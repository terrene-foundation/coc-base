/**
 * override-receipt.js — the SHARED mechanism for "a structural guard that BLOCKS, with an
 * AUDITED override".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AS A LIBRARY
 * ─────────────────────────────────────────────────────────────────────────────
 * `hook-output-discipline.md` MUST NOT § "Detectors that block work the agent has been
 * instructed to perform" makes a hard block with NO escape a defect: it dead-ends
 * legitimate work. The answer the corpus already settled on — first implemented inline in
 * `nested-worktree-guard.js` — is a TWO-CHANNEL audited override. That guard's version was
 * the only copy; this module is that mechanism lifted out so a SECOND guard adopts it
 * without a line of copy-paste, and a third after that.
 *
 * The properties below are what make an override AUDITED rather than FREE. Every one of
 * them is a property a re-implementation gets subtly wrong, which is the argument for
 * extracting rather than re-typing:
 *
 *   1. AGENT-REACHABLE. An env-var-only override is documented but UNREACHABLE at the
 *      moment a block fires — a hook inherits the CLI parent's environment, and a Bash
 *      `export` dies with the child shell. The receipt file is the channel an agent can
 *      actually use mid-session, and is therefore the channel that answers the MUST NOT.
 *   2. PRICED. The receipt must carry a NON-EMPTY REASON. An empty file is not an
 *      override. This is what makes overriding cost a sentence of justification instead
 *      of nothing.
 *   3. ONE-SHOT. The receipt is CONSUMED (deleted) as it is honoured. Without this, one
 *      override silently disarms the gate for every later call in the session — the exact
 *      failure mode a permanent env var has, and the reason a durable receipt would be
 *      worse than no receipt at all.
 *   4. RECORDED. The stated reason is echoed back into agent-visible context and onto the
 *      user-visible stderr line. "Non-empty" alone would let `x` buy an override; echoing
 *      it means the justification is read by the party who can judge it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "RECORDED" MEANS HERE, STATED HONESTLY
 * ─────────────────────────────────────────────────────────────────────────────
 * The record is the ADVISORY (agent-visible `additionalContext`) plus the stderr line
 * (user-visible). This module deliberately writes NO durable ledger: its consumers are
 * PreToolUse guards on a hot path, a ledger write is a new failure and disclosure surface,
 * and the sibling telemetry pair (`emit-dispatch-ledger.js` / `reconcile-dispatch-delivery.js`)
 * already owns durable dispatch recording. So an override is SURFACED, never SILENT — but
 * it is not, and is not claimed to be, independently auditable after the session ends.
 * Stated rather than implied, per `evidence-first-claims.md` MUST-4.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAIL-OPEN, EXCEPT AT CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Every runtime path fails OPEN into "no override" (`cc-artifacts.md` Rule 7): an
 * unreadable candidate, a receipt that is a directory, a tree that does not exist, a
 * candidate REFUSED by the hardened read, an undeletable receipt. Note the DIRECTION —
 * failing open here means the guard's own verdict STANDS, so a broken override channel
 * cannot wave a call through. It can only fail to rescue one.
 *
 * FAILING OPEN IS PER-CANDIDATE, NEVER PER-CALL, and the distinction is load-bearing. A
 * candidate that cannot be read or cannot be deleted disqualifies ITSELF and the loop moves
 * on; it does not disqualify the ones behind it. Ordering is invoking-tree-FIRST, so the
 * per-call reading turned a single poisoned receipt in the invoking tree into a DENIAL OF
 * SERVICE on the escape hatch for all three consumer guards — an operator's receipt in the
 * main checkout could never be reached. Refusal is total only when EVERY candidate fails.
 *
 * Every refusal is SURFACED on stderr (`conservation-gate.md` MUST-4 — an empty outcome
 * must be distinguishable from a successful one), with the receipt path REPO-RELATIVE plus
 * a root LABEL rather than the absolute operator path (see `warnReceipt`).
 *
 * CONSTRUCTION is the one place this module is LOUD: `createOverrideGate` THROWS on a
 * missing `receiptRel` or `envVar`. A gate misconfigured at construction would be a
 * silently DEAD override channel, which reads exactly like a working one until an agent
 * needs it and the block will not lift. That is the "documented but unreachable" defect,
 * and it is caught at require-time rather than at 2am.
 *
 * Origin: 2026-08-23 — extracted from `nested-worktree-guard.js` (2026-08-19) when a second
 * guard needed the same contract. The originating incident for the SECOND consumer: an
 * orchestrator overrode a correctly-firing dispatch-contract finding with the words "right
 * as issued", which was false; the lane burned ~119k tokens and delivered nothing. Detection
 * was never the gap — the gap was that overriding cost nothing and left no record.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The SHARED hardened reader. Not a second copy of a containment check: `append-sink.js`
// exports `readSinkFile` explicitly "so every sink READER shares this one implementation
// rather than re-deriving a containment check that will drift from the append path", and a
// receipt is exactly such a read. It supplies, in one call, the defenses this module read
// past for its whole life: root containment, dangling-symlink refusal at the ancestor,
// `O_NOFOLLOW` at the final component, `O_NONBLOCK` against a planted FIFO, a regular-file
// `fstat`, hard-link refusal, an fd-vs-directory identity reconcile, and a byte bound
// enforced BY THE READ. `require` is cycle-free — `append-sink.js` pulls only `fs`/`path`.
const { readSinkFile } = require("./append-sink.js");

/** DEFAULT cap on any untrusted field echoed back into agent-visible text. */
const FIELD_MAX = 80;

