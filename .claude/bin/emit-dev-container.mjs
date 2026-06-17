#!/usr/bin/env node
/**
 * ============================================================================
 *  emit-dev-container — loom-tracked dev-container source distributor (W6b-i)
 * ============================================================================
 *
 *  Reads the dev-container ownership model from
 *  `.claude/sync-manifest.yaml::multi_cli_overlays."multi-cli".dev_container_ownership`,
 *  resolves the per-variant DISTRIBUTION file set (the union of the declared
 *  publisher_internal + consumer_shipped classes and their <variant> overlays),
 *  reads each file from the loom-tracked source
 *  (`.claude/dev-container-templates/<variant>/`), substitutes the
 *  ecosystem-relative registry pointer (`{{REGISTRY_HOST}}`/`{{REGISTRY_ORG}}`
 *  → getRegistry().host/org) when the variant declares
 *  `registry_substitution: true`, and writes the result into the target USE
 *  template repo.
 *
 *  A variant ABSENT from `loom_distributed` is interim preserve-only (loom
 *  carries no copy, never emits) → exit 0 no-op. Per specs/04 §6 (Path-A,
 *  py-scoped): py is image-PULL with the canon-registry break; rs builds
 *  locally (no break) and stays preserve-only.
 *
 *  CLI:
 *    node .claude/bin/emit-dev-container.mjs --variant <v> --target <abs-path> [--dry-run]
 *
 *  FAIL-CLOSED (zero-tolerance Rule 3 — no silent fallback): if
 *  registry_substitution is true and getRegistry() returns null, OR a
 *  substituted output still contains a `{{REGISTRY_` token, the script throws a
 *  typed Error naming the file + missing field and writes NOTHING further. An
 *  unsubstituted placeholder is a broken image pointer and MUST NEVER ship.
 *
 *  External tools (yq) are invoked via execFileSync arg-array form only
 *  (security.md — never a composed shell string, never shell=true).
 *
 *  Node ESM, stdlib + ecosystem-config only.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getRegistry } from "./lib/ecosystem-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// bin/ → .claude/  (the manifest + dev-container-templates live under .claude/)
const CLAUDE_DIR = path.resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = path.join(CLAUDE_DIR, "sync-manifest.yaml");

const REGISTRY_HOST_TOKEN = "{{REGISTRY_HOST}}";
const REGISTRY_ORG_TOKEN = "{{REGISTRY_ORG}}";
// Any residual `{{REGISTRY_` after substitution is a broken pointer — fail closed.
const RESIDUAL_TOKEN_RE = /\{\{REGISTRY_/;

// The two ownership classes a `loom_distributed.<variant>.classes` entry may name.
// Each maps to a base array + a per-variant overlay array in the manifest.
const CLASS_BASE_KEY = {
  publisher_internal: "publisher_internal",
  consumer_shipped: "consumer_shipped",
};
const CLASS_VARIANT_KEY = {
  publisher_internal: "publisher_internal_variants",
  consumer_shipped: "consumer_shipped_variants",
};

// ────────────────────────────────────────────────────────────────
// Typed error — fail-closed substitution / config faults name the file + field.
// ────────────────────────────────────────────────────────────────
export class DevContainerEmitError extends Error {
  constructor(message) {
    super(message);
    this.name = "DevContainerEmitError";
  }
}

// ────────────────────────────────────────────────────────────────
// Manifest read (yq via execFileSync arg-array — never a shell string).
// Returns the parsed JS value, or null when the yq path resolves to null/absent.
// ────────────────────────────────────────────────────────────────
export function readManifestPath(yqPath, manifestPath = MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) {
    throw new DevContainerEmitError(
      `emit-dev-container: manifest not found at ${manifestPath}`,
    );
  }
  let out;
  try {
    out = execFileSync("yq", ["-o=json", yqPath, manifestPath], {
      encoding: "utf8",
    });
  } catch (e) {
    throw new DevContainerEmitError(
      `emit-dev-container: yq failed for path '${yqPath}' in ${manifestPath}: ${e.message}`,
    );
  }
  const trimmed = (out || "").trim();
  if (trimmed === "" || trimmed === "null") return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new DevContainerEmitError(
      `emit-dev-container: could not parse yq JSON for '${yqPath}': ${e.message}`,
    );
  }
}

/**
 * Read the dev_container_ownership block once (whole object), so the resolver
 * does one yq call and indexes in-process — deterministic config-branching,
 * NOT agent reasoning (agent-reasoning.md).
 */
