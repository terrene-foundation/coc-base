#!/usr/bin/env node
/**
 * todo-tracker fixtures — BIPOLAR BY PAIR, and the pairing is the assertion.
 *
 * `instrument-bipolarity.md` MUST-1: pole pairs are run by the SAME harness, which
 * ASSERTS THE VERDICTS DIFFER. Identical verdicts is a VACUOUS pair and MUST FAIL —
 * a pair whose two poles agree has measured nothing, however green it prints. So
 * every `pair()` below runs both poles and fails on agreement, not just on a wrong
 * value.
 *
 * MUST-2: every RED pole names a failure IDENTITY — the `rule_id`, WHICH criterion,
 * and the todo or row it fired on — never merely a non-zero exit or a count. That is
 * asserted here rather than assumed, because this hook does NOT exit non-zero at any
 * severity (it is `halt-and-report` at `PostToolUse`, so exit 0 and `continue:true`
 * are its verdicts). The exit code carries NO information about this instrument, and
 * a fixture keyed on it would pass identically for every pole.
 *
 * ── MUTATION PROOF, AND WHY IT IS NOT OPTIONAL ────────────────────────────────
 *
 * `instrument-discipline.md` MUST-2(b): a mutation that does not RED the test leaves
 * TWO live hypotheses — vacuous test, OR inert mutation — so a non-reddening mutation
 * is UNRESOLVED, never "proven vacuous". This runner therefore does not merely apply
 * a mutation and look for red; it proves the mutation REACHED the code by asserting a
 * NAMED pole's verdict FLIPS under it. A verdict flip is only producible by code that
 * ran.
 *
 *   TODO_TRACKER_FIXTURE_MUTANT=always-passthrough   every finding path silenced
 *   TODO_TRACKER_FIXTURE_MUTANT=always-halt          every path emits halt-and-report
 *   TODO_TRACKER_FIXTURE_MUTANT=id-includes-status   the join key moves with status
 *   TODO_TRACKER_FIXTURE_MUTANT=restore-upsert       the tracker write comes BACK
 *   TODO_TRACKER_FIXTURE_MUTANT=advance-context-always  the s57 retry fix reverted
 *
 * ── RE-BASELINED FOR THE EVENT LOG (s57), AND WHY THE LAST TWO MUTANTS EXIST ──
 *
 * The producer now APPENDS a signed event instead of upserting a tracker row, so the
 * cases that pinned tracker-row landing were pinning a contract that no longer
 * exists. They were re-baselined onto the event log rather than deleted.
 *
 * A re-baselined fixture is worthless unless something can still make it fail: one
 * that passes against BOTH the old upsert behaviour and the new append behaviour has
 * stopped testing anything. So `restore-upsert` puts the tracker write back and
 * `advance-context-always` reverts the retry fix, and the `rebaseline/*` cases assert
 * each REDS the assertion it defends. Reachability is enforced structurally: a mutant
 * whose substitution matched nothing THROWS rather than silently testing production.
 *
 * Sandboxes that must reach the append path are ENROLLED (`mkRepo({enrolled:true})`)
 * with a per-sandbox generated ed25519 key and a matching roster, because there is no
 * unsigned path to fall back to.
 *
 * Under each, the runner asserts (a) the flip happened at a named pole — the reach
 * proof — and (b) at least one pair went VACUOUS. Run without the env var, the same
 * mutants are applied INTERNALLY as part of the `mutation/*` cases, so CI gets the
 * proof without anyone having to remember to set anything.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS = path.join(REPO_ROOT, ".claude", "hooks");
const GUARD = path.join(HOOKS, "todo-tracker-guard.js");
const LIB = path.join(HOOKS, "lib");

// The generation lineage, read from the LIBRARY rather than copied. `HEALTHY_MANIFEST`
// below declares the sandbox's current generation from this, so a generation roll moves
// the fixture with the library instead of reding it.
const events = require(path.join(LIB, "burndown-events.js"));

// The rendered heads `instruct-and-wait.js` produces per severity. MEASURED against
// that module, not guessed — `severity/register-is-exactly-halt-and-report` below
// re-derives them from the module itself so this constant cannot drift silently.
const HEAD_HALT = "NOT BLOCKED — the action ALREADY RAN. Report it and wait.";
const HEAD_ADVISORY = "ADVISORY — the action proceeded. Acknowledge in next message.";

let pass = 0;
const failures = [];
function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

/**
 * Run BOTH poles and assert they DISAGREE. The whole point: a pair whose poles
 * return the same verdict has demonstrated nothing about the predicate between them.
 */
function pair(name, { red, green, expectRed, expectGreen }) {
  check(`${name}/RED`, () => {
    const v = red();
    return v.verdict === expectRed ? true : `expected ${expectRed}, got ${v.verdict} (${v.head})`;
  });
  check(`${name}/GREEN`, () => {
    const v = green();
    return v.verdict === expectGreen ? true : `expected ${expectGreen}, got ${v.verdict} (${v.head})`;
  });
  check(`${name}/POLES-DIFFER (a vacuous pair measures nothing)`, () => {
    const a = red().verdict;
    const b = green().verdict;
    return a !== b ? true : `both poles returned '${a}' — the pair is VACUOUS and proves nothing`;
  });
}

// ── sandbox construction ─────────────────────────────────────────────────────

/**
 * ENROL the sandbox: a real git repo, a real generated ed25519 key, and a roster
 * whose fingerprint matches it.
 *
 * Needed because the producer now appends a SIGNED event and there is no unsigned
 * path. Without enrolment every sandbox reports the honest UNKNOWN and the
 * "did the event actually LAND" pole is unreachable — which would have quietly
 * deleted the strongest assertion in this suite. The key is generated per-sandbox,
 * so nothing here depends on the machine's own signing configuration.
 *
 * ssh, not gpg, and that is deliberate: MEASURED interleaved on one tree, the same
 * append costs ~14 ms on ssh-ed25519 and ~234 ms on openpgp. An ssh sandbox keeps
 * this suite inside the 45 ms producer budget it exists to pin.
 */
