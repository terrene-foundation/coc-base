"use strict";

/**
 * lib/handover-seed.js — the SEED schema and its structural validator.
 *
 * @what The seed is the ONE block of state carried across a context boundary
 *       (`/clear` or an autocompact) in the autonomous context cycle
 *       (`workspaces/context-budget-2026-10-10/design/CYCLE.md` §2.1). This
 *       module parses a seed and answers ONE question: can a resumed agent
 *       answer the five resume questions from this seed ALONE?
 *
 *         Q1 who am I, in what role, where, under which standing directives?
 *         Q2 what is in flight, where does it physically live, how do I re-check it?
 *         Q3 what is owned by whom?
 *         Q4 which decisions are pending, with whom, and do they block me?
 *         Q5 what do I do first?
 *
 *       Every finding names the section AND the question it leaves unanswerable,
 *       so a refused seed tells its author exactly what to rewrite.
 *
 * @why  The owner's directive: the handover "cannot end up blowing up the
 *       context and yet must contain good information". Both halves are
 *       mechanical here:
 *         - SIZE: target 4,000 B, HARD CAP 8,000 B (UTF-8). Over the cap the seed
 *           is REFUSED, never truncated — a truncated seed is byte-for-byte
 *           indistinguishable from a complete one to the session that reads it,
 *           which is `session-notes-continuity.md` MUST-2's reasoning.
 *         - CONTENT: a fixed schema whose required sections each answer one of
 *           the five questions; an empty section must say `none`, so "nothing in
 *           flight" and "forgot to write the in-flight rows" cannot render alike.
 *
 * @scope STRUCTURAL ONLY. A green verdict means every question has an answer in
 *        the right SHAPE; whether each row is TRUE is what that row's `re-check`
 *        command answers after resume. This validator cannot see truth and does
 *        not claim to.
 *
 * @placement `hooks/lib/` and CommonJS on purpose: the SessionStart injector
 *        (CYCLE.md shard S4) re-validates the seed on READ, and a hook cannot
 *        synchronously import an ES module. The renderer CLI
 *        (`.claude/bin/handover-render.mjs`) loads this same file, so the writer
 *        and the reader share ONE schema (`security.md` § Enforcement-Surface
 *        Parity).
 *
 * Command validation resolves trusted repo/bin paths; see this file's
 * readonlyCommand (.claude/hooks/lib/handover-seed.js:52-88) never executes commands.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function readonlyCommand(cell, repoDir) {
  if (typeof cell !== "string") return false;
  const parts = cell.split(/→|->/);
  if (/[\r\n\t;&|`$<>\\]/.test(parts.join(""))) return false;
  const explanations = new Set([
    "still true", "meaning still true",
    "current checkout HEAD only, lane delivery remains UNVERIFIED",
    "current checkout cleanness only, peer state remains UNVERIFIED",
    "current checkout diff scope only, delivery and review claims remain UNVERIFIED",
    "identify current checkout HEAD only, re-derive review eligibility from DEPTH",
  ]);
  if (parts.length > 2 || (parts.length === 2 && !explanations.has(parts[1].trim()))) return false;
  const command = parts[0].trim();
  if (!command || /[^A-Za-z0-9_./%=: @-]/.test(command)) return false;
  const argv = command.split(/ +/);
  if (argv[0] === "trestle") return argv.join(" ") === "trestle run --status";
  if (argv[0] === "git") {
    const args = argv.slice(1);
    if (args[0] === "-C") return false;
    const [verb, ...flags] = args;
    if (verb === "status") return flags.length <= 1 && flags.every((x) => ["--short", "--porcelain", "--porcelain=v1"].includes(x));
    if (verb === "diff") return flags.join(" ") === "--stat";
    if (verb === "log") return flags.length <= 2 && new Set(flags).size === flags.length && flags.every((x) => /^-[1-9]\d?$/.test(x) || ["--oneline", "--format=%h"].includes(x));
    if (verb === "rev-parse") return flags.length === 1 && (["--show-toplevel", "--show-prefix", "--git-dir"].includes(flags[0]) || /^[A-Za-z0-9_][A-Za-z0-9_./@-]*$/.test(flags[0]));
    return false;
  }
  if (argv[0] !== "node" || argv.length !== 3 || argv[2] !== "--check") return false;
  // The finite capability exits before its write branch: .claude/bin/build-trust-root.mjs:361-414.
  try {
    const root = fs.realpathSync(repoDir);
    const bins = fs.realpathSync(path.join(root, ".claude", "bin"));
    const target = fs.realpathSync(path.resolve(root, argv[1]));
    const rel = path.relative(root, bins);
    return rel !== "" && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel) &&
      target === path.join(bins, "build-trust-root.mjs") && fs.lstatSync(target).isFile();
  } catch { return false; }
}

const SEED_SCHEMA = "SEED v1";
const SEED_TARGET_BYTES = 4000;
const SEED_HARD_CAP_BYTES = 8000;
const MECHANICAL_CAP_BYTES = 2000;

/**
 * The fixed section order. `kind`:
 *   inline — content on the label line after `:` (continuation lines allowed only
 *            where `multiline` is true)
 *   rows   — content on the lines that follow the label line
 * `noneOk` — whether the literal `none` is an acceptable answer.
 * `max`    — row / item ceiling from CYCLE.md §2.1.
 */
