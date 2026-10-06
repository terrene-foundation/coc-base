"use strict";
/**
 * CI runner-saturation predicate — "will this push queue behind a full pool?"
 *
 * THE PROCEDURE THIS BACKS (co-owner-directed, receipt loom#2016):
 *   1. check whether the LOCAL (self-hosted) runners are saturated
 *   2. if they are, ask for approval — or honour a session-level blanket — to
 *      use GitHub-hosted runners
 *   3. proceed on yes; otherwise queue to local
 *
 * WHY A PREDICATE MODULE AND NOT A HOOK BODY. Everything here is pure or
 * explicitly injected, so the fixtures exercise every branch with no network,
 * no repo, and no clock. The hook is the thin edge that reads the payload and
 * emits; this decides.
 *
 * FAIL-OPEN IS THE WHOLE DISPOSITION, and it is not a default reached for
 * casually. This guard sits at `PreToolUse:Bash` on the most common command in
 * the corpus. Every unknown — no `gh`, no network, a rate-limited API, an
 * unparseable body, a repo with no self-hosted runners at all — resolves to
 * "say nothing and let the push proceed". A CI-cost advisory that can wedge a
 * push is worse than the queueing it prevents, and a cascading capability that
 * costs anything on the repos it does not apply to is a tax on all of them.
 *
 * WHAT THIS IS NOT: it is not a claim about whether CI will PASS, nor about
 * cost. It answers exactly one question — is the local pool full right now —
 * and every consumer of that answer is a human decision.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Hard ceiling on the runner probe. A hook must never hold a push open. */
const PROBE_TIMEOUT_MS = 2500;

/** Receipt surface, mirroring `.claude/wip-authz/` and `.claude/cross-repo-authz/`. */
const CI_AUTHZ_REL = path.join(".claude", "ci-authz");
const BLANKET_FILE = "github-hosted-allow";

/**
 * Ceiling on an un-dated blanket, measured from the file's own mtime.
 *
 * Operator-specified shape: "Session + expiry, gate only". A session is the unit
 * the operator actually reasons about, but no session id reaches a PreToolUse
 * payload reliably, so wall-clock is the honest proxy — deliberately generous
 * enough to cover a long working session and deliberately far short of a day, so
 * a grant cannot quietly become policy. An explicit `expires:` always wins.
 */
const DEFAULT_BLANKET_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Labels that denote an operator-run pool. A repo whose workflows name none of
 * these has nothing to be saturated and the guard is inert there — which is the
 * common case for every downstream consumer.
 */
const SELF_HOSTED_MARKER = "self-hosted";

/**
 * Does this command trigger CI?
 *
 * NOT lexical, and an earlier version of this comment claiming it was is
 * WITHDRAWN. This consumes `parseGitInvocations` + `stripShellGroupDelimiters`
 * — the PARSED-signal reference `hook-output-discipline.md` MUST-5 names as
 * fencing-grade — so it is precisely NOT the shape MUST-2 caps. Using a parser
 * here is deliberate: a regex over the joined string cannot see the grammar, and
 * `(git push)` or `echo "git push"` would each fool it in opposite directions.
 *
 * What this CANNOT decide, by any parser, is whether the pushed ref actually has
 * workflows attached — that is one of the three grounds capping the guard's
 * severity (see the header of ../ci-runner-saturation-guard.js for all three).
 * It selects the QUESTION; the runner API supplies the ANSWER.
 *
 * Deliberately narrow: only a push. A commit triggers nothing, and a `--dry-run`
 * push contacts the remote but starts no workflow.
 */
function triggersCi(command) {
  if (typeof command !== "string" || !command.trim()) return false;
  let invocations;
  try {
    const {
      parseGitInvocations,
      stripShellGroupDelimiters,
    } = require("./git-command-parse.js");
    invocations = parseGitInvocations(stripShellGroupDelimiters(command));
  } catch {
    return false; // unknown ⇒ silent, per the fail-open disposition above
  }
  if (!Array.isArray(invocations)) return false;
  for (const inv of invocations) {
    if (!inv || inv.unresolvable || inv.sub !== "push") continue;
    const argv = Array.isArray(inv.argv)
      ? inv.argv.filter((a) => typeof a === "string")
      : [];
    // `--dry-run` reaches the remote but starts no workflow run.
    if (argv.some((a) => a === "--dry-run" || a === "-n")) continue;
    return true;
  }
  return false;
}

/**
 * Read the session-level blanket, if the operator granted one.
 *
 * Returns `{granted:boolean, reason:string|null}`. A blanket is a FILE whose
 * body is the operator's stated reason — an empty file is NOT a grant, the same
 * rule `.claude/wip-authz/` uses, so an accidental `touch` cannot authorize.
 */
