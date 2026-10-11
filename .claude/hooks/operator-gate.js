#!/usr/bin/env node
/**
 * @hook-event: PreToolUse:Skill (guard) — a model-invoked gate-bearing command
 *   (`/release`, `/posture upgrade|override`, `/codify`, roster ops) arrives as
 *   a `Skill` tool call, so the command name and args are visible BEFORE the
 *   skill body runs; this is the ONE registration, and it is where the gate
 *   bites.
 *
 * Hook: operator-gate
 *
 * ⛔ THE Bash AND Edit|Write|NotebookEdit REGISTRATIONS ARE REMOVED (2026-10-09),
 *   and the removal is a FIX, not a tidy-up. Two measured reasons:
 *
 *   (1) THEY COULD NEVER TRIGGER. detectTrigger resolves a command surface; a
 *       raw shell string and an edit payload carry none, so both rows returned
 *       null on every call. A registration that cannot fire is a claim of
 *       coverage with nothing behind it (hook-event-selection.md's
 *       discrimination test), and the sibling dead arm — `toolName ===
 *       "SlashCommand"`, a tool the 2.1.294 host does not ship — was retired in
 *       the same change.
 *   (2) THEY CAUSED FALSE REFUSALS ON CODEX, including on READS. The Codex
 *       policy extractor (`codex-mcp-guard/extract-policies.mjs`) derives a
 *       hook's `cc_matchers` from its REGISTRATIONS and fans them into the
 *       Codex `shell` / `apply_patch` / `unified_exec` policy tables; the Codex
 *       runtime fails every policy CLOSED, so once the rows declared
 *       `on_incomplete: "deny"` an operator-gate TIMEOUT refused the call —
 *       observed as "Policy operator-gate.js could not run (timeout)" on an
 *       ordinary bounded source read under load. Removing the rows takes this
 *       hook out of that table entirely: with no CC matcher there is no Codex
 *       tool fan-out (the apply_patch arm was marker-gated ON TOP of a matcher,
 *       so the marker alone never created one).
 *
 *   The `@coc-codex-edit-gate` marker went with them: its sole function was to
 *   fan a CC EDIT-matcher registration into the apply_patch lane, and with no
 *   edit registration there is nothing to fan. The Codex lanes therefore carry
 *   no operator-gate policy at all — the correct state for a gate that can only
 *   read a model-invoked command surface, and the state that stops the
 *   timeout-refusal lockout.
 *
 * Event: PreToolUse
 *
 * Trigger: lexical match on the MODEL-INVOKED command surface (the `Skill`
 *   tool's `skill`/`name` field), for the gate-bearing commands:
 *   - release          (release authorization)
 *   - posture upgrade
 *   - posture override
 *   - codify           (new-rule codify per R5-C-06)
 *   - whoami --register / --depart (roster-op slash commands)
 *
 * ⛔ MEASURED DEFECTS THIS FILE PREVIOUSLY CARRIED, AND THE FIX
 *
 * Shard C2 (workspaces/multi-operator-coc, design v11 §4.3 + §6.4) shipped this
 * gate wired to `tool_name === "SlashCommand"`. A read-only security review
 * returned CONFIRMED-UNENFORCED; the claims were then RE-MEASURED on the real
 * tree (installed host 2.1.294 binary + this repo's registry), and all three
 * hold:
 *
 *   (1) NO SUCH TOOL. `SlashCommand` appears 0 times in the 2.1.294 binary as
 *       a tool NAME (`grep -a -o 'name:"SlashCommand"'` and `'"SlashCommand"'`
 *       both return empty against 13 hits for `"Skill"`), while this hook was
 *       registered at `PreToolUse:Bash` + `PreToolUse:Edit|Write|NotebookEdit`
 *       only (.claude/hooks/dispatch-registry.json). So detectTrigger could
 *       never fire: the branch keyed on a tool name the host never sends.
 *       FIX: the trigger reads the `Skill` surface — the model-invoked command
 *       path (`.claude/hooks/analyze-completeness-guard.js` is the sibling
 *       precedent, registered on the same matcher).
 *
 *   (2) NO TEETH. The rejection was `severity: "halt-and-report"` (continue:true,
 *       exit 0) and every registry row declared `on_incomplete: "continue"` —
 *       a gate that reported a refusal without refusing. FIX: `severity:
 *       "block"` (exit 2 + `permissionDecision: "deny"`, the shape
 *       lib/instruct-and-wait.js emits at PreToolUse), the registry rows
 *       declare `on_incomplete: "deny"`, and the hook's own timeout fallback
 *       flips to fail-CLOSED once the trigger has fired.
 *
 *   (3) NO SERVER-SIDE EVIDENCE. Every input — requester identity, roster,
 *       folded state — was read from `tool_input`, so a caller could supply a
 *       roster containing its own fabricated "approver" and pass. FIX: the
 *       requester identity, the roster and the folded state are all resolved
 *       SERVER-SIDE (see § Evidence chain below); the payload supplies only the
 *       action (the skill name) and the invocations's own nonce.
 *
 * Enforcement-surface parity (security.md § Identity-derivation parity): the
 * predecessor of this fix (loom#1440) already server-derived the two GitHub
 * logins from the roster — but from a CALLER-SUPPLIED roster, which left the
 * derivation anchored to an attacker-chosen root. Both halves now read the
 * COMMITTED roster at HEAD.
 *
 * § Evidence chain — every load-bearing input and where it comes from
 *
 *   repoDir          SERVER       `lib/repo-dir-override.js::resolveRepoDirBound`
 *                                 (the payload's `cwd`, with the env override
 *                                 honoured only when it names the same repo)
 *   coordination ON  SERVER       `lib/coordination-mode.js::isCoordinationEnabled`
 *                                 — the substrate's ONE opt-in switch. OFF
 *                                 (solo repo) ⇒ passthrough: no gate is owed.
 *   requester id     SERVER       `lib/operator-id.js::resolveIdentity` — the
 *                                 key this machine is configured to sign with,
 *                                 bound through the roster to a person_id.
 *   roster           SERVER       `lib/burndown-events.js::readCommittedRoster`
 *                                 — `git show HEAD:.claude/operators.roster.json`.
 *                                 A working-tree roster is a trust root the
 *                                 adversary can write; HEAD is the reviewed one.
 *   folded state     SERVER       the coordination log at
 *                                 `<stateDir>/coordination-log.jsonl`, folded
 *                                 with the COMMITTED roster (structural fold —
 *                                 see the note on `skipSignatureVerify` below).
 *   approval         PAYLOAD      the signed `gate_approval` record, verified
 *                                 against the COMMITTED roster; its canonical
 *                                 bytes bind target_tool + requester_person_id +
 *                                 requester_verified_id + approver_verified_id +
 *                                 consumed_nonce + ts, and the requester half is
 *                                 now the SERVER-derived identity.
 *   action + nonce   PAYLOAD      the skill name (what is being gated) and the
 *                                 requester's own nonce. Neither grants
 *                                 authority; the nonce is the challenge the
 *                                 approver signs over.
 *
 * A payload-supplied `requester_person_id` / `requester_verified_id` is NOT
 * trusted: when present it MUST equal the server-derived identity, and a
 * mismatch refuses. Silence about the identity is not agreement either — the
 * server value is used regardless.
 *
 * § Residual — the USER-TYPED command surface is NOT gated (measured bound)
 *
 * A user who TYPES `/release` does not produce a tool call: the host expands
 * the command and runs its body. The event that sees that expansion is
 * `UserPromptExpansion` (payload `command_name`, `command_args`,
 * `command_source`, `prompt`; expansion_type `slash_command`), and it CAN
 * refuse: MEASURED in the installed 2.1.294 binary, the expansion loop returns
 * `{blocked:{shouldQuery:false}}` on a hook `blockingError`, and the host's own
 * block payload for the event is
 * `{decision:"block", reason, hookSpecificOutput:{hookEventName:"UserPromptExpansion",
 * suppressOriginalPrompt:true}}`. `UserPromptSubmit` is NOT the arm: that event
 * carries only `prompt`, and the host's own drop-reason string enumerates "a
 * command" among the cases that never go through `prompt.submit`.
 *
 * This tree cannot register at `UserPromptExpansion` today: the registry
 * contract's `EVENT_ORDER` / `EVENT_DEFAULTS` / `PROTOCOL_KIND_BY_EVENT`
 * (lib/hook-registry-contract.js) and the registry schema's event enum carry
 * exactly eight events and REFUSE anything else ("An event outside this enum is
 * refused by the emitter"), and `hook-event-selection.md` MUST-3 admits a
 * `guard` only at PreToolUse/PostToolUse. Adding the ninth event is a
 * platform-model change (contract + emitter + settings + dispatch + engine
 * merge + the validator's event vocabulary + that rule's table + its 26
 * fixtures and probe suite) and is NOT made here. The model-invoked `Skill`
 * arm above gates every agent-driven invocation; a human-typed invocation
 * remains un-gated until the UserPromptExpansion surface lands.
 *
 * § Why the folded `gate-approval` RECORD is not the evidence source (yet)
 *
 * The intended endpoint is that the approval is a signed `gate-approval` record
 * in the coordination log, and this gate consumes it by `consumed_nonce`
 * (commands/release.md and commands/posture.md already describe that shape).
 * It is NOT implementable today, measured:
 *   - no producer: `gate-approval.js::emitGateApproval` has zero production
 *     callers (specs/methodology/signing-agent-contract.md), and
 *   - emission is BLOCKED without the off-loom hardware-presence broker:
 *     `coc-emit.js` refuses an actuation record whose `content.presence_proof`
 *     is not a PROVEN broker proof (actuation-types.js ACTUATION_RECORD_TYPES),
 *     and that broker is an enterprise-product milestone.
 * Requiring a folded record would therefore make the gate UNSATISFIABLE for
 * every multi-operator repo, and consuming folded actuation records activates
 * the deferred presence-attribution consumer contract in one step — the one
 * recorded at `specs/methodology/signing-agent-non-mintability.md` R4 and
 * journal/0510 N-4, whose field names are deliberately NOT repeated here (the
 * #1442 A sweep reads this whole file for them, and a prose mention is not a
 * consumer). The in-payload approval, re-anchored to server-derived identity +
 * the committed roster, is the strongest available arm; the folded-record
 * consumer lands with the broker and that attribution contract.
 *
 * § Residual — owner-departure settlement is CORROBORATED, not fully settled
 *
 * The removal-only recovery row's `revocationSettled` was a caller-supplied
 * boolean, which made an owner removal self-servable; it is now derived from the
 * folded log (an ACCEPTED `collaborator-distinctness-revocation` naming the
 * departing victim and carrying the fold's explicit `rule10_contested: false`
 * must exist — departureRevocation; until the fold stamps that verdict, none
 * does). That is the settlement half a PreToolUse hook can answer. The other
 * half — `fold-rule-10.js::isSettled` (R10-S-01) — needs the peer high-water for
 * the victim's chain, which only the peer-high-water fetch mechanism has, so a
 * hook that claimed "settled" would be inventing it. Refusing there would make
 * the documented R7-A-03 recovery unsatisfiable for the very case it exists for;
 * corroboration is the defensible middle, and the full-settlement consumer is a
 * named residual, not a silent substitution.
 *
 * Hook output discipline (rules/hook-output-discipline.md):
 *   - All refusal paths emit via lib/instruct-and-wait.js::emit() with all
 *     six fields populated (MUST-1).
 *   - The trigger is LEXICAL on the command surface, so the row is a `guard`
 *     at a PreToolUse tool axis; refusal is `severity: "block"` (exit 2 +
 *     permissionDecision deny), NOT a halt-and-report.
 *   - Command-string detector skips shell-variable references (MUST-3).
 *   - Audit fixtures committed at .claude/audit-fixtures/operator-gate/
 *     one per scope-restriction predicate (MUST-4 + cc-artifacts.md
 *     Rule 9).
 *
 * Cross-shard contracts consumed:
 *   - lib/gate-matrix.js — the §6.4 matrix + evaluator (C2 sibling).
 *   - lib/eligibility.js — isEligibleSigner (A0b-2c, shared with B3b).
 *   - lib/r9s02-fence.js — R9-S-02 fence (A0b-2c, shared with C2).
 *   - lib/instruct-and-wait.js — canonical hook output shape (M0).
 *
 * Mitigates cc-artifacts.md Rule 7 (setTimeout fallback).
 */

