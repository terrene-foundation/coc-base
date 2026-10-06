"use strict";
/**
 * landing-provenance-audit.js — the SessionStart audit of the landing-provenance
 * machinery: it reports what the push-time gate CANNOT refuse, after the fact.
 *
 * The push gate (`scripts/ci/landing-trailer-gate.mjs`, run by
 * `scripts/ci/dev-push-guard.mjs`, run by the `pre-push` shim) refuses an
 * untrailered commit — but only on a push that goes THROUGH it. Three things
 * defeat it silently, and each is reported here:
 *
 *   (c) a shim — `.githooks/pre-push` (the push gate) or `.githooks/commit-msg`
 *       (stamps `Landed-From: direct`) — is not installed, differs from its
 *       tracked copy, or is not executable (git skips a non-executable hook with
 *       a hint, rc=0); a tracked shim ABSENT at the checkout's toplevel is
 *       reported as such (it cannot be judged, and is never read as installed);
 *       or the PUSHING checkout's own guard predates the landing check (the shim
 *       runs the guard from the pushing worktree's toplevel, so a worktree on a
 *       pre-fix commit pushes through a guard without it).
 *   (d) a push made somewhere the gate never ran (another machine, the web UI,
 *       `--no-verify`) cannot be blocked, only DETECTED: every commit past the
 *       cutover on the remote-tracking integration / promotion branch is judged.
 *       A non-merge commit needs a VALID `Landed-From` / `Landed-Partial` value
 *       (any malformed value, or `direct` beside a source value, flags it); a
 *       MERGE without one must be a clean two-parent auto-merge (`git merge-tree
 *       --write-tree` of its parents reproduces its tree), else it is listed
 *       UNVERIFIABLE — a merge can carry resolution content no parent has. The
 *       cutover used is the one in the config AS COMMITTED at the judged tip
 *       (`core.loadConfigAt`), not the working tree's, when that commit has one.
 *   (f) LANDED-OPEN: a local branch the trailers say is fully landed but which
 *       still exists — the retire step was never run.
 *
 * INERT without `.claude/bin/landing-provenance.json` (consumers receive hooks
 * but not the config): `runAudit` returns null after at most ONE git spawn
 * (`loadConfig`'s `rev-parse --show-toplevel`, `.claude/hooks/lib/landed-map.js:395-416`).
 *
 * NEVER THROWS, and never looks clean when it did not run: every failure becomes
 * `{ ran: false, why }` or a per-section `{ error }`, both rendered LOUDLY.
 *
 * NO NETWORK. (d) and (f) read LOCAL remote-tracking refs, so the answer is as
 * fresh as the last fetch; the rendered block names the tip it judged.
 *
 * SCOPE OF (c), stated because the instrument is blind to it: git is spawned
 * through `git-subprocess-env.js::gitEnv`, which nulls GLOBAL and SYSTEM config,
 * so a `core.hooksPath` set ONLY in `~/.gitconfig` is not seen; repository and
 * worktree config are. The guard check is LEXICAL (string presence of
 * `landing-trailer-gate.mjs`), not a proof the call runs.
 */

const fs = require("node:fs");
const path = require("node:path");
const core = require("./landed-map.js");

const FIX_HOOK = "node .claude/bin/land-lane.mjs verify-hook --install";
const FIX_RETIRE = "node .claude/bin/land-lane.mjs retire --apply";
// The tracked shims (c) checks, each against the hook git would actually run.
const SHIMS = Object.freeze([
  { name: "pre-push", label: "PRE-PUSH HOOK", ungated: (cfg) => `pushes from this clone reach ${cfg.integration_branch} UNGATED` },
  { name: "commit-msg", label: "COMMIT-MSG HOOK", ungated: (cfg) => `commits made directly on ${cfg.integration_branch} here are NOT stamped \`Landed-From: direct\`, and the push gate will refuse them` },
]);
const GUARD_REL = path.join("scripts", "ci", "dev-push-guard.mjs");
const GUARD_NEEDLE = "landing-trailer-gate.mjs";
const SHA40 = /^[0-9a-f]{40}$/;
const PER_CALL_CAP_MS = 2000;

