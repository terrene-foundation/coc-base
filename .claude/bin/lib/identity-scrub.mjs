/**
 * identity-scrub.mjs — shared identity-EXTRACTION machinery for the two
 * disclosure fences that must agree on "what counts as canon identity":
 *
 *   1. scripts/publish-to-public.mjs  — the canon→PUBLIC-fork scrub+gate.
 *   2. .claude/bin/clean-instantiate.mjs — the CLIENT-clone CLEAR ceremony
 *      (MO-OPT W2): a client cloning/templating canon to instantiate its OWN
 *      ecosystem MUST carry ZERO canon operator/trust identity. Its fail-closed
 *      assert-zero gate is `deriveDynamicTokens(clientCloneRoot).gate` — the SAME
 *      runtime-extraction machinery the publish gate's DYNAMIC half uses, so the
 *      two fences' dynamic gate CANNOT DRIFT (one shared function).
 *
 * The dynamic gate covers the canon owner's name + email too: harvestPgpUid
 * base64-decodes the roster's PGP UID packet, and separator-variant derivation
 * (below) emits the dotted/hyphenated/concatenated forms — so the gate is
 * machine-complete for a GPG-rostered owner WITHOUT any literal canon token in
 * this file. The publish fence ADDITIONALLY unions a small hand-maintained
 * EXTRA_IDENTITY_TOKENS static list (in the LOOM-ONLY scripts/publish-to-public.mjs)
 * for any residual a future SSH-key roster cannot derive. That static list is
 * DELIBERATELY publish-only: relocating it INTO this module would ship literal
 * canon identity to every synced consumer + the public fork — the exact leak the
 * "ZERO identity" guarantee below prevents (MO-OPT holistic redteam MO-R1-H2 —
 * honesty over a false "exact token set" claim).
 *
 * This module contains ZERO identity itself — it is identity-free machinery that
 * EXTRACTS identity from a repo's `operators.roster.json` + tenant denylist, the
 * canonical `canon-identity-values.json` declaration (`orgSets`) and the private
 * repositories its root `.gitmodules` declares (`privateRepoNames`) at RUNTIME. It is therefore safe to SYNC + PUBLISH (`.claude/bin/**`): a consumer
 * receiving it sees only the extraction logic, never a literal canon token.
 *
 * deriveDynamicTokens(repoDir) returns { scrub, gate, unhonoured }:
 *   - gate  : the flat token list the fail-closed disclosure gate greps for.
 *   - scrub : [from, to] genericization pairs (publish uses these to rewrite;
 *             the ceremony does not rewrite — it DELETES/RESETS the carriers —
 *             but the pairs are returned for parity with the publish fence).
 *
 * `assertNoSymlinkEscape` (moved here 2026-07-10, F7 redteam fix) is the
 * FAIL-CLOSED symlink-escape guard both fences share alongside `walkFiles` —
 * it was originally defined in scripts/publish-to-public.mjs, but
 * `.claude/bin/clean-instantiate.mjs::performClear` step (g) DELETES that file
 * from a client clone (canon-only publish tooling), so a static import of the
 * guard from there crashed every re-run after the first successful --apply
 * (ERR_MODULE_NOT_FOUND). identity-scrub.mjs is never deleted by the ceremony
 * (clean-instantiate imports `deriveDynamicTokens`/`walkFiles` from it to run
 * at all), so it is the guard's correct, survives-self-delete home.
 * publish-to-public.mjs now imports + re-exports it for backward-compatible
 * callers (edition-emit.mjs imports it from publish-to-public.mjs unchanged).
 *
 * Extracted from publish-to-public.mjs (the pre-W2 single source) per MO-OPT
 * W2-0 (workspaces/multi-operator-optional). The ADO `principal` (Entra UPN)
 * harvest is NEW here — the pre-W2 deriveDynamicTokens did NOT extract it, so an
 * azure-devops-provider roster's owner identity would have slipped both fences.
 *
 * Node ESM, zero dependencies.
 */
import {
  readdirSync, readFileSync, statSync, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants as FS,
  writeFileSync, renameSync, mkdirSync, chmodSync, rmSync, readlinkSync,
} from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  UnsafeFileReadError, statKind, O_NONBLOCK,
  READ_REGULAR_FILE_MAX_BYTES, readRegularFileNoFollow,
  RedactionMapError, GitEnvelopeError, spawnGitEnveloped,
  nearestRealAncestor, markerAtOrAbove, isInsideGitWorkTree, assertMapPathUsable, resolveRedactionMapPath, resolveAccountHome,
} = createRequire(import.meta.url)("../../hooks/lib/redaction-map-binding.js");
export {
  UnsafeFileReadError, READ_REGULAR_FILE_MAX_BYTES, readRegularFileNoFollow,
  RedactionMapError, GitEnvelopeError, spawnGitEnveloped, isInsideGitWorkTree, resolveRedactionMapPath, resolveAccountHome,
};


/**
 * Read a file as UTF-8 text, or null when it is binary (NUL-byte sniff over the
 * first 8 KiB). Every NON-binary file is therefore scrubbed + gated by DEFAULT
 * (fail-safe: unknown text extensions — .py, .csv, extensionless — are covered).
 * Redteam PR#438 closed the prior isText() extension-allowlist blind spot.
 *
 * NON-REGULAR FILES THROW, they do NOT return null. Every caller reads `null` as "binary → skip",
 * and at the publish gate a skip is a silent pass, so a FIFO/socket/device returning null would
 * be fail-OPEN. It is refused with `UnsafeFileReadError` (it used to HANG: `readFileSync` on a FIFO
 * waits for a writer forever — measured). A read that FAILS (absent, permission) and a DIRECTORY
 * still return null, as before.
 *
 * SYMLINKS ARE STILL FOLLOWED here, deliberately: these callers walk a tree that
 * `assertNoSymlinkEscape` has already vetted, and an in-tree link's target IS tree content the
 * scrub and the gate must see. What is checked is the OPENED descriptor, so a link to a FIFO is
 * refused like a FIFO. Config reads that must never follow a link use `readRegularFileNoFollow`.
 * No size cap: tree files are unbounded by design (the previous read had none either).
 *
 * This is now a THIN WRAPPER: `readTextOrReason` performs the read and can tell
 * "binary, skip by design" from "could not be read at all" — a distinction a
 * FAIL-CLOSED caller needs and this collapse cannot express. Callers that only
 * want the text keep using this, and keep its THROW on a non-regular file.
 */
export function readTextOrNull(f) {
  return readTextOrReason(f).text;
}

/**
 * The read behind `readTextOrNull`, DISTINGUISHING WHY the text is absent.
 *
 * `readTextOrNull` collapses "this file is binary, skip it by design" and "this
 * file could not be read at all" into ONE null, so a caller scanning for residual
 * identity tokens cannot tell a legitimate skip from a hole in its own coverage —
 * the two are the same bytes downstream. Its caller is clean-instantiate's
 * assertZero, the FAIL-CLOSED gate whose entire promise is that ZERO canon
 * trust-identity remains, so an unreadable carrier was skipped while the ceremony
 * still reported clean. A fail-closed gate MUST be able to tell them apart.
 *
 * MEASURED RATIFICATION (2026-10-06, operator-ratified Gate-1 port): the split is
 * the template-side shape recovered into this module; the throwing contract of
 * `readTextOrNull` is unchanged, because every caller reads a throw as "refuse to
 * run" and a reason would silently downgrade that to "skip me".
 *
 * @returns {{text: string|null, reason: "ok"|"binary"|"unreadable"|"directory", error?: string}}
 *   `binary` and `directory` are DELIBERATE non-text outcomes (never a coverage
 *   hole); `directory` is its own value rather than folded into either, because a
 *   directory passed to a FILE read is an EISDIR — not content, and not a failed
 *   read. Only `unreadable` means the read is UNKNOWN for a path that expected to
 *   yield text.
 */
export function readTextOrReason(f) {
  let fd;
  try { fd = openSync(f, FS.O_RDONLY | O_NONBLOCK); } catch (err) {
    // A SOCKET cannot be opened at all (ENXIO / EOPNOTSUPP), so its kind is only visible to a stat
    // of the name. Without this it read as a failed read → `null` → "binary, skip" — the silent
    // pass the refusal below exists to prevent (measured: a socket returned null). A genuinely
    // failed read (absent, permission) still returns null.
    let st = null;
    try { st = statSync(f); } catch { /* absent / unstattable: a failed read */ }
    const k = st ? statKind(st) : "file";
    if (k !== "file" && k !== "directory") throw new UnsafeFileReadError(path.basename(String(f)), k, `it is a ${k}, not a regular file`);
    if (k === "directory") return { text: null, reason: "directory" };
    return { text: null, reason: "unreadable", error: (err && err.code) || String(err) };
  }
  let buf;
  try {
    const k = statKind(fstatSync(fd));
    // A directory is not content and never blocks; it keeps its former `null` (EISDIR) result.
    if (k === "directory") return { text: null, reason: "directory" };
    if (k !== "file") throw new UnsafeFileReadError(path.basename(String(f)), k, `it is a ${k}, not a regular file`);
    const chunks = [];
    const b = Buffer.allocUnsafe(64 * 1024);
    for (let n; (n = readSync(fd, b, 0, b.length, null)) > 0; ) chunks.push(Buffer.from(b.subarray(0, n)));
    buf = Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof UnsafeFileReadError) throw e;
    return { text: null, reason: "unreadable", error: (e && e.code) || String(e) };
  } finally {
    closeSync(fd);
  }
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return { text: null, reason: "binary" }; // binary → skip
  return { text: buf.toString("utf8"), reason: "ok" };
}

// ── THE CANONICAL IDENTITY DECLARATION ───────────────────────────────────────
// `orgSets` / `privateOrgSlugs` and the org-value validator were defined in
// `strip-build-internal.mjs` until 2026-10-10 and MOVED here unchanged in behaviour;
// that module imports and re-exports them, so every existing import still resolves.
//
// WHY THEY MOVED. `deriveDynamicTokens` (below) now harvests the private REPOSITORY
// names, and a repository is private exactly when its owner is a private org — so this
// module needs the private org set. `strip-build-internal.mjs` already imports this
// module (`foldForGate`), so importing it back would close an import CYCLE that every
// importer of this module would then load, including the ones that never touch
// strip-build-internal today. A new third module would avoid the cycle but needs its own
// distribution classification on every lane and edition, and an importer that ships
// without it fails to load. Here, the declaration reader stays zero-dependency and
// travels wherever this module already does.
//
// Read MODULE-RELATIVE (`../../canon-identity-values.json` from `.claude/bin/lib/`), the
// same anchor the reader always had — this file sits in the same directory.

/** GitHub org-name shape: 2–39 chars — 1-char values ARE REJECTED (F7: the
 * previous regex admitted them while its comment claimed 2–39) — alnum with
 * interior hyphens, and NOT a common word. */
const ORG_VALUE_RX = /^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$/;
// M1 (cc-architect, 2026-10-04): a 2–3 character value is almost always an
// English word once the shape check passes (`is`, `to`, `at` all do), and a
// short true org name is vanishingly rare while the COST of a false positive is
// rewriting prose ("This is a test" → "This is <org> test", measured). So a
// value must ALSO be either ≥4 characters or contain a hyphen — every real
// slug in this ecosystem carries the hyphen (both the private canon slug and
// the public template org are hyphenated; neither is written here, and the
// literal that briefly was is exactly what the delivered-tree scan caught
// before this line learned to describe instead of name). A genuinely short org
// can be added to the stopword-exempt seed deliberately.
const ORG_VALUE_MIN = 4;
const ORG_VALUE_STOPWORDS = new Set([
  "a", "an", "at", "is", "it", "of", "on", "or", "to", "in", "by",
  "the", "and", "for", "org", "com", "github", "enterprise", "foundation",
]);
function assertValidOrgValue(value, where) {
  const v = String(value).trim().toLowerCase();
  const longEnough = v.length >= ORG_VALUE_MIN || v.includes("-");
  if (!ORG_VALUE_RX.test(v) || !longEnough || ORG_VALUE_STOPWORDS.has(v)) {
    // LOG-HYGIENE (Tier-1 r4): the REJECTED value is itself a candidate private
    // identity (this function validates the private declaration) — print its
    // LENGTH and the redacted placeholder, never the value.
    throw new Error(
      `strip-build-internal: INVALID org value ${JSON.stringify("<PRIVATE-ORG>")} (length ${v.length}) at ${where}. ` +
        "Org values must be GitHub-org-shaped (2–39 chars, alnum + interior hyphens), ≥4 chars or " +
        "hyphen-bearing, and not a common word. Refusing rather than rewriting prose with an invalid slug.",
    );
  }
  return v;
}

/**
 * THE CANONICAL ORG SETS — read from `.claude/canon-identity-values.json`, the
 * canonical identity declaration (already fenced `loom_only` +
 * CLIENT_TEMPLATE_REMOVE, so it ships nowhere). This is the SOURCE for the
 * private-slug guarantee:
 *   • PRIVATE slugs are subject to the delivery GATE (sync-tier-aware asserts
 *     ZERO case-insensitive occurrences, raw substring, any form, in every
 *     delivered and emitted tree) and to the best-effort path-prefix rewrites.
 *   • RETIRED slugs stay in the private set forever (F4): a transfer or rename
 *     would otherwise silently SHRINK the set while the old slug sits in
 *     carriers.
 *   • PUBLIC slugs are orgs the templates LIVE IN — clone URLs and runner
 *     endpoints naming them are CORRECT and are never gated or rewritten.
 *   • NEVER only the current `remote_links`: this declaration is the authority.
 *   • A non-string or malformed entry THROWS rather than being skipped (F4).
 * LAZY (F1): resolved on FIRST USE, never at module load — the client-template
 * seed and the public fork are `coc-source` trees with NO ecosystem.json, and an
 * import-time throw deadlocks `/ecosystem-init`. The DISTRIBUTION entrypoints
 * call `assertPrivateOrgConfig()` (strip-build-internal) before they distribute;
 * the scanner and coc-manifest imports NEVER throw on a missing config.
 */
const CANON_IDENTITY_REL = path.join("..", "..", "canon-identity-values.json");
let _orgSets = null;
export function orgSets() {
  if (_orgSets) return _orgSets;
  const identityPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    CANON_IDENTITY_REL,
  );
  let rawText;
  try {
    rawText = readFileSync(identityPath, "utf8");
  } catch (e) {
    // L1 (cc-architect, 2026-10-04): ONLY absence is the benign case. Any OTHER
    // read error (EACCES, EISDIR, ELOOP …) is NOT "no config" — treating it as
    // MISSING would silently empty the private set and disarm both the gate and
    // the rewrites. Rethrow it typed.
    if (e && e.code === "ENOENT") {
      // ABSENT (a fork or downstream consumer without canon identity): EMPTY
      // sets, NO throw — /ecosystem-init supplies the fork's own values later.
      return (_orgSets = { private: [], retired: [], public: [] });
    }
    throw new Error(
      `canon-identity-values.json could not be read at ${CANON_IDENTITY_REL}: ${e && e.code ? e.code : "read error"}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(
      // L2 (security read): V8's JSON.parse message QUOTES an excerpt of the
      // input, and this file holds the org slugs — the excerpt printed the
      // value. Generic message; the position is not worth the disclosure.
      // The RELATIVE constant, never the full path, and never through
      // `strip-build-internal.mjs::redactPrivateIdentity`: this throw runs INSIDE
      // orgSets() (the memo is not yet set), and that redactor resolves the slug
      // set via orgSets — MEASURED as unbounded mutual recursion ("Maximum call
      // stack size exceeded") on the malformed-config pole.
      `canon-identity-values.json present but unparseable at ${CANON_IDENTITY_REL} — refusing ` +
        "to proceed with a silently-emptied private set (the parser's message is withheld: it quotes the input).",
    );
  }
  const read = (key) => {
    const v = parsed ? parsed[key] : undefined;
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      throw new Error(`canon-identity-values.json::${key} must be an array (got ${typeof v})`);
    }
    return v.map((s) => {
      if (typeof s !== "string") {
        throw new Error(
          // F6a (security read): print the TYPE only — JSON.stringify of the
          // entry could echo a value-shaped string (or an object carrying one).
          `canon-identity-values.json::${key} holds a NON-STRING entry (type ${Array.isArray(s) ? "array" : typeof s}) — refusing to skip it silently (F4).`,
        );
      }
      return assertValidOrgValue(s, `canon-identity-values.json::${key}`);
    });
  };
  return (_orgSets = {
    private: read("private_org_slugs"),
    retired: read("retired_org_slugs"),
    public: read("public_org_slugs"),
  });
}
/** The orgs subject to rewriting AND to the delivery gate: private + retired. */
export function privateOrgSlugs() {
  const s = orgSets();
  return [...new Set([...s.private, ...s.retired])].sort();
}

// ── PRIVATE REPOSITORY NAMES — derived from `.gitmodules`, never typed ──────
// A repository whose owner is a PRIVATE org (`privateOrgSlugs`, private + retired) has a
// name that is itself a disclosure token: it names a non-public sibling system. The only
// file in a checkout that declares such a repository is the root `.gitmodules` (the url of
// each submodule section), so the set is DERIVED from it. No module may write one of these
// names as a literal: a typed list ships the very value it exists to withhold.
//
// FAIL-CLOSED, mirroring `edition-emit.mjs::declaredSubmodulePaths` and NOT the
// fail-SAFE-toward-walking direction of `submodule-paths.mjs` — that module answers "which
// subtree may a walker skip", where an empty answer restores the old walk; this answers
// "which names must a gate hold", where an empty answer silently disarms the gate:
//   - no `.gitmodules` (a consumer, a fork, most trees)  → [] (the one legitimate empty);
//   - an empty private org set                           → [] WITHOUT reading the file
//     (nothing can be owned by a private org, so a consumer is never bricked by its own
//     `.gitmodules`);
//   - present but a symlink, FIFO, directory, unreadable → `UnsafeFileReadError` (typed);
//   - a submodule section with no url, a url that does not parse into an owner and a
//     repository, or a private-owned name too short to gate → `PrivateRepoNameError`.
// Every message names a section INDEX and a LENGTH, never a url or a name.
//
// DECLARED BOUNDS: a private repository that is NOT a submodule of this checkout is not
// derivable here and is not in the set; a RELATIVE submodule url (`../x.git`) names no
// owner in its own text, so it is refused rather than guessed.

/** The typed refusal of the `.gitmodules` derivation. `code` is `ERR_PRIVATE_REPO_NAMES`. */
export class PrivateRepoNameError extends Error {
  constructor(detail) {
    super(`.gitmodules: refusing to derive the private repository names — ${detail}`);
    this.name = "PrivateRepoNameError";
    this.code = "ERR_PRIVATE_REPO_NAMES";
  }
}

// The git-config subset `.gitmodules` uses: `[submodule "x"]` / `[submodule.x]` headers and
// `key = value` lines. Same grammar `submodule-paths.mjs` parses for `path =`; restated
// here rather than imported so this module stays zero-dependency (it is the survives-
// self-delete home `clean-instantiate.mjs` relies on — see the header).
const GITMODULES_SECTION_RE = /^\s*\[([^\]]*)\]\s*$/;
const GITMODULES_KEY_RE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/;
// Counted independently of the section parse: a header the section regex cannot read (a
// missing `]`) is still a submodule declaration, and dropping it would drop its url.
const GITMODULES_RAW_HEADER_RE = /^\s*\[\s*submodule\b/gim;

function isSubmoduleSectionHeader(header) {
  const name = header.trim().toLowerCase();
  return name === "submodule" || name.startsWith("submodule.") || name.startsWith('submodule "');
}

/** Unquote / unescape one git-config value and drop an unquoted inline `#`/`;` comment. */
function decodeGitConfigValue(raw) {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break;
      i++;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "#" || ch === ";")) break;
    out += ch;
  }
  return out.trim();
}

/**
 * The OWNER candidates and the REPOSITORY a remote url names, lower-cased — or null when
 * the url names no host (a relative or local path) or no path segment at all.
 *
 * Forms: `https://host/org/repo(.git)`, `ssh://[user@]host[:port]/org/repo(.git)`, the scp
 * form `[user@]host:org/repo(.git)`, and Azure DevOps (`dev.azure.com/<org>/<project>/_git/
 * <repo>`, `ssh.dev.azure.com:v3/<org>/<project>/<repo>`, `<org>.visualstudio.com/…`).
 * The repository is the LAST segment. EVERY earlier segment is an owner candidate, and so is
 * every HOST label (the org of `<org>.visualstudio.com`, or a self-hosted forge named for its
 * org), so a GitLab subgroup path, an ADO project path, a path-prefixed host and a host-root
 * repository (`https://host/repo.git`, no owner segment) all classify without a per-host
 * table: a match on ANY candidate makes the repository private, which can only widen the
 * gate, never narrow it. A host-root url is CLASSIFIED rather than refused — its owner is the
 * host, which is a parsed fact; only a url with no host at all (relative, local) is ambiguous.
 */
function remoteOwnersAndRepo(url) {
  let raw = String(url).trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!raw) return null;
  let host;
  let pathPart;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (scheme) {
    if (scheme[1].toLowerCase() === "file") return null;
    const rest = scheme[2];
    const slash = rest.indexOf("/");
    host = slash === -1 ? rest : rest.slice(0, slash);
    pathPart = slash === -1 ? "" : rest.slice(slash + 1);
  } else {
    // scp form `[user@]host:path`. A one-letter "host" is a Windows drive (`C:\…`, `C:/…`)
    // and anything carrying a path separator before the colon is a LOCAL path, not a host.
    const scp = /^(?:[^@/\\\s]+@)?([^/\\:\s]+):(.+)$/.exec(raw);
    if (!scp || scp[1].length === 1) return null;
    host = scp[1];
    pathPart = scp[2];
  }
  host = host.replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
  if (!host) return null;
  // `_git` is Azure DevOps' vendor segment, never an owner or a repository.
  const segs = pathPart.split("/").filter((s) => s && s !== "_git");
  if (segs.length < 1) return null;
  const owners = segs.slice(0, -1).map((s) => s.toLowerCase());
  for (const label of host.split(".")) if (label) owners.push(label);
  return { owners, repo: segs[segs.length - 1].toLowerCase() };
}

// A repository name the GATE can hold: GitHub's repository-name alphabet, and long enough
// (or hyphenated) that a raw substring scan does not fire on ordinary prose — the same floor
// `assertValidOrgValue` applies to an org, for the same reason. A private-owned name that
// fails it is REFUSED, never dropped: dropping it would leave that repository ungated.
const REPO_NAME_RX = /^[a-z0-9._-]{1,100}$/;
function repoNameProblem(name) {
  if (!REPO_NAME_RX.test(name) || name === "." || name === "..") return "is not repository-name-shaped";
  // A punctuation-only name (`-`, `---`, `...`) passes the alphabet check and then rides
  // the hyphen clause below regardless of length, yet can never be a real repository
  // name. As a gate TOKEN it is worse than useless: `-` or `---` matches ordinary prose
  // (markdown rules, table separators), so a crafted `.gitmodules` could mint a token
  // that either floods the scan or, in the scrub direction, mangles every hyphen it
  // touches. Security review 2026-10-11: require at least one letter or digit.
  if (!/[a-z0-9]/.test(name)) return "carries no letter or digit";
  if (!(name.length >= ORG_VALUE_MIN || name.includes("-")) || ORG_VALUE_STOPWORDS.has(name)) {
    return "is too short (or too common a word) to gate without halting on ordinary prose";
  }
  return null;
}

/**
 * The repositories a `.gitmodules` TEXT declares under a private owner, lower-cased,
 * deduplicated, sorted. PURE: no filesystem. Throws `PrivateRepoNameError` on a section it
 * cannot classify (see the block comment above); a url under a NON-private owner
 * contributes nothing.
 * @param {string} text   the `.gitmodules` content
 * @param {string[]} slugs the private (+ retired) org slugs
 * @returns {string[]}
 */
