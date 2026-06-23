#!/usr/bin/env node
/**
 * Unit tests for .claude/bin/deploy-config.mjs (ECO-IMPL W6b-ii / C3, specs/07-deploy.md).
 *
 * Run: node --test .claude/bin/deploy-config.test.mjs
 *
 * Per probe-driven-verification.md MUST-3: every assertion here is STRUCTURAL
 * (object key/value equality, thrown-error type + subtype, path-navigation
 * result) — not lexical regex against assistant prose. getDeploy() is injected
 * (opts.deployFn) so the resolver is tested against synthetic ecosystem deploy
 * shapes without touching the real ecosystem.json (the loom-only, never-synced
 * committed config — committed-but-ecosystem-private, NOT gitignored).
 *
 * Coverage maps to specs/07-deploy.md §6 invariants:
 *   (i)  getDeploy()===null ⟹ projectConfig UNCHANGED         → test "invariant-i-*"
 *   (ii) every ${ecosystem.deploy.*} resolves OR fails CLOSED  → test "invariant-ii-*"
 *   §2   layered merge default_targets ⊕ per_project ⊕ project → test "merge-*"
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  resolveDeployTarget,
  DeployConfigError,
  _internals,
} from "./deploy-config.mjs";

const nullDeploy = () => null;
const deployFn = (obj) => () => obj;

// ── Invariant (i): null getDeploy → projectConfig returned unchanged ──────────

test("invariant-i-null-deploy-returns-project-config-unchanged", () => {
  const projectConfig = { platform: "fly", deploy_command: "fly deploy", paths: ["src/"] };
  const out = resolveDeployTarget({ projectKey: "build.py", projectConfig }, { deployFn: nullDeploy });
  assert.deepEqual(out, projectConfig);
});

test("invariant-i-null-deploy-returns-a-copy-not-the-same-ref", () => {
  const projectConfig = { platform: "fly" };
  const out = resolveDeployTarget({ projectKey: "build.py", projectConfig }, { deployFn: nullDeploy });
  assert.notEqual(out, projectConfig, "must be a fresh object, not the input ref");
  assert.deepEqual(out, projectConfig);
});

test("invariant-i-null-deploy-does-not-throw-on-tokens-left-in-place", () => {
  // No ecosystem config → no interpolation at all → tokens pass through literally
  // (today's behavior; the project simply has no ecosystem layer to resolve against).
  const projectConfig = { registry: "${ecosystem.deploy.registry_org}" };
  const out = resolveDeployTarget({ projectKey: "build.py", projectConfig }, { deployFn: nullDeploy });
  assert.equal(out.registry, "${ecosystem.deploy.registry_org}");
});

// ── Invariant (ii): token interpolation, fail-closed on unresolvable ──────────

test("invariant-ii-whole-value-token-resolves-to-raw-value", () => {
  const deploy = { registry_org: "acme-infra", default_targets: [{ env: "prod" }] };
  const out = resolveDeployTarget(
    { projectKey: "build.py", projectConfig: { registry: "${ecosystem.deploy.registry_org}" } },
    { deployFn: deployFn(deploy) },
  );
  assert.equal(out.registry, "acme-infra");
});

test("invariant-ii-whole-value-token-preserves-non-string-type", () => {
  const deploy = { default_targets: [{ env: "prod", port: 8080 }] };
  const out = resolveDeployTarget(
    { projectKey: "p", projectConfig: { target: "${ecosystem.deploy.default_targets[0]}" } },
    { deployFn: deployFn(deploy) },
  );
  assert.deepEqual(out.target, { env: "prod", port: 8080 }, "whole-value token keeps object shape");
});

test("invariant-ii-indexed-path-token-resolves", () => {
  const deploy = { default_targets: [{ env: "staging" }, { env: "prod" }] };
  const out = resolveDeployTarget(
    { projectKey: "p", projectConfig: { target_env: "${ecosystem.deploy.default_targets[1].env}" } },
    { deployFn: deployFn(deploy) },
  );
  assert.equal(out.target_env, "prod");
});

test("invariant-ii-embedded-token-substitutes-within-string", () => {
  const deploy = { registry_org: "acme", registry_host: "ghcr.io" };
  const out = resolveDeployTarget(
    {
      projectKey: "p",
      projectConfig: { image: "${ecosystem.deploy.registry_host}/${ecosystem.deploy.registry_org}/app" },
    },
    { deployFn: deployFn(deploy) },
  );
  assert.equal(out.image, "ghcr.io/acme/app");
});

test("invariant-ii-unresolvable-token-throws-typed-fail-closed", () => {
  const deploy = { registry_org: "acme" };
  assert.throws(
    () =>
      resolveDeployTarget(
        { projectKey: "p", projectConfig: { x: "${ecosystem.deploy.nonexistent_field}" } },
        { deployFn: deployFn(deploy) },
      ),
    (e) => {
      assert.ok(e instanceof DeployConfigError, "must be DeployConfigError");
      assert.equal(e.subtype, "unresolvable-token");
      assert.match(e.message, /nonexistent_field/, "names the missing field");
      return true;
    },
  );
});

test("invariant-ii-unresolvable-indexed-path-throws", () => {
  const deploy = { default_targets: [{ env: "prod" }] };
  assert.throws(
    () =>
      resolveDeployTarget(
        { projectKey: "p", projectConfig: { e: "${ecosystem.deploy.default_targets[5].env}" } },
        { deployFn: deployFn(deploy) },
      ),
    (e) => e instanceof DeployConfigError && e.subtype === "unresolvable-token",
  );
});

test("invariant-ii-token-in-nested-object-resolves-deeply", () => {
  const deploy = { registry_org: "acme" };
  const out = resolveDeployTarget(
    { projectKey: "p", projectConfig: { meta: { tags: ["${ecosystem.deploy.registry_org}", "v1"] } } },
    { deployFn: deployFn(deploy) },
  );
  assert.deepEqual(out.meta, { tags: ["acme", "v1"] });
});

test("invariant-ii-present-null-leaf-resolves-not-fail-closed", () => {
  // A field present-but-null is FOUND (not absent) → resolves to null, no throw.
  const deploy = { maybe_null: null };
  const out = resolveDeployTarget(
    { projectKey: "p", projectConfig: { x: "${ecosystem.deploy.maybe_null}" } },
    { deployFn: deployFn(deploy) },
  );
  assert.equal(out.x, null);
});

// ── §2 layered merge: default_targets(obj) ⊕ per_project[key] ⊕ projectConfig ──

test("merge-project-config-wins-last-over-ecosystem-layers", () => {
  const deploy = {
    default_targets: { provider: "github", env: "prod" },
    per_project: { "build.py": { env: "staging" } },
  };
  const out = resolveDeployTarget(
    { projectKey: "build.py", projectConfig: { env: "dev", deploy_command: "make ship" } },
    { deployFn: deployFn(deploy) },
  );
  // default env=prod, per_project env=staging, project env=dev → project wins
  assert.equal(out.env, "dev");
  assert.equal(out.provider, "github", "ecosystem default surfaces when project doesn't override");
  assert.equal(out.deploy_command, "make ship");
});

test("merge-per-project-overrides-default-when-project-silent", () => {
  const deploy = {
    default_targets: { provider: "github", region: "us-east" },
    per_project: { "build.rs": { region: "eu-west" } },
  };
  const out = resolveDeployTarget(
    { projectKey: "build.rs", projectConfig: { platform: "ado" } },
    { deployFn: deployFn(deploy) },
  );
  assert.equal(out.region, "eu-west", "per_project overrides default");
  assert.equal(out.provider, "github");
  assert.equal(out.platform, "ado");
});

test("merge-per-project-absent-key-yields-default-plus-project-only", () => {
  const deploy = {
    default_targets: { provider: "github" },
    per_project: { "build.py": { region: "x" } },
  };
  const out = resolveDeployTarget(
    { projectKey: "build.unknown", projectConfig: { platform: "fly" } },
    { deployFn: deployFn(deploy) },
  );
  assert.deepEqual(out, { provider: "github", platform: "fly" });
});

test("merge-list-default_targets-not-flat-merged-only-token-reachable", () => {
  // default_targets in LIST form is NOT spread into the flat merge (list ⊕ object
  // is undefined); it is reachable only via §2.1 tokens.
  const deploy = { default_targets: [{ env: "prod" }] };
  const out = resolveDeployTarget(
    { projectKey: "p", projectConfig: { platform: "fly" } },
    { deployFn: deployFn(deploy) },
  );
  assert.deepEqual(out, { platform: "fly" }, "list default_targets contributes no flat keys");
});

test("merge-null-projectKey-skips-per-project-layer", () => {
  const deploy = {
    default_targets: { provider: "github" },
    per_project: { "build.py": { region: "x" } },
  };
  const out = resolveDeployTarget(
    { projectKey: null, projectConfig: { platform: "fly" } },
    { deployFn: deployFn(deploy) },
  );
  assert.deepEqual(out, { provider: "github", platform: "fly" });
});

// ── input validation ─────────────────────────────────────────────────────────

test("config-error-non-object-project-config-throws", () => {
  assert.throws(
    () => resolveDeployTarget({ projectKey: "p", projectConfig: ["not", "object"] }, { deployFn: nullDeploy }),
    (e) => e instanceof DeployConfigError && e.subtype === "config-error",
  );
});

test("config-error-missing-project-config-throws", () => {
  assert.throws(
    () => resolveDeployTarget({ projectKey: "p" }, { deployFn: nullDeploy }),
    (e) => e instanceof DeployConfigError && e.subtype === "config-error",
  );
});

// ── navigatePath unit coverage (the path navigator behind tokens) ─────────────

test("navigatePath-dot-and-bracket-segments", () => {
  const root = { a: { b: [{ c: 42 }] } };
  assert.deepEqual(_internals.navigatePath(root, "a.b[0].c"), { found: true, value: 42 });
});

test("navigatePath-absent-segment-returns-not-found", () => {
  assert.deepEqual(_internals.navigatePath({ a: 1 }, "a.b.c"), { found: false });
});

test("navigatePath-out-of-range-index-not-found", () => {
  assert.deepEqual(_internals.navigatePath({ a: [1] }, "a[3]"), { found: false });
});

// ── prototype-chain hardening: inherited keys resolve to NOT-FOUND (fail-closed) ──

test("navigatePath-proto-chain-keys-not-found", () => {
  // __proto__ / constructor / prototype / toString are inherited, NOT own — must
  // be unresolvable so a token referencing them fails closed, never leaks the chain.
  assert.deepEqual(_internals.navigatePath({}, "__proto__"), { found: false });
  assert.deepEqual(_internals.navigatePath({}, "constructor"), { found: false });
  assert.deepEqual(_internals.navigatePath({}, "__proto__.polluted"), { found: false });
  assert.deepEqual(_internals.navigatePath({}, "toString"), { found: false });
});

test("invariant-ii-proto-chain-token-fails-closed", () => {
  const deploy = { registry_org: "acme" };
  for (const bad of ["__proto__", "constructor", "constructor.name"]) {
    assert.throws(
      () =>
        resolveDeployTarget(
          { projectKey: "p", projectConfig: { x: `\${ecosystem.deploy.${bad}}` } },
          { deployFn: deployFn(deploy) },
        ),
      (e) => e instanceof DeployConfigError && e.subtype === "unresolvable-token",
      `token ${bad} must fail closed`,
    );
  }
});

test("navigatePath-own-key-named-like-proto-still-resolves", () => {
  // An OWN property literally named "constructor" IS resolvable (it's own, not inherited).
  const obj = Object.create(null);
  obj.constructor = "i-am-own";
  assert.deepEqual(_internals.navigatePath(obj, "constructor"), { found: true, value: "i-am-own" });
});