/**
 * Hard byte bound on a receipt read. A receipt is ONE LINE of justification; 64 KiB is
 * orders of magnitude of headroom over any honest one. Over the cap the read is refused
 * WHOLESALE (never truncated), which fails into "no override" like every other refusal
 * here — so an oversized receipt cannot lift a gate on a prefix nobody wrote.
 */
const RECEIPT_MAX_BYTES = 64 * 1024;

/**
 * Bound and neutralize an untrusted string before it is interpolated into stderr or into
 * `permissionDecisionReason` / `additionalContext` — all of which the agent reads back as
 * AUTHORITATIVE text, making an unsanitized value a prompt-injection and terminal-escape
 * vector. Lifted from `nested-worktree-guard.js` (which mirrored `lib/open-pr-surface.js`)
 * so the consumers cannot drift apart on it.
 *
 * @param {*}      value      the untrusted string
 * @param {string} fallback   returned when `value` is absent or sanitizes to empty
 * @param {number} [max]      per-CALLER cap, defaulting to `FIELD_MAX`. The NEUTRALIZATION
 *                            is the shared mechanism and is NOT parameterized; only the
 *                            length budget is, because a field's budget is a property of
 *                            the SURFACE it is echoed into, not of the sanitizer. A payload
 *                            fragment quoted back inside a one-line stderr summary wants a
 *                            short cap; an operator's WRITTEN JUSTIFICATION for overriding a
 *                            gate is the audit record itself, and clipping it at 80 would
 *                            weaken the RECORDED property this module exists to hold. Kept
 *                            OPTIONAL so every existing call site is unchanged.
 */
function safeField(value, fallback, max) {
  const cap = Number.isInteger(max) && max > 0 ? max : FIELD_MAX;
  if (typeof value !== "string" || value.length === 0) return fallback;
  let s = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ") // control chars + ANSI/OSC introducers
    // Square brackets stripped so an untrusted value cannot FORGE a status marker
    // (`[BLOCK]` / `[ADVISORY]`) inside the body the agent reads as authoritative, nor
    // spoof the markers the fixture harnesses assert on.
    .replace(/[[\]]/g, "")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return fallback;
  if (s.length > cap) s = s.slice(0, cap) + "…";
  return s;
}

/**
 * The ONE user-visible line this module emits, and the ONE place its disclosure shape is
 * decided.
 *
 * DISCLOSURE: the receipt path is emitted REPO-RELATIVE, plus a fixed LABEL naming which
 * root it was found under — never the absolute path. An absolute candidate is
 * `/Users/<operator>/repos/...`, which is precisely `identity-scrub.mjs::makeHomepathRe`'s
 * operator-PII shape, and hook stderr lands in the transcript that agents quote into
 * journals and PRs (`user-flow-validation.md` MUST-6). The root LABEL is a constant, not a
 * basename: a repo basename can itself be a client/tenant token.
 *
 * Receipt CONTENT is never emitted here — the whole point of a refusal is that the content
 * was not trusted, so echoing it would publish the untrusted bytes the refusal exists to
 * contain. Nor is the underlying reader's `reason` string, which interpolates the absolute
 * path; only its short typed `error` code, which carries no path.
 *
 * @param {string} rootLabel   fixed label, e.g. `invoking tree`
 * @param {string} receiptRel  repo-relative receipt path
 * @param {string} what        path-free description of what happened
 * @param {string} remedy      path-free operator-actionable next step
 */
