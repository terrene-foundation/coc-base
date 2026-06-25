/*
 * ============================================================================
 *  loom-links — shared linked-repo resolver (Phase-2, Shard 1)
 * ============================================================================
 *
 *  loom coordinates across sibling repos (BUILD repos, USE templates, the
 *  loom self-checkout, atelier, downstream consumers). Historically every
 *  tool resolved a linked repo POSITIONALLY: `path.join(HOME, "repos",
 *  <name>)`. That positional assumption is the bug being removed — it
 *  breaks the moment an operator lays repos out differently, and it
 *  re-creates the issue #255 / #252 disclosure class whenever a registry
 *  is embedded inline in a synced artifact.
 *
 *  #255 already solved this for ONE tool (repin-downstream.mjs) with a
 *  gitignored operator-local config + committed schema template. This
 *  module is the GENERAL form of that exact pattern: a single shared
 *  resolver every linkage-aware tool reads from.
 *
 *    config (gitignored):  .claude/bin/loom-links.local.json
 *    schema  (committed):  .claude/bin/loom-links.local.example.json
 *    override (abs path):  $LOOM_LINKS_CONFIG
 *
 *  Canonical sublayout hint (F61, 2026-05-28): the recommended on-disk
 *  realization of the logical key namespace is `~/repos/kailash/{build,use}/<slug>`
 *  (e.g. ~/repos/kailash/build/py for build.py, ~/repos/kailash/use/py for
 *  use-template.py). This is a HINT for fresh operators — the resolver is
 *  layout-agnostic and existing layouts (flat ~/repos/<slug>, nested
 *  ~/repos/loom/<slug>) remain fully supported. See cross-repo.md
 *  § "Canonical Sublayout (Recommended — F61)" and the example schema's
 *  _README "CANONICAL SUBLAYOUT" section.
 *
 *  Disclosure discipline (issue #263): THIS FILE IS A SYNCED ARTIFACT
 *  (`bin/**` is a sync tier). It ships ONLY the loader + schema shape —
 *  ZERO embedded paths, org slugs, hostnames, or operator identifiers.
 *  The committed `.example.json` carries SYNTHETIC `example-*` /
 *  `example.com` tokens only (scanner-allowlisted). The real registry
 *  lives exclusively in the gitignored `.local.json`.
 *
 *  Resolution precedence (NO silent positional fallback — ever):
 *    1. $LOOM_LINKS_CONFIG  (absolute path)   — highest
 *    2. .claude/bin/loom-links.local.json     — operator-local
 *    3. throw LinkError("not-configured")     — fail loud, mirrors repin
 *
 *  This module NEVER prints or logs a resolved absolute path. Resolved
 *  values are RETURNED to the caller; callers render basename / relative
 *  per the existing loom convention.
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The WHICH layer (ecosystem-shared remote registry). loom-links owns WHERE;
// ecosystem-config owns WHICH. getRemoteLink returns null when no ecosystem.json
// is present (back-compat: resolution then collapses to today's path-only shape).
import { getRemoteLink, getRepoProvider } from "./ecosystem-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ → bin/  (config + schema live in bin/, one level up)
const BIN_DIR = path.resolve(SCRIPT_DIR, "..");
const LOCAL_CONFIG_PATH = path.join(BIN_DIR, "loom-links.local.json");
const EXAMPLE_PATH = path.join(BIN_DIR, "loom-links.local.example.json");
// lib/ → bin/ → .claude/ → repo-root. The `.coc-role` fallback marker (D2)
// lives at the repo root (open-decision #4 = repo-root-relative) so a
// resolver-absent USE-CONSUMER — which has NO .claude/bin/ config — can still
// declare its role.
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

// The closed ROLE vocabulary (D2). Lowercase, no synonyms, no fourth role. A
// value outside this set is a loud config-error, never a silent guess. This is
// the ONE membership-validated scalar in this module (everything else is
// shape-validated) because the role vocabulary IS closed.
export const VALID_ROLES = new Set(["platform", "build", "use-consumer"]);

// ────────────────────────────────────────────────────────────────
// Typed error
// ────────────────────────────────────────────────────────────────
//
// Subtypes:
//   not-configured : no config present on any precedence tier. Carries
//                     the fail-loud `cp <.example> <.local>` message,
//                     mirroring repin-downstream.mjs::loadShards().
//   unknown-key    : config present, but the requested logical key is
//                     not declared in `links`.
//   ambiguous      : a links entry sets BOTH `path` and `url`.
//   config-error   : config present but unparseable / malformed shape.
//
export class LinkError extends Error {
  constructor(subtype, message) {
    super(message);
    this.name = "LinkError";
    this.subtype = subtype;
  }
}

// ────────────────────────────────────────────────────────────────
// Path helpers (repin-compatible — same expandHome + reposRoot join)
// ────────────────────────────────────────────────────────────────
function expandHome(p) {
  const home = process.env.HOME || os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function rel(p) {
  try {
    return path.relative(process.cwd(), p) || p;
  } catch {
    return p;
  }
}

function notConfiguredMessage() {
  return (
    `loom-links: linkage config not found.\n\n` +
    `loom no longer resolves linked repos positionally\n` +
    `(it embedded a repo registry inline in a synced file —\n` +
    `issue #255 / #252 disclosure class).\n\n` +
    `To use it, copy the committed template and fill in your paths:\n` +
    `  cp ${rel(EXAMPLE_PATH)} ${rel(LOCAL_CONFIG_PATH)}\n` +
    `  $EDITOR ${rel(LOCAL_CONFIG_PATH)}\n\n` +
    `Or point $LOOM_LINKS_CONFIG at an absolute config path.\n\n` +
    `The local file is gitignored and is never committed or synced.`
  );
}

// ────────────────────────────────────────────────────────────────
// Config resolution — precedence: $LOOM_LINKS_CONFIG > local > throw
// ────────────────────────────────────────────────────────────────
//
// ABSOLUTELY NO silent fallback to path.join(HOME,"repos",key). The
// positional fallback IS the bug this module removes; re-introducing
// it here would re-create it. Absence → typed LinkError, never a guess.
//
function resolveConfigPath() {
  const env = process.env.LOOM_LINKS_CONFIG;
  if (env && env.trim() !== "") {
    if (!path.isAbsolute(env)) {
      throw new LinkError(
        "config-error",
        `$LOOM_LINKS_CONFIG must be an absolute path (got: ${rel(env)})`,
      );
    }
    if (!fs.existsSync(env)) {
      throw new LinkError(
        "not-configured",
        `$LOOM_LINKS_CONFIG points at a missing file.\n\n` +
          notConfiguredMessage(),
      );
    }
    return env;
  }
  if (fs.existsSync(LOCAL_CONFIG_PATH)) return LOCAL_CONFIG_PATH;
  throw new LinkError("not-configured", notConfiguredMessage());
}

let _cache = null; // { configPath, reposRoot, links, shards, role }

function loadConfig() {
  const configPath = resolveConfigPath();
  if (_cache && _cache.configPath === configPath) return _cache;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new LinkError(
      "config-error",
      `loom-links: config parse error in ${rel(configPath)}: ${e.message}`,
    );
  }
  if (!cfg || typeof cfg !== "object") {
    throw new LinkError(
      "config-error",
      `loom-links: config ${rel(configPath)} is not a JSON object`,
    );
  }

  const reposRoot = expandHome(
    cfg.reposRoot || path.join(process.env.HOME || os.homedir(), "repos"),
  );

  // `links` is REQUIRED for repo resolution. Shape-validate, not
  // membership-validate: arbitrary `downstream.*` keys + forward-compat
  // `_`-prefixed keys are accepted. An unknown key is NOT a config
  // error — it surfaces as LinkError("unknown-key") at resolve time.
  const links =
    cfg.links && typeof cfg.links === "object" && !Array.isArray(cfg.links)
      ? cfg.links
      : {};
  // `shards` is OPTIONAL (repin-compat block); only required by
  // resolveShard(). Validated lazily there.
  const shards =
    cfg.shards && typeof cfg.shards === "object" && !Array.isArray(cfg.shards)
      ? cfg.shards
      : null;

  // `role` is OPTIONAL (D2 — the ROLE-axis declaration: which role THIS clone
  // is). Absent → null (back-compat: a pre-role config behaves byte-identically;
  // the accessor decides). Present-but-out-of-enum → loud LinkError, matching
  // the resolver's typed-error discipline.
  const role = validateRole(cfg.role, rel(configPath));

  _cache = { configPath, reposRoot, links, shards, role };
  return _cache;
}

/** Test/CLI hook — drop the memoized config so a changed env/file is re-read. */
export function _resetCache() {
  _cache = null;
}

