#!/usr/bin/env node
/**
 * codify-self-referential — fixture runner for `.claude/hooks/codify-self-referential-guard.js`
 * and `.claude/hooks/lib/codify-self-referential.js`, the Phase-2 detector for
 * `self-referential-codify.md` Rule 1.
 *
 *   node .claude/audit-fixtures/codify-self-referential/run.mjs
 *   echo $?      # 0 = all green
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red the suite against a mutant
 *
 * ## WHAT EACH BLOCK IS FOR — every case names its falsifying result
 *
 * A — THE TRICHOTOMY, driven END-TO-END against the REAL rule file. The pair that matters is
 *     A1/A2: `.claude/rules/trust-posture.md` is ON the Rule-2 allowlist and MUST fire;
 *     `.claude/rules/zero-tolerance.md` sits under the SAME `.claude/rules/**` `paths:` glob, is
 *     DELIBERATELY off the allowlist (the rule says so in its own prose), and MUST stay silent.
 *     A detector that conflates the load-trigger SUPERSET with the firing SUBSET passes A1 and
 *     fails A2 — which is why A2 is the load-bearing pole, not A1.
 *
 * D — DERIVATION LIVENESS. This is what separates a live derivation from a hardcoded list, and it
 *     is driven through the HOOK, not asserted of the module. Each case mutates the AUTHORITY
 *     SURFACE — the rule file's own allowlist — and requires the hook's verdict to MOVE with it:
 *     D1 removes a real entry and the fire must stop; D2 adds a path that exists in no corpus and
 *     the fire must start. A module holding a baked-in copy of the 220-entry list returns the
 *     IDENTICAL verdict on both halves of both pairs, so it fails D1 and D2 while passing every
 *     case in block A. D3 pins the direction of the failure: the pre-mutation control for D2 is
 *     taken in the SAME temp repo, so "it fired" cannot be explained by the path being allowlisted
 *     all along.
 *
 * E — ENVELOPE. Tool axis, kill switch, containment, dedupe, and the fail-open arms. The fail-open
 *     cases are deliberately paired with a FIRING control in the same repo shape, because "emitted
 *     nothing" is the same observable as a working detector on a compliant path — an unpaired
 *     fail-open case would pass against a hook that does nothing at all.
 *
 * L — LIBRARY PREDICATE. `entryMatches` in isolation, where the end-to-end cases cannot reach: the
 *     basename `*` must not cross a `/`. There is exactly ONE non-`/**` wildcard entry in the live
 *     corpus (`.claude/bin/validate-*.mjs`), so the widening it guards against is one authored
 *     entry away rather than hypothetical.
 *
 * ## STAGING
 *
 * The PARSER is resolved by the lib from its own `__dirname` (real tree); the ALLOWLIST DATA is
 * read from the project dir under edit. That split is what lets these fixtures hand the REAL parser
 * a MUTATED rule and watch the verdict move. Each temp repo therefore carries a copy of the real
 * `self-referential-codify.md` (or a mutation of it) and nothing else from `.claude/`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { makeReporter, mkRepo, driveHook, cleanup } from "../hook-fixture-runner.mjs";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/codify-self-referential-guard.js");
const RULE_REL = ".claude/rules/self-referential-codify.md";
const REAL_RULE = fs.readFileSync(path.join(REPO, RULE_REL), "utf8");

const { check, finish } = makeReporter();

/** A temp repo carrying `ruleText` at the rule's canonical path. */
function stage(label, ruleText) {
  const repoDir = mkRepo(label);
  const p = path.join(repoDir, RULE_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, ruleText);
  return repoDir;
}

/** Drive the hook with a PostToolUse mutation payload for `relPath` inside `repoDir`. */
function drive(repoDir, relPath, opts = {}) {
  const abs = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, "fixture\n");
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: opts.tool || "Edit",
    session_id: opts.session || `fx-${label(repoDir)}-${relPath}`,
    cwd: repoDir,
    tool_input: { file_path: opts.absOverride || abs },
  };
  return driveHook(HOOK, {
    stdinRaw: JSON.stringify(payload),
    cwd: repoDir,
    env: opts.env || {},
    timeout: 30000,
  });
}

function label(d) {
  return path.basename(d).slice(0, 12);
}

