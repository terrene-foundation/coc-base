/*
 * manifest-source.mjs — the ONE class-aware `sync-manifest.yaml` reader.
 *
 * loom#1386. Every producer lib in `.claude/bin/` (emit.mjs, lib/coc-manifest.mjs,
 * lib/variant-overlay.mjs) is `ALWAYS_INCLUDE` in sync-tier-aware.mjs — shipped
 * VERBATIM to consumers of every repo class. Those libs held 16 UNGUARDED
 * `safeReadFileSync(sync-manifest.yaml)` calls. On a `coc-build` /
 * `coc-use-template` / `coc-project` repo the manifest MUST NOT exist
 * (emit.mjs::_classifyManifestPresence, loom#1383), so every one of those reads
 * threw ENOENT and `emit.mjs --all` could not run AT ALL on a consumer.
 *
 * WHY ONE READER RATHER THAN 16 GUARDS. A guard that conflates "absent" with
 * "present but corrupt" is a silent-fallback defect (`zero-tolerance.md` Rule 3):
 * a truncated / unreadable / symlink-swapped manifest at LOOM would degrade into
 * "empty exclusions, empty tiers, no variants" and emit a silently-wrong tree.
 * Sixteen hand-rolled guards is sixteen chances to write that bug. This module is
 * the single discriminator, modelled on the shape
 * `scan-synced-disclosure.mjs::readEcosystemOwnOrgs` already uses for a different
 * loom-only file: absence is guarded EXPLICITLY, present-but-unparseable throws
 * LOUD.
 *
 * WHY ERROR-CODE CLASSIFICATION AND NOT `existsSync` FIRST. An `existsSync` probe
 * followed by an open is a check-to-use window (`security.md` § Path Containment).
 * We open ONCE and classify the failure by `errno`:
 *
 *     ENOENT   → ABSENT      (class-conditional; see below)
 *     anything → PRESENT-BUT-UNREADABLE → LOUD throw, never "empty"
 *     else     (EACCES, EISDIR, ELOOP/EMLINK, …)
 *
 * ELOOP matters specifically: `safeReadFileSync` opens `O_NOFOLLOW`, so a symlink
 * swapped in for the manifest raises ELOOP (#569; EMLINK on some BSD kernels).
 * Folding that into the absent branch would convert loom's TOCTOU tripwire into a
 * silent empty read.
 *
 * CAVEAT, carried over from the reader this replaced: `O_NOFOLLOW` guards the
 * LEAF component ONLY. A symlinked `.claude/` PARENT silently redirects both
 * `sync-manifest.yaml` AND `.claude/VERSION` — the data and the trust anchor
 * together — with no ELOOP. Pre-existing and out of this module's reach; recorded
 * so the guard is not read as stronger than it is.
 *
 * A fourth corrupt-manifest mode — TRUNCATED — opens and reads cleanly and so is
 * invisible to errno. It is gated separately by `assertNotTruncated` below
 * (F1394-B); see that function for its deliberately-bounded scope.
 *
 * TRUSTED INPUT, NAMED (F1394-A). Every gate in this module resolves through
 * `.claude/VERSION::type`: the owner-class absence throw, `isManifestOwnerClass`
 * (which gates Validator 15 entirely and Validator 17's half B), and — via
 * emit.mjs — Validator 16's presence classifier. That file is therefore a single
 * root of trust for the distribution engine, and its fencing is ASYMMETRIC BY
 * DECISION rather than by oversight. The Bash lane DOES match it: the registry
 * row at `.claude/hooks/lib/guard-path-scope.js:1304-1309` carries
 * `surfaces: { bash: true, layer3: true }`, and `:1751` builds `STATE_PATH_RX`
 * from exactly that `bash` surface set (`validate-bash-command.js:139-142`
 * imports it from there rather than defining its own). The file-tool deny floor
 * (`reconcile-settings-deny.mjs::CANONICAL_STATE_DENY`) DECLINES it, and the
 * decline is recorded with its reason at `reconcile-settings-deny.mjs:101-112`:
 * `.claude/VERSION` has two Edit/Write-TOOL writers on documented happy paths
 * plus one on a HALT/error-recovery path, none with a ceremony script to route
 * through, so a blanket deny would break three shipped flows.
 *
 * An earlier revision of this paragraph asserted `.claude/VERSION` was matched by
 * NEITHER fence. The `STATE_PATH_RX` half was FALSE — #1399's Bash half LANDED,
 * as `reconcile-settings-deny.mjs:104` states in terms — and it is corrected here
 * rather than quietly overwritten, because a comment reporting a trust anchor as
 * unfenced when it IS fenced is exactly the `zero-tolerance.md` Rule 3e class
 * this module's own gates exist to catch.
 *
 * Framed honestly: against an attacker who can already WRITE `.claude/VERSION`
 * this is a CONCENTRATION of trust, not a new privilege — such an attacker could
 * usually write the manifest too. The case that actually bites is the ACCIDENT: a
 * mis-authored, mis-merged, or mis-synced `.claude/VERSION` at loom silently
 * converts several independent gates into no-ops and prints green, with no second
 * signal anywhere. Before these gates shared this input they degraded
 * independently. Fencing the file is tracked separately (loom#1399) because both
 * candidate lists live in other shards' surfaces this wave — `STATE_PATH_RX` in
 * `validate-bash-command.js` (F3/#1390) and `CANONICAL_STATE_DENY` in
 * `reconcile-settings-deny.mjs` (F1/#1371).
 *
 * WHAT ABSENCE MEANS IS CLASS-CONDITIONAL (the loom#1386 ruling):
 *
 *   coc-source (loom)  manifest is REQUIRED — it is the splitter's declaration of
 *                      every artifact's distribution fate. Absent → LOUD throw.
 *                      This is the reader-level twin of Validator 16's fail-closed
 *                      direction (loom#1383) so a DIRECT importer of these libs
 *                      (emit-cli-artifacts.mjs, emit-coc.mjs — neither runs V16)
 *                      cannot silently emit a tree composed from "no manifest".
 *
 *   coc-build /        manifest MUST NOT exist. Its absence is not a degraded
 *   coc-use-template / state, it is the CORRECT state the class asserts. Absent →
 *   coc-project        return null, and the CALLER supplies the value that is TRUE
 *                      for a repo that distributes nothing (see the four
 *                      dispositions below).
 *
 *   unresolvable       Absent → LOUD throw. Defaulting to "owner" breaks every
 *                      consumer; defaulting to "consumer" fail-OPENs loom's gate.
 *                      Both are worse than refusing to guess.
 *
 * THE FOUR CALLER DISPOSITIONS (loom#1386 ruling 3 — NOT blanket-empty).
 *
 * ADDING A 17th READ SITE? Pick from these four. If none fits, the answer is
 * almost certainly D4 — do NOT reach for D1 because "return empty" looks
 * harmless. For an ASSERTION, empty is not a neutral default: it is a vacuous
 * pass, which is the exact defect this whole module exists to prevent.
 *
 *   D1 DISTRIBUTION-DECLARATION reads (loom_only, cli_emit_exclusions,
 *      surface_roles, variants) → declared-empty. On a class where the manifest is
 *      FORBIDDEN the repo distributes nothing, so "no exclusions / no overlays" is
 *      the TRUE answer, not a fallback. (`tiers` was D1 until loom#1394's partition
 *      audit — see D3.)
 *
 *      NOT the D1 discriminator — the "a PRESENT manifest missing that stanza
 *      returns the IDENTICAL value" property. That property holds for all FOUR D1
 *      sites AND all SIX D2 sites (10/10), because it is exactly what D2 means by
 *      "the default the function ALREADY declares". It argues for D1∪D2 JOINTLY
 *      (absence routes to a value already in the contract rather than inventing
 *      one) and therefore cannot separate D1 from D2. What separates them is what
 *      the value MEANS: a D1 value is a DECLARATION that is literally true of a
 *      repo distributing nothing; a D2 value is the function's own TUNING default,
 *      which is why D2 needs the tighter/parity/no-gate analysis below and D1 does
 *      not. What separates D1 from D3 is the empty-is-benign vs
 *      empty-is-catastrophic test stated under D3.
 *
 *   D2 EMIT-TUNING reads (per-rule budgets, tolerance, block threshold, caps,
 *      headroom + budget exceptions) → the default the function ALREADY declares
 *      for a manifest that is present but lacks the stanza. Absence is routed to
 *      the same default one layer earlier; no new fallback is invented.
 *
 *      D2 is NOT uniformly "a tighter default" — that blanket is false, and
 *      stating it as one is how a future author mis-sizes a 17th site. Checked
 *      against loom's LIVE manifest values, the six D2 sites are three kinds:
 *        · defaults TIGHTER  — headroom + per-rule-budget exceptions. Both WIDEN
 *          a gate when present, so empty is strictly the strictest answer: a
 *          consumer can never inherit a waiver loom granted itself.
 *        · defaults at PARITY — tolerance (±30%), block threshold (+30%) and the
 *          per-CLI caps (warn 32768, block 65536, floor 10) equal what the
 *          manifest declares; emit-class-blind-manifest-reads.test.mjs::F1394-C
 *          asserts each, so a parity break in EITHER direction reds it. Its caps half
 *          is PER CLI: it first proves an edit to one CLI's stanza moves only that
 *          CLI's value (F1394-C-b does it through loadCliCaps() on a manifest file),
 *          so caps read from another CLI's stanza — as gemini's were read from
 *          codex's until 2026-09-12 — red instead of passing on equal values. The
 *          block fallback (emitBaseline's fallback object) followed the 2026-08-12
 *          raise to 65536 (plan §3.2 option b, expires 2027-02-12). CORRECTED
 *          2026-09-12: this said it stayed 61440 with no tripwire; both were false.
 *          The tripwire fires when the test runs — not on the expiry date, and never
 *          in a consumer running no loom tests. A PRESENT unparseable stanza throws.
 *        · NO GATE TO ASSERT — per-rule budgets. An empty Map REMOVES a per-entry
 *          gate rather than tightening one: every rule takes the `else` arm of
 *          emitBaseline's `budgets.has(rule)` test (an advisory WARN), and a budget
 *          BLOCK is recorded only in the other arm, so main() never fails on one. It
 *          is D2 on the V15 "no proposition" argument — a consumer has no per-rule
 *          budgets of its own and loom already gated its rules — NOT a tighter default.
 *
 *      That last one is why `assertNotTruncated` is a GATE-PRESERVATION fix and
 *      not hygiene: a present-but-truncated manifest AT LOOM yields no
 *      `per_rule_size_budget_bytes:` block, so every rule silently converts from
 *      BLOCK to WARN — on the owner class, reachable through
 *      `emit-cli-artifacts.mjs` / `emit-coc.mjs`, which run neither V15 nor V16.
 *
 *   D3 REFUSE-LOUDLY reads (repos.<target>.{tier_subscriptions,variant,role}, and
 *      `tiers`) → there is no answer to give. Naming a `--target` on a repo that
 *      has no manifest is an operator error; answering "no subscriptions" would
 *      fail OPEN into an emit-everything or emit-nothing plan for a target that
 *      does not exist.
 *
 *      THE D1-vs-D3 TEST — what does the EMPTY value DO downstream, not what KIND
 *      of stanza it is. Do NOT sort by "target-resolution lookup vs top-level
 *      catalogue": `tiers` is a top-level catalogue exactly like
 *      `cli_emit_exclusions`, takes no `--target`, and is still D3. That framing
 *      would place a FIFTH concept by its shape and get it wrong. The test is
 *      whether the empty value is CATASTROPHIC or BENIGN at the consuming site:
 *        · empty is CATASTROPHIC → D3. Empty `tiers` matches NOTHING, so a caller
 *          composes an emission that drops EVERY artifact while reporting success.
 *          Empty `repos.<target>.variant` reads as "no variant declared" and
 *          silently drops the language overlay.
 *        · empty is BENIGN → D1. Empty `surface_roles` → `surfaceRolesAllow`'s
 *          `if (!declared) return true`, so every artifact surfaces (permissive in
 *          the direction a manifest-less repo wants). Empty `variants` → the
 *          composition falls through to the required global base. Empty
 *          `loom_only` / `cli_emit_exclusions` → nothing is withheld.
 *      Both halves are the SAME question asked at the consuming site, which is why
 *      a D3 member need not resemble another D3 member structurally.
 *
 *      `tiers` joined D3 in loom#1394. It had been D1 on the reasoning that its
 *      only caller (`buildTierFilter`) returns early without a target, so the
 *      empty map was unreachable on a forbidden class. True, but the safety was a
 *      CALL-GRAPH property and an ORDER-DEPENDENT one — swapping two lines in
 *      `buildTierFilter` makes `{}` reachable, and nothing enforced the ordering.
 *      `loadTiers` is also exported AND re-exported (`emit-cli-artifacts.mjs`),
 *      so "its only caller" was forward-looking, not structural. Refusing makes it
 *      structural at zero behavioural cost, since the one legitimate reader
 *      already sits behind a D3 refusal.
 *
 *   D4 OWNER-GATED ASSERTION (Validator 15; Validator 17 half B) → gate on
 *      `isManifestOwnerClass` FIRST, then read unguarded and let this module
 *      throw if the manifest is absent at the owner class. This is the shape that
 *      lets a validator report `skipped` with a reason instead of asserting a
 *      proposition that is not true for the class it is running in.
 *
 *      A validator MUST NOT take D1. Returning empty makes the assertion VACUOUS —
 *      it prints a PASS indistinguishable from a real check, which is precisely
 *      the fail-open shape loom#1383 rejected for Validator 16 and the reason
 *      loom#1386 was not a one-line patch. If a new gate has no proposition on a
 *      class, it must SAY so, not silently succeed.
 *
 * Zero internal imports by design: `lib/coc-manifest.mjs` imports
 * `lib/variant-overlay.mjs`, so anything BOTH need must import neither.
 * Node built-ins only.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This module lives at `.claude/bin/lib/`, THREE levels below the repo root
// (lib → bin → .claude → root). Mirrors coc-manifest.mjs's REPO derivation; do
// NOT "simplify" to two `..` (that resolves to `.claude/`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

export const MANIFEST_REL = path.join(".claude", "sync-manifest.yaml");

// F95 — the CLI-emit projection. loom writes it at a target elected by
// `multi_cli_overlays.<template_type>.manifest_distribute`
// (`sync-tier-aware.mjs::emitCliEmitProjection`). It carries ONLY
// `cli_variants` / `cli_emit_exclusions` / `multi_cli_overlays`, so it is NOT a
// sync-manifest and is NOT the forbidden path above — a repo holding it declares
// nothing about tiers, loom_only, surface_roles or repos.*, and Validator 16's
// MUST-NOT-EXIST assertion is untouched.
export const CLI_EMIT_PROJECTION_REL = path.join(
  ".claude",
  ".coc-cli-emit.yaml",
);

// The stanzas the projection carries, in EMISSION ORDER — the ONE declaration,
// shared by the producer (`sync-tier-aware.mjs::buildCliEmitProjection`, which
// slices exactly these) and by the reader's truncation floor below.
//
// It lives HERE, in the reader lib, rather than in the producer, because the
// producer is `loom_only` and the reader SHIPS: a consumer that must decide
// whether its projection is complete cannot import a declaration that never
// reached it. The producer imports this list; a stanza added to the projection
// therefore joins the floor in the same edit, and the two cannot drift into a
// floor that admits a file the producer would never have written.
export const CLI_EMIT_PROJECTION_STANZAS = Object.freeze([
  "cli_variants",
  "cli_emit_exclusions",
  "multi_cli_overlays",
]);

// The repo CLASS vocabulary. `.claude/VERSION::type` is the declaration; see
// `.claude/hooks/lib/version-utils.js` for the canonical four. Positive
// allowlist (`cc-artifacts.md` Rule 10) — an unrecognized value is UNRESOLVED,
// never silently bucketed into either branch.
export const MANIFEST_OWNER_CLASS = "coc-source";
export const MANIFEST_FORBIDDEN_CLASSES = Object.freeze([
  "coc-build",
  "coc-use-template",
  "coc-project",
]);
export const KNOWN_REPO_CLASSES = Object.freeze([
  MANIFEST_OWNER_CLASS,
  ...MANIFEST_FORBIDDEN_CLASSES,
]);

// Symlink-safe read (O_RDONLY|O_NOFOLLOW). Local copy rather than an import for
// the same reason the module has no internal imports (coc-manifest ↔
// variant-overlay would cycle). #569 emit-lane source-read class.
function safeReadFileSync(filePath, encoding) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

// Machine-readable discriminator for `readRepoClass`'s failure branches
// (loom#1502). The prose in `error` is for humans and is free to be reworded;
// `reason` is the CONTRACT a caller may branch on. String-matching the prose
// would make every message edit a silent behaviour change.
//
// The split that matters is BOOTSTRAP vs CORRUPT. A repo that has never declared
// a class (`absent`, `no-type`) may be inferred structurally by a caller that
// says so out loud. A repo whose declaration is present but WRONG
// (`invalid-json`, `unknown-type`) or whose VERSION will not open for a reason
// other than "not there" (`unreadable` — EACCES/EISDIR/ELOOP) MUST NOT be
// inferred: those are corruption or tamper signals, and guessing a class routes
// a proposal to the wrong lane. ELOOP specifically is this module's
// symlink-swap tripwire (#569) — folding it into the bootstrap branch would
// convert that tripwire into a silent structural guess.
export const REPO_CLASS_REASONS = Object.freeze({
  ABSENT: "absent",
  UNREADABLE: "unreadable",
  INVALID_JSON: "invalid-json",
  NO_TYPE: "no-type",
  UNKNOWN_TYPE: "unknown-type",
});

// The ONLY two reasons a caller may fall back to a structural inference on.
// Positive allowlist (`cc-artifacts.md` Rule 10): a reason added later is
// NOT bootstrap-eligible until it is deliberately listed here.
export const BOOTSTRAP_ELIGIBLE_REASONS = Object.freeze([
  REPO_CLASS_REASONS.ABSENT,
  REPO_CLASS_REASONS.NO_TYPE,
]);

/**
 * Resolve the repo class, FAIL-CLOSED on every unresolvable shape.
 * Returns {type, error, reason}: `type` non-null iff `error` is null.
 * On the error branch `reason` is one of REPO_CLASS_REASONS; on success it is
 * null. See REPO_CLASS_REASONS for why callers branch on it and not on `error`.
 *
 * Moved here from emit.mjs (loom#1386) so the three producer libs can all reach
 * it without a cycle; emit.mjs re-exports it unchanged for its existing
 * importers (the loom#1383 test suite). The `reason` field is ADDITIVE
 * (loom#1502) — every pre-existing caller reads only `type`/`error`.
 */
