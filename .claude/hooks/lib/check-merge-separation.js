/**
 * check-merge-separation.js — the PURE decision half of the CI-check/merge separation guard
 * (`rules/git.md` § Discipline, "CI-check and merge are SEPARATE steps under duplicate-run races").
 *
 * THE CONTRACT, verbatim from the rule:
 *
 *   "(1) READ — pin the head SHA (`gh pr view <N> --json headRefOid`) and confirm every REQUIRED
 *    check is `SUCCESS` on THAT SHA; (2) MERGE — only then `gh pr merge <N>`. Bundling them
 *    (`&&`, or `--watch` then merge) is BLOCKED."
 *
 * THE SUBJECT IS ONE Bash `command` STRING, and the violation is a CO-OCCURRENCE inside it: a
 * check-READING gh invocation and a `gh pr merge` invocation in the SAME tool call. That is the
 * whole shape — the harm is not that the two commands exist, it is that the merge fires on the
 * reader's EXIT STATUS with nobody having read WHICH run the reader resolved against. A `--watch`
 * that returns green may have resolved against the PRIOR commit's run while a newer duplicate on
 * the current head is still pending or flaked red.
 *
 * ── WHY EVERY MATCH RUNS THROUGH `parseGhInvocations`, NEVER A REGEX ─────────────────────────
 *
 * `lib/git-command-parse.js::parseGhInvocations` is the repo's ONE gh dispatch surface. It
 * normalizes through `dispatchSurface` — which calls `violation-patterns.js::stripHeredocBodies`
 * FIRST and `stripShellComments` second — then splits quote-aware on `&&`, `||`, `;`, `|` and
 * newline, expands nested interpreter bodies (`sh -c '…'`, `eval "…"`), and reports the group and
 * subcommand from PARSED POSITIONS. Requiring it rather than re-deriving a splitter here is
 * `security.md` § Enforcement-Surface Parity: the next time that surface is hardened this detector
 * learns it, and it cannot grow a private lineage that drifts. Three consequences fall out for
 * free, and the fixtures pin all three:
 *
 *   · a bundled form quoted inside a heredoc body is DATA, not a command  → silent
 *   · the same form after a `#` is a COMMENT                              → silent
 *   · `echo "gh pr checks 42 && gh pr merge 42"` is an ARGUMENT           → silent
 *
 * ── FAIL OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7) ───────────────────────────────────
 *
 * A non-string command, an empty command, a parse that throws, a gh invocation whose subcommand
 * sits behind an unresolved substitution (`gh pr $(echo merge)`) — every one returns null. The
 * fail-open direction is deliberate and is affordable HERE precisely because this detector cannot
 * block: a missed bundle costs one advisory that did not fire, while a false one costs the
 * orchestrator's trust in every later finding this hook carries.
 *
 * WRITES NOTHING. Evidence strings are bounded and single-lined; no prompt or command text is
 * retained beyond the clipped fragment the advisory echoes.
 *
 * Origin: `skills/32-trust-posture/wiring/git.md` § Trust Posture Wiring — kailash-py PR #1465 Trap-1, landed at loom via
 * `/sync-from-build` py Shard B (`journal/0402`). The clause shipped 2026-07-03 with its detector
 * booked as Phase-2 and its own deferral row conceding the form "is lexically recognisable at the
 * Bash boundary … deferred by schedule, not by difficulty". This is that detector.
 */

"use strict";

const path = require("node:path");

const { parseGhInvocations } = require(
  path.join(__dirname, "git-command-parse.js"),
);

/** The finding identity every violation of this contract carries. */
const RULE_ID = "git/ci-check-merge-separation";

/** Cap on evidence echoed back into a hook advisory. */
const EVIDENCE_MAX = 200;

/**
 * gh invocations that READ CI state — the (1) READ half of the contract.
 *
 * `pr checks` is the canonical reader the rule names. `run watch` and `run view` are the same
 * question asked of the workflow-run surface: `gh run watch <id> && gh pr merge <N>` carries the
 * IDENTICAL race (the run being watched may be the prior commit's), only through a different
 * reader verb. Keyed by group so a future gh grammar change is one map entry, not a regex rewrite.
 */
