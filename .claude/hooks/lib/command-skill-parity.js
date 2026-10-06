/**
 * command-skill-parity.js — the PURE PREDICATES behind `command-skill-parity.md`'s
 * Phase-2 detector. Two arms, registered together by the rule's own Phase-2
 * sentence and built together here:
 *
 *   ARM 1  command-edit-without-paired-skill-edit
 *          An edit to `.claude/commands/<x>.md` that CHANGES A DECLARED STEP OR
 *          FLAG, where the session has not also touched any skill that command
 *          references. MUST-2: "An edit to either side ... MUST re-derive the
 *          other side IN THE SAME `/codify`."
 *
 *   ARM 2  dangling-skill-reference
 *          A `skills/<name>` reference in the written command body whose target
 *          does not exist on disk, or which no line of `sync-manifest.yaml`
 *          declares. MUST-3: "A command referencing a non-existent or
 *          unregistered skill ... is BLOCKED." The rule's own Detection block
 *          already specifies this sweep verbatim:
 *          `grep -o 'skills/[a-z0-9-]*' commands/*.md` → confirm each target
 *          exists + is in `sync-manifest.yaml`.
 *
 * --- SCOPE OF SILENCE — read before citing a clean run -----------------------
 * ARM 1 is a JUDGMENT approximated by a lexical proxy, and the proxy's misses
 * are named rather than implied:
 *   - "DECLARED step or flag" is approximated by (a) step headings / `Step N`
 *     mentions and (b) long-form `--flag` tokens. A flow change carried purely
 *     in prose ("run these in the other order") changes neither token set and is
 *     INVISIBLE here. The gate-review layer still owns that half.
 *   - The paired-skill set is derived from the command's OWN references. A
 *     command that references NO skill has no pair to drift from, so the match is
 *     WITHDRAWN — firing there would flag every ordinary command edit and train
 *     the operator to ignore the hook.
 *   - `Write` on a command supplies the whole new body and NO prior, so no token
 *     DIFFERENCE is computable. ARM 1 is WITHHELD for `Write` (a smaller true
 *     answer, never a false clean); ARM 2 still reads the written body.
 *   - THE CO-CHANGE MAY LAND LATER. This predicate sees the session's edits up to
 *     this call. An operator mid-flight who edits the command and its skill two
 *     tool calls apart draws a finding on the first call that is PREMATURE, not
 *     wrong. That is the price of firing at the seam instead of at session end,
 *     and it is why this arm is advisory: the finding is a prompt to check, never
 *     a refusal. (`Stop` would eliminate the prematurity at the cost of firing
 *     after the edit is long past and after the operator has left the file — see
 *     `../command-skill-parity-guard.js` § HOOK EVENT.)
 *
 * ARM 2 has no such softness: its verdict is `fs.existsSync` plus a parsed
 * manifest — a FILESYSTEM FACT, and the stronger half of this detector by a wide
 * margin. It is held at `advisory` only to match the tier the rule's Trust
 * Posture Wiring registered ("a lexical scan MAY flag a dangling `skills/<name>`
 * reference but MUST NOT carry `block`"), NOT because it could not carry more.
 *
 * --- DERIVED, NEVER HAND-LISTED ---------------------------------------------
 * There is no command→skill table in this file, deliberately. Both enumerations
 * are read from their authority by the caller and handed in:
 *   - the PAIRING          ← the `skills/<name>` references in the command body
 *                            itself (the rule's own definition of a pair: "the
 *                            command references the skill")
 *   - MANIFEST MEMBERSHIP  ← the non-comment lines of `.claude/sync-manifest.yaml`
 * A predicate keyed on a naming convention a newer convention outgrew is this
 * corpus's recurring defect class, so neither list is restated here.
 *
 * --- THE REFERENCE ANCHOR IS LOAD-BEARING -----------------------------------
 * The rule's suggested sweep, `grep -o 'skills/[a-z0-9-]*'`, MEASURABLY
 * over-matches on this very tree: `commands/codify.md:153` contains the prose
 * "which rules/skills/agents were updated", from which that grep extracts
 * `skills/agents` — a skill that exists nowhere and never did. An unanchored ARM
 * 2 therefore reports a dangling reference on a compliant corpus. The anchor
 * below refuses a match preceded by a path character (so `rules/skills/agents`
 * is not a reference) while accepting the `.claude/` prefix that legitimately
 * precedes one. `clean-slash-prefixed-skills-word` pins that case.
 *
 * --- PURITY -----------------------------------------------------------------
 * NOTHING here touches the filesystem, spawns a process, or reads the
 * environment. Existence, manifest membership and the session's edit set all
 * arrive on the context object, so the fixtures drive the REAL predicates rather
 * than a re-implementation. All I/O lives in `../command-skill-parity-guard.js`.
 *
 * Origin: graduated from
 * `phase2-deferrals.json::deferrals["command-skill-parity.md#paired-skill-edit"]`
 * 2026-09-13, whose own `reason` conceded the detector was buildable and merely
 * unwritten: "The trigger is a diff-shape ... which is exactly what a PostToolUse
 * detector can see. Deferred by schedule."
 */

