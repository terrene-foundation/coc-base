// Guard foundation S4 — the broker's unix-socket server. Started by the LAUNCHER
// outside the sandbox (csq at session launch, trestle at placement, or by hand),
// bound to ONE repository. Protocol: the client writes ONE JSON line
// {v:1, writer, args}; the server answers ONE JSON line (broker.mjs::handle) and
// closes. Requests are handled one at a time (handle() is synchronous), so two
// trusted writers never run at once and the before/after digest is attributable.
// ONE REQUEST PER CONNECTION: the first newline-terminated line is the request, handled
// exactly once; every byte after it — the rest of that chunk, or any later chunk — is ignored,
// so one connection can never run a writer twice. A handle() that throws despite its contract
// is answered `broker-failed`, never allowed to take the server down.
//
//   node server.mjs --repo <root> [--socket <path>] [--vault <dir>] [--config-dir <dir>]
//                   [--home <dir>] [--pass-env NAME]... [--profile <file> --profile-sha256 <hex>]
//
// --profile names the launch profile (Seatbelt text) the sandbox runs under, and
// --profile-sha256 the pin of its bytes (64 lowercase hex, as the launcher verified it). The two
// come together or not at all. The file is read ONCE at start; sha256 of THOSE bytes must equal
// the pin, or the server REFUSES TO START (exit 2, the mismatch named). That start-time check is
// the flag's whole effect: the verified text comes back as `profileText`, but createBroker does
// not take it (broker.mjs:178 reads only repo, anchors, policyFile, passEnv and timeoutMs), so
// admission never reads runtime coverage and the broker has no `runtime-untrusted` refusal.
// Runtime trust is enforced where the profile is rendered: seatbelt-launch.mjs write-denies the
// runtime-trust prefixes in every profile it renders, or refuses (seatbelt-launch.mjs:22-30).
// PATH IS passed through: it is in the broker's env allowlist (broker.mjs:58, copied into the
// writer's env at broker.mjs:284-285), so a writer finds external programs on the launcher's
// PATH. Keeping a writable directory off that PATH is the launcher's job (closure.mjs:33-36).
//
// The default socket is <home>/.cache/coc-guard-broker/<sha256(repo)[:16]>.sock —
// the path a CLI sandbox must allow (Claude Code: sandbox.network.allowUnixSockets).
// The socket directory is created 0700 and refused if it is a symlink. A process
// inside the sandbox that squats or removes the socket gains nothing: a fake
// broker has no out-of-sandbox power, and a missing one refuses every write.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";
import { createBroker } from "./broker.mjs";

const MAX_REQUEST_BYTES = 512 * 1024;

export function defaultSocketPath(repo, home = os.homedir()) {
  const id = crypto.createHash("sha256").update(fs.realpathSync(repo)).digest("hex").slice(0, 16);
  return path.join(home, ".cache", "coc-guard-broker", `${id}.sock`);
}

function prepareSocket(sock) {
  const dir = path.dirname(sock);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dst = fs.lstatSync(dir);
  if (dst.isSymbolicLink() || !dst.isDirectory()) throw new Error(`socket directory ${dir} is not a real directory`);
  const st = fs.lstatSync(sock, { throwIfNoEntry: false });
  if (st) {
    if (!st.isSocket()) throw new Error(`${sock} exists and is not a socket; refusing to replace it`);
    fs.unlinkSync(sock);
  }
}

