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

// #857: worker-mode flag. When present, this process is the DETACHED worker
// spawned by the parent — it runs the heavy teardown body DIRECTLY (never the
// parent spawn path, so there is no fork bomb).
const IS_WORKER = process.argv.includes("--coord-worker");

// #857: side-effect-observability flags. A test that sets one of these is
// asking to EXERCISE AND OBSERVE a side-effecting teardown path (release
// record / checkpoint / session-notes write), which requires the teardown to
// run SYNCHRONOUSLY so the effect is on disk when the test asserts. Production
// (the real harness) sets none of these → the parent detaches the worker and
// returns immediately (the #857 latency decoupling). This is NOT a behavior
// change to WHAT the teardown does — only to WHETHER the parent waits for it.
const SYNC_TEARDOWN =
  process.env.COC_TEST_WRITE_SESSION_NOTES === "1" ||
  process.env.COC_TEST_FORCE_RELEASE === "1" ||
  process.env.COC_TEST_FORCE_CHECKPOINT === "1";

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
  // CHFAPP (#868 reviewer R1 MED) — RETAINED SCOPE: this local appender is now
  // used by EXACTLY ONE call site — the genuine-genesis-degenerate self-signed
  // `compaction-checkpoint` in emitCheckpoint(). Every OTHER former caller
  // (checkpoint-skipped + the three session-notes-layout-error sites) was
  // converted to coc-emit.js::emitSignedRecord via emitTeardownRecord() below.
  // The checkpoint site is INTENTIONALLY left on this path: emit stamps a FRESH
  // per-emitter chain seq/prev_hash and runs the fail-closed fold-validate
  // guard, but a compaction-checkpoint carries a hardcoded sentinel `seq` and a
  // placeholder rule-5 payload (co_signers:[], degenerate:"single-owner") that
  // `coordination-log.js::_checkRule5` REJECTS — so emit's fold-validate would
  // refuse to append it (Δrejected=1). The checkpoint's rule-5 reconciliation
  // semantics are distinct from the per-emitter chain model; converting it
  // blindly would silently stop the checkpoint from landing. See the report /
  // commit body for the full disposition.
  //
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