function enrol(d) {
  execFileSync("git", ["init", "-q", "."], { cwd: d });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: d });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: d });
  const key = path.join(d, "fixture-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key, "-C", "fixture"]);
  execFileSync("git", ["config", "user.signingkey", key], { cwd: d });
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${key}.pub`]).toString().split(" ")[1];
  const pubkey = fs.readFileSync(`${key}.pub`, "utf8").trim();
  fs.mkdirSync(path.join(d, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(d, ".claude", "operators.roster.json"),
    JSON.stringify(
      {
        $schema: "operators-roster/v1",
        genesis: {},
        persons: {
          "pid-fixture-0001": { display_id: "fixture", role: "owner", host_role: "owner", keys: [{ type: "ssh", fingerprint, pubkey }] },
        },
      },
      null,
      1,
    ),
  );
  return d;
}

/** The event log the producer now writes, read back as parsed records. */
function eventsIn(d) {
  const p = path.join(d, "burndown", "events.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * The MINIMAL HEALTHY manifest for a sandbox — the one a case starts from when it is
 * not deliberately breaking the manifest.
 *
 * `signature_suite` is part of the minimum, not part of any one case's setup.
 * `appendEvent` resolves it through `signed-log.js::loadSuitePolicy` and REFUSES
 * fail-closed when it is ABSENT — absent never reads as a default (`signed-log.js` §1,
 * D1). A sandbox whose manifest omits it therefore cannot reach ANY append branch, so
 * every "did the event actually LAND" assertion here would measure the refusal instead
 * of the producer. Mirrors the canonical `burndown-manifest.json` block.
 *
 * `ssh-ed25519`, NOT `openpgp`, and the two are not interchangeable: `enrol()` above
 * generates an **ed25519** ssh key, and `decideAppendSuite` REFUSES a signing key whose
 * suite is not the declared one ("signing key suite mismatch"). That refusal is now
 * ALGORITHM-precise, not keyType-precise: the vocabulary carries `ssh-ed25519` AND
 * `ssh-rsa`, both keyType `ssh`, and `suiteForSigningKey` reads the key file to tell
 * them apart. So this declaration is pinned to what `enrol()` actually generates — swap
 * `-t ed25519` for `-t rsa` there without changing this line and the suite fence reds
 * the sandbox, which is the drift this fixture should catch rather than absorb. A
 * plausible-looking bare `"ssh"` is still refused as an unknown suite.
 *
 * `schema` is the CURRENT generation, which `buildEvent` stamps. It is read from
 * `burndown-events.js::SCHEMA` rather than written as a literal: a hardcoded copy is
 * what made FOUR fixtures red on the generation-2 roll at once, each declaring a
 * generation the library had already moved past.
 *
 * NO `prior_generations`: a fresh sandbox log holds only current-generation records, so
 * declaring a closed generation that has no records here would be a declaration about
 * nothing. The field is optional (`resolveSuitePolicy`), and omitting it keeps the
 * sandbox an honest description of its own log.
 */
const HEALTHY_MANIFEST = {
  _schema: "burndown-manifest/v1",
  target: "BURNDOWN.md",
  pages: ["P"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
  tracker: {
    path: ".session-notes.shared.md",
    kind: "forest-ledger",
    anchor_roots: ["workspaces/"],
    min_rows: 0,
  },
  signature_suite: {
    generation: events.SCHEMAS[events.SCHEMA].generation,
    schema: events.SCHEMA,
    suite: "ssh-ed25519",
  },
};

/** A deep copy, so a case that mutates its manifest cannot leak into the next sandbox. */
function healthyManifest() {
  return JSON.parse(JSON.stringify(HEALTHY_MANIFEST));
}

const TMPS = [];
function mkRepo({ ledger, manifest, context, enrolled = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "todo-tracker-fx-"));
  TMPS.push(d);
  if (enrolled) enrol(d);
  fs.writeFileSync(
    path.join(d, "burndown-manifest.json"),
    JSON.stringify(manifest === undefined ? healthyManifest() : manifest, null, 1),
  );
  fs.writeFileSync(
    path.join(d, ".session-notes.shared.md"),
    ledger === undefined
      ? "# notes\n\n| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n"
      : ledger,
  );
  if (context !== undefined) {
    fs.mkdirSync(path.join(d, "workspaces", "todo-tracker"), { recursive: true });
    fs.writeFileSync(path.join(d, "workspaces", "todo-tracker", "todo-context.md"), context);
  }
  return d;
}

function todoPayload(todos) {
  return JSON.stringify({ tool_name: "TodoWrite", tool_input: { todos } });
}

/**
 * Materialise the hook — optionally MUTATED — into its own dir whose `lib/` symlinks
 * the real modules, so a mutation touches exactly one file and every other module is
 * byte-identical to production. A mutant that also had to copy the library would be
 * testing the copy.
 */
function hookPath(mutant) {
  if (!mutant) return GUARD;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "todo-tracker-mut-"));
  TMPS.push(d);
  fs.mkdirSync(path.join(d, "lib"));
  for (const f of fs.readdirSync(LIB)) {
    try {
      fs.symlinkSync(path.join(LIB, f), path.join(d, "lib", f));
    } catch {}
  }
  let src = fs.readFileSync(GUARD, "utf8");
  let libSrc = null;
  if (mutant === "always-passthrough") {
    // Silence every finding path. Reaches the code iff a RED pole goes silent.
    src = src.replace(
      "function emitFinding({ severity, criterion, what_happened, why, agent_must_report }) {",
      "function emitFinding({ severity, criterion, what_happened, why, agent_must_report }) {\n  return passthrough(null); // MUTANT",
    );
  } else if (mutant === "always-halt") {
    // Force a finding on the clean path. Reaches the code iff a GREEN pole goes loud.
    src = src.replace(
      // Anchored on the end of main() — the hook's entry moved into hookMain(), so
      // what follows main() is now the hookMain comment, not a top-level main().catch.
      "  return passthrough(null);\n}\n\n// hookMain",
      '  return emitFinding({ severity: "halt-and-report", criterion: "MUTANT", what_happened: "mutant", why: "mutant", agent_must_report: ["mutant"] });\n}\n\n// hookMain',
    );
  } else if (mutant === "id-includes-status") {
    // Move the join key with status — the exact defect that would append a SECOND
    // row per transition and make `parseLedger` refuse a duplicate id.
    libSrc = fs
      .readFileSync(path.join(LIB, "todo-tracker.js"), "utf8")
      .replace(
        "  const id = deriveTodoId(content);\n  if (!id) return null;\n  const status =",
        "  const status0 = typeof raw.status === 'string' ? raw.status : 'pending';\n  const id = deriveTodoId(content + '::' + status0); // MUTANT\n  if (!id) return null;\n  const status =",
      );
  } else if (mutant === "restore-upsert") {
    // Re-introduce the TRACKER WRITE the event log replaced. This is the mutation
    // that proves the RE-BASELINED chain assertions still discriminate: after the
    // contract change, "the producer does not touch the tracker" is only a real
    // assertion if putting the touch back REDS it.
    src = src.replace(
      "        recorded.push(t);",
      "        try { require('./lib/session-notes-layout.js').upsertForestLedgerRow(PROJECT_DIR, { display_id: 'agent' }, require('./lib/todo-tracker.js').projectRow(t, CONTEXT_REL)); } catch {} // MUTANT\n        recorded.push(t);",
    );
  } else if (mutant === "advance-context-always") {
    // Revert the s57 fix: advance the context artifact for EVERY todo, not only the
    // RECORDED ones. Reds the retry case, because an unrecorded transition then
    // compares equal on the next fire and is swallowed forever.
    src = src.replace(
      "  const next = lib.mergeContext(prev, recorded, nowIso);",
      "  const next = lib.mergeContext(prev, todos, nowIso); // MUTANT",
    );
  } else {
    throw new Error(`unknown mutant ${mutant}`);
  }
  // REACHABILITY, asserted structurally rather than assumed: a `replace` whose needle
  // does not match returns the source UNCHANGED and the "mutant" then silently tests
  // production code, which is the inert-mutation half of the two live hypotheses
  // `instrument-discipline.md` MUST-2(b) names. A no-op substitution is refused here.
  if (libSrc === null && src === fs.readFileSync(GUARD, "utf8")) {
    throw new Error(`mutant '${mutant}' changed NOTHING — its needle did not match; result is UNRESOLVED, not green`);
  }
  if (libSrc !== null) {
    fs.unlinkSync(path.join(d, "lib", "todo-tracker.js"));
    fs.writeFileSync(path.join(d, "lib", "todo-tracker.js"), libSrc);
  }
  fs.writeFileSync(path.join(d, "todo-tracker-guard.js"), src);
  return path.join(d, "todo-tracker-guard.js");
}

/** Run the hook against a sandbox and classify its verdict. */
function runHook(dir, payload, mutant) {
  const r = spawnSync("node", [hookPath(mutant)], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    timeout: 20000,
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || "").trim().split("\n").filter(Boolean).pop());
  } catch {}
  const ctx = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || "";
  const head = ctx.split("\n")[0] || "";
  let verdict = "silent";
  if (head === HEAD_HALT) verdict = "halt-and-report";
  else if (head === HEAD_ADVISORY) verdict = "advisory";
  else if (ctx) verdict = "other";
  if (json === null) verdict = "malformed";
  return { verdict, head, ctx, status: r.status, json, dir };
}

const NEW_TODO = [{ content: "Land the todo tracker producer", status: "in_progress" }];
const NEW_ID = "todo-";

// ── RE-BASELINED FOR THE EVENT LOG (s57) ────────────────────────────────────
//
// The old RED trigger was an AMBIGUOUS LEDGER — a second candidate table, which made
// `parseLedger` refuse to guess and left the tracker row MEASURED absent. That
// trigger is GONE, and not because it stopped working: the producer no longer writes
// the tracker at all, so no property of the ledger can make its write fail. The
// contract it pinned ("a write that could not land is halt-and-report") still holds;
// only the surface moved, so the trigger moves with it.
//
// The new trigger is an ENROLLED sandbox — identity resolves, the signer works —
// carrying a todo whose text OVERFLOWS the event's field bound. The append is then
// genuinely REFUSED by the one path that can refuse it, which is exactly the
// refuse-rather-than-truncate contract C6 is about. Refusing on a REAL overflow,
// rather than on a broken filesystem, keeps the pole pinned to the append contract
// instead of to an environment accident.
const OVERSIZE_TODO = [{ content: `Land the producer ${"x".repeat(600)}`, status: "in_progress" }];

// A context artifact that cannot be READ (its parent path is a regular file). Used
// for the UNKNOWN arm: the producer cannot tell what it previously observed.
function unreadableContextRepo() {
  const d = mkRepo();
  fs.mkdirSync(path.join(d, "workspaces"), { recursive: true });
  fs.writeFileSync(path.join(d, "workspaces", "todo-tracker"), "not a directory\n");
  return d;
}

// ── PAIR 1 — C6: fires on a transition that could NOT be recorded ────────────

pair("C6/unrecorded-vs-recorded", {
  expectRed: "halt-and-report",
  expectGreen: "silent",
  red: () => runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO)),
  green: () => runHook(mkRepo({ enrolled: true }), todoPayload(NEW_TODO)),
});

check("C6/RED lands NOTHING in the log — a refused append never half-writes", () => {
  const d = mkRepo({ enrolled: true });
  const v = runHook(d, todoPayload(OVERSIZE_TODO));
  if (v.verdict !== "halt-and-report") return `expected halt-and-report, got ${v.verdict}`;
  if (eventsIn(d).length !== 0) return "a REFUSED append still wrote a line to the log";
  return true;
});

check("C6/RED names the failure IDENTITY (rule_id + criterion + the surface)", () => {
  const v = runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO));
  const missing = [];
  if (!v.ctx.includes("burndown-traceability/todos-to-index")) missing.push("rule_id");
  if (!v.ctx.includes("C6-refused-append-is-loud")) missing.push("criterion");
  if (!v.ctx.includes("UNRECORDED")) missing.push("what was not recorded");
  return missing.length === 0 ? true : `RED pole does not name: ${missing.join(", ")}`;
});

check("C6/GREEN actually LANDED the EVENT (silence must not be a no-op)", () => {
  const d = mkRepo({ enrolled: true });
  const v = runHook(d, todoPayload(NEW_TODO));
  if (v.verdict !== "silent") return `expected silent, got ${v.verdict} (${v.ctx.slice(0, 200)})`;
  const evs = eventsIn(d);
  if (evs.length !== 1) return `expected exactly 1 appended event, got ${evs.length}`;
  const e = evs[0];
  if (e.kind !== "transition") return `expected kind 'transition', got '${e.kind}'`;
  if (e.weight !== "live") return `expected weight 'live', got '${e.weight}'`;
  if (e.authority !== "agent") return `expected authority 'agent', got '${e.authority}'`;
  if (!e.sig) return "the appended event carries NO signature — the unsigned path must not exist";
  if (!e.verified_id || !e.person_id) return "the appended event is not identity-stamped";
  const ctxFile = path.join(d, "workspaces", "todo-tracker", "todo-context.md");
  if (!fs.existsSync(ctxFile)) return "context artifact was not written";
  // LINK-3 from the other end: the artifact must carry the id VERBATIM.
  if (!fs.readFileSync(ctxFile, "utf8").includes(`### ${e.item_id}`)) return "context artifact does not carry the id verbatim";
  // LINK-2: the anchor must point at that artifact under a declared durable root.
  if (e.value_anchor !== `workspaces/todo-tracker/todo-context.md#${e.item_id}`) {
    return `event anchor does not resolve to the artifact: '${e.value_anchor}'`;
  }
  // The tracker is NO LONGER TOUCHED — the T1/T2/T5 fix, asserted rather than assumed.
  if (fs.readFileSync(path.join(d, ".session-notes.shared.md"), "utf8").includes("| todo-")) {
    return "the producer wrote a tracker row — the upsert was supposed to be gone";
  }
  return true;
});

