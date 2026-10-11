#!/usr/bin/env node
/**
 * codex-foundation-adapter — the Codex-side boundary between the NATIVE hook
 * runtime and the guard foundation. TWO seams, deliberately separate:
 *
 *   1. PATCH DERIVATION (L1 facts). `parsePatch` / `derivePatchEffects` read a
 *      native `apply_patch` body and report WHAT the patch would do: the
 *      ordered per-operation effects (every operation, including a `Move to`
 *      destination), the readset whose current bytes the derivation consumed,
 *      and the declared residuals that travel with those facts. This is the
 *      provider `guard-foundation/tool-effects.js` names when it says patch
 *      destinations are "not parsed in the L1 skeleton" — that sentence is
 *      true of that module and false of this one.
 *
 *   2. THE EVALUATION SEAM (L1 facts + the legacy chain → ONE decision).
 *      `evaluateFoundation` runs the established native-policy evaluation
 *      through an INJECTED `evaluate` (no eager import of the runtime — the
 *      runtime imports THIS module, and an eager `require("./codex-hook-runtime")`
 *      here would close the cycle at load), derives a foundation decision
 *      record from the legacy result plus the caller-supplied facts, and
 *      returns both. `serializeDecision` restores the caller's shape
 *      (`{stdout, stderr, exitCode}`) so every call site keeps its established
 *      per-event behaviour byte-for-byte.
 *
 * THE HONEST STATE OF THE WORLD (do not over-read this module):
 *
 *   - The real evaluator is NOT decoupled. `evaluateFoundation` takes the
 *     evaluation as an injected function precisely so this module does not
 *     import it, but the function the runtime injects still routes through
 *     `codex-native-policy.js::evaluateNative` and the MCP-guard server helper
 *     (`codex-mcp-guard/server.js`) — the coupling MOVED to the injection
 *     point; it was not removed.
 *   - The legacy chain emits no rule identity on a normal result. When no
 *     facts (ruleId + provenance) are supplied, a PERMISSIVE legacy result
 *     yields decision kind "unknown" — NEVER "allow". An exit-0 result is not
 *     evidence that a policy determined this call is safe, and inferring an
 *     allow from it is the one inference this seam refuses. (A RESTRICTIVE
 *     legacy result is a refusal that HAPPENED — that is a fact, not an
 *     inference, so it reads "deny" even when its rule cannot be named.)
 *   - `authority.vendorAgreement` stays "UNKNOWN" unless the caller supplies a
 *     tool-parser fact to compare against. Today's in-tree projection of patch
 *     headers (`codex-native-policy.js::projectPayloads`, marker-regex based)
 *     is an IMITATION of the tool's grammar, not the grammar: it scans lines
 *     for `*** <Kind> File: ` and tolerates a missing envelope, while the
 *     admitted grammar here requires the `*** Begin Patch` / `*** End Patch`
 *     envelope and refuses any unprefixed body line. Where the two disagree,
 *     neither is the tool; the comparison hook exists so a real parser fact
 *     can settle it, and until one is available the disagreement is a
 *     declared residual, never a silent assumption.
 *   - Host-side behaviour facts (what the Codex app-server does with the
 *     patch once admitted, and its own hook timeout semantics on this host)
 *     are UNMEASURED here.
 *   - `resolveTarget` in the runtime is untouched by this module. It
 *     canonicalizes aliases and targets for HOOK RESOLUTION and grants no
 *     external edit authority and no TOCTOU immunity; that residual stays.
 *
 * MISSION-RELEVANT BOUNDARY: this module performs NO policy. It reports
 * facts and derives a decision RECORD; deny/allow semantics live in the L3
 * chain (deny > undetermined-on-protected > halt > advisory > allow) that
 * consumes it. The protected-set and alias-registry questions are INPUTS to
 * that chain (facts supplied by the caller), never answers computed here.
 *
 * Style: CommonJS, node:fs/node:path/crypto only, lazy requires across the
 * runtime boundary — matches `.claude/hooks/lib/*`.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** The admit authority of the ONE grammar this module implements. `version`
 *  is the grammar revision, not a package version; `vendorAgreement` is
 *  "UNKNOWN" until a tool-parser fact is actually compared (see the header). */
const AUTHORITY = Object.freeze({
  name: "loom-admitted-apply-patch",
  version: 1,
  vendorAgreement: "UNKNOWN",
});

const PATCH_ENVELOPE_BEGIN = "*** Begin Patch";
const PATCH_ENVELOPE_END = "*** End Patch";

