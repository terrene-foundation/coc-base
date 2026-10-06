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
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
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
  detectHeredocWriteRunBundle,
  splitShellSegments,
  hasInterpreterWriteSignal,
  detectRepoScopeDriftBash,
  // loom#1681 — the runner's OWN reachability gates are protected-path spelling
  // tests, the same question production asks. Left on a bare `pathRx.test` they
  // declared every traversal fixture "STRUCTURALLY UNREACHABLE" (the raw spelling
  // does not match — that IS the defect) and would have parked a real protected
  // path in NO_PROTECTED_PATH_FIXTURES as though it were path-free. Both route
  // through the shared predicate, so the harness cannot drift from the fence it
  // audits (`security.md` § Enforcement-Surface Parity).
  pathSpellingHit,
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

// loom#1703 — the PATH-IDENTITY oracle. A `1703-` fixture is ABOUT whether the
// resolved target lands in protected state, so it is the one class that must be
// evaluated WITH the oracle wired the way validate-bash-command.js wires it.
// Every OTHER fixture keeps calling the detector with no third argument, which
// is the documented no-scope default (every spelling match ranks "in-tree") and
// is byte-identical to pre-#1703 behaviour — so this opt-in cannot silently
// re-verdict the 170+ inherited fixtures.
//
// The sandbox path baked into the `1703-` payloads is `/tmp/loom-1703-sandbox`,
// chosen so the fixtures are MACHINE-INDEPENDENT: it is not under REPO_ROOT, it
// is not the user's home, and it has no `.git` above it on any host, so it
// resolves out-of-tree deterministically. The oracle is given REPO_ROOT as its
// boundary, so a relative `.claude/learning/…` payload resolves in-tree here for
// the same reason it does in a real session.
const { createStateTargetScope } = require(
  path.resolve(HERE, "..", "..", "..", "hooks", "lib", "state-target-scope.js"),
);
// loom#1681 — the traversal fixtures are ABOUT the same question (does the
// RESOLVED target land in protected state), reached through a `..` spelling the
// lexical matcher could not see. They are routed to the oracle for the same
// reason the `1703-` set is: their `in-tree` / out-of-tree poles are meaningless
// without it, and the no-scope default would score every spelling match in-tree
// and silently vacuate the clean pole.
const optsFor = (name, cmd) =>
  name.includes("1703-") || name.includes("1681-")
    ? {
        scope: createStateTargetScope({
          cwd: REPO_ROOT,
          boundaryRoots: [REPO_ROOT],
          command: cmd,
        }),
      }
    : undefined;

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
  // loom#s65 — the `.git` row's terminator was a WORD boundary (`\b`), so any
  // `.git` followed by a NON-word character matched: `.git-blame-ignore-revs` (a
  // standard git file), `.git-commit-msg.txt`, `.git.bak`. All three are ORDINARY
  // FILES, not the `.git` admin directory, so under the fixed regex they genuinely
  // carry no protected path — and that ABSENCE is what each one pins. Their
  // anti-vacuity pair is `flag-s65-dotgit-{dquote,squote}-still-blocked`, which
  // prove the SAME change did not open a fail-OPEN on the quoted spellings. The
  // terminator is a NEGATIVE assertion — it names what makes the token a DIFFERENT
  // file — so a quote is not in the excluded class and `rm -rf ".git"` still flags.
  // (An earlier revision of this comment described a POSITIVE boundary class that
  // "INCLUDES `'` and `\"`". No such class exists: the positive-allowlist design was
  // refuted for 13 fail-open holes and replaced. The sentence is struck rather than
  // edited in place because a reader reasoning from it would re-derive the refuted
  // design.) Without that pair, these three would be indistinguishable from a regex
  // that simply stopped matching the token at all.
  //
  // `flag-s65-r2high1-dotgit-trailing-dot-{sep,eol}` pin the SECOND refutation: a
  // FLAT `(?![\w\-.])` also excluded a bare trailing dot, fail-OPENing on a spelling
  // Win32 canonicalizes back onto the protected directory. They are the pole that
  // discriminates the conditional dot arm from the flat one.
  "detectStateFileMutation/clean-s65-dotgit-blame-ignore-revs",
  "detectStateFileMutation/clean-s65-dotgit-hyphen-scratch",
  "detectStateFileMutation/clean-s65-dotgit-dot-suffix",
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
  // loom#1426 — surfaced by wiring the orphaned bundle dir below. This one pins
  // the VAR-INDIRECT residual (`T=/tmp/s.cjs; node "$T"`), where the protected
  // path never reaches the command string at all, so the ABSENCE of a match is
  // the property. The other 26 bundle fixtures are reachable.
  "detectHeredocWriteRunBundle/clean-variable-indirect-run-only",
  // loom#1681 — the no-false-positive pole for the traversal collapse: an
  // ORDINARY `..` in a non-state path (`src/lib/../lib/app.js`). It carries no
  // protected path in EITHER spelling, and pinning that ABSENCE is the property —
  // it is what proves the collapse does not MANUFACTURE a match out of routine
  // traversal. The self-verifying assertion above now uses `pathSpellingHit`, so
  // a traversal-spelled protected path could not be parked here.
  "detectStateFileMutationSegmentAware/clean-1681-traversal-non-state-path",
  // loom#1681 — the STRONG form of that pole, and the one over-match hazard the
  // `guard-path-scope.js` SEP table singles out by name. `.claude/../learning/
  // posture.json` SPELLS both `.claude` and `learning/posture.json`, so unlike
  // the `src/lib/../lib/app.js` row above it is not obviously unrelated — yet it
  // resolves to `learning/posture.json`, an ordinary unprotected file, and must
  // stay silent in BOTH views. It is exactly what a careless widening of the
  // separator token would start blocking (measured: `false` today, `true` under
  // `\/+(?:\.{1,2}\/+)*`), so this row is the regression fence on that hazard.
  "detectStateFileMutationSegmentAware/clean-1681-overmatch-hazard-dotclaude-parent",
  // loom round-3 S1 — the no-false-positive pole for the nested-body Layer-1 pass.
  // `sh -c 'printf x > /tmp/notstate'` is a REAL redirect inside a REAL nested
  // command string, so the new pass reads it exactly as it reads the flagging
  // siblings; only the TARGET differs. Its ABSENCE of a protected path is the
  // property — it is what proves the pass did not become a blanket "a redirect
  // inside `sh -c` is a state write".
  "detectStateFileMutation/clean-s1-nested-sh-c-redirect-nonstate",
  // loom round-3 S4 — THREE entries, and two of them are `flag-*`, which is
  // deliberate and is the whole point of the shard. `find <root> -name <file>`
  // NEVER spells the protected path contiguously: the root and the basename sit in
  // different operands, so `pathSpellingHit` is FALSE on the payload while the
  // command still deletes the file. The detector reconstructs the target
  // (`findSynthesizedPaths`, the direct-child join) rather than reading it off the
  // line, so these fixtures are reachable THROUGH THE SYNTHESIS and not through the
  // line — which is exactly what the reachability assertion above cannot see, and
  // exactly why they must be declared here rather than renamed or re-spelled.
  //
  // The two poles that keep it honest: `clean-s4-find-name-delete-nonstate-root`
  // joins to `/tmp/scratch/posture.json` (unprotected → the join must NOT
  // manufacture a match), and `clean-s4-find-name-print-posture` has a protected
  // JOIN but a read-only ACTION (`-print` → no mutating hit → nothing to test).
  "detectStateFileMutation/flag-s4-find-name-delete-posture",
  "detectStateFileMutation/flag-s4-find-name-exec-rm-posture",
  "detectStateFileMutation/clean-s4-find-name-print-posture",
  "detectStateFileMutation/clean-s4-find-name-delete-nonstate-root",
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
          !pathSpellingHit(cmd, STATE_PATH_RX),
          `fixture ${dir}/${name} is declared in NO_PROTECTED_PATH_FIXTURES but its ` +
            `payload DOES contain a protected path under the production regex. The ` +
            `exemption is wrong — either it is mis-routed (fix the name) or it should ` +
            `never have been declared path-free.`,
        );
      } else {
        assert.ok(
          pathSpellingHit(cmd, rx),
          `fixture ${dir}/${name} is STRUCTURALLY UNREACHABLE: its routed regex ${rx} ` +
            `does not match its own payload, so the fixture cannot exercise what it ` +
            `claims to (a flag-* expectation is unmeetable; a clean-* one passes ` +
            `VACUOUSLY). Rename the fixture so it routes correctly, fix the payload, or ` +
            `— only if it genuinely carries no protected path — declare it in ` +
            `NO_PROTECTED_PATH_FIXTURES.`,
        );
      }
      const got = detector(cmd, rx, optsFor(name, cmd));
      // loom#1703 — the verdict gained a THIRD field, `scope`, reporting HOW the
      // protected path was decided ("in-tree" = candidate and boundary root both
      // canonicalized and it landed inside; "unresolved" = a `$VAR`/glob/`$(…)`
      // the hook refuses to expand, failed closed). A whole-object deepEqual
      // would have forced a mechanical rewrite of all 100+ `.expected` files to
      // re-state a field none of them is about, so the layer/kind contract is
      // compared on its OWN and `scope` is asserted only where a fixture opts in
      // via `expected.scope`. NOT laxity: the two poles that exist to pin scope
      // (`clean-1703-*` sandbox / `flag-1703-*` in-tree + unresolved) declare it,
      // and `scope-declared-somewhere` below refuses to let the set go empty.
      const { scope: gotScope, ...gotCore } = got || {};
      const { scope: wantScope, ...wantCore } = expected || {};
      assert.deepEqual(
        got ? gotCore : got,
        expected ? wantCore : expected,
        `fixture ${dir}/${name}: expected ${JSON.stringify(
          expected,
        )}, got ${JSON.stringify(got)}`,
      );
      if (wantScope !== undefined) {
        assert.equal(
          gotScope,
          wantScope,
          `fixture ${dir}/${name}: expected scope=${wantScope}, got scope=${gotScope}`,
        );
      }
    });
  }
}

