/*
 * ============================================================================
 *  ecosystem-config — ecosystem-shared parameterization loader (D6 keystone)
 * ============================================================================
 *
 *  loom-links.mjs answers WHERE-on-disk a logical key is (per-operator,
 *  gitignored). This module answers the orthogonal ECOSYSTEM-level questions
 *  that are the SAME for every operator in one ecosystem but DIFFER across
 *  ecosystems (canon vs a client fork):
 *
 *    (1) registry          which container registry host+org images publish to
 *    (2) remote_links      NAME → which remote {org,repo} (the WHICH layer that
 *                          composes with loom-links' WHERE layer)
 *    (3) vcs               ecosystem default provider + per-repo overrides
 *                          + the ADO work-item type
 *    (4) deploy            ecosystem-aware deploy targets
 *    (5) upstream_canon    the explicit "sync upstream from" pointer
 *                          (null in canon — canon is the root)
 *
 *  Design: workspaces/ecosystem-operating-model/02-plans/01 + specs/03 (§3).
 *
 *  DISCLOSURE DISCIPLINE (the load-bearing reason this is two files):
 *  THIS LOADER is a SYNCED artifact (`bin/**` is a sync tier) and ships to
 *  30+ downstream consumers + the public fork. It therefore embeds ZERO real
 *  paths, org slugs, or hostnames — exactly like loom-links.mjs. The REAL
 *  registry lives ONLY in `.claude/bin/ecosystem.json`, which is fenced THREE
 *  ways so it never crosses an ecosystem boundary:
 *    - never synced       (sync-manifest.yaml `loom_only:`)
 *    - never published    (scripts/publish-to-public.mjs EXCLUDE_WITHIN + KILL)
 *    - never scanned-as-content (scan-synced-disclosure.mjs self-exclude)
 *  Each fork carries its OWN ecosystem.json; neither is ever synced canon↔client.
 *  The committed `ecosystem.example.json` carries SYNTHETIC tokens only and is
 *  the only `ecosystem*` file the public fork carries.
 *
 *  Back-compat (mandatory): the ABSENCE of ecosystem.json is NOT an error.
 *  A consumer (which never receives ecosystem.json) sees every accessor return
 *  null / the documented default, and loom-links resolution is byte-identical
 *  to today. A PRESENT-but-malformed / unknown-schema_version file fails LOUD
 *  (Q6) — never silently read as v1.
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ → bin/  (ecosystem.json lives in bin/, one level up — co-located with loom-links)
const BIN_DIR = path.resolve(SCRIPT_DIR, "..");
const ECOSYSTEM_PATH = path.join(BIN_DIR, "ecosystem.json");

// The only schema_version this loom understands. An unknown version fails loud
// (Q6) rather than being read as v1 — a future v2 file MUST be read by a v2-aware
// loom, never silently mis-parsed by a v1 one.
const SUPPORTED_SCHEMA_VERSION = 1;

// ────────────────────────────────────────────────────────────────
// Typed error (mirrors loom-links LinkError)
//   config-error   : present but unparseable / malformed shape
//   schema-version : present but schema_version is not SUPPORTED_SCHEMA_VERSION
// ────────────────────────────────────────────────────────────────
export class EcosystemConfigError extends Error {
  constructor(subtype, message) {
    super(message);
    this.name = "EcosystemConfigError";
    this.subtype = subtype;
  }
}

// Config path: $LOOM_ECOSYSTEM_CONFIG (absolute, test/override) > co-located file.
// The override mirrors loom-links' $LOOM_LINKS_CONFIG so tests can point at a
// temp file (present OR absent) without touching the committed canon file.
function ecosystemPath() {
  const env = process.env.LOOM_ECOSYSTEM_CONFIG;
  if (env && env.trim() !== "") {
    if (!path.isAbsolute(env)) {
      throw new EcosystemConfigError(
        "config-error",
        `$LOOM_ECOSYSTEM_CONFIG must be an absolute path (got: ${env})`,
      );
    }
    return env; // may not exist → absent branch in load()
  }
  return ECOSYSTEM_PATH;
}

let _cache = null; // { path, config } — config===null means absent (back-compat)

function load() {
  const p = ecosystemPath();
  if (_cache && _cache.path === p) return _cache;

  if (!fs.existsSync(p)) {
    _cache = { path: p, config: null }; // ABSENCE IS NOT AN ERROR (back-compat)
    return _cache;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new EcosystemConfigError(
      "config-error",
      `ecosystem-config: parse error in ${p}: ${e.message}`,
    );
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new EcosystemConfigError(
      "config-error",
      `ecosystem-config: ${p} is not a JSON object`,
    );
  }
  if (cfg.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new EcosystemConfigError(
      "schema-version",
      `ecosystem-config: schema_version ${JSON.stringify(cfg.schema_version)} ` +
        `is unsupported (this loom understands ${SUPPORTED_SCHEMA_VERSION}). ` +
        `Refusing to read a future/unknown schema as v${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  _cache = { path: p, config: cfg };
  return _cache;
}

/** Test/CLI hook — drop the memoized config so a changed env/file is re-read. */
export function _resetCache() {
  _cache = null;
}

