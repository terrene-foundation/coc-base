"use strict";

/**
 * derives-from-edge.js — loom#1228 (W1 item B1, the S-1 provenance-edge PRODUCER, loom lane).
 *
 * FORMAT AUTHORITY for the **`derives_from[]` PROV edge** — the backward, queryable provenance
 * relation binding every loom artifact (agent / skill / rule / hook) to the spec + workspace
 * rationale it was distilled from. The frozen v0 field shape this module implements is
 * `workspaces/loom-rag-plugin-2026-07-18/07-loom-1209-producer/03-derives-from-emit-contract.md`
 * § 2 ("The edge field shape (v0)"); every invariant below is that contract's § 2 "Hygiene
 * invariants" and § 3 (anchor discipline + the mesh fence).
 *
 * PRODUCER / CONSUMER SPLIT (loom "no coding" charter):
 *   - loom (THIS module + `derives-from-ledger.js`) is the PRODUCER. It DEFINES the edge FORMAT
 *     and stages one record per generated artifact at `/codify`'s Step 3/4 emission point
 *     (`.claude/commands/codify.md` § "3. Update existing agents" + § "4. Update existing skills").
 *   - kailash-rs **S-1** (a separate BUILD repo, **#1951**) is the CONSUMER. It persists the edge
 *     into the LOCAL DataFlow-backed accountability store and serves the "where did artifact X
 *     come from?" query + the orphan/unbacked-anchor sweep. loom does NOT build the store.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 * │ PENDING S-1 RATIFICATION — `derives_from_schema_version: 0`.                              │
 * │ This envelope is a loom-side PROPOSAL, NOT an agreed cross-repo contract. Version 0       │
 * │ signals "proposed / not yet frozen": kailash-rs #1951 has NOT locked its S-1 store fields.│
 * │ loom OWNS v0 and authors it NOW so the emit-side shape is a greppable tripwire S-1        │
 * │ ratifies AGAINST, rather than a shape reverse-engineered from whatever S-1 ships. When     │
 * │ S-1 confirms the field set, bump to `1` in a COORDINATED cross-repo cycle (loom emitter +  │
 * │ store conformance together). Until then no caller may treat this shape as frozen.          │
 * │ See the emit contract § 5 ("kailash-rs S-1 ratification — the coordination protocol").     │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ORPHAN STATUS (stated plainly, per `rules/user-flow-validation.md` MUST-8 +
 * `rules/orphan-detection.md`): this is the PRODUCER HALF ONLY. Nothing DRAINS the staging sink
 * today and there is NO query surface — the consumer is gated on kailash-rs #1951 (loom#1228
 * item B1's dependency). Do not read this module as an end-to-end provenance capability.
 *
 * FAIL-LOUD HERE, FAIL-OPEN AT THE SINK. Every hygiene invariant is enforced fail-loud in THIS
 * module (`buildDerivesFromEdge` THROWS; a malformed edge never reaches the sink), while the
 * staging-sink wrapper in `derives-from-ledger.js` catches and returns a result object so a
 * capture failure NEVER blocks the `/codify` caller. Same split the ArtifactActivationEvent
 * sibling uses (`artifact-activation-event.js` throws / `artifact-activation-ledger.js` does not).
 *
 * DISTINCT FROM the two sibling streams — three separate records, three purposes:
 *   - `provenance-event.js` (F101-2, schema_version 1, FROZEN): SIGNED, hash-chained governance
 *     records csq anchors — "who authorized this mutation, tamper-evidently". BYTE-FROZEN; this
 *     module MUST NOT widen it.
 *   - `artifact-activation-event.js` (#1209, v0): "WHICH artifact fired in a session" (heatmap).
 *   - THIS module (#1228, v0): "WHERE each artifact came FROM" (provenance topology).
 * The `derives_from[]` edge ships INDEPENDENT of the durable F101-2 leg (loom#1211); nothing here
 * takes a dependency on it (emit contract § 1 "Distinct from the durable F101-2 leg").
 *
 * Origin: loom#1228 item B1 (design `02-plans/05-framework-composite-adoption-design.md` § 3.2
 * item 1; `01-analysis/A-distillation-methodology.md` § 5 item 1).
 */

const fs = require("fs");
const path = require("path");

// Version 0 = PROPOSED / pending S-1 ratification (see the fenced block above). A frozen,
// S-1-ratified contract is version >= 1, bumped in a coordinated cross-repo cycle.
const DERIVES_FROM_SCHEMA_VERSION = 0;
const PENDING_S1_RATIFICATION = true;

/**
 * Closed generated-Entity taxonomy (emit contract § 2; design § 1.1). Shared with the
 * ArtifactActivationEvent contract's `ARTIFACT_TYPES`. Closed by invariant — widening it is a
 * MAJOR change per the contract § 4, NOT an additive minor bump.
 */
const ARTIFACT_TYPES = Object.freeze(["agent", "skill", "rule", "hook"]);

