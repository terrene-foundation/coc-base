# `@hook-contract` authoring contract (loom.hook-registry/v1)

Every hook file that can appear as a row in an emitted `loom.hook-registry/v1`
manifest carries ONE `@hook-contract` block comment. The block carries the
fields the emitter CANNOT derive from source — they are **declarations by the
author** (`declared_by: "author"`), and the emitted manifest says so.

Mechanically derived fields (`[D]`: event, matcher, file, file_sha256, id,
order, on_incomplete / on_crash / on_timeout, timeout, source, surfaces,
payload_stdin, protocol, form, runtime, cwd_scope) are NOT written here. The
emitter computes them. Writing one here is a malformed block (the emitter
refuses unknown keys).

## Block shape

Insert ONE new block comment immediately after the file's existing header
comment (after `"use strict";` if the file has one is also fine — anywhere in
the file works, the parser scans the whole source; a placement next to the
header is for readers).

```js
/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [".claude/learning/violations.jsonl"],
 *     "network": false,
 *     "spawns": ["git"]
 *   },
 *   "idempotent": false,
 *   "may_rewrite_input": false
 * }
 */
```

Rules:

- The literal line `@hook-contract` opens the block. Everything up to the
  block comment's closing terminator, with a leading `*` and one space
  stripped per line, is parsed as JSON. It MUST parse.
- ⛔ Never put the two-character comment terminator inside the block — not in
  a path, not in a glob, not in `notes`. It ENDS the comment, truncating the
  JSON and usually breaking the file's syntax too. This has already cost three
  authors a cycle (two hook blocks and the parser's own header comment, where
  it produced `SyntaxError: Invalid regular expression`). Spell such shapes as
  `<mkdtemp-suffix>/`.
- Exactly ONE `@hook-contract` per file. Two is a malformed block.
- Required keys: `side_effects` (object), `idempotent` (boolean),
  `may_rewrite_input` (boolean).
- `side_effects` requires exactly: `fs_writes` (array of strings),
  `network` (boolean), `spawns` (ARRAY of program basenames — see below).
  `declared_by` is added by the emitter — do NOT write it.
- Optional: `timeout_exemption` (object `{ "reason": "…" }`) — present ONLY when
  the registration declares an `on_timeout` WEAKER than the row's own
  `on_incomplete`. Without it the emitter refuses; with it the validator
  SURFACES the exemption, because a guard that can time out into a weaker
  answer is something a reader must see.
- Optional: `notes` (string) — author-facing rationale for a non-obvious
  declaration. NOT emitted into the manifest.
- Optional: `cost` (object) — ONLY if actually measured. If present it MUST
  carry `p50_ms` (INTEGER), `p95_ms` (INTEGER), `platform` (string naming the
  machine/CI image), `method` (string naming how it was measured). A partial
  or guessed `cost` FAILS the emit (the spec says: omit if unmeasured, never
  guess). Loom emits no `cost` today.

## Field semantics — declare what the code CAN do, not what it usually does

Conservative direction: when a capability is conditional, declare it. The
consumer (`csq`) uses these to decide whether two hooks may share a process,
so an under-declaration is the dangerous direction.

### `fs_writes` — the write targets this hook can create, append to, or delete

- One entry per write TARGET. Two legal forms:
  - **repo-relative** — POSIX, relative to the repo root the hook resolves.
    Prefix a directory form with a trailing `/` (`.claude/learning/`).
  - **external** — a target OUTSIDE the repo, spelled with a locator prefix:
    `<os.tmpdir()>`, `~`, `<git-common-dir>`, `<npm-cache>`,
    `<sibling-worktree-path>`, `<main-checkout>`, `<edited-file>`. The set is
    CLOSED: an unknown locator fails the emit, so a typo can never sit there
    looking like a legitimate external target. `~/…` is the `home` locator.
- A segment built at runtime is spelled as a `<placeholder>`:
  `.claude/learning/provenance/<session>-<sha8>.jsonl`.
- Include everything: files created, appended to, rewritten, moved, deleted,
  mkdir'd, and updated in place.
- No whitespace, no `..`, no leading `/`. Prose belongs in `notes` — the
  emitter rejects an entry that reads like a sentence.
- If it writes nothing: `[]`. That is a strong claim — check for `writeFile`,
  `appendFile`, `mkdir`, `rm`, `unlink`, `rename`, `copyFile`,
  `createWriteStream`, `openSync(..., "w"|"a")`, and for writes done by a lib
  it calls. The emitter FAILS a hook that declares `[]` while its own source
  calls a write primitive.
- Blind spot the emitter CANNOT see: a write performed inside a lib helper the
  hook calls. If the hook delegates its durable writes to a lib, read that lib
  and declare the real target here.

### `network` — the hook's own process opens a network connection

- `true` iff the file (or a lib it calls on its own behalf) does DNS, TCP,
  HTTP(S), or a socket connect. `false` otherwise.
- A spawned child (e.g. `git push`) that reaches the network is covered by
  `spawns: true`, not by this flag — but if the hook MEANS to reach the
  network through a child, say so in `notes`.

### `spawns` — the PROGRAMS the hook starts, as a list

- One entry per PROGRAM, as invoked, lowercase basename: `["git"]`,
  `["git","gh"]`, `["npx","black","ruff"]`, `["node"]`. `[]` = spawns nothing.
- NOT a boolean, and not a command line: `["git rev-parse"]` and
  `["/usr/bin/git"]` are both refused by the emitter. The list exists because a
  consumer deciding whether two rows may share a process needs to know WHICH
  child — `true` answers nothing, and a bare list also cannot silently weaken.
