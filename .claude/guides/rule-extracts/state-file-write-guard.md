# state-file-write-guard.md — Extended Extracts

Companion to `.claude/rules/state-file-write-guard.md`. Holds the BLOCKED-rationalization corpora, extended DO/DO NOT bodies, full override-protocol prose, the composition table, and the originating post-mortem. Loaded on demand when the agent needs the deeper context — not in the always-on rule budget.

## BLOCKED Rationalizations By MUST Clause

### Rule 1 — Hand-writing deploy state without the wrapper

- "I observed the page render manually, that counts as verification"
- "The signature mechanism is overkill for this single deploy"
- "The wrapper is slow; I'll regenerate the signature later"
- "The agent's browser walk is equivalent to running the wrapper"
- "The state file is just metadata; the actual deploy is fine"
- "I'll write GREEN now and add the signature in a follow-up Write"
- "Playwright-MCP page-walk catches everything the contract scan does"
- "Surface signals (no console errors, 200 OK on every request, no warning toasts) ARE the contract"

### Rule 2 — T3 diagnostic: validator's verdict is authoritative

- "The validator is wrong about this finding — override and continue"
- "The wrapper is broken; my walk was correct"
- "The contract is too strict; relax it for this deploy"
- "I'll just write YELLOW even though I haven't enumerated all gaps"
- "The override env var is fine for one Write"
- "We can update the contract later; for now write GREEN to unblock"
- "The validator's signature scheme has a known issue; that's why it's failing"

### Rule 4 — Smoke-report trust root

- "I just want to fix one false-failing identifier, the rest of the report is correct"
- "The smoke report is generated, why is it protected?"
- "I'll regenerate the signature after editing"
- "Manual edit is faster than re-running the wrapper"
- "The wrapper is broken right now, I'll edit by hand to unblock the deploy"
- "The smoke report is just data; the validator is the gate"
- "Editing the report doesn't change the actual deploy state"

### Rule 5 — Three-layer Bash mutation coverage

- "cp doesn't use a shell redirect, it should be allowed"
- "The interpreter is just reading the file, my one-liner is innocent"
- "rsync is for backup, not mutation"
- "truncate doesn't write content, it just resizes"
- "ln -sf is a symlink, not a file write"
- "chmod doesn't write content"
- "touch only updates mtime"
- "python -c is fine for one-line edits, the agent isn't an attacker"
- "Layer 2/3 false-positives are too noisy; redirect-only is good enough"

### Rule 6 — Override env-var ordering

- "SELF block is the strongest defense, putting it first is conservative"
- "Override-first weakens the hook"
- "Atomic-update commits are rare; ordering doesn't matter"
- "We can document the actual behavior; the rule already says env var works"
- "The override is a last resort; making it dead code is fine"

### Rule 7 — Override protocol

- "The user said 'go ahead' last hour, that authorizes future bypasses"
- "I'll set it for this batch of writes and unset later"
- "The override is documented, that's enough"
- "Strip-and-restore lets me commit incrementally; the atomic-update rule is overkill"
- "Persistent override across sessions is fine if I don't actually edit anything"
- "The atomic-update commit can be split across PRs"

## Extended Examples

### Tier matrix — full T3 diagnostic remediation paths

The validator emits a T3 diagnostic with three remediation paths the agent can act on:

```text
T3 BLOCK — verification_status: "GREEN" but signature missing/invalid OR contract scan failed.

Remediation paths:
  (a) Verify GREEN properly:
      bash scripts/smoke/run-post-deploy-smoke.sh <env>
      # → wrapper writes the smoke + interactions reports + signed state file
      # → re-Write the resulting JSON; T1 ALLOW

  (b) Write YELLOW with documented gaps:
      change verification_status to "YELLOW"
      populate <gap_list_field>[] — one entry per gap referencing the failing identifier
      # → T2 ALLOW

  (c) Step-D auto-warm (project-specific):
      curl -X POST <fabric-endpoint>?refresh=true   # per gap
      bash scripts/smoke/run-post-deploy-smoke.sh <env>
      # → contract scan now passes; T1 ALLOW
```