/** Did the hook emit the advisory? Tag is the discriminator; `code` is 0 on both arms. */
function fired(r) {
  return r.tag === "[ADVISORY]";
}

// ===========================================================================
// A — the trichotomy, against the REAL allowlist
// ===========================================================================
{
  const repoDir = stage("a-real", REAL_RULE);

  const a1 = drive(repoDir, ".claude/rules/trust-posture.md");
  check(
    "A1 FIRE — `.claude/rules/trust-posture.md` is a named Rule-2 allowlist entry",
    fired(a1) && a1.code === 0,
    `tag=${a1.tag} exit=${a1.code}`,
    "silence here means the detector never fires at all, or the allowlist parse returned nothing — either way the gate is inert while reading as compliant.",
  );

  const a2 = drive(repoDir, ".claude/rules/zero-tolerance.md");
  check(
    "A2 LOAD_ONLY — `.claude/rules/zero-tolerance.md` is under `.claude/rules/**` but NOT allowlisted ⇒ SILENT",
    !fired(a2) && a2.code === 0,
    `tag=${a2.tag} exit=${a2.code}`,
    "firing here means the detector keyed on the `paths:` LOAD-trigger superset instead of the Rule-2 FIRING subset — it would demand a Tier-1 redteam for every rule edit in the repo, which is the conflation the rule spends a paragraph forbidding.",
  );

  check(
    "A1/A2 PAIR — same directory, same tool, same repo; only allowlist membership differs",
    fired(a1) && !fired(a2),
    `trust-posture=${a1.tag} zero-tolerance=${a2.tag}`,
    "identical dispositions = the allowlist test carries no information; the predicate is not discriminating (instrument-discipline.md MUST-1).",
  );

  const a3 = drive(repoDir, "README.md");
  check(
    "A3 OUTSIDE — a path under no `paths:` glob and no allowlist entry ⇒ SILENT",
    !fired(a3),
    `tag=${a3.tag}`,
    "firing on README.md means the path test degenerated to 'any write'.",
  );

  const a4 = drive(repoDir, ".claude/hooks/lib/brand-new-detector.js");
  check(
    "A4 SUBTREE GLOB — a file that exists in no enumeration fires via the `.claude/hooks/**` entry",
    fired(a4),
    `tag=${a4.tag}`,
    "silence means `/**` entries are not expanded, so the entire hooks/bin/fixtures surface is ungated while the named-file entries look covered.",
  );

  const a5 = drive(repoDir, ".claude/bin/validate-emit.mjs");
  check(
    "A5 BASENAME GLOB — `.claude/bin/validate-emit.mjs` fires via the `validate-*.mjs` entry",
    fired(a5),
    `tag=${a5.tag}`,
    "silence means the one non-`/**` wildcard in the live corpus is unhandled, so every validator is ungated.",
  );

  const a6 = drive(repoDir, ".claude/bin/some-unlisted-tool.mjs");
  check(
    "A6 BASENAME-GLOB NEGATIVE — a sibling in the same dir NOT matching `validate-*.mjs` stays SILENT",
    !fired(a6),
    `tag=${a6.tag}`,
    "firing here means the wildcard was widened to the whole directory — A5 would then be passing for the wrong reason.",
  );
}

