#!/usr/bin/env node
/**
 * CI JOB BUDGET AUDIT — the generic engine (loom#1877).
 *
 * Censuses every job reachable from a `pull_request` trigger in this repo's
 * `.github/workflows/`, resolves each onto a declared runner pool, and holds the
 * fan-out to declared capacity. Every job must be REQUIRED (it provides a
 * branch-protection required context), GATED (a per-job relevance skip, or a
 * paths:-filtered workflow providing no required context), or BUDGETED (declared
 * with a reviewed rationale). Anything else is unbudgeted and the audit fails.
 *
 * ZERO DEPLOYMENT VALUES LIVE HERE. No runner label, no capacity number, no host
 * identifier, no workflow filename appears in this file. Every such value is read
 * from a deployment declaration (`.claude/bin/ci-job-budget.local.json`, schema at
 * `.claude/bin/ci-job-budget.local.example.json`). That split is what lets this
 * engine cascade to every USE template and BUILD repo while the declaration — which
 * carries a fleet's labels, capacities and internal workflow names — never does.
 * The declaration is fenced from sync by `LOOM_LOCAL_PATTERNS` in
 * `sync-tier-aware.mjs`, which skips `.claude/bin/*.local.json` on every lane.
 *
 * FRESHNESS IS FAIL-CLOSED. A declared capacity is a MEASUREMENT, and a measurement
 * with no freshness contract goes stale silently and forever. Every capacity-bearing
 * node carries `capacity_authority` (HOW it was measured, restating the number) and
 * `capacity_verified_as_of` (WHEN). A missing, unreal or future date is a finding; a
 * read older than the clamped window is a finding. The audit REFUSES rather than
 * trusting a stale ceiling. Correctness needs NO credential: `--verify-capacity` is
 * an OPTIONAL reconciliation for an operator who holds one, never the gate.
 *
 * The date alone would not discriminate — it reads identically whether the number
 * was re-measured or re-typed — which is why the authority string must name a
 * re-runnable command AND restate the capacity it justifies.
 *
 * USAGE
 *   node .claude/bin/ci-job-budget-audit.mjs                 audit this repo
 *   node .claude/bin/ci-job-budget-audit.mjs --json          machine-readable
 *   node .claude/bin/ci-job-budget-audit.mjs --selftest      the negative control
 *   node .claude/bin/ci-job-budget-audit.mjs --verify-capacity <json-file>
 *                                                            OPTIONAL reconciliation
 * Exit 0 = VALID, 1 = findings, 2 = the audit could not run (UNKNOWN, never green).
 *
 * Node built-ins only, zero relative imports — so the `ALWAYS_INCLUDE` dep-closure
 * invariant in `sync-tier-aware.mjs` holds trivially.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `.claude/bin/` -> the repo root two levels up. */
const REPO_ROOT = path.resolve(HERE, "..", "..");
const WF_DIR = path.join(REPO_ROOT, ".github", "workflows");
export const DECLARATION_BASENAME = "ci-job-budget.local.json";
export const EXAMPLE_BASENAME = "ci-job-budget.local.example.json";
export const DECLARATION_ENV = "CI_JOB_BUDGET_DECLARATION";

// ── parsing ───────────────────────────────────────────────────────────────────
// Deliberately regex-based over the workflow text rather than a YAML library: it
// keeps this engine dependency-free (a consumer running it has Node and nothing
// else guaranteed), and the properties needed — trigger presence, job ids,
// `runs-on`, job-level `if:`, matrix shape — are all line-anchored. Every
// extractor is exported and selftest-covered, so a parsing regression is a RED
// case rather than a silently smaller census.

/**
 * Extract the `on:` block, tolerating the shapes that occur in the wild.
 * `"on":` is legal YAML and is what several formatters emit, because a bare `on`
 * is the YAML 1.1 boolean true.
 */
