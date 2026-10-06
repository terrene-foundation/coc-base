"use strict";
/**
 * landed-map.js — the ONE answer to "which source commits have landed on the
 * integration branch, and from which branch?", read from provenance RECORDED AT
 * LANDING TIME rather than reconstructed afterwards.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Landing rewrites commits. A rebase, a squash, a conflict fix or a reformat
 * gives the landed work NEW commit ids, and until this module nothing recorded
 * which source branch it came from. Every after-the-fact instrument — "is the
 * commit on dev?" (ancestry), "is the same patch on dev?" (patch-id /
 * `git cherry`), "do the files match?" (content) — then answers a DIFFERENT
 * question from "was this branch landed?", and misreports in both directions:
 * landed branches read as unlanded and were re-reviewed, re-queued or re-landed
 * (and a re-land can revert later fixes). No comparison is smart enough to
 * recover a link that was never written down, so the link is now WRITTEN DOWN:
 * every commit on the integration branch carries one git trailer per source
 * commit it lands (`.claude/bin/land-lane.mjs` writes them; the push guard and
 * CI refuse a commit without one).
 *
 *     Landed-From: <branch>@<40-hex>       this commit lands that source commit,
 *                                          in a landing that took EVERY
 *                                          outstanding commit of <branch>
 *     Landed-Partial: <branch>@<40-hex>    this commit lands that source commit,
 *                                          in a landing that LEFT other commits
 *                                          of <branch> outstanding
 *     Landed-Outstanding: <branch>@<40-hex> (on the LAST commit of a partial
 *                                          landing) a source commit of <branch>
 *                                          that this landing did NOT take
 *     Landed-From: direct                  authored directly on the integration
 *                                          branch; lands no source commit
 *
 * ── COST ─────────────────────────────────────────────────────────────────────
 *
 * Hooks call this on every tool call, so the map is ONE `git log` over the
 * commits AFTER the recorded cutover (nothing before the cutover can carry a
 * trailer, so reading it would be pure cost), cached on disk keyed by the exact
 * integration tip + cutover. A cache hit costs the tip `git rev-parse` plus
 * a per-process-memoised common-dir lookup.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 *
 * It never compares content. A branch the trailers say nothing about is
 * reported as `predates` ONLY when one of its OWN fork points is STRICTLY
 * before the cutover — i.e. it could not have been landed through the
 * recording path — and ONLY then may a caller fall back to its legacy content
 * comparison. A branch forked AT or AFTER the cutover with no covering trailer
 * is `not-landed`, full stop. A map that could not be built where the config
 * EXISTS is UNMEASURED (`no-map`, no fallback); only a repository with NO
 * config (recording never enabled) falls back wholesale (`no-config`).
 *
 * A trailer is a CLAIM written by the lander. The map itself does not verify
 * that the landed commit carries the change of the source commit it names; the
 * push gate (`scripts/ci/landing-trailer-gate.mjs`) verifies shape everywhere
 * and, locally, source existence plus a landing-ledger grant of the trailer's
 * kind bound to the landed commit by identity or by SAME CHANGE. Destructive
 * consumers (retire, remote-ref-reap) require `landingBacking` below — every
 * covered commit backed by a same-branch, same-kind ledger row bound to its
 * carrier (identity or same change), or by the source and carrier being the
 * same change — and archive the tip before deleting, rather than trust a claim
 * alone. SAME CHANGE (`sameChange` below) means: applying the one commit's
 * change onto the other's parent with `git merge-tree` reproduces the other's
 * tree exactly — so a rebase that only shifts lines matches, while the same
 * hunk at a different position, different bytes, extra content or an empty
 * change do not; any git failure reads as NOT the same change (fail closed).
 *
 * Dependencies: Node built-ins + `git-subprocess-env.js`. CommonJS so hooks can
 * `require` it; ESM callers use `createRequire`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

const TRAILER_FROM = "Landed-From";
const TRAILER_PARTIAL = "Landed-Partial";
const TRAILER_OUTSTANDING = "Landed-Outstanding";
const DIRECT = "direct";
const CONFIG_REL = path.join(".claude", "bin", "landing-provenance.json");
const CONFIG_SCHEMA = "landing-provenance/1";
// /2: the log is read with `-z` and newline-separated fields, and the cached
// records may carry `unparseable` entries — a /1 entry was produced by the old
// parser and is never read back.
const CACHE_SCHEMA = "landed-map-cache/2";
const CACHE_FILE = "landed-map-cache.json";
const SHA40 = /^[0-9a-f]{40}$/;

// ── pure helpers ────────────────────────────────────────────────────────────

// Every code point that is not a printable, visible character: \p{C} (C0 + C1
// controls, DEL, format characters incl. the bidi controls U+202A-202E and
// U+2066-2069, surrogates, private use, unassigned), \p{Z} (every space and the
// line / paragraph separators U+2028 / U+2029) and every default-ignorable
// (invisible) code point (zero-width joiners, variation selectors, U+3164 ...).
const NON_PRINTABLE = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Conservative mirror of `git check-ref-format --branch` for a SHORT branch
 * name. It rejects everything check-ref-format rejects that could matter here
 * (control chars, space, `~^:?*[\`, `..`, `@{`, leading `-` or `/`, trailing
 * `/` `.` or `.lock`, `//`, a lone `@`). It may reject a few exotic names git
 * would accept; for a provenance record that is the safe direction.
 *
 * It ALSO rejects every non-printable code point (NON_PRINTABLE above), which
 * git itself accepts: a branch name is attacker-authorable text that ends up
 * inside `Landed-From: <branch>@<sha>` and in every guard's output, where an
 * escape sequence or a bidi override could forge or reorder what an operator
 * reads. Printable non-ASCII letters (`feat/café`, `fix/日本`) are accepted.
 */
function isValidBranchName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name === "@" || name === DIRECT) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (NON_PRINTABLE.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.split("/").some((seg) => seg.startsWith(".") || seg.endsWith(".lock"))) return false;
  return true;
}

/**
 * Parse ONE trailer value. Returns `{ direct: true }`, `{ branch, sha }`, or
 * `{ error }`. The split is on the LAST `@`, and the suffix must be exactly 40
 * lowercase hex — an abbreviated id is refused, because an abbreviation can
 * become ambiguous later and a provenance record must not rot.
 */
function parseTrailerValue(raw) {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v === DIRECT) return { direct: true };
  const at = v.lastIndexOf("@");
  if (at <= 0) return { error: `not "<branch>@<40-hex>" or "direct": ${JSON.stringify(v)}` };
  const branch = v.slice(0, at);
  const sha = v.slice(at + 1);
  if (!SHA40.test(sha)) return { error: `source id is not a full 40-hex commit id: ${JSON.stringify(v)}` };
  if (!isValidBranchName(branch)) return { error: `source branch is not a valid branch name: ${JSON.stringify(v)}` };
  return { branch, sha };
}

