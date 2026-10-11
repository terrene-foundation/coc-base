/**
 * hook-registry-contract — the ONE definition of the `loom.hook-registry/v1`
 * document: its shape, its canonical JSON + content hash, the row-id
 * derivation, the `@hook-contract` block parser, and the vendored validator.
 *
 * WHY THIS FILE EXISTS. loom emits a per-repo hook registry so a consumer
 * (csq Gate — `csq gate dispatch <event>`, with the operator pin
 * `csq gate pin`) can consolidate a repo's hook surface and verify, before
 * dispatching a hook, that the bytes on disk are the bytes the registry was
 * emitted from.
 * That makes the registry a FAIL-CLOSED INTEGRITY CONTRACT, not a report: a
 * row missing from it is indistinguishable from a hook that does not exist,
 * which is exactly the failure the contract exists to prevent. So the emitter
 * (`bin/emit-hook-registry.mjs`) and the validator here MUST agree
 * byte-for-byte on what a valid document is — they share this module rather
 * than each carrying a copy (specs-authority.md Rule 9: derive from the
 * authority, never restate it).
 *
 * ARTIFACTS AND THEIR MEASURED DELIVERY (a real `sync-tier-aware --build base
 * --dry-run --json` plan, not a claim about the tree):
 *   - `.claude/hooks/hook-registry.schema.json`, `hooks/lib/hook-registry-contract.js`,
 *     `hooks/lib/jcs-canonicalize.js` → copy / always_include (`hooks/**`).
 *   - `.claude/bin/emit-hook-registry.mjs` → copy / always_include ONLY because it
 *     is on the consumer-runtime bin allowlist; before that entry it measured
 *     skip/no_tier_match while the schema, the libs and the README instructing a
 *     reader to run it all shipped (the reader-without-a-writer shape).
 *   - `.claude/hook-registry.json` (+ .sig) → GENERATED per target at Gate-2 and
 *     carried by that same allowlist. NOT target_owned: a manifest is about the
 *     hooks AND the registration set of the repo it describes, so loom ships the
 *     generated copy rather than letting a target's hand edit stand.
 *   - `.claude/hooks/lib/weft-jcs.js` → skip / loom_only (WEFT reference role); its
 *     IMPLEMENTATION rides the shipping jcs-canonicalize.js above.
 *   - `.claude/hooks/hook-registry.schema.json` — the JSON Schema (draft
 *     2020-12). THIS MODULE VALIDATES *AGAINST THAT FILE*, read at call time,
 *     so the schema a consumer's red test uses and the schema the emitter
 *     enforces cannot drift apart. The subset of JSON Schema needed is
 *     implemented by `validateAgainstSchema` below (type / required /
 *     properties / additionalProperties / items / enum / const / pattern /
 *     minimum / maximum / minItems / maxItems / minLength) — no external dep,
 *     per rules/dependencies.md "Own the Stack".
 *   - `.claude/bin/emit-hook-registry.mjs` — the emitter.
 *
 * WHAT THIS MODULE CANNOT SEE — THE HONEST BOUNDARY, stated here because it
 * SHIPS with the artifact and a reader must be able to tell what a green does
 * not cover (instrument-discipline.md MUST-3). Each item is a limit of the
 * instrument, not a defect to be discovered later:
 *   1. `side_effects.fs_writes` is a DECLARATION BY THE AUTHOR. Nothing here
 *      opens the hook or checks that the path is written; only the entry's
 *      SHAPE and its locator name are checked, never the claim.
 *   2. `side_effects.idempotent` is likewise declared and UNVERIFIED — no
 *      check can know whether a second run rewrites state.
 *   3. `cost` is labelled [M] but this module only checks its SHAPE
 *      (integers + a named platform/method); it cannot tell a measurement from
 *      a number someone typed.
 *   4. The `[A]` cross-checks (spawns / fs_writes / network / rewrite) catch
 *      the DECLARATION-VS-SOURCE contradiction, not the capability itself: a
 *      capability reached through a lib helper, an aliased binding
 *      (`const run = spawnSync`), or a reply assembled one call deeper is
 *      invisible to a lexed scan over this file. The network scan looks for
 *      `fetch(`, `http/https/net/dns/tls` + request/connect/lookup, and a bare
 *      `request/connect/lookup` call; it does NOT match `http.get`/`http.put`
 *      (only request/connect/lookup), `dgram`, `dns.promises.lookup` reached
 *      through a destructured binding, or a socket opened by a spawned child
 *      (that one is declared under `spawns`). The spawn scan looks for the
 *      spawn family and a `child_process` REQUIRE — `import("node:child_process")`
 *      is matched by the import form, a computed specifier is not.
 *   5. `protocol.decision_fields` and `exit_codes` are LEXED, not evaluated:
 *      computed keys, spread replies and computed exit codes do not appear.
 *   6. The require closure covers RELATIVE requires only. A node builtin or an
 *      npm package is not pinned (its bytes are not in this repo); a dynamic
 *      require is REFUSED rather than omitted, but an exemption, once granted,
 *      is a declared hole.
 *   7. TRANSITIVE INTEGRITY IS BOUNDED BY THE CLOSURE WALK: rows pin their
 *      hooks, `deps` pins the local require closure, `runtimes[]` pins the
 *      dispatcher/adapter closures — and NOTHING ELSE. A file reached by a
 *      non-require path (a runtime `readFileSync`, a plugin registry, a
 *      submodule, `node_modules`) is outside every pin.
 *   8. `content_sha256` is INTERNAL CONSISTENCY. It cannot tie the document to
 *      an authority or to the tree — that is the consumer's out-of-band pin
 *      and byte re-verification, and nothing here substitutes for it.
 *
 * CommonJS with zero dependencies, matching every sibling in this directory.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
// The RFC 8785 canonicalizer, imported from its ONE home in this repo (see the
// canonicalJson note below). Loaded defensively so a tree that carries this
// module without the hooks lib fails LOUD at first use rather than silently
// falling back to a weaker canonical form.
let jcsCanonicalize;
let sha256Jcs;
try {
  ({ jcsCanonicalize, sha256Jcs } = require("./jcs-canonicalize.js"));
} catch (err) {
  jcsCanonicalize = undefined;
  sha256Jcs = undefined;
  // Not thrown here: a require-time throw would make the module unloadable for
  // a caller that only wants the block parser. The hash functions below refuse
  // explicitly instead — a canonical form that is merely CLOSE is worse than
  // no answer, because both sides would compute a hash and disagree.
}
// The lexical scanner, shared with the code that owns the deny-capability
// ratchet: one tokenizer, so this module and that ratchet cannot disagree about
// what a token is (the same reasoning check-deny-capable-declarations.mjs cites
// for importing it rather than carrying a copy).
const { tokenize } = require("./block-evidence-provenance.js");

// ── identity ────────────────────────────────────────────────────────────────

const SCHEMA_ID = "loom.hook-registry/v1";
const SCHEMA_VERSION = "1.0.0";
/** The `$id`'s major. `version`'s MAJOR MUST equal it (refused otherwise). */
const SUPPORTED_MAJOR = 1;
const UNKNOWN_MAJOR_POLICY = "fail-closed";
/**
 * The combine rule a consuming dispatcher MUST implement, in FULL order. The
 * rewrite clause is not decoration: a hook may return a REWRITE of the tool
 * input instead of a verdict, and two rows rewriting the same call cannot both
 * win — so a conflicting rewrite is a REFUSAL, ranked below a deny (a deny
 * needs no tie-break) and above a single rewrite (which is applied).
 */
const PRECEDENCE =
  "deny > conflicting-rewrite refusal > single rewrite; advise never downgrades a deny";
const GENERATED_BY = "loom/.claude/bin/emit-hook-registry.mjs";

/** The manifest is a DISTRIBUTED artifact at this fixed repo-relative path. */
const MANIFEST_REL = ".claude/hook-registry.json";
/** Its sibling signature, when the signing path is available. */
const MANIFEST_SIG_REL = ".claude/hook-registry.json.sig";

/**
 * The two execution pools a consumer splits an event into. DERIVED from
 * `source`, never hand-set: loom-template rows run in the template pool, and
 * everything the repo itself brought (repo-local, third-party) runs in the repo
 * pool — so a crash in a locally-added row cannot mark a template row
 * incomplete.
 */
const POOL_BY_SOURCE = Object.freeze({
  "loom-template": "template",
  "repo-local": "repo",
  "third-party": "repo",
});

/**
 * The runtime entries whose closures are pinned at manifest level: the CC
 * dispatcher and the Codex adapter. Each is pinned by the SAME closure
 * function the rows use, because the adapter decides how every row's verdict is
 * produced and interpreted — pinning the hooks while leaving the adapter loose
 * is the transitive-integrity hole this closes.
 */
const RUNTIME_ENTRIES = Object.freeze([
  ".claude/hooks/dispatch.js",
  ".claude/hooks/lib/codex-hook-runtime.js",
  // The supervisor runs repo-owned detectors in a SEPARATE process tree, and it
  // is reached by SPAWN BY PATH — `spawn(process.execPath, [SUPERVISOR_FILE])`,
  // where the path comes from a join binding. No require walk can see that load,
  // so the file is pinned as its own runtime entry rather than left invisible
  // (which is what it was: unpinned in every closure).
  ".claude/hooks/lib/local-supervisor.js",
]);
/** The schema, resolved from THIS file so a moved tree still finds it. */
const SCHEMA_REL = ".claude/hooks/hook-registry.schema.json";

// ── events ──────────────────────────────────────────────────────────────────

/**
 * The events loom's dispatcher runs, in the canonical emission order (the
 * lifecycle order the host delivers them in, not alphabetical — a consumer
 * reading the document top-to-bottom reads a turn). An event NOT in this list
 * is refused by the emitter: the manifest cannot state a decision semantics it
 * does not know, and guessing "continue" is the fail-OPEN direction.
 */
const EVENT_ORDER = Object.freeze([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
]);

/**
 * `default_on_incomplete` — what an INCOMPLETE run of a row means (crash,
 * timeout, non-zero exit without a JSON reply) when the row does not declare
 * its own contract. Exposed the way the host behaves, not the way an author
 * might wish: a PreToolUse row that fails to answer is a REFUSAL (security
 * over availability — an unanswered permission question must not become an
 * allow), every other event degrades to an advisory miss.
 *
 * The DEFAULT MAP; a row may declare `on_incomplete` itself and overrides this.
 */
/**
 * WHAT THE DISPATCHER READS FOR A ROW THAT DOES NOT ANSWER — the ONE authority a
 * `null` `on_incomplete` defers to, and the value both sides must agree on
 * before a null is safe. It is NOT the per-event map below: that map is THIS
 * document's own vocabulary, and comparing the document against a copy of
 * itself is how the first revision accepted a null the dispatcher read the
 * other way.
 *
 * A NAMED COPY, not an import: `lib/dispatch-registry.js` is the dispatcher's
 * own module and a build-time consumer importing it would pull the dispatcher
 * into its process (the same reason ADVISORY_ONLY_EVENTS is a copy). Case 85 of
 * `.claude/audit-fixtures/hook-registry/run.mjs` pins this constant EQUAL to
 * `ROW_ON_INCOMPLETE_DEFAULT` in the dispatcher's source, so the copy cannot
 * drift — the technique case 64 already uses for the advisory-only list.
 *
 * MEASURED at the source it copies: `.claude/hooks/lib/dispatch-registry.js` —
 * `onIncompleteOf` resolves `h.on_incomplete === "continue" ? "continue" :
 * ROW_ON_INCOMPLETE_DEFAULT`, so null, absent, and any unrecognized value all
 * read as this constant.
 */
const DISPATCHER_ON_INCOMPLETE_DEFAULT = "deny";

const EVENT_DEFAULTS = Object.freeze({
  PreToolUse: "deny",
  PostToolUse: "continue",
  UserPromptSubmit: "continue",
  Stop: "continue",
  SubagentStop: "continue",
  SessionStart: "continue",
  SessionEnd: "continue",
  PreCompact: "continue",
});

/**
 * `protocol.kind` — what a row's answer MEANS at its event, derived from the
 * event (`.claude/hooks/lib/hook-engine.js` § HOST SEMANTICS PER EVENT, read
 * off the installed host binary rather than from memory). This is the field
 * that tells a consolidating consumer which rows may share a merged reply and
 * which cannot: at SessionStart an exit 2 is NOT a refusal, at PreCompact raw
 * stdout becomes instructions, at Stop a `decision:"block"` keeps the turn
 * alive. Two rows with different `kind`s may never be merged into one decision.
 */
const PROTOCOL_KIND_BY_EVENT = Object.freeze({
  PreToolUse: "permission-decision",
  PostToolUse: "context-injection",
  UserPromptSubmit: "prompt-gate",
  Stop: "handback-decision",
  SubagentStop: "handback-decision",
  SessionStart: "advisory",
  SessionEnd: "failure-report",
  PreCompact: "compaction-instructions",
});

/**
 * Events at which a refusal token is NOT a refusal — mirroring
 * `hook-engine.js`'s own `ADVISORY_ONLY`. Kept here as a NAMED copy rather
 * than imported: `hook-engine.js` is the dispatcher's own module and is loaded
 * on every tool call, so a build-time consumer importing it would pull the
 * whole engine into its process. Case 27 of
 * `.claude/audit-fixtures/hook-registry/run.mjs` pins the two lists EQUAL by
 * reading them out of the engine's own source, so the copy cannot drift.
 */
const ADVISORY_ONLY_EVENTS = Object.freeze(["SessionStart"]);

// ── contract vocabulary ─────────────────────────────────────────────────────

/** The CLIs whose registration surfaces this emitter reads. */
const SURFACES = Object.freeze(["claude", "codex", "gemini"]);

/** The stdin dialect a hook receives, per surface. */
const PAYLOAD_DIALECT_BY_SURFACE = Object.freeze({
  claude: "cc-hook-json",
  codex: "codex-hook-json",
  gemini: "gemini-hook-json",
});

/** Where a row came from. `third-party` rows need a sidecar, never an edit. */
const SOURCES = Object.freeze(["loom-template", "repo-local", "third-party"]);

/**
 * The locator names a declared write target may start with. An entry that
 * starts with `<` but names something outside this set FAILS: adding a
 * locator is a deliberate act, and a typo'd one would otherwise read as a
 * legitimate external target forever.
 */
const FS_WRITE_LOCATORS = Object.freeze([
  "os.tmpdir()",
  "home",
  "git-common-dir",
  "npm-cache",
  "sibling-worktree-path",
  "main-checkout",
  "edited-file",
]);

/**
 * The declaration's `declared_by` value — a constant, because these fields are
 * never derived. It is the manifest's own marker that a human/agent AUTHOR
 * asserted the value, so a consumer never reads them as measurements.
 */
const DECLARED_BY = "author";

// ── canonical JSON + hashes ─────────────────────────────────────────────────

/**
 * RFC 8785 JCS, DELEGATED — never re-implemented.
 *
 * `.claude/hooks/lib/jcs-canonicalize.js` is this repo's RFC 8785 canonicalizer
 * (extracted from the WEFT chain's weft-jcs.js, ADR-001, which re-exports it),
 * and its scope is exactly this document's
 * subject matter: string / safe-integer / boolean / null / dense array / plain
 * object, with floats and unsafe integers REJECTED fail-closed rather than
 * serialized through the ECMAScript shortest-round-trip rule — the documented
 * cross-implementation interop hazard. So the earlier "JSON.stringify of sorted
 * keys" stand-in (which did NOT implement JCS's number or escaping semantics)
 * is gone; `canonicalJson` is a thin alias over `jcsCanonicalize` so callers
 * keep one name for one operation.
 *
 * WHAT THIS MEANS FOR THE SCHEMA, and why the numbers are integer-only: JCS
 * number serialization across languages is the live door (1e-7 vs 1e-07), and
 * the seat's ruling closed it by constraining every number in this document to
 * a safe integer. The schema enforces that; the canonicalizer refuses anything
 * else; and the two agree because one of them is the authority.
 */
