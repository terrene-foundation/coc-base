#!/usr/bin/env node
/*
 * local-rules — F-353 Item 4: the deployment-local rules manifest (ADD-ONLY).
 *
 * WHAT THIS IS (grounded in the epic + precedents):
 *   A resolver-mapped verbatim-replica (an ecosystem FORK — `rules/artifact-flow.md`
 *   § "Ecosystem Forks vs Downstream Consumers") that wants its OWN deployment-local
 *   rule has, today, no clean surface: editing a canonical `.claude/rules/<name>.md`
 *   trips the overlay verifier's `drift-from-both` on the next `sync-from-canon`, and
 *   there is no declaration surface for deployment-only rules. This module is that
 *   surface: a config-driven, drift-excluded, ADD-ONLY additive overlay.
 *
 * THE ADD-ONLY INVARIANT (co-owner-APPROVED disposition ②):
 *   A local rule ADDS to the corpus. It MUST NOT OVERRIDE, shadow, or soften a canon
 *   rule. A local-manifest that declares a rule whose id / path COLLIDES with a canon
 *   rule (`.claude/rules/<id>.md`) is a LOUD, typed error — never a silent override.
 *   This is the load-bearing property of the approved decision; it is enforced here
 *   (the single shared loader every consumer routes through) so the eval surface
 *   (emit/compose) and the exclusion surface (drift comparator + never-sync
 *   classifier) can never drift on the invariant.
 *
 * FORK→CANON ISOLATION (preserved):
 *   The reserved subtree `.claude/rules/local/**` is a NEVER-SYNC, NEVER-ENUMERATED-
 *   BY-CANON path (mirrors how `.claude/.proposals/` is denied from a canon pull and
 *   how `*.local.json` is skipped by the distributor). A local rule never rides a
 *   canon upstream-pull (fork→canon MUST NOT), is never distributed to a target, and
 *   is never counted as canon drift. The path predicate `isLocalRulePath` is the
 *   single source of truth every fence consumes.
 *
 * PRECEDENTS (read + grounded):
 *   - reserved-subtree never-sync   → `.claude/.proposals/` DENY_SET_MATCHERS entry
 *                                     (`sync-from-canon-objects.mjs`) + LOOM_LOCAL_PATTERNS
 *                                     `*.local.json` skip (`sync-tier-aware.mjs`).
 *   - deployment-owned config file  → `bin/*.local.json` (#352) + the `.example`
 *                                     committed-schema companion pattern.
 *   - config-driven mechanism model → the `own_orgs` config-driven own-org allowlist
 *                                     #353 itself cites as its model.
 *
 * Style: Node ESM, zero dependencies beyond node core (mirrors emit.mjs / the
 * sync-from-canon* engine convention). Every failure is a typed, LOUD throw
 * (`rules/zero-tolerance.md` Rule 3) — never a silent skip.
 */

import fs from "node:fs";
import path from "node:path";

// ── the reserved subtree (single source of truth) ────────────────────────────
// A local rule lives at `.claude/rules/local/<name>.md`. Canon's baseline /
// allowlist / distributor / drift comparator ALL treat this subtree as reserved:
// never enumerated as a canon rule, never shipped, never a drift signal. The
// deployment-owned manifest + its committed `.example` template live INSIDE the
// subtree, so they too are never-synced by the same predicate.
export const LOCAL_RULES_SUBTREE = ".claude/rules/local/";
// Segment-anchored: matches the dir itself and anything under it, never a
// sibling like `.claude/rules/local-something.md`.
export const LOCAL_RULES_SUBTREE_RE = /^\.claude\/rules\/local(\/|$)/;
export const LOCAL_MANIFEST_RELPATH = ".claude/rules/local/local-manifest.yaml";
export const LOCAL_MANIFEST_EXAMPLE_RELPATH =
  ".claude/rules/local/local-manifest.example.yaml";

// Files under the subtree that are NOT candidate local rules: the manifest, its
// committed schema template, and the `_`-prefixed doc file (the loom "not an
// artifact" convention, mirroring `agents/_README.md`).
const NON_RULE_LOCAL_BASENAMES = new Set([
  "local-manifest.yaml",
  "local-manifest.example.yaml",
  "_README.md",
]);

/**
 * Is `relpath` inside the reserved deployment-local rules subtree? The single
 * predicate consumed by the drift comparator (sync-from-canon-objects),
 * the distributor (sync-tier-aware classifyFile), and any upstream/proposal
 * fence — so the never-sync / never-enumerate / never-drift invariant cannot
 * drift across surfaces.
 * @param {string} relpath  a repo-relative POSIX path
 * @returns {boolean}
 */
