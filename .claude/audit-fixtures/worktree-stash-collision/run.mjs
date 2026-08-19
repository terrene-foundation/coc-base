#!/usr/bin/env node
/*
 * Audit fixtures for the SHARED-STASH COLLISION tripwire — the Phase-2 detector
 * `worktree-isolation.md` Rule 9's Wiring booked and this change graduates
 * (loom#1795).
 *
 * WHAT IS UNDER TEST. `validate-bash-command.js` pairs a MUTATING `git stash`
 * form with a `git worktree list` count > 1 and emits a NON-BLOCKING
 * `pre-action` finding. The predicate halves live in
 * `.claude/hooks/lib/stash-collision.js`; the wiring lives in the hook.
 *
 * THREE ARMS, AND WHY NONE OF THEM IS REDUNDANT.
 *
 *   ARM 1 (selector table, no git). Each `<case>.json` carries a `command` and
 *   its `<case>.expected` sidecar carries `flagged` + the resolved stash `form`,
 *   or `clean`. This arm asks ONLY: does the command-shape half discriminate?
 *   It runs the SAME `selectStashHazard` the hook calls — not a re-implementation
 *   — so a green here is a statement about the shipped selector. It says NOTHING
 *   about the worktree-count half, which it never touches; that is ARM 2's
 *   question, named separately per instrument-discipline.md MUST-4.
 *
 *   ARM 2 (real git, real hook, real worktrees). ARM 1 is consistent with a hook
 *   that never calls the selector at all, with a worktree probe that always
 *   returns 1, and with a finding that is built and then dropped — three ways to
 *   be green and broken. So ARM 2 builds a throwaway repo, adds a LINKED
 *   WORKTREE, and pipes real PreToolUse JSON into the real hook binary for every
 *   case in the table. It asserts the finding is EMITTED for each `flagged` case
 *   and ABSENT for each `clean` one. instrument-discipline.md MUST-3(a): the
 *   instrument is fired at a known-answer case before its silence is read as a
 *   true negative.
 *
 *   ARM 3 (the falsifying pole). ARM 2 alone is consistent with a hook that
 *   fires on EVERY mutating stash regardless of worktree count — which would be
 *   a different, wrong detector that passes every ARM-2 assertion. So ARM 3
 *   re-runs every `flagged` case in a repo with EXACTLY ONE working tree and
 *   asserts SILENCE. This is the arm that makes the worktree-count half
 *   load-bearing rather than decorative; without it the whole suite could not
 *   tell this detector from `grep -q "git stash"`.
 *
 * WHAT NO ARM HERE COVERS, stated rather than implied (instrument-discipline.md
 * MUST-4): the SHELL FORMS the matcher structurally cannot see — a stash hidden
 * behind `$VAR` / `$(…)` in the verb slot, an alias, a shell function, or a
 * script file the hook never reads. Those are limitations of the Bash-boundary
 * vantage point, not gaps in this table, and are recorded in Rule 9's Detection
 * field.
 *
 * NEVER RUNS `git stash` IN A REPOSITORY IT DID NOT CREATE. Every arm operates
 * inside a `mkdtemp` throwaway; the fixtures ASSERT ON THE HOOK'S OUTPUT and do
 * not need the stash to actually execute.
 *
 * Exit 0 = every case matched. Exit 1 = >=1 mismatch.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoClaude = join(here, "..", "..");
const HOOK = join(repoClaude, "hooks", "validate-bash-command.js");

const require = createRequire(import.meta.url);
const { selectStashHazard } = require(
  join(repoClaude, "hooks", "lib", "stash-collision.js"),
);
const { parseGitInvocations } = require(
  join(repoClaude, "hooks", "lib", "git-command-parse.js"),
);

let passed = 0;
let failed = 0;
const pass = (name, detail) => {
  passed++;
  process.stdout.write(`  PASS  ${name}${detail ? ` — ${detail}` : ""}\n`);
};
const fail = (name, detail) => {
  failed++;
  process.stderr.write(`  FAIL  ${name}: ${detail}\n`);
};

/* ── fixture discovery ─────────────────────────────────────────────────────
 * Anti-vacuity floor local to this runner. An empty loop exits 0 and reads as
 * coverage — the bare-exit-0 failure `coc-artifact-eval-coverage.md` MUST-3
 * names, which the registry's `min_cases` catches only in aggregate. readdir is
 * CAUGHT rather than thrown so a missing directory is reported as a FAIL line
 * and not as an opaque node stack.
 */