The agent picks ONE path and proceeds — the validator does not negotiate.

### Honest YELLOW — full enumeration example

```json
// DO — every gap mapped to a tracking issue + free-text rationale
{
  "commit": "47e0859c...",
  "verification_status": "YELLOW",
  "smoke_pages_passed": [
    "treasury-portfolio.executive-summary",
    "cash-reporting.cross-country.detail-table"
  ],
  "smoke_step_d_actions": [
    "cash-reporting.cross-country.overview is COLD; tracked in #1900",
    "cash-reporting.sunburst.cash-insights ai_narrative=null on every probed cell; tracked in #1902",
    "treasury-portfolio.pipeline-investments shows 2 of 30+ projects; tracked in #1906"
  ]
}
```

The validator's contract scan extracts the failing identifiers from the smoke report and asserts each appears in `smoke_step_d_actions[]`. Free-text rationale is fine; the failing identifier MUST be present.

### Override-ordering — full DO / DO NOT JS

```javascript
// DO — override checked first; covers every protected category including SELF
function evaluateFileTool(toolName, input) {
  if (process.env.OVERRIDE_ENV_VAR === "1") {
    return { block: false, tier: "OVERRIDE" };
  }
  if (HOOK_SELF_PATTERNS.some((p) => p.test(input.file_path))) {
    return { block: true, tier: "T4", reason: "..." };
  }
  if (CONTRACT_DOC_PATTERNS.some((p) => p.test(input.file_path))) {
    return { block: true, tier: "T4", reason: "..." };
  }
  if (SMOKE_REPORT_PATTERNS.some((p) => p.test(input.file_path))) {
    return { block: true, tier: "T4", reason: "..." };
  }
  // ... validator-driven T1/T2/T3 routing for state files ...
}

// DO NOT — SELF / CONTRACT_DOC checks first; override is dead code for those
function evaluateFileTool(toolName, input) {
  if (HOOK_SELF_PATTERNS.some(...)) return { block: true, tier: "T4" };
  if (CONTRACT_DOC_PATTERNS.some(...)) return { block: true, tier: "T4" };
  if (process.env.OVERRIDE_ENV_VAR === "1") {
    return { block: false, tier: "OVERRIDE" };  // never reached for HOOK_SELF / CONTRACT_DOC paths
  }
  // ...
}
```

The v1 hook from the originating incident shipped with SELF-first ordering. The rule's "set the override env var to atomically update the hook" was structurally impossible — the only path was strip-and-restore on `settings.json`. v2 reordered to override-first.

## Override Protocol — Full Steps

To update the contract (add/remove a prohibited string, add a new contract identifier, change tier semantics):

1. Edit the project's contract spec.
2. Edit the project's smoke / contract manifest (`prohibited_strings` or per-page contract entries).
3. Edit the project's smoke / contract spec consumer (if assertion semantics change).
4. Edit the validator (if signature or tier-decision logic changes).
5. Edit the hook (if path patterns or tool routing change).
6. Edit this rule's project-specific instantiation.
7. Update the regression suite to pin every new code path.
8. Commit ALL of the above atomically.

Same atomic-update pattern as `branch-lock.md` § Override Protocol. Drift between any two of those artifacts = silent regression.

For the atomic-update commit, the override env-var bypasses the hook for the duration the variable is set in the hook's environment. Two ways to set it:

- **`.claude/settings.local.json`** (gitignored, session-scoped): add the var to the `env:` block. Effective on next session start.
- **Strip-and-restore** (in-session): edit `.claude/settings.json` to temporarily remove the hook, perform the atomic update, restore the hook, run the regression suite before committing. Diff is net-zero on `settings.json`.

Using the override MUST be authorized in chat by the user AND followed by a same-session commit fixing spec + rule + manifest + smoke spec + hook + validator + regression test in lockstep. Leaving the override active across sessions is BLOCKED.

