#!/usr/bin/env node
/**
 * probe-ancestor-load.mjs — the runnable sentinel probe for `rules/worktree-isolation.md`
 * Rule 7 / loom#1370 / loom#1368.
 *
 * WHAT QUESTION THIS ANSWERS
 * --------------------------
 * Does a CC session rooted at a worktree NESTED under a repo load that repo's `.claude/`
 * corpus IN ADDITION to its own — i.e. does the same rule arrive TWICE, under two distinct
 * paths? Measured 2026-07-26 on CC 2.1.220: YES for path-scoped (`priority: >0`) rules,
 * NO for `CLAUDE.md` and baseline (`priority: 0`) rules. Full matrix:
 * `skills/30-claude-code-patterns/worktree-orchestration.md` § Ancestor-Load Measurement.
 *
 * WHY A SCRIPT AND NOT A PROSE PROTOCOL
 * -------------------------------------
 * The 2026-07-22 answer to this question was WITHDRAWN as unsupported: it compared aggregate
 * TOKEN COUNTS across roots, found them roughly equal, and read that as "no duplication".
 * A size comparison CANNOT detect duplication when the two corpora are byte-identical —
 * loading the same bytes twice is exactly what "roughly equal" looks like to that instrument.
 * It could not have returned a different answer under either hypothesis, so it was evidence
 * for neither. Re-deriving the correct instrument from scratch each time is how that mistake
 * recurs; this script IS the instrument, committed.
 *
 * THE INSTRUMENT — root-distinguishing, not aggregate
 * --------------------------------------------------
 * Sentinels planted at ONE root only, and UNTRACKED. Untracked is the load-bearing property:
 * a git worktree checkout materialises COMMITTED content, so an untracked file at the outer
 * root provably CANNOT exist in the nested worktree's checkout. Any appearance of an
 * ancestor-only token in a session rooted at the worktree is therefore ancestor loading, with
 * no alternative explanation. Planting BEFORE any session starts is what additionally defeats
 * the "the baseline set is snapshotted at session start" confound for the baseline class.
 *
 * WHAT THIS SCRIPT DOES AND DOES NOT DO
 * -------------------------------------
 * Steps 1-4 and 6a (scaffold + assert the on-disk asymmetry) are fully automated here.
 * Steps 5 and 6b require a LIVE top-level CC session rooted at each candidate directory and
 * cannot be driven from inside another session — the script prints the exact launch commands
 * and the verbatim introspection prompt to use. Report BY INTROSPECTION, never by grep: a
 * grep tells you what is on disk, which is not the question.
 *
 * NOTE ON THE DELIBERATE NESTED WORKTREE
 * -------------------------------------
 * Step 2 creates a worktree at `.claude/worktrees/w1` INSIDE the scaffold repo. That is the
 * condition under test, not a Rule 7 violation: the scaffold is a throwaway repo under the
 * system temp dir, never loom itself, and nesting is the very thing being measured.
 *
 * USAGE
 *   node .claude/bin/probe-ancestor-load.mjs --help
 *   node .claude/bin/probe-ancestor-load.mjs --build [<dir>]    # scaffold + assert asymmetry
 *   node .claude/bin/probe-ancestor-load.mjs --verify <dir>     # re-assert asymmetry only
 *   node .claude/bin/probe-ancestor-load.mjs --clean <dir>      # remove the scaffold
 *
 * Exit 0 = the scaffold is sound and the asymmetry holds. Non-zero = the instrument is NOT
 * sound; any measurement taken with it is ZERO evidence (`evidence-first-claims.md` MUST-3).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TOK = {
  ownClaudeMd: "TOKEN-OWN-CLAUDEMD",
  ownBaseline: "TOKEN-OWN-BASELINE",
  ownScoped: "TOKEN-OWN-SCOPED",
  ancClaudeMd: "TOKEN-ANC-CLAUDEMD",
  ancBaseline: "TOKEN-ANC-BASELINE",
  ancScoped: "TOKEN-ANC-SCOPED",
};
const ANC_PREFIX = "TOKEN-ANC-";
const OWN_PREFIX = "TOKEN-OWN-";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .trim();
}

function write(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function help() {
  console.log(`probe-ancestor-load.mjs — sentinel probe for worktree ancestor-load (Rule 7)

The instrument is a ROOT-DISTINGUISHING sentinel, never an aggregate size or token count.
An aggregate comparison is structurally blind to duplication of byte-identical corpora and
is DISQUALIFIED as evidence for this question.

Sentinels are planted UNTRACKED at the outer root only. Untracked is load-bearing: a git
worktree checkout materialises COMMITTED content, so an untracked outer-root file provably
cannot exist in the nested worktree. They are planted BEFORE any session starts, which
defeats the "baseline is snapshotted at session start" confound.

MODES
  --build [<dir>]   Scaffold the two-root probe repo and assert the on-disk asymmetry.
                    Default <dir>: a fresh mkdtemp under the system temp dir.
  --verify <dir>    Re-assert the on-disk asymmetry for an existing scaffold.
  --clean <dir>     Remove a scaffold.
  --help            This text.

WHAT IS AUTOMATED / WHAT IS NOT
  Automated: scaffold, commit, nested worktree, sibling control, untracked ancestor plant,
            and the asymmetry gate (step 4).
  Manual:   the two live CC sessions (steps 5 + 6b). A session cannot root another session;
            --build prints the exact launch commands and the introspection prompt.

Full protocol + the measured matrix:
  .claude/skills/30-claude-code-patterns/worktree-orchestration.md
  § Ancestor-Load Measurement
`);
}

function build(dirArg) {
  const root = dirArg
    ? path.resolve(dirArg)
    : fs.mkdtempSync(path.join(os.tmpdir(), "loom-ancestor-probe-"));
  const outer = path.join(root, "outer-repo");
  const sibling = path.join(root, "sibling-wt");
  const nested = path.join(outer, ".claude", "worktrees", "w1");

  if (fs.existsSync(outer)) {
    console.error(`REFUSING: ${outer} already exists — pass a fresh dir or --clean it first.`);
    process.exit(2);
  }

  // ── 1. outer repo with a COMMITTED .claude corpus ──────────────────────────────
  fs.mkdirSync(outer, { recursive: true });
  git(outer, ["init", "-q", "-b", "main"]);
  git(outer, ["config", "user.email", "probe@example.invalid"]);
  git(outer, ["config", "user.name", "ancestor-load-probe"]);
  // Hermetic: never inherit the operator's commit.gpgsign — on a CI runner gpg
  // launches pinentry, which cannot prompt, and every fixture commit fails.
  // Set on the outer repo's config, which every worktree added below shares, so
  // the whole scaffold is hermetic — including the git commands an operator runs
  // inside it during the live steps 5/6b.
  git(outer, ["config", "commit.gpgsign", "false"]);
  git(outer, ["config", "tag.gpgsign", "false"]);

  write(
    path.join(outer, "CLAUDE.md"),
    `# Probe scaffold\n\nOwn-root CLAUDE.md marker: ${TOK.ownClaudeMd}\n`,
  );
  write(
    path.join(outer, ".claude", "rules", "probe-baseline.md"),
    `---\npriority: 0\nscope: baseline\n---\n\n# Probe baseline rule\n\nOwn-root baseline marker: ${TOK.ownBaseline}\n`,
  );
  write(
    path.join(outer, ".claude", "rules", "probe-scoped.md"),
    `---\npriority: 10\nscope: path-scoped\npaths:\n  - "src/**"\n---\n\n# Probe path-scoped rule\n\nOwn-root path-scoped marker: ${TOK.ownScoped}\n`,
  );
  // The trigger file for the path-scoped glob — the session reads this to fire injection.
  write(path.join(outer, "src", "trigger.txt"), "read me to trigger the src/** glob\n");
  git(outer, ["add", "-A"]);
  git(outer, ["commit", "-q", "-m", "probe scaffold: committed .claude corpus"]);

  // ── 2. the NESTED worktree (the condition under test) ──────────────────────────
  git(outer, ["worktree", "add", "-q", "-b", "probe-nested", nested, "HEAD"]);

  // ── 2b. the SIBLING control, OUTSIDE the repo ──────────────────────────────────
  git(outer, ["worktree", "add", "-q", "-b", "probe-sibling", sibling, "HEAD"]);

  // ── 3. plant UNTRACKED ancestor-only sentinels at the OUTER root only ──────────
  // Untracked + never committed => provably absent from every worktree checkout.
  fs.appendFileSync(
    path.join(outer, "CLAUDE.md"),
    `\nAncestor-only CLAUDE.md marker: ${TOK.ancClaudeMd}\n`,
  );
  write(
    path.join(outer, ".claude", "rules", "probe-anc-baseline.md"),
    `---\npriority: 0\nscope: baseline\n---\n\n# Ancestor-only baseline rule\n\nAncestor-only baseline marker: ${TOK.ancBaseline}\n`,
  );
  write(
    path.join(outer, ".claude", "rules", "probe-anc-scoped.md"),
    `---\npriority: 10\nscope: path-scoped\npaths:\n  - "src/**"\n---\n\n# Ancestor-only path-scoped rule\n\nAncestor-only path-scoped marker: ${TOK.ancScoped}\n`,
  );

  const res = verify(root, { quiet: true });
  if (!res.ok) {
    console.error("SCAFFOLD UNSOUND:\n" + res.problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }

  console.log(`Scaffold built and asymmetry ASSERTED.

  root     ${root}
  outer    ${outer}
  nested   ${nested}      (worktree INSIDE the repo — the condition under test)
  sibling  ${sibling}     (worktree OUTSIDE the repo — the control)

On-disk asymmetry (step 4) holds: no '${ANC_PREFIX}*' token exists in either worktree.

────────────────────────────────────────────────────────────────────────────────
STEP 5 — NESTED. Launch a TOP-LEVEL session rooted at the nested worktree:

    cd "${nested}" && claude

STEP 6b — SIBLING control. In a SEPARATE top-level session:

    cd "${sibling}" && claude

In EACH session, first read ./src/trigger.txt (this fires the src/** path-scoped glob),
then paste this prompt VERBATIM:

    Report BY INTROSPECTION only — do NOT grep, do NOT read any file to answer this.
    List every instruction/rule block currently injected into your context. For each,
    give its verbatim ABSOLUTE path as shown to you, and every TOKEN-OWN-* /
    TOKEN-ANC-* marker it contains. Then state explicitly whether ANY single token
    appears under MORE THAN ONE path.

EXPECTED (measured 2026-07-26, CC 2.1.220):
  nested   TOKEN-OWN-SCOPED appears TWICE, under two distinct paths, AND
           TOKEN-ANC-SCOPED appears in full. TOKEN-ANC-CLAUDEMD / TOKEN-ANC-BASELINE ABSENT.
  sibling  each TOKEN-OWN-* exactly ONCE; no TOKEN-ANC-* at all.

A 'did not reproduce' verdict produced by comparing aggregate sizes or token counts is a
finding about the instrument, NOT a clearance for the claim.

Clean up:  node .claude/bin/probe-ancestor-load.mjs --clean "${root}"
────────────────────────────────────────────────────────────────────────────────`);
  return 0;
}

function verify(rootArg, { quiet = false } = {}) {
  const root = path.resolve(rootArg);
  const outer = path.join(root, "outer-repo");
  const nested = path.join(outer, ".claude", "worktrees", "w1");
  const sibling = path.join(root, "sibling-wt");
  const problems = [];

  for (const [label, p] of [["outer", outer], ["nested", nested], ["sibling", sibling]]) {
    if (!fs.existsSync(p)) problems.push(`${label} root missing: ${p}`);
  }

  // The ancestor sentinels MUST exist at the outer root...
  const ancFiles = [
    path.join(outer, ".claude", "rules", "probe-anc-baseline.md"),
    path.join(outer, ".claude", "rules", "probe-anc-scoped.md"),
  ];
  for (const f of ancFiles) {
    if (!fs.existsSync(f)) problems.push(`ancestor sentinel missing: ${f}`);
  }

  // ...and MUST be UNTRACKED (a tracked sentinel would be checked out into the worktrees,
  // destroying the only property that makes an appearance unambiguous).
  if (fs.existsSync(outer)) {
    let tracked = "";
    try {
      tracked = git(outer, ["ls-files", "--", ".claude/rules/probe-anc-baseline.md",
        ".claude/rules/probe-anc-scoped.md"]);
    } catch {
      /* handled by the existence checks above */
    }
    if (tracked) problems.push(`ancestor sentinels are TRACKED (must be untracked): ${tracked}`);
  }

  // Step 4 gate: no ancestor token may exist anywhere under either worktree.
  for (const [label, wt] of [["nested", nested], ["sibling", sibling]]) {
    if (!fs.existsSync(wt)) continue;
    const hits = grepTokenFiles(wt, ANC_PREFIX);
    if (hits.length) {
      problems.push(
        `${label} worktree CONTAINS ancestor tokens (asymmetry broken): ${hits.join(", ")}`,
      );
    }
  }

  // POSITIVE half (loom#1432). The gate above is one-sided: "zero ANC tokens"
  // is trivially satisfied by an EMPTY tree, so a worktree that was pruned,
  // cleaned, or never fully materialised passed as "sound" while every sentinel
  // whose double-load is the entire question was gone. An operator would then
  // observe TOKEN-OWN-SCOPED exactly ONCE and read a degenerate scaffold as a
  // negative result — the same false-clearance class the 2026-07-22 withdrawal
  // was about. Assert the own-root sentinels are PRESENT in both worktrees.
  for (const [label, wt] of [["nested", nested], ["sibling", sibling]]) {
    if (!fs.existsSync(wt)) continue;
    const ownHits = grepTokenFiles(wt, OWN_PREFIX);
    if (!ownHits.length) {
      problems.push(
        `${label} worktree contains NO '${OWN_PREFIX}*' token — the scaffold is degenerate ` +
          `(pruned/unmaterialised), so "zero ancestor tokens" proves nothing`,
      );
    }
  }

  const ok = problems.length === 0;
  if (!quiet) {
    if (ok) {
      console.log(`Asymmetry ASSERTED for ${root}:
  - ancestor sentinels present at the outer root
  - ancestor sentinels are UNTRACKED (cannot be materialised into any worktree)
  - zero '${ANC_PREFIX}*' occurrences under the nested worktree
  - zero '${ANC_PREFIX}*' occurrences under the sibling worktree
  - own-root '${OWN_PREFIX}*' sentinels ARE present in both worktrees (scaffold is not degenerate)
The instrument is sound; a session's introspection report is now interpretable.`);
    } else {
      console.error("Asymmetry NOT established:\n" + problems.map((p) => `  - ${p}`).join("\n"));
      console.error(
        "\nThe instrument is UNSOUND. Any measurement taken with it is ZERO evidence.",
      );
    }
  }
  return { ok, problems };
}

