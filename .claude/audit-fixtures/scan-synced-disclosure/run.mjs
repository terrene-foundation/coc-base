#!/usr/bin/env node
/*
 * Fixture runner for scan-synced-disclosure.mjs (issue #263).
 *
 * Invokes the scanner with --root pointed at each fixture tree and
 * asserts the expected disposition. Every token in every fixture is
 * SYNTHETIC and invented for this fixture — there are NO real operator
 * hostnames, org slugs, runner labels, home paths, or service labels
 * anywhere under this directory.
 *
 *   node .claude/audit-fixtures/scan-synced-disclosure/run.mjs
 *
 * Exit 0 = all fixtures behaved as expected; 1 = a regression.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(
  HERE,
  "..",
  "..",
  "bin",
  "scan-synced-disclosure.mjs",
);

// Each case: { dir, expectExit, expectShapes:[ids], expectFindingCount }
const CASES = [
  {
    name: "flag-each-shape",
    dir: "flag-each-shape",
    expectExit: 1,
    // All five structural shapes must be caught at least once.
    expectShapes: [
      "operator-hostname",
      "nonfoundation-org-slug",
      "org-derived-runner-label",
      "operator-home-path",
      "operator-service-label",
    ],
  },
  {
    name: "clean-foundation-placeholder",
    dir: "clean-foundation-placeholder",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // F404 Shard 3 (2026-07-15): container-internal devcontainer user homes
    // (`/home/dev/` py + `/home/vscode/` rs) are the fixed base-image users,
    // NOT host operator homes — the allowlist suppresses both. This locks the
    // `/home/vscode/` entry added for the rs compose.override.yml.example mounts
    // (and retroactively the pre-existing `/home/dev/` sibling, previously
    // fixture-less). A real operator home still flags (see flag-each-shape /
    // nonown-still-flagged).
    name: "container-internal-home-allowlisted",
    dir: "container-internal-home-allowlisted",
    expectExit: 0,
    expectShapes: [],
  },
  {
    name: "excluded-accepted-history",
    dir: "excluded-accepted-history",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // Option-1 ruling 2026-05-17 (#263): loom's own GitHub host org
    // (esperie-enterprise) + the maintainer's own dev-home-path are
    // self-coordinates and MUST pass clean.
    name: "own-org-allowed",
    dir: "own-org-allowed",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // Proves the Option-1 own-org allowlist did NOT neuter genuine
    // detection: a non-own / 3rd-party org slug (acme-corp/loom) and a
    // different operator's home path MUST still flag even when own
    // coordinates appear on the same surface.
    name: "nonown-still-flagged",
    dir: "nonown-still-flagged",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "operator-home-path"],
  },
  {
    // R2 must-fix #1 (issue #263): the nonfoundation-org-slug shape MUST
    // detect a non-own, non-Foundation org in ALL forms — SSH-clone,
    // `gh api orgs/`, bare `<org>/<repo>`, issue-ref `<org>/<repo>#N`,
    // `<org>/kailash-*`, `<org>/coc-*`. Exactly 6 synthetic findings;
    // the Foundation/own coordinates on the same surface MUST NOT flag
    // (asserted via expectFindingCount: 6).
    name: "r2-org-forms",
    dir: "r2-org-forms",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 6,
  },
  {
    // R2 must-fix #2 (issue #263): the own-org / `<sdk>-enterprise`
    // allowlist entries are anchored — a typosquat that merely PREFIXES
    // the own org (`esperie-enterprise-evil/loom`,
    // `gh api repos/esperie-enterprise-evil/kailash-py`,
    // `nexus-enterprise-evil/loom`) MUST flag. Exactly 3 synthetic
    // findings; the EXACT own org + EXACT public SDK compounds MUST
    // stay clean (asserted via expectFindingCount: 3).
    name: "r2-allowlist-anchor",
    dir: "r2-allowlist-anchor",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 3,
  },
  {
    // R2 must-fix #3 + #4 + R3 must-fix #A (issue #263): runner-label
    // arch suffixes (`arm64`/`aarch64`/`x86_64`) + lowercase
    // `<op>-mini` + real Mac products flag; the R3 single-uppercase
    // stem `X-MacBook-Pro` now ALSO flags (prior stem `[A-Z][a-z]+s?`
    // required ≥1 lowercase, so a 1-char/all-caps stem evaded all
    // three `-Mac` arms); `Proc-Macro` (rust proc-macro) MUST NOT
    // flag. expectFindingCount: 8 (was 7; +1 for the R3
    // `X-MacBook-Pro` single-uppercase-stem case) locks the
    // Proc-Macro negative — a 9th finding would be a `Proc-Macro`
    // false-positive regression.
    name: "r2-hostname-runner",
    dir: "r2-hostname-runner",
    expectExit: 1,
    expectShapes: ["org-derived-runner-label", "operator-hostname"],
    expectFindingCount: 8,
  },
  {
    // R2 must-fix #5 (issue #263): the prior `isExcluded` journal
    // predicate over-excluded any synced file whose basename merely
    // STARTS with `journal` (`journaling-guide.md` → 0-scanned). The
    // fix scopes the exclusion to the `journal/` DIRECTORY only.
    // `rules/journaling-guide.md` (basename starts with `journal`) IS
    // now scanned and its synthetic leak flags (2 findings); the
    // genuine `journal/0001-note.md` directory file stays excluded —
    // expectFindingCount: 2 locks BOTH halves (over-exclusion gone AND
    // accepted-history journal/ exclusion intact).
    name: "r2-exclusion-scoping",
    dir: "r2-exclusion-scoping",
    expectExit: 1,
    expectShapes: ["operator-hostname", "operator-home-path"],
    expectFindingCount: 2,
  },
  {
    // R3 must-fix #B (issue #263): the prior scanner blanket-excluded
    // `variants/**` as never-synced — scope-evasion, since the
    // language overlays COMPOSE INTO the USE-template synced surface
    // at emit time. Fix: stop excluding `variants/` as never-synced;
    // `variants/rs/rules/leakrule.md` (committed overlay) carries a
    // synthetic leak that MUST be scanned + flagged (2 findings:
    // org-slug + runner-label).
    //
    // UPDATED for the `*.operator.local.md` #352 parity (loom Gate-1
    // ingest of the kailash-py re-convergence-#9 disclosure flag): the
    // `*.operator.local.md` suffix exclusion is now loom-source-only
    // (mirrors the `*.local.json` / `*.test.mjs` flips). This runner
    // scans at DESTINATION (`--root`), so the sibling
    // `ci-runners.operator.local.md` — a committed operator-local file
    // that shipped past the never-sync skip — IS now the disclosure
    // event and flags its 3 synthetic operator tokens (operator-hostname
    // + operator-home-path + operator-service-label). Total 5 findings:
    // 2 from leakrule.md + 3 from the operator-local companion. The
    // isolated destination-flip regression lock is
    // `operator-local-md-destination-flip` below. A count below 5 = the
    // #352 parity regressed (operator.local re-blinded, e.g. the generic
    // `*.local.md` catch-all re-swallowing the superset-suffix).
    name: "r3-variant-surface",
    dir: "r3-variant-surface",
    expectExit: 1,
    expectShapes: [
      "nonfoundation-org-slug",
      "org-derived-runner-label",
      "operator-hostname",
      "operator-home-path",
      "operator-service-label",
    ],
    expectFindingCount: 5,
  },
  {
    // `*.operator.local.md` #352 parity — now keyed on git-TRACKING status,
    // not the `REPO_ROOT_ACTIVE === REPO_ROOT` source/destination proxy. The
    // `isExcluded()` skip now fires ONLY for a file git confirms is UNTRACKED
    // (the gitignored per-operator companion); a TRACKED `*.operator.local.md`
    // is public-distributable and MUST be scanned (TRACKED WINS over the name
    // pattern). This committed fixture's `ci-runners.operator.local.md` is
    // TRACKED in loom's enclosing git tree, so `isGitTracked` returns true and
    // it is scanned — its synthetic `/Users/fakeuser/...` home-path MUST flag.
    // The isolated gitignored-vs-tracked distinction (a committed fixture can
    // only ever be TRACKED) is proven deterministically by the temp-git
    // scenario `runTrackingScenario()` below. If the skip ever regresses to
    // unconditional — or the generic `*.local.md` catch-all re-swallows the
    // `*.operator.local.md` superset-suffix — this case flips to exit 0.
    name: "operator-local-md-destination-flip",
    dir: "operator-local-md-destination-flip",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // R3 must-fix #D (issue #263): the 4th-alt anti-flood
    // negative-lookbehind let a 3rd-party org ride a `/` after a
    // git-branch prefix or URL scheme past detection
    // (`chore/acme-corp/loom`, `postgres://acme-corp/loom`). CLOSED
    // by a 5th alternative requiring a closed-set branch prefix OR
    // `<scheme>://` immediately before `<org>/<repo-family>`, reusing
    // the SAME internal-dir / repo-family negative-lookahead so it
    // does NOT flood. `smuggle.md` plants 4 smuggle forms (MUST all
    // flag); `cleanlocks.md` plants 9 flood vectors — real branch
    // names, internal paths, public SDK URLs, DB strings, own-org
    // (MUST all stay clean). expectFindingCount: 4 locks BOTH halves
    // — the close fires AND does not flood. A 5th finding = the
    // close over-extended into a prose-path flood.
    name: "r3-smuggle-closed",
    dir: "r3-smuggle-closed",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 4,
  },
  {
    // R4 single-HIGH (issue #263 Round-4): the R3-added `kailash-sdk`
    // allowlist entry was LEFT-UNANCHORED (only `\b`) — a genuine
    // 3rd-party `github.com/<org>/kailash-sdk` (or bare
    // `<org>/kailash-sdk`) org-slug span had its inner `kailash-sdk`
    // token match the WHOLE span via allowlistCovers(), SUPPRESSING the
    // `<org>` leak (false clean) — the R2 must-fix #2 failure class
    // reintroduced by the R3 broadener. Fix: position-aware entry —
    // `github.com[:/]kailash-sdk/<repo>` (Foundation Go ORG, first
    // segment) + bare-token form stay covered; `<org>/kailash-sdk`
    // (3rd-party REPO, last segment) is flagged. The fixture plants 2
    // synthetic 3rd-party forms (MUST flag) + 4 Foundation/Go-org/bare
    // forms (`go get github.com/kailash-sdk/kailash-go`,
    // `git@github.com:kailash-sdk/kailash-go.git`,
    // `terrene-foundation/kailash-sdk`, bare `kailash-sdk` — MUST stay
    // clean). expectFindingCount: 2 locks BOTH halves — the anchor
    // un-suppresses the 3rd-party leak AND the legit Foundation
    // Go-module install line is NOT newly-flagged. A 3rd finding = the
    // Foundation Go-org form regressed into a false-positive; a count
    // of 0/1 = the anchor failed to un-suppress the 3rd-party leak.
    name: "r4-sdk-allowlist-anchor",
    dir: "r4-sdk-allowlist-anchor",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 2,
  },
  {
    // R5 (issue-followup #336): `refs` git-namespace allowlist anchor.
    // Locks the `refs(?=/)` slash-anchored allowlisting in the
    // nonfoundation-org-slug SHAPE so that:
    //  (a) substrate ref names (`refs/coc/coordination-genN`,
    //      `refs/coc/archive-genN`, `refs/coc/**`, `refs/heads/main`,
    //      `refs/tags/v1.0`) stay CLEAN.
    //  (b) smuggle patterns where `refs-` prefixes a non-Foundation org
    //      slug (`refs-acme-corp/loom`, `chore/refs-customer-corp/coc-x`)
    //      STILL flag. Without the slash-anchor on `refs`, `refs\b` would
    //      match `refs` followed by `-` (a word boundary), suppressing
    //      legitimate smuggle detection.
    //  (c) bare third-party org slugs (`customer-acme/loom`) STILL flag
    //      as before — the `refs` allowlist doesn't touch the broader
    //      4th-alt behavior.
    // Expected findings: 4 (3 explicit FLAG cases + 1 in the explanatory
    // prose line 25 that contains a literal `refs-acme-corp/loom`).
    name: "r5-refs-allowlist",
    dir: "r5-refs-allowlist",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
    expectFindingCount: 4,
  },
  {
    // Issue #352 destination-mode `.local.json` scan-on (R1 security
    // LOW-S2): the `*.local.json` exclusion in `isExcluded()` now scopes
    // to `REPO_ROOT_ACTIVE === REPO_ROOT` (loom-source-scan only). When
    // `--root <dir>` points at a destination, committed `.local.json`
    // files ARE scanned because their presence at a sync destination IS
    // the disclosure event. The fixture plants a synthetic
    // `loom-links.local.json` carrying `/Users/fakeuser/fake-repos`
    // home-path shapes — these MUST flag at the destination scan. At
    // loom-source the same predicate path is excluded; the predicate's
    // destination-mode flip is what this fixture pins.
    name: "destination-local-json",
    dir: "destination-local-json",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // 2026-07-01 bin/*.test.mjs disclosure-leak fix: the `*.test.mjs`
    // exclusion in `isExcluded()` scopes to `REPO_ROOT_ACTIVE === REPO_ROOT`
    // (loom-source-scan only), mirroring the `.local.json` flip above. loom's
    // own bin unit tests legitimately embed synthetic disclosure shapes; at
    // source they are skipped (and never-synced per `**/*.test.mjs`), but a
    // `*.test.mjs` that LEAKS to a consumer IS the disclosure event — so a
    // destination scan MUST flag it. The fixture plants a synthetic
    // `bin/sample.test.mjs` carrying a `/Users/fakeuser/...` home-path; it
    // MUST flag at the destination scan. If the skip ever becomes
    // unconditional, this case flips to exit 0 and the suite goes red.
    name: "test-mjs-destination-flip",
    dir: "test-mjs-destination-flip",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // F77 good (#386): a synced .claude/settings.json with NO operator-PII
    // paths in permissions.allow/deny — every tool-call matcher uses a
    // relative or $CLAUDE_PROJECT_DIR-rooted path. The new
    // settings-permission-absolute-path SHAPE MUST NOT fire AND the
    // existing operator-home-path SHAPE MUST NOT fire (settings.json
    // is now in the walk surface per the F77 isNeverSynced narrowing).
    name: "f77-settings-good",
    dir: "f77-settings-good",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // F77 bad (#386): a synced .claude/settings.json carrying SYNTHETIC
    // operator-PII paths inside permissions.allow tool-call matchers.
    // The fixture plants 3 Edit/Write/Read(/Users/fakeuser/...) entries
    // + 1 Bash(/home/fakebuilder/...) entry — 4 settings-permission-
    // absolute-path findings expected (one per matcher). The /Users/
    // and /home/ tokens additionally trigger the operator-home-path
    // shape, but the fixture's count lock is on the new shape only —
    // a count delta would surface a regression in either the new
    // shape's regex or the per-line tokenization (settings.json is
    // single-line-per-matcher JSON, so each matcher is its own line
    // for the line-by-line scanner).
    name: "f77-settings-bad",
    dir: "f77-settings-bad",
    expectExit: 1,
    expectShapes: ["settings-permission-absolute-path"],
  },
  {
    // F77 own-coords-still-flagged (#386): proves the new SHAPE skips
    // the Option-1 allowlist. The maintainer's own /Users/esperie/ path
    // is allowlisted for PROSE leaks (per the co-owner Option-1 ruling
    // 2026-05-17 #263); the tool-call matcher form is intrinsically
    // wrong regardless of which operator's path appears inside. The
    // fixture plants 2 Edit/Read(/Users/esperie/...) matchers — both
    // MUST flag as settings-permission-absolute-path. The
    // operator-home-path SHAPE would have suppressed these via the
    // /Users/esperie/ allowlist entry, but the new SHAPE's
    // allowlist-skip carve-out fires here. A 0 finding count = the
    // allowlist-skip regressed; a 3rd finding = the skip leaked into
    // the operator-home-path SHAPE (which MUST continue honoring
    // Option-1 for prose leaks).
    name: "f77-settings-own-coords-still-flagged",
    dir: "f77-settings-own-coords-still-flagged",
    expectExit: 1,
    expectShapes: ["settings-permission-absolute-path"],
  },
  {
    // journal/0214 (loom#411): the customer-identity-token shape is driven
    // by a LOOM-ONLY tenant denylist (`.claude/disclosure-tenant-denylist.json`,
    // never synced) the scanner reads RELATIVE TO THE SCANNED ROOT. This
    // fixture proves the mechanism without committing a real customer token
    // to the (synced) fixture surface: the fixture provides its OWN denylist
    // with the SYNTHETIC token "Faketenant"; leaky.js names it in LOWERCASE
    // ("faketenant") and MUST flag (locks the case-insensitive `i` flag);
    // clean.md uses the generic "works-council / co-determination" terms and
    // MUST NOT flag (locks the deliberate non-tokenization of generic
    // vocabulary). expectFindingCount: 1 locks BOTH halves — a 2nd finding
    // = clean.md's generic terms regressed into a token; a 0 count = the
    // tenant-denylist read or the `i` flag regressed. The other fixtures
    // (no denylist file) implicitly lock the INERT-when-absent property:
    // customer-identity-token never appears in their expectShapes.
    name: "customer-identity-token",
    dir: "customer-identity-token",
    expectExit: 1,
    expectShapes: ["customer-identity-token"],
    expectFindingCount: 1,
  },
  {
    // scenario-11 (sync-upflow Wave 2b todo 10): the consumer-owned half of the
    // sanctioned-local-preserve pair (`sync-preserve.local.yaml`) is never
    // synced — `isNeverSynced` skips it unconditionally, same class as
    // `settings.local.json`. The fixture plants an operator-home-path token
    // inside the skipped file; the scan MUST stay clean (the file is never
    // walked). A non-zero exit = the skip predicate regressed.
    name: "sync-preserve-local-skipped",
    dir: "sync-preserve-local-skipped",
    expectExit: 0,
    expectShapes: [],
  },
  {
    // #1324 SOURCE-ONLY GUARD: the `.claude/cross-repo-authz/` exclusion is
    // SOURCE-ONLY (isExcluded, `&& REPO_ROOT_ACTIVE === REPO_ROOT`, mirroring the
    // org-slug-bearing `ecosystem.json` entry): it self-excludes ONLY at the
    // loom-source self-scan (unblocking the operator's commit — #1324). Driven via
    // `--root` this is a DESTINATION scan (REPO_ROOT_ACTIVE !== REPO_ROOT), so the
    // guard does NOT fire and the receipt is SCANNED. The synthetic org is
    // `acme-enterprise` — chosen because it matches the `*-enterprise` alternative
    // of the nonfoundation-org-slug shape — so it flags → exit 1. Make the exclusion
    // UNCONDITIONAL and it flips 1 → 0: the destination scan goes blind (the R1
    // security MEDIUM this fixture guards). The loom-SOURCE self-exclusion (the
    // #1324 fix itself) is exercised by loom's own clean self-scan over its 100+
    // real receipts. COVERAGE BOUND: this proves the guard is source-only, NOT that
    // destination detection is complete — an arbitrary client `<org>/<repo>` whose
    // org matches no shape would NOT flag (the receipt payload has no dedicated
    // content shape); non-distribution is guaranteed by the THREE distribution
    // fences, not this scan. See the fixture receipt's COVERAGE BOUND note.
    name: "cross-repo-authz-guard-source-only",
    dir: "cross-repo-authz-guard-source-only",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug"],
  },
  {
    // #1330 DESTINATION-COMPLETENESS: the source-only guard above proves a
    // leaked receipt is SCANNED at a destination, but the pre-#1330 scanner
    // only FLAGGED it when its target org matched ANOTHER shape (there
    // `acme-enterprise` → `*-enterprise`). An arbitrary client `<org>/<repo>`
    // (a plain `slug/slug` matching NO other shape) sailed through. The
    // `cross-repo-authz-receipt-payload` content shape closes that gap. This
    // fixture plants TWO receipts + a fork `ecosystem.json` (own orgs
    // `harbor-co`/`harborreg`):
    //  • `nimbus-labs/parts-store` (FOREIGN, repo NOT a repo-family, no
    //    `-enterprise`, no git context) → MUST flag, caught ONLY by the new
    //    shape (2 payload lines: `cross-repo-authorized:` + `**Target repo:**`).
    //  • `harbor-co/ledger-svc` (OWN org per ecosystem.json, repo NOT a
    //    repo-family) → MUST NOT flag: own-org-allowlisted by the new shape
    //    AND repo-family-silent for `nonfoundation-org-slug`.
    // The fork `ecosystem.json` contributes 2 `ecosystem-bare-org-slug`
    // findings (registry.org + remote_links.org bare slugs at a destination
    // scan — expected D6 behavior).
    //
    // #1330 L1 (frontmatter `target:` marker) adds two more receipts:
    //  • `2026-01-04-frontmatter-only-leak.md` — BODY markers genericized to
    //    metavariables (the partial-scrub evasion) but a CONCRETE FOREIGN
    //    frontmatter `target: vertex-systems/payments-core` (matches no other
    //    shape) → MUST flag via the `target:` marker ONLY (1 finding). Drop
    //    the `target:` alternative from the shape and this file goes silent.
    //  • `2026-01-05-frontmatter-own-suppressed.md` — frontmatter
    //    `target: harbor-co/settings-svc` (OWN org) → the L1 marker's own-org
    //    lookahead SUPPRESSES it → 0 findings.
    //
    // Findings: 2 (nimbus body) + 1 (vertex frontmatter) + 2 (ecosystem bare
    // slugs) + 0 (harbor-co body + both harbor-co own frontmatter/body) = 5.
    // expectFindingCount: 5 locks ALL directions non-vacuously: a 7th finding
    // = an own-org allowlist regression (harbor-co body OR frontmatter leaked
    // 2); a count of 4 = the L1 frontmatter marker regressed (vertex-systems
    // frontmatter went silent); a count below 4 = the foreign body detection
    // or the ecosystem-bare-org-slug shape regressed.
    name: "cross-repo-authz-arbitrary-org",
    dir: "cross-repo-authz-arbitrary-org",
    expectExit: 1,
    expectShapes: ["cross-repo-authz-receipt-payload", "ecosystem-bare-org-slug"],
    expectFindingCount: 5,
  },
  {
    // scenario-11 narrowness complement: the template-carried carrier
    // `sync-preserve.yaml` (NO `.local`) IS synced template→consumer and MUST
    // be scanned like any other synced artifact. The same operator-home-path
    // token MUST flag here. A 0-finding result = the `.local.yaml` skip
    // over-broadened to swallow the synced template-carried carrier.
    name: "sync-preserve-yaml-scanned",
    dir: "sync-preserve-yaml-scanned",
    expectExit: 1,
    expectShapes: ["operator-home-path"],
  },
  {
    // D6-1 (ECO-IMPL W1-S3): the nonfoundation-org-slug shape is BLIND to a
    // BARE JSON value (`"org": "acme-corp"` — no `/`, no repo-family, no git
    // context). The file-scoped ecosystem-bare-org-slug shape closes that
    // blindness for ecosystem* files ONLY. The fixture plants 2 bare slugs
    // (`"org": "acme-corp"` + `"host": "privatereg"` — MUST flag) alongside
    // synthetic `example-*` / `<org>` values + a dotted `docker.io` host (MUST
    // stay clean). expectFindingCount: 2 locks BOTH halves — the shape fires on
    // the real bare slug AND the allowlist/dot-host values do not flag. A 3rd
    // finding = the allowlist-skip regressed; a 0/1 count = the shape failed.
    name: "ecosystem-bare-org-slug",
    dir: "ecosystem-bare-org-slug",
    expectExit: 1,
    expectShapes: ["ecosystem-bare-org-slug"],
    expectFindingCount: 2,
  },
  {
    // D6-1 negative complement: the committed ecosystem.example.json carries
    // ONLY synthetic example-* / <org> placeholders + dotted public hosts. The
    // file-scoped shape APPLIES (basename matches) but produces ZERO findings —
    // proving it does not false-positive on the public-fork example vocabulary.
    name: "ecosystem-example-clean",
    dir: "ecosystem-example-clean",
    expectExit: 0,
    expectShapes: [],
  },
];

function runScanner(root) {
  try {
    const out = execFileSync("node", [SCANNER, "--check", "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exit: 0, out };
  } catch (e) {
    return {
      exit: typeof e.status === "number" ? e.status : 99,
      out: (e.stdout || "") + (e.stderr || ""),
    };
  }
}

// ────────────────────────────────────────────────────────────────
// Temp-git scenario: git-TRACKING is the operator-local skip predicate.
// ────────────────────────────────────────────────────────────────
//
// A committed fixture under this directory is ALWAYS git-tracked in loom's
// enclosing tree, so it can only ever exercise the TRACKED→SCAN half. The
// GITIGNORED→SKIP half needs a file git reports as UNTRACKED, which cannot be
// a committed fixture. This scenario builds a throwaway git repo and plants
// BOTH polarities so the tracked-vs-gitignored distinction is proven
// deterministically, via genuine git-tracking status — NOT a path heuristic:
//   • a TRACKED `*.operator.local.md` (force-added despite matching the repo's
//     own `.gitignore` — TRACKED WINS over the name pattern) → MUST be scanned
//     → its synthetic leak MUST flag.
//   • a GITIGNORED, UNTRACKED `*.operator.local.md` → MUST be skipped → its
//     synthetic leak MUST NOT appear in findings.
function runTrackingScenario() {
  const problems = [];
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-disclosure-track-"));
    const rulesDir = path.join(tmp, ".claude", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    // The repo gitignores every operator-local companion by name pattern.
    fs.writeFileSync(path.join(tmp, ".gitignore"), "*.operator.local.md\n");
    // Both carry a synthetic operator-home-path leak (SHAPE:operator-home-path).
    fs.writeFileSync(
      path.join(rulesDir, "tracked-companion.operator.local.md"),
      "runbook value: /Users/fakeuser/tracked-secret/repos\n",
    );
    fs.writeFileSync(
      path.join(rulesDir, "ignored-companion.operator.local.md"),
      "runbook value: /Users/fakeuser/ignored-secret/repos\n",
    );
    execFileSync("git", ["-C", tmp, "init", "-q"], { stdio: "ignore" });
    // Force-add the TRACKED companion despite the `.gitignore` pattern — this
    // is the exact "TRACKED WINS over the name pattern" case the fix asserts.
    execFileSync(
      "git",
      [
        "-C",
        tmp,
        "add",
        "-f",
        ".gitignore",
        ".claude/rules/tracked-companion.operator.local.md",
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "user.name=fixture",
        "-C",
        tmp,
        "commit",
        "-qm",
        "init",
      ],
      { stdio: "ignore" },
    );
    // `ignored-companion.operator.local.md` is left UNTRACKED (gitignored).
    const { exit, out } = runScanner(tmp);
    if (exit !== 1) {
      problems.push(`exit ${exit} (expected 1 — tracked leak must flag)`);
    }
    if (!out.includes("tracked-companion.operator.local.md")) {
      problems.push(
        "tracked operator-local was NOT scanned (its leak is missing from findings)",
      );
    }
    if (out.includes("ignored-companion.operator.local.md")) {
      problems.push(
        "gitignored/untracked operator-local was scanned (it MUST be skipped)",
      );
    }
  } catch (e) {
    problems.push(`scenario error: ${e.message}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

