/**
 * force-push-recovery-scope.js — the predicate for `orchestration-launch-ledger.md`
 * MUST-6(b): "NEVER `git push --force` / `--force-with-lease` a diverged branch.
 * MEASURE first (`git rev-list --count <branch>..origin/<branch>`), then preserve
 * both sides on `recovery/<name>`."
 *
 * WHAT IT ANSWERS: would this force-push DESTROY commits the remote holds and
 * this clone does not? That is the proposition MUST-6(b) states, and the count
 * the rule's own command produces is the answer. ZERO destroyed commits is
 * exactly what MUST-6(b) permits, so the verdict at zero is SILENCE.
 *
 * ── WHAT THIS MODULE USED TO DO, AND WHY THAT WAS NOT AN INSTRUMENT ─────────
 *
 * Until 2026-09-13 this module decided on the branch NAME: a force-push whose
 * destination was not `recovery/<name>` was flagged, and one that was, was not.
 * It never measured anything. Measured before the fix:
 *
 *   · `recovery/` appears in 0 of 1356 branches in this repo's history, so the
 *     predicate as written would have flagged EVERY force-push ever made here.
 *   · This header quoted MUST-6(b)'s "MEASURE first
 *     (`git rev-list --count <branch>..origin/<branch>`)" four lines above code
 *     that ran no such measurement.
 *
 * A name is not evidence about divergence: `feat/x` may destroy nothing and
 * `recovery/x` may destroy three commits, and the old predicate answered both
 * backwards. `instrument-discipline.md` MUST-1 asks what this instrument would
 * print were the proposition FALSE — were the push about to destroy nothing —
 * and the honest answer was "the same finding", which is no information at all.
 *
 * The `recovery/` prefix is therefore NOT a verdict determinant here. It is
 * MUST-6(b)'s REMEDY (where to preserve both sides), not an exemption from the
 * measurement, and a diverged `recovery/<name>` push destroys remote-only
 * commits exactly as a diverged `feat/<name>` one does. `isRecoveryScoped`
 * survives to TELL the reader which shape they are in; it decides nothing.
 * Equally, no `feat/*` or other name pattern is allowlisted: an allowlist would
 * leave a genuinely diverged push under that pattern silent, which is the defect
 * this module just stopped instancing.
 *
 * ── THE THREE VERDICTS, AND WHY THERE ARE THREE ─────────────────────────────
 *
 *   "flag"     the count is > 0 — this push destroys that many remote-only
 *              commits, and the count is carried in the finding.
 *   "clean"    the count is 0 — nothing the remote holds is lost. SILENT.
 *   "unknown"  the count COULD NOT BE READ. Never silently clean and never
 *              flagged; the finding names WHY it could not be read.
 *
 * UNKNOWN is a real state, not a shade of clean, and it is reachable by several
 * routes this module distinguishes by a short reason code: no remote-tracking
 * ref in this clone, no configured upstream, a remote that is a URL rather than
 * a named remote, an unresolvable source, a bulk selector naming every matching
 * ref, a ref deletion (which has no source to measure against and destroys
 * everything the remote ref holds), a tag destination (a forced tag update
 * replaces the tag object, so the branch-divergence measurement does not apply),
 * and plain git failure.
 *
 * ── THE MEASUREMENT'S OWN LIMIT, STATED RATHER THAN PAPERED OVER ────────────
 *
 * The count is taken against the REMOTE-TRACKING REF, which is only as fresh as
 * the last fetch. A stale local ref UNDER-reports: commits pushed to the remote
 * since the last fetch are invisible here, so 0 means "nothing this clone knows
 * of is destroyed", never "nothing is destroyed". This module deliberately does
 * NOT fetch — a hook must not perform network I/O — so the caller is told the
 * limit and the reader carries it. `FRESHNESS_CAVEAT` is that sentence, held
 * here once so the guard has no second lineage of it.
 *
 * ── NOT A DUPLICATE OF THE EXISTING FENCE ───────────────────────────────────
 *
 * A force-push fence already exists at `validate-bash-command.js` (the
 * "force-push to a protected branch" lane). It is NOT this one: its predicate
 * requires BOTH a force flag AND a `(main|master)` token, it measures nothing,
 * and it attributes to `git.md` § Branch Protection. Fired at known-positive
 * cases on this tree (`instrument-discipline.md` MUST-3(a) — the control must be
 * shown to speak before its silence is read as a true negative):
 *
 *   git push --force origin main                 -> FINDING   (control fires)
 *   git push --force-with-lease origin master    -> FINDING   (control fires)
 *   git push --force origin HEAD:refs/heads/main -> silent    <- misses its OWN class
 *   git push --force origin feat/wave-3          -> silent    <- MUST-6's case
 *   git push --force                             -> silent    <- MUST-6's case
 *
 * Row 3 is why this predicate does NOT exclude `main`/`master` to avoid overlap:
 * the existing fence's own protected-branch class is reachable through a spelling
 * it cannot see, and inheriting that blind spot to buy tidiness would trade a
 * real gap for a duplicate line. The two lanes also answer DIFFERENT questions —
 * that one asks WHICH REF, this one asks WHAT WOULD BE DESTROYED — so where a
 * force-push to `main` would destroy nothing this lane is correctly silent while
 * that one still fires, and neither result is evidence about the other's
 * question (`instrument-discipline.md` MUST-4).
 *
 * ── THE SIGNAL IS PARSED, NOT LEXICAL ───────────────────────────────────────
 *
 * Every destination below is taken from ARGV TOKENS via
 * `lib/git-command-parse.js::parseGitInvocations` — the subcommand POSITION and
 * the post-subcommand words as separate shell words — never a regex over the
 * joined command string. `hook-output-discipline.md` MUST-5 measured a joined
 * string matcher disagreeing with ground truth 7 times in 13. That parser also
 * supplies, for free, the wrapper forms (`sudo`, `env`, `xargs`), `git -C <dir>`,
 * `--work-tree`, nested `sh -c '…'` bodies, shell grouping, comments and
 * heredocs, all of which this predicate would otherwise have to re-learn.
 *
 * WHAT THAT PARSER LACKS FOR THIS QUESTION, stated rather than worked around:
 * `parseGitInvocation` returns `argv` as `rest.map(t => t.value)` — the token
 * VALUES — so the per-token `unexpandable` MARK that `tokenize` computed is
 * DROPPED before this module sees it. A force-push target spelled `$BRANCH` is
 * therefore indistinguishable, at the argv layer, from a branch literally named
 * `$BRANCH`. Rather than regex the joined command string (which is what
 * MUST-5 forbids) or edit the shared parser (another lane's surface), this module
 * reconstructs the mark from the token VALUE: `tokenize` preserves the RAW BYTES
 * of every construct it flags, so a `$` or backtick surviving into a token value
 * is exactly the set it marked. The one place the two readings differ is an
 * escape-free ANSI-C quote (`$'/tmp/x'`), which `tokenize` DECODES to a literal
 * and does not flag — and which therefore carries no `$` for this test to find
 * either. The reconstruction is faithful in both directions for the argv slots;
 * it is a predicate over ONE PARSED TOKEN, not over a command string.
 *
 * ── SCOPE, AND THE RESIDUALS THAT ARE NAMED RATHER THAN SILENT ──────────────
 *
 * IN the force set: `--force`, `-f` (including inside a short cluster, `-fu`),
 * `--force-with-lease[=<v>]`, and a `+`-prefixed refspec (`+HEAD:refs/heads/x`),
 * which forces THAT refspec alone with no flag present at all. Negations
 * (`--no-force`, `--no-force-with-lease`) are honoured LAST-WINS, because git
 * honours them.
 *
 * NOT in the force set, deliberately:
 *   · `--force-if-includes` — a MODIFIER on `--force-with-lease` with no effect
 *     of its own. Parsed so it is not mistaken for a refspec; never counted as a
 *     force by itself, because `git push --force-if-includes origin feat/x` is
 *     an ordinary non-forced push and firing on it would be a false positive.
 *   · `--mirror`, `--all`, `--tags` — each a BULK selector. `--mirror` has
 *     force-like semantics of its own, and covering it would be a defensible
 *     separate contract; MUST-6 names `git push --force*`, so widening the force
 *     set past that text here would be this module asserting a rule the rule does
 *     not carry. When one appears ALONGSIDE a real force flag it IS covered, as
 *     an UNMEASURABLE target — there is no single ref to count (`BULK_TARGET_FLAGS`).
 *
 * NOT covered: a segment whose VERB is unresolvable (`sh -c "$CMD"`,
 * `git $(echo push) --force`). Failing closed there would emit on every opaque
 * nested body in the session, and noise is how an advisory gets switched off.
 * The UNKNOWN verdict is scoped to "this IS a force-push and what it would
 * destroy cannot be read", which is the case where silence would read as clean.
 *
 * PURE. Nothing here spawns, reads the filesystem, or throws. BOTH impure reads —
 * the current branch of the no-refspec form, and the divergence count — are
 * INJECTED by the caller, so every table-driven fixture in
 * `.claude/audit-fixtures/force-push-recovery-scope/` is deterministic, and the
 * two impure arms live in the guard and are separately pinned against real git.
 */

