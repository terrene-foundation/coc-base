#!/usr/bin/env node
/*
 * Audit-fixture runner for the force-push DIVERGENCE tripwire
 * (`.claude/hooks/lib/force-push-recovery-scope.js` +
 * `.claude/hooks/force-push-recovery-guard.js`), which graduates
 * `orchestration-launch-ledger.md` MUST-6(b) out of Phase 2.
 *
 * THE CONTRACT UNDER TEST IS A MEASUREMENT, NOT A NAME. MUST-6(b) says NEVER
 * force-push a DIVERGED branch and names the command that decides it:
 * `git rev-list --count <branch>..origin/<branch>`. So the question every arm
 * below asks is "how many commits would this push DESTROY", and `recovery/` is
 * the rule's REMEDY rather than an exemption — a diverged `recovery/lane-a`
 * FLAGS and a zero-divergence `feat/wave-3` is CLEAN.
 *
 * FIVE ARMS, and none is optional.
 *
 *   ARM 1 (BIPOLAR predicate table). `cases.json` holds PAIRS, never loose
 *   cases: each pair is one violation pole and one compliant pole differing in
 *   exactly the property named in the pair. The runner asserts BOTH poles AND
 *   asserts they SEPARATE — a pair whose poles return the same verdict is a
 *   non-discriminating instrument and reds here rather than passing as two
 *   independent greens (`instrument-bipolarity.md` MUST-2,
 *   `instrument-discipline.md` MUST-1). BOTH impure reads — the current branch
 *   and the divergence count — are INJECTED, so this arm spawns nothing and is
 *   deterministic. A pole that declares NO divergence gets NO resolver, which
 *   MUST come back UNKNOWN: a fixture cannot buy a green by forgetting to
 *   measure.
 *
 *   ARM 1b (direct `isRecoveryScoped` assertions). Pinned here, and ONLY here,
 *   because the predicate is INFORMATIONAL and decides NO verdict. Its old home
 *   was a pair of bipolar cases that separated on the branch NAME — the rejected
 *   design — and those two pairs are deleted rather than repaired.
 *
 *   ARM 2 (the FALSIFYING RESULT is reachable). UNKNOWN must be distinguishable
 *   from CLEAN in the data, not merely in the prose: every unknown pole is
 *   asserted to be neither `clean` nor `flag`, and to NAME what it could not read.
 *
 *   ARM 3 (end-to-end, the shipped guard as a PROCESS). Arm 1 calls the library
 *   directly, so a green there is fully consistent with a guard that never
 *   reaches it — which is exactly how `dispatch-contract-guard.js` shipped
 *   silently inert with all of its library fixtures green. This arm pipes a real
 *   PreToolUse payload into the real hook, pointed at a throwaway repository with
 *   a KNOWN divergence, and reads its stdout, its exit code, the MEASURED COUNT
 *   in the finding, and whether the emitted line would BLOCK. Exit 0 and
 *   `continue: true` on the violating pole is the SEVERITY assertion: this
 *   detector is advisory by contract, and a future edit that promoted it to
 *   `block` reds here.
 *
 *   ARM 4 (real git, the BRANCH resolver). Arms 1-3 can hand the assessor its
 *   branch, so on their own they say NOTHING about whether the shipped resolver
 *   can read a checkout. This arm builds a throwaway repository, checks out each
 *   branch in turn, and INJECTS the divergence so the arm isolates the branch
 *   read — including the detached-HEAD case, where the falsifying result is
 *   UNKNOWN rather than clean.
 *
 *   ARM 5 (real git, the DIVERGENCE resolver). The instrument itself, against a
 *   real repository, POSITIVE CONTROL FIRST: it must be shown to return a
 *   NON-ZERO count before any zero it prints is read as a true negative
 *   (`instrument-discipline.md` MUST-3(a)). Each unreadable route is asserted to
 *   name WHY. Without this arm the guard could ship a resolver nothing exercises,
 *   which is the `dispatch-contract-guard.js` failure mode one layer down.
 *
 * CONTAINMENT. Every `git` this file runs is refused unless its cwd is inside
 * the throwaway root created below: an unpinned git call is how nine commits once
 * landed on a live repository. The e2e repository is built with
 * init/add/commit/branch/update-ref ONLY — no push, no fetch, no checkout, no
 * reset — and its remote-tracking refs are written DIRECTLY, which is the state a
 * fetch would have produced and needs no network.
 *
 * Exits non-zero on the first mismatch, printing expected vs actual.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const HOOKS = path.join(REPO_ROOT, ".claude", "hooks");
const LIB = require(path.join(HOOKS, "lib", "force-push-recovery-scope.js"));
const GUARD = path.join(HOOKS, "force-push-recovery-guard.js");

let cases = 0;
const failures = [];

// One `PASS <name>` / `FAIL <name>` line PER CASE is load-bearing, not cosmetic:
// `run-audit-fixtures.mjs` counts cases with /^[ \t]*(?:PASS|ok)[ \t]+\S/ and does
// NOT count a summary line. A runner printing only its summary contributes ZERO
// coverage against its declared min_cases while exiting 0 — the state
// `coc-artifact-eval-coverage.md` MUST-3 refuses to read as a pass.
function check(name, expected, actual) {
  cases++;
  if (String(expected).trim() !== String(actual).trim()) {
    failures.push(`  ${name}\n      expected: ${expected}\n      actual:   ${actual}`);
    console.log(`FAIL ${name}`);
  } else {
    console.log(`PASS ${name}`);
  }
}

const resolverFor = (pole) => {
  if (pole.branch_fails) return () => ({ ok: false, why: pole.branch_fails });
  if (pole.branch) return () => ({ ok: true, branch: pole.branch });
  return () => ({ ok: false, why: "no branch resolver was supplied by this fixture" });
};

/**
 * The divergence half of the injected contract. Returns `undefined` — NOT a
 * resolver that answers zero — when the pole declares none, because the library's
 * absent-resolver path is itself under test: a pole that forgets to declare a
 * divergence MUST come back UNKNOWN rather than quietly clean.
 */
