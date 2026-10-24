#!/usr/bin/env node
// Stand-alone macOS launcher (guard foundation S1): run ANY CLI inside a rendered Seatbelt
// profile file, with the S4 broker running OUTSIDE it, and no csq or trestle involved. csq
// and trestle consume the same file through the same verify + probe.
//
//   node seatbelt-launch.mjs render --repo <root> [--policy <file>] [--home <dir>]
//        [--config-dir <dir>] [--vault <dir>] > profile.sb
//   node seatbelt-launch.mjs run --profile <file> --expect-sha256 <hex> [--repo <root>]
//        [--policy <file>] [--home <dir>] [--config-dir <dir>] [--vault <dir>]
//        [--broker-socket <path>] [--broker-wait-ms <n>] [--pass-env NAME]... [--no-broker]
//        -- <cli> [args...]
//
// The repo root is a PARAMETER: `.git/hooks` and `.git/config` are denied under THAT root's
// git dir only, so another checkout (a trestle mirror, a sibling worktree's own repo) is
// untouched. Trusted writers (land-lane, the train, the vault tools) are NOT exempted inside
// the profile — they run outside it, through the broker.
//
// `render` REFUSES (exit 3, nothing on stdout) when a protected regular file already carries a
// second hard link (seatbelt.mjs::hardLinkedTargets): Seatbelt decides by PATH, so a write
// through the other name changes the protected inode, and no profile can cover that.
//
// RUNTIME TRUST: every render — `render`, and the re-render in `run` step 4 — also write-denies
// the install prefix of node and of every external program the trusted writers' closures run
// (the broker runs them OUTSIDE the sandbox, so a sandboxed rewrite of them would run
// unsandboxed). The set is the ONE derivation `broker/runtime-trust.mjs::runtimeTrustPaths(
// { programs: closurePrograms({ primary: <repo>, policy }) })`, imported dynamically. If that
// module is absent, or it or the generator throws (e.g. a prefix that covers the session's own
// home, repo or config dir), `render` REFUSES (exit 3, nothing on stdout) and `run` refuses; it
// never renders without the runtime rules. A program found in no trusted dir is a stderr GAP
// line, not a refusal (its writers get ENOENT).
//
// `run`, in order — every step that fails REFUSES (exit 3, the CLI never runs), and nothing
// ever falls back to an unsandboxed run. `--no-broker` lifts none of steps 1–5:
//   1. Arguments are parsed strictly: an unknown or repeated option is refused, so a typo in
//      `--expect-sha256` cannot silently drop the pin. The pin is MANDATORY (64 lowercase
//      hex): a profile that is merely self-consistent is not evidence it is the one the caller
//      meant to apply.
//   2. The profile file is read ONCE and verified (format, version, sha256, the caller's pin);
//      those verified bytes are what sandbox-exec receives (`-p`), so the file cannot be
//      swapped between the check and the use.
//   3. LIVE POLICY: the header's `policy_sha256` must equal the pin of the policy in force now
//      (`canonicalSha256(loadPolicy(--policy, default the shipped policy))` — the same policy
//      the broker enforces), so a profile rendered before a policy change is refused by name.
//   4. BINDING: the profile is re-rendered from --repo (default: cwd), --home, --config-dir,
//      --vault and --policy (same defaults as `render`), the runtime trust prefixes included
//      (computed again NOW), and must equal the verified text, so the sandbox protects the same
//      repository the broker is bound to and the runtime rules are bound into the sha-pinned
//      body: a profile whose runtime rules differ from today's set is refused. Then the FRESH render's
//      protected set must hold no file with a second hard link (as in `render`), checked now,
//      at launch, not trusted from render time. Then every directory the profile pins (each
//      anchor base and each directory between an anchor and a protected path, e.g. ~/.gnupg,
//      ~/.config, ~/.config/git) must be a REAL directory: an absent one is created (0700),
//      and a symlink or non-directory there is refused (seatbelt.mjs::preparePinnedDirs).
//   5. The probe must show Seatbelt applying on this host.
//   6. BROKER (default ON): this launcher starts the broker as its OWN child process — never
//      under sandbox-exec — by re-running this file as `broker` (server.mjs::startServer,
//      bound to the rendered repo and anchors). The broker also receives the VERIFIED profile:
//      the same bytes sandbox-exec receives are written 0600 into a fresh
//      `<tmpdir>/coc-guard-profile-*` dir and passed as `--profile <file> --profile-sha256
//      <pin>`; the broker reads it ONCE, verifies it against the pin, and refuses to start on
//      any mismatch. That dir is removed in the same teardown that stops the broker. Its socket is per launch,
//      `<home>/.cache/coc-guard-broker/<sha256(repo)[:16]>-<launcher pid>.sock` (or
//      --broker-socket), inside the policy row `broker-socket-dir`: the profile denies WRITES
//      there, so a sandboxed process cannot unlink or replace the socket, while connecting to
//      it stays allowed. The launcher does not reason about that from the paths: it MEASURES
//      it (step 7).
//   7. READINESS, bounded by --broker-wait-ms (default 10000): (a) from outside, a request
//      for a writer id no policy can name (`__readiness__` fails the policy's id pattern) must
//      come back as the broker's own `untrusted-writer` refusal — a real round trip through
//      the policy check, never a sleep; (b) then `client.mjs` run UNDER THE VERIFIED PROFILE
//      must reach it (client exit 3 = the broker answered; 5 = unreachable). A broker that
//      exits, never answers in time, or cannot be reached from inside the profile is a
//      refusal; the broker is stopped first.
//   8. The CLI runs as `sandbox-exec -p <verified text> <cli> ...` with
//      COC_GUARD_BROKER_SOCKET=<socket> in its environment (removed under --no-broker); a
//      sandboxed caller reaches the broker with `client.mjs --socket "$COC_GUARD_BROKER_SOCKET"`.
//   9. TEARDOWN: when the CLI exits, the broker is stopped (stdin closed + SIGTERM, SIGKILL
//      after a grace period) and AWAITED, then the launcher exits with the CLI's status
//      (128 + signal number when the CLI died on a signal). SIGTERM and SIGHUP sent to the
//      launcher are forwarded to the CLI; SIGINT is not (the terminal already delivers it to
//      the CLI, which shares the launcher's process group). The broker runs in its own
//      session, so a terminal signal never reaches it, and it stops by itself when its stdin
//      reaches EOF — so it does not outlive a launcher that is SIGKILLed.
//
// `--no-broker` is the explicit, documented opt-out: the CLI runs sandboxed with no broker,
// so every protected write — trusted writers included — is refused for the session. It
// cannot be combined with the broker options.
//
// Residual: a brokered writer still running when the CLI exits delays the broker's stop; past
// the grace period the broker is killed, and that writer's after-run licence report is lost.
// A launcher that is SIGKILLed leaves its `coc-guard-profile-*` dir behind (the profile text
// only; no secret).
// The macOS socket path limit is 103 bytes; a longer socket path is refused up front (exit 3,
// before the broker starts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSeatbeltProfile, resolveAnchors, renderProfileFile, verifyProfileFile, probeSandbox, hardLinkedTargets, preparePinnedDirs, RUNTIME_REFUSED } from "./seatbelt.mjs";
import { loadPolicy, canonicalSha256, POLICY_PATH } from "../policy/policy.mjs";
import { startServer, defaultSocketPath } from "../broker/server.mjs";
import { request } from "../broker/client.mjs";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";

