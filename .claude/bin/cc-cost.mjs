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
//   node cc-cost.mjs --since 2026-07-01  # only messages at/after a date
//   node cc-cost.mjs --sessions          # break down per session
//   node cc-cost.mjs --by-model          # break down per model
//   node cc-cost.mjs --no-fold           # keep worktrees/subdirs separate (default: fold)
//   node cc-cost.mjs --top 20            # only the N costliest projects
//   node cc-cost.mjs --json              # machine-readable output
//   node cc-cost.mjs --rates rates.json  # override the rate table
//
// Requires Node 14+.

import { readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

// --since is compared LEXICALLY against ISO-8601 timestamps. It is documented as
// date-granularity (YYYY / YYYY-MM / YYYY-MM-DD) and is restricted to that shape
// on purpose: a non-date string (e.g. "notadate") would sort ABOVE every
// timestamp and silently skip ALL messages, and a TIME suffix would mis-order
// against millisecond timestamps in the boundary second (`…:00Z` vs `…:00.5Z`).
// A bare date prefix is always < any longer timestamp that shares it, so the
// lexical compare is exact. `isValidSince` additionally rejects a shaped-but-
// impossible date like 2026-99-99 (which would also empty the report).
const SINCE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
function isValidSince(s) {
  return SINCE_RE.test(s) && !Number.isNaN(Date.parse(s));
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

function listDir(p) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
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

function collect(projectsDir, rates, { since = null, fold = true, perSession = false, perModel = false } = {}) {
  const buckets = new Map();
  const subBuckets = new Map(); // key -> Map(subKey -> bucket)
  const unpriced = new Map();
  const seen = new Set(); // NUL-joined (id, requestId) dedup key
  const repoCache = new Map();
  const counters = { files: 0, lines: 0, dupes: 0 };

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
      for (const d of usageLines(fp)) {
        if (since && String(d.timestamp || "") < since) continue;
        const msg = asDict(d.message);
        const u = msg.usage;
        if (!u || typeof u !== "object" || Array.isArray(u)) continue;

        // Dedup key must be hashable/comparable — coerce id/requestId to str-or-null.
        const mid = asStr(msg.id);
        const rid = asStr(d.requestId);
        if (!(mid === null && rid === null)) {
          const dk = `${mid}\u0000${rid}`;
          if (seen.has(dk)) {
            counters.dupes++;
            continue;
          }
          seen.add(dk);
        }
        counters.lines++;

        // Coerce every field used as a key / subprocess arg / rate lookup.
        let cwd = asStr(d.cwd);
        if (!cwd) cwd = fallback;
        const key = fold ? resolveRepoRoot(cwd, repoCache) : cwd;
        const model = asStr(msg.model);
        const sid = asStr(d.sessionId);

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
      }
    }
  }
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
      "  --since YYYY-MM-DD    only messages at/after this date (date granularity)",
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
        die(`--since ${a.since}: expected a valid date (YYYY-MM-DD, YYYY-MM, or YYYY)`);
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
    since: args.since || null,
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
  SINCE_RE,
  isValidSince,
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

// Run only when invoked directly (NOT when imported by the test). Compare REAL
// paths on both sides: import.meta.url is symlink-resolved, and the invocation
// path (process.argv[1]) may be a symlink on PATH — realpathSync resolves it so
// a symlinked launcher still runs main() (and Windows file:///C:/… is handled
// by fileURLToPath). Any resolution error falls back to NOT running main.
let _runDirect = false;
try {
  _runDirect =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  _runDirect = false;
}
if (_runDirect) {
  main();
}
