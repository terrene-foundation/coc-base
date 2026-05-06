/**
 * violation-patterns — high-evidence regex/AST detectors for the 5 patterns shipped in v1.
 *
 * Mitigates red-team HIGH-8 (missing detection patterns). Each pattern grounded in an
 * existing rule with at least one origin-evidence date.
 *
 * Self-confession scanner (HIGH-2 mitigation): lexical match is ADVISORY-only;
 * never auto-downgrade purely on a regex hit. Behavioral signals belong to /redteam.
 */

const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Normalize any GitHub repo URL form to canonical "Org/Repo".
 *   "git@github.com:Org/Repo.git" → "Org/Repo"
 *   "https://github.com/Org/Repo.git" → "Org/Repo"
 *   "https://github.com/Org/Repo" → "Org/Repo"
 *   "Org/Repo" → "Org/Repo"
 * Returns null for unrecognized shapes.
 */
function normalizeRepoSlug(s) {
  if (!s || typeof s !== "string") return null;
  const cleaned = s
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  // Must look like Org/Repo (single slash separator, no path traversal).
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Read `git remote get-url upstream` from cwd, normalize to "Org/Repo".
 * Returns null if no upstream remote, git unavailable, or unrecognized URL.
 * Used by detectRepoScopeDriftBash (issue #36) to allow parent-product
 * writes from hierarchical-fork consumers (rs-axis client deployments,
 * USE-template-derived projects with documented upstream parents).
 */
function readUpstreamRemoteSlug(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "upstream"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
    return normalizeRepoSlug(url);
  } catch {
    return null;
  }
}

// 1. Pre-existing claim without SHA grounding (rules/zero-tolerance.md Rule 1c, 2026-05-01)
const PRE_EXISTING_CLAIM =
  /\b(pre[- ]existing|out of scope|not introduced (?:by|in) this (?:session|PR))\b/i;
const SHA_NEAR = /\b[0-9a-f]{7,12}\b/;

function detectPreExistingNoSha(text) {
  if (!text || typeof text !== "string") return null;
  const paragraphs = text.split(/\n\s*\n/);
  for (const p of paragraphs) {
    if (PRE_EXISTING_CLAIM.test(p) && !SHA_NEAR.test(p)) {
      return {
        rule_id: "zero-tolerance/Rule-1c",
        severity: "halt-and-report",
        evidence: p.slice(0, 400),
      };
    }
  }
  return null;
}

// 2. Repo-scope drift (rules/repo-scope-discipline.md, 2026-05-03)
const REPO_SCOPE_DRIFT_TEXT =
  /\b(next-turn pick|context-switch to|the higher-priority workstream lives in)\s*[:]?\s*[a-zA-Z][\w-]*(?:[#/][\w-]+)?/i;

function detectRepoScopeDriftText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(REPO_SCOPE_DRIFT_TEXT);
  if (m) {
    return {
      rule_id: "repo-scope-discipline/MUST-NOT-2",
      severity: "halt-and-report",
      evidence: m[0],
    };
  }
  return null;
}

function detectRepoScopeDriftBash(command, cwd) {
  if (!command || typeof command !== "string") return null;
  // gh ... --repo X (where X != cwd's repo)
  const m = command.match(/\bgh\b[^|;]*--repo\s+(?:["']?)([^\s"']+)(?:["']?)/);
  if (!m) return null;
  const targetRepo = m[1].replace(/^["']|["']$/g, "");
  // hook-output-discipline.md MUST-3: skip shell-variable references —
  // `payload.tool_input.command` is the pre-expansion string, so $REPO /
  // ${REPO} / $(...) / `...` cannot be evaluated at hook time.
  if (
    /^\$\{?\w+\}?$/.test(targetRepo) ||
    /\$\(/.test(targetRepo) ||
    /`/.test(targetRepo)
  ) {
    return null;
  }
  // Issue #36 — hierarchical-fork allowance.
  // Before the basename heuristic, check whether the target matches the
  // cwd repo's `upstream` remote. The hierarchical-fork pattern (a
  // coc-project that documents an upstream parent-product remote) is a
  // shipped COC pattern; some consumer rules MANDATE filing issues / PRs
  // against the parent-product. Allowing the upstream-remote match
  // closes the false-positive class on a structural signal (durable
  // git remote state on disk), not lexical regex.
  const targetSlug = normalizeRepoSlug(targetRepo);
  if (targetSlug) {
    const upstream = readUpstreamRemoteSlug(cwd);
    if (upstream && upstream === targetSlug) return null;
  }
  const cwdBase = path.basename(cwd || process.cwd());
  if (!targetRepo.includes(cwdBase)) {
    // hook-output-discipline.md MUST-2: lexical regex finding emits
    // halt-and-report, never block. Block requires structural signal.
    return {
      rule_id: "repo-scope-discipline/MUST-NOT-1",
      severity: "halt-and-report",
      evidence: `gh --repo ${targetRepo} from cwd basename ${cwdBase} (no upstream remote match)`,
    };
  }
  return null;
}

// 3. Worktree-drift: absolute path NOT prefixed by env-pinned worktree (rules/worktree-isolation.md, 2026-04-19)
function detectWorktreeDrift(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const pinned = process.env.CLAUDE_WORKTREE_PATH;
  if (!pinned) return null; // not in worktree mode
  if (filePath.startsWith("/") && !filePath.startsWith(pinned)) {
    return {
      rule_id: "worktree-isolation/MUST-1",
      severity: "block",
      evidence: `absolute path ${filePath} outside pinned worktree ${pinned}`,
    };
  }
  return null;
}

// 4. Commit-claim accuracy (rules/git.md "Commit-message claim accuracy")
//    PostToolUse(Bash) on `git commit -m "..."` — flag if message claims
//    deletion/refactor that the staged diff does not exhibit.
//    POC: detect the claim language; full diff verification is /redteam-shaped.
const COMMIT_CLAIM_LANG =
  /\b(deleted|removed|refactored|extracted|consolidated)\b/i;

function detectCommitClaim(command) {
  if (!command || typeof command !== "string") return null;
  const m = command.match(/git\s+commit[^|;]*-m\s+["']([^"']+)["']/);
  if (!m) return null;
  if (COMMIT_CLAIM_LANG.test(m[1])) {
    return {
      rule_id: "git/commit-message-claim-accuracy",
      severity: "advisory",
      evidence: `commit msg contains claim language: "${m[1].slice(0, 200)}"`,
    };
  }
  return null;
}

// 5. Sweep-completeness substitution (rules/sweep-completeness.md, 2026-05-04)
//    Heuristic: agent's final report claims `Sweep N: 0/0/0 (clean)` while
//    the session's command history contains a known cheap proxy
//    (cite-check, lint-only) without a corresponding mandated tool invocation.
const SWEEP_REPORT = /\bSweep\s+\d+\s*:\s*0\s*\/\s*0\s*\/\s*0\s*\(clean\)/i;
const SUBSTITUTION_LABEL = /\(substituted\b/i;

function detectSweepSubstitution(finalText) {
  if (!finalText || typeof finalText !== "string") return null;
  if (SWEEP_REPORT.test(finalText) && !SUBSTITUTION_LABEL.test(finalText)) {
    return {
      rule_id: "sweep-completeness/MUST-2",
      severity: "halt-and-report",
      evidence: finalText.match(SWEEP_REPORT)[0],
    };
  }
  return null;
}

// Self-confession scanner (HIGH-2: advisory-only, never auto-downgrade)
const SELF_CONFESSION =
  /\bI\s+(missed|forgot|didn't (?:fully|properly|actually)|skipped|should have (?:run|tested|checked|verified))/i;
const INCOMPLETE_LANG =
  /\b(incomplete (?:test|coverage|run)|tests?\s+were\s+incomplete|the\s+previous\s+(?:run|iteration)\s+was\s+incomplete)\b/i;

function detectSelfConfession(finalText) {
  if (!finalText || typeof finalText !== "string") return null;
  const m1 = finalText.match(SELF_CONFESSION);
  const m2 = finalText.match(INCOMPLETE_LANG);
  const hit = m1 || m2;
  if (hit) {
    return {
      rule_id: "test-completeness/PROVISIONAL",
      severity: "advisory", // NEVER block or downgrade on lexical match alone
      evidence: hit[0].slice(0, 200),
    };
  }
  return null;
}

// 7. Menu-without-pick (rules/recommendation-quality.md MUST-1, 2026-05-06)
//
// Detects: ≥2 option markers in agent prose without a recommendation anchor.
// Severity: advisory (lexical regex match — per hook-output-discipline.md
//   MUST-2, lexical signals MUST NOT carry severity:block).
// Cumulative tracking: violations accumulate in violations.jsonl; trust-posture
//   downgrade triggers per rules/trust-posture.md MUST Rule 4 (5× total in 30d).
//
// Option markers (≥2 required):
//   "Option A:" / "Option B:" / ... (newline-anchored, lowercase variants too)
//   "(a)" / "(b)" / "(c)" / "(d)" — bulleted list-letter form
//   "[a]" / "[b]" / "[c]" / "[d]" — bracketed list-letter form
//
// Recommendation anchor (presence cancels the finding):
//   "Recommend:" / "I recommend" / "My recommendation" / "Going with"
//   / "Pick:" / "My pick" / "I'd go with" / "I suggest going with"
//   / "I'm going with" / "My choice"
const MENU_OPTION_MARKERS = [
  /^\s*\*?\*?Option [A-D]\b/gim, // "Option A", "**Option B**", indented
  /(?:^|\s)\([a-d]\)\s/gm, // "(a) ", " (b) "
  /(?:^|\s)\[[a-d]\]\s/gm, // "[a] ", " [b] "
];
const RECOMMENDATION_ANCHOR =
  /\b(I\s+recommend\b|I'm\s+recommending\b|Recommend:|Recommended\s+option:|Recommendation:|My\s+recommendation|Going\s+with\b|My\s+pick:|Pick:|I'd\s+go\s+with\b|I\s+suggest\s+going\s+with\b|I'm\s+going\s+with\b|My\s+choice:|I\s+choose\b)/i;

function detectMenuWithoutPick(text) {
  if (!text || typeof text !== "string") return null;

  // Sum option-marker hits across the three patterns.
  let totalMarkers = 0;
  const evidenceSamples = [];
  for (const re of MENU_OPTION_MARKERS) {
    const matches = [...text.matchAll(re)];
    totalMarkers += matches.length;
    for (const m of matches.slice(0, 2)) evidenceSamples.push(m[0].trim());
  }
  if (totalMarkers < 2) return null;

  // Recommendation anchor present → not a menu-without-pick
  if (RECOMMENDATION_ANCHOR.test(text)) return null;

  return {
    rule_id: "recommendation-quality/MUST-1",
    severity: "advisory", // lexical only; per hook-output-discipline.md MUST-2
    evidence: evidenceSamples.slice(0, 4).join(" / "),
  };
}

// 8. Regex-for-semantic-assertion (rules/probe-driven-verification.md MUST-1, 2026-05-06)
//
// Detects: regex/keyword/substring matching against assistant-prose-shaped
// inputs in test/harness contexts. Heuristic — surfaces candidates for
// human adjudication (advisory). Cannot perfectly distinguish structural
// from semantic; the function-name heuristic is conservative.
//
// Severity: advisory (lexical detector per hook-output-discipline.md MUST-2).
// Trigger: source contains BOTH:
//   - a regex/grep pattern (re.search, re.match, grep -E, str.contains, /…/.test, .match, .search)
//   - inside a function whose name suggests semantic verification
//     (verify_*, score_*, assert_*, check_*, probe_* AND any of:
//      recommendation, refusal, compliance, response, intent, semantic, quality)
const REGEX_API_PATTERNS = [
  /\bre\.(search|match|findall)\(/,
  /\bstr\.(contains|matches)\b/,
  /\bgrep\s+(-E|-P)/,
  /\.match\(['"`/]/,
  /\.test\(['"`/]/,
];
const SEMANTIC_FN_NAME =
  /\b(verify|score|assert|check|probe)_\w*?(recommend|refus|complian|respons|intent|semantic|quality|outcome|narrative|reasoning)/i;

function detectRegexForSemanticAssertion(source, filePath) {
  if (!source || typeof source !== "string") return null;
  if (
    !/(\.test|tests?\/|test-harness|suites|audit-fixture)/.test(filePath || "")
  )
    return null;
  const lines = source.split("\n");
  const findings = [];
  let inSemanticFn = false;
  let fnStartLine = 0;
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      SEMANTIC_FN_NAME.test(line) &&
      /\bdef\b|\bfunction\b|=>\s*\{?/.test(line)
    ) {
      inSemanticFn = true;
      fnStartLine = i + 1;
      braceDepth = 0;
    }
    if (inSemanticFn) {
      braceDepth +=
        (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      for (const re of REGEX_API_PATTERNS) {
        if (re.test(line)) {
          findings.push({
            line: i + 1,
            fnLine: fnStartLine,
            snippet: line.trim().slice(0, 120),
          });
          break;
        }
      }
      if (braceDepth <= 0 && i > fnStartLine + 1) inSemanticFn = false;
    }
  }
  if (findings.length === 0) return null;
  return {
    rule_id: "probe-driven-verification/MUST-1",
    severity: "advisory",
    evidence: findings
      .slice(0, 3)
      .map((f) => `L${f.line}: ${f.snippet}`)
      .join(" | "),
  };
}

module.exports = {
  detectPreExistingNoSha,
  detectRepoScopeDriftText,
  detectRepoScopeDriftBash,
  detectWorktreeDrift,
  detectCommitClaim,
  detectSweepSubstitution,
  detectSelfConfession,
  detectMenuWithoutPick,
  detectRegexForSemanticAssertion,
};
