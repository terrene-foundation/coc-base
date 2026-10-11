# `loom.hook-registry/v1` — delta table (1b + follow-up)

Every item raised against this lane, its disposition, and the fixture that holds
it. Rows are grouped by their source: the seat's verdict, the two reviewer
rounds, and csq's builder drift. A row with no case names its justification
instead — a disposition without one of the two is not a disposition.

Dispositions: **added** (the capability did not exist), **fixed** (it existed
wrong), **confirmed** (deliberately kept as-is, with the reasoning), **reverted**
(the delta was wrong and was removed).

## Re-emit (registration landed)

Both manifests were re-emitted against the registration commit this lane took
in as `c70c0930` (registry content sha256 `fc9e7a15…`, asserted equal to the
landed sha). NEW hash set, stated BESIDE the old rather than replacing it:

| artifact | before | after |
| --- | --- | --- |
| sample manifest | `2a81f038010eb1f3…` content `b6c8f2b4d9ebf496` source_sha `1e1416b4` | `8115aa06cad28fa8` content, source_sha `c70c0930` |
| loom's own manifest | `76f10a8ba62578c7…` content `7399a369fb22f868` source_sha `1e1416b4` | `9a0ef7854878309f` content, source_sha `c70c0930` |

Row counts and dep edges are unchanged (87/69/1711 and 101/82/1880): the
registration change moved four `on_incomplete` values, not the graph.

## Commits

| commit | batch |
| --- | --- |
| `872f910b8` | 1b — deps closure + runtime pins, pools, byte-derived source, JCS integers, fail-closed sweeps |
| `5371ec381` | the sample emitted against `872f910b` (a self-referential artifact cannot cite its own commit) |
| `1e617e74d` | battery registered with a measured floor; sync-manifest declarations; loom's own manifest |
| `1e1416b41` | block-opener form pinned (L5); undelivered-sidecar refusal |
| follow-up | D1–D4, E1–E5, the delivery-model ruling, the floor re-measure, the docs/naming pass |

## Seat — HIGH

| delta | disposition | fixture |
| --- | --- | --- |
| H1 `pool` absent; `additionalProperties` rejected it | added, DERIVED from `source` (`loom-template ⇒ template`, else `repo`), mapping stated in the schema | 43 (mismatch refused) / 44 (derived accepted) / 26 |
| H2 repo rows labelled `loom-template` | fixed — `source` is derived from BYTES: `loom-template` only when the file equals its blob at `source_sha` | 65 (committed ⇒ template; one-byte edit ⇒ repo-local) / 26 |
| H3 deny-capable PreToolUse ⇒ deny/deny; undispatched PreToolUse defaults deny; `timeout_exemption` | fixed — 20 deny-capable PreToolUse rows at loom, all deny/deny; where the REGISTRATION is weaker the manifest carries the policy and the divergence is NAMED (2 rows) | 18 / 19 / 20 / 21 / 22 |
| H4 deps closure + non-literal refusal + manifest-level runtime pins | added — 1707 dep edges in the sample, 1876 at loom; `runtimes[]` pins the dispatcher and the Codex adapter with their closures | 27 / 28 / 53 (lib edit moves the pin) / 54 |

## Seat — MEDIUM / LOW / process

| delta | disposition | fixture |
| --- | --- | --- |
| M1 JCS: duplicate keys, lone surrogates, `>2^53`, floats; maximums; integer `cost`; fixed vectors | fixed — strict parse refuses all four before any field is read; vectors frozen | `jcs-vectors.json` + 52 (every row, through BOTH module paths) |
| M2 prototype-chain bypass | fixed — own-property lookup plus refusal of 12 names | 45 |
| M3 network cross-check DEAD; aliased spawn | fixed — the one-arg/two-param indexer bug; a `child_process` require now contradicts `spawns: []` | 12 / 13 + 07 / 08 |
| M4 `sourceDrift` compared a sha256 with a git OBJECT ID | fixed — blob id computed in-process | 60 (clean pole — the one that reds on the old code) / 61 |
| M5 `null` on_incomplete + weak crash validated; battery unregistered | fixed — both refused; the battery is registered with a measured floor | 42; `ci-audit-fixtures.json` entry |
| M6 manifest path; precedence text | fixed — `.claude/hook-registry.json`; precedence carries the full combine order | 01 |
| M7 `--plan` silently dropped repo rows | fixed — only `loom-template` rows are delivery-filtered | 26 |
| LOW: raw-byte hashing, symlink refusal, case-insensitive delivery, `matcher: ""`, validator never throws, unlexable source | fixed | 29 / 55 / 48 / 49 / 42 / 46 |
| DISCLOSURE: absolute operator home path in the fixtures README | fixed — root-relative, and the WHOLE LANE re-scanned with a firing control (89 changed/new paths, zero hits remaining) | scan recorded in the lane report |

## Reviewer round 1 (correctness + security)

