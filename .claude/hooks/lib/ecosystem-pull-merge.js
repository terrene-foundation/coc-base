"use strict";

// ecosystem-pull-merge.js — the active start-refresh step (ECO-IMPL W8b / G-A-T3).
//
// Upgrades the session-start hook's PASSIVE upstream-lag advisory into the ACTIVE
// "always pull and merge at start" the co-owner's D2 directive requires — but ONLY
// where it is provably non-destructive. Two operations per the ratified tabletop
// ("both, applied differently", decisions/00 § Start-refresh):
//
//   Op1 — intra-ecosystem config: pull + MERGE --ff-only, CLEAN-TREE-GUARDED, and
//         HALT-not-destroy on a dirty tree OR a diverged (non-ff) branch. Scope is the
//         CURRENT repo's own @{upstream} (loom's .claude/ + ecosystem-config surface),
//         NOT build/use repos (Q3) — a session-start hook reaches only its own checkout.
//   Op2 — canon-upstream refs: FETCH WITHOUT MERGE. A client SEES canon's latest;
//         rolling it in stays a human-gated decision (D3), never an auto-merge.
//
// Every git access routes through the injected `exec` so the hook and the tests share
// ONE surface. Fail-open by construction: every operation degrades to an advisory on any
// error and NEVER throws into the session-start hook (which is itself fail-open, 10s budget).

const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnvForArgs } = require("./git-subprocess-env");

// Injected-exec contract: (args:string[], opts?) => { ok, stdout, code, error? }. Never throws.
//
// ENVELOPED (loom#1471, the last KNOWN_UNHELPERED row). This was the final open
// literal-`git` site in `.claude/hooks/**`, and the ledgered reason for leaving it
// open was that the file runs `merge`, so it supposedly needed a profile decision
// that did not exist — `merge` is outside CONFIG_PROFILE_SUBCOMMANDS and
// `gitConfigInvocation()` throws on it. That reason is STALE, and the stale half is
// the premise, not the conclusion: this file never needed the CONFIG profile.
//
// It runs `merge --ff-only` (`.claude/hooks/lib/ecosystem-pull-merge.js:154`) and ONLY
// after Invariant 2 has returned `diverged-halt` for any `aheadN > 0`
// (`.claude/hooks/lib/ecosystem-pull-merge.js:127-134`), so the merge is a genuine
// FAST-FORWARD every time it is reached. Both ranges were RE-READ after this comment
// reached its final length, not carried over: two earlier drafts cited ranges their
// own diff had already shifted, which is `zero-tolerance.md` Rule 3e occurring at the
// site of the claim that rule governs.
// A fast-forward performs no content merge — git moves the ref or refuses
// — so no `merge.<driver>.driver` from the operator's global config can run, no commit
// object is created, and no identity or signing key is consulted. The global-config
// argument that blocked this row describes a three-way merge this code cannot reach.
//
// So the profile it needed already existed: `gitEnvForArgs()` picks `gitNetEnv()` for
// the Op2 `fetch` (the file's only NET_SUBCOMMANDS verb) and the stricter `gitEnv()`
// for every local read and for `merge --ff-only`. Checked against this repo before
// claiming it: `.gitattributes` binds `merge=coc-ledger` for
// `workspaces/*/.session-notes.shared.md` but registers the driver COMMAND in
// clone-local config, and no filter/smudge/clean or LFS attribute exists anywhere in
// the tree — so nulling global config cannot change what a fast-forward checks out.
//
// Fail-CLOSED on an unresolvable binary, expressed in this file's own fail-open
// vocabulary: a null `gitBin` returns the not-ok shape every caller already handles
// by degrading to an advisory, so the session-start hook still never throws.
function defaultExec(args, opts) {
  const o = opts || {};
  const gitBin = resolveGitBinary();
  if (!gitBin) {
    return { ok: false, stdout: "", code: 1, error: "git binary unresolvable" };
  }
  try {
    const stdout = execFileSync(gitBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: o.timeout || 8000,
      env: gitEnvForArgs(args),
      ...(o.cwd ? { cwd: o.cwd } : {}),
    });
    return { ok: true, stdout: stdout || "", code: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: (e && e.stdout) || "",
      code: e && e.status != null ? e.status : 1,
      error: e && e.message,
    };
  }
}

function intStdout(res) {
  if (!res || !res.ok) return NaN;
  const n = parseInt(String(res.stdout).trim(), 10);
  return Number.isFinite(n) ? n : NaN;
}

