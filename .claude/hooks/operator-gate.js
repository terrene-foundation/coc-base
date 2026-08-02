#!/usr/bin/env node
/**
 * Hook: operator-gate
 *
 * @coc-codex-edit-gate — STATELESS trust gate (multi-operator 4-eyes
 *   gate-approval); the policy extractor fans its CC edit-matcher
 *   registration out to the Codex `apply_patch` lane (mcp-guard,
 *   FF-AC6-1). It fires only on the lexical gate-bearing command
 *   surfaces (/release, /posture upgrade|override, /codify, roster
 *   ops) and passes through every other edit — so it does NOT require
 *   the coordination substrate to be enrolled on a Codex consumer.
 *   The cc-only coordination guards deliberately omit this marker.
 *   NOTE: a `apply_patch` (file-edit) call carries no command surface,
 *   so on the apply_patch lane this gate is a NO-OP by construction —
 *   it bites only on the Bash lane (shell/unified_exec), where the
 *   gate-bearing slash commands actually arrive on Codex. The marker is
 *   retained for shell-lane structural parity (same 3 stateless gates
 *   across every Codex tool) + defense-in-depth (a future edit-gating
 *   branch would activate without re-wiring).
 *
 * Event: PreToolUse
 *
 * Trigger: lexical command-string match for the gate-bearing surfaces:
 *   - /release         (release authorization)
 *   - /posture upgrade
 *   - /posture override
 *   - /codify          (new-rule codify per R5-C-06)
 *   - roster-op slash commands (/whoami --register, --depart, etc.)
 *
 * Shard C2 (workspaces/multi-operator-coc, design v11 §4.3 + §6.4).
 *
 * Per the shard contract (workspaces/multi-operator-coc/todos/active/
 * 00-todos.md § C2 invariant 1):
 *
 *   operator-gate.js: resolves signed gate-approval key → person_id,
 *   rejects iff approver person_id == requester OR (owner/senior gates)
 *   same bound GitHub-collaborator login (R5-S-07); host_role:ci NEVER
 *   eligible (R5-S-04); degenerate self-sign rows fire only when N=1 is
 *   *derived* current-attestation fact, never self-reported.
 *
 * loom#1440 — BOTH identities in the R5-S-07 distinctness check are
 *   SERVER-DERIVED from the roster; NEITHER is read from the payload.
 *   The approver's login already came from the post-sig-verify roster
 *   person (F14 MED-1); the requester's now comes from
 *   `roster.persons[requester_person_id].github_login`, keyed on a field
 *   `verifyGateApproval` binds into the canonical signed bytes. The old
 *   `tool_input.requester_gh_login` read let a caller CHOOSE the value the
 *   distinctness check compared, while the signature never covered it — so
 *   omitting the field defeated R5-S-07 outright. Server-derivation is
 *   preferred over adding the field to the signed bytes (`security.md`
 *   § Enforcement-Surface Parity → Identity-derivation parity): signing a
 *   caller-supplied value binds the caller's CHOICE to the record; deriving
 *   it removes the choice. It also keeps the signed field set at six, so no
 *   previously-signed gate-approval record is invalidated.
 *
 * Hook output discipline (rules/hook-output-discipline.md):
 *   - All halt paths emit via lib/instruct-and-wait.js::emit() with all
 *     six fields populated (MUST-1).
 *   - The trigger detection is LEXICAL regex on command-string surface,
 *     so the resulting severity is "halt-and-report", NEVER "block"
 *     (MUST-2). Block-equivalent rejection at a signature-verification
 *     structural signal IS structural (gate-approval signature check),
 *     but the gate is policy not safety — halt-and-report per the
 *     architecture §4.3 hook table.
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

const TIMEOUT_MS = 5000;
// TIMEOUT_MS fallback — per cc-artifacts.md Rule 7: a hook MUST return
// {continue: true} and exit if it does not produce its own output within
// the timeout. The raw process.exit(1) here is the ONLY legitimate raw
// exit per hook-output-discipline.md MUST-1 (the timeout-fallback carve-out).
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1); // timeout fallback
}, TIMEOUT_MS);

const path = require("path");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const { evaluateGate, findRow } = require(
  path.join(__dirname, "lib", "gate-matrix.js"),
);
const { verifyGateApproval } = require(
  path.join(__dirname, "lib", "gate-approval.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

/**
 * Trigger detection — lexical match on command string surface. Returns
 * the canonical gate-matrix row name, or null if no trigger fires.
 *
 * Per hook-output-discipline.md MUST-3: when the captured command string
 * references a shell variable ($VAR, ${VAR}, $(...)), command substitution,
 * or backtick — the detector MUST return null (skip). The hook cannot
 * evaluate pre-expansion shell forms.
 */
