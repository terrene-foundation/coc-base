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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

import {
  isWithinRoot,
  isWithinTrustedTemp,
  realpathForContainment,
} from "./lib/path-containment.mjs";
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

// realpathForContainment / isWithinRoot moved to ./lib/path-containment.mjs
// (loom#1810) when sync-from-canon-objects.mjs became a second consumer of the
// same containment decision. A second copy would drift, and a drifted
// containment check is a silent hole. realpathOrSelf went with the env-derived
// temp allowlist it existed to build — see the --out carve-out below.

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
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
    let within;
    try {
      within = isWithinRoot(canonical, REPO);
    } catch (e) {
      // isWithinRoot canonicalises the BOUNDARY ROOT through the SAME resolver,
      // so it throws for an unresolvable ROOT (EACCES on an ancestor, ELOOP, the
      // root unlinked mid-run) exactly as the block above throws for the
      // candidate. It needs its OWN catch: left bare, a root that will not
      // resolve escaped as an uncaught throw and exited 1 — which this file's
      // header defines as "composition failure (slot not in global, etc.)", so a
      // caller could not tell "the guard DID NOT RUN" from a content failure.
      // Fail-closed either way (nothing is written); this makes the SIGNAL
      // honest. The wording keeps the `path could not be resolved` refusal
      // phrase that compose.test.mjs::GUARD_REFUSAL pins, because a root that
      // will not canonicalise IS a guard refusal, not a composition failure.
      process.stderr.write(
        `error: repo root path could not be resolved (${e.code ?? e.message}): ${REPO}\n`,
      );
      process.exit(2);
    }
    if (!within) {
      // Permit ephemeral temp-dir write targets for emission outputs, since
      // --out is legitimately ephemeral. Reads must stay in repo.
      //
      // The temp roots come from lib/path-containment.mjs and are STATIC
      // system temp roots — the environment contributes NOTHING to them
      // (loom#1810). The former list was
      // `[os.tmpdir(), process.env.TMPDIR, "/tmp", "/var/folders"]`, and since
      // the environment is attacker-controlled anywhere argv is, `TMPDIR=/Users`
      // made every file under /Users a legal write target: measured exit 0 with
      // a victim outside both repo and temp overwritten, where the identical
      // command under a clean TMPDIR exited 2. Dropping `process.env.TMPDIR`
      // alone would not have closed it — os.tmpdir() reads $TMPDIR itself.
      //
      // The comparison uses the SAME canonical form as the repo-root decision.
      // The former `realpathOrSelf(path.dirname(resolved))` resolved only the
      // parent and fell back to the LEXICAL path whenever that parent did not
      // exist yet, so a legitimate `--out <tmp>/sub/new.md` compared a lexical
      // `/tmp/…` against a realpath'd `/private/tmp` root and was refused.
      // realpathForContainment resolves every EXISTING component and re-appends
      // only the not-yet-created remainder, which fixes that and additionally
      // rejects a symlinked FINAL component whose target escapes temp.
      //
      // Residual (bounded-trust, F53-class — see
      // skills/30-claude-code-patterns/multi-operator-coordination-substrate.md § Origin F53): a symlink planted between
      // this check and fs.writeFileSync (no O_NOFOLLOW) is still followed —
      // that is check-to-use TOCTOU, not a lexical bypass or an env widening,
      // and closing it needs enforcement AT the sink.
      if (flag === "--out" && isWithinTrustedTemp(canonical)) {
        return resolved;
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

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
// Under --preserve-symlinks-main both sides stay lexical and still realpath equal,
// so the polarity pinned by compose.test.mjs still reaches main().
if (isMainModule(import.meta.url)) {
  main();
}
