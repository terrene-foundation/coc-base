#!/usr/bin/env node
/*
 * Audit fixture runner for `detectWorktreeStaleBaseRef` (loom#1501, L4 of the
 * enforcement-registration wave).
 *
 * WHAT IT COVERS, IN TWO ARMS — and why it needs both.
 *
 *   ARM 1 (fixture table). Each `<case>.json` carries `{ args, refs }` and its
 *   `<case>.expected` sidecar carries `flagged` or `clean`. `args` is the
 *   post-`worktree` token remainder parseGitInvocation hands the detector;
 *   `refs` is a stub ref-database consulted through the injected
 *   `readDivergence`, so the ARG-GRAMMAR and VERDICT arms are exercised
 *   deterministically, with no git and no network. One case per
 *   scope-restriction predicate per cc-artifacts.md Rule 9 +
 *   hook-output-discipline.md MUST-4, in BOTH polarities.
 *
 *   ARM 2 (real git). Arm 1 injects the reader, so on its own it says NOTHING
 *   about whether the reader production actually uses can tell a stale ref from
 *   a current one — a green Arm 1 is consistent with a completely broken
 *   `readRefDivergenceFromOrigin`. That is instrument-discipline.md MUST-2(a)
 *   exactly: a green reports on the behaviour it NAMES, and Arm 1 does not name
 *   this one. Arm 2 builds a throwaway repo whose local ref is 2 behind its
 *   origin counterpart and asserts the REAL reader returns the differing
 *   answers — including the null it must return on an absent ref, which is the
 *   fail-open path the whole guard's false-positive discipline rests on.
 *
 * WHY THE FIXTURES LIVE ONE DIRECTORY OVER. The fixture DATA is at
 * `.claude/audit-fixtures/violation-patterns/detectWorktreeStaleBaseRef/`,
 * because that is the location hook-output-discipline.md MUST-4 mandates for a
 * `violation-patterns.js` detector and the location `validate-emit.mjs`'s
 * `audit-fixture-coverage` check enforces (`^flag-` / `^clean-` prefixes,
 * `.expected` sidecars ignored) — putting them anywhere else BLOCKS /sync.
 *
 * The RUNNER lives here, at the top level, because `run-audit-fixtures.mjs`
 * discovers `<dir>/run.mjs` NON-RECURSIVELY: a runner nested inside the
 * violation-patterns family would be invisible to the registry and therefore
 * unwired — which is precisely the loom#1368 defect this wave exists to close,
 * and is why the sibling `violation-patterns/<detector>/test.mjs` family runs in
 * no CI today. One fixture set, both contracts satisfied, no duplication.
 *
 * Exit 0 = every case matched. Exit 1 = >=1 mismatch.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
// The fixture DATA lives in the violation-patterns family (see the header);
// only this runner lives here.
const fixtures = join(
  here,
  "..",
  "violation-patterns",
  "detectWorktreeStaleBaseRef",
);
// CONTENTION IMMUNITY — MUST be set BEFORE the require below, because
// violation-patterns.js reads this into a module-scope const at load time.
// Setting it any later is a silent no-op (caught while writing this, by probing
// the loaded constant rather than trusting the assignment).
//
// The reader's production spawn budget is 2500ms, bounded inside the hook's own
// 5000ms. Under a parallel-agent wave a git spawn in a throwaway repo can exceed
// that, and a timeout is indistinguishable from "refs absent" (both yield null),
// so a loaded machine would red Arm 2 against a perfectly working reader — the
// `codex-dispatcher` flakiness class, where a 5s spawn timeout surfaces as
// `status -1` under load. Raising it removes ONLY the false red: a broken reader
// returns null or the wrong counts however long it is given, and every assertion
// stays strict. Production is unaffected; nothing outside this runner sets it.
process.env.COC_REF_PROBE_TIMEOUT_MS =
  process.env.COC_REF_PROBE_TIMEOUT_MS || "60000";

const require = createRequire(import.meta.url);
const { detectWorktreeStaleBaseRef, readRefDivergenceFromOrigin } = require(
  join(here, "..", "..", "hooks", "lib", "violation-patterns.js"),
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

/* ── ARM 1 — fixture table, injected ref database ───────────────────────── */

