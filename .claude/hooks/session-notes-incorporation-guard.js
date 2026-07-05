#!/usr/bin/env node
/**
 * session-notes-incorporation-guard.js — PostToolUse(Bash) advisory that fires
 * when an INCORPORATION command (git merge / pull / rebase / checkout|switch to
 * main) has advanced HEAD past the point the operator's OWN session-notes
 * fragment was last reconciled — i.e. the operator's notes now TRAIL the branch
 * and a reconcile is due (#743 Wave 2, contract C3 / invariant I4).
 *
 * The detection anchor is the FROZEN Wave-1 stamp: each per-operator fragment
 * `.session-notes.d/<display_id>.md` carries a `last_reconciled_sha`
 * frontmatter value (written by `session-notes-layout.js::migrateMonolithToSplit`
 * at split creation, re-stamped by /reconcile-notes in Wave 3). Lag =
 * `git rev-list --count <last_reconciled_sha>..HEAD > 0`.
 *
 * Design (receipt journal/0394):
 *   D-W2-1  reads the CURRENT operator's OWN fragment (C3/C4 are per-operator),
 *           via the layout lib's own `fragmentPathFor` (single-source filename
 *           derivation — no replicated-slugify drift).
 *   D-W2-2  frontmatter parse is BLOCK-SCOPED (first `---`…`---` pair, which sits
 *           AFTER the HTML banner) so the banner's literal `last_reconciled_sha`
 *           prose is never mis-read. Missing/empty value → coherent (I10),
 *           advisory SUPPRESSED.
 *   D-W2-3  errored/ambiguous lag compute is ZERO evidence → SUPPRESS
 *           (`evidence-first-claims.md` MUST-3): only exit 0 with count>0 fires;
 *           exit 128 (bad rev — rebased-away / shallow clone) is a distinct
 *           suppress branch (I12b); any other exit / git-absent / unparseable
 *           count likewise suppresses. The stamp is shape-guarded before it ever
 *           reaches git.
 *   D-W2-4  advisory-only (`halt-and-report`, NEVER `block` per
 *           `hook-output-discipline.md` MUST-2 — a rev-list heuristic is not an
 *           irrefutable structural primitive); EVERY path fails OPEN (C3.4); a
 *           `cc-artifacts.md` Rule 7 timeout bounds a hung git call.
 *
 * Emits via the canonical `instruct-and-wait.js::emit()` shape
 * (`hook-output-discipline.md` MUST-1). Registered at PostToolUse(Bash).
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { fragmentPathFor, readNotesFileGuarded } = require(
  path.join(__dirname, "lib", "session-notes-layout.js"),
);

// cc-artifacts.md Rule 7 — timeout fallback that never hangs the session. Exit
// code 1 (NOT 0) marks a timeout-FIRED passthrough distinguishable in exit-code
// logs from a normal exit-0 passthrough (matches wrapup-after-landing.js). The
// timer is armed ONLY inside `_main()` (the CLI path), so a `require()` of this
// module for testing has ZERO side effects (no stray self-exiting timer).
const TIMEOUT_MS = 5000;
let _timeout = null;

function passthrough() {
  if (_timeout) clearTimeout(_timeout);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/**
 * Is `cmd` an INCORPORATION command? Segment-anchored (command start or after a
 * shell separator `\n`/`;`/`&`/`|`) so a `git merge` substring inside an
 * unrelated argument does not over-fire. This is a CHEAP PRE-FILTER only — the
 * authoritative gate is the lag compute (a non-incorporation that slips through,
 * or a `--abort` that did not advance HEAD, resolves to count==0 → suppress).
 *   - merge / pull / rebase  → incorporate other-branch or remote work.
 *     `--abort`/`--quit`/`--help`/`-h` in the same segment are excluded (they do
 *     not advance HEAD; a cheap short-circuit, not a correctness gate).
 *   - checkout / switch to a `main`/`master` branch TOKEN → moving onto the
 *     integration branch. `main` is matched as a standalone token so
 *     `checkout main-feature` does not over-fire.
 */
