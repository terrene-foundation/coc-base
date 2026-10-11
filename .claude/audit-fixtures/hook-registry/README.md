# `loom.hook-registry/v1` — contract, emitter, fixtures

What loom emits so csq Gate (`csq gate dispatch <event>`, pinned by
`csq gate pin`) can consolidate a repo's hook surface and
verify, BEFORE dispatching a hook, that the bytes on disk are the bytes the
manifest was emitted from — including the library code each hook's verdict
depends on, and the runtime entries those verdicts flow through. A row missing
from the manifest is indistinguishable from a hook that does not exist, so every
failure path here is fail-closed and every "skip the file" path is refused.

## The artifacts

| path (repo-relative) | what it is |
| --- | --- |
| `.claude/hook-registry.json` | THE MANIFEST — a distributed artifact at this fixed path, GENERATED per target by the emitter during Gate-2 (after apply, before the PR commit). A hand edit is overwritten by the next sync and refused by csq Gate's pin. |
| `.claude/hook-registry.json.sig` | Its sibling signature, written only when `--sign` is given AND a key is available. |
| `.claude/hooks/hook-registry.schema.json` | The v1 JSON Schema. Ships on every lane (`.claude/hooks/**` is always-included). |
| `.claude/hooks/lib/hook-registry-contract.js` | The ONE definition of the document — strict parse, JCS content hash, row-id derivation, the `@hook-contract` parser, the require-closure walker, and the vendored validator. It loads the schema FILE at call time, so the schema a consumer validates against and the schema the emitter enforces cannot drift. |
| `.claude/hooks/lib/jcs-canonicalize.js` | RFC 8785 JCS (zero-dep), shared by the contract and by `weft-jcs.js`, which re-exports it. |
| `.claude/bin/emit-hook-registry.mjs` | The emitter. Delivery set comes from a real sync plan's ACTIONS, never from a glob. |
| `AUTHORING.md` (this directory) | The contract an author follows when adding a `@hook-contract` block. |
| `run.mjs` (this directory) | The bipolar fixture battery (113 cases, accept/reject paired). |
| `jcs-vectors.json` (this directory) | Known-answer canonicalization vectors, including number-normalization rows. |
| `sample-trestle-base.manifest.json` (this directory) | The emitted sample for trestle (base BUILD lane). |

## Verifying a manifest (the consumer's job)

```bash
# 1. Shape + cross-field invariants (strict parse, JCS recompute, version/$id
#    agreement, row-id derivation, (event,order) uniqueness, no weaker
#    crash/timeout contract, pool derived from source). Exit 0 = valid.
node .claude/hooks/lib/hook-registry-contract.js validate .claude/hook-registry.json

# 2. Recompute the content hash by hand.
node .claude/hooks/lib/hook-registry-contract.js hash .claude/hook-registry.json

# 3. One hook's declaration block.
node .claude/hooks/lib/hook-registry-contract.js block .claude/hooks/<hook>.js
```

Then, before dispatching any row:

1. **Pin the document out of band.** `content_sha256` is INTERNAL CONSISTENCY —
   it detects an edit to the document, not a substitution of the document. The
   authority tie is yours: verify `.claude/hook-registry.json.sig` against a
   fingerprint pinned in YOUR config (never read from the subject repo), or
   accept an explicit operator pin. With neither, a `deny`-class row must fail
   closed.
2. **Verify the bytes.** For each row, `file_sha256` against the hook file, and
   EVERY `deps[].sha256` against its path — a hook can be byte-identical while
   a lib it requires now returns the opposite verdict. Then `runtimes[]`:
   `entry_sha256` plus its `deps`.
3. **Read `pool`** to split an event into two children (template / repo) so a
   crash in a repo-added row cannot mark a template row incomplete.
4. **Apply `precedence`**: `deny > conflicting-rewrite refusal > single
   rewrite; advise never downgrades a deny`. An UNDECLARED rewrite
   (`may_rewrite_input: false` but the row rewrites) makes the row INCOMPLETE
   per its own `on_incomplete` — a deny-class row then denies.