/**
 * Closed source-class taxonomy — which of the three source classes an `anchor` names (design
 * § 1.1/§ 1.4 "spec/artifact/workspace anchors"). The reverse index (orphan sweep) buckets by
 * this, so an out-of-set value would silently mis-bucket: closed by invariant.
 */
const ANCHOR_KINDS = Object.freeze(["spec", "artifact", "workspace"]);

/**
 * Closed PROV relation set. Light-PROV is SINGLE-relation, so `relation` is OPTIONAL on a
 * DerivationSource and absence defaults to `wasDerivedFrom`; a value PRESENT-and-out-of-set is
 * rejected (emit contract § 2 hygiene). Promoting it to required with a widened set is a MAJOR
 * change (contract § 5 Q4).
 */
const RELATIONS = Object.freeze(["wasDerivedFrom"]);
const DEFAULT_RELATION = "wasDerivedFrom";

/** The PROV Activity that generates the edge, and the PROV Agent (emitter identity). */
const ACTIVITY = "codify";
const PRODUCER = "loom";
const RECORD_TYPE = "DerivesFromEdge";

// Top-level edge keys in canonical declaration order (emit contract § 2 table order). Closed
// shape so a future S-1 conformance vector can byte-check it.
const EDGE_KEYS = Object.freeze([
  "derives_from_schema_version",
  "record_type",
  "artifact_type",
  "artifact_id",
  "derives_from",
  "activity",
  "session_id",
  "timestamp",
  "producer",
]);

// DerivationSource keys in canonical order (`relation` optional). Closed shape.
const DERIVATION_SOURCE_KEYS = Object.freeze(["anchor", "anchor_kind", "relation"]);

// Credential-shaped key names forbidden anywhere in the record (emit contract § 2 "No secrets";
// `security.md` "no secrets in logs"). A provenance edge is a DURABLE record.
//
// This pattern is COPIED from the ArtifactActivationEvent sibling's matcher and is byte-identical
// to it TODAY. Stating what is actually enforced (not "cannot drift" — that would over-claim per
// `zero-tolerance.md` Rule 3e): the sibling does NOT export its matcher, so no test can compare the
// two modules directly. What IS mechanically pinned is (a) THIS pattern against its literal, and
// (b) the shared `ARTIFACT_TYPES` taxonomy cross-module — both in
// `.claude/test-harness/tests/derives-from-edge.test.mjs`. A sibling-side edit to the credential
// pattern would NOT be caught here; closing that needs the sibling to export it too.
const CREDENTIAL_KEY_RE =
  /^(api_?key|model_?key|access_?key|signing_?key|private_?key|secret|token|password|passwd|credential)$|_(secret|token|password|passwd|credential|key)$/i;
const PROTO_POLLUTION_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);

const ISO_8601_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * THE MESH FENCE (emit contract § 3 point 2 — load-bearing, not a consumer courtesy). The
 * readable accountability graph these edges form stays LOCAL and READABLE; the mesh `kp://`
 * control-plane registry is a SEPARATE, name-BLIND, scrubbed-at-source identity/access layer
 * ABOVE it (`rules/specs-authority.md` Rule 10 invariants 3/4). A readable spec/artifact/
 * workspace anchor MUST NOT be pushed up into the name-blind plane, and the edge record NEVER
 * carries a `kp://` handle in EITHER direction. Enforced as a whole-record string scan.
 *
 * DELIBERATELY OVER-INCLUSIVE — matches the bare `kp://` SCHEME, not the full URN grammar
 * (`kp://<owning_level>/<domain>/<name>@<version>`). Known, ACCEPTED false positive: a section
 * heading whose TEXT contains the literal `kp://` cannot be used as an anchor — loom's own
 * `specs/ontology/glossary.md` has exactly such a heading, and citing it IS rejected (found by
 * dogfooding this resolver against this module's own doc examples). The disposition is to cite that
 * section by a different grep-stable heading, NOT to narrow the fence: a fail-closed fence with a
 * bounded, nameable false positive is the correct Phase-1 default (`cc-artifacts.md` Rule 10,
 * boundary-favors-the-gate), and "my own example tripped it" is not evidence that a
 * plane-separation fence is too strict. Narrowing this to a URN-shape match needs its own evidence
 * and review round; do NOT loosen it for convenience.
 */
const MESH_URN_RE = /kp:\/\//i;

/**
 * A bare line-number locator — the anchor shape `rules/symbol-anchored-citations.md` MUST-1
 * BLOCKS (`foo.mjs:471`, `dispatch.rs:88-140`). This is the property that makes the edge
 * queryable and the orphan sweep sound: a line number is invalidated by any insertion above it,
 * so an edge anchored on one silently points at the wrong code (emit contract § 2/§ 3 point 1).
 */
const BARE_LINE_LOCATOR_RE = /:\d+(?:-\d+)?$/;

/** Anchor grammar delimiters: `<path>::<symbol>` (symbol) and `<path>#<section>` (section). */
const SYMBOL_DELIM = "::";
const SECTION_DELIM = "#";

/** Bound the resolution read — a provenance emitter never slurps an arbitrarily large file. */
const MAX_ANCHOR_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Bound the per-record resolution WORK. Each DerivationSource costs one open+fstat+read, so an
 * unbounded array turns one `/codify` emission into arbitrary I/O. 32 is far above any plausible
 * real citation count (the richest artifact in this repo cites ~7 origins).
 */
const MAX_DERIVES_FROM = 32;

/**
 * Locator floors, measured on the NORMALIZED locator. Without a floor, `#§a` "resolves" against
 * `## The Widget Contract` (the `a` inside "contract") — so Rule 11 invariant 2 ("every anchor
 * resolves TODAY") would be satisfiable by a meaningless citation, and since the record stores only
 * the anchor STRING and never the matched heading, no consumer could ever re-audit it. A vacuous
 * resolution check would ratify the wrong contract into S-1.
 */
const MIN_SECTION_LOCATOR_LEN = 4;
const MIN_SYMBOL_LOCATOR_LEN = 3;

/**
 * High-confidence credential VALUE shapes. Deliberately narrow — only provider-prefixed or
 * PEM-armored forms whose false-positive rate is ~0. This complements the credential-shaped KEY
 * scan: a secret can arrive as a VALUE under an innocuous key, and the walk already inspects string
 * values for the mesh fence, so the traversal hook already existed.
 */
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  [/sk-[A-Za-z0-9]{16,}/, "openai-style secret key"],
  [/\bghp_[A-Za-z0-9]{16,}/, "GitHub personal access token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
]);

