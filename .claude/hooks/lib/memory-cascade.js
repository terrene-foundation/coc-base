/**
 * memory-cascade.js — the PURE PREDICATES behind `knowledge-cascade-routing.md`
 * MUST-1's Phase-2 detector: a write landed on a NON-CASCADING agent-memory
 * surface, so the cascade-value evaluation MUST-1 requires is owed on the record.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DECIDES, AND WHAT IT PROVABLY CANNOT — read before citing it
 * ─────────────────────────────────────────────────────────────────────────────
 * MUST-1 has TWO halves and this module implements exactly ONE of them:
 *
 *   THE SURFACE half   DECIDABLE. "is this write landing on a per-account,
 *                      non-cascading memory surface?" is a property of the PATH,
 *                      which arrives parsed on `tool_input.file_path`. That is a
 *                      structural signal, and this module decides it.
 *
 *   THE CASCADE-VALUE  NOT DECIDABLE, NOT ATTEMPTED, AND DELIBERATELY SO.
 *   half               "would a downstream agent, operator, or consumer repo
 *                      benefit from this?" is the judgment MUST-1 is built
 *                      around, and nothing in a file body carries it. A
 *                      reusable principle and an operator's ephemeral session
 *                      pointer are the same bytes to any matcher. The registry
 *                      row this detector graduates said so itself — "judging
 *                      whether the content was genuinely non-cascading stays
 *                      with the reviewer" — and this module keeps that promise
 *                      by returning NO verdict on content at all.
 *
 * CONSEQUENCE, STATED SO IT CANNOT BE MISREAD TWO WAYS:
 *
 *   A FINDING IS NOT A VIOLATION VERDICT. It records that a write reached a
 *   non-cascading surface and that MUST-1's evaluation is therefore owed on the
 *   record. A perfectly compliant memory write — genuinely local context, its
 *   cascade-value weighed and correctly answered "no" — fires this detector,
 *   and that is CORRECT, not a false positive: MUST-1's obligation is universal
 *   over this trigger ("Before writing any learning to `MEMORY.md` … the agent
 *   MUST evaluate its cascade-value"), so the prompt is owed on every one.
 *
 *   SILENCE IS NOT AN ALL-CLEAR. The trigger is a path shape. Cascade-valuable
 *   knowledge stranded anywhere else — a scratch note, a chat reply, a
 *   workspace file, an unregistered on-disk artifact (MUST-2's half) — is
 *   invisible here. That is the absence of an instrument, never a true negative
 *   (`instrument-discipline.md` MUST-3(a)).
 *
 * OVER-FIRING RELATIVE TO THE OBLIGATION, DECLARED RATHER THAN HIDDEN. MUST-1
 * binds a write OF A LEARNING. Whether a given memory write carries a learning
 * at all is semantic, so this detector's firing set is a SUPERSET of the
 * obligation's trigger set. It is a PROMPT to record the evaluation, not an
 * accusation that one was skipped — which is why the advisory it feeds asks for
 * one line and accepts "local context, not cascade-valuable" as a complete
 * answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PATH PREDICATE — two arms, and the near-misses each one must refuse
 * ─────────────────────────────────────────────────────────────────────────────
 * The arms are the rule's OWN declared trigger surface, taken from
 * `knowledge-cascade-routing.md`'s frontmatter `paths:` rather than from the
 * registry row's one-line summary of it:
 *
 *   ARM `basename`   the final path component is `MEMORY.md`, at ANY depth.
 *                    (frontmatter glob: double-star slash MEMORY.md)
 *   ARM `memory-dir` a `.md` file at ANY depth beneath a directory component
 *                    named exactly `memory`. (frontmatter glob: double-star
 *                    slash memory slash double-star slash star.md)
 *
 * The two globs are SPELLED OUT rather than quoted because a literal `*` `/`
 * pair terminates this block comment — which is not a stylistic note: writing
 * them literally is exactly what broke this file's first revision, and the
 * SyntaxError pointed at a line six below the real cause.
 *
 * THE TWO ARMS ARE INDEPENDENTLY LOAD-BEARING and that is MEASURED on this tree,
 * not assumed: `.claude/projects/-Users-<user>-repos-loom/memory/MEMORY.md`
 * satisfies both, but `.claude/projects/-Users-<user>-repos-loom/memory/project_kailash_prism.md`
 * satisfies ONLY `memory-dir`. Dropping that arm loses a real in-repo file.
 *
 * DIVERGENCE FROM THE REGISTRY ROW'S SUMMARY, DECLARED. The row described the
 * second arm as "star slash memory slash star.md" — an IMMEDIATE child of a
 * `memory/` directory. The rule's frontmatter reaches ANY depth beneath it. The
 * RULE is the obligation; the row was a one-line summary of it. This module
 * implements the rule's shape, which is a strict SUPERSET of the row's, so
 * nothing the row described is lost and one real case is gained (see the
 * `flag-memory-dir-deep-descendant` fixture).
 *
 * FOUR NEAR-MISSES THE NAIVE CHECKS GET WRONG, each a fixture case:
 *
 *   `docs/TEAM-MEMORY.md`      a naive `p.endsWith("MEMORY.md")` ACCEPTS this.
 *                              The basename is `TEAM-MEMORY.md`. REFUSED here —
 *                              the arm compares the whole final component.
 *   `.claude/team-memory/x.md` a naive `p.includes("memory/")` ACCEPTS this
 *                              (`team-memory/` contains `memory/`). REFUSED —
 *                              the arm compares whole path COMPONENTS. This is
 *                              not a hypothetical: two such files are tracked in
 *                              this repo today, and they are a SHARED, CASCADING
 *                              team surface — the opposite of what this detector
 *                              is for — so a false positive here would be the
 *                              detector contradicting its own rule.
 *                              MEASURED, and an earlier revision of this line got
 *                              it wrong: the path does NOT contain `/memory/`
 *                              (a `-` sits where the leading slash would be), so
 *                              the leading-slash form is NOT what this case
 *                              defeats. The error survived review and was caught
 *                              only when a mutation run failed to red on it.
 *   `notes/MEMORY.md.bak`      a naive `p.includes("MEMORY.md")` ACCEPTS this.
 *                              REFUSED — a backup is not the live surface.
 *   `docs/memoryland/x.md`     a naive `p.includes("/memory")` ACCEPTS this.
 *                              REFUSED — whole-component comparison again.
 *
 * CASE FOLDING IS DELIBERATE AND IS A WIDENING, NOT A CONVENIENCE. Both arms
 * compare case-INSENSITIVELY. On the case-insensitive filesystems this corpus is
 * developed on (darwin, and Windows at client forks), `Memory.md` and `MEMORY.md`
 * ARE THE SAME FILE, so a case-sensitive predicate would be silently blind to a
 * write the OS treats as identical — a false negative, which for an advisory is
 * the costlier direction. The price is that a genuine lowercase `memory.md` on a
 * case-sensitive filesystem also fires; that file is still agent-memory-shaped,
 * and the finding is advisory.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, and the rule fixed that before this detector existed
 * ─────────────────────────────────────────────────────────────────────────────
 * `knowledge-cascade-routing.md` § Trust Posture Wiring already declares it:
 * "`advisory` at the hook layer … a lexical `PostToolUse(Write)` tripwire on
 * `MEMORY.md` writes MAY pair as advisory but MUST NOT carry `block`". This
 * module honours that verbatim rather than re-deriving it.
 *
 * It is ALSO the honest ceiling on inspection, by two independent arguments.
 * (1) The COMPOSED finding is capped at its weakest half, and the cascade-value
 * half is not merely lexical but absent — so no strengthening of the path arm
 * can lift the composite. (2) At `PostToolUse` the write has ALREADY HAPPENED;
 * there is no call left to refuse, so `block` would be a claim about a decision
 * that is over. Note that the path signal itself is STRUCTURAL (a parsed
 * `file_path`, not prose), so `hook-output-discipline.md` MUST-2 does not by
 * itself bar `block` here — the cap comes from the rule's own declaration and
 * from the missing half, and saying otherwise would mis-cite MUST-2.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURITY
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTHING in this file touches the filesystem, spawns a process, or reads the
 * environment. Every input arrives on the argument, so the fixtures drive the
 * REAL predicates rather than a re-implementation of them. All I/O lives in
 * `../memory-cascade-guard.js`.
 *
 * Origin: graduated 2026-09-15 from
 * `phase2-deferrals.json::deferrals["knowledge-cascade-routing.md#memory-write-detector"]`,
 * whose registered graduation condition was "Delete this entry when the
 * MEMORY.md write advisory ships with fixtures."
 */