// Read with `git log -z`: NUL-terminated records of SEVEN newline-separated
// fields — id, parent ids, tree id, subject, Landed-From values, Landed-Partial
// values, and the id AGAIN as a closing sentinel (parseAuditLog).
const LOG_FORMAT =
  "%H%n%P%n%T%n%s%n" +
  `%(trailers:key=${core.TRAILER_FROM},valueonly,unfold,separator=%x1f)%n` +
  `%(trailers:key=${core.TRAILER_PARTIAL},valueonly,unfold,separator=%x1f)%n` +
  "%H";

class BudgetExhausted extends Error {}

function short(s) {
  return String(s || "").slice(0, 12);
}

function cleanSubject(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || "").replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 120);
}

function shortRef(ref) {
  return String(ref || "").replace(/^refs\/(heads|remotes)\//, "");
}

/**
 * Judge ONE commit's Landed-From / Landed-Partial values. Pure.
 *   { stamped: true }                          every value parses and the set is coherent
 *   { stamped: false, malformed: true, why }   ANY value is malformed — even beside a
 *                                              valid one — or `direct` is mixed with a
 *                                              source value, or `direct` is used as
 *                                              Landed-Partial (valid only as
 *                                              Landed-From: `.claude/hooks/lib/landed-map.js`
 *                                              foldRecords, the `p.direct` arm)
 *   { stamped: false, malformed: false, why }  no value at all
 * A malformed value is never outvoted by a valid neighbour: a commit whose
 * provenance is partly unreadable is flagged, not waved through.
 */
function judgeStamp(fromVals, partialVals) {
  const bad = [];
  let direct = 0;
  let sources = 0;
  for (const [key, list] of [[core.TRAILER_FROM, fromVals], [core.TRAILER_PARTIAL, partialVals]]) {
    for (const raw of list) {
      const p = core.parseTrailerValue(raw);
      if (p.error) { bad.push(`malformed ${key}: ${p.error}`); continue; }
      if (p.direct && key !== core.TRAILER_FROM) { bad.push(`${key}: direct is only valid as ${core.TRAILER_FROM}`); continue; }
      if (p.direct) direct += 1;
      else sources += 1;
    }
  }
  if (direct > 0 && sources > 0) bad.push(`\`${core.TRAILER_FROM}: direct\` mixed with ${sources} source trailer(s) on one commit`);
  if (bad.length) return { stamped: false, malformed: true, why: bad.join("; ") };
  if (direct + sources === 0) return { stamped: false, malformed: false, why: "no Landed-From / Landed-Partial trailer" };
  return { stamped: true };
}

/**
 * Parse `git log -z --format=LOG_FORMAT` output into
 * [{ sha, parents, tree, subject, from, partial }]. Pure; NEVER throws. A record
 * without the seven-field shape framed by its id is returned as
 * `{ sha: <id or null>, unparseable: why, raw }` — the caller LISTS it (an
 * unreadable commit is not a judged-clean commit).
 */
function parseAuditLog(text) {
  const out = [];
  for (const chunk of String(text).split("\x00")) {
    const r = chunk.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!r) continue;
    const f = r.split("\n");
    const lead = SHA40.test(f[0]) ? f[0] : null;
    if (f.length !== 7 || !lead || f[6] !== lead || !SHA40.test(f[2])) {
      out.push({ sha: lead, unparseable: `log record has ${f.length} field(s), expected 7 framed by the commit id`, raw: r.slice(0, 120) });
      continue;
    }
    const list = (s) => s.split("\x1f").map((x) => x.trim()).filter(Boolean);
    out.push({ sha: lead, parents: f[1].split(" ").filter(Boolean), tree: f[2], subject: f[3], from: list(f[4]), partial: list(f[5]) });
  }
  return out;
}

