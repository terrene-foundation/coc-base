# codex-dispatcher audit fixtures

Fixture set for `.claude/codex-templates/bin/coc` — the unified Codex
phase dispatcher that replaces the deprecated `/prompts:<name>`
invocation surface upstream (OpenAI Codex CLI 0.128+; openai/codex#9848;
loom issue #385).

## Cases (8)

| ID  | Name                       | Asserts                                                        |
| --- | -------------------------- | -------------------------------------------------------------- |
| 01  | no-args                    | exit 2; usage on stderr                                        |
| 02  | invalid-phase              | exit 3; "schema file ... not found" + phases list              |
| 03  | valid-phase-argv-tty       | exit 0; forwards `codex exec --json --output-schema=<phase>`   |
| 04  | valid-phase-argv-nontty    | **REGRESSION GUARD for CRIT H-1** — argv wins in non-TTY ctx   |
| 05  | piped-stdin                | exit 0; stdin used as prompt when no argv                      |
| 06  | empty-prompt               | exit 2; whitespace-only stdin rejected                         |
| 07  | phase-suffix-shim          | exit 0; basename-driven phase via `coc-<phase>` symlink        |
| 08  | traversal-rejected         | **REGRESSION GUARD for HIGH S-1** — phase-name path-traversal  |

## Invocation

```bash
node .claude/audit-fixtures/codex-dispatcher/run.mjs
```

Exit 0 = all cases pass; 1 = at least one regression.

## Stubbing

The runner stubs `codex` on PATH so the dispatcher's forward to
`codex exec --json ...` produces a deterministic marker line
(`STUB_CODEX_FORWARDED: <args>`) without requiring a real Codex CLI in
CI. Every case that successfully reaches `exec codex exec ...` emits
the marker; every case that exits BEFORE exec emits the dispatcher's
own error/usage text.

## Fixture layout: inline-runner vs sidecar (per `cc-artifacts.md` Rule 9)

`rules/cc-artifacts.md` Rule 9 ("Audit Tools Ship With Committed Test
Fixtures") mandates committed fixtures per scope-restriction predicate.
The example block in that rule shows the **sidecar layout** — each case
gets a `<id>.<ext>` input file paired with an `<id>.expected` output file
loaded by a generic runner.

This fixture set uses an alternative **inline-runner layout**: all 8 cases
(input + expected exit code + expected stderr substring) are defined as
literal objects inside `run.mjs`, and `run.mjs` is both the runner AND the
fixture data. Both layouts are Rule-9-compliant — the load-bearing
primitive is the runner contract (assert expected vs actual + non-zero on
mismatch), NOT the storage shape. Storage is operator-choice:

- **Sidecar layout** — preferred when the input data is large (>50 lines
  of text/JSON per case), when cases share a common harness across many
  detectors (e.g. `audit-fixtures/violation-patterns/<detector>/*.txt`
  loaded by a shared verifier), or when external tools (CodeQL fixtures,
  third-party linters) require disk-resident input files.

- **Inline-runner layout** — preferred when cases are short (≤5 lines of
  shell args / stdin / env per case), case set is small (≤20), the cases
  are tightly coupled to a single runner's behavior (no cross-detector
  reuse), and the inputs include shell quirks (TTY/non-TTY context,
  pipe behavior, env vars) that are clearer expressed as JS objects than
  as separate fixture files.

The codex-dispatcher fixtures are inline because: (a) cases include
non-TTY child-process spawning + stdin piping + symlink invocation —
behaviors that are clearer as JS than as sidecar files, (b) the 8 cases
are tightly coupled to the `bin/coc` dispatcher contract specifically (no
cross-detector reuse), (c) each case is ≤10 lines.

See `cc-architect` Round 2 LOW-2 disposition + journal/0167 § R3 wave
for the receipt-bearing rationale.

## Regression guards

The fixture set carries two named regression guards covering the
load-bearing defects surfaced at Round 1 redteam (2026-05-28):

- **04-valid-phase-argv-nontty** — CRIT H-1: pre-R2 the dispatcher's
  stdin probe (`! -t 0`) fired BEFORE the argv check, so any non-TTY
  invocation (CI/cron, agent subshell, `Bash(...)` tool call from CC
  orchestrating Codex) with empty stdin produced
  "ERROR: prompt is empty" exit 2 even when argv carried the prompt.
  The R2 fix inverts precedence — argv wins when present; stdin is
  the fallback only when no positional args. This case exercises the
  failure mode by passing empty stdin alongside argv `["analyze", "test prompt"]`
  in a non-TTY child process; expected exit is 0 (forward to codex exec).

- **08-traversal-rejected** — HIGH S-1: pre-R2 the dispatcher accepted
  any phase string and constructed `${PROJECT_ROOT}/.claude/wrappers/schemas/<phase>.schema.json`
  before the existence check, so a crafted `../../../etc/passwd` would
  resolve into arbitrary `.schema.json` paths (the existence check
  caught the file-not-found case, but the SHAPE was wrong). The R2
  fix validates phase names against `^[a-z][a-z0-9-]*$` immediately
  after binding the phase variable. This case exercises the failure
  mode by passing `../../foo` as the phase; expected exit is 2 with
  a phase-name-invalid error on stderr.
