/**
 * triage-routing.js — the PURE PREDICATES behind `issue-triage-routing.md`'s
 * Phase-2 detector: does a `gh issue create` send the issue to the lane this
 * repo's CLASS prescribes, or to the repo that happens to be convenient?
 *
 * --- WHAT IS MECHANICALLY DECIDABLE HERE, AND WHAT IS NOT -------------------
 * `issue-triage-routing.md` routes by `.claude/VERSION::type` across FOUR repo
 * classes. Only ONE of the four has an argv-visible disposition, and this module
 * implements that one and says so rather than implying coverage it lacks:
 *
 *   coc-project     DECIDABLE — "NEVER file on your own repo (orphan — never
 *                   pulled upstream); NEVER file on loom (bypasses USE-template
 *                   review)." Both destinations are in the argv, and the repo's
 *                   own identity and its sanctioned upstream are both derivable
 *                   from authorities (see DERIVED, NEVER HAND-LISTED below).
 *
 *   coc-use-template  NOT DECIDABLE — the disposition is "`/codify` Step 7b
 *                   proposal", a procedure, not a destination. Filing an issue
 *                   on itself is CORRECT for this class.
 *   coc-build       NOT DECIDABLE — "cross-SDK FIRST" is a sequencing property
 *                   over work that happened before this command; no token in a
 *                   `gh issue create` carries whether the sibling SDK was checked.
 *   coc-source      NOT DECIDABLE — "Splits, Never Originates" is violated by
 *                   AUTHORING A LOCAL ARTIFACT, i.e. an Edit to a rule file, and
 *                   an ingest-driven rule edit and a hand-fix to close an issue
 *                   are byte-identical at the tool boundary.
 *
 * SO THIS HOOK IS STRUCTURALLY SILENT AT LOOM, WHICH IS `coc-source`. That
 * silence is NOT evidence a session routed correctly — it is evidence the class
 * has no argv signal (`instrument-discipline.md` MUST-3(a): a silent instrument
 * and a true negative are byte-identical). The fixtures therefore drive the
 * predicate with a DECLARED class rather than reading loom's own, so the firing
 * pole is demonstrated on a tree where the detector can never fire in anger.
 *
 * --- DERIVED, NEVER HAND-LISTED --------------------------------------------
 * Three enumerations, each read from its AUTHORITY, because a hand-restated list
 * keyed on a naming convention a newer convention outgrew is this corpus's
 * recurring defect class:
 *   - the repo CLASS          ← `.claude/VERSION::type` (`version-utils.js`)
 *   - this repo's IDENTITY    ← the LIVE git origin remote
 *                               (`upflow-self-repo.js::deriveSelfRepoRef`, which
 *                               refuses rather than falling back to a dirname)
 *   - the SANCTIONED UPSTREAM ← `.claude/VERSION::upstream.repo`
 * There is no literal `loom` anywhere in this file, deliberately. The third
 * verdict below is "NEITHER self NOR the declared upstream", which is the class
 * the rule's two prohibitions share; naming loom specifically would be a
 * hand-list that a renamed or forked canon silently outgrows.
 *
 * --- THE THREE VERDICTS -----------------------------------------------------
 *   files-on-self      target resolves to THIS repo (explicitly, or by omitting
 *                      `--repo` so `gh` defaults to the current repo). The
 *                      orphan case: never pulled upstream.
 *   files-off-lane     target is neither this repo nor the declared upstream.
 *                      The bypass case. REQUIRES a declared upstream to be
 *                      readable — with none, this verdict is WITHHELD, because
 *                      without it a sanctioned Route-A filing on the template is
 *                      indistinguishable from a convenience filing. Degrading to
 *                      a SMALLER TRUE ANSWER, never to a false clean.
 *   (silent)           target IS the declared upstream — the sanctioned Route-A
 *                      fallback the rule names. This is the load-bearing CLEAN
 *                      pole: a detector that fired on every cross-repo filing
 *                      would flag the compliant lane and teach the operator to
 *                      ignore it.
 *
 * --- SEVERITY ---------------------------------------------------------------
 * `advisory`, which is what the rule's OWN Trust Posture Wiring prescribes:
 * "`advisory` at the hook layer (lexical routing-intent detection over a `gh
 * issue` triage MUST NOT carry `block` per `hook-output-discipline.md` MUST-2)".
 * The class and the identity are structural, but the intent — whether this issue
 * is a COC-method fix subject to the routing table, or an ordinary operational
 * issue — is not, so the composed finding is capped at the weakest half.
 *
 * --- PURITY -----------------------------------------------------------------
 * NOTHING in this file touches the filesystem, spawns a process, or reads the
 * environment. Every input arrives on the context object so the fixtures can
 * drive the real predicates rather than a re-implementation of them. All I/O
 * lives in `../triage-routing-guard.js`.
 *
 * Origin: graduated from `phase2-deferrals.json::deferrals`
 * ["issue-triage-routing.md#route-by-class"] 2026-09-13, whose registered
 * graduation condition was "a detector pairing a gh issue triage against
 * `.claude/VERSION::type`".
 */

