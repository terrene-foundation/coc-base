#!/usr/bin/env node
/*
 * ============================================================================
 *  Knowledge-Mesh C-1 Metadata-Scrub Fence — S1 (loom#953 obligation 2)
 * ============================================================================
 *
 *  The scrub ENGINE for the mesh metadata-observation UP pull. AUTHORITATIVE
 *  CONTRACT (do NOT paraphrase — this engine IMPLEMENTS it, it does not
 *  redefine it):
 *    workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
 *      § "Metadata-observation disclosure fence"  (the field dispositions)
 *    workspaces/knowledge-mesh-2026-07-10/specs/02-knowledge-product-identity.md
 *      § "The registry tuple (13 fields)"          (the input contract)
 *  Per `.claude/rules/specs-authority.md` Rule 9 the spec is the single source
 *  of truth; this header REFERENCES it and never restates the derivation.
 *
 *  WHERE IT RUNS — AT THE SOURCE, PRE-COMMIT. The transport is a `git fetch`
 *  of each project's COMMITTED registry text, so a post-fetch scrub is
 *  structurally too late (the raw objects are already in loom-command's
 *  `.git`). The PROJECT authors its registry tuple ALREADY-SCRUBBED by
 *  routing it through this engine at its own authoring/observation verdict.
 *  (specs/02 § "The UP-pull transport — and WHERE the fence sits".)
 *
 *  This engine is LOOM-BUILDABLE because "the tuple is text": no engine
 *  code, no data movement, no `db.start()`. It is the same class of loom
 *  disclosure tooling as `.claude/bin/scan-synced-disclosure.mjs`.
 *
 *  THE 13-FIELD DISPOSITION PARTITION (specs/04 § "Full field-disposition
 *  accounting" — 5 + 5 + 2 + 1 = 13, NO field uncounted):
 *    SCRUB (5)             name · provenance · staleness_policy_ref ·
 *                          reservoir_locator · merged_from[]
 *    ENUM/GRAMMAR PASS (5) classification · owning_level · product_class ·
 *                          cascade_scope · version
 *                          (classification is categorically a pass-through
 *                          field but its canonical vocabulary is UNDEFINED —
 *                          specs/03 — so it fail-closed-REDACTS until Wave 2b
 *                          defines the enum; a whitespace-free client slug
 *                          would otherwise pass an identifier grammar.)
 *    NOT-SCRUBBED (2)      lineage_id · content_commitment   (rendered)
 *    BY-CONSTRUCTION       content_hash   (NEVER enters the input set)
 *      EXCLUDED (1)
 *
 *  FAIL-CLOSED CORE INVARIANTS (specs/04 § "The scrub scope" + invariants):
 *    1. UP-direction fence exists (this file).
 *    2. Fail-closed on UNRECOGNIZED tuple fields — an unknown field is
 *       redacted + flagged, never passed through.
 *    3. None of the 5 SCRUB fields leaves un-scrubbed; the vault (map +
 *       keys k / k_eco) and the raw content_hash NEVER enter the input set
 *       at all (their presence is a HARD violation, not a scrub).
 *    4. content_commitment + lineage_id are RENDERED, deliberately NOT
 *       scrubbed (blinding either kills FP-4 / the lineage DAG).
 *    5. merged_from[] is FIELD-scrubbed (each URN's <name> segment redacted,
 *       structure PRESERVED) — never fail-closed-DROPPED, which would break
 *       the merge back-reference the console must render.
 *
 *  NAME-BLINDNESS (specs/04 § "loom-command governance is NAME-BLIND", M3):
 *    the readable <name> NEVER reaches loom-command; the S2 console resolves
 *    display names from the LOCAL handle vault, not the pulled tuple. So the
 *    `name` field IS redacted here — loom-command needs the opaque handle,
 *    never the readable name.
 *
 *  OUTPUT SAFETY: like scan-synced-disclosure.mjs, the report NEVER prints a
 *  raw scrubbed value. Redactions render as a sentinel; the report shows the
 *  per-field DISPOSITION, never the client-identifying bytes it removed. A
 *  denylist of client names in this committed file would BE the leak it
 *  prevents, so this engine carries ZERO client tokens — it is disposition-
 *  driven (structural), not denylist-driven.
 *
 *  Usage:
 *    node .claude/bin/mesh-registry-scrub.mjs <tuple.json>        scrub, print report+JSON
 *    node .claude/bin/mesh-registry-scrub.mjs --check <tuple.json> exit 1 if any HARD violation
 *    node .claude/bin/mesh-registry-scrub.mjs --json <tuple.json>  print scrubbed JSON only
 *    cat tuple.json | node .claude/bin/mesh-registry-scrub.mjs -   read from stdin
 *    node .claude/bin/mesh-registry-scrub.mjs --help
 *
 *  Exit codes: 0 = clean (scrub applied, no HARD violation);
 *              1 = ≥1 HARD violation (vault or content_hash in input set) in
 *                  --check mode; 2 = usage / parse error.
 * ============================================================================
 */