export const REFUSED_EXIT = 3;
export const BROKER_SOCKET_ENV = "COC_GUARD_BROKER_SOCKET";

const SELF = fileURLToPath(import.meta.url);
const CLIENT = path.join(path.dirname(SELF), "..", "broker", "client.mjs");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// Fails policy.mjs's id pattern (^[a-z0-9][a-z0-9-]*$), so no policy can make it trusted.
const READINESS_WRITER = "__readiness__";
const DEFAULT_BROKER_WAIT_MS = 10000;
const BROKER_STOP_GRACE_MS = 5000;
const MAX_SOCKET_PATH_BYTES = 103; // macOS sun_path is 104 bytes, the terminating NUL included

const RENDER_OPTS = { valued: ["--repo", "--policy", "--home", "--config-dir", "--vault"], flags: [], multi: [] };
const RUN_OPTS = {
  valued: ["--profile", "--expect-sha256", "--repo", "--policy", "--home", "--config-dir", "--vault", "--broker-socket", "--broker-wait-ms", "--pass-env"],
  flags: ["--no-broker"],
  multi: ["--pass-env"],
};
const BROKER_OPTS = {
  valued: ["--repo", "--socket", "--policy", "--home", "--config-dir", "--vault", "--pass-env", "--profile", "--profile-sha256"],
  flags: [],
  multi: ["--pass-env"],
};
// The ONE derivation of the runtime trust set (another module's; never derived here). Imported
// dynamically, so this launcher still loads while the module is absent; every render then refuses.
const RUNTIME_TRUST = "../broker/runtime-trust.mjs";