function warnReceipt(rootLabel, receiptRel, what, remedy) {
  try {
    process.stderr.write(
      `[override-receipt] receipt ${receiptRel} under the ${rootLabel} ${what} — NOT honoured. ${remedy}\n`,
    );
  } catch {
    // stderr itself is unavailable; the refusal the caller is about to make still stands.
  }
}

/**
 * Read one receipt candidate under the shared containment + `O_NOFOLLOW` discipline.
 *
 * WHY THIS EXISTS AS A SHARED EXPORT: before it, this module's read was
 * `existsSync` → `readFileSync` → `unlinkSync`, all path-based and all following symlinks,
 * and the sibling peeks in `wip-discipline-guard.js` had the identical shape. That is a
 * SYMLINK READ PRIMITIVE: `ln -s ~/.aws/credentials .claude/wip-authz/wip-limit-allow`,
 * trip the gate, and the file's first bytes become the `reason` — echoed verbatim into the
 * agent-visible advisory and the user-visible line, since `safeField` neutralizes control
 * characters but PRESERVES content. Bounded by what the hook process can read, which is
 * everything the operator can read. Every reader of this receipt goes through here so the
 * hardening cannot hold at one call site and not another
 * (`security.md` § Enforcement-Surface Parity).
 *
 * WHAT THIS CLOSES: the SYMLINK class, and the sibling shapes the shared reader already
 * refuses (out-of-tree ancestor, dangling link, FIFO, directory, hard link, oversize).
 *
 * WHAT THIS DOES NOT CLOSE, stated so no caller over-reads it: the check-to-use TOCTOU.
 * `security.md` § Path Containment records the three-phase swap as an ACCEPTED OPEN
 * residual — Node exposes no `openat`, so "the path I checked" cannot be atomically bound
 * to "the fd I opened" for the ancestors. `O_NOFOLLOW` binds the final component only. No
 * claim is made here that TOCTOU is closed.
 *
 * @returns {{state:"read", text:string} | {state:"absent"} | {state:"refused"}}
 */
function readReceiptGuarded(abs, root, rootLabel, receiptRel) {
  // PRESENCE PROBE ONLY — this lstat is NOT the fence, and must not be read as one. The
  // fence is `readSinkFile`'s `O_NOFOLLOW` open below. Its ONLY job is to decide QUIET vs
  // LOUD: `lstat` does not follow the final component, so a planted symlink counts as
  // PRESENT here and goes on to be refused loudly, while a genuinely-empty candidate — the
  // overwhelmingly common case, since most roots hold no receipt — stays silent instead of
  // emitting a line on every guard invocation.
  try {
    fs.lstatSync(abs);
  } catch {
    return { state: "absent" };
  }

  const r = readSinkFile({
    repoDir: root,
    sinkPath: abs,
    maxBytes: RECEIPT_MAX_BYTES,
  });
  if (r.ok) return { state: "read", text: r.text.trim() };
  // Raced away between the probe and the open. Genuinely absent, so genuinely quiet.
  if (r.absent) return { state: "absent" };

  // Something OCCUPIES the receipt path but could not be safely read. This is LOUD by
  // construction: a silent refusal here would be byte-identical to "no receipt", which is
  // the absence-reads-as-clean shape (`conservation-gate.md` MUST-4) — an operator who
  // wrote a receipt would watch their override never fire, with nothing said. Only the
  // short typed `error` is emitted; the reader's `reason` embeds the absolute path.
  warnReceipt(
    rootLabel,
    receiptRel,
    `could NOT be safely read (${r.error})`,
    "Replace it with a plain regular file containing your one-line reason, then retry.",
  );
  return { state: "refused" };
}

