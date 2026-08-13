#!/usr/bin/env node
/*
 * ============================================================================
 *  Cross-Reference Integrity Validator — F22 (journal/0150)
 * ============================================================================
 *
 *  Mechanical detector for dangling cross-references in `.claude/` artifacts.
 *  Walks rules/, skills/, commands/, agents/; extracts xref tokens from
 *  backtick-inline and markdown-link forms; resolves each token against the
 *  filesystem; reports dangling refs.
 *
 *  Value-anchor (per value-prioritization.md MUST-1 source c — journal
 *  DECISION entries): journal/0144 § analyst FM3 + journal/0149 § Forest
 *  follow-ups name F22 as the mechanical primitive Rule 11 + F25 lean on.
 *
 *  Detection surface (Phase-1):
 *    1. Backtick inline: `rules/foo.md`, `.claude/rules/foo.md`,
 *       `skills/foo/bar.md`, `commands/foo.md`, `agents/foo.md`,
 *       `hooks/foo.js`, `bin/foo.mjs`, `audit-fixtures/foo/`,
 *       `journal/NNNN-...md`.
 *    2. Markdown link: [text](path/to/file.md) and [text](path/to/file.md#anchor).
 *
 *  EXCLUDED (Phase-1):
 *    - Bare prose paths (high false-positive rate).
 *    - Section-anchor heuristic (`§ <heading>`) — deferred to Phase-2 per
 *      cc-artifacts.md Rule 9 false-positive class.
 *    - Refs inside fenced code blocks (treated as example/illustration).
 *    - Template placeholders: `<id>`, `<file>`, `<NN>`, `<NNNN>`, etc.
 *    - `.claude/audit-fixtures/**` is NOT scanned as a SOURCE (FC, journal/0186):
 *      audit-fixture markdown is synthetic test INPUT for the validator battery;
 *      its cross-refs are intentional fakes (`rules/foo.md`, `skills/foo`,
 *      `path.md`) or illustrative. Scanning fixtures for xref integrity is a
 *      category error — they are test corpora, not real-artifact sources. The
 *      fixtures are still exercised by the test harness (which calls the
 *      exported functions directly) and by an explicit `--scope .claude/audit-fixtures`.
 *      Bounded residual (R1 security-reviewer MED-1): a fixture `README.md` MAY
 *      carry a REAL institutional cross-ref (e.g. `rules/<real>.md`) that the
 *      default scan no longer validates. Accepted as bounded — those targets are
 *      authoritatively validated where the target itself is scanned and where
 *      real rules reference it; the example-bearing fixture READMEs additionally
 *      carry intentional-fake refs in table-cell code spans (un-fenceable) that a
 *      README-only re-scan would re-flag. `--scope .claude/audit-fixtures` is the
 *      audit path for fixture-README cross-refs.
 *    - Cross-CLI dispatcher tokens `bin/coc` / `bin/coc-<phase>` (FC, journal/0186):
 *      the Codex CLI phase dispatcher emitted to `<USE>/bin/coc` (loom source is
 *      `.claude/codex-templates/bin/coc`), referenced by NAME in cross-CLI prose
 *      per cross-cli-artifact-hygiene.md. It is never a loom-root `bin/` file, so
 *      the `bin/` prefix match is a structural false-positive.
 *    - Sanctioned Phase-2-DEFERRED audit-fixture forward-pointers (finding #70,
 *      journal/0182): a rule's Detection-mechanism field may cite an
 *      `audit-fixtures/<slug>/` dir that is intentionally not-yet-created — the
 *      rule declares the detector Phase-2-DEFERRED (per trust-posture.md
 *      § Two-Phase Rollout) and states "audit fixtures land with the Phase-2
 *      detector at <path>". validate-emit.mjs's `audit-fixture-coverage` gate
 *      already treats such a fixture as GREEN (it demands a fixture dir ONLY for a
 *      `detect*` export that EXISTS in violation-patterns.js; a deferred detector
 *      has no export yet, so its dir is never required). This validator diverges
 *      unless it recognizes the same sanction — so a not-found finding whose slug
 *      is on the SANCTIONED_DEFERRED_FIXTURES positive allowlist AND whose citing
 *      line declares the deferral is reclassified from dangling to skipped (see
 *      the allowlist below). This is NOT a blanket suppression of `audit-fixtures/`:
 *      a deferred-shaped citation whose slug is NOT on the allowlist still fails
 *      loud, so a genuinely-missing fixture dir cannot hide.
 *
 *  Resolver (per cross-repo.md Rule 1 — local-only, no positional cross-repo):
 *    - Tokens starting with `.claude/`: resolve against `<repo-root>/.claude/`.
 *    - Tokens starting with `rules/`, `skills/`, `commands/`, `agents/`,
 *      `hooks/`, `bin/`, `audit-fixtures/`: try `<repo-root>/.claude/<token>`
 *      AND `<repo-root>/<token>` (loom-internal precedent).
 *    - Tokens starting with `journal/NNNN[-...]`: glob-match against
 *      `<repo-root>/journal/NNNN-*.md` (NNNN-prefix match).
 *    - Slash-less directory fallback: a token written without a trailing slash
 *      that names a real DIRECTORY resolves via a labelled SECOND pass, so
 *      `skills/45-genesis-bootstrap` is not a false CRITICAL. Bounded to
 *      EXTENSION-LESS tokens — a token written `ghost.md` names its own type, so
 *      a directory called `ghost.md` must not retire it.
 *
 *  Exit:
 *    0 = COMPLETE run, no dangling refs (findings sourced from EXCLUDED contexts,
 *        OR reclassified as sanctioned Phase-2-deferred audit fixtures, do not count)
 *    1 = COMPLETE run, ≥1 dangling ref
 *    2 = usage / argv error
 *    3 = INCOMPLETE — the scan or its report did NOT complete. The verdict is
 *        UNKNOWN: exit 3 means neither "no findings" nor "findings". A consumer
 *        MUST NOT read it as either. Causes: stdout could not be fully delivered
 *        (the reader closed the pipe — EPIPE), or ≥1 target file could not be
 *        read (the scan denominator is short). Every exit-3 path writes a named
 *        cause to stderr, so the failure is never silent.
 *
 *  WHAT EXIT 0 DOES NOT COVER (read this before citing a clean run). Exit 0 means
 *  "clean WITHIN A STATED BOUNDARY", not "cross-references are healthy". A reader
 *  who takes it for the latter is reading a verdict the run never measured. The
 *  boundary has four known edges, each a live gap rather than a hypothetical:
 *
 *    - FRAGMENTS ARE NEVER CHECKED. MD_LINK_RE captures the path in group 1 and
 *      swallows any `#fragment` NON-CAPTURING, so a link whose FILE resolves but
 *      whose ANCHOR does not is indistinguishable here from a correct one. The
 *      whole broken-anchor class is structurally invisible; no amount of exit 0
 *      speaks to it. Closing it needs a fragment-resolution pass (resolve the
 *      anchor against the target's headings), which is NOT implemented.
 *    - TREES OUTSIDE DEFAULT_SCOPE_DIRS ARE NEVER READ, and `.claude/guides` is
 *      the consequential one: it holds the rule-depth extracts that carry each
 *      rule's BLOCKED corpus. `self-referential-codify.md` puts
 *      `.claude/guides/rule-extracts/**` on its allowlist precisely because an
 *      edit there changes a rule's enforcement surface exactly as an edit to the
 *      rule body does — so a clean run is currently silent on the
 *      ENFORCEMENT-BEARING half of the corpus while reporting exit 0 over the
 *      other half. Widening the default scope is the intended fix and is
 *      SEQUENCED, not skipped: it must land after the dangling refs already
 *      inside that tree are repaired, or it converts a known-clean gate into a
 *      red one for reasons unrelated to the change under test.
 *    - SLUG TAILS AND RANGE ENDPOINTS are matched loosely; a citation may resolve
 *      on its prefix while its tail names something that does not exist.
 *    - THE UNBACKTICKED JOURNAL SHAPE is out of scope BY DECISION (see
 *      BACKTICK_JOURNAL_RE). Unlike the three above, this one is not a defect:
 *      the class is correct-by-design provenance and the decision records why
 *      widening is refused.
 *
 *  WHY exit 3 EXISTS (the defect it repairs). Before it, a run whose report was
 *  truncated exited 1 with ZERO stderr — byte-identical, to any consumer reading
 *  only the exit code, to "validation ran and found problems". The mechanism was
 *  `process.exit()`: on POSIX, `process.stdout` to a PIPE is ASYNCHRONOUS, and
 *  `process.exit()` DISCARDS the queued write. Measured on this repo before the
 *  fix: `--scope .claude --json` delivered 121,799 bytes to a FILE (valid JSON)
 *  and exactly 65,536 bytes — the pipe-buffer boundary — through a PIPE (INVALID
 *  JSON), both under exit 1 with zero stderr. That is a validator reporting a
 *  verdict over a report the consumer never received. The repair is two-part:
 *  set `process.exitCode` and let node FLUSH (so the normal path stops
 *  truncating at all), and route a write that genuinely CANNOT complete to
 *  exit 3 with a diagnostic (so the abnormal path stops impersonating exit 1).
 *
 *  Usage:
 *    node .claude/bin/validate-xref-integrity.mjs [--json] [--scope <dir>] [--help]
 *
 *  --json     emit JSON report to stdout (machine-readable)
 *  --scope    limit scan to a subdirectory (default: .claude/ + selected
 *             root-level files)
 *  --help     usage text + exit 0
 *
 *  THIS SCRIPT IS A SYNCED ARTIFACT (`bin/**` per sync-manifest.yaml). Zero
 *  client/org tokens; detection is purely structural (a STRUCTURAL probe per
 *  probe-driven-verification.md MUST-3).
 * ============================================================================
 */