function canonicalJson(value) {
  if (typeof jcsCanonicalize !== "function") {
    throw new Error(
      "hook-registry-contract: the RFC 8785 canonicalizer (.claude/hooks/lib/jcs-canonicalize.js) did not load — refusing to hash. A fallback would produce a DIFFERENT canonical form, and two sides hashing different forms is the failure this contract exists to prevent.",
    );
  }
  return jcsCanonicalize(value);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of RAW BYTES — the form a consumer hashes off disk, no re-encode. */
function sha256Bytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** sha256 over the RFC 8785 canonical form of the document MINUS `content_sha256`. */
function contentSha256(doc) {
  const clone = { ...doc };
  delete clone.content_sha256;
  return sha256Hex(canonicalJson(clone));
}

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Strict JSON parse for anything this module will canonicalize.
 *
 * `JSON.parse` is too permissive for a hashed document three ways, and each is
 * a real attack or interop hazard on a fail-closed contract:
 *   - DUPLICATE KEYS are silently last-wins, so the bytes a human reads and the
 *     value the hash covers can differ while both look valid.
 *   - LONE SURROGATES are accepted into JS strings, where UTF-8 encoding turns
 *     them into replacement characters — two different documents, one hash.
 *   - NON-INTEGER / UNSAFE numbers are the RFC 8785 cross-language hazard.
 *
 * Duplicate keys are detected by a small scanner that walks the RAW TEXT and
 * records each object's keys — the only place the information still exists.
 * It is deliberately not a full parser: it tracks strings (with escapes), depth
 * and object-key positions, and leaves value parsing to JSON.parse. When it and
 * the value check disagree, the refusal wins.
 *
 * @returns {{ok: boolean, error: string|null, value: any}}
 */
function parseStrictJson(text) {
  if (typeof text !== "string")
    return {
      ok: false,
      error: `expected JSON text, got ${typeof text}`,
      value: null,
    };
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not JSON: ${err.message}`, value: null };
  }
  const dup = findDuplicateKey(text);
  if (dup)
    return {
      ok: false,
      error: `duplicate object key ${JSON.stringify(dup.key)} at ${dup.path}`,
      value: null,
    };
  const bad = findUnrepresentable(value, "$");
  if (bad) return { ok: false, error: bad, value: null };
  return { ok: true, error: null, value };
}

/** Walk the raw JSON text; report the first duplicate key inside any object. */
function findDuplicateKey(text) {
  let i = 0;
  const stack = [];
  const n = text.length;
  const readString = () => {
    let out = "";
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        // DECODE, do not append the raw escape: comparing raw text made `"a"`
        // and `"\\u0061"` two different keys while JSON.parse collapses them
        // into ONE, so a document could carry a duplicate that only appears
        // after decoding.
        const esc = text[i + 1];
        if (esc === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        const shortMap = {
          n: "\n",
          t: "\t",
          r: "\r",
          b: "\b",
          f: "\f",
          '"': '"',
          "\\": "\\",
          "/": "/",
        };
        out += Object.prototype.hasOwnProperty.call(shortMap, esc)
          ? shortMap[esc]
          : esc;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out;
  };
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      const s = readString();
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      const isKey =
        text[j] === ":" &&
        stack.length > 0 &&
        stack[stack.length - 1].expectKey;
      if (isKey) {
        const frame = stack[stack.length - 1];
        if (frame.seen.has(s))
          return { key: s, path: `$${frame.paths.slice(-3).join("")}` };
        frame.seen.add(s);
        frame.expectKey = false;
      }
      void start;
      continue;
    }
    if (c === "{") {
      stack.push({ seen: new Set(), expectKey: true, paths: [] });
      i++;
      continue;
    }
    if (c === "[") {
      stack.push({ seen: null, expectKey: false, paths: [] });
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      i++;
      // A value just ended: the enclosing object (if any) expects a comma or `}`.
      if (stack.length) {
        const f = stack[stack.length - 1];
        if (f.seen) f.expectKey = true;
      }
      continue;
    }
    if (c === ",") {
      const f = stack[stack.length - 1];
      if (f && f.seen) f.expectKey = true;
      i++;
      continue;
    }
    i++;
  }
  return null;
}

/** Reject values JSON can hold but RFC 8785 cannot canonicalize. */
function findUnrepresentable(value, path) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (typeof value === "string" && LONE_SURROGATE_RE.test(value)) {
      return `${path}: string contains a lone surrogate, which is not valid Unicode and does not survive a UTF-8 round trip`;
    }
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return `${path}: number ${value} is not a safe integer — this document is integer-only (RFC 8785 float serialization is the cross-language interop hazard)`;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = findUnrepresentable(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const k of Object.keys(value)) {
      // KEYS TOO: a key is a JSON string, so a lone surrogate in one is the
      // same defect as in a value — and it went unchecked, because only the
      // VALUES were recursed into.
      if (LONE_SURROGATE_RE.test(k)) {
        return `${path}: key ${JSON.stringify(k)} contains a lone surrogate (keys are strings and obey the same rule as values)`;
      }
      const r = findUnrepresentable(value[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return `${path}: value of type ${typeof value} is not JSON-representable`;
}

/**
 * The row id: a STABLE hash of event + matcher + file, so a consumer can key
 * on it across emissions. Deliberately excludes order, timeout and every
 * contract field — those are per-emission facts, and an id that moved when a
 * timeout was tuned would make the id useless as a join key.
 */
function rowId(event, matcher, file) {
  const material = `${event}\n${matcher === null || matcher === undefined ? "" : matcher}\n${file}`;
  return `hk_${sha256Hex(material).slice(0, 16)}`;
}

// ── the static local-require closure (the `deps` field) ─────────────────────

/**
 * THE QUESTION: which files does this hook's verdict depend on?
 *
 * A `file_sha256` on the hook alone pins the WRONG thing. A hook that requires
 * `lib/foo.js` can have every one of its own bytes unchanged while `lib/foo.js`
 * is edited to return the opposite verdict — and a consumer verifying only the
 * hook's hash reports a clean pin over a changed verdict. So a row carries
 * `deps`: path + sha256 for every file in the hook's STATIC LOCAL-REQUIRE
 * CLOSURE, and the runtime entries (the dispatcher, the Codex adapter) are
 * pinned the same way at manifest level.
 *
 * RESOLUTION (CommonJS order, local specifiers only): `./x` and `../x` resolve
 * to x, x.js, x.cjs, x.mjs, x.json, or x/index.js — the first that exists. A
 * specifier that is not relative (a node builtin, an npm package) is NOT
 * pinned: its bytes are not in this repo, and pretending to pin them would be
 * the false-assurance version of this whole field.
 *
 * FAIL-CLOSED ON DYNAMIC REQUIRES. `require(someVariable)` cannot be resolved
 * statically, so the closure is INCOMPLETE by construction and the emitter
 * REFUSES rather than emitting a deps list that silently omits reachable code.
 * The escape is an explicit, named exemption (see `dynamic_require_exemptions`
 * in the emitter) so the decision is declared rather than assumed.
 *
 * THE BOUNDARY OF THE CONSTANT PROPAGATION, stated so it is not mistaken for a
 * general evaluator: bindings are read from THIS FILE'S text at definition
 * time. A binding reassigned later, defined in another module, or built by any
 * expression other than the recognized join / array / string forms is NOT
 * followed — such a site stays DYNAMIC and is refused unless exempted.
 *
 * BLIND SPOTS, named because they are the honest boundary of this instrument:
 * a transitive `require` inside a file that is itself reached only at runtime
 * (a plugin registry, a lazily-read path string) is invisible; `import` in a
 * non-CJS file is not walked (these hooks are CommonJS); and a file read at
 * runtime by path (`fs.readFileSync("./x.js")`) is not a require and is not
 * in the closure.
 */
const LOCAL_REQUIRE_SUFFIXES = [
  "",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  "/index.js",
];
const MAX_CLOSURE_FILES = 500;

/**
 * Same-file constant propagation, ONE bounded form:
 *     const NAME = path.join|resolve(__dirname, "…", "…");
 * A dynamic site whose argument mentions NAME resolves to that path. This is
 * not a general evaluator and must not become one — but without it a HOOK that
 * builds its path in a const and imports it (the shape
 * lib/cross-ecosystem-disclosure-guard.js uses for the ecosystem-config loader)
 * would either be a permanent hole or force a blanket exemption. Anything else
 * stays dynamic and is refused.
 */
/**
 * The names this file bound to `path.join` / `path.resolve` through a
 * DESTRUCTURING import — `import { join } from "node:path"` or
 * `const { join } = require("path")`. A bare `join(...)` is the same call under
 * another spelling, and the `.mjs` scripts in this tree write it that way, so
 * leaving it unrecognized made every such load dynamic (a hole by default,
 * since the emitter refuses un-exempted dynamic sites).
 *
 * Only the `path` / `node:path` source counts: a local `join` imported from
 * anywhere else is not a path builder and must not be read as one.
 */
function destructuredPathFuncs(tokens, at) {
  const names = new Set();
  const isPathSource = (v) => v === "path" || v === "node:path";
  for (let i = 0; i < tokens.length; i++) {
    // `import { join, resolve } from "node:path"` — the names sit between the
    // braces; the source follows `from`.
    if (at(i) === "import" && at(i + 1) === "{") {
      const collected = [];
      let k = i + 2;
      let closed = false;
      for (; k < tokens.length && k < i + 40; k++) {
        if (at(k) === "}") {
          closed = true;
          break;
        }
        if (tokens[k].type === "ident" && at(k) !== "as" && at(k - 1) !== "as")
          collected.push(tokens[k].value);
      }
      if (!closed || at(k + 1) !== "from") continue;
      const src = tokens[k + 2];
      if (!src || src.type !== "string" || !isPathSource(src.value)) continue;
      collected.forEach((n) => names.add(n));
      continue;
    }
    // `const { join } = require("path")` — the CJS spelling of the same binding.
    if (["const", "let", "var"].includes(at(i)) && at(i + 1) === "{") {
      const collected = [];
      let k = i + 2;
      let closed = false;
      for (; k < tokens.length && k < i + 40; k++) {
        if (at(k) === "}") {
          closed = true;
          break;
        }
        if (tokens[k].type === "ident" && at(k) !== "as" && at(k - 1) !== "as")
          collected.push(tokens[k].value);
      }
      if (
        !closed ||
        at(k + 1) !== "=" ||
        at(k + 2) !== "require" ||
        at(k + 3) !== "("
      )
        continue;
      const src = tokens[k + 4];
      if (!src || src.type !== "string" || !isPathSource(src.value)) continue;
      collected.forEach((n) => names.add(n));
    }
  }
  return names;
}

/**
 * A name -> parts map that answers AT A SITE, not globally.
 *
 * THE FLAT MAP WAS A WRONG-PIN GENERATOR, not merely an imprecise one: one entry
 * per identifier with no scope means that when two functions each declare
 * `const rel = …`, the LAST declaration wins and a site in the FIRST function
 * resolves to the second function's file. MEASURED at this tree's own
 * `.claude/bin/burndown-build.mjs`, where five functions each bind `rel` to a
 * different hook lib — line 86's `requireCjs(rel)` was pinned to
 * `git-subprocess-env.js`, a file that line never loads, while the file it DOES
 * load stayed unpinned. A closure that verifies clean over the wrong file is
 * worse than one that refuses.
 *
 * So each declaration is stored WITH ITS LINE, and a lookup takes the site's
 * line and returns the NEAREST DECLARATION AT OR ABOVE IT — which is what
 * lexical scoping does for the sequential `const` declarations this reader
 * resolves. A name declared only BELOW a site is not in force there and reads
 * as unbound (the site goes dynamic and is refused unless exempted), which is
 * the fail-closed direction.
 */
/**
 * WHETHER THE BARE `__filename` IDENTIFIER IS PROVABLY THIS FILE'S OWN PATH.
 *
 * INVERTED ON PURPOSE, and this is the third round of that lesson. The rule used
 * to ENUMERATE the ways the name could be redirected — a reassignment, then a
 * non-shim declaration, then a destructuring assignment — and each round the
 * security lens found another spelling the enumeration had not thought of
 * (`for (__filename of […])`, `__filename &&= …`). An enumeration of CONSTRUCTS
 * cannot terminate; a whitelist of the language's own assignment-operators can,
 * because that set is closed by the grammar. So:
 *
 *   ACCEPT only when EVERY occurrence of the identifier is READ-SHAPED, and
 *   REFUSE everything else — an unthought-of construct now fails CLOSED instead
 *   of being pinned. Read-shaped means: the next token is not one of the
 *   assignment operators (a closed, spec-defined set), is not `of`/`in` in a
 *   `for` head, is not `++`/`--`, and the previous token is not `++`/`--`.
 *
 * DECLARATIONS. The ESM arm needs EXACTLY ONE declaration of the name and it
 * must BE the fileURLToPath shim (a file that never declares it has no
 * `__filename` at all). The CJS arm is KEPT, deliberately: in a `.js` module the
 * name is Node's own wrapper parameter, so it needs no declaration — and it is
 * accepted only with NO declaration anywhere (a `var __filename = …` is a
 * SHADOW) and no write-shaped occurrence. `.claude/hooks/delegation-default-guard.js`
 * is the live case: two reads, no declaration.
 *
 * TWO LIMITS, NAMED rather than left to be found:
 *   - the shim's OTHER spelling (`require("node:url").fileURLToPath(…)`) is
 *     REFUSED by decision: it is legitimate, but it has NO live user in this
 *     tree (MEASURED) and whitelisting it widens the accepted grammar for a
 *     shape nobody writes. A file that needs it takes the per-site exemption.
 *   - a PARAMETER that shadows the name (`function f(__filename) { … path.dirname(__filename) … }`)
 *     is not classified: a parameter binding and a call argument are the same
 *     two tokens from the inside, and telling them apart needs a real parser,
 *     which this walker is not. It is a declared boundary with the exemption
 *     path open, not a silent pass.
 *   - DYNAMIC CODE is lexically unclosable: `eval("__filename = …")` assigns
 *     through a string, and no token-level rule can see it (the security lens
 *     demonstrated it in round 4). A text scan cannot decide dynamic code — a
 *     walker that pretended to would be the enumeration failure with extra
 *     steps. Declared here and in the delta table, with the exemption path open.
 */
const FILENAME_WRITE_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
  "++",
  "--",
]);

/**
 * Is this occurrence inside the TARGET of a `for` head — the region before the
 * head's `of`/`in`, where every identifier or pattern member is a WRITE?
 *
 * Covered because the shape kept escaping: `for (x of …)` has no `=` near the
 * write, `for ([x] of …)` puts a bracket between the name and the keyword, and
 * `for await (x of …)` puts `await` between `for` and `(` — the last one defeated
 * the earlier check's "the token before the paren must be `for`". A classic
 * three-clause head has no `of`/`in` at all and is treated as target throughout,
 * which is the fail-closed reading.
 */
function inForHeadTarget(tokens, at, i) {
  let k = i - 1;
  while (k >= 0 && at(k) !== "(") k--;
  if (k < 0) return false;
  const before = at(k - 1);
  const isFor = before === "for" || (before === "await" && at(k - 2) === "for");
  if (!isFor) return false;
  let depth = 0;
  for (let j = k; j < tokens.length; j++) {
    const v = at(j);
    if (v === "(" || v === "[" || v === "{") depth++;
    else if (v === ")" || v === "]" || v === "}") {
      depth--;
      if (depth === 0) return false;
    } else if (depth === 1 && (v === "of" || v === "in")) {
      return j > i; // the name sits BEFORE the keyword ⇒ it is the target
    }
  }
  return true;
}

function filenameAnchorProven(tokens, cjs) {
  const at = (i) => (tokens[i] ? tokens[i].value : undefined);
  let decls = 0;
  let shims = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || t.value !== "__filename") continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    if (prev === "const" || prev === "let" || prev === "var") {
      decls += 1;
      if (next === "=" && at(i + 2) === "fileURLToPath" && at(i + 3) === "(")
        shims += 1;
      continue;
    }
    // THE FOR-HEAD TARGET COMES FIRST: its write has no `=` and may sit behind a
    // bracket (`for ([__filename] of …)`) or behind `await` (`for await (…)`),
    // and the pattern branches below would otherwise read it as a plain position.
    if (inForHeadTarget(tokens, at, i)) return false;
    if (next === "}" || next === "]") {
      if (at(i + 2) === "=") {
        // A DESTRUCTURING PATTERN being assigned. It is a declaration only when
        // a declaration keyword opens the statement; otherwise it WRITES.
        let declared = false;
        for (let k = i - 2; k >= 0 && k > i - 8; k--) {
          const v = at(k);
          if (v === "const" || v === "let" || v === "var") {
            declared = true;
            break;
          }
          if (v === ";" || v === "(" || v === "{" || v === "=") break;
        }
        if (declared) {
          decls += 1;
          continue;
        }
        return false;
      }
      continue; // a pattern/array position, not an assignment
    }
    // An assignment operator AFTER the name is a write; one BEFORE it is a READ
    // of this name (`const y = __filename`, `x += __filename`) — the previous
    // revision tested both sides and false-refused a plain RHS read (MEASURED,
    // the round-4 over-refusal). Only prefix `++`/`--` still count from the left.
    if (FILENAME_WRITE_OPS.has(next)) return false;
    if (prev === "++" || prev === "--") return false;
  }
  if (cjs) return decls === 0;
  return decls === 1 && shims === 1;
}

function bindingMap() {
  const byName = new Map();
  return {
    set(name, line, parts) {
      let list = byName.get(name);
      if (!list) {
        list = [];
        byName.set(name, list);
      }
      if (list.some((e) => e.line === line)) return;
      list.push({ line, parts });
    },
    /** The parts in force AT `line`, or undefined when no declaration precedes it. */
    get(name, line) {
      const list = byName.get(name);
      if (!list) return undefined;
      let best = null;
      for (const e of list)
        if (e.line <= line && (!best || e.line > best.line)) best = e;
      return best ? best.parts : undefined;
    },
    /** `line` given: in force THERE. Omitted: declared anywhere in the file. */
    has(name, line) {
      return line === undefined
        ? byName.has(name)
        : this.get(name, line) !== undefined;
    },
  };
}

function dirnameJoinBindings(tokens, joinNames = null, opts = {}) {
  const at = (idx) => (tokens[idx] ? tokens[idx].value : undefined);
  const map = bindingMap();
  // The RELATIVE bindings alone (passes 0 and 1 below), kept apart from the
  // dirname-anchored ones: a spawn script path is built from the PROJECT ROOT
  // (`path.join(projectDir, GENERATOR_REL)`), and splicing a __dirname-anchored
  // binding there would drop the anchor and resolve against the wrong base. The
  // spawn reader takes only this map.
  const relative = bindingMap();
  // PROVENANCE FOR THE BARE `__filename` ANCHOR — see `filenameAnchorProven`
  // for the whitelist and the reasons it replaced an enumeration of constructs.
  // Computed ONCE per file: the scan is over the whole token stream and the
  // answer cannot depend on where the anchor sits.
  let filenameProof = null;
  const provenSelf = (name) => {
    if (name !== "__filename") return false;
    if (filenameProof === null)
      filenameProof = filenameAnchorProven(tokens, opts.cjs === true);
    return filenameProof;
  };

  // PASS 0 — plain string-literal consts (`const CAPTURE_HOOK = "x.js"`), which
  // appear as join ARGUMENTS in this tree (`path.join(HOOKS_DIR, CAPTURE_HOOK)`)
  // and left those sites dynamic while only string TOKENS were accepted.
  for (let i = 0; i < tokens.length - 3; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    const lit = tokens[i + 3];
    // A CONCAT BINDING IS NOT A STRING CONSTANT: `const P = "./a" + suffix`
    // would register "./a" and drop the rest, so a later require(P) pins a file
    // the expression may never name. Only a bare literal initializer binds.
    if (
      lit &&
      lit.type === "string" &&
      lit.value.length > 0 &&
      at(i + 4) !== "+"
    ) {
      map.set(name.value, t.line, [lit.value]);
      relative.set(name.value, t.line, [lit.value]);
    }
  }
  // PASS 1 — relative string arrays and relative joins:
  //   const ENGINE_REL = ["..", "scripts", "ci", "x.mjs"];
  //   const AUTHORITY_REL = path.join("..", "..", "bin", "validate-emit.mjs");
  // These carry NO __dirname anchor, so they are only meaningful spliced into a
  // dirname-anchored call — which is exactly how both are used.
  for (let i = 0; i < tokens.length - 2; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    if (at(i + 3) === "[") {
      const parts = [];
      let k = i + 4;
      let closed = false;
      while (tokens[k]) {
        if (at(k) === "]") {
          closed = true;
          break;
        }
        if (tokens[k].type === "string") {
          parts.push(tokens[k].value);
          k += 1;
          continue;
        }
        if (at(k) === ",") {
          k += 1;
          continue;
        }
        break;
      }
      if (closed && parts.length) {
        map.set(name.value, t.line, parts);
        relative.set(name.value, t.line, parts);
      }
      continue;
    }
    if (
      at(i + 3) === "path" &&
      at(i + 4) === "." &&
      (at(i + 5) === "join" || at(i + 5) === "resolve") &&
      at(i + 6) === "("
    ) {
      const parts = [];
      let k = i + 7;
      let closed = false;
      while (tokens[k]) {
        if (at(k) === ")") {
          closed = true;
          break;
        }
        if (tokens[k].type === "string") {
          parts.push(tokens[k].value);
          k += 1;
          continue;
        }
        if (at(k) === ",") {
          k += 1;
          continue;
        }
        break;
      }
      // Only RELATIVE forms are collected here; a __dirname-anchored one is
      // pass 2's business and mixing them would splice the anchor in twice.
      if (closed && parts.length && !parts.includes("__dirname")) {
        map.set(name.value, t.line, parts);
        relative.set(name.value, t.line, parts);
      }
    }
  }
  // PASS 4 — DIRNAME-EQUIVALENT anchors. An ESM file has no `__dirname`, so it
  // derives one: `const HERE = path.dirname(fileURLToPath(import.meta.url))`
  // (the destructured spelling too). Recording it with ZERO parts puts it in
  // the same map `__dirname` is special-cased into above, so every join
  // anchored on it resolves against the file's own directory — which is what
  // the anchor means — instead of going dynamic. Without this, pinning a
  // spawned `.mjs` script dragged in that script's own loads as unresolvable.
  for (let i = 0; i < tokens.length - 6; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    // Normalize to: `j` sits ON the `dirname` identifier and `at(j + 1)` is its
    // `(` — so the `path.dirname(…)` and the destructured `dirname(…)` spellings
    // land in the same place and the rest of the check is written once.
    let j = i + 3;
    if (at(j) === "path" && at(j + 1) === ".") j += 2;
    if (at(j) !== "dirname") continue;
    if (!(
      at(j + 1) === "(" ||
      (joinNames && joinNames.has(at(j)) && at(j + 1) === "(")
    ))
      continue;
    j += 2;
    // The inner call must BE the module's own path. Two spellings, both sound:
    // `fileURLToPath(import.meta.url)` (ESM) and the IDENTIFIER `__filename`
    // (CJS, or an ESM file's shim `const __filename = fileURLToPath(import.meta.url)`
    // — template-freshness.mjs writes it that way, and `path.dirname(__filename)`
    // there IS its own directory). An anchor that resolves to the wrong
    // directory would be a WRONG PIN, so only these two are accepted.
    if (at(j) === "fileURLToPath" && at(j + 1) === "(") j += 2;
    const innerIsModuleUrl =
      at(j) === "import" &&
      at(j + 1) === "." &&
      at(j + 2) === "meta" &&
      at(j + 3) === "." &&
      at(j + 4) === "url";
    const innerIsProvenSelf =
      tokens[j] && tokens[j].type === "ident" && provenSelf(at(j));
    if (!innerIsModuleUrl && !innerIsProvenSelf) continue;
    map.set(name.value, t.line, []);
  }
  // PASS 2 — dirname-anchored joins, expanded through pass 1.
  for (let i = 0; i < tokens.length - 4; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    // The initializer WINDOW, not just the token after `=`: a bound path is
    // routinely written as `(opts && opts.authorityPath) || path.resolve(__dirname, REL)`,
    // and reading only `tokens[i+3]` missed every such binding. The scan stops
    // at the statement's end and takes the FIRST dirname-anchored join it can
    // read; a mis-read here would only ADD a pin, which is the fail-closed
    // direction for a closure field.
    let parts = null;
    for (let k = i + 3; k < tokens.length && k < i + 60; k++) {
      if (at(k) === ";") break;
      const bareJoin = joinNames && joinNames.has(at(k)) && at(k + 1) === "(";
      if (
        (at(k) === "path" &&
          at(k + 1) === "." &&
          (at(k + 2) === "join" || at(k + 2) === "resolve") &&
          at(k + 3) === "(") ||
        bareJoin
      ) {
        const read = readDirnameJoin(tokens, k, false, map, joinNames);
        if (read) {
          parts = read;
          break;
        }
      }
    }
    if (parts) map.set(name.value, t.line, parts);
  }
  // PASS 3 — RUNTIME-ANCHORED joins: `const gen = path.join(projectDir, REL)`.
  // The anchor is a value no walker can know, and everything AFTER it is
  // root-relative — the shape both spawn sites in this tree use. Collected in
  // their own map because ONLY the spawn reader may read them: a require
  // resolves against the requiring file's directory, never the repo root, so
  // splicing one of these into a require site would pin the wrong path.
  const spawnPaths = bindingMap();
  for (let i = 0; i < tokens.length - 4; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    for (let k = i + 3; k < tokens.length && k < i + 40; k++) {
      if (at(k) === ";") break;
      let j = k;
      if (at(j) === "path" && at(j + 1) === ".") {
        j += 2;
        if (at(j) === "posix" && at(j + 1) === ".") j += 2;
        if ((at(j) !== "join" && at(j) !== "resolve") || at(j + 1) !== "(")
          break;
      } else if (joinNames && joinNames.has(at(j)) && at(j + 1) === "(") {
        // `const lib = join(root, ".claude", "hooks", "lib", "x.js")` — the
        // destructured spelling of the same root-anchored join, which the
        // registry's own validator uses for every path it loads.
      } else break;
      j += 2;
      const anchor = tokens[j];
      if (!anchor || anchor.type !== "ident" || at(j + 1) !== ",") break;
      // A __dirname-anchored (or already-dirname-bound) join is PASS 2's, and
      // reading it as root-relative here resolved a hook's own sibling script
      // against the repo root — a wrong base for a path that was never wrong.
      if (anchor.value === "__dirname" || map.has(anchor.value, t.line)) break;
      j += 1;
      const parts = [];
      while (at(j) === ",") {
        if (at(j + 1) === ")") break;
        j += 1;
        const tok = tokens[j];
        if (tok && tok.type === "string") {
          parts.push(tok.value);
          j += 1;
          continue;
        }
        if (
          at(j) === "..." &&
          tokens[j + 1] &&
          tokens[j + 1].type === "ident" &&
          relative.has(tokens[j + 1].value, t.line)
        ) {
          parts.push(...relative.get(tokens[j + 1].value, t.line));
          j += 2;
          continue;
        }
        if (tok && tok.type === "ident" && relative.has(tok.value, t.line)) {
          parts.push(...relative.get(tok.value, t.line));
          j += 1;
          continue;
        }
        parts.length = 0;
        break;
      }
      // A TRAILING COMMA IS HOW A MULTI-LINE ARGUMENT LIST ENDS
      // (`join(\n  root,\n  ".claude",\n  "x.mjs",\n);`). Reading it as a
      // missing argument dropped the binding, and the load it names became a
      // refusal — the same trap readDirnameJoin documents on its own argument
      // list, hit here because this reader was written after it.
      if (at(j) === "," && at(j + 1) === ")") j += 1;
      if (at(j) === ")" && parts.length)
        spawnPaths.set(name.value, t.line, parts);
      break;
    }
  }
  // PASS 3b — A BINDING OF A BINDING. `const extractorReal = realpathSync(extractor)`
  // carries the same path through a resolver, and reading it as unresolvable
  // refused a spawn whose script the walker had ALREADY resolved one line up.
  // Only the resolver names this tree uses are followed, and only when their
  // argument is a binding this same pass set.
  for (let i = 0; i < tokens.length - 6; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    let j = i + 3;
    if (at(j) === "path" && at(j + 1) === ".") j += 2;
    if (
      !["realpathSync", "resolve", "normalize"].includes(at(j)) ||
      at(j + 1) !== "("
    )
      continue;
    const inner = tokens[j + 2];
    if (!inner || inner.type !== "ident") continue;
    const parts =
      spawnPaths.get(inner.value, t.line) || relative.get(inner.value, t.line);
    if (parts && parts.length) spawnPaths.set(name.value, t.line, parts);
  }
  // PASS 5 — SELF PATHS. `const SELF_PATH = fileURLToPath(import.meta.url)` is
  // this file's OWN path, and a spawn of it loads the file that is already
  // pinned by its own file_sha256 — a pin, not a hole, but not one a deps edge
  // can carry either (the closure's deps exclude the entry by construction).
  // Recorded so the spawn reader can say "self" instead of "unresolvable".
  const selfPaths = new Set();
  for (let i = 0; i < tokens.length - 5; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    let j = i + 3;
    if (at(j) === "path" && at(j + 1) === ".") j += 2;
    if (at(j) !== "fileURLToPath" || at(j + 1) !== "(") continue;
    if (!(
      at(j + 2) === "import" &&
      at(j + 3) === "." &&
      at(j + 4) === "meta" &&
      at(j + 5) === "." &&
      at(j + 6) === "url"
    ))
      continue;
    selfPaths.add(name.value);
  }
  if (provenSelf("__filename")) selfPaths.add("__filename");
  return { map, relative, spawnPaths, selfPaths };
}

/**
 * The identifiers inside a call's argument window, each tagged with whether it
 * is a PROPERTY name (preceded by `.`). The flag separates an expression that
 * merely MENTIONS a binding from one that IS a binding: a property name cannot
 * change which variable is dereferenced, a bare identifier can.
 */
function windowIdentifiers(tokens, start) {
  const ids = [];
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    const v = tokens[j];
    if (v.value === "(") depth++;
    else if (v.value === ")") {
      depth--;
      if (depth === 0) break;
    } else if (depth >= 1 && v.type === "ident") {
      const isProperty =
        tokens[j - 1] !== undefined && tokens[j - 1].value === ".";
      ids.push({ name: v.value, isProperty });
    }
  }
  return ids;
}

/**
 * What a specifier that is NOT `./`/`../`-relative IS. The distinction the
 * first revision collapsed: everything non-relative went into `externals`, which
 * reads as "not ours to pin" — true of a node builtin or an npm package, FALSE
 * of `.`, `..`, `/abs/x.js` and `file:…`, which are loads of a LOCAL FILE the
 * walker simply could not resolve. Dropping those silently is the same class of
 * hole as an unrecorded dynamic require, so they are refused (with the
 * per-site exemption path available) rather than filed as externals.
 */
function classifySpecifier(spec) {
  if (spec === "." || spec === "..") return "unpinnable";
  if (
    spec.startsWith("/") ||
    spec.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(spec)
  )
    return "unpinnable";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) {
    // `node:fs` IS a builtin — the scheme prefix says where the loader finds it,
    // not that it is a local file. Every other scheme (`file:`, `http:`,
    // `data:`) names bytes this closure cannot pin.
    return spec.startsWith("node:") ? "external" : "unpinnable";
  }
  return "external";
}

/** The spawn family whose FIRST argument may be a script this walker must pin. */
const SPAWN_FAMILY = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "fork",
]);

/**
 * The STATIC ESM specifier at an `import` / `export` token, or null.
 *
 * `import x from "./a.mjs"`, `import "./a.mjs"`, `export * from "./a.mjs"` all
 * EXECUTE the target exactly as a require does, and the first revision produced
 * no site for any of them — the closure verified clean over the entire import
 * graph of every `.mjs` file it walked. `import.meta` and the dynamic
 * `import(…)` form are recognized elsewhere; this reads the static clause only.
 */
function staticEsmSpecifier(tokens, i, at) {
  const isImport = at(i) === "import";
  const isExport = at(i) === "export";
  if (!isImport && !isExport) return null;
  let depth = 0;
  for (let j = i + 1; j < tokens.length && j < i + 80; j++) {
    const v = at(j);
    if (v === "{" || v === "(" || v === "[") depth++;
    else if (v === "}" || v === ")" || v === "]") {
      depth--;
      if (depth < 0) return null;
      continue;
    }
    if (depth !== 0) continue;
    if (v === ";") return null;
    if (tokens[j].type !== "string") continue;
    // A side-effect import puts the specifier first (`import "./x.mjs"`); every
    // other static form announces it with `from`. A string anywhere else in the
    // clause (`export const A = "x"`) is not a specifier.
    if (j === i + 1 && isImport) return tokens[j].value;
    if (at(j - 1) === "from") return tokens[j].value;
    return null;
  }
  return null;
}

/**
 * The path bindings interpolated into an INLINE program's `${…}` slots.
 *
 * `spawnSync(process.execPath, ["--input-type=module", "-e", shim])` names no
 * script, but the program string routinely carries one: template-resolver's
 * shim is `import { resolveRepo } from ${JSON.stringify(LOOM_LINKS_MJS)};`, and
 * LOOM_LINKS_MJS is a `path.resolve(__dirname, …)` binding. MEASURED before
 * this reader existed: `.claude/bin/lib/loom-links.mjs` appeared ZERO times in
 * the emitted manifest — the file the shim imports was pinned nowhere. The
 * interpolation is the only place that load is spelled, so it is read here.
 *
 * Only `${…}` at the array's own depth is scanned, and only identifiers the
 * binding maps resolve; anything else leaves the site to the caller's declared
 * hole rather than a guess.
 */
function interpolationBindings(tokens, start, bindings, relative, line, at) {
  const out = [];
  // The program may be spelled INLINE (`["-e", \`…${A}…\`]`) or held in a const
  // (`const shim = \`…${A}…\`; … ["-e", shim]`) — template-resolver writes the
  // second, so a bare identifier in the argv is followed to its own declaration
  // before the site is called opaque.
  const scanWindows = [start];
  // We begin just INSIDE the argv array's `[`, so the depth starts at 1 and the
  // top-level elements are the ones at depth 1 — the flags, the program, the args.
  let d0 = 1;
  for (let j = start; j < tokens.length; j++) {
    const v = at(j);
    if (v === "(" || v === "[") d0++;
    else if (v === ")") d0--;
    else if (v === "]") {
      d0--;
      if (d0 <= 0) break;
    }
    if (d0 !== 1 || tokens[j].type !== "ident" || at(j - 1) === ".") continue;
    const name = at(j);
    // NEAREST PRECEDING declaration, with no statement-boundary stop: the argv
    // expression sits inside the statement that FOLLOWS the declaration, so a
    // `;` on the way back is the declaration's own terminator, not a wall.
    for (let k = j - 1; k >= 0 && k > j - 400; k--) {
      if (
        tokens[k].type === "ident" &&
        ["const", "let", "var"].includes(tokens[k].value) &&
        at(k + 1) === name &&
        at(k + 2) === "=" &&
        tokens[k].line <= line
      ) {
        scanWindows.push(k + 3);
        break;
      }
    }
  }
  for (const winStart of scanWindows) {
    let depth = 0;
    for (let j = winStart; j < tokens.length && j < winStart + 120; j++) {
      const v = at(j);
      if (v === "(" || v === "[") depth++;
      else if (v === ")") depth--;
      else if (v === "]") {
        depth--;
        if (depth < 0 && winStart !== start) break;
      }
      if (v === ";" && winStart !== start) break;
      if (v !== "${") continue;
      // Walk this interpolation to its matching `}` collecting resolvable names.
      let inner = 0;
      for (let k = j + 1; k < tokens.length; k++) {
        const w = at(k);
        if (w === "{") inner++;
        else if (w === "}" || w === "}$") {
          // The lexer closes an interpolation with the TWO-token `}$` form; a
          // plain `}` close would leave this scan running past the slot into the
          // rest of the statement, where an unrelated binding could be mistaken
          // for an interpolated one.
          if (inner === 0) break;
          inner--;
        }
        const tok = tokens[k];
        if (!tok || tok.type !== "ident") continue;
        if (at(k - 1) === ".") continue;
        const dirParts = bindings.get(tok.value, line);
        if (dirParts && dirParts.length)
          out.push({ kind: "dirname-join", parts: dirParts });
        else {
          const relParts = relative.get(tok.value, line);
          if (relParts && relParts.length)
            out.push({ kind: "root-join", parts: relParts });
        }
      }
    }
  }
  // One binding used twice is one pin.
  const seen = new Set();
  return out.filter((p) => {
    const k = `${p.kind}:${p.parts.join("/")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The index just past the balanced expression starting at `start` — the token
 * that ENDS it (`,`, `;`) or the index after its own closer. Used to prove a
 * spawn's script argument is ONE array element and not the head of a larger
 * expression.
 */
function endOfExpression(tokens, start) {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    const v = tokens[j].value;
    if (v === "(" || v === "[" || v === "{") {
      depth++;
      continue;
    }
    if (v === ")" || v === "]" || v === "}") {
      depth--;
      if (depth === 0) return j + 1;
      if (depth < 0) return j;
      continue;
    }
    if (depth === 0 && (v === "," || v === ";")) return j;
  }
  return tokens.length;
}

/**
 * The script a spawn-by-path executes, or a reason it cannot be resolved.
 *
 * The load forms recognized here are the ones this tree writes; anything else
 * is DYNAMIC (refused unless the site is exempted, the exemption recorded in
 * the manifest) — never silently unpinned. `__filename` is the ONE exception
 * and it is not a hole: the file re-invoking itself is pinned by its own
 * `file_sha256` (rows) or by its own deps entry (libs).
 *
 * A join whose anchor is a RUNTIME identifier (`path.join(projectDir, …)`) is
 * read as ROOT-relative: that is what the spawn convention here means (the
 * caller passes `cwd: projectDir`), and the reading degrades to a dynamic site
 * rather than a wrong pin when the assembled path is not a file in this tree.
 */
function readSpawnScript(
  tokens,
  start,
  bindings,
  relative,
  spawnPaths,
  joinNames = null,
  selfPaths = null,
) {
  const at = (idx) => (tokens[idx] ? tokens[idx].value : undefined);
  // SELF ONLY ON PROOF: `__filename` counts as this file's own path only when
  // the file declares the shim and never reassigns it (see the provenance block
  // in dirnameJoinBindings). The bare keyword check that stood here accepted a
  // reassigned identifier, which is a wrong-pin on the spawn side too.
  if (
    selfPaths &&
    tokens[start] &&
    tokens[start].type === "ident" &&
    selfPaths.has(at(start))
  )
    return { kind: "self" };
  // `realpathSync(<expr>)` — the script argument wrapped in a resolver
  // (validate-emit realpaths its extractor so the child's own entrypoint guard
  // matches). Read the expression inside it.
  if (at(start) === "realpathSync" && at(start + 1) === "(") {
    return readSpawnScript(
      tokens,
      start + 2,
      bindings,
      relative,
      spawnPaths,
      joinNames,
      selfPaths,
    );
  }
  // A binding that holds the script path: `const script = path.join(repoDir,
  // ".claude", "bin", "orphan-reap.mjs")` — read through the map PASS 3 built.
  // A __dirname-anchored binding is checked FIRST, because the two bases are
  // different and only one of them can be right.
  const siteLine = tokens[start] ? tokens[start].line : 0;
  if (
    tokens[start] &&
    tokens[start].type === "ident" &&
    spawnPaths &&
    spawnPaths.has(tokens[start].value, siteLine)
  ) {
    return {
      kind: "root-join",
      parts: spawnPaths.get(tokens[start].value, siteLine),
    };
  }
  if (
    tokens[start] &&
    tokens[start].type === "ident" &&
    relative.has(tokens[start].value, siteLine)
  ) {
    return {
      kind: "root-join",
      parts: relative.get(tokens[start].value, siteLine),
    };
  }
  if (
    tokens[start] &&
    tokens[start].type === "ident" &&
    bindings.has(tokens[start].value, siteLine)
  ) {
    return {
      kind: "dirname-join",
      parts: bindings.get(tokens[start].value, siteLine),
    };
  }
  if (tokens[start] && tokens[start].type === "string") {
    const spec = tokens[start].value;
    if (spec.startsWith("./") || spec.startsWith("../"))
      return { kind: "literal", specifier: spec };
    // A LEADING FLAG IS NOT A SCRIPT: `spawnSync(process.execPath, ["-e", PROG, …])`
    // asks node to evaluate the inline program, so no file is named here — the
    // reader turns to the program's own interpolations instead (see
    // interpolationBindings) and only falls back to a declared hole when they
    // name nothing resolvable.
    if (spec.startsWith("-")) return { kind: "inline", flag: spec };
    return {
      kind: "dynamic",
      why: `a spawn script path ${JSON.stringify(spec)} is not ./-relative`,
    };
  }
  const dirnameJoin = readDirnameJoin(
    tokens,
    start,
    false,
    bindings,
    joinNames,
  );
  if (dirnameJoin) return { kind: "dirname-join", parts: dirnameJoin };
  const rootJoin = readRootJoin(
    tokens,
    start,
    bindings,
    relative,
    siteLine,
    joinNames,
  );
  // A WHY-ONLY RESULT IS NOT A JOIN. `readRootJoin` returns `{why}` for a join
  // whose path has an unresolvable segment — a truthy object with NO `parts`
  // — and treating it as a join let `parts: undefined` reach the consumer's
  // `site.parts.join("/")` and THROW (measured: the selector's whole
  // real-corpus run died, all eight child runs exit 1, no selected suite
  // executed). The `parts` check is the consumer-side shape contract; a
  // why-only result falls through to the dynamic return below, which already
  // carries its reason. grep-stable contrast: the sibling `readDirnameJoin`
  // arm above checks its own shape the same way.
  if (rootJoin && rootJoin.parts)
    return { kind: "root-join", parts: rootJoin.parts };
  return {
    kind: "dynamic",
    why:
      rootJoin === null
        ? "the spawn script path is not a recognized join"
        : rootJoin.why,
  };
}

/**
 * `path.join(<runtime anchor>, "a", "b.js")` READ FROM THE PROJECT ROOT — the
 * shape every bin script in this tree uses to name a repo file it loads at
 * runtime (`_require(join(root, ".claude", "hooks", "lib", "dispatch-registry.js"))`,
 * `spawnSync(process.execPath, [gen, …])`).
 *
 * The anchor is an identifier the walker cannot know; the walker therefore
 * reads the LITERAL TAIL as root-relative, because that is what the convention
 * here means, and returns null when the anchor is one whose base it DOES know
 * (a __dirname-anchored binding — readDirnameJoin's business) or when any
 * segment is not a literal/relative binding. The caller decides what an
 * unresolvable result means; for every caller here it is a dynamic site, i.e.
 * refused unless the site is exempted.
 */
function readRootJoin(tokens, start, bindings, relative, line, joinNames) {
  const at = (idx) => (tokens[idx] ? tokens[idx].value : undefined);
  let i = start;
  if (at(i) === "path" && at(i + 1) === ".") {
    i += 2;
    if (at(i) === "posix" && at(i + 1) === ".") i += 2;
    if (at(i) !== "join" && at(i) !== "resolve") return null;
    i += 1;
  } else if (joinNames && joinNames.has(at(i)) && at(i + 1) === "(") {
    i += 1;
  } else if (
    at(i) === "require" &&
    at(i + 1) === "(" &&
    tokens[i + 2] &&
    tokens[i + 2].type === "string" &&
    tokens[i + 2].value === "path" &&
    at(i + 3) === ")" &&
    at(i + 4) === "."
  ) {
    i += 5;
    if (at(i) !== "join" && at(i) !== "resolve") return null;
    i += 1;
  } else {
    return null;
  }
  if (at(i) !== "(") return null;
  i += 1;
  const anchor = tokens[i];
  if (!anchor || anchor.type !== "ident") return null;
  // The anchor must be a SINGLE runtime value, which may be spelled as a member
  // expression — `require(join(args.repo, ".claude", …))` in the bin scripts is
  // the same root-relative read as `join(repoDir, …)`. Walk the member chain,
  // then require the comma that ends the first argument.
  let aEnd = i + 1;
  while (
    at(aEnd) === "." &&
    tokens[aEnd + 1] &&
    tokens[aEnd + 1].type === "ident"
  )
    aEnd += 2;
  if (at(aEnd) !== ",") return null;
  // A __dirname-anchored anchor (or a name bound twice) is NOT a root base, and
  // reading it as one pins the wrong file — fail closed instead.
  if (anchor.value === "__dirname" || bindings.has(anchor.value, line))
    return null;
  const parts = relative.has(anchor.value, line)
    ? [...relative.get(anchor.value, line)]
    : [];
  i = aEnd;
  while (at(i) === ",") {
    if (at(i + 1) === ")") break;
    i += 1;
    const tok = tokens[i];
    if (tok && tok.type === "string") {
      parts.push(tok.value);
      i += 1;
      continue;
    }
    if (
      at(i) === "..." &&
      tokens[i + 1] &&
      tokens[i + 1].type === "ident" &&
      relative.has(tokens[i + 1].value, line)
    ) {
      parts.push(...relative.get(tokens[i + 1].value, line));
      i += 2;
      continue;
    }
    if (tok && tok.type === "ident" && relative.has(tok.value, line)) {
      parts.push(...relative.get(tok.value, line));
      i += 1;
      continue;
    }
    return { why: "the path has a segment the walker cannot resolve" };
  }
  if (at(i) === "," && at(i + 1) === ")") i += 1;
  if (at(i) !== ")") return null;
  if (!parts.length) return null;
  return { parts };
}

/**
 * A ONE-IDENTIFIER path argument, resolved through the binding maps in the same
 * order the spawn reader uses: a PROJECT-ROOT-anchored binding (PASS 3), a
 * relative binding (PASS 0/1), then a __dirname-anchored one (PASS 2/4). Each
 * lookup is site-local (see bindingMap). Nothing else resolves — an argument
 * that is not exactly one known identifier is the caller's dynamic site.
 */
function readBoundPath(tokens, start, bindings, relative, spawnPaths, line) {
  const tok = tokens[start];
  if (
    !tok ||
    tok.type !== "ident" ||
    (tokens[start + 1] !== undefined && tokens[start + 1].type !== "punct")
  )
    return null;
  // THE BASE IS THE CALL SITE'S, and the two differ: a REQUIRE resolves against
  // the requiring file's directory, so a relative binding (`const REL = ["lib",
  // "impl.js"]`) is DIRNAME-relative there; only a PASS-3 runtime-anchored join
  // is root-relative. Reading `relative` as root-relative made case 74's
  // `require(REL)` look for `lib/impl.js` at the repo root and refuse a load the
  // walker had resolved correctly before.
  const rootParts = spawnPaths && spawnPaths.get(tok.value, line);
  if (rootParts && rootParts.length)
    return { kind: "root-join", parts: rootParts };
  const dirParts =
    bindings.get(tok.value, line) || relative.get(tok.value, line);
  if (dirParts && dirParts.length)
    return { kind: "dirname-join", parts: dirParts };
  return null;
}

function requireSites(src, opts = {}) {
  const { tokens, ok, error } = tokenize(src);
  if (!ok) return { ok: false, error, sites: [] };
  // ONE-ARG indexer, deliberately NOT the `(i, k)` form: `V(i - 1)` with a
  // two-parameter helper passes the OFFSET as the index and reads
  // tokens[i - 1 + undefined] = tokens[NaN] — undefined for every position.
  // That shape has now produced two dead checks in this lane, so the
  // single-argument form is the convention in this file.
  const at = (idx) => (tokens[idx] ? tokens[idx].value : undefined);
  const sites = [];
  const joinNames = destructuredPathFuncs(tokens, at);
  const {
    map: bindings,
    relative,
    spawnPaths,
    selfPaths,
  } = dirnameJoinBindings(tokens, joinNames, opts);
  // AN ALIASED require IS REFUSED, not silently missed: `const r = require`
  // makes every later `r(...)` a load this walker cannot follow, and the first
  // revision produced NO site for it — a closure that verified clean over a file
  // it never covered. Detecting the ALIAS DECLARATION closes it fail-closed.
  //
  // `createRequire` IS THE CJS LOADER REACHED FROM ESM — the dominant form in
  // every `.mjs` file of this tree — and a binding holding one is an ALIAS OF
  // `require` in every respect. Treating its declaration as a hole (the cruder
  // reading) would refuse a file whose loads are mostly statically resolvable;
  // so the binding is RECORDED and its CALL SITES are walked exactly like a bare
  // `require(…)` below. A createRequire result that is called with anything the
  // walker cannot resolve is a dynamic site like any other: refused unless the
  // site is exempted, with the exemption carried in the manifest.
  const aliasNames = new Set();
  for (let i = 0; i < tokens.length - 4; i++) {
    const t = tokens[i];
    if (t.type !== "ident" || !["const", "let", "var"].includes(t.value))
      continue;
    const name = tokens[i + 1];
    if (!name || name.type !== "ident") continue;
    if (at(i + 2) !== "=") continue;
    if (at(i + 3) === "require" && at(i + 4) !== "." && at(i + 4) !== "(") {
      sites.push({ kind: "dynamic", specifier: null, line: t.line });
      continue;
    }
    // `const _require = createRequire(import.meta.url)`
    if (at(i + 3) === "createRequire" && at(i + 4) === "(") {
      aliasNames.add(name.value);
      continue;
    }
    // An alias OF an alias (`const r2 = _require`) is the same loader under a
    // third name; following it costs one line and leaving it would be a hole
    // this branch exists to close.
    if (
      at(i + 3) &&
      tokens[i + 3].type === "ident" &&
      aliasNames.has(at(i + 3))
    ) {
      aliasNames.add(name.value);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "ident") continue;
    // THREE load forms, because a form the walker does not RECOGNIZE is a
    // silent hole: it produces no deps entry, no refusal and no exemption line
    // — the closure verifies clean over code it never covered.
    //   require(…)             the bare form (`require.resolve` tokenizes as
    //                          three tokens and resolves identically)
    //   module.require(…)      the same loader reached through the module object
    //   import(…)              the dynamic-ESM form, literal or not
    // A `require` used as a plain property name (`x.require(...)`) is NOT a
    // load — `module.require` is the only member form recognized.
    const isBareRequire = t.value === "require" && at(i - 1) !== ".";
    const isModuleRequire =
      t.value === "require" && at(i - 1) === "." && at(i - 2) === "module";
    const isDynamicImport = t.value === "import" && at(i + 1) === "(";
    // require.resolve(<path>) — the file it RESOLVES is the file the caller then
    // executes; dispatch-main resolves hook-engine-worker.js this way.
    const isRequireResolve =
      t.value === "require" &&
      at(i + 1) === "." &&
      at(i + 2) === "resolve" &&
      at(i + 3) === "(";
    // new Worker(<path>) — a worker load IS an execution of that file, and the
    // walker missed it entirely: hook-engine-worker.js was invisible in every
    // runtime closure as a result.
    // require.call / require.apply — the loader reached through a Function
    // method; the specifier is the first argument after the call's own.
    const isRequireCall =
      t.value === "require" &&
      at(i + 1) === "." &&
      (at(i + 2) === "call" || at(i + 2) === "apply") &&
      at(i + 3) === "(";
    const isWorkerLoad =
      t.value === "Worker" && at(i - 1) === "new" && at(i + 1) === "(";
    if (isWorkerLoad) {
      // expectEnclosingClose=false: a Worker call takes MORE arguments after the
      // path (the options object), so requiring the enclosing `)` immediately —
      // correct for require(), which takes one argument — rejected every Worker
      // load and silently left hook-engine-worker.js dynamic.
      const parts = readDirnameJoin(tokens, i + 2, false, bindings, joinNames);
      if (parts) sites.push({ kind: "dirname-join", parts, line: t.line });
      else sites.push({ kind: "dynamic", specifier: null, line: t.line });
      continue;
    }
    if (isRequireResolve) {
      const parts = readDirnameJoin(tokens, i + 4, true, bindings, joinNames);
      if (parts) {
        sites.push({ kind: "dirname-join", parts, line: t.line });
        continue;
      }
      const argR = tokens[i + 4];
      if (
        argR &&
        argR.type === "string" &&
        argR.value.startsWith(".") &&
        (at(i + 5) === ")" || at(i + 5) === ",")
      ) {
        sites.push({ kind: "literal", specifier: argR.value, line: t.line });
        continue;
      }
      sites.push({ kind: "dynamic", specifier: null, line: t.line });
      continue;
    }
    if (isRequireCall) {
      // The specifier is NOT at a fixed offset: `require.call(thisArg, spec)`
      // puts a thisArg first, and `require.apply(thisArg, [spec])` wraps it in
      // an array. Reading tokens[i+4] alone resolved NEITHER and called both
      // dynamic, which is how this branch was first written.
      //
      // ONLY A STRING LITERAL IN THE SPECIFIER POSITION RESOLVES. The previous
      // revision counted ANY single string token in the argument window, so
      //     require.call(null, process.env.HOOK_IMPL || "./a.js")
      // resolved to ./a.js — the exact SUBSTITUTION bug the bound-const window
      // rule fixed elsewhere (`require(process.env.X || REL)`), reintroduced
      // here in a different spelling: a complete-looking closure over a module
      // that may never load. The thisArg is skipped by BALANCE, then the
      // specifier argument must BE a literal (for `apply`, a one-element array
      // holding one literal); every other shape is dynamic.
      const isApply = at(i + 2) === "apply";
      let j = i + 3;
      let depth = 0;
      for (; j < tokens.length; j++) {
        const v = tokens[j].value;
        if (v === "(" || v === "[") depth++;
        else if (v === ")" || v === "]") {
          depth--;
          if (depth === 0) break;
        } else if (depth === 1 && v === ",") break;
      }
      if (at(j) !== ",") {
        sites.push({ kind: "dynamic", specifier: null, line: t.line });
        continue;
      }
      j += 1;
      let specTok = tokens[j];
      let after;
      if (isApply) {
        if (at(j) !== "[") {
          sites.push({ kind: "dynamic", specifier: null, line: t.line });
          continue;
        }
        specTok = tokens[j + 1];
        after = at(j + 2);
        if (after !== "]") {
          sites.push({ kind: "dynamic", specifier: null, line: t.line });
          continue;
        }
        after = at(j + 3);
      } else {
        after = at(j + 1);
      }
      // Exactly one specifier argument: a trailing comma (or the close) proves it.
      if (
        specTok &&
        specTok.type === "string" &&
        (after === ")" || after === ",")
      ) {
        sites.push({ kind: "literal", specifier: specTok.value, line: t.line });
      } else {
        sites.push({ kind: "dynamic", specifier: null, line: t.line });
      }
      continue;
    }
    // ── the two load forms the closure could not see at all ──────────────────
    // SPAWN BY PATH: `spawnSync(process.execPath, [script, …])` EXECUTES the
    // script; a guard whose block verdict is decided by that child's exit was
    // pinned to nothing. Only the `process.execPath` form is read — a PATH
    // lookup (`spawnSync("node", …)`) names no file this walker can resolve,
    // and a non-node program is not a script of this tree.
    const isSpawnByPath =
      t.value &&
      SPAWN_FAMILY.has(t.value) &&
      at(i - 1) !== "." &&
      at(i + 1) === "(" &&
      at(i + 2) === "process" &&
      at(i + 3) === "." &&
      at(i + 4) === "execPath" &&
      at(i + 5) === "," &&
      at(i + 6) === "[";
    if (isSpawnByPath) {
      const script = readSpawnScript(
        tokens,
        i + 7,
        bindings,
        relative,
        spawnPaths,
        joinNames,
        selfPaths,
      );
      const end = endOfExpression(tokens, i + 7);
      const single =
        end < tokens.length && (at(end) === "," || at(end) === "]");
      if (script.kind === "self") continue;
      if (script.kind === "inline") {
        // The program is a STRING (pinned as part of this file's own bytes); the
        // only path it can name without being opaque is an interpolated binding.
        const pins = interpolationBindings(
          tokens,
          i + 7,
          bindings,
          relative,
          t.line,
          at,
        );
        if (pins.length) {
          pins.forEach((p) =>
            sites.push({ kind: p.kind, parts: p.parts, line: t.line }),
          );
          continue;
        }
        // NARROWED (operator ruling, 2026-10-08): an inline program with NO
        // interpolated path binding is NOT A LOAD — node -e "<text>" executes
        // text held in this file's own bytes and can name no file this walker
        // could resolve. Treating it as an unpinnable load refused the live tree
        // over programs that load nothing. An inline program that DOES
        // interpolate a binding is handled above and pinned from that binding.
        continue;
      }
      if (script.kind === "dynamic") {
        sites.push({
          kind: "dynamic",
          specifier: null,
          line: t.line,
          why: `spawn-by-path: ${script.why}`,
        });
        continue;
      }
      if (!single) {
        sites.push({
          kind: "dynamic",
          specifier: null,
          line: t.line,
          why: "spawn-by-path: the script argument is not a single expression",
        });
        continue;
      }
      sites.push({
        kind: script.kind,
        specifier: script.specifier,
        parts: script.parts,
        line: t.line,
      });
      continue;
    }
    // STATIC ESM: `import x from "./a.mjs"` / `import "./a.mjs"` /
    // `export * from "./a.mjs"` — each EXECUTES its target, and none produced a
    // site before this branch, so every `.mjs` file's import graph was invisible.
    // The guard is on the WHOLE branch, not a `continue` inside it: a dynamic
    // `import(…)` and an `import.meta` must FALL THROUGH to the branches below
    // (the dynamic-import form and the bound-const window rule), and an early
    // `continue` here silently stopped walking every computed `import(…)` — the
    // regression cases 69 and 74 caught.
    if (
      (t.value === "import" || t.value === "export") &&
      !(
        t.value === "import" &&
        (at(i - 1) === "." || at(i + 1) === "(" || at(i + 1) === ".")
      )
    ) {
      const spec = staticEsmSpecifier(tokens, i, at);
      if (spec !== null) {
        sites.push({ kind: "literal", specifier: spec, line: t.line });
        continue;
      }
    }
    // A createRequire RESULT CALLED AS A LOADER — walked exactly like a bare
    // require, so its arguments are read by the same rules below.
    if (aliasNames.has(t.value) && at(i + 1) === "(" && at(i - 1) !== ".") {
      const argA = tokens[i + 2];
      if (
        argA &&
        argA.type === "string" &&
        (at(i + 3) === ")" || at(i + 3) === ",")
      ) {
        sites.push({ kind: "literal", specifier: argA.value, line: t.line });
        continue;
      }
      if (argA && argA.type === "string") {
        sites.push({
          kind: "dynamic",
          specifier: null,
          line: t.line,
          why: `the specifier ${JSON.stringify(argA.value)} is only the head of a larger expression`,
        });
        continue;
      }
      const dirnameAlias = readDirnameJoin(
        tokens,
        i + 2,
        true,
        bindings,
        joinNames,
      );
      if (dirnameAlias) {
        sites.push({ kind: "dirname-join", parts: dirnameAlias, line: t.line });
        continue;
      }
      // A binding that IS the path — `const rel = path.join(here, "…", "x.js")`
      // then `_require(rel)`. The parts were resolved by the passes above; the
      // call must take that one identifier and nothing else, or it stays dynamic.
      if (
        argA &&
        argA.type === "ident" &&
        at(i + 3) === ")" &&
        bindings.has(argA.value, t.line) &&
        bindings.get(argA.value, t.line).length
      ) {
        sites.push({
          kind: "dirname-join",
          parts: bindings.get(argA.value, t.line),
          line: t.line,
        });
        continue;
      }
      // `_require(join(root, ".claude", …))` — a load named from the PROJECT
      // ROOT, which is how every bin script here reaches a repo file. Read by
      // the same reader the spawn form uses, so one rule covers both.
      const aliasRoot = readRootJoin(
        tokens,
        i + 2,
        bindings,
        relative,
        t.line,
        joinNames,
      );
      if (aliasRoot && aliasRoot.parts) {
        sites.push({ kind: "root-join", parts: aliasRoot.parts, line: t.line });
        continue;
      }
      if (at(i + 3) === ")") {
        const bound = readBoundPath(
          tokens,
          i + 2,
          bindings,
          relative,
          spawnPaths,
          t.line,
        );
        if (bound) {
          sites.push({ kind: bound.kind, parts: bound.parts, line: t.line });
          continue;
        }
      }
      sites.push({ kind: "dynamic", specifier: null, line: t.line });
      continue;
    }
    if (!isBareRequire && !isModuleRequire && !isDynamicImport) continue;
    if (at(i + 1) !== "(") continue;
    const arg = tokens[i + 2];
    // THE SPECIFIER MUST **BE** THE WHOLE ARGUMENT. A string that heads a
    // larger expression (`require("./a.js" + suffix)`) is not the path that
    // loads: at runtime the expression decides, so pinning the string resolves
    // the WRONG file with a complete-looking closure — the substitution class
    // F2 closed for bound consts and F1 re-opened here. The check mirrors case
    // 91's, which had it from the start.
    if (
      arg &&
      arg.type === "string" &&
      (at(i + 3) === ")" || at(i + 3) === ",")
    ) {
      sites.push({ kind: "literal", specifier: arg.value, line: t.line });
      continue;
    }
    if (arg && arg.type === "string") {
      sites.push({
        kind: "dynamic",
        specifier: null,
        line: t.line,
        why: `the specifier ${JSON.stringify(arg.value)} is only the head of a larger expression`,
      });
      continue;
    }
    // THE DOMINANT FORM IN THIS REPO:
    //   require(path.join(__dirname, "lib", "x.js"))
    // It is fully static — __dirname is the requiring file's own directory and
    // every other argument is a string literal — so treating it as dynamic
    // (the first revision did) silently emptied the deps closure for most
    // hooks, which is the failure the closure exists to prevent. Recognized
    // here for `path.join` / `path.resolve` / `path.posix.join` alike; the
    // `..` segments are resolved by the normalizer below.
    // The bindings map MUST reach the site call too: without it the anchor
    // branch cannot expand `path.join(HOOKS_DIR, "x")`, and every such site
    // degrades to dynamic.
    // `import(pathToFileURL(<path>).href)` — the ESM spelling of a dynamic
    // load, where the path expression sits one call deeper. Unwrap the URL
    // formatter and read the path inside it, or a repo file loaded this way
    // stays a hole. (The window rule below already knows `pathToFileURL` by
    // name; the READER did not, and reported every such site dynamic.)
    let argStart = i + 2;
    let innerClose = true;
    if (at(argStart) === "pathToFileURL" && at(argStart + 1) === "(") {
      argStart += 2;
      innerClose = false;
    }
    const dirnameJoin = readDirnameJoin(
      tokens,
      argStart,
      innerClose,
      bindings,
      joinNames,
    );
    if (dirnameJoin) {
      sites.push({ kind: "dirname-join", parts: dirnameJoin, line: t.line });
      continue;
    }
    // A ROOT-ANCHORED join (`join(root, ".claude", …)`) reads the same way here
    // as at the spawn sites — one rule, both load forms.
    const requireRootJoin = readRootJoin(
      tokens,
      argStart,
      bindings,
      relative,
      t.line,
      joinNames,
    );
    if (requireRootJoin && requireRootJoin.parts) {
      sites.push({
        kind: "root-join",
        parts: requireRootJoin.parts,
        line: t.line,
      });
      continue;
    }
    {
      const bound = readBoundPath(
        tokens,
        argStart,
        bindings,
        relative,
        spawnPaths,
        t.line,
      );
      if (bound && at(endOfExpression(tokens, argStart)) === ")") {
        sites.push({ kind: bound.kind, parts: bound.parts, line: t.line });
        continue;
      }
    }
    // BOUND CONST: a dynamic site whose argument names exactly ONE
    // __dirname-join binding resolves to it. Two candidate bindings stay
    // dynamic — a guess between them would pin the wrong file.
    // THE WINDOW MUST **BE** THE BINDING, not merely mention one. The earlier
    // form resolved on "exactly one known binding appears", which is silent and
    // WRONG for a runtime-selected expression:
    //     require(process.env.HOOK_IMPL || REL)
    // resolved to REL's target with a complete-looking closure, while at runtime
    // a different module loads — no deps entry, no dynamic site, no refusal.
    // (The old comment claimed a mis-read could "only ADD a pin"; that is FALSE
    // for an override: it SUBSTITUTES one.) An identifier is acceptable only
    // when it is a known binding, is a PROPERTY name (preceded by `.`, which
    // cannot change which variable is read), or is a module receiver this idiom
    // genuinely uses (`path`, `url`, `__dirname`). Any other bare identifier —
    // `process`, `globalThis`, a variable — means the expression can select a
    // different module at run time, and the site stays DYNAMIC.
    const windowIds = windowIdentifiers(tokens, i + 1);
    const windowHasJoin = windowIds.some(
      (w) => w.name === "join" || w.name === "resolve",
    );
    // The allowlist's CRITERION, so it does not grow by convenience: an entry is
    // a name that TRANSFORMS or NAMES a path without being able to SELECT one —
    // a module object, the file's own directory, or a path<->URL formatter. A
    // name that can select (process, a config object, a variable) never joins
    // this set.
    const MODULE_RECEIVERS = new Set([
      "path",
      "url",
      "__dirname",
      "pathToFileURL",
      "fileURLToPath",
    ]);
    const windowIsTheBinding =
      !windowHasJoin &&
      windowIds.length > 0 &&
      windowIds.every(
        (w) =>
          bindings.has(w.name, t.line) ||
          w.isProperty ||
          MODULE_RECEIVERS.has(w.name),
      );
    const boundNames = windowIsTheBinding
      ? windowIds.filter((w) => bindings.has(w.name, t.line)).map((w) => w.name)
      : [];
    if (boundNames.length === 1) {
      sites.push({
        kind: "dirname-join",
        parts: bindings.get(boundNames[0], t.line),
        line: t.line,
      });
      continue;
    }
    sites.push({ kind: "dynamic", specifier: null, line: t.line });
  }
  return { ok: true, error: null, sites };
}

/**
 * Recognize `path.join(__dirname, "a", "b.js"[, …])` (join OR resolve, posix
 * sub-object OR bare). Returns the string-literal parts, or null when the call
 * is anything else — a computed argument, a different function, or a first
 * argument that is not `__dirname`.
 *
 * Deliberately narrow: a `path.join(SOME_VAR, "x")` stays DYNAMIC and is
 * refused, because resolving it would be a guess.
 */
function readDirnameJoin(
  tokens,
  start,
  expectEnclosingClose = true,
  constParts = null,
  joinNames = null,
) {
  const at = (idx) => (tokens[idx] ? tokens[idx].value : undefined);
  // EVERY BINDING LOOKUP IS SITE-LOCAL: the maps answer with the nearest
  // declaration at or above THIS line, so a name re-bound in a later function
  // cannot resolve an earlier call (see bindingMap).
  const lineAt = tokens[start] ? tokens[start].line : 0;
  let i = start;
  if (at(i) === "path" && at(i + 1) === ".") {
    i += 2;
    if (at(i) === "posix" && at(i + 1) === ".") i += 2;
    if (at(i) !== "join" && at(i) !== "resolve") return null;
    i += 1;
  } else if (joinNames && joinNames.has(at(i)) && at(i + 1) === "(") {
    // `join(HERE, "..", "hooks", "lib", "x.js")` — the DESTRUCTURED spelling of
    // path.join, which is what the `.mjs` scripts here write. Only names bound
    // from the `path` module are in this set (see destructuredPathFuncs).
    i += 1;
  } else if (
    at(i) === "require" &&
    at(i + 1) === "(" &&
    tokens[i + 2] &&
    tokens[i + 2].type === "string" &&
    tokens[i + 2].value === "path" &&
    at(i + 3) === ")" &&
    at(i + 4) === "."
  ) {
    // `require("path").join(__dirname, …)` — the same call reached without a
    // top-level `path` binding. journal-write-guard.js writes it this way.
    i += 5;
    if (at(i) !== "join" && at(i) !== "resolve") return null;
    i += 1;
  } else {
    return null;
  }
  if (at(i) !== "(") return null;
  i += 1;
  // The anchor is __dirname, or a SAME-FILE binding that is itself
  // dirname-anchored (HOOKS_DIR = path.resolve(__dirname, "..")) — the
  // post-fix requires are written `path.join(HOOKS_DIR, "x.js")`, and reading
  // only the literal __dirname made every one of them unreadable. The parts of
  // such a binding are relative to THIS file's directory, which is the same
  // directory the call is in, so splicing them in is exact.
  let parts;
  if (at(i) === "__dirname") {
    parts = [];
  } else if (
    constParts &&
    tokens[i] &&
    tokens[i].type === "ident" &&
    constParts.has(tokens[i].value, lineAt)
  ) {
    parts = [...constParts.get(tokens[i].value, lineAt)];
  } else {
    return null;
  }
  i += 1;
  while (at(i) === ",") {
    // A TRAILING comma ( `…, "x.js",` then `)` ) ends the argument list; it is
    // not a missing argument. Reading it as one made every trailing-comma call
    // unresolvable, including the ecosystem-config loader that motivated this
    // recognizer at all.
    if (at(i + 1) === ")") break;
    i += 1;
    const tok = tokens[i];
    if (tok && tok.type === "string") {
      parts.push(tok.value);
      i += 1;
      continue;
    }
    // A SPREAD of an array-of-strings const ( `...ENGINE_REL` ), and a bare
    // identifier bound to a relative join ( `AUTHORITY_REL` ). Both are the
    // same bounded substitution: the const's parts splice in here. Refusing
    // them would leave two real hooks either permanently dynamic or
    // blanket-exempted, and a blanket exemption is a hole with no pin.
    if (constParts) {
      if (
        at(i) === "..." &&
        tokens[i + 1] &&
        tokens[i + 1].type === "ident" &&
        constParts.has(tokens[i + 1].value, lineAt)
      ) {
        parts.push(...constParts.get(tokens[i + 1].value, lineAt));
        i += 2;
        continue;
      }
      if (tok && tok.type === "ident" && constParts.has(tok.value, lineAt)) {
        parts.push(...constParts.get(tok.value, lineAt));
        i += 1;
        continue;
      }
    }
    return null;
  }
  // The break above leaves the cursor ON the trailing comma; step over it
  // before requiring the close, or the very next check rejects the very call
  // the trailing-comma handling exists for.
  if (at(i) === "," && at(i + 1) === ")") i += 1;
  if (at(i) !== ")") return null;
  // The enclosing `require(` must close next — allowing ONE optional trailing
  // comma, which is how these multi-line requires are actually written here:
  //     const { x } = require(
  //       path.join(__dirname, "lib", "x.js"),
  //     );
  // Requiring the `)` immediately reported every one of those as dynamic.
  if (!expectEnclosingClose) return parts;
  let j = i + 1;
  if (at(j) === ",") j += 1;
  if (at(j) !== ")") return null;
  return parts;
}

/**
 * @param {string} rootAbs absolute repo root
 * @param {string} entryRel repo-relative entry file (POSIX)
 * @returns {{ok: boolean, error: string|null, files: Array<{path: string, sha256: string}>,
 *            dynamic: Array<{file: string, line: number}>, externals: string[]}}
 */
function localRequireClosure(rootAbs, entryRel) {
  const visited = new Set();
  const files = [];
  const dynamic = [];
  const externals = new Set();
  const requireCache = new Map();
  // CONTAINMENT. Both sides resolve through the SAME resolver and the
  // comparison is on canonical forms, never on the lexical string
  // (rules/security.md § Path Containment — resolve BOTH candidate and
  // boundary root, fail closed if either will not resolve). Without this the
  // walker READS `require("../../../../etc/passwd")`, hashes it, and SHIPS the
  // path + digest in `deps[]` — a content oracle and a path leak in one, and a
  // direct contradiction of the rule. The boundary is the resolved root, so a
  // symlinked lib that points outside is refused for the same reason.
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootAbs);
  } catch (err) {
    return {
      ok: false,
      error: `cannot resolve the repo root ${rootAbs} (${err.message}) — refusing to walk a closure without a containment boundary`,
      files: [],
      dynamic: [],
      externals: [],
    };
  }
  // ENTRY CONTAINMENT — the entry is a read like any other. Every DEPENDENCY
  // below passes through this same resolver pair before it is read (the
  // realpath + relToRoot check in the loop); the entry did not, so an entry
  // spelled as a symlink pointing outside the tree was read, lexed and walked
  // with no containment at all — MEASURED, case 115's RED pole: the function
  // returned ok over the outside bytes. Resolve BOTH sides through the SAME
  // resolver and fail closed when either will not resolve
  // (rules/security.md § Path Containment), then queue the CANONICAL form so
  // the first loop iteration reads through the verified path. The in-tree
  // symlink is NOT refused wholesale: its canonical form is contained and it
  // walks normally (case 115's control pole).
  let entryReal;
  try {
    entryReal = fs.realpathSync(path.join(rootAbs, entryRel));
  } catch (err) {
    return {
      ok: false,
      error: `closure entry unreadable: ${entryRel}: ${err.message}`,
      files: [],
      dynamic: [],
      externals: [],
    };
  }
  const entryRelToRoot = path.relative(rootReal, entryReal);
  if (
    entryRelToRoot === "" ||
    entryRelToRoot.startsWith("..") ||
    path.isAbsolute(entryRelToRoot)
  ) {
    return {
      ok: false,
      error: `closure entry ${entryRel} resolves OUTSIDE the repo root (${entryReal}) — the closure entry is confined to this tree; reading it would walk content from outside the containment boundary`,
      files: [],
      dynamic: [],
      externals: [],
    };
  }
  const entryCanon = entryRelToRoot.split(path.sep).join("/");
  const queue = [entryCanon];
  while (queue.length) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    if (visited.size > MAX_CLOSURE_FILES) {
      return {
        ok: false,
        error: `require closure exceeds ${MAX_CLOSURE_FILES} files at ${rel} — refusing to emit a deps list that may be truncated`,
        files: [],
        dynamic: [],
        externals: [],
      };
    }
    const abs = path.join(rootAbs, rel);
    let raw;
    try {
      raw = fs.readFileSync(abs);
    } catch (err) {
      return {
        ok: false,
        error: `closure file unreadable: ${rel}: ${err.message}`,
        files: [],
        dynamic: [],
        externals: [],
      };
    }
    if (rel !== entryCanon) files.push({ path: rel, sha256: sha256Bytes(raw) });
    if (!/\.(js|cjs|mjs)$/.test(rel)) continue;
    let sites = requireCache.get(rel);
    if (!sites) {
      sites = requireSites(raw.toString("utf8"), {
        cjs: /\.(js|cjs)$/.test(rel),
      });
      requireCache.set(rel, sites);
    }
    if (!sites.ok) {
      return {
        ok: false,
        error: `cannot lex ${rel} for requires: ${sites.error}`,
        files: [],
        dynamic: [],
        externals: [],
      };
    }
    for (const site of sites.sites) {
      if (site.kind === "dynamic") {
        dynamic.push({
          file: rel,
          line: site.line,
          ...(site.why ? { why: site.why } : {}),
        });
        continue;
      }
      let spec;
      let base;
      if (site.kind === "root-join") {
        // A spawn script path assembled from the PROJECT ROOT. Resolved from the
        // root (not the spawner's directory) and, when it is not a file in this
        // tree, recorded as dynamic rather than refused outright: an anchor the
        // walker cannot prove is the root must not become a wrong pin, and the
        // exemption path is where a human states what it really is.
        base = path.posix.normalize(site.parts.join("/"));
        spec = base;
      } else {
        if (site.kind === "dirname-join") {
          spec = `./${site.parts.join("/")}`;
        } else {
          spec = site.specifier;
          if (!spec.startsWith("./") && !spec.startsWith("../")) {
            if (classifySpecifier(spec) === "unpinnable") {
              dynamic.push({
                file: rel,
                line: site.line,
                specifier: spec,
                why: "a local-path-shaped specifier the walker cannot resolve (it is not ./-relative)",
              });
              continue;
            }
            externals.add(spec);
            continue;
          }
        }
        base = path.posix.normalize(
          path.posix.join(path.posix.dirname(rel), spec),
        );
      }
      let found = null;
      for (const suffix of LOCAL_REQUIRE_SUFFIXES) {
        const candidate = base + suffix;
        if (
          fs.existsSync(path.join(rootAbs, candidate)) &&
          fs.statSync(path.join(rootAbs, candidate)).isFile()
        ) {
          found = candidate;
          break;
        }
      }
      if (!found) {
        if (site.kind === "root-join") {
          dynamic.push({
            file: rel,
            line: site.line,
            specifier: spec,
            why: "spawn-by-path",
          });
          continue;
        }
        return {
          ok: false,
          error: `${rel}:${site.line} requires ${JSON.stringify(spec)} which does not resolve to a file in this tree — the closure cannot be pinned`,
          files: [],
          dynamic: [],
          externals: [],
        };
      }
      let foundReal;
      try {
        foundReal = fs.realpathSync(path.join(rootAbs, found));
      } catch (err) {
        return {
          ok: false,
          error: `${rel}:${site.line} requires ${JSON.stringify(spec)} which will not resolve (${err.message}) — failing closed rather than pinning an unresolvable dependency`,
          files: [],
          dynamic: [],
          externals: [],
        };
      }
      const relToRoot = path.relative(rootReal, foundReal);
      if (
        relToRoot === "" ||
        relToRoot.startsWith("..") ||
        path.isAbsolute(relToRoot)
      ) {
        return {
          ok: false,
          error: `${rel}:${site.line} requires ${JSON.stringify(spec)}, which resolves OUTSIDE the repo root (${foundReal}) — the closure is confined to this tree; a dependency outside it cannot be pinned here and shipping its path or digest would leak both`,
          files: [],
          dynamic: [],
          externals: [],
        };
      }
      queue.push(relToRoot.split(path.sep).join("/"));
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    ok: true,
    error: null,
    files,
    dynamic,
    externals: [...externals].sort(),
  };
}

// ── the `@hook-contract` block parser ───────────────────────────────────────

/**
 * Extract the single `@hook-contract` block from a hook's source.
 *
 * Grammar (see `.claude/audit-fixtures/hook-registry/AUTHORING.md`): one line
 * whose only content is `@hook-contract`, optionally prefixed by the BLOCK
 * comment leader `*`, opens the block. A `// @hook-contract` line is NOT an
 * opener: the body-stripping below expects to run to a block-comment
 * terminator, so accepting a line-comment prefix made the opener half-match and
 * the body fail as "never closed" — a confusing error for a form the contract
 * never supported. The `//` form is now simply not a block (an earlier revision
 * accepted it as an opener); every following line up to the closing comment
 * terminator is the JSON body, with a leading `*` and one space stripped per
 * line.
 *
 * GOTCHA, and it has already bitten three times during authoring — twice in
 * hook blocks, once in this very comment: the two-character comment terminator
 * inside the body ENDS the comment, so a glob or a path spelled with a star
 * followed by a slash silently truncates the block (and usually breaks the
 * file's syntax too). Spell those shapes without the star
 * (`<mkdtemp-suffix>/`) instead.
 *
 * @returns {{ok: boolean, error: string|null, count: number, block: object|null}}
 */
function parseContractBlock(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `unreadable: ${err.message}`,
      count: 0,
      block: null,
    };
  }
  return parseContractBlockFromText(text);
}

/**
 * The parser proper, over TEXT. One implementation, because two copies of a
 * parse rule drift: the file reader above is a thin wrapper so a fixture can
 * drive a block string without writing a file, never a second grammar.
 */
function parseContractBlockFromText(text) {
  const lines = String(text).split("\n");
  const opens = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\*?\s*@hook-contract\s*$/.test(lines[i])) opens.push(i);
  }
  if (opens.length === 0)
    return {
      ok: false,
      error: "no @hook-contract block",
      count: 0,
      block: null,
    };
  if (opens.length > 1) {
    return {
      ok: false,
      error: `${opens.length} @hook-contract blocks (exactly one required)`,
      count: opens.length,
      block: null,
    };
  }
  const body = [];
  let closed = false;
  for (let j = opens[0] + 1; j < lines.length; j++) {
    if (/^\s*\*\/\s*$/.test(lines[j])) {
      closed = true;
      break;
    }
    body.push(lines[j].replace(/^\s*\*?\s?/, ""));
  }
  if (!closed)
    return {
      ok: false,
      error: "@hook-contract block is never closed",
      count: 1,
      block: null,
    };
  try {
    return {
      ok: true,
      error: null,
      count: 1,
      block: JSON.parse(body.join("\n")),
    };
  } catch (err) {
    return {
      ok: false,
      error: `@hook-contract body is not JSON: ${err.message}`,
      count: 1,
      block: null,
    };
  }
}

