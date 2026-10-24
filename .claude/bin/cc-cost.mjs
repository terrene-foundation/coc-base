#!/usr/bin/env node
// cc-cost.mjs — per-project Claude Code cost, computed locally.
//
// Cross-platform (macOS / Linux / Windows), Node built-ins only, ZERO dependencies.
// Port of scripts/cc-cost.py. Reads the transcripts Claude Code writes under
// <home>/.claude/projects/ and values token usage at Anthropic API list prices,
// grouped by project.
//
// WHAT "COST" MEANS: Claude Code never persists a dollar figure, only exact token
// counts per assistant message. This re-values those tokens at API list rates —
// approximate real spend under API-key billing, notional under a flat subscription.
//
// Handles the traps a naive sum misses: subagent transcripts
// (<proj>/<sessionId>/subagents/agent-*.jsonl), the usage.iterations[] duplicate,
// the 1h/5m cache-write tiers, dedup of resumed/forked sessions, and fast mode.
//
// USAGE
//   node cc-cost.mjs                     # per-project table, all history
//   node cc-cost.mjs --since 2026-07-01  # only messages at/after a date (UTC midnight)
//   node cc-cost.mjs --since 2026-10-11T14:00Z        # ... or an instant (Z or offset)
//   node cc-cost.mjs --since 2026-10-11T22:00+08:00   # same instant as above
//   node cc-cost.mjs --sessions          # break down per session
//   node cc-cost.mjs --by-model          # break down per model
//   node cc-cost.mjs --no-fold           # keep worktrees/subdirs separate (default: fold)
//   node cc-cost.mjs --top 20            # only the N costliest projects
//   node cc-cost.mjs --json              # machine-readable output
//   node cc-cost.mjs --rates rates.json  # override the rate table
//
// Requires Node 14+.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { isMainModule } from "./lib/entry-point.mjs";
import process from "node:process";

// --since is an INSTANT, compared as epoch milliseconds — never as a string.
//
// Accepted shapes (anything else is rejected loudly by parseArgs):
//   YYYY | YYYY-MM | YYYY-MM-DD                  -> 00:00:00.000 UTC on that day
//   YYYY-MM-DDTHH:MM[:SS[.fff]](Z|+HH:MM|-HH:MM)  -> that instant
// A datetime WITHOUT a zone designator is rejected: it would silently mean
// "whatever this machine's local zone is", and the transcripts are written in UTC.
// Every calendar field is range-checked by hand, because Date.parse is lenient
// where this must not be: it accepts 2026-02-30 and rolls it into March.
// Fractional seconds are capped at 3 digits — the precision the transcript
// timestamps carry — so a since value is never silently truncated.
const SINCE_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const SINCE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based; day 0 of m+1 = last of m
}

// Returns epoch milliseconds, or null when the input is not an accepted shape or
// names an impossible calendar value.
function parseSince(s) {
  if (typeof s !== "string") return null;
  let m = SINCE_DATE_RE.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = m[2] === undefined ? 1 : Number(m[2]);
    const d = m[3] === undefined ? 1 : Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    const t = Date.UTC(y, mo - 1, d);
    // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear pins the literal year.
    const dt = new Date(t);
    dt.setUTCFullYear(y);
    return dt.getTime();
  }
  m = SINCE_DATETIME_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, hh, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  let offMin = 0;
  if (m[8] !== "Z") {
    const oh = Number(m[8].slice(1, 3));
    const om = Number(m[8].slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offMin = (m[8][0] === "+" ? 1 : -1) * (oh * 60 + om);
  }
  const dt = new Date(Date.UTC(2000, mo - 1, d, hh, mi, ss, ms));
  dt.setUTCFullYear(y, mo - 1, d);
  return dt.getTime() - offMin * 60_000;
}
function isValidSince(s) {
  return parseSince(s) !== null;
}

