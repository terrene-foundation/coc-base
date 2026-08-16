# CI Runner Troubleshooting

Recovery protocols and service-management reference for self-hosted GitHub Actions runners. This skill is the companion to `rules/ci-runners.md` — the rules codify what MUST happen; this skill encodes the exact commands and diagnostic flows for each failure mode.

## When To Load This Skill

Load when:

- A CI gate is red and the runner's connection state is ambiguous
- `~/.cargo/bin/rustup` or an equivalent toolchain proxy has gone missing
- The `.env` file changed and jobs still pick up stale values
- `fmt` turned green and subsequent gates started failing
- A binding-CI workflow reports "no changes" despite a transitive dependency landing

Do NOT load for runner first-time setup — that is a one-time installation reference.

## Quick Diagnostics

| Symptom                                         | Likely Cause                        | First Command                                       |
| ----------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| Runner offline in GitHub, log shows "Connected" | Runner auto-update disconnect       | `launchctl list com.github.actions.runner.<name>`   |
| `rustc: command not found` mid-job              | `~/.cargo/bin/rustup` proxy missing | `ls -la ~/.cargo/bin/rustup`                        |
| Binding CI reports "no changes"                 | Narrow `paths:` filter              | Inspect workflow `.github/workflows/*.yml` `paths:` |
| Upload step fails with quota message            | Artifact storage quota              | Check `continue-on-error: true` on the step         |
| Multiple gates red after fmt turned green       | Post-fmt cascade                    | Triage gates one at a time, oldest first            |

## Protocol A: Runner Auto-Update Disconnect

**Signal:** `gh api repos/<org>/<repo>/actions/runners` shows 0 runners, runner stdout log tails show `Connected to GitHub` and `Listening for Jobs`, PR checks hang in queue.

**Steps:**

1. Verify the disconnect: `gh api repos/<org>/<repo>/actions/runners --jq '.runners[] | {name, status}'` returns empty.
2. Restart the runner service:
   - macOS: `launchctl unload ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist && launchctl load ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist`
   - Linux (systemd): `sudo systemctl restart actions.runner.<name>.service`
3. Push a trivial trigger: `git commit --allow-empty -m "chore(ci): trigger fresh run post-runner-update" && git push`
4. Verify the new run is picked up: `gh run list --limit 1` shows the new workflow.

**DO NOT** `gh run rerun <id> --failed` — the dead worker still owns the orphaned job entries and the new worker cannot claim them.

## Protocol B: Rustup Proxy Recovery

**Signal:** `~/.cargo/bin/rustup` is missing or is a broken symlink; `cargo` / `rustc` commands fail with `command not found` in otherwise-healthy jobs.

**Steps:**

1. Confirm the breakage: `ls -la ~/.cargo/bin/rustup` shows `No such file or directory` or a dangling symlink.
2. Reinstall rustup without modifying shell init:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
   ```
3. Verify: `~/.cargo/bin/rustup --version` and `~/.cargo/bin/cargo --version`.
4. Confirm the runner's `.env` still contains `/Users/<user>/.cargo/bin` in `PATH`.
5. Restart the runner (see Protocol C step 2) so the updated `~/.cargo/bin` is indexed.

## Protocol C: .env Change Recovery

**Signal:** An edit to `~/actions-runner-<name>/.env` is in place, but new jobs still fail with the old environment.

**Steps:**

1. Wait for any in-flight job to drain (or `launchctl unload` to interrupt — only if the user accepts killing the in-flight job).
2. Restart:
   - macOS: `launchctl unload ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist && launchctl load ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist`
   - Linux: `sudo systemctl restart actions.runner.<name>.service`
3. Verify startup reads the new env: `tail -20 ~/actions-runner-<name>/_diag/runner-stdout.log` shows the fresh start timestamp.

## Protocol D: Post-fmt Cascade Triage

**Signal:** `fmt` gate goes red → green for the first time in weeks. Subsequent gates (Clippy, Docs, Deny, Test, MSRV) start failing one-at-a-time over multiple pushes.

**Steps:**

1. Accept the session will span multiple waves (budget 3–6 pushes).
2. For each wave:
   a. `gh pr checks <N>` — identify the oldest failing gate.
   b. Pull its log: `gh run view <run-id> --log-failed`.
   c. Fix the root cause in-place. Do NOT defer as "pre-existing" — see `rules/zero-tolerance.md` Rule 1.
   d. Push, wait for CI, repeat.
3. Declare "CI fixed" only when every gate in `gh pr checks` shows green or neutral — never on a mix of green-and-skipped.

**Anti-pattern:** Fixing multiple gates in parallel branches. Each wave's fix depends on the previous wave's state; parallel branches merge-conflict at the state level.

## Protocol E: Binding-CI Path Filter Drift

**Signal:** A PR modifies a shared package that a binding transitively depends on. The core-language CI runs and is green/red, but the binding CI reports "no changes — skipping."

**Steps:**

1. Inspect `.github/workflows/<binding>.yml` → `on: pull_request: paths:` block.
2. Compare against the core-language workflow (e.g. `rust.yml`, `python.yml` at the core). The binding's paths MUST cover the same shared-package tree.
3. If narrow: widen to match. Example pattern for a Rust workspace with a Python binding:
   ```yaml
   on:
     pull_request:
       paths:
         - "bindings/python/**"
         - "crates/**"
         - "Cargo.toml"
         - "Cargo.lock"
         - ".github/workflows/python.yml"
   ```
4. Commit the widening in the same PR that surfaced the drift — not a follow-up PR.

## Service Management Reference

### macOS (launchd)

```bash
# Check status
launchctl list com.github.actions.runner.<name>