export function isLocalRulePath(relpath) {
  return typeof relpath === "string" && LOCAL_RULES_SUBTREE_RE.test(relpath);
}

// ── typed error (loud, never a silent skip) ──────────────────────────────────
export class LocalRulesError extends Error {
  constructor(subtype, message) {
    super(message);
    this.name = "LocalRulesError";
    this.subtype = subtype;
  }
}

/**
 * Parse a `local-manifest.yaml` body into a declared-rule list. Zero-dep minimal
 * YAML (mirrors emit.mjs's frontmatter/tier scanners — no external YAML dep).
 * The manifest shape is intentionally narrow:
 *
 *   rules:
 *     - id: my-deployment-cadence
 *       path: .claude/rules/local/my-deployment-cadence.md
 *     - id: another
 *       path: .claude/rules/local/another.md
 *
 * A malformed manifest is a LOUD throw — never a partial/silent parse.
 * @param {string} text
 * @returns {{rules: Array<{id:string, path:string}>}}
 */
export function parseLocalManifest(text) {
  if (typeof text !== "string") {
    throw new LocalRulesError(
      "malformed-manifest",
      "local-rules: manifest body must be a string",
    );
  }
  const lines = text.split("\n");
  const rules = [];
  let inRules = false;
  let cur = null;
  const flush = () => {
    if (cur) {
      rules.push(cur);
      cur = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip a whole-line / trailing comment (outside any quoting — the manifest
    // values are bare paths/ids, so a simple ` #` split is sufficient).
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    if (line.trim() === "") continue;
    if (/^rules:\s*$/.test(line)) {
      inRules = true;
      continue;
    }
    if (!inRules) {
      // A top-level key other than `rules:` — ignore (forward-compatible), but a
      // non-indented non-key line is malformed.
      if (/^\S/.test(line) && !/^[A-Za-z0-9_-]+:\s*/.test(line)) {
        throw new LocalRulesError(
          "malformed-manifest",
          `local-rules: unexpected top-level line ${JSON.stringify(raw)} (line ${i + 1})`,
        );
      }
      continue;
    }
    // Inside the `rules:` list. A new item starts with `- `.
    const itemStart = line.match(/^(\s*)-\s+(.*)$/);
    if (itemStart) {
      flush();
      cur = {};
      const rest = itemStart[2];
      const kv = rest.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) applyKv(cur, kv[1], kv[2], i, raw);
      continue;
    }
    const kv = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv && cur) {
      applyKv(cur, kv[1], kv[2], i, raw);
      continue;
    }
    throw new LocalRulesError(
      "malformed-manifest",
      `local-rules: cannot parse manifest line ${JSON.stringify(raw)} (line ${i + 1})`,
    );
  }
  flush();
  return { rules };
}

