#!/usr/bin/env node
/*
 * Slot-overlay composition helper for coc-sync Gate 2 (Phase F2).
 *
 * Reads a global rule and a language-axis variant overlay, composes them
 * by replacing each slot body in the global with the overlay's slot body,
 * writes the composed result to stdout (or --out <path>).
 *
 * parseSlotsV5 + applyOverlay are imported from ./lib/slot-parser.mjs
 * (shared canonical implementation, also used by emit.mjs).
 *
 * Usage:
 *   node .claude/bin/compose.mjs --global <path> --overlay <path>          # stdout
 *   node .claude/bin/compose.mjs --global <path> --overlay <path> --out <path>
 *   node .claude/bin/compose.mjs --check --global <path> --overlay <path> # validate only, no output
 *
 * Exit codes: 0 = success; 1 = composition failure (slot not in global, etc.);
 *             2 = usage error.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyOverlay } from "./lib/slot-parser.mjs";

// Symlink-safe read (O_RDONLY|O_NOFOLLOW, leaf-only guard). An artifact-source
// file swapped for a symlink between the existsSync probe and the read raises
// ELOOP instead of silently reading the attacker's target (#569 sibling-site
// sweep — the compose-source twin of emit.mjs / coc-manifest.mjs).
function safeReadFileSync(filePath, encoding) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

// realpath an existing path (resolves the macOS /var → /private/var and
// /tmp → /private/tmp symlinks); falls back to the lexical path when the
// target does not yet exist.
function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Canonicalise an absolute path for a CONTAINMENT decision.
//
// path.resolve() only normalises "." / ".." lexically — it does NOT follow
// symlinks, so a symlinked component whose target escapes the boundary is
// lexically indistinguishable from a real in-tree path. Every component that
// EXISTS is therefore resolved through fs.realpathSync; a not-yet-existing
// remainder (a fresh --out target) is re-appended lexically, which is what
// lets this run before the file is created.
//
// Fails CLOSED: any resolution failure other than a genuinely-absent
// component — EACCES, ELOOP, ENOTDIR — propagates to the caller, as does a
// DANGLING symlink (the component exists via lstat but will not resolve), so
// an unresolvable path is refused rather than silently treated as lexical.
function realpathForContainment(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return tail.length === 0
        ? fs.realpathSync(current)
        : path.join(fs.realpathSync(current), ...tail);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // ENOENT on something lstat CAN see is a dangling symlink, not an
      // absent component — refuse rather than fall back to the lexical form.
      let componentExists = false;
      try {
        fs.lstatSync(current);
        componentExists = true;
      } catch {
        /* genuinely absent — keep walking up */
      }
      if (componentExists) throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e; // reached the filesystem root
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// True when the candidate IS the boundary root or lies beneath it.
//
// `canonicalCandidate` MUST already have come from realpathForContainment, and
// `root` is canonicalised here through that SAME resolver, so the two sides are
// always compared in one form. A MIXED-form comparison — one side realpath'd,
// the other merely path.resolve'd — rejects paths genuinely inside the root.
// Passing a merely path.resolve'd candidate reintroduces the lexical bypass.
//
// SCOPE — this closes the LEXICAL-BYPASS class only. It does NOT by itself
// defeat check-to-use TOCTOU: a symlink swapped in between this check and the
// open/write sink is not observable here. Defeating that needs fd-based /
// O_NOFOLLOW enforcement AT the sink (see safeReadFileSync above, which is
// what carries the leaf guard on the read path).
function isWithinRoot(canonicalCandidate, root) {
  const resolvedRoot = realpathForContainment(root);
  return (
    canonicalCandidate === resolvedRoot ||
    canonicalCandidate.startsWith(resolvedRoot + path.sep)
  );
}