export function readRepoClass(repoRoot = REPO) {
  const versionPath = path.join(repoRoot, ".claude", "VERSION");
  let raw;
  try {
    raw = safeReadFileSync(versionPath, "utf8");
  } catch (e) {
    return {
      type: null,
      error:
        `.claude/VERSION is missing or unreadable (${e.code || e.message}) — ` +
        `cannot determine this repo's class`,
      reason:
        e.code === "ENOENT"
          ? REPO_CLASS_REASONS.ABSENT
          : REPO_CLASS_REASONS.UNREADABLE,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      type: null,
      error:
        `.claude/VERSION is not valid JSON (${e.message}) — ` +
        `cannot determine this repo's class`,
      reason: REPO_CLASS_REASONS.INVALID_JSON,
    };
  }
  const type =
    parsed && typeof parsed.type === "string" ? parsed.type.trim() : "";
  if (!type) {
    return {
      type: null,
      error:
        `.claude/VERSION declares no \`type\` field — ` +
        `cannot determine this repo's class`,
      reason: REPO_CLASS_REASONS.NO_TYPE,
    };
  }
  if (!KNOWN_REPO_CLASSES.includes(type)) {
    return {
      type: null,
      error:
        `.claude/VERSION::type is "${type}", not one of the known repo ` +
        `classes (${KNOWN_REPO_CLASSES.join(", ")}) — cannot determine which ` +
        `manifest expectation applies`,
      reason: REPO_CLASS_REASONS.UNKNOWN_TYPE,
    };
  }
  return { type, error: null, reason: null };
}

