/**
 * gh-api-allowlist — response-capture allowlists for ceremony gh-api captures.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.3 — genesis-anchor + collaborator-distinctness-attestation/revocation
 *     records capture gh-api response bodies for signature-bound evidence.
 *
 * Rationale (M0 security review HIGH-1):
 *   Whole-body capture stores far more than the verification semantics
 *   require — `repos/{owner}/{repo}` carries `description`, `homepage`,
 *   `private`, `billing_email`, etc.; commit responses carry internal
 *   `node_id`s, stats, parent SHAs. Each captured field becomes permanent
 *   in signed records on every clone. Allowlisting at capture time bounds
 *   the disclosure surface to the fields downstream fold/verify predicates
 *   actually read (per `fold-genesis-anchor.js` and the architecture's
 *   three-pinned-facts check).
 *
 * M3 hardening (HIGH-4 / F-7): capture_ts is preserved + carried through
 * every allowlisted shape so fold-time predicates can enforce freshness
 * against the consuming record's ts. Replay of historical gh-api captures
 * is BLOCKED by the freshness predicate `_isCaptureFresh`.
 *
 * M3 hardening (HIGH-2 / F-3): R5-S-07 distinct-bound-collaborator helper
 * lives here as the natural home — every cosig predicate (fold-rule-9b/9c,
 * reap-ceremony) consumes the collaborators capture AND needs to verify
 * that primary + cosigner resolve to DISTINCT bound github logins.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O.
 */

"use strict";

// F14 C2 iter-3 root-cause fix: GitHub server-side login semantics are
// case-insensitive. Route ALL login comparisons through loginsEqual()
// (lib/github-login.js) — closes R5-S-07 sock-puppet via case-mismatch.
const { loginsEqual } = require("./github-login.js");

/**
 * Freshness ceiling for a gh-api capture relative to the consuming
 * record's `ts`. 5 minutes (300_000 ms) is the conservative ceremony-time
 * default: a ceremony performs the capture, signs immediately, and
 * appends to the log — the entire ceremony executes in seconds. A 5-min
 * ceiling tolerates clock skew + slow ceremony hosts; it does NOT
 * tolerate replay of a capture from a previous day/week/month.
 *
 * Configurable per call via `_isCaptureFresh(captureTs, recordTs, {
 * freshnessMs })` for tests that need to assert behavior at the boundary.
 */
const GH_API_CAPTURE_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * Freshness ceiling for a `genesis-migration` ceremony's gh-api capture,
 * distinct from the routine-enrollment `GH_API_CAPTURE_FRESHNESS_MS`.
 *
 * Migration ceremonies (per `multi-operator-coordination.md` MUST-7) are
 * multi-step: (1) capture `gh api repos/{owner}/{repo}` external owner,
 * (2) capture `gh api repos/{owner}/{repo}/commits/{new_root_commit}` for
 * re-anchor sub-case, (3) capture `gh api orgs/{org}/memberships/{user}`
 * for the N=1 org-admin anchor under MUST-7, (4) verify local + origin
 * root-commit SHA agreement, (5) sign the migration record. The composite
 * ceremony can legitimately span up to ~15 minutes when the operator
 * stalls between captures (network hiccup, MFA re-prompt, switching
 * windows) — the 5-min routine-enrollment ceiling rejects every legitimate
 * migration in practice.
 *
 * 15 minutes (900_000 ms) is the conservative migration-ceremony ceiling:
 * tolerates multi-step ceremony + clock skew + worker boundary stalls;
 * does NOT tolerate replay of a capture from a previous hour/day/month.
 *
 * Per F86 acceptance criterion (2): exported here so the fold-rule-9c.js
 * amendment (paired with `genesis-ceremony.js::performMigration`) can
 * re-verify capture freshness at fold time without re-deriving the
 * constant. Distinct from `GH_API_CAPTURE_FRESHNESS_MS` so an unrelated
 * routine-enrollment freshness change cannot silently change migration
 * semantics.
 */
const MIGRATION_LIVENESS_TTL = 15 * 60 * 1000;

/**
 * Strip keys whose value is exactly `undefined`. `null` is preserved
 * because the allowlist explicitly uses null to signal "field absent in
 * the upstream response". This keeps canonicalSerialize (which rejects
 * `undefined`) happy while still recording presence-by-null in signed
 * records.
 */
