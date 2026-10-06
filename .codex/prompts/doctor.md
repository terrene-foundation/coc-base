---
name: doctor
description: "Check onboarding health: role, environment, line endings, VCS auth, and resolver; read-only with remediation."
---

`loom doctor` is the onboarding health-check. It surfaces EVERY onboarding issue
at once with an actionable remediation per finding — so a fresh operator on a
Windows / ADO / USE-consumer clone sees the full picture before `/onboard`,
not one cryptic failure at a time.

**Modes.** Read-only detection by default; `--fix` applies bounded SAFE repairs
(git config, the `.coc-role` marker with an explicit `--role`, the resolver
seed — never hook-mediated state); `--json` emits a versioned schema and
`--strict` exits non-zero on any CRIT for CI/ADO pipelines. The procedural
detail lives in the backing skill `.agents/skills/47-loom-doctor/`.

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

## Gate-2 target protection (`--targets`, opt-in)

The ONE check that leaves this repo. For each Gate-2 distribution target declared in
the ecosystem config (`build.*` + `use-template.*` in `remote_links`), it resolves the
repo's default branch and reports whether that branch carries **≥1 REQUIRED status
check** and whether **`enforce_admins`** is on.

```bash
node .claude/bin/loom-doctor.mjs --targets                     # resolve each default branch
node .claude/bin/loom-doctor.mjs --targets --target-base main  # skip the lookup, probe 'main'
node .claude/bin/loom-doctor.mjs --target-repo use-template.py # ONE target (implies --targets)
node .claude/bin/loom-doctor.mjs --target-repo <owner>/<repo>  # same, by slug
```

| Row | Meaning |
| --- | ------- |
| `[OK] gate2-target:<key>` | ≥1 required check AND `enforce_admins=on` |
| `[WARN] …enforce_admins=OFF` | required checks exist, but an admin merge bypasses them |
| `[CRIT] …NO required status check` | merges into this target are unverified BY CONSTRUCTION |
| `[CRIT] …protection UNKNOWN` | the probe did not answer — ZERO evidence, never an all-clear |

- **Opt-in.** Off by default, so an unattended `loom doctor` makes no cross-repo call.
  A default run still prints a visible `NOT PROBED` row rather than staying silent.
- **Fail-closed.** An API error, a bare 404, a permission denial, a missing `gh`, an
  unparseable body, or a failed default-branch lookup all report CRIT/UNKNOWN — the
  same severity as unprotected, never `ok` (`evidence-first-claims.md` MUST-3).
- **Report-only.** loom does not own a target's branch protection and MUST NOT edit it
  (`repo-scope-discipline.md`); every remediation names the TARGET's owner. Running it
  against real repos is a cross-repo READ and needs a `/cross-repo-authorize` receipt.
- **`--target-base` is fenced too.** The base ref is interpolated into the API path, so a
  traversal (`..`), a percent-encoded one (`%2e%2e`), a `#`, or any character git's own
  `check-ref-format` forbids is REFUSED at CRIT before any request. It is **not** a slash
  ban — `release/v1.2.3` is a real branch name and still probes.
- **`--target-repo` is an ALLOWLIST, not a free-form slug.** It accepts only the Gate-2
  targets `--targets` already probes (resolver key or `owner/repo`) plus this repo's own
  origin — so it NARROWS the enumeration and cannot widen it. It is therefore not a route
  around `/cross-repo-authorize`. Anything else is REFUSED at CRIT before any API call.
  `loom`/`atelier`/`command` are declared in `remote_links` but are NOT Gate-2 targets, so
  they are refused too. Use it to fire the instrument at a repo whose protection state you
  already know — the known-answer control that shows the check discriminates here.
- **Not a merge gate.** The Gate-2 driver's own refusal (`sync-gate2-worktree.mjs`,
  exit 6 on `--merge`) is unchanged; this is the fleet-wide reporting view of the same
  question, and reuses that driver's classifier rather than re-deriving it.

## Notes

- **Run `loom doctor` BEFORE `/onboard`** — the `/onboard` command preamble points back here.
- The engine takes injectable seams (`runDoctor(opts)` / `runFix(result, opts)`); the
  loom-side unit tests (`.claude/bin/loom-doctor.test.mjs` — loom-only, purged
  downstream per `sync-manifest.yaml`) drive every check + repair branch.
- `--fix` writes ONLY to the safe surface (git config, the resolver seed, `.coc-role`
  with an explicit `--role`) and never to hook-mediated state.