import fs from "node:fs";

// ────────────────────────────────────────────────────────────────
// Sentinels — the report/scrubbed output never carries a raw value.
// ────────────────────────────────────────────────────────────────
const REDACTED = "«REDACTED»";
const REDACTED_NAME = "«REDACTED_NAME»"; // for a URN <name> segment

// ────────────────────────────────────────────────────────────────
// Grammars (specs/02 § "The URN" + § "The registry tuple")
// ────────────────────────────────────────────────────────────────
// <version> / tuple `version`: dot-separated numerics, monotonic.
const VERSION_GRAMMAR = /^[0-9]+(\.[0-9]+)*$/;
// Opaque ≥128-bit handle grammar (clause (a): a random ≥128-bit id — a
// UUIDv4, or 16 random bytes — OR an HMAC output, UNTRUNCATED). The fence
// accepts ONLY the two RENDERINGS that a structural check can distinguish
// from readable text: a UUID, or a ≥32-char (≥128-bit) HEX digest. A value
// < 128 bits is a truncation; anything outside the hex/UUID charset is
// fail-closed-redacted.
const UUID_GRAMMAR =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX128_GRAMMAR = /^[0-9a-f]{32,}$/i;

// Structural opacity check (specs/02 clause (a)). SCOPE NOTE — WHAT THIS
// CLOSES AND WHAT IT DOES NOT:
//   * WHY hex/UUID ONLY, not base64url: clause (a) also permits a base64url
//     HMAC rendering, but a base64url string is charset-indistinguishable
//     from a RAW readable client name (even a hyphenated or digit-bearing one
//     like "acme-corp-2026-churn"). Restricting to hex/UUID closes that RAW-
//     readable-name class for the two console-RENDERED kept fields
//     (lineage_id, content_commitment): a raw client name is not a ≥32-char
//     pure-hex string. A project rendering its handle as base64url must re-
//     render it as hex/UUID — a fail-closed-SAFE redaction, never a leak.
//   * WHAT IT DOES NOT CLOSE (residual — OPEN, by construction): TWO name-
//     DERIVED renderings pass this structural check. (1) A hex-ENCODED client
//     name IS a ≥32-char pure-hex string, so `hex("acme-corporation")` passes
//     HEX128_GRAMMAR and a single `xxd -r -p` recovers it. (2) A UUIDv5 handle
//     `SHA1(namespace + readable_name)` is name-DERIVED yet passes UUID_GRAMMAR
//     (which accepts ANY UUID shape, v5 included). Both are the irreducible
//     limit of ANY structural check that must ALSO accept a real HMAC-hex value
//     (an encoded name and an HMAC-hex digest are byte-shape-identical), so the
//     residual is BY-CONSTRUCTION irreducible — NOT a fixable gap in this check.
//     Against an adversarial AUTHOR who deliberately derives the handle, opacity
//     rests on the project's minting DISCIPLINE via `mintHandle`
//     (`.claude/bin/mesh-urn.mjs`:84-105 — random mode = 16 CSPRNG bytes
//     UNTRUNCATED; hmac mode = HMAC-SHA256 under a ≥128-bit CSPRNG key,
//     UNTRUNCATED; both non-derivable from the readable name), NOT on any
//     verifiable property of the COMMITTED handle. A committed-handle minting
//     ATTESTATION — one that would let this fence PROVE a handle was
//     CSPRNG/HMAC-minted rather than name-derived — is UNBUILT: a FUTURE
//     obligation, NOT a shipped clause-(e) item. specs/02 clause (e) defines key
//     GENERATION/custody only (e.1 CSPRNG-gen · e.2 never-committed · e.3
//     mint-time-only · e.4 in the instantiation/publish scrub); it mints NO
//     attestation mechanism, and none shipped in Wave 1. So this check is a
//     fail-closed BACKSTOP against the RAW-readable-name class, NOT a proof of
//     opacity; the author-adversary residual is OPEN, registered at
//     workspaces/knowledge-mesh-2026-07-10/specs/03-access-auth-model.md
//     § "Residual register" as RES-22.
//   * NOTE (defense-in-depth, NOT applied here): a UUID version-nibble check
//     (reject v3/v5) would cheaply kill instance (2) — a real random handle
//     renders as a v4 UUID or as raw 32-hex, so rejecting v5 is loss-free — but
//     it does NOT close instance (1), the raw-hex-encoded name, which is also
//     the shape `content_commitment`/`lineage_id` legitimately carry (HMAC-hex).
//     It is therefore documented here rather than enforced.
function isOpaqueHandle(v) {
  if (typeof v !== "string") return false;
  return UUID_GRAMMAR.test(v) || HEX128_GRAMMAR.test(v);
}

