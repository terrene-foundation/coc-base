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
 *   2. PRICED. The receipt must carry a NON-EMPTY REASON. An empty reason is not an
 *      override. This is what makes overriding cost a sentence of justification instead
 *      of nothing.
 *   3. ONE-SHOT. The public receipt is CLAIMED before honour (override-receipt.js:933-1005). Without this, one
 *      override silently disarms the gate for every later call in the session — the exact
 *      failure mode a permanent env var has, and the reason a durable receipt would be
 *      worse than no receipt at all.
 *   4. RECORDED. The stated reason is echoed back into agent-visible context and onto the
 *      user-visible stderr line, AND every honoured receipt appends one row to a durable USE
 *      LEDGER in the MAIN checkout (§ THE USE LEDGER). "Non-empty" alone would let `x` buy
 *      an override; echoing it means the justification is read by the party who can judge
 *      it, and the ledger means the use can still be audited after the session ends.
 *   5. CALL-BOUND. A receipt names the ONE call it may lift, by digest (§ THE CALL DIGEST),
 *      and is honoured only on an EXACT match.
 *   6. TIME-BOUND. A receipt expires `RECEIPT_TTL_MS` after its OWN `written_at`.
 *
 * WHY 5 AND 6 EXIST (2026-10-10). Until then `consumeReceipt` honoured ANY non-empty
 * receipt for ANY blocked call on the channel — no binding, no expiry, no use ledger.
 * `dispatch-contract-guard.js` admitted it in its own header: a receipt written for one
 * blocked dispatch lifted whichever blocked dispatch arrived first. One receipt was a
 * bearer token for the whole gate until something spent it, and the spend named no call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CALL DIGEST — the canonical serialization, stated exactly
 * ─────────────────────────────────────────────────────────────────────────────
 *     digest = lowercase hex( sha256( UTF-8( JSON.stringify(
 *                [CALL_DIGEST_DOMAIN, tool, subagentType, prompt, findingIds] ) ) ) )
 *
 *   CALL_DIGEST_DOMAIN  "coc-override-receipt/call-digest/v1" — domain separation, and the
 *                       version: a change to anything below is a new domain string.
 *   tool                the payload's `tool_name`, byte-exact ("" when absent).
 *   subagentType        `tool_input.subagent_type` (or `subagentType`), byte-exact, NOT
 *                       trimmed ("" when absent or not a string).
 *   prompt              the call's PRINCIPAL input, byte-exact (`callPromptOf`):
 *                       `tool_input.prompt` when it is a string (Task / Agent), else
 *                       `tool_input.command` when it is a string (Bash and the Codex /
 *                       Gemini shell tools), else the RFC 8785 canonical JSON of the whole
 *                       `tool_input` (EnterWorktree `{name, path}`). A `tool_input` that
 *                       cannot be canonicalized yields NO digest, and no receipt can bind.
 *   findingIds          the blocking finding ids, de-duplicated, empty and non-string entries
 *                       dropped, sorted by JavaScript's default (UTF-16 code unit) order.
 *
 * WHY A JSON ARRAY. Each element is a JSON string (or an array of them), so every quote,
 * backslash and control character inside a prompt is escaped by `JSON.stringify` and no
 * prompt can forge an element boundary — a delimiter-joined form would let a prompt ending
 * in the delimiter collide with a different (prompt, findingIds) pair. `JSON.stringify`
 * output for strings is fully specified by ECMA-262 (lone surrogates are escaped), so the
 * bytes are reproducible by any reader. `description` is deliberately NOT bound: an agent
 * re-issuing "this exact call" rephrases it freely, and binding it would make the honest
 * retry fail while adding nothing the prompt does not already pin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RECEIPT
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE JSON object, with EXACTLY these three string fields and no others:
 *
 *     {"digest":"<64 lowercase hex>","reason":"<one-line reason>","written_at":"<ISO-8601>"}
 *
 * `written_at` is an ISO-8601 timestamp WITH a zone (`Z` or `±hh:mm`), e.g. the output of
 * `date -u +%Y-%m-%dT%H:%M:%SZ`. The block body prints the exact line to write, with this
 * block's own time already in `written_at` (`formatReceiptTemplate`), so the honest path is
 * one edit: replace `REASON_PLACEHOLDER`. A reason still carrying the placeholder is
 * REFUSED — a template that could be pasted verbatim would TEACH the free override.
 * The pre-2026-10-10 plain-text one-line receipt is RETIRED and is refused as malformed.
 *
 * TTL — `RECEIPT_TTL_MS` (15 minutes), measured from the receipt's OWN `written_at`. A
 * receipt is written to lift the call that was JUST blocked: block → write → re-issue is
 * one agent turn of seconds to a few minutes, and even a refused-then-corrected receipt
 * (a price refusal at the WIP gate, a reason fix) re-issues well inside it. Anything older
 * is a receipt that outlived the call it was written for, and the danger the bound exists
 * for is precisely that shape: an identical command or brief re-issued later — the next
 * session, a re-run lane — riding a forgotten receipt. `written_at` is writer-supplied, so
 * the TTL bounds FORGOTTEN receipts, not a hostile writer (who could always write a fresh
 * one): a `written_at` more than `RECEIPT_FUTURE_SKEW_MS` ahead of the hook's clock is
 * refused, so a mistyped date cannot stretch the window.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A RECEIPT THAT IS NOT HONOURED IS LEFT IN PLACE, AND SAID SO BY NAME
 * ─────────────────────────────────────────────────────────────────────────────
 * Malformed, written for a DIFFERENT call, stale, future-dated, unreadable: each is
 * refused WITHOUT being consumed, and the refusal is LOUD — a `[override-receipt] <CODE>:`
 * line on stderr (fed back to the agent when the guard blocks) and the same line in the
 * agent-visible block body (`formatOverrideInstruction`) — with a named code from
 * `REFUSAL`. Consuming a receipt the call could not use would spend the operator's
 * override on the wrong call, which is the very defect property 5 closes; staying silent
 * would make "your receipt was refused" byte-identical to "there is no receipt"
 * (`conservation-gate.md` MUST-4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE USE LEDGER
 * ─────────────────────────────────────────────────────────────────────────────
 * `<main checkout>/.claude/learning/override-receipt-uses.jsonl`, append-only, ONE row per
 * honoured receipt, every channel in one file:
 *
 *     {"v":1,"at":"<ISO>","channel":"<receipt rel path>","digest":"<64 hex>",
 *      "reason_sha256":"<64 hex>","written_at":"<receipt written_at>",
 *      "found_under":"invoking tree"|"extra root #N",
 *      "consumer":{"session_id":…,"agent_id":…,"agent_type":…,"tool_use_id":…}}
 *
 * The REASON is stored as a hash, never in clear: it is operator free text, and the
 * transcript already carries it. The main checkout is resolved from the tree the receipt
 * was FOUND in by `append-sink.js::mainCheckoutBoundaryRoots` — the one derivation of a
 * `.claude/learning/**` sink's root, built on the fail-closed
 * `state-resolver.js::requireMainCheckout` — so a worktree's override lands in the ONE
 * ledger every worktree of that repo shares, written through `append-sink.js::appendSinkLine`
 * (the hardened JSONL append). `.claude/learning/**` is gitignored, so the ledger never
 * dirties a tree.
 *
 * HONOURED ⇔ CLAIMED AND RECORDED. Atomic rename moves the public receipt into a private
 * same-parent claim directory before claimed bytes are validated and the use is recorded.
 * A priced peek binds both candidate path and original-byte SHA; a changed claim refuses.
 * Failed recording restores the original inode with a no-clobber link, or retains the
 * claim loudly if a newer public receipt occupies the path. Recorded uses never restore
 * after cleanup failure. Source: .claude/hooks/lib/override-receipt.js:656-685,867-1005.
 * This is concurrent one-shot exclusion, not crash-durable exactly-once execution. A
 * same-OS actor changing ancestor directories or writing an already-open inode remains
 * outside this claim boundary; the guarded reader's filesystem residuals still apply.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAILING INTO "NO OVERRIDE", EXCEPT AT CONSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────────
 * Every runtime path fails into "no override" (`cc-artifacts.md` Rule 7): an unreadable
 * candidate, a receipt that is a directory, a tree that does not exist, a candidate
 * REFUSED by the hardened read, an undeletable receipt, a ledger that cannot be written.
 * Note the DIRECTION — the guard's own verdict STANDS, so a broken override channel cannot
 * wave a call through. It can only fail to rescue one.
 *
 * FAILING IS PER-CANDIDATE, NEVER PER-CALL, and the distinction is load-bearing. A
 * candidate that cannot be read, is not valid for this call, or cannot be deleted
 * disqualifies ITSELF and the loop moves on; it does not disqualify the ones behind it.
 * Ordering is invoking-tree-FIRST, so the per-call reading turned a single poisoned
 * receipt in the invoking tree into a DENIAL OF SERVICE on the escape hatch — an
 * operator's receipt in the main checkout could never be reached.
 *
 * Every refusal is SURFACED (see above), with the receipt path REPO-RELATIVE plus a root
 * LABEL rather than the absolute operator path (see `emitRefusalLine`).
 *
 * CONSTRUCTION is the one place this module is LOUD by throwing: `createOverrideGate`
 * THROWS on a missing `receiptRel` or `envVar`. A gate misconfigured at construction would
 * be a silently DEAD override channel, which reads exactly like a working one until an
 * agent needs it and the block will not lift. That is the "documented but unreachable"
 * defect, and it is caught at require-time rather than at 2am.
 *
 * Origin: 2026-08-23 — extracted from `nested-worktree-guard.js` (2026-08-19) when a second
 * guard needed the same contract. The originating incident for the SECOND consumer: an
 * orchestrator overrode a correctly-firing dispatch-contract finding with the words "right
 * as issued", which was false; the lane burned ~119k tokens and delivered nothing. Detection
 * was never the gap — the gap was that overriding cost nothing and left no record.
 * 2026-10-10 — call binding, the TTL and the use ledger (properties 5, 6 and the durable
 * half of 4), adopted by all four consumers together.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// The SHARED hardened reader AND appender. Not a second copy of a containment check:
// `append-sink.js` exports `readSinkFile` explicitly "so every sink READER shares this one
// implementation rather than re-deriving a containment check that will drift from the
// append path", and a receipt is exactly such a read. It supplies, in one call, root
// containment, dangling-symlink refusal at the ancestor, `O_NOFOLLOW` at the final
// component, `O_NONBLOCK` against a planted FIFO, a regular-file `fstat`, hard-link refusal,
// an fd-vs-directory identity reconcile, and a byte bound enforced BY THE READ.
// `appendSinkLine` is the same module's hardened JSONL append, used for the use ledger, and
// `mainCheckoutBoundaryRoots` is the ONE derivation of the main-checkout root for a
// `.claude/learning/**` sink (`audit-fixtures/append-sink-boundary-roots/` refuses a
// hooks/lib caller that re-derives it). `require` is cycle-free — `append-sink.js` pulls
// only `fs`/`path` at load.
const { readSinkFile, appendSinkLine, mainCheckoutBoundaryRoots } = require("./append-sink.js");

/** DEFAULT cap on any untrusted field echoed back into agent-visible text. */
const FIELD_MAX = 80;

/**
 * Hard byte bound on a receipt read. A receipt is ONE LINE of justification; 64 KiB is
 * orders of magnitude of headroom over any honest one. Over the cap the read is refused
 * WHOLESALE (never truncated), which fails into "no override" like every other refusal
 * here — so an oversized receipt cannot lift a gate on a prefix nobody wrote.
 */
const RECEIPT_MAX_BYTES = 64 * 1024;

/** Domain + version of the call digest. See § THE CALL DIGEST. */
const CALL_DIGEST_DOMAIN = "coc-override-receipt/call-digest/v1";

/** A receipt expires this long after its own `written_at`. See § THE RECEIPT for why 15 min. */
const RECEIPT_TTL_MS = 15 * 60 * 1000;

/**
 * How far AHEAD of the hook's clock a `written_at` may sit before it is refused. The writer
 * and the hook run on the same host, so this absorbs only second-truncation and a stepped
 * clock — never a window extension.
 */
const RECEIPT_FUTURE_SKEW_MS = 60 * 1000;

/** The receipt's fields — exactly these, all strings, no others. */
const RECEIPT_FIELDS = Object.freeze(["digest", "reason", "written_at"]);

/** The reason slot of the printed template. A receipt still carrying it is refused. */
const REASON_PLACEHOLDER = "<REPLACE WITH YOUR ONE-LINE REASON>";

/** The use ledger, relative to the MAIN checkout. See § THE USE LEDGER. */
const USE_LEDGER_REL = path.join(".claude", "learning", "override-receipt-uses.jsonl");

/** Cap on each payload-derived consumer-identity field written to the ledger. */
const CONSUMER_FIELD_MAX = 128;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const WRITTEN_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The NAMED refusals. Each is the prefix of the stderr line AND of the agent-visible note,
 * so a refusal can be grepped for, and a reader never has to infer which one happened.
 */
const REFUSAL = Object.freeze({
  UNREADABLE: "RECEIPT-UNREADABLE",
  UNDELETABLE: "RECEIPT-UNDELETABLE",
  MALFORMED: "RECEIPT-MALFORMED",
  DIGEST_MISMATCH: "RECEIPT-DIGEST-MISMATCH",
  STALE: "RECEIPT-STALE",
  FUTURE_DATED: "RECEIPT-FUTURE-DATED",
  NO_CALL_DIGEST: "RECEIPT-UNBINDABLE-CALL",
  LEDGER_UNRESOLVED: "USE-LEDGER-UNRESOLVED",
  LEDGER_WRITE_FAILED: "USE-LEDGER-WRITE-FAILED",
  CONTENT_CHANGED: "RECEIPT-CONTENT-CHANGED",
  CLAIM_RETAINED: "RECEIPT-CLAIM-RETAINED",
  CLAIM_CLEANUP_FAILED: "RECEIPT-CLAIM-CLEANUP-FAILED",
});

const TTL_MINUTES = Math.round(RECEIPT_TTL_MS / 60000);

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

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * The ONE user-visible line this module emits per refusal, and the ONE place its
 * disclosure shape is decided.
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
 * contain. The two exceptions are VALIDATED shapes, never free text: a receipt digest that
 * already matched `DIGEST_RE`, and an age in whole minutes. Nor is the underlying reader's
 * `reason` string, which interpolates the absolute path; only its short typed `error` code.
 */
function emitRefusalLine(line) {
  try {
    process.stderr.write(`[override-receipt] ${line}\n`);
  } catch {
    // stderr itself is unavailable; the refusal the caller is about to make still stands.
  }
}

/** One refusal, rendered. `leftInPlace` states the receipt's fate in the same sentence. */
function refusalText(code, label, receiptRel, what, remedy, leftInPlace) {
  const fate = leftInPlace ? "NOT honoured, NOT consumed — left in place" : "NOT honoured";
  return `${code}: receipt ${receiptRel} under the ${label} ${what} — ${fate}. ${remedy}`;
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
 * @param {function} [onRefused]  `(what, remedy) => void` — report a refusal through the
 *                                caller's (de-duplicating) channel instead of directly. Both
 *                                strings are already rendered and path-free.
 * @returns {{state:"read", text:string} | {state:"absent"} | {state:"refused"}}
 */
function readReceiptGuarded(abs, root, rootLabel, receiptRel, onRefused) {
  // ONE refusal channel for every UNREADABLE outcome: the caller's de-duplicating `onRefused`
  // when given, else straight to stderr. It receives the rendered WHAT and REMEDY rather than a
  // bare error code, so the remedy this function chose (a parent-directory problem vs an occupied
  // receipt path) reaches the operator on the callback path too, not only on the direct one.
  const unreadable = (what, remedy) => {
    if (typeof onRefused === "function") onRefused(what, remedy);
    else emitRefusalLine(refusalText(REFUSAL.UNREADABLE, rootLabel, receiptRel, what, remedy, true));
  };
  // PRESENCE PROBE ONLY — this lstat is NOT the fence, and must not be read as one. The
  // fence is `readSinkFile`'s `O_NOFOLLOW` open below. Its ONLY job is to decide QUIET vs
  // LOUD: `lstat` does not follow the final component, so a planted symlink counts as
  // PRESENT here and goes on to be refused loudly, while a genuinely-empty candidate — the
  // overwhelmingly common case, since most roots hold no receipt — stays silent instead of
  // emitting a line on every guard invocation.
  let probeFailure = null;
  try {
    fs.lstatSync(abs);
  } catch (e) {
    // ENOENT-ONLY quiet path. A genuine absence — the overwhelmingly common case, most roots
    // hold no receipt — stays silent. Any OTHER failure (EACCES/ELOOP/ENOTDIR/…) means presence
    // is UNKNOWN: this probe's own job is to decide QUIET vs LOUD, and laundering a failed
    // presence check into `absent` makes it QUIET — byte-identical to "no receipt", the
    // absence-reads-as-clean shape. Fall through to the guarded read below, whose typed
    // refusal is reported LOUDLY — with the probe's errno kept, because the remedy differs.
    if (e && e.code === "ENOENT") return { state: "absent" };
    probeFailure = (e && e.code) || "error";
  }

  const r = readSinkFile({
    repoDir: root,
    sinkPath: abs,
    maxBytes: RECEIPT_MAX_BYTES,
    rawBytes: true,
  });
  if (r.ok && Buffer.isBuffer(r.rawBytes) && Buffer.from(r.text, "utf8").equals(r.rawBytes)) {
    return { state: "read", text: r.text.trim(),
      sha256: crypto.createHash("sha256").update(r.rawBytes).digest("hex") };
  }
  if (r.ok) {
    unreadable("could NOT be safely read (invalid UTF-8 receipt bytes)",
      "Replace it with a plain regular file holding UTF-8 JSON receipt bytes, then retry.");
    return { state: "refused" };
  }
  // Raced away between the probe and the open. Genuinely absent, so genuinely quiet.
  if (r.absent) return { state: "absent" };

  // Something OCCUPIES the receipt path but could not be safely read. This is LOUD by
  // construction: a silent refusal here would be byte-identical to "no receipt", which is
  // the absence-reads-as-clean shape (`conservation-gate.md` MUST-4) — an operator who
  // wrote a receipt would watch their override never fire, with nothing said. Only the
  // short typed `error` is emitted; the reader's `reason` embeds the absolute path.
  //
  // TWO REMEDIES, because there are two worlds. When the presence probe itself failed
  // (`probeFailure` set), nothing may occupy the receipt path at all — the fault is a PARENT
  // directory (unsearchable, not a directory, or a symlink loop), and "replace it with a plain
  // file" would send the operator to fix a file that is not the problem. Only the errno code is
  // emitted; it carries no path.
  unreadable(
    probeFailure
      ? `could NOT be safely read (${r.error}; its presence could not be checked: ${probeFailure})`
      : `could NOT be safely read (${r.error})`,
    probeFailure
      ? "A PARENT DIRECTORY of the receipt is the problem, not the receipt: one of them is " +
          "unreadable/unsearchable, is not a directory, or is a symlink loop. Repair the parent " +
          "directories so the path resolves inside this tree, place a plain regular file there " +
          "holding the one-line JSON receipt, then retry."
      : "Replace it with a plain regular file holding the one-line JSON receipt, then retry.",
  );
  return { state: "refused" };
}

// ── THE CALL DIGEST ──────────────────────────────────────────────────────────

/** The finding-id element of the digest: de-duplicated, non-strings dropped, sorted. */
function canonicalFindingIds(findingIds) {
  const list = Array.isArray(findingIds) ? findingIds : [];
  return [...new Set(list.filter((s) => typeof s === "string" && s !== ""))].sort();
}

/**
 * The call digest. Pure; the serialization is § THE CALL DIGEST, verbatim.
 *
 * @param {{tool?:string, subagentType?:string, prompt?:string, findingIds?:string[]}} parts
 * @returns {string} 64 lowercase hex characters
 */
function computeCallDigest({ tool, subagentType, prompt, findingIds } = {}) {
  const text = (v) => (typeof v === "string" ? v : "");
  const canonical = JSON.stringify([
    CALL_DIGEST_DOMAIN,
    text(tool),
    text(subagentType),
    text(prompt),
    canonicalFindingIds(findingIds),
  ]);
  return sha256Hex(canonical);
}

/**
 * The call's PRINCIPAL input — the digest's `prompt` element. Returns null only when a
 * `tool_input` with neither a string `prompt` nor a string `command` cannot be
 * canonicalized; a call with no digest can be lifted by no receipt.
 */
function callPromptOf(toolInput) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  if (typeof ti.prompt === "string") return ti.prompt;
  if (typeof ti.command === "string") return ti.command;
  try {
    // Lazy: only the non-prompt, non-command shapes (EnterWorktree) pay for it. The ONE
    // RFC 8785 canonicalizer in this repo, so this digest and every other canonical hash
    // here agree about what "canonical" means.
    const { jcsCanonicalize } = require("./jcs-canonicalize.js");
    return jcsCanonicalize(ti);
  } catch {
    return null;
  }
}

/**
 * The digest of ONE call, as a consumer sees it in its PreToolUse payload.
 *
 * @param {string}   toolName    the payload's `tool_name`
 * @param {object}   toolInput   the payload's `tool_input`
 * @param {string[]} findingIds  the BLOCKING finding ids this receipt may lift
 * @returns {string|null}        64-hex digest, or null when the call cannot be digested
 */
function callDigestOf(toolName, toolInput, findingIds) {
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  const prompt = callPromptOf(ti);
  if (prompt === null) return null;
  const sub = ti.subagent_type !== undefined ? ti.subagent_type : ti.subagentType;
  return computeCallDigest({
    tool: typeof toolName === "string" ? toolName : "",
    subagentType: typeof sub === "string" ? sub : "",
    prompt,
    findingIds,
  });
}

/**
 * The consuming party's identity, read from a hook payload. CC populates `agent_id` /
 * `agent_type` only inside a subagent (`provenance-capture-tool.js`), so their absence is
 * "the main agent or a runtime that does not send them", never evidence of either.
 */
function consumerOf(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return {
    session_id: p.session_id !== undefined ? p.session_id : p.sessionId,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    tool_use_id: p.tool_use_id,
  };
}

/** Bounded, sanitized identity for the ledger row; an absent field is `null`, never "". */
function normalizeConsumer(consumer) {
  const c = consumer && typeof consumer === "object" ? consumer : {};
  const pick = (v) => (typeof v === "string" && v ? safeField(v, null, CONSUMER_FIELD_MAX) : null);
  return {
    session_id: pick(c.session_id),
    agent_id: pick(c.agent_id),
    agent_type: pick(c.agent_type),
    tool_use_id: pick(c.tool_use_id),
  };
}

// ── THE RECEIPT ──────────────────────────────────────────────────────────────

/**
 * Parse and validate receipt TEXT. The detail strings name WHICH rule failed and never
 * quote the receipt's content (§ emitRefusalLine).
 *
 * @returns {{ok:true, receipt:{digest:string, reason:string, writtenAt:string, writtenAtMs:number}}
 *          | {ok:false, detail:string}}
 */
function parseReceipt(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, detail: "it is empty" };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return {
      ok: false,
      detail:
        "it is not JSON — the plain-text one-line receipt is RETIRED; receipts are the " +
        "call-bound JSON line the block prints",
    };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, detail: "it is not a JSON object" };
  }
  const keys = Object.keys(obj);
  if (keys.some((k) => !RECEIPT_FIELDS.includes(k))) {
    return {
      ok: false,
      detail: `it carries a field other than ${RECEIPT_FIELDS.join(", ")}`,
    };
  }
  const missing = RECEIPT_FIELDS.filter((k) => typeof obj[k] !== "string");
  if (missing.length) {
    return { ok: false, detail: `missing or non-string field(s): ${missing.join(", ")}` };
  }
  if (!DIGEST_RE.test(obj.digest)) {
    return { ok: false, detail: "digest is not 64 lowercase hex characters" };
  }
  const reason = obj.reason.trim();
  if (!reason) {
    return { ok: false, detail: "reason is empty — the reason is the price of the override" };
  }
  if (reason.includes(REASON_PLACEHOLDER)) {
    return { ok: false, detail: "reason is still the template placeholder" };
  }
  const writtenAtMs = WRITTEN_AT_RE.test(obj.written_at) ? Date.parse(obj.written_at) : NaN;
  if (!Number.isFinite(writtenAtMs)) {
    return {
      ok: false,
      detail: "written_at is not an ISO-8601 timestamp with a zone (e.g. 2026-10-10T12:34:56Z)",
    };
  }
  return {
    ok: true,
    receipt: { digest: obj.digest, reason, writtenAt: obj.written_at, writtenAtMs },
  };
}

