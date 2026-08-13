#!/usr/bin/env node
/**
 * Audit-fixture runner for session-notes-guard.js — the detector backing
 * `rules/session-notes-continuity.md` (MUST-1 read-order, MUST-2 no-truncate-read,
 * MUST-3 boundedness).
 *
 * Per `cc-artifacts.md` Rule 9 the fixtures ship WITH the detector, and the coverage
 * shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — not one per clause. The
 * predicates a wrong edit would silently widen or narrow are: what counts as a
 * continuity artifact, what counts as a truncation, what counts as the root
 * (directive) surface versus the workspace (narrative) one, what the tri-state
 * ordering signal does on UNKNOWN, and where the ceiling boundary sits.
 *
 * Every case exercises a PURE decision function — no stdin, no spawn, no git, no
 * filesystem. `repoDir` is a nonexistent synthetic root on purpose: path
 * classification is lexical, so the cases cannot pass by accident of what happens to
 * be on this machine's disk.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): each case's `reds_under` names
 * the mutation to `session-notes-guard.js` that makes it FAIL. The mutations were run
 * and the reddened set recorded in the landing PR — a fixture never shown to red is
 * not a regression guard, and a mutation that fails to red leaves two live hypotheses
 * (vacuous case OR inert mutation), so each mutation below was chosen to be
 * unambiguously reachable from the case's own inputs.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const guard = require(join(HERE, "..", "..", "hooks", "session-notes-guard.js"));

const {
  classifyNotesPath,
  truncationOf,
  decideReadGate,
  countLines,
  decideCeilingAdvisory,
  markerPathFor,
  NOTES_CEILING_LINES,
} = guard;

// A synthetic root that does not exist — classification is lexical by contract.
const REPO = "/synthetic/repo-root";

const CASES = [
  // ── MUST-2: truncation is block-grade, on every continuity surface ──────────
  {
    predicate: "block-limit-on-root-fragment",
    name: "MUST-2 — `limit` on the operator's own root fragment BLOCKS",
    reds_under: "truncationOf(): drop the `limit` branch",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: ".session-notes.d/esperie.md",
        limit: 50,
        rootNotesSeen: true,
      }),
    expect: { action: "block", reason: "truncated-read", truncation: "limit=50" },
  },
  {
    predicate: "block-offset-on-workspace-narrative",
    name: "MUST-2 — non-zero `offset` on a workspace narrative BLOCKS",
    reds_under: "truncationOf(): drop the `offset` branch",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "workspaces/proj/.session-notes",
        offset: 200,
        rootNotesSeen: true,
      }),
    expect: { action: "block", reason: "truncated-read", truncation: "offset=200" },
  },
  {
    predicate: "block-precedes-order-advisory",
    name: "MUST-2 outranks MUST-1 — a truncated narrative read BLOCKS, never merely advises",
    reds_under: "decideReadGate(): move the MUST-1 order check above the MUST-2 check",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "workspaces/proj/.session-notes",
        limit: 10,
        rootNotesSeen: false, // BOTH clauses are live; block must win
      }),
    expect: { action: "block", reason: "truncated-read" },
  },
  {
    predicate: "offset-zero-is-not-truncation",
    name: "MUST-2 boundary — explicit `offset: 0` with no limit is a WHOLE read, passes",
    reds_under: "truncationOf(): remove the `n === 0` boundary so any present offset blocks",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: ".session-notes.aggregate.md",
        offset: 0,
        rootNotesSeen: false,
      }),
    expect: { action: "pass", reason: "root-continuity-read" },
  },
  {
    predicate: "no-truncation-params-passes",
    name: "MUST-2 negative — a whole read of a fragment passes",
    reds_under: "truncationOf(): return a descriptor unconditionally",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: ".session-notes.d/esperie.md",
        rootNotesSeen: true,
      }),
    expect: { action: "pass", reason: "root-continuity-read" },
  },

  // ── MUST-1: read order, and its tri-state fail-open ─────────────────────────
  {
    predicate: "narrative-before-directive-advises",
    name: "MUST-1 — workspace narrative read with NO prior root read advises",
    reds_under: "decideReadGate(): delete the `surface === 'workspace'` order branch",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "workspaces/proj/.session-notes",
        rootNotesSeen: false,
      }),
    expect: {
      action: "advise",
      reason: "narrative-before-directive",
      workspace: "proj",
    },
  },
  {
    predicate: "fragment-first-unblocks",
    name: "MUST-1 — the SAME narrative read passes once a root artifact was read",
    // Measured: `!== true` does NOT red this case (true !== true is false, so it still
    // passes). Dropping the conjunct entirely is what reds it. Recorded as measured.
    reds_under: "decideReadGate(): drop the `rootNotesSeen === false` conjunct so the order branch fires regardless of state",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "workspaces/proj/.session-notes",
        rootNotesSeen: true,
      }),
    expect: { action: "pass", reason: "ordered" },
  },
  {
    predicate: "order-unknown-fails-open",
    name: "MUST-1 fail-open — UNKNOWN ordering (no session id) SUPPRESSES, never advises",
    reds_under: "decideReadGate(): test `!o.rootNotesSeen` instead of `=== false`",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "workspaces/proj/.session-notes",
        rootNotesSeen: null,
      }),
    expect: { action: "pass", reason: "order-unknown-suppress" },
  },
  {
    predicate: "root-read-never-order-advises",
    name: "MUST-1 — a ROOT artifact read is never itself out of order",
    reds_under: "classifyNotesPath(): return surface 'workspace' for anchorIdx === 0",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: ".session-notes.shared.md",
        rootNotesSeen: false,
      }),
    expect: { action: "pass", reason: "root-continuity-read" },
  },

  // ── scope restriction: what IS and IS NOT a continuity artifact ─────────────
  {
    predicate: "non-continuity-path-out-of-scope",
    name: "scope — an ordinary repo file is not a continuity artifact even with a limit",
    reds_under: "classifyNotesPath(): drop the NOTES_BASENAME_RE guard",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: ".claude/rules/cc-artifacts.md",
        limit: 50,
        rootNotesSeen: false,
      }),
    expect: { action: "pass", reason: "not-a-continuity-artifact" },
  },
  {
    predicate: "near-miss-basename-out-of-scope",
    name: "scope — `session-notes.md` (no leading dot) is NOT a continuity artifact",
    reds_under: "NOTES_BASENAME_RE: drop the leading `^\\.` anchor",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "docs/session-notes.md",
        limit: 5,
        rootNotesSeen: false,
      }),
    expect: { action: "pass", reason: "not-a-continuity-artifact" },
  },
  {
    predicate: "suffixed-basename-out-of-scope",
    name: "scope — `.session-notesX` is NOT a continuity artifact (dot-or-end anchor)",
    reds_under: "NOTES_BASENAME_RE: replace `(\\.|$)` with a bare prefix match",
    run: () => classifyNotesPath(REPO, ".session-notesX"),
    expect: null,
  },
  {
    predicate: "outside-repo-out-of-scope",
    name: "scope — a continuity-shaped path OUTSIDE the repo root classifies as null",
    reds_under: "toRepoRel(): drop the `rel.startsWith('..')` escape check",
    run: () => classifyNotesPath(REPO, "/elsewhere/.session-notes"),
    expect: null,
  },

  // ── surface classification (the MUST-1 discriminator) ───────────────────────
  {
    predicate: "root-fragment-surface",
    name: "surface — a fragment under the ROOT `.session-notes.d/` is the directive surface",
    reds_under: "classifyNotesPath(): use `segs.length - 1` as anchorIdx for fragments",
    run: () => classifyNotesPath(REPO, ".session-notes.d/esperie.md"),
    expect: { kind: "fragment", surface: "root", workspace: null },
  },
  {
    predicate: "workspace-fragment-surface",
    name: "surface — a fragment under `workspaces/<ws>/.session-notes.d/` is the narrative surface",
    reds_under: "classifyNotesPath(): drop the `segs[0] === 'workspaces'` branch",
    run: () => classifyNotesPath(REPO, "workspaces/proj/.session-notes.d/esperie.md"),
    expect: { kind: "fragment", surface: "workspace", workspace: "proj" },
  },
  {
    predicate: "deep-path-is-other-surface",
    name: "surface — a continuity-shaped path elsewhere is `other`: MUST-2 applies, MUST-1 does not",
    reds_under: "classifyNotesPath(): default the else-branch to 'workspace'",
    run: () => classifyNotesPath(REPO, "vendor/pkg/.session-notes"),
    expect: { kind: "monolith", surface: "other", workspace: null },
  },
  {
    predicate: "other-surface-never-order-advises",
    name: "surface — an `other` continuity read does not trigger the MUST-1 advisory",
    reds_under: "decideReadGate(): test `surface !== 'root'` in the order branch",
    run: () =>
      decideReadGate({
        repoDir: REPO,
        filePath: "vendor/pkg/.session-notes",
        rootNotesSeen: false,
      }),
    expect: { action: "pass", reason: "ordered" },
  },

  // ── MUST-3: the ceiling boundary + its zero-evidence suppression ────────────
  {
    predicate: "ceiling-boundary-at-limit-passes",
    name: `MUST-3 boundary — exactly ${NOTES_CEILING_LINES} lines is WITHIN the ceiling`,
    reds_under: "decideCeilingAdvisory(): change `>` to `>=`",
    run: () =>
      decideCeilingAdvisory({
        repoDir: REPO,
        filePath: ".session-notes.d/esperie.md",
        lineCount: NOTES_CEILING_LINES,
      }),
    expect: { action: "pass", reason: "within-ceiling" },
  },
  {
    predicate: "ceiling-boundary-over-limit-advises",
    name: `MUST-3 boundary — ${NOTES_CEILING_LINES + 1} lines is OVER the ceiling`,
    reds_under: "decideCeilingAdvisory(): neuter the over-ceiling branch",
    run: () =>
      decideCeilingAdvisory({
        repoDir: REPO,
        filePath: ".session-notes.d/esperie.md",
        lineCount: NOTES_CEILING_LINES + 1,
      }),
    expect: { action: "advise", reason: "over-ceiling", lineCount: NOTES_CEILING_LINES + 1 },
  },
  {
    predicate: "ceiling-unmeasured-suppresses",
    name: "MUST-3 — an unavailable line count is zero evidence, never a finding",
    reds_under: "decideCeilingAdvisory(): drop the Number.isFinite guard",
    run: () =>
      decideCeilingAdvisory({
        repoDir: REPO,
        filePath: ".session-notes.d/esperie.md",
        lineCount: NaN,
      }),
    expect: { action: "pass", reason: "line-count-unavailable" },
  },
  {
    predicate: "ceiling-scope-isolation",
    name: "MUST-3 scope — a huge NON-continuity file is not this hook's business",
    reds_under: "decideCeilingAdvisory(): drop the classifyNotesPath null-guard",
    run: () =>
      decideCeilingAdvisory({
        repoDir: REPO,
        filePath: "README.md",
        lineCount: 9000,
      }),
    expect: { action: "pass", reason: "not-a-continuity-artifact" },
  },
  {
    predicate: "countlines-trailing-newline",
    name: "MUST-3 arithmetic — a trailing newline terminates the last line, it does not add one",
    reds_under: "countLines(): drop the trailing-newline strip",
    run: () => ({ n: countLines("a\nb\nc\n"), empty: countLines("") }),
    expect: { n: 3, empty: 0 },
  },

  // ── ordering-marker derivation (the MUST-1 state source) ────────────────────
  {
    predicate: "marker-null-without-session-id",
    name: "marker — no session id yields NO marker path (→ UNKNOWN, never `false`)",
    // Requires removing BOTH empty-handle guards. Removing only the first is INERT —
    // measured — because the empty string clears its type test and is then caught by
    // the `!safe` guard. Recorded so a future reader does not read that inert mutation
    // as "the case is vacuous" (instrument-discipline.md MUST-2(b)).
    reds_under: "markerPathFor(): remove BOTH the `!sessionId` guard and the `!safe` guard",
    run: () => ({ absent: markerPathFor(REPO, ""), nullish: markerPathFor(REPO, null) }),
    expect: { absent: null, nullish: null },
  },
  {
    predicate: "marker-sanitizes-session-id",
    name: "marker — a traversal-shaped session id stays ONE filename segment inside tmpdir",
    reds_under: "markerPathFor(): drop the [^A-Za-z0-9_-] replace",
    // The assertion is `dirname === tmpdir`, NOT `!path.includes("..")`. The latter was
    // the FIRST form of this case and it was VACUOUS: `path.join` normalizes `..` away,
    // so it read identically with and without the sanitize (measured — the mutation
    // reddened nothing). What the sanitize actually buys is that no separator survives
    // into the filename, which `dirname` discriminates: unsanitized,
    // `<tmp>/coc-notes-order-<tag>-../../etc/passwd` normalizes to `<tmp>/etc/passwd`
    // and the dirname moves off tmpdir. The deep-traversal arm additionally pins
    // CONTAINMENT, which the shallow one cannot (it never escapes tmpdir either way).
    run: () => {
      const shallow = markerPathFor(REPO, "../../etc/passwd");
      const deep = markerPathFor(REPO, "../".repeat(12) + "etc/passwd");
      const tmp = tmpdir();
      return {
        oneSegment: dirname(shallow) === tmp,
        deepContained: deep.startsWith(tmp + sep),
        isString: typeof shallow === "string",
      };
    },
    expect: { oneSegment: true, deepContained: true, isString: true },
  },
  {
    predicate: "marker-is-repo-scoped",
    name: "marker — two different repo roots yield different marker paths",
    reds_under: "markerPathFor(): drop the repo-root hash from the filename",
    run: () => ({
      differ:
        markerPathFor("/repo/a", "sess-1") !== markerPathFor("/repo/b", "sess-1"),
      sameRepoStable:
        markerPathFor("/repo/a", "sess-1") === markerPathFor("/repo/a", "sess-1"),
    }),
    expect: { differ: true, sameRepoStable: true },
  },
  {
    predicate: "truncation-descriptor-shape",
    name: "truncation — the descriptor names the offending parameter for the block message",
    reds_under: "truncationOf(): return a bare boolean",
    run: () => ({
      lim: truncationOf(25, undefined),
      off: truncationOf(undefined, 7),
      zero: truncationOf(undefined, 0),
      none: truncationOf(undefined, undefined),
    }),
    expect: { lim: "limit=25", off: "offset=7", zero: null, none: null },
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

/** Subset match: every key in `expect` must deep-equal the same key in `got`.
 *  `expect: null` asserts a null return. Extra keys on `got` are ignored — the cases
 *  pin the load-bearing fields, not the whole shape. */
function matches(got, expect) {
  if (expect === null) return got === null;
  if (got === null || typeof got !== "object") return false;
  for (const [k, v] of Object.entries(expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

let failures = 0;
for (const c of CASES) {
  let got;
  try {
    got = c.run();
  } catch (err) {
    got = { threw: err && err.message ? err.message : String(err) };
  }
  if (matches(got, c.expect)) {
    console.log(`PASS  [${c.predicate}] ${c.name}`);
  } else {
    failures++;
    console.log(
      `FAIL  [${c.predicate}] ${c.name}\n      expected ${JSON.stringify(c.expect)}\n      got      ${JSON.stringify(got)}`,
    );
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} fixtures passed`);
process.exit(failures === 0 ? 0 : 1);