let names = [];
try {
  names = readdirSync(here)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.replace(/\.json$/, ""))
    .sort();
} catch (e) {
  fail("fixture-discovery", `cannot read ${here}: ${e.message}`);
}
if (names.length === 0) {
  fail("fixture-discovery", `no .json fixtures under ${here}`);
}

const cases = [];
for (const name of names) {
  try {
    const input = JSON.parse(readFileSync(join(here, `${name}.json`), "utf8"));
    const expected = JSON.parse(
      readFileSync(join(here, `${name}.expected`), "utf8"),
    );
    if (typeof input.command !== "string" || !input.command) {
      fail(name, "fixture has no `command`");
      continue;
    }
    if (expected.verdict !== "flagged" && expected.verdict !== "clean") {
      fail(name, `unknown verdict ${JSON.stringify(expected.verdict)}`);
      continue;
    }
    cases.push({ name, command: input.command, expected });
  } catch (e) {
    fail(name, `unreadable fixture pair: ${e.message}`);
  }
}

// BOTH POLES MUST BE POPULATED. A table that drifted to all-clean would pass
// every assertion below while proving the detector can never fire, and a table
// that drifted to all-flagged could not show it is ever silent.
const flagged = cases.filter((c) => c.expected.verdict === "flagged");
const clean = cases.filter((c) => c.expected.verdict === "clean");
if (flagged.length === 0) fail("bipolarity", "no `flagged` cases in the table");
if (clean.length === 0) fail("bipolarity", "no `clean` cases in the table");

/* ── ARM 1 — the selector, no git ──────────────────────────────────────────── */
process.stdout.write("ARM 1 — selectStashHazard (command shape only)\n");
for (const c of cases) {
  const hit = selectStashHazard(parseGitInvocations(c.command));
  if (c.expected.verdict === "flagged") {
    if (!hit) {
      fail(`arm1/${c.name}`, `expected a mutating-stash hit, got none`);
    } else if (hit.form !== c.expected.form) {
      fail(
        `arm1/${c.name}`,
        `resolved form ${JSON.stringify(hit.form)}, expected ${JSON.stringify(c.expected.form)}`,
      );
    } else {
      pass(`arm1/${c.name}`, `form=${hit.form}`);
    }
  } else if (hit) {
    fail(`arm1/${c.name}`, `expected silence, got form=${hit.form}`);
  } else {
    pass(`arm1/${c.name}`, "silent");
  }
}