/**
 * A budget-bound git runner over the core's `_git` — which pins
 * `-c log.showSignature=false` and `GIT_NO_REPLACE_OBJECTS=1` on EVERY call
 * (`.claude/hooks/lib/landed-map.js`, `GIT_PRE_ARGS` and `git()`), so no log
 * this audit reads can be reshaped by a signature block or a replace ref.
 * `g.timeoutMs()` is the per-call timeout a core helper should be given.
 */
function makeRunner(deadline) {
  const timeoutMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BudgetExhausted("audit time budget exhausted");
    return Math.min(remaining, PER_CALL_CAP_MS);
  };
  const g = function g(repoDir, args) {
    return core._git(repoDir, args, { timeoutMs: timeoutMs() });
  };
  g.timeoutMs = timeoutMs;
  return g;
}

function okOut(r, what) {
  if (r.status !== 0) throw new Error(`git ${what} failed (status ${r.status}): ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

// ── (c) the pre-push shim and the pushing checkout's guard ──────────────────

function auditHook(g, top, name = "pre-push") {
  const gp = okOut(g(top, ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`]), "rev-parse --git-path").trim();
  if (!gp) throw new Error(`\`git rev-parse --git-path hooks/${name}\` returned nothing`);
  const hookPath = path.resolve(top, gp);
  const rel = `.githooks/${name}`;
  const trackedPath = path.join(top, ".githooks", name);
  let tracked;
  try { tracked = fs.readFileSync(trackedPath); } catch (e) {
    if (e.code === "ENOENT") {
      return { name, hookPath, trackedPath, problems: [`tracked shim missing: ${rel} is absent at ${top} — cannot judge the installed hook (NOT read as installed)`] };
    }
    return { name, hookPath, trackedPath, problems: [`tracked ${rel} unreadable at ${top} (${e.code || e.message}) — cannot judge the installed hook`] };
  }
  let installed;
  let st;
  try {
    st = fs.statSync(hookPath);
    installed = fs.readFileSync(hookPath);
  } catch (e) {
    if (e.code === "ENOENT") return { name, hookPath, trackedPath, problems: ["MISSING"] };
    return { name, hookPath, trackedPath, problems: [`UNREADABLE (${e.code || e.message})`] };
  }
  const problems = [];
  if (!installed.equals(tracked)) problems.push(`STALE (differs byte-for-byte from the tracked ${rel})`);
  if (process.platform !== "win32" && (st.mode & 0o111) === 0) problems.push("NOT EXECUTABLE (git skips it with a hint and proceeds)");
  return { name, hookPath, trackedPath, problems };
}

function auditGuard(top) {
  const guardPath = path.join(top, GUARD_REL);
  let text;
  try { text = fs.readFileSync(guardPath, "utf8"); } catch (e) {
    return { guardPath, problem: `MISSING (${e.code || e.message})` };
  }
  return { guardPath, problem: text.includes(GUARD_NEEDLE) ? null : `lacks any reference to ${GUARD_NEEDLE}` };
}

// ── (d) untrailered commits on the remote-tracking branches ─────────────────