// Anti-vacuity floor local to this runner. If the fixture directory is moved,
// renamed, or emptied, an empty loop would exit 0 and read as coverage — the
// bare-exit-0 failure coc-artifact-eval-coverage.md MUST-3 names, which the
// registry's `min_cases` catches only at the aggregate layer. readdirSync is
// caught rather than allowed to throw: an uncaught throw prints a node stack
// with no FAIL case line, which run-audit-fixtures.mjs can only report as an
// `opaque-failure` — still red, but it sends the next reader after a crash
// instead of after the missing directory.
let fixtureFiles = [];
try {
  fixtureFiles = readdirSync(fixtures)
    .filter((n) => n.endsWith(".json"))
    .sort();
} catch (e) {
  fail(
    "fixture-discovery",
    `cannot read fixture directory ${fixtures}: ${e.message}`,
  );
}
if (fixtureFiles.length === 0) {
  fail("fixture-discovery", `no .json fixtures found under ${fixtures}`);
}

for (const name of fixtureFiles) {
  const caseName = name.replace(/\.json$/, "");
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(fixtures, name), "utf8"));
  } catch (e) {
    fail(caseName, `fixture is not valid JSON: ${e.message}`);
    continue;
  }
  const expected = readFileSync(
    join(fixtures, `${caseName}.expected`),
    "utf8",
  ).trim();
  if (expected !== "flagged" && expected !== "clean") {
    fail(
      caseName,
      `.expected must be "flagged" or "clean", got ${JSON.stringify(expected)}`,
    );
    continue;
  }

  // The stub is deliberately TOTAL over the fixture's declared refs and returns
  // null for anything else — same contract as the real reader's unresolvable
  // arm, so a parser that extracts the WRONG token surfaces as a verdict flip
  // rather than as a crash.
  const readDivergence = (ref) =>
    Object.prototype.hasOwnProperty.call(spec.refs || {}, ref)
      ? spec.refs[ref]
      : null;

  const hit = detectWorktreeStaleBaseRef(spec.args, "/nonexistent", {
    readDivergence,
  });
  const actual = hit ? "flagged" : "clean";
  if (actual !== expected) {
    fail(
      caseName,
      `expected ${expected}, got ${actual} (args=${JSON.stringify(spec.args)}, hit=${JSON.stringify(hit)})`,
    );
    continue;
  }
  if (hit) {
    // A flag is only correct if it is a flag ON THE RIGHT REF. Without this the
    // `-b`/`--reason`/`--` grammar cases would pass while extracting the branch
    // name instead of the base ref.
    const wantRef = spec.expect_ref || null;
    if (wantRef && hit.ref !== wantRef) {
      fail(
        caseName,
        `flagged on ref ${JSON.stringify(hit.ref)}, expected ${JSON.stringify(wantRef)}`,
      );
      continue;
    }
    // hook-output-discipline.md MUST-2: this detector must NEVER emit block.
    if (hit.severity !== "halt-and-report") {
      fail(
        caseName,
        `severity must be halt-and-report, got ${JSON.stringify(hit.severity)}`,
      );
      continue;
    }
  }
  pass(
    caseName,
    `${actual}${hit ? ` ref=${hit.ref} behind=${hit.behind}` : ""}`,
  );
}

