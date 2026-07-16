/**
 * roster-schema-validate — vendored JSON-Schema-subset validator for
 * .claude/operators.roster.json (shard A0b-1).
 *
 * Architecture refs (workspaces/multi-operator-coc/02-plans/01-architecture.md):
 *   §2.1 — person_id / verified_id / display_id
 *   §2.3 — signing substrate (roster file shape, host_role:ci audit-only)
 *
 * The 3 invariants this module supports:
 *   1. Roster JSON schema (genesis + persons, additionalProperties: false).
 *   2. Validation feeds the /whoami --register PR-flow round-trip test —
 *      a proposed edit MUST validate against this schema before push.
 *   3. host_role:ci is a VALID declared value (enum {human, ci});
 *      eligibility enforcement (R5-S-04) is shard A0b-2c, not here.
 *
 * Why a vendored validator instead of `ajv` (the npm-canonical choice):
 *   - loom has no top-level package.json; pulling ajv would require one
 *     and a 200kb node_modules dep just for one schema.
 *   - rules/dependencies.md "Own the Stack" — re-implement when the
 *     surface is narrow and the dep would constrain architecture.
 *   - sibling .claude/hooks/lib/*.js are all CommonJS, zero-dep — this
 *     module matches the convention.
 *
 * What this validator supports (only what the operators-roster schema
 * uses; intentionally narrow):
 *   - type: "object" | "array" | "string" | "integer" | "boolean"
 *   - required: [...]
 *   - properties: {...}
 *   - additionalProperties: false (default-allow if absent)
 *   - patternProperties via additionalProperties on object types
 *     (used for `persons.<person_id>: { ... }`)
 *   - enum: [...]
 *   - minLength / minProperties / minItems / minimum
 *   - pattern (string regex)
 *   - items (array element schema)
 *
 * What it does NOT support (intentional — not needed by this schema):
 *   - $ref / $defs (the schema is monolithic by choice)
 *   - oneOf / anyOf / allOf
 *   - dependencies / if/then/else
 *   - format keyword (we use pattern instead)
 *
 * Output contract:
 *   validate(roster) => { valid: boolean, errors: string[] }
 *
 * Errors are human-readable strings naming the failed JSON-pointer-ish
 * path and the violation. Callers (the test file, the /whoami command
 * implementation) consume errors as a flat list — no nesting.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "operators.roster.schema.json",
);

// F71: canonical $id the loaded schema MUST self-identify with.
// Defense-in-depth against a planted-schema attack vector — F67's
// integrity-guard.js DIRECT set blocks unauthorized local file writes
// to the schema path; this $id check is the runtime/in-memory sibling:
// even if a test environment or future refactor introduces a
// schema-loader path that bypasses integrity-guard (e.g. a fixture
// schema injected via require.cache or a path override), the $id
// mismatch surfaces loudly. Per journal/0162 § F71 acceptance.
const EXPECTED_SCHEMA_ID =
  "https://terrene.foundation/schemas/operators.roster.schema.json";

let _schemaCache = null;
function loadSchema() {
  if (_schemaCache !== null) return _schemaCache;
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(
      `roster-schema-validate: schema not found at ${SCHEMA_PATH}`,
    );
  }
  const raw = fs.readFileSync(SCHEMA_PATH, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `roster-schema-validate: schema is not valid JSON: ${err.message}`,
    );
  }
  // F71: $id self-identification check. Throws BEFORE cache so a
  // planted schema cannot poison the cache for downstream consumers.
  if (parsed.$id !== EXPECTED_SCHEMA_ID) {
    throw new Error(
      `roster-schema-validate: schema $id mismatch — expected "${EXPECTED_SCHEMA_ID}", got "${parsed.$id}" (F71 planted-schema defense-in-depth)`,
    );
  }
  _schemaCache = parsed;
  return _schemaCache;
}

function _typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function _validate(value, schema, pathBreadcrumb, errors) {
  if (schema.type) {
    const actual = _typeOf(value);
    // JSON Schema: "integer" subsumes a finite integer; "number" subsumes both.
    let ok;
    if (schema.type === "integer") {
      ok = actual === "integer";
    } else if (schema.type === "number") {
      ok = actual === "integer" || actual === "number";
    } else {
      ok = actual === schema.type;
    }
    if (!ok) {
      errors.push(
        `${pathBreadcrumb}: expected type ${schema.type}, got ${actual}`,
      );
      return; // type mismatch cascades — further checks meaningless
    }
  }

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `${pathBreadcrumb}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`,
      );
    }
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      errors.push(
        `${pathBreadcrumb}: string shorter than minLength ${schema.minLength}`,
      );
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(
          `${pathBreadcrumb}: string does not match pattern ${schema.pattern}`,
        );
      }
    }
  }

  if (Number.isFinite(value) && typeof schema.minimum === "number") {
    if (value < schema.minimum) {
      errors.push(
        `${pathBreadcrumb}: value ${value} less than minimum ${schema.minimum}`,
      );
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(
        `${pathBreadcrumb}: array shorter than minItems ${schema.minItems}`,
      );
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        _validate(value[i], schema.items, `${pathBreadcrumb}[${i}]`, errors);
      }
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);

    if (
      typeof schema.minProperties === "number" &&
      keys.length < schema.minProperties
    ) {
      errors.push(
        `${pathBreadcrumb}: object has ${keys.length} properties, minimum ${schema.minProperties}`,
      );
    }

    // LOW-5 (M0 security review): propertyNames pattern enforcement.
    // Rejects __proto__ / constructor / prototype-pollution-style keys
    // and any control-character / path-traversal artifact in person_id
    // map keys.
    if (schema.propertyNames && schema.propertyNames.pattern) {
      const re = new RegExp(schema.propertyNames.pattern);
      for (const k of keys) {
        if (!re.test(k)) {
          errors.push(
            `${pathBreadcrumb}: property name '${k}' does not match propertyNames.pattern ${schema.propertyNames.pattern}`,
          );
        }
      }
    }

    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, req)) {
          errors.push(`${pathBreadcrumb}: missing required property '${req}'`);
        }
      }
    }

    const propsSchema = schema.properties || {};
    const additionalAllowed =
      schema.additionalProperties === undefined
        ? true
        : schema.additionalProperties;

    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(propsSchema, k)) {
        _validate(value[k], propsSchema[k], `${pathBreadcrumb}.${k}`, errors);
      } else if (additionalAllowed === false) {
        errors.push(
          `${pathBreadcrumb}: unknown property '${k}' (additionalProperties: false)`,
        );
      } else if (additionalAllowed && typeof additionalAllowed === "object") {
        // patternProperties-equivalent: every additional key is validated
        // against the additionalProperties schema. This is how the
        // `persons.<person_id>` map is enforced.
        _validate(
          value[k],
          additionalAllowed,
          `${pathBreadcrumb}.${k}`,
          errors,
        );
      }
      // else: additionalProperties:true (default) — accept silently.
    }
  }
}

/**
 * GPG fingerprints MUST be uppercase 40-hex (#372). `gpg --with-colons`
 * emits this canonical form, and operator-id.js::_parseGpgColonFingerprint
 * preserves it; resolution then compares case-sensitively against the
 * roster (operator-id.js::_findPersonByFingerprint). A hand-authored
 * lowercase (or non-40-hex) GPG fingerprint would never match at
 * resolution and would SILENTLY fall to L2_SUPERVISED. This assert makes
 * that malformed entry fail LOUD at the validation gate (the
 * /whoami --register PR round-trip hard-stops on `valid:false`) instead.
 *
 * This is a load-time CODE assert, not a JSON-Schema `pattern`, because:
 *   (a) the constraint is conditional on `type === "gpg"` and this vendored
 *       validator intentionally does NOT support if/then (see header), and
 *   (b) a `pattern` on the shared `fingerprint` field would wrongly reject
 *       SSH `SHA256:base64` fingerprints, which are case-sensitive.
 * GPG-path only; the shared compare in operator-id.js is untouched.
 */
