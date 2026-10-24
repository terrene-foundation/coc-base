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
 *   - whoami --register / --owner-add  (roster-op slash commands; both route to
 *     the roster-edit-add row, whose approval requirement is the gate)
 *   - whoami --owner-depart            (roster-op slash command; the legacy
 *     `--depart` spelling is aliased to the same row)
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
 *       declare `on_incomplete: "deny"`, and the run is bounded by
 *       `lib/guard-runner.js::runGuard`, which refuses on any timeout, crash or
 *       unreadable payload (it once failed open before the trigger fired).
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
 * Runs on guard-runner.js::runGuard (cc-artifacts.md Rule 7, deny-capable rows):
 * the runner reads the payload and bounds the run, and a crash, a hang past the
 * budget or an unreadable payload REFUSES — before or after the trigger fires.
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

// The run budget outside the engine (the registry row's own timeout bounds it
// inside) — guard-runner.js::runGuard. A run that does not reach a verdict in it
// is a budget REFUSAL whether or not the trigger had fired: the former fallback
// failed OPEN before the trigger, and a gate-bearing call that stalls before its
// trigger is recognised is exactly the call that must not pass on a timeout.
const TIMEOUT_MS = 5000;

const path = require("path");
const { emit } = require(
  path.join(__dirname, "lib", "instruct-and-wait.js"),
);
const { runGuard } = require(path.join(__dirname, "lib", "guard-runner.js"));
const { evaluateGate, findRow } = require(
  path.join(__dirname, "lib", "gate-matrix.js"),
);
const { verifyGateApproval, normalizeGateCommand } = require(
  path.join(__dirname, "lib", "gate-approval.js"),
);
// The ONE provider→bind-field resolver + comparator pair (same module fold
// rule 10's victim collector, derive-n and recovery-fallback resolve through),
// used here to name a revocation's victim and to compare the requester's bound
// login against the live-owner set.
const { resolveBindIdentity, namedIdentity } = require(
  path.join(__dirname, "lib", "revocation-bind-identity.js"),
);

