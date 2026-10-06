/*
 * Slot parser + overlay composition — shared across emit.mjs and compose.mjs.
 *
 * Canonical implementation of spec v6 §3.1. Moved here from the gitignored
 * workspaces/multi-cli-coc/fixtures/slot-markers/emitter.mjs PoC to remove
 * the "PoC emitter.mjs import" trap and the duplication between emit.mjs
 * (Phase E4) and compose.mjs (Phase F2).
 *
 * Exports:
 *   parseSlotsV5(body)            → Map<slotName, slotBody>
 *   applyOverlay(globalSrc, overlaySrc) → { composed, warnings[] }
 */

// ────────────────────────────────────────────────────────────────
// THE ONE SLOT-MARKER PREDICATE, AND THE ONE FENCE MACHINE (loom#2208).
//
// WHY THIS LIVES HERE AND IS EXPORTED. "Is this line a real slot marker?" is
// asked by TWO surfaces: this parser (which must NOT treat an in-fence marker as
// a slot, or an overlay would overwrite a rule's own documentation of the
// mechanism) and the emitter's strip stage (which must NOT delete one from the
// output). Both used to answer it with their OWN regex, and only one of them was
// block-aware — so the parser skipped an in-fence marker while the strip stage
// deleted it, and shipped rules lost the markers that delimit their own examples.
// Two surfaces, one question, ONE predicate: they cannot disagree now.
export const SLOT_OPEN_RE = /^<!--\s*slot:([a-z][a-z0-9-]*)\s*-->\s*$/;
export const SLOT_CLOSE_RE = /^<!--\s*\/slot:([a-z][a-z0-9-]*)\s*-->\s*$/;
export function isSlotMarkerLine(line) {
  return SLOT_OPEN_RE.test(line) || SLOT_CLOSE_RE.test(line);
}

/**
 * ONE step of the fence state machine. Returns the state AFTER `line`; the
 * transition is the parser's own (`^(\`\`\`+|~~~+)` opener, closer requires the same
 * character, at least as many, and nothing but whitespace after it).
 */
