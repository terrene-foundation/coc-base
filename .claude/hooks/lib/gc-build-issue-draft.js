/**
 * gc-build-issue-draft — the G-C-WIRE Route-B BUILD-issue drafter: a DUMB
 * assembler of the `upstream-issue-hygiene.md` MUST-3 five-section issue body,
 * with the cross-SDK-first acceptance flag injected and a mechanical
 * disclosure-scrub against the MUST-2 denylist. It NEVER files anything.
 *
 * ECO-IMPL Wave 7b, Shard G-C-WIRE. Implements
 * `workspaces/ecosystem-operating-model/02-plans/04-gc-dual-route-classification.md`
 * §1 (Route B) + §3 (cross-SDK-first preservation, option a) +
 * `rules/upstream-issue-hygiene.md` MUST-1 (human gate) / MUST-2 (redaction) /
 * MUST-3 (five-section minimal-repro shape).
 *
 * THE HUMAN-VS-TOOLING BOUNDARY (load-bearing, `artifact-flow.md:224` +
 * `upstream-issue-hygiene.md` MUST-1): tooling DRAFTS the body + injects the
 * cross-SDK flag + runs the mechanical scrub + SIGNALS that a human gate is
 * required. The human CONFIRMS the classification, RATIFIES the scrub (HALT on
 * any finding), and APPROVES the file (explicit same-session y/N, restate
 * target + action). The transport (`createUpflowIssue` / ADO work-item, W7a)
 * fires ONLY after approval — and this lib has NO path to it (it returns a
 * draft + a gate signal; the codify.md Step-7c procedure does the gated file).
 *
 * SCOPE BOUNDARY (NOT this shard): NO transport / gh-issue creation (the lib
 * deliberately never imports vcs-*-adapter), NO routing (gc-route-classifier.js
 * — G-C-T2), NO disposition receipts (gc-disposition-receipt.js — G-C-3).
 *
 * Style: CommonJS, sync, zero-dep. Per zero-tolerance.md Rule 2/3: no stubs;
 * typed failures; no silent fallback.
 */

"use strict";

// The five required sections, in order (upstream-issue-hygiene MUST-3). NOTHING
// else: no `## Workaround`, no `## Workspace`, no `## Cross-references`, no
// `## Origin` — those are the leakage surfaces the scrub also catches if a
// caller smuggles them into a section's content.
const SECTION_ORDER = [
  "Affected API",
  "Minimal repro",
  "Expected vs actual",
  "Severity",
  "Acceptance criteria",
];

const SEVERITY_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

// The cross-SDK-first acceptance flag (§3 option a): a CHECKABLE gate the
// BUILD-side /redteam catches, injected because the consultant CANNOT do
// cross-SDK analysis (lacks sibling-SDK source; repo-scope-discipline). It is a
// fixed constant — the test pins it.
const CROSS_SDK_ACCEPTANCE_LINE =
  "[ ] cross-SDK-first considered (py/rs/prism parity) before fix lands";

