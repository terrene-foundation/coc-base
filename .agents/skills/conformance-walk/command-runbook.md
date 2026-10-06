# Command Runbook — Driving The Conformance Walk From `/conformance-walk`

This is the per-flavor runbook the `/conformance-walk` command drives. It carries the
DEPTH the command references — the flavor-detection algorithm, the per-flavor adapter-family
scan specifics, and the report contract — extracted from the command body to keep it under
the 150-line budget (`cc-artifacts.md` Rule 3 / `command-skill-parity.md` MUST-1).

It does NOT redefine the CW model. The freeze-then-judge model, `cw_core`, the
adapter-registry interface, the three-family adapter table, the verdict taxonomy, and the
phase-action triggers live in `SKILL.md` (this file's sibling) + `rules/conformance-walk.md`.
Read those first; this file is the command's operational overlay on top of them.

CW = one **`cw_core`** + three oracle families on one delivery axis — **Source (SCM) →
Delivered (DCM/FCM) → Live (API/CLI/MCP/FE=TOW)**. The `cw_core` record schema is the
interop boundary; any-language adapter emits schema-valid JSON with zero shared code, so
the report below composes identically whichever flavor was detected.

## Flavor Detection

The command resolves exactly one flavor at invocation and applies the matching adapter
family — the user never chooses. Detection is a deterministic read of the repo's manifest
files (config-branching, not agent judgment):

1. **Read the host-language manifests present:** `Cargo.toml` (Rust), `pyproject.toml` /
   `setup.py` / `setup.cfg` (Python), `package.json` (Node), `Gemfile` (Ruby). Delegate to
   stack-detector when the host language is ambiguous or multiple manifests coexist.
2. **Look for kailash markers** (signal precedence, first match wins):
   - a shipped `conformance-walk/` engine directory (the kailash SDK ships `cw_core` + the
     Source/Delivered/Live adapters) — the strongest signal;
   - a `kailash*` crate dependency in `Cargo.toml` (kailash-rs);
   - a `kailash` / `kailash_*` package dependency in the Python manifest (kailash-py);
   - a kailash marker under a different host language (other kailash-*).
3. **Resolve to one flavor:**
   - **kailash-rs** — Rust host + kailash markers.
   - **kailash-py** — Python host + kailash markers.
   - **other kailash-\*** — kailash markers, a different host language.
   - **non-kailash** — no kailash markers (the fail-safe default; never guess kailash).
4. **Fail-safe:** absence of any kailash marker resolves to **non-kailash** (core-only),
   never to a kailash flavor. A mixed / polyglot repo resolves per the surface being walked
   (a kailash Python package inside a non-kailash monorepo walks kailash-py for that
   package, non-kailash for the rest).

Report the detected flavor in the first line of the walk report so the reader knows which
adapter family ran.

## Adapter Families

### kailash-\* → the kailash reference adapter FAMILY (methodology + shipped engine)

Run the CW methodology (the frozen-expectation walk) PLUS the language-specific engine that
ships with the kailash SDK — `cw_core` + the three oracle-family adapters. Per flavor:

- **kailash-rs**
  - **Source (SCM):** scan `crates/**` for the public-symbol surface via rustdoc-JSON —
    every exported `fn` / `struct` / `enum`, judged WITHOUT running.
  - **Delivered (DCM/FCM):** render the reachable public surface under the EXACT resolved
    shipped-feature profile (the wheel × binding × resolved cargo feature set) — a symbol
    compiled out of the default feature set is an ABSENT delivered node, even when the
    source has it. The delivery gap is the thesis (`rules/conformance-walk.md` § the
    delivery gap).
  - **Live (API/CLI/MCP/FE=TOW):** service-boot + real invocation matched against the
    frozen post-state; non-Rust surfaces conform via the `cw_core` JSON contract.
- **kailash-py**
  - **Source (SCM):** scan the package / `__all__` / AST surface for the exported public
    symbols, judged without running.
  - **Delivered (DCM/FCM):** render the reachable surface under the shipped wheel × binding
    surface (per-wheel binding-parity, authority derived from the ecosystem lead) — a
    binding wrapper never generated is an absent delivered node.
  - **Live (API/CLI/MCP/FE=TOW):** live invocation matched against the frozen post-state.
- **other kailash-\*** — run the kailash adapter family with language-appropriate Source /
  Delivered / Live adapters where the SDK ships them; where a given surface has no shipped
  adapter for that language, that surface DEGRADES to core-only (reported as such, never
  faked) rather than failing the whole walk.

One capability record spans `Source symbol ↔ Delivered node ↔ Live endpoint/tool/route`
(the `cw_core` linkage): a Fail on the Delivered node surfaces the WHOLE capability.

### non-kailash → ARTIFACT-ONLY / core-only

Run the CW methodology + `cw_core` + the consumer's OWN per-surface adapters. Each repo
authors an adapter for every surface it exposes (the three required methods —
`enumerate_units` / `freeze_expectation` / `oracle` — per `SKILL.md` § adapter-registry
interface + § per-consumer adapter obligation). Surfaces with no applicable adapter degrade
gracefully: reported as `Not-Run` / `Skipped` per the discrete taxonomy, never silently
counted as `Pass`. No kailash engine is assumed; only `cw_core` + the consumer's adapters
run.

## Report Contract

Emit ONE walk report, opening with the detected flavor + adapter family, then three
sections kept DISTINCT (never collapsed into a single "100%"):

1. **Coverage + frontier** — is every enumerated unit measured? Over the MACHINE-DERIVED
   denominator (enumerated from source/runtime, never hand-listed; the no-vacuous-eval
   guard applies — a verdict counts toward coverage only with ≥1 real assertion). Name the
   un-expectationed FRONTIER (units with no frozen expectation yet) SEPARATELY. Reported
   independently of pass-rate: coverage can be 100% while pass-rate is 80% — that is the
   honest state.
2. **Structural-BLOCK findings → the CI gate** — the DETERMINISTIC-oracle failures. These
   are the load-bearing verdicts; they hard-fail the merge gate (`rules/conformance-walk.md`
   MUST-2 — only the deterministic oracle may block CI).
3. **Semantic-ADVISORY worklist → the human** — the pre-computed per-unit questions no
   oracle can settle (L2 semantic-stub / L5 naive-fallback probe concerns). These ADVISE
   `/redteam`; they MUST NOT hard-fail CI. Each row names the exact unit + the exact
   question, so `/redteam`'s budget goes to ADJUDICATION, not discovery.

Every unit's verdict is from the discrete taxonomy `Pass | Fail | Blocked | Retest |
Skipped | Not-Run` (`rules/conformance-walk.md` MUST-4). The RATCHET stands as the standing
merge gate: a new unit without a frozen expectation, or a coverage regression, fails the
gate (`SKILL.md` § phase-action triggers — ratchet @ deploy/CI).

CW is the STANDING, mechanical, PRE-`/redteam` gate: it front-loads the deterministic half
and hands `/redteam` a pre-computed advisory worklist; it does NOT replace the adversarial
round (`SKILL.md` § CW vs /redteam).