const CHECK_READER_VERBS = new Map([
  ["pr", new Set(["checks"])],
  ["run", new Set(["watch", "view"])],
]);

/** Groups in which a bare `--watch` marks an invocation as a CI-state reader. */
const WATCHABLE_GROUPS = new Set(["pr", "run", "checks"]);

/** Flags that turn an invocation into documentation rather than an action. */
const HELP_FLAGS = new Set(["--help", "-h", "help"]);

/** Truncate + single-line an evidence fragment so an advisory stays bounded. */
function clip(s, max = EVIDENCE_MAX) {
  if (typeof s !== "string") return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** The argv tokens of a parsed gh invocation, always an array. */
function argvOf(inv) {
  return inv && Array.isArray(inv.argv) ? inv.argv : [];
}

/**
 * The SUBJECT a gh invocation names — the PR/run selector, as written.
 *
 * WHY THIS EXISTS. The evidence this module emits used to say the call bundles a CI read "with the
 * merge it gates". `classifyCommand` never established that relation: it collected readers and
 * merges from ONE command string and correlated NOTHING, so `gh run view 12345 && gh pr merge 42`
 * — a read of an unrelated run — was described as gating the merge. That is a claim about the
 * world the predicate had not measured (`zero-tolerance.md` Rule 3e at the message layer), and it
 * is the same over-claim class this round was convened to remove. The fix is to MEASURE the
 * relation and let the sentence follow the measurement, rather than to soften the sentence.
 *
 * Deliberately SYNTACTIC and deliberately weak: the first non-flag operand after the subcommand,
 * compared as written. A PR named as `42` in one call and as a URL or branch in the other reads as
 * DIFFERENT, which is the safe direction — it withdraws the strong claim rather than asserting a
 * match it cannot support. Resolving those spellings to one identity needs the network, and a
 * PreToolUse hook must not perform network I/O.
 *
 * @param {object} inv a parsed gh invocation
 * @returns {string|null} the subject as written, or null when none is present
 */
function subjectOf(inv) {
  const argv = argvOf(inv);
  for (const tok of argv) {
    if (typeof tok !== "string" || tok === "") continue;
    if (tok.startsWith("-")) continue; // a flag, or a flag's attached value
    return tok;
  }
  return null;
}

/**
 * Decide whether the reader and the merge demonstrably concern the SAME subject.
 *
 * Three answers, and the third is the point: `true` (same subject, so "the merge it gates" is
 * EARNED), `false` (subjects resolve and DIFFER, so the read demonstrably does not gate this
 * merge), and `null` (at least one subject is absent or unreadable, so the relation is UNKNOWN and
 * must not be asserted in either direction).
 *
 * @param {object[]} readers parsed reader invocations
 * @param {object[]} merges parsed merge invocations
 * @returns {boolean|null}
 */
function sameSubject(readers, merges) {
  const rs = (readers || []).map(subjectOf);
  const ms = (merges || []).map(subjectOf);
  if (rs.length === 0 || ms.length === 0) return null;
  if (rs.some((s) => s === null) || ms.some((s) => s === null)) return null;
  const uniq = new Set([...rs, ...ms]);
  return uniq.size === 1;
}

/**
 * True when this invocation BLOCKS waiting for a verdict — the rule's NAMED worst case.
 *
 * Two shapes, one meaning: the `--watch` FLAG (attached `--watch=…` form included), and the
 * `gh run watch` VERB, which is a blocking wait with no flag to carry. Reading only the flag would
 * have given the run-surface form the milder evidence line while it runs the identical race, which
 * is the naming-convention blindness this repo keeps re-learning.
 */
function hasWatchFlag(inv) {
  if (!inv) return false;
  if (inv.group === "run" && inv.sub === "watch") return true;
  return argvOf(inv).some((t) => t === "--watch" || t.startsWith("--watch="));
}

/**
 * True when this invocation is DOCUMENTATION rather than an action — `gh pr merge --help`,
 * `gh pr merge -h`, `gh help pr merge`. The WITHDRAW arm: a help invocation runs no merge, so a
 * finding built on it would be a pure false positive on the one command an operator runs when they
 * are trying to LEARN the correct form.
 */
function isHelpInvocation(inv) {
  if (!inv) return true;
  if (inv.group === "help") return true;
  return argvOf(inv).some((t) => HELP_FLAGS.has(t));
}

/**
 * Is this parsed invocation a CI-state READ?
 *
 * Never a merge: `gh pr merge` is the (2) half and can never stand in for the (1) half, so the
 * merge verb is excluded before the `--watch` arm is consulted.
 */
function isCheckReader(inv) {
  if (!inv || !inv.group || !inv.sub) return false;
  if (inv.group === "pr" && inv.sub === "merge") return false;
  if (isHelpInvocation(inv)) return false;
  const subs = CHECK_READER_VERBS.get(inv.group);
  if (subs && subs.has(inv.sub)) return true;
  // "or any `--watch`-bearing gh check/run read" — the flag IS the blocking-read signal, whatever
  // verb carries it, because a command that waits for a verdict is what the merge then rides on.
  return WATCHABLE_GROUPS.has(inv.group) && hasWatchFlag(inv);
}

/** Is this parsed invocation a REAL `gh pr merge` — an action, not a help page? */
function isRealMerge(inv) {
  if (!inv || inv.group !== "pr" || inv.sub !== "merge") return false;
  return !isHelpInvocation(inv);
}

/**
 * Parse a Bash command string into its gh invocations, failing open to [] on anything unreadable.
 *
 * @param {string} command
 * @returns {object[]}
 */
function ghInvocationsOf(command) {
  if (typeof command !== "string" || command.trim() === "") return [];
  try {
    const out = parseGhInvocations(command);
    return Array.isArray(out) ? out : [];
  } catch {
    return []; // A parse this module cannot complete is an UNKNOWN, never a violation.
  }
}

/**
 * Classify one Bash command against the separation contract.
 *
 * Exported ALONGSIDE the detector so a fixture can assert WHY a command was silent rather than
 * only THAT it was — a clean merge must be silent because no READER was present, not because the
 * merge itself went unrecognised. A silence whose cause is unpinned is indistinguishable from an
 * inert predicate (`instrument-discipline.md` MUST-2).
 *
 * @param {string} command
 * @returns {{readers:object[], merges:object[], watch:boolean, bundled:boolean}}
 */
function classifyCommand(command) {
  const invocations = ghInvocationsOf(command);
  const readers = invocations.filter(isCheckReader);
  const merges = invocations.filter(isRealMerge);
  return {
    readers,
    merges,
    watch: readers.some(hasWatchFlag),
    bundled: readers.length > 0 && merges.length > 0,
  };
}

/** Render one parsed invocation back to a short `gh <group> <sub> <args>` label for evidence. */
function labelOf(inv) {
  return clip(`gh ${inv.group} ${inv.sub}${inv.args ? ` ${inv.args}` : ""}`, 80);
}

/**
 * `git.md` § Discipline — a CI-state read and a `gh pr merge` bundled into ONE tool call.
 *
 * SEVERITY `halt-and-report`, and the ceiling is argued rather than assumed.
 *
 *   WHY NOT `block`. `hook-output-discipline.md` MUST-2 reserves `block` for a structural signal a
 *   surface rewrite cannot evade. Both halves of THIS predicate are structural — parsed gh
 *   subcommand POSITIONS and argv TOKENS, never a regex over the joined string — so the signal
 *   would qualify. The bar it fails is a different one: the VERDICT rests on the ABSENCE of a
 *   pinned READ that this hook cannot see. `PreToolUse` shows it exactly one command string; a
 *   session that correctly pinned the head SHA in an EARLIER call and then, at the end, bundled a
 *   confirming `gh pr checks` with its merge would be refused on evidence the hook never had. A
 *   refusal that can be wrong about a correctly-ordered session is a refusal operators disable,
 *   which restores the bug.
 *
 *   WHY NOT LOWER. The cost asymmetry runs the other way from a style advisory: a merge that lands
 *   on a stale-green or red duplicate run is not undone by noticing it afterwards. `advisory`
 *   renders as commentary on a call that is going ahead; `halt-and-report` requires the
 *   orchestrator to answer for the ordering before it does, which is the whole remedy — split the
 *   call in two and pin the SHA.
 *
 * @param {string} command the Bash `tool_input.command`
 * @returns {{rule_id:string,severity:string,evidence:string,readers:string[],merges:string[]}|null}
 */
function detectBundledCheckAndMerge(command) {
  const c = classifyCommand(command);
  if (!c.bundled) return null;

  const readerLabels = c.readers.map(labelOf);
  const mergeLabels = c.merges.map(labelOf);

  // The `--watch` form is the rule's NAMED worst case and gets its own evidence line: the other
  // bundled forms race a duplicate run, this one actively waits for the WRONG run to finish.
  // The RELATION, measured rather than asserted. `same === true` earns "the merge it gates";
  // `false` means the read demonstrably concerns a DIFFERENT subject, which is a worse bundle and
  // is named as such; `null` means it could not be read, so no relation is claimed in either
  // direction. An earlier revision said "the merge it gates" unconditionally, on a correlation
  // this module never performed.
  const same = sameSubject(c.readers, c.merges);
  const relation =
    same === true
      ? "with the merge it gates"
      : same === false
        ? "with a merge of a DIFFERENT subject"
        : "with a merge";
  const tail =
    same === false
      ? ` The reader and the merge name different subjects as written, so the read does not gate ` +
        `this merge at all — the exit status the merge rides answers a question nobody asked here.`
      : same === null
        ? ` Whether the read even concerns this merge could not be determined from the argv, so ` +
          `that it gates the merge is UNVERIFIED rather than established.`
        : "";

  const head = c.watch
    ? `this call bundles a BLOCKING check-watch ${relation}: ` +
      `[${readerLabels.join(" | ")}] then [${mergeLabels.join(" | ")}]. A \`--watch\` that ` +
      `returns green may have resolved against the PRIOR commit's run while a newer duplicate on ` +
      `the current head is still pending or flaked red — and the \`&&\` fires the merge on that ` +
      `exit status with no one having read WHICH run answered.${tail}`
    : `this call bundles a CI-state read ${relation}: ` +
      `[${readerLabels.join(" | ")}] then [${mergeLabels.join(" | ")}]. The merge rides the ` +
      `reader's exit status inside one tool call, so nothing confirms the checks that passed were ` +
      `the ones on the head SHA being merged.${tail}`;

  return {
    rule_id: RULE_ID,
    severity: "halt-and-report",
    readers: readerLabels,
    merges: mergeLabels,
    evidence:
      `${head} Per rules/git.md § Discipline these are SEPARATE steps: (1) READ — ` +
      `\`head=$(gh pr view <N> --json headRefOid -q .headRefOid)\`, then confirm every REQUIRED ` +
      `check is SUCCESS on THAT SHA; (2) MERGE — only then \`gh pr merge <N>\`, in its own call.`,
  };
}

/**
 * Run the contract against one Bash command. Returns an array (possibly empty) — never null — so a
 * caller cannot mistake "no findings" for "did not run".
 *
 * @param {string} toolName
 * @param {object} toolInput the PreToolUse `tool_input`
 * @returns {object[]}
 */
function inspectBashCommand(toolName, toolInput) {
  if (toolName !== "Bash") return [];
  const command =
    toolInput && typeof toolInput === "object" && typeof toolInput.command === "string"
      ? toolInput.command
      : "";
  if (!command.trim()) return []; // Absent command is an UNKNOWN — fail open.
  const f = detectBundledCheckAndMerge(command);
  return f ? [f] : [];
}

module.exports = {
  RULE_ID,
  EVIDENCE_MAX,
  CHECK_READER_VERBS,
  WATCHABLE_GROUPS,
  clip,
  hasWatchFlag,
  isHelpInvocation,
  isCheckReader,
  isRealMerge,
  ghInvocationsOf,
  classifyCommand,
  detectBundledCheckAndMerge,
  inspectBashCommand,
};