/** The exact line a blocked caller writes, with `written_at` pre-set to `nowMs`. */
function formatReceiptTemplate(digest, nowMs) {
  const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  return JSON.stringify({ digest, reason: REASON_PLACEHOLDER, written_at: at });
}

// ── THE USE LEDGER ───────────────────────────────────────────────────────────

/**
 * The MAIN checkout of the tree a receipt was found in, or a refusal. Only the honour path
 * pays for it: one git probe, asked through the canonical argv, so it shares its answer
 * with every other asker in the same hook event. Fails CLOSED — `[]` from the helper (git
 * could not identify a main checkout, or the resolver is unavailable) is an UNRESOLVED
 * ledger, never a fallback to the invoking tree.
 */
function resolveLedgerRoots(root) {
  let roots = [];
  try {
    roots = mainCheckoutBoundaryRoots(root);
  } catch {
    roots = [];
  }
  return Array.isArray(roots) && typeof roots[0] === "string" && roots[0] ? roots : null;
}

/**
 * Bounded caller-supplied facts for a ledger row: at most 8 keys, string values only, each clipped.
 * Shared by the receipt row (optional `detail`) and the inline row, so both carry one shape.
 */
function normalizeDetail(detail) {
  const out = {};
  if (detail && typeof detail === "object") {
    for (const [k, v] of Object.entries(detail).slice(0, 8)) {
      if (typeof v === "string") out[safeField(k, "key")] = safeField(v, "?");
    }
  }
  return out;
}

