/**
 * o1-citation-check — mechanical SHAPE check for the O1 compliance-origination
 * receipt (issue #577).
 *
 * Rule refs (.claude/rules/artifact-flow.md § "The Origination Taxonomy —
 * O1 (compliance), O2 (consultant upflow), O3 (BUILD)"):
 *   the O1 row success-criterion + the load-bearing enforcement paragraph
 *   (artifact-flow.md § "The Origination Taxonomy", the "Enforcement is
 *   load-bearing" paragraph + the "per ISO 27001:2022" DO-NOT): an
 *   O1-origination journal `DECISION` receipt MUST (a) cite the external
 *   authority down to a specific version + clause/§ (a BARE standard name
 *   is the agent-producible degenerate case and is INSUFFICIENT — see that
 *   § "per ISO 27001:2022" DO-NOT), AND
 *   (b) state in ONE sentence HOW that clause MANDATES the artifact's
 *   content (the derivation "§X requires Y → this rule mandates Z").
 *   Spec basis: workspaces/ecosystem-operating-model/specs/05-origination-
 *   and-upflow.md §1 (O1 row); decisions/00-decision-packet.md DECISION-7
 *   honest-con VERBATIM: "the O1 receipt MUST be enforced (the external-
 *   authority citation is mandatory, not optional) or O1 becomes the
 *   loophole."
 *
 * SCOPE — SHAPE-mechanical ONLY. This module decides three structural
 * questions a regex/parse CAN answer deterministically:
 *   (a) does the receipt name a standard AND carry a VERSION token?
 *   (b) does it cite a specific clause/§ identifier (NOT a bare name)?
 *   (c) does it carry a one-sentence derivation linking clause → artifact?
 *
 * AUTHORING CONTRACT — version-less-looking statutory authorities still carry a
 * version. The (a) version gate is uniform: per artifact-flow.md § "The
 * Origination Taxonomy" the O1 receipt cites the authority "down to the specific
 * version + clause/§". Statutes/regulations (GDPR, HIPAA, SOX, CCPA, GLBA,
 * FISMA, …) DO have a version identifier — their enactment/amendment year (GDPR
 * = Regulation (EU) 2016/679; HIPAA = Pub. L. 104-191/1996) — so they MUST be
 * cited WITH it, NAME-ADJACENT: "GDPR 2016 Article 32 requires X → this rule
 * mandates Y", "HIPAA 1996 §164.312 requires …". A bare "GDPR Article 32" fails
 * (a) by design (the year is the version proxy NAME_ADJACENT_YEAR matches). Use
 * spelled-out clause forms (§ / Article / Annex / Clause / Section / Control /
 * Requirement + the id) — the abbreviated "Art." is not in the (b) keyword set.
 *
 * The SEMANTIC question — "does the cited clause ACTUALLY GOVERN this
 * artifact's content?" — STAYS WITH THE HUMAN / LLM GATE (the cc-architect
 * /codify review per artifact-flow.md § "The Origination Taxonomy"
 * Detection layer 2 + cc-artifacts.md Rule 6). This
 * module MUST NOT attempt to judge governance mechanically: a real
 * standard whose clause does NOT govern the edit passes the SHAPE check
 * (a, b, c all present) and is BLOCKED only by the human gate. That
 * boundary is intentional and documented here so the fence is honest —
 * the shape check COMPLEMENTS, never REPLACES, the judgment gate. Per
 * hook-output-discipline.md MUST-2 the consuming hook surfaces this as
 * halt-and-report / advisory (a judgment-bearing review signal), never
 * severity:block.
 *
 * Style: CommonJS, zero-dep, pure functions. No I/O / clock / network in the
 * LIBRARY half (exports below); the require.main CLI edge at the foot of the file
 * is the SOLE I/O surface (fs read + stdout/exit), guarded so a require() of this
 * module never triggers it — consumers stay I/O-free.
 */

"use strict";

