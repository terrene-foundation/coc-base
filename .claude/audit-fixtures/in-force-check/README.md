# `in-force-check` fixtures

Committed mini-roots for `.claude/bin/in-force-check.mjs`, executed by
`coc-eval-all.mjs` through the `in-force-check` entry in `eval-manifest.json`
and asserted class-by-class in
`.claude/test-harness/tests/in-force-check.test.mjs`.

## What each root has to contain, and why

The gate's `every-relation-adjudicated-claims` check is CRITICAL: a relation
that adjudicates nothing contributes a clean green while measuring nothing.
So **every** fixture carries all three relations populated — otherwise a
violation root would red on vacuity instead of on the thing it tests, and a
fixture that reds for the wrong reason is not a fixture.

That means each root holds:

| path                                    | supplies                                           |
| --------------------------------------- | -------------------------------------------------- |
| `.claude/rules/security.md`             | the `artifact-names-tool` obligation                |
| `.claude/bin/<tool>`                    | that obligation's instrument (must EXIST on disk)   |
| `.claude/hooks/demo-guard.js`           | the `hook-registration` obligation                  |
| `.claude/settings.json`                 | the CC registration surface                         |
| `.claude/codex-templates/hooks.json`    | the Codex registration surface                      |
| `.claude/gemini-templates/settings.json`| the Gemini registration surface                     |
| `.claude/ci-templates/demo-validate.yml`| the `emitted-verifier-requires` obligation          |

**The rule is `security.md` and not a made-up name.** The manifest tiers
enumerate rules INDIVIDUALLY (`- rules/cc-artifacts.md`), not by a `rules/**`
glob, so an invented filename classifies `no_tier_match`, reaches no lane, and
is dropped as non-adjudicable. Measured while these fixtures were written: the
first cut used `demo-obligation.md` and its violation pole exited **0** — the
FAIL pole did not fire, and its declared twin then reported a STALE baseline
because the gap it declared never existed. Firing each FAIL pole before
trusting it is what surfaced that.

**The lane model is always LOOM's** (`loadManifest()` reads the manifest of the
checkout the script lives in, not of `--root`). A fixture can therefore vary the
corpus and the paths it cites, never the distribution model — which is why
`.claude/bin/loom-doctor.mjs` is used wherever a root needs a tool that SHIPS
(it is on the fail-closed `ALWAYS_INCLUDE` allowlist) and
`.claude/bin/sync-tier-aware.mjs` wherever it needs one that does not (it is
positively `loom_only`). The file contents are stubs; the classifier reads the
PATH.

## The roots

| fixture                                      | pole      | pins                                                                 |
| -------------------------------------------- | --------- | -------------------------------------------------------------------- |
| `clean-all-in-force`                         | PASS      | every relation satisfied; each adjudicates at least one claim         |
| `violation-artifact-names-unshipped-tool`    | FAIL (W4) | a shipped rule invokes a `loom_only` tool                             |
| `violation-hook-unregistered-on-runtime`     | FAIL (W3) | the hook file ships; Codex/Gemini register nothing                    |
| `violation-verifier-requires-unshipped-file` | FAIL (W5) | the emitted verifier requires `sync-manifest.yaml`, an `exclude:` file |
| `clean-declared-gap`                         | PASS      | the declared twin of the W4 root — differs ONLY in the declaration    |
| `violation-stale-baseline`                   | FAIL      | a declaration with no corresponding live gap                          |
| `violation-vacuous-relation`                 | FAIL      | a relation adjudicating nothing must red, not pass free               |

`clean-declared-gap` is deliberately byte-comparable to
`violation-artifact-names-unshipped-tool` apart from its baseline file. The pair
is what makes the declaration channel falsifiable: if the declared root had no
gap at all it would be a different tree, and the pair would prove nothing.

## Two critical checks are NOT fixture-reachable — and they are not equally covered

`relations-selected` is argv-driven, so no fixture *root* reaches it — but its
FAIL branch **is** executed, by the `--relations ","` test in the suite (that
splits to zero non-empty ids and lands on the fail branch, exit 1). An earlier
revision of this file claimed no input could select zero relations; that was
false and is withdrawn.

`audience-model-loaded` is manifest-driven: `loadManifest()` always reads
**loom's** manifest, never `--root`'s, so neither a fixture nor a flag can empty
the lane set. **Its FAIL branch is not exercised anywhere.** What stands in for
it is the live-corpus *collapse floors* (`>= 6` lanes, `>= 19` runtime
audiences), which red if the model shrinks. That is weaker than executing the
branch, and it is written down here rather than left to look like coverage.

The suite's coverage test asserts this mapping EXPLICITLY, so a new critical
check cannot be added without landing in one bucket or the other.