// ── PAIR 2 — UNKNOWN is not a violation ─────────────────────────────────────
//
// RE-BASELINED: the oversize LEDGER no longer reaches the producer, which stopped
// reading it. The producer DOES still read and still cap the CONTEXT ARTIFACT, and
// that cap exists for the same reason and refuses in the same direction — it stops
// rather than pruning, because pruning would delete the LINK-3 back-reference for
// ids whose rows remain, the originating failure. So the oversize surface moves from
// the ledger to the artifact and the assertion is otherwise unchanged.
const OVERSIZE_CONTEXT = "# ctx\n\n" + "x".repeat(512 * 1024 + 64);

pair("UNKNOWN/unreadable-context-is-advisory-not-violation", {
  expectRed: "advisory",
  expectGreen: "silent",
  red: () => runHook(mkRepo({ context: OVERSIZE_CONTEXT }), todoPayload(NEW_TODO)),
  green: () => runHook(mkRepo({ enrolled: true }), todoPayload(NEW_TODO)),
});

// The OTHER unreadable shape, and the one that was rendering as CLEAN: the artifact
// exists but cannot be stat'd or read at all. Both must reach the same UNKNOWN.
check("UNKNOWN/an UNREADABLE context is surfaced, never a bare passthrough", () => {
  const v = runHook(unreadableContextRepo(), todoPayload(NEW_TODO));
  if (v.verdict === "silent") {
    return "an unreadable context artifact rendered as a CLEAN projection — 'could not read' and 'read it, nothing outstanding' must not render identically";
  }
  if (v.verdict === "halt-and-report") return "an unreadable context was scored as a VIOLATION; UNKNOWN is not a violation";
  if (!v.ctx.includes("C3-unknown-not-clean")) return "the finding does not name its criterion";
  return true;
});