export function startServer({ socket, ...brokerOpts }) {
  const broker = createBroker(brokerOpts);
  const sock = socket || defaultSocketPath(broker.repo);
  prepareSocket(sock);
  const server = net.createServer((conn) => {
    let buf = "";
    // Set the moment the connection's one request is TAKEN (or refused), before it is handled:
    // every later data event returns here, so no chunk can re-parse the line and re-run a writer.
    let taken = false;
    const reply = (obj) => conn.end(`${JSON.stringify(obj)}\n`);
    conn.setEncoding("utf8");
    conn.on("data", (d) => {
      if (taken) return;
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0 && buf.length <= MAX_REQUEST_BYTES) return;
      taken = true;
      const line = nl < 0 ? null : buf.slice(0, nl);
      buf = "";
      if (line === null || line.length > MAX_REQUEST_BYTES) return reply({ ok: false, refused: true, code: "bad-request", detail: "request too large" });
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        return reply({ ok: false, refused: true, code: "bad-request", detail: "not JSON" });
      }
      let res;
      try {
        res = broker.handle(req);
      } catch (e) {
        // Not `refused`: past admission the writer may have run, so its outcome is UNKNOWN (rc null ⇒ the client exits non-zero).
        const msg = String((e && e.message) || e).slice(0, 300);
        res = { ok: false, refused: false, code: "broker-failed", detail: `the broker failed on this request (whether the writer ran is unknown) and stays up: ${msg}`, rc: null, outside_licence: [], escapes: [] };
      }
      reply(res);
    });
    conn.on("error", () => {});
  });
  // `ready` settles only after the socket is owner-only (the 0700 directory is
  // the primary fence; the mode is the second).
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      fs.chmodSync(sock, 0o600);
      resolve();
    });
  });
  return { server, socket: sock, broker, ready };
}

const PIN_RE = /^[0-9a-f]{64}$/;

/**
 * The server's argv → startServer options. --profile and --profile-sha256 are required together;
 * the profile file is read ONCE, here, and its text is returned as `profileText` only when sha256
 * of exactly those bytes equals the pin. Any violation throws (the CLI refuses to start). The
 * broker does not read `profileText` (see the header).
 */
export function parseServerArgs(argv) {
  const o = { anchors: {}, passEnv: [], profileText: null };
  let profileFile = null;
  let profilePin = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--repo") (o.repo = v), i++;
    else if (k === "--socket") (o.socket = v), i++;
    else if (k === "--vault") (o.anchors.vault = v), i++;
    else if (k === "--config-dir") (o.anchors.config_dir = v), i++;
    else if (k === "--home") (o.anchors.home = v), i++;
    else if (k === "--pass-env") (o.passEnv.push(v), i++);
    else if (k === "--profile") {
      if (profileFile !== null) throw new Error("--profile given twice");
      if (!v) throw new Error("--profile needs a file");
      profileFile = v;
      i++;
    } else if (k === "--profile-sha256") {
      if (profilePin !== null) throw new Error("--profile-sha256 given twice");
      if (!v || !PIN_RE.test(v)) throw new Error("--profile-sha256 must be 64 lowercase hex characters");
      profilePin = v;
      i++;
    } else throw new Error(`unknown argument ${k}`);
  }
  if (!o.repo) throw new Error("--repo is required");
  if ((profileFile === null) !== (profilePin === null)) {
    throw new Error(profileFile === null ? "--profile-sha256 given without --profile: a pin with no profile to verify" : "--profile given without --profile-sha256: an unpinned profile is never read as coverage");
  }
  if (profileFile !== null) {
    // Read ONCE, here, and verify THESE bytes, so the pin is checked against the bytes the
    // launcher handed over, never against a file a later writer could swap.
    const bytes = fs.readFileSync(profileFile);
    const got = crypto.createHash("sha256").update(bytes).digest("hex");
    if (got !== profilePin) throw new Error(`--profile ${profileFile}: sha256 ${got} does not match --profile-sha256 ${profilePin}`);
    o.profileText = bytes.toString("utf8");
  }
  return o;
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  try {
    const { socket, ready } = startServer(parseServerArgs(process.argv.slice(2)));
    ready.then(
      () => process.stdout.write(`guard broker listening on ${socket}\n`),
      (e) => {
        process.stderr.write(`guard broker: REFUSED TO START — ${(e && e.message) || e}\n`);
        process.exit(2);
      },
    );
  } catch (e) {
    process.stderr.write(`guard broker: REFUSED TO START — ${(e && e.message) || e}\n`);
    process.exit(2);
  }
}