// ---------------------------------------------------------------------------
// Mechanical disclosure-scrub (upstream-issue-hygiene MUST-2 denylist).
//
// The denylist is the MECHANICAL half of the scrub (workspace paths, internal
// source-tree paths, operator home paths, finding tags, journal/proposals
// paths, leakage section headers, Origin/Discovered footers). It is a pattern
// denylist, NOT a positive allowlist, because the disclosure vocabulary it
// fences is NON-enumerable (consumer / customer / engagement NAMES are
// unbounded) — `cc-artifacts.md` Rule 10's allowlist preference applies only to
// enumerable vocabularies. The non-mechanical residual (a bare consumer name)
// is covered by the HUMAN gate (MUST-1), which this lib's `requires_human_gate`
// signal mandates. Patterns are deliberately FAIL-CLOSED (err toward
// over-match): a false positive HALTs and the human re-words; a false negative
// ships a permanent public leak — so the asymmetry is biased to the safe side.
// Each `re` carries the `g` flag so scrubIssueText enumerates EVERY span (the
// human's redaction view sees all tokens in one pass, not one-per-class).
// ---------------------------------------------------------------------------
const SCRUB_PATTERNS = [
  // No mandatory trailing slash: a bare `workspaces/<name>` (slug or
  // end-of-string) is still a leak, and a space-containing name still matches
  // its leading segment — fail-closed (R1 LOW: trailing-slash + space-name
  // evasion).
  { name: "workspace-path", re: /\bworkspaces\/[\w.-]+/g },
  { name: "session-notes", re: /\.session-notes\b/g },
  { name: "proposals-path", re: /\.proposals\//g },
  { name: "journal-path", re: /\bjournal\/(\d{3,}|\.pending)/g },
  // Internal source-tree paths outside the SDK import surface (MUST-2:
  // `src/<consumer-app>/...`, `app/...`, `bindings/<consumer>/...` — the "e.g."
  // is non-exhaustive, so the root set spans the py/rs/rb/prism consumer
  // populations: src/app/apps (py/js), crates (rs), lib/libs/gems (rb),
  // vendor/pkg/internal (go/vendored), bindings). A MUST-3 minimal repro uses
  // ONLY kailash/kailash_* imports, so any of these source-tree PATHS in a
  // BUILD-issue body IS leakage by construction. R2 HIGH: non-`src` roots.
  {
    name: "internal-source-path",
    re: /\b(src|app|apps|bindings|crates|lib|libs|vendor|internal|pkg|gems?)\/[\w.-]+/g,
  },
  // Operator home paths carry the operator's identity (MUST-2 / security.md).
  // No mandatory trailing slash (`/Users/<op>` alone names the operator). The
  // `/Users`/`/home` anchor is matched as a SUBSTRING (not at string start), so
  // a Windows `C:\Users\op` — after scrubIssueText normalizes `\`→`/` — becomes
  // `C:/Users/op` and matches `/Users/op`. R2 MED: Windows backslash homes.
  { name: "operator-home-path", re: /(?:\/Users|\/home)\/[\w.-]+/g },
  // Loom-internal finding tags: F-G1-HIGH / S-H3 / BP-049 / Sec-MED-3 (and kin).
  {
    name: "finding-tag",
    re: /\b(F-[A-Z]?\d+(-[A-Z]+)?|BP-\d{2,}|Sec-[A-Z]+-\d+|S-[A-Z]\d+)\b/g,
  },
  // Leakage section headers / footers smuggled into a section's content.
  {
    name: "leakage-section",
    re: /^#+\s*(Workaround|Workspace|Cross-references|Origin)\b/gim,
  },
  // Origin/provenance footer — case-INSENSITIVE (a lowercase `origin:` footer
  // is the more common free-text form and must not bypass the gate). The
  // `(?<![-\w])` lookbehind excludes hyphenated compounds (`Allow-Origin:` /
  // `Access-Control-Allow-Origin:` — a legit HTTP-capability repro header) while
  // still catching a standalone `Origin:`/`origin:` footer. R2 INFO precision.
  {
    name: "origin-footer",
    re: /(?<![-\w])(origin|discovered[\s-]?(by|in|during))\s*:/gi,
  },
  { name: "discovered-during", re: /\bDiscovered during\b/gi },
];

/**
 * Scan assembled issue text for mechanical disclosure-denylist hits. Returns
 * EVERY triggering match inline (proposal-intake-trust MUST-2 / evidence-first
 * MUST-2: quote the triggering span) so the human's redaction view is complete
 * in one pass. Does NOT mutate the (original) text.
 *
 * Separators are normalized `\`→`/` BEFORE matching so Windows-style backslash
 * paths cannot evade the forward-slash path patterns (R2 MED — the scrub
 * surface mirrors the classifier's `_normalizePath` backslash discipline).
 *
 * @returns { clean: boolean, findings: Array<{pattern, match}> }
 */
function scrubIssueText(text) {
  const normalized = String(text).replace(/\\/g, "/");
  const findings = [];
  for (const { name, re } of SCRUB_PATTERNS) {
    // re carries the `g` flag; matchAll enumerates every span. lastIndex is not
    // shared because matchAll clones the regex internally per call.
    for (const m of normalized.matchAll(re)) {
      findings.push({ pattern: name, match: m[0] });
    }
  }
  return { clean: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// draftBuildIssue — assemble the five-section body, inject the cross-SDK flag,
// scrub, and return the gated draft. NEVER files.
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {object} opts.repoRef            - { owner, name } the BUILD repo target (for the gate restate)
 * @param {string} opts.title             - issue title (e.g. "feat(dataflow): ..."); scrubbed
 * @param {string} opts.affectedApi       - section 1 content (one SDK import surface)
 * @param {string} opts.minimalRepro      - section 2 content (kailash/kailash_* only)
 * @param {string} opts.expectedVsActual  - section 3 content
 * @param {string} opts.severity          - section 4: LOW|MEDIUM|HIGH|CRITICAL
 * @param {string[]} opts.acceptanceCriteria - section 5: array of "[ ] ..." lines (SDK-API-scoped)
 * @param {string} [opts.proposedClass]   - the G-C-T2 routing class (capability|bug), for labels
 * @returns one of:
 *   ready:  { ok:true, scrub_clean:true, title, body, labels, requires_human_gate:true, gate }
 *   halt:   { ok:false, error:"scrub findings", findings, body }  (genericize + re-draft)
 *   invalid:{ ok:false, error, reason, step }
 */
function draftBuildIssue(opts) {
  const o = opts || {};

  // --- arg validation (typed; never a silent default) ---
  const repoRef = o.repoRef;
  if (
    !repoRef ||
    typeof repoRef.owner !== "string" ||
    typeof repoRef.name !== "string"
  ) {
    return _err(
      "args",
      "opts.repoRef must be { owner, name } strings (the BUILD target)",
    );
  }
  const stringFields = {
    title: o.title,
    affectedApi: o.affectedApi,
    minimalRepro: o.minimalRepro,
    expectedVsActual: o.expectedVsActual,
  };
  for (const [k, v] of Object.entries(stringFields)) {
    if (typeof v !== "string" || v.trim().length === 0) {
      return _err("args", `opts.${k} must be a non-empty string`);
    }
  }
  const severity =
    typeof o.severity === "string" ? o.severity.toUpperCase() : "";
  if (!SEVERITY_LEVELS.has(severity)) {
    return _err(
      "severity",
      `opts.severity must be one of ${[...SEVERITY_LEVELS].join(", ")} (SDK-API-surface impact, NOT consumer-business impact); got ${JSON.stringify(o.severity)}`,
    );
  }
  if (
    !Array.isArray(o.acceptanceCriteria) ||
    o.acceptanceCriteria.length === 0 ||
    !o.acceptanceCriteria.every(
      (l) => typeof l === "string" && l.trim().length > 0,
    )
  ) {
    return _err(
      "acceptance",
      "opts.acceptanceCriteria must be a non-empty array of '[ ] ...' lines",
    );
  }

  // --- inject the cross-SDK-first flag (§3 opt-a) as the FIRST acceptance line,
  //     BEFORE the human gate. Idempotent: never duplicated if already present. ---
  const accepts = o.acceptanceCriteria.slice();
  if (!accepts.some((l) => l.includes("cross-SDK-first considered"))) {
    accepts.unshift(CROSS_SDK_ACCEPTANCE_LINE);
  }

  // --- assemble the FIVE-section body, in order, nothing else (invariant i) ---
  const body = [
    `## Affected API\n\n${o.affectedApi.trim()}`,
    `## Minimal repro\n\n${o.minimalRepro.trim()}`,
    `## Expected vs actual\n\n${o.expectedVsActual.trim()}`,
    `## Severity\n\n${severity}`,
    `## Acceptance criteria\n\n${accepts.join("\n")}`,
  ].join("\n\n");

  // --- mechanical scrub of the ASSEMBLED body + the title (invariant iii) ---
  const scrub = scrubIssueText(`${o.title}\n${body}`);
  if (!scrub.clean) {
    return {
      ok: false,
      error: "scrub findings",
      reason:
        "the assembled issue contains downstream-context disclosure tokens (upstream-issue-hygiene MUST-2). HALT: genericize the flagged spans + re-draft. The defect goes upstream; the story of HOW you found it stays home.",
      findings: scrub.findings,
      body, // returned so the human can see what to redact
      step: "scrub",
    };
  }

  // Labels: a cross-sdk label + the routing class (capability/bug), if supplied.
  const labels = ["cross-sdk"];
  if (o.proposedClass === "capability" || o.proposedClass === "bug") {
    labels.push(o.proposedClass);
  }

  return {
    ok: true,
    scrub_clean: true,
    title: o.title,
    body,
    labels,
    // Invariant (iv): a human gate is MANDATORY before any file. This lib never
    // fires the transport — it returns the restate material the codify.md
    // Step-7c gate uses (MUST-1: restate target + action, explicit y/N).
    requires_human_gate: true,
    gate: {
      target_repo: `${repoRef.owner}/${repoRef.name}`,
      action: "create BUILD issue (cross-SDK-first)",
      prompt: `Approve filing this BUILD issue against ${repoRef.owner}/${repoRef.name}? (y/N)`,
    },
  };
}

// ---------------------------------------------------------------------------
function _err(step, reason) {
  return { ok: false, error: "draft failed", reason, step };
}

module.exports = {
  draftBuildIssue,
  scrubIssueText,
  // Constants exposed for callers + tests (the byte-identity pins live here).
  SECTION_ORDER,
  SEVERITY_LEVELS,
  CROSS_SDK_ACCEPTANCE_LINE,
  SCRUB_PATTERNS,
};