function applyKv(obj, key, value, lineIdx, raw) {
  const v = value.replace(/^["']|["']$/g, "").trim();
  if (key === "id" || key === "path") {
    obj[key] = v;
    return;
  }
  // Unknown per-item key — forward-compatible ignore, but only for known-shaped
  // scalar keys; a structurally weird line already threw above.
}

/**
 * Load + VALIDATE the deployment's local rules, enforcing the ADD-ONLY invariant.
 *
 * INERT when absent: if `.claude/rules/local/local-manifest.yaml` does not exist
 * the result is `{ rules: [] }` — canon loom (and any deployment with no local
 * rules) is completely unaffected. The mechanism activates ONLY in a deployment
 * that authored a manifest.
 *
 * Validation (every failure is a LOUD, typed throw):
 *   1. containment    — every declared `path` MUST be inside the reserved subtree
 *                       (no `..`, no escape, no canonical-file target).
 *   2. existence      — every declared rule file MUST exist on disk.
 *   3. ADD-ONLY       — a declared id (or the basename of its path) MUST NOT
 *                       collide with a canon rule `.claude/rules/<id>.md`. A local
 *                       rule can NEVER silently override canon.
 *   4. no-orphan      — every `*.md` file present in the subtree (excluding the
 *                       manifest / example / `_README.md`) MUST be declared. An
 *                       undeclared local rule file is a LOUD error (parity with
 *                       `rules/orphan-detection.md`: no undeclared subtree file).
 *
 * @param {string} repoRoot                       repo root (contains `.claude/`)
 * @param {object} [opts]
 * @param {string[]} [opts.canonRuleIds]          canon rule ids (basename w/o `.md`);
 *                                                default: read `.claude/rules/*.md`.
 * @param {function} [opts.readFileFn]            (absPath) => string
 * @param {function} [opts.readdirFn]             (absDir) => string[]  (subtree listing)
 * @param {function} [opts.existsFn]              (absPath) => boolean
 * @returns {{rules: Array<{id:string, path:string, absPath:string}>}}
 * @throws {LocalRulesError}
 */
export function loadLocalRules(repoRoot, opts = {}) {
  if (typeof repoRoot !== "string" || repoRoot === "") {
    throw new LocalRulesError("bad-repo-root", "local-rules: repoRoot must be a non-empty string");
  }
  // Default reader opens the LEAF with O_NOFOLLOW so a symlink planted at a
  // declared local-rule path (or the manifest) cannot redirect the read out of
  // the containment-verified subtree (defense-in-depth; the path string is
  // already `..`-guarded, this closes the leaf-symlink axis structurally in the
  // single shared loader rather than per-consumer). ELOOP on a symlink → fail
  // closed (a typed throw from the caller's error path).
  const readFileFn =
    opts.readFileFn ||
    ((p) => {
      const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        return fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    });
  const existsFn = opts.existsFn || ((p) => fs.existsSync(p));
  const readdirFn =
    opts.readdirFn ||
    ((d) => (fs.existsSync(d) ? fs.readdirSync(d) : []));

  const manifestAbs = path.join(repoRoot, LOCAL_MANIFEST_RELPATH);
  const subtreeAbs = path.join(repoRoot, LOCAL_RULES_SUBTREE);

  // INERT when absent — the canon/no-local-rules case.
  if (!existsFn(manifestAbs)) {
    // Even with no manifest, an UNDECLARED `*.md` sitting in the subtree is a
    // latent orphan (a fork dropped a rule file but never declared it → it would
    // silently never load). Surface it loud rather than swallow it.
    const stray = strayLocalRuleFiles(subtreeAbs, readdirFn);
    if (stray.length > 0) {
      throw new LocalRulesError(
        "undeclared-local-rule",
        `local-rules: ${stray.length} rule file(s) in ${LOCAL_RULES_SUBTREE} but no ` +
          `${LOCAL_MANIFEST_RELPATH} declares them: ${stray.join(", ")}. ` +
          `Declare each in local-manifest.yaml (a local rule must be declared to load).`,
      );
    }
    return { rules: [] };
  }

  const manifest = parseLocalManifest(readFileFn(manifestAbs));
  // ADD-ONLY collision set — case-FOLDED so a local `Security.md` cannot slip past
  // a canon `security.md` on a case-insensitive filesystem (defense-in-depth on
  // the load-bearing add-only control; canon ids are lowercase by frontmatter
  // convention but the compare must not assume it).
  const canonIds = new Set(
    (Array.isArray(opts.canonRuleIds)
      ? opts.canonRuleIds
      : defaultCanonRuleIds(repoRoot, readdirFn)
    ).map((id) => String(id).toLowerCase()),
  );

  const seenIds = new Set();
  const declaredBasenames = new Set();
  const out = [];
  for (const decl of manifest.rules) {
    if (!decl || typeof decl.id !== "string" || decl.id.trim() === "") {
      throw new LocalRulesError(
        "malformed-manifest",
        `local-rules: every rule entry needs a non-empty 'id' (got ${JSON.stringify(decl)})`,
      );
    }
    if (typeof decl.path !== "string" || decl.path.trim() === "") {
      throw new LocalRulesError(
        "malformed-manifest",
        `local-rules: rule '${decl.id}' needs a non-empty 'path'`,
      );
    }
    // 1. containment — normalize + confirm inside the reserved subtree.
    const norm = path.posix.normalize(decl.path);
    if (!isLocalRulePath(norm) || norm.includes("..")) {
      throw new LocalRulesError(
        "path-escape",
        `local-rules: rule '${decl.id}' path ${JSON.stringify(decl.path)} MUST be inside ` +
          `${LOCAL_RULES_SUBTREE} (a local rule cannot target a canonical file or escape the subtree).`,
      );
    }
    // duplicate id inside the manifest.
    if (seenIds.has(decl.id)) {
      throw new LocalRulesError(
        "duplicate-id",
        `local-rules: id '${decl.id}' declared more than once in the manifest`,
      );
    }
    seenIds.add(decl.id);
    const base = path.posix.basename(norm, ".md");
    declaredBasenames.add(path.posix.basename(norm));
    // 3. ADD-ONLY — collision with a canon rule id/basename is a LOUD error
    // (case-folded compare — see canonIds above).
    const idLc = decl.id.toLowerCase();
    const baseLc = base.toLowerCase();
    if (canonIds.has(idLc) || canonIds.has(baseLc)) {
      throw new LocalRulesError(
        "add-only-violation",
        `local-rules: local rule '${decl.id}' (${norm}) COLLIDES with canon rule ` +
          `'.claude/rules/${canonIds.has(idLc) ? decl.id : base}.md'. Local rules are ADD-ONLY — ` +
          `they MUST NOT override, shadow, or soften a canon rule. Rename the local rule or ` +
          `contribute the change to canon via /codify.`,
      );
    }
    // 2. existence.
    const absPath = path.join(repoRoot, norm);
    if (!existsFn(absPath)) {
      throw new LocalRulesError(
        "missing-local-rule",
        `local-rules: rule '${decl.id}' declares ${norm} but the file does not exist`,
      );
    }
    // 5. baseline-only contract (LOUD, never a silent no-op). The emit/compose
    // path composes ONLY always-on baseline (`priority: 0`) local rules; a
    // path-scoped (`priority: N>0` / `paths:`) local rule would validate here yet
    // enter NO emit output — a silent drop of a declared, validated artifact
    // (`rules/zero-tolerance.md` Rule 3). Rather than swallow it, require every
    // declared local rule to be `priority: 0`. Path-scoped local rules are a
    // clean future extension (they need emit-side rules-reference wiring); until
    // then a non-baseline declaration is a LOUD, actionable error.
    const body = readFileFn(absPath);
    const fm = typeof body === "string" ? body.match(/^---\n([\s\S]*?)\n---/) : null;
    const prio = fm ? fm[1].match(/^priority:\s*(\d+)/m) : null;
    if (!prio || parseInt(prio[1], 10) !== 0) {
      throw new LocalRulesError(
        "unsupported-local-rule-scope",
        `local-rules: rule '${decl.id}' (${norm}) must declare frontmatter 'priority: 0' — ` +
          `local rules are currently ADD-ONLY always-on baseline rules. Path-scoped local ` +
          `rules (priority > 0 / paths:) are not yet emitted and would silently never load; ` +
          `set 'priority: 0' or remove the rule.`,
      );
    }
    out.push({ id: decl.id, path: norm, absPath, priority: 0 });
  }

  // 4. no-orphan — every present rule file MUST be declared.
  const stray = strayLocalRuleFiles(subtreeAbs, readdirFn).filter(
    (rel) => !declaredBasenames.has(path.posix.basename(rel)),
  );
  if (stray.length > 0) {
    throw new LocalRulesError(
      "undeclared-local-rule",
      `local-rules: ${stray.length} rule file(s) present in ${LOCAL_RULES_SUBTREE} but not ` +
        `declared in ${LOCAL_MANIFEST_RELPATH}: ${stray.join(", ")}. Declare each (or remove it).`,
    );
  }

  return { rules: out };
}

// Non-recursive scan of the subtree for candidate `*.md` rule files (excludes the
// manifest / example / `_README.md`). Returns repo-subtree-relative paths.
function strayLocalRuleFiles(subtreeAbs, readdirFn) {
  const entries = readdirFn(subtreeAbs) || [];
  return entries
    .filter((f) => typeof f === "string" && f.endsWith(".md"))
    .filter((f) => !NON_RULE_LOCAL_BASENAMES.has(f))
    .map((f) => `${LOCAL_RULES_SUBTREE}${f}`)
    .sort();
}

// Canon rule ids = basenames (no `.md`) of `.claude/rules/*.md`, NON-recursive —
// the `local/` subdir is a dirent (not a `.md` file) and is naturally excluded,
// so canon's rule-id set NEVER enumerates a local rule (mechanism #1).
function defaultCanonRuleIds(repoRoot, readdirFn) {
  const rulesAbs = path.join(repoRoot, ".claude", "rules");
  const entries = readdirFn(rulesAbs) || [];
  return entries
    .filter((f) => typeof f === "string" && f.endsWith(".md"))
    .map((f) => path.posix.basename(f, ".md"));
}

export const _internal = {
  NON_RULE_LOCAL_BASENAMES,
  strayLocalRuleFiles,
  defaultCanonRuleIds,
  applyKv,
};