function auditBranchTrailers(g, top, cfg, branch) {
  const ref = `refs/remotes/${cfg.remote}/${branch}`;
  const label = `${cfg.remote}/${branch}`;
  const rp = g(top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const tip = rp.status === 0 ? rp.stdout.trim() : "";
  if (!SHA40.test(tip)) return { label, skipped: `no remote-tracking ref ${label} (never fetched?) — not judged` };
  // The cutover the judged tip ITSELF commits to — what the push gate judges by
  // — not the working tree's, which may be edited, stale, or on another branch.
  const cc = core.loadConfigAt(top, tip, { timeoutMs: g.timeoutMs() });
  let cutover = cfg.cutover;
  let cutoverFrom = "working-tree config (none committed at the judged tip)";
  if (cc.ok) {
    cutover = cc.config.cutover;
    cutoverFrom = `config as committed at ${label}@${short(tip)}`;
  } else if (!cc.absent) {
    throw new Error(`the config committed at ${label}@${short(tip)} is unusable: ${cc.why}`);
  }
  const anc = g(top, ["merge-base", "--is-ancestor", cutover, tip]);
  if (anc.status === 1) {
    // Without this, `tip ^cutover` on a DIVERGED branch lists every pre-recording
    // commit since the merge base as "untrailered" — a flood of false reports.
    const behind = g(top, ["merge-base", "--is-ancestor", tip, cutover]).status === 0;
    return {
      label,
      tip,
      cutover,
      cutoverFrom,
      skipped: `cutover ${short(cutover)} is not an ancestor of ${label}@${short(tip)} (as of last fetch)` +
        (behind ? " — the recording cutover has not reached it yet" : " — the branch has DIVERGED from the cutover") +
        "; nothing there is judged",
    };
  }
  okOut(anc, "merge-base --is-ancestor");
  const out = okOut(g(top, ["log", "-z", `--format=${LOG_FORMAT}`, tip, `^${cutover}`]), "log");
  const untrailered = [];
  const unverifiableMerges = [];
  let judged = 0;
  for (const rec of parseAuditLog(out)) {
    judged += 1;
    if (rec.unparseable) {
      untrailered.push({ sha: rec.sha || "(no commit id)", subject: cleanSubject(rec.raw), why: `unreadable log record: ${rec.unparseable}` });
      continue;
    }
    const j = judgeStamp(rec.from, rec.partial);
    if (j.stamped) continue;
    if (rec.parents.length < 2 || j.malformed) {
      untrailered.push({ sha: rec.sha, subject: cleanSubject(rec.subject), why: j.why });
      continue;
    }
    const why = judgeMerge(g, top, rec);
    if (why) unverifiableMerges.push({ sha: rec.sha, subject: cleanSubject(rec.subject), why });
  }
  return { label, tip, cutover, cutoverFrom, judged, untrailered, unverifiableMerges };
}

/**
 * A MERGE with no landing trailer is acceptable only as a clean two-parent
 * auto-merge: re-merging its parents (`git merge-tree --write-tree`, no working
 * tree touched) must succeed without conflict AND reproduce its tree exactly.
 * Anything else may carry content no parent has. Returns null (clean) or why.
 */
function judgeMerge(g, top, rec) {
  if (rec.parents.length !== 2) return `${rec.parents.length}-parent merge (only a clean two-parent auto-merge is verifiable)`;
  const r = g(top, ["merge-tree", "--write-tree", rec.parents[0], rec.parents[1]]);
  const tree = r.stdout.split("\n")[0].trim();
  if (r.status === 1) return "re-merging its parents CONFLICTS, so the recorded result is a hand resolution";
  if (r.status !== 0 || !SHA40.test(tree)) return `could not re-merge its parents (merge-tree status ${r.status}: ${r.stderr.trim().slice(0, 120)})`;
  if (tree !== rec.tree) return `its tree ${short(rec.tree)} differs from the clean auto-merge of its parents (${short(tree)}): content was changed in the merge`;
  return null;
}

// ── (f) LANDED-OPEN local branches ─────────────────────────────────────────

function auditLandedOpen(g, top, cfg, { useCache, verdictBudgetMs, deadline }) {
  const remaining = () => Math.max(0, deadline - Date.now());
  const timeoutMs = Math.min(remaining(), PER_CALL_CAP_MS);
  if (timeoutMs <= 0) throw new BudgetExhausted("audit time budget exhausted");
  const map = core.buildLandedMap({ repoDir: top, config: cfg, useCache, timeoutMs });
  if (!map.ok) return { error: `no landed map: ${map.why}` };
  const refs = okOut(g(top, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]), "for-each-ref");
  const branches = [];
  for (const line of refs.split("\n")) {
    const [ref, tip] = line.split("\0");
    if (!ref || !ref.startsWith("refs/heads/")) continue;
    const name = ref.slice("refs/heads/".length);
    if (cfg.protected_branches.includes(name) || name.startsWith("landed/")) continue;
    branches.push({ ref, name, tip });
  }
  const verdicts = core.landedVerdicts({
    repoDir: top,
    branches,
    map,
    timeoutMs: Math.min(remaining(), PER_CALL_CAP_MS) || 1,
    budgetMs: Math.min(verdictBudgetMs, remaining()),
  });
  const landedOpen = [];
  const unmeasured = [];
  for (const v of verdicts) {
    if (v.decided && v.landed) landedOpen.push(v.name);
    else if (!v.decided && !v.fallback) unmeasured.push({ name: v.name, why: v.why || v.status });
  }
  return { mapRef: shortRef(map.ref), mapTip: map.tip, considered: branches.length, landedOpen, unmeasured };
}