function readBlanket(repoDir, now) {
  const at = typeof now === "number" ? now : Date.now();
  try {
    const p = path.join(repoDir, CI_AUTHZ_REL, BLANKET_FILE);
    const raw = fs.readFileSync(p, "utf8");
    const body = raw.trim();
    if (!body) return { granted: false, reason: null, basis: "empty-file" };

    // EXPIRY IS MANDATORY IN EFFECT, never in syntax. An operator writing a
    // one-line reason under time pressure should not have their grant silently
    // refused for missing a field — so an absent `expires:` falls back to a
    // BOUNDED default from the file's own mtime rather than to "forever".
    // The one thing that must not exist is an UNBOUNDED grant: a blanket with no
    // end date is indistinguishable, later, from a standing policy nobody agreed to.
    //
    // BOUNDED IS THE CONTRACT — NOT SHORT. An explicit `expires:` is honoured at
    // whatever date it names, with no ceiling, and that is deliberate: a long grant
    // an operator WROTE and DATED is a decision on the record, which is the property
    // this doctrine actually protects. The 8h mtime fallback exists for the case
    // where nobody stated a bound at all, not as a maximum.
    //
    // An earlier revision of this comment said "outlives the session it was reasoned
    // about", which a review correctly read as forbidding the multi-month standing
    // grant this repo actually ships. That phrasing described a SHORTNESS rule the
    // code has never implemented. Corrected rather than left to be quoted forward as
    // though the code were in breach of itself.
    //
    // What is genuinely BLOCKED is a grant with no `expires:` and no mtime — i.e. no
    // derivable end at all. `readBlanket` fails CLOSED on that (`mtime-unreadable`).
    // CAPTURE LOOSELY, ADJUDICATE WITH `Date.parse`. This read `(\S+)` anchored
    // by `\s*$` until 2026-08-29, which meant any expiry value CONTAINING
    // WHITESPACE did not match the regex AT ALL — and a non-match falls to the
    // `else` branch, which GRANTS for 8h from mtime. So the two most ordinary
    // mistypings an operator makes were the two that failed OPEN:
    //   expires: 2026-08-30 06:00:00Z                  (space instead of `T`)
    //   expires: 2026-08-30T06:00:00Z  # end of session (trailing comment)
    // Both now reach `Date.parse`, which is the ONLY thing entitled to decide
    // whether a value is a date: the first parses (the operator DID bound the
    // grant, at the time they meant) and the second is NaN (fail-CLOSED, below).
    // `[ \t]` rather than `\s` on both sides so a greedy `\s*` cannot step over
    // the newline and capture the NEXT line's text as this line's value; `(.*?)`
    // rather than `(.+?)` so a bare `expires:` captures "" and Date.parse NaNs it
    // shut, instead of silently missing the match and taking the 8h default.
    const m = body.match(/^[ \t]*expires:[ \t]*(.*?)[ \t]*$/im);
    let expiresAt = null;
    let basis = null;
    if (m) {
      const t = Date.parse(m[1]);
      // UNPARSEABLE is fail-CLOSED: an operator who tried to bound the grant
      // and mistyped it must not get an unbounded one.
      if (Number.isNaN(t)) {
        return {
          granted: false,
          reason: body,
          basis: "expires-unparseable",
          expiresAt: null,
        };
      }
      expiresAt = t;
      basis = "explicit-expires";
    } else {
      let mtime;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        return {
          granted: false,
          reason: body,
          basis: "mtime-unreadable",
          expiresAt: null,
        };
      }
      expiresAt = mtime + DEFAULT_BLANKET_TTL_MS;
      basis = "default-ttl-from-mtime";
    }
    if (at >= expiresAt) {
      return { granted: false, reason: body, basis: "expired", expiresAt };
    }
    return { granted: true, reason: body, basis, expiresAt };
  } catch {
    return { granted: false, reason: null, basis: "absent" };
  }
}

/**
 * Probe the pool. Returns a DISCRIMINATING result or an explicit INDETERMINATE.
 *
 * `null` means "could not tell", NEVER "not saturated" — the two are opposite in
 * meaning and identical in a naive truthiness check, which is the
 * `instrument-discipline.md` MUST-1 trap this shape exists to avoid.
 *
 * @param {string} org
 * @param {(args:string[])=>({status:number,stdout:string}|null)} [runner] injected for tests
 */
