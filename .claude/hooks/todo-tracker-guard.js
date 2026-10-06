#!/usr/bin/env node
/**
 * todo-tracker-guard.js — the PRODUCER for `todos → index`, the missing half of the
 * `INVENTORY → INDEX → CONTEXT → VIEW` chain `burndown-traceability.md` governs.
 *
 * ── WHAT THIS PRODUCER NOW WRITES, AND WHY IT CHANGED ────────────────────────
 *
 * It APPENDS AN EVENT to `burndown/events.jsonl`. It no longer UPSERTS a row into
 * `.session-notes.shared.md`.
 *
 * The upsert was never a choice. `parseLedger` REFUSES a duplicate row id — a
 * PROJECTION invariant — so an append-only writer could not be the producer for that
 * surface and had to become a read-modify-write. Three consequences followed from
 * that one fact: every write dirtied a file held to `assertCommittedAndUnmodified`,
 * taking `burndown-build.mjs` UNRUNNABLE until someone committed (T1); two clones
 * writing produced a row-keyed 3-way merge of a PROJECTION, which fabricates a state
 * that is the fold of NEITHER branch's log and merges CLEANLY (T2); and the tracker
 * grew toward `session-notes-continuity.md` MUST-3's 300-line ceiling, 97% consumed
 * (T5). An append-only log has none of the three.
 *
 * The event schema, the ordering decision, the genesis/transition distinction and the
 * single signed write path live in `lib/burndown-events.js`.
 *
 * @hook-event: PostToolUse:TodoWrite (guard) — the todo list is the subject, and
 *   `PostToolUse(TodoWrite)` is the ONLY event where it provably EXISTS at fire
 *   time, which is `hook-event-selection.md`'s discrimination test. Every OTHER
 *   enforcement surface in this corpus fires at CLOSE-OUT — `wrapup-after-landing`
 *   on `gh pr merge`, `session-notes-incorporation-guard` on merge/pull/rebase,
 *   `multi-operator-sessionend` at SessionEnd, `fleet-drain-guard` at Stop — and
 *   every one of them fails that test for THIS subject: by close-out the projection
 *   is a reconstruction. `Stop` is wrong for the sibling reason its own guards
 *   record: it fires every turn, including turns with no todo change, so it would
 *   pay for a read on every reply to learn nothing. The matcher is exactly
 *   `TodoWrite` — a `*` matcher would pay a node spawn on every Read/Grep to reach a
 *   passthrough, which `hook-event-selection.md` MUST-3 BLOCKS, and an omitted
 *   matcher is the same thing spelled differently.
 *
 * WHY THIS ONE DOES NOT BLOCK, stated so nobody upgrades it by reflex:
 * the ratified severity is `halt-and-report`. The signal IS structural (a todo id
 * present with no matching ledger row), so `hook-output-discipline.md` MUST-2 would
 * PERMIT `block`. It is refused on that same rule's MUST NOT — blocking work the
 * agent was instructed to perform — and because a todo mid-edit is a legitimate
 * transient state. The mitigation for a scrollable-past finding is the 24h bound,
 * not a stronger severity.
 *
 * ── THE Bash BLIND SPOT, STATED AT THE MECHANISM ─────────────────────────────
 *
 * This hook sees a todo change ONLY when it arrives through the `TodoWrite` tool.
 * It does not and cannot see:
 *
 *   - A todo list maintained anywhere other than `TodoWrite` — a markdown checklist
 *     edited with `Edit`, a plan file, a workspace todo tree.
 *   - ANY write to the tracker itself that does not go through `Edit`/`Write`/
 *     `NotebookEdit` either: a Bash heredoc or `>` redirect writes
 *     `.session-notes.shared.md` directly and no `PostToolUse` matcher fires. That
 *     is the same structural gap `burndown-quote-write-guard.js` self-documents,
 *     for the same reason — the matcher IS the tool set — and it belongs to the
 *     Bash surface, not to this predicate. It is recorded here rather than implied
 *     away, and NO coverage over it is claimed.
 *
 * So this producer closes `todos → index` for todos the harness owns. It does not
 * close "every possible representation of a todo", and must not be cited as doing so.
 *
 * FAILS OPEN ON EVERY UNKNOWN per `cc-artifacts.md` Rule 7 — no manifest, an
 * undeclared tracker, an unreadable or oversized ledger, a write failure, a spawn
 * failure, a timeout. But fails open LOUDLY where it can (`zero-tolerance.md`
 * Rule 3): an UNKNOWN is SURFACED as an advisory naming the reason, never rendered
 * as a clean projection. "Could not project" and "projected, nothing outstanding"
 * are opposite facts and MUST NOT render identically.
 */

