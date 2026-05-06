# Model Optimization Workspace

**Date**: 2026-03-11
**Status**: Ready for review
**Purpose**: Optimize Claude model assignments (Opus vs Sonnet) across the entire COC ecosystem

## Repos Audited

| #   | Repo                   | Type                    |
| --- | ---------------------- | ----------------------- |
| 1   | Governance KB          | Governance KB           |
| 2   | Kailash Python SDK     | BUILD (SDK development) |
| 3   | Kailash Python USE     | USE template (end-user) |
| 4   | Kailash Rust BUILD/USE | BUILD + USE template    |

## Documents

| Document                        | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `01-opus-vs-sonnet-research.md` | Comparative performance analysis with benchmarks |
| `02-ecosystem-inventory.md`     | Complete inventory across all 4 repos            |
| `03-recommendations.md`         | Per-repo model assignments with rationale        |
| `04-implementation-plan.md`     | Exact changes to apply to each repo              |

## Guiding Principle

> "Token use is secondary to performance. Do not sacrifice ANY performance for token use."

Sonnet is recommended ONLY where research demonstrates equivalent or superior performance to Opus for that task category. Where evidence is marginal, Opus is retained.