export function fenceStep(state, line) {
  const m = line.match(/^(```+|~~~+)/);
  if (!m) return state;
  const tok = m[1];
  if (!state.open) return { open: true, ch: tok[0], len: tok.length };
  if (tok[0] === state.ch && tok.length >= state.len && line.slice(tok.length).trim() === "") {
    return { open: false, ch: null, len: 0 };
  }
  return state;
}

// ────────────────────────────────────────────────────────────────
// parseSlotsV5 — v6 §3.1 slot parser
//   Extracts slot body content keyed by slot name. Skips markers
//   inside fenced code blocks, HTML raw blocks (script/style/pre/
//   textarea), HTML block comments, and indented code blocks.
// ────────────────────────────────────────────────────────────────

/**
 * THE ONE BLOCK CLASSIFIER (loom#2208). Two surfaces ask "is this line inside a
 * block that owns its own bytes?": `parseSlotsV5`, so it does not treat an
 * illustrative marker as a slot an overlay may replace, and the emitter's strip
 * stage, so it does not DELETE one from the output. They used to answer it with
 * two models — the parser's (fenced, indented, HTML raw, HTML comment) and the
 * strip's (fences only, and before that nothing at all) — and only one of them was
 * the parser's contract. A second model is a second answer waiting to drift, so
 * this is the parser's model EXTRACTED, and `parseSlotsV5` now consumes it too.
 *
 * Each entry carries ONE PER-LINE RESULT, `kind`, with three MUTUALLY EXCLUSIVE values:
 *
 *   kind: "content"  — the line belongs to a block that owns its bytes: PRESERVE it.
 *   kind: "marker"   — the line reached the marker branch AND is a slot marker: DROP it.
 *   kind: "ordinary" — it reached the marker branch and is not a marker.
 *
 * ONE COMPUTATION, ONE FIELD, TWO CONSUMERS. The regression this replaced was TWO READS of
 * one line that merely happened to agree; a pair of booleans can be set to disagree by a
 * later edit, so exclusivity lives in the SHAPE here rather than in the control flow that
 * writes it. Consumers ask `isContent` / `isMarker`.
 *
 * Diagnostics — NEVER for decisions:
 *   entering:   the state the line entered with (see the note on `isContent`).
 *   consumedBy: which block branch claimed it, or null.
 *   isBlank:    the line is empty/whitespace (the indented-block rule reads it).
 */
export function scanBlockStates(lines) {
  const states = [];
  let inFencedBlock = false;
  let fenceChar = null;
  let fenceLen = 0;
  let inIndentedBlock = false;
  let inHtmlRaw = false;
  let htmlRawTag = null;
  let inHtmlComment = false;
  let previousLineBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlank = line.trim() === "";
    const entering = {
      fence: inFencedBlock,
      indented: inIndentedBlock,
      htmlRaw: inHtmlRaw,
      htmlComment: inHtmlComment,
    };
    let consumedBy = null;
    // THE ONE PER-LINE RESULT, written exactly once below. "content" until the MARKER
    // BRANCH proves otherwise — and that branch tests the state AFTER the block branches
    // ran, NOT the state this line ENTERED with. That distinction is the whole of the
    // loom#2208 FOLLOW-UP REGRESSION: on a line following an indented block, the indented
    // branch's `else` clears `inIndentedBlock` in THIS SAME iteration, so the line DOES
    // reach the marker branch and the BASE parser reads it as a real slot. Classifying from
    // the ENTERING snapshot called that line "block content" and skipped it, which threw
    // `slot close mismatch: 'x' != 'null'` at the matching close. MEASURED against the base
    // parser: 7 of 69 constructed shapes diverged, every one of this shape; over 1321 corpus
    // `.md` files, 0 diverged BOTH with the regression live and with it fixed — the corpus
    // cannot be the instrument for this question.
    let kind = "content";

    // ── The four block branches below are SEPARATE, each guarded and each
    // setting `consumedBy`, mirroring `parseSlotsV5`'s original chain of
    // `if` blocks with `continue`s IN ORDER. They are deliberately NOT an
    // `else if` chain: in the original a branch whose guard passes but whose
    // INNER condition fails FALLS THROUGH to the later branches (a `<!--` line
    // that opens no raw block still reaches the comment branch), and an
    // `else if` chain would swallow it. MEASURED: the first draft of this
    // extraction was an `else if` chain, deleted the marker out of an HTML
    // comment, and the 1194-file parse differential did NOT catch it because no
    // corpus file exercises that path — the fixture did.
    const fenceMatch =
      !inHtmlRaw && !inIndentedBlock && !inHtmlComment
        ? line.match(/^(```+|~~~+)/)
        : null;
    if (consumedBy === null && fenceMatch) {
      const next = fenceStep({ open: inFencedBlock, ch: fenceChar, len: fenceLen }, line);
      inFencedBlock = next.open;
      fenceChar = next.ch;
      fenceLen = next.len;
      consumedBy = "fence";
      previousLineBlank = false;
    }

    if (consumedBy === null && !inFencedBlock && !inIndentedBlock && !inHtmlComment) {
      if (!inHtmlRaw) {
        const open = line.match(/^<(script|style|pre|textarea)[\s>]/i);
        if (open) {
          inHtmlRaw = true;
          htmlRawTag = open[1].toLowerCase();
          consumedBy = "htmlRaw";
          previousLineBlank = false;
        }
      } else {
        const close = new RegExp(`</${htmlRawTag}>`, "i");
        if (close.test(line)) {
          inHtmlRaw = false;
          htmlRawTag = null;
        }
        consumedBy = "htmlRaw";
        previousLineBlank = false;
      }
    }

    if (consumedBy === null && !inFencedBlock && !inIndentedBlock && !inHtmlRaw) {
      const looksLikeComment = line.startsWith("<!--");
      const isSlotMarker = isSlotMarkerLine(line);
      if (!inHtmlComment && looksLikeComment && !isSlotMarker) {
        inHtmlComment = true;
        if (line.includes("-->")) inHtmlComment = false;
        consumedBy = "htmlComment";
        previousLineBlank = false;
      } else if (inHtmlComment) {
        if (line.includes("-->")) inHtmlComment = false;
        consumedBy = "htmlComment";
        previousLineBlank = false;
      }
    }

    if (consumedBy === null && !inFencedBlock && !inHtmlRaw && !inHtmlComment) {
      const indented = /^ {4,}/.test(line);
      if (indented && (previousLineBlank || inIndentedBlock)) {
        inIndentedBlock = true;
        consumedBy = "indented";
        previousLineBlank = false;
      } else if (!indented) {
        inIndentedBlock = false;
      }
    }

    if (
      consumedBy === null &&
      !inFencedBlock &&
      !inIndentedBlock &&
      !inHtmlRaw &&
      !inHtmlComment
    ) {
      // THE MARKER BRANCH: reaching it is what makes a line NOT block content — and what
      // makes a matching line a slot line. A marker line also resets `previousLineBlank`
      // for the indented rule, which is why that decision lives here rather than being
      // recomputed by a caller.
      if (isSlotMarkerLine(line)) {
        kind = "marker";
        previousLineBlank = true;
      } else {
        kind = "ordinary";
        previousLineBlank = isBlank;
      }
    }

    states.push({ kind, entering, consumedBy, isBlank });
  }
  return states;
}

