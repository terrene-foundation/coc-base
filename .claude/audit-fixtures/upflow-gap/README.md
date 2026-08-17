# `upflow-gap` audit fixtures

Structural fixture set for `.claude/bin/lib/fleet-upflow-gap.mjs` — the
AUTHORED-vs-OFFERED upflow-invisibility probe (loom#1751 part b). Registered in
`.claude/test-harness/eval-manifest.json::upflow-gap` and pinned in
`coc-manifest-integrity.mjs::IN_CODE_PIN_SETS['coc-source'].requiredStructuralEntries`.

## Scenario shape (hermetic — no resolver, no cross-repo reads)

Each fixture is a self-contained tree the scanner drives via `--root <fixture> --json`:

```
<fixture>/
  canon/.claude/**                              the canon (loom) surface
  canon/.claude/variants/<v>/**                 variant overlays, also canon
  canon/.claude/upflow-dispositions.json        optional disposition ledger
  producers/<logical-key>/.claude/**            one or more producing repos
  producers/<logical-key>/.claude/.proposals/** the offer corpus (latest + archive)
```

No fixture contains an absolute path, operator home directory, or real checkout
location. Producing repos use the synthetic key `build.demo`.

## Why these cases

The set is bipolar (8 clean / 6 violation) and every critical check owns at
least one violation case. Four of the clean cases exist because they are the
ways this probe would otherwise produce a **confidently wrong** answer:

| Fixture | The wrong answer it prevents |
| --- | --- |
| `clean-canon-variant-overlay` | An artifact landed in canon as a `variants/<lang>/` overlay reads as "locally authored, never offered" if the canon set is built from `.claude/` alone. This is not hypothetical — it is the shape that made loom#1751's own table list two already-landed rs hooks as absent. |
| `clean-offered-in-archive` | An artifact offered in a PRIOR cycle reads as never-offered if the corpus is `latest.yaml` only. Also the exact scope limit of the issue's original instrument. |
| `clean-offered-as-companion` | An artifact offered as a bare path string under `companions:` — no entry key at all — is invisible to every entry-key parser. |
| `clean-fp-operator-local-config` | `*.local.*` config and dotfiles must never be enumerated: they are not COC artifacts, and naming one would leak operator layout into output. |
| `clean-not-a-coc-producer` | A repo in a producing namespace that carries no COC artifact class at all has nothing to offer by construction. Reporting it as a finding would train the reader to discount the list — which is how a triage surface dies. Distinct from `violation-missing-proposals-dir`, where a repo HAS a COC surface and no offer corpus, and so can never upflow anything. |

`violation-nested-id-subkey-manifest` is the counterpart trap: a manifest whose
entry key is `- file:` while its `- id:` occurrences are nested sub-keys at a
deeper indent. A parser keyed on `- id:` miscounts it and mis-answers
membership. The fixture asserts the probe surfaces the genuinely-unoffered hook
and NOT the offered one.

## Verdict semantics

`passed:false` / exit 1 mean **the probe found rows**, never "the repo is
non-compliant". A surfaced row is a decision owed; `keep-local` is a legitimate
answer, recorded in the disposition ledger. Nothing in CI consumes this exit
code.
