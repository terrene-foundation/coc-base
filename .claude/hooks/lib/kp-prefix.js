#!/usr/bin/env node
/**
 * kp-prefix.js — the PURE PREDICATES behind `specs-authority.md` Rule 10
 * INVARIANT 1: "A value that is not a `kp://` URN — a bare table name, an
 * identifier, a path — is BLOCKED."
 *
 * GRADUATED 2026-09-15 from `phase2-deferrals.json::deferrals`
 * ["specs-authority.md#rule-10-kp-prefix"], whose registered graduation
 * condition was "the knowledge-product prefix tripwire ships with fixtures".
 *
 * --- WHAT THIS DECIDES, AND THE FOUR INVARIANTS IT CANNOT SEE ---------------
 * Rule 10 states FIVE invariants. This module implements ONE of them and says
 * so rather than implying coverage it lacks:
 *
 *   1  `kp://`-scheme URN required   DECIDABLE — the value either carries the
 *      scheme and the rule's declared grammar, or it does not. A parsed field
 *      value is compared against a literal prefix and a closed shape.
 *
 *   2  ecosystem-relative            NOT DECIDABLE — deciding that a segment
 *      embeds "the ecosystem/tenant slug" requires knowing which tokens ARE
 *      this deployment's ecosystem slugs. No authority in this tree enumerates
 *      them, and a hand-list here would be exactly the drift shape the sibling
 *      detectors refuse.
 *   3  `<domain>` is an OPAQUE handle NOT DECIDABLE — and the rule says so in
 *      its own voice: "what counts as non-derivable is the mesh identity spec's
 *      contract, not this rule's to restate". `kp://use/7f3a9c21/x@3` and
 *      `kp://use/9c1f3a72/x@3` are byte-indistinguishable to any parser; one
 *      may be a hash of the readable name and the other not.
 *   4  no readable client name       NOT DECIDABLE — "acme" vs "churn" is a
 *      judgment against a client roster that exists nowhere in this repo.
 *   5  inert at loom / REGISTER-not-BIND  NOT DECIDABLE HERE — it is a property
 *      of WHO wrote the link and in WHICH repo, not of the bytes on the line.
 *
 * SO SILENCE FROM THIS MODULE IS NOT A CLEAN VERDICT ON RULE 10. It is a clean
 * verdict on invariant 1 ALONE, and on nothing else
 * (`instrument-discipline.md` MUST-3(a): a silent instrument and a true
 * negative are byte-identical). Gate-review remains the layer for 2–5, exactly
 * as the rule's Trust Posture Wiring already assigns it.
 *
 * --- THE CORPUS HAS NO LIVE INSTANCE, AND THE FIXTURES CARRY THAT WEIGHT ----
 * MEASURED 2026-09-15 on this tree: `git grep -n '^\s*knowledge-product:'`
 * returns 10 lines, ALL of them inside a fenced ```text teaching block in
 * `.claude/rules/specs-authority.md` or `.claude/rules/spec-accuracy.md`, and
 * NONE in any file under a `specs/` directory. Every other occurrence of the
 * token in the tree is prose naming the FIELD TYPE, not a field. So this
 * detector has ZERO true-positive population at loom today, by design as much
 * as by accident: invariant 5 makes loom a REGISTRAR, and the link is BOUND
 * downstream. The fixtures beside this module are therefore the ONLY place its
 * firing is ever demonstrated, which is why they are bipolar on every
 * scope-restriction predicate rather than a firing set with a token clean case.
 *
 * --- WHAT MAKES A LINE A FIELD (the structural part) ------------------------
 * Three fences, and each one is load-bearing against a naive check that this
 * corpus would otherwise have shipped:
 *
 *   COLUMN 0        the key must begin at column 0. This is what makes an
 *                   indented line — a YAML block-scalar body, a nested mapping
 *                   under another key, a continuation under a bullet — unable
 *                   to spoof the detector. It costs a DECLARED BLIND SPOT (an
 *                   indented real field is missed) and that is the smaller true
 *                   answer, not a silent one: the fixture set pins it under a
 *                   `blind-` name that the runner reports as BLIND, never PASS.
 *   NOT FENCED      a line inside a ``` / ~~~ code fence is an ILLUSTRATION.
 *                   All ten corpus occurrences are fenced; without this fence a
 *                   line-anchored regex reds the very rule that defines the
 *                   field, including its deliberate DO-NOT examples. An
 *                   UNCLOSED fence swallows the rest of the file, which is the
 *                   reading a markdown renderer takes and the conservative one.
 *   KEY AT LINE HEAD  a prose mention is written `` `knowledge-product:` `` and
 *                   so begins with a backtick. Requiring the bare (or quoted)
 *                   key at the head is what separates a FIELD from a SENTENCE
 *                   ABOUT the field — the discrimination a `grep -l` cannot
 *                   make, and the reason `specs/ontology/glossary.md:90` is
 *                   silent here.
 *
 * --- TYPED WORLDS, NEVER COLLAPSED -----------------------------------------
 * The parse returns a KIND per field, on the discipline
 * `journal-write-guard.js::parseFrontmatterAuthor` records: collapsing
 * "no value", "a block-scalar opener" and "a bare table name" into one verdict
 * is how a check stops RUNNING while still passing. An empty or block-scalar
 * value is reported as UNPARSEABLE — a finding — not skipped and not reported
 * as a missing prefix, because those are different facts about the document.
 *
 * --- SEVERITY: `advisory`, and the rule fixed it before this existed --------
 * `specs-authority.md` § Trust Posture Wiring — Rule 10: "`advisory` at the
 * hook layer (a `knowledge-product:` value's `kp://` prefix MAY be lexically
 * checked, but the inert-at-loom / no-in-session-resolution / no-cross-write
 * property is judgment-bearing per `hook-output-discipline.md` MUST-2 and MUST
 * NOT carry `block`)". This module honours that verbatim rather than
 * re-deriving it. Two independent reasons hold it there on inspection: the
 * detector covers 1 of 5 invariants, so a green is not a Rule-10 verdict and a
 * refusal would assert one; and the consuming hook runs at PostToolUse, after
 * the write has landed, where there is nothing left to block.
 *
 * --- PURITY -----------------------------------------------------------------
 * NOTHING here touches the filesystem, spawns a process, or reads the
 * environment. Every input arrives as an argument so the fixtures drive the
 * real predicates rather than a re-implementation of them. All I/O lives in
 * `../kp-prefix-guard.js`.
 */