import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// --- Repo root resolution -----------------------------------------------

function findRepoRoot(startDir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || startDir;
  } catch {
    // security-reviewer LOW — silent cwd-outside-repo footgun. Warn so the
    // operator notices that scan scope will not be repo-anchored.
    process.stderr.write(
      `validate-xref-integrity: warning: git rev-parse failed for cwd=${startDir}; scanning relative to cwd\n`,
    );
    return startDir;
  }
}

// --- Token surface ------------------------------------------------------

// Backtick-inline xref. Captures the path token. Must start with one of the
// known prefixes; must end at backtick. Excludes refs containing `<` (template
// placeholders) or whitespace.
//
// Prefixes covered: .claude/, rules/, skills/, commands/, agents/, hooks/,
// bin/, audit-fixtures/, journal/. The optional `.claude/` prefix is handled
// by allowing either form.
const BACKTICK_RE =
  /`((?:\.claude\/)?(?:rules|skills|commands|agents|hooks|bin|audit-fixtures)\/[A-Za-z0-9_./~+\-]+)`/g;

// Backtick-inline journal ref.
//
// DELIBERATE SCOPE — backticked-only, and this is a DECISION, not an oversight.
// The pattern requires a BACKTICKED `journal/NNNN`, so it sees 105 of 604 journal
// references repo-wide (~17%). The blindness splits into ~190 in-scope-but-
// unbackticked (186 plain prose + 4 path-qualified) and 309 out-of-scope.
//
// Widening is REFUSED on both halves, for different reasons:
//   - The 309 out-of-scope are dominated by 229 EMITTED MIRRORS (.coc/rules,
//     .coc/{skills,commands,agents}, .codex/{skills,prompts}, .gemini/skills).
//     Scanning them would double-count DERIVED copies of refs already counted at
//     their source and would flag generated output, which no author can fix in
//     place. (The derived-vs-source call rests on `.coc/` carrying a different
//     frontmatter schema while mirroring `.claude/` filenames 1:1; it is an
//     INFERENCE, labelled as one. If `.coc/` were hand-authored neutral source
//     this would change the SIZE of the guides recommendation below, not its
//     direction.)
//   - The unbackticked in-scope shape is a formatting variant of a class that is
//     correct-by-design: all 604 are provenance citations, the corpus holds
//     roughly ONE genuine defect among them, and `journal-entry-not-found` still
//     fires wherever a root `journal/` exists. So this class is NOT where exit 0
//     overstates corpus health — see the exit-0 scope note in the header, which
//     names the three places it actually does.
//
// The 105 SURVIVED an independent refutation round: a separately-written
// instrument (backtick-span membership via a tick-toggle model rather than a
// negative lookbehind, with its own fence stripper) reproduced them as a
// MULTISET-IDENTICAL set — same file:line:NNNN triples — which is agreement on
// MEMBERS, not merely on totals. A predicted `[text](journal/...)` md-link
// sub-shape was REFUTED at zero occurrences repo-wide, so within scope
// "unbackticked" really does mean invisible rather than caught by MD_LINK_RE.
// A residual 3 between the two instruments is UNRECONCILED and recorded as such.
const BACKTICK_JOURNAL_RE = /`(journal\/(?:\.pending\/)?\d{3,4}[A-Za-z0-9_.\-/]*)`/g;