function formatTrailerValue(branch, sha) {
  return `${branch}@${sha}`;
}

/**
 * `s` as printable ASCII only — the ONE output-escaping function for text an
 * attacker can author (subjects, trailer values, branch names, git's error
 * text). 0x20-0x7e pass through unchanged; C0 controls (incl. CR, LF, TAB, ESC)
 * and DEL render as `\xNN`; every other code point (C1 controls, bidi / format /
 * invisible characters, and all other non-ASCII) renders as `\u{XXXX}` (at
 * least four upper-case hex digits). Iterates by CODE POINT, so a surrogate
 * pair is one `\u{XXXXX}`, and a lone surrogate is escaped, never emitted.
 * Pure. `scripts/ci/landing-trailer-gate.mjs` prints through exactly this.
 */
function toAsciiPrintable(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp < 0x80) out += `\\x${cp.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}`;
  }
  return out;
}

/**
 * Validate a parsed config object. Returns `{ ok: true, config }` or
 * `{ ok: false, why }`. It checks SHAPE only; ancestry is the caller's
 * question because it depends on which tip is being judged.
 */
function validateConfig(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, why: "config is not an object" };
  if (obj.schema !== CONFIG_SCHEMA) return { ok: false, why: `config schema ${JSON.stringify(obj.schema)} != ${CONFIG_SCHEMA}` };
  if (typeof obj.cutover !== "string" || !SHA40.test(obj.cutover))
    return { ok: false, why: `config cutover is not a full 40-hex commit id: ${JSON.stringify(obj.cutover)}` };
  for (const k of ["integration_branch", "promotion_branch", "remote"]) {
    if (typeof obj[k] !== "string" || !isValidBranchName(obj[k])) return { ok: false, why: `config ${k} is not a valid name: ${JSON.stringify(obj[k])}` };
  }
  if (!Array.isArray(obj.protected_branches) || !obj.protected_branches.every(isValidBranchName))
    return { ok: false, why: "config protected_branches must be an array of branch names" };
  for (const must of [obj.integration_branch, obj.promotion_branch]) {
    if (!obj.protected_branches.includes(must)) return { ok: false, why: `config protected_branches must include ${must}` };
  }
  return { ok: true, config: obj };
}

/**
 * Parse the output of `git log -z --format=LOG_FORMAT` (see buildLandedMap).
 * Pure; NEVER throws.
 *
 * Records are NUL-terminated (`-z`); a record is FIVE newline-separated fields:
 * the commit id, the Landed-From values, the Landed-Partial values, the
 * Landed-Outstanding values, and the commit id AGAIN as a closing sentinel.
 * Multiple values of one key are joined by \x1f. Trailer values are single-line
 * (`unfold`), so a newline can only be a field separator. A single record
 * WITHOUT `-z` (git's tformat newline terminator) parses too, because the
 * sentinel field is never empty and the terminator is stripped.
 *
 * A record that does not have exactly that shape — a stray line (a signature
 * block), a NUL or control byte inside a message splitting a record — is
 * returned as `{ sha: <id or null>, unparseable: <why>, raw, from: [], partial:
 * [], outstanding: [] }`: foldRecords lists it in `invalid` and it records
 * nothing. One bad commit therefore never takes the whole map down, and a
 * skipped record can only REMOVE coverage (never invent a landing).
 * Returns [{ sha, from: [], partial: [], outstanding: [] }] with RAW strings.
 */
function parseLogRecords(text) {
  const out = [];
  for (const chunk of String(text).split("\x00")) {
    const r = chunk.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!r) continue;
    const f = r.split("\n");
    const lead = SHA40.test(f[0]) ? f[0] : null;
    if (f.length !== 5 || !lead || f[4] !== lead) {
      out.push({ sha: lead, unparseable: `log record has ${f.length} field(s), expected 5 framed by the commit id`, raw: r.slice(0, 120), from: [], partial: [], outstanding: [] });
      continue;
    }
    const split = (s) => s.split("\x1f").map((x) => x.trim()).filter(Boolean);
    out.push({ sha: lead, from: split(f[1]), partial: split(f[2]), outstanding: split(f[3]) });
  }
  return out;
}

/**
 * Fold parsed records (NEWEST FIRST, git log order) into the map. Pure.
 * bySource: source sha -> [{ landed, branch, kind }]
 * byBranch: branch -> { landed: [sha], sources: [sha], outstanding: [sha], lastKind }
 *   `lastKind` is the kind of the NEWEST landing naming the branch ("from" |
 *   "partial"), which answers "done?" when the branch ref no longer exists.
 *   `outstanding` is the NEWEST landing's own list only: the Landed-Outstanding
 *   values on the newest commit naming the branch when that landing is
 *   "partial" (its last commit carries them), and EMPTY when it is "from" (a
 *   complete landing took every outstanding commit). Older partial landings'
 *   lists are SUPERSEDED, not accumulated: after partial -> rebase (new ids) ->
 *   full landing, the old ids never become sources, so accumulating them kept a
 *   deleted, fully-landed branch reading "partial" forever.
 */
function foldRecords(records) {
  const bySource = new Map();
  const byBranch = new Map();
  const direct = [];
  const invalid = [];
  const newest = new Map(); // branch -> id of the newest record naming it (from/partial)
  const branchEntry = (b) => {
    if (!byBranch.has(b)) byBranch.set(b, { landed: [], sources: [], outstanding: [], lastKind: null });
    return byBranch.get(b);
  };
  for (const rec of records) {
    if (rec.unparseable) {
      invalid.push({ commit: rec.sha || "(no commit id)", kind: "record", value: rec.raw || "", why: rec.unparseable });
      continue;
    }
    for (const [kind, list] of [["from", rec.from], ["partial", rec.partial]]) {
      for (const raw of list) {
        const p = parseTrailerValue(raw);
        if (p.error) { invalid.push({ commit: rec.sha, kind, value: raw, why: p.error }); continue; }
        if (p.direct) {
          if (kind === "from") direct.push(rec.sha);
          else invalid.push({ commit: rec.sha, kind, value: raw, why: "Landed-Partial cannot be direct" });
          continue;
        }
        if (!bySource.has(p.sha)) bySource.set(p.sha, []);
        bySource.get(p.sha).push({ landed: rec.sha, branch: p.branch, kind });
        const e = branchEntry(p.branch);
        if (!e.landed.includes(rec.sha)) e.landed.push(rec.sha);
        if (!e.sources.includes(p.sha)) e.sources.push(p.sha);
        if (e.lastKind === null) { e.lastKind = kind; newest.set(p.branch, rec.sha); } // newest first
      }
    }
    for (const raw of rec.outstanding) {
      const p = parseTrailerValue(raw);
      if (p.error || p.direct) { invalid.push({ commit: rec.sha, kind: "outstanding", value: raw, why: p.error || "outstanding cannot be direct" }); continue; }
      if (!newest.has(p.branch)) {
        // Not landed by this commit or any newer one: an outstanding list with
        // no landing of its branch is not a partial landing's record.
        invalid.push({ commit: rec.sha, kind: "outstanding", value: raw, why: `Landed-Outstanding for ${p.branch}, which this commit does not land` });
        continue;
      }
      if (newest.get(p.branch) !== rec.sha) continue; // superseded by a newer landing of the branch
      const e = byBranch.get(p.branch);
      if (e.lastKind !== "partial") {
        invalid.push({ commit: rec.sha, kind: "outstanding", value: raw, why: `Landed-Outstanding beside a complete ${TRAILER_FROM} landing of ${p.branch}` });
        continue;
      }
      if (!e.outstanding.includes(p.sha)) e.outstanding.push(p.sha);
    }
  }
  // A source the newest partial landing lists as outstanding but which some
  // landing on the branch DID land is not outstanding.
  for (const e of byBranch.values()) e.outstanding = e.outstanding.filter((s) => !bySource.has(s));
  return { bySource, byBranch, direct, invalid };
}