// loom#1703 — ANTI-VACUITY for the `scope` opt-in above. The verdict comparison
// ignores `scope` unless a fixture DECLARES it, which is the right default for
// the inherited set but would silently become total laxity if the declaring set
// ever emptied (a rebase dropping the 1703 fixtures, someone "simplifying" the
// .expected files). Then `scope` would be asserted NOWHERE and the path-identity
// contract would be untested while every test stayed green — the exact silent
// direction this file's own NO_PROTECTED_PATH_FIXTURES note warns about.
//
// Pinned at BOTH poles, because a set containing only in-tree rows would leave
// the out-of-tree narrowing (the whole point of #1703) unpinned.
test("1703 scope contract: both verdict poles are declared by at least one fixture", () => {
  const declared = { "in-tree": 0, unresolved: 0, clean: 0 };
  for (const dir of [
    "detectStateFileMutation",
    "detectStateFileMutationSegmentAware",
  ]) {
    const abs = path.join(HERE, "..", dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith(".expected") || !f.includes("1703-")) continue;
      const exp = JSON.parse(fs.readFileSync(path.join(abs, f), "utf8"));
      if (exp === null) declared.clean++;
      else if (exp.scope === "in-tree") declared["in-tree"]++;
      else if (exp.scope === "unresolved") declared.unresolved++;
    }
  }
  assert.ok(
    declared["in-tree"] > 0,
    "no fixture declares scope:'in-tree' — the RESOLVED-and-inside verdict is unpinned",
  );
  assert.ok(
    declared.unresolved > 0,
    "no fixture declares scope:'unresolved' — the FAIL-CLOSED verdict is unpinned",
  );
  assert.ok(
    declared.clean > 0,
    "no `clean-1703-*` fixture expects null — the out-of-tree narrowing that #1703 " +
      "exists to deliver is unpinned, so the guard could have reverted to blocking " +
      "every sandbox path with this suite still green",
  );
});