"use strict";

const TIMEOUT_MS = 4000;

/**
 * The in-loop append deadline, INSIDE the timeout fallback above.
 *
 * A signed append costs whatever the operator's key type costs, and that is a
 * DEPLOYMENT PROPERTY, not a constant: MEASURED on this machine, an `openpgp`
 * `user.signingkey` costs ~233 ms per append (`gpg --detach-sign` alone is ~210 ms
 * of it), while the acceptance measurement recorded `ssh-keygen -Y sign` at 5.17 ms.
 * A large `TodoWrite` on a GPG deployment can therefore outrun the 4000 ms fallback,
 * and the fallback returns a BARE `{continue:true}` — so the events already appended
 * would stand while the un-appended tail vanished with nothing said about it.
 *
 * That silent tail is precisely what C6 forbids. So the loop stops at this deadline
 * and REPORTS the ids it did not record, rather than racing a timer that cannot
 * report anything.
 */
const APPEND_DEADLINE_MS = 3000;

let fallback = null;

const fs = require("node:fs");
const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

const RULE_ID = "burndown-traceability/todos-to-index";

/** The context artifact this producer maintains, repo-relative. Under `workspaces/`,
 * which `burndown-manifest.json::tracker.anchor_roots` declares DURABLE — never
 * `.session-notes.d/`, which `/reconcile-notes` is entitled to prune and whose
 * pruning is the originating failure `burndown-traceability.md` § Origin records. */
const CONTEXT_REL = "workspaces/todo-tracker/todo-context.md";

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = { hookEventName: "PostToolUse", additionalContext: context };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/** Strip the absolute project path out of any message before it is rendered.
 *
 * `burndown-build.mjs` is deliberate about never printing an operator's absolute
 * path, and records an incident where a crash leaked one. Still required after the
 * move to the event log, and for the same shape of reason: `append-sink.js` refuses a
 * sink outside its containment roots by NAMING the resolved path, which IS absolute,
 * and that reason string is exactly what a C6 refusal renders. Relativized here
 * rather than at the source, because those modules have no notion of a project root
 * and inventing one there would be the wider change. */
function scrub(s) {
  return String(s == null ? "" : s).split(PROJECT_DIR + path.sep).join("");
}

/** Emit through the canonical six-field shape. A raw `process.exit(2)` is BLOCKED
 * (`hook-output-discipline.md` MUST-1), and `instructAndWait` RETURNS its payload
 * rather than writing it — returning without emitting is the silent no-op that
 * computes a finding in full and discards it.
 *
 * `rule_id` and the CRITERION are carried IN THE TEXT, not as a sibling field.
 * MEASURED: `instructAndWait` does not destructure `rule_id`, so a `rule_id:` key
 * passed alongside is silently dropped and reaches the agent on no channel — the
 * exact "custom field CC drops" class that module's own header warns about. A RED
 * pole that cannot name which rule and which criterion fired is a non-zero exit
 * wearing a verdict's grammar (`instrument-bipolarity.md` MUST-2), so the identity
 * is prefixed into `what_happened` where it provably survives. */