/**
 * Classify ONE branch against the map. Pure.
 *   own               non-merge commits of the branch NOT reachable from the
 *                     integration tip (`git rev-list --no-merges tip..branch`)
 *   forkPreCutover    true when one of the branch's OWN fork points is a STRICT
 *                     ancestor of the cutover — it forked before recording
 *                     began (computed by branchStatus; only consulted when
 *                     nothing covers or names the branch)
 *   branchName        short name (used to look up branch-keyed records)
 * Statuses:
 *   landed        every own commit is covered by a trailer
 *   partial       some own commits covered, some not (outstanding listed)
 *   not-landed    forked after the cutover and no own commit covered
 *   predates      forked at/before the cutover, no trailer covers or names it:
 *                 the ONLY status a caller may resolve by content comparison
 *   ancestry      no own commits and no trailer names it: the tip is already
 *                 reachable from the integration tip (a pre-fix merge, or a
 *                 fresh branch with nothing on it). Exact, not heuristic — but
 *                 it does NOT distinguish "merged" from "empty"; callers that
 *                 destroy must not treat it as landed.
 */
function classifyBranch({ own, forkPreCutover, branchName, map }) {
  const covered = own.filter((s) => map.bySource.has(s));
  const outstanding = own.filter((s) => !map.bySource.has(s));
  const rec = branchName ? map.byBranch.get(branchName) : undefined;
  const landedCommits = [...new Set(covered.flatMap((s) => map.bySource.get(s).map((x) => x.landed)))];
  const base = { own: own.length, covered: covered.length, outstanding, landedCommits };
  // No own commits means the tip is ALREADY reachable from the integration tip:
  // a pre-recording merge, or a branch with nothing on it yet. A replayed
  // landing never produces this shape (the source commits are never on the
  // integration branch), so a trailer that merely NAMES this branch — e.g. an
  // old landing of a since-deleted branch whose name was reused for a fresh
  // lane — must NOT make it "landed". Only the ref-absent path below reads
  // branch-keyed records.
  if (own.length === 0) return { ...base, status: "ancestry", namedByTrailer: Boolean(rec) };
  if (outstanding.length === 0) return { ...base, status: "landed" };
  if (covered.length > 0) return { ...base, status: "partial" };
  if (forkPreCutover && !rec) return { ...base, status: "predates" };
  return { ...base, status: "not-landed" };
}

// ── git plumbing ────────────────────────────────────────────────────────────

/**
 * Every git call of this module (and of the audit, through `_git`) runs with
 * REPOSITORY config that could reshape a formatted log neutralised:
 *   `-c log.showSignature=false`  a repo-local `log.showSignature=true` prints
 *                                 the signature check ("Good ... signature")
 *                                 INSIDE the formatted output of every signed
 *                                 commit, which corrupted the map's records;
 *   GIT_NO_REPLACE_OBJECTS=1      a `refs/replace/*` object would substitute a
 *                                 different commit's message (and trailers) for
 *                                 the one actually on the integration branch.
 * gitEnv() already nulls GLOBAL and SYSTEM config; repo config is still read.
 */
const GIT_PRE_ARGS = Object.freeze(["-c", "log.showSignature=false"]);