/**
 * THE TWO QUESTIONS A CONSUMER MAY ASK, BOTH ANSWERED FROM ONE FIELD.
 *
 * `kind` is a SINGLE value, so these are MUTUALLY EXCLUSIVE BY SHAPE — no line can be both
 * content and a marker, and no future edit can make it so without changing the value's
 * type. That is the entire reason this is not a pair of booleans: the shipped regression WAS
 * two reads of one line that happened to agree, and agreeing by convention is one branch
 * away from disagreeing again.
 *
 * NEVER derive either answer from `st.entering`. That snapshot is diagnostic: the first
 * revision of this extraction classified from the state the line ENTERED with, which is a
 * DIFFERENT question from "did this line reach the marker branch" — the question the base
 * parser decides. They disagree exactly where a block-resetting branch fires in the same
 * iteration as the marker branch, and that disagreement shipped as a regression.
 */
export function isContent(st) {
  return st.kind === "content";
}

export function isMarker(st) {
  return st.kind === "marker";
}

// ────────────────────────────────────────────────────────────────
// parseSlotsV5 — v6 §3.1 slot parser
//   Extracts slot body content keyed by slot name. Skips markers
//   inside fenced code blocks, HTML raw blocks (script/style/pre/
//   textarea), HTML block comments, and indented code blocks.
//   The block model is `scanBlockStates`'s — ONE classifier, shared
//   with the emitter's strip stage (loom#2208).
// ────────────────────────────────────────────────────────────────

export function parseSlotsV5(body) {
  const lines = body.split("\n");
  const states = scanBlockStates(lines);

  const slots = new Map();
  let currentSlot = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const st = states[i];

    if (isContent(st)) {
      if (currentSlot) currentLines.push(line);
      continue;
    }
    if (isMarker(st)) {
      const openMatch = line.match(SLOT_OPEN_RE);
      const closeMatch = line.match(SLOT_CLOSE_RE);
      if (openMatch) {
        if (currentSlot)
          throw new Error(
            `nested slot open '${openMatch[1]}' inside '${currentSlot}' at line ${i + 1}`,
          );
        currentSlot = openMatch[1];
        currentLines = [];
        continue;
      }
      if (closeMatch) {
        if (currentSlot !== closeMatch[1])
          throw new Error(
            `slot close mismatch: '${closeMatch[1]}' != '${currentSlot}' at line ${i + 1}`,
          );
        slots.set(currentSlot, currentLines.join("\n"));
        currentSlot = null;
        currentLines = [];
        continue;
      }
    }
    if (currentSlot) currentLines.push(line);
  }

  // Unclosed slot at EOF is a spec violation — surface it instead of
  // silently dropping the half-parsed content.
  if (currentSlot !== null) {
    throw new Error(`unclosed slot '${currentSlot}' at end of file`);
  }

  return slots;
}
// ────────────────────────────────────────────────────────────────
// applyOverlay — v6 §3.1
//   Overlay files contain ONLY slot-keyed replacement bodies. For
//   each slot name that exists in BOTH overlay and global, replace
//   the global's slot body with the overlay's. Slots in overlay
//   but not in global are WARN (spec violation per v6 §3).
// ────────────────────────────────────────────────────────────────

export function applyOverlay(globalSrc, overlaySrc) {
  const overlaySlots = parseSlotsV5(overlaySrc);
  const globalSlots = parseSlotsV5(globalSrc);
  let out = globalSrc;
  const warnings = [];

  for (const [name, content] of overlaySlots) {
    // Defense-in-depth: re-validate the slot name against the v6 §3.1
    // grammar before constructing a regex. parseSlotsV5 already enforces
    // this at parse time, but future callers that pass raw content here
    // inherit the escaping safety net.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `invalid slot name '${name}' — must match /^[a-z][a-z0-9-]*$/`,
      );
    }
    if (!globalSlots.has(name)) {
      // Canonical whole-body slot. `neutral-body` is the slot-only
      // spelling of full-body replacement (variant-authoring.md MUST-1):
      // a proper slot-only variant wraps its entire override in
      // `slot:neutral-body`. When the global carries NO slot markers at
      // all, its whole body IS the implicit neutral-body, so the
      // overlay's neutral-body replaces it outright — the documented
      // Replacement semantic (artifact-flow.md § Variant Overlay
      // Semantics), identical to the full-file overlay path
      // (emit.mjs:291 `composed = overlay`). Without this branch the
      // RECOMMENDED slot-only form silently regresses to the generic
      // global while the legacy full-file form works — issue #290.
      if (name === "neutral-body" && globalSlots.size === 0) {
        out = content;
        continue;
      }
      warnings.push(
        `overlay introduces slot '${name}' not in global (v6 §3 violation)`,
      );
      continue;
    }
    // nameEsc is defensive — given the grammar check above, `name` can
    // only contain [a-z0-9-]. Kept for symmetry with other escape sites.
    const nameEsc = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const pattern = new RegExp(
      `(<!--\\s*slot:${nameEsc}\\s*-->\\n?)[\\s\\S]*?(<!--\\s*/slot:${nameEsc}\\s*-->)`,
    );
    out = out.replace(
      pattern,
      (_, open, close) => `${open}\n${content}\n${close}`,
    );
  }

  return { composed: out, warnings };
}
