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
// loom#1462 — THE shared allowlist for every `git` a guard spawns. Adds NO new
// file to the shipped closure: `.claude/hooks/**` is ALWAYS_INCLUDE, and
// validate-bash-command.js already loads this module transitively via
// lib/guard-path-scope.js, so it is in-process before this file is required.
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

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
  // THE shared guard-git allowlist (loom#1462), same as the ref probe below.
  // These two spawns pre-date that module and were still passing no `env:` with
  // a bare binary name — `security.md` § Enforcement-Surface Parity puts them in
  // the same change as the new one rather than leaving the file with one surface
  // routed and two not. An unresolvable git returns null, and BOTH call sites in
  // detectRepoScopeDriftBash (the `origin` and `upstream` allowances) test
  // `slug && slug === targetSlug`, so null makes neither allowance fire and the
  // guard FLAGS — null already ranks TIGHTEST here, as that module's caller
  // contract requires.
  //
  // WHY THE ROUTING IS WORTH ITS COST HERE SPECIFICALLY. Unrouted, an ambient
  // `GIT_DIR` pointing at ANY repo whose `origin` is the cross-repo TARGET makes
  // `origin === targetSlug` true — the own-origin allowance fires and the
  // cross-repo scope fence is BYPASSED. That is a fence bypass, not a nuisance.
  //
  // ACCEPTED RESIDUAL, measured, not reasoned. `gitEnv()` sets
  // `GIT_CONFIG_GLOBAL=/dev/null`, which also discards `url.<base>.insteadOf`
  // rewrites, and `git remote get-url` applies those. Observed in a scratch repo
  // with remote `gh:Org/Repo` and a global `url."https://github.com/".insteadOf
  // "gh:"`:
  //
  //   $ git remote get-url origin                              → https://github.com/Org/Repo
  //   $ GIT_CONFIG_GLOBAL=/dev/null … git remote get-url origin → gh:Org/Repo
  //
  // The second does not normalize (normalizeRepoSlug is github.com-shaped), so an
  // operator who uses an `insteadOf` remote loses the own-origin allowance and
  // gets a halt on their OWN repo. TIGHTER, never more permissive — but it is a
  // real false positive for that operator class, traded knowingly against the
  // fence bypass above. Closing it needs normalizeRepoSlug to understand alias
  // remotes, which is a separate change.
  const gitBin = resolveGitBinary();
  if (!gitBin) return null;
  try {
    const url = execFileSync(gitBin, ["remote", "get-url", remoteName], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
      env: gitEnv(),
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
  // Shared allowlist, as readRemoteSlug above. Null propagates to
  // hasCrossRepoAuthorizationReceipt's `if (!root) return false` — no receipt
  // found, so the cross-repo action is NOT cleared. Fail-closed, tightest.
  const gitBin = resolveGitBinary();
  if (!gitBin) return null;
  try {
    return execFileSync(gitBin, ["rev-parse", "--show-toplevel"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
      env: gitEnv(),
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

// Fail-closed size cap for the #1319/#1320 quote-mask FP-reduction (same discipline
// as parseHeredocSpans' PARSE_WORK_BUDGET). maskQuotedSpans is a linear char scan but
// pays a per-command cost; on a pathologically huge command (a 20k-heredoc DoS shape,
// ~1 MB) the mask is skipped and detection falls back to the RAW pre-#1319 path —
// fail-closed (over-block on repo-drift halt-and-report / state-file block, never
// under-block). A REAL interpreter-body false positive (`node -e '…'`) is < a few KB,
// far under this cap, so the FP fix is fully active for every realistic command.
const MASK_QUOTE_BUDGET = 16384;

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
  // #1320 — neutralize a doc-carrier's argument PAYLOAD (a `gh issue/pr
  // create|edit --body/--body-file/--field/-F` heredoc or quoted body) BEFORE
  // the split, so a `gh … --repo other` quoted as a DOCUMENTATION example inside
  // that body is opaque data (never segment-leading, never found by
  // `_ghSegmentTarget`). The mask touches ONLY body-flag payloads — never a
  // `--repo` value — so a real cross-repo target still extracts. Shared with
  // `detectStateFileMutationSegmentAware` (#1319-D2) per security.md
  // § Enforcement-Surface Parity: ONE helper, so the two guards cannot drift.
  const masked = maskDocCarrierPayloads(joined);
  // #1319/#1320 systemic FP fix — an interpreter body (`node -e '…'`, `python3 -c
  // "…"`) is NOT a gh/echo/printf doc-carrier, so maskDocCarrierPayloads leaves it
  // intact; a `gh … --repo other` quoted INSIDE such a body (a multi-line
  // documentation example) then LEADS a fractured segment after the newline split
  // and FALSE-blocks. Fix (the same masked-operator / raw-operand discipline
  // detectStateFileMutation uses): quote-mask the command with the length-preserving
  // maskQuotedSpans (in-quote content — INCLUDING in-quote newlines — → filler), use
  // it to derive SEGMENT BOUNDARIES and confirm the `gh` command word is UNQUOTED,
  // but extract the `--repo` target from the RAW (doc-masked) text at the SAME
  // offsets so a REAL quoted target (`gh --repo "other/repo"`, a receipt-authorized
  // `--repo "own/repo"`) is unaffected and still extracts + honors origin/receipt.
  // A `gh` inside a quoted body is filler in the mask → never leads a segment →
  // correctly ignored. maskQuotedSpans is char-for-char length-preserving, so the
  // quote-masked and raw slices align 1:1. Splitting on the quote-masked string also
  // (correctly) stops splitting on a `;`/`&`/`|` that lives INSIDE a quoted body.
  // Build aligned (QUOTE-MASKED seg, RAW seg) pairs. The quote-masked string gives
  // the OUTSIDE-quote segment boundaries + an UNQUOTED-`gh`-lead check (a `gh` inside
  // a quoted interpreter body is filler → never leads), while the RAW (doc-masked)
  // segment preserves a real quoted `--repo "other/repo"` value for extraction. Over
  // the DoS size budget the mask is skipped and each `[;&|\n]`-split segment is its
  // own raw pair (the pre-#1319 behavior) — built by ONE `split`, never 60k
  // `slice()` calls (which is what made the guarded path O(n²) on a 20k-heredoc DoS).
  //
  // EXECUTES fail-closed — PER-SEGMENT gating (#1325; enforcement-surface parity
  // with detectStateFileMutation's per-line `EXECUTES_INSIDE_QUOTES_RX` fallback,
  // the #1321 desync class). The quote-mask gives the primary OUTSIDE-quote segment
  // boundaries (a quoted `;` in `--title "x;y"` is filler → never fractures, the
  // #1319 fix). The EXECUTES fail-close is then applied PER SEGMENT, not to the
  // WHOLE command: only a segment whose QUOTE-MASKED form still carries an
  // executing/ANSI-C construct downgrades to a raw `[;&|\n]` re-split.
  //
  // WHY test the QUOTE-MASKED segment (not the raw one): maskQuotedSpans does NOT
  // honor `$'…'` (its header flags this divergence), so a `$'…'` leaves the mask
  // stuck in an OPEN single-quote — but the `$'` itself SURVIVES in the mask (the
  // `$` + opening `'` are copied), so `EXECUTES_INSIDE_QUOTES_RX` still sees it and
  // the segment fails closed to a raw re-split → a real `; gh … --repo` after the
  // desync still LEADS a flagged raw segment (invariant D). A benign
  // `--body "$(…)"` payload, by contrast, has its `$(` MASKED to filler inside the
  // double-quoted value (maskDocCarrierPayloads leaves executing bodies intact, but
  // maskQuotedSpans then masks the quoted span), so the quote-masked segment does
  // NOT trip EXECUTES → no re-split → the quoted `;` in a sibling `--title "x;y"` is
  // NOT re-fractured. That is the whole-command miss this fix closes: previously ANY
  // `$(…)` anywhere downgraded the ENTIRE command to a raw split that fractured the
  // quoted `;`. A top-level (unquoted) `$(…)` stays visible in the mask and still
  // fails closed, but the re-split is localized to its OWN segment — a sibling
  // quoted `;` in a DIFFERENT segment is unaffected (strictly lower blast radius
  // than the whole-command downgrade). Over the DoS budget the whole command uses
  // the pre-#1319 raw split (fail-closed).
  const segPairs = [];
  if (masked.length <= MASK_QUOTE_BUDGET) {
    const quoteMasked = maskQuotedSpans(masked);
    let st = 0;
    for (let i = 0; i <= quoteMasked.length; i++) {
      const c = i < quoteMasked.length ? quoteMasked[i] : null;
      if (c === null || c === ";" || c === "&" || c === "|" || c === "\n") {
        const qSeg = quoteMasked.slice(st, i);
        const rSeg = masked.slice(st, i);
        if (EXECUTES_INSIDE_QUOTES_RX.test(qSeg)) {
          // This segment carries an executing/ANSI-C construct the quote-mask
          // cannot be trusted around → fail closed to a raw re-split so a real
          // `; gh … --repo` after a `$'…'` desync still leads a flagged segment.
          for (const raw of rSeg.split(/[;&|\n]/)) segPairs.push([raw, raw]);
        } else {
          segPairs.push([qSeg, rSeg]);
        }
        st = i + 1;
      }
    }
  } else {
    for (const seg of masked.split(/[;&|\n]/)) segPairs.push([seg, seg]);
  }
  const cwdBase = path.basename(cwd || process.cwd());
  for (const [qSegRaw, rawSeg] of segPairs) {
    // LEAD check on the quote-masked segment: the `gh` command word must be UNQUOTED
    // (a `gh` inside a quoted interpreter body is filler here → not gh-leading →
    // skipped). Optionally after a subshell `(` and/or env-assign prefixes.
    const qSeg = qSegRaw.trim();
    if (!/^\(*\s*(?:\w+=\S+\s+)*gh\s/.test(qSeg)) continue;
    // Extract from the RAW (doc-masked) segment so a real quoted `--repo` value survives.
    const s = rawSeg.trim();
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

// STATE_INTERP_WRITE_RX — positive write-verb/write-mode allowlist for the
// Layer-3 read-vs-write gate (#1292). Layer 3 is a MUTATION detector: it fires
// on an interpreter body ONLY when the body carries a WRITE token AND the
// protected path. A read-only interpreter body (`readFileSync`, `json.tool`,
// `JSON.parse(open(p).read())`) references the path but carries no write token,
// so it PASSES — closing the over-block that hard-blocked routine JSONL
// inspection (`cat` cannot parse/filter JSONL).
//
// Function-agnostic BY DESIGN — it matches the WRITE VECTOR, not the API name:
//   • comma-quoted write MODE  ,'w' / ,"a+" / ,'r+'  → open / openSync /
//     File.open / File.new / io.open / fdopen in ONE term. The mode grammar is
//     a TIGHT fullmatch between the quotes, so an English word (`,'war'`) or a
//     read-only mode (`,'r'` / `,'rb'`) does NOT match (only w/a families and
//     the read-WRITE `r+` family qualify).
//   • node stream/file writers  writeFile(Sync) / createWriteStream /
//     appendFile(Sync)   ([Ww]riteFile | WriteStream | [Aa]ppendFile)
//   • POSIX open-flag barewords  O_WRONLY | O_RDWR | O_TRUNC | O_APPEND | O_CREAT
//     (covers `fs.openSync(p, O_WRONLY|O_TRUNC)` / `os.open` / perl `sysopen`)
//   • python fileinput in-place  inplace=True
//   • call-anchored write ops  syswrite | unlink | rename | truncate  (+ their
//     `…Sync` forms via an optional `(?:Sync)?` — `renameSync`/`unlinkSync`/
//     `truncateSync`, the common one-liner forgery form; each `\b`-anchored so a
//     verb-PREFIXED identifier like `renamed_files` or `truncated` does NOT
//     match — the FP the redteam surfaced)
//   • perl read-write open  +<
//
// A positive allowlist is never exhaustive. The honest post-fix claim is
// "every ALLOWLISTED write blocks" — an `mmap` / custom-helper (e.g. a project
// `appendStamped()` wrapper) write is a documented residual, forever-defended
// by the signed-fold / fail-closed-to-L1 integrity layer, never this command
// interceptor. See `state-file-write-guard.md` Rule 5 § Layer 3 + § "Known
// residuals" (i). NUMERIC OPEN FLAGS are no longer part of that residual: the
// group-(1) numeric-flag pattern below covers the `open`-family CALL surface
// (`openSync`/`sysopen`/`open`, plus python `os.open` via group (4)), so
// `openSync(p, 577)` blocks on its own. A numeric flag reaching a write by some
// OTHER route — a bare fd from a helper, an `mmap` — stays residual.
//
// #1337 UNDER-BLOCK CLOSURE. The original #1292 allowlist enumerated ~8 write
// vectors, which left the MAJORITY of each interpreter's real mutation surface
// un-gated: `fs.rmSync` / `copyFileSync` / `cpSync` / `chmodSync` / `writeSync`,
// python `os.remove` / `os.replace` / `shutil.*` / `pathlib.write_text` /
// `open(p, mode='w')` / `Path(p).open('w')`, ruby `File.write` / `File.delete` /
// `IO.write` / `FileUtils.*`, and — worst — perl's CANONICAL write form, the
// 2-/3-arg shell-mode open (`open(FH, ">", $p)`), whose `'>'` mode string the
// old comma-quoted MODE grammar (`[wa]`/`r+` families only) did not admit. Each
// was a live authority-state forgery path that reached the file untouched
// (empirically confirmed against the real hook before this change: 37 of the
// mutation corpus's cases returned exit 0 / continue:true). The vector list
// below is grouped BY SURFACE so a future language/API addition has an obvious
// home; every entry stays flat + backreference-free + bounded, so the whole
// alternation remains linear-time (the ReDoS fixtures pin this).
const STATE_INTERP_WRITE_SOURCES = [
  // ── (1) WRITE MODE + OPEN FLAGS — language-agnostic `open` surface ──
  // comma-quoted mode: open/openSync/File.open/File.new/io.open/fdopen/sysopen.
  // TIGHT fullmatch between the quotes, so an English word (`,'war'`) or a
  // read-only mode (`,'r'`/`,'rb'`) does NOT match — only the w/a/x families
  // and the read-WRITE `r+` family qualify.
  String.raw`,\s*['"](?:[wax][bt]?\+?b?|r[bt]?\+b?)['"]`,
  // python keyword mode: `open(p, mode='w')` (comma-quoted grammar misses it —
  // the token after the comma is `mode=`, not a quote).
  String.raw`\bmode\s*=\s*['"](?:[wax][bt]?\+?b?|r[bt]?\+b?)['"]`,
  // mode as the FIRST positional arg: `pathlib.Path(p).open('w')`, `f.open('a')`.
  String.raw`\bopen\s*\(\s*['"](?:[wax][bt]?\+?b?|r[bt]?\+b?)['"]`,
  // perl/ruby SHELL-mode open — the canonical perl write. 3-arg `open($fh, '>',
  // $p)` / `open($fh, '>>', $p)` and 2-arg `open(FH, ">$p")`.
  String.raw`,\s*['"]\s*\+?>>?`,
  // perl read-write open.
  String.raw`\+<`,
  // POSIX open-flag barewords (`fs.openSync(p, O_WRONLY|O_TRUNC)`, `os.open`,
  // perl `sysopen`).
  String.raw`\bO_(?:WRONLY|RDWR|TRUNC|APPEND|CREAT|EXCL)\b`,
  // NUMERIC open flags — the bareword line above matches the O_* SPELLING only,
  // so the numerically-equivalent call evades it while opening the same
  // write-capable fd: `fs.openSync(p, 577)` is O_WRONLY|O_CREAT|O_TRUNC. (The
  // python spelling `os.open` is independently covered by the group-(4)
  // module-qualified list, numeric or not.) Gated on the WRITE-CAPABLE FLAG
  // SURFACE — an `open`-family CALL whose flag argument is a numeric literal —
  // never on bare digits anywhere in the command, so `readSync(fd, buf, 0,
  // 1024, 0)` and `d['a']+d['b']` stay clean. All four literal bases are
  // covered (`577`, `0x241`, `0o1101`, `0b1001000001` — a base the flag list
  // missed is a free evasion), and the trailing `\b` rather than `[,)]` admits
  // the assembled form `openSync(p, 1|64|512)`, which anchoring on the closing
  // punctuation would have let through. Numeric `0` (O_RDONLY) is deliberately
  // INCLUDED: a numeric flag argument is itself the evasion tell, and honest
  // read code spells the mode `'r'`.
  //
  // Argument POSITION is what keeps python's third-arg `buffering` clean: for
  // `open`/`openSync` the flag is the argument immediately after the path, so
  // the run is `[^,)]` (it cannot cross a comma) and `open(p,'r',8192)` finds
  // no numeric in the tested position. perl's `sysopen(FH, $path, $flags)` puts
  // flags THIRD, so it gets its own pattern whose run may cross commas.
  String.raw`\b(?:openSync|open)\s*\(\s*[^,)]{0,200}?,\s*(?:0[xX][0-9A-Fa-f]{1,16}|0[bB][01]{1,64}|0[oO][0-7]{1,22}|[0-9]{1,20})\b`,
  String.raw`\bsysopen\s*\([^)]{0,200}?,\s*(?:0[xX][0-9A-Fa-f]{1,16}|0[bB][01]{1,64}|0[oO][0-7]{1,22}|[0-9]{1,20})\b`,

  // ── (2) NODE fs WRITE APIs (name-anchored) ──
  String.raw`[Ww]riteFile`,
  String.raw`WriteStream`,
  String.raw`[Aa]ppendFile`,
  // fd-based writes. Anchored on the fs-only spellings — a BARE `write\s*\(`
  // would false-match `process.stdout.write(` in a read-only body.
  String.raw`\bwrite(?:v|Sync|vSync)\b`,

  // ── (3) DESTRUCTIVE / REPLACEMENT ops ──
  // Barewords that are NOT common English keep the plain `\b` form (so a
  // verb-PREFIXED identifier like `renamed_files` / `truncated` still does not
  // match); the rest are CALL-anchored (`\s*\(`) so prose keeps passing —
  // `node -e 'const s="rm <state>"'` must stay clean.
  String.raw`\b(?:syswrite|unlink|rename|truncate|ftruncate)(?:Sync)?\b`,
  String.raw`\brm(?:Sync|dir|dirSync)?\s*\(`,
  String.raw`\b(?:copyFile|copyfile|cp)(?:Sync)?\s*\(`,
  String.raw`\b(?:chmod|chown|lchown|lchmod|utimes|lutimes|futimes|mkdir|symlink|link)(?:Sync)?\s*\(`,

  // ── (4) PYTHON module-qualified mutators + the IN-PLACE-EDIT body tokens ──
  // (the ARGV-side `-i` sibling of these lives in STATE_INTERP_INPLACE_RX)
  String.raw`\bos\.(?:remove|removedirs|unlink|rmdir|replace|rename|renames|truncate|ftruncate|chmod|chown|lchown|utime|link|symlink|open|fdopen|write|makedirs|mkdir)\b`,
  String.raw`\bshutil\.(?:copy|copy2|copyfile|copyfileobj|copytree|copymode|copystat|move|rmtree|chown|unpack_archive|make_archive)\b`,
  String.raw`\bwrite_(?:text|bytes)\b`,
  // `fileinput.input(p, inplace=<truthy>)` rewrites the file in place. Keying on
  // the literal `True` missed every other truthy spelling — `inplace=1`,
  // `inplace=2`, `inplace=flag` — each of which enables the SAME rewrite. So the
  // test is inverted: match the kwarg unless its value is a FALSY literal
  // (`False` / `None` / `0` / `""`). The trailing `[^\s=]` requires a real value
  // character AND excludes the read-only comparison `inplace == True`. A python
  // body that merely mentions the word (`d.get('inplace')`) has no `=` after it
  // and stays clean; a local `inplace = False` is falsy and stays clean.
  String.raw`\binplace\s*=\s*(?!False\b|None\b|0[^\w.]|0$|['"]['"])[^\s=]`,
  // perl's in-place-edit variable — the body-side sibling of python's `inplace=`
  // above and of the ARGV `-i` flag. `perl -pe 'BEGIN{$^I=".bak"} s/a/b/' <path>`
  // rewrites the file with NO `-i` in ARGV and no write API in the body, so
  // neither STATE_INTERP_INPLACE_RX nor any token above sees it. `$INPLACE_EDIT`
  // is the same variable's `use English` alias. Assignment only — `(?!=)` keeps
  // the read-only comparison `$^I == 1` clean.
  String.raw`\$(?:\^I|INPLACE_EDIT)\s*=(?!=)`,

  // ── (5) RUBY mutators ──
  // `File.open` / `File.new` are deliberately ABSENT — they are mode-gated by
  // group (1), because `File.open(p).read` is a legitimate READ.
  String.raw`\bFile\.(?:write|binwrite|delete|unlink|rename|truncate|chmod|chown|utime|symlink|link|mkfifo)\b`,
  String.raw`\bIO\.(?:write|binwrite|copy_stream)\b`,
  String.raw`\bFileUtils\.(?:rm\w*|remove\w*|cp\w*|copy\w*|mv|move|touch|install|ln\w*|link\w*|symlink\w*|chmod\w*|chown\w*|mkdir\w*|mkpath|makedirs)\b`,

  // ── (6) SHELL-OUT FROM INSIDE THE BODY — the interpreter becomes a shell,
  // so the inner command is a write vector this scanner cannot analyze ──
  // NB — each alternative carries its OWN trailing anchor. A single `\b` after
  // the group would break `subprocess\.\w` (the `\w` lands mid-identifier, where
  // no word boundary exists).
  String.raw`\b(?:os\.system\b|subprocess\.\w|child_process\b|exec(?:File)?Sync\b|spawn(?:Sync)?\b|Popen\b|popen\b)`,
  // ruby/perl bare `system("…")` — needs the string-literal arg so a bare
  // `system` identifier in a read body does not match.
  String.raw`\bsystem\s*\(\s*['"]`,
  // QUOTE-LIKE shell-out operators. The backtick spelling is already covered
  // (Layer 1 sees the redirect; `IO.popen`/`popen` are listed above), but each
  // language also spells command-substitution as a quote-like literal that
  // carries NO backtick and NO call syntax: ruby `%x{…}` and perl `qx{…}`.
  // `ruby -e '%x{echo x > <path>}'` shells out and writes with nothing above
  // matching. `%x` accepts any of its delimiters here, but the trailing
  // `[^%"']` is a format-string discriminator: a real shell-out opens with a
  // COMMAND character, whereas a printf conversion either continues with
  // another `%` (`"%x/%x"`, `"%x(%d)"`) or closes its quote (`"%x/"`). Without
  // it, `%x` + `(` would false-match the plausible hex-then-decimal format.
  // ALL FOUR bracketing pairs are listed, `<…>` included: both languages accept
  // it, and a delimiter the class omits is a free evasion (the inner `>` is no
  // help — inside the interpreter's quoted body it is masked, so Layer 1 never
  // sees it as a redirect).
  String.raw`%x[\{\(\[</!|~][^%"']`,
  // perl `qx{…}` / `qx(…)` / `qx[…]` / `qx<…>` / `qx/…/` / `qx!…!` / `qx#…#`.
  // The sigil lookbehind keeps a VARIABLE named qx clean — `$qx/2` is division,
  // `@qx[0]` is a slice — and the delimiter class keeps an identifier such as
  // `qx_count` clean (`_` is not a delimiter).
  String.raw`(?<![\w$@%&])qx[\{\(\[</!#|~]`,

  // ── (7) DYNAMIC DISPATCH / OBFUSCATION — an un-analyzable body in a command
  // that names authority state fails CLOSED (the tie-breaker: a wrongly-blocked
  // read has a documented `cat` workaround; a wrongly-allowed write defeats the
  // guard). The concat form is the tell: a bracket member-access whose key is
  // built by `+` (`fs['write'+'FileSync']`, `f['app'+'endFile'+'Sync']`) — it is
  // near-zero in honest code, while a NON-concatenated `fs['readFileSync']`
  // still reads clean (its literal name carries no write token). ──
  String.raw`\[\s*['"][^'"\]]{0,64}['"]\s*\+`,
  String.raw`\b(?:eval\s*\(|new\s+Function\s*\()`,
  String.raw`\b(?:__import__\s*\(\s*['"](?:os|shutil|subprocess|io|pathlib|tempfile)['"]|getattr\s*\(\s*(?:os|io|shutil|pathlib|builtins|__import__)\b)`,
  String.raw`\b(?:File|IO|FileUtils|Kernel|Object|Module)\.(?:send|public_send)\s*\(`,
];
const STATE_INTERP_WRITE_RX = new RegExp(
  STATE_INTERP_WRITE_SOURCES.join("|"),
);
// Global twin of the above, used ONLY to COUNT how many write/mutation verbs a
// body contains. The target resolver (`resolveInterpreterWriteTargets`) can only
// resolve the open/write family — it has no grammar for `os.remove`,
// `os.rename`, `shutil.move`, `File.delete`, `truncate`, … — so without a count
// check a single benign `open()` was enough to declare "all targets resolved,
// all benign" while an UNENUMERATED delete/rename of a protected path rode along
// in the same body (loom#1534, MEASURED). Counting the FULL verb set and
// requiring `verbs <= targets` is what makes an unenumerated verb fail closed.
// `matchAll` clones the regex, so the shared `lastIndex` is never observed.
const STATE_INTERP_WRITE_RX_G = new RegExp(
  STATE_INTERP_WRITE_SOURCES.join("|"),
  "g",
);
function countInterpreterWriteVerbs(text) {
  if (!text) return 0;
  let n = 0;
  for (const _m of text.matchAll(STATE_INTERP_WRITE_RX_G)) n++;
  return n;
}

// STATE_INTERP_INPLACE_RX — the perl/ruby `-i` IN-PLACE EDIT flag (#1337).
// This is the one write vector that lives in the interpreter's ARGV rather than
// its body: `perl -i -pe 's/L1_SUPERVISED/L5_DELEGATED/' <state>` rewrites the
// file with NO write API anywhere in the command text, so no body-token
// allowlist can ever see it (the python sibling `inplace=True` IS a body token
// and is covered above; `sed -i`/`jq -i` are covered structurally at Layer 1).
//
// Anchored `^`-per-line on a perl/ruby LEAD so the flag is read as the
// interpreter's own argument, not as a `-i` belonging to some other utility on
// the line (`grep -i`, `sort -i`). The `{0,80}?` bound keeps it linear.
const STATE_INTERP_INPLACE_RX =
  /^[ \t]*(?:\S*\/)?(?:perl|ruby)\b[^|\n]{0,80}?\s-[A-Za-z]{0,8}i(?:\.[A-Za-z0-9_-]{0,16})?(?=[\s'"]|$)/m;

// CONCAT_FOLD_RX / foldConcatenatedLiterals — collapse ADJACENT string literals
// joined by `+` into one literal (`'write' + 'FileSync'` → `'writeFileSync'`),
// so a write API whose NAME was split across a concatenation is scanned under
// its real spelling.
//
// This closes the variable-indirection form of the obfuscation class:
//   node -e "const k='write'+'FileSync'; require('fs')[k](<state>,'{}')"
// The in-BRACKET form (`require('fs')['write'+'FileSync'](…)`) is already caught
// by the group-(7) concat signal, but that signal keys on the brackets — moving
// the concatenation into an assignment evaded it while executing identically.
//
// This is LITERAL FOLDING, not evaluation: it rewrites only quoted-literal pairs
// separated by `+`, never expands a shell construct, a variable, or a call. So it
// stays inside `hook-output-discipline.md` MUST-3 (a hook MUST NOT expand shell
// syntax) — nothing here resolves `$VAR`, `$(…)`, or a runtime value.
//
// Bounded: each pass is a single linear scan with `{0,64}` operand bounds, and
// the fixpoint loop is capped at 8 rounds (`'a'+'b'+'c'+…` needs one round per
// adjacent pair), so a crafted concat chain cannot drive superlinear work.
const CONCAT_FOLD_RX = /(['"])([^'"]{0,64})\1\s*\+\s*(['"])([^'"]{0,64})\3/g;
function foldConcatenatedLiterals(text) {
  let out = text;
  for (let round = 0; round < 8; round++) {
    const next = out.replace(CONCAT_FOLD_RX, (_m, q, a, _q2, b) => q + a + b + q);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * hasInterpreterWriteSignal — the SINGLE read-vs-write predicate both Layer-3
 * branches (per-line quoted `-c`/`-e`/`-m` body, and the interpreter-led
 * fallback) consult.
 *
 * ONE shared callee per `security.md` § Enforcement-Surface Parity: the two
 * branches previously each restated `STATE_INTERP_WRITE_RX.test(...)`, so a
 * vector added to one was silently absent from the other. Routing both through
 * this function makes that drift structurally impossible.
 *
 * Scans the raw text FIRST (the common path, no allocation), then re-scans the
 * concat-folded text only when folding actually changed something — so an
 * honest body pays one extra regex test and nothing more.
 */
function hasInterpreterWriteSignal(text) {
  if (!text) return false;
  if (STATE_INTERP_WRITE_RX.test(text) || STATE_INTERP_INPLACE_RX.test(text)) {
    return true;
  }
  const folded = foldConcatenatedLiterals(text);
  return folded !== text && STATE_INTERP_WRITE_RX.test(folded);
}

// ── Write-TARGET resolution (loom#1534) ─────────────────────────────────────
// The WIDE Layer-3 branch flags on `interpreter-led && write-signal-anywhere`,
// with the protected-path test applied to the SAME whole-command scope. The two
// are never required to be RELATED, so a body that WRITES an ordinary file while
// merely MENTIONING a protected path in prose is read as a state mutation.
//
// MEASURED false positive (2026-08-02, twice in one session, both `severity:
// block`): a `python3 - <<PY` heredoc whose write target was a `.md` skill file
// and whose body quoted protected path names inside the prose it was inserting.
// The upstream doc-carrier mask does not reach it — that mask recognizes
// `gh --body` / `git commit -m` / `echo` / `printf`, and an interpreter heredoc
// writing a markdown file is none of those.
//
// This resolver answers the narrower question the branch should have asked:
// WHICH path is being written? It reads the first argument of each write call,
// resolving a bare identifier through simple `NAME = "literal"` bindings in the
// same body.
//
// FAIL-CLOSED, BUT ONLY BECAUSE OF THE VERB-COUNT GATE — not "by construction".
// It returns benign ONLY when (a) it resolved at least one target, (b) every
// resolved target is a non-protected path, AND (c) the number of mutation verbs
// in the body does not EXCEED the number of targets resolved. Any unresolved
// target (a computed path, an f-string, a join, a variable bound to anything but
// a plain literal) sets `unresolved` and the caller keeps the existing flag.
//
// Clause (c) is load-bearing and was ABSENT in the first cut, where this comment
// claimed the resolver "cannot admit an obfuscated write". It could, and did:
// the argument-capturing grammar below (`WRITE_CALL_ARG_RX`) enumerates only the
// open/write family, while `hasInterpreterWriteSignal` — the predicate whose
// finding this suppresses — also fires on delete / rename / move / truncate /
// chmod / shell-out / dynamic dispatch. So ONE benign `open()` resolved one
// benign target, `unresolved` stayed false, and an `os.remove(<ledger>)` in the
// same body was suppressed along with it (MEASURED 2026-08-02, loom#1534).
//
// The real bound, stated exactly: this suppressor is sound for the verbs
// `WRITE_CALL_ARG_RX` + `RECEIVER_WRITE_TARGET_RX` can resolve. For every OTHER
// verb in `STATE_INTERP_WRITE_SOURCES` it does not analyze the target at all —
// it only COUNTS, and any surplus count forces `unresolved`. Adding a verb to
// `STATE_INTERP_WRITE_SOURCES` is therefore always safe (it can only over-block);
// adding one to `WRITE_CALL_ARG_RX` without a correct first-arg-is-the-path
// grammar is NOT (see the `write_text` note below).
// FIRST-ARG-IS-THE-PATH writers only. `write_text` / `write_bytes` are
// deliberately ABSENT: they are RECEIVER-style (`Path(<path>).write_text(<data>)`)
// so their first argument is the CONTENT. Capturing it resolves a "target" of
// `{}` and would clear a REAL state write as benign. That exact mistake regressed
// the committed `flag-heredoc-write-text-body` fixture while this was being
// written — the fixture caught it, which is precisely why it exists.
const WRITE_CALL_ARG_RX =
  /(?:io\.open|open|writeFileSync|writeFile|appendFileSync|createWriteStream|File\.write|File\.open|IO\.write)\s*\(\s*([^,)]+)/g;
// Receiver-style: the path is the `Path(...)` receiver, not the first argument.
const RECEIVER_WRITE_TARGET_RX =
  /(?:pathlib\.)?Path\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/g;
// Every receiver-style write, resolvable or not — the count difference is what
// makes an unresolvable receiver (a variable, a join, an f-string) fail closed.
const RECEIVER_WRITE_ANY_RX = /\.\s*write_(?:text|bytes)\s*\(/g;
const STRING_BINDING_RX =
  /(?:^|[;\n{(\s])([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/g;

function resolveInterpreterWriteTargets(text) {
  const out = { targets: [], unresolved: false };
  if (!text) return out;
  // A name bound MORE THAN ONCE is UNRESOLVABLE, not "the last one wins". Taking
  // the last binding was a MEASURED bypass: `p="<state>"; write(p); p="/tmp/x"`
  // resolved to the benign trailing value while the runtime write used the state
  // path. Static order is not execution order, so any rebinding poisons the name.
  const bindings = new Map();
  const rebound = new Set();
  for (const m of text.matchAll(STRING_BINDING_RX)) {
    if (bindings.has(m[1])) rebound.add(m[1]);
    bindings.set(m[1], m[3]);
  }
  for (const n of rebound) bindings.delete(n);
  let sawCall = false;
  for (const m of text.matchAll(WRITE_CALL_ARG_RX)) {
    sawCall = true;
    const arg = m[1].trim();
    const lit = arg.match(/^(['"])((?:\\.|(?!\1)[^\\])*)\1$/);
    if (lit) {
      out.targets.push(lit[2]);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(arg) && bindings.has(arg)) {
      out.targets.push(bindings.get(arg));
      continue;
    }
    out.unresolved = true;
  }
  // Receiver-style writers, handled separately because their PATH is the
  // receiver. Any receiver-style write we cannot resolve to a literal path is
  // unresolved — never silently benign.
  const recvResolved = [...text.matchAll(RECEIVER_WRITE_TARGET_RX)];
  const recvAll = [...text.matchAll(RECEIVER_WRITE_ANY_RX)];
  for (const m of recvResolved) out.targets.push(m[2]);
  if (recvAll.length > recvResolved.length) out.unresolved = true;
  if (recvAll.length > 0) sawCall = true;
  if (!sawCall) out.unresolved = true;
  // ── VERB-vs-TARGET COVERAGE (loom#1534 fail-open) ────────────────────────
  // Same count-difference shape as the receiver-style guard immediately above,
  // applied to the NON-receiver verbs it never covered. The two regexes above
  // enumerate only the open/write family; `STATE_INTERP_WRITE_RX` additionally
  // fires on delete / rename / move / truncate / chmod / shell-out / dynamic
  // dispatch. A body carrying MORE mutation verbs than we resolved targets for
  // has at least one mutation whose target we never inspected — so it is
  // unresolved, not benign.
  //
  // MEASURED before this gate: `python3 - <<PY` with one benign
  // `io.open("x.md","w")` plus `os.remove("<ledger>")` was ALLOWED (baseline
  // FLAGged it); removing the benign decoy restored the flag, so the decoy was
  // the mechanism. Same for `os.rename` and `shutil.move`.
  //
  // Counted on the concat-FOLDED text too, and maxed: `hasInterpreterWriteSignal`
  // itself flags on the folded spelling, so a verb that only exists post-folding
  // (`fs['write'+'FileSync']` moved into a variable) must not read as zero here.
  const folded = foldConcatenatedLiterals(text);
  const verbCount = Math.max(
    countInterpreterWriteVerbs(text),
    folded === text ? 0 : countInterpreterWriteVerbs(folded),
  );
  if (verbCount > out.targets.length) out.unresolved = true;
  // The ARGV-side in-place-edit flag (`perl -i -pe …`) is a write with NO call
  // and NO body token, so it contributes ZERO to `verbCount` and no target at
  // all. It can never be shown benign by target resolution — fail closed.
  if (STATE_INTERP_INPLACE_RX.test(text)) out.unresolved = true;
  return out;
}

// True only when every write target in the body RESOLVED and none is protected.
// Used to suppress the WIDE-branch finding; never used to CREATE one.
function interpreterWritesOnlyBenignTargets(text, pathRx) {
  const { targets, unresolved } = resolveInterpreterWriteTargets(text);
  if (unresolved || targets.length === 0) return false;
  return targets.every((t) => !pathRx.test(t));
}

// ── Heredoc body: DATA or CODE? (loom#1534, second half) ────────────────────
// `detectHeredocWriteRunBundle` already encodes the right discriminator for this
// class — a heredoc body is dangerous when it is WRITTEN **and then EXECUTED**.
// The WIDE Layer-3 branch never asks, so authoring a FIXTURE whose CONTENT is an
// attack sample flags on the sample's own text. The corpus anticipated exactly
// this: the bundle detector's redesign note records that a lexical predecessor
// "false-blocked writing a doc that merely QUOTED writeFileSync('.claude/…') —
// loom authors exactly such fixtures". This applies that discriminator here.
//
// A heredoc whose body is piped to an interpreter (`python3 - <<PY`) has NO
// redirect target, so it is never inert — it is code, and still flags.
//
// FAIL-CLOSED: inert only when EVERY heredoc has an identifiable, literal,
// non-protected target that no later interpreter-led segment executes. A
// variable/expansion target, a protected target, or any execution of the target
// returns false and the caller flags exactly as before.
const HEREDOC_REDIRECT_TARGET_RX =
  /(?:^|[;&|]\s*)(?:cat|tee)\b(?:\s+-a)?[^\n<]*?(?:>>?\s*|\s+)([^\s<>|;&]+)[^\n<]*<<-?\s*['"]?[A-Za-z_]\w*/gm;

// Any token that could EXECUTE something. Deliberately over-broad: this decides
// whether to SUPPRESS, so over-matching only costs a retained (correct) flag.
// A per-target basename search was the first attempt and it leaked on every
// documented token-divergence residual — `T=s.py; python3 "$T"`, `env python3
// s.py`, `chmod +x s && ./s` — because the exec line need not name the file.
const ANY_EXEC_TOKEN_RX =
  /(?:^|[\s;&|(])(?:\.\/|source\b|\.\s+\S|env\b|chmod\b|exec\b|eval\b|xargs\b|python3?|node|nodejs|ruby|perl|bash|sh|zsh|deno|bun|tsx|ts-node|Rscript|lua|php|osascript)\b/;

function heredocBodiesAreInertData(command, pathRx) {
  if (!command) return false;
  const targets = [...command.matchAll(HEREDOC_REDIRECT_TARGET_RX)].map((m) => m[1]);
  if (targets.length === 0) return false; // stdin-fed heredoc = code, not data
  for (const t of targets) {
    if (/[$`]/.test(t)) return false; // unresolved expansion — fail closed
    if (pathRx.test(t)) return false; // writing protected state itself
  }
  // The command must be a PURE WRITE: strip every heredoc BODY, then require the
  // remaining shell text to contain no execution token at all. Checking whether
  // the written file is named on a later interpreter line is not enough — the
  // exec token and the write token need not match.
  // `[ \t]*` BEFORE the terminator is load-bearing, not tidiness. `<<-` tells
  // bash to STRIP LEADING TABS from the terminator line, so a TAB-indented
  // `EOF` genuinely CLOSES a `<<-EOF` heredoc. Anchoring the terminator hard at
  // `^` did not model that: the lazy body then ran PAST the real terminator and
  // bridged into the NEXT heredoc, swallowing every line between them — an exec
  // line included. MEASURED as a live patched-allows/baseline-flags divergence:
  // `cat > p.py <<-EOF … <TAB>EOF / python3 p.py / cat > q.txt <<EOF … EOF`
  // returned null here while bash ran the python3 (baseline: layer 3).
  // Allowing the indent UNCONDITIONALLY (rather than only for `<<-`) is the
  // fail-CLOSED direction and is deliberate: for a plain `<<EOF`, bash requires
  // the terminator flush-left, so an indented `EOF` is still body text and this
  // stripper now closes EARLIER than bash — it strips LESS, leaving more text in
  // the skeleton, which can only ADD exec-token matches and RETAIN a flag. Same
  // doctrine as ANY_EXEC_TOKEN_RX's own deliberate over-breadth above.
  const skeleton = command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?^[ \t]*\2\s*$/gm, " <<HEREDOC ");
  return !ANY_EXEC_TOKEN_RX.test(skeleton);
}

/**
 * detectStateFileMutation — three-layer Bash mutation detector for protected
 * state-file paths.
 *
 * Layer 1: redirect / heredoc / tee / sed -i / jq -i (excluding fd-redirects
 *          like `2>&1` and /dev/null sinks).
 * Layer 2: file-mutating utilities (cp, mv, rm, dd, rsync, install, truncate,
 *          ln, chmod, chown, touch, sponge).
 * Layer 3: interpreter bodies (python, node, ruby, perl, bash, sh) that WRITE
 *          the protected path — per-line quoted `-c`/`-e`/`-m` forms, PLUS a
 *          fallback for a command / pipeline-segment LED BY python/node/ruby/perl
 *          (covers `-m`, unquoted, script-arg, `--eval=`, and stdin-heredoc
 *          forms; restores parity with the removed Bash(python:*<state>*) deny
 *          globs, which anchored on the interpreter as the command executable).
 *          BOTH Layer-3 branches are gated on the SHARED hasInterpreterWriteSignal
 *          predicate (#1292 gate, #1337 shared callee + broadened vector set):
 *          a read-only interpreter body PASSES; only a WRITE + the path flags.
 *
 *          SCOPE (#1337). When nothing outside the interpreter's own segment can
 *          contribute to its argv — no heredoc, no `$(…)`/backtick/`$'…'`, and no
 *          `$` parameter reference anywhere in the command — the fallback scopes
 *          its path + write tests to the interpreter-led SEGMENT (quote- AND
 *          newline-aware), so an interpreter READ plus an unrelated protected-path
 *          mention on a SIBLING line no longer false-blocks. When ANY of those
 *          constructs IS present the whole-command scope is retained UNCHANGED
 *          (fail-closed), which keeps the stdin-heredoc write and the
 *          assembled-body write (`S=$(…)⏎node -e "$S"`) covered.
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
  // #1319/#1320 systemic FP fix — Layers 1 (redirect/heredoc/tee/sed-i) and 2
  // (file-mutation verbs) are SHELL-operation layers: a redirect operator or a
  // mutation verb is a REAL shell operation ONLY when it is UNQUOTED. The same
  // token appearing INSIDE a quoted span (an interpreter `-e`/`-c` body, a quoted
  // string, a multi-line quoted body) is DATA, not an executed mutation, and
  // previously false-blocked (`node -e 'const s="rm <state>"'` → Layer 2). Fix:
  // detect the OPERATOR/VERB on a length-preserving `maskQuotedSpans()` copy (so
  // it MUST be unquoted), and read the OPERAND from the RAW text at the same
  // position — a legitimately-quoted operand (`rm "<state>"`, `> "<state>"`) still
  // fires (NO bypass), while a `rm`/`>` inside an interpreter body is filler in
  // the mask (no FP). maskQuotedSpans is char-for-char length-preserving, so a
  // capture's offset in the mask maps 1:1 to the raw text.
  //
  // Layer 3 (the interpreter-body layer) is UNCHANGED — it runs on the RAW line
  // with its own STATE_INTERP_WRITE_RX write-token gate + the LAYER3_BLOCK_RX
  // severity router (validate-bash-command.js). A lexical write-token inside an
  // interpreter body (`node -e '…writeFileSync…'` vs a `writeFileSync` mentioned
  // as a data string) is the ratified #1293 Option-X ambiguity — deliberately NOT
  // "fixed" here (fail-closed block for authority state), so F-B does NOT touch it.
  //
  // Whole-command masking (not per-physical-line): maskQuotedSpans replaces an
  // in-quote newline with filler, so splitting the MASKED command on newline
  // yields lines at OUTSIDE-quote boundaries only — a multi-line `node -e
  // '<nl>rm <state><nl>'` body collapses to one masked line whose verb is filler
  // (no Layer-2 FP), while the RAW slice at the same offsets preserves the real
  // text for Layer-3 + operand reads.
  // Build aligned (RAW line, MASKED line) pairs. maskQuotedSpans replaces an
  // in-quote newline with filler, so the quote-masked command's newlines are the
  // OUTSIDE-quote boundaries only — a multi-line `node -e '<nl>rm <state><nl>'` body
  // collapses to one masked line whose verb is filler (no Layer-2 FP), while the RAW
  // slice at the same offsets preserves the real text for Layer-3 + operand reads.
  // Over the DoS size budget the mask is skipped and each physical line is its own
  // raw pair (fail-closed, and — critically — built by ONE `split("\n")`, never
  // 60k `command.slice()` calls, which is what made the guarded path O(n²) on a
  // 20k-heredoc input).
  const linePairs = [];
  if (command.length <= MASK_QUOTE_BUDGET) {
    const maskedCmd = maskQuotedSpans(command);
    let ls = 0;
    for (let i = 0; i <= maskedCmd.length; i++) {
      if (i === maskedCmd.length || maskedCmd[i] === "\n") {
        linePairs.push([command.slice(ls, i), maskedCmd.slice(ls, i)]);
        ls = i + 1;
      }
    }
  } else {
    for (const l of command.split("\n")) linePairs.push([l, l]);
  }
  for (const [line, maskedRaw] of linePairs) {
    // Layer 1/2 detect the OPERATOR/VERB on `maskedLine`: normally the quote-masked
    // line (so a verb/redirect inside INERT quoted data is filler → no FP), BUT when
    // the line carries an EXECUTING construct (`$(…)` / backtick / `$'…'` / `${ …}`)
    // the quoted content is NOT inert — it runs — so fall back to the RAW line to keep
    // a real `$(rm <state>)` / `"$(cat <<EOF … rm <state> … EOF)"` mutation visible
    // (#1319-D2 invariant; the SAME fail-closed discipline the segment-aware wrapper +
    // maskDocCarrierPayloads use via hasActiveExecutingConstruct). Both branches are
    // char-for-char length-aligned with `line`, so the raw-operand offset reads stay valid.
    //
    // #1363 Defect 2: the test is QUOTE-AWARE (`hasActiveExecutingConstruct`), not a
    // flat regex. A backtick / `$(` inside a SINGLE-quoted span is literal text the
    // shell never runs, so it must NOT force the raw re-scan — that is what made a
    // markdown-backticked prose body (`git commit -m 'fix `rm -rf` handling'`) block.
    // An executing construct at an unquoted or DOUBLE-quoted position still fails
    // closed, unchanged.
    const maskedLine = hasActiveExecutingConstruct(line) ? line : maskedRaw;
    // Layer 1: redirect / heredoc / tee / sed -i / jq -i — but NOT an fd-DUP
    // (2>&1, >&2), which redirects to a descriptor, not a file.
    // Output redirect to a protected path. Recognizes every file-writing form:
    //   >  >>  >| (force-clobber)  &> &>> (stdout+stderr)  N> N>> N>| (fd-prefixed).
    // An fd-dup target (`&N`) is excluded from the capture class so `2>&1` /
    // `>&2` never capture a path. `matchAll` checks EVERY redirect target on the
    // line, so a benign redirect preceding the state-file one is not a blind spot.
    // (#745 redteam Finding 1: the prior `(?:^|[^&\d2])>` matcher missed `>|`,
    // `&>`, and fd-prefixed `N>` forms — all real state-file writes.)
    // The redirect OPERATOR is matched on maskedLine (so it is unquoted); the
    // TARGET is read RAW at the capture position (a quoted target still fires).
    for (const rm of maskedLine.matchAll(/(?:\d+|&)?>>?\|?\s*([^\s|;&<>()]+)/g)) {
      const off = rm.index + rm[0].length - rm[1].length;
      const rawTarget = line.slice(off, off + rm[1].length);
      if (pathRx.test(rawTarget)) {
        return { layer: 1, kind: "redirect" };
      }
    }
    // Heredoc to protected path: `cat > path << EOF` or `>>path<<EOF`.
    // Uses the shared matchHeredocOpener (bash delimiter parser with quote
    // removal + structural `<<<` here-string exclusion) so a numeric / quoted /
    // hyphenated / partially-quoted delimiter (`<<9`, `<<'a-b'`, `<<E"O"F`) is
    // recognized consistently with the Layer-4 bundle pass. (The `>`-redirect
    // matcher above already catches `> <protected>` directly; this branch is the
    // labelled defence-in-depth companion.) Opener + `>` matched on maskedLine
    // (unquoted); target read RAW at position.
    if (matchHeredocOpeners(maskedLine).length) {
      const m = maskedLine.match(/>\s*([^\s|;&<]+)/);
      if (m) {
        const off = m.index + m[0].length - m[1].length;
        const rawTarget = line.slice(off, off + m[1].length);
        if (pathRx.test(rawTarget)) {
          return { layer: 1, kind: "heredoc" };
        }
      }
    }
    // tee — verb unquoted (masked); target read RAW at position.
    if (/\btee\b\s+/.test(maskedLine)) {
      const m = maskedLine.match(/\btee\b\s+(?:-[a-zA-Z]+\s+)*([^\s|;&]+)/);
      if (m) {
        const off = m.index + m[0].length - m[1].length;
        const rawTarget = line.slice(off, off + m[1].length);
        if (pathRx.test(rawTarget)) {
          return { layer: 1, kind: "tee" };
        }
      }
    }
    // sed -i / jq -i in-place editing — verb+`-i` unquoted (masked); path RAW.
    if (/\b(?:sed|jq)\b\s+[^|\n]*-i\b/.test(maskedLine)) {
      if (pathRx.test(line)) return { layer: 1, kind: "in-place-edit" };
    }

    // Layer 2: file-mutating utilities. `rm` + `sponge` added (F123): `rm`
    // closes the parity gap left when settings.json's Bash(rm:<state>) deny
    // entries were removed in favor of this path-based interceptor; `sponge`
    // (moreutils write-back) closes a write-capable verb the deny-matrix
    // never covered. The VERB is matched on maskedLine (so it is unquoted — a
    // `rm` inside an interpreter body is filler), and pathRx on the RAW line
    // (a quoted state-path operand still fires). Each fires only when pathRx
    // ALSO matches, so a benign `rm <non-state-file>` does not flag.
    const layer2Verbs =
      /\b(?:cp|mv|rm|dd|rsync|install|truncate|ln|chmod|chown|touch|sponge)\b\s+/;
    if (layer2Verbs.test(maskedLine) && pathRx.test(line)) {
      const verbMatch = maskedLine.match(layer2Verbs);
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
    // #1292 read-vs-write gate: require a WRITE token on the line, not just the
    // path — a read-only `-c`/`-e`/`-m` body (readFileSync / json.tool) passes.
    // #1337: routed through the SHARED hasInterpreterWriteSignal predicate so
    // this branch and the fallback below cannot drift apart.
    if (
      pathRx.test(line) &&
      interpreterBody.test(line) &&
      hasInterpreterWriteSignal(line)
    ) {
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
  // Early exit: every branch below requires the protected path somewhere in the
  // command, so a non-protected command never enters the segment scan.
  // Behaviour-neutral (both the narrow and the wide branch re-test a SUBSET).
  if (!pathRx.test(command)) return null;

  // #1337 Defect 3 — SCOPE. The wide branch tests `pathRx` + the write signal
  // against the WHOLE command while the interpreter leads only ONE sub-segment,
  // so an interpreter-led READ plus an unrelated protected-path mention on a
  // SIBLING line false-blocks (`node -e "console.log(1)"⏎grep -rn unlink src/⏎
  // cat <state>` — empirically exit 2 / permissionDecision deny before this fix).
  //
  // Narrowing to the led segment is sound ONLY when nothing outside that segment
  // can contribute text to the interpreter's argv. Absent a heredoc, a command
  // substitution / backtick / ANSI-C `$'…'` construct, and ANY `$` parameter
  // reference, the interpreter's body and arguments are LITERAL text inside its
  // own segment — nothing can be assembled from a sibling segment, so a
  // segment-scoped test cannot miss a write the wide test would have caught.
  //
  // When ANY of those constructs IS present the command stays on the WIDE branch
  // (today's exact semantics, unchanged). That deliberately keeps covered:
  //   • the stdin heredoc  `python3 - <<PY … open(p,'w') … PY`  (write on a body line)
  //   • the assembled body `S=$(cat <<JS … JS)⏎node -e "$S"`     (write in a sibling segment)
  // Narrowing those would be the FAIL-OPEN trade, which a trust-substrate
  // control must never take. The residual is therefore an over-block, not an
  // under-block: a `$`-bearing multi-line read + sibling state-path mention
  // still flags (remediation: split the command, or read with `cat`).
  // NB (#1390 review F1390-2): the EXECUTES_INSIDE_QUOTES_RX conjunct is
  // currently SUBSUMED — every construct that regex matches (`$(`, backtick,
  // `$'`, `${ `) contains a `$` or a backtick, so the two `includes` conjuncts
  // below already exclude it and it can never be the deciding term. It is kept
  // deliberately rather than deleted: it is the conjunct that stays CORRECT if
  // the regex ever gains a construct containing NEITHER character, at which
  // point it becomes load-bearing again. Reader's note only — not dead logic to
  // "clean up" without re-checking that invariant. This branch is the FLAT regex
  // on purpose (unlike the quote-aware call sites): `narrowable` decides scope,
  // where over-matching means falling back to the WIDE fail-closed branch.
  const narrowable =
    !matchHeredocOpeners(command).length &&
    !EXECUTES_INSIDE_QUOTES_RX.test(command) &&
    !command.includes("$") &&
    !command.includes("`");
  if (narrowable) {
    // Quote-aware + newline-aware split, so a separator INSIDE a quoted body
    // (`node -e 'a|b'`) does not fracture the segment. EVERY interpreter-led
    // segment is tested, not just the first — a read on line 1 must not mask a
    // write on line 3 (`node -e "console.log('ok')"⏎node -e "…writeFileSync(p)…"`).
    for (const seg of splitShellSegments(command, {
      newlineSeparates: true,
      withOffsets: true,
    })) {
      const im = seg.text.match(leadingInterpreter);
      if (!im) continue;
      if (pathRx.test(seg.text) && hasInterpreterWriteSignal(seg.text)) {
        return { layer: 3, kind: `${im[1]} (interpreter)` };
      }
    }
    return null;
  }

  // WIDE branch (unchanged #1292 semantics): an interpreter-led command flags
  // ONLY when a WRITE signal is present in the command too — a read-only
  // `python3 -m json.tool <state>` or `node -e '…readFileSync(<state>)…'`
  // passes. The write check is whole-command (same coarseness as the pathRx
  // check), which is what keeps the cross-line stdin-heredoc write covered; the
  // doc-prose false positive that coarseness could otherwise admit is masked
  // upstream in detectStateFileMutationSegmentAware (Defect B).
  const segments = command.split(/\||&&|;|\n/);
  const ledSeg = segments.find((s) => leadingInterpreter.test(s));
  if (ledSeg && hasInterpreterWriteSignal(command)) {
    // loom#1534 — the whole-command coarseness above never requires the write
    // signal and the protected-path hit to be RELATED. Before flagging, ask the
    // narrower question: which path does this body actually write? Suppress ONLY
    // when every write target RESOLVED and none is protected; any unresolved
    // target falls through and flags exactly as before (fail-closed).
    if (interpreterWritesOnlyBenignTargets(command, pathRx)) return null;
    // …and the sibling half: a heredoc body being WRITTEN to an ordinary file and
    // never executed is DATA (a committed fixture, a doc, a test sample), not
    // code. `detectHeredocWriteRunBundle` owns the write→EXEC case and still runs
    // as the whole-command fallback, so suppressing here cannot hide a bundle.
    if (heredocBodiesAreInertData(command, pathRx)) return null;
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
/*
 * Options (#1337, both default OFF so every pre-existing caller is byte-identical):
 *   • newlineSeparates — also split on an UNQUOTED, UNESCAPED newline. A `\`
 *     line-continuation is consumed by the escape branch before the newline
 *     check, so a continued line stays ONE segment (as bash reads it).
 *   • withOffsets — return `{ text, start }` records instead of bare strings,
 *     so a caller can slice the ORIGINAL command from a segment's position
 *     (the Layer-3 fallback needs this to extend scope past a heredoc opener).
 */
function splitShellSegments(command, opts = {}) {
  if (!command) return [];
  const newlineSeparates = opts.newlineSeparates === true;
  const withOffsets = opts.withOffsets === true;
  const segments = [];
  let current = "";
  let start = 0;
  const flush = (nextStart) => {
    segments.push(withOffsets ? { text: current, start } : current);
    current = "";
    start = nextStart;
  };
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
    if (newlineSeparates && ch === "\n") {
      flush(i + 1);
      i += 1;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      flush(i + 2);
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
      flush(i + 2);
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|") {
      flush(i + 1);
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush(n);
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
// loom#1368: the explicit `(?:-tree)?(?![\w-])` is load-bearing. A trailing
// word-boundary escape treats `-` as a boundary, so the prior form silently
// admitted EVERY `git commit-*` sub-command. Unlike the blocklist sites in
// #1368, over-matching HERE is permissive — this regex only TRIGGERS the
// quoted-body mask — so the fix states the intent precisely rather than
// narrowing blindly: `git commit-tree` genuinely takes a human-authored `-m`
// body and MUST keep riding the mask. Dropping it would raw-scan real prose
// and re-introduce the false positives the mask exists to prevent. No other
// `commit-*` sub-command accepts `-m` or `-F`, so the rest could never reach
// the mask in the first place.
const GIT_COMMIT_WITH_BODY_RX =
  /^\s*git\s+commit(?:-tree)?(?![\w-])[^|;]*?\s(?:-[A-Za-z]*[mF]|--message|--file|--reuse-message)\b/;

// #1292 Defect B — documentation-body wrappers whose QUOTED argument is prose
// that may QUOTE an example state-write command (`gh issue create --body "…node
// -e \"fs.appendFileSync('.claude/learning/…')\"…"`, `echo "…open(p,'w')…"`).
// Same failure mode as the git-commit body: the naive `command.split(/\||&&|;|
// \n/)` inside detectStateFileMutation's Layer-3 fallback is NOT quote-aware, so
// a `;`/newline INSIDE the quoted prose fractures an interpreter-led sub-segment
// out of the example text and FALSE-flags it. The fix mirrors the commit-body
// exception: mask the wrapper's quoted body (prose → filler) before detection,
// so a state-write EXAMPLE quoted as documentation does not fire — while a REAL
// interpreter execution (`python3 -c "open(p,'w')…"`, NOT a doc wrapper) and the
// stdin-heredoc-to-interpreter case (`python3 - <<PY … open(p,'w') … PY`, the
// interpreter CONSUMES the heredoc) are NOT wrappers and still fire.
//
// gh: `gh (issue|pr) (create|edit) … --body`/`--body-file`. echo/printf: any.
// These commands never mutate a protected LOCAL state file themselves; masking
// their quoted body can only REMOVE tokens (never synthesize a path/verb), and a
// REAL unquoted redirect on the segment (`echo x > <state>`) survives the mask
// and is caught by Layer 1 — identical mask-not-skip discipline to git commit.
const DOC_BODY_WRAPPER_RX =
  /^\s*(?:gh\s+(?:issue|pr)\s+(?:create|edit)\b[^|;]*?\s--body(?:-file)?\b|echo\b|printf\b)/;

// #1363 Defect 1 — the quoted-body mask was allowlisted to `git commit` (+ the
// #1292 `gh (issue|pr) create|edit --body` / `echo` / `printf` wrappers). Every
// OTHER command that carries a HUMAN-AUTHORED message went to the raw scan, so
// prose describing a state file blocked: `git tag -m`, `git notes add -m`,
// `gh release create --notes`, `gh gist create --desc`, `gh pr comment --body`,
// `gh pr review --body`. Measured at loom HEAD before the fix — `git tag -a v1
// -m '<prose naming .claude/learning/posture.json>'` flagged Layer 3 with NO
// backtick involved, i.e. independent of the Defect-2 quote bug.
//
// POSITIVE ALLOWLIST ON BOTH AXES (`cc-artifacts.md` Rule 10): a segment rides
// the mask only when an allowlisted COMMAND is paired with a flag that means
// "human message" FOR THAT COMMAND. Never a denylist of "commands that execute",
// which would silently admit every unlisted interpreter; an interpreter can
// never match this regex, so a widened flag set cannot reach one.
//
// The two axes are what make `-m` safe to honor here. A flat `-m` mask would be
// wrong: `git revert -m 2` / `git cherry-pick -m 1` take a MAINLINE PARENT
// NUMBER, and `python3 -m <module>` is an execution flag. Both are excluded by
// construction — they are not on the command allowlist.
//
// Masking is mask-NOT-skip, identical to the git-commit path: the segment's
// QUOTED spans become filler and detection still runs, so a real unquoted
// redirect / verb on the segment (`git tag -m 'x' > <state>`) still fires at
// Layer 1, and a segment carrying an ACTIVE executing construct
// (`git tag -m "$(rm <state>)"`) still fails closed to the raw re-scan.
const PROSE_CARRIER_RX =
  /^\s*(?:git\s+(?:tag|notes|merge|stash)\b[^|;]*?\s(?:-[A-Za-z]*[mF]|--message|--file)\b|gh\s+(?:issue|pr)\s+(?:comment|review)\b[^|;]*?\s--body(?:-file)?\b|gh\s+release\s+(?:create|edit)\b[^|;]*?\s--notes(?:-file)?\b|gh\s+gist\s+create\b[^|;]*?\s(?:--desc|-d)\b|gh\s+repo\s+(?:create|edit)\b[^|;]*?\s(?:--description|-d)\b)/;

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

// The funsub opener's blank set, factored out of EXECUTES_INSIDE_QUOTES_RX above
// so the quote-aware `hasActiveExecutingConstruct` tests the IDENTICAL class
// rather than a hand-enumerated copy that can silently lose a codepoint (#1390
// review S6). Any future edit to the class must happen HERE, once.
const FUNSUB_BLANK_RX = /[\s|]/;

/**
 * hasActiveExecutingConstruct — the QUOTE-AWARE form of
 * `EXECUTES_INSIDE_QUOTES_RX` (#1363 Defect 2).
 *
 * The flat regex answers "does an executing construct appear ANYWHERE in this
 * text", which over-answers the question its callers actually ask: "can this
 * text execute something, so its quoted content is NOT inert prose?". Under
 * POSIX shell quoting those differ in exactly one place, and it is the common
 * one: **inside a SINGLE-quoted span every character is literal** — `` ` ``,
 * `$(`, `$'`, `${ ` included. So a markdown-backticked prose body
 * (`gh issue create --body 'see `node -e …` for …'`, `git commit -m 'fix `rm
 * -rf` handling'`) tripped the flat regex, fail-closed into a RAW re-scan of
 * the prose, and BLOCKED — the #1363 self-sealing class, where writing an
 * accurate report about a state file trips the guard that protects it.
 * Code-quoting a command in a commit message / issue body is ordinary
 * practice, so this was not a rare corner.
 *
 * Returns true iff an executing construct occurs at a position where the shell
 * would ACT on it — i.e. unquoted, or inside a DOUBLE-quoted span:
 *
 *   UNQUOTED       `$(`  backtick  `$'` (ANSI-C: desyncs the quote scan)  `${ `/`${|` (funsub)
 *   DOUBLE-QUOTED  `$(`  backtick  `${ `/`${|`     — all expand inside `"…"`
 *                  NOT `$'`  — ANSI-C quoting is not recognized inside double
 *                  quotes; there `$'` is a literal `$` followed by a literal `'`.
 *                  A backslash-escaped `\$` / `\`` is a LITERAL and does not fire.
 *   SINGLE-QUOTED  nothing — every byte is literal (this is the whole fix)
 *
 * FAIL-CLOSED cases (return true, preserving the #745 F1/F2 invariant):
 *   • an UNTERMINATED quote — the parse is ambiguous, so the "inert prose"
 *     assumption is unsafe;
 *   • `$'…'` at an unquoted position — its `\'` escaping desyncs any naive
 *     quote scanner (this one included), so it is reported immediately rather
 *     than scanned through.
 *
 * The quote state machine is deliberately the SAME as `maskQuotedSpans` and
 * `splitShellSegments` (single-quote = no escapes; double-quote/unquoted =
 * `\`+next consumed as a unit) — the three MUST stay consistent or they
 * desync, which is the #1321 class.
 *
 * `initialQuote` lets a caller that already knows it is INSIDE a quoted span
 * (the `_maskDocCarrierBodyFlagValues` body-flag VALUE) scan the span's inner
 * text directly: `"'"` → always false (literal), `'"'` → double-quote rules.
 *
 * Narrowing scope (what this does NOT relax): this only decides whether a
 * QUOTED span may be treated as inert. An executing construct at an unquoted
 * or double-quoted position still fails closed exactly as before, so
 * `git commit -m "$(rm <state>)"`, `` gh … --body "…`rm <state>`…" ``,
 * `$'…'`, and funsubs all keep blocking. Single linear scan, no backtracking.
 */
function hasActiveExecutingConstruct(text, initialQuote = null) {
  if (!text) return false;
  if (initialQuote === "'") return false; // wholly literal by construction
  let quote = initialQuote || null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    // Unquoted OR double-quoted: a backslash consumes the next char as a unit,
    // so `\$(` / `` \` `` are literals and MUST NOT fire.
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === "`") return true;
    if (ch === "$") {
      const next = text[i + 1];
      if (next === "(") return true;
      // bash 5.3 funsub `${ …;}` / `${| …;}` — runs a command. The blank set is
      // tested with the SAME `[\s|]` class the flat EXECUTES_INSIDE_QUOTES_RX uses,
      // NOT a hand-enumerated list of blanks. #1390 review S6: an enumeration of
      // ` `/`\t`/`|` silently dropped SIX members of JS `\s` — `\n`, `\r`, `\f`,
      // `\v`, NBSP (U+00A0) and U+2028 — each a measured BLOCK→PASS regression
      // against a `git commit -m "x ${<blank>rm <state>;}"` payload. Reusing the
      // class makes parity structural: this predicate cannot drift from the regex
      // it replaced by someone forgetting a codepoint. Whether every bash build
      // accepts each blank as a funsub opener is UNVERIFIED and deliberately not
      // relied on — this is the fail-CLOSED side, where over-matching is free.
      if (next === "{" && FUNSUB_BLANK_RX.test(text[i + 2] ?? "")) {
        return true;
      }
      // ANSI-C `$'…'` is recognized ONLY at an unquoted position; inside double
      // quotes it is a literal `$` + `'`. Unquoted it desyncs the scan → fail closed.
      if (next === "'" && quote === null) return true;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    // Unquoted.
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    i += 1;
  }
  // Unterminated quote opened WITHIN this text → ambiguous parse → fail closed.
  // (An `initialQuote` span that simply runs to the end of `text` is the
  // caller's own slice and is NOT ambiguous — the caller checks closure.)
  return quote !== null && quote !== initialQuote;
}

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

// ===========================================================================
// #1319 (Defect 2) + #1320 — SHARED doc-carrier payload mask.
//
// Both PreToolUse guards below segment-split a Bash command on separators
// (`detectRepoScopeDriftBash` on `[;&|\n]`; `detectStateFileMutation`'s Layer-3
// fallback on `\||&&|;|\n`). When a DOC-CARRYING command (`gh (issue|pr)
// (create|edit) … --body/--body-file/--field/-F`, and `echo`/`printf` for the
// heredoc form) receives a MULTI-LINE payload — the idiomatic
// `--body "$(cat <<'EOF' … EOF)"` heredoc form, or a literal multi-line / even
// single-line quoted body — a DOCUMENTATION example quoted inside that payload
// (a `gh … --repo other`, a `python3 -c "open(<state>,'w')"`) is scanned as
// COMMAND TEXT: for `detectStateFileMutation` a newline INSIDE the payload
// fractures an interpreter-led sub-segment out of the prose; for
// `detectRepoScopeDriftBash` the same newline makes an embedded `gh … --repo`
// segment-LEADING, AND `_ghSegmentTarget` regex-searches the WHOLE segment
// (incl. a single-line quoted body) for `--repo`. Both FALSE-fire.
//
// This ONE shared helper (per security.md § Enforcement-Surface Parity — both
// guards call the SAME function so they cannot drift) neutralizes a doc-carrier's
// argument PAYLOAD to OPAQUE filler BEFORE either guard splits, distinguishing by
// ARGUMENT CONTEXT — NOT by pattern-matching the prose line:
//
//   MASKED (opaque data):
//     • a heredoc body fed to `cat` INSIDE a doc-carrier substitution
//       (`--body "$(cat <<'EOF' … EOF)"`) — `cat` EMITS the body as data
//     • a heredoc consumed DIRECTLY by gh/echo/printf (`gh … --body-file - <<EOF`)
//     • a doc-carrier body-flag's directly-quoted VALUE with no command-sub
//       (`--body "…"`, `--field "…"`, `-F "…"`) — single- OR multi-line
//
//   NEVER MASKED (execution — MUST still flag; the load-bearing invariant):
//     • `python3 -c "open(<state>,'w')"`            — no heredoc/doc-carrier
//     • `python3 - <<PY … open(p,'w') … PY`         — interpreter CONSUMES heredoc
//     • `bash -c "$(cat <<X … rm <state> … X)"`     — `$()` consumed by interpreter
//     • `cat > s.cjs <<X … <state> … X && node s`   — cat REDIRECTS to a file (#764)
//     • `gh … --body "$(node -e '…writeFileSync…')"`— `$()` runs node (not cat)
//     • `gh … --body "$(cat <<EOF … $(rm <state>) … EOF)"` — an UNQUOTED heredoc
//       delimiter EXPANDS its body, so a `$(…)`/backtick EXECUTES before `cat`
//       reads it → left intact (only a QUOTED-delimiter `<<'EOF'` body, or an
//       unquoted body with no execution construct, is inert data)
//     • a genuine `&& gh … --repo other` / a real `--repo other` NOT inside a
//       doc-carrier body payload
//
// Masking only DELETES bytes from a recognized data span (heredoc body → one
// space; quoted body value → `x` filler, delimiters kept); it never synthesizes
// a path / verb / `--repo`, so it can only turn a FALSE positive into a pass,
// never a real hit into a miss. It NEVER touches a `--repo` VALUE (Pass 2 masks
// only body-flag values), so a real cross-repo target — quoted or not — is still
// extracted. Per hook-output-discipline.md MUST-2 this is a false-positive
// REDUCTION for two halt-and-report/advisory lexical detectors — it NEVER widens
// a block and NEVER relaxes a real detection.
const HEREDOC_OPENER_RX = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
const HEREDOC_INTERP_OWNER_RX =
  /^(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh|env|xargs)$/;
const HEREDOC_DIRECT_DATA_OWNER_RX = /^(?:gh|echo|printf)$/;
// (A body-flag VALUE's inertness is decided by `hasActiveExecutingConstruct`
// under the value's OWN quote context — see `_maskDocCarrierBodyFlagValues`.
// The former flat `VALUE_EXECUTES_RX` was removed in #1363 Defect 2: it fired on
// a backtick/`$(` ANYWHERE in the value, including inside a single-quoted span
// where the shell runs nothing.)

function _escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The command word that OWNS the heredoc at `openerIdx` — the first token of the
// simple command containing `<<DELIM` (bounded by the nearest preceding
// separator / substitution start). Path prefix stripped (`/usr/bin/python3` →
// `python3`).
function _heredocOwner(cmd, openerIdx) {
  // Nearest preceding boundary via a BACKWARD char scan bounded by the enclosing
  // simple-command — NOT `cmd.slice(0, openerIdx)` + a forward boundRx scan of the
  // WHOLE prefix, which copied + rescanned a growing prefix on EVERY opener
  // (O(openers · n) = O(n²), the availability-DoS root cause). The forward scan's
  // `last` is always "one past the LAST boundary CHARACTER"; every boundRx variant
  // (`$(`, backtick, `(`, `&&`, `||`, `;`, `\n`, `&`, `|`) ENDS on one of
  // `; \n & | ( ` ``, so the first such char found scanning backward yields the
  // identical `last`. Bounded to the line → O(n) total.
  let last = 0;
  for (let k = openerIdx - 1; k >= 0; k--) {
    const c = cmd[k];
    if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === "`") {
      last = k + 1;
      break;
    }
  }
  const head = cmd.slice(last, openerIdx);
  const wm = head.match(/^\s*([A-Za-z0-9_./-]+)/);
  return wm ? wm[1].replace(/^.*\//, "") : null;
}

// Ascending start indices of every `$(` and every backtick in `cmd`, collected
// in ONE left-to-right pass. _isDocCarrierSubstitutionContext binary-searches
// these instead of doing a per-opener `cmd.slice(0,openerIdx)` +
// `pre.lastIndexOf("$(")`, which rescanned a growing prefix on EVERY heredoc
// opener (O(openers · n) = O(n²), an availability DoS on a many-heredoc input).
function _collectSubStarts(cmd) {
  const dollarParen = [];
  const backtick = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "`") backtick.push(i);
    else if (c === "$" && cmd[i + 1] === "(") dollarParen.push(i);
  }
  return { dollarParen, backtick };
}

// Largest element of an ASCENDING array that is <= bound, or -1 (binary search).
function _lastIndexLE(arr, bound) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= bound) {
      ans = arr[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// A `cat`/`tee` heredoc body is DATA only when its enclosing `$(…)`/backtick
// substitution is the argument of a DOC-CARRIER (gh --body/--field, echo,
// printf) and NOT of an interpreter (`bash -c "$(…)"`, `python3 -c "$(…)"`).
// Fail-closed: an unrecognized consumer returns false (heredoc left intact).
// `subStarts` is _collectSubStarts(cmd) — precomputed ONCE by the caller so this
// per-opener check is a binary search + a bounded backward head scan, not a
// growing-prefix rescan. Semantically identical to the prior
// max(pre.lastIndexOf("$("), pre.lastIndexOf("`")) + beforeSub.lastIndexOf(sep):
// a `$(` token (2 chars) fits before openerIdx iff its start <= openerIdx-2; a
// backtick (1 char) iff its start <= openerIdx-1.
function _isDocCarrierSubstitutionContext(cmd, openerIdx, subStarts) {
  const subStart = Math.max(
    _lastIndexLE(subStarts.dollarParen, openerIdx - 2),
    _lastIndexLE(subStarts.backtick, openerIdx - 1),
  );
  if (subStart < 0) return false; // not inside a substitution → not the $(cat) form
  // headStart = one past the nearest of `\n ; & | (` before subStart (the
  // simple-command start), via a bounded backward scan — equivalent to the prior
  // max over beforeSub.lastIndexOf(ch)+1, but O(head) not O(prefix).
  let headStart = 0;
  for (let k = subStart - 1; k >= 0; k--) {
    const c = cmd[k];
    if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(") {
      headStart = k + 1;
      break;
    }
  }
  const head = cmd.slice(headStart, subStart);
  // Finding 2 hardening (#1321 redteam, defense-in-depth): an interpreter-LED
  // head with a `-c`/`-e`/`-m`/`--eval` ANYWHERE (not only as the last token
  // before `$(`) consumes the substitution as CODE — a quoted prefix
  // (`bash -c "pre $(cat…)"`) defeats the end-anchored checks below. Fail-closed:
  // any interpreter-led code-flag head is an executing consumer → NOT a
  // doc-carrier (leave the heredoc intact so the raw scan sees the real code).
  const interpLed =
    /^\s*(?:\S*\/)?(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh|env)\b/.test(
      head,
    );
  if (interpLed && /\s-[A-Za-z]*[cem]\b|--eval\b/.test(head)) return false;
  // interpreter consumer of the substitution → NOT a doc-carrier (the invariant
  // that keeps `bash -c "$(cat <<X … rm <state> … X)"` flagging).
  if (
    /\b(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b[^\n]*?\s-[A-Za-z]*[cem]\b[\s"']*$/.test(
      head,
    )
  )
    return false;
  if (
    /\b(?:python3?|node|nodejs|ruby|perl|bash|sh|zsh)\b[^\n]*?--eval[=\s]*["']?\s*$/.test(
      head,
    )
  )
    return false;
  // doc-carrier consumer of the substitution
  if (/(?:^|\s)(?:echo|printf)\b/.test(head)) return true;
  if (
    /\bgh\s+(?:issue|pr)\s+(?:create|edit)\b/.test(head) &&
    /(?:--body(?:-file)?|--field|--raw-field|-F)\b/.test(head)
  )
    return true;
  // a body flag IMMEDIATELY before the substitution (`--body "$(`, `-F $(`)
  if (/(?:--body(?:-file)?|--field|--raw-field|-F)\s*=?\s*["']?\s*$/.test(head))
    return true;
  return false;
}

function _shouldMaskHeredoc(cmd, openerIdx, subStarts) {
  const owner = _heredocOwner(cmd, openerIdx);
  if (!owner) return false;
  if (HEREDOC_INTERP_OWNER_RX.test(owner)) return false; // execution — never mask
  if (HEREDOC_DIRECT_DATA_OWNER_RX.test(owner)) return true; // gh/echo/printf consume as data
  if (owner === "cat" || owner === "tee")
    return _isDocCarrierSubstitutionContext(cmd, openerIdx, subStarts);
  return false; // unknown owner → fail-closed (don't mask)
}

// Pass 1 — replace every DATA heredoc body (the opener-line newline through the
// end of the closing-delimiter line) with a single space, so a doc example on
// its own body line cannot survive segment-splitting. Interpreter /
// redirect-to-file / #764 heredocs are left byte-for-byte intact.
function _maskDataHeredocBodies(cmd) {
  let result = "";
  let cursor = 0;
  const subStarts = _collectSubStarts(cmd); // ONE pass; per-opener check is O(log n)
  HEREDOC_OPENER_RX.lastIndex = 0;
  let m;
  while ((m = HEREDOC_OPENER_RX.exec(cmd)) !== null) {
    if (m.index < cursor) continue; // opener inside an already-consumed body
    const openerEnd = HEREDOC_OPENER_RX.lastIndex;
    const nlIdx = cmd.indexOf("\n", openerEnd);
    if (nlIdx === -1) continue; // no body line to mask
    // Scan for the closing delimiter with a `g`-flag regex anchored at nlIdx via
    // lastIndex — NOT `closeRx.exec(cmd.slice(nlIdx))`. `cmd.slice(nlIdx)` copies
    // the ENTIRE remaining tail on EVERY opener, so a command with H sequential
    // closed heredocs was O(H·n) = O(n²) in allocation alone (an availability DoS
    // on a large committed-heredoc input, ~8s at ~13k openers). lastIndex scans
    // the shared `cmd` in place; `cm.index` is already absolute.
    const closeRx = new RegExp(
      "\\n[ \\t]*" + _escapeRegExp(m[2]) + "[ \\t]*(?=\\r?\\n|$)",
      "g",
    );
    closeRx.lastIndex = nlIdx;
    const cm = closeRx.exec(cmd);
    const bodyEnd = cm ? cm.index + cm[0].length : cmd.length;
    // An UNQUOTED heredoc delimiter (`<<EOF`) undergoes shell expansion — a
    // `$(…)` / backtick / funsub in the body EXECUTES before `cat` reads it, so
    // it is NOT inert data. Only mask when the delimiter is QUOTED (`<<'EOF'` /
    // `<<"EOF"`, the idiomatic doc form) OR the body carries no execution
    // construct; otherwise fail-closed (leave the body intact so the existing
    // raw scan still flags the real execution). Without this a
    // `--body "$(cat <<EOF … $(rm <state>) … EOF)"` would hide a real mutation.
    const delimQuoted = m[1] !== "";
    const bodyInert =
      delimQuoted || !EXECUTES_INSIDE_QUOTES_RX.test(cmd.slice(nlIdx, bodyEnd));
    if (bodyInert && _shouldMaskHeredoc(cmd, m.index, subStarts)) {
      result += cmd.slice(cursor, nlIdx) + " ";
    } else {
      result += cmd.slice(cursor, bodyEnd);
    }
    cursor = bodyEnd;
    HEREDOC_OPENER_RX.lastIndex = bodyEnd;
  }
  result += cmd.slice(cursor);
  return result;
}

// Pass 2 — mask a doc-carrier body-flag's directly-quoted VALUE (single- OR
// multi-line) to `x` filler, keeping delimiters. ONLY body-flag values are
// touched — never a `--repo` value — so a real cross-repo target survives. A
// value carrying a command-substitution (`$(…)`/backtick/`$'…'`) EXECUTES and is
// LEFT intact so the existing fail-closed raw scan (state) / a real nested
// `$(gh … --repo …)` (repo-drift) still fires.
// A body flag matched at the CURRENT (unquoted) scan position — only when it is a
// genuine command word: at a word boundary (start/whitespace before) AND the flag
// token is itself word-bounded (followed by `=`, whitespace, a quote, or EOL, so
// `--bodyfoo` is not `--body`).
const DOC_CARRIER_FLAG_AT_RX =
  /^(--body(?:-file)?|--field|--raw-field|-F)(=?)(?=$|[=\s"'])/;

function _maskDocCarrierBodyFlagValues(cmd) {
  // QUOTE-AWARE single pass (#1321 redteam CRITICAL): the earlier version matched
  // a body-flag token ANYWHERE and ran an ad-hoc quote scan from the flag with no
  // knowledge of the global quote state. A flag token appearing INSIDE quoted
  // prose (`echo "x -F "; rm <state>`) made the string's CLOSING quote read as the
  // value's OPENING quote, masking the real trailing `; rm …` / `; gh --repo …` to
  // EOL and DELETING the separator — a BLOCK→PASS bypass on BOTH guards. Now a
  // body flag is honored ONLY at an UNQUOTED word-boundary position (a real
  // command word); a `-F`/`--body` sitting inside a quoted span is PROSE and is
  // copied verbatim, so a real trailing command stays visible to the split.
  let out = "";
  let i = 0;
  const n = cmd.length;
  let quote = null; // "'" | '"' | null
  while (i < n) {
    const ch = cmd[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < n) {
        out += ch + cmd[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    // Unquoted.
    if (ch === "\\" && i + 1 < n) {
      out += ch + cmd[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    // A body flag is honored ONLY as a real command word: `-` at a word boundary.
    const atBoundary = i === 0 || /\s/.test(cmd[i - 1]);
    if (atBoundary && ch === "-") {
      const fm = DOC_CARRIER_FLAG_AT_RX.exec(cmd.slice(i));
      if (fm) {
        out += fm[0];
        let j = i + fm[0].length;
        if (!fm[2]) while (j < n && /[ \t]/.test(cmd[j])) out += cmd[j++]; // ws → value
        const q = cmd[j];
        if (q === '"' || q === "'") {
          let k = j + 1;
          let closed = false;
          while (k < n) {
            if (q === '"' && cmd[k] === "\\" && k + 1 < n) {
              k += 2;
              continue;
            }
            if (cmd[k] === q) {
              closed = true;
              k += 1;
              break;
            }
            k += 1;
          }
          const inner = cmd.slice(j + 1, closed ? k - 1 : k);
          // #1363 Defect 2 — QUOTE-AWARE value inertness. The prior flat
          // `VALUE_EXECUTES_RX` left a body value intact whenever it contained a
          // backtick / `$(` ANYWHERE — including a SINGLE-quoted `--body '…`node
          // -e …`…'`, where the shell runs nothing. That un-masked prose then
          // reached the raw scan and blocked. Now: a single-quoted value is inert
          // by construction; a double-quoted value is scanned under double-quote
          // rules (so `$(`/backtick/funsub still leave it intact, while `\$`/`` \` ``
          // escapes are literals); an UNTERMINATED value fails closed.
          const valueExecutes =
            !closed || hasActiveExecutingConstruct(inner, q);
          if (valueExecutes) {
            out += cmd.slice(j, k); // executes → leave intact (raw scan must see it)
          } else {
            out += q + inner.replace(/[^]/g, "x") + (closed ? q : "");
          }
          i = k;
          continue;
        }
        // unquoted value → nothing to fracture; resume normal scan at the value
        i = j;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * maskDocCarrierPayloads — the shared #1319-D2 + #1320 entry point. Pass 1
 * (heredoc data bodies) THEN Pass 2 (directly-quoted body-flag values). See the
 * block comment above for the mask/never-mask contract and the security
 * invariant. Idempotent-safe on non-doc-carrier commands (no-op).
 */
function maskDocCarrierPayloads(command) {
  if (!command || typeof command !== "string") return command;
  return _maskDocCarrierBodyFlagValues(_maskDataHeredocBodies(command));
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
  // consistent with the separate-invocation ceremony contract.
  //
  // ACCURACY CORRECTION (#1363, measured — the prior claim here was too narrow).
  // This comment used to read: "Never fires when the executed file is NOT written
  // in-command (`cat <state> && node other.js` stays clean — `other.js` is not a
  // structural write target)." That holds ONLY when the command carries NO
  // redirect at all. The conjunction below is protected-path-mention AND
  // ANY structural redirect target AND ANY structurally-executed script — the
  // written target and the executed token are NOT required to be the SAME file.
  // Executed evidence (`pathRx = /\.claude\/settings\.json\b/`):
  //   `cat <state> && node other.js`                        → clean  (no redirect)
  //   `cat <state> && node /tmp/a/other.js > /tmp/b/out.json` → FLAG (different files!)
  //   `cat <state> && wc -l x > /tmp/b/out.json`            → clean  (no interpreter)
  // So a READ-ONLY inspection that merely redirects unrelated output and runs an
  // unrelated interpreter flags — e.g. hashing a state file before/after running a
  // probe (`shasum <state>; node probe.mjs > out.json; shasum <state>`), which is
  // how a guard's own test fixtures get built. Kept AS-IS deliberately: this is the
  // fail-CLOSED backstop against bash-parse divergence, and narrowing the
  // target↔exec correlation is a security change owing its own analysis, NOT part
  // of #1363's operand-vs-prose class. Tracked as residual (m) in
  // `rules/state-file-write-guard.md`; remediation today is to split the command.
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
  // #1319 Defect 2 — neutralize a doc-carrier's argument PAYLOAD (a `gh
  // issue/pr create|edit --body/--body-file/--field/-F` heredoc or quoted body)
  // BEFORE the per-segment scan. The pre-existing DOC_BODY_WRAPPER_RX +
  // maskQuotedSpans path handles a DIRECTLY-quoted body, but a
  // `--body "$(cat <<'EOF' … EOF)"` heredoc form trips EXECUTES_INSIDE_QUOTES_RX
  // (the `$(`), which fail-closes to a RAW scan of the heredoc prose — where a
  // `python3 -c "open(<state>,'w')"` EXAMPLE quoted as documentation FALSE-fires
  // at BLOCK severity for authority-state paths. Masking the heredoc BODY (an
  // interpreter/redirect-to-file/#764 heredoc is left intact — see the helper's
  // contract) removes the prose before the raw scan sees it. Shared with
  // `detectRepoScopeDriftBash` (#1320) per security.md § Enforcement-Surface
  // Parity: ONE helper, so the two guards cannot drift. The #764 write-run
  // bundle pass below runs on the ORIGINAL `command` (a `cat > file <<X` heredoc
  // is never masked, but keeping it original is belt-and-suspenders).
  const masked = maskDocCarrierPayloads(command);
  for (const segment of splitShellSegments(masked)) {
    if (
      GIT_COMMIT_WITH_BODY_RX.test(segment) ||
      DOC_BODY_WRAPPER_RX.test(segment) ||
      PROSE_CARRIER_RX.test(segment)
    ) {
      // Documentation-body segment (git commit -m / -F, OR #1292 Defect B:
      // gh issue/pr create|edit --body[-file], echo, printf): mask its quoted
      // body (prose) then detect — so a real unquoted redirect/verb on the
      // segment still flags (`echo x > <state>` → Layer 1) while a verb/path or
      // a quoted `node -e "…write…"` EXAMPLE mentioned inside the body does not.
      const maskedHit = detectStateFileMutation(
        maskQuotedSpans(segment),
        pathRx,
      );
      if (maskedHit) return maskedHit;
      // Fail-closed (#745 F1/F2): `$(…)` / backtick command-substitution
      // EXECUTES inside double quotes, and `$'…'` desyncs the quote scan —
      // masking wrongly treats these as inert. When present, re-scan the RAW
      // (unmasked) segment so a mutation carried by the construct is caught.
      // Applies equally to the #1292 wrappers (`echo "$(node -e '…write…')"`
      // executes the command-sub, so it must NOT ride the mask).
      //
      // #1363 Defect 2 — QUOTE-AWARE. The flat regex fired on a backtick ANYWHERE,
      // including inside a SINGLE-quoted prose body where the shell treats it as a
      // literal. That re-scanned human-authored prose as command text and BLOCKED
      // it: the self-sealing class where an accurate bug report about a state file
      // trips the guard protecting that file. `hasActiveExecutingConstruct` fires
      // only where the shell would actually act (unquoted / double-quoted), so
      // `--body "$(node -e '…write…')"` and `` --body "…`rm <state>`…" `` still
      // fail closed.
      if (hasActiveExecutingConstruct(segment)) {
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

/* ═══════════════════════════════════════════════════════════════════════════
 * loom#1470 DEFEAT 2 — `git config` writes to the repository's OWN config.
 *
 * WHY THIS IS A SEPARATE DETECTOR AND NOT ANOTHER REGISTRY ROW. The executed
 * form of defeat 2 is `git config core.repositoryformatversion 99`, and the
 * string `.git/config` appears NOWHERE in it. `STATE_PATH_RX` is a PATH
 * matcher, so the path lane structurally cannot see this command — that premise
 * is measured, not assumed: BASH-3 in git-protected-surface-1470.test.mjs
 * asserts `STATE_PATH_RX.test(...) === false` before it asserts anything about
 * this function.
 *
 * WHY THE BASH BOUNDARY IS THE ONLY PLACE LEFT. The write also goes AROUND the
 * #1464 subprocess-env allowlist rather than through it: `GIT_CONFIG_NOSYSTEM`
 * and `GIT_CONFIG_GLOBAL=/dev/null` disable the SYSTEM and GLOBAL files, but a
 * repository's own config is always read and has no off switch. No env fix can
 * reach it, and the same test file measures the consequence rather than quoting
 * it — one such write makes every git command in the repo refuse.
 *
 * SEVERITY (hook-output-discipline.md MUST-2). This detector matches a shell
 * command STRING, so its ceiling is halt-and-report. The ratified Layer-1/2
 * `block` deviation recorded in state-file-write-guard.md § "Severity by layer"
 * is scoped to the PATH lane and is deliberately NOT extended here.
 * ═══════════════════════════════════════════════════════════════════════════ */

// The security-load-bearing key set — a MEMBERSHIP test, never a blanket
// `core.*` fence. `core.autocrlf`, `core.longpaths`, `core.editor` and friends
// are ergonomics with zero authority, and this repo's OWN onboarding docs
// instruct operators to set several of them (the line-endings step, the ssh
// commit-signing setup). A blanket section fence would flag those, and a guard
// that fires on its own documented setup is a guard operators route around.
//
//   core.repositoryformatversion — defeat 2's executed form; one write makes
//        every git command in the repo refuse.
//   core.worktree / core.bare    — repoint or reclassify the working tree, so
//        every path-scoped fence in this repo resolves against a tree the
//        operator never chose.
//   core.hookspath / core.fsmonitor / core.sshcommand — each NAMES A PROGRAM
//        git executes during ordinary operations, out of the repo's own config.
//        `hooksPath` is the one the corpus names; the other two are the
//        identical primitive (arbitrary command from repo config) and are
//        included deliberately rather than left as a known hole beside their
//        own sibling.
//   include.path / includeif.<cond>.path — pull an ATTACKER-CHOSEN config file
//        into this repo's config, which re-opens every key above indirectly.
//   extensions.*                 — repository-FORMAT state (objectFormat,
//        refStorage, worktreeConfig); the SECTION, not one key, is the unit of
//        authority, so the wildcard is the correct granularity here.
const GIT_CONFIG_SENSITIVE_KEY_RX =
  /^(?:core\.(?:repositoryformatversion|worktree|bare|hookspath|fsmonitor|sshcommand)|include\.path|includeif\..+\.path|extensions\..+)$/;

// `--remove-section` / `--rename-section` take a SECTION, not a key, so they
// need their own membership test: `git config --remove-section core` deletes
// every key above at once and would never match the key regex.
const GIT_CONFIG_SENSITIVE_SECTION_RX =
  /^(?:core|extensions|include|includeif)$/;

// Scope flags selecting a config file OUTSIDE this repository. `--global` and
// `--system` are out of scope BY CONSTRUCTION — they cannot reach this repo's
// `.git/config`, which is the only surface this detector fences.
//
// `--file` / `--blob` are deliberately ABSENT from this set: they name an
// arbitrary target that MAY be this repo's config, so they stay IN scope
// (fail-closed per security.md § Secure-Default). The finding is
// halt-and-report, so the whole cost of that choice is one advisory line on a
// rare form, against a silent bypass if it were listed here.
//
// Absence from this set is NECESSARY but was not SUFFICIENT: both flags take a
// VALUE, and until GIT_CONFIG_VALUE_TAKING_FLAGS existed that value was read as
// the KEY, so the in-scope form returned null anyway. See that set's note.
const GIT_CONFIG_OUT_OF_REPO_FLAGS = new Set(["global", "system"]);

// Read-only sub-commands. Reading a fenced key is not writing it — and
// `git config --get core.repositoryformatversion` is precisely how an operator
// DIAGNOSES this attack, so flagging it would fight the incident response.
const GIT_CONFIG_READ_FLAGS = new Set([
  "get",
  "get-all",
  "get-regexp",
  "get-urlmatch",
  "get-color",
  "get-colorbool",
  "list",
  "l",
  "name-only",
  "count",
]);

// Sub-commands that WRITE with fewer than two positionals, so the
// key-plus-value positional test below cannot see them on its own.
const GIT_CONFIG_WRITE_FLAGS = new Set([
  "add",
  "replace-all",
  "unset",
  "unset-all",
  "remove-section",
  "rename-section",
]);

// The subset of the write flags whose first positional is a SECTION, not a key.
const GIT_CONFIG_SECTION_FLAGS = new Set(["remove-section", "rename-section"]);

// Flags whose NEXT token is that flag's VALUE, not a positional — in their
// SEPARATED spelling only (`--file X`); the joined `--file=X` spelling is one
// token and needs no entry. A POSITIVE ALLOWLIST of git config's own
// value-taking options (cc-artifacts.md Rule 10), not a generic "-x consumes
// the next token" heuristic, which would swallow the KEY after every unknown
// boolean flag.
//
// WHY THIS SET EXISTS. Without it the flag's value is pushed onto `positionals`
// and shifts the key out of slot 0, so `git config --file .git/config core.bare
// true` read its key as `.git/config`, matched nothing, and returned null —
// while the joined `--file=.git/config` spelling of the SAME write flagged. The
// two spellings are interchangeable to git (measured: `bare = false` → `bare =
// true` in the repo's own `.git/config`), so that gap was a silent bypass of
// this fence, and precisely the one the `--file`/`--blob` comment above claims
// to hold closed. The skew hit the READ test too: `--file X core.hooksPath` is
// a READ that presented as two positionals and would have flagged as a write.
const GIT_CONFIG_VALUE_TAKING_FLAGS = new Set([
  "file",
  "f",
  "blob",
  "type",
  "t",
  "default",
  "comment",
]);

// `git [<git-option>…] config` — the invocation opener, as a SOURCE string so
// each scan builds its own regex and no `lastIndex` state is shared between
// calls.
//
// The leading class lets a match start INSIDE a command substitution
// (`--body "$(git config …)"`), which is exactly what the fail-closed raw
// re-scan hands us; a `^` anchor would miss that form and BASH-5 pins it.
//
// The option loop is a POSITIVE ALLOWLIST of git's own global options
// (`cc-artifacts.md` Rule 10), not a generic `\S+` skip. That is what keeps
// `git -c core.hooksPath=/dev/null commit` from ever reaching `config`: `-c
// k=v` is a per-invocation override that PERSISTS NOTHING, so it is not a
// vector — and it is the exact idiom this repo's own clean-instantiate.mjs,
// cc-cost.mjs, and the #1470 test fixtures use to commit. A fence that flagged
// it would be self-blocking.
const GIT_CONFIG_INVOCATION_SRC =
  "(?:^|[\\s;&|(){}`])git(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=\\S*|\\s+\\S+)|-P|--no-pager|--paginate|--bare|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-replace-objects))*\\s+config(?![\\w-])";

/**
 * _gitConfigArgTokens — quote-aware tokenizer for the argument tail of ONE
 * `git config` invocation.
 *
 * Stops at the first UNQUOTED shell metacharacter, so a tail handed over from
 * inside a command substitution (`… core.bare true)"`) ends at the `)` instead
 * of absorbing the carrier's trailing punctuation as a positional.
 *
 * Quotes are STRIPPED from the token they wrap: `git config --get-regexp
 * '^core'` must read as one flag plus one positional, not as a literal
 * `'^core'` that no membership test could ever match.
 *
 * NOT a shell parser — no expansion, per `hook-output-discipline.md` MUST-3.
 * `$HOME/.ssh/id.pub` stays the literal token `$HOME/.ssh/id.pub`, which is all
 * this detector needs: it reads the KEY (positional 0), never the value.
 */
function _gitConfigArgTokens(tail) {
  const tokens = [];
  let cur = "";
  let started = false; // distinguishes a real empty quoted token ('') from none
  let quote = null;
  const flush = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (quote === "'") {
      // Single quotes are literal in POSIX shell — no escapes; only ' closes.
      if (ch === "'") quote = null;
      else cur += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < tail.length) {
        cur += tail[i + 1];
        i += 1;
        started = true;
        continue;
      }
      if (ch === '"') quote = null;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < tail.length) {
      cur += tail[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if ("()`;&|<>".includes(ch)) {
      // End of THIS invocation's arguments (a command-substitution close, a
      // redirect, a separator the segment splitter did not own).
      flush();
      return tokens;
    }
    cur += ch;
    started = true;
  }
  flush();
  return tokens;
}

/**
 * _classifyGitConfigInvocation — decide whether ONE `git config` invocation
 * WRITES a security-load-bearing key of THIS repository's config.
 *
 * Returns `{ key, rawKey, target, kind }` on a hit, or `null`.
 */
function _classifyGitConfigInvocation(tail) {
  let outOfRepo = false;
  let isRead = false;
  let writeFlag = false;
  let sectionOp = false;
  const positionals = [];

  let pendingValue = false;
  for (const tok of _gitConfigArgTokens(tail)) {
    // The previous token was a separated-spelling value-taking flag, so THIS
    // token is its value — never a positional. See
    // GIT_CONFIG_VALUE_TAKING_FLAGS for the bypass this closes.
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (tok.startsWith("-") && tok !== "-" && tok !== "--") {
      const flag = tok.replace(/^-+/, "").split("=")[0].toLowerCase();
      if (GIT_CONFIG_VALUE_TAKING_FLAGS.has(flag) && !tok.includes("=")) {
        pendingValue = true;
      }
      if (GIT_CONFIG_OUT_OF_REPO_FLAGS.has(flag)) outOfRepo = true;
      else if (GIT_CONFIG_READ_FLAGS.has(flag)) isRead = true;
      else if (GIT_CONFIG_WRITE_FLAGS.has(flag)) {
        writeFlag = true;
        if (GIT_CONFIG_SECTION_FLAGS.has(flag)) sectionOp = true;
      }
      // Anything else (`--local`, `--worktree`, `--null`) neither moves the
      // target out of this repo nor decides read-vs-write.
      continue;
    }
    positionals.push(tok);
  }

  if (outOfRepo || isRead) return null;

  // A LONE positional is a READ — `git config core.hooksPath` PRINTS the value.
  // It becomes a write only when a value follows it or a write sub-command flag
  // is present (`--unset core.hooksPath` writes with one positional).
  if (!writeFlag && positionals.length < 2) return null;

  const rawKey = positionals[0];
  if (!rawKey) return null;
  // git config key names are case-INSENSITIVE in their section and variable
  // parts, so `core.repositoryFormatVersion` and `core.repositoryformatversion`
  // are the same key and must not be distinguishable to this fence.
  const key = rawKey.toLowerCase();

  const sensitive = sectionOp
    ? GIT_CONFIG_SENSITIVE_SECTION_RX.test(key)
    : GIT_CONFIG_SENSITIVE_KEY_RX.test(key);
  if (!sensitive) return null;

  return {
    key,
    rawKey,
    target: sectionOp ? "section" : "key",
    kind: sectionOp
      ? `git config write to the [${key}] config section`
      : `git config write to ${key}`,
  };
}

/** Scan ONE already-split shell segment for a fenced `git config` write. */
function _scanSegmentForGitConfigMutation(segment) {
  if (!segment) return null;
  const rx = new RegExp(GIT_CONFIG_INVOCATION_SRC, "g");
  let m;
  while ((m = rx.exec(segment)) !== null) {
    const hit = _classifyGitConfigInvocation(
      segment.slice(m.index + m[0].length),
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * detectGitConfigMutation — flag a `git config` command that WRITES a
 * security-load-bearing key of THIS repository's own config (loom#1470
 * defeat 2). See the banner above for why this cannot be a registry row.
 *
 * Segment-aware and mask-NOT-skip, deliberately identical in shape to
 * `detectStateFileMutationSegmentAware` (security.md § Enforcement-Surface
 * Parity: the two guards share the same helpers so they cannot drift):
 *
 *   • a prose carrier's QUOTED BODY is masked to filler, never the segment
 *     skipped — so `git commit -m "notes" && git config core.bare true` still
 *     flags on the chained REAL write, while `gh issue create --body '…`git
 *     config core.repositoryformatversion 99`…'` (an accurate bug report about
 *     the attack) does not. That self-sealing class — where writing about the
 *     defeat trips the guard against the defeat — is #1363's lesson.
 *   • a segment carrying an ACTIVE executing construct fails CLOSED to a raw
 *     re-scan, because `$(…)` and backticks RUN inside double quotes, so the
 *     mask's "quoted body is inert" assumption does not hold there.
 *
 * Returns the first hit's `{ key, rawKey, target, kind }`, or `null`.
 */
function detectGitConfigMutation(command) {
  if (!command || typeof command !== "string") return null;
  const masked = maskDocCarrierPayloads(command);
  for (const segment of splitShellSegments(masked)) {
    if (
      GIT_COMMIT_WITH_BODY_RX.test(segment) ||
      DOC_BODY_WRAPPER_RX.test(segment) ||
      PROSE_CARRIER_RX.test(segment)
    ) {
      const maskedHit = _scanSegmentForGitConfigMutation(
        maskQuotedSpans(segment),
      );
      if (maskedHit) return maskedHit;
      if (hasActiveExecutingConstruct(segment)) {
        const rawHit = _scanSegmentForGitConfigMutation(segment);
        if (rawHit) return rawHit;
      }
    } else {
      const hit = _scanSegmentForGitConfigMutation(segment);
      if (hit) return hit;
    }
  }
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

/* ═══════════════════════════════════════════════════════════════════════════
 * loom#1501 (L4) — `git worktree add` from a STALE LOCAL base ref.
 *
 * THE ERROR THIS REPLACES. Creating a lane worktree from a LOCAL branch ref
 * whose `origin/` counterpart has moved ahead. The lane then does good work on
 * a base that can never be pushed. It was recorded as a session-notes "trap"
 * TWICE and recurred a THIRD time, costing a full reconciliation (one lane's
 * base was 182 commits behind its own remote tip). Session notes are
 * per-session memory — routing cascade-valuable knowledge there is the
 * knowledge-cascade-routing.md MUST-1 failure. This is the structural answer.
 *
 * WHY THIS IS A HOOK AND THE OTHER CANDIDATES ARE NOT. The adjudication test is
 * instrument-discipline.md MUST-1: would the instrument produce a DIFFERENT
 * result if the proposition were false? Here it demonstrably would — the
 * verdict comes from `git rev-list --left-right --count`, which returns
 * `0<TAB>0` for an up-to-date ref and `<ahead><TAB><behind>` for a stale one,
 * off the operator's own ref database, at the moment the command is about to
 * run. The three sibling candidates fail that test at tool-call time and are
 * adjudicated NOT-a-hook in the PR body; see also rules/instrument-discipline.md.
 *
 * SEVERITY — block-ELIGIBLE, capped at halt-and-report on PROPORTIONALITY.
 * hook-output-discipline.md MUST-2 forbids `block` from a LEXICAL match alone.
 * The regex here does NOT issue the verdict: it only LOCATES a candidate base-ref
 * token, and the finding is emitted only after git reports a non-zero behind-count.
 * That is process-state evidence of exactly the class MUST-2 names as
 * block-eligible ("`git status --porcelain` non-empty before `--hard`"), and
 * spelling the ref `origin/wave/x` yields behind=0 BY CONSTRUCTION, because that
 * is the correct command.
 *
 * EVASION-RESISTANCE, BOUNDED HONESTLY. An earlier draft of this comment claimed
 * a fully-qualified `refs/heads/wave/x` "resolves to the same count". It did not:
 * the probe interpolates into `refs/heads/${ref}`, so that spelling produced
 * `refs/heads/refs/heads/wave/x`, git exited 128, and the detector silently
 * returned null. Fully-qualified refs are a legitimate spelling, not an evasion
 * attempt, so the probe now STRIPS a leading `refs/heads/` before interpolating
 * (see normalizeBranchRef) and the two spellings do now agree. The claim is
 * retained only because it is now TRUE by construction rather than by assertion.
 *
 * It is nevertheless capped at `halt-and-report`, not `block`, because the harm
 * is RECOVERABLE (rebase, or re-create the worktree) unlike the two `block`
 * neighbours in validate-bash-command.js, which are IRRECOVERABLE (a dirty-tree
 * `--hard` and a force `clean` both destroy work with no reflog). This is the
 * loom#1323 proportionality precedent, recorded there for a recoverable
 * merge-conflict class. The whole cost of this error lives in NOT KNOWING, and a
 * PreToolUse halt fires BEFORE the worktree exists — so surfacing is sufficient
 * teeth, while `block` would additionally hard-stop the rare-but-real "reproduce
 * the old base deliberately" case.
 *
 * FAIL-OPEN ON AN UNVERIFIABLE SIGNAL. Every path that cannot establish the
 * count — not a repo, ref absent, git missing, timeout, unparseable output —
 * returns null rather than flagging. Same disposition as
 * gitWorkingTreeStatus()'s `ok:false` arm in validate-bash-command.js: a guard
 * that flags on an unconfirmable signal is the MUST-2 false-positive class.
 * ═══════════════════════════════════════════════════════════════════════════ */

// `git worktree add` options that CONSUME the following token. Every other
// option in the `add` subcommand is boolean (`-f/--force`, `--detach`,
// `--checkout/--no-checkout`, `--lock`, `--orphan`, `--track/--no-track`,
// `--guess-remote/--no-guess-remote`, `-q/--quiet`, `--relative-paths`), and
// the ATTACHED forms (`-bfoo`, `--reason=x`) consume one token by construction.
const WORKTREE_ADD_VALUE_FLAGS = new Set(["-b", "-B", "--reason"]);

/**
 * Given the token remainder AFTER the `worktree` subcommand token (i.e. the
 * `args` field parseGitInvocation returns for `git worktree …`), extract the
 * explicit base commit-ish of an `add`.
 *
 * `git worktree add [<opts>] <path> [<commit-ish>]` — so the base ref is the
 * SECOND positional. When it is absent, git bases the tree on HEAD; that is a
 * different (and far noisier) proposition and is deliberately OUT of scope, so
 * this returns null.
 *
 * Returns { path, ref } or null.
 */
function parseWorktreeAddBaseRef(args) {
  if (!args || typeof args !== "string") return null;
  const toks = args.trim().split(/\s+/).filter(Boolean);
  if (toks[0] !== "add") return null;

  const positionals = [];
  let sawDoubleDash = false;
  for (let i = 1; i < toks.length && positionals.length < 2; i++) {
    const t = toks[i];
    if (!sawDoubleDash && t === "--") {
      sawDoubleDash = true;
      continue;
    }
    if (!sawDoubleDash && t.length > 1 && t.startsWith("-")) {
      // `-b <branch>` / `-B <branch>` / `--reason <string>` eat the next token.
      // Attached forms (`-bfoo`, `--reason=x`) and booleans do not.
      if (WORKTREE_ADD_VALUE_FLAGS.has(t)) i++;
      continue;
    }
    positionals.push(t);
  }
  if (positionals.length < 2) return null;
  return { path: positionals[0], ref: positionals[1] };
}

/**
 * STRUCTURAL PROBE — how far is `refs/heads/<ref>` from `refs/remotes/origin/<ref>`?
 *
 * ONE git spawn. `git rev-list --left-right --count A...B` prints
 * `<left>\t<right>` where left = commits in A missing from B (ahead) and right =
 * commits in B missing from A (behind); it exits non-zero when EITHER ref is
 * absent, which is precisely the "not a local branch with an origin counterpart"
 * case we want to skip. Verified by execution, both polarities, before this
 * detector was written.
 *
 * Returns { ahead, behind } or null (null = UNVERIFIABLE, never "clean").
 *
 * BOUND, stated rather than implied: the remote is hard-coded to `origin`. A
 * repo whose upstream lives under a differently-named remote is not covered —
 * the rev-list simply fails to resolve and this returns null, so the miss is a
 * silent non-detection, never a false flag.
 *
 * ARGUMENT SAFETY. `execFileSync` invokes no shell, and `ref` is shape-checked
 * before it reaches argv: it must begin with an alphanumeric (so it can never be
 * read as an option) and must not contain `..` (so it cannot walk out of the
 * `refs/` namespace it is interpolated into).
 *
 * ACCEPTED RESIDUAL, recorded so a future auditor does not have to re-derive it.
 * `cwd` here is the caller's resolved probe directory — it honours a `git -C
 * <dir>` AND a `cd <dir>` prefix in the inspected command, so this reads a repo
 * the COMMAND chose. `gitEnv()` neutralises system and global config, but a
 * repository's OWN `.git/config` is always read and cannot be disabled.
 *
 * The bound, stated precisely rather than waved at: repo-local config can name
 * programs git executes, but each such key needs a code path `rev-list` does not
 * take — `core.fsmonitor` needs an index refresh, `core.pager` needs a TTY and a
 * porcelain command (and `GIT_PAGER=cat` is set), `core.hooksPath` needs a hook
 * invocation, `uploadpack.packObjectsHook` is server-side, `core.sshCommand` and
 * `credential.helper` need a transport. What remains is FILE-PARSING exposure
 * (packed-refs, commit-graph, pack idx) under the hook's identity, not command
 * execution.
 *
 * AN EARLIER VERSION OF THIS NOTE CLAIMED "no new exposure — the same surface
 * `gitWorkingTreeStatus` already has". That cited the WEAKER sibling as a ceiling:
 * at the time that call passed no `env:` at all, and `git status` (unlike
 * `rev-list`) DOES refresh the index and therefore DOES consult `core.fsmonitor`.
 * It has since been routed through the same allowlist, so the comparison is now
 * true — but it was an argument standing in for evidence, and it is recorded here
 * because that is how the sibling stayed unhardened. The `git config` write fence
 * (detectGitConfigMutation) covers the write half.
 */
// Production budget for the one git spawn, bounded well inside
// validate-bash-command.js's own 5000ms TIMEOUT_MS. Overridable ONLY by env, and
// the override exists for one reason: under heavy parallel-agent load a spawn in
// a throwaway repo can exceed a few seconds, and a timeout is indistinguishable
// from "refs absent" here (both yield null) — so a contention-induced null would
// surface in the fixture suite as a BOGUS red against a working reader. That is
// the `codex-dispatcher` flakiness class (a 5s spawn timeout reporting
// `status -1` under load). The fixture runner raises this; nothing in production
// sets it, so the shipped budget is unchanged. Verified separately that the
// execFileSync timeout genuinely fires (SIGTERM/ETIMEDOUT) rather than hanging —
// unlike a synchronous readFileSync on a FIFO, which parks the event loop and
// defeats an in-process fallback timer.
// CLAMPED, not merely defaulted. `Number(process.env.X || 2500)` is wrong twice:
// `||` tests the STRING, so `COC_REF_PROBE_TIMEOUT_MS=0` is truthy and yields
// `0` — the documented "no timeout" value, i.e. an UNBOUNDED synchronous spawn
// on the PreToolUse hot path — and a non-numeric yields NaN, whose throw is
// swallowed by the catch below into `return null`, silently inerting the
// detector. Neither is loud, and there is no backstop: validate-bash-command.js
// clears its own 5s timer BEFORE validateBashCommand runs. So the value is
// range-checked here and falls back to the default on anything unusable.
// The ceiling stays strictly under that (now-cleared) 5s hook budget so the
// figure keeps meaning something to a reader.
const REF_PROBE_DEFAULT_MS = 2500;
const REF_PROBE_MAX_MS = 4500;
const REF_PROBE_TIMEOUT_MS = (() => {
  const raw = process.env.COC_REF_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return REF_PROBE_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return REF_PROBE_DEFAULT_MS;
  return Math.min(n, REF_PROBE_MAX_MS);
})();

/**
 * Reduce a branch spelling to the SHORT name the probe interpolates.
 *
 * `git worktree add <path> refs/heads/wave/x` is a legitimate, fully-qualified
 * spelling — not an evasion attempt. Interpolating it raw yielded
 * `refs/heads/refs/heads/wave/x`, which git rejects with exit 128, so the probe
 * returned null and the detector went silent on a command it should flag.
 * Measured, both polarities, before this function existed:
 *
 *   $ git rev-list --left-right --count refs/heads/$B...refs/remotes/origin/$B
 *     1  0                                                        # exit 0
 *   $ git rev-list --left-right --count refs/heads/refs/heads/$B...<same>
 *     fatal: ambiguous argument …: unknown revision                # exit 128
 *
 * Only `refs/heads/` is stripped, and only as a LEADING prefix. `refs/remotes/…`
 * is deliberately NOT stripped: a remote-tracking ref is the CORRECT base and is
 * already short-circuited by the `origin/`|`upstream/` pre-guard in the detector,
 * so anything else under `refs/` should keep failing to resolve into null rather
 * than being coerced into a branch it is not.
 *
 * Returns the short name, or null when nothing usable remains.
 */
function normalizeBranchRef(ref) {
  if (typeof ref !== "string") return null;
  // `refs/heads/x` and `heads/x` are both spellings git resolves to the branch
  // `x`. Only these two, and only as a LEADING prefix, and only once — a nested
  // `refs/heads/refs/heads/x` is NOT a real ref and must keep failing to resolve
  // rather than being coerced into one.
  let short = ref;
  for (const p of ["refs/heads/", "heads/"]) {
    if (short.startsWith(p)) {
      short = short.slice(p.length);
      break;
    }
  }
  // A bare `refs/heads/` leaves the empty string; re-assert the leading-char
  // shape so the stripped form is subject to the same rule as the raw one.
  return /^[A-Za-z0-9]/.test(short) ? short : null;
}

// `opts.timeoutMs` is an IN-PROCESS injection seam, deliberately NOT clamped and
// deliberately NOT reachable from the environment — the same tier-1 distinction
// git-subprocess-env.js draws for `opts.gitBin` ("reachable only by code already
// executing inside the guard process, never from the environment or a config").
// The env var is semi-trusted input and is clamped; an explicit argument from a
// caller inside the process is not.
//
// WHICH LEVER APPLIES WHERE, stated because an earlier draft of this comment got
// it backwards and claimed the fixture runner used the seam "rather than the env
// var" — it uses the env var, and the clamp caps that at 4500ms, so the stated
// mechanism delivered none of the headroom it claimed:
//
//   Arm 2 (in-process, direct calls)  → `opts.timeoutMs`, forwarded from
//     detectWorktreeStaleBaseRef, UNCLAMPED. Real headroom.
//   Arm 3 (the hook as a SUBPROCESS)  → the env var only; no in-process seam can
//     reach another process. Clamped to REF_PROBE_MAX_MS (4500ms).
//
// 4500ms is therefore the honest ceiling for Arm 3, and it is an ACCEPTED bound,
// not an oversight: the clamp's whole point is that the figure stays inside the
// hook's own budget, and raising it for a fixture would make the shipped number
// mean less than the fixture's convenience.
function readRefDivergenceFromOrigin(ref, cwd, opts = {}) {
  if (!ref || typeof ref !== "string") return null;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : REF_PROBE_TIMEOUT_MS;
  // Reject anything that could be read as an option or escape the ref
  // namespace before it reaches the argv. execFileSync does not invoke a
  // shell, so this is shape hygiene, not shell-injection defence.
  // Runs on the RAW token, before normalization, so normalization can never
  // launder a token the shape check would have rejected.
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(ref) || ref.includes("..")) {
    return null;
  }
  const branch = normalizeBranchRef(ref);
  if (!branch) return null;
  // THE shared guard-git allowlist (loom#1462). A guard that spawns bare `git`
  // with no `env:` does a PATH lookup and hands the child the AMBIENT
  // environment — and `GIT_DIR` outranks repository DISCOVERY, so neither `-C`
  // nor `cwd:` pins WHICH repository answers. Routing through
  // resolveGitBinary()+gitEnv() gives an absolute binary and an env built from
  // constants. This matters more here than at the sibling `git status` probe,
  // because `cwd` below is the caller's `g.dir || cwd` — a directory the
  // INSPECTED COMMAND chose via `-C` — and the segmentation fix means this can
  // still be reached from a command that will not itself run a worktree add.
  //
  // NAMED DEVIATION from the module's caller contract, per security.md
  // § Enforcement-Surface Parity. git-subprocess-env.js requires every caller to
  // rank an unresolvable git TIGHTEST ("indeterminate, never a clean negative").
  // That is correct for a fail-CLOSED authorization fence; this is not one. This
  // detector only SURFACES advice, so ranking tightest would emit a halt on
  // every host where git does not resolve — a guaranteed false positive with no
  // attacker, which hook-output-discipline.md MUST-2 forbids outright. It
  // therefore fails OPEN, the same disposition gitWorkingTreeStatus()'s
  // `ok:false` arm already takes in validate-bash-command.js. The security
  // property the allowlist exists for (an attacker steering WHICH repository
  // answers) is unaffected by the direction of that fallback.
  const gitBin = resolveGitBinary();
  if (!gitBin) return null;
  try {
    const out = execFileSync(
      gitBin,
      [
        "-C",
        cwd || process.cwd(),
        "rev-list",
        "--left-right",
        "--count",
        `refs/heads/${branch}...refs/remotes/origin/${branch}`,
      ],
      {
        encoding: "utf8",
        // The RESOLVED value, not the module constant — `opts.timeoutMs` is the
        // seam the fixture runner uses for contention headroom, and reading the
        // constant here left that seam computed-but-dead: the runner's override
        // would have been silently ignored and the flakiness it exists to absorb
        // would have re-appeared as a bogus red.
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
    const m = String(out).trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) return null;
    return { ahead: Number(m[1]), behind: Number(m[2]) };
  } catch {
    // Non-zero exit (either ref absent / not a repo), ENOENT, or timeout.
    return null;
  }
}

/**
 * Flag a `git worktree add` whose explicit base is a LOCAL branch ref that its
 * `origin/` counterpart has moved ahead of.
 *
 * @param {string} args  the post-`worktree` token remainder (parseGitInvocation's
 *                       `args` for a `git worktree …` invocation)
 * @param {string} cwd   the directory the git query runs in
 * @param {object} opts  { readDivergence } — injectable for fixtures, so the
 *                       arg-grammar and verdict arms are exercised without git
 * @returns {null | {rule_id, severity, ref, path, ahead, behind, evidence, detection_layer}}
 */
function detectWorktreeStaleBaseRef(args, cwd, opts = {}) {
  const parsed = parseWorktreeAddBaseRef(args);
  if (!parsed) return null;
  const { ref, path: wtPath } = parsed;

  // hook-output-discipline.md MUST-3 — a captured group referencing an
  // unexpanded shell variable is UNKNOWABLE at hook time. Structural null; do
  // NOT downgrade to advisory and do NOT attempt expansion.
  if (/[$`]/.test(ref)) return null;

  // Already a remote-tracking ref: this IS the correct form. Cheap pre-guard
  // that also avoids a pointless spawn (the rev-list would fail to resolve
  // `refs/heads/origin/main` anyway and return null one step later).
  if (/^(?:origin|upstream)\//.test(ref)) return null;

  const readDivergence = opts.readDivergence || readRefDivergenceFromOrigin;
  // `opts.stats` is an OUT-PARAM the dispatcher uses to spend its one-spawn
  // budget honestly. Everything above this line returns null WITHOUT spawning
  // (not an `add`, no explicit base, a shell-variable ref, an already-correct
  // `origin/` ref), and from outside those are indistinguishable from "spawned
  // and found nothing" — so a caller that breaks on any null stops walking after
  // a `git worktree list` and never probes the real `add` behind it. The flag is
  // set HERE so the pre-guards stay in ONE place rather than being re-derived by
  // every caller.
  if (opts.stats) opts.stats.probed = true;
  // `opts` is FORWARDED, not dropped. Without this `opts.timeoutMs` is a seam no
  // caller can reach — the reader computes it and no one can supply it, which is
  // the zero-tolerance.md Rule 3c shape (a documented parameter with no effect).
  // Production passes no opts, so the resolved value is unchanged there.
  const d = readDivergence(ref, cwd, { timeoutMs: opts.timeoutMs });
  // null => the count could not be established (ref absent, not a repo, git
  // unavailable, timeout). Fail OPEN.
  if (!d || !Number.isInteger(d.behind) || d.behind <= 0) return null;

  const diverged = d.ahead > 0;
  return {
    rule_id: "worktree-orchestration/Rule-7",
    severity: "halt-and-report",
    ref,
    path: wtPath,
    ahead: d.ahead,
    behind: d.behind,
    diverged,
    detection_layer: "structural",
    evidence:
      `git worktree add … ${wtPath} ${ref} — local refs/heads/${ref} is ${d.behind} commit(s) ` +
      `BEHIND refs/remotes/origin/${ref}` +
      (diverged ? ` and ${d.ahead} ahead (diverged)` : "") +
      `; the new tree would be based on a stale ref`,
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
  detectGitConfigMutation,
  // Exported for direct probing: #1390 review could not test the quote-context
  // predicate behaviourally because it was internal, so the S6 blank-set
  // regression was reachable only by reading the code. A security predicate that
  // reviewers cannot execute is one a reviewer will mis-read.
  hasActiveExecutingConstruct,
  detectHeredocWriteRunBundle,
  hasInterpreterWriteSignal,
  splitShellSegments,
  maskDocCarrierPayloads,
  // loom#1501 (L4). The worktree lane needs the BODIES-REMOVED surface, not just
  // doc-carrier ARGUMENT masking: `maskDocCarrierPayloads` covers a `$(cat <<X)`
  // feeding a doc-carrier flag, but a plain `cat > notes.md <<'EOF' … EOF` writes
  // a FILE, so its body stayed unmasked and any `git worktree add …` inside the
  // prose read as a live command. That is the repo's own documented authoring
  // shape (`agents/management/coc-sync.md` uses it verbatim).
  parseHeredocSpans,
  detectMust6Paraphrase,
  // loom#1501 (L4). All three are exported: the fixtures exercise the
  // arg-grammar (parseWorktreeAddBaseRef) and the verdict (detect… with an
  // injected reader) SEPARATELY from the real-git probe
  // (readRefDivergenceFromOrigin), so an injected stub cannot silently make
  // the whole set vacuous — instrument-discipline.md MUST-2(a).
  parseWorktreeAddBaseRef,
  readRefDivergenceFromOrigin,
  detectWorktreeStaleBaseRef,
  // Exported for direct probing, same rationale as hasActiveExecutingConstruct
  // above: the clamp is the only thing standing between a hostile/typo'd env
  // value and either an UNBOUNDED synchronous spawn on the hot path (`=0`) or a
  // silently inert detector (`=abc` -> NaN -> throw -> caught -> null). A guard
  // whose value a reviewer cannot execute is one a reviewer will mis-read. It is
  // resolved at module load, so a probe reads it by spawning with a given env.
  REF_PROBE_TIMEOUT_MS,
};