// ────────────────────────────────────────────────────────────────
// ROLE axis (D2) — which role THIS clone is
// ────────────────────────────────────────────────────────────────
//
// Precedence (NO silent guess): resolver `role:` (PRIMARY) → `.coc-role`
// repo-root marker (FALLBACK, resolver-absent consumer) → null (doctor-inferred
// is a Wave-3 ratified action, NOT here). See resolveRole() below.

// Validate an OPTIONAL role scalar against the closed VALID_ROLES enum. Absent
// (undefined / null) → null (back-compat). Present-but-invalid (wrong type or
// out-of-enum, including "") → LinkError("config-error"), consistent with the
// resolver's fail-loud discipline. `where` names the source for the message.
function validateRole(role, where) {
  if (role === undefined || role === null) return null;
  if (typeof role !== "string" || !VALID_ROLES.has(role)) {
    throw new LinkError(
      "config-error",
      `loom-links: invalid role ${JSON.stringify(role)} in ${where} — ` +
        `must be one of {${[...VALID_ROLES].join(", ")}}`,
    );
  }
  return role;
}

// The `.coc-role` fallback-marker path: $LOOM_COC_ROLE_MARKER (absolute
// override — for tests + operators) → repo-root `.coc-role`. Computed at call
// time so a test-set env var is honored. The absolute-path requirement mirrors
// $LOOM_LINKS_CONFIG (resolveConfigPath): a relative override would resolve
// against an arbitrary CWD (a footgun in a synced artifact), so it fails loud.
function cocRoleMarkerPath() {
  const env = process.env.LOOM_COC_ROLE_MARKER;
  if (env && env.trim() !== "") {
    if (!path.isAbsolute(env)) {
      throw new LinkError(
        "config-error",
        `$LOOM_COC_ROLE_MARKER must be an absolute path (got: ${rel(env)})`,
      );
    }
    return env;
  }
  return path.join(REPO_ROOT, ".coc-role");
}

