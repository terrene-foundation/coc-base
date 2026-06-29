#!/usr/bin/env node
/*
 * Regression tests for the sync-from-canon read-only ref-fetch (loom#576
 * SHARD 1). Tier 1 (deterministic, no network, no LLM). Run:
 *   node --test .claude/bin/sync-from-canon-fetch.test.mjs
 *
 * Coverage per `rules/probe-driven-verification.md` Rule 3: STRUCTURAL probes
 * only — return-shape equality, status discriminants, thrown-error subtypes,
 * call-spy assertions. No LLM judge; no regex over prose.
 *
 * Test classes:
 *   A. canon-root      — getUpstreamCanon null → status "canon-root", lsRemote
 *                        NEVER called, merged:false (the boundary keystone).
 *   B. fork + url      — pointer carries url → lsRemote called with that url.
 *   C. fork + remote   — pointer carries only remote → resolveRemote('loom')
 *                        fallback supplies the url (two-layer resolution).
 *   D. fail-loud       — fork declares canon but no url resolves →
 *                        SyncFromCanonError("unresolved-canon-remote").
 *   E. non-mutating    — the SHARD-1 invariant: result.merged is always false
 *                        AND no merge/fetch dep is ever invoked.
 *   F. ls-remote-fail  — a failing reader throws SyncFromCanonError("ls-remote-failed").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.resolve(HERE, "sync-from-canon-fetch.mjs");
const { resolveCanonTip, SyncFromCanonError, _internal } = await import(MOD);

// A spy ls-remote that records its calls and returns a fixed tip.
function spyLsRemote(tip = "a".repeat(40)) {
  const calls = [];
  const fn = (url, ref) => {
    calls.push({ url, ref });
    return tip;
  };
  fn.calls = calls;
  return fn;
}

// ── A. canon-root: the boundary keystone ──────────────────────────────────
test("A: canon (upstream_canon null) → canon-root, ls-remote NEVER called", () => {
  const ls = spyLsRemote();
  const r = resolveCanonTip({
    getUpstreamCanonFn: () => null,
    resolveRemoteFn: () => {
      throw new Error("resolveRemote MUST NOT be called at canon-root");
    },
    lsRemoteFn: ls,
  });
  assert.equal(r.status, "canon-root");
  assert.equal(r.canon, null);
  assert.equal(r.tip, null);
  assert.equal(r.merged, false);
  assert.equal(ls.calls.length, 0, "ls-remote must not run at canon-root");
});

// ── B. fork + explicit url ────────────────────────────────────────────────
test("B: fork pointer with url → ls-remote called with that url", () => {
  const ls = spyLsRemote("b".repeat(40));
  const r = resolveCanonTip({
    getUpstreamCanonFn: () => ({ remote: "upstream", url: "git@example.com:terrene-foundation/loom.git" }),
    resolveRemoteFn: () => {
      throw new Error("resolveRemote fallback MUST NOT run when url is present");
    },
    lsRemoteFn: ls,
    ref: "refs/heads/main",
  });
  assert.equal(r.status, "fetched");
  assert.equal(r.canon.url, "git@example.com:terrene-foundation/loom.git");
  assert.equal(r.canon.remote, "upstream");
  assert.equal(r.ref, "refs/heads/main");
  assert.equal(r.tip, "b".repeat(40));
  assert.equal(ls.calls.length, 1);
  assert.deepEqual(ls.calls[0], {
    url: "git@example.com:terrene-foundation/loom.git",
    ref: "refs/heads/main",
  });
});

// ── C. two-layer fallback: remote-only pointer → resolveRemote('loom') ────
test("C: fork pointer with only `remote` → resolveRemote('loom') supplies url", () => {
  const ls = spyLsRemote("c".repeat(40));
  let resolveKey = null;
  const r = resolveCanonTip({
    getUpstreamCanonFn: () => ({ remote: "upstream" }), // no url
    resolveRemoteFn: (key) => {
      resolveKey = key;
      return { org: "terrene-foundation", repo: "loom", provider: "github", url: "git@example.com:terrene-foundation/loom.git" };
    },
    lsRemoteFn: ls,
  });
  assert.equal(resolveKey, "loom", "fallback resolves the canon loom remote");
  assert.equal(r.status, "fetched");
  assert.equal(r.canon.url, "git@example.com:terrene-foundation/loom.git");
  assert.equal(r.ref, "HEAD"); // default
  assert.equal(ls.calls[0].url, "git@example.com:terrene-foundation/loom.git");
});

// ── D. fail-loud: declared canon, no resolvable url ───────────────────────
test("D: fork declares canon but no url resolves → unresolved-canon-remote", () => {
  assert.throws(
    () =>
      resolveCanonTip({
        getUpstreamCanonFn: () => ({ remote: "upstream" }), // no url
        resolveRemoteFn: () => null, // fallback fails
        lsRemoteFn: spyLsRemote(),
      }),
    (e) => e instanceof SyncFromCanonError && e.subtype === "unresolved-canon-remote",
  );
});

// ── E. non-mutating invariant (SHARD 1) ───────────────────────────────────
test("E: result.merged is always false; no merge/fetch dep is invoked", () => {
  const ls = spyLsRemote();
  const r = resolveCanonTip({
    getUpstreamCanonFn: () => ({ remote: "upstream", url: "git@example.com:terrene-foundation/loom.git" }),
    lsRemoteFn: ls,
  });
  assert.equal(r.merged, false);
  // The tool exposes NO merge/fetch surface — only the read-only reader runs.
  assert.equal(typeof resolveCanonTip, "function");
  assert.ok(!("apply" in r) && !("applied" in r), "no apply/merge result field");
});

// ── F. ls-remote failure surfaces as a typed throw ────────────────────────
test("F: a failing ls-remote reader → ls-remote-failed typed error", () => {
  assert.throws(
    () =>
      resolveCanonTip({
        getUpstreamCanonFn: () => ({ remote: "upstream", url: "git@example.com:terrene-foundation/loom.git" }),
        lsRemoteFn: () => {
          throw new SyncFromCanonError("ls-remote-failed", "boom");
        },
      }),
    (e) => e instanceof SyncFromCanonError && e.subtype === "ls-remote-failed",
  );
});

// ── G. ref absent on remote → tip null, still status fetched ──────────────
test("G: ref absent on remote → tip null, status fetched (not an error)", () => {
  const r = resolveCanonTip({
    getUpstreamCanonFn: () => ({ remote: "upstream", url: "git@example.com:terrene-foundation/loom.git" }),
    lsRemoteFn: () => null, // ref absent
  });
  assert.equal(r.status, "fetched");
  assert.equal(r.tip, null);
  assert.equal(r.merged, false);
});

// ── H. git option-injection guard (security review HIGH) ───────────────────
// defaultLsRemote MUST refuse a url/ref beginning with '-' BEFORE exec (it would
// be parsed as a git option, e.g. --upload-pack=<cmd>, a ref-read RCE class).
test("H: defaultLsRemote refuses option-injecting url ('--upload-pack=...')", () => {
  assert.throws(
    () => _internal.defaultLsRemote("--upload-pack=touch /tmp/pwned", "HEAD"),
    (e) => e instanceof SyncFromCanonError && e.subtype === "option-injection",
  );
});
test("H2: defaultLsRemote refuses option-injecting ref ('--upload-pack=...')", () => {
  assert.throws(
    () => _internal.defaultLsRemote("git@example.com:terrene-foundation/loom.git", "--upload-pack=evil"),
    (e) => e instanceof SyncFromCanonError && e.subtype === "option-injection",
  );
});
test("H3: assertGitSafeArg allows normal url + ref", () => {
  // Does not throw for safe values (guard returns undefined; exec is what would run).
  assert.doesNotThrow(() => _internal.assertGitSafeArg("url", "git@example.com:terrene-foundation/loom.git"));
  assert.doesNotThrow(() => _internal.assertGitSafeArg("ref", "refs/heads/main"));
});

// ── H4. git scheme-injection guard (security review SEC-2) ─────────────────
// A remote-helper scheme `ext::sh -c <cmd>` does NOT start with '-' (passes the
// option-injection guard) but makes `git ls-remote` EXECUTE the command. The
// scheme allowlist MUST reject it BEFORE exec.
test("H4: defaultLsRemote refuses an ext:: remote-helper url (scheme-rejected)", () => {
  assert.throws(
    () => _internal.defaultLsRemote("ext::sh -c 'touch /tmp/pwned'", "HEAD"),
    (e) => e instanceof SyncFromCanonError && e.subtype === "scheme-rejected",
  );
});
test("H5: assertAllowedScheme rejects ext::/fd::/file:: helper + bare/http schemes", () => {
  for (const bad of [
    "ext::sh -c 'id'",
    "fd::17/foo",
    "file::/etc/passwd",
    "file:///etc/passwd",
    "http://evil.example.com/x.git", // http not on the allowlist (only https)
    "wat://nope",
  ]) {
    assert.throws(
      () => _internal.assertAllowedScheme("url", bad),
      (e) => e instanceof SyncFromCanonError && e.subtype === "scheme-rejected",
      `expected ${bad} to be scheme-rejected`,
    );
  }
});
test("H6: assertAllowedScheme accepts https/ssh/git + scp-like canon urls", () => {
  for (const ok of [
    "https://github.com/terrene-foundation/loom.git",
    "ssh://git@github.com/terrene-foundation/loom.git",
    "git://github.com/terrene-foundation/loom.git",
    "git@github.com:esperie-enterprise/loom.git", // scp-like SSH shorthand
  ]) {
    assert.doesNotThrow(
      () => _internal.assertAllowedScheme("url", ok),
      `expected ${ok} to be accepted`,
    );
  }
});

// ── H7. '-'-leading host bypass (redteam R2 HIGH — ssh-option-injection) ───
// A '-'-leading host (or userinfo) passes the option-injection guard (the whole
// url does NOT start with '-') but git hands it to the ssh sub-process, which
// parses it as an OPTION (-oProxyCommand=<cmd>) → RCE. The explicit-scheme branch
// parses with `new URL` and rejects a '-'-leading hostname OR username (no
// backtracking-regex bypass — R3 fix); the scp-like branch anchors host-alnum.
test("H7: assertAllowedScheme rejects '-'-leading hosts AND userinfo (explicit-scheme + scp)", () => {
  for (const bad of [
    "ssh://-oProxyCommand=touch /tmp/pwned",
    "ssh://-oProxyCommand=x@realhost/r.git", // '-'-leading USERINFO, alnum host (R3)
    "ssh://user@-evilhost", // userinfo present, '-'-leading HOST (R3 backtrack fix)
    "ssh://user@-evilhost/r", // same, with a path
    "ssh://user@-oProxyCommand=x", // userinfo present, '-'-leading host
    "ssh://a@b@-evil/r", // double-@; new URL resolves host to '-evil' (R3)
    "https://-x",
    "git://-evil/r.git",
    "git@-evil:path", // scp-like, '-'-leading host
    "-evil:path", // scp-like, no userinfo, '-'-leading host
    // R4: %2d/%0a-encoded host (new URL does NOT decode non-special-scheme hosts;
    // git decodes before ssh → byte-identical to the raw '-evil' form above)
    "ssh://user@%2devil/r.git", // %2d → '-evil' host
    "ssh://%2d%2devil", // %2d%2d → '--evil' host
    "git://user@%2devil", // git:// non-special, same decode gap
    "ssh://user@evil%0a-host", // %0a → newline injection in host
  ]) {
    assert.throws(
      () => _internal.assertAllowedScheme("url", bad),
      (e) => e instanceof SyncFromCanonError && e.subtype === "scheme-rejected",
      `expected ${bad} to be scheme-rejected`,
    );
  }
});
test("H8: assertAllowedScheme still accepts userinfo'd canon urls (no false-reject)", () => {
  for (const ok of [
    "ssh://git@github.com/terrene-foundation/loom.git", // userinfo + alnum host
    "https://user@example.com/r.git",
    "https://user:pass@host/r", // credentialed (redacted only in logs, valid scheme)
    "ssh://git@gh.com:22/r", // explicit port
    "ssh://xn--n3h.com/r", // punycode IDN host
    "git@github.com:esperie-enterprise/loom.git", // scp-like, userinfo + alnum host
  ]) {
    assert.doesNotThrow(
      () => _internal.assertAllowedScheme("url", ok),
      `expected ${ok} to be accepted`,
    );
  }
});
test("H9: isStrictHost decode+shape — rejects %2d/%0a/bracket, accepts punycode/IPv4 (redteam R4)", () => {
  // rejects
  for (const bad of ["%2devil", "-evil", "evil%0a-x", "[::1]", "ev%il", "a b", ""]) {
    assert.equal(_internal.isStrictHost(bad), false, `host ${JSON.stringify(bad)} must be rejected`);
  }
  // accepts (decoded, strict shape)
  for (const ok of ["github.com", "gh.com", "xn--n3h.com", "127.0.0.1", "h"]) {
    assert.equal(_internal.isStrictHost(ok), true, `host ${JSON.stringify(ok)} must be accepted`);
  }
  // isStrictUser: '-'-leading / %0a rejected; empty + real logins accepted
  assert.equal(_internal.isStrictUser(""), true);
  assert.equal(_internal.isStrictUser("git"), true);
  assert.equal(_internal.isStrictUser("x-access-token"), true);
  assert.equal(_internal.isStrictUser("%2doProxyCommand"), false); // decodes to '-oProxyCommand'
  assert.equal(_internal.isStrictUser("u%0ax"), false);
});

// ── J. credential redaction in error messages (redteam R2 MEDIUM) ──────────
// A url carrying userinfo (user:TOKEN@) must NEVER appear verbatim in any error
// message / --json error field (security.md § "No secrets in logs").
test("J: redactUserinfo strips userinfo from scheme + scp urls", () => {
  assert.equal(
    _internal.redactUserinfo("https://u:secret@h/r.git"),
    "https://<redacted>@h/r.git",
  );
  assert.equal(
    _internal.redactUserinfo("git@github.com:org/repo.git"),
    "<redacted>@github.com:org/repo.git",
  );
  // no userinfo → unchanged
  assert.equal(
    _internal.redactUserinfo("https://github.com/org/repo.git"),
    "https://github.com/org/repo.git",
  );
  // embedded url inside a longer diagnostic string is still redacted
  assert.ok(
    !_internal
      .redactUserinfo("fatal: unable to access https://u:secret@h/r.git: 403")
      .includes("secret"),
  );
});
test("J2: scheme-rejected error for a credentialed url does NOT leak the token", () => {
  let msg = "";
  try {
    // http:// is not on the allowlist → scheme-rejected, and it carries a token.
    _internal.assertAllowedScheme("url", "http://u:SECRETTOKEN@h/r.git");
  } catch (e) {
    msg = e.message;
  }
  assert.ok(msg.length > 0, "expected a scheme-rejected throw");
  assert.ok(!msg.includes("SECRETTOKEN"), `error message leaked the token: ${msg}`);
});
test("J3: SUCCESS-path output (--json + human slug) does NOT leak a credentialed canon.url (redteam R3 MED)", () => {
  // The 4th echo site: a fetched result whose canon.url carries a PAT-embedded
  // pointer. redactResultForOutput strips the token before any print.
  const fetched = {
    status: "fetched",
    canon: { remote: "upstream", url: "https://x-access-token:SECRETTOKEN123@github.com/terrene-foundation/loom.git" },
    ref: "HEAD",
    tip: "a".repeat(40),
    merged: false,
  };
  const safe = _internal.redactResultForOutput(fetched);
  // --json carrier: the serialized output must not contain the token.
  assert.ok(!JSON.stringify(safe).includes("SECRETTOKEN123"), "--json output leaked the token");
  // human slug carrier: remote-or-url, redacted.
  const slug = safe.canon.remote || safe.canon.url;
  assert.ok(!String(slug).includes("SECRETTOKEN123"), "human slug leaked the token");
  // the in-memory ORIGINAL is unchanged (programmatic SHARD-2 caller still has the real url).
  assert.ok(fetched.canon.url.includes("SECRETTOKEN123"), "redaction must not mutate the original result");
});

// ── I. real ls-remote output parser (closes the untested-parse-path gap) ───
test("I: parseLsRemoteTip parses a SHA-1 tip from multi-line ls-remote output", () => {
  const out = "a".repeat(40) + "\tHEAD\n" + "b".repeat(40) + "\trefs/heads/main\n";
  assert.equal(_internal.parseLsRemoteTip(out), "a".repeat(40));
});
test("I2: parseLsRemoteTip accepts a SHA-256 (64-hex) tip", () => {
  const out = "c".repeat(64) + "\tHEAD\n";
  assert.equal(_internal.parseLsRemoteTip(out), "c".repeat(64));
});
test("I3: parseLsRemoteTip → null on empty/whitespace output (ref absent)", () => {
  assert.equal(_internal.parseLsRemoteTip(""), null);
  assert.equal(_internal.parseLsRemoteTip("\n  \n"), null);
});
test("I4: parseLsRemoteTip throws on malformed (non-SHA leading token), not silent null", () => {
  assert.throws(
    () => _internal.parseLsRemoteTip("not-a-sha\trefs/heads/main\n"),
    (e) => e instanceof SyncFromCanonError && e.subtype === "ls-remote-failed",
  );
});
