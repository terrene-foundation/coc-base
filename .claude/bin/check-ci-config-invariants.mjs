#!/usr/bin/env node
/**
 * check-ci-config-invariants — the CONFIGURATION half of CI cost discipline.
 *
 * `ci-cost-discipline.md` MUST-1..5 are all written TO THE OPERATOR, and all of
 * them reduce N, the open-PR count. The costs below are `strict × N` and
 * `fanout × N`, and NOTHING in that rule touches either multiplier, because both
 * live in CONFIGURATION rather than behaviour. A repo can comply with every
 * clause in that file and still be unable to merge, or burn its whole runner
 * pool on jobs that gate nothing.
 *
 * That is why this ships as a tool. Operator behaviour is a judgment over
 * session history, which is why all five existing MUSTs are Phase-1 gate-review
 * with `Scanner: none`. Configuration is a structural fact with an API.
 *
 * THREE INVARIANTS, each with its own verdict
 * ───────────────────────────────────────────
 *   (A) STALE-BASE CHURN. A protected branch MUST NOT require branches-up-to-
 *       date (`strict: true`) while more than one PR is open, unless merges are
 *       serialized. Under `strict: true` every merge invalidates every other
 *       open PR; each needs a base update, which is a new head SHA, which is a
 *       full fan-out of every PR-triggered workflow, which `cancel-in-progress`
 *       then discards mid-flight. Cost is quadratic in N, and once validation
 *       latency exceeds the merge interval a PR cannot converge at all.
 *
 *   (B) QUEUE READINESS — CONDITIONAL, and reported as such. If a merge queue
 *       is ever switched on, every REQUIRED context must still report under
 *       `merge_group` or the queue wedges every merge with no admin override.
 *       This half NEVER states that a queue is the remedy: see § MECHANISM.
 *
 *   (C) FAN-OUT vs POOL, and ENFORCEMENT VALUE. A repo's per-PR fan-out must
 *       fit its runner pool, and every runner-consuming PR job should either
 *       sit in the dependency closure of a required context or carry a stated
 *       justification. A job outside that closure gates nothing: it is pure
 *       cost, and no amount of serialization or queueing reduces it.
 *
 * § MECHANISM — THE INVARIANT IS MANDATED, THE MECHANISM IS NOT
 * ─────────────────────────────────────────────────────────────
 * Invariant (A) has three mechanisms, and this tool names all three rather than
 * pushing one, because a merge queue is NOT universally available:
 *
 *   1. DISABLE `strict` — one field, every provider, every plan, trivially
 *      reversible. This is the DEFAULT recommendation. Honest trade-off, which
 *      the report states rather than hides: two PRs that pass individually can
 *      break `main` together, and the protected branch's own post-merge CI
 *      catches that within a cycle instead of preventing it.
 *   2. CAP CONCURRENT OPEN PRs AT 1 — a CONCURRENCY ceiling, not a bundling
 *      instruction. It bounds how many PRs are open at once; it says nothing
 *      about how work is SPLIT, which stays with `ci-cost-discipline.md` MUST-2
 *      and its revert-safety boundary.
 *   3. A MERGE QUEUE — only WHERE THE PROVIDER AND PLAN OFFER ONE.
 *
 * Mechanism 3 is entitlement- and provider-gated, and mandating it would ship
 * an obligation a large share of the audience cannot satisfy:
 *
 *   · PLAN. A merge queue on a PRIVATE repo requires GitHub Enterprise Cloud.
 *     On a `team` plan the ruleset rule is rejected outright.
 *   · PROVIDER. loom is multi-VCS — `.claude/hooks/lib/vcs-provider.js` is a
 *     provider-adapter registry with an Azure DevOps adapter alongside GitHub,
 *     selected per repo. An ADO consumer has no merge queue in any plan.
 *
 * So half (B) reports readiness as CONDITIONAL, prints the plan and visibility
 * it measured, and never escalates a not-ready provider into a finding on a
 * repo where no queue exists. `merge_group:` triggers are inert until a queue
 * is actually enabled, so landing them is safe but is enabling work, not a fix.
 *
 * § SIZE BY REQUIRED-CONTEXT PROVIDERS, NOT WORKFLOW COUNT
 * ───────────────────────────────────────────────────────
 * A workflow that ignores `merge_group` simply does not run; it wedges only if
 * it provides a REQUIRED context. Both halves (B) and (C) key on that set, and
 * (C) additionally takes its DEPENDENCY CLOSURE — a feeder job listed in an
 * aggregator's `needs:` provides no context itself yet gates every merge
 * through the aggregator, so scoring it "zero enforcement value" would be
 * wrong. Measured at loom: 3 PR jobs, 1 context provider, closure 3 of 3.
 *
 * § WHAT THIS TOOL DOES NOT ANSWER (instrument-discipline.md MUST-4)
 * ─────────────────────────────────────────────────────────────────
 * A green here is NOT "the queue is safe to enable" and NOT "this CI is sound".
 * Named, so a reader cannot over-read the scope:
 *   · job-level `if:` guards widened to admit `merge_group` — NOT decidable
 *     from the file (it depends on what the aggregator's `needs:` tolerates).
 *   · a PR-shaped relevance skip made EXPLICITLY true under `merge_group`
 *     rather than reached through a fail-open branch — a SEMANTIC property.
 *   · org RULESETS as a source of required contexts — only the classic
 *     `branches/<base>/protection` surface is read here. A repo whose contexts
 *     live in a ruleset reads as `unmeasurable`, which is fail-closed.
 *   · matrix expansion — a `strategy.matrix` job counts as ONE job here, so
 *     the fan-out figure in (C) is a LOWER BOUND, never an over-estimate.
 *
 * § SCOPE CAVEAT ON ANY THRESHOLD — carried verbatim from the source finding
 * ─────────────────────────────────────────────────────────────────────────
 * The fan-out figures that motivated invariant (C) are from ONE BUILD repo (one
 * PR fanning out to 16 runs / 33 runner-consuming jobs against an org pool of
 * 24, of which only 12 provide a required context and 11 are heavy Rust jobs
 * running at full cost with zero enforcement value). THE MECHANISM
 * GENERALISES; THE NUMBERS DO NOT. Consumers MUST measure their own fan-out
 * against their own pool before adopting any threshold — which is what this
 * tool does, rather than shipping a constant.
 *
 * § FALSIFYING RESULTS, named before any result here is cited as evidence
 * ──────────────────────────────────────────────────────────────────────
 *   · (A) On a repo with `strict: true`, N>1 and no serialization, this prints
 *     `finding/stale-base-churn` and exits 1; with `strict: false` it prints
 *     `clear/not-strict`. Both are reachable, so either is readable as evidence.
 *   · (B) A provider with no `merge_group:` arm prints `not-ready/no-merge-group`;
 *     with a filtered arm, `not-ready/filtered-merge-group`; with a
 *     cancel-in-progress that cannot be shown PR-scoped,
 *     `unresolved/cancel-expression-undecidable`. All differ from `ready`.
 *   · (C) A fan-out exceeding the online pool prints
 *     `finding/fanout-exceeds-pool`; a job outside the closure with no
 *     justification prints `finding/unenforcing-jobs`.
 *   · UNREADABLE INPUTS NEVER READ AS CLEAR. Every one is its own verdict and
 *     exits non-zero. An instrument printing "clear" when it measured nothing
 *     would be the fail-open class this tool exists to close.
 *
 * § KEY CHECKS, NOT OBJECT CONSTRUCTION
 * ─────────────────────────────────────
 * GitHub OMITS `required_status_checks` when nothing is required, and can
 * return it with a null member. `p.required_status_checks?.strict` collapses
 * ABSENT, PRESENT-AND-NULL and PRESENT-AND-FALSE into one falsy value, so every
 * read goes through `hasKey()` first AND every non-boolean value is reported
 * UNREADABLE rather than folded onto the non-finding side.
 *
 * USAGE
 *   node .claude/bin/check-ci-config-invariants.mjs
 *   node .claude/bin/check-ci-config-invariants.mjs --repo owner/name --base main
 *   node .claude/bin/check-ci-config-invariants.mjs --json
 *
 * EXIT CODES  0 = no finding. 1 = a finding. 2 = bad arguments. A crash is never
 * silently 1: every argument path is validated before any work begins.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./lib/entry-point.mjs";

const WORKFLOW_DIR = ".github/workflows";

/** A job block may opt out of invariant (C) by naming why it gates nothing. */
const JUSTIFICATION_MARKER = "ci-enforcement-justification:";