- Covers `spawn` / `spawnSync` / `exec` / `execSync` / `execFile` /
  `execFileSync` / `fork` reached directly OR through a lib helper. If the
  helper spawns `git` (even via a resolved binary), the entry is `"git"`.
- The emitter REFUSES `[]` when the source calls a spawn primitive or requires
  `child_process` — a renamed binding still requires the module, so an alias
  cannot dodge the check.
- This is the field that most often forbids sharing a worker: the process
  semantics of a spawned child (and its own timeout) are not the host's.

### `may_rewrite_input` — the hook can REWRITE the tool input

- `true` iff it can return `hookSpecificOutput.updatedInput`. Every loom hook is
  currently `false`; the emitter refuses a `false` whose source references
  `updatedInput`.
- Not a label: a consumer applies `precedence` (`deny > conflicting-rewrite
  refusal > single rewrite`), and an UNDECLARED rewrite makes the whole row
  INCOMPLETE per its own `on_incomplete` — so a deny-class row DENIES rather
  than silently dropping the rewrite an allow was conditional on.

### `idempotent` — a repeat with the same payload makes no FURTHER DURABLE CHANGE

This is STATE-idempotence, not output-identity. The consumer's question is
"may this run twice without harm?", so the falsifier is a durable side effect,
not a difference in what the hook prints:

- `true` iff a second execution with the same payload writes nothing new —
  including when it re-derives and rewrites byte-identical content, or finds a
  keyed marker already present and stops.
- `false` if it appends a record per invocation, bumps a counter, rewrites a
  timestamped artifact, emits a heartbeat, or CONSUMES a one-shot receipt
  (a delete is a durable change) — unless it dedupes on the payload so the
  repeat is a no-op.
- The DECISION may therefore differ between the two runs: an already-healed
  file passes through, a consumed authorization refuses instead of advising.
  That alone does not make a hook non-idempotent.
- Advisory-only hooks are still `false` when they append unconditionally.

## What the emitter does with a bad block

It FAILS the whole emit, names the file and the exact defect, and exits
non-zero. There is no "skip the file" path: a manifest missing a row is
indistinguishable from a repo that has no such hook, which is the failure this
contract exists to prevent.

It also refuses a declaration the SOURCE contradicts — `spawns: false` while
the file calls a spawn primitive, `fs_writes: []` while it calls a write, or
`network: false` while it opens a socket. The reverse never fails: a
capability performed one hop down in a lib the scan cannot see is the
conservative direction, and punishing it would punish the careful author.

## Where the emitter must run (source/pool derivation)

`source` (and therefore `pool`) is derived by comparing each hook's bytes with
its blob at `source_sha`. That needs the emitting tree to CARRY ITS SOURCE
COMMIT — a normal clone or worktree. Two consequences worth knowing before you
point it at a tree:

- An EXPORTED tree (a `git archive` tarball, a plain copy without `.git`) cannot
  resolve the commit, so every row falls to `source: "repo-local"` /
  `pool: "repo"`. The emitter says so LOUDLY on stderr and the per-row
  `file_sha256` pins are still correct — but the template/repo split a
  two-pool consumer routes on is degraded, so do not emit a DELIVERY manifest
  from an export.
- A hook whose bytes have MOVED from the commit (an uncommitted edit) is
  `repo-local` for the same reason: its bytes are no longer the template's.
  `--require-source-match` turns that from a loud warning into a failure.

## Line endings (Windows lanes)

Every sha256 in the manifest — `file_sha256`, `deps[]`, `runtimes[]` — is over
the file's RAW BYTES. A checkout that rewrites line endings (`core.autocrlf`,
`text` eol attributes) therefore moves every hash and makes the manifest verify
as tampered. If a Windows lane can run the emitter or verify against the sample,
pin the fixture tree's endings (a `.gitattributes` entry for
`.claude/audit-fixtures/hook-registry/**`), and check before verifying:

```bash
git check-attr text eol -- .claude/hooks/<hook>.js
git config --get core.autocrlf
```

The same applies to the SAMPLE: it is emitted with `\n` and compared
byte-for-byte by `--check`, so a normalizing checkout will report a mismatch
that is the checkout's doing, not the artifact's.

## The require closure (`deps`) — what an author must keep resolvable

The emitter walks each hook's STATIC LOCAL-REQUIRE CLOSURE and pins every file
it finds, transitively. Three forms resolve:

- `require("./x.js")` / `require("../y/z.js")`;
- `require(path.join(__dirname, "lib", "x.js"))` (also `path.resolve`, also
  `require("path").join(…)`, also a trailing comma before the closing paren) —
  every segment must be a string literal;
- the same with `..` segments.

Anything else is a DYNAMIC require: `require(someVariable)`,
`require(path.join(__dirname, SOME_CONST, "x.js"))`, a template literal. The
emitter REFUSES the emit rather than pin a closure that is silently short —
short is the dangerous direction, because the manifest then verifies clean over
code it never covered. Fix the call site, or declare a named exemption in
`DYNAMIC_REQUIRE_EXEMPTIONS` (emitter) with the coverage argument for why the
dynamic edge is already pinned some other way.

## The sidecar form (third-party hooks only)

A hook loom cannot edit does not carry the block; a sibling
`<hook>.contract.json` holds the same JSON object, and the emitter reads it in
place of the in-file block. This form is for hooks owned outside this repo —
writing a block into a vendored hook would be overwritten on its next update,
and the declaration would silently become a lie.