check("UNKNOWN/is NOT scored as halt-and-report, and does NOT claim clean", () => {
  const v = runHook(mkRepo({ context: OVERSIZE_CONTEXT }), todoPayload(NEW_TODO));
  if (v.verdict === "halt-and-report") return "an unreadable context was scored as a VIOLATION; UNKNOWN is not a violation";
  if (v.verdict === "silent") return "an unreadable context rendered as a clean projection — the fabricated-clean failure";
  if (!/UNKNOWN/.test(v.ctx)) return "the finding does not say UNKNOWN";
  if (!v.ctx.includes("C3-unknown-not-clean")) return "the finding does not name its criterion";
  return true;
});

// ── the retry regression (s57) ──────────────────────────────────────────────
//
// A transition whose event could NOT be recorded must be re-detected on the NEXT
// fire. The producer's transition test reads the context artifact, so advancing that
// artifact for an UNRECORDED todo makes the next fire compare equal, drop the todo,
// and report nothing — a refusal that was correctly loud once becomes permanently
// silent, and the event never lands. That is the silent-discard class C6 exists to
// close, re-created by the producer's own bookkeeping.
check("retry/an UNRECORDED transition is re-detected on the NEXT fire, not swallowed", () => {
  // Un-enrolled: no identity, so nothing can be recorded on either fire.
  const d = mkRepo();
  const first = runHook(d, todoPayload(NEW_TODO));
  if (first.verdict === "silent") return "the first fire was silent — it should have reported UNKNOWN";
  const second = runHook(d, todoPayload(NEW_TODO));
  if (second.verdict === "silent") {
    return "the SECOND fire went silent — the unrecorded transition was swallowed by the context artifact";
  }
  if (eventsIn(d).length !== 0) return "an event landed in an un-enrolled repo — there must be no unsigned path";
  return true;
});

