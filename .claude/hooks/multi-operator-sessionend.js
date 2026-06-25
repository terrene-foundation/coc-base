#!/usr/bin/env node
/**
 * multi-operator-sessionend.js — F14 M5 B2 session-end hook.
 *
 * Architecture ref: §4.3 hook table row "multi-operator-sessionend.js"
 *
 * Event: Stop (also wires SessionEnd).
 * Severity: NEVER blocks. {continue:true} on every path.
 * Budget: 5s wall-clock.
 *
 * Responsibilities:
 *   1. Release own active claims (append `release` records).
 *   2. Append compaction-checkpoint when size/age trigger met AND
 *      eligible signer available:
 *        - 2-of-N owner cosig (routed through isEligibleSigner), OR
 *        - genuine-genesis-degenerate self-sign (NEVER under
 *          revocation-induced N=1 — routed through r9s02-fence).
 *   3. Atomic .session-notes regen via .tmp.<pid> + rename.
 *
 * Cross-shard contracts:
 *   - lib/eligibility.js::isEligibleSigner — SSOT for signer eligibility.
 *   - lib/r9s02-fence.js::gateEligibleForSelfSignedCheckpointOrRotation —
 *     blocks self-sign under revocation-induced N=1.
 *   - lib/coordination-log.js::foldLog — consume folded state.
 *
 * Test env overrides:
 *   COC_TEST_FINGERPRINT, COC_TEST_PERSON_ID — identity short-circuit
 *   COC_TEST_SKIP_SIGN — write unsigned stubs (tests only)
 *   COC_TEST_FORCE_RELEASE — emit a release for every own active claim
 *   COC_TEST_FORCE_CHECKPOINT — attempt checkpoint emission (subject to fence)
 *   COC_TEST_WRITE_SESSION_NOTES — exercise atomic .session-notes regen
 */

"use strict";