// A transcript timestamp as epoch ms, or null when absent/unparseable. Claude Code
// writes ISO-8601 UTC with milliseconds ("2026-10-11T14:00:00.123Z").
function tsMs(v) {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// A single transcript larger than this is skipped rather than read whole into a
// ~512MB string (readFileSync + split). Bounds worst-case transient memory; a
// real Claude Code transcript is orders of magnitude smaller.
const MAX_FILE_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Rate table: API list prices in USD per 1,000,000 tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (verified 2026-07-15).
// Longest SEGMENT-prefix match wins ("claude-opus-4-8" resolves before "claude-opus").
// Cache multipliers: 5m=1.25x, 1h=2x, read=0.1x of base input (same for every model).
// Current Opus 4.5-4.8 = $5/$25 (NOT the deprecated Opus 4.1/4 $15/$75); Sonnet 5 shows
// introductory pricing ($2/$10 through 2026-08-31, then $3/$15). inference_geo="us"
// (+10%) and >200k-context surcharges are NOT modelled.
// ---------------------------------------------------------------------------
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const rrow = (input, output) => ({
  input,
  output,
  cache_read: round4(input * 0.1),
  cache_write_5m: round4(input * 1.25),
  cache_write_1h: round4(input * 2.0),
});

const DEFAULT_RATES = {
  // Current Opus (4.5-4.8): $5 / $25
  "claude-opus-4-8": rrow(5.0, 25.0),
  "claude-opus-4-7": rrow(5.0, 25.0),
  "claude-opus-4-6": rrow(5.0, 25.0),
  "claude-opus-4-5": rrow(5.0, 25.0),
  // Deprecated Opus (4.1, 4): $15 / $75
  "claude-opus-4-1": rrow(15.0, 75.0),
  "claude-opus-4-0": rrow(15.0, 75.0),
  "claude-3-opus": rrow(15.0, 75.0),
  // Generic Opus fallback -> current pricing
  "claude-opus": rrow(5.0, 25.0),
  // Sonnet 5 introductory ($2/$10 through 2026-08-31; $3/$15 after)
  "claude-sonnet-5": rrow(2.0, 10.0),
  "claude-sonnet-4": rrow(3.0, 15.0),
  "claude-sonnet-3": rrow(3.0, 15.0),
  "claude-sonnet": rrow(3.0, 15.0),
  // Haiku
  "claude-haiku-4": rrow(1.0, 5.0),
  "claude-haiku-3-5": rrow(0.8, 4.0),
  "claude-3-5-haiku": rrow(0.8, 4.0),
  "claude-haiku": rrow(1.0, 5.0),
  // Fable / Mythos 5
  "claude-fable-5": rrow(10.0, 50.0),
  "claude-mythos-5": rrow(10.0, 50.0),
};
// Fast-mode rates (usage.speed === "fast"), Opus 4.7/4.8 only.
const FAST_RATES = {
  "claude-opus-4-8": rrow(10.0, 50.0),
  "claude-opus-4-7": rrow(30.0, 150.0),
};
const WEB_SEARCH_PER_REQUEST = 0.01; // $10 / 1k requests
const WEB_FETCH_PER_REQUEST = 0.0; // no additional charge beyond token cost

// A per-message token field above this is corrupt (real max ~context-window, ~1e7);
// the ceiling also keeps cost = tokens x rate from overflowing to Infinity.
const MAX_TOK = 1e15;
const MAX_RATE = 1e6; // $/MTok; anything above is nonsense and risks a cost overflow
const RATE_KEYS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"];

// --- coercion helpers: never trust the shape of a value from a JSON transcript ---
function tok(v) {
  // Non-negative int in [0, MAX_TOK]; anything else (string, bool, negative,
  // NaN/Infinity, absurdly-huge) -> 0. Guards crashes, negative cost, overflow.
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_TOK) return 0;
  return Math.floor(v);
}
function asDict(v) {
  // v if it is a plain object, else {} — so a malformed non-dict nested field
  // (cache_creation / server_tool_use / message) can't throw.
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function asStr(v) {
  return typeof v === "string" ? v : null;
}

function matchTable(model, table) {
  // Longest SEGMENT-prefix match: `claude-opus-4-8` matches `claude-opus-4-8`,
  // `claude-opus-4`, `claude-opus` — but `claude-opus-4-10` does NOT match the
  // deprecated `claude-opus-4-1` row (two-digit minor must not collide with one-digit).
  if (typeof model !== "string" || !model) return null;
  let best = null;
  for (const prefix of Object.keys(table)) {
    if (
      (model === prefix || model.startsWith(prefix + "-")) &&
      (best === null || prefix.length > best.length)
    ) {
      best = prefix;
    }
  }
  return best !== null ? table[best] : null;
}
function matchRate(model, rates, fast) {
  if (fast) {
    const r = matchTable(model, FAST_RATES);
    if (r) return r;
  }
  return matchTable(model, rates);
}

// --- rate-table (--rates) validation ---
const rateOk = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_RATE;

function validateRates(rates, path) {
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) {
    die(`--rates ${path}: top level must be an object of model -> rate row`);
  }
  for (const [model, row] of Object.entries(rates)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      die(`--rates ${path}: row for "${model}" must be an object`);
    }
    const bad = RATE_KEYS.filter((k) => !rateOk(row[k]));
    if (bad.length) {
      die(
        `--rates ${path}: row for "${model}" has missing/invalid key(s): ` +
          `${bad.join(", ")} (each required as a finite number in [0, ${MAX_RATE}] $/MTok)`,
      );
    }
  }
}