runFixtureDir("detectStateFileMutation", detectStateFileMutation);
runFixtureDir(
  "detectStateFileMutationSegmentAware",
  detectStateFileMutationSegmentAware,
);
// loom#1426 — the `detectHeredocWriteRunBundle` fixture dir was ORPHANED. It has
// been committed since #764 with 27 pairs, `state-file-write-guard.md` §
// Cross-references cites it as the Layer-4 evidence, and `cc-artifacts.md` Rule 9
// binds a detector to its fixtures — but NO runner iterated it, so not one of
// those 27 had ever executed. Measured before wiring: this file's own output
// named `detectStateFileMutationSegmentAware/` 85 times and
// `detectHeredocWriteRunBundle/` 0 times. It is added HERE rather than in a new
// file because the Layer-4 pass is reached through
// `detectStateFileMutationSegmentAware` in production, so the two belong to one
// runner — and a second runner would be a second thing to forget to register.
runFixtureDir("detectHeredocWriteRunBundle", detectHeredocWriteRunBundle);

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

// loom#1703 — these two rows assert on the {layer,kind} CONTRACT; the verdict
// gained an orthogonal `scope` field. Drop it here for the same reason
// runFixtureDir does, and for the same non-laxity reason: neither directional
// invariant is ABOUT path identity, and both were re-measured against
// origin/main at this change (site 1 discriminating: {layer:2,kind:"rm"} on
// both; site 2 wide: {layer:3,kind:"node (interpreter)"} on both; both null
// cases null on both), so the properties they pin are demonstrably intact.
const core = (v) => {
  if (!v) return v;
  const { scope: _scope, ...rest } = v;
  return rest;
};

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
    core(detectStateFileMutationSegmentAware(discriminating, DIRECTIONAL_RX)),
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
    core(detectStateFileMutationSegmentAware(wide, DIRECTIONAL_RX)),
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

// FASTEST of several calls, not one call. A single wall-clock sample includes
// whatever GC or JIT pause lands inside it, so the one-shot form went red with no
// code change: measured on this suite 2026-09-12, the comma-run input took up to
// 243.7 ms on HEAD over 15 calls whose median was 8.3 ms, and the suite failed one
// run in three at 124 ms. Catastrophic backtracking is slow on EVERY call, so the
// minimum still exceeds the bound exactly when the property this test exists for
// is broken; a pause cannot make every sample slow.
const fastestMs = (fn, runs = 5) => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
  }
  return best;
};

test("ReDoS: 50k-char interpreter flag-run completes <100ms (write-allowlist is linear)", () => {
  const cmd = "perl -" + "e".repeat(50000) + ' ".claude/learning/posture.json"';
  const got = detectStateFileMutation(cmd, POSTURE_RX);
  assert.equal(got, null, "a read-only flag-run carries no write token → PASS");
  const ms = fastestMs(() => detectStateFileMutation(cmd, POSTURE_RX));
  assert.ok(ms < 100, `write-allowlist gate MUST be linear (fastest was ${ms}ms)`);
});

