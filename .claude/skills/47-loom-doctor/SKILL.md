---
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
- **`--targets` (opt-in, the ONLY check that leaves this repo).** For each Gate-2
  target in the ecosystem config's `remote_links` (`build.*` + `use-template.*`;
  `loom`/`atelier`/`command` are not distribution destinations), resolve the repo's
  default branch and report whether it carries ≥1 REQUIRED status check and whether
  `enforce_admins` is on. Engine: `runTargetChecks({exec, config, configError, base,
  probeProtection, probeBranch, classifyChecks})` — async, separate from `runDoctor`
  so the default run stays 100% local, with every network seam injectable.
  `--target-base <branch>` skips the default-branch lookup; `--target-repo <key|slug>`
  narrows to ONE target and implies `--targets`.
  - **The BASE ref is fenced too** (`validateBaseRef`, B-1): it is interpolated into the
    API path, so it carries git's `check-ref-format` grammar plus `%` and `#` — both legal
    in a ref, both illegal in a URL path component (`%2e%2e` decodes server-side; `#`
    truncates client-side). Enforced at TWO surfaces through ONE helper — the flag
    boundary (`runTargetChecks`, zero API calls on refusal) and the SINK
    (`probeTargetProtectionStrict`, which no caller can bypass, including the API-derived
    default branch). NOT a slash ban: `release/v1.2.3` still probes.
  - **`--target-repo` is an ALLOWLIST** (`resolveTargetRepoArg`): the enumerated Gate-2
    targets plus this repo's own `origin` (resolved from the real git remote, never a
    hardcoded path). Everything else — including `loom`/`atelier`/`command`, which are in
    `remote_links` but are not Gate-2 targets — is REFUSED at `crit` before any API call.
    It NARROWS the enumeration and cannot widen it, so it adds no reach `--targets` lacks
    and is not a route around `/cross-repo-authorize`. Its purpose is the known-answer
    control: fire the check at a repo whose protection state is independently known.
  - **Report-only.** It NEVER writes to a target; loom does not own a target's branch
    protection (`repo-scope-discipline.md`) and every remediation names the target's
    owner. A live run is a cross-repo READ and needs a `/cross-repo-authorize` receipt.
  - **Fail-closed.** API error, bare 404, permission denial, missing `gh`, unparseable
    body, failed default-branch lookup, or an unloadable classifier all report
    UNKNOWN at `crit` — never `ok` (`evidence-first-claims.md` MUST-3). Only a 404
    whose body says `Branch not protected` is read as determinate.
  - **Key-presence, not `?.`.** ABSENT / PRESENT-AND-NULL / PRESENT-AND-EMPTY are
    three repo states with three remedies; an optional chain collapses them to one
    falsy value and would print the same thing whether the target is protected or
    not (`instrument-discipline.md` MUST-1). An absent `enforce_admins` key is
    `unknown`, never `off`.
  - **SSOT.** The required-status-check classifier is the Gate-2 driver's exported
    `classifyTargetVerifiability`, not a second copy (`security.md` §
    Enforcement-Surface Parity). Fixtures + measured mutations:
    `.claude/audit-fixtures/doctor-target-protection/`.

## Boundary (out of scope)

- **No csq seam.** Feeding the check-group into csq's runtime doctor is a
  SECONDARY, cross-repo-gated integration (`repo-scope-discipline.md`) — out of
  scope here; the standalone `loom doctor` is the primary surface.