function emitTeardownRecord(repoDir, identity, type, content) {
  // CHFAPP (#868 reviewer R1 MED): route the SessionEnd teardown WITNESS records
  // (checkpoint-skipped + session-notes-layout-error) through the canonical
  // coc-emit.js::emitSignedRecord — the same conversion #868 applied to
  // releaseOwnClaims. emit stamps verified_id/person_id, reads the emitter's
  // chain head FRESH per call (seq/prev_hash set by emit itself — callers MUST
  // NOT pass them), signs canonical bytes, runs the fail-closed COC-CHAIN
  // fold-validate guard, and enforces the 2KB MAX_LINE_BYTES refuse-on-overflow
  // cap. Pre-CHFAPP these records were hand-appended WITHOUT a seq, so every
  // fold SHAPE-rejected them (`_validateRecordShape` requires seq) — they landed
  // on disk but were invisible to every reader. Both types are now registered
  // no-op-accept predicates in coordination-log.js::_registerM0Defaults.
  //
  // Signing mirrors releaseOwnClaims exactly (its KEY-DISCOVERY + LOW-3 notes):
  //   - Test skip-sign (COC_TEST_SKIP_SIGN=1): inject a stub `sign`; emit's
  //     SKIP_SIGN short-circuit skips the fold-validate rule-1 gate for the stub.
  //   - Production: pass COC_OPERATOR_KEY_PATH EXPLICITLY (keyType "ssh") so the
  //     record signs with the SAME key the operator's chain was built with — NOT
  //     emit's default `git config user.signingkey` discovery (LOW-3: an
  //     unpinned git-config key signs with the WRONG key → rule-1-rejected at
  //     every reader's fold). When the key path is unset in production, SKIP
  //     emission (the pre-#868 `if (!keyPath) return` fail-safe) rather than
  //     gamble on an unpinned git-config key.
  //
  // Returns the emit result ({ok:true, record} | {ok:false, step, reason}).
  // NEVER throws: sessionend MUST NEVER block (header contract). On {ok:false}
  // the refusal is surfaced on stderr (knowledge-convergence.md Rule 6: surface,
  // never silently drop) and the record simply does not land — strictly
  // safer-or-equal to the pre-CHFAPP shape-rejected write.
  const skipSign = process.env.COC_TEST_SKIP_SIGN === "1";
  if (!skipSign && !process.env.COC_OPERATOR_KEY_PATH) {
    try {
      process.stderr.write(
        `[sessionend] COC_OPERATOR_KEY_PATH unset — skipping ${type} record ` +
          `emission rather than signing with an unpinned git-config key ` +
          `(security redteam LOW-3).\n`,
      );
    } catch {
      /* best-effort advisory only */
    }
    return {
      ok: false,
      step: "key-guard",
      reason: "COC_OPERATOR_KEY_PATH unset",
    };
  }
  const signOpts = skipSign
    ? { sign: () => ({ ok: true, sig: "test-stub" }) }
    : { signingKeyPath: process.env.COC_OPERATOR_KEY_PATH, keyType: "ssh" };
  let result;
  try {
    const { emitSignedRecord } = require(
      path.join(__dirname, "lib", "coc-emit.js"),
    );
    result = emitSignedRecord(
      Object.assign({ repoDir, type, content, identity }, signOpts),
    );
  } catch (err) {
    result = {
      ok: false,
      step: "emit-threw",
      reason: err && err.message ? err.message : String(err),
    };
  }
  if (!result || !result.ok) {
    try {
      process.stderr.write(
        `[sessionend] ${type} record refused ` +
          `(step=${result && result.step}): ${result && result.reason} — ` +
          `degrading to no-record; continuing.\n`,
      );
    } catch {
      /* best-effort advisory only */
    }
  }
  return result;
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
  // #868: release emission now routes through coc-emit.js::emitSignedRecord
  // (which reads the chain head FRESH per call). This wrapper is retained as
  // the R8-LOW-2 parity-contract surface — m6-shard-d-r8-followups.test.js
  // source-greps for `function computeOwnChainHead(folded, ownVerifiedId)` +
  // `computeOwnChainHead: ssot` to lock the SSOT delegation against drift.
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

function releaseOwnClaims(repoDir, identity, claims) {
  // Cache the release intent for next-session reconciliation.
  cacheReleaseIntent(repoDir, claims);

  // #868 (Sec-MED-A1 trust-substrate equivocation-safety): route each RELEASE
  // record through the canonical coc-emit.js::emitSignedRecord. The prior
  // in-file path computed seq/prev_hash from the parent-supplied fold ONCE and
  // advanced the chain head LOCALLY across the loop (sign + fs.appendFileSync
  // directly). Under the #857 detached-worker model that EQUIVOCATES: two
  // SAME-verified_id workers both read the same stale fold head and both emit
  // seq=N+1 → the per-emitter chain forks (fold rule 3 frames the operator as
  // an equivocator). emitSignedRecord reads the chain head FRESH from the LIVE
  // log on EVERY call (refuse-don't-fork), sets seq/prev_hash ITSELF (callers
  // MUST NOT pass them), runs the fail-closed COC-CHAIN fold guard, and enforces
  // the 2KB cap.
  //
  // KEY-DISCOVERY: the old appendRecord signed with COC_OPERATOR_KEY_PATH +
  // hardcoded keyType "ssh"; emit's DEFAULT discovery reads
  // `git config user.signingkey` (may be a DIFFERENT key or none). Pass the key
  // EXPLICITLY so the release signs with the SAME key the operator's existing
  // chain was built with — else the release signs with the wrong key (breaks
  // the operator's chain at fold rule-1) or discovers none (silent drop).
  //
  // Test skip-sign: inject a stub `sign` returning the test-stub sig; emit's
  // COC_TEST_SKIP_SIGN=1 short-circuit skips the fold-validate guard for the
  // stub-signed record (per emit's docstring — a stub-signed record on the
  // default-append path fails rule-1 at the validation fold unless SKIP_SIGN=1).
  const { emitSignedRecord } = require(
    path.join(__dirname, "lib", "coc-emit.js"),
  );
  const skipSign = process.env.COC_TEST_SKIP_SIGN === "1";

  // LOW-3 (security redteam): when COC_OPERATOR_KEY_PATH is unset, emit's default
  // key-discovery reverts to `git config user.signingkey` — which may be a
  // DIFFERENT key than the operator's chain was built with, signing the release
  // with the WRONG key (rule-1-rejected at every reader's fold, and the operator's
  // subsequent same-emitter records may rule-2/3-break behind the rejected line)
  // instead of the intended pin. The pre-#868 appendRecord path fail-safe-DROPPED
  // when the key path was absent (`if (!keyPath) return`); restore that fail-safe
  // rather than gamble on an unpinned git-config key. Releases are NOT emitted →
  // the claims linger to TTL (the SAME safe degradation as an {ok:false} sign
  // failure below); the release intent is already cached at cacheReleaseIntent above.
  if (!skipSign && !process.env.COC_OPERATOR_KEY_PATH) {
    try {
      process.stderr.write(
        "[sessionend] COC_OPERATOR_KEY_PATH unset — skipping release-record " +
          "emission (claims linger to TTL) rather than signing with an unpinned " +
          "git-config key (security redteam LOW-3).\n",
      );
    } catch {
      /* best-effort advisory only */
    }
    return;
  }

  const signOpts = skipSign
    ? { sign: () => ({ ok: true, sig: "test-stub" }) }
    : { signingKeyPath: process.env.COC_OPERATOR_KEY_PATH, keyType: "ssh" };

  for (let i = 0; i < claims.length; i++) {
    // RESIDUAL EQUIVOCATION WINDOW (#868 Option A — shrunk, NOT eliminated).
    // emit's per-call chain-head read is read-then-append, NON-atomic: two
    // SAME-verified_id detached workers that BOTH read head=N before either
    // appends still both emit seq=N+1 and both pass fold-validate → a fork.
    // This is STRICTLY SAFER than the prior whole-loop stale-head advance
    // (which forked the ENTIRE release batch on any concurrency; this forks
    // only the races overlapping the sub-ms read→append window), and a fork
    // degrades to the SAME failure mode as today: the losing release lingers
    // as a stale claim until its TTL. A lease/mutex (Option B) that closes the
    // window is deliberately NOT built here — it is a separate, larger shard
    // the human gates IF the redteam proves this residual reachable.
    const result = emitSignedRecord(
      Object.assign(
        {
          repoDir,
          type: "release",
          content: { claim_id: claims[i].claim_id },
          identity,
        },
        signOpts,
      ),
    );
    if (!result || !result.ok) {
      // Sec-MED-A1 TRAP: emit adds 3 refusal paths the old best-effort
      // appendRecord lacked — (a) already-forked live chain (step
      // fold-validate), (b) no signing key (step sign), (c) 2KB cap (step
      // append). DEGRADE VISIBLY: surface the refusal on stderr for the
      // forensic trail and CONTINUE to the next claim. The release does not
      // land → the claim lingers to its TTL — strictly safer-or-equal to the
      // pre-#868 append (which ALSO lost a release to TTL under concurrency).
      // NEVER throw: sessionend MUST NEVER block (header contract), and the
      // downstream writeSessionNotesAtomic MUST still run.
      try {
        process.stderr.write(
          `[sessionend] release refused for claim ${claims[i].claim_id} ` +
            `(step=${result && result.step}): ${result && result.reason} — ` +
            `degrading to fork→stale-claim-lingers-to-TTL; continuing.\n`,
        );
      } catch {
        /* best-effort advisory only */
      }
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
    emitTeardownRecord(repoDir, identity, "checkpoint-skipped", {
      reason: "cosigner-coordination-required",
      cosigner_person_id: cosigner.person_id,
    });
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
      emitTeardownRecord(repoDir, identity, "session-notes-layout-error", {
        phase: "fragment",
        error: fragResult.error,
        reason: fragResult.reason,
      });
    }
    // Ensure the forest ledger exists (header-only on first call; the
    // merge driver requires the table region to be present before
    // rows land via /wrapup / /journal flows).
    const ledgerResult = layout.ensureForestLedger(repoDir);
    if (!ledgerResult.ok) {
      emitTeardownRecord(repoDir, identity, "session-notes-layout-error", {
        phase: "shared-ledger-ensure",
        error: ledgerResult.error,
        reason: ledgerResult.reason,
      });
    }
  } catch (_) {
    // The layout lib is REQUIRED at runtime (M6 D ships it alongside
    // this hook). If the require fails, surface via coordination-log
    // best-effort and continue — never block sessionend.
    emitTeardownRecord(repoDir, identity, "session-notes-layout-error", {
      phase: "require",
      error: "session-notes-layout require failed",
      reason: _ && _.message ? _.message : String(_),
    });
  }
}

// ---- the heavy coordination teardown (shared by worker + sync-test path) ----

function performTeardown(mainCheckout, identity) {
  // The SAME coordination work the hook always did — releaseOwnClaims →
  // emitCheckpoint → writeSessionNotesAtomic. No coordination semantics are
  // skipped or weakened; #857 only changed WHEN this runs relative to the
  // hook's return (in a detached worker for production; inline for tests that
  // observe side effects). Callers own process lifecycle (exit / passthrough).
  const roster = loadRoster(mainCheckout);
  const folded = readFoldedLog(mainCheckout);

  // 1. Release own active claims (fold-accepted in production; raw under
  // skip-sign test mode so stub-sig fixture claims are still found).
  const claimsSource =
    process.env.COC_TEST_SKIP_SIGN === "1"
      ? folded.rawRecords || folded.accepted
      : folded.accepted;
  const ownClaims = findOwnActiveClaims(claimsSource, identity.verified_id);
  // Emit release records for every own active claim (production + the
  // COC_TEST_FORCE_RELEASE sync-observability path run identically — the two
  // former branches were byte-identical; the env var only decides WHETHER the
  // parent runs teardown inline, in runParent, not WHAT the teardown does).
  if (ownClaims.length > 0) {
    releaseOwnClaims(mainCheckout, identity, ownClaims);
  }

  // 2. Emit checkpoint when size/age trigger met + eligibility OK.
  // R9-S-02 fence: gateEligibleForSelfSignedCheckpointOrRotation returns
  // eligible:false when N=1 traces to a revocation. emitCheckpoint
  // respects that — NO record appended in that case.
  emitCheckpoint(mainCheckout, identity, roster, folded);

  // 3. Atomic .session-notes regen (own operator section only).
  writeSessionNotesAtomic(mainCheckout, identity);
}

// ---- worker: the heavy teardown off the harness path -----------------------

function runWorker() {
  // #857: this runs in the DETACHED worker process spawned by runParent(). It
  // survives the parent's immediate passthrough exit (detached + own process
  // group). The parent owns the setTimeout self-fallback; the worker is NOT
  // harness-bounded, so disarm it here (the teardown body is synchronous — a
  // lingering timer would only keep the worker alive after its work completes).
  clearTimeout(fallback);
  try {
    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const identity = resolveIdentitySafely(mainCheckout);
    if (identity && identity.verified_id) {
      performTeardown(mainCheckout, identity);
    }
    process.exit(0);
  } catch (_) {
    process.exit(0);
  }
}

// ---- parent: harness-invoked; spawn the worker, return immediately ---------

function runParent() {
  try {
    // #857: do NOT synchronously read stdin here. A blocking fs.readFileSync(0)
    // freezes the event loop when fd 0 is an open pipe with no EOF (the headless
    // `claude -p --input-format stream-json` condition), which defeats the
    // setTimeout fallback above and hangs session teardown (surfacing as
    // "SessionEnd hook … Hook cancelled"). This hook derives all state from
    // CLAUDE_PROJECT_DIR and never used the stdin payload.
    //
    // #857 fix: the GPG-heavy fold/sign/verify teardown ran synchronously on
    // the harness critical path (~6-7s) and blew the 5s budget every time. We
    // now resolve identity cheaply (no GPG), then either detach the teardown
    // (production — passthrough returns in the spawn cost, <1s) or run it
    // inline (SYNC_TEARDOWN test paths that must observe the side effect).
    const mainCheckout = resolveMainCheckoutSafely(PROJECT_DIR);
    const identity = resolveIdentitySafely(mainCheckout);
    if (!identity || !identity.verified_id) {
      // No identity → no coordination work to do; skip the worker spawn.
      passthrough();
      return;
    }
    if (SYNC_TEARDOWN) {
      // Test-observability path: run the teardown inline so the release /
      // checkpoint / session-notes effect is on disk before passthrough
      // returns. Never block (best-effort) — sessionend MUST NEVER block.
      try {
        performTeardown(mainCheckout, identity);
      } catch {
        /* best-effort */
      }
      passthrough();
      return;
    }
    // Production: spawn the detached worker (own process group; survives our
    // exit + a harness SIGTERM to our group). Best-effort — on spawn failure
    // we still passthrough (sessionend MUST NEVER block per its header).
    const { spawnDetachedWorker } = require(
      path.join(__dirname, "lib", "coord-background.js"),
    );
    spawnDetachedWorker(__filename);
    passthrough();
  } catch (_) {
    // Never block.
    passthrough();
  }
}

if (IS_WORKER) {
  runWorker();
} else {
  runParent();
}
