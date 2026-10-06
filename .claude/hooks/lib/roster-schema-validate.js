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

const path = require("path");

// The hardened reader, for the same reason `roster-write.js` and
// `coc-roster-register.mjs` take it. `SCHEMA_PATH` below is the SAME file the register
// tool reads in its own `main()` — `.claude/operators.roster.schema.json` — so the actor
// who can plant a FIFO at that path reaches this read too, and this is the read that
// actually fires: `loadSchema()` is called from `validate()`, i.e. on the registration
// path, so a plain `readFileSync` here wedges the CLI even when the caller's own schema
// read is hardened. One open(2) flag set, shared (`security.md` § "Multi-Site Kwarg
// Plumbing").
const { readFileHardened } = require("./state-io.js");

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
  // Through `state-io.js::readFileHardened` (implemented by `state-io.js::_readFileHardened`). The `existsSync`
  // guard this replaces was not a substitute: `existsSync` returns TRUE for a planted
  // FIFO, and the `readFileSync` it guarded then BLOCKED FOREVER in open(2) with no
  // try/catch able to reach a hang. ABSENT keeps its own message below; everything else
  // — FIFO, symlink, directory, permissions — is UNREADABLE and says so, rather than
  // being reported as "not found".
  const read = readFileHardened(SCHEMA_PATH);
  if (!read.ok) {
    if (read.code === "ENOENT") {
      throw new Error(
        `roster-schema-validate: schema not found at ${SCHEMA_PATH}`,
      );
    }
    throw new Error(
      `roster-schema-validate: schema is not readable at ${SCHEMA_PATH}: ${read.reason}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(read.value.toString("utf8"));
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
    //
    // What this ACTUALLY rejects: leading-underscore keys (so `__proto__` as
    // an OWN key, `_foo`), keys not starting `[a-zA-Z0-9]`, and any character
    // outside `[a-zA-Z0-9._-]` — i.e. control characters and path-traversal
    // artifacts in person_id map keys.
    //
    // What it does NOT reject, MEASURED (S60): `constructor`, `prototype`,
    // `toString`, `hasOwnProperty` and every other non-underscore
    // Object.prototype member SATISFY the pattern and are ACCEPTED here. It
    // also cannot see a `__proto__` SETTER assignment at all, which creates
    // no own key for `Object.keys` to yield. Prototype-pollution refusal is
    // therefore NOT this pattern's job and never was — it belongs to
    // `_validateSafeMapKeys` below, which is structural (own-property-of-
    // Object.prototype) rather than a pattern, and to the own-key fences at
    // each consuming lookup. Do not read this pattern as a pollution defense.
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
 * S60: person_id map keys MUST be safe as JavaScript object keys.
 *
 * The JSON-Schema `propertyNames.pattern` on `persons` cannot enforce this,
 * for two INDEPENDENT and separately-measured reasons:
 *
 *   (a) `propertyNames` is evaluated by iterating `Object.keys(value)`
 *       (see _validate above). An assignment `persons["__proto__"] = {...}`
 *       invokes the Object.prototype `__proto__` SETTER — it replaces the
 *       map's PROTOTYPE and creates NO own key. `Object.keys` therefore
 *       never yields it, `propertyNames` has nothing to test, and the
 *       roster validates as though the edit never happened. The write then
 *       proceeds against an effectively UNMODIFIED roster: a registration
 *       that silently no-ops while reporting success.
 *
 *   (b) `constructor` and `prototype` DO create own keys and DO satisfy the
 *       pattern (leading alphanumeric, all alphanumeric), so they were
 *       accepted as ordinary person_ids. A person_id that shadows an
 *       Object.prototype member makes a bare `roster.persons[pid]` lookup
 *       resolve TRUTHY on rosters that do not contain it, handing consumers
 *       a non-person object (see the hardened own-key lookups in
 *       operator-gate.js::resolveRosterLogin, add-key-ceremony.js
 *       ::runAddKeyCeremony and genesis-anchor-guard.js::verifyRecord).
 *       NOTE: presence-proof-verify.js is NOT such a sibling — measured, its
 *       persons access is `Object.entries` and its `hasOwnProperty` guards
 *       are over a STATUS enum and a `statuses` map, not over persons.
 *
 * The predicate is STRUCTURAL, not a hand-maintained denylist: a key is
 * unsafe iff it is an own property of `Object.prototype` (which covers
 * `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__`,
 * `__defineGetter__`, …), plus `prototype` — the one reserved key that is
 * not an Object.prototype member but is still never a legitimate person_id.
 * A denylist would need editing every time the JS object model grows a
 * member; this cannot drift.
 *
 * Load-time CODE assert rather than a JSON-Schema constraint for the same
 * reason as _validateGpgFingerprints (#372): the vendored validator has no
 * way to express "not inherited from Object.prototype", and case (a) is not
 * expressible in JSON Schema at all.
 */
function _isUnsafeMapKey(k) {
  return Object.prototype.hasOwnProperty.call(Object.prototype, k) || k === "prototype";
}

function _validateSafeMapKeys(roster, errors) {
  const persons = roster && roster.persons;
  if (!persons || typeof persons !== "object" || Array.isArray(persons)) return;

  // Case (a): the map's prototype was replaced by a `__proto__` assignment.
  // A legitimate roster's persons map is a plain object (Object.prototype) or
  // a null-prototype object; anything else means the map was mutated through
  // the prototype setter and carries state Object.keys cannot see.
  const proto = Object.getPrototypeOf(persons);
  if (proto !== Object.prototype && proto !== null) {
    errors.push(
      "$.persons: prototype has been replaced — an assignment through the " +
        "`__proto__` setter mutated the persons map without creating an own " +
        "key. This is never a legitimate roster edit; the registration must " +
        "be refused rather than written.",
    );
  }

  // Case (b): own keys that shadow the JS object model.
  for (const k of Object.keys(persons)) {
    if (_isUnsafeMapKey(k)) {
      errors.push(
        `$.persons: property name '${k}' is not a safe object key — it ` +
          "shadows a JavaScript Object.prototype member, which makes a bare " +
          "`roster.persons[pid]` lookup resolve truthy on rosters that do " +
          "not contain it",
      );
    }
  }
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
 * IDENTITY-BINDING UNIQUENESS (loom#s49 — identity fragmentation at root).
 *
 * Architecture §2.1 defines `person_id` as "the unit of authority (one
 * `person_id` → one human)". Two ENROLLED person_ids sharing one identity
 * binding — `github_login` under the github provider, `principal` under
 * azure-devops — therefore makes the roster encode a FALSE FACT: one human
 * wearing N authority units.
 *
 * Measured consequence at canon loom (the originating incident): THREE
 * person_ids sharing one prefix all bound the SAME `github_login`. The
 * self-approval fence in operator-gate.js MUST-3 gates on person_id
 * DISTINCTNESS, so it blocked that split only BECAUSE all three happened to
 * share a login — coincidence, not design. One entry minted with a different
 * or absent login turns the same roster into a quorum defeat by one human.
 * Nothing at registration time refused the second or third mint.
 *
 * WHY THE CHECK IS DELTA-SCOPED, NOT A WHOLE-ROSTER INVARIANT
 * ───────────────────────────────────────────────────────────
 * `validate()` runs against the WHOLE roster and every consumer treats
 * `valid:false` as fail-closed. This module is a DISTRIBUTED artifact (it
 * ships to every consumer repo on the `hooks/**` sync glob), and #379 already
 * measured what a fail-closed roster load does downstream: "every commit fails
 * closed in consumer repos". A whole-roster hard error on shared bindings
 * would therefore BRICK every deployment whose roster already carries one —
 * including canon's — with no in-band repair path, because fixing it requires
 * a 2-of-N quorum roster edit that itself needs a loadable roster.
 *
 * So the BLOCKING check is scoped to the EDIT (old → new): it refuses to
 * introduce a NEW shared binding and grandfathers every pre-existing one.
 * Pre-existing fragmentation is surfaced instead as a NON-FATAL warning by
 * `identityBindingConflicts` (exposed on `validate().warnings`), which reports
 * without failing. Two surfaces, one control — `rules/security.md`
 * § Enforcement-Surface Parity.
 *
 * FAIL DIRECTION: a genuinely NEW operator carries a DIFFERENT login, so the
 * predicate is false by construction and they can never be locked out. The
 * only way to trip it is to re-bind an ALREADY-BOUND login, which is exactly
 * the defect. The refusal is LOUD and names its override — `same_human_as` —
 * so a deliberate second identity stays possible but becomes DURABLE and
 * machine-readable instead of implicit (`rules/hook-output-discipline.md`
 * MUST NOT § detectors that block work the agent was instructed to perform).
 */

const { loginsEqual } = require("./github-login.js");
const { principalsEqual } = require("./ado-login.js");

/**
 * Resolve the provider-dependent identity-binding field + its comparator.
 * GitHub logins and Entra UPNs are BOTH case-insensitive, so a bare `===`
 * would admit a sock-puppet via case mismatch (`Alice` vs `alice`) —
 * the exact threat `github-login.js::loginsEqual` and
 * `ado-login.js::principalsEqual` already exist to close. Reusing them is
 * also required by the structural sweep that BLOCKS bare `===` on
 * login-class fields outside those modules.
 *
 * @param {object} roster
 * @returns {{field: string, equals: (a:*, b:*) => boolean}}
 */
function _bindingFor(roster) {
  const genesis = (roster && roster.genesis) || {};
  const provider =
    typeof genesis.provider === "string" && genesis.provider
      ? genesis.provider
      : "github";
  return provider === "azure-devops"
    ? { field: "principal", equals: principalsEqual }
    : { field: "github_login", equals: loginsEqual };
}

/** Enrolled (non-PLACEHOLDER) person_ids, in stable key order. */
function _enrolledIds(roster) {
  const persons = (roster && roster.persons) || {};
  if (typeof persons !== "object" || Array.isArray(persons)) return [];
  return Object.keys(persons).filter(
    (pid) =>
      !isUnenrolled(pid) && persons[pid] && typeof persons[pid] === "object",
  );
}

/**
 * Report every ENROLLED person whose identity binding is ALSO bound by a
 * different enrolled person. PURE + NON-FATAL — this is the reporting half
 * of the control; `validateIdentityBindingEdit` is the blocking half.
 *
 * A group is `acknowledged` when the person carries `same_human_as` naming
 * one of the persons it collides with (referential integrity of that field
 * is asserted separately by `_validateSameHumanAsIntegrity`).
 *
 * @param {object} roster
 * @returns {Array<{person_id: string, binding_field: string, binding: string,
 *                  collides_with: string[], acknowledged: boolean}>}
 */
function identityBindingConflicts(roster) {
  const { field, equals } = _bindingFor(roster);
  const persons = (roster && roster.persons) || {};
  const ids = _enrolledIds(roster);
  const out = [];
  for (const pid of ids) {
    const binding = persons[pid][field];
    if (typeof binding !== "string" || !binding) continue; // _validateProviderIdentity owns absence
    const collides = ids.filter(
      (other) => other !== pid && equals(persons[other][field], binding),
    );
    if (collides.length === 0) continue;
    const ack = persons[pid].same_human_as;
    out.push({
      person_id: pid,
      binding_field: field,
      binding,
      collides_with: collides,
      acknowledged: typeof ack === "string" && collides.indexOf(ack) !== -1,
    });
  }
  return out;
}

/**
 * Referential integrity for `same_human_as`. Hard errors (folded into
 * `validate()`): the field is NEW, so no existing roster carries it and this
 * cannot retro-invalidate anything.
 *
 * The target MUST: exist, be enrolled, not be self, share the same binding,
 * and NOT itself carry `same_human_as`. The last condition makes the target
 * the CANONICAL ROOT of the identity cluster and makes cycles structurally
 * impossible (A→B→A cannot be built).
 */
function _validateSameHumanAsIntegrity(roster, errors) {
  const persons = (roster && roster.persons) || {};
  if (typeof persons !== "object" || Array.isArray(persons)) return;
  const { field, equals } = _bindingFor(roster);
  for (const pid of Object.keys(persons)) {
    const person = persons[pid];
    if (!person || typeof person !== "object") continue; // shape errors already flagged
    const target = person.same_human_as;
    if (target === undefined) continue;
    const at = `$.persons.${pid}.same_human_as`;
    if (typeof target !== "string" || !target) continue; // type errors already flagged by _validate
    if (target === pid) {
      errors.push(`${at}: must not reference itself (${JSON.stringify(pid)})`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(persons, target)) {
      errors.push(
        `${at}: references ${JSON.stringify(target)}, which is not a person_id in this roster`,
      );
      continue;
    }
    if (isUnenrolled(target)) {
      errors.push(
        `${at}: references ${JSON.stringify(target)}, which is unenrolled (PLACEHOLDER-); the acknowledged identity must be an enrolled person`,
      );
      continue;
    }
    if (!equals(persons[target][field], person[field])) {
      errors.push(
        `${at}: references ${JSON.stringify(target)}, whose ${field} (${JSON.stringify(persons[target][field])}) differs from this person's (${JSON.stringify(person[field])}); same_human_as declares a SHARED identity binding, so the two MUST match`,
      );
      continue;
    }
    if (typeof persons[target].same_human_as === "string") {
      errors.push(
        `${at}: references ${JSON.stringify(target)}, which itself carries same_human_as; point at the CANONICAL person_id of the cluster (the one with no same_human_as) so the linkage stays acyclic`,
      );
    }
  }
}

/**
 * THE REGISTRATION FENCE. Refuse a roster EDIT that newly binds an identity
 * (`github_login` / `principal`) already bound by a different enrolled
 * person, unless the entry declares `same_human_as`.
 *
 * Covers BOTH ways a new conflict can appear:
 *   (1) a person_id ADDED whose binding is already taken, and
 *   (2) an EXISTING person whose binding is MUTATED onto a taken one —
 *       without which the fence is bypassed by registering under a unique
 *       login and editing it afterwards.
 *
 * Pre-existing conflicts present in `oldRoster` are GRANDFATHERED: a pair is
 * only an error if it is not already a conflict in the old roster. Callers:
 * the `/whoami --register` ceremony (`.claude/commands/whoami.md` step 4),
 * before it writes the roster and opens the PR.
 *
 * @param {object} oldRoster — roster as it exists on the base branch
 * @param {object} newRoster — roster as proposed by the edit
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateIdentityBindingEdit(oldRoster, newRoster) {
  const errors = [];
  if (!newRoster || typeof newRoster !== "object") {
    return { valid: false, errors: ["$: newRoster must be an object"] };
  }
  const old =
    oldRoster && typeof oldRoster === "object" ? oldRoster : { persons: {} };
  const oldPersons =
    old.persons &&
    typeof old.persons === "object" &&
    !Array.isArray(old.persons)
      ? old.persons
      : {};
  const newPersons =
    newRoster.persons &&
    typeof newRoster.persons === "object" &&
    !Array.isArray(newRoster.persons)
      ? newRoster.persons
      : {};
  const { field, equals } = _bindingFor(newRoster);

  // Blame ONLY the entries THIS edit introduced or re-bound. A person whose
  // binding is untouched is never at fault for a conflict the edit created,
  // and naming it would point the operator at the wrong entry to fix.
  const changed = new Set(
    Object.keys(newPersons).filter((pid) => {
      const before = oldPersons[pid];
      if (!before) return true; // ADDED
      return !equals(before[field], newPersons[pid][field]); // RE-BOUND
    }),
  );

  for (const c of identityBindingConflicts(newRoster)) {
    if (c.acknowledged) continue;
    if (!changed.has(c.person_id)) continue; // untouched entry; grandfathered
    errors.push(
      `$.persons.${c.person_id}.${field}: ${JSON.stringify(c.binding)} is already bound by ${c.collides_with
        .map((x) => JSON.stringify(x))
        .join(
          ", ",
        )}. Architecture §2.1: one person_id → one human, so a second person_id on the same ` +
        `${field} makes the roster encode a false fact. If this IS a deliberate second identity for the SAME human, ` +
        `declare it: add "same_human_as": ${JSON.stringify(c.collides_with[0])} to $.persons.${c.person_id}. ` +
        `If it is a DIFFERENT human, they must register under their own ${field}.`,
    );
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a roster object against the operators-roster JSON Schema.
 *
 * @param {object} roster — parsed JSON content of operators.roster.json
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 *   valid is false iff ≥1 error; errors is always an array (possibly empty).
 *   `warnings` is ADDITIVE and NEVER affects `valid` — it carries
 *   non-fatal identity-fragmentation findings (shared bindings that predate
 *   this control). Existing callers destructure {valid, errors} and are
 *   unaffected.
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
  // S60: person_id map keys must be safe JS object keys. Catches both the
  // `__proto__` prototype-setter shape (invisible to propertyNames, which
  // iterates Object.keys) and the `constructor`/`prototype` shapes (which
  // satisfy propertyNames.pattern but shadow the JS object model).
  _validateSafeMapKeys(roster, errors);
  // loom#s49: referential integrity of the same_human_as acknowledgement.
  // HARD errors are safe here — the field is new, so no existing roster
  // carries it and this cannot retro-invalidate a live deployment.
  _validateSameHumanAsIntegrity(roster, errors);

  // NON-FATAL identity-fragmentation report. Deliberately NOT folded into
  // `errors`: a shared binding that predates this control must not brick a
  // roster load (see the header note on #379). The blocking half is
  // `validateIdentityBindingEdit`, which refuses to CREATE a new one.
  const warnings = identityBindingConflicts(roster)
    .filter((c) => !c.acknowledged)
    .map(
      (c) =>
        `$.persons.${c.person_id}.${c.binding_field}: ${JSON.stringify(c.binding)} is ALSO bound by ${c.collides_with
          .map((x) => JSON.stringify(x))
          .join(
            ", ",
          )} — architecture §2.1 is one person_id per human, so this roster encodes N authority units for one human. ` +
        `Pre-existing bindings are grandfathered (non-fatal). Declare the linkage with "same_human_as" to silence this, or collapse the identities via a quorum roster edit.`,
    );

  return { valid: errors.length === 0, errors, warnings };
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
  // loom#s49 identity-binding uniqueness. `validateIdentityBindingEdit` is
  // the BLOCKING registration fence (delta-scoped, called by the
  // /whoami --register ceremony before it writes the roster);
  // `identityBindingConflicts` is the non-fatal reporting half.
  validateIdentityBindingEdit,
  identityBindingConflicts,
  // S60: the safe-object-key predicate, exported so a ceremony can refuse an
  // unsafe person_id UP FRONT (before any assignment) with a typed refusal,
  // and so consumers doing map lookups share ONE definition of "unsafe key"
  // rather than each re-deriving a denylist.
  isUnsafeMapKey: _isUnsafeMapKey,
  // Exposed for tests + downstream tools; not for general consumption.
  _internal: { loadSchema, _validateSafeMapKeys },
};
