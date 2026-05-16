/**
 * violation-patterns — high-evidence regex/AST detectors for the 5 patterns shipped in v1.
 *
 * Mitigates red-team HIGH-8 (missing detection patterns). Each pattern grounded in an
 * existing rule with at least one origin-evidence date.
 *
 * Self-confession scanner (HIGH-2 mitigation): lexical match is ADVISORY-only;
 * never auto-downgrade purely on a regex hit. Behavioral signals belong to /redteam.
 */

const fs = require("fs");
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

/**
 * Resolve the git repo root from cwd. Structural (git toplevel), 500ms
 * cap — same posture as readUpstreamRemoteSlug.
 */
function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
  } catch {
    return null;
  }
}

// Bounds stale-receipt reuse across sessions: an authorizing journal
// receipt only clears a cross-repo write if written within this window
// (repo-scope-discipline.md User-Authorized Exception condition 5 —
// scoped to ONE action; a days-old receipt MUST NOT authorize).
const CROSS_REPO_RECEIPT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Structural in-scope signal for repo-scope-discipline.md
 * § User-Authorized Exception condition 4: a cross-repo write PRECEDED
 * by an authorizing journal receipt is in-scope by definition. The
 * receipt is a journal entry containing the greppable marker line
 * `cross-repo-authorized: <owner/repo>` for the exact target slug,
 * written recently (within the window). Durable on-disk signal — same
 * structural class as readUpstreamRemoteSlug's git-remote allowance,
 * NOT lexical agent prose. Scans repo-root journal/ + workspace
 * journals (incl. .pending), mtime-bounded, content-marker matched.
 */