function _omitUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/**
 * Allowlist for `gh api repos/{owner}/{repo}` response capture (owner-check).
 *
 * Downstream consumer (fold-genesis-anchor.js + ceremony): body.owner.login
 * is the only verification-semantics field. Capture name + full_name as
 * audit context; everything else is dropped.
 *
 * @param {object} body - the gh-api response body (raw)
 * @param {object} [opts] - { capture_ts: ISO-8601 string } (M3 HIGH-4: required)
 *   The caller MUST supply the capture timestamp; the allowlist refuses to
 *   produce an output that lacks capture_ts (fold-time freshness predicate
 *   depends on it). For backward compat, callers passing no opts get a
 *   capture_ts of `new Date().toISOString()` — but ceremony writers SHOULD
 *   pass the explicit ts so the signed record carries the actual capture
 *   moment, not the allowlist-call moment.
 */
function _allowlistRepoOwner(body, opts) {
  if (!body || typeof body !== "object") return body;
  const out = {
    owner: body.owner
      ? _omitUndefined({
          login: body.owner.login,
          type: body.owner.type,
        })
      : null,
  };
  if (body.name !== undefined) out.name = body.name;
  if (body.full_name !== undefined) out.full_name = body.full_name;
  // M3 HIGH-4 / F-7: capture_ts is required for fold-time freshness check.
  const captureTs =
    (opts && typeof opts.capture_ts === "string" && opts.capture_ts) ||
    new Date().toISOString();
  out.capture_ts = captureTs;
  return out;
}

/**
 * Allowlist for `gh api .../commits/{root_commit}` response capture.
 *
 * Downstream consumer (genesis-ceremony.js step 4): verification.verified,
 * verification.reason, verification.signature, verification.payload,
 * commit.author.{name,email,date}, body.author.login. These are the fields
 * that bind the root-commit verification to the declared owner.
 *
 * Issue #358 (org-owned bootstrap relaxation): when a ceremony succeeds
 * with verification.verified === false under the org-owned bootstrap
 * path, the signed genesis-anchor record's gh_api_root_commit_capture
 * carries both verification.verified (the unverified state) AND
 * verification.reason (e.g. "unsigned") — these fields are part of the
 * allowlist below and are captured verbatim. Auditors inspecting the
 * record can therefore see the root commit was unverified AND
 * (cross-referencing the sibling gh_api_org_membership_capture) see
 * the ceremony proceeded under the verified-admin attestation path
 * (Step 3 returned role=="admin" + state=="active"). The two captures
 * together are the structural evidence trail for the relaxation.
 */
function _allowlistCommitVerification(body, opts) {
  if (!body || typeof body !== "object") return body;
  const out = {};
  if (body.sha !== undefined) out.sha = body.sha;
  if (body.commit) {
    out.commit = _omitUndefined({
      author: body.commit.author
        ? _omitUndefined({
            name: body.commit.author.name,
            email: body.commit.author.email,
            date: body.commit.author.date,
          })
        : null,
      verification: body.commit.verification
        ? _omitUndefined({
            verified: body.commit.verification.verified,
            reason: body.commit.verification.reason,
            signature: body.commit.verification.signature,
            payload: body.commit.verification.payload,
          })
        : null,
    });
  } else {
    out.commit = null;
  }
  out.author = body.author
    ? _omitUndefined({ login: body.author.login })
    : null;
  // M3 HIGH-4 / F-7: capture_ts.
  out.capture_ts =
    (opts && typeof opts.capture_ts === "string" && opts.capture_ts) ||
    new Date().toISOString();
  return out;
}

/**
 * Allowlist for `gh api orgs/{org}/memberships/{login}` response capture
 * (R5-S-02 org variant).
 *
 * Downstream consumer (genesis-ceremony.js step 3 + fold-genesis-anchor.js
 * _resolveOwnerPerson): role + user.login + organization.login. The state
 * field is captured as audit context (the ceremony also asserts the bind
 * was active at ceremony time).
 */
function _allowlistOrgMembership(body, opts) {
  if (!body || typeof body !== "object") return body;
  const out = _omitUndefined({
    role: body.role,
    state: body.state,
  });
  out.user = body.user ? _omitUndefined({ login: body.user.login }) : null;
  out.organization = body.organization
    ? _omitUndefined({ login: body.organization.login })
    : null;
  // M3 HIGH-4 / F-7: capture_ts.
  out.capture_ts =
    (opts && typeof opts.capture_ts === "string" && opts.capture_ts) ||
    new Date().toISOString();
  return out;
}