/* ── ARM 1b — the env-override CLAMP ─────────────────────────────────────── */
//
// `REF_PROBE_TIMEOUT_MS` is resolved at MODULE LOAD, so each case needs its own
// process. Without the clamp, `=0` yields 0 — the documented "no timeout" value,
// i.e. an unbounded synchronous spawn on the PreToolUse hot path — and `=abc`
// yields NaN, whose throw is swallowed into `return null`, silently inerting the
// detector. Neither is loud and there is no backstop (validate-bash-command.js
// clears its own 5s timer BEFORE validateBashCommand runs), so the clamp is the
// only thing between a typo'd env value and a dead or hanging guard.
{
  const LIB = join(here, "..", "..", "hooks", "lib", "violation-patterns.js");
  const read = (val) => {
    const env = { ...process.env };
    if (val === undefined) delete env.COC_REF_PROBE_TIMEOUT_MS;
    else env.COC_REF_PROBE_TIMEOUT_MS = val;
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(String(require(${JSON.stringify(LIB)}).REF_PROBE_TIMEOUT_MS))`,
      ],
      { env, encoding: "utf8" },
    );
    return r.stdout.trim();
  };
  const CLAMP_CASES = [
    ["unset", undefined, "2500"],
    ["empty-string", "", "2500"],
    ["zero-would-mean-no-timeout", "0", "2500"],
    ["negative", "-5", "2500"],
    ["non-numeric-would-be-NaN", "abc", "2500"],
    ["above-ceiling", "999999", "4500"],
    ["in-range-honoured", "1200", "1200"],
  ];
  for (const [name, val, want] of CLAMP_CASES) {
    const got = read(val);
    if (got === want)
      pass(`clamp-${name}`, `${JSON.stringify(val)} → ${got}ms`);
    else
      fail(
        `clamp-${name}`,
        `env=${JSON.stringify(val)} expected ${want}ms, got ${JSON.stringify(got)}`,
      );
  }
}

/* ── ARM 2 — the REAL reader against a real repo ────────────────────────── */

let tmp = null;
try {
  tmp = mkdtempSync(join(tmpdir(), "wt-stale-base-"));
  const git = (cwd, ...a) =>
    execFileSync("git", ["-C", cwd, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  const bare = join(tmp, "remote.git");
  const work = join(tmp, "work");
  execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", work], { stdio: "ignore" });
  git(work, "config", "user.email", "fixture@example.invalid");
  git(work, "config", "user.name", "fixture");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "commit", "-q", "--allow-empty", "-m", "c1");
  git(work, "branch", "-M", "mainline");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "-u", "origin", "mainline");
  // `current` stays in sync; `mainline` is rewound behind its remote.
  git(work, "branch", "current");
  git(work, "push", "-q", "-u", "origin", "current");
  git(work, "commit", "-q", "--allow-empty", "-m", "c2");
  git(work, "commit", "-q", "--allow-empty", "-m", "c3");
  git(work, "push", "-q", "origin", "mainline");
  git(work, "update-ref", "refs/heads/mainline", "HEAD~2");

  const behind = readRefDivergenceFromOrigin("mainline", work);
  if (behind && behind.ahead === 0 && behind.behind === 2) {
    pass("real-git-stale-ref-reports-behind", `ahead=0 behind=2`);
  } else {
    fail(
      "real-git-stale-ref-reports-behind",
      `expected {ahead:0,behind:2}, got ${JSON.stringify(behind)}`,
    );
  }

  // The DISCRIMINATION arm: the same reader on a ref that is NOT stale must
  // return the other answer. Without this, a reader hard-coded to report
  // "behind" would pass the case above.
  const upToDate = readRefDivergenceFromOrigin("current", work);
  if (upToDate && upToDate.ahead === 0 && upToDate.behind === 0) {
    pass("real-git-current-ref-reports-zero", "ahead=0 behind=0");
  } else {
    fail(
      "real-git-current-ref-reports-zero",
      `expected {ahead:0,behind:0}, got ${JSON.stringify(upToDate)}`,
    );
  }

  // Fail-OPEN: an absent ref must yield null, never a flag. This is the arm the
  // guard's whole false-positive discipline rests on.
  const absent = readRefDivergenceFromOrigin("no-such-branch", work);
  if (absent === null) {
    pass("real-git-absent-ref-fails-open-null");
  } else {
    fail(
      "real-git-absent-ref-fails-open-null",
      `expected null, got ${JSON.stringify(absent)}`,
    );
  }

  // End-to-end through the DEFAULT reader (no injection at all) — the exact
  // call shape validate-bash-command.js makes.
  const e2e = detectWorktreeStaleBaseRef("add ../lane mainline", work);
  if (e2e && e2e.ref === "mainline" && e2e.behind === 2) {
    pass("real-git-end-to-end-default-reader", `behind=${e2e.behind}`);
  } else {
    fail(
      "real-git-end-to-end-default-reader",
      `expected a finding on mainline behind=2, got ${JSON.stringify(e2e)}`,
    );
  }

  const e2eClean = detectWorktreeStaleBaseRef("add ../lane current", work);
  if (e2eClean === null) {
    pass("real-git-end-to-end-default-reader-clean");
  } else {
    fail(
      "real-git-end-to-end-default-reader-clean",
      `expected null on an up-to-date ref, got ${JSON.stringify(e2eClean)}`,
    );
  }

  /* ── ARM 3 — the DISPATCHER, through the real hook process ─────────────── */
  //
  // Arms 1 and 2 both enter at `detectWorktreeStaleBaseRef`, i.e. AFTER
  // parseGitInvocation has already extracted `args` and `dir`. Every one of the
  // 17 table cases does. So the entire layer that decides WHETHER to call the
  // detector — segmentation, doc-carrier masking, subcommand routing, and which
  // DIRECTORY the probe reads — had no coverage at all, and that is the layer
  // where both of this branch's real defects lived:
  //
  //   * prose false positives (a `git worktree add …` inside a quoted `--body`),
  //     which a quote-UNAWARE split hands to the detector as a live command;
  //   * probing the SESSION cwd for a command that targets another repo via a
  //     `cd <dir> &&` prefix — wrong in BOTH directions, and the false-positive
  //     direction is the one hook-output-discipline.md MUST-2 forbids outright.
  //
  // instrument-discipline.md MUST-2(a): a green Arm 1 reports on the behaviour
  // it NAMES, and it does not name this one. So this arm drives the REAL hook as
  // a subprocess over stdin — the exact interface Claude Code uses — and asserts
  // both polarities, including a second repo that shares a branch name so a
  // directory mix-up cannot pass as a correct verdict.
  let repoSeq = 0;
  // Build a repo at an ARBITRARY path whose `mainline` is `behind` commits
  // behind its own origin (behind=0 → in sync). Taking the path as a parameter
  // is what lets the guard cases below put a real stale repo at a directory
  // literally named `-` or `$TARGET`.
  const mkRepo = (dir, behind) => {
    const remote = join(tmp, `remote-${repoSeq++}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    git(dir, "config", "user.email", "fixture@example.invalid");
    git(dir, "config", "user.name", "fixture");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "commit", "-q", "--allow-empty", "-m", "c1");
    // SAME branch name across every fixture repo, deliberately: this is what
    // makes a wrong-directory probe visible as a verdict flip rather than
    // passing silently because the ref simply did not resolve.
    git(dir, "branch", "-M", "mainline");
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "-u", "origin", "mainline");
    for (let k = 0; k < behind; k++) {
      git(dir, "commit", "-q", "--allow-empty", "-m", `ahead-${k}`);
    }
    if (behind > 0) {
      git(dir, "push", "-q", "origin", "mainline");
      git(dir, "update-ref", "refs/heads/mainline", `HEAD~${behind}`);
    }
    return dir;
  };

  const clean = mkRepo(join(tmp, "clean"), 0);

  // ── the `cd`-guard trap layout ─────────────────────────────────────────────
  //
  // WHY THESE DIRECTORY NAMES. An earlier cut of these cases put the unresolvable
  // operands (`$TARGET`, `-`) in a tree where `path.resolve(<cwd>, "$TARGET")`
  // named NOTHING. They passed — and kept passing with the guard DELETED, because
  // the verdict came from the fail-open "that is not a repo" path, not from the
  // guard. A test that passes with the code it tests removed asserts nothing
  // (instrument-discipline.md MUST-2(b)).
  //
  // So each unresolvable operand gets a REAL STALE REPO at exactly the path a
  // naive `path.resolve` would produce. Now removing the guard makes the probe
  // land on a genuinely stale repo and FLAG, and the case reds.
  const trap = join(tmp, "trap");
  mkdirSync(trap, { recursive: true });
  mkRepo(join(trap, "-"), 3);
  mkRepo(join(trap, "$TARGET"), 3);
  mkRepo(join(trap, "~"), 3);
  mkRepo(join(trap, "--"), 3);
  // `cd <file>` FAILS, so the shell stays where it was. Put a stale repo at the
  // cwd and a plain FILE at the operand: a walk that applies the failed `cd`
  // reports clean, a walk that keeps the shell's real directory flags.
  const filecwd = mkRepo(join(tmp, "filecwd"), 4);
  writeFileSync(join(filecwd, "notadir"), "x\n");

  const HOOK = join(here, "..", "..", "hooks", "validate-bash-command.js");
  const fires = (cmd, hookCwd) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: cmd },
        cwd: hookCwd,
      }),
      encoding: "utf8",
      timeout: 60000,
    });
    // The finding is surfaced in additionalContext; anything else is "silent".
    // Parsed, not grepped, so a malformed hook payload fails loudly here.
    let ctx = "";
    try {
      ctx =
        (JSON.parse(r.stdout || "{}").hookSpecificOutput || {})
          .additionalContext || "";
    } catch {
      return `unparseable-stdout:${String(r.stdout).slice(0, 80)}`;
    }
    return /STALE local base ref/.test(ctx) ? "flagged" : "clean";
  };

  const DISPATCH_CASES = [
    // ── the detector must reach a real invocation ──
    [
      "dispatch-bare-stale",
      "git worktree add ../lane mainline",
      work,
      "flagged",
    ],
    [
      "dispatch-bare-current",
      "git worktree add ../lane current",
      work,
      "clean",
    ],
    // Correct form — remote-tracking base is behind=0 BY CONSTRUCTION.
    [
      "dispatch-origin-prefixed",
      "git worktree add ../lane origin/mainline",
      work,
      "clean",
    ],
    // A fully-qualified ref is a legitimate spelling, not an evasion. Before the
    // normalizer this interpolated to `refs/heads/refs/heads/mainline`, git
    // exited 128, and the detector went silent on a command it must flag.
    [
      "dispatch-fully-qualified-ref",
      "git worktree add ../lane refs/heads/mainline",
      work,
      "flagged",
    ],
    // ── prose carriers: a quoted payload is NOT a command ──
    [
      "dispatch-prose-gh-issue-body",
      'gh issue create --body "before; git worktree add ../lane mainline; after"',
      work,
      "clean",
    ],
    [
      "dispatch-prose-commit-message",
      'git commit -m "fix: step && git worktree add ../lane mainline now"',
      work,
      "clean",
    ],
    [
      "dispatch-prose-echo",
      'echo "docs && git worktree add ../lane mainline done"',
      work,
      "clean",
    ],
    // ── WHICH repo the probe reads ──
    [
      "dispatch-dash-C-targets-stale",
      `git -C ${work} worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    [
      "dispatch-dash-C-targets-clean",
      `git -C ${clean} worktree add ../lane mainline`,
      work,
      "clean",
    ],
    [
      "dispatch-cd-targets-stale",
      `cd ${work} && git worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    [
      "dispatch-cd-targets-clean",
      `cd ${clean} && git worktree add ../lane mainline`,
      work,
      "clean",
    ],
    // An unresolvable `cd` must DECLINE to probe. Falling back to the session
    // cwd — or naively resolving the literal operand — is exactly the false
    // positive above. Each of these runs from `trap/`, where a REAL STALE repo
    // sits at the path a naive resolve would name, so "clean" is only reachable
    // by actually declining.
    [
      "dispatch-cd-unresolvable-var",
      "cd $TARGET && git worktree add ../lane mainline",
      trap,
      "clean",
    ],
    [
      "dispatch-cd-dash-is-oldpwd",
      "cd - && git worktree add ../lane mainline",
      trap,
      "clean",
    ],
    [
      "dispatch-cd-tilde-is-home",
      "cd ~ && git worktree add ../lane mainline",
      trap,
      "clean",
    ],
    [
      "dispatch-cd-double-dash-is-home",
      "cd -- && git worktree add ../lane mainline",
      trap,
      "clean",
    ],
    [
      "dispatch-cd-bare-is-home",
      "cd && git worktree add ../lane mainline",
      work,
      "clean",
    ],
    // `cd <file>` fails; the shell stays in the stale repo, so the add DOES run
    // there. A walk that applies the failed cd reports clean — the miss this
    // asserts against.
    [
      "dispatch-cd-to-a-file-leaves-shell-put",
      "cd notadir ; git worktree add ../lane mainline",
      filecwd,
      "flagged",
    ],
    // ── separator hygiene: a `cd` the shell may SKIP, or runs in a SUBSHELL ──
    // Each of these places a STALE repo where a naive walk would look and a
    // CURRENT one where the shell actually ends up, so "clean" is only reachable
    // by declining. All three were confirmed as live false positives first.
    //
    // `||` short-circuits: `cd <clean>` succeeds, `cd <work>` never runs.
    [
      "dispatch-cd-or-shortcircuit-no-false-positive",
      `cd ${clean} || cd ${work} ; git worktree add ../lane mainline`,
      clean,
      "clean",
    ],
    // A pipeline puts the `cd` in a SUBSHELL; the add runs in the original dir.
    [
      "dispatch-cd-in-pipeline-no-false-positive",
      `cd ${work} | cat ; git worktree add ../lane mainline`,
      clean,
      "clean",
    ],
    // MIXED `&&` + newline: if `git fetch` fails the cd does not run, but the add
    // does. The "pure && chain is safe by construction" argument does not hold
    // once a `;`/newline joins the chain.
    [
      "dispatch-cd-mixed-and-then-newline-no-false-positive",
      `git fetch origin mainline && cd ${work}\ngit worktree add ../lane mainline`,
      clean,
      "clean",
    ],
    // …and the HOMOGENEOUS shapes must still be trusted, or the hygiene rule has
    // simply disabled the feature. Both of these end in the stale repo for real.
    [
      "dispatch-cd-pure-and-chain-still-trusted",
      `cd ${work} && git fetch origin mainline && git worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    [
      "dispatch-cd-pure-seq-chain-still-trusted",
      `cd ${work} ; git worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    // ── a `heads/<name>` spelling resolves to the branch and must be probed ──
    [
      "dispatch-heads-prefixed-ref",
      "git worktree add ../lane heads/mainline",
      work,
      "flagged",
    ],
    // ── an earlier worktree subcommand must not consume the one-spawn budget ──
    // Each of these is the documented cleanup/inspect-then-add shape. `list`,
    // `remove`, `prune` and a base-less `add` all return null WITHOUT spawning,
    // so breaking on them strands the real stale add behind.
    [
      "dispatch-list-then-stale-add",
      "git worktree list && git worktree add ../lane mainline",
      work,
      "flagged",
    ],
    [
      "dispatch-prune-then-stale-add",
      "git worktree prune ; git worktree add ../lane mainline",
      work,
      "flagged",
    ],
    [
      "dispatch-remove-then-stale-add",
      "git worktree remove ../old && git worktree add ../lane mainline",
      work,
      "flagged",
    ],
    [
      "dispatch-clean-add-then-stale-add",
      "git worktree add ../a current && git worktree add ../b mainline",
      work,
      "flagged",
    ],
    [
      "dispatch-nobase-add-then-stale-add",
      "git worktree add ../a && git worktree add ../b mainline",
      work,
      "flagged",
    ],
    // ── multi-line: a newline separates commands exactly as `;` does ──
    // This is the canonical Rule 7 remedy shape, and it was entirely invisible.
    [
      "dispatch-multiline-fetch-then-stale-add",
      "git fetch origin mainline\ngit worktree add ../lane mainline",
      work,
      "flagged",
    ],
    [
      "dispatch-multiline-cd-then-stale-add",
      `cd ${work}\ngit worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    // ── heredoc bodies are PROSE, not commands ──
    // `cat > file <<'EOF'` writes a FILE; no argument-masking pass covers its
    // body, so the `;`/`&&` inside the prose used to fracture out a `git` segment.
    // This is the repo's own documented authoring shape.
    [
      "dispatch-heredoc-file-body-is-prose",
      "cat > /tmp/l4-fixture-note.md <<'EOF'\nStep 1: fetch; git worktree add ../lane mainline\nEOF",
      work,
      "clean",
    ],
    [
      "dispatch-heredoc-commit-message-is-prose",
      "git commit -F- <<'EOF'\nfix: step && git worktree add ../lane mainline\nEOF",
      work,
      "clean",
    ],
    // …and a REAL add after a heredoc still fires: the masking removes bodies,
    // not commands. Without this the two cases above pass by disabling the lane.
    [
      "dispatch-heredoc-then-real-stale-add",
      "cat > /tmp/l4-fixture-note.md <<'EOF'\njust notes\nEOF\ngit worktree add ../lane mainline",
      work,
      "flagged",
    ],
    // ── an ABSOLUTE -C pins the repo even when the cd trail is unknowable ──
    [
      "dispatch-absolute-C-overrides-unknown-cd",
      `cd $TARGET && git -C ${work} worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    // ── pushd is tracked like cd; popd is not resolvable ──
    [
      "dispatch-pushd-targets-stale",
      `pushd ${work} && git worktree add ../lane mainline`,
      clean,
      "flagged",
    ],
    [
      "dispatch-popd-declines",
      `cd ${work} && popd && git worktree add ../lane mainline`,
      clean,
      "clean",
    ],
    // ── subcommand routing ──
    [
      "dispatch-worktree-remove-not-add",
      "git worktree remove ../lane",
      work,
      "clean",
    ],
  ];
  for (const [name, cmd, hookCwd, want] of DISPATCH_CASES) {
    const got = fires(cmd, hookCwd);
    if (got === want) pass(name, got);
    else
      fail(
        name,
        `expected ${want}, got ${got} (cmd=${JSON.stringify(cmd)}, cwd=${hookCwd})`,
      );
  }
} catch (e) {
  fail("real-git-arm", `setup or execution error: ${e.message}`);
} finally {
  if (tmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

process.stdout.write(
  `\nworktree-stale-base-ref fixtures: ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