const SECTIONS = Object.freeze([
  { label: "ROLE", kind: "inline", question: 1, noneOk: false },
  { label: "STANDING", kind: "inline", question: 1, noneOk: true, max: 5 },
  { label: "MISSION", kind: "inline", question: 1, noneOk: false },
  // OPTIONAL in the schema (absent ⇒ accepted), so a seed written before this section
  // existed — and the mechanical emergency seed, which cannot know an assignment — still
  // validates on READ. The WRITER requires it: handover-render.mjs refuses a render whose
  // seed lacks it (bin/lib/handover-render.mjs::handoverBinding). `none` declares that no
  // owner-assigned objective is carried.
  { label: "ASSIGNMENT", kind: "rows", question: 1, noneOk: true, max: 3, required: false },
  { label: "IN FLIGHT", kind: "rows", question: 2, noneOk: true, max: 8, cells: 7 },
  { label: "OWNED BY OTHERS", kind: "rows", question: 3, noneOk: true, max: 6, cells: 4 },
  { label: "PENDING DECISIONS", kind: "rows", question: 4, noneOk: true, max: 5, cells: 5 },
  { label: "NEXT", kind: "inline", question: 5, noneOk: false },
  { label: "QUEUED", kind: "inline", question: 5, noneOk: true, max: 2, multiline: true },
  { label: "TRAPS", kind: "rows", question: null, noneOk: true, max: 5 },
  { label: "DEPTH", kind: "rows", question: null, noneOk: true, max: 6 },
  { label: "MECHANICAL", kind: "rows", question: null, noneOk: true },
]);

const SECTION_LABELS = Object.freeze(SECTIONS.map((s) => s.label));

/** Column names, so a short row is reported by the cell it lacks. */
const CELL_NAMES = Object.freeze({
  "IN FLIGHT": ["id", "what", "where", "state", "owner", "next", "re-check"],
  "OWNED BY OTHERS": ["who", "what", "waiting on", "check"],
  "PENDING DECISIONS": ["id", "question", "decides", "recommendation", "blocks"],
});

/**
 * The ASSIGNMENT keys, in order. `objective` is the owner's wording VERBATIM, in double
 * quotes; `ledger` is the path of the durable assignment ledger (absolute, or relative to
 * ROLE repo=); `next` is the next step ON THE ASSIGNMENT (NEXT stays the next action).
 */
const ASSIGNMENT_KEYS = Object.freeze(["objective", "ledger", "next"]);

/** The two distinct escalation destinations of the forest directive. */
const DECIDERS = Object.freeze(["HUMAN", "ORCHESTRATOR"]);

const HEADER_RE = /^=== SEED v1 (.*) ===$/;
const FOOTER = "=== END SEED ===";
const RESUME_TOKEN_RE = /^[0-9a-f]{8}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Codepoints a seed may not carry. The seed is model-authored text that is
 * re-injected into a FUTURE context, so anything that renders differently from
 * how it reads — C0/C1 controls, DEL, bidirectional overrides — is refused at
 * the writer rather than left to the reader's sanitiser alone.
 */
function forbiddenCodepoint(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  if (cp < 0x20 || cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  if (cp === 0x00ad || cp === 0x061c || cp === 0x180e || cp === 0xfeff) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x2060 && cp <= 0x206f) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  return false;
}

