#!/usr/bin/env node
/**
 * adjacency-leasecheck — fixture runner (F51 residue; loom#2044 Group A).
 *
 * Nine fixtures, nine scope-restriction predicates, ONE guard:
 * `.claude/hooks/adjacency-leasecheck.js`. FAMILY A (disposition) — driven through
 * the shared `runDispositionSuite` in ../hook-fixture-runner.mjs.
 *
 * WHAT WAS UNEXECUTED. This directory held nine `input.json` + `expected.txt`
 * pairs and no `run.mjs`, so it sat outside run-audit-fixtures.mjs's closure.
 * `tests/integration/adjacency-leasecheck.test.js` drives the guard and is
 * registered in ci-suites.json; what nothing executed is THIS CORPUS — the pinned
 * dispositions, including fixture 07's `body_discriminator`, which exists
 * precisely because §4.1 SAME and §4.2 now SHARE a severity and a severity-only
 * assertion cannot tell them apart.
 *
 * PORCELAIN IS PINNED IN THE HARNESS, NOT MATERIALIZED. `detectFilesystemException
 * Match` takes `COC_PORCELAIN_OVERRIDE` as AUTHORITATIVE when set (any value,
 * including empty) and otherwise shells out to `git worktree list --porcelain`
 * against whatever tree it finds. Left unset, every "silent" fixture would depend
 * on ambient worktree state and could emit a stderr ADVISORY for a reason no
 * fixture declares. So the variable is set on EVERY drive — empty for the fixtures
 * that declare no porcelain state, and to the fixture's own `_env_overrides` value
 * for 07/08. This is the guard's own documented test seam (`rules/instrument-
 * discipline.md`: pin the precondition through the seam, never by materializing
 * ambient repo state).
 *
 *   node .claude/audit-fixtures/adjacency-leasecheck/run.mjs
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant
 */
import path from "path";
import { fileURLToPath } from "url";
import {
  makeReporter,
  mkKey,
  mkRepo,
  writeRoster,
  writeLog,
  signRecord,
  driveHook,
  cleanup,
  runDispositionSuite,
} from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/adjacency-leasecheck.js");

const { check, finish } = makeReporter();

const FIXTURES = [
  "01-watched-edit-on-claimed-path",
  "02-watched-edit-on-unrelated-path",
  "03-watched-write-on-workspace",
  "04-watched-write-on-non-cwd-path",
  "05-non-watched-tool-noop",
  "06-structural-null-malformed-log",
  "07-filesystem-exception-positive",
  "08-filesystem-exception-negative",
  "09-self-claim-no-self-conflict",
];

const SETUPS = {
  "01-watched-edit-on-claimed-path": {
    claims: [{ by: "sibling", content: { path: "src/lib/foo.js" } }],
    why: "an ACTIVE sibling claim on the exact target path — §4.1 SAME axis (a), predicate `exact`. Signed by the SIBLING key so the own-claim filter cannot be what produces the halt.",
  },
  "02-watched-edit-on-unrelated-path": {
    claims: [{ by: "sibling", content: { path: "src/lib/foo.js" } }],
    why: "the SAME sibling claim as 01 is present; only the target moves to docs/unrelated/. A silent pass here is therefore attributable to the RELATION (INDEPENDENT), not to an empty log.",
  },
  "03-watched-write-on-workspace": {
    claims: [{ by: "sibling", content: { workspace: "alpha" } }],
    why: '_setup: "assumes an active workspace-scoped claim on workspace=\\"alpha\\"" — a claim carrying NO path, only `workspace`, so the halt can only come from §4.1 SAME axis (b) `_matchContainer`.',
  },
  "04-watched-write-on-non-cwd-path": {
    claims: [{ by: "sibling", content: { path: "src/lib/foo.js" } }],
    why: "sibling claim present as in 01; the target is /tmp/... so repoRelative returns null and the guard passes through BEFORE any relation evaluation.",
  },
  "05-non-watched-tool-noop": {
    claims: [{ by: "sibling", content: { path: "src/lib/foo.js" } }],
    why: "sibling claim on the exact target path — the state that makes 01 HALT. Only the tool differs (Read), so a silent pass isolates isWatchedTool.",
  },
  "06-structural-null-malformed-log": {
    raw: true,
    // The fixture's own `stderr:` line is a DISJUNCTION — "(empty OR [ADVISORY]
    // adjacency-leasecheck internal error: ...)". Both are non-halting; pinning
    // either arm would red a fixture that is internally consistent.
    permittedTags: ["(none)", "[ADVISORY]"],
    why: "stdin is the fixture's literal malformed byte string `{ this is not json` — NOT re-serialized JSON. cc-artifacts.md Rule 7: malformed input MUST NOT halt the agent.",
  },
  "07-filesystem-exception-positive": {
    why: "_env_overrides.COC_PORCELAIN_OVERRIDE names the EXACT candidate path. Deliberately staged with NO sibling claim, so the halt can only come from the §4.2 structural branch — a §4.1 SAME fallthrough is unavailable.",
  },
  "08-filesystem-exception-negative": {
    claims: [{ by: "sibling", content: { path: "src/lib/other.js" } }],
    why: "_env_overrides.COC_PORCELAIN_OVERRIDE names a SIBLING file in the same dir but NOT the candidate, plus an active sibling claim on that file → §4.2 must NOT fire and the pair falls through to the §4.1 ADJACENT `same-dir` advisory.",
  },
  "09-self-claim-no-self-conflict": {
    claims: [{ by: "self", content: { path: "src/lib/foo.js" } }],
    why: '_note: "Active claim record in the log has verified_id == self". Byte-identical claim CONTENT to fixture 01; only the signing key moves, so a silent pass isolates projectActiveSiblingClaims\' own-claim exclusion.',
  },
};