"use strict";

const path = require("path");

const { parseGitInvocations } = require(
  path.join(__dirname, "git-command-parse.js"),
);

/** MUST-6(b)'s REMEDY destination. Informational here — it decides no verdict. */
const RECOVERY_PREFIX = "recovery/";

/**
 * Long options that consume the NEXT word when written without `=`. Getting this
 * set wrong moves an option VALUE into the operand list, where it would be read
 * as a refspec — a target the command never had.
 */
const VALUE_LONG_OPTS = new Set([
  "--repo",
  "--exec",
  "--receive-pack",
  "--push-option",
  "--server-option",
]);

/** Short options that consume a value (the rest of their cluster, or the next word). */
const VALUE_SHORT_OPTS = new Set(["o"]);

/** Bulk selectors: with a force flag present, the target is "every matching ref". */
const BULK_TARGET_FLAGS = new Set(["--all", "--mirror", "--tags", "--branches"]);

/**
 * The reasons a count cannot be read. Short, stable codes so a fixture pole can
 * pin WHICH unreadable case it exercises rather than a bare "unknown" — an
 * UNKNOWN that cannot say why is the same non-answer this module was rewritten
 * to stop giving.
 */
const UNMEASURED = {
  NO_RESOLVER: "no-divergence-resolver",
  NO_TRACKING_REF: "no-remote-tracking-ref",
  NO_UPSTREAM: "no-upstream",
  UNNAMED_REMOTE: "unnamed-remote",
  REMOTE_UNRESOLVABLE: "remote-unresolvable",
  SOURCE_UNRESOLVABLE: "source-unresolvable",
  BRANCH_UNREADABLE: "current-branch-unreadable",
  BULK: "bulk-selector",
  DELETION: "ref-deletion",
  TAG: "tag-destination",
  GIT_FAILED: "git-failed",
};

