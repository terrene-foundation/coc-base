#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/pcf-category.js` — the closed
 * literal enum backing `rules/product-completion-first.md` MUST-1 at the PR
 * surface (T5).
 *
 * Per `cc-artifacts.md` Rule 9 the fixtures ship WITH the detector, and the
 * coverage shape is ONE CASE PER SCOPE-RESTRICTION PREDICATE — not one per
 * clause. The predicates a wrong edit would silently widen or narrow are: what
 * counts as a category MARKER, what counts as a MEMBER of the enum, which of
 * the four states an unreadable body lands in, where the body actually comes
 * from on the argv, and whether the verdict is a state or a boolean.
 *
 * BIPOLAR by construction: every predicate carries BOTH an accept pole and a
 * reject pole. A fixture set that only ever asserts acceptance passes
 * identically against a validator that accepts everything, which is precisely
 * the M5-a mutation this set exists to lock out.
 *
 * Every case exercises a PURE decision function — no stdin, no spawn, no git.
 * The one filesystem-touching predicate (`--body-file`) is driven through the
 * injectable `readBodyFile` seam, so the cases cannot pass or fail by accident
 * of what happens to be on this machine's disk.
 *
 * ESTABLISHED RED (`instrument-discipline.md` MUST-2): each case's `reds_under`
 * names the mutation to `pcf-category.js` that makes it FAIL. The two mutations
 * the plan requires (M5-a permissive pattern, M5-b boolean state) were RUN and
 * their reddened sets recorded in the landing PR, each with a reach proof — a
 * fixture never shown to red is not a regression guard, and a mutation that
 * fails to red leaves two live hypotheses (vacuous case OR inert mutation).
 *
 * CAUSE IDENTITY, NOT MERELY CAUSE STATE (`instrument-bipolarity.md` MUST-2).
 * The first cut of the cause taxonomy shipped a set that asserted `state` for
 * six of the twenty codes and never asserted WHICH code — so a cyclic
 * permutation of `MARKER_ABSENT`, `VALUE_NOT_IN_ENUM`, `VALUE_EMPTY`,
 * `MARKERS_CONFLICT`, `BODY_TEXT_MISSING` and `COMMAND_UNRESOLVABLE` at their
 * five assignment sites shipped 50/50 fixtures and 24/24 suite GREEN, with the
 * mutation's reach proven first: on that mutant `gh pr create --body x` reported
 * `[cause: VALUE_NOT_IN_ENUM]` for a body that has no marker at all. A refusal
 * that names the WRONG cause is worse than the anonymous refusal the taxonomy
 * replaced — it sends the operator down a remedy for a fault they do not have,
 * which is exactly the wasted-diagnosis cost loom#1803 exists to end. So the
 * class is closed, not the six instances: `CAUSE_IDENTITY_TABLE` below carries
 * ONE situation per code with a LITERAL `STATE/CAUSE` expectation, and a
 * companion case asserts the table's code set equals `PCF_CAUSES` exactly — so
 * a code added to the source with no situation REDS rather than shipping
 * unpinned. The expectations are literal strings, never `PCF_CAUSES.X`, so a
 * scramble of the taxonomy's own VALUES reds too.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const lib = require(join(HERE, "..", "..", "hooks", "lib", "pcf-category.js"));

const {
  findGhSubcommand,
} = require(join(HERE, "..", "..", "hooks", "lib", "git-command-parse.js"));

const {
  PCF_CATEGORIES,
  PCF_STATES,
  PCF_CAUSES,
  PCF_SOURCES,
  isKnownCategory,
  prefilterCouldMatch,
  locateSubstitution,
  readCategoryFromBody,
  extractBodySpec,
  readBodyFileDiagnosed,
  classifyPrCreate,
  formatCategoryAdvisory,
  formatCategoryRemediation,
} = lib;

/**
 * A SELF-BUILT sandbox for the cause-taxonomy cases (loom#1803).
 *
 * The header above says the one filesystem-touching predicate is driven through
 * the injected seam so a case cannot pass by accident of what is on this
 * machine's disk. The cause taxonomy makes that impossible for part of the set:
 * "outside the root", "missing", "not a regular file", "escapes via symlink"
 * and "over the cap" are DEFINED by filesystem facts, and a seam that fabricates
 * them would be testing the fabrication, not the reader. So the sandbox is
 * built HERE, entirely by this file, under `os.tmpdir()` — nothing about the
 * repo, the checkout layout or the machine's contents is read. Same property,
 * different mechanism: the cases still cannot pass or fail by accident.
 *
 * DELIBERATELY NOT USED: a `chmod 000` file for the EACCES case. It is a no-op
 * under root, which is how a container CI often runs, and a case that silently
 * inverts its meaning by privilege is worse than no case. The same
 * `BODY_FILE_UNREADABLE` branch is reached deterministically and unprivileged by
 * a self-referential symlink (ELOOP) and by a path whose parent component is a
 * regular file (ENOTDIR), both of which ARE covered below. Real EACCES was
 * exercised by hand at landing and reported there.
 */
const SANDBOX = fs.mkdtempSync(join(os.tmpdir(), "pcf-fixture-"));
const ROOT = join(SANDBOX, "root");
const OUTSIDE = join(SANDBOX, "outside");
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(join(ROOT, "good.md"), "PCF-Category: BUG\n");
fs.writeFileSync(join(ROOT, "plain.md"), "PCF-Category: BUG\n");
fs.writeFileSync(join(ROOT, "big.md"), "x".repeat(lib.BODY_FILE_MAX_BYTES + 1));
fs.mkdirSync(join(ROOT, "adir"), { recursive: true });
fs.writeFileSync(join(OUTSIDE, "body.md"), "PCF-Category: INVEST-NOW\n");
fs.symlinkSync(join(OUTSIDE, "body.md"), join(ROOT, "escape.md"));
fs.symlinkSync(join(ROOT, "loop.md"), join(ROOT, "loop.md")); // ELOOP, unprivileged

/**
 * A root reached through a SYMLINKED PREFIX, built here rather than hoped for.
 *
 * The regression lock for the first-cut lexical-containment bug (see the
 * `a-symlinked-root-prefix…` case) needs a root whose given spelling and
 * canonical spelling PROVABLY differ. The first cut of that lock derived its
 * root from `os.tmpdir()` and got the difference by luck of the platform: on
 * macOS the default TMPDIR is `/var/folders/...` which canonicalizes to
 * `/private/var/folders/...`, so the lock fired; under `TMPDIR=/private/tmp`,
 * and on the Linux self-hosted runner the fixture runner actually executes on,
 * tmpdir is already canonical and the SAME reintroduced bug shipped the set
 * fully GREEN. Measured at the fix: the lexical mutant scored 40/50 under macOS
 * default TMPDIR and 50/50 under `TMPDIR=/private/tmp` — i.e. the "permanent"
 * lock was inert exactly where CI runs.
 *
 * `LINK_ROOT` removes the dependency on the host. It is a symlink whose own
 * basename (`link-root`) differs from its target's (`root`), so
 * `realpathSync(LINK_ROOT) !== LINK_ROOT` holds on EVERY platform, by
 * construction rather than by environment. That inequality is ASSERTED in the
 * case's `expect` block, not merely recorded: if the construction ever stopped
 * producing a differing prefix the case would RED, instead of quietly
 * degrading to asserting the trivial half.
 */