/**
 * TRUE iff this repo's class OWNS the manifest (i.e. the manifest is required
 * and every manifest-dependent gate is meaningful here). FALSE for the three
 * forbidden classes. THROWS when the class is unresolvable — a gate that cannot
 * establish which expectation applies must not pick one.
 *
 * This is the predicate the loom-only VALIDATORS (V15 tier-completeness, V17's
 * tier-membership half) gate on. It is deliberately a separate export from
 * `readManifestSource` so a validator can decide "do I have a proposition to
 * assert here?" WITHOUT reading a file.
 */
export function isManifestOwnerClass(repoRoot = REPO) {
  const { type, error } = readRepoClass(repoRoot);
  if (error) {
    throw new Error(
      `[manifest-source] repo class UNRESOLVED — ${error}. A manifest-dependent ` +
        `gate asserts a DIFFERENT proposition per class (${MANIFEST_OWNER_CLASS}: ` +
        `the manifest declares every artifact's distribution fate; ` +
        `${MANIFEST_FORBIDDEN_CLASSES.join("/")}: distribution fate is declared ` +
        `UPSTREAM at loom, not here), so it fails CLOSED rather than guess. ` +
        `Repair .claude/VERSION before emit.`,
    );
  }
  return type === MANIFEST_OWNER_CLASS;
}