function onBlock(src) {
  // `[ \t]*` NOT `\s*` after the colon: in JS `\s` MATCHES A NEWLINE, so a greedy
  // `\s*` before the inline capture crosses the line break and swallows the FIRST
  // line of the block body — which makes a paths-filtered workflow read as
  // unfiltered.
  const m = /^["']?on["']?[ \t]*:[ \t]*(.*)\n((?:[ \t]+.*\n|[ \t]*#.*\n|\n)*)/m.exec(src);
  if (!m) return { inline: "", body: "" };
  return { inline: m[1] || "", body: m[2] || "" };
}

export function triggersOnPullRequest(src) {
  const { inline, body } = onBlock(src);
  // `pull_request_target` COUNTS. It is a different trigger with different
  // permissions, but it fans out on a pull request and consumes a runner exactly
  // the same way, which is the only question this census asks. It is invisible to
  // a `\bpull_request\b` pattern, because `_` is a word character.
  const NAMES = /\b(pull_request|pull_request_target)\b/;
  // flow sequence `on: [push, pull_request]` / flow mapping `on: { pull_request: {} }`
  if (NAMES.test(inline)) return true;
  // block mapping at ANY indent (2-space and 4-space styles both occur); a
  // column-0 comment inside the block must not truncate the capture.
  return /^[ \t]+["']?(pull_request|pull_request_target)["']?\s*:/m.test(body);
}

export function workflowHasPathsFilter(src) {
  const { body } = onBlock(src);
  if (!body) return false;
  // ONLY the `pull_request:` block. Reading `paths:` from ANY trigger under-counts:
  // a workflow carrying `paths:` on `push:` while its `pull_request:` trigger is
  // deliberately unfiltered would read as filtered, silently excusing the exact
  // jobs this audit exists to surface.
  //
  // Indent is DERIVED from the block, not assumed. Requiring exactly two spaces
  // makes a 4-space `on:` block read as unfiltered while `triggersOnPullRequest`
  // counts it as PR-triggered — an asymmetry that is safe only by luck.
  const lines = body.split("\n");
  const hdr = lines.findIndex((l) => /^[ \t]*["']?pull_request["']?\s*:/.test(l));
  if (hdr === -1) return false;
  const indent = (lines[hdr].match(/^[ \t]*/) || [""])[0].length;
  for (let k = hdr + 1; k < lines.length; k += 1) {
    const line = lines[k];
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    const ind = (line.match(/^[ \t]*/) || [""])[0].length;
    if (ind <= indent) break; // left the pull_request block
    // `paths:` ONLY. `paths-ignore:` is NOT a gate for budget purposes — a workflow
    // ignoring `**/*.md` still fires on every code-touching PR, so its jobs cost a
    // runner on the common case. Treating it as gating UNDER-counts the unbudgeted
    // set, which is the direction this audit exists to catch.
    if (/^[ \t]*paths:/.test(line)) return true;
  }
  return false;
}

/** Job blocks as {id, body} in file order. */
export function jobBlocks(src) {
  const at = src.indexOf("\njobs:");
  if (at < 0) return [];
  const body = src.slice(at);
  const out = [];
  // Tolerate a trailing comment on the job key. `  build:  # nightly only` is a
  // valid job key, and a `[ \t]*$` anchor drops it from the census SILENTLY — the
  // under-count direction. `no-workflow-parses-to-zero-jobs` cannot see it: that
  // floor fires only when a workflow yields ZERO jobs, so one dropped job among
  // several is invisible.
  const re = /^ {2}([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ id: m[1], start: m.index });
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    out.push({ id: marks[i].id, body: body.slice(marks[i].start, end) });
  }
  return out;
}

// NOTE on `[ \t]*` rather than `\s*` in the three extractors below: in JS `\s`
// MATCHES A NEWLINE, so a greedy `\s*` sitting before a lazy capture crosses the
// line break and captures the NEXT line — which makes `runs-on:` in mapping form
// return the `group:` line instead of the labels.
export function jobName(block) {
  const m = /^ {4}name:[ \t]*(.+?)[ \t]*$/m.exec(block);
  if (!m) return null;
  // Strip a trailing YAML comment. `name: Gate # the gate` is the scalar "Gate";
  // keeping the comment means the job can never string-match its required context.
  const raw = m[1].replace(/\s+#.*$/, "").trim();
  return raw.replace(/^["']|["']$/g, "");
}

export function jobRunsOn(block) {
  const m = /^ {4}runs-on:[ \t]*(.*?)[ \t]*$/m.exec(block);
  if (!m) return null;
  const head = m[1].trim();
  if (head) return head;
  // MAPPING form: `runs-on:` then `group:` / `labels:` on following lines. The pool
  // lives in `labels:`; returning the first child line yields the group name and the
  // pool fails to resolve.
  const after = block.slice(m.index + m[0].length);
  const lines = [];
  for (const line of after.split("\n")) {
    if (/^\s*$/.test(line)) continue;
    if (!/^ {6}/.test(line)) break;
    lines.push(line.trim());
  }
  const labels = lines.find((l) => /^labels\s*:/.test(l));
  return labels ? labels.replace(/^labels\s*:\s*/, "") : lines.join(" ") || null;
}

export function jobIf(block) {
  const m = /^ {4}if:[ \t]*(.*?)[ \t]*$/m.exec(block);
  if (!m) return null;
  const head = m[1].trim();
  // A BLOCK SCALAR (`>`, `|`, `>-`, `|-`) puts the condition on the FOLLOWING
  // indented lines. Returning the indicator alone reports ">" as the whole
  // condition, so a genuinely relevance-gated job reads as ungated.
  if (/^[>|][-+]?$/.test(head)) {
    const after = block.slice(m.index + m[0].length);
    const lines = [];
    for (const line of after.split("\n")) {
      if (/^\s*$/.test(line)) {
        lines.push("");
        continue;
      }
      if (!/^ {6}/.test(line)) break; // dedent ends the scalar
      lines.push(line.trim());
    }
    return lines.join(" ").trim();
  }
  return head;
}

/**
 * Is this job UNREACHABLE from a pull request, because its own `if:` pins it to a
 * different event? Counting such a job against the PR budget charges a pull request
 * for a job that cannot run on one.
 */
export function isEventExcludedFromPr(cond) {
  if (!cond) return false;
  // ONE NEGATED SHAPE IS DECIDABLE, and it is handled BEFORE the blanket refusal.
  // `github.event_name != 'pull_request'` is FALSE on a pull request, so the job
  // cannot run there — that is the plainest possible way to say "not on PRs", and
  // sweeping it up with the undecidable negations mis-counts jobs a workflow's own
  // header says stay on a schedule. Narrowly: a top-level `||` still defeats it.
  //
  // SCOPE: this answers the `pull_request` leg. A workflow that ALSO triggers
  // `pull_request_target` fires a separate run where a job negating only
  // `pull_request` still executes; that leg is decided by the workflow's trigger
  // set, not by this condition.
  if (
    !hasTopLevelOr(cond) &&
    (cond.match(/github\.event_name\s*!=\s*'([a-z_]+)'/g) || [])
      .map((x) => (x.match(/'([a-z_]+)'/) || [])[1])
      .includes("pull_request")
  ) {
    return true;
  }
  // A NEGATED pin inverts the meaning and this function reads pins positionally, so
  // `!(github.event_name == 'push')` — true on every PR — would be excluded from the
  // census. Refuse anything else containing a negation: this is the ONLY
  // census-SHRINKING predicate, so it excludes only when it can SEE that every path
  // to this job is non-PR.
  if (/![\s(]*github\.event_name/.test(cond) || /!=\s*'/.test(cond)) return false;
  // A top-level `||` defeats positional reading: any one disjunct suffices, so a job
  // pinned `event_name == 'push' || github.event.pull_request.draft == false` DOES
  // run on pull requests while every `event_name` pin present says otherwise.
  if (hasTopLevelOr(cond)) {
    const pins = cond.match(/github\.event_name\s*==\s*'([a-z_]+)'/g) || [];
    const evs = pins.map((x) => (x.match(/'([a-z_]+)'/) || [])[1]);
    // Safe sub-case: EVERY disjunct is an event_name pin and none is PR-reaching.
    const disjuncts = splitTopLevelOr(cond);
    // `allArePins` implies `pins` is non-empty, so an `evs.length` conjunct would be
    // redundant — two edges each surviving a mutation on the other's back.
    const allArePins = disjuncts.every((d) =>
      /^\s*github\.event_name\s*==\s*'[a-z_]+'\s*$/.test(d),
    );
    if (!allArePins) return false;
    // `pull_request_target` and `merge_group` both reach a PR-shaped run and consume
    // a runner, so neither may license an exclusion. Applying that allowlist to the
    // WIDENING predicate and not to the SHRINKING one is the asymmetry running in
    // the unsafe direction.
    return (
      !evs.includes("pull_request") &&
      !evs.includes("pull_request_target") &&
      !evs.includes("merge_group")
    );
  }
  // an equality pin to a non-PR event, with no `pull_request` alternative named
  const pins = cond.match(/github\.event_name\s*==\s*'([a-z_]+)'/g) || [];
  if (!pins.length) return false;
  const events = pins.map((x) => (x.match(/'([a-z_]+)'/) || [])[1]);
  return (
    !events.includes("pull_request") &&
    !events.includes("pull_request_target") &&
    !events.includes("merge_group")
  );
}

/**
 * The job ids this job DEPENDS ON, from either legal `needs:` spelling.
 *
 * `needs: build` (scalar), `needs: [a, b]` (flow) and a block sequence are all
 * legal. Returns [] when absent. Used for skip PROPAGATION: a CI provider skips the
 * whole subtree below a skipped job, so a dependant is as unreachable as its parent.
 */
export function jobNeeds(body) {
  const flow = /^\s{4}needs:\s*\[([^\]]*)\]/m.exec(body || "");
  if (flow) {
    return flow[1]
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const scalar = /^\s{4}needs:[ \t]*([A-Za-z0-9_-]+)[ \t]*(?:#.*)?$/m.exec(body || "");
  if (scalar) return [scalar[1]];
  const block = /^\s{4}needs:[ \t]*(?:#.*)?\n((?:\s{6}-[^\n]*\n?)+)/m.exec(body || "");
  if (block) return [...block[1].matchAll(/-\s*["']?([A-Za-z0-9_-]+)["']?/g)].map((x) => x[1]);
  return [];
}

/** Split on `||` at paren-depth zero. */
export function splitTopLevelOr(cond) {
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (let i = 0; i < cond.length; i += 1) {
    const ch = cond[i];
    // QUOTE-AWARE, and it must match `hasTopLevelOr`'s scanner exactly: these two are
    // duals read by the same consumers, and hardening one alone leaves the disarm
    // reachable through the other. A paren inside a STRING is not a grouping paren;
    // an unbalanced `(` in a literal inflates `depth` permanently and hides every
    // later top-level `||`.
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      cur += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      continue;
    }
    if (ch === "|" && cond[i + 1] === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Does this job carry a per-job RELEVANCE skip (not merely an event guard)? */
export function hasRelevanceSkip(cond) {
  if (!cond) return false;
  // A bare `event_name == 'pull_request'` is NOT a relevance skip — it does not make
  // the job cheaper on a pull request, which is the whole point of the budget.
  //
  // The relevance term must be LOAD-BEARING, which means CONJUNCTIVE. Anything joined
  // to it by a top-level `||` short-circuits it: the job runs whenever the other
  // disjunct holds, no matter what relevance says. Test the STRUCTURE rather than
  // denylisting tokens — a denylist naming `always()` is walked straight past by
  // `success() || X`.
  if (hasTopLevelOr(cond)) return false;
  const asserted =
    /needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_]*relevant[A-Za-z0-9_]*\s*==\s*'true'/.test(cond);
  // `== 'false'` INVERTS the gate — the job then runs when the change is NOT relevant.
  const inverted = /\b(?:[A-Za-z0-9_]*relevant[A-Za-z0-9_]*)\s*==\s*'false'/.test(cond);
  return asserted && !inverted;
}

/**
 * True when `cond` contains a `||` outside every parenthesised group — i.e. a
 * disjunct that can satisfy the whole condition on its own. Depth-tracked rather
 * than regex-matched, because `(a || b) && c` is conjunctive at the top level and a
 * flat search cannot tell it from `a || (b && c)`.
 */
export function hasTopLevelOr(cond) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < cond.length; i += 1) {
    const ch = cond[i];
    // QUOTE-AWARE — see `splitTopLevelOr`. Both consumers disarm at once when this
    // is wrong: `isEventExcludedFromPr` deletes a PR-reachable job, and
    // `hasRelevanceSkip` books an ungated job as relevance-gated.
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "|" && cond[i + 1] === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * Classify ONE job block. The single definition of "is this job accounted for",
 * exported so an edit-time hook and this audit cannot answer it differently. A hook
 * re-implementing the expression is byte-equivalent only at the moment it is
 * written; nothing in CI executes the hook, so a later divergence would surface only
 * as a hook that quietly stopped agreeing with the authority.
 */
export function classifyJob(b, { pathsFiltered, requiredContexts, pools, budgeted, file }) {
  const name = jobName(b.body) || b.id; // a nameless job renders as its id
  const cond = jobIf(b.body);
  if (isEventExcludedFromPr(cond)) return null; // cannot run on a PR at all
  const key = `${file}::${b.id}`;
  const required = Boolean(name && requiredContexts.has(name));
  const gated = hasRelevanceSkip(cond) || (pathsFiltered && !required);
  return {
    key,
    file,
    id: b.id,
    name,
    cond,
    pool: resolvePool(jobRunsOn(b.body), pools),
    required,
    gated,
    budgeted: budgeted.has(key),
    legs: matrixLegs(b.body),
    body: b.body,
  };
}

/**
 * Ids appearing more than once. Exported as a pure function because a conjunct
 * guarding a condition the real tree does not exhibit is INERT, so mutating it in
 * place survives every fixture. Pulling it out gives the property an input of its
 * own and therefore a control that can actually go red.
 */
export function findDuplicateIds(ids) {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

/** `matrix: { os: [a, b], v: [1, 2] }` — the inline form, legal and easily unread. */
function flowMatrixLegs(inner) {
  let legs = 1;
  let seen = 0;
  const re = /([A-Za-z0-9_-]+)\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(inner))) {
    if (m[1] === "include" || m[1] === "exclude") continue;
    const n = m[2].trim() ? m[2].split(",").filter((x) => x.trim()).length : 0;
    if (n) {
      legs *= n;
      seen += 1;
    }
  }
  return seen ? Math.max(1, legs) : 1;
}

/**
 * How many RUNNERS does this job actually occupy?
 *
 * A `strategy: matrix` job is ONE yaml block and N concurrent runners. Counting
 * blocks under-counts the fan-out — the direction that hurts, and exactly the class
 * of error this audit exists to catch, so shipping it inside the counter would be a
 * poor showing.
 *
 * SCOPE, stated rather than implied: this multiplies the declared dimension lengths,
 * removes `exclude:` combinations, and adds only those `include:` entries that match
 * no existing combination. It does NOT evaluate expression-valued dimensions or a
 * matrix built at runtime — those count as their literal declared size, or 1 when
 * nothing literal is declared. It therefore UNDER-counts a dynamic matrix, and a
 * dynamic matrix on a PR-triggered workflow is worth a second look by hand.
 */
export function matrixLegs(block) {
  // FLOW FORM AT THE `strategy:` LEVEL TOO. Handling the flow `matrix: {…}` case and
  // not the ENCLOSING key means `strategy: { matrix: { os: [a…h] } }` — legal, and
  // what a formatter emits — matches nothing and reads as no matrix at all.
  const mFlowStrategy = /^ {4}strategy:[ \t]*\{(.*)\}[ \t]*(?:#.*)?$/m.exec(block);
  if (mFlowStrategy) {
    const inner = mFlowStrategy[1];
    const nestedMatrix = /matrix:[ \t]*\{(.*)\}/.exec(inner);
    return nestedMatrix ? flowMatrixLegs(nestedMatrix[1]) : 1;
  }
  const m = /^ {4}strategy:[ \t]*(?:#.*)?$/m.exec(block);
  if (!m) return 1;
  const rest = block.slice(m.index);
  // Tolerate a trailing comment: requiring NOTHING after the colon lets a single
  // `# note` on `strategy:` or `matrix:` silently collapse the whole matrix to one
  // leg — a one-character-class defect, invisible in review.
  const mmFlow = /^ {6}matrix:[ \t]*\{(.*)\}[ \t]*(?:#.*)?$/m.exec(rest);
  if (mmFlow) return flowMatrixLegs(mmFlow[1]);
  const mm = /^ {6}matrix:[ \t]*(?:#.*)?$/m.exec(rest);
  if (!mm) return 1;
  const body = rest.slice(mm.index + mm[0].length);
  // stop at the next key at or above `matrix:`'s indent
  const endM = /^ {0,6}\S/m.exec(body);
  const scope = endM ? body.slice(0, endM.index) : body;

  // Dimensions this parser SAW but could not READ. An unreadable dimension is
  // UNKNOWN, never one leg — the direction that hurts.
  const unreadable = [];
  // NULL-PROTOTYPE. Keys are WORKFLOW-controlled matrix dimension names and the
  // dimension regex admits `__proto__`, so `dims["__proto__"] = […]` would set the
  // prototype and create no key — the dimension vanishes from `Object.entries` and
  // the legs UNDER-count.
  const dims = Object.create(null); // name -> [values]
  const includes = []; // [{key: value}]
  const excludes = []; // [{key: value}] — REMOVES matching combinations
  const parseFlow = (t) => {
    // A MULTI-LINE flow sequence has no `]` on the opening line, so `lastIndexOf`
    // is -1 and a naive slice yields "" — dropping the dimension SILENTLY rather
    // than reporting it unreadable. Return null (UNREADABLE) so the caller can tell
    // "no values" from "could not read the values".
    const end = t.lastIndexOf("]");
    if (end < 1) return null;
    const inner = t.slice(1, end);
    return inner.trim()
      ? inner
          .split(",")
          .map((x) => x.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      : [];
  };
  // A QUOTED dimension key (`"target": [...]`) is legal YAML.
  const dimRe = /^ {8}["']?([A-Za-z0-9_-]+)["']?:[ \t]*(.*)$/gm;
  let d;
  while ((d = dimRe.exec(scope))) {
    const key = d[1];
    const inline = (d[2] || "").trim();
    const after = scope.slice(d.index + d[0].length);
    // A sequence dash at the PARENT indent belongs to this key and does not end the
    // block; nor does a COMMENT at the parent indent, a blank line, or the lone `]`
    // terminating a multi-line flow sequence. Without these the scope terminates on
    // the first item and the whole dimension reads as empty.
    const stop = /^ {0,8}(?!- )(?!#)(?!\])(?!\s*$)\S/m.exec(after);
    const nested = stop ? after.slice(0, stop.index) : after;

    if (key === "include" || key === "exclude") {
      const sink = key === "include" ? includes : excludes;
      // Each `- k: v` starts an entry; continuation lines at a deeper indent add
      // more keys to it. A sequence under a mapping key may take ANY deeper indent,
      // so a fixed 10/12-space cap drops legal entries.
      let cur = null;
      for (const line of nested.split("\n")) {
        const first = /^ {8,}- ["']?([A-Za-z0-9_-]+)["']?:[ \t]*(.*)$/.exec(line);
        const more = /^ {10,}["']?([A-Za-z0-9_-]+)["']?:[ \t]*(.*)$/.exec(line);
        if (first) {
          cur = {};
          sink.push(cur);
          cur[first[1]] = first[2].trim().replace(/^["']|["']$/g, "");
        } else if (more && cur) {
          cur[more[1]] = more[2].trim().replace(/^["']|["']$/g, "");
        }
      }
      continue;
    }

    if (inline.startsWith("[")) {
      // A multi-line flow sequence has its `]` on a LATER line, so parse across the
      // nested scope rather than the opening line alone.
      const v = parseFlow(inline.includes("]") ? inline : `${inline}\n${nested}`);
      if (v === null) {
        unreadable.push(`${key}: flow sequence has no closing "]" within the matrix block`);
      } else if (v.length) dims[key] = v;
    } else if (!inline) {
      // 10-space (child) OR 8-space (PARENT) indent — a sequence at the parent's
      // indent is legal YAML and is what several formatters emit.
      const v = (nested.match(/^ {8,10}- .*$/gm) || []).map((l) =>
        l
          .replace(/^ {8,10}- /, "")
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
      if (v.length) dims[key] = v;
    }
  }

  const names = Object.keys(dims);
  // With no dimensions, `include:` IS the matrix — it does not ADD to an empty
  // product of 1. Getting this wrong inflates an include-only matrix by exactly one
  // leg.
  if (names.length === 0) return Math.max(1, includes.length || 1);

  // Cartesian product of the declared dimensions.
  let combos = [{}];
  for (const n of names) {
    const next = [];
    for (const c of combos) for (const v of dims[n]) next.push({ ...c, [n]: v });
    combos = next;
  }

  // `exclude:` REMOVES a generated combination. Parsing it and then discarding it
  // OVER-counts — safe for a ceiling, but false for a declaration claiming to pin
  // today's TRUE worst case.
  if (excludes.length) {
    combos = combos.filter(
      (c) =>
        !excludes.some((ex) => {
          const shared = Object.keys(ex).filter((k) => names.includes(k));
          return shared.length > 0 && shared.every((k) => c[k] === ex[k]);
        }),
    );
  }

  // THE INCLUDE-MERGE RULE, which a bare `legs + includes` gets wrong: an `include`
  // entry that MATCHES an existing combination on the keys they SHARE is merged INTO
  // that leg and adds nothing. It creates a new leg only when it matches none. An
  // entry with NO overlapping key overwrites nothing, is added to EVERY combination,
  // and adds ZERO legs — which falls out correctly here, because `every` over an
  // empty list is true.
  let extra = 0;
  for (const inc of includes) {
    const shared = Object.keys(inc).filter((k) => names.includes(k));
    const merges = combos.some((c) => shared.every((k) => c[k] === inc[k]));
    if (!merges) extra += 1;
  }
  return Math.max(1, combos.length + extra);
}

/** Map a `runs-on` label expression onto a declared pool id. */
export function resolvePool(runsOn, pools) {
  if (!runsOn) return null;
  // TOKENIZE both sides. Raw substring matching lets a declared "label" containing
  // separators outrank a real one and capture a whole pool's jobs, and matches a
  // label appearing inside a trailing COMMENT on the runs-on line.
  const tokens = new Set(
    String(runsOn)
      .replace(/#.*$/, "")
      .toLowerCase()
      .split(/[[\],\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const hits = [];
  for (const [id, p] of Object.entries(pools)) {
    for (const label of p.labels || []) {
      const lbl = String(label).toLowerCase();
      if (tokens.has(lbl)) {
        hits.push(id);
        break;
      }
    }
  }
  // AMBIGUITY IS NULL. Returning `hits.sort()[0]` silently arbitrates in alphabetical
  // order — which is the worst available, because an overlay pool typically sorts
  // before the real one, moving a whole pool's jobs onto a row with no ratchet and
  // evaluating the ratchet against nothing. `pool-resolves` then structurally CANNOT
  // fire, because it only ever sees a resolved pool id.
  return hits.length === 1 ? hits[0] : null;
}

// ── dates and rationales ──────────────────────────────────────────────────────

/** Beyond this, a `REVIEW BY` is a permanent excuse with the shape of a deadline. */
export const DATED_RATIONALE_HORIZON_DAYS = 180;

/**
 * The HARD ceiling on how old the read behind a declared capacity may be.
 *
 * Shipped in the ENGINE, and it is the one number here that is not deployment
 * content: it is a pure freshness window, naming no fleet, no label and no host. The
 * declaration's own `capacity_max_age_days` is CLAMPED by it — `min(declared, this)`
 * — so a deployment may TIGHTEN the window and can never loosen it. Without the
 * clamp, raising the window would be a one-token way to make a stale ceiling fresh,
 * which is the same move as raising the number the window protects.
 */
export const CAPACITY_MAX_AGE_HARD_CEILING_DAYS = 90;

/** The floor on a rationale's length, below which it is a placeholder. */
export const RATIONALE_MIN_LENGTH = 40;

/**
 * A REAL calendar date in ISO form. `Date.parse` alone is not the test:
 * `2026-02-31` parses and silently ROLLS to March 3, so the round-trip is what
 * separates a date from a string that looks like one.
 */
export function isRealIsoDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/**
 * THE single dated-rationale validator.
 *
 * Every exemption on this surface demands "a substantive why WITH an unexpired
 * REVIEW BY". Re-implementing those arms inline per exemption is why only one of
 * them ever gets its expiry arm pinned: a control written against one exemption
 * proves nothing about the others, and a degenerate input (an empty `why`) trips the
 * thin-rationale AND missing-date arms at once, so each masks the other and neither
 * is tested.
 *
 * Returns `null` when the rationale is sound, else one of the string verdicts
 * `"thin"` / `"undated"` / `"unparseable"`, or an object `{ expired }` / `{ far }`.
 */
export function checkDatedRationale(why, nowIso, minLen = RATIONALE_MIN_LENGTH) {
  if (isRealIsoDate(nowIso) !== true) {
    throw new TypeError(
      `checkDatedRationale: nowIso must be a real ISO date, got ${JSON.stringify(nowIso)} — a clock that is not a date makes every age comparison meaningless`,
    );
  }
  const text = typeof why === "string" ? why : "";
  if (text.trim().length < minLen) return "thin";
  const m = /REVIEW BY (\d{4}-\d{2}-\d{2})/.exec(text);
  if (!m) return "undated";
  if (!isRealIsoDate(m[1])) return "unparseable";
  const days = Math.floor((Date.parse(`${m[1]}T00:00:00Z`) - Date.parse(`${nowIso}T00:00:00Z`)) / 86400000);
  if (days < 0) return { expired: -days };
  if (days > DATED_RATIONALE_HORIZON_DAYS) return { far: days };
  return null;
}

/** The message tail for a non-string verdict, so every call site cannot drift. */
export function datedRationaleTail(r) {
  if (r && typeof r === "object" && "expired" in r) {
    return `REVIEW BY passed ${r.expired}d ago — re-decide it or remove it`;
  }
  if (r && typeof r === "object" && "far" in r) {
    return `REVIEW BY is ${r.far}d out, past the ${DATED_RATIONALE_HORIZON_DAYS}-day horizon — a date that far ahead is a permanent excuse with the shape of a deadline`;
  }
  return String(r);
}

/**
 * Does `why` RESTATE the number it justifies, exactly once, correctly?
 *
 * A dated sentence proves someone wrote a sentence; it proves nothing about the
 * VALUE. Requiring the literal `<noun> <n>` makes the sentence answerable to the
 * number, so moving the number without re-deriving the sentence reds.
 *
 * THE LOOKAHEADS ARE THREE SEPARATE REFUSALS. `(?!\d)` stops a prefix match (a
 * declared 1 satisfied by a sentence about 16); `(?!\.\d)` stops a decimal tail being
 * truncated; `(?!-\d)` refuses a DATE as the carrier, so `capacity 2026-11-16` cannot
 * satisfy a declared capacity of 2026. A blanket `(?![\d.-])` would ALSO reject a
 * sentence-ending period, making an honest restatement read as absent — strict by
 * being broken.
 *
 * Requiring EXACTLY ONE matters as much as requiring the right one: a rationale
 * carrying several cannot notice which is current, and pre-loading tomorrow's value
 * into today's prose disarms this check in advance, with nothing red at either point.
 */
export function restatementFindings({ why, noun, value, label }) {
  const found = [...String(why || "").matchAll(new RegExp(`\\b${noun} (\\d+(?:\\.\\d+)?)(?!\\d)(?!\\.\\d)(?!-\\d)`, "g"))].map(
    (m) => m[1],
  );
  if (found.length === 0) {
    return `${label}: does not restate the ${noun} it justifies — expected the literal "${noun} ${value}"; a bare digit is satisfied by the rationale's own prose (a rule citation, or the REVIEW BY date the sibling arm requires), so the sentence could not notice the number changing under it`;
  }
  if (found.length > 1) {
    return `${label}: names ${found.length} ${noun} values (${found.join(", ")}) — a rationale that states more than one cannot notice which is current, and pre-loading a future value disarms this check in advance; state exactly one`;
  }
  if (found[0] !== String(value)) {
    return `${label}: restates "${noun} ${found[0]}" but the declared ${noun} is ${value} — the number moved and the sentence did not`;
  }
  return null;
}

// ── the declaration ───────────────────────────────────────────────────────────

/**
 * Where the deployment declaration lives, by explicit precedence and NEVER by a
 * positional guess.
 *
 *   1. $CI_JOB_BUDGET_DECLARATION   an ABSOLUTE path, wins outright
 *   2. <bin>/ci-job-budget.local.json
 *   3. null — fail LOUD
 *
 * There is no default declaration and no fallback. An audit with no declaration is
 * UNKNOWN, and UNKNOWN exits non-zero rather than green: a census with nothing to
 * measure itself against would report every job as fitting a pool that was never
 * declared.
 */
export function resolveDeclarationPath({ binDir = HERE, env = process.env } = {}) {
  const override = env[DECLARATION_ENV];
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        path: null,
        error: `$${DECLARATION_ENV} is set to ${JSON.stringify(override)}, which is not an ABSOLUTE path — a relative override resolves differently per working directory, so it is refused rather than guessed`,
      };
    }
    if (!existsSync(override)) {
      return { path: null, error: `$${DECLARATION_ENV} points at ${override}, which does not exist` };
    }
    return { path: override, error: null };
  }
  const local = path.join(binDir, DECLARATION_BASENAME);
  if (existsSync(local)) return { path: local, error: null };
  return {
    path: null,
    error:
      `no CI job-budget declaration found. This engine carries no deployment values by design, ` +
      `so it cannot audit without one.\n` +
      `  cp ${path.join(binDir, EXAMPLE_BASENAME)} \\\n     ${local}\n` +
      `  $EDITOR ${local}\n` +
      `Or set $${DECLARATION_ENV} to an absolute path. There is no positional fallback: ` +
      `an audit with no declaration is UNKNOWN, not clean.`,
  };
}

/** Parse a declaration, fail-closed. Returns `{ decl, error }`. */
export function loadDeclaration(p) {
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    return { decl: null, error: `could not read the declaration at ${p}: ${e.message}` };
  }
  try {
    const decl = JSON.parse(raw);
    if (decl === null || typeof decl !== "object" || Array.isArray(decl)) {
      return { decl: null, error: `the declaration at ${p} is not a JSON object` };
    }
    return { decl, error: null };
  } catch (e) {
    return { decl: null, error: `the declaration at ${p} is not valid JSON: ${e.message}` };
  }
}

/**
 * THE FRESHNESS CONTRACT, applied to ONE capacity-bearing node (a fleet or a pool).
 *
 * This is the root-cause fix for a capacity that had no reader. The source contract
 * this engine generalises made reconciliation depend on a live API call requiring an
 * `admin:org` credential no configured CI secret carried — so it never ran, and the
 * declared number went stale silently and forever while a dated sentence beside it
 * kept reading as fresh.
 *
 * Correctness must therefore need NO credential. Three things are demanded of every
 * capacity, all checkable offline:
 *   capacity                 a FINITE POSITIVE number (a non-finite or wrong-typed
 *                            capacity silently reads as "no ceiling", which is a
 *                            config side-effect rather than a declared state)
 *   capacity_authority       >= 40 chars naming HOW it was obtained AND restating it
 *                            as the literal `capacity <n>`
 *   capacity_verified_as_of  a REAL ISO date, not in the FUTURE, within the CLAMPED
 *                            window
 *
 * WHY THE AUTHORITY AND NOT JUST THE DATE. A date alone reads identically whether
 * the number was re-measured or merely re-typed — it cannot discriminate, so it is
 * not evidence of freshness. The authority names a command a reader can RE-RUN, and
 * the restatement makes the sentence answerable to the number.
 *
 * WHY THE FUTURE DATE IS ITS OWN ARM. A receipt records a read that HAPPENED; it
 * cannot post-date the clock it is measured against. A future date yields a NEGATIVE
 * age, which is under every window forever — a permanent receipt. Neither the
 * missing-date arm nor the too-old arm can see it.
 */
export function capacityFreshnessFindings({ node, label, nowIso, maxAgeDays }) {
  const out = [];
  const cap = node ? node.capacity : undefined;
  if (!("capacity" in (node || {}))) {
    out.push(`${label}: no capacity declared — a node with no capacity has no ceiling, and an absent ceiling is a config side-effect rather than a declared state`);
    return out;
  }
  if (typeof cap !== "number") {
    out.push(
      `${label}: capacity ${JSON.stringify(cap)} is declared but is not a number — a wrong-TYPE capacity silently reads as a ceiling exemption`,
    );
    return out;
  }
  if (!Number.isFinite(cap)) {
    out.push(
      `${label}: capacity ${cap} is not finite — a non-finite capacity makes every ceiling derived from it unbounded, deleting the ratchet with one key`,
    );
    return out;
  }
  if (cap <= 0) {
    out.push(`${label}: capacity ${cap} is not positive — a fleet or pool of zero runners cannot carry the jobs routed to it`);
    return out;
  }
  const why = typeof node.capacity_authority === "string" ? node.capacity_authority : "";
  if (why.trim().length < RATIONALE_MIN_LENGTH) {
    out.push(
      `${label}: capacity ${cap} carries no capacity_authority naming HOW it was measured — a number with no named authority is a policy constant wearing a measurement's clothes`,
    );
  } else {
    const r = restatementFindings({ why, noun: "capacity", value: cap, label: `${label}: capacity_authority` });
    if (r) out.push(r);
  }
  const asOf = node.capacity_verified_as_of;
  if (!asOf) {
    out.push(`${label}: no capacity_verified_as_of — the capacity is unsourced, so its freshness is UNKNOWN rather than fresh`);
    return out;
  }
  if (!isRealIsoDate(asOf)) {
    out.push(`${label}: capacity_verified_as_of ${JSON.stringify(asOf)} is not a real ISO calendar date`);
    return out;
  }
  const ageDays = Math.floor(
    (Date.parse(`${nowIso}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86400000,
  );
  if (ageDays < 0) {
    out.push(
      `${label}: capacity_verified_as_of "${asOf}" is ${-ageDays}d in the FUTURE — a receipt cannot post-date the read it records, and a negative age is under every window forever`,
    );
    return out;
  }
  if (ageDays > maxAgeDays) {
    out.push(
      `${label}: capacity ${cap} was verified ${ageDays}d ago (${asOf}), past the ${maxAgeDays}-day window — re-run the authority in capacity_authority and restate what it returned. REFUSING rather than trusting a stale ceiling.`,
    );
  }
  return out;
}

/** The effective freshness window: the declaration may TIGHTEN it, never loosen it. */
export function effectiveMaxAgeDays(decl) {
  const declared =
    typeof decl?.capacity_max_age_days === "number" && Number.isFinite(decl.capacity_max_age_days)
      ? decl.capacity_max_age_days
      : CAPACITY_MAX_AGE_HARD_CEILING_DAYS;
  return Math.min(declared, CAPACITY_MAX_AGE_HARD_CEILING_DAYS);
}

// ── the audit ─────────────────────────────────────────────────────────────────

export function audit({ workflows, decl, requiredContexts, now }) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass, detail });

  const pools = decl.pools || {};
  const fleets = decl.fleets || {};
  // THE CLOCK IS A PARAMETER, never a field of the audited declaration. Reading a
  // `_now` key from the file under audit lets ONE key move time for EVERY date check
  // at once — an expired `REVIEW BY` passes, and the freshness clamp is defeated
  // because a past clock yields a negative age, which is under any window.
  const nowIso = now || new Date().toISOString().slice(0, 10);
  const maxAgeDays = effectiveMaxAgeDays(decl);
  const budgeted = new Set(Object.keys(decl.budgeted || {}));

  add("declaration-loads", Object.keys(pools).length > 0, `${Object.keys(pools).length} pool(s) declared`);
  add(
    "fleets-declared",
    Object.keys(fleets).length > 0,
    Object.keys(fleets).length
      ? `${Object.keys(fleets).length} fleet(s) declared`
      : "no fleet declared — a pool with no fleet is bounded by NOTHING, so every capacity would be unconstrained",
  );

  // A declared label MUST be a single token. Tokenised matching means a
  // separator-bearing label can never match — so left silent it would make a pool
  // UNREACHABLE with no signal, and every job on it would resolve to null.
  const badLabels = [];
  for (const [pid, p] of Object.entries(pools)) {
    for (const label of p.labels || []) {
      if (!/^[A-Za-z0-9_.-]+$/.test(String(label))) {
        badLabels.push(
          `${pid}: label ${JSON.stringify(label)} is not a single token — it can never match a runs-on entry, so this pool is unreachable`,
        );
      }
    }
    if (!(p.labels || []).length) badLabels.push(`${pid}: declares no labels, so no job can ever resolve to it`);
  }
  add(
    "pool-labels-are-single-tokens",
    badLabels.length === 0,
    badLabels.length
      ? badLabels.join("; ")
      : `every declared label across ${Object.keys(pools).length} pool(s) is a single token`,
  );

  // …and no label may be declared by TWO pools. Ambiguity resolves to null, so the
  // jobs surface as unresolvable — but that reports the SYMPTOM at the job and
  // leaves the operator to infer the cause from the declaration. Report the cause.
  const labelOwners = Object.entries(pools).flatMap(([pid, p]) =>
    (p.labels || []).map((l) => [String(l).toLowerCase(), pid]),
  );
  const dupLabels = findDuplicateIds(labelOwners.map(([l]) => l));
  add(
    "pool-labels-are-unambiguous",
    dupLabels.length === 0,
    dupLabels.length
      ? dupLabels
          .map(
            (l) =>
              `label "${l}" is declared by ${labelOwners
                .filter(([x]) => x === l)
                .map(([, pid]) => pid)
                .join(" and ")} — a job carrying it belongs to neither, so whichever pool's ceiling would have applied is evaluated against nothing`,
          )
          .join("; ")
      : `${labelOwners.length} declared label(s) across ${Object.keys(pools).length} pool(s), each owned by exactly one`,
  );

  // Every pool names a DECLARED fleet. A pool naming an undeclared fleet is bounded
  // by nothing, so it is a finding rather than a silent skip (fail-closed).
  const orphanFleet = Object.entries(pools)
    .filter(([, p]) => !Object.prototype.hasOwnProperty.call(fleets, String(p.fleet)))
    .map(
      ([pid, p]) =>
        `${pid}: fleet ${JSON.stringify(p.fleet)} is not declared under "fleets", so this pool's capacity is bounded by NOTHING`,
    );
  add(
    "pool-names-a-declared-fleet",
    orphanFleet.length === 0,
    orphanFleet.length
      ? orphanFleet.join("; ")
      : `every one of ${Object.keys(pools).length} pool(s) names a declared fleet`,
  );

  // ── the census ──────────────────────────────────────────────────────────────
  const jobs = [];
  const parsedZero = [];
  const eventExcluded = []; // the census SHRINKS here — record it
  const templateNamed = []; // a templated name can never equal a required context
  for (const { file, src } of workflows) {
    if (!triggersOnPullRequest(src)) continue;
    if (jobBlocks(src).length === 0) parsedZero.push(file);
    const pathsFiltered = workflowHasPathsFilter(src);
    for (const b of jobBlocks(src)) {
      const row = classifyJob(b, { pathsFiltered, requiredContexts, pools, budgeted, file });
      if (!row) {
        eventExcluded.push(`${file}::${b.id}`);
        continue;
      }
      // A `name:` containing a template interpolation can never string-equal a
      // required context, because the check-run is reported under the UNEXPANDED
      // template — the same "declared thing never matches" shape as a nameless job,
      // one field over, and latent only while every required context happens to be a
      // literal single-leg job name.
      if (/\$\{\{/.test(row.name)) templateNamed.push(`${file}::${b.id}`);
      row.needs = jobNeeds(b.body);
      jobs.push(row);
    }
  }

  // TRANSITIVE `needs:` PROPAGATION. A skipped job's whole subtree is skipped, so a
  // job that `needs:` an event-excluded job is itself unreachable. Iterated to a
  // FIXPOINT rather than one pass: a chain a -> b -> c must remove all three, and a
  // single sweep in declaration order misses any edge pointing backwards.
  {
    const excludedIds = new Set(eventExcluded.map((k) => k.split("::")[1]));
    for (let pass = 0; pass < jobs.length + 1; pass += 1) {
      const before = excludedIds.size;
      for (const j of jobs) {
        if (excludedIds.has(j.id)) continue;
        if ((j.needs || []).some((dep) => excludedIds.has(dep))) excludedIds.add(j.id);
      }
      if (excludedIds.size === before) break;
    }
    for (let i = jobs.length - 1; i >= 0; i -= 1) {
      if (!excludedIds.has(jobs[i].id)) continue;
      const j = jobs[i];
      eventExcluded.push(`${j.file}::${j.id} (needs an excluded job)`);
      jobs.splice(i, 1);
    }
  }

  // ANTI-VACUITY for the required set. With an EMPTY set every job reads as
  // non-required, so every job in every paths-filtered workflow reads as gated and
  // the whole contract becomes undetectable.
  add(
    "required-contexts-load",
    requiredContexts.size > 0,
    requiredContexts.size
      ? `${requiredContexts.size} required context(s) declared`
      : "the required-context set is EMPTY — every job would read as non-required, so every job in every paths-filtered workflow would read as gated and the contract would be undetectable",
  );

  // Report the census WITH what it removed. Two opposite effects can net out, and a
  // bare total shows neither, so a reader reconciling a ratchet cannot see the
  // exclusion arm at all.
  add(
    "workflows-readable",
    jobs.length > 0,
    `${jobs.length} PR-reachable job(s) derived` +
      (eventExcluded.length
        ? `; ${eventExcluded.length} excluded as non-PR-reachable (${eventExcluded.join(", ")})`
        : "; 0 excluded"),
  );

  // DECLARED, not inferred. A templated job name is a latent hazard rather than a
  // live defect, so failing the build on it would be wrong and staying silent lets
  // the next one arrive unnoticed. Only an UNDECLARED one is a finding — and so is a
  // STALE declaration, because leaving one standing pre-approves the next. The legacy
  // ARRAY form is accepted but held to the same dated rationale every sibling
  // exemption carries: appending one string to an array must not convert a finding
  // into a pass.
  const tplDecl = decl._template_named_jobs;
  const tplEntries = Array.isArray(tplDecl)
    ? tplDecl.map((k) => [k, null])
    : Object.entries(tplDecl && typeof tplDecl === "object" ? tplDecl : {});
  const declaredTpl = new Set(tplEntries.map(([k]) => k));
  const tplUnjustified = tplEntries
    .filter(([, v]) => checkDatedRationale(v && typeof v === "object" ? v.why : "", nowIso) !== null)
    .map(([k]) => k);
  const undeclaredTpl = templateNamed.filter((k) => !declaredTpl.has(k));
  const staleTpl = [...declaredTpl].filter((k) => !templateNamed.includes(k));
  add(
    "template-named-jobs-declared",
    undeclaredTpl.length === 0 && staleTpl.length === 0 && tplUnjustified.length === 0,
    [
      undeclaredTpl.length
        ? `undeclared template-named job(s): ${undeclaredTpl.join(", ")} — such a job can never string-match a required context; declare it or give it a literal name`
        : "",
      staleTpl.length
        ? `stale declaration(s): ${staleTpl.join(", ")} no longer carry a template name (leaving one standing pre-approves the next)`
        : "",
      tplUnjustified.length
        ? `exemption(s) with no dated rationale: ${tplUnjustified.join(", ")} — every sibling exemption needs a >=${RATIONALE_MIN_LENGTH}-char why with an unexpired REVIEW BY; an array entry is a one-key pass`
        : "",
    ]
      .filter(Boolean)
      .join("; ") || `${templateNamed.length} template-named job(s), each declared`,
  );

  // A job that CALLS a reusable workflow fans out to that workflow's jobs, which this
  // census cannot see. A latent blind spot that under-counts SILENTLY is exactly the
  // shape this surface exists to refuse, so fail LOUD the moment one appears.
  const reusable = jobs.filter((j) => /^ {4}uses:\s*\S/m.test(j.body)).map((j) => j.key);
  add(
    "no-reusable-workflow-callees",
    reusable.length === 0,
    reusable.length
      ? `${reusable.join(", ")} call a reusable workflow — this census cannot see the jobs they fan out to; budget them explicitly or inline them`
      : "no job delegates to a reusable workflow (the census can see every job it counts)",
  );

  // A PR-triggered workflow that parses to ZERO jobs is a PARSER failure wearing the
  // costume of an empty workflow. An anti-vacuity floor over the WHOLE tree cannot
  // see it, because the other workflows satisfy the floor.
  add(
    "no-workflow-parses-to-zero-jobs",
    parsedZero.length === 0,
    parsedZero.length
      ? `${parsedZero.join(", ")} trigger(s) on pull_request but yield no jobs — parser blind spot, not an empty workflow`
      : "every PR-triggered workflow yields at least one job",
  );

  // 1. every PR-reachable job is required, gated, or budgeted
  const unbudgeted = jobs.filter((j) => !j.required && !j.gated && !j.budgeted);
  add(
    "every-job-accounted",
    unbudgeted.length === 0,
    unbudgeted.length
      ? `${unbudgeted.length} unbudgeted: ${unbudgeted
          .slice(0, 6)
          .map((j) => j.key)
          .join(", ")}${unbudgeted.length > 6 ? " …" : ""}`
      : "every PR-reachable job is required, relevance-gated, or budgeted",
  );

  // 2. no job declares a pool that does not exist
  const orphanPool = jobs.filter((j) => j.pool === null);
  add(
    "pool-resolves",
    orphanPool.length === 0,
    orphanPool.length
      ? `${orphanPool.length} job(s) target an undeclared or ambiguous pool: ${orphanPool
          .slice(0, 4)
          .map((j) => j.key)
          .join(", ")}`
      : "every job resolves to exactly one declared pool",
  );

  // NULL-PROTOTYPE, because the keys are DECLARATION-CONTROLLED strings. With a bare
  // `{}`, a pool id of `__proto__` makes `perPool[id] || {…}` read `Object.prototype`
  // — truthy — so the accumulation writes onto the prototype and `Object.entries`
  // never sees the row: the pool vanishes from every terminal line rather than being
  // reported as zero.
  const perPool = Object.create(null);
  for (const j of jobs) {
    if (!j.pool) continue;
    perPool[j.pool] = perPool[j.pool] || { required: 0, total: 0 };
    perPool[j.pool].total += j.legs || 1; // a matrix job occupies one runner PER LEG
    if (j.required) perPool[j.pool].required += j.legs || 1;
  }

  // 3. REQUIRED demand per pool must fit capacity. Required jobs cannot be skipped,
  //    so if they alone exceed the pool no pull request can validate without
  //    saturating it.
  const overflow = Object.entries(perPool)
    .filter(([pid, d]) => {
      const cap = (pools[pid] || {}).capacity;
      return typeof cap === "number" && Number.isFinite(cap) && d.required > cap;
    })
    .map(([pid, d]) => `${pid}: ${d.required} required > capacity ${(pools[pid] || {}).capacity}`);
  add(
    "required-demand-fits-pool",
    overflow.length === 0,
    overflow.length
      ? overflow.join("; ")
      : Object.entries(perPool)
          .map(([p, d]) => `${p}=${d.required}req/${d.total}tot`)
          .join("  ") || "no job resolved to any pool",
  );

  // ── freshness: the fail-closed capacity contract ────────────────────────────
  // Applied UNIFORMLY to every fleet and every pool. The source contract this
  // generalises exempted a carved-out pool from the receipt entirely, which is the
  // one-key shape: a single field silently deleted the whole freshness obligation for
  // that pool while the check PRINTED that every pool carried a fresh date.
  const stale = [];
  for (const [fid, f] of Object.entries(fleets)) {
    stale.push(...capacityFreshnessFindings({ node: f, label: `fleet ${fid}`, nowIso, maxAgeDays }));
  }
  for (const [pid, p] of Object.entries(pools)) {
    stale.push(...capacityFreshnessFindings({ node: p, label: `pool ${pid}`, nowIso, maxAgeDays }));
  }
  const freshSubjects = Object.keys(fleets).length + Object.keys(pools).length;
  add(
    "capacity-is-fresh",
    stale.length === 0,
    stale.length
      ? stale.join("; ")
      : freshSubjects === 0
        ? "nothing declares a capacity — UNKNOWN, not fresh"
        : `${freshSubjects} capacity-bearing node(s) (${Object.keys(fleets).length} fleet(s) + ${Object.keys(pools).length} pool(s)), each naming a re-runnable authority that restates its own number, verified within ${maxAgeDays}d. Freshness is enforced OFFLINE and fails CLOSED; --verify-capacity is an OPTIONAL reconciliation of the NUMBER for an operator holding a credential, never the gate.`,
  );

  // ── the fleet bounds ────────────────────────────────────────────────────────
  // A pool can never be larger than the fleet it draws from…
  const oversized = Object.entries(pools)
    .filter(([, p]) => typeof p.capacity === "number" && Number.isFinite(p.capacity))
    .map(([pid, p]) => {
      const f = fleets[String(p.fleet)];
      if (!f || typeof f.capacity !== "number" || !Number.isFinite(f.capacity)) {
        // Reported at `pool-names-a-declared-fleet` / `capacity-is-fresh` — but it
        // must not silently resolve to "unbounded" HERE either (fail-closed).
        return `${pid}: its fleet ${JSON.stringify(p.fleet)} declares no usable capacity, so this pool's capacity ${p.capacity} is bounded by NOTHING`;
      }
      return p.capacity > f.capacity
        ? `${pid}: declared capacity ${p.capacity} exceeds fleet ${p.fleet}'s ${f.capacity} — a capacity is a MEASUREMENT; no pool can be larger than the fleet it draws from`
        : null;
    })
    .filter(Boolean);
  add(
    "capacity-within-the-fleet",
    oversized.length === 0,
    oversized.length
      ? oversized.join("; ")
      : `${Object.values(pools).filter((p) => typeof p.capacity === "number").length} pool capacity/ies each within their declared fleet`,
  );

  // …and the NON-OVERLAY pools of one fleet can never SUM past it. This is the bound
  // a per-pool ceiling leaves open: each pool individually fits while the fleet is
  // oversold, because nothing adds them up. `union: true` marks an OVERLAY pool whose
  // runners are already counted in a sibling, so it is excluded from the SUM and from
  // nothing else.
  const sumFindings = [];
  for (const [fid, f] of Object.entries(fleets)) {
    if (typeof f.capacity !== "number" || !Number.isFinite(f.capacity)) continue;
    const members = Object.entries(pools).filter(
      ([, p]) => String(p.fleet) === fid && p.union !== true && typeof p.capacity === "number" && Number.isFinite(p.capacity),
    );
    const sum = members.reduce((a, [, p]) => a + p.capacity, 0);
    if (sum > f.capacity) {
      sumFindings.push(
        `fleet ${fid}: its non-overlay pools sum to ${sum} (${members.map(([pid, p]) => `${pid}=${p.capacity}`).join(" + ")}) but the fleet measures ${f.capacity} — each pool fits individually while the fleet is oversold, which is exactly the slack a per-pool ceiling leaves open`,
      );
    }
  }
  add(
    "non-overlay-capacities-sum-within-the-fleet",
    sumFindings.length === 0,
    sumFindings.length
      ? sumFindings.join("; ")
      : Object.keys(fleets).length
        ? `every fleet's non-overlay pool capacities sum within its measured total`
        : "no fleet declared — nothing to sum",
  );

  // `union: true` is an EXEMPTION from the sum, so it is a DATED DECLARATION rather
  // than a one-key config side-effect. Left unguarded, one boolean removes a pool
  // from the sum silently and forever.
  const unionUndeclared = [];
  for (const [pid, p] of Object.entries(pools)) {
    if (p.union !== true) continue;
    const r = checkDatedRationale(p._union_why, nowIso);
    if (r === "thin") unionUndeclared.push(`${pid}: union: true with no _union_why naming which sibling pool already counts these runners`);
    else if (r === "undated") unionUndeclared.push(`${pid}: union exemption with no "REVIEW BY <YYYY-MM-DD>" date`);
    else if (r === "unparseable") unionUndeclared.push(`${pid}: union exemption REVIEW BY is not a real calendar date`);
    else if (r) unionUndeclared.push(`${pid}: union exemption ${datedRationaleTail(r)}`);
  }
  const unionCount = Object.values(pools).filter((p) => p.union === true).length;
  add(
    "union-exemption-declared-and-dated",
    unionUndeclared.length === 0,
    unionUndeclared.length
      ? unionUndeclared.join("; ")
      : unionCount === 0
        ? "no pool declares union: true — nothing to check"
        : `${unionCount} overlay pool(s), each declaring why with an unexpired review date`,
  );

  // ── the ratchets ────────────────────────────────────────────────────────────
  // WORST-CASE demand, per pool AND per fleet. Whether the REQUIRED jobs fit is the
  // wrong question — they comfortably do. The binding constraint is the worst case:
  // every PR-reachable job at once, because a pull request touching many paths fires
  // every paths-gated workflow too. `oversubscribe` is the declared allowance; 1.0
  // means one pull request must fit outright.
  //
  // The FLEET arm is not a nicety. Bounding each pool's DEMAND while nothing bounds
  // the total leaves the fleet contended for by the sum of every pool's ratchet, so a
  // job moved from a ratcheted pool to an unratcheted sibling — one token in
  // `runs-on:`, landing on the SAME physical runners — costs the same capacity with
  // nothing red.
  const subjects = [
    ...Object.entries(pools).map(([id, node]) => ({
      kind: "pool",
      id,
      node,
      total: (perPool[id] || { total: 0 }).total,
    })),
    ...Object.entries(fleets).map(([id, node]) => ({
      kind: "fleet",
      id,
      node,
      total: Object.entries(pools)
        .filter(([, p]) => String(p.fleet) === id)
        .reduce((a, [pid]) => a + (perPool[pid] || { total: 0 }).total, 0),
    })),
  ];

  const overSub = [];
  for (const s of subjects) {
    const cap = s.node.capacity;
    // An absent, wrong-typed or non-finite capacity is `capacity-is-fresh`'s finding.
    // Evaluating a ceiling against it here would emit a second, vaguer version of a
    // finding that already has a precise owner — two arms red, neither isolating.
    if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
    const rawAllow = typeof s.node.oversubscribe === "number" ? s.node.oversubscribe : 1;
    if (!(Number.isFinite(rawAllow) && rawAllow > 0)) {
      overSub.push(
        `${s.kind} ${s.id}: oversubscribe ${rawAllow} is not a finite positive number — a non-finite multiplier makes the ceiling unbounded and deletes the ratchet`,
      );
      continue;
    }
    const ceiling = Math.floor(cap * rawAllow);
    if (s.total > ceiling) {
      overSub.push(`${s.kind} ${s.id}: worst-case ${s.total} job(s) > ${ceiling} (capacity ${cap} x ${rawAllow})`);
    }
  }
  // The pass line says WHAT IT FITS. Printing bare totals under a check id reading
  // "fits" makes a ratchet ceiling look like physical capacity — the declaration is
  // honest about the difference and the terminal line must be too, because the
  // terminal line is what a reader sees.
  add(
    "worst-case-demand-fits",
    overSub.length === 0,
    overSub.length
      ? overSub.join("; ")
      : subjects
          .filter((s) => typeof s.node.capacity === "number" && Number.isFinite(s.node.capacity))
          .map((s) => {
            const cap = s.node.capacity;
            const allow =
              typeof s.node.oversubscribe === "number" && Number.isFinite(s.node.oversubscribe) && s.node.oversubscribe > 0
                ? s.node.oversubscribe
                : 1;
            const ceil = Math.floor(cap * allow);
            return allow > 1
              ? `${s.id}=${s.total} of ${ceil} RATCHET (capacity ${cap} x ${allow}; ${s.total} jobs do NOT fit ${cap} runners — they queue)`
              : `${s.id}=${s.total} of ${ceil} runners`;
          })
          .join("  ") || "nothing declares a usable capacity",
  );

  // An oversubscribe above 1.0 MUST carry a rationale, a review date the audit REDS
  // once it passes, AND the literal arithmetic it justifies. Without the arithmetic,
  // the check verifies only that a dated SENTENCE exists and never that the sentence
  // describes the VALUE — so moving the ratio is one token, needs no other edit, and
  // leaves the shipped rationale still asserting the old ceiling.
  const overDecl = [];
  for (const s of subjects) {
    const allow = typeof s.node.oversubscribe === "number" ? s.node.oversubscribe : 1;
    if (!(Number.isFinite(allow) && allow > 1)) continue;
    const label = `${s.kind} ${s.id}`;
    const why = typeof s.node._oversubscribe_why === "string" ? s.node._oversubscribe_why : "";
    const r = checkDatedRationale(why, nowIso);
    if (r === "thin") {
      overDecl.push(`${label}: oversubscribe ${allow} above 1.0 with no _oversubscribe_why`);
      continue;
    }
    if (r === "undated") {
      overDecl.push(`${label}: oversubscribe ${allow} with no "REVIEW BY <YYYY-MM-DD>" date — a ratio with no reader`);
      continue;
    }
    if (r === "unparseable") {
      overDecl.push(`${label}: oversubscribe ${allow} REVIEW BY is not a real calendar date`);
      continue;
    }
    if (r) {
      overDecl.push(`${label}: oversubscribe ${allow} ${datedRationaleTail(r)} — re-decide or lower it`);
      continue;
    }
    const cap = s.node.capacity;
    if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
    const expect = `floor(${cap} x ${allow}) = ${Math.floor(cap * allow)}`;
    // Match the GENERIC SHAPE, then COUNT, then COMPARE — not "does the current
    // literal appear". Requiring the current literal is satisfied by a rationale that
    // ALSO carries other arithmetic, so pre-loading tomorrow's number into today's
    // prose disarms this check for a future edit with nothing red at either point.
    const found = [...why.matchAll(/\bfloor\((\d+(?:\.\d+)?) x (\d+(?:\.\d+)?)\) = (\d+)(?!\d)(?!\.\d)/g)].map((m) => m[0]);
    if (found.length === 0) {
      overDecl.push(
        `${label}: _oversubscribe_why does not restate the arithmetic it justifies — expected the literal "${expect}"; a rationale that does not name its own number cannot notice the number changing under it`,
      );
    } else if (found.length > 1) {
      overDecl.push(
        `${label}: _oversubscribe_why states ${found.length} different arithmetic claims (${found.join("; ")}) — a rationale carrying more than one cannot notice which is current; state exactly one`,
      );
    } else if (found[0] !== expect) {
      overDecl.push(`${label}: _oversubscribe_why restates "${found[0]}" but the declared values give "${expect}" — the number moved and the sentence did not`);
    }
  }
  const overCount = subjects.filter(
    (s) => typeof s.node.oversubscribe === "number" && Number.isFinite(s.node.oversubscribe) && s.node.oversubscribe > 1,
  ).length;
  add(
    "oversubscribe-declared-and-dated",
    overDecl.length === 0,
    overDecl.length
      ? overDecl.join("; ")
      : overCount === 0
        ? "nothing declares an oversubscribe above 1.0 — nothing to check"
        : `${overCount} subject(s) above 1.0, each with a rationale, an unexpired review date, and its own arithmetic restated`,
  );

  // A RATCHET IS A PIN, NOT A CEILING. `<=` and `=` are different assertions, and the
  // gap between them is free job slots: a ceiling standing above today's worst case
  // lets that many jobs land with nothing red. Unenforced DOWNWARD too — a census
  // that SHRINKS leaves a stale-high ratchet, so an allowance earned at the old
  // number is silently retained.
  //
  // NO SLACK KEY, deliberately. A declared, dated, bounded `_ratchet_slack` would be a
  // SECOND route to the same headroom behind a WEAKER gate than the one already next
  // door. Headroom is available and always was: raise the ratio and restate its
  // arithmetic, in the diff that needs it, under `oversubscribe-declared-and-dated`.
  // That IS the reviewed act. This paragraph exists so a later session reads the
  // absence as a decision rather than an oversight.
  //
  // ONLY the upward direction is reported here; `total > ceiling` is
  // `worst-case-demand-fits`'s finding, and an arm firing on it too would make that
  // mutant's redness OVER-DETERMINED.
  const ratchetSlack = [];
  let pinned = 0;
  const ratchetDeclared = subjects.filter(
    (s) => typeof s.node.oversubscribe === "number" && Number.isFinite(s.node.oversubscribe) && s.node.oversubscribe > 1,
  ).length;
  for (const s of subjects) {
    const declaredRatio = typeof s.node.oversubscribe === "number" ? s.node.oversubscribe : 1;
    if (!(Number.isFinite(declaredRatio) && declaredRatio > 1)) continue;
    const cap = s.node.capacity;
    if (typeof cap !== "number" || !Number.isFinite(cap)) continue;
    pinned += 1;
    const ceiling = Math.floor(cap * declaredRatio);
    const slack = ceiling - s.total;
    if (slack > 0) {
      ratchetSlack.push(
        `${s.kind} ${s.id}: ratchet ceiling ${ceiling} (capacity ${cap} x ${declaredRatio}) stands ${slack} job slot(s) above the worst case ${s.total} — a ratchet is EXACTLY today's worst case, so ${slack} job(s) could land here with nothing red; re-derive oversubscribe to floor(${cap} x r) = ${s.total}, or lower it`,
      );
    }
  }
  // A DECLARED RATCHET THAT COULD NOT BE PINNED IS A FINDING, not a pass with a sad
  // sentence: reporting "UNKNOWN, not clean" in the detail while carrying `pass:true`
  // is a distinction computed and then discarded at the type boundary, so the
  // terminal prints [PASS] and CI goes green.
  if (pinned < ratchetDeclared) {
    ratchetSlack.push(
      `${ratchetDeclared - pinned} of ${ratchetDeclared} subject(s) declaring an oversubscribe above 1.0 carry no usable capacity, so no ceiling could be computed and they were NOT pinned — UNKNOWN, not clean`,
    );
  }
  add(
    "ratchet-ceiling-is-pinned-to-the-census",
    ratchetSlack.length === 0,
    ratchetSlack.length
      ? ratchetSlack.join("; ")
      : pinned === 0
        ? "nothing declares an oversubscribe above 1.0 — no ratchet exists to pin (nothing to check)"
        : `${pinned} of ${ratchetDeclared} declared ratchet(s) pinned, each with a ceiling equal to its own worst case`,
  );

  // ── the exemptions ──────────────────────────────────────────────────────────
  // A budgeted exemption must carry a rationale — an undocumented exemption is a
  // permanent excuse, a deferral whose wake-up condition nothing evaluates.
  const thin = Object.entries(decl.budgeted || {})
    .filter(([, v]) => checkDatedRationale((v || {}).why, nowIso) === "thin")
    .map(([k]) => k);
  add(
    "budgeted-carries-rationale",
    thin.length === 0,
    thin.length
      ? `${thin.length} exemption(s) with no substantive rationale: ${thin.join(", ")}`
      : `${budgeted.size} exemption(s), each with a rationale`,
  );

  // …and a review date the audit reds on. Invoking the deferral-needs-a-reader
  // principle and then omitting the date half ships every exemption permanent.
  const undated = Object.entries(decl.budgeted || {})
    .filter(([, v]) => {
      const r = checkDatedRationale((v || {}).why, nowIso);
      return r === "undated" || r === "unparseable" || (r && (r.expired || r.far));
    })
    .map(([k]) => k);
  add(
    "budgeted-review-date-unexpired",
    undated.length === 0,
    undated.length
      ? `${undated.length} exemption(s) with a missing, unreal, passed, or beyond-horizon review date: ${undated.slice(0, 4).join(", ")}`
      : budgeted.size === 0
        ? "no budgeted exemptions declared — nothing to check"
        : `${budgeted.size} exemption(s), each with a real, unexpired, in-horizon review date`,
  );

  // A budgeted entry naming a job that no longer exists is stale.
  const live = new Set(jobs.map((j) => j.key));
  const staleBudget = [...budgeted].filter((k) => !live.has(k));
  add(
    "budgeted-not-stale",
    staleBudget.length === 0,
    staleBudget.length
      ? `stale exemption(s): ${staleBudget.join(", ")}`
      : budgeted.size === 0
        ? "no budgeted exemptions declared — nothing to check"
        : `${budgeted.size} exemption(s), each naming a job that still exists`,
  );

  return { checks, jobs, perPool };
}

// ── io ────────────────────────────────────────────────────────────────────────

export function loadWorkflows(dir = WF_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => ({ file: f, src: readFileSync(path.join(dir, f), "utf8") }));
}

/**
 * The branch-protection required contexts, from the declaration.
 *
 * ANTI-VACUITY is enforced at `required-contexts-load` inside the audit rather than
 * here, so an empty set produces a NAMED FAILING CHECK rather than a throw a caller
 * might catch and treat as zero contexts.
 */
export function loadRequiredContexts(decl) {
  const raw = decl && Array.isArray(decl.required_contexts) ? decl.required_contexts : [];
  return new Set(raw.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()));
}

// ── the negative control ──────────────────────────────────────────────────────

/**
 * Every check in this engine, controlled by a case that shows it can go RED.
 *
 * A gate with no negative control is not evidence: a check that can never fail
 * reports `pass` for every input, including the ones it exists to catch. Each case
 * below asserts that a NAMED check went red on a tree built to violate exactly that
 * check — so `targeted` is populated as a SIDE EFFECT of the assertions themselves,
 * and the coverage floor at the end derives from the authority rather than from a
 * hand-written list that could drift.
 *
 * The fixture labels here are SYNTHETIC by construction (`example-pool-a`,
 * `wf-one.yml`). This engine ships to every consumer, so a fixture naming a real
 * runner label or a real workflow file would be the deployment content the whole
 * split exists to keep out.
 */
export function selftest() {
  const NOW = "2026-08-20";
  const FUTURE_REVIEW = "REVIEW BY 2026-11-16.";
  const AUTH = (n) =>
    `SYNTHETIC selftest authority naming a re-runnable command that returned capacity ${n} for this node.`;
  const fleet = (capacity, extra = {}) => ({
    capacity,
    capacity_authority: AUTH(capacity),
    capacity_verified_as_of: NOW,
    ...extra,
  });
  const pool = (labels, capacity, extra = {}) => ({
    labels,
    fleet: "example-fleet",
    capacity,
    capacity_authority: AUTH(capacity),
    capacity_verified_as_of: NOW,
    ...extra,
  });

  const base = () => ({
    fleets: { "example-fleet": fleet(2) },
    pools: { alpha: pool(["example-pool-a"], 2) },
    required_contexts: ["Req One"],
    budgeted: {},
  });

  const wf = (name, src) => ({ file: name, src });
  const OK = wf(
    "wf-one.yml",
    [
      "on:",
      "  pull_request:",
      "    branches: [main]",
      "",
      "jobs:",
      "  gate:",
      "    name: Req One",
      "    runs-on: [self-hosted, example-pool-a]",
      "    steps:",
      "      - run: true",
      "",
    ].join("\n"),
  );

  // The CLOCK IS EXPLICIT. Without it every date-bearing control silently depends on
  // the real date, passing only while today happens to be the pinned day.
  const run = (workflows, decl) =>
    audit({
      workflows,
      decl,
      requiredContexts: loadRequiredContexts(decl),
      now: NOW,
    });

  const targeted = new Set();
  const cases = [];
  // `red()` returns a VERDICT OBJECT and only `t()` registers coverage, and only when
  // the case HELD. Registering as a side effect of the CALL decouples registration
  // from assertion two ways: a bare `red(...)` with no `t()` registers a check nothing
  // asserted, and a DEAD case still registers its id — so the floor prints a green
  // line naming a check whose only control had failed.
  const red = (res, id) => {
    const c = res.checks.find((x) => x.id === id);
    return { id, ok: Boolean(c && !c.pass) };
  };
  const t = (id, verdict, detail = "") => {
    const isVerdict = verdict !== null && typeof verdict === "object" && "ok" in verdict;
    const ok = isVerdict ? verdict.ok : Boolean(verdict);
    if (ok && isVerdict && verdict.id) targeted.add(verdict.id);
    // `isVerdict` is COMPUTED and must not be DISCARDED at the push: a case built
    // from `red()` asserts a named check went RED, so it is a negative control BY
    // CONSTRUCTION and the classifier can be held to it.
    cases.push({ id, ok, detail, provablyNegative: isVerdict });
  };
  // Mutate a copy — a case that edits the shared base poisons every case after it.
  const withDecl = (mutate) => {
    const d = JSON.parse(JSON.stringify(base()));
    mutate(d);
    return d;
  };

  // ── the clean control ───────────────────────────────────────────────────────
  // If the clean tree does not pass EVERY check, "always fails" would satisfy every
  // negative case below and the whole battery would prove nothing.
  const clean = run([OK], base());
  t(
    "control-clean-tree-is-valid",
    clean.checks.every((c) => c.pass),
    clean.checks
      .filter((c) => !c.pass)
      .map((c) => `${c.id}: ${c.detail}`)
      .join(" | ") || "all pass",
  );

  // ── census ─────────────────────────────────────────────────────────────────
  const stray = wf("wf-stray.yml", OK.src.replace("name: Req One", "name: Not A Gate"));
  t("every-job-accounted-can-fail", red(run([stray], base()), "every-job-accounted"));

  // `pull_request_target` fans out on a pull request and consumes a runner exactly as
  // `pull_request` does, and is invisible to a `\bpull_request\b` pattern.
  const tgt = wf(
    "wf-target.yml",
    OK.src.replace("  pull_request:", "  pull_request_target:").replace("name: Req One", "name: Not A Gate"),
  );
  t("pull-request-target-job-is-counted", red(run([tgt], base()), "every-job-accounted"));

  // The OPPOSITE verdict, so this is not merely "any trigger counts": a workflow on a
  // trigger that CANNOT reach a pull request must stay out of the census entirely.
  const pushOnly = wf(
    "wf-push.yml",
    OK.src.replace("  pull_request:", "  push:").replace("name: Req One", "name: Not A Gate"),
  );
  t(
    "push-only-workflow-is-not-in-the-pr-census",
    run([pushOnly], base()).checks.find((c) => c.id === "every-job-accounted").pass,
  );

  const badPool = wf("wf-badpool.yml", OK.src.replace("example-pool-a", "example-unknown"));
  t("pool-resolves-can-fail", red(run([badPool], base()), "pool-resolves"));

  // A label declared by TWO pools: the DECLARATION is ambiguous and the JOB is
  // therefore unresolvable. Both arms, separated — arbitrating the ambiguity makes
  // `pool-resolves` structurally unable to fire, because it only ever sees a resolved
  // pool id.
  const ambiguous = withDecl((d) => {
    d.pools.aardvark = pool(["example-pool-a"], 2);
  });
  t("duplicate-pool-label-can-fail", red(run([OK], ambiguous), "pool-labels-are-unambiguous"));
  t("duplicate-pool-label-makes-the-job-unresolvable", red(run([OK], ambiguous), "pool-resolves"));
  t(
    "resolve-pool-refuses-to-arbitrate-a-shared-label",
    resolvePool("[self-hosted, example-pool-a]", {
      aardvark: { labels: ["example-pool-a"] },
      alpha: { labels: ["example-pool-a"] },
    }) === null,
  );
  t(
    "resolve-pool-still-resolves-an-unambiguous-label",
    resolvePool("[self-hosted, example-pool-a]", {
      alpha: { labels: ["example-pool-a"] },
      beta: { labels: ["example-pool-b"] },
    }) === "alpha",
  );

  const badLabel = withDecl((d) => {
    d.pools.alpha.labels = ["self-hosted, example-pool-a"];
  });
  t("pool-label-must-be-a-single-token", red(run([OK], badLabel), "pool-labels-are-single-tokens"));

  const noLabels = withDecl((d) => {
    d.pools.alpha.labels = [];
  });
  t("pool-with-no-labels-can-fail", red(run([OK], noLabels), "pool-labels-are-single-tokens"));

  const noPools = withDecl((d) => {
    d.pools = {};
  });
  t("empty-pool-set-can-fail", red(run([OK], noPools), "declaration-loads"));

  const noFleets = withDecl((d) => {
    d.fleets = {};
  });
  t("empty-fleet-set-can-fail", red(run([OK], noFleets), "fleets-declared"));
  t("pool-naming-a-missing-fleet-can-fail", red(run([OK], noFleets), "pool-names-a-declared-fleet"));

  const orphanFleet = withDecl((d) => {
    d.pools.alpha.fleet = "no-such-fleet";
  });
  t("pool-names-a-declared-fleet-can-fail", red(run([OK], orphanFleet), "pool-names-a-declared-fleet"));

  const noReq = withDecl((d) => {
    d.required_contexts = [];
  });
  t("empty-required-contexts-can-fail", red(run([OK], noReq), "required-contexts-load"));

  t("empty-tree-can-fail", red(run([], base()), "workflows-readable"));

  // A PR-triggered workflow yielding ZERO jobs is a PARSER failure wearing the
  // costume of an empty workflow.
  const zeroJobs = wf("wf-zero.yml", ["on:", "  pull_request:", "", "jobs:", ""].join("\n"));
  t("zero-job-workflow-can-fail", red(run([zeroJobs, OK], base()), "no-workflow-parses-to-zero-jobs"));

  const reusable = wf(
    "wf-reusable.yml",
    ["on:", "  pull_request:", "", "jobs:", "  call:", "    name: Req One", "    uses: ./.github/workflows/other.yml", ""].join("\n"),
  );
  t("reusable-workflow-callee-can-fail", red(run([reusable], base()), "no-reusable-workflow-callees"));

  const templated = wf(
    "wf-tpl.yml",
    OK.src.replace("name: Req One", "name: Build (${{ matrix.v }})"),
  );
  t("undeclared-template-named-job-can-fail", red(run([templated], base()), "template-named-jobs-declared"));
  const staleTpl = withDecl((d) => {
    d._template_named_jobs = { "wf-one.yml::gate": { why: `A synthetic stale declaration for a job that is not template-named. ${FUTURE_REVIEW}` } };
  });
  t("stale-template-declaration-can-fail", red(run([OK], staleTpl), "template-named-jobs-declared"));
  const tplThin = withDecl((d) => {
    d._template_named_jobs = { "wf-tpl.yml::gate": { why: "todo" } };
  });
  t("template-declaration-with-thin-rationale-can-fail", red(run([templated], tplThin), "template-named-jobs-declared"));

  // ── demand ─────────────────────────────────────────────────────────────────
  const many = wf(
    "wf-many.yml",
    [
      "on:",
      "  pull_request:",
      "",
      "jobs:",
      ...["a", "b", "c"].flatMap((j, i) => [
        `  j${i}:`,
        `    name: Req ${j}`,
        "    runs-on: [self-hosted, example-pool-a]",
        "    steps:",
        "      - run: true",
      ]),
    ].join("\n"),
  );
  const manyDecl = withDecl((d) => {
    d.required_contexts = ["Req a", "Req b", "Req c"];
  });
  t("required-demand-can-fail", red(run([many], manyDecl), "required-demand-fits-pool"));
  t("worst-case-demand-can-fail", red(run([many], manyDecl), "worst-case-demand-fits"));

  // A matrix job occupies one runner PER LEG. Counting blocks under-counts fan-out,
  // which is the direction that hurts.
  const matrix = wf(
    "wf-matrix.yml",
    [
      "on:",
      "  pull_request:",
      "",
      "jobs:",
      "  gate:",
      "    name: Req One",
      "    runs-on: [self-hosted, example-pool-a]",
      "    strategy:",
      "      matrix:",
      "        v: [1, 2, 3, 4]",
      "    steps:",
      "      - run: true",
      "",
    ].join("\n"),
  );
  t("matrix-legs-count-against-the-pool", red(run([matrix], base()), "worst-case-demand-fits"));
  t("matrix-legs-reads-a-block-sequence", matrixLegs("    strategy:\n      matrix:\n        v:\n          - 1\n          - 2\n") === 2);
  t("matrix-legs-reads-a-flow-strategy", matrixLegs("    strategy: { matrix: { v: [1, 2, 3] } }\n") === 3);
  t("matrix-legs-merges-a-matching-include", matrixLegs("    strategy:\n      matrix:\n        v: [\"3\"]\n        include:\n          - v: \"3\"\n            extra: y\n") === 1);
  t("matrix-legs-adds-a-non-matching-include", matrixLegs("    strategy:\n      matrix:\n        v: [\"3\"]\n        include:\n          - v: \"4\"\n") === 2);
  t("matrix-legs-removes-an-exclude", matrixLegs("    strategy:\n      matrix:\n        v: [1, 2]\n        exclude:\n          - v: 1\n") === 1);
  t("matrix-legs-defaults-to-one", matrixLegs("    name: x\n") === 1);

  // ── the fleet bounds ───────────────────────────────────────────────────────
  const oversizedPool = withDecl((d) => {
    d.pools.alpha.capacity = 99;
    d.pools.alpha.capacity_authority = AUTH(99);
  });
  t("pool-larger-than-its-fleet-can-fail", red(run([OK], oversizedPool), "capacity-within-the-fleet"));

  // THE SUM. Each pool fits the fleet individually while the fleet is oversold —
  // exactly the slack a per-pool ceiling leaves open, and the bound the source
  // contract tracked as an open gap because nothing added the pools up.
  const oversoldFleet = withDecl((d) => {
    d.pools.beta = pool(["example-pool-b"], 2);
  });
  t("non-overlay-capacities-summing-past-the-fleet-can-fail", red(run([OK], oversoldFleet), "non-overlay-capacities-sum-within-the-fleet"));
  // …and the OPPOSITE verdict: an OVERLAY pool is excluded from the sum, so the same
  // capacities pass when the sibling is declared `union: true`. Without this the case
  // above would also be satisfied by a sum that counts everything unconditionally.
  const overlayOk = withDecl((d) => {
    d.pools.beta = pool(["example-pool-b"], 2, {
      union: true,
      _union_why: `A synthetic overlay label carried by the same runners alpha already counts, so it must not be summed with them. ${FUTURE_REVIEW}`,
    });
  });
  t(
    "overlay-pool-is-excluded-from-the-sum",
    run([OK], overlayOk).checks.find((c) => c.id === "non-overlay-capacities-sum-within-the-fleet").pass,
  );
  const unionUndeclared = withDecl((d) => {
    d.pools.beta = pool(["example-pool-b"], 2, { union: true });
  });
  t("union-without-a-dated-why-can-fail", red(run([OK], unionUndeclared), "union-exemption-declared-and-dated"));
  const unionExpired = withDecl((d) => {
    d.pools.beta = pool(["example-pool-b"], 2, {
      union: true,
      _union_why: "A synthetic overlay rationale whose review date has already passed and must therefore red. REVIEW BY 2020-01-01.",
    });
  });
  t("expired-union-review-date-can-fail", red(run([OK], unionExpired), "union-exemption-declared-and-dated"));

  // ── freshness: the fail-closed capacity contract ───────────────────────────
  const noCapacity = withDecl((d) => {
    delete d.pools.alpha.capacity;
  });
  t("missing-capacity-can-fail", red(run([OK], noCapacity), "capacity-is-fresh"));

  const stringCapacity = withDecl((d) => {
    d.pools.alpha.capacity = "2";
  });
  t("wrong-typed-capacity-can-fail", red(run([OK], stringCapacity), "capacity-is-fresh"));

  const infCapacity = withDecl((d) => {
    d.pools.alpha.capacity = Infinity;
  });
  t("non-finite-capacity-can-fail", red(run([OK], infCapacity), "capacity-is-fresh"));

  const zeroCapacity = withDecl((d) => {
    d.pools.alpha.capacity = 0;
    d.pools.alpha.capacity_authority = AUTH(0);
  });
  t("non-positive-capacity-can-fail", red(run([OK], zeroCapacity), "capacity-is-fresh"));

  const noAuthority = withDecl((d) => {
    delete d.pools.alpha.capacity_authority;
  });
  t("capacity-without-an-authority-can-fail", red(run([OK], noAuthority), "capacity-is-fresh"));

  // The authority must RESTATE the number. A dated sentence proves someone wrote a
  // sentence; it proves nothing about the value.
  const authorityDoesNotRestate = withDecl((d) => {
    d.pools.alpha.capacity_authority = "A synthetic authority sentence of ample length that never names the number it is supposed to justify.";
  });
  t("authority-that-does-not-restate-its-number-can-fail", red(run([OK], authorityDoesNotRestate), "capacity-is-fresh"));

  const authorityRestatesTheWrongNumber = withDecl((d) => {
    d.pools.alpha.capacity_authority = AUTH(99);
  });
  t("authority-restating-the-wrong-number-can-fail", red(run([OK], authorityRestatesTheWrongNumber), "capacity-is-fresh"));

  // Pre-loading a future value disarms the check in advance, with nothing red at
  // either point — so exactly one restatement is required.
  const authorityRestatesTwo = withDecl((d) => {
    d.pools.alpha.capacity_authority = `${AUTH(2)} A second reading also recorded capacity 99 for the same node.`;
  });
  t("authority-restating-two-numbers-can-fail", red(run([OK], authorityRestatesTwo), "capacity-is-fresh"));

  // A DATE must not be able to carry the restatement, and a sentence-ending period
  // must not break it — a gate that is strict by being broken pushes an author to
  // reword a correct sentence.
  t(
    "a-date-cannot-carry-the-restatement",
    restatementFindings({ why: "measured capacity 2026-11-16 by hand", noun: "capacity", value: 2026, label: "x" }) !== null,
  );
  t(
    "a-sentence-ending-period-does-not-break-the-restatement",
    restatementFindings({ why: "the command returned capacity 12.", noun: "capacity", value: 12, label: "x" }) === null,
  );
  t(
    "a-prefix-cannot-satisfy-a-shorter-number",
    restatementFindings({ why: "the command returned capacity 16.", noun: "capacity", value: 1, label: "x" }) !== null,
  );

  const noDate = withDecl((d) => {
    delete d.pools.alpha.capacity_verified_as_of;
  });
  t("capacity-without-a-date-can-fail", red(run([OK], noDate), "capacity-is-fresh"));

  const unrealDate = withDecl((d) => {
    d.pools.alpha.capacity_verified_as_of = "2026-02-31";
  });
  t("unreal-capacity-date-can-fail", red(run([OK], unrealDate), "capacity-is-fresh"));

  // A FUTURE receipt yields a NEGATIVE age, which is under every window forever —
  // a permanent receipt. Neither the missing-date arm nor the too-old arm sees it.
  const futureDate = withDecl((d) => {
    d.pools.alpha.capacity_verified_as_of = "2099-01-01";
  });
  t("future-capacity-date-can-fail", red(run([OK], futureDate), "capacity-is-fresh"));

  // THE ROOT-CAUSE ARM. A stale capacity FAILS CLOSED, offline, with no credential.
  const staleDate = withDecl((d) => {
    d.pools.alpha.capacity_verified_as_of = "2020-01-01";
  });
  t("stale-capacity-fails-closed", red(run([OK], staleDate), "capacity-is-fresh"));

  // …and the window is CLAMPED, so a deployment cannot make a stale ceiling fresh by
  // raising its own key. This is the disarm the clamp exists to refuse.
  const raisedWindow = withDecl((d) => {
    d.pools.alpha.capacity_verified_as_of = "2020-01-01";
    d.capacity_max_age_days = 100000;
  });
  t("raising-the-window-cannot-launder-a-stale-capacity", red(run([OK], raisedWindow), "capacity-is-fresh"));
  t("effective-window-is-clamped-downward", effectiveMaxAgeDays({ capacity_max_age_days: 100000 }) === CAPACITY_MAX_AGE_HARD_CEILING_DAYS);
  t("effective-window-honours-a-tightening", effectiveMaxAgeDays({ capacity_max_age_days: 7 }) === 7);
  t("effective-window-defaults-to-the-hard-ceiling", effectiveMaxAgeDays({}) === CAPACITY_MAX_AGE_HARD_CEILING_DAYS);

  // The FLEET is held to the same contract as a pool — an exemption for the node
  // every pool is bounded by would delete the bound for all of them at once.
  const staleFleet = withDecl((d) => {
    d.fleets["example-fleet"].capacity_verified_as_of = "2020-01-01";
  });
  t("stale-fleet-capacity-fails-closed", red(run([OK], staleFleet), "capacity-is-fresh"));

  // ── the ratchets ───────────────────────────────────────────────────────────
  const ratchetBase = () =>
    withDecl((d) => {
      d.fleets["example-fleet"] = fleet(4, {
        oversubscribe: 2,
        _oversubscribe_why: `A synthetic fleet ratchet pinned to today's census: floor(4 x 2) = 8 exactly. ${FUTURE_REVIEW}`,
      });
      d.pools.alpha = pool(["example-pool-a"], 4, {
        oversubscribe: 2,
        _oversubscribe_why: `A synthetic pool ratchet pinned to today's census: floor(4 x 2) = 8 exactly. ${FUTURE_REVIEW}`,
      });
    });
  // The eight jobs are RELEVANCE-GATED, not required. `required-demand-fits-pool`
  // holds required jobs to PHYSICAL capacity — an oversubscribe allowance cannot
  // apply to jobs that can never be skipped — so a required fixture would red there
  // and the ratchet arms under test would never be reached.
  const eightJobs = wf(
    "wf-eight.yml",
    [
      "on:",
      "  pull_request:",
      "",
      "jobs:",
      ...["a", "b", "c", "d", "e", "f", "g", "h"].flatMap((j, i) => [
        `  j${i}:`,
        `    name: Gated ${j}`,
        "    if: needs.detect.outputs.relevant == 'true'",
        "    runs-on: [self-hosted, example-pool-a]",
        "    steps:",
        "      - run: true",
      ]),
    ].join("\n"),
  );
  // The clean ratchet control: pinned EXACTLY, so both ratchet checks pass.
  const pinnedRun = run([eightJobs], ratchetBase());
  t(
    "control-a-pinned-ratchet-passes",
    pinnedRun.checks.every((c) => c.pass),
    pinnedRun.checks
      .filter((c) => !c.pass)
      .map((c) => `${c.id}: ${c.detail}`)
      .join(" | ") || "all pass",
  );

  const thinRatchet = (() => {
    const d = ratchetBase();
    d.pools.alpha._oversubscribe_why = "todo";
    return d;
  })();
  t("oversubscribe-with-a-thin-rationale-can-fail", red(run([eightJobs], thinRatchet), "oversubscribe-declared-and-dated"));

  const undatedRatchet = (() => {
    const d = ratchetBase();
    d.pools.alpha._oversubscribe_why = "A synthetic ratchet rationale of ample length that carries floor(4 x 2) = 8 but no review date at all.";
    return d;
  })();
  t("oversubscribe-with-no-review-date-can-fail", red(run([eightJobs], undatedRatchet), "oversubscribe-declared-and-dated"));

  const expiredRatchet = (() => {
    const d = ratchetBase();
    d.pools.alpha._oversubscribe_why = "A synthetic ratchet rationale carrying floor(4 x 2) = 8 whose review date has passed. REVIEW BY 2020-01-01.";
    return d;
  })();
  t("expired-oversubscribe-review-date-can-fail", red(run([eightJobs], expiredRatchet), "oversubscribe-declared-and-dated"));

  const farRatchet = (() => {
    const d = ratchetBase();
    d.pools.alpha._oversubscribe_why = "A synthetic ratchet rationale carrying floor(4 x 2) = 8 whose review date is far beyond the horizon. REVIEW BY 2099-01-01.";
    return d;
  })();
  t("beyond-horizon-oversubscribe-review-date-can-fail", red(run([eightJobs], farRatchet), "oversubscribe-declared-and-dated"));

  // THE ARITHMETIC RESTATEMENT. Moving the ratio is one token and needs no other
  // edit, so without this the shipped rationale keeps asserting the old ceiling.
  const movedRatio = (() => {
    const d = ratchetBase();
    d.pools.alpha.oversubscribe = 4;
    return d;
  })();
  t("moving-the-ratio-without-restating-it-can-fail", red(run([eightJobs], movedRatio), "oversubscribe-declared-and-dated"));

  const twoArithmetics = (() => {
    const d = ratchetBase();
    d.pools.alpha._oversubscribe_why = `Pre-loading tomorrow's value: floor(4 x 2) = 8 today and floor(4 x 4) = 16 later. ${FUTURE_REVIEW}`;
    return d;
  })();
  t("pre-loading-a-second-arithmetic-claim-can-fail", red(run([eightJobs], twoArithmetics), "oversubscribe-declared-and-dated"));

  const nonFiniteRatio = (() => {
    const d = ratchetBase();
    d.pools.alpha.oversubscribe = Infinity;
    return d;
  })();
  t("non-finite-oversubscribe-can-fail", red(run([eightJobs], nonFiniteRatio), "worst-case-demand-fits"));

  // A RATCHET IS A PIN. A ceiling standing above today's worst case is free job slots
  // nothing reds on — enforced in BOTH directions, so a shrinking census also reds.
  const slackRatchet = (() => {
    const d = ratchetBase();
    d.pools.alpha.oversubscribe = 3;
    d.pools.alpha._oversubscribe_why = `A synthetic ratchet standing above today's census: floor(4 x 3) = 12. ${FUTURE_REVIEW}`;
    d.fleets["example-fleet"].oversubscribe = 3;
    d.fleets["example-fleet"]._oversubscribe_why = `A synthetic fleet ratchet standing above today's census: floor(4 x 3) = 12. ${FUTURE_REVIEW}`;
    return d;
  })();
  t("ratchet-slack-can-fail", red(run([eightJobs], slackRatchet), "ratchet-ceiling-is-pinned-to-the-census"));

  // A ratchet declared on a subject with no usable capacity could not be PINNED, and
  // an unpinnable ratchet is UNKNOWN, not clean.
  const unpinnable = (() => {
    const d = ratchetBase();
    delete d.pools.alpha.capacity;
    return d;
  })();
  t("unpinnable-ratchet-can-fail", red(run([eightJobs], unpinnable), "ratchet-ceiling-is-pinned-to-the-census"));

  // THE FLEET-LEVEL DEMAND RATCHET. A job moved to an unratcheted sibling pool costs
  // the same physical capacity, so bounding each pool while nothing bounds the total
  // leaves the fleet contended for by the sum of every pool's ratchet.
  const fleetOversold = (() => {
    const d = ratchetBase();
    // A second pool on the SAME fleet, itself within its own ceiling, taking the
    // fleet's total demand past the fleet ratchet.
    d.pools.beta = pool(["example-pool-b"], 4, {
      union: true,
      _union_why: `A synthetic overlay so the capacity SUM is not what reds here — the DEMAND ratchet is. ${FUTURE_REVIEW}`,
    });
    return d;
  })();
  const eightPlusOne = wf(
    "wf-beta.yml",
    [
      "on:",
      "  pull_request:",
      "",
      "jobs:",
      "  b0:",
      "    name: Gated z",
      "    if: needs.detect.outputs.relevant == 'true'",
      "    runs-on: [self-hosted, example-pool-b]",
      "    steps:",
      "      - run: true",
      "",
    ].join("\n"),
  );
  const fleetDemandRun = run([eightJobs, eightPlusOne], fleetOversold);
  t("fleet-demand-ratchet-can-fail", {
    id: "worst-case-demand-fits",
    ok: !fleetDemandRun.checks.find((c) => c.id === "worst-case-demand-fits").pass,
  });

  // ── the exemptions ─────────────────────────────────────────────────────────
  const thinBudget = withDecl((d) => {
    d.budgeted = { "wf-stray.yml::gate": { why: "todo" } };
  });
  t("budgeted-rationale-can-fail", red(run([stray], thinBudget), "budgeted-carries-rationale"));

  const undatedBudget = withDecl((d) => {
    d.budgeted = { "wf-stray.yml::gate": { why: "A synthetic exemption rationale of ample length that carries no review date whatsoever." } };
  });
  t("budgeted-review-date-can-fail", red(run([stray], undatedBudget), "budgeted-review-date-unexpired"));

  const expiredBudget = withDecl((d) => {
    d.budgeted = { "wf-stray.yml::gate": { why: "A synthetic exemption rationale whose review date has already passed. REVIEW BY 2020-01-01." } };
  });
  t("expired-budgeted-review-date-can-fail", red(run([stray], expiredBudget), "budgeted-review-date-unexpired"));

  const farBudget = withDecl((d) => {
    d.budgeted = { "wf-stray.yml::gate": { why: "A synthetic exemption rationale whose review date is beyond the horizon. REVIEW BY 2099-01-01." } };
  });
  t("beyond-horizon-budgeted-review-date-can-fail", red(run([stray], farBudget), "budgeted-review-date-unexpired"));

  const staleBudget = withDecl((d) => {
    d.budgeted = { "wf-gone.yml::vanished": { why: `A synthetic exemption naming a job that does not exist. ${FUTURE_REVIEW}` } };
  });
  t("budgeted-stale-can-fail", red(run([OK], staleBudget), "budgeted-not-stale"));

  // …and the OPPOSITE verdict: a WELL-FORMED exemption clears every budget arm, so
  // the four cases above are not satisfied by an exemption path that always reds.
  const goodBudget = withDecl((d) => {
    d.budgeted = { "wf-stray.yml::gate": { why: `A synthetic exemption that runs per pull request, gates nothing, and is nevertheless kept for a stated reason. ${FUTURE_REVIEW}` } };
  });
  const goodBudgetRun = run([stray], goodBudget);
  t(
    "control-a-well-formed-exemption-passes-every-budget-arm",
    ["budgeted-carries-rationale", "budgeted-review-date-unexpired", "budgeted-not-stale", "every-job-accounted"].every(
      (id) => goodBudgetRun.checks.find((c) => c.id === id).pass,
    ),
  );

  // ── the parsers, directly ──────────────────────────────────────────────────
  // Each parser gets an input of its own, because a conjunct guarding a condition the
  // fixture tree does not exhibit is INERT and survives every end-to-end case.
  t("quoted-on-key-is-read", triggersOnPullRequest('"on":\n  pull_request:\n    branches: [main]\n') === true);
  t("flow-sequence-on-is-read", triggersOnPullRequest("on: [push, pull_request]\n") === true);
  t("push-only-on-is-not-a-pr-trigger", triggersOnPullRequest("on:\n  push:\n    branches: [main]\n") === false);
  t("four-space-on-block-is-read", triggersOnPullRequest("on:\n    pull_request:\n        branches: [main]\n") === true);
  t(
    "paths-filter-is-read-from-the-pull-request-block-only",
    workflowHasPathsFilter("on:\n  push:\n    paths: ['src/**']\n  pull_request:\n    branches: [main]\n") === false,
  );
  t("paths-filter-is-read-when-present", workflowHasPathsFilter("on:\n  pull_request:\n    paths: ['src/**']\n") === true);
  t("paths-ignore-is-not-a-paths-filter", workflowHasPathsFilter("on:\n  pull_request:\n    paths-ignore: ['**/*.md']\n") === false);
  t("job-key-with-a-trailing-comment-is-counted", jobBlocks("\njobs:\n  build:  # nightly only\n    name: X\n").length === 1);
  t("job-name-strips-a-trailing-comment", jobName("    name: Req One # the gate\n") === "Req One");
  t("runs-on-mapping-form-reads-labels", jobRunsOn("    runs-on:\n      group: g\n      labels: [example-pool-a]\n") === "[example-pool-a]");
  t("block-scalar-if-is-read-whole", jobIf("    if: |\n      github.event_name == 'push'\n") === "github.event_name == 'push'");
  t("negated-pull-request-pin-is-excluded", isEventExcludedFromPr("github.event_name != 'pull_request'") === true);
  t("negated-push-pin-is-not-excluded", isEventExcludedFromPr("!(github.event_name == 'push')") === false);
  t("push-pin-is-excluded", isEventExcludedFromPr("github.event_name == 'push'") === true);
  t("merge-group-pin-is-not-excluded", isEventExcludedFromPr("github.event_name == 'merge_group'") === false);
  t("pull-request-target-pin-is-not-excluded", isEventExcludedFromPr("github.event_name == 'pull_request_target'") === false);
  t(
    "top-level-or-defeats-the-exclusion",
    isEventExcludedFromPr("github.event_name == 'push' || github.event.pull_request.draft == false") === false,
  );
  t(
    "all-pins-disjunction-still-excludes",
    isEventExcludedFromPr("github.event_name == 'push' || github.event_name == 'schedule'") === true,
  );
  t("needs-scalar-form-is-read", jobNeeds("    needs: build\n").join(",") === "build");
  t("needs-flow-form-is-read", jobNeeds("    needs: [a, b]\n").join(",") === "a,b");
  t("needs-block-form-is-read", jobNeeds("    needs:\n      - a\n      - b\n").join(",") === "a,b");
  t("relevance-skip-is-recognised", hasRelevanceSkip("needs.detect.outputs.relevant == 'true'") === true);
  t("inverted-relevance-skip-is-refused", hasRelevanceSkip("needs.detect.outputs.relevant == 'false'") === true ? { id: "x", ok: false } : true);
  t("top-level-or-defeats-a-relevance-skip", hasRelevanceSkip("success() || needs.detect.outputs.relevant == 'true'") === false);
  t("a-paren-in-a-string-does-not-hide-a-top-level-or", hasTopLevelOr("contains(x, 'wip(') || y") === true);
  t("a-grouped-or-is-not-top-level", hasTopLevelOr("(a || b) && c") === false);
  t("real-iso-date-round-trips", isRealIsoDate("2026-08-20") === true);
  t("rolled-date-is-refused", isRealIsoDate("2026-02-31") === false);

  // TRANSITIVE needs propagation: a job depending on an event-excluded job is itself
  // unreachable, and a chain must be removed to a FIXPOINT.
  const chain = wf(
    "wf-chain.yml",
    [
      "on:",
      "  pull_request:",
      "",
      "jobs:",
      "  a:",
      "    name: Not A Gate A",
      "    if: github.event_name == 'push'",
      "    runs-on: [self-hosted, example-pool-a]",
      "    steps:",
      "      - run: true",
      "  b:",
      "    name: Not A Gate B",
      "    needs: a",
      "    runs-on: [self-hosted, example-pool-a]",
      "    steps:",
      "      - run: true",
      "  c:",
      "    name: Not A Gate C",
      "    needs: b",
      "    runs-on: [self-hosted, example-pool-a]",
      "    steps:",
      "      - run: true",
      "",
    ].join("\n"),
  );
  const chainRun = run([chain, OK], base());
  t(
    "transitive-needs-exclusion-reaches-a-fixpoint",
    chainRun.checks.find((c) => c.id === "every-job-accounted").pass &&
      chainRun.checks.find((c) => c.id === "workflows-readable").detail.includes("3 excluded"),
    chainRun.checks.find((c) => c.id === "workflows-readable").detail,
  );

  // ── the coverage floor ─────────────────────────────────────────────────────
  // Derived from THIS RUN's emitted check ids, not from a hand-written list: a check
  // added next door would be invisible to a list, and NOTHING would go red, so the
  // floor would certify a scope it does not cover.
  const allIds = [...new Set(clean.checks.map((c) => c.id))];
  const uncovered = allIds.filter((id) => !targeted.has(id));
  t(
    "every-check-has-a-negative-control",
    uncovered.length === 0,
    uncovered.length ? `uncovered: ${uncovered.join(", ")}` : `${allIds.length} check(s), each with a case that shows it can go RED`,
  );
  // …and the reverse: a case naming a check this engine does not emit is a phantom.
  const phantom = [...targeted].filter((id) => !allIds.includes(id));
  t(
    "no-negative-control-names-a-phantom-check",
    phantom.length === 0,
    phantom.length ? `phantom: ${phantom.join(", ")}` : `${targeted.size} targeted id(s), each emitted by the audit`,
  );

  const negatives = cases.filter((c) => c.provablyNegative).length;
  return { cases, negatives, accepting: cases.length - negatives };
}

// ── the OPTIONAL reconciliation ───────────────────────────────────────────────

/**
 * Reconcile the declared NUMBERS against a live reading, for an operator who holds a
 * credential.
 *
 * OPTIONAL BY CONSTRUCTION, and this is the point. Correctness does NOT depend on it:
 * `capacity-is-fresh` enforces the freshness contract offline and fails CLOSED, so
 * the audit is sound with this function never running. Making reconciliation the gate
 * is what leaves a declared number with no reader at all — an obligation parked
 * behind an instrument that needs a credential no CI secret carries, so it never runs
 * and the number goes stale silently and forever.
 *
 * Takes a PARSED reading rather than fetching one: an instrument that fetches its own
 * basis cannot be shown the basis it fails on, so it could never be given a control.
 * The caller supplies `{ labels: { "<label>": <count> } }` — whatever produced it.
 *
 * Returns `{ arms, findings }`. An unreadable reading is a FINDING, never an
 * all-clear: absence of a reading is not evidence of agreement.
 */
export function verifyCapacity({ decl, reading }) {
  const findings = [];
  const arms = [];
  const flag = (arm, detail) => {
    arms.push(arm);
    findings.push(`${arm}: ${detail}`);
  };
  if (!reading || typeof reading !== "object" || typeof reading.labels !== "object" || reading.labels === null) {
    flag("reading-unreadable", "the supplied reading has no `labels` map, so NOTHING was reconciled — UNKNOWN, not agreeing");
    return { arms, findings };
  }
  const labels = reading.labels;
  const pools = decl.pools || {};
  if (Object.keys(pools).length === 0) {
    flag("no-pools-to-reconcile", "the declaration declares no pools, so this reconciliation had no subjects");
    return { arms, findings };
  }
  for (const [pid, p] of Object.entries(pools)) {
    for (const label of p.labels || []) {
      const key = String(label);
      if (!Object.prototype.hasOwnProperty.call(labels, key)) {
        flag("label-absent-from-the-reading", `pool ${pid} declares label ${JSON.stringify(key)}, which the reading does not mention — its capacity is unreconciled, not confirmed`);
        continue;
      }
      const live = labels[key];
      if (typeof live !== "number" || !Number.isFinite(live)) {
        flag("label-count-unreadable", `pool ${pid} label ${JSON.stringify(key)} reads ${JSON.stringify(live)} in the reading, which is not a finite number`);
        continue;
      }
      if (typeof p.capacity === "number" && p.capacity !== live) {
        flag("declared-capacity-disagrees-with-the-reading", `pool ${pid} declares capacity ${p.capacity} for label ${JSON.stringify(key)} but the reading shows ${live}`);
      }
    }
  }
  return { arms, findings };
}

// ── cli ───────────────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2)) {
  const wantJson = argv.includes("--json");

  if (argv.includes("--selftest")) {
    const { cases, negatives, accepting } = selftest();
    const failed = cases.filter((c) => !c.ok);
    if (wantJson) {
      process.stdout.write(`${JSON.stringify({ cases, negatives, accepting, failed: failed.length }, null, 2)}\n`);
    } else {
      for (const c of cases) {
        process.stdout.write(`${c.ok ? "[ok]  " : "[FAIL]"} ${c.id}${c.detail ? ` — ${c.detail}` : ""}\n`);
      }
      process.stdout.write(
        `\n${failed.length ? "SELFTEST FAILED" : "SELFTEST OK"}: ${cases.length} case(s): ${negatives} negative + ${accepting} accepting; ${failed.length} failing\n`,
      );
    }
    return failed.length ? 1 : 0;
  }

  const { path: declPath, error: resolveError } = resolveDeclarationPath();
  if (resolveError) {
    process.stderr.write(`${resolveError}\n`);
    return 2; // UNKNOWN — never green
  }
  const { decl, error: loadError } = loadDeclaration(declPath);
  if (loadError) {
    process.stderr.write(`${loadError}\n`);
    return 2;
  }

  const verifyAt = argv.indexOf("--verify-capacity");
  if (verifyAt !== -1) {
    const readingPath = argv[verifyAt + 1];
    if (!readingPath) {
      process.stderr.write("--verify-capacity needs a path to a JSON reading, e.g. {\"labels\": {\"<label>\": 8}}\n");
      return 2;
    }
    let reading = null;
    try {
      reading = JSON.parse(readFileSync(readingPath, "utf8"));
    } catch (e) {
      process.stderr.write(`could not read the reading at ${readingPath}: ${e.message}\n`);
      return 2;
    }
    const { arms, findings } = verifyCapacity({ decl, reading });
    if (wantJson) {
      process.stdout.write(`${JSON.stringify({ arms, findings }, null, 2)}\n`);
    } else {
      for (const f of findings) process.stdout.write(`[FINDING] ${f}\n`);
      process.stdout.write(
        `\n${findings.length ? "RECONCILIATION FINDINGS" : "RECONCILED"}: ${findings.length} finding(s). This is an OPTIONAL reconciliation of the NUMBER; the freshness contract is enforced offline by the audit and does not depend on it.\n`,
      );
    }
    return findings.length ? 1 : 0;
  }

  const workflows = loadWorkflows();
  const requiredContexts = loadRequiredContexts(decl);
  const { checks, jobs, perPool } = audit({ workflows, decl, requiredContexts });
  const failed = checks.filter((c) => !c.pass);

  if (wantJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          declaration: declPath,
          verdict: failed.length ? "INVALID" : "VALID",
          checks,
          perPool,
          jobs: jobs.map((j) => ({ key: j.key, name: j.name, pool: j.pool, legs: j.legs, required: j.required, gated: j.gated, budgeted: j.budgeted })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`declaration: ${declPath}\n\n`);
    for (const c of checks) {
      process.stdout.write(`${c.pass ? "[PASS]" : "[FAIL]"} ${c.id} — ${c.detail}\n`);
    }
    process.stdout.write(
      `\n${failed.length ? "INVALID" : "VALID"} (${checks.length - failed.length}/${checks.length})\n`,
    );
  }
  return failed.length ? 1 : 0;
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) process.exit(main());