function emitFinding({ severity, criterion, what_happened, why, agent_must_report }) {
  if (fallback) clearTimeout(fallback);
  try {
    const { instructAndWait } = require("./lib/instruct-and-wait.js");
    const emitted = instructAndWait({
      hookEvent: "PostToolUse",
      severity,
      what_happened: `[${RULE_ID} — ${criterion}] ${scrub(what_happened)}`,
      why: scrub(why),
      agent_must_report: [`rule_id: ${RULE_ID} · criterion: ${criterion}`, ...agent_must_report.map(scrub)],
    });
    process.stdout.write(JSON.stringify(emitted.json) + "\n");
    process.exit(emitted.exitCode);
  } catch {
    return passthrough(scrub(why)); // even the emit path fails open
  }
}

/**
 * Decide whether this repo has a burndown at all.
 *
 * SCOPED BY MANIFEST PRESENCE, like both burndown guards: a repo with no burndown
 * pays nothing and sees nothing.
 *
 * WHAT IS NO LONGER CHECKED, AND WHY THAT IS NOT A LOST FENCE. The prior version
 * read `tracker.path` from the manifest and REFUSED unless it was
 * `.session-notes.shared.md`, because the producer wrote through
 * `session-notes-layout.js`, which owns that one path — the fence stopped a silent
 * write to a surface nobody declared. This producer no longer writes the tracker at
 * all. Its sink is `burndown-events.js::EVENTS_REL`, a constant owned by the module
 * that also owns the schema and the only write path, so there is no manifest-declared
 * surface it could diverge from. The fence has nothing left to guard, rather than
 * having been relaxed.
 *
 * The `tracker.kind` check STAYS: it is what distinguishes "a burndown exists here"
 * from "a manifest exists that means something else", and an unrecognized kind is an
 * honest UNKNOWN rather than a silent no-op.
 *
 * BOTH KINDS ARE A BURNDOWN, and reading only `forest-ledger` was a stale vocabulary
 * that DISARMED this producer the moment loom's manifest declared `event-log`.
 * MEASURED before the fix, both poles on one tree: an `event-log` manifest produced
 * `todo→event projection is UNKNOWN: tracker.kind is 'event-log', not 'forest-ledger'`
 * and wrote nothing, while the same payload against the `forest-ledger` manifest
 * returned a bare `{"continue":true}` and recorded the transition. The guard was
 * HONEST about it — UNKNOWN, never "clean" — which is the only reason the disarm was
 * visible at all; but a producer that records nothing is still a producer that records
 * nothing. `event-log` is the STRONGEST signal a burndown exists here, so the set
 * GAINS it, mirroring `burndown-build.mjs::TRACKER_KINDS`.
 */
const TRACKER_KINDS = ["event-log", "forest-ledger"];