const TIMEOUT_MS = 5000;
const fallback = setTimeout(() => {
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readStdinSyncSafe() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function passthrough() {
  clearTimeout(fallback);
  try {
    process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  } catch {}
  process.exit(0);
}

function resolveMainCheckoutSafely(repoDir) {
  try {
    const { resolveMainCheckout } = require(
      path.join(__dirname, "lib", "state-resolver.js"),
    );
    return resolveMainCheckout(repoDir);
  } catch {
    return repoDir;
  }
}

function loadRoster(repoDir) {
  const p = path.join(repoDir, ".claude", "operators.roster.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function resolveIdentitySafely(repoDir) {
  const testFp = process.env.COC_TEST_FINGERPRINT;
  const testPid = process.env.COC_TEST_PERSON_ID;
  if (testFp && testPid) {
    return { verified_id: testFp, person_id: testPid };
  }
  try {
    const { resolveIdentity } = require(
      path.join(__dirname, "lib", "operator-id.js"),
    );
    return resolveIdentity(repoDir, {});
  } catch {
    return null;
  }
}

function readFoldedLog(repoDir) {
  try {
    const { foldLog } = require(
      path.join(__dirname, "lib", "coordination-log.js"),
    );
    const logPath = path.join(
      repoDir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    if (!fs.existsSync(logPath)) {
      return { accepted: [], rawRecords: [], foldState: null };
    }
    const raw = fs.readFileSync(logPath, "utf8");
    const records = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") records.push(obj);
      } catch {}
    }
    const roster = loadRoster(repoDir);
    const result = foldLog(records, roster, {});
    return {
      accepted: result.accepted || [],
      rawRecords: records,
      foldState: result.foldState || null,
    };
  } catch {
    return { accepted: [], rawRecords: [], foldState: null };
  }
}

function findOwnActiveClaims(accepted, ownFingerprint) {
  if (!Array.isArray(accepted) || !ownFingerprint) return [];
  const released = new Set();
  const reaped = new Set();
  for (const r of accepted) {
    if (!r) continue;
    if (r.type === "release" && r.content && r.content.claim_id) {
      released.add(r.content.claim_id);
    } else if (r.type === "reap" && r.content && r.content.claim_id) {
      reaped.add(r.content.claim_id);
    }
  }
  const out = [];
  for (const r of accepted) {
    if (!r || r.type !== "claim") continue;
    if (r.verified_id !== ownFingerprint) continue;
    const cid = r.content && r.content.claim_id;
    if (!cid) continue;
    if (released.has(cid)) continue;
    if (reaped.has(cid)) continue;
    out.push({ claim_id: cid, original: r });
  }
  return out;
}

function appendRecord(repoDir, record) {
  // Sec-MED-A1 (M5 iter-6): sessionend MUST sign appended records in
  // production. Pre-iter-6 sessionend wrote unsigned records → fold rule-1
  // rejected them → release records never settled → siblings saw stale
  // claims for the full 20 min TTL. Asymmetric vs adjacency-heartbeat
  // which DID sign at production.
  //
  // Test affordance: COC_TEST_SKIP_SIGN=1 preserves the Tier-2 unsigned
  // stub path for determinism. Production (skipSign=false) routes through
  // coc-sign.js::canonicalSerialize + sign, mirroring the heartbeat
  // protocol at adjacency-heartbeat.js:134-152.
  const skipSign = process.env.COC_TEST_SKIP_SIGN === "1";
  try {
    if (skipSign) {
      if (!record.sig) record.sig = "test-stub";
    } else {
      // Production: require key + sign. Defense-in-depth — if signing
      // fails (no key, sign-call returns ok:false), DROP the record
      // rather than writing an unsigned (rule-1-rejected) line.
      const { canonicalSerialize, sign } = require(
        path.join(__dirname, "lib", "coc-sign.js"),
      );
      const keyPath = process.env.COC_OPERATOR_KEY_PATH;
      if (!keyPath) return;
      // Canonicalize the record minus any sig field already present.
      // Co-signers (if any) carry their own sig material in
      // content.co_signers[] and are part of the canonical payload.
      const { sig: _existing, ...core } = record;
      const bytes = canonicalSerialize(core);
      const r = sign(bytes, { keyType: "ssh", keyPath });
      if (!r.ok) return;
      record = Object.assign({}, core, { sig: r.sig });
    }
    const logPath = path.join(
      repoDir,
      ".claude",
      "learning",
      "coordination-log.jsonl",
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
  } catch {
    // best-effort
  }
}

function cacheReleaseIntent(repoDir, claims) {
  try {
    const cachePath = path.join(
      repoDir,
      ".claude",
      "learning",
      ".session-end-cache",
    );
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        ts: new Date().toISOString(),
        released_claim_ids: claims.map((c) => c.claim_id),
      }) + "\n",
    );
  } catch {
    // best-effort
  }
}

function computeOwnChainHead(folded, ownVerifiedId) {
  // R8-LOW-2 consumer migration (M6 D Step 4a): delegate to the SSOT
  // helper exposed by coordination-log.js. The prior in-file
  // implementation (~35 LOC) was an exact behavioral copy; the
  // m6-d-coordination-log-helper.test.js parity test locks the
  // refactor against byte-for-byte drift.
  //
  // Rationale: when fold rule-2 (per-emitter chain integrity)
  // semantics change in coordination-log.js, the change MUST
  // propagate here automatically. The prior duplicated copy was
  // an institutional-knowledge bomb — silent drift the first time
  // someone updated _advanceChainState without remembering this
  // call site existed.
  const { computeOwnChainHead: ssot } = require(
    path.join(__dirname, "lib", "coordination-log.js"),
  );
  return ssot(folded, ownVerifiedId);
}

