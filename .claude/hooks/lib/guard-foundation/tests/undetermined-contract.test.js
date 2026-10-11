/**
 * Undetermined-contract tests for the guard-foundation L1 provider skeletons.
 *
 * SCOPE — exactly the contract, nothing else. Per provider:
 *   (1) one case where a PRESENT fact yields "determined";
 *   (2) one case where an ABSENT fact yields "undetermined" — never false,
 *       never an empty result, never an allow.
 * Plus the contract's own guard (`isProviderResult`) exercised in BOTH
 * directions: it must PASS every provider result and REJECT malformed shapes,
 * so the sweep over them is discriminating rather than decorative.
 *
 * Real fs for target-identity (house rule: no mocking) via mkdtemp, cleaned
 * up in `after`. Everything else is pure and hermetic — no ambient reads.
 *
 * Run: node --test .claude/hooks/lib/guard-foundation/tests/undetermined-contract.test.js
 */

"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GF = path.resolve(__dirname, "..");

const contract = require(path.join(GF, "contract.js"));
const effectsModel = require(path.join(GF, "effects.js"));
const { effectsForShellCommand } = require(path.join(GF, "shell-effects.js"));
const { effectsForToolCall } = require(path.join(GF, "tool-effects.js"));
const { targetIdentity } = require(path.join(GF, "target-identity.js"));
const { repoIdentity, consumerTree, gitEnv } = require(path.join(GF, "repo-facts.js"));
const { operatorIdentity, operatorRepoBinding } = require(path.join(GF, "identity.js"));

const { isProviderResult, MISSING_FACT_PREFIX, VERDICTS } = contract;

/** Universal invariants every provider result must satisfy. */
function assertProvider(result, label) {
  assert.ok(
    isProviderResult(result),
    `${label}: result fails the provider contract: ${JSON.stringify(result)}`,
  );
  if (result.verdict === VERDICTS.DETERMINED) {
    assert.equal(result.reason, null, `${label}: determined must carry reason === null`);
  } else {
    assert.ok(
      typeof result.reason === "string" && result.reason.trim().length > 0,
      `${label}: undetermined must carry a non-empty reason`,
    );
  }
}

// ---- fixtures --------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-foundation-contract-"));
const plainFile = path.join(tmp, "notes.txt");
fs.writeFileSync(plainFile, "hello\n");
const aliasTarget = path.join(tmp, "handler-dir");
fs.mkdirSync(aliasTarget);
const aliasLink = path.join(tmp, "handler-alias");
fs.symlinkSync(aliasTarget, aliasLink);

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- the shape guard itself: BOTH directions ------------------------------

test("isProviderResult passes well-formed results and rejects malformed ones", () => {
  const okFact = contract.determinedFacts({ a: 1 });
  const okEffects = contract.determinedEffects([]);
  const okUndetermined = contract.undeterminedFacts(contract.missingFactReason("x"), {}, []);
  for (const ok of [okFact, okEffects, okUndetermined]) {
    assert.equal(isProviderResult(ok), true);
  }

  // Negative controls — each malformed shape MUST be rejected, and each
  // rejection is a different failure mode (a guard that only returned true
  // would be no evidence at all).
  const rejections = [
    { verdict: "determined", facts: {}, reason: "why" }, // determined with a reason
    { verdict: "undetermined", facts: {}, reason: "" }, // empty reason
    { verdict: "undetermined", facts: [], reason: "x" }, // facts as array
    { verdict: "determined" }, // no facts/effects at all
    { verdict: "determined", facts: {}, effects: [] }, // both at once
    {
      verdict: "determined",
      effects: [{ seq: 1, kind: "write-bytes", from: null, to: null, bytes: {} }], // null endpoints
    },
    {
      verdict: "determined",
      // unknown endpoint under a DETERMINED verdict — the half-described move
      effects: [
        {
          seq: 1,
          kind: "write-bytes",
          from: { kind: "argv", value: "x" },
          to: { kind: "unknown", value: null },
          bytes: { observed: null, prospective: null, basis: "unknown" },
        },
      ],
    },
    {
      verdict: "determined",
      // seq drift — order is assigned by effectList, never hand-set
      effects: [
        {
          seq: 2,
          kind: "delete",
          from: { kind: "path", value: "/x" },
          to: null,
          bytes: { observed: null, prospective: null, basis: "unknown" },
        },
      ],
    },
  ];
  for (const bad of rejections) {
    assert.equal(
      isProviderResult(bad),
      false,
      `malformed result wrongly accepted: ${JSON.stringify(bad)}`,
    );
  }
});

// ---- shell-effects ---------------------------------------------------------