const GPG_FINGERPRINT_RE = /^[0-9A-F]{40}$/;

function _validateGpgFingerprints(roster, errors) {
  const persons = roster && roster.persons;
  if (!persons || typeof persons !== "object" || Array.isArray(persons)) return;
  for (const personId of Object.keys(persons)) {
    const person = persons[personId];
    if (!person || !Array.isArray(person.keys)) continue; // shape errors already flagged by _validate
    person.keys.forEach((key, i) => {
      if (!key || typeof key !== "object" || key.type !== "gpg") return;
      if (typeof key.fingerprint !== "string") return; // type/required errors already flagged
      if (!GPG_FINGERPRINT_RE.test(key.fingerprint)) {
        errors.push(
          `$.persons.${personId}.keys[${i}].fingerprint: GPG fingerprint must be uppercase 40-hex (^[0-9A-F]{40}$), got ${JSON.stringify(key.fingerprint)}`,
        );
      }
    });
  }
}

/**
 * #583 Shard 1: GPG-fingerprint uppercase-40-hex assert for trust_anchors,
 * conditional on anchor.type == "gpg" — the same constraint _validateGpgFingerprints
 * enforces for persons[].keys[], applied to the non-person broker trust-anchor.
 * The vendored validator cannot express a type-conditional pattern (see header),
 * so it is a load-time CODE assert. A lowercase / non-40-hex GPG anchor fingerprint
 * would silently fail broker-sig verification at the Shard-2 fold predicate; this
 * surfaces it LOUD at the /whoami --register validation gate naming the exact index.
 */
function _validateTrustAnchorFingerprints(roster, errors) {
  const anchors = roster && roster.trust_anchors;
  if (!Array.isArray(anchors)) return; // absent or shape errors already flagged by _validate
  anchors.forEach((anchor, i) => {
    if (!anchor || typeof anchor !== "object" || anchor.type !== "gpg") return;
    if (typeof anchor.fingerprint !== "string") return; // type/required errors already flagged
    if (!GPG_FINGERPRINT_RE.test(anchor.fingerprint)) {
      errors.push(
        `$.trust_anchors[${i}].fingerprint: GPG fingerprint must be uppercase 40-hex (^[0-9A-F]{40}$), got ${JSON.stringify(anchor.fingerprint)}`,
      );
    }
  });
}