"use strict";

const RULE_MISSING_SCHEME = "specs-authority/rule-10-missing-kp-scheme";
const RULE_MALFORMED_URN = "specs-authority/rule-10-malformed-kp-urn";
const RULE_UNPARSEABLE = "specs-authority/rule-10-unparseable-value";
const SEVERITY = "advisory";

/** Bound every evidence string so one long line cannot flood the response. */
const EVIDENCE_MAX = 200;

/**
 * `specs-authority.md`'s OWN `paths:` frontmatter, transcribed once here and
 * nowhere else in this module, each glob translated to the narrowest regex that
 * means the same thing. Deliberately NOT widened: `.claude/rules/**` is absent,
 * so this detector cannot fire on the rule that defines the field — a second,
 * independent fence behind the code-fence mask, and the one that survives if a
 * future edit un-fences an example.
 */
const SPEC_SURFACE_PATTERNS = [
  /(^|\/)specs\//,
  /(^|\/)workspaces\//,
  /(^|\/)briefs\//,
  /(^|\/)02-plans\//,
  /(^|\/)todos\//,
];

/**
 * Surfaces a `knowledge-product:` field can live on. Markdown is the shape Rule
 * 10's DO example shows (a field line under a `##` section heading); YAML is
 * included because a spec sidecar carrying the same key is the same contract
 * with the same grammar.
 */
const TEXT_EXT = /\.(md|markdown|mdx|txt|rst|ya?ml)$/i;

/**
 * The FIELD line. Anchored at column 0 (see the header's COLUMN 0 fence) and
 * accepting the bare or quoted key, with optional space before the colon —
 * the same three shapes `parseFrontmatterAuthor` tolerates, for the same
 * reason: a real claim written in a shape the regex missed sails past with no
 * finding at all, which is a check that never RAN rather than one that passed.
 */
const FIELD_RE =
  /^(?:"knowledge-product"|'knowledge-product'|knowledge-product)[ \t]*:[ \t]*(.*)$/;

/** A fence line — three-or-more backticks or tildes, with an optional info string. */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Rule 10's DECLARED grammar, quoted from the rule: a value is a
 * `kp://<owning_level>/<domain>/<name>@<version>` URN. Exactly three
 * slash-separated segments after the scheme, none of them empty or carrying an
 * `@` or whitespace, and a non-empty `@version` closing the last one.
 */
const URN_RE = /^kp:\/\/([^/\s@]+)\/([^/\s@]+)\/([^/\s@]+)@([^/\s@]+)$/;

/** A YAML block-scalar opener — `|`, `>`, with an optional chomp/indent suffix. */
const BLOCK_SCALAR_RE = /^[|>][0-9+-]*$/;