/* ── shared helpers for the git-backed arms ────────────────────────────────── */
const GIT = "git";
const runGit = (cwd, args) => {
  const r = spawnSync(GIT, args, { cwd, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.status}): ${(r.stderr || "").trim()}`,
    );
  }
  return r.stdout;
};

function makeRepo(root, name) {
  const dir = join(root, name);
  runGit(root, ["init", "-q", name]);
  runGit(dir, ["config", "user.email", "fixture@example.invalid"]);
  runGit(dir, ["config", "user.name", "fixture"]);
  writeGit(dir);
  return dir;
}
function writeGit(dir) {
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  runGit(dir, ["add", "seed.txt"]);
  runGit(dir, ["commit", "-qm", "seed"]);
}

// Fire the REAL hook the way the harness does: PreToolUse JSON on stdin.
// Returns the raw stdout, so the assertion reads the FINDING, not an exit code
// (every non-block severity exits 0, so the exit code cannot discriminate here —
// instrument-discipline.md MUST-1).
const RULE_MARK = "worktree-isolation.md Rule 9";
function hookSays(cwd, command) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, tool_input: { command } }),
    encoding: "utf8",
    timeout: 30000,
  });
  const out = `${r.stdout || ""}`;
  return { fired: out.includes(RULE_MARK), out, status: r.status };
}

const root = mkdtempSync(join(tmpdir(), "stash-collision-fixtures-"));
try {
  /* ── ARM 2 — real hook, repo WITH a linked worktree ──────────────────────── */
  process.stdout.write("ARM 2 — real hook, 2 working trees (the firing pole)\n");
  const multi = makeRepo(root, "multi");
  runGit(multi, ["worktree", "add", "-q", join(root, "multi-wt"), "-b", "side"]);
  // The control for the CONTROL: if this count is not >1 the whole arm is
  // measuring nothing, and every "fired" below would be unexplained.
  const treeLines = runGit(multi, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
  if (treeLines !== 2) {
    fail("arm2/setup", `expected 2 working trees, git reports ${treeLines}`);
  } else {
    pass("arm2/setup", "2 working trees present");
  }
  // A NON-EMPTY shared stack, as the near-miss that motivated this detector had.
  // Depth is CONTEXT in the finding and NOT part of the predicate, so this also
  // pins that the guard does not quietly start depending on it.
  writeFileSync(join(multi, "seed.txt"), "dirty\n");
  runGit(multi, ["stash", "push", "-q", "-m", "fixture-entry"]);

  for (const c of cases) {
    const { fired, status } = hookSays(multi, c.command);
    // `hook: "silent"` is the DECLARED divergence between the two questions:
    // ARM 1 asks whether the COMMAND SHAPE is a mutating stash, ARM 2 asks
    // whether the HOOK speaks — and the hook additionally requires a MEASURED
    // worktree count. A `-C` naming no repository is a mutating stash whose
    // count cannot be taken, so the two answers legitimately differ. Making the
    // divergence a declared field rather than a silent per-arm heuristic keeps
    // each arm's question its own (instrument-discipline.md MUST-4).
    const want =
      c.expected.hook === "silent" ? false : c.expected.verdict === "flagged";
    if (status !== 0) {
      fail(`arm2/${c.name}`, `hook exited ${status} (expected 0 — non-blocking)`);
    } else if (fired === want) {
      pass(`arm2/${c.name}`, want ? "fired" : "silent");
    } else {
      fail(
        `arm2/${c.name}`,
        want ? "expected the finding, hook was SILENT" : "expected silence, hook FIRED",
      );
    }
  }

  /* ── ARM 3 — the falsifying pole: exactly ONE working tree ───────────────── */
  process.stdout.write(
    "ARM 3 — real hook, 1 working tree (the same commands must go SILENT)\n",
  );
  const solo = makeRepo(root, "solo");
  const soloTrees = runGit(solo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;
  if (soloTrees !== 1) {
    fail("arm3/setup", `expected 1 working tree, git reports ${soloTrees}`);
  } else {
    pass("arm3/setup", "1 working tree");
  }
  for (const c of flagged) {
    const { fired, status } = hookSays(solo, c.command);
    if (status !== 0) {
      fail(`arm3/${c.name}`, `hook exited ${status} (expected 0)`);
    } else if (fired) {
      fail(
        `arm3/${c.name}`,
        "FIRED in a single-worktree repo — the worktree-count half is not load-bearing",
      );
    } else {
      pass(`arm3/${c.name}`, "silent (no linked worktree)");
    }
  }
} catch (e) {
  fail("git-arms", `setup failed: ${e.message}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* a leftover tmpdir is not a test result */
  }
}

process.stdout.write(
  `\nworktree-stash-collision: ${passed} passed, ${failed} failed ` +
    `(${cases.length} fixture cases × 2 git-backed arms + selector table)\n`,
);
process.exit(failed === 0 ? 0 : 1);