/**
 * Provider-conditional identity binding (Azure DevOps port). The vendored
 * validator does NOT support if/then (see header), so the
 * provider-dependent "which identity field is required" constraint is a
 * load-time CODE assert, exactly like _validateGpgFingerprints (#372).
 *
 * `genesis.provider` (absent ⇒ "github") decides the binding:
 *   - github  → every enrolled (non-PLACEHOLDER) person MUST carry a
 *               non-empty `github_login` (relaxed from JSON-Schema `required`
 *               so an azure-devops roster need not carry it).
 *   - azure-devops → `genesis.ado_project` MUST be present, AND every
 *               enrolled person MUST carry a non-empty `principal` (Entra UPN).
 *
 * Why fail LOUD here rather than at resolution: a github roster missing
 * `github_login` (or an ADO roster missing `principal`) would silently fail
 * owner-bind at the genesis ceremony / fold — the trust root never
 * establishes and every downstream guard hard-blocks with an opaque reason.
 * Surfacing it at the /whoami --register validation gate names the exact
 * field + person_id.
 */
function _validateProviderIdentity(roster, errors) {
  const genesis = roster && roster.genesis;
  if (!genesis || typeof genesis !== "object") return; // shape errors already flagged
  const provider =
    typeof genesis.provider === "string" && genesis.provider
      ? genesis.provider
      : "github";
  const persons = roster.persons;
  if (!persons || typeof persons !== "object" || Array.isArray(persons)) return;

  if (provider === "azure-devops") {
    if (typeof genesis.ado_project !== "string" || !genesis.ado_project) {
      errors.push(
        `$.genesis.ado_project: required when genesis.provider == "azure-devops" (the ADO project ref the coordination repo lives under)`,
      );
    }
  }

  for (const personId of Object.keys(persons)) {
    if (isUnenrolled(personId)) continue; // PLACEHOLDER- reserved, not yet bound
    const person = persons[personId];
    if (!person || typeof person !== "object") continue; // shape errors already flagged
    if (provider === "azure-devops") {
      if (typeof person.principal !== "string" || !person.principal) {
        errors.push(
          `$.persons.${personId}.principal: required when genesis.provider == "azure-devops" (Entra UPN binding; the ADO analogue of github_login)`,
        );
      }
    } else {
      if (typeof person.github_login !== "string" || !person.github_login) {
        errors.push(
          `$.persons.${personId}.github_login: required when genesis.provider is github/absent`,
        );
      }
    }
  }
}

/**
 * Validate a roster object against the operators-roster JSON Schema.
 *
 * @param {object} roster — parsed JSON content of operators.roster.json
 * @returns {{valid: boolean, errors: string[]}}
 *   valid is false iff ≥1 error; errors is always an array (possibly empty).
 */
function validate(roster) {
  const errors = [];
  let schema;
  try {
    schema = loadSchema();
  } catch (err) {
    return { valid: false, errors: [err.message] };
  }
  if (roster === null || typeof roster !== "object" || Array.isArray(roster)) {
    return {
      valid: false,
      errors: [`$: expected object, got ${_typeOf(roster)}`],
    };
  }
  _validate(roster, schema, "$", errors);
  // #372: GPG-fingerprint uppercase-40-hex assert (conditional on key.type,
  // which the vendored validator cannot express as a JSON-Schema pattern).
  _validateGpgFingerprints(roster, errors);
  // #583 Shard 1: same uppercase-40-hex GPG assert for the broker trust-anchor,
  // conditional on anchor.type == "gpg" (not a JSON-Schema constraint).
  _validateTrustAnchorFingerprints(roster, errors);
  // Azure DevOps port: provider-conditional identity binding (github_login vs
  // principal), also conditional and thus not a JSON-Schema constraint.
  _validateProviderIdentity(roster, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * LOW-4 (M0 security review): shared predicate for the PLACEHOLDER-
 * convention. Architecture §2.1 + .claude/operators.roster.README.md
 * declares any person_id beginning with `PLACEHOLDER-` is unenrolled —
 * reserved-but-not-yet-verified. The convention was open-coded across
 * fold-genesis-anchor.js, derive-n.js, recovery-fallback.js,
 * genesis-ceremony.js (`startsWith("PLACEHOLDER-")`). This helper is
 * the single source of truth — downstream consumers MUST route through
 * this function instead of re-implementing the startsWith check.
 *
 * @param {string} personId - the person_id (or any string under
 *   inspection); non-strings return false (defensive).
 * @returns {boolean} true iff the personId is unenrolled per the
 *   PLACEHOLDER- prefix convention.
 */
function isUnenrolled(personId) {
  return typeof personId === "string" && personId.startsWith("PLACEHOLDER-");
}

module.exports = {
  validate,
  isUnenrolled,
  // Exposed for tests + downstream tools; not for general consumption.
  _internal: { loadSchema },
};
