# /wrapup --cycle — the bounded context-cycle handover

Read this file INSTEAD of the rest of the wrapup depth: it is the whole procedure. Runs with no human step; nothing here asks.

**When.** The context meter's `[CTX] HANDOVER-DUE` / `HANDOVER-OVERDUE` / `BACKSTOP` line, or an explicit `/wrapup --cycle`. The cycle is a CHECKPOINT, never a stop: run it at once, then keep working (§ After the line).

## The four slots — in this order, and nothing else

0. **Read this file** — only if its schema is not already in context. No other read: the aggregate, the fragment, its history, the journal and the ledger are NEVER read here.
1. **SEED — one `Write`, FIRST.** Path: `<main-checkout>/.claude/learning/handoff/seed-<display_id>-<YYYYMMDDTHHMMSS>.md` (gitignored). After this call alone, any boundary (`/clear` or an autocompact) resumes correctly — that is why it is first.
2. **DEPTH delta — one `Write`, only when this cycle changed the forest.** `<same stem>.events.json`: a JSON array of `{item_id, item, value_anchor, status}` — the ledger transitions, each closing one with its receipt in `status` or growing one with a fresh `item_id` + user-anchored `value_anchor` (`commands/wrapup.md` § Outstanding ledger reconciliation steps 2–3 bind unchanged). Nothing changed ⇒ skip the slot. Anything larger than a seed row belongs in a todo or journal BEFORE the cycle, and the seed's DEPTH points at it.
3. **Projections — one `Bash`.** `node .claude/bin/handover-render.mjs render <seed> [--events <events.json>]; echo "rc=$?"` — nothing after the `echo`, no pipe; its few receipt lines are the whole read-back. It validates the seed, then writes the fragment `## CURRENT` section, the signed events, the regenerated forest ledger, and the vault pair (plan → exclusive write → verify). If the renderer is absent here, the final line says so — the seed alone is a valid boundary.

Then **end the cycle** with one line. From the seed write on, write NO text — tool calls only — until that ONE final line, which must name the stamped seed. Anything the seed does not carry — an owner or queued prompt, an answer or rejection, any other assistant text — refuses readiness (`tail-after-seed`; `context-state.js::tailFenceVerdict`), so the next cycle rewrites the seed to carry it. The last message is ONE line, the renderer's first output line verbatim (`HANDOVER WRITTEN <sha8> — …`), or one of the lines below.

| render rc | meaning | final line |
| --- | --- | --- |
| 0 | rendered AND stamped; every projection `ok` or `skipped` (a missing vault is a DECLARED skip; `.claude/bin/lib/handover-render.mjs::projectVault`) | the renderer's first line |
| 1 | seed REFUSED (schema, > 8,000 B, or the binding below) — NOTHING was projected | `HANDOVER REFUSED <finding codes> — seed at <path>, render owed` |
| 3 | a projection FAILED; the seed stands | `HANDOVER INCOMPLETE <sha8> — <failed projections>` |
| 4 | rendered but NOT stamped — `CLAUDE_CONFIG_DIR` unset or not a directory; the boundary can never read ready | `HANDOVER RENDERED NOT STAMPED <sha8> — no config dir` |
| 5 | rendered but the stamp REFUSED (seed changed, misnamed, outside the handoff dir, or `tail-after-seed`: input arrived after the seed) | `HANDOVER RENDERED NOT STAMPED <sha8> — <stamp code>` |
| 2 / other | usage or unreadable seed | `HANDOVER UNKNOWN rc=<n> — seed at <path>` |

**Cap 4, plus ONE bounded retry of at most 2 calls (≤ 6).** The retry exists only for a seed-write `[CTX] seed …` line or a REFUSED render whose codes are all in this set, each fixed ONCE and then rendered once more: `written-skew` ⇒ Edit the header to the clock the line or refusal prints (only a FUTURE label is fixed in place); `seed-stale` ⇒ write a NEW seed file from live state — never re-label an old one; `assignment-ledger-stale` ⇒ append this cycle's results (or a dated "no change since" line) to the ledger. Anything else, or a second refusal, ends the cycle loudly: the seed still stands, the meter re-signals and the NEXT cycle rewrites the seed, carrying the failure in TRAPS. A truncated seed is BLOCKED — over the cap the renderer refuses, it never cuts.

## After the line — keep working

The cycle ends with its one line; the SESSION does not. With work queued, keep draining it in the same turn — never idle at the handover threshold. Ending the turn after the line is right only when nothing is queued or the owner is about to `/clear`. Working on after the line makes the boundary read not-ready for `/clear` (`tail-after-seed`) — expected: the seed stays on disk for an autocompact, and the meter's next band line re-runs this cycle when the forest has moved. This binds every session in a fleet, and ROOT carries it into every workhorse brief (`skills/lane-planning/fleet-operations.md` § 3).

