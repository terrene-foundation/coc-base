#!/usr/bin/env node
/*
 * repo-class.mjs — resolve THIS repo's CO/COC class from its DECLARATION.
 *
 * loom#1502. `/codify` Step 7 routes a proposal by repo class. It used to do so
 * with a four-row precedence that matched hardcoded repo NAMES (`kailash-coc-*`
 * in the git remote, `kailash-py`/`kailash-rs`/`kailash-prism`, a `pyproject.toml`
 * name of exactly `kailash`). Two defects followed:
 *
 *   1. A CLIENT-FORK BUILD repo matched NO row. A fork's BUILD repo is not named
 *      `kailash-*`, and the BUILD row had no `.claude/VERSION::type` arm at all
 *      (`coc-build` appeared ZERO times in codify.md). The multi-ecosystem model
 *      — where a client copies the whole loom ↔ build ↔ use ecosystem and renames
 *      it — was structurally unroutable.
 *   2. It was a SECOND class-detection surface. `lib/manifest-source.mjs`
 *      (loom#1386) already owns class semantics for the entire emit engine. Two
 *      independent detectors for one property is exactly the
 *      `security.md` § Enforcement-Surface Parity defect: they drift, and the one
 *      nobody updated is the one that decides.
 *
 * So this tool RESOLVES NOTHING ITSELF. It is a thin CLI over the existing
 * authority, `manifest-source.mjs::readRepoClass`, which reads the declaration at
 * `.claude/VERSION::type`, validates it against a positive allowlist of the four
 * known classes, and fails closed on every unresolvable shape. NO repo name
 * appears anywhere in this file's predicate — by construction, because the
 * predicate is not here.
 *
 * THE BOOTSTRAP HEURISTIC INFORMS THE REMEDY; IT NEVER ROUTES.
 *
 * `version-utils.js::detectRepoType` guesses a class from DIRECTORY STRUCTURE
 * (`pyproject.toml`/`Cargo.toml` + `packages/`/`src/`). Its own docstring says it
 * is "for bootstrap", and it can only ever return two of the four classes — it
 * cannot express `coc-source` or `coc-use-template` at all. Routing a proposal on
 * it would send a USE-template's artifact fix down the SDK-code lane.
 *
 * When the declaration is genuinely ABSENT (never written) this tool therefore
 * exits 3 — NOT 0 — and offers the structural guess only as the suggested VALUE
 * for the operator to write into `.claude/VERSION`. The caller halts and names
 * that self-service fix, mirroring the shape Step 7c already uses for a missing
 * `upstream.template`. An inference is reported AS an inference
 * (`evidence-first-claims.md` MUST-4), never asserted as the answer, and never
 * silently consumed as a default.
 *
 * A declaration that is present but WRONG (invalid JSON, an unrecognized `type`)
 * or a VERSION that will not open for a reason other than "not there"
 * (EACCES/EISDIR/ELOOP) is NOT bootstrappable: it exits 1 with no guess offered.
 * Those are corruption or tamper signals — ELOOP in particular is the
 * symlink-swap tripwire (#569) — and inferring past them would convert a
 * tripwire into a shrug.
 *
 * Usage:
 *   node .claude/bin/repo-class.mjs            # prints the class, e.g. `coc-build`
 *   node .claude/bin/repo-class.mjs --json     # machine-readable, incl. routing
 *   node .claude/bin/repo-class.mjs --root <d> # resolve a different repo root
 *
 * Exit codes (compose.mjs convention):
 *   0  class resolved FROM THE DECLARATION — safe to route on.
 *   1  unresolvable and NOT bootstrappable (corrupt / unknown / unreadable).
 *      No guess is offered. Repair `.claude/VERSION`.
 *   2  usage error.
 *   3  no declaration yet (genuine bootstrap). A structural guess is offered as
 *      the value to WRITE, not as a routing answer. Caller MUST halt.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  readRepoClass,
  KNOWN_REPO_CLASSES,
  BOOTSTRAP_ELIGIBLE_REASONS,
} from "./lib/manifest-source.mjs";

// bin/ is ONE level below .claude/, which is one below the repo root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..");

// `/codify` Step 7's routing table, keyed by CLASS — the whole point of the
// change. Every one of the four known classes has a destination; a class with no
// row here would be the original defect (the BUILD lane) reintroduced, which the
// completeness assertion in the test suite pins.
const CODIFY_ROUTE = Object.freeze({
  "coc-source": {
    step: "8",
    summary:
      "loom — the splitter. Splits, never originates: continue to Step 8 (loom→atelier, CC/CO tier).",
  },
  "coc-use-template": {
    step: "7b",
    summary:
      "USE template — the origination node: proposal to loom via /sync-from-use Gate-1.",
  },
  "coc-build": {
    step: "7a",
    summary:
      "BUILD repo — SDK code: cross-SDK-FIRST, then proposal to loom via /sync-from-build Gate-1.",
  },
  "coc-project": {
    step: "7c",
    summary:
      "Downstream consumer — upflow to the USE template it pulled from (never to its own repo, never to loom).",
  },
});

// Lazily loaded so the structural heuristic is reachable ONLY on the bootstrap
// path. version-utils.js is CommonJS; this file is ESM.
function structuralGuess(root) {
  try {
    const require = createRequire(import.meta.url);
    const { detectRepoType } = require("../hooks/lib/version-utils.js");
    return detectRepoType(root);
  } catch {
    // The heuristic is a courtesy on an already-failing path. If it is
    // unavailable the remedy is still actionable without a suggested value.
    return null;
  }
}

function parseArgs(argv) {
  const args = { json: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else return { error: `unknown argument "${a}"` };
  }
  return args;
}

const USAGE =
  "usage: repo-class.mjs [--json] [--root <dir>]\n" +
  "  Resolves this repo's class from .claude/VERSION::type.\n" +
  "  exit 0 = resolved; 1 = unresolvable (repair VERSION); 2 = usage; 3 = undeclared (bootstrap).\n";

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`repo-class: ${args.error}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : DEFAULT_ROOT;
  const { type, error, reason } = readRepoClass(root);

  if (type) {
    const route = CODIFY_ROUTE[type];
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            class: type,
            source: "declaration",
            inferred: false,
            codify_step: route.step,
            routing: route.summary,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(`${type}\n`);
    }
    return 0;
  }

  const bootstrappable = BOOTSTRAP_ELIGIBLE_REASONS.includes(reason);
  if (!bootstrappable) {
    // Corrupt / unknown / unreadable. No guess — repair is the only answer.
    process.stderr.write(
      `repo-class: UNRESOLVED (${reason}) — ${error}.\n` +
        `  FIX: set \`type\` in .claude/VERSION to one of: ` +
        `${KNOWN_REPO_CLASSES.join(", ")}, then re-run.\n` +
        `  No class is inferred for this failure: the declaration is present but ` +
        `unusable, or VERSION did not open. Guessing would route work to the wrong lane.\n`,
    );
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          { class: null, source: null, inferred: false, reason, error },
          null,
          2,
        ) + "\n",
      );
    }
    return 1;
  }

  // Genuine bootstrap: no declaration has ever been written.
  const guess = structuralGuess(root);
  process.stderr.write(
    `repo-class: UNDECLARED (${reason}) — ${error}.\n` +
      `  FIX: add \`"type": "<class>"\` to .claude/VERSION, then re-run. ` +
      `Valid classes: ${KNOWN_REPO_CLASSES.join(", ")}.\n` +
      (guess
        ? `  SUGGESTED VALUE (structural INFERENCE from directory layout, NOT a ` +
          `routing answer): "${guess}". This heuristic can only ever return ` +
          `coc-build or coc-project — if this repo is loom or a USE template it is ` +
          `WRONG. Confirm before writing it.\n`
        : ``) +
      `  Routing is BLOCKED until the class is declared.\n`,
  );
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          class: null,
          source: null,
          inferred: false,
          reason,
          error,
          suggested_value: guess,
          suggested_value_is_inference: true,
        },
        null,
        2,
      ) + "\n",
    );
  }
  return 3;
}

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedAsScript) {
  process.exit(main());
}