const SELF = { person_id: "p-self", display_id: "self" };
const SIB = { person_id: "p-sibling", display_id: "sibling" };

function makeWorld(label, opts = {}) {
  const repoDir = mkRepo(label, opts);
  const selfKey = mkKey(`${label}-self`);
  const sibKey = mkKey(`${label}-sib`);
  writeRoster(repoDir, {
    genesis: {
      repo_owner: "test-owner",
      repo_owner_kind: "user",
      root_commit: "deadbeef",
      genesis_generation: 1,
    },
    persons: {
      [SELF.person_id]: {
        display_id: SELF.display_id,
        role: "owner",
        github_login: "self-login",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint: selfKey.fingerprint, pubkey: selfKey.pubKey }],
      },
      [SIB.person_id]: {
        display_id: SIB.display_id,
        role: "contributor",
        github_login: "sib-login",
        host_role: "human",
        keys: [{ type: "ssh", fingerprint: sibKey.fingerprint, pubkey: sibKey.pubKey }],
      },
    },
  });
  writeLog(repoDir, []);
  return { repoDir, selfKey, sibKey };
}

/**
 * A REAL signed `claim` record. `ts` is NOW, never a frozen date: rule-7 liveness
 * is heartbeat-TTL-based, so a fixed timestamp would make the fixture start
 * passing-for-the-wrong-reason on a calendar roll rather than on a code change.
 */
function claimRecord(w, { by, content }, i = 0) {
  const who = by === "self" ? SELF : SIB;
  const key = by === "self" ? w.selfKey : w.sibKey;
  return signRecord(
    REPO,
    {
      type: "claim",
      verified_id: key.fingerprint,
      person_id: who.person_id,
      display_id: who.display_id,
      seq: i,
      prev_hash: null,
      ts: new Date().toISOString(),
      content: { claim_id: `afx-${by}-${i}`, ...content },
    },
    key.keyPath,
  );
}

function seedClaims(w, claims) {
  writeLog(w.repoDir, (claims || []).map((c, i) => claimRecord(w, c, i)));
}

function envFor(w, porcelain) {
  return {
    COC_OPERATOR_KEY_PATH: w.selfKey.keyPath,
    // ALWAYS set — see the header note. Empty string = "no sibling porcelain
    // state", which the guard treats as authoritative and which stops the
    // production `git worktree list` primitive from reading ambient state.
    COC_PORCELAIN_OVERRIDE: porcelain || "",
  };
}

function stage(name, setup, c) {
  const w = makeWorld(name.slice(0, 2));
  seedClaims(w, setup.claims);
  if (setup.raw) {
    // Drive the fixture's LITERAL bytes. Re-serializing would repair the very
    // malformation the fixture exists to exercise.
    return { repoDir: w.repoDir, stdinRaw: c.rawInput, env: envFor(w) };
  }
  const payload = {
    session_id: "adjacency-leasecheck-audit-fixtures",
    hook_event_name: c.input.hook_event_name,
    tool_name: c.input.tool_name,
    tool_input: {},
    cwd: w.repoDir,
  };
  for (const [k, v] of Object.entries(c.input.tool_input || {})) {
    payload.tool_input[k] = typeof v === "string" ? v.replace(/<repo>/g, w.repoDir) : v;
  }
  const porcelain = (c.input._env_overrides || {}).COC_PORCELAIN_OVERRIDE;
  const cite =
    name === "01-watched-edit-on-claimed-path"
      ? ["§4.1 SAME predicate", "Predicate: exact"]
      : name === "03-watched-write-on-workspace"
        ? ["§4.1 SAME predicate", "Predicate: workspace"]
        : name === "07-filesystem-exception-positive"
          ? ["§4.2 filesystem exception"]
          : name === "08-filesystem-exception-negative"
            ? ["§4.1 ADJACENT predicate", "same-dir"]
            : null;
  return {
    repoDir: w.repoDir,
    stdinRaw: JSON.stringify(payload),
    env: envFor(w, porcelain),
    bodyMustCite: cite,
  };
}

