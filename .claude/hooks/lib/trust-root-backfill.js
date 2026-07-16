#!/usr/bin/env node
/**
 * trust-root-backfill — GENMAT-1 Wave-3 Shard T4 (loom#879 root-cause fix).
 *
 * A ONE-TIME, OWNER-TRIGGERED, one-repo-at-a-time tool that pushes THIS repo's
 * EXISTING local trust-root CHAIN — the `genesis-anchor` record PLUS any
 * `genesis-migration` record (the WHOLE chain, never anchor-only) — to its OWN
 * canonical fetchable coordination-log ref, via the COMPOSED enrollment-seed
 * transport (Shard T2, `enrollment-seed-transport.js`).
 *
 * WHY THIS EXISTS. The ~12 already-enrolled fleet repos (loom included) were
 * enrolled BEFORE Shard T2 wired the ref-first seed transport into the
 * ceremonies, so their chains live ONLY in the gitignored local
 * `.claude/learning/coordination-log.jsonl` and were NEVER pushed to a
 * fetchable ref (spec `trust-root-recovery.md` §1). A fresh clone of any of
 * them therefore has nothing to fetch and `genesis-anchor-guard.js`
 * fail-CLOSED-blocks its first commit. T2 fixes NEW enrollments; T4 backfills
 * the EXISTING fleet. It does NOT re-enroll and does NOT originate a new
 * trust root — it copies the chain that already verifies locally onto the ref
 * so `genesis-materializer.js` (Shard T3) can fetch-then-fold it.
 *
 * --------------------------------------------------------------------------
 * SENSITIVE — NOT AUTONOMOUS. The actual fleet backfill EXECUTION is
 * owner-gated (a shared `refs/coc/**` write, Prudence-gated). This module is
 * the TOOL; it pushes ONLY when EXPLICITLY invoked (`--backfill` on the CLI,
 * or a direct `backfill(...)` call). It is NEVER wired into any SessionStart /
 * `runParent` / hook path — the #857 500ms parent budget is preserved because
 * this module performs network I/O (push + ls-remote) that MUST NOT run on the
 * parent path. Each invocation operates on ONE repo and SURFACES the target
 * (repo + remote + records) before pushing; there is NO unattended loop.
 * --------------------------------------------------------------------------
 *
 * INVARIANTS (todo `04-wave3-backfill-authority-gated.md` §Invariants):
 *   1. Push target resolves via the repo's OWN `origin` remote — a remote
 *      NAME (default "origin"), NEVER a literal/canon URL.
 *   2. I3 FENCE (security-CRITICAL): a pre-push assertion that the resolved
 *      target remote's URL == the repo's own `git remote get-url origin`.
 *      REFUSE (typed error, non-zero exit) on any mismatch / foreign remote.
 *      This is the ONLY STRUCTURAL fork→canon fence on the push path — the
 *      `cross-ecosystem-disclosure-guard.js` is a PreToolUse Edit|Write hook,
 *      blind to a raw `git push`, and dormant on canon.
 *   3. Idempotent (`--force-with-lease`, inherited from `transport-git-ref.js`);
 *      after the chain is pushed, an `ls-remote` verify gate confirms the ref
 *      before success is returned.
 *   4. WHOLE chain pushed (anchor + migration), in local (append / anchor-
 *      first) order. Never an unattended loop; one repo per invocation.
 *
 * Style: CommonJS, zero-dep beyond child_process + the two sibling libs
 * (`enrollment-seed-transport.js`, `log-ref-name.js`, themselves zero-dep
 * beyond child_process). The `git` runner, the transport factory, the local-
 * chain reader, and the `print` sink are all injectable (opts.git /
 * opts.createEnrollmentSeedTransport / opts.readLocalChain / opts.print) so
 * tests use a real `git init --bare` remote in `mktemp -d` with NO subprocess
 * mocking — the same pattern the sibling libs' tests use.
 */

"use strict";

const { execFileSync } = require("child_process");
const seedTransport = require("./enrollment-seed-transport.js");

// The trust-root chain is exactly these two record types. `genesis-anchor` is
// the enrollment root; `genesis-migration` supersedes it on a MIGRATED repo
// (loom's state). Both are pushed — never anchor-only (todo Invariant 4).
const TRUST_ROOT_TYPES = ["genesis-anchor", "genesis-migration"];

