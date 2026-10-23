#!/usr/bin/env node
/**
 * redact — a THIN CLI over the redaction map in `.claude/bin/lib/identity-scrub.mjs`
 * (§ REDACTION MAP). Matching, enrolment, map and record I/O, locking and every refusal live in
 * the engine; this file holds argument handling, target expansion and output, and ZERO identity
 * values.
 *
 *   printf %s "$VALUE" | node .claude/bin/redact.mjs add <CAT> --stdin   enrol; prints ONLY the token
 *   node .claude/bin/redact.mjs scan    [--tracked] [--allow-no-map] <paths...>   per-category counts + file:line
 *   node .claude/bin/redact.mjs check   [--tracked] [--allow-skips] [--allow-no-map] <paths...>
 *                                                               exit 1 on any value, family match or skip
 *   node .claude/bin/redact.mjs check --staged [--allow-skips] [--allow-no-map]   same, over the INDEX blobs
 *   node .claude/bin/redact.mjs apply   [--tracked] [--allow-no-map] <paths...>   values → tokens; enrols families
 *   node .claude/bin/redact.mjs restore [--tracked] [--force-tracked] <paths...>
 *                                                               undo a prior apply EXACTLY (LOCAL ONLY)
 *
 * Map: account selection (.claude/hooks/lib/redaction-map-binding.js:313-329); --map is for add only
 * (.claude/bin/redact.mjs:653-656). The engine refuses a map inside any git work tree or
 * with a mode looser than 0600. Categories OP HOST PATH ACCT ORG TEN are enrolled by `add`; the
 * value is read from STDIN only, never argv (argv lands in `ps`, shell history and transcripts).
 * `add` is the ONLY verb that creates a map.
 *
 * NO MAP IS NOT A CLEAN MAP. OP HOST PATH ACCT ORG TEN are detectable ONLY through map entries, so
 * with no map at the default location — or a map holding no entries in those six — scan, check and
 * apply REFUSE with exit 2 (the existing refusal class, the same one an explicit-but-absent map
 * takes), printing the per-category entry counts on stdout and on stderr which categories cannot be
 * detected and how to enrol them. They used to print 0 for those categories and exit 0: on a tree
 * carrying the operator's login that was a FALSE CLEAN from a disclosure gate. `--allow-no-map` is
 * the explicit opt-out for a run where map-only detection is genuinely not applicable: the pattern
 * families SID EMAIL IP are still checked, and stderr LOGS which categories were not. It never lets
 * apply CREATE a map: apply against an absent map refuses with or without it, creating nothing (no
 * directory, lock, map or record). Every scan / check / apply prints `map-entries-by-category`.
 *
 * OUTPUT NEVER CARRIES A VALUE: hits print as `<CAT>\t<path>:<line>`, where line is a number, `name`
 * (the value is in the file's NAME) or `link` (in a symlink's target text). The path itself is
 * masked first. Errors name no map path and no value; git's own stderr is never relayed.
 *
 * WHAT EACH VERB WILL AND WILL NOT DO
 *   scan / check  READ-ONLY: never write the tree, the map, or anything beside the map. Names are
 *                 checked as well as contents. A file that cannot be read as text — a NUL anywhere,
 *                 invalid UTF-8, a device — is SKIPPED and COUNTED, and under `check` any skip exits
 *                 1 unless --allow-skips. UTF-16 files with a BOM are scanned. A symlink is checked
 *                 by its target TEXT and never followed. Submodule gitlinks under --tracked are
 *                 reported as `submodule-skipped` (they are another repository) and do not fail.
 *   apply         Holds the map lock from load to save. Computes every rewrite in memory, SAVES THE
 *                 MAP FIRST (merge-checked against the map on disk), writes an apply record beside
 *                 the map, and only then rewrites files, each atomically (temp + rename) and each
 *                 re-read just before its rename: a file edited since it was read stops the run, is
 *                 left as the editor wrote it, and the apply record is cut back to the files actually
 *                 rewritten. Refuses the whole run, before any change, if a target is a symlink, sits
 *                 beside the map, or resolves outside the tree it was listed under (an ancestor
 *                 directory replaced by a symlink). Rewrites UTF-8 text only. Tokens already present
 *                 are never re-matched.
 *   restore       Rewrites only a file whose bytes equal a recorded post-apply state, puts back the
 *                 recorded original spellings, and verifies the recorded pre-apply sha256. Refuses
 *                 git-tracked files unless --force-tracked: a restored file carries RAW values.
 *                 Holds the map lock throughout, and refuses an apply-record directory that is a
 *                 symlink or lies inside a git work tree.
 *   --tracked     A directory argument expands to the files git tracks under it; untracked and
 *                 ignored files are neither read nor written. Without it, a directory is walked
 *                 without following symlinks, skipping node_modules and .venv, and any entry named
 *                 .git whatever its kind or case — a linked worktree's .git is a FILE (all
 *                 counted). A path argument through any `.git` segment is skipped the same way.
 *
 * OPTIONS COME FIRST: options are read only before the first path or `--`; every later argument
 * is a path, whatever it looks like. `--help` / `-h` print usage only as the SOLE argument.
 *
 * DOCUMENTED LIMITS — `check` exiting 0 does NOT establish any of: encoded forms of a value
 * (URL-encoding, JSON \u and \/ escapes, base64, a value split across lines or by backslash path
 * separators); hyphen-less UUIDs or non-8-hex abbreviations; IPv6; a value glued to a letter or
 * digit; git-LFS pointer targets; allowlisted family shapes (documentation/private/loopback IPv4,
 * version-shaped quads, well-known resolvers, nil/namespace UUIDs, noreply/git@ addresses);
 * untracked files under --tracked; submodule contents; an external dotfile work tree that nothing
 * announces. The engine's § REDACTION MAP header carries the full list and the file-I/O residuals.
 *
 * GIT — every git this tool runs is ENVELOPED (`spawnGitEnveloped`: a trusted binary, an env built
 * from constants), so an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE never chooses the
 * repository. The envelope reads no global git config, so a checkout git trusts only through a
 * GLOBAL `safe.directory` (another owner's clone, a bind mount) is REFUSED loudly by every verb that
 * asks git — never read as untracked or empty. `check --staged` alone honours GIT_INDEX_FILE, and
 * only as a validated file inside the repository's own git directory, so a pre-commit hook checks
 * the index `git commit -a` / `git commit -- <path>` actually commits (`resolveHookIndex`).
 *
 * EXIT 0 ok · 1 check found something (or a skip without --allow-skips) · 2 usage, refusal, or error
 * — including NO MAP (or no map-only entries) without --allow-no-map: never 0, never read as clean.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import {
  loadRedactionMap, saveRedactionMap, addRedactionValue, redactText, findRedactionHits, maskRedactionValues,
  restoreFromSlots, resolveRedactionMapPath, redactionAuthorityLine, acquireRedactionMapLock, writeApplyRecord,
  readApplyRecords, redactionRecordDir, writeFileAtomic, classifyTextBuffer, walkFilesNoFollow,
  readSymlinkText, readRegularFileNoFollow, makeHomepathRe, REDACTION_CATEGORIES,
  REDACTION_FAMILIES, RedactionMapError, redactionMapCounts, redactionMapOnlyTotal, formatRedactionMapCounts, commitApplyWrites, foldForGate,
  spawnGitEnveloped, GitEnvelopeError, hasGitMarkerAncestor, canonicalPath, pathWithin, isGitMetadataName,
} from "./lib/identity-scrub.mjs";

const USAGE = [
  "usage: redact.mjs add <CAT> --stdin | scan|check|apply|restore [options] <paths...> | check --staged",
  "options: --map <path>  --tracked  --staged  --allow-skips  --allow-no-map  --force-tracked  --help",
  "(see the header of .claude/bin/redact.mjs for what each verb will and will not do, and the DOCUMENTED LIMITS)",
].join("\n");
const MAX_FILE_BYTES = 512 * 1024 * 1024;

class CliError extends Error {}

const FLAGS = Object.freeze({
  "--tracked": "tracked", "--staged": "staged", "--stdin": "stdin", "--allow-skips": "allowSkips",
  "--allow-no-map": "allowNoMap", "--force-tracked": "forceTracked",
});

/**
 * OPTIONS COME FIRST (M-W2.1 R2 S2). Every argument used to be tried as an option, so a FILE named
 * `--help` exited 0 with nothing checked, and files named `--allow-no-map` / `--allow-skips` /
 * `--force-tracked` / `--tracked` switched on the opt-out they spell. Now: options are read only
 * BEFORE the first path or `--`; from there on every argument is a path, whatever it looks like.
 * An unknown option-shaped argument before that point is a usage error, never a path. Help is
 * the SOLE argument only. `add` takes a CATEGORY, not a path, so its `--stdin` may follow it.
 */
