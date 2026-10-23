/**
 * guard-foundation/repo-facts.js — L1 provider: repository facts, with ONE
 * `gitEnv` for every git child process in the guard-foundation tree.
 *
 * THE ONE `gitEnv`. `gitEnv` here IS `lib/git-subprocess-env.js::gitEnv` —
 * the house allowlist (loom#1462): the child gets an explicit minimal env
 * built from constants, so an ambient `GIT_DIR`/`GIT_WORK_TREE` cannot
 * re-point a guard's git at a different repository. This module re-exports it
 * and does NOT build a second one: two env builders would drift and leave one
 * a variable behind (rules/security.md § Enforcement-Surface Parity). Every
 * provider or caller in this directory that ever spawns git obtains its env
 * from HERE, and nowhere else.
 *
 * PROVIDERS (skeleton scope: interfaces + the Undetermined contract — facts
 * are CONSUMED, never fabricated):
 *
 *   repoIdentity(ctx)  — who/where this repository is. REQUIRED: repoRoot
 *     (already resolved, absolute), isWorkTree (boolean), trunk (string).
 *     Absence of any required fact is undetermined — an absent `isWorkTree`
 *     is NOT `false`, and an absent `trunk` is NOT "main". DETAIL (may be
 *     null when not supplied, never load-bearing for the verdict): gitDir,
 *     commonDir, remoteUrl.
 *
 *   consumerTree(ctx)  — the tree of paths that CONSUME guard artifacts.
 *
 * THE WALKER-REPLACEMENT BOUNDARY (why consumerTree is its own provider).
 * Today the registry lane enumerates consumers with its own hand-rolled
 * directory walk. A hand-rolled walk RE-IMPLEMENTS module/graph resolution,
 * so it drifts from Node's rules the moment package layouts get interesting
 * (nested workspaces, `exports`, symlinked trees). This provider is the
 * long-term replacement: its future implementation uses NODE'S OWN PARSER AND
 * RESOLVERS (package.json reads and `require.resolve`/`createRequire` /
 * `node:module` resolution) instead of a bespoke walk, so the consumer set
 * agrees with what Node actually loads. The registry lane then consumes THIS
 * provider's result instead of walking.
 *
 * UNTIL THAT LANDS, THIS PROVIDER RETURNS `undetermined` WHEN NO CONSUMER SET
 * IS SUPPLIED — it never falls back to calling the walker, because a silent
 * second enumeration is the drift this boundary exists to end, and L3 must
 * see "consumer set unknown" rather than a set that disagrees with Node.
 *
 * Style: CommonJS, zero-dep (node:path + the house gitEnv) — no policy.
 */

"use strict";

const path = require("node:path");

const { gitEnv } = require("../git-subprocess-env.js");
const {
  determinedFacts,
  undeterminedFacts,
  missingFactReason,
} = require("./contract.js");

const REQUIRED_REPO_FACTS = Object.freeze(["repoRoot", "isWorkTree", "trunk"]);

/**
 * repoIdentity — THE repository-identity provider.
 *
 * @param {object} ctx - fact source: { repoRoot, isWorkTree, trunk, gitDir?,
 *   commonDir?, remoteUrl? }. Discovery (spawning git with `gitEnv`) is the
 *   caller's step; this provider consumes the discovered facts and refuses to
 *   invent any that are absent.
 * @returns {{verdict: string, facts: object, reason: string|null, unresolved?: Array}}
 */
function repoIdentity(ctx = {}) {
  const { repoRoot, isWorkTree, trunk, gitDir, commonDir, remoteUrl } = ctx;

  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    return undeterminedFacts(missingFactReason("repoRoot (absolute, already-resolved)"), {}, []);
  }
  if (typeof isWorkTree !== "boolean") {
    return undeterminedFacts(
      missingFactReason("isWorkTree (boolean; absence is not `false`)"),
      { repoRoot },
      [],
    );
  }
  if (typeof trunk !== "string" || trunk.length === 0) {
    return undeterminedFacts(missingFactReason("trunk (resolved trunk ref)"), { repoRoot, isWorkTree }, []);
  }

  return determinedFacts({
    repoRoot,
    isWorkTree,
    trunk,
    gitDir: typeof gitDir === "string" ? gitDir : null,
    commonDir: typeof commonDir === "string" ? commonDir : null,
    remoteUrl: typeof remoteUrl === "string" ? remoteUrl : null,
  });
}

/**
 * consumerTree — THE consumer-tree provider (walker-replacement boundary;
 * see the module header). `ctx.consumers`, when supplied, is the set the
 * caller established through Node's own resolution; each entry is
 * `{ path (relative to repoRoot), kind, resolver? }`.
 */
function consumerTree(ctx = {}) {
  const { repoRoot, consumers } = ctx;

  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) {
    return undeterminedFacts(missingFactReason("repoRoot (absolute, already-resolved)"), {}, []);
  }
  if (!Array.isArray(consumers)) {
    return undeterminedFacts(
      missingFactReason(
        "consumer set (enumeration via Node's own parser + resolvers is not implemented in the L1 skeleton; the registry lane's provisional walker is NOT silently substituted here)",
      ),
      { repoRoot },
      [{ span: repoRoot, reason: "consumer tree not enumerated" }],
    );
  }

  const normalized = [];
  for (let i = 0; i < consumers.length; i++) {
    const entry = consumers[i];
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0) {
      return undeterminedFacts(missingFactReason(`consumers[${i}].path`), { repoRoot }, []);
    }
    normalized.push(
      Object.freeze({
        path: entry.path,
        kind: typeof entry.kind === "string" ? entry.kind : null,
        resolver: typeof entry.resolver === "string" ? entry.resolver : null,
      }),
    );
  }

  return determinedFacts({ repoRoot, consumers: Object.freeze(normalized) });
}

module.exports = {
  gitEnv,
  REQUIRED_REPO_FACTS,
  repoIdentity,
  consumerTree,
};