| delta | disposition | fixture |
| --- | --- | --- |
| HIGH-1 `sourceDrift` object-id comparison | fixed (same as M4) | 60 / 61 |
| HIGH-2 local-registry row omitting `on_incomplete` emitted `continue` | fixed — local rows are dispatched rows and resolve through the dispatcher's fail-closed default | 26 |
| A1 the block was parsed from a SECOND read of the path | fixed — one read per file, block parsed FROM THE SAME TEXT | 53 / 65 exercise the single read |
| A2 wrapper error shape differed from the text parser's | fixed — the file reader is a thin wrapper over the one parser | — (structural; both forms now share the vocabulary) |
| B `null` on_incomplete + `continue` crash validated | fixed — ranked against the RESOLVED default | 42 / 72 |
| C1 environment-derived `surfaces` narrowed silently | fixed — an absent registration surface is a REFUSAL unless declared | 30 / 31 |
| C2 line-ending risk | documented — AUTHORING § Line endings carries `git check-attr` / `core.autocrlf` | — (doc; no Windows lane runs it in CI today) |
| L3 `form` ignored the local registry's `mode` | fixed | local-row cases (26) use the mode path |
| L4 validator threw on wrong-shaped input | fixed — denials, never throws | 48 / 49 (the validator's own inputs) |
| L5 line-based block opener accepted `//` | fixed — the opener is the block form only | 66 (both poles) |
| L8 the "always-included" claim | fixed — VERIFIED against a real plan; the check found the emitter shipping `skip/no_tier_match` while the schema, libs and README shipped | plan measurement recorded in the contract header |
| ITEM 4 evasion boundary | added — the 8-class list SHIPS in the contract header (widened in E4) | — (prose that ships) |
| ITEM 6 `pool` | added (same as H1) | 43 / 44 |
| ITEM 7 sidecar errors reported; sidecar must be delivered | fixed | 67 (both poles) |
| M5 (security, process) battery registration | fixed — floor 72, measured | `run-audit-fixtures --only hook-registry` |

## csq builder drift

| delta | disposition | fixture |
| --- | --- | --- |
| `pool` | added | 43 / 44 |
| `may_rewrite_input` + the row-incomplete consequence | added — the declaration is cross-checked against the source; the consumer semantics (an undeclared rewrite makes the row INCOMPLETE per its own `on_incomplete`) are stated in the schema and `precedence` | 14 / 15 |
| `spawns` as a LIST | fixed — all 82 hook files swept; two wave-1 errors found (codify-self-referential-guard declared `spawns:false` while spawning git; log-triage-gate's shell pipeline) | 07 / 08 |
| SubagentStop as an 8th event | confirmed — it is in the registry and its host semantics differ from Stop's | — (justification) |
| per-row `surfaces` (not top-level) | confirmed — registration is per row; a file can be codex-only for one event | — (justification) |
| nullable `matcher` / `timeout` | confirmed — `null` is the event-wide form, distinct from `matcher: "*"` normalising to it; `timeout: null` means the surface declares none | 01 |
| 7 protocol kinds | confirmed — each is a distinct host reading of an answer, derived from the event | — (justification) |
| `exit_codes` array + the computed sibling | confirmed — the array shape is preserved for readers; the qualifier is additive because absence of `2` does not mean "cannot deny" | — (justification) |
| JCS known-answer vector path | added — `.claude/audit-fixtures/hook-registry/jcs-vectors.json` | 52 |

## Reviewer round 2 (security delta)

| delta | disposition | fixture |
| --- | --- | --- |
| D1 the require closure read OUTSIDE the repo root (content oracle + path leak) | fixed — BOTH sides resolved through the same resolver, containment checked on the canonical path, escape REFUSED by name; a repo-relative `deps[].path` pattern added to the schema | 68 (both poles: a real outside-root file refused; a `..`-walk that stays inside resolves) |
| D2 `module.require(…)` and `import(…)` produced NO site | fixed — both recognized; a dynamic site now refuses independently of the closure's `ok` flag | 69 / 27 (the refusal case; the earlier delta-table row that cited case 54 was WRONG — 54 pins the runtime closures) |
| D3 `--require-signature` alone exited 0 UNSIGNED | fixed — the flag implies `--sign`, `--sign` with `--stdout` refuses, and a missing key fails loudly | 71 (three poles: no-key refusal, stdout refusal, signed happy path + the hand-edit pin) |
| D4 the exemption was keyed by FILE and invisible in the document | fixed — keyed to the SITE (file + line), matched on both, and carried in-document as `dynamic_require_exemptions[]` | 70 (one site exempted ⇒ the OTHER still refused and named; both ⇒ two in-document declarations) |
| E1 `null` on_incomplete + weaker crash/timeout still validated | fixed — the default is resolved BEFORE ranking | 72 |
| E2 the per-file cache key lost the source class | fixed — keyed `(file, source class)` | masked by ordering before; the key is now structural |
| E3 `--check` compared decoded text while pins moved to raw bytes | fixed — Buffers compared | 56 / 57 |
| E4 name more network/spawn primitives in the shipped blind-spot list | fixed — `http.get`, `dns.promises.lookup`, `dgram`, `import("node:child_process")` and the destructured-binding gap are named | — (prose that ships) |
| E5 `weft-jcs:` error prefix in a shipping module | fixed — retitled `jcs-canonicalize:` (diagnostics, not disclosure: the scanner has zero `weft` matches) | — (diagnostics) |
| E5 `WEFT_PUBLIC_TEMPLATE_FLOOR` | NOT changed, deliberately — that set is a presence SUBSET asserted at length 8, and adding the new path would red that assertion and misstate the set | suites settle it (see below) |
| "refuted: the battery is unregistered" | confirmed — the entry exists with a measured floor | `ci-audit-fixtures.json` |

## Final security batch (F1–F5)

| delta | disposition | fixture |
| --- | --- | --- |
| F2 the bound-const branch resolved a call whose argument merely MENTIONED a binding — `require(process.env.HOOK_IMPL || REL)` produced a complete-LOOKING closure over the wrong module, with no deps entry, no dynamic site and no refusal | fixed — the argument window must **BE** the binding: every identifier is a known binding, a PROPERTY name (which cannot change which variable is dereferenced), or a path-NAMING/transform helper (`path`, `url`, `__dirname`, `pathToFileURL`, `fileURLToPath`, by a stated criterion: it may name a path, never select one). Any other bare identifier keeps the site DYNAMIC. The recognizer's comment claiming a mis-read could "only ADD a pin" was FALSE for an override — it substitutes — and is corrected in place | 74, three poles: override-window refused; bare binding resolved; the direct `path.join(__dirname,…)` AND the validate-emit `||`-override-through-`pathToFileURL` shape still resolved. The third pole is what stops "make everything dynamic" from greening the suite while EMPTYING the closure |
| F1 the containment pattern existed on `hooks[].deps[].path` but NOT `runtimes[].deps[].path`, and the VALIDATOR had no containment check of its own — a hand-edited document could smuggle `../../etc/hosts` past validate | fixed in BOTH homes — the schema pattern is now identical on both arrays (asserted equal, not retyped), and the validator carries a clause over BOTH arrays, matching the pattern's strictness (leading slash or a full `..` segment refused; `...` a legitimate filename still passes) | four-way control run at authoring: runtime escape refused, hook absolute refused, `...` filename passes, clean sample unaffected |
| F3 case 71's pin pole could not fail independently (its re-hash differs by construction) | fixed — case 75 exercises the VERIFY side a consumer implements: `coc-sign::verify` succeeds for the signed payload under the signing key, FAILS for the edited payload under the same key, and FAILS under a WRONG key | 75 |
| F4 case 71 reds rather than skips when `ssh-keygen` is absent, and the registry note named only git | fixed — the note names git AND ssh-keygen as required, states that absence REDS rather than skips, and the floor was re-derived on a host that has both | registry note + floor 75 |
| F5 the `DYNAMIC_REQUIRE_EXEMPTIONS` docblock said "Empty today" and "(file, reason)" while the list holds one `{file,line,shape,reason}` entry | fixed — the docblock matches the list it documents (a security constant's comment contradicting its contents is what the next reviewer trusts) | — (comment; the list itself is pinned by 28/70) |

## The two contract overrides — dispositions

The manifest names two rows whose REGISTRATION is weaker than the deny/deny
policy for deny-capable PreToolUse rows. Neither is an unpatched defect:

| row | disposition |
| --- | --- |
| `detect-violations.js` | RESOLVED, and the override is now GONE from both emitted documents. The lane that owns the registration flipped its four `continue` rows → `deny` (a fifth was already deny) and re-derived the deploy budgets; that commit was taken into this lane so the manifests could be emitted against a commit THIS tree carries (registry content `fc9e7a15…`, asserted equal to the landed sha). The four re-emitted rows now read `deny`; the emitter reports ONE override, not two |
| `settings-deny-edit-guard.js` | **registration-by-design.** It is registered DIRECTLY in settings.json on purpose — its own settings entry self-checks that direct registration, and `hook-dispatch-registry.test.mjs` carries an explicit case asserting that moving it into the registry "would disarm that self-protection" (the move was attempted and reddened those cases, then reverted). The manifest KEEPS naming the divergence: a direct registration cannot inherit the dispatcher's deny-on-incomplete policy, and stating that is the honest output, not a defect to patch away |

## Coverage closed in this batch

| delta | disposition | fixture |
| --- | --- | --- |
| the verify-side pole for the signature (a self-derived re-hash comparison cannot fail if the signed payload is itself wrong) | added — `coc-sign::verify` runs in the battery: PASSES the unedited payload under the signing key, FAILS the edited payload, FAILS under a wrong key | 75 |
| loom's OWN manifest had no re-emit pin (the sample had case 59; this one had nothing, so its rot would have been silent) | added — emitted with `--all-rows` and `--check`ed against the committed file at the source_sha that file itself names, so the assertion is about bytes and does not move with later commits | 76 |

## Delivery model (orchestrator ruling)

| delta | disposition |
| --- | --- |
| `.claude/hook-registry.json` was drafted `target_owned:` | **reverted** — it is loom-GENERATED per target. Gate-2 runs the emitter in the sync worktree (after apply, before the PR commit); the path rides the consumer-runtime bin allowlist so the artifact class is delivered. A target-side hand edit is overwritten by the next sync AND refused by csq Gate's pin (the signed payload names the original `content_sha256`) | 
| the hand-edit red fixture | 71's third pole: the manifest is signed, then edited and re-hashed as an attacker would — the signed payload still names the original digest, so the pin fails |

## Formal correctness verdict (at `1e1416b41`) — the three recorded residuals

The verdict was CLEAN: frozen replay 67/67, mutation control reddening case 59
alone, closure green with the recorded floor, the 15 JCS vectors reproduced by an
INDEPENDENT implementation, loom's own manifest byte-identical on re-emit, the
emitter measured `copy / always_include`, and all 82 blocks complete. Three
residuals were recorded with it:

| residual | disposition | where |
| --- | --- | --- |
| R1 AUTHORING said `p50_ms` "(number)" while the schema requires an integer | fixed — the doc says INTEGER | AUTHORING.md § the cost field |
| R2 a `git archive` EXPORT reds its own case 59 (66/67) with every row falling to repo-pool, and the fallback was silent outside `--json` | fixed — an unresolvable `source_sha` now prints a LOUD stderr line naming the reason AND the consequence (the template/repo split could not be derived; every row is `repo-local`/`repo`; the byte pins are unaffected), and AUTHORING gained § "Where the emitter must run" stating the deployment scope | case 73 |
| R3 no battery case covered `--sign`/`.sig` although the .sig is on csq Gate's critical path | fixed — case 71 covers three poles: no-key refusal, `--sign` with `--stdout` refusal, and a signed happy path with a throwaway ed25519 key the case generates, ending with the PIN (a hand-edited manifest that recomputes its own content hash still fails, because the signed payload names the original digest) | case 71 |

The R2 case and the R3 case were added in the same edit as the fixes, and the
registry floor moved with them (75 executed).

## Load-form closure (2026-10-08) — the security seat's ruling, closed in-lane

The seat's root cause, verbatim: **the walker IMITATES the loader, so every load
form it does not spell out is a silent hole** — no deps entry, no refusal and no
exemption line, so the closure verifies clean over code it never covered. This
batch closes the cited forms. Every row below was MEASURED again at the head
before it was touched (citations re-read, not trusted), each fix carries a case
that REDS when the fix is inverted, and each mutation was proven to REACH the
code before its red-set was read.

| delta | disposition | fixture |
| --- | --- | --- |
| (a) STATIC ESM: `import … from "./x.mjs"` / `import "./x.mjs"` / `export … from "./x.mjs"` produced no site, so a `.mjs` file's whole import graph was invisible — `reconcile-settings-deny.mjs`'s `./lib/entry-point.mjs` and `validate-emit.mjs`'s seven local imports were unpinned | fixed — the three static forms are read as load sites. MEASURED: `entry-point` appears 0 times in the pre-fix manifest and is a deps entry after | 89 (both poles) + 59/76 (the re-emit pins it for the real tree) |
| (b) `createRequire` aliases (`const _require = createRequire(import.meta.url)`) were neither refused nor exempted — 8 call sites in `validate-emit.mjs` alone | fixed — the alias is RECORDED and its call sites are walked exactly like `require(…)`. The orchestrator approved this over the stricter floor ("refuse the file"): a literal or `path.join(__dirname, …)` argument PINS, anything else is a dynamic site | 92 (both poles) |
| (c) SPAWN BY PATH (`spawn`/`spawnSync`/`execFile(…, process.execPath, [script])`) pinned nothing — for `burndown-trace-write-guard` a CHILD'S EXIT DECIDES THE BLOCK VERDICT while its generator was in no deps list | fixed — the script argument resolves through `__dirname`/dirname-equivalent joins, PROJECT-ROOT-anchored joins (inline or binding-held; member-expression anchors included), a `realpathSync(<path>)` wrapper, and `__filename`/`fileURLToPath(import.meta.url)` (SELF ⇒ no edge needed, its bytes are file_sha256); an inline `-e` program is read through its interpolated path bindings; everything else is a dynamic site | 93 (4 poles) + 85/86 (worker form, branch-isolated) |
| (d) M5 — `.` / `..` / absolute / `file:` specifiers were added to `externals` and SILENTLY dropped | fixed — they are classified UNPINNABLE and refused BY NAME; `node:` builtins and package names remain externals (their bytes are not in this repo) | 90 (5 poles) |
| (d) M5 — `require.call`/`require.apply` resolved on ANY single string token in the argument window, so `require.call(null, process.env.X \|\| "./a.js")` resolved to ./a.js — the F2 substitution bug, reintroduced in this spelling | fixed — only a LITERAL IN THE SPECIFIER POSITION resolves (a one-element array for `apply`); every other shape is a dynamic site | 91 (3 poles — the third exists because the first two left the token-type check INERT under mutation) |
| (e) M2 — `validateManifest()` never ran `parseStrictJson`/`findUnrepresentable` (only the CLI did), and the `hash` CLI used plain `JSON.parse` | fixed — the validator runs the object sweep ALWAYS and the text scan when the caller passes the text (the emitter does); `hash` refuses a document that does not strictly parse rather than printing a digest for a document with no canonical form | 80 + 84 |
| (f) the null-`on_incomplete` clause compared `doc.default_on_incomplete[event]` against `EVENT_DEFAULTS[event]` — the document against a copy of ITSELF — while naming `EVENT_DEFAULTS` "the dispatcher's fail-closed default"; the dispatcher reads every non-`continue` (null included) as `deny` at EVERY event | fixed — a null must equal `DISPATCHER_ON_INCOMPLETE_DEFAULT`, a NAMED copy of the dispatcher's `ROW_ON_INCOMPLETE_DEFAULT` pinned to the dispatcher's own source | 87 (constant pin) + 88 (both poles) |
| LOW — a runtime entry could be a SYMLINK (the row check has existed since case 29; the manifest-level check tested existence only), and `runtimes` carried `minItems: 1`, which cannot say WHICH entries | fixed — the runtime pin refuses a symlink, the schema floor is 3, and the validator additionally requires EVERY entry in `RUNTIME_ENTRIES` BY NAME | 95 (both rejects) |
| LOW — the BRACKET form `reply["updatedInput"]` evaded the rewrite cross-check (the quoted-key scan requires a `:` next, a bracket closes with `]`); case 80 created `zz-case80-*` INSIDE the real `.claude/hooks/lib` | fixed — the bracket form is the same undeclared rewrite; case 80 now drives a SYNTHETIC root and never writes into the artifact under test | 96 (both poles); 80 |
| fixture gaps: case 78 asserted the worker's presence ONCE while two walker branches supply it; case 69 required the same file from both the bare and the `module.require` form | fixed — each branch has its OWN root (85 `new Worker`, 86 `require.resolve`) and case 69 gives each load form its own file | 69 / 85 / 86 |

### The resolution boundary — pinned vs refused, stated

A path expression RESOLVES when it is: a `./`/`../` string literal; a
`path.join` / `path.resolve` / destructured-`join` chain anchored on `__dirname`
or a dirname-equivalent binding (`path.dirname(fileURLToPath(import.meta.url))`);
a PROJECT-ROOT-anchored join (a runtime identifier or member expression as the
anchor, literals and known relative bindings after it); `__filename` /
`fileURLToPath(import.meta.url)` (SELF); a `realpathSync`/`resolve`/`normalize`
wrapper over another resolvable path; or a SINGLE-IDENTIFIER argument bound by
one of the above. Binding lookups are SITE-LOCAL — the nearest declaration at or
above the site's line — because a flat map made two same-named `const rel`
bindings in one file resolve to each other's targets (MEASURED: line 86 of
`burndown-build.mjs` was pinned to `git-subprocess-env.js`, a file it never
loads).

EVERYTHING ELSE IS REFUSED: a site the walker cannot resolve fails the emit and
names the file, the line, and — where it can — the specifier and why. The only
sanctioned escape is a per-site exemption in `DYNAMIC_REQUIRE_EXEMPTIONS`, or
`--dynamic-require-exempt`, carried IN-DOCUMENT as `dynamic_require_exemptions`
so a consumer sees the hole instead of trusting there was none. This batch
declares 21 sites at the tip, and 21 DISTINCT sites appear in EACH emitted
manifest, up from 3 when this field was added (ARITHMETIC, corrected by the
security re-verify: 14 → 21 is **+7 with ZERO deletions** — five new sites in the
codex-mcp-guard adapter and two in `codex-rule-context.js` — while the other
NINE are the same loads re-stated at new lines. Of the 21, **13** have their file
inside a runtime closure, counted STRICTLY as "the site's file is a `runtimes[]`
entry or appears in a `runtimes[].deps`"; the naive per-entry sum over
`runtimes[].dynamic_require_exemptions` reads 17, because a site shared by several
runtime closures is counted once per closure): coord-background ×3 (the spawned
path is the CALLER's `__filename`, i.e. a row), auto-format (the pinned prettier
bin inside npm's npx cache), codex-native-policy (an inline `-e` program whose
only load is the `require.resolve` in its own argv), codex-rule-context ×2 (the
same inline-`-e` class, both MEASURED with `artifact-glob.js` pinned in the same
closure), codex-hook-runtime (the adapter's HANDLERS list — all eight MEASURED as
rows), local-supervisor (the dispatcher's own detector set), the
codex-mcp-guard adapter ×7 (its `HOOKS_DIR` root is probed at runtime over two
install layouts, so no walker can assemble the base), and five in the build-tool
graph that `validate-emit.mjs` transitively pulls in.

WHY 21 AND NOT 14: the guard-foundation merge that this branch was rebased onto
MOVED nine of these sites (~660 lines inserted above them in `hook-engine.js`,
`server.js`, `coord-background.js` and three more) and ADDED seven — five in the
adapter and two in `codex-rule-context.js`. Because the exemption key is
(file,LINE), every moved site stopped matching and the emit REFUSED until each was
re-stated — the fail-closed direction the line key is chosen for, and the reason a
re-emit after a merge is a measurement rather than a formality. NOTHING WAS
DELETED: an earlier revision of this passage claimed two entries were removed
because their sites had resolved, and the security re-verify measured that FALSE —
`strip-build-internal.mjs:1960` is still a live site and still declared, and
`template-freshness.mjs` never had an entry to delete (its loads are PINS, which
is a different outcome from an entry being retired). It also claimed a "24 → 21"
movement, which was an UNCOMMITTED intermediate measurement and not a state any
committed manifest ever had. Both claims are withdrawn here rather than quietly
reworded, because a reader of the earlier commit would otherwise carry them.

## Rebase batch (2026-10-08) — resolving the lane onto the guard-foundation merge

| delta | disposition | fixture |
| --- | --- | --- |
| the branch was 19 commits behind `dev` and CONFLICTED on two files | rebased; `.claude/settings.json` taken from DEV WHOLESALE (the merged `dispatch-registry.json` hashes `435ff1c4…`, so the lane's `fc9e7a15…` pin would be refused fail-closed by the dispatcher at every event — MEASURED byte-identical to dev's file after the rebase); `.claude/test-harness/ci-audit-fixtures.json` UNIONED, so dev's `hook-local-registry: 40` and dev's raised floors (`journal-frontmatter-shape: 17`, `session-load-backstop: 200`) sit beside this lane's `hook-registry` floor | the rebase's own re-emit (59/76) |
| ONE lane commit was DROPPED by the rebase as already-applied — `c70c09305` "the two weak registrations" | accounted, not silent: its content is present in the tree because dev carries the same change (MEASURED — all five `detect-violations` rows read `on_incomplete: "deny"` in both the tree and dev). 20 lane commits before, 19 after; the one absent is named here | — (conservation accounting on the rebase boundary) |
| the merged row `template-freshness-surface.js` was REGISTERED with no `@hook-contract` block, so the emit refused and NO manifest could be re-emitted with it | fixed — the block is authored from the file's own calls (`fs_writes: []`, `network: false`, `spawns: []`, `idempotent: true`, `may_rewrite_input: false`) with the one-hop-down facts recorded in `notes`; the emitter's own cross-checks validate it, and `contract block` returns OK | the re-emit (59/76) is the assertion |
| nine of the fourteen declared exemption sites ROTTED under the merge (their lines moved) and five sites were NEW — the emit refused until each was re-stated | fixed — the table is re-derived against the merged tree (21 live sites, 21 declared, MEASURED set-equal); two obsolete entries deleted because their sites now RESOLVE, and one whose stated justification measured FALSE was rewritten to declare the hole instead | the re-emit; the union probe is the measurement |
| the walker did not know `path.dirname(__filename)` (the CJS/ESM-shim spelling of the dirname anchor), so `template-freshness.mjs`'s three loads were holes | fixed — PASS 4 accepts `__filename` as well as `fileURLToPath(import.meta.url)`; MEASURED, all three targets (`sync-tier-aware.mjs`, `ecosystem-config.mjs`, `loom-links.mjs`) are now PINNED in that closure | 89 (the anchor family) + the union probe dropping 24 → 21 |
| `https.get(...)` — the ONE network form the capability scan could not see (the contract header named it as a boundary) | fixed — `get` joined `NET_METHODS`; the match still requires an `http`/`https`/`net`/`dns`/`tls` receiver, and MEASURED against this tree no hook or adapter file calls `.get(` on such a receiver, so no existing declaration is contradicted | 98 (receiver form, both poles) |
| the RECEIVER network branch had NO case — deleting it left the battery green | fixed — case 98 drives `https.get` + `https.request` with a benign twin | 98 |
| raw-byte hashing had NO case (no fixture wrote invalid UTF-8) | fixed — case 99 writes invalid UTF-8 and asserts the pin equals the raw digest AND that the decode/re-encode digest provably differs | 99 |
| F4 doc rot: the README's case count | fixed — corrected to the measured 99 in both places | — |
| the M3 figure | corrected to the measured **72 continue / 29 deny** of 101 rows, with the two superseded readings named | — |
| a fleet host name in a note added by this lane (security lens, LOW form) | fixed — genericized to "the remote trestle host this lane ran on". The RESIDUE is TWO dev-authored host lines in the same file — `ci-audit-fixtures.json:36` (a host name) and `:46` (a second one, in the airgap measurement note): both are dev ancestors, neither is this lane's edit, and both are left for the owner of those lines. MEASURED by token sweep: two distinct fleet-host tokens remain, one per line | — |

## Security re-verify batch (2026-10-08) — F1 and the anchor provenance

| delta | disposition | fixture |
| --- | --- | --- |
| F1 — the plain literal branches resolved on a string that only HEADS a larger expression (`require("./a.js" + suffix)`), pinning a file the row may never load; and a CONCAT BINDING was registered as a plain string const, dropping the rest of the expression | fixed — every literal branch now requires the specifier to BE the whole argument (the check case 91 already had), a concat binding is not registered, and a backslash-rooted specifier joins the unpinnable class | 100 (2 hostile shapes + the control that keeps bare literals pinning); mutation F1 → 100 red, reach shown |
| the `path.dirname(__filename)` anchor this lane ADDED was accepted with no provenance check — a file that reassigns `__filename` made the walker pin an in-tree decoy while node loads the file the assignment names (wrong pin), and the spawn reader called a reassigned `__filename` SELF (silent false claim) | fixed — the bare identifier is accepted only on PROOF: no reassignment anywhere in the file AND either a CJS file (where the name is Node's own wrapper parameter) or the file's own shim `const __filename = fileURLToPath(import.meta.url)`. All legit users verified: every `dirname(__filename)` file in this tree carries the shim, and template-freshness's three pins are unchanged | 101 (require side, with control), 102 (anchor-through-join, with control), 103 (the spawn reader's OWN self-check, which 102 does NOT aim at); mutations A1 → 101+102 red, A2 → 103 red. A2 FIRST CAME BACK EMPTY, which is what forced case 103 into existence rather than a vacuity verdict |
| case 98 carried `https.get` AND `https.request` together, so removing `get` from NET_METHODS left the battery green — a case blind to its own member | fixed — one member per fixture (get-only and request-only poles), plus the declared twin | 98; mutation NET → 98 red |
| server.js:265's exemption reason claimed state-resolver.js is "NOT otherwise pinned from this closure", inverting an earlier TRUE statement | corrected — MEASURED: state-resolver.js is a deps path in 105 places (all 102 rows and all three runtime entries) via `append-sink.js:647`; the narrow truth is that server.js's own one-file closure does not hold the edge | the reason text, with its measurement |
| the exemption arithmetic (14 → 21 = +7, ZERO deletions) and the runtime-closure count (13 strict, 17 naive per-entry) | corrected, with the counting rule stated and the earlier wrong claims WITHDRAWN in the passage rather than reworded | the resolution-boundary section above |
| the README's re-emit recipe omitted `--source-sha` | fixed — the recipe names it, with the self-referential caveat (a manifest cannot name the commit that carries it) | README § Re-emitting |

| the provenance proof was still INCOMPLETE — the security lens measured two surviving spellings of the same wrong-pin bypass: a NON-SHIM DECLARATION (`var __filename = <outside>`, skipped because the declaration branch only looked for the shim and the reassignment test excludes declaration tokens) and a DESTRUCTURING ASSIGNMENT (`[__filename] = [x]`, whose `=` sits behind a `]`). Both read as PROVEN in a CJS file, so the emitter pinned the in-tree decoy while node loaded the file the shadow names — require AND spawn variants, no live occurrence in this tree | fixed — a declaration with a non-shim initializer counts as UNPROVEN (a shadow, exactly like a reassignment) and the destructuring pattern is read as an assignment; the CJS and ESM-shim branches keep their proofs | 104 (var spelling: require + spawn + control), 105 (destructuring: require + spawn + control), 106 (the ESM shim spelling, the positive pole the shim branch never had); mutations VAR → 104 red, DESTR → 105 red, reach shown, each reddening ONLY its own case |
| the anchor-provenance change needed no re-emit | measured, not assumed — the live-site set is unchanged at exactly 21/21 and `--check` at the manifest's own `source_sha` is byte-identical (a first check MISMATCHED because the command passed HEAD instead of the manifest's own sha; that was the command, and it is corrected in the row rather than dropped) | the `--check` run |

| M4 — the template/repo split is derived against the EMITTING tree's git, so a consumer clone that does not carry the named sha reads every row as `repo-local`; no case drove that shape | **NOW COVERED** (the orchestrator ordered it as a case, explicitly not a residual): case 107 builds a CONSUMER-SHAPED CLONE — a git repo carrying its own commit but not the sha it is asked to compare against — and drives the emitter twice on the SAME tree. Loom's HEAD sha stands in for the absent commit. The pair is the point: the clone's own sha RESOLVES the split (every committed row `loom-template`/`template`, no warning), the absent sha CANNOT (every row `repo-local`/`repo`, the warning LOUD, `source_drift.reason` declared in `--json`) — and the SAFE-FAIL direction is asserted on its own: NOT ONE row claims `loom-template`, which is the false provenance claim that would make a consumer trust a pin that does not exist | 107 (control + consumer); mutation M4-FALSE (blob match forced true) → 107 red, reach shown, alongside 01/65/73 |

| the provenance rule was an ENUMERATION of redirect constructs, and round 3 measured two more survivors: `for (__filename of […])` (the loop variable is a write with no `=` near it) and `__filename &&= …` (a compound-assignment operator) | fixed by INVERSION, not by a longer list — the anchor is now accepted only when EVERY occurrence of the identifier is READ-shaped and (ESM) the file's sole declaration is the fileURLToPath shim, (CJS) there is no declaration at all. Read-shaped means the next token is not one of the language's assignment operators — a CLOSED, spec-defined set, which is what makes the rule terminate — is not `of`/`in` in a `for` head, and is not `++`/`--` on either side. An unthought-of construct now fails CLOSED as unproven instead of being pinned | 108 (`for…of`: require + spawn + control), 109 (`&&=`: require + spawn + control); mutations: the PRE-v5 contract run against these poles reds 108 AND 109 and nothing else (the wrong-pin is measured, not asserted); W-OPS-EMPTY → 101/102/103/109; FOR-HEAD-OFF → 108 |
| TWO DECISIONS THE INVERSION FORCED, made explicitly rather than by default | (1) THE CJS ARM IS KEPT: a `.js` module's `__filename` is Node's wrapper parameter and needs no declaration, so the arm accepts it with NO declaration anywhere and no write-shaped occurrence — `delegation-default-guard.js` is the live case (two reads, no declaration, MEASURED still pinning). (2) THE SHIM'S OTHER SPELLING IS REFUSED BY DECISION: `require("node:url").fileURLToPath(…)` is a legitimate shim, but it has NO live user in this tree (MEASURED) and whitelisting it would widen the accepted grammar for a shape nobody writes; such a file takes the per-site exemption | the truth table, 16/16, driven through the exported `filenameAnchorProven` |
| ONE LIMIT NAMED RATHER THAN LEFT TO BE FOUND: a PARAMETER that shadows the name (`function f(__filename) { … path.dirname(__filename) … }`) is not classified — a parameter binding and a call argument are the same two tokens from the inside, and telling them apart needs a real parser, which this walker is not | documented in the classifier's own comment as a declared boundary with the exemption path open, so it is a stated limit and not a silent pass | the comment; no live user |
| the inversion's cost to live pins | MEASURED ZERO LOSS: the live-site set is unchanged at exactly 21/21 and `template-freshness.mjs`'s three pins are unchanged; `delegation-default-guard.js` still resolves | the union probe |

| S1/S2/S4 — round 4 measured three more for-head spellings of the same write: `for ([__filename] of …)` (a destructuring TARGET, bracket where the `=` would be), `for (const [a, __filename] of …)` (a loop-scoped SHADOW with the anchor inside the body), and `for await (__filename of …)` (`await` between `for` and `(`, which defeated the earlier "the token before the paren must be `for`" test) | fixed by ONE rule: any occurrence in a for-head TARGET — identifier OR pattern member, classic three-clause heads included — is a write, and the matcher skips `await`; a name in the SOURCE half of the head stays a read | 110, 111, 112 (require + spawn + control each); mutations FOR-TARGET-OFF → 108/110/111/112 red, AWAIT-OFF → 112 ONLY (the await skip is load-bearing exactly there) |
| LOW over-refusal: `const y = __filename;` — a plain RHS READ — was refused as unproven, because the operator test looked for an assignment operator on EITHER side of the name | fixed — only a TRAILING operator and prefix `++`/`--` are writes; an operator BEFORE the name means the name is read (`const y = __filename`, `x += __filename`) | 113 (accept pole); mutation RHS-BROAD → 113 ONLY |
| S3 — direct `eval("__filename = …")` assigns through a string | **DECLARED BOUNDARY, not a fix**: dynamic code is lexically unclosable and a text scan cannot decide it (the security lens demonstrated it in round 4). Recorded in the classifier's own comment beside the PARAM-SHADOW precedent, with the exemption path open and no pole — a pole would assert behaviour the walker cannot have | the comment; the round-4 demonstration |
| the v6 poles' PRE-FIX evidence | MEASURED, not asserted: the previous head's contract (`0f91f6c7b`) checked back into the worktree and run against these poles reds 110, 111, 112 AND 113 (the over-refusal) and NOTHING else — restored from a hash-verified backup | the pre-fix run |

### M3 — residual accepted by orchestrator with security seat, conditions a/b

| delta | disposition | fixture |
| --- | --- | --- |
| M3 — a refusal that lives in a LIBRARY is invisible to the emitter (severity is lexed from the hook's own bytes) | **residual accepted by orchestrator with security seat, conditions a/b** — accepted, NOT fixed in this shard; condition (a) is the next train's first item | none here by construction: the RED fixture for (a) is the next train's first item, because the derivation has to be designed (boundary, exemption, or deny-capable propagation), not toggled |

The two conditions, verbatim from the ruling:

- **(a)** "The first item of the next train is a red fixture where a lib-sourced
  deny severity makes the emitter REFUSE (or derive deny-capable across the
  import closure) instead of emitting continue."
- **(b)** "csq is told about the class so it treats it conservatively."

WHY THIS SHARD DID NOT CHANGE THE EMITTER: severity is lexed from the HOOK'S OWN
source, so a refusal that lives in a library is invisible, and the size of the
manifest that a closure-aware derivation would have to re-decide is the whole
reason it has to be designed rather than toggled.

THE FIGURE, at the tip: of the manifest's 101 rows, **72 emit `continue` and 29
emit `deny`** (MEASURED over `.claude/hook-registry.json`), so a blanket closure
reading — a row whose closure holds a refusal token must be deny-capable —
refuses 72 rows of 101, most of the manifest. For context, the refusal tokens are
not rare: all 101 rows carry a dependency that holds one (`hook-engine.js`
directly in 100 of them, `instruct-and-wait.js` in the hundredth).

TWO EARLIER READINGS ARE SUPERSEDED and are named here rather than dropped,
because each was committed and a reader of either commit would otherwise carry a
number this row no longer states: the FIRST wording said "71 of 101" (that is the
`continue` count under a slightly narrower filter, quoted as though it were the
refusal-token population); the SECOND said "101 of 101 … and 71 of those emit
continue" after an independent re-derivation refuted the first — arithmetically
sound, but it made the population the headline and buried the 72/29 split that
the blanket reading is actually governed by. The reader's number is 72/29.

### The walker itself — LONGER TERM, replaced

The walker IMITATES the loader and keeps missing load forms; this batch is the
sixth round of that. LONGER TERM it is replaced by the guard foundation's
consumer-tree provider (Node's own parser + resolvers, partner P3), which reads
the REAL loader's behaviour instead of re-spelling it. Recorded here so the next
reviewer reads the shape of the churn, not just its instances.

### `runtimes[]` — ONE authority (recorded; implementation is a NEXT-TRAIN item)

The registry manifest's `runtimes[]` carries the mechanical UNION of the
dispatcher closure, the Codex adapter closure, and every file in the adapter
package's runtime set. csq Gate verifies that SINGLE manifest-level set, and REDS
if either source set has a file the union lacks. Recorded now because the union
is the only shape in which the two sources cannot drift apart; the implementation
is a next-train item.

## Behaviour the manifest still does NOT cover (declared, not discovered)

1. `[A]` fields are DECLARATIONS: `fs_writes` shape, `idempotent`, `cost`,
   `may_rewrite_input` are author-authored; only `may_rewrite_input` is
   cross-checked against the source, and only for the contradiction direction.
2. The `[A]` cross-checks are lexical over ONE file plus its resolved closure —
   an aliased binding, a capability one hop down a lib, or a computed reply key
   is invisible.
3. The closure covers RELATIVE requires only; a dynamic site is refused unless
   an exemption names it, and exemptions are sites, surfaced in-document.
4. Transitive integrity is bounded by the closure walk: `deps`, `runtimes[]`,
   and nothing else. A file reached by a non-require path is outside every pin.
5. `content_sha256` is internal consistency; the consumer's out-of-band pin is
   what makes it evidence about the world.