const DEFAULT_REMOTE = "origin";

/**
 * Default git runner: `git -C <repoDir> <args...>` via execFileSync (arg-array
 * form, no shell interpolation — `security.md` § "No eval()"). Returns
 * {ok, stdout} on success or {ok:false, stderr} on non-zero exit. NEVER throws.
 *
 * @param {{args: string[], repoDir: string}} spec
 * @returns {{ok: boolean, stdout?: string, stderr?: string}}
 */
function _defaultGit({ args, repoDir }) {
  try {
    const stdout = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout) };
  } catch (err) {
    return {
      ok: false,
      stderr: err && err.stderr ? String(err.stderr) : String(err),
    };
  }
}

/**
 * Read THIS repo's local trust-root chain from
 * `<repoDir>/.claude/learning/coordination-log.jsonl`, returning ONLY the
 * `genesis-anchor` + `genesis-migration` records in FILE (append) order —
 * which is anchor-first on a MIGRATED repo, so the ref blob lands in chain
 * order.
 *
 * Unparseable lines are SKIPPED (the local log is a mixed append log carrying
 * heartbeats / claims / etc.; an unrelated malformed line MUST NOT block a
 * trust-root backfill) — the same disposition `genesis-ceremony.js::
 * _defaultReadChainHead` takes on the same file. An absent log (ENOENT) is
 * `{ok:true, records:[]}` (the caller reports no-anchor); any OTHER read error
 * surfaces as a typed `{ok:false}`.
 *
 * @param {string} repoDir
 * @returns {{ok: true, records: object[]} | {ok: false, reason: string}}
 */