function isIncorporationCommand(cmd) {
  const s = String(cmd || "");
  return _RE_MERGE_PULL_REBASE.test(s) || _RE_CHECKOUT_SWITCH.test(s);
}

// Segment anchor tolerates leading whitespace (`^\s*`) as well as a shell
// separator prefix. `_OPT_PREFIX` matches git GLOBAL options (`-c cfg`,
// `-C dir`, `--no-pager`, `--git-dir=…`) that may sit between `git` and the
// subcommand (so `git -c x pull` / `git -C dir merge` / `  git merge` are not
// missed). The repetition is bounded `{0,6}` so the option-loop's `-c`-prefix
// alternation cannot catastrophically backtrack — ReDoS-safe regardless of
// input length. The lag compute remains the authoritative gate: a command that
// slips through (or an over-fire on an arg that merely names the verb) resolves
// to a count 0 → suppress, and can only ever surface a TRUE lag of baseDir's
// own notes (the checked HEAD is always baseDir's, never a `-C` target's).
const _OPT_PREFIX = "(?:(?:-[cC]\\s+\\S+|--?[\\w-]+(?:=\\S+)?)\\s+){0,6}";
const _RE_MERGE_PULL_REBASE = new RegExp(
  `(^\\s*|[\\n;&|]\\s*)git\\s+${_OPT_PREFIX}(?:merge|pull|rebase)\\b(?![^\\n;&|]*\\s(?:--abort|--quit|--help|-h)(?:\\s|$))`,
);
const _RE_CHECKOUT_SWITCH = new RegExp(
  `(^\\s*|[\\n;&|]\\s*)git\\s+${_OPT_PREFIX}(?:checkout|switch)\\b[^\\n;&|]*\\s(?:main|master)(?:\\s|$)`,
);

/**
 * Parse `last_reconciled_sha` from a fragment body, reading ONLY the YAML
 * frontmatter block delimited by the FIRST pair of `---` lines. In a Wave-1
 * fragment that block sits AFTER the HTML banner (whose prose literally contains
 * the token `last_reconciled_sha`), so banner text is never scanned (D-W2-2).
 * Returns the trimmed value, or null when: no frontmatter block, no key in the
 * block, or an EMPTY value (I10 — empty/missing stamp is treated as coherent).
 *
 * TRUST DOCTRINE (R11 MED-B, 2026-07-04) — the stamp is an ADVISORY COHERENCE HINT,
 * NOT an authenticated input. The fragment `.session-notes.d/<id>.md` is a TRACKED,
 * single-writer-BY-DESIGN file (`knowledge-convergence.md` MUST-1); at the git level a
 * teammate with repo write can author its frontmatter and set a chosen stamp. A crafted
 * stamp (== HEAD) can therefore SUPPRESS a victim's advisory (count 0 -> coherent) — but
 * that is a SUBSET of the inherent M6-D tracked-fragment trust model (a teammate who can
 * write your fragment can already delete your notes or plant false rows), NOT a new
 * capability THIS hook introduces, and the M6-D storage layer is OUT OF #743's scope.
 * The advisory is therefore BEST-EFFORT: it fires (halt-and-report, NEVER block per
 * `hook-output-discipline.md` MUST-2) to catch the HONEST stale-ledger case (#743's
 * motivating June-frozen-ledger failure), not to defend against a malicious teammate.
 * Do NOT build an authorization / forensic control on this value — its trust posture
 * matches the forest-ledger `owner:` column's "UNSIGNED ... NOT a forensic witness"
 * doctrine. A signed-coordination-log-derived anchor was CONSIDERED and REJECTED: it
 * would require coordination-mode ON, breaking the advisory in the single-operator
 * default (loom's own mode) — exactly #743's motivating case.
 */
