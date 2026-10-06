#!/usr/bin/env node
/**
 * codify-lease-journal-scope — the regression lock for RS-50, re-derived
 * 2026-08-16 for the RECORD-OVERFLOW fix.
 *
 * WHAT IS UNDER TEST. `codify-lease.js::_sortDedupRel` unions, into EVERY lease
 * scope, the journal directories `/codify`'s own phase-complete gate writes to.
 *
 * THE ORIGINAL DEFECT (RS-50). `commands/codify.md` Step 0 tells the caller the
 * helper unions only `.claude/learning/learning-codified.json` +
 * `.claude/.proposals/latest.yaml`; § "Journal (MUST — phase-complete gate)" then
 * REQUIRES a journal entry before `/codify` may be reported complete. A caller
 * following the command LITERALLY acquired a lease covering two files and was
 * halt-and-reported by `integrity-guard.js` for the journal write — on a step the
 * SAME command mandates.
 *
 * ── WHY THIS FIXTURE WAS RE-DERIVED, NOT PATCHED ─────────────────────────────
 *
 * The RS-50 fix resolved the journal prefixes by ENUMERATING `workspaces/` on
 * disk. That list is O(repo size) and lands verbatim in `content.scope_files` of
 * the signed `codify-lease` record, which `coc-emit.js::_defaultAppend` caps at
 * 2048 B. Measured: the record crosses the cap at the TWELFTH enumerated
 * workspace and reached 2964 B on loom's 31 (reproduced end-to-end 2026-08-23
 * against the real `_defaultAppend`), so every MAIN-CHECKOUT acquire was REFUSED
 * and the cross-clone visibility surface `knowledge-convergence.md` MUST-3 names
 * never emitted from there — while `acquireCodifyLease` kept returning
 * {ok: true}. NOT every acquire: a worktree enumerates far fewer (most workspace
 * journals are untracked), so 195 records did land, none above 19 scope entries.
 * The enumeration is now the bounded shape `workspaces` + `*` + `journal/`.
 *
 * THAT VOIDED THIS FIXTURE'S STATED DISCRIMINATION. The previous revision said
 * "the lever is the LAYOUT, not the call" — the same call had to yield different
 * prefixes per layout. Under a bounded shape the scope is layout-INDEPENDENT by
 * design, so every layout case would now pass no matter what the resolver did
 * with the directory tree, and the suite would have quietly become a set of
 * constants. Rewriting only the assertions that reddened would have left exactly
 * that. The lever is therefore re-derived:
 *
 *   THE NEW LEVER IS THE PAIR (bounded, AND still covering).
 *   An enumerating implementation reds `scope-is-bounded` and `record-fits-cap`.
 *   An implementation that unions nothing, or emits a shape the real covering
 *   predicate does not accept, reds every coverage case. Neither property alone
 *   is sufficient — a resolver returning [] is perfectly bounded, and the
 *   enumeration was perfectly covering.
 *
 * ── TWO CONTRACT CHANGES, RECORDED RATHER THAN ABSORBED ──────────────────────
 *
 * (1) META-DIRS ARE NOW COVERED. The old `meta-dirs-excluded` case asserted that
 *     `workspaces/_archive/journal/` and `workspaces/instructions/journal/` were
 *     NOT scoped (cc-artifacts.md Rule 8). A single-segment wildcard cannot carry
 *     a negative, and pushing the exclusion into the READER would move a
 *     writer-side tidiness policy into the trust predicate. The exclusion is
 *     therefore DROPPED, deliberately — see `meta-dirs-now-covered`, which
 *     asserts the NEW behaviour under a NEW name so the change is visible in the
 *     case list rather than hidden in a flipped assertion. Grounds: guard-path-
 *     scope.js::WATCHED_SUBTREE_RX watches `workspaces/<any>/journal/` with NO
 *     underscore exclusion, so those paths were always WATCHED and never
 *     COVERABLE — the change closes that residual rather than opening a new hole.
 *     This is a real widening and is flagged for gate-review, not self-certified.
 *
 * (2) THE COVERING PREDICATE GAINED A FOURTH BRANCH. `globCoversRel` is IMPORTED
 *     here, not transcribed — it lives in `guard-path-scope.js`, which is a plain
 *     module. Only the three literal branches remain transcribed, because
 *     `integrity-guard.js` still has no `module.exports` and runs an unguarded
 *     `main()` IIFE, so requiring it would EXECUTE the hook.
 *
 * ── THE TRAILING-SLASH FORM ──────────────────────────────────────────────────
 *
 * The previous README warned: "A maintainer who rewrites [meta-dirs-excluded] to
 * assert coverage instead of membership removes the last thing holding the
 * emitted form." That case is exactly what changed, so the form is NOT left
 * unheld — `emitted-form-pinned` now asserts the literal emitted strings
 * directly, which is a stronger hold than the incidental one it replaces.
 *
 * Each case names the mutation that reds it (`instrument-discipline.md`
 * MUST-2(b)); the mutations are recorded as measured in README.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// Overridable so the RED can be established against an UNFIXED build of the
// module without mutating the working tree (`instrument-discipline.md` MUST-2).
const LIB =
  process.env.CODIFY_LEASE_LIB ||
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "codify-lease.js");
const GUARD = path.join(REPO_ROOT, ".claude", "hooks", "integrity-guard.js");

const mod = require(LIB);
const sortDedupRel = mod._test_sortDedupRel;
const { globCoversRel, matchIntegrityWatchedRel } = require(
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "guard-path-scope.js"),
);
const { MAX_LINE_BYTES } = require(
  path.join(REPO_ROOT, ".claude", "hooks", "lib", "coc-emit.js"),
);

/**
 * `integrity-guard.js::leaseScopeCovers`'s covering predicate (the scan
 * `findCoveringLease` delegates the SCOPE half of its decision to). The three
 * LITERAL branches are TRANSCRIBED (the hook self-executes on require, so it is
 * not importable); the FOURTH — the single-segment glob — is IMPORTED from
 * `guard-path-scope.js`, the module that owns it. `RS-50/covering-predicate-pin`
 * below asserts the real function still carries exactly these four and no fifth,
 * AND that the helper hosting them still exists, so a divergence reds here
 * rather than silently making every coverage assertion test a stale contract.
 *
 * SCOPE COVERAGE IS NECESSARY, NOT SUFFICIENT, and this fixture tests only the
 * necessary half. `findCoveringLease` additionally requires the lease to still
 * be a GRANT — un-released, and within `LEASE_TTL_MS` — so a scope that covers
 * a path does NOT by itself authorize a write to it. That second half is pinned
 * in tests/integration/multi-operator/lease-binding-drop-1849b.test.js § G, not
 * here; RS-50 is about which PATHS a lease scope reaches.
 */
