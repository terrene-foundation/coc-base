/*
 * ============================================================================
 *  fleet-deps — read-only per-consumer DEPENDENCY-CURRENCY probe (W2a-T4)
 * ============================================================================
 *
 *  Build #2-completion, the deps half of the maintenance observe-plane signal
 *  enrichment (analysis §5 Build #2; §6 "buyer-credible only once it reports
 *  CVE/compliance drift, not just version distance"). It records each
 *  consumer's DECLARED-MANIFEST dependency currency into the fleet ledger
 *  (`fleet-freshness-ledger.mjs`), the surface the buyer dashboard reads.
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  WHAT THIS IS — AND IS NOT (honest-signal contract, evidence-first-claims.md):
 *
 *  This is NOT a CVE engine and builds NONE (W2a-T4 invariant "no new CVE
 *  engine"). loom has no vulnerability database, so this probe makes NO
 *  vulnerability claim. It records DEPENDENCY-CURRENCY: a mechanical read of
 *  each consumer's declared dependency manifest, applying the `dependencies.md`
 *  rules ALREADY embodied by `/inspect deps` —
 *
 *    - `declared` : count of direct declared dependencies.
 *    - `capped`   : declared deps carrying a DEFENSIVE UPPER-BOUND cap (a `<`
 *                   constraint) — the `dependencies.md` "No Caps / No Defensive
 *                   Caps" anti-pattern.
 *    - `pinned`   : declared deps pinned to an EXACT version — the
 *                   `dependencies.md` MUST NOT "Pin exact versions in library".
 *
 *  A `capped` or `pinned` count > 0 is the meaningful maintenance signal: the
 *  consumer is on a defensive-pinning treadmill and silently falls behind on
 *  security patches (dependencies.md § "Latest Versions Always"). The ledger
 *  field is named `deps` — honest about what it measures. The dashboard's `cve`
 *  column STAYS roadmap-labeled through T4; T6 is the WIRE step where the
 *  buyer-facing framing is decided (journal/0313).
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *  REUSE, NOT REIMPLEMENTATION: the classification predicates ARE the
 *  `dependencies.md` mechanical rules (`<` cap, `==`/`=`/exact pin). No new
 *  version-resolution or vuln-lookup engine is introduced.
 *
 *  Read-only + resolver-driven, mirroring fleet-freshness.mjs: enumerates
 *  consumers via the injected resolveAll (loom-links::resolveAll; NEVER
 *  positional, cross-repo.md MUST-1); reads ONLY each consumer's root manifest;
 *  no fetch, no mutation, no state write. FAIL-LOUD (evidence-first-claims.md
 *  MUST-3): a consumer with no recognized/readable manifest, an unresolvable
 *  key, or a remote-only (non-path) entry is reported `reachable:false` + a
 *  logical-key-keyed reason — NEVER silently counted "current". Every `reason`
 *  keys on the logical consumer key; any caught `err.message` interpolated into
 *  a reason is run through `scrubPath()` FIRST, so no absolute checkout path
 *  reaches the durable ledger reason (security.md § "No secrets in logs" +
 *  upstream-issue-hygiene.md MUST-2). The `repo` field deliberately carries the
 *  absolute path (the documented JSON shape, loom-local ledger); `reason` does
 *  not.
 *
 *  SCOPE LIMITS (documented, NOT silent): py parsing covers PEP 621
 *  `[project].dependencies` + `[project.optional-dependencies]` ONLY — a
 *  Poetry-only manifest (`[tool.poetry.dependencies]`, a different TOML shape)
 *  is fail-loud UNKNOWN, NEVER reported as `declared:0`/current. Two classifier
 *  edge-cases are accepted as documented limitations (reviewer LOW, deferred):
 *  an npm bare prerelease pin (`1.2.3-beta.1`) is classified NOT pinned, and a
 *  py `==1.2.*` prefix-match IS classified pinned (it is a `==` constraint).
 *
 *  --json output shape (consumers MUST tolerate unknown keys; additive):
 *    {
 *      "scope": "declared-manifest-currency",
 *      "results": [
 *        {
 *          "target":          "<logical-key>",
 *          "repo":            "<absolute-path>" | null,
 *          "manifest":        "pyproject.toml"|"Cargo.toml"|"package.json"|null,
 *          "declared":        <int> | null,
 *          "capped":          <int> | null,
 *          "pinned":          <int> | null,
 *          "capped_examples": ["<name>", ...],   // up to EXAMPLES_CAP
 *          "pinned_examples": ["<name>", ...],
 *          "reachable":       true | false,
 *          "reason":          null | "<diagnostic>"
 *        },
 *        ...
 *      ],
 *      "overall_reachable": true | false
 *    }
 *
 *  Usage (scoped INTO /inspect health per repo-scope-discipline.md):
 *    node .claude/bin/lib/fleet-deps.mjs --json
 *
 *  Node ESM, zero dependencies.
 * ============================================================================
 */