// Failure-reason constants — the TYPED reason naming WHICH of (a)/(b)/(c)
// failed, so the surfacing hook / reviewer can name the precise gap.
const REASON = {
  OK: "ok",
  EMPTY: "empty-receipt", // no receipt text at all
  NO_STANDARD: "no-standard-named", // (a) — no recognizable standard/authority token
  NO_VERSION: "no-version-token", // (a) — standard named but no version token
  NO_CLAUSE: "no-clause-identifier", // (b) — bare standard name, no specific clause/§ (the loophole)
  NO_DERIVATION: "no-derivation-sentence", // (c) — no "§X requires Y → this … mandates Z" derivation
};

// A standard/authority token: an uppercase acronym family (ISO, SOC, GDPR,
// HIPAA, PCI, NIST, FedRAMP, …) OR an explicit "ISO/IEC"-style compound.
// Kept deliberately permissive — the SEMANTIC validity of the standard is
// the human gate's job; this only confirms SOMETHING shaped like a named
// external authority is present (NOT a bare "best practice" claim).
// The source (sans \b anchors) is reused by NAME_ADJACENT_YEAR below so the
// standalone-year version form is recognized ONLY when the year rides the
// standard name.
const STANDARD_TOKEN_SRC =
  "(?:ISO\\/IEC|ISO|IEC|SOC\\s?2|SOC\\s?1|GDPR|HIPAA|PCI(?:[-\\s]?DSS)?|NIST|FedRAMP|CCPA|FISMA|SOX|COBIT|CIS|OWASP|CSA|FFIEC|GLBA|PIPEDA|APRA|DORA|CMMC)";
const STANDARD_TOKEN = new RegExp("\\b" + STANDARD_TOKEN_SRC + "\\b", "i");

// A version token detected ANYWHERE in the receipt. These forms are
// self-identifying as versions (a colon-year suffix, an explicit vN, a
// Rev/Revision, a NIST pub-id) so they need no name-adjacency to be safe.
// Accepted shapes, kept DELIBERATELY narrow so a clause id's dotted number
// (e.g. "§A.8.24") is NOT mis-read as a version — a BARE dotted decimal
// (`\d+\.\d+`) is EXCLUDED for exactly that reason (it is the clause-token
// shape, not a version shape):
//   - ":<year>" suffix ............ ISO/IEC 27001:2022
//   - a "vN[.N…]" version .......... PCI-DSS v4.0, v1.2.3
//   - a "Rev. N" / "Revision N" .... NIST SP 800-53 Rev. 5
//   - a NIST-style "NNN-NN" pub id . 800-53, 800-171 — a standard-IDENTITY
//     token (the publication number), serving as a pragmatic version proxy,
//     NOT a true version field; it is intrinsically name-riding (it IS the
//     standard's id) so it is safe to match anywhere.
const VERSION_TOKEN =
  /(?::\s*\d{4}\b|\bv\d+(?:\.\d+)+\b|\bRev\.?\s*\d+\b|\bRevision\s+\d+\b|\b\d{3}-\d{1,3}\b)/i;

// A NAME-ADJACENT standalone 4-digit year — the ONLY way a bare year counts
// as a version. A free-floating year ANYWHERE in prose (an audit date, a
// ship deadline — "§A.8.24 in 2019 requires X", "we ship by 2026 deadline")
// MUST NOT satisfy the version sub-gate; only a year that RIDES the standard
// name does ("SOC 2 2017", "ISO 27001 2022"). The pattern requires a
// STANDARD_TOKEN, then an OPTIONAL catalog-number token (e.g. "27001",
// "800-53"), then — within a SMALL separator window (≤6 chars: whitespace /
// "/" / ":" / "." / "," / "-") — a 4-digit year. The tight window is what
// excludes a year sitting past a clause id or several prose words away.
const NAME_ADJACENT_YEAR = new RegExp(
  "\\b" +
    STANDARD_TOKEN_SRC +
    "\\b" +
    "(?:[\\s/:.-]*\\d[\\d.-]*)?" + // optional catalog-number token (27001, 800-53)
    "[\\s/:.,-]{0,6}" + // small separator window — NOT free-floating prose
    "\\b(?:19|20)\\d{2}\\b",
  "i",
);

