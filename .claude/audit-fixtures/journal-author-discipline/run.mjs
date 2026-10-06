#!/usr/bin/env node
/**
 * journal-author-discipline — fixture runner (F51 residue; loom#2044 Group A).
 *
 * Four fixtures, four backing statuses, ONE branch: the F101-3 `checkAuthorBacking`
 * call inside `.claude/hooks/journal-write-guard.js` (predicate implemented in
 * `.claude/hooks/lib/provenance-author-backing.js`). FAMILY A (disposition) —
 * driven through the shared `runDispositionSuite` in ../hook-fixture-runner.mjs.
 *
 * WHAT WAS UNEXECUTED. This directory held four `input.json` + `expected.txt`
 * pairs and no `run.mjs`, so it sat outside run-audit-fixtures.mjs's closure.
 * `.claude/test-harness/tests/provenance-author-backing.test.mjs` unit-tests the
 * PREDICATE; nothing drove these fixtures END-TO-END through the hook, which is
 * where the severity is decided (halt-and-report, NEVER block).
 *
 * REACHING THE BRANCH IS ITSELF A PRECONDITION. `checkAuthorBacking` runs ONLY on
 * the self-reserved passthrough path — an unreserved slot halts one layer earlier
 * for a DIFFERENT reason and would look identical on severity alone. So every
 * fixture here is staged with a real signed `journal-slot-reservation` for its own
 * slot, and every halting row additionally asserts the body cites
 * `journal-author-discipline` rather than the slot fence.
 *
 * LEDGER MATERIALIZATION. The per-session ledger path is produced by
 * `provenance-ledger.js::_ledgerPath`; this runner CALLS that producer rather than
 * re-deriving the sanitize+sha8 scheme, so a fixture can never fail because the
 * harness and the hook disagreed about where the file goes. Stated plainly as a
 * BOUND (rules/instrument-discipline.md MUST-4): this makes the runner blind to a
 * regression in `_ledgerPath` ITSELF — both sides would move together. What it
 * does discriminate is everything downstream of the path: presence vs absence
 * (04 vs 01), event-kind counting (02 vs 01), and the agent-branch short-circuit
 * (03), each pinned by a paired control in T4.
 *
 *   node .claude/audit-fixtures/journal-author-discipline/run.mjs
 *   HOOK=/abs/path/to/mutant.js node .../run.mjs     # red it against a mutant
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  makeReporter,
  mkKey,
  mkRepo,
  writeRoster,
  writeLog,
  signRecord,
  driveHook,
  ensureParent,
  cleanup,
  runDispositionSuite,
} from "../hook-fixture-runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = process.env.HOOK || path.join(REPO, ".claude/hooks/journal-write-guard.js");
const require_ = createRequire(import.meta.url);
const { _ledgerPath } = require_(path.join(REPO, ".claude/hooks/lib/provenance-ledger.js"));

const { check, finish } = makeReporter();

const FIXTURES = [
  "01-backed-human",
  "02-unbacked-human",
  "03-agent-na",
  "04-undetermined-no-ledger",
];

// The fixtures' session ids are PLACEHOLDER tokens ("<session-with-humaninput-in-
// ledger>"); each is bound to a concrete id here and the ledger is staged to match
// the state the token NAMES.
const SESSIONS = {
  "01-backed-human": { id: "afx-session-backed", ledger: ["HumanInput"] },
  "02-unbacked-human": { id: "afx-session-unbacked", ledger: [] },
  "03-agent-na": { id: "afx-session-any", ledger: [] },
  "04-undetermined-no-ledger": { id: "afx-session-no-ledger", ledger: null },
};

const SETUPS = {
  "01-backed-human": {
    slot: "0042",
    why: 'author=human + a live per-session ledger carrying ≥1 HumanInput event in the chain-adjacency window. Slot 0042 is SELF-reserved so the guard reaches the F101-3 branch at all.',
  },
  "02-unbacked-human": {
    slot: "0043",
    why: "author=human + a ledger that EXISTS and holds ZERO HumanInput events — the discriminator against 04, whose ledger is absent. Slot 0043 SELF-reserved.",
  },
  "03-agent-na": {
    slot: "0044",
    why: 'author=agent → the ledger is not even read (MUST-2: renders "n/a — agent-surfaced", never "BACKED by human input"). Deliberately staged with an EMPTY ledger — the same state that makes 02 halt — so the pass is attributable to the AUTHOR value alone.',
  },
  "04-undetermined-no-ledger": {
    slot: "0045",
    why: "author=co-authored + NO per-session ledger on disk (capture degraded or never ran) → undetermined. Slot 0045 SELF-reserved so the halt cannot be the slot fence.",
  },
};

const SELF = { person_id: "p-self", display_id: "someoperator" };

function makeWorld(label) {
  const repoDir = mkRepo(label);
  const selfKey = mkKey(`${label}-self`);
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
    },
  });
  writeLog(repoDir, []);
  return { repoDir, selfKey };
}

function reserveSelf(w, slot) {
  writeLog(w.repoDir, [
    signRecord(
      REPO,
      {
        type: "journal-slot-reservation",
        verified_id: w.selfKey.fingerprint,
        person_id: SELF.person_id,
        display_id: SELF.display_id,
        seq: 0,
        prev_hash: null,
        ts: new Date().toISOString(),
        content: { slot, dir: "journal" },
      },
      w.selfKey.keyPath,
    ),
  ]);
}

/** kinds === null ⇒ write NO ledger file at all (the `undetermined` state). */
function stageLedger(w, session, kinds) {
  if (kinds === null) return;
  const p = _ledgerPath(w.repoDir, session);
  ensureParent(p);
  fs.writeFileSync(p, kinds.map((k) => JSON.stringify({ kind: k })).join("\n") + (kinds.length ? "\n" : ""));
}