export function readOwnership(manifestPath = MANIFEST_PATH) {
  const block = readManifestPath(
    '.multi_cli_overlays."multi-cli".dev_container_ownership',
    manifestPath,
  );
  if (!block || typeof block !== "object") {
    throw new DevContainerEmitError(
      `emit-dev-container: dev_container_ownership block missing or malformed in ${manifestPath}`,
    );
  }
  return block;
}

// ────────────────────────────────────────────────────────────────
// Resolver — the per-variant DISTRIBUTION file list.
//   union over loom_distributed.<variant>.classes of:
//     ownership[<class base key>]  +  ownership[<class variant key>].<variant>
// De-duplicated, order-preserved (base before variant overlay).
// Returns { distributed: bool, source, registry_substitution, classes, files }.
// distributed:false → variant absent from loom_distributed (preserve-only no-op).
// ────────────────────────────────────────────────────────────────
export function resolveFileList(variant, ownership) {
  const loomDistributed = ownership.loom_distributed || {};
  const decl = loomDistributed[variant];
  if (!decl) {
    return { distributed: false };
  }
  const source = decl.source;
  if (typeof source !== "string" || source.trim() === "") {
    throw new DevContainerEmitError(
      `emit-dev-container: loom_distributed.${variant}.source missing or empty`,
    );
  }
  const classes = Array.isArray(decl.classes) ? decl.classes : [];
  if (classes.length === 0) {
    throw new DevContainerEmitError(
      `emit-dev-container: loom_distributed.${variant}.classes missing or empty`,
    );
  }
  const registry_substitution = decl.registry_substitution === true;

  const seen = new Set();
  const files = [];
  const add = (relpath) => {
    if (typeof relpath !== "string" || relpath.trim() === "") return;
    if (seen.has(relpath)) return;
    seen.add(relpath);
    files.push(relpath);
  };

  for (const cls of classes) {
    const baseKey = CLASS_BASE_KEY[cls];
    const variantKey = CLASS_VARIANT_KEY[cls];
    if (!baseKey) {
      throw new DevContainerEmitError(
        `emit-dev-container: loom_distributed.${variant}.classes names unknown class '${cls}'`,
      );
    }
    const baseArr = ownership[baseKey];
    if (!Array.isArray(baseArr)) {
      throw new DevContainerEmitError(
        `emit-dev-container: dev_container_ownership.${baseKey} missing or not a list`,
      );
    }
    for (const f of baseArr) add(f);

    const variantBlock = ownership[variantKey] || {};
    const variantArr = variantBlock[variant];
    // A variant overlay MAY be absent or [] — that is a valid empty overlay.
    if (variantArr !== undefined && variantArr !== null) {
      if (!Array.isArray(variantArr)) {
        throw new DevContainerEmitError(
          `emit-dev-container: dev_container_ownership.${variantKey}.${variant} is not a list`,
        );
      }
      for (const f of variantArr) add(f);
    }
  }

  return { distributed: true, source, registry_substitution, classes, files };
}

// ────────────────────────────────────────────────────────────────
// Substitution — replace ALL registry tokens; fail closed on null registry or
// any residual `{{REGISTRY_` token. Returns { content, substitutions }.
//   registryFn: () => {host, org} | null  (injectable for tests)
// ────────────────────────────────────────────────────────────────
export function substituteRegistry(content, relpath, registryFn) {
  const reg = registryFn();
  if (!reg || typeof reg.host !== "string" || typeof reg.org !== "string") {
    const missing = !reg
      ? "registry (ecosystem.json absent or no registry key)"
      : `registry.${typeof reg.host !== "string" ? "host" : "org"}`;
    throw new DevContainerEmitError(
      `emit-dev-container: registry_substitution requested but getRegistry() did not yield {host,org} ` +
        `(missing: ${missing}) — refusing to write unsubstituted placeholders to ${relpath}`,
    );
  }
  let substitutions = 0;
  let out = content;
  // Count + replace HOST then ORG. split/join counts occurrences deterministically.
  const hostParts = out.split(REGISTRY_HOST_TOKEN);
  substitutions += hostParts.length - 1;
  out = hostParts.join(reg.host);
  const orgParts = out.split(REGISTRY_ORG_TOKEN);
  substitutions += orgParts.length - 1;
  out = orgParts.join(reg.org);

  if (RESIDUAL_TOKEN_RE.test(out)) {
    throw new DevContainerEmitError(
      `emit-dev-container: ${relpath} still contains a {{REGISTRY_ token after substitution — ` +
        `fail-closed (a broken image pointer MUST NOT ship)`,
    );
  }
  return { content: out, substitutions };
}