/**
 * Allowlist for `gh api .../collaborators` response array (attestation +
 * revocation + reap-ceremony + generation-rotation + genesis-migration).
 *
 * Downstream consumers:
 *   - owner-add-ceremony.js / owner-depart-ceremony.js — derive bound
 *     github logins for R5-S-07 distinct-bound-collaborator (HIGH-2).
 *   - fold-rule-9b (generation-rotation), fold-rule-9c (genesis-migration),
 *     reap-ceremony — call _verifyDistinctBoundCollaborators(primaryLogin,
 *     cosignerLogin, capture) to enforce sock-puppet defense.
 *
 * Shape change (M3 HIGH-2/HIGH-4):
 *   Prior shape: bare Array<{login, type, permissions}>
 *   New shape:   { collaborators: Array<...>, capture_ts: ISO-8601 }
 *
 * The wrapped object preserves the capture timestamp (HIGH-4 freshness
 * predicate) AND surfaces the collaborators array under a stable key
 * (`capture.collaborators`) that downstream cosig predicates consume
 * deterministically. Non-array bodies pass through unchanged so the
 * ceremony's own non-array detection surfaces the error.
 */
function _allowlistCollaboratorsList(body, opts) {
  if (!Array.isArray(body)) return body;
  const collaborators = body.map((c) => {
    const out = _omitUndefined({ login: c.login, type: c.type });
    out.permissions = c.permissions
      ? { admin: !!c.permissions.admin, push: !!c.permissions.push }
      : null;
    return out;
  });
  // M3 HIGH-4 / F-7: capture_ts.
  const captureTs =
    (opts && typeof opts.capture_ts === "string" && opts.capture_ts) ||
    new Date().toISOString();
  return { collaborators, capture_ts: captureTs };
}

/**
 * Freshness predicate (M3 HIGH-4 / F-7).
 *
 * Returns true iff the consuming record's `ts` is within
 * `freshnessMs` (default `GH_API_CAPTURE_FRESHNESS_MS`) of the capture's
 * `capture_ts`. Replay of historical captures fails this predicate.
 *
 * Bidirectional check: the record's ts MUST be at or after capture_ts
 * (you cannot use a capture from the future), AND no more than
 * freshnessMs after it.
 *
 * @param {string} captureTs - ISO-8601 capture timestamp
 * @param {string} recordTs  - ISO-8601 consuming record's ts
 * @param {object} [opts]    - { freshnessMs?: number }
 * @returns {{fresh: boolean, reason?: string, elapsedMs?: number}}
 */
function _isCaptureFresh(captureTs, recordTs, opts) {
  const ceiling =
    (opts && typeof opts.freshnessMs === "number" && opts.freshnessMs) ||
    GH_API_CAPTURE_FRESHNESS_MS;
  if (typeof captureTs !== "string" || !captureTs) {
    return { fresh: false, reason: "capture_ts missing or not a string" };
  }
  if (typeof recordTs !== "string" || !recordTs) {
    return { fresh: false, reason: "record ts missing or not a string" };
  }
  const cap = Date.parse(captureTs);
  const rec = Date.parse(recordTs);
  if (Number.isNaN(cap)) {
    return { fresh: false, reason: `capture_ts unparseable: ${captureTs}` };
  }
  if (Number.isNaN(rec)) {
    return { fresh: false, reason: `record ts unparseable: ${recordTs}` };
  }
  const elapsed = rec - cap;
  if (elapsed < 0) {
    return {
      fresh: false,
      reason: `capture_ts ${captureTs} is in the future relative to record ts ${recordTs}`,
      elapsedMs: elapsed,
    };
  }
  if (elapsed > ceiling) {
    return {
      fresh: false,
      reason: `capture stale: ${elapsed}ms elapsed > freshness ceiling ${ceiling}ms (capture_ts=${captureTs}, record ts=${recordTs})`,
      elapsedMs: elapsed,
    };
  }
  return { fresh: true, elapsedMs: elapsed };
}