/** Recursive file scan for a token — deliberately dependency-free and .git-skipping. */
function grepTokenFiles(dir, token, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === ".git") continue;
      grepTokenFiles(p, token, acc);
    } else if (ent.isFile()) {
      let body = "";
      try {
        body = fs.readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (body.includes(token)) acc.push(p);
    }
  }
  return acc;
}

function clean(rootArg) {
  const root = path.resolve(rootArg);
  const outer = path.join(root, "outer-repo");
  if (!fs.existsSync(root)) {
    console.error(`nothing to clean: ${root}`);
    return 1;
  }
  // Refuse to clean anything that is not recognisably a probe scaffold.
  if (!fs.existsSync(path.join(outer, ".claude", "rules", "probe-scoped.md"))) {
    console.error(
      `REFUSING: ${root} does not look like a probe scaffold ` +
        "(no outer-repo/.claude/rules/probe-scoped.md).",
    );
    return 2;
  }
  try {
    git(outer, ["worktree", "remove", "--force", path.join(root, "sibling-wt")]);
  } catch {
    /* best effort */
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`removed ${root}`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    help();
    return 0;
  }
  const i = argv.findIndex((a) => a.startsWith("--"));
  const mode = argv[i];
  const arg = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;

  switch (mode) {
    case "--build":
      return build(arg);
    case "--verify":
      if (!arg) {
        console.error("--verify requires <dir>");
        return 2;
      }
      return verify(arg).ok ? 0 : 1;
    case "--clean":
      if (!arg) {
        console.error("--clean requires <dir>");
        return 2;
      }
      return clean(arg);
    default:
      console.error(`unknown mode: ${mode}`);
      help();
      return 2;
  }
}

process.exit(main());