function probePool(org, labelSets, runner) {
  if (!org || typeof org !== "string") return null;
  const run = runner || _ghJson;
  const out = run([
    "api",
    `orgs/${org}/actions/runners`,
    "--paginate",
    "-q",
    ".runners[] | [(.labels[].name)] as $l | {busy: .busy, labels: $l} | @json",
  ]);
  if (!out || out.status !== 0 || typeof out.stdout !== "string") return null;
  const rows = [];
  for (const ln of out.stdout.split(/\r?\n/)) {
    const t = ln.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t);
      // CASEFOLD AT THE BOUNDARY. GitHub Actions matches `runs-on` labels
      // CASE-INSENSITIVELY, but the API returns each label as it was REGISTERED,
      // so an exact-case `Array.includes` disagrees with the scheduler. Folded
      // here (and symmetrically in `requestedSelfHostedLabelSets`) so every
      // comparison downstream — the `self-hosted` marker test, the per-set
      // `every`, the dedup key — is a single-case comparison by construction.
      if (j && Array.isArray(j.labels))
        rows.push({
          busy: !!j.busy,
          labels: j.labels.map((l) => String(l).toLowerCase()),
        });
    } catch {
      return null; // a body we cannot parse is INDETERMINATE, not empty
    }
  }
  if (rows.length === 0) return null; // no rows parsed ⇒ cannot tell
  const selfHosted = rows.filter((r) => r.labels.includes(SELF_HOSTED_MARKER));
  if (selfHosted.length === 0) {
    // A real answer: this org runs no self-hosted pool, so nothing can saturate.
    return {
      total: 0,
      idle: 0,
      saturated: false,
      applicable: false,
      reason: "no-self-hosted-runners",
      pool: null,
    };
  }

  // SCOPE IS THE WHOLE POINT, and getting it wrong is silent.
  //
  // An org-wide "is any self-hosted runner idle" count answers a DIFFERENT
  // question from "can the job this push triggers get a slot", and it fails
  // toward silence. Measured on this repo while building the guard: 28
  // self-hosted runners, 5 idle → org-wide says "capacity available", while the
  // pool the structural job actually requests (`kailash-linux`) was 0 of 16 idle
  // and every run queued. The guard would have stayed quiet through exactly the
  // saturation it exists to catch (`instrument-discipline.md` MUST-4 — an
  // instrument is scoped to the question it was BUILT for).
  //
  // So saturation is evaluated PER REQUESTED LABEL SET: a runner satisfies a set
  // only if it carries EVERY label in it, which is GitHub's own matching rule.
  // BOTH boundaries fold, not one. `requestedSelfHostedLabelSets` already
  // lowercases what it parses, but a comparison whose soundness depends on the
  // CALLER having folded is one refactor away from being wrong again — and its
  // failure mode is the silent one (zero matches ⇒ unschedulable ⇒ nothing said).
  // Folding here makes `probePool` correct for ANY caller, which is the property
  // worth having.
  const sets = Array.isArray(labelSets)
    ? labelSets
        .filter((s) => Array.isArray(s) && s.length)
        .map((s) => s.map((l) => String(l).toLowerCase()))
    : [];
  if (sets.length === 0) {
    // No self-hosted set requested by this repo's workflows ⇒ nothing to queue
    // behind. A real answer, not an unknown.
    return {
      total: selfHosted.length,
      idle: 0,
      saturated: false,
      applicable: false,
      reason: "no-requested-set",
      pool: null,
    };
  }
  let worst = null;
  const unschedulable = [];
  for (const set of sets) {
    const matching = selfHosted.filter((r) =>
      set.every((l) => r.labels.includes(l)),
    );
    // A requested set with NO matching runner at all is not saturation — it is a
    // misconfiguration (the job can never be scheduled). Report it as its own
    // state rather than folding it into "0 idle", which would send the operator
    // to buy capacity that already exists.
    const cand = {
      pool: set.join(","),
      total: matching.length,
      idle: matching.filter((r) => !r.busy).length,
      unschedulable: matching.length === 0,
    };
    if (cand.unschedulable) {
      // RETURN THE STATE, DO NOT DISCARD IT. Until 2026-08-29 this was a bare
      // `continue`, so `unschedulable` was computed and then dropped on the
      // floor: an all-unschedulable probe fell through to `{applicable:false,
      // pool:null}`, BYTE-IDENTICAL to "this org runs no self-hosted pool" and
      // to "this repo requests no self-hosted set". Three distinct states
      // collapsed to one silent verdict — which is what made the case-folding
      // defect INVISIBLE rather than merely wrong: a case-mismatched set matched
      // zero runners, landed here, and the guard went quiet exactly where it
      // should have spoken.
      unschedulable.push(cand.pool);
      continue;
    }
    if (worst === null || cand.idle < worst.idle) worst = cand;
  }
  if (worst === null) {
    return {
      total: selfHosted.length,
      idle: 0,
      saturated: false,
      applicable: false,
      // NOT saturation, and NOT silence: every requested set names a pool no
      // registered runner satisfies, so these jobs can never be scheduled.
      reason: "unschedulable",
      pool: unschedulable.join(" | ") || null,
      unschedulable,
    };
  }
  return {
    total: worst.total,
    idle: worst.idle,
    saturated: worst.idle === 0,
    applicable: true,
    pool: worst.pool,
  };
}