/**
 * Build an override gate.
 *
 * @param {object}   opts
 * @param {string}   opts.receiptRel  REQUIRED. Repo-relative receipt path, e.g.
 *                                    `.claude/dispatch-authz/dispatch-contract-allow`.
 * @param {string}   opts.envVar      REQUIRED. Operator/CI env channel, e.g.
 *                                    `COC_ALLOW_DISPATCH_CONTRACT`.
 * @param {function} [opts.extraRoots] `() => string[]` — additional ABSOLUTE roots to
 *                                    search besides the invoking tree. Consumers pass the
 *                                    MAIN checkout here, so a call issued from inside a
 *                                    linked worktree still finds an operator's receipt.
 *                                    A callback (not an array) so a consumer that must
 *                                    spawn git to learn its roots pays that cost ONLY on
 *                                    the path that actually needs a receipt.
 * @param {string}   [opts.cwd]       Base for the invoking-tree candidate. Defaults to
 *                                    `process.cwd()`. Injectable so fixtures are hermetic.
 * @returns {object} the gate
 */
function createOverrideGate({ receiptRel, envVar, extraRoots, cwd } = {}) {
  if (typeof receiptRel !== "string" || receiptRel.trim() === "") {
    throw new TypeError(
      "createOverrideGate: `receiptRel` is REQUIRED — a gate with no receipt path is a " +
        "silently dead override channel (documented but unreachable).",
    );
  }
  if (typeof envVar !== "string" || envVar.trim() === "") {
    throw new TypeError(
      "createOverrideGate: `envVar` is REQUIRED — a gate with no operator channel cannot " +
        "be turned off for a CI run.",
    );
  }

  const RECEIPT_REL = receiptRel;
  const ENV_VAR = envVar;
  const rootsFn = typeof extraRoots === "function" ? extraRoots : () => [];

  /**
   * Candidate receipt RECORDS, in precedence order: the invoking tree first (where an
   * agent writes while working, possibly a linked worktree), then each extra root (where
   * an operator drops one). Resolving only one of the two is what makes an override
   * unreachable for the other party.
   *
   * Each record carries its ROOT (the containment boundary the shared reader needs) and a
   * fixed LABEL (the disclosure-safe way to say WHICH tree a refusal happened in — see
   * `warnReceipt`). `receiptCandidates()` below projects these to absolute paths so the
   * public shape is unchanged.
   */
  function receiptCandidateRecords() {
    const base = typeof cwd === "string" && cwd ? cwd : process.cwd();
    const out = [
      {
        root: base,
        abs: path.resolve(base, RECEIPT_REL),
        label: "invoking tree",
      },
    ];
    let extras = [];
    try {
      extras = rootsFn() || [];
    } catch {
      extras = []; // A root resolver that throws must not kill the primary candidate.
    }
    let n = 0;
    for (const r of extras) {
      if (typeof r !== "string" || !r) continue;
      const p = path.resolve(r, RECEIPT_REL);
      n += 1;
      if (out.some((c) => c.abs === p)) continue;
      out.push({ root: r, abs: p, label: `extra root #${n}` });
    }
    return out;
  }

  /**
   * Candidate ABSOLUTE receipt paths. Unchanged public shape (an array of absolute path
   * strings); the records above are the internal form.
   */
  function receiptCandidates() {
    return receiptCandidateRecords().map((c) => c.abs);
  }

  /**
   * Channel 2 — operator / CI environment. Checked against the LITERAL "1" rather than a
   * truthiness test, so an accidental `VAR=0` or `VAR=` does not silently disarm a guard.
   *
   * @param {object} [env] defaults to `process.env`; injectable for fixtures.
   */
  function envOverride(env) {
    const e = env && typeof env === "object" ? env : process.env;
    if (e[ENV_VAR] !== "1") return null;
    return {
      source: "env",
      channel: `${ENV_VAR}=1`,
      reason: null,
      detail: "Set in the session environment by the operator or harness.",
      consumedPath: null,
    };
  }

  /**
   * Channel 1 — the agent-reachable ONE-SHOT receipt.
   *
   * Returns the override (and DELETES the receipt) when a candidate holds a non-empty
   * reason, else null. The delete is what stops one override from disarming the gate for
   * the rest of the session. Every read goes through `readReceiptGuarded`, so a symlinked,
   * out-of-tree, hard-linked, non-regular or oversized candidate is REFUSED rather than
   * read — see that function for what the hardening does and does not close.
   */
  function consumeReceipt() {
    for (const c of receiptCandidateRecords()) {
      const got = readReceiptGuarded(c.abs, c.root, c.label, RECEIPT_REL);
      // `absent` (nothing here) and `refused` (something here we would not read) both mean
      // NO OVERRIDE FROM THIS CANDIDATE. They differ only in loudness, which
      // `readReceiptGuarded` has already decided.
      if (got.state !== "read") continue;
      const reason = got.text;
      if (!reason) continue; // An EMPTY receipt is not an override. The reason is the price.
      try {
        fs.unlinkSync(c.abs);
      } catch (e) {
        // The unlink IS the one-shot property (§ 3 above). A receipt that cannot be deleted
        // is DURABLE, and this module's own header calls a durable receipt "worse than no
        // receipt at all" — it lifts the gate for every later call in the session. The
        // "best-effort" disposition this replaced returned the override anyway, with `detail`
        // asserting "CONSUMED (deleted)", so all three consumer guards were disarmed for the
        // rest of the session by a claim about an action that did not happen.
        //
        // CONTINUE, DO NOT RETURN. Returning outright made ONE undeletable receipt a DENIAL
        // OF SERVICE ON THE ESCAPE HATCH ITSELF: candidates are ordered invoking-tree-FIRST,
        // so an undeletable receipt there (immutable flag, read-only parent dir, root-owned
        // file, read-only mount) is found first on EVERY call and no operator receipt in the
        // main checkout could ever be reached — leaving all three consuming guards
        // (`wip-discipline`, `nested-worktree`, `dispatch-contract`) with a `block` and no
        // working escape, which is the dead-end `hook-output-discipline.md` MUST NOT calls a
        // defect. Skipping past it is SAFE precisely BECAUSE it is undeletable: its unlink
        // fails identically on every future call, so it can never be honoured and can never
        // disarm anything. Leaving it in place costs one stderr line per call; returning
        // costs the operator their only escape. Refusal is still total when EVERY candidate
        // fails — the loop simply ends with no override, which is this function's own
        // no-receipt verdict.
        //
        // Fail into "no override" per § FAIL-OPEN, EXCEPT AT CONSTRUCTION: the guard's own
        // verdict STANDS.
        //
        // SURFACED, never silent: the operator wrote a receipt and is owed the reason it did
        // not lift. The path is emitted REPO-RELATIVE with a root LABEL, never absolute —
        // see `warnReceipt` for why. Receipt CONTENT is not echoed.
        warnReceipt(
          c.label,
          RECEIPT_REL,
          `could NOT be deleted (${(e && e.code) || (e && e.name) || "unknown"})`,
          "An undeletable receipt would disarm this gate for the rest of the session. " +
            "Remove it, or fix its directory permissions, then retry.",
        );
        continue;
      }
      return {
        source: "receipt",
        channel: `one-shot receipt ${RECEIPT_REL}`,
        reason,
        detail: "Receipt CONSUMED (deleted); it will not lift the next call.",
        consumedPath: c.abs,
      };
    }
    return null;
  }

  /**
   * Resolve any armed override. ENV IS CHECKED FIRST, deliberately: an env-armed run must
   * NOT eat a receipt an agent wrote for a later call. Ordering the other way would make a
   * CI run silently spend the agent's one shot.
   */
  function resolveOverride(env) {
    return envOverride(env) || consumeReceipt();
  }

  /**
   * The one-line RECORD. This is the sentence that makes the override audited rather than
   * free: it names the channel, states the one-shot consumption, and QUOTES the stated
   * reason (sanitized). Consumers embed it in whatever advisory shape they emit.
   */
  function formatOverrideLine(override) {
    if (!override || typeof override !== "object") return "";
    const parts = [`Override HONOURED via ${override.channel}.`];
    if (override.detail) parts.push(override.detail);
    if (override.reason) {
      parts.push(`Stated reason: "${safeField(override.reason, "(none)")}"`);
    } else {
      parts.push(
        "No per-call reason is captured on this channel — the environment channel is " +
          "operator-scoped and applies to the whole run.",
      );
    }
    return parts.join(" ");
  }

  /**
   * The "how to override" sentence, for embedding in a BLOCK body. A block whose escape is
   * not stated in the block itself is an unreachable escape.
   */
  function formatOverrideInstruction() {
    return (
      `OVERRIDE (if this is genuinely correct as issued) — write a one-line REASON to ` +
      `${RECEIPT_REL} and re-issue this exact call. The receipt is CONSUMED on use ` +
      `(one-shot), and your stated reason is echoed back into the transcript, so the ` +
      `override is recorded rather than free. An empty receipt is not an override. ` +
      `Operator/CI channel: ${ENV_VAR}=1.`
    );
  }

  return {
    RECEIPT_REL,
    ENV_VAR,
    receiptCandidates,
    receiptCandidateRecords,
    envOverride,
    consumeReceipt,
    resolveOverride,
    formatOverrideLine,
    formatOverrideInstruction,
  };
}