// ── entry point ────────────────────────────────────────────────────────────

function section(fn) {
  try { return fn(); } catch (e) {
    return { error: e instanceof BudgetExhausted ? "audit time budget exhausted before this check" : e.message };
  }
}

/**
 * Run the audit. Returns null when the repo has no config (INERT), else
 * `{ ran: false, why }` or `{ ran: true, config, top, hook, guard, trailers, open }`.
 * Never throws.
 */
function runAudit({ repoDir = process.cwd(), budgetMs = 3000, verdictBudgetMs = 1500, useCache = true } = {}) {
  try {
    const deadline = Date.now() + budgetMs;
    const c = core.loadConfig(repoDir, { timeoutMs: Math.min(budgetMs, PER_CALL_CAP_MS) });
    if (!c.ok && c.absent) return null;
    if (!c.ok) return { ran: false, why: `config invalid: ${c.why}` };
    const cfg = c.config;
    const g = makeRunner(deadline);
    const top = okOut(g(repoDir, ["rev-parse", "--show-toplevel"]), "rev-parse --show-toplevel").trim();
    if (!top) return { ran: false, why: "could not resolve the checkout toplevel" };
    const hooks = SHIMS.map((s) => ({ name: s.name, ...section(() => auditHook(g, top, s.name)) }));
    const hook = hooks[0]; // pre-push, kept under its original key
    const guard = section(() => auditGuard(top));
    const trailers = [];
    for (const b of [...new Set([cfg.integration_branch, cfg.promotion_branch])]) {
      trailers.push({ label: `${cfg.remote}/${b}`, ...section(() => auditBranchTrailers(g, top, cfg, b)) });
    }
    const open = section(() => auditLandedOpen(g, top, cfg, { useCache, verdictBudgetMs, deadline }));
    return { ran: true, config: cfg, top, hook, hooks, guard, trailers, open };
  } catch (e) {
    return { ran: false, why: e instanceof BudgetExhausted ? "audit time budget exhausted" : e.message };
  }
}