// Markdown link: [text](relative/path.md) or [text](relative/path.md#anchor)
// Skip http(s) URLs, mailto:, fragment-only (#X) and absolute-system paths.
const MD_LINK_RE =
  /\[(?:[^\]]*)\]\(([A-Za-z0-9_./~+\-]+?\.(?:md|mjs|js|json|ya?ml))(?:#[^)]*)?\)/g;

// Section heading detector for resolving section anchors inside markdown
// files (deferred to Phase-2; not used in Phase-1 default mode).

// Template-placeholder detection (skip these as not real refs). Covers:
//   <id>, <NN>, <NNNN>          (angle-bracket form)
//   {topic}, ${VAR}             (curly-brace form)
//   %(var)s                     (printf-named form)
function isPlaceholder(token) {
  if (/[<>{}]/.test(token)) return true;
  if (/%\([A-Za-z_][A-Za-z0-9_]*\)/.test(token)) return true;
  return false;
}

// A token carries a FILE EXTENSION when its last path segment has a dot at any
// position past the first — `rules/foo.md`, `bin/x.mjs`, `a/b/v1.2`. A leading
// dot is NOT an extension (`journal/.pending`, `.claude`), and a segment with no
// dot at all (`skills/45-genesis-bootstrap`, `hooks/lib`) is extension-less.
//
// Used to bound the slash-less directory fallback below: only an EXTENSION-LESS
// token may be satisfied by a same-named directory. See the second pass for why.
function hasFileExtension(token) {
  const segments = token.split("/").filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  return last.lastIndexOf(".") > 0;
}

// Cross-CLI dispatcher tokens are not loom files (see docstring EXCLUDED note).
// `bin/coc` and `bin/coc-<phase>` name the Codex CLI dispatcher emitted to
// `<USE>/bin/coc`; the loom source is `.claude/codex-templates/bin/coc`.
const CROSS_CLI_DISPATCHER_RE = /^bin\/coc(-[a-z0-9-]+)?$/;
function isCrossCliDispatcher(token) {
  return CROSS_CLI_DISPATCHER_RE.test(token);
}

// --- Sanctioned Phase-2-deferred audit-fixture carve-out (finding #70) --
//
// A POSITIVE ALLOWLIST (cc-artifacts.md Rule 10 discipline; the same shape as
// validate-emit.mjs's LOOM_ONLY_TIER_CARVEOUTS) of `audit-fixtures/<slug>/`
// forward-pointers a rule's Detection-mechanism field cites for a Phase-2-
// DEFERRED detector whose fixture dir does not exist yet. These are SANCTIONED
// not-yet-real references, NOT dangling defects — validate-emit.mjs's
// authoritative `audit-fixture-coverage` gate already treats them as GREEN (it
// requires a fixture dir only for a `detect*` export that EXISTS in
// violation-patterns.js; a deferred detector has no export, so its dir is never
// demanded). This validator matches that sanction ONLY for the enumerated slugs.
//
// Each entry cites the rule whose "Phase 2 (deferred …) — audit fixtures land
// with the Phase-2 detector at `.claude/audit-fixtures/<slug>/`" clause sanctions
// it. Slugs are stored WITHOUT the optional `.claude/` prefix and WITHOUT the
// trailing slash — the normalized form isSanctionedDeferredFixture compares.
//
// NOT on this list (still flagged loud, deliberately): `proposal-intake-trust`,
// `symbol-anchored-citations`, and any future deferred-shaped citation whose
// slug is not enumerated here — a genuinely-missing fixture dir cannot hide
// behind a blanket `audit-fixtures/` suppression.
const SANCTIONED_DEFERRED_FIXTURES = new Set([
  // artifact-flow.md § "Exact Gate-1 / Gate-2 Tracking" Detection mechanism
  // (also cited by sync-completeness.md's distribution-side companion).
  "audit-fixtures/exact-gate-tracking",
  // git.md § CI-check/merge-separation Detection mechanism.
  "audit-fixtures/ci-check-merge-separation",
  // knowledge-cascade-routing.md Detection mechanism.
  "audit-fixtures/knowledge-cascade-routing",
  // recommendation-quality.md MUST-7 (below-confidence escalation) Detection mechanism.
  "audit-fixtures/recommendation-quality/below-confidence-escalation",
  // recommendation-quality.md MUST-8 (sensitivity/classification escalation) Detection mechanism.
  "audit-fixtures/recommendation-quality/sensitivity-escalation",
  // security.md § Enforcement-Surface Parity Detection mechanism.
  "audit-fixtures/enforcement-surface-parity",

  // ---------------------------------------------------------------------
  // 2026-08-10 — the 25 slugs below were each adjudicated INDIVIDUALLY, not
  // bulk-declared. Bulk-declaring `audit-fixtures/` would destroy the signal
  // this allowlist exists to preserve; the point of enumerating is that a slug
  // NOT listed here still fails loud.
  //
  // Evidence per slug (all four had to hold):
  //   1. the citing line is a rule's `**Detection mechanism:**` Wiring field
  //      that DECLARES the detector Phase-2-deferred (the secondary guard below
  //      re-checks this at runtime, so a mislabelled entry cannot silently pass);
  //   2. no fixture dir of that name exists at ANY depth under audit-fixtures/;
  //   3. no near-miss exists — minimum Levenshtein distance to any real fixture
  //      dir was 10 (control: `instrument-discipline` matched itself at 0), so
  //      none is a typo for an existing dir;
  //   4. none was ever DELETED in git history (control: the same query returns
  //      48 hits for `forest-ledger`), so none is a stale path to a moved dir.
  //
  // Corroborated from an INDEPENDENT code path: `.claude/bin/detection-binding-check.mjs`
  // — the authoritative `coc-artifact-eval-coverage.md` MUST-4 arbiter — classifies
  // these as `deferred-fixtures-absent` (reported, NOT fatal) while its CRITICAL
  // `dangling-fixtures-binding` check, which reds when a LIVE detector's fixture
  // dir is missing, is green. A slug moving from deferred to live therefore reds
  // THERE even if it lingers here; a stale entry here is inert, because once the
  // dir is created resolveRefToken resolves it and never reaches this carve-out.
  // ---------------------------------------------------------------------

  // agents.md § Triad + wave-loop.md MUST-6/7 (shared slug, cited by both).
  "audit-fixtures/wave-loop/orchestration-hygiene",
  // agents.md § "Correctness-Review-Clean Is Not Security-Clean" Detection mechanism.
  "audit-fixtures/correctness-not-security-clean",
  // artifact-flow.md § Canon-Neutrality Detection mechanism.
  "audit-fixtures/canon-neutrality",
  // command-skill-parity.md Detection mechanism.
  "audit-fixtures/command-skill-parity",
  // conformance-walk.md Detection mechanism.
  "audit-fixtures/conformance-walk",
  // deploy-hygiene.md § positive-COPY Detection mechanism.
  "audit-fixtures/deploy-hygiene-positive-copy",
  // handoff-completion.md Detection mechanism.
  "audit-fixtures/handoff-completion",
  // hook-output-discipline.md MUST-5(a) Detection mechanism. NOTE: this clause
  // declares its deferral in prose ("its ONE genuine Phase 2 deferral" +
  // "Audit fixtures land WITH that check at …") and never in the literal
  // `Phase 2 (deferred` form — which is why the secondary guard below also
  // accepts the cc-artifacts.md Rule 9 "fixtures land with" phrasing.
  "audit-fixtures/parsed-signal-detector",
  // issue-triage-routing.md Detection mechanism.
  "audit-fixtures/issue-triage-routing",
  // multi-operator-coordination.md § Coordination-Disposition-Verification Detection mechanism.
  "audit-fixtures/coordination-disposition-verification",
  // orchestration-launch-ledger.md Detection mechanism.
  "audit-fixtures/orchestration-launch-ledger",
  // orphan-detection.md § default-change sweep Detection mechanism.
  "audit-fixtures/orphan-default-change-sweep",
  // product-completion-first.md Detection mechanism.
  "audit-fixtures/product-completion-first",
  // proposal-intake-trust.md Detection mechanism.
  "audit-fixtures/proposal-intake-trust",
  // schema-migration.md § ADD COLUMN paired-artifacts Detection mechanism.
  "audit-fixtures/schema-add-column-paired-artifacts",
  // security.md § Path Containment Detection mechanism.
  "audit-fixtures/path-containment",
  // security.md § Secure-Default For A New Security Feature Detection mechanism.
  "audit-fixtures/secure-default-new-feature",
  // security.md § Approver/Decider-Identity Detection mechanism.
  "audit-fixtures/approver-identity-server-derived",
  // spec-accuracy.md § kp:// carve-out Detection mechanism.
  "audit-fixtures/spec-accuracy-kp-carveout",
  // specs-authority.md Rule 10 (knowledge-product field-type) Detection mechanism.
  "audit-fixtures/knowledge-product-field-type",
  // specs-authority.md Rule 11 (derives_from[] provenance) Detection mechanism.
  "audit-fixtures/derives-from-provenance",
  // stack-detection.md Detection mechanism.
  "audit-fixtures/stack-detection",
  // symbol-anchored-citations.md Detection mechanism.
  "audit-fixtures/symbol-anchored-citations",
  // sync-completeness.md § multi-CLI re-emit Detection mechanism.
  "audit-fixtures/sync-completeness-multi-cli-reemit",
  // tenant-isolation.md § upsert-guard Detection mechanism.
  "audit-fixtures/tenant-upsert-guard",

  // ---------------------------------------------------------------------
  // RECONCILED FROM TWO IN-FLIGHT LANES (2026-08-10). Three lanes had a claim
  // on this count at once; the slugs are absorbed HERE, in the file that owns
  // them, so the ingest lanes carry no allowlist hunk and cannot conflict.
  //
  // Both are PRE-DECLARED: the rules citing them are not on main yet. That is
  // safe in both directions and needs no follow-up. If a lane never lands, its
  // entry is INERT — the carve-out only ever fires on a citation that exists.
  // If a lane lands with a DIFFERENT path than the one declared here, the
  // mismatch surfaces as dangling rather than being absorbed, which is the
  // behaviour we want from a pre-declaration: it can be wrong loudly, never
  // quietly. And once a fixture dir is actually created, resolveRefToken
  // resolves it directly and never reaches this set at all.
  // ---------------------------------------------------------------------

  // orchestration-launch-ledger.md MUST-4/5 (rescue-checkpoint clause), cited at
  // its Detection mechanism. In flight on feat/gate1-ingest-build-2026-08-10;
  // that lane's own allowlist hunk is superseded by this entry. Its sibling
  // `audit-fixtures/orchestration-launch-ledger` is already declared above — the
  // same pre-existing row this pass adjudicated independently, which is why the
  // two lanes' counts disagreed (26 vs 25) rather than either being wrong.
  "audit-fixtures/orchestration-launch-ledger/rescue-checkpoint",
  // script-tool-manifest-sanity.md Detection mechanism. In flight on
  // feat/gate1-ingest-build-prism-2026-08-10 — the row that took the count to 27.
  // NOTE: that citation is hard-wrapped across three lines, with `Phase 2
  // (deferred per` on the first and the token on the third, so the LINE-scoped
  // guard would have rejected it even WITH this entry present. The block-scoped
  // guard above is what makes it declarable at all.
  "audit-fixtures/script-tool-manifest-sanity",
  // worktree-isolation.md Rule 9 (stash-collision) Detection mechanism. PRE-EXISTING on
  // main at 117eaa96 — measured: that base exits 1 with this single dangling ref, so it
  // is not this branch's regression. Fixed here under zero-tolerance.md Rule 1 (found it,
  // own it) because it reds a shared gate for every lane. Legitimately allowlistable: the
  // clause declares its Phase-2 detector deferred AND the deferral is registered in
  // phase2-deferrals.json with a dated expiry (2027-02-15), which is the same bar every
  // row above met. If the owning lane ships the same slug, drop whichever lands second.
  "audit-fixtures/worktree-stash-collision",

  // ---------------------------------------------------------------------
  // 2026-08-12 — unpark of the parked baseline queue. Adjudicated
  // INDIVIDUALLY against the same bar as the rows above: the citing clause
  // declares its Phase-2 detector DEFERRED, and the fixture dir is the
  // forward-pointer that lands WITH that detector. Both are ALSO declared in
  // .claude/test-harness/phase2-deferrals.json::deferrals with a dated
  // `expires`, so an indefinite deferral reds there rather than hiding here.
  //
  // evidence-first-claims.md MUST-5 + MUST-6 Detection mechanism.
  "audit-fixtures/evidence-first-claims/instrument-capability-and-scope",
]);

// --- Sanctioned absent-by-design / external references -------------------
//
// A POSITIVE, SOURCE-SCOPED ALLOWLIST (same discipline as
// SANCTIONED_DEFERRED_FIXTURES above) of tokens naming something REAL that is
// deliberately absent from canon loom's tree: a CONSUMER-owned path, a
// canon-absent-by-design companion, a generic illustration, or a file in
// ANOTHER repository. Nothing at loom can satisfy these — by design — so they
// are not dangling defects and must not drive the exit code.
//
// Each entry is SOURCE-SCOPED: the carve-out applies ONLY in the file(s) whose
// surrounding prose establishes the token as by-design-absent. A NEW citer of
// the same token still flags loud. That is what keeps this from decaying into
// a blanket suppression of the token itself — the same constraint
// SANCTIONED_DEFERRED_FIXTURES states in its own "NOT on this list" note.
const SANCTIONED_ABSENT_REFS = new Map([
  [
    ".claude/agents/project/",
    {
      why: "CONSUMER-owned path. The citing line names it as project-specific artifacts a sync MUST NEVER overwrite; it exists on a consumer, never in canon.",
      sources: new Set([
        ".claude/commands/sync-from-template.md",
        // Same by-design absence, second citer: the guide's own sentence says
        // loom has "No `project/` subdirectory — loom/ is the authority, not a
        // project", i.e. it names the path in order to state that canon lacks it.
        ".claude/guides/co-setup/03-creating-components.md",
      ]),
    },
  ],
  [
    "bin/loom-links.local.json",
    {
      why: "OPERATOR-LOCAL and gitignored by design. The citing table marks it '**gitignored**' on the same row and names the committed synthetic schema `bin/loom-links.local.example.json` beside it; a resolvable copy in canon would BE the leak the gitignore prevents.",
      sources: new Set([".claude/guides/co-setup/10-user-defined-repo-linkages.md"]),
    },
  ],
  [
    "bin/repin-targets.local.json",
    {
      why: "OPERATOR-LOCAL and gitignored by design, same shape as loom-links: the citing line describes it as the LEGACY per-operator registry that `repin-downstream.mjs` still falls back to, with `bin/repin-targets.local.example.json` as the committed schema.",
      sources: new Set([".claude/guides/co-setup/10-user-defined-repo-linkages.md"]),
    },
  ],
  [
    "pattern-1.md",
    {
      why: "TEMPLATE PLACEHOLDER. The citing block is a fill-in skeleton whose sibling lines are literal placeholders ('[Your most common patterns]', '[Use case 1]'); the reader replaces it, so nothing in canon can or should satisfy it.",
      sources: new Set([".claude/guides/claude-code/11-advanced-usage.md"]),
    },
  ],
  [
    "../skills/99-my-custom-skill/SKILL.md",
    {
      why: "TEMPLATE PLACEHOLDER naming a skill the READER creates. The `99-` prefix is deliberately outside canon's numbered range and the surrounding block is a fill-in skeleton ('[Step 2]', '[Verification]').",
      sources: new Set([".claude/guides/claude-code/11-advanced-usage.md"]),
    },
  ],
  // Siblings of agents/project/ above, cited by the SAME consumer-owned-paths
  // sentence in the same file, and absent from canon for the identical reason.
  // Note the set is deliberately incomplete relative to that sentence:
  // `.claude/skills/project/` EXISTS at loom, so it resolves and needs no
  // carve-out. Only the three genuinely-absent siblings are listed, and each
  // stays SOURCE-SCOPED — a new citer elsewhere still flags loud.
  [
    ".claude/rules/project/",
    {
      why: "CONSUMER-owned path. Same sync-from-template consumer-owned-paths sentence as agents/project/; a PRESERVED overlay dir that exists on a consumer, never in canon.",
      sources: new Set([".claude/commands/sync-from-template.md"]),
    },
  ],
  [
    ".claude/commands/project/",
    {
      why: "CONSUMER-owned path. Same sync-from-template consumer-owned-paths sentence as agents/project/; a PRESERVED overlay dir that exists on a consumer, never in canon.",
      sources: new Set([".claude/commands/sync-from-template.md"]),
    },
  ],
  [
    ".claude/rules/local/local-manifest.yaml",
    {
      // SCOPE — this entry is LOAD-BEARING AT CANON and INERT AT A CONSUMER, and
      // the difference is the whole reason it is not simply deleted. `rules/local/**`
      // is positively excluded from distribution in sync-manifest.yaml ("Never
      // distributed to a target"), so at a consumer neither the sanctioned target
      // NOR its only `sources` citer ever ships and the entry can never match.
      // At canon both exist: `_README.md` cites the token and the target genuinely
      // does not exist, so removing this row makes canon's own run FAIL. Measured
      // both poles: deleting it → exit 1 with `.claude/rules/local/_README.md:48
      // [backtick] .claude/rules/local/local-manifest.yaml → not-found`; restoring
      // it → exit 0. "Unreachable at a consumer" is therefore NOT "dead code".
      why: "Canon-absent BY DESIGN. rules/local/_README.md states canon 'carries only this doc + the schema example'; the deployment copies local-manifest.example.yaml to this path in a FORK. Reachable only at canon — `rules/local/**` is never distributed, so this row is inert (not wrong) at every consumer.",
      sources: new Set([".claude/rules/local/_README.md"]),
    },
  ],
  [
    "bin/dev",
    {
      why: "Generic ILLUSTRATION of a dev-container entrypoint in prose enumerating what such a stack contains ('dev-container, `bin/dev`, compose dev stack'), not a loom file.",
      sources: new Set([
        ".claude/skills/10-deployment-git/docker-dev-env-patterns.md",
        ".claude/agents/management/coc-sync.md",
      ]),
    },
  ],
  [
    "skills/claude-api/shared/prompt-caching.md",
    {
      why: "EXTERNAL repository. The citing line qualifies it explicitly as 'github.com/anthropics/skills § skills/claude-api/shared/prompt-caching.md'.",
      sources: new Set([
        ".claude/skills/30-claude-code-patterns/prompt-caching-coc-artifacts.md",
      ]),
    },
  ],
]);

// A not-found finding is SANCTIONED-ABSENT (skip, not dangling) iff its token
// is on the allowlist AND the citing file is one of that entry's declared
// sources.
function isSanctionedAbsentRef(finding) {
  const entry = SANCTIONED_ABSENT_REFS.get(finding.token);
  if (!entry) return false;
  return entry.sources.has(finding.source);
}

// The citation declares Phase-2 deferral when its enclosing Wiring bullet carries
// a deferral marker AND names an audit fixture. This guard is secondary — the
// allowlist above is the binding constraint — but it ties the skip to genuine
// sanctioning text and self-heals: once the fixture dir is created resolveRefToken
// resolves it directly (never reaching this reclassification).
//
// TWO accepted declaration forms, because ONE was not enough and the gap was a
// silent FALSE NEGATIVE — a legitimately-sanctioned reference reported as a
// dangling defect, which corrupts the signal in exactly the direction that makes
// a real defect harder to see:
//   (a) the canonical `Phase 2 (deferred …)` marker;
//   (b) the `cc-artifacts.md` Rule 9 phrasing "audit fixtures land WITH <the
//       detector>". Form (b) is not a loosening: it asserts the fixtures are NOT
//       present yet and will land with the detector — the deferral, stated.
//       hook-output-discipline.md MUST-5(a) declares its deferral ONLY this way
//       ("its ONE genuine Phase 2 deferral" + "Audit fixtures land WITH that
//       check at …"), and its line additionally contains the string
//       "Phase 2 is NOT deferred" for the sibling half — so a regex widened to
//       chase `Phase 2` + `deferr` would have matched the DISCLAIMER. Form (b)
//       is the narrow, meaning-bearing alternative.
const PHASE2_DEFERRED_RE = /Phase[\s-]?2\s*\(deferred/i;
const FIXTURES_LAND_WITH_RE = /audit[\s-]?fixtures?\s+land\s+with\b/i;
const AUDIT_FIXTURE_RE = /audit[\s-]?fixtures?/i;

// A Wiring bullet is routinely HARD-WRAPPED across several physical lines, so a
// LINE-scoped guard reads the continuation line carrying the token and never sees
// the declaration two lines above it. That was a real false negative, not a
// hypothetical: wave-loop.md's MUST-6/7 Detection bullet declares
// "Phase 2 (deferred per …)" on one line and cites the fixture path on the next,
// and the reference was reported dangling for that reason alone — while the
// IDENTICAL slug cited on a single unwrapped line in agents.md was skipped
// correctly. Scoping to the enclosing bullet makes the guard depend on what the
// prose SAYS rather than on where the author's editor happened to wrap.
//
// A line STARTS a block when it opens a list item, opens a heading, or follows a
// blank line. The block runs to the line before the next block-start or blank
// line. Continuation lines therefore attach to their own bullet and to no other,
// so the guard cannot borrow a neighbouring bullet's declaration.
const BLOCK_START_RE = /^\s*(?:[-*+]|\d+[.)])\s|^\s*#{1,6}\s/;

function computeBlockTexts(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const isBlank = lines[i].trim() === "";
    const prevBlank = i === 0 || lines[i - 1].trim() === "";
    if (!isBlank && (prevBlank || BLOCK_START_RE.test(lines[i]))) starts.push(i);
  }
  // For each line, the text of the block it belongs to.
  const blockOf = new Array(lines.length).fill("");
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    let to = s + 1 < starts.length ? starts[s + 1] - 1 : lines.length - 1;
    for (let k = from; k <= to; k++) {
      if (lines[k].trim() === "") {
        to = k - 1;
        break;
      }
    }
    const text = lines.slice(from, to + 1).join("\n");
    for (let k = from; k <= to; k++) blockOf[k] = text;
  }
  return blockOf;
}