function detectTrigger(toolName, toolInput) {
  if (!toolName || !toolInput) return null;
  const command = (toolInput.command || "").trim();
  if (!command) return null;

  // Skip shell-variable references AT THE COMMAND STRING LEVEL (MUST-3).
  // If the command IS purely a shell-variable expansion (eval "$CMD",
  // $(...), `...`), we cannot resolve the trigger at hook time.
  if (
    /^eval\s+["']?\$/.test(command) ||
    /^\$\(/.test(command) ||
    /^\$\{?\w+\}?\s*$/.test(command) ||
    /^\$\(.+\)\s*$/.test(command) ||
    /^`.+`\s*$/.test(command)
  ) {
    return null;
  }

  // SlashCommand tool — direct command name match.
  if (toolName === "SlashCommand") {
    // Strip leading slash + arguments.
    const slashMatch = command.match(/^\/(\S+)(?:\s+(.*))?$/);
    if (!slashMatch) return null;
    const subcommand = slashMatch[1];
    const args = (slashMatch[2] || "").trim();

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

  // Bash surface — looser match. Skip if the command body contains an
  // unresolvable shell-variable in the captured fragment.
  if (toolName === "Bash") {
    // For Bash invocations, gate-bearing surfaces are typically wrapped
    // in slash-command form already — but a raw `gh pr merge ...` style
    // command MAY invoke an authorization path. We do NOT trigger on raw
    // Bash by default — slash commands carry the gate context.
    return null;
  }

  return null;
}

/**
 * Resolve a roster person's bound GitHub-collaborator login by person_id.
 *
 * #1440: this is the SERVER-DERIVATION half of the R5-S-07 fix. The bound
 * login is read from the ROSTER — the same object the approver's signing
 * pubkey is resolved from — keyed by a person_id the gate-approval signature
 * already covers. It is NEVER read from a caller-supplied payload field.
 *
 * Prototype-safe lookup (`hasOwnProperty`): a bare `roster.persons[pid]`
 * resolves truthy for inherited Object keys ("constructor", "toString", …),
 * which would hand the caller a non-person object to read `github_login` off.
 * Same guard the sibling proto-safe check in presence-proof-verify.js uses.
 *
 * @param {object|null} roster    — the operators roster ({persons: {...}})
 * @param {string|null} personId  — signature-bound person_id
 * @returns {string|null} the roster's github_login, or null if unresolvable
 */
function resolveRosterLogin(roster, personId) {
  if (!roster || typeof roster !== "object") return null;
  const persons = roster.persons;
  if (!persons || typeof persons !== "object") return null;
  if (typeof personId !== "string" || !personId) return null;
  if (!Object.prototype.hasOwnProperty.call(persons, personId)) return null;
  const person = persons[personId];
  if (!person || typeof person !== "object") return null;
  const login = person.github_login;
  return typeof login === "string" && login ? login : null;
}

/**
 * Build the gate-evaluator context from the PreToolUse payload.
 *
 * EVERY field below is CALLER-SUPPLIED. Treat this list as a wire-format
 * description, not a trust description — the only fields with any cryptographic
 * standing are the three `verifyGateApproval` binds into the canonical signed
 * bytes (`requester_person_id`, `requester_verified_id`, and the nonce via
 * `consumed_nonce`); a caller cannot alter those without invalidating the
 * approver's signature. Everything else is an unauthenticated claim.
 *
 *   tool_input.requester_person_id    : the operator invoking the gate
 *                                       (SIGNATURE-BOUND — see above)
 *   tool_input.requester_verified_id  : that operator's key (SIGNATURE-BOUND)
 *   tool_input.requester_nonce        : this invocation's nonce (SIGNATURE-BOUND)
 *   tool_input.gate_approval          : the signed approval record (optional)
 *     .approver_person_id             : claim; the TRUSTED approver identity is
 *                                       verifyGateApproval's roster-resolved
 *                                       person, not this field
 *     .approver_gh_login              : IGNORED since loom#1440 (roster-derived)
 *   tool_input.requester_person       : an unauthenticated claim. NOT roster-
 *                                       resolved and NOT read by evaluateGate —
 *                                       do NOT reach for it as a source of the
 *                                       requester's github_login (loom#1440:
 *                                       that would restore the body-trust
 *                                       pattern the fix removed). The roster
 *                                       lookup keyed on the signature-bound
 *                                       requester_person_id is the derivation.
 *   tool_input.approver_person        : same — superseded by the verified
 *                                       roster person whenever one resolves
 *   tool_input.roster                 : the operators roster
 *   tool_input.folded_state           : folded coordination log (derived_N
 *                                       + records, from coordination-log.js)
 *
 * CORRECTION (loom#1440): a previous version of this comment claimed "real CC
 * invocations populate the requester / approver / roster / folded_state from the
 * session-start hook's pre-computed state cache". That is FALSE and was actively
 * misleading — a SessionStart hook cannot inject fields into a later PreToolUse
 * `tool_input`, which is the tool's own input as constructed by the caller. There
 * is in fact NO production producer of this payload shape at all; the only
 * writers are test fixtures. The roster below is therefore as caller-supplied as
 * everything else, which is the ceiling on what this gate can currently prove —
 * server-derivation puts the requester's login on the SAME footing as the
 * approver's signing pubkey (both roster-resolved), which is parity, not
 * unconditional trust.
 */
function buildEvalCtx(gate, toolInput, verifiedApprover) {
  const roster = toolInput.roster || null;
  const requesterPersonId = toolInput.requester_person_id || null;
  // #1440: the requester's bound GitHub-collaborator login is SERVER-DERIVED
  // from the roster via requester_person_id — a field verifyGateApproval binds
  // into the canonical signed bytes, so the caller cannot alter it without
  // invalidating the approver's signature. The former
  // `toolInput.requester_gh_login` read is DELETED, not merely distrusted:
  // it was a caller-chosen value feeding the R5-S-07 distinctness check while
  // the approver's half was already roster-resolved (F14 MED-1). That
  // asymmetry let one human holding two roster persons bound to the SAME
  // GitHub account defeat 4-eyes by simply OMITTING the field — the signature
  // still verified, because the field was never in the signed set.
  // `security.md` § Enforcement-Surface Parity → Identity-derivation parity
  // prefers server-derivation over signature-coverage precisely here: signing
  // the value would bind the caller's CHOICE to the record; deriving it takes
  // the choice away.
  const requester = {
    person_id: requesterPersonId,
    gh_login: resolveRosterLogin(roster, requesterPersonId),
  };
  const gateApproval = toolInput.gate_approval || {};
  // F14 MED-1: approver identity is resolved from the roster post-sig-verify,
  // NEVER from the attacker-controlled payload claims. verifiedApprover is
  // the {person, person_id, verified_id} record returned by
  // verifyGateApproval; if it is null (single-operator workstreams, n/a
  // signing_context rows), fall back to the payload-derived shape so
  // legacy passthrough rows (e.g. todos-plan-single-operator) still work.
  //
  // #1440 same-PR sibling sweep: the FALLBACK branch previously read
  // `gateApproval.approver_gh_login` — the same body-trust pattern on the
  // approver half. It reaches no distinctness decision today (the two
  // signing_context:"n/a" rows return before the R5-S-07 check), but leaving
  // one endpoint on the body-trust pattern while fixing its sibling is
  // exactly what § Enforcement-Surface Parity blocks. Both halves now derive
  // from the roster, so NO code path in this hook reads a caller-supplied
  // GitHub login.
  const approver = verifiedApprover
    ? {
        person_id: verifiedApprover.approverPersonId,
        gh_login: verifiedApprover.approverPerson.github_login || null,
      }
    : {
        person_id: gateApproval.approver_person_id || null,
        gh_login: resolveRosterLogin(
          roster,
          gateApproval.approver_person_id || null,
        ),
      };
  return {
    gate,
    requester,
    approver,
    requesterPerson: toolInput.requester_person || null,
    // F14 MED-1: pass the roster-resolved person; gate-matrix.evaluateGate
    // consults THIS for eligibility (host_role:ci / role-floor) — not the
    // payload's attacker-controlled approver_role / approver_host_role.
    approverPerson:
      (verifiedApprover && verifiedApprover.approverPerson) ||
      toolInput.approver_person ||
      null,
    roster,
    foldedState: toolInput.folded_state || null,
    touchesAnothersLease: !!toolInput.touches_anothers_lease,
    rosterEditKind: toolInput.roster_edit_kind || null,
    revocationSettled: !!toolInput.revocation_settled,
  };
}

/**
 * Emit a halt-and-report payload for a gate evaluation that returned
 * allowed=false. All six instructAndWait fields populated.
 */
function emitGateHalt(gate, verdict, command) {
  clearTimeout(fallback);
  const cmdHead = command.slice(0, 80);
  const reasonHead = (verdict.reason || "").slice(0, 200);
  emit({
    hookEvent: "PreToolUse",
    severity: "halt-and-report",
    what_happened: `operator-gate refused '${gate}': ${cmdHead}`,
    why: `operator-gate/${gate} — ${reasonHead}`,
    agent_must_report: [
      `State the gate that fired: '${gate}' (§6.4)`,
      `Quote the rejection reason: ${reasonHead}`,
      "Identify the requester person_id and the missing/insufficient approver",
      "Propose remediation in this turn — do NOT file a follow-up issue (autonomous-execution.md MUST Rule 4)",
    ],
    agent_must_wait:
      "Do not retry the gated action. Surface the rejection to the user and wait for explicit approval or remediation.",
    user_summary: `operator-gate halted ${gate}: ${reasonHead.slice(0, 60)}`,
  });
}

/**
 * Emit a passthrough-with-audit-marker for degenerate self-sign rows.
 * The audit marker is logged on stderr but does NOT halt the flow.
 */
function passthroughWithAudit(gate, verdict) {
  clearTimeout(fallback);
  process.stderr.write(
    `[operator-gate] ${gate} ALLOWED with audit marker: ${verdict.audit_marker}\n`,
  );
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

// ---- main -------------------------------------------------------------------

let input = "";
if (process.stdin.isTTY) {
  passthrough();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
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
    const command = (toolInput.command || "").trim();

    // Trigger detection (lexical regex; returns null on shell-variable
    // references per MUST-3).
    const gate = detectTrigger(toolName, toolInput);
    if (!gate) return passthrough();

    // The §6.4 row exists?
    const row = findRow(gate);
    if (!row) return passthrough();

    // F14 MED-1 + MED-2: for rows requiring a co-signer, cryptographically
    // verify the gate_approval payload BEFORE consulting the gate matrix.
    // The verifier checks: sig present + signature valid + target_tool ==
    // current gate + consumed_nonce == requester_nonce + ts within 24h +
    // approver_verified_id resolves to a roster person eligible to sign
    // gate-approval (R5-S-04 + role-floor via isEligibleSigner). Until
    // verify succeeds, the gate-matrix is consulted ONLY against a
    // null/passthrough approver — the attacker cannot inject role claims.
    let verifiedApprover = null;
    if (row.signing_context !== "n/a") {
      if (!toolInput.gate_approval) {
        return emitGateHalt(
          gate,
          {
            reason: `row '${gate}' requires a signed gate-approval record (signing_context='${row.signing_context}'); none provided`,
          },
          command,
        );
      }
      const verifyResult = verifyGateApproval(toolInput.gate_approval, {
        gate,
        requester_person_id: toolInput.requester_person_id || "",
        requester_verified_id: toolInput.requester_verified_id || "",
        requester_nonce: toolInput.requester_nonce || "",
        roster: toolInput.roster || null,
      });
      if (!verifyResult.ok) {
        return emitGateHalt(
          gate,
          {
            reason: `gate-approval verify failed: ${verifyResult.reason}`,
          },
          command,
        );
      }
      verifiedApprover = verifyResult;
    }

    // Build the evaluator context and run.
    const ctx = buildEvalCtx(gate, toolInput, verifiedApprover);

    let verdict;
    try {
      verdict = evaluateGate(ctx);
    } catch (err) {
      // Defensive — any unexpected error becomes a halt-and-report,
      // never a silent passthrough (rules/zero-tolerance.md Rule 3).
      return emitGateHalt(
        gate,
        {
          reason: `evaluator error: ${err && err.message ? err.message : String(err)}`,
        },
        command,
      );
    }

    if (!verdict.allowed) {
      return emitGateHalt(gate, verdict, command);
    }
    if (verdict.audit_marker) {
      return passthroughWithAudit(gate, verdict);
    }
    return passthrough();
  });
}