const LINK_ROOT = join(SANDBOX, "link-root");
fs.symlinkSync(ROOT, LINK_ROOT);

/**
 * A MAIN CHECKOUT and a LINKED WORKTREE, built by hand — the loom#1990 subject.
 *
 * The defect these cases lock out is a WRONG ROOT: the guard resolved and
 * contained `--body-file` against the hook payload's `cwd`, which is the SESSION
 * directory — in this repo's workflow the MAIN CHECKOUT — while the command runs
 * in a linked worktree it reaches with a `cd <wt> &&` prefix. Measured before the
 * fix, on a REAL `git worktree add`: a relative path reported
 * `NOT_VERIFIED/BODY_FILE_MISSING` and an ABSOLUTE path under the same worktree
 * reported `NOT_VERIFIED/BODY_FILE_OUTSIDE_ROOT`. Absolute paths did not help
 * because the containment root, not the spelling, was wrong.
 *
 * WHY BY HAND AND NOT `git worktree add`. This runner's header commits to no
 * spawn and no git, and that constraint is worth keeping — but the fabrication
 * objection it raises for the seam does NOT apply here, because nothing is being
 * faked: git's linked-worktree layout is a PUBLISHED on-disk contract (`.git` as
 * a FILE holding `gitdir:`, a `commondir` sidecar inside that gitdir naming the
 * shared git directory), and it is exactly the contract `checkoutOf` reads. What
 * is built here IS the subject, not a stand-in for it.
 *
 * The hand-built layout was cross-checked against a real `git worktree add` in
 * the landing PR — same three verdicts, same three causes — so the contract read
 * here is pinned to the one real git produces rather than assumed equal to it.
 *
 * `OTHER_*` is a SECOND, unrelated repository with its own worktree. It is the
 * REJECT pole for the containment widening: same shape, different common
 * directory, and therefore still OUTSIDE_ROOT. Without it, "contained by
 * repository identity" would be indistinguishable from "contained by nothing".
 */
function buildCheckout(mainDir, worktreeDir, linkName) {
  const gitDir = join(mainDir, ".git");
  const wtGitDir = join(gitDir, "worktrees", linkName);
  fs.mkdirSync(wtGitDir, { recursive: true });
  // The sidecar git itself writes: a path to the shared git directory, relative
  // to the worktree's own gitdir.
  fs.writeFileSync(join(wtGitDir, "commondir"), "../..\n");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);
  fs.writeFileSync(join(wtGitDir, "gitdir"), `${join(worktreeDir, ".git")}\n`);
}
const REPO_MAIN = join(SANDBOX, "repo");
const REPO_WT = join(SANDBOX, "repo-wt-lane");
buildCheckout(REPO_MAIN, REPO_WT, "lane");
fs.writeFileSync(join(REPO_WT, "body.md"), "## Summary\n\nPCF-Category: BUG\n");
fs.writeFileSync(join(REPO_MAIN, "main-body.md"), "PCF-Category: INCREMENTAL\n");
const OTHER_MAIN = join(SANDBOX, "other-repo");
const OTHER_WT = join(SANDBOX, "other-repo-wt");
buildCheckout(OTHER_MAIN, OTHER_WT, "lane");
fs.writeFileSync(join(OTHER_WT, "body.md"), "PCF-Category: BUG\n");

process.on("exit", () => {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
});

/** The cause of a `--body-file` read against the sandbox root. */
const causeOf = (p, command) => readBodyFileDiagnosed(p, ROOT, command).cause;

/** A verdict rendered as the pair that IS its identity. Both halves matter: the
 *  state is what the guard concluded, the cause is WHY, and a permutation of the
 *  causes leaves every state untouched — which is precisely how the first cut
 *  shipped green. `NOT-APPLICABLE` is spelled out rather than left as `null`, so
 *  a case can never read a silently-absent verdict as agreement. */
const idOf = (v) => (v === null ? "NOT-APPLICABLE" : `${v.state}/${v.cause}`);

/**
 * ONE SITUATION PER CAUSE CODE — the identity lock (`instrument-bipolarity.md`
 * MUST-2). Every row drives the PUBLIC verdict surface and pins a LITERAL
 * `STATE/CAUSE` string; nothing here reads `PCF_CAUSES.X` for its expectation,
 * so the table discriminates against BOTH a mis-assignment at a call site AND a
 * scramble of the taxonomy's own values. `expect` is the whole point: a row
 * asserting only the state would pass against a guard that reported one cause
 * for everything, which is the pre-loom#1803 behaviour this set exists to lock
 * out.
 */
const CAUSE_IDENTITY_TABLE = [
  // ── the body WAS read; these are findings about the PR ────────────────────
  {
    code: "CATEGORY_DECLARED",
    expect: "CATEGORIZED/CATEGORY_DECLARED",
    run: () => readCategoryFromBody("PCF-Category: BUG"),
  },
  {
    code: "MARKER_ABSENT",
    expect: "UNCATEGORIZED/MARKER_ABSENT",
    run: () => readCategoryFromBody("## Summary\nno category field here"),
  },
  {
    code: "VALUE_NOT_IN_ENUM",
    expect: "INVALID/VALUE_NOT_IN_ENUM",
    run: () => readCategoryFromBody("PCF-Category: F-G1-HIGH"),
  },
  {
    code: "VALUE_EMPTY",
    expect: "INVALID/VALUE_EMPTY",
    run: () => readCategoryFromBody("PCF-Category:"),
  },
  {
    code: "MARKERS_CONFLICT",
    expect: "INVALID/MARKERS_CONFLICT",
    run: () =>
      readCategoryFromBody("PCF-Category: BUG\n\nPCF-Category: INCREMENTAL"),
  },

  // ── the body was NOT read; these are instrument failures ──────────────────
  {
    code: "BODY_SUBSTITUTION",
    expect: "NOT_VERIFIED/BODY_SUBSTITUTION",
    run: () => readCategoryFromBody("## Summary\nsee $(git log) for detail"),
  },
  {
    code: "BODY_TEXT_MISSING",
    expect: "NOT_VERIFIED/BODY_TEXT_MISSING",
    run: () => readCategoryFromBody(null),
  },
  {
    code: "COMMAND_UNRESOLVABLE",
    expect: "NOT_VERIFIED/COMMAND_UNRESOLVABLE",
    run: () => classifyPrCreate("$(which gh) pr create --body x", { repoRoot: ROOT }),
  },
  {
    code: "BODY_DERIVED",
    expect: "NOT_VERIFIED/BODY_DERIVED",
    run: () => classifyPrCreate("gh pr create --fill", { repoRoot: ROOT }),
  },
  {
    code: "BODY_ABSENT",
    expect: "NOT_VERIFIED/BODY_ABSENT",
    run: () => classifyPrCreate("gh pr create --title t", { repoRoot: ROOT }),
  },
  {
    code: "BODY_FILE_UNREAD",
    expect: "NOT_VERIFIED/BODY_FILE_UNREAD",
    run: () =>
      classifyPrCreate("gh pr create --body-file b.md", {
        repoRoot: ROOT,
        readBodyFile: () => null,
      }),
  },
  {
    code: "BODY_FILE_PATH_EMPTY",
    expect: "NOT_VERIFIED/BODY_FILE_PATH_EMPTY",
    run: () => classifyPrCreate("gh pr create --body-file ''", { repoRoot: ROOT }),
  },
  {
    code: "BODY_FILE_OUTSIDE_ROOT",
    expect: "NOT_VERIFIED/BODY_FILE_OUTSIDE_ROOT",
    run: () =>
      classifyPrCreate(`gh pr create -F ${join(OUTSIDE, "body.md")}`, {
        repoRoot: ROOT,
      }),
  },
  {
    code: "BODY_FILE_ESCAPES_CONTAINMENT",
    expect: "NOT_VERIFIED/BODY_FILE_ESCAPES_CONTAINMENT",
    run: () =>
      classifyPrCreate(`gh pr create -F ${join(ROOT, "escape.md")}`, {
        repoRoot: ROOT,
      }),
  },
  {
    code: "BODY_FILE_MISSING",
    expect: "NOT_VERIFIED/BODY_FILE_MISSING",
    run: () =>
      classifyPrCreate(`gh pr create -F ${join(ROOT, "nope.md")}`, {
        repoRoot: ROOT,
      }),
  },
  {
    code: "BODY_FILE_WRITTEN_BY_THIS_COMMAND",
    expect: "NOT_VERIFIED/BODY_FILE_WRITTEN_BY_THIS_COMMAND",
    run: () =>
      classifyPrCreate(
        `cat > nope.md <<'EOF'\nPCF-Category: BUG\nEOF\ngh pr create -F ${join(ROOT, "nope.md")}`,
        { repoRoot: ROOT },
      ),
  },
  {
    code: "BODY_FILE_UNREADABLE",
    expect: "NOT_VERIFIED/BODY_FILE_UNREADABLE",
    run: () =>
      classifyPrCreate(`gh pr create -F ${join(ROOT, "loop.md")}`, {
        repoRoot: ROOT,
      }),
  },
  {
    code: "BODY_FILE_NOT_A_FILE",
    expect: "NOT_VERIFIED/BODY_FILE_NOT_A_FILE",
    run: () =>
      classifyPrCreate(`gh pr create -F ${join(ROOT, "adir")}`, { repoRoot: ROOT }),
  },
  {
    code: "BODY_FILE_TOO_LARGE",
    expect: "NOT_VERIFIED/BODY_FILE_TOO_LARGE",
    run: () =>
      classifyPrCreate(`gh pr create -F ${join(ROOT, "big.md")}`, {
        repoRoot: ROOT,
      }),
  },
  {
    code: "ROOT_UNRESOLVABLE",
    expect: "NOT_VERIFIED/ROOT_UNRESOLVABLE",
    run: () =>
      classifyPrCreate("gh pr create -F x.md", {
        repoRoot: join(SANDBOX, "no", "such", "root"),
      }),
  },
];