function parseArgs(argv) {
  const o = { verb: argv[0], rest: [], map: null, tracked: false, staged: false, stdin: false, allowSkips: false, allowNoMap: false, forceTracked: false, help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) { o.help = true; return o; }
  const takesPaths = o.verb !== "add";
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { i++; break; }
    if (!a.startsWith("-") || a === "-") {
      if (takesPaths) break;
      o.rest.push(a);
      continue;
    }
    if (a === "--map") {
      if (i + 1 >= argv.length) throw new CliError("--map needs a path");
      o.map = argv[++i];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(FLAGS, a)) throw new CliError("unknown option (options come before the first path; put `--` before a path that begins with '-')");
    o[FLAGS[a]] = true;
  }
  for (; i < argv.length; i++) o.rest.push(argv[i]);
  return o;
}

/**
 * Every git this tool runs goes through HERE, and from here through the shared envelope
 * (`spawnGitEnveloped`: trusted binary, constants-built env — loom#1471 G7). `-C <dir>` picks a
 * directory; only the envelope stops an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE from
 * picking the repository. Both streams are captured and never relayed (git can echo absolute
 * paths). An envelope that cannot run refuses, typed, with no path in the message.
 */
function gitSpawn(dir, args, { buffer = false, indexFile = null, literal = false } = {}) {
  try {
    return spawnGitEnveloped(dir, args, { encoding: buffer ? "buffer" : "utf8", maxBuffer: 1 << 30, indexFile, literalPathspecs: literal });
  } catch (e) {
    if (e instanceof GitEnvelopeError) throw new CliError(`${e.message}; nothing was written`);
    throw e;
  }
}

/** git, with stderr CAPTURED and never relayed (it can echo absolute paths). Throws code-only. */
function git(dir, args, { buffer = false, indexFile = null, literal = false } = {}) {
  const r = gitSpawn(dir, args, { buffer, indexFile, literal });
  if (r.status !== 0) throw new CliError(`git ${args[0]} failed (exit ${r.status}) — is the path inside a git work tree?`);
  return r.stdout;
}