test("ReDoS: long comma-quoted near-mode run completes <100ms", () => {
  // A dense run of `,'wa` partial-mode near-matches: each fails the tight mode
  // grammar after O(1) bounded work (no nested/overlapping quantifier).
  const cmd =
    "node -e '" + ",'wa".repeat(20000) + "' .claude/learning/posture.json";
  const ms = fastestMs(() => detectStateFileMutation(cmd, POSTURE_RX));
  assert.ok(ms < 100, `mode-grammar scan MUST be linear (fastest was ${ms}ms)`);
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

// ── Layer 1/2 VERB POSITION — the flag-cluster false positive (lane state-guard-verb) ──
//
// MEASURED DEFECT. Layer 2 tested `/\b(?:cp|…|ln|…)\b\s+/` against the quote-masked
// line, and `\b` holds between `-` and a letter, so a FLAG CLUSTER that spells a
// verb counted as the verb: `git grep -l x -- <settings>` ran while
// `git grep -ln x -- <settings>` was refused as "Layer 2: ln". The same shape
// refused `docker run --rm`, `ls -cp`, `grep -e rm`, and at Layer 1 `--tee` / `--jq … -i`.
//
// These cases pin BOTH directions with the production regex and the production
// scope oracle, asserting the refusal IDENTITY (layer + kind), never a bare
// non-null — a refusal for the wrong reason would pass a truthiness check.
// Each case runs through BOTH entry points: `detectStateFileMutationSegmentAware`
// is what `validate-bash-command.js` calls, and `detectStateFileMutation` is the
// layer implementation it delegates to.
const SETTINGS = ".claude/" + "settings.json";
const scopeOf = (cmd) =>
  createStateTargetScope({
    cwd: REPO_ROOT,
    boundaryRoots: [REPO_ROOT],
    command: cmd,
  });
const verdictBoth = (cmd) => ({
  seg: core(
    detectStateFileMutationSegmentAware(cmd, STATE_PATH_RX, {
      scope: scopeOf(cmd),
    }),
  ),
  raw: core(
    detectStateFileMutation(cmd, STATE_PATH_RX, { scope: scopeOf(cmd) }),
  ),
});

const L2 = (kind) => ({ layer: 2, kind });
const L1 = (kind) => ({ layer: 1, kind });

// Every one of these is a real mutation of the protected file. The first block is
// the brief's bypass battery; the second proves the fix did not trade the false
// positive for a miss on commands that run their OPERANDS (an unknown command's
// argument semantics cannot be known, so a verb word there must still count).
const VERB_POSITION_REFUSED = [
  [`ln -s x ${SETTINGS}`, L2("ln")],
  [`/bin/ln -sf x ${SETTINGS}`, L2("ln")],
  [`command ln x ${SETTINGS}`, L2("ln")],
  [`FOO=1 ln x ${SETTINGS}`, L2("ln")],
  [`sudo ln x ${SETTINGS}`, L2("ln")],
  [`true && rm ${SETTINGS}`, L2("rm")],
  [`(rm ${SETTINGS})`, L2("rm")],
  [`{ rm ${SETTINGS}; }`, L2("rm")],
  [`echo $(rm ${SETTINGS})`, L2("rm")],
  [`sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`eval "rm ${SETTINGS}"`, L2("rm")],
  [`xargs rm <<< ${SETTINGS}`, L2("rm")],
  [`find ${SETTINGS} -exec rm {} \\;`, L2("rm")],
  [`cp x ${SETTINGS}`, L2("cp")],
  [`cp x "${SETTINGS}"`, L2("cp")],
  [`ln -s x "${SETTINGS}"`, L2("ln")],
  [`rm "${SETTINGS}"`, L2("rm")],
  [`sh -c 'rm "${SETTINGS}"'`, L2("rm")],
  // Operand-executing commands this detector has no model of.
  [`flock /tmp/l rm ${SETTINGS}`, L2("rm")],
  [`chroot / rm ${SETTINGS}`, L2("rm")],
  [`watch rm ${SETTINGS}`, L2("rm")],
  [`exec rm ${SETTINGS}`, L2("rm")],
  [`busybox rm ${SETTINGS}`, L2("rm")],
  [`rg --pre=rm x ${SETTINGS}`, L2("rm")],
  [`git -c diff.external=rm diff ${SETTINGS}`, L2("rm")],
  // Command positions the segment splitter does not separate.
  [`sleep 1 & rm ${SETTINGS}`, L2("rm")],
  [`grep -e x file & rm ${SETTINGS}`, L2("rm")],
  [`grep -e x file&rm ${SETTINGS}`, L2("rm")],
  [`if true; then rm ${SETTINGS}; fi`, L2("rm")],
  [`for f in a; do rm ${SETTINGS}; done`, L2("rm")],
  [`case x in x) rm ${SETTINGS};; esac`, L2("rm")],
  [`f() { rm ${SETTINGS}; }`, L2("rm")],
  [`timeout 5 rm ${SETTINGS}`, L2("rm")],
  [`sudo -u root rm ${SETTINGS}`, L2("rm")],
  [`true || ln -s x ${SETTINGS}`, L2("ln")],
  // Executing constructs.
  [`cat <(rm ${SETTINGS})`, L2("rm")],
  ["echo `rm " + SETTINGS + "`", L2("rm")],
  [`echo "$(rm ${SETTINGS})"`, L2("rm")],
  // A comment-opened quote the shell ends at the newline: our quote model and
  // bash's disagree here, so the fail-closed lexical scan must still see line 2.
  [`echo x #'\nrm ${SETTINGS}`, L2("rm")],
  // Verb spellings the shell resolves to the same command word.
  [`\\rm ${SETTINGS}`, L2("rm")],
  [`"rm" ${SETTINGS}`, L2("rm")],
  [`bash -lc 'rm ${SETTINGS}'`, L2("rm")],
  // Layer 1: in-place edit flags spelled as a cluster, and tee's later operands.
  [`sed -i s/a/b/ ${SETTINGS}`, L1("in-place-edit")],
  [`sed --in-place s/a/b/ ${SETTINGS}`, L1("in-place-edit")],
  [`sed -Ei s/a/b/ ${SETTINGS}`, L1("in-place-edit")],
  [`sed -ni s/a/b/ ${SETTINGS}`, L1("in-place-edit")],
  [`echo x | tee ${SETTINGS}`, L1("tee")],
  [`echo x | tee /dev/null ${SETTINGS}`, L1("tee")],
  // `find` with the protected path written out: `-delete` removes it, the exec
  // actions run a command over it, and `-fprint`/`-fprintf`/`-fls` truncate their
  // FILE operand. Each was null from the detector, and the real hook exited 0,
  // before this lane's second change — except the bare `-exec rm` spellings, which
  // the word scan already caught.
  [`find ${SETTINGS} -delete`, L2("rm")],
  [`sudo find ${SETTINGS} -delete`, L2("rm")],
  [`find ${SETTINGS} -name x -delete`, L2("rm")],
  [`find ${SETTINGS} -execdir rm {} \\;`, L2("rm")],
  [`find ${SETTINGS} -ok rm {} \\;`, L2("rm")],
  [`find ${SETTINGS} -okdir rm {} +`, L2("rm")],
  [`find ${SETTINGS} -exec "rm" {} \\;`, L2("rm")],
  [`find ${SETTINGS} -exec sh -c 'rm "$1"' _ {} \\;`, L2("rm")],
  [`find . -fprint ${SETTINGS}`, L1("find-fprint")],
  [`find . -fprintf ${SETTINGS} '%p'`, L1("find-fprint")],
  [`find . -fls ${SETTINGS}`, L1("find-fprint")],
  // `env -S` / `--split-string` splits its string into a command, like `sh -c`.
  [`env -S 'rm ${SETTINGS}'`, L2("rm")],
  [`env -S'rm ${SETTINGS}'`, L2("rm")],
  [`env --split-string='rm ${SETTINGS}'`, L2("rm")],
  [`env --split-string 'rm ${SETTINGS}'`, L2("rm")],
  [`env -iS 'rm ${SETTINGS}'`, L2("rm")],
  [`sudo env -S 'rm -f' ${SETTINGS}`, L2("rm")],
  // An UNREADABLE split string takes the lexical fallback, exactly like
  // `sh -c "$CMD"`. The trailing `-ln` is there to make the route observable: the
  // parsed dispatch would call it a flag, the lexical scan still reads `ln`.
  [`env -S "$CMD" -ln ${SETTINGS}`, L2("ln")],
  [`sh -c "$CMD" -ln ${SETTINGS}`, L2("ln")],
  // Command-running wrappers (`git-command-parse.js::COMMAND_RUNNING_WRAPPERS`).
  // Each was null from both entry points before this lane's third change: the
  // word scan over an unknown command reads a MASKED view, so a quoted body or a
  // quoted `-fprint` operand behind the wrapper was invisible. `watch` runs its
  // joined operands through `sh -c`, and with `-x` runs them as an argv.
  [`watch find ${SETTINGS} -fprint "${SETTINGS}"`, L1("find-fprint")],
  [`watch -n 5 find . -fprint "${SETTINGS}"`, L1("find-fprint")],
  [`watch 'rm ${SETTINGS}'`, L2("rm")],
  [`watch -n 5 'rm -f' "${SETTINGS}"`, L2("rm")],
  [`watch --int 5 'rm ${SETTINGS}'`, L2("rm")],
  [`watch -tx sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`sudo watch 'rm ${SETTINGS}'`, L2("rm")],
  [`find . -exec watch 'rm ${SETTINGS}' \\;`, L2("rm")],
  [`flock /tmp/l find . -fprint "${SETTINGS}"`, L1("find-fprint")],
  [`flock -s /tmp/l --command 'rm ${SETTINGS}'`, L2("rm")],
  [`flock --wait 5 /tmp/l sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`su -lc 'rm ${SETTINGS}'`, L2("rm")],
  [`su root --command='rm ${SETTINGS}'`, L2("rm")],
  [`script --command 'rm ${SETTINGS}'`, L2("rm")],
  [`arch -e FOO=1 -arch arm64 find . -fprint "${SETTINGS}"`, L1("find-fprint")],
  [`parallel -j 4 'rm {}' ::: ${SETTINGS}`, L2("rm")],
  [`chroot --userspec=u:g / sh -c 'rm ${SETTINGS}'`, L2("rm")],
  // A KNOWN wrapper whose bare-word skip swallowed the real command name.
  [`nice rg --pre=rm x ${SETTINGS}`, L2("rm")],
  // PREFIX RUNNERS added with the load guard (`GIT_WRAPPERS`). The bipolar
  // fixture pairs use the QUOTED-BODY spelling, because that is the one
  // membership decides: measured against an unmodelled name on this tree,
  // `zzunknownwrap --flag sh -c 'rm <settings>'` returns NULL while
  // `zzunknownwrap --flag rm <settings>` still flags lexically. The rows here are
  // the value-option spellings, which discriminate the option walk: read as
  // flags, `-o /tmp/t` / `--cpunodebind=0` / `-t 1 -m` would put their VALUE in
  // the command slot and hide the verb behind it.
  [`setarch x86_64 rm -f ${SETTINGS}`, L2("rm")],
  [`linux32 sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`numactl --cpunodebind=0 sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`nsenter -t 1 -m find . -fprint "${SETTINGS}"`, L1("find-fprint")],
  [`unshare -r sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`systemd-run --user --scope sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`firejail --quiet sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`proot -R / sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`pkexec sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`strace -f -o /tmp/t sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`valgrind --tool=memcheck sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`xvfb-run -a sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`torsocks sh -c 'rm ${SETTINGS}'`, L2("rm")],
  // Multi-call binaries: the applet name occupies the command slot, so the real
  // command is one word further along.
  [`busybox sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`toybox find ${SETTINGS} -fprint "${SETTINGS}"`, L1("find-fprint")],
  // shadow-utils `sg` — the named-open residual a9dedb29c left behind.
  [`sg staff -c 'rm ${SETTINGS}'`, L2("rm")],
  [`sg - staff -c 'rm ${SETTINGS}'`, L2("rm")],
  // `nix-shell`'s positional operand is a `.nix` FILE, so only its body options
  // run anything a fence can see.
  [`nix-shell -p coreutils --run 'rm ${SETTINGS}'`, L2("rm")],
  [`nix-shell --command 'rm ${SETTINGS}'`, L2("rm")],
  // MULTI-VERB front-ends: the grammar applies only AFTER the runner verb, and
  // the verb may sit behind the front-end's own options. The QUOTED-BODY rows are
  // the ones that BIND the grammar entry — measured, `zzunknown run sh -c
  // 'rm <settings>'` is NULL, so only membership can produce the verdict.
  [`uv run sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`uv --directory . run sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`poetry run sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`pipx run --spec x sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`pnpm exec sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`yarn exec sh -c 'rm ${SETTINGS}'`, L2("rm")],
  // `mise exec` puts a NON-OPTION tool spec before the command, so `--` is what
  // decides where the command starts.
  [`mise exec node@20 -- sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`asdf exec sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`direnv exec . sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`conda run -n env sh -c 'rm ${SETTINGS}'`, L2("rm")],
  [`micromamba run -n e sh -c 'rm ${SETTINGS}'`, L2("rm")],
  // The bare-argv spelling of the same thing. These rows are TRUE but do NOT
  // bind the grammar: measured, `zzunknown run rm <settings>` is refused too, so
  // the generic word scan already reaches them and a mutation of the `uv` entry
  // leaves them green. Kept as documentation of the argv reading, never relied on
  // as evidence for it — the quoted-body rows above and the fixture pairs are.
  [`uv run rm ${SETTINGS}`, L2("rm")],
  [`pnpm exec rm ${SETTINGS}`, L2("rm")],
  [`mise exec node@20 -- rm ${SETTINGS}`, L2("rm")],
  // Constructs the parser reports as undecidable keep today's lexical verdict,
  // INCLUDING its false positive: an ANSI-C quote desyncs the quote model and an
  // unterminated quote leaves the segmentation untrusted.
  [`echo $'\\'' ; git grep -ln x -- ${SETTINGS}`, L2("ln")],
  [`git grep -ln 'x -- ${SETTINGS}`, L2("ln")],
];

const VERB_POSITION_ALLOWED = [
  `git grep -l 'x' -- ${SETTINGS}`,
  `git grep -ln 'x' -- ${SETTINGS}`,
  `git grep -lcn x -- ${SETTINGS}`,
  `grep -e rm ${SETTINGS}`,
  `docker run --rm img cat ${SETTINGS}`,
  `ls -cp ${SETTINGS}`,
  `git grep -ln x -- ${SETTINGS} "$(git rev-parse --show-toplevel)"`,
  // Layer 1 carried the same `\b` shape.
  `foo --tee ${SETTINGS}`,
  `foo --jq .a -i ${SETTINGS}`,
  // `find` is MODELLED, not word-scanned: only its exec actions run a command, so
  // a verb word inside an exec'd grep pattern is data (this one was refused before).
  `find ${SETTINGS} -name x -print`,
  `find ${SETTINGS} -type f -exec cat {} \\;`,
  `find ${SETTINGS} -exec grep -e rm {} \\;`,
  // `-fprint` truncates its FILE operand, not the start point.
  `find ${SETTINGS} -fprint /tmp/out`,
  `env -S 'cat ${SETTINGS}'`,
  `env FOO=1 cat ${SETTINGS}`,
  // The read-only poles for the command-running wrappers: the same wrapper, the
  // same protected path, a command that mutates nothing.
  `watch -n 5 cat ${SETTINGS}`,
  `watch 'cat ${SETTINGS}'`,
  `watch -x git status -- ${SETTINGS}`,
  `flock /tmp/l -c 'cat ${SETTINGS}'`,
  `su root -c 'cat ${SETTINGS}'`,
  `script -q /dev/null cat ${SETTINGS}`,
  `parallel 'cat {}' ::: ${SETTINGS}`,
  // The known-wrapper word scan skips flags and assignments, as the unknown one does.
  `nice git grep -ln x -- ${SETTINGS}`,
  `env ACTION=rm cat ${SETTINGS}`,
  // Read-only poles for the prefix runners and multi-verb front-ends: the same
  // wrapper, the same protected path, a verb that mutates nothing. These are the
  // no-false-positive half — recognising a wrapper must widen what the scan SEES,
  // never what it REFUSES.
  `setarch x86_64 sh -c 'cat ${SETTINGS}'`,
  `numactl --cpunodebind=0 sh -c 'cat ${SETTINGS}'`,
  `nsenter -t 1 -m cat ${SETTINGS}`,
  `systemd-run --user --scope cat ${SETTINGS}`,
  `firejail --quiet sh -c 'cat ${SETTINGS}'`,
  `strace -f -o /tmp/t node .claude/bin/emit.mjs --dry-run`,
  `valgrind --tool=memcheck sh -c 'cat ${SETTINGS}'`,
  `xvfb-run -a sh -c 'cat ${SETTINGS}'`,
  `busybox cat ${SETTINGS}`,
  `sg staff -c 'cat ${SETTINGS}'`,
  `nix-shell -p coreutils --run 'cat ${SETTINGS}'`,
  `uv run sh -c 'cat ${SETTINGS}'`,
  `pnpm exec sh -c 'cat ${SETTINGS}'`,
  `mise exec node@20 -- sh -c 'cat ${SETTINGS}'`,
  `conda run -n env sh -c 'cat ${SETTINGS}'`,
  `direnv exec . sh -c 'cat ${SETTINGS}'`,
  // A MULTI-VERB front-end carrying NO runner verb runs no operand command. Each
  // row still SPELLS the protected path, so it is not vacuously null; the
  // git-side half of the same gate (`uv pip install git` is not a git
  // invocation) is asserted in the wrapper-model test below.
  `conda list --explicit ${SETTINGS}`,
  `uv pip show -o ${SETTINGS}`,
  `pnpm why --json ${SETTINGS}`,
];

for (const [cmd, want] of VERB_POSITION_REFUSED) {
  test(`verb position — REFUSED with identity ${want.layer}:${want.kind}: ${JSON.stringify(cmd)}`, () => {
    const got = verdictBoth(cmd);
    assert.deepEqual(got.seg, want, `segment-aware entry point: ${JSON.stringify(got.seg)}`);
    assert.deepEqual(got.raw, want, `layer implementation: ${JSON.stringify(got.raw)}`);
  });
}

for (const cmd of VERB_POSITION_ALLOWED) {
  test(`verb position — ALLOWED (no mutation verb where the shell runs one): ${JSON.stringify(cmd)}`, () => {
    const got = verdictBoth(cmd);
    assert.equal(got.seg, null, `segment-aware entry point: ${JSON.stringify(got.seg)}`);
    assert.equal(got.raw, null, `layer implementation: ${JSON.stringify(got.raw)}`);
  });
}

// RESIDUAL, pinned so that closing it is a deliberate act and not a silent drift.
// The verb IS recognised here (the literal-path sibling above is refused), but the
// protected path is never spelled: `-name settings.json` is a pattern find expands
// at run time. That is `state-file-write-guard.md` § Known residuals (a)/(f) — the
// literal is absent pre-expansion — not a verb-position gap.
//
// NARROWED, NOT CLOSED (loom round-3 S4). `findSynthesizedPaths` now reconstructs
// the DIRECT-CHILD reading of the root × `-name` join, which closes
// `find .claude/learning -name posture.json -delete` and its `-exec rm` sibling
// (both `flag-s4-*` fixtures). What is left is exactly the shape below: a search
// root that is an ANCESTOR rather than the parent, where the protected file is
// reached through an unbounded set of intermediate directories no join can
// enumerate from a path regex. `./settings.json` is what the join produces here,
// and it is genuinely not a protected path — so the residual is the RECURSION,
// not the join. Closing it needs the containment oracle to answer "could a
// protected path exist UNDER this root with this basename", which is a different
// question from the one `scopedPathHit` is built for.
test("verb position — RESIDUAL: find by -name never spells the protected path", () => {
  assert.deepEqual(verdictBoth("find . -name settings.json -exec rm {} \\;"), {
    seg: null,
    raw: null,
  });
});

// RESIDUAL, OPEN BY DECISION — stdin-fed operands (`… | xargs <verb>`). The
// rationale lives at `violation-patterns.js::detectStateFileMutationSegmentAware`;
// what is pinned here is the DECISION, so that closing it is deliberate.
//
// READ THIS BEFORE "FIXING" IT. A pass reconstructing the argv `xargs` would
// build WAS written and measured, and was BACKED OUT: it closed the bypass and
// ALSO fired, at `block` tier, on two classes of routine instructed work — the
// EXCLUSION role (the protected path is what the producer SKIPS) and the
// INPUT-LIST role (the producer READS the protected file to obtain OTHER paths).
// The second is not fixable at this layer at all: it is token-for-token the same
// shape as the true positive, and only the producer's STDOUT separates them,
// which `hook-output-discipline.md` MUST-3 forbids the hook from computing.
// A fence that blocks `grep … | xargs sed` is worse than one that misses a rare
// bypass. If you close this, these three false-positive rows go RED first.
// MEASURED on this tree, and it is the whole reason the pass was backed out: the
// residual and the ABSENCE of the false positives have the SAME cause. The FLAT
// layer implementation (`raw`) flags every row below, true positive and false
// positive alike, because verb and path sit in one string. The SEGMENT SPLIT —
// which is what production calls — drops all five. So a pass that reached across
// the pipe would not be adding sight to a blind scan; it would be re-importing
// the flat scan's false positives into the entry point that had removed them.
test("RESIDUAL: stdin-fed xargs operands are undetected, by decision", () => {
  // (i) The true positive that stays open. Its bipolar partner is the SAME verb
  // and path with the operand on the ARGV, which IS refused at BOTH entry points
  // — so this row pins a boundary, not a blind spot in the verb scan.
  assert.deepEqual(verdictBoth(`echo ${SETTINGS} | xargs rm`), {
    seg: null,
    raw: L2("rm"),
  });
  assert.deepEqual(verdictBoth(`xargs rm ${SETTINGS}`), {
    seg: L2("rm"),
    raw: L2("rm"),
  });
  // A here-string is not stdin from a PIPE — the operand is still in the segment,
  // and `xargs rm <<< <settings>` is refused (pinned in VERB_POSITION_REFUSED
  // above). Kept adjacent so the two are not confused for one another.
  //
  // (ii) The two MEASURED false positives of the backed-out pass, EXCLUSION role:
  // the protected path is what the producer SKIPS. Both flag under the flat scan.
  assert.deepEqual(
    verdictBoth(`grep -rl needle . --exclude-dir=.git | xargs sed -i ''`),
    { seg: null, raw: L1("in-place-edit") },
  );
  assert.deepEqual(
    verdictBoth(`find . -path ./.git -prune -o -name '*.tmp' -print | xargs rm`),
    { seg: null, raw: L2("rm") },
  );
  // (iii) INPUT-LIST role — the producer READS the protected file and emits
  // OTHER paths. Token-for-token the shape of (i); only the producer's stdout
  // separates them, and `hook-output-discipline.md` MUST-3 forbids computing it.
  assert.deepEqual(verdictBoth(`jq -r '.paths[]' ${SETTINGS} | xargs rm`), {
    seg: null,
    raw: L2("rm"),
  });
});

// The command-running wrappers are extracted in the SHARED parser, so the git/gh
// verb fences get the same closure the state-file detector does. That half is
// pinned here in-process; the hook-spawning posture-gate suite is the hook half.
// Before the change every row below parsed as NO git invocation. The two
// value-option rows (`watch -n 1`, `flock -w 5`) discriminate the grammar: read
// as flags, their VALUE would land in the command slot and hide the git token.
const GP = require(
  path.resolve(HERE, "..", "..", "..", "hooks", "lib", "git-command-parse.js"),
);
const gitSubs = (cmd) =>
  GP.parseGitInvocations(cmd).map((g) => g.sub || `?${g.unresolvable}`);

test("wrapper model — git invocations behind command-running wrappers are parsed", () => {
  assert.deepEqual(gitSubs("git commit -m x"), ["commit"], "control");
  for (const cmd of [
    "watch -n 1 git commit -m x",
    "watch 'git commit -m x'",
    "watch -x git commit -m x",
    // -x keeps the argv: joined for `sh -c` instead, `sh -c git commit -m x` runs
    // only `git`, so this row separates the two readings.
    "watch -x sh -c 'git commit -m x'",
    "flock -w 5 /tmp/l git commit -m x",
    "flock /tmp/l -c 'git commit -m x'",
    "chronic git commit -m x",
    "unbuffer git commit -m x",
    "arch -arch arm64 git commit -m x",
    "caffeinate -t 5 git commit -m x",
    "chroot / git commit -m x",
    "script -q /dev/null git commit -m x",
    "script -q -c 'git commit -m x' /dev/null",
    "su root -c 'git commit -m x'",
    "runuser -u root -- git commit -m x",
    "parallel git commit -m ::: x",
    "exec git commit -m x",
    "gtimeout 5 git commit -m x",
    "genv -S 'git commit -m x'",
    "gnice -n 5 git commit -m x",
    // getopt_long's unique-prefix rule: `--int` is `--interval`, which takes `1`.
    "watch --int 1 git commit -m x",
    // parallel with no command runs each argument as a command line.
    "parallel ::: 'git commit -m x'",
  ]) {
    assert.deepEqual(gitSubs(cmd), ["commit"], `${cmd}: ${JSON.stringify(gitSubs(cmd))}`);
  }
  for (const cmd of [
    "watch git status",
    "flock /tmp/l git status",
    "su root -c 'git status'",
    // After `--` nothing is an option: git's own `-c <name=value>` must not be
    // read as runuser's shell body (which would invent a `commit`).
    "runuser -u root -- git -c 'git commit -m x' status",
  ]) {
    assert.deepEqual(gitSubs(cmd), ["status"], cmd);
  }
  // A shell body the hook cannot read is unresolvable, the verdict `sh -c "$CMD"` gets.
  assert.deepEqual(gitSubs('watch "$CMD"'), ["?subcommand"]);
  // A lone lock descriptor runs nothing.
  assert.deepEqual(gitSubs("flock 9"), []);
});

// The SAME parity for the prefix runners and multi-verb front-ends the load
// guard added. This half is what makes the entry list load-bearing rather than
// decorative: the git verb fence carries `block` severity for `push`, so a
// wrapper it cannot see through is a bypass of a blocking gate, not merely of an
// advisory one. `setarch x86_64 git push --force` is the named row — note that
// `x86_64` is BOTH setarch's arch operand and a GIT_WRAPPERS alias of its own,
// so a grammar that mis-read the operand would still have to land on `git`.
test("wrapper model — git PUSH behind the load-guard wrappers is parsed", () => {
  assert.deepEqual(gitSubs("git push --force"), ["push"], "control");
  // NEGATIVE control, measured on this tree: an unmodelled name yields NOTHING,
  // so membership — not the generic word scan — is what closes each row below.
  assert.deepEqual(gitSubs("zzunknownwrap --flag git push --force"), []);
  for (const cmd of [
    "setarch x86_64 git push --force",
    "linux32 git push --force",
    "numactl --cpunodebind=0 git push --force",
    "nsenter -t 1 -m git push --force",
    "unshare -r git push --force",
    "systemd-run --user --scope git push --force",
    "cgexec -g cpu:/lim git push --force",
    "firejail --quiet git push --force",
    "bwrap --dev-bind / / git push --force",
    "proot -R / git push --force",
    "fakeroot git push --force",
    "pkexec git push --force",
    "eatmydata git push --force",
    "strace -f -o /tmp/t git push --force",
    "ltrace git push --force",
    "dtruss git push --force",
    "valgrind --tool=memcheck git push --force",
    "gdb --args git push --force",
    "xvfb-run -a git push --force",
    "torsocks git push --force",
    "proxychains4 -q git push --force",
    "busybox git push --force",
    "toybox git push --force",
    // COMMAND_RUNNING_WRAPPERS grammars.
    "sg staff -c 'git push --force'",
    "nix-shell --run 'git push --force'",
    "uv run git push --force",
    "poetry run git push --force",
    "pipx run git push --force",
    "pnpm exec git push --force",
    "yarn exec git push --force",
    "mise exec node@20 -- git push --force",
    "asdf exec git push --force",
    "direnv exec . git push --force",
    "conda run -n e git push --force",
    "micromamba run -n e git push --force",
  ]) {
    assert.deepEqual(gitSubs(cmd), ["push"], `${cmd}: ${JSON.stringify(gitSubs(cmd))}`);
  }
  // The `subcommands` gate, git side: a multi-verb front-end carrying no runner
  // verb runs no operand command, so a `git` WORD in its arguments is a package
  // name, not an invocation. Plain GIT_WRAPPERS membership would have invented
  // one here — which is why these front-ends got a grammar instead.
  for (const cmd of ["uv pip install git", "pnpm add git", "conda list git"]) {
    assert.deepEqual(gitSubs(cmd), [], cmd);
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
