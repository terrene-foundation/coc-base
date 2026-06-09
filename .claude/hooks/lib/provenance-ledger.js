"use strict";

/**
 * provenance-ledger.js — F101-2 (loom#411 governance-as-DNA, loom lane).
 *
 * The LOCAL per-session provenance ledger writer. Per the loom↔csq seam (csq
 * journal 0017 §2): the capture hooks are a NEW EMITTER into csq's audit
 * pipeline; when the csq daemon is unreachable the hook captures to a DEGRADED
 * LOCAL ledger and csq reconciles on reconnect. This module IS that local
 * ledger — a SEPARATE per-session append stream, NOT the coordination-log.
 *
 * Why separate from coordination-log (journal/0190 For-Discussion #1, resolved):
 *   - SIGNING AUTHORITY DIFFERS (dispositive): csq signs provenance events
 *     (Ed25519); loom signs NOTHING here (loom is the FORMAT authority per
 *     provenance-event.js). coordination-log holds records loom signs ITSELF
 *     under 10 fold rules. Two trust models cannot share one append stream — an
 *     unsigned csq-bound event in loom's signed multi-operator fold is rejected.
 *   - csq DRAINS the seam: csq reads this ledger independently; interleaving
 *     into coordination-log would force csq to parse loom's multi-operator fold.
 *
 * Events are UNSIGNED canonical events (built via provenance-event.js). Signing +
 * anchoring is the csq lane. This module: resolve path, derive chain head, build,
 * chain, append. It is BEST-EFFORT and NEVER throws to the caller's halting path
 * — a capture failure degrades the ledger, it does not block the session.
 *
 * Origin: F101-2 (journal/0188 §D approved /todos plan; F101-1 schema journal/0190).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  validateProvenanceEvent,
  chainProvenanceEvent,
} = require("./provenance-event.js");

/**
 * Per-session ledger file. The raw session_id is sanitized to a safe filename
 * token AND suffixed with an 8-char sha256 of the RAW id, so the mapping is
 * INJECTIVE by construction: two distinct raw session_ids that sanitize to the
 * same token (e.g. "a/b" and "a_b") still land on distinct ledgers, while the
 * SAME raw id is deterministic (same file → one chain). The charclass strips
 * every path separator, so a crafted session_id cannot traverse out of
 * provenance/ (a surviving "." is inert without a separator). The filename is
 * loom-internal/opaque to csq, which drains by directory + the in-event
 * `session` field, so the suffix is seam-safe.
 */
function _ledgerPath(repoDir, session) {
  const hasSession = typeof session === "string" && session.trim().length > 0;
  const safe = hasSession
    ? session.replace(/[^A-Za-z0-9._-]/g, "_")
    : "unknown-session";
  const suffix = hasSession
    ? crypto
        .createHash("sha256")
        .update(session, "utf8")
        .digest("hex")
        .slice(0, 8)
    : "00000000";
  return path.join(
    repoDir,
    ".claude",
    "learning",
    "provenance",
    `${safe}-${suffix}.jsonl`,
  );
}

/**
 * Disclosure fence for path-bearing payload values (#255/#252 class). A
 * file_path lands in a PERMANENT, csq-anchored governance record. This fence
 * drops the part of an absolute path that is pure DISCLOSURE — the operator's
 * home dir / username + the checkout ROOT prefix (`/Users/<dev>/clients/<acme>/`)
 * — which redaction-after-anchor cannot undo and which carries no governance value.
 *
 * What is INTENTIONALLY RETAINED (an accepted residual, NOT a gap): the
 * REPO-RELATIVE module path (`src/billing/credit-card-vault.py`). That path IS
 * the accountability surface decision-provenance exists to record — "which
 * module did the AI touch, on whose authorization" — so dropping it would defeat
 * the capture's purpose. The repo-relative form discloses internal module layout
 * but NOT the home/username/client-root prefix; that is the deliberate
 * accountability-vs-disclosure trade-off.
 *
 * Coarsening the in-repo path further (basename-only, depth-bucketed, hashed) is
 * NOT loom's default — it is the #411 ATTRIBUTION-GRANULARITY decision, which is
 * HUMAN-GATED (a downstream works-council / co-determination agreement settles
 * how much AI-action detail the record may carry). loom emits the maximally-
 * accountable form; csq's compliance-evidence lane MAY coarsen it per that
 * agreement.
 *
 * Branches: absolute-under-repo → repo-relative (retained per above); absolute
 * OUTSIDE the repo → basename only (no foreign-root disclosure); already-relative
 * → normalized, and a `..`-escaping relative → basename (exported-helper fence
 * so a future caller passing `../sibling/secret.py` cannot leak a sibling root).
 */
function _relativizePath(repoDir, p) {
  if (typeof p !== "string" || !p) return p;
  if (!path.isAbsolute(p)) {
    const norm = path.normalize(p);
    // A leading `..` escapes the repo root → drop to basename (no sibling-root
    // disclosure). Not reachable from classify() today (CC supplies absolute
    // paths), but _relativizePath is exported, so the contract is fenced here.
    if (norm === ".." || norm.startsWith(`..${path.sep}`))
      return path.basename(p);
    return norm;
  }
  const rel = path.relative(repoDir, p);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return path.basename(p);
  }
  return rel;
}