// ── [A] declaration validation ──────────────────────────────────────────────

const BLOCK_KEYS = Object.freeze([
  "side_effects",
  "idempotent",
  "may_rewrite_input",
  "timeout_exemption",
  "notes",
  "cost",
]);
const SIDE_EFFECT_KEYS = Object.freeze(["fs_writes", "network", "spawns"]);

/**
 * Does one declared write target have a legal shape?
 *
 * The rule is coarse and deliberately so — it is a SHAPE gate, never a
 * containment proof: no whitespace (prose belongs in `notes`), no `..`
 * segment, not absolute (an external target is spelled with a locator
 * prefix), and only path-ish characters. See the module header for what this
 * cannot see.
 */
const FS_WRITE_RE =
  /^(?![\s\S]*\s)(?![\s\S]*\.\.)(?!\/)[~<>A-Za-z0-9._*@+()/:-]+$/;

function fsWriteEntryError(entry) {
  if (typeof entry !== "string")
    return `fs_writes entry is ${typeof entry}, expected string`;
  if (entry.length === 0) return "fs_writes entry is empty";
  if (!FS_WRITE_RE.test(entry))
    return `fs_writes entry ${JSON.stringify(entry)} is not a legal write-target shape`;
  const m = /^<([^>]+)>/.exec(entry);
  if (m && !FS_WRITE_LOCATORS.includes(m[1])) {
    return `fs_writes entry ${JSON.stringify(entry)} names unknown locator <${m[1]}> (known: ${FS_WRITE_LOCATORS.join(", ")})`;
  }
  return null;
}

