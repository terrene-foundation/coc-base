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
 * root of trust for the distribution engine, and it is NOT currently on the
 * state-file deny floor (`reconcile-settings-deny.mjs::CANONICAL_STATE_DENY`) nor
 * matched by `validate-bash-command.js::STATE_PATH_RX`.
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
 *        · defaults at PARITY, EXCEPT block_cap_bytes since 2026-08-12 —
 *          tolerance (±30%), block threshold (+30%), floor 10 still equal what
 *          the manifest declares. `block_cap_bytes` no longer does: loom raised
 *          codex+gemini to 65536 (plan §3.2 option b, expires 2027-02-12) while
 *          the hardcoded fallback stays 61440. That divergence is in the SAFE
 *          direction — a manifest-less consumer keeps the STRICTER 61440 cap and
 *          can never inherit loom's raise — so it needs no tripwire, and the
 *          fallback is deliberately NOT tracked to the grant.
 *          The original hazard is unchanged and still has no tripwire: if loom
 *          ever tightens `block_cap_bytes` below the fallback, or raises
 *          `headroom_floor_pct` above 10, a manifest-less consumer silently
 *          keeps the LOOSER gate. Only the raise direction is safe.
 *        · NO GATE TO ASSERT — per-rule budgets. An empty Map is not a tighter
 *          default; it REMOVES a per-entry gate. Every rule takes emitBaseline's
 *          `else` branch (emit.mjs:1363-1367) and gets an advisory WARN, and
 *          since `budgetBlockViolations` is populated only inside the
 *          `budgets.has(rule)` branch (emit.mjs:1307) it never reaches the
 *          `overallPass = false` at emit.mjs:2937. It is correctly D2 on the
 *          V15 "no proposition" argument — a consumer has no per-rule budgets of
 *          its own, and its rules were already gated at loom on emission — NOT
 *          on a tighter-default argument.
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