function parseLastReconciledSha(body) {
  if (typeof body !== "string") return null;
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].trim() === "---") {
      end = j;
      break;
    }
  }
  if (end === -1) return null;
  for (let k = start + 1; k < end; k++) {
    const m = lines[k].match(/^last_reconciled_sha:[ \t]*(.*)$/);
    if (m) return m[1].trim() || null;
  }
  return null;
}

/**
 * Real `git rev-list --count <sha>..HEAD` runner. Returns
 * `{status, count}` — `status` is the process exit code (null on spawn error),
 * `count` the parsed integer (NaN when unparseable). Never throws.
 */
function _revListCount(baseDir, sha) {
  const r = spawnSync(
    "git",
    ["-C", baseDir, "rev-list", "--count", `${sha}..HEAD`],
    // `timeout` bounds the child directly (defense-in-depth beneath the _main()
    // Rule-7 timer); a hung git returns status null → suppress via the branch below.
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 4000 },
  );
  if (r.error) return { status: null, count: NaN, error: r.error.message };
  return {
    status: r.status,
    count: parseInt(String(r.stdout || "").trim(), 10),
  };
}

/**
 * Decide whether the incorporation advisory should FIRE. Pure of side effects
 * beyond a read of the operator's own fragment + a `git rev-list` (both
 * fail-open). Returns `{ fire, reason, sha?, ahead?, fragmentPath? }`.
 *
 * @param {{baseDir:string, identity:object, command:string,
 *          _revListCount?:function}} opts
 *   `_revListCount` is injectable for deterministic exit-code-branch tests;
 *   defaults to the real spawn.
 */
function decideIncorporationAdvisory(opts) {
  const o = opts || {};
  const baseDir = o.baseDir;
  const identity = o.identity;
  const command = o.command;
  const revList =
    typeof o._revListCount === "function" ? o._revListCount : _revListCount;

  if (!isIncorporationCommand(command)) {
    return { fire: false, reason: "not-an-incorporation-command" };
  }
  const fragPath = fragmentPathFor(baseDir, identity);
  if (!fragPath) {
    // No usable identity handle → cannot locate an own fragment → coherent.
    return { fire: false, reason: "no-identity-handle" };
  }
  // Route the own-fragment read through the SINGLE guarded chokepoint
  // (session-notes-layout.js::readNotesFileGuarded). R8 completeness finding:
  // this reader was on `fs.statSync` (symlink-FOLLOWING) + size-cap ONLY, so a
  // teammate-committed symlink `.session-notes.d/<victim>.md -> /dev/zero`
  // (statSync reports size 0) passed the cap and readFileSync followed it into
  // an unbounded read → hook hang/OOM on every incorporation command (the
  // synchronous read blocks the event loop; the Rule-7 timer cannot fire). The
  // chokepoint lstat-refuses symlink/non-regular BEFORE the size check, closing
  // the reader class by construction (no per-site read left to drift). Every
  // non-ok result → suppress (fail-open, C3.3/C3.4 — coherent, never a crash):
  //   ENOENT           → no own fragment yet
  //   oversize         → fragment-too-large (unchanged reason)
  //   symlink/non-reg  → fragment-not-regular (the newly-closed vector)
  //   other read error → ZERO evidence → suppress
  const g = readNotesFileGuarded(fragPath);
  if (!g.ok) {
    const reason =
      g.kind === "stat-error" && g.err && g.err.code === "ENOENT"
        ? "no-own-fragment"
        : g.kind === "oversize"
          ? "fragment-too-large"
          : g.kind === "symlink" || g.kind === "not-regular"
            ? "fragment-not-regular"
            : "fragment-read-error";
    return { fire: false, reason, fragmentPath: fragPath };
  }
  const body = g.content;
  const sha = parseLastReconciledSha(body);
  if (!sha) {
    // I10 — empty/missing stamp is COHERENT (suppress the session-one advisory).
    return {
      fire: false,
      reason: "unstamped-coherent",
      fragmentPath: fragPath,
    };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    // A non-sha-shaped stamp never becomes a git argument (defense in depth).
    return {
      fire: false,
      reason: "stamp-not-sha-shaped",
      fragmentPath: fragPath,
    };
  }
  const r = revList(baseDir, sha);
  if (r.status === 0) {
    if (Number.isFinite(r.count) && r.count > 0) {
      return {
        fire: true,
        reason: "notes-lag",
        sha,
        ahead: r.count,
        fragmentPath: fragPath,
      };
    }
    // count === 0 (or unparseable-but-exit-0) → notes are at HEAD → coherent.
    return {
      fire: false,
      reason: "coherent-count-zero",
      sha,
      fragmentPath: fragPath,
    };
  }
  if (r.status === 128) {
    // I12b — the stamped sha is not a reachable object: rebased away OR a
    // shallow clone missing it. An errored rev-list is ZERO evidence, NOT
    // confirmation of lag (`evidence-first-claims.md` MUST-3) → suppress.
    return {
      fire: false,
      reason: "bad-rev-suppress",
      sha,
      fragmentPath: fragPath,
    };
  }
  // Any other non-zero exit, git-absent (status null), or unparseable output →
  // zero evidence → suppress (distinct from exit-128 for log legibility, I12b).
  return {
    fire: false,
    reason: `git-exit-${r.status == null ? "error" : r.status}-suppress`,
    sha,
    fragmentPath: fragPath,
  };
}