// ────────────────────────────────────────────────────────────────
// Enum-bounded pass-through vocabularies (specs/04 § "ENUM-BOUNDED
// PASS-THROUGH"). A value OUTSIDE the enum is unrecognized ⇒ fail-closed.
// ────────────────────────────────────────────────────────────────
const ENUMS = {
  owning_level: new Set(["platform", "build", "use"]),
  product_class: new Set(["data", "knowledge"]),
  cascade_scope: new Set(["generic", "scoped"]),
};
// cascade_scope fail-closed default (specs/02 § "The registry tuple").
const CASCADE_SCOPE_DEFAULT = "scoped";

// ────────────────────────────────────────────────────────────────
// The authoritative machine-readable field-disposition table. This is
// the executable encoding of specs/04 § "Full field-disposition
// accounting". Every one of the 13 tuple fields appears exactly once.
// ────────────────────────────────────────────────────────────────
const DISPOSITIONS = {
  name: "scrub", // free text; loom-command is name-blind (M3) ⇒ redact
  provenance: "scrub", // operator identity ⇒ redact
  staleness_policy_ref: "scrub", // may carry a client-repo path ⇒ redact
  reservoir_locator: "scrub", // may embed an infra hostname ⇒ redact
  merged_from: "field-scrub-urn", // redact each URN's <name>, keep structure
  version: "passthrough-grammar", // VERSION_GRAMMAR or fail-closed
  classification: "passthrough-pending-vocab", // vocab RATIFIED (#995); scrub passthrough activation deferred to Wave-2b ⇒ fail-closed
  owning_level: "passthrough-enum",
  product_class: "passthrough-enum",
  cascade_scope: "passthrough-enum",
  lineage_id: "keep-opaque", // rendered as the lineage DAG; NOT scrubbed
  content_commitment: "keep-opaque", // HMAC(k_eco,·) — opaque; NOT scrubbed (blinding kills FP-4)
  content_hash: "excluded", // MUST NOT be in the UP-pull input set
};

// Fields whose PRESENCE in the input set is a HARD violation (never a
// scrub). The vault — map + keys — is excluded BY CONSTRUCTION and must
// never be committed beside the registry (specs/02 clauses (c)/(e)).
// NOTE (accepted residual): detection is NAME-based, so a vault map committed
// under an un-enumerated name (e.g. "handle_to_name") is NOT a HARD violation
// — it falls to the unrecognized→REDACTED branch. That is DISCLOSURE-safe
// (the value is redacted, the client↔handle pairs never survive), the only
// cost is a --check exit 0 instead of 1 for that mis-named case. A value-shape
// heuristic was rejected as over-fitting; the redaction backstop is the guard.
const VAULT_FORBIDDEN = new Set([
  "k",
  "k_eco",
  "vault",
  "handle_map",
  "handle_vault",
  "name_map",
  "key",
  "keys",
]);

