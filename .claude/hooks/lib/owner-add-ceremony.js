/**
 * owner-add-ceremony — collaborator-distinctness-attestation ceremony for
 * shard A0b-2b.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — collaborator-distinctness-attestation (owner-add ceremony):
 *     captures `gh api repos/{owner}/{repo}/collaborators` showing the
 *     login IS a distinct collaborator, signed at ceremony time.
 *   §2.2 — record type is checkpoint-exempt witness (rule 6 generic);
 *     advisory-for-record-authority but authority-for-aggregate-derived-N
 *     (R7-S-05 / R6-A-03 orthogonal).
 *
 * The 1 invariant this module holds (invariant 1 of the shard contract):
 *
 *   (1) Attestation ceremony — at owner-add, capture `gh api
 *       repos/{owner}/{repo}/collaborators` showing the named login IS
 *       a distinct collaborator. Sign the response + record metadata.
 *
 * Style: CommonJS, zero-dep. Network IO (`gh api`) and signing IO are
 * injected as function parameters (ghApi, sign, now) so the module is
 * deterministically testable. Same pattern A0b-2a's genesis-ceremony.js
 * established.
 */

"use strict";

const cocSign = require("./coc-sign.js");
const ghApiAllowlist = require("./gh-api-allowlist.js");
const githubLogin = require("./github-login.js");

/**
 * Default sign function bound to coc-sign. Callers MAY override for
 * testing or to use a non-default key path.
 */
function defaultSign(bytes, opts) {
  return cocSign.sign(bytes, opts);
}

/**
 * Validate ceremony input. Returns null on OK, error string otherwise.
 */
function _validateInput(params) {
  if (!params || typeof params !== "object") return "params not an object";
  if (!params.roster || typeof params.roster !== "object")
    return "roster missing";
  if (typeof params.repoOwner !== "string" || !params.repoOwner) {
    return "repoOwner missing";
  }
  if (typeof params.repo !== "string" || !params.repo) return "repo missing";
  if (typeof params.newOwnerLogin !== "string" || !params.newOwnerLogin) {
    return "newOwnerLogin missing";
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
  return null;
}

/**
 * Run the attestation ceremony. Returns either:
 *   {ok: true, record: {...signed record...}}  — emit + append
 *   {ok: false, error: "<reason>"}             — fail-CLOSED, do not emit
 *
 * @param {object} params
 * @param {object} params.roster - the validated operators roster
 * @param {string} params.repoOwner - owner login (e.g. "alice")
 * @param {string} params.repo - repo name (e.g. "test-repo")
 * @param {string} params.newOwnerLogin - the login being attested
 * @param {object} params.signer - {person_id, verified_id, keyPath, keyType?}
 * @param {number} params.seq - the signer's next per-emitter seq
 * @param {string|null} params.prevHash - per-emitter hash-chain prev_hash
 * @param {function} params.now - () => ISO-8601 ts string
 * @param {function} params.ghApi - (endpoint) => {ok, status, body}
 * @param {function} [params.sign] - optional sign override (defaults to coc-sign.sign)
 *
 * @returns {{ok: boolean, record?: object, error?: string}}
 */
function runAttestationCeremony(params) {
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
  const newLoginValid = githubLogin.validateGithubLogin(params.newOwnerLogin);
  if (!newLoginValid.valid) {
    return {
      ok: false,
      error: `newOwnerLogin invalid: ${newLoginValid.reason}`,
    };
  }

  // 1. gh-api capture: verify newOwnerLogin IS in collaborators.
  const endpoint = `repos/${params.repoOwner}/${params.repo}/collaborators`;
  const capture = params.ghApi(endpoint);
  if (!capture || !capture.ok) {
    return {
      ok: false,
      error: `gh-api capture failed for ${endpoint}: status ${capture && capture.status}`,
    };
  }
  if (!Array.isArray(capture.body)) {
    return {
      ok: false,
      error: `gh-api capture body for ${endpoint} is not an array`,
    };
  }
  // F14 C2 iter-3: case-insensitive login compare per GitHub server semantics.
  // Pre-iter-3, strict === allowed server 'entry.login: "alice"' to fail
  // attestation when ceremony asserted 'newOwnerLogin: "Alice"' — silent
  // owner-enrollment integrity failure.
  const found = capture.body.find(
    (entry) =>
      entry &&
      typeof entry.login === "string" &&
      githubLogin.loginsEqual(entry.login, params.newOwnerLogin),
  );
  if (!found) {
    return {
      ok: false,
      error: `attestation fails closed: login '${params.newOwnerLogin}' is NOT a collaborator on ${params.repoOwner}/${params.repo} per fresh gh api`,
    };
  }

  // 2. Build the record's signable content.
  const ts = params.now();
  // HIGH-1 (M0 security review): allowlist collaborator-list capture.
  // M3 HIGH-4 / F-7: pass capture_ts so the freshness predicate downstream
  // has a stable anchor; ceremony captures + signs in one transaction, so
  // capture_ts == ts is the honest pin.
  const collaboratorsCapture = ghApiAllowlist._allowlistCollaboratorsList(
    capture.body,
    { capture_ts: ts },
  );
  const recordCore = {
    type: "collaborator-distinctness-attestation",
    verified_id: params.signer.verified_id,
    person_id: params.signer.person_id,
    seq: params.seq,
    prev_hash: params.prevHash || null,
    ts,
    content: {
      github_login: params.newOwnerLogin,
      gh_api_collaborators_capture: collaboratorsCapture,
      captured_at_ts: ts,
    },
  };

  // 3. Canonical-serialize + sign.
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

  // 4. Emit the signed record.
  const record = { ...recordCore, sig: signResult.sig };
  return { ok: true, record };
}

module.exports = {
  runAttestationCeremony,
};