// The stanza whose absence means the read is not a usable manifest. `tiers:` is
// the load-bearing choice: it is the core distribution declaration, and an empty
// tier set is the single input that makes the WHOLE emission silently wrong
// (nothing matches any tier → nothing distributes, and every consumer's run is
// green against its own empty view).
const REQUIRED_STANZA_RX = /^tiers:\s*$/m;

/**
 * F1394-B — reject a TRUNCATED manifest.
 *
 * The header above names three corrupt-manifest modes this module refuses to
 * degrade into "empty": truncated, unreadable, symlink-swapped. errno
 * classification covers the latter two, but a zero-byte or severely-truncated
 * file OPENS and READS cleanly, so it would flow to every D1 reader as valid
 * text — empty tiers, empty loom_only, empty exclusions, empty surface_roles,
 * empty variants. That is precisely the sentence the header says it prevents.
 *
 * The asymmetry is what makes it load-bearing rather than theoretical: under
 * `emit.mjs::main()` V15 would fail on empty tiers — but this reader exists FOR
 * the producers that run neither V15 nor V16 (`emit-cli-artifacts.mjs`,
 * `emit-coc.mjs`), and for those a truncated manifest at loom is otherwise
 * ungated end to end.
 *
 * SCOPE, stated honestly rather than over-claimed (the F1394-B lesson is that a
 * header claiming more than the code delivers IS the defect): a stanza-presence
 * check catches the zero-byte / whitespace-only / severely-truncated class. It
 * does NOT catch arbitrary partial truncation — a file cut after `tiers:` but
 * before `loom_only:` still passes here. Structural validity is Validator 16's
 * job (strict-YAML parse); this is the minimum-viability floor for the readers
 * that run before, or entirely without, V16.
 *
 * Applied on EVERY class rather than owner-only, deliberately: gating it behind
 * a class read would add a `.claude/VERSION` parse to all 16 success-path reads
 * (that file is ~362 KB at loom), and a truncated manifest is not more
 * acceptable on a consumer — where a stray manifest is separately rejected by
 * Validator 16 for existing at all.
 */
