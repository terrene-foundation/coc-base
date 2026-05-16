#!/usr/bin/env node
/*
 * Multi-CLI Emitter — Phase E4 (spec v6 §2.2 + §3.1 + §4.4)
 *
 * Driver that composes source rules with CLI-specific slot overlays,
 * runs v6 abridgement_protocol, enforces per-rule + total cap budgets,
 * and emits the per-CLI baseline context file (AGENTS.md for codex,
 * GEMINI.md for gemini).
 *
 * Also: populates `.codex-mcp-guard/` POLICIES table via extract-policies.mjs
 * (Phase E6) and flips POLICIES_POPULATED=false → true when bijection
 * holds against the extractor's output.
 *
 * Usage:
 *   node .claude/bin/emit.mjs --cli codex --out /tmp/emit-codex
 *   node .claude/bin/emit.mjs --cli gemini --out /tmp/emit-gemini
 *   node .claude/bin/emit.mjs --all --out /tmp/emit-all    (both CLIs)
 *   node .claude/bin/emit.mjs --dry-run                    (default out)
 *
 * Exit codes: 0 = pass; 1 = budget/validator failure; 2 = usage error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Symlink-safe write. Node's fs.writeFileSync follows symlinks by
// default, so a TOCTOU attacker can plant a symlink between mkdirSync
// and writeFileSync and redirect the write. O_NOFOLLOW refuses to open
// a symlink target, closing the window. Used for emission outputs where
// we specifically want to fail-closed on symlink presence.
function safeWriteFileSync(filePath, data) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

import { parseSlotsV5, applyOverlay } from "./lib/slot-parser.mjs";
import { resolveOverlay } from "./lib/variant-overlay.mjs";
import { extractPolicies } from "../codex-mcp-guard/extract-policies.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

// ────────────────────────────────────────────────────────────────
// v6 abridgement protocol (extends v5 with M-1: "BLOCKED responses:")
// ────────────────────────────────────────────────────────────────
// Strip sections:
//   - Origin: lines (and continuation paragraphs)
//   - Evidence / Verified / Measured H3+ sub-sections
//   - BLOCKED rationalizations: enumerated bullet lists
//   - BLOCKED responses: enumerated bullet lists           [v6 M-1]
//   - Heading-depth level 4 and deeper
// Strip patterns:
//   - Fenced code blocks that are NOT DO / DO NOT examples
//   - Markdown tables beyond 3 data rows (keep header + first 3)
// Preserve:
//   - MUST / MUST NOT clauses in full
//   - **Why:** lines in full (first 2 sentences)
//   - DO / DO NOT example blocks under 200 bytes each
//   - Tables whose full-rendered size is under 1000 bytes
export function abridgeV6(raw) {
  const lines = raw.split("\n");
  const out = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // H4+ headings → strip entire subsection until next <= H3
    const hMatch = line.match(/^(#{1,6})\s/);
    if (hMatch && hMatch[1].length >= 4) {
      i++;
      while (i < lines.length) {
        const n = lines[i].match(/^(#{1,6})\s/);
        if (n && n[1].length <= 3) break;
        if (n && n[1].length >= hMatch[1].length) break;
        i++;
      }
      continue;
    }

    // Origin: line or Origin paragraph — strip until blank
    if (/^Origin:/i.test(trimmed) || /^\*\*Origin:/i.test(trimmed)) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    // Evidence / Verified / Measured H3 sub-sections
    if (
      hMatch &&
      hMatch[1].length === 3 &&
      /^(#+)\s+(Evidence|Verified|Measured)/i.test(line)
    ) {
      i++;
      while (i < lines.length && !/^(#{1,3})\s/.test(lines[i])) i++;
      continue;
    }

    // BLOCKED rationalizations / BLOCKED responses — strip header + bullets
    // [v6 M-1: added "BLOCKED responses:" to v5's "BLOCKED rationalizations:"]
    if (/^\*\*BLOCKED (rationalizations|responses):\*\*/.test(trimmed)) {
      i++;
      if (i < lines.length && lines[i].trim() === "") i++;
      while (
        i < lines.length &&
        (/^\s*-\s/.test(lines[i]) || lines[i].trim() === "")
      )
        i++;
      continue;
    }

    // Fenced code block: preserve only if DO/DO NOT AND <= 200B total
    const fenceOpen = line.match(/^(```+|~~~+)/);
    if (fenceOpen) {
      const fence = fenceOpen[1];
      const blockLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        blockLines.push(lines[j]);
        if (
          lines[j].startsWith(fence[0].repeat(fence.length)) &&
          lines[j].slice(fence.length).trim() === ""
        ) {
          j++;
          break;
        }
        j++;
      }
      const blockText = blockLines.join("\n");
      const blockSize = Buffer.byteLength(blockText, "utf8");
      const isDoBlock = blockLines.some((l) =>
        /^#\s+DO\b|^#\s+DO NOT\b|^\/\/\s+DO\b|^\/\/\s+DO NOT\b/.test(l),
      );
      if (isDoBlock && blockSize <= 200) {
        out.push(...blockLines);
      }
      i = j;
      continue;
    }

    // Markdown tables: preserve if under 1000B; else header + 3 data rows
    if (
      /^\|/.test(line) &&
      i + 1 < lines.length &&
      /^\|[-:\s|]+\|/.test(lines[i + 1])
    ) {
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && /^\|/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      const tableText = tableLines.join("\n");
      const tableSize = Buffer.byteLength(tableText, "utf8");
      const dataRows = tableLines.length - 2;
      if (tableSize <= 1000) {
        out.push(...tableLines);
      } else if (dataRows > 3) {
        out.push(
          tableLines[0],
          tableLines[1],
          tableLines[2],
          tableLines[3],
          tableLines[4],
        );
        out.push("| ... | ... |");
      } else {
        out.push(...tableLines);
      }
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  // Collapse multi-blanks + trim
  let result = out.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim() + "\n";
}

// ────────────────────────────────────────────────────────────────
// Slot-marker strip (after abridgement, before emit)
// ────────────────────────────────────────────────────────────────
// Slot markers are HTML comments — invisible in rendered markdown,
// but emitted text is consumed by Codex/Gemini as source strings.
// Strip them for a clean final output.
export function stripSlotMarkers(raw) {
  return raw
    .split("\n")
    .filter((l) => !/^<!--\s*\/?slot:[a-z][a-z0-9-]*\s*-->\s*$/.test(l))
    .join("\n");
}

// ────────────────────────────────────────────────────────────────
// Rule frontmatter strip (CDX-1: per-rule frontmatter blocks repeated in body)
// ────────────────────────────────────────────────────────────────
// Source rules carry a leading frontmatter block declaring `priority:`
// and `scope:` (validator-14 enforces the pair). The block is metadata
// for the emitter — Codex/Gemini consume the rendered baseline as
// instruction prose, so the `---\npriority: 0\nscope: baseline\n---`
// block must not survive into the emitted body.
export function stripRuleFrontmatter(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// ────────────────────────────────────────────────────────────────
// Overlay application (per variant-authoring.md Rule 1)
// ────────────────────────────────────────────────────────────────
// applyOverlay is imported from ./lib/slot-parser.mjs — shared with
// compose.mjs. Variant files contain ONLY slot-keyed replacement bodies.

// ────────────────────────────────────────────────────────────────
// Compose one rule for one CLI
// ────────────────────────────────────────────────────────────────
// Precedence per variant-authoring.md Rule 4:
//   1. global .claude/rules/<rule>.md
//   2. variants/<lang>/rules/<rule>.md        (language-axis only)
//   3. variants/<cli>/rules/<rule>.md         (CLI-axis only)
//   4. variants/<lang>-<cli>/rules/<rule>.md  (ternary, both-axis)
// 2–4 are all applied if present (union of slot replacements), in
// that order. Language-axis overlays were added 2026-04-22 (Phase I2)
// to close the semantic-licensing bug where, e.g., the proprietary
// rs override of independence.md was invisible to emit because only
// CLI-only and ternary paths composed into the baseline.
export function composeRule(ruleName, cli, lang = null) {
  // Rule-name validation: must be a simple .md filename — no traversal.
  if (!/^[a-z][a-z0-9-]*\.md$/.test(ruleName)) {
    throw new Error(
      `invalid rule name '${ruleName}' — must match /^[a-z][a-z0-9-]*\\.md$/`,
    );
  }

  const globalPath = path.join(REPO, ".claude", "rules", ruleName);
  if (!fs.existsSync(globalPath)) {
    throw new Error(`rule not found: ${globalPath}`);
  }

  let composed = fs.readFileSync(globalPath, "utf8");
  const warnings = [];

  // Axis resolution defers to resolveOverlay() so sync-manifest.yaml::variants
  // is the source of truth. `null` declarations skip the axis even if a
  // legacy file exists on disk (closes the phantom-overlay class — e.g.
  // `variants/py/rules/ci-runners.md` exists despite the manifest declaring
  // `[py] ci-runners.md: null`).
  //
  // Composition order matches the documented precedent: language-axis first,
  // CLI-axis second, ternary (lang-cli) third. All present overlays compose
  // additively (slot bodies replace global slots; full-file overlays replace
  // composed body entirely — last writer wins).
  const applyAxis = (axis, axisLabel) => {
    const res = resolveOverlay("rules", ruleName, axis);
    if (res.kind === "manifest-null") return;
    if (!fs.existsSync(res.path)) {
      if (res.kind === "manifest-explicit") {
        throw new Error(
          `sync-manifest.yaml::variants declares overlay '${path.relative(REPO, res.path)}' ` +
            `for rules/${ruleName} axis '${axis}', but the file is missing (manifest defect)`,
        );
      }
      return;
    }
    const overlay = fs.readFileSync(res.path, "utf8");
    if (overlay.includes("<!-- slot:")) {
      // Slot-keyed overlay — compose via slot-parser (Phase F2 convention).
      const { composed: c, warnings: w } = applyOverlay(composed, overlay);
      composed = c;
      warnings.push(...w.map((m) => `[${axisLabel}] ${m}`));
    } else {
      // Full-file overlay — variant wins per artifact-flow.md § Variant
      // Overlay Semantics. Pre-2026-05-12 composeRule had no branch for
      // this and silently no-op'd against legacy full-file overlays (e.g.
      // variants/prism/rules/*.md). Mirror composeArtifactBody behavior.
      composed = overlay;
    }
  };

  if (lang) applyAxis(lang, lang);
  applyAxis(cli, cli);
  if (lang) applyAxis(`${lang}-${cli}`, `${lang}-${cli}`);

  return { composed, warnings };
}

// ────────────────────────────────────────────────────────────────
// Emit CRIT baseline for one CLI
// ────────────────────────────────────────────────────────────────
// Per spec v6 §2.2, the CRIT baseline is emitted to AGENTS.md (codex)
// or GEMINI.md (gemini). The rule set + per-rule budgets come from
// sync-manifest.yaml cli_variants.context/root.md.<cli>.abridgement_protocol.

// Extract per-rule budget entries from sync-manifest.yaml. Returns a
// Map<ruleFileName, budgetBytes>. Parses only the
// `per_rule_size_budget_bytes:` block — deliberately narrow regex
// instead of a full YAML parser to avoid adding a dependency AND to
// limit the attack surface to a well-defined substring (addresses the
// MED finding on loadManifestConfig's regex-based YAML parsing).
export function loadPerRuleBudgets() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");

  const blockMatch = src.match(
    /per_rule_size_budget_bytes:\s*\n([\s\S]*?)(?=\n\s*per_rule_budget_tolerance:|\n[a-zA-Z_])/,
  );
  if (!blockMatch) return new Map();

  const block = blockMatch[1];
  const budgets = new Map();
  // Match lines like:  "zero-tolerance.md": 9000
  // Indented-line regex, strict: rule name in quotes, colon, whitespace,
  // integer, optional trailing comment.
  const entryRe = /^\s+"([a-z][a-z0-9-]*\.md)":\s*(\d+)\s*(?:#.*)?$/gm;
  let m;
  while ((m = entryRe.exec(block)) !== null) {
    budgets.set(m[1], parseInt(m[2], 10));
  }
  return budgets;
}

// Tolerance from sync-manifest.yaml per_rule_budget_tolerance (fixed
// at ±30% in v6 §2.2; the manifest stores it as a string literal so we
// parse it narrowly — if drift, this falls back to 0.30).
export function loadBudgetTolerance() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const m = src.match(/per_rule_budget_tolerance:\s*"±(\d+)%"/);
  return m ? parseInt(m[1], 10) / 100 : 0.3;
}

// Block threshold from sync-manifest.yaml per_rule_budget_block_threshold
// (v6 §A.2 + §2.2). When a rule's emitted bytes exceed budget * (1 +
// block_threshold), emission MUST hard-fail — the WARN tier is the
// drift-signal; the BLOCK tier is the contract. Pre-Shard-D, only the
// WARN path was wired; zero-tolerance.md ran +64% over budget unchecked.
export function loadBudgetBlockThreshold() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const m = src.match(/per_rule_budget_block_threshold:\s*"\+(\d+)%"/);
  return m ? parseInt(m[1], 10) / 100 : 0.3;
}

// Load warn_cap_bytes + block_cap_bytes + headroom_floor_pct from
// sync-manifest.yaml per CLI. The manifest is the single source of truth
// for the caps and the v6.2 Risk-0004 headroom floor; hardcoded constants
// would silently drift if the manifest changed. This loader mirrors the
// narrow-regex style used by loadPerRuleBudgets — deliberate, auditable,
// no YAML dep. The manifest structure is:
//   cli_variants:
//     context/root.md:
//       <cli>:
//         warn_cap_bytes: <int>
//         block_cap_bytes: <int>
//         headroom_floor_pct: <int>   # v6.2 — defaults to 10 if absent
export function loadCliCaps() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const src = fs.readFileSync(manifestPath, "utf8");
  const caps = {};
  // Anchor on each CLI's cap pair. Regex is intentionally narrow: match the
  // per-CLI block from `<cli>:` down to (and including) the first
  // `block_cap_bytes: <int>` line. Scan over the well-known set.
  for (const cli of ["codex", "gemini"]) {
    const re = new RegExp(
      `\\b${cli}:\\s*\\n` +
        `[\\s\\S]*?warn_cap_bytes:\\s*(\\d+)` +
        `[\\s\\S]*?block_cap_bytes:\\s*(\\d+)`,
      "m",
    );
    const m = src.match(re);
    if (m) {
      caps[cli] = {
        warn_cap_bytes: parseInt(m[1], 10),
        block_cap_bytes: parseInt(m[2], 10),
        // headroom_floor_pct lives in the same per-CLI block; parse with a
        // separate narrow regex anchored on the same `<cli>:` block. Default
        // to 10 (Risk-0004 floor) if not declared — preserves backward-compat
        // for any future CLI that lands without an explicit floor.
        // Lower-bound clamp at 10 per Risk-0004 contract: a manifest edit
        // setting floor < 10 would silently disable enforcement on the very
        // surface the v6.2 plan §3 closes. Per security-reviewer audit
        // (PR #218 R1) — the manifest is git-tracked, but operator-or-agent
        // edits below the contract floor are structurally rejected here.
        headroom_floor_pct: (() => {
          const fr = new RegExp(
            `\\b${cli}:\\s*\\n` +
              `[\\s\\S]*?headroom_floor_pct:\\s*(\\d+)`,
            "m",
          );
          const fm = src.match(fr);
          const parsed = fm ? parseInt(fm[1], 10) : 10;
          return Math.max(10, parsed);
        })(),
      };
    }
  }
  return caps;
}

export function getCritBaseline() {
  // CRIT baseline = rules with priority: 0 in frontmatter.
  // Empirically matches the per_rule_size_budget_bytes keys in the manifest.
  const rulesDir = path.join(REPO, ".claude", "rules");
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
  const crit = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(rulesDir, f), "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const prio = fm[1].match(/^priority:\s*(\d+)/m);
    if (prio && parseInt(prio[1], 10) === 0) crit.push(f);
  }
  return crit.sort();
}

// v6.2 Shard 1 — pure validator for aggregate headroom. Extracted from
// emitBaseline so the violation shape is testable in isolation. Returns
// an array (empty when no breach) so the call site can spread it directly
// into the result; matches the budget_block_violations shape per plan §5.1
// invariant 3 (per-rule budget BLOCK and aggregate-headroom BLOCK are
// independent and both can fire on one emission).
export function validateAggregateHeadroom({ cli, lang, emissionBytes, blockCap, floorPct }) {
  if (blockCap <= 0) return [];
  const headroomFloorBytes = Math.floor(blockCap * (1 - floorPct / 100));
  const livePctRaw = ((blockCap - emissionBytes) / blockCap) * 100;
  if (livePctRaw >= floorPct) return [];
  return [
    {
      cli,
      lang: lang || "base",
      emission_bytes: emissionBytes,
      block_cap_bytes: blockCap,
      headroom_pct: Number(livePctRaw.toFixed(2)),
      headroom_floor_pct: floorPct,
      headroom_floor_bytes: headroomFloorBytes,
      under_by_bytes: emissionBytes - headroomFloorBytes,
      remediation:
        "v6.2 Risk-0004 floor breach: per workspaces/multi-cli-coc/02-plans/" +
        "08-loom-v6.2-headroom-validator.md, demote a CRIT rule to path-scoped " +
        "(per v6 §A.2 + the v2.13.0/v2.19.0/v6.2-Shard-3 precedent), tighten a " +
        "per-rule budget, or trim emission. block_cap raise (option b) is BLOCKED " +
        "without explicit Codex-override-ceiling-stable evidence per plan §3.2.",
    },
  ];
}

export function emitBaseline(cli, outDir, { lang = null, verbose = false, dryRun = false } = {}) {
  const crit = getCritBaseline();
  const budgets = loadPerRuleBudgets();
  const tolerance = loadBudgetTolerance();
  const blockThreshold = loadBudgetBlockThreshold();
  const perRuleReport = [];
  const chunks = [];
  const allWarnings = [];
  const budgetWarnings = [];
  const budgetBlockViolations = [];

  for (const rule of crit) {
    const { composed, warnings } = composeRule(rule, cli, lang);
    const fmStripped = stripRuleFrontmatter(composed);
    const abridged = abridgeV6(fmStripped);
    const cleaned = stripSlotMarkers(abridged);
    const bytes = Buffer.byteLength(cleaned, "utf8");

    // Per-rule budget check per sync-manifest.yaml §per_rule_size_budget_bytes.
    // Outside ±tolerance → WARN (drift signal).
    // Over budget * (1 + block_threshold) → BLOCK (contract violation;
    //   per spec v6 §A.2, prevents one CRIT rule from monopolizing the
    //   total emission budget). Pre-Shard-D, only the WARN path was
    //   wired and zero-tolerance.md ran +64% over budget unchecked.
    let budgetStatus = "no_budget";
    if (budgets.has(rule)) {
      const budget = budgets.get(rule);
      const tolHigh = Math.floor(budget * (1 + tolerance));
      const tolLow = Math.floor(budget * (1 - tolerance));
      const blockHigh = Math.floor(budget * (1 + blockThreshold));
      if (bytes > blockHigh) {
        budgetStatus = "block";
        const overByPct = ((bytes / budget - 1) * 100).toFixed(1);
        budgetBlockViolations.push({
          rule,
          bytes,
          budget,
          block_threshold_bytes: blockHigh,
          over_by_bytes: bytes - blockHigh,
          over_by_pct: Number(overByPct),
        });
        budgetWarnings.push(
          `${rule}: ${bytes}B BLOCKS budget ${budget}B (+${blockThreshold * 100}% block_threshold = ${blockHigh}B); over by ${bytes - blockHigh}B (+${overByPct}% of budget)`,
        );
      } else if (bytes > tolHigh) {
        budgetStatus = "over";
        budgetWarnings.push(
          `${rule}: ${bytes}B over budget ${budget}B (+${tolerance * 100}% = ${tolHigh}B); over by ${bytes - tolHigh}B`,
        );
      } else if (bytes < tolLow) {
        budgetStatus = "under";
        budgetWarnings.push(
          `${rule}: ${bytes}B under budget ${budget}B (-${tolerance * 100}% = ${tolLow}B); under by ${tolLow - bytes}B`,
        );
      } else {
        budgetStatus = "ok";
      }
    } else {
      budgetWarnings.push(
        `${rule}: no per_rule_size_budget_bytes entry in sync-manifest.yaml (CRIT rule requires a budget)`,
      );
    }

    perRuleReport.push({
      rule,
      bytes,
      budget: budgets.get(rule) || null,
      budget_status: budgetStatus,
    });
    // CDX-3: drop the redundant `# <filename>.md` H1 prefix — each rule's
    // own H1 (e.g. `# Zero-Tolerance Rules`) is more descriptive and the
    // `---` inter-rule separator below provides structural boundary.
    // CDX-1 fix: stripRuleFrontmatter() above prevents the `---\npriority:`
    // block from showing up where the file-name H1 used to live.
    chunks.push(cleaned);
    if (warnings.length) allWarnings.push({ rule, warnings });
  }

  // CDX-2: append a closing `---` so the document ends with a clean
  // structural terminator rather than the trailing prose of the last
  // rule. `chunks.join` only places separators *between* chunks; without
  // this the final byte lands inside Rule 6a's "Why" paragraph and the
  // file looks truncated to a Codex/Gemini reader.
  const emission = chunks.join("\n---\n\n").replace(/\n+$/, "") + "\n\n---\n";
  const emissionBytes = Buffer.byteLength(emission, "utf8");

  // v6 caps — load from sync-manifest.yaml (single source of truth). The
  // previous hardcoded WARN_CAP=32768 / BLOCK_CAP=61440 are now loaded per-CLI
  // from cli_variants.context/root.md.<cli>.{warn,block}_cap_bytes so a
  // manifest edit propagates without touching emit.mjs.
  const allCaps = loadCliCaps();
  const caps = allCaps[cli] || {
    warn_cap_bytes: 32768,
    block_cap_bytes: 61440,
    headroom_floor_pct: 10,
  };
  const WARN_CAP = caps.warn_cap_bytes;
  const BLOCK_CAP = caps.block_cap_bytes;
  // v6.2 Risk-0004 floor — emission MUST keep at least this percentage of
  // block_cap as headroom. Default 10% per Risk-0004 contract; per-CLI
  // override via cli_variants.context/root.md.<cli>.headroom_floor_pct.
  const HEADROOM_FLOOR_PCT = caps.headroom_floor_pct;
  let tier;
  if (emissionBytes >= BLOCK_CAP) tier = "BLOCK";
  else if (emissionBytes >= WARN_CAP) tier = "WARN";
  else tier = "OK";

  // v6.2 Shard 1 — per-lang aggregate headroom validator. Independent of
  // per-rule budget BLOCK (line 440) and tier classification (above).
  // Surfaces a structured violation for any cli×lang combo whose
  // emission would breach the Risk-0004 floor. Both dryRun and regular
  // returns include the array; strict-headroom mode in main() (default
  // on as of v6.2 cycle-2; --no-strict-headroom escape for test-harness)
  // turns a non-empty array into a non-zero exit code so /sync halts at
  // emission.
  const headroomFloorViolations = validateAggregateHeadroom({
    cli,
    lang,
    emissionBytes,
    blockCap: BLOCK_CAP,
    floorPct: HEADROOM_FLOOR_PCT,
  });

  const emitName = cli === "codex" ? "AGENTS.md" : "GEMINI.md";
  const outPath = path.join(outDir, emitName);
  const reportPath = path.join(outDir, `emit-report-${cli}.json`);

  if (!dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    safeWriteFileSync(outPath, emission);
  }

  const headroomBytesForReport = Math.max(0, BLOCK_CAP - emissionBytes);
  const headroomPctForReport =
    BLOCK_CAP > 0
      ? Number(((headroomBytesForReport / BLOCK_CAP) * 100).toFixed(2))
      : 0;

  if (dryRun) {
    // Dry-run: return metadata but don't write files; caller reports
    // tier + rule count without touching disk.
    return {
      cli,
      lang,
      out_path: outPath,
      emission_bytes: emissionBytes,
      tier,
      rules: crit.length,
      warn_cap_bytes: WARN_CAP,
      block_cap_bytes: BLOCK_CAP,
      headroom_bytes: headroomBytesForReport,
      headroom_pct: headroomPctForReport,
      headroom_floor_pct: HEADROOM_FLOOR_PCT,
      headroom_floor_violations: headroomFloorViolations,
      budget_warnings: budgetWarnings,
      budget_block_violations: budgetBlockViolations,
      per_rule: perRuleReport,
      warnings: allWarnings,
      dry_run: true,
    };
  }

  safeWriteFileSync(
    reportPath,
    JSON.stringify(
      {
        cli,
        lang,
        emit_path: outPath,
        emission_bytes: emissionBytes,
        tier,
        warn_cap: WARN_CAP,
        block_cap: BLOCK_CAP,
        warn_cap_bytes: WARN_CAP,
        block_cap_bytes: BLOCK_CAP,
        headroom_bytes: headroomBytesForReport,
        headroom_pct: headroomPctForReport,
        headroom_floor_pct: HEADROOM_FLOOR_PCT,
        headroom_floor_violations: headroomFloorViolations,
        rules_emitted: crit.length,
        per_rule: perRuleReport,
        budget_warnings: budgetWarnings,
        budget_block_violations: budgetBlockViolations,
        warnings: allWarnings,
      },
      null,
      2,
    ),
  );

  if (verbose) {
    console.log(`[emit ${cli}${lang ? " " + lang : ""}] → ${outPath}`);
    console.log(
      `  ${crit.length} rules, ${emissionBytes}B total (${tier} tier; warn=${WARN_CAP}, block=${BLOCK_CAP})`,
    );
    for (const r of perRuleReport) {
      console.log(`    ${r.rule.padEnd(28)} ${String(r.bytes).padStart(6)} B`);
    }
    if (allWarnings.length) {
      console.log(`  warnings:`);
      for (const w of allWarnings) {
        for (const msg of w.warnings) console.log(`    ${w.rule}: ${msg}`);
      }
    }
  }

  const headroomBytes = Math.max(0, BLOCK_CAP - emissionBytes);
  const headroomPct = BLOCK_CAP > 0 ? (headroomBytes / BLOCK_CAP) * 100 : 0;

  return {
    emission_bytes: emissionBytes,
    tier,
    out_path: outPath,
    rules: crit.length,
    warn_cap_bytes: WARN_CAP,
    block_cap_bytes: BLOCK_CAP,
    headroom_bytes: headroomBytes,
    headroom_pct: Number(headroomPct.toFixed(2)),
    headroom_floor_pct: HEADROOM_FLOOR_PCT,
    headroom_floor_violations: headroomFloorViolations,
    budget_warnings: budgetWarnings,
    budget_block_violations: budgetBlockViolations,
  };
}