// ===========================================================================
// D — derivation liveness: mutate the AUTHORITY SURFACE, require the verdict to move
// ===========================================================================
{
  // D1 — REMOVE a real entry from the Rules bullet. Nothing else changes.
  const TARGET = "trust-posture,";
  if (!REAL_RULE.includes(TARGET)) {
    check(
      "D1 PRECONDITION — the Rules brace-set contains `trust-posture,`",
      false,
      "anchor not found in the live rule",
      "the mutation could not be applied, so D1 below would pass vacuously.",
    );
  }
  const withoutEntry = REAL_RULE.replace(TARGET, "");
  const repoFull = stage("d1-full", REAL_RULE);
  const repoMinus = stage("d1-minus", withoutEntry);

  const before = drive(repoFull, ".claude/rules/trust-posture.md");
  const after = drive(repoMinus, ".claude/rules/trust-posture.md");
  check(
    "D1 REMOVAL — the SAME path fires with the entry present and goes SILENT with it removed",
    fired(before) && !fired(after),
    `with-entry=${before.tag} without-entry=${after.tag}`,
    "identical dispositions = the allowlist is NOT read from the rule. A hardcoded copy of the 220-entry list returns the same verdict on both halves, which is precisely the drift this module was built to make impossible.",
  );

  // D2 — ADD a path that appears nowhere in the corpus, to a bullet the parser recognises.
  const NOVEL = ".claude/rules/zzz-fixture-derivation-probe.md";
  const anchor = "- **Management agents:**";
  if (!REAL_RULE.includes(anchor)) {
    check(
      "D2 PRECONDITION — the `Management agents` bullet anchor exists",
      false,
      "anchor not found",
      "the addition could not be applied, so D2 would pass vacuously.",
    );
  }
  const withNovel = REAL_RULE.replace(
    anchor,
    `- **Management agents:** \`${NOVEL}\`\n${anchor}`,
  );
  const repoNovel = stage("d2-novel", withNovel);

  const d3control = drive(repoFull, NOVEL);
  check(
    "D3 CONTROL — the novel path is SILENT against the unmutated rule",
    !fired(d3control),
    `tag=${d3control.tag}`,
    "firing here means the path was already covered, and D2's fire would prove nothing.",
  );

  const d2 = drive(repoNovel, NOVEL);
  check(
    "D2 ADDITION — the same novel path FIRES once it is declared in the rule, with no code change",
    fired(d2) && !fired(d3control),
    `unmutated=${d3control.tag} with-entry-added=${d2.tag}`,
    "silence after the addition = a rule-side allowlist entry does NOT reach the detector, so every future entry lands ungated while the rule claims coverage — the exact five-omission drift the rule's own SUPERSET paragraph records.",
  );

  // D4 — the advisory names the MATCHED ENTRY and the parsed COUNT, so the finding is
  // traceable to the rule text rather than to an opaque internal decision.
  const body = `${before.stdout}${before.stderr}`;
  check(
    "D4 PROVENANCE — the emitted finding names the matched entry and the live entry count",
    body.includes("trust-posture.md") && /\d+ entries parsed/.test(body),
    `matched-entry-named=${body.includes("trust-posture.md")} count-named=${/(\d+) entries parsed/.test(body)}`,
    "a finding that names neither cannot be checked against the rule by its reader, so a mis-derivation would be invisible at review.",
  );
}

// ===========================================================================
// E — envelope
// ===========================================================================
{
  const repoDir = stage("e-env", REAL_RULE);
  const FIRING = ".claude/rules/trust-posture.md";

  const e1 = drive(repoDir, FIRING, { tool: "Read", session: "e1" });
  const e1ctl = drive(repoDir, FIRING, { tool: "Edit", session: "e1ctl" });
  check(
    "E1 TOOL AXIS — `Read` on an allowlisted path is SILENT; `Edit` on the same path FIRES",
    !fired(e1) && fired(e1ctl),
    `Read=${e1.tag} Edit=${e1ctl.tag}`,
    "identical dispositions = the mutation-tool test is dead; a read-only session would be told it owes a redteam round.",
  );

  const e2 = drive(repoDir, FIRING, {
    session: "e2",
    env: { COC_CODIFY_SELFREF: "0" },
  });
  check(
    "E2 KILL SWITCH — `COC_CODIFY_SELFREF=0` silences the same payload that fires at E1ctl",
    !fired(e2) && fired(e1ctl),
    `off=${e2.tag} on=${e1ctl.tag}`,
    "if the switch does not silence it, the documented opt-out does not exist; if the control does not fire, the case proves nothing.",
  );

  const e3 = drive(repoDir, FIRING, {
    session: "e3",
    absOverride: path.join(REPO, ".claude/rules/trust-posture.md"),
  });
  check(
    "E3 CONTAINMENT — an allowlisted path OUTSIDE the payload's repo is SILENT",
    !fired(e3),
    `tag=${e3.tag}`,
    "firing means the hook classifies files belonging to another tree against this repo's allowlist — a cross-repo verdict wearing an in-repo grammar.",
  );

  const e4a = drive(repoDir, FIRING, { session: "e4-same" });
  const e4b = drive(repoDir, FIRING, { session: "e4-same" });
  const e4c = drive(repoDir, FIRING, { session: "e4-other" });
  check(
    "E4 DEDUPE — second identical edit in the SAME session is silent; a DIFFERENT session fires again",
    fired(e4a) && !fired(e4b) && fired(e4c),
    `first=${e4a.tag} repeat=${e4b.tag} other-session=${e4c.tag}`,
    "no suppression = one advisory per keystroke and the orchestrator learns to skim; suppression across sessions = a later session never hears about the surface it is editing.",
  );
}