// Read the repo-root `.coc-role` fallback marker (D2, open-decision #4). A
// USE-CONSUMER legitimately has NO resolver config, so this marker is the role
// anchor when loadConfig throws not-configured. Mirrors the ecosystem-config
// absent-is-not-error contract: absent / empty → null (fall through), malformed
// (out-of-enum token) → loud LinkError("config-error").
function readCocRoleMarker() {
  const markerPath = cocRoleMarkerPath();
  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return null; // absent → fall through (back-compat)
  }
  const token = raw.trim();
  if (token === "") return null; // empty marker → treat as absent
  return validateRole(token, rel(markerPath));
}

// ────────────────────────────────────────────────────────────────
// Entry normalization
// ────────────────────────────────────────────────────────────────
//
// A links entry is EITHER:
//   - a string: a path relative to reposRoot (repin-compatible), OR
//   - an object: { path?, url?, absolute? }
//       path     : relative to reposRoot (unless absolute:true)
//       absolute : when true, `path` is used verbatim (still expandHome'd)
//       url      : a git URL, used verbatim
//   Both path AND url set → LinkError("ambiguous").
//
function normalizeEntry(key, entry, reposRoot) {
  if (typeof entry === "string") {
    const abs = path.join(reposRoot, expandHome(entry));
    return { kind: "path", value: abs, key };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const hasPath =
      typeof entry.path === "string" && entry.path.trim() !== "";
    const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
    if (hasPath && hasUrl) {
      throw new LinkError(
        "ambiguous",
        `loom-links: key '${key}' sets BOTH path and url — exactly one is allowed`,
      );
    }
    if (hasUrl) {
      return { kind: "url", value: entry.url, key };
    }
    if (hasPath) {
      const expanded = expandHome(entry.path);
      const abs = entry.absolute
        ? expanded
        : path.isAbsolute(expanded)
          ? expanded
          : path.join(reposRoot, expanded);
      return { kind: "path", value: abs, key };
    }
    throw new LinkError(
      "config-error",
      `loom-links: key '${key}' object entry must set 'path' or 'url'`,
    );
  }
  throw new LinkError(
    "config-error",
    `loom-links: key '${key}' must be a string or { path? , url? } object`,
  );
}