## Composition With Trust Posture — Full Table

| Layer                                         | Scope              | Decision unit            | State file                         | Authored by                                   |
| --------------------------------------------- | ------------------ | ------------------------ | ---------------------------------- | --------------------------------------------- |
| **state-file-write-guard** (per-deploy claim) | per-deploy claim   | T1/T2/T3/T4 verdict tier | project-defined deploy state files | project (consumes loom-shipped rule + helper) |
| **trust-posture** (per-repo authority)        | per-repo authority | L1–L5 posture level      | `.claude/learning/posture.json`    | loom (baseline)                               |

Composition mechanics: a T3 unsupported-claim detection logs to the shared `violations.jsonl` (per `rules/trust-posture.md` § State files); cumulative T3 violations cross the trust-posture downgrade threshold (3× same-rule in 30d → drop one posture; 5× total in 30d → drop one posture) and the agent's repo-wide authority degrades on the next session. The deploy claim being blocked is the single-event defense; the posture downgrade is the cross-session learning.

The two systems share infrastructure (the `instruct-and-wait.js` library for canonical hook output, the `state-io.js` library for atomic violations.jsonl appends) but operate on independent state files: state-file-write-guard owns `deploy/.last-deployed-*`; trust-posture owns `.claude/learning/posture.json`. Neither is allowed to mutate the other's state — `permissions.deny` covers both surfaces in `settings.json`.

## Origin Post-Mortem (2026-05-05)