function git(repoDir, args, { timeoutMs = 15000, indexFile, gitDir, workTree } = {}) {
  const bin = resolveGitBinary();
  if (!bin) return { status: null, stdout: "", stderr: "git binary unresolvable" };
  const r = spawnSync(bin, [...(gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.splitIndex=false"] : ["-C", repoDir]), ...GIT_PRE_ARGS, ...args], {
    encoding: "utf8",
    env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1", ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) }, // indexFile = the caller's TEMPORARY index. The ONLY caller-chosen entry.
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return { status: r.error ? null : r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error.message) : "") };
}

function gitOk(repoDir, args, opts) {
  const r = git(repoDir, args, opts);
  if (r.status !== 0) throw new Error(`landed-map: git ${args.join(" ")} failed (status ${r.status}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

/**
 * The commit `ref` names, or null when git says it does NOT exist (exit 1 of
 * `rev-parse --verify --quiet`). Any other outcome — a timeout, a killed child,
 * an unresolvable git, "not a git repository", an unexpected output — THROWS:
 * "could not ask" must never read as "absent", because an absent branch ref is
 * judged by its name-keyed trailers alone (branchStatus), which would turn a
 * slow git into a "landed" verdict.
 */
function resolveCommit(repoDir, ref, opts) {
  const r = git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], opts);
  if (r.status === 1) return null;
  const s = r.stdout.trim();
  if (r.status === 0 && SHA40.test(s)) return s;
  throw new Error(`landed-map: rev-parse ${ref} undetermined (status ${r.status}): ${(r.stderr.trim() || s).slice(0, 200)}`);
}

function isAncestor(repoDir, a, b, opts) {
  const r = git(repoDir, ["merge-base", "--is-ancestor", a, b], opts);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`landed-map: is-ancestor ${a} ${b} undetermined: ${r.stderr.trim()}`);
}

/**
 * Read the config from the WORKING TREE of the checkout containing repoDir.
 * repoDir may be a subdirectory: the path is resolved against the toplevel, so
 * a hook running from a subdirectory does not silently read "no config".
 */
function loadConfig(repoDir, opts) {
  let p = path.join(repoDir, CONFIG_REL);
  // A `.git` entry (a directory, or a file in a linked worktree) means repoDir
  // IS a toplevel: skip the spawn, so a consumer repo without the config pays
  // nothing on every hook invocation.
  if (!fs.existsSync(p) && !fs.existsSync(path.join(repoDir, ".git"))) {
    const top = git(repoDir, ["rev-parse", "--show-toplevel"], opts);
    if (top.status === 0 && top.stdout.trim()) p = path.join(top.stdout.trim(), CONFIG_REL);
    // A git that did not ANSWER (timeout, kill, unresolvable binary) cannot say
    // the config is absent: "absent" is the wholesale-fallback answer.
    else if (top.status === null) return { ok: false, why: `cannot resolve the checkout toplevel of ${repoDir}: ${top.stderr.trim().slice(0, 200)}` };
  }
  if (!fs.existsSync(p)) return { ok: false, absent: true, why: `no ${CONFIG_REL} (recording not enabled here)` };
  let obj;
  try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return { ok: false, why: `${CONFIG_REL} unreadable: ${e.message}` }; }
  return validateConfig(obj);
}

/** Read the config as COMMITTED at `commit` (what a gate must judge by). */
function loadConfigAt(repoDir, commit, opts) {
  const r = git(repoDir, ["cat-file", "-p", `${commit}:${CONFIG_REL.split(path.sep).join("/")}`], opts);
  // status null = git never answered (timeout / kill / no binary): NOT absent.
  if (r.status === null) return { ok: false, why: `could not read ${CONFIG_REL} at ${String(commit).slice(0, 12)}: ${r.stderr.trim().slice(0, 200)}` };
  if (r.status !== 0) return { ok: false, absent: true, why: `no ${CONFIG_REL} at ${String(commit).slice(0, 12)}` };
  let obj;
  try { obj = JSON.parse(r.stdout); } catch (e) { return { ok: false, why: `${CONFIG_REL} at ${String(commit).slice(0, 12)} is not JSON: ${e.message}` }; }
  return validateConfig(obj);
}

// Read with `git log -z` (NUL-terminated records); five newline-separated
// fields, the last repeating the commit id as a closing sentinel — the
// contract parseLogRecords documents.
const LOG_FORMAT =
  "%H%n" +
  `%(trailers:key=${TRAILER_FROM},valueonly,unfold,separator=%x1f)%n` +
  `%(trailers:key=${TRAILER_PARTIAL},valueonly,unfold,separator=%x1f)%n` +
  `%(trailers:key=${TRAILER_OUTSTANDING},valueonly,unfold,separator=%x1f)%n` +
  "%H";

const _commonDirMemo = new Map();
function _cachePath(repoDir, opts) {
  if (!_commonDirMemo.has(repoDir)) {
    const r = git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts);
    _commonDirMemo.set(repoDir, r.status === 0 && r.stdout.trim() ? path.join(r.stdout.trim(), CACHE_FILE) : null);
  }
  return _commonDirMemo.get(repoDir);
}

/**
 * Build the map for `ref` (default: the config's integration branch on the
 * config's remote, falling back to the local branch). ONE `git log` over
 * `tip ^cutover`, cached per (tip, cutover).
 *
 * Returns { ok: true, ref, tip, cutover, bySource, byBranch, direct, invalid, cached }
 *      or { ok: false, why, noConfig } — `noConfig: true` ONLY when the config
 *      file is ABSENT (recording never enabled here: callers fall back to their
 *      legacy path). Every other failure — invalid config, cutover or ref that
 *      does not resolve, a git failure or timeout — is `noConfig: false`, which
 *      landedVerdict reports as UNMEASURED. NEVER throws.
 */
function buildLandedMap(opts = {}) {
  try {
    return _buildLandedMap(opts);
  } catch (e) {
    return { ok: false, noConfig: false, why: e.message };
  }
}

function _buildLandedMap({ repoDir = process.cwd(), ref, config, useCache = true, timeoutMs } = {}) {
  const o = timeoutMs ? { timeoutMs } : undefined;
  let cfg = config;
  if (!cfg) {
    const c = loadConfig(repoDir, o);
    if (!c.ok) return { ok: false, noConfig: Boolean(c.absent), why: c.why };
    cfg = c.config;
  }
  let target = ref;
  if (!target) {
    const remoteRef = `refs/remotes/${cfg.remote}/${cfg.integration_branch}`;
    target = resolveCommit(repoDir, remoteRef, o) ? remoteRef : `refs/heads/${cfg.integration_branch}`;
  }
  const tip = resolveCommit(repoDir, target, o);
  if (!tip) return { ok: false, noConfig: false, why: `cannot resolve ${target}` };
  const cutover = cfg.cutover;

  // A cache entry is keyed by the exact (tip, cutover) pair and is only ever
  // written AFTER the cutover was verified to be a commit, so a hit needs no
  // second verification: a hit costs the tip rev-parse (+ the common-dir
  // lookup, memoised per process).
  const cacheFile = useCache ? _cachePath(repoDir, o) : null;
  if (cacheFile) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      const hit = c && c.schema === CACHE_SCHEMA && c.entries && c.entries[`${tip}:${cutover}`];
      if (hit) {
        const folded = foldRecords(hit);
        return { ok: true, ref: target, tip, cutover, ...folded, cached: true };
      }
    } catch { /* absent or corrupt cache: rebuild */ }
  }
  if (!resolveCommit(repoDir, cutover, o)) return { ok: false, noConfig: false, why: `cutover ${cutover} is not a commit in this repository` };
  const out = git(repoDir, ["log", "-z", `--format=${LOG_FORMAT}`, tip, `^${cutover}`], o);
  if (out.status !== 0) return { ok: false, noConfig: false, why: `git log failed (status ${out.status}): ${out.stderr.trim().slice(0, 200)}` };
  const records = parseLogRecords(out.stdout);
  if (cacheFile) {
    try {
      // Keep only a handful of tips; the file is a cache, never a record.
      let entries = {};
      try {
        const prev = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (prev && prev.schema === CACHE_SCHEMA && prev.entries) entries = prev.entries;
      } catch { /* start fresh */ }
      const keys = Object.keys(entries).slice(-7);
      const kept = {};
      for (const k of keys) kept[k] = entries[k];
      kept[`${tip}:${cutover}`] = records;
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, entries: kept }));
      fs.renameSync(tmp, cacheFile);
    } catch { /* a cache that cannot be written costs speed, not correctness */ }
  }
  return { ok: true, ref: target, tip, cutover, ...foldRecords(records), cached: false };
}

/**
 * Status of one branch ref against a built map. `branchRef` is any ref that
 * resolves (refs/heads/x, refs/remotes/origin/x); `branchName` is the short
 * name trailers use (x). `tip` may be passed when the caller already resolved
 * it (saves a spawn). Never throws: a git failure is `status: "unknown"`.
 *
 * FORK POINTS, not merge-base. The fork points are read off the branch's OWN
 * walk: the first parent of each own non-merge commit that is not itself own.
 * merge-base(integration tip, branch) is the wrong instrument — a lane forked
 * BEFORE the cutover that later merged post-cutover dev has a post-cutover
 * merge-base and would read `not-landed` although nothing could ever have
 * recorded its pre-cutover commits.
 *
 * `predates` is STRICT: it needs a fork point that is a STRICT ancestor of the
 * cutover (fork point != cutover). A branch whose fork point IS the cutover
 * forked after recording began (its own commits can only postdate it), so it is
 * never `predates` and never handed to a content comparison. Ancestor-or-equal
 * here would route every lane cut from the cutover commit — with the cutover
 * set to the dev tip, that is every lane cut before the next landing —
 * straight back to the instrument this module replaces. An own ROOT commit (no
 * parent: an unrelated history) also counts: nothing could have recorded it.
 * The ancestry test runs only when the answer matters (nothing covers or names
 * the branch) and is memoised per fork point (`_fork`).
 */
function _forkPredatesCutover(repoDir, map, forkParents, o, memo) {
  for (const p of forkParents) {
    if (p === null) return true; // own root commit: unrelated history
    if (p === map.cutover) continue;
    if (!memo.has(p)) memo.set(p, isAncestor(repoDir, p, map.cutover, o));
    if (memo.get(p)) return true;
  }
  return false;
}

function _hasUnparseableRecords(map) {
  return (map.invalid || []).some((i) => i.kind === "record");
}

function branchStatus({ repoDir = process.cwd(), map, branchRef, branchName, tip, timeoutMs, _fork } = {}) {
  if (!map || !map.ok) return { status: "unknown", why: (map && map.why) || "no map" };
  const o = timeoutMs ? { timeoutMs } : undefined;
  try {
    const tipB = tip && SHA40.test(tip) ? tip : resolveCommit(repoDir, branchRef, o);
    if (!tipB) {
      const rec = map.byBranch.get(branchName);
      if (!rec) return { status: "unknown", why: `cannot resolve ${branchRef} and no trailer names ${branchName}` };
      // An absent ref is judged by name-keyed records ALONE; an unparseable
      // record on the integration branch may be the newer landing that names
      // it (and its Landed-Outstanding), so the records cannot answer.
      if (_hasUnparseableRecords(map)) {
        return { status: "unknown", refAbsent: true, why: `${branchRef} is absent and ${map.invalid.filter((i) => i.kind === "record").length} unparseable record(s) on the integration branch may name ${branchName}` };
      }
      return {
        status: rec.lastKind === "from" && rec.outstanding.length === 0 ? "landed" : "partial",
        refAbsent: true,
        own: 0,
        covered: 0,
        outstanding: rec.outstanding.slice(),
        landedCommits: rec.landed.slice(),
      };
    }
    // ONE walk with parents: non-merge commits are the source commits a
    // landing replays; MERGE commits in the branch's own range cannot be
    // replayed (land-lane refuses them) and may carry resolution content no
    // parent has, so their presence keeps the branch from ever reading as
    // fully landed.
    const walk = gitOk(repoDir, ["rev-list", "--parents", tipB, `^${map.tip}`], o).split("\n").filter(Boolean).map((l) => l.split(" "));
    const ownSet = new Set(walk.map((f) => f[0]));
    const nonMerge = walk.filter((f) => f.length <= 2);
    const own = nonMerge.map((f) => f[0]);
    const ownMerges = walk.filter((f) => f.length > 2).map((f) => f[0]);
    // `predates` is only reachable when nothing covers the own commits and no
    // trailer names the branch (classifyBranch), so only then is it measured.
    let forkPreCutover = false;
    const couldPredate = own.length > 0 && !own.some((s) => map.bySource.has(s)) && !map.byBranch.has(branchName);
    if (couldPredate) {
      const forkParents = [...new Set(nonMerge.map((f) => (f.length === 2 ? f[1] : null)).filter((p) => p === null || !ownSet.has(p)))];
      forkPreCutover = _forkPredatesCutover(repoDir, map, forkParents, o, _fork || new Map());
    }
    const c = classifyBranch({ own, forkPreCutover, branchName, map });
    if (ownMerges.length > 0) {
      // Merges are outstanding whatever the rest says; they only CHANGE the
      // status when every non-merge commit is covered (landed -> partial).
      const status = c.status === "landed" ? "partial" : c.status;
      return { ...c, status, outstanding: [...c.outstanding, ...ownMerges], outstandingMerges: ownMerges, tip: tipB };
    }
    return { ...c, tip: tipB };
  } catch (e) {
    return { status: "unknown", why: e.message };
  }
}

const _memo = new Map();

/**
 * THE consumer entry point — the one policy every "is this branch done?" tool
 * applies, so no consumer re-derives it:
 *
 *   { decided: true,  landed: true,  status: "landed", landedCommits }
 *   { decided: true,  landed: false, status: "partial"|"not-landed", outstanding }
 *   { decided: false, fallback: true,  status: "predates"|"ancestry"|"no-config", why }
 *        -> the caller MAY apply its legacy content comparison (and only then)
 *   { decided: false, fallback: false, status: "unknown"|"no-map", why }
 *        -> the caller MUST treat the branch as UNMEASURED (never landed)
 *
 * `no-config` (the config file is ABSENT: recording was never enabled here) is
 * the only map failure that falls back. `no-map` — the config EXISTS but the
 * map could not be built (invalid config, missing cutover, unresolvable
 * integration ref, git failure or timeout) — is UNMEASURED: the requirement is
 * to fall back to content comparison ONLY for branches that predate the fix,
 * and a broken map says nothing about whether this branch does.
 *
 * `map` is optional; without it the map is built once per (repoDir, ref) per
 * process. `ref` pins the integration ref the caller already resolved (so the
 * map and the caller's legacy comparison judge the SAME tip).
 */
function _verdictOf(s) {
  if (s.status === "landed") return { decided: true, landed: true, ...s };
  if (s.status === "partial" || s.status === "not-landed") return { decided: true, landed: false, ...s };
  if (s.status === "predates" || s.status === "ancestry") return { decided: false, fallback: true, ...s };
  return { decided: false, fallback: false, ...s };
}

function _mapFor({ repoDir, map, ref, timeoutMs }) {
  if (map) return map;
  const key = `${repoDir}\0${ref || ""}`;
  if (!_memo.has(key)) _memo.set(key, buildLandedMap({ repoDir, ref, timeoutMs }));
  return _memo.get(key);
}

function _shortName(branchRef) {
  return String(branchRef || "").replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
}

/** The verdict for a map that is not ok: fallback ONLY when the config is absent. */
function _mapFailureVerdict(m) {
  return m.noConfig
    ? { decided: false, fallback: true, status: "no-config", why: m.why }
    : { decided: false, fallback: false, status: "no-map", why: m.why || "landed map unavailable" };
}

function landedVerdict({ repoDir = process.cwd(), branchRef, branchName, map, ref, tip, timeoutMs } = {}) {
  const m = _mapFor({ repoDir, map, ref, timeoutMs });
  if (!m.ok) return _mapFailureVerdict(m);
  const name = branchName || _shortName(branchRef);
  const s = branchStatus({ repoDir, map: m, branchRef, branchName: name, tip, timeoutMs });
  return _verdictOf(s);
}

/**
 * BULK form for hooks: one verdict per `{ ref, name?, tip? }`, same policy as
 * landedVerdict, with tips resolved in ONE `for-each-ref` when not supplied,
 * ONE `rev-list` per branch, plus an is-ancestor per DISTINCT fork point
 * (memoised across the pass) only for branches nothing covers or names.
 * `budgetMs` bounds the whole pass: a
 * branch the budget never reaches is `unknown` (UNMEASURED), never landed and
 * never handed to a content comparison.
 */
function landedVerdicts({ repoDir = process.cwd(), branches = [], map, ref, timeoutMs, budgetMs } = {}) {
  const t0 = Date.now();
  const m = _mapFor({ repoDir, map, ref, timeoutMs });
  if (!m.ok) {
    return branches.map((b) => ({ ref: b.ref, name: b.name || _shortName(b.ref), ..._mapFailureVerdict(m) }));
  }
  const o = timeoutMs ? { timeoutMs } : undefined;
  const need = branches.filter((b) => !(b.tip && SHA40.test(b.tip))).map((b) => b.ref);
  const tips = new Map();
  if (need.length) {
    const r = git(repoDir, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)", ...need], o);
    if (r.status === 0) {
      for (const line of r.stdout.split("\n")) {
        const [rn, obj, peeled] = line.split("\0");
        if (rn) tips.set(rn, peeled && SHA40.test(peeled) ? peeled : obj);
      }
    }
  }
  const fork = new Map();
  return branches.map((b) => {
    const name = b.name || _shortName(b.ref);
    if (typeof budgetMs === "number" && Date.now() - t0 > budgetMs) {
      return { ref: b.ref, name, decided: false, fallback: false, status: "unknown", budgetExhausted: true, why: `provenance budget ${budgetMs}ms exhausted before this branch` };
    }
    const tip = b.tip && SHA40.test(b.tip) ? b.tip : tips.get(b.ref);
    const s = branchStatus({ repoDir, map: m, branchRef: b.ref, branchName: name, tip, timeoutMs, _fork: fork });
    return { ref: b.ref, name, ..._verdictOf(s) };
  });
}

function _resetMemo() { _memo.clear(); _hermeticMemo.clear(); }

/** Plain-object view of a map, for JSON output. */
function mapToJSON(map) {
  if (!map || !map.ok) return map;
  const branches = {};
  for (const [b, e] of [...map.byBranch.entries()].sort(([a], [c]) => a.localeCompare(c))) branches[b] = e;
  const sources = {};
  for (const [s, l] of map.bySource.entries()) sources[s] = l;
  return { ref: map.ref, tip: map.tip, cutover: map.cutover, cached: map.cached, branches, sources, direct: map.direct, invalid: map.invalid };
}

// ── landing backing: what a DESTRUCTIVE consumer requires beyond a trailer ──

const LANDING_LEDGER_SCHEMA = "land-lane-landing/1";
const LANDING_LEDGER_REL = path.join("land-lane", "landing-ledger.jsonl");
const LEDGER_KINDS = new Set(["from", "partial"]);

/**
 * The shape sameChange needs of ONE commit: { parent, tree, parentTree }, or
 * `{ none: why }` when it is not a single-parent commit here (a merge, a root,
 * an object this repository does not have, a non-40-hex id) or its git calls
 * failed for ANY reason (timeout, no binary included). Memoised in `memo`.
 * `runGit` is the surface's git runner (`git` here, the gate's neutralised one
 * there) — one implementation, one behaviour, two runners.
 */
function _changeShape(runGit, repoDir, sha, o, memo) {
  if (memo && memo.has(sha)) return memo.get(sha);
  let shape;
  if (typeof sha !== "string" || !SHA40.test(sha)) shape = { none: `${JSON.stringify(String(sha).slice(0, 60))} is not a 40-hex commit id` };
  else {
    const r = runGit(repoDir, ["rev-list", "--no-walk", "--parents", `${sha}^{commit}`], o);
    const f = r.status === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean) : [];
    if (r.status !== 0) shape = { none: `${sha} could not be read here (git status ${r.status}: ${r.stderr.trim().slice(0, 120)})` };
    else if (f.length !== 2 || !SHA40.test(f[1])) shape = { none: `${sha} is ${f.length > 2 ? "a merge" : "a root commit"}` };
    else {
      const t = runGit(repoDir, ["rev-parse", `${sha}^{tree}`, `${f[1]}^{tree}`], o);
      const [tree, parentTree] = t.status === 0 ? t.stdout.trim().split(/\s+/) : [];
      if (!SHA40.test(tree || "") || !SHA40.test(parentTree || "")) shape = { none: `the trees of ${sha} could not be read (git status ${t.status})` };
      else if (tree === parentTree) shape = { none: `${sha} changes nothing (an empty change is bound by identity only)` };
      else shape = { parent: f[1], tree, parentTree };
    }
  }
  if (memo) memo.set(sha, shape);
  return shape;
}

/**
 * Per-repo-dir `{ objects, objectFormat }`, the ONE non-hermetic read the
 * hermetic environment needs (see `hermeticEnv`). Cleared by `_resetMemo`; a
 * module-level `const` this late is deliberate, so the declaration costs no
 * shift to the line-range citations that point above it.
 */
const _hermeticMemo = new Map();

/**
 * The environment every VERIFICATION git call runs in: a git dir that answers
 * for `repoDir`'s OBJECTS and carries NOTHING ELSE. Objects are reached only
 * through `objects/info/alternates`; the dir holds no repo config, no
 * `info/attributes`, no `info/grafts`, no hooks and no refs, and it is paired
 * with an EMPTY work tree, so no `.gitattributes` anywhere on disk is read.
 *
 * WHY — each of these is a round-6 measurement against the `-C <repo>` path:
 *   `info/grafts` re-parents a commit. `git -C <repo> rev-list --no-walk
 *     --parents <sha>` returns the GRAFTED parent even under
 *     `--no-replace-objects` + `GIT_NO_REPLACE_OBJECTS=1`, so a `sameChange`
 *     verdict could be taken on a topology the repository does not have; the
 *     hermetic dir returns the real parent.
 *   Repo config is unreachable, which takes out `apply.ignoreWhitespace`
 *     (widens what a patch may match), `core.fsmonitor` (a hook that executes
 *     during index operations), `merge.<name>.driver` (executes during a merge)
 *     and `remote.<name>.uploadpack` (executes on a lazy fetch) together.
 *   A missing object CANNOT be lazily fetched: the promisor remote is repo
 *     config the hermetic dir does not have, and `GIT_NO_LAZY_FETCH=1` is set
 *     as well — so a partial clone FAILS CLOSED instead of reaching the network.
 *
 * The caller MUST call `cleanup()`. Returns null when it cannot be built, and
 * every caller then fails closed: a verdict is never taken in an environment
 * that could not be shown to be hermetic.
 *
 * `git()` accepts `{ gitDir, workTree }` and, when they are given, locates by
 * `--git-dir`/`--work-tree` INSTEAD of `-C <repoDir>` and hardens BY FLAG
 * (`--no-replace-objects`, `-c core.fsmonitor=false`, `-c core.splitIndex=false`)
 * rather than trusting the config to be unreachable. `GIT_NO_LAZY_FETCH=1` and
 * `GIT_ATTR_NOSYSTEM=1` are set on every call; a missing object fails.
 *
 * The `--show-object-format` read is the ONE non-hermetic git call, and it
 * cannot be otherwise — it is how the hermetic dir is built. It reads no content
 * and its answer is cached per repo dir.
 */
function hermeticEnv(repoDir, o, memoRoot) {
  let known = memoRoot ? memoRoot.get(repoDir) : undefined;
  if (known === undefined) {
    const common = git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], o);
    const fmt = git(repoDir, ["rev-parse", "--show-object-format"], o);
    const objectFormat = fmt.status === 0 ? fmt.stdout.trim() : "";
    if (common.status !== 0 || !common.stdout.trim() || (objectFormat !== "sha1" && objectFormat !== "sha256")) return null;
    known = { objects: path.join(common.stdout.trim(), "objects"), objectFormat };
    if (memoRoot) memoRoot.set(repoDir, known);
  }
  let root;
  try {
    root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "landed-hermetic-"));
  } catch {
    return null;
  }
  const gitDir = path.join(root, "git");
  const workTree = path.join(root, "wt");
  try {
    fs.mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.mkdirSync(workTree, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${known.objects}\n`);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/none\n");
    // repositoryformatversion follows the object format: `extensions.*` other
    // than the default requires version 1, and reading sha256 objects as sha1
    // would fail in every direction.
    fs.writeFileSync(
      path.join(gitDir, "config"),
      known.objectFormat === "sha256" ? "[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectformat = sha256\n" : "[core]\n\trepositoryformatversion = 0\n",
    );
  } catch {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* nothing else to do */ }
    return null;
  }
  return {
    root,
    gitDir,
    workTree,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a leftover temp dir is not a failure of the verdict */ }
    },
  };
}