// ────────────────────────────────────────────────────────────────
// WHICH-layer join (D6) — local owns WHERE, remote owns WHICH
// ────────────────────────────────────────────────────────────────
//
// deriveDefaultPath maps a remote-only logical key to its SUGGESTED checkout
// path under the operator's reposRoot, using the canonical sublayout HINT
// (cross-repo.md § Canonical Sublayout). This is a DECLARED-binding-derived
// default — the key's remote binding IS declared in ecosystem.json — NOT the
// positional guess cross-repo.md MUST-1 blocks (an UNDECLARED key still throws
// unknown-key below; nothing here invents a binding).
//
function deriveDefaultPath(key, remote, reposRoot) {
  let relUnder;
  if (key.startsWith("build.")) {
    relUnder = path.join("kailash", "build", key.slice("build.".length));
  } else if (key.startsWith("use-template.")) {
    relUnder = path.join("kailash", "use", key.slice("use-template.".length));
  } else if (key === "loom" || key === "atelier") {
    relUnder = key;
  } else {
    // downstream.<slug> / any dotted key → its last segment; else the repo name.
    relUnder = key.includes(".") ? key.split(".").pop() : remote.repo || key;
  }
  return path.join(reposRoot, relUnder);
}

// Derive a clone URL for a remote-only binding. github → SSH form (canon's
// only provider today). Non-github providers (azure-devops) need the full
// org/project triple wired by G-F (W7); until then the result carries org +
// repo + provider so a consumer can construct the URL, and url is null.
function deriveRemoteUrl(remote, provider) {
  if (provider === "github") {
    return `git@github.com:${remote.org}/${remote.repo}.git`;
  }
  return null;
}