// ---- CLI entry (only when invoked directly, never on require) --------------
function _main() {
  _timeout = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1);
  }, TIMEOUT_MS);
  _timeout.unref?.();

  let input = "";
  process.stdin.on("error", passthrough);
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    clearTimeout(_timeout);
    try {
      const payload = JSON.parse(input || "{}");
      const command =
        (payload && payload.tool_input && payload.tool_input.command) || "";
      // Cheap short-circuit before any identity resolution / git spawn.
      if (!isIncorporationCommand(command)) return passthrough();

      const baseDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
      const { resolveIdentity } = require(
        path.join(__dirname, "lib", "operator-id.js"),
      );
      const identity = resolveIdentity(baseDir, {});
      const decision = decideIncorporationAdvisory({
        baseDir,
        identity,
        command,
      });
      if (!decision.fire) return passthrough();

      const { emit } = require(
        path.join(__dirname, "lib", "instruct-and-wait.js"),
      );
      const n = decision.ahead;
      emit({
        hookEvent: "PostToolUse",
        severity: "halt-and-report",
        what_happened: `An incorporation command advanced HEAD; your session-notes fragment trails HEAD by ${n} commit(s) since its last_reconciled_sha.`,
        why: "session-notes-coherence/C3 (#743): your .session-notes.d fragment's last_reconciled_sha is behind HEAD, so your notes may not reflect the just-incorporated work — the exact stale-ledger failure mode #743 exists to surface.",
        agent_must_report: [
          `State that your session-notes fragment lags HEAD by ${n} commit(s) since its last_reconciled_sha.`,
          "Reconcile your own fragment (.session-notes.d/<display_id>.md) against the incorporated work — prune landed in-flight items, refresh read-first pointers, move merged-closed ledger rows.",
          "Re-stamp last_reconciled_sha to the current HEAD after reconciling (/reconcile-notes does this for you).",
        ],
        agent_must_wait:
          "Advisory — you may proceed; reconcile your fragment when convenient (or via /reconcile-notes).",
        user_summary: `session-notes fragment lags HEAD by ${n} commit(s) — reconcile advisory (#743).`,
      });
    } catch {
      return passthrough();
    }
  });
}

if (require.main === module) {
  _main();
}

module.exports = {
  isIncorporationCommand,
  parseLastReconciledSha,
  decideIncorporationAdvisory,
  _revListCount,
};