function hasCrossRepoAuthorizationReceipt(targetSlug, cwd) {
  if (!targetSlug) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  const marker = `cross-repo-authorized: ${targetSlug}`;
  const now = Date.now();
  const dirs = [path.join(root, "journal")];
  try {
    const wsRoot = path.join(root, "workspaces");
    for (const e of fs.readdirSync(wsRoot, { withFileTypes: true })) {
      if (
        e.isDirectory() &&
        e.name !== "instructions" &&
        !e.name.startsWith("_")
      ) {
        dirs.push(path.join(wsRoot, e.name, "journal"));
        dirs.push(path.join(wsRoot, e.name, "journal", ".pending"));
      }
    }
  } catch {
    /* no workspaces/ — repo-root journal/ only */
  }
  for (const d of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      const fp = path.join(d, f.name);
      try {
        if (now - fs.statSync(fp).mtimeMs > CROSS_REPO_RECEIPT_WINDOW_MS) {
          continue; // stale — bounds cross-session reuse
        }
        if (fs.readFileSync(fp, "utf8").includes(marker)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
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
    // repo-scope-discipline.md § User-Authorized Exception condition 4:
    // a cross-repo write PRECEDED by an authorizing journal receipt is
    // in-scope by definition. Structural durable-on-disk signal (journal
    // marker `cross-repo-authorized: <slug>`), not lexical prose —
    // mirrors the upstream-remote allowance above. Closes the journal
    // 0077/0078 gap where a properly-authorized action still tripped
    // the trust-posture L1 critical downgrade.
    if (hasCrossRepoAuthorizationReceipt(targetSlug, cwd)) return null;
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
  /\b(I\s+recommend\b|I'm\s+recommending\b|Recommend:|Recommended\s+option:|Recommendation:|My\s+recommendation|Going\s+with\b|My\s+pick:|Pick:|I'd\s+go\s+with\b|I\s+suggest\s+going\s+with\b|I'm\s+going\s+with\b|My\s+choice:|I\s+choose\b|Leaning\s+toward\b|Best\s+path\s+forward\s+is\b|Pragmatic\s+call\s+is\b|Default\s+is\s+to\s+take\b|Will\s+start\s+with\b|Going\s+to\s+start\s+with\b|Taking\s+the\b|Picking\s+up\b|Obvious\s+next\s+step\s+is\b|Inclined\s+to\b|I\s+think\s+we\s+should\b|The\s+right\s+call\s+(here\s+)?is\b|Most\s+sensible\s+is\b|Optimal\s+pick\s+is\b|Pretty\s+clear\s+we\b|Path\s+of\s+least\s+resistance\b|Sensible\s+default\s+is\b)/i;

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

// 9. Time-pressure procedure-drop (rules/time-pressure-discipline.md, 2026-05-07)
//
// Two detection modes against a single rule:
//   mode="input": UserPromptSubmit-event scan of user prompt for pressure
//     framings ("speed up", "running out of time", "deadline is looming",
//     "ship it now", "skip the validation", etc.). When found, the hook
//     wires an advisory additionalContext that primes the agent to respond
//     per rule MUST-5 — no violation logged (framing detection is a PRIME,
//     not a violation; the violation is the agent's procedure-drop response).
//   mode="response": Stop-event scan of agent's final report for explicit
//     procedure-drop language ("skipping /redteam", "--no-verify", "defer
//     the fix", "won't add regression test", etc.) UNLESS the response
//     also carries a parallelization/prioritization anchor ("parallelize",
//     "wave of N", "prioritized list", "surface the priority"). When found
//     without anchor → violation logged as advisory.
//
// Severity: advisory in both modes (lexical regex on prose per
//   hook-output-discipline.md MUST-2 — block requires structural signal).
// Cumulative tracking: response-mode findings accumulate in violations.jsonl;
//   trust-posture downgrade per trust-posture.md MUST Rule 4 (5× total in
//   30d). New emergency-trigger time_pressure_procedure_drop adds 1× per
//   incident → drop 1 posture.
const PRESSURE_FRAMINGS = [
  /\bspeed (?:this|it|things) up\b/i,
  /\b(?:running|run) out of time\b/i,
  /\beveryone'?s? waiting\b/i,
  /\b(?:past|over|behind) (?:the )?(?:due date|deadline|due)\b/i,
  /\bdeadline (?:is )?looming\b/i,
  /\bship (?:it|this) (?:now|today|tonight|asap|by EO[DW])\b/i,
  /\bskip (?:the |all )?(?:validation|tests?|redteam|review|gate|checks?|regression test)/i,
  /\bwe need to (?:ship|merge|deploy|land) (?:today|now|tonight|asap|by EO[DW])\b/i,
  /\brush (?:this|it)\b/i,
  /\bfast[- ]?track\b/i,
  /\bno time (?:to|for)\b/i,
  /\bjust pick (?:the most important|one|the top)\b/i,
];
const PROCEDURE_DROP_LANGUAGE = [
  /\bskip(?:ping)?\s+(?:\/redteam|the redteam|the validation|the regression test|the gate|the tests?|gate-review)\b/i,
  /\bgit commit[^|;]*--no[- ]?verify\b/i,
  // --no-verify can't anchor with \b on the leading side (- is non-word
  // and the preceding char is usually whitespace, also non-word, so \b
  // fails). Use lookbehind for start-or-non-word-char-non-dash instead.
  /(?:^|[\s,;])--no[- ]?verify\b/i,
  /\b(?:defer(?:ring)?|deferred) (?:this|the) (?:fix|finding|issue|gap|same-class)\b/i,
  /\bwon'?t add (?:a )?regression test\b/i,
  /\bshortcut(?:ting|ed)?\s+(?:this|here|the (?:procedure|process))\b/i,
  /\bone[- ]?time exception\b/i,
  /\bship(?:ping)? (?:without|with no) (?:the )?(?:redteam|validation|regression|test)/i,
  /\b(?:file|filing) (?:a |the )?follow[- ]?up (?:issue|PR|ticket) (?:instead|rather than)\b/i,
];
const PARALLELIZATION_ANCHOR =
  /\b(paralleliz|wave of \d|prioritized list|prioritization|surface (?:a |the )?priorit|authorize the parallel|parallel (?:specialist |worktree |dispatch))/i;

function detectTimePressureShortcut(text, opts) {
  if (!text || typeof text !== "string") return null;
  const mode = (opts && opts.mode) || "input";
  if (mode === "input") {
    for (const re of PRESSURE_FRAMINGS) {
      const m = text.match(re);
      if (m) {
        return {
          rule_id: "time-pressure-discipline/MUST-1",
          severity: "advisory",
          evidence: m[0].slice(0, 120),
          // Hint to the wiring layer: framing-mode finding is a PRIME (inject
          // additionalContext to the agent), NOT a violation log.
          mode: "input",
        };
      }
    }
    return null;
  }
  // mode === "response": flag procedure-drop language ONLY when the response
  // does NOT also carry a parallelization/prioritization anchor. The anchor
  // is the structural signal that the agent surfaced the right alternative.
  if (PARALLELIZATION_ANCHOR.test(text)) return null;
  const evidenceSamples = [];
  for (const re of PROCEDURE_DROP_LANGUAGE) {
    const m = text.match(re);
    if (m) evidenceSamples.push(m[0].slice(0, 120));
    if (evidenceSamples.length >= 3) break;
  }
  if (evidenceSamples.length === 0) return null;
  return {
    rule_id: "time-pressure-discipline/MUST-2",
    severity: "advisory",
    evidence: evidenceSamples.join(" | "),
    mode: "response",
  };
}

// 10. Streetlight selection (rules/value-prioritization.md MUST-1, 2026-05-07)
//
// Detects: response surfaces ≥2 candidate items AND picks one using
// fittability-anchor language WITHOUT a user-anchored value-rank citation.
// Severity: advisory (lexical detector per hook-output-discipline.md MUST-2).
// Mode: response (Stop event scan of agent's final report).
//
// Required co-occurrence (all three):
//   - candidate-set markers (≥2 items surfaced)
//   - pick anchor (RECOMMENDATION_ANCHOR)
//   - fittability-anchor language
// Cancelling signal (any one):
//   - value-anchor language (cites brief / spec § / journal DECISION / user-stated)
//   - explicit named trade-off ("higher-value per X; more fittable; recommend Y because")
const FITTABILITY_ANCHOR =
  /\b(fits?\s+(one\s+)?shard\b|fits?\s+the\s+shard\b|cheap\s*\(~|cheap\s+\(\d|regression-?locked\b|closes?\s+the\s+only\s+(open\s+)?(follow-?up|Week-\d+)|tracked\s+separately\b|no\s+grace\s+clock\b|carried-?forward\b|smallest\s+(blast\s+radius|scope)\b|latent\s+bug\s+fix\s+while\s+we'?re\s+here|out\s+of\s+scope\s+for\s+this\s+session\b|small\s+(first|wins\s+build\s+momentum)\b|build\s+momentum\b|achievable\s+one\b|easier\s+to\s+land\b|grace\s+deadline\s+approaching\b|or\s+(an\s+)?explicit\s+ADR\s+statement\b|tractable\s+(in\s+one\s+pass|shard)\b|scoped\s+down\s+to\b|narrow\s+blast\b|reviewable\s+diff\b|small\s+surface\b|well-?bounded\b|atomic\s+delivery\b|ergonomic\s+for\s+one\s+session\b|tighter\s+scope\b|more\s+compact\b|low\s+coordination\s+cost\b|dependency-?of-?the-?dependency\b|sequencing\s+dependencies\b|risk-?adjusted\s+value\b|delivery\s+probability\b|velocity\s+multiplier\b|small\s+wins\s+unlock\b|optionality\s+preservation\b|reversible\s+work\s+first\b)/i;
// Value-anchor presence anywhere is a WEAK cancel (decorative-anchor evasion);
// the strong cancel requires proximity-to-pick (Rule 1 named-trade-off form).
// `VALUE_ANCHOR_NEAR_PICK_RE` checks the ±200-char window around the
// recommendation anchor for a value-anchor cite.
const VALUE_ANCHOR =
  /\b(per\s+the\s+brief\b|per\s+brief\s+§|highest\s+user\s+value\b|user\s+prioriti[sz]ed\b|per\s+spec\s+§|delivers\s+value\s+to\s+the\s+user\b|forest-?vs-?trees\b|value-?anchor:|user-anchored\b|user'?s\s+(brief|stated)\b|primary\s+anchor:|user-?stated\s+(value|impact|preference)\b|per\s+journal\s+DECISION|user'?s\s+\d{4}-\d{2}-\d{2}\s+brief\b)/i;
const NAMED_TRADEOFF =
  /\b(higher-?value\s+per\b[\s\S]{0,80}?(more\s+fittable|smaller|cheaper|more\s+compact|tighter)|alternative\s+is\s+to\s+shard\b|recommend\s+\w+\s+because\b[\s\S]{0,80}?(alternative|cost\s+is)|cost\s+is\s+one\s+more\s+session)/i;
// Candidate-set markers — broader than MENU_OPTION_MARKERS (also catches
// numbered candidate lists "1. X (HIGH) ... 2. Y (LOW)", "Two options:"
// headers, "Candidates:" headers, and bulleted candidate lists where each
// bullet introduces a named workstream). Each marker emits its own match;
// the detector requires ≥2 total marker hits across patterns OR ≥1 header
// match (since a header implies the list that follows IS a candidate set).
const CANDIDATE_SET_MARKERS = [
  /^\s*\*?\*?Option [A-D]\b/gim,
  /(?:^|\s)\([a-d]\)\s/gm,
  /(?:^|\s)\[[a-d]\]\s/gm,
  // Numbered candidate list with priority/value tag in parentheses
  /^\s*\d+\.\s+[^\n]{4,}\((HIGH|MED|LOW|MEDIUM|HIGH-VALUE|LOW-VALUE)\)/gim,
  // "Candidates:" / "Candidate workstreams:" / "Candidate items:" headers
  /^\s*Candidate(s|\s+(workstreams?|items?|tasks?|shards?|PRs?|follow-?ups?))\s*:/gim,
  // "Two|Three|Four|Five|Several options:" / "options:" / "paths:" headers
  // followed by an enumerated list — common streetlight surface. Accepts
  // optional intervening qualifier word (today, right now, in flight,
  // currently, eligible, here) before the colon.
  /^\s*(Two|Three|Four|Five|Six|Several|Multiple)\s+(options?|candidates?|paths?|choices?|items?|carried-?forward\s+items?|follow-?ups?|workstreams?|shards?|tasks?|PRs?)(\s+(today|right\s+now|in\s+flight|currently|eligible|here|are\s+eligible))?\s*:/gim,
];
// Header markers count as candidate-set evidence on their own.
const CANDIDATE_SET_HEADER_RE =
  /^\s*(Two|Three|Four|Five|Six|Several|Multiple)\s+(options?|candidates?|paths?|choices?|items?|carried-?forward\s+items?|follow-?ups?|workstreams?|shards?|tasks?|PRs?)(\s+(today|right\s+now|in\s+flight|currently|eligible|here|are\s+eligible))?\s*:/im;

function detectStreetlightSelection(text) {
  if (!text || typeof text !== "string") return null;

  // Require ≥2 candidate-set markers OR ≥1 candidate-set header (implies
  // a list — a header alone is sufficient evidence that a candidate set
  // was surfaced, since enumeration follows by structure).
  let totalMarkers = 0;
  const evidenceSamples = [];
  for (const re of CANDIDATE_SET_MARKERS) {
    const matches = [...text.matchAll(re)];
    totalMarkers += matches.length;
    for (const m of matches.slice(0, 2)) evidenceSamples.push(m[0].trim());
  }
  const hasHeader = CANDIDATE_SET_HEADER_RE.test(text);
  if (totalMarkers < 2 && !hasHeader) return null;

  // Require a pick anchor (otherwise it's a menu-without-pick — different rule)
  if (!RECOMMENDATION_ANCHOR.test(text)) return null;

  // Require fittability-anchor language
  const fitMatch = text.match(FITTABILITY_ANCHOR);
  if (!fitMatch) return null;

  // Cancelling signal: named trade-off (strongest) OR value-anchor in
  // proximity to the pick anchor (within ±200 chars). Decorative value-
  // anchor on a non-picked candidate elsewhere in text does NOT cancel
  // (HIGH-7 from /redteam Round 1).
  if (NAMED_TRADEOFF.test(text)) return null;
  const pickMatch = text.match(RECOMMENDATION_ANCHOR);
  if (pickMatch) {
    const pickIdx = pickMatch.index;
    const window = text.slice(
      Math.max(0, pickIdx - 200),
      Math.min(text.length, pickIdx + 200 + pickMatch[0].length),
    );
    if (VALUE_ANCHOR.test(window)) return null;
  }

  return {
    rule_id: "value-prioritization/MUST-1",
    severity: "advisory", // lexical only; per hook-output-discipline.md MUST-2
    evidence: `pick+fit:[${fitMatch[0].trim()}] without value-anchor; markers=${evidenceSamples.slice(0, 3).join(" / ")}`,
    detection_layer: "lexical",
    mode: "response",
  };
}

// 11. Deferral without value-anchor (rules/value-prioritization.md MUST-2, 2026-05-07)
//
// Detects: deferral / carried-forward / tracked-separately markers in
// session notes / journal entries / response prose WITHOUT an adjacent
// value-anchor line. Companion to detectStreetlightSelection — that one
// catches selection-time streetlight; this one catches the deferral-time
// failure that produces decay-as-forgetting.
// Severity: advisory.
// Tier 1 — strong deferral markers. These phrases alone signal deferral
// disposition; they are nearly always agent-side framings of "this is
// being moved out of the queue."
const DEFERRAL_MARKER_TIER1 =
  /\b(carried-?forward\s+\(no\s+grace\s+clock\)|deferred\s+to\s+(follow-?up|next\s+session|backlog)|tracked\s+separately\b|out\s+of\s+(this\s+)?(session|milestone|phase|week-?\d*)\s+scope\b|punted\s+to\s+\w+|deferred\s+indefinitely\b|architectural\s+follow-?up\b|future\s+iteration\b)/i;
// Tier 2 — weak deferral markers. These phrases (Phase II, wishlist,
// stretch goal, roadmap item, Tier-2, v<N> scope, etc.) often appear in
// LEGITIMATE non-deferral contexts (migration phasing, user feature
// descriptions, public roadmaps). Flag only when in proximity (±150
// chars) to a deferral-context phrase that signals the agent is moving
// the item OUT of its own queue.
const DEFERRAL_MARKER_TIER2 =
  /\b(phase\s+(II|2|3|N|next|2[+-]?)\s*(scope|work|item|milestone)?|beta\s+milestone\b|v\d+\.\d+\s+scope\b|v\d+\s+scope\b|out\s+of\s+(MVP|v\d+(\.\d+)?|the\s+MVP)\b|post-?(launch|\d+\.\d+|1\.0)\b|wishlist\b|stretch\s+goal\b|nice-?to-?have\b|roadmap\s+item\b|productization\s+concern\b|strategic\s+backlog\b|long-?term\s+queue\b|cycle\s+\d+|cycle\s+N\+1\b|tier-?2\s+(priority|item)?|\bP[23]\s+(priority|item)?\b|below\s+the\s+cut-?line\b|beyond\s+current\s+scope\b|next\s+sprint\b|sprint\s+cycle\b|iteration\s+window\s+\d+|OKR\s+cadence\b|quarterly\s+review\b|next\s+(quarter|half)\b|H[12]\s+\d{4}\b|next-?PI\b|program\s+increment\b)/i;
// Tier 2 needs corroborating deferral context to flag — phrases that
// indicate the agent is moving work OUT of its queue.
const DEFERRAL_CONTEXT =
  /\b(deferred?\b|deferring\b|defer(ring|ral)\s+to\b|will\s+revisit\b|will\s+pick\s+up\s+(later|next)|punt\b|out\s+of\s+scope\b|moved\s+out\s+of\b|not\s+in\s+this\s+(session|cycle|sprint|milestone)|track(ed|ing)\s+separately\b|carried[-\s]?forward\b|follow-?up\s+(issue|item|work)|backlog(ged)?\b)/i;
// Adjacent value-anchor: appears within 200 chars after the deferral marker.
// Includes literal user-quoted authorization (per Round-3 analyst NE-1 —
// "user said X" with the user's literal scope-reduction directive IS a
// user-anchored source per rule MUST-1's closed allowlist).
const VALUE_ANCHOR_ADJACENT =
  /(value[\s_-]?anchor\s*:|primary\s+anchor\s*:|delivers\s+value\b|per\s+the\s+brief\b|per\s+brief\s+§|per\s+spec\s+§|per\s+journal\s+DECISION|user-?stated\s+(value|preference|priority)|user\s+(said|quoted|directed|instructed)\b|per\s+user\s+(instruction|quote|directive))/i;

function detectDeferralWithoutValueAnchor(text) {
  if (!text || typeof text !== "string") return null;
  const findings = [];

  // Sweep tier-1 markers (always indicate deferral).
  const re1 = new RegExp(DEFERRAL_MARKER_TIER1.source, "gi");
  let match;
  while ((match = re1.exec(text)) !== null) {
    const start = match.index;
    const window = text.slice(Math.max(0, start - 250), start + 250);
    if (VALUE_ANCHOR_ADJACENT.test(window)) continue;
    findings.push(match[0].trim());
    if (findings.length >= 3) break;
  }

  // Sweep tier-2 markers (PM euphemisms; require corroborating deferral
  // context within ±150 chars to distinguish legitimate non-deferral
  // uses like "Phase I lands core, Phase II lands consumers" or
  // "user's wishlist for v3 includes X" from agent-side deferral-as-
  // forgetting framings).
  if (findings.length < 3) {
    const re2 = new RegExp(DEFERRAL_MARKER_TIER2.source, "gi");
    while ((match = re2.exec(text)) !== null) {
      const start = match.index;
      const ctxWindow = text.slice(
        Math.max(0, start - 150),
        Math.min(text.length, start + 150 + match[0].length),
      );
      // Require deferral context to flag tier-2 markers.
      if (!DEFERRAL_CONTEXT.test(ctxWindow)) continue;
      // Then check value-anchor cancel (250-char window).
      const anchorWindow = text.slice(Math.max(0, start - 250), start + 250);
      if (VALUE_ANCHOR_ADJACENT.test(anchorWindow)) continue;
      findings.push(match[0].trim());
      if (findings.length >= 3) break;
    }
  }

  if (findings.length === 0) return null;
  return {
    rule_id: "value-prioritization/MUST-2",
    severity: "advisory",
    evidence: findings.join(" | "),
    detection_layer: "lexical",
    mode: "response",
  };
}

// 12. Deferred-item pickup without re-validation (rules/value-prioritization.md
// MUST-3, F-2 deferred follow-up, 2026-05-07).
//
// Detects: agent prose where the agent picks up a deferred item (resuming /
// picking up / continuing / re-opening a deferred-shard / Carried-forward /
// follow-up / prior-session / session-notes-tagged item) WITHOUT surfacing
// the re-validation step the rule mandates ("re-validate the value-anchor
// before resuming"). Companion to detectStreetlightSelection (MUST-1) and
// detectDeferralWithoutValueAnchor (MUST-2). Closes the silent-inheritance
// loophole MUST-3 currently enforces in prose only — without this detector
// an agent that picks up a deferred item without a re-validation prose
// surface evades MUST-3 detection entirely.
//
// Severity: advisory (lexical regex per probe-driven-verification.md MUST-4).
//
// PICKUP markers — TWO classes that require an action verb adjacent to a
// deferred-item noun phrase. The 80-char proximity window is the same shape
// as DEFERRAL_MARKER_TIER1 → DEFERRAL_CONTEXT proximity in MUST-2.
const PICKUP_MARKER_GENERIC =
  /\b(resuming|re-?starting|picking[-\s]?up|continuing|re-?picking|re-?opening|starting\s+on|carrying\s+forward|reactivating|un-?deferring|going\s+back\s+to|returning\s+to)\b[^.\n]{0,80}\b(deferred(\s+(item|shard|todo|workstream|queue|issue|follow-?up))?|carried[-\s]?forward|prior\s+session|previous\s+session|last\s+session|session[-\s]?notes?|workspace\s+todo|deferred-?to-?follow-?up|follow-?up\s+(item|shard|issue|work)|backlog\s+item)\b/i;
// Issue/PR pickup — same shape but explicitly anchored to a numeric ID.
// Matches "picking up #234 from prior session" / "resuming PR #75" / etc.
const PICKUP_MARKER_TICKETED =
  /\b(picking[-\s]?up|resuming|re-?opening|starting\s+on|reactivating|going\s+back\s+to|returning\s+to)\b[^.\n]{0,80}\b(issue|GH\s*issue|PR|pull\s+request|ticket|workspace\s+todo|shard|follow-?up)\s*#?\d+\b/i;
// Re-validation cancel: any of these phrases within ±250 chars of the pickup
// marker cancels the finding. Mirrors VALUE_ANCHOR_ADJACENT's proximity model.
// Matches the prose surfaces MUST-3 explicitly mandates: "re-validate", "is
// this still your value", "anchor still applies/holds", "before resuming",
// "still load-bearing", "surface the value-anchor", "confirm the brief".
const REVALIDATION_MARKER =
  /(re-?validat(e|ing|ion|ed)\b|value[\s_-]?anchor\s+(still|holds?|applicable|load-?bearing|may\s+have\s+decayed|valid)|anchor\s+(still|holds?|applicable|valid|may\s+have\s+decayed)|is\s+this\s+still\s+your\s+(value|priority|preference|anchor|brief)|still\s+wanted\?|still\s+load-?bearing|still\s+applies\b|before\s+resuming\b|surfac(ing|e)\s+the\s+(value|anchor|brief|user-?anchored)|confirm(ing)?\s+(the\s+)?(value|anchor|brief|user-?anchored)|check\s+(the\s+|for\s+)?(value-?anchor|the\s+anchor|the\s+brief)|user-?anchored\s+gate|recorded\s+anchor\s*:|is\s+the\s+anchor\s+still|is\s+this\s+still\s+the\s+(brief|priority|value)|MUST-3\s+re-?validation|re-?pickup\s+gate)/i;

function detectDeferredItemPickupWithoutRevalidation(text) {
  if (!text || typeof text !== "string") return null;
  const findings = [];

  for (const re of [PICKUP_MARKER_GENERIC, PICKUP_MARKER_TICKETED]) {
    const reGlobal = new RegExp(re.source, "gi");
    let match;
    while ((match = reGlobal.exec(text)) !== null) {
      const start = match.index;
      const window = text.slice(Math.max(0, start - 250), start + 250);
      if (REVALIDATION_MARKER.test(window)) continue;
      findings.push(match[0].trim());
      if (findings.length >= 3) break;
    }
    if (findings.length >= 3) break;
  }

  if (findings.length === 0) return null;
  return {
    rule_id: "value-prioritization/MUST-3",
    severity: "advisory",
    evidence: findings.slice(0, 3).join(" | "),
    detection_layer: "lexical",
    mode: "response",
  };
}

// 13. gh-close-as-not-planned PostToolUse(Bash) detector
// (rules/value-prioritization.md MUST-4, F-3 deferred follow-up, 2026-05-07).
//
// Detects: `gh issue close N --reason not_planned` / `--reason wontfix` /
// `gh pr close N --reason not_planned` invocations in agent tool-call
// space. Per MUST-4, closure of value-bearing deferred work as not_planned
// / wontfix requires explicit user approval IN THE SAME SESSION; the
// prose-scan hooks (detectStreetlightSelection / detectDeferral...)
// cannot see closures issued via Bash. F-3 closes that escape route.
//
// Severity: halt-and-report. Bash-time detection is post-execution (the
// closure has already shipped); the surface is forensic for /codify
// review + cumulative tracking. Per hook-output-discipline.md MUST-2,
// severity:block from lexical regex is BLOCKED — halt-and-report is the
// loudest legitimate severity for a lexical match.
// Trailing `\b` only after BARE forms — `"not_planned"` ends in a non-word
// quote char, where `\b` does not match against a following space; the
// closing quote already anchors the quoted alternates structurally.
//
// Argument-order tolerance (Round-2 MED-C2): the regex MUST tolerate any
// argument order between `close` and `--reason VALUE` — `gh issue close N
// --reason wontfix`, `gh issue close --reason wontfix N`, xargs-piped
// `xargs gh issue close --reason wontfix` (no literal ID at hook time).
// The structural signal is the verb pair (`gh (issue|pr) close`) + the
// `--reason` flag with a forbidden value; the issue ID's presence and
// position is irrelevant to the failure-mode classification.
const GH_CLOSE_NOT_PLANNED_RE =
  /\bgh\s+(?:issue|pr)\s+close\b[^|;\n]*--reason\s+(?:(?:not_planned|wontfix)\b|"(?:not_planned|wontfix)"|'(?:not_planned|wontfix)')/i;

function detectGhIssueCloseAsNotPlanned(command) {
  if (!command || typeof command !== "string") return null;
  if (!GH_CLOSE_NOT_PLANNED_RE.test(command)) return null;
  // Skip shell-variable references per hook-output-discipline.md MUST-3 —
  // unexpanded $VAR / ${VAR} / $(...) cannot be evaluated at hook time, so
  // a finding against the literal string is structurally meaningless.
  // Round-2 MED-C1: brace-form `${VAR}` MUST be covered alongside `$VAR`.
  if (/--reason\s+\$\w/.test(command)) return null;
  if (/--reason\s+\$\{\w/.test(command)) return null; // brace-form ${VAR}
  if (/--reason\s+\$\(/.test(command)) return null; // command substitution $()
  if (/--reason\s+`/.test(command)) return null; // backtick command substitution
  const match = command.match(GH_CLOSE_NOT_PLANNED_RE);
  return {
    rule_id: "value-prioritization/MUST-4",
    severity: "halt-and-report",
    evidence: match[0].slice(0, 200),
    detection_layer: "lexical",
    mode: "bash",
  };
}

/**
 * detectStateFileMutation — three-layer Bash mutation detector for protected
 * state-file paths.
 *
 * Layer 1: redirect / heredoc / tee / sed -i / jq -i (excluding fd-redirects
 *          like `2>&1` and /dev/null sinks).
 * Layer 2: file-mutating utilities (cp, mv, dd, rsync, install, truncate, ln,
 *          chmod, chown, touch).
 * Layer 3: interpreter -c / -e / -m bodies (python, node, ruby, perl, bash, sh)
 *          that reference the protected path.
 *
 * Single-line scope: each layer matches within ONE line of the command —
 * a `>` on line 1 followed by a protected path on line 4 is NOT one redirect.
 * Without single-line scope, an unrelated redirect on one line plus a
 * protected-path mention on a later line would fire a false-positive.
 *
 * Generic over `pathRx` so consumers can supply their own protected-path
 * regex (trust-posture state, deploy state, project-specific state). Returns
 * `{ layer, kind }` on hit, or `null` if no mutation detected.
 *
 * Pairs with `rules/state-file-write-guard.md` § "Bash-Layer Mutation
 * Coverage — Beyond Redirects" and the trust-posture state-file protection
 * in `validate-bash-command.js`.
 */
function detectStateFileMutation(command, pathRx) {
  if (!command || !pathRx) return null;
  const lines = command.split("\n");
  for (const line of lines) {
    // Layer 1: redirect / heredoc / tee / sed -i / jq -i — but NOT 2>&1 fd-redirect or /dev/null sink
    // Output redirect to protected path
    if (/(?:^|[^&\d2])>\s*[^|\n]*?/.test(line)) {
      const redirectMatch = line.match(/(?:^|[^&\d2])>>?\s*([^\s|;&]+)/);
      if (redirectMatch && pathRx.test(redirectMatch[1])) {
        return { layer: 1, kind: "redirect" };
      }
    }
    // Heredoc to protected path: `cat > path << EOF` or `>>path<<EOF`
    if (/<<[-~]?\s*['"]?[A-Za-z_]/.test(line)) {
      // Heredoc body itself is delivered later; the line that opens it
      // typically has the redirect target. Match `> <protected>` on this line.
      const m = line.match(/>\s*([^\s|;&<]+)/);
      if (m && pathRx.test(m[1])) {
        return { layer: 1, kind: "heredoc" };
      }
    }
    // tee
    if (/\btee\b\s+/.test(line)) {
      const m = line.match(/\btee\b\s+(?:-[a-zA-Z]+\s+)*([^\s|;&]+)/);
      if (m && pathRx.test(m[1])) {
        return { layer: 1, kind: "tee" };
      }
    }
    // sed -i / jq -i in-place editing
    if (/\b(?:sed|jq)\b\s+[^|\n]*-i\b/.test(line)) {
      if (pathRx.test(line)) return { layer: 1, kind: "in-place-edit" };
    }

    // Layer 2: file-mutating utilities
    const layer2Verbs =
      /\b(?:cp|mv|dd|rsync|install|truncate|ln|chmod|chown|touch)\b\s+/;
    if (layer2Verbs.test(line) && pathRx.test(line)) {
      const verbMatch = line.match(layer2Verbs);
      return {
        layer: 2,
        kind: verbMatch ? verbMatch[0].trim() : "file-mutation-util",
      };
    }

    // Layer 3: interpreter -c / -e / -m bodies (e.g. python -c "...", node -e "...")
    // Includes combined short-flag forms like `-uc`, `-uec`
    const interpreterBody =
      /\b(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b\s+[^|\n]*-[a-zA-Z]*[cem][a-zA-Z]*\b\s+["'][^"']*["']/;
    if (interpreterBody.test(line) && pathRx.test(line)) {
      const interpMatch = line.match(
        /\b(python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b/,
      );
      return {
        layer: 3,
        kind: interpMatch ? `${interpMatch[1]} -c/-e/-m` : "interpreter-body",
      };
    }
  }
  return null;
}

module.exports = {
  detectPreExistingNoSha,
  detectRepoScopeDriftText,
  detectRepoScopeDriftBash,
  hasCrossRepoAuthorizationReceipt,
  detectWorktreeDrift,
  detectCommitClaim,
  detectSweepSubstitution,
  detectSelfConfession,
  detectMenuWithoutPick,
  detectRegexForSemanticAssertion,
  detectTimePressureShortcut,
  detectStreetlightSelection,
  detectDeferralWithoutValueAnchor,
  detectDeferredItemPickupWithoutRevalidation,
  detectGhIssueCloseAsNotPlanned,
  detectStateFileMutation,
};
