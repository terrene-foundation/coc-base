#!/usr/bin/env node
/**
 * triage-routing-guard.js — the Phase-2 detector for `issue-triage-routing.md`
 * § "MUST: Route Every Triaged Issue By The Repo `type`, Never By Convenience".
 *
 * @hook-event: PreToolUse:Bash (guard) — the `gh issue create` argv IS the
 *   subject. A routing disposition is prose right up until it becomes a filed
 *   issue, and the destination repo exists in no other artifact: at `/codify`
 *   gate-review the issue is already on the wrong lane and its provenance is
 *   already lost, and no PostToolUse read recovers a filing that should not have
 *   happened. The matcher is `Bash` and not `*` — `hook-event-selection.md`
 *   MUST-3 FAILs a narrow class registered without a matcher, and a `*` matcher
 *   would pay a node spawn on every Read/Grep/Edit to reach an immediate
 *   passthrough.
 *
 * ARMED 2026-09-18 — registered in `.claude/settings.json` at `PreToolUse`, matcher
 *   `Bash`, the event this file's own `@hook-event` declares. NO registration-state marker is carried
 *   , deliberately: every value in
 *   `reconcile-hook-surfaces.mjs::MARKER_VOCABULARY` asserts NON-registration, so
 *   a registered hook carries none, and `detection-dispatch-check.mjs` reds
 *   `authored-unwired-marker-contradicted` on one that does. Co-owner-authorized;
 *   fixtures re-run at arming time on this tree, 14/14, rc read directly off the
 *   node process. It is authored complete: predicates in `lib/triage-routing.js`,
 *   class/identity/upstream each read from its own authority via
 *   `lib/version-utils.js` and `lib/upflow-self-repo.js`.
 *
 *   ⛔ ARMING BUYS LOOM NOTHING, AND THAT IS NOT A DEFECT — IT IS THE POINT.
 *   Two bounds compose and MUST NOT be collapsed. (1) This hook reaches only the
 *   `coc-project` class; the other three are procedure-shaped and carried by no
 *   token in any command. (2) Loom's own `.claude/VERSION::type` is `coc-source`,
 *   so AT LOOM the predicate is a STRUCTURAL NO-OP — it will decide nothing, ever,
 *   on this repo. The payoff is at CC CONSUMERS, where `.claude/VERSION::type` IS
 *   `coc-project` and Gate-2's `reconcileWorktreeSettings` propagates this
 *   registration into the target. So loom pays the cost and the consumer gets the
 *   enforcement — an asymmetry worth stating rather than discovering later.
 *
 *   THE COST IS REAL AND IS ON THE HOTTEST PATH. `PreToolUse:Bash` is this repo's
 *   busiest matcher; this registration adds one process to every Bash call at
 *   loom (~81 ms, measured on this class, NOT re-measured for this guard —
 *   re-derive before citing it) in exchange for zero loom-side benefit. It is
 *   registered SEPARATELY rather than merged into the incumbent
 *   `validate-bash-command.js` because that host BLOCKS and runs at a 10 s
 *   timeout, and whether an `advisory` guest inherits a block-capable host's
 *   refusal semantics has never been measured. A merge would be free in process
 *   count and is the right optimization ONCE that coupling is measured; until
 *   then a separate registration carries its own severity and cannot silently
 *   acquire teeth `hook-output-discipline.md` MUST-2 forbids it.
 *
 *   `issue-triage-routing.md`'s routing MUST remains enforced at GATE-REVIEW for
 *   every class; this guard narrows nothing and backstops one class at one
 *   audience. ARMED IS NOT PROVEN EFFECTIVE: registration is measured here, live
 *   firing is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEVERITY — `advisory`, and the rule itself says so
 * ─────────────────────────────────────────────────────────────────────────────
 * `skills/32-trust-posture/wiring/issue-triage-routing.md` § Trust Posture Wiring already fixed this tier
 * before any detector existed: "`advisory` at the hook layer (lexical
 * routing-intent detection over a `gh issue` triage MUST NOT carry `block` per
 * `hook-output-discipline.md` MUST-2)". This hook honours that verbatim rather
 * than re-deriving it. The reasoning holds on inspection: the repo CLASS and the
 * repo IDENTITY are structural (a parsed `.claude/VERSION` field; the live git
 * origin remote), but whether THIS issue is a COC-method fix the routing table
 * governs — as opposed to an ordinary operational issue a consumer legitimately
 * files on itself — is not carried by any token in the command. A detector is
 * capped at its weakest half, so the composed finding is advisory and this hook
 * can annotate a filing; it can never stop one. Promoting it would be a MUST-2
 * violation AND would block the operational-issue case it cannot distinguish.
 *
 * At `PreToolUse` the finding is RENDERED under the `pre-action` register, which
 * is the only head that is TRUE at this instant — `advisory` renders "the action
 * proceeded" and `halt-and-report` renders "the action ALREADY RAN", and the
 * filing has done neither. Each finding still carries its OWN class on its
 * rendered line (the same correction `dispatch-contract-guard.js` records).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS HOOK CANNOT SEE — read before citing its silence
 * ─────────────────────────────────────────────────────────────────────────────
 * Of the rule's FOUR repo classes, exactly ONE (`coc-project`) has an
 * argv-visible disposition. The other three are procedure-shaped and this hook
 * is structurally silent on them — including `coc-source`, which is loom's own
 * class, so AT LOOM THIS HOOK NEVER FIRES AT ALL. That silence is not evidence
 * of correct routing; it is the absence of an instrument
 * (`instrument-discipline.md` MUST-3(a)). The per-class argument is in
 * `lib/triage-routing.js` § "WHAT IS MECHANICALLY DECIDABLE HERE"; the fixtures
 * drive the predicate with a DECLARED class so the firing pole is demonstrated
 * on a tree where it cannot fire in anger.
 *
 * FAILS OPEN ON EVERY UNKNOWN (`cc-artifacts.md` Rule 7): unparseable payload,
 * missing command, unreadable `.claude/VERSION`, a class other than
 * `coc-project`, a git remote that will not resolve, an unparseable `--repo`
 * value, a thrown require, the internal timer expiring — all return
 * `{continue:true}`. The one deliberate degradation is the `files-off-lane`
 * verdict, which is WITHHELD when no upstream is declared: a smaller true
 * answer, never a false clean.
 *
 * WRITES NOTHING. One bounded stdin read, one `.claude/VERSION` read, and one
 * `git remote get-url origin` (via `upflow-self-repo.js`, which derives the
 * identity from the LIVE remote and refuses rather than guessing from a dirname).
 * No sink, no ledger, no receipt, no network.
 *
 * Origin: graduated 2026-09-13 from
 * `phase2-deferrals.json::deferrals["issue-triage-routing.md#route-by-class"]`,
 * whose registered graduation condition was "a detector pairing a gh issue
 * triage against `.claude/VERSION::type`".
 */

