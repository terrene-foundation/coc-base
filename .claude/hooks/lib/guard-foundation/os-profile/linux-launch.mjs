#!/usr/bin/env node
// Stand-alone Linux launcher (guard foundation S2): run ANY CLI inside a
// rendered profile file, with the S4 broker running OUTSIDE it, and no csq or
// trestle involved. csq and trestle consume the same file through the same
// verify + probe.
//
//   node linux-launch.mjs render --repo <root> [--policy <file>] [--home <dir>]
//        [--config-dir <dir>] [--vault <dir>] [--precreate] > profile.json
//   node linux-launch.mjs run --profile <file> --expect-sha256 <hex>
//        [--backend auto|bwrap|unshare] [--unshare <bin>] [--accept-absent]
//        [--broker-socket <path>] [--broker-wait-ms <n>] [--pass-env NAME]... [--no-broker]
//        -- <cli> [args...]
//
// `run` IS DISABLED (fail closed, no override): it refuses with exit 3 before
// parsing an argument, starting the broker, creating a socket or directory, or
// spawning anything. Open HIGH finding, measured at 7e7685760: a write from a
// working directory inherited from before launch is not covered by the
// read-only binds. Lifting the refusal is a code change scheduled for RUN 9 —
// no flag, argument or environment variable re-enables `run`. Until then the
// steps below describe the run path that RUN 9 re-enables, and none executes.
// linux.mjs's public builders (generateLinuxProfile, renderProfileFile,
// unshareSetupScript, sandboxCommand) refuse the same way for any other
// launcher; `render` here uses the INTERNAL builders and keeps working.
//
// `run`, in order — every step that fails REFUSES (exit 3, the CLI never runs),
// and nothing ever falls back to an unsandboxed run:
//   1. Arguments are parsed strictly: an unknown or repeated option is refused,
//      so a typo in `--expect-sha256` cannot silently drop the pin.
//   2. The profile is read ONCE and verified against the MANDATORY pin; the
//      verified object is what the sandbox and the broker are built from.
//   3. The profile must have been rendered from the LIVE policy (its pin), have
//      no hard-linked protected file, and cover every protected path (absent
//      ones refuse unless --accept-absent).
//   4. Backend: bwrap, or the managed unshare a host grants the userns
//      exception to (--unshare, else LOOM_GUARD_UNSHARE, else `unshare`); `auto`
//      takes the first whose capability probe shows the sandbox applying.
//   5. BROKER (default ON): this launcher starts the broker as its OWN child
//      process, OUTSIDE the namespace, by re-running this file as `broker`
//      (server.mjs::startServer), bound to the profile's repo root and anchors,
//      so the broker and the sandbox protect the same world by construction.
//      Its socket is per launch,
//      `<home>/.cache/coc-guard-broker/<sha256(repo)[:16]>-<launcher pid>.sock`
//      (or --broker-socket), inside the policy row whose path is that socket
//      dir: the profile mounts the dir READ-ONLY, so a sandboxed process cannot
//      unlink or replace the socket, while connecting to it stays allowed
//      (connect(2) to a unix socket is not a filesystem write). The launcher
//      does not reason about that from the paths: it MEASURES it (step 6).
//   6. READINESS, bounded by --broker-wait-ms (default 10000): (a) from
//      outside, a request for a writer id no policy can name (`__readiness__`
//      fails the policy's id pattern) must come back as the broker's own
//      `untrusted-writer` refusal — a real round trip through the policy check,
//      never a sleep; (b) then `client.mjs` run INSIDE the verified profile
//      must reach it (client exit 3 = the broker answered). A broker that
//      exits, never answers in time, or cannot be reached from inside is a
//      refusal; the broker is stopped first.
//   7. The CLI runs inside the profile with COC_GUARD_BROKER_SOCKET=<socket>
//      in its environment (removed under --no-broker).
//   8. TEARDOWN: when the CLI exits, the broker is stopped (stdin closed +
//      SIGTERM, SIGKILL after a grace period) and AWAITED, then the launcher
//      exits with the CLI's status (128 + signal number on a signal). SIGTERM
//      and SIGHUP are forwarded to the CLI; SIGINT is the terminal's to deliver.
//      The broker runs in its own session and stops by itself when its stdin
//      reaches EOF, so it does not outlive a launcher that is SIGKILLed.
//
// `--no-broker` is the explicit opt-out: every protected write, trusted
// writers included, is refused for the session. It cannot be combined with the
// broker options.
//
// Known property, stated rather than hidden: a protected file that a trusted
// writer REPLACES (write-to-temp + rename) outside the namespace is a new inode,
// and the read-only bind inside still shows the old one until the next launch.
// Linux's unix-socket path limit is 107 bytes; a longer socket path is refused.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyProfileFile, probeSandbox, RUN_DISABLED, _internalLinuxProfile } from "./linux.mjs";
import { loadPolicy, POLICY_PATH } from "../policy/policy.mjs";
import { startServer, defaultSocketPath } from "../broker/server.mjs";
import { request } from "../broker/client.mjs";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";