export function parsePrivateRepoNames(text, slugs) {
  if (typeof text !== "string") throw new PrivateRepoNameError("the declaration is not text");
  const priv = new Set((slugs || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const sections = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = GITMODULES_SECTION_RE.exec(line);
    if (sec) {
      cur = isSubmoduleSectionHeader(sec[1]) ? { urls: [] } : null;
      if (cur) sections.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = GITMODULES_KEY_RE.exec(line);
    if (kv && kv[1].toLowerCase() === "url") cur.urls.push(decodeGitConfigValue(kv[2]));
  }
  const rawHeaders = (text.match(GITMODULES_RAW_HEADER_RE) || []).length;
  if (rawHeaders !== sections.length) {
    throw new PrivateRepoNameError(
      `${rawHeaders} submodule header(s) but only ${sections.length} readable section(s) — a malformed header would drop its url`,
    );
  }
  const out = new Set();
  sections.forEach((s, i) => {
    if (s.urls.length === 0) {
      throw new PrivateRepoNameError(`submodule section #${i} (0-based) declares no url, so its owner cannot be classified`);
    }
    for (const u of s.urls) {
      const parsed = remoteOwnersAndRepo(u);
      if (!parsed) {
        throw new PrivateRepoNameError(
          `submodule section #${i} (0-based): its url (length ${u.length}) names no owner and repository ` +
            "(a relative, local or unrecognized remote form) — refusing rather than guessing its owner",
        );
      }
      if (!parsed.owners.some((o) => priv.has(o))) continue;
      const problem = repoNameProblem(parsed.repo);
      if (problem) {
        throw new PrivateRepoNameError(
          `submodule section #${i} (0-based): its private-owned repository name (length ${parsed.repo.length}) ${problem}`,
        );
      }
      out.add(parsed.repo);
    }
  });
  return [...out].sort();
}

// The checkout THIS module belongs to (`.claude/bin/lib/` → three levels up) — the same
// anchoring `orgSets` uses for the declaration, so the default answer is always about the
// checkout whose canon identity is loaded.
const MODULE_CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let _defaultPrivateRepoNames = null;

/**
 * The private repository names `<root>/.gitmodules` declares — by default THIS module's own
 * checkout. `slugs` overrides the private org set (hermetic fixtures pass a synthetic one);
 * absent, `privateOrgSlugs()` is used, and the default call is memoized like `orgSets`.
 * @param {string} [root]
 * @param {{ slugs?: string[]|null }} [opts]
 * @returns {string[]}
 * @throws {UnsafeFileReadError|PrivateRepoNameError}
 */
export function privateRepoNames(root = MODULE_CHECKOUT_ROOT, { slugs = null } = {}) {
  const set = slugs || privateOrgSlugs();
  if (!set.length) return [];
  const memo = slugs === null && path.resolve(root) === MODULE_CHECKOUT_ROOT;
  if (memo && _defaultPrivateRepoNames) return [..._defaultPrivateRepoNames];
  const txt = readRegularFileNoFollow(path.join(root, ".gitmodules"), { label: ".gitmodules", allowAbsent: true });
  const names = txt === null ? [] : parsePrivateRepoNames(txt, set);
  if (memo) _defaultPrivateRepoNames = names;
  return [...names];
}

/**
 * Synthesize a same-length, same-case-class hex placeholder for a real
 * fingerprint, so a scrubbed fingerprint keeps its shape without carrying the
 * real bytes. (e.g. "DEADBEEFDEADBEEF…" truncated to the real length.)
 */
export function synthHex(real) {
  const p = "DEADBEEF";
  let s = "";
  for (let i = 0; i < real.length; i++) s += p[i % p.length];
  return real === real.toLowerCase() ? s.toLowerCase() : s;
}

/**
 * The scrub's REPLACEMENT vocabulary — every literal `to` value a `scrub.push([from, to])` in
 * this module writes, declared ONCE. Every push site below uses these constants, so the set a
 * scrub WRITES and the set `isScrubPlaceholderToken` RECOGNIZES are one list and cannot drift.
 *
 * Why it has to be recognizable: a carrier scrubbed IN PLACE (a NEUTRALIZE'd
 * `.claude/trust-root.json` whose signer `person_id` now reads `maintainer`) is later READ BACK
 * as an identity source by `scan-synced-disclosure.mjs::loadOperatorIdentityShape` and by
 * `clean-instantiate.mjs::snapshotCanonTokens`. Without this list the scanner harvested the
 * scrubber's own placeholder as an operator identity and flagged every file containing the
 * English word (measured: 219 findings on the client-template edition, 79 on a
 * clean-instantiate'd copy), while clean-instantiate exempted `maintainer` by its own literal —
 * two filters disagreeing about one vocabulary.
 *
 * The other replacement the scrub writes is `synthHex(real)` (fingerprints, root commits), an
 * UNBOUNDED family rather than a literal — see `isSynthHexStream`. NOT listed, because no
 * identity field ever holds them as a whole value: the computed `SHA256:<synthHex>…` prose
 * form, the cross-repo-receipt filename `<target>` rewrite, and the home-path `<user>` segment
 * (a path shape with its own scanner shape, never a harvested token). Placeholders are, by
 * construction, nobody's identity; this module still carries ZERO real identity.
 */
export const SCRUB_PLACEHOLDER = Object.freeze({
  EMAIL: "maintainer@example.com",
  LOGIN: "maintainer",
  DISPLAY_NAME: "Example Maintainer",
  NAME_VARIANT: "example-maintainer",
  HOST: "example-host",
  DOMAIN: "example.com", // a WHOLE declared domain — RFC 2606 reserved, so it names nobody. Written
  // by `harvestDomain`'s whole-domain substitution (`.claude/bin/lib/identity-scrub.mjs::harvestDomain`), which
  // rewrites the domain ALONE, bounded, rather than an address: `EMAIL` merely CONTAINS this domain.
  TENANT: "a downstream tenant",
  CANON_OWNER: "<canon-owner>",
  ADO_PROJECT: "<ado-project>",
  // A private repository name (`privateRepoNames`). NOT angle-bracketed, deliberately: the
  // angle form is reserved for neutralize SENTINELS a SUBSTITUTE-mode static entry may
  // supersede (`isNeutralizeSentinel`), and no public substitute exists for a private
  // repository — every lane neutralizes it to this one generic name.
  PRIVATE_REPO: "example-repo",
});
const SCRUB_PLACEHOLDER_LOWER = new Set(Object.values(SCRUB_PLACEHOLDER).map((v) => v.toLowerCase()));

/**
 * True when `t` is a prefix of the infinite `deadbeef…` stream (case-insensitive) — exactly the
 * shape `synthHex` writes, at any length (a truncated, non-multiple-of-8 form included).
 */
export function isSynthHexStream(t) {
  const low = String(t).toLowerCase();
  if (low.length === 0) return false;
  for (let i = 0; i < low.length; i++) if (low[i] !== "deadbeef"[i % 8]) return false;
  return true;
}

/**
 * True when `t` IS one of the scrub's replacement values: an EXACT, case-insensitive member of
 * `SCRUB_PLACEHOLDER` (never a prefix or substring — `maintainers`, `example-hostname` and
 * `maintainer2` are NOT placeholders), or a `synthHex` stream at least `minSynthHexLength` long.
 * The floor is the caller's: a scanner reading a roster whose real login may be spelled like a
 * short hex word (`DeadBeef`) floors it; a gate filtering its OWN derive output need not.
 * DECLARED BOUND for every caller: a real identity spelled exactly like a placeholder
 * (a login `maintainer`) is indistinguishable from the placeholder and is not seen.
 */
export function isScrubPlaceholderToken(t, { minSynthHexLength = 1 } = {}) {
  if (typeof t !== "string") return false;
  if (SCRUB_PLACEHOLDER_LOWER.has(t.toLowerCase())) return true;
  // A redaction-map token (`@@CAT-NNN@@`, see § REDACTION MAP) is a replacement, never an
  // identity: a gate reading scrubbed bytes back must not flag the token it wrote.
  if (isRedactionToken(t)) return true;
  return t.length >= minSynthHexLength && isSynthHexStream(t);
}

/**
 * Harvest NAME + EMAIL from an armored PGP public-key block's UID packets. The
 * redteam proved the armored key base64-decodes to literal "Name <email>" bytes,
 * so a newly-rostered operator's identity is auto-gated without a hand edit.
 *
 * W2-0 fix: decode from the PARSED `keys[].pubkey` field (real newlines), NOT a
 * regex match over the raw roster TEXT. In the on-disk JSON the pubkey newlines
 * are `\n`-ESCAPED (backslash+n); `Buffer.from(s,"base64")` silently keeps the
 * stray `n`s and CORRUPTS the decode — so the pre-W2 raw-text scan recovered the
 * fingerprint (a separate field) but ZERO name/email from canon's real roster
 * (verified: emailish=0, nameish=0). Decoding the parsed field closes the gap.
 */
/**
 * Machine-derive the common separator-variants of a multi-part identity token:
 * "alex.kim" → ["alex-kim","alex_kim","alexkim"]. Used so the dynamic gate
 * covers every separator form WITHOUT a hand-maintained literal (MO-OPT holistic
 * redteam MO-R1-H2). Only emits forms >=5 chars distinct from the input — keeps
 * includes()-grep false-positives low while strengthening the fail-closed gate.
 */
function separatorVariants(token) {
  const parts = String(token).toLowerCase().split(/[.\-_ ]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const out = new Set();
  for (const sep of [".", "-", "_", ""]) out.add(parts.join(sep));
  out.delete(String(token).toLowerCase());
  return [...out].filter((v) => v.length >= 5);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mail / identity-provider domains SHARED by unrelated people. Such a domain identifies nobody,
 * and gating it would halt every publish that mentions it, so it yields NO domain token — the
 * local-part still does. `onmicrosoft.com` is the Entra default suffix: the TENANT label to its
 * left (`<tenant>.onmicrosoft.com`) is the identity, never the suffix itself (see
 * DOMAIN_SUFFIXES_2 / publicSuffixLength). The RFC 2606 example domains are here so a fixture
 * address never derives `example` as a token.
 */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com",
  "fastmail.com", "hey.com", "qq.com", "163.com", "yandex.com", "yandex.ru",
  "github.com", "users.noreply.github.com", "noreply.github.com",
  "example.com", "example.org", "example.net",
]);

/**
 * Labels that are never an identity when they sit where a domain's owner label would: RFC 2606 /
 * RFC 6761 / RFC 8375 special-use names and the host names every machine has. `localhost` from
 * a `user@localhost` SSH comment, or `example` from `jdoe@example.test`, would otherwise become an
 * unbounded gate token that matches ordinary prose.
 */
const GENERIC_DOMAIN_LABELS = new Set([
  "example", "localhost", "localdomain", "local", "lan", "home", "internal", "intranet",
  "test", "invalid", "onion", "arpa", "corp", "mail", "email", "smtp", "www",
]);

/**
 * Labels that are generic TOP-LEVEL domains or ccTLD registry categories. Never an owner label: as
 * a gate token each matches ordinary text (`com` inside `command`).
 */
const TLD_LIKE_LABELS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "io", "co", "ac", "app", "dev",
]);

/**
 * MULTI-LABEL PUBLIC SUFFIXES recognised by NAME: a small hand-picked set MODELLED ON the Public
 * Suffix List (https://publicsuffix.org/list/public_suffix_list.dat) plus Entra tenant suffixes and
 * `fritz.box` (a vendor-private home-router namespace the PSL does not carry). It is NOT a copy of
 * the PSL and was NOT verified entry-by-entry against the live list — an earlier revision of this
 * comment said "as read on 2026-09-27", which was false and is withdrawn. A domain these rules do
 * not size correctly yields NO owner label (harvestDomain's exact-structure rule), so a gap here
 * costs a missed tenant label, never a wrong one.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "onmicrosoft.com", "mail.onmicrosoft.com", "onmicrosoft.us", "onmicrosoft.de", "onmicrosoft.cn", "sharepoint.com",
  "home.arpa", "fritz.box",
  "blogspot.com", "github.io", "gitlab.io", "herokuapp.com", "azurewebsites.net", "cloudapp.net",
  "appspot.com", "firebaseapp.com", "web.app", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
  "s3.amazonaws.com",
  "gouv.fr", "asso.fr", "presse.fr", "govt.nz", "school.nz", "school.za", "gouv.qc.ca", "police.uk", "parliament.uk",
]);
/** Wildcard suffixes (`*.<x>`): the label directly left of `<x>` is PART of the suffix (cloud machine names). */
const WILDCARD_SUFFIXES = ["compute.amazonaws.com", "compute-1.amazonaws.com", "compute.amazonaws.com.cn"];

/**
 * How many trailing labels of a lower-cased, dot-split domain are its PUBLIC SUFFIX:
 *   1. a wildcard suffix (`*.compute-1.amazonaws.com` — the machine label belongs to the suffix);
 *   2. `k12.<state>.us`;
 *   3. a NAMED multi-label suffix (MULTI_LABEL_SUFFIXES), longest first;
 *   4. under a two-letter ccTLD, a second-level label of AT MOST 3 characters when a label sits to
 *      its left (`co.uk`, `sch.uk`, `ltd.uk`, `nhs.uk`, `per.sg`, `gen.in`, `id.au`, `ne.jp`, …);
 *   5. otherwise the one-label TLD.
 */
function publicSuffixLength(labels) {
  const n = labels.length;
  for (const w of WILDCARD_SUFFIXES) {
    const k = w.split(".").length;
    if (n >= k + 1 && labels.slice(-k).join(".") === w) return k + 1;
  }
  if (n >= 3 && labels[n - 1] === "us" && labels[n - 2].length === 2 && labels[n - 3] === "k12") return 3;
  for (const k of [3, 2]) if (n >= k && MULTI_LABEL_SUFFIXES.has(labels.slice(-k).join("."))) return k;
  if (n >= 3 && labels[n - 1].length === 2 && labels[n - 2].length <= 3) return 2;
  return 1;
}

/**
 * The scrub key for a WHOLE declared domain: bounded so it never rewrites inside a longer host name
 * or word. The left boundary excludes `.` and `-` as well as alphanumerics, so a declared
 * `amazonaws.com` does not turn `s3.amazonaws.com` into `s3.example.com`; the right boundary also
 * refuses a following `.label`. An occurrence the key declines is still seen by the unbounded GATE,
 * which HALTS — the failure direction is a halt, never a silent rewrite of someone else's host.
 */
function domainScrubRe(d) {
  return new RegExp("(?<![A-Za-z0-9.\\-])" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9\\-]|\\.[A-Za-z0-9])", "gi");
}

/**
 * Push a DERIVED token — an exact PART of a declared value (a local-part, a machine name left
 * after stripping `.local`), never a guess. It is always a GATE token. It becomes a SCRUB key only
 * when it cannot be an ordinary word — it carries a digit, `.`, `-`, `_` or another non-letter —
 * and then WORD-BOUNDED. A letters-only derived token (`jdoe`, `mini`, `work`, `data`) is gate-only:
 * the scrubber rewrote such words inside ordinary text (`workflow` → `example-hostflow`, `database`
 * → `maintainerbase`, measured), a SILENT corruption no later gate can see. Gate-only makes the
 * failure a loud publish HALT that the adjudication registry can clear.
 */
function pushDerived(tok, to, gate, scrub) {
  const t = String(tok).trim();
  if (t.length < TENANT_TOKEN_MIN_LEN) return;
  gate.push(t);
  if (/[^\p{L}\p{M}]/u.test(t)) scrub.push([t, to, { bounded: true }]);
}

/**
 * Harvest the identity a DOMAIN carries.
 *
 *   WHOLE DOMAIN — the declared value itself: a GATE token and a bounded SCRUB key (domainScrubRe).
 *   OWNER LABEL  — a HEURISTIC guess at the tenant (`contoso` in `jdoe@contoso.com`): GATE ONLY,
 *                  never a scrub key and never given separator variants. A heuristic label used as
 *                  a silent-rewrite key was the root of a whole class (`amazonaws`, `us-west-2`,
 *                  `fritz`, `k12`, `com` became keys and rewrote `s3.amazonaws.com`, `github.com`,
 *                  `command` in published output — measured). As a gate token a wrong guess HALTS.
 *                  Taken only when the structure is fully accounted for: exactly `<owner>.<suffix>`,
 *                  with only special-use labels (`mail`, `corp`, `www`, …) to its left; anything
 *                  else yields no owner label. `ownerLabel:false` (SSH comment hosts, whose names
 *                  are machines, not tenants) never takes one.
 *   PRIVATE NAMESPACE — a special-use tail (`.local`, `.internal`, `.lan`, `.corp`, `.home.arpa`, …)
 *                  is stripped. If exactly ONE label remains, it is the machine / tenant name
 *                  exactly (`zqhost` in `zqhost.local`) and is pushed as a DERIVED token
 *                  (pushDerived). If more remain and they end in a TLD-shaped label
 *                  (`<org>.com.local`), the owner rule applies to them; otherwise
 *                  (`ip-….us-west-2.compute.internal`) there is no owner.
 *
 * Nothing is harvested for a shared mail domain (GENERIC_EMAIL_DOMAINS), a bare named suffix, or a
 * domain of special-use labels only (`localhost.localdomain`).
 */
function harvestDomain(domain, gate, scrub, { ownerLabel = true, hostTo = SCRUB_PLACEHOLDER.HOST } = {}) {
  const d = String(domain).trim().toLowerCase().replace(/\.$/, "");
  if (!d || GENERIC_EMAIL_DOMAINS.has(d) || MULTI_LABEL_SUFFIXES.has(d)) return;
  const all = d.split(".");
  if (all.some((l) => l === "")) return;
  let labels = all;
  while (labels.length && (GENERIC_DOMAIN_LABELS.has(labels[labels.length - 1]) ||
    (labels.length >= 2 && labels.slice(-2).join(".") === "home.arpa"))) {
    labels = labels.slice(0, labels.slice(-2).join(".") === "home.arpa" ? -2 : -1);
  }
  if (labels.every((l) => GENERIC_DOMAIN_LABELS.has(l))) return; // special-use labels only
  if (d.length >= TENANT_TOKEN_MIN_LEN) { gate.push(d); scrub.push([domainScrubRe(d), SCRUB_PLACEHOLDER.DOMAIN]); }
  const stripped = labels.length < all.length;
  if (stripped && labels.length === 1) { pushDerived(labels[0], hostTo, gate, scrub); return; }
  if (!ownerLabel) return;
  if (stripped && !TLD_LIKE_LABELS.has(labels[labels.length - 1]) && labels[labels.length - 1].length !== 2) return;
  const suffix = publicSuffixLength(labels);
  const oi = labels.length - suffix - 1;
  if (oi < 0) return;
  if (labels.slice(0, oi).some((l) => !GENERIC_DOMAIN_LABELS.has(l))) return; // unaccounted labels: no guess
  const owner = labels[oi];
  if (GENERIC_DOMAIN_LABELS.has(owner) || TLD_LIKE_LABELS.has(owner) || owner.length < TENANT_TOKEN_MIN_LEN) return;
  gate.push(owner); // GATE ONLY — see above
}

/**
 * Local-parts that name a ROLE or a SERVICE, not a person (`admin@<tenant>`, `build@<tenant>`,
 * `root@<host>`, `data@<tenant>`). None is emitted on its own; the whole address and its domain
 * still are. A closed list cannot be complete. What an UNLISTED dictionary-word local-part costs is
 * now bounded by pushDerived: a letters-only one is a GATE token only, so it can HALT a publish
 * (false positive, adjudicable) but is never a scrub key, so it cannot silently rewrite text; one
 * carrying a digit or punctuation is a word-bounded scrub key. That is what makes "errs toward a
 * false-positive halt, never a silent corruption" true — an earlier revision claimed it while the
 * key was an unbounded scrub pair (`data` rewrote `database`, measured).
 *
 * MEMBERSHIP IS PINNED BY A TEST, in BOTH directions. See
 * `L2 LOCAL-PART: the machine/role name set is PINNED in BOTH directions`.
 *
 * THIS LIST IS THE E-MAIL SURFACE ONLY, and it is NOT the operator-home exclusion. The two are
 * NOT derived from one another, and the reason is that their FAILURE DIRECTIONS ARE OPPOSITE: a
 * wrong skip here costs a FALSE-POSITIVE HALT (a legitimate token stops being extracted), while a
 * wrong exclusion on the home-path side costs a MISSED DISCLOSURE. A name safe to SKIP as a role
 * mailbox is therefore NOT thereby safe to EXCLUDE as a home — `build@tenant` is a role mailbox,
 * but a home directory named `build` may be a real operator.
 *
 * THE PATH IS DESCRIBED, NEVER WRITTEN, and that is a deliberate change: an earlier revision of
 * this paragraph spelled one out, and a literal `/home/<name>` IS the exact shape this fence scans
 * for — so the sentence explaining a MISSED DISCLOSURE was itself a disclosure finding in a file
 * that ships (`.claude/bin/lib/**`, measured: `scan-synced-disclosure --check` rc=1 on the tip that
 * carried it, rc=0 on the tip without it). Describing the shape keeps the point and costs nothing.
 * If you are about to restore a literal for readability: it is a finding, and the fence is right.
 *
 * The incident: the path-side exclusion was briefly DERIVED from this list, which imported
 * machine-account names into a disclosure fence whose failure direction is the unsafe one. The
 * derivation was reverted. Keep the two literal and keep them separate.
 *
 * (`ci` can never be emitted as a token on this surface — it is 2 characters and
 * `TENANT_TOKEN_MIN_LEN` is 3 — so adding it here is INERT for token extraction. Whether it
 * matters elsewhere in this module is unmeasured.)
 */
const GENERIC_LOCAL_PARTS = new Set([
  "admin", "administrator", "root", "user", "info", "contact", "support", "noreply", "no-reply",
  "donotreply", "do-not-reply", "test", "dev", "git", "mail", "webmaster", "postmaster", "hostmaster",
  "security", "sales", "office", "hello", "team", "ubuntu", "ec2-user", "runner", "maintainer", "owner",
  "operator", "build", "builder", "deploy", "deployer", "release", "bot", "service", "svc", "automation",
  "devops", "backup", "scanner", "monitor", "monitoring", "alert", "alerts", "notify", "notifications",
  "jenkins", "azure", "sync", "api", "app", "system", "sysadmin", "help", "helpdesk", "abuse",
  "billing", "accounts", "finance", "marketing", "news", "newsletter", "bounce", "mailer-daemon",
  "data", "work", "home", "mini", "studio",
]);

/**
 * Push the tokens a LOCAL-PART yields, each through pushDerived: the local-part as written
 * (surrounding `"` of an RFC 5321 quoted local-part removed) and, for a `+` sub-address, the BASE
 * before the first `+` — never the TAG after it (`jdoe+ado` → `ado` is a free label). Each is
 * floored at > 2 and skipped when it is a role word or all digits. Separator variants (MO-R1-H2:
 * `alex.kim` → `alex-kim`, `alexkim`) are variants of an EXACT declared part, not of a guess, and
 * go through pushDerived too.
 */
function harvestLocalPart(lp, gate, scrub) {
  const whole = String(lp).trim().replace(/^"(.*)"$/, "$1");
  const plus = whole.indexOf("+");
  for (const part of new Set(plus > 0 ? [whole, whole.slice(0, plus)] : [whole])) {
    const t = part.trim();
    if (t.length <= 2 || GENERIC_LOCAL_PARTS.has(t.toLowerCase()) || /^\d+$/.test(t)) continue;
    pushDerived(t, SCRUB_PLACEHOLDER.LOGIN, gate, scrub);
    for (const v of separatorVariants(t)) pushDerived(v, SCRUB_PLACEHOLDER.LOGIN, gate, scrub);
  }
}

/** Push one email (gate + scrub, whole declared value) + its local-part + its domain. */
function harvestEmail(email, gate, scrub, domainOpts) {
  gate.push(email); scrub.push([email, SCRUB_PLACEHOLDER.EMAIL]);
  const at = email.lastIndexOf("@");
  harvestLocalPart(email.slice(0, at), gate, scrub);
  harvestDomain(email.slice(at + 1), gate, scrub, domainOpts);
}

/**
 * Harvest the parts of an Entra userPrincipalName (`<local>@<domain>`, roster `principal`) that a
 * citation actually uses: the LOCAL-PART (harvestLocalPart) and the TENANT domain (harvestDomain:
 * whole domain gated + scrubbed, owner label gated only). The whole UPN is pushed by the caller as a
 * person-id token. An Entra B2B guest UPN (`<local>_<home-domain>#EXT#@<tenant>`) also yields its
 * HOME address, rebuilt from the `_` before `#EXT#`.
 */
function harvestPrincipalParts(upn, gate, scrub) {
  const at = upn.lastIndexOf("@");
  if (at <= 0 || at === upn.length - 1) return;
  let local = upn.slice(0, at);
  harvestDomain(upn.slice(at + 1), gate, scrub);
  const ext = /^(.+)#EXT#$/i.exec(local);
  if (ext) {
    local = ext[1];
    const us = local.lastIndexOf("_");
    if (us > 0 && us < local.length - 1) {
      const home = local.slice(0, us) + "@" + local.slice(us + 1);
      if (new RegExp("^" + EMAIL_RE.source + "$").test(home)) {
        harvestEmail(home, gate, scrub);
        local = local.slice(0, us);
      }
    }
  }
  harvestLocalPart(local, gate, scrub);
}

/** Push one display name (trimmed, floor > 2) + its separator variants. */
function harvestDisplayName(name, gate, scrub) {
  const n = String(name).trim();
  if (n.length <= 2) return;
  gate.push(n); scrub.push([n, SCRUB_PLACEHOLDER.DISPLAY_NAME]);
  for (const v of separatorVariants(n.toLowerCase())) { gate.push(v); scrub.push([v, SCRUB_PLACEHOLDER.NAME_VARIANT]); }
}

/**
 * Harvest a UID display name under the full rule set: the name as written; the name with every
 * parenthesised `( … )` segment removed, trimmed and whitespace-collapsed (so the standard
 * `Name (Comment) <email>` UID also yields the plain `Name` a citation actually uses); and each
 * comment's inner text (floor > 2). Used by BOTH the packet path and the text-scan fallback.
 */
function harvestUidName(display, gate, scrub) {
  const whole = String(display).trim();
  harvestDisplayName(whole, gate, scrub);
  const bare = whole.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (bare !== whole) harvestDisplayName(bare, gate, scrub);
  for (const m of whole.matchAll(/\(([^()]*)\)/g)) {
    const inner = m[1].trim();
    if (inner.length > 2) { gate.push(inner); scrub.push([inner, SCRUB_PLACEHOLDER.LOGIN]); }
  }
}