/** A label line: the label at column 0, then `:`, ` (`, or end of line. */
function matchLabel(line) {
  for (const label of SECTION_LABELS) {
    if (!line.startsWith(label)) continue;
    const rest = line.slice(label.length);
    if (rest === "" || rest.startsWith(":") || rest.startsWith(" (") || rest.startsWith(" :")) {
      let inline = "";
      const colon = rest.indexOf(":");
      // `IN FLIGHT (id | what …)` is a column legend, not content. Only text after
      // a colon that is NOT inside the legend parentheses is inline content.
      if (rest.startsWith(":") || rest.startsWith(" :")) inline = rest.slice(colon + 1).trim();
      else if (rest.startsWith(" (")) {
        const close = rest.indexOf(")");
        const after = close >= 0 ? rest.slice(close + 1) : "";
        const c2 = after.indexOf(":");
        inline = c2 >= 0 ? after.slice(c2 + 1).trim() : "";
      }
      return { label, inline };
    }
  }
  return null;
}

function isNone(text) {
  return /^\(?none\)?\.?$/i.test(String(text).trim());
}

/** Split a row into cells on ` | `; the LAST cell absorbs any surplus pipes. */
function splitCells(row, want) {
  const parts = row.split(/\s\|\s/).map((c) => c.trim());
  if (want && parts.length > want) {
    return parts.slice(0, want - 1).concat([parts.slice(want - 1).join(" | ")]);
  }
  return parts;
}

/** Strip a leading list marker: `1.` `1)` `-` `*` `•`. */
function stripBullet(line) {
  return line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "");
}

// A key given twice is REFUSED (header-field-duplicate), never resolved first- or
// last-wins: two readers resolving it differently would each see a valid but DIFFERENT
// header (one `written=` for the renderer, another for a human), so the seed is ambiguous.
function parseHeaderFields(s, duplicates = []) {
  const out = {};
  for (const tok of s.trim().split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const key = tok.slice(0, eq);
    if (Object.prototype.hasOwnProperty.call(out, key)) duplicates.push(key);
    out[key] = tok.slice(eq + 1);
  }
  return out;
}

/**
 * The tool's clock as ISO-8601 with this host's offset (`…T23:21:27+08:00`), seconds
 * precision — the ONE format the seed header's `written=` takes. Shared by the meter's
 * handover line (which prints it, so the agent copies a clock instead of typing one) and
 * the renderer's stamp, so the two can never disagree on shape.
 */
/** A FUTURE `written=` is a typed time, not a clock: bounded tightly (the renderer AND the seed-write hook). */
const WRITTEN_FUTURE_SKEW_MS = 120 * 1000;
/** A `written=` more than this BEHIND the clock is an old seed (or an old time) — rewrite it. */
const WRITTEN_PAST_SKEW_MS = 600 * 1000;

function clockIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const two = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}${off >= 0 ? "+" : "-"}${two(off / 60)}:${two(off % 60)}`;
}

/**
 * Parse a seed into header + sections. Never throws; structural problems are
 * returned as findings for `validateSeed` to merge.
 */
function parseSeed(text) {
  const findings = [];
  const add = (code, section, question, detail) => findings.push({ code, section, question, detail });
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const header = { present: false, fields: {} };
  if (i < lines.length && HEADER_RE.test(lines[i])) {
    header.present = true;
    const dups = [];
    header.fields = parseHeaderFields(HEADER_RE.exec(lines[i])[1], dups);
    for (const k of [...new Set(dups)]) add("header-field-duplicate", "HEADER", null, `header key ${k}= appears more than once — readers would disagree on which value holds; give each key once`);
    i++;
  } else {
    add("header-missing", "HEADER", null, `the first line must be '=== ${SEED_SCHEMA} lineage=… written=… at_tokens=… resume=… ===' (got ${JSON.stringify((lines[i] || "").slice(0, 80))})`);
  }

  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  let footerAt = -1;
  for (let k = i; k <= end; k++) {
    if (lines[k] === FOOTER) {
      footerAt = k;
      break;
    }
  }
  if (footerAt < 0) {
    add("footer-missing", "FOOTER", null, `the seed must end with '${FOOTER}' — without it a cut-off seed reads exactly like a complete one`);
    footerAt = end + 1;
  } else if (footerAt !== end) {
    add("content-after-footer", "FOOTER", null, `${end - footerAt} line(s) follow '${FOOTER}'; nothing may follow the footer`);
  }

  const sections = new Map();
  const order = [];
  let cur = null;
  for (let k = i; k < footerAt; k++) {
    const line = lines[k];
    const m = matchLabel(line);
    if (m) {
      if (sections.has(m.label)) {
        add("section-duplicate", m.label, null, `section ${m.label} appears more than once (line ${k + 1})`);
        cur = null;
        continue;
      }
      cur = { label: m.label, line: k + 1, inline: m.inline, rows: [] };
      sections.set(m.label, cur);
      order.push(m.label);
      continue;
    }
    if (line.trim() === "") continue;
    if (!cur) {
      add("stray-content", "HEADER", null, `line ${k + 1} is outside any section: ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    cur.rows.push({ text: line, line: k + 1 });
  }
  return { header, sections, order, findings };
}