test("shell-effects: present fact (plain read) yields determined", () => {
  const r = effectsForShellCommand("cat notes.txt");
  assertProvider(r, "shell-effects/cat");
  assert.equal(r.verdict, "determined");
  assert.equal(r.effects.length, 1);
  assert.deepEqual(r.effects[0], {
    seq: 1,
    kind: effectsModel.EFFECT_KINDS.READ_BYTES,
    from: { kind: "path", value: "notes.txt" },
    to: { kind: "process", value: "process" },
    bytes: { observed: null, prospective: null, basis: "unknown" },
  });

  const cp = effectsForShellCommand("cp a.txt b.txt");
  assertProvider(cp, "shell-effects/cp");
  assert.equal(cp.verdict, "determined");
  assert.deepEqual(
    cp.effects.map((e) => [e.seq, e.kind]),
    [
      [1, "read-bytes"],
      [2, "write-bytes"],
    ],
  );
  assert.deepEqual(cp.effects[1].from, { kind: "path", value: "a.txt" });
  assert.deepEqual(cp.effects[1].to, { kind: "path", value: "b.txt" });
});

test("shell-effects: absent fact (executor script body) yields BOUNDED undetermined", () => {
  const r = effectsForShellCommand("bash script.sh");
  assertProvider(r, "shell-effects/executor");
  assert.equal(r.verdict, "undetermined");
  // Bounded: the effects that ARE established travel with the verdict, in
  // order — read-bytes split from load-and-execute.
  assert.deepEqual(
    r.effects.map((e) => [e.seq, e.kind]),
    [
      [1, "read-bytes"],
      [2, "load-and-execute"],
    ],
  );
  assert.deepEqual(r.unresolved, [{ span: "script.sh", reason: "script body unresolved" }]);

  // Dynamic expansion is undetermined too, with the span named.
  const dyn = effectsForShellCommand("echo $(date)");
  assertProvider(dyn, "shell-effects/dynamic");
  assert.equal(dyn.verdict, "undetermined");
  assert.deepEqual(dyn.unresolved, [{ span: "$(date)", reason: "command substitution" }]);

  // An unmapped command is NOT assumed effect-free.
  const unknown = effectsForShellCommand("frobnicate x");
  assertProvider(unknown, "shell-effects/unknown");
  assert.equal(unknown.verdict, "undetermined");
  assert.equal(unknown.effects.length, 0);
});

test("shell-effects: missing command fact yields undetermined naming it", () => {
  const r = effectsForShellCommand("");
  assertProvider(r, "shell-effects/empty");
  assert.equal(r.verdict, "undetermined");
  assert.ok(r.reason.startsWith(MISSING_FACT_PREFIX));
});

// ---- tool-effects ----------------------------------------------------------

test("tool-effects: present fact (Write with content) yields determined", () => {
  const r = effectsForToolCall("Write", { file_path: "/tmp/x.txt", content: "abc" });
  assertProvider(r, "tool-effects/Write");
  assert.equal(r.verdict, "determined");
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].kind, "write-bytes");
  assert.deepEqual(r.effects[0].to, { kind: "path", value: "/tmp/x.txt" });
  assert.equal(r.effects[0].bytes.prospective, 3);
  assert.equal(r.effects[0].bytes.basis, "derived");

  // Bash delegates to the SAME effect model.
  const bash = effectsForToolCall("Bash", { command: "cat a.txt" });
  assertProvider(bash, "tool-effects/Bash");
  assert.equal(bash.verdict, "determined");
  assert.equal(bash.effects[0].kind, "read-bytes");
});

test("tool-effects: absent fact (Write without content) yields undetermined", () => {
  const r = effectsForToolCall("Write", { file_path: "/tmp/x.txt" });
  assertProvider(r, "tool-effects/Write-missing");
  assert.equal(r.verdict, "undetermined");
  assert.ok(r.reason.startsWith(MISSING_FACT_PREFIX));

  // An unmapped tool must not read as effect-free.
  const unknown = effectsForToolCall("Frobnicate", { file_path: "/tmp/x.txt" });
  assertProvider(unknown, "tool-effects/unknown");
  assert.equal(unknown.verdict, "undetermined");
  assert.equal(unknown.effects.length, 0);

  // apply_patch: destinations unparsed -> unknown endpoint forces undetermined.
  const patch = effectsForToolCall("apply_patch", { command: "*** Begin Patch\n*** End Patch" });
  assertProvider(patch, "tool-effects/apply_patch");
  assert.equal(patch.verdict, "undetermined");
  assert.equal(patch.effects[0].to.kind, "unknown");
});

// ---- target-identity -------------------------------------------------------

test("target-identity: present facts (plain file + registry consulted) yields determined", () => {
  const r = targetIdentity(plainFile, { aliasRegistry: [] });
  assertProvider(r, "target-identity/plain");
  assert.equal(r.verdict, "determined");
  assert.equal(r.facts.exists, true);
  assert.equal(r.facts.symlink, false);
  assert.equal(r.facts.canonical, fs.realpathSync(plainFile));
  assert.equal(r.facts.alias.registered, false);
});

test("target-identity: absent fact (registry unavailable) yields undetermined, never false", () => {
  const r = targetIdentity(plainFile, {});
  assertProvider(r, "target-identity/no-registry");
  assert.equal(r.verdict, "undetermined");
  assert.ok(r.reason.startsWith(MISSING_FACT_PREFIX));
  // THE trap: an unavailable registry is NOT "not registered".
  assert.equal(r.facts.alias.registered, null);
  assert.notEqual(r.facts.alias.registered, false);
});