/** The per-call options that RELOCATE a runner into `h`. Pure. */
function hermeticRunOpts(h) {
  return { gitDir: h.gitDir, workTree: h.workTree };
}

/**
 * `{ same, why }` for sameChange (the reason is what landingBacking reports).
 * `memo` = { shapes: Map, pairs: Map } shares work across calls of ONE caller.
 */
function _sameChange(runGit, repoDir, a, b, o, memo) {
  const key = `${a}\0${b}`;
  if (memo && memo.pairs.has(key)) return memo.pairs.get(key);
  // EVERY call of this comparison — both shape reads and the application — runs
  // in the hermetic environment, never against the repository as it sits.
  const h = hermeticEnv(repoDir, o, _hermeticMemo);
  let out;
  if (!h) out = { same: false, why: "no hermetic environment could be built for this repository; fail closed" };
  else {
    const run = (_dir, args, extra) => runGit(repoDir, args, { ...o, ...hermeticRunOpts(h), ...(extra || {}) });
    try {
      const sa = _changeShape(run, repoDir, a, o, memo && memo.shapes);
      const sb = _changeShape(run, repoDir, b, o, memo && memo.shapes);
      if (sa.none) out = { same: false, why: sa.none };
      else if (sb.none) out = { same: false, why: sb.none };
      else {
        // Apply a's change (a^ -> a) onto b's parent; b is the same change iff
        // the result IS b's tree. The merge runs in the HERMETIC environment, so
        // the judged repository's attributes, merge drivers, grafts, config and
        // hooks are not consulted: only its OBJECTS are.
        const r = run(repoDir, ["merge-tree", "--write-tree", "--merge-base", sa.parent, sb.parent, a], o);
        const tree = r.status === 0 ? (r.stdout.split("\n")[0] || "").trim() : "";
        if (r.status === 1) out = { same: false, why: `${a}'s change does not apply cleanly onto ${b}'s parent` };
        else if (r.status !== 0 || !SHA40.test(tree)) out = { same: false, why: `git merge-tree could not decide (status ${r.status}: ${r.stderr.trim().slice(0, 120)}); fail closed` };
        else if (tree !== sb.tree) out = { same: false, why: `${a}'s change applied onto ${b}'s parent is not ${b}'s tree` };
        else out = { same: true, why: "" };
      }
    } finally {
      h.cleanup();
    }
  }
  if (memo) memo.pairs.set(key, out);
  return out;
}