/**
 * Flatten one value for the advisory surface: C0 controls (including the
 * newlines a multi-line value could carry) become spaces so a single finding
 * can never break the rendered response into forged lines, then runs of
 * whitespace collapse and the result is length-bounded.
 *
 * THE CONTROL CLASS IS WRITTEN WITH SINGLE BACKSLASHES, AND THAT IS A FIX.
 * A prior revision carried `[\\u0000-\\u001f\\u007f]` — DOUBLE-escaped — which
 * is not a control-character range at all but a literal class containing `\`,
 * `u`, `f`, `7` and assorted digits, so it silently ate letters out of the very
 * value the finding exists to quote: `churn_features_table` was rendered
 * `ch rn_ eat res_table`. Every fixture still passed, because the runner
 * compares rule_ids; it was caught only by running the GUARD end-to-end. The
 * runner now also asserts the offending value appears VERBATIM in the evidence,
 * which is the case that would have reddened this.
 */
function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_MAX
    ? flat.slice(0, EVIDENCE_MAX) + "..."
    : flat;
}

/**
 * Is this path a surface `specs-authority.md` itself governs?
 * Text extension AND one of the rule's own globs. Anything else is silent —
 * not clean, out of scope.
 */
function isGovernedSpecSurface(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  const p = relPath.replace(/\\/g, "/");
  if (!TEXT_EXT.test(p)) return false;
  return SPEC_SURFACE_PATTERNS.some((re) => re.test(p));
}

/**
 * Normalize a raw field value to the URN CANDIDATE token.
 *
 * Order matters and each step answers one shape seen in the rule's own
 * examples: strip an unquoted `# comment` (a quoted value may legitimately
 * contain `#`), unwrap one layer of quotes, then take the FIRST whitespace-
 * delimited token — so a trailing parenthetical annotation on the same line
 * ("kp://a/b/c@3 (registered 2026-09-15)") is not read INTO the URN and does
 * not manufacture a malformed-URN finding out of prose.
 *
 * THE COMMENT ANCHOR IS `(^|\s+)#`, NOT `\s+#`, AND THAT IS A FIX, NOT A
 * FLOURISH. `FIELD_RE` already consumes the run of spaces after the colon, so a
 * field written `knowledge-product:    # unbound, pending /distill` arrives here as the
 * value `# unbound, pending /distill` with NO leading whitespace: a `\s+#` anchor never
 * matched it, the strip silently did nothing, and the first-token split then
 * reported the value as the single character `#` — i.e. "that is not a `kp://`
 * URN", when the true fact is that the field declares NO VALUE and invariant 1
 * was never checked. That is the collapsed-worlds defect this module's header
 * warns about, committed by this module. Found by MUTATION (dropping the strip
 * left the suite GREEN at 23/23 because the first-token split absorbed it; the
 * DOUBLE mutation reddened, which is what separated absorption from vacuity),
 * and closed here with `flag-comment-only-value` as its pinning case. A leading
 * `#` can never begin a `kp://` URN, so the wider anchor costs no true positive.
 *
 * @returns {{kind:"value", token:string, display:string}
 *          |{kind:"empty"}
 *          |{kind:"block-scalar", token:string}}
 */
function normalizeFieldValue(raw) {
  let value = typeof raw === "string" ? raw : "";
  if (!/^["']/.test(value.trim())) value = value.replace(/(^|\s+)#.*$/, "");
  value = value.trim();
  const q = value.match(/^"([^"]*)"$|^'([^']*)'$/);
  if (q) value = (q[1] !== undefined ? q[1] : q[2]).trim();
  if (value === "") return { kind: "empty" };
  if (BLOCK_SCALAR_RE.test(value))
    return { kind: "block-scalar", token: value };
  const token = value.split(/\s+/)[0];
  return { kind: "value", token, display: value };
}

/**
 * Every `knowledge-product:` FIELD in a document, with the structural facts
 * that decided it was a field. Fenced lines and indented lines are NOT fields
 * and are not returned — see the header's three fences.
 *
 * `region` is reported for the reader's benefit only; it does not change any
 * verdict. `frontmatter` means the line sits inside the document's LEADING
 * `---` … `---` block.
 *
 * @param {string} text
 * @returns {Array<{line:number, region:"frontmatter"|"body", raw:string,
 *                  parsed:ReturnType<typeof normalizeFieldValue>}>}
 */
function parseKnowledgeProductFields(text) {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);

  // Leading `---` … `---` block, for the region LABEL only. An unterminated
  // opener leaves `fmEnd` at -1, in which case no line is labelled frontmatter
  // (the label is cosmetic; the verdict does not depend on it).
  let fmEnd = -1;
  if (lines.length > 0 && /^---[ \t]*$/.test(lines[0])) {
    for (let i = 1; i < lines.length; i += 1) {
      if (/^---[ \t]*$/.test(lines[i])) {
        fmEnd = i;
        break;
      }
    }
  }

  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    // An UNCLOSED fence swallows the rest of the file. Deliberate: it is the
    // reading a markdown renderer takes, and going silent on prose that is
    // really code beats flagging it.
    if (inFence) continue;
    const m = FIELD_RE.exec(line);
    if (!m) continue;
    out.push({
      line: i + 1,
      region: fmEnd > 0 && i > 0 && i < fmEnd ? "frontmatter" : "body",
      raw: m[1],
      parsed: normalizeFieldValue(m[1]),
    });
  }
  return out;
}