/**
 * Validate one parsed block. Every message names the defect and the fix; a
 * bare "invalid" would make the author re-derive the contract from this file.
 */
function validateContractBlock(block, fileForMessage) {
  const errors = [];
  const where = fileForMessage ? `${fileForMessage}: ` : "";
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return [`${where}@hook-contract must be a JSON object`];
  }
  for (const k of Object.keys(block)) {
    if (!BLOCK_KEYS.includes(k)) {
      errors.push(
        `${where}@hook-contract has unknown key "${k}" (allowed: ${BLOCK_KEYS.join(", ")}); derived fields belong to the emitter, not the block`,
      );
    }
  }
  const se = block.side_effects;
  if (se === null || typeof se !== "object" || Array.isArray(se)) {
    errors.push(`${where}@hook-contract.side_effects must be an object`);
  } else {
    for (const k of Object.keys(se)) {
      if (!SIDE_EFFECT_KEYS.includes(k)) {
        errors.push(
          `${where}side_effects has unknown key "${k}" (allowed: ${SIDE_EFFECT_KEYS.join(", ")}); declared_by is added by the emitter`,
        );
      }
    }
    if (!Array.isArray(se.fs_writes)) {
      errors.push(
        `${where}side_effects.fs_writes must be an array of path strings`,
      );
    } else {
      se.fs_writes.forEach((e, i) => {
        const err = fsWriteEntryError(e);
        if (err) errors.push(`${where}side_effects.fs_writes[${i}]: ${err}`);
      });
    }
    // `spawns` is a LIST of what is spawned (program basenames, as invoked),
    // not a boolean: a consumer deciding isolation needs to know WHICH child,
    // and `true` answers nothing about whether two rows collide on one child.
    if (!Array.isArray(se.spawns)) {
      errors.push(
        `${where}side_effects.spawns must be an ARRAY of program basenames (e.g. ["git"]), not a boolean — [] means it spawns nothing`,
      );
    } else {
      se.spawns.forEach((e, i) => {
        if (typeof e !== "string" || e.length === 0) {
          errors.push(
            `${where}side_effects.spawns[${i}] must be a non-empty program basename string`,
          );
        } else if (/\s/.test(e) || e.includes("/")) {
          errors.push(
            `${where}side_effects.spawns[${i}] ${JSON.stringify(e)} names a command line or a path — declare the PROGRAM BASENAME as invoked (["git"], not ["git rev-parse"], not ["/usr/bin/git"])`,
          );
        }
      });
    }
    if (typeof se.network !== "boolean")
      errors.push(`${where}side_effects.network must be a boolean`);
  }
  if (typeof block.idempotent !== "boolean")
    errors.push(`${where}idempotent must be a boolean`);
  // The rewrite declaration. `false` means the hook never returns
  // hookSpecificOutput.updatedInput; the emitter cross-checks it against the
  // source, because an UNDECLARED rewrite is a contract violation the consumer
  // turns into an INCOMPLETE row (a deny-class row then denies) — so a wrong
  // `false` here changes a verdict, not just a label.
  if (typeof block.may_rewrite_input !== "boolean") {
    errors.push(
      `${where}may_rewrite_input must be a boolean (declare whether the hook can return hookSpecificOutput.updatedInput)`,
    );
  }
  if (block.timeout_exemption !== undefined) {
    const te = block.timeout_exemption;
    if (te === null || typeof te !== "object" || Array.isArray(te)) {
      errors.push(
        `${where}timeout_exemption must be an object { "reason": "…" }`,
      );
    } else {
      for (const k of Object.keys(te)) {
        if (k !== "reason")
          errors.push(
            `${where}timeout_exemption has unknown key "${k}" (only "reason")`,
          );
      }
      if (typeof te.reason !== "string" || te.reason.trim().length < 10) {
        errors.push(
          `${where}timeout_exemption.reason must be a real sentence — an exempted timeout is a WEAKER contract than the row's own on_incomplete, and the reason is what a reviewer reads`,
        );
      }
    }
  }
  if (block.notes !== undefined && typeof block.notes !== "string") {
    errors.push(`${where}notes must be a string when present`);
  }
  if (block.cost !== undefined) {
    const c = block.cost;
    const need = ["p50_ms", "p95_ms", "platform", "method"];
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`${where}cost must be an object`);
    } else {
      for (const k of need) {
        if (c[k] === undefined)
          errors.push(
            `${where}cost.${k} is required — a MEASURED cost needs p50_ms, p95_ms, platform and method; omit cost entirely if unmeasured (never guess)`,
          );
      }
      for (const k of ["p50_ms", "p95_ms"]) {
        if (
          c[k] !== undefined &&
          !(typeof c[k] === "number" && Number.isFinite(c[k]) && c[k] >= 0)
        ) {
          errors.push(`${where}cost.${k} must be a non-negative number`);
        }
      }
      for (const k of ["platform", "method"]) {
        if (
          c[k] !== undefined &&
          !(typeof c[k] === "string" && c[k].length > 0)
        ) {
          errors.push(
            `${where}cost.${k} must be a non-empty string naming the platform/method it was measured on`,
          );
        }
      }
    }
  }
  return errors;
}

