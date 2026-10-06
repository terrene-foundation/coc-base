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
 *       `test-harness/probes/foo.probes.json`, `fixtures/foo/`,
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
 *    - CASE-EXACT: every resolved candidate is re-checked segment-by-segment
 *      against `readdirSync`, because `lstatSync` says YES to a wrong-case token
 *      on a case-INSENSITIVE filesystem (macOS, Windows) and NO on the Linux CI
 *      runner. Without it the SAME tree yields different verdicts on the two, and
 *      the operator's is the FALSE-GREEN one. See pathCaseExactUnderRoot.
 *      An UPPERCASE token (`rules/SYNC-COMPLETENESS.md`) looks like an emitted-tree
 *      artifact id — `emit-coc.mjs::deriveId` uppercases source basenames — and a
 *      pass that reverse-derived such ids back to their lowercase source was
 *      BUILT, MEASURED, and REMOVED. It was refuted: every one of the nine
 *      uppercase tokens in the corpus resolves in lowercase, so they are REAL
 *      PATHS, MISCASED, and teaching the resolver to accept them would silence a
 *      class of genuine dangling references — the check-that-cannot-fail outcome
 *      this very pass exists to prevent. The repair is corrected citations, not a
 *      more forgiving resolver. Do not re-add it.
 *
 *  NOT-APPLICABLE (reported, never counted, never drives the exit code):
 *    - `journal/NNNN` provenance citations in a repo with NO root `journal/`
 *      tree. `journal/` is loom-only and NEVER distributed (it is the
 *      NON-cascading local receipt per knowledge-cascade-routing.md), so at every
 *      USE template, BUILD repo and downstream consumer EVERY such citation is
 *      unresolvable BY DESIGN — and counting them dangling made a consumer green
 *      only if loom's rules stopped citing their own provenance. Two things keep
 *      this from being an amnesty: a PRESENT tree with a missing entry is still
 *      `journal-entry-not-found` and still reds, and an ABSENT tree at the repo
 *      that OWNS it (`.claude/VERSION::type == "coc-source"`) is still
 *      `journal-dir-missing` and still reds. See resolveJournalToken.
 *    - `test-harness/` citations in a repo that does not carry the harness
 *      SUBTREE they reach into (2026-08-20, loom#1807). `.claude/test-harness/**`
 *      is never-synced to USE and downstream, and on the BUILD lane only
 *      `test-harness/lib/**` ships — so at a consumer these are unresolvable BY
 *      DESIGN, for the same reason and on the same evidence as `journal/` above.
 *      SUBTREE-scoped, not tree-scoped, because distribution is: at BUILD the
 *      tree exists while `probes/` does not. The same two guards apply — a
 *      PRESENT subtree with a missing member is still `not-found` and still
 *      reds, and at the repo that OWNS the harness (`.claude/VERSION::type ==
 *      "coc-source"`) nothing here is ever not-applicable. See
 *      testHarnessSubtreePresent.
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
 *    - TREES OUTSIDE DEFAULT_SCOPE_DIRS ARE NEVER READ. `.claude/guides` WAS the
 *      consequential one and is now CLOSED (2026-08-13, loom#1406): the tree is
 *      in DEFAULT_SCOPE_DIRS and `guides` is an alternand of BACKTICK_RE, so both
 *      the tree's OUTBOUND refs and every INBOUND backtick citation into it are
 *      checked on a default run. The sequencing that entry demanded was honoured
 *      rather than skipped — b51d3f13 repaired the tree's backlog first, and the
 *      widening was measured green (0 dangling) before it landed. What remains
 *      outside the default scope is `.claude/audit-fixtures` (deliberate — see
 *      the EXCLUDED note above; synthetic test input, reachable via --scope) and
 *      any tree not enumerated in DEFAULT_SCOPE_DIRS, so this edge is narrower
 *      than it was but is not gone: adding a new `.claude/` subtree still
 *      requires adding it here.
 *
 *      THE TOKEN-SURFACE HALF OF THIS EDGE IS NOW DETECTED (2026-08-20,
 *      loom#1807). The former claim that "nothing detects that omission" was
 *      true of BOTH halves and is now true of only one, so it is corrected
 *      rather than left standing. SCOPE (which trees are READ) and TOKEN
 *      SURFACE (which prefixes are RECOGNIZED) are independent, and the second
 *      is the more dangerous: an unread tree still has its INBOUND citations
 *      checked from files that ARE read, whereas an unrecognized prefix is
 *      invisible from EVERYWHERE, under ANY scope, and reports as a PASS.
 *      `test-harness/` was missing for the validator's whole life on exactly
 *      that footing, and the corpus leans on it where danglement costs most
 *      (`coc-artifact-eval-coverage.md` MUST-4 REQUIRES a rule's Detection block
 *      to name its probes file BY PATH). The detector is
 *      `.claude/test-harness/tests/xref-prefix-authority.test.mjs`, which checks
 *      BACKTICK_RE's alternands against `detection-binding-check.mjs`'s
 *      `BINDING_NAMESPACES` — an EXHAUSTIVE, SELF-GUARDING census of `.claude/`
 *      subdirectories — instead of re-listing them by hand
 *      (`verification-gate-integrity.md` MUST-3(a)). It earned its keep on its
 *      first run: it found `.claude/fixtures/` blind too, which the issue had
 *      not named. What is still UNDETECTED is the SCOPE half — a new subtree
 *      absent from DEFAULT_SCOPE_DIRS goes unread with no signal.
 *
 *      DECLARED RESIDUAL — 15 of the authority's 25 remaining `.claude/`
 *      subdirectories are still unrecognized, and this is a KNOWN, MEASURED,
 *      DATED gap rather than an oversight (2026-08-20, loom#1807 follow-up;
 *      REVISIT 2026-11-20). Measured over DEFAULT_SCOPE_DIRS on this tree:
 *      268 backtick occurrences sit on the 25 non-enumerated prefixes, of which
 *      154 would NOT resolve if the prefixes were simply added. The bulk are
 *      absent BY DESIGN, not dangling — `specs/` 110 occ / 89 unresolvable
 *      (project-local domain specs, absent at loom for the same reason
 *      `journal/` is absent at a consumer), `learning/` 45/45 (gitignored
 *      runtime state: posture.json, violations.jsonl), `.proposals/` 48/12
 *      (transient inbox), plus `worktrees/`, `team-memory/`.
 *      Each of those classes needs its OWN by-design-absence carve-out, exactly
 *      as `journal/` and `test-harness/` each needed one; adding the prefixes
 *      without them would either RED the gate on 154 by-design absences or ship
 *      154 blanket amnesties, and the second is worse than the present silence
 *      because it reads as coverage. That is a design task with its own
 *      invariants, deliberately NOT bundled into this shard.
 *
 *      PARTIALLY DISCHARGED (loom#1980) — the receipts namespaces
 *      (`ci-authz/`, `cross-repo-authz/`, `deferral-acceptance/`,
 *      `deferral-requests/`, `load-authz/`, `wip-authz/`, `worktree-authz/` —
 *      SEVEN, counted against the alternand list below rather than restated from
 *      an earlier revision, which said FOUR while listing five) left this
 *      residual and are now RECOGNIZED alternands of
 *      BACKTICK_RE. They were not simply added: they took exactly the route this
 *      paragraph demands — their own by-design-absence carve-outs, SOURCE-SCOPED
 *      in SANCTIONED_ABSENT_REFS, covering the THREE consumed-on-use receipts
 *      (`wip-limit-allow`, `nested-worktree-allow`, `synthetic-load-allow`) whose
 *      absence at rest IS the guard holding. Not a blanket amnesty: a NEW citer
 *      of any of those tokens still flags loud (measured — a probe citer planted
 *      in an undeclared source file reported `not-found` at exit 1).
 *
 *      `load-authz/` joined LAST and late: `detection-binding-check.mjs` declared
 *      it BINDING at 0219efd36 without the matching alternand here, so the #1807
 *      census red (`xref-prefix-authority.test.mjs`) was the only thing standing
 *      between that divergence and a repo-wide invisible prefix. That is the
 *      detector doing exactly the job its own suite header claims for it.
 *
 *      They moved because `detection-binding-check.mjs` made them BINDING
 *      namespaces, and the #1807 census reds when this list and that authority
 *      diverge — so recognition here was compulsory, not optional.
 *
 *      THE FIGURES ABOVE (15 of 25, 268 occurrences, 154 unresolvable) ARE THE
 *      PRE-CHANGE MEASUREMENT and are now STALE BY FOUR NAMESPACES. They are left
 *      as-recorded rather than adjusted by arithmetic, because a re-derived count
 *      that was never actually run would be a fabricated measurement — worse than
 *      a dated stale one. RE-MEASURE before citing any of them; do not subtract.
 *
 *      `variants/` was the one tractable member and is the reason the residual
 *      is bounded rather than open: 34 occurrences, only 3 unresolvable. All
 *      three are in `guides/co-setup/05-variant-architecture.md`. Two named
 *      paths that do not exist and were FIXED in this change against the tree;
 *      the third (`variants/rb/`, line 76) is a correct ASSERTED-ABSENT
 *      reference — the sentence containing it states there is no such directory
 *      — and would need a SANCTIONED_ABSENT_REFS entry, not a repoint, if the
 *      prefix is ever enumerated. Enumerating `variants/` alone was rejected as
 *      a partial fix that would leave the census-vs-extractor divergence #1807
 *      names still open on 24 other directories while reading as closed.
 *    - SLUG TAILS AND RANGE ENDPOINTS are matched loosely; a citation may resolve
 *      on its prefix while its tail names something that does not exist.
 *    - A MATERIALIZED TREE IS NOT A CONSUMER. Running this validator inside a
 *      tree produced by `sync-tier-aware.mjs --out <dir>` is the standard way to
 *      preview a consumer's verdict WITHOUT a cross-repo read, and it is faithful
 *      for `.claude/**` — but `--out` materializes ONLY `.claude/**`, so every
 *      ROOT-LEVEL file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `STACK.md`) is
 *      absent there and present in a real consumer. A citation that climbs out of
 *      `.claude/` — e.g. `[x](../../../CLAUDE.md)` from a skill — is therefore
 *      reported not-found in the scratch tree and resolves fine at the consumer.
 *      Measured both poles: that exact citation is 1 finding in a materialized
 *      base tree and 0 in the real consumer CI log for the same target (control:
 *      59 finding lines in that log, so the matcher had something to find), and
 *      it does not appear among loom's own 11. SUCH FINDINGS MUST NOT BE READ AS
 *      DANGLING; copy the root files in, or discount the class by hand.
 *
 *      NO CHECKER-SIDE FIX IS OFFERED, and the reason is measured rather than
 *      assumed: `../../../CLAUDE.md` from `.claude/skills/<dir>/<file>.md`
 *      resolves to `<repoRoot>/CLAUDE.md`, which is INSIDE the repo root — so
 *      there is no structural signal distinguishing "this tree is a partial
 *      materialization" from "this consumer is genuinely missing its CLAUDE.md".
 *      A rule broad enough to excuse the first would silently excuse the second,
 *      which is the same amnesty class the declaration reader refuses. The defect
 *      is in the INSTRUMENT'S USE, not in what it computes, so it is documented
 *      here rather than coded around.
 *    - AT A REPO WITH NO ROOT `journal/`, exit 0 says NOTHING about journal
 *      citations: every one of them is NOT-APPLICABLE there (see the
 *      NOT-APPLICABLE block above), so their correctness is measured at loom and
 *      nowhere else. This edge is by construction rather than a defect — the
 *      question genuinely has no answer at a repo that does not carry the tree —
 *      but a reader citing a consumer's exit 0 must not read it as covering them.
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

import {
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

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
// Prefixes covered: .claude/, rules/, skills/, commands/, agents/, guides/,
// hooks/, bin/, audit-fixtures/, journal/. The optional `.claude/` prefix is
// handled by allowing either form.
//
// `guides` was ADDED 2026-08-13 (loom#1406). Its absence was not a scope gap but
// a TOKEN-SURFACE gap, and the two are independent: with `.claude/guides` absent
// from DEFAULT_SCOPE_DIRS the tree's OUTBOUND refs went unread, while the absent
// `guides` alternand made every INBOUND backtick citation INTO that tree
// unextractable — from ANY source file, including ones already in default scope.
// Measured on this repo before the fix: a planted `.claude/guides/rule-extracts/
// ghost-1406.md` and a planted bare `guides/rule-extracts/ghost-1406.md`, both in
// a file under `.claude/rules/`, produced ZERO findings and exit 0, while a
// control `rules/ghost-does-not-exist-1406.md` planted on the line above them was
// reported dangling in the same run. So the extractor demonstrably fired on that
// file — the two guides tokens were invisible to the PATTERN, not skipped with it.
// The md-link form was never affected: `[x](../guides/…)` matches MD_LINK_RE on the
// `.md` extension and was reported dangling in that same control run.
// `fixtures` was ADDED in the SAME change, and it was NOT on the issue's list —
// the authority check found it. `.claude/fixtures/` is declared a `fixtures`-kind
// BINDING namespace by the same census, the directory EXISTS here, and two
// citations of `.claude/fixtures/validator-13/` (in `skills/hook-authoring/SKILL.md`
// and `agents/codex-architect.md`) were unextractable for the same reason
// `test-harness/` was. Both resolve, so this lands green — but they were
// UNCHECKED, and an unchecked reference that happens to resolve today is one
// rename away from a silent dangle. This is the derivation earning its keep:
// a hand-restated prefix list would have closed the one gap that was reported
// and left the one that was not.
//
// `test-harness` was ADDED 2026-08-20 (loom#1807), the SAME token-surface class
// `guides` was. Its absence made every `.claude/test-harness/**` citation
// UNEXTRACTABLE repo-wide — not failing, INVISIBLE — so a dangling probe-suite,
// eval-manifest or harness-lib reference shipped under a green exit 0. That is the
// most dangerous shape a gap can take here, because the corpus leans on this prefix
// exactly where a dangling reference costs most: `coc-artifact-eval-coverage.md`
// MUST-4 REQUIRES a rule's Detection block to name its probes file by path.
//
// The prefix list is NOT hand-restated. It is checked against
// `detection-binding-check.mjs::BINDING_NAMESPACES` ∪ `NON_BINDING_CLAUDE_DIRS`,
// which is the corpus's one EXHAUSTIVE, SELF-GUARDING census of `.claude/`
// subdirectories (its own census test reds when a `.claude/` subdir appears in
// neither list, so it cannot silently fall behind the tree). `test-harness` is
// declared there as `{ prefix: ".claude/test-harness/", kind: "probes" }` — a
// BINDING namespace, i.e. a path MUST-4 holds rules to — while this extractor did
// not know the prefix existed. That divergence between two checkers over one
// subject IS the defect #1807 names.
// The `receipts`-kind alternands (`ci-authz`, `cross-repo-authz`,
// `deferral-acceptance`, `deferral-requests`, `load-authz`, `wip-authz`,
// `worktree-authz` — every entry `BINDING_NAMESPACES` carries at `kind:
// "receipts"`, read from that list rather than restated from memory) were added
// when those namespaces became BINDING
// in `detection-binding-check.mjs`. They are here because the #1807 census
// DEMANDED them — it reds when this list and `BINDING_NAMESPACES` diverge, and it
// caught this omission on the same commit that created it. Without them every
// citation into a receipt namespace would be unchecked repo-wide and would dangle
// silently under exit 0, which is the precise divergence-between-two-checkers
// defect #1807 exists to close.
//
// `load-authz` is the second time that census caught the divergence rather than
// the author: it was declared BINDING at 0219efd36 and the alternand did not
// follow, so every `.claude/load-authz/**` citation was invisible here — under
// ANY scope, reporting as a PASS — until the suite red.
const BACKTICK_RE =
  /`((?:\.claude\/)?(?:rules|skills|commands|agents|guides|hooks|bin|audit-fixtures|test-harness|fixtures|ci-authz|cross-repo-authz|deferral-acceptance|deferral-requests|load-authz|wip-authz|worktree-authz)\/[A-Za-z0-9_./~+\-]+)`/g;

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
  // (2026-09-13) `audit-fixtures/ci-check-merge-separation` was here for
  // git.md § CI-check/merge-separation and is DELETED, not moved: that clause's
  // Phase-2 deferral GRADUATED — the detector shipped
  // (`hooks/check-merge-separation-guard.js` + `hooks/lib/check-merge-separation.js`)
  // and the slug now holds 11 real fixtures plus a `run.mjs`, so the token
  // RESOLVES on its own and needs no suppression. Keeping the carve-out would
  // leave a permanent exemption standing over a directory that now exists —
  // which is how the next genuinely-dangling reference at this slug would be
  // absorbed quietly instead of flagged loudly, the exact behaviour this set's
  // own header refuses. Same disposition as the recommendation-quality entry
  // recorded below, reached from the opposite direction: that one because the
  // fixture will NEVER be built, this one because it now HAS been.
  // knowledge-cascade-routing.md Detection mechanism.
  "audit-fixtures/knowledge-cascade-routing",
  // (2026-08-31) `audit-fixtures/recommendation-quality/below-confidence-escalation`
  // was here for MUST-7 and is DELETED, not moved: that clause's Phase-2 deferral was
  // RETIRED (it now states no lexical detector is achievable, and its registry row moved
  // to `phase2-deferrals.json::acknowledged_non_deferrals`), so no fixture directory is
  // owed at that slug and the rule no longer cites one. Keeping the carve-out would leave
  // a permanent suppression standing over a token nothing will ever create — which is how
  // the next genuinely-dangling reference at that slug would be absorbed quietly instead
  // of flagged loudly, the exact behaviour this set's own header refuses. The MUST-8
  // sibling below is a DIFFERENT clause whose deferral still stands, and stays.
  //
  // recommendation-quality.md MUST-8 (sensitivity/classification escalation) Detection mechanism.
  "audit-fixtures/recommendation-quality/sensitivity-escalation",
  // (2026-09-13) `audit-fixtures/enforcement-surface-parity` was here for
  // security.md § Enforcement-Surface Parity and is DELETED, not moved — the same
  // disposition, for the same reason, as the 2026-08-31 removal recorded above.
  // That clause's Phase-2 deferral was RETIRED (its Wiring block now states that no
  // hook detector will ever be built, because neither "was this field promoted to a
  // fail-closed authorization control" nor "did every independent validation surface
  // learn it" is carried by any structural signal, and the surface enumeration is
  // declared in no registry), and its `phase2-deferrals.json` row moves to
  // `acknowledged_non_deferrals`. No fixture directory is owed at that slug and the
  // rule no longer cites one, so a carve-out left standing would be a permanent
  // suppression over a token nothing will ever create — which is how the next
  // genuinely-dangling reference at that slug would be absorbed quietly instead of
  // flagged loudly. The § Path Containment and § Approver-Identity siblings below are
  // DIFFERENT clauses whose deferrals still stand, and stay.
  // orchestration-launch-ledger.md MUST-6 (revival + force-push) Detection
  // mechanism. Adjudicated individually against the same four conditions as the
  // 2026-08-10 block below: (1) the citing line IS that clause's `**Detection
  // mechanism:**` Wiring field; (2) it is declared Phase-2 DEFERRED, not
  // present-tense; (3) the deferral is registered in phase2-deferrals.json
  // (`orchestration-launch-ledger.md#must-6-revival-and-force-push`, risk
  // `trust`, expires 2026-12-11) so it is time-bounded rather than permanent;
  // (4) the fixtures land WITH the detector per cc-artifacts.md Rule 9, so an
  // empty directory created now would be a fake fixture, not coverage.
  "audit-fixtures/orchestration-launch-ledger/revival-and-force-push",

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
  // deploy-hygiene.md § positive-COPY — REMOVED 2026-08-14 (W2-DEFER / T6). The
  // detector GRADUATED, so its fixtures now EXIST and need no absence excuse; and
  // they live at `audit-fixtures/violation-patterns/detectDockerfileWholeContextCopy/`
  // (the per-detector location `validate-emit.mjs::audit-fixture-coverage` enforces),
  // which the rule now cites, so nothing references the old path any more. Left in
  // place it would be a lingering entry pre-clearing the NEXT dangling reference
  // registered at `audit-fixtures/deploy-hygiene-positive-copy` — the same
  // stale-excuse hazard the deferral registry's own staleness checks exist to stop.
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
  // (2026-09-13) `audit-fixtures/coordination-disposition-verification` was here for
  // multi-operator-coordination.md § Coordination-Disposition-Verification and is DELETED,
  // not moved: that clause's Phase-2 deferral was RETIRED (the field now states no detector
  // will ever be built, and its registry row moved to
  // `phase2-deferrals.json::acknowledged_non_deferrals`), so no fixture directory is owed at
  // that slug and the rule no longer cites one. Keeping the carve-out would leave a permanent
  // suppression standing over a token nothing will ever create, quietly absorbing the next
  // genuinely-dangling reference at that slug — the same reasoning the 2026-08-31
  // `recommendation-quality/below-confidence-escalation` deletion above records.
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
  // (2026-09-13) `audit-fixtures/secure-default-new-feature` was here for security.md
  // § Secure-Default For A New Security Feature and is DELETED on the same ground as
  // the § Enforcement-Surface Parity entry above: that clause's Phase-2 deferral was
  // RETIRED, because none of its three deciding facts — is the feature a SECURITY
  // feature, is its default a SILENT no-op, and was on-by-default GENUINELY infeasible
  // for backward-compat — is carried by any argv token, AST node, parsed-document
  // field or git-object fact. The rule no longer cites the slug, so no fixture
  // directory is owed and the carve-out has outlived its condition.
  // security.md § Approver/Decider-Identity Detection mechanism.
  "audit-fixtures/approver-identity-server-derived",
  // spec-accuracy.md § kp:// carve-out Detection mechanism.
  "audit-fixtures/spec-accuracy-kp-carveout",
  // (2026-09-15) `audit-fixtures/knowledge-product-field-type` was here for
  // specs-authority.md Rule 10 and is DELETED on the same ground as the two
  // `security.md` entries above: that clause's Phase-2 deferral GRADUATED —
  // `.claude/hooks/kp-prefix-guard.js` ships with real fixtures at
  // `.claude/audit-fixtures/kp-prefix/` — so the rule no longer cites the slug,
  // the directory was never created, and the carve-out has outlived its
  // condition. Leaving it would absorb the next genuinely-dangling reference at
  // that slug instead of flagging it.
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
  // (2026-08-31) `audit-fixtures/worktree-stash-collision` was here for
  // worktree-isolation.md Rule 9 and is DELETED. Its comment asserted the entry was
  // "registered in phase2-deferrals.json with a dated expiry (2027-02-15)", and that
  // statement is FALSE as of this commit: MEASURED, the registry carries NO row at
  // `worktree-isolation.md#rule-9-stash-collision` and NO row anywhere expiring
  // 2027-02-15 — the deferral GRADUATED (loom#1795, 2026-08-18) and now lives in
  // `acknowledged_non_deferrals` as `#rule-9-phase2-landed`, recording the detector as
  // BUILT AND WIRED. The entry was also already INERT: `.claude/audit-fixtures/
  // worktree-stash-collision/` exists on disk with 40 bipolar cases, so resolveRefToken
  // resolves the token directly and never consults this set (MEASURED: the pre-removal
  // run reported 96 sanctioned skips and named this slug in none of them, and the
  // post-removal run reports the same dangling count). Removing it rather than
  // rewording it is the disposition the entry's own last sentence anticipated: the
  // fixtures shipped, so the carve-out has outlived its condition, and a suppression
  // left standing over a real directory would silently absorb the next dangling
  // reference at that slug if the directory were ever renamed or removed.

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
  // value-prioritization.md MUST-7 (critical-path share) Detection mechanism —
  // 2026-08-11 /sync-from-build kailash-rs Gate-1. Adjudicated individually: the
  // citing clause declares its Phase-2 detector DEFERRED, and the entry is also
  // declared in phase2-deferrals.json::deferrals with a dated `expires`.
  "audit-fixtures/value-prioritization/critical-path-share",
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
  // ── CONSUMED-ON-USE RECEIPTS ──────────────────────────────────────────────
  //
  // All THREE entries became REACHABLE by this checker only when their receipt
  // namespaces were added to BACKTICK_RE's alternands (the #1807 census demanded
  // that once they became BINDING in `detection-binding-check.mjs`). They are
  // sanctioned rather than fixed because absence at rest is CORRECT here: the
  // hook that honours one of these receipts DELETES it, so a resolvable copy in
  // canon would mean the override channel had been left armed. Reddening on them
  // would be reddening on the guard working correctly — the same objection that
  // kept receipts out of BINDING_NAMESPACES until the kind-specific resolution
  // rule answered it, arriving here at the second checker.
  //
  // Kept SOURCE-SCOPED like every entry below, deliberately: a NEW citer of
  // any of these tokens still flags loud. That is what keeps this from decaying into a
  // blanket suppression of the whole receipt namespace, which would re-open the
  // silent-dangle class at exactly the surface this change opened up.
  [
    ".claude/wip-authz/wip-limit-allow",
    {
      why: "CONSUMED-ON-USE RECEIPT. `wip-discipline-guard.js` deletes it as it honours it (the rule's own MUST-2 says 'honoured ONCE (consumed on use)'), so it exists only between an operator writing it and the very next dispatch. A committed copy would be a permanently-armed WIP override.",
      sources: new Set([
        ".claude/rules/wip-discipline.md",
        ".claude/guides/rule-extracts/wip-discipline.md",
        // Handbook Parts II and VI name this receipt to explain what an override
        // IS, for any operator. Same by-design absence as the citers above.
        ".claude/guides/handbook/02-artifacts.md",
        ".claude/guides/handbook/06-operating.md",
      ]),
    },
  ],
  [
    ".claude/worktree-authz/nested-worktree-allow",
    {
      why: "CONSUMED-ON-USE RECEIPT, same class as the wip-authz entry above: the nested-worktree guard's one-shot override channel, spent when honoured. Absent at rest IS the guard holding.",
      sources: new Set([
        ".claude/rules/worktree-isolation.md",
        ".claude/guides/rule-extracts/worktree-isolation.md",
        // Handbook Part VI names this receipt to explain what an override IS
        // (02-artifacts.md does NOT cite this token). Same by-design absence.
        ".claude/guides/handbook/06-operating.md",
      ]),
    },
  ],
  [
    ".claude/load-authz/synthetic-load-allow",
    {
      why: "CONSUMED-ON-USE RECEIPT, same class as the two entries above: the synthetic-load guard's one-shot, reason-bearing override channel. `hooks/lib/override-receipt.js::consumeReceipt` UNLINKS it as it honours it (`fs.unlinkSync(c.abs)`, override-receipt.js:342-354, whose own comment records 'The unlink IS the one-shot property'), and repo-root `.gitignore:33` names the exact path, so canon can never carry a resolvable copy. A committed one would be a permanently-armed load override — precisely the inversion `detector-distribution-baseline.json` records for this receipt. The namespace DIRECTORY exists and is tracked (`.claude/load-authz/README.md`), so this carve-out excuses only the spent RECEIPT, never a citation into a namespace that is gone.",
      sources: new Set([".claude/rules/ci-cost-discipline.md"]),
    },
  ],
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
        // Handbook Part II names it for the same reason: to state canon lacks it.
        ".claude/guides/handbook/02-artifacts.md",
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
      sources: new Set([
        ".claude/rules/local/_README.md",
        // Handbook Part II's coverage-surface table names it as the registry a
        // FORK updates when it adds a local rule; canon ships only the .example.
        // (Conditional on an action canon never takes — same shape as _README.md.)
        ".claude/guides/handbook/02-artifacts.md",
      ]),
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
    "test-harness/probes/instrument-discipline.probes.jsonl",
    {
      // A FIFTH category for this allowlist, named rather than smuggled in under
      // one of the four above: a HISTORICAL citation of a path that has since
      // been DELETED. The citing paragraph quotes a `sync-tier-aware` plan row
      // read at a specific commit (`action:skip reason:exclude`) and then states
      // in its own next sentence that "the suite has since graduated to
      // `test-harness/probes/instrument-discipline.probes.json` and the `.jsonl`
      // is deleted", deliberately leaving the historical reading verbatim rather
      // than restating a measurement over a path it never measured.
      //
      // REPOINTING THIS TOKEN TO THE `.json` WOULD BE THE DEFECT, not the fix: it
      // would attribute a measured plan row to a file that did not exist when the
      // measurement was taken — the `zero-tolerance.md` Rule 3e shape (a claim
      // restated over a surface that changed underneath it). The reference is
      // CORRECT prose about a file that is correctly gone.
      why: "HISTORICAL citation of a DELETED path. The citing paragraph quotes a plan row measured against the `.jsonl` file at an earlier commit and states in the same block that the suite graduated to `.probes.json` and the `.jsonl` was deleted. Repointing it would falsify the measurement it records.",
      sources: new Set([
        ".claude/skills/30-claude-code-patterns/instrument-discipline.md",
      ]),
    },
  ],
  [
    ".claude/test-harness/results/",
    {
      // AUTHORITY, not assertion: `.gitignore` carries the literal line
      // `.claude/test-harness/results/`, so the directory is a per-run OUTPUT
      // location that is absent in EVERY clean checkout including loom's own —
      // the same shape as `bin/loom-links.local.json` above, whose entry cites
      // its gitignore status the same way. `/test-harness-probe` CREATES it when
      // a probe run writes results; a committed copy would be the churn the
      // gitignore exists to prevent. Surfaced by loom#1807, whose prefix widening
      // made these three citations visible for the first time.
      why: "GITIGNORED per-run output directory (`.gitignore` declares `.claude/test-harness/results/`). Created by a `/test-harness-probe` run; absent in every clean checkout by design, so nothing in canon can or should satisfy it.",
      sources: new Set([
        ".claude/commands/test-harness-probe.md",
        ".claude/skills/test-harness-probe/SKILL.md",
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
//
// `.claude/guides` was ADDED 2026-08-13 (loom#1406), completing the fix-then-
// ratchet sequencing that issue set out: b51d3f13 (2026-08-11) repaired the
// backlog inside the tree — 29 broken references fixed, 5 declared absent-by-
// design — and left the widening for a follow-up precisely so the ratchet would
// not convert a known-clean gate into a red one. Re-measured at this commit
// before widening: `--scope .claude/guides` reported 0 dangling over 81 files /
// 456 tokens, so the precondition holds and the widening lands green. The tree
// holds each rule's depth extract, which `self-referential-codify.md` allowlists
// because an edit there changes a rule's enforcement surface exactly as an edit
// to the rule body does — so leaving it unscanned meant exit 0 was silent over
// the enforcement-bearing half of the corpus.
//
// A scope dir that does not exist is skipped by main()'s existsSync guard, so
// this entry is inert (not an error) at any consumer that receives the script
// without the guides tree.
const DEFAULT_SCOPE_DIRS = [
  ".claude/commands",
  ".claude/rules",
  ".claude/skills",
  ".claude/agents",
  ".claude/guides",
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

// Does this repo OWN a root `journal/` tree at all?
//
// `journal/` is loom-only and NEVER distributed (knowledge-cascade-routing.md
// names the /codify journal entry as the NON-cascading local receipt; nothing in
// sync-manifest.yaml ships it). So at every USE template, BUILD repo and
// downstream consumer, EVERY backticked `journal/NNNN` provenance citation in
// every shipped rule points at a tree that is absent BY DESIGN.
//
// Before this distinction existed, all of them resolved to `journal-dir-missing`
// and were reported as dangling defects, which made a consumer green ONLY if
// loom's rules stopped citing their own provenance receipts — i.e. the validator
// demanded that provenance be deleted. Measured on a two-pole simulation (a
// synthetic `.claude/rules/probe.md` citing `journal/0569`, `journal/.pending/
// 0001-x` and `journal/9999`, scanned in an otherwise-identical tree WITH and
// WITHOUT a root `journal/`): 4 dangling without the tree vs 2 with it, while a
// planted control `rules/ghost-does-not-exist-9999.md` was reported in BOTH runs
// — so the extractor demonstrably fired on both poles and the delta is the
// journal class alone, not a skipped file.
function repoOwnsJournalTree(repoRoot) {
  try {
    return statSync(join(repoRoot, "journal")).isDirectory();
  } catch {
    return false;
  }
}

// ...but "absent" is a defect AT THE ONE REPO THAT OWNS THE TREE. `.claude/VERSION::type`
// is the same discriminator `issue-triage-routing.md` routes on, and it ships to
// every consumer carrying that consumer's own class. At `coc-source` (loom) a
// missing root `journal/` is NOT by-design and stays LOUD — so this carve-out
// cannot silently swallow the whole journal class if loom's tree is deleted, or if
// the validator is run from a root that is not the repo root. Any other type, or an
// unreadable/unparseable VERSION, is treated as consumer-like: not-applicable.
//
// Falsifying result, named per instrument-discipline.md MUST-1: at a repo whose
// VERSION says `coc-source` and which has no `journal/`, the run still reports
// `journal-dir-missing` and exits 1. That is what the paired fixture asserts.
// RENAMED from `repoIsJournalOwningSource` (loom#1807): the predicate is not
// journal-specific. It answers "is this the canon repo that OWNS the trees which
// are never distributed" — `journal/` AND `.claude/test-harness/` — and both
// by-design-absence carve-outs read it, so a journal-shaped name would have
// mis-described half its callers.
function repoIsCanonSource(repoRoot) {
  try {
    const v = JSON.parse(readFileSync(join(repoRoot, ".claude", "VERSION"), "utf8"));
    return v && v.type === "coc-source";
  } catch {
    return false;
  }
}

// --- `test-harness/` subtree presence (loom#1807) -----------------------
//
// WHY THIS IS NOT AN AMNESTY. `.claude/test-harness/**` is NEVER-SYNCED to USE
// templates and downstream consumers, and on the BUILD lane ONLY
// `test-harness/lib/**` ships (`sync-tier-aware.mjs::BUILD_ONLY_ALWAYS_INCLUDE`).
// So at a consumer, EVERY `test-harness/` citation in every shipped rule points
// at a subtree that is absent BY CONSTRUCTION — exactly the situation
// `resolveJournalToken` already models for `journal/`, and for the identical
// reason: counting them dangling would make a consumer green only if loom's
// rules stopped naming the probe suites `coc-artifact-eval-coverage.md` MUST-4
// REQUIRES them to name.
//
// This is SUBTREE-scoped rather than tree-scoped, because distribution is:
// a BUILD repo receives `test-harness/lib/**` and nothing else, so at BUILD the
// tree EXISTS while `probes/` does not. A tree-scoped test would resolve `lib/`
// citations and red every `probes/` one there.
//
// TWO things keep it strict where it matters, mirroring the journal carve-out:
//   - at the repo that OWNS the harness (`.claude/VERSION::type == "coc-source"`,
//     i.e. loom) NOTHING here is ever not-applicable; an absent subtree is a
//     defect and stays LOUD;
//   - where the subtree IS present, a missing MEMBER is still a real dangling
//     reference and still drives the exit code.
//
// Falsifying result, named per instrument-discipline.md MUST-1: at a repo whose
// VERSION says `coc-source` and whose `.claude/test-harness/probes/` is absent,
// a `test-harness/probes/x.probes.json` citation still reports dangling and the
// run still exits 1. The paired fixture asserts both poles on one tree.
function isTestHarnessToken(token) {
  return normalizeFixtureSlug(token).startsWith("test-harness/");
}

// True iff the specific `.claude/test-harness/<segment>` this token reaches into
// is present here. For a token naming a TOP-LEVEL harness file
// (`test-harness/eval-manifest.json`) the relevant container is the harness
// directory itself.
function testHarnessSubtreePresent(token, repoRoot) {
  const segments = normalizeFixtureSlug(token).split("/").filter(Boolean);
  // segments[0] === "test-harness"
  const base = join(repoRoot, ".claude", "test-harness");
  const container = segments.length > 2 ? join(base, segments[1]) : base;
  try {
    return statSync(container).isDirectory();
  } catch {
    return false;
  }
}

function resolveJournalToken(token, repoRoot) {
  // token = "journal/NNNN..." or "journal/.pending/NNNN..."
  const m = token.match(/^journal\/(\.pending\/)?(\d{3,4})/);
  if (!m) return { ok: false, reason: "malformed-journal-token" };
  // NOT-APPLICABLE, not dangling: this repo carries no journal tree at all, so
  // the question "does entry NNNN exist" has no answer here. Distinguished from
  // the tree being PRESENT and the specific entry missing, which stays a real
  // defect (`journal-entry-not-found`) and still drives the exit code.
  if (!repoOwnsJournalTree(repoRoot) && !repoIsCanonSource(repoRoot)) {
    return {
      ok: false,
      notApplicable: true,
      reason: "journal-tree-absent-not-applicable",
    };
  }
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

// --- Case-exact resolution ----------------------------------------------
//
// WHY THIS EXISTS. `lstatSync` asks the FILESYSTEM whether a path exists, and on
// a case-INSENSITIVE filesystem (macOS APFS/HFS+ by default, Windows NTFS) it
// answers YES for a token whose spelling does not match the real on-disk name.
// The consumers of this validator run it on BOTH: an operator's mac AND a Linux
// CI runner. So without a case check the SAME tree yields DIFFERENT verdicts on
// the two, and the mac verdict is the FALSE-GREEN one — a dangling ref that reds
// CI is invisible to the operator who is trying to fix it.
//
// Measured on this repo, with a known-answer control (instrument-discipline.md
// MUST-3a): `lstatSync(".claude/commands/TEST-HARNESS-PROBE.md")` and
// `lstatSync(".claude/rules/DOCUMENTATION.md")` BOTH returned FILE on macOS while
// the real on-disk names are `test-harness-probe.md` and `documentation.md`, and
// the control `.claude/commands/DEFINITELY-NOT-A-REAL-FILE.md` returned ENOENT in
// the same probe — so the resolver was demonstrably running and the wrong-case
// hits were the filesystem answering yes, not the probe misfiring.
//
// The check is segment-by-segment against `readdirSync`, which reports the REAL
// spelling on every platform, rather than `realpathSync.native` — the resolver
// deliberately uses `lstat` so a symlink cannot walk it out of the repo, and
// realpath would follow exactly the symlinks that guard exists to refuse.
//
// Falsifying result, named per MUST-1: if case were NOT being enforced, a probe
// token spelled `rules/DOCUMENTATION.md` would resolve `ok: true` here. It does
// not; the paired fixture asserts both poles on one tree.
const dirEntryCache = new Map();

function dirEntryNames(dir, { refresh = false } = {}) {
  if (!refresh && dirEntryCache.has(dir)) return dirEntryCache.get(dir);
  let names;
  try {
    names = new Set(readdirSync(dir));
  } catch {
    names = null;
  }
  dirEntryCache.set(dir, names);
  return names;
}

// True iff every path segment from repoRoot down to absPath exists with EXACTLY
// this spelling. A cached MISS is re-read from disk before it is believed, so a
// caller (the fixture harness) that creates files between calls is never served
// a stale negative; positive hits are cached outright, matching the resolver's
// pre-existing assumption that the tree does not change during a run.
function pathCaseExactUnderRoot(absPath, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(".." + sep)) return false;
  let cur = resolve(repoRoot);
  for (const segment of rel.split(sep).filter((s) => s && s !== ".")) {
    let names = dirEntryNames(cur);
    if (!names || !names.has(segment)) {
      names = dirEntryNames(cur, { refresh: true });
      if (!names || !names.has(segment)) return false;
    }
    cur = join(cur, segment);
  }
  return true;
}

// The candidate paths a token could name, in resolution order. EXTRACTED so the
// shipped-declaration reader tests the SAME paths the resolver tried: a
// source-relative `../02-dataflow/SKILL.md` has no textual `.claude/` prefix to
// normalize, so a reader that guessed at the path shape missed 26 of the 44
// findings left at a materialized consumer tree. One producer of candidates, two
// consumers, no second copy to drift.
function candidatePathsFor(token, repoRoot, sourcePath, kind) {
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
    // ...and source-relative for a BACKTICK ref too, which the resolver does not
    // try (a backtick token is repo-anchored by convention). Declaration lookup
    // is a superset on purpose: it only ever excuses an absence.
    if (kind !== "md-link" && sourcePath) {
      candidates.push(resolve(dirname(join(repoRoot, sourcePath)), token));
    }
  } else {
    // Bare form (rules/foo.md, skills/foo/bar.md, etc.) — try `.claude/<token>`
    // first (the canonical loom-side path), then `<repo-root>/<token>` (loom-
    // internal precedent).
    candidates.push(join(repoRoot, ".claude", token));
    candidates.push(join(repoRoot, token));
    // ...then SOURCE-RELATIVE, LAST (loom#1807 follow-up). A document that lives
    // inside a subtree may name a sibling path relative to ITSELF rather than to
    // the repo root, and until the `fixtures` alternand landed no such token was
    // EXTRACTED, so the resolver never had to model it. It does now:
    // `.claude/test-harness/README.md:42` cites `fixtures/safety/`, meaning
    // `.claude/test-harness/fixtures/safety/`, which EXISTS — while
    // `.claude/fixtures/safety/` (the canonical reading) does not. Reported
    // dangling, the reference was correct and the validator was wrong.
    //
    // ORDERED LAST, and that is the whole safety argument. Both canonical
    // candidates are tried first and a hit there returns before this one is
    // reached, so this line CANNOT change any resolution that already
    // succeeded — it can only convert a not-found into a found. The widening it
    // does buy is real and is why the match is LABELLED (`sourceRelativeMatch`)
    // and surfaced in its own report section rather than folded into the pass
    // count, the same discipline the slash-less directory fallback below
    // follows.
    //
    // WHY IT DOES NOT RE-BLIND THE PREFIX THE SHARD JUST TAUGHT. The candidate
    // is `dirname(<citing file>)/<token>`, so a `test-harness/probes/GHOST.json`
    // cited from `.claude/rules/foo.md` is tested at
    // `.claude/rules/test-harness/probes/GHOST.json` — absent, so the planted
    // ghost still reds. Only a citer that genuinely SITS above the named path is
    // excused, which is exactly the reading that made the citation correct.
    if (sourcePath) {
      candidates.push(resolve(dirname(join(repoRoot, sourcePath)), token));
    }
  }
  return candidates;
}

// The source-relative candidate for a BARE BACKTICK token, or null when there is
// none. Mirrors the exact branch above that pushes it, so the label can never
// describe a path the resolver did not actually try.
//
// md-link is EXCLUDED, and that exclusion is the whole correctness of the label
// rather than a tidiness preference. For a markdown link, source-relative is the
// FIRST candidate and always has been — that is ordinary link semantics, not a
// looser fallback. Measured before this guard existed: labelling it too reported
// 704 "source-relative matches" repo-wide, every one of them a pre-existing,
// entirely normal sibling link (`[x](connection-patterns.md)`), which would have
// buried the handful of genuinely looser backtick matches this section exists to
// surface. A report nobody can read is not an audit trail.
function sourceRelativeCandidateFor(token, repoRoot, sourcePath, kind) {
  if (!sourcePath || kind === "md-link") return null;
  if (token.startsWith(".claude/") || token.startsWith("./") || token.startsWith("../")) {
    return null;
  }
  return resolve(dirname(join(repoRoot, sourcePath)), token);
}

function resolveRefToken(token, repoRoot, sourcePath, kind) {
  const candidates = candidatePathsFor(token, repoRoot, sourcePath, kind);

  // Clamp every candidate to repoRoot before stat — defense-in-depth
  // against path-traversal via `../../etc/passwd`-style tokens. Candidates
  // outside the repo are silently dropped (treated as not-found).
  const safeCandidates = candidates.filter((c) => isInsideRepoRoot(c, repoRoot));

  // For dir tokens (ending in `/`), check directory; otherwise check file.
  // Use lstatSync to avoid following symlinks out of the repo (security-
  // reviewer LOW — symlink-following stat).
  const isDir = token.endsWith("/");
  const srcRel = sourceRelativeCandidateFor(token, repoRoot, sourcePath, kind);
  for (const c of safeCandidates) {
    try {
      const st = lstatSync(c);
      if ((isDir ? st.isDirectory() : st.isFile()) && pathCaseExactUnderRoot(c, repoRoot)) {
        // Labelled, not silent: this hit came from the LAST candidate, the
        // source-relative one, so both canonical readings missed. Surfaced in
        // its own report section so the looser match stays auditable.
        return srcRel && c === srcRel
          ? { ok: true, resolvedPath: c, sourceRelativeMatch: true }
          : { ok: true, resolvedPath: c };
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
        if (lstatSync(c).isDirectory() && pathCaseExactUnderRoot(c, repoRoot)) {
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
  const r = resolveRefToken(finding.token, repoRoot, finding.source, finding.kind);
  // NOT-APPLICABLE, not dangling: this repo does not carry the `test-harness/`
  // subtree the token reaches into, so the question "does this member exist" has
  // no answer here (§ test-harness subtree presence above). Applied ONLY to a
  // resolution FAILURE, so it can never turn a resolved ref into anything else,
  // and NEVER at the repo that owns the harness.
  if (
    !r.ok &&
    isTestHarnessToken(finding.token) &&
    !testHarnessSubtreePresent(finding.token, repoRoot) &&
    !repoIsCanonSource(repoRoot)
  ) {
    return {
      ok: false,
      notApplicable: true,
      reason: "test-harness-subtree-absent-not-applicable",
    };
  }
  return r;
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

// --- PER-TARGET absent-by-design, DERIVED (`--target`) ------------------
//
// WHY DERIVED AND NOT LISTED. SANCTIONED_ABSENT_REFS is hand-enumerated against
// ONE filesystem — loom's — while this validator runs against MANY. The bug that
// shape produces is visible in this very file: the `.claude/skills/project/`
// note above records an entry being SKIPPED because "it EXISTS at loom, so it
// resolves and needs no entry". True at loom; wrong at every consumer, where a
// consumer-owned overlay dir is absent by construction. Its three siblings got
// entries only because they happen NOT to exist here. So the defect was never a
// missing row — it was reasoning about absence from the wrong filesystem.
// `sync-manifest.yaml` already KNOWS, per target, what that target receives.
//
// WHERE THIS CAN RUN, stated plainly because it bounds the whole feature:
// LOOM ONLY. `sync-manifest.yaml` is in the universal `exclude:` block and
// `sync-tier-aware.mjs` is loom-platform tooling, so NEITHER reaches a consumer
// (`sync-tier-aware.mjs` names `.coc-obsoleted` as "the only channel reaching
// EVERY consumer" for exactly this reason). `--target` is therefore a
// PRE-DISTRIBUTION preview run at loom — it tells loom which of its citations
// will dangle in a target's tree BEFORE the sync — and it does NOT make a
// consumer's own CI run green. Doing that needs a slim DERIVED declaration
// SHIPPED per target, the shape `.coc-obsoleted` already proves; that emitter is
// distribution code and is deliberately NOT built here.
//
// The import is DYNAMIC and reached only under `--target` on purpose: this
// validator SHIPS (sync-tier-aware.mjs::ALWAYS_INCLUDE) and its dependency does
// NOT, so a static import would give every consumer ERR_MODULE_NOT_FOUND on load.

// Skip reasons that POSITIVELY DECLARE the path absent for this target. Each is
// a manifest statement, not an inference. `no_tier_match` is deliberately NOT
// here — see targetDisposition.
const PROVING_SKIP_REASONS = new Set([
  "loom_only",
  "exclude",
  "use_exclude",
  "build_exclude",
  "loom_local",
  "reserved_local",
]);

async function loadTargetPlan(repoRoot, target, mode) {
  if (mode !== "use" && mode !== "build") {
    return { error: `--mode must be "use" or "build" (got "${mode}")` };
  }
  const url = pathToFileURL(
    join(repoRoot, ".claude", "bin", "sync-tier-aware.mjs"),
  ).href;
  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    return {
      error:
        `--target requires .claude/bin/sync-tier-aware.mjs and .claude/sync-manifest.yaml, ` +
        `which are loom-platform tooling and never distributed; this repo has neither ` +
        `(${(e && e.code) || (e && e.message) || "import failed"})`,
    };
  }
  // buildPlan calls process.exit() on a manifest defect, which would bypass this
  // script's exit contract entirely (its code 1 is indistinguishable from
  // "dangling refs found"). Its three reachable fail() paths are pre-checked here
  // so they surface as this script's own usage error instead.
  let manifest, repos;
  try {
    manifest = mod.loadManifest();
    repos = mod.parseRepos(manifest);
  } catch (e) {
    return { error: `could not read sync-manifest.yaml (${e.message})` };
  }
  const repo = repos[target];
  if (!repo) {
    return {
      error: `unknown --target "${target}"; declared targets: ${Object.keys(repos).join(", ")}`,
    };
  }
  if (repo.tier_subscriptions == null) {
    return { error: `manifest defect: repos.${target}.tier_subscriptions missing` };
  }
  if (mode === "build" && repo.build === null) {
    return {
      error: `--mode build is not applicable to target "${target}" (repos.${target}.build is null)`,
    };
  }
  let plan, tiers;
  try {
    plan = mod.buildPlan(manifest, target, null, mode);
    tiers = mod.parseTiers(manifest);
  } catch (e) {
    return { error: `could not build the ${mode} plan for "${target}" (${e.message})` };
  }
  // Every glob of EVERY tier, subscribed or not. This is what separates "lives in
  // a tier this target does not subscribe" (PROVEN absent) from "matches no tier
  // at all" (UNDECLARED — reported, never suppressed).
  const allTierGlobs = [];
  for (const globs of Object.values(tiers || {})) {
    if (Array.isArray(globs)) allTierGlobs.push(...globs);
  }
  const byPath = new Map(plan.files.map((f) => [f.path, f]));
  return {
    byPath,
    paths: [...byPath.keys()],
    allTierGlobs,
    matchesAnyManifestGlob: mod.matchesAnyManifestGlob,
  };
}

// Does `relpath` (relative to `.claude/`) reach this target, and if not, does the
// manifest PROVE the absence? Returns null when the path is unknown to the plan.
function targetDisposition(relpath, plan) {
  const exact = plan.byPath.get(relpath);
  const entries = [];
  if (exact) {
    entries.push(exact);
  } else {
    // Directory token: the plan enumerates FILES, so a dir reaches the target if
    // ANY file under it is copied.
    const prefix = relpath.endsWith("/") ? relpath : relpath + "/";
    for (const p of plan.paths) if (p.startsWith(prefix)) entries.push(plan.byPath.get(p));
    if (entries.length === 0) return null;
  }
  // `overlay` DELIVERS the file (a variant REPLACEMENT of its content), so it is
  // received just as `copy` is. Measured: reading `copy` alone reported 62 false
  // dangling refs for base, every one of them `rules/agents.md`, which base
  // receives as a variant overlay.
  if (entries.some((e) => e.action === "copy" || e.action === "overlay")) {
    return { received: true };
  }
  // Every constituent is skipped. Absence is PROVEN only if EVERY one of them is
  // skipped for a reason the manifest positively declares. A `no_tier_match`
  // still counts as proven IF the path matches some OTHER tier's globs — that is
  // "lives in a tier this target does not subscribe". Matching NO tier at all is
  // UNDECLARED: `artifact-flow.md` § MUST NOT is explicit that "matches nothing"
  // must never be relied on as a fence, so it stays reportable.
  const reasons = new Set();
  for (const e of entries) {
    if (PROVING_SKIP_REASONS.has(e.reason)) {
      reasons.add(e.reason);
      continue;
    }
    if (
      e.reason === "no_tier_match" &&
      plan.matchesAnyManifestGlob(e.path, plan.allTierGlobs)
    ) {
      reasons.add("tier_not_subscribed");
      continue;
    }
    return { received: false, proven: false, reason: e.reason || "unknown" };
  }
  return { received: false, proven: true, reason: [...reasons].sort().join("+") };
}

// --- The SHIPPED declaration (`.claude/.coc-xref-absent.json`) ----------
//
// `--target` derives absent-by-design from the manifest, but it can only run at
// loom: neither `sync-manifest.yaml` nor `sync-tier-aware.mjs` is distributed.
// So loom derives the conclusion at Gate-2 and SHIPS it, and this is the READER
// for that file. The PRODUCER is `sync-tier-aware.mjs::emitXrefAbsent` (via
// `bin/lib/xref-absent.mjs`) — deliberately in the distribution code rather than
// on this validator, because this validator SHIPS and a generator inside a
// distributed artifact is the wrong seam.
//
// An earlier revision of this file carried its OWN line-based format and an
// `--emit-absent-by-design` flag. Both were REMOVED, not deprecated. The
// deciding defect was not syntax: a flat path list keys on the PATH, while the
// same relative token (`../01-core-sdk/SKILL.md`) denotes DIFFERENT paths from
// different citing files. A path list must therefore over-declare — suppressing
// a token from a file where it genuinely dangles, which is the amnesty
// direction — or under-declare. The `(token -> sources[])` shape below carries
// the dimension that fixes it, so the entry KEY is the fix and no marker could
// have been.
const XREF_ABSENT_PATH = ".coc-xref-absent.json";

// Declaration format versions this reader understands. `format` is a NUMBER in
// the producer (`xref-absent.mjs::XREF_ABSENT_FORMAT = 1`), read from that
// module rather than assumed.
const SUPPORTED_XREF_ABSENT_FORMATS = new Set([1]);

// Read the shipped declaration.
//
// FOUR outcomes, and the third and fourth are deliberately NOT the same — that
// distinction is the whole reason this loader is not three lines:
//   ABSENT              -> { absent: null }. Silent. A consumer that has not
//                          re-synced yet MUST behave exactly as before.
//   UNRECOGNISED FORMAT -> { absent: null }. ALSO silent, and this is correct:
//                          a newer loom writing format 2 to an older checker is
//                          FORWARD-COMPAT, not corruption. Suppress nothing,
//                          report everything, exit as today.
//   MALFORMED           -> { error }. LOUD: routed to markIncomplete() and
//                          exit 3. Unreadable, unparseable, or structurally
//                          wrong is NOT "absent" — reading it as absent makes a
//                          broken declaration indistinguishable from a clean
//                          run, which is the failure this validator exists to
//                          refuse.
//   VALID               -> { absent }.
//
// NOTE FOR THE PRODUCER: `xref-absent.mjs`'s shipped `note` string currently
// tells readers that a file they "cannot parse" MUST behave as if absent. That
// collapses MALFORMED into ABSENT and is the one point where this reader
// deliberately diverges; the divergence is ratified, and the producer's note
// should be narrowed to unrecognised-VERSION.
function loadXrefAbsentDeclaration(repoRoot) {
  const file = join(repoRoot, ".claude", XREF_ABSENT_PATH);
  if (!existsSync(file)) return { absent: null };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return {
      error: `${XREF_ABSENT_PATH} is present but could not be read (${(e && e.code) || e.message})`,
    };
  }
  let decl;
  try {
    decl = JSON.parse(raw);
  } catch (e) {
    return { error: `${XREF_ABSENT_PATH} is present but is not parseable JSON (${e.message})` };
  }
  if (decl === null || typeof decl !== "object" || Array.isArray(decl)) {
    return { error: `${XREF_ABSENT_PATH} is not a JSON object` };
  }
  if (!Object.prototype.hasOwnProperty.call(decl, "format")) {
    return { error: `${XREF_ABSENT_PATH} has no "format" field` };
  }
  // Version gate BEFORE structural validation: a future format may legitimately
  // restructure `absent`, and rejecting it as malformed would convert a
  // forward-compat upgrade into a hard failure at every consumer.
  if (!SUPPORTED_XREF_ABSENT_FORMATS.has(decl.format)) {
    return { absent: null, unsupportedFormat: decl.format };
  }
  const absent = decl.absent;
  if (absent === null || typeof absent !== "object" || Array.isArray(absent)) {
    return { error: `${XREF_ABSENT_PATH} format ${decl.format} has no usable "absent" object` };
  }
  // Every row is validated HERE rather than at match time, so a malformed row
  // fails loud once instead of silently declining to match on each lookup.
  for (const [token, row] of Object.entries(absent)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { error: `${XREF_ABSENT_PATH}: entry ${JSON.stringify(token)} is not an object` };
    }
    if (!Array.isArray(row.sources) || row.sources.some((s) => typeof s !== "string")) {
      return {
        error: `${XREF_ABSENT_PATH}: entry ${JSON.stringify(token)} has no "sources" array of strings`,
      };
    }
  }
  return { absent };
}

// SOURCE-SCOPED match, and the scoping is load-bearing rather than decorative:
// the same relative token means different paths from different citing files, so
// a token is excused ONLY in the files the producer proved it absent for. A new
// citer of the same token still reports — the identical constraint
// SANCTIONED_ABSENT_REFS enforces in code.
// OWN-PROPERTY lookup, not a bare index: `absent` is parsed from JSON a
// DISTRIBUTOR writes, so a token equal to an Object.prototype member
// (`constructor`, `toString`, `valueOf`, `hasOwnProperty`) would otherwise return
// a truthy NON-row and throw on `.sources`. The token surface does not currently
// produce such a token, so this is prophylactic — but it is one extractor
// widening away from live, and the failure mode is a crash inside the suppression
// path, which is the worst place for one.
function isDeclaredXrefAbsent(finding, absent) {
  if (!Object.prototype.hasOwnProperty.call(absent, finding.token)) return false;
  const row = absent[finding.token];
  if (!row) return false;
  return row.sources.includes(finding.source);
}

// --- DEFERRED PROBE AUTHORSHIP, DERIVED (loom#1807) ---------------------
//
// The `test-harness/probes/<id>.probes.json` class is the bulk of this prefix's
// citations, and most of those suites are deliberately UNWRITTEN: a rule's
// Wiring block NAMES its probe file (which `coc-artifact-eval-coverage.md`
// MUST-4 REQUIRES it to do) while the suite's authorship is deferred under a
// DATED declaration. Those citations are sanctioned forward-pointers, not
// dangling defects — the same disposition SANCTIONED_DEFERRED_FIXTURES gives the
// audit-fixture arm.
//
// DERIVED, NOT RESTATED — this is the whole point, per
// `verification-gate-integrity.md` MUST-3(a). There is a genuine AUTHORITATIVE
// enumeration: `.claude/test-harness/phase2-deferrals.json::probe_authorship_deferrals`,
// read through its OWNING reader `phase2-deferral-integrity.mjs::loadProbeAuthorshipDeferrals`.
// Hand-copying those ~50 paths into a Set here would produce a list that agrees
// with the author's mental model and drifts from the registry silently — and,
// worse, would be a SECOND opinion on whether a deferral has EXPIRED. The reader
// is fail-closed on every axis (absent / unparseable / malformed / never-valid /
// past-expiry all yield NO excuse), so deriving inherits that.
//
// THE IMPORT IS DYNAMIC, and that is load-bearing rather than stylistic. This
// validator is in `sync-tier-aware.mjs::ALWAYS_INCLUDE` and therefore SHIPS to
// every consumer; `bin/phase2-deferral-integrity.mjs` is `loom_only` and does
// NOT. A static import would give every consumer ERR_MODULE_NOT_FOUND on load —
// the identical hazard the `--target` note records for `sync-tier-aware.mjs`.
// Absence is silent and suppresses nothing; at a consumer the subtree-absence
// carve-out above has already made the whole class not-applicable anyway.
//
// SOURCE-SCOPING IS DELIBERATELY NOT APPLIED, and the divergence is named rather
// than left implicit. `detection-binding-check.mjs` requires a declaration to
// name the CITING RULE, because it adjudicates whether THAT RULE discharged its
// MUST-4 binding obligation — a rule-scoped question. This validator asks a
// different one: does the PATH exist? A dated declaration that the path is
// unwritten answers that for every citer, so a rule's own depth extract in
// `guides/rule-extracts/` or its paired skill may cite the same pending suite
// without a second declaration. The safety property is unchanged: when the date
// passes, the reader drops the entry and EVERY citer reds at once.
async function loadDeferredProbeSuites(repoRoot) {
  const url = pathToFileURL(
    join(repoRoot, ".claude", "bin", "phase2-deferral-integrity.mjs"),
  ).href;
  try {
    const mod = await import(url);
    if (typeof mod.loadProbeAuthorshipDeferrals !== "function") return null;
    return mod.loadProbeAuthorshipDeferrals(repoRoot);
  } catch {
    // loom_only module absent (every consumer) — declare nothing.
    return null;
  }
}

// A not-found finding is a SANCTIONED deferred probe suite (skip, not dangling)
// iff its normalized path is a LIVE, unexpired declaration in the registry.
function isSanctionedDeferredProbe(finding, deferredProbes) {
  if (!deferredProbes || deferredProbes.size === 0) return false;
  const slug = normalizeFixtureSlug(finding.token);
  // The registry keys on the repo-relative form INCLUDING `.claude/`.
  return deferredProbes.has(`.claude/${slug}`);
}

// An absolute resolved path as the path shape the plan is keyed on — repo-root
// relative and INCLUDING the `.claude/` prefix, which is what
// `sync-tier-aware.mjs::walkClaudeDir` emits (`.claude/rules/foo.md`, not
// `rules/foo.md`). Measured, not assumed: keying on the stripped form found 0 of
// 3881 plan rows. Returns null for anything outside `.claude/` — a root
// `journal/` citation, say — which no tier governs.
function toManifestRelpath(absPath, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(absPath));
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep)) return null;
  const posix = rel.split(sep).join("/");
  return posix === ".claude" || posix.startsWith(".claude/") ? posix : null;
}

// --- Main ---------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    json: false,
    scope: null,
    help: false,
    usageError: null,
    target: null,
    mode: "use",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
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
  node .claude/bin/validate-xref-integrity.mjs --target <name> [--mode use|build]

flags:
  --json        emit JSON report to stdout (machine-readable)
  --scope DIR   limit scan to DIR (default: .claude/{commands,rules,skills,agents,guides}; audit-fixtures excluded — see header)
  --target NAME LOOM-ONLY preview: report the refs that would dangle in NAME's
                distributed tree. Absent-by-design is DERIVED from
                sync-manifest.yaml per target, never hand-listed. Requires the
                manifest, which never ships — see the § PER-TARGET note.
                CAVEAT when previewing via a materialized tree
                (sync-tier-aware --out): that tree holds ONLY .claude/**, so a
                citation climbing out to a ROOT file (CLAUDE.md, AGENTS.md,
                GEMINI.md, STACK.md) reads not-found there and resolves at a real
                consumer. Do NOT read those as dangling — see the header.
  --mode M      use | build (default use) — selects the lane --target previews
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

async function main() {
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

  // `--target` preview: derive, per target, what that target's tree receives.
  // A load failure is a USAGE error (exit 2), never a silent fall-through to an
  // unfiltered run — a preview that quietly stopped previewing would report
  // loom's verdict under the target's name.
  let targetPlan = null;
  if (args.target) {
    const loaded = await loadTargetPlan(repoRoot, args.target, args.mode);
    if (loaded.error) {
      process.stderr.write(`validate-xref-integrity: ${loaded.error}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    targetPlan = loaded;
  }

  // The shipped declaration, when this repo has one. At loom it is absent and
  // nothing changes; at a consumer it is what makes the manifest's proof
  // available to a tree that has no manifest.
  // The DERIVED deferred-probe-authorship declarations (loom#1807). Loaded once,
  // here, because the import is dynamic and this is the only async frame; a null
  // result (every consumer, where the loom_only reader is absent) declares
  // nothing and suppresses nothing.
  const deferredProbes = await loadDeferredProbeSuites(repoRoot);

  const declResult = loadXrefAbsentDeclaration(repoRoot);
  // An UNRECOGNISED `format` disables suppression entirely. The EXIT behaviour is
  // deliberately unchanged — forward-compat silence is the documented contract at
  // the version gate above, and the direction is safe (the run OVER-reports) — but
  // silence on the DIAGNOSTIC channel is not: an operator watching dozens of
  // by-design refs go red with no stated cause has every incentive to loosen
  // something. Name the version and the consequence, once, on stderr.
  if (declResult.unsupportedFormat !== undefined) {
    try {
      process.stderr.write(
        `validate-xref-integrity: ${XREF_ABSENT_PATH} declares unrecognised format ` +
          `${JSON.stringify(declResult.unsupportedFormat)} (supported: ` +
          `${[...SUPPORTED_XREF_ABSENT_FORMATS].map((v) => JSON.stringify(v)).join(", ")}); ` +
          "absent-by-design suppression is DISABLED for this run, so refs this repo " +
          "does not receive will report as dangling. The exit code is unchanged — a " +
          "newer declaration format is not an error here.\n",
      );
    } catch {
      /* diagnostics are best-effort by construction (see installStreamGuards) */
    }
  }
  if (declResult.error) {
    // A present-but-unusable declaration makes the by-design question
    // UNANSWERABLE, so the verdict is UNKNOWN — never a quiet fall-through to an
    // unsuppressed run, which would be indistinguishable from a clean one.
    markIncomplete(declResult.error);
  }
  const declaration = declResult.absent;

  const scopeDirs = args.scope
    ? [resolve(args.scope)]
    : DEFAULT_SCOPE_DIRS.map((d) => join(repoRoot, d));
  const scopeFiles = args.scope
    ? []
    : DEFAULT_SCOPE_ROOT_FILES.map((f) => join(repoRoot, f)).filter(existsSync);

  // Collect scan targets
  let targets = [];
  for (const d of scopeDirs) {
    if (existsSync(d)) targets.push(...walkDir(d, repoRoot));
  }
  for (const f of scopeFiles) targets.push(f);

  // `--target` also narrows the SOURCE set: a loom-only command's citations say
  // nothing about a consumer's tree, because that command is not in it. Scanning
  // them would report defects no consumer can ever see.
  if (targetPlan) {
    targets = targets.filter((t) => {
      const relpath = toManifestRelpath(t, repoRoot);
      if (relpath === null) return false; // root-level file, not distributed as-is
      const d = targetDisposition(relpath, targetPlan);
      return d === null ? true : d.received;
    });
  }

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

  // `--target` re-resolution. A ref that resolves HERE still dangles THERE when
  // the target does not receive the file it points at. Applied AFTER the normal
  // resolve so loom-local defects are never masked: a token that fails to resolve
  // at loom stays dangling under `--target` too.
  if (targetPlan) {
    for (const f of allFindings) {
      if (!f.ok || !f.resolvedPath) continue;
      const relpath = toManifestRelpath(f.resolvedPath, repoRoot);
      if (relpath === null) {
        // Outside `.claude/`, so no tier governs it. The only such class the
        // token surface produces is a root `journal/` citation, and journal/ is
        // never distributed to anything (§ NOT-APPLICABLE above) — so at a target
        // it is absent by design, for the same reason and by the same evidence.
        if (f.kind === "journal") {
          f.ok = false;
          f.notApplicable = true;
          f.reason = "absent-by-design-for-target (journal-never-distributed)";
        }
        continue;
      }
      const d = targetDisposition(relpath, targetPlan);
      if (d === null || d.received) continue;
      if (d.proven) {
        f.ok = false;
        f.notApplicable = true;
        f.reason = `absent-by-design-for-target (${d.reason})`;
      } else {
        f.ok = false;
        f.reason = `target-does-not-receive (${d.reason})`;
      }
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
  // Apply the shipped declaration to refs that did NOT resolve. Deliberately
  // only to NOT-FOUND findings: it can excuse an absence, never satisfy a
  // reference, so it can never turn a real resolution failure into a pass for
  // any path loom did not PROVE this target lacks.
  if (declaration) {
    for (const f of allFindings) {
      if (f.ok || f.notApplicable) continue;
      if (isDeclaredXrefAbsent(f, declaration)) f.declaredXrefAbsent = true;
    }
  }

  const notFound = allFindings.filter((f) => !f.ok);
  // NOT-APPLICABLE partitions FIRST and unconditionally: a question this repo
  // cannot answer is not a defect it can fix, so it never reaches the sanction
  // filters and never drives the exit code. Currently one member —
  // `journal-tree-absent-not-applicable` (see resolveJournalToken).
  const notApplicable = notFound.filter((f) => f.notApplicable === true);
  const answerable = notFound.filter((f) => f.notApplicable !== true);
  // Deferred-fixture (audit-fixtures arm, in-code allowlist) OR deferred-probe
  // (test-harness arm, DERIVED from the registry). Both are dated, sanctioned
  // forward-pointers and share one bucket, because an operator does not care
  // which registry excused the ref — only that the excuse is dated and expires.
  const isDeferredForwardPointer = (f) =>
    isSanctionedDeferredFixture(f) || isSanctionedDeferredProbe(f, deferredProbes);
  const skippedDeferred = answerable.filter(isDeferredForwardPointer);
  // The SHIPPED declaration and the in-code SANCTIONED_ABSENT_REFS are
  // COMPLEMENTARY, not overlapping: the in-code list names tokens that do not
  // exist AT LOOM by design, the shipped file names tokens that DO exist at loom
  // and provably do not ship to THIS target. Both land in one bucket because a
  // consumer does not care which proof excused the ref.
  const isAbsentByDesign = (f) => isSanctionedAbsentRef(f) || f.declaredXrefAbsent === true;
  const skippedAbsent = answerable.filter(
    (f) => !isDeferredForwardPointer(f) && isAbsentByDesign(f),
  );
  const dangling = answerable.filter(
    (f) => !isDeferredForwardPointer(f) && !isAbsentByDesign(f),
  );
  // Resolved, but only by the slash-less-token directory fallback. Reported so
  // the looser match is auditable rather than silently folded into the pass count.
  const looseDirMatches = allFindings.filter((f) => f.ok && f.looseDirMatch);
  // Resolved, but only by the SOURCE-RELATIVE fallback (loom#1807 follow-up) —
  // both canonical readings missed and the citing file's own directory supplied
  // the hit. Same discipline as the loose-directory list directly above: a
  // looser match is REPORTED, never folded silently into the pass count.
  const sourceRelativeMatches = allFindings.filter((f) => f.ok && f.sourceRelativeMatch);
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
          not_applicable_count: notApplicable.length,
          loose_directory_match_count: looseDirMatches.length,
          source_relative_match_count: sourceRelativeMatches.length,
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
            reason: d.declaredXrefAbsent
              ? "declared-absent-by-design (shipped .coc-xref-absent.json)"
              : "sanctioned-absent-by-design",
            why: d.declaredXrefAbsent
              ? (declaration && declaration[d.token] && declaration[d.token].why) || null
              : (SANCTIONED_ABSENT_REFS.get(d.token) || {}).why,
          })),
          // Full rows, always — the class stays machine-auditable here even
          // though the text report prints only a count (see the text branch).
          not_applicable: notApplicable.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: d.reason,
          })),
          loose_directory_matches: looseDirMatches.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: "resolved-as-directory-slashless-token",
          })),
          source_relative_matches: sourceRelativeMatches.map((d) => ({
            source: d.source,
            line: d.line,
            kind: d.kind,
            token: d.token,
            reason: "resolved-relative-to-citing-file",
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
      // SPLIT by proof source, as the --json branch already does via
      // `declaredXrefAbsent`. The two classes are not interchangeable: a DECLARED
      // absence is a distributor's per-target claim carried in a shipped file and
      // is only as good as that file, while a SANCTIONED one was reviewed into
      // this script's own source. Reporting them under one number asks the
      // operator to audit a distribution claim and a code-reviewed constant with
      // the same eye — and text is the channel an operator actually reads.
      const declaredN = skippedAbsent.filter((d) => d.declaredXrefAbsent === true).length;
      const sanctionedN = skippedAbsent.length - declaredN;
      const parts = [];
      if (declaredN > 0) parts.push(`${declaredN} declared (shipped file)`);
      if (sanctionedN > 0) parts.push(`${sanctionedN} sanctioned (in-code)`);
      process.stdout.write(
        `; ${skippedAbsent.length} absent-by-design refs skipped (${parts.join(", ")})`,
      );
    }
    if (notApplicable.length > 0) {
      // Name each contributing class rather than one blanket label: the count
      // now mixes journal provenance with manifest-declared absences, and a
      // summary that named only the first would misdescribe the rest.
      const naByClass = new Map();
      for (const d of notApplicable) {
        const cls = String(d.reason || "unspecified").split(" (")[0];
        naByClass.set(cls, (naByClass.get(cls) || 0) + 1);
      }
      const breakdown = [...naByClass.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${n} ${cls}`)
        .join(", ");
      process.stdout.write(
        `; ${notApplicable.length} not-applicable (${breakdown}) — unresolvable BY DESIGN in this repo; --json lists them`,
      );
    }
    if (looseDirMatches.length > 0) {
      process.stdout.write(
        `; ${looseDirMatches.length} resolved as directory via slash-less token`,
      );
    }
    if (sourceRelativeMatches.length > 0) {
      process.stdout.write(
        `; ${sourceRelativeMatches.length} resolved relative to the citing file`,
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
        // Same discrimination as the summary count above, per row: which PROOF
        // excused this ref decides where an operator goes to check it.
        const label = d.declaredXrefAbsent
          ? "declared-absent-by-design (shipped file)"
          : "sanctioned-absent-by-design (in-code)";
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → ${label}\n`,
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
    if (sourceRelativeMatches.length > 0) {
      process.stdout.write(
        "\nresolved RELATIVE TO THE CITING FILE, not to the repo root\n" +
          "(not a defect; listed so the looser match stays auditable — the citing document\n" +
          " sits above the path it names, so both canonical readings missed):\n",
      );
      for (const d of sourceRelativeMatches) {
        process.stdout.write(
          `  ${d.source}:${d.line}  [${d.kind}]  ${d.token}  → resolved-relative-to-citing-file\n`,
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
// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
const isMain = isMainModule(import.meta.url);

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
  isSanctionedDeferredProbe,
  isSanctionedAbsentRef,
  isTestHarnessToken,
  testHarnessSubtreePresent,
  loadDeferredProbeSuites,
  repoIsCanonSource,
  BACKTICK_RE,
  targetDisposition,
  toManifestRelpath,
  PROVING_SKIP_REASONS,
  loadXrefAbsentDeclaration,
  isDeclaredXrefAbsent,
  candidatePathsFor,
  XREF_ABSENT_PATH,
  SUPPORTED_XREF_ABSENT_FORMATS,
  normalizeFixtureSlug,
  computeBlockTexts,
  findRepoRoot,
  DEFAULT_SCOPE_DIRS,
  SANCTIONED_DEFERRED_FIXTURES,
  SANCTIONED_ABSENT_REFS,
};

// `main` is async, so a throw inside it becomes an UNHANDLED REJECTION if the
// promise is dropped — and node exits 1 on that, with the report never written.
// Exit 1 is EXIT_DANGLING, so a crash would be indistinguishable from a complete
// run that found dangling references: precisely the conflation the
// `installStreamGuards` comment above calls "not an acceptable diagnostic".
// Route it through the SAME markIncomplete path every other unreadable-verdict
// case uses, so the crash exits 3 (UNKNOWN) with a named cause on stderr.
// The message is built INSIDE its own try. `markIncomplete` is already hardened,
// but the argument expression was not: reading `.stack`/`.message`, or coercing
// with String(), runs USER-CONTROLLED getters on the thrown value. A throwable
// whose `.stack` getter or `toString` throws would re-raise INSIDE this handler,
// producing the unhandled rejection — and the exit-1 conflation — that this very
// block exists to prevent. Pathological, but the fallback costs one try/catch and
// the failure mode it removes is the one we just fixed.
if (isMain) {
  main().catch((e) => {
    let detail;
    try {
      detail = (e && (e.stack || e.message)) || String(e);
    } catch {
      detail = "<throwable whose stack/message/toString itself threw>";
    }
    markIncomplete(`unhandled error during the scan: ${detail}`);
  });
}
