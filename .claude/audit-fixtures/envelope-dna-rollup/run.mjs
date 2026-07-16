#!/usr/bin/env node
/*
 * Audit-fixture runner for validate-envelope-dna.mjs (#411 Wave 1 Shard 1b).
 *
 * Structural probe per `probe-driven-verification.md` MUST-3: the pure
 * validateEnvelope() predicate is run over a committed public-authority toy
 * cascade (valid-iso-gdpr-toy.json) AND a per-predicate battery of single-mutation
 * variants; each case's { valid, error-code } is compared to its declared
 * expectation. NO semantic judgment, NO regex on prose.
 *
 * One case per scope-restriction predicate per `cc-artifacts.md` Rule 9:
 *   valid-base                        → valid   (the reference toy cascade)
 *   broken-trace                      → invalid BROKEN_TRACE            (invariant 1)
 *   forward-materialization-mismatch  → invalid FORWARD_MATERIALIZATION_MISMATCH (inv 1 chain)
 *   forward-index-incomplete          → invalid FORWARD_INDEX_INCOMPLETE (invariant 1 completeness)
 *   forward-index-phantom             → invalid FORWARD_INDEX_PHANTOM   (invariant 1 phantom)
 *   missing-forward-index             → invalid MISSING_FORWARD_INDEX   (invariant 1 required)
 *   reverse-index-incomplete          → invalid REVERSE_INDEX_INCOMPLETE (invariant 2)
 *   reverse-index-phantom             → invalid REVERSE_INDEX_PHANTOM   (invariant 2, phantom article)
 *   reverse-phantom-member            → invalid REVERSE_INDEX_PHANTOM   (invariant 2, phantom member)
 *   reverse-index-duplicate           → invalid REVERSE_INDEX_DUPLICATE (invariant 2, duplicate member)
 *   missing-reverse-index             → invalid MISSING_REVERSE_INDEX   (invariant 2)
 *   non-string-id                     → invalid NON_STRING_ID           (cascade id string contract)
 *   tenant-token                      → invalid TENANT_TOKEN_PRESENT    (invariant 3 value, synthetic denylist)
 *   tenant-token-in-key               → invalid TENANT_TOKEN_PRESENT    (invariant 3 KEY, synthetic denylist)
 *   coarsened-granularity             → invalid NON_MAX_ACCOUNTABLE_GRANULARITY (invariant 4)
 *   unknown-binding-kind              → invalid UNKNOWN_BINDING_KIND    (vocab allowlist)
 *   schema-version-mismatch           → invalid SCHEMA_VERSION_MISMATCH
 *
 * Invariant 3 uses a SYNTHETIC tenant-token regex (matching "acmetenant") so the
 * case is deterministic and independent of the real loom-only denylist.
 *
 * Exit 0 = all cases pass. Exit 1 = >=1 mismatch.
 */
import { validateEnvelope } from "../../bin/validate-envelope-dna.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(readFileSync(join(here, "valid-iso-gdpr-toy.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(BASE));

// Synthetic tenant-token regex — a case-insensitive alternation over a made-up
// customer token, independent of the real denylist (which the fixtures never touch).
const SYNTH_TENANT_RE = /(acmetenant)/gi;