// A clause/§ identifier: a section sign + id (§A.8.24, § 5.1), an
// "Annex A"/"Article 32"/"Clause 6.1"/"Control AC-2" style label, or a
// dotted-control id (A.8.24 / AC-2 / 800-53 control families). This is the
// (b) gate: a BARE standard name with NO clause id is the degenerate case
// artifact-flow.md § "The Origination Taxonomy" (the "per ISO 27001:2022"
// DO-NOT) calls out as the loophole.
const CLAUSE_TOKEN =
  /(?:§\s?[A-Za-z0-9][A-Za-z0-9.\-]*|\b(?:Annex|Article|Clause|Section|Control|Requirement|Req)\.?\s+[A-Za-z0-9][A-Za-z0-9.\-]*|\b[A-Z]{1,3}[-.][0-9]+(?:\([0-9a-z]+\))?(?:\.[0-9]+)*\b|\bA\.\d+(?:\.\d+)+\b)/;

// A derivation sentence: a clause-requires-X-therefore-mandates-Y link.
// The structural marker is a "→" / "therefore" / "so" / "requires … →"
// connective bridging an authority-requirement to a rule mandate. The
// SEMANTIC correctness of the derivation is the human gate's job; this
// only confirms the AUTHOR WROTE A DERIVATION (not merely a citation).
// Two accepted shapes:
//   (1) explicit arrow:  "… requires … → this rule mandates …"
//   (2) prose connective: "… requires …, therefore/so this rule mandates …"
const DERIVATION_ARROW = /→/;
const DERIVATION_REQUIRES = /\brequire(?:s|d)?\b/i;
const DERIVATION_MANDATE = /\bmandat(?:e|es|ed|ing)\b/i;
const DERIVATION_CONNECTIVE =
  /\b(?:therefore|thus|hence|so that|so this|so the)\b/i;

/**
 * Detect whether the receipt carries a one-sentence derivation linking a
 * clause-requirement to a rule-mandate. Accepts EITHER the explicit-arrow
 * shape OR the prose-connective shape; both MUST pair a "require…" with a
 * "mandate…" so a bare citation ("per §A.8.24") without the bridge fails.
 */
function _hasDerivation(text) {
  const hasMandate = DERIVATION_MANDATE.test(text);
  if (!hasMandate) return false;
  const hasRequires = DERIVATION_REQUIRES.test(text);
  // Shape (1): explicit arrow bridging requirement → mandate.
  if (DERIVATION_ARROW.test(text) && hasRequires) return true;
  // Shape (2): prose connective bridging requirement → mandate.
  if (DERIVATION_CONNECTIVE.test(text) && hasRequires) return true;
  return false;
}

/**
 * checkO1Citation — the mechanical SHAPE gate for an O1-origination receipt.
 *
 * @param {string} receiptText - the journal DECISION receipt text (or the
 *   provenance-citation paragraph) for an O1-classified loom-direct edit.
 * @returns {{ ok: boolean, reason: string, failed: string|null,
 *             checks: {standard: boolean, version: boolean,
 *                      clause: boolean, derivation: boolean} }}
 *
 *   ok=true iff ALL of (a) standard+version, (b) clause, (c) derivation
 *   are present. On failure, `reason` is the TYPED REASON.* constant naming
 *   which check failed and `failed` names the predicate ((a)/(b)/(c)).
 *   Fails LOUD: the first missing check determines the reason, evaluated in
 *   (a)→(b)→(c) order so the most fundamental gap surfaces first.
 *
 *   This function decides SHAPE ONLY. Whether the cited clause GOVERNS the
 *   artifact is NOT decided here — that is the human/LLM gate per the
 *   module header. A shape-clean receipt MAY still be BLOCKED by the
 *   reviewer for a non-governing citation; a shape-failing receipt is
 *   BLOCKED here before the reviewer ever reads it.
 */