function newBucket() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cw5: 0,
    cw1: 0,
    web_search: 0,
    web_fetch: 0,
    cost: 0,
    sessions: new Set(),
  };
}

function addUsage(b, u, model, rates, sid) {
  const ci = tok(u.input_tokens);
  const co = tok(u.output_tokens);
  const cwTotal = tok(u.cache_creation_input_tokens);
  const cr = tok(u.cache_read_input_tokens);
  const cc = asDict(u.cache_creation);
  let cw1 = tok(cc.ephemeral_1h_input_tokens);
  let cw5 = tok(cc.ephemeral_5m_input_tokens);
  // Reconcile against the authoritative flat total: whatever the enumerated
  // tiers do NOT account for (an empty dict, a partial dict, or a future tier
  // key this build doesn't know) is attributed to 5m rather than silently
  // dropped at $0. When the tiers already sum to (or above) the total, this is
  // a no-op — so a normal 5m/1h breakdown is unchanged.
  if (cwTotal > cw5 + cw1) cw5 += cwTotal - cw5 - cw1;
  const stu = asDict(u.server_tool_use);
  const ws = tok(stu.web_search_requests);
  const wf = tok(stu.web_fetch_requests);
  const fast = u.speed === "fast";

  b.input += ci;
  b.output += co;
  b.cache_read += cr;
  b.cw5 += cw5;
  b.cw1 += cw1;
  b.web_search += ws;
  b.web_fetch += wf;
  if (sid) b.sessions.add(sid);

  // Server-tool cost is per-request and model-independent -> always counted.
  b.cost += ws * WEB_SEARCH_PER_REQUEST + wf * WEB_FETCH_PER_REQUEST;
  const r = matchRate(model, rates, fast);
  if (!r) return;
  b.cost +=
    (ci * r.input +
      co * r.output +
      cr * r.cache_read +
      cw5 * r.cache_write_5m +
      cw1 * r.cache_write_1h) /
    1_000_000;
}

function decodeProjectDir(name) {
  // Fallback label from Claude Code's folder name (cwd with path-sep -> '-').
  // Lossy; only used when a transcript line carries no `cwd` field.
  const p = name.replace(/^-+/, "");
  return p ? "/" + p.split("-").join("/") : name;
}

function resolveRepoRoot(cwd, cache) {
  // Fold worktrees + subdirs into the one git repo root they belong to, via
  // `git --git-common-dir` (worktrees share one common .git; its parent is the
  // repo root). Falls back to the cwd when the dir is gone, not a repo, or git
  // is not installed. Cached per cwd (the git call is the slow part).
  if (!cwd) return cwd;
  if (cache.has(cwd)) return cache.get(cwd);
  let root = cwd;
  // Skip the subprocess entirely unless cwd is a real directory — a transcript
  // carries arbitrary cwd strings, and spawning `git` on each non-existent one
  // is wasted process churn (bounds worst-case spawn count to real dirs).
  let isRealDir = false;
  try {
    isRealDir = statSync(cwd).isDirectory();
  } catch {
    isRealDir = false;
  }
  if (!isRealDir) {
    cache.set(cwd, root);
    return root;
  }
  try {
    // Defense-in-depth: cwd is untrusted input, so neutralize every git surface
    // an in-tree config could hijack — command-line `-c` overrides even a
    // repo-local .git/config, and the env vars disable system + global config.
    // `rev-parse --git-common-dir` invokes none of these today (no index refresh,
    // no hooks, no pager), so this is belt-and-suspenders, not a live exec surface.
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        cwd,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
    if (out) {
      const parts = out.split(/[/\\]/);
      if (parts[parts.length - 1] === ".git") root = parts.slice(0, -1).join("/");
      else root = out;
    }
  } catch {
    // git missing / not a repo / timeout -> keep the cwd as its own group
  }
  cache.set(cwd, root);
  return root;
}