/**
 * Append one use row. Never throws; returns the typed sink result. `detail` is written ONLY when the
 * consumer supplied one (the effort-routing arm records the effort the lifted call requested), so
 * every other consumer's row keeps its exact key set.
 */
function appendUseRow(invokingRoot, ledgerRoots, receiptRel, label, receipt, digest, consumer, detail) {
  const row = {
    v: 1,
    at: new Date().toISOString(),
    channel: receiptRel.split(path.sep).join("/"),
    digest,
    reason_sha256: sha256Hex(receipt.reason),
    written_at: receipt.writtenAt,
    found_under: label,
    consumer: normalizeConsumer(consumer),
  };
  if (detail && typeof detail === "object") row.detail = normalizeDetail(detail);
  try {
    const r = appendSinkLine({
      repoDir: invokingRoot,
      additionalRoots: ledgerRoots,
      sinkPath: path.join(ledgerRoots[0], USE_LEDGER_REL),
      line: JSON.stringify(row),
    });
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "append failed" };
  } catch {
    return { ok: false, error: "append threw" };
  }
}

/**
 * Restore an unrecorded claim by linking its original inode to the vacant public path,
 * then unlinking the private name. An occupied public path retains both receipts without
 * overwrite. Source: .claude/hooks/lib/override-receipt.js:656-667.
 */