/** Strict option parsing: unknown, value-less or repeated (non-multi) options throw. */
function parseOpts(args, spec) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (spec.flags.includes(k)) {
      if (k in o) throw new Error(`${k} given twice`);
      o[k] = true;
      continue;
    }
    if (!spec.valued.includes(k)) throw new Error(`unknown argument ${JSON.stringify(k)}`);
    const v = args[i + 1];
    if (v === undefined) throw new Error(`${k} needs a value`);
    i++;
    if (spec.multi.includes(k)) (o[k] ||= []).push(v);
    else if (k in o) throw new Error(`${k} given twice`);
    else o[k] = v;
  }
  return o;
}

function refuse(msg) {
  process.stderr.write(`REFUSING: ${msg}. Nothing was run.\n`);
  process.exit(REFUSED_EXIT);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The anchors `render` and `run` share, with the same defaults. */
function anchorsFrom(o) {
  return resolveAnchors({
    repoDir: o["--repo"] || process.cwd(),
    homeDir: o["--home"] || process.env.HOME,
    configDir: o["--config-dir"] || process.env.CLAUDE_CONFIG_DIR,
    vaultDir: o["--vault"] || null,
  });
}

/**
 * The runtime trust set for this repo and policy, through the dynamic import of
 * broker/runtime-trust.mjs. Any failure (module absent, either call throwing) throws with code
 * RUNTIME_REFUSED: no render may proceed without it.
 */
async function runtimeFor(policy, anchors) {
  try {
    const { runtimeTrustPaths, closurePrograms } = await import(RUNTIME_TRUST);
    if (typeof runtimeTrustPaths !== "function" || typeof closurePrograms !== "function") {
      throw new Error("it does not export runtimeTrustPaths and closurePrograms");
    }
    const rt = runtimeTrustPaths({ programs: closurePrograms({ primary: anchors.repo, policy }) });
    if (!rt || !Array.isArray(rt.prefixes)) throw new Error("runtimeTrustPaths returned no prefixes array");
    return rt;
  } catch (e) {
    throw Object.assign(new Error(`the runtime trust set (broker/runtime-trust.mjs) could not be computed: ${(e && e.message) || e}`), { code: RUNTIME_REFUSED });
  }
}

/**
 * A fresh render: the pinned file text, its gaps, the program names runtime-trust found nowhere,
 * and the generator result (for hardLinkedTargets). The runtime trust prefixes are always rendered.
 */
async function renderFor(policy, anchors) {
  const runtime = await runtimeFor(policy, anchors);
  const r = generateSeatbeltProfile({ policy, anchors, runtime: { prefixes: runtime.prefixes, entries: runtime.entries } });
  const unresolved = Array.isArray(runtime.unresolved) ? runtime.unresolved : [];
  return { text: renderProfileFile(r, { policySha256: canonicalSha256(policy) }), gaps: r.gaps, unresolved, result: r };
}

const unresolvedLine = (name) => `seatbelt: GAP — runtime program not found in any trusted dir (writers get ENOENT): ${name}\n`;

const PIN_RE = /^[0-9a-f]{64}$/;
const hardLinkMsg = (list) => `protected files already carry a second hard link, so a write through the other name changes them and no profile can cover it: ${list.join(", ")} (remove the extra links)`;

/** A profile text without its pin and signature lines (a signer may fill the slot later). */
const unpinned = (text) => text.split("\n").filter((l) => !/^;; (sha256|signature): /.test(l)).join("\n");

// ---- the broker child: runs OUTSIDE the sandbox, stops on stdin EOF or SIGTERM/SIGHUP ----

function brokerChild(rest) {
  let o;
  try {
    o = parseOpts(rest, BROKER_OPTS);
    if (!o["--repo"] || !o["--socket"]) throw new Error("--repo and --socket are required");
    if (!o["--profile"] || !o["--profile-sha256"]) throw new Error("--profile and --profile-sha256 are required (the verified profile the CLI runs under)");
    if (!PIN_RE.test(o["--profile-sha256"])) throw new Error("--profile-sha256 must be 64 lowercase hex characters");
  } catch (e) {
    process.stderr.write(`guard broker: REFUSED TO START — ${e.message}\n`);
    process.exit(2);
  }
  // Read ONCE and verified against the launcher's pin: these are the bytes sandbox-exec applies.
  let profileText;
  try {
    profileText = fs.readFileSync(o["--profile"], "utf8");
    verifyProfileFile(profileText, { expectSha256: o["--profile-sha256"] });
  } catch (e) {
    process.stderr.write(`guard broker: REFUSED TO START — the profile did not verify: ${(e && e.message) || e}\n`);
    process.exit(2);
  }
  const anchors = {};
  if (o["--home"]) anchors.home = o["--home"];
  if (o["--config-dir"]) anchors.config_dir = o["--config-dir"];
  if (o["--vault"]) anchors.vault = o["--vault"];
  let started;
  try {
    started = startServer({ socket: o["--socket"], repo: o["--repo"], anchors, policyFile: o["--policy"] || POLICY_PATH, passEnv: o["--pass-env"] || [], profileText });
  } catch (e) {
    process.stderr.write(`guard broker: REFUSED TO START — ${(e && e.message) || e}\n`);
    process.exit(2);
  }
  const { server, socket, ready } = started;
  const conns = new Set();
  server.on("connection", (c) => {
    conns.add(c);
    c.on("close", () => conns.delete(c));
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // A held-open connection must not keep the broker alive past its launcher.
    for (const c of conns) c.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => {
      try {
        if (fs.lstatSync(socket).isSocket()) fs.unlinkSync(socket);
      } catch {
        // already gone
      }
      process.exit(0);
    }, 1000).unref();
  };
  ready.then(
    () => {},
    (e) => {
      process.stderr.write(`guard broker: REFUSED TO START — ${(e && e.message) || e}\n`);
      process.exit(2);
    },
  );
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
  process.stdin.resume();
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  process.on("SIGINT", () => {});
}

// ---- the launcher side: start, wait for an answer, stop ----

/** Spawn the broker process from an argv; never under sandbox-exec. */
function startBroker(argv, socket) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "ignore", "pipe"], detached: true });
  const b = { child, socket, exit: null, err: "" };
  b.exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve((b.exit = { code, signal })));
    child.once("error", (e) => resolve((b.exit = { code: null, signal: null, error: e.message })));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    if (b.err.length < 4096) b.err += d;
  });
  child.stdin.on("error", () => {}); // EPIPE once the broker is gone
  return b;
}

