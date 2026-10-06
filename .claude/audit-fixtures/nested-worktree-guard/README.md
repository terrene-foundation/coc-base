# nested-worktree-guard fixtures

Committed fixtures for `.claude/hooks/nested-worktree-guard.js` per
`cc-artifacts.md` Rule 9 + `hook-output-discipline.md` MUST-4.

```bash
node .claude/audit-fixtures/nested-worktree-guard/run.mjs                  # 35 cases
node .claude/audit-fixtures/nested-worktree-guard/run.mjs --mutation-check # M0 + A0 controls + 13 mutants
```

Both exit 0 on success, **from any working directory**. The harness pins the
hook's child cwd to the repo root: the hook resolves its receipt and its git
boundary roots cwd-relatively while the harness writes the receipt at an absolute
path, so an inherited cwd would fail the receipt rows AND report `FAIL M0-control`
— which by the design below makes every `KILLED` verdict meaningless. Run it from
both places if you touch the harness.

## Fixture classes

| Prefix   | Expectation   | Predicate under test                                                                                                              |
| -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `flag-`  | `BLOCKED`     | `tool_input.isolation === "worktree"` (case/space-insensitive), OR an `EnterWorktree` whose RESOLVED TARGET is a nested placement |
| `clean-` | `PASSTHROUGH` | everything else — a wedge here wedges every delegation in the repo                                                                |

An unrecognized prefix is a hard error, not a silent `PASSTHROUGH` default: a
typo'd `flg-` fixture intended to block would otherwise be asserted to pass.