/**
 * Is commit `b` the SAME CHANGE as commit `a`? True iff both are non-merge
 * commits WITH a parent, each changes something, and applying `a`'s change
 * (`a^ -> a`) onto `b`'s parent's TREE reproduces `<b>^{tree}` EXACTLY. A genuine
 * rebase that only shifts lines still matches; a change landed at a different
 * POSITION (an identical hunk under a different function or key), with different
 * BYTES (whitespace, non-UTF-8, a NUL on a text-diffed line) or with extra
 * content does not. This replaces `git patch-id --verbatim`, which hashes
 * neither hunk position nor bytes after a NUL (round-4 PoCs F4-1 / F4-2).
 *
 * The comparison is a 3-WAY MERGE (`git merge-tree --write-tree --merge-base
 * <a>^ <b>^ <a>`) run in the HERMETIC ENVIRONMENT — a relocated git dir whose
 * objects come from `objects/info/alternates` and which carries no repo config,
 * no `info/attributes`, no `info/grafts`, no hooks and an empty work tree (see
 * `hermeticEnv`). That is what makes the verdict a property of the two COMMITS:
 * the round-5 HIGH was that a plain `merge-tree` reads `merge=<driver>`
 * attributes and `merge.<name>.driver` config from the checkout and the clone,
 * so a carrier that KEEPS a line its source deleted was reported as the same
 * change — and a configured driver EXECUTED during the check. Both are measured
 * against `-C <repo>` and closed here.
 *
 * A merge is LENIENT in the direction a patch application is strict: a hunk
 * whose surrounding context was disturbed by an unrelated nearby edit still
 * resolves, where `git apply` would refuse. That leniency is wanted — `retire`
 * and `remote-ref-reap` must recognise a landing that a neighbouring commit has
 * pushed around — and it is safe HERE only because the steerable inputs are gone.
 *
 * FAIL CLOSED: any git failure — a timeout, no binary, a missing object (a
 * partial clone is never lazily fetched: `GIT_NO_LAZY_FETCH=1`, and the promisor
 * remote is repo config the hermetic dir does not have), an environment that
 * cannot be built — is `false`, never an exception and never `true`; an empty
 * change is `false` (bound by identity only). `opts.memo` (from
 * `newSameChangeMemo()`) memoises per commit and per pair.
 *
 * `sameChangeWith` is the same implementation over a CALLER'S git runner, so a
 * surface that must neutralise git differently (the CI gate adds
 * `--no-replace-objects` and allows 60 s where this module allows 15 s) shares
 * one verdict rather than a second copy of it.
 */
