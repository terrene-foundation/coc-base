---
id: "S47-LOOM-DOCTOR"
name: loom-doctor
description: "/loom doctor procedure: read-only onboarding health-check (role, env/versions, line-endings, VCS-host auth, resolver) — all findings at once with remediation."
---

# /loom doctor — onboarding health-check runbook

This skill is the procedural detail for the `doctor` command
(`.claude/commands/doctor.md`). The command is the entry point; this skill is
the runbook + the contract the check engine (`.claude/bin/loom-doctor.mjs`)
honors.

## When to use

- A fresh operator clones a repo (loom, a USE template, or a downstream
  consumer) on a new workstation — especially Windows or an ADO host — and wants
  the full onboarding picture before `/onboard`.
- After a layout change (moved repos, new `loom-links.local.json`) to confirm
  the resolver still resolves.
- As the FIRST step of onboarding: run `loom doctor`, fix what it surfaces, then
  `/onboard` — the `/onboard` command preamble points back here.

## Read-only contract

`loom doctor` in its default mode writes ZERO state. Every check is a read:

| Check          | Source (read-only)                                  | Status semantics                                                  |
| -------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `role`         | `loom-links.mjs::resolveRole()`                     | ok=declared · warn=null (undeclared) · crit=malformed (LinkError) |
| `node`         | `process.versions.node`                             | ok=≥floor · crit=below floor                                      |
| `git`          | `git --version`                                     | ok=present · crit=missing                                         |
| `line-endings` | `git config --get core.autocrlf` + `.gitattributes` | ok=clean · warn=autocrlf true · info=no contract                  |
| `gh`           | `gh --version` + `gh auth status`                   | ok=authed · warn=present-unauthed · info=absent                   |
| `az`           | `az --version` + `az account show`                  | ok=authed · warn=present-unauthed · info=absent                   |
| `vcs-host`     | derived from gh/az                                  | ok=≥1 host authed · warn=none authed                              |
| `resolver`     | `resolveAll()` / `isConfigured()`                   | ok=all resolve · warn=error cells · info=not configured           |

**`resolveAll()` takes NO opts** (G3 grounding correction — the plan's
`resolveAll({require:false})` was wrong). Role comes from the SEPARATE
`resolveRole()` export, which returns `"platform"|"build"|"use-consumer"|null`
with precedence `resolver role:` → `.coc-role` marker → `null`.

## Engine contract — `runDoctor(opts)`

The engine is dependency-injected so the unit tests
(`.claude/bin/loom-doctor.test.mjs`) drive every branch deterministically:

```js
import { runDoctor, formatReport } from "../../bin/loom-doctor.mjs";
const result = runDoctor({
  // all optional; defaults hit the real environment
  resolveRole,
  resolveAll,
  isConfigured, // loom-links seams
  exec, // (cmd, args) => {ok, missing, code, stdout, stderr}
  readFile, // (path) => string | null
  nodeVersion, // string
});
// result = { schema_version, checks: [{id, status, detail, remediation, ...}], summary: {ok,warn,crit,info} }
```

`exec` never throws — a missing tool returns `{ok:false, missing:true}`, so an
absent `gh`/`az` degrades to `info`, never a crash. The same seams back the
`--json` schema output and the `--fix` auto-repair (`runFix`).

## Output discipline

- The report is **all-at-once** — every finding, every remediation, in one pass.
  Do NOT collapse it to "looks fine" or drop the remediation lines; the
  remediation is the next step the operator takes (`user-flow-validation.md`).
- Translate each remediation to plain language for non-technical operators per
  `communication.md` (the command body carries the canonical translations).

## Modes

- **Detection (default).** Read-only; emits the all-at-once report.
- **`--fix`.** Bounded SAFE auto-repair (`runFix`): `core.autocrlf false`, register
  the coc-ledger merge driver, seed `loom-links.local.json` via the existing
  `loom-links-init.mjs` (refuses-on-exists), and write the `.coc-role` marker —
  the last ONLY with an explicit valid `--role` (NO silent guess, D2). Auto-repair
  writes to that fixed surface ONLY and NEVER touches hook-mediated protected
  state (`posture.json`, `coordination-log.jsonl`, `operators.roster.json`) per
  `multi-operator-coordination.md`.
- **`--json` / `--strict`.** `--json` emits the versioned `{schema_version, checks,
summary}` shape; under `--json`/`--strict` the process exits non-zero on any CRIT
  for CI/ADO gating. An interactive run always exits 0 (a human report never trips
  `set -e`).

## Boundary (out of scope)

- **No csq seam.** Feeding the check-group into csq's runtime doctor is a
  SECONDARY, cross-repo-gated integration (`repo-scope-discipline.md`) — out of
  scope here; the standalone `loom doctor` is the primary surface.