function releaseOwnClaims(repoDir, identity, claims, folded) {
  // Cache the release intent for next-session reconciliation.
  cacheReleaseIntent(repoDir, claims);
  // Sec-MED-A1 (M5 iter-6): chain-correct seq + prev_hash so the release
  // record passes fold rule-2 (per-emitter chain integrity). The prior
  // best-effort `seq: 9000 + i` violated rule-2 (no chain continuation
  // from the operator's prior accepted record) AND rule-1 (unsigned in
  // production). Fixing rule-1 alone was insufficient — rule-2 still
  // rejected. Compute the head from fold output and chain from there.
  const head = computeOwnChainHead(folded, identity.verified_id);
  let nextSeq = head ? head.lastSeq + 1 : 0;
  let prevHash = head ? head.lastContentHash : null;
  for (let i = 0; i < claims.length; i++) {
    const release = {
      type: "release",
      verified_id: identity.verified_id,
      person_id: identity.person_id,
      seq: nextSeq,
      prev_hash: prevHash,
      ts: new Date().toISOString(),
      content: { claim_id: claims[i].claim_id },
    };
    appendRecord(repoDir, release);
    // Advance chain head locally so subsequent releases chain correctly.
    try {
      const { canonicalSerialize } = require(
        path.join(__dirname, "lib", "coc-sign.js"),
      );
      const crypto = require("crypto");
      const bytes = canonicalSerialize(release);
      prevHash = crypto.createHash("sha256").update(bytes).digest("hex");
      nextSeq = release.seq + 1;
    } catch {
      // best-effort chain advance; if hashing fails, subsequent releases
      // may rule-2-reject but the first lands correctly.
      nextSeq = release.seq + 1;
    }
  }
}

function shouldAttemptCheckpoint() {
  return process.env.COC_TEST_FORCE_CHECKPOINT === "1";
}

function checkpointEligibility(roster, foldedState) {
  // Path A: derived-N >= 2 → owner cosig possible.
  // Path B: genuine-genesis N=1 → self-sign permitted.
  // Path C: revocation-induced N=1 → BLOCKED by r9s02-fence.
  try {
    const { gateEligibleForSelfSignedCheckpointOrRotation } = require(
      path.join(__dirname, "lib", "r9s02-fence.js"),
    );
    return gateEligibleForSelfSignedCheckpointOrRotation(roster, foldedState);
  } catch {
    return {
      eligible: false,
      reason: "r9s02-fence unavailable; blocked conservatively",
    };
  }
}

function findOwnerCosigner(roster, ownPersonId) {
  // Walk the roster for ANOTHER owner person eligible to co-sign.
  if (!roster || !roster.persons) return null;
  try {
    const { isEligibleSigner } = require(
      path.join(__dirname, "lib", "eligibility.js"),
    );
    for (const [pid, person] of Object.entries(roster.persons)) {
      if (pid === ownPersonId) continue;
      const r = isEligibleSigner(person, "owner-quorum");
      if (r && r.eligible) return { person_id: pid, person };
    }
  } catch {
    return null;
  }
  return null;
}

