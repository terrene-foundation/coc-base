/**
 * rule-governance-surface — a rule's governance surface is the rule file
 * UNION its wiring sibling.
 *
 * WHY THIS EXISTS. Claude Code injects every `.md` under `.claude/rules/`
 * recursively, at launch, for every session. Governance bookkeeping — the
 * Trust-Posture Wiring fields, the rule-graph cross-references, the Origin
 * record — is read by gate-review and by the validators; it is not an
 * instruction an agent acts on mid-turn, so every session was paying for text
 * it never acts on. That bookkeeping now lives at
 * `.claude/rules/wiring/<base>.md`, a SIBLING of the rule.
 *
 * THE FAILURE THIS MODULE PREVENTS, MEASURED rather than argued. Splitting
 * `conservation-gate.md` moved it out of `detection-binding-check.mjs`'s
 * wired population and into its `no-wiring` bucket — 32 rules to 33 — while
 * BOTH runs reported `VALID (score 100)`. The rule's Detection block, its
 * probe binding and its fixture paths left a CRITICAL-bearing scanner's view
 * and nothing went red. A validator that reads only the rule file is, after
 * the split, a NON-DISCRIMINATING instrument for every governance question:
 * it returns the same green whether the Wiring is correct, absent, or
 * relocated (`instrument-discipline.md` MUST-1 / MUST-3(a)).
 *
 * THE JOIN ORDER IS LOAD-BEARING. The sibling is appended AFTER the rule
 * body, never prepended, so every byte offset into the rule body is
 * BYTE-IDENTICAL to what a plain `readFileSync` of the rule would have
 * produced. Call sites that already computed `text.indexOf(q)` and compared
 * it against `wiringSections(text)` spans keep working unchanged; only the
 * previously-absent wiring region is new. Prepending would silently shift
 * every existing offset, which is the kind of change that passes its tests
 * and corrupts every span comparison in the corpus.
 *
 * POSITION REPORTING. A joined blob makes `relPath:line` arithmetic wrong for
 * any hit in the wiring region — the line number runs past the rule file's
 * end while still being attributed to the rule. `locateInSurface` maps an
 * index back to the (path, line) that actually holds it, so a diagnostic
 * names a file a reader can open.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { realpathForContainment, isWithinRoot } from "./path-containment.mjs";

/**
 * Where a rule's governance sibling lives, relative to the `.claude` directory.
 *
 * NOT under `.claude/rules/`, and that is the whole point. Claude Code injects
 * every `.md` under `.claude/rules/` RECURSIVELY at launch, so a sibling there
 * is still paid for in every session — the saving would be contingent on a
 * `claudeMdExcludes` glob that is per-operator, unversioned, and was in fact
 * absent. MEASURED at the pilot: rule 6,665 B + sibling 9,884 B = 16,549 B
 * against a pre-split 14,153 B, a +2,396 B REGRESSION, while
 * `check-rule-injection-budget.mjs` (non-recursive until 2026-09-25) reported it as a
 * 7,488 B saving — an error of exactly the sibling's size, in the optimistic
 * direction.
 *
 * The skills tree is NOT launch-injected, so the saving here is STRUCTURAL
 * rather than configuration-dependent, and `skills/32-trust-posture/**` is
 * already both a distribution tier and a self-referential-allowlist entry —
 * so the sibling SHIPS (consumers keep their Wiring and the pointer resolves)
 * and edits to it still fire the Tier-1 gate.
 */
export const WIRING_SUBPATH = join("skills", "32-trust-posture", "wiring");

/**
 * The wiring sibling for a rule path, or null when the path cannot have one.
 *
 * Returns null for a path ALREADY inside a wiring directory. That guard is not
 * defensive padding: without it a surface read would recurse one level and
 * concatenate a file to itself, which reports as a duplicate-quote error at
 * `bindQuote` rather than as the loop it is.
 *
 * @param {string} ruleAbsPath absolute path to a rule `.md`
 * @returns {string|null}
 */
export function wiringSiblingPathFor(ruleAbsPath) {
  if (typeof ruleAbsPath !== "string" || !ruleAbsPath.endsWith(".md")) return null;
  const dir = dirname(ruleAbsPath);
  // Only a CANON rule directly under `<root>/.claude/rules/` has a sibling.
  // Keying on the RULE directory rather than on the wiring directory also
  // retires the case-sensitivity hazard in the old guard: it compared a
  // basename to "wiring" with `===` on a filesystem (APFS) that does not
  // compare names that way, so a `Wiring/` directory slipped past it.
  if (basename(dir) !== "rules") return null;
  const claudeDir = dirname(dir);
  if (basename(claudeDir) !== ".claude") return null;
  return join(claudeDir, WIRING_SUBPATH, basename(ruleAbsPath));
}

/**
 * Is a resolved sibling path genuinely inside the wiring tree?
 *
 * The containment decision is taken on the REAL path, never the lexical one.
 * MEASURED before this fix: a `wiring -> .` symlink made the old lexical guard
 * return a path that read the rule back into its own surface
 * (`SELF-CONCAT = true`), which `bindQuote` would then report as a duplicate
 * quote rather than as the loop it is. `security.md` § Path Containment names
 * the lexical form as its DO-NOT and requires BOTH candidate and boundary root
 * through the SAME resolver; that is what this does.
 *
 * @param {string} candidate resolved sibling path
 * @param {string} claudeDir the `.claude` directory the rule lives under
 * @returns {boolean}
 */