// ────────────────────────────────────────────────────────────────
// Validator 12 — slot round-trip preservation
// ────────────────────────────────────────────────────────────────
// After compose + abridge, each rule's slot structure MUST still be
// parseable (no unclosed slots, no mangled markers).
export function validateSlotRoundTrip(cli, lang = null) {
  const crit = getCritBaseline();
  const failures = [];
  for (const rule of crit) {
    try {
      const { composed } = composeRule(rule, cli, lang);
      parseSlotsV5(composed);
    } catch (err) {
      failures.push({ rule, error: err.message });
    }
  }
  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 13 — MCP guardrail bijection
// ────────────────────────────────────────────────────────────────
// Extract predicates from .claude/hooks/ → bijection against acceptance
// fixture expectations. When bijection holds, write policies.json and
// flip POLICIES_POPULATED=true in server.js.
export function validateMcpBijectionAgainstFixtures() {
  // Fixture moved from workspaces/multi-cli-coc/fixtures/ (gitignored)
  // to .claude/fixtures/ (committed) on 2026-04-22 so emit.mjs works
  // from a fresh clone. USE-template repos vendor the fixture when
  // they vendor .claude/bin/.
  const fixtureDir = path.join(REPO, ".claude", "fixtures", "validator-13");
  const expectedPath = path.join(fixtureDir, "expected-policies.json");
  if (!fs.existsSync(expectedPath)) {
    return { pass: false, reason: `fixture missing: ${expectedPath}` };
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const actual = extractPolicies(fixtureDir);
  const actualById = new Map(actual.predicates.map((p) => [p.id, p]));
  const failures = [];
  for (const fx of expected.fixtures) {
    const got = actualById.get(fx.predicate.id);
    if (!got) {
      failures.push(`MISSING ${fx.predicate.id}`);
      continue;
    }
    if (got.shape !== fx.shape) failures.push(`SHAPE ${fx.predicate.id}`);
    if (got.reason_template !== fx.predicate.reason_template)
      failures.push(`REASON ${fx.predicate.id}`);
    actualById.delete(fx.predicate.id);
  }
  for (const id of actualById.keys()) failures.push(`EXTRA ${id}`);
  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 14 — rule frontmatter per rule-authoring.md Rule 7
// ────────────────────────────────────────────────────────────────
// Every rule MUST declare BOTH `priority:` (0/10/20) AND `scope:`
// (baseline/path-scoped/skill-embedded/excluded). Pair must be consistent:
//   priority:0  ⇒ scope:baseline
//   priority:10 ⇒ scope:path-scoped + `paths:` present
//   priority:20 ⇒ scope:skill-embedded OR scope:excluded
//                 scope:excluded additionally requires `exclude_from: [...]`
//
// Before this validator existed, emit.mjs's getCritBaseline() silently
// dropped rules missing `priority:` — a stripped-frontmatter regression
// evaporated from the emitted baseline with no warning. Session
// 2026-04-24 pre-commit audit caught 5 baseline-rule regressions + 8
// pre-existing path-scoped Rule 7 violations this way.
export function validateRuleFrontmatter() {
  const rulesDir = path.join(REPO, ".claude", "rules");
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
  const failures = [];

  for (const f of files) {
    const content = fs.readFileSync(path.join(rulesDir, f), "utf8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      failures.push(`${f}: MISSING frontmatter block`);
      continue;
    }
    const body = fm[1];
    const prioMatch = body.match(/^priority:\s*(\d+)/m);
    const scopeMatch = body.match(/^scope:\s*(\w[\w-]*)/m);
    const hasPaths = /^paths:/m.test(body);
    const excludeFromMatch = body.match(/^exclude_from:\s*\[([^\]]*)\]/m);

    if (!prioMatch) failures.push(`${f}: MISSING priority: field`);
    if (!scopeMatch) failures.push(`${f}: MISSING scope: field`);
    if (!prioMatch || !scopeMatch) continue;

    const prio = parseInt(prioMatch[1], 10);
    const scope = scopeMatch[1];

    if (prio === 0 && scope !== "baseline") {
      failures.push(`${f}: priority:0 requires scope:baseline (got scope:${scope})`);
    }
    if (prio === 10 && scope !== "path-scoped") {
      failures.push(`${f}: priority:10 requires scope:path-scoped (got scope:${scope})`);
    }
    if (prio === 10 && !hasPaths) {
      failures.push(`${f}: priority:10 + scope:path-scoped requires paths: list`);
    }
    if (prio === 20 && !["skill-embedded", "excluded"].includes(scope)) {
      failures.push(
        `${f}: priority:20 requires scope:skill-embedded or scope:excluded (got scope:${scope})`,
      );
    }
    if (scope === "excluded" && !excludeFromMatch) {
      failures.push(`${f}: scope:excluded requires exclude_from: [cli, ...]`);
    }
    if (![0, 10, 20].includes(prio)) {
      failures.push(`${f}: priority must be 0, 10, or 20 (got ${prio})`);
    }
    if (!["baseline", "path-scoped", "skill-embedded", "excluded"].includes(scope)) {
      failures.push(
        `${f}: scope must be baseline/path-scoped/skill-embedded/excluded (got ${scope})`,
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 15 — manifest tier-completeness (loom 2026-05-16, journal
// 0078). Every .claude/rules/*.md MUST have its distribution fate
// consciously declared in sync-manifest.yaml — exactly one of:
//   (a) tier-listed (cc/co/coc/onboarding) — shipped to subscribers,
//   (b) use_obsoleted: — actively purged from USE templates,
//   (c) use_exclude:   — deliberately loom-only (never fanned out).
// The failure mode this blocks is SILENT omission: a rule that is in
// none of the three falls out of the subscription-based /sync model
// unnoticed. Before this validator, 16 rules authored at loom were
// never added to a tier and were frozen in templates (matching only by
// the luck of a pre-subscription full-sync). use_exclude IS a conscious
// state (loom-only by design, e.g. loom-csq-boundary.md) — counting it
// as managed prevents false positives on deliberately-excluded rules
// while still hard-failing the unmanaged class. Regex-scoped section
// parse (no YAML dep) consistent with loadManifestConfig.
export function validateTierCompleteness() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const rulesDir = path.join(REPO, ".claude", "rules");
  const text = fs.readFileSync(manifestPath, "utf8");

  // Slice a top-level YAML block: from the line AFTER `^<key>:` to the
  // next column-0 key. Slicing must start past the key's own newline —
  // otherwise the next-key search matches the tail of the key line.
  const sliceBlock = (key) => {
    const re = new RegExp(`^${key}:\\s*$`, "m");
    const start = text.search(re);
    if (start === -1) return "";
    const bodyStart = text.indexOf("\n", start);
    if (bodyStart === -1) return "";
    const after = text.slice(bodyStart + 1);
    const nextRel = after.search(/^[A-Za-z_][\w-]*:\s*$/m);
    return after.slice(0, nextRel === -1 ? undefined : nextRel);
  };

  const tiersBlock = sliceBlock("tiers");
  const obsBlock = sliceBlock("use_obsoleted");
  const exclBlock = sliceBlock("use_exclude");

  const tiered = new Set(
    [...tiersBlock.matchAll(/^\s*-\s*rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
      (m) => `${m[1]}.md`,
    ),
  );
  // use_obsoleted entries are `.claude/rules/x.md`; use_exclude entries
  // are `rules/x.md` (no `.claude/` prefix). Match both shapes.
  const obsoleted = new Set(
    [...obsBlock.matchAll(/^\s*-\s*\.claude\/rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
      (m) => `${m[1]}.md`,
    ),
  );
  const excluded = new Set(
    [...exclBlock.matchAll(/^\s*-\s*rules\/([a-z0-9-]+)\.md\s*$/gm)].map(
      (m) => `${m[1]}.md`,
    ),
  );

  const failures = [];
  for (const f of fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"))) {
    if (!tiered.has(f) && !obsoleted.has(f) && !excluded.has(f)) {
      failures.push(
        `${f}: unmanaged — declare its distribution fate in ` +
          `sync-manifest.yaml: add to a tier (cc/co/coc/onboarding), OR ` +
          `use_obsoleted: (purge from templates), OR use_exclude: ` +
          `(loom-only). (journal 0078)`,
      );
    }
  }
  return { pass: failures.length === 0, failures };
}

// ────────────────────────────────────────────────────────────────
// Validator 16 — strict-YAML manifest gate (loom 2026-05-16, journal
// 0080). emit.mjs parses sync-manifest.yaml with regex (no YAML dep, by
// design — loadManifestConfig). That parser is YAML-SYNTAX-BLIND: a
// structurally-broken manifest still lets `emit --dry-run` exit 0,
// while every strict-YAML consumer (verify-overlays.sh, yq, downstream
// /sync) fails repo-wide. PR #246 shipped exactly this — a list scalar
// with an embedded ": " — and it passed the emit gate. This validator
// closes the hole: a strict YAML parse (python3 yaml.safe_load shell-
// out, so emit.mjs stays Node-dependency-free) MUST succeed or emit
// hard-fails. Runs BEFORE Validator 15 in main() — V15's regex section
// parse is only trustworthy on a syntactically valid manifest.
export function validateManifestYaml() {
  const manifestPath = path.join(REPO, ".claude", "sync-manifest.yaml");
  const r = spawnSync(
    "python3",
    [
      "-c",
      "import sys,yaml\ntry:\n yaml.safe_load(open(sys.argv[1]))\nexcept yaml.YAMLError as e:\n sys.stderr.write(str(e))\n sys.exit(1)",
      manifestPath,
    ],
    { encoding: "utf8" },
  );
  if (r.error && r.error.code === "ENOENT") {
    // python3 absent — degrade to a clear advisory, do NOT silently pass.
    return {
      pass: false,
      failures: [
        "python3 not found — cannot strict-YAML-validate the manifest. " +
          "Install python3 (PyYAML) OR validate manually before emit.",
      ],
    };
  }
  if (r.status !== 0) {
    return {
      pass: false,
      failures: [
        `sync-manifest.yaml is not valid YAML: ${(r.stderr || "").trim().slice(0, 400)}`,
      ],
    };
  }
  return { pass: true, failures: [] };
}

// ────────────────────────────────────────────────────────────────
// POLICIES writeback to .codex-mcp-guard/
// ────────────────────────────────────────────────────────────────
// Runs extract-policies on .claude/hooks/. Writes TWO files (CDX-5 fix,
// Shard B 2026-05-10):
//
//   policies.json                — RUNTIME shape consumed by server.js
//                                  ({version, source_dir, policies}).
//                                  loadPolicies() in server.js (line 71-89)
//                                  reads `raw.policies[t]` for each wrapped
//                                  tool; this writer must match that shape.
//   extract-policies.dump.json   — AUDIT shape for V13 introspection
//                                  ({predicates, shape_summary,
//                                   orchestrators_filtered, policies_predicates}).
//                                  Sidecar; not loaded at runtime.
//
// Pre-Shard-B: this function wrote the audit shape to filename
// `policies.json`, while the on-disk `.claude/codex-mcp-guard/policies.json`
// (manually populated) carried the runtime shape. Same filename, two
// schemas — CDX-5 finding from the 2026-05-10 audit. If a /sync ever
// shipped this function's output to the codex-mcp-guard runtime
// directory, server.js would silently see no policies and fail-closed-
// refuse-to-start.
//
// Orchestrator filter per spec v6 §4.4 "Why Shape B is load-bearing":
// Shape A orchestrator functions (`main`, top-level entry points) are
// filtered as non-policy. Policies must be Shape B/C/D — Shape A's
// `main` is the script entry, not a guard predicate.
export function wireMcpPolicies(outDir) {
  const hooksDir = path.join(REPO, ".claude", "hooks");
  const extracted = extractPolicies(hooksDir);

  const filteredPredicates = extracted.predicates.filter((p) => {
    if (p.shape === "A" && p.id === "main") return false;
    return true;
  });

  // Runtime shape — what server.js::loadPolicies consumes.
  const runtimeJson = {
    version: 1,
    source_dir: path.relative(REPO, hooksDir),
    policies: extracted.policies,
  };

  // Audit shape — V13 introspection, /cli-audit Phase 2 input.
  const auditJson = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_dir: hooksDir,
    shape_summary: {
      A: filteredPredicates.filter((p) => p.shape === "A").length,
      B: filteredPredicates.filter((p) => p.shape === "B").length,
      C: filteredPredicates.filter((p) => p.shape === "C").length,
      D: filteredPredicates.filter((p) => p.shape === "D").length,
    },
    orchestrators_filtered: extracted.predicates.length - filteredPredicates.length,
    predicates: filteredPredicates,
    policies_predicates: extracted.policies_predicates,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const runtimePath = path.join(outDir, "policies.json");
  const auditPath = path.join(outDir, "extract-policies.dump.json");
  safeWriteFileSync(runtimePath, JSON.stringify(runtimeJson, null, 2) + "\n");
  safeWriteFileSync(auditPath, JSON.stringify(auditJson, null, 2) + "\n");
  return runtimePath;
}

// ────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────

// Single source of truth for the accepted-flag list. Read by BOTH the
// parseArgs unknown-flag warning (issue #235) and main()'s usage line —
// a future flag addition touches one place, not two.
const EMIT_USAGE =
  "usage: emit.mjs [--cli codex|gemini] [--lang py|rs] [--all] " +
  "[--out <dir>] [--dry-run] [--no-strict-headroom] [-v]";

export function parseArgs(argv) {
  const args = {
    cli: null,
    out: null,
    lang: null,
    all: false,
    dryRun: false,
    verbose: false,
    // v6.2 cycle-2 — strict mode is opt-out (default true). Mirrors the
    // v2.13.0 --strict-budget rollout: shipped opt-in in cycle-1, flipped
    // to opt-out in cycle-2 after one /sync observation cycle confirmed
    // zero false-positive blocks (PR #218 → v2.31.0 /sync, 2026-05-15).
    // Any headroom_floor_violations[] entry triggers exit code 1 so
    // /sync halts at emission rather than shipping the breach to
    // downstream USE templates.
    strictHeadroom: true,
    // issue #235 — tokens parseArgs did not recognize. Populated below so
    // callers (and the emit-shape harness) can assert the warning fired
    // without scraping stderr. A typo'd --no-strict-headroom lands here.
    unknownArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cli") args.cli = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--lang") args.lang = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-v" || a === "--verbose") args.verbose = true;
    // v6.2 cycle-2 — explicit opt-out for test-harness intentional-breach
    // exercises. Production /sync invocations MUST NOT pass this flag;
    // dropping strict mode in a /sync command body is regression class (a)
    // per sync-completeness.md Trust Posture Wiring § Rule 2 headroom-floor.
    else if (a === "--no-strict-headroom") args.strictHeadroom = false;
    // issue #235 — anything else is an unrecognized token. Pre-v6.2 this
    // branch did not exist: a typo'd --no-strict-headroon was silently
    // swallowed, strict mode stayed ON, and the operator burned a round
    // trip diagnosing why their explicit opt-out never fired.
    else args.unknownArgs.push(a);
  }
  if (args.unknownArgs.length > 0) {
    // JSON.stringify each token before echoing: argv is operator-controlled
    // and may carry control / ANSI-escape characters; quoting neutralizes
    // them and makes empty / whitespace-only tokens visible.
    const shown = args.unknownArgs.map((t) => JSON.stringify(t)).join(", ");
    process.stderr.write(
      `emit.mjs: WARNING — ignored unrecognized argument(s): ${shown}\n` +
        `  ${EMIT_USAGE}\n` +
        `  note: a typo'd --no-strict-headroom leaves strict mode ON — ` +
        `emission stays fail-safe, but the intended opt-out did NOT apply\n`,
    );
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) args.out = `/tmp/loom-emit-${Date.now()}`;

  const clis = args.all ? ["codex", "gemini"] : args.cli ? [args.cli] : null;
  if (!clis) {
    process.stderr.write(
      `${EMIT_USAGE}\n`,
    );
    process.exit(2);
  }

  let overallPass = true;
  const telemetry = {
    emitted_at: new Date().toISOString(),
    per_cli: {},
    block_cap_bytes: null,
    warn_cap_bytes: null,
  };

  // Validator 14 — rule frontmatter consistency per rule-authoring.md Rule 7.
  // Runs FIRST so a frontmatter regression blocks emission before any
  // CLI-specific work. Silent-drop in getCritBaseline() was the failure
  // mode this validator exists to prevent (session 2026-04-24).
  const v14 = validateRuleFrontmatter();
  console.log(`[validator-14] rule-frontmatter: ${v14.pass ? "PASS" : "FAIL"}`);
  if (!v14.pass) {
    overallPass = false;
    process.stderr.write(
      `VALIDATOR 14 FAIL (rule-authoring.md Rule 7):\n${v14.failures.map((l) => "  " + l).join("\n")}\n`,
    );
    process.exit(1);
  }

  // Validator 16 — strict-YAML manifest gate (journal 0080). MUST run
  // BEFORE V15: V15's regex section parse is only meaningful on a
  // syntactically valid manifest. PR #246's broken manifest passed the
  // YAML-blind regex parser; this gate makes that impossible.
  const v16 = validateManifestYaml();
  console.log(`[validator-16] manifest-yaml: ${v16.pass ? "PASS" : "FAIL"}`);
  if (!v16.pass) {
    overallPass = false;
    process.stderr.write(
      `VALIDATOR 16 FAIL (sync-manifest.yaml strict-YAML, journal 0080):\n${v16.failures.map((l) => "  " + l).join("\n")}\n`,
    );
    process.exit(1);
  }

  // Validator 15 — manifest tier-completeness (journal 0078). Runs
  // alongside V14 (structural, pre-emission): a rule absent from every
  // tier is silently excluded from the subscription sync, so block
  // before any CLI work — same fail-fast posture as V14.
  const v15 = validateTierCompleteness();
  console.log(`[validator-15] tier-completeness: ${v15.pass ? "PASS" : "FAIL"}`);
  if (!v15.pass) {
    overallPass = false;
    process.stderr.write(
      `VALIDATOR 15 FAIL (sync-manifest tier-completeness, journal 0078):\n${v15.failures.map((l) => "  " + l).join("\n")}\n`,
    );
    process.exit(1);
  }

  for (const cli of clis) {
    const subdir = path.join(args.out, cli);
    const result = emitBaseline(cli, subdir, {
      lang: args.lang,
      verbose: args.verbose,
      dryRun: args.dryRun,
    });
    telemetry.per_cli[cli] = {
      rules: result.rules,
      bytes: result.emission_bytes,
      tier: result.tier,
      headroom_bytes: result.headroom_bytes,
      headroom_pct: result.headroom_pct,
      warn_cap_bytes: result.warn_cap_bytes,
      block_cap_bytes: result.block_cap_bytes,
    };
    // Top-level caps: take from the first CLI that reports them. If different
    // CLIs have different caps, the per_cli block still shows the truth.
    if (telemetry.block_cap_bytes === null) {
      telemetry.block_cap_bytes = result.block_cap_bytes;
      telemetry.warn_cap_bytes = result.warn_cap_bytes;
    }
    const rtr = validateSlotRoundTrip(cli, args.lang);
    console.log(
      `[${cli}${args.lang ? " " + args.lang : ""}] ${result.tier}: ${result.rules} rules, ${result.emission_bytes}B → ${result.out_path}`,
    );
    console.log(`[${cli}] validator-12 slot-round-trip: ${rtr.pass ? "PASS" : "FAIL"}`);
    if (!rtr.pass) {
      overallPass = false;
      process.stderr.write(`[${cli}] VALIDATOR 12 FAIL: ${JSON.stringify(rtr.failures)}\n`);
    }
    if (result.budget_warnings && result.budget_warnings.length > 0) {
      process.stderr.write(
        `[${cli}] per-rule budget WARN (${result.budget_warnings.length} rule${result.budget_warnings.length > 1 ? "s" : ""}):\n`,
      );
      for (const w of result.budget_warnings) {
        process.stderr.write(`  ${w}\n`);
      }
    }
    if (result.budget_block_violations && result.budget_block_violations.length > 0) {
      // Per-rule budget BLOCK — spec v6 §A.2 + sync-manifest.yaml
      // per_rule_budget_block_threshold. ANY rule over budget * (1 +
      // block_threshold) is a hard fail; emission is wrong by contract,
      // not just over a soft target. Closes CDX-7 (2026-05-10 audit).
      overallPass = false;
      process.stderr.write(
        `[${cli}] per-rule budget BLOCK (${result.budget_block_violations.length} rule${result.budget_block_violations.length > 1 ? "s" : ""} exceed block_threshold):\n`,
      );
      for (const v of result.budget_block_violations) {
        process.stderr.write(
          `  ${v.rule}: ${v.bytes}B over budget ${v.budget}B by +${v.over_by_pct}% (block_threshold ${v.block_threshold_bytes}B); over by ${v.over_by_bytes}B\n`,
        );
      }
      process.stderr.write(
        `[${cli}] remediation: per spec v6 §A.2, abridge the offending rule (move long examples to .claude/guides/rule-extracts/<rule>.md), tighten the per-rule budget, or demote the rule to path-scoped.\n`,
      );
    }
    if (result.tier === "BLOCK") {
      overallPass = false;
      process.stderr.write(
        `[${cli}] HARD BLOCK: ${result.emission_bytes}B >= block_cap 61440 (over by ${result.emission_bytes - 61440}B)\n`,
      );
      process.stderr.write(
        `[${cli}] remediation: per spec v6 §A.2, demote a CRIT rule to path-scoped, tighten a per-rule budget, or trim the ruleset. See ${subdir}/emit-report-${cli}.json for per-rule sizes.\n`,
      );
    } else if (result.tier === "WARN") {
      process.stderr.write(
        `[${cli}] WARN: ${result.emission_bytes}B in [${32768}, ${61440}) — refactoring-signal tier (steady state per v6 §2.2).\n`,
      );
    }
    // v6.2 Shard 1 — per-lang headroom floor enforcement. Surfaces with
    // ANY violation (independent of tier — a BLOCK is cap-breach, a
    // floor breach is the canary BEFORE cap-breach). Always logs;
    // strict-headroom mode (default on as of cycle-2; opt-out via
    // --no-strict-headroom for test-harness) converts the log into a
    // hard fail.
    if (result.headroom_floor_violations && result.headroom_floor_violations.length > 0) {
      const v = result.headroom_floor_violations[0];
      const verdict = args.strictHeadroom ? "BLOCK" : "WARN";
      process.stderr.write(
        `[${cli}${args.lang ? " " + args.lang : ""}] headroom-floor ${verdict}: ` +
          `${v.headroom_pct}% < ${v.headroom_floor_pct}% floor ` +
          `(under by ${v.under_by_bytes}B; emission ${v.emission_bytes}B vs ` +
          `floor ${v.headroom_floor_bytes}B / cap ${v.block_cap_bytes}B)\n`,
      );
      process.stderr.write(
        `[${cli}${args.lang ? " " + args.lang : ""}] remediation: ${v.remediation}\n`,
      );
      if (args.strictHeadroom) {
        overallPass = false;
      }
    }
  }

  // Write consolidated emit-telemetry.json at the shared out-dir so
  // /cli-audit Phase 4 (and coc-sync marker synthesis) can read a single
  // machine-readable summary rather than parsing two per-CLI reports.
  // Surfaces baseline headroom as a trend metric — Risk-0004 (baseline-cap
  // headroom ~4%) becomes observable across syncs.
  if (!args.dryRun) {
    try {
      fs.mkdirSync(args.out, { recursive: true });
      safeWriteFileSync(
        path.join(args.out, "emit-telemetry.json"),
        JSON.stringify(telemetry, null, 2),
      );
    } catch (e) {
      process.stderr.write(`[telemetry] write failed: ${e.message}\n`);
    }
  }

  // Validator 13 + POLICIES wiring — always runs; not CLI-scoped.
  const v13 = validateMcpBijectionAgainstFixtures();
  if (!v13.pass) {
    overallPass = false;
    const detail = v13.reason || JSON.stringify(v13.failures);
    process.stderr.write(`VALIDATOR 13 FAIL: ${detail}\n`);
  } else if (args.dryRun) {
    console.log(`[validator-13] PASS (dry-run; policies.json not written)`);
  } else {
    const policiesDir = path.join(args.out, "codex-mcp-guard");
    const policiesPath = wireMcpPolicies(policiesDir);
    console.log(`[validator-13] PASS + wrote ${policiesPath}`);
  }

  process.exit(overallPass ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