function emitCheckpoint(repoDir, identity, roster, foldedState) {
  if (!shouldAttemptCheckpoint()) return;
  // Fence input: in production the fence consults fold-accepted records
  // (signature-verified). In skip-sign test mode, raw records are passed
  // so the fence can observe attestation history that would otherwise be
  // rule-1-rejected in tests; production paths still flow through fold.
  const fenceRecords =
    process.env.COC_TEST_SKIP_SIGN === "1"
      ? foldedState.rawRecords || foldedState.accepted
      : foldedState.accepted;
  const gate = checkpointEligibility(roster, {
    records: fenceRecords,
  });
  if (!gate || !gate.eligible) {
    // R9-S-02 fence fired (or other gate): DO NOT emit self-signed checkpoint.
    return;
  }
  // Sec-MED-A1 / R7 closure (M5 iter-6): the prior placeholder cosig
  // literal was a stand-in for a 2-of-N owner cosig that this
  // single-session hook CANNOT actually produce — the cosigner's
  // private key lives on a different machine. Emitting a fake cosig sig
  // would either be rule-5-rejected at fold (defense holds) or, worse,
  // mask the fact that no real cosig occurred. The architecturally
  // honest emission is:
  //   - When a cosigner exists in roster AND eligibility passed via the
  //     N>=2 ladder: SKIP emission here; coordinated 2-of-N cosig flows
  //     through a separate handoff path (out of scope for sessionend).
  //   - When no cosigner exists (genuine-genesis-degenerate single owner):
  //     emit self-signed checkpoint via appendRecord (which signs in
  //     production per Sec-MED-A1).
  // (Per the structural sweep at tests/integration/multi-operator/
  // m5-iter6-hardening.test.js::iter6_structural_sweeps_still_clean, the
  // historical placeholder emission pattern has been removed.)
  const cosigner = findOwnerCosigner(roster, identity.person_id);
  if (cosigner) {
    // R8-LOW-1 (M6 D Step 4c): the prior path silently returned
    // when a cosigner existed but cosig coordination cannot be
    // completed from this one-sided hook. Silent skip means the
    // operator sees no checkpoint emission AND no signal that one
    // was skipped — exactly the failure mode observability.md
    // Rule 7 (bulk-op partial-failure WARN) generalizes.
    //
    // Surface the skip on both surfaces: stderr (operator UX) +
    // coordination-log record (forensic audit trail). The record
    // is type `checkpoint-skipped`, content carries reason +
    // cosigner's person_id; field schema mirrors session-end-cache
    // for downstream consumers.
    try {
      process.stderr.write(
        `[sessionend] checkpoint skipped — cosigner coordination required ` +
          `(cosigner.person_id=${cosigner.person_id}); 2-of-N cosig flows ` +
          `through a separate handoff path.\n`,
      );
    } catch {
      /* best-effort */
    }
    try {
      appendRecord(repoDir, {
        type: "checkpoint-skipped",
        verified_id: identity.verified_id,
        person_id: identity.person_id,
        ts: new Date().toISOString(),
        content: {
          reason: "cosigner-coordination-required",
          cosigner_person_id: cosigner.person_id,
        },
      });
    } catch {
      /* best-effort */
    }
    return;
  }
  const record = {
    type: "compaction-checkpoint",
    verified_id: identity.verified_id,
    person_id: identity.person_id,
    seq: 9999,
    ts: new Date().toISOString(),
    content: {
      up_to_seq: {},
      per_emitter_chain_heads: {},
      cumulative_delta: [],
      folded_state_digest: "stub",
      archive_gen_tip: null,
      co_signers: [],
      degenerate: "single-owner",
    },
  };
  appendRecord(repoDir, record);
}