// ── the vendored JSON-Schema-subset validator ───────────────────────────────

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** Own-property access: `in` walks the prototype chain and is a bypass. */
function objectHas(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Keys that, if they ever reached an object's prototype, would change behaviour
 * rather than describe a row. A manifest never legitimately carries one; they
 * are refused by NAME as well as by own-property lookup, so the refusal does
 * not depend on the lookup being right.
 */
const UNSAFE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function matchesType(value, want) {
  const have = typeOf(value);
  if (want === "number") return have === "number" || have === "integer";
  if (want === "integer") return have === "integer";
  return have === want;
}

/**
 * Validate `data` against a draft-2020-12 schema SUBSET — exactly the keywords
 * `.claude/hooks/hook-registry.schema.json` uses. Unsupported keywords are a
 * hard error rather than a silent pass: a schema that quietly ignores a
 * keyword is a check that cannot fail.
 */
function validateAgainstSchema(data, schema, rootSchema, ptr, errors) {
  const path = ptr || "$";
  if (schema.$ref)
    return validateAgainstSchema(
      data,
      resolveRef(rootSchema, schema.$ref),
      rootSchema,
      path,
      errors,
    );
  const unsupported = Object.keys(schema).filter(
    (k) =>
      ![
        "$schema",
        "$id",
        "$defs",
        "$comment",
        "title",
        "description",
        "type",
        "required",
        "properties",
        "additionalProperties",
        "items",
        "enum",
        "const",
        "pattern",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "minLength",
        "minProperties",
        "default",
        "examples",
        "deprecated",
        "readOnly",
        "writeOnly",
      ].includes(k),
  );
  if (unsupported.length)
    errors.push(
      `${path}: schema uses unsupported keyword(s) ${unsupported.join(", ")} — extend validateAgainstSchema rather than letting them pass unchecked`,
    );
  if (
    schema.const !== undefined &&
    JSON.stringify(data) !== JSON.stringify(schema.const)
  ) {
    errors.push(
      `${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`,
    );
  }
  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!want.some((w) => matchesType(data, w))) {
      errors.push(`${path}: expected ${want.join("|")}, got ${typeOf(data)}`);
      return errors;
    }
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(data))
  ) {
    errors.push(
      `${path}: ${JSON.stringify(data)} is not one of ${JSON.stringify(schema.enum)}`,
    );
  }
  if (
    schema.pattern !== undefined &&
    typeof data === "string" &&
    !new RegExp(schema.pattern).test(data)
  ) {
    errors.push(
      `${path}: ${JSON.stringify(data)} does not match ${schema.pattern}`,
    );
  }
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum)
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum)
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
  }
  if (
    typeof data === "string" &&
    schema.minLength !== undefined &&
    data.length < schema.minLength
  ) {
    errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems)
      errors.push(
        `${path}: ${data.length} items < minItems ${schema.minItems}`,
      );
    if (schema.maxItems !== undefined && data.length > schema.maxItems)
      errors.push(
        `${path}: ${data.length} items > maxItems ${schema.maxItems}`,
      );
    if (schema.items !== undefined)
      data.forEach((v, i) =>
        validateAgainstSchema(
          v,
          schema.items,
          rootSchema,
          `${path}[${i}]`,
          errors,
        ),
      );
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    if (
      schema.minProperties !== undefined &&
      Object.keys(data).length < schema.minProperties
    ) {
      errors.push(
        `${path}: ${Object.keys(data).length} properties < minProperties ${schema.minProperties}`,
      );
    }
    for (const req of schema.required || []) {
      if (!objectHas(data, req))
        errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties || {};
    // OWN PROPERTIES ONLY, and never the prototype-chain names. `k in props`
    // resolves through Object.prototype, so a document carrying `__proto__`,
    // `constructor`, `toString` … would find a "declared property" for a key
    // the schema does not declare — an additionalProperties:false bypass at
    // EVERY level, reachable from parsed JSON. Those names are refused
    // outright as well: a manifest key that can reach the prototype is never
    // legitimate here.
    const extra = Object.keys(data).filter((k) => !objectHas(props, k));
    const dangerous = Object.keys(data).filter((k) => UNSAFE_KEYS.has(k));
    if (dangerous.length) {
      errors.push(
        `${path}: prototype-chain key(s) refused: ${dangerous.join(", ")} — a manifest key that can reach Object.prototype is never legitimate and used to bypass additionalProperties:false`,
      );
    }
    if (schema.additionalProperties === false) {
      const shown = extra.filter((k) => !UNSAFE_KEYS.has(k));
      if (shown.length)
        errors.push(
          `${path}: additional propert${shown.length === 1 ? "y" : "ies"} not allowed: ${shown.join(", ")}`,
        );
    }
    for (const k of Object.keys(props)) {
      if (objectHas(data, k))
        validateAgainstSchema(
          data[k],
          props[k],
          rootSchema,
          `${path}.${k}`,
          errors,
        );
    }
  }
  return errors;
}

