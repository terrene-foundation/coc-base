/**
 * codify-self-referential — the derivation + classification core for
 * `self-referential-codify.md` Rule 1's gate.
 *
 * The rule declares a POSITIVE ALLOWLIST (Rule 2) of loom-side artifacts that govern
 * codification itself. A `/codify` whose proposal touches ANY of them is SELF-REFERENTIAL and owes
 * the depth-tiered redteam gate of Rule 1 regardless of trust posture. Until this module landed,
 * `Detection (Phase 2)` in that rule's Trust-Posture Wiring named a `codify-self-referential.js`
 * that did not exist, and the row in `phase2-deferrals.json` said why it was still open: *"Its own
 * allowlist match is mechanically checkable, so unlike most entries here this one has a clear
 * structural path and is deferred only for want of the hook."* This is that hook's core.
 *
 * ## THE ALLOWLIST IS DERIVED, NEVER RESTATED — and that is the whole design constraint
 *
 * `self-referential-codify.md` spends a paragraph on exactly this failure, having lived it: a PROSE
 * RESTATEMENT of its `paths:` glob list stood for months while silently omitting five entries,
 * "because every glob addition had to remember to update a second, non-load-bearing surface."
 * A hardcoded copy of the 220-entry named-file allowlist inside THIS module would be the same
 * defect one layer down, and a worse one — a rule-side addition would leave the detector quietly
 * blind to the file it was added to cover, and the detector's silence reads as compliance.
 *
 * So this module holds NO list. It imports `parseSelfRefAllowlist` and `parsePathsFrontmatter`
 * from `.claude/bin/validate-emit.mjs` — the SAME parser the `allowlist-paths-coverage` check
 * (#443) already runs at `/sync` — and applies them to the rule file's own text at call time. Two
 * consequences are load-bearing and both are pinned by fixtures:
 *
 *   - an entry ADDED to the rule fires this detector on the next edit, with no change here;
 *   - an entry REMOVED from the rule stops firing it, with no change here.
 *
 * If either stops being true, the derivation has been replaced by a copy. `run.mjs` case D1/D2
 * drive both directions END-TO-END through the hook rather than asserting them of this module.
 *
 * ## WHAT IS DERIVED AND WHAT IS AUTHORED HERE, stated so the boundary is reviewable
 *
 * DERIVED from the authority: the allowlist ENTRY SET, and the `paths:` GLOB SET.
 * AUTHORED here: `entryMatches` — the predicate deciding whether one entry covers one path.
 * `validate-emit.mjs` exports `allowlistGlobCovers`, but it answers a DIFFERENT question (does a
 * `paths:` GLOB cover an allowlist ENTRY) and its own comment says a `*` in a basename "is
 * irrelevant" to it. Reading it for this question would be `instrument-discipline.md` MUST-4 —
 * a sound instrument re-read for a second proposition. The corpus contains exactly one entry whose
 * wildcard is NOT a trailing `/**` (`.claude/bin/validate-*.mjs`, MEASURED on this tree), and it
 * is pinned by a fixture, so the third form below is live rather than speculative.
 *
 * ## TRICHOTOMY, not a boolean — the SUPERSET/SUBSET distinction is the thing to get right
 *
 * The rule's `paths:` frontmatter is the LOAD-trigger SUPERSET; the Rule-2 allowlist is the FIRING
 * SUBSET. A detector conflating them fires on every `.claude/rules/**` edit and is wrong: the rule
 * itself records `zero-tolerance.md` and `security.md` as DELIBERATELY off the allowlist while
 * sitting squarely under the `.claude/rules/**` load glob. So:
 *
 *   FIRE       on the named-file allowlist            → the Rule-1 gate applies
 *   LOAD_ONLY  under a `paths:` glob, NOT allowlisted → rule loads, gate does not fire; silent
 *   OUTSIDE    neither                                → silent
 *
 * LOAD_ONLY is a distinct verdict in the data rather than folded into OUTSIDE, because it is the
 * pole a fixture has to be able to name to show the predicate discriminates at all.
 *
 * ## SEVERITY CEILING
 *
 * `advisory`, and the rule itself already says so — its `**Severity:**` bullet reads "`advisory` at
 * hook layer" and cites `hook-output-discipline.md` MUST-2. The path membership IS structural (set
 * membership over a parsed document, not a regex over prose), but the PROPOSITION — "this edit is
 * part of a `/codify` that owes the Tier gate" — is not decidable from a tool call: the same edit
 * shape occurs in an ordinary implementation session. Firing `advisory` on the structural half and
 * leaving the codify-context judgment to the orchestrator is the honest split. It is also why the
 * finding is phrased conditionally at `formatAdvisory` rather than as an assertion that a `/codify`
 * is under way.
 *
 * NEVER THROWS. Every entry point returns a typed result (`zero-tolerance.md` Rule 3); the caller
 * fails open on any non-`ok` shape (`cc-artifacts.md` Rule 7).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

/**
 * The authority module, resolved relative to THIS FILE rather than to the project dir.
 *
 * The PARSER is code that ships in the same `.claude/` tree as this hook; the ALLOWLIST is DATA
 * read out of the tree under edit. In production those are the same tree and the distinction is
 * invisible. It is drawn deliberately anyway, for two reasons: a fixture can then hand the real
 * parser a MUTATED rule file and watch the verdict move (which is the only way to demonstrate the
 * derivation is live), and a session editing a checkout whose `validate-emit.mjs` is mid-rewrite
 * still classifies against a parser that loads.
 *
 * A consumer repo that receives this hook without `.claude/bin/validate-emit.mjs` gets a silent
 * fail-open, NOT a wrong answer — `loadAuthority` returns `{ok:false}` and the hook emits nothing.
 */