export function wiringPathIsContained(candidate, claudeDir) {
  const root = realpathForContainment(join(claudeDir, WIRING_SUBPATH));
  const real = realpathForContainment(candidate);
  if (!root || !real) return false; // fail CLOSED when either will not resolve
  return isWithinRoot(real, root);
}
/**
 * Read a rule's full governance surface.
 *
 * The return is ALWAYS defined for a readable rule, and `parts` always holds
 * at least the rule itself, so a caller never has to distinguish "split rule"
 * from "unsplit rule" — that is the whole point of routing every reader
 * through one function rather than teaching ten of them about a directory.
 *
 * A rule that cannot be read returns `null` text, preserving the existing
 * `text === null` contract every call site already branches on.
 *
 * @param {string} ruleAbsPath
 * @param {(p:string)=>string} [readFile] injectable for tests
 * @returns {{text: string|null, parts: {path:string,start:number,end:number}[], wiringPath: string|null, hasWiring: boolean}}
 */
export function readGovernanceSurface(ruleAbsPath, readFile) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  let ruleText = null;
  try {
    ruleText = read(ruleAbsPath);
  } catch {
    return { text: null, parts: [], wiringPath: null, hasWiring: false };
  }

  const wiringPath = wiringSiblingPathFor(ruleAbsPath);
  let wiringText = null;
  if (wiringPath) {
    // Containment on the REAL path, before the read. A sibling that resolves
    // OUTSIDE the wiring tree is refused rather than unioned: reading it would
    // fold out-of-tree content into a governance surface whose snippets are
    // echoed into diagnostics.
    if (!wiringPathIsContained(wiringPath, dirname(dirname(ruleAbsPath)))) {
      return {
        text: null,
        parts: [],
        wiringPath,
        hasWiring: false,
        error: `wiring sibling resolves outside the wiring tree: ${wiringPath}`,
      };
    }
    try {
      wiringText = read(wiringPath);
    } catch (e) {
      // ENOENT is the NORMAL case — most rules are unsplit and have no sibling.
      // EVERY OTHER ERROR FAILS CLOSED, and that distinction is the whole point.
      //
      // A blanket catch returns `hasWiring: false`, which is BYTE-IDENTICAL to
      // "this rule was never split" — so an EACCES, EISDIR, ELOOP, EIO, a
      // truncated checkout or a case-mismatched filename would be silently
      // indistinguishable from the ordinary case, and no caller could tell.
      // That re-creates the exact non-discriminating instrument this module
      // exists to remove (`instrument-discipline.md` MUST-1) and reports an
      // empty outcome in the grammar of a successful one
      // (`conservation-gate.md` MUST-4).
      //
      // MEASURED, not argued: with the sibling present and chmod 000,
      // `detection-binding-check`'s no-wiring bucket went 32 -> 33 and the run
      // still printed `VALID (score 100)` — the same false green the split
      // itself produced. Surfacing it as an unreadable SURFACE routes it into
      // the `text === null` contract every call site already branches on.
      if (e && e.code === "ENOENT") {
        wiringText = null;
      } else {
        return {
          text: null,
          parts: [],
          wiringPath,
          hasWiring: false,
          error: `wiring sibling present but unreadable: ${wiringPath} (${e && e.code ? e.code : e})`,
        };
      }
    }
  }

  const parts = [{ path: ruleAbsPath, start: 0, end: ruleText.length }];
  if (wiringText === null) {
    return { text: ruleText, parts, wiringPath, hasWiring: false };
  }

  // One separator newline, so a rule not ending in a newline cannot fuse its
  // last line to the sibling's first heading and hide that heading from every
  // line-anchored matcher.
  const sep = "\n";
  const start = ruleText.length + sep.length;
  const text = ruleText + sep + wiringText;
  parts.push({ path: wiringPath, start, end: start + wiringText.length });
  return { text, parts, wiringPath, hasWiring: true };
}

/**
 * Map an index in the joined surface back to the file and 1-based line holding it.
 *
 * @param {{text:string|null, parts:{path:string,start:number,end:number}[]}} surface
 * @param {number} index
 * @returns {{path:string, line:number}|null}
 */
export function locateInSurface(surface, index) {
  if (!surface || surface.text === null) return null;
  for (const part of surface.parts) {
    if (index >= part.start && index < part.end) {
      const local = index - part.start;
      const before = surface.text.slice(part.start, part.start + local);
      return { path: part.path, line: before.split("\n").length };
    }
  }
  return null;
}

/**
 * Map a 1-based LINE in the joined surface back to the file and line holding it.
 *
 * The line-oriented companion to `locateInSurface`. Spans produced by a scanner
 * that counts lines over the surface are otherwise reported against the RULE
 * file at a line past its end — MEASURED: `detection-distribution-check` emitted
 * `[ANCHOR UNRESOLVED: line 168 is outside the file]` for a 119-line rule, and
 * `detection-binding-check` printed the same unopenable 168 from an independent
 * code path. A citation a reader cannot open is the dangling-reference class
 * `cc-artifacts.md` MUST NOT blocks, manufactured by the fix itself.
 *
 * @param {{text:string|null, parts:{path:string,start:number,end:number}[]}} surface
 * @param {number} line1 1-based line within `surface.text`
 * @returns {{path:string, line:number}|null}
 */
export function locateSurfaceLine(surface, line1) {
  if (!surface || surface.text === null) return null;
  const lines = surface.text.split("\n");
  if (!Number.isInteger(line1) || line1 < 1 || line1 > lines.length) return null;
  let index = 0;
  for (let i = 0; i < line1 - 1; i++) index += lines[i].length + 1;
  return locateInSurface(surface, index);
}