/**
 * ADMITTED-DERIVATION INVARIANTS — each value IS the property its name
 * states, the derivation code READS it, and `REACH` below derives a token
 * from it. That triple is load-bearing for the mutation corpus: a single
 * literal splice of one value flips BOTH the behaviour and the token the
 * LOADED module reports, which is what makes a corpus red a proof that the
 * mutated module ran rather than a disk read (`case.schema.json`
 * § reachedProof; `.claude/test-harness/foundation-corpus/fixtures/demo-subject`
 * is the reference implementation of the same pattern).
 *
 * No value here is configuration: the admitted derivation ASSERTS these
 * properties, and a deployment that wants the other value wants a different
 * guard, not a flag.
 */
const INVARIANTS = Object.freeze({
  // ONE admitted grammar, enforced strictly: a body line with no
  // " "/"-"/"+" prefix is REFUSED. When this is not "strict" the line is
  // admitted as context — the lenient reading — which is a DIFFERENT parse,
  // never a silently-equal one
  grammarStrictness: "strict",
  // every operation of the patch derives effects — not just the first
  operationCoverage: "every",
  // a `Move to` destination IS an effect endpoint; a move that drops its
  // destination would report bytes landing nowhere
  moveDestination: "derive",
  // targets are canonicalized through the filesystem (realpath), never by
  // lexical string comparison alone
  canonicalization: "realpath",
  // the FINAL sink of a target must be examined: an existing non-regular
  // sink (directory, device, …) is a refusal, a symlink sink is resolved and
  // reported, never silently followed or silently refused
  finalSink: "enforce",
  // serializeDecision with no legacy result REFUSES; it never emits a bare
  // pass for a decision it cannot restore
  decisionFallback: "refuse",
});

/** REACH — one token per invariant, derived from the values above and
 *  exported so a corpus run can prove WHICH module it loaded. Consumed by
 *  `cases-codex/bin/foundation-cli.mjs`; never consulted by the derivation
 *  itself. */
const REACH = Object.freeze({
  grammarStrictness: INVARIANTS.grammarStrictness === "strict"
    ? "CFA_REACH_patch-grammar-strict:enforcing" : "CFA_REACH_patch-grammar-strict:removed",
  operationCoverage: INVARIANTS.operationCoverage === "every"
    ? "CFA_REACH_patch-second-operation:enforcing" : "CFA_REACH_patch-second-operation:removed",
  moveDestination: INVARIANTS.moveDestination === "derive"
    ? "CFA_REACH_patch-move-destination:enforcing" : "CFA_REACH_patch-move-destination:removed",
  canonicalization: INVARIANTS.canonicalization === "realpath"
    ? "CFA_REACH_patch-canonical-target:enforcing" : "CFA_REACH_patch-canonical-target:removed",
  finalSink: INVARIANTS.finalSink === "enforce"
    ? "CFA_REACH_patch-final-sink:enforcing" : "CFA_REACH_patch-final-sink:removed",
  decisionFallback: INVARIANTS.decisionFallback === "refuse"
    ? "CFA_REACH_decision-fallback:enforcing" : "CFA_REACH_decision-fallback:removed",
});

/**
 * PatchEffectsError — the ONE failure shape of the patch derivation. Thrown,
 * never returned: a derivation that could not establish the whole effect set
 * has NO partial "complete" to hand anyone (`complete: true` on a success is
 * the only other outcome). `code` is the greppable class; `reason` names the
 * operation and the raw text involved so a refusal is auditable.
 */
class PatchEffectsError extends Error {
  constructor(code, reason) {
    if (typeof code !== "string" || code.length === 0) throw new TypeError("PatchEffectsError requires a code");
    if (typeof reason !== "string" || reason.length === 0) throw new TypeError("PatchEffectsError requires a reason");
    super(`${code}: ${reason}`);
    this.name = "PatchEffectsError";
    this.code = code;
    this.reason = reason;
  }
}

const fail = (code, reason) => {
  throw new PatchEffectsError(code, reason);
};

// ---------------------------------------------------------------------------
// 1. parsePatch — ONE admitted grammar, text only
// ---------------------------------------------------------------------------

const DIRECTIVE_ADD = /^\*\*\* Add File: (.+)$/;
const DIRECTIVE_UPDATE = /^\*\*\* Update File: (.+)$/;
const DIRECTIVE_DELETE = /^\*\*\* Delete File: (.+)$/;
const DIRECTIVE_MOVE = /^\*\*\* Move to: (.+)$/;
const HUNK_ANCHOR = /^@@(?: (.*))?$/;