function checkO1Citation(receiptText) {
  const text = typeof receiptText === "string" ? receiptText : "";
  const checks = {
    standard: false,
    version: false,
    clause: false,
    derivation: false,
  };

  if (text.trim() === "") {
    return { ok: false, reason: REASON.EMPTY, failed: "(a)", checks };
  }

  // (a) — standard named AND a version token present. A version is EITHER a
  // self-identifying form (colon-year / vN / Rev / NIST pub-id, matched
  // anywhere) OR a bare 4-digit year that RIDES the standard name
  // (NAME_ADJACENT_YEAR). A free-floating year in prose does NOT count.
  checks.standard = STANDARD_TOKEN.test(text);
  checks.version = VERSION_TOKEN.test(text) || NAME_ADJACENT_YEAR.test(text);
  if (!checks.standard) {
    return { ok: false, reason: REASON.NO_STANDARD, failed: "(a)", checks };
  }
  if (!checks.version) {
    return { ok: false, reason: REASON.NO_VERSION, failed: "(a)", checks };
  }

  // (b) — specific clause/§ identifier (BLOCK a bare standard name).
  checks.clause = CLAUSE_TOKEN.test(text);
  if (!checks.clause) {
    return { ok: false, reason: REASON.NO_CLAUSE, failed: "(b)", checks };
  }

  // (c) — one-sentence derivation linking clause → artifact mandate.
  checks.derivation = _hasDerivation(text);
  if (!checks.derivation) {
    return { ok: false, reason: REASON.NO_DERIVATION, failed: "(c)", checks };
  }

  return { ok: true, reason: REASON.OK, failed: null, checks };
}

/**
 * humanReason — render the typed reason as a one-line, actionable message
 * naming the failed predicate AND restating the preserved human-judgment
 * boundary, for a halt-and-report surfacing hook / reviewer.
 */
function humanReason(result) {
  switch (result.reason) {
    case REASON.OK:
      return "O1 citation SHAPE check passed (standard+version, clause, derivation present). Governance-of-clause is still the human/LLM gate's call.";
    case REASON.EMPTY:
      return "O1 citation (a) FAILED: empty receipt — no external-authority citation. An uncited compliance edit is an unattributable loom origination (BLOCKED).";
    case REASON.NO_STANDARD:
      return "O1 citation (a) FAILED: no named external authority (no standard/framework token). 'standard best practice' is not a citation (BLOCKED).";
    case REASON.NO_VERSION:
      return "O1 citation (a) FAILED: standard named but NO version token (e.g. ':2022', 'v4.0', 'Rev. 5'). Cite the authority down to its version.";
    case REASON.NO_CLAUSE:
      return "O1 citation (b) FAILED: bare standard name with no specific clause/§ identifier — the agent-producible degenerate case, the loophole (BLOCKED).";
    case REASON.NO_DERIVATION:
      return "O1 citation (c) FAILED: no one-sentence derivation linking clause → artifact ('§X requires Y → this rule mandates Z'). A citation that EXISTS is not enough; it must show the clause GOVERNS.";
    default:
      return `O1 citation check: ${result.reason}`;
  }
}

module.exports = {
  REASON,
  checkO1Citation,
  humanReason,
  // exported for fixture/test introspection only:
  _hasDerivation,
};

// ── CLI edge (require.main === module ONLY — the library above stays I/O-free) ──
// Usage: node o1-citation-check.js <receipt-path>
//   Reads the O1-origination journal DECISION receipt at <receipt-path>, runs the
//   SHAPE gate, prints the typed human reason + the JSON result, and exits:
//     0  shape-clean (name+version, clause, derivation all present)
//     1  shape-fail  (a typed REASON names which of (a)/(b)/(c) is missing)
//     2  usage / unreadable receipt
//   This is Detection LAYER 1 (mechanical SHAPE) per artifact-flow.md § "The
//   Origination Taxonomy" — the platform-engineer's pre-gate self-check that
//   `/govern` Step 2 prescribes. It is NOT the governance gate: a shape-clean
//   receipt is STILL subject to the cc-architect /codify judgment (LAYER 2 —
//   "does the cited clause ACTUALLY govern this artifact?"). The exit code is the
//   structural SHAPE signal only.
if (require.main === module) {
  const fs = require("fs");
  const receiptPath = process.argv[2];
  if (!receiptPath) {
    process.stderr.write(
      "usage: node o1-citation-check.js <receipt-path>\n" +
        "  shape-checks an O1-origination journal DECISION receipt (Detection layer 1).\n",
    );
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(receiptPath, "utf8");
  } catch (e) {
    process.stderr.write(
      `o1-citation-check: cannot read receipt '${receiptPath}': ${e && e.message ? e.message : String(e)}\n`,
    );
    process.exit(2);
  }
  const result = checkO1Citation(text);
  process.stdout.write(humanReason(result) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}
