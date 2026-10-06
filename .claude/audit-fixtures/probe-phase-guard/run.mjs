#!/usr/bin/env node
/**
 * probe-phase-guard — fixture runner (F51 residue; loom#2044 Group A).
 *
 * Four fixtures, four predicates, ONE guard: `.claude/hooks/probe-phase-guard.js`.
 * The corpus is FAMILY A (disposition), so it drives through the shared
 * `runDispositionSuite` in ../hook-fixture-runner.mjs; only the staging is local.
 *
 * WHAT WAS UNEXECUTED. This directory held four `input.json` + `expected.txt`
 * pairs and no `run.mjs`, so it sat outside run-audit-fixtures.mjs's closure
 * (which is over the `run.mjs` convention) and nothing ever compared the pinned
 * dispositions against the hook. `tests/integration/` does not carry a
 * probe-phase-guard suite at all, so for THIS guard the corpus was the only
 * fixture-level coverage and it was inert.
 *
 * THE FIXTURES DECLARE A PREDICATE, NOT A WORLD. Each `input.json` carries a
 * `_setup` block naming the filesystem state its predicate requires. SETUPS below
 * materializes exactly that — a real repo, a real lockfile at a real path.
 *
 *   node .claude/audit-fixtures/probe-phase-guard/run.mjs
 *   echo $?     # 0 = all green
 *
 * Override the guard under test (to red the suite against a mutant) with:
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeReporter,
  mkRepo,
  driveHook,
  cleanup,
  runDispositionSuite,
} from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/probe-phase-guard.js");

const { check, finish } = makeReporter();

const LOCK = ".certify-in-probe-abc123def456.lock";

// README.md § "Predicates covered" is the authority on which fixtures exist.
const FIXTURES = [
  "01-block-retrieval-during-probe",
  "02-pass-no-lockfile",
  "03-pass-non-retrieval-tool",
  "04-pass-lockfile-outside-claude-dir",
];

const SETUPS = {
  "01-block-retrieval-during-probe": {
    lockRel: `.claude/${LOCK}`,
    why: '_setup.create_file ".claude/.certify-in-probe-abc123def456.lock" — the lockfile-present + retrieval-tool conjunction is what this fixture pins; it is the ONLY branch of this guard that ships severity:block.',
  },
  "02-pass-no-lockfile": {
    lockRel: null,
    why: "_setup.no_lockfile_in_claude_dir — deliberately staged with the SAME Read payload as 01 so the passthrough is attributable to the LOCKFILE predicate and nothing else.",
  },
  "03-pass-non-retrieval-tool": {
    lockRel: `.claude/${LOCK}`,
    why: "_setup.create_file — the lockfile IS present; only the tool differs (Bash), so a pass here isolates RETRIEVAL_TOOLS. Blocking Bash would deadlock /certify's own lockfile cleanup at probe exit.",
  },
  "04-pass-lockfile-outside-claude-dir": {
    lockRel: `workspaces/_certify/${LOCK}`,
    why: "_setup.create_file at workspaces/_certify/ — a lockfile-SHAPED file outside repo-root .claude/. findProbeLockfile reads `.claude/` direct children only; treating a workspace file as the probe signal would let an attacker spoof probe-active state.",
  },
};

function placeLock(repoDir, rel) {
  if (!rel) return;
  const p = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
}

function stage(name, setup, c) {
  const repoDir = mkRepo(name.slice(0, 2));
  placeLock(repoDir, setup.lockRel);
  const payload = {
    session_id: "probe-phase-guard-audit-fixtures",
    hook_event_name: c.input.hook_event_name,
    tool_name: c.input.tool_name,
    tool_input: {},
    cwd: repoDir,
  };
  for (const [k, v] of Object.entries(c.input.tool_input || {})) {
    payload.tool_input[k] = typeof v === "string" ? v.replace(/<repo>/g, repoDir) : v;
  }
  return {
    repoDir,
    stdinRaw: JSON.stringify(payload),
    bodyMustCite:
      name === "01-block-retrieval-during-probe"
        ? ["probe-phase-guard", LOCK]
        : null,
  };
}

runDispositionSuite({ suiteDir: HERE, hook: HOOK, fixtures: FIXTURES, setups: SETUPS, stage }, check);

// ---- T4: PAIRED CONTROLS — each green attributable to its OWN predicate ------
//
// Every row above is consistent with a degenerate guard: one that passes
// everything satisfies 02/03/04, and 01 alone cannot exclude one that blocks
// everything. Each control flips EXACTLY ONE element of a fixture's declared
// setup and requires the disposition to CHANGE (instrument-discipline.md
// MUST-1 + MUST-3).
console.log("\n=== T4: paired controls — flip one setup element, require the verdict to move ===");

function drive(repoDir, payload) {
  return driveHook(HOOK, { stdinRaw: JSON.stringify(payload), cwd: repoDir });
}

{
  // C1 — 02's PASS is attributable to the LOCKFILE, not to a Read that is
  // somehow un-guarded. Same repo, same payload; only the file appears.
  const repoDir = mkRepo("c1");
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(repoDir, "rules/independence.md") },
    cwd: repoDir,
  };
  const before = drive(repoDir, payload);
  placeLock(repoDir, `.claude/${LOCK}`);
  const after = drive(repoDir, payload);
  check(
    "C1: identical Read payload — lockfile ABSENT ⇒ passthrough / lockfile PRESENT ⇒ BLOCK",
    before.code === 0 && before.tag === "(none)" && after.code === 2 && after.tag === "[BLOCK]",
    `no-lock: exit=${before.code} tag=${before.tag} | with-lock: exit=${after.code} tag=${after.tag}`,
    "identical dispositions = findProbeLockfile is not gating anything. If BOTH pass, the /certify probe gate is off and an operator can be fed the answers while the signed pass-receipt still attests they were not; if BOTH block, every ordinary session's Read is refused.",
  );
}

{
  // C2 — 03's PASS is attributable to the TOOL CLASS. Same repo, same lockfile;
  // only tool_name moves across the RETRIEVAL_TOOLS boundary.
  const repoDir = mkRepo("c2");
  placeLock(repoDir, `.claude/${LOCK}`);
  const bash = drive(repoDir, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: `rm .claude/${LOCK}` },
    cwd: repoDir,
  });
  const read = drive(repoDir, {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(repoDir, "rules/independence.md") },
    cwd: repoDir,
  });
  check(
    "C2: same repo + same lockfile — Bash ⇒ passthrough / Read ⇒ BLOCK",
    bash.code === 0 && bash.tag === "(none)" && read.code === 2 && read.tag === "[BLOCK]",
    `Bash: exit=${bash.code} tag=${bash.tag} | Read: exit=${read.code} tag=${read.tag}`,
    "identical dispositions = the RETRIEVAL_TOOLS membership test is dead. Both blocking deadlocks /certify (the orchestrator cannot Bash the lockfile away at probe exit); both passing means the gate never fires on the tools it exists for.",
  );
}

{
  // C3 — 04's PASS is attributable to the LOCKFILE LOCATION. Same repo, same
  // Read, same lockfile BASENAME; only the directory moves.
  const repoDir = mkRepo("c3");
  placeLock(repoDir, `workspaces/_certify/${LOCK}`);
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(repoDir, "rules/independence.md") },
    cwd: repoDir,
  };
  const outside = drive(repoDir, payload);
  placeLock(repoDir, `.claude/${LOCK}`);
  const inside = drive(repoDir, payload);
  check(
    "C3: same basename — under workspaces/_certify/ ⇒ passthrough / under .claude/ ⇒ BLOCK",
    outside.code === 0 && outside.tag === "(none)" && inside.code === 2 && inside.tag === "[BLOCK]",
    `workspaces/: exit=${outside.code} tag=${outside.tag} | .claude/: exit=${inside.code} tag=${inside.tag}`,
    "identical dispositions = the location pin is gone. A recursive or glob search would let any workspace file named like a lockfile assert probe-active state repo-wide — the spoof the location scope exists to refuse.",
  );
}

cleanup();
finish();