/**
 * parsePatch(text) → `{authority, operations}`.
 *
 * The admitted grammar, in full:
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +<content line>            (one or more; an EMPTY Add is refused —
 *                               whether the tool accepts one is an
 *                               unresolved vendor question, and a
 *                               derivation must not guess)
 *   *** Update File: <path>
 *   *** Move to: <path>        (optional, only immediately after the Update
 *                               header, at most once; a move with no hunk
 *                               lines is a pure rename)
 *   @@ <optional anchor>       (starts a hunk; hunk lines may also start
 *                               immediately after the header)
 *    <context line>            (one leading space)
 *   -<removed line>
 *   +<added line>
 *   *** Delete File: <path>    (no body lines)
 *   *** End Patch
 *
 * EVERY content line carries a prefix; a body line with no prefix, a
 * directive in an unlawful position, a missing envelope, an empty
 * path, or a body line after a Delete section is a refusal of the ONE
 * admitted grammar (`patch-grammar-unsupported`), not an invitation to
 * guess what the tool would have done. A path addressed twice (including a
 * `Move to` colliding with any other section) is `patch-alias-uncertain`:
 * the tool's own duplicate handling is not measured here, so which write
 * wins is UNKNOWN, and a derivation with an unknown winner is not one.
 */
function parsePatch(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    fail("patch-input-malformed", "patch text is absent or empty");
  }
  const raw = text.split(/\r?\n/);
  // A single trailing newline is the ordinary serialisation, not a body line.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  if (raw.length === 0 || raw[0] !== PATCH_ENVELOPE_BEGIN) {
    fail("patch-envelope-invalid", `patch does not open with "${PATCH_ENVELOPE_BEGIN}"`);
  }
  if (raw[raw.length - 1] !== PATCH_ENVELOPE_END) {
    fail("patch-envelope-invalid", `patch does not close with "${PATCH_ENVELOPE_END}"`);
  }

  const operations = [];
  const pathsSeen = new Map(); // path -> where it was seen, for duplicate refusal
  const claim = (p, what) => {
    if (pathsSeen.has(p)) {
      fail("patch-alias-uncertain", `path "${p}" is addressed more than once (${pathsSeen.get(p)} and ${what}); the tool's duplicate handling is not admitted, so which write wins is unknown`);
    }
    pathsSeen.set(p, what);
  };

  let current = null; // the operation being built
  let currentHunk = null;
  const closeCurrent = () => {
    if (!current) return;
    if (current.kind === "add" && current.content.length === 0) {
      fail("patch-grammar-unsupported", `Add File "${current.path}" carries no content lines; whether the tool accepts an empty add is unresolved, and the derivation will not guess`);
    }
    if (current.kind === "delete" && (current.hunks.length || current.moveTo !== null)) {
      fail("patch-grammar-unsupported", `Delete File "${current.path}" carries body lines or a Move to; the admitted grammar gives a delete no body`);
    }
    operations.push(current);
    current = null;
    currentHunk = null;
  };

  for (let i = 1; i < raw.length - 1; i++) {
    const line = raw[i];
    const add = line.match(DIRECTIVE_ADD);
    const update = line.match(DIRECTIVE_UPDATE);
    const del = line.match(DIRECTIVE_DELETE);
    if (add || update || del) {
      closeCurrent();
      const kind = add ? "add" : update ? "update" : "delete";
      const target = (add || update || del)[1].trim();
      if (target.length === 0) {
        fail("patch-grammar-unsupported", `empty path in "${line.trim()}"`);
      }
      if (target.includes("\0")) fail("patch-path-invalid", `path "${target}" contains a NUL byte`);
      claim(target, `${kind} ${target}`);
      current = { kind, path: target, moveTo: null, hunks: [], content: [] };
      currentHunk = null;
      continue;
    }
    if (!current) {
      fail("patch-grammar-unsupported", `directive before any file section: "${line}"`);
    }
    const move = line.match(DIRECTIVE_MOVE);
    if (move) {
      const destination = move[1].trim();
      if (current.kind !== "update" || current.moveTo !== null || current.hunks.length || current.content.length > 0) {
        fail("patch-grammar-unsupported", `Move to in an unlawful position (only once, immediately after an Update File header): "${line}"`);
      }
      if (destination.length === 0 || destination.includes("\0")) {
        fail("patch-grammar-unsupported", `empty or invalid move destination in "${line}"`);
      }
      claim(destination, `move destination ${destination}`);
      current.moveTo = destination;
      continue;
    }
    if (current.kind === "delete") {
      fail("patch-grammar-unsupported", `Delete File "${current.path}" carries a body line: "${line}"`);
    }
    if (current.kind === "add") {
      if (!line.startsWith("+")) {
        fail("patch-grammar-unsupported", `Add File "${current.path}" body line has no "+" prefix: "${line}"`);
      }
      current.content.push(line.slice(1));
      continue;
    }
    // update body
    const anchor = line.match(HUNK_ANCHOR);
    if (anchor) {
      currentHunk = { anchor: anchor[1] === undefined ? null : anchor[1], oldLines: [], newLines: [] };
      current.hunks.push(currentHunk);
      continue;
    }
    const prefixed = [" ", "-", "+"].includes(line[0]);
    if (INVARIANTS.grammarStrictness === "strict" && !prefixed) {
      fail("patch-grammar-unsupported", `Update File "${current.path}" body line has no " "/"-"/"+" prefix: "${line}"`);
    }
    if (!currentHunk) {
      currentHunk = { anchor: null, oldLines: [], newLines: [] };
      current.hunks.push(currentHunk);
    }
    // The lenient reading (grammarStrictness mutated away from "strict")
    // admits an unprefixed line as a CONTEXT line — a different parse with a
    // different result, never a silently-equal one.
    const marker = prefixed ? line[0] : " ";
    const body = prefixed ? line.slice(1) : line;
    if (marker === " " || marker === "-") currentHunk.oldLines.push(body);
    if (marker === " " || marker === "+") currentHunk.newLines.push(body);
  }
  closeCurrent();

  if (operations.length === 0) {
    fail("patch-grammar-unsupported", "no file sections between the envelope markers");
  }
  if (operations.some((op) => op.kind === "update" && op.hunks.length === 0 && op.moveTo === null)) {
    const idle = operations.find((op) => op.kind === "update" && op.hunks.length === 0 && op.moveTo === null);
    fail("patch-grammar-unsupported", `Update File "${idle.path}" carries neither hunks nor a Move to; an empty update has no admitted meaning`);
  }
  return { authority: AUTHORITY, operations };
}

