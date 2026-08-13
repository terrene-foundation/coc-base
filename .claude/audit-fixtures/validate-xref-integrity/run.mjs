#!/usr/bin/env node
/*
 * Audit fixture runner for validate-xref-integrity (F22, journal/0150).
 *
 * Structural probes per rules/probe-driven-verification.md MUST-3:
 *   - exit-code / count-of-elements / equality checks on pure-function outputs.
 *   - NO semantic judgment, NO regex on assistant prose.
 *
 * Exit 0 = all fixtures pass. Exit 1 = ≥1 fixture failed.
 */

import {
  extractTokens,
  resolveJournalToken,
  resolveRefToken,
  resolveOne,
  stripFencedBlocks,
  isPlaceholder,
  isCrossCliDispatcher,
  hasFileExtension,
  isSanctionedAbsentRef,
  isSanctionedDeferredFixture,
  computeBlockTexts,
  findRepoRoot,
  DEFAULT_SCOPE_DIRS,
} from "../../bin/validate-xref-integrity.mjs";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = findRepoRoot(process.cwd());

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

// ------------------------------------------------------------------
// fixture-01-backtick-extract
// ------------------------------------------------------------------
{
  const text = "see `rules/foo.md` and `.claude/rules/bar.md` plus `<id>` literal";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-01-backtick-extract",
    tokens.length === 2 &&
      tokens.includes("rules/foo.md") &&
      tokens.includes(".claude/rules/bar.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-02-md-link-extract
// ------------------------------------------------------------------
{
  const text =
    "[a](rules/foo.md) [b](https://x.com/x.md) [c](#frag) [d](skills/x/y.md#anchor)";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-02-md-link-extract",
    tokens.length === 2 &&
      tokens.includes("rules/foo.md") &&
      tokens.includes("skills/x/y.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-03-journal-backtick
// ------------------------------------------------------------------
{
  const text = "see `journal/0150-DECISION-foo.md` and `journal/.pending/0001-bar`";
  const findings = extractTokens(text, "test.md");
  const kinds = findings.map((f) => f.kind).sort();
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-03-journal-backtick",
    findings.length === 2 &&
      kinds[0] === "journal" &&
      kinds[1] === "journal" &&
      tokens[0] === "journal/.pending/0001-bar" &&
      tokens[1] === "journal/0150-DECISION-foo.md",
    `got findings=${JSON.stringify(findings.map((f) => ({ k: f.kind, t: f.token })))}`,
  );
}

// ------------------------------------------------------------------
// fixture-04-fence-strip
// ------------------------------------------------------------------
{
  const text = [
    "see `rules/outside.md`",
    "```",
    "this `rules/inside-fence.md` is illustrative",
    "```",
    "and `rules/after-fence.md`",
  ].join("\n");
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-04-fence-strip",
    tokens.length === 2 &&
      tokens.includes("rules/outside.md") &&
      tokens.includes("rules/after-fence.md") &&
      !tokens.includes("rules/inside-fence.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-04b-fence-run-length
// ------------------------------------------------------------------
// A 4-backtick fence whose body contains a 3-backtick fence. CommonMark
// closes a fence only on a run of the SAME character that is AT LEAST as
// long as the opener, so every line below between the ```` markers is
// fenced content and none of its tokens may be extracted.
//
// The discriminating token is `rules/between-inner.md`. A stripper that
// compares only the fence CHARACTER treats the first inner ``` as a close,
// which re-opens scanning mid-block and leaks that one token — while
// `rules/inner-a.md` and `rules/inner-b.md` stay blanked either way. So the
// leak is a parity FLIP, not uniform: a case asserting only "inner tokens
// are absent" passes under BOTH implementations and cannot discriminate.
{
  const text = [
    "see `rules/outside.md`",
    "````",
    "this `rules/inner-a.md` is illustrative",
    "```",
    "this `rules/between-inner.md` is ALSO illustrative",
    "```",
    "this `rules/inner-b.md` is illustrative",
    "````",
    "and `rules/after.md`",
  ].join("\n");
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-04b-fence-run-length",
    tokens.length === 2 &&
      tokens.includes("rules/outside.md") &&
      tokens.includes("rules/after.md") &&
      !tokens.includes("rules/between-inner.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-05-md-link-relative-resolve
// ------------------------------------------------------------------
// Build a temp tree: <tmp>/source-dir/source.md links to ../sibling/target.md
// at <tmp>/sibling/target.md. Resolver must match.
{
  const tmp = join(tmpdir(), `xref-fix-05-${Date.now()}`);
  try {
    mkdirSync(join(tmp, "source-dir"), { recursive: true });
    mkdirSync(join(tmp, "sibling"), { recursive: true });
    writeFileSync(join(tmp, "sibling", "target.md"), "# target\n");
    writeFileSync(join(tmp, "source-dir", "source.md"), "[t](../sibling/target.md)\n");

    // Use resolveRefToken directly with kind="md-link" + source-relative path
    const result = resolveRefToken(
      "../sibling/target.md",
      tmp,
      "source-dir/source.md",
      "md-link",
    );
    check(
      "fixture-05-md-link-relative-resolve",
      result.ok === true,
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-06-placeholder-reject
// ------------------------------------------------------------------
{
  check(
    "fixture-06-placeholder-reject",
    isPlaceholder("<id>") &&
      isPlaceholder("<NNNN>") &&
      isPlaceholder("{topic}") &&
      !isPlaceholder("rules/foo.md") &&
      !isPlaceholder("skills/x/y.md"),
    `placeholder detection broken`,
  );
}

// ------------------------------------------------------------------
// fixture-07-dir-token-vs-file
// ------------------------------------------------------------------
{
  const tmp = join(tmpdir(), `xref-fix-07-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "audit-fixtures", "alpha"), { recursive: true });
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "audit-fixtures", "alpha", "README.md"), "# x");
    writeFileSync(join(tmp, ".claude", "rules", "alpha.md"), "# y");

    // Dir token with trailing /
    const r1 = resolveRefToken(
      "audit-fixtures/alpha/",
      tmp,
      null,
      "backtick",
    );
    // File token without trailing /
    const r2 = resolveRefToken("rules/alpha.md", tmp, null, "backtick");
    // File token WITH trailing slash → should fail (file, not dir)
    const r3 = resolveRefToken("rules/alpha.md/", tmp, null, "backtick");
    check(
      "fixture-07-dir-token-vs-file",
      r1.ok === true && r2.ok === true && r3.ok === false,
      `r1=${r1.ok} r2=${r2.ok} r3=${r3.ok}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-08-claude-prefix
// ------------------------------------------------------------------
{
  const tmp = join(tmpdir(), `xref-fix-08-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "rules", "x.md"), "# x");
    const r = resolveRefToken(".claude/rules/x.md", tmp, null, "backtick");
    check(
      "fixture-08-claude-prefix",
      r.ok === true,
      `got r=${JSON.stringify(r)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-09-bare-prefix-tries-claude-first
// ------------------------------------------------------------------
// `rules/x.md` should resolve to `<repo>/.claude/rules/x.md` when only
// the .claude/-prefixed variant exists.
{
  const tmp = join(tmpdir(), `xref-fix-09-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "rules"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "rules", "x.md"), "# x");
    // bare-prefix form (no leading .claude/)
    const r = resolveRefToken("rules/x.md", tmp, null, "backtick");
    check(
      "fixture-09-bare-prefix-tries-claude-first",
      r.ok === true && r.resolvedPath && r.resolvedPath.endsWith(".claude/rules/x.md"),
      `got r=${JSON.stringify(r)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-10-journal-resolve-prefix
// ------------------------------------------------------------------
// Build a temp journal dir with `0150-DECISION-foo.md`; resolveJournalToken
// for `journal/0150` MUST match (NNNN-prefix glob), and `journal/9999` MUST NOT.
{
  const tmp = join(tmpdir(), `xref-fix-10-${Date.now()}`);
  try {
    mkdirSync(join(tmp, "journal"), { recursive: true });
    writeFileSync(join(tmp, "journal", "0150-DECISION-foo.md"), "# foo");
    const hit = resolveJournalToken("journal/0150", tmp);
    const miss = resolveJournalToken("journal/9999", tmp);
    check(
      "fixture-10-journal-resolve-prefix",
      hit.ok === true && miss.ok === false && miss.reason === "journal-entry-not-found",
      `hit=${JSON.stringify(hit)} miss=${JSON.stringify(miss)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-11-anchor-stripping
// ------------------------------------------------------------------
// `journal/0150-foo.md#section` extracts token `journal/0150-foo.md` (the
// regex char-class excludes `#`); the section anchor is NOT verified per
// Phase-1 exclusion. Pinned to prevent regex drift in future edits.
{
  const text = "see `journal/0150-foo.md` and `journal/0150-foo` and [x](rules/foo.md#section)";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-11-anchor-stripping",
    tokens.length === 3 &&
      tokens.includes("journal/0150-foo.md") &&
      tokens.includes("journal/0150-foo") &&
      tokens.includes("rules/foo.md") && // md-link strips the `#section` anchor
      !tokens.some((t) => t.includes("#")),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-12-crlf-line-endings
// ------------------------------------------------------------------
// split(/\r?\n/) handles CRLF; verify no token corruption.
{
  const text = "first line `rules/a.md`\r\nsecond line `rules/b.md`\r\n";
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  const lines = findings.map((f) => f.line).sort();
  check(
    "fixture-12-crlf-line-endings",
    tokens.length === 2 &&
      tokens.includes("rules/a.md") &&
      tokens.includes("rules/b.md") &&
      lines[0] === 1 &&
      lines[1] === 2,
    `got tokens=${JSON.stringify(tokens)} lines=${JSON.stringify(lines)}`,
  );
}

// ------------------------------------------------------------------
// fixture-13-tilde-fence
// ------------------------------------------------------------------
// `~~~` fences are stripped exactly like ` ``` ` fences.
{
  const text = [
    "see `rules/outside.md`",
    "~~~",
    "this `rules/inside-tilde.md` is illustrative",
    "~~~",
    "and `rules/after-tilde.md`",
  ].join("\n");
  const findings = extractTokens(text, "test.md");
  const tokens = findings.map((f) => f.token).sort();
  check(
    "fixture-13-tilde-fence",
    tokens.length === 2 &&
      tokens.includes("rules/outside.md") &&
      tokens.includes("rules/after-tilde.md") &&
      !tokens.includes("rules/inside-tilde.md"),
    `got tokens=${JSON.stringify(tokens)}`,
  );
}

// ------------------------------------------------------------------
// fixture-14-path-traversal-guard
// ------------------------------------------------------------------
// Malicious md-link token MUST NOT resolve to a path outside repoRoot
// (security-reviewer MEDIUM-1 — `isInsideRepoRoot`).
//
// THE EARLIER VERSION OF THIS FIXTURE COULD NOT FAIL, and the way it could not
// is worth stating because it is the failure mode the whole validator exists to
// catch. It asserted `not-found` for `../../../../../etc/passwd` resolved from a
// tree under `os.tmpdir()`. On macOS `tmpdir()` is `/var/folders/<a>/<b>/T/...`,
// so five `..` hops land on `/var/folders/etc/passwd` — a path that does not
// exist. The assertion therefore held for the WRONG REASON: the traversal target
// was absent, not clamped. Deleting `isInsideRepoRoot`'s guard entirely left the
// fixture GREEN (measured: mutation `isInsideRepoRoot -> return true` executed 23
// times during this suite and reddened nothing). The outcome was constant across
// both branches of the hypothesis, which is `instrument-discipline.md` MUST-1.
//
// The repair makes the escape target REAL and tmpdir-shape-independent: a file
// is planted at a known relative distance outside the root, its existence is
// asserted (so `not-found` can only mean "clamped"), and a POSITIVE CONTROL
// resolves an INSIDE token through the same resolver on the same tree — so a
// resolver that refused everything could not pass either.
{
  const tmp = join(tmpdir(), `xref-fix-14-${Date.now()}`);
  try {
    const root = join(tmp, "root");
    mkdirSync(join(root, "source-dir"), { recursive: true });
    writeFileSync(join(root, "source-dir", "source.md"), "source");
    writeFileSync(join(root, "source-dir", "sibling.md"), "inside the root");
    // A REAL file one level ABOVE the repo root.
    mkdirSync(join(tmp, "outside"), { recursive: true });
    const escapeTarget = join(tmp, "outside", "secret.md");
    writeFileSync(escapeTarget, "OUTSIDE THE ROOT");

    // Precondition, asserted rather than assumed: without the guard this token
    // resolves onto a file that is really there.
    const targetExists = existsSync(escapeTarget);

    const escaping = resolveRefToken(
      "../../outside/secret.md",
      root,
      "source-dir/source.md",
      "md-link",
    );
    // POSITIVE CONTROL — same resolver, same tree, a token that stays inside.
    const inside = resolveRefToken(
      "./sibling.md",
      root,
      "source-dir/source.md",
      "md-link",
    );

    check(
      "fixture-14-path-traversal-guard",
      targetExists === true &&
        inside.ok === true &&
        escaping.ok === false &&
        escaping.reason === "not-found",
      `targetExists=${targetExists} inside=${JSON.stringify(inside)} escaping=${JSON.stringify(escaping)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-15-extended-placeholders
// ------------------------------------------------------------------
// Reviewer MEDIUM-4: isPlaceholder also rejects ${VAR}, %(var)s forms.
{
  check(
    "fixture-15-extended-placeholders",
    isPlaceholder("${API_KEY}") &&
      isPlaceholder("%(var)s") &&
      isPlaceholder("rules/${NAME}.md") &&
      !isPlaceholder("rules/foo.md") &&
      !isPlaceholder("skills/percent-100.md"),
    `placeholder extension broken`,
  );
}

// ------------------------------------------------------------------
// fixture-16-cross-cli-dispatcher (FC, journal/0186)
// ------------------------------------------------------------------
// isCrossCliDispatcher skips the Codex dispatcher token family bin/coc /
// bin/coc-<phase> (anchored ^bin/coc(-[a-z0-9-]+)?$) and NOTHING ELSE.
{
  check(
    "fixture-16-cross-cli-dispatcher",
    isCrossCliDispatcher("bin/coc") === true &&
      isCrossCliDispatcher("bin/coc-analyze") === true &&
      isCrossCliDispatcher("bin/cocktail.mjs") === false &&
      isCrossCliDispatcher("bin/codex.mjs") === false &&
      isCrossCliDispatcher("bin/coc.mjs") === false &&
      isCrossCliDispatcher("bin/emit.mjs") === false,
    `cross-cli dispatcher token classification broken`,
  );
}

// ------------------------------------------------------------------
// fixture-17-default-scope-excludes-audit-fixtures (FC, journal/0186)
// ------------------------------------------------------------------
// audit-fixtures/ is NOT a default SCAN SOURCE (synthetic test corpora);
// still reachable via explicit --scope. The other four trees stay in default.
{
  check(
    "fixture-17-default-scope-excludes-audit-fixtures",
    !DEFAULT_SCOPE_DIRS.some((d) => d.includes("audit-fixtures")) &&
      DEFAULT_SCOPE_DIRS.includes(".claude/rules") &&
      DEFAULT_SCOPE_DIRS.includes(".claude/skills") &&
      DEFAULT_SCOPE_DIRS.includes(".claude/commands") &&
      DEFAULT_SCOPE_DIRS.includes(".claude/agents"),
    `DEFAULT_SCOPE_DIRS scope set incorrect`,
  );
}

// ------------------------------------------------------------------
// fixture-18-slashless-token-naming-directory-resolves-labelled
// ------------------------------------------------------------------
// A bare token naming a real DIRECTORY (`skills/45-genesis-bootstrap`) must
// RESOLVE, not report not-found — `isDir` is inferred from the token's
// trailing slash, never from disk. The match is LABELLED so it stays visible.
{
  const tmp = join(tmpdir(), `xref-fix-18-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "skills", "45-genesis-bootstrap"), { recursive: true });
    const result = resolveRefToken("skills/45-genesis-bootstrap", tmp, "a.md", "backtick");
    check(
      "fixture-18-slashless-token-naming-directory-resolves-labelled",
      result.ok === true && result.looseDirMatch === true,
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-19-file-wins-over-directory-no-loose-label
// ------------------------------------------------------------------
// THE tightness property. Candidate order for a bare token puts `.claude/<t>`
// FIRST and `<root>/<t>` second. With a DIRECTORY at the first candidate and a
// FILE at the second, the FILE must win and the result must carry NO loose
// label — proving the directory fallback is a second pass, not a relaxed
// predicate that would let a same-named directory satisfy a file reference.
{
  const tmp = join(tmpdir(), `xref-fix-19-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "thing"), { recursive: true }); // directory, first candidate
    writeFileSync(join(tmp, "thing"), "real file\n"); // file, second candidate
    const result = resolveRefToken("thing", tmp, "a.md", "backtick");
    check(
      "fixture-19-file-wins-over-directory-no-loose-label",
      result.ok === true &&
        result.looseDirMatch !== true &&
        result.resolvedPath === join(tmp, "thing"),
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-20-trailing-slash-token-resolves-strictly-unlabelled
// ------------------------------------------------------------------
// An explicit-directory token skips a FILE at candidate-1 and resolves at the
// DIRECTORY at candidate-2 — carrying NO loose label, because the strict first
// pass matched it. Pins two things the slash-less fallback must not disturb:
// the trailing-slash form is type-checked, and its match is not mislabelled.
//
// This fixture REPLACES an earlier `fixture-20-trailing-slash-token-still-strict`
// that asserted a FILE at a trailing-slash path stays not-found. That assertion
// held for a reason OUTSIDE the validator: `join()` preserves the trailing slash,
// and lstat("<path>/") on a file is rejected by the KERNEL with ENOTDIR before any
// predicate runs. It therefore survived every mutation of the logic it claimed to
// pin — a check that could not discriminate.
//
// Note on the `!isDir` conjunct guarding the second pass: it is provably INERT
// (that pass's predicate is a subset of pass 1's over the same candidate list),
// so NO fixture can pin it — widening it to `true` changes 0 of 486 disk-config ×
// token-shape × kind rows, on a harness that reports 32 differing rows when the
// pass is disabled. (32 is the control for the CURRENT, extension-bounded code;
// it was 48 pre-bound, and an earlier revision of this note quoted that figure.)
// It is kept as documented defense-in-depth, not as covered logic. See the second
// pass in validate-xref-integrity.mjs.
//
// Discriminating (both verified by mutation):
//   - pass-1 predicate `isDir ? st.isDirectory() : st.isFile()` → `st.isFile()`
//     ⇒ RED (not-found: the directory no longer satisfies the token)
//   - `const isDir = token.endsWith("/")` → `false`
//     ⇒ RED (resolves via the fallback and arrives WITH looseDirMatch)
{
  const tmp = join(tmpdir(), `xref-fix-20-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "x"), "file at candidate-1\n");
    mkdirSync(join(tmp, "x"), { recursive: true }); // directory at candidate-2
    const result = resolveRefToken("x/", tmp, "a.md", "backtick");
    check(
      "fixture-20-trailing-slash-token-resolves-strictly-unlabelled",
      result.ok === true &&
        result.looseDirMatch !== true &&
        String(result.resolvedPath).replace(/\/+$/, "") === join(tmp, "x"),
      `got result=${JSON.stringify(result)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-21-absent-by-design-skipped-only-in-declared-source
// ------------------------------------------------------------------
// The absent-by-design allowlist is SOURCE-SCOPED: sanctioned in the file whose
// prose establishes the token, still dangling anywhere else. Both polarities,
// so the carve-out can never decay into blanket token suppression.
{
  const declared = {
    kind: "backtick",
    token: "bin/dev",
    source: ".claude/skills/10-deployment-git/docker-dev-env-patterns.md",
  };
  const undeclared = { kind: "backtick", token: "bin/dev", source: ".claude/rules/zero-tolerance.md" };
  check(
    "fixture-21-absent-by-design-skipped-only-in-declared-source",
    isSanctionedAbsentRef(declared) === true && isSanctionedAbsentRef(undeclared) === false,
    `declared=${isSanctionedAbsentRef(declared)} undeclared=${isSanctionedAbsentRef(undeclared)}`,
  );
}

// ------------------------------------------------------------------
// fixture-22-absent-by-design-unknown-token-not-sanctioned
// ------------------------------------------------------------------
// A token absent from the allowlist is never sanctioned, even from a file that
// legitimately carries other carve-outs.
{
  const other = {
    kind: "backtick",
    token: "bin/definitely-not-allowlisted",
    source: ".claude/skills/10-deployment-git/docker-dev-env-patterns.md",
  };
  check(
    "fixture-22-absent-by-design-unknown-token-not-sanctioned",
    isSanctionedAbsentRef(other) === false,
    `got ${isSanctionedAbsentRef(other)}`,
  );
}

// ------------------------------------------------------------------
// fixture-23-extension-bearing-token-not-satisfied-by-directory
// ------------------------------------------------------------------
// The slash-less directory fallback is bounded to EXTENSION-LESS tokens. A token
// written `ghost.md` states its type in its own name, so a DIRECTORY named
// `ghost.md` must NOT retire it — it stays dangling and keeps driving the exit
// code. Without the bound, a real dangling ref would go quiet the moment a
// same-named directory appeared.
//
// BIPOLAR by construction: the extension-less arm must still resolve via the
// fallback in the SAME tree, so a dead fallback cannot make the first arm pass
// for the wrong reason.
//
// Discriminating: drop `!hasFileExtension(token)` from the second-pass condition
// ⇒ RED (the `ghost.md` arm resolves with looseDirMatch instead of not-found).
{
  const tmp = join(tmpdir(), `xref-fix-23-${Date.now()}`);
  try {
    mkdirSync(join(tmp, ".claude", "ghost.md"), { recursive: true }); // directory named like a file
    mkdirSync(join(tmp, ".claude", "ghostdir"), { recursive: true }); // extension-less directory
    const extBearing = resolveRefToken("ghost.md", tmp, "a.md", "backtick");
    const extLess = resolveRefToken("ghostdir", tmp, "a.md", "backtick");
    check(
      "fixture-23-extension-bearing-token-not-satisfied-by-directory",
      extBearing.ok === false &&
        extBearing.reason === "not-found" &&
        extLess.ok === true &&
        extLess.looseDirMatch === true,
      `extBearing=${JSON.stringify(extBearing)} extLess=${JSON.stringify(extLess)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// fixture-24-file-extension-classifier
// ------------------------------------------------------------------
// The classifier the bound above rests on: a dot past position 0 in the LAST
// path segment is an extension; a leading dot is not (`journal/.pending`,
// `.claude`), and a dotless segment is extension-less. Pinned directly so the
// bound cannot be silently widened by a regex/indexing tweak.
{
  check(
    "fixture-24-file-extension-classifier",
    hasFileExtension("rules/foo.md") === true &&
      hasFileExtension("bin/x.mjs") === true &&
      hasFileExtension("ghost.md") === true &&
      hasFileExtension("skills/45-genesis-bootstrap") === false &&
      hasFileExtension(".claude/hooks/lib") === false &&
      hasFileExtension("journal/.pending") === false &&
      hasFileExtension("audit-fixtures/exact-gate-tracking") === false,
    `file-extension classifier broken`,
  );
}

// ------------------------------------------------------------------
// fixture-25-deferral-declaration-is-block-scoped-not-line-scoped
// ------------------------------------------------------------------
// A Trust-Posture-Wiring bullet is routinely HARD-WRAPPED, so the physical line
// carrying the fixture token often does NOT carry the deferral declaration two
// lines above it. A line-scoped guard therefore reported a legitimately
// sanctioned reference as a dangling defect — a FALSE NEGATIVE that corrupts the
// signal in the direction that hides real defects. Pinned against the real shape
// (wave-loop.md's MUST-6/7 bullet), not a paraphrase.
//
// BIPOLAR: the same finding WITHOUT blockText (the old line-scoped view) must
// still come back false, so a guard that sanctioned everything cannot pass this.
{
  const lines = [
    "- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects the",
    "  transcript for an idle-wait window (MUST-6). Phase 2 (deferred per",
    "  `rules/trust-posture.md` § Two-Phase Rollout): advisory Stop-event detector + audit fixtures at",
    "  `.claude/audit-fixtures/wave-loop/orchestration-hygiene/` per `rules/cc-artifacts.md` Rule 9.",
  ];
  const blockOf = computeBlockTexts(lines);
  const token = ".claude/audit-fixtures/wave-loop/orchestration-hygiene/";
  const wrapped = {
    kind: "backtick",
    token,
    lineText: lines[3],
    blockText: blockOf[3],
  };
  const lineOnly = { kind: "backtick", token, lineText: lines[3] };
  check(
    "fixture-25-deferral-declaration-is-block-scoped-not-line-scoped",
    isSanctionedDeferredFixture(wrapped) === true &&
      isSanctionedDeferredFixture(lineOnly) === false,
    `wrapped=${isSanctionedDeferredFixture(wrapped)} lineOnly=${isSanctionedDeferredFixture(lineOnly)}`,
  );
}

// ------------------------------------------------------------------
// fixture-26-deferral-declared-by-fixtures-land-with-phrasing
// ------------------------------------------------------------------
// hook-output-discipline.md MUST-5(a) declares its deferral in the cc-artifacts
// Rule 9 phrasing ("Audit fixtures land WITH that check at …") and NEVER in the
// literal `Phase 2 (deferred` form — while the SAME line contains the string
// "Phase 2 is NOT deferred" for its sibling half. So the accepted second form
// must key on the land-with phrasing; a regex widened to chase `Phase 2` near
// `deferr` would match the DISCLAIMER and sanction the wrong thing.
//
// BIPOLAR: the disclaimer-only arm must NOT be accepted.
{
  const declaring =
    "The (a) half is this clause's ONE genuine **Phase 2** deferral. " +
    "Audit fixtures land WITH that check at `.claude/audit-fixtures/parsed-signal-detector/` " +
    "per `cc-artifacts.md` Rule 9; no fixtures are claimed now.";
  const disclaimerOnly =
    "**Phase 2 is NOT deferred-pending-a-detector for the (b) half**, and this " +
    "clause may not file one; see the audit fixtures discussion above.";
  const token = ".claude/audit-fixtures/parsed-signal-detector/";
  check(
    "fixture-26-deferral-declared-by-fixtures-land-with-phrasing",
    isSanctionedDeferredFixture({ kind: "backtick", token, blockText: declaring }) === true &&
      isSanctionedDeferredFixture({ kind: "backtick", token, blockText: disclaimerOnly }) === false,
    `declaring=${isSanctionedDeferredFixture({ kind: "backtick", token, blockText: declaring })} ` +
      `disclaimerOnly=${isSanctionedDeferredFixture({ kind: "backtick", token, blockText: disclaimerOnly })}`,
  );
}

// ------------------------------------------------------------------
// fixture-27-positive-allowlist-remains-the-binding-constraint
// ------------------------------------------------------------------
// Widening HOW a deferral may be declared must not widen WHICH slugs may be
// sanctioned. An UNLISTED slug stays dangling even under a perfect declaration
// (otherwise a genuinely-missing fixture dir could hide behind the carve-out),
// and a LISTED slug stays dangling without one. Both directions pinned.
{
  const perfect =
    "Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — " +
    "audit fixtures land with the Phase-2 detector at that path.";
  const unlisted = isSanctionedDeferredFixture({
    kind: "backtick",
    token: ".claude/audit-fixtures/totally-made-up-slug/",
    blockText: perfect,
  });
  const listedNoDeclaration = isSanctionedDeferredFixture({
    kind: "backtick",
    token: ".claude/audit-fixtures/path-containment/",
    blockText: "see the fixtures directory for detail",
  });
  const listedWithDeclaration = isSanctionedDeferredFixture({
    kind: "backtick",
    token: ".claude/audit-fixtures/path-containment/",
    blockText: perfect,
  });
  check(
    "fixture-27-positive-allowlist-remains-the-binding-constraint",
    unlisted === false && listedNoDeclaration === false && listedWithDeclaration === true,
    `unlisted=${unlisted} listedNoDeclaration=${listedNoDeclaration} listedWithDeclaration=${listedWithDeclaration}`,
  );
}

// ------------------------------------------------------------------
// fixture-28-a-block-does-not-borrow-a-neighbouring-bullets-declaration
// ------------------------------------------------------------------
// Block-scoping widens the guard's view from one line to one bullet. It must NOT
// widen it to the whole document: a token cited in a bullet that declares
// nothing must stay dangling even when the ADJACENT bullet declares a deferral.
// Both tokens here are on the allowlist, so only the block boundary separates
// them — which is exactly the property under test.
{
  const lines = [
    "- **Detection mechanism:** Phase 2 (deferred per rollout) — audit fixtures land",
    "  with the detector at `.claude/audit-fixtures/path-containment/`.",
    "- **Violation scope:** the clause only; see `.claude/audit-fixtures/tenant-upsert-guard/`.",
  ];
  const blockOf = computeBlockTexts(lines);
  const declared = isSanctionedDeferredFixture({
    kind: "backtick",
    token: ".claude/audit-fixtures/path-containment/",
    blockText: blockOf[1],
  });
  const neighbour = isSanctionedDeferredFixture({
    kind: "backtick",
    token: ".claude/audit-fixtures/tenant-upsert-guard/",
    blockText: blockOf[2],
  });
  check(
    "fixture-28-a-block-does-not-borrow-a-neighbouring-bullets-declaration",
    declared === true && neighbour === false,
    `declared=${declared} neighbour=${neighbour} block2=${JSON.stringify(blockOf[2])}`,
  );
}

// ------------------------------------------------------------------
// fixture-29-a-typo-of-a-real-deferred-slug-stays-visible
// ------------------------------------------------------------------
// THE property this carve-out exists to preserve, pinned against the cheaper
// design that was proposed and rejected: ONE batched entry sanctioning any
// `audit-fixtures/*` cited in a Phase-2-declaring block. That variant is
// indistinguishable from this one on CORRECT references and absorbs every TYPO,
// because a typo appears in exactly the same prose as the thing it misspells.
//
// It matters here more than it looks: `detection-binding-check.mjs` classifies a
// typo'd deferred path as `deferred-fixtures-absent` (reported, NOT fatal) just
// like a correct one — its positive allowlist is over binding NAMESPACES, not
// slugs. So this enumeration is the only place in the corpus where a misspelled
// deferred fixture path is still visible. Loosen it and nothing else catches it.
//
// Discriminating: drop the SANCTIONED_DEFERRED_FIXTURES membership test (i.e.
// adopt the batched design) ⇒ every typo arm below flips to sanctioned ⇒ RED.
{
  const declaring =
    "- **Detection mechanism:** Phase 2 (deferred per `trust-posture.md` § Two-Phase " +
    "Rollout) — no hook detector; audit fixtures land with the Phase-2 detector there.";
  const sanctioned = (token) =>
    isSanctionedDeferredFixture({ kind: "backtick", token, blockText: declaring });

  // Correct spellings of real, currently-deferred slugs: sanctioned.
  const correct =
    sanctioned(".claude/audit-fixtures/tenant-upsert-guard/") &&
    sanctioned(".claude/audit-fixtures/path-containment/") &&
    sanctioned(".claude/audit-fixtures/handoff-completion/");
  // One-character corruptions of those SAME slugs, in the SAME prose: NOT sanctioned.
  const typosVisible =
    !sanctioned(".claude/audit-fixtures/tenant-upsert-gaurd/") &&
    !sanctioned(".claude/audit-fixtures/path-contaiment/") &&
    !sanctioned(".claude/audit-fixtures/handoff-completeion/");

  check(
    "fixture-29-a-typo-of-a-real-deferred-slug-stays-visible",
    correct === true && typosVisible === true,
    `correct=${correct} typosVisible=${typosVisible}`,
  );
}

// ------------------------------------------------------------------
// fixture-30-extract-tokens-supplies-the-block-scoped-declaration
// ------------------------------------------------------------------
// fixtures 25/27/28 all exercise `isSanctionedDeferredFixture` against a
// `blockText` the FIXTURE hand-builds by calling `computeBlockTexts` itself. That
// pins the CONSUMER and leaves the PRODUCER unpinned: nothing asserted that
// `extractTokens` actually attaches the enclosing block to the finding it emits.
// Measured: degrading `extractTokens`'s `computeBlockTexts(lines)` to a per-line
// map executed 17 times during this suite and reddened nothing — the block-scoped
// guard would have silently reverted to the line-scoped behaviour that fixture-25
// exists to prevent, with the whole suite green.
//
// So this fixture runs the REAL extractor end-to-end over a hard-wrapped Wiring
// bullet and asserts the finding it produces is sanctioned. BIPOLAR: the same
// token in a bullet that names audit fixtures but declares NO deferral must come
// back unsanctioned, so a producer that stapled a permissive block onto every
// finding could not pass either.
{
  const wrapped = [
    "- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects the",
    "  transcript for an idle-wait window (MUST-6). Phase 2 (deferred per",
    "  `rules/trust-posture.md` § Two-Phase Rollout): advisory Stop-event detector at",
    "  `.claude/audit-fixtures/wave-loop/orchestration-hygiene/` per `rules/cc-artifacts.md` Rule 9.",
  ].join("\n");
  // Same token, same "audit fixtures" vocabulary, NO deferral declaration.
  const undeclared = [
    "- **Detection mechanism:** Phase 1 (manual, gate-review) — reviewer inspects the",
    "  transcript for an idle-wait window (MUST-6), with audit fixtures at",
    "  `.claude/audit-fixtures/wave-loop/orchestration-hygiene/` per `rules/cc-artifacts.md` Rule 9.",
  ].join("\n");
  const TOKEN = ".claude/audit-fixtures/wave-loop/orchestration-hygiene/";
  const pick = (text) =>
    extractTokens(text, ".claude/rules/wave-loop.md").find((f) => f.token === TOKEN);

  const declared = pick(wrapped);
  const bare = pick(undeclared);

  check(
    "fixture-30-extract-tokens-supplies-the-block-scoped-declaration",
    !!declared &&
      !!bare &&
      isSanctionedDeferredFixture(declared) === true &&
      isSanctionedDeferredFixture(bare) === false,
    `declared=${declared && isSanctionedDeferredFixture(declared)} bare=${bare && isSanctionedDeferredFixture(bare)}`,
  );
}

// ------------------------------------------------------------------
process.stdout.write(`\n${passed}/${passed + failed} fixtures pass\n`);
process.exit(failed === 0 ? 0 : 1);