async function stopBroker(b) {
  if (!b) return;
  try {
    await stopBrokerProcess(b);
  } finally {
    // The verified-profile copy the broker read lives exactly as long as the broker.
    if (b.profileDir) {
      try {
        fs.rmSync(b.profileDir, { recursive: true, force: true });
      } catch {
        // best effort: the dir holds the profile text only
      }
    }
  }
}

async function stopBrokerProcess(b) {
  if (!b.exit) {
    try {
      b.child.stdin.end();
    } catch {
      // the pipe is already closed
    }
    try {
      b.child.kill("SIGTERM");
    } catch {
      // already exited
    }
    const done = await Promise.race([b.exited, sleep(BROKER_STOP_GRACE_MS).then(() => null)]);
    if (done === null) {
      try {
        b.child.kill("SIGKILL");
      } catch {
        // already exited
      }
      await b.exited;
    }
  }
}

/** Run a command with a bound; resolves { status, signal, stderr }. */
function spawnBounded(cmd, args, ms, env) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env });
    let err = "";
    c.stderr.setEncoding("utf8");
    c.stderr.on("data", (d) => {
      if (err.length < 4096) err += d;
    });
    const timer = setTimeout(() => c.kill("SIGKILL"), ms);
    c.once("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stderr: e.message });
    });
    c.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stderr: err });
    });
  });
}

