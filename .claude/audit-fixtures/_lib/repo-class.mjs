#!/usr/bin/env node
/*
 * Shared repo-class gate for audit-fixture suites.
 *
 * PROVENANCE — INGESTED, NOT ORIGINATED HERE
 * ------------------------------------------
 * Authored at the kailash-rs BUILD repo and ingested into canon through
 * `/sync-from-build` Gate-1 classification (loom#1549). loom SPLITS and does
 * not originate: per `.claude/rules/artifact-flow.md` a BUILD repo raises the
 * proposal, loom classifies it global-vs-variant and redistributes. This file
 * is classified GLOBAL — a "does this suite have a job in a repo of THIS
 * class?" gate is multi-class by construction and is inert if only one class
 * holds it.
 *
 * The defect it repairs is loom's OWN. Gate-2 shipped loom-only fixture suites
 * into repos where their targets are — correctly — absent, so the suites
 * hard-crashed there; and because the same sync overwrites every file present
 * on both sides, each cycle also erased the target's local repair. Ingesting
 * the mechanism makes canon carry the fix instead of destroying it.
 *
 * The WHY THIS EXISTS paragraph below is kept VERBATIM from the origin repo.
 * Its numbers (21 suites, 20 unwired, 7 silently red) were measured in THEIR
 * tree, not this one; restating them as canon's own would be a claim no
 * measurement here supports.
 *
 * WHY THIS EXISTS
 * ---------------
 * The COC artifact corpus is authored at loom (`coc-source`) and distributed to
 * consumer repos. Some audit-fixture suites lock a guard that only EXISTS at
 * loom — their target script or manifest is a loom-only artifact. Distributed
 * into a `coc-build` repo, those suites used to hard-crash with ERR_MODULE_NOT_FOUND
 * or ENOENT. A crash is indistinguishable from a real regression, so the whole
 * corpus was left un-runnable and therefore un-wired: 20 of 21 suites had never
 * executed in CI, and seven were red without anyone knowing.
 *
 * THE GATE IS ON REPO CLASS, NOT ON FILE EXISTENCE — DELIBERATELY
 * ---------------------------------------------------------------
 * `if (!existsSync(target)) skip` is fail-OPEN by construction: the day the
 * target legitimately goes missing in a repo where it SHOULD exist, the suite
 * would skip instead of failing — the exact silent-pass class these fixtures
 * exist to prevent. So the gate asks "does this suite have a job in a repo of
 * THIS CLASS?" and nothing else. In a class where the suite applies, a missing
 * target still crashes loudly, as it must.
 *
 * FAIL-CLOSED IN EVERY DIRECTION
 * ------------------------------
 * An unreadable `.claude/VERSION`, absent `type`, or a `type` outside the known
 * set THROWS. It never degrades to "skip" — an unknown repo class must not be
 * able to silently switch off a security fixture. Per `zero-tolerance.md` Rule 3
 * (no silent fallbacks) and `evidence-first-claims.md` MUST-3 (a command that
 * could not run is zero evidence, never confirmation).
 *
 * CONTRACT
 * --------
 * Exit 78 == SKIP, and ONLY skip. The aggregator (`../run-all.mjs`) treats 78 as
 * a counted, reason-bearing skip; 0 as pass; anything else as failure. 78 is
 * chosen because it is outside the 0/1 range every suite here already uses, so a
 * suite cannot skip by accident.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exit code meaning "this suite does not apply to this repo class". */
export const SKIP_EXIT = 78;

/**
 * Repo classes defined by the COC artifact-flow model. Kept as an explicit
 * allowlist so an unrecognized value fails closed rather than matching nothing
 * and silently skipping every gated suite.
 * See `.claude/rules/issue-triage-routing.md` for what each class means.
 */
export const KNOWN_CLASSES = Object.freeze([
  "coc-source", // loom — authors and distributes the corpus
  "coc-build", // SDK source repo — consumes it
  "coc-use-template", // template repo — consumes and redistributes
  "coc-project", // downstream consumer — consumes only
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `.claude/audit-fixtures/_lib` -> repo root. */
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/**
 * Read `.claude/VERSION::type`. Throws — never returns a default — on any
 * condition that would leave the class unknown.
 * @param {string} [repoRoot]
 * @returns {string} one of KNOWN_CLASSES
 */
export function readRepoClass(repoRoot = REPO_ROOT) {
  const versionPath = path.join(repoRoot, ".claude", "VERSION");
  let raw;
  try {
    raw = readFileSync(versionPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot determine repo class: unable to read ${versionPath} (${err.code || err.message}). ` +
        `Refusing to guess — an unknown repo class must not silently skip a fixture suite.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `cannot determine repo class: ${versionPath} is not valid JSON (${err.message}).`,
    );
  }

  const type = parsed && parsed.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(
      `cannot determine repo class: ${versionPath} has no string "type" field.`,
    );
  }
  if (!KNOWN_CLASSES.includes(type)) {
    throw new Error(
      `unrecognized repo class "${type}" in ${versionPath}. ` +
        `Known: ${KNOWN_CLASSES.join(", ")}. Refusing to run or skip on an unknown class.`,
    );
  }
  return type;
}

/**
 * Gate a suite on repo class. Call at the very top of a run.mjs, BEFORE any
 * import or read of a class-specific target.
 *
 * If the current repo class is in `appliesTo`, returns the class and the suite
 * proceeds. Otherwise prints a machine-readable SKIP line and exits 78.
 *
 * @param {string[]} appliesTo repo classes in which this suite has a job
 * @param {string} reason WHY it does not apply elsewhere — printed, not optional
 * @returns {string} the current repo class
 */
export function requireRepoClass(appliesTo, reason) {
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) {
    throw new Error("requireRepoClass: appliesTo must be a non-empty array");
  }
  const unknown = appliesTo.filter((c) => !KNOWN_CLASSES.includes(c));
  if (unknown.length > 0) {
    throw new Error(
      `requireRepoClass: unknown class(es) in appliesTo: ${unknown.join(", ")}`,
    );
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    // A skip without a stated reason is the opaque-failure class this whole
    // mechanism exists to remove.
    throw new Error("requireRepoClass: a skip reason is mandatory");
  }

  const current = readRepoClass();
  if (appliesTo.includes(current)) return current;

  console.log(
    `SKIP: repo class "${current}" — this suite applies to ${appliesTo.join(", ")}. ${reason}`,
  );
  process.exit(SKIP_EXIT);
}