// ────────────────────────────────────────────────────────────────
// Emit — orchestrate read → (substitute) → write for one variant.
//   opts: { variant, target, dryRun, manifestPath, registryFn, claudeDir }
// Returns the JSON summary object (also printed by main()).
// ────────────────────────────────────────────────────────────────
export function emitDevContainer({
  variant,
  target,
  dryRun = false,
  manifestPath = MANIFEST_PATH,
  registryFn = getRegistry,
  claudeDir = CLAUDE_DIR,
}) {
  if (!variant) {
    throw new DevContainerEmitError("emit-dev-container: --variant is required");
  }
  if (!target) {
    throw new DevContainerEmitError("emit-dev-container: --target is required");
  }

  const ownership = readOwnership(manifestPath);
  const resolved = resolveFileList(variant, ownership);

  if (!resolved.distributed) {
    // Preserve-only (interim) — loom carries no copy, never emits.
    return {
      variant,
      distributed: false,
      written: [],
      substitutions: 0,
      dry_run: dryRun,
      message: `${variant}: preserve-only (interim), not distributed`,
    };
  }

  // Source root is manifest-relative to the .claude/ dir (e.g.
  // ".claude/dev-container-templates/py/"); resolve against the loom REPO root
  // (one level above .claude/) so the manifest-declared path is honored verbatim.
  const repoRoot = path.resolve(claudeDir, "..");
  const sourceRoot = path.resolve(repoRoot, resolved.source);

  let totalSubs = 0;
  const written = [];
  const lines = [];

  for (const relpath of resolved.files) {
    const srcPath = path.join(sourceRoot, relpath);
    if (!fs.existsSync(srcPath)) {
      throw new DevContainerEmitError(
        `emit-dev-container: source file missing: ${srcPath} (declared for variant '${variant}')`,
      );
    }
    let content = fs.readFileSync(srcPath, "utf8");
    let subs = 0;
    if (resolved.registry_substitution) {
      const r = substituteRegistry(content, relpath, registryFn);
      content = r.content;
      subs = r.substitutions;
    }
    totalSubs += subs;

    const destPath = path.join(target, relpath);
    if (dryRun) {
      lines.push(`${srcPath} -> ${destPath}  (${subs} substitution(s))`);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content);
      written.push(relpath);
    }
  }

  if (dryRun) {
    for (const l of lines) process.stdout.write(l + "\n");
  }

  return {
    variant,
    distributed: true,
    written: dryRun ? [] : written,
    substitutions: totalSubs,
    dry_run: dryRun,
  };
}

// ────────────────────────────────────────────────────────────────
// CLI arg parse (locked contract):
//   --variant <v>  --target <abs-path>  [--dry-run]
// ────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = { variant: null, target: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variant") {
      out.variant = argv[++i];
    } else if (a === "--target") {
      out.target = argv[++i];
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else {
      throw new DevContainerEmitError(
        `emit-dev-container: unknown argument '${a}'`,
      );
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.variant || !args.target) {
    process.stderr.write(
      "usage: node .claude/bin/emit-dev-container.mjs --variant <v> --target <abs-template-repo-path> [--dry-run]\n",
    );
    process.exit(2);
  }
  const summary = emitDevContainer({
    variant: args.variant,
    target: args.target,
    dryRun: args.dryRun,
  });
  if (summary.distributed === false && summary.message) {
    process.stdout.write(summary.message + "\n");
  }
  // Final JSON summary line (locked contract).
  const { message, distributed, ...rest } = summary;
  process.stdout.write(JSON.stringify(rest) + "\n");
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    if (e instanceof DevContainerEmitError) {
      process.stderr.write(e.message + "\n");
      process.exit(1);
    }
    throw e;
  }
}