const AUTHORITY_REL = path.join("..", "..", "bin", "validate-emit.mjs");

/** Rule file holding the allowlist, relative to the project dir. */
const RULE_REL = path.join(".claude", "rules", "self-referential-codify.md");

/** Hard cap on the rule read. The file is ~60 kB; anything past this is not the rule. */
const MAX_RULE_BYTES = 1024 * 1024;

/**
 * Import the authority and hand back the two parsers.
 *
 * MEASURED COST, stated rather than hidden: 34 / 39 / 38 ms across three FRESH node processes on
 * this tree (Node 25), which is the shape a hook actually pays — a one-off 110 ms was measured on
 * the first cold read and is NOT the recurring figure. The cost is non-zero because
 * `validate-emit.mjs` eagerly imports `emit-coc.mjs`, `emit-cli-artifacts.mjs` and
 * `reconcile-settings-deny.mjs`. The caller pays it only after it already has a mutation-tool
 * payload with a file path, and it sits inside the hook's own 4 s bound under a 5 s registration.
 * The alternative — a cheaper private parser — is exactly the second surface this module refuses
 * to create.
 *
 * @param {{authorityPath?: string}} [opts]
 * @returns {Promise<{ok: boolean, authorityPath: string, parseSelfRefAllowlist?: Function,
 *                    parsePathsFrontmatter?: Function, error?: string}>}
 */
