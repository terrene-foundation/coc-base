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
    // keep excluding the genuinely-non-synced companions via the
    // `*.operator.local.md` SUFFIX rule (runs BEFORE isNeverSynced).
    // `variants/rs/rules/leakrule.md` (committed overlay) carries a
    // synthetic leak that MUST now be scanned + flagged (2 findings:
    // org-slug + runner-label); the sibling
    // `ci-runners.operator.local.md` (gitignored-companion suffix)
    // MUST stay excluded (0 findings from it). expectFindingCount: 2
    // locks BOTH halves — variants/ now in scope AND operator.local
    // still excluded via suffix not blanket. A 3rd finding = the
    // operator.local companion regressed into scope.
    name: "r3-variant-surface",
    dir: "r3-variant-surface",
    expectExit: 1,
    expectShapes: ["nonfoundation-org-slug", "org-derived-runner-label"],
    expectFindingCount: 2,
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

console.log("");
if (failed) {
  console.log(`${failed} fixture(s) FAILED — scanner regressed`);
  process.exit(1);
}
console.log("all fixtures passed");
process.exit(0);
