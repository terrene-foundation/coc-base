#!/usr/bin/env node
/**
 * probe-phase-guard.js — pre-tool-use hook enforcing the /certify probe-phase
 * no-Claude-assistance discipline (PR #355 R1 security HIGH-1 closure).
 *
 *   Event:    pre-tool-use (Read, Grep, Glob, WebFetch only)
 *   Watched:  repo-root presence of any `.claude/.certify-in-probe-<vid>.lock`
 *   Severity: block            (lockfile presence is the structural primitive
 *                               per hook-output-discipline.md MUST-2 — file
 *                               existence is process-local deterministic, not
 *                               lexical; tool name is string-equality on the
 *                               canonical CC tool set, not regex over prose)
 *             silent           (no lockfile / non-retrieval tool / outside-repo)
 *   Budget:   ≤5s; setTimeout fallback emits {continue: true} on hang
 *             (cc-artifacts.md Rule 7).
 *
 * Why block (not halt-and-report):
 *   Per hook-output-discipline.md MUST-2: "Block severity is for structural
 *   facts the agent cannot rationalize away (e.g., `CLAUDE_WORKTREE_PATH` env
 *   set + absolute path outside it; pre-commit exit code non-zero;
 *   `git status --porcelain` non-empty before `--hard`)." The lockfile is
 *   exactly that shape — a file the orchestrator wrote at probe entry, that
 *   exists xor doesn't, and a tool-name equality check is not a regex over
 *   prose. The /certify probe is the load-bearing gate against forged
 *   institutional knowledge; weakening to halt-and-report would let a future
 *   session rationalize the retrieval as "just looking up the cited section."
 *
 * Why probe phase only (not brief phase):
 *   Phase A (brief) NEEDS Read/Grep to walk the briefed surface (specs/,
 *   CLAUDE.md, rules/). The lockfile is created by the /certify command at
 *   the START of Phase B (probe), removed at Phase C completion or abandon.
 *   So Read fires fine during Phase A; only Phase B retrieval is gated.
 *
 * Pairs with:
 *   - rules/probe-driven-verification.md MUST-4 (hooks MAY use structural
 *     signals at block severity AS LONG AS gate-review counterpart exists —
 *     /certify's pass-receipt journal entry IS the gate-review counterpart).
 *   - rules/knowledge-convergence.md MUST-2 (signed pass-receipt) — the
 *     signed receipt is meaningless if the probe was assisted by retrieval.
 *
 * ENV OVERRIDES (test injection only):
 *   COC_OPERATOR_REPO_DIR  — test injection of the repo root. HONORED ONLY when
 *     git PROVES the injected directory is a checkout ROOT (`provenCheckoutRoot`,
 *     loom#1473 / #1586). See § resolveRepoDir — an unproven override is IGNORED,
 *     never trusted, because trusting it disabled this gate outright.
 *
 * Origin: PR #355 R1 multi-agent self-referential redteam (2026-05-26),
 * security-reviewer HIGH-1 (prose-only no-assist enforcement); cc-architect
 * R1 walk-receipt MUST-4 closure.
 */

"use strict";

const TIMEOUT_MS = 5000;

const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
// The verified-checkout-root predicate. NOT yet shared: the six sibling
// COC_OPERATOR_REPO_DIR readers do NOT reach it — `state-resolver.js` does not
// read that variable at all, and its one `provenCheckoutRoot` call gates
// CLAUDE_TRUST_STATE_DIR. Parity with them is OWED, not held
// (`rules/security.md` § Enforcement-Surface Parity). See § resolveRepoDir.
const { provenCheckoutRoot } = require(
  path.join(__dirname, "lib", "git-checkout-proof.js"),
);

// Retrieval-class tools — the orchestrator uses these to look things up.
// Bash, Edit, Write, MultiEdit, Task are NOT retrieval tools; the lockfile
// gate is narrow by design. Adding Bash would block the orchestrator's own
// lockfile cleanup at probe exit.
const RETRIEVAL_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch"]);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