const cases = [
  { label: "valid-base", mutate: (e) => e, valid: true, code: null },
  {
    label: "broken-trace",
    mutate: (e) => {
      e.cascade.constraints[0].framework_control = "FC-does-not-exist";
      return e;
    },
    valid: false,
    code: "BROKEN_TRACE",
  },
  {
    label: "forward-materialization-mismatch",
    mutate: (e) => {
      e.rollup.forward["C-secret-env-only"] = ["FC-secret-env", "SC-crypto-policy", "GDPR-Art32"]; // wrong article
      return e;
    },
    valid: false,
    code: "FORWARD_MATERIALIZATION_MISMATCH",
  },
  {
    label: "reverse-index-incomplete",
    mutate: (e) => {
      e.rollup.reverse["A.8.24"] = []; // drops the bound constraint
      return e;
    },
    valid: false,
    code: "REVERSE_INDEX_INCOMPLETE",
  },
  {
    label: "reverse-index-phantom",
    mutate: (e) => {
      e.rollup.reverse["A.99.99"] = ["C-secret-env-only"]; // article no constraint traces to
      return e;
    },
    valid: false,
    code: "REVERSE_INDEX_PHANTOM",
  },
  {
    label: "missing-reverse-index",
    mutate: (e) => {
      delete e.rollup.reverse;
      return e;
    },
    valid: false,
    code: "MISSING_REVERSE_INDEX",
  },
  {
    label: "reverse-index-duplicate",
    mutate: (e) => {
      const art = Object.keys(e.rollup.reverse)[0];
      e.rollup.reverse[art] = [...new Set(e.rollup.reverse[art])]; // ensure a clean base
      e.rollup.reverse[art].push(e.rollup.reverse[art][0]); // duplicate a real member
      return e;
    },
    valid: false,
    code: "REVERSE_INDEX_DUPLICATE",
  },
  {
    label: "non-string-id",
    mutate: (e) => {
      e.cascade.regulation_articles[0].id = 42; // numeric id — cascade ids MUST be strings
      return e;
    },
    valid: false,
    code: "NON_STRING_ID",
  },
  {
    label: "forward-index-incomplete",
    mutate: (e) => {
      delete e.rollup.forward["C-db-tls-required"]; // resolvable constraint missing from forward map
      return e;
    },
    valid: false,
    code: "FORWARD_INDEX_INCOMPLETE",
  },
  {
    label: "forward-index-phantom",
    mutate: (e) => {
      e.rollup.forward["C-ghost-constraint"] = ["FC-secret-env", "SC-crypto-policy", "A.8.24"]; // key no constraint resolves to
      return e;
    },
    valid: false,
    code: "FORWARD_INDEX_PHANTOM",
  },
  {
    label: "missing-forward-index",
    mutate: (e) => {
      delete e.rollup.forward;
      return e;
    },
    valid: false,
    code: "MISSING_FORWARD_INDEX",
  },
  {
    label: "reverse-phantom-member",
    mutate: (e) => {
      e.rollup.reverse["A.8.24"].push("C-db-tls-required"); // extra member under a real article (it traces to GDPR-Art32)
      return e;
    },
    valid: false,
    code: "REVERSE_INDEX_PHANTOM",
  },
  {
    label: "tenant-token-in-key",
    mutate: (e) => {
      e.cascade.constraints[0].envelope_binding.AcmeTenant_meta = "internal"; // token in an object KEY, not a value
      return e;
    },
    valid: false,
    code: "TENANT_TOKEN_PRESENT",
  },
  {
    label: "tenant-token",
    mutate: (e) => {
      e.cascade.framework_controls[0].title = "AcmeTenant internal secret handling"; // leaked tenant name
      return e;
    },
    valid: false,
    code: "TENANT_TOKEN_PRESENT",
  },
  {
    label: "coarsened-granularity",
    mutate: (e) => {
      e.cascade.constraints[0].attribution_granularity = "per-role"; // coarsened in a canon envelope
      return e;
    },
    valid: false,
    code: "NON_MAX_ACCOUNTABLE_GRANULARITY",
  },
  {
    label: "unknown-binding-kind",
    mutate: (e) => {
      e.cascade.constraints[0].envelope_binding.kind = "arbitrary_new_kind"; // not in allowlist
      return e;
    },
    valid: false,
    code: "UNKNOWN_BINDING_KIND",
  },
  {
    label: "schema-version-mismatch",
    mutate: (e) => {
      e.schema_version = "envelope-dna/v2";
      return e;
    },
    valid: false,
    code: "SCHEMA_VERSION_MISMATCH",
  },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const env = c.mutate(clone());
  const res = validateEnvelope(env, { tenantTokenRe: SYNTH_TENANT_RE });
  const okValid = res.valid === c.valid;
  const okCode = c.code === null ? res.errors.length === 0 : res.errors.some((e) => e.code === c.code);
  if (okValid && okCode) {
    passed++;
    process.stdout.write(`  PASS  ${c.label} → valid=${res.valid}${c.code ? ` [${c.code}]` : ""}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${c.label}: expected valid=${c.valid} code=${c.code}, got valid=${res.valid} codes=${JSON.stringify(res.errors.map((e) => e.code))}\n`);
  }
}

process.stdout.write(`\nenvelope-dna-rollup fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