check("retry/first_seen IS still stamped for an unrecorded todo (age must not reset)", () => {
  const d = mkRepo();
  runHook(d, todoPayload(NEW_TODO));
  const ctxFile = path.join(d, "workspaces", "todo-tracker", "todo-context.md");
  if (!fs.existsSync(ctxFile)) return "no context artifact — first_seen was never stamped";
  const txt = fs.readFileSync(ctxFile, "utf8");
  const m = txt.match(/- first_seen: (\S+)/);
  if (!m) return "the context artifact carries no first_seen";
  const t1 = m[1];
  runHook(d, todoPayload(NEW_TODO));
  const t2 = (fs.readFileSync(ctxFile, "utf8").match(/- first_seen: (\S+)/) || [])[1];
  return t1 === t2 ? true : `first_seen was RECOMPUTED (${t1} -> ${t2}); age would reset on every failed append`;
});

// ── PAIR 3 — wrong-event fall-through ───────────────────────────────────────

pair("event/TodoWrite-vs-other-tool-on-the-SAME-broken-tree", {
  expectRed: "halt-and-report",
  expectGreen: "silent",
  red: () => runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO)),
  green: () =>
    runHook(
      mkRepo({ enrolled: true }),
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x", content: "y" } }),
    ),
});

check("event/a non-TodoWrite payload produces NOTHING — no row, no context file", () => {
  const d = mkRepo();
  const v = runHook(d, JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x" } }));
  if (v.verdict !== "silent") return `expected silent, got ${v.verdict}`;
  const led = fs.readFileSync(path.join(d, ".session-notes.shared.md"), "utf8");
  if (led.includes("| todo-")) return "a non-TodoWrite payload produced a ledger row";
  if (fs.existsSync(path.join(d, "workspaces", "todo-tracker", "todo-context.md"))) {
    return "a non-TodoWrite payload produced a context artifact";
  }
  return true;
});

check("event/a TodoWrite with NO todos array falls through (null != empty)", () => {
  const d = mkRepo();
  const v = runHook(d, JSON.stringify({ tool_name: "TodoWrite", tool_input: {} }));
  return v.verdict === "silent" && !fs.readFileSync(path.join(d, ".session-notes.shared.md"), "utf8").includes("| todo-")
    ? true
    : `expected a silent no-op, got ${v.verdict}`;
});

// ── PAIR 4 — B4: AGE, not COUNT ─────────────────────────────────────────────

// The id is DERIVED with the producer's own function, never hand-written. A guessed
// hash produced an aged entry the producer never joined, so the pole silently
// measured a FRESH todo and the pair went vacuous — an INERT fixture that printed
// green until the POLES-DIFFER assertion caught it. That is the assertion earning
// its place, and the reason the constant below is a call, not a literal.
const { deriveTodoId } = require(path.join(LIB, "todo-tracker.js"));

function contextWithAge(hoursAgo) {
  const id = deriveTodoId(NEW_TODO[0].content);
  const iso = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return { id, text: `# ctx\n\n### ${id}\n- first_seen: ${iso}\n- status: in_progress\n- todo: ${NEW_TODO[0].content}\n` };
}

function agedRepo(hoursAgo) {
  const c = contextWithAge(hoursAgo);
  // The id must be the one the producer DERIVES, or the aged entry is never joined
  // and the pole silently measures a fresh todo instead — an inert fixture.
  const d = mkRepo({ context: c.text });
  return d;
}

pair("B4/past-bound-vs-fresh", {
  expectRed: "advisory",
  expectGreen: "silent",
  red: () => runHook(agedRepo(30), todoPayload(NEW_TODO)),
  green: () => runHook(agedRepo(1), todoPayload(NEW_TODO)),
});

check("B4/RED reports an AGE DISTRIBUTION and NAMES the rows past bound", () => {
  const v = runHook(agedRepo(30), todoPayload(NEW_TODO));
  const missing = [];
  if (!/p50 .*h, p90 .*h, max .*h/.test(v.ctx)) missing.push("an age distribution (p50/p90/max)");
  if (!/BY NAME/.test(v.ctx)) missing.push("the by-name section");
  if (!new RegExp(`${NEW_ID}[a-z0-9-]+ — \\d`).test(v.ctx)) missing.push("the named row with its age");
  if (!/of \d+ open todo/.test(v.ctx)) missing.push("the denominator");
  if (!v.ctx.includes("B4-age-not-count")) missing.push("the criterion");
  return missing.length === 0 ? true : `a bare count does not satisfy B4; missing: ${missing.join(", ")}`;
});

check("B4/age derives from first_seen, NEVER from mtime", () => {
  // Same first_seen, but the context file's mtime is dragged to NOW. If age were an
  // mtime read the row would look fresh and the finding would vanish — measured.
  const c = contextWithAge(30);
  const d = mkRepo({ context: c.text });
  const f = path.join(d, "workspaces", "todo-tracker", "todo-context.md");
  const now = new Date();
  fs.utimesSync(f, now, now);
  const v = runHook(d, todoPayload(NEW_TODO));
  return v.verdict === "advisory" && /BY NAME/.test(v.ctx)
    ? true
    : `a fresh mtime suppressed the age finding (got ${v.verdict}) — age is being read from mtime`;
});

// ── PAIR 5 — the severity register is EXACTLY halt-and-report ───────────────

check("severity/register-is-exactly-halt-and-report (re-derived from the emitter)", () => {
  // Re-derive both heads from `instruct-and-wait.js` itself so this fixture cannot
  // pass against a stale constant if that module's prose register changes.
  const r = spawnSync(
    "node",
    [
      "-e",
      'const {instructAndWait}=require(process.argv[1]);' +
        'const h=s=>instructAndWait({hookEvent:"PostToolUse",severity:s,what_happened:"w",why:"y",agent_must_report:["a"]})' +
        '.json.hookSpecificOutput.additionalContext.split("\\n")[0];' +
        'console.log(JSON.stringify({halt:h("halt-and-report"),adv:h("advisory")}));',
      path.join(LIB, "instruct-and-wait.js"),
    ],
    { encoding: "utf8" },
  );
  let heads;
  try {
    heads = JSON.parse((r.stdout || "").trim());
  } catch {
    return `could not re-derive the severity heads: ${r.stderr}`;
  }
  if (heads.halt !== HEAD_HALT) return `the halt-and-report head drifted: ${heads.halt}`;
  if (heads.adv !== HEAD_ADVISORY) return `the advisory head drifted: ${heads.adv}`;
  const v = runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO));
  if (v.head !== heads.halt) return `the B1 finding rendered '${v.head}', not the halt-and-report head`;
  if (v.head === heads.adv) return "the B1 finding rendered as ADVISORY — the ratified severity is halt-and-report";
  if (v.json && v.json.continue !== true) return "a halt-and-report must not refuse the call";
  if (v.status !== 0) return `a halt-and-report must exit 0, got ${v.status}`;
  return true;
});

