#!/usr/bin/env node
/*
 * ============================================================================
 *  deploy-config — ecosystem-relative deploy-target resolver (ECO-IMPL W6b-ii / C3)
 * ============================================================================
 *
 *  Design: workspaces/ecosystem-operating-model/specs/07-deploy.md (§2/§2.1/§3).
 *  Deploy-side sibling of the dev-container registry break (specs/04): the SAME
 *  ecosystem-relative-parameter class (specs/03 §3) applied to deploy TARGETING
 *  instead of the image pointer.
 *
 *  WHAT IT DOES (§3 — the override layer consumed by /deploy Step-0, see §4 / C4):
 *    resolveDeployTarget({ projectKey, projectConfig }) composes the effective
 *    deploy target from two layers, last-wins per key:
 *      1. ecosystem layer  (ecosystem.json::deploy, via getDeploy()) — WHERE the
 *         deploy targets: registry org, infra endpoint, provider, env names.
 *      2. project layer    (the caller's deployment-config.md values)    — HOW the
 *         project deploys: platform, deploy command, paths. The project layer MAY
 *         reference an ecosystem field via a `${ecosystem.deploy.<path>}` token.
 *
 *    Composition (§2):  default_targets(obj) ⊕ per_project[projectKey] ⊕ projectConfig
 *    Interpolation (§2.1): every `${ecosystem.deploy.<path>}` token in a project value
 *      is resolved against the whole `deploy` object (dot + [index] path navigation).
 *      `<path>` examples: `registry_org`, `default_targets[0].env`,
 *      `per_project.build_py.provider`.
 *
 *  THE TWO LOAD-BEARING, CODE-ENFORCED INVARIANTS (§6):
 *    (i)  getDeploy() === null  ⟹  projectConfig is returned UNCHANGED (today's
 *         behavior). Ecosystem-awareness is ADDITIVE — a repo with no
 *         ecosystem.json::deploy deploys exactly as it does now, NO error.
 *    (ii) every `${ecosystem.deploy.*}` token resolves OR fails CLOSED with a typed
 *         DeployConfigError naming the missing field — NEVER a silent
 *         canon-hardcoded fallback (zero-tolerance.md Rule 3; the specs/04 §4
 *         "MUST NOT distribute canon-hardcoded into client ecosystems" invariant
 *         applied to deploy).
 *
 *  DISCLOSURE DISCIPLINE (inherited from ecosystem-config.mjs):
 *  THIS resolver is a SYNCED artifact (`bin/**` is a sync tier) and ships to 30+
 *  downstream consumers + the public fork. It embeds ZERO real registry/org/infra
 *  values: it reads them ONLY through getDeploy(), which reads the loom-only
 *  `.claude/bin/ecosystem.json` — committed-but-ecosystem-private, fenced THREE ways
 *  (NOT gitignored): never-synced (`sync-manifest.yaml loom_only:` + the
 *  `validate-emit.mjs` LOOM_ONLY_TIER_CARVEOUTS), never-published
 *  (`publish-to-public.mjs` EXCLUDE_WITHIN + KILL_BASENAMES), and never-scanned-as-content
 *  (`scan-synced-disclosure.mjs` self-exclude at source / flagged at a consumer `--root`).
 *  Each ecosystem carries its OWN ecosystem.json; neither is ever synced canon↔client — so
 *  no ecosystem's deploy identity is carried into another's surface (§6 invariant v).
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDeploy as _getDeploy } from "./lib/ecosystem-config.mjs";

// ────────────────────────────────────────────────────────────────
// Typed error (mirrors ecosystem-config's EcosystemConfigError).
//   unresolvable-token : a ${ecosystem.deploy.<path>} token whose <path> does not
//                        resolve against the ecosystem deploy object (invariant ii).
//   config-error       : structurally invalid input (non-object projectConfig).
// ────────────────────────────────────────────────────────────────
export class DeployConfigError extends Error {
  constructor(subtype, message) {
    super(message);
    this.name = "DeployConfigError";
    this.subtype = subtype;
  }
}

const TOKEN_RE = /\$\{ecosystem\.deploy\.([^}]+)\}/g;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Navigate a dotted + bracket-indexed path within `root`.
 *   "registry_org"            → root.registry_org
 *   "default_targets[0].env"  → root.default_targets[0].env
 *   "per_project.build_py.x"  → root.per_project.build_py.x
 * Returns { found: boolean, value }. A missing segment → { found: false }.
 * Distinguishes a genuinely-present `null`/`undefined` leaf (found:true) from an
 * absent path (found:false) so invariant (ii) fails closed only on absence.
 */
