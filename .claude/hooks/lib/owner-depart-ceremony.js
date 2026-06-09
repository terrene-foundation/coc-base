/**
 * owner-depart-ceremony — collaborator-distinctness-revocation ceremony
 * for shard A0b-2b.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — collaborator-distinctness-revocation (owner-departure ceremony):
 *     captures FRESH `gh api repos/{owner}/{repo}/collaborators` showing
 *     the login is NO LONGER a collaborator. R10-A-02 evidence window
 *     opens at the `ts` of the most recent X per-emitter chain entry
 *     the revoker has folded at ceremony time, closes at the revocation's
 *     own `ts`.
 *   §2.3 — owner departure + recovery (R7-A-03; residual-bounded R9-S-01
 *     per journal/0120). A revocation WITHOUT a fresh gh-api proof is
 *     INVALID (defeats omission). A revocation IS a self-produced gh-api
 *     fact and can be forged; the forgery is detected-eventually by
 *     fold rule 10's contest path.
 *   §4.5 — owner-departure residual (the §1.1 general structural-residual
 *     law instance; journal/0120 disposition is "detected-eventually +
 *     forger-named + bounded-window").
 *
 * The 1 invariant this module holds (invariant 2 of the shard contract):
 *
 *   (2) Revocation ceremony — at owner-departure, capture fresh gh-api
 *       proof the login is NO LONGER a collaborator, AND carry the
 *       R10-A-02 evidence window verbatim. A revocation without a fresh
 *       gh-api proof showing login absent fails closed.
 *
 * Style: CommonJS, zero-dep. Network IO + signing IO injected as
 * parameters. Same pattern A0b-2a established.
 */

"use strict";

const cocSign = require("./coc-sign.js");
const ghApiAllowlist = require("./gh-api-allowlist.js");
const githubLogin = require("./github-login.js");
// Azure DevOps port (Shard 2c): the ADO provider adapter for the revocation
// path. The ADO path binds the departing operator via `principal` (Entra UPN)
// and captures org members via the ADO Graph adapter (canonical inner shape).
const azureAdapter = require("./vcs-azure-adapter.js");

function defaultSign(bytes, opts) {
  return cocSign.sign(bytes, opts);
}

/**
 * Shared signing tail (provider-NEUTRAL): canonical-serialize + sign + attach
 * `sig`. Both the GitHub and ADO revocation paths hand their assembled
 * recordCore here so the signing envelope cannot drift between providers.
 *
 * @returns {{ok: true, record} | {ok: false, error}}
 */
function _signRecord(recordCore, signFn, keyType, keyPath) {
  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(recordCore);
  } catch (err) {
    return {
      ok: false,
      error: `canonicalSerialize failed: ${err && err.message ? err.message : err}`,
    };
  }
  const signResult = signFn(bytes, { keyType, keyPath });
  if (!signResult || !signResult.ok) {
    return {
      ok: false,
      error: `sign failed: ${signResult && signResult.reason ? signResult.reason : "unknown"}`,
    };
  }
  return { ok: true, record: { ...recordCore, sig: signResult.sig } };
}

/**
 * Build the provider-neutral R10-A-02 evidence window from the most-recent
 * folded victim chain entry. Identical shape for GitHub and ADO — fold rule 10
 * consumes it below the provider dispatch.
 */
function _buildEvidenceWindow(mostRecentVictimChainEntry, ts) {
  const mre = mostRecentVictimChainEntry;
  return {
    opens_at: mre && typeof mre.ts === "string" ? mre.ts : ts,
    closes_at: ts,
    victim_chain_high_water_seq:
      mre && typeof mre.seq === "number" ? mre.seq : -1,
  };
}

/**
 * Validate the provider-neutral signer/seq fields shared by both paths.
 */
function _validateSignerSeq(params) {
  if (!params.signer || typeof params.signer !== "object")
    return "signer missing";
  if (typeof params.signer.person_id !== "string" || !params.signer.person_id) {
    return "signer.person_id missing";
  }
  if (
    typeof params.signer.verified_id !== "string" ||
    !params.signer.verified_id
  ) {
    return "signer.verified_id missing";
  }
  if (typeof params.signer.keyPath !== "string" || !params.signer.keyPath) {
    return "signer.keyPath missing";
  }
  if (
    typeof params.seq !== "number" ||
    !Number.isInteger(params.seq) ||
    params.seq < 0
  ) {
    return "seq must be non-negative integer";
  }
  if (typeof params.now !== "function") return "now callback missing";
  return null;
}