// ---------------------------------------------------------------------------
// 2. derivePatchEffects — resolution, reads, ordered effects
// ---------------------------------------------------------------------------

/** The report form of an established path: root-relative POSIX when the
 *  canonical path is inside `root`, the absolute canonical path otherwise.
 *  The two forms are distinguishable by construction (a relative form never
 *  starts with "/" or ".."), so a consumer can read containment off the
 *  string without re-resolving. What it reads off is containment in the
 *  installed ROOT only — NOT checkout membership: a path in a linked worktree
 *  of the installed repository reports here in its absolute form, while the
 *  membership predicate `codex-rule-context.js::checkoutTop` (which
 *  `codex-native-policy.js::publishedMoveContent` refuses with) accepts it. */
function reportForm(canonical, rootReal) {
  const rel = path.relative(rootReal, canonical);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return canonical;
  return rel.split(path.sep).join("/");
}

function octMode(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, "0");
}

/** Resolve one patch target to its canonical absolute form and its report
 *  form. Existing paths go through realpath (the sink included); a not-yet-
 *  existing path resolves its PARENT, so a symlinked parent cannot hide a
 *  divergence behind the lexical form. A parent that does not exist is a
 *  refusal, not an invitation to create directories: the admitted tool
 *  writes no intermediate directories, and guessing that it would fabricate
 *  a destination that may land nowhere. */
function resolveTarget(rawPath, cwd, rootReal) {
  const absolute = path.resolve(cwd, rawPath);
  const canonicalize =
    INVARIANTS.canonicalization === "realpath"
      ? (p) => fs.realpathSync(p)
      : (p) => p; // mutated: lexical form only (no symlink resolution)
  let exists = true;
  try {
    fs.lstatSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else fail("patch-target-missing", `target "${rawPath}" cannot be probed (${error.code || "IO error"})`);
  }
  let canonical;
  if (exists) {
    try {
      canonical = canonicalize(absolute);
    } catch (error) {
      fail("patch-target-missing", `target "${rawPath}" exists but does not resolve (${error.code || "IO error"}): canonical target unknown`);
    }
  } else {
    try {
      canonical = path.join(canonicalize(path.dirname(absolute)), path.basename(absolute));
    } catch (error) {
      fail("patch-target-missing", `target "${rawPath}" does not exist and its parent does not resolve (${error.code || "IO error"})`);
    }
  }
  return { raw: rawPath, absolute, canonical, report: reportForm(canonical, rootReal), exists };
}

/** Read a target's current bytes WITH the final-sink discipline: an existing
 *  non-regular sink is refused (`patch-target-not-regular` — its "bytes" are
 *  not a file's bytes), a symlink sink is resolved by `resolveTarget` and
 *  declared as a residual, never silently followed. */