runDispositionSuite({ suiteDir: HERE, hook: HOOK, fixtures: FIXTURES, setups: SETUPS, stage }, check);

// ---- T4: PAIRED CONTROLS ------------------------------------------------------
console.log("\n=== T4: paired controls — flip one setup element, require the verdict to move ===");

function drive(w, payload, porcelain) {
  return driveHook(HOOK, {
    stdinRaw: JSON.stringify(payload),
    cwd: w.repoDir,
    env: envFor(w, porcelain),
  });
}

function editPayload(w, rel) {
  return {
    session_id: "alc-control",
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: rel },
    cwd: w.repoDir,
  };
}

{
  // C1 — 01's HALT is attributable to the CLAIM's PRESENCE. Same payload, same
  // repo; only the log content moves.
  const w = makeWorld("c1");
  const payload = editPayload(w, "src/lib/foo.js");
  writeLog(w.repoDir, []);
  const none = drive(w, payload);
  seedClaims(w, [{ by: "sibling", content: { path: "src/lib/foo.js" } }]);
  const claimed = drive(w, payload);
  check(
    "C1: same Edit on src/lib/foo.js — log EMPTY ⇒ silent / active sibling claim ⇒ HALT",
    none.code === 0 &&
      none.tag === "(none)" &&
      claimed.tag === "[HALT-AND-REPORT]" &&
      claimed.combined.includes("§4.1 SAME predicate"),
    `empty-log: exit=${none.code} tag=${none.tag} | claimed: exit=${claimed.code} tag=${claimed.tag}`,
    "identical dispositions = the fold→projectActiveSiblingClaims→sameReason chain carries no information. Silent on BOTH means every SAME-class collision ships unsurfaced; halting on BOTH means every Edit in a clean repo halts.",
  );
}

{
  // C2 — 09's PASS is attributable to the OWN-CLAIM FILTER. Byte-identical claim
  // CONTENT on both arms; only the signing key (and hence verified_id) moves.
  const w = makeWorld("c2");
  const payload = editPayload(w, "src/lib/foo.js");
  seedClaims(w, [{ by: "self", content: { path: "src/lib/foo.js" } }]);
  const own = drive(w, payload);
  seedClaims(w, [{ by: "sibling", content: { path: "src/lib/foo.js" } }]);
  const theirs = drive(w, payload);
  check(
    "C2: identical claim content on src/lib/foo.js — signed by SELF ⇒ silent / by SIBLING ⇒ HALT",
    own.code === 0 && own.tag === "(none)" && theirs.tag === "[HALT-AND-REPORT]",
    `self-signed: exit=${own.code} tag=${own.tag} | sibling-signed: exit=${theirs.code} tag=${theirs.tag}`,
    "identical dispositions = the `verified_id === selfVerifiedId` exclusion is dead. Halting on the SELF arm makes an operator halt against their own claim on every subsequent edit; passing on the SIBLING arm removes the cross-operator surface entirely.",
  );
}

{
  // C3 — 07's HALT is attributable to the PORCELAIN MATCH, with no claim anywhere
  // in the log. Both arms take the override branch; only the LIST content moves.
  const w = makeWorld("c3");
  const payload = editPayload(w, "src/lib/foo.js");
  const clean = drive(w, payload, "");
  const dirty = drive(w, payload, "src/lib/foo.js");
  check(
    "C3: empty log, same Edit — porcelain list EMPTY ⇒ silent / naming the exact path ⇒ HALT citing §4.2",
    clean.code === 0 &&
      clean.tag === "(none)" &&
      dirty.tag === "[HALT-AND-REPORT]" &&
      dirty.combined.includes("§4.2 filesystem exception"),
    `empty: exit=${clean.code} tag=${clean.tag} | match: exit=${dirty.code} tag=${dirty.tag}`,
    "identical dispositions = the §4.2 branch is unreachable or unconditional. It is the ONLY branch that fires with no registry record at all, so if it is dead, cross-worktree contention on an unclaimed path goes entirely unsurfaced — this guard's whole reason to exist in a parallel run.",
  );
}

