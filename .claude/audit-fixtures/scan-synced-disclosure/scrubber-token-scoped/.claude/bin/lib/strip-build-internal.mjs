// SYNTHETIC scrubber stand-in (scrubber-token-scoped fixture). Its path is the
// one the scanner ONCE tolerated; Tier-1 round 2 (2026-10-04) DELETED that
// tolerance — the real file carries no private literal, so this path is scanned
// like any other and the private slug below MUST flag. Every token is invented.
//
// A private org the REAL scrubber derives (privateOrgSlugs()), substituted for
// __CANON_ORG__ by the runner at scan time so no literal is committed here —
// NOW A FINDING (nonfoundation-org-slug), exactly like any other path:
const OWN_BARE = /\b(?:__CANON_ORG__|terrene-foundation)\b(?!\/)/g;
const OWN_ORGS_FORM = "Run `gh api orgs/__CANON_ORG__/actions/hosted-runners`.";
const OWN_REPOS_FORM = "Diagnose: `gh api repos/__CANON_ORG__/kailash-rs/actions/runs`.";

// Appended to the scrubber — each token MUST still flag (4 findings):
// third-party org, issue-ref form: acme-corp/loom#21
// third-party org, orgs endpoint: gh api orgs/globex-inc
// two person tokens on ONE line (branch, then login): codify/canonop-2026-08-20 canonop-gh
export { OWN_BARE, OWN_ORGS_FORM, OWN_REPOS_FORM };