export const REFUSED_EXIT = 3;
export const BROKER_SOCKET_ENV = "COC_GUARD_BROKER_SOCKET";
export const UNSHARE_ENV = "LOOM_GUARD_UNSHARE";
// ONE finding text, owned by linux.mjs (its public builders throw it too).
export { RUN_DISABLED };
// The working builders: INTERNAL to this launcher (the public ones refuse until RUN 9).
// `run` (disabled) keeps the PUBLIC verifyProfileFile, which also refuses every
// Linux profile until RUN 9; `render` self-checks with the internal verifier.
const { generateLinuxProfile, renderProfileFile, sandboxCommand, verifyProfileFile: verifyRenderedInternal } = _internalLinuxProfile;

const SELF = fileURLToPath(import.meta.url);
const CLIENT = path.join(path.dirname(SELF), "..", "broker", "client.mjs");
// Fails policy.mjs's id pattern (^[a-z0-9][a-z0-9-]*$), so no policy can make it trusted.
const READINESS_WRITER = "__readiness__";
const DEFAULT_BROKER_WAIT_MS = 10000;
const BROKER_STOP_GRACE_MS = 5000;
const MAX_SOCKET_PATH_BYTES = 107; // Linux sun_path is 108 bytes, the terminating NUL included

const RENDER_OPTS = { valued: ["--repo", "--policy", "--home", "--config-dir", "--vault"], flags: ["--precreate"], multi: [] };
const RUN_OPTS = {
  valued: ["--profile", "--expect-sha256", "--backend", "--unshare", "--broker-socket", "--broker-wait-ms", "--pass-env"],
  flags: ["--accept-absent", "--no-broker"],
  multi: ["--pass-env"],
};
const BROKER_OPTS = { valued: ["--repo", "--socket", "--home", "--config-dir", "--vault", "--pass-env"], flags: [], multi: ["--pass-env"] };

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

// ---- the broker child: runs OUTSIDE the namespace, stops on stdin EOF or SIGTERM/SIGHUP ----