function restoreReceipt(claim) {
  try {
    fs.linkSync(claim.abs, claim.original);
  } catch (error) {
    return { restored: false, retained: true, error: error.code || error.name };
  }
  try { fs.unlinkSync(claim.abs); }
  catch (error) { return { restored: true, retained: true, error: error.code || error.name }; }
  try { fs.rmdirSync(claim.dir); }
  catch (error) { return { restored: true, retained: false, error: error.code || error.name }; }
  return { restored: true, retained: false };
}

function claimReceipt(c) {
  const root = fs.realpathSync(c.root), parent = fs.realpathSync(path.dirname(c.abs));
  const rel = path.relative(root, parent);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error("receipt parent outside root");
  }
  const dir = fs.mkdtempSync(path.join(parent, ".override-claim-"));
  const claim = { dir, abs: path.join(dir, "receipt"), original: path.join(parent, path.basename(c.abs)), relative: path.relative(root, path.join(dir, "receipt")) };
  try {
    fs.chmodSync(dir, 0o700);
    fs.renameSync(c.abs, claim.abs);
    return claim;
  } catch (error) {
    try { fs.rmdirSync(dir); } catch (cleanup) { error.claimCleanup = cleanup.code || cleanup.name; }
    throw error;
  }
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
   * Every refusal this gate made, keyed (code, candidate) so it is written to stderr ONCE
   * per gate however many times a guard peeks before it consumes, and kept as the
   * agent-visible note `formatOverrideInstruction` / `formatOverrideLine` append.
   */
  const refusals = new Map();
  const peekSelections = new Map();
  function refuse(c, code, what, remedy, leftInPlace = true) {
    const key = `${code}\u0000${c.abs}`;
    if (refusals.has(key)) return;
    const line = refusalText(code, c.label, RECEIPT_REL, what, remedy, leftInPlace);
    refusals.set(key, line);
    emitRefusalLine(line);
  }

  /**
   * Candidate receipt RECORDS, in precedence order: the invoking tree first (where an
   * agent writes while working, possibly a linked worktree), then each extra root (where
   * an operator drops one). Resolving only one of the two is what makes an override
   * unreachable for the other party.
   *
   * Each record carries its ROOT (the containment boundary the shared reader needs) and a
   * fixed LABEL (the disclosure-safe way to say WHICH tree a refusal happened in — see
   * `emitRefusalLine`). `receiptCandidates()` below projects these to absolute paths so the
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
   * NOT call-bound and NOT ledgered: it is operator-scoped and applies to the whole run.
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
   * Validity for `c` and `digest`: returns parsed receipt plus original-byte SHA, or null.
   * Refusals are reported here; rollback links the claimed inode rather than this text.
   * Source: .claude/hooks/lib/override-receipt.js:355-425,656-667,808-855.
   */
  function validateCandidate(c, digest, nowMs) {
    const got = readReceiptGuarded(c.abs, c.root, c.label, RECEIPT_REL, (what, remedy) =>
      refuse(c, REFUSAL.UNREADABLE, what, remedy),
    );
    if (got.state !== "read") return null;
    const parsed = parseReceipt(got.text);
    if (!parsed.ok) {
      refuse(
        c,
        REFUSAL.MALFORMED,
        `is not a valid receipt (${parsed.detail})`,
        "Rewrite it as the one-line JSON receipt this block prints, then retry.",
      );
      return null;
    }
    const r = parsed.receipt;
    if (r.digest !== digest) {
      refuse(
        c,
        REFUSAL.DIGEST_MISMATCH,
        `was written for a DIFFERENT call (receipt digest ${r.digest.slice(0, 12)}…, this call ${digest.slice(0, 12)}…)`,
        "It can lift only the call it was written for. If THIS is the call you meant, " +
          "rewrite it with this call's digest; otherwise delete it once it is no longer needed.",
      );
      return null;
    }
    if (r.writtenAtMs > nowMs + RECEIPT_FUTURE_SKEW_MS) {
      refuse(
        c,
        REFUSAL.FUTURE_DATED,
        "carries a written_at in the FUTURE",
        "Set written_at to the current UTC time (date -u +%Y-%m-%dT%H:%M:%SZ), then retry.",
      );
      return null;
    }
    if (nowMs - r.writtenAtMs > RECEIPT_TTL_MS) {
      const ageMin = Math.floor((nowMs - r.writtenAtMs) / 60000);
      refuse(
        c,
        REFUSAL.STALE,
        `is STALE — written ${ageMin} minute(s) ago, past the ${TTL_MINUTES}-minute bound`,
        "If the override is still wanted for this call, set written_at to the current UTC " +
          "time and retry; otherwise delete it.",
      );
      return null;
    }
    return { receipt: r, sha256: got.sha256 };
  }

  /**
   * NON-DESTRUCTIVE: the receipt that would lift the call `digest` right now, or null. For
   * a guard that must decide whether an override is ATTEMPTED before it decides whether to
   * refuse it (`wip-discipline-guard.js`'s debt and price gates), without spending it.
   * A peek pins candidate path and SHA of original fd-read bytes; consume validates the
   * privately claimed file and refuses substitution or changed bytes. Source:
   * .claude/hooks/lib/override-receipt.js:355-397,867-1005.
   *
   * @returns {{reason:string, writtenAt:string, label:string, path:string}|null}
   */
  function peekReceipt(digest) {
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return null;
    const nowMs = Date.now();
    for (const c of receiptCandidateRecords()) {
      if (peekSelections.has(digest) && (!peekSelections.get(digest) || peekSelections.get(digest).path !== c.abs)) continue;
      const v = validateCandidate(c, digest, nowMs);
      if (v) {
        peekSelections.set(digest, { path: c.abs, sha256: v.sha256 });
        return { reason: v.receipt.reason, writtenAt: v.receipt.writtenAt, label: c.label, path: c.abs };
      }
    }
    peekSelections.set(digest, null);
    return null;
  }

  /**
   * Channel 1 — the agent-reachable ONE-SHOT receipt, bound to ONE call.
   *
   * Returns the override after claiming, validating and recording a receipt for this
   * digest within its TTL. Invalid claims restore without overwrite or remain in private
   * custody loudly. Source: .claude/hooks/lib/override-receipt.js:916-1005.
   *
   * @param {string} digest       the call digest (`callDigestOf`). Anything that is not a
   *                              64-hex digest honours NO receipt — a consumer that forgot
   *                              to bind fails safe, and says so when a receipt is present.
   * @param {object} [ctx]
   * @param {object} [ctx.consumer] identity for the ledger row (`consumerOf(payload)`).
   * @param {object} [ctx.detail]   bounded facts for the ledger row (string values only).
   */
  function consumeReceipt(digest, ctx) {
    const consumer = ctx && typeof ctx === "object" ? ctx.consumer : undefined;
    const detail = ctx && typeof ctx === "object" ? ctx.detail : undefined;
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      for (const c of receiptCandidateRecords()) {
        const got = readReceiptGuarded(c.abs, c.root, c.label, RECEIPT_REL, (what, remedy) =>
          refuse(c, REFUSAL.UNREADABLE, what, remedy),
        );
        if (got.state === "read") {
          refuse(
            c,
            REFUSAL.NO_CALL_DIGEST,
            "cannot be matched to this call — no call digest was computed for it",
            `Only the operator/CI channel (${ENV_VAR}=1) can lift this call.`,
          );
        }
      }
      return null;
    }
    const nowMs = Date.now();
    for (const c of receiptCandidateRecords()) {
      const selected = peekSelections.get(digest);
      if (peekSelections.has(digest) && (!selected || selected.path !== c.abs)) continue;
      if (!validateCandidate(c, digest, nowMs)) continue;

      // RESOLVED BEFORE THE CLAIM: an unresolvable ledger refuses without touching the file.
      const ledgerRoots = resolveLedgerRoots(c.root);
      if (!ledgerRoots) {
        refuse(
          c,
          REFUSAL.LEDGER_UNRESOLVED,
          "could not be RECORDED — git did not identify the main checkout that holds the use ledger",
          `An unrecorded override is not honoured. Retry from inside the repository, or use ${ENV_VAR}=1.`,
        );
        continue;
      }

      let claim;
      try {
        claim = claimReceipt(c);
      } catch (e) {
        refuse(
          c,
          REFUSAL.UNDELETABLE,
          `could NOT be exclusively claimed (${(e && e.code) || (e && e.name) || "unknown"})` +
            (e.claimCleanup ? `; empty claim directory cleanup failed (${e.claimCleanup})` : ""),
          "Fix the receipt directory permissions or competing writer, then retry.",
        );
        continue;
      }

      const undo = () => {
        const restored = restoreReceipt(claim);
        if (restored.retained || restored.error) {
          const rel = claim.relative;
          refuse(c, REFUSAL.CLAIM_RETAINED,
            `rollback ${restored.restored ? "restored the public receipt" : "could NOT restore the public receipt"}; ` +
              `${restored.retained ? "original bytes retained" : "empty claim directory retained"} at ${rel} (${restored.error || "unknown"})`,
            "Preserve the newer public receipt and reconcile the retained claim before retrying.", restored.restored);
        }
        return restored;
      };
      const v = validateCandidate({ ...c, abs: claim.abs }, digest, nowMs);
      if (!v) { undo(); continue; }
      if (selected && selected.sha256 !== v.sha256) {
        refuse(c, REFUSAL.CONTENT_CHANGED, "changed bytes after the priced peek",
          "Re-evaluate the receipt reason and price before retrying; this call did not honour it.");
        undo();
        continue;
      }

      const rec = appendUseRow(c.root, ledgerRoots, RECEIPT_REL, c.label, v.receipt, digest, consumer, detail);
      if (!rec.ok) {
        const restored = undo();
        refuse(
          c,
          REFUSAL.LEDGER_WRITE_FAILED,
          `could not be RECORDED in ${USE_LEDGER_REL} under the main checkout (${safeField(rec.error, "unknown", 40)})` +
            (restored.restored ? "" : " and could NOT be put back; its original bytes remain in the private claim"),
          restored.restored
            ? `An unrecorded override is not honoured. Retry once the ledger can be written (a live landing window freezes it until the window closes), or use ${ENV_VAR}=1.`
            : `An unrecorded override is not honoured. Reconcile the retained claim without overwriting the newer public receipt, or use ${ENV_VAR}=1.`,
          restored.restored,
        );
        continue;
      }

      try {
        fs.unlinkSync(claim.abs);
        fs.rmdirSync(claim.dir);
      } catch (error) {
        refuse(c, REFUSAL.CLAIM_CLEANUP_FAILED,
          "was RECORDED but private claim cleanup failed; it is not re-armed",
          `Retained claim location: ${claim.relative} (${error.code || error.name}).`, false);
      }
      return {
        source: "receipt",
        channel: `one-shot receipt ${RECEIPT_REL}`,
        reason: v.receipt.reason,
        detail:
          `Receipt CONSUMED (claimed and recorded); it will not lift the next call. Bound to this call ` +
          `(digest ${digest.slice(0, 12)}…); the use is recorded in ${USE_LEDGER_REL} under the main checkout.`,
        consumedPath: c.abs,
        digest,
        writtenAt: v.receipt.writtenAt,
        ledger: USE_LEDGER_REL,
      };
    }
    return null;
  }

  /**
   * Resolve any armed override for ONE call: `resolveOverride({ digest, env, consumer, detail })`.
   * `detail` (optional) is recorded on the receipt-use row; the env channel records nothing.
   * ENV IS CHECKED FIRST, deliberately: an env-armed run must NOT eat a receipt an agent
   * wrote for a later call. Ordering the other way would make a CI run silently spend the
   * agent's one shot.
   *
   * The pre-binding form `resolveOverride(envObject)` (and `resolveOverride()`) still
   * resolves the ENV channel exactly as before — but carries no digest, so it honours NO
   * receipt. A consumer left on the old form fails SAFE: its block stands.
   */
  function resolveOverride(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const bound = ["digest", "env", "consumer"].some((k) =>
      Object.prototype.hasOwnProperty.call(o, k),
    );
    const env = bound ? o.env : opts;
    return (
      envOverride(env) ||
      consumeReceipt(bound ? o.digest : undefined, {
        consumer: bound ? o.consumer : undefined,
        detail: bound ? o.detail : undefined,
      })
    );
  }

  /** The named refusals this gate made, as agent-visible lines. */
  function refusalLines() {
    return [...refusals.values()];
  }

  function refusalSuffix() {
    const lines = refusalLines();
    return lines.length ? ` RECEIPT(S) NOT HONOURED ON THIS CALL: ${lines.join(" | ")}` : "";
  }

  /**
   * The one-line RECORD. This is the sentence that makes the override audited rather than
   * free: it names the channel, states the one-shot consumption and the binding, and
   * QUOTES the stated reason (sanitized). Consumers embed it in whatever advisory shape
   * they emit.
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
    return parts.join(" ") + refusalSuffix();
  }

  /**
   * The "how to override" sentence, for embedding in a BLOCK body. A block whose escape is
   * not stated in the block itself is an unreachable escape — so it carries the EXACT line
   * to write, bound to `digest`, and every refusal this gate made on this call.
   */
  function formatOverrideInstruction(digest) {
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      return (
        `OVERRIDE — the one-shot receipt channel cannot be offered for this call: no call ` +
        `digest could be computed, so no receipt could be bound to it. Operator/CI channel: ` +
        `${ENV_VAR}=1.` + refusalSuffix()
      );
    }
    return (
      `OVERRIDE (if this is genuinely correct as issued) — write the ONE line below to ` +
      `${RECEIPT_REL}, replacing ${REASON_PLACEHOLDER} with your reason, and re-issue this ` +
      `exact call. The receipt is BOUND to this call (digest ${digest}, over the tool, the ` +
      `subagent type, the prompt or command, and the blocking finding ids), so it lifts no ` +
      `other call. It EXPIRES ${TTL_MINUTES} minutes after its written_at — the value below ` +
      `is this block's time; set it to the current UTC time if more time passes. It is ` +
      `CONSUMED on use (one-shot), the use is recorded in ${USE_LEDGER_REL} under the main ` +
      `checkout, and your stated reason is echoed back into the transcript, so the override ` +
      `is recorded rather than free. A receipt for another call, a stale one, or one with an ` +
      `empty reason is NOT honoured and is left in place. Operator/CI channel: ${ENV_VAR}=1.\n` +
      `      ${formatReceiptTemplate(digest)}` +
      refusalSuffix()
    );
  }

  return {
    RECEIPT_REL,
    ENV_VAR,
    receiptCandidates,
    receiptCandidateRecords,
    envOverride,
    peekReceipt,
    consumeReceipt,
    resolveOverride,
    refusalLines,
    formatOverrideLine,
    formatOverrideInstruction,
  };
}