/**
 * Text-scan fallback for a key blob that does NOT parse as a packet stream: every UID-looking
 * segment directly followed by ` <x@y>` — the run of text back to the previous boundary (a
 * control character, U+FFFD from an undecodable byte, `<` or `>`), capped at the last 128
 * characters so a long run stays bounded and the result deterministic. Covers mononyms and
 * lower-case particles the Capitalised-words shape cannot see.
 */
const UID_SEGMENT_RE = /([^\p{Cc}\uFFFD<>]{1,128}) <[^<>\s@]+@[^<>\s]+>/gu;

/**
 * Walk an OpenPGP packet stream (RFC 4880 §4.2, old + new format headers) and return the bodies
 * of its User ID packets (tag 13), or null when the stream does not parse cleanly (truncated
 * length, partial-length body, indeterminate length) — the caller then falls back to a text scan.
 */
function pgpUidPackets(buf) {
  const uids = [];
  let i = 0;
  while (i < buf.length) {
    const h = buf[i++];
    if (!(h & 0x80)) return null;
    let tag, len;
    if (h & 0x40) { // new format
      tag = h & 0x3f;
      if (i >= buf.length) return null;
      const o1 = buf[i++];
      if (o1 < 192) len = o1;
      else if (o1 < 224) { if (i >= buf.length) return null; len = ((o1 - 192) << 8) + buf[i++] + 192; }
      else if (o1 === 255) { if (i + 4 > buf.length) return null; len = buf.readUInt32BE(i); i += 4; }
      else return null; // partial body length
    } else { // old format
      tag = (h >> 2) & 0x0f;
      const lt = h & 0x03;
      const n = lt === 0 ? 1 : lt === 1 ? 2 : lt === 2 ? 4 : 0;
      if (n === 0 || i + n > buf.length) return null; // indeterminate length / truncated
      len = n === 1 ? buf[i] : n === 2 ? buf.readUInt16BE(i) : buf.readUInt32BE(i);
      i += n;
    }
    if (i + len > buf.length) return null;
    if (tag === 13) uids.push(buf.subarray(i, i + len));
    i += len;
  }
  return uids;
}

/**
 * Every intact User ID packet (tag 13) inside a byte stream that does NOT parse as a whole, found
 * by scanning for a tag-13 header at every offset: old format `0xB4`/`0xB5` (1- or 2-octet
 * length) and new format `0xCD` (1- or 2-octet length). A candidate counts only when its declared
 * body fits the buffer, is valid UTF-8, and is WHOLLY a UID ending in an address —
 * `<name> <local@domain>` with no control character — so a stray header byte inside key material
 * does not produce one. A UID without an address is not recognisable here; the text fallback
 * covers what it can of that case.
 */
function salvageUidPackets(buf) {
  const out = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i + 1 < buf.length; i++) {
    const h = buf[i];
    let len, start;
    if (h === 0xb4) { len = buf[i + 1]; start = i + 2; }
    else if (h === 0xb5) { if (i + 3 > buf.length) continue; len = buf.readUInt16BE(i + 1); start = i + 3; }
    else if (h === 0xcd) {
      const o1 = buf[i + 1];
      if (o1 < 192) { len = o1; start = i + 2; }
      else if (o1 < 224 && i + 2 < buf.length) { len = ((o1 - 192) << 8) + buf[i + 2] + 192; start = i + 3; }
      else continue;
    } else continue;
    if (len < 1 || start + len > buf.length) continue;
    let text;
    try { text = utf8.decode(buf.subarray(start, start + len)); } catch { continue; }
    if (!/^[^\p{Cc}<>]+ <[^<>\s@]+@[^<>\s]+>$/u.test(text)) continue;
    out.push(Buffer.from(text, "utf8"));
  }
  return out;
}

/**
 * Harvest NAME + EMAIL from each armored PGP block in a pubkey field.
 *
 * UID packets are decoded as UTF-8 (RFC 4880 §5.11), not latin1: latin1 turned `José García`
 * into mojibake that matches no text. When the block parses as a packet stream, EVERY UID yields
 * its display name — the text before ` <`, trimmed, or the whole UID when it has no email — as
 * ONE token (floor > 2) with its separator variants. The previous ASCII-only regex demanded two
 * or more Capitalised words, so `Ludwig van Beethoven`, mononyms and non-Latin names yielded only
 * their email. When the stream does NOT parse (e.g. a hand-built fixture), the text-scan fallback
 * applies the old name shape with Unicode letter classes over the UTF-8 decode. Emails are always
 * harvested from the whole decode, as before.
 */
function harvestPgpUid(pubkeyText, gate, scrub) {
  if (typeof pubkeyText !== "string") return;
  for (const block of pubkeyText.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g) || []) {
    let bytes;
    try {
      // Armor headers (RFC 4880 §6.2: `Version`, `Comment`, `Hash`, `Charset`, `MessageID`, and
      // any other `Key: value`) are dropped by SHAPE, not by name: a line holding `:` cannot be
      // base64 payload. Only `Comment`/`Version` used to be dropped, so a `Hash:` or `MessageID:`
      // header's letters were decoded AS payload, shifted every byte after them, and the block's
      // name and email left the gate (measured: 0 of 2 harvested).
      const b64 = block
        .replace(/-----(BEGIN|END) PGP PUBLIC KEY BLOCK-----/g, "")
        .replace(/^[^\n]*:[^\n]*$/gm, "")
        .replace(/\n=[^\n]{4}\s*$/, "")
        .replace(/\s+/g, "");
      bytes = Buffer.from(b64, "base64");
    } catch { continue; }
    const decoded = bytes.toString("utf8");
    for (const m of decoded.matchAll(EMAIL_RE)) harvestEmail(m[0], gate, scrub);
    const uids = pgpUidPackets(bytes);
    if (uids && uids.length) {
      for (const u of uids) {
        const text = u.toString("utf8");
        const lt = text.indexOf(" <");
        harvestUidName(lt >= 0 ? text.slice(0, lt) : text.replace(/<[^>]*>/g, ""), gate, scrub);
      }
    } else {
      // The stream does not parse as a whole (a truncated or partial-length packet anywhere), but
      // its UID packets usually still sit intact inside it. Located by HEADER and sliced by the
      // declared LENGTH (salvageUidPackets), a UID's name comes out exact. The text shapes below
      // cannot do that: the byte before a UID body is its packet LENGTH, which is often printable
      // and glues onto the segment — an uppercase glued letter defeated the Capitalised-words
      // shape too, so only `K<Name>` was harvested and `<Name>` itself read clean (measured).
      for (const u of salvageUidPackets(bytes)) {
        const text = u.toString("utf8");
        harvestUidName(text.slice(0, text.lastIndexOf(" <")), gate, scrub);
      }
      // Both text shapes, additively, for a blob that holds no locatable UID packet at all (e.g. a
      // hand-built fixture): the boundary segment (UID_SEGMENT_RE) catches mononyms and lower-case
      // particles; the Capitalised-words shape starts at a capital, so a LOWER-case glued length
      // byte still yields the clean name there.
      for (const m of decoded.matchAll(UID_SEGMENT_RE)) harvestUidName(m[1], gate, scrub);
      for (const m of decoded.matchAll(/(\p{Lu}[\p{L}\p{M}.'’-]+(?: \p{Lu}[\p{L}\p{M}.'’-]+)+) <[^>]+>/gu)) {
        harvestUidName(m[1], gate, scrub);
      }
    }
  }
}

/**
 * Harvest identity from an OpenSSH public-key line (`ssh-<alg> <base64> [comment]`, also
 * `ecdsa-…` and `sk-…`): the COMMENT (trimmed, floor > 2) and, when it contains an email, that
 * email + local-part exactly as the PGP email harvest does. The key BODY is deliberately NOT
 * harvested: it is a public key, not an identity, and its SHA256 fingerprint is already carried
 * by `keys[].fingerprint`. Before this, an SSH pubkey contributed nothing, so a `user@host`
 * comment — typically the operator's login and machine — was never gated.
 */
function harvestSshPubkey(pubkeyText, gate, scrub) {
  if (typeof pubkeyText !== "string") return;
  for (const line of pubkeyText.split(/\r?\n/)) {
    const m = /^\s*(?:ssh-[A-Za-z0-9.@-]+|ecdsa-[A-Za-z0-9.@-]+|sk-[A-Za-z0-9.@-]+)\s+[A-Za-z0-9+/=]+(?:\s+(.*))?$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const comment = m[1].trim();
    if (comment.length <= 2) continue;
    gate.push(comment); scrub.push([comment, SCRUB_PLACEHOLDER.LOGIN]);
    // A comment `user@<machine>.local` (the macOS ssh-keygen default) IS an email to EMAIL_RE, so it
    // is harvested HERE and never reaches the no-dot branch below. The whole host is gated and
    // scrubbed; the machine name alone is derived ONLY by stripping a special-use tail
    // (`<machine>.local`), never guessed as an "owner" label (`ownerLabel:false`) — a cloud host
    // `ec2-….compute-1.amazonaws.com` made `amazonaws` a scrub key (measured).
    for (const e of comment.matchAll(EMAIL_RE)) harvestEmail(e[0], gate, scrub, { ownerLabel: false });
    // `user@host` with no dot-TLD (the ssh-keygen default comment) is not an email to EMAIL_RE,
    // so its parts are harvested here: the login and the machine name, each floored at > 2. A
    // special-use host (`localhost`) names no machine and is not a token.
    for (const word of comment.split(/\s+/)) {
      const uh = /^([^@\s]+)@([^@\s]+)$/.exec(word);
      if (!uh || new RegExp(EMAIL_RE.source).test(word)) continue;
      // Both parts through pushDerived: a letters-only login or host (`work`) is gate-only — as an
      // unbounded scrub key `work` rewrote `workflow` (measured).
      if (!GENERIC_LOCAL_PARTS.has(uh[1].toLowerCase())) pushDerived(uh[1], SCRUB_PLACEHOLDER.LOGIN, gate, scrub);
      if (!GENERIC_DOMAIN_LABELS.has(uh[2].toLowerCase())) pushDerived(uh[2], SCRUB_PLACEHOLDER.HOST, gate, scrub);
    }
  }
}

/** Every identity a `pubkey` field carries: PGP UIDs and OpenSSH comments. ONE entry point. */
function harvestPubkeyIdentity(pubkeyText, gate, scrub) {
  harvestPgpUid(pubkeyText, gate, scrub);
  harvestSshPubkey(pubkeyText, gate, scrub);
}

/** Depth-first walk of every file under `dir`, calling cb(absolutePath). */
export function walkFiles(dir, cb) {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkFiles(full, cb);
    else cb(full);
  }
}

/**
 * FAIL-CLOSED symlink-escape assertion over a materialized/checked-out `tree` (#825
 * Wave-3 R-LOW-1 / 06c; relocated here 2026-07-10 per the F7 redteam MEDIUM fix — see
 * the file-level doc comment above for why this guard lives here and not in
 * scripts/publish-to-public.mjs).
 *
 * `walkFiles` (above) resolves entries with `statSync`, which FOLLOWS symlinks: a
 * symlink to an external FILE is `readFileSync`-followed by a scrub/identity-token
 * walk, and a symlink to an external DIRECTORY makes the walk RECURSE OUTSIDE the
 * scanned surface. A disclosure/token scan then only flags identity TOKENS, so a
 * symlink to a structurally-sensitive-but-token-free target escapes every fence —
 * and on the clean-instantiate CLEAR ceremony, `neutralizeWholeTree`'s
 * `writeFileSync(f, after)` would WRITE THROUGH such a symlink to an arbitrary path
 * on the operator's machine. This assertion closes that class for every caller that
 * runs a `walkFiles`-driven pass over a materialized tree.
 *
 * The assertion is `lstat`-based (SEES the link node — `walkFiles`'s `statSync`
 * cannot, it dereferences) and does NOT recurse through a symlinked directory. A
 * symlink whose `realpathSync` target stays INSIDE `tree` is benign (idempotent
 * re-scrub); a target that ESCAPES the tree root, OR is unresolvable (dangling →
 * the scan would error/fail-closed), is a finding. Callers assert BEFORE their
 * first destructive/tree-walking step so no escaping symlink is ever FOLLOWED.
 * Throws (fail-closed) naming every escaping link by its TREE-RELATIVE path; the resolved
 * target is withheld (`<outside the tree>`), because it is an absolute path on the operator's machine.
 *
 * @param {string} tree  absolute path to the materialized/checked-out tree
 * @returns {void}  throws on the FIRST walk that finds ≥1 escaping / unresolvable symlink
 */
export function assertNoSymlinkEscape(tree) {
  const root = realpathSync(tree);
  const escaped = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      let lst;
      try { lst = lstatSync(full); } catch { continue; }
      if (lst.isSymbolicLink()) {
        let real;
        try { real = realpathSync(full); }
        catch { escaped.push(`${path.relative(tree, full)} -> <unresolvable/dangling>`); continue; }
        if (real !== root && !real.startsWith(root + path.sep)) {
          // The TARGET is never printed: it is an absolute path outside the tree — typically
          // `/Users/<operator>/…` — and this message reaches terminals and CI logs unscrubbed. Nor is
          // a root-relative form (`../../<operator>/.ssh/…`), which carries the same segments. The
          // in-tree link name is enough to find and fix it.
          // The link is named relative to `tree`, the base the walk joins onto — NOT to `root`,
          // its realpath: where the two differ (macOS `/var` → `/private/var`, a symlinked
          // checkout) `path.relative(root, full)` climbs out with `../../` and spells the whole
          // absolute path (measured).
          escaped.push(`${path.relative(tree, full)} -> <outside the tree>`);
        }
        // Do NOT recurse THROUGH a symlinked directory (even an in-tree one): the lstat
        // walk enumerates the tree's own structure, never a link's target subtree.
      } else if (lst.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(tree);
  if (escaped.length) {
    throw new Error(
      "tree contains symlink(s) that escape the scanned surface (disclosure-escape / " +
      "arbitrary-file-write, #825 06c): " + escaped.join("; ") + ". A tracked in-tree symlink " +
      "whose target leaves the tree is reproduced verbatim by a recursive copy's default " +
      "dereference:false, and then FOLLOWED by any statSync-based walk (identity-scrub.mjs's " +
      "walkFiles), so its target bypasses the token scan — or, on a write pass, is written " +
      "through to an arbitrary path outside the tree. Remove the symlink from the surface " +
      "or repoint it inside the tree.",
    );
  }
}

/**
 * A FRESH operator-home-path regex each call. The pattern matches any
 * /Users/<name>/ or /home/<name>/ that is NOT the placeholder or a CI runner →
 * structural scrub of operator paths the literal token list misses (e.g. a
 * test-fixture /Users/<name>/). Returned as a factory — NOT a shared module-level
 * const — because the `g` flag carries mutable `lastIndex` state; a shared
 * instance would race between the scrub `.replace()` and the gate `.exec()`.
 */
export function makeHomepathRe() {
  return new RegExp(HOMEPATH_RE_SOURCE, "gu");
}

export function makeHomepathFormRe() {
  return new RegExp(homepathPatternSource(false), "gu");
}

// ── makeHomepathRe, piece by piece. Group 1 is the home ROOT, group 2 the USERNAME CHAIN, in every
// form — consumers read `m[2]`; homepathPlaceholder replaces exactly group 2.
//
// ROOTS. `/Users/` and `/home/` (case-sensitive), and `\Users\` after a backslash — a JSON-escaped
// `\\` is accepted wherever `\` is. Any OTHER casing (`users`, `USERS`) counts only after a DRIVE
// root (`C:\`, `C:/`, `C:\\`) or a UNC share (`\\server\c$\`), so `api\users\list` is not a home.
//
// WINDOWS vs POSIX is decided by what precedes the NAME (WIN_LB): a backslash, or `Users/` reached
// from a drive root or a backslash (`C:/Users/…`, mixed `C:\Users/…`). The separator AFTER the root
// does not decide it — a mixed-separator path used to fall to the POSIX one-word rule.
//
// NAME characters: Unicode letters, marks, digits, `_ . ~ -`, and an apostrophe only BETWEEN
// letters/digits (a trailing one is a closing quote). `~` covers 8.3 names (`JDOEZQ~1`).
//
// WINDOWS NAMES OVER-SCRUB, BY DESIGN. A Windows profile name may hold spaces, and the old rule took
// the spaced form only when it then hit `\ / " ' \x60 CR LF EOI` — every OTHER follower (`, ; : ) |
// # ! …`, `%20`, NBSP, ZWSP, a 5th word) left `<user> <surname>`, and the `<user>` exclusion then
// hid the surname from every later gate (measured). Now a Windows name is: a word, then any number
// of (in-name separator + word), where an in-name separator is a space, tab, any `\p{Zs}` (NBSP …),
// `%20`, or a zero-width character (ZWSP/ZWNJ/ZWJ/WJ/BOM). It stops at the first character that is
// neither. So the failure direction is SAFE: `see C:\Users\<name> then more prose` loses `then more
// prose` too (DECLARED over-scrub: every name-like word after a Windows home up to the first
// non-name character). No word cap. A POSIX name (macOS short name, Linux login) takes no space.
//
// TRAVERSAL. `<home>/<name>/<dot-segments>/<other>` where the dot segments hold at least one `..`
// (with any `.`, `..` or EMPTY segments around it — `/./../`, `//../`, `\.\..\`) names a home of
// `<other>`. The chain `<name>(<dot-segments><sep><name>)*` is the username group, so the whole
// chain is replaced. An excluded name followed by such a traversal is not excluded.
//
// EXCLUDED NAMES (never an operator), and the set is deliberately SHORT: `<user>`, `runner`,
// `runneradmin`, `example`, `Public`, `Default`, plus the two Windows BUILT-IN profile
// directories that are genuinely multi-word (`Default User`, `All Users`). Each is enumerated
// because it is provably not a person; the list is not a place to park every service-sounding
// word, since a name wrongly listed here is a missed disclosure, and the widened forms are
// reachable by a real person's surname (see HP_NB (b)).
//
// LINEAR TIME. No lookbehind has an unbounded quantifier (the UNC one is capped at 64 characters per
// label), and every repetition is disjoint from what follows it. The previous spaced-name lookbehind
// `(?:[^/\\\s]+/)*` made `"C:/Users/".repeat(64000)` take ~39 s (measured).
const HP_SEP = String.raw`(?:/|\\{1,2})`;
const HP_NC = String.raw`(?:[\p{L}\p{M}\p{N}_.~\-]|['’](?=[\p{L}\p{N}]))`;
const HP_START = String.raw`[\p{L}_]`;
const HP_WSTART = String.raw`[\p{L}\p{N}_]`;
const HP_INSEP = String.raw`(?:[\t\p{Zs}]|%20|[\u200B-\u200D\u2060\uFEFF])`;
// The NAME BOUNDARY an excluded name must be followed by, and it rules out TWO classes:
//
// (a) A NAME CHARACTER (`HP_NC`). The narrower `[\p{L}\p{M}\p{N}_]` it replaces is NOT the
//     complement of that class \u2014 `HP_NC` also admits `.`, `~`, `-` and an interior apostrophe \u2014 so
//     a name that merely STARTS with an excluded one was read as the excluded PREFIX: a
//     `<machine>.<surname>` / `<Machine>-<surname>` home was excluded whole (measured on the
//     pre-existing members: the `runner`-, `Public`- and `example`-prefixed dotted forms were each
//     read as just their first segment). That is a missed disclosure, the unsafe direction.
//
// (b) A WINDOWS IN-NAME SEPARATOR (`HP_INSEP`) \u2014 space, tab, `%20`, NBSP, zero-width. This closes a
//     PRE-EXISTING hole (present before and after the boundary above was corrected, FOUND BY
//     SECURITY REVIEW): a space is NOT a name character, so the old boundary passed at one and the
//     lookahead vetoed the WHOLE spaced Windows name \u2014 surname included. A spaced Windows home
//     beginning with the built-in `Public` profile directory name read as that directory, so a real
//     person whose profile was `Public` + a surname was never flagged; the same held for a `runner`
//     + surname profile. With (b) the exclusion applies only when the excluded name is the WHOLE
//     name, so both are flagged. The literals are deliberately NOT written here: they are MATCHING
//     homes now, and one spelled out in this file self-flags the scan (measured \u2014 an earlier
//     revision of this comment reddened the self-scan on two of its own columns).
//
// (b) makes a spaced continuation a NAME, so the built-ins that genuinely ARE multi-word are
// enumerated as whole alternatives in HP_EXCL rather than relying on a prefix (`All Users`,
// `Default User`). That is a SEMANTIC distinction no structural rule can draw, and it is drawn
// where the scanner's own allowlist draws its equivalents: one name at a time, with evidence.
const HP_NB = String.raw`(?!(?:${HP_NC})|(?:${HP_INSEP}))`;
const HP_USERS_ANYCASE = String.raw`[Uu][Ss][Ee][Rr][Ss]`;
const HP_DRIVE_LB = String.raw`(?<=(?:^|[^\p{L}\p{N}_])[A-Za-z]:(?:/|\\{1,2}))`;
const HP_UNC_LB = String.raw`(?<=\\{2,4}[^\\/\s"'<>]{1,64}\\{1,2}[^\\/\s"'<>]{1,64}\\{1,2})`;
const HP_KIND = String.raw`(Users|home|(?:${HP_DRIVE_LB}|${HP_UNC_LB})${HP_USERS_ANYCASE})`;
const HP_UPLOOK = String.raw`(?:${HP_SEP}\.?(?=${HP_SEP}))*${HP_SEP}\.\.(?=${HP_SEP})`;
const HP_DOTSEG = String.raw`${HP_SEP}\.{0,2}(?=${HP_SEP})`;
const HP_EXCL = String.raw`(?!<user>|(?:runner|runneradmin|example|[Pp]ublic|PUBLIC|[Dd]efault|DEFAULT|Default User|All Users)${HP_NB}(?!${HP_UPLOOK}))`;
const HP_WIN_LB = String.raw`(?<=\\|(?:\\|[A-Za-z]:/)${HP_USERS_ANYCASE}/)`;
const HP_WINNAME = String.raw`${HP_START}${HP_NC}*(?:${HP_INSEP}+${HP_WSTART}${HP_NC}*)*`;
const HP_POSIXNAME = String.raw`${HP_START}${HP_NC}*`;
const HP_CHAIN = (name) => String.raw`${name}(?:(?=${HP_UPLOOK})(?:${HP_DOTSEG})+${HP_SEP}${name})*`;
function homepathPatternSource(excludeNonOperatorProfiles) {
  const excluded = excludeNonOperatorProfiles ? HP_EXCL : "";
  return String.raw`${HP_SEP}${HP_KIND}${HP_SEP}${excluded}((?:${HP_WIN_LB}${HP_CHAIN(HP_WINNAME)}|${HP_CHAIN(HP_POSIXNAME)}))`;
}
const HOMEPATH_RE_SOURCE = homepathPatternSource(true);

/**
 * The replacement for a makeHomepathRe match: the match with its USERNAME replaced by `<user>`,
 * separators and root kept as written. For a POSIX match this is byte-identical to the former
 * `"/$1/<user>"`; for a Windows match it keeps the backslashes instead of forging a mixed path.
 */
function homepathPlaceholder(full, username) {
  return full.slice(0, full.length - String(username).length) + "<user>";
}

/**
 * SYNTHETIC operator-home usernames that disclosure-test FIXTURES legitimately
 * plant in `*.test.mjs` so the fork's OWN disclosure tests still fire the scanner
 * after clean-instantiate. Used ONLY by the `*.test.mjs` homepath carve-out
 * (`makeScrubber({ preserveSyntheticFixtureHomes: true })`): a `/Users/<name>/`
 * (or `/home/<name>/`) shape in a test file is PRESERVED iff `<name>`
 * (case-insensitive) is in this set; EVERY OTHER username — including a REAL
 * contributor's macOS home whose name is NOT a roster token — is STILL rewritten
 * to the `/Users/<user>/` placeholder.
 *
 * This is the leak-SAFE form of the #1141-7 fixture carve-out (the prior binary
 * "skip ALL homepath rewriting for *.test.mjs" let a non-token real operator home
 * survive into the client's new ecosystem — an operator-PII-across-ecosystem leak
 * the structural scanner also misses, because clean-instantiate runs it in SOURCE
 * mode where scan-synced-disclosure.mjs excludes *.test.mjs from ALL shapes). The
 * failure direction is SAFE both ways: an unknown username → rewritten (NO leak);
 * a genuinely-synthetic fixture name missing here → over-neutered (a test-QUALITY
 * issue, never a disclosure leak).
 *
 * Membership is derived from the usernames loom's own test files actually use
 * (grep the `/(Users|home)/<name>/` shape across the `.test.mjs` files) PLUS the
 * canonical synthetic placeholders. Deliberately EXCLUDED: the maintainer's own login
 * localpart (the REAL maintainer home — a
 * roster token the dynamic scrub already rewrites to `maintainer`, which this pass
 * then normalizes to `<user>`, defense-in-depth) and `realclient`/`realcontributor`
 * (the counter-example REAL homes the regression tests assert are rewritten).
 * `runner`/`example`/`<user>` are already excluded by makeHomepathRe's lookahead,
 * so they never reach this set.
 */
export const SYNTHETIC_FIXTURE_USERS = new Set([
  "jdoe",         // sync-from-canon.test.mjs disclosure fixture (the #1141-7 motivating case)
  "jane",         // "Jane Doe" placeholder (sibling of jdoe)
  "alice",        // canonical Alice/Bob placeholder pair
  "bob",          // canonical Alice/Bob placeholder pair
  "op",           // generic synthetic operator, widely used in coordination-substrate fixtures
  "someoperator", // explicitly-synthetic operator name
  "fakeuser",     // explicitly-synthetic ("fake" in the name)
  "acme",         // canonical ACME synthetic placeholder
  "x",            // single-char synthetic operator stub
  // NOTE (rt2-security R2 INCREMENTAL): `me` / `user` / `test` / `someone` were
  // DELIBERATELY REMOVED — they are the most plausibly-REAL macOS usernames (a real
  // contributor could literally be named `test`/`user`), are used by ZERO loom
  // *.test.mjs disclosure fixture (grep-verified), and `me` is moot anyway
  // (scan-synced-disclosure already treats the `me` placeholder home as benign).
  // Removing them shrinks the preserve-set to only distinctly-synthetic names,
  // minimizing the real-username-collision surface at zero fixture cost. A future
  // synthetic fixture username not in this set fails SAFE (rewritten, no leak) — add
  // it here with a comment only if a disclosure fixture genuinely needs it preserved.
]);

/**
 * The two disclosure-scrub APPLICATION modes. FAIL-CLOSED: makeScrubber throws on
 * any other value (an unknown/missing mode is never a silent passthrough).
 *
 *   NEUTRALIZE — apply the dynamic pairs (deriveDynamicTokens().scrub: org-slug →
 *                `<canon-owner>` neutralize sentinel, login/display_id → "maintainer",
 *                tenant → "a downstream tenant", fingerprint → synthetic hex) + the
 *                operator-home-path regex ONLY. NO caller-supplied static list. The
 *                mode a CLIENT-TEMPLATE edition uses — it emits generic placeholders,
 *                never a real substitute identity.
 *   SUBSTITUTE — the NEUTRALIZE pairs UNION a caller-passed static substitution list
 *                (the public-fork mode: the caller passes its own loom-only static
 *                list mapping the org slug to the public foundation name, etc.). On a
 *                colliding `from`-key whose DYNAMIC value is a neutralize SENTINEL
 *                (angle-bracket form, e.g. `<canon-owner>`), the static SUBSTITUTE
 *                supersedes it — so the org resolves to the real foundation name, not
 *                the template placeholder. Non-sentinel dynamic pairs keep precedence.
 */
export const SCRUB_MODES = Object.freeze({ NEUTRALIZE: "NEUTRALIZE", SUBSTITUTE: "SUBSTITUTE" });

/**
 * A neutralize SENTINEL is the angle-bracket placeholder form (`<canon-owner>`), or a
 * redaction-map token (`@@CAT-NNN@@`). The map token is a neutralizer by construction — it
 * names a category, never a public substitute — so a SUBSTITUTE-mode static entry for the
 * SAME value (e.g. an org slug's public name) keeps precedence over it, exactly as it does
 * over `<canon-owner>`. Without this, an operator whose map enrols a value a static pair
 * already substitutes would see the public lane write the token instead of the name.
 */
function isNeutralizeSentinel(value) {
  return typeof value === "string" && (/^<[^>]*>$/.test(value) || isRedactionToken(value));
}

/**
 * Build a text scrubber `(text) => scrubbedText` from a set of `[from, to]` dynamic
 * scrub pairs (deriveDynamicTokens().scrub) plus the structural operator-home-path
 * regex, mode-parameterized. This is the shared SCRUB-APPLICATION layer both disclosure
 * fences use; it is identity-FREE (the literal substitution tokens live only in the
 * caller's `staticScrub`, never in this module — so the module stays sync+publish-safe).
 *
 * Pairs are applied LONGEST-`from`-first (a specific multi-token rule runs before a
 * general catch-all) and deduped by `from`-key, FIRST-WINS.
 *
 *   - NEUTRALIZE: `pairs = dynScrubPairs` (staticScrub is never consulted), so the
 *     output can only carry placeholders — never a literal substitute identity.
 *   - SUBSTITUTE: the merge order is `[supersede, ...dynScrubPairs, ...staticScrub]`,
 *     where `supersede` is the subset of staticScrub whose `from`-key collides with a
 *     dynamic pair carrying a NEUTRALIZE SENTINEL value. Placing that subset first lets
 *     first-wins dedup pick the static SUBSTITUTE over the dynamic sentinel (the
 *     org-shadowing fix: the org slug → the real foundation name, not `<canon-owner>`),
 *     while every NON-sentinel dynamic pair (e.g. an identity → "maintainer") keeps its
 *     original precedence over a same-key static catch-all — so the SUBSTITUTE output
 *     is byte-identical to the pre-split scrubber EXCEPT the deliberate sentinel-key
 *     substitutions. Trailing `staticScrub` supplies every static-only key.
 *
 * A FRESH homepath regex is minted per scrubber (the `g` flag carries mutable
 * `lastIndex`; `.replace()` resets it, but a shared instance would still race a
 * concurrent gate `.exec()` — makeHomepathRe's contract).
 *
 * `preserveSyntheticFixtureHomes` (default false) switches the structural
 * operator-home-path rewrite from an UNCONDITIONAL rewrite to a SYNTHETIC-USERNAME
 * ALLOWLIST callback: a `/Users/<name>/` (or `/home/<name>/`) shape is PRESERVED
 * iff `<name>` ∈ `SYNTHETIC_FIXTURE_USERS`, and EVERY OTHER username — including a
 * REAL contributor's macOS home — is STILL rewritten to `/Users/<user>/`. It
 * exists for the clean-instantiate whole-tree neutralize's `*.test.mjs` carve-out:
 * disclosure-test fixtures LEGITIMATELY plant SYNTHETIC operator-home shapes (e.g.
 * a `/Users/<fixture-user>/...` path under a `SYNTHETIC_FIXTURE_USERS` name) the fork's
 * own disclosure tests must trip against — an
 * unconditional rewrite would neuter them into `/Users/<user>/` (a green test that
 * verifies nothing). The narrow allowlist keeps THOSE intact while still closing
 * the operator-PII-across-ecosystem leak a blanket `*.test.mjs` skip opens (a REAL
 * non-token contributor home surviving into the client's new ecosystem — #1141-7
 * rt1-security). The dynamic canon-IDENTITY scrub is NEVER skipped: a real canon
 * token in a test file is still neutralized (and clean-instantiate's assert-zero
 * canon-token grep still covers `*.test.mjs` as the fail-closed backstop). The
 * default path (unconditional rewrite) stays byte-identical, so publish-fence
 * callers are unaffected.
 *
 * @param {[string,string][]} dynScrubPairs  the dynamic pairs (deriveDynamicTokens().scrub)
 * @param {{ mode: string, staticScrub?: [string,string][], preserveSyntheticFixtureHomes?: boolean }} opts
 * @returns {(text: string) => string}
 */
/**
 * The ONE token word-boundary predicate. Boundaries are LETTERS AND DIGITS only, so
 * `<tenant>_backend` is a tenant reference (the `_` joins a slug, not a word) and MUST
 * scrub, while `httpclient` is one word and stays whole for the benign-collision
 * registry to adjudicate.
 *
 * ── DO NOT WIRE THIS INTO THE GATE. The gate is DELIBERATELY unbounded. ──────────────
 *
 * An earlier revision of this comment said the predicate is EXPORTED "because the scrubber
 * and the output GATE must decide 'is this a tenant reference?' identically", citing a
 * 4302536f drift where a bounded scrubber and an unbounded gate disagreed. That instruction
 * is WITHDRAWN, and following it now would CREATE A LEAK on a public surface.
 *
 * MEASURED on this tree: `tokenBoundedRe` is referenced NOWHERE outside this file, and
 * `edition-output-gate.mjs` imports `tokenIsUnadjudicatedHit` (an unbounded `indexOf` scan),
 * NOT this predicate. That asymmetry is LOAD-BEARING, not drift:
 *
 *   - the SCRUBBER is bounded, and additionally SKIPS a match inside an opaque base64 run
 *     (`isInsideOpaqueBase64Run` below);
 *   - the GATE is unbounded and has NO base64 skip, so anything the scrubber declines to
 *     rewrite is still SEEN and still HALTS the publish.
 *
 * The scrubber's narrowing is safe ONLY because the gate does not share it. Wiring this
 * predicate — or the base64 skip — into the gate would convert that fail-safe into a silent
 * leak: the token would be neither scrubbed nor flagged. `edition-output-gate.mjs` (§ LAYER 3)
 * independently records that a bounded predicate WAS tried there and REVERTED for this reason.
 * If the two ever look like they should agree, read both comments before changing either.
 *
 * Returns a fresh RegExp per call: the `g` flag carries `lastIndex` state, so a shared
 * instance would silently skip matches on its second use.
 */
export function tokenBoundedRe(from) {
  return new RegExp("(?<![A-Za-z0-9])" + String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9])", "gi");
}