function brokerChild(rest) {
  let o;
  try {
    o = parseOpts(rest, BROKER_OPTS);
    if (!o["--repo"] || !o["--socket"]) throw new Error("--repo and --socket are required");
  } catch (e) {
    process.stderr.write(`guard broker: REFUSED TO START — ${e.message}\n`);
    process.exit(2);
  }
  const anchors = {};
  if (o["--home"]) anchors.home = o["--home"];
  if (o["--config-dir"]) anchors.config_dir = o["--config-dir"];
  if (o["--vault"]) anchors.vault = o["--vault"];
  let started;
  try {
    // The LIVE policy, the same one whose pin `run` checked the profile against.
    started = startServer({ socket: o["--socket"], repo: o["--repo"], anchors, policyFile: POLICY_PATH, passEnv: o["--pass-env"] || [] });
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

/** Spawn the broker process; never inside the namespace. */
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
  if (!b || b.exit) return;
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
async function awaitBroker(b, file, sandbox, waitMs) {
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
  const [bin, args] = sandboxCommand(file, sandbox, [process.execPath, CLIENT, "--socket", b.socket, READINESS_WRITER]);
  const p = await spawnBounded(bin, args, left, process.env);
  if (p.status !== REFUSED_EXIT) {
    return { ok: false, reason: `a client inside the profile could not reach it (client exit ${p.status}${p.signal ? `, ${p.signal}` : ""}): ${p.stderr.trim().slice(0, 300)}` };
  }
  return { ok: true };
}

/** Run the CLI inside the verified profile; resolves with its exit status after teardown. */
function runCli(file, sandbox, cmd, env, broker) {
  return new Promise((resolve) => {
    let settled = false;
    const [bin, args] = sandboxCommand(file, sandbox, cmd);
    const child = spawn(bin, args, { stdio: "inherit", env });
    const fwd = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        // already exited
      }
    };
    process.on("SIGTERM", fwd("SIGTERM"));
    process.on("SIGHUP", fwd("SIGHUP"));
    // SIGINT is the terminal's to deliver to the CLI (same process group); the
    // launcher stays up so it can stop the broker and report the CLI's status.
    process.on("SIGINT", () => {});
    child.once("error", async (e) => {
      if (settled) return;
      settled = true;
      await stopBroker(broker);
      refuse(`${sandbox.backend} failed to start: ${e.message}`);
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
  // FAIL CLOSED until RUN 9: refuse before anything else happens. Not a switch.
  refuse(RUN_DISABLED);
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
  // The pin is MANDATORY: a self-consistent profile is not evidence it is the
  // one the caller meant to apply, so `run` never trusts the file alone.
  if (!o["--expect-sha256"]) refuse("--expect-sha256 is required (the pin of the profile to apply)");
  const brokerOpts = ["--broker-socket", "--broker-wait-ms", "--pass-env"].filter((k) => k in o);
  if (o["--no-broker"] && brokerOpts.length) refuse(`--no-broker cannot be combined with ${brokerOpts.join(", ")}`);
  let waitMs = DEFAULT_BROKER_WAIT_MS;
  if (o["--broker-wait-ms"] !== undefined) {
    if (!/^[1-9][0-9]{0,6}$/.test(o["--broker-wait-ms"])) refuse("--broker-wait-ms must be a positive integer of milliseconds");
    waitMs = Number(o["--broker-wait-ms"]);
  }

  let file;
  try {
    file = verifyProfileFile(fs.readFileSync(o["--profile"], "utf8"), { expectSha256: o["--expect-sha256"] });
  } catch (e) {
    refuse(`profile did not verify: ${e.message}`);
  }
  // Rendered from the policy in force NOW, or refused: a profile rendered
  // before a policy change would silently apply the older protected set.
  let livePin;
  try {
    livePin = loadPolicy().integrity.sha256;
  } catch (e) {
    refuse(`the live policy did not load: ${e.message}`);
  }
  if (file.policy_sha256 !== livePin) {
    refuse(`profile was rendered from policy ${file.policy_sha256}, but the live policy pin is ${livePin}; re-render`);
  }
  if (Array.isArray(file.hardlinked) && file.hardlinked.length) {
    refuse(`protected files have a second hard link outside the profile, writable through it: ${file.hardlinked.join(", ")}`);
  }
  if (file.absent.length && !o["--accept-absent"]) {
    refuse(`protected paths were absent at render time and are NOT covered: ${file.absent.map((a) => a.path).join(", ")} (re-render with --precreate, or pass --accept-absent)`);
  }

  const want = o["--backend"] || "auto";
  if (!["auto", "bwrap", "unshare"].includes(want)) refuse(`unknown --backend ${want}`);
  const unshareBin = o["--unshare"] || process.env[UNSHARE_ENV] || "unshare";
  const reasons = [];
  let sandbox = null;
  for (const backend of want === "auto" ? ["bwrap", "unshare"] : [want]) {
    const probe = probeSandbox(spawnSync, { backend, unshareBin });
    if (probe.ok) {
      sandbox = { backend, unshareBin };
      break;
    }
    reasons.push(`${backend}: ${probe.reason}`);
  }
  if (!sandbox) refuse(`the sandbox cannot apply on this host: ${reasons.join("; ")}`);

  const env = { ...process.env };
  delete env[BROKER_SOCKET_ENV];
  if (o["--no-broker"]) return runCli(file, sandbox, cmd, env, null);

  const anchors = file.anchors || {};
  let socket = o["--broker-socket"];
  if (!socket) {
    if (!anchors.home) refuse("the broker socket lives under the home anchor, and the profile was rendered with no home");
    const dflt = defaultSocketPath(file.repo_root, anchors.home);
    socket = path.join(path.dirname(dflt), `${path.basename(dflt, ".sock")}-${process.pid}.sock`);
  } else if (!path.isAbsolute(socket)) {
    refuse("--broker-socket must be an absolute path");
  }
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
    refuse(`the broker socket path is ${Buffer.byteLength(socket)} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte Linux limit: ${socket} (use a shorter home or --broker-socket)`);
  }
  const brokerArgs = [SELF, "broker", "--repo", file.repo_root, "--socket", socket];
  if (anchors.home) brokerArgs.push("--home", anchors.home);
  if (anchors.config_dir) brokerArgs.push("--config-dir", anchors.config_dir);
  if (anchors.vault) brokerArgs.push("--vault", anchors.vault);
  for (const n of o["--pass-env"] || []) brokerArgs.push("--pass-env", n);

  const broker = startBroker([process.execPath, ...brokerArgs], socket);
  // Before the CLI starts, a signal tears the broker down and leaves; nothing was run.
  const early = (sig) => () => stopBroker(broker).then(() => process.exit(128 + os.constants.signals[sig]));
  const earlyHandlers = { SIGTERM: early("SIGTERM"), SIGHUP: early("SIGHUP"), SIGINT: early("SIGINT") };
  for (const [s, h] of Object.entries(earlyHandlers)) process.on(s, h);
  const ready = await awaitBroker(broker, file, sandbox, waitMs);
  if (!ready.ok) {
    await stopBroker(broker);
    refuse(`the guard broker did not answer: ${ready.reason}`);
  }
  for (const [s, h] of Object.entries(earlyHandlers)) process.off(s, h);
  env[BROKER_SOCKET_ENV] = socket;
  return runCli(file, sandbox, cmd, env, broker);
}

function render(rest) {
  let o;
  try {
    o = parseOpts(rest, RENDER_OPTS);
  } catch (e) {
    process.stderr.write(`render: ${e.message}\n`);
    return 2;
  }
  try {
    // loadPolicy validates the schema and the integrity pin, and throws on either.
    const profile = generateLinuxProfile(loadPolicy(o["--policy"] || POLICY_PATH), {
      repoRoot: o["--repo"] || process.cwd(),
      home: o["--home"] || process.env.HOME,
      configDir: o["--config-dir"] || process.env.CLAUDE_CONFIG_DIR,
      vault: o["--vault"],
      precreate: Boolean(o["--precreate"]),
    });
    const text = renderProfileFile(profile);
    // Self-check before emitting: the file must verify, and must carry the RUN 9 marker.
    const self = verifyRenderedInternal(text);
    if (self.disabled !== RUN_DISABLED) throw new Error("rendered profile lacks the RUN 9 disabled marker");
    process.stdout.write(text);
  } catch (e) {
    process.stderr.write(`render: ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "render") return render(rest);
  if (verb === "run") return run(rest);
  if (verb === "broker") return brokerChild(rest); // internal: started by `run`, outside the namespace
  process.stderr.write("usage: linux-launch.mjs render|run (see header)\n");
  return 2;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (e) => {
      process.stderr.write(`linux-launch: ${(e && e.stack) || e}\n`);
      process.exit(REFUSED_EXIT);
    },
  );
}