/** Carried with EVERY count this module produces. See the header's LIMIT section. */
const FRESHNESS_CAVEAT =
  "The count is measured against the REMOTE-TRACKING ref, which is only as fresh as the last fetch: " +
  "a stale local ref UNDER-reports, so 0 means `nothing this clone knows of is destroyed`, never " +
  "`nothing is destroyed`. This hook does not fetch — a hook must not perform network I/O.";

/**
 * Does this token value carry an expansion the shell would resolve and this hook
 * MUST NOT? See the header: a faithful reconstruction of the `unexpandable` mark
 * that `argv` drops. `$` and backtick are the only two characters that open one.
 */
const carriesExpansion = (v) => typeof v === "string" && /[$`]/.test(v);

/**
 * Strip the ref namespace so `refs/heads/x` and `x` name the same branch.
 * DELIBERATELY only `refs/heads/`: a `refs/tags/…` destination keeps its prefix,
 * because it is not a branch and the branch-divergence measurement does not
 * apply to it — which is reported as UNMEASURED, never guessed at.
 */
function normalizeRef(dst) {
  return String(dst).replace(/^refs\/heads\//, "");
}

/**
 * Is this destination MUST-6(b)'s remedy branch? INFORMATIONAL: carried into the
 * finding so the reader knows which shape they are in. A bare `recovery` is not.
 */
function isRecoveryScoped(dst) {
  const name = normalizeRef(dst);
  return name.startsWith(RECOVERY_PREFIX) && name.length > RECOVERY_PREFIX.length;
}

/**
 * Split one refspec into its forced-ness, its SOURCE and its DESTINATION.
 *
 * `+src:dst` forces that refspec alone. `src:dst` takes dst. A bare `name` is
 * `name:name`, so source and destination are both the name. `:dst` is a
 * deletion, which has NO source — which is why it cannot be measured.
 */
function parseRefspec(spec) {
  let s = String(spec);
  let plus = false;
  if (s.startsWith("+")) {
    plus = true;
    s = s.slice(1);
  }
  const i = s.indexOf(":");
  if (i === -1) return { plus, src: s, dst: s, deletion: false };
  const src = s.slice(0, i);
  return { plus, src, dst: s.slice(i + 1), deletion: src === "" };
}

/**
 * Parse the post-`push` argv into `{ force, forceSource, bulk, deleteMode,
 * operands }`.
 *
 * LAST-WINS on the force flag, because git's own parse-options is last-wins:
 * `--force --no-force` is not a force push, and treating it as one would be a
 * false positive on a command that does exactly what the rule wants.
 */
function parsePushArgv(argv) {
  const out = {
    force: false,
    forceSource: null,
    bulk: [],
    deleteMode: false,
    ifIncludes: false,
    operands: [],
  };
  const words = Array.isArray(argv) ? argv : [];
  let afterDoubleDash = false;
  for (let i = 0; i < words.length; i++) {
    const t = String(words[i]);
    if (afterDoubleDash) {
      out.operands.push(t);
      continue;
    }
    if (t === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (t.startsWith("--")) {
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (name === "--force" || name === "--force-with-lease") {
        out.force = true;
        out.forceSource = name;
        continue;
      }
      if (name === "--no-force" || name === "--no-force-with-lease") {
        out.force = false;
        out.forceSource = null;
        continue;
      }
      if (name === "--force-if-includes") {
        // A modifier, never a force by itself. Recorded so the reporting layer
        // can say so, and consumed here so it cannot land in `operands`.
        out.ifIncludes = true;
        continue;
      }
      if (name === "--no-force-if-includes") continue;
      if (BULK_TARGET_FLAGS.has(name)) {
        out.bulk.push(name);
        continue;
      }
      if (name === "--delete") {
        out.deleteMode = true;
        continue;
      }
      if (VALUE_LONG_OPTS.has(name) && !t.includes("=")) i++; // its value is the next word
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      // A short cluster. Every character is its own option until one consumes a
      // value, which takes the rest of the cluster (or the next word) with it.
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (ch === "f") {
          out.force = true;
          out.forceSource = "-f";
          continue;
        }
        if (ch === "d") {
          out.deleteMode = true;
          continue;
        }
        if (VALUE_SHORT_OPTS.has(ch)) {
          if (k + 1 === t.length) i++; // value is the next word
          break; // rest of the cluster is the value
        }
      }
      continue;
    }
    out.operands.push(t);
  }
  return out;
}

/**
 * Classify ONE parsed git invocation into the STRUCTURAL facts — what is forced,
 * where it would land, and what cannot even be NAMED. NO VERDICT is reached here:
 * the verdict needs the measurement, which is the caller's injected read. That
 * split is what keeps this module pure and its fixtures deterministic.
 *
 * Returns `null` when the segment is not a force-push this contract reaches —
 * the common case, which MUST stay silent. Otherwise:
 *
 *   { targets, unresolved, implicitTarget, dir, remote, forceSource, ifIncludes }
 *
 * `targets`    destinations that can be NAMED, each `{ spec, src, dst, forcedBy,
 *              deletion, bulk, tag, recoveryScoped }`.
 * `unresolved` destinations that cannot be named at all, each `{ spec, reason,
 *              why }`.
 * `implicitTarget` marks the no-refspec form, whose destination is the CURRENT
 *              branch: a fact this pure function cannot know and the caller
 *              resolves.
 */
function classifyPushInvocation(g) {
  if (!g || g.sub !== "push") return null;
  const parsed = parsePushArgv(g.argv);

  // `git push <repository> [<refspec>…]` — the FIRST operand is the repository,
  // which is git's own precedence even when `--repo` is also given.
  const remote = parsed.operands.length ? String(parsed.operands[0]) : null;
  const refspecs = parsed.operands.slice(1);
  const plusForced = refspecs.some((s) => String(s).startsWith("+"));

  if (!parsed.force && !plusForced) return null; // not a force-push — silent

  const targets = [];
  const unresolved = [];

  for (const spec of refspecs) {
    if (carriesExpansion(spec)) {
      unresolved.push({
        spec,
        reason: UNMEASURED.REMOTE_UNRESOLVABLE,
        why: "the refspec is produced by a shell expansion, so the destination cannot be named — and what a push to an unnamed destination would destroy cannot be counted",
      });
      continue;
    }
    const r = parseRefspec(spec);
    if (!parsed.force && !r.plus) continue; // this refspec is not forced
    const dst = normalizeRef(r.dst);
    targets.push({
      spec,
      src: r.deletion ? null : r.src,
      dst,
      forcedBy: r.plus ? "+refspec" : parsed.forceSource,
      deletion: r.deletion || parsed.deleteMode,
      bulk: false,
      tag: dst.startsWith("refs/tags/"),
      recoveryScoped: isRecoveryScoped(r.dst),
    });
  }

  // A bulk selector alongside a force flag: the destination set is every matching
  // ref, so there is no single ref whose divergence could be counted.
  for (const flag of parsed.bulk) {
    if (!parsed.force) continue;
    targets.push({
      spec: flag,
      src: null,
      dst: `${flag} (every matching ref)`,
      forcedBy: parsed.forceSource,
      deletion: false,
      bulk: true,
      tag: false,
      recoveryScoped: false,
    });
  }

  const implicitTarget =
    targets.length === 0 && unresolved.length === 0 && refspecs.length === 0;

  // An unresolvable `-C` / `--work-tree` value means neither the current branch
  // NOR the divergence can be read in the right tree. Reported, never guessed at.
  if (implicitTarget && g.unresolvable === "dir") {
    return {
      targets: [],
      unresolved: [
        {
          spec: "(current branch)",
          reason: UNMEASURED.REMOTE_UNRESOLVABLE,
          why: "the -C / --work-tree value is a shell expansion, so the tree to read HEAD and the divergence from is unknown",
        },
      ],
      implicitTarget: false,
      dir: g.dir,
      remote,
      forceSource: parsed.forceSource,
      ifIncludes: parsed.ifIncludes,
    };
  }

  return {
    targets,
    unresolved,
    implicitTarget,
    dir: g.dir,
    remote,
    forceSource: parsed.forceSource || (plusForced ? "+refspec" : null),
    ifIncludes: parsed.ifIncludes,
  };
}

/** Every force-push classification in a command string, one per git segment. */
function classifyCommand(command) {
  const out = [];
  for (const g of parseGitInvocations(command || "")) {
    const c = classifyPushInvocation(g);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The reasons a NAMED destination still cannot be measured, decided with NO IO.
 * Returns `{ reason, why }`, or `null` when the target IS measurable.
 *
 * Each of these is a case where the rule's own command
 * (`git rev-list --count <branch>..origin/<branch>`) has no well-formed
 * instantiation — so answering "0" would be inventing a measurement rather than
 * taking one, and answering "flag" would be flagging on shape, which is the
 * defect this module was rewritten to remove.
 */
function unmeasurableReason(target, remote) {
  if (target.bulk) {
    return {
      reason: UNMEASURED.BULK,
      why: `\`${target.spec}\` names every matching ref, so there is no single destination whose divergence could be counted`,
    };
  }
  if (target.deletion) {
    return {
      reason: UNMEASURED.DELETION,
      why: "this is a ref DELETION: it has no source to measure against, and it destroys every commit the remote ref holds",
    };
  }
  if (target.tag) {
    return {
      reason: UNMEASURED.TAG,
      why: "the destination is a TAG: a forced tag update replaces the tag object, and the branch-divergence measurement MUST-6(b) names does not apply to it",
    };
  }
  if (remote !== null && carriesExpansion(remote)) {
    return {
      reason: UNMEASURED.REMOTE_UNRESOLVABLE,
      why: "the remote is produced by a shell expansion, so no remote-tracking ref can be named to measure against",
    };
  }
  return null;
}

