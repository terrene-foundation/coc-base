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
// parseSlotsV5 — v6 §3.1 slot parser
//   Extracts slot body content keyed by slot name. Skips markers
//   inside fenced code blocks, HTML raw blocks (script/style/pre/
//   textarea), HTML block comments, and indented code blocks.
// ────────────────────────────────────────────────────────────────

export function parseSlotsV5(body) {
  const lines = body.split("\n");
  let inFencedBlock = false;
  let fenceChar = null;
  let fenceLen = 0;
  let inIndentedBlock = false;
  let inHtmlRaw = false;
  let htmlRawTag = null;
  let inHtmlComment = false;
  let previousLineBlank = true;

  const slots = new Map();
  let currentSlot = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlank = line.trim() === "";

    const fenceMatch =
      !inHtmlRaw && !inIndentedBlock && !inHtmlComment
        ? line.match(/^(```+|~~~+)/)
        : null;
    if (fenceMatch) {
      const m = fenceMatch[1];
      if (!inFencedBlock) {
        inFencedBlock = true;
        fenceChar = m[0];
        fenceLen = m.length;
      } else if (
        m[0] === fenceChar &&
        m.length >= fenceLen &&
        line.slice(m.length).trim() === ""
      ) {
        inFencedBlock = false;
        fenceChar = null;
        fenceLen = 0;
      }
      if (currentSlot) currentLines.push(line);
      previousLineBlank = false;
      continue;
    }

    if (!inFencedBlock && !inIndentedBlock && !inHtmlComment) {
      if (!inHtmlRaw) {
        const open = line.match(/^<(script|style|pre|textarea)[\s>]/i);
        if (open) {
          inHtmlRaw = true;
          htmlRawTag = open[1].toLowerCase();
          if (currentSlot) currentLines.push(line);
          previousLineBlank = false;
          continue;
        }
      } else {
        const close = new RegExp(`</${htmlRawTag}>`, "i");
        if (close.test(line)) {
          inHtmlRaw = false;
          htmlRawTag = null;
        }
        if (currentSlot) currentLines.push(line);
        previousLineBlank = false;
        continue;
      }
    }

    if (!inFencedBlock && !inIndentedBlock && !inHtmlRaw) {
      const looksLikeComment = line.startsWith("<!--");
      const isSlotMarker = /^<!--\s*\/?slot:/.test(line);
      if (!inHtmlComment && looksLikeComment && !isSlotMarker) {
        inHtmlComment = true;
        if (currentSlot) currentLines.push(line);
        if (line.includes("-->")) inHtmlComment = false;
        previousLineBlank = false;
        continue;
      }
      if (inHtmlComment) {
        if (line.includes("-->")) inHtmlComment = false;
        if (currentSlot) currentLines.push(line);
        previousLineBlank = false;
        continue;
      }
    }

    if (!inFencedBlock && !inHtmlRaw && !inHtmlComment) {
      const indented = /^ {4,}/.test(line);
      if (indented && (previousLineBlank || inIndentedBlock)) {
        inIndentedBlock = true;
        if (currentSlot) currentLines.push(line);
        previousLineBlank = false;
        continue;
      }
      if (!indented) inIndentedBlock = false;
    }

    if (!inFencedBlock && !inIndentedBlock && !inHtmlRaw && !inHtmlComment) {
      const openMatch = line.match(/^<!--\s*slot:([a-z][a-z0-9-]*)\s*-->\s*$/);
      const closeMatch = line.match(
        /^<!--\s*\/slot:([a-z][a-z0-9-]*)\s*-->\s*$/,
      );
      if (openMatch) {
        if (currentSlot)
          throw new Error(
            `nested slot open '${openMatch[1]}' inside '${currentSlot}' at line ${i + 1}`,
          );
        currentSlot = openMatch[1];
        currentLines = [];
        previousLineBlank = true;
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
        previousLineBlank = true;
        continue;
      }
    }

    if (currentSlot) currentLines.push(line);
    previousLineBlank = isBlank;
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