function readLocalChain(repoDir) {
  // eslint-disable-next-line global-require
  const fs = require("fs");
  // eslint-disable-next-line global-require
  const path = require("path");
  const logPath = path.join(
    repoDir,
    ".claude",
    "learning",
    "coordination-log.jsonl",
  );
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, records: [] };
    return {
      ok: false,
      reason: `read ${logPath} failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const records = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Skip unparseable lines — not our target records (see docstring).
      continue;
    }
    if (
      rec &&
      typeof rec === "object" &&
      TRUST_ROOT_TYPES.indexOf(rec.type) !== -1
    ) {
      records.push(rec);
    }
  }
  return { ok: true, records };
}

/**
 * I3 FENCE (security-CRITICAL, todo Invariant 2). Assert the target remote's
 * URL EQUALS the repo's OWN `origin` URL. This is the ONLY structural
 * fork→canon fence on the raw-`git push` path. A remote NAME that resolves to
 * a foreign URL (a fork pointing `canon` at canon's remote), OR a remote that
 * does not resolve at all, is REFUSED — the tool NEVER pushes a repo's
 * trust-root chain anywhere but that repo's own origin.
 *
 * Passing a literal URL as `remote` also fails here (`git remote get-url
 * <url>` is not a configured remote → non-zero) — enforcing todo Invariant 1
 * ("resolves via the repo's OWN origin remote — NEVER a literal/canon URL").
 *
 * BOTH the PUSH url (`get-url --push`, what `git push <remote>` actually
 * targets, honoring `remote.<name>.pushurl`) AND the FETCH url (`get-url`)
 * MUST equal origin's respective url. Checking only the fetch url leaves a
 * pushurl-divergence bypass: a repo with `remote.origin.pushurl = <canon>`
 * would pass a fetch-url==fetch-url compare while the push lands on canon —
 * the exact fork→canon leak this fence exists to block (T5 MED-1).
 *
 * @returns {{ok: true, originUrl: string, originPushUrl: string} | {ok: false, reason: string}}
 */
function resolveRemoteUrl({ repoDir, remote, git, push }) {
  const args = push
    ? ["remote", "get-url", "--push", remote]
    : ["remote", "get-url", remote];
  const res = git({ args, repoDir });
  if (!res || !res.ok) {
    return {
      ok: false,
      stderr: res && res.stderr ? res.stderr : "unknown",
    };
  }
  return { ok: true, url: String(res.stdout || "").trim() };
}

function assertOwnOriginTarget({ repoDir, remote, git }) {
  // Resolve origin's fetch + push urls (the destination we are allowed to write).
  const originFetch = resolveRemoteUrl({
    repoDir,
    remote: "origin",
    git,
    push: false,
  });
  if (!originFetch.ok) {
    return {
      ok: false,
      reason: `cannot resolve origin URL (git remote get-url origin failed): ${originFetch.stderr}`,
    };
  }
  const originUrl = originFetch.url;
  if (!originUrl) {
    return { ok: false, reason: "origin remote URL is empty" };
  }
  const originPush = resolveRemoteUrl({
    repoDir,
    remote: "origin",
    git,
    push: true,
  });
  if (!originPush.ok) {
    return {
      ok: false,
      reason: `cannot resolve origin PUSH URL (git remote get-url --push origin failed): ${originPush.stderr}`,
    };
  }
  const originPushUrl = originPush.url;

  // Resolve the target remote's fetch + push urls.
  const targetFetch = resolveRemoteUrl({ repoDir, remote, git, push: false });
  if (!targetFetch.ok) {
    return {
      ok: false,
      reason: `cannot resolve target remote '${remote}' URL (git remote get-url ${remote} failed — not a configured remote?): ${targetFetch.stderr}`,
    };
  }
  const targetUrl = targetFetch.url;
  const targetPush = resolveRemoteUrl({ repoDir, remote, git, push: true });
  if (!targetPush.ok) {
    return {
      ok: false,
      reason: `cannot resolve target remote '${remote}' PUSH URL (git remote get-url --push ${remote} failed): ${targetPush.stderr}`,
    };
  }
  const targetPushUrl = targetPush.url;

  // THE fence: the ACTUAL push destination (`git push <remote>` targets the
  // remote's push url, honoring `remote.<name>.pushurl`) MUST equal this repo's
  // OWN canonical identity — origin's FETCH url, the url this repo was cloned
  // from. Comparing the push destination against origin's fetch identity closes
  // BOTH bypasses at once:
  //   (a) a foreign remote NAME whose push url is canon (push != origin-fetch);
  //   (b) a `remote.origin.pushurl = <canon>` REDIRECT with `--remote origin`
  //       (push url is canon while fetch url is origin — the T5 MED-1 attack;
  //       a target-vs-origin push-url compare would MISS it, since target IS
  //       origin there and both sides are trivially equal).
  // Fail-CLOSED: a divergent push destination (incl. a legit split
  // ssh-push/https-fetch config) is REFUSED — for a rare, owner-gated,
  // one-time trust-root push the safe default is to refuse-and-surface, not to
  // trust a push url that does not resolve to the repo's own clone identity.
  if (targetPushUrl !== originUrl) {
    return {
      ok: false,
      reason: `I3 FENCE: the push destination for remote '${remote}' (${targetPushUrl}) does NOT equal this repo's own origin identity (${originUrl}); refusing fork→canon push. A repo's trust-root chain is pushed ONLY to its own origin's url (a divergent remote.<name>.pushurl is refused).`,
    };
  }
  if (targetUrl !== originUrl) {
    return {
      ok: false,
      reason: `I3 FENCE: target remote '${remote}' fetch URL (${targetUrl}) does NOT equal this repo's own origin fetch URL (${originUrl}); refusing fork→canon push. A repo's trust-root chain is pushed ONLY to its own origin.`,
    };
  }
  return { ok: true, originUrl, originPushUrl };
}

/**
 * backfill — push THIS repo's local trust-root chain to its own canonical
 * coordination-log ref via the composed enrollment-seed transport.
 *
 * @param {object} opts
 * @param {string} [opts.repoDir]  - local git checkout; defaults to cwd.
 * @param {string} [opts.remote]   - remote NAME (default "origin"); the I3
 *                                   fence requires its URL == origin's URL.
 * @param {function} [opts.git]    - injected git runner ({args, repoDir}) =>
 *                                   {ok, stdout?, stderr?}; defaults to execFileSync.
 * @param {function} [opts.createEnrollmentSeedTransport] - override the factory
 *                                   (tests); defaults to the real Shard-T2 factory.
 * @param {function} [opts.readLocalChain] - override the local-chain reader
 *                                   (tests); defaults to `readLocalChain`.
 * @param {function} [opts.print]  - surface sink ((msg)=>void); defaults to no-op
 *                                   (the CLI wires it to console.log so every push
 *                                   is surfaced — todo §Scope "every push is surfaced").
 *
 * @returns {{ok: true, refName, remote, repoDir, pushed: string[], refTip: string} |
 *           {ok: false, error: string, reason: string, code: string, surface?: string, pushed?: string[]}}
 */