/**
 * The verdict. PURE — every input is supplied by the caller.
 *
 * @param {string} text  the document's content AFTER the write
 * @returns {Array<{rule_id,severity,line,region,evidence}>}
 */
function findKnowledgeProductFindings(text) {
  const fields = parseKnowledgeProductFields(text);
  const findings = [];
  for (const f of fields) {
    const base = { severity: SEVERITY, line: f.line, region: f.region };

    if (f.parsed.kind === "empty") {
      findings.push({
        ...base,
        rule_id: RULE_UNPARSEABLE,
        evidence:
          `line ${f.line} (${f.region}): \`knowledge-product:\` declares NO value, so invariant 1 ` +
          `could not be checked — an unchecked field is a finding, not a clean line`,
      });
      continue;
    }
    if (f.parsed.kind === "block-scalar") {
      findings.push({
        ...base,
        rule_id: RULE_UNPARSEABLE,
        evidence:
          `line ${f.line} (${f.region}): \`knowledge-product:\` opens a YAML block scalar ` +
          `(\`${sanitize(f.parsed.token)}\`); this parser reads a single-line scalar, so the URN was ` +
          `NOT read and invariant 1 is UNCHECKED here, not satisfied`,
      });
      continue;
    }

    const token = f.parsed.token;
    if (!token.startsWith("kp://")) {
      findings.push({
        ...base,
        rule_id: RULE_MISSING_SCHEME,
        evidence:
          `line ${f.line} (${f.region}): \`knowledge-product: ${sanitize(f.parsed.display)}\` is not a ` +
          `\`kp://\` URN. Rule 10 invariant 1: "A value that is not a \`kp://\` URN — a bare table ` +
          `name, an identifier, a path — is BLOCKED"`,
      });
      continue;
    }
    if (!URN_RE.test(token)) {
      findings.push({
        ...base,
        rule_id: RULE_MALFORMED_URN,
        evidence:
          `line ${f.line} (${f.region}): \`${sanitize(token)}\` carries the \`kp://\` scheme but not the ` +
          `shape Rule 10 declares — \`kp://<owning_level>/<domain>/<name>@<version>\`, three ` +
          `non-empty segments closed by a non-empty \`@version\``,
      });
    }
    // A value that passes BOTH checks draws no finding. That is invariant 1
    // satisfied — and invariants 2, 3, 4 and 5 UNEXAMINED. See the header.
  }
  return findings;
}

/** Render findings for the advisory surface — bounded, each line naming its own field. */
function renderFindings(findings, surface) {
  const lines = [
    `⚠ specs-authority Rule 10 invariant 1 — ${findings.length} \`knowledge-product:\` field(s) ` +
      `in ${surface} do not carry a well-formed \`kp://\` URN.`,
    "",
    ...findings
      .slice(0, 12)
      .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.evidence}`),
  ];
  if (findings.length > 12) lines.push(`- … and ${findings.length - 12} more`);
  lines.push("");
  lines.push(
    "Bind the field to a `kp://<owning_level>/<domain>/<name>@<version>` URN, or remove the field. " +
      "This is ADVISORY and stopped nothing: the write has already landed, and this check covers " +
      "invariant 1 ALONE — the ecosystem-relative, opaque-`<domain>`, no-readable-client-name and " +
      "inert-at-loom invariants are judgment-bearing and remain gate-review's, so silence here is " +
      "NOT a Rule 10 all-clear.",
  );
  return lines.join("\n");
}

module.exports = {
  RULE_MISSING_SCHEME,
  RULE_MALFORMED_URN,
  RULE_UNPARSEABLE,
  SEVERITY,
  EVIDENCE_MAX,
  SPEC_SURFACE_PATTERNS,
  TEXT_EXT,
  URN_RE,
  isGovernedSpecSurface,
  normalizeFieldValue,
  parseKnowledgeProductFields,
  findKnowledgeProductFindings,
  renderFindings,
};