"use strict";

/** Bound every evidence string so a large edit cannot flood the response. */
const EVIDENCE_MAX = 200;

/** The only directory ARM 1 is scoped to. ARM 2 rides the same scope. */
const COMMAND_DIR_SEGMENT = ".claude/commands/";

function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX ? flat.slice(0, EVIDENCE_MAX) + "..." : flat;
}

/**
 * True when a path names a command artifact. Anchored on the DIRECTORY segment,
 * not on a basename or an extension, so `docs/commands/foo.md` and
 * `.claude/commands/foo.json` are both correctly out of scope.
 */
function isCommandPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  const norm = filePath.replace(/\\/g, "/");
  return norm.includes(COMMAND_DIR_SEGMENT) && norm.endsWith(".md");
}

/** True when a path names a skill artifact, and yields the skill's name. */
function skillNameOf(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  const m = norm.match(/\.claude\/skills\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Every `skills/<name>` reference in a body, anchored (see § THE REFERENCE
 * ANCHOR IS LOAD-BEARING). Returns unique names in first-seen order.
 */
function extractSkillReferences(body) {
  if (typeof body !== "string" || !body) return [];
  const re = /(^|[^A-Za-z0-9_./-])(?:\.claude\/)?skills\/([a-z0-9][a-z0-9-]*)/g;
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[2];
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The DECLARED-step token set of a body: explicit `Step N` mentions and numbered
 * step headings. Normalized to lowercase so a capitalization fix is not a step
 * change.
 */
function stepTokens(body) {
  const set = new Set();
  if (typeof body !== "string" || !body) return set;
  const stepRe = /\bstep\s+(\d+[a-z]?)\b/gi;
  let m;
  while ((m = stepRe.exec(body)) !== null) set.add(`step:${m[1].toLowerCase()}`);
  const headingRe = /^[ \t]{0,3}#{1,6}[ \t]+(\d+[a-z]?)[.)][ \t]*(.*)$/gim;
  while ((m = headingRe.exec(body)) !== null) {
    set.add(`heading:${m[1].toLowerCase()}:${m[2].trim().toLowerCase()}`);
  }
  return set;
}

/**
 * The DECLARED-flag token set of a body: long-form `--flag` options. A bare `--`
 * and a markdown `---` frontmatter fence do not match (the first character after
 * the dashes must be alphanumeric), and an em-dash is a different codepoint
 * entirely.
 */
function flagTokens(body) {
  const set = new Set();
  if (typeof body !== "string" || !body) return set;
  const re = /(^|[^A-Za-z0-9\-])--([a-z0-9][a-z0-9-]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) set.add(`flag:--${m[2]}`);
  return set;
}

/** Symmetric difference of two token sets, as a sorted array. */
function symmetricDifference(a, b) {
  const out = [];
  for (const t of a) if (!b.has(t)) out.push(t);
  for (const t of b) if (!a.has(t)) out.push(t);
  return out.sort();
}

/**
 * Did this edit CHANGE a declared step or flag? Returns the changed tokens.
 * Pure set difference over old vs new text — an edit that only rewords prose
 * moves no token and returns `[]`, which is the load-bearing clean pole.
 */
function declaredSurfaceChange(oldText, newText) {
  const changed = symmetricDifference(stepTokens(oldText), stepTokens(newText));
  const flags = symmetricDifference(flagTokens(oldText), flagTokens(newText));
  return changed.concat(flags);
}

/**
 * The verdict. PURE — every input is supplied by the caller.
 *
 * @param {object} ctx
 * @param {string}   ctx.toolName        "Edit" | "Write" | "MultiEdit" | ...
 * @param {string}   ctx.filePath        tool_input.file_path
 * @param {string}   ctx.oldText         the pre-edit text (Edit: old_string). "" for Write.
 * @param {string}   ctx.newText         the post-edit text (Edit: new_string; Write: content)
 * @param {string}   ctx.commandBody     the full on-disk command body after the write, if readable
 * @param {string[]} ctx.sessionEditedSkills   skill NAMES this session has already edited
 * @param {(name:string)=>boolean} ctx.skillExists       on-disk existence oracle
 * @param {(name:string)=>boolean} ctx.skillInManifest   manifest-membership oracle
 * @returns {Array<{rule_id,severity,evidence}>}
 */
function inspectCommandWrite(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  // FAIL OPEN on every unknown (`cc-artifacts.md` Rule 7).
  if (!isCommandPath(c.filePath)) return [];

  const findings = [];
  const body =
    typeof c.commandBody === "string" && c.commandBody
      ? c.commandBody
      : typeof c.newText === "string"
        ? c.newText
        : "";
  const referenced = extractSkillReferences(body);

  // ── ARM 2 — dangling reference. A filesystem fact, run first because it does
  // not depend on the session's history at all.
  const existsFn = typeof c.skillExists === "function" ? c.skillExists : null;
  const manifestFn =
    typeof c.skillInManifest === "function" ? c.skillInManifest : null;
  for (const name of referenced) {
    // WITHHELD without an oracle: with no way to ask, an absent skill and a
    // present one are indistinguishable — the smaller true answer, never a
    // false clean and never a guessed finding.
    if (!existsFn) break;
    let onDisk;
    try {
      onDisk = existsFn(name) === true;
    } catch {
      continue; // a throwing oracle is UNKNOWN ⇒ fail open for this name
    }
    if (!onDisk) {
      findings.push({
        rule_id: "command-skill-parity/dangling-skill-reference",
        severity: "advisory",
        evidence:
          `\`${sanitize(c.filePath)}\` references \`skills/${name}\`, which does NOT exist ` +
          `on disk. command-skill-parity.md MUST-3: the reader following the command's ` +
          `reference dead-ends, and the runbook never reaches the consumer.`,
      });
      continue;
    }
    if (!manifestFn) continue;
    let declared;
    try {
      declared = manifestFn(name) === true;
    } catch {
      continue;
    }
    if (!declared) {
      findings.push({
        rule_id: "command-skill-parity/dangling-skill-reference",
        severity: "advisory",
        evidence:
          `\`${sanitize(c.filePath)}\` references \`skills/${name}\`, which exists on disk but ` +
          `is declared NOWHERE in sync-manifest.yaml (no tier, no loom_only). ` +
          `command-skill-parity.md MUST-3 + knowledge-cascade-routing.md MUST-2: it never ` +
          `cascades, so the consumer receives the reference without the runbook.`,
      });
    }
  }

  // ── ARM 1 — co-change. Requires a computable BEFORE, which only an Edit-shaped
  // payload carries; see § SCOPE OF SILENCE.
  const hasPrior = typeof c.oldText === "string" && c.oldText.length > 0;
  if (!hasPrior) return findings;

  const changed = declaredSurfaceChange(c.oldText, c.newText);
  if (changed.length === 0) return findings; // prose-only edit ⇒ silent.

  // WITHDRAW when the command has no pair at all. Only a referenced skill that
  // EXISTS counts as a pair — a dangling one is ARM 2's finding, and charging
  // the same edit twice for the same defect is noise.
  const pairs = existsFn
    ? referenced.filter((n) => {
        try {
          return existsFn(n) === true;
        } catch {
          return false;
        }
      })
    : referenced;
  if (pairs.length === 0) return findings;

  const edited = Array.isArray(c.sessionEditedSkills) ? c.sessionEditedSkills : [];
  if (pairs.some((n) => edited.includes(n))) return findings; // pair moved together.

  findings.push({
    rule_id: "command-skill-parity/command-edit-without-paired-skill-edit",
    severity: "advisory",
    evidence:
      `\`${sanitize(c.filePath)}\` changed a DECLARED step/flag (${sanitize(changed.join(", "))}) ` +
      `but no paired skill was edited in this session. Pairs referenced by this command: ` +
      `${pairs.map((n) => "skills/" + n).join(", ")}. command-skill-parity.md MUST-2 — an edit to ` +
      `either side re-derives the other in the SAME codify. NOTE: if the paired-skill edit is ` +
      `still to come in this session, this finding is PREMATURE, not wrong.`,
  });

  return findings;
}

module.exports = {
  COMMAND_DIR_SEGMENT,
  EVIDENCE_MAX,
  declaredSurfaceChange,
  extractSkillReferences,
  flagTokens,
  inspectCommandWrite,
  isCommandPath,
  skillNameOf,
  stepTokens,
  symmetricDifference,
};