function readTarget(target, residuals) {
  let lstat;
  try {
    lstat = fs.lstatSync(target.absolute);
  } catch (error) {
    fail("patch-read-failed", `target "${target.raw}" cannot be read (${error.code || error.message})`);
  }
  // EVERY regularity decision lives under the ONE `finalSink` invariant: a
  // check outside it would absorb that invariant's mutation and make the
  // corpus's sink arm unreadable.
  if (INVARIANTS.finalSink === "enforce") {
    if (!lstat.isFile() && !lstat.isSymbolicLink()) {
      fail("patch-target-not-regular", `target "${target.raw}" is not a regular file (mode ${octMode(lstat)}); its bytes cannot be read as a file's bytes`);
    }
    if (lstat.isSymbolicLink()) {
      residuals.push({
        span: target.report,
        reason: `final sink is a symlink (${target.raw}); the read and the write land on the canonical target, which is what the effect reports`,
      });
      let resolved;
      try {
        resolved = fs.statSync(target.canonical);
      } catch (error) {
        fail("patch-read-failed", `target "${target.raw}" resolves nowhere (${error.code || error.message})`);
      }
      if (!resolved.isFile()) {
        fail("patch-target-not-regular", `target "${target.raw}" resolves to a non-regular file; its bytes cannot be read as a file's bytes`);
      }
    }
  }
  let bytes;
  let stat;
  try {
    bytes = fs.readFileSync(target.canonical);
    stat = fs.statSync(target.canonical);
  } catch (error) {
    fail("patch-read-failed", `target "${target.raw}" cannot be read (${error.code || error.message})`);
  }
  return {
    bytes,
    size: bytes.length,
    mode: octMode(stat),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Apply update hunks to `lines` (the current file split on the SAME line
 *  terminator policy as any content comparison). Each hunk's OLD block is
 *  located by an exact search FORWARD from the cursor — the admitted
 *  anchoring rule. Not found ⇒ `patch-context-mismatch`. The `@@` anchor
 *  text is admitted and carried but NOT used for location: the tool's own
 *  fuzzy/anchored seek is unmeasured here, which is a declared residual
 *  (byte counts are supporting detail; the PATH SET is what policy keys on). */
function applyHunks(target, hunks, text) {
  const lines = text.split("\n");
  let cursor = 0;
  for (const [index, hunk] of hunks.entries()) {
    const block = hunk.oldLines;
    let at = -1;
    if (block.length === 0) {
      at = cursor;
    } else {
      for (let i = cursor; i + block.length <= lines.length; i++) {
        if (block.every((oldLine, offset) => lines[i + offset] === oldLine)) {
          at = i;
          break;
        }
      }
    }
    if (at === -1) {
      const first = block.length ? block[0] : "";
      fail(
        "patch-context-mismatch",
        `hunk ${index + 1} of "${target.raw}" does not match the current file (first removed/context line: ${JSON.stringify(first)})`,
      );
    }
    lines.splice(at, block.length, ...hunk.newLines);
    cursor = at + hunk.newLines.length;
  }
  return lines.join("\n");
}

/**
 * derivePatchEffects(text, {cwd, root, toolParser}) — the L1 derivation.
 *
 * Returns `{complete, authority, effects, readset, residuals}`:
 *
 *   complete   true on every RETURNED value; incompleteness is never
 *              returned as a partial success, it THROWS (PatchEffectsError).
 *   authority  the admitted grammar's identity (vendorAgreement "matched"
 *              only when a toolParser fact was compared and agreed).
 *   effects    one entry per operation, in patch order:
 *              {order, kind, sourcePath, destinationPath, affectedPaths,
 *               beforeBytes, afterBytes}
 *              kind is "add" | "update" | "delete" | "move"; paths are in
 *              reportForm (root-relative, or absolute when out of root);
 *              beforeBytes is MEASURED current bytes (null for add);
 *              afterBytes is DERIVED from the patched content (null for
 *              delete). A `Move to` derives kind "move" with BOTH endpoints.
 *   readset    {path, sha256, bytes, mode} for every file whose CURRENT
 *              bytes the derivation consumed (update/move/delete sources).
 *   residuals  declared non-resolutions that travel WITH the facts (vendor
 *              agreement, TOCTOU, resolved symlink sinks) — the same
 *              {span, reason} shape as the L1 contract's `unresolved`.
 *
 * Everything here is PROSPECTIVE: nothing is written. The readset is the
 * cheap predicate a later consumer can re-run to ask "have the inputs
 * moved?" without recomputing the derivation.
 */
function derivePatchEffects(text, { cwd, root, toolParser } = {}) {
  const effectiveCwd = cwd === undefined ? process.cwd() : cwd;
  if (typeof effectiveCwd !== "string" || effectiveCwd.length === 0) {
    fail("patch-context-mismatch", "cwd is absent or not a string; the derivation has no resolution context");
  }
  if (typeof root !== "string" || root.length === 0) {
    fail("patch-context-mismatch", "root is absent; the derivation will not guess the repository boundary it reports paths against");
  }
  let cwdReal;
  let rootReal;
  try {
    cwdReal = fs.realpathSync(effectiveCwd);
  } catch (error) {
    fail("patch-context-mismatch", `cwd "${effectiveCwd}" does not resolve (${error.code || "IO error"})`);
  }
  try {
    rootReal = fs.realpathSync(root);
  } catch (error) {
    fail("patch-context-mismatch", `root "${root}" does not resolve (${error.code || "IO error"})`);
  }

  const parsed = parsePatch(text);

  // Where a tool-parser fact IS available it is COMPARED, never trusted:
  // agreement upgrades vendorAgreement to "matched"; any disagreement is a
  // refusal (this module will not average two grammars).
  let authority = parsed.authority;
  if (toolParser !== undefined) {
    const theirs = toolParser && Array.isArray(toolParser.operations) ? toolParser.operations : null;
    if (!theirs) fail("patch-tool-parser-disagreement", "toolParser fact carries no operations array");
    const ours = parsed.operations.map((op) => ({ kind: op.kind, path: op.path, moveTo: op.moveTo }));
    const same = theirs.length === ours.length && theirs.every((op, i) =>
      op && op.kind === ours[i].kind && op.path === ours[i].path && (op.moveTo ?? null) === ours[i].moveTo);
    if (!same) {
      fail("patch-tool-parser-disagreement", "the supplied tool-parser fact disagrees with the admitted grammar's parse of this patch");
    }
    authority = Object.freeze({ ...AUTHORITY, vendorAgreement: "matched" });
  }

  const residualList = [
    {
      span: "<patch>",
      reason: authority.vendorAgreement === "matched"
        ? "vendor agreement MATCHED for this patch: the caller supplied a tool-parser fact and it agreed with the admitted grammar"
        : "vendor agreement UNKNOWN: the tool's own parser fact was not available, so this derivation implements ONE admitted grammar and the in-tree marker-regex projection is an imitation of it, not it",
    },
    {
      span: "<readset>",
      reason: "TOCTOU: bytes measured at probe time; apply-time state is not re-verified (resolve-and-normalize is necessary, not sufficient)",
    },
  ];

  const effects = [];
  const readset = [];
  const operations = INVARIANTS.operationCoverage === "every" ? parsed.operations : parsed.operations.slice(0, 1);

  for (const [index, op] of operations.entries()) {
    const order = index + 1;
    const target = resolveTarget(op.path, cwdReal, rootReal);

    if (op.kind === "add") {
      if (target.exists) {
        fail("patch-state-mismatch", `Add File "${op.path}" targets a path that already exists; the patch's pre-state assumption does not hold`);
      }
      const content = `${op.content.join("\n")}\n`;
      effects.push({
        order,
        kind: "add",
        sourcePath: null,
        destinationPath: target.report,
        affectedPaths: [target.report],
        beforeBytes: null,
        afterBytes: Buffer.byteLength(content, "utf8"),
      });
      continue;
    }

    if (!target.exists) {
      fail("patch-state-mismatch", `${op.kind === "delete" ? "Delete" : "Update"} File "${op.path}" targets a path that does not exist; the patch's pre-state assumption does not hold`);
    }
    const current = readTarget(target, residualList);
    readset.push({ path: target.report, sha256: current.sha256, bytes: current.size, mode: current.mode });

    if (op.kind === "delete") {
      effects.push({
        order,
        kind: "delete",
        sourcePath: target.report,
        destinationPath: null,
        affectedPaths: [target.report],
        beforeBytes: current.size,
        afterBytes: null,
      });
      continue;
    }

    const patched = applyHunks(target, op.hunks, current.bytes.toString("utf8"));
    const patchedBytes = Buffer.byteLength(patched, "utf8");
    if (op.moveTo !== null && INVARIANTS.moveDestination === "derive") {
      const destination = resolveTarget(op.moveTo, cwdReal, rootReal);
      if (destination.exists) {
        fail("patch-state-mismatch", `Move to "${op.moveTo}" targets a path that already exists; the patch's pre-state assumption does not hold`);
      }
      effects.push({
        order,
        kind: "move",
        sourcePath: target.report,
        destinationPath: destination.report,
        affectedPaths: [target.report, destination.report],
        beforeBytes: current.size,
        afterBytes: patchedBytes,
      });
      continue;
    }
    effects.push({
      order,
      kind: "update",
      sourcePath: target.report,
      destinationPath: target.report,
      affectedPaths: [target.report],
      beforeBytes: current.size,
      afterBytes: patchedBytes,
    });
  }

  return Object.freeze({
    complete: true,
    authority,
    effects: Object.freeze(effects.map((e) => Object.freeze({ ...e, affectedPaths: Object.freeze([...e.affectedPaths]) }))),
    readset: Object.freeze(readset.map((r) => Object.freeze({ ...r }))),
    residuals: Object.freeze(residualList.map((r) => Object.freeze({ ...r }))),
  });
}

// ---------------------------------------------------------------------------
// 3. evaluateFoundation — the evaluation seam
// ---------------------------------------------------------------------------

const DECISION_KINDS = Object.freeze([
  "deny", "undetermined-on-protected", "halt", "advisory", "allow", "unknown",
]);

/** Does this legacy result REFUSE, by the runtime's own definition of a
 *  restrictive verdict (a nonzero exit, a denial payload, a block decision,
 *  or an explicit continue:false)? Kept in step with the runtime's
 *  `verdictRestricts` reading; the runtime's `parseOutput` is reused lazily
 *  so the two cannot drift on how a payload is read. */
function legacyRestricts(result) {
  if (result.exitCode !== 0) return true;
  const { parseOutput } = require("./codex-hook-runtime");
  const json = parseOutput(result.stdout);
  if (!json) return false;
  const h = json.hookSpecificOutput;
  return Boolean(
    (h && typeof h === "object" && ["deny", "ask"].includes(h.permissionDecision)) ||
    json.decision === "block" ||
    json.continue === false,
  );
}

function legacyReason(result) {
  const { parseOutput } = require("./codex-hook-runtime");
  const json = parseOutput(result.stdout);
  const h = json && typeof json.hookSpecificOutput === "object" ? json.hookSpecificOutput : null;
  const text = [
    h && h.permissionDecisionReason,
    json && json.reason,
    json && json.stopReason,
    json && json.systemMessage,
    typeof result.stderr === "string" ? result.stderr.trim() : "",
  ].filter((v) => typeof v === "string" && v.trim()).join(" ");
  return text.trim();
}

function legacyCarriesContext(result) {
  const { parseOutput } = require("./codex-hook-runtime");
  const json = parseOutput(result.stdout);
  const h = json && typeof json.hookSpecificOutput === "object" ? json.hookSpecificOutput : null;
  return Boolean(
    (h && typeof h.additionalContext === "string" && h.additionalContext.trim()) ||
    (json && typeof json.systemMessage === "string" && json.systemMessage.trim()),
  );
}

function freezeDecision(decision) {
  return Object.freeze({ ...decision });
}

/**
 * decide — the ONE mapping from (legacy verdict, foundation facts) to a
 * decision record. It derives; it does not adjudicate:
 *
 *   - a RESTRICTIVE legacy result IS a deny (rank 1). The refusal happened;
 *     naming its rule is provenance, not a precondition. ruleId stays null
 *     when nothing supplied one.
 *   - a PERMISSIVE legacy result is where inference is refused. Without
 *     facts (a ruleId AND its provenance) the kind is "unknown" — NEVER
 *     "allow" — because an exit-0 result from a chain that emits no rule
 *     identity is not evidence any policy determined the call safe.
 *   - with facts: an `undetermined` L1 verdict on a PROTECTED target is
 *     "undetermined-on-protected" (rank 2), on an unprotected one "halt"
 *     (rank 3); a `determined` verdict carrying legacy context is "advisory"
 *     (rank 4), otherwise "allow" (rank 5). `facts.protected` is an INPUT —
 *     the protected-set question is the L3 chain's, never this module's.
 */
function decide(legacyResult, facts) {
  const restrictive = legacyRestricts(legacyResult);
  const ruleId = facts && typeof facts.ruleId === "string" && facts.ruleId ? facts.ruleId : null;
  const provenance = facts && facts.provenance && typeof facts.provenance === "object" ? facts.provenance : null;
  const factsVerdict = facts && ["determined", "undetermined"].includes(facts.verdict) ? facts.verdict : null;
  const protectedFact = facts && typeof facts.protected === "boolean" ? facts.protected : null;

  if (restrictive) {
    return freezeDecision({
      kind: "deny",
      ruleId,
      reason: legacyReason(legacyResult) || "the legacy policy chain refused this operation",
      provenance,
      factsVerdict,
      protected: protectedFact,
    });
  }
  if (!facts || !ruleId || !provenance) {
    return freezeDecision({
      kind: "unknown",
      ruleId,
      reason: !facts
        ? "no foundation facts supplied: an exit-0 legacy result carries no rule identity, and an allow is never inferred from a status byte"
        : "foundation facts lack a rule identity and provenance: the decision cannot be attributed, and an allow is never inferred from a status byte",
      provenance,
      factsVerdict,
      protected: protectedFact,
    });
  }
  if (factsVerdict === "undetermined") {
    return freezeDecision({
      kind: protectedFact === true ? "undetermined-on-protected" : "halt",
      ruleId,
      reason: typeof facts.reason === "string" && facts.reason
        ? facts.reason
        : "the L1 derivation is undetermined and carries no reason text",
      provenance,
      factsVerdict,
      protected: protectedFact,
    });
  }
  if (factsVerdict === "determined") {
    const advisory = legacyCarriesContext(legacyResult);
    return freezeDecision({
      kind: advisory ? "advisory" : "allow",
      ruleId,
      reason: advisory
        ? "determined, allowed, and the legacy evaluation carried context the agent must read"
        : "determined and allowed by the legacy evaluation",
      provenance,
      factsVerdict,
      protected: protectedFact,
    });
  }
  return freezeDecision({
    kind: "unknown",
    ruleId,
    reason: "foundation facts carry no recognized verdict, so the decision cannot be attributed",
    provenance,
    factsVerdict,
    protected: protectedFact,
  });
}

/**
 * evaluateFoundation(payload, {facts, evaluate, deadline}) →
 * `{decision, legacyResult}`.
 *
 *   evaluate  REQUIRED. The established evaluation, as a function
 *             `(payload, deadline) → {stdout, stderr, exitCode}`. Injected,
 *             never imported: the runtime imports this module, so an eager
 *             require of the runtime (or of the evaluator that requires it)
 *             would close the cycle at load time.
 *   facts     OPTIONAL `{verdict, effects, reason, protected, ruleId,
 *             provenance}`. Absent facts are a MISSING FACT, not an empty
 *             answer: the decision reads "unknown", never "allow".
 *   deadline  OPTIONAL absolute ms-since-epoch. Checked BEFORE evaluating:
 *             an already-expired budget refuses from inside the hook with
 *             the runtime's own budget refusal text, exactly as
 *             `evaluateEveryRendering` does — one behaviour for one state.
 *
 * The legacyResult is returned UNTOUCHED: this seam wraps the established
 * chain, it does not replace it, and a consumer that only wants the old
 * behaviour keeps it byte-for-byte.
 */
function evaluateFoundation(payload, { facts = null, evaluate, deadline = null } = {}) {
  if (typeof evaluate !== "function") {
    throw new TypeError("evaluateFoundation requires an evaluate function; the seam never evaluates anything itself");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("evaluateFoundation requires a payload object");
  }
  if (deadline !== null && Number.isFinite(deadline) && Date.now() >= deadline) {
    const { refusal } = require("./codex-hook-runtime");
    return Object.freeze({
      decision: freezeDecision({
        kind: "halt",
        ruleId: null,
        reason: "foundation evaluation exceeded its time budget before the legacy chain ran",
        provenance: null,
        factsVerdict: null,
        protected: null,
      }),
      legacyResult: refusal("Native policy evaluation exceeded its time budget."),
    });
  }
  const legacyResult = evaluate(payload, deadline === null ? undefined : deadline);
  if (!legacyResult || typeof legacyResult !== "object" || !Number.isInteger(legacyResult.exitCode)) {
    throw new TypeError("the injected evaluate returned no legacy result (an object with an integer exitCode is required)");
  }
  return Object.freeze({ decision: decide(legacyResult, facts), legacyResult });
}

// ---------------------------------------------------------------------------
// 4. serializeDecision — the caller's shape, restored
// ---------------------------------------------------------------------------

/**
 * serializeDecision(event, result) → `{stdout, stderr, exitCode}`.
 *
 * With a legacy result, the established per-event behaviour IS that result,
 * restored verbatim — the serializer never re-encodes what the runtime's own
 * normalisers already produced. Without one (a decision built outside an
 * evaluation), the decision is serialized through the runtime's own
 * `refusal()` builder, which already implements the per-event contract
 * (PreToolUse → exit 2 with the refusal envelope; every other event → exit 1
 * with the advisory envelope). `decisionFallback: "refuse"` pins the
 * fail-closed direction: an unrestorable decision refuses; it never emits a
 * bare pass.
 */
function serializeDecision(event, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("serializeDecision requires an {decision, legacyResult} object");
  }
  const legacy = result.legacyResult;
  if (legacy && typeof legacy === "object" && Number.isInteger(legacy.exitCode)) {
    return { stdout: legacy.stdout || "", stderr: legacy.stderr || "", exitCode: legacy.exitCode };
  }
  const decision = result.decision;
  const kind = decision && typeof decision.kind === "string" ? decision.kind : "unknown";
  const reason = decision && typeof decision.reason === "string" && decision.reason
    ? decision.reason
    : "the foundation produced no decision and no legacy result";
  const named = decision && decision.ruleId ? ` [${decision.ruleId}]` : "";
  const message = `[codex-foundation] ${kind}${named}: ${reason}`;
  if (INVARIANTS.decisionFallback === "refuse") {
    const { refusal } = require("./codex-hook-runtime");
    return refusal(message, event);
  }
  return { stdout: "", stderr: "", exitCode: 0 }; // mutated: the fail-closed fallback removed
}

module.exports = {
  AUTHORITY,
  INVARIANTS,
  REACH,
  DECISION_KINDS,
  PatchEffectsError,
  parsePatch,
  derivePatchEffects,
  evaluateFoundation,
  serializeDecision,
};