/**
 * NON-DESTRUCTIVE hardened read of a receipt at `<root>/<receiptRel>`, returning its
 * trimmed text or `null`.
 *
 * Exported for the sibling PEEK call sites (`wip-discipline-guard.js::peekReceiptText` /
 * `::peekReceipt`), which answer "is a receipt present / what does it say" WITHOUT
 * consuming it. They previously carried their own `readFileSync`-by-path loop — the same
 * symlink read primitive `consumeReceipt` had, in a second copy. Routing every receipt
 * reader through one implementation is `security.md` § Enforcement-Surface Parity: harden
 * one call site and leave a sibling naive and the attacker simply picks the sibling.
 *
 * Refusals are LOUD here exactly as they are on the consume path, so a peek can never
 * report "no receipt" about a path something occupies without saying so.
 *
 * @param {string} root        containment root (the tree the receipt is relative to)
 * @param {string} receiptRel  repo-relative receipt path
 * @param {string} [rootLabel] disclosure-safe label for stderr; defaults to a generic one
 * @returns {string|null} the trimmed non-empty reason, or null (absent / refused / empty)
 */
function readReceiptText(root, receiptRel, rootLabel) {
  const got = readReceiptState(root, receiptRel, rootLabel);
  return got.state === "read" ? got.text || null : null;
}

