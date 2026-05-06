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

import { applyOverlay } from "./lib/slot-parser.mjs";

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
    if (!resolved.startsWith(REPO + path.sep) && resolved !== REPO) {
      // Permit /tmp write targets for emission outputs, since --out is
      // legitimately ephemeral. Reads must stay in repo.
      if (flag === "--out" && (resolved.startsWith("/tmp/") || resolved.startsWith(path.join(process.env.TMPDIR || "/tmp", "")))) {
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

  const globalSrc = fs.readFileSync(globalPath, "utf8");
  const overlaySrc = fs.readFileSync(overlayPath, "utf8");
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