function resolveRef(root, ref) {
  if (!ref.startsWith("#/"))
    throw new Error(`unsupported $ref ${ref} (only local #/ pointers)`);
  return ref
    .slice(2)
    .split("/")
    .reduce(
      (acc, seg) => acc[seg.replace(/~1/g, "/").replace(/~0/g, "~")],
      root,
    );
}

function schemaPath(root) {
  return path.resolve(__dirname, "..", "hook-registry.schema.json");
}

function loadSchema(root) {
  return JSON.parse(fs.readFileSync(schemaPath(root), "utf8"));
}

// ── manifest validation (schema + the cross-field invariants) ───────────────

const SHA256_RE = /^[0-9a-f]{64}$/;
const SOURCE_SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^hk_[0-9a-f]{16}$/;

/**
 * Validate an entire manifest.
 *
 * Two layers, and BOTH must pass:
 *   1. the JSON Schema file (loaded from disk, never restated) — shape.
 *   2. the CROSS-FIELD invariants a schema cannot express — the content hash
 *      actually recomputes, `version`'s major equals the `$id`'s, every id is
 *      the stable derivation of its own row, order is unique per event, and
 *      an `on_incomplete` of null is only legal where the manifest default
 *      and the dispatcher's fail-closed default AGREE (a null the two
 *      contracts would read differently is the exact bug this refuses).
 *
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
/**
 * The `unknown_major_policy: "fail-closed"` enforcement point.
 *
 * A consumer that does not implement the document's major MUST refuse the
 * whole document. Reading the fields it happens to recognize and ignoring the
 * rest is how an unknown-major document gets obeyed anyway — the manifest
 * says `fail-closed` in its own text, so this is where that promise is kept.
 *
 * @returns {string|null} the refusal reason, or null when the major is known.
 */