// Normalize a backtick token to the `audit-fixtures/<slug>` form the allowlist
// stores: strip an optional leading `.claude/` and any trailing slash.
function normalizeFixtureSlug(token) {
  return token.replace(/^\.claude\//, "").replace(/\/+$/, "");
}

// A not-found finding is a SANCTIONED deferred audit-fixture (skip, not dangling)
// iff its normalized slug is on the positive allowlist AND its enclosing Wiring
// bullet declares Phase-2 deferral of an audit fixture.
//
// `blockText` is preferred and `lineText` is the fallback, so a caller that
// supplies only a line (the pre-existing shape, and what the fixture harness
// constructs by hand) keeps working unchanged.
function isSanctionedDeferredFixture(finding) {
  if (finding.kind !== "backtick") return false;
  if (!SANCTIONED_DEFERRED_FIXTURES.has(normalizeFixtureSlug(finding.token))) return false;
  const text = finding.blockText || finding.lineText || "";
  if (!AUDIT_FIXTURE_RE.test(text)) return false;
  return PHASE2_DEFERRED_RE.test(text) || FIXTURES_LAND_WITH_RE.test(text);
}

// --- Walker -------------------------------------------------------------

// NOTE: `.claude/audit-fixtures` is intentionally NOT a default SOURCE scope
// (FC, journal/0186) — fixture markdown is synthetic test input; see the
// EXCLUDED note in the header. It remains scannable via `--scope .claude/audit-fixtures`.
const DEFAULT_SCOPE_DIRS = [
  ".claude/commands",
  ".claude/rules",
  ".claude/skills",
  ".claude/agents",
];
const DEFAULT_SCOPE_ROOT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "STACK.md"];