function _validateInput(params) {
  if (!params || typeof params !== "object") return "params not an object";
  if (!params.roster || typeof params.roster !== "object")
    return "roster missing";
  if (typeof params.repoOwner !== "string" || !params.repoOwner) {
    return "repoOwner missing";
  }
  if (typeof params.repo !== "string" || !params.repo) return "repo missing";
  if (typeof params.departingLogin !== "string" || !params.departingLogin) {
    return "departingLogin missing";
  }
  if (!params.signer || typeof params.signer !== "object")
    return "signer missing";
  if (typeof params.signer.person_id !== "string" || !params.signer.person_id) {
    return "signer.person_id missing";
  }
  if (
    typeof params.signer.verified_id !== "string" ||
    !params.signer.verified_id
  ) {
    return "signer.verified_id missing";
  }
  if (typeof params.signer.keyPath !== "string" || !params.signer.keyPath) {
    return "signer.keyPath missing";
  }
  if (
    typeof params.seq !== "number" ||
    !Number.isInteger(params.seq) ||
    params.seq < 0
  ) {
    return "seq must be non-negative integer";
  }
  if (typeof params.ghApi !== "function") return "ghApi callback missing";
  if (typeof params.now !== "function") return "now callback missing";
  // mostRecentVictimChainEntry MAY be null (degenerate case: the revoker
  // has NEVER folded any X record). The evidence window's opens_at then
  // falls back to a deterministic "no observation" sentinel — but the
  // ceremony itself does NOT fail-closed on this; fold rule 10 simply
  // cannot evaluate strictly-prior. Document this in the receipt.
  return null;
}

/**
 * Run the revocation ceremony. Returns either:
 *   {ok: true, record: {...signed record...}}
 *   {ok: false, error: "<reason>"}
 *
 * The ceremony fails closed iff the fresh gh-api capture shows the
 * departing login IS STILL a collaborator. A genuine offline departure
 * (account deleted / signer cannot reach gh) → loud halt-and-report
 * is the CALLER'S responsibility (the command body) — this module
 * surfaces the underlying error via `ok: false` and the caller chooses
 * the user-visible exit code.
 *
 * @param {object} params
 * @param {object} params.roster - validated operators roster
 * @param {string} params.repoOwner
 * @param {string} params.repo
 * @param {string} params.departingLogin
 * @param {object} params.signer - {person_id, verified_id, keyPath, keyType?}
 * @param {number} params.seq
 * @param {string|null} params.prevHash
 * @param {function} params.now - () => ISO-8601 ts string
 * @param {function} params.ghApi - (endpoint) => {ok, status, body}
 * @param {object|null} params.mostRecentVictimChainEntry - the most
 *   recent X per-emitter chain entry the revoker has folded at ceremony
 *   time; {verified_id, seq, ts}. Used to populate the R10-A-02 evidence
 *   window's opens_at + victim_chain_high_water_seq.
 * @param {function} [params.sign] - optional sign override
 *
 * @returns {{ok: boolean, record?: object, error?: string}}
 */