function assertNotTruncated(text, manifestPath) {
  if (typeof text === "string" && text.trim() !== "" && REQUIRED_STANZA_RX.test(text))
    return text;
  const why =
    typeof text !== "string" || text.trim() === ""
      ? "it is EMPTY (zero-byte or whitespace-only)"
      : "it carries no top-level `tiers:` stanza, so it is truncated or is not a " +
        "sync-manifest at all";
  const err = new Error(
    `[manifest-source] ${MANIFEST_REL} is PRESENT and readable at ${manifestPath} ` +
      `but ${why} — refusing to compose an emission from a TRUNCATED manifest. ` +
      `Every distribution-fate declaration (tiers, loom_only, cli_emit_exclusions, ` +
      `surface_roles, variants) would read as EMPTY and the emitted tree would be ` +
      `wrong in a way nothing downstream detects — the same failure the ABSENT ` +
      `guard blocks, one file-state over. Restore .claude/sync-manifest.yaml from ` +
      `git before emit.`,
  );
  // Typed so readManifestSource's catch can re-raise it verbatim instead of
  // re-classifying a truncation as a read error.
  err.code = "ERR_MANIFEST_TRUNCATED";
  throw err;
}

/**
 * The minimum-viability floor for the F95 CLI-emit PROJECTION.
 *
 * Sibling of `assertNotTruncated`, keyed on the projection's own declared
 * stanzas (`CLI_EMIT_PROJECTION_STANZAS`) instead of on `tiers:`, which the
 * projection deliberately does not carry. Because the producer slices those
 * same stanzas from that same constant, a stanza added to the projection joins
 * this floor in the same edit.
 *
 * SCOPE, stated honestly rather than over-claimed — the same discipline the
 * `assertNotTruncated` header keeps, and for the same reason (a header claiming
 * more than the code delivers IS the defect). This catches:
 *
 *   - the zero-byte / whitespace-only file;
 *   - a cut ANYWHERE before the last stanza header, because all three declared
 *     headers are required and `multi_cli_overlays:` is emitted LAST — so the
 *     mid-`cli_emit_exclusions` cut that motivated this floor is caught.
 *
 * It does NOT catch a cut INSIDE the final stanza's body: the headers are all
 * present, and a short trailing list is structurally indistinguishable from a
 * genuinely short one without a length or digest the projection does not carry.
 * That residual is the same one `assertNotTruncated` names for the manifest, and
 * it is bounded to `multi_cli_overlays` — NOT to `cli_emit_exclusions`, whose
 * over-emission failure is what this floor exists to stop.
 */
function assertProjectionNotTruncated(text, projPath) {
  const missing =
    typeof text === "string" && text.trim() !== ""
      ? CLI_EMIT_PROJECTION_STANZAS.filter(
          (key) => !new RegExp(`^${key}:\\s*$`, "m").test(text),
        )
      : null;
  if (missing !== null && missing.length === 0) return text;
  const why =
    missing === null
      ? "it is EMPTY (zero-byte or whitespace-only)"
      : `it is missing the top-level ${missing
          .map((k) => `\`${k}:\``)
          .join(", ")} stanza${missing.length > 1 ? "s" : ""}, so it is ` +
        `truncated or is not a CLI-emit projection at all`;
  const err = new Error(
    `[manifest-source] ${CLI_EMIT_PROJECTION_REL} is PRESENT and readable at ` +
      `${projPath} but ${why} — refusing to compose an emission from a ` +
      `TRUNCATED projection. The per-CLI declarations would read as EMPTY or ` +
      `SHORT, and this repo's own emitter would ship to \`.codex/**\` and ` +
      `\`.gemini/**\` the very artifacts loom declared withheld — silently, in ` +
      `a way nothing downstream detects. Re-run /sync-to-use from loom to ` +
      `refresh the projection.`,
  );
  // Typed so readCliEmitProjection's catch re-raises it verbatim instead of
  // re-classifying a truncation as a read error.
  err.code = "ERR_CLI_EMIT_PROJECTION_TRUNCATED";
  throw err;
}

// Shared prose for the two LOUD absence throws, so the owner-class and
// unresolved-class messages cannot drift apart.
function absentAtOwnerError(manifestPath, classLabel, why, remediation) {
  return new Error(
    `[manifest-source] ${MANIFEST_REL} is ABSENT at ${manifestPath} — ${why} ` +
      `(class:${classLabel}). Refusing to compose an emission from "no manifest": ` +
      `every distribution-fate declaration (tiers, loom_only, cli_emit_exclusions, ` +
      `surface_roles, variants) would silently read as EMPTY and the emitted tree ` +
      `would be wrong in a way nothing downstream detects. ${remediation}`,
  );
}