const CASES = [
  // ── the enum is a CLOSED LITERAL, not a shape ───────────────────────────────
  {
    predicate: "enum-is-a-frozen-literal-triple",
    name: "enum — exactly three members, frozen, in the rule's own order",
    reds_under: "PCF_CATEGORIES: add a fourth member, or build it from a template",
    run: () => ({
      members: PCF_CATEGORIES,
      frozen: Object.isFrozen(PCF_CATEGORIES),
      isArray: Array.isArray(PCF_CATEGORIES),
    }),
    expect: {
      members: ["BUG", "INVEST-NOW", "INCREMENTAL"],
      frozen: true,
      isArray: true,
    },
  },
  {
    predicate: "enum-accepts-every-member",
    name: "enum ACCEPT pole — each of the three literals is a member",
    reds_under: "isKnownCategory(): invert or narrow the membership test",
    run: () => PCF_CATEGORIES.map((c) => isKnownCategory(c)),
    expectDeep: [true, true, true],
  },
  {
    predicate: "enum-rejects-derived-finding-tag",
    name: "enum REJECT pole — the derived finding tag `F-G1-HIGH` is NOT a member (disclosure lock)",
    reds_under:
      "isKnownCategory(): replace membership with a permissive pattern (M5-a)",
    run: () => isKnownCategory("F-G1-HIGH"),
    expectDeep: false,
  },
  {
    predicate: "enum-rejects-adjacent-shapes",
    name: "enum REJECT pole — near-miss and workspace-identifier shapes are all non-members",
    reds_under:
      "isKnownCategory(): replace membership with a permissive pattern (M5-a)",
    run: () =>
      [
        "BUGS",
        "INVEST",
        "INVEST_NOW",
        "INCREMENTAL-IMPROVEMENT",
        "W3-D",
        "loom-1689",
        "",
      ].map((t) => isKnownCategory(t)),
    expectDeep: [false, false, false, false, false, false, false],
  },

  // ── the four states, and the fact that they are STATES ──────────────────────
  {
    predicate: "state-categorized-on-a-member",
    name: "state — a body declaring BUG is CATEGORIZED and names the category",
    reds_under: "readCategoryFromBody(): drop the CATEGORIZED return",
    run: () => readCategoryFromBody("## Summary\nPCF-Category: BUG\ndetail"),
    expect: { state: "CATEGORIZED", category: "BUG", observed: "BUG" },
  },
  {
    predicate: "state-uncategorized-is-its-own-state",
    name: "state — a body with NO marker is UNCATEGORIZED, a distinct state (not clean, not false)",
    reds_under:
      "readCategoryFromBody(): return `{categorized:false}` for the no-marker branch (M5-b)",
    run: () => {
      const v = readCategoryFromBody("## Summary\nno category here");
      return {
        state: v.state,
        isString: typeof v.state === "string",
        notABoolean: !Object.prototype.hasOwnProperty.call(v, "categorized"),
      };
    },
    expect: { state: "UNCATEGORIZED", isString: true, notABoolean: true },
  },
  {
    predicate: "state-invalid-on-a-non-member",
    name: "state — a marker carrying a non-member is INVALID and echoes what it saw",
    reds_under:
      "isKnownCategory(): replace membership with a permissive pattern (M5-a)",
    run: () => readCategoryFromBody("PCF-Category: F-G1-HIGH"),
    expect: { state: "INVALID", category: null, observed: "F-G1-HIGH" },
  },
  {
    predicate: "state-invalid-on-a-present-but-empty-marker",
    name: "state — a marker present with no value is INVALID, not UNCATEGORIZED",
    reds_under:
      "readCategoryFromBody(): fall through an empty capture to the no-marker branch",
    run: () => readCategoryFromBody("PCF-Category:"),
    expect: { state: "INVALID", category: null, observed: "" },
  },
  {
    predicate: "state-invalid-on-conflicting-markers",
    name: "state — two markers with different values is INVALID, never first-wins",
    reds_under:
      "readCategoryFromBody(): stop collecting matches and read only the first",
    run: () =>
      readCategoryFromBody("PCF-Category: BUG\n\nPCF-Category: INCREMENTAL"),
    expect: { state: "INVALID", category: null },
  },
  {
    predicate: "state-categorized-on-duplicate-agreeing-markers",
    name: "state ACCEPT pole — two markers AGREEING is still CATEGORIZED (the conflict test is about disagreement)",
    reds_under:
      "readCategoryFromBody(): reject on marker COUNT rather than on disagreement",
    run: () => readCategoryFromBody("PCF-Category: BUG\n\nPCF-Category: bug"),
    expect: { state: "CATEGORIZED", category: "BUG" },
  },
  {
    predicate: "state-not-verified-on-an-unreadable-body",
    name: "state — an unexpanded substitution is NOT_VERIFIED, never UNCATEGORIZED",
    reds_under: "SUBSTITUTION_RE: drop the `$(` alternative",
    run: () => readCategoryFromBody("$(cat /tmp/body.md)"),
    expect: { state: "NOT_VERIFIED", category: null },
  },
  {
    predicate: "four-states-are-mutually-distinct",
    name: "state — the four state values are four distinct strings",
    reds_under: "PCF_STATES: collapse any two states onto one value",
    run: () => new Set(Object.values(PCF_STATES)).size,
    expectDeep: 4,
  },

  // ── marker recognition: what IS and IS NOT the field ────────────────────────
  {
    predicate: "marker-accepts-the-markdown-forms-authors-write",
    name: "marker ACCEPT pole — bold (either placement), list-bullet and lowercase all read",
    reds_under: "MARKER_RE: drop the emphasis or list-bullet groups",
    run: () =>
      [
        "**PCF-Category:** incremental",
        "**PCF-Category**: BUG",
        "PCF-Category: **INVEST-NOW**",
        "- PCF-Category: BUG",
        "pcf-category: bug",
      ].map((b) => readCategoryFromBody(b).category),
    expectDeep: ["INCREMENTAL", "BUG", "INVEST-NOW", "BUG", "BUG"],
  },
  {
    predicate: "marker-rejects-an-unqualified-category-line",
    name: "marker REJECT pole — a bare `Category:` prose line is NOT the field",
    reds_under: "MARKER_RE: make the `PCF-` qualifier optional",
    run: () => readCategoryFromBody("Category: BUG").state,
    expectDeep: "UNCATEGORIZED",
  },
  {
    predicate: "marker-rejects-a-mid-line-mention",
    name: "marker REJECT pole — the field name inside prose is not a declaration",
    reds_under: "MARKER_RE: drop the `^` line anchor",
    run: () =>
      readCategoryFromBody("we discussed PCF-Category: BUG in review").state,
    expectDeep: "UNCATEGORIZED",
  },
  {
    predicate: "marker-value-stops-at-the-first-word",
    name: "marker — a trailing rationale after the category is ignored, not merged into it",
    reds_under: "firstWord(): return the whole captured remainder",
    run: () => readCategoryFromBody("PCF-Category: BUG — the gate fails closed"),
    expect: { state: "CATEGORIZED", category: "BUG" },
  },

  // ── where the body comes from on the argv ───────────────────────────────────
  {
    predicate: "body-spec-reads-both-inline-spellings",
    name: "argv — `--body x`, `-b x` and `--body=x` all resolve to the inline body",
    reds_under: "extractBodySpec(): drop the attached-form or short-flag branch",
    run: () => [
      extractBodySpec(["--body", "A"]),
      extractBodySpec(["-b", "B"]),
      extractBodySpec(["--body=C"]),
    ],
    expectDeep: [
      { kind: "inline", value: "A" },
      { kind: "inline", value: "B" },
      { kind: "inline", value: "C" },
    ],
  },
  {
    predicate: "body-spec-does-not-read-a-flag-value-as-a-flag",
    name: "argv REJECT pole — a `--title` whose VALUE is the string `--body` does not become the body",
    reds_under: "extractBodySpec(): drop the GH_PR_CREATE_VALUE_FLAGS skip",
    run: () => extractBodySpec(["--title", "--body", "--body", "real"]),
    expectDeep: { kind: "inline", value: "real" },
  },
  {
    predicate: "body-spec-marks-fill-as-derived",
    name: "argv — `--fill` derives the body from commits, so there is no text to read",
    reds_under: "extractBodySpec(): drop the --fill branch",
    run: () => extractBodySpec(["--fill"]).kind,
    expectDeep: "derived",
  },
  {
    predicate: "body-file-read-through-the-injected-seam",
    name: "argv — a readable `--body-file` is parsed like an inline body",
    reds_under: "classifyPrCreate(): stop dispatching the file branch to the reader",
    run: () =>
      classifyPrCreate("gh pr create --body-file body.md", {
        readBodyFile: () => "PCF-Category: INCREMENTAL",
      }),
    expect: { state: "CATEGORIZED", category: "INCREMENTAL" },
  },
  {
    predicate: "body-file-unreadable-fails-closed-to-not-verified",
    name: "argv REJECT pole — an unreadable `--body-file` is NOT_VERIFIED, never UNCATEGORIZED",
    reds_under: "classifyPrCreate(): treat a null reader result as an empty body",
    run: () =>
      classifyPrCreate("gh pr create --body-file body.md", {
        readBodyFile: () => null,
      }).state,
    expectDeep: "NOT_VERIFIED",
  },

  // ── applicability: the question must not be asked of the wrong command ──────
  {
    predicate: "not-applicable-on-a-non-pr-create",
    name: "applicability — a command that opens no PR returns null, not a state",
    reds_under: "classifyPrCreate(): drop the findGhSubcommand guard",
    run: () => [
      classifyPrCreate("git push"),
      classifyPrCreate("gh pr list --search create"),
      classifyPrCreate('echo "gh pr create --body x"'),
    ],
    expectDeep: [null, null, null],
  },
  {
    predicate: "applicable-through-a-shell-wrapper",
    name: "applicability ACCEPT pole — a wrapped `sh -c 'gh pr create …'` is still a PR create",
    reds_under: "classifyPrCreate(): bypass the shared parser and regex the string",
    run: () =>
      classifyPrCreate(`sh -c 'gh pr create --body "PCF-Category: BUG"'`).state,
    expectDeep: "CATEGORIZED",
  },
  {
    predicate: "not-applicable-on-a-help-invocation",
    name: "applicability REJECT pole — `--help`/`-h` creates no PR, so no verdict is owed",
    reds_under: "classifyPrCreate(): drop the GH_NON_CREATING_FLAGS guard",
    run: () => [
      classifyPrCreate("gh pr create --help"),
      classifyPrCreate("gh pr create -h"),
      classifyPrCreate("gh pr create --title t --help"),
    ],
    expectDeep: [null, null, null],
  },
  {
    predicate: "help-guard-does-not-swallow-a-real-create",
    name: "applicability ACCEPT pole — the help guard does not silence a genuine create",
    reds_under: "GH_NON_CREATING_FLAGS: widen it to match any flag, or substring-match",
    run: () =>
      classifyPrCreate(
        `gh pr create --title "help the user" --body "PCF-Category: BUG"`,
      ),
    expect: { state: "CATEGORIZED", category: "BUG" },
  },
  {
    predicate: "prefilter-is-sound-never-skips-a-real-match",
    name: "prefilter — agrees with the PARSER on every corpus command (equivalence, not a heuristic)",
    reds_under:
      "prefilterCouldMatch(): drop a conjunct, or gate on a token the parser does not require",
    run: () => {
      // The property: prefilter FALSE ⇒ the parser would not have matched. A
      // disagreement in that direction is a silently skipped PR create.
      const corpus = [
        `gh pr create --body x`,
        `sh -c 'gh pr create --body x'`,
        `git add -A && gh pr create --title t --body x`,
        `GH_TOKEN=x gh pr create --body y`,
        `/usr/local/bin/gh pr create --body y`,
        `gh --repo o/r pr create --body y`,
        `gh pr list`,
        `git push`,
        `echo create`,
        `cat > a.js <<E\nnothing\nE`,
        `gh issue create --body y`,
        `PR=1 gh pr view 3`,
        ``,
      ];
      const unsound = corpus.filter(
        (c) => !prefilterCouldMatch(c) && findGhSubcommand(c, "pr", "create") !== null,
      );
      return { unsound, checked: corpus.length };
    },
    expect: { unsound: [], checked: 13 },
  },
  {
    predicate: "prefilter-actually-rejects-the-hot-payload",
    name: "prefilter — a large heredoc payload with no gh/pr/create is rejected before the parser",
    reds_under: "prefilterCouldMatch(): return true unconditionally",
    run: () =>
      prefilterCouldMatch(
        Array(500).fill("cat > a.js <<E\n.claude/state/roster.json\nE").join("\n"),
      ),
    expectDeep: false,
  },
  {
    predicate: "title-is-not-the-body",
    name: "applicability REJECT pole — a category in the TITLE does not categorize the PR",
    reds_under: "extractBodySpec(): read --title as a body source",
    run: () =>
      classifyPrCreate(
        'gh pr create --title "PCF-Category: BUG" --body "no marker"',
      ).state,
    expectDeep: "UNCATEGORIZED",
  },

  // ── the advisory the hook renders ───────────────────────────────────────────
  {
    predicate: "advisory-is-silent-on-a-categorized-pr",
    name: "advisory — a CATEGORIZED verdict emits NOTHING (non-discrimination is what gets a hook ignored)",
    reds_under: "formatCategoryAdvisory(): drop the CATEGORIZED early return",
    run: () => formatCategoryAdvisory(readCategoryFromBody("PCF-Category: BUG")),
    expectDeep: null,
  },
  {
    predicate: "advisory-names-the-state-and-the-enum",
    name: "advisory — a non-categorized verdict names its state AND the three valid values",
    reds_under: "formatCategoryAdvisory(): drop the enum line",
    run: () => {
      const msg = formatCategoryAdvisory(readCategoryFromBody("no marker"));
      return {
        namesState: msg.includes("UNCATEGORIZED"),
        namesEnum: PCF_CATEGORIES.every((c) => msg.includes(c)),
      };
    },
    expect: { namesState: true, namesEnum: true },
  },
  // ── the CAUSE TAXONOMY (loom#1803) ─────────────────────────────────────────
  // The scope-restriction predicate under test here is: WHICH cause a given
  // situation is reported as. A wrong edit widens or narrows it silently — and
  // the whole point of the taxonomy is that every code carries a DIFFERENT fix,
  // so a case that only asserted "it refused" would pass against a guard that
  // reported one cause for everything, which is the pre-#1803 behaviour.
  {
    predicate: "every-cause-code-is-pinned-to-its-own-situation",
    name: "cause IDENTITY lock — each of the 20 codes is asserted BY NAME against a situation only it may claim",
    reds_under:
      "any mis-assignment of a cause at its call site, e.g. a cyclic permutation of MARKER_ABSENT / VALUE_NOT_IN_ENUM / VALUE_EMPTY / MARKERS_CONFLICT / BODY_TEXT_MISSING / COMMAND_UNRESOLVABLE at their five assignment sites — the exact scramble that shipped 50/50 GREEN before this case existed",
    // The row label is carried INTO the compared value, so the failure diff
    // names WHICH code was mis-assigned and what it was mis-assigned to,
    // rather than printing two unlabelled twenty-element arrays.
    run: () => CAUSE_IDENTITY_TABLE.map((r) => `${r.code} => ${idOf(r.run())}`),
    expectDeep: CAUSE_IDENTITY_TABLE.map((r) => `${r.code} => ${r.expect}`),
  },
  {
    predicate: "the-identity-table-covers-the-whole-enum-and-nothing-else",
    name: "cause IDENTITY completeness — the table's code set EQUALS PCF_CAUSES, so a new code cannot ship unpinned",
    reds_under:
      "PCF_CAUSES: add a code (or delete one) without adding/removing its row in CAUSE_IDENTITY_TABLE",
    // Without this, the identity lock above degrades silently: a twenty-first
    // cause would be introduced with no situation, and the set would stay green
    // while carrying exactly the blindness this fix exists to remove.
    run: () => {
      const declared = new Set(Object.keys(PCF_CAUSES));
      const pinned = new Set(CAUSE_IDENTITY_TABLE.map((r) => r.code));
      return {
        unpinned: [...declared].filter((c) => !pinned.has(c)).sort(),
        stale: [...pinned].filter((c) => !declared.has(c)).sort(),
        pinnedCount: pinned.size,
        rowCount: CAUSE_IDENTITY_TABLE.length,
      };
    },
    // 20 is a LITERAL, not `Object.keys(PCF_CAUSES).length` — an expectation
    // computed from the subject agrees with it by construction
    // (`evidence-first-claims.md` MUST-5, self-derived oracle).
    expect: { unpinned: [], stale: [], pinnedCount: 20, rowCount: 20 },
  },
  {
    predicate: "cause-taxonomy-is-a-frozen-identity-map",
    name: "cause enum — PCF_CAUSES is frozen and every key maps to its OWN name (no aliasing)",
    reds_under:
      "PCF_CAUSES: point two keys at one value, or unfreeze the table so a consumer can rewrite a code at runtime",
    run: () => ({
      frozen: Object.isFrozen(PCF_CAUSES),
      // an alias (`VALUE_EMPTY: "VALUE_NOT_IN_ENUM"`) would make two distinct
      // fixes indistinguishable in the emitted advisory
      nonIdentity: Object.entries(PCF_CAUSES)
        .filter(([k, v]) => k !== v)
        .map(([k]) => k),
      distinctValues: new Set(Object.values(PCF_CAUSES)).size,
    }),
    expect: { frozen: true, nonIdentity: [], distinctValues: 20 },
  },
  {
    predicate: "cause-outside-root-is-named-even-when-the-file-exists",
    name: "cause ACCEPT pole — an out-of-root path that DOES exist reports OUTSIDE_ROOT, not MISSING",
    reds_under:
      "readBodyFileDiagnosed(): drop the lexical out-of-root branch, so the stat's ENOENT/EACCES wins the message",
    run: () => causeOf(join(OUTSIDE, "body.md")),
    expectDeep: PCF_CAUSES.BODY_FILE_OUTSIDE_ROOT,
  },
  {
    predicate: "cause-outside-root-does-not-swallow-an-in-root-read",
    name: "cause REJECT pole — an in-root readable file is NOT reported outside the root (no cause at all)",
    reds_under:
      "readBodyFileDiagnosed(): invert the containment test, or compare against the wrong root",
    run: () => causeOf(join(ROOT, "good.md")),
    expectDeep: null,
  },
  {
    predicate: "cause-escapes-containment-is-distinct-from-outside-root",
    name: "cause — a lexically-in-root symlink whose TARGET escapes gets its own code (different fix)",
    reds_under:
      "readBodyFileDiagnosed(): drop the post-realpath containment re-test, or fold it onto OUTSIDE_ROOT",
    run: () => causeOf(join(ROOT, "escape.md")),
    expectDeep: PCF_CAUSES.BODY_FILE_ESCAPES_CONTAINMENT,
  },
  {
    predicate: "cause-missing-vs-written-by-this-command",
    name: "cause — an absent path reports MISSING, but WRITTEN_BY_THIS_COMMAND when the same line writes it",
    reds_under:
      "pathWrittenByCommand(): return false unconditionally, or drop the ENOENT branch that consults it",
    run: () => [
      causeOf(join(ROOT, "nope.md"), "gh pr create -F nope.md"),
      causeOf(
        join(ROOT, "nope.md"),
        "cat > nope.md <<'EOF'\nPCF-Category: BUG\nEOF\ngh pr create -F nope.md && rm -f nope.md",
      ),
      causeOf(join(ROOT, "nope.md"), "printf x | tee nope.md && gh pr create -F nope.md"),
    ],
    expectDeep: [
      PCF_CAUSES.BODY_FILE_MISSING,
      PCF_CAUSES.BODY_FILE_WRITTEN_BY_THIS_COMMAND,
      PCF_CAUSES.BODY_FILE_WRITTEN_BY_THIS_COMMAND,
    ],
  },
  {
    predicate: "cause-write-detection-does-not-fire-on-a-mere-mention",
    name: "cause REJECT pole — a path merely NAMED in the command is not 'written by' it",
    reds_under:
      "pathWrittenByCommand(): substring-match the path instead of anchoring on a redirect or tee",
    run: () =>
      causeOf(join(ROOT, "nope.md"), "cat nope.md; gh pr create -F nope.md"),
    expectDeep: PCF_CAUSES.BODY_FILE_MISSING,
  },
  {
    predicate: "cause-unreadable-covers-the-non-enoent-errnos",
    name: "cause — ELOOP and ENOTDIR are UNREADABLE, not MISSING (the path is there, the read is not possible)",
    reds_under:
      "readBodyFileDiagnosed(): route every catch to the ENOENT branch",
    run: () => [
      causeOf(join(ROOT, "loop.md")),
      causeOf(join(ROOT, "plain.md", "child.md")),
    ],
    expectDeep: [PCF_CAUSES.BODY_FILE_UNREADABLE, PCF_CAUSES.BODY_FILE_UNREADABLE],
  },
  {
    predicate: "cause-not-a-file-and-too-large-are-distinct",
    name: "cause — a directory and an over-cap file are two codes, not one 'unreadable'",
    reds_under: "readBodyFileDiagnosed(): merge the isFile() and size branches",
    run: () => [causeOf(join(ROOT, "adir")), causeOf(join(ROOT, "big.md"))],
    expectDeep: [PCF_CAUSES.BODY_FILE_NOT_A_FILE, PCF_CAUSES.BODY_FILE_TOO_LARGE],
  },
  {
    predicate: "cause-empty-path-and-unresolvable-root",
    name: "cause — an empty --body-file value and an unresolvable ROOT are their own codes",
    reds_under:
      "readBodyFileDiagnosed(): drop the empty-path guard or the root realpath try/catch",
    run: () => [
      causeOf(""),
      readBodyFileDiagnosed("x.md", join(SANDBOX, "no", "such", "root")).cause,
    ],
    expectDeep: [PCF_CAUSES.BODY_FILE_PATH_EMPTY, PCF_CAUSES.ROOT_UNRESOLVABLE],
  },
  {
    predicate: "cause-substitution-names-the-token-and-its-line",
    name: "cause — a substitution refusal carries the offending token, line and column",
    reds_under: "locateSubstitution(): return only a boolean, or drop the line math",
    run: () => {
      const v = readCategoryFromBody("## Summary\ndetail\nsee $(git log) here");
      return {
        state: v.state,
        cause: v.cause,
        token: locateSubstitution("a\nb $(x)").token,
        line: locateSubstitution("a\nb $(x)").line,
        column: locateSubstitution("a\nb $(x)").column,
        namesTokenInReason: v.reason.includes("$("),
        namesLineInReason: v.reason.includes("line 3"),
      };
    },
    expect: {
      state: "NOT_VERIFIED",
      cause: "BODY_SUBSTITUTION",
      token: "$(",
      line: 2,
      column: 3,
      namesTokenInReason: true,
      namesLineInReason: true,
    },
  },
  {
    predicate: "cause-substitution-does-not-fire-on-a-backtick-span",
    name: "cause REJECT pole — an inline `code` span is NOT a substitution (the stated scope holds)",
    reds_under: "SUBSTITUTION_RE: add a backtick alternative",
    run: () => [
      locateSubstitution("use `gh pr view` here"),
      readCategoryFromBody("use `gh pr view`\nPCF-Category: BUG").state,
    ],
    expectDeep: [null, "CATEGORIZED"],
  },
  {
    predicate: "source-distinguishes-an-inline-body-from-a-file-body",
    name: "source — the same refusal reports inline vs file, because the two have different fixes",
    reds_under: "readCategoryFromBody(): drop the `source` parameter and hard-code one value",
    run: () => [
      classifyPrCreate(`gh pr create --body "see $(x)"`).source,
      classifyPrCreate("gh pr create --body-file b.md", {
        readBodyFile: () => "see $(x)",
      }).source,
      classifyPrCreate("gh pr create --fill").source,
      classifyPrCreate("gh pr create --title t").source,
    ],
    expectDeep: ["inline", "file", "derived", "absent"],
  },
  {
    predicate: "every-refusal-names-a-cause-none-is-anonymous",
    name: "cause — every NOT_VERIFIED situation carries a cause code, and no two situations share one wrongly",
    reds_under: "verdict(): default the cause argument, or pass it through unset",
    run: () => {
      const causes = [
        classifyPrCreate(`gh pr create --body "$(x)"`),
        classifyPrCreate("gh pr create --fill"),
        classifyPrCreate("gh pr create --title t"),
        classifyPrCreate("gh pr create --body-file b.md", { readBodyFile: () => null }),
        classifyPrCreate(`gh pr create --body-file ${join(OUTSIDE, "body.md")}`, {
          repoRoot: ROOT,
        }),
        classifyPrCreate(`gh pr create --body-file ${join(ROOT, "adir")}`, {
          repoRoot: ROOT,
        }),
      ].map((v) => v.cause);
      return { causes, anyMissing: causes.some((c) => !c), distinct: new Set(causes).size };
    },
    expect: {
      causes: [
        "BODY_SUBSTITUTION",
        "BODY_DERIVED",
        "BODY_ABSENT",
        "BODY_FILE_UNREAD",
        "BODY_FILE_OUTSIDE_ROOT",
        "BODY_FILE_NOT_A_FILE",
      ],
      anyMissing: false,
      distinct: 6,
    },
  },
  {
    predicate: "naming-a-cause-never-changes-the-verdict",
    name: "NO-WEAKENING LOCK — every unreadable situation is still NOT_VERIFIED; only the prose changed",
    reds_under:
      "classifyPrCreate(): let any named cause fall through to UNCATEGORIZED or CATEGORIZED",
    run: () =>
      [
        `gh pr create --body "$(x)"`,
        "gh pr create --fill",
        "gh pr create --title t",
        `gh pr create --body-file ${join(OUTSIDE, "body.md")}`,
        `gh pr create --body-file ${join(ROOT, "escape.md")}`,
        `gh pr create --body-file ${join(ROOT, "nope.md")}`,
        `gh pr create --body-file ${join(ROOT, "adir")}`,
        `gh pr create --body-file ${join(ROOT, "big.md")}`,
        `gh pr create --body-file ${join(ROOT, "loop.md")}`,
        "gh pr create --body-file ''",
      ].map((c) => classifyPrCreate(c, { repoRoot: ROOT }).state),
    expectDeep: Array(10).fill("NOT_VERIFIED"),
  },
  {
    predicate: "the-must-not-flag-case-a-readable-categorized-body-stays-silent",
    name: "MUST-NOT-FLAG pole — a readable in-root body with a valid category draws NO advisory at all",
    reds_under:
      "any change that makes a cause-bearing branch fire on a healthy read (e.g. the containment test comparing against the wrong root)",
    run: () => {
      const v = classifyPrCreate(
        `gh pr create --title t --body-file ${join(ROOT, "good.md")}`,
        { repoRoot: ROOT },
      );
      return {
        state: v.state,
        category: v.category,
        cause: v.cause,
        advisory: formatCategoryAdvisory(v),
        remediation: formatCategoryRemediation(v),
      };
    },
    expect: {
      state: "CATEGORIZED",
      category: "BUG",
      cause: "CATEGORY_DECLARED",
      advisory: null,
      remediation: null,
    },
  },
  {
    predicate: "remediation-never-advises-a-second-pr-create-on-not-verified",
    name: "remedy — a NOT_VERIFIED remedy sends the reader to the PUBLISHED body, never to a re-issue",
    reds_under:
      "formatCategoryRemediation(): restore the old static 'Re-issue the command' line for NOT_VERIFIED",
    run: () => {
      const nv = formatCategoryRemediation(
        classifyPrCreate(`gh pr create --body-file ${join(OUTSIDE, "body.md")}`, {
          repoRoot: ROOT,
        }),
      );
      return {
        warnsAgainstReissue: /Do NOT re-issue `gh pr create`/.test(nv),
        namesDuplicateRisk: /DUPLICATE/.test(nv),
        sendsToPublishedBody: /gh pr view <n> --json body/.test(nv),
        namesTheCauseSpecificFix: /CAUSE-SPECIFIC FIX/.test(nv),
      };
    },
    expect: {
      warnsAgainstReissue: true,
      namesDuplicateRisk: true,
      sendsToPublishedBody: true,
      namesTheCauseSpecificFix: true,
    },
  },
  {
    predicate: "remediation-differs-per-cause-not-one-message-for-all",
    name: "remedy REJECT pole — two different causes do NOT produce the same remedy text",
    reds_under: "formatCategoryRemediation(): collapse the switch to a single default",
    run: () => {
      const texts = [
        `gh pr create --body-file ${join(OUTSIDE, "body.md")}`,
        `gh pr create --body-file ${join(ROOT, "nope.md")}`,
        `gh pr create --body "$(x)"`,
        "gh pr create --fill",
      ].map((c) => formatCategoryRemediation(classifyPrCreate(c, { repoRoot: ROOT })));
      return { count: texts.length, distinct: new Set(texts).size };
    },
    expect: { count: 4, distinct: 4 },
  },
  {
    predicate: "advisory-carries-the-cause-code-and-the-detail",
    name: "advisory — the rendered message names the cause CODE and the concrete detail, not just the state",
    reds_under: "formatCategoryAdvisory(): drop the cause or detail interpolation",
    run: () => {
      const v = classifyPrCreate(
        `gh pr create --body-file ${join(OUTSIDE, "body.md")}`,
        { repoRoot: ROOT },
      );
      const msg = formatCategoryAdvisory(v);
      return {
        namesCause: msg.includes("BODY_FILE_OUTSIDE_ROOT"),
        // the CANONICAL root, which is the root the guard actually read
        // against — see the symlinked-prefix case below for why the two spellings
        // are not interchangeable.
        namesRootTried: msg.includes(fs.realpathSync(ROOT)),
        namesState: msg.includes("NOT VERIFIED"),
      };
    },
    expect: { namesCause: true, namesRootTried: true, namesState: true },
  },
  {
    predicate: "a-symlinked-root-prefix-does-not-make-an-in-root-file-unreadable",
    name: "cause REJECT pole — a root reached through a symlinked PREFIX still reads its own files",
    reds_under:
      "readBodyFileDiagnosed(): reintroduce a LEXICAL out-of-root rejection ahead of realpathSync",
    run: () => {
      // The root under test is `LINK_ROOT`: a symlink BUILT BY THIS FILE whose
      // own basename differs from its target's, so its given and canonical
      // spellings differ on EVERY platform. That is the whole fix here — the
      // first cut of this lock used the tmpdir spelling and got its difference
      // from the host: on macOS default TMPDIR (`/var/...` → `/private/var/...`)
      // it fired, and under `TMPDIR=/private/tmp` — and on the Linux runner the
      // fixture set actually executes on — tmpdir is already canonical, so the
      // SAME reintroduced bug shipped 50/50 green and the "permanent" lock was
      // inert exactly where CI runs.
      //
      // Both spellings must read identically, and the PAIR is the point:
      // asserting only the canonical spelling would pass against the broken
      // version.
      const canonicalRoot = fs.realpathSync(LINK_ROOT);
      const viaSymlinkedRoot = classifyPrCreate(
        `gh pr create -F ${join(LINK_ROOT, "good.md")}`,
        { repoRoot: LINK_ROOT },
      );
      const viaCanonicalRoot = classifyPrCreate(
        `gh pr create -F ${join(canonicalRoot, "good.md")}`,
        { repoRoot: canonicalRoot },
      );
      // Retained from the first cut: the tmpdir spelling, which on macOS is the
      // `/var` vs `/private/var` case the original bug was found on. It is
      // platform-dependent and therefore NOT the lock — the symlinked root is —
      // but it costs nothing and is a second real spelling.
      const viaTmpdirRoot = classifyPrCreate(
        `gh pr create -F ${join(ROOT, "good.md")}`,
        { repoRoot: ROOT },
      );
      return {
        symlinkedRootSpelling: viaSymlinkedRoot.state,
        canonicalRootSpelling: viaCanonicalRoot.state,
        tmpdirRootSpelling: viaTmpdirRoot.state,
        prefixesDiffer: canonicalRoot !== LINK_ROOT,
      };
    },
    // `prefixesDiffer` is ASSERTED, not merely recorded. It is the REACH PROOF
    // for this lock: true means the given and canonical roots really did differ,
    // so a lexical comparison HAD the opportunity to get it wrong. Asserting it
    // means the case REDS if the construction ever stops producing a differing
    // prefix, rather than silently degrading to the trivial half — which is what
    // the tmpdir-derived first cut did on every canonical-tmpdir platform
    // (`instrument-discipline.md` MUST-3a, `evidence-first-claims.md` MUST-6).
    expect: {
      symlinkedRootSpelling: "CATEGORIZED",
      canonicalRootSpelling: "CATEGORIZED",
      tmpdirRootSpelling: "CATEGORIZED",
      prefixesDiffer: true,
    },
  },
  {
    predicate: "detail-is-sanitized-like-every-other-echoed-value",
    name: "advisory — an author-controlled --body-file path cannot inject a fence or a newline via the detail",
    reds_under: "verdict(): stop routing `detail` through sanitizeDetail",
    run: () => {
      const v = classifyPrCreate(
        "gh pr create --body-file '/etc/`evil`\nINJECTED.md'",
        { repoRoot: ROOT },
      );
      return {
        state: v.state,
        noBacktick: !/`/.test(v.detail || ""),
        noControl: !/[\x00-\x1f]/.test(v.detail || ""),
      };
    },
    expect: { state: "NOT_VERIFIED", noBacktick: true, noControl: true },
  },

  // ── the INVOKING DIRECTORY, not the session directory (loom#1990) ──────────
  // A gate that cannot read its subject is worse than no gate. These six cases
  // are BIPOLAR by pair: each green pole is accompanied by the red that proves
  // the green is not simply "everything passes now".
  {
    predicate: "body-file-resolves-against-the-invoking-worktree",
    name: "wrong-root GREEN pole — a relative --body-file in a worktree reached by `cd` is READ, not reported missing",
    reds_under:
      "readBodyFileDiagnosed(): resolve the path against `repoRoot` (the session cwd) instead of the cd-trail directory — i.e. the pre-fix behaviour",
    run: () => {
      const v = classifyPrCreate(
        `cd ${REPO_WT} && gh pr create --title t --body-file body.md`,
        { repoRoot: REPO_MAIN },
      );
      return {
        id: idOf(v),
        category: v.category,
        // REACH PROOF: the two directories really are different, so resolving
        // against the wrong one HAD the opportunity to fail. Asserted, not
        // recorded — if the sandbox ever collapsed them the case would RED
        // rather than degrade to the trivial half.
        rootsDiffer: REPO_MAIN !== REPO_WT,
      };
    },
    expect: {
      id: "CATEGORIZED/CATEGORY_DECLARED",
      category: "BUG",
      rootsDiffer: true,
    },
  },
  {
    predicate: "containment-follows-repository-identity-not-one-root",
    name: "wrong-root GREEN pole — an ABSOLUTE path in a sibling worktree of the SAME repo is contained (absolute never fixed this)",
    reds_under:
      "readBodyFileDiagnosed(): drop the same-common-dir arm of `inside()`, so containment is the session root alone — the pre-fix behaviour that made an absolute path report OUTSIDE_ROOT",
    run: () =>
      idOf(
        classifyPrCreate(`gh pr create -F ${join(REPO_WT, "body.md")}`, {
          repoRoot: REPO_MAIN,
        }),
      ),
    expectDeep: "CATEGORIZED/CATEGORY_DECLARED",
  },
  {
    predicate: "an-absent-body-file-in-a-worktree-still-refuses",
    name: "wrong-root RED pole — a body file that genuinely does not exist is STILL NOT_VERIFIED/BODY_FILE_MISSING",
    reds_under:
      "readBodyFileDiagnosed(): treat an unresolvable path as an empty body, or route the ENOENT branch to UNCATEGORIZED — the fail-OPEN this fix must not introduce",
    // The failure IDENTITY, not merely "something was emitted": the cause is
    // asserted as a literal, so a fix that widened the root by reporting a
    // DIFFERENT refusal (or none) reds here.
    run: () => [
      idOf(
        classifyPrCreate(`cd ${REPO_WT} && gh pr create -F nope.md`, {
          repoRoot: REPO_MAIN,
        }),
      ),
      idOf(
        classifyPrCreate(`gh pr create -F ${join(REPO_WT, "nope.md")}`, {
          repoRoot: REPO_MAIN,
        }),
      ),
    ],
    expectDeep: [
      "NOT_VERIFIED/BODY_FILE_MISSING",
      "NOT_VERIFIED/BODY_FILE_MISSING",
    ],
  },
  {
    predicate: "containment-widening-stops-at-the-repository-boundary",
    name: "wrong-root REJECT pole — another repository's worktree, and a plain directory, are still OUTSIDE_ROOT",
    reds_under:
      "checkoutOf(): return a constant common dir (or drop the equality test) so any checkout counts as the session's own — the widening-to-anywhere failure",
    run: () => [
      idOf(
        classifyPrCreate(`gh pr create -F ${join(OTHER_WT, "body.md")}`, {
          repoRoot: REPO_MAIN,
        }),
      ),
      idOf(
        classifyPrCreate(`gh pr create -F ${join(OUTSIDE, "body.md")}`, {
          repoRoot: REPO_MAIN,
        }),
      ),
    ],
    expectDeep: [
      "NOT_VERIFIED/BODY_FILE_OUTSIDE_ROOT",
      "NOT_VERIFIED/BODY_FILE_OUTSIDE_ROOT",
    ],
  },
  {
    predicate: "an-untrackable-cd-trail-falls-back-and-never-invents-a-root",
    name: "wrong-root fail direction — a `cd` inside a pipeline is NOT applied; the verdict falls back to today's refusal",
    reds_under:
      "resolveCdTrailDir(): apply a `cd` from a pipeline or a mixed `&&`/`;` chain, guessing at a directory the shell may never enter",
    // `cd | cat` runs the cd in a SUBSHELL, so the gh call runs in the ORIGINAL
    // directory. Guessing otherwise would read a file the command never names —
    // the false positive this walk's conservatism exists to prevent.
    run: () =>
      idOf(
        classifyPrCreate(`cd ${REPO_WT} | cat ; gh pr create -F body.md`, {
          repoRoot: REPO_MAIN,
        }),
      ),
    expectDeep: "NOT_VERIFIED/BODY_FILE_MISSING",
  },
  {
    predicate: "a-cd-after-the-gh-invocation-is-not-applied-to-it",
    name: "wrong-root ordering — only the `cd`s that PRECEDE `gh pr create` move the directory it runs in",
    reds_under:
      "readBodyFileDiagnosed(): drop the `stopWhen` bound on the cd-trail walk, so a LATER `cd` retroactively relocates an EARLIER command",
    run: () => [
      idOf(
        classifyPrCreate(`gh pr create -F body.md ; cd ${REPO_WT}`, {
          repoRoot: REPO_MAIN,
        }),
      ),
      idOf(
        classifyPrCreate(`cd ${REPO_WT} ; gh pr create -F body.md`, {
          repoRoot: REPO_MAIN,
        }),
      ),
    ],
    expectDeep: [
      "NOT_VERIFIED/BODY_FILE_MISSING",
      "CATEGORIZED/CATEGORY_DECLARED",
    ],
  },
  {
    predicate: "advisory-sanitizes-an-echoed-token",
    name: "advisory — an echoed rejected token cannot inject a newline or open a code fence",
    reds_under: "sanitizeObserved(): drop the control-char or backtick pass",
    run: () => {
      const msg = formatCategoryAdvisory(
        readCategoryFromBody("PCF-Category: `x`\x07evil"),
      );
      return { noBacktick: !msg.includes("`x`"), noControl: !/[\x00-\x1f]/.test(msg) };
    },
    expect: { noBacktick: true, noControl: true },
  },
];

// ── run ───────────────────────────────────────────────────────────────────────

/** Subset match on `expect` (load-bearing fields only); `expectDeep` pins the
 *  WHOLE return, which is what the array- and scalar-returning cases need. */
function matches(got, c) {
  if (Object.prototype.hasOwnProperty.call(c, "expectDeep")) {
    return JSON.stringify(got) === JSON.stringify(c.expectDeep);
  }
  const expect = c.expect;
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
  if (matches(got, c)) {
    console.log(`PASS  [${c.predicate}] ${c.name}`);
  } else {
    failures++;
    const want = Object.prototype.hasOwnProperty.call(c, "expectDeep")
      ? c.expectDeep
      : c.expect;
    console.error(
      `FAIL  [${c.predicate}] ${c.name}\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`,
    );
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} fixtures passed`);
process.exit(failures === 0 ? 0 : 1);