/** Count enumerated items: `(a) … (b) …`, `1. … 2. …`, or `;`-separated. */
function countInlineItems(text) {
  const t = text.trim();
  if (t === "" || isNone(t)) return 0;
  const paren = t.match(/(?:^|\s)\(([a-z]|\d{1,2})\)\s/gi);
  if (paren && paren.length) return paren.length;
  const num = t.match(/(?:^|\s)\d{1,2}[.)]\s/g);
  if (num && num.length) return num.length;
  return t.split(/;\s+/).filter((s) => s.trim() !== "").length;
}

/** Is a cell an answer (non-empty, not a dash, not `?`)? */
function answered(cell) {
  const c = (cell || "").trim();
  return c !== "" && !/^[-–—?]+$/.test(c);
}

/**
 * Validate a seed.
 *
 * @param {string|Buffer} input
 * @returns {{
 *   ok: boolean, refused: boolean, bytes: number, sha256: string,
 *   target_bytes: number, cap_bytes: number, over_target: boolean,
 *   header: {lineage?:string, written?:string, at_tokens?:number, resume_token?:string},
 *   sections: Object<string, {line:number, inline:string, rows:string[]}>,
 *   findings: Array<{code:string, section:string, question:number|null, detail:string}>,
 *   warnings: string[]
 * }}
 *   `refused` is true whenever `ok` is false: an invalid seed is never projected.
 */