// LOUD-on-refusal (`rules/security.md` § Secure-Default For A New Security
// Feature): a gate whose refusal is a SILENT no-op leaves an operator whose
// legitimate-but-malformed injection stopped working with no way to see why,
// and lets a genuine attack pass unremarked. One-time per process, stderr only
// — this hook's stdout is its structured protocol surface, so a diagnostic
// written there would corrupt the payload. Mirrors
// `state-resolver.js::_warnRefusedTrustStateDir`.
let _warnedRepoDir = false;
function _warnRefusedRepoDir(raw) {
  if (_warnedRepoDir) return;
  _warnedRepoDir = true;
  try {
    process.stderr.write(
      `[probe-phase-guard] REFUSED $COC_OPERATOR_REPO_DIR=${raw} — git does not ` +
        "prove it is a checkout ROOT. Ignoring the override and resolving from " +
        "the session cwd (loom#1473).\n",
    );
  } catch {
    /* stderr unavailable — never throw into a guard (zero-tolerance.md Rule 3) */
  }
}

/**
 * Resolve the repo root whose `.claude/` is searched for the probe lockfile.
 *
 * THE DEFECT THIS SHAPE EXISTS FOR (loom#1473, the 7th site of the loom#1586
 * class). The former line here was:
 *
 *     if (envDir && fs.existsSync(envDir)) return envDir;
 *
 * Existence is not proof of anything. `COC_OPERATOR_REPO_DIR` pointed at ANY
 * existing empty directory made `findProbeLockfile` search a tree that holds no
 * lockfile, so the gate reported "no probe in progress" and allowed the very
 * retrieval it exists to refuse. Measured end-to-end through this hook, one
 * `mkdir` apart, with the real lockfile present at the session cwd throughout:
 *
 *   no env override                 exit=2  BLOCK Read during /certify probe phase
 *   COC_OPERATOR_REPO_DIR=<empty>   exit=0  {"continue":true}   ← gate disabled
 *
 * The impact is the one this file's header states: `knowledge-convergence.md`
 * MUST-2's signed pass-receipt attests the operator answered unassisted, and one
 * env var let them retrieve the answers while the receipt still said otherwise.
 *
 * THE FIX IS TO VERIFY THE OVERRIDE, NOT TO IGNORE IT. The variable is a real
 * test-injection seam the harness depends on, so refusing it outright would
 * break the harness. It is now honored ONLY when git PROVES the injected
 * directory is a checkout ROOT, and IGNORED (fall through to the session cwd —
 * the protected behaviour, never an attacker-supplied path) otherwise. That is
 * the fail-closed direction for THIS gate specifically: falling back to the cwd
 * restores the lockfile search to the tree the probe is actually running in.
 *
 * WHY `provenCheckoutRoot` AND NOT A LOCAL CHECK — AND WHY NOT `requireMainCheckout`.
 * `rules/security.md` § Enforcement-Surface Parity: a fail-closed dimension lands
 * at EVERY surface through ONE shared function. That parity is NOT yet held here,
 * and saying otherwise would be the defect rather than a wording slip. The six
 * sibling hooks do NOT route this env var through `provenCheckoutRoot`:
 * `state-resolver.js` never reads COC_OPERATOR_REPO_DIR (its one
 * `provenCheckoutRoot` call gates CLAUDE_TRUST_STATE_DIR, a different variable),
 * so the siblings pass the raw value as the `cwd` ARGUMENT to
 * `requireMainCheckout` — a predicate that ACCEPTS a nested subdirectory of a
 * real checkout, which the one below REFUSES. This site is the FIRST to hold the
 * stronger predicate; the other six are owed it, and #1473 must not be closed
 * until they have it. The predicate is TWO requirements — (2a) IDENTITY, git's `--show-toplevel`
 * IS this directory rather than an ancestor; and (2b) COHERENCE, `<root>/.git`
 * NAMES the repository git reported. (2a) alone is WEAKER than the `existsSync`
 * it replaces, because `core.worktree` in an ancestor's repo-LOCAL config makes
 * git report a directory holding no `.git` entry at all as a toplevel (loom#1586).
 * A second, locally-invented predicate here is exactly how this defect survived
 * six sites; this one imports the shared one.
 *
 * `requireMainCheckout` — what the six siblings call — is deliberately NOT used.
 * It resolves to the MAIN checkout, and loom operates out of linked worktrees
 * where /certify writes its lockfile in the WORKTREE. Redirecting the search to
 * the main checkout would be a live regression, not extra safety.
 * `provenCheckoutRoot` accepts a linked worktree as a root by design.
 *
 * WHAT THIS DOES NOT CLOSE, STATED PLAINLY. An actor who can set this env var
 * can also run `git init` on an empty directory, and a real checkout with no
 * lockfile is accepted here — it IS a checkout root, so no predicate on the
 * TARGET can refuse it. This closes the COUNTERFEIT class (a directory wearing
 * no `.git` costume at all, or one that git refuses) and nothing wider, which is
 * the same scope `git-checkout-proof.js` documents for its six other callers.
 *
 * BUDGET. `provenCheckoutRoot` spawns one `git rev-parse` bounded at 2000ms,
 * inside this hook's 5000ms TIMEOUT_MS, and only when the override is SET —
 * a session with no override pays nothing.
 */