function sameChangeWith(runGit, repoDir, a, b, opts = {}) {
  const o = opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined;
  try {
    return _sameChange(runGit, repoDir, a, b, o, opts.memo).same;
  } catch {
    return false; // fail closed
  }
}

function sameChange(repoDir, a, b, opts = {}) {
  return sameChangeWith(git, repoDir, a, b, opts);
}

function newSameChangeMemo() {
  return { shapes: new Map(), pairs: new Map() };
}

/**
 * The landing ledger land-lane writes, `<git-common-dir>/land-lane/
 * landing-ledger.jsonl` (schema land-lane-landing/1: {branch, source, landed,
 * kind "from"|"partial", at}), as Map<source40, Array<{branch, landed, kind}>>.
 * A garbled or foreign line (bad JSON, other schema, invalid branch, non-40-hex
 * source/landed, unknown kind) is ignored: it never backs anything. An ABSENT
 * file is an empty map. A ledger that exists but cannot be read, or a common
 * dir git will not name, THROWS — "could not read" is not "no landing".
 */
function readLandingLedger(repoDir, opts) {
  const common = gitOk(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts).trim();
  if (!common) throw new Error(`landed-map: no git common dir for ${repoDir}`);
  let text;
  try {
    text = fs.readFileSync(path.join(common, LANDING_LEDGER_REL), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return new Map();
    throw new Error(`landed-map: landing ledger unreadable: ${e.message}`);
  }
  const out = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // garbled: never backs
    if (!o || typeof o !== "object" || o.schema !== LANDING_LEDGER_SCHEMA) continue;
    if (!isValidBranchName(o.branch) || typeof o.source !== "string" || !SHA40.test(o.source)) continue;
    if (typeof o.landed !== "string" || !SHA40.test(o.landed) || !LEDGER_KINDS.has(o.kind)) continue;
    if (!out.has(o.source)) out.set(o.source, []);
    out.get(o.source).push({ branch: o.branch, landed: o.landed, kind: o.kind });
  }
  return out;
}

