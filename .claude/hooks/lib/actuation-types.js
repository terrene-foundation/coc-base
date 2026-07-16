#!/usr/bin/env node
/**
 * actuation-types.js — the presence-gate SSOT for #583.
 *
 * Single source of truth for (a) WHICH coordination-log record types carry
 * human intent (the "actuation" class the presence proof gates), and (b) the
 * provisioning-state signal `isPresenceMechanismConfigured` (the loom ↔
 * loom-command provisioning contract). Importers (Shard 3a):
 *   - `coc-emit.js`  — the EMIT-side gate: an actuation emission MUST carry a
 *     PROVEN `content.presence_proof` (verified via presence-proof-verify.js).
 *   - `presence-proof-verify.js` — `foldPresenceGate` consults
 *     `requiresPresenceAttestation` to REJECT an ABSENT actuation at the FOLD
 *     (every reader — the unbypassable non-mintability enforcement).
 *   - `coordination-log.js` — a load-time structural assert that every
 *     ACTUATION type is fold-registered AND checkpoint-exempt (F5/Q5a).
 *
 * Contract: workspaces/signing-agent-contract/02-plans/01-...contract.md
 *   §C4 (presence-proof-gated signing as an enforced property); §0/§4 (the
 *   presence-token FORMAT + cryptographic verification are off-loom
 *   `loom-command`'s; loom enforces the presence + broker-sig verification of
 *   the proof). #583 Shards 1–3 (journal/0505/0506/0508 + the Shard-3a
 *   convergence receipt).
 *
 * Partition (positive allowlist per cc-artifacts.md Rule 10 — flag everything
 * NOT in the allowlist as "routine, never gated"):
 *
 *   ACTUATION (presence-gated): records that encode a deliberate human
 *     actuation. Today exactly `gate-approval` (the multi-operator /release
 *     co-sign + the future command-center "Approve"). Extend this set when
 *     command-center actuation record types land — NEVER widen it to a routine
 *     agent-emitted type. Every member MUST be checkpoint-exempt (F5, asserted
 *     at coordination-log load): a checkpoint-exempt actuation's presence
 *     nonces never leave the live re-fold set, so the single-use nonce ledger
 *     fully closes replay and freshness is redundant for the gated type.
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
 * identity-≠-intent hole the presence gate closes does not apply to them the
 * way it does to a single-emit UI actuation. The presence gate is scoped to
 * UI-relayed single-emit actuation (`gate-approval` + future command-center
 * actuation types). Extend ACTUATION_RECORD_TYPES ONLY when a command-center
 * actuation type lands; do NOT add a co-signed authority type without first
 * re-deriving whether its quorum predicate already supplies the human-intent
 * binding. (Omission-precedent shape per self-referential-codify.md.)
 *
 * ALWAYS-ON (co-owner-ratified, Shard 3a): the presence requirement for
 * actuation types is enforced UNCONDITIONALLY. The primary enforcement signal
 * is the STATIC type-membership above (an immutable, write-guarded code
 * constant) — NOT the mutable `presence-mechanism.json` / env signal. The FOLD
 * (foldPresenceGate) rejects an ABSENT actuation regardless of any provisioning
 * state; the EMIT gate requires a PROVEN proof. `isPresenceMechanismConfigured`
 * below is RETAINED (hardened per AC-L15) as the loom ↔ loom-command
 * provisioning-state signal + defense-in-depth for any future conditional
 * consumer; the always-on latch does NOT gate on it.
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
 * Provisioning-state signal (AC-L15 fail-closed requirement latch). Returns
 * true when this repo has a hardware-presence mechanism provisioned (the
 * off-loom `loom-command` path).
 *
 * PRECEDENCE — FILE IS AUTHORITATIVE (the AC-L15 fix, journal/0505 CRITICAL
 * finding 2): a config file `.claude/learning/presence-mechanism.json` carrying
 * `{"configured": true}` LATCHES the mechanism ON. Once provisioned, NO env
 * value may downgrade it — the env var is consulted ONLY when the file does not
 * provision (absent / `configured:false` / unreadable), and then it may only
 * turn the gate ON ("1"/"true" for A3-era staging), never OFF. This closes the
 * env-precedence inversion the pre-Shard-3a code shipped, where an in-process
 * agent could `COC_PRESENCE_MECHANISM=0` to silently downgrade a provisioned
 * gate (the journal/0365 sec MED-3 mintability re-open).
 *
 * INTEGRITY REQUIREMENT: the file `.claude/learning/presence-mechanism.json`
 * MUST live in `settings.json::permissions.deny` (only loom-command's
 * provisioning ceremony writes it) — exactly the protection `posture.json` /
 * the roster carry. The write-guard + this file-authoritative precedence
 * together make the provisioning state fail-closed-once-provisioned.
 *
 * Any read/parse error fails SAFE to "not configured by file" (then env is
 * consulted). Note: under the Shard-3a always-on model the presence latch does
 * NOT consult this signal (static type-membership is the enforcement signal);
 * this function is retained hardened for the loom ↔ loom-command provisioning
 * contract + defense-in-depth for any future conditional consumer.
 */
function isPresenceMechanismConfigured(repoDir, env) {
  const e = env || process.env;
  // 1. Provisioned file is AUTHORITATIVE — latch ON; env cannot downgrade it.
  let fileConfigured = false;
  try {
    const cfgPath = path.join(
      repoDir,
      ".claude",
      "learning",
      "presence-mechanism.json",
    );
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      fileConfigured = Boolean(cfg && cfg.configured === true);
    }
  } catch {
    fileConfigured = false; // read/parse error → file does not provision (fail-safe)
  }
  if (fileConfigured) return true; // LATCH: no env value downgrades a provisioned gate
  // 2. No file provision → env may ONLY turn the gate ON (never the authoritative
  //    signal, so it can never downgrade — an "0"/"false"/""/unknown value simply
  //    leaves the gate not-configured, same as absent).
  const ov = e.COC_PRESENCE_MECHANISM;
  if (ov === "1" || ov === "true") return true;
  return false;
}

module.exports = {
  ACTUATION_RECORD_TYPES,
  requiresPresenceAttestation,
  isPresenceMechanismConfigured,
};