// ────────────────────────────────────────────────────────────────
// Public API — accessors. Each returns null / a documented default when
// ecosystem.json is absent, so a consumer (no ecosystem.json) degrades
// cleanly to today's behaviour.
// ────────────────────────────────────────────────────────────────

/** Whether an ecosystem.json exists at all (the back-compat discriminator). */
export function hasEcosystemConfig() {
  return load().config !== null;
}

/** Full config object, or null when absent. Onboarding/display consumer. */
export function getEcosystemConfig() {
  return load().config;
}

/** (1) registry → {host, org} or null. Composes `${host}/${org}/<image>`. */
export function getRegistry() {
  const c = load().config;
  if (!c || !c.registry) return null;
  return { host: c.registry.host, org: c.registry.org };
}

/**
 * (2) The remote {org, repo} binding for a logical key, or null when there is
 * no ecosystem.json OR the key is not declared in remote_links. The WHICH
 * layer; loom-links.mjs joins it with the WHERE layer.
 */
export function getRemoteLink(key) {
  const c = load().config;
  if (!c || !c.remote_links) return null;
  const e = c.remote_links[key];
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  return { org: e.org, repo: e.repo };
}

/**
 * (3) The VCS provider for a logical key. Precedence (Q7), resolved ONCE here
 * so no call site re-derives it:
 *   roster own-repo  >  vcs.overrides[key]  >  vcs.default_provider  >  "github"
 * The roster own-repo layer (closest to truth for a repo's OWN provider) is
 * supplied by the caller via opts.rosterProvider — the ecosystem layer owns
 * only the overrides + default tiers.
 */
export function getRepoProvider(key, opts = {}) {
  if (opts.rosterProvider) return opts.rosterProvider;
  const c = load().config;
  const vcs = (c && c.vcs) || {};
  if (vcs.overrides && vcs.overrides[key]) return vcs.overrides[key];
  if (vcs.default_provider) return vcs.default_provider;
  return "github";
}

/**
 * (3b) The ADO work-item type (G-F-3; D6 owns the schema field, G-F consumes).
 * Defaults to "Task" when unset — the ADO default work-item type.
 */
export function getAdoWorkItemType() {
  const c = load().config;
  return (c && c.vcs && c.vcs.ado_work_item_type) || "Task";
}

/** (4) deploy config → {default_targets, per_project} or null (redteam/01 F2). */
export function getDeploy() {
  const c = load().config;
  return c && c.deploy ? c.deploy : null;
}

/**
 * (5) The upstream-canon pointer → {remote, url} or null. null in canon
 * (canon is the root); a client fork names the canon it syncs upstream from.
 * Read by the G-F upflow transport.
 */
export function getUpstreamCanon() {
  const c = load().config;
  if (!c || !c.ecosystem || !c.ecosystem.upstream_canon) return null;
  return c.ecosystem.upstream_canon;
}

export const _paths = { ECOSYSTEM_PATH, BIN_DIR };