function passthrough() {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/**
 * The refusal payload — severity "block" at PreToolUse: exit 2 plus
 * hookSpecificOutput.permissionDecision "deny", the two channels the host
 * reads to refuse a tool call (lib/instruct-and-wait.js).
 */
function emitGateBlock(gate, reason, surface) {
  const cmdHead = String(surface || "").slice(0, 80);
  const reasonHead = String(reason || "").slice(0, 400);
  return emit({
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
  // ARRAY shape (2026-10-09, round-2 guard-side finding). The host has been
  // observed sending `args` as an ARRAY of tokens; the string-only read dropped
  // it, the invocation then resolved to NO args, no flag matched, and a gated
  // ceremony passed through UNGATED (measured by the reviewer). A token list is
  // exactly what an argv parse wants, so it is JOINED here and every consumer
  // downstream keeps reading one shape (the string).
  if (Array.isArray(ti.args)) {
    const joined = ti.args
      .filter((a) => a !== null && a !== undefined)
      .map((a) => String(a))
      .join(" ")
      .trim();
    if (joined) return joined;
  }
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
  const m = skillArgsOf(toolInput).match(/^--(?:owner-)?depart\s+(\S+)$/);
  return m ? m[1] : null;
}

/**
 * The FLAG set of a Skill invocation's args, parsed as argv: whitespace-split,
 * each token reduced to its flag half (the part before `=`, so
 * `--owner-depart=bob` matches) and lowercased. Tokens that are operands
 * (`bob`) land in the set too and are never looked up — membership is only ever
 * tested against declared flag spellings, so an operand cannot accidentally
 * select a row. Returns a Set, so callers cannot depend on position.
 */
function _argvFlags(args) {
  const out = new Set();
  for (const tok of String(args == null ? "" : args).trim().split(/\s+/)) {
    if (!tok) continue;
    out.add(tok.split("=")[0].toLowerCase());
  }
  return out;
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
    // ARGV-TOKEN MATCHING (2026-10-09, review F2). The trigger used to test
    // `^--flag` — the flag had to be the FIRST token, in the exact case the
    // matcher spelled. MEASURED misses that left gated ceremonies ungated:
    // `--OWNER-DEPART bob` (case), `--force --owner-depart bob` (preceding
    // flag), `bob --owner-depart` (flag after the operand). The surface is an
    // argv string, so it is parsed as one: tokens split on whitespace, each
    // compared case-insensitively by its flag half (the part before `=`), in
    // ANY position.
    const flags = _argvFlags(args);
    if (flags.has("--register")) return "roster-edit-add-contributor";
    // 2026-10-09 (owner-add closure): `/whoami --owner-add <login>` promoted a
    // contributor to `owner` while reaching NO gate at all — measured: the only
    // spellings this matcher recognised were `--register` and the departure
    // ones, so the MOST privileged roster edit on the surface was the least
    // gated. It routes to the SAME landed row `--register` uses
    // (`roster-edit-add-contributor`: signing_context `gate-approval`,
    // self_approvable `no`, required_signers "one owner", 4-eyes + R5-S-07
    // distinctness), so an owner-add demands a SIGNED APPROVAL from a distinct
    // owner — strictly MORE authority than the departure row's conditional
    // self-sign, which is what "at least as privileged as departing" requires.
    // NO new row, NO new condition: the row and every check in it are the
    // LANDED ones; this line is the missing registration.
    //
    // The alternative routing (map the add to the departure row so its
    // REMOVAL-ONLY arm refuses it) was CONSIDERED AND REJECTED: that arm's ctx
    // fact (`rosterEditKind`) is set from the ROW NAME, so reaching it with an
    // add would either need that derivation widened (making the row's
    // "REMOVAL-ONLY" metadata a lie for an add) or would wall off the documented
    // owner-add ceremony with no approval path at all — the row is
    // `signing_context:"n/a"`, so no signature could ever admit a legitimate
    // add. Reported to the orchestrator as a deviation from "reuse the --depart
    // path"; re-decided only on an explicit ruling.
    if (flags.has("--owner-add")) return "roster-edit-add-contributor";
    // 2026-10-09 (shipped-spelling closure): the SHIPPED ceremony spelling is
    // `--owner-depart` (`.claude/commands/whoami.md` § `/whoami --owner-depart
    // <login>`; the genesis runbook carries the same spelling). This matcher
    // read `^--depart\b`, which `--owner-depart` does NOT match — so the
    // removal ceremony reached NO gate at all, while a spelling no ceremony
    // consumes was gated. Both spellings now map to the removal row, and the
    // legacy one is kept as an EXPLICIT ALIAS rather than dropped: a spelling
    // variant of the removal surface must never reach the gate unarmed.
    if (flags.has("--owner-depart") || flags.has("--depart")) {
      return "owner-departure-roster-removal";
    }
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
 * The verified fold's own budget. The hook's outer timeout is 5s
 * (`TIMEOUT_MS`); the fold gets the larger share of it and THROWS on expiry
 * (`coordination-log.js` § opt-in fold deadline), which lands in the catch
 * below and yields a null foldedState — a refusal, never a partial fold.
 */
const FOLD_BUDGET_MS = 3000;

/**
 * Latest-owner settlement adapter, reached only after victim-bound explicit
 * uncontested corroboration (operator-gate.js:862-870).
 */
function _verifiedRevocationIsLatestForOwner(accepted, roster, derivedN, repoDir, departingVictim, trustRoot) {
  const perLoginLatest =
    derivedN && derivedN.per_login_latest ? derivedN.per_login_latest : null;
  // Fail-closed: with no derived-N index there is no settlement claim to make.
  if (!perLoginLatest) {
    return { settled: false, reason: "no derived-N index (per_login_latest) is available" };
  }
  let lastReason = "no verified, uncontested revocation is the latest distinctness record for a rostered owner login";
  const expectedProvider =
    roster && roster.genesis ? roster.genesis.provider : undefined;
  for (const rec of accepted) {
    if (!rec || rec.type !== "collaborator-distinctness-revocation") continue;
    // Belt and braces: a rule-10-CONTESTED revocation is retained in `accepted`
    // flagged (R10-A-03) rather than dropped, and the derived-N index below
    // already excludes it. Skipping it explicitly keeps this reader's intent
    // visible and keeps a contested record from ever being the one that settles.
    if (rec.rule10_contested === true) continue;
    const content = rec.content || {};
    // Provider dispatch through the ONE shared resolver (same one fold rule 10's
    // collector and derive-n use): a record whose victim cannot be resolved
    // against this roster's declared provider is not evidence of settlement.
    const bind = resolveBindIdentity(content, { expectedProvider });
    if (!bind.ok) continue;
    const login = namedIdentity(content, bind.bindField);
    if (!login || !departingVictim || !bind.equals(login, departingVictim) ||
        rec.rule10_contested !== false) continue;
    const key = Object.keys(perLoginLatest).find((k) => bind.equals(login, k));
    if (!key) continue;
    if (!(perLoginLatest[key] && perLoginLatest[key].kind === "revocation" &&
          Number.isSafeInteger(rec.seq) && rec.seq >= 0 &&
          perLoginLatest[key].seq === rec.seq)) {
      continue;
    }
    // THE RECORD IS THE LATEST DISTINCTNESS RECORD for a rostered owner login,
    // AND it is SETTLED in fold-rule-10's full sense (R10-A-01 quiescence +
    // R10-S-01 fetch-bounded peer high-water) — evaluated HERE, in the
    // production path, from derived data; see _revocationSettlement.
    const sameIndexCandidates = accepted.filter((candidate) => {
      if (!candidate || candidate.type !== "collaborator-distinctness-revocation" ||
          candidate.rule10_contested === true || candidate.seq !== rec.seq) return false;
      const candidateBind = resolveBindIdentity(candidate.content, { expectedProvider });
      return candidateBind.ok && candidateBind.equals(
        namedIdentity(candidate.content, candidateBind.bindField), departingVictim,
      );
    });
    if (sameIndexCandidates.length !== 1) {
      lastReason = "latest victim revocation is ambiguous across emitter chains";
      continue;
    }
    const settlement = _revocationSettlement(rec, accepted, roster, repoDir, trustRoot);
    if (settlement.settled) return { settled: true, reason: settlement.reason };
    lastReason = settlement.reason;
  }
  return { settled: false, reason: lastReason };
}

/**
 * Exact-fingerprint peer reader; disposition distinguishes absent from unread.
 * Transport source: lib/transport-git-ref.js:571-598.
 */
function _peerHighWaterReader(repoDir, roster, accepted, trustRoot) {
  let transport = null;
  let transportError = null;
  const outcome = { status: "not-asked", detail: null };
  try {
    const { createGitRefTransport } = require(
      path.join(__dirname, "lib", "transport-git-ref.js"),
    );
    const { resolveLogRefName } = require(
      path.join(__dirname, "lib", "log-ref-name.js"),
    );
    const { resolveSignedPeerBinding } = require(path.join(__dirname, "lib", "signed-peer-binding.js"));
    const binding = resolveSignedPeerBinding(roster, accepted, trustRoot);
    if (!binding.ok) throw new Error(binding.reason);
    const resolved = resolveLogRefName({ repoDir, boundPeerUrl: binding.url });
    transport = createGitRefTransport({
      repoDir,
      boundPeerUrl: binding.url,
      refName: resolved && resolved.refName ? resolved.refName : undefined,
    });
  } catch (err) {
    transport = null;
    transportError = err && err.message ? err.message : String(err);
  }
  const peerHighWaterFor = function peerHighWaterFor(key) {
    if (!transport || typeof key !== "string" || !key) {
      outcome.status = "could-not-ask";
      outcome.detail = transportError || "no transport or exact fingerprint";
      return null;
    }
    let high;
    try {
      high = transport.peerObservedHighWaterSync(key);
    } catch (err) {
      outcome.status = "could-not-ask";
      outcome.detail = err && err.message ? err.message : String(err);
      return null;
    }
    if (high === null) {
      outcome.status = "answered-absent";
      outcome.detail = `peer holds no chain for ${key}`;
      return null;
    }
    if (!Number.isSafeInteger(high) || high < 0) {
      outcome.status = "could-not-ask";
      outcome.detail = `invalid peer sequence for ${key}`;
      return null;
    }
    outcome.status = "answered";
    outcome.detail = `peer high-water ${high} for ${key}`;
    return high;
  };
  return { peerHighWaterFor, outcome: () => outcome };
}

/**
 * Per-emitter settlement adapter for lib/fold-rule-10.js:239-324.
 */
function _revocationSettlement(revocation, accepted, roster, repoDir, trustRoot) {
  const peer = _peerHighWaterReader(repoDir, roster, accepted, trustRoot);
  return _perKeySettlement(revocation, accepted, roster, peer);
}

function _perKeySettlement(revocation, accepted, roster, peer) {
  const chain = require(
    path.join(__dirname, "lib", "coordination-log.js"),
  )._internal._collectVictimChainEntries(revocation, roster, accepted);
  if (chain.indeterminate) {
    return { settled: false, reason: `victim chain indeterminate: ${chain.indeterminate}` };
  }
  const bind = resolveBindIdentity(revocation.content, {
    expectedProvider: roster && roster.genesis ? roster.genesis.provider : undefined,
  });
  if (!bind.ok) return { settled: false, reason: `victim bind invalid: ${bind.reason}` };
  const victim = namedIdentity(revocation.content, bind.bindField);
  const fingerprints = new Set();
  for (const person of Object.values((roster && roster.persons) || {})) {
    if (!person || !bind.equals(namedIdentity(person, bind.bindField), victim)) continue;
    if (!Array.isArray(person.keys) || !person.keys.length) {
      return { settled: false, reason: "victim key set unreadable" };
    }
    for (const key of person.keys) {
      if (!key || typeof key.fingerprint !== "string" || !key.fingerprint) {
        return { settled: false, reason: "victim fingerprint unreadable" };
      }
      fingerprints.add(key.fingerprint);
    }
  }
  if (!fingerprints.size) return { settled: false, reason: "no provider-bound victim keys" };
  const localByKey = new Map();
  let lastXActivity = null;
  let lastTs = -Infinity;
  const now = Date.now();
  for (const entry of Array.isArray(chain.entries) ? chain.entries : []) {
    if (!fingerprints.has(entry.verified_id) ||
        !Number.isSafeInteger(entry.seq) || entry.seq < 0) {
      return { settled: false, reason: "invalid local victim chain sequence" };
    }
    if (!localByKey.has(entry.verified_id) || entry.seq > localByKey.get(entry.verified_id)) {
      localByKey.set(entry.verified_id, entry.seq);
    }
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts)) return { settled: false, reason: "invalid victim activity timestamp" };
    if (ts > lastTs) {
      lastTs = ts;
      lastXActivity = entry;
    }
  }
  const { isSettled } = require(path.join(__dirname, "lib", "fold-rule-10.js"));
  let heldChains = 0;
  let lastVerdict = null;
  for (const fingerprint of fingerprints) {
    const peerSeq = peer.peerHighWaterFor(fingerprint);
    const outcome = peer.outcome();
    if (outcome.status === "answered-absent") continue;
    if (outcome.status !== "answered" || !Number.isSafeInteger(peerSeq) || peerSeq < 0) {
      return { settled: false, reason: `peer chain unknown: ${outcome.detail || outcome.status}` };
    }
    heldChains++;
    if (!localByKey.has(fingerprint)) {
      return { settled: false, reason: `local victim chain missing for ${fingerprint}; peer seq ${peerSeq}` };
    }
    const verdict = isSettled(revocation, {
      foldedHighWaterSeq: localByKey.get(fingerprint),
      peerHighWaterFor: () => peerSeq,
      lastXActivity,
      now,
    });
    if (!verdict.settled) return verdict;
    lastVerdict = verdict;
  }
  if (!heldChains) return { settled: false, reason: "peer holds no victim chains; settlement unknown" };
  return { settled: true, reason: `${lastVerdict.reason} [peer: answered ${heldChains} separate chains]` };
}

/**
 * The shared provider→bind-field resolution, derived ONCE per roster from the
 * roster's declared provider (absent ⇒ github, the schema's
 * backward-compatible default — the SAME ladder `revocation-bind-identity.js`
 * applies). Callers use ITS `bindField` and ITS `equals`; nothing here
 * re-spells the dispatch, so an operator-id field added for a future provider
 * cannot land in one reader and miss another (security.md §
 * Enforcement-Surface Parity). Fail-closed on a malformed/unknown provider:
 * `ok:false` propagates and the caller refuses.
 */
function _bindFor(roster) {
  const provider =
    roster && roster.genesis && roster.genesis.provider
      ? roster.genesis.provider
      : "github";
  return resolveBindIdentity({ provider }, { expectedProvider: provider });
}

/** A person's provider-bound login, through the shared dispatch. */
function _boundLoginOf(person, roster) {
  if (!person || typeof person !== "object") return null;
  const bind = _bindFor(roster);
  if (!bind.ok) return null;
  return namedIdentity(person, bind.bindField);
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
    const { parseCoordinationLog } = require(
      path.join(__dirname, "lib", "fold-record-limits.js"),
    );
    let raw;
    try {
      raw = fs.readFileSync(resolveLogPath(repoDir), "utf8");
    } catch {
      return null;
    }
    records = parseCoordinationLog(raw, {
      malformed: "skip", objectRecordsOnly: true, maxRecords: null,
    }).records;
    if (records.length === 0) return null;
    // SIGNATURE-VERIFIED fold — no `skipSignatureVerify`. See this function's
    // header for the ruling and the attack the opt used to admit.
    const folded = foldLog(records, roster, {
      deadlineAtMs: Date.now() + FOLD_BUDGET_MS,
    });
    if (!folded || folded.skippedSignatureVerify === true) return null;
    const accepted = (folded && folded.accepted) || [];
    const derivedN = folded.derivedN && typeof folded.derivedN === "object" ? folded.derivedN : null;
    const corroboration = departureRevocation(
      accepted,
      (folded && folded.rejected) || [],
      roster,
      departingVictim,
    );
    const settlementVerdict = corroboration.recorded
      ? _verifiedRevocationIsLatestForOwner(accepted, roster, derivedN, repoDir, departingVictim,
          folded.foldState && folded.foldState.trustRoot)
      : { settled: false, reason: corroboration.detail };
    return {
      records: accepted,
      rejected: folded.rejected,
      derived_N:
        derivedN && typeof derivedN.derived_N === "number"
          ? derivedN.derived_N
          : null,
      // The live-owner set derived-N is computed FROM (derive-n.js::computeDerivedN
      // `live_logins`): the row's third condition names the ONE remaining owner,
      // and naming it requires this list, not just its cardinality.
      live_logins:
        derivedN && Array.isArray(derivedN.live_logins)
          ? derivedN.live_logins.slice()
          : null,
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
      // stamps `false`, NO revocation corroborates (the ruled interim).
      revocationRecorded: corroboration.recorded,
      revocationDetail: corroboration.detail,
      revocationSettled: corroboration.recorded && settlementVerdict.settled,
      revocationSettledReason: settlementVerdict.reason,
    };
  } catch (err) {
    // The refusal downstream says "no folded state is available"; this line says
    // WHY (a deadline, a malformed log, a predicate throw) without dumping a
    // stack into a hook channel. Bounded to the message on purpose.
    process.stderr.write(
      `[operator-gate] folded state unavailable: ${err && err.message ? err.message : String(err)}\n`,
    );
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
    if (!Object.prototype.hasOwnProperty.call(r, VERDICT) || r[VERDICT] !== false) {
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
    // Owner departure remains HOLD and requires a distinct eligible co-signer;
    // gate-matrix.js:328-415. The derived evidence below cannot authorize
    // self-recovery. Its producer is resolveFoldedState in this module.
    rosterEditKind:
      gate === "owner-departure-roster-removal" ? "removal" : null,
    revocationSettled: !!(
      evidence.foldedState && evidence.foldedState.revocationSettled === true
    ),
    // Operator-facing: WHY it did not settle (quiescence pending, peer
    // high-water unknown, victim chain indeterminate, ...). Rendered by the row
    // in its refusal; never used to widen access.
    revocationSettledReason: evidence.foldedState
      ? evidence.foldedState.revocationSettledReason ||
        "settled=false and the fold reported no detail"
      : "no folded state is available (the coordination log is absent, unreadable, or could not be folded within the hook's budget)",
    requesterIsSoleLiveOwner: _requesterIsSoleLiveOwner(
      evidence.roster,
      evidence.requester,
      evidence.requesterPerson,
      evidence.foldedState,
    ),
    // WHICH precondition is unmet when `revocationSettled` is false, so the
    // matrix's refusal names it rather than one sentence for every cause.
    revocationUnsettledReason: evidence.foldedState
      ? evidence.foldedState.revocationDetail
      : "NO FOLDED LOG — the coordination log is absent, empty or unreadable, or its fold failed, so no revocation can corroborate this removal",
  };
}

/**
 * The row's third condition, computed SERVER-side: derived-N is exactly 1 and
 * the sole live login is the requester's own provider-bound login.
 *
 * Both halves are load-bearing. `derived_N === 1` alone would admit a removal
 * by an owner who is NOT the survivor (derived-N counts live OWNERS; the
 * requester is identified separately), and the identity half alone would admit
 * a removal with other owners still live. Fail-closed on every unresolvable
 * input: no folded state, no live-login list, no bound requester login, or a
 * provider whose bind field the roster does not carry all return false.
 */
function _requesterIsSoleLiveOwner(roster, requester, requesterPerson, foldedState) {
  if (!foldedState || foldedState.derived_N !== 1) return false;
  const live = foldedState.live_logins;
  if (!Array.isArray(live) || live.length !== 1) return false;
  const requesterLogin = _boundLoginOf(requesterPerson, roster);
  if (!requesterLogin) return false;
  const bind = _bindFor(roster);
  if (!bind.ok) return false;
  if (!bind.equals(requesterLogin, live[0])) return false;
  // IDENTITY, NOT JUST LOGIN EQUALITY (review F3). Two roster persons can carry
  // the same provider login (the schema does not forbid it), so a login compare
  // alone could call a DIFFERENT person "the sole remaining owner". Resolve the
  // live login back to its roster person and require: same person_id as the
  // requester, and that person is an owner who is not a CI host — the same two
  // properties derive-n counts on. Any ambiguity (no match, several matches,
  // role/host mismatch) refuses.
  const matches = [];
  for (const [pid, person] of Object.entries((roster && roster.persons) || {})) {
    if (!person || typeof person !== "object") continue;
    if (!bind.equals(namedIdentity(person, bind.bindField), live[0])) continue;
    matches.push({ pid, person });
  }
  if (matches.length !== 1) return false;
  const sole = matches[0];
  if (sole.person.role !== "owner") return false;
  if (sole.person.host_role === "ci") return false;
  const requesterPersonId =
    requester && typeof requester.person_id === "string"
      ? requester.person_id
      : null;
  return !!requesterPersonId && sole.pid === requesterPersonId;
}

// ---- main -------------------------------------------------------------------

async function main(data) {
  const event = data.hook_event_name || data.hookEventName || "";
  if (event !== "PreToolUse") return passthrough();

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};
  if (toolName === "Skill") {
    const command = skillNameOf(toolInput);
    const guarded = new Set(["release", "posture", "codify", "whoami"]);
    if (guarded.has(command)) {
      const args = toolInput.args;
      const knownArgs = args === undefined || typeof args === "string" ||
        (Array.isArray(args) && args.every((token) => typeof token === "string"));
      if (!knownArgs || Object.prototype.hasOwnProperty.call(toolInput, "argv")) {
        return emitGateBlock("argument-shape", "unsupported gated Skill args/argv shape; argument meaning is unknown", `/${command}`);
      }
    }
  }
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
  // A coordination verdict that THROWS is not "coordination off": the trigger has
  // already fired on a gate-bearing surface, so an unanswered mode question must
  // not resolve to a pass. The throw reaches the runner, which refuses (it was once
  // caught here and read as OFF — a passthrough on a gate-bearing call).
  const coordinationOn = isCoordinationEnabled(repoDir) === true;
  if (!coordinationOn) return passthrough();

  // Past this line the gate is ARMED on an enrolled repo: an unresolved
  // question must refuse.

  // ---- server-side evidence -------------------------------------------------
  // A resolver that THROWS is a refusal naming it — decided OUTSIDE the catch, which
  // only captures the error (a verdict emitted from inside a catch is the shape the
  // fail-closed lint and the engine's exit sentinel both make fragile).
  let evidence = null;
  let evidenceError = null;
  try {
    evidence = resolveServerEvidence(repoDir, toolInput);
  } catch (err) {
    evidenceError = err;
  }
  if (evidenceError !== null) {
    return emitGateBlock(
      gate,
      `server-evidence error: ${evidenceError && evidenceError.message ? evidenceError.message : String(evidenceError)}`,
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

  // Defensive — any unexpected evaluator error becomes a refusal, never a silent
  // passthrough (rules/zero-tolerance.md Rule 3); captured in the catch, decided
  // outside it.
  let verdict = null;
  let evaluatorError = null;
  try {
    verdict = evaluateGate(ctx);
  } catch (err) {
    evaluatorError = err;
  }
  if (evaluatorError !== null) {
    return emitGateBlock(
      gate,
      `evaluator error: ${evaluatorError && evaluatorError.message ? evaluatorError.message : String(evaluatorError)}`,
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

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). Built by the fail-closed runner:
// it reads the payload (a terminal, an empty or unparseable stdin REFUSES — the
// former reader passed all three through), bounds the run, and refuses on a crash;
// a require() has no side effects.
const hookMain = runGuard("operator-gate", main, { budgetMs: TIMEOUT_MS });

module.exports = { hookMain, detectTrigger, departureRevocation };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1")
    require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