// Assemble the remote-only result (Q4 url-kind): the key is bound in the
// ecosystem remote registry but NOT checked out locally. kind:"remote-only"
// signals "not on disk"; `value` is the suggested default path, `url`/`org`/
// `repo`/`provider` are the remote WHICH.
function makeRemoteOnly(key, remote, reposRoot) {
  const provider = getRepoProvider(key);
  return {
    kind: "remote-only",
    key,
    org: remote.org,
    repo: remote.repo,
    provider,
    url: deriveRemoteUrl(remote, provider),
    value: deriveDefaultPath(key, remote, reposRoot),
  };
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Resolve a single logical key, joining the WHERE layer (local, this module)
 * with the WHICH layer (ecosystem remote registry, ecosystem-config.mjs).
 *
 * Join rule — local owns WHERE, remote owns WHICH:
 *   - local present  → return the local entry, ANNOTATED `remote:{org,repo}`
 *                      when a remote binding exists (else the field is absent).
 *   - local absent + remote present → `{kind:"remote-only", org, repo,
 *                      provider, url, value:<derived-default-path>, key}` (Q4).
 *   - local absent + remote absent  → unchanged fail-loud LinkError(unknown-key).
 *
 * BACK-COMPAT (mandatory): with NO ecosystem.json, getRemoteLink returns null
 * for every key, so the `remote` annotation never appears and the return is
 * BYTE-IDENTICAL to before D6 (`{kind,value,key}`). A PRESENT-but-malformed
 * ecosystem.json fails LOUD (EcosystemConfigError, Q6) — NOT swallowed by
 * require:false, because a survey silently skipping every key over a broken
 * remote registry is the exact silent failure Q6 prevents.
 *
 * @param {string} logicalKey  e.g. "build.py", "use-template.rs",
 *                              "loom", "atelier", "downstream.<slug>"
 * @param {{require?: boolean}} [opts]  require defaults to true.
 *        require:false → return { skipped:true, reason } instead of
 *        throwing a LinkError (for survey / fan-out callers that tolerate
 *        undeclared-key GAPS; a malformed ecosystem.json still throws).
 * @returns {{kind:"path"|"url", value:string, key:string, remote?:{org,repo}}
 *           | {kind:"remote-only", key:string, org:string, repo:string,
 *              provider:string, url:string|null, value:string}
 *           | {skipped:true, reason:string}}
 */
export function resolveRepo(logicalKey, opts = {}) {
  const requireIt = opts.require !== false;
  try {
    if (typeof logicalKey !== "string" || logicalKey.trim() === "") {
      throw new LinkError(
        "unknown-key",
        `loom-links: logicalKey must be a non-empty string`,
      );
    }
    const { reposRoot, links } = loadConfig();
    const remote = getRemoteLink(logicalKey); // null when no ecosystem.json / unbound

    if (logicalKey in links) {
      const local = normalizeEntry(logicalKey, links[logicalKey], reposRoot);
      if (remote) local.remote = { org: remote.org, repo: remote.repo };
      return local;
    }
    if (remote) {
      return makeRemoteOnly(logicalKey, remote, reposRoot);
    }
    throw new LinkError(
      "unknown-key",
      `loom-links: no linkage declared for key '${logicalKey}'\n` +
        `(declare it in your loom-links.local.json 'links' block)`,
    );
  } catch (e) {
    if (!requireIt && e instanceof LinkError) {
      return { skipped: true, reason: `${e.subtype}: ${e.message}` };
    }
    throw e;
  }
}

/**
 * Resolve ONLY the WHICH layer for a logical key (the ecosystem remote
 * binding), independent of whether the repo is checked out locally. For
 * consumers that need the remote slug/URL without a local path — S3
 * cross-ecosystem migration + the G-F upflow transport (design §5).
 *
 * @param {string} logicalKey
 * @returns {{org:string, repo:string, provider:string, url:string|null}|null}
 *          null when there is no ecosystem.json OR the key is not bound in
 *          remote_links. A malformed ecosystem.json throws (Q6).
 */
export function resolveRemote(logicalKey) {
  const remote = getRemoteLink(logicalKey);
  if (!remote) return null;
  const provider = getRepoProvider(logicalKey);
  return {
    org: remote.org,
    repo: remote.repo,
    provider,
    url: deriveRemoteUrl(remote, provider),
  };
}

/**
 * Resolve every declared link.
 *
 * `_`-prefixed keys (e.g. `_README`) are skipped (forward-compat /
 * comment vocabulary, mirrors repin's `_`-key-ignore). A per-entry
 * normalization failure (e.g. an ambiguous entry) is surfaced in-band
 * as { kind:"error", error } so one bad entry does not abort the survey.
 *
 * @returns {Map<string,{kind:"path"|"url",value:string}
 *                       |{kind:"error",error:string}>}
 */
export function resolveAll() {
  const { reposRoot, links } = loadConfig();
  const out = new Map();
  for (const [key, entry] of Object.entries(links)) {
    if (key.startsWith("_")) continue;
    try {
      const r = normalizeEntry(key, entry, reposRoot);
      out.set(key, { kind: r.kind, value: r.value });
    } catch (e) {
      out.set(key, {
        kind: "error",
        error: e instanceof LinkError ? `${e.subtype}: ${e.message}` : String(e),
      });
    }
  }
  return out;
}

/**
 * Resolve which ROLE this clone is (D2). Precedence (NO silent guess):
 *   1. resolver `role:` in loom-links.local.json   — PRIMARY
 *   2. `.coc-role` repo-root marker                 — FALLBACK (resolver-absent
 *                                                     USE-CONSUMER)
 *   3. null                                         — undeclared (doctor-inferred
 *                                                     is a Wave-3 ratified action,
 *                                                     NOT a runtime guess here)
 *
 * A resolver-absent clone (loadConfig → not-configured) FALLS THROUGH to the
 * marker — a USE-CONSUMER has no config but may carry a marker. A malformed
 * config OR an out-of-enum role value still propagates loud (LinkError
 * "config-error"); ONLY "not-configured" falls through.
 *
 * Does NOT route through resolveAll/resolveRepo — those operate on the `links`
 * map and would not surface a top-level scalar.
 *
 * @returns {"platform"|"build"|"use-consumer"|null}
 */
export function resolveRole() {
  try {
    const { role } = loadConfig();
    if (role) return role;
    // config present but no role: → fall through to the marker.
  } catch (e) {
    // Resolver-absent consumer → try the marker. Any OTHER LinkError
    // (config-error / out-of-enum role) propagates loud.
    if (!(e instanceof LinkError) || e.subtype !== "not-configured") throw e;
  }
  return readCocRoleMarker();
}

/**
 * repin-compatible shard resolution. Reads the OPTIONAL `shards` block:
 *   { "<label>": ["<rel/path>", ...], ... }
 * Each relative path is joined to reposRoot exactly as repin does.
 * `_`-prefixed shard labels are ignored.
 *
 * @param {string} label  a shard label, or "all" to union every shard.
 * @returns {string[]}    absolute repo paths.
 */
export function resolveShard(label) {
  const { reposRoot, shards } = loadConfig();
  if (!shards) {
    throw new LinkError(
      "config-error",
      `loom-links: config has no 'shards' block (required by resolveShard)`,
    );
  }
  const resolved = {};
  for (const [name, rels] of Object.entries(shards)) {
    if (name.startsWith("_")) continue;
    if (!Array.isArray(rels)) {
      throw new LinkError(
        "config-error",
        `loom-links: shard '${name}' must be an array of repo-relative paths`,
      );
    }
    resolved[name] = rels.map((r) => path.join(reposRoot, expandHome(r)));
  }
  if (Object.keys(resolved).length === 0) {
    throw new LinkError(
      "config-error",
      `loom-links: config defines no shards`,
    );
  }
  if (label === "all") {
    return [].concat(...Object.values(resolved));
  }
  if (!(label in resolved)) {
    throw new LinkError(
      "unknown-key",
      `loom-links: unknown shard '${label}' (have: ${Object.keys(resolved).join(", ")})`,
    );
  }
  return resolved[label];
}

/**
 * Whether a usable linkage config exists on any precedence tier.
 * Does NOT throw — for callers that want to branch on configured-ness
 * (e.g. the repin unify shim) without a try/catch.
 */
export function isConfigured() {
  try {
    resolveConfigPath();
    return true;
  } catch {
    return false;
  }
}

/** The resolved config path (for diagnostics). Throws if not configured. */
export function configPath() {
  return resolveConfigPath();
}

export const _paths = { LOCAL_CONFIG_PATH, EXAMPLE_PATH, BIN_DIR, REPO_ROOT };