/**
 * The unbounded sibling of `tokenBoundedRe` — a case-INSENSITIVE literal matcher, used where a
 * pair carries no `{bounded:true}` — most pairs, but NOT "the identity pairs", which this line
 * claimed until 2026-09-08: `root_commit` IS an identity pair and IS bounded. Do not read a
 * category here; read `deriveDynamicTokens` for the live set. Replaces the former
 * `txt.split(from).join(to)`, which was case-SENSITIVE.
 *
 * Returns a fresh RegExp per call, for the same `lastIndex` reason `tokenBoundedRe` documents.
 */
export function tokenUnboundedRe(from) {
  return new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/**
 * The ONE normalization every GATE consumer folds BOTH its haystack AND its token through.
 *
 * ── THE RULE THIS EXISTS TO ENFORCE ──────────────────────────────────────────────────
 * The SAME folding function on BOTH sides of ONE comparison inside ONE component fails
 * CLOSED. TWO DIFFERENT folding functions across TWO components that must AGREE fails OPEN.
 * `disclosure-adjudication.mjs::loadBenignAdjudications` is the first shape — it lowercases
 * `token` and `host` with the same call, and a mismatch merely declines to suppress. The
 * scrubber/gate seam was the second, and it leaked: the SCRUBBER matches with
 * `new RegExp(escape(from), "gi")` while the GATE lowercased and `indexOf`'d, and those two
 * disagree on Unicode. Hence ONE function, exported, called on both sides. Do not inline a
 * second `.toLowerCase()` at a gate call site (`security.md` § Enforcement-Surface Parity).
 *
 * ── WHAT DIVERGED, MEASURED 2026-09-07 ───────────────────────────────────────────────
 *   'İ' (U+0130) .toLowerCase() -> "i" + U+0307   (TWO code points)
 *   /i/i.test('İ')              -> false           (non-unicode `i` folding never maps it)
 *   'K' (U+212A) .toLowerCase() -> "k"             (ASCII k — ONE code point)
 *   /k/i.test('K'(U+212A))      -> false
 * So U+0130 in a NON-FINAL position inserted a combining mark that SPLIT the token in the
 * gate's haystack — token `kaixcorp` written `ka<U+0130>xcorp` lowered to `kai̇xcorp`, and
 * `indexOf("kaixcorp")` failed. Scrubber missed it, gate missed it, the token shipped.
 * U+212A was NEVER that case: it folds to ASCII `k`, so the gate already caught it. The
 * originating review paired the two; only the first evaded both.
 *
 * NFKD decomposes compatibility forms (U+212A -> "K", U+0130 -> "I" + U+0307); stripping
 * `\p{M}` removes the freed marks; `toLowerCase` finishes the fold. Applied to the GATE ONLY.
 *
 * ── DELIBERATELY HIGH-RECALL ─────────────────────────────────────────────────────────
 * Mark-stripping also folds `café` -> `cafe`, so a token `cafe` now HITS on `café`. That is
 * MORE recall on a fail-closed publish fence — a false positive HALTS a publish, the safe
 * direction, and the benign-collision registry exists precisely to adjudicate such pairs.
 * This function MUST NOT be used to rewrite content: it is not a scrub, and normalizing the
 * SCRUBBER would rewrite published bytes (the corruption class `a24b9016` fixed).
 *
 * @param {string} s
 * @returns {string} the folded form — for MATCHING only, never for emission
 */
export function foldForGate(s) {
  return String(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

const BASE64_CH = /[A-Za-z0-9+/=]/;

/**
 * The ONE minimum length for a dynamic gate token, enforced at DERIVE time so no consumer has to
 * invent one. See the tenant-denylist push in `deriveDynamicTokens` for why it lives here and why
 * a shorter token is unusable rather than merely risky.
 */
export const TENANT_TOKEN_MIN_LEN = 3;

/**
 * True IFF the match at `[idx, idx+len)` sits STRICTLY INSIDE an opaque base64 payload.
 *
 * Why this exists: the word-boundary class is `[A-Za-z0-9]`, but base64's alphabet also contains
 * `+`, `/` and `=` — so those characters READ AS WORD BOUNDARIES, and a short tenant token
 * coincidentally occurring inside a base64 blob (`…Yd+<tok>+wbg30…`) satisfies the bounded matcher
 * and gets rewritten, CORRUPTING the payload. Boundedness offers base64 no protection at all.
 *
 * The three conditions are each load-bearing, and the alternative remedy was REJECTED ON
 * MEASUREMENT rather than on taste. Widening the boundary class to `[A-Za-z0-9+/=]` also stops the
 * base64 match, but `/` is a PATH separator: measured over the tracked tree it would stop scrubbing
 * 117 matches, and every one read was GENUINE identity in path position (`<org>/<tenant>`,
 * `<org>/<tenant>_backend`). That is a fence-weakening, so it is not the fix. This predicate stops
 * 4 matches out of 1963 across the whole working tree, and all 4 were read and are opaque blob.
 *
 *   run >= 40 chars   — a real path segment does not reach 40 unbroken base64-alphabet chars;
 *                       mirrors the `{40,}` run length the private-key gate already uses.
 *   run contains + or = — paths and slugs essentially never carry these; base64 payloads almost
 *                       always do. `/` alone is NOT sufficient evidence, precisely because paths
 *                       are full of it.
 *   STRICT interior   — `run.length > len` so a match that IS the whole run is never skipped.
 *                       A coincidence needs surrounding payload; a match with NOTHING around it
 *                       inside the run is the token itself, not an accident of neighbouring
 *                       base64. This protects a long, base64-alphabet, `+`/`=`-carrying TENANT
 *                       token (a denylist entry may be any shape) from being skipped whole.
 *
 * Applied to every `{skipBase64:true}` pair — see the call site, which keys on `opt.skipBase64`
 * and NOTHING ELSE. That is the WHOLE predicate: this function reaches exactly the skipBase64 set.
 *
 * **The flag is its own, and that is the fix.** Until 2026-09-08 the call site keyed this skipper
 * on `opt.bounded`, so the two INDEPENDENT narrowings — word-boundedness and the base64 skip —
 * were one key. A pair that needed only the first silently received the second. That is not a
 * hypothetical: the genesis `root_commit` pair gained `{bounded:true}` on 2026-09-07 to stop it
 * corrupting unrelated 40-hex SHAs, and thereby also became base64-skippable, which nobody
 * intended and no prose recorded. Separating the flags fixes the CAUSE; the earlier round only
 * corrected the prose to match the conflated behaviour, which is why the defect survived it.
 *
 * The live population, re-derivable and not restated as a list: every pair whose third element
 * sets `skipBase64` — today, the tenant-denylist pairs, which carry `{bounded:true, skipBase64:true}`.
 * Identity pairs carry `{bounded:true}` alone and DO reach this function's caller unskipped. Read
 * `deriveDynamicTokens` for the live set; do not trust a category name here.
 *
 * **Before adding `skipBase64` to a NEW pair, enumerate the lanes that apply this scrubber and
 * confirm each one's gate is an unbounded literal-token scan.** That premise is NOT universal —
 * see `deriveDynamicTokens` § 4, where a lane gated by the SHAPE scanner alone is recorded.
 *
 * A previous revision justified STRICT interior as "what keeps an SSH fingerprint safe". That
 * reason was FALSE and is corrected rather than dropped, for the same reason. Fingerprint
 * pairs push NO third element (`scrub.push([h, synthHex(h)])`), so `opt` is undefined, the
 * `opt && opt.bounded` guard at the call site is false, and they take the UNBOUNDED branch —
 * a fingerprint can never reach this function at all. The condition is right; the reason was not.
 */
export function isInsideOpaqueBase64Run(text, idx, len) {
  let s = idx, e = idx + len;
  while (s > 0 && BASE64_CH.test(text[s - 1])) s--;
  while (e < text.length && BASE64_CH.test(text[e])) e++;
  const run = text.slice(s, e);
  return run.length >= 40 && run.length > len && /[+=]/.test(run);
}

/**
 * A STATEFUL skipper with the same verdict as `isInsideOpaqueBase64Run`, memoizing the run bounds
 * across successive matches in ONE `String.replace` pass.
 *
 * Why: the stateless form re-expands the enclosing run on EVERY match, so a file with M matches
 * inside ONE long run costs O(M × runlength). MEASURED on that exact shape (a single contiguous
 * base64 run, the machine-generated `.jsonl` shape where this rule's only 4 real hits live), the
 * stateless form ran 2.8 / 7.8 / 17.7 / 75.9 / 307.8 ms for M = 50 / 100 / 200 / 400 / 800 — a
 * ×4 cost per doubling of M at scale, i.e. quadratic. A publish fence that hangs is a fence that
 * gets bypassed, so the growth is the defect regardless of today's file sizes.
 *
 * Correctness: runs are MAXIMAL, so any index inside a previously-computed `[s, e)` belongs to that
 * same run — the memo can be reused whenever the whole match lies within it, and is recomputed
 * otherwise. `String.replace` scans left-to-right over ONE immutable string, and a fresh skipper is
 * built per pair per text, so the memo can never outlive the string it was computed against.
 */
export function makeOpaqueBase64RunSkipper() {
  let cs = -1, ce = -1, runLen = 0, hasPlusEq = false;
  return function skip(text, idx, len) {
    if (!(idx >= cs && idx + len <= ce)) {
      let s = idx, e = idx + len;
      while (s > 0 && BASE64_CH.test(text[s - 1])) s--;
      while (e < text.length && BASE64_CH.test(text[e])) e++;
      cs = s; ce = e;
      runLen = e - s;
      hasPlusEq = /[+=]/.test(text.slice(s, e));
    }
    return runLen >= 40 && runLen > len && hasPlusEq;
  };
}

export function makeScrubber(dynScrubPairs, { mode, staticScrub = [], preserveSyntheticFixtureHomes = false } = {}) {
  if (mode !== SCRUB_MODES.NEUTRALIZE && mode !== SCRUB_MODES.SUBSTITUTE) {
    throw new Error(
      `identity-scrub makeScrubber: unknown/missing mode ${JSON.stringify(mode)} ` +
      `(expected ${SCRUB_MODES.NEUTRALIZE} or ${SCRUB_MODES.SUBSTITUTE})`,
    );
  }
  let merged;
  if (mode === SCRUB_MODES.NEUTRALIZE) {
    merged = [...dynScrubPairs]; // copy, not alias — the later .sort() must not mutate the caller's array (parity with the SUBSTITUTE branch)
  } else {
    // Static SUBSTITUTE supersedes ONLY a dynamic NEUTRALIZE-sentinel value for the
    // same key (the org-shadowing fix); every other dynamic pair keeps precedence.
    const sentinelKeys = new Set(
      dynScrubPairs.filter(([, v]) => isNeutralizeSentinel(v)).map(([f]) => f),
    );
    const supersede = staticScrub.filter(([f]) => sentinelKeys.has(f));
    merged = [...supersede, ...dynScrubPairs, ...staticScrub];
  }
  const _seen = new Set();
  const keyOf = (f) => (f instanceof RegExp ? f.source : f);
  const pairs = merged
    .sort((a, b) => keyOf(b[0]).length - keyOf(a[0]).length)
    .filter(([f]) => (_seen.has(keyOf(f)) ? false : (_seen.add(keyOf(f)), true)));
  // Boundaries are LETTERS AND DIGITS only: `<tenant>_backend` is a tenant reference
  // (the `_` joins a slug, not a word) and MUST scrub; `httpclient` is one word
  // and stays whole for the benign-collision registry to adjudicate.
  const boundedRe = tokenBoundedRe;
  const homepathRe = makeHomepathRe(); // fresh per scrubber (g-flag lastIndex state)
  // Default: UNCONDITIONAL rewrite (byte-identical to the pre-carve-out behavior).
  // *.test.mjs carve-out: a REPLACE-CALLBACK preserves a match ONLY when its
  // captured username (group 2) is a recognized SYNTHETIC fixture user; any other
  // home — incl. a REAL contributor's — is still rewritten to `/<kind>/<user>`,
  // closing the non-token-home leak (#1141-7 rt1-security).
  const homepathReplace = preserveSyntheticFixtureHomes
    ? (full, kind, username) =>
        SYNTHETIC_FIXTURE_USERS.has(String(username).toLowerCase()) ? full : homepathPlaceholder(full, username)
    : (full, kind, username) => homepathPlaceholder(full, username);
  return (text) => {
    let txt = text;
    for (const [from, to, opt] of pairs) {
      // A RegExp pair's `to` may legitimately BE a function (the cross-repo-receipt pair uses one to
      // rebuild the filename from its captures), so a function is passed through untouched. A
      // STRING `to`, however, went in as a string replacement, where `$&` / `$1` / `` $` `` are
      // INTERPRETED — the same hazard the literal-replacer guard closes on the non-RegExp branch
      // below. It was correct only by accident: today the sole string-valued RegExp pair is
      // synthHex-derived and carries no `$`. Wrapping makes it correct by CONSTRUCTION.
      if (from instanceof RegExp) { txt = txt.replace(from, typeof to === "function" ? to : () => to); continue; }
      // CASE-INSENSITIVE prefilter + replace. The three fences that DETECT a surviving token all
      // lowercase both sides (`edition-output-gate.mjs::assertDisclosureCleanNeutralize`,
      // `publish-to-public.mjs::runIdentityTokenGate`, `scan-synced-disclosure.mjs`'s
      // `customer-identity-token` shape at `new RegExp(alt,"gi")`), while THIS applicator — the
      // only one that NEUTRALIZES — matched case-SENSITIVELY. A token whose on-disk case differed
      // from the SSOT case was therefore detected and never removed: measured, a Title-case tenant
      // token reached a PUBLIC `is_template` repo through all three fences, and 1150 lowercase
      // occurrences of a denylist slug were surviving a differently-cased SSOT entry.
      //
      // Replacement is CANONICAL, never case-preserving: every `to` is a placeholder
      // (`maintainer` / `a downstream tenant` / `<canon-owner>` / synthetic hex) for which source
      // case carries no meaning, and a multi-word placeholder has no well-defined case to preserve.
      // This is also what `clean-instantiate.mjs::neutralizeWholeTree`'s former
      // `[from, lower, upper]` enumeration already produced, so canonical form keeps that
      // behaviour byte-identical while additionally covering Title case, which that enumeration
      // MISSED — and which was the form actually leaking.
      //
      // The replacer is a FUNCTION so `to` is inserted LITERALLY: `String.replace` interprets `$&`
      // / `$1` in a string replacement, whereas the `split(from).join(to)` this supersedes did not.
      // A `to` carrying a `$` would otherwise silently change meaning.
      //
      // MEASURED before landing: no replacement string case-insensitively contains any gate token
      // (0 collisions, checker shown to fire on a planted case), so no pair's output is ever
      // re-matched as another pair's input, and the applicator is IDEMPOTENT
      // (`scrub(scrub(x)) === scrub(x)` over the corpus: 1294 files changed, 0 non-idempotent).
      //
      // That measurement does NOT establish ORDER-INDEPENDENCE, and an earlier revision of this
      // comment claimed it did. The two are different propositions: idempotence asks whether a
      // `to` can become a later `from`; the base64 skip additionally reads the NEIGHBOURING
      // CHARACTERS of a partially-scrubbed `txt`. MEASURED, it IS order-dependent — pairs run
      // longest-`from`-first, and an identity replacement that removes a run-BREAKING character
      // (`pid-canon-owner`, whose `-` splits a run) with an all-base64-alphabet placeholder
      // (`maintainer`) MERGES two fragments into one longer run, flipping a LATER tenant token's
      // skip verdict from scrubbed to skipped.
      //
      // Recorded rather than fixed, because the direction is FAIL-SAFE and the fence is elsewhere:
      // the flip makes the SCRUBBER more permissive, and the GATE is unbounded with no base64 skip,
      // so the surviving token HALTS the publish instead of shipping. Ordering the pairs to remove
      // the coupling would trade a loud halt for a silent rewrite — strictly worse.
      if (!tokenUnboundedRe(from).test(txt)) continue;
      // TWO ORTHOGONAL NARROWINGS, each doing exactly what its name says and NOTHING to the other.
      //
      // `bounded`     chooses the MATCHER: word-bounded, so the token is not rewritten inside an
      //               unrelated identifier (a 40-hex SHA, a UUID). Without it, unbounded.
      // `skipBase64`  chooses whether a match sitting STRICTLY INSIDE an opaque base64 run is
      //               declined. Rewriting there is CONTENT CORRUPTION of a payload, not a leak.
      //
      // They are computed INDEPENDENTLY and composed, rather than nested. An earlier revision of
      // this fix nested the skipper inside the `bounded` branch, which made the real predicate
      // `bounded AND skipBase64` while the docblock claimed it was `skipBase64` alone — so a pair
      // written `{skipBase64:true}` would have silently received NEITHER narrowing. That is the
      // same prose-asserts-what-code-does-not class this whole change exists to close, and it was
      // caught by review of this commit's own diff. Composition makes the four combinations mean
      // what a reader would predict:
      //
      //   {}                             unbounded, no skip   — every identity pair by default
      //   {bounded:true}                 bounded,   no skip   — the genesis root_commit anchor
      //   {bounded:true,skipBase64:true} bounded,   skip      — the tenant-denylist pairs
      //   {skipBase64:true}              unbounded, skip      — no live pair, but it now WORKS
      //
      // `skip` is fresh per pair per text — the memo must never outlive its string.
      const skip = opt && opt.skipBase64 ? makeOpaqueBase64RunSkipper() : null;
      const re = opt && opt.bounded ? boundedRe(from) : tokenUnboundedRe(from);
      // The replacer is a FUNCTION so `to` is inserted LITERALLY: a `to` carrying `$&` or `$1`
      // would otherwise be interpreted as a substitution pattern.
      txt = txt.replace(re, (m, offset, whole) => (skip && skip(whole, offset, m.length) ? m : to));
    }
    return txt.replace(homepathRe, homepathReplace); // structural operator-home-path scrub
  };
}

/**
 * Derive the dynamic (per-repo) identity tokens from `repoDir`'s canonical
 * sources. FAIL-LOUD on a present-but-unparseable denylist/roster — a silently
 * empty gate is fail-OPEN on the exact axis it protects (mirrors the scanner's
 * loadCustomerIdentityShape "never silently disable the guard" contract).
 *
 * @param {string} repoDir absolute path to the repo root whose .claude/ holds
 *        disclosure-tenant-denylist.json + operators.roster.json, and whose root
 *        `.gitmodules` declares the private repositories (§ 5 below).
 * @param {{ privateSlugs?: string[]|null, redactionMap?: string|false|undefined }} [opts]
 *        `privateSlugs`: the private org set § 5 classifies owners against; absent,
 *        `privateOrgSlugs()` (this checkout's declaration). A hermetic fixture passes a
 *        synthetic set. `redactionMap`: the operator's redaction map (§ 6) — a path, `false`
 *        to disable it, or absent for the account selector
 *        (.claude/hooks/lib/redaction-map-binding.js::resolveRedactionMapPath).
 * @returns {{ scrub: [string,string][], gate: string[], gateBounded: string[], unhonoured: object[] }}
 *        `gate` is matched as an UNBOUNDED substring; `gateBounded` holds tokens EVERY gate consumer
 *        MUST also match, but WORD-BOUNDED (`gateTokenHit(..., { bounded: true })`) — see § 6.
 */
export function deriveDynamicTokens(repoDir, { privateSlugs = null, redactionMap } = {}) {
  const scrub = [], gate = [], gateBounded = [];
  // Tokens the operator DECLARED but this function cannot honour — today, denylist entries below
  // TENANT_TOKEN_MIN_LEN. Carried out as a THIRD return key (purely additive; every consumer
  // destructures by name) so a PUBLISH FENCE can fail CLOSED on it. A `console.warn` alone is not
  // enough at a fence: the operator asked for a token to be protected, the system cannot protect
  // it, and publishing anyway ships exactly what they asked to withhold. LENGTHS ONLY, never
  // values — this array is surfaced in operator-visible error text that is not itself scrubbed.
  const unhonoured = [];

  // (1) customer/tenant tokens from the denylist SSOT — gate AND self-scrub (so
  // a NEW tenant token added to the denylist self-scrubs without a STATIC edit).
  const denyPath = path.join(repoDir, ".claude/disclosure-tenant-denylist.json");
  // readRegularFileNoFollow, not `existsSync` + `readFileSync`: those FOLLOWED a symlink (an
  // inbound tree could point this path at any file on the operator's machine), HUNG on a FIFO, and
  // read a DANGLING link as absent — a silently-disabled gate. Only "nothing at the path" is absent
  // now; anything else that is not a regular file is a typed refusal (UnsafeFileReadError).
  const denyTxt = readRegularFileNoFollow(denyPath, { label: "disclosure-tenant-denylist.json", allowAbsent: true });
  if (denyTxt !== null) {
    // jsonParseOrThrow, not JSON.parse + `e.message`: V8's syntax-error text quotes input bytes,
    // and in this file those bytes are the tenant names the gate exists to withhold.
    const parsed = jsonParseOrThrow(denyTxt, "disclosure-tenant-denylist.json");
    // Parseable is not the same as well-formed: the former `.tokens || []` iterated a STRING
    // `tokens` character by character (every char then dropped by the floor) and read `{}`, `[]`,
    // a mis-cased key or a non-string entry as an EMPTY gate. The validator refuses all of those.
    const toks = denylistTokensOrThrow(parsed, "disclosure-tenant-denylist.json");
    for (const t of toks) {
      // BOUNDED: a short tenant token inside an unrelated identifier (the shape
      // the benign-collision registry adjudicates) must NOT be cut out of the
      // word — the glued remainder hands a reader the token by subtraction,
      // which is the exact leak the scan's word-bounded shape and the benign-
      // collision registry exist to avoid (measured, docket round 7). The gate
      // still sees the token; the registry adjudicates the in-word host.
      // FLOOR AT DERIVE TIME (2026-09-08). This was the ONLY unfloored gate push in this
      // function — every roster-side push already floors at `> 2` (pid, per-key fields, genesis
      // values) or higher (root_commit `{7,64}`, fingerprints `>= 16`). Leaving this one open let
      // each CONSUMER invent its own answer, and measured on 2026-09-08 three of them had three
      // DIFFERENT ones: `edition-output-gate` no floor at all, `publish-to-public` `>= 2`,
      // `clean-instantiate` `>= 3` — the last fail-OPEN at the ceremony whose entire job is to
      // assert ZERO canon identity. A floor is a property of the TOKEN SET, not of a fence; the
      // producer states it once, here, and the consumers no longer disagree.
      //
      // Value `>= 3` is the LOWEST minimum any other push site already produces, not a value they
      // all "match" — an earlier revision said "matches what the other five push sites enforce" and
      // both the count and the verb were wrong. Measured: four sites guard `> 2` (pid, per-key
      // fields, genesis values, PGP localpart); separator-variants `>= 5`; `root_commit` `{7,64}`;
      // fingerprints `>= 16`; the `SHA256:` prefix is a fixed 13. Two more push from
      // `harvestPgpUid` with NO explicit guard at all — their minima (>=6, >=5) are implied by the
      // regexes that produced them, so the invariant holds but a reader auditing it will find no
      // floor there. That is why the producer invariant is PINNED by a test rather than argued here.
      //
      // It is also the only usable value: a 2-char token substring-matches nearly every file in a
      // tree, so admitting one would red `assertZero` on noise and make `/clean-instantiate`
      // unrunnable.
      //
      // The drop is LOUD, and that is load-bearing. Filtering silently would trade a LOCALIZED
      // fail-open (one fence) for a GLOBAL one (the token vanishes for every consumer at once,
      // with nothing to report it) — strictly worse. Lengths are named, never the token values:
      // the values are the secret this whole function exists to protect.
      const tt = typeof t === "string" ? t.trim() : "";
      if (tt && tt.length < TENANT_TOKEN_MIN_LEN) {
        unhonoured.push({ reason: "below-min-length", length: tt.length, floor: TENANT_TOKEN_MIN_LEN });
        console.warn(
          `[identity-scrub] DROPPED a disclosure-tenant-denylist token of length ${tt.length}: ` +
          `below the ${TENANT_TOKEN_MIN_LEN}-char floor, so it is NOT in the gate and NOT self-scrubbed. ` +
          `A token this short substring-matches ordinary text and would make assert-zero unrunnable. ` +
          `Lengthen the entry or scrub that surface another way — this token is currently protecting nothing.`,
        );
        continue;
      }
      // Push `tt`, NOT `t`. The floor above measures the TRIMMED value, so pushing the raw one
      // installs a token whose length was never the one checked. Measured before the fix: a
      // denylist entry `"  AcmeCorp  "` (a spreadsheet paste) passed the floor on its trimmed
      // length and then entered BOTH the gate and the scrub pair with its padding, so the gate
      // substring-scanned for `"  acmecorp  "` — which occurs in no ordinary prose — while
      // `AcmeCorp` in a README was neither gated nor scrubbed. The publish reported ok:true with a
      // non-zero token count, so the operator saw a green run with the token nominally covered.
      // Found independently by BOTH reviewers of this change's own diff.
      if (tt) { gate.push(tt); scrub.push([tt, SCRUB_PLACEHOLDER.TENANT, { bounded: true, skipBase64: true }]); }
    }
  }

  // (2) operator identity from the roster.
  const rosterPath = path.join(repoDir, ".claude/operators.roster.json");
  // Same reader, same reasons as the denylist above (a FIFO roster hung the derive; a symlinked one
  // was parsed from out of tree — both measured).
  const rosterTxt = readRegularFileNoFollow(rosterPath, { label: "operators.roster.json", allowAbsent: true });
  if (rosterTxt !== null) {
    const txt = rosterTxt;
    // Same reason as the denylist parse above: the roster's bytes are identity values.
    const r = jsonParseOrThrow(txt, "operators.roster.json");
    // Genesis and trust-anchor SHAPE is checked BEFORE any harvest, for the same reason person
    // shape is: a malformed value is otherwise skipped by a `typeof === "string"` guard and its
    // identity silently leaves the gate. Messages are type/index-only.
    const gProblem = genesisShapeProblem(r && typeof r === "object" ? r.genesis : undefined);
    if (gProblem) {
      throw new Error(
        `operators.roster.json has a malformed genesis: ${gProblem} — refusing to proceed ` +
          `with a silently-partial identity gate.`,
      );
    }
    const aProblem = trustAnchorsShapeProblem(r);
    if (aProblem) {
      throw new Error(
        `operators.roster.json has a malformed trust anchor: ${aProblem} — refusing to proceed ` +
          `with a silently-partial identity gate. Its fingerprint and PGP UIDs cannot be harvested.`,
      );
    }
    // The CANONICAL roster shape is a map (person_id → record, schema:59), so the
    // person_id is the KEY, not a field. The pre-W2 derive iterated VALUES only,
    // never gating the map-key person_id — the same latent-gap class as the
    // principal omission below (canon's publish passed only because the org-slug
    // catch-all incidentally covered it). Iterate ENTRIES so the key is harvested.
    // BOTH collections, merged — see rosterPersonEntries.
    const entries = rosterPersonEntries(r);
    const fps = new Set();
    for (const [entryIndex, [pid, p]] of entries.entries()) {
      const pidTok = personIdToken(pid);
      if (pidTok) { gate.push(pidTok); scrub.push([pidTok, SCRUB_PLACEHOLDER.LOGIN]); }
      if (!p || typeof p !== "object") continue;
      // S61 CORRECTION (HIGH-1) — this path REFUSES LOUDLY; it does NOT skip.
      //
      // An earlier S61 revision applied the same skip-never-throw fence used at
      // the fold resolvers. That was WRONG HERE, and inverted the safe
      // direction. The general rule holds only where non-resolution is wired to
      // REFUSE; on this path non-resolution is wired to PERMIT.
      //
      // MEASURED: `deriveDynamicTokens` feeds the disclosure scrub + token gate,
      // and `scripts/publish-to-public.mjs` calls it inside a try whose catch
      // (:273) does `rmSync(stage); throw e;` — it RE-THROWS. So a throw ABORTS
      // THE PUBLISH: nothing is written, therefore nothing leaks. Fail-CLOSED.
      // Skipping instead lets the publish PROCEED with a token set missing this
      // person's `keys[].fingerprint` and every PGP UID in `keys[].pubkey` —
      // real identity shipped unscrubbed and ungated. The `fps.size === 0`
      // fallback below does NOT cover it (it fires only when NO fingerprint was
      // harvested, so a MIXED roster slips through) and cannot match SSH
      // `SHA256:` fingerprints at all.
      //
      // Throwing IS the protection on this path, and it is this module's own
      // established idiom: the unparseable-roster and unparseable-denylist arms
      // above both throw "refusing to proceed with a silently-disabled gate",
      // and `test-harness/tests/identity-scrub.test.mjs` pins BOTH as contract.
      const shapeProblem = personShapeProblem(p);
      if (shapeProblem) {
        // The message embeds NO identity token. This function GATES and SCRUBS
        // person_id, display_id, github_login and principal ALIKE (see the
        // harvest below), so echoing ANY of them is the one place this module
        // would emit what it exists to suppress — and a refusal message is
        // exactly the string most likely to be pasted into an issue.
        //
        // An earlier revision used `display_id` on the stated ground that it
        // "carries no authority". That reason is WITHDRAWN: it is true but
        // irrelevant. The axis that makes echoing unsafe is DISCLOSURE, and on
        // that axis this module treats display_id and person_id identically.
        //
        // The ORDINAL position in the merged persons/operators list (persons
        // first, then operators — rosterPersonEntries) is not an identity token at
        // all, and it is what someone editing the roster actually needs to find
        // the entry. It is also well-defined on the array-roster branch, where
        // the map key is null and `pid` would have rendered the literal 'null'.
        const locator = `entry #${entryIndex} (0-based) in the merged persons/operators list`;
        // `shapeProblem` is TYPE-ONLY by construction (personShapeProblem never echoes a value),
        // and for the non-array-keys case it keeps the historical wording
        // "has a person with a non-array keys field".
        throw new Error(
          `operators.roster.json has a person with a ${shapeProblem} ` +
            `(${locator}) — refusing to proceed ` +
            `with a silently-partial identity gate. Its identity fields, key fingerprints ` +
            `and PGP UIDs cannot all be harvested, so continuing would scrub and gate an ` +
            `INCOMPLETE token set.`,
        );
      }
      for (const k of (Array.isArray(p.keys) ? p.keys : [])) {
        // verified_id = GPG 40-hex OR SSH "SHA256:base64" (roster schema:120-123).
        // The fingerprint IS the authenticating identity regardless of algorithm;
        // harvest any non-trivial value, not just hex (HIGH-1: the prior
        // ^[0-9A-Fa-f]{16,}$ regex silently dropped every SSH verified_id).
        // Every written form (literal + compact hex) goes through `fps`, so each gets the same
        // scrub pair and gate treatment — see fingerprintForms.
        if (k) for (const f of fingerprintForms(k.fingerprint)) fps.add(f);
        // (3) NAME + EMAIL from each parsed pubkey's PGP UID packets.
        if (k && typeof k.pubkey === "string") harvestPubkeyIdentity(k.pubkey, gate, scrub);
      }
      // display_id/github_login/person_id are the GitHub-provider bindings;
      // `principal` is the azure-devops Entra UPN binding (roster schema:84) —
      // NEW in W2: the pre-W2 derive omitted it, so an ADO-provider owner's UPN
      // slipped both the publish gate AND (absent this) the ceremony gate.
      harvestPersonIdFields(p, gate, scrub);
    }
    // Trust anchors (roster schema `trust_anchors[]`, a top-level sibling of `persons`) carry a
    // signing key exactly like a person key: the fingerprint goes through `fps` (same scrub pair,
    // gate, SSH-prefix handling) and the pubkey's PGP UIDs through harvestPgpUid. Neither the
    // harvest nor the scanner read them before, so an anchor's identity was never gated.
    for (const a of rosterTrustAnchors(r)) {
      for (const f of fingerprintForms(a.fingerprint)) fps.add(f);
      if (typeof a.pubkey === "string") harvestPubkeyIdentity(a.pubkey, gate, scrub);
    }
    if (fps.size === 0) for (const h of (txt.match(/[0-9A-F]{40}/g) || [])) fps.add(h); // fallback only
    for (const h of fps) {
      scrub.push([h, synthHex(h)]);
      gate.push(h);
      // The truncated prose form a maintainer writes in a comment
      // (`SHA256:<prefix>…`) carries a 36-bit correlation handle to the same key;
      // it is scrubbed by prefix and gated by the same prefix (measured, docket
      // round 7: one such comment survived the exact-string pair).
      // Prefix matched case-INSENSITIVELY: a roster value written `sha256:<body>` is the same key
      // and previously got no truncated form. The pushed gate token and scrub replacement keep
      // the canonical `SHA256:` spelling; the `gi` scrub regex below already covers any case.
      const ssh = h.match(/^SHA256:([A-Za-z0-9+/=]{6,})$/i);
      if (ssh) {
        const pre = ssh[1].slice(0, 6);
        // `gi`, not `g`: the GATE pushes the 13-char `SHA256:<pre>` string below and matches it
        // case-INSENSITIVELY, so a `g`-only scrub pair reproduced this file's own defect one level
        // down — a case variant of the truncated prose form was DETECTED and never NEUTRALIZED.
        // Measured at the time of the fix: no such variant exists in the corpus (delta 0 on every
        // surface), so this closes a LATENT gap rather than a live leak. The `[A-Za-z0-9+/=]` class
        // is already case-covering; `i` only widens the literal `SHA256:` prefix and `<pre>`.
        scrub.push([new RegExp("SHA256:" + pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[A-Za-z0-9+/=]*(?:…|\\.\\.\\.)?", "gi"), "SHA256:" + synthHex(h).slice(0, 8) + "…"]);
        gate.push("SHA256:" + pre);
      }
    }

    // (4) genesis trust-root identity — the brief's "genesis trust-root + owner
    // identity" axes (CRIT-1: the pre-fix derive harvested NEITHER, so the canon
    // owner login AND the trust-root root_commit SHA escaped both fences — the
    // publish fence only caught the owner via the hand-maintained EXTRA_IDENTITY
    // static list, and root_commit had NO coverage on either path). EXCLUDE the
    // placeholder sentinels (PLACEHOLDER- owner / all-zero root_commit) so a
    // re-derive over a cleared tree harvests nothing.
    const g = (r && r.genesis) || {};
    // CONVENTION: angle-bracket scrub replacements ("<...>") are RESERVED for neutralize
    // sentinels — makeScrubber's SUBSTITUTE mode lets a static substitute supersede a dynamic
    // pair ONLY when its value is angle-wrapped (isNeutralizeSentinel). A future dynamic pair
    // MUST NOT adopt angle-bracket form for a real (non-superseding) substitution target.
    for (const [val, repl] of [[g.repo_owner, SCRUB_PLACEHOLDER.CANON_OWNER], [g.ado_project, SCRUB_PLACEHOLDER.ADO_PROJECT]]) {
      // Trimmed BEFORE the floor and pushed trimmed, as person ids are (`personIdToken`): a
      // padded value would otherwise gate and scrub only text carrying the same padding.
      const v = typeof val === "string" ? val.trim() : "";
      if (v.length > 2 && !v.startsWith("PLACEHOLDER-")) { gate.push(v); scrub.push([v, repl]); }
    }
    // `{7,64}` MIRRORS the roster schema (`operators.roster.schema.json::genesis.root_commit`,
    // `pattern: "^[0-9a-f]{7,64}$"`), so a 7-char abbreviated anchor is a SCHEMA-VALID config and
    // reaches here without any malformed input. The floor stays at 7 DELIBERATELY: `gate.push`
    // and `scrub.push` are the same statement, so raising it to 12 would drop a schema-valid
    // 7..11-char anchor from the GATE as well as the scrub — fail-OPEN on the disclosure axis
    // this fence exists to hold, which is strictly worse than the corruption below.
    //
    // `{bounded:true}` is what fixes that corruption. A plain-string pair is applied with
    // `tokenUnboundedRe` — `new RegExp(escape(from),"gi")`, an UNBOUNDED case-INSENSITIVE
    // substring matcher — so the anchor was rewritten wherever it occurred, including STRICTLY
    // INSIDE an unrelated 40-hex SHA, digest, or UUID. That is CONTENT CORRUPTION of published
    // output, not a leak. MEASURED before landing: with `abc1234` configured,
    // `5f3abc1234e0e1e2e3e4e5e6e7e8e9eaebecedeeef` became `5f3deadbeee0e…`.
    //
    // A LENGTH FLOOR does NOT close this class, which is why one is not used: a 12-char anchor
    // embedded in a 40-hex SHA still corrupts (measured identically), so `{12,64}` would only
    // lower the collision PROBABILITY while paying the gate cost above. Boundedness closes it
    // structurally at EVERY length, because a hex neighbour is alphanumeric and so fails
    // `tokenBoundedRe`'s `(?<![A-Za-z0-9])…(?![A-Za-z0-9])`.
    //
    // `{bounded:true}` USED TO buy a SECOND narrowing — the opaque-base64 skip — because the call
    // site keyed the skipper on `bounded`. That conflation was the defect, and it is FIXED as of
    // 2026-09-08: the skipper now keys on its own `skipBase64` flag. `root_commit` carries
    // `{bounded:true}` ALONE, so it gets the SHA-corruption protection it needed and keeps full
    // base64-interior scrub coverage. The tenant-denylist pairs carry `{bounded:true,
    // skipBase64:true}` and are byte-unchanged. Pinned bipolar in `identity-scrub.test.mjs` § M8:
    // re-conflating the flags reds one pole, dropping the tenant skip reds the other.
    //
    // Narrowing the SCRUBBER is FAIL-SAFE **only on a lane whose GATE is an unbounded literal-
    // token scan.** WHICH LANES THOSE ARE is a query result, and it is therefore no longer
    // written here. The block below is GENERATED by `.claude/bin/census-build.mjs` from the
    // corpus and refuses to go stale (`--check` exits 1). This is not tidiness: the hand-written
    // census it replaces was WRONG TWICE — once naming four consumers under one floor where
    // there were three consumers under three DIFFERENT floors plus a dead-code entry, and once
    // written in the present tense while the SAME commit deleted two of the floors it named.
    // Both were caught only by adversarial review, and both were mechanically derivable. Read
    // the block for WHO consumes this function; read the prose around it for what that MEANS,
    // which no query answers.
    //
    // CENSUS:BEGIN CONSUMER-CENSUS — generated by .claude/bin/census-build.mjs — DO NOT EDIT BY HAND
    // Regenerate: node .claude/bin/census-build.mjs --write   ·   Verify: --check (exit 1 = STALE)
    //
    // SUBJECT `deriveDynamicTokens`, returning { scrub, gate, unhonoured } — the keys are READ OUT of the producer's own return statement, not typed.
    // INPUT SET — DISCOVERED, never declared: `git grep -l --untracked -F deriveDynamicTokens -- *.mjs *.js`
    // matched 23 file(s) carrying 76 call site(s). The manifest declares the SYMBOL,
    // the GLOBS and the TARGET; the FILES, the CALL SITES and every column below are found.
    //
    // RUNTIME CONSUMERS (7):
    //   .claude/bin/clean-instantiate.mjs:694 ::snapshotCanonTokens
    //       reads: gate (destructured)
    //       length compares in fn: none
    //       callers of snapshotCanonTokens: 0 — DEAD CODE on this tree
    //   .claude/bin/clean-instantiate.mjs:704 ::snapshotCanonIdentity
    //       reads: gate, scrub, unhonoured (destructured)
    //       length compares in fn: none
    //       callers of snapshotCanonIdentity: 1 (.claude/bin/clean-instantiate.mjs:1523)
    //   .claude/bin/edition-emit.mjs:791 ::makeClientTemplateScrubber
    //       reads: scrub (destructured)
    //       length compares in fn: none
    //       callers of makeClientTemplateScrubber: 7 (.claude/bin/edition-emit.mjs:1279, .claude/bin/edition-emit.mjs:1280, .claude/bin/edition-emit.mjs:2256, .claude/bin/fork-conference-pack.mjs:11974, …)
    //   .claude/bin/lib/edition-output-gate.mjs:500 ::assertDisclosureCleanNeutralize
    //       reads: gate (destructured)
    //       length compares in fn: hits.length >= CAP
    //       callers of assertDisclosureCleanNeutralize: 11 (.claude/bin/lib/edition-output-gate.mjs:695, .claude/test-harness/tests/disclosure-adjudication.test.mjs:322, .claude/test-harness/tests/disclosure-adjudication.test.mjs:348, .claude/test-harness/tests/disclosure-adjudication.test.mjs:417, …)
    //   `.claude/bin/scan-synced-disclosure.mjs::loadOperatorIdentityShape`
    //       reads: filter, some (bound to `gate`)
    //       length compares in fn: t.length >= 3 · raw.length === 0 · tokens.length === 0
    //       load site: `.claude/bin/scan-synced-disclosure.mjs::operatorShape`
    //   scripts/publish-to-public.mjs:191 ::makeScrubber
    //       reads: scrub (destructured)
    //       length compares in fn: none
    //       callers of makeScrubber: UNDETERMINED — the name is declared 2× in this corpus (.claude/bin/lib/identity-scrub.mjs:1705, scripts/publish-to-public.mjs:190), so a name search cannot attribute a call to THIS one
    //   scripts/publish-to-public.mjs:392 ::runIdentityTokenGate
    //       reads: gate, unhonoured (destructured)
    //       length compares in fn: t.length < TENANT_TOKEN_MIN_LEN · t.length >= TENANT_TOKEN_MIN_LEN · hits.length === 0
    //       callers of runIdentityTokenGate: 10 (.claude/bin/edition-emit.mjs:1370, .claude/bin/edition-emit.mjs:1952, .claude/bin/edition-emit.mjs:2091, .claude/test-harness/tests/disclosure-adjudication.test.mjs:333, …)
    //
    // NON-RUNTIME CALL SITES (69 across 7 file(s)) — a DERIVED predicate:
    // under a test-harness/ or audit-fixtures/ directory, or a basename ending .test.mjs/.test.js.
    //   .claude/audit-fixtures/consumer-census/run.mjs — 5 (5 UNDETERMINED)
    //   .claude/test-harness/tests/clean-instantiate.test.mjs — 1
    //   .claude/test-harness/tests/disclosure-adjudication.test.mjs — 1
    //   .claude/test-harness/tests/edition-emit.test.mjs — 2
    //   .claude/test-harness/tests/identity-scrub.test.mjs — 56
    //   .claude/test-harness/tests/publish-to-private-template.test.mjs — 1
    //   .claude/test-harness/tests/roster-keys-shape-fence.test.mjs — 3
    //
    // UNDETERMINED OCCURRENCES (5) — reported, never dropped and never guessed:
    //   .claude/audit-fixtures/consumer-census/run.mjs:75 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:92 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:105 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:285 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //   .claude/audit-fixtures/consumer-census/run.mjs:422 — two independent classifiers disagree on whether this occurrence is code (mask=prose, line-shape=code)
    //
    // WHAT THIS INSTRUMENT CANNOT SEE — name it, do not read silence as absence:
    //   · a length compare is reported wherever it sits in the enclosing function; this tool does
    //     NOT decide whether it constrains the token set. Read the hit, not the column.
    //   · a caller reached other than by a literal `NAME(` in code — a dynamic dispatch, a
    //     re-export under another name, a consumer outside this repo — counts as 0 here.
    //   · a consumer in a file the globs do not match (*.mjs, *.js).
    //   · a call site inside census-build.mjs itself — the instrument excludes itself from the
    //     population it measures, so it cannot report on its own use of the symbol.
    //   · INDIRECT reach: a file that imports a consumer inherits that lane's behaviour and is
    //     not a call site, so it does not appear as a row.
    //
    // input_digest: 7da07ed206a9ece9
    // generated_from_sha: 18019baa9b3744f2dc873abdb74e696868ce2e4a
    // CENSUS:END CONSUMER-CENSUS
    //
    // The block does NOT answer the question this paragraph asks of every row in it: is that
    // lane's gate an unbounded literal-token scan? That is a judgment about a DIFFERENT file and
    // a comment here cannot vouch for it. What the block does settle is which lanes there are to
    // ask about, and whether one of them is reached by nobody at all.
    //
    // A floor is a property of the TOKEN SET, not of a fence — which is why the one floor,
    // `TENANT_TOKEN_MIN_LEN`, is applied ONCE at derive time above rather than reinvented per
    // consumer, and why a `length compares in fn` row in the block is evidence about that
    // function, never by itself a claim that the comparison constrains the token set.
    //
    // On every consumer an anchor embedded in-word still HALTS the publish rather than shipping —
    // consumers no longer each invent an answer. On all of them an anchor embedded in-word still
    // HALTS the publish rather than shipping — the deliberate gate/scrubber asymmetry the tenant
    // denylist pairs rely on, recorded from the gate's side in `edition-output-gate.mjs` LAYER 3.
    // Do not make the two agree.
    //
    // **That premise is NOT universal, and stating it unqualified was the defect.** A lane that
    // applies this NEUTRALIZE scrubber but gates with the SHAPE scanner alone
    // (`scan-synced-disclosure.mjs`) has NO unbounded literal-token fence: the scanner holds
    // zero secret tokens by design, so it carries no genesis-anchor shape in ANY position.
    // MEASURED: a planted file carrying the anchor both standalone AND base64-embedded produced
    // ZERO findings on the same invocation where an operator-home-path control fired.
    // `fork-conference-pack.mjs` IS such a lane. Do NOT read this paragraph as saying it is fixed:
    // whether it carries an unbounded literal-token gate is a claim about a DIFFERENT file, and a
    // comment here cannot vouch for it. Re-derive it — grep that file for `runIdentityTokenGate`
    // and read the hit in context — rather than trusting this line. What THIS commit changed is
    // narrower and is the whole of what it claims: the identity anchor no longer carries the
    // base64 skip, so the position that lane was most exposed on is scrubbed rather than shipped.
    // The in-word position is NOT closed by the scrubber and is not meant to be.
    // Before bounding a NEW pair, enumerate the lanes that apply the scrubber and confirm each
    // one's gate is unbounded — do not infer it from this file.
    // TRIMMED before the regex and pushed trimmed: a padded root was previously dropped outright
    // (the anchored regex failed on the padding), leaving the trust-root SHA ungated.
    const rc = typeof g.root_commit === "string" ? g.root_commit.trim() : "";
    if (/^[0-9a-fA-F]{7,64}$/.test(rc) && !/^0+$/.test(rc)) {
      gate.push(rc); scrub.push([rc, synthHex(rc), { bounded: true }]);
    }
  }
  // (5) PRIVATE REPOSITORY NAMES — every repository `repoDir/.gitmodules` declares under a
  // private owner (`privateRepoNames`; it refuses loudly on a section it cannot classify, and
  // is empty without reading when the private org set is empty, so a consumer is unaffected).
  // Read from `repoDir`, like the roster and the denylist above, so every consumer that
  // derives from the source checkout — the publish scrub + gate, the client-template
  // scrubber, the edition output gate, clean-instantiate and the scanner's operator shape —
  // inherits the token with no wiring of its own.
  //
  // UNBOUNDED matcher. A repository name glued into a longer token (`<name>2`,
  // `<name>_backend`, `org/<name>.git`) still names the repository; a word-bounded scrub
  // would leave that disclosure standing in the output for the gate to halt on, rather than
  // neutralizing it.
  //
  // WITH the base64 skip, which is a separate narrowing (see `isInsideOpaqueBase64Run`). A
  // hyphenated name never sits strictly inside a standard-alphabet run (the hyphen breaks
  // it), so for that shape the skip is inert; it exists for a hyphen-less ≥4-char name,
  // which CAN collide inside an opaque payload by chance, where rewriting would corrupt the
  // payload. The skip is fail-safe ONLY because every lane applying this scrubber gates
  // with an UNBOUNDED, skip-free literal scan of these names, so a declined match HALTS
  // rather than ships: `publish-to-public.mjs::runIdentityTokenGate` and
  // `edition-output-gate.mjs::assertDisclosureCleanNeutralize` read `gate` below;
  // `strip-build-internal.mjs::assertTreeFreeOfPrivateIdentity` (run on every final output
  // tree) reads `privateRepoNames` directly; and the shape-scanner-gated lane recorded in
  // § 4 is covered by the scanner's own `private-repo-name-token` shape, which matches
  // unbounded with no skip.
  for (const n of privateRepoNames(repoDir, { slugs: privateSlugs })) {
    gate.push(n);
    scrub.push([n, SCRUB_PLACEHOLDER.PRIVATE_REPO, { skipBase64: true }]);
  }
  // A cross-repo authorization receipt FILENAME is a loom process token: it names the
  // sibling repo (or its purpose) and the date the read was granted. The date and
  // mode survive; the target slug is replaced (measured: one shipped verbatim in a
  // hook comment while every docket page had already fenced the class).
  // `gi` for parity with every other pair in this function: a receipt filename written in any other
  // case is the same loom process token. The replacement is emitted in canonical lower case, and
  // `mode` is lower-cased so an `-READ.md` receipt does not round-trip its casing into the output.
  scrub.push([/\bcross-repo-authorized-(\d{4}-\d{2}-\d{2})-[A-Za-z0-9._-]*?-?(read|write)?\.md\b/gi, (_m, d, mode) => `cross-repo-authorized-${d}-<target>${mode ? "-" + String(mode).toLowerCase() : ""}.md`]);
  // (6) THE OPERATOR'S REDACTION MAP — a THIRD token source beside the repo's own declarations
  // (denylist + roster) and the canonical identity declaration. It lives OUTSIDE every work tree
  // (`loadRedactionMap` refuses otherwise), so it carries the values a repo can never declare
  // about itself: the operator's login, host names, home path, account ids. Every fence that
  // derives here — publish, client-template, edition gate, clean-instantiate — inherits it with
  // no wiring of its own. The gate gets the VALUE; the scrub pair writes the map's TOKEN, which
  // `isNeutralizeSentinel` treats as a neutralizer so a static public substitute still wins.
  // A refused map (in-repo path, mode looser than 0600, malformed) THROWS: the fences re-throw,
  // so a map the operator configured but this function cannot trust aborts rather than being
  // silently ignored. Every map pair is WORD-BOUNDED (`redactText` semantics): a value is never cut
  // out of a longer word, so prose is never altered (C1 R1 correctness 8).
  // A map path that was named EXPLICITLY (the `redactionMap` argument) and is
  // absent THROWS: a fence told to use a map must not run as though it had none (C1 R1 H4). Only
  // the DEFAULT location may be absent, which is the state of CI and of a machine with no map.
  //
  // EVERY map value is gated; HOW it is matched depends on its shape (C1 R2 F1). The `gate`
  // consumers match UNBOUNDED substrings. A value under 4 chars, or one made only of hex digits,
  // decimal digits and hyphens (an 8-hex session prefix, a UUID tenant id, a numeric account id),
  // would halt on every digest or number that happens to contain it — a fail-closed denial of
  // service with nothing disclosed (C1 R1 M6). The R1 fix dropped such values from the gate
  // ENTIRELY, so a UUID tenant id or a numeric account id shipped through every fence unflagged.
  // They now go to `gateBounded`, matched word-bounded: a standalone occurrence halts, and an
  // in-word occurrence inside a longer hex or digit run — which is not that value — does not.
  //
  // `redactionMapCounts` — the loaded map's per-category entry counts (`redactionMapCounts`), or
  // null when the map was disabled (`redactionMap: false`). Carried out so every fence that derives
  // here can PRINT them (`redactionMapCoverageLine`): an absent default map is legitimate (CI, a
  // consumer), but it must be visible, never indistinguishable from a covered run.
  let mapCounts = null, redactionAuthority = null;
  if (redactionMap !== false) {
    const { path: mp, explicit } = redactionMap === undefined ? resolveRedactionMapPath() : { path: redactionMap, explicit: true };
    const map = loadRedactionMap(mp, { explicit });
    mapCounts = redactionMapCounts(map);
    redactionAuthority = map.authority;
    const g = redactionMapGateTokens(map);
    unhonoured.push(...g.unhonoured);
    gate.push(...g.gate);
    gateBounded.push(...g.gateBounded);
    for (const e of map.entries) if (e.value.length >= TENANT_TOKEN_MIN_LEN) scrub.push([e.value, e.token, { bounded: true }]);
  }
  return { scrub, gate, gateBounded, unhonoured, redactionMapCounts: mapCounts, redactionAuthority };
}

/**
 * The per-person identity fields the roster harvest reads. ONE list, used by
 * `deriveDynamicTokens` and `personIdentityTokens` alike, so the two cannot drift.
 */
export const PERSON_ID_FIELDS = Object.freeze(["display_id", "github_login", "person_id", "principal"]);

/** Type name for a JSON value, distinguishing null and array. Never the value itself. */
function jsonTypeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * JSON.parse that refuses WITHOUT echoing input. V8's syntax-error message quotes an excerpt of
 * the input (`Unexpected token 'q', ..."tok": qzsecret}" is not valid JSON`), and the files this
 * module parses hold exactly the identity and tenant values it exists to withhold — a reviewer
 * measured a denylist token printed on stderr through the old `${e.message}` interpolation. The
 * refusal carries only the label and, when V8 reports one, the numeric position (and the line
 * computed from it); otherwise `position unknown`. Keeps `present but unparseable` so existing
 * assertions match.
 *
 * @param {string} text
 * @param {string} label  file label for the message
 * @returns {unknown}
 */
export function jsonParseOrThrow(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = /\bposition (\d+)/.exec(String(e && e.message));
    let where = "position unknown";
    if (m) {
      const pos = Number(m[1]);
      const line = String(text).slice(0, pos).split("\n").length;
      where = `position ${pos}, line ${line}`;
    }
    throw new Error(
      `${label} present but unparseable (JSON syntax error at ${where}) — refusing to proceed ` +
        `with a silently-disabled gate.`,
    );
  }
}

/**
 * Shape problem of the roster's `genesis` block, or null. TYPE/LENGTH-only text, never a value.
 * undefined/null `g` is not a problem (a roster may carry no genesis). A problem is: `g` not a
 * plain object; `repo_owner` or `ado_project` present, non-null and not a string; `root_commit`
 * present, non-null and either not a string or, after trim, not 7–64 hex characters (the schema's
 * `^[0-9a-f]{7,64}$`, case-widened as the harvest is). Without this, each of those was skipped by
 * the harvest's `typeof === "string"` / regex guard and the trust-root identity left the gate.
 *
 * @param {unknown} g
 * @returns {string|null}
 */
export function genesisShapeProblem(g) {
  if (g === undefined || g === null) return null;
  if (jsonTypeOf(g) !== "object") return `genesis is ${jsonTypeOf(g)}, not an object`;
  for (const f of ["repo_owner", "ado_project"]) {
    const v = g[f];
    if (v !== undefined && v !== null && typeof v !== "string") return `non-string genesis.${f}, got ${jsonTypeOf(v)}`;
  }
  const rc = g.root_commit;
  if (rc !== undefined && rc !== null) {
    if (typeof rc !== "string") return `non-string genesis.root_commit, got ${jsonTypeOf(rc)}`;
    if (!/^[0-9a-fA-F]{7,64}$/.test(rc.trim())) return `genesis.root_commit is not 7-64 hex characters after trim (length ${rc.trim().length})`;
  }
  return null;
}

/**
 * Shape problem of ONE signing-key record (a person's `keys[i]` or a `trust_anchors[i]`), or
 * null. `where` locates it by INDEX only. A problem is: not a plain object; `fingerprint` present,
 * non-null and not a string or shorter than 16 after trim; `pubkey` present, non-null and not a
 * string (an array-of-lines armor was dropped silently by harvestPgpUid, so its UID never gated).
 */
function keyEntryShapeProblem(k, where) {
  if (jsonTypeOf(k) !== "object") return `non-object ${where} entry, got ${jsonTypeOf(k)}`;
  const fp = k.fingerprint;
  if (fp !== undefined && fp !== null) {
    if (typeof fp !== "string") return `non-string ${where}.fingerprint, got ${jsonTypeOf(fp)}`;
    if (fp.trim().length < 16) return `${where}.fingerprint shorter than 16 characters, got length ${fp.trim().length}`;
  }
  const pk = k.pubkey;
  if (pk !== undefined && pk !== null && typeof pk !== "string") return `non-string ${where}.pubkey, got ${jsonTypeOf(pk)}`;
  return null;
}

/** The roster's `trust_anchors[]` entries that are plain objects (shape is validated separately). */
function rosterTrustAnchors(r) {
  if (jsonTypeOf(r) !== "object" || !Array.isArray(r.trust_anchors)) return [];
  return r.trust_anchors.filter((a) => jsonTypeOf(a) === "object");
}

/**
 * Shape problem of the roster's top-level `trust_anchors` (schema: an array of objects with
 * `fingerprint` + `pubkey`), or null. Absent/null is fine (optional, pre-#583 rosters). Located by
 * index only.
 */
function trustAnchorsShapeProblem(r) {
  if (jsonTypeOf(r) !== "object") return null;
  const ta = r.trust_anchors;
  if (ta === undefined || ta === null) return null;
  if (!Array.isArray(ta)) return `non-array trust_anchors field, got ${jsonTypeOf(ta)}`;
  for (let i = 0; i < ta.length; i++) {
    const p = keyEntryShapeProblem(ta[i], `trust_anchors[${i}]`);
    if (p) return p;
  }
  return null;
}

/**
 * The gate tokens the roster's trust anchors yield, by exactly the rules deriveDynamicTokens
 * applies: each anchor fingerprint's forms (fingerprintForms) and its pubkey's PGP UID
 * names/emails (with separator variants). Like personIdentityTokens it returns the direct tokens
 * only — not the derived `SHA256:<prefix>` truncation, which deriveDynamicTokens adds for every
 * fingerprint. Malformed entries are skipped here; deriveDynamicTokens is where they are refused.
 * Exists so a caller (the scanner) can count anchor tokens as roster-derived.
 *
 * @param {unknown} r  the parsed roster
 * @returns {string[]}
 */
export function trustAnchorTokens(r) {
  const gate = [];
  const scrub = [];
  for (const a of rosterTrustAnchors(r)) {
    for (const f of fingerprintForms(a.fingerprint)) gate.push(f);
    if (typeof a.pubkey === "string") harvestPubkeyIdentity(a.pubkey, gate, scrub);
  }
  return gate;
}

/**
 * Validate a parsed tenant denylist and return its TRIMMED string tokens. Well-formed means: a
 * non-array object whose `tokens` is an array in which EVERY entry is a string that is non-empty
 * after trim. `{"tokens":[]}` is well-formed and returns [].
 *
 * Anything else THROWS. The former `.tokens || []` read a string `tokens` as its characters
 * (each dropped by the length floor), and `{}`, `[]`, a mis-cased `Tokens` key or a non-string
 * entry as an empty gate, so a malformed denylist silently disabled the tenant gate. The message
 * names what was found by TYPE or COUNT only — never a value, because the values are the tenant
 * names this file exists to withhold, and a refusal message is the string most likely to be pasted
 * into an issue. Sub-floor handling stays with the caller (deriveDynamicTokens' `unhonoured`).
 *
 * @param {unknown} parsed  the JSON.parse result
 * @param {string} label    file label for the message (should contain the file name)
 * @returns {string[]}
 */
export function denylistTokensOrThrow(parsed, label = "disclosure-tenant-denylist.json") {
  const refuse = (found) => {
    throw new Error(
      `${label} has the wrong shape: ${found}. Expected an object with a "tokens" array of ` +
        `non-empty strings (disclosure-tenant-denylist.json) — refusing to proceed with a ` +
        `silently-disabled tenant gate.`,
    );
  };
  if (jsonTypeOf(parsed) !== "object") refuse(`top level is ${jsonTypeOf(parsed)}, not an object`);
  if (!Array.isArray(parsed.tokens)) refuse(`"tokens" is ${parsed.tokens === undefined ? "missing" : jsonTypeOf(parsed.tokens)}, not an array`);
  // A LONE surrogate can never match text (no well-formed UTF-16 string contains one), so such a
  // token protects nothing while looking installed. Refused like any other unusable entry.
  // A line break INSIDE the (trimmed) token is refused too: every scan here is line-split, so a
  // multi-line token can never match. Leading/trailing breaks are removed by the trim and are fine.
  const bad = parsed.tokens.filter((t) => typeof t !== "string" || t.trim() === "" || LONE_SURROGATE_RE.test(t) || /[\r\n]/.test(t.trim()));
  if (bad.length) {
    const kind = (t) => (typeof t !== "string" ? jsonTypeOf(t)
      : t.trim() === "" ? "blank string"
        : LONE_SURROGATE_RE.test(t) ? "string with a lone surrogate"
          : "string with a line break");
    const types = [...new Set(bad.map(kind))].join(", ");
    refuse(`${bad.length} of ${parsed.tokens.length} "tokens" entries are not non-empty strings (found: ${types})`);
  }
  return parsed.tokens.map((t) => t.trim());
}

/**
 * The shape problem of ONE roster person record, or null when it is harvestable. TYPE-ONLY text,
 * never a value (the caller embeds it in a refusal). A problem is:
 *   - a PERSON_ID_FIELDS key present, non-null and not a string (e.g. an array `principal`),
 *     which the harvest would otherwise skip — silently dropping that identity;
 *   - `keys` present, non-null and not an array;
 *   - a `keys[]` entry that is not a plain object;
 *   - a key's `fingerprint` present, non-null and not a string, or shorter than 16 after trim;
 *   - a key's `pubkey` present, non-null and not a string (see keyEntryShapeProblem).
 * A null / non-object `p` is NOT a problem: a pid-only entry is legitimate.
 *
 * @param {unknown} p
 * @returns {string|null}
 */
export function personShapeProblem(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  for (const f of PERSON_ID_FIELDS) {
    const v = p[f];
    if (v !== undefined && v !== null && typeof v !== "string") return `non-string ${f} field, got ${jsonTypeOf(v)}`;
  }
  if (p.keys === undefined || p.keys === null) return null;
  if (!Array.isArray(p.keys)) return `non-array keys field, got ${jsonTypeOf(p.keys)}`;
  for (let i = 0; i < p.keys.length; i++) {
    const prob = keyEntryShapeProblem(p.keys[i], `keys[${i}]`);
    if (prob) return prob;
  }
  return null;
}

/**
 * Every `[pid|null, person]` entry a parsed roster carries, from `persons` FIRST and then
 * `operators`, MERGED. The previous `r.persons || r.operators` read only ONE collection, so a
 * roster carrying both silently dropped every `operators` person: none of their tokens were
 * gated or scrubbed (measured: rc=0 with an operators-only person planted).
 *
 * Per collection: an array maps each element to `[null, x]`; any other non-null object maps
 * via `Object.entries` (the canonical map form, pid → record); null/undefined is skipped. Any
 * other type (string, number, boolean) is SKIPPED without throwing — type validation, and the
 * refusal that goes with it, belongs to the caller (the scanner refuses with its own message),
 * so this helper does not duplicate it. A non-object `r` yields `[]`.
 *
 * @param {unknown} r  the parsed roster
 * @returns {Array<[string|null, unknown]>}
 */
export function rosterPersonEntries(r) {
  if (!r || typeof r !== "object") return [];
  const out = [];
  for (const coll of [r.persons, r.operators]) {
    if (coll === null || coll === undefined || typeof coll !== "object") continue;
    if (Array.isArray(coll)) for (const x of coll) out.push([null, x]);
    else for (const e of Object.entries(coll)) out.push(e);
  }
  return out;
}

/**
 * The identity tokens ONE roster person entry yields, using exactly the rules
 * `deriveDynamicTokens` applies to it: the map-key person id and each PERSON_ID_FIELDS value
 * (trimmed, then length > 2 — personIdToken), each key fingerprint (>= 16, literal plus its
 * compact hex form — fingerprintForms), and the PGP UID names/emails (with their
 * separator variants). Genesis values are NOT included — they belong to the repo, not to
 * the person.
 *
 * Exists so a caller can ask "does EVERY person yield an identity?" rather than "does the
 * roster as a whole yield anything?". The whole-set question is answered yes by the genesis
 * owner and root commit alone, which let a person with no harvestable field (an
 * array-form entry keyed only by an unknown field) pass as covered while the scanner could
 * never match them (measured: `{"persons":[{"nick":"carolxyz"}]}` plus a planted
 * `carolxyz wrote this` gave rc=0, 0 findings).
 *
 * @param {string|null} pid  the map key (null for an array-form entry)
 * @param {object} p         the person record
 * @returns {string[]}
 */
export function personIdentityTokens(pid, p) {
  const gate = [];
  const scrub = [];
  const pidTok = personIdToken(pid);
  if (pidTok) gate.push(pidTok);
  if (!p || typeof p !== "object") return gate;
  for (const k of Array.isArray(p.keys) ? p.keys : []) {
    if (k) for (const f of fingerprintForms(k.fingerprint)) gate.push(f);
    if (k && typeof k.pubkey === "string") harvestPubkeyIdentity(k.pubkey, gate, scrub);
  }
  harvestPersonIdFields(p, gate, scrub);
  return gate;
}

/**
 * Push every PERSON_ID_FIELDS token of person `p` (trimmed, floored — personIdToken) and, for the
 * ADO `principal`, its local-part and tenant (harvestPrincipalParts). ONE helper, used by
 * `deriveDynamicTokens` and `personIdentityTokens` alike, so the publish gate, the ceremony and
 * the scanner cannot drift on what a principal yields.
 */
function harvestPersonIdFields(p, gate, scrub) {
  for (const k of PERSON_ID_FIELDS) {
    const tok = personIdToken(p[k]);
    if (!tok) continue;
    gate.push(tok); scrub.push([tok, SCRUB_PLACEHOLDER.LOGIN]);
    if (k === "principal") harvestPrincipalParts(tok, gate, scrub);
  }
}

/**
 * The token a person-id value (the map-key pid or a PERSON_ID_FIELDS value) contributes, or
 * null. TRIM FIRST, then floor, then return the TRIMMED value — the same discipline the
 * tenant-denylist arm applies to `tt`. Flooring the raw value let `"   "` count as an identity
 * (the scanner's "person yields ZERO identity tokens" refusal was bypassed, then the scanner
 * trimmed it to "" and dropped it: measured rc=0, 0 findings) and let `" ab"` clear a floor its
 * content fails; pushing the raw value installed `"  bob  "` as a gate/scrub token that never
 * matches the unpadded name in prose. ONE helper, used by `deriveDynamicTokens` and
 * `personIdentityTokens` alike, so the two cannot drift.
 */
function personIdToken(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 2 ? t : null;
}

/**
 * Every form of a roster key fingerprint to harvest. The trimmed LITERAL (>= 16), plus — when it
 * differs and is all-hex of length >= 16 — the COMPACT form: whitespace removed, then a leading
 * `0x`/`0X` removed. A fingerprint written as `gpg --fingerprint` prints it (`0F1E 2D3C …`) or
 * with a `0x` prefix otherwise never yields the compact 40-hex citation, so neither that string
 * nor the prefix/key-ID forms consumers derive from a 40-hex token were ever matched. SSH
 * `SHA256:<base64>` values contain no whitespace and are not hex, so they yield the literal only.
 */
function fingerprintForms(fp) {
  if (typeof fp !== "string") return [];
  const lit = fp.trim();
  if (lit.length < 16) return [];
  const out = [lit];
  const compact = lit.replace(/\s+/g, "").replace(/^0x/i, "");
  if (compact !== lit && /^[0-9A-Fa-f]{16,}$/.test(compact)) out.push(compact);
  return out;
}


// ── § REDACTION MAP ──────────────────────────────────────────────────────────────────────
//
// The operator's redaction map: `{ entries: [{ token, cat, value }] }` at
// Account map: .claude/hooks/lib/redaction-map-binding.js::resolveRedactionMapPath; explicit paths are for draft APIs.
// It records values NO repository can declare about itself — the operator's login, host names,
// home path, account and tenant ids — and assigns each a stable token `@@CAT-NNN@@`.
//
// THIS MODULE STAYS IDENTITY-FREE. The map is read at RUNTIME from OUTSIDE every work tree, the
// same way the roster and denylist are read from the repo; no value is ever written into this
// file, and `.claude/bin/redact.test.mjs` asserts that for a seeded canary map.
//
// Categories: OP HOST PATH ACCT ORG TEN are declared by the operator (`redact add --stdin`); SID
// EMAIL IP are FAMILIES — detected by pattern (with allowlists for benign shapes) and enrolled by
// `redact apply`.
//
// MATCHING. Case-insensitive, longest value first, and ALWAYS WORD-BOUNDED (`tokenBoundedRe`:
// letters and digits are the only word characters). A value is never cut out of a longer word,
// so prose is never altered, while a value inside a path segment, a dash-encoded directory name
// or a `_`-joined slug is still caught. Tokens already in the text — written by an earlier apply,
// or quoted on purpose — are PROTECTED from re-matching, so apply is idempotent.
//
// RESTORE IS EXACT AND RECORD-KEYED. `apply` writes a per-run record beside the map (mode 0600,
// outside every work tree) holding, per file, the pre/post sha256 and the ORIGINAL spelling behind
// every token it wrote. Restore rewrites only a file whose bytes still equal the recorded post-apply
// bytes, puts back exactly the recorded spellings (case, BOM and line endings preserved), and
// verifies the result against the recorded pre-apply sha256. Token-shaped text the record does not
// own — a test's literal token, a token planted in inbound content — is never expanded.
//
// NO MAP IS NOT A CLEAN MAP. OP HOST PATH ACCT ORG TEN are detectable ONLY through map entries.
// With no map, or one holding no entries in those six, `redact.mjs` scan / check refuse (exit 2,
// the existing refusal class) instead of printing 0 for them, and `apply` refuses rather than
// creating a map as a side effect; `--allow-no-map` is the explicit, logged opt-out (families only,
// and never lets apply create a map). Every fence prints `redactionMapCoverageLine` — counts only.
//
// DOCUMENTED LIMITS — what a `check` of 0 does NOT establish:
//   · ENCODED forms of a value are not decoded: URL/percent-encoding, JSON `\uXXXX` and `\/`
//     escapes, base64, and a value split across lines or by a backslash path separator.
//   · UUIDs written WITHOUT hyphens or abbreviated to anything but their 8-hex prefix; IPv6; a
//     value glued to a letter or digit (`x<value>`, `<value>2`) — word-bounded matching treats that
//     as a different word; git-LFS pointer targets.
//   · Family allowlists: documentation / private / loopback / link-local / multicast IPv4 ranges,
//     version-shaped dotted quads, well-known resolver addresses, the nil/max and RFC 4122
//     namespace UUIDs, and noreply / git@ / reserved-domain addresses are NOT auto-enrolled. A
//     private address that matters to you must be enrolled by hand (`add IP --stdin`).
//   · An 8-hex prefix of a KNOWN UUID is redacted wherever it stands as its own word, including
//     the vanishingly rare short git SHA that happens to equal it.
//   · Confusable spellings are DETECTED by `check` (folded through `foldForGate`) but cannot be
//     rewritten by `apply`; they stay as failures for a human to fix.
//   · A git repository with an EXTERNAL work tree that is not announced by `GIT_WORK_TREE`
//     (a bare dotfile repo managed by yadm / vcsh / `--work-tree=$HOME`) is invisible to the
//     in-work-tree refusal.
//   · File I/O residuals: the map's mode is read by `lstat` just before the no-follow open, not
//     from the descriptor; the map directory's mode is set only when this module creates it;
//     nothing is fsync'd before a rename. A file with OTHER hard links: the atomic rename
//     replaces this name only, so every other name keeps the raw bytes (no write-through, and no
//     redaction there either).
//   · A text carrying the reserved private-use markers U+E000/U+E001 is still CHECKED, but
//     `apply` skips it (counted as skipped-reserved) rather than risk a mis-restored token.

/** Legacy variable name; account selection is .claude/hooks/lib/redaction-map-binding.js::resolveRedactionMapPath. */
export const REDACTION_MAP_ENV = "COC_REDACTION_MAP";
/** Operator-declared categories. */
export const REDACTION_CATEGORIES = Object.freeze(["OP", "HOST", "PATH", "ACCT", "ORG", "TEN"]);
/** Pattern-detected families, enrolled by `redactText(..., { enrolFamilies: true })`. */
export const REDACTION_FAMILIES = Object.freeze(["SID", "EMAIL", "IP"]);
/** Bounds on the map, so an enrolling apply can never grow it past what loads (C1 R1 M6). */
export const REDACTION_MAP_MAX_ENTRIES = 20000;
export const REDACTION_MAP_MAX_BYTES = 16 * 1024 * 1024;
const REDACTION_ALL_CATS = [...REDACTION_CATEGORIES, ...REDACTION_FAMILIES];
const REDACTION_TOKEN_RE = new RegExp(`^@@(${REDACTION_ALL_CATS.join("|")})-(\\d{3,})@@$`);
const REDACTION_TOKEN_SCAN_SRC = `@@(?:${REDACTION_ALL_CATS.join("|")})-\\d{3,}@@`;
// Private-use markers stand in for a replacement until the end of a redact pass, so no later pass
// can match inside a value already replaced, and every replacement keeps its original spelling.
const MARK_OPEN = "\uE000", MARK_CLOSE = "\uE001", MARK_DIGIT0 = 0xE100;
const RESERVED_MARK_RE = /[\uE000\uE001]/g;
const MARK_SRC = `${MARK_OPEN}[\\uE100-\\uE1FF]+${MARK_CLOSE}`;
const PROTECT_SRC = `${REDACTION_TOKEN_SCAN_SRC}|${MARK_SRC}`;
const TOKEN_IN_VALUE_RE = new RegExp(REDACTION_TOKEN_SCAN_SRC);

/**
 * Per-category entry COUNTS of a loaded map — every category, zero included, never a value.
 * The map-only categories (`REDACTION_CATEGORIES`) are detectable ONLY through map entries, so a
 * count of 0 there means that category was not checked at all; it is not a clean result.
 *
 * @param {{ entries: { cat: string }[] }} map a loaded map (`loadRedactionMap`)
 * @returns {Readonly<Record<string, number>>}
 */
export function redactionMapCounts(map) {
  const counts = Object.fromEntries(REDACTION_ALL_CATS.map((c) => [c, 0]));
  for (const e of (map && map.entries) || []) if (Object.prototype.hasOwnProperty.call(counts, e.cat)) counts[e.cat]++;
  return Object.freeze(counts);
}

/** Total entries across the map-only categories (OP HOST PATH ACCT ORG TEN) in `counts`. */
export function redactionMapOnlyTotal(counts) {
  return REDACTION_CATEGORIES.reduce((n, c) => n + (counts[c] || 0), 0);
}

/** `OP=1 HOST=0 … IP=0` — the counts in the fixed category order. Counts only. */
export function formatRedactionMapCounts(counts) {
  return REDACTION_ALL_CATS.map((c) => `${c}=${counts[c] || 0}`).join(" ");
}

/**
 * The ONE line every fence and printer that reads the map prints, so a run with no map — or a map
 * holding no map-only entries — is VISIBLE rather than indistinguishable from a covered run (the
 * H4 residual: no fence used to print how many entries it had loaded). Counts only, never a value.
 */
export function redactionAuthorityLine(authority) {
  if (!authority || !["UNPINNED", "EXPLICIT"].includes(authority.mode) || typeof authority.mapPresent !== "boolean") throw new RedactionMapError("authority-metadata", "redaction authority metadata is unavailable");
  return `redaction-authority mode=${authority.mode} authority-file=${authority.mode === "EXPLICIT" ? "none" : authority.authorityPath || "unsupported-platform"} map-present=${authority.mapPresent}`;
}
export function redactionMapCoverageLine(counts, authority) {
  const line = `redaction-map entries ${formatRedactionMapCounts(counts)}` + (authority ? ` — ${redactionAuthorityLine(authority)}` : "");
  if (redactionMapOnlyTotal(counts) > 0) return line;
  return `${line} — no map-only entries: ${REDACTION_CATEGORIES.join(" ")} values are NOT checked by this run (create a map with \`redact.mjs add <CAT> --stdin\`)`;
}

/** True when `t` is exactly one redaction-map token: `@@CAT-NNN@@`, a known CAT, >= 3 digits. */
export function isRedactionToken(t) {
  return typeof t === "string" && REDACTION_TOKEN_RE.test(t);
}


/** Account map selector: .claude/hooks/lib/redaction-map-binding.js::resolveRedactionMapPath. */
export function defaultRedactionMapPath() {
  return resolveRedactionMapPath().path;
}


/**
 * True when `p` (which need not exist) lies under a `.git` marker — a `.git` directory or worktree
 * FILE in the canonical path or any ancestor, or a path passing THROUGH a `.git` directory. The
 * nearest existing ancestor is resolved with `realpathSync` first (security.md § Path Containment).
 * This answers "is there a repository here at all?" WITHOUT asking git, so it still answers when git
 * runs but cannot open the repository (an unknown extension; a dubious-ownership refusal): callers
 * use it to tell "no repository" — a legitimate negative — from "a repository git could not read",
 * which must refuse.
 */
export function hasGitMarkerAncestor(p) {
  const real = nearestRealAncestor(p);
  return real !== null && markerAtOrAbove(real);
}

/**
 * THE canonical form of `p` for a containment decision (M-W2.1 R2 S1): `realpathSync.native` —
 * which returns the ON-DISK spelling, so on a case-insensitive volume `MAPDIR/x` and `mapdir/x`
 * canonicalize alike, where the JS `realpathSync` keeps whatever case it was handed — applied to
 * the nearest EXISTING ancestor, with the not-yet-existing tail re-appended as given.
 *
 * It climbs ONLY past a component that is genuinely ABSENT — realpath says ENOENT AND `lstat`
 * sees nothing there. Anything else THROWS (refuse): EACCES and ELOOP are components that exist
 * but cannot be characterised, and an ENOENT that `lstat` CAN see is a dangling link whose target
 * may lie anywhere. Climbing past those returned a real ancestor plus a lexical tail — a form that
 * never resolved — so `pathWithin` judged a dangling `tree/artifact.txt -> outside/x` as INSIDE
 * the tree (train-8 R1 correctness F1 / security F9). The same semantics as
 * `path-containment.mjs::realpathForContainment`.
 */
export function canonicalPath(p) {
  // Absolute WITHOUT lexical normalisation: a ".." after an existing component is the kernel's to
  // resolve (after links), and one in the absent tail is refused (train-8 R2 security N6).
  const raw = String(p);
  let probe = path.isAbsolute(raw) ? raw : `${process.cwd()}${path.sep}${raw}`;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(probe), ...tail);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e; // EACCES / ELOOP / ENOTDIR: refuse, never climb
      let entryExists = true;
      try { lstatSync(probe); } catch { entryExists = false; /* genuinely absent: climb */ }
      if (entryExists) throw new Error(`canonicalPath: ${JSON.stringify(probe)} exists but does not resolve (a dangling link); refusing to canonicalize past it`);
    }
    const up = path.dirname(probe);
    // Not even the filesystem root resolved: REFUSE, never the lexical spelling — a containment
    // decision over an unresolved form is the raw-fallback security.md § Path Containment forbids.
    if (up === probe) throw new Error(`canonicalPath: no ancestor of ${JSON.stringify(String(p))} resolves; refusing to canonicalize lexically`);
    const base = path.basename(probe);
    if (base === "." || base === "..") throw new Error(`canonicalPath: ${JSON.stringify(String(p))} has a dot segment in its absent tail; refusing to collapse it lexically`);
    if (base !== "") tail.unshift(base);
    probe = up;
  }
}

const swapCase = (s) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

/**
 * Whether the volume holding canonical path `real` folds case: the nearest existing component
 * whose name has a case is looked up again with its case swapped, and the two must be ONE inode.
 * A volume that cannot be shown to fold reads false (compare exactly).
 */
export function volumeFoldsCase(real) {
  for (let d = path.resolve(String(real)); ; d = path.dirname(d)) {
    const base = path.basename(d);
    const flipped = swapCase(base);
    if (flipped !== base) {
      let a = null;
      try { a = lstatSync(d); } catch { /* absent: climb */ }
      if (a) {
        try { const b = lstatSync(path.join(path.dirname(d), flipped)); return a.dev === b.dev && a.ino === b.ino; } catch { return false; }
      }
    }
    if (path.dirname(d) === d) return false;
  }
}

/**
 * THE containment test for "is `candidate` the folder `root` or inside it" — both sides through
 * `canonicalPath` (security.md § Path Containment: the SAME resolver on both), compared case- and
 * normalization-folded exactly when `root`'s volume folds case. `redact.mjs` decides "beside the
 * map" and asks git about a restore target's on-disk name through this and `canonicalPath`, so
 * the two can never canonicalize differently again.
 */
export function pathWithin(candidate, root) {
  let c = canonicalPath(candidate), r = canonicalPath(root);
  if (volumeFoldsCase(r)) { c = c.normalize("NFC").toLowerCase(); r = r.normalize("NFC").toLowerCase(); }
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}


function validateRedactionEntries(entries) {
  if (!Array.isArray(entries)) throw new RedactionMapError("malformed", "`entries` is not an array");
  if (entries.length > REDACTION_MAP_MAX_ENTRIES) throw new RedactionMapError("full", `the map holds ${entries.length} entries, above the ${REDACTION_MAP_MAX_ENTRIES} cap`);
  const tokens = new Set(), values = new Set();
  entries.forEach((e, i) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new RedactionMapError("malformed", `entry #${i} is not an object`);
    const m = typeof e.token === "string" ? REDACTION_TOKEN_RE.exec(e.token) : null;
    if (!m) throw new RedactionMapError("malformed", `entry #${i} has no valid @@CAT-NNN@@ token`);
    if (e.cat !== m[1]) throw new RedactionMapError("malformed", `entry #${i} has a cat that disagrees with its token`);
    if (typeof e.value !== "string" || /[\r\n]/.test(e.value) || e.value.trim() !== e.value) {
      throw new RedactionMapError("malformed", `entry #${i} has a non-string, multi-line or padded value`);
    }
    // The same floor `addRedactionValue` enforces: a hand-edited 1–2 char value would be used by the
    // CLI yet skipped by every fence (C1 R1 correctness 16), two answers to one map.
    if (e.value.length < TENANT_TOKEN_MIN_LEN) throw new RedactionMapError("malformed", `entry #${i} has a value below the ${TENANT_TOKEN_MIN_LEN}-char floor`);
    // A value that IS or CARRIES a token is what a map looks like after an apply rewrote it
    // (M-W2.1 R2 S1): every raw value is gone and the map would still load as healthy, detecting
    // nothing. Never a legitimate enrolment either — tokens are protected from re-matching.
    if (TOKEN_IN_VALUE_RE.test(e.value)) throw new RedactionMapError("malformed", `entry #${i} has a value that is or carries a redaction token — the map looks tokenized; restore it from a backup`);
    if (tokens.has(e.token)) throw new RedactionMapError("malformed", `entry #${i} repeats a token`);
    const fold = e.value.toLowerCase();
    if (values.has(fold)) throw new RedactionMapError("malformed", `entry #${i} repeats a value under another token`);
    tokens.add(e.token); values.add(fold);
  });
}

/**
 * Load the map.
 *   ABSENT at the DEFAULT location carries UNPINNED authority metadata (.claude/hooks/lib/redaction-map-binding.js::resolveRedactionMapPath). This answer comes
 *   BEFORE the in-work-tree test, so a consumer whose ~/.config is itself a repository, and who
 *   never made a map, is not refused (C1 R1 M2). An empty answer is NOT a covered one: the
 *   map-only categories cannot be detected from it, so `redact.mjs` scan / check / apply REFUSE
 *   it (exit 2) unless `--allow-no-map`, and every fence prints `redactionMapCoverageLine`.
 *   ABSENT at an EXPLICIT path → throws `kind:"absent"` (C1 R1 H4).
 *   REFUSED (throws `RedactionMapError`): a path inside a git work tree; on POSIX a file whose
 *   mode grants ANY group/other bit (looser than 0600); a symlink, FIFO or other non-regular file
 *   (via `readRegularFileNoFollow`); unparseable JSON or a malformed entry. Error text carries no
 *   path and no value.
 *
 * @param {string} [p] map path; default the resolved map path
 * @param {{ explicit?: boolean }} [opts] default: explicit unless `p` is the resolved default path
 *        (selection: .claude/hooks/lib/redaction-map-binding.js::resolveRedactionMapPath)
 * @returns {{ entries: {token:string, cat:string, value:string}[] }}
 */
export function loadRedactionMap(p = defaultRedactionMapPath(), { explicit } = {}) {
  if (typeof p !== "string" || p.trim() === "") throw new RedactionMapError("no-path", "no map path was given");
  const r = resolveRedactionMapPath();
  const isExplicit = explicit === undefined ? r.explicit || path.resolve(p) !== path.resolve(r.path) : explicit;
  let st;
  try { st = lstatSync(p); } catch (e) {
    if (e && e.code === "ENOENT") {
      if (isExplicit) throw new RedactionMapError("absent", "the map named explicitly by a draft API does not exist — refusing to run as though there were no map");
      return { entries: [], authority: { mode: r.mode, authorityPath: r.authorityPath, mapPresent: false } };
    }
    throw new RedactionMapError("malformed", `cannot stat the map (${(e && e.code) || "error"})`);
  }
  assertMapPathUsable(p);
  if (process.platform !== "win32" && st.isFile() && (st.mode & 0o077) !== 0) {
    throw new RedactionMapError("mode-too-open", `the map file mode is looser than 0600 (${(st.mode & 0o777).toString(8)}) — restrict it to the owner (mode 600)`);
  }
  const text = readRegularFileNoFollow(p, { label: "redaction-map.json", maxBytes: REDACTION_MAP_MAX_BYTES });
  const parsed = jsonParseOrThrow(text, "redaction-map.json");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RedactionMapError("malformed", "the map is not a JSON object");
  validateRedactionEntries(parsed.entries);
  const map = { entries: parsed.entries.map((e) => ({ token: e.token, cat: e.cat, value: e.value })) };
  Object.defineProperty(map, "authority", { value: Object.freeze({ mode: isExplicit ? "EXPLICIT" : r.mode, authorityPath: isExplicit ? null : r.authorityPath, mapPresent: true }) });
  return map;
}

/**
 * Replace `p`'s bytes atomically: an exclusive sibling temp file, then `rename` over `p`. `rename`
 * replaces the directory ENTRY — it never follows a symlink at `p` and never writes through a hard
 * link — so a swapped-in link cannot redirect the write (C1 R1 H1 / correctness 15).
 */
export function writeFileAtomic(p, data, mode = 0o644) {
  const dir = path.dirname(path.resolve(p));
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, data, { mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, p);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort: the temp file is the only residue */ }
    throw e;
  }
}

