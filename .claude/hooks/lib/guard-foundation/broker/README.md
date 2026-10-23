# Guard foundation — the broker (S4)

Inside the sandbox no process can write a protected path. The broker runs OUTSIDE
the sandbox, bound to one repository, and runs only the policy's `trusted_writers`
(`policy/protected-paths.json`, loaded pin-checked through `policy/policy.mjs::loadPolicy`).

- `broker.mjs` — the policy check and the run. A request is exactly
  `{v:1, writer, args}`; the broker chooses the code, the cwd and the environment.
- `server.mjs` — the unix-socket server the launcher starts outside the sandbox:
  `node server.mjs --repo <root> [--vault D] [--config-dir D] [--home D] [--pass-env NAME]`.
  Default socket: `<home>/.cache/coc-guard-broker/<sha256(realpath repo)[:16]>.sock`
  (directory 0700, socket 0600).
- `client.mjs` — run inside the sandbox: `node client.mjs [--socket P] <writer-id> [-- <args>]`.
  The socket is `--socket`, else `$COC_GUARD_BROKER_SOCKET` (the launcher exports its
  per-launch socket there); with neither it refuses. Exit: the writer's status;
  3 refused (nothing ran); 4 wrote outside its licence; 5 no broker reachable or named.
- `log-append.js` — the broker writer `learning-log-append`: the one bytes-accepting
  route (below).
- `closure.mjs` — a writer's EXECUTION CLOSURE (below):
  `node closure.mjs rows [--repo <primary>]` prints the policy rows it needs,
  `node closure.mjs show <writer-id>` prints one writer's members and unresolved sites.

## Trusted writers run only from the primary, over a protected closure (ROOT, R1 H1)

The broker runs a writer outside the sandbox, so every file that run can EXECUTE must be
unwritable from inside it; protecting only the entry file left its libraries writable. Admission
in `broker.mjs` therefore refuses, before anything runs:

- `primary-unresolved` / `entry-not-primary` — the broker is not bound to the PRIMARY checkout,
  or the entry's real path leaves it. A lane worktree is editable lane work, so its code never
  runs here; both sides are compared as real paths;
- `closure-unresolved` — a load or spawn site in the closure (static or dynamic import, an
  evaluable `require`, a spawned node script, a git hook of the repository the writer's git acts
  on) that resolves neither statically nor by a reviewed declaration in `closure.mjs`
  (`DECLARATIONS`, each pinned by sha256 to the bytes it was reviewed against — editing a pinned
  file un-resolves its sites until it is re-pinned);
- `closure-unprotected` — a closure member that is not a protected regular file in the primary.

Variables that would move a declared code root (`ROOT_ENV`) never reach a writer. The rows a
policy needs for every writer's closure are GENERATED (`closure.mjs rows`), never hand-listed.

`land-lane` and `build-trust-root` are REFUSED (`closure-unresolved`): each loads code relative
to a requester-supplied `--repo`, which a sandboxed caller can point at writable lane work. The
refusal names every inadmissible load and says the writer is an operator step until RUN 9, when
the writer-side fix lands (ROOT ruling (c); `broker.mjs::OPERATOR_STEP_UNTIL_RUN9`). Their
closure rows are deliberately NOT in the policy: the writers stay refused regardless, and
protecting those `.claude/bin` files would block routine lane edits under the profile.

## Residuals (R1 H1/H3, as accepted)

- (a) A brokered append lands in the PRIMARY checkout's `.claude/learning/`, whichever worktree
  the hook ran in (the broker re-derives the sink from its own repo).
- (b) Each brokered append spawns a client; the cost is MEASURED, not gated, by
  `tests/broker-hook-route.test.mjs` (the 20-append case's diagnostic).
- (c) Under the profile `state-io.js::appendViolation`'s unsigned legacy row is refused by the
  signature gate — LOUDLY: stderr and the thrown `EBROKER` name the dropped row class, and
  `detect-violations.js` carries the throw into its verdict.
- (d) A declaration in `closure.mjs` is pinned to its file's sha256; editing a pinned file
  un-resolves its sites (and reds the pin test) until the declaration is re-reviewed and re-pinned.
- (e) Three quoted strings (two test fixtures, one declaration site) spell their quote as `\x22`
  so the 1471 regrowth guard's lexical scan does not read quoted text as a spawn; each is
  commented at its site.

What is refused, and the residuals: the header of `broker.mjs`.

## The broker never accepts bytes

The broker runs a protected entry script; it never writes bytes a sandboxed
process hands it. A route that did would let any sandboxed process write any
protected path. A writer that is not a script — a ceremony that edits files
through the CLI's file tools — therefore has no broker route.

## The one bytes-accepting route — two signed logs, append-only (ROOT, R1 H3)

ROOT narrowed the rule above for exactly two sinks, `.claude/learning/violations.jsonl`
and `.claude/learning/coordination-log.jsonl`. The launcher wraps the whole CLI, so hooks
run inside the profile, and every hook record for those logs is built and SIGNED inside it;
there is no other way for them to land. `append-sink.js::appendSinkLine` (and
`state-io.js::appendViolation`) hand such a line to `learning-log-append` when
`$COC_GUARD_BROKER_SOCKET` is set. That variable is a ROUTING HINT, never a security
control: a sandboxed process that unsets it gets the direct write, which the OS profile
refuses (EPERM). A refused or unreachable broker is a refused append — never a direct-write
fallback.

`log-append.js` admits a line only if ALL hold, and refuses otherwise:

1. the caller names one of the two LOGS, never a path; the sink is derived from the
   broker's repo through the hooks' own state-dir resolver;
2. it is ONE line: no CR or LF, one JSON object, at most 2048 bytes with its newline;
3. its signature verifies against an ENROLLED key through the fold's own gate
   (`coordination-log.js::_verifyRule1` over `loadFoldRoster`), and its `person_id` is the
   signer's roster person (rule 4) — so an unsigned line, an unrostered signer and a forged
   signature are refused, and an absent roster refuses everything. Consequence:
   `appendViolation`'s unsigned un-rostered fallback row is refused under the profile;
4. for coordination-log, its `(seq, prev_hash)` extends the emitter's current tail as the
   emitter computes it (`coc-emit.js::_defaultReadChainHead`), so no fork and no gap;
5. it is written by `appendSinkLine`: O_APPEND only, never truncate, rename or replace,
   refusing a symlinked or non-regular sink and a swapped or symlinked directory.

It adds no power a sandboxed process lacks (the signing key is readable inside the
sandbox); what it protects is the append-only shape of both logs and the fold's acceptance
set.

## Declared phase: fork instantiation is PRE-PROFILE, ONE-TIME

The fresh-fork setup ceremonies write protected repo-anchored files, partly
through the CLI's file tools:

- `/clean-instantiate` (`skills/46-clean-instantiate`, table row 10) — resets
  `.claude/VERSION` to `{version: "0.0.0", type}` and `.claude/bin/ecosystem.json`
  to a placeholder for a new fork;
- `/ecosystem-init` (`skills/43-ecosystem-init`) — writes the fork's own
  `.claude/bin/ecosystem.json`.

They are DECLARED to run BEFORE the launcher applies the sandbox profile: once, on
a fresh fork that has no guard yet. The launcher applies the profile afterwards,
and from then on only `land-lane` (licensed for `repo-version` and
`ecosystem-config`) changes those files. They have no broker route, by design.