/** Depth cap + cycle fence for the record walk (a cyclic surplus value must not blow the stack). */
const MAX_SCAN_DEPTH = 8;

/** Typed rejection reasons — greppable, and stable for fixtures/tests. */
const REASON = Object.freeze({
  NOT_A_STRING: "anchor-not-a-non-empty-string",
  MESH_FENCE: "mesh-fence-kp-urn-in-anchor",
  BARE_LINE: "bare-line-number-anchor",
  NO_LOCATOR: "no-grep-stable-locator",
  EMPTY_LOCATOR: "empty-locator",
  EMPTY_PATH: "empty-path",
  ABSOLUTE_PATH: "absolute-path",
  TRAVERSAL: "path-traversal-segment",
  BACKSLASH: "non-posix-backslash-path",
  NUL_BYTE: "nul-byte-in-anchor",
  PATH_NOT_FOUND: "path-does-not-resolve",
  OUTSIDE_REPO: "path-escapes-repo-root",
  NOT_A_FILE: "path-is-not-a-file",
  FILE_TOO_LARGE: "file-exceeds-read-cap",
  SECTION_NOT_FOUND: "section-heading-not-found",
  SECTION_AMBIGUOUS: "section-heading-ambiguous",
  SYMBOL_NOT_FOUND: "symbol-not-found",
  READ_FAILED: "file-read-failed",
  LOCATOR_TOO_SHORT: "locator-too-short",
});

/**
 * THE symmetric anchor/heading normalizer. Used on BOTH the cited needle AND the candidate heading —
 * the asymmetry it replaces was a real defect: the heading side stripped `_` while the needle side
 * did not, so a heading normalized to `derivesfrom[] edge` while the needle kept `derives_from[] edge`
 * and `includes` failed. Consequence: ANY heading containing an underscore was uncitable, including
 * this stream's own central term (`### \`derives_from[]\` edge` in `specs/ontology/glossary.md`).
 * One function on both sides is the only way the two cannot drift again.
 */