function backfill(opts) {
  const o = opts || {};
  const repoDir = o.repoDir || process.cwd();
  const remote = o.remote || DEFAULT_REMOTE;
  const git = typeof o.git === "function" ? o.git : _defaultGit;
  const createTransport =
    typeof o.createEnrollmentSeedTransport === "function"
      ? o.createEnrollmentSeedTransport
      : seedTransport.createEnrollmentSeedTransport;
  const readChain =
    typeof o.readLocalChain === "function" ? o.readLocalChain : readLocalChain;
  const print = typeof o.print === "function" ? o.print : () => {};

  // --- Step 1: I3 FENCE (pre-push, security-CRITICAL) — refuse a foreign remote ---
  const fence = assertOwnOriginTarget({ repoDir, remote, git });
  if (!fence.ok) {
    return {
      ok: false,
      error: "I3 fence refused the push target",
      reason: fence.reason,
      code: "foreign-remote",
    };
  }

  // --- Step 2: read the WHOLE local trust-root chain (anchor + migration) ---
  const chain = readChain(repoDir);
  if (!chain || !chain.ok) {
    return {
      ok: false,
      error: "cannot read local trust-root chain",
      reason: (chain && chain.reason) || "unknown read error",
      code: "chain-read",
    };
  }
  const records = chain.records || [];
  const hasAnchor = records.some((r) => r && r.type === "genesis-anchor");
  if (!hasAnchor) {
    return {
      ok: false,
      error: "no local genesis-anchor to backfill",
      reason: `no genesis-anchor record found in ${repoDir}/.claude/learning/coordination-log.jsonl — this repo is not locally enrolled, so there is no chain to push (the tool NEVER originates a trust root)`,
      code: "no-anchor",
    };
  }

  // --- Step 3: compose the Shard-T2 seed transport bound to this repo's origin ---
  // The local cache ALREADY holds this chain (it is our SOURCE), so the
  // local surface is a no-op that reports success — we are pushing the chain
  // to the REF, not re-writing the local log. The composed transport gives us
  // the ref-first-then-local ordering + the half-write fail-CLOSED discipline
  // (a ref-append failure returns a typed error, no false success).
  let composed;
  try {
    composed = createTransport({
      repoDir,
      remote,
      localAppend: () => ({ ok: true }),
    });
  } catch (err) {
    return {
      ok: false,
      error: "enrollment-seed transport construction failed",
      reason: err && err.message ? err.message : String(err),
      code: "transport-init",
    };
  }
  const refName = composed.refName;

  // SURFACE the target BEFORE any push (todo §Scope: "Every push is surfaced
  // to the owner — target repo + remote + records").
  print(
    `trust-root backfill → repo=${repoDir} remote=${remote} ref=${refName} records=[${records.map((r) => r.type).join(", ")}]`,
  );

  // --- Step 4: push the WHOLE chain, in order; fail-CLOSED on any failure ---
  const pushed = [];
  for (const record of records) {
    let res;
    try {
      res = composed.transportAppend(record);
    } catch (err) {
      return {
        ok: false,
        error: "chain push threw (fail-CLOSED)",
        reason: err && err.message ? err.message : String(err),
        code: "push-threw",
        pushed,
      };
    }
    if (!res || !res.ok) {
      return {
        ok: false,
        error: "chain push failed (fail-CLOSED)",
        reason: (res && (res.reason || res.error)) || "unknown push error",
        surface: res && res.surface,
        code: "push-failed",
        pushed,
      };
    }
    pushed.push(record.type);
  }

  // --- Step 5: ls-remote verify gate — confirm the ref before success ---
  const verify = git({ args: ["ls-remote", remote, refName], repoDir });
  if (!verify || !verify.ok) {
    return {
      ok: false,
      error: "ls-remote verify failed after push",
      reason: `git ls-remote ${remote} ${refName} failed: ${verify && verify.stderr ? verify.stderr : "unknown"}`,
      code: "verify-failed",
      pushed,
    };
  }
  const verifyOut = String(verify.stdout || "").trim();
  if (!verifyOut) {
    return {
      ok: false,
      error: "ref absent on remote after push",
      reason: `git ls-remote ${remote} ${refName} returned empty after a reported-successful push — the chain did not land`,
      code: "verify-empty",
      pushed,
    };
  }
  const refTip = verifyOut.split(/\s+/)[0];

  print(
    `trust-root backfill OK → ${pushed.length} record(s) on ${remote}:${refName} @ ${refTip} (verified via ls-remote)`,
  );
  return { ok: true, refName, remote, repoDir, pushed, refTip };
}