import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/ → bin/ → .claude/ → loom root
const LOOM_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

export const SCOPE = "declared-manifest-currency";
// Cap on how many capped/pinned dep NAMES are enumerated per consumer
// (the full counts are always in `capped`/`pinned`; the lists are for legibility).
export const EXAMPLES_CAP = 10;

// Consumer logical keys PULL canon distribution; recognized by resolver-key
// namespace prefix — NEVER by a positional path (mirrors fleet-freshness.mjs).
const CONSUMER_KEY_PREFIXES = ["use-template.", "downstream."];

// Manifest probe order. The FIRST recognized manifest present at the consumer
// repo root is the one read (a consumer declares deps in exactly one ecosystem
// manifest at its root). `ecosystem` selects the classifier predicate set.
const MANIFESTS = [
  { file: "pyproject.toml", ecosystem: "py" },
  { file: "Cargo.toml", ecosystem: "rs" },
  { file: "package.json", ecosystem: "npm" },
];

// Cap on a single manifest read (resource-exhaustion guard, mirrors the sibling
// fleet-freshness.mjs maxBuffer bound). A real dependency manifest is well under
// this; an oversized one fails loud as UNKNOWN rather than OOM-ing the probe.
const MANIFEST_SIZE_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Strip absolute filesystem paths out of a string before it lands in a durable
 * ledger reason (security.md § "No secrets in logs"). Same shape as
 * fleet-dashboard.mjs::scrubReason, applied at the PROBE source so the raw
 * `reason` is path-free even before any render-time scrub. Returns "" for
 * non-strings. A leading "/" + ≥2 path segments → `<path>`; logical keys
 * (`use-template.py`) and relative artifact paths have no leading slash.
 */
export function scrubPath(s) {
  if (typeof s !== "string" || s.length === 0) return "";
  return s.replace(/\/[\w.\-]+(?:\/[\w.\-]+)+\/?/g, "<path>");
}