function runRevocationCeremony(params) {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params not an object" };
  }
  if (!params.roster || typeof params.roster !== "object") {
    return { ok: false, error: "roster missing" };
  }

  // Azure DevOps port (Shard 2c): provider dispatch. `roster.genesis.provider`
  // (absent ⇒ "github") selects the path. The GitHub path below is byte-
  // UNCHANGED; the ADO path is fully additive in _runAdoRevocation.
  const providerId =
    (params.roster.genesis && params.roster.genesis.provider) || "github";
  if (providerId === "azure-devops") {
    return _runAdoRevocation(params);
  }
  if (providerId !== "github") {
    return {
      ok: false,
      error: `unknown provider "${providerId}" (github | azure-devops)`,
    };
  }

  const validateErr = _validateInput(params);
  if (validateErr) return { ok: false, error: validateErr };

  const signFn = params.sign || defaultSign;
  const keyType = params.signer.keyType || "ssh";

  // HIGH-3 (M0 security review): validate endpoint inputs BEFORE
  // interpolation.
  const repoOwnerValid = githubLogin.validateGithubLogin(params.repoOwner);
  if (!repoOwnerValid.valid) {
    return {
      ok: false,
      error: `repoOwner invalid: ${repoOwnerValid.reason}`,
    };
  }
  const repoNameValid = githubLogin.validateGithubRepoName(params.repo);
  if (!repoNameValid.valid) {
    return { ok: false, error: `repo invalid: ${repoNameValid.reason}` };
  }
  const departingValid = githubLogin.validateGithubLogin(params.departingLogin);
  if (!departingValid.valid) {
    return {
      ok: false,
      error: `departingLogin invalid: ${departingValid.reason}`,
    };
  }

  // 1. Fresh gh-api capture: verify departingLogin is NO LONGER a collaborator.
  const endpoint = `repos/${params.repoOwner}/${params.repo}/collaborators`;
  const capture = params.ghApi(endpoint);
  if (!capture || !capture.ok) {
    return {
      ok: false,
      error: `gh-api capture failed for ${endpoint}: status ${capture && capture.status} (genuine offline departure requires network-permitted ceremony; never zero-network self-asserted revocation)`,
    };
  }
  if (!Array.isArray(capture.body)) {
    return {
      ok: false,
      error: `gh-api capture body for ${endpoint} is not an array`,
    };
  }
  // F14 C2 iter-2 Q-MED-2: GitHub server semantics are case-insensitive
  // on logins. A strict `===` allowed an attacker submitting
  // departingLogin="Alice" while GitHub lists the still-present
  // collaborator as "alice" to bypass the stillPresent check —
  // stillPresent resolves undefined, the revocation proceeds against a
  // collaborator who is in fact still present. Sibling-class of
  // PR #316 MED-4 case-fold sweep + Q-MED-1 (genesis-ceremony).
  //
  // F14 C2 iter-3 root-cause fix: route through githubLogin.loginsEqual
  // (lib/github-login.js) — SSOT for case-insensitive compare. Was:
  // hand-rolled String(...).toLowerCase() === ... drifted from sibling
  // ceremonies' approach.
  const stillPresent = capture.body.find(
    (entry) =>
      entry &&
      typeof entry.login === "string" &&
      githubLogin.loginsEqual(entry.login, params.departingLogin),
  );
  if (stillPresent) {
    return {
      ok: false,
      error: `revocation fails closed: login '${params.departingLogin}' is still a collaborator on ${params.repoOwner}/${params.repo} per fresh gh api — a revocation without proof of departure defeats omission (architecture §2.1)`,
    };
  }

  // 2. Build the R10-A-02 evidence window.
  const ts = params.now();
  const mre = params.mostRecentVictimChainEntry;
  const evidenceWindow = {
    opens_at: mre && typeof mre.ts === "string" ? mre.ts : ts,
    closes_at: ts,
    victim_chain_high_water_seq:
      mre && typeof mre.seq === "number" ? mre.seq : -1,
  };

  // 3. Build the record's signable content.
  // HIGH-1 (M0 security review): allowlist collaborator-list capture.
  // M3 HIGH-4 / F-7: pass capture_ts pinned to record ts.
  const collaboratorsCapture = ghApiAllowlist._allowlistCollaboratorsList(
    capture.body,
    { capture_ts: ts },
  );
  const recordCore = {
    type: "collaborator-distinctness-revocation",
    verified_id: params.signer.verified_id,
    person_id: params.signer.person_id,
    seq: params.seq,
    prev_hash: params.prevHash || null,
    ts,
    content: {
      github_login: params.departingLogin,
      gh_api_collaborators_capture: collaboratorsCapture,
      captured_at_ts: ts,
      evidence_window: evidenceWindow,
    },
  };

  // 4. Canonical-serialize + sign.
  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(recordCore);
  } catch (err) {
    return {
      ok: false,
      error: `canonicalSerialize failed: ${err && err.message ? err.message : err}`,
    };
  }
  const signResult = signFn(bytes, { keyType, keyPath: params.signer.keyPath });
  if (!signResult || !signResult.ok) {
    return {
      ok: false,
      error: `sign failed: ${signResult && signResult.reason ? signResult.reason : "unknown"}`,
    };
  }

  // 5. Emit the signed record. NOTE PER ARCHITECTURE §4.5: this revocation
  // is itself a self-produced gh-api fact; it IS forgeable. Fold rule 10
  // (lib/fold-rule-10.js) detects the forgery eventually via X-signed
  // activity contradicting the evidence window. The §4.5 owner-departure
  // residual disposition (journal/0120) is "detected-eventually +
  // forger-named + bounded-window" — owner-accountability via the
  // revocation's signer is the cryptographic-naming trail.
  const record = { ...recordCore, sig: signResult.sig };
  return { ok: true, record };
}

// =========================================================================
// Azure DevOps port (Shard 2c) — _runAdoRevocation (additive). The ADO
// collaborator-distinctness revocation. Fails closed iff the fresh ADO members
// capture shows the departing principal IS STILL a member. Binds via
// `principal`; the evidence_window is provider-NEUTRAL (fold rule 10 reads it
// below the dispatch). Per architecture §4.5 the revocation is a self-produced
// fact and IS forgeable; fold rule 10's contest path detects forgery eventually
// and names the signing verified_id — identical to the GitHub path.
// =========================================================================

