#!/usr/bin/env node
/**
 * Hook: ci-job-budget-guard
 * Event: PostToolUse (Edit | Write | NotebookEdit) — matches the registration in
 *        `.claude/settings.json`.
 *
 * @hook-event: PostToolUse:Edit|Write|NotebookEdit (guard) — the subject is the
 * workflow YAML AFTER the edit lands, so the job set being judged is the one the
 * author actually wrote. PreToolUse cannot see it: the edit has not been applied,
 * so the guard would have to re-derive the post-edit file from the tool payload
 * and would judge a document that does not exist on disk. The class is `guard`
 * rather than `telemetry` because it emits a finding about the edit, and
 * `advisory` rather than `block` because the trigger is a lexical read of YAML —
 * `hook-output-discipline.md` MUST-2 bars `block` on lexical evidence, and adding
 * a CI job is legitimate work this must never wedge.
 * Purpose: surface a CI job added to a `pull_request` workflow that is neither a
 *          required context, nor relevance-gated, nor budgeted — at the moment it
 *          is authored, not many merges later when the shared pool is saturated.
 *
 * WHY AT EDIT TIME
 * ----------------
 * `.claude/bin/ci-job-budget-audit.mjs` is the AUTHORITY and runs in CI. But a job
 * added today is paid for on every pull request from tomorrow, and a CI failure
 * arrives after the diff is already written and pushed. The originating measurement
 * (`rules/ci-job-budget.md` § Origin): one pull request fanned out to 33
 * runner-consuming jobs against a pool of 24, of which only 12 gated anything. No
 * single edit caused that — it accreted, one unremarkable job at a time, and
 * nothing said anything at the moment each was added.
 *
 * SEVERITY: `advisory`, never `block`. The trigger is a LEXICAL read of workflow
 * YAML, and `hook-output-discipline.md` MUST-2 bars a lexical detector from
 * carrying `block`. It also MUST NOT block on the merits: adding a CI job is
 * legitimate work — the goal is that it becomes a DECLARED act, not that it is
 * refused.
 *
 * FAIL-OPEN, BUT NOT SILENTLY INERT
 * ---------------------------------
 * `cc-artifacts.md` Rule 7 requires a hook to fail OPEN on unknowns under a bounded
 * timer. It does NOT require silence, and the difference is load-bearing HERE:
 * `.claude/hooks/**` is on the sync `ALWAYS_INCLUDE` surface, so this file reaches
 * every consumer. If it fell silent when the engine were absent it would present as
 * coverage while checking nothing — which is the exact defect class
 * `verification-gate-integrity.md` MUST-2 names (absence of a result is not a pass).
 *
 * So the engine-absent path EMITS an advisory NAMING what is not being checked,
 * rather than returning quiet. Two bounds keep that from becoming a nag:
 *   (1) it fires only when the edited file actually carries a `pull_request`
 *       trigger token — a cheap DIAGNOSTIC relevance filter, deliberately NOT a
 *       classifier. It never decides anything about a job; it only decides whether
 *       an engine-absence notice is worth printing. It may over-report (the token
 *       can appear in a comment); over-reporting a diagnostic is safe, and it can
 *       never under-classify a job because it never looks at one.
 *   (2) it is deduplicated ONCE PER SESSION via a marker in the OS temp dir. If the
 *       marker cannot be written the notice is emitted anyway — the dedupe itself
 *       fails open, because a repeated diagnostic is strictly better than a lost one.
 *
 * ON ITS OWN INTERNAL ERRORS the guard stays quiet (the blanket catch at the
 * bottom), because a guard that cannot parse a workflow must not cry wolf. That
 * asymmetry — loud about a MISSING engine, quiet about its OWN parse failure — is
 * deliberate: the first is a coverage gap the reader can act on, the second is
 * noise the CI audit already covers.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));

const TIMEOUT_MS = 5000;
let timer = null;

function quiet() {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

/** The cascading engine path. NOT a repo-root `scripts/` path: that cascades to
 *  nobody, and a hook pointing at one would be inert in every consumer. */
const ENGINE_REL = ["..", "bin", "ci-job-budget-audit.mjs"];

/** Is this path a GitHub workflow file? SHAPE only — containment is separate. */
function isWorkflow(p) {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(String(p || ""));
}

/**
 * DIAGNOSTIC relevance filter for the engine-absent notice ONLY. Not a classifier
 * and never used to judge a job — see the header. Matches a `pull_request` key at
 * any indent, which is intentionally permissive.
 */
function looksPullRequestTriggered(src) {
  return /^[ \t]*pull_request(_target)?[ \t]*:/m.test(String(src || ""));
}

/**
 * Strip characters that would let a filename inject structure into the advisory.
 * `[^/]` in JS ALSO matches newline, so an unconstrained basename could otherwise
 * break the message into forged lines.
 */
function safeName(s) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

/** Once-per-session dedupe for the engine-absent notice. Fails OPEN (returns
 *  false = "not yet seen") on any error, so the notice is never lost to a
 *  filesystem problem. */
