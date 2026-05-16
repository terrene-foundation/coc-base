/**
 * Classify a commit by literal pattern matching for journal candidacy.
 *
 * Returns: {type, skipReason}
 *   - type: "DECISION" | "DISCOVERY" | "RISK" — generate a stub
 *   - type: null + skipReason: <slug> — skip; caller logs to .journal-skipped.log
 *
 * Tightening philosophy (issue #114):
 *   The previous classifier matched ANY `^feat(\(|:)` subject as DECISION,
 *   producing a stub on every feature commit even when the commit body
 *   already preserved the full institutional content. Across 17 days of
 *   multi-CLI work the multi-cli-coc workspace accumulated 79 stubs whose
 *   value content was already in `git log`. This file replaces the broad
 *   subject-keyword match with body-anchored novelty checks plus a
 *   first-pass skip-list for commits known to be verbatim-in-git-log.
 *
 * Skip taxonomy (returned in skipReason):
 *   merge-commit       Merge SHA from `git merge`; the merged branch's
 *                      commits already triggered classification on their
 *                      own and the merge contributes no novel content.
 *   version-bump       Subject matches `bump`/`release`/`vX.Y.Z` — pure
 *                      version anchor edit, no design content.
 *   coc-housekeeping   `chore(coc): land telemetry drift|sync|delivery` —
 *                      mechanical artifact pipeline movement.
 *   style-only         `^style(\(|:)` — formatter / linter output only.
 *   chore-routine      `^chore(\(|:)` with no body decision-language.
 *   docs-routine       `^docs?(\(|:)` with no body decision-language and
 *                      no ADR/decisions path reference.
 *   test-routine       `^test(\(|:)` with no body decision-language.
 *   feat-no-novel-body `^feat(\(|:)` whose body has no decision-language
 *                      and is short (<100 chars trimmed).
 *   fix-routine        `^fix(\(|:)` not matching the narrow subtle-bug
 *                      regex AND no body discovery-language.
 *   no-match           Doesn't match any classifier pattern at all.
 */

function classifyCommitForJournal(subject, body) {
  const subjectStr = String(subject || "");
  const bodyStr = String(body || "");
  const subjectLower = subjectStr.toLowerCase();
  const bodyLower = bodyStr.toLowerCase();
  const bodyTrimmed = bodyStr.trim();
  const bodyIsSubstantive = bodyTrimmed.length >= 100;

  // ---- SKIP-FIRST: verbatim-in-git-log patterns ----
  // These NEVER need a stub regardless of body content because the commit
  // is mechanical and the git log preserves everything readers need.

  if (/^merge\s/i.test(subjectStr)) {
    return { type: null, skipReason: "merge-commit" };
  }

  // Version bumps: "chore: bump X to 1.2.3", "release v1.2.3", "chore(release): 1.2.3"
  if (
    /^(chore|release)(\([^)]*\))?:\s*(bump|release\b|v?\d+\.\d+\.\d+\b)/i.test(
      subjectStr,
    ) ||
    /^bump\s/i.test(subjectStr)
  ) {
    return { type: null, skipReason: "version-bump" };
  }

  // COC housekeeping: chore(coc) landing telemetry / sync / delivery
  if (
    /^chore\(coc\):\s*(land\s+telemetry|sync\b|land\s+\/sync|land\s+\S+\s+delivery)/i.test(
      subjectStr,
    )
  ) {
    return { type: null, skipReason: "coc-housekeeping" };
  }

  if (/^style(\(|:)/i.test(subjectStr)) {
    return { type: null, skipReason: "style-only" };
  }

  // ---- RISK: security / vulnerability material ----
  // Higher-bar than the previous classifier (which fired on bare "security"
  // anywhere). RISK now requires either (a) a CVE identifier, (b) the words
  // vulnerability/exploit/advisory, or (c) "security fix" or "security patch"
  // phrasing — all of which signal an actual security event rather than a
  // generic "this is security-related" sentence.
  const riskText = subjectLower + " " + bodyLower;
  if (
    /\bcve-\d{4}-\d+\b/i.test(riskText) ||
    /\b(vulnerability|exploit|advisory)\b/i.test(riskText) ||
    /\bsecurity\s+(fix|patch|hotfix|advisory)\b/i.test(riskText)
  ) {
    return { type: "RISK" };
  }

  // ---- DISCOVERY: subtle bug fixes (narrow subject pattern) ----
  // Race / leak / deadlock / corruption / data loss / regression — these
  // typically have hidden behaviour worth a journal write-up regardless of
  // body length, because the next session needs to know the failure mode.
  if (
    /^fix.*\b(race|leak|deadlock|corrupt|lost|regression)\b/i.test(subjectStr)
  ) {
    return { type: "DISCOVERY" };
  }

  // ---- BODY-ANCHORED DECISION ----
  // Only fire when the body is substantive (>=100 chars trimmed) AND
  // contains explicit decision-language. Short bodies are not novel; the
  // commit subject already says everything.
  if (
    bodyIsSubstantive &&
    /\b(decided|chose|trade-?off|alternative considered|rationale)\b/i.test(
      bodyLower,
    )
  ) {
    return { type: "DECISION" };
  }

  // ---- BODY-ANCHORED DISCOVERY ----
  if (
    bodyIsSubstantive &&
    /\b(discovered|found that|turns out|learned)\b/i.test(bodyLower)
  ) {
    return { type: "DISCOVERY" };
  }

  // ---- ADR / architecture decision document path ----
  // Touching docs/adr/ or specs/decisions/ implies a load-bearing decision.
  if (/(docs|specs)\/(adr|architecture|decisions)/i.test(bodyLower)) {
    return { type: "DECISION" };
  }

  // ---- Default skip with descriptive reason ----
  if (/^chore(\(|:)/i.test(subjectStr)) {
    return { type: null, skipReason: "chore-routine" };
  }
  if (/^docs?(\(|:)/i.test(subjectStr)) {
    return { type: null, skipReason: "docs-routine" };
  }
  if (/^test(\(|:)/i.test(subjectStr)) {
    return { type: null, skipReason: "test-routine" };
  }
  if (/^feat(\(|:)/i.test(subjectStr)) {
    return { type: null, skipReason: "feat-no-novel-body" };
  }
  if (/^fix(\(|:)/i.test(subjectStr)) {
    return { type: null, skipReason: "fix-routine" };
  }

  return { type: null, skipReason: "no-match" };
}

module.exports = { classifyCommitForJournal };