/** Wait until the broker ANSWERS, from outside and from inside the verified profile. */
async function awaitBroker(b, profileText, waitMs) {
  const deadline = Date.now() + waitMs;
  let last = "no answer yet";
  for (;;) {
    if (b.exit) return { ok: false, reason: `it exited (${b.exit.error || b.exit.signal || `code ${b.exit.code}`}) before answering: ${b.err.trim().slice(0, 300)}` };
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, reason: `no answer within ${waitMs} ms (${last})` };
    try {
      const r = await request(b.socket, READINESS_WRITER, [], Math.min(left, 1000));
      if (r && r.refused === true && r.code === "untrusted-writer") break;
      last = `unexpected answer ${JSON.stringify(r).slice(0, 200)}`;
    } catch (e) {
      last = (e && (e.code || e.message)) || String(e);
    }
    await sleep(Math.max(0, Math.min(25, deadline - Date.now())));
  }
  const left = deadline - Date.now();
  if (left <= 0) return { ok: false, reason: `no answer within ${waitMs} ms (the in-profile check had no time left)` };
  const p = await spawnBounded(SANDBOX_EXEC, ["-p", profileText, process.execPath, CLIENT, "--socket", b.socket, READINESS_WRITER], left, process.env);
  if (p.status !== REFUSED_EXIT) {
    return { ok: false, reason: `a client inside the profile could not reach it (client exit ${p.status}${p.signal ? `, ${p.signal}` : ""}): ${p.stderr.trim().slice(0, 300)}` };
  }
  return { ok: true };
}

/** Run the CLI under the verified profile; resolves with its exit status after teardown. */
function runCli(profileText, cmd, env, broker) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(SANDBOX_EXEC, ["-p", profileText, ...cmd], { stdio: "inherit", env });
    const fwd = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        // already exited
      }
    };
    process.on("SIGTERM", fwd("SIGTERM"));
    process.on("SIGHUP", fwd("SIGHUP"));
    // SIGINT is the terminal's to deliver to the CLI (same process group); the launcher stays
    // up so it can stop the broker and report the CLI's status.
    process.on("SIGINT", () => {});
    child.once("error", async (e) => {
      if (settled) return;
      settled = true;
      await stopBroker(broker);
      refuse(`sandbox-exec failed to start: ${e.message}`);
    });
    child.once("exit", async (code, signal) => {
      if (settled) return;
      settled = true;
      await stopBroker(broker);
      resolve(code !== null ? code : 128 + (os.constants.signals[signal] || 0));
    });
  });
}