/**
 * R5-S-07 distinct-bound-collaborator predicate (M3 HIGH-2 / F-3).
 *
 * Verifies that the primary signer's github login AND the cosigner's
 * github login are BOTH:
 *   (a) DISTINCT from each other (sock-puppet defense),
 *   (b) PRESENT in the collaborators capture as admin-permission entries.
 *
 * This is the cryptographic-key-aside structural defense: even if two
 * accounts hold distinct verified_ids AND distinct person_ids AND both
 * resolve to owner-role in the roster, the gh-api capture is the
 * canonical out-of-band evidence that two DIFFERENT GitHub identities
 * approved the action. Two roster persons mapped to a single bound
 * github login (e.g. via roster misconfiguration OR via a future
 * attacker who managed to bind one login to two person_ids) are caught
 * here.
 *
 * The collaborators capture is the authoritative source; the roster
 * is NOT, because the attacker controls the roster modifications under
 * the same threat model the cosig is defending against.
 *
 * @param {string} primaryLogin - github_login the primary signer's roster
 *   person carries (caller resolves via roster.persons[<pid>].github_login)
 * @param {string} cosignerLogin - github_login the cosigner's roster
 *   person carries
 * @param {object} capture - the allowlisted collaborators capture
 *   ({collaborators: [...], capture_ts}). The bare-array shape is
 *   ALSO accepted (legacy callers — backward compat) but new callers
 *   SHOULD pass the wrapped object so capture_ts is available.
 * @returns {{ok: boolean, reason?: string}}
 */
function _verifyDistinctBoundCollaborators(
  primaryLogin,
  cosignerLogin,
  capture,
) {
  if (typeof primaryLogin !== "string" || !primaryLogin) {
    return { ok: false, reason: "primaryLogin missing or not a string" };
  }
  if (typeof cosignerLogin !== "string" || !cosignerLogin) {
    return { ok: false, reason: "cosignerLogin missing or not a string" };
  }
  // F14 C2 iter-3: case-insensitive sock-puppet detection. Pre-iter-3,
  // strict === allowed an attacker to register as "Alice" while having
  // a co-signer registered as "alice" to bypass the distinct-login
  // requirement (sock-puppet via case-mismatch).
  if (loginsEqual(primaryLogin, cosignerLogin)) {
    return {
      ok: false,
      reason: `R5-S-07: primary and cosigner resolve to the SAME bound github login '${primaryLogin}' (sock-puppet defense — two distinct person_ids cannot share a github login for cosig purposes)`,
    };
  }
  // Accept both shapes.
  let entries;
  if (Array.isArray(capture)) {
    entries = capture;
  } else if (capture && Array.isArray(capture.collaborators)) {
    entries = capture.collaborators;
  } else {
    return {
      ok: false,
      reason:
        "R5-S-07: collaborators capture missing or not in {collaborators: [...]} shape",
    };
  }
  const primaryHit = entries.find(
    (c) =>
      c &&
      typeof c.login === "string" &&
      loginsEqual(c.login, primaryLogin) &&
      c.permissions &&
      c.permissions.admin === true,
  );
  if (!primaryHit) {
    return {
      ok: false,
      reason: `R5-S-07: primary login '${primaryLogin}' is not an admin-permission collaborator in the gh-api capture`,
    };
  }
  const cosignerHit = entries.find(
    (c) =>
      c &&
      typeof c.login === "string" &&
      loginsEqual(c.login, cosignerLogin) &&
      c.permissions &&
      c.permissions.admin === true,
  );
  if (!cosignerHit) {
    return {
      ok: false,
      reason: `R5-S-07: cosigner login '${cosignerLogin}' is not an admin-permission collaborator in the gh-api capture`,
    };
  }
  return { ok: true };
}

module.exports = {
  _allowlistRepoOwner,
  _allowlistCommitVerification,
  _allowlistOrgMembership,
  _allowlistCollaboratorsList,
  // M3 hardening surface (HIGH-2, HIGH-4)
  GH_API_CAPTURE_FRESHNESS_MS,
  // F86 / MUST-7 migration-ceremony surface — distinct ceiling for the
  // multi-step migration ceremony so its 15-min tolerance does not silently
  // relax the 5-min routine-enrollment default.
  MIGRATION_LIVENESS_TTL,
  _isCaptureFresh,
  _verifyDistinctBoundCollaborators,
};