function _normalizeAnchorText(s) {
  return String(s)
    .replace(/[*_`"'§]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function _isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function _isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively scan for forbidden KEYS (credential-shaped + prototype-pollution) and for the mesh
 * `kp://` fence in every string VALUE. Both are emit contract § 2 hygiene invariants.
 */
function _scanForbidden(value, pathStr, errors, depth, seen) {
  const d = depth === undefined ? 0 : depth;
  const s = seen || new WeakSet();
  if (typeof value === "string") {
    if (MESH_URN_RE.test(value))
      errors.push(
        `${pathStr}: mesh-fence violation — a \`kp://\` handle MUST NOT appear in the edge ` +
          `record (the readable accountability graph stays LOCAL; the mesh registry is a ` +
          `separate name-blind plane — emit contract § 3 point 2)`,
      );
    for (const [re, label] of CREDENTIAL_VALUE_PATTERNS)
      if (re.test(value))
        errors.push(
          `${pathStr}: credential-shaped VALUE forbidden (${label}) — a provenance edge is a ` +
            `durable record and MUST NOT carry secrets (security.md "no secrets in logs")`,
        );
    return;
  }
  if (value === null || typeof value !== "object") return;
  // Depth cap + cycle fence. Without them a cyclic or deeply-nested surplus value throws
  // RangeError out of the VALIDATOR, which the ledger's catch would then mislabel as a contract
  // violation ("the agent's citation is wrong") when it is an internal limit.
  if (d > MAX_SCAN_DEPTH) {
    errors.push(`${pathStr}: exceeds max scan depth ${MAX_SCAN_DEPTH} (record too deeply nested)`);
    return;
  }
  if (s.has(value)) {
    errors.push(`${pathStr}: cyclic reference forbidden (a durable record MUST be serializable)`);
    return;
  }
  s.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      _scanForbidden(value[i], `${pathStr}[${i}]`, errors, d + 1, s);
    return;
  }
  for (const k of Object.keys(value)) {
    if (PROTO_POLLUTION_KEYS.includes(k))
      errors.push(`${pathStr}.${JSON.stringify(k)}: prototype-pollution key forbidden`);
    if (CREDENTIAL_KEY_RE.test(k))
      errors.push(
        `${pathStr}.${JSON.stringify(k)}: credential-shaped key forbidden — a provenance edge is a durable ` +
          `record and MUST NOT carry secrets (security.md "no secrets in logs")`,
      );
    _scanForbidden(value[k], `${pathStr}.${k}`, errors, d + 1, s);
  }
}

/**
 * Classify an `anchor` against the grep-stable grammar. PURE (no I/O) — the SHAPE gate.
 * Accepts `<path>::<symbol>` (symbol anchor) or `<path>#<section>` (section anchor, `§` optional).
 * Rejects a bare line number, a `kp://` handle, an absolute path, and `..` traversal.
 *
 * @param {string} anchor
 * @returns {{ ok: true, kind: "symbol"|"section", path: string, locator: string }
 *          | { ok: false, reason: string, detail?: string }}
 */
function classifyAnchor(anchor) {
  if (!_isNonEmptyString(anchor) || anchor.trim().length === 0)
    return { ok: false, reason: REASON.NOT_A_STRING };
  if (anchor.includes("\0")) return { ok: false, reason: REASON.NUL_BYTE };
  // Mesh fence FIRST — a `kp://` anchor is rejected before any grammar interpretation, so a
  // crafted `kp://…::sym` can never reach the symbol branch.
  if (MESH_URN_RE.test(anchor)) return { ok: false, reason: REASON.MESH_FENCE };

  let kind;
  let rawPath;
  let locator;
  const symIdx = anchor.indexOf(SYMBOL_DELIM);
  const secIdx = anchor.indexOf(SECTION_DELIM);
  if (symIdx > 0 && (secIdx === -1 || symIdx < secIdx)) {
    kind = "symbol";
    rawPath = anchor.slice(0, symIdx);
    locator = anchor.slice(symIdx + SYMBOL_DELIM.length);
  } else if (secIdx > 0) {
    kind = "section";
    rawPath = anchor.slice(0, secIdx);
    locator = anchor.slice(secIdx + SECTION_DELIM.length);
  } else {
    // No grep-stable locator at all. A bare `<path>:<line>` is the specific BLOCKED shape
    // symbol-anchored-citations.md MUST-1 names, so report it as such rather than generically.
    return {
      ok: false,
      reason: BARE_LINE_LOCATOR_RE.test(anchor)
        ? REASON.BARE_LINE
        : REASON.NO_LOCATOR,
      detail: anchor,
    };
  }

  // A line number smuggled onto the path half (`foo.md:471#§S`) is still a bare-line anchor.
  if (BARE_LINE_LOCATOR_RE.test(rawPath))
    return { ok: false, reason: REASON.BARE_LINE, detail: rawPath };

  const cleanLocator = kind === "section" ? locator.replace(/^§\s*/, "").trim() : locator.trim();
  if (cleanLocator.length === 0)
    return { ok: false, reason: REASON.EMPTY_LOCATOR, detail: anchor };
  // A locator that is ONLY a line number is the bare-line shape wearing the grammar.
  if (kind === "symbol" && /^\d+(?:-\d+)?$/.test(cleanLocator))
    return { ok: false, reason: REASON.BARE_LINE, detail: anchor };

  // Floor the locator on its NORMALIZED length. A 1-3 char locator resolves against almost any
  // file by substring accident, which makes "the anchor resolves" a vacuous claim.
  const floor = kind === "section" ? MIN_SECTION_LOCATOR_LEN : MIN_SYMBOL_LOCATOR_LEN;
  if (_normalizeAnchorText(cleanLocator).length < floor)
    return {
      ok: false,
      reason: REASON.LOCATOR_TOO_SHORT,
      detail: `${JSON.stringify(cleanLocator)} (normalized length < ${floor})`,
    };

  const relPath = rawPath.trim();
  if (relPath.length === 0) return { ok: false, reason: REASON.EMPTY_PATH };
  if (relPath.includes("\\")) return { ok: false, reason: REASON.BACKSLASH, detail: relPath };
  if (relPath.startsWith("/")) return { ok: false, reason: REASON.ABSOLUTE_PATH, detail: relPath };
  if (relPath.split("/").includes(".."))
    return { ok: false, reason: REASON.TRAVERSAL, detail: relPath };

  return { ok: true, kind, path: relPath, locator: cleanLocator };
}

/**
 * Does the symbol appear as a standalone TOKEN (not as a substring of a longer identifier)?
 * Deliberately literal (no RegExp construction from caller data — a crafted anchor must never
 * become a pattern). `foo` MUST NOT resolve against `foobar`.
 *
 * SCOPE — this is a MENTION check over the WHOLE file, NOT a definition check. It is satisfied by
 * the token appearing anywhere: a definition, a call site, a comment, or ordinary prose. It
 * therefore proves the anchor is not a DEAD pointer; it does NOT prove the file DEFINES the symbol.
 * Stated explicitly per `zero-tolerance.md` Rule 3e — do not let a caller read "resolves" as
 * "declares".
 */
function _containsSymbolToken(haystack, symbol) {
  const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch);
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(symbol, from);
    if (i === -1) return false;
    const before = i === 0 ? "" : haystack[i - 1];
    const after = haystack[i + symbol.length] || "";
    const boundedLeft = before === "" || !isWordChar(before);
    const boundedRight = after === "" || !isWordChar(after);
    if (boundedLeft && boundedRight) return true;
    from = i + 1;
  }
}