function coversRel(scope, candidateRel) {
  for (const s of scope) {
    if (s === candidateRel) return true;
    if (s.endsWith("/") && candidateRel.startsWith(s)) return true;
    if (!s.includes(".") && candidateRel.startsWith(s + "/")) return true;
    if (globCoversRel(s, candidateRel)) return true;
  }
  return false;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rs50-"));
let pass = 0;
const failures = [];

function check(name, expectation, actualFn) {
  let ok = false;
  let detail;
  try {
    const r = actualFn();
    ok = r === true;
    if (!ok) detail = typeof r === "string" ? r : JSON.stringify(r);
  } catch (err) {
    detail = `threw: ${err && err.message ? err.message : String(err)}`;
  }
  if (ok) {
    pass += 1;
    // `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS
    // counts (/^[ \t]*(?:PASS|ok)[ \t]+\S/). An indented `✓ <name>` is invisible
    // to it, so this runner reported 0 cases against its own min_cases floor —
    // 9 at the time, while it passed 9/9 standalone. Both numbers are the state
    // AS OF that incident, not the live floor: read the floor from
    // ci-audit-fixtures.json rather than from this comment.
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}`);
    console.log(`      expected: ${expectation}`);
    console.log(`      actual  : ${detail}`);
  }
}

function mkRepo(label, dirs) {
  const root = path.join(TMP, label);
  fs.mkdirSync(root, { recursive: true });
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

// ── RS-50 — the original finding ──────────────────────────────────────────────
check(
  "RS-50",
  'empty scopeFiles yields a scope covering "journal/0001-x-DECISION-y.md"',
  () => {
    mkRepo("root-journal", ["journal"]);
    const scope = sortDedupRel([]);
    return (
      coversRel(scope, "journal/0001-x-DECISION-y.md") ||
      `scope=${JSON.stringify(scope)}`
    );
  },
);

// The root default must hold even when the directory does not exist — the
// /codify that CREATES a repo's first journal entry has no directory to resolve.
check(
  "RS-50/root-journal-covered-before-the-dir-exists",
  'a repo with NO journal/ still yields a scope covering "journal/0001-x.md"',
  () => {
    mkRepo("no-journal-yet", []);
    const scope = sortDedupRel([]);
    return coversRel(scope, "journal/0001-x.md") || `scope=${JSON.stringify(scope)}`;
  },
);

// The workspace-scoped layout — the half a root-only implementation would miss.
check(
  "RS-50/workspace-journal-covered",
  'the bounded shape covers "workspaces/alpha/journal/0001-x.md"',
  () => {
    mkRepo("ws-journal", ["workspaces/alpha/journal"]);
    const scope = sortDedupRel([]);
    return (
      coversRel(scope, "workspaces/alpha/journal/0001-x.md") ||
      `scope=${JSON.stringify(scope)}`
    );
  },
);

// `.pending/` is a real journal write target (`journal-write-guard.js` watches
// `workspaces/<name>/journal/.pending/<slot>-…`), so the scope must reach it.
check(
  "RS-50/pending-subdir-covered",
  'the bounded shape also covers "workspaces/alpha/journal/.pending/0001-x.md"',
  () => {
    mkRepo("ws-pending", ["workspaces/alpha/journal/.pending"]);
    const scope = sortDedupRel([]);
    return (
      coversRel(scope, "workspaces/alpha/journal/.pending/0001-x.md") ||
      `scope=${JSON.stringify(scope)}`
    );
  },
);

// A repo with no workspaces/ at all must not throw — a lease MUST NOT fail to
// acquire because the layout is minimal.
check(
  "RS-50/no-workspaces-dir-does-not-throw",
  "a repo with no workspaces/ resolves cleanly and still carries the root default",
  () => {
    mkRepo("bare", ["journal"]);
    const scope = sortDedupRel([]);
    return scope.includes("journal/") || `scope=${JSON.stringify(scope)}`;
  },
);

// ── the property whose ABSENCE caused the 2026-08-16 outage ──────────────────
// Reds against ANY per-workspace enumeration, which is the whole point.
check(
  "RS-50/scope-is-bounded",
  "the scope is byte-identical for a repo with 0 workspaces and one with 40",
  () => {
    // The cwd is the lever: an enumerating implementation resolves `workspaces/`
    // relative to it, so the two calls must straddle a chdir for this case to
    // discriminate at all. `finally` restores it even on a throw — a stuck cwd
    // would silently corrupt every case after this one.
    const many = mkRepo(
      "bounded-40",
      Array.from({ length: 40 }, (_, i) => `workspaces/ws-${i}/journal`),
    );
    const a = JSON.stringify(sortDedupRel([]));
    let b;
    try {
      process.chdir(many);
      b = JSON.stringify(sortDedupRel([]));
    } finally {
      process.chdir(REPO_ROOT);
    }
    return a === b || `bare=${a}\n                populated=${b}`;
  },
);

// The consequence the bound exists FOR: the signed record has to fit the cap.
check(
  "RS-50/record-fits-cap",
  `a codify-lease record built from this scope fits MAX_LINE_BYTES (${MAX_LINE_BYTES}B)`,
  () => {
    const scope = sortDedupRel([]);
    const record = {
      type: "codify-lease",
      verified_id: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
      person_id: "pid-synthetic-fixture",
      display_id: "someoperator",
      seq: 128,
      prev_hash: "a".repeat(64),
      ts: "2026-08-16T12:00:00.000Z",
      content: {
        lease_id: "lease_1755300000000_deadbeef",
        branch: "codify/someoperator-2026-08-16",
        date: "2026-08-16",
        scope_files: scope,
        scope_fingerprint: mod._test_scopeFingerprint(scope),
        acquired_at: "2026-08-16T12:00:00.000Z",
        action: "acquire",
      },
      // The armored-GPG signature length MEASURED from loom's live signer. A
      // stub signature is a fraction of this and would let an over-budget
      // record read as fitting.
      sig: "x".repeat(870),
    };
    const bytes = Buffer.byteLength(JSON.stringify(record) + "\n", "utf8");
    return bytes <= MAX_LINE_BYTES || `record=${bytes}B > cap=${MAX_LINE_BYTES}B`;
  },
);

// ── CONTRACT CHANGE (1), asserted under a NEW name so it is visible ──────────
//
// READ THIS BEFORE "RESTORING" THE OLD BEHAVIOUR. Until 2026-08-16 this case was
// `meta-dirs-excluded` and asserted the OPPOSITE: that `workspaces/_archive/…`
// and `workspaces/instructions/…` were NOT scoped. It was renamed rather than
// flipped, so the change is visible in the case list — but a name is not an
// argument, so here is the argument.
//
// WHY THE EXCLUSION WAS DROPPED — three reasons, ruled on and accepted
// 2026-08-16 (the ruling is recorded; the widening was escalated as a named
// question to Tier-1 redteam rather than self-certified):
//
//   1. IT IS NOT EXPRESSIBLE. The scope is now a bounded single-segment
//      wildcard, because an enumerated list is O(repo size) inside a record
//      capped at 2048 B and had been refused, from any checkout enumerating
//      twelve or more workspaces, since the twelfth. A wildcard cannot carry a
//      NEGATIVE — there is no shape that
//      says "every workspace journal EXCEPT the underscore-prefixed ones" and
//      still fits in a bounded string the reader can evaluate.
//
//   2. THE ALTERNATIVE IS A LAYERING VIOLATION. The exclusion could be moved
//      into `findCoveringLease`. It must not be: that predicate answers "is this
//      path within the scope this lease DECLARED", and nothing else. Whether
//      anyone SHOULD be writing under `_archive` is writer-side tidiness policy.
//      Pushing tidiness policy into a trust predicate makes the trust decision
//      depend on a convention that can change for unrelated reasons.
//
//   3. IT CLOSED AN INCOHERENCE RATHER THAN OPENING A HOLE.
//      `guard-path-scope.js::WATCHED_SUBTREE_RX` matches
//      `workspaces/<any>/journal/` with NO underscore exclusion. So those paths
//      were WATCHED (the guard fences a write there) but UNCOVERABLE (no lease
//      could ever authorise one). That is not a protection — it is a state where
//      the only outcome is a halt-and-report on a path the substrate itself
//      treats as an ordinary journal.
//
// `cc-artifacts.md` Rule 8 is NOT authority against this. Rule 8 governs hooks
// that ENUMERATE workspaces — the harm there is surfacing `_archive` as if it
// were the active workspace. Lease coverage is a different question.
//
// WHAT IS ACTUALLY GAINED BY AN ADVERSARY OR A CARELESS OPERATOR: a /codify
// session, already holding a valid lease, on its own date-terminal codify
// branch, under its own verified signer, may now write `workspaces/_archive/
// journal/**` without a fresh halt. It gains nothing outside that: coverage is a
// strict SUBSET of the watched set (measured — every path this glob covers is
// also matched by `matchIntegrityWatchedRel`), and the branch + signer checks in
// `findCoveringLease` are untouched.
check(
  "RS-50/meta-dirs-now-covered",
  "workspaces/_archive/journal/ IS now scoped — the exclusion was dropped deliberately",
  () => {
    mkRepo("meta", [
      "workspaces/_archive/journal",
      "workspaces/instructions/journal",
      "workspaces/real/journal",
    ]);
    const scope = sortDedupRel([]);
    for (const p of [
      "workspaces/_archive/journal/0001-x.md",
      "workspaces/instructions/journal/0001-x.md",
      "workspaces/real/journal/0001-x.md",
    ]) {
      if (!coversRel(scope, p)) return `NOT covered: ${p}`;
    }
    return true;
  },
);

// The BOUND on contract change (1). The paragraph above claims the widening
// "gains nothing outside" the watched set; this ENFORCES that claim rather than
// asserting it, so a future widening of the glob that reached an unwatched path
// reds here. Direction matters: covered ⇒ watched. The converse is false and
// deliberately not asserted — plenty of watched paths (team-memory, the roster)
// are correctly NOT covered by a workspace-journal scope.
check(
  "RS-50/coverage-is-a-subset-of-the-watched-set",
  "every path the journal scope COVERS is also a path integrity-guard WATCHES",
  () => {
    const scope = sortDedupRel([]);
    const probes = [
      "workspaces/alpha/journal/0001-x.md",
      "workspaces/_archive/journal/0001-x.md",
      "workspaces/instructions/journal/0001-x.md",
      "workspaces/alpha/journal/.pending/0001-x.md",
      "journal/0001-x.md",
      // Negative probes — neither covered nor watched. Present so the case
      // cannot pass by the scope covering nothing at all.
      "workspaces/alpha/notes/0001-x.md",
      "workspaces/a/b/journal/0001-x.md",
      "src/main.js",
    ];
    let covered = 0;
    for (const p of probes) {
      const isCovered = coversRel(scope, p);
      if (!isCovered) continue;
      covered += 1;
      if (!matchIntegrityWatchedRel(p)) {
        return `COVERED but NOT WATCHED: ${p} — the lease scope reaches a path ` +
          "the guard never consults, which is breadth with no fence behind it";
      }
    }
    // Anti-vacuity: if the scope covered nothing, the loop above proves nothing.
    return covered >= 5 || `only ${covered} probes were covered — scope=${JSON.stringify(scope)}`;
  },
);

// knowledge-convergence.md MUST-3's named pair must survive — the journal
// prefixes are an ADDITION to the mandatory scope, never a replacement.
check(
  "RS-50/mandatory-scope-preserved",
  "both MANDATORY_SCOPE files are still auto-unioned (knowledge-convergence.md MUST-3)",
  () => {
    const scope = sortDedupRel([]);
    const missing = [
      ".claude/learning/learning-codified.json",
      ".claude/.proposals/latest.yaml",
    ].filter((f) => !scope.includes(f));
    return missing.length === 0 || `missing=${JSON.stringify(missing)}`;
  },
);

// Caller-supplied scope entries must survive alongside the auto-unioned ones.
check(
  "RS-50/caller-scope-preserved",
  "an explicit scopeFiles entry is not dropped by the journal union",
  () => {
    const scope = sortDedupRel([".claude/rules/foo.md"]);
    return (
      scope.includes(".claude/rules/foo.md") || `scope=${JSON.stringify(scope)}`
    );
  },
);

// ── the emitted FORM, now held directly ──────────────────────────────────────
// Replaces the incidental hold the old `meta-dirs-excluded` literal-membership
// assertion provided, which the previous README explicitly warned about losing.
check(
  "RS-50/emitted-form-pinned",
  'the resolver emits exactly ["journal/", "workspaces/*/journal/"] — trailing slashes included',
  () => {
    const got = JSON.stringify(mod._test_resolveJournalScope());
    const want = JSON.stringify([
      mod.JOURNAL_ROOT_SCOPE,
      mod.WORKSPACE_JOURNAL_SCOPE,
    ]);
    if (got !== want) return `got=${got} want=${want}`;
    // …and the constants themselves are the trailing-slash forms, so a change to
    // them reds here rather than silently altering what findCoveringLease sees.
    if (mod.JOURNAL_ROOT_SCOPE !== "journal/") {
      return `JOURNAL_ROOT_SCOPE=${mod.JOURNAL_ROOT_SCOPE}`;
    }
    if (mod.WORKSPACE_JOURNAL_SCOPE !== "workspaces/*/journal/") {
      return `WORKSPACE_JOURNAL_SCOPE=${mod.WORKSPACE_JOURNAL_SCOPE}`;
    }
    return true;
  },
);

// The git-pathspec twin. The record shape matches NOTHING as a git pathspec
// (measured, git 2.50.1: a trailing-slash wildcard pathspec returns empty), so
// the dirty gate needs the `:(glob)` form. Handing it the record shape would
// silently no-op the scope-dirtiness gate for every workspace journal.
check(
  "RS-50/pathspec-translation",
  "the workspace-journal entry is translated for git; every other entry passes through",
  () => {
    const scope = sortDedupRel([".claude/rules/foo.md"]);
    const specs = mod._test_scopeToPathspecs(scope);
    if (specs.length !== scope.length) return `length ${specs.length} != ${scope.length}`;
    for (let i = 0; i < scope.length; i++) {
      const want =
        scope[i] === mod.WORKSPACE_JOURNAL_SCOPE
          ? mod.WORKSPACE_JOURNAL_PATHSPEC
          : scope[i];
      if (specs[i] !== want) return `specs[${i}]=${specs[i]} want=${want}`;
    }
    return true;
  },
);

// ── the pin, STRENGTHENED ────────────────────────────────────────────────────
// The previous revision asserted only that the three transcribed lines were
// PRESENT. That check passes unchanged when a FOURTH branch is added — which is
// exactly what happened on 2026-08-16, so the pin did not red and the stale
// transcription was caught by the coverage cases instead. It now asserts the
// branch SET: all four present, and no fifth `return rec;` in the loop.
check(
  "RS-50/covering-predicate-pin",
  "leaseScopeCovers carries exactly the four covering branches transcribed above",
  () => {
    const src = fs.readFileSync(GUARD, "utf8");
    // RE-DERIVED 2026-08-21 against the real predicate. The three conditions are
    // UNCHANGED; what changed is where they live and what they return. The
    // covering scan was extracted out of `findCoveringLease` into the named
    // helper `leaseScopeCovers`, which answers "does this scope cover the path?"
    // with a BOOLEAN — so `return rec` became `return true` — because the caller
    // now has a second question to ask about the same record (is the lease still
    // a GRANT: un-released, and inside LEASE_TTL_MS). The predicate this fixture
    // transcribes did not move semantically, and `coversRel()` above already
    // returned a boolean, so it needed no edit; only these literals did.
    const lines = [
      "if (s === candidateRel) return true;",
      'if (s.endsWith("/") && candidateRel.startsWith(s)) return true;',
      'if (!s.includes(".") && candidateRel.startsWith(s + "/")) return true;',
      "if (globCoversRel(s, candidateRel)) return true;",
    ];
    const absent = lines.filter((l) => !src.includes(l));
    if (absent.length > 0) {
      return (
        `integrity-guard.js no longer carries: ${JSON.stringify(absent)} — ` +
        "re-derive coversRel() in this fixture against the real predicate"
      );
    }
    // Pin the HOST too. Without this the four lines could migrate into some
    // unrelated helper and the pin would still read green while `coversRel()`
    // no longer transcribes the predicate the guard actually authorizes with.
    const HOST = "function leaseScopeCovers(content, candidateRel) {";
    const hostAt = src.indexOf(HOST);
    if (hostAt < 0) {
      return (
        "integrity-guard.js no longer defines leaseScopeCovers(content, candidateRel) — " +
        "the covering lines above may now live in an unrelated helper; re-derive " +
        "coversRel() against whatever findCoveringLease actually calls"
      );
    }

    // CARDINALITY, scoped to the host's own body — not the whole file. A
    // file-wide `return true;` count happens to equal 4 today only because no
    // other function in integrity-guard.js uses that literal; it would go red on
    // an unrelated edit and green again if a covering branch were added in the
    // same commit as an unrelated `return true;` was removed. Neither reading
    // would be about the predicate, which is the question this case exists for.
    const bodyEnd = src.indexOf("\n}", hostAt);
    const body = src.slice(hostAt, bodyEnd < 0 ? src.length : bodyEnd);
    const n = (body.match(/return true;/g) || []).length;
    if (n !== lines.length) {
      return (
        `leaseScopeCovers has ${n} \`return true;\` branches but this fixture ` +
        `transcribes ${lines.length} — a covering branch was added without ` +
        "updating coversRel(), which would make every coverage case above test " +
        "a predicate weaker than the real one"
      );
    }
    return true;
  },
);

fs.rmSync(TMP, { recursive: true, force: true });

const total = pass + failures.length;
console.log(`\ncodify-lease-journal-scope: ${pass}/${total} PASS`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