/**
 * Run the ADO revocation ceremony.
 *
 * @param {object} params
 * @param {object} params.roster - provider="azure-devops"; genesis.repo_owner
 *   the ADO org, genesis.ado_project the project ref.
 * @param {string} params.repo - the ADO repo slug.
 * @param {string} params.departingPrincipal - the Entra UPN departing.
 * @param {object} params.signer - {person_id, verified_id, keyPath, keyType?}
 * @param {number} params.seq
 * @param {string|null} params.prevHash
 * @param {function} params.now
 * @param {function} params.adoApi - ({service,path,meta?}) => {ok,status,body}
 * @param {object|null} params.mostRecentVictimChainEntry - {verified_id, seq, ts}
 * @param {function} [params.sign]
 *
 * @returns {{ok: boolean, record?: object, error?: string}}
 */
function _runAdoRevocation(params) {
  const signerSeqErr = _validateSignerSeq(params);
  if (signerSeqErr) return { ok: false, error: signerSeqErr };
  if (typeof params.adoApi !== "function") {
    return {
      ok: false,
      error:
        "adoApi callback missing (azure-devops revocation requires opts.adoApi)",
    };
  }
  if (
    typeof params.departingPrincipal !== "string" ||
    !params.departingPrincipal
  ) {
    return { ok: false, error: "departingPrincipal missing" };
  }
  if (typeof params.repo !== "string" || !params.repo) {
    return { ok: false, error: "repo missing (ADO repo slug)" };
  }

  const g = params.roster.genesis || {};
  if (typeof g.repo_owner !== "string" || !g.repo_owner) {
    return { ok: false, error: "roster.genesis.repo_owner missing (ADO org)" };
  }
  if (typeof g.ado_project !== "string" || !g.ado_project) {
    return {
      ok: false,
      error:
        "roster.genesis.ado_project missing (azure-devops requires the ADO project ref)",
    };
  }
  const repoRef = {
    org: g.repo_owner,
    project: g.ado_project,
    repo: params.repo,
  };
  const refValid = azureAdapter.validateRepoRef(repoRef);
  if (!refValid.valid) {
    return { ok: false, error: `repoRef invalid: ${refValid.reason}` };
  }
  const pValid = azureAdapter.validatePrincipal(params.departingPrincipal);
  if (!pValid.valid) {
    return {
      ok: false,
      error: `departingPrincipal invalid: ${pValid.reason}`,
    };
  }

  const signFn = params.sign || defaultSign;
  const keyType = params.signer.keyType || "ssh";
  const ts = params.now();

  // Fresh members capture: verify departingPrincipal is NO LONGER a member.
  const membersRes = azureAdapter.listCollaborators(params.adoApi, repoRef, {
    capture_ts: ts,
  });
  if (!membersRes.ok) {
    return {
      ok: false,
      error: `ADO members capture failed: ${membersRes.error} (${membersRes.reason}) — a revocation without a fresh ADO Graph proof defeats omission (architecture §2.1); genuine offline departure requires a network-permitted ceremony`,
    };
  }
  const members =
    (membersRes.capture && membersRes.capture.collaborators) || [];
  const stillPresent = members.find(
    (entry) =>
      entry &&
      typeof entry.login === "string" &&
      azureAdapter.principalsEqual(entry.login, params.departingPrincipal),
  );
  if (stillPresent) {
    return {
      ok: false,
      error: `revocation fails closed: principal '${params.departingPrincipal}' is still a member of ADO org '${g.repo_owner}' per fresh ADO Graph — a revocation without proof of departure defeats omission (architecture §2.1)`,
    };
  }

  const evidenceWindow = _buildEvidenceWindow(
    params.mostRecentVictimChainEntry,
    ts,
  );
  const recordCore = {
    type: "collaborator-distinctness-revocation",
    verified_id: params.signer.verified_id,
    person_id: params.signer.person_id,
    seq: params.seq,
    prev_hash: params.prevHash || null,
    ts,
    content: {
      provider: "azure-devops",
      principal: params.departingPrincipal,
      ado_api_members_capture: membersRes.capture,
      captured_at_ts: ts,
      evidence_window: evidenceWindow,
    },
  };
  return _signRecord(recordCore, signFn, keyType, params.signer.keyPath);
}

module.exports = {
  runRevocationCeremony,
};
