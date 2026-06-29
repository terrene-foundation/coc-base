#!/usr/bin/env node
/**
 * actuation-types.js — the A+ presence-gate SSOT for #583.
 *
 * Single source of truth for (a) WHICH coordination-log record types carry
 * human intent (the "actuation" class that the A+ floor presence-gates), and
 * (b) WHETHER this repo has a hardware-presence mechanism configured (the A3
 * staging signal). `coc-emit.js` (the structural pre-sign gate) is the SOLE
 * importer — the partition is defined here, in exactly one place, and enforced
 * at the pre-sign gate in `emitSignedRecord`. (A `signing-mutation-guard.js`
 * lexical advisory was the originally-planned second consumer but was DROPPED
 * at implementation — no code emits `gate-approval` through the emitter today,
 * the emitter gate is the complete chokepoint, and a lexical Bash detector
 * would add false-positive noise for ~zero enforcement gain. See `journal/0365`
 * + `02-plans/04-aplus-implementation-plan.md` file 3.)
 *
 * Contract: workspaces/signing-agent-contract/02-plans/01-...contract.md
 *   §C4 (A+ floor — presence-proof-gated signing as an enforced property),
 *   §0/§4 (the presence-token FORMAT + cryptographic verification are off-loom
 *   `loom-command`'s; loom enforces the PRESENCE of an attestation slot).
 *
 * Partition (positive allowlist per cc-artifacts.md Rule 10 — flag everything
 * NOT in the allowlist as "routine, never gated"):
 *
 *   ACTUATION (presence-gated): records that encode a deliberate human
 *     actuation. Today exactly `gate-approval` (the multi-operator /release
 *     co-sign + the future command-center "Approve"). Extend this set when
 *     command-center actuation record types land — NEVER widen it to a routine
 *     agent-emitted type.
 *
 *   ROUTINE (NEVER gated): every other type the agent legitimately emits
 *     in-process as part of normal coordination — journal-slot-reservation,
 *     journal-body-anchor, codify-lease / codify-lease-release, claim / lease,
 *     capability-ledger / capability-retirement, member-registry,
 *     upstream-canon-pointer, heartbeat, reconciliation-attestation, ... .
 *     These are NOT in ACTUATION_RECORD_TYPES, so they pass untouched.
 *
 * Excluded-on-purpose (the named human-intent / authority-escalation types that
 * by the literal "deliberate human actuation" reading LOOK like actuation but
 * are deliberately NOT presence-gated here): `lease-override`, `posture-event`,
 * `genesis-migration` / `generation-rotation`, `reap`,
 * `collaborator-distinctness-revocation`/`-attestation`. Each is emitted through
 * its OWN 2-of-N owner co-sign predicate (coordination-log.js) that already
 * binds a DISTINCT second human (the contract C6 quorum property) — so the
 * identity-≠-intent hole the A+ presence gate closes does not apply to them the
 * way it does to a single-emit UI actuation. The A+ presence gate is scoped to
 * UI-relayed single-emit actuation (`gate-approval` + future command-center
 * actuation types). Extend ACTUATION_RECORD_TYPES ONLY when a command-center
 * actuation type lands; do NOT add a co-signed authority type without first
 * re-deriving whether its quorum predicate already supplies the human-intent
 * binding. (Omission-precedent shape per self-referential-codify.md.)
 */

"use strict";

const fs = require("fs");
const path = require("path");

/**
 * The human-intent ACTUATION record types. Positive allowlist — only these
 * are presence-gated; every other type is routine and passes untouched.
 */
const ACTUATION_RECORD_TYPES = new Set(["gate-approval"]);

/** True when `type` is an actuation record requiring a per-record presence proof. */
function requiresPresenceAttestation(type) {
  return ACTUATION_RECORD_TYPES.has(type);
}

/**
 * A presence attestation is "present" when it is a non-empty value loom-command
 * supplied. PRESENCE-ONLY BY DESIGN: any non-empty value passes this check.
 * loom enforces only that the slot is filled; the attestation's cryptographic
 * VALIDITY and its binding to THIS record's bytes are loom-command's
 * (contract §0/§4), wired when that path lands. A `loom-command` integration
 * that sets the presence mechanism "configured" MUST cryptographically verify
 * the attestation BEFORE relaying to emitSignedRecord — it MUST NOT treat this
 * presence check as the security boundary (a trivially-forged non-empty value
 * passes here). This is a real, complete loom-side behavior (presence
 * enforcement), NOT a zero-tolerance stub — the off-loom half (format + verify)
 * is a documented contract boundary, not deferred loom work. Empty string,
 * null, undefined, and an empty object/array do NOT count.
 */
function isAttestationPresent(att) {
  if (att === undefined || att === null) return false;
  if (typeof att === "string") return att.length > 0;
  if (typeof att === "object") return Object.keys(att).length > 0;
  return Boolean(att);
}

/**
 * A3 staging gate. Returns true when this repo has a hardware-presence
 * mechanism wired (the off-loom `loom-command` path), signalled by either:
 *   - the explicit env override COC_PRESENCE_MECHANISM. ONLY four values are
 *     honored as definite signals: "1"/"true" → on; "0"/"false"/"" → off. Any
 *     OTHER non-empty value (e.g. "yes") is NOT a definite signal and falls
 *     through to the config-file check below — fail-SAFE during A3 staging
 *     (advisory, never a spurious hard block on a typo'd env var that would
 *     break the existing /release co-sign flow), OR
 *   - a config file `.claude/learning/presence-mechanism.json` carrying
 *     `{"configured": true}` (the file loom-command writes when provisioned).
 *
 * When false (the default today — no mechanism exists), the A+ gate runs as a
 * loud ADVISORY rather than a hard refusal, so the existing /release
 * gate-approval co-sign flow is not broken before a mechanism exists. Any read
 * error fails SAFE to "not configured" (advisory, never a spurious hard block).
 *
 * INTEGRITY REQUIREMENT (load-bearing the moment A3 staging ends): the file
 * `.claude/learning/presence-mechanism.json` is what flips the gate from
 * advisory→hard. Today it is advisory so the file is latent, but BEFORE the
 * hard gate is relied upon, `loom-command`'s provisioning codify MUST add this
 * file to `settings.json::permissions.deny` (only the provisioning ceremony
 * writes it) — exactly the protection `posture.json` / the roster carry. An
 * in-process agent that can write `{"configured": false}` to an unprotected
 * file could silently downgrade the hard gate back to advisory and re-open the
 * mintability hole. See `journal/0365` § redteam disposition (sec MED-3).
 */
function isPresenceMechanismConfigured(repoDir, env) {
  const e = env || process.env;
  const ov = e.COC_PRESENCE_MECHANISM;
  if (ov === "1" || ov === "true") return true;
  if (ov === "0" || ov === "false" || ov === "") return false;
  try {
    const cfgPath = path.join(
      repoDir,
      ".claude",
      "learning",
      "presence-mechanism.json",
    );
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return Boolean(cfg && cfg.configured === true);
  } catch {
    return false;
  }
}

module.exports = {
  ACTUATION_RECORD_TYPES,
  requiresPresenceAttestation,
  isAttestationPresent,
  isPresenceMechanismConfigured,
};