/**
 * Write the map atomically with mode 0600 (directory created 0700). MERGE-CHECKED: the map on disk
 * is re-read first and every entry it holds must appear, identically, in `map` — a writer that
 * loaded an older map, or one that bypassed the lock, is refused (`kind:"concurrent"`) rather than
 * allowed to drop or renumber another writer's enrolments (C1 R1 H2 / correctness 2). Hold the lock
 * from `acquireRedactionMapLock` across load → save.
 */
export function saveRedactionMap(p, map) {
  assertMapPathUsable(p);
  validateRedactionEntries(map && map.entries);
  let onDisk = { entries: [] };
  try { lstatSync(p); onDisk = loadRedactionMap(p, { explicit: true }); } catch (e) {
    if (!(e && e.code === "ENOENT")) throw e;
  }
  const mine = new Map(map.entries.map((e) => [e.token, e]));
  for (const d of onDisk.entries) {
    const m = mine.get(d.token);
    if (!m || m.value !== d.value || m.cat !== d.cat) {
      throw new RedactionMapError("concurrent", "the map on disk changed since it was loaded — reload it under the lock and retry; nothing was written");
    }
  }
  mkdirSync(path.dirname(path.resolve(p)), { recursive: true, mode: 0o700 });
  writeFileAtomic(p, JSON.stringify({ $id: "coc.redaction-map/v1", entries: map.entries }, null, 1) + "\n", 0o600);
}