/**
 * Find THE markdown heading a cited `§section` names. Both sides go through the SAME normalizer,
 * and the match is EXACT-or-PREFIX — never an unbounded `includes`, which let a needle match any
 * interior substring of any heading.
 *
 * Ambiguity is UNRESOLVED, not first-wins: when ≥2 headings satisfy the needle, the citation does
 * not identify a unique origin, and silently returning the first one would record a provenance edge
 * pointing at an arbitrary choice the reader cannot reproduce.
 *
 * @returns {{ ok: true, matched: string } | { ok: false, reason: string, detail?: string }}
 */
function _findSectionHeading(text, section) {
  const needle = _normalizeAnchorText(section);
  const matches = [];
  // FENCE STATE IS LOAD-BEARING — the THIRD vacuity channel. A `# ...` line inside a fenced code
  // block is a code COMMENT, not a markdown heading, and this rule corpus is full of them (the
  // DO/DO-NOT examples `cc-artifacts.md` Rule 3 mandates: `.claude/rules/security.md` alone has 12).
  // Without fence tracking, `security.md#§DO — route through the shared helper` "resolved" against a
  // comment inside a ```python block — while invariant 2 says each endpoint is a `§section` HEADING.
  // The length floor closed "too short" and exact-or-prefix+ambiguity closed "not unique"; this
  // closes "not a heading at all". It also SHRINKS the ambiguity surface: a phantom heading could
  // otherwise collide with a real one and make the real heading uncitable.
  let inFence = false;
  for (const line of text.split("\n")) {
    // Toggle on ``` / ~~~ (indented forms included — a fence inside a list item is still a fence).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!/^#{1,6}\s/.test(line)) continue;
    const heading = _normalizeAnchorText(line.replace(/^#{1,6}\s*/, ""));
    if (heading === needle || heading.startsWith(needle)) matches.push(line.trim());
  }
  if (matches.length === 0) return { ok: false, reason: REASON.SECTION_NOT_FOUND };
  if (matches.length > 1)
    return {
      ok: false,
      reason: REASON.SECTION_AMBIGUOUS,
      detail: `${matches.length} headings match: ${JSON.stringify(matches.slice(0, 3))}`,
    };
  return { ok: true, matched: matches[0] };
}

/**
 * Resolve an `anchor` against the CURRENT tree (emit contract § 2: "an anchor that … does not
 * resolve against the current tree is rejected"). Performs I/O.
 *
 * PATH CONTAINMENT per `rules/security.md` § "Path Containment": BOTH the candidate and the
 * boundary root are resolved through the SAME resolver (`fs.realpathSync`) before the comparison,
 * and a path that will not resolve FAILS CLOSED. Scoped necessary-but-not-sufficient: this closes
 * the lexical/symlink-escape class; it is NOT a TOCTOU defense (there is no exec/write sink here —
 * the resolved path is only READ to confirm the locator exists).
 *
 * @param {{ repoDir: string, anchor: string }} a
 * @returns {{ ok: true, kind: string, path: string, locator: string, matched: string }
 *          | { ok: false, reason: string, detail?: string }}
 */
function resolveAnchor(a) {
  const shape = classifyAnchor(a && a.anchor);
  if (!shape.ok) return shape;

  let root;
  try {
    root = fs.realpathSync(a.repoDir || process.cwd());
  } catch (e) {
    return { ok: false, reason: REASON.PATH_NOT_FOUND, detail: `repoDir: ${e.message}` };
  }

  let candidate;
  try {
    candidate = fs.realpathSync(path.resolve(root, shape.path));
  } catch {
    return { ok: false, reason: REASON.PATH_NOT_FOUND, detail: shape.path };
  }
  if (candidate !== root && !candidate.startsWith(root + path.sep))
    return { ok: false, reason: REASON.OUTSIDE_REPO, detail: shape.path };

  // Read via a FILE DESCRIPTOR, and gate size/regular-file on `fstat` of THAT SAME fd. A
  // stat-then-read pair is TOCTOU-bypassable: the size gate would pass on the stat'd object while
  // `readFileSync(path)` opens whatever occupies the path afterwards. That is not merely a stale
  // size — a FIFO swapped into the window makes a blocking read HANG FOREVER, and because a
  // never-returning call never reaches the ledger's catch, the documented "fail-OPEN, never blocks
  // /codify" guarantee would NOT hold. O_NONBLOCK makes a FIFO open return instead of blocking;
  // O_NOFOLLOW refuses a symlink swapped onto the final component (both `|| 0`-guarded so a
  // platform lacking them degrades rather than NaN-poisoning the bitmask — the F53 idiom in
  // `state-io.js`). Binding the gate to the fd is what closes the window: the bytes measured are
  // the bytes read.
  const cache = a.cache instanceof Map ? a.cache : null;
  let text = cache ? cache.get(candidate) : undefined;
  if (text === undefined) {
    let fd;
    try {
      fd = fs.openSync(
        candidate,
        fs.constants.O_RDONLY |
          (fs.constants.O_NOFOLLOW || 0) |
          (fs.constants.O_NONBLOCK || 0),
      );
    } catch (e) {
      return { ok: false, reason: REASON.READ_FAILED, detail: e.message };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: REASON.NOT_A_FILE, detail: shape.path };
      if (st.size > MAX_ANCHOR_FILE_BYTES)
        return { ok: false, reason: REASON.FILE_TOO_LARGE, detail: `${st.size}B` };
      text = fs.readFileSync(fd, "utf8");
    } catch (e) {
      return { ok: false, reason: REASON.READ_FAILED, detail: e.message };
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // The fd is being discarded on every path out of this block; a failed close cannot be
        // acted on and must not mask the resolution result the caller needs.
      }
    }
    if (cache) cache.set(candidate, text);
  }

  if (shape.kind === "section") {
    const hit = _findSectionHeading(text, shape.locator);
    if (!hit.ok) return { ok: false, reason: hit.reason, detail: hit.detail || shape.locator };
    return { ok: true, kind: shape.kind, path: shape.path, locator: shape.locator, matched: hit.matched };
  }
  if (!_containsSymbolToken(text, shape.locator))
    return { ok: false, reason: REASON.SYMBOL_NOT_FOUND, detail: shape.locator };
  return { ok: true, kind: shape.kind, path: shape.path, locator: shape.locator, matched: shape.locator };
}