function envFor(w) {
  return { COC_OPERATOR_KEY_PATH: w.selfKey.keyPath };
}

function stage(name, setup, c) {
  const w = makeWorld(name.slice(0, 2));
  reserveSelf(w, setup.slot);
  const s = SESSIONS[name];
  stageLedger(w, s.id, s.ledger);
  const payload = {
    session_id: s.id,
    hook_event_name: c.input.hook_event_name,
    tool_name: c.input.tool_name,
    tool_input: {},
    cwd: w.repoDir,
  };
  for (const [k, v] of Object.entries(c.input.tool_input || {})) {
    payload.tool_input[k] =
      typeof v === "string" ? v.replace(/<repo>/g, w.repoDir).replace(/<[^>]*session[^>]*>/g, s.id) : v;
  }
  ensureParent(payload.tool_input.file_path);
  const halting = name === "02-unbacked-human" || name === "04-undetermined-no-ledger";
  return {
    repoDir: w.repoDir,
    stdinRaw: JSON.stringify(payload),
    env: envFor(w),
    // The severity alone cannot tell the AUTHOR branch from the SLOT branch —
    // both are halt-and-report on this hook. The rule id is the discriminator.
    bodyMustCite: halting
      ? ["journal-author-discipline", name === "02-unbacked-human" ? "UNBACKED" : "UNDETERMINED"]
      : null,
  };
}

runDispositionSuite({ suiteDir: HERE, hook: HOOK, fixtures: FIXTURES, setups: SETUPS, stage }, check);

// ---- T4: PAIRED CONTROLS ------------------------------------------------------
console.log("\n=== T4: paired controls — flip one setup element, require the verdict to move ===");

function drive(w, payload) {
  return driveHook(HOOK, { stdinRaw: JSON.stringify(payload), cwd: w.repoDir, env: envFor(w) });
}

/**
 * A frontmatter block that SATISFIES the canonical shape contract
 * (`rules/journal.md` § Naming & Format), with `author:` left as the ONE hole
 * the controls below fill.
 *
 * WHY IT EXISTS. Every control payload here used to carry a hand-rolled block
 * (`type`/`date`/`author`/`session_id`/`topic`) chosen when NO layer in this
 * guard read content beyond `author:`. The guard now runs a second, independent
 * obligation over the same bytes — `lib/journal-frontmatter-shape.js`, rule_id
 * `journal/frontmatter-shape`, severity advisory — and against IT that block is
 * a genuine violation: six required keys absent (`project`, `phase`,
 * `verified_id`, `person_id`, `display_id`, `tags`) and `session_id:` RETIRED.
 * So a payload asserting "silent passthrough" had quietly become a COMPOUND
 * assertion that BOTH layers are quiet, which is not what any row here is about.
 *
 * Restoring the block to contract-conformance returns each control to flipping
 * exactly ONE element — the ledger's event count (C1), the author word (C2), the
 * ledger's existence (C3), the slot reservation (C4) — which is the property
 * that makes them controls at all. NOTHING is relaxed: every authorship verdict
 * below (passthrough vs HALT, and the UNBACKED / UNDETERMINED / rule-id
 * discriminators) is asserted exactly as before.
 *
 * `person_id` / `display_id` deliberately match SELF, and `verified_id` is
 * self-evidently a fixture value: the shape layer checks these keys are PRESENT
 * and NON-EMPTY and never reads their content (its header records that
 * `author:` VALUE membership belongs to journal-author-discipline and that
 * unknown keys are not a finding), so no verdict here turns on what they say.
 *
 * NOT imported from `../journal-write-guard/run.mjs`, which defines its own
 * `SHAPE_CLEAN_FM`: that one pins `author: agent` for its own reasons, and a
 * cross-suite import would couple two fixture corpora that must be able to move
 * independently.
 */
const SHAPE_CLEAN_FM_KEYS = [
  "project: loom",
  "topic: control",
  "phase: codify",
  "verified_id: SHA256:fixture-not-a-real-key",
  `person_id: ${SELF.person_id}`,
  `display_id: ${SELF.display_id}`,
  "tags: []",
].join("\n");