// ────────────────────────────────────────────────────────────────
// The scrub engine.
//
//   scrubTuple(tuple) -> {
//     scrubbed,        // the already-scrubbed tuple, safe to commit
//     dispositions,    // per-field: { field, disposition, action }
//     violations,      // HARD violations (vault / content_hash present)
//     flags,           // fail-closed redactions (unrecognized / bad-grammar)
//     ok,              // false iff violations.length > 0
//   }
//
// The engine NEVER throws on bad input — a malformed tuple is a fail-
// closed finding, not a crash (`.claude/rules/zero-tolerance.md` Rule 3).
// ────────────────────────────────────────────────────────────────
function scrubTuple(tuple) {
  // Null-prototype output object: a field literally named "__proto__" then
  // lands as an ordinary own key (redacted) instead of silently retargeting
  // the prototype — no prototype-pollution sink in the scrubbed result.
  const scrubbed = Object.create(null);
  const dispositions = [];
  const violations = [];
  const flags = [];
  // Unrecognized field names are themselves attacker-controlled free text
  // (a project author picks the key), so they are DROPPED, never echoed —
  // and referenced only by this positional counter, never by their raw name.
  let unrecognizedCount = 0;

  if (tuple === null || typeof tuple !== "object" || Array.isArray(tuple)) {
    return {
      scrubbed: {},
      dispositions: [],
      violations: [
        {
          field: "<root>",
          reason: "input is not a registry-tuple object",
        },
      ],
      flags: [],
      ok: false,
    };
  }

  for (const field of Object.keys(tuple)) {
    const value = tuple[field];
    // HARD-violation detection is CASE-INSENSITIVE: a case variant
    // ("Content_Hash", "K_ECO") of an excluded-by-construction field MUST
    // still HARD-violate (block the commit), not merely fall to the
    // unrecognized→redact branch (which is disclosure-safe but returns a
    // misleading --check exit 0). The disposition lookup below stays
    // case-SENSITIVE — a mis-cased tuple field is legitimately unrecognized.
    const fieldLC = field.toLowerCase();

    // ---- HARD violations: presence is itself the finding ----------------
    if (VAULT_FORBIDDEN.has(fieldLC)) {
      // The vault (map + keys) must NEVER enter the UP-pull input set.
      violations.push({
        field,
        reason:
          "handle-vault material (map/keys) present in registry tuple — MUST be excluded by construction (specs/02 clauses (c)/(e))",
      });
      // Do NOT copy the value into the scrubbed output.
      dispositions.push({ field, disposition: "vault-forbidden", action: "dropped-hard-violation" });
      continue;
    }
    if (fieldLC === "content_hash") {
      // Raw hash is a membership-test oracle; excluded by construction (D-6).
      // Case-insensitive (fieldLC) so Content_Hash / CONTENT_HASH also block,
      // matching the vault-detection discipline above.
      violations.push({
        field,
        reason:
          "raw content_hash present — excluded from the UP-pull input set BY CONSTRUCTION (D-6); publish content_commitment instead",
      });
      dispositions.push({ field, disposition: "excluded", action: "dropped-hard-violation" });
      continue;
    }

    // Object.hasOwn guard: a prototype-chain key ("__proto__", "constructor",
    // "toString", …) MUST route through the genuine unrecognized→fail-closed
    // branch, NOT resolve to an inherited Object.prototype value that skips it.
    const disposition = Object.hasOwn(DISPOSITIONS, field)
      ? DISPOSITIONS[field]
      : undefined;

    // ---- Unrecognized field: FAIL-CLOSED — DROP key AND value -----------
    // The field NAME is attacker-controlled free text (a client name /
    // operator email / infra hostname smuggled as a JSON key). Redacting
    // only the VALUE would leak the key verbatim into the scrubbed output
    // and the report. So the whole field is DROPPED and referenced only by a
    // positional sentinel — the raw key never reaches `scrubbed` or a report.
    if (disposition === undefined) {
      unrecognizedCount += 1;
      const label = `«unrecognized-field-#${unrecognizedCount}»`;
      flags.push({
        field: label,
        reason: "unrecognized tuple field — fail-closed DROPPED (key + value); the field name is itself untrusted free text (specs/04 invariant 2)",
      });
      dispositions.push({ field: label, disposition: "unrecognized", action: "dropped-fail-closed" });
      continue;
    }

    switch (disposition) {
      case "scrub": {
        // Free-text / identity / locator: loom-command has no need for the
        // raw value (name-blind, M3). Redact unconditionally to a sentinel.
        scrubbed[field] = REDACTED;
        dispositions.push({ field, disposition: "scrub", action: "redacted" });
        break;
      }
      case "field-scrub-urn": {
        // merged_from[]: preserve structure, redact each URN's <name> segment.
        const { value: out, count } = scrubMergedFrom(value, field, flags);
        scrubbed[field] = out;
        dispositions.push({
          field,
          disposition: "field-scrub-urn",
          action: `name-segment-redacted (${count} urn${count === 1 ? "" : "s"})`,
        });
        break;
      }
      case "passthrough-grammar": {
        if (typeof value === "string" && VERSION_GRAMMAR.test(value)) {
          scrubbed[field] = value;
          dispositions.push({ field, disposition: "passthrough-grammar", action: "passed" });
        } else {
          scrubbed[field] = REDACTED;
          flags.push({
            field,
            reason: `value does not match the ^[0-9]+(\\.[0-9]+)*$ grammar — fail-closed redacted (specs/02 § "The URN")`,
          });
          dispositions.push({ field, disposition: "passthrough-grammar", action: "redacted-fail-closed" });
        }
        break;
      }
      case "passthrough-pending-vocab": {
        // classification: the canonical mesh classification vocabulary is now
        // RATIFIED (specs/03 § "Classification vocabulary", PR #995) — but the
        // scrub's ENUM pass-through ACTIVATION is deferred to Wave-2b (the S2
        // console's classification-posture render is gated on the same wave),
        // so this stays fail-closed-REDACT for now: a whitespace-free identifier
        // is NOT a safe stand-in — hostnames (`db.acme-corp.internal`), host:port,
        // and tenant slugs (`tenant_acme_corp_prod`) are all whitespace-free and
        // would leak. Redacting a legitimate LEVEL token ("internal") is the
        // accepted fail-closed cost until Wave-2b wires the ratified vocab into
        // ENUMS (at which point this row becomes a `passthrough-enum`); nothing
        // downstream regresses because no live consumer renders it yet.
        scrubbed[field] = REDACTED;
        flags.push({
          field,
          reason:
            "classification vocabulary RATIFIED (#995) but ENUM pass-through activation deferred to Wave-2b — fail-closed redacted (specs/03 § Classification vocabulary); a whitespace-free identifier is not a safe enum stand-in (a tenant slug / hostname passes it)",
        });
        dispositions.push({ field, disposition: "passthrough-pending-vocab", action: "redacted-fail-closed" });
        break;
      }
      case "passthrough-enum": {
        const allowed = ENUMS[field];
        if (typeof value === "string" && allowed.has(value)) {
          scrubbed[field] = value;
          dispositions.push({ field, disposition: "passthrough-enum", action: "passed" });
        } else if (field === "cascade_scope") {
          // fail-closed DEFAULT (never a bare redaction) — specs/02.
          scrubbed[field] = CASCADE_SCOPE_DEFAULT;
          flags.push({
            field,
            reason: `value outside {${[...allowed].join(", ")}} — fail-closed to default '${CASCADE_SCOPE_DEFAULT}'`,
          });
          dispositions.push({ field, disposition: "passthrough-enum", action: "defaulted-fail-closed" });
        } else {
          scrubbed[field] = REDACTED;
          flags.push({
            field,
            reason: `value outside {${[...allowed].join(", ")}} — fail-closed redacted`,
          });
          dispositions.push({ field, disposition: "passthrough-enum", action: "redacted-fail-closed" });
        }
        break;
      }
      case "keep-opaque": {
        // lineage_id + content_commitment: rendered / the merge signal,
        // deliberately NOT scrubbed — but each MUST carry the opaque ≥128-bit
        // grammar (a non-opaque value is invertible to a readable name, or a
        // stuffed client string). A non-opaque value is fail-closed redacted.
        // content_commitment is HMAC(k_eco,·) output, which IS opaque hex/
        // base64 — so grammar-checking it (not blind-keeping) closes the
        // "stuff a client name into content_commitment" smuggle path.
        if (isOpaqueHandle(value)) {
          scrubbed[field] = value;
          dispositions.push({ field, disposition: "keep-opaque", action: "kept" });
        } else {
          scrubbed[field] = REDACTED;
          flags.push({
            field,
            reason: `${field} is not an opaque ≥128-bit value — fail-closed redacted (specs/02 § "${field}"; a non-opaque value is invertible / can carry free text)`,
          });
          dispositions.push({ field, disposition: "keep-opaque", action: "redacted-fail-closed" });
        }
        break;
      }
      default: {
        // Defensive: a disposition string with no handler is itself a bug.
        scrubbed[field] = REDACTED;
        flags.push({ field, reason: `no handler for disposition '${disposition}' — fail-closed redacted` });
        dispositions.push({ field, disposition, action: "redacted-fail-closed" });
      }
    }
  }

  // Invariant 4 — fail-closed cascade_scope DEFAULT for an ABSENT field. The
  // per-field loop only defaults an INVALID cascade_scope (line ~343); a field
  // that is simply MISSING is never iterated, so without this an authored tuple
  // could be committed carrying NO cascade_scope marker at all — the fail-closed
  // default would not be guaranteed at the scrub-at-source gate (redteam #965 R1
  // F1). Treat absent as invalid: inject the most-restrictive value.
  if (!Object.hasOwn(scrubbed, "cascade_scope")) {
    scrubbed.cascade_scope = CASCADE_SCOPE_DEFAULT;
    flags.push({
      field: "cascade_scope",
      reason: `cascade_scope ABSENT — fail-closed injected default '${CASCADE_SCOPE_DEFAULT}' (most-restrictive; specs/02 § "The registry tuple")`,
    });
    dispositions.push({ field: "cascade_scope", disposition: "passthrough-enum", action: "defaulted-fail-closed-absent" });
  }

  return {
    scrubbed,
    dispositions,
    violations,
    flags,
    ok: violations.length === 0,
  };
}