# Start / Stop
launchctl load   ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist
launchctl unload ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist

# Restart (after .env change)
launchctl unload ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist && \
launchctl load   ~/Library/LaunchAgents/com.github.actions.runner.<name>.plist

# Live logs
tail -f ~/actions-runner-<name>/_diag/runner-stdout.log

# Job logs (most-recent worker)
ls -lt ~/actions-runner-<name>/_diag/Worker_*.log | head -3
tail -50 ~/actions-runner-<name>/_diag/Worker_<timestamp>-utc.log
```

### Linux (systemd)

```bash
# Check status
sudo systemctl status actions.runner.<name>.service

# Restart
sudo systemctl restart actions.runner.<name>.service

# Live logs
journalctl -u actions.runner.<name>.service -f

# Job logs
ls -lt ~/actions-runner-<name>/_diag/Worker_*.log | head -3
```

## Registration Token Lifecycle

Tokens expire after 1 hour. Generate fresh:

```bash
gh api -X POST repos/<org>/<repo>/actions/runners/registration-token --jq '.token'
```

Never commit the token. Setup scripts use the placeholder `RUNNER_TOKEN="REPLACE_WITH_FRESH_TOKEN"` and read the actual value from an env var at runtime.

## Common Error Strings

### "Unable to locate executable file: rustc"

maturin-action or cargo-action cannot find rustc. See Protocol B.

### "Cargo metadata failed. Do you have cargo in your PATH?"

Usually the same as above — the rustup proxy is broken. A job-level `dtolnay/rust-toolchain@stable` step is the permanent fix.

### "mkdir /Users/runner: Permission denied" in setup-python

`actions/setup-python` hardcodes paths under `/Users/runner/` which do not exist on self-hosted macOS runners. Remove `actions/setup-python` and let `maturin` auto-detect interpreters from `PATH`; for Linux, use a `manylinux` Docker container.

### "Failed to restore: The operation cannot be completed in timeout"

Warning from `Swatinem/rust-cache@v2` when the Rust cache restore times out on large caches. Non-fatal — the build proceeds without cache.

### "Failed to CreateArtifact: Artifact storage quota has been hit"

Artifact quota exhaustion. `continue-on-error: true` on every `upload-artifact` step is the structural fix (see `rules/ci-runners.md` MUST NOT Rule 2).

## Related References

- `rules/ci-runners.md` — the MUST/MUST NOT rules these protocols implement
- `rules/zero-tolerance.md` Rule 1 — pre-existing failures MUST be fixed, not deferred (informs Protocol D)
- `skills/10-deployment-git/deployment-ci.md` — broader CI setup reference
- `skills/10-deployment-git/release-runbook.md` — release-pipeline-specific CI guidance

Origin: Extracted from a BUILD-repo `rules/ci-runners.md` during loom 2.8.12 — the rules file grew to 328 lines (exceeding the 200-line soft cap from `rules/rule-authoring.md`). Troubleshooting and service-management content moved here so the rules file stays focused on MUST/MUST NOT enforcement language.