/**
 * Validate ONE DerivationSource against the v0 contract. PURE (shape only — tree resolution is
 * `validateEdgeAnchorsResolve`).
 */
function _validateDerivationSource(src, pathStr, errors) {
  if (!_isPlainObject(src)) {
    errors.push(`${pathStr}: each derives_from entry MUST be a plain object`);
    return;
  }
  const shape = classifyAnchor(src.anchor);
  if (!shape.ok)
    errors.push(
      `${pathStr}.anchor: MUST be a grep-stable anchor — \`<path>::<symbol>\` or ` +
        `\`<path>#§<section>\`, NEVER a bare line number, NEVER a \`kp://\` handle ` +
        `(rejected: ${shape.reason}${shape.detail ? ` — ${JSON.stringify(shape.detail)}` : ""})`,
    );
  if (!ANCHOR_KINDS.includes(src.anchor_kind))
    errors.push(
      `${pathStr}.anchor_kind MUST be one of ${JSON.stringify(ANCHOR_KINDS)} ` +
        `(got ${JSON.stringify(src.anchor_kind)})`,
    );
  if (src.relation !== undefined && !RELATIONS.includes(src.relation))
    errors.push(
      `${pathStr}.relation, when present, MUST be one of ${JSON.stringify(RELATIONS)} ` +
        `(got ${JSON.stringify(src.relation)}); omit it to default to "${DEFAULT_RELATION}"`,
    );
  for (const k of Object.keys(src))
    if (!DERIVATION_SOURCE_KEYS.includes(k))
      errors.push(
        `${pathStr}: unexpected key ${JSON.stringify(k)} (closed DerivationSource shape)`,
      );
}