/**
 * Take the map's write lock: `<map>.lock`, created exclusively. Every writer (`add`, `apply`)
 * holds it from LOAD to SAVE, so two concurrent enrolments cannot each number from the same
 * maximum and hand one token to two values (C1 R1 H2). Returns a release function. A lock that
 * exists is refused with its age, never silently broken; remove it by hand once no writer runs.
 */
export function acquireRedactionMapLock(mapPath) {
  assertMapPathUsable(mapPath);
  const lock = path.resolve(mapPath) + ".lock";
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e && e.code === "EEXIST") {
      let age = "unknown";
      try { age = `${Math.round((Date.now() - statSync(lock).mtimeMs) / 1000)}s`; } catch { /* raced away */ }
      throw new RedactionMapError("locked", `another writer holds the map lock (age ${age}); if none is running, remove the .lock file beside the map`);
    }
    throw e;
  }
  return () => { try { rmSync(lock, { force: true }); } catch { /* already gone */ } };
}

/** The directory holding apply records: beside the map, so it inherits the map's outside-every-repo placement. */
export function redactionRecordDir(mapPath) {
  return path.join(path.dirname(path.resolve(mapPath)), "redaction-applies");
}

/**
 * The apply-record directory, held to the MAP's location checks before anything reads or writes
 * it (M-W2.1 R2 S5): outside every git work tree, and a real directory — never a symlink, which
 * would let restore take its original spellings (raw values it writes back) from anywhere.
 * Returns the directory, or null when it does not exist yet. Value-free and path-free refusals.
 */