/** Whether a resolver logical key denotes a canon-distribution consumer. */
export function isConsumerKey(key) {
  return CONSUMER_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Classify ONE dependency version specifier against the `dependencies.md`
 * mechanical rules. Pure + exported for unit tests.
 *
 * @param {string} spec       the version specifier (e.g. ">=2.0,<3.0", "=1.0.0", "^1.2").
 * @param {string} ecosystem  "py" | "rs" | "npm" — selects the pin predicate.
 * @returns {{capped: boolean, pinned: boolean}}
 *
 *  capped : a DEFENSIVE UPPER BOUND — any `<` constraint, across all
 *           ecosystems (dependencies.md "No Defensive Caps").
 *  pinned : an EXACT-version pin (dependencies.md MUST NOT "Pin exact versions"):
 *           - py  : a `==` (or `===`) operator anywhere in the specifier.
 *           - rs  : a leading `=` exact requirement (Cargo `"=1.2.3"`).
 *           - npm : a leading `=`, OR a bare exact semver `X.Y.Z` with no range
 *                   operator (`^`/`~`/`>`/`<`/`*`/`x`/`-`/`||`).
 */
export function classifyRequirement(spec, ecosystem) {
  const s = typeof spec === "string" ? spec.trim() : "";
  const capped = s.includes("<");
  let pinned = false;
  if (ecosystem === "py") {
    pinned = /==|===/.test(s);
  } else if (ecosystem === "rs") {
    pinned = /^\s*=\s*\d/.test(s);
  } else if (ecosystem === "npm") {
    if (/^\s*=\s*\d/.test(s)) {
      pinned = true;
    } else {
      // Bare exact semver with no range operator → an exact pin.
      pinned = /^\d+\.\d+\.\d+/.test(s) && !/[\^~><*x|\s-]/.test(s.replace(/^\d+\.\d+\.\d+/, ""));
    }
  }
  return { capped, pinned };
}

/**
 * Extract the `[ ... ]`-array body that follows `dependencies = ` (and every
 * `[project.optional-dependencies]` array) from a pyproject.toml, returning the
 * concatenated array bodies. Bracket-depth aware so a nested `[extra]` marker
 * inside a requirement string does not terminate early.
 */
function pyDependencyArrays(text) {
  const bodies = [];
  // Match `dependencies = [` and `<name> = [` lines inside the optional-deps
  // table. We collect the body of every `= [ ... ]` whose key is `dependencies`
  // OR which appears under an `[project.optional-dependencies]` header.
  const lines = text.split(/\r?\n/);
  let inOptional = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inOptional = /optional-dependencies/.test(header[1]);
      continue;
    }
    const m = line.match(/^\s*(?:dependencies|[A-Za-z0-9._-]+)\s*=\s*\[(.*)$/);
    if (!m) continue;
    const key = line.match(/^\s*([A-Za-z0-9._-]+)\s*=/);
    const isDeps = key && key[1] === "dependencies";
    if (!isDeps && !inOptional) continue;
    // Accumulate until the array closes (bracket-depth across lines).
    let body = m[1];
    let depth = 1;
    depth += countBracket(m[1]);
    let j = i;
    while (depth > 0 && j + 1 < lines.length) {
      j++;
      body += "\n" + lines[j];
      depth += countBracket(lines[j]);
    }
    bodies.push(body);
    i = j;
  }
  return bodies.join("\n");
}

/** Net bracket delta of `[` vs `]` in a chunk (string-literal-naive, adequate for TOML arrays). */
function countBracket(chunk) {
  let d = 0;
  for (const ch of chunk) {
    if (ch === "[") d++;
    else if (ch === "]") d--;
  }
  return d;
}

/** Pull quoted requirement strings out of an array body. */
function quotedStrings(body) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const v = m[1] !== undefined ? m[1] : m[2];
    if (v && v.trim()) out.push(v.trim());
  }
  return out;
}

/** Split a PEP 508 requirement into {name, spec}. Drops env markers / extras. */
function splitPep508(req) {
  // name optionally followed by [extras], then a specifier, optionally `; marker`.
  const noMarker = req.split(";")[0].trim();
  const m = noMarker.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  return { name: m[1], spec: m[2].trim() };
}

/**
 * Parse a manifest text into an array of `{name, spec}` direct dependencies.
 * Pure + exported for unit tests. Returns null when the manifest cannot be
 * parsed at all (e.g. malformed JSON) — distinct from an empty deps list.
 */
export function parseManifest(manifestFile, ecosystem, text) {
  if (typeof text !== "string") return null;
  if (ecosystem === "py") {
    const body = pyDependencyArrays(text);
    return quotedStrings(body)
      .map(splitPep508)
      .filter(Boolean);
  }
  if (ecosystem === "rs") {
    // Collect lines under [dependencies] / [dependencies.<name>] tables.
    const lines = text.split(/\r?\n/);
    const deps = [];
    let section = null; // "table" | "named:<name>" | null
    for (const line of lines) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        const h = header[1].trim();
        if (h === "dependencies") section = "table";
        else if (h.startsWith("dependencies.")) section = "named:" + h.slice("dependencies.".length);
        else section = null;
        continue;
      }
      if (section === "table") {
        // name = "1.0"  OR  name = { version = "1.0", ... }
        const inline = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"/);
        if (inline) {
          deps.push({ name: inline[1], spec: inline[2].trim() });
          continue;
        }
        const obj = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*\{(.*)\}/);
        if (obj) {
          const ver = obj[2].match(/version\s*=\s*"([^"]*)"/);
          deps.push({ name: obj[1], spec: ver ? ver[1].trim() : "" });
        }
      } else if (section && section.startsWith("named:")) {
        const ver = line.match(/^\s*version\s*=\s*"([^"]*)"/);
        if (ver) deps.push({ name: section.slice("named:".length), spec: ver[1].trim() });
      }
    }
    return deps;
  }
  if (ecosystem === "npm") {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null; // malformed package.json — fail-loud at call site
    }
    const deps = [];
    const dep = json && typeof json.dependencies === "object" && json.dependencies ? json.dependencies : {};
    for (const [name, spec] of Object.entries(dep)) {
      deps.push({ name, spec: typeof spec === "string" ? spec.trim() : "" });
    }
    return deps;
  }
  return null;
}