"use strict";

const {
  stripHeredocBodies,
  splitShellSegments,
} = require("./violation-patterns.js");
const { normalizeComponent } = require("./upflow-self-repo.js");

/** The one class whose disposition has an argv signal. See the header. */
const DECIDABLE_CLASS = "coc-project";

/** Bound every evidence string so a long command cannot flood the response. */
const EVIDENCE_MAX = 200;

function sanitize(s) {
  if (typeof s !== "string") return "";
  // Strip C0 controls (including the newlines a multi-line command carries) so a
  // single finding can never break the rendered response into forged lines.
  const flat = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX ? flat.slice(0, EVIDENCE_MAX) + "..." : flat;
}

/**
 * Split one shell segment into argv tokens, quote-aware, unwrapping the quotes.
 * NOT a shell parser and deliberately does not expand anything
 * (`hook-output-discipline.md` MUST-3 forbids a hook expanding shell syntax) —
 * it only needs to see `gh`, `issue`, `create` and a `--repo` value.
 */
function tokenize(segment) {
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        cur += segment[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[i + 1];
      started = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (cur || started) out.push(cur);
  return out;
}

/**
 * Parse `owner/name` (or a full https/ssh URL) into a normalized {owner, name}
 * using the SAME component normalizer the VCS adapters use, so this module and
 * they cannot drift apart on case or a `.git` suffix.
 */
function parseRepoRef(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw.trim();
  s = s.replace(/^[a-z]+:\/\/[^/]+\//i, ""); // https://host/  → owner/name
  s = s.replace(/^git@[^:]+:/i, ""); // git@host:      → owner/name
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = normalizeComponent(parts[parts.length - 2]);
  const name = normalizeComponent(parts[parts.length - 1]);
  if (!owner || !name) return null;
  return { owner, name };
}

/** True when two normalized refs name the same repo. Null on either side ⇒ false. */
function sameRepo(a, b) {
  return Boolean(a && b && a.owner === b.owner && a.name === b.name);
}

/**
 * Every `gh issue create` invocation in one command string, with its explicit
 * `--repo` target if it carries one.
 *
 * SCOPE RESTRICTIONS, each one a case a wrong edit would silently widen:
 *   - heredoc BODIES are stripped first, so a command documented inside a
 *     `cat <<EOF` payload is data, not an invocation;
 *   - segments are split quote-aware, so a `gh issue create` inside a quoted
 *     commit message or `echo` argument is one token, not a command;
 *   - the invocation must START the segment (after `env`-style prefixes are not
 *     accepted — a `gh` appearing mid-segment is an argument to something else);
 *   - `--help`/`-h` is a documentation read, never a filing;
 *   - a `#` comment tail is dropped.
 */
function extractIssueCreateInvocations(command) {
  if (typeof command !== "string" || !command.trim()) return [];
  let text;
  try {
    text = stripHeredocBodies(command);
  } catch {
    return []; // Cannot separate command from data ⇒ UNKNOWN ⇒ fail open.
  }
  let segments;
  try {
    segments = splitShellSegments(text, { newlineSeparates: true });
  } catch {
    return [];
  }
  const found = [];
  for (const seg of segments) {
    if (typeof seg !== "string") continue;
    const noComment = seg.replace(/(^|\s)#[^\n]*$/, "");
    const tokens = tokenize(noComment).filter((t) => t.length > 0);
    if (tokens.length < 3) continue;
    if (tokens[0] !== "gh") continue;
    if (tokens[1] !== "issue" || tokens[2] !== "create") continue;
    if (tokens.some((t) => t === "--help" || t === "-h")) continue;

    let target = null;
    for (let i = 3; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === "--repo" || t === "-R") {
        target = tokens[i + 1] || null;
        break;
      }
      if (t.startsWith("--repo=")) {
        target = t.slice("--repo=".length);
        break;
      }
    }
    found.push({
      segment: sanitize(noComment.trim()),
      explicitTarget: target,
      target: target ? parseRepoRef(target) : null,
    });
  }
  return found;
}

/**
 * The verdict. PURE — every input is supplied by the caller.
 *
 * @param {object} ctx
 * @param {string} ctx.command       the Bash tool_input command
 * @param {string} ctx.repoClass     `.claude/VERSION::type`
 * @param {{owner,name}|null} ctx.selfRepo      derived from the live origin remote
 * @param {{owner,name}|null} ctx.upstreamRepo  `.claude/VERSION::upstream.repo`
 * @returns {Array<{rule_id,severity,evidence}>}
 */
function inspectIssueFiling(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  // FAIL OPEN on every unknown (`cc-artifacts.md` Rule 7). A class we cannot
  // read is not a violation; neither is one of the three classes with no argv
  // signal — see the header, and do NOT read this silence as an all-clear.
  if (typeof c.repoClass !== "string" || c.repoClass.trim() !== DECIDABLE_CLASS) {
    return [];
  }
  const invocations = extractIssueCreateInvocations(c.command);
  if (invocations.length === 0) return [];

  const self = c.selfRepo || null;
  const upstream = c.upstreamRepo || null;
  const findings = [];

  for (const inv of invocations) {
    // No `--repo` ⇒ `gh` files on the CURRENT repo. That IS the self-filing
    // case and needs no identity derivation to decide.
    if (!inv.explicitTarget) {
      findings.push({
        rule_id: "issue-triage-routing/files-on-self",
        severity: "advisory",
        evidence:
          `\`gh issue create\` with no --repo files on THIS repo, and ` +
          `.claude/VERSION::type is \`${DECIDABLE_CLASS}\` — a downstream consumer. ` +
          `The rule: "NEVER file on your own repo (orphan — never pulled upstream)". ` +
          `Command: ${inv.segment}`,
      });
      continue;
    }
    if (!inv.target) continue; // Unparseable target ⇒ UNKNOWN ⇒ fail open.

    if (self && sameRepo(inv.target, self)) {
      findings.push({
        rule_id: "issue-triage-routing/files-on-self",
        severity: "advisory",
        evidence:
          `\`gh issue create --repo ${inv.target.owner}/${inv.target.name}\` targets THIS ` +
          `repo, and .claude/VERSION::type is \`${DECIDABLE_CLASS}\`. The rule: "NEVER file ` +
          `on your own repo (orphan — never pulled upstream)". Command: ${inv.segment}`,
      });
      continue;
    }

    // WITHHELD without a declared upstream: a sanctioned Route-A filing on the
    // template and a convenience filing are indistinguishable, so the honest
    // answer is the smaller true one, not a guess in either direction.
    if (!upstream) continue;

    if (sameRepo(inv.target, upstream)) continue; // Sanctioned Route-A fallback.

    findings.push({
      rule_id: "issue-triage-routing/files-off-lane",
      severity: "advisory",
      evidence:
        `\`gh issue create --repo ${inv.target.owner}/${inv.target.name}\` targets neither ` +
        `this repo nor the upstream declared in .claude/VERSION::upstream.repo ` +
        `(${upstream.owner}/${upstream.name}), and .claude/VERSION::type is ` +
        `\`${DECIDABLE_CLASS}\`. A consumer routes UP to the template it pulled from — ` +
        `filing elsewhere bypasses USE-template review and loses provenance. ` +
        `Command: ${inv.segment}`,
    });
  }
  return findings;
}

module.exports = {
  DECIDABLE_CLASS,
  EVIDENCE_MAX,
  extractIssueCreateInvocations,
  inspectIssueFiling,
  parseRepoRef,
  sameRepo,
  tokenize,
};