"use strict";

/** The canonical harness memory filename, compared case-insensitively. */
const MEMORY_BASENAME = "memory.md";

/** The directory component whose `.md` descendants are memory surfaces. */
const MEMORY_DIRNAME = "memory";

/** Bound every evidence string so a long path cannot flood the response. */
const EVIDENCE_MAX = 200;

/**
 * Split a path into components, tolerating either separator.
 *
 * Backslashes are treated as separators so a Windows-shaped `file_path` from a
 * client fork decomposes correctly. A POSIX filename may legally CONTAIN a
 * backslash, which this would split — accepted deliberately: the failure mode is
 * a wider match on a pathological name, and the finding is advisory.
 */
function splitComponents(p) {
  if (typeof p !== "string") return [];
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((c) => c.length > 0 && c !== ".");
}

function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s
    // Strip C0 controls + DEL (incl. newlines) so a crafted path cannot forge lines.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX
    ? flat.slice(0, EVIDENCE_MAX) + "..."
    : flat;
}

/**
 * Which memory-surface arm, if any, this path satisfies.
 *
 * PURE. Accepts absolute OR relative paths and does NOT resolve either — the
 * live agent-memory file lives OUTSIDE any project directory (a per-account
 * path), so a predicate that first relativised against the project root would be
 * blind to the single most important trigger there is.
 *
 * @param {string} filePath
 * @returns {{arm:"basename"|"memory-dir", basename:string}|null}
 */