// =========================================================================
// CLI — the EXPLICIT, owner-triggered, one-repo-at-a-time entrypoint.
// =========================================================================

const USAGE =
  "Usage: node .claude/hooks/lib/trust-root-backfill.js --backfill [--repo-dir <path>] [--remote <name>]\n" +
  "\n" +
  "  Pushes THIS repo's EXISTING local trust-root chain (genesis-anchor +\n" +
  "  genesis-migration) to its OWN canonical coordination-log ref, so a fresh\n" +
  "  clone can fetch-then-fold its trust root (loom#879). ONE repo per run.\n" +
  "\n" +
  "  --backfill            REQUIRED — perform the push (explicit owner action).\n" +
  "  --repo-dir <path>     repo checkout (default: cwd).\n" +
  "  --remote <name>       remote NAME (default: origin). The I3 fence REFUSES\n" +
  "                        any remote whose URL != this repo's origin URL.\n" +
  "\n" +
  "  SENSITIVE: a shared refs/coc/** write; run ONLY on explicit owner go-ahead,\n" +
  "  ONE repo at a time. Never wired into any SessionStart/hook path.\n" +
  "\n" +
  "  Exit: 0 = pushed + verified; 1 = fail-CLOSED (fence refused / no anchor /\n" +
  "  push or verify failed); 2 = usage.";

/**
 * runCli — parse args and drive one backfill. Requires `--backfill` to perform
 * the push (a bare invocation prints usage + exits 2 — the push is NEVER the
 * default action). Returns the process exit code.
 *
 * @param {string[]} argv - args after the node script (process.argv.slice(2)).
 * @param {object} [env]  - process env (reserved; unused today).
 * @returns {number} exit code
 */
function runCli(argv, env) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.indexOf("--help") !== -1 || args.indexOf("-h") !== -1) {
    process.stdout.write(USAGE + "\n");
    return 2;
  }
  let repoDir = process.cwd();
  let remote = DEFAULT_REMOTE;
  let doBackfill = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--backfill") {
      doBackfill = true;
    } else if (a === "--repo-dir") {
      repoDir = args[i + 1];
      i += 1;
    } else if (a === "--remote") {
      remote = args[i + 1];
      i += 1;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  if (!doBackfill) {
    process.stderr.write(
      "Refusing to run without --backfill (the push is never the default action).\n" +
        USAGE +
        "\n",
    );
    return 2;
  }
  if (typeof repoDir !== "string" || !repoDir) {
    process.stderr.write(`--repo-dir requires a path.\n${USAGE}\n`);
    return 2;
  }
  if (typeof remote !== "string" || !remote) {
    process.stderr.write(`--remote requires a name.\n${USAGE}\n`);
    return 2;
  }

  const result = backfill({
    repoDir,
    remote,
    print: (msg) => process.stdout.write(msg + "\n"),
  });
  if (result.ok) {
    return 0;
  }
  process.stderr.write(
    `trust-root backfill REFUSED/FAILED [${result.code}]: ${result.error} — ${result.reason}\n`,
  );
  return 1;
}

module.exports = {
  backfill,
  readLocalChain,
  assertOwnOriginTarget,
  runCli,
  TRUST_ROOT_TYPES,
};

// Only run when invoked directly (`node .../trust-root-backfill.js --backfill`).
// NEVER auto-runs on import — this module is imported by NO SessionStart /
// hook path (the #857 parent-budget invariant).
if (require.main === module) {
  process.exit(runCli(process.argv.slice(2), process.env));
}
