#!/usr/bin/env node
// The process-spawning-harness scrub: FIRST import, per the harness contract (the live
// sweep spawns `git ls-files`).
import "../_lib/no-ambient-git.cjs";
/*
 * Audit fixture runner — `rules/security.md` § Path Containment, Phase 2.
 *
 * Drives `.claude/bin/lib/path-containment-scan.mjs` two ways:
 *   1. the bipolar fixtures beside this file (`<name>.case.txt` JS source + `<name>.expected`
 *      answer key `[{line, arm}]`), each PROVED to discriminate:
 *        flag-*   fires exactly as expected, and the hit DISAPPEARS with only its arm disabled;
 *        clean-*  is silent, and FLAGS once its named silencer (CLEAN_SILENCER) is removed;
 *        blind-*  is a real violation the detector is silent on BY CONSTRUCTION — printed as
 *                 BLIND, never PASS, never counted as coverage.
 *   2. a LIVE sweep of the tracked trust code that mentions realpath — `.claude/**`,
 *      `.codex-mcp-guard/**` and `scripts/ci/**` JS (tests, fixtures and the test harness
 *      excluded; the two non-.claude roots were added after train-8 R1 security F7 found them
 *      unswept) — reconciled BOTH ways against `acknowledged-sites.json`: an unacknowledged hit
 *      FAILS, and an acknowledgement with no live hit FAILS as stale. An acknowledgement must
 *      carry an `expires` ISO date that has not passed AND lies at most ACK_HORIZON_DAYS after
 *      the date the registry was committed (today while it is uncommitted), a `tracking`
 *      reference of a checked shape (an issue `#N` / `owner/repo#N`, or a journal / workspaces
 *      path that EXISTS), and the `site_sha256` of the comparison it excuses AND its enclosing
 *      decision — so it can neither live forever, nor cite nothing, nor survive the site being
 *      rewritten or its polarity flipped (R1 F4, F5; R2 security N7, correctness R2-2).
 *   3. a NAME census over EVERY tracked JS file in that population (not only the realpath-
 *      mentioning ones): any definition carrying a DECLARED resolver's name, or `realpathNative`,
 *      must itself be a pure resolver, so a same-named stand-in cannot borrow the trust (R1
 *      correctness F4, R2 security N8); and one that can LEND trust across files (an EXPORTED
 *      definition, or any `realpathNative`) must infer exactly its declared family (R2-4).
 *
 * The `.case.txt` extension is deliberate: the live sweep never scans its own positives,
 * and nothing parses them as shipped code. Synthetic roots only (/srv/sandbox).
 * Gate-time, not a hook: the failure is a file AT REST. Exit 0 = all pass; 1 = any fail.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, SILENCERS, DECLARED_RESOLVERS, ROOT_RESOLVING_COMPARATORS, loadAcorn, parseSource, scanSource, resolverDefinitions, definitionNames, exportedNames } from "../../bin/lib/path-containment-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

// Denominator floors, from an ACTUAL run through trestle (2026-10-17, train-8 R2 fix round, both
// OS): `census: 154 files · 203 comparisons · 64 REAL-tagged`. The REAL-tagged count fell from 67
// (R1, tree 2d9a93d7a30b) because the R2 N1 fix moved three worktree decisions (occupancy, the
// reclaimer's main/current, the cache-GC allow-list) from realpath STRING comparisons to (dev, ino)
// identity, which no longer reads as a path comparison. They detect a DROP only — raise them when
// the tree grows.
const FLOOR_FILES = 154;
const FLOOR_REAL_COMPARISONS = 64;

// Each clean-* case names the precision rule it proves; the baseline proves no arm over-fires.
const CLEAN_SILENCER = {
  "clean-both-realpath-same-resolver": null,
  "clean-both-via-realpathForContainment-isWithinRoot": "declared-resolvers",
  "clean-null-sentinel-strict-helper": "null-not-raw",
  "clean-join-on-real-root-absent-tail": "real-derived-join",
  "clean-relative-as-label-only": "relative-flow",
  "clean-same-name-different-scope": "scope",
  "clean-comparison-in-comment-and-string": "ast",
  "clean-conditional-sep-idiom": "conditional-sep",
  "clean-prefix-strip-display-label": "label-strip",
  "clean-enoent-lstat-climb": "enoent-lstat-climb",
  "clean-enoent-lstat-return-climb": "enoent-lstat-climb",
  "clean-enoent-absence-flag-climb": "enoent-lstat-climb",
  "clean-helper-chain-rederived": "fixpoint-rederive",
};

let passed = 0;
let failed = 0;
let blind = 0;
const check = (name, ok, detail) => {
  if (ok) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (detail) process.stderr.write(`        ${detail}\n`);
  }
};
const without = (all, x) => new Set(all.filter((a) => a !== x));
const key = (h) => `${h.line}:${h.arm}`;
const keys = (hs) => hs.map(key).sort();

// ── parser ──
{
  let ok = false;
  let why = "";
  try {
    loadAcorn();
    ok = parseSource(readFileSync(fileURLToPath(import.meta.url), "utf8")).type === "Program";
  } catch (e) {
    why = e.message;
  }
  check("parser-loads", ok, why || "the bundled acorn did not parse this runner");
}

// ── fixtures ──
const cases = readdirSync(HERE).filter((f) => f.endsWith(".case.txt")).map((f) => f.slice(0, -".case.txt".length)).sort();
check("fixtures-present", cases.length >= 18, `${cases.length} case(s)`);
const armsProved = new Set();
const silencersProved = new Set();
for (const name of cases) {
  const src = readFileSync(path.join(HERE, `${name}.case.txt`), "utf8");
  const expPath = path.join(HERE, `${name}.expected`);
  if (!existsSync(expPath)) {
    check(`${name}/has-answer-key`, false, `${name}.expected is missing`);
    continue;
  }
  const expected = JSON.parse(readFileSync(expPath, "utf8"));
  let full;
  try {
    full = scanSource(src).findings;
  } catch (e) {
    check(`${name}/parses`, false, e.message);
    continue;
  }
  if (name.startsWith("flag-")) {
    check(`${name}/fires-as-expected`, JSON.stringify(keys(full)) === JSON.stringify(keys(expected)) && expected.length > 0, `got ${JSON.stringify(keys(full))} want ${JSON.stringify(keys(expected))}`);
    for (const arm of new Set(expected.map((h) => h.arm))) {
      const lines = new Set(expected.filter((h) => h.arm === arm).map((h) => h.line));
      const off = scanSource(src, { arms: without(ARMS, arm) }).findings.filter((h) => lines.has(h.line));
      check(`${name}/${arm}-is-the-arm-that-fires`, off.length === 0, `with ${arm} disabled the line(s) still fire: ${JSON.stringify(keys(off))} (a sibling arm absorbs it — disable both and record)`);
      if (off.length === 0) armsProved.add(arm);
    }
  } else if (name.startsWith("clean-")) {
    check(`${name}/silent`, full.length === 0, `false positive: ${JSON.stringify(full)}`);
    if (!(name in CLEAN_SILENCER)) {
      check(`${name}/names-its-silencer`, false, "add it to CLEAN_SILENCER");
      continue;
    }
    const s = CLEAN_SILENCER[name];
    if (s !== null) {
      const off = scanSource(src, { silencers: without(SILENCERS, s) }).findings;
      check(`${name}/flags-without-${s}`, off.length > 0, `still silent with ${s} removed — a vacuous negative`);
      if (off.length > 0) silencersProved.add(s);
    }
  } else if (name.startsWith("blind-")) {
    if (full.length === 0) {
      blind++;
      process.stdout.write(`  BLIND ${name} — SILENT ON A REAL VIOLATION, by construction. Not coverage.\n`);
    } else check(`${name}/still-blind`, false, `the detector now fires (${JSON.stringify(keys(full))}); re-file it as flag-*`);
  } else check(`${name}/known-prefix`, false, "a case is flag-*, clean-* or blind-*");
}
for (const n of Object.keys(CLEAN_SILENCER)) check(`clean-silencer-table/${n}-exists`, cases.includes(n), "CLEAN_SILENCER names a case that is not on disk");
check("every-arm-proved-by-a-flag-case", ARMS.every((a) => armsProved.has(a)), `unproved: ${ARMS.filter((a) => !armsProved.has(a)).join(", ")}`);
check("every-silencer-proved-by-a-clean-case", SILENCERS.every((s) => silencersProved.has(s)), `unproved: ${SILENCERS.filter((s) => !silencersProved.has(s)).join(", ")}`);

// ── live sweep ──
// The trust-code roots swept. `.codex-mcp-guard/` (the Codex MCP guard) and `scripts/ci/` (the
// dev pre-push guard, preflight and landing gates) hold containment decisions too.
const SWEEP_ROOTS = [".claude", ".codex-mcp-guard", "scripts/ci"];
function trackedJs() {
  const out = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", ...SWEEP_ROOTS], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((f) => /\.(js|mjs|cjs)$/.test(f))
    .filter((f) => !/\.test\.[cm]?js$/.test(f) && !/(^|\/)tests\//.test(f) && !f.startsWith(".claude/audit-fixtures/") && !f.startsWith(".claude/test-harness/"))
    .filter((f) => existsSync(path.join(REPO, f)));
}
function population() {
  return trackedJs().filter((f) => /realpath/.test(readFileSync(path.join(REPO, f), "utf8")));
}
// The hash binds the comparison AND its enclosing decision (`context`), so a flipped polarity
// re-fails its acknowledgement (R2 security N7).
const siteSha = (h) => createHash("sha256").update(`${h.op}|${h.arm}|${h.candidateKinds.join(",")}|${h.rootKinds.join(",")}|${h.site}|${h.context}`).digest("hex");
function sweep(files) {
  const hits = [];
  const errors = [];
  const census = { files: 0, comparisons: 0, real_comparisons: 0, unknown_side: 0 };
  const defs = new Map(); // resolver name -> [files defining it as a resolver]
  const impure = []; // a DECLARED name defined somewhere as a FALLBACK (or as no resolver)
  for (const f of files) {
    const src = f.src !== undefined ? f.src : readFileSync(path.join(REPO, f.path), "utf8");
    let r;
    try {
      r = scanSource(src);
      const resolving = resolverDefinitions(src, new Set(Object.keys(DECLARED_RESOLVERS)));
      for (const d of resolving) defs.set(d, [...(defs.get(d) || []), f.path]);
      // Trusting a name is sound only if EVERY same-named definition is a pure resolver.
      for (const d of Object.keys(DECLARED_RESOLVERS)) {
        const k = r.helpers.get(d);
        if (k && (k.has("FALLBACK") || ![...k].some((x) => x.startsWith("REAL")))) impure.push(`${f.path}::${d} infers ${[...k].join("|")}`);
      }
    } catch (e) {
      errors.push(`${f.path}: ${e.message}`);
      continue;
    }
    census.files++;
    for (const k of ["comparisons", "real_comparisons", "unknown_side"]) census[k] += r.census[k];
    const ord = new Map();
    for (const h of r.findings) {
      const base = `${f.path}::${h.enclosingFunction}::${h.arm}`;
      const n = (ord.get(base) || 0) + 1;
      ord.set(base, n);
      hits.push({ key: `${base}#${n}`, ...h, file: f.path, sha256: siteSha(h) });
    }
  }
  return { hits, errors, census, defs, impure };
}
const files = population().map((p) => ({ path: p }));
const live = sweep(files);
check("live-sweep-parses-every-file", live.errors.length === 0, live.errors.join(" | "));
check(`live-sweep-denominator-files>=${FLOOR_FILES}`, live.census.files >= FLOOR_FILES, `${live.census.files} file(s) parsed — the sweep is not reaching the tree`);
check(`live-sweep-denominator-real-comparisons>=${FLOOR_REAL_COMPARISONS}`, live.census.real_comparisons >= FLOOR_REAL_COMPARISONS, `${live.census.real_comparisons} REAL-tagged comparison(s)`);
for (const name of [...Object.keys(DECLARED_RESOLVERS), ...Object.keys(ROOT_RESOLVING_COMPARATORS)]) {
  check(`declared-resolver-verified/${name}`, (live.defs.get(name) || []).length > 0, `no definition of ${name} in the population calls a realpath function — the declared list is trust, not a checked claim`);
}
check("declared-resolvers-are-pure-everywhere", live.impure.length === 0, `a name trusted as a resolver is defined as a fallback: ${live.impure.join(" | ")}`);
// EVERY same-named definition, found by NAME across every tracked JS file in the swept roots —
// including files that never mention realpath (which the population filter would drop) and
// definitions that never call one (which the helper map, populated only for REAL returns, skips).
// `realpathNative` is censused too: no NAME is trusted by the detector any more, but a same-named
// stand-in is the shape that used to borrow REAL:native (R2 security N8).
const CENSUS_FAMILY = { ...DECLARED_RESOLVERS, realpathNative: "REAL:native" };
{
  const names = [...Object.keys(CENSUS_FAMILY), ...Object.keys(ROOT_RESOLVING_COMPARATORS)];
  const nameRe = new RegExp(`\\b(${names.join("|")})\\b`);
  const bad = [];
  const localCopies = [];
  let defsSeen = 0;
  for (const f of trackedJs()) {
    const src = readFileSync(path.join(REPO, f), "utf8");
    if (!nameRe.test(src)) continue;
    let defined;
    let resolving;
    let helpers;
    let exported;
    try {
      defined = definitionNames(src);
      resolving = resolverDefinitions(src, new Set(names));
      helpers = scanSource(src).helpers;
      exported = exportedNames(src);
    } catch (e) {
      bad.push(`${f}: ${e.message}`);
      continue;
    }
    for (const n of names) {
      if (!defined.has(n)) continue;
      defsSeen++;
      const k = helpers.get(n);
      const want = CENSUS_FAMILY[n];
      if (!resolving.has(n)) bad.push(`${f}::${n} calls no realpath function`);
      else if (want && (!k || k.has("FALLBACK") || ![...k].some((x) => x.startsWith("REAL")))) bad.push(`${f}::${n} infers ${k ? [...k].join("|") : "no REAL return"}`);
      else if (want && ![...k].every((x) => x === want)) {
        // A same-file call resolves to the LOCAL definition's inferred kind, so only an EXPORTED
        // definition (or any realpathNative) can carry a declared family into another file.
        if (n === "realpathNative" || exported.has(n)) bad.push(`${f}::${n} infers ${[...k].join("|")}, declared ${want}`);
        else localCopies.push(`${f}::${n} (${[...k].join("|")})`);
      }
    }
  }
  check("declared-names-pure-by-name-census", bad.length === 0 && defsSeen >= names.length, `${defsSeen} definition(s) seen; ${bad.join(" | ")}`);
  process.stdout.write(`  census: ${localCopies.length} non-exported same-named local cop(ies) on another family, sound only locally (not findings): ${localCopies.join(", ") || "none"}\n`);
}
process.stdout.write(
  `  census: ${live.census.files} files · ${live.census.comparisons} comparisons · ${live.census.real_comparisons} REAL-tagged · ${live.census.unknown_side} UNKNOWN-SIDE (not findings) · ${live.hits.length} hit(s)\n`,
);

// the live sweep FIRES: the flag-a1 source, injected as a virtual extra file, is reported
{
  const virt = { path: ".claude/bin/__virtual-flag-a1__.mjs", src: readFileSync(path.join(HERE, "flag-a1-realpath-candidate-raw-literal-root.case.txt"), "utf8") };
  const v = sweep([virt]);
  check("live-sweep-fires-on-an-injected-violation", v.hits.some((h) => h.arm === "A1" && h.file === virt.path), JSON.stringify(v.hits));
}

// acknowledgements, reconciled both ways
// Every problem with ONE acknowledgement against the live hit it names (null when there is none).
// An ack that cannot expire, names no tracking reference, or excuses a comparison other than the
// one now in the tree is not a review record — it is a permanent mute (R1 security F4, F5).
// expires lies at most this many days after the registry's commit date (R2 N7 / R2-2).
const ACK_HORIZON_DAYS = 90;
const ACK_EPOCH_FLOOR = "2026-01-01";
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// tracking: an issue (#123, owner/repo#123) or a journal / workspaces markdown path that EXISTS.
const TRACKING_ISSUE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+$/;
const TRACKING_PATH = /^(journal\/\d{4}-[A-Za-z0-9_.-]+\.md|workspaces\/[A-Za-z0-9_./-]+\.md)$/;
function trackingProblem(t) {
  if (typeof t !== "string") return "tracking: missing";
  if (TRACKING_ISSUE.test(t)) return null;
  if (!TRACKING_PATH.test(t) || t.split("/").includes("..")) return `tracking "${t}": not an issue id (#N, owner/repo#N) nor a journal/ or workspaces/ .md path`;
  if (!existsSync(path.join(REPO, t))) return `tracking "${t}": no such file`;
  return null;
}
function ackProblems(v, hit, today, base = today) {
  const p = [];
  if (!v || typeof v !== "object") return ["not an object"];
  if (!(typeof v.reason === "string" && v.reason.length >= 30 && /\b(allow|deny)\b/i.test(v.reason))) p.push("reason >= 30 chars naming the polarity (allow|deny)");
  if (!["fixed-pending", "by-design"].includes(v.disposition)) p.push("disposition fixed-pending|by-design");
  if (!(typeof v.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.expires) && !Number.isNaN(Date.parse(v.expires)))) p.push("expires: an ISO date (YYYY-MM-DD)");
  else if (v.expires < today) p.push(`EXPIRED on ${v.expires} — fix the site or re-review the acknowledgement`);
  else if (v.expires > addDays(base, ACK_HORIZON_DAYS)) p.push(`expires ${v.expires} is beyond the ${ACK_HORIZON_DAYS}-day horizon from ${base} (latest ${addDays(base, ACK_HORIZON_DAYS)})`);
  const tp = trackingProblem(v.tracking);
  if (tp) p.push(tp);
  if (!(typeof v.site_sha256 === "string" && /^[0-9a-f]{64}$/.test(v.site_sha256))) p.push("site_sha256: the hash of the comparison it excuses");
  else if (hit && v.site_sha256 !== hit.sha256) p.push(`site_sha256 does not match the live site (${hit.sha256}) — the comparison changed; re-review it`);
  return p;
}
const TODAY = new Date().toISOString().slice(0, 10);
const ackPath = path.join(HERE, "acknowledged-sites.json");
// The horizon's base: the registry's last commit date, or TODAY while it carries uncommitted edits
// (an entry being added now is measured from now). Unresolvable or implausible ⇒ TODAY. A snapshot
// runner (trestle) commits a dirty tree with a FIXED epoch date, so a date before ACK_EPOCH_FLOOR
// is a synthetic commit, not a review date — measured: "beyond the 90-day horizon from 1970-01-01".
function ackBaseDate() {
  try {
    const rel = path.relative(REPO, ackPath);
    const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", rel], { encoding: "utf8" }).trim();
    if (dirty) return TODAY;
    const d = execFileSync("git", ["-C", REPO, "log", "-1", "--format=%cs", "--", rel], { encoding: "utf8" }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= ACK_EPOCH_FLOOR && d <= TODAY ? d : TODAY;
  } catch {
    return TODAY;
  }
}
const ACK_BASE = ackBaseDate();
// The registry rule is itself proved: each malformed shape is REFUSED and a well-formed one passes.
{
  const hit = { sha256: "a".repeat(64) };
  const good = { reason: "allow polarity (outside => refuse): synthetic acknowledgement for the rule's own proof.", disposition: "fixed-pending", expires: addDays(TODAY, 30), tracking: "journal/0001-DECISION-co-refocusing.md", site_sha256: "a".repeat(64) };
  check("ack-rule/accepts-a-well-formed-entry", ackProblems(good, hit, TODAY).length === 0, JSON.stringify(ackProblems(good, hit, TODAY)));
  check("ack-rule/accepts-an-issue-tracking-id", ackProblems({ ...good, tracking: "#1234" }, hit, TODAY).length === 0, "an issue id was refused");
  const bad = {
    "no-expires": { ...good, expires: undefined },
    expired: { ...good, expires: "2000-01-01" },
    "beyond-horizon": { ...good, expires: addDays(TODAY, ACK_HORIZON_DAYS + 1) },
    "permanent-date": { ...good, expires: "2999-01-01" },
    "no-tracking": { ...good, tracking: undefined },
    "free-text-tracking": { ...good, tracking: "todo/synthetic" },
    "tracking-path-absent": { ...good, tracking: "journal/9999-no-such-entry.md" },
    "tracking-path-escapes": { ...good, tracking: "workspaces/../.claude/rules/git.md" },
    "no-site-hash": { ...good, site_sha256: undefined },
    "site-rewritten": { ...good, site_sha256: "b".repeat(64) },
  };
  for (const [n, v] of Object.entries(bad)) check(`ack-rule/refuses-${n}`, ackProblems(v, hit, TODAY).length > 0, "a malformed acknowledgement was accepted");
  // A polarity flip of the SAME comparison in the SAME function must change the hash an
  // acknowledgement binds (N7: `K.ack-polarity-flip … "sameSha":true` before this round).
  const pole = (neg) => `import fs from "node:fs";\nexport function inside(c) {\n  if (${neg}fs.realpathSync(c).startsWith("/srv/sandbox/")) return false;\n  return true;\n}\n`;
  const [a, b] = [pole(""), pole("!")].map((s) => sweep([{ path: ".claude/bin/__virtual-polarity__.mjs", src: s }]).hits);
  check("ack-rule/polarity-flip-changes-the-site-hash", a.length === 1 && b.length === 1 && a[0].key === b[0].key && a[0].sha256 !== b[0].sha256, JSON.stringify([a.map((h) => [h.key, h.sha256]), b.map((h) => [h.key, h.sha256])]));
}
const ack = JSON.parse(readFileSync(ackPath, "utf8"));
const sites = ack.sites || {};
const liveByKey = new Map(live.hits.map((h) => [h.key, h]));
for (const h of live.hits) {
  check(`live/${h.key}/acknowledged`, h.key in sites, `${h.file}:${h.line} ${h.op} arm ${h.arm} candidate=${h.candidateKinds.join("|")} root=${h.rootKinds.join("|")} site_sha256=${h.sha256} — fix it (resolve both sides, fail closed) or acknowledge it with its polarity, expires, tracking and site_sha256`);
}
for (const [k, v] of Object.entries(sites)) {
  check(`ack/${k}/not-stale`, liveByKey.has(k), "acknowledged, but no live hit — delete the acknowledgement");
  const probs = ackProblems(v, liveByKey.get(k), TODAY, ACK_BASE);
  check(`ack/${k}/well-formed`, probs.length === 0, probs.join("; "));
}

process.stdout.write(`\npath-containment fixtures: ${passed}/${passed + failed} passed · ${blind} DECLARED-BLIND (not counted)\n`);
process.exit(failed === 0 ? 0 : 1);