// Directories this run could NOT list. Every skip silently REDUCES a dollar figure
// the operator reads as the total, and an under-count is indistinguishable from
// genuinely-lower usage (`verification-gate-integrity.md` MUST-2 — absence of a
// result is not a pass). ENOENT is deliberately EXCLUDED: several call sites probe
// an OPTIONAL directory, so counting absence as "unreadable" reports a hole where
// there is none — the very conflation this counter exists to expose (the template's
// measurement: 835 false "unreadable" directories on the first instrumented run,
// every one absent). Operator-ratified Gate-1 port, 2026-10-06.
const SKIPPED = { dirs: 0 };

function listDir(p) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch (e) {
    if (!e || e.code !== "ENOENT") SKIPPED.dirs++;
    return [];
  }
}

function* usageLines(fp, maxBytes = MAX_FILE_BYTES) {
  let content;
  try {
    // Skip a pathologically large transcript rather than load ~512MB into one
    // string (+ split doubling it). A real transcript is far smaller.
    // maxBytes is injectable so the skip branch is testable with a tiny cap.
    if (statSync(fp).size > maxBytes) return;
    content = readFileSync(fp, "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip malformed line
    }
  }
}

// WHY ONE MESSAGE IS ONE (survivor, instant) PAIR, CHOSEN BEFORE ANY WINDOW.
//
// Claude Code streams one assistant message as SEVERAL transcript lines that share
// (message.id, requestId), each stamped a little later and each carrying a usage
// block — and output_tokens GROWS across them; only the LAST line holds the
// message's final usage. Measured over one day of real transcripts: 115,966
// multi-line messages; on every one the last line held the largest output_tokens,
// and the first lines summed to ~29% less output than the last lines.
//
// The previous shape filtered each LINE by --since and THEN deduped, keeping the
// first line that survived the filter. That made the counted record depend on the
// window: with an earlier start the first (smallest) line won; with a start that
// fell between a message's lines, a later (larger) line won — so a LATER start
// could report MORE cost. It also under-counted output on every unwindowed run.
//
// Now, per transcript file, every line of a message is grouped first; the
// message's representative is the line with the LARGEST output_tokens — ties go
// to the later line, so when only input moves into cache-read the final record
// still wins — and its instant is its EARLIEST line's timestamp (when it
// started). "Last line in file order" alone is not enough: an older partial
// line re-appended later would replace the final usage AND move its project.
// Across files the first file (sorted order) to carry a message keeps it — a
// resumed/forked copy is a duplicate — and that choice is made over EVERY line,
// in or out of the window. --since then includes or excludes whole messages by
// their fixed instant. Because neither the representative, its project, nor its
// instant depends on --since, cost(since t2) <= cost(since t1) for t1 <= t2.
function collect(projectsDir, rates, { since = null, fold = true, perSession = false, perModel = false } = {}) {
  const buckets = new Map();
  const subBuckets = new Map(); // key -> Map(subKey -> bucket)
  const unpriced = new Map();
  // NUL-joined (id, requestId) -> was the owning copy counted (inside the window)?
  // Every keyed message enters, in or out of the window, so which file owns a
  // message never depends on --since.
  const owner = new Map();
  const repoCache = new Map();
  const counters = { files: 0, lines: 0, dupes: 0, dirs_skipped: 0 };

  let sinceMs = null;
  if (since !== null && since !== undefined) {
    sinceMs = typeof since === "number" ? since : parseSince(since);
    if (sinceMs === null || !Number.isFinite(sinceMs)) {
      throw new TypeError(`collect: invalid since ${JSON.stringify(since)}`);
    }
  }
  // A message with no parseable timestamp cannot be placed in a window, so it is
  // excluded whenever a window is set (and counted when none is).
  const inWindow = (startMs) => sinceMs === null || (startMs !== null && startMs >= sinceMs);

  const getBucket = (key) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = newBucket()));
    return b;
  };
  const getSub = (key, subKey) => {
    let m = subBuckets.get(key);
    if (!m) subBuckets.set(key, (m = new Map()));
    let b = m.get(subKey);
    if (!b) m.set(subKey, (b = newBucket()));
    return b;
  };

  // The fields accounting reads, coerced once. A message group holds ONLY this
  // (never the parsed line, whose message.content can dwarf the usage block), so
  // per-file memory stays proportional to the message count, not the file size.
  const record = (d, msg, u) => ({ cwd: asStr(d.cwd), sid: asStr(d.sessionId), model: asStr(msg.model), u });

  const account = ({ cwd: rawCwd, sid, model, u }, fallback) => {
    counters.lines++;
    // Coerce every field used as a key / subprocess arg / rate lookup.
    const cwd = rawCwd || fallback;
    const key = fold ? resolveRepoRoot(cwd, repoCache) : cwd;

    addUsage(getBucket(key), u, model, rates, sid);
    if (model && matchRate(model, rates, false) === null) {
      unpriced.set(
        model,
        (unpriced.get(model) || 0) +
          tok(u.input_tokens) +
          tok(u.output_tokens) +
          tok(u.cache_creation_input_tokens) +
          tok(u.cache_read_input_tokens),
      );
    }
    if (perSession) addUsage(getSub(key, sid || "?"), u, model, rates, sid);
    else if (perModel) addUsage(getSub(key, model || "?"), u, model, rates, sid);
  };

  // Sorted so the dedup survivor is deterministic across runs.
  const projDirs = listDir(projectsDir)
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dname of projDirs) {
    const pdir = join(projectsDir, dname);
    const fallback = decodeProjectDir(dname);

    // main-thread transcripts + nested subagent transcripts
    const entries = listDir(pdir);
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(pdir, e.name))
      .sort();
    const subFiles = [];
    for (const sd of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const sap = join(pdir, sd, "subagents");
      for (const e of listDir(sap)) {
        if (e.isFile() && e.name.endsWith(".jsonl")) subFiles.push(join(sap, e.name));
      }
    }
    subFiles.sort();

    for (const fp of [...files, ...subFiles]) {
      counters.files++;
      // dk -> { rec, startMs, n } for this file's keyed messages, in first-seen order.
      const groups = new Map();
      for (const d of usageLines(fp)) {
        const msg = asDict(d.message);
        const u = msg.usage;
        if (!u || typeof u !== "object" || Array.isArray(u)) continue;
        const t = tsMs(d.timestamp);

        // Dedup key must be hashable/comparable — coerce id/requestId to str-or-null.
        const mid = asStr(msg.id);
        const rid = asStr(d.requestId);
        if (mid === null && rid === null) {
          // No key to group on: the line is its own message.
          if (inWindow(t)) account(record(d, msg, u), fallback);
          continue;
        }
        const dk = `${mid}\u0000${rid}`;
        const g = groups.get(dk);
        if (!g) {
          groups.set(dk, { rec: record(d, msg, u), startMs: t, n: 1 });
        } else {
          // Output only grows while a message streams: the largest is the final
          // usage; >= hands a tie to the later line.
          if (tok(u.output_tokens) >= tok(g.rec.u.output_tokens)) g.rec = record(d, msg, u);
          g.n++;
          if (t !== null && (g.startMs === null || t < g.startMs)) g.startMs = t;
        }
      }
      for (const [dk, g] of groups) {
        if (owner.has(dk)) {
          // A copy, in a later file, of a message an earlier file owns. counters.dupes
          // counts every extra line of a COUNTED message, so it moves with the window.
          if (owner.get(dk)) counters.dupes += g.n;
          continue;
        }
        const counted = inWindow(g.startMs);
        owner.set(dk, counted);
        if (!counted) continue;
        counters.dupes += g.n - 1;
        account(g.rec, fallback);
      }
    }
  }
  // Surfaced rather than counted-and-dropped: a counter nothing reads cannot warn
  // anyone, and the under-count it exists to expose is invisible in the totals.
  counters.dirs_skipped = SKIPPED.dirs;
  return { buckets, subBuckets, unpriced, counters };
}