"use strict";

// Bounded timer per `cc-artifacts.md` Rule 7, deliberately under the registered
// 8s timeout so this hook's OWN fallback fires first and emits a well-formed
// passthrough. The only subprocess is a local `git remote get-url`.
const TIMEOUT_MS = 6000;
let fallback = null;

const path = require("node:path");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const { readStdinBounded } = require("./lib/read-stdin-bounded.js");

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        additionalContext: context,
      };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

/** One line per finding, each under its OWN severity class. */
function renderFindingLines(findings) {
  return findings
    .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`)
    .join("\n");
}

async function main() {
  // `readStdinBounded()` resolves the PARSED payload, NOT raw text — do not
  // JSON.parse its result (the seam that made a sibling hook silently inert).
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null);
  }
  const p = payload && typeof payload === "object" ? payload : {};
  if ((p.tool_name || p.tool || "") !== "Bash") return passthrough(null);

  const command =
    p.tool_input && typeof p.tool_input.command === "string"
      ? p.tool_input.command
      : "";
  if (!command) return passthrough(null);

  // Cheap pre-filter BEFORE any module load or subprocess: the overwhelming
  // majority of Bash calls are not issue filings and must cost nothing.
  if (!/gh\s+issue\s+create/.test(command)) return passthrough(null);

  let lib;
  try {
    lib = require(path.join(__dirname, "lib", "triage-routing.js"));
  } catch {
    return passthrough(null);
  }

  // ── Authority 1: the repo CLASS, from `.claude/VERSION::type`.
  let repoClass = null;
  let upstreamRepo = null;
  try {
    const { readLocalVersion } = require(
      path.join(__dirname, "lib", "version-utils.js"),
    );
    const v = readLocalVersion(PROJECT_DIR);
    if (v && typeof v.type === "string") repoClass = v.type;
    // ── Authority 3: the SANCTIONED upstream, declared in the same file.
    if (v && v.upstream && typeof v.upstream.repo === "string") {
      upstreamRepo = lib.parseRepoRef(v.upstream.repo);
    }
  } catch {
    return passthrough(null); // Unreadable class ⇒ UNKNOWN ⇒ fail open.
  }
  if (repoClass !== lib.DECIDABLE_CLASS) return passthrough(null);

  // ── Authority 2: THIS repo's identity, from the LIVE git origin remote.
  // Resolved only after the class gate, so no subprocess is spawned on the
  // three classes this hook cannot decide.
  let selfRepo = null;
  try {
    const { deriveSelfRepoRef } = require(
      path.join(__dirname, "lib", "upflow-self-repo.js"),
    );
    const derived = deriveSelfRepoRef(PROJECT_DIR);
    if (derived && derived.ok && derived.self) {
      selfRepo = { owner: derived.self.owner, name: derived.self.name };
    }
  } catch {
    selfRepo = null; // Smaller true answer: the no-`--repo` arm still decides.
  }

  let findings = [];
  try {
    findings = lib.inspectIssueFiling({
      command,
      repoClass,
      selfRepo,
      upstreamRepo,
    });
  } catch {
    return passthrough(null);
  }
  if (findings.length === 0) return passthrough(null);

  let emit;
  try {
    ({ emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js")));
  } catch {
    return passthrough(
      [
        "⚠ issue-triage-routing findings — NOT blocked (renderer unavailable).",
        "",
        renderFindingLines(findings),
      ].join("\n"),
    );
  }

  const ruleIds = [...new Set(findings.map((f) => f.rule_id))];
  if (fallback) clearTimeout(fallback);
  emit({
    hookEvent: "PreToolUse",
    severity: "pre-action",
    what_happened:
      `This \`gh issue create\` has NOT run yet and drew ${findings.length} ` +
      `issue-triage-routing finding(s):\n` +
      renderFindingLines(findings),
    why:
      "issue-triage-routing.md — a triaged issue is routed by `.claude/VERSION::type`, never by " +
      "repo convenience. This repo declares `coc-project`, a downstream consumer: it routes UP to " +
      "the template it pulled from (`/codify` Step 7c PR to the template inbox, primary; a Route-A " +
      "issue on the template, fallback). An issue filed on its own repo is an orphan that is never " +
      "pulled upstream; one filed off-lane bypasses USE-template review and loses provenance. " +
      "This finding is ADVISORY and cannot stop the call: whether THIS issue is a COC-method fix " +
      "the routing table governs, or an ordinary operational issue, is not carried by any token in " +
      "the command, and `hook-output-discipline.md` MUST-2 caps a detector at its weakest half.",
    agent_must_report: [
      "Name the finding's rule_id and state the destination you intend.",
      "If this is a COC-method fix: re-target it UP — `/codify` Step 7c PR to the template inbox " +
        "(primary), or a Route-A issue on the template declared in `.claude/VERSION::upstream.repo` " +
        "(fallback). Never your own repo; never loom.",
      "If this is an ordinary operational issue that the routing table does not govern, say so in " +
        "one line and proceed — that stated line is the record for this tier.",
    ],
    agent_must_wait:
      "Re-target the filing or proceed with your stated reason — this is not a block.",
    user_summary: `issue-triage-routing — ${ruleIds.join(", ")} on a gh issue create (not blocked)`,
  });
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). It arms the fallback timer the
// file used to arm at load time, then runs main() with the SAME catch handler.
function hookMain() {
  fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
  if (typeof fallback.unref === "function") fallback.unref();
  return main().catch(() => passthrough(null));
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