function validateSeed(input, { repoDir = process.cwd() } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input === undefined || input === null ? "" : input), "utf8");
  const bytes = buf.length;
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const findings = [];
  const warnings = [];
  const add = (code, section, question, detail) => findings.push({ code, section, question, detail });

  const base = {
    bytes,
    sha256,
    target_bytes: SEED_TARGET_BYTES,
    cap_bytes: SEED_HARD_CAP_BYTES,
    over_target: bytes > SEED_TARGET_BYTES,
  };

  // SIZE FIRST, and it short-circuits. An over-cap seed is refused WHOLE: no
  // partial parse is offered as a basis for trimming it into shape here, because
  // the remedy is the author rewriting it shorter — never this module cutting it.
  if (bytes > SEED_HARD_CAP_BYTES) {
    add("over-cap", "SEED", null, `seed is ${bytes} bytes; the hard cap is ${SEED_HARD_CAP_BYTES}. REFUSED, not truncated — rewrite it shorter (target ${SEED_TARGET_BYTES}); move detail into DEPTH pointers`);
    return Object.assign(base, { ok: false, refused: true, header: {}, sections: {}, findings, warnings });
  }

  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) {
    add("invalid-utf8", "SEED", null, "seed is not valid UTF-8; its bytes would not survive a decode/encode round-trip");
  }
  let lineNo = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a) lineNo++;
    if (forbiddenCodepoint(cp)) {
      add("forbidden-codepoint", "SEED", null, `line ${lineNo} carries U+${cp.toString(16).toUpperCase().padStart(4, "0")} — control and bidirectional-override codepoints are refused in text re-injected into a future context`);
      break;
    }
  }
  if (/^\s*(?:`{3,}|~{3,})/m.test(text)) {
    add("fence-in-seed", "SEED", null, "a line opens a code fence; the seed is embedded verbatim inside the vault wrapup's fenced /clear seed block, and an inner fence would end that block early");
  }

  const parsed = parseSeed(text);
  findings.push(...parsed.findings);

  // Header fields — resume_token is what the post-boundary echo check keys on.
  const hf = parsed.header.fields;
  const header = {};
  if (parsed.header.present) {
    if (!hf.lineage) add("header-field-missing", "HEADER", 1, "header lacks lineage=<terminal>");
    else header.lineage = hf.lineage;
    if (!hf.written || !ISO_RE.test(hf.written)) add("header-field-invalid", "HEADER", null, `header written= must be an ISO-8601 timestamp with offset (got ${JSON.stringify(hf.written || "")})`);
    else header.written = hf.written;
    if (!hf.at_tokens || !/^\d+$/.test(hf.at_tokens)) add("header-field-invalid", "HEADER", null, `header at_tokens= must be a non-negative integer (got ${JSON.stringify(hf.at_tokens || "")})`);
    else header.at_tokens = Number.parseInt(hf.at_tokens, 10);
    if (!hf.resume) add("resume-token-missing", "HEADER", null, "header lacks resume=<8-hex>; without it the resumed session cannot prove it read the seed");
    else if (!RESUME_TOKEN_RE.test(hf.resume)) add("resume-token-invalid", "HEADER", null, `resume= must be exactly 8 lowercase hex characters (got ${JSON.stringify(hf.resume)})`);
    else header.resume_token = hf.resume;
  }

  // Presence + order.
  const present = parsed.order;
  for (const s of SECTIONS) {
    if (!parsed.sections.has(s.label) && s.required !== false) {
      add("section-missing", s.label, s.question, `required section ${s.label} is absent${s.question ? ` — resume question Q${s.question} is unanswerable` : ""}; an empty section must still be written, saying 'none'`);
    }
  }
  const expected = SECTION_LABELS.filter((l) => present.includes(l));
  if (present.length === expected.length && present.some((l, idx) => l !== expected[idx])) {
    add("section-order", "SEED", null, `sections are out of order: ${present.join(" → ")}; the schema order is ${SECTION_LABELS.join(" → ")}`);
  }

  const out = {};
  for (const s of SECTIONS) {
    const sec = parsed.sections.get(s.label);
    if (!sec) continue;
    const rowTexts = sec.rows.map((r) => r.text);
    out[s.label] = { line: sec.line, inline: sec.inline, rows: rowTexts };
    const q = s.question;

    if (s.kind === "inline") {
      if (sec.rows.length && !s.multiline) {
        add("section-multiline", s.label, q, `${s.label} must be one line (found ${sec.rows.length} continuation line(s) from line ${sec.rows[0].line})`);
      }
      const content = s.multiline ? [sec.inline, ...rowTexts.map(stripBullet)].filter((x) => x.trim() !== "").join("; ") : sec.inline;
      if (content.trim() === "") {
        add("section-empty", s.label, q, `${s.label} is empty; write 'none' if there is genuinely nothing${s.noneOk ? "" : " — but this section may NOT be 'none'"}`);
        continue;
      }
      if (isNone(content)) {
        if (!s.noneOk) add("section-none-forbidden", s.label, q, `${s.label} cannot be 'none' — resume question Q${q} needs a real answer`);
        continue;
      }
      if (s.label === "ROLE") checkRole(content, add);
      if (s.label === "STANDING") {
        const n = content.split(/\s\|\s/).filter((x) => x.trim() !== "").length;
        if (n > s.max) add("section-over-limit", s.label, q, `STANDING carries ${n} pointers; at most ${s.max} (pointers to directives, never their text)`);
      }
      if (s.label === "NEXT") checkNext(content, add, repoDir);
      if (s.label === "QUEUED") {
        const n = s.multiline && rowTexts.length ? [sec.inline, ...rowTexts].filter((x) => x.trim() !== "").length : countInlineItems(content);
        if (n > s.max) add("section-over-limit", s.label, q, `QUEUED carries ${n} items; at most ${s.max}`);
      }
      continue;
    }

    // rows-kind
    const rows = sec.inline ? [sec.inline, ...rowTexts] : rowTexts;
    if (rows.length === 0) {
      add("section-empty", s.label, q, `${s.label} has no rows; write 'none' if there is genuinely nothing`);
      continue;
    }
    if (rows.length === 1 && isNone(stripBullet(rows[0]))) continue;

    if (s.label === "MECHANICAL") {
      const mb = Buffer.byteLength(rows.join("\n"), "utf8");
      if (mb > MECHANICAL_CAP_BYTES) add("section-over-limit", s.label, null, `MECHANICAL is ${mb} bytes; at most ${MECHANICAL_CAP_BYTES}`);
      continue;
    }
    if (s.label === "ASSIGNMENT") {
      checkAssignment(rows, sec.line, add);
      continue;
    }
    if (s.label === "DEPTH") {
      const n = rows.reduce((acc, r) => acc + stripBullet(r).split(/\s\|\s/).filter((x) => x.trim() !== "").length, 0);
      if (n > s.max) add("section-over-limit", s.label, null, `DEPTH carries ${n} pointers; at most ${s.max}`);
      continue;
    }
    if (rows.length > s.max) {
      add("section-over-limit", s.label, q, `${s.label} carries ${rows.length} rows; at most ${s.max}`);
    }
    if (!s.cells) continue;
    const names = CELL_NAMES[s.label];
    sec.rows.forEach((r, idx) => checkRow(s, names, stripBullet(r.text), r.line, idx + 1, add, repoDir));
    if (sec.inline) checkRow(s, names, stripBullet(sec.inline), sec.line, 0, add, repoDir);
  }

  if (base.over_target && findings.length === 0) {
    warnings.push(`seed is ${bytes} bytes — over the ${SEED_TARGET_BYTES}-byte target (accepted; the hard cap is ${SEED_HARD_CAP_BYTES})`);
  }
  const ok = findings.length === 0;
  return Object.assign(base, { ok, refused: !ok, header, sections: out, findings, warnings });
}

/**
 * The ASSIGNMENT rows as {objective, ledger, next} (bullets stripped, `key: value`), or
 * {none:true}, or null when the section is absent. Shared by the writer's binding check
 * and the emergency-seed carrier, so the three read ONE shape.
 */
function assignmentFields(sections) {
  const sec = sections && sections.ASSIGNMENT;
  if (!sec) return null;
  const rows = (sec.inline ? [sec.inline, ...sec.rows] : sec.rows).filter((r) => String(r).trim() !== "");
  if (rows.length === 1 && isNone(stripBullet(rows[0]))) return { none: true };
  const out = { none: false };
  for (const r of rows) {
    const m = /^([a-z]+)\s*:\s*(.*)$/i.exec(stripBullet(r).trim());
    if (m && ASSIGNMENT_KEYS.includes(m[1].toLowerCase()) && !(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function checkAssignment(rows, line, add) {
  const seen = new Set();
  for (const r of rows) {
    const m = /^([a-z]+)\s*:\s*(.*)$/i.exec(stripBullet(r).trim());
    if (!m || !ASSIGNMENT_KEYS.includes(m[1].toLowerCase())) {
      add("assignment-row-invalid", "ASSIGNMENT", 1, `ASSIGNMENT rows are '${ASSIGNMENT_KEYS.join(": … | ")}: …' (got ${JSON.stringify(String(r).slice(0, 80))})`);
      continue;
    }
    const key = m[1].toLowerCase();
    if (seen.has(key)) add("assignment-row-duplicate", "ASSIGNMENT", 1, `ASSIGNMENT carries '${key}' more than once`);
    seen.add(key);
    const val = m[2].trim();
    if (!answered(val)) add("assignment-field-missing", "ASSIGNMENT", 1, `ASSIGNMENT '${key}' is empty`);
    else if (key === "objective" && !/^".+"$/s.test(val)) add("assignment-objective-unquoted", "ASSIGNMENT", 1, "ASSIGNMENT objective must be the owner's wording VERBATIM, inside double quotes — a paraphrase is how an assignment collapses into a label");
  }
  for (const key of ASSIGNMENT_KEYS) {
    if (!seen.has(key)) add("assignment-field-missing", "ASSIGNMENT", 1, `ASSIGNMENT (line ${line}) lacks '${key}:' — write all of ${ASSIGNMENT_KEYS.join(", ")}, or 'ASSIGNMENT: none'`);
  }
}

function checkRole(content, add) {
  const role = content.split(/\s+/)[0] || "";
  if (!/^(orchestrator|workhorse|lane)\b/i.test(role)) {
    add("role-unrecognised", "ROLE", 1, `ROLE must begin with orchestrator | workhorse(<lane>) | lane (got ${JSON.stringify(role)})`);
  }
  const kv = {};
  for (const cell of content.split(/\s\|\s/)) {
    const m = /^\s*([a-z][a-z-]*)=(.*)$/i.exec(cell);
    if (m) kv[m[1].toLowerCase()] = m[2].trim();
  }
  for (const key of ["repo", "trunk", "posture", "msg-name"]) {
    if (!answered(kv[key])) add("role-field-missing", "ROLE", 1, `ROLE lacks ${key}=<value> — the resumed agent cannot tell ${key === "repo" ? "WHERE it is" : key === "trunk" ? "which trunk it lands on" : key === "posture" ? "its trust posture" : "its messaging name to re-assert"}`);
  }
  if (answered(kv.repo) && !kv.repo.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(kv.repo)) {
    add("role-repo-not-absolute", "ROLE", 1, `ROLE repo= must be an absolute path (got ${JSON.stringify(kv.repo)})`);
  }
}

function checkNext(content, add, repoDir) {
  const idx = content.search(/\|\s*re-validate:/i);
  if (idx >= 0 && !readonlyCommand(content.slice(idx).replace(/^\|\s*re-validate:/i, ""), repoDir)) {
    add("command-not-readonly", "NEXT", 5, "re-validate must be one supported readonly command; shell operators and unknown capabilities are refused");
  }
  if (idx < 0) {
    add("next-revalidate-missing", "NEXT", 5, "NEXT must read '<one imperative> | re-validate: <command → meaning still true>' — without the re-validation the first action rests on a pre-boundary belief");
  }
  const action = (idx < 0 ? content : content.slice(0, idx)).trim();
  if (!answered(action)) {
    add("next-action-missing", "NEXT", 5, "NEXT has no action before '| re-validate:'");
    return;
  }
  if (idx >= 0 && !answered(content.slice(idx).replace(/^\|\s*re-validate:/i, ""))) {
    add("next-revalidate-missing", "NEXT", 5, "NEXT's re-validate: is empty");
  }
  if (countInlineItems(action) > 1 && /(?:^|\s)(?:\(([a-z]|\d{1,2})\)|\d{1,2}[.)])\s/i.test(action)) {
    add("next-plural", "NEXT", 5, "NEXT enumerates more than one action; it must be exactly ONE imperative — put the rest in QUEUED");
  }
}

function checkRow(s, names, rowText, line, ordinal, add, repoDir) {
  const cells = splitCells(rowText, s.cells);
  if (["IN FLIGHT", "OWNED BY OTHERS"].includes(s.label) && cells.length >= s.cells && !readonlyCommand(cells[s.cells - 1], repoDir)) {
    add("command-not-readonly", s.label, s.question, "re-check must be one supported readonly command; shell operators and unknown capabilities are refused");
  }
  const where = ordinal ? `row ${ordinal} (line ${line})` : `inline row (line ${line})`;
  if (cells.length < s.cells) {
    add("row-short", s.label, s.question, `${s.label} ${where} has ${cells.length} of ${s.cells} cells (${names.join(" | ")}); missing: ${names.slice(cells.length).join(", ")}`);
  }
  names.forEach((name, k) => {
    if (k >= cells.length) return;
    if (!answered(cells[k])) add("row-cell-empty", s.label, s.question, `${s.label} ${where}: '${name}' is empty`);
  });
  if (s.label === "PENDING DECISIONS" && cells.length >= 3 && answered(cells[2])) {
    const d = cells[2].trim().toUpperCase();
    if (!DECIDERS.includes(d)) add("decision-decider-invalid", s.label, 4, `${s.label} ${where}: decides must be HUMAN or ORCHESTRATOR (got ${JSON.stringify(cells[2].trim())})`);
  }
}

/** One-line summary of a verdict, for CLIs and hooks. */
function summarize(v) {
  if (v.ok) return `seed OK — ${v.bytes} B (target ${v.target_bytes}, cap ${v.cap_bytes}) sha256 ${v.sha256.slice(0, 8)} resume ${v.header.resume_token}`;
  return `seed REFUSED — ${v.findings.length} finding(s); ${v.bytes} B sha256 ${v.sha256.slice(0, 8)}`;
}

module.exports = {
  SEED_SCHEMA,
  SEED_TARGET_BYTES,
  SEED_HARD_CAP_BYTES,
  MECHANICAL_CAP_BYTES,
  SECTIONS,
  SECTION_LABELS,
  CELL_NAMES,
  ASSIGNMENT_KEYS,
  DECIDERS,
  FOOTER,
  parseSeed,
  validateSeed,
  clockIso,
  WRITTEN_FUTURE_SKEW_MS,
  WRITTEN_PAST_SKEW_MS,
  assignmentFields,
  splitCells,
  stripBullet,
  summarize,
};
