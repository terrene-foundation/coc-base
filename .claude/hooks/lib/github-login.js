/**
 * github-login — validators for GitHub login + repo-name strings used in
 * ceremony endpoint construction.
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.3 — genesis / owner-add / owner-depart ceremonies interpolate
 *     `repo.owner`, `repo.name`, `declaredOwner`, `adminLogin` into the
 *     gh-api endpoint string. Without validation, a malicious roster /
 *     opts value could inject path traversal, shell metachars, or URL
 *     query fragments into the endpoint.
 *
 * Rationale (M0 security review HIGH-3):
 *   GitHub logins are constrained to `^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$`
 *   (alphanumeric + hyphen, ≤39 chars, no leading hyphen — the same
 *   pattern GitHub itself enforces at signup). Repo names are looser
 *   (`^[a-zA-Z0-9._-]{1,100}$` — alphanumeric + dot + underscore +
 *   hyphen, ≤100 chars). Validating BEFORE building the endpoint string
 *   closes the input-validation gap (`rules/security.md` § Input
 *   Validation) at the structural-confirmation layer.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O. Returns
 *   `{valid: true}` on success, `{valid: false, reason: <string>}` on
 *   failure. NEVER throws — the ceremony state-machine surfaces the
 *   reason via its own error shape per `rules/zero-tolerance.md` Rule 3.
 */

"use strict";

// GitHub login pattern: 1-39 chars, alphanumeric + hyphen, no leading hyphen,
// no consecutive hyphens (the latter is not enforced here — GitHub itself
// allows them at the policy level; the structural surface this validator
// protects is endpoint-interpolation, not GitHub's own signup rules).
const GITHUB_LOGIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;

// GitHub repo name pattern: 1-100 chars, alphanumeric + dot + underscore +
// hyphen. GitHub itself caps at 100; we mirror that bound.
const GITHUB_REPO_RE = /^[a-zA-Z0-9._-]{1,100}$/;

function validateGithubLogin(s) {
  if (typeof s !== "string") {
    return { valid: false, reason: "must be string" };
  }
  if (!GITHUB_LOGIN_RE.test(s)) {
    return {
      valid: false,
      reason: `not a valid GitHub login: ${JSON.stringify(s)}`,
    };
  }
  return { valid: true };
}

function validateGithubRepoName(s) {
  if (typeof s !== "string") {
    return { valid: false, reason: "must be string" };
  }
  if (!GITHUB_REPO_RE.test(s)) {
    return {
      valid: false,
      reason: `not a valid repo name: ${JSON.stringify(s)}`,
    };
  }
  return { valid: true };
}

// ---- F14 C2 iter-3: case-insensitive login comparison helpers --------------

/**
 * F14 C2 iter-3 root-cause fix: GitHub server-side login semantics are
 * case-INSENSITIVE. Github resolves "Alice", "alice", and "ALICE" to the
 * same account at the API layer; ALL substrate code that compares logins
 * against roster entries / record content / capture body MUST do so
 * case-insensitively.
 *
 * Per substrate enumeration (iter-3 R3): ~10+ call sites across
 * fold-genesis-anchor.js, gh-api-allowlist.js, owner-add-ceremony.js,
 * recovery-fallback.js, coordination-log.js, fold-rule-9c.js were still
 * using strict `===` after iter-2's MED-4 sweep. iter-1 and iter-2 added
 * `.toLowerCase()` per-site (derive-n.js, gate-matrix.js,
 * genesis-ceremony.js, owner-depart-ceremony.js); iter-3 closes the class
 * structurally: every comparison goes through `loginsEqual` (which
 * normalizes both sides), and every normalization goes through
 * `normalizeLogin`.
 *
 * Without normalization the failure modes are:
 *   - sock-puppet bypass: an attacker registering as "Alice" defeats a
 *     `loginsEqual("alice", "Alice")` check that was a bare `===`.
 *   - silent attestation/revocation failure: roster `github_login: "Alice"`
 *     against record `content.github_login: "alice"` resolves false,
 *     victim chain never populates, fold-rule-10 settlement bypassed.
 *   - genesis owner-bind drift: roster `genesis.repo_owner: "Alice"`
 *     against gh-api capture `body.owner.login: "alice"` resolves false
 *     under strict `===`; trust root never establishes.
 *
 * Architecture refs:
 *   - rules/security.md § Multi-Site Kwarg Plumbing — same structural
 *     class: a security-relevant invariant enforced per-site silently
 *     drifts; the structural defense is one helper.
 *   - rules/zero-tolerance.md Rule 4 (no workarounds — fix bug class
 *     structurally).
 *
 * Style: CommonJS, zero-dep, pure functions. NEVER throws — non-string
 *   inputs return null (normalize) or false (loginsEqual).
 */

