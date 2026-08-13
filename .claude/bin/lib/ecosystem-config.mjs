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
 *                          (null in canon — canon is the root). Its `url` MAY
 *                          carry a credential — sync-from-canon-fetch.mjs
 *                          documents the `https://x-access-token:TOKEN@host/…`
 *                          form as supported — so it is read RAW server-side via
 *                          getUpstreamCanon() and redacted on the display path
 *                          by getEcosystemConfig(), same discipline as (6).
 *                          SCOPED, because the redactor's coverage is: that
 *                          holds for the USERINFO form above (measured:
 *                          `https://x-access-token:<redacted>@github.com/o/r.git`)
 *                          and for a `password=` query parameter. It does NOT
 *                          hold for the query-parameter credential spellings
 *                          redactReservoirLocator lists under its own § NOT
 *                          COVERED — `?access_token=`, `?token=`, `?secret=`,
 *                          `?apikey=` all reach the display view INTACT
 *                          (measured). Those forms are out of scope, named here
 *                          rather than covered by an unqualified claim
 *                          (zero-tolerance R3e).
 *    (6) rag               the per-ecosystem RAG accountability-store pointer
 *                          {reservoir_locator, tenant_id}. reservoir_locator is
 *                          a DSN that MAY carry a credential (Mode-2 Postgres):
 *                          read SERVER-SIDE via getRagReservoirLocator(); ANY
 *                          view/log surface routes through the credential-redacted
 *                          projection (INV-2 "never surface a secret VALUE").
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

// ────────────────────────────────────────────────────────────────
// The display PROJECTION (#1351).
//
// Recursively route every string VALUE in the config through the credential
// redactor, returning a fresh deep copy so the memoized cache keeps the RAW
// value for the SERVER-SIDE accessors that must actually connect or fetch.
//
// WHY RECURSE RATHER THAN REJECT (the #1351 Gap-A decision, recorded here
// because the issue left the choice open): the alternative was to make
// loadRag() fail LOUD on any `rag` member that is not a declared string.
// Rejected for two reasons.
//   1. loadRag() sits on the SERVER-SIDE path too (getRagReservoirLocator,
//      getRagTenantId). Rejecting there would turn a DISPLAY-hygiene concern
//      into a hard failure of the resolution path for a deployment that
//      already works — the display gap would take down the connection.
//   2. redactReservoirLocator() is a documented no-op on non-DSN strings (see
//      its § contract), so recursion cannot damage a legitimate scalar, while
//      a reject is a breaking schema change for any config already carrying a
//      nested member.
// Recursion also delivers what the doc claim above getEcosystemConfig()
// promises: coverage BY CONSTRUCTION for field shapes nobody has declared yet.
// An enumeration of known credential fields cannot do that — a narrow
// projection wearing a broad claim is the exact defect #1351 reported.
//
// The cost is accepted OVER-redaction, not under-redaction. Two instances, both
// cosmetic on a view surface where the opposite error leaks a real credential:
//   (a) a prose/doc string that merely CONTAINS a synthetic DSN (the `_README`
//       block) shows `<redacted>` in the display view.
//   (b) a `:`-less URL userinfo is redacted WHOLE, because a bare userinfo token
//       may itself be the credential (`https://TOKEN@host/…` is a real form).
//       That rule cannot tell a token from a USERNAME, so the ordinary
//       `ssh://git@github.com/org/repo.git` renders as
//       `ssh://<redacted>@github.com/…` (measured) — anywhere in the config,
//       `upstream_canon.url` included, where `git` is plainly not a secret. The
//       SCP-style spelling `git@github.com:org/repo.git` carries no `://`, so it
//       is left byte-identical (measured); the two spellings of the same remote
//       therefore display differently. Accepted rather than fixed: narrowing to
//       an allowlist of known-benign usernames would fail OPEN the first time a
//       deployment used a real token in that position.
//
// BOUNDED: JSON.parse cannot produce a cyclic object, so a cycle is impossible
// by construction on this input rather than merely defended against — but the
// depth cap makes the bound STRUCTURAL instead of assumed. Anything that would
// otherwise recurse without limit (a cycle, or a pathologically deep config)
// hits the cap and yields the sentinel instead of blowing the stack.
//
// COST — the redactor's INPUT SET IS WIDER HERE THAN WHERE ITS COST WAS
// ACCEPTED, so do not inherit that acceptance without re-deriving it. The
// quadratic-risk note in § the cost guard (below, on `nextSep`) was written when
// redactReservoirLocator ran on ONE or TWO rag DSNs. This projection routes
// EVERY string value at EVERY depth through it, so the accepted worst case now
// applies once per string rather than once per config. Re-measured on THIS
// path, not assumed:
//   * the real ecosystem.example.json — 5811 B, 90 string values, longest 82
//     chars — projects in 0.141 ms/call (200 warm iterations). Not a concern.
//   * the adversarial shape the guard does NOT cover — a 32 KB separator-free
//     run FOLLOWED by a `://` — costs 575 ms for that single value. With the
//     guard armed (no `://` after the run) the same 32 KB costs 15 ms.
// The acceptance still holds, for the SAME reason and now with the wider input
// measured: ecosystem.json is an operator-owned local file, not network input,
// so the pathological value is one the operator would have to write into their
// own config. What changed is only that a config carrying MANY such values
// would pay the cost per value; a real one carries none.
// ────────────────────────────────────────────────────────────────