Inline (in `run.mjs`, not files): empty stdin, malformed JSON, JSON `null`, both
override channels, the one-shot receipt's consumption, the instructAndWait
block-body shape, and the five **path-target** rows — which must be built at
setup time because they need the REAL repo layout (a live symlink, this
machine's repo top, its actual sibling-worktree root, a non-git cwd), none of
which a static JSON fixture can name.

## Matcher bound, stated rather than implied

The hook is registered at `PreToolUse` on `Task|Agent|EnterWorktree`, NOT on `*`:
`hook-event-selection.md` MUST-3 forbids a `guard`-class hook from claiming a `*`
matcher, and `validate-emit.mjs::hook-event-declaration` FAILS on it. The
DETECTOR still keys on the isolation PARAMETER rather than a tool-name allowlist,
so `flag-unknown-delegation-tool-name.json` (a future tool name carrying the same
flag) is blocked when the hook is invoked at all. The residual is honest and
recorded here: a future delegation tool under a name outside those three would
not INVOKE this hook. The remedy is a one-line matcher edit in `settings.json`,
not a wider hook class. `validate-emit.mjs` MUST-4 enforces that the
`@hook-event:` marker set and the `settings.json` registration set stay equal, so
the matcher cannot drift from the declaration silently.

## The resolved-target discriminator

`EnterWorktree` is judged on WHERE the agent gets rooted, never on which KEY
carries it. Keying on `name` WITHOUT `path` means appending a `path` key DISARMS
the block, and leaves the `path` form unchecked entirely:

```
{"tool_name":"EnterWorktree","tool_input":{"path":"<repo>/.claude/worktrees/agent-99"}}   → would pass
{"tool_input":{"name":"agent-99","path":"<repo>/.claude/worktrees/agent-99"}}             → would pass
```

A `block`-grade detector that a surface rewrite evades is exactly what
`hook-output-discipline.md` MUST-2 forbids. Two INDEPENDENT edges decide, each
with its own uniquely-killing fixture so neither masks the other's mutation:

| Edge        | Fires on                                                    | Sole killer fixture                                   |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| SEGMENTS    | resolved path carries `.claude/worktrees`                   | `flag-enterworktree-path-nested-segments.json` (M11)  |
| CONTAINMENT | resolved path strictly inside a resolved repo boundary root | `<path> symlink resolving back INSIDE the repo` (M10) |

Per `security.md` § Path Containment BOTH candidate and boundary root go through
the SAME resolver and the check FAILS CLOSED when either will not resolve — so a
symlink at a lexically-outside path that resolves back into the repo is caught,
and an undecidable containment question is answered "contained" rather than waved
through. Containment is STRICT: re-rooting AT the repo top is not a nested
worktree, and blocking it would refuse a no-op re-root.

## The load-bearing negative control

`clean-prose-mentions-isolation-worktree.json` is a `Task` whose **prompt text**
contains the literal characters `isolation: "worktree"` — the RETIRED flag
`worktree-isolation.md` Rule 1(a) BLOCKS — while its `tool_input` carries no such
**parameter**. It MUST pass.

That single fixture is what separates a structural detector (reads the field the
harness acts on — `hook-output-discipline.md` MUST-2's bar for `block` severity)
from a lexical one (greps the payload — which MUST-2 forbids from carrying
`block`).

**It is proven load-bearing, not assumed.** Mutant `M3` dies on **exactly one**
fixture — this one (measured: `killed by: clean-prose-mentions-isolation-worktree.json`,
1 fixture failure). No other `clean-` fixture carries the lowercase substring
`worktree` in free text; if you add one that does, M3's kill count rises above 1
and this property is silently lost.

## Why a mutation check ships with the fixtures

A fixture suite that passes against a **defeated** guard is the same inert-green
failure the guard exists to close.

`--mutation-check` first runs **M0-control**: the re-rooted but otherwise
UNMODIFIED hook, which MUST pass the entire suite. Without it, a mutant that
merely _crashes_ (broken re-root, missing `lib/`, syntax error) scores fixture
failures and is misreported as `KILLED` — the harness would print "N/N killed"
while testing nothing. **A0-control** is its arity sibling: it fires the
anchor-arity checker at known-answer inputs (a zero-match anchor, a two-match
anchor, a one-match anchor) before any of its verdicts are trusted, per
`instrument-discipline.md` MUST-3(a). Either control failing returns NO
`MUTATION-BATTERY` line at all rather than a fabricated ratio.

Then thirteen targeted single-line defeats, each of which the fixture set must
catch. The harness prints each mutant's killer rows, so the single-fixture
property below is verifiable rather than asserted:

| Mutant                           | Defect reproduced                                                                 | Kills |
| -------------------------------- | --------------------------------------------------------------------------------- | ----- |
| `M1-neutered-predicate`          | detector always returns null — "registered but inert"                             | 21    |
| `M2-sync-stdin-drain`            | synchronous `process.stdin.read()` drain: 0 bytes, always passes                  | 21    |
| `M3-lexical-not-structural`      | substring-greps the payload — false-positives on the negative control             | 1     |
| `M4-escape-hatch-always-on`      | override treated as always set — block never fires                                | 19    |
| `M5-no-normalization`            | drops `.trim().toLowerCase()` — locks the mixed-case fixture                      | 1     |
| `M6-enterworktree-blind`         | drops the whole `EnterWorktree` route                                             | 8     |
| `M7-unsanitized-interpolation`   | `safeField` becomes identity — locks the control-byte / forged-marker fixtures    | 2     |
| `M8-path-key-disarms-name`       | reverts to `hasName && !hasPath` — the evasion above                              | 1     |
| `M9-path-target-unchecked`       | `path` targets never classified — the "any path is a sibling" assumption          | 4     |
| `M10-lexical-not-realpath`       | drops symlink resolution — a symlink into the repo escapes                        | 1     |
| `M11-segment-edge-blind`         | drops the `.claude/worktrees` edge — misses a nested placement under ANOTHER repo | 1     |
| `M12-fail-open-undecidable`      | waves through an undecidable containment instead of failing closed                | 1     |
| `M13-tool-name-fallback-dropped` | drops the `payload.tool` fallback sibling hooks accept                            | 1     |

A mutant reported `SURVIVED` means the fixture set has a hole, and the harness
exits non-zero. If a mutant's anchor no longer matches EXACTLY ONE site in the
hook, or the re-root anchor is gone, the harness fails loudly rather than
silently testing nothing.

## Environment hygiene

The suite strips `COC_ALLOW_NESTED_WORKTREE` from the base environment and clears
any stray receipt before every case. The operator running this suite is, by
construction, the person most likely to have just set the override after hitting
the block — inheriting it would make every `flag-` fixture pass and the suite
meaningless.

Origin: 2026-08-19 — Gate-1 ingest of a BUILD-stream structural guard loom lacked
entirely, genericized. Rule: `worktree-isolation.md` Rules 1 + 7.