/**
 * The same read, returning the DISCRIMINATION rather than collapsing it.
 *
 * `readReceiptText` answers "what does it say", and folds `absent` and `refused` into one
 * `null` because that is all its callers need. This exports the distinction for a caller
 * that must REPORT which happened — notably `wip-discipline-guard.js::receiptPriceViolation`,
 * whose typed reason would otherwise say `"absent"` about a path something OCCUPIES while
 * this module simultaneously wrote a LOUD refusal to stderr about that same path. Two
 * surfaces disagreeing on one event is how a real refusal gets read as a benign
 * no-receipt six weeks later.
 *
 * The three states are exhaustive and mutually exclusive:
 *   - `read`    — a regular, contained, in-bounds file yielded text (possibly empty).
 *   - `absent`  — nothing occupies the path.
 *   - `refused` — something occupies it that this module will not read (symlinked or
 *                 otherwise escaping the root, dangling, a directory, a FIFO or device,
 *                 hard-linked, or over `RECEIPT_MAX_BYTES`). Already surfaced on stderr
 *                 by the time this returns, so a caller MUST NOT re-emit the path.
 *
 * NOTE the containment semantics, because they are narrower than "symlinks are refused"
 * and the difference is load-bearing: refusal is keyed on ESCAPING THE ROOT, not on being
 * a symlink. A symlinked `.claude/wip-authz` whose target stays INSIDE the same root
 * resolves fine and is honoured silently — MEASURED, both poles, on this tree. Only a
 * target that resolves outside every declared root is refused.
 *
 * @returns {{state:"read", text:string} | {state:"absent"} | {state:"refused"}}
 */
function readReceiptState(root, receiptRel, rootLabel) {
  if (typeof root !== "string" || !root) return { state: "absent" };
  if (typeof receiptRel !== "string" || !receiptRel) return { state: "absent" };
  let abs;
  try {
    abs = path.resolve(root, receiptRel);
  } catch {
    return { state: "absent" };
  }
  return readReceiptGuarded(abs, root, rootLabel || "candidate tree", receiptRel);
}

module.exports = {
  FIELD_MAX,
  RECEIPT_MAX_BYTES,
  safeField,
  createOverrideGate,
  readReceiptText,
  readReceiptState,
};