let failed = 0;
for (const c of CASES) {
  const root = path.join(HERE, c.dir);
  const { exit, out } = runScanner(root);
  const findingMatches = [...out.matchAll(/\[SHAPE:([a-z-]+)\]/g)];
  const shapesSeen = new Set(findingMatches.map((m) => m[1]));
  const findingCount = findingMatches.length;

  const problems = [];
  if (exit !== c.expectExit) {
    problems.push(`exit ${exit} (expected ${c.expectExit})`);
  }
  for (const s of c.expectShapes) {
    if (!shapesSeen.has(s)) problems.push(`missing expected SHAPE:${s}`);
  }
  if (c.expectShapes.length === 0 && shapesSeen.size > 0) {
    problems.push(`unexpected findings: ${[...shapesSeen].join(", ")}`);
  }
  // Exact finding-count lock — a count delta is a false-positive (extra
  // finding, e.g. Proc-Macro) or false-negative (missing form)
  // regression even when the shape-set still matches.
  if (
    typeof c.expectFindingCount === "number" &&
    findingCount !== c.expectFindingCount
  ) {
    problems.push(
      `finding count ${findingCount} (expected ${c.expectFindingCount}) — ` +
        `a delta is a false-positive or false-negative regression`,
    );
  }

  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  ${c.name}  (exit ${exit}` +
        (c.expectShapes.length
          ? `, shapes: ${[...shapesSeen].sort().join(", ")}`
          : ", clean") +
        ")",
    );
  }
}

// git-tracking scenario (temp repo; tracked→scan + gitignored→skip polarities).
{
  const problems = runTrackingScenario();
  if (problems.length) {
    failed++;
    console.log(`FAIL  operator-local-git-tracking-scenario`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(
      `PASS  operator-local-git-tracking-scenario  ` +
        `(tracked→scanned+flagged, gitignored/untracked→skipped)`,
    );
  }
}

// ── Named regression cases (case name = finding id, per
//    `coc-artifact-eval-coverage.md` MUST-2) ────────────────────────────────
//
// These do not need a fixture TREE — they assert properties of the scanner's
// own run-shape, which is why they live here rather than as sibling dirs.
{
  // `os`, `fs`, `path` are imported at module top.
  const named = [];
  const add = (id, fn) => named.push({ id, fn });

  // RS-16 / GAP B — the allowlist entry annotated "public PACT product" was
  // FALSE (co-owner correction 2026-07-26: that product is NOT public) and
  // suppressed the token on every scanned surface in every repo shipping the
  // scanner. Entry removed. This case locks the removal: plant the token on a
  // synthetic synced surface and require a finding. If someone re-adds the
  // allowlist entry, this case reds.
  add("RS-16-false-public-product-allowlist-entry-absent", () => {
    // GAP B: the allowlist entry annotated "public PACT product" was FALSE
    // (co-owner correction 2026-07-26 — that product is NOT public; the public
    // one is the PACT *reference platform*). It is removed.
    //
    // This case asserts the SOURCE fact (the entry is gone), NOT a behavioural
    // one, and that is deliberate. The first draft asserted "the token now
    // flags" and RED-ed at exit 0 — which measured something worth recording:
    // removing the allowlist is NECESSARY BUT NOT SUFFICIENT, because NO shape
    // detects a bare product name in the first place. The allowlist entry was
    // pre-empting a detector that does not exist. Detection would come from a
    // `.claude/disclosure-tenant-denylist.json` entry (the customer-identity
    // shape loads its denylist from the scanned root) — a ratification call
    // that names a real internal product, deliberately NOT made here.
    //
    // Asserting the true property keeps the suite honest; asserting the
    // behavioural one would have forced either a red suite or a re-added false
    // allowlist entry, and both are worse than a recorded residual.
    const src = fs.readFileSync(SCANNER, "utf8");
    const rx = new RegExp(String.raw`/\\b` + ["Ae", "gis"].join("") + String.raw`\\b/i`);
    return {
      pass: !rx.test(src),
      got: rx.test(src) ? "entry still present in the allowlist" : "entry absent",
      want: "the false public-product allowlist entry is absent",
    };
  });

  // MEASURED DEFECT 2026-08-10 — a `--root` at a NONEXISTENT path returned
  // exit 0 with ZERO output, byte-identical to a clean scan, so a mistyped
  // path silently PASSED the Gate-1 intake gate and /ecosystem-init's
  // pre-write gate. Now exit 2 ("did not run").
  add("root-nonexistent-is-2-not-0", () => {
    const r = runScanner("/nonexistent/path/that/cannot/exist");
    return { pass: r.exit === 2, got: `exit ${r.exit}`, want: "exit 2" };
  });

  add("root-without-synced-surface-is-2-not-0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nosurface-"));
    fs.writeFileSync(path.join(dir, "README.md"), "not a coc checkout\n");
    const r = runScanner(dir);
    return { pass: r.exit === 2, got: `exit ${r.exit}`, want: "exit 2" };
  });

  // The companion property: a clean exit 0 must now carry its own
  // discriminating receipt, so 0-with-output and 0-with-nothing-scanned are
  // no longer the same observation.
  add("clean-check-emits-scanned-count", () => {
    const dir = path.join(HERE, "clean-foundation-placeholder");
    const r = runScanner(dir);
    const out = String(r.out || "");
    return {
      pass: r.exit === 0 && /^Scanned: \d+ files/m.test(out),
      got: `exit ${r.exit} :: ${out.trim().split("\n")[0] || "(no output)"}`,
      want: "exit 0 with a 'Scanned: N files' line",
    };
  });

  for (const c of named) {
    let res;
    try {
      res = c.fn();
    } catch (e) {
      res = { pass: false, got: `threw: ${e.message}`, want: "no throw" };
    }
    if (res.pass) {
      console.log(`PASS  ${c.id}  (${res.got})`);
    } else {
      failed++;
      console.log(`FAIL  ${c.id}`);
      console.log(`        - want: ${res.want}`);
      console.log(`        - got:  ${res.got}`);
    }
  }
}

console.log("");
if (failed) {
  console.log(`${failed} fixture(s) FAILED — scanner regressed`);
  process.exit(1);
}
console.log("all fixtures passed");
process.exit(0);