function writeSessionNotesAtomic(repoDir, identity) {
  // M6 D §5.1: the legacy single-file `.session-notes` clobbers under N
  // concurrent writers. The layout is now:
  //   .session-notes.d/<display_id>.md  — per-operator fragment (this op's)
  //   .session-notes.shared.md          — forest ledger (per-row owner:,
  //                                       merged via coc-ledger driver)
  // Both lands via atomic `.tmp.<pid>` + rename inside the layout lib.
  if (process.env.COC_TEST_WRITE_SESSION_NOTES !== "1") return;
  // MO-OPT W1-e — opt-in gate (workspaces/multi-operator-optional, journal/0330).
  // The per-operator split (.session-notes.d/<display_id>.md + the
  // .session-notes.shared.md forest ledger) exists to solve the N-concurrent-
  // writer clobber — a coordination-ON artifact. A solo repo (coordination
  // OFF) writes a single tracked .session-notes (via /wrapup) and MUST NOT
  // scatter multi-operator fragments + a forest ledger. Skip the split when
  // OFF (the single-file form is the correct solo default, brief S1/S4). When
  // ENABLED, the split write is byte-unchanged (S6).
  const { isCoordinationEnabled } = require(
    path.join(__dirname, "lib", "coordination-mode.js"),
  );
  if (!isCoordinationEnabled(repoDir)) return;
  try {
    const layout = require(
      path.join(__dirname, "lib", "session-notes-layout.js"),
    );
    const body = [
      `# Session Notes (${identity.display_id || identity.person_id || "unknown"})`,
      `Session ended at: ${new Date().toISOString()}`,
      "",
      "Per-operator fragment under .session-notes.d/. Forest-ledger rows",
      "(cross-operator workstreams + blocked items) live in",
      ".session-notes.shared.md (per-row owner: attribution; merged via",
      "the coc-ledger driver registered in .gitattributes).",
    ].join("\n");
    const fragResult = layout.writePerOperatorFragment(
      repoDir,
      identity,
      body + "\n",
    );
    if (!fragResult.ok) {
      // Surface to coordination-log for forensic audit per
      // observability.md (operator MUST see write failures); do not throw
      // — sessionend MUST NEVER block per its header contract.
      try {
        appendRecord(repoDir, {
          type: "session-notes-layout-error",
          verified_id: identity.verified_id,
          person_id: identity.person_id,
          ts: new Date().toISOString(),
          content: {
            phase: "fragment",
            error: fragResult.error,
            reason: fragResult.reason,
          },
        });
      } catch {
        /* best-effort */
      }
    }
    // Ensure the forest ledger exists (header-only on first call; the
    // merge driver requires the table region to be present before
    // rows land via /wrapup / /journal flows).
    const ledgerResult = layout.ensureForestLedger(repoDir);
    if (!ledgerResult.ok) {
      try {
        appendRecord(repoDir, {
          type: "session-notes-layout-error",
          verified_id: identity.verified_id,
          person_id: identity.person_id,
          ts: new Date().toISOString(),
          content: {
            phase: "shared-ledger-ensure",
            error: ledgerResult.error,
            reason: ledgerResult.reason,
          },
        });
      } catch {
        /* best-effort */
      }
    }
  } catch (_) {
    // The layout lib is REQUIRED at runtime (M6 D ships it alongside
    // this hook). If the require fails, surface via coordination-log
    // best-effort and continue — never block sessionend.
    try {
      appendRecord(repoDir, {
        type: "session-notes-layout-error",
        verified_id: identity.verified_id,
        person_id: identity.person_id,
        ts: new Date().toISOString(),
        content: {
          phase: "require",
          error: "session-notes-layout require failed",
          reason: _ && _.message ? _.message : String(_),
        },
      });
    } catch {
      /* best-effort */
    }
  }
}

(function main() {
  try {
    readStdinSyncSafe();
    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const identity = resolveIdentitySafely(mainCheckout);
    if (!identity || !identity.verified_id) {
      passthrough();
      return;
    }
    const roster = loadRoster(mainCheckout);
    const folded = readFoldedLog(mainCheckout);

    // 1. Release own active claims (fold-accepted in production; raw under
    // skip-sign test mode so stub-sig fixture claims are still found).
    const claimsSource =
      process.env.COC_TEST_SKIP_SIGN === "1"
        ? folded.rawRecords || folded.accepted
        : folded.accepted;
    const ownClaims = findOwnActiveClaims(claimsSource, identity.verified_id);
    if (process.env.COC_TEST_FORCE_RELEASE === "1" && ownClaims.length > 0) {
      releaseOwnClaims(mainCheckout, identity, ownClaims, folded);
    } else if (ownClaims.length > 0) {
      // Production: emit release records for every own active claim.
      releaseOwnClaims(mainCheckout, identity, ownClaims, folded);
    }

    // 2. Emit checkpoint when size/age trigger met + eligibility OK.
    // R9-S-02 fence: gateEligibleForSelfSignedCheckpointOrRotation returns
    // eligible:false when N=1 traces to a revocation. emitCheckpoint
    // respects that — NO record appended in that case.
    emitCheckpoint(mainCheckout, identity, roster, folded);

    // 3. Atomic .session-notes regen (own operator section only).
    writeSessionNotesAtomic(mainCheckout, identity);

    passthrough();
  } catch (_) {
    // Never block.
    passthrough();
  }
})();