## The seed — fixed schema, every section present (empty ⇒ `none`)

```
=== SEED v1 lineage=<terminal> written=<iso8601+offset> at_tokens=<n> resume=<8 hex, fresh> ===
ROLE: <orchestrator|workhorse(<lane>)|lane> (<repo>) | repo=<abs> | trunk=<branch> | posture=<L> | msg-name=<name>
STANDING: <pointer#anchor> | … (≤5; pointers, never text)
MISSION: <one sentence>
ASSIGNMENT: none    — or the three rows: - objective: "<owner wording, verbatim>" / - ledger: <path> / - next: <step>
IN FLIGHT (id | what | where | state | owner | next | re-check)
OWNED BY OTHERS (who | what | waiting on | check)
PENDING DECISIONS (id | question | decides | recommendation | blocks)
NEXT: <exactly one imperative> | re-validate: <command -> meaning still true>
QUEUED: <≤2 items>
TRAPS
DEPTH
MECHANICAL (generated, do not edit)
=== END SEED ===
```

- **Budget:** target 4,000 B, hard cap 8,000 B. Rows: IN FLIGHT ≤8, OWNED ≤6, DECISIONS ≤5, TRAPS ≤5, DEPTH ≤6 (`path#anchor`, read on demand, never on resume).
- **Header:** `written` = the clock the latest `[CTX]` handover line prints (`seed written=<clock>`), COPIED — never typed from memory, never a lookup call. With no such line in context, write your best time: the seed-write `[CTX] seed …` line prints the clock if it is off, and that one Edit is the cycle's retry. The renderer stamps its own clock into every record and REFUSES a label > 2 min ahead of the seed-write clock (`written-skew`) or a seed > 10 min old (`seed-stale`). `at_tokens` = the meter's last figure (`341k` ⇒ `341000`); none in context ⇒ `0` and a TRAPS row `at_tokens unmeasured`. `resume` is 8 fresh hex chars — the resume prompt echoes it.
- **ROLE:** the seed validator requires the leading token to begin with `orchestrator`, `workhorse` or `lane` (`hooks/lib/handover-seed.js::checkRole`). In a fleet, the two working orchestrators write `orchestrator(root)` / `orchestrator(second)` — each carries work through its own subagents, so its own lanes are IN FLIGHT rows — and the lander-builder (lands, measures, reaps, and builds bounded shards) writes `workhorse(lander)`; a two-session project has no lander seed.
- **ASSIGNMENT** (required to render): `none`, or the owner's objective VERBATIM in quotes, its durable ledger (absolute, or relative to `repo=`) and the next step. The objective must appear in an owner-typed message of this or a predecessor transcript (refused otherwise); the ledger must exist, contain it verbatim and be written in the last 15 min (a future mtime is refused) — a result reported to the owner is written to it in the SAME turn. A delegated session's work is ONE `OWNED BY OTHERS` line, never IN FLIGHT rows. **On resume**, ledger missing or unreadable ⇒ FIRST extract the OWNER's messages from the predecessor transcript (`<config dir>/projects/<repo slug>/<handover.session_id>.jsonl`; non-isMeta user prompts and origin:human queued prompts only — peer, task and tool text is never the owner) before answering anything about the assignment — never guess it.
- **IN FLIGHT** rows name WHERE the work physically lives (worktree path + branch) and a `re-check` command; running background agents go here (it is the wave tracker's projection). `decides` is `HUMAN` or `ORCHESTRATOR` — the two escalation destinations, never merged.
- **STANDING** carries `commands/wrapup.md#handoff-block (LAND FIRST)` — the seed REPLACES the handoff block, so the landing directive rides as a pointer. A fleet session's STANDING also carries `skills/lane-planning/fleet-operations.md (FLEET MODE)`, so a resumed session re-resolves its role and, as ROOT, re-creates its stall watchdog on its first turn.
- **MECHANICAL** holds ONLY generated lines already in context (a `--quote` burndown line, a sweep receipt path), quoted verbatim, ≤2,000 B — else `none`. A figure typed from memory is BLOCKED (`commands/wrapup.md` § Hard rules, generated-figure carve-out).

## The vault pair, and why this is bounded

The renderer projects the pair (`…-wrapup.md` carries the seed verbatim as the `/clear` seed; `…-sweep.md` the GENERATED half of the report), which satisfies the vault directive between full `/sweep` runs (decision D1); cycle mode never chains a full `/sweep`. Why ≤ 4 calls (≤ 6 with the one retry) suffice, and the measured walk: `skills/wrapup/SKILL.md` § 10.