/**
 * Read `sync-manifest.yaml`, class-aware.
 *
 * @param {string} [repoRoot]
 * @returns {string|null}  the manifest text, OR `null` when the manifest is
 *   EXPECTED-absent (a class that FORBIDS it). Never returns "" for an absent
 *   file — `null` is the discriminator callers switch on, and an empty-string
 *   manifest on disk is a genuinely present (if useless) file.
 * @throws when the manifest is absent on the owner class, absent on an
 *   unresolvable class, or PRESENT-but-unreadable on any class.
 */
export function readManifestSource(repoRoot = REPO) {
  const manifestPath = path.join(repoRoot, MANIFEST_REL);
  try {
    return assertNotTruncated(safeReadFileSync(manifestPath, "utf8"), manifestPath);
  } catch (e) {
    // A truncation throw is already fully-formed — re-raise rather than
    // re-classifying it as a read error below.
    if (e && e.code === "ERR_MANIFEST_TRUNCATED") throw e;
    // PRESENT-but-unreadable — EACCES, EISDIR, ELOOP/EMLINK (O_NOFOLLOW symlink
    // swap, #569), EMFILE, … NEVER conflated with absence (zero-tolerance.md
    // Rule 3).
    if (e && e.code !== "ENOENT") {
      // O_NOFOLLOW on a symlink LEAF raises ELOOP on Linux/Darwin but EMLINK on
      // some BSD-derived kernels. Both are the same tripwire; matching only
      // ELOOP would drop the explanatory text on those platforms.
      const symlinkTripwire = e.code === "ELOOP" || e.code === "EMLINK";
      throw new Error(
        `[manifest-source] ${MANIFEST_REL} is PRESENT but UNREADABLE at ` +
          `${manifestPath} (${e.code || e.message}) — refusing to degrade an ` +
          `unreadable manifest into an empty one. ` +
          (symlinkTripwire
            ? `${e.code} means the path is a SYMLINK: the emit lane opens ` +
              `O_NOFOLLOW on purpose (#569), so this is a tripwire, not a ` +
              `config choice. `
            : "") +
          `Fix the file's readability before emit.`,
      );
    }
    // ENOENT — absence. What it MEANS is class-conditional.
    const { type, error } = readRepoClass(repoRoot);
    if (error) {
      throw absentAtOwnerError(
        manifestPath,
        "UNRESOLVED",
        `and this repo's class cannot be determined (${error}), so whether that ` +
          `absence is a DEFECT (${MANIFEST_OWNER_CLASS}) or the REQUIRED state ` +
          `(${MANIFEST_FORBIDDEN_CLASSES.join("/")}) is unknowable`,
        // The remediation MUST NOT be "restore the manifest" here. On a consumer
        // whose .claude/VERSION is merely corrupt, following that instruction
        // plants exactly the SECOND DISTRIBUTION SOURCE #1383 forbids. The
        // unresolved input is the CLASS, so the class is what to repair.
        `Repair .claude/VERSION before emit — do NOT create a manifest to satisfy ` +
          `this message: on a ${MANIFEST_FORBIDDEN_CLASSES.join("/")} repo a local ` +
          `manifest is a SECOND distribution source and Validator 16 rejects it.`,
      );
    }
    if (type === MANIFEST_OWNER_CLASS) {
      throw absentAtOwnerError(
        manifestPath,
        type,
        `a ${MANIFEST_OWNER_CLASS} repo is the splitter/distributor and MUST hold ` +
          `the manifest that declares every artifact's distribution fate`,
        `Restore .claude/sync-manifest.yaml before emit.`,
      );
    }
    // A forbidden class: absence is REQUIRED here, not merely tolerated
    // (emit.mjs::_classifyManifestPresence — a local manifest would be a SECOND
    // distribution source). Hand the caller the discriminator.
    return null;
  }
}

/**
 * F95 — read the CLI-emit projection, or `null` when it is not present.
 *
 * The projection is ELECTED, not universal: only a template whose
 * `multi_cli_overlays.<template_type>.manifest_distribute` is true receives one,
 * so ABSENCE is a legitimate state on every class and is NEVER an error here.
 * The caller decides what absence means for the stanza it wants.
 *
 * PRESENT-but-unreadable throws, on the same grounds `readManifestSource`
 * throws: degrading an unreadable declaration into an empty one is the exact
 * over-emission this file exists to prevent (zero-tolerance.md Rule 3). The
 * O_NOFOLLOW symlink tripwire (#569) is carried for the same reason.
 *
 * A TRUNCATION FLOOR IS applied, by `assertProjectionNotTruncated`. It could not
 * be `assertNotTruncated`, which keys on a `tiers:` stanza the projection
 * deliberately does not carry — reusing that one would reject every valid
 * projection. The floor here keys on the projection's OWN declared stanzas
 * instead. Previously NO floor ran, and the gap was not hypothetical: the
 * projection's whole job is to carry `cli_emit_exclusions` to a consumer that
 * runs the per-CLI emitter FOR ITSELF, so a file cut mid-stanza read as a SHORT
 * LIST — indistinguishable from a genuinely shorter declaration — and every
 * artifact past the cut was over-emitted to `.codex/**` and `.gemini/**`. That
 * is the same one-file-state-over failure the ABSENT guard blocks, and it is
 * exactly the class `readManifestSource` refuses for the manifest proper.
 *
 * @param {string} [repoRoot]
 * @returns {string|null} the projection text, or `null` when absent.
 * @throws when the projection is present but empty or missing a declared stanza.
 */