"use strict";

/**
 * @hook-contract
 * {
 *   "side_effects": {
 *     "fs_writes": [
 *       "<os.tmpdir()>/coc-sign-<mkdtemp-suffix>"
 *     ],
 *     "network": false,
 *     "spawns": ["git","gpg","ssh-keygen"]
 *   },
 *   "idempotent": true,
 *   "may_rewrite_input": false,
 *   "notes": "This file itself only writes stdout/stderr; the one fs target comes from the co-signer verification it delegates to (lib/gate-approval.js -> lib/coc-sign.js verify), which creates an ephemeral signing/verify homedir under the OS tmp root and removes it. spawns: the ssh-keygen/gpg verification that homedir serves, plus the git probes this file now makes server-side — lib/operator-id.js::resolveIdentity (git config / fingerprint discovery) and lib/burndown-events.js::readCommittedRoster (`git show HEAD:<roster>`); every one of them is a READ. Repeat of the same payload on the same tree = same verdict, no durable state, so idempotent."
 * }
 */

const TIMEOUT_MS = 5000;
// TIMEOUT_MS fallback — per cc-artifacts.md Rule 7: a hook MUST return
// {continue: true} and exit if it does not produce its own output within
// the timeout. TWO-DIRECTIONAL (the shape integrity-guard.js ships): a
// pass-through call that has not reached the trigger is none of this gate's
// business, so the fallback is fail-OPEN there; once the trigger has FIRED on
// a coordination-ENABLED repo the only outstanding question is the
// authorization verdict, and "I could not determine" must not resolve to
// "yes" — `triggerFired` flips the same timer to fail-CLOSED (refuse).
let fallback = null;
// Flips to "deny" the moment a gate-bearing surface is recognised on an
// enrolled repo. Never flips back: a later passthrough clears the timer.
let fallbackDisposition = "allow";