async function run(rest) {
  const dash = rest.indexOf("--");
  if (dash < 0 || dash === rest.length - 1) refuse("no command after --");
  let o;
  try {
    o = parseOpts(rest.slice(0, dash), RUN_OPTS);
  } catch (e) {
    refuse(e.message);
  }
  const cmd = rest.slice(dash + 1);
  if (!o["--profile"]) refuse("--profile is required");
  // The pin is MANDATORY, --no-broker included: a self-consistent profile is not evidence it is
  // the one the caller meant to apply, so `run` never trusts the file alone.
  if (!o["--expect-sha256"]) refuse("--expect-sha256 is required (the pin of the profile to apply)");
  if (!PIN_RE.test(o["--expect-sha256"])) refuse("--expect-sha256 must be 64 lowercase hex characters");
  const brokerOpts = ["--broker-socket", "--broker-wait-ms", "--pass-env"].filter((k) => k in o);
  if (o["--no-broker"] && brokerOpts.length) refuse(`--no-broker cannot be combined with ${brokerOpts.join(", ")}`);
  let waitMs = DEFAULT_BROKER_WAIT_MS;
  if (o["--broker-wait-ms"] !== undefined) {
    if (!/^[1-9][0-9]{0,6}$/.test(o["--broker-wait-ms"])) refuse("--broker-wait-ms must be a positive integer of milliseconds");
    waitMs = Number(o["--broker-wait-ms"]);
  }

  let text;
  let verified;
  try {
    text = fs.readFileSync(o["--profile"], "utf8");
    verified = verifyProfileFile(text, { expectSha256: o["--expect-sha256"] });
  } catch (e) {
    refuse(`profile did not verify: ${e.message}`);
  }

  // Rendered from the policy in force NOW, or refused by name: a profile rendered before a policy
  // change would apply the older protected set. (The re-render below also differs then; this
  // check names the cause and does not depend on it.)
  let policy;
  let livePin;
  try {
    policy = loadPolicy(o["--policy"] || POLICY_PATH);
    livePin = canonicalSha256(policy);
  } catch (e) {
    refuse(`the live policy did not load: ${e.message}`);
  }
  if (verified.policySha256 !== livePin) {
    refuse(`profile was rendered from policy ${JSON.stringify(verified.policySha256)}, but the live policy pin is ${livePin}; re-render`);
  }

  let anchors;
  let fresh;
  try {
    anchors = anchorsFrom(o);
    fresh = await renderFor(policy, anchors);
    if (unpinned(fresh.text) !== unpinned(text)) {
      throw new Error("its rules differ from a fresh render for these anchors and this policy");
    }
  } catch (e) {
    if (e && e.code === RUNTIME_REFUSED) refuse(`the runtime trust prefixes could not be rendered: ${e.message}`);
    refuse(`the profile is not bound to --repo ${JSON.stringify((anchors && anchors.repo) || o["--repo"] || process.cwd())}: ${e.message}`);
  }
  for (const n of fresh.unresolved) process.stderr.write(unresolvedLine(n));
  // Measured NOW on the fresh render, never trusted from render time: a link made after render
  // is as writable as one made before.
  let linked;
  try {
    linked = hardLinkedTargets(fresh.result);
  } catch (e) {
    refuse(`the protected set could not be checked for hard links: ${e.message}`);
  }
  if (linked.length) refuse(hardLinkMsg(linked));
  // The unlink pins hold only on directories that EXIST: an absent ~/.gnupg or ~/.config could
  // be created from inside by a staged rename or a symlink. Create them now, before the profile
  // applies; a symlink or non-directory standing there is a refusal.
  try {
    preparePinnedDirs(fresh.result);
  } catch (e) {
    refuse(`a pinned directory is not safe to protect: ${e.message}`);
  }

  const probe = probeSandbox(spawnSync);
  if (!probe.ok) refuse(`the sandbox cannot apply on this host: ${probe.reason}`);

  const env = { ...process.env };
  delete env[BROKER_SOCKET_ENV];
  if (o["--no-broker"]) return runCli(text, cmd, env, null);

  let socket = o["--broker-socket"];
  if (!socket) {
    if (!anchors.home) refuse("the broker socket lives under the home anchor, and no home resolved (pass --home)");
    const dflt = defaultSocketPath(anchors.repo, anchors.home);
    socket = path.join(path.dirname(dflt), `${path.basename(dflt, ".sock")}-${process.pid}.sock`);
  } else if (!path.isAbsolute(socket)) {
    refuse("--broker-socket must be an absolute path");
  }
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
    refuse(`the broker socket path is ${Buffer.byteLength(socket)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte macOS limit: ${socket} (use a shorter --home or --broker-socket)`);
  }
  const brokerArgs = [SELF, "broker", "--repo", anchors.repo, "--socket", socket];
  if (anchors.home) brokerArgs.push("--home", anchors.home);
  if (anchors.config_dir) brokerArgs.push("--config-dir", anchors.config_dir);
  if (anchors.vault) brokerArgs.push("--vault", anchors.vault);
  if (o["--policy"]) brokerArgs.push("--policy", path.resolve(o["--policy"]));
  for (const n of o["--pass-env"] || []) brokerArgs.push("--pass-env", n);

  // The broker receives the VERIFIED text — the same bytes sandbox-exec receives — pinned by the
  // verified sha, in a fresh owner-only dir removed by the teardown that stops the broker.
  let profileDir;
  try {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "coc-guard-profile-"));
    const profileFile = path.join(profileDir, "profile.sb");
    fs.writeFileSync(profileFile, text, { mode: 0o600, flag: "wx" });
    brokerArgs.push("--profile", profileFile, "--profile-sha256", verified.sha256);
  } catch (e) {
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
    refuse(`the verified profile could not be written for the broker: ${e.message}`);
  }

  const broker = startBroker([process.execPath, ...brokerArgs], socket);
  broker.profileDir = profileDir;
  // Before the CLI starts, a signal tears the broker down and leaves; nothing was run.
  const early = (sig) => () => stopBroker(broker).then(() => process.exit(128 + os.constants.signals[sig]));
  const earlyHandlers = { SIGTERM: early("SIGTERM"), SIGHUP: early("SIGHUP"), SIGINT: early("SIGINT") };
  for (const [s, h] of Object.entries(earlyHandlers)) process.on(s, h);
  const ready = await awaitBroker(broker, text, waitMs);
  if (!ready.ok) {
    await stopBroker(broker);
    refuse(`the guard broker did not answer: ${ready.reason}`);
  }
  for (const [s, h] of Object.entries(earlyHandlers)) process.off(s, h);
  env[BROKER_SOCKET_ENV] = socket;
  return runCli(text, cmd, env, broker);
}