/**
 * Validate a DerivesFromEdge against the PROPOSED (v0) contract. PURE — no I/O, so it is safe to
 * call from any layer. Anchor TREE-resolution is the separate `validateEdgeAnchorsResolve`.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateDerivesFromEdge(edge) {
  const errors = [];
  if (!_isPlainObject(edge))
    return { ok: false, errors: ["edge MUST be a plain object"] };

  if (edge.derives_from_schema_version !== DERIVES_FROM_SCHEMA_VERSION)
    errors.push(
      `derives_from_schema_version MUST be ${DERIVES_FROM_SCHEMA_VERSION} ` +
        `(proposed/pending-S1) (got ${JSON.stringify(edge.derives_from_schema_version)})`,
    );
  if (edge.record_type !== RECORD_TYPE)
    errors.push(`record_type MUST be "${RECORD_TYPE}" (got ${JSON.stringify(edge.record_type)})`);
  if (!ARTIFACT_TYPES.includes(edge.artifact_type))
    errors.push(
      `artifact_type MUST be one of ${JSON.stringify(ARTIFACT_TYPES)} ` +
        `(got ${JSON.stringify(edge.artifact_type)})`,
    );
  if (!_isNonEmptyString(edge.artifact_id))
    errors.push("artifact_id MUST be a non-empty string (the generated Entity identity)");

  // `derives_from: []` is the FIRST-CLASS ORPHAN SIGNAL the reverse-index sweep reads (emit
  // contract § 2; design § 1.6 AC 2). It MUST be present and MUST be an array — an EMPTY array
  // is valid and is never omitted, never dropped.
  if (!Array.isArray(edge.derives_from))
    errors.push(
      "derives_from MUST be an array (an EMPTY array is the first-class orphan signal and is " +
        "never omitted)",
    );
  else {
    // The array MUST be a plain Array, not a subclass. An `Array` subclass carrying a prototype
    // `toJSON` serializes bytes this validator never inspected — the record on disk would differ
    // from the record that was checked, defeating byte-checkability AND every fence above (a
    // subclass `toJSON` was able to substitute a `kp://` handle past the mesh fence).
    if (Object.getPrototypeOf(edge.derives_from) !== Array.prototype)
      errors.push(
        "derives_from MUST be a plain Array (an Array subclass can override toJSON and serialize " +
          "bytes the validator never saw)",
      );
    if (edge.derives_from.length > MAX_DERIVES_FROM)
      errors.push(
        `derives_from MUST carry at most ${MAX_DERIVES_FROM} sources ` +
          `(got ${edge.derives_from.length}); each costs one file read at emit time`,
      );
    edge.derives_from.forEach((src, i) =>
      _validateDerivationSource(src, `derives_from[${i}]`, errors),
    );
  }

  if (edge.activity !== ACTIVITY)
    errors.push(`activity MUST be "${ACTIVITY}" (got ${JSON.stringify(edge.activity)})`);
  if (!_isNonEmptyString(edge.session_id))
    errors.push("session_id MUST be a non-empty string");
  if (!_isNonEmptyString(edge.timestamp) || !ISO_8601_RE.test(edge.timestamp))
    errors.push("timestamp MUST be an ISO-8601 string");
  if (edge.producer !== PRODUCER)
    errors.push(`producer MUST be "${PRODUCER}" (got ${JSON.stringify(edge.producer)})`);

  _scanForbidden(edge, "edge", errors);

  for (const k of Object.keys(edge))
    if (!EDGE_KEYS.includes(k))
      errors.push(`unexpected top-level key ${JSON.stringify(k)} (closed edge shape)`);

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve EVERY anchor in an edge against the current tree. Performs I/O; separated from
 * `validateDerivesFromEdge` so the shape gate stays pure.
 * @param {{ repoDir: string, edge: object }} a
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateEdgeAnchorsResolve(a) {
  const errors = [];
  const edge = a && a.edge;
  if (!_isPlainObject(edge) || !Array.isArray(edge.derives_from))
    return { ok: false, errors: ["edge MUST be a plain object carrying a derives_from array"] };
  // One read cache per resolution pass: N anchors into the same file (the common case — several
  // sections of one spec) cost one read, not N. Pass-scoped, never process-global, so a file edited
  // between two /codify emissions is re-read rather than served stale.
  const cache = new Map();
  edge.derives_from.forEach((src, i) => {
    const r = resolveAnchor({ repoDir: a.repoDir, anchor: src && src.anchor, cache });
    if (!r.ok)
      errors.push(
        `derives_from[${i}].anchor does not resolve against the current tree: ${r.reason}` +
          `${r.detail ? ` — ${JSON.stringify(r.detail)}` : ""} ` +
          `(anchor ${JSON.stringify(src && src.anchor)})`,
      );
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Build a canonical DerivesFromEdge. THROWS on invalid input (fail-loud — a malformed edge must
 * never reach the sink). Time-source-agnostic (caller supplies `timestamp`) so it stays
 * deterministic + testable. SHAPE-only: tree resolution is the caller's separate step, so this
 * function is I/O-free and usable where the tree is not available.
 *
 * @param {object} a
 * @param {string} a.artifactType  one of ARTIFACT_TYPES
 * @param {string} a.artifactId    the generated Entity identity (agent/skill name, rule id, hook name)
 * @param {Array}  a.derivesFrom   DerivationSource[] — MAY be empty (`[]` = the orphan signal)
 * @param {string} a.sessionId     session id
 * @param {string} a.timestamp     ISO-8601
 * @returns {Readonly<object>}
 */