function resolveRepoDir(payload) {
  const envDir = process.env.COC_OPERATOR_REPO_DIR;
  if (envDir) {
    const proof = provenCheckoutRoot(envDir);
    if (proof) return proof.realRoot;
    // FALL THROUGH (fail closed): ignore the unproven redirect.
    _warnRefusedRepoDir(envDir);
  }
  if (payload && typeof payload.cwd === "string" && payload.cwd.length > 0) {
    return payload.cwd;
  }
  return process.cwd();
}

/**
 * Find any `.claude/.certify-in-probe-*.lock` file in repo-root `.claude/`.
 * Returns the lockfile basename on hit, null on miss.
 *
 * Structural primitive: fs.readdirSync + filename equality match. NOT a
 * regex over prose; the lockfile naming pattern is fixed by /certify's
 * command body.
 */
function findProbeLockfile(repoDir) {
  const claudeDir = path.join(repoDir, ".claude");
  try {
    if (!fs.existsSync(claudeDir)) return null;
    const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith(".certify-in-probe-") && e.name.endsWith(".lock")) {
        return e.name;
      }
    }
    return null;
  } catch {
    // Defensive: any fs error treated as "no lockfile" (passthrough). The
    // /certify command's own structural identity-gate check (Step 1) catches
    // misconfigured repos before probe entry; this hook is the per-tool-call
    // defense, not the only line.
    return null;
  }
}

(async function main() {
  try {
    const payload = await readStdinBounded();
    const hookEvent = payload.hook_event_name || "PreToolUse";
    const tool = payload && payload.tool_name;

    // Tool-class gate — only retrieval tools are guarded. String equality on
    // the canonical CC tool set is structural per hook-output-discipline.md
    // MUST-2, not lexical regex over prose.
    if (!RETRIEVAL_TOOLS.has(tool)) {
      passthrough();
    }

    const repoDir = resolveRepoDir(payload);
    const lockfile = findProbeLockfile(repoDir);

    if (!lockfile) {
      // No probe in progress — passthrough. The hook is silent during
      // normal sessions and during /certify Phase A (brief).
      passthrough();
    }

    // Probe in progress + retrieval tool requested = block.
    clearTimeout(fallback);
    emit({
      hookEvent,
      severity: "block",
      what_happened: `/certify probe phase active (${lockfile} present); ${tool} call blocked.`,
      why: "/certify probe phase is the load-bearing institutional-knowledge gate; orchestrator retrieval (Read/Grep/Glob/WebFetch) during probe would assist the operator with answers they should be producing from their own absorbed knowledge. Per `rules/knowledge-convergence.md` MUST-2 the signed pass-receipt is meaningless if the probe was assisted. Structural primitive: lockfile existence + tool-name equality, NOT lexical regex (hook-output-discipline.md MUST-2 permits block on structural signals).",
      agent_must_report: [
        `Tool blocked: ${tool}`,
        `Lockfile present: .claude/${lockfile}`,
        "If you are running /certify Phase B (probe), do NOT retrieve the cited section, the answer, or any rephrasing — the probe tests what the operator absorbed during Phase A (brief), not what you can look up.",
        'If the operator asks for help during probe, refuse with one sentence: "I cannot assist during the gate phase; re-read the cited section and answer when ready."',
        "If the lockfile is stale (a prior /certify session crashed without cleanup), the operator must remove `.claude/" +
          lockfile +
          "` manually before retrying.",
      ],
      agent_must_wait:
        "Do not retry retrieval against this tool. If the operator has answered the current probe question, proceed to judge per the bank's `expected:` + `grading_rubric:` (no retrieval needed for judging — the bank ships the canonical answer + rubric).",
      user_summary: `probe-phase-guard — BLOCK ${tool} during /certify probe phase`,
    });
    // emit() exits
  } catch (err) {
    try {
      process.stderr.write(
        `[ADVISORY] probe-phase-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
      );
    } catch {
      // best-effort
    }
    try {
      clearTimeout(fallback);
      process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    } catch {
      // best-effort
    }
    process.exit(0);
  }
})();