// ── PAIR 6 — fail-open, and the SCOPE control that proves it is not inert ───

pair("scope/manifest-present-vs-absent (the inertness control)", {
  expectRed: "halt-and-report",
  expectGreen: "silent",
  red: () => runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO)),
  green: () => {
    const d = mkRepo({ enrolled: true });
    fs.unlinkSync(path.join(d, "burndown-manifest.json"));
    return runHook(d, todoPayload(NEW_TODO));
  },
});

for (const [label, payload] of [
  ["malformed JSON", "{not json"],
  ["empty stdin", ""],
  ["null tool_input", JSON.stringify({ tool_name: "TodoWrite", tool_input: null })],
  ["todos not an array", JSON.stringify({ tool_name: "TodoWrite", tool_input: { todos: "x" } })],
  ["todo with no content", JSON.stringify({ tool_name: "TodoWrite", tool_input: { todos: [{ status: "pending" }] } })],
]) {
  check(`fail-open/${label} exits 0 and never refuses`, () => {
    const v = runHook(mkRepo(), payload);
    if (v.status !== 0) return `exit ${v.status}`;
    if (v.json && (v.json.continue === false || v.json?.hookSpecificOutput?.permissionDecision === "deny")) return "refused the call";
    return true;
  });
}

check("fail-open/an undeclared tracker path writes NOTHING and says UNKNOWN", () => {
  // ONE variable: the tracker path. Derived from the healthy manifest rather than
  // rebuilt inline, so the case cannot be passing on a SECOND defect — an inline copy
  // that also omitted `signature_suite` would refuse the append for a reason that has
  // nothing to do with the undeclared tracker this case exists to pin.
  const manifest = healthyManifest();
  manifest.tracker.path = "some/other/tracker.md";
  const d = mkRepo({ manifest });
  const v = runHook(d, todoPayload(NEW_TODO));
  if (v.verdict !== "advisory") return `expected an UNKNOWN advisory, got ${v.verdict}`;
  if (fs.readFileSync(path.join(d, ".session-notes.shared.md"), "utf8").includes("| todo-")) {
    return "wrote to a surface the manifest does not declare";
  }
  return true;
});

// ── IDEMPOTENCE — the property that keeps the chain intact ──────────────────

check("idempotence/a re-projection of unchanged state performs NO write", () => {
  const d = mkRepo();
  runHook(d, todoPayload(NEW_TODO));
  const led = path.join(d, ".session-notes.shared.md");
  const before = fs.statSync(led).mtimeMs;
  const bytes = fs.readFileSync(led, "utf8");
  runHook(d, todoPayload(NEW_TODO));
  const after = fs.statSync(led).mtimeMs;
  if (fs.readFileSync(led, "utf8") !== bytes) return "the ledger bytes changed on an unchanged projection";
  if (after !== before) {
    return "the ledger was REWRITTEN on an unchanged projection — the tracker is a declared burndown source, so any write takes the generator UNRUNNABLE";
  }
  return true;
});

// RE-BASELINED: an append-only log does not UPDATE a row, it appends an EVENT — so
// the invariant moves from "one row after three transitions" to "three events that
// FOLD to one row". The property being defended is unchanged and is the same one
// that forced this whole re-architecture: `parseLedger` REFUSES a duplicate id, so
// the join key MUST stay stable across status transitions. Only the surface on which
// the invariant is observed has moved.
check("idempotence/three transitions append THREE events that FOLD to ONE row", () => {
  const d = mkRepo({ enrolled: true });
  runHook(d, todoPayload([{ content: "Land the todo tracker producer", status: "pending" }]));
  runHook(d, todoPayload([{ content: "Land the todo tracker producer", status: "in_progress" }]));
  runHook(d, todoPayload([{ content: "Land the todo tracker producer", status: "completed" }]));
  const evs = eventsIn(d);
  if (evs.length !== 3) return `three transitions appended ${evs.length} event(s), expected 3 — an append-only log records every change`;
  const ids = new Set(evs.map((e) => e.item_id));
  if (ids.size !== 1) {
    return `three transitions produced ${ids.size} distinct item_ids — the join key MOVED with status, and a duplicate id makes burndown-build.mjs::parseLedger REFUSE the whole tracker`;
  }
  const { foldEvents } = require(path.join(LIB, "burndown-events.js"));
  const fold = foldEvents(fs.readFileSync(path.join(d, "burndown", "events.jsonl"), "utf8"));
  if (fold.rows.size !== 1) return `three events folded to ${fold.rows.size} rows, expected 1`;
  if (evs[2].status !== "todo:completed") return `the last event does not carry the final status: '${evs[2].status}'`;
  // LAST WRITE WINS in FILE ORDER — the ordering decision, asserted rather than assumed.
  const row = fold.rows.get([...ids][0]);
  if (row.line !== 3) return `the fold took line ${row.line}, not the LAST line — file order is not deciding the winner`;
  return true;
});