export function readCliEmitProjection(repoRoot = REPO) {
  const projPath = path.join(repoRoot, CLI_EMIT_PROJECTION_REL);
  try {
    return assertProjectionNotTruncated(
      safeReadFileSync(projPath, "utf8"),
      projPath,
    );
  } catch (e) {
    // A truncation throw is already fully-formed — re-raise rather than
    // re-classifying it as a read error below (the shape readManifestSource
    // uses for ERR_MANIFEST_TRUNCATED).
    if (e && e.code === "ERR_CLI_EMIT_PROJECTION_TRUNCATED") throw e;
    if (e && e.code === "ENOENT") return null;
    const symlinkTripwire = e.code === "ELOOP" || e.code === "EMLINK";
    throw new Error(
      `[manifest-source] ${CLI_EMIT_PROJECTION_REL} is PRESENT but UNREADABLE ` +
        `at ${projPath} (${e.code || e.message}) — refusing to degrade an ` +
        `unreadable per-CLI emission declaration into an empty one, which would ` +
        `silently over-emit every artifact loom declared withheld from Codex ` +
        `and Gemini. ` +
        (symlinkTripwire
          ? `${e.code} means the path is a SYMLINK: the emit lane opens ` +
            `O_NOFOLLOW on purpose (#569), so this is a tripwire, not a ` +
            `config choice. `
          : "") +
        `Fix the file's readability before emit.`,
    );
  }
}

/**
 * D3 — REFUSE. Read the manifest for a TARGET-RESOLUTION lookup, where "the repo
 * has no manifest" can never be answered with a value.
 *
 * `repos.<target>.{tier_subscriptions,variant,role}` answers "what does loom ship
 * to <target>". A repo whose class FORBIDS the manifest has no sync targets at
 * all, so a named `--target` there is an operator error. Returning null/[] would
 * fail OPEN — `buildTierFilter` would emit for a target that does not exist, or
 * `loadTargetVariant` would silently drop the language overlay.
 *
 * @param {string} target  the target slug the caller was asked to resolve
 * @param {string} what    the field being resolved (for the error message)
 */
export function requireManifestSourceForTarget(target, what, repoRoot = REPO) {
  const src = readManifestSource(repoRoot);
  if (src === null) {
    const { type } = readRepoClass(repoRoot);
    throw new Error(
      `[manifest-source] cannot resolve ${what} for --target '${target}': this ` +
        `repo's class is "${type}", which FORBIDS ${MANIFEST_REL} (distribution ` +
        `fate is declared UPSTREAM at loom, never here). A "${type}" repo has no ` +
        `sync targets, so '${target}' cannot be resolved and refusing is the only ` +
        `safe answer — answering "no subscriptions" would emit a plan for a target ` +
        `that does not exist. Drop --target: emit composes this repo's OWN artifacts ` +
        `when no target is named.`,
    );
  }
  return src;
}

/**
 * D3 — REFUSE, target-free. The same disposition for a distribution read that
 * takes no `--target` but still has no meaningful answer on a class that FORBIDS
 * the manifest.
 *
 * Reaching for this on a NEW top-level stanza? The test is the header's D1-vs-D3
 * one — whether the EMPTY value is catastrophic or benign at the consuming site —
 * NOT whether the read takes a `--target`. `tiers` routes here precisely because a
 * top-level catalogue can have a catastrophic empty.
 *
 * Added by loom#1394's partition audit for `loadTiers`. Its previous D1 empty-map
 * was SAFE but only as a call-graph property: `buildTierFilter` returns early
 * without a target before ever reaching it. That safety was order-dependent (two
 * swapped lines make `{}` reachable) and forward-looking (`loadTiers` is exported
 * AND re-exported, so "its only caller" is an assumption, not a guarantee).
 * Refusing converts it to a structural guarantee at zero behavioural cost.
 */
export function requireManifestSource(what, repoRoot = REPO) {
  const src = readManifestSource(repoRoot);
  if (src === null) {
    const { type } = readRepoClass(repoRoot);
    throw new Error(
      `[manifest-source] cannot resolve ${what}: this repo's class is "${type}", ` +
        `which FORBIDS ${MANIFEST_REL} (distribution fate is declared UPSTREAM at ` +
        `loom, never here). A "${type}" repo declares no ${what}, and refusing is ` +
        `safer than answering "empty": an empty ${what} silently matches NOTHING, ` +
        `so a caller would compose an emission that drops every artifact while ` +
        `reporting success.`,
    );
  }
  return src;
}

// ────────────────────────────────────────────────────────────────
// Path-scoped stanza reading — pure text, no file access
// ────────────────────────────────────────────────────────────────
//
// Key NAMES repeat at different depths of sync-manifest.yaml: `codex:` and
// `gemini:` each open a stanza under `cli_emit_exclusions` AND under
// `cli_variants."context/root.md"`, and `codex:` opens more under other
// `cli_variants` entries. A reader that finds `<name>:` with an unanchored regex
// gets whichever occurrence comes FIRST in the file, not the one at the path it
// means — the defect that had Gemini's caps read out of Codex's stanza. These
// helpers resolve a key by its full PATH, so a value can only come from the
// stanza that declares it.
//
// SCOPE, so this is not mistaken for a YAML parser: block mappings keyed by
// indentation. A block's children are the key lines at the indent of its first
// content line; blank and comment-only lines are skipped; list items (`- …`) are
// never keys; a block scalar's content sits deeper than its key and so is never
// read as a sibling. Flow collections, anchors/aliases and multi-line plain
// scalars are NOT resolved — structural validity stays Validator 16's strict
// parse (`emit.mjs::validateManifestYaml`). Two ambiguities THROW instead of
// resolving silently: a key repeated at one level (YAML forbids it; pyyaml keeps
// the LAST, a scanning reader keeps the FIRST), and a TAB in structural
// indentation (YAML forbids it; counting it as zero columns would silently end
// every enclosing block).