// --- formatting ---
function hn(n) {
  for (const [unit, div] of [["B", 1e9], ["M", 1e6], ["K", 1e3]]) {
    if (Math.abs(n) >= div) return (n / div).toFixed(2) + unit;
  }
  return String(Math.trunc(n));
}
function money(n) {
  const neg = n < 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${neg ? "-" : ""}${grouped}.${dec}`;
}
const pad = (s, w) => String(s).padStart(w);
const padE = (s, w) => String(s).padEnd(w);

function printTable(buckets, subBuckets, top, showSub) {
  const allRows = [...buckets.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const rows = top ? allRows.slice(0, top) : allRows;
  let w = Math.max(...rows.map(([k]) => k.length), "PROJECT".length);
  w = Math.min(w, 60);
  const hdr =
    `${padE("PROJECT", w)}  ${pad("SESS", 5)}  ${pad("INPUT", 8)}  ${pad("OUTPUT", 8)}  ` +
    `${pad("CACHE-W", 8)}  ${pad("CACHE-R", 8)}  ${pad("COST", 11)}`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const [key, b] of rows) {
    const name = key.length <= w ? key : "..." + key.slice(-(w - 3));
    console.log(
      `${padE(name, w)}  ${pad(b.sessions.size, 5)}  ${pad(hn(b.input), 8)}  ${pad(hn(b.output), 8)}  ` +
        `${pad(hn(b.cw5 + b.cw1), 8)}  ${pad(hn(b.cache_read), 8)}  ${pad(money(b.cost), 11)}`,
    );
    if (showSub) {
      const subs = [...(subBuckets.get(key) || new Map()).entries()].sort(
        (a, b2) => b2[1].cost - a[1].cost,
      );
      for (const [sk, sb] of subs) {
        const sname = (sk || "?").slice(0, w - 4);
        console.log(
          `  ${String.fromCharCode(0x2514)} ${padE(sname, w - 4)}  ${pad("", 5)}  ${pad(hn(sb.input), 8)}  ` +
            `${pad(hn(sb.output), 8)}  ${pad(hn(sb.cw5 + sb.cw1), 8)}  ${pad(hn(sb.cache_read), 8)}  ${pad(money(sb.cost), 11)}`,
        );
      }
    }
  }
  if (top && allRows.length > top) {
    console.log(`... ${allRows.length - top} more projects not shown (--top ${top})`);
  }
  // TOTAL over ALL buckets, never the truncated display rows.
  const tot = newBucket();
  for (const [, b] of allRows) {
    tot.input += b.input;
    tot.output += b.output;
    tot.cache_read += b.cache_read;
    tot.cw5 += b.cw5;
    tot.cw1 += b.cw1;
    tot.cost += b.cost;
    for (const s of b.sessions) tot.sessions.add(s);
  }
  console.log("-".repeat(hdr.length));
  console.log(
    `${padE(`TOTAL (${buckets.size} projects)`, w)}  ${pad(tot.sessions.size, 5)}  ${pad(hn(tot.input), 8)}  ` +
      `${pad(hn(tot.output), 8)}  ${pad(hn(tot.cw5 + tot.cw1), 8)}  ${pad(hn(tot.cache_read), 8)}  ${pad(money(tot.cost), 11)}`,
  );
}

function printHelp() {
  console.log(
    [
      "cc-cost — per-project Claude Code cost, computed locally (cross-platform).",
      "",
      "Usage: node cc-cost.mjs [options]",
      "  --projects-dir DIR   default: <home>/.claude/projects",
      "  --since WHEN         only messages that STARTED at/after WHEN, where WHEN is",
      "                       YYYY[-MM[-DD]] (00:00 UTC) or an ISO-8601 instant with a",
      "                       zone: 2026-10-11T14:00Z, 2026-10-11T22:00:30.5+08:00",
      "  --sessions           break down per session within each project",
      "  --by-model           break down per model (ignored if --sessions is set)",
      "  --no-fold            do NOT fold worktrees/subdirs into their repo root",
      "  --rates FILE         JSON file overriding the rate table",
      "  --top N              show only the N costliest projects",
      "  --json               machine-readable output",
      "  -h, --help           this help",
    ].join("\n"),
  );
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const a = {
    projectsDir: join(homedir(), ".claude", "projects"),
    since: null,
    sessions: false,
    byModel: false,
    noFold: false,
    rates: null,
    top: 0,
    json: false,
  };
  // A value-taking flag as the LAST arg (or followed by another flag) would
  // otherwise swallow `undefined` and silently no-op / mis-default. Fail loud.
  const needVal = (flag, v) => {
    if (v == null || (typeof v === "string" && v.startsWith("--"))) {
      die(`${flag}: expected a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--help" || x === "-h") {
      printHelp();
      process.exit(0);
    } else if (x === "--projects-dir") a.projectsDir = needVal("--projects-dir", argv[++i]);
    else if (x === "--since") {
      a.since = needVal("--since", argv[++i]);
      if (!isValidSince(a.since)) {
        die(
          `--since ${a.since}: expected YYYY, YYYY-MM, YYYY-MM-DD, or an ISO-8601 instant with a ` +
            `zone (e.g. 2026-10-11T14:00Z or 2026-10-11T22:00+08:00); a datetime without Z/offset ` +
            `is rejected as ambiguous`,
        );
      }
    } else if (x === "--sessions") a.sessions = true;
    else if (x === "--by-model") a.byModel = true;
    else if (x === "--no-fold") a.noFold = true;
    else if (x === "--rates") a.rates = needVal("--rates", argv[++i]);
    // A negative --top would slice(0, -n) and silently DROP the last n rows;
    // clamp to >=0 (0 = show all, matching the no-flag default).
    else if (x === "--top") a.top = Math.max(0, parseInt(needVal("--top", argv[++i]), 10) || 0);
    else if (x === "--json") a.json = true;
    else die(`unknown argument: ${x} (try --help)`);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isDir(args.projectsDir)) die(`projects dir not found: ${args.projectsDir}`);

  let rates = DEFAULT_RATES;
  if (args.rates) {
    let raw;
    try {
      raw = readFileSync(args.rates, "utf8");
    } catch (e) {
      die(`--rates ${args.rates}: cannot read file (${e.code || e.message})`);
    }
    try {
      rates = JSON.parse(raw);
    } catch (e) {
      die(`--rates ${args.rates}: not valid JSON (${e.message})`);
    }
    validateRates(rates, args.rates);
  }

  const { buckets, subBuckets, unpriced, counters } = collect(args.projectsDir, rates, {
    since: args.since ? parseSince(args.since) : null,
    fold: !args.noFold,
    perSession: args.sessions,
    perModel: args.byModel,
  });

  if (args.json) {
    // null-proto: a project key literally named "__proto__" is an own key, not
    // a hit on the prototype setter (which would silently drop that bucket).
    const projects = Object.create(null);
    for (const [k, b] of buckets) {
      projects[k] = {
        cost_usd: round4(b.cost),
        sessions: b.sessions.size,
        input_tokens: b.input,
        output_tokens: b.output,
        cache_write_5m: b.cw5,
        cache_write_1h: b.cw1,
        cache_read_tokens: b.cache_read,
        web_search_requests: b.web_search,
        web_fetch_requests: b.web_fetch,
      };
    }
    const out = {
      generated_from: args.projectsDir,
      note: "cost = token consumption valued at API list prices; notional under a subscription",
      counters,
      unpriced_models: Object.fromEntries(unpriced),
      projects,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("Claude Code cost by project  (token consumption x API list prices)");
  console.log(
    `source: ${args.projectsDir}   scanned ${counters.files.toLocaleString("en-US")} files, ` +
      `${counters.lines.toLocaleString("en-US")} messages, deduped ${counters.dupes.toLocaleString("en-US")}\n`,
  );
  if (counters.dirs_skipped) {
    console.log(
      `WARN: ${counters.dirs_skipped} director(y/ies) could not be listed — any transcripts under them ` +
        `are MISSING from every figure below (an under-count, not lower usage).\n`,
    );
  }
  printTable(buckets, subBuckets, args.top, args.sessions || args.byModel);

  if (unpriced.size) {
    console.log("\nUNPRICED models (add to the rate table for accurate cost):");
    for (const [m, t] of [...unpriced.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${m}: ${hn(t)} tokens`);
    }
  }
  console.log("\nNote: under a Claude subscription these dollars are NOTIONAL (flat billing);");
  console.log("they equal real spend only for API-key metered usage. Rates are list prices — edit the");
  console.log("DEFAULT_RATES table or pass --rates to match your contract.");
}

// Testable surface (imported by cc-cost.test.mjs; the CLI entry is main()).
export {
  round4,
  rrow,
  DEFAULT_RATES,
  FAST_RATES,
  MAX_TOK,
  MAX_RATE,
  RATE_KEYS,
  MAX_FILE_BYTES,
  parseSince,
  isValidSince,
  tsMs,
  tok,
  asDict,
  asStr,
  matchTable,
  matchRate,
  rateOk,
  validateRates,
  newBucket,
  addUsage,
  decodeProjectDir,
  resolveRepoRoot,
  usageLines,
  collect,
  hn,
  money,
  parseArgs,
  main,
};

// Run only when invoked directly (NOT when imported by the test).
// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  main();
}