test("target-identity: registered external-handler alias is a separate, positive fact", () => {
  const registry = [{ path: aliasLink, handler: "ext-handler", registry: "test-registry" }];
  const r = targetIdentity(aliasLink, { aliasRegistry: registry });
  assertProvider(r, "target-identity/alias");
  assert.equal(r.verdict, "determined");
  assert.equal(r.facts.symlink, true);
  assert.equal(r.facts.alias.registered, true);
  assert.equal(r.facts.alias.handler, "ext-handler");
  assert.equal(r.facts.canonical, fs.realpathSync(aliasTarget));

  // The SAME symlink with a consulted-but-empty registry is a different,
  // determined fact (unregistered link) — L3 denies it; L1 reports it.
  const unregistered = targetIdentity(aliasLink, { aliasRegistry: [] });
  assertProvider(unregistered, "target-identity/unregistered");
  assert.equal(unregistered.verdict, "determined");
  assert.equal(unregistered.facts.symlink, true);
  assert.equal(unregistered.facts.alias.registered, false);
});

test("target-identity: non-existent write target resolves through its parent", () => {
  const dst = path.join(tmp, "not-yet-created.txt");
  const r = targetIdentity(dst, { aliasRegistry: [] });
  assertProvider(r, "target-identity/new");
  assert.equal(r.verdict, "determined");
  assert.equal(r.facts.exists, false);
  assert.equal(r.facts.canonical, path.join(fs.realpathSync(tmp), "not-yet-created.txt"));
});

// ---- repo-facts ------------------------------------------------------------

test("repo-facts: repoIdentity determined on present facts, undetermined on absent", () => {
  const ok = repoIdentity({ repoRoot: tmp, isWorkTree: true, trunk: "main" });
  assertProvider(ok, "repo-facts/repoIdentity");
  assert.equal(ok.verdict, "determined");

  const missingRoot = repoIdentity({});
  assertProvider(missingRoot, "repo-facts/repoIdentity-missing");
  assert.equal(missingRoot.verdict, "undetermined");
  assert.ok(missingRoot.reason.startsWith(MISSING_FACT_PREFIX));

  // Absence is NOT false: repoRoot present but isWorkTree absent is still
  // undetermined (never `isWorkTree: false`).
  const missingFlag = repoIdentity({ repoRoot: tmp, trunk: "main" });
  assertProvider(missingFlag, "repo-facts/repoIdentity-noflag");
  assert.equal(missingFlag.verdict, "undetermined");
  assert.ok(missingFlag.reason.startsWith(MISSING_FACT_PREFIX));
});

test("repo-facts: consumerTree determined on a supplied set, undetermined without (never the walker)", () => {
  const ok = consumerTree({ repoRoot: tmp, consumers: [{ path: "a", kind: "hook-config" }] });
  assertProvider(ok, "repo-facts/consumerTree");
  assert.equal(ok.verdict, "determined");

  const missing = consumerTree({ repoRoot: tmp });
  assertProvider(missing, "repo-facts/consumerTree-missing");
  assert.equal(missing.verdict, "undetermined");
  assert.ok(missing.reason.startsWith(MISSING_FACT_PREFIX));
});

test("repo-facts: gitEnv is THE house gitEnv — the same function, not a second builder", () => {
  const house = require(path.join(GF, "..", "git-subprocess-env.js"));
  assert.equal(typeof gitEnv, "function");
  assert.equal(
    gitEnv,
    house.gitEnv,
    "guard-foundation must re-export the house gitEnv, not build its own",
  );
});

// ---- identity --------------------------------------------------------------

test("identity: operatorIdentity determined on present fact, undetermined on absent", () => {
  const ok = operatorIdentity({ operator: "test-operator" });
  assertProvider(ok, "identity/operatorIdentity");
  assert.equal(ok.verdict, "determined");
  assert.equal(ok.facts.operator, "test-operator");

  const missing = operatorIdentity({});
  assertProvider(missing, "identity/operatorIdentity-missing");
  assert.equal(missing.verdict, "undetermined");
  assert.ok(missing.reason.startsWith(MISSING_FACT_PREFIX));
});

test("identity: operatorRepoBinding requires BOTH halves", () => {
  const full = operatorRepoBinding({
    operator: "test-operator",
    repoRoot: tmp,
    isWorkTree: true,
    trunk: "main",
  });
  assertProvider(full, "identity/binding-full");
  assert.equal(full.verdict, "determined");

  const half = operatorRepoBinding({ operator: "test-operator" });
  assertProvider(half, "identity/binding-half");
  assert.equal(half.verdict, "undetermined");
  // The established half travels with the verdict (bounded partial).
  assert.equal(half.facts.operator.operator, "test-operator");
  assert.ok(half.unresolved.some((u) => u.reason.includes("repo identity unresolved")));
});
