# `.claude/ci-authz/` — CI runner-pool authorization receipts

Holds the operator's grant to spend **GitHub-hosted** runner minutes when the
local self-hosted pool is saturated. Read by
`.claude/hooks/ci-runner-saturation-guard.js` via
`hooks/lib/ci-runner-saturation.js::readBlanket`.

## The procedure this serves

1. A CI-triggering `git push` is proposed.
2. The guard probes the org's self-hosted pool. **0 idle ⇒ the run will queue.**
3. With no grant in force it asks the operator: queue to local, or use
   GitHub-hosted. It never refuses the push — which pool to spend is the
   operator's call, and the predicate's CI-triggering half is lexical, so
   `hook-output-discipline.md` MUST-2 caps it below `block` anyway.

## `github-hosted-allow` — the session blanket

A file whose **body is the operator's stated reason**. Its presence stops the
guard asking for the rest of the session.

**An empty file is NOT a grant.** The body is read and must be non-empty — the
same rule `.claude/wip-authz/wip-limit-allow` uses, so a stray `touch` or a
half-finished redirect cannot authorize minute-spend.

Unlike the WIP receipt, this one is **not consumed on use**: the operator's
answer to "this batch of CI work is worth GitHub-hosted minutes" is a decision
about a session, not about one command, and re-asking on every push would be the
notification fatigue that teaches operators to ignore the surface.

Delete the file to withdraw the grant.

## Why this README is TRACKED, and why that is load-bearing

**Git cannot carry an empty directory**, and the grant file is operator-created
and frequently absent — so without a tracked file here the directory would not
survive a clean checkout, and `readBlanket` would resolve against a path that
does not exist.

That failure would be SILENT and in the SAFE direction (a missing file reads as
"no grant", so the guard asks), which is exactly what makes it worth pinning: a
fence that degrades quietly toward asking is one nobody notices is broken until
they wonder why a granted blanket stopped being honoured.

Sibling precedent, tracked for the same reason:
`.claude/wip-authz/README.md`, `.claude/cross-repo-authz/README.md`,
`.claude/worktree-authz/README.md`.

## What the guard does NOT do

- It does not decide whether CI will PASS. It answers one question — is the
  local pool full right now.
- It does not edit `runs-on`. Moving a job between pools is a shared-CI change
  that lands on the default branch unless reverted, and a job pinned to a
  self-hosted pool is often pinned for a tracked platform reason. The guard
  surfaces the choice; a human makes the edit.
- It does nothing at all where it does not apply. An org with no self-hosted
  runners returns `applicable: false` and the guard is silent — which matters,
  because this capability cascades to every downstream BUILD and USE target and
  must cost nothing on the repos that never had a local pool.