const divergenceFor = (pole) => {
  if (pole.divergence_fails) {
    return () => ({
      ok: false,
      reason: pole.divergence_fails,
      why: `fixture-injected measurement failure: ${pole.divergence_fails}`,
    });
  }
  if (pole.divergence_raw !== undefined) {
    // ok:true carrying a count that is NOT a number — success is not an answer.
    return () => ({ ok: true, count: pole.divergence_raw });
  }
  if (pole.divergence !== undefined) {
    const d = pole.divergence;
    if (d !== null && typeof d === "object") {
      return ({ dst }) => ({
        ok: true,
        count: Object.prototype.hasOwnProperty.call(d, dst) ? d[dst] : 0,
        remoteRef: `refs/remotes/origin/${dst}`,
      });
    }
    return ({ dst }) => ({ ok: true, count: d, remoteRef: `refs/remotes/origin/${dst}` });
  }
  return undefined;
};

const assess = (pole) =>
  LIB.assessForcePush(pole.command, {
    resolveBranch: resolverFor(pole),
    resolveDivergence: divergenceFor(pole),
  });

// ── ARM 1 + 1b + 2: the bipolar predicate table ─────────────────────────────

const corpus = JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8"));

for (const pair of corpus.cases) {
  const verdicts = [];
  for (const pole of pair.poles) {
    const a = assess(pole);
    verdicts.push(a.verdict);
    check(`${pair.pair} · ${pole.name} · verdict`, pole.expect, a.verdict);
    check(`${pair.pair} · ${pole.name} · targets`, pole.targets, LIB.describeTargets(a.findings));
  }
  // THE SEPARATION ASSERTION. Two poles that agree are not two passing cases —
  // they are one instrument that cannot tell the property apart.
  check(
    `${pair.pair} · poles SEPARATE on: ${pair.property}`,
    "separated",
    new Set(verdicts).size === verdicts.length ? "separated" : `collapsed onto ${verdicts[0]}`,
  );
}

// ARM 1b — `isRecoveryScoped` is INFORMATIONAL ONLY: it decides NO verdict, and
// this is its honest home. It used to be pinned by two bipolar pairs that
// separated on the branch NAME; those encoded the rejected name-based design and
// are deleted, because under the measurement contract both of their poles return
// the same verdict and the separation assertion would correctly red.
for (const [input, expected] of [
  ["recovery", "false"],
  ["recovery/", "false"],
  ["recovery/a", "true"],
  ["refs/heads/recovery/a", "true"],
  ["feat/x", "false"],
  ["recoveryX", "false"],
]) {
  check(
    `arm1b/isRecoveryScoped(${JSON.stringify(input)}) · informational only — decides NO verdict`,
    expected,
    String(LIB.isRecoveryScoped(input)),
  );
}