The originating incident: agent wrote `verification_status: GREEN` for dev `47e0859c` while three Cash Reporting AI panels rendered stub content (#1900-#1906). The agent's GREEN claim was based on Playwright-MCP page-walk header signals — Mar 2026 data-date, 100% Completeness badge, "Updated less than a minute ago", 0 console errors, 200 OK on every request, no warning toasts. None of those signals trip on AI-panel stubs ("Click Generate Overview", "haven't been generated yet"); the page renders normally, no error fires, the surface walk passes.

The contract scan would have caught all three: prohibited stub-string match against the rendered panel content. The agent's walk did not run the contract scan; it inferred GREEN from surface signals. False-GREEN shipped.

User downgraded autonomy on smoke testing per CARE Principle 7 + EATP graduated postures + Mirror Thesis. Self-redteam (same day) surfaced four follow-up gaps in the v1 hook:

1. **Bash regex missed Layer 2 + Layer 3.** v1 only matched redirect-style writes; a `cp /tmp/forged.json deploy/.last-deployed-dev` slipped through silently. Same with `python -c "open(...).write(...)"`. v2 broadened to all three layers.

2. **Smoke report itself was unprotected.** v1 protected the state file but not the smoke report (the validator's trust root). An agent who could not write GREEN directly could still hand-write the smoke report (no protection), then run `validate-state-file --mode=emit-signature` (allowed; emit-signature is wrapper-driven), and ship a "signed" state file built on a fraudulent signature input. v2 added `SMOKE_REPORT_PATTERNS` T4-block.

3. **Atomic-update contract was unprotected.** v1 didn't block edits to spec / manifest / smoke spec — agent could weaken text-only policy without touching structural artifacts. v2 added `CONTRACT_DOC_PATTERNS` T4-block (covering rule + spec + manifest + smoke spec).

4. **Override env-var was checked AFTER SELF check.** v1 ordering made the rule-promised escape hatch dead code for hook-self / contract-doc / smoke-report edits. The rule said "set CLAUDE_HOOK_OVERRIDE_STATE_GUARD=1 to bypass for atomic-update commits" but the v1 implementation returned T4 BLOCK before reading the env var when the path was `state-file-write-guard.js` itself. The only working path was strip-and-restore on settings.json (a separate, unprotected file). v2 reordered to override-first.

v2 closed all four gaps in a single atomic update.

Issue #25 (loom 2026-05-05) endorsed global adoption + named three lift-to-loom artifacts. PR #125 (2026-05-10) lifted the institutional-knowledge layer (the rule + the shared three-layer Bash-mutation helper). The lib generalization was deferred until a second consumer project exists — abstractions designed without two concrete consumers tend to fit zero. The rule is the high-value-per-LOC piece; the lib is the speculative-per-LOC piece.

The runtime defense (project-specific PreToolUse hook + validator) remains project-scoped because state-file shapes vary across projects. Each consumer project authors a thin hook that consumes the loom-shipped helper with its own protected-path regex.

PR #126 (2026-05-10) trimmed the rule from 272 → 154 lines per `rule-authoring.md` MUST NOT clause "Rules longer than 200 lines" — same-class gap surfaced post-PR-125-merge, fixed in same session per `autonomous-execution.md` MUST Rule 4. The trim moved the BLOCKED-rationalization corpora, JS code blocks, full override-protocol prose, composition table, and Origin post-mortem to this guide-extract.


## #1363 / #1390 residuals — executed evidence for (k)–(n)

Depth for the four residuals the rule lists in pointer form. Each was MEASURED,
not inferred; every command below was run against the real detector via
`detectStateFileMutationSegmentAware(cmd, STATE_PATH_RX)`.

### (k) — the detector is not root-scoped

`STATE_PATH_RX` is unanchored, so any path whose SUFFIX is a protected path
matches, whatever the prefix. A `/tmp` sandbox path and the real repo's file are
indistinguishable:

```
node -e '…writeFileSync("/tmp/f2-walk/otherroot/.claude/settings.json", "{}")'  -> FLAG L3
node -e '…writeFileSync(".claude/settings.json", "{}")'                        -> FLAG L3
```

Consequences measured in one session: an adversarial reviewer's symlink probe
inside a `mktemp` sandbox was blocked (its finding was downgraded from EXECUTED
to STATIC), and a drift-guard's own deliberately-drifted `/tmp` fixture could not
be built through Bash.

Why it is a SEPARATE shard rather than part of the operand-vs-prose fix: closing
it needs (1) the detector to RETURN the matched path span (today it returns only
`{layer, kind}`), (2) a containment decision resolving candidate AND repo
state-root through one resolver per `security.md` § Path Containment, (3)
deepest-existing-ancestor resolution — the sibling precedent
`state-io.js::_assertStateDirContained` fails CLOSED when `realpathSync` throws,
and a guard-time fixture path does not exist yet, so a naive port would STILL
block the case it is meant to fix — and (4) the macOS `/tmp` → `/private/tmp`
symlink case. That is a new invariant class with its own TOCTOU analysis.

Pinned by `flag-f3-1363-k-tmp-sandbox-write-not-root-scoped` +
`flag-f3-1363-k-control-real-repo-write`, so a future root-scoping change must
flip them DELIBERATELY rather than by accident.

### (l) — heredoc to a non-protected scratch file

A `cat > file <<'EOF'` heredoc is deliberately never masked (the #764
write-then-run invariant), so a write EXAMPLE quoted in the body of a scratch
file is scanned as command text. This blocked an orchestrator writing the #1363
bug report itself into `/tmp`. Not fixed here because masking it would REMOVE an
existing detection rather than correct a quote-semantics error; residuals (c)/(h)
already cover separate-command write-then-run, and the Layer-4 bundle pass still
covers same-command write+run. Remediation: author the scratch file with the
Write tool, or use `gh … --body-file`.

### (m) — the Layer-4 backstop's real trigger

Ablation of the bundle backstop (`pathRx = /\.claude\/settings\.json\b/`):

```
cat <state> && node other.js                            -> clean  (no redirect)
cat <state> && node /tmp/a/other.js > /tmp/b/out.json   -> FLAG   (different files!)
cat <state> && node /tmp/d/other.js > /tmp/d/out.json   -> FLAG
cat <state> && wc -l x > /tmp/b/out.json                -> clean  (no interpreter)
cat /etc/hosts && node /tmp/a/o.js > /tmp/b/out.json    -> clean  (no protected path)
```

So the conjunction is *protected-path mention + ANY structural redirect target +
ANY structurally-executed script*; the written target need NOT be the executed
file. A read-only before/after inspection
(`shasum <state>; node probe.mjs > out.json; shasum <state>`) therefore blocks —
which is how a guard's own test fixtures get built. Note the read VERBS are
already clean on their own: `shasum <state>`, `cat <state>`, `grep <state>` all
return `null`, so this is NOT a read-vs-write gap.

The in-code comment previously claimed the backstop "never fires when the
executed file is NOT written in-command"; that holds only when the command
carries no redirect at all, and was corrected in place per `zero-tolerance.md`
Rule 3e. The backstop itself is left AS-IS: it is the fail-CLOSED defense against
bash-parse divergence, where over-blocking is the cheap direction.

### (n) — newline-joined segment, PRE-EXISTING under-block

`splitShellSegments` does not split on a lone `&`, and
`detectStateFileMutationSegmentAware` does not pass `newlineSeparates`, so a
prose-carrier lead followed by a newline-joined interpreter write stays ONE
masked segment. Traced against the PRE-EXISTING `GIT_COMMIT_WITH_BODY_RX`
(`git commit -m 'x'` ⏎ `node -e …write…`), so #1363 did not introduce it — but
#1363 does add new entry points (`git tag|notes|merge|stash`,
`gh pr comment|review`, `gh release|gist|repo`). Recorded per
`zero-tolerance.md` Rule 1a: "same on main" is not a disposition. Not bundled,
because `newlineSeparates: true` plus lone-`&` splitting changes segmentation for
EVERY caller of the shared splitter — including `detectRepoScopeDriftBash` — and
owes a full re-run of both detectors' fixture suites.

### The blank-set lesson (#1390 review S6)

The quote-aware predicate that replaced `EXECUTES_INSIDE_QUOTES_RX` first
enumerated the funsub blank set by hand as ` `/`\t`/`|`, silently dropping SIX
members of JS `\s`. Each was a measured BLOCK→PASS regression against
`git commit -m "x ${<blank>rm <state>;}"`:

```
space                 HEAD=BLOCK  NOW=BLOCK    (enumerated)
tab                   HEAD=BLOCK  NOW=BLOCK    (enumerated)
newline \n            HEAD=BLOCK  NOW=PASS  <- REGRESSION
carriage return \r    HEAD=BLOCK  NOW=PASS  <- REGRESSION
form feed \f          HEAD=BLOCK  NOW=PASS  <- REGRESSION
vertical tab \v       HEAD=BLOCK  NOW=PASS  <- REGRESSION
NBSP U+00A0           HEAD=BLOCK  NOW=PASS  <- REGRESSION
line sep U+2028       HEAD=BLOCK  NOW=PASS  <- REGRESSION
pipe |                HEAD=BLOCK  NOW=BLOCK  (enumerated)
```

Generalizable rule, now normative in the rule body: a narrowing justified by
QUOTE CONTEXT never licenses shrinking a CHARACTER CLASS. Re-use the original
class (`FUNSUB_BLANK_RX`) so parity is structural. On the fail-closed side
over-matching is free — whether a given bash build accepts each blank as a funsub
opener is UNVERIFIED and deliberately not relied upon.


## Directional invariant — which sites keep the FLAT executing-construct regex

`#1390` review raised a structural risk in the #1363 clause: it named the three
sites CONVERTED to the quote-aware predicate and gave no exemption criterion for
the ones that stayed flat. A later reader — or a `/redteam` round applying the
MUST literally, which the clause's own Detection-mechanism field prescribes —
would read the survivors as an unfinished migration and "complete" it. That would
move all three **fail-OPEN**, i.e. the clause would have caused the class it
exists to prevent. The rule now states the criterion DIRECTIONALLY. This section
carries the per-site accounting.

**The invariant.** The flat regex OVER-matches. At every site where it survives,
it is used in a direction where over-matching is fail-CLOSED — it forces a raw
re-scan, retains a wider scope, or declines to mask. Converting those sites to
the quote-aware form would make each match *less*, which moves every one of them
fail-OPEN.

| site | use | direction of a MATCH | why flat is correct |
| --- | --- | --- | --- |
| `_maskDataHeredocBodies` — `bodyInert` | `delimQuoted \|\| !RX.test(body)` (NEGATED) | match ⇒ `bodyInert` false ⇒ body NOT masked ⇒ raw scan sees it | TIGHTENS. Independently, a heredoc body has **no shell quoting at all** — its `'`/`"` are literal bytes — so a quote-aware scan would be categorically wrong here, not merely narrower. |
| `detectStateFileMutation` — `narrowable` | `!RX.test(command) && …` | match ⇒ `narrowable` false ⇒ WIDE whole-command scope retained | TIGHTENS. Additionally redundant: every construct the regex matches contains `$` or a backtick, both already excluded by the adjacent `includes` conjuncts (see F1390-2). |
| `detectRepoScopeDriftBash` — segment split | `RX.test(qSeg)` on the QUOTE-MASKED segment | match ⇒ fail-closed raw re-split (more segments scanned) | TIGHTENS — and it tests the already quote-MASKED segment, where a single-quoted backtick is already `x` filler, so this site was **immune to the #1363 class by construction**. |

**Executed check — committed, CI-gated, and mutation-tested.** The invariant is
pinned by three tests in
`.claude/audit-fixtures/violation-patterns/detectStateFileMutation/test.mjs`
(`directional site 1|2|3`), not by a throwaway script. An earlier draft used an
uncommitted probe reporting `directional violations: 0`; that number was
withdrawn — it was not re-runnable by a reviewer, and **mutation testing showed
all three of its rows failed to catch the very conversion the rule forbids**.

The correction, measured by converting each flat site to the quote-aware
predicate and re-running the suite:

| site | conversion caught? | why |
| --- | --- | --- |
| 1 — heredoc `bodyInert` | **YES — suite goes RED** | genuinely fail-OPEN to convert |
| 2 — `narrowable` | no | conversion is BEHAVIOUR-NEUTRAL today (see below) |
| 3 — repo-scope splitter | no | conversion is BEHAVIOUR-NEUTRAL today (see below) |

**Site 1 is the load-bearing guard, and its discriminator is precise.** The
payload puts a backtick inside BALANCED SINGLE QUOTES in a heredoc body with an
UNQUOTED delimiter:

```
gh issue create --title t --body "$(cat <<EOF
note: '`rm <state>`' is bad
EOF
)"
```

Inside a heredoc body those quotes are LITERAL BYTES — bash still runs the
backtick — so the body is genuinely executing. Verified directly on that body:
flat `= true`, `hasActiveExecutingConstruct` `= false`. Converting site 1 would
therefore mask a real mutation, and the test returns `{layer:2, kind:"rm"}` today
and `null` under the conversion. This is the concrete form of "a heredoc body is
categorically quote-free, so a quote-aware scan there is wrong in KIND".

**Sites 2 and 3 are neutral to convert, and the tests say so rather than
implying coverage.** Site 2's EXECUTES conjunct sits beside `!includes("$")` /
``!includes("`")``; every construct the flat regex matches contains a `$` or a
backtick, so `narrowable` is already false via those conjuncts (F1390-2) — the
conjunct only becomes load-bearing if the regex gains a construct with NEITHER
character. Site 3 tests the ALREADY quote-MASKED segment, where single-quoted
content is `x` filler, so both predicates agree by construction — the same fact
that made it immune to the #1363 class.

So the directional MUST's fail-open guard rests on **site 1**, which is strict;
sites 2 and 3 pin current correct behaviour. Stating that beats an aggregate
"0 violations" that would imply a guard on all three.

**Reading rule for future rounds.** The number of remaining flat references is
NOT a migration backlog and MUST NOT be driven to zero by count. Ask instead:
*at this site, does a match relax or tighten detection?* Relaxes ⇒ quote-aware.
Tightens ⇒ flat.
