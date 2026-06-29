#!/usr/bin/env node
/*
 * sync-from-canon-fetch — the resolver-backed LIVE remote ref-fetch of canon's
 * artifact tip (loom#576 SHARD 1 — the SAFE, NON-MUTATING half of the
 * sync-from-canon driver).
 *
 * WHAT THIS IS (grounded in source):
 *   The cross-ecosystem upstream-pull (a client ecosystem FORK SEEing canon's
 *   latest and DECIDING per-change whether to roll it in) is the documented
 *   multi-ecosystem model (`rules/artifact-flow.md` § "Ecosystem Forks vs
 *   Downstream Consumers"). The fold substrate ships
 *   (`.claude/hooks/lib/fold-upstream-canon.js` + the `loom-links.mjs` /
 *   `ecosystem-config.mjs` two-layer resolver); the DRIVER did not. This tool
 *   is SHARD 1's load-bearing half: it RESOLVES canon via the two-layer
 *   resolver and READS canon's current tip via `git ls-remote` — read-only,
 *   NO objects fetched into the local store, NO merge applied.
 *
 * CANON-REMOTE RESOLUTION (`rules/cross-repo.md` § "Ecosystem-Scoped Remote
 * Links"): the fetchable canon URL comes from the ecosystem-remote registry
 * (`ecosystem.json`) — primarily the explicit `ecosystem.upstream_canon.url`
 * pointer (`ecosystem-config.mjs::getUpstreamCanon`), falling back to the
 * `remote_links.loom` binding (`loom-links.mjs::resolveRemote`) when the
 * pointer names only a logical remote. Both are ecosystem-layer values — a live
 * remote read needs a URL, not a path. The operator-local resolver layer
 * (`loom-links.local.json`) governs on-disk checkout location (WHERE) and is
 * orthogonal to this live remote read.
 *
 * THE BOUNDARY DISCRIMINATOR is the SHIPPED keystone
 * `ecosystem-config.mjs::getUpstreamCanon()`: null in canon (canon is the
 * root — nothing upstream to pull), set in a fork (the canon it syncs from).
 * Running this at canon returns status "canon-root" and never touches the
 * network.
 *
 * WHAT THIS IS NOT (SHARD 2, deferred — #576):
 *   - the GATED per-change human-decide pull-merge (auto-merge is BLOCKED by
 *     contract, `rules/artifact-flow.md` § "Cascade is scoped to the
 *     ecosystem");
 *   - the Gate-1 Intake Disclosure Scrub routing of the pulled surface
 *     (`scan-synced-disclosure.mjs --root` + human body-scrub) the merge MUST
 *     run before placement;
 *   - the fork->canon write-back fence (the
 *     `cross-ecosystem-disclosure-guard.js` AC-2 intake wiring).
 *   This tool performs NONE of those — it only reports what canon's tip IS so a
 *   human (SHARD 2) can decide. The returned object carries `merged: false` as
 *   a structural invariant a consumer can assert.
 *
 * Style: Node ESM, zero dependencies. Mirrors the sibling read-only probe
 * `check-sync-freshness.mjs` (also `git ls-remote`-only, also never mutates the
 * working tree). All injectable deps (getUpstreamCanonFn / resolveRemoteFn /
 * lsRemoteFn) let the node:test suite supply deterministic fakes with no
 * network. Per `rules/zero-tolerance.md` Rule 3: every failure is a typed,
 * loud throw — no silent fallback.
 *
 * Usage:
 *   node .claude/bin/sync-from-canon-fetch.mjs            # human-readable
 *   node .claude/bin/sync-from-canon-fetch.mjs --json     # JSON
 *   node .claude/bin/sync-from-canon-fetch.mjs --ref refs/heads/main
 *
 * Exit codes: 0 = resolved (incl. canon-root); 1 = resolution/fetch error;
 *             2 = usage error.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getUpstreamCanon } from "./lib/ecosystem-config.mjs";
import { resolveRemote } from "./lib/loom-links.mjs";

// ────────────────────────────────────────────────────────────────
// Typed error (mirrors loom-links LinkError / ecosystem EcosystemConfigError)
//   not-a-fork              : this repo is canon (no upstream_canon) — caller
//                             should treat as a no-op, NOT an error. (Returned
//                             as status "canon-root", never thrown.)
//   unresolved-canon-remote : a fork DECLARES a canon but no fetchable URL
//                             resolves (neither upstream_canon.url nor
//                             resolveRemote('loom').url).
//   option-injection        : a url/ref begins with '-' (would be parsed by git
//                             as an option, e.g. --upload-pack=<cmd>) — refused
//                             BEFORE exec.
//   scheme-rejected         : the url uses a non-allowlisted git transport — a
//                             remote-helper scheme (ext::/fd::/<transport>::addr)
//                             or file:: executes a program / reads local paths;
//                             only https/ssh/git/scp-like are accepted.
//   ls-remote-failed        : the `git ls-remote` read against canon failed,
//                             timed out, or returned unrecognized output.
// ────────────────────────────────────────────────────────────────
export class SyncFromCanonError extends Error {
  constructor(subtype, message) {
    super(message);
    this.name = "SyncFromCanonError";
    this.subtype = subtype;
  }
}

// Redact URL userinfo before embedding a url in ANY error message / log line.
// A `https://user:TOKEN@host/repo.git` (or scp-like `user@host:path`) carries a
// credential in the userinfo segment; echoing it verbatim leaks the token to
// stderr + the --json `error` field (security.md § "No secrets in logs").
// Rewrites the userinfo to `<redacted>@` in BOTH the scheme-URL form (anywhere
// in the string, so an embedded url in a wrapped stderr line is covered too) and
// the scp-like leading form. Non-string → returned unchanged.
function redactUserinfo(s) {
  if (typeof s !== "string") return s;
  // scheme://[userinfo@]host  →  scheme://<redacted>@host  (global: covers an
  // embedded url inside a longer diagnostic string).
  let out = s.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g, "$1<redacted>@");
  // scp-like [userinfo@]host:path at string start (no scheme) → <redacted>@…
  if (!/:\/\//.test(s)) out = out.replace(/^[^/@\s]+@/, "<redacted>@");
  return out;
}

// Redact secrets from a result BEFORE it is PRINTED (stdout / --json / human
// slug). The SUCCESS path's `canon.url` can carry a credentialed pointer
// (e.g. `https://x-access-token:TOKEN@github.com/...` from ecosystem.json), so
// echoing the raw result to a log/console leaks the token (security.md § "No
// secrets in logs"). The in-memory RETURN of resolveCanonTip keeps the real url
// for a programmatic SHARD-2 caller (which re-resolves from config anyway);
// only the printed copy is redacted. Non-fetched results pass through unchanged.
function redactResultForOutput(result) {
  if (result && result.status === "fetched" && result.canon && result.canon.url) {
    return {
      ...result,
      canon: { ...result.canon, url: redactUserinfo(result.canon.url) },
    };
  }
  return result;
}

// Reject a value git would parse as an OPTION rather than a positional. A url
// or ref beginning with '-' (e.g. `--upload-pack=<cmd>`) is a known ls-remote
// ref-read RCE class; refuse with a typed, greppable throw BEFORE exec. The
// `--` end-of-options separator in defaultLsRemote is belt-and-suspenders.
function assertGitSafeArg(name, val) {
  if (typeof val === "string" && val.startsWith("-")) {
    throw new SyncFromCanonError(
      "option-injection",
      `sync-from-canon: refusing ${name} that begins with '-' (git option-injection guard): ${JSON.stringify(redactUserinfo(val))}`,
    );
  }
}

// Strict hostname validation for the explicit-scheme branch. WHATWG `new URL`
// does NOT percent-decode the hostname for NON-special schemes (ssh://, git://),
// so a raw `%2devil` host (which git percent-decodes to `-evil` before handing it
// to ssh → option-injection RCE, byte-identical to the raw `ssh://-evil` we
// reject) would slip past a raw-string check. DECODE first (a malformed `%`
// sequence throws → fail closed), THEN require a strict hostname shape:
// alnum-start, alnum-end, only alnum/dot/hyphen between — no leading/trailing
// dash, no `%`, `@`, whitespace, control char (`%0a`), or bracket/IPv6-junk. This
// subsumes the old `!startsWith('-')` check AND closes the `%2d`/`%0a`/bracket
// classes in one rule. Punycode IDN (xn--…) and IPv4 literals pass; IPv6 literals
// `[::1]` are rejected (canon remotes don't use them — fail-closed is fine).
function isStrictHost(rawHost) {
  if (!rawHost) return false;
  let host;
  try {
    host = decodeURIComponent(rawHost);
  } catch {
    return false; // malformed %-sequence → fail closed
  }
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

// Strict username validation (the userinfo half). Empty userinfo is allowed (no
// login). A present username is DECODED (malformed `%` → fail closed) then MUST
// be a clean token: alnum-start, then alnum/dot/underscore/tilde/hyphen only.
// This rejects a '-'-leading login (`ssh://-oProxyCommand=x@host` — handed to ssh
// as `-l <login>`, option-injection class) AND a control-char/`%0a` login, while
// accepting the real canon logins (`git`, `x-access-token`, `oauth2`).
function isStrictUser(rawUser) {
  if (rawUser === "" || rawUser == null) return true;
  let user;
  try {
    user = decodeURIComponent(rawUser);
  } catch {
    return false; // malformed %-sequence → fail closed
  }
  return /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(user);
}

// Positive URL-scheme allowlist (SEC: git remote-helper command-execution).
// Git's transport-helper forms `<transport>::<address>` (e.g. `ext::sh -c <cmd>`,
// `fd::…`) make `git ls-remote` EXECUTE a program — turning a "read-only" probe
// into arbitrary command execution. The canon url comes from operator-controlled
// config (ecosystem.json / resolveRemote), so it MUST be scheme-validated BEFORE
// exec. Accept ONLY: https:// , ssh:// , git:// , and scp-like [user@]host:path
// SSH shorthand. Reject ext:: / fd:: / file:: / any other `<token>::` helper or
// scheme with a typed, greppable throw.
function assertAllowedScheme(name, url) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new SyncFromCanonError(
      "unresolved-canon-remote",
      `sync-from-canon: empty/invalid ${name} url`,
    );
  }
  // Explicit-scheme URL form (has "://") — parse with the WHATWG URL parser, which
  // cleanly SEPARATES userinfo from hostname (no backtracking-regex bypass: an
  // optional userinfo group could match zero-width and anchor the alnum check on
  // the userinfo's first char, accepting `ssh://user@-evilhost`). A '-'-leading
  // HOSTNAME — incl. the userinfo-present `ssh://user@-evilhost` and double-`@`
  // `ssh://a@b@-evil` forms — is handed verbatim to the ssh sub-process git
  // spawns, which parses it as an OPTION → RCE (the `--` separator protects git's
  // OWN argv, not ssh's; `protocol.{ext,fd}.allow=never` do not touch ssh). Accept
  // ONLY protocol ∈ {https,ssh,git} with a host AND userinfo that pass the
  // decode+strict-shape check below.
  if (url.includes("://")) {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null; // unparseable → fall through to the typed throw below
    }
    if (
      parsed &&
      (parsed.protocol === "https:" ||
        parsed.protocol === "ssh:" ||
        parsed.protocol === "git:") &&
      isStrictHost(parsed.hostname) &&
      isStrictUser(parsed.username)
    ) {
      return;
    }
    throw new SyncFromCanonError(
      "scheme-rejected",
      `sync-from-canon: refusing ${name} — only https://, ssh://, git:// with a ` +
        `non-empty, non-'-'-leading host accepted (file:///, http://, other schemes, ` +
        `and '-'-leading hosts are BLOCKED): ${JSON.stringify(redactUserinfo(url))}`,
    );
  }
  // scp-like SSH shorthand: [user@]host:path — no "://", userinfo AND host first
  // char alphanumeric (rejects `git@-evil:path` AND `-evil:path`, same
  // ssh-option-injection class), a ':' before any path, and the char after ':' is
  // NOT another ':' (which would be a remote-helper `transport::address` form).
  if (
    !url.includes("://") &&
    /^([A-Za-z0-9][A-Za-z0-9._~-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*:(?!:)[^\s].*$/.test(url)
  ) {
    return;
  }
  throw new SyncFromCanonError(
    "scheme-rejected",
    `sync-from-canon: refusing ${name} with a non-allowlisted git transport ` +
      `(only https://, ssh://, git://, or scp-like user@host:path accepted; ` +
      `a '-'-leading host, ext::/fd::/file:: remote-helper schemes, and bare ` +
      `schemes are BLOCKED): ${JSON.stringify(redactUserinfo(url))}`,
  );
}

// Parse `git ls-remote` output → the leading tip SHA. Empty output = ref absent
// on the remote (→ null, a legitimate result). A non-empty first line whose
// leading token is NEITHER a SHA-1 (40-hex) NOR a SHA-256 (64-hex) object id is
// malformed output — a typed throw, NOT a silent null (which would masquerade
// as "ref absent" and mask a real tip). Honors the module's typed-loud-throw
// discipline. Exported via _internal for direct test of the real parse path.
function parseLsRemoteTip(out) {
  const line = (out || "").split("\n").find((l) => l.trim() !== "");
  if (!line) return null; // no advertised ref → ref absent on the remote
  const sha = line.split(/\s+/)[0];
  if (/^[0-9a-f]{40}$/.test(sha) || /^[0-9a-f]{64}$/.test(sha)) return sha;
  throw new SyncFromCanonError(
    "ls-remote-failed",
    `sync-from-canon: unrecognized \`git ls-remote\` output (leading token is not a 40- or 64-hex SHA): ${JSON.stringify(line.slice(0, 80))}`,
  );
}

// Default `git ls-remote` reader. READ-ONLY: ls-remote queries the remote's
// advertised refs and writes NOTHING to the local object store or working tree
// (unlike `git fetch`, which is deliberately NOT used in SHARD 1). Returns the
// tip SHA at <ref> (SHA-1 or SHA-256), or null when the ref is absent.
function defaultLsRemote(url, ref) {
  assertGitSafeArg("url", url);
  assertGitSafeArg("ref", ref);
  assertAllowedScheme("url", url);
  let out;
  try {
    // `-c protocol.{ext,fd}.allow=never`: belt-and-suspenders at the git level —
    // disable the two command-executing remote helpers even if the scheme
    // allowlist above is ever bypassed (they leave https/ssh/git/file untouched).
    // `--`: end-of-options. GIT_TERMINAL_PROMPT=0: never block on a credential
    // prompt (also bounds the hang the timeout backstops).
    out = execFileSync(
      "git",
      [
        "-c", "protocol.ext.allow=never",
        "-c", "protocol.fd.allow=never",
        "ls-remote", "--", url, ref,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000, // bound an unreachable/slow canon remote (no indefinite hang)
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
  } catch (e) {
    // Do NOT embed Node's `e.message` — execFileSync wraps the full argv
    // (`git … ls-remote -- <url> <ref>`), so a credentialed url would leak to
    // stderr + the --json error field. Prefer git's OWN stderr (git redacts
    // passwords in transport errors), redact-pass it anyway, and echo only a
    // redacted url. Classify timeout distinctly.
    let detail;
    if (e && (e.killed || e.code === "ETIMEDOUT" || e.signal === "SIGTERM")) {
      detail = "timed out (30s)";
    } else if (e && e.stderr && String(e.stderr).trim()) {
      detail = redactUserinfo(String(e.stderr).trim().split("\n").slice(-1)[0]);
    } else if (e && typeof e.status === "number") {
      detail = `git exited ${e.status}`;
    } else {
      detail = "git invocation failed";
    }
    throw new SyncFromCanonError(
      "ls-remote-failed",
      `sync-from-canon: \`git ls-remote\` against canon (${redactUserinfo(url)}) failed for ref '${ref}': ${detail}`,
    );
  }
  return parseLsRemoteTip(out);
}

/**
 * Resolve canon's current artifact tip via the two-layer resolver + a
 * read-only `git ls-remote`. NO merge, NO object fetch — SHARD 1.
 *
 * @param {object} [opts]
 * @param {() => ({remote?:string,url?:string}|null)} [opts.getUpstreamCanonFn]
 *        ecosystem-remote layer (default: ecosystem-config.getUpstreamCanon).
 *        null return = this repo is canon (root).
 * @param {(key:string) => ({org,repo,provider,url:string|null}|null)} [opts.resolveRemoteFn]
 *        ecosystem remote_links.loom URL fallback (default: loom-links.resolveRemote).
 * @param {(url:string, ref:string) => (string|null)} [opts.lsRemoteFn]
 *        read-only ref reader (default: `git ls-remote`).
 * @param {string} [opts.ref]  ref to read (default "HEAD").
 * @returns {{status:"canon-root", canon:null, ref:null, tip:null, merged:false, note:string}
 *          | {status:"fetched", canon:{remote:string|null,url:string},
 *             ref:string, tip:string|null, fetched_at:string, merged:false, note:string}}
 * @throws {SyncFromCanonError} unresolved-canon-remote | option-injection | scheme-rejected | ls-remote-failed
 */