async function render(rest) {
  let o;
  try {
    o = parseOpts(rest, RENDER_OPTS);
  } catch (e) {
    process.stderr.write(`render: ${e.message}\n`);
    return 2;
  }
  let r;
  let linked;
  try {
    // loadPolicy validates the schema and the integrity pin, and throws on either.
    r = await renderFor(loadPolicy(o["--policy"] || POLICY_PATH), anchorsFrom(o));
    linked = hardLinkedTargets(r.result);
  } catch (e) {
    // A runtime-trust failure is a REFUSAL by name: never a profile without the runtime rules.
    if (e && e.code === RUNTIME_REFUSED) {
      process.stderr.write(`render: REFUSING: ${e.message}. No profile was written.\n`);
      return REFUSED_EXIT;
    }
    process.stderr.write(`render: ${e.message}\n`);
    return 1;
  }
  if (linked.length) {
    process.stderr.write(`render: REFUSING: ${hardLinkMsg(linked)}. No profile was written.\n`);
    return REFUSED_EXIT;
  }
  process.stdout.write(r.text);
  for (const g of r.gaps) process.stderr.write(`seatbelt: GAP — ${g}\n`);
  for (const n of r.unresolved) process.stderr.write(unresolvedLine(n));
  return 0;
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "render") return render(rest);
  if (verb === "run") return run(rest);
  if (verb === "broker") return brokerChild(rest); // internal: started by `run`, outside the sandbox
  process.stderr.write("usage: seatbelt-launch.mjs render|run (see header)\n");
  return 2;
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (e) => {
      process.stderr.write(`seatbelt-launch: ${(e && e.stack) || e}\n`);
      process.exit(REFUSED_EXIT);
    },
  );
}