/**
 * NON-DESTRUCTIVE hardened read of a receipt at `<root>/<receiptRel>`, returning its
 * trimmed TEXT or `null`.
 *
 * A RAW READ PRIMITIVE, NOT AN HONOUR DECISION. It applies the hardened read and nothing
 * else — no parse, no digest match, no TTL. Deciding whether an override is present or
 * permitted from this text would bypass the call binding entirely; a guard asks
 * `gate.peekReceipt(digest)` for that, which holds every candidate to `consumeReceipt`'s
 * own validity test.
 *
 * Refusals are LOUD here exactly as they are on the consume path, so a read can never
 * report "no receipt" about a path something occupies without saying so.
 *
 * @param {string} root        containment root (the tree the receipt is relative to)
 * @param {string} receiptRel  repo-relative receipt path
 * @param {string} [rootLabel] disclosure-safe label for stderr; defaults to a generic one
 * @returns {string|null} the trimmed non-empty text, or null (absent / refused / empty)
 */
function readReceiptText(root, receiptRel, rootLabel) {
  const got = readReceiptState(root, receiptRel, rootLabel);
  return got.state === "read" ? got.text || null : null;
}

/**
 * The same read, returning the DISCRIMINATION rather than collapsing it.
 *
 * `readReceiptText` folds `absent` and `refused` into one `null`. This exports the
 * distinction for a caller that must REPORT which happened. Two surfaces disagreeing on
 * one event — a loud stderr refusal beside a typed reason saying "absent" — is how a real
 * refusal gets read as a benign no-receipt six weeks later.
 *
 * The three states are exhaustive and mutually exclusive:
 *   - `read`    — a regular, contained, in-bounds file yielded text (possibly empty).
 *   - `absent`  — nothing occupies the path: its presence check returned ENOENT.
 *   - `refused` — EITHER something occupies it that this module will not read (symlinked or
 *                 otherwise escaping the root, dangling, a directory, a FIFO or device,
 *                 hard-linked, or over `RECEIPT_MAX_BYTES`), OR its presence could NOT be
 *                 decided — a parent directory that is unsearchable (EACCES), not a directory
 *                 (ENOTDIR) or a symlink loop (ELOOP). The second kind is NOT "absent": an
 *                 undecidable check is not evidence that no receipt is there. Already surfaced
 *                 on stderr by the time this returns, with a remedy naming the parent
 *                 directory for the second kind, so a caller MUST NOT re-emit the path.
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

/**
 * Record an INLINE override — one declared in the call itself rather than by a receipt file — in
 * the SAME use ledger, so every override of every guard is greppable in one place. First consumer:
 * the effort-routing arm of `dispatch-contract-guard.js`, whose override is the brief's
 * `EFFORT-OVERRIDE: <level> — <reason>` line (`effort-routing.js`).
 *
 * The row keeps the receipt row's shape and its privacy rule: the REASON is stored as a HASH,
 * never in clear (the transcript already carries it). `written_at` is null and `found_under` is
 * `"inline"` because no receipt was written or found; `detail` carries the bounded, caller-supplied
 * facts of the override (string values only, each clipped). The ledger root is resolved by the same
 * fail-closed derivation the receipt path uses (`resolveLedgerRoots`), so an unconfirmable main
 * checkout is `{ok:false}` — and the caller MUST then refuse the override: honoured ⇔ recorded,
 * exactly as for a receipt. NEVER throws.
 *
 * @param {{invokingRoot:string, channel:string, digest:string|null, reason:string,
 *          consumer?:object, detail?:Object<string,string>}} a
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function recordInlineOverride(a) {
  try {
    const x = a && typeof a === "object" ? a : {};
    if (typeof x.invokingRoot !== "string" || !x.invokingRoot) return { ok: false, error: "no invoking root" };
    if (typeof x.channel !== "string" || !x.channel) return { ok: false, error: "no channel" };
    if (typeof x.reason !== "string" || !x.reason.trim()) return { ok: false, error: "no reason" };
    const ledgerRoots = resolveLedgerRoots(x.invokingRoot);
    if (!ledgerRoots) return { ok: false, error: "the main checkout could not be resolved" };
    const detail = normalizeDetail(x.detail);
    const row = {
      v: 1,
      at: new Date().toISOString(),
      channel: safeField(x.channel, "inline"),
      digest: typeof x.digest === "string" && DIGEST_RE.test(x.digest) ? x.digest : null,
      reason_sha256: sha256Hex(x.reason.trim()),
      written_at: null,
      found_under: "inline",
      consumer: normalizeConsumer(x.consumer),
      detail,
    };
    const r = appendSinkLine({
      repoDir: x.invokingRoot,
      additionalRoots: ledgerRoots,
      sinkPath: path.join(ledgerRoots[0], USE_LEDGER_REL),
      line: JSON.stringify(row),
    });
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || "append failed" };
  } catch {
    return { ok: false, error: "record threw" };
  }
}

module.exports = {
  FIELD_MAX,
  RECEIPT_MAX_BYTES,
  CALL_DIGEST_DOMAIN,
  RECEIPT_TTL_MS,
  RECEIPT_FUTURE_SKEW_MS,
  RECEIPT_FIELDS,
  REASON_PLACEHOLDER,
  USE_LEDGER_REL,
  REFUSAL,
  safeField,
  computeCallDigest,
  callPromptOf,
  callDigestOf,
  consumerOf,
  parseReceipt,
  formatReceiptTemplate,
  createOverrideGate,
  recordInlineOverride,
  readReceiptText,
  readReceiptState,
};