{
  // E5 — FAIL-OPEN arms, each PAIRED with a firing control in the same shape so that
  // "emitted nothing" cannot be satisfied by a hook that does nothing at all.
  const noRule = mkRepo("e5-norule"); // staged WITHOUT the rule file
  const e5 = drive(noRule, ".claude/rules/trust-posture.md", { session: "e5" });
  const withRule = stage("e5-ctl", REAL_RULE);
  const e5ctl = drive(withRule, ".claude/rules/trust-posture.md", { session: "e5ctl" });
  check(
    "E5 FAIL-OPEN (absent rule) — silent with no rule file, FIRES with one; exit 0 on both",
    !fired(e5) && e5.code === 0 && fired(e5ctl),
    `no-rule=${e5.tag}/exit=${e5.code} with-rule=${e5ctl.tag}`,
    "a non-zero exit or a crash here would turn an unreadable allowlist into a broken tool boundary (cc-artifacts.md Rule 7); a silent control would mean the case is passing because nothing ever fires.",
  );

  // E6 — a rule whose category bullets the authority does not recognise parses to ZERO entries.
  // The module treats that as NOT-OK rather than as an empty set, so an allowlisted path goes
  // silent (fail-open) instead of being reclassified LOAD_ONLY behind a confident verdict.
  const gutted = REAL_RULE.replace(/^- \*\*(Commands|Skills|Rules|Hooks|Data|Bin|Tools|Codex|Audit|Management|Rule-depth|Eval-harness)/gm, "- **Zzz");
  const repoGutted = stage("e6-gutted", gutted);
  const e6 = drive(repoGutted, ".claude/rules/trust-posture.md", { session: "e6" });
  check(
    "E6 ZERO-PARSE — an unparseable allowlist fails OPEN and exits 0, it does not crash the boundary",
    !fired(e6) && e6.code === 0,
    `tag=${e6.tag} exit=${e6.code}`,
    "a crash here converts a rule-format change into a broken Edit/Write boundary for the whole session.",
  );
}

// ===========================================================================
// L — library predicate, where the end-to-end cases cannot reach
// ===========================================================================
{
  const lib = require_(path.join(REPO, ".claude/hooks/lib/codify-self-referential.js"));

  check(
    "L1 BASENAME `*` DOES NOT CROSS `/` — `.claude/bin/validate-*.mjs` must not match a nested path",
    lib.entryMatches(".claude/bin/validate-*.mjs", ".claude/bin/validate-emit.mjs") === true &&
      lib.entryMatches(".claude/bin/validate-*.mjs", ".claude/bin/sub/validate-emit.mjs") === false,
    `flat=${lib.entryMatches(".claude/bin/validate-*.mjs", ".claude/bin/validate-emit.mjs")} nested=${lib.entryMatches(".claude/bin/validate-*.mjs", ".claude/bin/sub/validate-emit.mjs")}`,
    "a `*` compiled to `.*` silently widens one entry into a whole subtree, firing the Tier-1 gate on files the rule never allowlisted.",
  );

  check(
    "L2 `/**` COVERS THE DIRECTORY ITSELF AND ITS CHILDREN, AND NOTHING ELSE",
    lib.entryMatches(".claude/hooks/**", ".claude/hooks") === true &&
      lib.entryMatches(".claude/hooks/**", ".claude/hooks/lib/x.js") === true &&
      lib.entryMatches(".claude/hooks/**", ".claude/hooks-extra/x.js") === false,
    `dir=${lib.entryMatches(".claude/hooks/**", ".claude/hooks")} child=${lib.entryMatches(".claude/hooks/**", ".claude/hooks/lib/x.js")} sibling-prefix=${lib.entryMatches(".claude/hooks/**", ".claude/hooks-extra/x.js")}`,
    "a bare `startsWith(prefix)` matches `.claude/hooks-extra/`, gating a directory the rule never named.",
  );

  check(
    "L3 CLASSIFY ORDER — an allowlisted path that ALSO sits under a `paths:` glob reports FIRE, not LOAD_ONLY",
    lib.classifyPath(".claude/rules/trust-posture.md", {
      entries: [".claude/rules/trust-posture.md"],
      globs: [".claude/rules/**"],
    }).verdict === "FIRE" &&
      lib.classifyPath(".claude/rules/zero-tolerance.md", {
        entries: [".claude/rules/trust-posture.md"],
        globs: [".claude/rules/**"],
      }).verdict === "LOAD_ONLY",
    "order pinned",
    "testing the glob first reports LOAD_ONLY for the ENTIRE firing set — the trichotomy inverted, and every gate silently off.",
  );
}