/**
 * Is each trailer-covered own commit BACKED by more than its trailer? A trailer
 * is text anyone can type and push; a consumer that DESTROYS on it (retire,
 * remote-ref-reap) needs the landing to be backed.
 *
 * For every sha in `own` that the map covers, each covering entry
 * `{landed: carrier, branch, kind}` of `map.bySource.get(source)` is tried; the
 * source is backed iff SOME entry is backed by
 *   (a) LEDGER  — a row with the same source, the same branch and the same kind
 *                 (a `Landed-From` entry needs kind "from", a `Landed-Partial`
 *                 entry kind "partial"), whose `landed` IS the carrier or is
 *                 the SAME CHANGE as it (`sameChange(row.landed, carrier)`,
 *                 e.g. that landing after a later local rebase of dev) —
 *                 land-lane on this machine made that landing, e.g. a
 *                 conflict-resolved one; or
 *   (b) CONTENT — `sameChange(source, carrier)`: the source's change applied
 *                 onto the carrier's parent reproduces the carrier exactly.
 * An own sha the map does NOT cover is not judged here (coverage is the map's
 * question: branchStatus); it never appears in `unbacked`.
 *
 * Returns { backed, unbacked: [{ source, carrier, why }] } — one element per
 * covering entry of each UNBACKED source. `ledger` (readLandingLedger's shape)
 * is read when absent. Pure apart from the git spawns of sameChange, memoised
 * per commit and per pair within the call; a git failure inside sameChange is
 * fail-closed (not backed, with the reason). Throws when the ledger cannot be
 * read.
 */
function landingBacking(repoDir, { map, own, ledger, timeoutMs } = {}) {
  if (!map || !(map.bySource instanceof Map)) throw new Error("landed-map: landingBacking needs a built map");
  const o = timeoutMs ? { timeoutMs } : undefined;
  const rows = ledger instanceof Map ? ledger : readLandingLedger(repoDir, o);
  const memo = newSameChangeMemo();
  const same = (a, b) => _sameChange(git, repoDir, a, b, o, memo);
  const unbacked = [];
  for (const source of own || []) {
    const entries = map.bySource.get(source);
    if (!entries || entries.length === 0) continue;
    const reasons = [];
    let backed = false;
    for (const e of entries) {
      const carrier = e.landed;
      const cand = (rows.get(source) || []).filter((r) => r.branch === e.branch);
      const sameKind = cand.filter((r) => r.kind === e.kind);
      let ledgerWhy;
      if (sameKind.some((r) => r.landed === carrier)) { backed = true; break; }
      if (sameKind.some((r) => same(r.landed, carrier).same)) { backed = true; break; }
      const content = same(source, carrier);
      if (content.same) { backed = true; break; }
      if (sameKind.length) ledgerWhy = `the ledger's ${e.kind} row(s) for ${e.branch}@${source} are bound to ${sameKind.map((r) => r.landed).join(",")}, neither of which is ${carrier} or the same change as it`;
      else if (cand.length) ledgerWhy = `the ledger records ${e.branch}@${source} only as kind ${[...new Set(cand.map((r) => r.kind))].join(",")}, not ${e.kind}`;
      else ledgerWhy = `no ledger row records ${e.branch}@${source}`;
      reasons.push({ source, carrier, why: `${ledgerWhy}; not the same change: ${content.why}` });
    }
    if (!backed) unbacked.push(...reasons);
  }
  return { backed: unbacked.length === 0, unbacked };
}

module.exports = {
  TRAILER_FROM,
  TRAILER_PARTIAL,
  TRAILER_OUTSTANDING,
  DIRECT,
  CONFIG_REL,
  CONFIG_SCHEMA,
  LOG_FORMAT,
  isValidBranchName,
  parseTrailerValue,
  formatTrailerValue,
  toAsciiPrintable,
  validateConfig,
  parseLogRecords,
  foldRecords,
  classifyBranch,
  loadConfig,
  loadConfigAt,
  resolveCommit,
  isAncestor,
  buildLandedMap,
  branchStatus,
  landedVerdict,
  landedVerdicts,
  _resetMemo,
  mapToJSON,
  LANDING_LEDGER_SCHEMA,
  sameChange,
  sameChangeWith,
  hermeticEnv,
  newSameChangeMemo,
  readLandingLedger,
  landingBacking,
  _git: git,
};