{
  // C4 — 08 pins the EXACT-MATCH discipline of §4.2: it MUST NOT generalize to
  // "any porcelain activity in the dir halts". Same repo, same sibling claim on
  // src/lib/other.js; only WHICH path the porcelain list names moves.
  const w = makeWorld("c4");
  seedClaims(w, [{ by: "sibling", content: { path: "src/lib/other.js" } }]);
  const payload = editPayload(w, "src/lib/foo.js");
  const sameDir = drive(w, payload, "src/lib/other.js");
  const exact = drive(w, payload, "src/lib/foo.js");
  check(
    "C4: sibling claim on src/lib/other.js — porcelain names other.js ⇒ [ADVISORY] (§4.1 ADJACENT) / names foo.js ⇒ [HALT-AND-REPORT] (§4.2)",
    sameDir.tag === "[ADVISORY]" &&
      sameDir.combined.includes("same-dir") &&
      exact.tag === "[HALT-AND-REPORT]" &&
      exact.combined.includes("§4.2 filesystem exception"),
    `same-dir: tag=${sameDir.tag} | exact: tag=${exact.tag}`,
    "a HALT on the same-dir arm = §4.2 over-generalized to directory granularity and every edit near a sibling's uncommitted file over-halts the operator; an ADVISORY on the exact arm = the structural cross-worktree signal was demoted to the same severity as mere proximity.",
  );
}

{
  // C5 — 05's PASS is attributable to the TOOL. Same repo, same claimed target;
  // only tool_name crosses the mutation-tool boundary.
  const w = makeWorld("c5");
  seedClaims(w, [{ by: "sibling", content: { path: "src/lib/foo.js" } }]);
  const base = { session_id: "alc-c5", hook_event_name: "PreToolUse", cwd: w.repoDir };
  const read = drive(w, { ...base, tool_name: "Read", tool_input: { file_path: "src/lib/foo.js" } });
  const edit = drive(w, { ...base, tool_name: "Edit", tool_input: { file_path: "src/lib/foo.js" } });
  check(
    "C5: same claimed path — Read ⇒ silent / Edit ⇒ HALT",
    read.code === 0 && read.tag === "(none)" && edit.tag === "[HALT-AND-REPORT]",
    `Read: exit=${read.code} tag=${read.tag} | Edit: exit=${edit.code} tag=${edit.tag}`,
    "identical dispositions = isWatchedTool is not scoping. Halting on Read makes every inspection of a contended file a halt; passing on Edit removes the fence from the tool class that actually mutates.",
  );
}

{
  // C6 — 04's PASS is attributable to the path leaving the repo. Same Edit, same
  // active sibling claim; only the target crosses the boundary.
  const w = makeWorld("c6");
  seedClaims(w, [{ by: "sibling", content: { path: "src/lib/foo.js" } }]);
  const outside = drive(w, editPayload(w, "/tmp/some-unrelated-file.txt"));
  const inside = drive(w, editPayload(w, "src/lib/foo.js"));
  check(
    "C6: active sibling claim throughout — /tmp/... ⇒ silent / src/lib/foo.js ⇒ HALT",
    outside.code === 0 && outside.tag === "(none)" && inside.tag === "[HALT-AND-REPORT]",
    `outside: exit=${outside.code} tag=${outside.tag} | inside: exit=${inside.code} tag=${inside.tag}`,
    "identical dispositions = repoRelative is not scoping. Halting on the OUTSIDE arm surfaces sibling contention for files the repo has no claim over; passing on the INSIDE arm is the contention going unsurfaced.",
  );
}

{
  // C7 — the opt-in gate is load-bearing. The SAME state that HALTS on an enrolled
  // repo must pass SILENTLY on an un-enrolled one; without this row, every halt
  // above is consistent with a guard that ignores the gate and taxes solo repos
  // running several of their OWN worktrees (the MO-OPT W1 disruption).
  // Un-enrolled means BOTH: no roster AND no tier-2 override. Asymmetric
  // precedence REFUSES {enabled:false} on an enrolled repo, and a two-human
  // roster alone resolves tier 4 ON (measured — dropping only the override left
  // this row halting), so the roster must go too.
  const repoDir = mkRepo("c7", { coordinationForceOn: false });
  const w = { repoDir, selfKey: mkKey("c7-self") };
  const payload = editPayload(w, "src/lib/foo.js");
  const off = drive(w, payload, "src/lib/foo.js");
  check(
    "C7: coordination OFF (no tier-2 override) + exact porcelain match ⇒ SILENT passthrough, not a §4.2 halt",
    off.code === 0 && off.json?.continue === true && off.tag === "(none)",
    `exit=${off.code} continue=${off.json?.continue} tag=${off.tag}`,
    "a halt here = the opt-in gate stopped gating and a solo dev running two of their own worktrees is halted on every shared file. WITHOUT the tag leg this row cannot discriminate: halt-and-report is exit 0 / continue:true and would read as a silent pass.",
  );
}

cleanup();
finish();