// ────────────────────────────────────────────────────────────────
// merged_from[]: each entry is a kp:// URN whose <name> segment is
// operator-authored free text. Redact the <name> segment AND validate the
// other segments the same way the top-level tuple validates them — the
// URN's <owning_level> MUST be enum-bounded and its <domain> MUST be an
// opaque handle, else a URN like kp://acme-corp/logistics-handle/x@2 would
// leak the client in the owning_level / domain slots the earlier "keep m[1]
// verbatim" approach preserved. Any non-conforming segment fail-closes the
// WHOLE entry to REDACTED (structure is only preserved when it is SAFE to
// render). Conforming entries keep <owning_level>/<domain>/@<version> so the
// console can render the merge back-reference (specs/04 § scrub item 5).
//   kp://<owning_level>/<domain>/<name>@<version>
// ────────────────────────────────────────────────────────────────
const KP_URN = /^kp:\/\/([^/]+)\/([^/]+)\/([^@/]+)(@([^/]+))?$/;

function scrubMergedFrom(value, field, flags) {
  if (value === undefined || value === null) {
    return { value: [], count: 0 };
  }
  if (!Array.isArray(value)) {
    flags.push({
      field,
      reason: "merged_from is not an array — fail-closed redacted",
    });
    return { value: REDACTED, count: 0 };
  }
  let count = 0;
  const out = value.map((entry) => {
    if (typeof entry !== "string") {
      flags.push({ field, reason: "merged_from entry is not a string — fail-closed redacted" });
      return REDACTED;
    }
    const m = KP_URN.exec(entry);
    if (!m) {
      // Not a recognizable kp:// URN → fail-closed redact the whole entry.
      flags.push({ field, reason: "merged_from entry is not a kp:// URN — fail-closed redacted" });
      return REDACTED;
    }
    const owningLevel = m[1];
    const domain = m[2];
    const version = m[5]; // undefined when no @<version>
    // Same discipline as the top-level tuple: owning_level enum-bounded,
    // domain opaque, version numeric. Any miss fail-closes the whole entry.
    if (!ENUMS.owning_level.has(owningLevel)) {
      flags.push({ field, reason: "merged_from URN owning_level outside {platform, build, use} — fail-closed redacted" });
      return REDACTED;
    }
    if (!isOpaqueHandle(domain)) {
      flags.push({ field, reason: "merged_from URN <domain> is not an opaque handle — fail-closed redacted" });
      return REDACTED;
    }
    if (version !== undefined && !VERSION_GRAMMAR.test(version)) {
      flags.push({ field, reason: "merged_from URN <version> is not numeric — fail-closed redacted" });
      return REDACTED;
    }
    count += 1;
    const versionPart = version !== undefined ? `@${version}` : "";
    return `kp://${owningLevel}/${domain}/${REDACTED_NAME}${versionPart}`;
  });
  return { value: out, count };
}

