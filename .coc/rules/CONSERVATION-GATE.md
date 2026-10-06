---
id: "CONSERVATION-GATE"
---

# Conservation Gate — Content Crossing A Boundary Is Enumerated Before And After

See `.claude/guides/rule-extracts/conservation-gate.md` for the boundary roster, the eight measured instances, extended DO/DO-NOT blocks, and the per-boundary signal classes.

Wherever content crosses a boundary — branch rewrite, dispatch, delivery, worktree teardown, scrub, temp-root purge — ask **does what I had a moment ago still exist?** Undeclared disappearance is the violation.

## MUST Rules

### 1. Every Boundary Crossing Declares Its Delta

Before an operation that can remove content from a surface, record the BEFORE set; after it, the AFTER set; every element present-before-and-absent-after MUST carry a declared reason in the same message. A plausible after-set is not an account; "it reported success" is not a reason.

```text
# DO — before-set, after-set, every departure declared
before 12 commits → after 8; the 4 absent are merges, reverse-patch-applied ⇒ content present
# DO NOT — read the after-set alone and call it healthy
"rebase clean, 8 commits, PR green"   ← nothing enumerated what the 4 were
```

**BLOCKED rationalizations:**

- "The operation reported success"
- "The result looks right"
- "Nothing errored, so nothing was dropped"
- "The tool would have told me"
- "I can reconstruct the before-set from the after-set if I need to"
- "It is a routine operation, it does not move content"
- "The count went down because the history was tidied"
- "The diff is the record; I do not need a separate before-set"

**Why:** Surviving evidence at a boundary always looks healthy, so a loss is undetectable unless the before-set was written down first.

### 2. Membership Is Decided By CONTENT Identity, Never By NAME Identity

The before/after comparison MUST be made on content — reverse-patch-apply, blob comparison, byte equality — never on names, shas or path presence.

```text
# DO — content test
range-diff / reverse-patch-apply: the 4 absent shas' changes ARE in the tree ⇒ conserved
# DO NOT — name test
"those 4 shas are not in `git log`, so 4 commits were lost"   ← counted 10, truth was 4
```

**BLOCKED rationalizations:**

- "Not on the trunk means lost"
- "The sha is not in the log, so the work is gone"
- "The file is still there, so the content is fine"
- "Same filename, same path — nothing changed"
- "Comparing shas is the rigorous way to do it"
- "Reverse-patch-apply is overkill for a routine rebase"
- "The names are what the tool reports, so the names are the truth"

**Why:** Rewrites and re-deliveries change every name while conserving every byte, so a name-keyed comparison reports losses that never happened and misses losses that did.

### 3. The Enumeration NAMES What Its Instrument Cannot See

An enumeration MUST state inline the classes its instrument structurally cannot observe — untracked files, additions, out-of-index state — and MUST NOT be called whole-set while a blind class stays unnamed.

```text
# DO — blind classes named in the same report
"fence covers tracked modifications only; untracked + ADDED files UNSEEN — 180 additions unchecked"
# DO NOT — report the fence's silence as a whole-set clean
"fence returned no divergence ⇒ destination is clean"   ← it never looked at additions
```

**BLOCKED rationalizations:**

- "The check returned clean"
- "If there were a problem the fence would have caught it"
- "Untracked files are not really part of the delivery"
- "Additions cannot cause loss"
- "Naming the blind spots invites scope creep"
- "It is the standard instrument for this boundary"
- "Enumerating what a tool cannot see is unbounded"

**Why:** An instrument's silence about a class it was never built to observe is indistinguishable from a true negative, so an unnamed blind spot turns a partial check into a confident all-clear.

### 4. Absence Is LOUD — An Empty Outcome Is Distinguishable From A Successful One

A boundary operation producing NO payload — a refused tool call, a dispatch returning nothing, a purge that closed nothing, a scan matching zero — MUST emit a signal naming what did NOT happen and what is still outstanding. Reporting an empty outcome in the grammar of a completed one, or going quiet after a refusal, is BLOCKED.

```text
# DO — the empty outcome is announced with its consequence
"tool call REFUSED by hook; 286 insertions still uncommitted in <path>; NOT delivered"
# DO NOT — silence, or an idle that reads as completion
(agent returns nothing; orchestrator records the lane idle)   ← payload still on disk
```

**BLOCKED rationalizations:**

- "There was nothing to report"
- "The call was blocked, so there is nothing to say"
- "I will mention it if it matters later"
- "An empty result is a clean result"
- "The scan found nothing, so the surface is clean"
- "Zero rows means the purge had nothing to do"
- "Reporting a refusal is noise"
- "The orchestrator can see the lane went quiet"

**Why:** A silent empty is the one failure a reader cannot detect, being byte-identical to the successful case that legitimately has nothing to report.

### 5. Scratch Is Asked For, Never The Only Copy

Scratch MUST be ASKED for (`mktemp -d`, under `os.tmpdir()`), never hand-spelled, `/tmp/<name>` included. Anything whose loss would matter MUST NOT live only under a temp root. An artifact a later session must read MUST NOT be left as a standalone temp-root snapshot; scratch that must outlive the session MUST go in a repo-declared gitignored path, never loose in the tracked tree.

```bash
# DO — ask for scratch; keep what must survive in a declared-ignored root
d=$(mktemp -d); git check-ignore -q scratchpad/ && cp result.json scratchpad/
# DO NOT — spell a root, or leave the only copy where a reboot purges it
mkdir -p /tmp/mywork; cp result.json /tmp/handoff.json; echo x > ./probe-out.txt
```

**Why:** A reboot or the OS cleaner purges a temp root with no after-set to compare, and a spelled root is a path nobody guaranteed. Depth: `.claude/guides/rule-extracts/conservation-gate-scratch.md`.

## MUST NOT

- Instantiate this contract as a uniform `block` across every boundary

**Why:** Each boundary instantiates this contract with the strongest signal it actually yields, and only a parsed structural signal may carry `block` per `hook-output-discipline.md` MUST-2; a judgment-bearing boundary carries `halt-and-report`. Per-boundary roster: `.claude/guides/rule-extracts/conservation-gate.md` § Boundary Roster.

- Close a boundary operation whose conservation enumeration never ran, on the grounds that the operation is routine

**Why:** Every measured instance of this class was a routine operation; routineness is when the gate gets skipped, never evidence it was unneeded.

Depth — the Trust-Posture Wiring fields, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/conservation-gate.md`, which every validator reads as part of this rule.
