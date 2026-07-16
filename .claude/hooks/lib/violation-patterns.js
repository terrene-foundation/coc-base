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
 * Read `git remote get-url <remoteName>` from cwd, normalize to "Org/Repo".
 * Returns null if the remote is absent, git is unavailable, or the URL is
 * unrecognized. Structural durable-on-disk signal (git remote state), NOT
 * lexical prose — the in-scope allowances in detectRepoScopeDriftBash are
 * grounded on it:
 *   - "origin"   — the CWD repo's OWN identity. A `gh --repo <origin>` is the
 *                  owner PR/merge workflow on the CURRENT repo, in-scope even
 *                  from a git WORKTREE whose directory basename differs from
 *                  the repo slug (the basename heuristic cannot see this).
 *   - "upstream" — the hierarchical-fork parent-product (issue #36); some
 *                  consumer rules MANDATE filing issues/PRs against the parent.
 * Worktrees share the common .git, so origin/upstream resolve identically
 * from a linked worktree and its main checkout.
 */
function readRemoteSlug(cwd, remoteName) {
  try {
    const url = execFileSync("git", ["remote", "get-url", remoteName], {
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
 * cap — same posture as readRemoteSlug.
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

// Bounds stale-receipt reuse across sessions: an authorizing receipt only
// clears a cross-repo action if written within this window
// (repo-scope-discipline.md User-Authorized Exception condition 5 — scoped to
// ONE action; a days-old receipt MUST NOT authorize). Age is derived from the
// receipt's own `timestamp:`/`date:` FRONTMATTER, NOT filesystem mtime — git
// rewrites mtime on checkout / worktree-add / clone, and receipts are COMMITTED
// (repo-scope-discipline.md), so mtime is not a reliable authorization-age
// bound; the content timestamp is checkout-stable.
const CROSS_REPO_RECEIPT_WINDOW_MS = 6 * 60 * 60 * 1000;
// The staleness bound is TWO-SIDED: a FUTURE-dated receipt is also rejected
// (beyond this small clock-skew tolerance). Since the age field is the
// agent/writer-controlled `timestamp:` frontmatter, a one-sided bound would let
// a `timestamp: 2062-...` receipt authorize indefinitely (a typo `2026`→`2062`
// does it non-adversarially). Skew tolerates benign multi-host clock drift.
const CROSS_REPO_RECEIPT_SKEW_MS = 5 * 60 * 1000;

// Parse a receipt's `timestamp:` (ISO) or `date:` (YYYY-MM-DD) frontmatter →
// ms epoch, or null if absent/unparseable (→ treated as stale, fail-closed).
function _receiptTimestampMs(content) {
  let m = content.match(/^timestamp:\s*(\S+)\s*$/m);
  if (!m) m = content.match(/^date:\s*(\S+)\s*$/m);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

/**
 * Structural in-scope signal for repo-scope-discipline.md
 * § User-Authorized Exception condition 4: a cross-repo action PRECEDED by an
 * authorizing receipt is in-scope by definition. The receipt carries the
 * greppable whole-line marker `cross-repo-authorized: <owner/repo> <mode>`.
 *
 * TIER-AWARE (D — journal/0488): a WRITE action is cleared ONLY by a `write`
 * receipt; a READ action is cleared by EITHER a `read` OR a `write` receipt (a
 * write authorization is strictly stronger). `requiredMode` comes from
 * `classifyCrossRepoIntent` — so a cheap read receipt can NEVER clear a write.
 *
 * The marker is matched ANCHORED to a full standalone line (regex-escaped
 * slug), so a prefix-slug (`acme/service` vs a receipt for
 * `acme/service-internal`) cannot collide and an injected free-text line cannot
 * forge a second target. Age is the content `timestamp:`, not mtime.
 *
 * Scans the non-codify-gated `.claude/cross-repo-authz/` (RC6 break, journal/0488)
 * FIRST, then repo-root journal/ + workspace journals for codify-authored receipts.
 */
function hasCrossRepoAuthorizationReceipt(targetSlug, cwd, requiredMode) {
  if (!targetSlug) return false;
  const root = repoRoot(cwd);
  if (!root) return false;
  // Fail-closed: anything not explicitly "read" is treated as the stricter write.
  const mode = requiredMode === "read" ? "read" : "write";
  const esc = targetSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // WRITE action → `write` receipt only; READ action → read OR write.
  const modeAlt = mode === "read" ? "(?:read|write)" : "write";
  // `[ \t]` (not `\s`) for inner separators so the marker is TRULY single-line —
  // `\s` matches `\n`, which would let the slug/mode tokens satisfy the pattern
  // across a line break; `^`/`$` with the `m` flag stay line-anchored.
  const markerRe = new RegExp(
    `^cross-repo-authorized:[ \\t]+${esc}[ \\t]+${modeAlt}[ \\t]*$`,
    "m",
  );
  const now = Date.now();
  const dirs = [
    path.join(root, ".claude", "cross-repo-authz"),
    path.join(root, "journal"),
  ];
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
        const content = fs.readFileSync(fp, "utf8");
        if (!markerRe.test(content)) continue;
        // Content-timestamp age bound (checkout-stable, unlike mtime), TWO-SIDED:
        // reject too-old (> window) AND future-dated (> skew) — a future
        // `timestamp:` would otherwise authorize indefinitely (the age field is
        // writer-controlled since the mtime→content-timestamp switch).
        const ts = _receiptTimestampMs(content);
        if (
          ts === null ||
          now - ts > CROSS_REPO_RECEIPT_WINDOW_MS ||
          ts - now > CROSS_REPO_RECEIPT_SKEW_MS
        )
          continue;
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

// Classify a cross-repo `gh` command's intent as "read" or "write" for the
// tier-reads discipline (D — journal/0488): a user-directed READ satisfies
// repo-scope-discipline.md § User-Authorized Exception with condition-4
// downgraded to a one-line affordance receipt; a WRITE keeps all five
// conditions. FAIL-CLOSED: an unrecognized subcommand ranks WRITE (the
// stricter tier), so a novel `gh` verb never silently gets the lighter read
// ceremony — an unrecognized→write default is the conservative disposition,
// mirroring the enforcement-surface-parity "unrecognized ranks tightest".
const GH_READ_VERBS =
  /\bgh\s+(?:issue|pr|repo|run|release|workflow|cache|label|gist|search|api)?\s*(?:view|list|status|diff|checks|ls)\b|\bgh\s+search\b|\bgh\s+repo\s+view\b/;
const GH_WRITE_VERBS =
  /\bgh\s+(?:issue|pr|repo|release|secret|workflow|label|gist|api)?\s*(?:create|edit|close|comment|reopen|delete|transfer|pin|lock|merge|review|ready|set|run|upload|fork|rename|sync|clone)\b/;
// `gh api` with an explicit mutating method or a data field is a WRITE.
// Matches all method-flag forms — `-X POST`, `-XPOST`, `--method POST`,
// `--method=POST` — via `(?:-X|--method)[\s=]*`, AND a body field
// (`-f`/`-F`/`--field`/`--raw-field`/`--input`; `--input <file|->` promotes the
// request to POST). Missing the equals-form + `--input` was a fail-OPEN hole in
// a fail-closed-by-design classifier.
const GH_API_MUTATE =
  /\bgh\s+api\b[^|;]*(?:(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE)|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)\b)/i;

function classifyCrossRepoIntent(command) {
  if (!command || typeof command !== "string") return "write";
  if (GH_API_MUTATE.test(command)) return "write";
  if (GH_WRITE_VERBS.test(command)) return "write";
  if (GH_READ_VERBS.test(command)) return "read";
  // A bare `gh api <path>` with no mutating method/field is a GET (read) —
  // GH_API_MUTATE above already claimed every mutating `gh api` first, so a
  // remaining `gh api` is read-only (the verify-resource-existence.md GET is
  // the common case). This narrows the fail-closed default WITHOUT weakening
  // it: mutating api calls never reach here.
  if (/\bgh\s+api\b/.test(command)) return "read";
  // Unknown gh subcommand → fail-closed to the stricter WRITE tier.
  return "write";
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

// Extract the cross-repo target slug a `gh` command SEGMENT names, or null.
// Two forms: (1) `gh ... --repo <slug>` (flag form), (2) `gh api [/]repos/<owner>/<repo>...`
// (positional REST-path form — `gh api` never takes `--repo`, so without this a
// cross-repo `gh api` was entirely ungated + classifyCrossRepoIntent's gh-api
// handling was dead code). `seg` MUST already be a single command segment that
// LEADS with `gh` (see detectRepoScopeDriftBash).
function _ghSegmentTarget(rest) {
  const flag = rest.match(/(?:^|\s)--repo(?:=|\s+)(["']?)([^\s"']+)\1/);
  if (flag) return flag[2];
  // Positional `gh api .../repos/<owner>/<repo>` — only when the verb is `api`.
  if (/^api\b/.test(rest)) {
    const api = rest.match(
      /(?:^|\s)\/?repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/|\s|$)/,
    );
    if (api) return api[1];
  }
  return null;
}

function detectRepoScopeDriftBash(command, cwd) {
  if (!command || typeof command !== "string") return null;
  // Join backslash-newline line-CONTINUATIONS first (the shell treats them as
  // one command), THEN segment-split on real separators `;` `&` `|` newline `(`.
  // Segment-splitting means a `gh ... --repo other` embedded as a SUBSTRING
  // inside an echo / grep / heredoc / JSON payload is NOT segment-leading → NOT
  // flagged (the false-positive class the PreToolUse guide-first amplified),
  // while a `--repo`/`repos/` sitting past a `\`-newline continuation is still
  // caught (the continuation is joined before the split). A BARE newline stays a
  // separator (a benign leading `gh` and an unrelated later `--repo` are
  // different segments → correctly not joined).
  const joined = command.replace(/\\\r?\n/g, " ");
  // Split on `;` `&` `|` newline — but NOT `(`: splitting on `(` would sever a
  // `$(...)` command-substitution (leaving a bare `--repo $` that the
  // shell-variable skip misses), a false-positive. A leading `(` subshell is
  // instead absorbed by the lead regex below, so `$(...)` stays intact within
  // its segment and the existing `\$\(` skip catches it.
  const segments = joined.split(/[;&|\n]/);
  const cwdBase = path.basename(cwd || process.cwd());
  for (const seg of segments) {
    const s = seg.trim();
    // Segment MUST start with `gh` (optionally after a subshell `(` and/or
    // env-assign prefixes like `FOO=bar gh ...`); a `gh` mid-string (echo/grep)
    // never leads a segment.
    const lead = s.match(/^\(*\s*(?:\w+=\S+\s+)*gh\s+(.*)$/s);
    if (!lead) continue;
    const rest = lead[1];
    const targetRepo = _ghSegmentTarget(rest);
    if (!targetRepo) continue;
    // hook-output-discipline.md MUST-3: skip shell-variable references —
    // `payload.tool_input.command` is the pre-expansion string, so $REPO /
    // ${REPO} / $(...) / `...` cannot be evaluated at hook time.
    if (
      /^\$\{?\w+\}?$/.test(targetRepo) ||
      /\$\(/.test(targetRepo) ||
      /`/.test(targetRepo)
    ) {
      continue;
    }
    const intent = classifyCrossRepoIntent(s);
    const targetSlug = normalizeRepoSlug(targetRepo);
    if (targetSlug) {
      // OWN-ORIGIN allowance — the CWD repo's own `origin` slug (the in-scope
      // owner PR/merge workflow, fires even from a git WORKTREE whose basename
      // differs). Structural git-remote signal, not lexical regex.
      const origin = readRemoteSlug(cwd, "origin");
      if (origin && origin === targetSlug) continue;
      // Issue #36 — hierarchical-fork `upstream` allowance (same class).
      const upstream = readRemoteSlug(cwd, "upstream");
      if (upstream && upstream === targetSlug) continue;
      // condition 4 — a cross-repo action PRECEDED by an authorizing receipt is
      // in-scope. TIER-AWARE: a WRITE needs a write receipt; a READ accepts read
      // OR write (classifyCrossRepoIntent supplies the required mode). Structural
      // durable-on-disk signal, not lexical prose.
      if (hasCrossRepoAuthorizationReceipt(targetSlug, cwd, intent)) continue;
    }
    if (!targetRepo.includes(cwdBase)) {
      // hook-output-discipline.md MUST-2: lexical regex finding emits
      // halt-and-report, never block. `target` + `intent` are surfaced so the
      // PreToolUse guide-first ceremony need not re-extract/re-classify.
      return {
        rule_id: "repo-scope-discipline/MUST-NOT-1",
        severity: "halt-and-report",
        evidence: `gh cross-repo ${intent} ${targetRepo} from cwd basename ${cwdBase} (no origin/upstream remote/receipt match)`,
        target: targetRepo,
        intent,
      };
    }
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
 * Layer 2: file-mutating utilities (cp, mv, rm, dd, rsync, install, truncate,
 *          ln, chmod, chown, touch, sponge).
 * Layer 3: interpreter bodies (python, node, ruby, perl, bash, sh) referencing
 *          the protected path — per-line quoted `-c`/`-e`/`-m` forms, PLUS a
 *          fallback for a command / pipeline-segment LED BY python/node/ruby/perl
 *          (covers `-m`, unquoted, script-arg, `--eval=`, and stdin-heredoc
 *          forms; restores parity with the removed Bash(python:*<state>*) deny
 *          globs, which anchored on the interpreter as the command executable).
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
 * Coverage — Four Layers" and the trust-posture state-file protection
 * in `validate-bash-command.js`.
 */
function detectStateFileMutation(command, pathRx) {
  if (!command || !pathRx) return null;
  const lines = command.split("\n");
  for (const line of lines) {
    // Layer 1: redirect / heredoc / tee / sed -i / jq -i — but NOT an fd-DUP
    // (2>&1, >&2), which redirects to a descriptor, not a file.
    // Output redirect to a protected path. Recognizes every file-writing form:
    //   >  >>  >| (force-clobber)  &> &>> (stdout+stderr)  N> N>> N>| (fd-prefixed).
    // An fd-dup target (`&N`) is excluded from the capture class so `2>&1` /
    // `>&2` never capture a path. `matchAll` checks EVERY redirect target on the
    // line, so a benign redirect preceding the state-file one is not a blind spot.
    // (#745 redteam Finding 1: the prior `(?:^|[^&\d2])>` matcher missed `>|`,
    // `&>`, and fd-prefixed `N>` forms — all real state-file writes.)
    for (const rm of line.matchAll(/(?:\d+|&)?>>?\|?\s*([^\s|;&<>()]+)/g)) {
      if (pathRx.test(rm[1])) {
        return { layer: 1, kind: "redirect" };
      }
    }
    // Heredoc to protected path: `cat > path << EOF` or `>>path<<EOF`.
    // Uses the shared matchHeredocOpener (bash delimiter parser with quote
    // removal + structural `<<<` here-string exclusion) so a numeric / quoted /
    // hyphenated / partially-quoted delimiter (`<<9`, `<<'a-b'`, `<<E"O"F`) is
    // recognized consistently with the Layer-4 bundle pass. (The `>`-redirect
    // matcher above already catches `> <protected>` directly; this branch is the
    // labelled defence-in-depth companion.)
    if (matchHeredocOpeners(line).length) {
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

    // Layer 2: file-mutating utilities. `rm` + `sponge` added (F123): `rm`
    // closes the parity gap left when settings.json's Bash(rm:<state>) deny
    // entries were removed in favor of this path-based interceptor; `sponge`
    // (moreutils write-back) closes a write-capable verb the deny-matrix
    // never covered. Each fires only when pathRx ALSO matches the line, so a
    // benign `rm <non-state-file>` does not flag.
    const layer2Verbs =
      /\b(?:cp|mv|rm|dd|rsync|install|truncate|ln|chmod|chown|touch|sponge)\b\s+/;
    if (layer2Verbs.test(line) && pathRx.test(line)) {
      const verbMatch = line.match(layer2Verbs);
      return {
        layer: 2,
        kind: verbMatch ? verbMatch[0].trim() : "file-mutation-util",
      };
    }

    // Layer 3: interpreter -c / -e / -m bodies (e.g. python -c "...", node -e "...")
    // Includes combined short-flag forms like `-uc`, `-uec`. The flag-cluster
    // quantifiers are BOUNDED (`{0,32}`, not `*`) to prevent catastrophic
    // backtracking on a crafted long `-eeee…` run (a ReDoS: adjacent overlapping
    // `[a-zA-Z]` classes around `[cem]`); real interpreter flag clusters are short.
    // `pathRx.test(line)` gates FIRST so the bounded regex only runs on a
    // protected-path line.
    const interpreterBody =
      /\b(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b\s+[^|\n]*-[a-zA-Z]{0,32}[cem][a-zA-Z]{0,32}\b\s+["'][^"']*["']/;
    if (pathRx.test(line) && interpreterBody.test(line)) {
      const interpMatch = line.match(
        /\b(python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b/,
      );
      return {
        layer: 3,
        kind: interpMatch ? `${interpMatch[1]} -c/-e/-m` : "interpreter-body",
      };
    }
  }

  // Layer 3 (whole-command fallback): a command — or pipeline segment — whose
  // LEADING token is an interpreter (python/node/ruby/perl), with a protected
  // path anywhere in the command. The per-line matcher above requires a quoted
  // `-c`/`-e`/`-m` body on a single line; this clause additionally covers `-m`
  // module invocations, unquoted/escaped bodies, `--eval=` forms, a script arg
  // (`python3 write_state.py <path>`), and stdin heredocs (`python3 - <<PY …
  // <path> … PY`) that span lines. Anchoring on the LEADING token (the way the
  // removed Bash(python:*<state>*)/Bash(node:*<state>*) deny globs anchored on
  // the interpreter AS the command executable) restores parity WITHOUT the
  // broader false-positives a bare token-anywhere match would add: prose
  // (`echo "python … <path>"`) and interpreter-as-search-arg (`grep python
  // <path>`) are NOT led by the interpreter and do not flag (per
  // hook-output-discipline.md MUST-2 — keep the lexical block narrow).
  // bash/sh/zsh are excluded: their writes go through the redirect operator,
  // already caught by Layer 1.
  const leadingInterpreter = /^\s*(?:\S*\/)?(python3?|node|nodejs|ruby|perl)\b/;
  const segments = command.split(/\||&&|;|\n/);
  const ledSeg = segments.find((s) => leadingInterpreter.test(s));
  if (ledSeg && pathRx.test(command)) {
    const im = ledSeg.match(leadingInterpreter);
    return { layer: 3, kind: `${im[1]} (interpreter)` };
  }
  return null;
}

/**
 * splitShellSegments — quote-aware split of a bash command into the
 * segments delimited by the top-level control operators `&&`, `||`, `;`,
 * and `|`. Separators appearing INSIDE single- or double-quotes (and
 * backslash-escaped separators) are NOT split points — they are prose.
 *
 * This is the primitive `detectStateFileMutationSegmentAware` relies on to
 * distinguish a mutation CHAINED after a `git commit` (a real, unquoted
 * `&&`) from a state-file path MENTIONED inside a quoted commit message (a
 * `&&`/`;`/`|` that lives between quotes). Single `&` (background) is NOT a
 * split point: it is rare, collides with the `2>&1` fd-redirect form, and a
 * mutation after a bare `&` is still caught by the per-segment
 * `detectStateFileMutation` fallback on the un-split segment.
 *
 * NOT a full shell parser (no here-doc / process-substitution awareness) —
 * per `hook-output-discipline.md` MUST-3 the hook MUST NOT expand shell
 * syntax. It tracks only quote state, which is sufficient to keep the
 * git-commit-body exception from being defeated by a chained `&&`.
 */
function splitShellSegments(command) {
  if (!command) return [];
  const segments = [];
  let current = "";
  let quote = null; // "'" or '"' when inside a quoted span, else null
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (quote === "'") {
      // Single quotes are literal in POSIX shell — no escapes; only ' closes.
      current += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      // Inside double quotes a backslash escapes the next char (incl. \").
      if (ch === "\\" && i + 1 < n) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    // Unquoted.
    if (ch === "\\" && i + 1 < n) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === "|" && current.endsWith(">")) {
      // `>|` force-clobber redirect — the `|` is part of the redirect operator,
      // NOT a pipe separator, so it must not split the segment (else the
      // redirect target lands in a sibling segment and Layer-1 detection
      // misses it). #745 redteam Finding 1.
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      segments.push(current);
      current = "";
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments;
}

// The git-commit-with-body exception: a `git commit -m "..."` / `git commit
// -F <file>` body is documentation prose that may contain arbitrary
// shell-like syntax (a mutation verb or a state-path mentioned in the
// message). The pattern anchors on the segment starting with `git commit`
// and requires a message/file body flag. It recognizes the common forms:
// ` -m ` / `-m"…"` (attached), combined short-flag clusters (`-am`, `-aF`),
// `--message[= ]`, ` -F ` / `-F<file>`, `--file[= ]`, `--reuse-message`.
// (Bare `git commit` / `git commit -a` open an editor — no inline body — so
// they are NOT commit-with-body: a mutation chained after them lands in a
// separate segment and is detected normally.) #745 F3: the pre-fix
// `(?:\s-m\s|\s-F\s)` anchor missed `-am`/attached forms, which then ran raw
// detection and FALSE-POSITIVE-blocked legit commits whose message mentioned
// a verb + state path.
const GIT_COMMIT_WITH_BODY_RX =
  /^\s*git\s+commit\b[^|;]*?\s(?:-[A-Za-z]*[mF]|--message|--file|--reuse-message)\b/;

// Constructs that EXECUTE (or change quote parsing) even inside a double-quoted
// commit body, defeating the "quoted body is inert prose" assumption that
// mask-not-skip relies on (#745 F1/F2):
//   `$(…)`     — command substitution runs inside double quotes
//   backtick   — legacy command substitution, runs inside double quotes
//   `$'…'`     — ANSI-C quoting; its `\'` escaping desyncs a naive quote scanner
//   `${ …;}` / `${| …;}` — bash 5.3+ command "funsubs"; run a command inside
//                double quotes exactly like `$(…)`. The `${`+space/`|` form is
//                distinct from `${x}` parameter expansion (which does NOT run a
//                command and is correctly NOT matched). (#745 redteam Finding 2.)
// When a commit segment contains any of these, masking cannot be trusted to
// have neutralized the body, so detection MUST fail-closed by also scanning
// the RAW (unmasked) segment.
const EXECUTES_INSIDE_QUOTES_RX = /\$\(|`|\$'|\$\{[\s|]/;

/**
 * maskQuotedSpans — replace the CONTENTS of every single/double-quoted span
 * with neutral filler (`x`), preserving the quote delimiters and the
 * unquoted structure. Backslash-escaped chars inside double quotes (and
 * unquoted) are consumed as a unit so an escaped quote does not mis-close.
 *
 * NB — this quote state machine MUST stay consistent with the one in
 * `splitShellSegments` (single-quote = no escapes; double-quote/unquoted =
 * `\`+next consumed as a unit). If one gains a new quote form (e.g. proper
 * `$'…'` ANSI-C handling), the other MUST gain it too, or the two desync.
 *
 * Used to neutralize a `git commit` MESSAGE body before running
 * mutation-detection on the commit segment: a state-path or mutation-verb
 * MENTIONED inside the quoted message becomes filler (no false positive),
 * while a REAL unquoted redirect/verb on the commit line (e.g.
 * `git commit -m "x" > .claude/learning/posture.json`) survives the mask and
 * is detected. Masking to `x` can only REMOVE tokens, never synthesize a
 * `.claude/learning/…` path or a mutation verb, so it cannot create a hit.
 */
function maskQuotedSpans(segment) {
  if (!segment) return segment;
  let out = "";
  let quote = null;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        out += ch;
      } else {
        out += "x";
      }
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < n) {
        out += "xx";
        i += 2;
        continue;
      }
      if (ch === '"') {
        quote = null;
        out += ch;
      } else {
        out += "x";
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      out += ch + segment[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// #764 item 3 — heredoc write+RUN-bundle detector (STRUCTURAL, whole-command).
//
// The bug: a bundled command
//   cat > s.cjs <<EOF ... fs.writeFileSync("<protected>") ... EOF && node s.cjs
// evades the per-segment `detectStateFileMutation`. `splitShellSegments` is NOT
// heredoc-aware, so the heredoc body's internal `;` (e.g. `writeFileSync(...);`)
// fractures the interpreter-lead (`node s.cjs`) from the protected-path write —
// no single segment sees BOTH, and the per-segment fallback's own whole-command
// clause runs against a fractured segment, not the full command. This pass runs
// on the WHOLE command and matches the STRUCTURAL write→execute conjunction.
//
// The signal (why `severity:block` is justified per hook-output-discipline.md
// MUST-2 — this is STRUCTURAL, not lexical): flag ONLY when, in ONE command,
//   (a) a heredoc whose REDIRECT-TARGET script file's BODY contains a protected
//       PATH LITERAL anywhere (match the path literal — NOT a write-verb
//       allowlist, NOT a prefix-anchored write-call regex; the path-literal
//       presence in a body destined for EXECUTION is the signal), AND
//   (b) that SAME written script file is SUBSEQUENTLY EXECUTED in the same
//       command by `<interp> <that-exact-written-path>` (node/nodejs/python/
//       ruby/perl/bash/sh/zsh running the written script).
// The conjunction is a real write-a-script-that-touches-a-protected-path AND
// run-it dataflow — structurally equivalent to a direct heredoc redirect to the
// protected path (which `detectStateFileMutation` Layer-1 already blocks), one
// indirection deeper through the heredoc→script→exec chain. A surface rewrite
// of the SCRIPT NAME, PATH PREFIX, QUOTING, WRITE VERB, WRITE SURFACE, or
// DELIMITER SHAPE does NOT evade it: (b) matches the written-path TOKEN identity
// (not a fixed lexical form); (a) matches the protected-path SUBSTRING in the
// executed body (not a verb allowlist); the write surface covers `>`/`>>` +
// `| tee` + `dd of=`; and the delimiter grammar is bash's full WORD grammar
// (numeric/quoted/hyphenated). TWO residual classes remain, SAME class as
// state-file-write-guard.md Rule 5 residuals (a)/(d) — NOT closable at this
// command-interceptor layer without in-hook shell expansion (forbidden by
// hook-output-discipline.md MUST-3): (i) VAR-INDIRECT exec, where the write and
// the run use DIFFERENT tokens that expand to the same file (`cat >/tmp/s.cjs
// <<E…E; T=/tmp/s.cjs; node "$T"` — write token `/tmp/s.cjs` ≠ exec token `$T`,
// so (b)'s token-identity fails; note a SHARED var token DOES match, since
// identity holds pre-expansion); (ii) a RUN segment NOT recognized as
// interpreter-led by RUN_INTERPRETER_RX after `VAR=` stripping — this ONE root
// cause covers a non-`VAR=` command prefix (`sudo`/`env`/`nice`/a subshell),
// direct shebang / executable-bit invocation (`chmod +x s && ./s`), AND shell
// sourcing (`source s` / `. s`); only `VAR=val` prefixes are stripped before the
// interpreter test. The forever-defense for both classes is the signed-fold /
// fail-closed-to-L1 integrity layer, NOT this interceptor. It does
// NOT false-block
// doc/rule/test authoring — that WRITES a file but does NOT execute it, so (b)
// fails structurally (this is why the redesign supersedes attempt-1's LEXICAL
// heredoc-body write-call regex, which false-blocked writing a doc that merely
// QUOTED `writeFileSync(".claude/…")` — loom authors exactly such fixtures).
//
// The git-commit exception needs NO special skip here (fixing attempt-1's
// per-line HIGH-2 evasion, `git commit -m x && cat >s.cjs <<EOF …write… EOF;
// node s.cjs`): a git-commit MESSAGE heredoc either (i) has no redirect-target
// script file (its body is git's STDIN, `git commit -F- <<MSG`), so (a)'s
// `!hd.target` guard skips it, OR (ii) its target file is consumed by `git`
// (`git commit -F msg.txt`), never by an interpreter in RUN_INTERPRETER_RX, so
// (b) fails. A heredoc CHAINED AFTER `git commit` is analyzed on its own
// structural merits (write→exec), never skipped — strictly tighter than a
// scoped git-commit skip.
//
// RUN_INTERPRETER_RX is the interpreter-lead gate for the RUN half. A RUN
// segment not matching it after `VAR=` stripping is the accepted residual (ii)
// enumerated in full above (non-`VAR=` command prefix / shebang-exec-bit /
// sourcing — SAME class as state-file-write-guard.md Rule 5 residual (d)); its
// forever-defense is the signed-fold / fail-closed-to-L1 integrity layer, not
// this interceptor. Leading `VAR=val` assignment prefixes (the ceremony
// env-prefix shape) ARE stripped before the interpreter test.
// Interpreter allowlist for the RUN half — a POSITIVE allowlist (an interpreter
// NOT listed is a documented residual, same class as the accepted residuals;
// forever-defense = signed-fold). Covers the standard shells + the common
// script interpreters an agent would use to run a written script.
const RUN_INTERPRETER_RX =
  /^\s*(?:\S*\/)?(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh|deno|bun|tsx|ts-node|Rscript|lua|php|osascript)\b/;
// Leading `VAR=val` assignment prefix(es) (attached quotes tolerated).
const VAR_ASSIGN_PREFIX_RX = /^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/;
// Heredoc opener recognition + TERMINATOR derivation. A regex that captured the
// delimiter's SURFACE bytes is not sufficient — bash applies QUOTE REMOVAL and
// BACKSLASH-ESCAPE to the delimiter word to get the terminator, so `<<E"O"F`,
// `<<'EO'F`, `<<EOF''`, and `<<EO\F` all close on the line `EOF`, not on their
// literal spelling. Capturing the surface bytes desyncs parseHeredocSpans' close
// comparison, so it never finds the close line, swallows the RUN line into a
// phantom body, and the bundle evades (redteam HIGH). The parser below computes
// the real terminator; matchHeredocOpener also enforces the here-STRING (`<<<`)
// exclusion STRUCTURALLY (a regex lookahead `(?!<)` is defeated by the engine
// re-matching one position right — `<<<x` → the 2nd/3rd `<` form a spurious
// `<<x` opener; the char-scan below cannot be shifted into that false match).
//
// parseHeredocDelimiter(line, i) — parse the bash delimiter WORD starting at i,
// applying quote removal + backslash-escape, and return { terminator } (the
// close-line bash matches) or null if no word is present. `~` is an ordinary
// word char (bash has only `<<-`, no `<<~`), so `<<~EOF` → terminator `~EOF`.
function parseHeredocDelimiter(line, i) {
  let term = "";
  let started = false;
  while (i < line.length) {
    const c = line[i];
    if (c === "$" && (line[i + 1] === "'" || line[i + 1] === '"')) {
      // ANSI-C `$'…'` / locale `$"…"` quoting — bash drops the `$` and dequotes
      // the body to the terminator (`<<$'EOF'` closes on `EOF`). Skip the `$`;
      // the quote branch on the next iteration consumes the body.
      started = true;
      i++;
      continue;
    }
    if (c === "'") {
      // single-quote: verbatim to the next `'` (bash single quotes have no escapes)
      started = true;
      i++;
      while (i < line.length && line[i] !== "'") {
        term += line[i];
        i++;
      }
      if (i < line.length) i++; // consume closing quote
      continue;
    }
    if (c === '"') {
      // double-quote: only `\"` and `\\` act as escapes for delimiter purposes
      started = true;
      i++;
      while (i < line.length && line[i] !== '"') {
        if (
          line[i] === "\\" &&
          i + 1 < line.length &&
          (line[i + 1] === '"' || line[i + 1] === "\\")
        ) {
          term += line[i + 1];
          i += 2;
          continue;
        }
        term += line[i];
        i++;
      }
      if (i < line.length) i++; // consume closing quote
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      // unquoted backslash-escape: next char is literal (`<<\EOF` → EOF)
      started = true;
      term += line[i + 1];
      i += 2;
      continue;
    }
    if (/[\s<>|;&()]/.test(c)) break; // unquoted whitespace/metachar ends the word
    term += c;
    started = true;
    i++;
  }
  if (!started) return null;
  return { terminator: term };
}

// matchHeredocOpeners(line) → array of { dash, terminator } for EVERY `<<` / `<<-`
// introducer on the line that is NOT a `<<<` here-string. Returns all candidates
// (not just the first) so parseHeredocSpans can pick the one whose close line
// actually exists downstream — an arithmetic `1<<4` or decoy `<<WORD` with no
// matching close is thereby ignored instead of opening a phantom heredoc.
function matchHeredocOpeners(line) {
  const out = [];
  for (let i = 0; i + 1 < line.length; i++) {
    if (line[i] !== "<" || line[i + 1] !== "<") continue;
    if (line[i - 1] === "<") continue; // part of a longer `<`-run (e.g. `<<<`)
    let j = i + 2;
    let dash = false;
    if (line[j] === "-") {
      dash = true;
      j++;
    }
    if (line[j] === "<") continue; // `<<<` here-STRING (no body)
    while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
    const parsed = parseHeredocDelimiter(line, j);
    if (parsed) out.push({ dash, terminator: parsed.terminator });
  }
  return out;
}

// normPath — strip a single leading `./` so `node ./s.cjs` matches a `> s.cjs`
// write target (structural same-file identity, not a lexical form).
function normPath(s) {
  return (s || "").replace(/^\.\//, "");
}

// tokenizeShellArgs — quote-aware whitespace split; strips surrounding quotes so
// a quoted script arg (`node "${TMPDIR:-/tmp}/x.cjs"`) is one token whose inner
// value compares byte-for-byte against the (also quote-stripped) write target.
// A shell VARIABLE inside the token (`${TMPDIR:-/tmp}`) is NEVER expanded (per
// hook-output-discipline.md MUST-3) — the match is TOKEN IDENTITY between the
// write target and the exec arg, which holds regardless of what the var expands
// to (both sides carry the identical unexpanded token).
function tokenizeShellArgs(str) {
  const toks = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      // Inside `"…"`, a backslash escapes the next char (so `\"` does NOT close
      // the quote); inside `'…'` there are no escapes.
      if (quote === '"' && c === "\\" && i + 1 < str.length) {
        cur += str[i + 1];
        i++;
        started = true;
        continue;
      }
      if (c === quote) quote = null;
      else cur += c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < str.length) {
      // unquoted backslash-escape: next char is a literal word char
      cur += str[i + 1];
      i++;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        toks.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) toks.push(cur);
  return toks;
}

// stripSurroundingQuotes — remove one matching pair of surrounding quotes.
function stripSurroundingQuotes(t) {
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

// splitUnquotedPipes — split a line on UNQUOTED `|` into pipeline stages. Quote-
// and backslash-aware so a `|` inside a quoted arg (`"a\"|b"`) or escaped (`\|`)
// does not split. `|&` (pipe stdout+stderr) is consumed as one operator so the
// following stage leads with `tee`, not `&`. `||` yields an empty stage
// (harmless). Used to find `tee` in command position within its pipe stage
// WITHOUT depending on whitespace around the pipe.
function splitUnquotedPipes(line) {
  const stages = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (quote === '"' && c === "\\" && i + 1 < line.length) {
        cur += line[i + 1]; // `\x` inside `"…"` — literal, quote stays open
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[i + 1]; // unquoted `\x` — the `x` is not an operator
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "|") {
      stages.push(cur);
      cur = "";
      if (line[i + 1] === "&") i++; // `|&` is one pipe operator
      continue;
    }
    cur += c;
  }
  stages.push(cur);
  return stages;
}

// SINK_VERBS — stdin/heredoc-consuming write verbs whose file operand(s) receive
// the heredoc body. A POSITIVE allowlist (a verb NOT listed is a documented
// residual, same class as the accepted residuals; forever-defense = signed-fold).
// `tee` writes to EVERY operand; `sponge`/`cp`/`install` write the operand from
// stdin (`… | sponge f`, `… | cp /dev/stdin f`, `… | install /dev/stdin f`). All
// non-flag, non-redirect operands are collected (over-approx toward fail-closed —
// e.g. `cp`'s `/dev/stdin` source is harmlessly included).
const SINK_VERBS = new Set(["tee", "sponge", "cp", "install"]);

// extractSinkTargets — file operands of a SINK_VERBS command in COMMAND position
// (the first token of a pipeline STAGE). Splitting on the unquoted pipe (not
// relying on whitespace) catches `| tee`, `|tee`, `|& tee`, `| sponge`,
// `| cp /dev/stdin`; keying on the STAGE-LEAD token keeps the verb appearing as a
// SEARCH ARG (`grep tee <<EOF`) from being read as the command.
function extractSinkTargets(line) {
  const out = [];
  for (const stage of splitUnquotedPipes(line)) {
    const toks = tokenizeShellArgs(stage);
    if (!toks.length) continue;
    const base = toks[0].replace(/^.*\//, ""); // basename: `/usr/bin/tee` → `tee`
    if (!SINK_VERBS.has(base)) continue;
    for (let j = 1; j < toks.length; j++) {
      const a = toks[j];
      if (!a || a === ";" || a === "&" || a === "&&") break;
      if (a.startsWith("-")) continue; // flags (`-a`, `--append`, `-t DIR` …)
      if (a.startsWith("<") || a.startsWith(">")) continue; // redirect operator token
      out.push(a); // file operand
    }
  }
  return out;
}

// extractRedirectTargets — ALL write targets on a line, across the heredoc-write
// surfaces: `>`/`>>` redirects (quoted or bare, every one), SINK_VERBS sinks
// (`tee`/`sponge`/`cp`/`install`, every operand), and a `dd of=FILE` sink.
// `2>&1`/`>&2` fd-dups carry a `&`-target excluded by the bare class, so they
// never capture. Returns the quote-stripped paths (possibly several — `tee a b`,
// `> a > b`), so the bundle pass blocks when ANY written file is executed. The
// write-surface allowlist is POSITIVE: a verb outside it (`patch`, `ed`, a
// mv-rename dataflow hop) is a documented residual, forever-defended by the
// signed-fold / fail-closed-to-L1 layer, not this interceptor.
function extractRedirectTargets(line) {
  const targets = [];
  const rx = /(?:\d+|&)?>>?\|?\s*("[^"]*"|'[^']*'|[^\s|;&<>()]+)/g;
  let m;
  while ((m = rx.exec(line)) !== null) {
    const t = stripSurroundingQuotes(m[1]);
    if (t) targets.push(t);
  }
  for (const t of extractSinkTargets(line)) targets.push(t);
  const dd = line.match(/\bdd\b[^\n]*?\bof=("[^"]*"|'[^']*'|[^\s|;&<>()]+)/);
  if (dd) {
    const t = stripSurroundingQuotes(dd[1]);
    if (t) targets.push(t);
  }
  return targets;
}

// parseHeredocSpans — line-based heredoc parser. Returns { heredocs, structural }
// where heredocs = [{ targets, body }] and structural is the command with every
// heredoc BODY and its closing-delimiter line removed (opener + post-close lines
// only) — the surface the RUN-half scan runs against. Closing-delimiter match is
// STRUCTURAL: a plain `<<DELIM` closes ONLY on a line that is EXACTLY `DELIM`
// (no leading whitespace); a `<<-DELIM` strips leading TABS only (never spaces).
//
// A candidate opener is committed as a heredoc ONLY IF its close line actually
// exists downstream. This is the load-bearing robustness invariant: a SPURIOUS
// opener (an arithmetic `1<<4`, a decoy `<<WORD` with no close, or a delimiter
// whose terminator was mis-derived) is IGNORED rather than swallowing the rest
// of the command into a phantom body that hides the RUN line. An unclosed
// heredoc therefore can only ADD lines to `structural`, never remove them —
// fail-toward-more-scanning. Each line's openers are tried in order; the first
// with a real close wins (so a decoy `<<X` before a real `<<EOF` on the SAME
// line does not mask the real one).
// PARSE_WORK_BUDGET bounds the ACTUAL close-lookahead work (per-iteration
// overhead + bytes compared), NOT a raw `<<` proxy. The close-lookahead is
// O(unclosed-openers × downstream-lines × line-length): a COMMITTED heredoc skips
// its body (`i = closeIdx + 1`), so a `<<`-dense DOC body costs ONE lookahead, not
// grind — which is why a raw-`<<`-count cap false-blocked such docs. A flood of
// UNCLOSED openers (each scanning to EOF), OR many openers over very long lines,
// is the real O(n²) DoS. When the measured work exceeds the budget, the parser
// returns `{ overflow: true }` and the caller fails CLOSED (a protected-path
// command this pathological is treated as a hit — the in-hook watchdog is cleared
// before detection). ~40M work-units ≈ well under 100 ms.
const PARSE_WORK_BUDGET = 40_000_000;

function parseHeredocSpans(command) {
  const lines = command.split("\n");
  const heredocs = [];
  const structuralLines = [];
  let work = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let opened = false;
    for (const opener of matchHeredocOpeners(line)) {
      const dash = opener.dash;
      const delim = opener.terminator;
      let closeIdx = -1;
      for (let k = i + 1; k < lines.length; k++) {
        const bl = lines[k].replace(/\r$/, "");
        work += 1 + bl.length; // per-iteration overhead + bytes compared
        if (work > PARSE_WORK_BUDGET) return { overflow: true };
        const closes = dash ? bl.replace(/^\t+/, "") === delim : bl === delim;
        if (closes) {
          closeIdx = k;
          break;
        }
      }
      if (closeIdx === -1) continue; // spurious opener (no close) — try next candidate
      structuralLines.push(line); // opener line stays structural
      heredocs.push({
        targets: extractRedirectTargets(line),
        body: lines.slice(i + 1, closeIdx).join("\n"),
      });
      i = closeIdx + 1; // resume after the close line (body + close removed)
      opened = true;
      break;
    }
    if (opened) continue;
    structuralLines.push(line);
    i++;
  }
  return { heredocs, structural: structuralLines.join("\n") };
}

// computeExecutedTokenSet — the set of normalized script tokens `structural`
// EXECUTES via an interpreter: for every segment (split on `\n` then top-level
// shell operators) that is interpreter-LED (after stripping a leading `VAR=val`
// prefix), every later token normalized. Computed ONCE per command (O(structural))
// so the per-heredoc / per-target membership checks in detectHeredocWriteRunBundle
// are O(1) — the previous per-heredoc re-scan was O(heredocs × structural) = O(H²),
// a pure availability DoS on H committed protected-body heredocs (the parse budget
// does not cover it because parsing itself stays cheap). A target is "executed"
// iff it is in this set — semantically identical to the old per-target scan.
function computeExecutedTokenSet(structural) {
  const set = new Set();
  const segs = structural.split("\n").flatMap((ln) => splitShellSegments(ln));
  for (const seg of segs) {
    const stripped = seg.replace(VAR_ASSIGN_PREFIX_RX, "");
    if (!RUN_INTERPRETER_RX.test(stripped)) continue;
    const toks = tokenizeShellArgs(stripped);
    for (let k = 1; k < toks.length; k++) {
      const np = normPath(toks[k]);
      if (np) set.add(np);
    }
  }
  return set;
}

// anyTargetExecuted — does any of `targets` (normalized) appear in the precomputed
// executed-token set? O(targets).
function anyTargetExecuted(execSet, targets) {
  for (const t of targets || []) {
    if (execSet.has(normPath(t))) return true;
  }
  return false;
}

/**
 * detectHeredocWriteRunBundle — flag the write+RUN-bundle described above.
 * Generic over `pathRx` (same contract as `detectStateFileMutation`). Returns
 * `{ layer, kind }` on a hit, or `null`.
 */
function detectHeredocWriteRunBundle(command, pathRx) {
  if (!command || !pathRx) return null;
  // Early exit: a flag REQUIRES the protected path to appear in the command
  // (PRIMARY reads it from a committed body ⊆ command; BACKSTOP from structural ⊆
  // command). Testing it first keeps every non-protected command O(n) — it never
  // enters the parser. Behaviour-neutral (both branches need the path present).
  if (!pathRx.test(command)) return null;
  // Fail-closed size cap: parseHeredocSpans bounds its own close-lookahead work
  // (PARSE_WORK_BUDGET — actual iterations + bytes, NOT a raw `<<` proxy, so a
  // `<<`-dense DOC body does not false-trip it). A protected-path command
  // pathological enough to blow the budget (an unclosed-opener flood, or many
  // openers over very long lines — a DoS / slow-hook amplifier since the in-hook
  // watchdog is cleared before detection) is treated as a hit rather than ground.
  const parsed = parseHeredocSpans(command);
  if (parsed.overflow) return { layer: 1, kind: "heredoc-write-run-bundle" };
  const { heredocs, structural } = parsed;
  // Executed-script token set — computed ONCE (O(structural)); the PRIMARY and
  // BACKSTOP membership checks below are then O(targets), never re-scanning
  // structural per heredoc (which was O(H²) — an availability DoS).
  const execSet = computeExecutedTokenSet(structural);
  // PRIMARY: a committed heredoc body carries the protected path AND that
  // heredoc's written script is executed. Precise + tight — the normal bundle.
  for (const hd of heredocs) {
    if (!hd.targets || !hd.targets.length) continue; // no write target (e.g. git-commit stdin)
    if (!pathRx.test(hd.body)) continue; // (a) protected path literal in the body
    if (anyTargetExecuted(execSet, hd.targets)) {
      // (b) one of the written scripts is executed by an interpreter in this command
      return { layer: 1, kind: "heredoc-write-run-bundle" };
    }
  }
  // BACKSTOP (fail-closed against ANY terminator/close-derivation divergence from
  // bash — an ANSI-C `$'\x46'` escape, an arithmetic `1<<4` opener, a `\r`-seeded
  // close line, or any future mis-parse this hand-written parser does not model
  // byte-identically). A divergence can only PUSH the real heredoc body — and its
  // RUN line — into `structural`: either the opener never commits (no close found
  // → whole span stays structural) or it commits with a truncated/empty body (a
  // seeded early close → the real body spills past it). So if the protected path
  // appears on a STRUCTURAL line AND a script WRITTEN on a structural line is
  // EXECUTED on a structural line, flag. This is the robust invariant the
  // per-body PRIMARY check cannot provide alone, because its `pathRx.test(hd.body)`
  // gate runs BEFORE the structural exec-scan and drops a truncated body first.
  //
  // It does NOT fire for well-formed doc/rule/test authoring — there the path
  // lives in the correctly-REMOVED body, absent from `structural` — nor for the
  // accepted var-indirect residual (the exec token differs from the write target,
  // so no target is in the executed-token set). It IS whole-command, NOT heredoc-scoped:
  // `structuralTargets` collects from a plain `>` redirect too, so the backstop
  // fires on a protected-mention + write+run bundle even with no heredoc at all.
  // It DOES fail-closed over-block the shape "a protected-path mention on a
  // command line (INCLUDING an allowed `cat <state>` read, or an `&&`-chained
  // build+inspect) AND a script write+run in ONE command" — this over-block is
  // wider than a purely contrived case; remediation is to split the command,
  // consistent with the separate-invocation ceremony contract. Never fires when
  // the executed file is NOT written in-command (`cat <state> && node other.js`
  // stays clean — `other.js` is not a structural write target).
  const structuralTargets = structural
    .split("\n")
    .flatMap((ln) => extractRedirectTargets(ln));
  if (
    structuralTargets.length &&
    pathRx.test(structural) &&
    anyTargetExecuted(execSet, structuralTargets)
  ) {
    return { layer: 1, kind: "heredoc-write-run-bundle" };
  }
  return null;
}

/**
 * detectStateFileMutationSegmentAware — segment-aware wrapper over
 * `detectStateFileMutation` that applies the git-commit-body exception PER
 * SEGMENT instead of to the whole command.
 *
 * Closes issue #745 Evasion 1: `git commit -m "wip" && rm <state-file>`.
 * The pre-#745 whole-command skip matched the leading `git commit … -m`
 * and returned `null` for the ENTIRE command (`[^|;]*` did not exclude
 * `&`), so the chained mutation ran undetected. Segment-awareness skips
 * ONLY the commit segment and runs mutation-detection on the rest.
 *
 * No false-positive regression (#745 AC): a state-file path MENTIONED
 * inside a quoted commit message (`git commit -m "cleanup && rm <state>"`)
 * is NOT split — the `&&` lives inside the double-quotes, so the whole
 * command stays one segment. That segment matches the commit-body
 * exception, so its QUOTED body is MASKED (not the whole segment skipped)
 * before detection: the mentioned path/verb becomes filler and does not
 * flag, while a REAL unquoted redirect/verb ON the commit line survives.
 *
 * Mask-instead-of-skip also closes the sibling of Evasion 1 — a redirect on
 * the commit segment itself (`git commit -m "x" > <state>`): the earlier
 * whole-segment skip let it through (same exploitation primitive as the
 * chained `&&`, just `>` in place of the operator); masking exposes the
 * unquoted redirect target to Layer-1 detection.
 *
 * F1/F2 (redteam-surfaced): masking assumes a quoted commit body is inert,
 * but `$(…)`/backtick command-substitution EXECUTES inside double quotes and
 * `$'…'` ANSI-C quoting desyncs the quote scan. When a commit segment
 * contains any of those (`EXECUTES_INSIDE_QUOTES_RX`), detection fails closed
 * by ALSO scanning the RAW (unmasked) segment — so `git commit -m "$(rm
 * <state>)"` and `git commit -m $'\'' && rm <state>` block. The commit-body
 * recognizer also accepts `-am`/attached-`-m`/`--message`/`--file` forms
 * (F3), so a legit commit whose message merely mentions a verb + state path
 * (`git commit -am "touch up <state> docs"`) is masked, not false-blocked.
 *
 * Evasion 2 (cd into the learning dir + bare-relative-path redirect) and a
 * glob-metacharacter redirect target (`> …/posture.jso[n]`) are NOT closed
 * here: they are the same accepted class as the `$IFS`/variable-path residual
 * documented in `state-file-write-guard.md` Rule 5 § "Known residuals" (a)/
 * (e)/(f) — the literal protected path is absent from the pre-expansion
 * command string, so closing it at the path-matcher layer would require
 * in-hook shell/glob expansion, forbidden by `hook-output-discipline.md`
 * MUST-3. The forever-defense for those paths is the signed-fold /
 * fail-closed-to-L1 integrity layer.
 *
 * Returns the first segment's `{ layer, kind }` hit, or `null`.
 */
function detectStateFileMutationSegmentAware(command, pathRx) {
  if (!command || !pathRx) return null;
  for (const segment of splitShellSegments(command)) {
    if (GIT_COMMIT_WITH_BODY_RX.test(segment)) {
      // Commit segment: mask its quoted message body (prose), then detect —
      // so a real unquoted redirect/verb on the commit line still flags while
      // a verb/path MENTIONED inside the quoted message does not.
      const maskedHit = detectStateFileMutation(
        maskQuotedSpans(segment),
        pathRx,
      );
      if (maskedHit) return maskedHit;
      // Fail-closed (#745 F1/F2): `$(…)` / backtick command-substitution
      // EXECUTES inside double quotes, and `$'…'` desyncs the quote scan —
      // masking wrongly treats these as inert. When present, re-scan the RAW
      // (unmasked) segment so a mutation carried by the construct is caught.
      if (EXECUTES_INSIDE_QUOTES_RX.test(segment)) {
        const rawHit = detectStateFileMutation(segment, pathRx);
        if (rawHit) return rawHit;
      }
    } else {
      // Non-commit segment: detect as-is.
      const hit = detectStateFileMutation(segment, pathRx);
      if (hit) return hit;
    }
  }
  // #764 item 3 — whole-command heredoc write+RUN-bundle pass. The per-segment
  // loop above cannot see this class: `splitShellSegments` is not heredoc-aware,
  // so the heredoc body's internal `;` fractures the write from the run across
  // sibling segments. This pass reconstructs the heredoc structurally and
  // matches the write→execute conjunction on the FULL command.
  const bundleHit = detectHeredocWriteRunBundle(command, pathRx);
  if (bundleHit) return bundleHit;
  return null;
}

// F29 — MUST-6 verbatim-quote detector (value-prioritization.md MUST-6, 2026-05-23)
//
// Detects: a journal entry's frontmatter declares `references: [<ID>, ...]`
// citing prior journals, but the journal's body contains NO block-quote line
// (markdown `>`) that appears as a contiguous substring of EVERY cited
// journal's content. MUST-6 requires "path + section + verbatim sentence";
// this detector enforces the verbatim half lexically.
//
// Severity: advisory (lexical detector per hook-output-discipline.md MUST-2).
// The probe-driven gate-review counterpart per probe-driven-verification.md
// MUST-4 runs at cc-architect at /codify (reviewer judges whether the cited
// anchors are genuinely materialized verbatim).
//
// Parameters:
//   journalPath: absolute or repo-relative path to a recently-written
//                journal/NNNN-*.md file.
//   options.journalDir: optional override for the directory containing
//                cited journals (default: the same directory as journalPath).
//                Used by audit fixtures to set up isolated temp layouts.
//
// Returns: a finding object when ANY cited journal has zero matching
//          verbatim block-quotes; null when all cited journals are covered
//          OR when there are no references to verify.
// Resource caps applied per security-reviewer R1 findings (2026-05-23):
//   MEDIUM-2: file-size cap before readFileSync (DoS class)
//   MEDIUM-3: refIds-array cap + readdirSync cache (O(N×M) → O(N+M))
// Quote-length floor from cc-architect MED-3 (anti-trigram-evasion):
//   MUST6_MIN_QUOTE_CHARS (defined inside function body, used at extraction).
const MUST6_MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MUST6_MAX_REFS = 50;

// Normalize whitespace + smart-quotes for substring matching per analyst
// FM-E. Collapses runs of whitespace to a single space; normalizes smart-
// quote codepoints (U+2018/U+2019/U+201C/U+201D) to ASCII ' and ".
function _normalizeQuoteText(s) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Cross-directory cited-journal resolution (analyst FM-D). When the new
// journal lives in `workspaces/<name>/journal/`, fall back to the
// repo-root `journal/` directory if the cited NNNN isn't found locally.
// Returns the list of candidate journal directories to search, in order.
function _candidateJournalDirs(journalPath, explicitOverride) {
  if (explicitOverride) return [explicitOverride];
  const dirs = [path.dirname(journalPath)];
  // If the journal lives in a workspaces/<name>/journal/ subtree, also
  // search the repo-root journal/ dir (cross-workspace + cross-root refs).
  const posix = journalPath.replace(/\\/g, "/");
  const wsMatch = posix.match(/^(.*?)\/workspaces\/[^/]+\/journal\/\d{3,4}-/);
  if (wsMatch) {
    const repoRoot = wsMatch[1];
    const rootJournal = path.join(repoRoot, "journal");
    if (rootJournal !== dirs[0]) dirs.push(rootJournal);
  }
  return dirs;
}

// HIGH-1: only operate on journal paths that resolve under <repo>/journal/
// or <repo>/workspaces/*/journal/. Without this guard a malicious
// PostToolUse(Write) on /etc/journal/0001-x.md would make the detector
// read from /etc.
function isJournalPathInScope(journalPath) {
  const norm = path.normalize(journalPath);
  // Acceptable: any path whose POSIX-style dirname matches journal/ or
  // workspaces/*/journal/. Use posix normalization for cross-platform
  // consistency in the regex match.
  const posix = norm.replace(/\\/g, "/");
  return (
    /(^|\/)journal\/\d{3,4}-[^/]+\.md$/.test(posix) &&
    (/(^|\/)journal\/\d{3,4}-[^/]+\.md$/.test(posix) ||
      /(^|\/)workspaces\/[^/]+\/journal\/\d{3,4}-[^/]+\.md$/.test(posix))
  );
}

function detectMust6Paraphrase(journalPath, options) {
  if (!journalPath || typeof journalPath !== "string") return null;
  const opts = options || {};
  // HIGH-1: path-scope allowlist. Silently no-op for out-of-scope paths;
  // the hook is best-effort, not a permission gate. Test escape-hatch:
  // when an explicit `options.journalDir` is supplied, trust the caller
  // (audit fixtures use temp dirs without `journal/` in the layout).
  if (!opts.journalDir && !isJournalPathInScope(journalPath)) return null;
  // MEDIUM-2: size guard before reading.
  let stat;
  try {
    stat = fs.statSync(journalPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MUST6_MAX_FILE_BYTES) return null;
  let bodyRaw;
  try {
    bodyRaw = fs.readFileSync(journalPath, "utf8");
  } catch {
    return null; // file unreadable — nothing to verify
  }
  // Parse YAML frontmatter — extract `references:` array. Frontmatter is
  // bounded by `---` fences at the start of the file.
  const fmMatch = bodyRaw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null; // no frontmatter — nothing to verify
  const frontmatter = fmMatch[1];
  const body = fmMatch[2];
  // Extract `references:` list. Accept inline-array form (`references: ["0150", "0149"]`)
  // and YAML-block form (multi-line bullets).
  const refIds = [];
  // Inline form: references: [ID1, ID2] (with optional quotes)
  const inlineMatch = frontmatter.match(/^references:\s*\[([^\]]*)\]\s*$/m);
  if (inlineMatch) {
    const items = inlineMatch[1].split(",");
    for (const it of items) {
      const m = it.match(/["']?(\d{3,4})["']?/);
      if (m) refIds.push(m[1]);
      if (refIds.length >= MUST6_MAX_REFS) break;
    }
  } else {
    // YAML-block form:
    //   references:
    //     - "0150"
    //     - "0149"
    const blockMatch = frontmatter.match(
      /^references:\s*\n((?:\s*-\s*["']?\d{3,4}["']?.*\n?)+)/m,
    );
    if (blockMatch) {
      const lines = blockMatch[1].split("\n");
      for (const ln of lines) {
        const m = ln.match(/^\s*-\s*["']?(\d{3,4})["']?/);
        if (m) refIds.push(m[1]);
        if (refIds.length >= MUST6_MAX_REFS) break;
      }
    }
  }
  if (refIds.length === 0) return null; // no refs — nothing to verify

  // Extract block-quote lines from the body — lines starting with `>`
  // (after optional indent). Trim the leading `>` and surrounding
  // whitespace; require ≥30 chars per cc-architect MED-3 to prevent
  // trigram-substring false-positives (e.g. `> the only valid` matching
  // any prose containing that phrase).
  const MUST6_MIN_QUOTE_CHARS = 30;
  const quoteLines = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*>\s?(.*)$/);
    if (m) {
      const q = m[1].trim();
      if (q.length >= MUST6_MIN_QUOTE_CHARS) quoteLines.push(q);
    }
  }

  // Resolve candidate journal directories per analyst FM-D — walk parent
  // dirs when the new journal lives in workspaces/<name>/journal/.
  const candidateDirs = _candidateJournalDirs(journalPath, opts.journalDir);

  // MEDIUM-3: cache readdirSync ONCE per candidate dir before the refIds
  // loop (was O(N×M)).
  const dirEntries = [];
  for (const d of candidateDirs) {
    try {
      dirEntries.push({ dir: d, entries: fs.readdirSync(d) });
    } catch {
      // skip unreadable candidate
    }
  }
  if (dirEntries.length === 0) return null;

  // Pre-normalize quoteLines once for cross-journal comparison (FM-E).
  const normalizedQuotes = quoteLines.map(_normalizeQuoteText);

  // For each cited journal ID, check whether ≥1 block-quote line from the
  // new journal appears as a contiguous substring of the cited journal.
  const verified = [];
  const unverified = [];
  for (const refId of refIds) {
    const padded = String(refId).padStart(4, "0");
    let citedPath = null;
    for (const { dir, entries } of dirEntries) {
      const hit = entries.find(
        (e) => e.startsWith(padded + "-") && e.endsWith(".md"),
      );
      if (hit) {
        citedPath = path.join(dir, hit);
        break;
      }
    }
    if (!citedPath) continue; // cited journal not found in any candidate dir
    // MEDIUM-2: size guard for cited file too.
    let citedStat;
    try {
      citedStat = fs.statSync(citedPath);
    } catch {
      continue;
    }
    if (!citedStat.isFile() || citedStat.size > MUST6_MAX_FILE_BYTES) continue;
    let citedContent;
    try {
      citedContent = fs.readFileSync(citedPath, "utf8");
    } catch {
      continue;
    }
    // FM-E: substring match against normalized text on both sides.
    const normalizedCited = _normalizeQuoteText(citedContent);
    const hasMatch = normalizedQuotes.some((q) => normalizedCited.includes(q));
    if (hasMatch) verified.push(refId);
    else unverified.push(refId);
  }

  if (unverified.length === 0) return null;

  // LOW-4: scrub absolute path → basename in evidence to avoid leaking
  // operator workspace context (per upstream-issue-hygiene.md MUST-2).
  // Evidence enrichment (analyst): include verified[] + unverified[] +
  // quote_count so reviewer can re-derive the partial-honoring shape
  // without re-reading both journals.
  const safeName = path.basename(journalPath);
  return {
    rule_id: "value-prioritization/MUST-6",
    severity: "advisory",
    evidence: `journal ${safeName} cites ${unverified.join(", ")} but contains no verbatim substring from ${unverified.length === 1 ? "it" : "them"} (verified: ${verified.length ? verified.join(", ") : "none"}; quote_count: ${quoteLines.length})`,
    detection_layer: "lexical",
    verified,
    unverified,
    quote_count: quoteLines.length,
  };
}

module.exports = {
  detectPreExistingNoSha,
  detectRepoScopeDriftText,
  detectRepoScopeDriftBash,
  hasCrossRepoAuthorizationReceipt,
  classifyCrossRepoIntent,
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
  detectStateFileMutationSegmentAware,
  detectHeredocWriteRunBundle,
  splitShellSegments,
  detectMust6Paraphrase,
};
