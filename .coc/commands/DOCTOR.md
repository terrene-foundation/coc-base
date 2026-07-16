---
id: "DOCTOR"
name: doctor
description: "loom onboarding health-check. Read-only: role, env/versions, line-endings, VCS-host auth, resolver — all at once with remediation."
---

`loom doctor` is the onboarding health-check. It surfaces EVERY onboarding issue
at once with an actionable remediation per finding — so a fresh operator on a
Windows / ADO / USE-consumer clone sees the full picture before `/onboard`,
not one cryptic failure at a time.

**Modes.** Read-only detection by default; `--fix` applies bounded SAFE repairs
(git config, the `.coc-role` marker with an explicit `--role`, the resolver
seed — never hook-mediated state); `--json` emits a versioned schema and
`--strict` exits non-zero on any CRIT for CI/ADO pipelines. The procedural
detail lives in the backing skill `.claude/skills/47-loom-doctor/`.

## Steps

1. Run the check engine (read-only by default):

   ```bash
   node .claude/bin/loom-doctor.mjs            # human report
   node .claude/bin/loom-doctor.mjs --fix      # apply safe repairs
   ```

2. Present the report as-is (it is already grouped + all-at-once). Do NOT
   re-summarize away the per-finding remediation lines — the remediation IS the
   value (`user-flow-validation.md`: the next step the user takes must be legible).

3. For any `[CRIT]` or `[WARN]` finding, restate the remediation in plain
   language per `communication.md` (many onboarding operators are non-technical):
   - **role: no role declared** → "this clone hasn't been told whether it's a
     platform / build / use-consumer checkout; create a `.coc-role` file at the
     repo root with one of those words."
   - **line-endings: core.autocrlf=true** → "Windows line-ending auto-conversion
     is on; it fights the repo's normalization. Turn it off with
     `git config core.autocrlf false`."
   - **vcs-host: no host authenticated** → "you're not logged in to GitHub
     (`gh`) or Azure DevOps (`az`); log in to your host before onboarding."
   - **resolver: link(s) fail to resolve** → "one of your declared repo paths
     points at a directory that isn't there; fix the path in
     `loom-links.local.json`."

4. If all checks are clean, say so plainly and point at `/onboard` as the next
   step.

## Checks (read-only)

| Check          | What it verifies                                                         |
| -------------- | ------------------------------------------------------------------------ |
| `role`         | `resolveRole()` → platform / build / use-consumer / null (undeclared)    |
| `node`         | node major version ≥ the supported floor                                 |
| `git`          | git present (mandatory)                                                  |
| `line-endings` | `core.autocrlf` + `.gitattributes` eol=lf contract                       |
| `merge-driver` | coc-ledger 3-way merge driver registered (when `.gitattributes` uses it) |
| `gh`           | GitHub CLI presence + auth (for a GitHub host)                           |
| `az`           | Azure CLI presence + auth (for an ADO host)                              |
| `vcs-host`     | derived: at least one VCS host authenticated                             |
| `resolver`     | `resolveAll()` link errors / resolver-absent USE-consumer                |

## Notes

- **Run `loom doctor` BEFORE `/onboard`** — the `/onboard` command preamble points back here.
- The engine takes injectable seams (`runDoctor(opts)` / `runFix(result, opts)`); the
  unit tests at `.claude/bin/loom-doctor.test.mjs` drive every check + repair branch.
- `--fix` writes ONLY to the safe surface (git config, the resolver seed, `.coc-role`
  with an explicit `--role`) and never to hook-mediated state.