function assertRecordDirUsable(mapPath) {
  const dir = redactionRecordDir(mapPath);
  let st;
  try { st = lstatSync(dir); } catch (e) {
    if (e && e.code === "ENOENT") { assertMapPathUsable(path.join(dir, "probe.json")); return null; }
    throw new RedactionMapError("malformed", `cannot stat the apply-record directory (${(e && e.code) || "error"})`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new RedactionMapError("malformed", "the apply-record directory beside the map is a symlink or not a directory — refusing to read or write apply records through it");
  }
  assertMapPathUsable(path.join(dir, "probe.json"));
  return dir;
}

/**
 * Persist one apply's record (mode 0600, directory 0700) and return its id. The record holds raw
 * values — the original spellings — which is why it lives beside the map and is refused inside a
 * work tree exactly as the map is.
 */
export function writeApplyRecord(mapPath, record) {
  const dir = redactionRecordDir(mapPath);
  if (assertRecordDirUsable(mapPath) === null) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertRecordDirUsable(mapPath);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  writeFileAtomic(path.join(dir, `${id}.json`), JSON.stringify({ $id: "coc.redaction-apply/v1", id, ...record }) + "\n", 0o600);
  return id;
}

/** Cut apply record `id` back to `files`; with none left the record is removed. */
function trimApplyRecord(mapPath, id, record, files) {
  const dir = redactionRecordDir(mapPath);
  assertRecordDirUsable(mapPath);
  if (typeof id !== "string" || !/^[0-9A-Za-z-]+$/.test(id)) throw new RedactionMapError("malformed", "an apply record id is malformed");
  const p = path.join(dir, `${id}.json`);
  if (!files.length) { rmSync(p, { force: true }); return; }
  writeFileAtomic(p, JSON.stringify({ $id: "coc.redaction-apply/v1", id, ...record, files }) + "\n", 0o600);
}

/**
 * An apply's file-rewrite phase (C1 R2 F7). `writes` are `{ abs, text, mode, rec }`, where
 * `rec.path` is the canonical path and `rec.pre_sha256` the hash of the bytes the rewrite was
 * computed from. Immediately before each atomic rename the file is re-resolved and re-read: if it
 * no longer resolves to `rec.path`, or its bytes no longer hash to `rec.pre_sha256`, someone edited
 * it after it was read, and renaming over it would erase that edit with no trace. The phase then
 * STOPS — that file and every later one stay unwritten — and throws `kind:"changed"` with `.index`
 * naming the write (no path, no value). On that stop, or on any failed write, apply record `id`
 * (which `record` was written as) is cut back to the files ACTUALLY rewritten, so a record never
 * claims a file this apply did not write. `beforeWrite(w, i)`, when given, runs before each check.
 *
 * RESIDUAL, declared: an edit landing between the re-hash and the rename is still lost — closing
 * that needs a lock the editor itself honours, which a plain text file does not have.
 *
 * @returns {number} the count of files rewritten
 */
export function commitApplyWrites(mapPath, { id, record, writes, maxBytes = READ_REGULAR_FILE_MAX_BYTES, beforeWrite = null }) {
  const written = [];
  try {
    writes.forEach((w, i) => {
      if (beforeWrite) beforeWrite(w, i);
      let real = null, now = null;
      try {
        real = realpathSync(w.abs);
        now = createHash("sha256").update(readRegularFileNoFollow(w.abs, { encoding: null, maxBytes, label: "apply target" })).digest("hex");
      } catch { /* unresolvable or unreadable: it is not the file that was read */ }
      if (real !== w.rec.path || now !== w.rec.pre_sha256) {
        const e = new RedactionMapError("changed", `apply target #${i} changed since it was read, or no longer resolves to the same file — it was not rewritten`);
        e.index = i;
        throw e;
      }
      writeFileAtomic(w.abs, w.text, w.mode);
      written.push(w.rec);
    });
  } catch (e) {
    if (id) trimApplyRecord(mapPath, id, record, written);
    throw e;
  }
  return written.length;
}

/** Every apply record, newest first. Each is read no-follow and parsed; an unreadable one is refused loudly. */
export function readApplyRecords(mapPath) {
  const dir = assertRecordDirUsable(mapPath);
  if (dir === null) return [];
  const names = readdirSync(dir);
  return names.filter((n) => n.endsWith(".json")).sort().reverse()
    .map((n) => jsonParseOrThrow(readRegularFileNoFollow(path.join(dir, n), { label: "redaction apply record", maxBytes: 256 * 1024 * 1024 }), "redaction apply record"));
}

/**
 * Enrol `value` under `cat` and return its token. One value → one token, always: a value already
 * present (case-insensitively) returns its EXISTING token, whatever `cat` is asked for now.
 * Refuses (typed, value-free) an unknown category, a multi-line or padded value, a value below
 * `TENANT_TOKEN_MIN_LEN`, a value that is itself a placeholder, or an enrolment beyond
 * `REDACTION_MAP_MAX_ENTRIES`. Mutates `map`; the caller saves it under the lock.
 */
export function addRedactionValue(map, cat, value) {
  if (!REDACTION_ALL_CATS.includes(cat)) throw new RedactionMapError("bad-category", `unknown category (expected one of ${REDACTION_ALL_CATS.join(" ")})`);
  const v = String(value ?? "");
  if (/[\r\n]/.test(v) || v.trim() !== v) throw new RedactionMapError("bad-value", "a value must be one line with no surrounding whitespace");
  if (v.length < TENANT_TOKEN_MIN_LEN) throw new RedactionMapError("bad-value", `a value must be at least ${TENANT_TOKEN_MIN_LEN} chars (got ${v.length})`);
  if (isScrubPlaceholderToken(v)) throw new RedactionMapError("bad-value", "a placeholder cannot be enrolled as a value");
  const fold = v.toLowerCase();
  const have = map.entries.find((e) => e.value.toLowerCase() === fold);
  if (have) return have.token;
  if (map.entries.length >= REDACTION_MAP_MAX_ENTRIES) throw new RedactionMapError("full", `the map is at its ${REDACTION_MAP_MAX_ENTRIES}-entry cap`);
  let n = 0;
  for (const e of map.entries) if (e.cat === cat) n = Math.max(n, Number(REDACTION_TOKEN_RE.exec(e.token)[2]));
  const token = `@@${cat}-${String(n + 1).padStart(3, "0")}@@`;
  map.entries.push({ token, cat, value: v });
  return token;
}

/**
 * Whether a map value is matched by the fences as an UNBOUNDED substring (true) or WORD-BOUNDED
 * (false). A value under 4 chars, or one made only of hex digits and hyphens (which covers decimal
 * digits), would halt an unbounded gate on every digest or number that happens to contain it
 * (C1 R1 M6 / correctness 12), so it is matched bounded instead. It is NEVER dropped from the gate
 * (C1 R2 F1): `redactionMapGateTokens` routes it to `gateBounded`.
 */
export function redactionGateEligible(value) {
  const v = String(value);
  return !(v.length < 4 || /^[0-9a-f-]+$/i.test(v));
}

/**
 * The redaction map's contribution to the disclosure gates, as ONE function so every gate reads the
 * map the same way — `deriveDynamicTokens` § 6, and any gate that reads the map without a roster.
 * `gate`: values matched as unbounded substrings. `gateBounded`: values matched word-bounded
 * (`redactionGateEligible` false). `unhonoured`: values below `TENANT_TOKEN_MIN_LEN`, reported by
 * length only. Every map value at or above the floor lands in exactly one of the two gate lists.
 *
 * @param {{ entries: { value: string }[] }} map a loaded map (`loadRedactionMap`)
 * @returns {{ gate: string[], gateBounded: string[], unhonoured: object[] }}
 */
export function redactionMapGateTokens(map) {
  const gate = [], gateBounded = [], unhonoured = [];
  for (const e of map.entries) {
    if (e.value.length < TENANT_TOKEN_MIN_LEN) {
      unhonoured.push({ reason: "below-min-length", length: e.value.length, floor: TENANT_TOKEN_MIN_LEN });
      continue;
    }
    (redactionGateEligible(e.value) ? gate : gateBounded).push(e.value);
  }
  return { gate, gateBounded, unhonoured };
}

/**
 * The ONE matcher for a gate token against a haystack, both ALREADY folded through `foldForGate`.
 * Unbounded: a plain substring test. Bounded (`gateBounded` tokens): the token must not touch an
 * ASCII letter or digit on either side — the same boundary `tokenBoundedRe` scrubs with, so the
 * gate halts on exactly the occurrences the scrubber is able to rewrite, and on no digest or number
 * that merely contains the value. Adjudication-aware consumers use
 * `disclosure-adjudication.mjs::tokenIsUnadjudicatedHit(..., { bounded })`, which applies the same
 * boundary per occurrence.
 */
export function gateTokenHit(foldedText, foldedToken, { bounded = false } = {}) {
  if (!foldedToken) return false;
  if (!bounded) return foldedText.includes(foldedToken);
  for (let i = foldedText.indexOf(foldedToken); i !== -1; i = foldedText.indexOf(foldedToken, i + 1)) {
    if (isBoundedOccurrence(foldedText, i, foldedToken.length)) return true;
  }
  return false;
}

/** True when `[idx, idx+len)` of `text` has no ASCII letter or digit immediately on either side. */
export function isBoundedOccurrence(text, idx, len) {
  const alnum = /[A-Za-z0-9]/;
  return !(idx > 0 && alnum.test(text[idx - 1])) && !(idx + len < text.length && alnum.test(text[idx + len]));
}

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Well-known UUIDs that identify nobody: nil, max, and the RFC 4122 Appendix C namespace ids.
const BENIGN_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "6ba7b810-9dad-11d1-80b4-00c04fd430c8", "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  "6ba7b812-9dad-11d1-80b4-00c04fd430c8", "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
]);
const RESERVED_EMAIL_DOMAIN_RE = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$/i;
const BENIGN_EMAIL_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|git)$/i;
// Public resolvers named in documentation everywhere; they identify no operator.
const BENIGN_IPS = new Set(["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112"]);