// ── pure core: protection ───────────────────────────────────────────────────

/** Own-property presence. `p[k] !== undefined` cannot tell ABSENT from PRESENT-AND-NULL. */
function hasKey(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Read `strict` + the required-context list out of a branch-protection payload.
 *
 * Both fields carry their own readability flag. A non-boolean `strict` is
 * UNREADABLE, not `false`: folding it onto the non-finding side would make the
 * tool most confident exactly where the payload was strangest. Likewise
 * `contextsReadable` — an ABSENT `contexts` and an EMPTY one are different
 * answers, and only one of them licenses "nothing can wedge a queue here".
 */
function readProtection(protection) {
  const none = { readable: false, strict: null, contexts: [], contextsReadable: false };
  if (!hasKey(protection, "required_status_checks")) {
    return { ...none, reason: "no required_status_checks key" };
  }
  const rsc = protection.required_status_checks;
  if (!hasKey(rsc, "strict")) {
    return { ...none, reason: "required_status_checks carries no strict key" };
  }
  if (typeof rsc.strict !== "boolean") {
    return { ...none, reason: `required_status_checks.strict is ${JSON.stringify(rsc.strict)}, not a boolean` };
  }
  // Union of the two surfaces GitHub offers on this endpoint. `checks[]` is the
  // newer shape and carries an app_id; `contexts` is the legacy mirror. Reading
  // only one would under-report on a repo that carries the other.
  const names = new Set();
  let contextsReadable = false;
  if (hasKey(rsc, "contexts") && Array.isArray(rsc.contexts)) {
    contextsReadable = true;
    for (const c of rsc.contexts) if (typeof c === "string") names.add(c);
  }
  if (hasKey(rsc, "checks") && Array.isArray(rsc.checks)) {
    contextsReadable = true;
    for (const c of rsc.checks) if (c && typeof c.context === "string") names.add(c.context);
  }
  return { readable: true, strict: rsc.strict, contexts: [...names], contextsReadable, reason: null };
}

/**
 * Invariant (A), as a pure function of three measured facts.
 *
 * `queueEnabled` is a TRISTATE: true / false / null-for-unread. null must not
 * read as "no queue" — that would turn an unmeasured input into a finding.
 */
function classifyStaleBaseChurn({ protection, queueEnabled, openPrCount }) {
  const prot = readProtection(protection);
  if (!prot.readable) {
    return {
      verdict: "unmeasurable",
      finding: true,
      detail: `branch protection did not yield a usable strict flag (${prot.reason}). Nothing here is evidence either way.`,
    };
  }
  if (prot.strict !== true) {
    return {
      verdict: "clear/not-strict",
      finding: false,
      detail: "strict is false, so the multiplier is 1: a merge does not invalidate other open PRs.",
    };
  }
  if (queueEnabled === null || queueEnabled === undefined) {
    return {
      verdict: "unmeasurable",
      finding: true,
      detail: "strict is true but the serialization mechanism could not be read. Fail-closed: this is not a clear.",
    };
  }
  if (queueEnabled === true) {
    return {
      verdict: "clear/queue-serializes",
      finding: false,
      detail: "strict is true and a merge queue serializes merges: candidates are tested against a settled base.",
    };
  }
  if (typeof openPrCount !== "number" || !Number.isInteger(openPrCount) || openPrCount < 0) {
    return {
      verdict: "finding/unknown-n",
      finding: true,
      detail: "strict is true with no serialization, and the open-PR count could not be read. Fail-closed.",
    };
  }
  if (openPrCount <= 1) {
    return {
      verdict: "clear/serialized",
      finding: false,
      detail: `strict is true, but ${openPrCount} PR(s) are open: merges are serialized by concurrency, so the invariant holds.`,
    };
  }
  return {
    verdict: "finding/stale-base-churn",
    finding: true,
    detail:
      `strict is true with ${openPrCount} PRs open and no serialization. Every merge invalidates the other ` +
      `${openPrCount - 1}; each base update buys a full fan-out that cancel-in-progress discards. ` +
      "REMEDIES, in the order they should be considered: (1) DISABLE strict — one field, every provider, " +
      "every plan, trivially reversible; the trade-off is that two PRs passing individually can break the " +
      "base together, which the base's own post-merge CI catches within a cycle instead of preventing. " +
      "(2) Hold concurrent open PRs at 1 — a concurrency ceiling, not an instruction to bundle work. " +
      "(3) A merge queue, ONLY where the provider and plan offer one.",
  };
}

// ── pure core: workflow parsing ─────────────────────────────────────────────

/**
 * Parse the top-level `on:` mapping out of a workflow's raw text.
 *
 * A SCOPED text parse, not a YAML parser: this repo carries no YAML dependency.
 * The scope is made honest by the return shape — `parsed: false` whenever the
 * block cannot be read as a block mapping, which callers MUST NOT read as "no
 * merge_group arm". Every shape that would otherwise yield a confidently wrong
 * answer routes there: an inline sequence (`on: [push]`), a flow mapping
 * (`on: {push: null}`), and a block whose arms are not at the depth this parser
 * establishes from the first arm it sees.
 *
 * Indentation is LEARNED from the first arm rather than fixed at two spaces, so
 * 3-space and 4-space files parse correctly instead of reporting zero arms.
 */
function parseOnArms(text) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^on:\s*(#.*)?$/.test(lines[i])) {
      start = i;
      break;
    }
    // Any inline form — sequence or flow mapping — carries arms this parser
    // cannot enumerate. UNPARSED, never "no arms".
    if (/^on:\s*\S/.test(lines[i])) return { parsed: false, arms: [], reason: "inline `on:` form" };
  }
  if (start === -1) return { parsed: false, arms: [], reason: "no top-level `on:` block" };

  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // back to column 0 → the block ended
    body.push({ line, n: i + 1 });
  }
  if (body.length === 0) return { parsed: true, arms: [] };

  const indentOf = (s) => /^[ \t]*/.exec(s)[0].length;
  const armIndent = indentOf(body[0].line);
  const arms = [];
  let current = null;
  for (const { line, n } of body) {
    const ind = indentOf(line);
    const key = /^[ \t]*([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (ind === armIndent) {
      if (!key) return { parsed: false, arms: [], reason: "a line at arm depth is not a mapping key" };
      current = { name: key[1], line: n, subKeys: [] };
      arms.push(current);
      // An inline value on the arm line IS a filter (`merge_group: {branches: […]}`).
      const inlineValue = key[2].replace(/#.*$/, "").trim();
      if (inlineValue !== "" && inlineValue !== "null" && inlineValue !== "~") {
        current.subKeys.push("<inline>");
      }
      continue;
    }
    if (ind > armIndent) {
      if (current) current.subKeys.push(key ? key[1] : "<item>");
      continue;
    }
    // Dedent below the established arm depth inside the block: not a shape this
    // parser models. Refuse rather than guess.
    return { parsed: false, arms: [], reason: "inconsistent indentation inside the `on:` block" };
  }
  if (arms.length === 0) return { parsed: false, arms: [], reason: "block located but no arms parsed" };
  return { parsed: true, arms };
}

/**
 * Does any JOB in this workflow declare `name:` equal to `context`?
 *
 * Bounded three ways, because a bare `name:` match is not a job declaration and
 * a false provider SUPPRESSES the correct `unresolved/provider-not-found`:
 *   · the search starts after a column-0 `jobs:` key;
 *   · indentation is `[ \t]` only — `\s` includes `\n`, which let `^\s{2,}` eat
 *     blank lines and match a workflow-level `name:` at column 0;
 *   · depth is capped, so a STEP name, a `with:` input, or a `matrix` entry —
 *     all nested deeper than a job key — cannot match.
 *
 * A templated job name (`${{ … }}`) will not match, which is why an unmatched
 * context is UNRESOLVED rather than "no provider": "I did not find it" and "it
 * is not there" are different answers and only one of them is a clear.
 */
const MAX_JOB_KEY_INDENT = 6;

function declaresJobName(text, context) {
  const src = String(text);
  const jobs = /^jobs:\s*(#.*)?$/m.exec(src);
  if (!jobs) return false;
  const region = src.slice(jobs.index + jobs[0].length);
  const esc = context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]{2,${MAX_JOB_KEY_INDENT}}name:[ \\t]*(["']?)${esc}\\1[ \\t]*(#.*)?$`, "m");
  return re.test(region);
}

/**
 * Grade EVERY `cancel-in-progress:` expression in the file.
 *
 * Two corrections to the obvious form, both from adversarial review:
 *
 *   (1) POSITIVE, NOT NEGATIVE. Testing "does the expression contain the token
 *       `merge_group`" is sound about the TOKEN and unsound about the PROPERTY.
 *       `cancel-in-progress: true` cancels every run — including queued ones,
 *       each cancellation reporting as a FAILED required check — while
 *       containing no such token. So `safe` requires the expression be
 *       DEMONSTRABLY PR-scoped; everything else is UNDECIDABLE, not safe.
 *   (2) ALL OCCURRENCES, NOT THE FIRST. Actions supports job-level
 *       `concurrency:`, and the required-context provider job is exactly where
 *       a per-job cancel would live. One safe top-level expression must not
 *       mask an unsafe job-level one, so the union is graded and the worst
 *       outcome wins.
 */
function gradeCancelInProgress(text) {
  const exprs = [...String(text).matchAll(/^[ \t]*cancel-in-progress:[ \t]*(.+?)[ \t]*$/gm)].map((m) =>
    m[1].replace(/#.*$/, "").trim(),
  );
  if (exprs.length === 0) return { present: false, status: "absent", exprs: [] };
  let status = "pr-scoped";
  for (const expr of exprs) {
    if (/merge_group/.test(expr)) return { present: true, status: "admits", exprs, offender: expr };
    // The one shape that is demonstrably PR-scoped: an expression comparing
    // `github.event_name` to the literal 'pull_request' and nothing else.
    const prScoped = /github\.event_name\s*==\s*'pull_request'/.test(expr) && !/\|\||!=/.test(expr);
    if (!prScoped) return { present: true, status: "undecidable", exprs, offender: expr };
  }
  return { present: true, status: "pr-scoped", exprs };
}

/**
 * Enumerate jobs: id, declared name, `needs:`, whether it consumes a runner,
 * whether its `if:` can admit a `pull_request`, and whether its block carries a
 * justification marker.
 *
 * Same learned-indent discipline as `parseOnArms`. `parsed: false` on any shape
 * this cannot read, so a caller never mistakes an unread file for an empty one.
 */
function parseJobs(text) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*(#.*)?$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return { parsed: false, jobs: [], reason: "no top-level `jobs:` block" };

  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    body.push({ line, n: i + 1, comment: /^\s*#/.test(line) });
  }
  const content = body.filter((b) => !b.comment);
  if (content.length === 0) return { parsed: false, jobs: [], reason: "`jobs:` block is empty" };

  const indentOf = (s) => /^[ \t]*/.exec(s)[0].length;
  const jobIndent = indentOf(content[0].line);
  // The job-KEY depth is LEARNED from the first key seen inside the first job,
  // not computed from `jobIndent`. A file indented 2, 3 or 4 spaces all parse;
  // guessing (`jobIndent * 2`) would silently read the wrong level on any file
  // whose nesting step differs from its top-level indent.
  let keyIndent = null;
  const jobs = [];
  let current = null;
  for (const { line, n, comment } of body) {
    const ind = indentOf(line);
    if (comment) {
      if (current && line.includes(JUSTIFICATION_MARKER)) current.justified = true;
      continue;
    }
    if (ind === jobIndent) {
      const key = /^[ \t]*([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
      if (!key) return { parsed: false, jobs: [], reason: "a line at job depth is not a mapping key" };
      current = { id: key[1], line: n, name: null, needs: [], runnerConsuming: false, ifExpr: null, justified: false };
      jobs.push(current);
      continue;
    }
    if (!current) continue;
    if (line.includes(JUSTIFICATION_MARKER)) current.justified = true;
    const key = /^[ \t]+([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!key) continue;
    if (keyIndent === null && ind > jobIndent) keyIndent = ind;
    // Only keys at the job's OWN mapping depth are job keys; anything deeper
    // belongs to `steps:`, `strategy:`, `with:` and must not be read here — a
    // step's `name:` read as a job's is exactly how a false provider arises.
    if (ind !== keyIndent) continue;
    const value = key[2].replace(/#.*$/, "").trim();
    if (key[1] === "name" && current.name === null) current.name = value.replace(/^["']|["']$/g, "");
    else if (key[1] === "runs-on") current.runnerConsuming = true;
    else if (key[1] === "uses") current.runnerConsuming = true; // a reusable-workflow call fans out too
    else if (key[1] === "if" && current.ifExpr === null) current.ifExpr = value;
    else if (key[1] === "needs") {
      const inline = value.replace(/^\[|\]$/g, "");
      for (const part of inline.split(",")) {
        const t = part.trim().replace(/^["']|["']$/g, "");
        if (t) current.needs.push(t);
      }
    }
  }
  if (jobs.length === 0) return { parsed: false, jobs: [], reason: "no jobs parsed" };
  return { parsed: true, jobs };
}

/**
 * Does this job run on a `pull_request`? Absent `if:` means yes (the workflow's
 * `on:` already decided); an `if:` that names `pull_request` means yes; an `if:`
 * that names other event(s) and NOT `pull_request` means no. Anything else is
 * treated as YES, which over-counts the fan-out rather than under-counting it —
 * the conservative direction for a cost figure.
 */
function jobRunsOnPullRequest(job) {
  if (!job.ifExpr) return true;
  if (/pull_request/.test(job.ifExpr)) return true;
  if (/github\.event_name\s*==/.test(job.ifExpr)) return false;
  return true;
}

/**
 * Invariant (C). Fan-out, pool fit, and the required-context DEPENDENCY CLOSURE.
 *
 * `workflows` is `[{ path, text, prTriggered }]`; `poolOnline` is a number or
 * null for unread.
 */
function classifyFanout({ contexts, workflows, poolOnline }) {
  const contextSet = new Set(contexts);
  const prJobs = [];
  const unparsed = [];
  for (const w of workflows) {
    if (!w.prTriggered) continue;
    const parsed = parseJobs(w.text);
    if (!parsed.parsed) {
      unparsed.push({ path: w.path, reason: parsed.reason });
      continue;
    }
    for (const job of parsed.jobs) {
      if (!job.runnerConsuming) continue;
      if (!jobRunsOnPullRequest(job)) continue;
      prJobs.push({ ...job, workflow: w.path });
    }
  }

  // Closure: a job PROVIDES a required context, or is reachable through the
  // `needs:` graph FROM one that does. A feeder job gates every merge through
  // its aggregator, so scoring it "zero enforcement value" would be wrong.
  const byId = new Map(prJobs.map((j) => [`${j.workflow}#${j.id}`, j]));
  const inClosure = new Set();
  const queue = [];
  for (const j of prJobs) {
    if (j.name !== null && contextSet.has(j.name)) {
      const k = `${j.workflow}#${j.id}`;
      inClosure.add(k);
      queue.push(j);
    }
  }
  while (queue.length) {
    const j = queue.pop();
    for (const dep of j.needs) {
      const k = `${j.workflow}#${dep}`;
      if (inClosure.has(k)) continue;
      const target = byId.get(k);
      if (!target) continue;
      inClosure.add(k);
      queue.push(target);
    }
  }

  const outside = prJobs
    .filter((j) => !inClosure.has(`${j.workflow}#${j.id}`) && !j.justified)
    .map((j) => ({ workflow: j.workflow, id: j.id, name: j.name }));

  const rows = [];
  if (unparsed.length) {
    for (const u of unparsed) {
      rows.push({
        verdict: "unmeasurable/jobs-unparsed",
        finding: true,
        detail: `${u.path}: ${u.reason}. The fan-out figure below EXCLUDES this file, so it is not a total.`,
      });
    }
  }
  if (contextSet.size === 0) {
    rows.push({
      verdict: "unmeasurable/no-required-contexts",
      finding: true,
      detail:
        "no required context was read, so the dependency closure is empty and EVERY job would score outside it. " +
        "Reported as unmeasurable rather than as a fan-out finding.",
    });
  } else if (outside.length > 0) {
    rows.push({
      verdict: "finding/unenforcing-jobs",
      finding: true,
      detail:
        `${outside.length} of ${prJobs.length} runner-consuming PR job(s) sit outside the required-context ` +
        `dependency closure and carry no \`${JUSTIFICATION_MARKER}\` marker: ` +
        `${outside.map((o) => `${o.workflow}#${o.id}`).join(", ")}. These gate nothing — they are cost with ` +
        "no enforcement value, and no amount of serialization or queueing reduces it.",
    });
  } else {
    rows.push({
      verdict: "clear/all-jobs-enforce",
      finding: false,
      detail: `all ${prJobs.length} runner-consuming PR job(s) are in the required-context dependency closure or justified.`,
    });
  }

  if (poolOnline === null || poolOnline === undefined) {
    rows.push({
      verdict: "unmeasurable/pool-unread",
      finding: true,
      detail: "the runner pool size could not be read, so fan-out cannot be compared against it. Fail-closed.",
    });
  } else if (prJobs.length > poolOnline) {
    rows.push({
      verdict: "finding/fanout-exceeds-pool",
      finding: true,
      detail:
        `one PR fans out to ${prJobs.length} runner-consuming job(s) against ${poolOnline} online runner(s). ` +
        "A single PR cannot validate without saturating the pool, and two concurrently is structurally " +
        "impossible. A merge queue does NOT fix this: it serializes CANDIDATES and leaves the per-PR fan-out " +
        "unchanged. This is a LOWER BOUND — a matrix job counts once here.",
    });
  } else {
    rows.push({
      verdict: "clear/fanout-fits-pool",
      finding: false,
      detail: `one PR fans out to ${prJobs.length} runner-consuming job(s) against ${poolOnline} online runner(s) (lower bound; a matrix job counts once).`,
    });
  }
  return { rows, prJobCount: prJobs.length, closureCount: inClosure.size, outside };
}

/**
 * Invariant (B). Grade each required context's provider — CONDITIONAL, and it
 * never escalates on a repo where no queue exists.
 */
function classifyQueueReadiness({ contexts, contextsReadable, workflows }) {
  if (!contextsReadable) {
    return [
      {
        context: null,
        provider: null,
        verdict: "unmeasurable/contexts-unread",
        finding: true,
        detail:
          "the required-context list was never read, so no claim is made about what would report under a " +
          "queue. This is NOT `no contexts` — an absent field and an empty one are different answers.",
      },
    ];
  }
  const rows = [];
  for (const context of contexts) {
    const providers = workflows.filter((w) => declaresJobName(w.text, context));
    if (providers.length === 0) {
      rows.push({
        context,
        provider: null,
        verdict: "unresolved/provider-not-found",
        finding: true,
        detail:
          "no workflow in this tree declares a JOB with this exact name. It may come from a non-Actions app, " +
          "or from a job whose name is templated. UNRESOLVED, not absent.",
      });
      continue;
    }
    for (const p of providers) {
      const on = parseOnArms(p.text);
      if (!on.parsed) {
        rows.push({
          context,
          provider: p.path,
          verdict: "unresolved/on-block-unparsed",
          finding: true,
          detail: `the \`on:\` block could not be read as a block mapping (${on.reason}), so no claim is made about its arms.`,
        });
        continue;
      }
      const mg = on.arms.find((a) => a.name === "merge_group");
      if (!mg) {
        rows.push({
          context,
          provider: p.path,
          verdict: "not-ready/no-merge-group",
          finding: true,
          detail:
            "this workflow provides a REQUIRED context and carries no `merge_group:` arm, so it would not " +
            "instantiate on a queued candidate: the context would never report and every merge would hang.",
        });
        continue;
      }
      if (mg.subKeys.length > 0) {
        rows.push({
          context,
          provider: p.path,
          verdict: "not-ready/filtered-merge-group",
          finding: true,
          detail:
            `the \`merge_group:\` arm carries filter key(s) [${mg.subKeys.join(", ")}]. Any subtracting key ` +
            "excludes some candidate from reporting and re-introduces the hang.",
        });
        continue;
      }
      const cip = gradeCancelInProgress(p.text);
      if (cip.status === "admits") {
        rows.push({
          context,
          provider: p.path,
          verdict: "not-ready/cancels-queued-runs",
          finding: true,
          detail:
            `a cancel-in-progress expression admits merge_group (\`${cip.offender}\`). A cancelled queued run ` +
            "reports as a FAILED required check, so this ejects PRs from the queue rather than saving time.",
        });
        continue;
      }
      if (cip.status === "undecidable") {
        rows.push({
          context,
          provider: p.path,
          verdict: "unresolved/cancel-expression-undecidable",
          finding: true,
          detail:
            `a cancel-in-progress expression (\`${cip.offender}\`) cannot be shown PR-scoped. A bare \`true\` ` +
            "cancels queued runs while containing no `merge_group` token, so silence here is not safety.",
        });
        continue;
      }
      rows.push({
        context,
        provider: p.path,
        verdict: "ready",
        finding: false,
        detail:
          cip.status === "absent"
            ? "unfiltered `merge_group:` arm present; no cancel-in-progress in this workflow."
            : "unfiltered `merge_group:` arm present; every cancel-in-progress expression is demonstrably PR-scoped.",
      });
    }
  }
  return rows;
}

// ── gh plumbing ─────────────────────────────────────────────────────────────

/**
 * Whitelist-validate before either string reaches an API path or a GraphQL body
 * (security.md § Input Validation).
 *
 * `execFileSync` spawns no shell, which is the reason this looks safe and is the
 * wrong boundary: `slug` lands in a REST PATH where a `../` segment redirects
 * the request, and `owner`/`name`/`base` land in a GraphQL query STRING where a
 * quote closes the argument. Both cross `execFileSync` faithfully.
 *
 * The trailing-anchor case is pinned by the suite deliberately: JS `$` without
 * `m` matches only at end of input, so `"owner/repo\n../x"` is rejected — but
 * that is a JS-specific anchor semantic, and a port of this validator to a
 * language whose `$` matches before a trailing newline would be a live
 * traversal. The test names it so the port cannot silently lose it.
 */
const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._\/-]+$/;

function validateTargets(slug, base) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return `invalid --repo ${JSON.stringify(slug)}: expected owner/name using [A-Za-z0-9._-] only`;
  }
  if (typeof base !== "string" || !REF_RE.test(base)) {
    return `invalid --base ${JSON.stringify(base)}: expected a ref name using [A-Za-z0-9._/-] only`;
  }
  if (slug.includes("..")) return `invalid --repo ${JSON.stringify(slug)}: path traversal segment`;
  if (base.includes("..")) return `invalid --base ${JSON.stringify(base)}: path traversal segment`;
  return null;
}

/**
 * Terminal output carries remote-controlled strings: a required-context name is
 * chosen by whoever registered the check, and workflow text is attacker-authored
 * whenever `--root` points at a fork checkout. An ANSI/CSI escape in either can
 * overwrite the FINDINGS line, so C0 (bar newline and tab) and DEL are replaced
 * before any human-report write. `--json` needs none of this: JSON.stringify
 * escapes C0 by construction.
 */
function stripControl(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const printable = ch === "\n" || ch === "\t" || (c >= 0x20 && c !== 0x7f);
    out += printable ? ch : "?";
  }
  return out;
}

function gh(args, cwd) {
  try {
    return {
      ok: true,
      out: execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (err) {
    return { ok: false, err: ((err.stderr || err.message) + "").trim() };
  }
}

function ghJson(args, cwd) {
  const r = gh(args, cwd);
  if (!r.ok) return r;
  try {
    return { ok: true, out: JSON.parse(r.out) };
  } catch (err) {
    return { ok: false, err: `unparseable JSON from gh ${args.join(" ")}: ${err.message}` };
  }
}

function fetchProtection(slug, base, cwd) {
  const r = ghJson(["api", `repos/${slug}/branches/${base}/protection`], cwd);
  return r.ok ? r.out : null;
}

/**
 * Merge-queue state as a TRISTATE. GraphQL is the only surface that answers it.
 * `null` on any error, never `false` — an unread answer is not a negative one.
 *
 * UNKNOWN, stated rather than assumed: this was measured live only at its
 * NULL pole (a repo with no queue). The non-null pole cannot be produced
 * without enabling a queue, which needs an entitlement this org does not have,
 * so "non-null exactly when a queue is enabled for that branch" is documented
 * GitHub behaviour here and NOT a local measurement.
 */
function fetchQueueEnabled(slug, base, cwd) {
  const [owner, name] = slug.split("/");
  if (!owner || !name) return null;
  const q = `query{repository(owner:"${owner}",name:"${name}"){mergeQueue(branch:"${base}"){id}}}`;
  const r = ghJson(["api", "graphql", "-f", `query=${q}`], cwd);
  if (!r.ok) return null;
  const repo = r.out && r.out.data ? r.out.data.repository : null;
  if (!hasKey(repo || {}, "mergeQueue")) return null;
  return repo.mergeQueue !== null;
}

function fetchOpenPrCount(slug, cwd) {
  const r = ghJson(["pr", "list", "--repo", slug, "--state", "open", "--limit", "500", "--json", "number"], cwd);
  if (!r.ok || !Array.isArray(r.out)) return null;
  return r.out.length;
}

/** Plan + visibility — the two facts that decide whether a merge queue is even available. */
function fetchAvailability(slug, cwd) {
  const owner = slug.split("/")[0];
  const repo = ghJson(["api", `repos/${slug}`], cwd);
  const org = ghJson(["api", `orgs/${owner}`], cwd);
  const visibility = repo.ok && repo.out && typeof repo.out.visibility === "string" ? repo.out.visibility : null;
  const plan = org.ok && org.out && org.out.plan && typeof org.out.plan.name === "string" ? org.out.plan.name : null;
  return { plan, visibility };
}

function fetchPoolOnline(slug, cwd) {
  const owner = slug.split("/")[0];
  const r = ghJson(["api", `orgs/${owner}/actions/runners`, "--paginate"], cwd);
  if (!r.ok || !r.out || !Array.isArray(r.out.runners)) return null;
  return r.out.runners.filter((x) => x && x.status === "online").length;
}

function readWorkflows(root) {
  const dir = join(root, WORKFLOW_DIR);
  let names;
  try {
    names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  } catch {
    return null;
  }
  return names.map((n) => {
    const text = readFileSync(join(dir, n), "utf8");
    const on = parseOnArms(text);
    return {
      path: `${WORKFLOW_DIR}/${n}`,
      text,
      // Unparsed `on:` counts as PR-triggered: over-counting the fan-out is the
      // conservative direction for a cost figure.
      prTriggered: !on.parsed || on.arms.some((a) => a.name === "pull_request"),
    };
  });
}

function detectSlug(cwd) {
  const r = ghJson(["repo", "view", "--json", "nameWithOwner"], cwd);
  if (!r.ok || !r.out || typeof r.out.nameWithOwner !== "string") return null;
  return r.out.nameWithOwner;
}

// ── entry point ─────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(["--repo", "--base", "--root"]);

function parseArgs(argv) {
  const opts = { repo: null, base: "main", json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(a)) return { error: `unknown argument: ${a}` };
    const v = argv[i + 1];
    // A missing value must be exit 2, not a crash and not a silent fallback to
    // the auto-detected repo under the flag the operator typed.
    if (v === undefined || VALUE_FLAGS.has(v) || v === "--json") return { error: `${a} requires a value` };
    if (a === "--repo") opts.repo = v;
    else if (a === "--base") opts.base = v;
    else opts.root = v;
    i++;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    process.stderr.write(`${opts.error}\n`);
    process.exit(2);
  }

  const detected = detectSlug(opts.root);
  const slug = opts.repo || detected;
  if (!slug) {
    process.stderr.write("could not determine the repo slug; pass --repo owner/name\n");
    process.exit(1);
  }
  const invalid = validateTargets(slug, opts.base);
  if (invalid) {
    process.stderr.write(`${invalid}\n`);
    process.exit(2);
  }
  // Halves (B) and (C) read LOCAL files while half (A) reads a REMOTE repo. If
  // those are not the same subject, one header would sit over two repos —
  // exactly the one-instrument-two-questions shape instrument-discipline.md
  // MUST-4 forbids. Refuse rather than print a mixed report.
  const subjectsAgree = detected === null ? false : detected === slug;

  const protection = fetchProtection(slug, opts.base, opts.root);
  const queueEnabled = fetchQueueEnabled(slug, opts.base, opts.root);
  const openPrCount = fetchOpenPrCount(slug, opts.root);
  const availability = fetchAvailability(slug, opts.root);
  const poolOnline = fetchPoolOnline(slug, opts.root);
  const workflows = readWorkflows(opts.root);

  const churn = classifyStaleBaseChurn({ protection, queueEnabled, openPrCount });
  const prot = readProtection(protection || {});

  let readiness = null;
  let fanout = null;
  const localFindings = [];
  if (!subjectsAgree) {
    localFindings.push(
      `local halves SKIPPED: --repo is ${slug} but this tree resolves to ${detected === null ? "no repo" : detected}. ` +
        "Grading local workflow files against a different repo's settings would put one header over two subjects.",
    );
  } else if (workflows === null) {
    localFindings.push(`local halves SKIPPED: no ${WORKFLOW_DIR} directory under ${opts.root}.`);
  } else {
    readiness = classifyQueueReadiness({
      contexts: prot.contexts,
      contextsReadable: prot.contextsReadable,
      workflows,
    });
    fanout = classifyFanout({ contexts: prot.contexts, workflows, poolOnline });
  }

  // (B) is CONDITIONAL. It escalates only where a queue actually bears on the
  // repo: one is already enabled (a live wedge), or strict is on with none (the
  // remedy set includes one). Where no queue exists and none is implicated, an
  // unready provider is a fact worth printing, not a violation — mandating a
  // mechanism the audience may not be entitled to is the defect this avoids.
  const readinessBinds = queueEnabled === true || (prot.strict === true && queueEnabled === false);
  const readinessFindings = readinessBinds ? (readiness || []).filter((r) => r.finding).length : 0;
  const fanoutFindings = (fanout ? fanout.rows : []).filter((r) => r.finding).length;
  const findings = (churn.finding ? 1 : 0) + readinessFindings + fanoutFindings + localFindings.length;

  const report = {
    repo: slug,
    base: opts.base,
    measured_at: new Date().toISOString(),
    strict: prot.readable ? prot.strict : null,
    merge_queue_enabled: queueEnabled,
    open_pr_count: openPrCount,
    required_contexts: prot.contextsReadable ? prot.contexts : null,
    plan: availability.plan,
    visibility: availability.visibility,
    runner_pool_online: poolOnline,
    stale_base_churn: churn,
    queue_readiness: readiness,
    queue_readiness_binds: readinessBinds,
    fanout,
    local_findings: localFindings,
    not_checked: [
      "job-level `if:` widening to admit merge_group — not decidable from the file",
      "relevance skips made explicitly true under merge_group — a semantic property",
      "org RULESETS as a source of required contexts — only classic protection is read",
      "matrix expansion — a matrix job counts once, so the fan-out figure is a LOWER BOUND",
      "merge-queue ENTITLEMENT — plan and visibility are reported, not probed",
    ],
    findings,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(findings > 0 ? 1 : 0);
  }

  const out = [];
  out.push(`check-ci-config-invariants — ${slug} @ ${opts.base}`);
  out.push("");
  out.push(`  strict                 ${prot.readable ? prot.strict : "UNREADABLE"}`);
  out.push(`  merge queue enabled    ${queueEnabled === null ? "UNREADABLE" : queueEnabled}`);
  out.push(`  open PRs               ${openPrCount === null ? "UNREADABLE" : openPrCount}`);
  out.push(`  required contexts      ${prot.contextsReadable ? (prot.contexts.join(", ") || "(none)") : "UNREADABLE"}`);
  out.push(`  plan / visibility      ${availability.plan || "UNREADABLE"} / ${availability.visibility || "UNREADABLE"}`);
  out.push(`  runners online         ${poolOnline === null ? "UNREADABLE" : poolOnline}`);
  out.push("");
  out.push(`  (A) STALE-BASE CHURN   ${churn.verdict}`);
  out.push(`      ${churn.detail}`);
  out.push("");
  if (readiness === null) {
    out.push("  (B) QUEUE READINESS    not evaluated");
  } else {
    out.push(
      `  (B) QUEUE READINESS    ${readinessBinds ? "BINDING (a queue is enabled or implicated)" : "CONDITIONAL — no queue exists or is implicated; informational only"}`,
    );
    for (const r of readiness) {
      out.push(`      ${r.verdict}  ${r.context || ""}  ←  ${r.provider || "(no provider found)"}`);
      out.push(`        ${r.detail}`);
    }
    if (!readinessBinds) {
      out.push(
        "      NOTE: a merge queue on a PRIVATE repo requires GitHub Enterprise Cloud, and providers other " +
          "than GitHub (e.g. Azure DevOps) have no equivalent. `merge_group:` triggers are INERT until a " +
          "queue exists, so landing them is safe enabling work — never the remedy.",
      );
    }
  }
  out.push("");
  if (fanout === null) {
    out.push("  (C) FAN-OUT / VALUE    not evaluated");
  } else {
    out.push(`  (C) FAN-OUT / VALUE    ${fanout.prJobCount} runner-consuming PR job(s), ${fanout.closureCount} in the required-context closure`);
    for (const r of fanout.rows) {
      out.push(`      ${r.verdict}`);
      out.push(`        ${r.detail}`);
    }
  }
  for (const f of localFindings) {
    out.push("");
    out.push(`  !! ${f}`);
  }
  out.push("");
  out.push("  NOT CHECKED by this tool:");
  for (const n of report.not_checked) out.push(`    · ${n}`);
  out.push("");
  out.push(
    "  SCOPE CAVEAT: any fan-out THRESHOLD is repo-specific. The finding that motivated invariant (C) came " +
      "from ONE BUILD repo. The mechanism generalises; the numbers do not — which is why this tool measures " +
      "your pool rather than shipping a constant.",
  );
  out.push("");
  out.push(
    findings > 0
      ? `FINDINGS: ${findings}. A green would have read differently — see the verdict strings above.`
      : "NO FINDING. This is not a claim that the CI is sound; see NOT CHECKED.",
  );
  process.stdout.write(`${stripControl(out.join("\n"))}\n`);
  process.exit(findings > 0 ? 1 : 0);
}

export {
  hasKey,
  validateTargets,
  stripControl,
  readProtection,
  classifyStaleBaseChurn,
  parseOnArms,
  parseJobs,
  jobRunsOnPullRequest,
  declaresJobName,
  gradeCancelInProgress,
  classifyQueueReadiness,
  classifyFanout,
  parseArgs,
  JUSTIFICATION_MARKER,
};

const isMain = isMainModule(import.meta.url);
if (isMain) main();