/**
 * MEASURE every named destination and reduce to ONE verdict for the command.
 *
 * `resolveBranch(dir)` MUST return `{ ok: true, branch }` or `{ ok: false, why }`
 * and MUST NOT throw.
 *
 * `resolveDivergence({ dir, remote, src, dst })` MUST return
 * `{ ok: true, count, remoteRef }` — the number of commits the REMOTE ref holds
 * that `src` does not, i.e. exactly what this force-push would destroy — or
 * `{ ok: false, reason, why }`, and MUST NOT throw.
 *
 * Both are injected rather than called directly so the whole decision is
 * table-testable; the shipped resolvers live in the guard and share ONE bounded
 * git subprocess lineage there.
 *
 * ABSENT RESOLVER IS UNKNOWN, NEVER CLEAN. A caller that supplies no divergence
 * resolver has measured nothing, and the honest verdict for "nothing was
 * measured" is UNKNOWN. Defaulting to clean would restore, by omission, exactly
 * the silent-pass this module was rewritten to remove.
 *
 * PRECEDENCE: flag > unknown > clean. A command holding one measurable-at-zero
 * push and one that destroys commits is FLAGGED — the clean half does not buy
 * silence for the other.
 */
function assessForcePush(command, { resolveBranch, resolveDivergence } = {}) {
  const parts = classifyCommand(command);
  if (!parts.length) return { verdict: "clean", findings: [] };

  const measure =
    typeof resolveDivergence === "function"
      ? resolveDivergence
      : () => ({
          ok: false,
          reason: UNMEASURED.NO_RESOLVER,
          why: "no divergence resolver was supplied, so what this push would destroy was never measured",
        });

  const findings = [];
  for (const p of parts) {
    let targets = p.targets;
    const unresolved = p.unresolved.slice();

    if (p.implicitTarget) {
      const r =
        typeof resolveBranch === "function"
          ? resolveBranch(p.dir)
          : { ok: false, why: "no branch resolver was supplied" };
      if (!r || !r.ok) {
        findings.push({
          ...p,
          verdict: "unknown",
          targets: [],
          flagged: [],
          unresolved: [
            {
              spec: "(current branch)",
              reason: UNMEASURED.BRANCH_UNREADABLE,
              why: `no refspec was given and the current branch could not be read, so neither the destination nor what it would destroy is knowable: ${(r && r.why) || "unknown"}`,
            },
          ],
        });
        continue;
      }
      targets = [
        {
          spec: "(no refspec — the current branch)",
          // HEAD is what a no-refspec push sends and resolves in every tree; the
          // branch NAME is what names the remote-tracking ref to count against.
          src: "HEAD",
          dst: normalizeRef(r.branch),
          forcedBy: p.forceSource,
          deletion: false,
          bulk: false,
          tag: false,
          recoveryScoped: isRecoveryScoped(r.branch),
        },
      ];
    }

    const flagged = [];
    const measured = [];
    for (const t of targets) {
      const blocked = unmeasurableReason(t, p.remote);
      if (blocked) {
        unresolved.push({ spec: t.dst, reason: blocked.reason, why: blocked.why });
        continue;
      }
      const d = measure({ dir: p.dir, remote: p.remote, src: t.src, dst: t.dst });
      const count = d && d.ok ? Number(d.count) : NaN;
      if (!d || !d.ok || !Number.isFinite(count)) {
        unresolved.push({
          spec: t.dst,
          reason: (d && d.reason) || UNMEASURED.GIT_FAILED,
          why:
            (d && d.why) ||
            (d && d.ok ? `the divergence count came back unreadable: ${String(d.count)}` : "the divergence count could not be read"),
        });
        continue;
      }
      const m = { ...t, count, remoteRef: (d && d.remoteRef) || null };
      measured.push(m);
      if (count > 0) flagged.push(m);
    }

    const verdict = flagged.length ? "flag" : unresolved.length ? "unknown" : "clean";
    findings.push({ ...p, verdict, targets: measured, flagged, unresolved });
  }

  const verdict = findings.some((f) => f.verdict === "flag")
    ? "flag"
    : findings.some((f) => f.verdict === "unknown")
      ? "unknown"
      : "clean";
  return { verdict, findings: findings.filter((f) => f.verdict !== "clean") };
}

/**
 * Render the finding's one-line summary. Kept here so the guard holds no second
 * lineage of the wording and the fixtures can pin it.
 *
 * A flagged destination CARRIES ITS COUNT — the number IS the finding, and a
 * summary naming the branch without it would be the name-matcher this module
 * stopped being. An unmeasured destination carries its REASON CODE, so UNKNOWN
 * is never a bare non-answer a reader has to guess at.
 */
function describeTargets(findings) {
  const names = [];
  for (const f of findings) {
    for (const t of f.flagged || []) {
      names.push(`${t.dst} (${t.count} remote-only commit${t.count === 1 ? "" : "s"})`);
    }
    for (const u of f.unresolved || []) names.push(`${u.spec} [UNMEASURED: ${u.reason}]`);
  }
  return names.join(", ");
}

module.exports = {
  RECOVERY_PREFIX,
  BULK_TARGET_FLAGS,
  VALUE_LONG_OPTS,
  UNMEASURED,
  FRESHNESS_CAVEAT,
  carriesExpansion,
  normalizeRef,
  isRecoveryScoped,
  parseRefspec,
  parsePushArgv,
  unmeasurableReason,
  classifyPushInvocation,
  classifyCommand,
  assessForcePush,
  describeTargets,
};