/**
 * normalizeLogin — lowercase a candidate login string. Returns null on
 * non-string OR non-ASCII input. The canonical normalization used by
 * every substrate comparison.
 *
 * F14 C2 iter-4 LOW-R4-5 defense-in-depth: GitHub logins are
 * structurally ASCII-only per `^[a-zA-Z0-9-]{1,39}$`. Rejecting non-ASCII
 * BEFORE `.toLowerCase()` closes the locale-aware case-fold attack
 * surface (e.g., Turkish "İ".toLowerCase() resolves to "i" on
 * locale-aware engines, letting a non-ASCII login match an ASCII roster
 * entry on some platforms). Even though Node's `.toLowerCase()` is
 * locale-INDEPENDENT (it uses Unicode default case-folding), the ASCII
 * guard is the structural defense — a malformed login that slipped past
 * upstream validation can never satisfy `loginsEqual` against an ASCII
 * roster entry.
 *
 * @param {*} login - candidate login (typically `person.github_login`,
 *   `record.content.github_login`, `capture.body.owner.login`)
 * @returns {string|null} - lowercase string, or null if input was not
 *   an ASCII string
 */
function normalizeLogin(login) {
  if (typeof login !== "string") return null;
  // F14 M5-B2 iter-5 R5-LOW-1: explicit zero-length guard. Previously the
  // ASCII regex /^[\x00-\x7f]*$/ allowed zero chars; normalizeLogin("")
  // returned "" and loginsEqual("", "") returned true. The property was
  // upstream-dependent (validateGithubLogin rejects empty) rather than
  // structural. This guard makes empty-string rejection a structural
  // property of normalizeLogin itself — any caller that ever skips
  // upstream validation still gets a safe null.
  if (login.length === 0) return null;
  // GitHub login charset is ASCII per the signup-rules pattern.
  // Reject non-ASCII before lowercasing to close Turkish-I / NFC
  // variant case-folding attack surface (defense-in-depth — Node's
  // .toLowerCase is locale-independent today, but the guard makes
  // the property structural rather than dependent on engine behavior).
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(login)) return null;
  return login.toLowerCase();
}

/**
 * loginsEqual — case-insensitive equality. Both sides are normalized via
 * `normalizeLogin`. Returns false if either side is non-string (NOT
 * truthy, NOT throws — false-safe predicate).
 *
 * Use this for ALL substrate login comparisons. Bare `a === b` on
 * github_login / login fields is BLOCKED outside this file
 * (enforced via grep structural sweep in tests).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function loginsEqual(a, b) {
  const na = normalizeLogin(a);
  const nb = normalizeLogin(b);
  return na !== null && nb !== null && na === nb;
}

// ---- F14 C2 iter-4: semantic-class enumeration SSOT --------------------------

/**
 * GITHUB_LOGIN_FIELD_NAMES — single source of truth for field names whose
 * values are GitHub user OR org names. ALL strict comparisons of these
 * fields anywhere in `.claude/hooks/` MUST route through `loginsEqual`.
 *
 * F14 C2 iter-4 MED-R4-2: iter-3 enforced the contract on `github_login`
 * and `login` only. R4-quality surfaced `repo_owner` (a GitHub user name
 * for kind=user, an org name for kind=org — both ASCII-only
 * case-insensitive on GitHub) as a same-bug-class field-name miss.
 * Tightening to a positive allowlist closes the field-name-anchored
 * sweep against future drift: any new login-class field MUST be added
 * here AND the structural sweep test in
 * `tests/integration/multi-operator/c2-auth-hardening-iter3.test.js`
 * (consumed at sweep-regex construction) covers the new name
 * automatically.
 *
 * Per `cc-artifacts.md` Rule 10 (positive-allowlist sweeps): the
 * enumeration scales linearly with deliberate additions; a denylist
 * would scale linearly with brainstormed typos and never close the
 * class. The allowlist is the structural defense.
 *
 * Adding a new login-class field name:
 *   1. Append the name here.
 *   2. (No other edits required — the sweep regex consumes this
 *      constant; the rule fires automatically on the next test run.)
 */