function resolveScope() {
  const manifestPath = path.join(PROJECT_DIR, "burndown-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { scoped: false };
  }
  const t = manifest && manifest.tracker;
  if (!t || typeof t.path !== "string" || !t.path) return { scoped: false };
  if (!TRACKER_KINDS.includes(t.kind)) {
    return { scoped: true, ok: false, why: `tracker.kind is '${t.kind}', not one of ${TRACKER_KINDS.join(", ")}` };
  }
  return { scoped: true, ok: true, rel: t.path.replace(/\\/g, "/").replace(/^\.\//, "") };
}

async function main() {
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }

  let lib;
  try {
    lib = require("./lib/todo-tracker.js");
  } catch {
    return passthrough(null);
  }

  // WRONG-EVENT FALL-THROUGH. `extractTodos` returns null for anything that is not a
  // `TodoWrite` carrying a todos array. This produces NOTHING — no row, no context
  // entry, no finding — which is the pole that proves the matcher is load-bearing
  // rather than the payload shape being coincidental.
  const todos = lib.extractTodos(payload);
  if (todos === null) return passthrough(null);

  const tracker = resolveScope();
  if (!tracker.scoped) return passthrough(null);
  if (!tracker.ok) {
    return emitFinding({
      severity: "advisory",
      criterion: "C3-unknown-not-clean",
      what_happened: `todo→event projection is UNKNOWN: ${tracker.why}`,
      why:
        `The producer could not establish that this repo declares a burndown, so it wrote nothing. ` +
        `"Could not project" is NOT "projected, nothing outstanding" — this is surfaced rather than ` +
        `swallowed so the two cannot render identically.`,
      agent_must_report: [
        "Todo→event projection did not run.",
        `Reason: ${tracker.why}`,
        "Reconcile burndown-manifest.json::tracker with the producer, or accept that todos are unrecorded.",
      ],
    });
  }

  let events;
  try {
    events = require("./lib/burndown-events.js");
  } catch {
    return passthrough(null);
  }

  const contextAbs = path.join(PROJECT_DIR, CONTEXT_REL);

  // ── read the context artifact (the durable first_seen record) ────────────────
  let prevText = "";
  try {
    const st = fs.statSync(contextAbs);
    if (st.size > lib.CONTEXT_CAP_BYTES) {
      return emitFinding({
        severity: "advisory",
        criterion: "C3-unknown-not-clean",
        what_happened: `todo→event projection is UNKNOWN: '${CONTEXT_REL}' is ${st.size} bytes, over the ${lib.CONTEXT_CAP_BYTES}-byte cap.`,
        why:
          `The producer stopped rather than pruning. Pruning would delete the LINK-3 back-reference for ids ` +
          `whose ledger rows remain — which is precisely the originating failure burndown-traceability.md ` +
          `records: the context for eleven register ids was PRUNED, not never-written.`,
        agent_must_report: [
          `Context artifact over cap: ${CONTEXT_REL} (${st.size} bytes).`,
          "Todo transitions are NOT being recorded until this is dispositioned by an owner.",
        ],
      });
    }
    prevText = fs.readFileSync(contextAbs, "utf8");
  } catch (e) {
    // ENOENT is the ORDINARY first-run state: no artifact yet, `prevText` stays "",
    // every todo reads as new. Anything else means the artifact EXISTS and could not
    // be read — a broken symlink, a parent that is a regular file, a permission
    // denial — and the producer then does not know what it previously observed.
    //
    // That used to `return passthrough(null)`: a BARE `{continue:true}`, which is
    // byte-identical to the output of a completely clean run. "Could not read the
    // context" and "read it, nothing outstanding" are opposite facts, and this
    // file's own header requires that they MUST NOT render identically — so the
    // silent return was the fabricated-clean failure the header names, sitting in
    // the one branch nobody had exercised. It is surfaced now, still fail-open.
    if (e && e.code !== "ENOENT") {
      return emitFinding({
        severity: "advisory",
        criterion: "C3-unknown-not-clean",
        what_happened: `todo→event projection is UNKNOWN: '${CONTEXT_REL}' exists but could not be read (${e.code || "unknown error"}).`,
        why:
          `The producer cannot tell what it previously observed, so it cannot tell which todos have ` +
          `transitioned. Reporting nothing here would be indistinguishable from a clean projection, which ` +
          `is the one thing this producer must never do.`,
        agent_must_report: [
          `Context artifact unreadable: ${CONTEXT_REL} (${e.code || "unknown error"}).`,
          "Todo transitions are NOT being recorded. Do NOT read this as clean.",
        ],
      });
    }
  }

  const nowMs = Date.now();
  // UTC by definition. A local-time read wrote an 8-hour-forward skew into a ledger
  // this month; `toISOString()` is the form that cannot.
  const nowIso = new Date(nowMs).toISOString();

  const prev = lib.parseContext(prevText);

  // ── decide which todos actually TRANSITIONED ────────────────────────────────
  //
  // An append-only log records CHANGES, and this is where the producer stops paying
  // per-todo cost on every keystroke. A `TodoWrite` that re-states an unchanged list
  // appends NOTHING and resolves no identity and spawns no signer — which is the
  // dominant case and is measurably CHEAPER than the upsert it replaces, where every
  // todo cost a read-modify-write of a 28 kB markdown table whether or not anything
  // had moved.
  //
  // The comparison is against the context artifact, which is the durable record of
  // what this producer last observed. It is deliberately NOT against the tracker: the
  // tracker is about to become a derived projection, and a producer that decided what
  // to emit by reading its own downstream projection would be reasoning in a circle.
  const transitions = [];
  for (const t of todos) {
    const before = prev.get(t.id);
    // `mergeContext` stores the RAW todo status, so the comparison is against the raw
    // form. Comparing the `todo:`-prefixed form here would never match, every todo
    // would read as a transition, and the no-op fast path would be dead code that
    // still looked correct.
    if (before && before.status === t.status && before.todo === t.content) continue;
    transitions.push(t);
  }

  // ── append one event per transition ─────────────────────────────────────────
  const unrecorded = []; // MEASURED loss of a transition — halt-and-report (C6)
  const unknown = []; // could not be determined — loud, but NOT a violation
  const recorded = []; // the transitions that ACTUALLY LANDED an event
  let wrote = 0;

  if (transitions.length > 0) {
    // Resolved ONCE per invocation, never per event: both calls shell out, and the
    // budget is per-hook-fire, not per-todo.
    let identity = null;
    let signOpts = null;
    let why = null;
    try {
      const { resolveIdentity, _discoverSigningKey } = require("./lib/operator-id.js");
      const id = resolveIdentity(PROJECT_DIR);
      const key = _discoverSigningKey(PROJECT_DIR, {});
      if (!id || !id.verified_id || !id.person_id) {
        why = "no verified identity resolved (run /whoami --register)";
      } else if (!key || !key.keyPath) {
        why = "no signing key discovered (set `git config user.signingkey`)";
      } else {
        identity = { verified_id: id.verified_id, person_id: id.person_id, display_id: id.display_id };
        signOpts = { keyType: key.keyType, keyPath: key.keyPath };
      }
    } catch (e) {
      why = `identity/key resolution threw: ${(e && e.message) || String(e)}`;
    }

    if (!identity) {
      // UNKNOWN AND VIOLATION ARE DIFFERENT ANSWERS, and the line here is
      // ENVIRONMENT versus WRITE. An un-enrolled repo with no signing key CANNOT
      // record a signed event; that is a missing precondition, not a failed write,
      // and scoring it as a lost transition would be a verdict the instrument cannot
      // support (`instrument-discipline.md` MUST-1: a result consistent with both
      // branches carries zero information). It is still LOUD — silence here would
      // render exactly like a clean projection.
      for (const t of transitions) unknown.push({ id: t.id, why });
    } else {
      const deadline = nowMs + APPEND_DEADLINE_MS;
      for (const t of transitions) {
        if (Date.now() > deadline) {
          // The remaining ids are NOT recorded and NOT silently dropped. Racing the
          // 4000 ms fallback would drop them with a bare `{continue:true}` — the
          // silent tail C6 forbids.
          unrecorded.push({
            id: t.id,
            why: `append deadline (${APPEND_DEADLINE_MS} ms) reached before this transition was recorded`,
          });
          continue;
        }
        const r = events.appendEvent(
          PROJECT_DIR,
          events.buildEvent({
            kind: "transition",
            item_id: t.id,
            item: t.content,
            value_anchor: `${CONTEXT_REL}#${t.id}`,
            // `todo:`-namespaced, and the namespace is load-bearing:
            // `burndown-traceability.md` MUST-4 makes statuses the OWNER's, so an
            // agent-authored event carrying a burndown-vocabulary status is REFUSED
            // by `validateEvent`. This is the fence that lets A4's promotion channel
            // exist at all without handing the agent a `Signed off`.
            status: `${lib.TODO_STATUS_PREFIX}${t.status}`,
            authority: "agent",
            source: "todo-tracker-guard",
          }),
          { identity, signOpts },
        );
        if (!r.ok) {
          unrecorded.push({ id: t.id, why: `${r.error}: ${r.reason}` });
          continue;
        }
        recorded.push(t);
        wrote++;
      }
    }
  }

  // ── ADVANCE THE CONTEXT ONLY FOR TRANSITIONS THAT ACTUALLY LANDED ───────────
  //
  // This is the difference between a producer that can lose a transition ONCE and
  // one that loses it FOREVER, and it is not a detail.
  //
  // The context artifact is this producer's record of WHAT IT LAST OBSERVED, and it
  // is also the input to the transition test above. Advancing it for a todo whose
  // event was NOT recorded makes the very next `TodoWrite` compare equal, drop the
  // todo from `transitions`, and report NOTHING — so a refusal that was correctly
  // LOUD on the first fire becomes permanently SILENT on the second, and the event
  // never lands. That is the silent-discard class C6 exists to close, re-created one
  // layer down by the producer's own bookkeeping.
  //
  // So `status`/`todo` advance only for RECORDED transitions. Every other todo still
  // gets `first_seen` stamped — the creation instant `wip-discipline.md` MUST-3
  // requires must be captured the first time a todo is SEEN, not the first time it is
  // successfully recorded, or age would silently reset on every failed append — but
  // with an EMPTY observed state, so the next fire re-detects the transition and
  // retries it.
  const next = lib.mergeContext(prev, recorded, nowIso);
  for (const t of todos) {
    if (next.has(t.id)) continue;
    next.set(t.id, { first_seen: nowIso, status: "", todo: "" });
  }

  // ── write the context artifact ONLY if it changed ───────────────────────────
  //
  // Still the LINK-3 back-reference target and still the durable `first_seen` record,
  // so it is still written — only the TRACKER moved to the log.
  //
  // The no-op fast path survives the move for a narrower reason than before. It used
  // to be load-bearing because the tracker was a DECLARED source held to
  // `assertCommittedAndUnmodified` and a byte-identical rewrite still counts as a
  // modification against HEAD. This artifact is NOT a declared source, so that
  // specific gate no longer applies to it; what remains is that a rewrite on every
  // `TodoWrite` churns a committed file for no state change, which is noise in every
  // diff and every merge. The reason is restated rather than inherited, because
  // inheriting a rationale after the surface it described changed is exactly the
  // `zero-tolerance.md` Rule 3e shape.
  const nextText = lib.renderContext(next);
  if (nextText !== prevText) {
    try {
      fs.mkdirSync(path.dirname(contextAbs), { recursive: true });
      const tmp = `${contextAbs}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, nextText, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // ATOMIC `.tmp` + `rename()` per `knowledge-convergence.md` MUST-1. The tracker
      // and this artifact are BOTH multi-writer surfaces with a merge driver, and a
      // partial write is indistinguishable from a corrupt one to every later reader.
      fs.renameSync(tmp, contextAbs);
    } catch {
      unrecorded.push({ id: "(context artifact)", why: `could not write ${CONTEXT_REL}` });
    }
  }

  // ── B4: AGE, not COUNT ──────────────────────────────────────────────────────
  const age = lib.ageReport(next, todos, nowMs);

  // ── C6: A REFUSED APPEND IS LOUD ────────────────────────────────────────────
  //
  // THIS IS WHERE A REFUSAL SURFACES, and it is the whole reason the log is a
  // SYNCHRONOUS committed file rather than a detached async emit. A detached refusal
  // is a typed return value with no durable sink: it is computed in full and
  // discarded, and the session learns nothing. Here the refusal reaches the agent
  // in-band, at `halt-and-report`, naming the rule, the criterion, the `item_id` and
  // the helper's own `error: reason` — so "the transition was recorded" and "the
  // transition was refused" cannot render identically.
  //
  // LOUD AND FAIL-OPEN ARE NOT IN TENSION. `emitFinding` routes through
  // `instructAndWait`, whose `halt-and-report` payload instructs the agent and does
  // not wedge the session; the 4000 ms fallback bounds it; and every other error path
  // in this file returns `{continue:true}`. The refusal is surfaced, the session is
  // not blocked.
  if (unrecorded.length > 0) {
    return emitFinding({
      severity: "halt-and-report",
      criterion: "C6-refused-append-is-loud",
      what_happened:
        `${unrecorded.length} of ${transitions.length} todo transition(s) were NOT recorded in ` +
        `'${events.EVENTS_REL}'. The append was REFUSED.`,
      why:
        `A transition that is not in the log is work the burndown reports nothing about: there is no path ` +
        `from the status to the ruling behind it, which is what burndown-traceability.md MUST-1 refuses. ` +
        `The append path REFUSED rather than writing an unsigned or truncated row — refusing is correct ` +
        `(knowledge-convergence.md MUST-6), and losing the refusal SILENTLY is what is not.\n` +
        lib.renderAgeReport(age),
      agent_must_report: [
        `Event log: ${events.EVENTS_REL}`,
        ...unrecorded.slice(0, 5).map((u) => `UNRECORDED: ${u.id} — ${u.why}`),
        `Events appended this projection: ${wrote} of ${transitions.length} transition(s).`,
        "Resolve the refusal; do NOT hand-edit the log or the tracker to paper over it.",
      ],
    });
  }

  // Some transitions could not be attempted at all, because the preconditions for a
  // SIGNED append are absent. Reported LOUDLY and as UNKNOWN — never as a violation
  // (this producer did not fail to write; it was never able to try), and never as
  // clean.
  if (unknown.length > 0) {
    return emitFinding({
      severity: "advisory",
      criterion: "C3-unknown-not-clean",
      what_happened:
        `todo→event projection is UNKNOWN for ${unknown.length} of ${transitions.length} transition(s): ` +
        `the signed-append preconditions are absent.`,
      why:
        `Identity or signing-key discovery did not resolve, so no signed event could be written. That is ` +
        `UNKNOWN, not a violation: scoring it as a lost transition would be a verdict the instrument cannot ` +
        `support. It is surfaced rather than swallowed so it cannot render as a clean projection. There is ` +
        `no unsigned fallback by design — an unsigned row is un-attributable.\n` +
        lib.renderAgeReport(age),
      agent_must_report: [
        `Event log: ${events.EVENTS_REL}`,
        ...unknown.slice(0, 5).map((u) => `UNKNOWN: ${u.id} — ${u.why}`),
        "These transitions are UNRECORDED. Do NOT read this as clean.",
      ],
    });
  }

  // Everything mirrored. Staleness is INFORMATION at this point, not a violation of
  // the producer contract, so it is `advisory` — the ratified `halt-and-report` is
  // scoped to "a todo has no tracker row", and halting on every TodoWrite for a
  // >24h todo is exactly how the previous WIP surface reached 63% noise and taught
  // its reader to ignore it.
  if (age.past.length > 0) {
    return emitFinding({
      severity: "advisory",
      criterion: "B4-age-not-count",
      what_happened: `${age.past.length} of ${age.open} open todo(s) are past the ${age.boundHours}h bound.`,
      why:
        lib.renderAgeReport(age) +
        `\n\nAge derives from the first_seen recorded in '${CONTEXT_REL}' at first sight — never from a ` +
        `stat().mtime read, which wip-discipline.md MUST-3 BLOCKS because a touch makes rot look fresh.`,
      agent_must_report: [
        `Past the ${age.boundHours}h bound: ${age.past.map((r) => `${r.id} (${r.ageHours}h)`).join(", ")}`,
        "Land it, kill it with a recorded reason, or restate why it is still open.",
      ],
    });
  }

  return passthrough(null);
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  // The timeout fallback returns a BARE `{continue:true}` — no finding, no claim.
  // A timeout has measured nothing, so anything it printed about the chain would be
  // a fabricated clean.
  fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
  if (typeof fallback.unref === "function") fallback.unref();
  return main().catch(() => passthrough(null));
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