check("idempotence/first_seen is stamped ONCE and never recomputed", () => {
  const d = mkRepo();
  runHook(d, todoPayload([{ content: "Land the todo tracker producer", status: "pending" }]));
  const f = path.join(d, "workspaces", "todo-tracker", "todo-context.md");
  const first = /- first_seen: (\S+)/.exec(fs.readFileSync(f, "utf8"))[1];
  runHook(d, todoPayload([{ content: "Land the todo tracker producer", status: "completed" }]));
  const second = /- first_seen: (\S+)/.exec(fs.readFileSync(f, "utf8"))[1];
  return first === second ? true : `first_seen moved ${first} → ${second}; age would reset on every transition`;
});

check("idempotence/first_seen is UTC (a local read wrote an 8h skew into a ledger)", () => {
  const d = mkRepo();
  runHook(d, todoPayload(NEW_TODO));
  const f = path.join(d, "workspaces", "todo-tracker", "todo-context.md");
  const iso = /- first_seen: (\S+)/.exec(fs.readFileSync(f, "utf8"))[1];
  if (!/Z$/.test(iso)) return `not a UTC instant: ${iso}`;
  const skewH = Math.abs(Date.now() - Date.parse(iso)) / 3_600_000;
  return skewH < 1 ? true : `first_seen is ${skewH.toFixed(1)}h from now — a timezone skew`;
});

// ── MUTATION PROOF ───────────────────────────────────────────────────────────
//
// Each case asserts BOTH halves: the mutation REACHED the code (a named pole's
// verdict flipped) AND the pair it defends went VACUOUS. Asserting only the second
// would leave `instrument-discipline.md` MUST-2(b)'s two hypotheses live.

check("mutation/always-passthrough — reaches the code AND vacuates B1", () => {
  const redBase = runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO)).verdict;
  const redMut = runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO), "always-passthrough").verdict;
  const greenMut = runHook(mkRepo(), todoPayload(NEW_TODO), "always-passthrough").verdict;
  if (redBase !== "halt-and-report") return `baseline RED was ${redBase}; the mutation has nothing to flip`;
  if (redMut === redBase) {
    return `the mutation did NOT change the RED pole (${redMut}) — UNRESOLVED per instrument-discipline MUST-2(b): inert mutation, or vacuous pair, and this cannot tell which`;
  }
  if (redMut !== greenMut) return `poles still differ under the mutation (${redMut} vs ${greenMut}) — B1 is not what this defends`;
  return true;
});

check("mutation/always-halt — reaches the code AND vacuates the GREEN pole", () => {
  // ENROLLED, because the GREEN pole is now "the event LANDED and the producer was
  // silent" — unreachable without identity, since there is no unsigned path.
  const greenBase = runHook(mkRepo({ enrolled: true }), todoPayload(NEW_TODO)).verdict;
  const greenMut = runHook(mkRepo({ enrolled: true }), todoPayload(NEW_TODO), "always-halt").verdict;
  const redMut = runHook(mkRepo({ enrolled: true }), todoPayload(OVERSIZE_TODO), "always-halt").verdict;
  if (greenBase !== "silent") return `baseline GREEN was ${greenBase}; the mutation has nothing to flip`;
  if (greenMut === greenBase) {
    return `the mutation did NOT change the GREEN pole (${greenMut}) — UNRESOLVED, not vacuous`;
  }
  if (redMut !== greenMut) return `poles still differ under the mutation (${redMut} vs ${greenMut})`;
  return true;
});

// RE-BASELINED to the FOLD. The mutation and the property it defends are unchanged —
// a join key that moves with status splits one item into two — but the observation
// moves from "rows in the tracker" to "distinct item_ids in the fold", because the
// producer no longer writes rows. Counting FOLDED ROWS, not raw events, is what keeps
// this discriminating: the append-only log grows by one line per transition under
// BOTH the clean code and the mutant, so a raw line count would read 2 either way and
// the case would have gone permanently green while testing nothing.
check("mutation/id-includes-status — reaches the code AND splits one item into two", () => {
  const { foldEvents } = require(path.join(LIB, "burndown-events.js"));
  const foldedRows = (d) => {
    const p = path.join(d, "burndown", "events.jsonl");
    if (!fs.existsSync(p)) return 0;
    return foldEvents(fs.readFileSync(p, "utf8")).rows.size;
  };
  const two = [
    todoPayload([{ content: "Land the todo tracker producer", status: "pending" }]),
    todoPayload([{ content: "Land the todo tracker producer", status: "completed" }]),
  ];

  const clean = mkRepo({ enrolled: true });
  for (const p of two) runHook(clean, p);
  const cleanRows = foldedRows(clean);

  const mut = mkRepo({ enrolled: true });
  for (const p of two) runHook(mut, p, "id-includes-status");
  const mutRows = foldedRows(mut);

  if (cleanRows !== 1) return `baseline folded to ${cleanRows} rows, expected 1`;
  if (mutRows === cleanRows) {
    return `the mutation did NOT change the folded row count (${mutRows}) — UNRESOLVED: either the join key is not load-bearing, or the mutation never executed`;
  }
  return mutRows === 2 ? true : `expected the mutation to split the item into 2 folded rows, got ${mutRows}`;
});

