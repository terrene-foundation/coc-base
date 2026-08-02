# `derives_from[]` PROV-Edge Emission — depth for `rules/specs-authority.md` Rule 11

Procedural depth for the artifact→origin provenance edge `/codify` emits at its Step 3/4 artifact-emission point. The path-scoped contract is `rules/specs-authority.md` Rule 11 (the four load-bearing invariants) — `specs-authority.md` is `priority: 10` + `scope: path-scoped`, so Rule 11 does NOT load in a `/codify` session touching no `specs/` / `workspaces/` / `briefs/` / `02-plans/` / `todos/` path; the always-loaded `codify.md` Step 3/4 bullet is the reachability floor for exactly those sessions and MUST NOT be deleted as redundant plumbing. This file carries the record shape, the emitter call, the hygiene-invariant enforcement map, the transport decision, and the v0→v1 ratification protocol.

**Frozen v0 contract:** (loom-internal reference) (loom#1228 item B2, landed by PR #1305). That doc is the SPECIFICATION; this file is the how-to. Do not re-freeze or re-author the contract here.

## ORPHAN STATUS — read first

**Only the PRODUCER half exists.** loom emits edges to a local, gitignored, per-session JSONL staging sink. There is **no drain, no reverse index, and no query surface** — the CONSUMER (the local DataFlow accountability store that persists edges, answers "where did artifact X come from?", and runs the orphan/unbacked-anchor sweep) is **kailash-rs #1951 and is NOT built**. Edges accumulate and are read by nothing.

That is the DESIGNED v0 state, not a gap to paper over: loom freezes the emit-side shape FIRST so #1951 ratifies against a greppable tripwire, instead of loom reverse-engineering whatever the store happens to ship (`derives_from_schema_version: 0` is the wire signal for "proposed, not agreed"). **MUST NOT** describe this as a converged end-to-end provenance capability, and MUST NOT invent a drain, a query, or a sweep that does not exist (`rules/orphan-detection.md`; `rules/user-flow-validation.md` MUST-8).

## The v0 record shape

One JSON record per generated artifact. Closed top-level shape; 9 required fields.

| Field                         | Type                                     | Meaning                                                                                       |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `derives_from_schema_version` | `0`                                      | Proposed / pending-S-1. Frozen ⇒ `>= 1`.                                                      |
| `record_type`                 | `"DerivesFromEdge"`                      | Stream discriminator.                                                                          |
| `artifact_type`               | `"agent" \| "skill" \| "rule" \| "hook"` | The generated Entity's type. Closed.                                                           |
| `artifact_id`                 | non-empty string                         | Agent name / skill name / rule id / hook name.                                                 |
| `derives_from`                | array of DerivationSource (≥0)           | The `wasDerivedFrom` edges. `[]` is the ORPHAN SIGNAL — emitted, never omitted.                |
| `activity`                    | `"codify"`                               | The PROV Activity that generated the edge.                                                     |
| `session_id`                  | non-empty string                         | Per-session provenance scope.                                                                  |
| `timestamp`                   | ISO-8601 string                          | Capture time.                                                                                  |
| `producer`                    | `"loom"`                                 | The PROV Agent (emitter identity).                                                             |

**DerivationSource** — one source anchor per element:

| Field         | Type                                  | Req/Opt  | Meaning                                                                                                                 |
| ------------- | ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `anchor`      | non-empty string                      | required | `<path>#§<section>` or `<path>::<symbol>`, resolving UNIQUELY against the current tree. NEVER a line number, a 1-3 char locator, an ambiguous prefix, or a `kp://` handle. |
| `anchor_kind` | `"spec" \| "artifact" \| "workspace"` | required | Which source class the anchor names. Closed — the reverse index buckets by it.                                          |
| `relation`    | `"wasDerivedFrom"`                    | optional | Light-PROV is single-relation; absence defaults to `wasDerivedFrom`. Present-and-out-of-set is rejected.                |

**Core vs envelope.** The PROV core is `artifact_type` + `artifact_id` + `derives_from[]`. The other 6 fields are the loom envelope (version, discriminator, activity, session/timestamp grain, producer). S-1 MAY persist only the core and treat the envelope as ingest metadata — a consumer choice v0 leaves open.

## Calling the emitter — the CLI is the sanctioned call

**Use the CLI, not the library.** Rule 11 invariant 1 leans on the emitter's **non-zero exit** as the compensating control for its one sanctioned exception (a rejected citation writes no row): the library form returns a result object and produces **no exit code at all**, so calling it directly means the control cannot fire.

```bash
echo '{
  "session_id": "<from the session context>",
  "artifacts": [
    { "artifact_type": "rule", "artifact_id": "specs-authority",
      "derives_from": [
        { "anchor": "specs/ontology/glossary.md#§topology-aware agentic distillation", "anchor_kind": "spec" },
        { "anchor": "(loom-internal reference)#§5. Remediation SCOPE", "anchor_kind": "workspace" }
      ] },
    { "artifact_type": "skill", "artifact_id": "some-skill", "derives_from": [] }
  ]
}' | node .claude/bin/emit-derives-from.mjs
```

Payload fields use the CONTRACT's snake_case names (one vocabulary across Rule 11, the contract, and the CLI). `derives_from: []` is the ORPHAN signal — emit it, never omit the artifact. Optional: `repo_dir`, `now_iso`.

**Exit contract:** `0` = every row staged (or an explicit empty `artifacts: []`); `1` = ≥1 record REJECTED; `2` = usage error (payload absent / unparseable / structurally wrong). **A non-zero exit MUST NOT be passed over** — an ignored rejection is the BLOCKED omission under Rule 11 invariant 1. Rejections print per artifact with their stage: `validate` = the citation is wrong (fix the anchor); `sink` = the record was valid but the write was refused (an environment problem); `internal` = a fault in the emitter.

**Batch atomicity.** The batch is validated in FULL before any row is appended, so a rejected citation cannot leave a partial batch that the mandated re-run would duplicate. For the residual case a JSONL append cannot cover (a crash mid-batch), the contract-level dedup rule is **last row wins per `artifact_id` + `session_id`** — no shape change, no supersession field.

**Library form (INTERNAL — not the sanctioned call).** `emitCodifyArtifactEdges` / `emitDerivesFromEdge` in `.claude/hooks/lib/derives-from-ledger.js` are what the CLI wraps. They **never throw** (a rejection is a returned `{ ok: false, stage, error }`), which is the fail-open property the library owes `/codify` — and precisely why they are the wrong surface for an author: no exit code, so no enforcement. Call them only from another tool that itself surfaces the failure.

**Sink:** `.claude/learning/derives-from/<sanitized-session>-<sha8>.jsonl`, gitignored (`.gitignore` § "loom#1228"). Per-session, append-only. Same per-clone never-committed state class as `.claude/learning/provenance/` (F101-2) and `.claude/learning/artifact-activation/` (#1209).

## Hygiene-invariant enforcement map

Every invariant is enforced **fail-loud at construction** (`buildDerivesFromEdge` throws) and surfaced as a returned error by the sink wrapper (**fail-open to the caller** — a capture failure never blocks `/codify`, per `rules/hook-output-discipline.md`).

| Invariant (contract § 2)                        | Enforced by                                            | Rejection reason               |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| Closed `artifact_type` / `anchor_kind` / `relation` | `validateDerivesFromEdge`                          | per-field closed-set message   |
| Anchor is not a bare line number                | `classifyAnchor`                                       | `bare-line-number-anchor`      |
| Anchor has a grep-stable locator at all         | `classifyAnchor`                                       | `no-grep-stable-locator`       |
| Locator is not vacuously short                  | `classifyAnchor` (normalized floor: 4 section / 3 symbol) | `locator-too-short`         |
| Anchor resolves against the CURRENT tree        | `validateEdgeAnchorsResolve` → `resolveAnchor`         | `path-does-not-resolve` / `section-heading-not-found` / `symbol-not-found` |
| Resolution is UNIQUE (≥2 headings ⇒ unresolved) | `_findSectionHeading` (collect-all, exact-or-prefix)   | `section-heading-ambiguous`    |
| Anchor path stays inside the repo               | `resolveAnchor` (realpath BOTH sides, fail closed)     | `path-escapes-repo-root` / `absolute-path` / `path-traversal-segment` |
| Read is bounded + fd-bound                      | `openSync(O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK)` + `fstatSync(fd)` | `file-exceeds-read-cap` / `path-is-not-a-file` |
| Work is bounded                                 | `MAX_DERIVES_FROM` (32) + per-pass read memoization    | at-most-N-sources message      |
| Mesh fence — no `kp://` anywhere                | `classifyAnchor` + whole-record string scan            | `mesh-fence-kp-urn-in-anchor`  |
| No credential KEYS or high-confidence VALUES    | recursive walk in `validateDerivesFromEdge` (depth-capped, cycle-fenced) | credential key / VALUE / proto message |
| Closed top-level + DerivationSource shape       | `validateDerivesFromEdge`                              | `unexpected … key`             |
| `derives_from` is a PLAIN Array (no subclass)   | prototype assertion + `Array.from` species strip       | `MUST be a plain Array`        |
| `derives_from: []` is valid and never dropped   | `validateDerivesFromEdge` (array required, empty OK)   | — (accepted; counted as orphan) |

Details worth not re-litigating:

- **Anchor verification is UNCONDITIONAL — there is no opt-out parameter.** A record staged without tree verification would be byte-identical to a verified one, so the consumer's unbacked-anchor sweep could not tell them apart. (An in-band `anchors_verified` flag is not the alternative: it widens the frozen v0 shape and needs S-1 coordination.)
- **One normalizer, both sides.** The needle and the candidate heading go through the SAME `_normalizeAnchorText`. The asymmetry it replaced was a real defect: the heading side stripped `_` and the needle side did not, so every heading containing an underscore was uncitable — including this stream's own `### \`derives_from[]\` edge`.
- **A heading is only matched when it IS a heading.** Fence state is tracked, so a `# ...` line inside a ```` ``` ```` block is a code COMMENT and never a match target. This corpus is full of them (the DO/DO-NOT examples `cc-artifacts.md` Rule 3 mandates — `security.md` alone has 12), and without the fence check they resolved as headings AND enlarged the ambiguity surface, which could make a real heading uncitable.
- **KNOWN LIMITATION (accepted): a heading whose normalized text is under 4 chars is uncitable.** `## API` / `## FAQ` cannot be cited; the emitter rejects with `locator-too-short` and no row is written. Zero collateral in this corpus today (`grep -nE '^#{1,6} .{1,4}$'` over `specs/` finds none). Workaround: cite a longer unique parent section, or rename the heading. NOT "fixed" by moving the floor to resolution time — the floor lives in the PURE shape gate (`classifyAnchor`), which `validateDerivesFromEdge` runs with no filesystem access, so an exact-unique-match waiver would either weaken that pure gate for every caller or duplicate resolution logic. Revisit only if a real heading in this band appears.
- **Matching is exact-or-prefix, never `includes`.** An unbounded substring match let a needle match any heading interior, and made a 1-char locator resolve against almost any file.
- **A missing `derivesFrom` is NOT defaulted to `[]`.** The empty array is a meaningful ORPHAN CLAIM; manufacturing it from `undefined` would forge a claim the caller never made. An absent array is a caller bug and is rejected fail-loud.
- **Symbol resolution is a MENTION check, token-bounded and literal.** It is satisfied by the token appearing anywhere — definition, call site, comment, or prose — so it proves the anchor is not a DEAD pointer, NOT that the file DEFINES the symbol. `foo` must not resolve against `foobar`, and a crafted anchor never becomes a RegExp.
- **Two failure lanes, kept distinguishable.** `stage: "validate"` = the caller's citation is wrong; `stage: "sink"` = the record was fine, the write failed; `stage: "internal"` = a fault here (a limit, a bug). Reporting an internal fault as `validate` would send the reader to audit a citation that was fine.

**Path containment** follows `rules/security.md` § "Path Containment": candidate and boundary root are both resolved through `fs.realpathSync` before comparison, and an unresolvable path fails closed. The read then goes through a **file descriptor**, with the size/regular-file gate taken from `fstat` of THAT fd — a stat-then-read pair is TOCTOU-bypassable, and a FIFO swapped into the window would make a blocking read hang forever, which would break the fail-open guarantee outright (a call that never returns never reaches the catch). `O_NONBLOCK` + `O_NOFOLLOW` are `|| 0`-guarded per the F53 idiom in `state-io.js`.

**Sink hardening (local half).** The append refuses a symlink at the sink directory or file (`lstat`, never `stat`) and creates with mode `0o600`; the sink is anchored at the discovered repo root, and emission refuses outright when no root is found. This is the cheap local half of a corpus-wide gap — 5+ sibling sinks under `.claude/hooks/lib/` share the same unhardened `mkdirSync + appendFileSync` idiom, and the shared hardened helper is tracked separately.

## Transport — an open v0→v1 coordination point, not a v0 field-shape question

The contract § 5 Q3 leaves transport explicitly open: a **drained staging sink** (the ArtifactActivationEvent sibling's shape) vs a **direct store write** (the design § 1.4 phrasing). v0 stages to a sink because:

1. the direct-store-write alternative is **unimplementable today** — the kailash-rs S-1 store does not exist (the #1228 B1 dependency gate); and
2. the staging sink is the **shipped #1209 precedent** in the same producer folder, with the same fail-open/never-committed properties.

Whichever transport #1951 confirms rides the coordinated v0→v1 bump. The field shape is unaffected either way — which is the point of freezing the shape separately from the transport.

## Forward-compat + the v0 → v1 bump

- **A consumer MUST ignore unknown fields** — persist what it knows, never fail-closed on surplus.
- **A producer MAY add optional fields at a minor bump** — additive-only, provided every v0-named field keeps its type and meaning.
- **Closed sets are the exception.** Widening `artifact_type` / `anchor_kind` / `relation` is a MAJOR change (a consumer keyed on the old set would silently mis-bucket), as is a rename, a type change, or a required-field addition.

The four questions #1951 must answer to move v0 → v1 (contract § 5): core-only vs full-envelope persistence; whether the empty-array orphan row is persisted as a first-class row rather than dropped; the transport above; and whether single-relation `relation` suffices for the store's query surface.

## Related

- `rules/specs-authority.md` Rule 11 — the path-scoped contract + its Trust Posture Wiring (the always-loaded reachability floor is the `codify.md` Step 3/4 bullet)
- `rules/symbol-anchored-citations.md` MUST-1/2 — why the anchor is grep-stable, never a bare line
- `rules/specs-authority.md` Rule 10 invariants 3/4 — the mesh `kp://` name-blind plane the fence separates from
- `.claude/hooks/lib/artifact-activation-event.js` + `artifact-activation-ledger.js` — the sibling seam (#1209): which artifacts FIRED, vs this stream's where each artifact CAME FROM
- `.claude/hooks/lib/provenance-event.js` — the FROZEN signed F101-2 governance record (schema_version 1); a different stream, byte-frozen, never widened from here
