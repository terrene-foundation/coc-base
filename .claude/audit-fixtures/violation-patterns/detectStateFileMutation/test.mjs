#!/usr/bin/env node
/*
 * Audit-fixture runner for detectStateFileMutation + detectStateFileMutationSegmentAware
 * (rules/state-file-write-guard.md Rule 5 § "Bash-Layer Mutation Coverage").
 *
 * Per cc-artifacts.md Rule 9: every detector ships with committed fixtures
 * covering each scope-restriction predicate, plus an executable test that locks
 * behavior. This runner iterates every `<name>.txt` / `<name>.expected` pair in
 * BOTH fixture dirs, runs the matching detector with the protected-path regex
 * the caller supplies (coordination-log for `*coord*` fixtures, posture.json
 * otherwise — the two shapes `validate-bash-command.js` passes), and asserts the
 * committed `.expected` (a `null` or a `{layer,kind}` structural object).
 *
 * Covers the #1292 read-vs-write gate:
 *   • WRITE-vector flags — writeFile/appendFile/WriteStream, comma-quoted write
 *     MODE (open/openSync/File.new/sysopen/fdopen), O_WRONLY|O_TRUNC barewords,
 *     inplace=True, syswrite/truncate/unlink/rename, perl +<, stdin-heredoc.
 *   • READ passes — readFileSync / `-m json.tool` / list.append() read / the
 *     `,'war'` non-mode + `renamed_files` verb-prefix FP guards.
 *   • Doc-body masking — a state-write EXAMPLE quoted inside gh --body / echo /
 *     printf passes; a REAL interpreter exec + a real redirect on the wrapper
 *     segment + a $(…) cmd-sub write still fire.
 *   • ReDoS regression — a pathological near-match input completes <100ms
 *     (the positive write-allowlist is a flat, bounded, backreference-free
 *     alternation — provably linear).
 *
 * Run: node .claude/audit-fixtures/violation-patterns/detectStateFileMutation/test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOOKS_LIB = path.resolve(
  HERE,
  "..",
  "..",
  "..",
  "hooks",
  "lib",
  "violation-patterns.js",
);
const {
  detectStateFileMutation,
  detectStateFileMutationSegmentAware,
  splitShellSegments,
  hasInterpreterWriteSignal,
  detectRepoScopeDriftBash,
} = require(HOOKS_LIB);
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

const POSTURE_RX = /posture\.json/; // narrow shape, used by the ReDoS + null-input probes below
const COORD_RX = /coordination-log\.jsonl/;
const SETTINGS_RX = /settings\.json/; // #1309 — the deny CONTRACT as a guarded path
// The DEFAULT is the PRODUCTION protected-path regex, verbatim from
// `validate-bash-command.js` (the `STATE_PATH_RX` it passes to
// `detectStateFileMutationSegmentAware`) — NOT a narrow `/posture\.json/`.
//
// #1363: the narrow posture-only default made a fixture whose payload targets a
// DIFFERENT protected path STRUCTURALLY UNREACHABLE — the runner handed it a
// regex that could never match, so its pinned `{layer,kind}` expectation could
// never be met no matter what the detector did. `flag-perl-sysopen-numeric-flags`
// (payload: `perl -e 'sysopen(FH,".claude/operators.roster.json",577)'`) had been
// RED since #1337 landed it (commit b22db20f) for exactly this reason; the
// detector itself was correct all along (it returns `{layer:3,kind:'perl -c/-e/-m'}`
// under a regex that matches the roster path).
//
// Using the production regex also removes the whole recurrence class: a future
// fixture targeting violations.jsonl / observations.jsonl / presence-mechanism.json
// / `.initialized` / the roster schema is now routed correctly WITHOUT depending on
// a substring appearing in its FILENAME. The `coord` / `settings` name branches are
// kept because they mirror the two distinct call sites in `validate-bash-command.js`
// (the second passes a coordination-scoped regex).
// loom#1422 — this was a MANUAL COPY of the production literal, kept in parity
// by the F1390-1 test below. The copy is now GONE: production builds the regex
// from the single registry in `.claude/hooks/lib/guard-path-scope.js`, and this
// runner imports the very same object. Drift is no longer something a test has
// to catch, because there is no longer a second copy to drift.
const { STATE_PATH_RX } = require(
  path.resolve(HERE, "..", "..", "..", "hooks", "lib", "guard-path-scope.js"),
);
const rxFor = (name) =>
  name.includes("coord")
    ? COORD_RX
    : name.includes("settings")
      ? SETTINGS_RX
      : STATE_PATH_RX;

// F1390-1, SUPERSEDED BY loom#1422 — this used to compare a MANUAL COPY of the
// production regex against the literal in validate-bash-command.js, because a
// silent divergence would make the whole suite test a DIFFERENT pattern than
// the hook enforces (production adds a protected path, the copy does not, and
// every fixture targeting the new path becomes structurally unreachable and
// silently green — the `flag-perl-sysopen-numeric-flags` vacuity of #1363, one
// generation later).
//
// The copy is gone: both sides now IMPORT the built regex. So the property
// worth pinning is no longer "the two copies agree" but "there is no second
// copy" — strictly stronger, since parity can only ever detect drift AFTER a
// duplicate exists. Asserting object IDENTITY is what makes that total: a
// future edit that re-introduces a local literal here would still satisfy a
// value comparison on the day it was copied.
test("no-duplication: the runner uses the SAME regex object production builds", () => {
  const prod = require(
    path.resolve(HERE, "..", "..", "..", "hooks", "lib", "guard-path-scope.js"),
  );
  assert.equal(
    STATE_PATH_RX,
    prod.STATE_PATH_RX,
    "the fixture runner is no longer using the production STATE_PATH_RX object. " +
      "If a local literal was re-introduced, every fixture is being evaluated " +
      "against a pattern the hook does not enforce — import it from " +
      "hooks/lib/guard-path-scope.js instead of copying it.",
  );
  const prodSrc = fs.readFileSync(
    path.resolve(HERE, "..", "..", "..", "hooks", "validate-bash-command.js"),
    "utf8",
  );
  assert.ok(
    !/const\s+STATE_PATH_RX\s*=\s*\n?\s*\//.test(prodSrc),
    "validate-bash-command.js has re-declared STATE_PATH_RX as a local regex " +
      "literal. The Bash-lane matcher MUST be built from the registry in " +
      "hooks/lib/guard-path-scope.js (loom#1422) so a new fail-closed dimension " +
      "lands at every surface at once.",
  );
});

// R2-1 — fixtures that legitimately carry NO literal protected path. These test
// the ABSENCE of a match (a benign command-sub, an fd-dup to a non-state target,
// an unexpanded `$VAR` path, `rm` on a non-state file), so a reachability
// assertion cannot apply to them.
//
// DECLARED, not assumed. The earlier form exempted every `clean-*` fixture as a
// blanket rule, which guarded the LOUD direction and skipped the SILENT one: an
// unreachable `flag-*` fixture already fails visibly (that is how
// `flag-perl-sysopen-numeric-flags` was caught sitting RED since b22db20f),
// whereas an unreachable `clean-*` fixture passes green forever and hides its own
// vacuity. Enumerating inverts the default to fail-closed — a NEW `clean-*`
// fixture whose routed regex cannot match now FAILS until someone adds it here
// deliberately.
//
// The list cannot become a parking lot: every entry is itself asserted to carry
// no protected path under the PRODUCTION regex (below), so a fixture cannot be
// silenced here to paper over a routing bug.
const NO_PROTECTED_PATH_FIXTURES = new Set([
  "detectStateFileMutation/clean-node-tooling",
  "detectStateFileMutation/clean-rm-non-state",
  // loom#1534 — `.git/info/exclude` is carved OUT of the `.git` subtree row, so
  // under the production regex it genuinely carries no protected path, and that
  // ABSENCE is exactly what this fixture pins. Its flag-* siblings
  // (`flag-1534-dotgit-config-still-blocked`, `flag-1534-dotgit-hooks-still-blocked`)
  // are the anti-vacuity pair: they prove the subtree blanket still holds for the
  // leaves that can execute code or redirect `core.hooksPath`.
  "detectStateFileMutation/clean-1534-dotgit-info-exclude-append",
  "detectStateFileMutationSegmentAware/clean-benign-cmdsub",
  "detectStateFileMutationSegmentAware/clean-f3-1363-must3-shell-variable-path",
  "detectStateFileMutationSegmentAware/clean-fd-dup-nonstate",
  "detectStateFileMutationSegmentAware/clean-param-expansion",
  "detectStateFileMutationSegmentAware/clean-shell-variable-path",
  // #1399 — both genuinely carry NO protected path under the production regex, and
  // that ABSENCE is the property each one pins:
  //   stamper-worktree-arg: the sanctioned `/sync-to-use` Gate-2 writer passes the
  //     target as `--worktree <dir>`, so `.claude/VERSION` never reaches the command
  //     line at all (the same shape as the pinned-clean `reconcile-settings-deny.mjs
  //     --write` writer). `.claude/bin/…` does not match the regex.
  //   tmp-sandbox-bare-name: a `/tmp` fixture write to a BARE `VERSION` filename must
  //     not flag. NOTE the scope limit — per `state-file-write-guard.md` residual (k)
  //     STATE_PATH_RX is UNANCHORED, so a `/tmp/<x>/.claude/VERSION` write DOES flag;
  //     that pre-existing over-block is a separate shard and is deliberately NOT
  //     asserted clean here (asserting it would be false).
  "detectStateFileMutationSegmentAware/clean-1399-version-stamper-worktree-arg",
  "detectStateFileMutationSegmentAware/clean-1399-version-tmp-sandbox-bare-name",
]);

function runFixtureDir(dir, detector) {
  const abs = path.join(HERE, "..", dir);
  const names = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.slice(0, -4))
    .sort();
  for (const name of names) {
    test(`${dir}/${name}`, () => {
      const cmd = fs.readFileSync(path.join(abs, name + ".txt"), "utf8");
      const expected = JSON.parse(
        fs.readFileSync(path.join(abs, name + ".expected"), "utf8"),
      );
      const rx = rxFor(name);
      // S13 + R2-1 — REACHABILITY, for EVERY fixture unless explicitly declared
      // path-free. Routing is by filename substring, so a fixture whose NAME says
      // one thing and whose PAYLOAD targets another protected file gets a regex
      // that cannot match it. For a `flag-*` that is loud (permanently red); for a
      // `clean-*` it is SILENT — vacuously green forever, proving nothing. The
      // silent direction is the one that hides coverage, so the assertion runs on
      // both and the exemption is enumerated in NO_PROTECTED_PATH_FIXTURES.
      const declaredPathFree = NO_PROTECTED_PATH_FIXTURES.has(`${dir}/${name}`);
      if (declaredPathFree) {
        // The exemption is SELF-VERIFYING: a declared-path-free fixture must
        // genuinely carry no protected path under the PRODUCTION regex. Without
        // this, the list would be a parking lot where a real routing bug could be
        // silenced by adding a name to it.
        assert.ok(
          !STATE_PATH_RX.test(cmd),
          `fixture ${dir}/${name} is declared in NO_PROTECTED_PATH_FIXTURES but its ` +
            `payload DOES contain a protected path under the production regex. The ` +
            `exemption is wrong — either it is mis-routed (fix the name) or it should ` +
            `never have been declared path-free.`,
        );
      } else {
        assert.ok(
          rx.test(cmd),
          `fixture ${dir}/${name} is STRUCTURALLY UNREACHABLE: its routed regex ${rx} ` +
            `does not match its own payload, so the fixture cannot exercise what it ` +
            `claims to (a flag-* expectation is unmeetable; a clean-* one passes ` +
            `VACUOUSLY). Rename the fixture so it routes correctly, fix the payload, or ` +
            `— only if it genuinely carries no protected path — declare it in ` +
            `NO_PROTECTED_PATH_FIXTURES.`,
        );
      }
      const got = detector(cmd, rx);
      assert.deepEqual(
        got,
        expected,
        `fixture ${dir}/${name}: expected ${JSON.stringify(
          expected,
        )}, got ${JSON.stringify(got)}`,
      );
    });
  }
}

runFixtureDir("detectStateFileMutation", detectStateFileMutation);
runFixtureDir(
  "detectStateFileMutationSegmentAware",
  detectStateFileMutationSegmentAware,
);

// R2-1 (closure) — the exemption list MUST NOT rot. A stale entry (fixture
// renamed or deleted) would silently pre-authorize a future fixture that happens
// to reclaim the name, re-opening the vacuity this list exists to bound.
test("every NO_PROTECTED_PATH_FIXTURES entry names a fixture that exists", () => {
  const missing = [...NO_PROTECTED_PATH_FIXTURES].filter(
    (rel) => !fs.existsSync(path.join(HERE, "..", rel + ".txt")),
  );
  assert.deepEqual(
    missing,
    [],
    `NO_PROTECTED_PATH_FIXTURES names fixture(s) that no longer exist: ${missing.join(", ")}. ` +
      `Remove the stale entry — a name left behind silently exempts any future fixture that reclaims it.`,
  );
});

// ── #1390 review R2-11 — DIRECTIONAL INVARIANT, as committed tests ──────────
//
// `state-file-write-guard.md` states which sites keep the FLAT
// EXECUTES_INSIDE_QUOTES_RX and which use the quote-aware predicate, by
// DIRECTION: flat is kept wherever a MATCH TIGHTENS detection, because there an
// over-match is fail-closed. That claim was first checked by a throwaway script,
// which made it a one-off — not re-runnable by a reviewer and not gated in CI —
// and two of its three rows could not fail (one was `0 >= 0`, and the third site
// was unreachable from the entry point it drove). A check that cannot fail is
// the exact shape this whole fixture suite exists to prevent, so the invariant
// lives here now, one test per site, each asserting a STRICT property.
//
// No aggregate "0 violations" number is emitted: each row states precisely what
// it proves, so the suite cannot imply coverage it does not have.
const DIRECTIONAL_RX = /\.claude\/(?:learning\/posture\.json|settings\.json)\b/;
const PROTECTED = ".claude/learning/posture.json";

test("directional site 1 (heredoc bodyInert): converting to quote-aware would be FAIL-OPEN", () => {
  // A quoted-delimiter heredoc body is inert data and is masked away.
  const inert = `gh issue create --title t --body "$(cat <<'EOF'\nrm ${PROTECTED}\nEOF\n)"`;
  assert.equal(
    detectStateFileMutationSegmentAware(inert, DIRECTIONAL_RX),
    null,
    "an inert quoted-delimiter heredoc body must be masked (no false positive)",
  );

  // THE DISCRIMINATOR. The backtick sits inside BALANCED SINGLE QUOTES in the
  // body, and the delimiter is UNQUOTED. Inside a heredoc body those quotes are
  // LITERAL BYTES — bash still runs the backtick — so the body is genuinely
  // executing. The flat regex says so; a quote-aware scan reads the apostrophes
  // as quoting and calls the backtick inert (verified directly: flat=true,
  // hasActiveExecutingConstruct=false on this exact body). Converting this site
  // would therefore MASK a real mutation. This assertion goes RED under that
  // conversion — that is what makes this test non-vacuous, and it is the concrete
  // form of "a heredoc body is categorically quote-free, so a quote-aware scan
  // here is wrong in KIND, not merely narrower".
  const discriminating = `gh issue create --title t --body "$(cat <<EOF\nnote: '\`rm ${PROTECTED}\`' is bad\nEOF\n)"`;
  assert.deepEqual(
    detectStateFileMutationSegmentAware(discriminating, DIRECTIONAL_RX),
    { layer: 2, kind: "rm" },
    "FAIL-OPEN GUARD: a backtick inside literal single quotes in an UNQUOTED-delimiter " +
      "heredoc body EXECUTES in bash. If this returns null, site 1 has been converted to " +
      "the quote-aware predicate and a real mutation is now masked.",
  );
});

// HONEST SCOPE for sites 2 and 3 — measured, not assumed. Converting either to
// the quote-aware predicate is BEHAVIOUR-NEUTRAL today, so neither test below can
// catch that conversion, and neither claims to:
//   • site 2 — the EXECUTES conjunct sits beside `!includes("$")` / ``!includes("`")``.
//     Every construct the flat regex matches contains a `$` or a backtick, so
//     `narrowable` is already false via those conjuncts (this is F1390-2). The
//     conjunct only becomes load-bearing if the regex gains a construct with
//     NEITHER character.
//   • site 3 — it tests the ALREADY QUOTE-MASKED segment, where single-quoted
//     content is `x` filler, so both predicates agree by construction. That is
//     the same fact that made this site immune to the #1363 class.
// So the fail-open guard for the directional MUST rests on site 1, which IS
// strict. These two pin current correct behaviour. Recorded rather than papered
// over: a suite that implied it guarded all three would be the vacuity this file
// exists to prevent.
test("directional site 2 (narrowable): a match retains WIDE scope and finds what the narrow scope misses", () => {
  // narrowable = true: nothing outside the interpreter's own segment can reach
  // its argv, so detection is scoped to that segment — which carries neither the
  // path nor a write token. Clean.
  const narrow = `node -e "console.log(1)"\ngrep -rn writeFileSync src/\ncat ${PROTECTED}`;
  // Adding a backtick makes narrowable FALSE, retaining the WIDE whole-command
  // scope, where the path (line 3) and the write token (line 2) are both in view.
  const wide = `${narrow}\necho \`date\``;
  assert.equal(
    detectStateFileMutationSegmentAware(narrow, DIRECTIONAL_RX),
    null,
    "segment-scoped: an interpreter READ plus a sibling-line path mention must not flag (#1337)",
  );
  assert.deepEqual(
    detectStateFileMutationSegmentAware(wide, DIRECTIONAL_RX),
    { layer: 3, kind: "node (interpreter)" },
    "PINS CURRENT BEHAVIOUR, does NOT guard the conversion: the flat match retains " +
      "the WIDE scope, which detects. Converting site 2 to the quote-aware predicate " +
      "is BEHAVIOUR-NEUTRAL (measured: 177/177 either way) because the conjunct is " +
      "redundant behind the adjacent $/backtick includes — so this assertion would " +
      "stay green under that conversion. The fail-open guard for the directional MUST " +
      "is `directional site 1`, which is strict.",
  );
});

test("directional site 3 (repo-scope splitter): immune to the #1363 class, and the fail-close still fires", () => {
  // IMMUNITY — this site tests the ALREADY QUOTE-MASKED segment, where a
  // single-quoted backtick is already `x` filler. So the #1363 false-positive
  // class cannot arise here, and a quoted `;` must not fracture the segment.
  const sqBacktick = `gh issue create --title "x;y" --body 'see \`cmd\` here' --repo other-org/other-repo`;
  const hit = detectRepoScopeDriftBash(sqBacktick, REPO_ROOT);
  assert.ok(hit, "the cross-repo target must still be detected");
  assert.equal(
    hit.target,
    "other-org/other-repo",
    "a single-quoted backtick must not fracture the segment or lose the --repo value",
  );
  // Discriminator: the same shape WITHOUT a cross-repo target is clean, so the
  // row above is not passing for an unrelated reason.
  assert.equal(
    detectRepoScopeDriftBash(
      `gh issue create --title "x;y" --body 'see \`cmd\` here'`,
      REPO_ROOT,
    ),
    null,
    "no --repo => no finding (proves the assertion above discriminates)",
  );
  // FAIL-CLOSE LOCK (not a strict with/without pair — the construct IS the
  // desync): `$'…'` desyncs maskQuotedSpans, so the flat match is what forces the
  // raw re-split that keeps the trailing cross-repo `gh` segment-leading.
  const desync = `echo $'\\'' ; gh issue create --repo other-org/other-repo`;
  const desyncHit = detectRepoScopeDriftBash(desync, REPO_ROOT);
  assert.ok(
    desyncHit && desyncHit.target === "other-org/other-repo",
    "an ANSI-C desync before a cross-repo gh must still be caught by the fail-closed raw re-split",
  );
});

// Recorded, NOT a gap today (#1390 review R2-2, second half): production also
// duplicates `LAYER3_BLOCK_RX`, which is NOT pinned here. That is not vacuity —
// this runner asserts the detector's `{layer, kind}` return and does not model
// SEVERITY at all, so it has no copy of that constant to drift from. Severity
// routing is asserted separately by
// `.claude/test-harness/tests/validate-bash-command-state-severity.test.mjs`.
// Noted so a future reader does not assume both production constants are covered
// by the parity test above — adding a pin for a constant this file never uses
// would itself be the vacuous-gate shape.

// ── ReDoS regression (#1292): the positive write-allowlist STATE_INTERP_WRITE_RX
// gates both Layer-3 branches; it MUST be linear-time. A pathological adversarial
// input (a long run of the near-match token) MUST complete well under 100ms — a
// catastrophic-backtracking guard hook that hangs is worse than the original
// over-block. ──

test("ReDoS: 50k-char interpreter flag-run completes <100ms (write-allowlist is linear)", () => {
  const cmd = "perl -" + "e".repeat(50000) + ' ".claude/learning/posture.json"';
  const t = Date.now();
  const got = detectStateFileMutation(cmd, POSTURE_RX);
  const ms = Date.now() - t;
  assert.equal(got, null, "a read-only flag-run carries no write token → PASS");
  assert.ok(ms < 100, `write-allowlist gate MUST be linear (was ${ms}ms)`);
});

test("ReDoS: long comma-quoted near-mode run completes <100ms", () => {
  // A dense run of `,'wa` partial-mode near-matches: each fails the tight mode
  // grammar after O(1) bounded work (no nested/overlapping quantifier).
  const cmd =
    "node -e '" + ",'wa".repeat(20000) + "' .claude/learning/posture.json";
  const t = Date.now();
  detectStateFileMutation(cmd, POSTURE_RX);
  const ms = Date.now() - t;
  assert.ok(ms < 100, `mode-grammar scan MUST be linear (was ${ms}ms)`);
});

test("empty / null input returns null without throwing", () => {
  assert.equal(detectStateFileMutation("", POSTURE_RX), null);
  assert.equal(detectStateFileMutation(null, POSTURE_RX), null);
  assert.equal(detectStateFileMutation("read something", null), null);
  assert.equal(detectStateFileMutationSegmentAware("", POSTURE_RX), null);
});

// ── #1337 — branches not reachable through a `<name>.txt` fixture ──
// The fixture files exercise the DETECTOR; these pin the two primitives the
// #1337 scope fix introduced, so a future edit to either cannot silently change
// the segment scoping or the shared read-vs-write predicate.

test("splitShellSegments: options default OFF (pre-#1337 callers byte-identical)", () => {
  // No opts → bare strings, newline is NOT a separator.
  assert.deepEqual(splitShellSegments("a && b ; c"), ["a ", " b ", " c"]);
  assert.deepEqual(splitShellSegments("a\nb"), ["a\nb"]);
});

test("splitShellSegments: newlineSeparates splits only UNQUOTED newlines", () => {
  const o = { newlineSeparates: true };
  assert.deepEqual(splitShellSegments("a\nb", o), ["a", "b"]);
  // A newline INSIDE quotes is body text, not a separator — otherwise a
  // multi-line `node -e "…"` body would fracture and its write would escape.
  assert.deepEqual(splitShellSegments("node -e 'a\nb'", o), ["node -e 'a\nb'"]);
  // A backslash line-continuation is consumed by the escape branch, so the
  // continued command stays ONE segment (as bash reads it).
  assert.deepEqual(splitShellSegments("node \\\n -e x", o), ["node \\\n -e x"]);
});

test("splitShellSegments: withOffsets positions index into the ORIGINAL command", () => {
  const cmd = "alpha\nbravo";
  const segs = splitShellSegments(cmd, {
    newlineSeparates: true,
    withOffsets: true,
  });
  assert.deepEqual(segs, [
    { text: "alpha", start: 0 },
    { text: "bravo", start: 6 },
  ]);
  for (const s of segs) {
    assert.equal(cmd.slice(s.start, s.start + s.text.length), s.text);
  }
});

test("hasInterpreterWriteSignal: shared predicate — write vectors vs reads", () => {
  // WRITE vectors (one per source group) → true.
  for (const w of [
    "open(p,'w')", // (1) comma-quoted mode
    "open(p, mode='a')", // (1) python keyword mode
    'open(my $fh, ">", $p)', // (1) perl shell-mode
    "fs.writeFileSync(p,x)", // (2) node fs API
    "fs.writeSync(fd,x)", // (2) fd write
    "fs.rmSync(p)", // (3) destructive
    "fs.copyFileSync(a,p)", // (3) replacement
    "os.replace(a,p)", // (4) python
    "shutil.move(a,p)", // (4) python
    "pathlib.Path(p).write_text(x)", // (4) python
    "File.write(p,x)", // (5) ruby
    "FileUtils.mv(a,p)", // (5) ruby
    "os.system('rm p')", // (6) shell-out
    "fs['write'+'FileSync'](p,x)", // (7) obfuscation
    "perl -i -pe 's/a/b/' p", // in-place ARGV flag
  ]) {
    assert.equal(hasInterpreterWriteSignal(w), true, `expected WRITE: ${w}`);
  }
  // READ bodies + the historical false-positive guards → false.
  for (const r of [
    "fs.readFileSync(p,'utf8')", // plain read
    "open(p,'r')", // read mode
    "open(p,'rb')", // read mode, binary
    "json.load(open(p))", // read, no mode
    "File.open(p).read", // ruby read (why File.open is mode-gated)
    "fs['readFileSync'](p)", // bracket access, NO concat
    "const renamed_files=[]", // verb-PREFIXED identifier
    "cfg.set(p,'war')", // non-mode comma-quoted token
    "acc.append(d)", // append, not appendFile
    "perl -ne 'print' p", // perl read, no -i
    "node --write-summary p", // `--write` flag is not a write API
    "", // empty
  ]) {
    assert.equal(hasInterpreterWriteSignal(r), false, `expected READ: ${r}`);
  }
});