// ── RE-BASELINE DISCRIMINATION PROOF (s57) ───────────────────────────────────
//
// The two cases below exist because the CONTRACT changed. A fixture re-baselined
// onto a new contract is worthless unless something can still make it fail — a
// fixture that passes against BOTH the old upsert behaviour and the new append
// behaviour has stopped testing anything. These mutants put the OLD behaviour back
// and assert the re-baselined cases RED.

check("rebaseline/restore-upsert REDS the tracker-untouched assertion", () => {
  const ledger =
    "# notes\n\n| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
    "| A1-existing-row | someoperator | x | workspaces/a.md#A1-existing-row | see burndown |\n" +
    "\nSome trailing prose that an EOF append would land after.\n";

  const base = mkRepo({ enrolled: true, ledger });
  runHook(base, todoPayload(NEW_TODO));
  const baseUnchanged = fs.readFileSync(path.join(base, ".session-notes.shared.md"), "utf8") === ledger;

  const mut = mkRepo({ enrolled: true, ledger });
  runHook(mut, todoPayload(NEW_TODO), "restore-upsert");
  const mutUnchanged = fs.readFileSync(path.join(mut, ".session-notes.shared.md"), "utf8") === ledger;

  if (!baseUnchanged) return "baseline already writes the tracker — there is nothing for the mutation to restore";
  if (mutUnchanged) {
    return "restoring the upsert did NOT change the tracker — UNRESOLVED per instrument-discipline MUST-2(b): either the mutation never executed, or the assertion cannot see a tracker write";
  }
  return true;
});

check("rebaseline/advance-context-always REDS the retry assertion", () => {
  // Baseline: an unrecorded transition is re-detected on the second fire.
  const base = mkRepo();
  runHook(base, todoPayload(NEW_TODO));
  const baseSecond = runHook(base, todoPayload(NEW_TODO)).verdict;

  // Mutant: the context advances for every todo, recorded or not.
  const mut = mkRepo();
  runHook(mut, todoPayload(NEW_TODO), "advance-context-always");
  const mutSecond = runHook(mut, todoPayload(NEW_TODO), "advance-context-always").verdict;

  if (baseSecond === "silent") return "baseline second fire was already silent — nothing for the mutation to break";
  if (mutSecond === baseSecond) {
    return `the mutation did NOT change the second fire (${mutSecond}) — UNRESOLVED: either it never executed, or the retry assertion is inert`;
  }
  return mutSecond === "silent"
    ? true
    : `expected the mutant's second fire to go SILENT (the swallow), got ${mutSecond}`;
});

// ── the join key agrees with the GATE that reads it ──────────────────────────

// RE-BASELINED — and this pair is the clearest case of a contract that legitimately
// CHANGED rather than a test that broke.
//
// Both cases pinned a WRITER hazard: a row appended at EOF, or past trailing prose,
// lands OUTSIDE the table the gate's locator reads, so the gate never sees it. That
// hazard is now STRUCTURALLY ELIMINATED, because the producer no longer inserts into
// the table at all. Asserting the old property would be asserting something no code
// can any longer violate — the definition of a decorative fixture.
//
// So the assertion INVERTS: the tracker must come out BYTE-IDENTICAL, and the chain
// must resolve from the EVENT instead. That is discriminating in the way the old one
// was — it fails the moment anything re-introduces a tracker write.
check("chain/the producer leaves the tracker BYTE-IDENTICAL, prose and all", () => {
  const ledger =
    "# notes\n\n| ID | owner | item | value_anchor | status |\n| --- | --- | --- | --- | --- |\n" +
    "| A1-existing-row | someoperator | x | workspaces/a.md#A1-existing-row | see burndown |\n" +
    "\nSome trailing prose that an EOF append would land after.\n";
  const d = mkRepo({ enrolled: true, ledger });
  const before = fs.readFileSync(path.join(d, ".session-notes.shared.md"), "utf8");
  runHook(d, todoPayload(NEW_TODO));
  const after = fs.readFileSync(path.join(d, ".session-notes.shared.md"), "utf8");
  if (after !== before) return "the producer MODIFIED the tracker — the upsert was supposed to be gone (T1/T2/T5)";
  if (eventsIn(d).length !== 1) return `expected the transition to land as 1 event, got ${eventsIn(d).length}`;
  return true;
});

check("chain/the EVENT resolves LINK-2 and LINK-3 the way the gate reads them", () => {
  const d = mkRepo({ enrolled: true });
  runHook(d, todoPayload(NEW_TODO));
  const evs = eventsIn(d);
  if (evs.length !== 1) return `expected 1 event, got ${evs.length}`;
  const e = evs[0];
  // The fold must produce `parseLedger`'s exact row shape, or the projection this
  // log exists to feed cannot be built from it.
  const { foldEvents } = require(path.join(LIB, "burndown-events.js"));
  const row = foldEvents(fs.readFileSync(path.join(d, "burndown", "events.jsonl"), "utf8")).rows.get(e.item_id);
  if (!row) return "the event does not fold back to its own item_id";
  for (const k of ["id", "anchorRaw", "item", "line"]) {
    if (!(k in row)) return `the folded row lacks '${k}' — it is not parseLedger's shape`;
  }
  // LINK-2: the anchor points under a DECLARED durable anchor_root.
  if (!row.anchorRaw.startsWith("workspaces/")) return `the anchor '${row.anchorRaw}' is outside the declared anchor_roots`;
  // LINK-3 from the other end: the artifact carries the id VERBATIM.
  const ctx = fs.readFileSync(path.join(d, "workspaces", "todo-tracker", "todo-context.md"), "utf8");
  if (!ctx.includes(`### ${row.id}`)) return "the context artifact does not carry the id verbatim";
  return true;
});

// ── cleanup ─────────────────────────────────────────────────────────────────

for (const d of TMPS) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {}
}

console.log("");
console.log(`todo-tracker fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