// Explicit ignored-dir set (reviewer MEDIUM-2). The dot-prefix heuristic
// also still skips nested fixture dirs that simulate `.claude/` layouts
// inside audit-fixtures/ (these are intentional test artifacts, not
// real cross-reference sources).
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "worktrees",
]);

function walkDir(dir, repoRoot) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      // Skip dot-prefixed dirs (e.g. nested `.claude/` test fixtures under
      // audit-fixtures/, `.proposals/`, transient hidden state).
      if (e.name.startsWith(".")) continue;
      out.push(...walkDir(full, repoRoot));
    } else if (e.isFile() && /\.md$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

// --- Fence-block skip ---------------------------------------------------

// Returns the input text with fenced code blocks replaced by blank lines of
// the same length. Backticks INSIDE fenced blocks are example-only and MUST
// not be scanned (Phase-1 disposition).
// RUN LENGTH is load-bearing, not just the fence CHARACTER. Per CommonMark a
// fenced block closes only on a run of the SAME character that is AT LEAST as
// long as the opener, which is exactly what lets a 4-backtick fence quote a
// 3-backtick one. Comparing only `run[0]` made the first inner ``` close the
// outer ```` block, so content after it was scanned as prose while the reader
// sees it as fenced. That is a parity FLIP rather than uniform leakage — it
// produces false POSITIVES (illustrative tokens inside a nested fence get
// resolved) and false NEGATIVES (real prose after an unclosed run is blanked)
// in the same file. Fixture: audit-fixtures/validate-xref-integrity/run.mjs
// `fixture-04b-fence-run-length`.
function stripFencedBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceMarker = null;
  let fenceLen = 0;
  for (const l of lines) {
    const fm = l.match(/^\s*(```+|~~~+)/);
    if (fm) {
      const run = fm[1];
      const kind = run[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = kind;
        fenceLen = run.length;
        out.push("");
        continue;
      }
      if (kind === fenceMarker && run.length >= fenceLen) {
        inFence = false;
        fenceMarker = null;
        fenceLen = 0;
        out.push("");
        continue;
      }
      out.push("");
      continue;
    }
    out.push(inFence ? "" : l);
  }
  return out.join("\n");
}

// --- Extractor ----------------------------------------------------------

function extractTokens(text, sourcePath) {
  const stripped = stripFencedBlocks(text);
  const findings = [];
  const lines = stripped.split(/\r?\n/);
  // Fence-stripping replaces fenced lines with empty ones rather than removing
  // them, so indices here still align with the source file's line numbers.
  const blockOf = computeBlockTexts(lines);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    // Backtick non-journal
    for (const m of line.matchAll(BACKTICK_RE)) {
      const token = m[1];
      if (isPlaceholder(token)) continue;
      if (isCrossCliDispatcher(token)) continue;
      // lineText + blockText are retained for the sanctioned-deferred-fixture
      // carve-out (finding #70) — the Detection-mechanism prose that declares
      // Phase-2 deferral, which is routinely hard-wrapped across the bullet.
      // Harmless for every other backtick finding.
      findings.push({
        token,
        kind: "backtick",
        line: lineNo,
        source: sourcePath,
        lineText: line,
        blockText: blockOf[i],
      });
    }
    // Backtick journal
    for (const m of line.matchAll(BACKTICK_JOURNAL_RE)) {
      const token = m[1];
      if (isPlaceholder(token)) continue;
      findings.push({ token, kind: "journal", line: lineNo, source: sourcePath });
    }
    // Markdown link
    for (const m of line.matchAll(MD_LINK_RE)) {
      const token = m[1];
      if (isPlaceholder(token)) continue;
      if (/^(https?:|mailto:|#)/i.test(token)) continue;
      findings.push({ token, kind: "md-link", line: lineNo, source: sourcePath });
    }
  }
  return findings;
}

// --- Resolver -----------------------------------------------------------

function resolveJournalToken(token, repoRoot) {
  // token = "journal/NNNN..." or "journal/.pending/NNNN..."
  const m = token.match(/^journal\/(\.pending\/)?(\d{3,4})/);
  if (!m) return { ok: false, reason: "malformed-journal-token" };
  const subdir = m[1] ? ".pending" : "";
  const nnnn = m[2];
  const dir = subdir ? join(repoRoot, "journal", subdir) : join(repoRoot, "journal");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { ok: false, reason: "journal-dir-missing" };
  }
  // Match any file starting with `NNNN-` or exact `NNNN.md`.
  const hit = entries.find(
    (n) => n === `${nnnn}.md` || n.startsWith(`${nnnn}-`),
  );
  return hit
    ? { ok: true, resolvedPath: join(dir, hit) }
    : { ok: false, reason: "journal-entry-not-found" };
}

// Path-traversal guard: confine resolved candidates to <repoRoot>/... so a
// malicious md-link token cannot make the validator stat arbitrary
// filesystem paths (security-reviewer MEDIUM-1).
function isInsideRepoRoot(absPath, repoRoot) {
  const normRoot = resolve(repoRoot);
  const normPath = resolve(absPath);
  return normPath === normRoot || normPath.startsWith(normRoot + sep);
}

function resolveRefToken(token, repoRoot, sourcePath, kind) {
  // Candidate paths to try, in order.
  const candidates = [];

  // For md-link kind, try source-relative first (markdown link semantics).
  // This handles `../../skill-x/file.md` and bare `sibling.md` patterns
  // common in skill cross-references.
  if (kind === "md-link") {
    const sourceDir = sourcePath
      ? dirname(join(repoRoot, sourcePath))
      : repoRoot;
    candidates.push(resolve(sourceDir, token));
  }

  if (token.startsWith(".claude/")) {
    candidates.push(join(repoRoot, token));
  } else if (token.startsWith("./") || token.startsWith("../")) {
    // Relative path — source-relative already tried above for md-link;
    // also try repo-root-relative as a fallback for backtick refs.
    candidates.push(resolve(repoRoot, token));
  } else {
    // Bare form (rules/foo.md, skills/foo/bar.md, etc.) — try `.claude/<token>`
    // first (the canonical loom-side path), then `<repo-root>/<token>` (loom-
    // internal precedent).
    candidates.push(join(repoRoot, ".claude", token));
    candidates.push(join(repoRoot, token));
  }

  // Clamp every candidate to repoRoot before stat — defense-in-depth
  // against path-traversal via `../../etc/passwd`-style tokens. Candidates
  // outside the repo are silently dropped (treated as not-found).
  const safeCandidates = candidates.filter((c) => isInsideRepoRoot(c, repoRoot));

  // For dir tokens (ending in `/`), check directory; otherwise check file.
  // Use lstatSync to avoid following symlinks out of the repo (security-
  // reviewer LOW — symlink-following stat).
  const isDir = token.endsWith("/");
  for (const c of safeCandidates) {
    try {
      const st = lstatSync(c);
      if (isDir ? st.isDirectory() : st.isFile()) {
        return { ok: true, resolvedPath: c };
      }
    } catch {
      // try next candidate
    }
  }

  // SECOND PASS — slash-less tokens only. `isDir` is inferred from the token's
  // trailing slash, never from disk, so a bare token naming a real DIRECTORY
  // (`skills/45-genesis-bootstrap`, `.claude/hooks/lib`) failed the strict
  // isFile() check above and was reported not-found while the thing it points
  // at plainly exists. That false-positive class SHIPS: this validator is in
  // sync-tier-aware.mjs::ALWAYS_INCLUDE, so every consumer running /cc-audit
  // inherited the bogus CRITICAL.
  //
  // Deliberately a SEPARATE pass rather than a relaxed `isFile() ||
  // isDirectory()` predicate in the first one. A file candidate always wins,
  // so a token naming a real file can never be silently satisfied by a
  // same-named directory earlier in the candidate list. The looser match is
  // LABELLED and surfaced in its own report section — "resolved, but written
  // like a file and found as a directory" stays visible instead of vanishing
  // into the pass count. Precision costs a few lines here; a check that
  // silently accepts a wrong-type token is the failure mode this validator
  // exists to catch.
  //
  // Bounded to EXTENSION-LESS tokens (`skills/45-genesis-bootstrap`,
  // `.claude/hooks/lib`). A token written `ghost.md` states its type in its own
  // name, so a DIRECTORY named `ghost.md` must NOT satisfy it — without this
  // bound the fallback would silently retire a real dangling ref the moment a
  // same-named directory appeared, and the row would stop driving the exit code
  // exactly when the deferred CI wiring starts consuming it. All 8 real
  // loose-directory matches in canon are extension-less, so this costs nothing.
  //
  // The `!isDir` conjunct is DEFENSE-IN-DEPTH and provably INERT on POSIX, kept
  // deliberately: for a trailing-slash token pass 1's predicate is
  // `st.isDirectory()` and this pass's is `lstatSync(c).isDirectory()` over the
  // IDENTICAL candidate list in the IDENTICAL order, so this pass is a subset of
  // pass 1 and can never fire where pass 1 did not. Measured, not assumed —
  // widening it to `true` changed 0 of 486 disk-config × token-shape × kind rows
  // (the same harness reports 32 differing rows when the pass is disabled, so it
  // discriminates). No fixture claims to pin it, because none can; see
  // fixture-20's note. The control is 32 for THIS code; it was 48 before the
  // extension bound landed — bounded code has fewer rows where the second pass
  // can fire at all. An earlier revision of this comment quoted the pre-bound 48.
  if (!isDir && !hasFileExtension(token)) {
    for (const c of safeCandidates) {
      try {
        if (lstatSync(c).isDirectory()) {
          return { ok: true, resolvedPath: c, looseDirMatch: true };
        }
      } catch {
        // try next candidate
      }
    }
  }
  return { ok: false, reason: "not-found" };
}

function resolveOne(finding, repoRoot) {
  if (finding.kind === "journal") {
    return resolveJournalToken(finding.token, repoRoot);
  }
  return resolveRefToken(finding.token, repoRoot, finding.source, finding.kind);
}

// --- Exit-code contract -------------------------------------------------

const EXIT_OK = 0; // COMPLETE run, no dangling refs
const EXIT_DANGLING = 1; // COMPLETE run, >=1 dangling ref
const EXIT_USAGE = 2; // usage / argv error
const EXIT_INCOMPLETE = 3; // run did NOT complete — verdict UNKNOWN

// First cause wins; a second failure must not overwrite the diagnosis of the
// first, and must not re-report.
let incompleteReason = null;

function markIncomplete(reason) {
  if (incompleteReason !== null) return;
  incompleteReason = reason;
  // stderr may itself be closed (`cmd 2>&- | true`). A diagnostic that throws
  // must never replace the exit code it exists to explain, so the write is
  // best-effort and the exit code is set regardless — silence on stderr is
  // still distinguishable via exit 3.
  try {
    process.stderr.write(`validate-xref-integrity: INCOMPLETE: ${reason}\n`);
    process.stderr.write(
      "validate-xref-integrity: exit 3 — the verdict is UNKNOWN; this is NOT " +
        "'no dangling refs' (0) and NOT 'dangling refs found' (1).\n",
    );
  } catch {
    /* stderr gone too; the exit code is the only channel left, and it is set */
  }
  process.exitCode = EXIT_INCOMPLETE;
}

// An unhandled 'error' event on process.stdout terminates node with a raw stack
// trace and exit 1 — which a consumer reading the exit code cannot tell apart
// from "complete run, found dangling refs", and which is not an acceptable
// diagnostic in any case. Installing the listener converts that crash into a
// named, single-line cause plus exit 3.
function installStreamGuards() {
  process.stdout.on("error", (err) => {
    const code = err && err.code ? err.code : "unknown";
    markIncomplete(
      code === "EPIPE"
        ? "stdout closed by the reader before the report was fully written (EPIPE)"
        : `stdout write failed (${code})`,
    );
  });
  // Same reasoning one stream over: a failed diagnostic must not become a crash
  // that hides the diagnosis.
  process.stderr.on("error", () => {
    /* diagnostics are best-effort by construction */
  });
}

// --- Main ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, scope: null, help: false, usageError: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a.startsWith("--")) {
      // Reported by main() rather than exited here: process.exit() is what this
      // script no longer uses anywhere, because it discards queued stream
      // writes. Message and exit code are unchanged (stderr, exit 2).
      out.usageError = `unknown flag: ${a}`;
      return out;
    } else {
      // Positional fallback (treat as scope)
      out.scope = a;
    }
  }
  return out;
}