// ===========================================================================
// V — PER-SURFACE DEDUPE. The scope of the gate is correct-by-derivation (block A proves the
//     trichotomy); what this block pins is its VOLUME. 16 of the 220 entries are subtree globs,
//     and between them they cover 5,533 of the 5,657 firing files in this repo (MEASURED). Keyed
//     per-PATH, a codify touching an allowlisted subtree emits one advisory per FILE — 4,843 for
//     `.claude/audit-fixtures/**` alone — each asking the identical question, because the Rule-1
//     obligation is one Tier verdict PER CODIFY, not per file. That is the shape the guard's own
//     header warns produces "a detector the orchestrator learns to skim".
//
//     Keyed per-(session, matched ENTRY), the same session emits one advisory per governing
//     SURFACE. V1/V2 are the bipolar pair: identical session, identical tool, two edits, separating
//     ONLY on whether the second path is covered by the SAME allowlist entry as the first. V3 is
//     the no-regression pole — for the 203 EXACT entries, entry and path are 1:1, so the key change
//     must be observationally IDENTICAL there (MEASURED: 124 firing exact-entry files, 124 distinct
//     advisories before and after).
// ===========================================================================
{
  const repoDir = stage("v-dedupe", REAL_RULE);

  // Both paths are covered by the SAME entry, `.claude/hooks/**` (neither is enumerated by name).
  const v1a = drive(repoDir, ".claude/hooks/lib/alpha-detector.js", { session: "v1" });
  const v1b = drive(repoDir, ".claude/hooks/lib/beta-detector.js", { session: "v1" });
  check(
    "V1 SURFACE DEDUPE — a SECOND file under the SAME allowlist entry, same session, is SILENT",
    fired(v1a) && !fired(v1b),
    `first=${v1a.tag} same-entry-second=${v1b.tag}`,
    "firing again means the advisory is keyed per FILE, so a codify touching an allowlisted subtree repeats one identical Tier-1 question thousands of times; the Rule-1 obligation is per CODIFY, and a finding restated per keystroke is one the orchestrator stops reading.",
  );

  // The suppression must be SCOPED to the entry. A different entry in the same session still fires.
  const v2 = drive(repoDir, ".claude/rules/trust-posture.md", { session: "v1" });
  check(
    "V2 SCOPE CONTROL — a path under a DIFFERENT entry, SAME session, still FIRES",
    fired(v2),
    `other-entry=${v2.tag}`,
    "silence here means the dedupe collapsed to one-advisory-per-session and the orchestrator never hears about the second, distinct governing surface it edited — a fix that bought quiet by dropping signal.",
  );

  // 203 of 220 entries are exact paths, where entry and path are 1:1. The key change must not
  // alter their behaviour at all.
  const v3a = drive(repoDir, ".claude/rules/cc-artifacts.md", { session: "v3" });
  const v3b = drive(repoDir, ".claude/commands/codify.md", { session: "v3" });
  check(
    "V3 EXACT ENTRIES UNCHANGED — two distinct exact-entry paths, same session, BOTH fire",
    fired(v3a) && fired(v3b),
    `cc-artifacts=${v3a.tag} codify=${v3b.tag}`,
    "suppression here would mean the key change silently narrowed the 203 exact entries too, losing a real finding on a distinct governing artifact to buy volume on the 16 glob entries.",
  );
}

cleanup();
finish();
