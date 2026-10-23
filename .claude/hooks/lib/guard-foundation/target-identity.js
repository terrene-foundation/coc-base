/**
 * guard-foundation/target-identity.js — L1 provider: WHAT a target path
 * actually is: its canonical target AND whether it is a REGISTERED
 * EXTERNAL-HANDLER ALIAS. Those are TWO facts, deliberately separate.
 *
 * THE FALSE-BLOCK THIS EXISTS FOR. A universal "refuse symlinks" rule is the
 * cheapest path-fence, and it is wrong here: registered external-handler
 * aliases ARE symlinks BY DESIGN (a consumer tree links to a handler that
 * lives outside it), so a refusal keyed only on `isSymbolicLink()` blocks the
 * sanctioned case while claiming to be conservative. The correct inputs to
 * L3 are separate questions with separate answers:
 *
 *     canonical : where does the target REALLY point  (path fact, resolved)
 *     alias     : is that link a REGISTERED handler   (registry fact)
 *
 * L3's chain (deny > undetermined-on-protected > halt > advisory > allow)
 * needs both: an UNREGISTERED symlink out of tree is the deny case, a
 * REGISTERED alias is the allow case, and the two are indistinguishable to
 * any instrument that only asks "is it a symlink?".
 *
 * THE MISSING-FACT RULE APPLIES TO THE REGISTRY TOO — this is the provider's
 * sharpest edge. When the alias registry is UNAVAILABLE the `alias` fact is
 * `registered: null` and the verdict is "undetermined" — NEVER
 * `registered: false`. Reading "no registry" as "not registered" is exactly
 * the missing-fact-becomes-false shape the ruling bans, and here it would
 * re-create the false-block through the back door on every target. The rule
 * is uniform across ALL targets (including plain files and non-existent
 * paths), so there is no target class where alias absence is silently
 * assumed away.
 *
 * FACTS (required vs detail):
 *   required : the target path itself; registry availability; resolution
 *              success (canonical for an existing target, or parent
 *              resolution for one about to be created)
 *   detail   : existence as a LINK (`symlink`), registration entry detail
 *              (`handler`, `registry`)
 *
 * NON-EXISTENT TARGETS. A write target normally does not exist yet. Its
 * identity is the RESOLVED PARENT (realpath) joined with the basename, so a
 * symlinked parent directory cannot hide an escape; if the parent will not
 * resolve, the identity is undetermined. This module resolves no TOCTOU —
 * it reports identity at probe time, per `rules/security.md` § Path
 * Containment (resolve-and-normalize is necessary, not sufficient).
 *
 * Style: CommonJS, zero-dep, node:fs/node:path only — real fs, no policy.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  determinedFacts,
  undeterminedFacts,
  missingFactReason,
} = require("./contract.js");

/**
 * A registration entry (from the registry lane's artifact) is
 * `{ path, handler, registry? , target? }`:
 *   path     - the ALIAS location (the symlink's own path)
 *   target   - optional: the canonical destination the alias resolves to
 *   handler  - the external handler's name (detail fact for L3's audit)
 *   registry - the registry artifact the entry came from (detail fact)
 */
function _matchRegistration(registry, absolute, canonical) {
  for (const entry of registry) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.path === "string" && path.resolve(entry.path) === absolute) {
      return entry;
    }
    if (
      typeof entry.target === "string" &&
      canonical !== null &&
      path.resolve(entry.target) === canonical
    ) {
      return entry;
    }
  }
  return null;
}

function _aliasFact(registration) {
  return {
    registered: registration !== null,
    handler: registration && typeof registration.handler === "string" ? registration.handler : null,
    registry: registration && typeof registration.registry === "string" ? registration.registry : null,
  };
}

/**
 * targetIdentity — THE target provider.
 *
 * @param {string} rawPath - the target path (absolute, or relative to ctx.cwd)
 * @param {object} [ctx] - { cwd?, aliasRegistry? } — `aliasRegistry` is the
 *   registration list from the registry lane; its ABSENCE is a missing fact,
 *   not an empty registry. Pass `[]` to state "registry consulted, nothing
 *   registered" — the two are different worlds and the verdicts differ.
 * @returns {{verdict: string, facts: object, reason: string|null, unresolved?: Array}}
 */
function targetIdentity(rawPath, ctx = {}) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return undeterminedFacts(missingFactReason("target path"), {}, []);
  }
  const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  const absolute = path.resolve(cwd, rawPath);

  // ---- canonical target (path fact) --------------------------------------
  let lstat = null;
  let exists = true;
  try {
    lstat = fs.lstatSync(absolute);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      exists = false;
    } else {
      return undeterminedFacts(
        `target cannot be probed (${(err && err.code) || "IO error"}): identity unresolved`,
        { raw: rawPath, absolute },
        [{ span: absolute, reason: "lstat failed" }],
      );
    }
  }

  let canonical = null;
  if (exists) {
    try {
      canonical = fs.realpathSync(absolute);
    } catch (err) {
      return undeterminedFacts(
        `target exists but does not resolve (dangling link or IO error): canonical target unknown`,
        { raw: rawPath, absolute, exists: true },
        [{ span: absolute, reason: (err && err.code) || "realpath failed" }],
      );
    }
  } else {
    // Identity of a not-yet-created target = RESOLVED parent + basename, so a
    // symlinked parent cannot hide an escape behind the lexical form.
    let parentReal = null;
    try {
      parentReal = fs.realpathSync(path.dirname(absolute));
    } catch (err) {
      return undeterminedFacts(
        `target does not exist and its parent does not resolve (${(err && err.code) || "IO error"}): identity unresolved`,
        { raw: rawPath, absolute, exists: false },
        [{ span: path.dirname(absolute), reason: "parent resolution failed" }],
      );
    }
    canonical = path.join(parentReal, path.basename(absolute));
  }

  const symlink = exists ? lstat.isSymbolicLink() : false;

  // ---- alias fact (registry fact) — SEPARATE from the canonical target ----
  const registry = ctx.aliasRegistry;
  if (!Array.isArray(registry)) {
    return undeterminedFacts(
      missingFactReason(
        "alias registry (external-handler alias registrations not consulted; a symlink refusal without this fact false-blocks registered aliases)",
      ),
      { raw: rawPath, absolute, exists, canonical, symlink, alias: { registered: null, handler: null, registry: null } },
      [{ span: absolute, reason: "alias registry unavailable" }],
    );
  }

  const registration = _matchRegistration(registry, absolute, canonical);
  return determinedFacts({
    raw: rawPath,
    absolute,
    exists,
    canonical,
    symlink,
    alias: _aliasFact(registration),
  });
}

module.exports = { targetIdentity };