function usage() {
  return `validate-xref-integrity.mjs — mechanical cross-reference detector

usage:
  node .claude/bin/validate-xref-integrity.mjs [--json] [--scope <dir>] [--help]

flags:
  --json        emit JSON report to stdout (machine-readable)
  --scope DIR   limit scan to DIR (default: .claude/{commands,rules,skills,agents}; audit-fixtures excluded — see header)
  --help, -h    show this message and exit 0

exit codes:
  0  COMPLETE run, no dangling refs
  1  COMPLETE run, ≥1 dangling ref found
  2  usage / argv error
  3  INCOMPLETE run — the scan or its report did NOT complete, so the verdict is
     UNKNOWN. Do NOT read exit 3 as either 0 or 1. Causes: stdout could not be
     fully delivered (reader closed the pipe — EPIPE), or ≥1 target file could
     not be read. A named cause is always written to stderr.

what it checks:
  - backtick inline refs: \`rules/foo.md\`, \`skills/foo/bar.md\`, \`journal/NNNN\`, etc.
  - markdown links: [text](path/to/file.md)
  - resolves against <repo>/.claude/<token> and <repo>/<token>

what it does NOT check (Phase-1):
  - bare prose paths
  - section-anchor heuristic (§ heading)
  - refs inside fenced code blocks (treated as illustrative)
`;
}