async function loadAuthority(opts) {
  const authorityPath =
    (opts && opts.authorityPath) || path.resolve(__dirname, AUTHORITY_REL);
  try {
    const mod = await import(pathToFileURL(authorityPath).href);
    if (
      typeof mod.parseSelfRefAllowlist !== "function" ||
      typeof mod.parsePathsFrontmatter !== "function"
    ) {
      return {
        ok: false,
        authorityPath,
        error:
          "authority does not export parseSelfRefAllowlist/parsePathsFrontmatter",
      };
    }
    return {
      ok: true,
      authorityPath,
      parseSelfRefAllowlist: mod.parseSelfRefAllowlist,
      parsePathsFrontmatter: mod.parsePathsFrontmatter,
    };
  } catch (e) {
    return {
      ok: false,
      authorityPath,
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * Read the rule file out of `projectDir`. Refuses a symlinked rule path: the allowlist decides
 * which edits get an extra review round, so a swapped rule is a way to make the gate go quiet.
 * Refusal is fail-OPEN (no finding), never a wrong finding.
 *
 * @returns {{ok: boolean, rulePath: string, text?: string, error?: string}}
 */
function readRuleText(projectDir, opts) {
  const rulePath = (opts && opts.rulePath) || path.join(projectDir, RULE_REL);
  try {
    const st = fs.lstatSync(rulePath);
    if (st.isSymbolicLink())
      return { ok: false, rulePath, error: "rule path is a symlink" };
    if (!st.isFile())
      return { ok: false, rulePath, error: "rule path is not a regular file" };
    if (st.size > MAX_RULE_BYTES)
      return { ok: false, rulePath, error: "rule file over cap" };
    return { ok: true, rulePath, text: fs.readFileSync(rulePath, "utf8") };
  } catch (e) {
    return {
      ok: false,
      rulePath,
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * Derive the two surfaces from one rule text, through the authority's parsers.
 *
 * A ZERO-length allowlist is `ok:false`, not an empty set. The parser returns `[]` for a rule whose
 * category bullets it did not recognise — the exact `Rule-depth` / `Eval-harness` class its own
 * maintenance comment records — and an empty set would silently reclassify every allowlisted path
 * as LOAD_ONLY. A detector that goes quiet when its input stops parsing is the fail-open that reads
 * as compliance, so the emptiness is named instead.
 *
 * @returns {{ok: boolean, entries?: string[], globs?: string[], error?: string}}
 */
function deriveSurface(ruleText, authority) {
  try {
    const entries = authority.parseSelfRefAllowlist(ruleText);
    const globs = authority.parsePathsFrontmatter(ruleText);
    if (!Array.isArray(entries) || entries.length === 0) {
      return {
        ok: false,
        error: "authority parsed 0 allowlist entries from the rule text",
      };
    }
    return { ok: true, entries, globs: Array.isArray(globs) ? globs : [] };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Does one allowlist ENTRY cover `relPath`? Three forms, and only three, because the corpus has
 * only three (MEASURED on this tree: 220 entries — 203 exact, 16 trailing `/**`, 1 basename `*`):
 *
 *   exact            `.claude/commands/codify.md`
 *   subtree glob     `.claude/hooks/**`          → the dir itself, or anything beneath it
 *   basename glob    `.claude/bin/validate-*.mjs` → same directory only, `*` never crosses a `/`
 *
 * The basename form is deliberately NOT a general glob engine. `*` is expanded to `[^/]*` so it
 * cannot swallow a separator and silently widen the firing scope to a subtree the rule never
 * allowlisted; every other regex metacharacter in the entry is escaped.
 */
function entryMatches(entry, relPath) {
  if (typeof entry !== "string" || typeof relPath !== "string") return false;
  if (entry === relPath) return true;
  if (entry.endsWith("/**")) {
    const prefix = entry.slice(0, -3);
    return relPath === prefix || relPath.startsWith(prefix + "/");
  }
  if (entry.includes("*")) {
    const rx = new RegExp(
      "^" +
        entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") +
        "$",
    );
    return rx.test(relPath);
  }
  return false;
}

/** Does a `paths:` frontmatter glob cover `relPath`? Exact or `/**` prefix — the forms the rule uses. */
function globMatches(glob, relPath) {
  if (typeof glob !== "string" || typeof relPath !== "string") return false;
  if (glob === relPath) return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return relPath === prefix || relPath.startsWith(prefix + "/");
  }
  return false;
}

/**
 * FIRE / LOAD_ONLY / OUTSIDE for one repo-relative path.
 *
 * Order is load-bearing: the allowlist is tested FIRST, so an allowlisted path that also sits under
 * a load glob (almost all of them do) reports FIRE. Testing the glob first would report LOAD_ONLY
 * for the entire firing set — the conflation this trichotomy exists to prevent, inverted.
 */
function classifyPath(relPath, surface) {
  const matchedEntry = (surface.entries || []).find((e) =>
    entryMatches(e, relPath),
  );
  if (matchedEntry) return { verdict: "FIRE", matchedEntry, matchedGlob: null };
  const matchedGlob = (surface.globs || []).find((g) =>
    globMatches(g, relPath),
  );
  if (matchedGlob)
    return { verdict: "LOAD_ONLY", matchedEntry: null, matchedGlob };
  return { verdict: "OUTSIDE", matchedEntry: null, matchedGlob: null };
}

/**
 * Absolute (or already-relative) tool path → repo-relative POSIX path, or null when the path is
 * outside `projectDir`.
 *
 * Both sides go through `realpathSync` before the containment test, per `security.md` § Path
 * Containment — a lexically-contained symlink whose target escapes the tree would otherwise be
 * classified against an allowlist that does not govern it. Resolution failure on the CANDIDATE
 * falls back to the lexical form (at `PostToolUse` the file normally exists, but a write that was
 * immediately moved should still classify rather than vanish); failure on the ROOT returns null,
 * because a boundary that would not resolve cannot contain anything.
 */
function toRelPath(filePath, projectDir) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  let root;
  try {
    root = fs.realpathSync(projectDir);
  } catch {
    return null;
  }
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  let cand;
  try {
    cand = fs.realpathSync(abs);
  } catch {
    cand = path.resolve(abs);
  }
  const rel = path.relative(root, cand);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * Per-(session, matched ENTRY) dedupe key — the GOVERNING SURFACE, not the file.
 *
 * The key is the matched entry ALONE, deliberately, and the path is deliberately NOT in it. What
 * Rule 1 asks for is ONE Tier verdict and one redteam dispatch PER CODIFY; the advisory's whole
 * actionable content is identical for every file a single entry covers, because the Tier verdict is
 * a property of the DIFF, not of any one file in it. Keying per-path restated that one question
 * once per file, and the corpus makes that concrete: 16 of the 220 entries are subtree globs, and
 * between them they cover 5,533 of the 5,657 firing files in this repo — `.claude/audit-fixtures/**`
 * alone covers 4,843 (MEASURED on this tree). A codify sweeping a fixture directory paid thousands
 * of identical advisories, which is precisely the "detector the orchestrator learns to skim" this
 * module's own header warns against — and the volume was read as over-firing SCOPE, which it never
 * was: block A pins the scope as correct-by-derivation.
 *
 * FOR THE 203 EXACT ENTRIES THIS CHANGES NOTHING, and that is the point of its shape rather than a
 * happy accident: entry and path are 1:1 there, so the key is the same key under a different
 * spelling (MEASURED: 124 firing exact-entry files → 124 distinct advisories, before and after).
 * The entire reduction — 5,533 → 16 — falls on the glob entries that caused the volume.
 *
 * The derivation-liveness property the previous key was built around is PRESERVED: a mid-session
 * allowlist edit that changes WHICH entry covers a file still changes this key, so the finding
 * re-surfaces rather than being suppressed as a duplicate. Fixtures V1/V2/V3 pin the three poles —
 * same entry suppresses, DIFFERENT entry still fires, exact entries unchanged.
 */
function signatureOf(result) {
  return `SELFREF:${result.matchedEntry}`;
}

/**
 * The advisory body. Phrased CONDITIONALLY ("if this edit is part of a `/codify`") because the
 * structural half — allowlist membership — is all this hook can see; whether a codify is under way
 * is the orchestrator's to answer. Over-stating it would make the finding wrong in every ordinary
 * implementation session that touches a governing artifact, and a detector that is routinely wrong
 * is one the orchestrator learns to skim.
 */
function formatAdvisory(result) {
  return (
    `\`${result.relPath}\` is on the self-referential surface allowlist ` +
    `(\`self-referential-codify.md\` Rule 2; matched entry \`${result.matchedEntry}\`, ` +
    `derived live from ${result.entryCount} entries parsed out of that rule).\n\n` +
    `If this edit is part of a \`/codify\`, that codify is SELF-REFERENTIAL: Rule 1 sets its ` +
    `redteam DEPTH by the diff's enforcement-class, NOT by trust posture. An enforcement-bearing ` +
    `diff (hook, \`.claude/bin/\` script, validator, audit fixture, management agent, or any ` +
    `MUST / MUST NOT / BLOCKED-corpus, detector-matcher, allowlist or trust-posture-trigger-key ` +
    `delta) owes the FULL multi-agent parallel redteam before merge, EVEN AT L5_DELEGATED where ` +
    `the posture default would be mechanical-sweeps-only. Only an UNAMBIGUOUSLY prose-only, ` +
    `non-enforcement diff drops to the Tier-2 single cc-architect pass; anything not unambiguously ` +
    `prose-only defaults to Tier 1.\n\n` +
    `If this edit is NOT part of a \`/codify\`, say so and proceed — no gate is owed.`
  );
}

module.exports = {
  loadAuthority,
  readRuleText,
  deriveSurface,
  entryMatches,
  globMatches,
  classifyPath,
  toRelPath,
  signatureOf,
  formatAdvisory,
  AUTHORITY_REL,
  RULE_REL,
};