function classifyMemoryPath(filePath) {
  const parts = splitComponents(filePath);
  if (parts.length === 0) return null;

  const basename = parts[parts.length - 1];
  // Guard against a path ending in a separator (a directory, never a write target).
  if (!basename) return null;

  // ARM 1 — the whole final component, never a suffix. `TEAM-MEMORY.md` and
  // `MEMORY.md.bak` both fail here, which is the point.
  if (basename.toLowerCase() === MEMORY_BASENAME) {
    return { arm: "basename", basename };
  }

  // ARM 2 — a `.md` at any depth beneath a component named exactly `memory`.
  // Whole-component comparison, so `team-memory` and `memoryland` both fail.
  if (!/\.md$/i.test(basename)) return null;
  const dirs = parts.slice(0, -1);
  for (const d of dirs) {
    if (d.toLowerCase() === MEMORY_DIRNAME) {
      return { arm: "memory-dir", basename };
    }
  }
  return null;
}

/**
 * The verdict. PURE — every input is supplied by the caller.
 *
 * FAILS OPEN on every unknown (`cc-artifacts.md` Rule 7): a non-write tool, an
 * absent path, an unrecognised shape. Returns findings, never throws on input.
 *
 * `toolName` is checked HERE as well as at the matcher, because a matcher is a
 * registration fact and this module is also driven directly by fixtures; the
 * predicate must carry its own scope rather than inherit it from wiring that the
 * fixtures do not exercise.
 *
 * @param {object} ctx
 * @param {string} ctx.toolName   the tool that ran (`Write`)
 * @param {string} ctx.filePath   `tool_input.file_path`
 * @returns {Array<{rule_id,severity,arm,evidence}>}
 */
function inspectMemoryWrite(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const toolName = typeof c.toolName === "string" ? c.toolName : "";
  if (toolName !== "Write") return [];

  const filePath = typeof c.filePath === "string" ? c.filePath : "";
  if (!filePath.trim()) return [];

  const hit = classifyMemoryPath(filePath);
  if (!hit) return [];

  const why =
    hit.arm === "basename"
      ? "the final path component is `MEMORY.md`"
      : "the file is a `.md` beneath a directory component named `memory`";

  return [
    {
      rule_id: "knowledge-cascade-routing/memory-write",
      severity: "advisory",
      arm: hit.arm,
      evidence:
        `A Write landed on a NON-CASCADING agent-memory surface — ${why}. ` +
        `Path: ${sanitize(filePath)}. ` +
        `knowledge-cascade-routing.md MUST-1 requires a cascade-value evaluation ` +
        `BEFORE any learning is written here; memory is per-account and reaches no ` +
        `downstream consumer. This finding records the SURFACE only — it makes NO ` +
        `claim about whether the content was cascade-valuable, which stays with the reviewer.`,
    },
  ];
}

module.exports = {
  EVIDENCE_MAX,
  MEMORY_BASENAME,
  MEMORY_DIRNAME,
  classifyMemoryPath,
  inspectMemoryWrite,
  splitComponents,
};