function parseArgs(argv) {
  const args = { global: null, overlay: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--global") args.global = argv[++i];
    else if (a === "--overlay") args.overlay = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: compose.mjs --global <path> --overlay <path> [--out <path>] [--check]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.global || !args.overlay) {
    process.stderr.write("error: --global and --overlay are required\n");
    process.exit(2);
  }

  // Path-traversal guard: coc-sync/orchestrator is an LLM, so we
  // cannot fully trust argv even though the human operator typed the
  // command. Resolve all three paths and reject anything that escapes
  // the loom REPO root.
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  function assertInRepo(p, flag) {
    const resolved = path.resolve(p);
    let canonical;
    try {
      canonical = realpathForContainment(resolved);
    } catch (e) {
      // Fail closed: a path we cannot canonicalise is not a path we can prove
      // is inside the repo.
      process.stderr.write(
        `error: ${flag} path could not be resolved (${e.code ?? e.message}): ${resolved}\n`,
      );
      process.exit(2);
    }
    if (!isWithinRoot(canonical, REPO)) {
      // Permit ephemeral temp-dir write targets for emission outputs, since
      // --out is legitimately ephemeral. Reads must stay in repo.
      //
      // macOS portability: the OS temp dir is /var/folders/<…>/T (the Darwin
      // user temp dir), which realpath-resolves to /private/var/folders/… —
      // and BSD `mktemp` with no -p returns it regardless of $TMPDIR (the
      // #F89 false-positive class that made verify-overlays.sh report every
      // slot overlay as compose-failed on macOS). Normalise BOTH the
      // candidate temp roots AND the resolved out-path (via its existing
      // parent) through realpath so the /var→/private/var (and /tmp→
      // /private/tmp) symlinks and the os.tmpdir() / $TMPDIR / bare-/tmp trio
      // all match — without widening the path-traversal surface beyond
      // ephemeral temp.
      if (flag === "--out") {
        // `/var/folders` is the Darwin user-temp tree root that BSD `mktemp`
        // returns regardless of $TMPDIR (os.tmpdir() honours the $TMPDIR
        // override, so it alone misses the mktemp-produced path). On Linux
        // this root simply never matches a real out-path.
        const tempRoots = [os.tmpdir(), process.env.TMPDIR, "/tmp", "/var/folders"]
          .filter(Boolean)
          .map((r) => realpathOrSelf(path.resolve(r)));
        // Compare the SAME canonical form used for the repo-root decision.
        // The former `realpathOrSelf(path.dirname(resolved))` resolved only
        // the parent and fell back to the LEXICAL path whenever that parent
        // did not exist yet, so a legitimate `--out <tmp>/sub/new.md` compared
        // a lexical `/tmp/…` against a realpath'd `/private/tmp` root and was
        // refused. realpathForContainment resolves every EXISTING component
        // and re-appends only the not-yet-created remainder, which fixes that
        // and additionally rejects a symlinked FINAL component whose target
        // escapes temp. Residual (bounded-trust, F53-class — see
        // multi-operator-coordination.md § Origin F53): a symlink planted
        // between this check and fs.writeFileSync (no O_NOFOLLOW) is still
        // followed — that is check-to-use TOCTOU, not a lexical bypass, and
        // closing it needs enforcement AT the sink.
        const resolvedReal = canonical;
        if (
          tempRoots.some(
            (root) =>
              resolvedReal === root || resolvedReal.startsWith(root + path.sep),
          )
        ) {
          return resolved;
        }
      }
      process.stderr.write(`error: ${flag} path escapes loom repo: ${resolved}\n`);
      process.exit(2);
    }
    return resolved;
  }
  const globalPath = assertInRepo(args.global, "--global");
  const overlayPath = assertInRepo(args.overlay, "--overlay");
  const outPath = args.out ? assertInRepo(args.out, "--out") : null;

  if (!fs.existsSync(globalPath)) {
    process.stderr.write(`error: --global path not found: ${globalPath}\n`);
    process.exit(2);
  }
  if (!fs.existsSync(overlayPath)) {
    process.stderr.write(`error: --overlay path not found: ${overlayPath}\n`);
    process.exit(2);
  }

  const globalSrc = safeReadFileSync(globalPath, "utf8");
  const overlaySrc = safeReadFileSync(overlayPath, "utf8");
  let result;
  try {
    result = applyOverlay(globalSrc, overlaySrc);
  } catch (e) {
    process.stderr.write(`compose error: ${e.message}\n`);
    process.exit(1);
  }
  if (result.warnings.length > 0) {
    for (const w of result.warnings) process.stderr.write(`WARN: ${w}\n`);
  }
  if (args.check) {
    process.exit(result.warnings.length > 0 ? 1 : 0);
  }
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.composed);
  } else {
    process.stdout.write(result.composed);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