const GITHUB_LOGIN_FIELD_NAMES = [
  "github_login",
  "login",
  "repo_owner",
  "new_repo_owner",
  // F14 M5-B2 iter-5 R5-MED-1: `gh_login` field-name. Current consumer at
  // `gate-matrix.js:_sameBoundCollaborator` already routes
  // requester.gh_login + approver.gh_login through `loginsEqual`. Adding
  // the name to the SSOT lifts future drift detection into the sweep
  // regex — any new `.gh_login ===` bare compare anywhere in the substrate
  // is flagged by `structural_sweep_with_extended_field_ssot_empty`.
  "gh_login",
  // MULTIOPDD iter-5 exhaustive-enumeration residual (2026-06-12,
  // journal/0276): three GitHub-login-class field names surfaced by the
  // iter-5 todo's mandatory grep audit. `requester_gh_login` +
  // `approver_gh_login` (operator-gate.js:183,199) feed the gate-matrix
  // `gh_login` compare; `target_login`
  // (multi-operator-sessionstart.js:410) carries the rule-10
  // revocation-contest target's login. None are in bare `===` compare
  // sites today — same future-drift predicate as the R5-LOW-3 entries:
  // any new strict compare on these names becomes a sweep finding
  // instead of a silent normalization bypass.
  "requester_gh_login",
  "approver_gh_login",
  "target_login",
];

/**
 * GITHUB_LOGIN_LOCAL_VARS — single source of truth for local-variable
 * names that hold values of the GitHub-login class. ALL strict
 * comparisons of these locals anywhere in `.claude/hooks/` MUST route
 * through `loginsEqual`.
 *
 * F14 C2 iter-4 MED-R4-2 (R4-security): iter-3 sweep was
 * field-name-anchored (matched `.github_login ===`, `.login ===`) and
 * slid past local-var-assigned compares like
 * `externalOwner !== declaredOwner` (genesis-ceremony.js step 2) and
 * `authorLogin === declaredOwner` (step 4) — same semantic bug class,
 * different syntactic shape. The local-var allowlist closes the gap:
 * the iter-4 sweep regex enumerates these names at word-boundary
 * (`\b<name>\s*[!=]==`) and flags any bare strict compare.
 *
 * Per `cc-artifacts.md` Rule 10: same positive-allowlist rationale as
 * `GITHUB_LOGIN_FIELD_NAMES` — adding a new local-var name requires
 * appending it here, and the sweep automatically covers it.
 *
 * Adding a new login-class local-var name:
 *   1. Append the name here.
 *   2. (No other edits required — the sweep regex consumes this
 *      constant.)
 */
const GITHUB_LOGIN_LOCAL_VARS = [
  "externalOwner",
  "declaredOwner",
  "authorLogin",
  "authorName",
  "targetLogin",
  "primaryLogin",
  "cosignerLogin",
  "departingLogin",
  "newOwnerLogin",
  "remainingLogin",
  // F14 M5-B2 iter-5 R5-MED-2: `recLogin` + `login` local-vars. Current
  // sites at `derive-n.js:130,143` and `recovery-fallback.js:66,94` hold
  // GitHub-login-class values; the compare at `derive-n.js:147`
  // (`if (recLogin !== login) continue;`) is structurally safe today
  // because BOTH sides are pre-normalized via upstream `normalizeLogin`.
  // If a future refactor removes upstream normalization, this entry
  // makes the bare compare a sweep finding.
  "recLogin",
  "login",
  // F14 M5-B2 iter-5 R5-LOW-3: `victimLogin` + `adminLogin` local-vars.
  // Current sites at `fold-rule-10.js:252` (victimLogin) +
  // `genesis-ceremony.js:366` (adminLogin) hold GitHub-login-class values
  // but are NOT currently in `===` compare sites. Future-drift defense
  // only — preempts any new strict compare against the bug class.
  "victimLogin",
  "adminLogin",
];

module.exports = {
  validateGithubLogin,
  validateGithubRepoName,
  normalizeLogin,
  loginsEqual,
  // Semantic-class enumeration SSOT (iter-4 MED-R4-2):
  GITHUB_LOGIN_FIELD_NAMES,
  GITHUB_LOGIN_LOCAL_VARS,
  // Patterns exposed for downstream tests that want to assert the contract.
  _GITHUB_LOGIN_RE: GITHUB_LOGIN_RE,
  _GITHUB_REPO_RE: GITHUB_REPO_RE,
};