function main() {
  installStreamGuards();
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.usageError) {
    process.stderr.write(`${args.usageError}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (args.help) {
    process.stdout.write(usage());
    process.exitCode = EXIT_OK;
    return;
  }
  const repoRoot = findRepoRoot(process.cwd());
  const scopeDirs = args.scope
    ? [resolve(args.scope)]
    : DEFAULT_SCOPE_DIRS.map((d) => join(repoRoot, d));
  const scopeFiles = args.scope
    ? []
    : DEFAULT_SCOPE_ROOT_FILES.map((f) => join(repoRoot, f)).filter(existsSync);

  // Collect scan targets
  const targets = [];
  for (const d of scopeDirs) {
    if (existsSync(d)) targets.push(...walkDir(d, repoRoot));
  }
  for (const f of scopeFiles) targets.push(f);

  // Extract + resolve. Per reviewer HIGH-4: a single unreadable file MUST
  // NOT kill the scan with exit 2; log to stderr + continue. Exit 2 is
  // reserved strictly for argv-parsing errors above.
  const allFindings = [];
  const readFailures = [];
  for (const t of targets) {
    let text;
    try {
      text = readFileSync(t, "utf8");
    } catch (e) {
      readFailures.push({ path: relative(repoRoot, t), error: e.message });
      process.stderr.write(
        `validate-xref-integrity: read-failed: ${relative(repoRoot, t)}: ${e.message}\n`,
      );
      continue;
    }
    const findings = extractTokens(text, relative(repoRoot, t));
    for (const f of findings) {
      const r = resolveOne(f, repoRoot);
      allFindings.push({ ...f, ...r });
    }
  }

  // A file the scan could not read shrinks the DENOMINATOR: the run examined
  // fewer targets than it set out to, so `ok: true` would assert "no dangling
  // refs" over a corpus it never fully saw. The pre-existing decision to keep
  // scanning past a read failure (reviewer HIGH-4) is preserved — the run still
  // reports everything it DID find — but the verdict is now marked UNKNOWN
  // rather than shipping as if complete, which is the same silent-error-hiding
  // shape `zero-tolerance.md` Rule 3 blocks. Measured on this repo: zero read
  // failures, so no normal path is affected.
  if (readFailures.length > 0) {
    markIncomplete(
      `${readFailures.length} target file(s) could not be read; the scan covered ` +
        `${targets.length - readFailures.length} of ${targets.length} targets`,
    );
  }

  // Partition not-found findings: SANCTIONED Phase-2-deferred audit-fixture
  // forward-pointers (finding #70) are skipped-not-dangling; everything else is
  // a real dangling ref. Only real dangling refs drive the exit code.
  const notFound = allFindings.filter((f) => !f.ok);
  const skippedDeferred = notFound.filter(isSanctionedDeferredFixture);
  const skippedAbsent = notFound.filter(
    (f) => !isSanctionedDeferredFixture(f) && isSanctionedAbsentRef(f),
  );
  const dangling = notFound.filter(
    (f) => !isSanctionedDeferredFixture(f) && !isSanctionedAbsentRef(f),
  );
  // Resolved, but only by the slash-less-token directory fallback. Reported so
  // the looser match is auditable rather than silently folded into the pass count.
  const looseDirMatches = allFindings.filter((f) => f.ok && f.looseDirMatch);
  const totalScanned = allFindings.length;
  const filesScanned = targets.length;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          // `ok` keeps its pre-existing dangling-only meaning so existing
          // consumers are unaffected. `complete` is the NEW field that says
          // whether `ok` is answerable at all — read them together: `ok: true`
          // with `complete: false` is a verdict over a short denominator, which
          // is exactly the shape exit 3 exists to flag.
          ok: dangling.length === 0,
          complete: incompleteReason === null,
          incomplete_reason: incompleteReason,
          files_scanned: filesScanned,
          tokens_scanned: totalScanned,
          dangling_count: dangling.length,
          skipped_deferred_count: skippedDeferred.length,
          skipped_absent_by_design_count: skippedAbsent.length,
          loose_directory_match_count: looseDirMatches.length,
          read_failures: readFailures,
          dangling: dangling.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: d.reason,
          })),
          skipped_deferred: skippedDeferred.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: "sanctioned-phase2-deferred-fixture",
          })),
          skipped_absent_by_design: skippedAbsent.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: "sanctioned-absent-by-design",
            why: (SANCTIONED_ABSENT_REFS.get(d.token) || {}).why,
          })),
          loose_directory_matches: looseDirMatches.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: "resolved-as-directory-slashless-token",
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      `validate-xref-integrity: scanned ${filesScanned} files, ${totalScanned} xref tokens; ${dangling.length} dangling`,
    );
    if (skippedDeferred.length > 0) {
      process.stdout.write(`; ${skippedDeferred.length} sanctioned deferred-fixture refs skipped`);
    }
    if (skippedAbsent.length > 0) {
      process.stdout.write(`; ${skippedAbsent.length} absent-by-design refs skipped`);
    }
    if (looseDirMatches.length > 0) {
      process.stdout.write(
        `; ${looseDirMatches.length} resolved as directory via slash-less token`,
      );
    }
    if (readFailures.length > 0) {
      process.stdout.write(`; ${readFailures.length} read failures`);
    }
    process.stdout.write("\n");
    if (dangling.length > 0) {
      process.stdout.write("\ndangling refs:\n");
      for (const d of dangling) {
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → ${d.reason}\n`,
        );
      }
    }
    if (skippedDeferred.length > 0) {
      process.stdout.write(
        "\nskipped (sanctioned Phase-2-deferred audit fixtures, finding #70):\n",
      );
      for (const d of skippedDeferred) {
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → phase2-deferred\n`,
        );
      }
    }
    if (skippedAbsent.length > 0) {
      process.stdout.write(
        "\nskipped (sanctioned absent-by-design / external, source-scoped allowlist):\n",
      );
      for (const d of skippedAbsent) {
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → absent-by-design\n`,
        );
      }
    }
    if (looseDirMatches.length > 0) {
      process.stdout.write(
        "\nresolved as DIRECTORY though written without a trailing slash\n" +
          "(not a defect; listed so the looser match stays auditable — add a `/` to pin intent):\n",
      );
      for (const d of looseDirMatches) {
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → resolved-as-directory\n`,
        );
      }
    }
  }

  // NOT process.exit(). On POSIX, process.stdout to a PIPE is ASYNCHRONOUS, and
  // process.exit() DISCARDS whatever is still queued — which silently truncated
  // the report at the pipe-buffer boundary while still exiting 1, handing the
  // consumer malformed JSON under a code that reads as a verdict. Setting
  // exitCode lets node drain stdout and exit on its own; a write that genuinely
  // CANNOT complete raises 'error', which installStreamGuards() routes to
  // markIncomplete() -> exit 3.
  //
  // The incomplete check reads incompleteReason rather than process.exitCode
  // because a stdout 'error' can still arrive AFTER this function returns; that
  // later markIncomplete() overwrites the code set here, which is the intended
  // precedence — an undelivered report outranks the verdict it was carrying.
  if (incompleteReason !== null) return;
  process.exitCode = dangling.length > 0 ? EXIT_DANGLING : EXIT_OK;
}

// Export internals for audit-fixture harness
const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

export {
  extractTokens,
  resolveJournalToken,
  resolveRefToken,
  resolveOne,
  stripFencedBlocks,
  isPlaceholder,
  isCrossCliDispatcher,
  hasFileExtension,
  isSanctionedDeferredFixture,
  isSanctionedAbsentRef,
  normalizeFixtureSlug,
  computeBlockTexts,
  findRepoRoot,
  DEFAULT_SCOPE_DIRS,
  SANCTIONED_DEFERRED_FIXTURES,
  SANCTIONED_ABSENT_REFS,
};

if (isMain) main();