function checkSupportedMajor(doc) {
  const m = String((doc && doc.$id) || "").match(/\/v(\d+)$/);
  if (!m) {
    return `$id ${JSON.stringify(doc && doc.$id)} does not end in /v<major> — a consumer cannot tell which major it is reading, which is the state fail-closed exists to prevent`;
  }
  const major = Number(m[1]);
  if (major !== SUPPORTED_MAJOR) {
    return `unknown major v${major}: this implementation implements v${SUPPORTED_MAJOR}, and the document's own unknown_major_policy ("${UNKNOWN_MAJOR_POLICY}") requires refusing it rather than reading the fields it recognizes`;
  }
  return null;
}

function validateManifest(doc, opts = {}) {
  const errors = [];
  const warnings = [];
  // DENIALS, NOT THROWS. A validator fed a malformed document must return
  // {valid:false, errors:[…]}; a throw is indistinguishable from a crash to the
  // caller and turns "this document is wrong" into "the checker broke".
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      valid: false,
      errors: [`$: expected an object, got ${typeOf(doc)}`],
      warnings,
    };
  }
  // THE STRICT CHECKS LIVE HERE, not only in the CLI. They were reachable ONLY
  // from the `validate` subcommand, so every caller that parsed the document
  // ITSELF — the emitter's self-check, a consumer's harness, `require()` of
  // this module — validated a document whose duplicate keys, lone surrogates
  // and non-integer numbers had already been flattened by JSON.parse. Two
  // halves, because they answer different questions:
  //   - the OBJECT sweep runs ALWAYS (a float or a surrogate is still visible
  //     after parsing, whoever parsed it);
  //   - the TEXT scan runs when the caller passes `opts.text`, because a
  //     duplicate key exists only in the bytes and is unrecoverable afterwards.
  const unrepresentable = findUnrepresentable(doc, "$");
  if (unrepresentable) errors.push(unrepresentable);
  if (typeof opts.text === "string") {
    const strict = parseStrictJson(opts.text);
    if (!strict.ok) errors.push(`$: ${strict.error}`);
  }
  const majorRefusal = checkSupportedMajor(doc);
  if (majorRefusal) return { valid: false, errors: [majorRefusal], warnings };
  let schema;
  try {
    schema = opts.schema || loadSchema();
  } catch (err) {
    return {
      valid: false,
      errors: [`schema unreadable: ${err.message}`],
      warnings,
    };
  }
  validateAgainstSchema(doc, schema, schema, "$", errors);

  const idMajor = String(doc.$id || "").match(/\/v(\d+)$/);
  if (!idMajor) {
    errors.push(`$id ${JSON.stringify(doc.$id)} does not end in /v<major>`);
  } else if (typeof doc.version === "string") {
    const vMajor = doc.version.split(".")[0];
    if (vMajor !== idMajor[1]) {
      errors.push(
        `version ${doc.version} has major ${vMajor} but $id declares major ${idMajor[1]} — the document's identity and its version MUST agree`,
      );
    }
  }
  if (doc.unknown_major_policy !== UNKNOWN_MAJOR_POLICY) {
    errors.push(
      `unknown_major_policy must be "${UNKNOWN_MAJOR_POLICY}" — a manifest that lets an unknown major through is not fail-closed`,
    );
  }
  if (typeof doc.content_sha256 === "string") {
    // DENIALS, NEVER THROWS — including here. contentSha256 canonicalizes with
    // RFC 8785, which REJECTS a non-integer, so a document carrying a float made
    // the validator THROW: "this document is wrong" became "the checker broke".
    let want = null;
    try {
      want = contentSha256(doc);
    } catch (err) {
      errors.push(`content_sha256 cannot be recomputed: ${err.message}`);
      want = null;
    }
    if (want !== null && doc.content_sha256 !== want) {
      errors.push(
        `content_sha256 does not recompute: declared ${doc.content_sha256}, computed ${want} (the document was edited after emission, or canonical JSON differs)`,
      );
    }
  }
  if (
    doc.default_on_incomplete &&
    typeof doc.default_on_incomplete === "object"
  ) {
    for (const [event, outcome] of Object.entries(doc.default_on_incomplete)) {
      // THE DISPATCHER'S DEFAULT IS `ROW_ON_INCOMPLETE_DEFAULT`, not the
      // per-event map: naming the map here was the same mix-up the null check
      // above carried, and a warning that misnames the authority is worse than
      // no warning — it tells a reader the document was checked against a
      // contract it was never compared with.
      if (EVENT_DEFAULTS[event] !== outcome) {
        warnings.push(
          `default_on_incomplete.${event}=${JSON.stringify(outcome)} differs from this contract's standard map (${JSON.stringify(EVENT_DEFAULTS[event])}); note the DISPATCHER reads a null (and every value but "continue") as ${JSON.stringify(DISPATCHER_ON_INCOMPLETE_DEFAULT)} at every event, so a row deferring to this entry is read two ways unless the entry itself is ${JSON.stringify(DISPATCHER_ON_INCOMPLETE_DEFAULT)}`,
        );
      }
    }
  }

  const seenIds = new Map();
  const orderByEvent = new Map();
  const rows = Array.isArray(doc.hooks) ? doc.hooks : [];
  rows.forEach((row, i) => {
    const at = `$.hooks[${i}]`;
    // A null / scalar entry is a SHAPE error the schema layer already reports;
    // reading through it here is how a validator throws.
    if (row === null || typeof row !== "object" || Array.isArray(row)) return;
    if (row.file === undefined || row.event === undefined) return;
    const wantId = rowId(
      row.event,
      row.matcher === undefined ? null : row.matcher,
      row.file,
    );
    if (row.id !== wantId)
      errors.push(
        `${at}.id ${JSON.stringify(row.id)} is not the stable derivation of its row (expected ${wantId})`,
      );
    if (seenIds.has(row.id))
      errors.push(
        `${at}.id duplicates ${seenIds.get(row.id)} — ids must be unique`,
      );
    else seenIds.set(row.id, at);
    const okey = `${row.event}\u0000${row.order}`;
    if (orderByEvent.has(okey))
      errors.push(
        `${at}.order ${row.order} duplicates ${orderByEvent.get(okey)} within event ${row.event}`,
      );
    else orderByEvent.set(okey, at);
    if (row.on_incomplete === null) {
      // A NULL IS A DEFERRAL, AND A DEFERRAL IS ONLY SAFE WHEN BOTH READERS READ
      // IT THE SAME WAY. Two different maps are in play and the first revision
      // compared the WRONG ONE: `doc.default_on_incomplete` is the MANIFEST's
      // own map, and the value it must agree with is the DISPATCHER's default —
      // `ROW_ON_INCOMPLETE_DEFAULT` in lib/dispatch-registry.js, which resolves
      // every value that is not the exact string "continue" (null included) to
      // "deny", at EVERY event. Comparing the manifest map against
      // `EVENT_DEFAULTS[event]` instead compares the document with a copy of
      // itself, so the check passed whenever the two copies agreed — including
      // at PostToolUse, where the manifest says "continue", the dispatcher says
      // "deny", and a `null` is read two ways. That is the divergence this
      // branch exists to refuse, and it was inverted.
      const declared = doc.default_on_incomplete
        ? doc.default_on_incomplete[row.event]
        : undefined;
      if (declared === undefined) {
        errors.push(
          `${at}.on_incomplete is null and default_on_incomplete has no entry for ${row.event} — the row's incomplete-run behaviour would be undefined`,
        );
      } else if (declared !== DISPATCHER_ON_INCOMPLETE_DEFAULT) {
        errors.push(
          `${at}.on_incomplete is null, but the manifest's default for ${row.event} is ${JSON.stringify(declared)} while the dispatcher reads a null (and any value that is not "continue") as ${JSON.stringify(DISPATCHER_ON_INCOMPLETE_DEFAULT)} — the two contracts read this null differently, so declare the value explicitly`,
        );
      }
    }
    // NEVER WEAKER THAN THE ROW'S OWN CONTRACT. `deny` is the strong value; a
    // `continue` crash/timeout contract under a `deny` row is a guard that
    // answers "allow" by failing, which is exactly the fail-open shape this
    // contract exists to make visible. on_crash may not weaken at all; a
    // weakened on_timeout is legal ONLY with a declared `timeout_exemption`,
    // and it is then SURFACED as a warning rather than passed in silence.
    const rank = { deny: 1, continue: 0 };
    // RESOLVE the null BEFORE ranking. `on_incomplete: null` means "the manifest
    // default applies", so ranking against the literal null ranked against
    // nothing and let a weaker on_crash/on_timeout through on exactly the rows
    // that defer — the fail-open hole the rank check exists to close.
    const declaredDefault = doc.default_on_incomplete
      ? doc.default_on_incomplete[row.event]
      : undefined;
    const effectiveIncomplete =
      row.on_incomplete === null ? declaredDefault : row.on_incomplete;
    const weaker = (v) =>
      typeof v === "string" &&
      typeof effectiveIncomplete === "string" &&
      rank[v] < rank[effectiveIncomplete];
    if (weaker(row.on_crash)) {
      errors.push(
        `${at}.on_crash (${row.on_crash}) is WEAKER than on_incomplete (${row.on_incomplete}) — a crash contract may never weaken a row's own contract`,
      );
    }
    if (weaker(row.on_timeout)) {
      if (
        !row.timeout_exemption ||
        typeof row.timeout_exemption.reason !== "string"
      ) {
        errors.push(
          `${at}.on_timeout (${row.on_timeout}) is WEAKER than on_incomplete (${row.on_incomplete}) without a declared timeout_exemption {reason}`,
        );
      } else {
        warnings.push(
          `${at}: SURFACED timeout exemption on ${row.event} ${row.file} — on_timeout ${row.on_timeout} < on_incomplete ${row.on_incomplete}: ${row.timeout_exemption.reason}`,
        );
      }
    }
    // "Never implicit" applies when the ROW declared a concrete on_incomplete:
    // then the emitter resolves crash/timeout to it and a null is a defect. When
    // on_incomplete is ITSELF null the whole contract defers to
    // default_on_incomplete, and a null crash/timeout is that same deferral —
    // flagging it would make the legal deferral unrepresentable.
    if (typeof row.on_incomplete === "string") {
      if (row.on_crash === null) {
        errors.push(
          `${at}.on_crash is null while on_incomplete is ${JSON.stringify(row.on_incomplete)} — the emitter resolves crash behaviour, it never leaves it implicit`,
        );
      }
      if (row.on_timeout === null) {
        errors.push(
          `${at}.on_timeout is null while on_incomplete is ${JSON.stringify(row.on_incomplete)} — the emitter resolves timeout behaviour, it never leaves it implicit`,
        );
      }
    }
    // A DENY-CAPABLE PreToolUse ROW MUST BE deny/deny. A guard that can refuse
    // must not be able to answer "allow" by not running.
    if (
      row.event === "PreToolUse" &&
      row.contract &&
      row.contract.protocol &&
      row.contract.protocol.severity === "block" &&
      effectiveIncomplete !== "deny"
    ) {
      errors.push(
        `${at}: a deny-capable PreToolUse row has on_incomplete ${JSON.stringify(row.on_incomplete)} — it MUST be "deny" (an incomplete deny-capable check refuses rather than passing)`,
      );
    }
    // pool is the DERIVATION of source, never a second opinion about it.
    if (
      typeof row.source === "string" &&
      row.pool !== undefined &&
      POOL_BY_SOURCE[row.source] !== undefined &&
      row.pool !== POOL_BY_SOURCE[row.source]
    ) {
      errors.push(
        `${at}.pool ${JSON.stringify(row.pool)} contradicts source ${JSON.stringify(row.source)} — pool is DERIVED (${row.source} ⇒ ${POOL_BY_SOURCE[row.source]}), never hand-set`,
      );
    }
    if (
      typeof row.file_sha256 === "string" &&
      !SHA256_RE.test(row.file_sha256)
    ) {
      errors.push(`${at}.file_sha256 is not a lowercase 64-hex sha256`);
    }
    if (
      row.contract &&
      row.contract.protocol &&
      typeof row.contract.protocol.severity === "string"
    ) {
      const advisoryOnly = ADVISORY_ONLY_EVENTS.includes(row.event);
      if (advisoryOnly && row.contract.protocol.severity === "block") {
        errors.push(
          `${at}: severity "block" at ${row.event}, where the host reads exit 2 / decision:"block" as a user-facing error and NOT as a refusal (hook-engine.js § ADVISORY_ONLY)`,
        );
      }
    }
  });
  // CONTAINMENT, on BOTH deps arrays, in the VALIDATOR — because the schema's
  // pattern is a lexical check on a document a consumer may be handed EDITED.
  // The two arrays are produced by one walker and carry one trust; a gate on
  // one of them is a gate on nothing. Strictness matches the schema pattern: a
  // leading slash or a FULL `..` segment is refused, `...` (a legitimate
  // filename) passes.
  const badDepPath = (v) =>
    typeof v === "string" &&
    ((v.startsWith("/") ? true : false) || v.split("/").includes(".."));
  const depArrays = [
    ...(Array.isArray(doc.hooks)
      ? doc.hooks.map((r, i) => [`$.hooks[${i}].deps`, r && r.deps])
      : []),
    ...(Array.isArray(doc.runtimes)
      ? doc.runtimes.map((r, i) => [`$.runtimes[${i}].deps`, r && r.deps])
      : []),
  ];
  // EVERY RUNTIME ENTRY THE CONTRACT NAMES MUST BE PRESENT. The schema's
  // minItems is a COUNT, and a count cannot say WHICH: three entries that omit
  // the supervisor (or the adapter) satisfy it while shipping exactly the
  // transitive-integrity hole `runtimes[]` exists to close. The set is read from
  // RUNTIME_ENTRIES, so adding an entry to the contract cannot leave the
  // validator behind, and a document is refused until its emitter is updated.
  if (Array.isArray(doc.runtimes)) {
    const present = new Set(doc.runtimes.map((r) => r && r.entry));
    for (const want of RUNTIME_ENTRIES) {
      if (!present.has(want)) {
        errors.push(
          `$.runtimes is missing the required entry ${JSON.stringify(want)} — a manifest whose runtime pins omit it verifies every row through an adapter it never pinned`,
        );
      }
    }
  }
  for (const [at, deps] of depArrays) {
    if (!Array.isArray(deps)) continue;
    deps.forEach((d, j) => {
      if (d && badDepPath(d.path)) {
        errors.push(
          `${at}[${j}].path ${JSON.stringify(d.path)} escapes or is absolute — every pinned dependency is a repo-relative path inside this tree`,
        );
      }
    });
  }

  if (
    typeof doc.source_sha === "string" &&
    !SOURCE_SHA_RE.test(doc.source_sha)
  ) {
    errors.push(
      `source_sha ${JSON.stringify(doc.source_sha)} is not a 40-hex commit sha`,
    );
  }
  if (
    Array.isArray(doc.hooks) &&
    doc.hooks.some((r) => r && r.source === "loom-template") &&
    Array.isArray(doc.hooks)
  ) {
    // A loom-template row whose file is absent from the emitted tree would be
    // a row the consumer can never verify; the EMITTER checks that (it has the
    // delivery plan). Here we only note the count for a reader.
    warnings.push(`manifest carries ${doc.hooks.length} rows`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const [cmd, file] = argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || !cmd) {
    process.stdout.write(
      [
        "hook-registry-contract — validate a loom.hook-registry/v1 manifest",
        "",
        "  node .claude/hooks/lib/hook-registry-contract.js validate <manifest.json>",
        "  node .claude/hooks/lib/hook-registry-contract.js hash <manifest.json>   # recompute content_sha256",
        "  node .claude/hooks/lib/hook-registry-contract.js block <hook.js>        # parse+validate one @hook-contract",
        "",
        "Exit codes: 0 = valid, 1 = invalid, 2 = usage/unreadable.",
        "",
      ].join("\n"),
    );
    return cmd ? 0 : 2;
  }
  if (cmd === "hash") {
    if (!file) return usage("hash needs a manifest path");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      return usage(`unreadable manifest: ${err.message}`);
    }
    // THE SAME STRICT PARSE `validate` USES, because the hash is what a pin is
    // compared against: `JSON.parse` collapses duplicate keys last-wins, so a
    // document a human reads as one thing hashed as another and the recomputed
    // digest AGREED with a document the validator refuses. A hash command that
    // can print a digest for an unparseable document is an oracle for a
    // document that has no canonical form.
    const strict = parseStrictJson(text);
    if (!strict.ok) {
      process.stderr.write(`INVALID $: ${strict.error}\n`);
      return 1;
    }
    let digest;
    try {
      digest = contentSha256(strict.value);
    } catch (err) {
      // The canonicalizer refuses what it cannot represent (see canonicalJson);
      // that is a DENIAL about the document, not a crash of the tool.
      process.stderr.write(`INVALID $: ${err.message}\n`);
      return 1;
    }
    process.stdout.write(`${digest}\n`);
    return 0;
  }
  if (cmd === "block") {
    if (!file) return usage("block needs a hook path");
    const parsed = parseContractBlock(file);
    if (!parsed.ok) {
      process.stderr.write(`${file}: ${parsed.error}\n`);
      return 1;
    }
    const errs = validateContractBlock(parsed.block, file);
    if (errs.length) {
      errs.forEach((e) => process.stderr.write(`${e}\n`));
      return 1;
    }
    process.stdout.write(`${file}: @hook-contract OK\n`);
    return 0;
  }
  if (cmd !== "validate") return usage(`unknown command ${cmd}`);
  if (!file) return usage("validate needs a manifest path");
  // STRICT parse, not JSON.parse: a duplicate key, a lone surrogate or a
  // non-integer number is refused HERE, before any field is read — the hash
  // covers a canonical form, and a document that does not canonicalize must
  // never reach the field checks.
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(`unreadable manifest: ${err.message}\n`);
    return 2;
  }
  const strict = parseStrictJson(text);
  if (!strict.ok) {
    process.stderr.write(`INVALID $: ${strict.error}\n`);
    return 1;
  }
  const doc = strict.value;
  const { valid, errors, warnings } = validateManifest(doc, { text });
  warnings.forEach((w) => process.stderr.write(`warn: ${w}\n`));
  errors.forEach((e) => process.stderr.write(`INVALID ${e}\n`));
  process.stdout.write(
    valid
      ? `valid: ${file} (${doc.hooks ? doc.hooks.length : 0} rows)\n`
      : `invalid: ${file} (${errors.length} error(s))\n`,
  );
  return valid ? 0 : 1;
}