const path = require("path");
const { emit, instructAndWait } = require(
  path.join(__dirname, "lib", "instruct-and-wait.js"),
);
const { evaluateGate, findRow } = require(
  path.join(__dirname, "lib", "gate-matrix.js"),
);
const { verifyGateApproval, normalizeGateCommand } = require(
  path.join(__dirname, "lib", "gate-approval.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/**
 * The refusal payload — severity "block" at PreToolUse: exit 2 plus
 * hookSpecificOutput.permissionDecision "deny", the two channels the host
 * reads to refuse a tool call (lib/instruct-and-wait.js).
 */
function emitGateBlock(gate, reason, surface) {
  clearTimeout(fallback);
  const cmdHead = String(surface || "").slice(0, 80);
  const reasonHead = String(reason || "").slice(0, 400);
  emit({
    hookEvent: "PreToolUse",
    severity: "block",
    what_happened: `operator-gate refused '${gate}': ${cmdHead}`,
    why: `operator-gate/${gate} — ${reasonHead}`,
    agent_must_report: [
      `State the gate that fired: '${gate}' (§6.4)`,
      `Quote the rejection reason: ${reasonHead}`,
      "Identify the requester person_id (server-resolved) and the missing/insufficient approver",
      "Propose remediation in this turn — do NOT file a follow-up issue (autonomous-execution.md MUST Rule 4)",
    ],
    agent_must_wait:
      "Do not retry the gated action. Surface the rejection to the user and wait for explicit approval or remediation.",
    user_summary: `operator-gate BLOCKED ${gate}: ${reasonHead.slice(0, 60)}`,
  });
}

/**
 * Emit a passthrough-with-audit-marker for degenerate self-sign rows.
 * The audit marker is logged on stderr but does NOT refuse the call.
 */
function passthroughWithAudit(gate, verdict) {
  clearTimeout(fallback);
  process.stderr.write(
    `[operator-gate] ${gate} ALLOWED with audit marker: ${verdict.audit_marker}\n`,
  );
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// ---- trigger detection ------------------------------------------------------

/**
 * Normalize a Skill invocation's command name: strip a leading `/`, take the
 * first token, lowercase. `/release` → `release`; `posture upgrade` → `posture`.
 * Same shape as the sibling `analyze-completeness-guard.js::skillNameOf`, so the
 * two Skill-matcher guards read one payload dialect.
 */
function skillNameOf(toolInput) {
  const ti = toolInput || {};
  const raw = ti.skill || ti.name || ti.command || "";
  return String(raw)
    .trim()
    .replace(/^\//, "")
    .toLowerCase()
    .split(/[\s/]+/)[0];
}

/**
 * The args of a Skill invocation. The host may carry them in `args`
 * (`/release --approval X` → skill "release", args "--approval X") or inline in
 * the name string; both dialects resolve.
 */
function skillArgsOf(toolInput) {
  const ti = toolInput || {};
  if (typeof ti.args === "string" && ti.args.trim()) return ti.args.trim();
  const raw = String(ti.skill || ti.name || ti.command || "").trim();
  const m = raw.match(/^\/?([\s\S]*?)\s+([\s\S]*)$/);
  if (!m) return "";
  return m[2].trim();
}

/**
 * The departing victim a `/whoami --depart <login>` invocation names — the one
 * identity the owner-departure row removes, and the one the co-signer's approval
 * binds (its signed `command` is normalizeGateCommand over these same args). It
 * is compared against a revocation's named victim in the provider's bind field
 * (lib/revocation-bind-identity.js), so it is that field's value: a login on
 * GitHub, a principal on Azure DevOps. Exactly ONE operand after `--depart`;
 * anything else — no operand, two, a `--depart=` spelling — is null, and null
 * corroborates nothing (departureRevocation), so an operand list the gate cannot
 * bind to one victim refuses rather than binding to the first of several.
 */
function departingVictimOf(toolInput) {
  const m = skillArgsOf(toolInput).match(/^--depart\s+(\S+)$/);
  return m ? m[1] : null;
}

/** The human-readable surface, for the refusal body. */
function surfaceOf(toolName, toolInput) {
  if (toolName === "Skill") {
    const name = skillNameOf(toolInput);
    const args = skillArgsOf(toolInput);
    return `/${name}${args ? ` ${args}` : ""}`;
  }
  const ti = toolInput || {};
  return typeof ti.command === "string" ? ti.command.trim() : "";
}

/**
 * Trigger detection — lexical match on the MODEL-INVOKED command surface.
 *
 * Returns the canonical gate-matrix row name, or null if no trigger fires.
 *
 * Per hook-output-discipline.md MUST-3: when the captured surface references a
 * shell variable ($VAR, ${VAR}, $(...)) or a backtick — the detector MUST
 * return null (skip). The hook cannot evaluate pre-expansion shell forms, and a
 * future arm that reads a shell string inherits this fence.
 *
 * ONLY `Skill` can return a row. `Bash` and the edit tools return null by
 * construction (an edit carries no command surface; a raw shell string is not
 * resolved here), and the registrations that used to exist for those tools are
 * REMOVED — see this file's header: they could never fire and their presence
 * was what made a Codex policy timeout refuse ordinary reads.
 */
function detectTrigger(toolName, toolInput) {
  if (!toolName || !toolInput) return null;
  if (toolName !== "Skill") return null;

  const raw = String(
    toolInput.skill || toolInput.name || toolInput.command || "",
  );
  // MUST-3 — shell forms are not resolvable at hook time.
  const surface = raw.trim();
  if (
    /^eval\s+["']?\$/.test(surface) ||
    /^\$\(/.test(surface) ||
    /^\$\{?\w+\}?\s*$/.test(surface) ||
    /^\$\(.+\)\s*$/.test(surface) ||
    /^`.+`\s*$/.test(surface)
  ) {
    return null;
  }

  const subcommand = skillNameOf(toolInput);
  if (!subcommand) return null;
  const args = skillArgsOf(toolInput);

  if (subcommand === "release") return "release";
  if (subcommand === "posture") {
    if (/^upgrade\b/.test(args)) return "posture-upgrade";
    if (/^override\b/.test(args)) return "posture-override";
    return null; // /posture (no args) is read-only — no gate
  }
  if (subcommand === "codify") {
    // R5-C-06: new-rule /codify needs second person_id signed [ack].
    // The trigger fires; downstream evaluator checks gate_approval shape.
    return "new-rule-codify";
  }
  if (subcommand === "whoami") {
    if (/^--register\b/.test(args)) return "roster-edit-add-contributor";
    if (/^--depart\b/.test(args)) return "owner-departure-roster-removal";
    return null;
  }
  return null;
}

// ---- server-side evidence ---------------------------------------------------

/**
 * Resolve the roster person bound to a person_id from the COMMITTED roster.
 * Prototype-safe lookup (`hasOwnProperty`): a bare `roster.persons[pid]`
 * resolves truthy for inherited Object keys ("constructor", "toString", …),
 * which would hand the caller a non-person object to read `github_login` off.
 * Same guard as the sibling persons lookups in add-key-ceremony.js
 * ::runAddKeyCeremony and genesis-anchor-guard.js::verifyRecord.
 */
function committedPerson(roster, personId) {
  if (!roster || typeof roster !== "object") return null;
  const persons = roster.persons;
  if (!persons || typeof persons !== "object") return null;
  if (typeof personId !== "string" || !personId) return null;
  if (!Object.prototype.hasOwnProperty.call(persons, personId)) return null;
  const person = persons[personId];
  if (!person || typeof person !== "object") return null;
  return person;
}

/**
 * Does the COMMITTED roster bind the given fingerprint to the given person_id?
 * This is the cross-check that keeps the server-derived identity honest: a
 * person_id claimed by the working-tree roster must still resolve, by
 * fingerprint, to the SAME person in the committed one.
 */
function committedKeyBindsPerson(roster, personId, verifiedId) {
  const person = committedPerson(roster, personId);
  if (!person) return false;
  const keys = Array.isArray(person.keys) ? person.keys : [];
  return keys.some((k) => k && k.fingerprint === verifiedId);
}

/**
 * The commit this gate binds an approval to: the repo's CURRENT HEAD, read
 * through the same git-profile env helper the committed-roster read uses (an
 * ambient GIT_DIR / GIT_* steering must not be able to name a different tree).
 *
 * WHAT THIS IS FOR (2026-10-09 replay closure): the approval's signed bytes
 * carry a `target_sha`, and the gate compares it against THIS value, so a
 * signature that proves "an owner approved releasing commit X" cannot admit a
 * release of commit Y. What it deliberately is NOT: a claim that HEAD is the
 * release artifact — it is the concrete, server-derivable referent both sides
 * can name, and binding to it makes "the approval has been overtaken" a
 * REFUSAL rather than a silent pass.
 *
 * Returns the 40-hex sha, or null when HEAD cannot be resolved (the caller
 * refuses — fail-closed; an unresolvable referent is not a matching one).
 */
function resolveTargetSha(repoDir) {
  try {
    const { execFileSync } = require("child_process");
    const { resolveGitBinary, gitEnvForArgs } = require(
      path.join(__dirname, "lib", "git-subprocess-env.js"),
    );
    const gitBin = resolveGitBinary();
    if (!gitBin) return null;
    const args = ["rev-parse", "HEAD"];
    const out = execFileSync(gitBin, args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnvForArgs(args),
    });
    const sha = String(out || "").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Fold the coordination log against the COMMITTED roster, WITH FULL SIGNATURE
 * VERIFICATION (2026-10-09, verified-fold item).
 *
 * This is the AUTHORIZATION fold: its outputs — `derived_N` and
 * `revocationRecorded` (→ `revocationSettled`, ctx below) — gate a roster
 * removal, so it must not read a record whose signature does not verify. It
 * previously folded with `skipSignatureVerify: true` on a fail-closed-count
 * argument ("an unverified record can only INFLATE the attested-owner count").
 * MEASURED 2026-10-09: that argument covers `derived_N` but NOT
 * `revocationRecorded`, and the skip's hole is LIVE on the real log — 27
 * records of one ROSTERED signer (its whole chain; the seq-0 signature does
 * not even parse) fold ACCEPTED under the skip and REJECT under verification
 * (`workspaces/verified-fold/verify-diff-control.cjs`). A stub-signature
 * `collaborator-distinctness-revocation` therefore satisfied the corroboration
 * predicate with no signature at all (pinned by
 * tests/integration/multi-operator/verified-fold-poles.test.js, whose control
 * pole reproduces exactly that read under the skip). Verify cost on the real
 * 1072-record log: ~1.5 s cold vs ~0.7 s skip — acceptable for a gate
 * evaluation; warm cost measured during implementation.
 *
 * Every failure (absent log, unreadable log, fold throw) returns null, and a
 * null foldedState makes every degenerate row refuse.
 *
 * `departingVictim` is the identity a `/whoami --depart` invocation removes
 * (departingVictimOf); null for every other invocation. Only the
 * owner-departure corroboration below reads it.
 */
function resolveFoldedState(repoDir, roster, departingVictim) {
  let records = null;
  try {
    const fs = require("fs");
    const { resolveLogPath } = require(
      path.join(__dirname, "lib", "state-io.js"),
    );
    const { foldLog } = require(
      path.join(__dirname, "lib", "coordination-log.js"),
    );
    let raw;
    try {
      raw = fs.readFileSync(resolveLogPath(repoDir), "utf8");
    } catch {
      return null;
    }
    records = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r && typeof r === "object");
    if (records.length === 0) return null;
    // Budget arm (round-1 security F2): the fold's crypto cost is growable by
    // appended invalid records (checkpoints cannot cover rejected records), and
    // a 5s setTimeout CANNOT preempt this synchronous path — the in-tree
    // mechanism is foldLog's own deadline check BETWEEN records
    // (journal-write-guard.js's pattern). Expiry THROWS; the catch below turns
    // it into null, and null makes every degenerate row refuse (fail-closed).
    const FOLD_DEADLINE_MS = 3500; // hook budget 5000, headroom for evidence+emit
    const folded = foldLog(records, roster, {
      deadlineAtMs: Date.now() + FOLD_DEADLINE_MS,
    });
    const accepted = (folded && folded.accepted) || [];
    const corroboration = departureRevocation(
      accepted,
      (folded && folded.rejected) || [],
      roster,
      departingVictim,
    );
    return {
      records: accepted,
      derived_N:
        folded && typeof folded.derivedN === "number" ? folded.derivedN : null,
      // § owner-departure corroboration. `revocationSettled` was a
      // CALLER-SUPPLIED boolean on the removal-only recovery row, which made an
      // owner removal self-servable. The server-side substitute asks the folded
      // log the question it can answer: does an ACCEPTED
      // `collaborator-distinctness-revocation` name THE victim this invocation
      // removes, carrying the fold's EXPLICIT uncontested verdict? `accepted`
      // is wider than the uncontested set: the fold does NOT reject a
      // rule-10-contested revocation, it ADMITS it into `accepted` flagged
      // `rule10_contested: true`, so derive-n can apply the R10-A-03 exclusion
      // (lib/coordination-log.js::_foldLog, the contested-revocation branch),
      // and it stamps NOTHING on an uncontested one. So an accepted revocation
      // is not thereby an uncontested one, a revocation of a DIFFERENT person
      // corroborates nothing about this removal, and the verdict is READ —
      // `rule10_contested === false` — never inferred from the flag's absence.
      // The value is the fold's: the fold rejects any record that carries a
      // fold-derived name in its own body (lib/fold-derived-fields.js, the one
      // list both consume). `departureRevocation` applies all of it, and its
      // `detail` names the unmet condition for the refusal. Until the fold
      // stamps `false`, NO revocation corroborates (the ruled interim). WHAT
      // THIS DOES NOT ESTABLISH, named so the reader is not misled: R10-S-01's
      // fetch-bounded half (peer high-water for the victim's chain) needs a
      // peer-observation input a PreToolUse hook does not have, so full
      // settlement is NOT claimed here and `fold-rule-10.js::isSettled` is NOT
      // evaluated. This is strictly stronger than the payload boolean it
      // replaces and strictly weaker than that predicate; the residual is
      // recorded in this file's header.
      revocationRecorded: corroboration.recorded,
      revocationDetail: corroboration.detail,
    };
  } catch {
    return null;
  }
}

/**
 * Does the folded log hold a revocation that corroborates THIS departure?
 *
 * One counts only when it is (a) a `collaborator-distinctness-revocation` in
 * `accepted`, (b) naming the departing victim, and (c) carrying the fold's
 * EXPLICIT uncontested verdict, `rule10_contested === false`:
 *
 *   (b) The victim is read and compared exactly as fold rule 10's own victim
 *       collector does it (lib/coordination-log.js::_collectVictimChainEntries):
 *       the ONE shared provider resolver, pinned to the COMMITTED roster's
 *       declared provider, and that provider's comparator (`loginsEqual` /
 *       `principalsEqual`). A revocation whose victim cannot be resolved is
 *       skipped, which can only WITHHOLD corroboration, never grant it.
 *   (c) `true` is rule 10's contest verdict: the victim signed activity inside
 *       the evidence window. ABSENT is no verdict at all and is refused. The
 *       fold on this tree stamps `true` on a contested copy and nothing on an
 *       uncontested one, so until it stamps `false` (the full-stream contest)
 *       NO revocation corroborates — the interim the orchestrator ruled on.
 *
 * The verdict is the FOLD's: lib/fold-derived-fields.js lists the names only
 * the fold may compute, the fold rejects any record whose own body carries one
 * ('derived field in record body'), and this function reads the verdict only
 * under a name that list reserves — refusing outright if the name ever leaves
 * it, since a producer could then supply the value. When no accepted revocation
 * names the victim, the fold's own rule and reason for one it rejected are
 * carried into the refusal.
 *
 * @param {object[]} accepted the fold's accepted[] (the copies it stamped)
 * @param {object[]} rejected the fold's rejected[] ({record, reason, rule})
 * @returns {{recorded: boolean, detail: string|null}} `detail` names the unmet
 *   condition for the refusal: NO VICTIM / UNTRUSTED VERDICT / CONTESTED /
 *   UNCONFIRMED / NO REVOCATION (with the fold's rejection, when it has one) /
 *   VICTIM MISMATCH.
 */
function departureRevocation(accepted, rejected, roster, victim) {
  if (!victim) {
    return {
      recorded: false,
      detail:
        "NO VICTIM — the invocation does not name exactly one departing victim (`/whoami --depart <login>`), so no revocation can be bound to it",
    };
  }
  const { isDerivedField } = require(
    path.join(__dirname, "lib", "fold-derived-fields.js"),
  );
  const VERDICT = "rule10_contested";
  if (!isDerivedField(VERDICT)) {
    return {
      recorded: false,
      detail: `UNTRUSTED VERDICT — ${VERDICT} is not in the fold's derived-field list (lib/fold-derived-fields.js), so a record could carry it itself; nothing corroborates`,
    };
  }
  const { resolveBindIdentity, namedIdentity } = require(
    path.join(__dirname, "lib", "revocation-bind-identity.js"),
  );
  const expectedProvider =
    roster && roster.genesis ? roster.genesis.provider : undefined;
  const namesVictim = (r) => {
    if (!r || r.type !== "collaborator-distinctness-revocation") return null;
    const bind = resolveBindIdentity(r.content, { expectedProvider });
    if (!bind.ok) return null;
    const named = namedIdentity(r.content, bind.bindField);
    if (!named) return null;
    return bind.equals(named, victim) ? true : named;
  };
  let contested = null;
  let unconfirmed = null;
  const otherVictims = [];
  for (const r of accepted) {
    const named = namesVictim(r);
    if (named === null) continue;
    if (named !== true) {
      otherVictims.push(named);
      continue;
    }
    if (r[VERDICT] === true) {
      if (!contested) contested = r;
      continue;
    }
    if (r[VERDICT] !== false) {
      if (!unconfirmed) unconfirmed = r;
      continue;
    }
    return { recorded: true, detail: null };
  }
  const which = (r) =>
    `the revocation naming ${JSON.stringify(victim)} ` +
    `(collaborator-distinctness-revocation seq ${r.seq}, signer ${r.verified_id})`;
  if (contested) {
    return {
      recorded: false,
      detail:
        `CONTESTED — ${which(contested)} is rule10_contested: ` +
        "the victim signed activity inside its evidence window, so it corroborates nothing",
    };
  }
  if (unconfirmed) {
    return {
      recorded: false,
      detail:
        `UNCONFIRMED — ${which(unconfirmed)} carries no fold verdict (rule10_contested is not false), ` +
        "so it cannot corroborate this removal",
    };
  }
  // No accepted revocation names the victim. If the fold turned one away — a
  // body carrying a derived field, a signature that did not verify — its own
  // rule and reason say why, so the refusal carries them rather than only the
  // absence. Matched with the same victim binding, so a rejected revocation of
  // someone else is never reported as this victim's.
  const turnedAway = rejected.find((e) => e && namesVictim(e.record) === true);
  if (turnedAway) {
    return {
      recorded: false,
      detail:
        `NO REVOCATION — the folded log holds no accepted collaborator-distinctness-revocation naming ${JSON.stringify(victim)}: ` +
        `the fold rejected the one that does (${turnedAway.rule}: ${String(turnedAway.reason).slice(0, 120)})`,
    };
  }
  if (otherVictims.length > 0) {
    const shown = otherVictims.slice(0, 3).map((v) => JSON.stringify(v));
    const more =
      otherVictims.length > 3 ? ` (+${otherVictims.length - 3} more)` : "";
    return {
      recorded: false,
      detail:
        `VICTIM MISMATCH — no accepted revocation names the departing victim ${JSON.stringify(victim)}; ` +
        `the folded revocations name ${shown.join(", ")}${more}`,
    };
  }
  return {
    recorded: false,
    detail:
      "NO REVOCATION — the folded log holds no accepted collaborator-distinctness-revocation (a record that fails verification is not accepted)",
  };
}

/**
 * Build the SERVER-SIDE half of the evaluator context. Every field here is
 * derived from the machine's identity, the committed roster and the folded log;
 * NOTHING is read from the caller's payload.
 *
 * @returns {{ok:true, requester:object, requesterPerson:object, roster:object,
 *            foldedState:object|null} |
 *           {ok:false, reason:string, code:string}}
 */
function resolveServerEvidence(repoDir, toolInput) {
  const { resolveIdentity } = require(
    path.join(__dirname, "lib", "operator-id.js"),
  );
  const { readCommittedRoster } = require(
    path.join(__dirname, "lib", "burndown-events.js"),
  );

  let identity;
  try {
    identity = resolveIdentity(repoDir, {});
  } catch (err) {
    return {
      ok: false,
      code: "identity-unresolved",
      reason: `operator identity could not be resolved (${err && err.message ? err.message : String(err)}); the gate cannot bind a requester, so it refuses (fail-closed)`,
    };
  }
  if (
    !identity ||
    typeof identity.verified_id !== "string" ||
    !identity.verified_id ||
    typeof identity.person_id !== "string" ||
    !identity.person_id
  ) {
    return {
      ok: false,
      code: "identity-unresolved",
      reason:
        "no rostered signing identity resolves for this machine (resolveIdentity found no roster-bound key), so the requester cannot be bound to an approval — fix the signing key / roster enrollment, then retry",
    };
  }

  const rosterRead = readCommittedRoster(repoDir);
  if (!rosterRead || rosterRead.ok !== true || !rosterRead.roster) {
    return {
      ok: false,
      code: "roster-unreadable",
      reason:
        `the COMMITTED roster could not be read at HEAD (${(rosterRead && rosterRead.reason) || "unknown failure"}). ` +
        "The gate reads HEAD rather than the working tree because a working-tree roster is a trust root the adversary can write; commit the roster, then retry",
    };
  }
  const roster = rosterRead.roster;

  if (
    !committedKeyBindsPerson(roster, identity.person_id, identity.verified_id)
  ) {
    return {
      ok: false,
      code: "identity-not-committed",
      reason: `the session identity (person '${identity.person_id}') is not bound in the COMMITTED roster — the working-tree roster and HEAD disagree, or the enrollment was never committed; reconcile and commit the roster, then retry`,
    };
  }

  const requesterPerson = committedPerson(roster, identity.person_id);
  // Enforcement-surface parity (#1440 + this fix): both identities in the
  // R5-S-07 distinctness check come from the SAME committed roster. A payload
  // that states its own requester identity must AGREE with this one.
  const claimedPersonId = toolInput && toolInput.requester_person_id;
  if (
    typeof claimedPersonId === "string" &&
    claimedPersonId &&
    claimedPersonId !== identity.person_id
  ) {
    return {
      ok: false,
      code: "requester-identity-mismatch",
      reason: `the payload claims requester_person_id '${claimedPersonId}' but this session's roster-resolved identity is '${identity.person_id}' — the requester half of a gate-approval is SERVER-derived and cannot be chosen by the caller`,
    };
  }
  const claimedVerifiedId = toolInput && toolInput.requester_verified_id;
  if (
    typeof claimedVerifiedId === "string" &&
    claimedVerifiedId &&
    claimedVerifiedId !== identity.verified_id
  ) {
    return {
      ok: false,
      code: "requester-identity-mismatch",
      reason: `the payload claims requester_verified_id '${claimedVerifiedId}' but this session signs as '${identity.verified_id}' — the requester half of a gate-approval is SERVER-derived and cannot be chosen by the caller`,
    };
  }

  const requester = {
    person_id: identity.person_id,
    verified_id: identity.verified_id,
    gh_login:
      requesterPerson && typeof requesterPerson.github_login === "string"
        ? requesterPerson.github_login
        : null,
  };

  return {
    ok: true,
    requester,
    requesterPerson,
    roster,
    foldedState: resolveFoldedState(
      repoDir,
      roster,
      departingVictimOf(toolInput),
    ),
  };
}

/**
 * Build the gate-evaluator context from SERVER-side evidence plus the two
 * things the payload legitimately carries: the action being gated (already
 * lexical) and the requester's own nonce.
 *
 * `verifiedApprover` is the {approverPerson, approverPersonId} record returned
 * by verifyGateApproval AFTER the signature verified against the committed
 * roster; until it exists the evaluator sees a null approver, so a caller
 * cannot inject role claims.
 */
function buildEvalCtx(gate, evidence, verifiedApprover) {
  const approver = verifiedApprover
    ? {
        person_id: verifiedApprover.approverPersonId,
        gh_login:
          verifiedApprover.approverPerson &&
          typeof verifiedApprover.approverPerson.github_login === "string"
            ? verifiedApprover.approverPerson.github_login
            : null,
      }
    : { person_id: null, gh_login: null };
  return {
    gate,
    requester: evidence.requester,
    approver,
    requesterPerson: evidence.requesterPerson,
    approverPerson:
      (verifiedApprover && verifiedApprover.approverPerson) || null,
    roster: evidence.roster,
    foldedState: evidence.foldedState,
    // Owner-departure recovery (row `owner-departure-roster-removal`) is the one
    // self-approvable roster row. Both of its preconditions were caller-supplied
    // claims; both are now SERVER-side:
    //   rosterEditKind  — derived from the command itself: this row is only
    //                     reachable through `/whoami --depart`, which IS a
    //                     removal. A caller can no longer claim "removal" for
    //                     an owner-ADD.
    //   revocationSettled — derived from the folded log's accepted revocation
    //                     record (see resolveFoldedState § owner-departure
    //                     corroboration). A caller can no longer assert a
    //                     settled revocation that never happened.
    rosterEditKind:
      gate === "owner-departure-roster-removal" ? "removal" : null,
    revocationSettled: !!(
      evidence.foldedState && evidence.foldedState.revocationRecorded === true
    ),
    // WHICH precondition is unmet when `revocationSettled` is false, so the
    // matrix's refusal names it rather than one sentence for every cause.
    revocationUnsettledReason: evidence.foldedState
      ? evidence.foldedState.revocationDetail
      : "NO FOLDED LOG — the coordination log is absent, empty or unreadable, or its fold failed, so no revocation can corroborate this removal",
  };
}

// ---- main -------------------------------------------------------------------

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Everything a standalone run
// did at load time happens here instead, so a require() has no side effects.
function hookMain() {
  fallback = setTimeout(() => {
    if (fallbackDisposition === "deny") {
      // Fail-CLOSED: the trigger already fired on an enrolled repo, so the
      // only outstanding question is the authorization verdict.
      const out = instructAndWait({
        hookEvent: "PreToolUse",
        severity: "block",
        what_happened:
          "operator-gate could not reach a verdict inside its budget",
        why: "operator-gate — the hook's own timeout expired after a gate-bearing command was recognised, and an undetermined authorization is a refusal",
        agent_must_report: [
          "State that operator-gate timed out before answering its authorization question",
          "Do NOT retry the gated command — re-run it after the underlying stall (git roster read, fold, signature verify) is understood",
        ],
        agent_must_wait:
          "Do not retry the gated action until the stall is understood.",
        user_summary: "operator-gate refused (timeout, fail-closed)",
      });
      process.stdout.write(JSON.stringify(out.json) + "\n");
      process.exit(out.exitCode);
    }
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
    process.exit(1); // timeout fallback
  }, TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let input = "";
    if (process.stdin.isTTY) {
      passthrough();
    } else {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (input += c));
      process.stdin.on("end", () => {
        try {
          onStdinEnd(input);
        } catch (e) {
          return reject(e);
        }
        resolve();
      });
    }
  });
}

function onStdinEnd(input) {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {
    return passthrough();
  }
  const event = data.hook_event_name || data.hookEventName || "";
  if (event !== "PreToolUse") return passthrough();

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  const surface = surfaceOf(toolName, toolInput);

  // Trigger detection (lexical; null on shell-variable references per MUST-3,
  // and null for every surface but the model-invoked Skill command).
  const gate = detectTrigger(toolName, toolInput);
  if (!gate) return passthrough();

  // The §6.4 row exists?
  const row = findRow(gate);
  if (!row) return passthrough();

  // `row.signing_context === "n/a"` rows (single-operator plan; owner-departure
  // removal-only recovery) carry no co-signature requirement. They still
  // evaluate (the matrix decides), and the evidence below is only read when the
  // row needs it.

  // ---- coordination OFF ⇒ passthrough (the substrate's ONE opt-in switch) ---
  const { resolveRepoDirBound } = require(
    path.join(__dirname, "lib", "repo-dir-override.js"),
  );
  const repoDir = resolveRepoDirBound(data, {
    hookName: "operator-gate",
  }).repoDir;
  const { isCoordinationEnabled } = require(
    path.join(__dirname, "lib", "coordination-mode.js"),
  );
  let coordinationOn = false;
  try {
    coordinationOn = isCoordinationEnabled(repoDir) === true;
  } catch {
    coordinationOn = false;
  }
  if (!coordinationOn) return passthrough();

  // Past this line the gate is ARMED on an enrolled repo: an unresolved
  // question must refuse.
  fallbackDisposition = "deny";

  // ---- server-side evidence -------------------------------------------------
  let evidence;
  try {
    evidence = resolveServerEvidence(repoDir, toolInput);
  } catch (err) {
    return emitGateBlock(
      gate,
      `server-evidence error: ${err && err.message ? err.message : String(err)}`,
      surface,
    );
  }
  if (!evidence.ok) {
    return emitGateBlock(gate, evidence.reason, surface);
  }

  // ---- signed approval, verified against the COMMITTED roster ---------------
  // F14 MED-1 + MED-2: for rows requiring a co-signer, cryptographically verify
  // the gate_approval payload BEFORE consulting the gate matrix. The verifier
  // checks: sig present + signature valid + target_tool == current gate +
  // consumed_nonce == requester_nonce + ts within 24h + approver_verified_id
  // resolves to a roster person eligible to sign gate-approval (R5-S-04 +
  // role-floor via isEligibleSigner). Until verify succeeds, the gate-matrix is
  // consulted ONLY against a null approver — the caller cannot inject role
  // claims.
  let verifiedApprover = null;
  if (row.signing_context !== "n/a") {
    if (!toolInput.gate_approval) {
      return emitGateBlock(
        gate,
        `row '${gate}' requires a signed gate-approval record (signing_context='${row.signing_context}'); none provided`,
        surface,
      );
    }
    // REPLAY CLOSURE (2026-10-09): the two values the approval is bound to are
    // derived HERE, from the live invocation and the repo — never from the
    // payload. `command` comes from the same normalization the minting side is
    // documented to use (one shared helper); `target_sha` is the repo's HEAD.
    const currentCommand = normalizeGateCommand(
      skillNameOf(toolInput),
      skillArgsOf(toolInput),
    );
    const currentSha = resolveTargetSha(repoDir);
    if (!currentSha) {
      return emitGateBlock(
        gate,
        "the repo's HEAD commit could not be resolved, so no gate-approval can be bound to an action — refusing (fail-closed; an unresolvable referent is not a matching one)",
        surface,
      );
    }
    const verifyResult = verifyGateApproval(toolInput.gate_approval, {
      gate,
      // SPEED OF THE SERVER-DERIVED REQUESTER: the canonical bytes the approver
      // signed bind these two fields, so a payload naming another person makes
      // the signature fail — the caller cannot choose the requester.
      requester_person_id: evidence.requester.person_id,
      requester_verified_id: evidence.requester.verified_id,
      requester_nonce: toolInput.requester_nonce || "",
      // The action binding: the approval must name THIS command and THIS commit.
      command: currentCommand,
      target_sha: currentSha,
      roster: evidence.roster,
    });
    if (!verifyResult.ok) {
      return emitGateBlock(
        gate,
        `gate-approval verify failed: ${verifyResult.reason}`,
        surface,
      );
    }
    verifiedApprover = verifyResult;
  }

  // Build the evaluator context and run.
  const ctx = buildEvalCtx(gate, evidence, verifiedApprover);

  let verdict;
  try {
    verdict = evaluateGate(ctx);
  } catch (err) {
    // Defensive — any unexpected error becomes a refusal, never a silent
    // passthrough (rules/zero-tolerance.md Rule 3).
    return emitGateBlock(
      gate,
      `evaluator error: ${err && err.message ? err.message : String(err)}`,
      surface,
    );
  }

  // Authority can only narrow downstream of the server-resolved evidence: an
  // evaluator that ALLOWED while the signed approver failed to verify would be
  // the same fail-open class this fix removes.
  if (
    row.signing_context !== "n/a" &&
    !verifiedApprover &&
    !verdict.audit_marker
  ) {
    return emitGateBlock(
      gate,
      "the gate evaluator allowed the call but no verified approver was established — refusing (fail-closed)",
      surface,
    );
  }

  if (!verdict.allowed) {
    return emitGateBlock(gate, verdict.reason, surface);
  }
  if (verdict.audit_marker) {
    return passthroughWithAudit(gate, verdict);
  }
  return passthrough();
}

module.exports = { hookMain, detectTrigger, departureRevocation };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