/**
 * The self-hosted label sets this repo's own workflows request.
 *
 * Line-oriented and deliberately conservative: a `runs-on:` it cannot parse is
 * OMITTED rather than guessed, because a fabricated label set would produce a
 * confident answer about a pool that does not exist. Omission costs silence,
 * which is this guard's safe direction.
 *
 * Handles the two shapes the corpus uses:
 *   runs-on: [self-hosted, kailash-linux]
 *   runs-on: ubuntu-latest            (ignored — not self-hosted)
 */
function requestedSelfHostedLabelSets(repoDir, readDirSync, readFileSync) {
  const rd = readDirSync || ((d) => fs.readdirSync(d));
  const rf = readFileSync || ((f) => fs.readFileSync(f, "utf8"));
  const dir = path.join(repoDir, ".github", "workflows");
  let names;
  try {
    names = rd(dir).filter((n) => /\.ya?ml$/i.test(n));
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const n of names) {
    let text;
    try {
      text = rf(path.join(dir, n));
    } catch {
      continue;
    }
    for (const ln of String(text).split(/\r?\n/)) {
      const m = ln.match(/^\s*runs-on:\s*(.+?)\s*(?:#.*)?$/);
      if (!m) continue;
      const v = m[1].trim();
      if (!v.startsWith("[")) continue; // scalar form is a hosted label
      const inner = v.replace(/^\[|\]$/g, "");
      // Lowercased to match the runner-side fold in `probePool` — GitHub's own
      // label matching is case-INSENSITIVE, so `[self-hosted, Kailash-Linux]`
      // against a runner registered `kailash-linux` schedules fine and MUST NOT
      // read as an unmatched (and previously: silent) set.
      const labels = inner
        .split(",")
        .map((s) =>
          s
            .trim()
            .replace(/^["']|["']$/g, "")
            .toLowerCase(),
        )
        .filter(Boolean);
      if (!labels.includes(SELF_HOSTED_MARKER)) continue;
      const key = labels.slice().sort().join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(labels);
    }
  }
  return out;
}

function _ghJson(args) {
  try {
    const r = spawnSync("gh", args, {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) return null;
    return { status: r.status, stdout: r.stdout || "" };
  } catch {
    return null;
  }
}

/**
 * The decision. Pure: every input is injected.
 *
 * @returns {{verdict:"silent"|"notify"|"ask", detail?:object}}
 *   "silent" — say nothing (not a CI push / indeterminate / pool has capacity /
 *              no self-hosted pool / a blanket is in force)
 *   "notify" — a MEASURED misconfiguration the operator should see but which is
 *              not a choice about pool spend: every requested self-hosted set
 *              matches zero registered runners, so those jobs can never be
 *              scheduled. Distinct from "silent" precisely because it is a
 *              positive finding, and distinct from "ask" because there is
 *              nothing to authorize — the push proceeds either way.
 *   "ask"    — the pool is full and no blanket is in force; surface the choice
 */
function assessCiSaturation({ command, pool, blanket }) {
  if (!triggersCi(command))
    return { verdict: "silent", detail: { why: "not-a-ci-push" } };
  if (pool === null || pool === undefined) {
    // INDETERMINATE. Explicitly not an all-clear, and explicitly not a refusal:
    // a probe that could not answer must not spend the operator's attention.
    return { verdict: "silent", detail: { why: "probe-indeterminate" } };
  }
  if (!pool.applicable) {
    if (pool.reason === "unschedulable") {
      return {
        verdict: "notify",
        detail: {
          why: "unschedulable",
          pool: pool.pool,
          unschedulable: pool.unschedulable || [],
          total: pool.total,
        },
      };
    }
    // `why` is deliberately UNCHANGED for the other two inapplicable states —
    // no self-hosted runners in the org, and no self-hosted set requested by
    // this repo — because both genuinely mean "nothing here can queue". The
    // more specific `reason` rides alongside so the three are separable
    // downstream without re-conflating them into one verdict.
    return {
      verdict: "silent",
      detail: { why: "no-self-hosted-pool", reason: pool.reason || null },
    };
  }
  if (!pool.saturated) {
    return {
      verdict: "silent",
      detail: { why: "capacity-available", idle: pool.idle, total: pool.total },
    };
  }
  if (blanket && blanket.granted) {
    return {
      verdict: "silent",
      detail: {
        why: "session-blanket-in-force",
        reason: blanket.reason,
        idle: 0,
        total: pool.total,
      },
    };
  }
  return { verdict: "ask", detail: { idle: 0, total: pool.total } };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  CI_AUTHZ_REL,
  DEFAULT_BLANKET_TTL_MS,
  BLANKET_FILE,
  SELF_HOSTED_MARKER,
  requestedSelfHostedLabelSets,
  triggersCi,
  readBlanket,
  probePool,
  assessCiSaturation,
};