// Depth cap for the display projection. Far above any real ecosystem.json
// (canon's deepest path is 3 levels), so it never fires on a legitimate config.
const MAX_PROJECTION_DEPTH = 32;

// Emitted in place of a subtree deeper than MAX_PROJECTION_DEPTH. Fails CLOSED
// (the raw subtree is never emitted) and is VISIBLE in the output, so it is a
// loud substitution rather than a silent fallback (zero-tolerance R3).
const UNPROJECTABLE_SUBTREE = "<unprojected: depth limit>";

function projectCredentialValues(value, depth) {
  if (typeof value === "string") return redactReservoirLocator(value);
  // numbers / booleans / null carry no credential and have no children
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_PROJECTION_DEPTH) return UNPROJECTABLE_SUBTREE;
  if (Array.isArray(value)) {
    return value.map((v) => projectCredentialValues(v, depth + 1));
  }
  const out = {};
  // VALUES only — see § NOT COVERED on getEcosystemConfig() for why keys are not
  // projected.
  //
  // defineProperty, NOT `out[k] = …`. JSON.parse builds `__proto__` as an OWN
  // enumerable DATA property (measured: the descriptor is
  // {value,writable:true,enumerable:true,configurable:true}), so Object.entries
  // above yields it — but a plain assignment on an object literal resolves to
  // the INHERITED Object.prototype `__proto__` SETTER instead of creating an own
  // property. Measured consequences, both CONCEALMENT:
  //   * string value  → the setter is a silent no-op; the member VANISHES from
  //     the projection entirely (absent from Object.keys AND JSON.stringify).
  //   * object value  → `out` is re-parented; the member is absent from
  //     JSON.stringify/Object.entries, yet `for..in` walks the injected subtree
  //     as though those were top-level config keys.
  // Neither is a credential LEAK — the value was already routed through the
  // redactor on the way in, and `Object.prototype` itself is never touched (the
  // setter mutates `out` alone; verified). The defect is concealment on the one
  // surface designated for credential AUDIT, which is the exact outcome
  // § NOT COVERED invokes ("would silently DROP a field, a worse failure than
  // displaying it") to justify not projecting KEYS. Sibling precedent one
  // directory over: mesh-registry-scrub.mjs's `Object.hasOwn` guard, which
  // names `__proto__` for the same reason.
  //
  // defineProperty over Object.create(null) deliberately: both render the member
  // identically under Object.keys + JSON.stringify (measured), but a null-
  // prototype receiver would also strip `.hasOwnProperty` from every projected
  // object and change util.inspect's rendering for consumers. `constructor` /
  // `toString` / `valueOf` keys never needed this — they inherit DATA properties,
  // not setters, so plain assignment already shadowed them correctly (measured);
  // they are pinned by the regression test anyway.
  for (const [k, v] of Object.entries(value)) {
    Object.defineProperty(out, k, {
      value: projectCredentialValues(v, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * The full config as a credential-redacted DISPLAY PROJECTION, or null when
 * absent. This is the onboarding/display/log consumer (INV-2 "never surface a
 * secret VALUE"), so what it returns is a deep COPY in which EVERY string value
 * — at EVERY depth, in EVERY block, not only `rag` — has been routed through
 * redactReservoirLocator(). The cached object is never mutated and never
 * returned, so getRagReservoirLocator() / getUpstreamCanon() keep yielding the
 * RAW value to the SERVER-SIDE callers that must connect or fetch.
 *
 * SCOPE, stated exactly so no reader over-reads it (#1351; zero-tolerance R3e —
 * a doc claim about a code surface must match the code):
 *   - COVERED: every string value reachable from the config root through plain
 *     objects and arrays, at any nesting depth. That is what makes BOTH a
 *     future DSN-shaped `rag` sibling (`backup_locator`, a nested object, an
 *     array of locators) AND a credential-bearing NON-`rag` field covered by
 *     construction. `ecosystem.upstream_canon.url` is the live instance of the
 *     latter: sync-from-canon-fetch.mjs documents it as legitimately carrying
 *     `https://x-access-token:TOKEN@github.com/...`.
 *   - NOT COVERED: object KEYS. A key is a schema field name, and two distinct
 *     keys can redact to one string — which would silently DROP a field, a
 *     worse failure than displaying it. A credential parked in a KEY is out of
 *     scope, named rather than silently mishandled.
 *
 *     A SHIPPED ALTERNATIVE EXISTS AND WAS STILL REJECTED — recorded because
 *     two sibling modules otherwise hold opposite dispositions on the same
 *     "a key is untrusted free text" problem with no stated reason.
 *     mesh-registry-scrub.mjs (~L288-302) solves the collision objection with a
 *     POSITIONAL sentinel (`«unrecognized-field-#N»`), the shape
 *     security.md § Redactor Contract mandates as `[REDACTED_KEY_N]`; the
 *     collision argument above is therefore not, by itself, load-bearing.
 *     The dispositions differ because the INPUTS do, not because one module
 *     overlooked the other:
 *       * mesh-registry-scrub's keys arrive on an UP-pull tuple from another
 *         deployment — genuinely attacker-controlled free text (a client name /
 *         operator email smuggled as a JSON key), so its fail-CLOSED drop-and-
 *         renumber is correct even though it destroys navigability.
 *       * THIS module's keys are schema field names in ecosystem.json, an
 *         operator-owned LOCAL file that crosses no trust boundary (it is
 *         never synced, never published, never scanned-as-content — see
 *         § DISCLOSURE DISCIPLINE). And the consumer here is a DISPLAY view of
 *         a config: renumbering `rag` to `«redacted-key-#3»` would make the
 *         view unreadable and unnavigable for exactly the operator who owns
 *         the file, to defend against that operator attacking themselves.
 *     So the sentinel is the right instrument on an untrusted-key surface and
 *     the wrong one here. If ecosystem.json ever takes keys from a source the
 *     local operator does not own, this disposition MUST be revisited and the
 *     sentinel adopted — that, not the collision argument, is the real trigger.
 *   - NOT COVERED: whatever redactReservoirLocator() itself does not recognize
 *     (see its § NOT COVERED — `token=`, `secret=`, `apikey=` and friends).
 *   - DEPTH-CAPPED: a subtree nested deeper than MAX_PROJECTION_DEPTH is
 *     replaced by UNPROJECTABLE_SUBTREE, never emitted raw.
 *
 * A present-but-malformed rag block fails loud via loadRag() (config-error),
 * same as the loader's Q6 and the server-side accessors.
 */
export function getEcosystemConfig() {
  const c = load().config;
  if (c === null) return null;
  // Validate the rag block FIRST so a present-but-malformed one fails LOUD here
  // exactly as it does on the server-side accessors, instead of being projected
  // into a plausible-looking display view.
  if (c.rag !== undefined && c.rag !== null) loadRag();
  return projectCredentialValues(c, 0);
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
 *
 * RAW — SERVER-SIDE ONLY. `url` MAY carry a credential (sync-from-canon-fetch.mjs
 * documents `https://x-access-token:TOKEN@github.com/…` as a supported form), and
 * the fetch transport needs it intact. NEVER hand this object to a view/log
 * surface: route display through getEcosystemConfig(), which redacts it (#1351).
 */
export function getUpstreamCanon() {
  const c = load().config;
  if (!c || !c.ecosystem || !c.ecosystem.upstream_canon) return null;
  return c.ecosystem.upstream_canon;
}

// ────────────────────────────────────────────────────────────────
// (6) rag — the per-ecosystem RAG accountability-store pointer (#1316).
//
// reservoir_locator is a DSN that MAY carry a credential (Mode-2 Postgres:
// `postgres://user:secret@host/db`). The RAW value is read SERVER-SIDE ONLY via
// getRagReservoirLocator(); ANY view/log/display surface MUST route through the
// credential-redacted projection — the INV-2 "never surface a secret VALUE"
// discipline. redactReservoirLocator() mirrors sync-from-canon-fetch.mjs's
// redactUserinfo() (the sibling URL-credential redactor, same `<redacted>`
// sentinel) and EXTENDS it with the libpq/query `password=` keyword form.
// ────────────────────────────────────────────────────────────────

// The redaction sentinel — matches sync-from-canon-fetch.mjs::redactUserinfo.
const REDACTED_CREDENTIAL = "<redacted>";

// ────────────────────────────────────────────────────────────────
// The parse-then-redact tokenizer (#1334, closing the #1316 R2 residue).
//
// WHY A PARSE, NOT A REGEX OVER THE VALUE SPAN: a single `replace()` whose
// value alternation guesses the terminator leaks whatever the guess cut short
// (`'[^']*'` stops at a libpq-escaped quote → the tail survives; `[^&;\s]+`
// applies the URL-query terminator to a SPACE-DSN value where `&`/`;` are
// ordinary password bytes) and over-reaches where the guess is too greedy
// (`[^/\s]*@` runs past a URL's `?` into a query `@`, corrupting host+query).
// A left-to-right walk that CONSUMES each token instead decides the terminator
// from the token's own grammar + the region it sits in, so a value is never
// re-entered and never truncated.
//
// A DSN is EITHER a URI or a libpq keyword/value string, and a diagnostic line
// may embed a URI inside prose. Only ONE character's meaning actually varies by
// position — `&` — so the region state tracks exactly that:
//   * URI QUERY (after `?`, before `#`, inside a URI) — `&` separates query
//     parameters, so it terminates a bare value.
//   * EVERYWHERE ELSE (libpq space-DSN, a URI authority, a URI fragment) — `&`
//     is an ordinary byte; ONLY whitespace terminates a bare value. An authority
//     has no query to separate and a URI fragment (RFC 3986 §3.5) has no
//     `&`-separator semantics, so both take the whitespace-only terminator.
//
// `;` NEVER terminates. libpq splits query parameters on `&` only, and in
// RFC 3986 `;` is a sub-delim with no separator meaning; `;`-delimited
// connection strings are an ODBC/ADO.NET convention, and that form carries no
// `://`, so the whitespace-only terminator already covers it fail-closed.
//
// "Whitespace" here is C `isspace()` — the SIX ASCII characters libpq's parser
// breaks on — NOT JS `\s`, which is a strict superset including U+00A0, U+2028,
// U+2029, U+FEFF, U+1680, U+2003, U+202F, U+3000 and more. Those are ordinary
// password bytes to libpq, so terminating a value on one truncates the redaction
// and leaks the tail — the same defect class as applying `&` where it does not
// separate.
// ────────────────────────────────────────────────────────────────

// C `isspace()` — libpq's own token terminator. Used for every LIBPQ-SEMANTICS
// boundary (bare-value ends, authority end, userinfo window). Deliberately NOT
// JS `\s`: see the § tokenizer note above.
const LIBPQ_WS = /[ \t\n\v\f\r]/;

// A key whose name ENDS in `password` (password, sslpassword, db_password,
// pgpassword, …) + libpq's whitespace-tolerant `=` delimiter. Sticky: probed at
// one explicit scan position, never scanned forward.
const RE_PASSWORD_KEY = /(\w*password)(\s*=\s*)/iy;
// `scheme://` — the start of a URL region; its authority follows.
const RE_URL_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:\/\//y;
// libpq single-quoted value: a backslash escapes the NEXT character, so an
// escaped quote does NOT close the token (`'a\'b'` is ONE token — F-R2-1).
const RE_SQ_VALUE = /'(?:[^'\\]|\\[\s\S])*'/y;
// The same shape for the non-canonical double-quoted spelling (libpq canon uses
// single quotes; accepting this costs one probe and closes the same tail leak).
const RE_DQ_VALUE = /"(?:[^"\\]|\\[\s\S])*"/y;
// Bare value, everywhere EXCEPT a URI query: ONLY C-`isspace()` whitespace
// terminates (F-R2-2). NOT `\S+` — that would also break on Unicode whitespace,
// which libpq treats as ordinary password bytes.
const RE_BARE_KEYWORD_VALUE = /[^ \t\n\v\f\r]+/y;
// Bare value, inside a URI query: `&` additionally terminates, because there it
// genuinely separates parameters. `;` is NOT included (not a URI separator) and
// neither is `#`: if a `#` after a password value is a real fragment start,
// consuming it into the sentinel only over-redacts a NON-secret, whereas
// terminating on it would LEAK the tail when the `#` is an unencoded literal
// password byte (not representable in a URI, but a reachable config typo).
const RE_BARE_URL_QUERY_VALUE = /[^& \t\n\v\f\r]+/y;

// Probe a sticky regex at exactly `i` (no forward scan). null when it does not
// match there.
function probeAt(re, s, i) {
  re.lastIndex = i;
  return re.exec(s);
}

// End index (exclusive) of the value token starting at `i`. A quoted token wins
// over a bare run, because a quoted value MAY legally contain the region's bare
// terminator. An UNTERMINATED quote consumes to END-OF-STRING: this is a
// credential surface, so an unparseable value fails toward MORE redaction —
// falling back to a shorter bare run would leak the tail, which is exactly the
// F-R2-1 defect. Returns `i` itself for an empty value (nothing to redact).
function endOfValue(s, i, inUriQuery) {
  if (s[i] === "'") {
    const m = probeAt(RE_SQ_VALUE, s, i);
    return m ? i + m[0].length : s.length; // unterminated → fail closed
  }
  if (s[i] === '"') {
    const m = probeAt(RE_DQ_VALUE, s, i);
    return m ? i + m[0].length : s.length; // unterminated → fail closed
  }
  const m = probeAt(
    inUriQuery ? RE_BARE_URL_QUERY_VALUE : RE_BARE_KEYWORD_VALUE,
    s,
    i,
  );
  return m ? i + m[0].length : i;
}

// End index (exclusive) of a URL authority starting at `i`. RFC 3986 §3.2: the
// authority ends at the FIRST `/`, `?` or `#`, or at the end of the URI —
// terminating on `?`/`#` is what keeps a query-embedded `@` out of the userinfo
// (F-R2-4). Whitespace ends it too (a URI carries none), so a URL embedded in a
// longer diagnostic string does not swallow the rest of the line.
function endOfAuthority(s, i) {
  for (let j = i; j < s.length; j += 1) {
    const c = s[j];
    if (c === "/" || c === "?" || c === "#" || LIBPQ_WS.test(c)) return j;
  }
  return s.length;
}

// End index (exclusive) of the window a USERINFO `@` may live in, starting at
// `i`. Wider than endOfAuthority: it stops ONLY at `/` or whitespace, so `?` and
// `#` stay INSIDE — in this position they are ordinary password bytes, not
// component delimiters. Used only as the fallback in § the scheme branch, whose
// `:`-before-`@` requirement is what keeps a query `@` from being read as a
// userinfo delimiter.
function endOfUserinfoWindow(s, i) {
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === "/" || LIBPQ_WS.test(s[j])) return j;
  }
  return s.length;
}

// Index of the first `*password=` key at a word-run start within [from, to), or
// -1. A `@` occurring AFTER such a key belongs to that key's VALUE, never to a
// userinfo — see § the scheme branch.
function firstPasswordKeyIn(s, from, to) {
  for (let j = from; j < to; j += 1) {
    if (j > 0 && /\w/.test(s[j - 1])) continue; // not a word-run start
    if (probeAt(RE_PASSWORD_KEY, s, j)) return j;
  }
  return -1;
}

// Redact one userinfo component (the bytes BEFORE the authority's delimiting
// `@`; the caller locates that `@` so it is never searched for past the
// authority's end — that is the F-R2-4 defect). Everything after the first `:`
// is the password and goes; an unencoded `@` inside the password is therefore
// inside this span already (`user:p@ss`) and no fragment leaks. A userinfo with
// no `:` may itself be a bare token → redact all of it.
function redactUserinfoComponent(userinfo) {
  const colon = userinfo.indexOf(":");
  return colon === -1
    ? REDACTED_CREDENTIAL // bare token → whole userinfo
    : `${userinfo.slice(0, colon)}:${REDACTED_CREDENTIAL}`; // keep the username
}

/**
 * Redact every credential VALUE in a reservoir-locator DSN, leaving the
 * non-secret structure (scheme, username, host, port, path, non-password
 * params) intact so the projection stays diagnostically useful.
 *
 * COVERED (each a token consumed by the walk above, per § tokenizer):
 *   (a) URL userinfo  scheme://user:PASS@host → scheme://user:<redacted>@host
 *                     scheme://TOKEN@host      → scheme://<redacted>@host
 *       The `@` is sought inside the RFC-3986 authority (first `/`, `?`, `#`, or
 *       whitespace) and taken at the LAST one, so an unencoded `@` in the
 *       password redacts whole AND a `@` in the query is left alone. When that
 *       span holds no `@`, the search widens to a `/`-or-whitespace window and
 *       requires a `:` before the `@` — that is what covers `?`/`#` INSIDE the
 *       password without reading a query `@` as a userinfo delimiter.
 *   (b) ANY key ending in `password` (`password`, `sslpassword`, `db_password`,
 *       `pgpassword`, …), case-insensitively, with whitespace tolerated around
 *       `=` (libpq `password = secret`). The VALUE is a libpq single-quoted
 *       token (backslash-escape aware, may hold spaces / `&` / `;`), a
 *       double-quoted token, or a bare run whose only terminator is C-`isspace()`
 *       whitespace — plus `&` when, and ONLY when, the value sits inside a URI
 *       QUERY. Key and delimiter are preserved; only the VALUE becomes the
 *       sentinel. A `@` occurring after such a key is part of its value, never a
 *       userinfo delimiter, so both halves of a run holding both still redact.
 *
 * NOT COVERED (deliberate, stated so no reader over-reads the coverage):
 *   - Non-`*password` secret-ish keys (`token=`, `secret=`, `apikey=`) are left
 *     alone — they are not Postgres DSN parameters (#1334 F-R2-5, accepted).
 *   - Values are treated as opaque bytes; no percent-decoding is performed. A
 *     percent-encoded `%40`/`%23` therefore stays inside the value it belongs to
 *     (correct), but no attempt is made to DECODE one into its delimiter meaning.
 *   - Genuine non-secrets are untouched by construction because none end in
 *     `password`: `passfile=`/`sslkey=`/`sslcert=` (paths), `channel_binding=`/
 *     `require_auth=` (modes). Over-redaction is a defect too.
 *   - The scan is byte/codepoint-level and does NOT model libpq's full connection
 *     -string grammar: no keyword validation, no `service=`/`passfile` file
 *     resolution, no multi-host `host=a,b` awareness. It recognizes credential
 *     TOKENS and their terminators, which is what display hygiene needs.
 *
 * Non-string → returned unchanged (the accessor validates the type upstream).
 * Safe on non-DSN strings (no token matches → returned byte-identical), so a
 * projection MAY apply it to every rag string value for defense in depth.
 */
export function redactReservoirLocator(locator) {
  if (typeof locator !== "string") return locator;
  const out = [];
  let i = 0;
  // Region state (see § tokenizer). `inUri` tracks whether the scan sits inside
  // a URI at all; `inUriQuery` — the only flag a value terminator consults —
  // tracks the URI's QUERY component specifically, since `&` separates there and
  // nowhere else. Both start false: the default grammar is the libpq space-DSN.
  let inUri = false;
  let inUriQuery = false;
  // The next `://` at or after the scan position, or -1 when none remains. A
  // scheme match is IMPOSSIBLE without one, so skipping the probe in that case
  // avoids re-scanning a long separator-free run at every position (the probe's
  // `[A-Za-z0-9+.-]*` otherwise makes the walk quadratic). Purely a cost guard —
  // it removes no coverage (pinned by G17).
  //
  // SCOPE OF THE GUARD, measured not assumed: it removes the quadratic ONLY when
  // no `://` follows the run (32 KB: 2329ms → 0.8ms). A long run FOLLOWED by a
  // real `://` keeps the probe armed and stays quadratic (32 KB ≈ 2.3s). That is
  // accepted, not fixed: the input is an operator-owned local config value, not
  // network input, and a bounded scheme length would fail OPEN (an unrecognized
  // scheme means the authority is never parsed, so the userinfo is never
  // redacted) — the wrong trade on a credential surface.
  let nextSep = locator.indexOf("://");
  while (i < locator.length) {
    // Probe the key only at the START of a word run. `\w*password` is greedy, so
    // a match at a mid-run position implies a match from that run's start (`\w*`
    // simply absorbs the leading chars) — the run start is always visited first,
    // because the walk advances one char at a time and every token it skips over
    // ends on a non-word char. Probing every position instead costs O(run²)
    // backtracking for zero extra coverage.
    const atWordStart = i === 0 || !/\w/.test(locator[i - 1]);
    const key = atWordStart ? probeAt(RE_PASSWORD_KEY, locator, i) : null;
    if (key) {
      const valueStart = i + key[0].length;
      const valueEnd = endOfValue(locator, valueStart, inUriQuery);
      out.push(key[1], key[2]);
      if (valueEnd > valueStart) out.push(REDACTED_CREDENTIAL);
      // The value is CONSUMED — the scan resumes AFTER it, so its interior is
      // never re-entered by a later probe. That is what makes a whole DSN
      // sitting inside a password (`password=postgres://u:p@h`) redact whole
      // instead of being re-parsed as a URL and having its structure emitted.
      i = valueEnd;
      continue;
    }
    if (nextSep !== -1 && nextSep < i) nextSep = locator.indexOf("://", i);
    const scheme = nextSep === -1 ? null : probeAt(RE_URL_SCHEME, locator, i);
    if (scheme) {
      // Entering a URI at its AUTHORITY — not its query, so `&` does not yet
      // separate anything.
      inUri = true;
      inUriQuery = false;
      const authStart = i + scheme[0].length;
      // Span to search for the userinfo `@`. Default: the RFC-3986 authority,
      // whose `?`/`#` bound is what keeps a QUERY `@` from being read as the
      // userinfo delimiter (F-R2-4).
      let lookupEnd = endOfAuthority(locator, authStart);
      if (!locator.slice(authStart, lookupEnd).includes("@")) {
        // No `@` in the RFC authority — but `?` and `#` are legal (if unencoded)
        // bytes INSIDE a password, so `scheme://user:p?w@host/db` puts the real
        // userinfo `@` beyond that bound. Widen to a `/`-or-whitespace window
        // before concluding there is no credential, and require a `:` before the
        // `@`: a `:`-less `@` is a query value (`?opt=a@b`), not a userinfo, and
        // MUST stay un-redacted.
        const windowEnd = endOfUserinfoWindow(locator, authStart);
        const win = locator.slice(authStart, windowEnd);
        const at = win.lastIndexOf("@");
        if (at !== -1 && win.lastIndexOf(":", at) !== -1) lookupEnd = windowEnd;
      }
      // A `@` after a `*password=` key inside the span belongs to that key's
      // VALUE. Splitting there would emit the value's head raw (`password=AA:`
      // out of `password=AA:BB@c`) — the partial-redaction class F-R2-1 is about.
      // Bounding the search to BEFORE the key keeps both halves redacted: the
      // userinfo by this split, the value by the walk's own key probe.
      const keyStart = firstPasswordKeyIn(locator, authStart, lookupEnd);
      const atLimit = keyStart === -1 ? lookupEnd : keyStart;
      const at = locator.slice(authStart, atLimit).lastIndexOf("@");
      out.push(scheme[0]);
      if (at === -1) {
        // No credential in this authority. Resume INSIDE it rather than jumping
        // to the span end: an authority-shaped run can still contain a
        // `password=` (`redis://h&password=x` — no `/`, `?` or `#` to end the
        // component), and emitting the span wholesale would skip the key probe.
        i = authStart;
      } else {
        // Emit the redacted userinfo + its `@`, then resume just after the `@` so
        // the host/port/path tail is scanned normally (its own tokens still get
        // probed) rather than emitted as one opaque span.
        out.push(
          redactUserinfoComponent(locator.slice(authStart, authStart + at)),
          "@",
        );
        i = authStart + at + 1;
      }
      continue;
    }
    const ch = locator[i];
    if (inUri) {
      // Component transitions inside a URI. `?` opens the query (where `&`
      // separates); `#` opens the fragment, which has no `&`-separator semantics
      // (RFC 3986 §3.5), so the whitespace-only terminator resumes there.
      if (ch === "?") inUriQuery = true;
      else if (ch === "#") inUriQuery = false;
      // A URI carries NO raw whitespace of any kind, so ANY JS-`\s` codepoint
      // ends it — deliberately the broader class here, unlike every libpq
      // terminator: leaving the URI early only drops `&` back to an ordinary
      // byte, which redacts MORE. It can never widen a value.
      else if (/\s/.test(ch)) {
        inUri = false;
        inUriQuery = false;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

// Internal: the validated raw rag block, or null when absent (back-compat).
// A PRESENT-but-malformed block fails LOUD (config-error) — mirroring the
// loader's Q6 schema discipline + zero-tolerance R3 (no silent fallback).
function loadRag() {
  const c = load().config;
  if (!c || c.rag === undefined || c.rag === null) return null; // absent (OK)
  const rag = c.rag;
  if (typeof rag !== "object" || Array.isArray(rag)) {
    throw new EcosystemConfigError(
      "config-error",
      `ecosystem-config: 'rag' must be an object (got ${Array.isArray(rag) ? "array" : typeof rag})`,
    );
  }
  if (
    typeof rag.reservoir_locator !== "string" ||
    rag.reservoir_locator.trim() === ""
  ) {
    throw new EcosystemConfigError(
      "config-error",
      `ecosystem-config: 'rag.reservoir_locator' must be a non-empty string when 'rag' is present`,
    );
  }
  if (rag.tenant_id !== undefined && typeof rag.tenant_id !== "string") {
    throw new EcosystemConfigError(
      "config-error",
      `ecosystem-config: 'rag.tenant_id' must be a string when present (got ${typeof rag.tenant_id})`,
    );
  }
  return rag;
}

/**
 * (6) The RAW rag reservoir-locator DSN, or null when absent. SERVER-SIDE ONLY —
 * the value MAY carry a credential; NEVER hand it to a view/log surface. Route
 * display through getRagReservoirLocatorRedacted() / getEcosystemConfig() (both
 * redacted). A present-but-malformed rag block fails loud (config-error).
 */
export function getRagReservoirLocator() {
  const rag = loadRag();
  return rag ? rag.reservoir_locator : null;
}

/**
 * (6) The rag tenant scope. Defaults to ecosystem.id when unset (#1316); null
 * only when there is no rag block. A present-but-malformed rag block fails loud.
 */
export function getRagTenantId() {
  const rag = loadRag();
  if (!rag) return null;
  if (typeof rag.tenant_id === "string") return rag.tenant_id;
  const c = load().config;
  return (c && c.ecosystem && c.ecosystem.id) || null;
}

/**
 * (6) The PROJECTION of the reservoir locator — the credential-redacted view for
 * ANY log/display/onboarding surface (INV-2). null when absent. This is the ONLY
 * locator form that may cross a view/log boundary.
 */
export function getRagReservoirLocatorRedacted() {
  const raw = getRagReservoirLocator();
  return raw === null ? null : redactReservoirLocator(raw);
}

export const _paths = { ECOSYSTEM_PATH, BIN_DIR };