/**
 * The hook's index for `check --staged`, VALIDATED — or null when GIT_INDEX_FILE is not set.
 *
 * WHY IT IS HONOURED AT ALL. A pre-commit hook is handed the index the commit will be built from in
 * GIT_INDEX_FILE: `.git/index` (relative) for a plain commit, but `.git/index.lock` under
 * `git commit -a` and `.git/next-index-<pid>.lock` under `git commit -- <path>`. The envelope drops
 * every inherited GIT_* variable, so without this the hook read the stale real index while git
 * committed the lock index — and a value staged only by `-a` or a path commit landed in HEAD.
 *
 * WHY IT IS FENCED. Only THIS path's three reads (`diff --cached`, `ls-files -s`, `show :<n>`) carry
 * it; `isTracked`, `check --tracked` and map discovery never do. The value is resolved the way git
 * resolves it — a relative path against the WORK-TREE TOP, not the cwd (MEASURED, GITENV2 I1: from a
 * subdirectory `GIT_INDEX_FILE=relidx git read-tree HEAD` creates `relidx` at the top, so a hook
 * that `cd`s into a subdirectory used to refuse every commit, clean ones included) — canonicalized,
 * and must be a REGULAR FILE strictly inside this worktree's OWN git directory
 * (`rev-parse --absolute-git-dir`, i.e. `.git/worktrees/<wt>` for a linked worktree — not the common
 * dir), with both sides through the same resolver (security.md § Path Containment). A variable
 * that is set but fails any of that REFUSES, loudly and typed: falling back to the real index is
 * exactly the fail-open this exists to close. The message names no path.
 */