function buildDerivesFromEdge(a) {
  if (!_isPlainObject(a)) {
    const e = new TypeError("buildDerivesFromEdge: args MUST be a plain object");
    e.contract_violation = true;
    throw e;
  }
  const edge = {
    derives_from_schema_version: DERIVES_FROM_SCHEMA_VERSION,
    record_type: RECORD_TYPE,
    artifact_type: a.artifactType,
    artifact_id: a.artifactId,
    // Normalize to a plain array of plain objects WITHOUT adding keys: `relation` stays absent
    // when the caller omitted it (light-PROV single-relation default), so the emitted record
    // matches the v0 shape byte-for-byte rather than materializing an implied default.
    // `Array.from` strips the ARRAY SPECIES. Both `.map` AND `Array.prototype.slice` are
    // species-preserving (they route through ArraySpeciesCreate, so `slice.call(subclassInstance)`
    // returns the SUBCLASS — verified, not assumed), which would let an `Array` subclass survive
    // into the record and serialize bytes the validator never inspected via a prototype `toJSON`.
    // `Array.from` and spread are the only copies that always yield a plain Array; the validator
    // additionally asserts the prototype, so this is belt-and-braces.
    derives_from: Array.isArray(a.derivesFrom)
      ? Array.from(a.derivesFrom).map((s) => {
          if (!_isPlainObject(s)) return s;
          const out = { anchor: s.anchor, anchor_kind: s.anchor_kind };
          if (s.relation !== undefined) out.relation = s.relation;
          for (const k of Object.keys(s)) {
            if (DERIVATION_SOURCE_KEYS.includes(k)) continue;
            // Surplus keys are CARRIED so the closed-shape + forbidden-key checks below SEE and
            // reject them. `defineProperty` (not `out[k] = …`) is load-bearing: a plain assignment
            // to `__proto__` invokes the Object.prototype SETTER — it mutates the prototype instead
            // of creating an own property, so the key would vanish from `Object.keys` and slip past
            // the prototype-pollution scan silently. `defineProperty` always creates an own
            // property, keeping the rejection fail-loud (and never re-parenting `out`).
            Object.defineProperty(out, k, {
              value: s[k],
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          return out;
        })
      : a.derivesFrom,
    activity: ACTIVITY,
    session_id: a.sessionId,
    timestamp: a.timestamp,
    producer: PRODUCER,
  };
  const { ok, errors } = validateDerivesFromEdge(edge);
  if (!ok) {
    // Tagged so the ledger can distinguish a CONTRACT violation (the caller's citation is wrong)
    // from an INTERNAL fault (a bug or limit here) — mislabelling the latter as the former sends
    // the reader to audit a citation that was fine.
    const e = new Error(`buildDerivesFromEdge: invalid edge:\n  - ${errors.join("\n  - ")}`);
    e.contract_violation = true;
    throw e;
  }
  Object.freeze(edge.derives_from);
  edge.derives_from.forEach((s) => Object.freeze(s));
  return Object.freeze(edge);
}

/**
 * The self-describing contract descriptor — what a consumer (kailash-rs S-1, #1951) reads to
 * learn the PROPOSED field shape + ratification status WITHOUT importing loom code. Machine-
 * readable half of the emit-contract proposal (§ 2 "Core fields vs envelope").
 */
function contractDescriptor() {
  return Object.freeze({
    record_type: RECORD_TYPE,
    derives_from_schema_version: DERIVES_FROM_SCHEMA_VERSION,
    pending_s1_ratification: PENDING_S1_RATIFICATION,
    producer: PRODUCER,
    consumer: "kailash-rs S-1 (#1951, local DataFlow accountability store) — NOT YET BUILT",
    activity: ACTIVITY,
    core_fields: ["artifact_type", "artifact_id", "derives_from"],
    envelope_fields: [
      "derives_from_schema_version",
      "record_type",
      "activity",
      "session_id",
      "timestamp",
      "producer",
    ],
    artifact_types: ARTIFACT_TYPES.slice(),
    anchor_kinds: ANCHOR_KINDS.slice(),
    relations: RELATIONS.slice(),
    default_relation: DEFAULT_RELATION,
    derivation_source_fields: DERIVATION_SOURCE_KEYS.slice(),
    empty_derives_from_is_orphan_signal: true,
  });
}

module.exports = {
  DERIVES_FROM_SCHEMA_VERSION,
  PENDING_S1_RATIFICATION,
  ARTIFACT_TYPES,
  ANCHOR_KINDS,
  RELATIONS,
  DEFAULT_RELATION,
  ACTIVITY,
  PRODUCER,
  RECORD_TYPE,
  EDGE_KEYS,
  DERIVATION_SOURCE_KEYS,
  REASON,
  CREDENTIAL_KEY_RE, // exported for the cross-stream fence test (see the constant's comment)
  MAX_DERIVES_FROM,
  MIN_SECTION_LOCATOR_LEN,
  MIN_SYMBOL_LOCATOR_LEN,
  classifyAnchor,
  resolveAnchor,
  validateDerivesFromEdge,
  validateEdgeAnchorsResolve,
  buildDerivesFromEdge,
  contractDescriptor,
};