/**
 * Derive the chain head from the ledger's last line — split-brain-free (the
 * chain head is always re-derivable from the ledger itself, never a sidecar
 * cache that could diverge per `knowledge-convergence.md`). Returns the prior
 * EVENT (chainProvenanceEvent re-hashes it) or null for genesis. A present-but-
 * unparseable last line is corruption: we surface an explicit reset reason so
 * csq sees a LOUD chain reset, never a silent fork (`zero-tolerance.md` Rule 3).
 *
 * @returns {{ priorEvent: ?object, resetReason: ?string }}
 */
function _deriveChainHead(ledgerPath) {
  if (!fs.existsSync(ledgerPath))
    return { priorEvent: null, resetReason: null };
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    // Ledger exists but is unreadable — reset loudly rather than silently fork.
    return { priorEvent: null, resetReason: "prior_ledger_unreadable" };
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { priorEvent: null, resetReason: null };
  const last = lines[lines.length - 1];
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { priorEvent: null, resetReason: "prior_line_unparseable" };
  }
  const { ok } = validateProvenanceEvent(parsed);
  if (!ok) return { priorEvent: null, resetReason: "prior_line_invalid" };
  return { priorEvent: parsed, resetReason: null };
}

/**
 * Project a resolveIdentity() result onto the closed operator_ref shape AND
 * classify attribution confidence. Per #411: a session with no per-dev identity
 * "records as `unidentified operator on host H`, never silently mis-attributed."
 *
 *   - verified_id + person_id      → attribution "verified"   (rostered key)
 *   - verified_id, no person_id    → attribution "unrostered"  (real key, not
 *                                     yet enrolled; record the fingerprint so
 *                                     csq CAN bind it on enrollment)
 *   - no verified_id               → attribution "unidentified" (no signing key)
 *
 * operator_ref is byte-exact-closed (verified_id/person_id/[display_id] only) —
 * the schema rejects anything else. display_id is advisory and included only
 * when present + non-empty.
 *
 * @returns {{ operatorRef: object, attribution: string }}
 */
function _projectOperatorRef(identity) {
  const host = os.hostname() || "unknown-host";
  const vid =
    identity && typeof identity.verified_id === "string" && identity.verified_id
      ? identity.verified_id
      : null;
  const pid =
    identity && typeof identity.person_id === "string" && identity.person_id
      ? identity.person_id
      : null;

  if (vid && pid) {
    const ref = { verified_id: vid, person_id: pid };
    if (
      identity &&
      typeof identity.display_id === "string" &&
      identity.display_id
    ) {
      ref.display_id = identity.display_id;
    }
    return { operatorRef: ref, attribution: "verified" };
  }
  if (vid) {
    // Real signing key, not yet rostered — keep the fingerprint (csq binds it
    // once /whoami --register lands), mark unrostered so attribution is honest.
    return {
      operatorRef: { verified_id: vid, person_id: `unrostered@${host}` },
      attribution: "unrostered",
    };
  }
  return {
    operatorRef: {
      verified_id: "unidentified",
      person_id: `unidentified@${host}`,
    },
    attribution: "unidentified",
  };
}

/**
 * Capture one provenance event to the local per-session ledger. Best-effort:
 * returns a result object; NEVER throws (the caller is a non-blocking hook).
 *
 * @param {object} a
 * @param {string} a.repoDir   MAIN-checkout repo dir (caller resolves it)
 * @param {string} a.session   session id (from the hook payload)
 * @param {string} a.kind      one of provenance-event EVENT_KINDS
 * @param {?object} a.identity resolveIdentity() result (or null → unidentified)
 * @param {object} a.payload   kind-specific payload (plain object)
 * @param {string} a.nowIso    ISO-8601 timestamp (caller supplies; testable)
 * @returns {{ ok: boolean, event?: object, ledgerPath?: string, error?: string }}
 */
function captureProvenance(a) {
  try {
    const { repoDir, session, kind, identity } = a;
    const ledgerPath = _ledgerPath(repoDir, session);
    const { priorEvent, resetReason } = _deriveChainHead(ledgerPath);
    const { operatorRef, attribution } = _projectOperatorRef(identity);

    // NULL-PROTOTYPE merge target: an own-enumerable `__proto__` key in the
    // caller payload (e.g. from JSON.parse) would, on a plain `{}` target,
    // trigger the prototype SETTER and silently vanish — bypassing the schema's
    // _scanForbiddenKeys guard (the F101-1 bug-class #4 the guard closed). On a
    // null-proto target there is no __proto__ setter, so the key survives as a
    // real own property and the guard rejects the event. Defense survives the
    // pre-validation merge that precedes it.
    const payload = Object.assign(Object.create(null), a.payload || {}, {
      attribution,
    });
    if (resetReason) payload.chain_reset_reason = resetReason;

    // Disclosure fence: relativize path-bearing values against the repo root so
    // a permanent governance record never carries an absolute home/client path.
    if (typeof payload.file_path === "string") {
      payload.file_path = _relativizePath(repoDir, payload.file_path);
    }
    if (typeof payload.journal_path === "string") {
      payload.journal_path = _relativizePath(repoDir, payload.journal_path);
    }

    const event = chainProvenanceEvent(priorEvent, {
      kind,
      ts: a.nowIso,
      session:
        typeof session === "string" && session.trim()
          ? session
          : "unknown-session",
      operatorRef,
      payload,
    });

    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, JSON.stringify(event) + "\n");
    return { ok: true, event, ledgerPath };
  } catch (e) {
    // Best-effort capture: a malformed event or IO failure degrades the ledger
    // but MUST NOT propagate to the hook's halting path.
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  captureProvenance,
  _ledgerPath,
  _deriveChainHead,
  _projectOperatorRef,
  _relativizePath,
};