function navigatePath(root, dottedPath) {
  // Split "a.b[0].c" into ["a","b","0","c"].
  const segments = [];
  for (const part of dottedPath.split(".")) {
    const m = part.matchAll(/([^[\]]+)|\[(\d+)\]/g);
    for (const g of m) {
      if (g[1] !== undefined) segments.push(g[1]);
      else if (g[2] !== undefined) segments.push(g[2]);
    }
  }
  let cur = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return { found: false };
    // hasOwnProperty (NOT the `in` operator) so inherited / prototype-chain keys —
    // __proto__, constructor, prototype, toString, etc. — resolve to NOT-FOUND and
    // therefore fail CLOSED per invariant (ii), never to a prototype-chain value.
    // Array indices ("0", "1", …) ARE own properties, so they still resolve.
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

/**
 * Resolve every `${ecosystem.deploy.<path>}` token in a string against the
 * ecosystem `deploy` object. An unresolvable path throws DeployConfigError
 * naming the field (invariant ii). A resolved leaf that is not a string is
 * JSON-stringified when embedded in a larger string; a whole-value token
 * ("${ecosystem.deploy.x}" alone) returns the raw resolved value (preserving
 * objects/arrays/numbers for descriptor fields).
 */
function interpolateString(value, deploy, fieldName) {
  const whole = value.match(/^\$\{ecosystem\.deploy\.([^}]+)\}$/);
  if (whole) {
    const r = navigatePath(deploy, whole[1]);
    if (!r.found) {
      throw new DeployConfigError(
        "unresolvable-token",
        `deploy-config: unresolvable token \${ecosystem.deploy.${whole[1]}} ` +
          `in field "${fieldName}" — no such field in ecosystem.json::deploy ` +
          `(fail-closed; never a canon-hardcoded fallback).`,
      );
    }
    return r.value;
  }
  return value.replace(TOKEN_RE, (_match, p) => {
    const r = navigatePath(deploy, p);
    if (!r.found) {
      throw new DeployConfigError(
        "unresolvable-token",
        `deploy-config: unresolvable token \${ecosystem.deploy.${p}} ` +
          `in field "${fieldName}" — no such field in ecosystem.json::deploy ` +
          `(fail-closed; never a canon-hardcoded fallback).`,
      );
    }
    return typeof r.value === "string" ? r.value : JSON.stringify(r.value);
  });
}

/** Recursively interpolate tokens in every string leaf of an object/array. */
function interpolateDeep(node, deploy, fieldPath) {
  if (typeof node === "string") return interpolateString(node, deploy, fieldPath);
  if (Array.isArray(node)) {
    return node.map((v, i) => interpolateDeep(v, deploy, `${fieldPath}[${i}]`));
  }
  if (isPlainObject(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = interpolateDeep(v, deploy, fieldPath ? `${fieldPath}.${k}` : k);
    }
    return out;
  }
  return node; // number / bool / null pass through
}

/**
 * Resolve the effective deploy target (§3).
 *
 * @param {object}  args
 * @param {string}  args.projectKey     the project's resolver logical key (per_project lookup key)
 * @param {object}  args.projectConfig  the project's deployment-config.md deploy values (HOW layer)
 * @param {object}  [opts]
 * @param {Function}[opts.deployFn]     injectable getDeploy() for tests; defaults to the real accessor
 * @returns {object} the resolved deploy descriptor (effective target)
 * @throws  {DeployConfigError} on a non-object projectConfig or an unresolvable token
 */
export function resolveDeployTarget({ projectKey, projectConfig } = {}, opts = {}) {
  if (!isPlainObject(projectConfig)) {
    throw new DeployConfigError(
      "config-error",
      `deploy-config: projectConfig must be a plain object (got ${
        Array.isArray(projectConfig) ? "array" : typeof projectConfig
      }).`,
    );
  }
  const deployFn = opts.deployFn || _getDeploy;
  const deploy = deployFn();

  // Invariant (i): no ecosystem deploy config → project config UNCHANGED.
  if (deploy == null) return { ...projectConfig };

  // Invariant (ii): resolve every ${ecosystem.deploy.*} token, fail-closed.
  const resolvedProject = interpolateDeep(projectConfig, deploy, "");

  // §2 layered merge, last-wins per key:
  //   default_targets(object form) ⊕ per_project[projectKey] ⊕ resolvedProject.
  //   default_targets in LIST form is the ecosystem default surface tokens index
  //   into (§2.1 `default_targets[0].env`); it is not flat-merged (a list ⊕ object
  //   is undefined) — only its object form participates in the flat merge.
  const ecoDefault = isPlainObject(deploy.default_targets)
    ? deploy.default_targets
    : {};
  const perProject =
    (isPlainObject(deploy.per_project) &&
      projectKey != null &&
      isPlainObject(deploy.per_project[projectKey]) &&
      deploy.per_project[projectKey]) ||
    {};

  return { ...ecoDefault, ...perProject, ...resolvedProject };
}

// ────────────────────────────────────────────────────────────────
// CLI entry — `/deploy` Step-0 (§4 / C4) invokes this to resolve + print the
// effective deploy descriptor as JSON. Reads projectConfig from a JSON file
// (--config <path>) or stdin; --key <projectKey> sets the per_project lookup.
// Exit 0 + descriptor JSON on success; exit 1 + the typed error on fail-closed.
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { key: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") out.key = argv[++i];
    else if (argv[i] === "--config") out.config = argv[++i];
  }
  return out;
}

async function main(argv) {
  const fs = await import("node:fs");
  const { key, config } = parseArgs(argv);
  let raw;
  if (config) {
    raw = fs.readFileSync(config, "utf8");
  } else {
    raw = fs.readFileSync(0, "utf8"); // stdin
  }
  let projectConfig;
  try {
    projectConfig = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`deploy-config: invalid project-config JSON: ${e.message}\n`);
    process.exit(1);
  }
  try {
    const descriptor = resolveDeployTarget({ projectKey: key, projectConfig });
    process.stdout.write(JSON.stringify(descriptor, null, 2) + "\n");
    process.exit(0);
  } catch (e) {
    if (e instanceof DeployConfigError) {
      process.stderr.write(e.message + "\n");
      process.exit(1);
    }
    throw e;
  }
}

const _isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isMain) {
  main(process.argv.slice(2));
}

export const _internals = { navigatePath, interpolateString, interpolateDeep };