function alreadyNotifiedThisSession(sessionId) {
  if (!sessionId) return false;
  try {
    const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!safe) return false;
    const marker = path.join(os.tmpdir(), `coc-cjb-engine-absent-${safe}`);
    // `wx` is atomic create-or-fail: the first caller writes it and reports
    // "not yet seen", every later caller in the same session gets EEXIST.
    fs.writeFileSync(marker, "1", { flag: "wx" });
    return false;
  } catch (e) {
    if (e && e.code === "EEXIST") return true;
    return false;
  }
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  timer = setTimeout(() => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      Promise.resolve()
        .then(() => onStdinEnd(input))
        .then(resolve, reject);
    });
  });
}

async function onStdinEnd(input) {
  try {
    // The timer is deliberately NOT cleared here, and its coverage is NARROWER
    // than it looks. A setTimeout callback cannot fire while the event loop is
    // blocked, and every fs call below is SYNCHRONOUS — so the timer does NOT
    // guard the reads, which is the half a caller-supplied path can influence.
    // It guards the awaited dynamic import(), which yields. The O_NONBLOCK open
    // and the size cap are what bound the read. Cleared on every exit path
    // (quiet() and each emit path).
    const data = JSON.parse(input || "{}");
    const ti = data.tool_input || {};
    const file = ti.file_path || ti.notebook_path || "";
    if (!isWorkflow(file)) return quiet();
    if (!fs.existsSync(file)) return quiet();

    // Containment + size cap, BEFORE anything reads content. `isWorkflow` tests
    // the path SHAPE only, so `/tmp/x/.github/workflows/y.yml` and
    // `../../.github/workflows/y.yml` both pass it.
    //
    // CANONICAL, not lexical. `path.resolve` collapses `..` and nothing else: a
    // symlink at a lexically-contained path whose TARGET escapes the repo would
    // pass a string check and have its content read and quoted back into the
    // advisory. `security.md` § Path Containment requires BOTH the candidate and
    // the boundary root resolved through the SAME resolver.
    //
    // Fail CLOSED: a path that will not resolve is not a path we read. This
    // closes the LEXICAL-BYPASS class and — stated so it is not over-claimed —
    // does NOT by itself defeat the check-to-use TOCTOU; that needs enforcement
    // at the SINK, which is what the file descriptor below provides.
    let repoRoot, resolved;
    try {
      repoRoot = fs.realpathSync(path.resolve(__dirname, "..", ".."));
      resolved = fs.realpathSync(path.resolve(file));
    } catch {
      return quiet();
    }
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
      return quiet();
    }

    // Read through a FILE DESCRIPTOR, and stat THAT descriptor. `statSync` then
    // `readFileSync(path)` is a check-to-use gap: the path can be swapped between
    // the two calls, so the size that was checked is not necessarily the size
    // that is read.
    //
    // REGULAR FILES ONLY, and O_NONBLOCK, because `open` ITSELF blocks on a FIFO
    // — before any stat can run, so an fstat-then-reject is too late. A FIFO also
    // reports size 0, so it would pass a size cap and then block the read
    // indefinitely, and the timer cannot rescue that: a setTimeout callback
    // cannot fire while a SYNCHRONOUS read blocks the event loop. That is a hung
    // session from a path a caller supplies. O_NONBLOCK is harmless on a regular
    // file.
    let src;
    let fd = null;
    try {
      fd = fs.openSync(
        resolved,
        fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0),
      );
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return quiet();
      if (st.size > 512 * 1024) return quiet();
      src = fs.readFileSync(fd, "utf8");
    } catch {
      return quiet();
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }

    const base = safeName(path.basename(file));
    const enginePath = path.resolve(__dirname, ...ENGINE_REL);

    // ── the engine-absent path: fail OPEN, and SAY SO ───────────────────────
    if (!fs.existsSync(enginePath)) {
      if (!looksPullRequestTriggered(src)) return quiet();
      if (alreadyNotifiedThisSession(data.session_id)) return quiet();
      clearTimeout(timer);
      return emit({
        hookEvent: "PostToolUse",
        severity: "advisory",
        what_happened:
          `CI JOB BUDGET — NOT CHECKED. ${base} carries a pull_request trigger, but the ` +
          "job-budget audit engine is not present in this repo at " +
          "`.claude/bin/ci-job-budget-audit.mjs`, so NO job in this workflow was " +
          "classified. This notice replaces silence deliberately: a guard that returned " +
          "quiet here would present as coverage while checking nothing.\n" +
          "  What is NOT being checked: whether each job reachable from `pull_request` is " +
          "a required context, relevance-gated, or budgeted with a dated rationale; and " +
          "whether the per-pool worst-case demand fits the declared capacity.\n" +
          "  This is a coverage gap, not a finding about your edit. The edit stands.",
        why: "ci-job-budget.md MUST-1 is unenforced here without the audit engine; verification-gate-integrity.md MUST-2 — absence of a result is not a pass",
        agent_must_report: [
          "State that the ci-job-budget edit-time check did NOT run, and why (engine absent), rather than reporting the workflow edit as clean",
          "If this repo is meant to carry the check, obtain `.claude/bin/ci-job-budget-audit.mjs` from the upstream template sync; if it is deliberately not carried, say so",
        ],
        user_summary: `job-budget check did not run on ${base} (audit engine absent)`,
      });
    }

    // Reuse the AUDIT's own parsers and classifier. Two implementations of one
    // contract drift, and nothing in CI runs this hook — so a divergence would
    // show up only as a guard that had quietly stopped agreeing with the
    // authority it exists to preview.
    const A = await import(`file://${enginePath}`);
    if (!A.triggersOnPullRequest(src)) return quiet();

    // Degrade LOUDLY on a malformed declaration rather than letting the blanket
    // catch below turn a throw into silence — one malformed sibling declaration
    // would otherwise switch the edit-time guard off with no signal. An empty
    // budget set OVER-reports rather than under-reports, and the reason is
    // carried into the advisory so a spurious row is attributable.
    let decl,
      declUnavailable = null;
    try {
      // Two calls, not one: the engine separates RESOLVING the declaration path
      // (env override, else its own bin dir) from READING it, so a deployment can
      // relocate the declaration without the reader guessing. Calling a single
      // no-arg loader — as this hook did before the engine landed — would not
      // even import.
      decl = A.loadDeclaration(A.resolveDeclarationPath());
    } catch (e) {
      decl = { budgeted: {} };
      declUnavailable = safeName(e && e.message);
    }
    let required,
      requiredUnavailable = null;
    try {
      // Takes the declaration: the required-context set is declared BESIDE the
      // pools, so reading it independently would re-open the drift this split
      // exists to close.
      required = A.loadRequiredContexts(decl);
    } catch (e) {
      required = new Set();
      requiredUnavailable = safeName(e && e.message);
    }

    const budgeted = new Set(Object.keys(decl.budgeted || {}));
    const pathsFiltered = A.workflowHasPathsFilter(src);

    const offenders = [];
    // ONE classifier, shared with the audit — never re-derived here.
    for (const b of A.jobBlocks(src)) {
      const row = A.classifyJob(b, {
        pathsFiltered,
        requiredContexts: required,
        pools: decl.pools || {},
        budgeted,
        file: base,
      });
      // null = the job's `if:` pins it to a non-PR event, so it cannot run on a
      // pull request at all.
      if (!row) continue;
      if (row.required || row.gated || row.budgeted) continue;
      offenders.push({
        key: safeName(row.key),
        pool: safeName(row.pool) || "UNDECLARED POOL",
      });
    }
    if (!offenders.length) return quiet();

    // A truncated list is worse than a short one: the reader cannot tell which
    // offenders were dropped. Cap explicitly and NAME the elided count, so the
    // message stays a bounded payload and the omission is visible rather than
    // silent.
    const CAP = 20;
    const shown = offenders.slice(0, CAP);
    const lines =
      shown.map((o) => `  - ${o.key}  (pool: ${o.pool})`).join("\n") +
      (offenders.length > CAP
        ? `\n  ... and ${offenders.length - CAP} more (run the audit for the full list)`
        : "");
    clearTimeout(timer);
    emit({
      hookEvent: "PostToolUse",
      severity: "advisory",
      what_happened:
        (requiredUnavailable
          ? `NOTE: the required-context set was UNAVAILABLE (${requiredUnavailable}), so a job that IS a required context may be listed below in error. Classification is incomplete.\n`
          : "") +
        (declUnavailable
          ? `NOTE: the job-budget declaration was UNAVAILABLE (${declUnavailable}), so a job that IS budgeted may be listed below in error. Classification is incomplete.\n`
          : "") +
        `CI JOB BUDGET — ${offenders.length} job(s) in ${base} run on every pull request but ` +
        `gate nothing:\n${lines}\n` +
        "  A job in this state is the worst of both: it consumes a runner slot on every " +
        "pull request and cannot block a merge. The edit stands — this is advisory.",
      why: "ci-job-budget.md MUST-1: a PR-reachable job is required, relevance-gated, or budgeted with a reason",
      agent_must_report: [
        "For each job listed: promote it to a required context, add a per-job relevance skip, move it off the pull_request trigger, or declare it in this repo's job-budget declaration with a dated rationale",
        "Run `node .claude/bin/ci-job-budget-audit.mjs` and report the per-pool worst-case figures",
      ],
      user_summary: `${offenders.length} ungated non-gating CI job(s) in ${base}`,
    });
  } catch (error) {
    // Quiet on the guard's OWN failure — see the header. The CI audit is the
    // authority and is not subject to this hook's parsing. The stderr line keeps
    // the failure attributable without wedging the session.
    process.stderr.write(
      `[HOOK ERROR] ci-job-budget-guard: ${error && error.message}\n`,
    );
    quiet();
  }
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