function benignIp(m, whole, off) {
  if (BENIGN_IPS.has(m)) return true;
  const o = m.split(".").map(Number);
  if (o.filter((x) => x === 0).length >= 2) return true; // version-shaped (1.0.0.0) or a network address
  if (o[0] === 0 || o[0] === 10 || o[0] === 127 || o[0] >= 224) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if ((o[0] === 192 && o[1] === 0 && o[2] === 2) || (o[0] === 198 && o[1] === 51 && o[2] === 100) || (o[0] === 203 && o[1] === 0 && o[2] === 113)) return true;
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true;
  return /(?:version|ver|v)[\s"'=:(]*$/i.test(whole.slice(Math.max(0, off - 16), off));
}

/** The family detectors, in application order. Fresh RegExps per call (the `g` flag carries state). */
function redactionFamilyDetectors() {
  return {
    // Applied BEFORE the map values (C1 R1 M5), so a map value inside an address cannot be
    // replaced alone and leave the rest of the address raw and uncounted.
    email: { cat: "EMAIL", re: new RegExp(EMAIL_RE.source, "g"), benign: (m) => {
      const at = m.lastIndexOf("@");
      return RESERVED_EMAIL_DOMAIN_RE.test(m.slice(at + 1)) || BENIGN_EMAIL_LOCAL_RE.test(m.slice(0, at)) || m.toLowerCase() === SCRUB_PLACEHOLDER.EMAIL;
    } },
    ids: [
      { cat: "SID", re: /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi, benign: (m) => BENIGN_UUIDS.has(m.toLowerCase()) },
      { cat: "SID", re: /(?<![0-9A-Za-z])a[0-9a-f]{16}(?![0-9A-Za-z])/g, benign: () => false },
      { cat: "IP", re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g, benign: benignIp },
    ],
  };
}

function lineIndexer(text) {
  const nl = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) nl.push(i);
  return (off) => { let lo = 0, hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < off) lo = mid + 1; else hi = mid; } return lo + 1; };
}

function markFor(i) {
  let s = "";
  do { s = String.fromCharCode(MARK_DIGIT0 + (i & 0xff)) + s; i >>= 8; } while (i > 0);
  return MARK_OPEN + s + MARK_CLOSE;
}
function markIndex(m) {
  let i = 0;
  for (const ch of m.slice(1, -1)) i = (i << 8) | (ch.charCodeAt(0) - MARK_DIGIT0);
  return i;
}

/**
 * Redact `text` with `map`. Order, each step over the output of the last, and NONE of them able to
 * match inside a token already present or a value already replaced (C1 R1 correctness 7):
 *   1. EMAIL family (C1 R1 M5);
 *   2. every map value, longest first, word-bounded;
 *   3. the id families — UUID, subagent id `a<16 hex>`, IPv4 — minus their benign allowlists
 *      (C1 R1 correctness 4);
 *   4. the 8-hex PREFIX of every UUID that is KNOWN (in the map, or carried by this text),
 *      word-bounded, so it never matches inside a longer hex run (C1 R1 correctness 12).
 * A family match that is itself a scrub placeholder (a `deadbeef` stream) is not a value and is left
 * alone, so an apply never fails mid-run trying to enrol one.
 *
 * Returns `{ text, hits, enrolled, slots }`. `hits` carry CATEGORY and LINE only. `slots` lists every
 * token occurrence in the output, in order: `{ original }` for a token this pass wrote (the exact
 * source spelling it replaced) or `null` for a token that was already there — the input to an exact,
 * record-keyed restore (`restoreFromSlots`). With `enrolFamilies` a family match not yet in the map
 * is ENROLLED (mutating `map`); without it the match is replaced by a category marker that is NOT a
 * valid token, so that result is for counting only. `families: false` applies the map alone.
 * Text carrying the reserved private-use marker characters is refused (`kind:"reserved-chars"`).
 */
export function redactText(text, map, { enrolFamilies = false, families = true } = {}) {
  const src = String(text);
  if (src.includes(MARK_OPEN) || src.includes(MARK_CLOSE)) throw new RedactionMapError("reserved-chars", "the text carries the reserved private-use marker characters U+E000/U+E001; it cannot be redacted safely");
  let txt = src;
  const hits = [], spans = [];
  let enrolled = 0;
  const known = new Map(map.entries.map((x) => [x.value.toLowerCase(), x.token]));
  const tokenFor = (cat, m) => {
    const have = known.get(m.toLowerCase());
    if (have) return have;
    if (!enrolFamilies) return `@@${cat}@@`;
    enrolled++;
    const t = addRedactionValue(map, cat, m);
    known.set(m.toLowerCase(), t);
    return t;
  };
  // One protected pass: `re` matches only OUTSIDE existing tokens and earlier replacements.
  const pass = (re, onMatch) => {
    const combined = new RegExp(`(${PROTECT_SRC})|(?:${re.source})`, re.flags.includes("g") ? re.flags : re.flags + "g");
    const lineAt = lineIndexer(txt);
    txt = txt.replace(combined, (m, prot, off, whole) => {
      if (prot !== undefined) return m;
      const r = onMatch(m, off, whole);
      if (r === null) return m;
      hits.push({ cat: r.cat, line: lineAt(off) });
      spans.push({ token: r.token, original: m });
      return markFor(spans.length - 1);
    });
  };
  const det = redactionFamilyDetectors();
  if (families) {
    pass(det.email.re, (m) => (det.email.benign(m) || isScrubPlaceholderToken(m) ? null : { cat: "EMAIL", token: tokenFor("EMAIL", m) }));
  }
  for (const e of [...map.entries].sort((a, b) => b.value.length - a.value.length)) {
    pass(tokenBoundedRe(e.value), () => ({ cat: e.cat, token: e.token }));
  }
  if (families) {
    const seen = new Set();
    for (const m of src.match(det.ids[0].re) || []) if (!det.ids[0].benign(m)) seen.add(m.toLowerCase());
    for (const e of map.entries) if (e.cat === "SID" && UUID_SHAPE_RE.test(e.value)) seen.add(e.value.toLowerCase());
    for (const d of redactionFamilyDetectors().ids) {
      pass(d.re, (m, off, whole) => (d.benign(m, whole, off) || isScrubPlaceholderToken(m) ? null : { cat: d.cat, token: tokenFor(d.cat, m) }));
    }
    for (const u of [...seen].sort()) {
      const prefix = u.slice(0, 8);
      if (isScrubPlaceholderToken(prefix)) continue;
      pass(tokenBoundedRe(prefix), (m) => ({ cat: "SID", token: tokenFor("SID", m.toLowerCase()) }));
    }
  }
  // Resolve: walk the protected stream in order, so `slots` lines up with the output's tokens.
  const slots = [];
  const out = txt.replace(new RegExp(PROTECT_SRC, "g"), (m) => {
    if (m.startsWith(MARK_OPEN)) { const s = spans[markIndex(m)]; slots.push({ original: s.original }); return s.token; }
    slots.push(null);
    return m;
  });
  return { text: out, hits, enrolled, slots };
}

/**
 * Undo one apply EXACTLY: walk the token occurrences of `text` in order against `slots` (from
 * `redactText` at apply time) and put back each recorded original; a `null` slot — a token that was
 * already there — is left as written. Throws if the text's token occurrences no longer line up with
 * the record (the file changed since the apply). Never expands a token the record does not own.
 */
export function restoreFromSlots(text, slots) {
  let i = 0;
  const out = String(text).replace(new RegExp(REDACTION_TOKEN_SCAN_SRC, "g"), (m) => {
    if (i >= slots.length) throw new RedactionMapError("concurrent", "the file carries more tokens than its apply record — it changed since the apply");
    const s = slots[i++];
    return s ? s.original : m;
  });
  if (i !== slots.length) throw new RedactionMapError("concurrent", "the file carries fewer tokens than its apply record — it changed since the apply");
  return out;
}

/**
 * Read-only detection: every hit `redactText` would make (never enrolling), PLUS confusable
 * spellings of a map value that the literal matcher misses — each remaining line is folded through
 * `foldForGate` and searched, word-bounded, for each folded value (C1 R1 L5). A confusable hit
 * cannot be rewritten by `apply`, so it stays a `check` failure. `families: false` restricts it to
 * the map's own values (the no-literal check on source files, where an illustrative address in a
 * comment is not a map value).
 */
export function findRedactionHits(text, map, { families = true } = {}) {
  // Read-only: a reserved marker cannot be part of a value (load refuses it), so it is neutralised
  // rather than refused — detection must never go blind on a file that merely carries one.
  const { text: rest, hits } = redactText(String(text).replace(RESERVED_MARK_RE, "\uFFFD"), { entries: map.entries.slice() }, { families });
  if (map.entries.length) {
    const folded = map.entries.map((e) => [e.cat, tokenBoundedRe(foldForGate(e.value))]);
    rest.split("\n").forEach((line, i) => {
      if (/^[\x00-\x7f]*$/.test(line)) return; // pure ASCII: the literal pass already decided it
      const f = foldForGate(line);
      for (const [cat, re] of folded) { re.lastIndex = 0; if (re.test(f)) hits.push({ cat, line: i + 1, confusable: true }); }
    });
  }
  return { hits };
}

/**
 * The fence PRINTERS' one entry point: `text` with every map-sourced value replaced by its
 * `@@CAT-NNN@@` token. Use it on every string a gate prints: hit text, file paths, failure
 * reasons. A path can carry a value in a NAME.
 *
 * A PRINTER IS NEVER WEAKER THAN A GATE (C1 R2 F5a). The gates match a value as an UNBOUNDED
 * substring of `foldForGate(text)`, so a printer that masked word-bounded and unfolded printed
 * exactly the occurrences the gates halt on — a value glued to a letter (`notes<value>x.md`), or
 * spelled with a combining mark or a compatibility form. The mask therefore runs two passes:
 *   1. every value, longest first, as a case-insensitive SUBSTRING (existing tokens protected);
 *   2. per line, every value FOLDED (`foldForGate`) against the line folded one code point at a
 *      time, each folded hit mapped back to the source code points that produced it.
 * A line that still carries a folded value afterwards (a fold the per-code-point map cannot
 * isolate) is WITHHELD whole rather than printed. Over-masking a printed string is the safe
 * direction; the redaction verbs (`redactText`, `check`, `apply`) keep their word-bounded matcher,
 * because they REWRITE content and a printer does not.
 *
 * Families are NOT applied — a printer masks what the map declares, and a fence's own finding text
 * (a UUID it reports on purpose) is not rewritten.
 *
 * No map at the DEFAULT location → `text` unchanged. A map named explicitly but absent, or present
 * but refused (in-repo path, mode looser than 0600, symlink, malformed), THROWS `RedactionMapError`
 * exactly as `loadRedactionMap` does: a printer must never fall back to printing values.
 *
 * @param {string} text
 * @param {{ map?: string | { entries: object[] } }} [opts] a map path or an already-loaded map;
 *        default the resolved map path.
 * @returns {string}
 */
export function maskRedactionValues(text, { map } = {}) {
  const m = loadMapArg(map);
  if (!m.entries.length) return String(text);
  // A printer must never throw on odd input it is merely masking: strip the reserved markers first.
  let txt = String(text).replace(RESERVED_MARK_RE, "\uFFFD");
  const byLen = [...m.entries].sort((a, b) => b.value.length - a.value.length);
  // PASS 1 — unfolded, case-insensitive substring; a value already replaced is never re-entered.
  const tokens = [];
  for (const e of byLen) {
    const combined = new RegExp(`(${PROTECT_SRC})|(?:${tokenUnboundedRe(e.value).source})`, "gi");
    txt = txt.replace(combined, (mm, prot) => (prot !== undefined ? mm : (tokens.push(e.token), markFor(tokens.length - 1))));
  }
  txt = txt.replace(new RegExp(MARK_SRC, "g"), (mm) => tokens[markIndex(mm)]);
  // PASS 2 — folded, per line (a value never spans a newline: load refuses one).
  const folded = byLen.map((e) => [[...foldForGate(e.value)], e.token]).filter(([f]) => f.length > 0);
  return txt.split("\n").map((line) => maskFoldedLine(line, folded)).join("\n");
}

const WITHHELD_LINE = "<line withheld: it carries a redaction-map value in a form the mask cannot isolate>";

/** True when `line`, with its tokens blanked, still folds to a string carrying a folded value. */
function lineCarriesFoldedValue(line, folded) {
  const f = foldForGate(line.replace(new RegExp(REDACTION_TOKEN_SCAN_SRC, "gi"), " "));
  return folded.some(([v]) => f.includes(v.join("")));
}

/** Index of the char run `needle` within the char array `hay`, from `start`; -1 when absent. */
function indexOfChars(hay, needle, start) {
  outer: for (let k = start; k + needle.length <= hay.length; k++) {
    for (let j = 0; j < needle.length; j++) if (hay[k + j] !== needle[j]) continue outer;
    return k;
  }
  return -1;
}

function maskFoldedLine(line, folded) {
  if (!lineCarriesFoldedValue(line, folded)) return line;
  // Fold one code point at a time, recording the source span that produced each folded char.
  const fchars = [], from = [], to = [];
  for (let i = 0; i < line.length;) {
    const w = line.codePointAt(i) > 0xffff ? 2 : 1;
    for (const ch of foldForGate(line.slice(i, i + w))) { fchars.push(ch); from.push(i); to.push(i + w); }
    i += w;
  }
  // Existing tokens are protected: no replacement may overlap one, nor another replacement.
  const taken = [...line.matchAll(new RegExp(REDACTION_TOKEN_SCAN_SRC, "gi"))].map((t) => [t.index, t.index + t[0].length]);
  const reps = [];
  for (const [v, token] of folded) {
    for (let k = indexOfChars(fchars, v, 0); k !== -1; k = indexOfChars(fchars, v, k + 1)) {
      const a = from[k], b = to[k + v.length - 1];
      if (taken.some(([s, e]) => a < e && s < b)) continue;
      taken.push([a, b]);
      reps.push([a, b, token]);
    }
  }
  let out = line;
  for (const [a, b, token] of reps.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + token + out.slice(b);
  return lineCarriesFoldedValue(out, folded) ? WITHHELD_LINE : out;
}

function loadMapArg(map) {
  if (map && typeof map === "object") return map;
  if (map === undefined) { const r = resolveRedactionMapPath(); return loadRedactionMap(r.path, { explicit: r.explicit }); }
  return loadRedactionMap(map, { explicit: true });
}

/**
 * Classify a file's bytes for redaction. `utf8` → `{ text }`; `utf16` (BOM-marked) → `{ text }`
 * for READ-ONLY scanning (apply never rewrites it); `binary` (a NUL ANYWHERE) and `non-utf8`
 * (fails strict UTF-8 decoding) → no text. Apply rewrites only `utf8`, so it can never write a
 * lossy decode back (C1 R1 correctness 5).
 */
export function classifyTextBuffer(buf) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    const le = buf[0] === 0xff;
    const body = buf.subarray(2);
    const swapped = le ? body : Buffer.from(body).swap16();
    return { kind: "utf16", text: swapped.toString("utf16le") };
  }
  if (buf.includes(0)) return { kind: "binary" };
  try { return { kind: "utf8", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf) }; }
  catch { return { kind: "non-utf8" }; }
}

/**
 * Depth-first walk that NEVER follows a symlink: entries are yielded as `(absPath, kind)` with kind
 * "file" | "symlink" | "special"; a symlinked directory is yielded as a symlink and not entered, so
 * an in-tree link to an ancestor cannot recurse (C1 R1 L4). Directories named in `skipDirs` (default
 * `.git`) are not entered and are reported through `onSkipDir`.
 *
 * An entry named `.git` is skipped WHATEVER ITS KIND (C1 R2 F3). A linked worktree's `.git` is a
 * FILE (`gitdir: <path>`), and a submodule's can be too; it is git's metadata, never content, and
 * a rewrite of it severs the worktree from its repository (`git status` exits 128).
 */
export function walkFilesNoFollow(dir, cb, { skipDirs = [".git"], onSkipDir = () => {} } = {}) {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (isGitMetadataName(e)) { onSkipDir(full); continue; }
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) cb(full, "symlink");
    else if (st.isDirectory()) { if (skipDirs.includes(e)) onSkipDir(full); else walkFilesNoFollow(full, cb, { skipDirs, onSkipDir }); }
    else cb(full, st.isFile() ? "file" : "special");
  }
}

/** The name git gives its metadata entry in a work tree — a directory, or a worktree's gitdir FILE. */
export const GIT_METADATA_NAME = ".git";

/**
 * True when a path SEGMENT names git's metadata, CASE-INSENSITIVELY (M-W2.1 R2 S4): on a
 * case-insensitive volume `.GIT` opens `.git`, and git itself refuses `.GIT` as a tracked name
 * (core.protectHFS / protectNTFS), so no content is ever lost by treating it as metadata.
 */
export function isGitMetadataName(segment) {
  return String(segment).toLowerCase() === GIT_METADATA_NAME;
}

/** The text a symlink carries — its target string — read without following it. */
export function readSymlinkText(p) {
  return readlinkSync(p, "utf8");
}