// Op1 — intra-ecosystem config pull + merge --ff-only (clean-tree-guarded).
// Invariant 1: clean-tree check BEFORE any merge. Invariant 2: non-ff / dirty → surface
// + HALT, NEVER force / silent-destroy (git.md destructive-working-tree discipline).
function pullMergeIntraEcosystem(exec) {
  const up = exec([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (!up.ok || !String(up.stdout).trim()) {
    return op1(
      "no-upstream",
      "advisory",
      "Op1 intra-ecosystem pull: no @{upstream} tracking — skipped.",
    );
  }
  const upstreamRef = String(up.stdout).trim();

  const behindN = intStdout(
    exec(["rev-list", "--count", `HEAD..${upstreamRef}`]),
  );
  const aheadN = intStdout(
    exec(["rev-list", "--count", `${upstreamRef}..HEAD`]),
  );
  if (!Number.isFinite(behindN)) {
    return op1(
      "lag-unknown",
      "advisory",
      `Op1 intra-ecosystem pull: could not compute lag vs ${upstreamRef} — skipped (fail-open).`,
    );
  }
  if (behindN <= 0) {
    return op1(
      "up-to-date",
      "advisory",
      `Op1 intra-ecosystem pull: already up to date with ${upstreamRef}.`,
    );
  }

  // Invariant 2 (diverged): local commits upstream lacks → NEVER auto-merge.
  if (Number.isFinite(aheadN) && aheadN > 0) {
    return op1(
      "diverged-halt",
      "halt-and-report",
      `⚠️  Op1 intra-ecosystem pull: branch DIVERGED from ${upstreamRef} (${aheadN} local / ${behindN} upstream commit(s)) — NOT auto-merged. Resolve manually; never force.`,
    );
  }

  // Invariant 1 (clean-tree gate): dirty tree → NEVER auto-merge (would risk uncommitted work).
  const status = exec(["status", "--porcelain"]);
  if (!status.ok) {
    return op1(
      "status-failed",
      "advisory",
      "Op1 intra-ecosystem pull: git status failed — skipped (fail-open).",
    );
  }
  if (String(status.stdout).trim() !== "") {
    return op1(
      "dirty-halt",
      "halt-and-report",
      `⚠️  Op1 intra-ecosystem pull: working tree DIRTY (${behindN} commit(s) behind ${upstreamRef}) — NOT auto-merged. Commit/stash, then pull --ff-only.`,
    );
  }

  // Clean AND strictly-behind → the only provably-non-destructive case: --ff-only.
  const merge = exec(["merge", "--ff-only", upstreamRef]);
  if (!merge.ok) {
    return op1(
      "ff-failed",
      "halt-and-report",
      `⚠️  Op1 intra-ecosystem pull: --ff-only merge of ${upstreamRef} failed — NOT forced. Resolve manually.`,
    );
  }
  return op1(
    "ff-merged",
    "advisory",
    `✓ Op1 intra-ecosystem pull: fast-forwarded ${behindN} commit(s) from ${upstreamRef}.`,
  );
}

// Op2 — canon-upstream FETCH WITHOUT MERGE. Invariant 3: fetch only, never merge.
// Invariant 4: unreachable → advisory degrade, NEVER a session-start outage.
function fetchCanonUpstream(exec, upstreamCanon) {
  if (!upstreamCanon || !upstreamCanon.remote) {
    return op2(
      "no-canon",
      "advisory",
      "Op2 canon-upstream fetch: no upstream_canon configured (canon ecosystem, or not set) — skipped.",
    );
  }
  const remote = String(upstreamCanon.remote);

  // Invariant 3: FETCH only (--no-write-fetch-head: don't even touch FETCH_HEAD merge state).
  const fetch = exec(["fetch", "--no-write-fetch-head", remote]);
  if (!fetch.ok) {
    return op2(
      "unreachable",
      "advisory",
      `Op2 canon-upstream fetch: ${remote} unreachable — skipped (advisory; never a session-start outage).`,
    );
  }

  // Best-effort roll-in count against the canon default branch (main). Branch-name
  // assumptions are fragile, so a failed count degrades to a generic "fetched" message.
  const availN = intStdout(
    exec(["rev-list", "--count", `HEAD..${remote}/main`]),
  );
  if (Number.isFinite(availN) && availN > 0) {
    return op2(
      "available",
      "advisory",
      `Op2 canon-upstream fetch: ${availN} canon commit(s) available to roll in from ${remote}/main (fetch-only; roll-in stays human-gated — D3).`,
    );
  }
  return op2(
    "fetched",
    "advisory",
    `Op2 canon-upstream fetch: ${remote} fetched (fetch-only; roll-in stays human-gated — D3).`,
  );
}

// CJS-friendly read of the SAME `ecosystem.upstream_canon` field that the ESM authority
// `ecosystem-config.mjs::getUpstreamCanon` returns (= `c.ecosystem.upstream_canon`). The
// session-start hook is synchronous CJS + fail-open, so it cannot `await import()` the ESM
// accessor; this narrow single-field read is the CJS equivalent (no cache / no join / no
// validation beyond JSON.parse — richer consumers use the ESM accessor). Absence of
// ecosystem.json is NOT an error (back-compat): canon / unconfigured / consumer → null.
function readUpstreamCanon(repoDir) {
  try {
    const fs = require("fs");
    const path = require("path");
    const p = path.join(
      repoDir || process.cwd(),
      ".claude",
      "bin",
      "ecosystem.json",
    );
    if (!fs.existsSync(p)) return null;
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!c || !c.ecosystem || !c.ecosystem.upstream_canon) return null;
    return c.ecosystem.upstream_canon;
  } catch {
    return null;
  }
}

function runStartRefresh(opts) {
  const o = opts || {};
  const exec = o.exec || ((args) => defaultExec(args, { cwd: o.repoDir }));
  // Injected upstreamCanon (tests) wins; otherwise read it CJS-friendly from ecosystem.json.
  const upstreamCanon =
    o.upstreamCanon !== undefined
      ? o.upstreamCanon
      : readUpstreamCanon(o.repoDir);
  const result = { op1: null, op2: null };
  try {
    result.op1 = pullMergeIntraEcosystem(exec);
  } catch (e) {
    result.op1 = op1(
      "error",
      "advisory",
      "Op1 intra-ecosystem pull: internal error — skipped (fail-open).",
    );
  }
  try {
    result.op2 = fetchCanonUpstream(exec, upstreamCanon);
  } catch (e) {
    result.op2 = op2(
      "error",
      "advisory",
      "Op2 canon-upstream fetch: internal error — skipped (fail-open).",
    );
  }
  return result;
}

function op1(status, severity, message) {
  return { op: "op1", status, severity, message };
}
function op2(status, severity, message) {
  return { op: "op2", status, severity, message };
}

module.exports = {
  runStartRefresh,
  pullMergeIntraEcosystem,
  fetchCanonUpstream,
  readUpstreamCanon,
  defaultExec,
};