/** Render a runAudit result to the SessionStart block. Pure. null in → null out. */
function renderAudit(result) {
  if (result === null || result === undefined) return null;
  const H = "## Landing provenance";
  if (!result.ran) return `${H}\nlanding-provenance audit did not run: ${result.why} — NOTHING below was checked; this is not a clean result.`;
  const cfg = result.config;
  const warn = [];
  const info = [];

  const hooks = result.hooks || (result.hook ? [{ name: "pre-push", ...result.hook }] : []);
  const current = [];
  for (const h of hooks) {
    const shim = SHIMS.find((s) => s.name === h.name) || SHIMS[0];
    if (h.error) { warn.push(`${shim.label}: check did not run: ${h.error}`); continue; }
    if (h.problems && h.problems.length) {
      const cannotJudge = h.problems.some((p) => p.startsWith("tracked") || p.startsWith("UNREADABLE"));
      const ungated = h.problems.some((p) => p.startsWith("MISSING") || p.startsWith("NOT EXECUTABLE"));
      const impact = cannotJudge
        ? `whether the ${h.name} check runs is UNKNOWN (not a pass)`
        : ungated
          ? shim.ungated(cfg)
          : `the ${h.name} hook that runs is not the tracked, reviewed one`;
      warn.push(`${shim.label} ${h.problems.join("; ")}: ${h.hookPath} — until fixed, ${impact}. Fix: \`${FIX_HOOK}\``);
    } else current.push(h.name);
  }
  if (current.length) info.push(`${current.join(" + ")} hook(s) current (byte-identical to .githooks/, executable; repo/worktree core.hooksPath honoured, global config not read)`);

  const gd = result.guard || {};
  if (gd.error) warn.push(`PUSH GUARD: check did not run: ${gd.error}`);
  else if (gd.problem) {
    warn.push(`PUSH GUARD WITHOUT LANDING CHECK: ${gd.guardPath} ${gd.problem} (a LEXICAL check — string presence only). The shim runs the guard from the PUSHING checkout, so pushes from here skip the trailer check; bring this checkout up to ${cfg.integration_branch} before pushing from it`);
  }

  for (const t of result.trailers || []) {
    if (t.error) { warn.push(`UNTRAILERED CHECK ON ${t.label} did not run: ${t.error}`); continue; }
    if (t.skipped) { warn.push(`SKIPPED ${t.label}: ${t.skipped}`); continue; }
    const fresh = `as of last fetch, ${t.label}@${short(t.tip)}; cutover ${short(t.cutover)} from the ${t.cutoverFrom}`;
    const merges = t.unverifiableMerges || [];
    if (t.untrailered.length) {
      warn.push(`${t.untrailered.length} of ${t.judged} commit(s) past cutover ${short(t.cutover)} carry no valid landing trailer (${fresh}) — pushed around the gate:`);
      for (const u of t.untrailered) warn.push(`  UNTRAILERED ON ${t.label}: ${short(u.sha)} ${u.subject}  [${u.why}]`);
    }
    if (merges.length) {
      warn.push(`${merges.length} untrailered merge(s) past cutover ${short(t.cutover)} are not clean auto-merges (${fresh}) — their content is unaccounted for:`);
      for (const u of merges) warn.push(`  UNVERIFIABLE MERGE ON ${t.label}: ${short(u.sha)} ${u.subject}  [${u.why}]`);
    }
    if (!t.untrailered.length && !merges.length) info.push(`${t.judged} commit(s) past cutover on ${t.label} all trailered or clean auto-merges (${fresh})`);
  }

  const o = result.open || {};
  if (o.error) warn.push(`LANDED-OPEN check did not run: ${o.error}`);
  else {
    for (const b of o.landedOpen) {
      warn.push(`LANDED-OPEN: ${b} — landed per trailers on ${o.mapRef}@${short(o.mapTip)}; retire with \`${FIX_RETIRE}\` once the push is on the remote`);
    }
    for (const u of o.unmeasured) warn.push(`UNMEASURED: ${u.name} — ${u.why} (not known to be landed or unlanded)`);
    if (!o.landedOpen.length && !o.unmeasured.length) info.push(`no landed-open branches among ${o.considered} local branch(es) (judged against ${o.mapRef}@${short(o.mapTip)})`);
  }

  const lines = [warn.length ? `${H} — ${warn.filter((l) => !l.startsWith("  ")).length} WARNING(S)` : `${H} — OK`];
  for (const l of warn) lines.push(l.startsWith("  ") ? l : `- ${l}`);
  if (info.length) lines.push(`(${info.join("; ")})`);
  return lines.join("\n");
}

module.exports = { runAudit, renderAudit, judgeStamp, judgeMerge, parseAuditLog, LOG_FORMAT, SHIMS, FIX_HOOK, FIX_RETIRE };