// ────────────────────────────────────────────────────────────────
// Human-readable report (safe to paste anywhere — no raw values).
// ────────────────────────────────────────────────────────────────
function formatReport(result) {
  const lines = [];
  lines.push("mesh-registry-scrub — C-1 metadata-scrub fence (S1)");
  lines.push("");
  lines.push("Per-field disposition:");
  for (const d of result.dispositions) {
    lines.push(`  ${d.field.padEnd(22)} ${d.disposition.padEnd(20)} ${d.action}`);
  }
  if (result.flags.length) {
    lines.push("");
    lines.push(`Fail-closed flags (${result.flags.length}):`);
    for (const f of result.flags) lines.push(`  ${f.field.padEnd(22)} ${f.reason}`);
  }
  if (result.violations.length) {
    lines.push("");
    lines.push(`HARD VIOLATIONS (${result.violations.length}) — the tuple MUST be re-authored:`);
    for (const v of result.violations) lines.push(`  ${v.field.padEnd(22)} ${v.reason}`);
  }
  lines.push("");
  lines.push(result.ok ? "RESULT: scrubbed OK (no hard violation)" : "RESULT: HARD VIOLATION — do NOT commit this tuple");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: "report", src: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.mode = "check";
    else if (a === "--json") args.mode = "json";
    else if (a === "--help" || a === "-h") args.mode = "help";
    else if (a === "-") args.src = "-";
    else if (!a.startsWith("--")) args.src = a;
    else return { error: `unknown flag: ${a}` };
  }
  return args;
}