/**
 * Default manifest reader: probes MANIFESTS in order at the repo root, returns
 * the FIRST present `{file, ecosystem, text}` or null. INJECTED in tests.
 */
function defaultReadManifest(repoDir) {
  for (const { file, ecosystem } of MANIFESTS) {
    const abs = path.join(repoDir, file);
    if (existsSync(abs)) {
      try {
        // Size-cap BEFORE reading (resource-exhaustion guard): an oversized
        // manifest fails loud as UNKNOWN, never OOMs the probe.
        const size = statSync(abs).size;
        if (size > MANIFEST_SIZE_CAP_BYTES) {
          return {
            file,
            ecosystem,
            text: null,
            note: `exceeds the ${MANIFEST_SIZE_CAP_BYTES}-byte size cap (${size} bytes)`,
          };
        }
        return { file, ecosystem, text: readFileSync(abs, "utf8") };
      } catch {
        // Present but unreadable → treat as a read failure (fail-loud upstream).
        // No err interpolation — the path lives in `abs`, never in a reason.
        return { file, ecosystem, text: null, note: "unreadable" };
      }
    }
  }
  return null;
}

/**
 * Probe ONE consumer's declared-manifest dependency currency.
 * @returns {object} the per-consumer deps result row.
 */
export function probeConsumerDeps(key, repoDir, readManifest = defaultReadManifest) {
  const base = {
    target: key,
    repo: repoDir,
    manifest: null,
    declared: null,
    capped: null,
    pinned: null,
    capped_examples: [],
    pinned_examples: [],
    reachable: false,
    reason: null,
  };

  let found;
  try {
    found = readManifest(repoDir);
  } catch (err) {
    // Scrub any absolute path out of the caught message BEFORE it lands in the
    // durable ledger reason (security.md § "No secrets in logs").
    return { ...base, reason: `consumer '${key}' manifest read failed — deps currency UNKNOWN: ${scrubPath(err && err.message)}` };
  }
  if (!found) {
    return {
      ...base,
      reason: `consumer '${key}' has no recognized dependency manifest (pyproject.toml/Cargo.toml/package.json) — deps currency UNKNOWN`,
    };
  }
  if (typeof found.text !== "string") {
    const note = scrubPath(found.note || "unreadable");
    return { ...base, manifest: found.file, reason: `consumer '${key}' manifest '${found.file}' ${note} — deps currency UNKNOWN` };
  }

  // Poetry guard (reviewer LOW-1): a pyproject.toml using the Poetry table shape
  // (`[tool.poetry.dependencies]`, NOT PEP 621 `[project].dependencies`) parses
  // to ZERO deps under our PEP-621-only py parser. Reporting that as
  // `declared:0`/current would be a SILENT "current" — fail loud as UNKNOWN.
  if (
    found.ecosystem === "py" &&
    /^\s*\[tool\.poetry\.dependencies\]\s*$/m.test(found.text) &&
    !/^\s*dependencies\s*=\s*\[/m.test(found.text)
  ) {
    return {
      ...base,
      manifest: found.file,
      reason: `consumer '${key}' uses the Poetry [tool.poetry.dependencies] layout (PEP-621 parser only) — deps currency UNKNOWN`,
    };
  }

  const parsed = parseManifest(found.file, found.ecosystem, found.text);
  if (parsed === null) {
    return { ...base, manifest: found.file, reason: `consumer '${key}' manifest '${found.file}' could not be parsed — deps currency UNKNOWN` };
  }

  let capped = 0;
  let pinned = 0;
  const cappedNames = [];
  const pinnedNames = [];
  for (const { name, spec } of parsed) {
    const c = classifyRequirement(spec, found.ecosystem);
    if (c.capped) {
      capped += 1;
      if (cappedNames.length < EXAMPLES_CAP) cappedNames.push(name);
    }
    if (c.pinned) {
      pinned += 1;
      if (pinnedNames.length < EXAMPLES_CAP) pinnedNames.push(name);
    }
  }

  return {
    ...base,
    manifest: found.file,
    declared: parsed.length,
    capped,
    pinned,
    capped_examples: cappedNames,
    pinned_examples: pinnedNames,
    reachable: true,
    reason: null,
  };
}

/**
 * The fleet deps probe. Enumerate consumers via the injected resolver
 * (resolveAll), compute each consumer's declared-manifest dependency currency.
 *
 * @param {object}   opts
 * @param {Function} opts.resolveAll     resolver enumeration fn (INJECTED in tests).
 * @param {Function} [opts.readManifest] (repoDir)=>{file,ecosystem,text}|null; INJECTED in tests.
 * @returns {object} { scope, results[], overall_reachable }
 */
export function probeFleetDeps({ resolveAll, readManifest = defaultReadManifest } = {}) {
  if (typeof resolveAll !== "function") {
    throw new TypeError(
      "probeFleetDeps: opts.resolveAll must be the resolver enumeration function (resolver-driven, never positional)",
    );
  }
  const resolved = resolveAll();
  const results = [];
  for (const [key, entry] of resolved) {
    if (!isConsumerKey(key)) continue;

    if (entry.kind === "error" || (entry.kind === "path" && !entry.value)) {
      results.push({
        target: key,
        repo: null,
        manifest: null,
        declared: null,
        capped: null,
        pinned: null,
        capped_examples: [],
        pinned_examples: [],
        reachable: false,
        reason: entry.error
          ? `consumer '${key}' unresolvable: ${entry.error}`
          : `consumer '${key}' not linked in resolver — deps currency UNKNOWN`,
      });
      continue;
    }

    if (entry.kind !== "path") {
      // Any non-path kind (url / remote-only) — no local manifest to read. This
      // dispatch precedes the value-guard above so a value-less remote-only entry
      // renders the precise remote-only reason, NOT "not linked" (LOW-1). Fail
      // loud as UNKNOWN, NEVER feed a non-local ref to a filesystem read.
      results.push({
        target: key,
        repo: null,
        manifest: null,
        declared: null,
        capped: null,
        pinned: null,
        capped_examples: [],
        pinned_examples: [],
        reachable: false,
        reason: `consumer '${key}' is remote-only (kind:${entry.kind}) — local deps currency UNKNOWN`,
      });
      continue;
    }

    results.push(probeConsumerDeps(key, entry.value, readManifest));
  }

  const overall_reachable = results.every((r) => r.reachable);
  return { scope: SCOPE, results, overall_reachable };
}

// ────────────────────────────────────────────────────────────────
// CLI entry — scoped INTO /inspect health (repo-scope-discipline.md:42).
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      process.stderr.write(`fleet-deps: unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: fleet-deps.mjs [--json]\n" +
        "  Read-only per-consumer DEPENDENCY-CURRENCY probe (declared-manifest).\n" +
        "  Applies dependencies.md mechanical rules: declared / capped (`<` cap) /\n" +
        "  pinned (exact). NOT a CVE/vuln scan — no vulnerability DB exists.\n" +
        "  --json   emit machine-readable JSON\n",
    );
    process.exit(0);
  }

  const mod = await import(path.join(LOOM_ROOT, ".claude", "bin", "lib", "loom-links.mjs"));
  const report = probeFleetDeps({ resolveAll: mod.resolveAll });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`[fleet-deps] scope=${report.scope}\n`);
    for (const r of report.results) {
      if (r.reachable) {
        const tag = r.capped + r.pinned > 0 ? `${r.capped} capped, ${r.pinned} pinned` : "current";
        process.stdout.write(
          `[fleet-deps] ${r.target} (${r.manifest}): ${tag} — ${r.declared} declared deps\n`,
        );
      } else {
        process.stdout.write(`[fleet-deps] ${r.target}: UNKNOWN\n`);
        process.stderr.write(`  reason: ${r.reason}\n`);
      }
    }
  }
  process.exit(report.overall_reachable ? 0 : 1);
}

// CLI-vs-import discriminator (mirrors fleet-freshness.mjs).
const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`fleet-deps: fatal: ${err.message}\n`);
    process.exit(2);
  });
}
