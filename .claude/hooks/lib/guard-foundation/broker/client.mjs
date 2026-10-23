// Guard foundation S4 — ask the broker to run a trusted writer. Runs INSIDE the
// sandbox; it only sends {v:1, writer, args} and prints the broker's answer.
//
//   node client.mjs [--socket <path>] <writer-id> [-- <args>...]
//
// The socket is --socket, else $COC_GUARD_BROKER_SOCKET (exported by the OS launcher, which
// starts a broker per launch at a per-launch path). With neither, the client REFUSES: there is
// no default path to dial, because a per-launch broker never binds one. The variable is a
// ROUTING HINT, never a security control — unsetting it inside the sandbox only means no
// broker is asked, and a direct write is then refused by the OS profile itself.
//
// Exit: the writer's own status when it ran and stayed inside its licence;
// 3 when the broker REFUSED (nothing ran); 4 when it ran but wrote outside its
// licence or left an escaping symlink; 5 when no broker could be reached (or none was named).

import net from "node:net";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";

export function request(socket, writer, args, timeoutMs = 11 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("broker did not answer in time"));
    }, timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${JSON.stringify({ v: 1, writer, args })}\n`));
    conn.on("data", (d) => (buf += d));
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    conn.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        reject(new Error(`broker answered non-JSON: ${buf.slice(0, 200)}`));
      }
    });
  });
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  let socket = null;
  if (argv[0] === "--socket") {
    argv.shift();
    socket = argv.shift();
  }
  const writer = argv.shift();
  if (argv[0] === "--") argv.shift();
  if (!writer || socket === undefined) {
    process.stderr.write("usage: client.mjs [--socket <path>] <writer-id> [-- <args>...]\n");
    process.exit(2);
  }
  socket = socket || process.env.COC_GUARD_BROKER_SOCKET || null;
  if (!socket) {
    process.stderr.write("guard broker unreachable: no broker named (no --socket and COC_GUARD_BROKER_SOCKET is unset); nothing was asked\n");
    process.exit(5);
  }
  request(socket, writer, argv).then(
    (r) => {
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.refused) {
        process.stderr.write(`guard broker REFUSED (${r.code}): ${r.detail}\n`);
        process.exit(3);
      }
      if (r.outside_licence.length || r.escapes.length) {
        process.stderr.write(`guard broker: ${r.writer} wrote OUTSIDE its licence: ${[...r.outside_licence, ...r.escapes].join(", ")}\n`);
        process.exit(4);
      }
      process.exit(typeof r.rc === "number" ? r.rc : 1);
    },
    (e) => {
      process.stderr.write(`guard broker unreachable: ${(e && e.message) || e}\n`);
      process.exit(5);
    },
  );
}