## Re-emitting

```bash
d=$(mktemp -d)
node .claude/bin/sync-tier-aware.mjs --build base --dry-run --json --out "$d" > "$d/plan.json"
node .claude/bin/emit-hook-registry.mjs --target base --lane build --plan "$d/plan.json" \
     --source-sha "$(git rev-parse HEAD)" --require-source-match \
     --out .claude/audit-fixtures/hook-registry/sample-trestle-base.manifest.json

# `--source-sha` is NOT optional here: without it the emitter falls back to
# `git rev-parse HEAD` of whatever tree it runs in, which for a re-emit after a
# commit is the WRONG commit (the hooks are compared against the previous head's
# blobs and every row is labelled repo-local). Name the commit whose bytes the
# manifest describes — and note that self-referential case: a manifest committed
# in the same commit it describes cannot name that commit, so the recipe is
# emit-against-the-prior-commit or emit-then-commit, never both at once.
```

`--check <file>` fails unless the emit is byte-identical to the given file —
that is how the fixture battery proves the shipped sample is still the re-emit
of this tree. `--require-source-match` makes a hook whose bytes differ from the
emitting commit's blob a FATAL error (without it they are reported loudly, and
those rows emit `source: "repo-local"`, because their bytes are not loom's).

### Signing

```bash
node .claude/bin/emit-hook-registry.mjs … --sign --sign-key ~/.ssh/id_ed25519
```

The signed payload is `{content_sha256, source_sha, version}`, serialized with
`coc-sign::canonicalSerialize` (the frozen loom↔csq seam serializer) and signed
through `coc-sign::sign`. The verifier recomputes that serialization and calls
`coc-sign::verify` with the public key of the fingerprint pinned in its own
config. Without a key the `.sig` is SKIPPED LOUDLY (stderr) and the manifest is
still written; `--require-signature` turns the skip into a failure.

## The three field disciplines

- **[D] derived** — computed by the emitter from the repo's own registration
  surfaces (`settings.json` expanded through `dispatch-registry.json`,
  `.codex/hooks.json` + the native-policy handler list, `.gemini/settings.json`)
  and from the hook's source, lexed rather than grepped. An absent registration
  surface is REFUSED (`--allow-missing-surface <name>` declares an expected
  absence), because a missing source silently NARROWS the document.
- **[A] declared** — `side_effects` (`fs_writes`, `network`, `spawns` as a LIST
  of program basenames), `idempotent`, `may_rewrite_input`, optional
  `timeout_exemption`, written by the author in the hook's `@hook-contract`
  block (or a `<hook>.contract.json` sidecar for a third-party hook loom cannot
  edit). `side_effects.declared_by == "author"` is the in-band marker that
  these are declarations, never measurements.
- **[M] measured** — `cost`, present ONLY with a named platform and method, and
  omitted entirely when unmeasured. Loom emits none today.

## Numbers and the hash

`content_sha256_scheme` is **RFC 8785 JCS** over the document with that field
removed. Numbers in this document are **safe integers only**; `jcs-vectors.json`
pins the canonical form of a set of known inputs (including `1.0 → 1`,
`1e2 → 100`, `-0.0 → 0`, and the refusals for `1.5`, `1e21`, `>2^53`, lone
surrogates and duplicate keys). A consumer reproduces those rows in its own
language and fails closed on any disagreement — that is the check that makes
cross-language hashing safe rather than hopeful.

## Verification

    node .claude/audit-fixtures/hook-registry/run.mjs     # 113 cases, exit 1 on any failure

Every case PAIRS an accept pole with a reject pole and asserts the exact
expected error text, so a fixture that stopped firing (the instrument broke) is
distinguishable from a subject that regressed (the emitter broke). The battery
is registered in `.claude/test-harness/ci-audit-fixtures.json`, so it runs in
CI with an anti-vacuity floor; case 59 re-derives the sync plan in-run and
insists the checked-in sample is still its byte-identical re-emit.