function usage(msg) {
  process.stderr.write(`${msg}\n`);
  return 2;
}

module.exports = {
  SCHEMA_ID,
  SCHEMA_VERSION,
  SUPPORTED_MAJOR,
  UNKNOWN_MAJOR_POLICY,
  PRECEDENCE,
  GENERATED_BY,
  MANIFEST_REL,
  SCHEMA_REL,
  EVENT_ORDER,
  EVENT_DEFAULTS,
  DISPATCHER_ON_INCOMPLETE_DEFAULT,
  PROTOCOL_KIND_BY_EVENT,
  ADVISORY_ONLY_EVENTS,
  SURFACES,
  PAYLOAD_DIALECT_BY_SURFACE,
  SOURCES,
  FS_WRITE_LOCATORS,
  DECLARED_BY,
  FS_WRITE_RE,
  canonicalJson,
  sha256Hex,
  sha256Bytes,
  parseStrictJson,
  contentSha256,
  rowId,
  checkSupportedMajor,
  requireSites,
  filenameAnchorProven,
  classifySpecifier,
  localRequireClosure,
  POOL_BY_SOURCE,
  RUNTIME_ENTRIES,
  MANIFEST_SIG_REL,
  parseContractBlock,
  parseContractBlockFromText,
  validateContractBlock,
  fsWriteEntryError,
  validateManifest,
  validateAgainstSchema,
  loadSchema,
  schemaPath,
};

if (require.main === module) process.exit(main(process.argv));