const YAML_NON_CONTENT_RX = /^\s*(?:#.*)?$/;
// Groups: 1 double-quoted key · 2 single-quoted key · 3 plain key · 4 value text.
// A plain key may not open with `- ` (a list item) or `#` (a comment).
const YAML_KEY_RX =
  /^ *(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|((?!-(?:\s|$))[^\s"'#][^:#]*?))\s*:(?:\s+(.*))?$/;

function yamlLineIndent(text) {
  const m = /^( *)(\t?)/.exec(text);
  return { indent: m[1].length, tab: m[2] === "\t" };
}

function yamlTabError(lineIndex, label) {
  return new Error(
    `[manifest-source] line ${lineIndex + 1}: TAB in the indentation of ${label} — ` +
      `YAML forbids tabs there, and counting one as zero columns would silently end ` +
      `the enclosing block. Re-indent with spaces.`,
  );
}

// A key line's value text: unquoted, inline comment removed. `|` / `>` come back
// verbatim (a block scalar's content is not assembled).
function yamlScalarText(rest) {
  const t = String(rest ?? "").trim();
  const dq = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(t);
  if (dq) return dq[1];
  const sq = /^'([^']*)'\s*(?:#.*)?$/.exec(t);
  if (sq) return sq[1];
  if (t.startsWith("#")) return "";
  return t.replace(/\s+#.*$/, "");
}

// The key lines of lines[from, to) at the indent of that range's first content
// line — i.e. the direct children of whatever block the range is the body of.
function yamlKeysIn(lines, from, to, label) {
  const keys = [];
  let childIndent = null;
  for (let i = from; i < to; i++) {
    const text = lines[i];
    if (YAML_NON_CONTENT_RX.test(text)) continue;
    const { indent, tab } = yamlLineIndent(text);
    if (tab && (childIndent === null || indent <= childIndent)) {
      throw yamlTabError(i, label);
    }
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;
    const m = YAML_KEY_RX.exec(text);
    if (!m) continue;
    keys.push({ key: m[1] ?? m[2] ?? m[3], index: i, indent, rest: m[4] ?? "" });
  }
  return keys;
}

// Exclusive end of the block opened by the key at `keyIndex`: the first later
// content line indented no deeper than the key itself.
function yamlBlockEnd(lines, keyIndex, keyIndent, to, label) {
  let end = keyIndex + 1;
  for (; end < to; end++) {
    const text = lines[end];
    if (YAML_NON_CONTENT_RX.test(text)) continue;
    const { indent, tab } = yamlLineIndent(text);
    if (tab && indent <= keyIndent) throw yamlTabError(end, label);
    if (indent <= keyIndent) break;
  }
  return end;
}

/**
 * Resolve the block of the key at `keyPath`, walking one mapping level per
 * segment from the document root.
 *
 * @param {string} src      manifest SOURCE TEXT (not a path)
 * @param {string[]} keyPath e.g. ["cli_variants", "context/root.md", "gemini"]
 * @returns {null | {
 *   line: number,    // 1-based line of the final segment's key
 *   indent: number,  // that key's column
 *   value: string,   // its inline value text (see yamlScalarText); "" when none
 *   children: Array<{ key: string, line: number, value: string }>,
 *   body: Array<{ line: number, text: string }>, // every line inside the block
 * }}  null when any segment is absent at its level.
 * @throws on a key repeated at one level — a path segment, or a child of the
 *   resolved block — and on a TAB in structural indentation.
 */
export function readYamlBlock(src, keyPath) {
  if (!Array.isArray(keyPath) || keyPath.length === 0) {
    throw new TypeError("[manifest-source] readYamlBlock: keyPath must be a non-empty array");
  }
  const lines = String(src ?? "").split("\n");
  const labelOf = (n) => keyPath.slice(0, n).map((k) => JSON.stringify(k)).join(".");
  let from = 0;
  let to = lines.length;
  let hit = null;
  for (let depth = 0; depth < keyPath.length; depth++) {
    const label = labelOf(depth + 1);
    const matches = yamlKeysIn(lines, from, to, label).filter((k) => k.key === keyPath[depth]);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(
        `[manifest-source] ${label} is declared ${matches.length} times at one level ` +
          `(lines ${matches.map((k) => k.index + 1).join(", ")}) — YAML forbids a ` +
          `repeated mapping key, and any reader would have to pick one silently. ` +
          `Remove the duplicate.`,
      );
    }
    hit = matches[0];
    from = hit.index + 1;
    to = yamlBlockEnd(lines, hit.index, hit.indent, to, label);
  }
  const label = labelOf(keyPath.length);
  const children = [];
  const seen = new Map();
  for (const k of yamlKeysIn(lines, from, to, `the children of ${label}`)) {
    if (seen.has(k.key)) {
      throw new Error(
        `[manifest-source] ${label} declares child "${k.key}" twice (lines ` +
          `${seen.get(k.key)}, ${k.index + 1}) — YAML forbids a repeated mapping key, ` +
          `and any reader would have to pick one silently. Remove the duplicate.`,
      );
    }
    seen.set(k.key, k.index + 1);
    children.push({ key: k.key, line: k.index + 1, value: yamlScalarText(k.rest) });
  }
  const body = [];
  for (let i = from; i < to; i++) body.push({ line: i + 1, text: lines[i] });
  return {
    line: hit.index + 1,
    indent: hit.indent,
    value: yamlScalarText(hit.rest),
    children,
    body,
  };
}

/**
 * The inline value of the key at `keyPath`, or null when the key is absent.
 * Same resolution and same throws as `readYamlBlock`.
 */
export function readYamlScalar(src, keyPath) {
  const block = readYamlBlock(src, keyPath);
  return block === null ? null : block.value;
}

/** Effective destination election, carried without the owner's target registry.
 * Missing/old projections stay default-off; malformed present values fail loud.
 */
export function readNativeCodexSkillsElection(repoRoot = REPO) {
  const text = readCliEmitProjection(repoRoot);
  if (text === null) return false;
  const value = readYamlScalar(text, ["multi_cli_overlays", "multi-cli", "codex_native_skills"]);
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  throw new Error("CLI projection codex_native_skills must be true or false");
}