const HELP = `mesh-registry-scrub — knowledge-mesh C-1 metadata-scrub fence (S1)

Scrubs a knowledge-product registry TUPLE at the SOURCE (pre-commit) so the
raw client-identifying values never enter a git object loom-command fetches.
Contract: workspaces/knowledge-mesh-2026-07-10/specs/04-plane-split.md
§ "Metadata-observation disclosure fence".

Usage:
  mesh-registry-scrub <tuple.json>          scrub; print report + scrubbed JSON
  mesh-registry-scrub --json <tuple.json>   print scrubbed JSON only
  mesh-registry-scrub --check <tuple.json>  exit 1 on any HARD violation
  cat tuple.json | mesh-registry-scrub -    read the tuple from stdin
  mesh-registry-scrub --help

Exit: 0 clean · 1 hard violation (--check) · 2 usage/parse error`;

function readSource(src) {
  if (src === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(src, "utf8");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (args.mode === "help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (!args.src) {
    process.stderr.write(`error: no tuple source given\n\n${HELP}\n`);
    process.exit(2);
  }
  let raw;
  try {
    raw = readSource(args.src);
  } catch (e) {
    process.stderr.write(`error: cannot read ${args.src}: ${e.message}\n`);
    process.exit(2);
  }
  let tuple;
  try {
    tuple = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`error: input is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }

  const result = scrubTuple(tuple);

  if (args.mode === "json") {
    process.stdout.write(`${JSON.stringify(result.scrubbed, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  if (args.mode === "check") {
    if (!result.ok) {
      process.stderr.write(`${formatReport(result)}\n`);
      process.exit(1);
    }
    process.stdout.write("mesh-registry-scrub: clean (no hard violation)\n");
    process.exit(0);
  }
  // report mode
  process.stdout.write(`${formatReport(result)}\n\n`);
  process.stdout.write(`Scrubbed tuple:\n${JSON.stringify(result.scrubbed, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

// ESM: run main() only when invoked as a script, not when imported by tests.
const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

export {
  scrubTuple,
  scrubMergedFrom,
  formatReport,
  parseArgs,
  DISPOSITIONS,
  ENUMS,
  VAULT_FORBIDDEN,
  VERSION_GRAMMAR,
  isOpaqueHandle,
  REDACTED,
  REDACTED_NAME,
};