function resolveHookIndex(top) {
  if (!Object.prototype.hasOwnProperty.call(process.env, "GIT_INDEX_FILE")) return null;
  const raw = process.env.GIT_INDEX_FILE;
  const refuse = (why) => new CliError(`check --staged refused: GIT_INDEX_FILE is set but ${why}; it is honoured only as a regular file inside this repository's own git directory — nothing was checked`);
  if (typeof raw !== "string" || raw === "") throw refuse("empty");
  let gitDir;
  try { gitDir = realpathSync(String(git(top, ["rev-parse", "--absolute-git-dir"])).trim()); } catch {
    throw refuse("this repository's git directory could not be resolved");
  }
  let idx;
  try { idx = realpathSync(path.resolve(top, raw)); } catch { throw refuse("it does not resolve to an existing file"); }
  let st;
  try { st = lstatSync(idx); } catch { throw refuse("it does not resolve to an existing file"); }
  if (!st.isFile()) throw refuse("it is not a regular file");
  if (!idx.startsWith(gitDir + path.sep)) throw refuse("it lies outside this repository's git directory");
  return idx;
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** True when canonical path `real` is `root` or lies under it. Both must come from `realpathSync`. */
const within = (real, root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Expand path arguments into targets `{ abs, label, kind }`, kind ∈ file | symlink | special |
 * submodule | missing | outside. Nothing is followed: a symlink is a target of kind symlink.
 *
 * CONTAINMENT (C1 R2 F4, security.md § Path Containment). A target reached by expanding a
 * DIRECTORY must resolve inside it: the candidate and the boundary root are BOTH resolved through
 * `realpathSync`, and the canonical forms compared. Under --tracked the boundary is the repository
 * top; git lists `sub/f.md` by NAME, so an ancestor directory `sub` replaced by a symlink leads
 * outside the repository while every lexical test passes. Such a target — or one that will not
 * resolve at all — is kind `outside`, which `apply` refuses and `check` counts as a skip. A walked
 * tree never follows a link, so its entries resolve inside the walk root by construction; they are
 * checked all the same. An explicit FILE argument has no boundary beyond the path the operator named.
 *
 * An argument with ANY path segment naming git's metadata — `.git` in any case, in the path as
 * given OR in its canonical form (a symlink into `.git/`) — is skipped, never read or written, as
 * the walk skips such an entry (F3; M-W2.1 R2 S4: it used to test the LAST segment, exactly).
 *
 * Git is asked with LITERAL pathspecs (M-W2.1 R2 S3): a directory named `d*` lists `d*` only.
 */
function underGitMetadata(given) {
  const segs = (p) => p.split(path.sep).some(isGitMetadataName);
  if (segs(given)) return true;
  try { return segs(realpathSync(given)); } catch { return false; }
}

function expand(paths, { tracked }, skipped) {
  const out = [];
  const bounded = (abs, root, rest) => {
    let real = null;
    try { real = realpathSync(abs); } catch { /* unresolvable: fail closed below */ }
    return real !== null && within(real, root) ? { abs, ...rest } : { abs, ...rest, kind: "outside" };
  };
  for (const p of paths) {
    const given = path.resolve(p);
    if (underGitMetadata(given)) { skipped.dirs++; continue; }
    const lst = lstatSync(given);
    if (lst.isSymbolicLink()) { out.push({ abs: given, label: path.basename(given), kind: "symlink" }); continue; }
    if (!lst.isDirectory()) { out.push({ abs: given, label: path.basename(given), kind: lst.isFile() ? "file" : "special" }); continue; }
    const root = realpathSync(given);
    if (tracked) {
      const top = realpathSync(String(git(root, ["rev-parse", "--show-toplevel"])).trim());
      const rel = path.relative(top, root) || ".";
      const listed = String(git(top, ["ls-files", "-s", "-z", "--", rel], { literal: true }));
      for (const rec of listed.split("\0").filter(Boolean)) {
        const tab = rec.indexOf("\t");
        const mode = rec.slice(0, rec.indexOf(" "));
        const relPath = rec.slice(tab + 1);
        const abs = path.join(top, relPath);
        if (mode === "160000") { out.push({ abs, label: relPath, kind: "submodule" }); continue; }
        let kind = "file";
        try { const s = lstatSync(abs); kind = s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : "special"; } catch { kind = "missing"; }
        // A symlink target is never followed (refused by kind); a missing one writes nothing.
        out.push(kind === "file" || kind === "special" ? bounded(abs, top, { label: relPath, kind }) : { abs, label: relPath, kind });
      }
    } else {
      walkFilesNoFollow(root, (abs, kind) => out.push(kind === "symlink" ? { abs, label: path.relative(root, abs), kind } : bounded(abs, root, { label: path.relative(root, abs), kind })),
        { skipDirs: [".git", "node_modules", ".venv"], onSkipDir: () => { skipped.dirs++; } });
    }
  }
  const seen = new Set();
  return out.filter((t) => (seen.has(t.abs) ? false : (seen.add(t.abs), true))).sort((a, b) => (a.abs < b.abs ? -1 : 1));
}

/**
 * Mask a label for printing: map values, families, then the structural home-path shape (L1).
 * Map values go through the fence PRINTERS' mask (`maskRedactionValues`: substring and folded,
 * never weaker than a gate), NOT the rewrite matcher, which is word-bounded and unfolded by design
 * — a file NAME glues a value to its neighbours (`notes<value>x.md`) or spells it with a combining
 * mark, and the rewrite matcher printed exactly those (C1 R2 F5a). `redactText` then adds only the
 * families the map does not enumerate; the map's values are already tokens, which it protects.
 */
function safeLabel(label, map) {
  let s;
  try { s = redactText(maskRedactionValues(label, { map }), { entries: map.entries.slice() }).text; } catch { s = "<unprintable path>"; }
  if (path.isAbsolute(s)) return s.replace(makeHomepathRe(), "<home>");
  // A RELATIVE label has lost the leading separator the structural home shape keys on
  // (`Users/<name>/…` under a scan root of `/`): mask it as if rooted, then drop the added root.
  const m = ("/" + s).replace(makeHomepathRe(), "<home>");
  return m.startsWith("/") ? m.slice(1) : m;
}

function readTarget(t) {
  const buf = readRegularFileNoFollow(t.abs, { encoding: null, maxBytes: MAX_FILE_BYTES, label: "target file" });
  return { buf, ...classifyTextBuffer(buf) };
}

function report(rows, map, skipped, { verb }) {
  const counts = new Map();
  for (const r of rows) {
    const lbl = safeLabel(r.label, map);
    for (const h of r.hits) {
      counts.set(h.cat, (counts.get(h.cat) || 0) + 1);
      process.stdout.write(`${h.cat}\t${lbl}:${h.where ?? h.line}${h.confusable ? " (confusable)" : ""}\n`);
    }
  }
  for (const c of [...REDACTION_CATEGORIES, ...REDACTION_FAMILIES]) process.stdout.write(`count ${c} ${counts.get(c) || 0}\n`);
  printMapEntries(map);
  process.stdout.write(`files-with-hits ${rows.filter((r) => r.hits.length).length} skipped-binary ${skipped.binary} skipped-non-utf8 ${skipped.nonUtf8} skipped-special ${skipped.special} skipped-reserved ${skipped.reserved} submodule-skipped ${skipped.submodule} dirs-skipped ${skipped.dirs}\n`);
  return [...counts.values()].reduce((a, b) => a + b, 0);
}

/** The loaded map's entry counts on stdout: the total, then every category (counts only). */
function printMapEntries(map) {
  process.stdout.write(redactionAuthorityLine(map.authority) + "\n");
  process.stdout.write(`map-entries ${map.entries.length}\n`);
  process.stdout.write(`map-entries-by-category ${formatRedactionMapCounts(redactionMapCounts(map))}\n`);
}

/** Whether a map FILE exists at `mapPath` (anything at the path counts; load decides if it is usable). */
function mapFilePresent(mapPath) {
  try { lstatSync(mapPath); return true; } catch (e) {
    if (e && e.code === "ENOENT") return false;
    return true; // not ENOENT: present but unreadable — loadRedactionMap refuses it, typed
  }
}

const CATS = REDACTION_CATEGORIES.join(" ");
const FAMS = REDACTION_FAMILIES.join(" ");
const ENROL_HINT = "create one with `redact.mjs add <CAT> --stdin`";

/**
 * NO MAP IS NOT A CLEAN MAP. A map with no entries in OP HOST PATH ACCT ORG TEN — absent at the
 * default location, or present holding families only — cannot detect those categories at all, so a
 * scan / check over it must not print 0 for them and exit 0. Without --allow-no-map: print the
 * counts, then REFUSE (exit 2). With it: run, and LOG on stderr exactly what was not checked.
 */
function requireMapCoverage(o, map, mapPath) {
  if (redactionMapOnlyTotal(redactionMapCounts(map)) > 0) return;
  const what = mapFilePresent(mapPath)
    ? `the redaction map holds no ${CATS} entries (map-entries ${map.entries.length})`
    : "no redaction map (map-entries 0)";
  if (o.allowNoMap) {
    process.stderr.write(`redact: --allow-no-map: ${what}, so ${CATS} were NOT checked — this result covers the pattern families ${FAMS} only\n`);
    return;
  }
  printMapEntries(map);
  throw new CliError(`${what}: ${CATS} cannot be detected without map entries, so this ${o.verb} cannot report them clean — nothing was checked; ${ENROL_HINT}, or pass --allow-no-map to check only the pattern families ${FAMS} (logged)`);
}

const fileSkips = (s) => s.binary + s.nonUtf8 + s.special + s.reserved;

function hitsFor(text, map) {
  return { hits: findRedactionHits(text, map).hits };
}

function scanOrCheck(o, map) {
  const skipped = { binary: 0, nonUtf8: 0, special: 0, reserved: 0, submodule: 0, dirs: 0 };
  const rows = [];
  const tally = (label, cls, extra = []) => {
    const hits = [...extra];
    if (cls.text !== undefined) {
      hits.push(...hitsFor(cls.text, map).hits);
    } else if (cls.kind === "binary") skipped.binary++;
    else if (cls.kind === "non-utf8") skipped.nonUtf8++;
    rows.push({ label, hits });
  };
  const nameHits = (label) => findRedactionHits(label, map).hits.map((h) => ({ cat: h.cat, where: "name" }));
  if (o.staged) {
    const top = String(git(process.cwd(), ["rev-parse", "--show-toplevel"])).trim();
    // The UNION of the real index and, when git handed one to a hook, the hook's index (see
    // `resolveHookIndex`). Each index's staged blobs are read and scanned, so a hit can only be
    // ADDED by the second index, never subtracted: even an index that passes containment cannot
    // hide a value the real index holds. One (name, blob) pair is scanned once.
    const hookIndex = resolveHookIndex(top);
    const seen = new Set();
    for (const indexFile of hookIndex === null ? [null] : [null, hookIndex]) {
      const names = String(git(top, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT"], { indexFile })).split("\0").filter(Boolean);
      for (const n of names) {
        // The EXACT entry for `n`, read from EVERY record (M-W2.1 R2 S3): it used to take the first
        // record of a wildmatch, so a gitlink `A` sorting before a file named `[A-Z]` made the file
        // read as a submodule and go unchecked. Literal pathspecs, and the record whose name IS `n`.
        const recs = String(git(top, ["ls-files", "-s", "-z", "--", n], { indexFile, literal: true })).split("\0").filter(Boolean);
        const own = recs.find((rec) => rec.slice(rec.indexOf("\t") + 1) === n);
        if (own === undefined) throw new CliError("check --staged: a staged name has no exact index entry — nothing was reported clean");
        const mode = own.slice(0, own.indexOf(" "));
        if (mode === "160000") {
          if (!seen.has(`${n}\0submodule`)) { seen.add(`${n}\0submodule`); skipped.submodule++; }
          continue;
        }
        const buf = git(top, ["show", `:${n}`], { buffer: true, indexFile });
        const key = `${n}\0${sha256(buf)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tally(n, classifyTextBuffer(buf), nameHits(n));
      }
    }
  } else {
    for (const t of expand(o.rest, { tracked: o.tracked }, skipped)) {
      if (t.kind === "submodule") { skipped.submodule++; continue; }
      const names = nameHits(t.label);
      if (t.kind === "symlink") {
        rows.push({ label: t.label, hits: [...names, ...hitsFor(readSymlinkText(t.abs), map).hits.map((h) => ({ cat: h.cat, where: "link" }))] });
        continue;
      }
      if (t.kind !== "file") { skipped.special++; rows.push({ label: t.label, hits: names }); continue; }
      tally(t.label, readTarget(t), names);
    }
  }
  const n = report(rows, map, skipped, { verb: o.verb });
  if (o.verb !== "check") return 0;
  if (fileSkips(skipped) && !o.allowSkips) process.stderr.write(`redact: ${fileSkips(skipped)} file(s) could not be read as text and were NOT checked (pass --allow-skips to accept that)\n`);
  return n > 0 || (fileSkips(skipped) && !o.allowSkips) ? 1 : 0;
}

/**
 * True when `abs` is inside the map's directory (map, lock, apply records) — never a target.
 * Through the engine's ONE canonicalizer (`pathWithin`, M-W2.1 R2 S1): the JS `realpathSync` used
 * here kept the case it was handed, so on a case-insensitive volume `MAPDIR/redaction-map.json`
 * read as NOT beside `mapdir/` and apply tokenized the map and its records. `isTracked` resolves
 * through the same canonicalizer.
 */
function besideMap(abs, mapPath) {
  return pathWithin(abs, path.dirname(path.resolve(mapPath)));
}

/**
 * apply NEVER CREATES A MAP. It used to — `saveRedactionMap` on an absent default location wrote a
 * fresh map holding only the families it auto-enrolled, so the operator was left with a map that
 * could detect none of OP HOST PATH ACCT ORG TEN and a tree still carrying every such value. An
 * absent map now refuses BEFORE the lock is taken (the lock creates the map's directory), so a
 * refused apply leaves nothing behind; --allow-no-map does not lift this. `add` creates a map.
 */
function applyNoMapError(explicit) {
  const what = explicit ? "the map named explicitly does not exist" : "no redaction map";
  return new CliError(`apply refused: ${what} — apply never creates a map as a side effect (one it made could not hold ${CATS}); ${ENROL_HINT} first — nothing was written`);
}

function apply(o, mapPath, explicit) {
  const skipped = { binary: 0, nonUtf8: 0, special: 0, reserved: 0, submodule: 0, dirs: 0 };
  if (!mapFilePresent(mapPath)) throw applyNoMapError(explicit);
  const targets = expand(o.rest, { tracked: o.tracked }, skipped);
  const refused = targets.filter((t) => t.kind === "symlink" || t.kind === "special" || t.kind === "outside" || besideMap(t.abs, mapPath));
  const release = acquireRedactionMapLock(mapPath);
  try {
    // Re-asked UNDER the lock: a map removed between the check above and here must not be recreated.
    if (!mapFilePresent(mapPath)) throw applyNoMapError(explicit);
    const map = loadRedactionMap(mapPath, { explicit });
    if (redactionMapOnlyTotal(redactionMapCounts(map)) === 0) {
      if (!o.allowNoMap) {
        printMapEntries(map);
        throw new CliError(`apply refused: the redaction map holds no ${CATS} entries (map-entries ${map.entries.length}), so apply would leave every such value in place; enrol them with \`redact.mjs add <CAT> --stdin\`, or pass --allow-no-map to redact the pattern families ${FAMS} only (logged) — nothing was written`);
      }
      process.stderr.write(`redact: --allow-no-map: the redaction map holds no ${CATS} entries, so ${CATS} were NOT redacted — this apply covers the pattern families ${FAMS} only\n`);
    }
    if (refused.length) {
      for (const t of refused) process.stderr.write(`redact: refusing target ${safeLabel(t.label, map)} (${t.kind === "file" ? "beside the map" : t.kind === "outside" ? "resolves outside the tree it was listed under" : t.kind})\n`);
      throw new CliError(`apply refused: ${refused.length} target(s) are symlinks, special files, outside their tree or beside the map — nothing was written`);
    }
    // PHASE 1 — compute every rewrite in memory; enrolments land in `map` only.
    const rows = [], writes = [];
    for (const t of targets) {
      if (t.kind === "submodule") { skipped.submodule++; continue; }
      if (t.kind !== "file") continue;
      const st = lstatSync(t.abs);
      const cls = readTarget(t);
      if (cls.kind !== "utf8") { if (cls.kind === "binary") skipped.binary++; else skipped.nonUtf8++; continue; }
      let r;
      try { r = redactText(cls.text, map, { enrolFamilies: true }); }
      catch (e) { if (e instanceof RedactionMapError && e.kind === "reserved-chars") { skipped.reserved++; continue; } throw e; }
      rows.push({ label: t.label, hits: r.hits });
      if (r.text !== cls.text) {
        // Invariant: the rewrite changes ONLY token spans. Restoring from the slots must give back the
        // exact pre-apply bytes, or restore could never undo this write — refuse before anything lands.
        if (sha256(Buffer.from(restoreFromSlots(r.text, r.slots), "utf8")) !== sha256(cls.buf)) {
          throw new CliError(`apply refused: ${safeLabel(t.label, map)} would not round-trip byte-exact through restore — nothing was written`);
        }
        writes.push({ abs: t.abs, label: t.label, text: r.text, mode: st.mode & 0o777, rec: { path: realpathSync(t.abs), pre_sha256: sha256(cls.buf), post_sha256: sha256(Buffer.from(r.text, "utf8")), slots: r.slots } });
      }
    }
    // PHASE 2 — the map first: a failure after this point leaves every written token restorable.
    saveRedactionMap(mapPath, map);
    // PHASE 3 — the apply record, holding the original spellings restore needs.
    const record = { created: new Date().toISOString(), files: writes.map((w) => w.rec) };
    const id = writes.length ? writeApplyRecord(mapPath, record) : null;
    // PHASE 4 — file rewrites, each atomic, each re-checked against what PHASE 1 read (C1 R2 F7);
    // on a stop the record is cut back to the files actually rewritten (`commitApplyWrites`).
    try {
      commitApplyWrites(mapPath, { id, record, writes, maxBytes: MAX_FILE_BYTES });
    } catch (e) {
      if (e instanceof RedactionMapError && e.kind === "changed" && Number.isInteger(e.index)) {
        throw new CliError(`apply stopped: ${safeLabel(writes[e.index].label, map)} changed since it was read (or no longer resolves to the same file) — it was NOT rewritten; the ${e.index} file(s) before it were, and the apply record lists only those`);
      }
      throw e;
    }
    report(rows, map, skipped, { verb: "apply" });
    process.stdout.write(`applied: ${writes.length} file(s) rewritten${id ? `; apply record ${id}` : ""}\n`);
    return 0;
  } finally {
    release();
  }
}

/**
 * Whether git tracks `abs`, asked INSIDE the shared envelope (`gitSpawn`): an inherited GIT_DIR /
 * GIT_INDEX_FILE used to answer for a DIFFERENT repository, read "untracked", and let restore
 * write RAW values into a tracked file. A git that did not run at all is not "untracked" either —
 * it refuses, so the guard can never open on an instrument that never answered.
 */
function isTracked(abs) {
  // Asked with the ON-DISK name. On a case-insensitive volume `A.md` opens tracked `a.md`, but
  // `ls-files --error-unmatch A.md` exits 1 even under `core.ignorecase` (MEASURED, GITENV2 F2), so a
  // wrong-case argument read "untracked" and restore wrote RAW values into the tracked file.
  // `canonicalPath` (the engine's ONE canonicalizer, shared with `besideMap`) returns the on-disk
  // case. The name is a LITERAL pathspec (M-W2.1 R2 S3): as a wildmatch, an untracked `*.md` read
  // "tracked" because a tracked sibling matched it.
  const onDisk = canonicalPath(abs);
  const r = gitSpawn(path.dirname(onDisk), ["ls-files", "--error-unmatch", "--", path.basename(onDisk)], { literal: true });
  if (r.error || r.signal) throw new CliError(`could not determine whether a restore target is tracked by git (${r.error ? r.error.code || "spawn error" : r.signal}) — nothing was written`);
  // `ls-files --error-unmatch`: 0 = tracked, 1 = untracked inside a repository. ANY other status
  // means git ran but could not answer — 128 for "not a repository" AND for "a repository git cannot
  // open" (an unknown extension; the envelope's empty global config dropping a `safe.directory`).
  // Only the first may read as untracked, and git's own exit code cannot tell them apart, so the
  // `.git` marker walk decides: no repository here at all → untracked; a repository is present →
  // refuse, because "untracked" would let restore write RAW values into a file git may well track.
  if (r.status === 0) return true;
  // An EXTERNAL work tree announced only by the caller's environment (`vcsh enter` / `yadm enter`
  // export GIT_DIR + GIT_WORK_TREE) has no `.git` marker, and the envelope deliberately drops both
  // variables, so git answers 128 "not a repository" about a file the caller's git DOES track
  // (MEASURED, GITENV2 F1: restore wrote raw values there). The announcement is honoured as a
  // REFUSAL, never as a repository to ask: steering git by an inherited GIT_DIR is exactly what the
  // envelope exists to stop. Same contract as `isInsideGitWorkTree`'s announced-work-tree test.
  // It is checked for "untracked" (1) too: an announced tree nested inside a marker repository
  // reads 1 from THAT repository while the announced one may track the file.
  if (announcedExternalTree(onDisk)) {
    throw new CliError("could not determine whether a restore target is tracked: GIT_DIR / GIT_WORK_TREE announce a work tree around it, which this tool does not ask git about — pass --force-tracked if you mean it; nothing was written");
  }
  if (r.status === 1) return false;
  if (!hasGitMarkerAncestor(abs)) return false;
  throw new CliError(`could not determine whether a restore target is tracked: it lies in a git repository that git could not read (exit ${r.status}) — nothing was written`);
}

/**
 * True when the caller's environment announces a git work tree that may contain `real` (a
 * canonical path): GIT_DIR set at all, or a GIT_WORK_TREE whose canonical form contains it. Adds
 * refusals only; it never makes a file read as tracked or untracked.
 */
function announcedExternalTree(real) {
  if (Object.prototype.hasOwnProperty.call(process.env, "GIT_DIR")) return true;
  const gwt = process.env.GIT_WORK_TREE;
  if (typeof gwt !== "string" || gwt.trim() === "") return false;
  let root;
  try { root = realpathSync.native(gwt); } catch { return false; } // same resolver as `real`
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Printed in place of a restore label that cannot be shown to carry no known value. */
const LABEL_WITHHELD = "<target name withheld: no redaction map to mask it with>";
const LABEL_WITHHELD_HELD = "<target name withheld: it carries a value an apply record holds>";

/**
 * Every original spelling the apply records hold, folded the way the gates read (`foldForGate`).
 * These are the raw values a restore puts back — the map may no longer list one (a value removed
 * from the map after its apply), but the record still does, so it is masking data too.
 */
function recordHeldValues(records) {
  const held = new Set();
  for (const r of records) for (const f of r.files || []) for (const sl of f.slots || []) {
    if (sl && typeof sl.original === "string") { const v = foldForGate(sl.original); if (v) held.add(v); }
  }
  return [...held];
}

/**
 * A restore diagnostic's label. Restoration itself never reads a map VALUE — the apply record
 * carries every original spelling — but the label it prints is a file NAME, which can carry one.
 * Two trusted inputs mask it: the map (through the same mask as every other verb's, C1 R2 F5), and
 * the values the apply records hold, which cover a value removed from the map after its apply (A5).
 * A record-held value cannot be swapped for a token (the record keeps no category), so a label that
 * still carries one, read folded as a substring the way the gates read, is WITHHELD whole. With
 * neither input holding anything, nothing can tell a value in the name from any other text, so the
 * name is withheld too: never an unmasked fallback.
 *
 * THE HELD VALUES ARE READ AGAINST THE ORIGINAL NAME, BEFORE ANY MAP MASK (F5-SEC-OVERLAP). They
 * used to be read against the ALREADY-masked name — and a map value OVERLAPPING a held value (one
 * starting with the held value's tail, or ending with its head) was swapped for its token first,
 * taking part of the held value with it. The held value then no longer matched, and its remaining
 * fragment printed. A mask must never destroy the evidence the second check needs, so the held
 * check runs on the raw name, independently of the mask. The masked name is read again after, so
 * a held value the mask itself could surface is withheld too.
 */
function restoreLabel(label, map, held) {
  if (!map.entries.length && !held.length) return LABEL_WITHHELD;
  const raw = foldForGate(String(label));
  if (held.some((v) => raw.includes(v))) return LABEL_WITHHELD_HELD;
  const s = safeLabel(label, map);
  const f = foldForGate(s);
  return held.some((v) => f.includes(v)) ? LABEL_WITHHELD_HELD : s;
}

/**
 * restore HOLDS THE MAP LOCK from the map load to the last write (M-W2.1 R2 S5), so it never reads
 * records or the map mid-apply. With no map folder at all there is no record to restore from and
 * nothing to lock — the lock is not taken, so a restore never CREATES the folder. The apply
 * records are read through the engine's record-directory checks (outside every work tree, never
 * a symlink), the same placement the map itself is held to.
 */
function restore(o, mapPath, explicit) {
  let mapDirPresent = true;
  try { lstatSync(path.dirname(path.resolve(mapPath))); } catch (e) { if (e && e.code === "ENOENT") mapDirPresent = false; }
  const release = mapDirPresent ? acquireRedactionMapLock(mapPath) : () => {};
  try {
    return restoreLocked(o, mapPath, explicit);
  } finally {
    release();
  }
}

function restoreLocked(o, mapPath, explicit) {
  // Refuses an unusable map location exactly as the other verbs do, and is the mask for every label.
  const map = loadRedactionMap(mapPath, { explicit });
  const skipped = { binary: 0, nonUtf8: 0, special: 0, reserved: 0, submodule: 0, dirs: 0 };
  const targets = expand(o.rest, { tracked: o.tracked }, skipped).filter((t) => t.kind !== "submodule");
  // Read BEFORE any refusal: the records are the second masking input for every label below.
  const records = readApplyRecords(mapPath);
  const held = recordHeldValues(records);
  for (const t of targets) {
    if (t.kind !== "file" || besideMap(t.abs, mapPath)) throw new CliError(`restore refused: ${restoreLabel(t.label, map, held)} is a ${t.kind === "file" ? "file beside the map" : t.kind === "outside" ? "target resolving outside the tree it was listed under" : t.kind} — nothing was written`);
    if (!o.forceTracked && isTracked(t.abs)) throw new CliError(`restore refused: ${restoreLabel(t.label, map, held)} is tracked by git, and a restored file carries RAW values — pass --force-tracked if you mean it; nothing was written`);
  }
  let restored = 0, unmatched = 0;
  for (const t of targets) {
    const st = lstatSync(t.abs);
    const buf = readRegularFileNoFollow(t.abs, { encoding: null, maxBytes: MAX_FILE_BYTES, label: "target file" });
    const cur = sha256(buf);
    const real = realpathSync(t.abs);
    let entry = null;
    for (const r of records) { entry = (r.files || []).find((f) => f.path === real && f.post_sha256 === cur) || null; if (entry) break; }
    if (!entry) { unmatched++; continue; }
    const out = restoreFromSlots(buf.toString("utf8"), entry.slots);
    if (sha256(Buffer.from(out, "utf8")) !== entry.pre_sha256) throw new CliError(`restore refused: ${restoreLabel(t.label, map, held)} would not reproduce its recorded pre-apply bytes — nothing more was written`);
    writeFileAtomic(t.abs, out, st.mode & 0o777);
    restored++;
  }
  process.stdout.write(`restored ${restored} file(s); ${unmatched} had no matching apply record (changed since, or never applied). Restored files carry RAW values: never stage or commit them.\n`);
  return 0;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(USAGE + "\n"); return 0; }
  if (!["add", "scan", "apply", "restore", "check"].includes(o.verb)) { process.stderr.write(USAGE + "\n"); return 2; }
  if (o.verb === "add" && o.map !== null && o.map.trim() === "") throw new RedactionMapError("no-path", "--map requires a non-empty path");
  const r = resolveRedactionMapPath();
  if (o.map !== null && o.verb !== "add") throw new RedactionMapError("map-override", "--map is accepted only by add; enforcing commands use the account map");
  const mapPath = o.map || r.path;
  const explicit = o.map ? true : r.explicit;

  if (o.verb === "add") {
    const [cat, ...extra] = o.rest;
    if (!o.stdin || extra.length) throw new CliError("add takes its value on STDIN only (--stdin); a value on argv lands in ps, shell history and transcripts");
    if (!cat) { process.stderr.write(USAGE + "\n"); return 2; }
    const value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    const release = acquireRedactionMapLock(mapPath);
    try {
      const map = loadRedactionMap(mapPath, { explicit: false });
      const token = addRedactionValue(map, cat, value);
      saveRedactionMap(mapPath, map);
      process.stdout.write(token + "\n");
    } finally { release(); }
    return 0;
  }
  const covered = () => { const map = loadRedactionMap(mapPath, { explicit }); requireMapCoverage(o, map, mapPath); return map; };
  if (o.verb === "check" && o.staged) return scanOrCheck(o, covered());
  if (!o.rest.length) { process.stderr.write(USAGE + "\n"); return 2; }
  if (o.verb === "scan" || o.verb === "check") return scanOrCheck(o, covered());
  if (o.verb === "apply") return apply(o, mapPath, explicit);
  return restore(o, mapPath, explicit);
}

try {
  process.exitCode = main();
} catch (e) {
  // Typed refusals carry no path and no value by construction; anything else is reported by its
  // class and code only, because a raw error message can quote a path under the operator's home.
  if (e instanceof RedactionMapError || e instanceof CliError) process.stderr.write(`redact: ${e.message}\n`);
  else process.stderr.write(`redact: failed (${(e && e.name) || "Error"}${e && e.code ? " " + e.code : ""})\n`);
  process.exitCode = 2;
}