function writePayload(w, session, slot, author) {
  const p = path.join(w.repoDir, `journal/${slot}-someoperator-DECISION-control.md`);
  ensureParent(p);
  return {
    session_id: session,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: p,
      content: `---\ntype: DECISION\ndate: 2026-06-01\nauthor: ${author}\n${SHAPE_CLEAN_FM_KEYS}\n---\n\nbody\n`,
    },
    cwd: w.repoDir,
  };
}

{
  // C1 — 01's PASS is attributable to the HumanInput EVENT, not merely to the
  // ledger file existing. Same repo, same payload, same ledger PATH; only the
  // event line inside it moves.
  const w = makeWorld("c1");
  reserveSelf(w, "0050");
  const payload = writePayload(w, "afx-c1", "0050", "human");
  stageLedger(w, "afx-c1", ["HumanInput"]);
  const backed = drive(w, payload);
  stageLedger(w, "afx-c1", []);
  const unbacked = drive(w, payload);
  check(
    "C1: same ledger file — one HumanInput event ⇒ passthrough / zero events ⇒ HALT",
    backed.code === 0 &&
      backed.tag === "(none)" &&
      unbacked.tag === "[HALT-AND-REPORT]" &&
      unbacked.combined.includes("UNBACKED"),
    `with-event: exit=${backed.code} tag=${backed.tag} | empty: exit=${unbacked.code} tag=${unbacked.tag}`,
    "identical dispositions = the HumanInput count is not read, and `author: human` becomes self-certifying — exactly the trusted-not-verifiable claim F101-3 exists to refuse. Passing on BOTH also makes fixture 02 green against a guard that never opens the ledger.",
  );
}

{
  // C2 — 03's PASS is attributable to the AUTHOR VALUE. Same repo, same empty
  // ledger (the state that makes `human` halt); only the frontmatter word moves.
  const w = makeWorld("c2");
  reserveSelf(w, "0051");
  stageLedger(w, "afx-c2", []);
  const agent = drive(w, writePayload(w, "afx-c2", "0051", "agent"));
  const human = drive(w, writePayload(w, "afx-c2", "0051", "human"));
  check(
    "C2: same empty ledger — author:agent ⇒ passthrough / author:human ⇒ HALT",
    agent.code === 0 && agent.tag === "(none)" && human.tag === "[HALT-AND-REPORT]",
    `agent: exit=${agent.code} tag=${agent.tag} | human: exit=${human.code} tag=${human.tag}`,
    "identical dispositions = the agent short-circuit is gone. Halting on the AGENT arm demands human-input backing for an entry that makes no human claim; passing on the HUMAN arm is the unbacked claim shipping unremarked.",
  );
}

{
  // C3 — 04's HALT is attributable to LEDGER ABSENCE, and `undetermined` is a
  // DISTINCT status from `unbacked`. Same co-authored payload; only the file's
  // existence moves.
  const w = makeWorld("c3");
  reserveSelf(w, "0052");
  const payload = writePayload(w, "afx-c3", "0052", "co-authored");
  const absent = drive(w, payload);
  stageLedger(w, "afx-c3", ["HumanInput"]);
  const present = drive(w, payload);
  check(
    "C3: co-authored — NO ledger ⇒ HALT citing UNDETERMINED / ledger with a HumanInput ⇒ passthrough",
    absent.tag === "[HALT-AND-REPORT]" &&
      absent.combined.includes("UNDETERMINED") &&
      present.code === 0 &&
      present.tag === "(none)",
    `absent: exit=${absent.code} tag=${absent.tag} | present: exit=${present.code} tag=${present.tag}`,
    "a pass on the ABSENT arm = a missing ledger reads as a clean result, which is the silent fail-open MUST-3 names; an UNBACKED label there would conflate degraded capture with a false claim, and the two carry different remediations.",
  );
}

{
  // C4 — the whole F101-3 branch sits BEHIND the self-reservation gate. Without
  // this row, 01's and 03's passes are consistent with a guard whose author check
  // never runs, and 02's halt is consistent with the SLOT fence firing instead.
  const w = makeWorld("c4");
  stageLedger(w, "afx-c4", []);
  const payload = writePayload(w, "afx-c4", "0053", "human");
  const unreserved = drive(w, payload);
  reserveSelf(w, "0053");
  const reserved = drive(w, payload);
  check(
    "C4: author:human on an empty ledger — slot UNRESERVED ⇒ halts on the SLOT fence / slot SELF-RESERVED ⇒ halts on the AUTHOR fence",
    unreserved.tag === "[HALT-AND-REPORT]" &&
      unreserved.combined.includes("UNRESERVED") &&
      !unreserved.combined.includes("journal-author-discipline") &&
      reserved.tag === "[HALT-AND-REPORT]" &&
      reserved.combined.includes("journal-author-discipline"),
    `unreserved: tag=${unreserved.tag} | reserved: tag=${reserved.tag}`,
    "both bodies naming the same fence = severity alone cannot tell which branch fired, and every author-discipline row above would be satisfiable by the slot fence it sits behind — the fallthrough that lets a deleted F101-3 branch pass a severity-only assertion.",
  );
}

cleanup();
finish();
