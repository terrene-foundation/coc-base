# `.claude/load-authz/` — synthetic-load override receipts

Holds the one-shot override for `.claude/hooks/synthetic-load-guard.js`, which
refuses a CPU load generator at the `PreToolUse:Bash` boundary
(`ci-cost-discipline` MUST-7, receipt `journal/0609`). The mechanism is the shared
audited-override gate in `.claude/hooks/lib/override-receipt.js`.

## What the guard refuses, and what it only reports

- **Refused (`block`)** — a dedicated load tool at a parsed command-word position:
  `stress`, `stress-ng`, `yes` to a discard sink or backgrounded with no consumer,
  `openssl speed`, `sysbench cpu`, `dd if=/dev/zero of=/dev/null` with no `count=`,
  a hash of `/dev/zero`, and similar. A bounded wrapper (`timeout 60 stress-ng`) is
  still refused, and so is a tool reached through a nested spelling: a shell body
  (`bash -c`, a here-string `bash <<<"…"`), a process substitution
  (`head <(stress-ng …)`), `find -exec`, or a command-running wrapper
  (`watch`, `flock`, `su`, `script`, `chroot`, `caffeinate`).
- **Reported, never refused (`halt-and-report`)** — an interpreter or shell loop
  whose body only reads the clock or bumps a counter (`node -e "while(true){}"`,
  `while :; do :; done`), and N copies of one launched in the background. Reading a
  program's text is a lexical signal, so it cannot block.

This receipt applies to the **refused** tier only. A reported finding never reads or
consumes it.

## `synthetic-load-allow` — the one-shot receipt

A file whose **body is your stated reason** for generating load. Write it, then
re-issue the exact refused command.

- **An empty file is NOT an override.** The body must be non-empty, so a stray
  `touch` or half-finished redirect cannot lift the refusal.
- **Consumed on use.** The receipt is deleted as it is honoured, so it lifts ONE
  call, never the rest of the session.
- **Recorded.** The stated reason is echoed back into the transcript with the
  override notice, so the decision is on the record rather than free.
- **Found in either tree.** The guard looks in the tree the command runs from AND
  in the main checkout, so a receipt an operator drops in the main checkout works
  for a call issued from a linked worktree.

Operator / CI channel: `COC_ALLOW_SYNTHETIC_LOAD=1` in the session environment. It
is checked BEFORE the receipt, so an environment-armed run never spends a receipt
an agent wrote for a later call.

Use it only when generating load is itself the task the operator assigned. A flaky
or timing-dependent test is not that task: reproduce it by forcing the budget,
injecting a clock, or stubbing the slow call.

## Why this README is TRACKED

Git cannot carry an empty directory, and the receipt file is written on demand and
normally absent. Without a tracked file here, the directory would not exist in a
clean checkout, and an agent told "write your reason to
`.claude/load-authz/synthetic-load-allow`" would first have to create a directory
nobody told it about.

The receipt file itself is NOT tracked: a committed receipt would be a standing
override for every clone. The ignore entry reaches a repository by two different
routes, and the difference matters because loom runs this guard on itself:

- **At loom** — the entry is carried in loom's own repo-root `.gitignore`
  (alongside `.claude/ci-authz/github-hosted-allow`). It has to be: loom is where
  the refusal fires and tells an agent to write the receipt, and the
  manifest-driven route below writes only a TARGET's `.gitignore`, never loom's.
- **At every consumer** — the entry arrives through
  `sync-manifest.yaml::gitignore_additions`, whose writer appends the managed
  `# >>> coc:gitignore_additions` block to the target's `.gitignore` during sync.

An earlier revision of this section said only that the entry "lives in the
repository's `.gitignore`". At loom that was FALSE when written — no such line
existed, and `git check-ignore --no-index .claude/load-authz/synthetic-load-allow`
exited 1 — so the receipt this README tells an agent to write was fully
committable. The line landed with that correction.

Sibling precedent: `.claude/ci-authz/README.md`, `.claude/wip-authz/README.md`,
`.claude/cross-repo-authz/README.md`.

## What the guard does NOT do

- It does not measure machine load. It judges the command, not the machine; the
  process-table backstop reports busy processes a session actually spawned.
- It does not run, expand, or evaluate the command. Every classification is a
  parse of the command string, and every parse failure lets the call through.
- It does not see a script FILE's contents (`node burn.js`). That launch is visible
  only once it runs, which is the backstop's layer.
- It does not refuse a PROJECT-LOCAL script whose name happens to be a load-tool
  word (`./stress`, `scripts/stress`). The basename names a file in this repo, not
  the system tool — Go's `x/tools` ships a `stress` of exactly that shape — and
  refusing it would block work an agent was told to do. Same layer as above.
- It does not read inside a container or package runner (`docker run … stress-ng`,
  `npx stress-ng`). Those put the tool word at an argv position with its own
  per-runner grammar, which this guard declines to guess at; the processes still
  land on the host table, where the backstop sees them.