export function resolveCanonTip(opts = {}) {
  const readUpstreamCanon = opts.getUpstreamCanonFn || getUpstreamCanon;
  const readRemote = opts.resolveRemoteFn || resolveRemote;
  const lsRemote = opts.lsRemoteFn || defaultLsRemote;
  const ref = typeof opts.ref === "string" && opts.ref.trim() ? opts.ref : "HEAD";

  const upstreamCanon = readUpstreamCanon();

  // Boundary discriminator (the SHIPPED keystone). null = canon (root): there
  // is no upstream to pull. NOT an error — a no-op the caller surfaces.
  if (!upstreamCanon) {
    return {
      status: "canon-root",
      canon: null,
      ref: null,
      tip: null,
      merged: false,
      note:
        "This repo is canon (ecosystem.upstream_canon is null) — there is no " +
        "upstream to pull from. sync-from-canon runs only in a client ecosystem fork.",
    };
  }

  // Two-layer resolution: ecosystem-remote (WHICH) over operator-local (WHERE).
  // Prefer the pointer's explicit url; else fall back to the operator-local
  // resolver for the canon loom remote. A declared-but-unfetchable canon fails
  // LOUD (no silent positional guess — `rules/cross-repo.md` MUST-1).
  const remote =
    typeof upstreamCanon.remote === "string" ? upstreamCanon.remote : null;
  let url =
    typeof upstreamCanon.url === "string" && upstreamCanon.url.trim()
      ? upstreamCanon.url
      : null;
  if (!url) {
    const r = readRemote("loom");
    if (r && typeof r.url === "string" && r.url.trim()) url = r.url;
  }
  if (!url) {
    throw new SyncFromCanonError(
      "unresolved-canon-remote",
      "sync-from-canon: ecosystem.upstream_canon names a canon but no fetchable " +
        "URL resolved (neither upstream_canon.url nor resolveRemote('loom').url). " +
        "Declare the canon loom remote in ecosystem.json (remote_links.loom or " +
        "ecosystem.upstream_canon.url) before pulling.",
    );
  }

  const tip = lsRemote(url, ref); // READ-ONLY git ls-remote

  return {
    status: "fetched",
    canon: { remote, url },
    ref,
    tip,
    fetched_at: new Date().toISOString(),
    // SHARD 1 structural invariant: this verb NEVER merges. The gated per-change
    // pull-merge + Gate-1 disclosure scrub + fork->canon fence are #576 SHARD 2.
    merged: false,
    note:
      "Read-only ref-fetch (git ls-remote): NO objects fetched, NO merge applied. " +
      "The gated per-change human-decide pull-merge is #576 SHARD 2 (deferred).",
  };
}

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { json: false, ref: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--ref") {
      opts.ref = argv[++i];
      if (!opts.ref) {
        process.stderr.write("usage: --ref requires a value\n");
        process.exit(2);
      }
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "sync-from-canon-fetch — read-only resolve of canon's tip (loom#576 SHARD 1)\n" +
          "  --json           emit JSON\n" +
          "  --ref <ref>      ref to read (default HEAD)\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = resolveCanonTip({ ref: opts.ref });
  } catch (e) {
    if (e instanceof SyncFromCanonError) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ status: "error", subtype: e.subtype, error: e.message }) + "\n",
        );
      } else {
        process.stderr.write(`[sync-from-canon-fetch] ERROR (${e.subtype}): ${e.message}\n`);
      }
      process.exit(1);
    }
    throw e;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(redactResultForOutput(result)) + "\n");
    process.exit(0);
  }

  if (result.status === "canon-root") {
    process.stdout.write(`[sync-from-canon-fetch] canon-root: ${result.note}\n`);
    process.exit(0);
  }
  const safe = redactResultForOutput(result);
  const slug = safe.canon.remote || safe.canon.url;
  process.stdout.write(
    `[sync-from-canon-fetch] canon (${slug}) ${result.ref}: tip=${result.tip || "(ref absent)"} ` +
      `merged=${result.merged} (read-only; gated merge is #576 SHARD 2)\n`,
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export const _internal = { defaultLsRemote, parseLsRemoteTip, assertGitSafeArg, assertAllowedScheme, isStrictHost, isStrictUser, redactUserinfo, redactResultForOutput, parseArgs };
export { fileURLToPath };