// ARM 2 — UNKNOWN is a THIRD state, not a shade of clean. Asserted on the data
// rather than inferred from the prose above.
for (const pair of corpus.cases) {
  for (const pole of pair.poles) {
    if (pole.expect !== "unknown") continue;
    const a = assess(pole);
    check(`${pair.pair} · ${pole.name} · UNKNOWN is not clean`, "true", String(a.verdict !== "clean"));
    check(`${pair.pair} · ${pole.name} · UNKNOWN is not flag`, "true", String(a.verdict !== "flag"));
    check(
      `${pair.pair} · ${pole.name} · UNKNOWN names what it could not read`,
      "true",
      String(a.findings.some((f) => f.unresolved.length > 0)),
    );
  }
}

// ── CONTAINMENT: every git below is pinned inside the throwaway root ─────────

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coc-force-push-scope-")));

/**
 * REFUSES any cwd outside the throwaway root. This is not ceremony: an unpinned
 * git call in a fixture runner is how nine commits once landed on a live
 * repository and seven branches reached a real remote.
 */
const git = (args, cwd) => {
  const resolved = fs.realpathSync(cwd);
  if (resolved !== TMP && !resolved.startsWith(TMP + path.sep)) {
    throw new Error(`CONTAINMENT: refusing to run git in ${resolved}, which is outside ${TMP}`);
  }
  return spawnSync("git", args, { cwd: resolved, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

/**
 * The e2e repository, built with init/add/commit/branch/update-ref ONLY — no
 * push, no fetch, no checkout, no reset. The remote-tracking refs are written
 * DIRECTLY with `update-ref`, which is exactly the state a fetch would have left
 * behind and needs no network at all.
 *
 *   feat/wave-3      sits 2 commits BEHIND refs/remotes/origin/feat/wave-3     -> divergence 2
 *   recovery/wave-3  is LEVEL with refs/remotes/origin/recovery/wave-3          -> divergence 0
 *
 * That pairing is the whole point: the diverged branch is the wave one and the
 * level one is under `recovery/`, so a name-matcher and a measurement agree here
 * — and ARM 4's `a DIVERGED recovery/ branch FLAGS` is where they part.
 */
function setupE2eRepo() {
  const repo = path.join(TMP, "e2e");
  fs.mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "fixture@example.invalid"], repo);
  git(["config", "user.name", "fixture"], repo);
  const shas = [];
  for (const n of ["c1", "c2", "c3", "c4"]) {
    fs.writeFileSync(path.join(repo, "seed.txt"), `${n}\n`);
    git(["add", "-A"], repo);
    git(["commit", "-qm", n], repo);
    shas.push(git(["rev-parse", "HEAD"], repo).stdout.trim());
  }
  const [, c2, , c4] = shas;
  git(["branch", "feat/wave-3", c2], repo);
  git(["branch", "recovery/wave-3", c4], repo);
  git(["update-ref", "refs/remotes/origin/feat/wave-3", c4], repo);
  git(["update-ref", "refs/remotes/origin/recovery/wave-3", c4], repo);
  return repo;
}

const E2E = setupE2eRepo();

try {
  // ── ARM 3: the shipped guard as a PROCESS, against a KNOWN divergence ──────

  function runGuard(command, { toolName = "Bash", env = {}, cwd = E2E } = {}) {
    const res = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd }),
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    let json = null;
    try {
      json = JSON.parse(String(res.stdout || "").trim().split("\n").filter(Boolean).pop());
    } catch {
      /* left null — the assertions below read it as "no protocol line" */
    }
    const ctx = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || "";
    return { status: res.status, json, ctx, stderr: String(res.stderr || "") };
  }

  const violating = runGuard("git push --force origin feat/wave-3");
  check("e2e · violating pole · exit code is 0 (ADVISORY, never blocks)", "0", String(violating.status));
  check("e2e · violating pole · continue stays true", "true", String(violating.json && violating.json.continue));
  // The MEASUREMENT, end to end: the shipped divergence resolver read the real
  // repository and the real count reached the finding. A guard with no resolver
  // wired in reports `no-divergence-resolver` here instead, which is precisely
  // the state this arm exists to catch.
  check(
    "e2e · violating pole · carries the MEASURED count from real git",
    "true",
    String(violating.ctx.includes("feat/wave-3 (2 remote-only commits)")),
  );
  check(
    "e2e · violating pole · did NOT fall back to `no-divergence-resolver`",
    "false",
    String(violating.ctx.includes("no-divergence-resolver")),
  );
  check(
    "e2e · violating pole · rendered at the PRE-ACTION register (has NOT run yet)",
    "true",
    String(violating.ctx.includes("has NOT run yet")),
  );
  check(
    "e2e · violating pole · names the rule it enforces",
    "true",
    String(violating.ctx.includes("orchestration-launch-ledger.md MUST-6")),
  );
  // The staleness limit travels WITH the count, so a reader cannot take 0 or 2 as
  // an absolute. `FRESHNESS_CAVEAT` is held once in the library; these two
  // substrings are read from that one lineage.
  check(
    "e2e · violating pole · carries the staleness caveat",
    "true",
    String(violating.ctx.includes("only as fresh as the last fetch")),
  );
  check(
    "e2e · violating pole · says it does not fetch",
    "true",
    String(violating.ctx.includes("does not fetch")),
  );
  // The one shape that would make this a BLOCK. Pinned so a future severity
  // change reds here instead of silently acquiring teeth the contract forbids.
  check(
    "e2e · violating pole · never denies the call",
    "false",
    String(
      violating.json &&
        (violating.json.continue === false ||
          (violating.json.hookSpecificOutput || {}).permissionDecision === "deny"),
    ),
  );

  const compliant = runGuard("git push --force origin recovery/wave-3");
  check("e2e · compliant pole · exit code is 0", "0", String(compliant.status));
  check("e2e · compliant pole · MEASURED at zero, bare passthrough, no finding", "", compliant.ctx);

  const unknown = runGuard("git push --force origin $BRANCH");
  check("e2e · unknown pole · exit code is 0", "0", String(unknown.status));
  check("e2e · unknown pole · says UNKNOWN is not an all-clear", "true", String(unknown.ctx.includes("UNKNOWN")));
  check(
    "e2e · unknown pole · carries the staleness caveat too",
    "true",
    String(unknown.ctx.includes("only as fresh as the last fetch")),
  );

  const nonBash = runGuard("git push --force origin feat/wave-3", { toolName: "Read" });
  check("e2e · non-Bash tool · passthrough", "", nonBash.ctx);

  const killed = runGuard("git push --force origin feat/wave-3", { env: { COC_FORCE_PUSH_SCOPE: "0" } });
  check("e2e · kill switch honoured", "", killed.ctx);
  const stillOn = runGuard("git push --force origin feat/wave-3", { env: { COC_FORCE_PUSH_SCOPE: "1" } });
  check("e2e · kill switch is OPT-OUT, not opt-in", "true", String(stillOn.ctx.includes("feat/wave-3")));

  // ── ARM 4: the shipped BRANCH resolver against real git ────────────────────
  //
  // The divergence is INJECTED throughout, so this arm isolates the branch read:
  // a failure here is a failure to read HEAD, never a failure to count.

  const repo = path.join(TMP, "repo");
  fs.mkdirSync(repo);
  git(["init", "-q", "-b", "recovery/lane-a"], repo);
  git(["config", "user.email", "fixture@example.invalid"], repo);
  git(["config", "user.name", "fixture"], repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "seed"], repo);

  const { makeBranchResolver, makeDivergenceResolver } = require(GUARD);
  const resolve = makeBranchResolver(repo);
  const diverged = () => ({ ok: true, count: 3, remoteRef: "refs/remotes/origin/injected" });
  const level = () => ({ ok: true, count: 0, remoteRef: "refs/remotes/origin/injected" });
  const bare = (resolveDivergence) =>
    LIB.assessForcePush("git push --force", { resolveBranch: resolve, resolveDivergence }).verdict;

  // POSITIVE CONTROL FIRST: the resolver must be shown to speak before any of
  // its answers is read as evidence (`instrument-discipline.md` MUST-3(a)).
  const onRecovery = resolve(null);
  check("arm4/real-git · resolver answers at all", "true", String(onRecovery.ok));
  check("arm4/real-git · reads the recovery branch", "recovery/lane-a", onRecovery.branch);
  check("arm4/real-git · a LEVEL recovery/ branch is CLEAN", "clean", bare(level));
  // The inversion of the rejected design, pinned end to end: the NAME is
  // `recovery/`, the measurement is 3, and the measurement wins.
  check("arm4/real-git · a DIVERGED recovery/ branch FLAGS through the real resolver", "flag", bare(diverged));

  git(["checkout", "-q", "-b", "feat/lane-a"], repo);
  const onWave = resolve(null);
  check("arm4/real-git · reads the wave branch", "feat/lane-a", onWave.branch);
  check("arm4/real-git · a LEVEL wave branch is CLEAN", "clean", bare(level));
  check("arm4/real-git · a DIVERGED wave branch FLAGS", "flag", bare(diverged));

  const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["checkout", "-q", "--detach", head], repo);
  const detached = resolve(null);
  check("arm4/real-git · detached HEAD names no destination", "false", String(detached.ok));
  check(
    "arm4/real-git · detached HEAD is UNKNOWN even with a resolver answering zero",
    "unknown",
    bare(level),
  );

  // The `-C` retarget must read the TREE NAMED IN THE COMMAND, not the cwd.
  const other = path.join(TMP, "other");
  fs.mkdirSync(other);
  git(["init", "-q", "-b", "feat/other-lane"], other);
  git(["config", "user.email", "fixture@example.invalid"], other);
  git(["config", "user.name", "fixture"], other);
  fs.writeFileSync(path.join(other, "seed.txt"), "seed\n");
  git(["add", "-A"], other);
  git(["commit", "-qm", "seed"], other);
  const fromRepo = makeBranchResolver(repo);
  check("arm4/real-git · -C retarget reads the OTHER tree", "feat/other-lane", fromRepo(other).branch);

  // ── ARM 5: the shipped DIVERGENCE resolver against real git ────────────────
  //
  // A fresh resolver per case: the 1500ms budget is shared across one COMMAND's
  // reads by design, and sharing it across this whole arm would measure the
  // budget rather than the instrument.
  const div = (q) => makeDivergenceResolver(E2E)(q);

  // POSITIVE CONTROL FIRST — the instrument must be shown able to return a
  // NON-ZERO count before any zero it prints can be read as a true negative.
  const hot = div({ dir: null, remote: "origin", src: "feat/wave-3", dst: "feat/wave-3" });
  check("arm5/real-git · POSITIVE CONTROL · the resolver answers", "true", String(hot.ok));
  check("arm5/real-git · POSITIVE CONTROL · reads the KNOWN divergence of 2", "2", String(hot.count));
  check(
    "arm5/real-git · POSITIVE CONTROL · names the ref it measured against",
    "refs/remotes/origin/feat/wave-3",
    String(hot.remoteRef),
  );

  const cold = div({ dir: null, remote: "origin", src: "recovery/wave-3", dst: "recovery/wave-3" });
  check("arm5/real-git · a LEVEL branch reads 0 (readable only because the control fired)", "0", String(cold.count));
  check("arm5/real-git · a LEVEL branch is ok:true, not an unreadable", "true", String(cold.ok));

  const noRef = div({ dir: null, remote: "origin", src: "feat/wave-3", dst: "branch-this-clone-never-heard-of" });
  check("arm5/real-git · a missing tracking ref is UNREADABLE, not zero", "false", String(noRef.ok));
  check("arm5/real-git · and it names WHY", "no-remote-tracking-ref", String(noRef.reason));

  const noUp = div({ dir: null, remote: null, src: "feat/wave-3", dst: "feat/wave-3" });
  check("arm5/real-git · no configured upstream is UNREADABLE, not zero", "false", String(noUp.ok));
  check("arm5/real-git · and it names WHY", "no-upstream", String(noUp.reason));

  const url = div({ dir: null, remote: "https://example.invalid/r.git", src: "feat/wave-3", dst: "feat/wave-3" });
  check("arm5/real-git · a URL remote has no tracking ref here", "false", String(url.ok));
  check("arm5/real-git · and it names WHY", "unnamed-remote", String(url.reason));

  const optish = div({ dir: null, remote: "origin", src: "--upload-pack=evil", dst: "feat/wave-3" });
  check("arm5/real-git · a ref git would read as an OPTION is refused BEFORE spawning", "false", String(optish.ok));
  check("arm5/real-git · and it names WHY", "source-unresolvable", String(optish.reason));
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort — a leftover temp dir is not a test failure */
  }
}

if (failures.length) {
  console.error(`force-push-recovery-scope fixtures: ${failures.length} of ${cases} FAILED\n`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`force-push-recovery-scope fixtures: ${cases}/${cases} passed`);
