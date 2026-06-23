/**
 * gc-disposition-receipt — the G-C-3 (G3.5) disposition-visibility receipt
 * builder: a DUMB string-builder for the per-hop async-disposition comment that
 * makes the consultant's dual-route upflow LEGIBLE without changing the
 * (correct, human-gated, quadruple-fenced) mechanism.
 *
 * ECO-IMPL Wave 7b, Shard G-C-3. Implements
 * `workspaces/ecosystem-operating-model/02-plans/04-gc-dual-route-classification.md`
 * §5 (G3.5 — close the use-template-route UX delta; it's disposition-VISIBILITY,
 * not mechanism) + Q3 (PR/issue comment-back — no new infra, visible where the
 * consultant looks).
 *
 * THE MECHANISM IS UNCHANGED (load-bearing): this lib emits a COMMENT string the
 * Step-7c / Route-B procedure posts back to the consultant's own PR / issue. It
 * adds NO new infrastructure and changes NO routing — it converts the silence of
 * the (correct) async pipeline into a legible breadcrumb at each hop.
 *
 * DISCLOSURE (invariant ii): a receipt carries HOP-LEVEL provenance ONLY — the
 * template NAME (`via: <template-slug>`), never a consumer identity. There is no
 * consumer-name parameter; the optional free-text `detail` is scrubbed through
 * the SAME disclosure denylist as the BUILD-issue drafter (single source of
 * truth — gc-build-issue-draft.js::scrubIssueText).
 *
 * SCOPE BOUNDARY (NOT this shard): NO routing (gc-route-classifier.js — G-C-T2),
 * NO issue drafting (gc-build-issue-draft.js — G-C-WIRE), NO transport.
 *
 * Style: CommonJS, sync. Per zero-tolerance.md Rule 2/3: no stubs; typed
 * failures; no silent fallback.
 */

"use strict";

const { scrubIssueText } = require("./gc-build-issue-draft.js");

// Route A (artifact upflow) hop stages — the 4-hop chain made visible (§5).
const ROUTE_A_STAGES = {
  queued: "queued for template ingest",
  relayed: "relayed to loom Gate-1",
  deduped: "deduped — already solved upstream",
  flagged: "flagged at template ingest (see template review)",
  cascaded: "cascaded — pull on next /sync or session start",
};

// Route B (capability/bug → BUILD) hop stages.
const ROUTE_B_STAGES = {
  drafted: "BUILD issue drafted — pending your human gate",
  filed: "BUILD issue filed (cross-SDK-first)",
  triaged: "BUILD triage disposition recorded",
};

const ROUTE_STAGE_MAPS = { A: ROUTE_A_STAGES, B: ROUTE_B_STAGES };

// The fixed channel — a comment on the consultant's own PR/issue (Q3: no new
// infra). The test pins it.
const RECEIPT_CHANNEL = "pr-issue-comment";

/**
 * Build a single async-disposition receipt comment for one hop.
 *
 * @param {object} opts
 * @param {"A"|"B"} opts.route       - which lane (A = artifact upflow, B = BUILD)
 * @param {string} opts.stage        - a key of the route's stage map
 * @param {string} [opts.templateSlug] - hop-level provenance (the template NAME,
 *                                        rendered as `via: <slug>`); NEVER a
 *                                        consumer identity
 * @param {string|number} [opts.ref] - the PR / issue number for filed/cascaded hops
 * @param {string} [opts.detail]     - optional free-text (scrubbed; HALT on a finding)
 * @returns one of:
 *   { ok:true, channel, route, stage, comment }
 *   { ok:false, error, reason, step[, findings] }
 */
function buildDispositionReceipt(opts) {
  const o = opts || {};
  // Prototype-safe lookups: a plain-object `in`/`[]` walks the prototype chain,
  // so `route:"constructor"` / `stage:"__proto__"` would pass validation
  // (R2 MED — the sibling libs use Set.has; this lib regressed to `in`). Guard
  // every map access with hasOwnProperty so only OWN keys validate.
  if (typeof o.route !== "string" || !_hasOwn(ROUTE_STAGE_MAPS, o.route)) {
    return _err(
      "route",
      `opts.route must be 'A' or 'B'; got ${JSON.stringify(o.route)}`,
    );
  }
  const stageMap = ROUTE_STAGE_MAPS[o.route];
  if (typeof o.stage !== "string" || !_hasOwn(stageMap, o.stage)) {
    return _err(
      "stage",
      `opts.stage must be one of ${Object.keys(stageMap).join(", ")} for route ${o.route}; got ${JSON.stringify(o.stage)}`,
    );
  }
  if (
    o.templateSlug !== undefined &&
    (typeof o.templateSlug !== "string" || !o.templateSlug)
  ) {
    return _err(
      "templateSlug",
      "opts.templateSlug, when provided, must be a non-empty string (the template NAME)",
    );
  }
  if (
    o.ref !== undefined &&
    typeof o.ref !== "string" &&
    typeof o.ref !== "number"
  ) {
    return _err("ref", "opts.ref, when provided, must be a string or number");
  }
  if (o.detail !== undefined && typeof o.detail !== "string") {
    return _err(
      "detail",
      `opts.detail, when provided, must be a string; got ${typeof o.detail}`,
    );
  }

  // Assemble the comment from CONTROLLED inputs (closed stage map + the template
  // NAME + the ref number). No consumer-name parameter exists.
  const parts = [`COC upflow disposition: ${stageMap[o.stage]}`];
  if (o.ref !== undefined) parts.push(`#${String(o.ref)}`);
  if (typeof o.templateSlug === "string")
    parts.push(`(via: ${o.templateSlug})`);
  if (typeof o.detail === "string" && o.detail.length > 0)
    parts.push(`— ${o.detail.trim()}`);
  const comment = parts.join(" ");

  // Invariant (ii): scrub the WHOLE assembled comment against the shared
  // disclosure denylist — covers the free-text `detail` AND a misused
  // `templateSlug` (R1 INFO defense-in-depth: a consumer identity passed AS the
  // slug would render into the public comment; the controlled stage-map prefix
  // + `#ref` never match a denylist pattern). A finding HALTs — no
  // consumer-context token in a receipt that gets posted publicly.
  const scrub = scrubIssueText(comment);
  if (!scrub.clean) {
    return {
      ok: false,
      error: "scrub findings",
      reason:
        "the receipt contains downstream-context disclosure tokens (upstream-issue-hygiene MUST-2). HALT: genericize the detail / template slug. Receipts carry hop-level provenance only.",
      findings: scrub.findings,
      step: "scrub",
    };
  }

  return {
    ok: true,
    channel: RECEIPT_CHANNEL, // comment-back (invariant i): no new infra
    route: o.route,
    stage: o.stage,
    comment,
  };
}

function _err(step, reason) {
  return { ok: false, error: "receipt failed", reason, step };
}

/** Prototype-safe own-key check (never walks the prototype chain). */
function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

module.exports = {
  buildDispositionReceipt,
  ROUTE_A_STAGES,
  ROUTE_B_STAGES,
  RECEIPT_CHANNEL,
};
