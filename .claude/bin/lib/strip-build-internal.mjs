// strip-build-internal.mjs — codify BUILD-internal-path strip for USE-template emission.
//
// Applied at /sync Gate 2 + per-CLI artifact emission. Codifies the patterns
// from the 2026-05-12 Phase-4 broad strip (PR #84 on kailash-coc-claude-rs,
// PR #25 on kailash-coc-rs) so future /sync cycles do NOT re-leak BUILD-internal
// references that the manual sweep just cleaned.
//
// Contract: pure content transform. Idempotent — applying twice yields the
// same result as applying once. Preserves institutional content; only paths
// the USE consumer cannot resolve get rewritten.
//
// Pairs with `.claude/agents/management/coc-sync.md` Step 3a — the agent's
// per-file judgment cases (rule softening, BUILD-only artifact exclusion)
// remain prose; mechanical path-strip lives here.

// ────────────────────────────────────────────────────────────────
// REWRITES — order matters: backtick variants run before bare variants
// so the more specific match wins. Each entry is structurally:
//   pattern:     RegExp (must have /g flag for replaceAll behavior)
//   replacement: string with $N backrefs or function
//   desc:        short label used in --check output and self-test
//   buildSafe:   (optional) when true, the rewrite ALSO fires on the
//                BUILD lane (`buildMode`). See the BUILD-subset note below.
// ────────────────────────────────────────────────────────────────
//
// BUILD-scoped subset (#673): rewrites tagged `buildSafe: true` are the
// DISCLOSURE-class rules — loom-internal workspace paths (sections 1+2) +
// the canon org slug (section 3). They ALSO fire on the BUILD lane
// (`stripBuildInternalReferences(content, { buildMode: true })`) so a
// public-facing SDK BUILD repo (kailash-py / kailash-rs) never receives a
// loom workspace path or a PRIVATE org slug (derived — see `privateOrgSlugs()`).
// Rewrites
// WITHOUT the tag (sections 4–7: `packages/<repo>` / `crates/<repo>` /
// sibling `.claude/` / workspace-tree headers) are package/repo
// SELF-references a BUILD repo legitimately owns; they apply on the USE
// lane only and ship VERBATIM to BUILD (stripping `kailash-py` → generic
// ON kailash-py would corrupt the repo's own names — the F11 reason the
// BUILD lane shipped verbatim before this subset).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./entry-point.mjs";
// F6e (security read): the ONE fold used by BOTH the scanner's gate and this
// module's redactor, so their matching cannot diverge (the Kelvin-sign case).
import { foldForGate } from "./identity-scrub.mjs";

// ── loom-workspace name set (DERIVED, not literal) ──────────────────
// #673-A2: section 1 below used to match ONLY `workspaces/multi-cli-coc/…`,
// so a real `--build py` emission shipped `workspaces/multi-operator-coc/…`
// (and every other loom workspace) VERBATIM to a BUILD repo — proven live in
// rules/knowledge-convergence.md. The fix derives the workspace name set from
// loom's LIVE `workspaces/` dir (resolved relative to THIS module, NOT cwd, so
// it works under the worktree the strip runs in), covering EVERY current loom
// workspace + any future one with zero literal-list drift. The strip runs at
// loom (during /sync-to-build + /sync-to-use), where `workspaces/` always
// exists. A name present in `workspaces/` is — by construction — a loom-internal
// workspace; an instructional / synthetic example name (`workspaces/my-project/`,
// `workspaces/acme-cust-engagement-q3/`) is NOT in the set and ships verbatim.
// This is the "provably scoped to loom-internal workspaces" guarantee: BUILD
// repos (kailash-py/rs) do not contain loom workspaces, so a derived match is
// always strip-eligible.
//
// The canonical loom-internal workspace names. These are the long-lived set the
// selftest fixtures pin as strip-eligible (and the #673-A2 proven-leak classes).
// They are ALWAYS in the alternation, in EVERY repo, so the shipped fixtures and
// the known-leak classes can never silently stop stripping.
const CANONICAL_LOOM_WS = [
  "multi-cli-coc",
  "multi-operator-coc",
  "ecosystem-operating-model",
  "sync-upflow",
];

/**
 * Read `.claude/VERSION::type`. ABSENT → null, and callers MUST treat null as
 * "not loom" (fail closed toward the canonical set). PRESENT BUT UNPARSEABLE
 * or missing a string `type` → THROW (F7, 2026-10-04): reading a CORRUPT class
 * marker as "not loom" silently disables every loud-at-loom path — the exact
 * silent-fallback shape this module's ledger check refuses elsewhere.
 */
function readRepoClass(repoRoot) {
  const p = path.join(repoRoot, ".claude", "VERSION");
  let rawText;
  try {
    rawText = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(
      `readRepoClass: .claude/VERSION at ${p} is PRESENT but unparseable (${e.message}) — ` +
        'refusing to read a corrupt class marker as "not loom".',
    );
  }
  if (parsed && typeof parsed.type === "string") return parsed.type;
  throw new Error(
    `readRepoClass: .claude/VERSION at ${p} carries no string \`type\` — ` +
      'refusing to read a corrupt class marker as "not loom".',
  );
}

// Derivation from the live `workspaces/` dir is only VALID AT LOOM, where every
// name in `workspaces/` is by construction a loom-internal workspace. This module
// SHIPS (`action: copy, reason: always_include` on the py / rs / base lanes), so
// it also runs at BUILD repos and downstream consumers — and THERE that directory
// holds the CONSUMER's own workspaces, whose names are not loom-internal at all.
// Deriving there both over-stripped the consumer's real paths (rewriting them to
// "(loom-internal reference)") and, because the old `dirs.length > 0 ? dirs :
// FALLBACK` REPLACED the canonical names rather than adding to them, silently
// under-stripped every canonical loom name to zero.
//
// ── loom#1930: the live directory is not a sound floor, and cannot be one ──
// A previous revision of this comment claimed the union guaranteed that "an
// archived/renamed loom workspace must not drop its name out of the alternation".
// It did not, and the claim is withdrawn rather than softened. The union floor
// was only the four hardcoded CANONICAL names, so `git mv workspaces/X
// workspaces/_archive/X` removed X from the top-level listing and therefore from
// the alternation — text that stripped before the archive shipped verbatim after.
// Measured on this tree: 7 names in `workspaces/` git history were absent from the
// live top-level listing, and `workspaces/_archive/` held 7 more the walk never
// reached because it was one level deep.
//
// Worse, a whole class of names is UNDERIVABLE from loom at all. The two leaks
// found in the shipped `.codex/`/`.gemini/` trees — `workspaces/use-feedback-triage/…`
// and `workspaces/issue-781-todo-nnn-cleanup/` — are not loom workspaces and never
// were; `git log --all --name-only -- workspaces/` returns neither, against a
// control that DID return `multi-cli-coc` on the same query. They arrived inside
// artifacts synced in from BUILD/USE repos where those workspaces existed. No
// live-directory, git-history or filesystem derivation at loom can produce a name
// loom never had.
//
// So the floor is a COMMITTED, APPEND-ONLY manifest (`loom-workspace-names.json`),
// which cannot shrink between a clone and an emit and can hold foreign names, and
// the live arms are ADDITIVE convenience on top of it — they fence a brand-new
// workspace the moment it exists, before anyone remembers to record it. Git
// history was measured and rejected as a RUNTIME source: it does not contain the
// foreign names, and it needs a subprocess that returns less under a shallow clone
// (a source that can silently return LESS is the failure class being fixed). It is
// used once, to SEED the manifest.
//
// The manifest arm is NOT gated on repo class. Its names are loom/BUILD-internal
// by construction — a downstream consumer does not own a workspace called
// `multi-operator-coc` — so applying it everywhere strips more and over-strips
// nothing. Only the LIVE arms stay loom-gated, because THERE the directory holds
// the consumer's own names.
const WS_MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "loom-workspace-names.json",
);

/**
 * Read the committed append-only name ledger. Returns `{strip, preserve}`.
 *
 * Fails CLOSED toward the hardcoded canonical floor on any read/parse error:
 * a missing or corrupt manifest must never widen what ships, and must never
 * silently disable the fence.
 */
export function readWorkspaceNameManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WS_MANIFEST_PATH, "utf8"));
    const arr = (v) =>
      Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.length) : [];
    return { strip: arr(parsed.strip), preserve: arr(parsed.preserve) };
  } catch {
    return { strip: [], preserve: [] };
  }
}

/**
 * Enumerate live workspace dirs AT LOOM ONLY — top level PLUS one level inside
 * `workspaces/_archive/`, which the pre-loom#1930 walk never descended into.
 * Returns [] anywhere that is not a `coc-source` checkout.
 */
export function liveLoomWorkspaceDirs() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  if (!isLoomSourceTree()) return [];
  const wsRoot = path.join(repoRoot, "workspaces");
  const readDirNames = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
  const top = readDirNames(wsRoot);
  // One level deeper for the archive tree. Archived workspaces are exactly the
  // ones that fall out of the top-level listing, so this arm is what makes the
  // live half stop shrinking on `git mv … _archive/`.
  const archived = readDirNames(path.join(wsRoot, "_archive"));
  return [...top, ...archived];
}

function deriveLoomWorkspaceDirs() {
  return [
    ...new Set([
      ...CANONICAL_LOOM_WS, // hardcoded floor — always present, every repo
      ...readWorkspaceNameManifest().strip, // committed append-only floor
      ...liveLoomWorkspaceDirs(), // additive, loom-only, incl. _archive/*
    ]),
  ];
}

// Longest-first, for DETERMINISM. An earlier draft of this comment claimed the
// sort was what stopped a strict-prefix name (`sync` vs `sync-upflow`) from
// half-matching and leaving `-upflow/…` as residue. That claim was MEASURED and
// is FALSE: regex alternation backtracks, so when `sync` matches but the
// following `(?:\/…)` group then fails against `-upflow`, the engine retries the
// remaining alternatives and the longer name matches anyway. Removing this sort
// reds nothing (mutation M5) — a fact recorded here rather than left implied,
// because a comment asserting a guarantee the code does not provide is exactly
// the defect loom#1930 was opened on, twenty lines above this one.
//
// What the sort DOES buy: a stable alternation independent of `Set` insertion
// order, which otherwise varies with the manifest's file order and the live
// directory listing. The emitted trees are byte-compared by
// `check-cli-emit-drift.mjs`, so a nondeterministic rewrite order is a real
// (if latent) source of phantom drift. Kept on that ground, not the other one.
const LOOM_WS_ALT = deriveLoomWorkspaceDirs()
  .sort((a, b) => b.length - a.length || a.localeCompare(b))
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // regex-escape each dir
  .join("|");

/** The ONE loom-source predicate (Tier-1, 2026-10-04): readRepoClass on THIS
 * module's checkout. One predicate, one meaning. Callers, MEASURED at the r4
 * handover (the earlier "and nothing else" was already false when written) —
 * all three INSIDE this module, SYMBOL-anchored (line numbers rotted here once
 * already, security read): the workspace-name derivation
 * (`liveLoomWorkspaceDirs`), the ledger-missing fence inside
 * `assertNoUnclassifiedWorkspaceRef`, and the scan-selftest scoping probe;
 * outside it, only the audit-fixture scanner runner. NOTE: the identity
 * GATES do NOT arm on this predicate — they arm on the CONFIG
 * (`privateOrgSlugs()` non-empty), so deleting `.claude/VERSION` cannot disarm
 * them (Tier-1 r4 ruling). */
export function isLoomSourceTree() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  return readRepoClass(repoRoot) === "coc-source";
}

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
 * call `assertPrivateOrgConfig()` before they distribute; the scanner and
 * coc-manifest imports NEVER throw on a missing config.
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
    rawText = fs.readFileSync(identityPath, "utf8");
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
      // redactPrivateIdentity: this throw runs INSIDE orgSets() (the memo is
      // not yet set), and redactPrivateIdentity resolves the slug set via
      // orgSets — MEASURED as unbounded mutual recursion ("Maximum call stack
      // size exceeded") on the malformed-config pole.
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
/** DISTRIBUTION-TIME assertion (F1/F4): the entrypoints call this before they
 * distribute; a missing or empty private set HALTS loudly there — the one
 * place the guarantee may not silently degrade. */
export function assertPrivateOrgConfig() {
  const slugs = privateOrgSlugs();
  if (slugs.length === 0) {
    throw new Error(
      "the PRIVATE org-slug set is EMPTY at distribution time (canon-identity-values.json absent, " +
        "unreadable, or holds no private_org_slugs) — refusing to distribute a tree whose private-slug " +
        "gate would be vacuous.",
    );
  }
  return slugs;
}

// ── THE ONE SHARED IDENTITY GATE (Tier-1 r4, 2026-10-04) ────────────────────
// EVERY place content leaves loom runs `assertTreeFreeOfPrivateIdentity` on the
// FINAL output tree, after all enrichment (Gate-2 --finalize, emit-cli-artifacts,
// edition-emit, publish-to-private-template, publish-to-public,
// fork-conference-pack, and the delivery engine itself). The guarantee covers
// what is WRITTEN, not what the writer intended.
//
// THE SCAN: every file's bytes — a RAW pass (latin1 preserves bytes 1:1, then
// ASCII-only lowercase) PLUS, on any file carrying a non-ASCII byte, a FOLDED
// pass through the SAME `foldForGate` the redactor uses (MED-1; a compatibility
// spelling in CONTENT evaded the raw pass entirely), EVERY path component (file
// names, directory names, the root's own name), and every symlink's target
// string. An UNREADABLE entry — directory, file, link, or an entry that is
// neither — HALTS: an unscannable path is never a clean one. The only exemption
// is an ABSENT top-level root (a delivery that wrote nowhere). `.git` internals
// are skipped (VCS storage, not delivered content).
//
// STATED LIMIT: the raw pass is a BYTE, ASCII-CASE test, and the fold covers
// compatibility spellings of the values in the set; NEITHER sees encoded
// spellings (percent-, base64-, \u-escaped), compressed content (zip/gz), or
// UTF-16 (NUL-interleaved) text. The PATH half remains raw-only: a path
// component spelled with a compatibility character is not folded. TWO FURTHER
// LIMITS, probe-confirmed and stated rather than closed: a value SPLIT ACROSS A
// LINE BREAK is not matched (every pass tests CONTIGUOUS spans), and a
// CYRILLIC-HOMOGLYPH spelling is not folded (`foldForGate` folds compatibility
// forms via NFKD, never confusables). Those limits are out of scope for the
// byte contract and are covered, if at all, by the rewrites — never by this
// gate's silence.
const PRIVATE_IDENTITY_MAX_REPORTED = 20;
// Per-value replacement cap for `redactPrivateIdentity`'s folded pass. At the
// cap the redactor REFUSES (returns a masked count) rather than returning a
// partially-masked string whose remainder prints raw (LOW-4).
const REDACTION_MAX_PER_VALUE = 1000;
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The POSITIVE fork-identity verdict (r4-v3 ruling; pure, so the per-exit
 * suite drives every pole). No canon-derived data: the fork's OWN origin org
 * must be COVERED by its declared org values. Fails closed on no remote, no
 * declared values, or no coverage. @returns {{ok: boolean, reason?: string}} */
/** The org a git remote URL belongs to — HOST-AWARE, because a GitHub-style
 * `host/org/repo` path satisfies a last-two-segments read while an Azure DevOps
 * remote keeps its org somewhere else entirely:
 *   https://dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
 *   git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
 *   https://<org>.visualstudio.com/<project>/_git/<repo>
 * The last-two read returned `_git` for those forms, so EVERY ADO fork was
 * refused — fail-closed, but wrong.
 * @returns {{org: string|null, unknown: string|null}} `org` when the URL names
 * one; otherwise `unknown` says why no org can be derived (the verdict treats
 * that as UNKNOWN and refuses rather than inventing an org). */
function remoteOrgFromUrl(remoteUrl) {
  const raw = String(remoteUrl || "").trim().replace(/\.git$/i, "");
  if (!raw) return { org: null, unknown: "no resolvable origin remote is configured" };
  // LOCAL PATH / file:// — no host, so no org. Reading one out of a PARENT
  // DIRECTORY NAME made a copied canon declaration PASS whenever the clone sat
  // under a canon-org-named directory, and a correct client-only declaration
  // FAIL there — MEASURED both ways. The check would thereby vouch for the very
  // copy it exists to be suspicious of, so a local path is UNKNOWN, never a
  // parsed org.
  if (/^(?:file:\/\/|[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|~[\\/])/.test(raw)) {
    return { org: null, unknown: "origin is a LOCAL path — no host, so no org can be derived" };
  }
  const rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const scp = /^([^/@\s]+@)?([^/:\s]+):(.+)$/.exec(rest); // scp-like `user@host:path`
  let host;
  let pathPart;
  if (scp) {
    host = scp[2];
    pathPart = scp[3];
  } else {
    const slash = rest.indexOf("/");
    host = slash === -1 ? rest : rest.slice(0, slash);
    pathPart = slash === -1 ? "" : rest.slice(slash + 1);
  }
  host = host.replace(/^[^@/]*@/, "").toLowerCase(); // drop any userinfo
  const segs = pathPart.split("/").filter(Boolean);
  let org = null;
  // ssh.dev.azure.com ALSO ends with `.dev.azure.com`, so it is tested first.
  if (host === "ssh.dev.azure.com") org = segs[0] === "v3" ? segs[1] : segs[0];
  else if (host === "dev.azure.com" || host.endsWith(".dev.azure.com")) org = segs[0];
  else if (host.endsWith(".visualstudio.com")) org = host.slice(0, -".visualstudio.com".length);
  else org = segs.length >= 2 ? segs[segs.length - 2] : null;
  // `_git` is ADO's vendor segment, never an org — refuse to read it as one.
  if (!org || String(org).startsWith("_")) {
    return { org: null, unknown: "origin does not resolve to an org (unrecognized remote shape)" };
  }
  return { org: String(org).trim().toLowerCase(), unknown: null };
}

/** A MANUAL SANITY CHECK — deliberately NOT a gate, and called from no
 * entrypoint (only the `--assert-fork-identity-derived` CLI below). It answers
 * one question: does the declaration's PRIVATE org list include the org derived
 * from THIS clone's own `origin`?
 *
 * IT TRUSTS `origin`, and without canon data it CANNOT detect a copied canon
 * declaration: if `origin` points into canon's org (the client-template repo,
 * or a path that merely looks like it), a copied declaration passes and a
 * correct client-only one fails — MEASURED both ways. The enforced fence is the
 * distribution-time identity gate over the WRITTEN tree; this is a checklist
 * item a human runs. A local-path or otherwise unparseable remote is UNKNOWN
 * and refuses.
 * @returns {{ok: boolean, unknown?: boolean, reason?: string}} */
export function forkIdentityDerivedVerdict({ remoteUrl, declared }) {
  const { org: remoteOrg, unknown } = remoteOrgFromUrl(remoteUrl);
  const set = [...new Set((declared || []).map((x) => String(x).trim().toLowerCase()))];
  if (unknown) {
    return {
      ok: false,
      unknown: true,
      reason: `UNKNOWN — ${unknown}; this manual check cannot verify the declaration here (values withheld)`,
    };
  }
  if (!set.length) {
    return { ok: false, reason: "canon-identity-values.json declares no orgs — nothing covers this fork's own identity (fail closed)" };
  }
  if (!set.includes(remoteOrg)) {
    return {
      ok: false,
      reason:
        "this fork's OWN origin org is NOT among its declared org values (values withheld) — the declaration " +
        "does not describe this fork (a pasted-canon or otherwise wrong identity would gate the wrong set)",
    };
  }
  return { ok: true };
}

/** Replace every case-variant of each private slug with `<PRIVATE-ORG>` — for
 * every message, selftest diff and path string a human or a log will read. */
export function redactPrivateIdentity(text, slugs = null) {
  let s = String(text ?? "");
  // F6b (security read): LONGEST-FIRST. Replacing a short slug that is a
  // PREFIX of a longer one leaves the longer one's tail unmasked (short slug
  // first renders `<PRIVATE-ORG>-<tail>`, never a whole-span mask); the
  // longer match must consume the span first.
  const ordered = [...(slugs || privateOrgSlugs())].sort((a, b) => String(b).length - String(a).length);
  for (const slug of ordered) {
    // Pass 1: exact case-insensitive spans.
    s = s.replace(new RegExp(escapeRx(slug), "gi"), "<PRIVATE-ORG>");
    // Pass 2 (F6e): FOLDED spans. The scanner matches through `foldForGate`
    // (NFKD + mark-strip + lowercase — the U+212A Kelvin case), while `/i`
    // alone does NOT fold compatibility spellings, so a Kelvin-spelled value
    // was caught by the gate but NOT masked here. Fold per character with a
    // recorded source index so a folded match maps back to raw bytes.
    const fSlug = foldForGate(slug);
    if (!fSlug) continue;
    const refold = () => {
      let folded = "";
      const map = [];
      for (let i = 0; i < s.length; i += 1) {
        const ch = foldForGate(s[i]);
        for (let k = 0; k < ch.length; k += 1) { folded += ch[k]; map.push(i); }
      }
      return { folded, map };
    };
    let applied = 0;
    for (let guard = 0; guard < REDACTION_MAX_PER_VALUE; guard += 1) {
      const { folded, map } = refold();
      const at = folded.indexOf(fSlug);
      if (at === -1) break;
      const start = map[at];
      const end = map[at + fSlug.length - 1] + 1;
      s = s.slice(0, start) + "<PRIVATE-ORG>" + s.slice(end);
      applied += 1;
    }
    // LOW-4: at the cap the loop used to STOP silently, leaving every remaining
    // occurrence RAW for whatever caller prints the return value. Refuse
    // instead: a masked COUNT, and never any raw bytes.
    if (applied >= REDACTION_MAX_PER_VALUE) {
      return `<redaction-incomplete: ${applied} span(s) masked for one value, cap of ${REDACTION_MAX_PER_VALUE} reached — output withheld>`;
    }
  }
  return s;
}
/** Folded occurrences of `fSlug` in `text`, returned as RAW [start,end) ranges.
 * Built on the SAME per-character `foldForGate` mapping the redactor uses, so
 * the scanner and the redactor cannot disagree on a compatibility spelling
 * again (one fold, both sides). @returns {Array<[number, number]>} */
function foldedRawRanges(text, fSlug) {
  const folded = [];
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = foldForGate(text[i]);
    for (let k = 0; k < ch.length; k += 1) {
      folded.push(ch[k]);
      map.push(i);
    }
  }
  const hay = folded.join("");
  const out = [];
  let at = hay.indexOf(fSlug);
  while (at !== -1) {
    out.push([map[at], map[at + fSlug.length - 1] + 1]);
    at = hay.indexOf(fSlug, at + 1);
  }
  return out;
}

export function scanTreeForPrivateIdentity(root, slugs = null, onlyPaths = null) {
  const set = slugs || privateOrgSlugs();
  const out = { total: 0, hits: [], unreadable: [], absent: false, root: path.resolve(String(root)) };
  if (!fs.existsSync(out.root)) {
    out.absent = true; // ONLY an absent TOP-LEVEL root is exempt
    return out;
  }
  const test = (s, label) => {
    const low = String(s).toLowerCase();
    for (const slug of set) {
      let idx = low.indexOf(slug);
      while (idx !== -1) {
        out.total += 1;
        if (out.hits.length < PRIVATE_IDENTITY_MAX_REPORTED) out.hits.push(label);
        idx = low.indexOf(slug, idx + 1);
      }
    }
  };
  const bytes = (buf, rel) => {
    const low = buf.toString("latin1").toLowerCase();
    for (const slug of set) {
      let idx = low.indexOf(slug);
      while (idx !== -1) {
        out.total += 1;
        if (out.hits.length < PRIVATE_IDENTITY_MAX_REPORTED) {
          out.hits.push(`${rel}:${low.slice(0, idx).split("\n").length}`);
        }
        idx = low.indexOf(slug, idx + 1);
      }
    }
    // FOLDED pass (MED-1). The comments around this scan claimed the content
    // path matched through `foldForGate` while it actually ran ASCII lowercase
    // only — so a COMPATIBILITY spelling in CONTENT (U+212A Kelvin, fullwidth)
    // was caught by the redactor but NOT by the scan: MEASURED, a fullwidth
    // value in a file produced total 0. Both sides now use the ONE fold.
    // Cheap gate first: with no non-ASCII byte, folding cannot change a match.
    if (!/[^\x00-\x7f]/.test(low)) return;
    const text = buf.toString("utf8");
    for (const slug of set) {
      const fSlug = foldForGate(slug);
      if (!fSlug) continue;
      for (const [start, end] of foldedRawRanges(text, fSlug)) {
        const rawSlice = text.slice(start, end);
        // A plain ASCII spelling was already counted by the pass above.
        if (!/[^\x00-\x7f]/.test(rawSlice) && rawSlice.toLowerCase() === slug) continue;
        out.total += 1;
        if (out.hits.length < PRIVATE_IDENTITY_MAX_REPORTED) {
          out.hits.push(`${rel}:${text.slice(0, start).split("\n").length}`);
        }
      }
    }
  };
  const oneEntry = (rel, abs) => {
    // Path COMPONENTS first (every component, case-insensitively), then the
    // entry itself: symlink target string, file bytes, or — for a directory the
    // run wrote — the full walk beneath it.
    test(rel, `${rel} (name)`);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (e) {
      if (e && e.code === "ENOENT") return; // a planned path that is GONE (purged/retired this run)
      out.unreadable.push(`${rel}: ${e.code || e.message}`);
      return;
    }
    if (st.isSymbolicLink()) {
      try {
        test(fs.readlinkSync(abs), `${rel} (symlink target)`);
      } catch (err) {
        out.unreadable.push(`${rel}: ${err.code || err.message}`);
      }
      return;
    }
    if (st.isDirectory()) {
      walk(abs);
      return;
    }
    if (!st.isFile()) {
      out.unreadable.push(`${rel}: not a regular file, directory or symlink`);
      return;
    }
    try {
      bytes(fs.readFileSync(abs), rel);
    } catch (err) {
      out.unreadable.push(`${rel}: ${err.code || err.message}`);
    }
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      out.unreadable.push(`${dir}: ${e.code || e.message}`);
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rel = path.relative(out.root, p) || e.name;
      // VCS storage, not delivered content. The root entry is skipped when it is
      // EITHER a `.git/` directory OR the `.git` gitlink FILE a linked worktree
      // carries: the gitlink's content is `gitdir: <path>`, and a worktree stored
      // under a path carrying the value produced a FALSE POSITIVE (security read).
      // The rule stays NARROW — root only, exact name — so a `.git` file deeper in
      // the tree (a delivered artifact that happens to be named that) is still
      // scanned.
      if ((e.isDirectory() || e.isFile()) && e.name === ".git" && dir === out.root) continue;
      if (e.isDirectory()) {
        test(rel, `${rel} (name)`);
        walk(p);
        continue;
      }
      oneEntry(rel, p);
      if (e.isSymbolicLink()) continue;
      // oneEntry already handled bytes/links; a directory re-entry is impossible here.
    }
  };
  if (onlyPaths) {
    // WRITTEN-PATHS MODE (the delivery engine): scan exactly what THIS RUN
    // wrote — each planned path's components and bytes — never the whole
    // destination clone (a BUILD target legitimately names its own org; a live
    // clone carries unrelated content). A planned path that no longer exists is
    // SKIPPED (this run purged/retired it — nothing was written there to leak);
    // anything READABLE but unreadable-ERRORING halts.
    for (const p of onlyPaths) {
      const abs = path.isAbsolute(p) ? p : path.join(out.root, p);
      const rel = path.relative(out.root, abs) || path.basename(abs);
      if (rel.startsWith("..")) {
        out.unreadable.push(`${p}: outside the output root`);
        continue;
      }
      oneEntry(rel, abs);
    }
    return out;
  }
  test(path.basename(out.root), `${path.basename(out.root)} (root name)`);
  walk(out.root);
  return out;
}
/** THROWING wrapper — the one call every exit makes. Returns the scan result
 * (with `absent: true`) when clean; throws with a REDACTED message naming the
 * first hits by file:line / path-component when not. `onlyPaths` restricts the
 * scan to what a run WROTE (the engine's mode); absent, the whole tree under
 * `root` is scanned (fresh staging/emission trees). */
export function assertTreeFreeOfPrivateIdentity(root, { slugs = null, label = null, onlyPaths = null } = {}) {
  const set = slugs || privateOrgSlugs();
  const r = scanTreeForPrivateIdentity(root, set, onlyPaths);
  if (r.absent) return r;
  const rid = (s) => redactPrivateIdentity(s, set);
  if (r.unreadable.length) {
    throw new Error(
      `PRIVATE-IDENTITY GATE: ${r.unreadable.length} UNREADABLE entr(ies) under ${rid(r.root)} — ` +
        `an unscannable path is never a clean one; halting. First: ${r.unreadable.slice(0, 5).map(rid).join(" | ")}`,
    );
  }
  if (r.total > 0) {
    throw new Error(
      `PRIVATE-IDENTITY DISCLOSURE — ${r.total} occurrence(s) as raw bytes or path components ` +
        `(case-insensitive substring; value withheld): first: ${r.hits.map(rid).join(", ")}` +
        `${r.total > r.hits.length ? " …(+more)" : ""}` +
        // L3 (security read): the label is caller-supplied — mask it like every
        // other printed component, so a caller that ever builds a label from a
        // path cannot print the value through this channel.
        `${label ? ` — ${rid(label)}` : ` — under ${rid(r.root)}`}`,
    );
  }
  return r;
}

/** A DERIVED-slug rewrite entry (3a–3e + 3c). The pattern compiles LAZILY, on
 * first use, from the one private alternation; while that alternation is empty
 * (a consumer) it is a never-matching byte — no private slugs means no
 * private-slug rewrites, and the DELIVERY GATE is the guarantee either way. */
const DERIVED_RULE_NEVER = /$a/g;
let _privateAlt = null;
function privateAlt() {
  if (_privateAlt === null) {
    _privateAlt = privateOrgSlugs()
      .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .join("|");
  }
  return _privateAlt;
}
const derivedRule = (rxTemplate, replacement, desc) => ({
  get pattern() {
    const alt = privateAlt();
    return alt ? new RegExp(rxTemplate.replace("%ALT%", alt), "gi") : DERIVED_RULE_NEVER;
  },
  replacement,
  desc,
  buildSafe: true,
});

const REWRITES = [
  // ── 1. loom-internal workspace paths ────────────────────────────
  // `workspaces/<loom-internal-ws>/...` in backticks (path-context only).
  // The workspace name set is DERIVED from loom's live workspaces/ dir
  // (LOOM_WS_ALT above) so EVERY current loom workspace is covered, not just
  // the historical multi-cli-coc literal (#673-A2).
  //
  // loom#1930 — the subpath is OPTIONAL. The pre-1930 form required `\/[^`\s]+`,
  // i.e. at least one character AFTER the separating slash, so BOTH
  // `` `workspaces/<ws>/` `` (trailing slash, no subpath) and
  // `` `workspaces/<ws>` `` (bare name) escaped the fence entirely. The live
  // CRITICAL leak in the shipped `.codex/`/`.gemini/` trees was exactly the
  // first shape:
  //   - Workspace plan + per-shard disposition catalogs at `workspaces/issue-781-todo-nnn-cleanup/`
  // This is the same omission the `packages/` family needed two dedicated
  // rewrites for (5d/5e below, "BUILD packages/ dir, no subpath"); the workspace
  // equivalent was simply never added. Here it folds into one optional group
  // rather than a third rule, because a BACKTICKED token is unambiguously a path
  // reference — there is no prose-vs-path judgment to make inside code fences,
  // which is exactly why the bare form (pattern 2) still needs one.
  {
    pattern: new RegExp(
      "`[Ww]orkspaces\\/(?:" + LOOM_WS_ALT + ")(?:\\/[^`\\s]*)?`", // sentence-case too
      "g",
    ),
    replacement: "(loom-internal reference)",
    desc: "loom workspace path (backticked)",
    buildSafe: true, // #673 — loom-internal workspace path; strip on BUILD too
  },
  // bare workspaces/<loom-internal-ws>/<something> in prose.
  //
  // TWO delimiters, not one (loom#1914). The separator between the workspace
  // NAME and the rest of the path is `/` in the well-formed case — but a path
  // written with a SPACE there (`workspaces/multi-operator-coc 02-plans/…`) is
  // the same disclosure and evaded this fence entirely. Measured on loom's own
  // emitted `.codex/`/`.gemini/` trees: four surviving leaks, all of that one
  // shape, all reaching the emitted output the strip had already run over. A
  // fence a typo walks through is not a fence, so the delimiter is widened
  // here rather than the four source typos being corrected — correcting the
  // instances leaves the CLASS live for the next one.
  //
  // The whitespace arm is SCOPED so it cannot swallow prose. The pre-loom#1930
  // scoping was "the continuation must contain a `/`", which is NOT a path test
  // — ordinary English prose is full of slashed tokens. Measured, all four
  // consumed the token and mangled the sentence:
  //   "See workspaces/multi-cli-coc and/or the sync workspace."
  //     → "See (loom-internal reference) the sync workspace."   ← "and/or" eaten
  //   ... CI/CD notes.  → "(loom-internal reference) notes."
  //   ... 24/7 coverage. → "(loom-internal reference) coverage."
  //   ... TCP/IP details. → "(loom-internal reference) details."
  // An over-strip is not the harmless direction: it silently deletes words from
  // shipped instructions, and unlike an under-strip nothing downstream greps for
  // it. The old negative fixture (`preserve-workspace-name-followed-by-prose`)
  // used prose with NO slash, so it never touched this boundary and passed
  // throughout.
  //
  // The tightened test is FILE-shaped or DIRECTORY-shaped, not merely
  // slash-bearing: the continuation must either end in a dot-extension
  // (`02-plans/01-architecture.md`) or terminate at the slash with nothing
  // path-like after it (`02-plans/` at end of token). `and/or`, `CI/CD`, `24/7`
  // and `TCP/IP` satisfy neither, because a bare word after the slash is a word.
  //
  // THREE arms now, not two (loom#1930):
  //   1. `/<subpath>`  — the well-formed case.
  //   2. `/` with nothing path-like after — the trailing-slash directory form,
  //      which arm 1 could never match because it requires ≥1 subpath char. `*`
  //      is in the negative lookahead so glob forms (`workspaces/<ws>/**` in
  //      `paths:` frontmatter and CI path filters) stay load-bearing verbatim —
  //      the same carve-out rule 5e makes for `packages/`.
  //   3. whitespace-delimited, scoped as above.
  //   4. the bare NAME closed by punctuation or end of line —
  //      `(workspaces/<ws>, brief directive #1)`, `… see workspaces/<ws>.` — the
  //      no-slash form, which none of arms 1–3 reach (each needs a `/` or a
  //      path-shaped continuation) while `workspaceRefNames` — the fence's own
  //      ASSERTION — matches it, so the assert refused output the rewrite had
  //      just passed. Measured 2026-09-04 on the fork-conference docket: three
  //      names in this shape, every one already in the ledger's `strip` list.
  //      A space followed by an opening paren (`workspaces/<ws> (receipt …)`) is
  //      the same shape. Space-then-word stays preserved (the compliant pole
  //      below): a name used as an adjective in prose is not a path.
  // Every arm is pinned by a fixture pair below, violation pole AND compliant
  // pole, so a future widening that re-breaks prose reds here.
  {
    pattern: new RegExp(
      "\\b[Ww]orkspaces\\/(?:" + // sentence-case too (measured: "Workspaces/<name>/…" reached an item title)
        LOOM_WS_ALT +
        ")(?:" +
        "\\/[A-Za-z0-9_./\\-]+" +
        "|\\/(?![A-Za-z0-9_.*/\\-])" +
        "|[ \\t]+[A-Za-z0-9_.\\-]+\\/(?:[A-Za-z0-9_.\\-/]*\\.[A-Za-z0-9]+|(?![A-Za-z0-9_.*/\\-]))" +
        "|(?=[,;:)\\]]|\\.(?:\\s|$)|[ \\t]+\\(|$)" +
        ")",
      "gm",
    ),
    replacement: "(loom-internal reference)",
    desc: "loom workspace path (bare)",
    buildSafe: true, // #673 — loom-internal workspace path; strip on BUILD too
  },

  // ── 2. sibling-SDK workspaces/ prefixes ─────────────────────────
  // `kailash-{py,rs,prism}/workspaces/...` in backticks
  {
    pattern: /`kailash-(?:py|rs|prism)\/workspaces\/[^`]*`/g,
    replacement: "workspace artifacts",
    desc: "sibling SDK workspaces/ (backticked)",
    buildSafe: true, // #673 — loom-internal workspace-path class; strip on BUILD too
  },

  // ── 3a–3e. DERIVED-slug PATH-PREFIX forms (Tier-1, 2026-10-04) ──
  // PRIVATE slugs ONLY (the canonical-identity set): the PUBLIC org is where
  // these templates LIVE, and naming it in clone URLs or runner endpoints is
  // CORRECT — that naming is never rewritten. The previous ANY-ORG context arms
  // (gh api repos/<any>/kailash-…") were REMOVED with the same ruling: the
  // guarantee is the DELIVERY GATE (sync-tier-aware asserts ZERO occurrences of
  // every private slug in the delivered tree), so the rewrites are best-effort
  // hygiene in front of it and may be conservative without losing coverage.
  // OUT OF SCOPE (commit body): line-split tokens and URL-encoded spellings —
  // non-adjacent forms a regex over adjacent bytes cannot see; the GATE sees
  // them, because it scans raw substrings.
  derivedRule(`github\\.com\\/(?:%ALT%)(?![A-Za-z0-9-])`, "github.com/<org>", "private slug in a github.com URL"),
  derivedRule(`git@github\\.com:(?:%ALT%)(?![A-Za-z0-9-])`, "git@github.com:<org>", "private slug in an ssh remote"),
  derivedRule(`--repo\\s+(?:%ALT%)(?![A-Za-z0-9-])`, "--repo <org>", "private slug after --repo"),
  derivedRule(`raw\\.githubusercontent\\.com\\/(?:%ALT%)(?![A-Za-z0-9-])`, "raw.githubusercontent.com/<org>", "private slug in a raw URL"),
  derivedRule(`gh api repos\\/(?:%ALT%)\\/([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)`, "gh api repos/<org>/<repo>", "private slug, gh api repos with a non-kailash repo"),
  // correctness round (2026-10-04): the `repos/` CITATION form in every gh-api
  // spelling — `gh api -X GET repos/…`, the absolute `gh api /repos/…`, and the
  // bare path — plus `gh repo view <org>/<repo>`. Case-insensitive like all
  // derived rules; `<org>/repo#52` is BY DESIGN left alone (declared in the
  // commit body).
  derivedRule(`repos\\/(?:%ALT%)\\/([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)`, "repos/<org>/<repo>", "private slug, repos/ citation (any gh-api spelling)"),
  derivedRule(`gh repo view\\s+(?:%ALT%)\\/([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)`, "gh repo view <org>/<repo>", "private slug in gh repo view"),
  // The `orgs/<slug>` family in EVERY surface spelling the security re-run
  // listed (2026-10-04): `gh api orgs/…`, the absolute `gh api /orgs/…`,
  // `gh api -X GET orgs/…`, `github.com/orgs/…` and `api.github.com/orgs/…` —
  // one slug-anchored rule that preserves the surrounding call (the `-X GET`
  // and the leading `/` stay verbatim) and rewrites only the slug. The OTHER
  // spellings on the reviewer's list (`-R`, `--repo=`, `gh repo clone`,
  // `uses:`, `repo:`, `ghcr.io/`, JSON `"ORG/x"`) are NOT rewritten: the
  // rewrite is best-effort hygiene, and the DELIVERY GATE halts on any raw
  // occurrence regardless of what this pass recognized.
  derivedRule(`orgs\\/(?:%ALT%)(?![A-Za-z0-9-])`, "orgs/<org>", "private slug after orgs/ (any surface spelling)"),
  // ── 3c. bare PRIVATE slug — STANDALONE token only ───────────────
  // The standalone PRIVATE-slug token outside any path form shipped VERBATIM
  // (#673-A2: proven live at guides/rule-extracts/verify-resource-existence.md:100,
  // the backticked slug form). The lookahead `(?!/)` SCOPES this to the
  // standalone token: an org/repo PATH citation (`terrene-foundation/kailash`
  // — a public-org citation, or the J10 variant-source-hygiene shape) is
  // preserved; rules 3a–3e above consume the PRIVATE path forms, and
  // the DELIVERY GATE catches every remaining raw occurrence whatever its
  // spelling. `<org>` is slug-free so re-application is a fixed point.
  {
    get pattern() {
      const alt = privateAlt();
      return alt
        ? new RegExp(`\\b(?:${alt})(?![A-Za-z0-9-])(?!\\/)`, "gi")
        : DERIVED_RULE_NEVER;
    },
    replacement: "<org>",
    desc: "private slug (bare token)",
    buildSafe: true, // #673-A2 — private org slug; strip on BUILD too
  },

  // ── 4. BUILD packages/ paths (backticked) ───────────────────────
  // `packages/kailash-X/path/to/file` → the X package (`path/to/file`)
  {
    pattern: /`packages\/kailash-([a-z][a-z0-9_-]*)\/([^`]+)`/g,
    replacement: "the $1 package (`$2`)",
    desc: "BUILD packages/ path (backticked)",
  },

  // ── 5. BUILD packages/ paths (bare in prose) ────────────────────
  // packages/kailash-X/<rest>  →  the X package directory <rest>
  // Trailing punctuation (. , ; : ! ?) is kept outside the path.
  {
    pattern: /\bpackages\/kailash-([a-z][a-z0-9_-]*)\/([A-Za-z0-9_./\-]+)/g,
    replacement: "the $1 package directory $2",
    desc: "BUILD packages/ path (bare)",
  },

  // ── 5b. BUILD monorepo sub-package paths (backticked) ───────────
  // kailash-kaizen monorepo layout: `packages/kaizen-agents/<rest>`.
  // Non-kailash-prefixed BUILD sub-packages are an explicit family
  // allowlist (kaizen- today) — a generic `packages/<name>/` pattern
  // would corrupt consumer-project monorepo paths (see PRESERVED).
  // Replacement keeps the full package name (no prefix to drop),
  // matching the #475 R5 manual-rewording convention at source.
  {
    pattern: /`packages\/(kaizen-[a-z][a-z0-9_-]*)\/([^`]+)`/g,
    replacement: "the $1 package (`$2`)",
    desc: "BUILD monorepo packages/ path (backticked)",
  },

  // ── 5c. BUILD monorepo sub-package paths (bare in prose) ────────
  {
    pattern: /\bpackages\/(kaizen-[a-z][a-z0-9_-]*)\/([A-Za-z0-9_./\-]+)/g,
    replacement: "the $1 package directory $2",
    desc: "BUILD monorepo packages/ path (bare)",
  },

  // ── 5d. BUILD packages/ dir, trailing-slash no-subpath (backticked)
  // `packages/kailash-X/` / `packages/kaizen-X/` with NOTHING after
  // the slash (e.g. "- `packages/kailash-align/` -- Source code").
  // Patterns 4/4b require a subpath, so this form previously shipped
  // verbatim (#477 item 1 / #475 redteam R-1).
  {
    pattern: /`packages\/((?:kailash|kaizen)-[a-z][a-z0-9_-]*)\/`/g,
    replacement: (_m, pkg) =>
      `the ${pkg.startsWith("kailash-") ? pkg.slice("kailash-".length) : pkg} package directory`,
    desc: "BUILD packages/ dir, no subpath (backticked)",
  },

  // ── 5e. BUILD packages/ dir, trailing-slash no-subpath (bare) ───
  // Negative lookahead: no subpath character may follow. `*` is in the
  // excluded set so glob forms (`packages/kailash-dataflow/**` in
  // `paths:` frontmatter / CI path filters) stay load-bearing verbatim.
  {
    pattern:
      /\bpackages\/((?:kailash|kaizen)-[a-z][a-z0-9_-]*)\/(?![A-Za-z0-9_.*/\-])/g,
    replacement: (_m, pkg) =>
      `the ${pkg.startsWith("kailash-") ? pkg.slice("kailash-".length) : pkg} package directory`,
    desc: "BUILD packages/ dir, no subpath (bare)",
  },

  // ── 6. sibling-SDK .claude/ examples (descriptive cross-repo) ───
  // `kailash-{py,rs,prism}/.claude/<rest>` → the sibling SDK's `.claude/<rest>`
  {
    pattern: /`kailash-(?:py|rs|prism)\/(\.claude\/[^`]+)`/g,
    replacement: "the sibling SDK's `$1`",
    desc: "sibling SDK .claude/ example",
  },

  // ── 7. workspace-tree headers (`kailash-rs/` as top-of-tree label)
  // Matches `kailash-{py,rs,prism}/` only when followed by an ASCII
  // tree-drawing character or end-of-string (avoids consuming repo
  // names appearing in prose like "the kailash-rs/ repo"). Backticked
  // form only — bare prose mentions stay.
  {
    pattern: /`kailash-(?:py|rs|prism)\/`(?=\s*$|\s*[\n├└│─])/gm,
    replacement: "`<workspace-root>/`",
    desc: "workspace-tree header",
  },
];

// ────────────────────────────────────────────────────────────────
// PRESERVED (per Phase-4 strip contract — informative, not code)
// ────────────────────────────────────────────────────────────────
//   - `crates/kailash-*/` — illustrative for binding consumers describing
//     crate-level architecture (kailash-rs-alignment skill body relies on this)
//   - PyPI package names in dep specs: `kailash-dataflow>=2.0.3`, etc.
//     (public package identifiers users `pip install` directly)
//   - `kailash-{py,rs,prism}` repo names appearing in unstructured prose
//     (NOT followed by /workspaces/, /.claude/, or tree-character)
//   - Glob forms: `packages/kailash-X/**` / `packages/kaizen-X/**` (and any
//     `*` immediately after the package slash) — these are LOAD-BEARING in
//     `paths:` frontmatter of path-scoped rules/skills and in CI path
//     filters; `*` is excluded from every subpath char-class and from the
//     5e trailing-slash lookahead by design. Rewriting them would break
//     rule loading on the consumer side.
//   - Generic consumer monorepo paths: `packages/<name>/...` where <name>
//     is NOT kailash-/kaizen- prefixed (e.g. packages/my-app/src/). Consumer
//     projects legitimately use packages/ layouts; only the known BUILD
//     package families strip. New BUILD monorepo families extend the
//     explicit alternation (kailash|kaizen), never a wildcard.
// These patterns are intentionally NOT in REWRITES.

/**
 * stripBuildInternalReferences — apply BUILD-internal-path rewrites.
 *
 * @param {string} content  Source content (markdown/text).
 * @param {{buildMode?: boolean}} [opts]
 *   buildMode (#673) — when true, apply ONLY the `buildSafe` rewrites
 *   (loom workspace paths + canon org slug), leaving package/repo
 *   self-reference rewrites OFF so a BUILD repo's own `packages/<repo>`
 *   / `crates/<repo>` / sibling `.claude/` names ship verbatim. Default
 *   false = full USE-lane strip (every rewrite), back-compat with every
 *   single-arg caller (emit-cli-artifacts.mjs, the USE deploy path).
 * @returns {{stripped: string, applied: string[]}}
 *   stripped — content with the applicable REWRITES applied (idempotent).
 *   applied  — descriptions of which rewrite rules actually fired.
 */
export function stripBuildInternalReferences(content, { buildMode = false } = {}) {
  if (typeof content !== "string") {
    throw new TypeError(
      "stripBuildInternalReferences: content must be a string",
    );
  }
  let stripped = content;
  const applied = [];
  for (const rw of REWRITES) {
    // #673 BUILD-scoped subset: on the BUILD lane only the disclosure-class
    // (buildSafe) rewrites fire; package/repo self-reference rewrites are
    // skipped so the BUILD repo's own names survive verbatim.
    if (buildMode && !rw.buildSafe) continue;
    const { pattern, replacement, desc } = rw;
    const before = stripped;
    stripped = stripped.replace(pattern, replacement);
    if (stripped !== before && !applied.includes(desc)) applied.push(desc);
  }
  return { stripped, applied };
}

// ────────────────────────────────────────────────────────────────
// FAIL-CLOSED disclosure scan (loom#1930)
//
// The rewrites above can only strip names they KNOW. The CRITICAL leak was a
// pair of names loom could not know — `use-feedback-triage` and
// `issue-781-todo-nnn-cleanup` arrived inside artifacts synced in from BUILD/USE
// repos, and appear nowhere in loom's `workspaces/` directory or its git
// history. No derivation closes that class. Only a REFUSAL does.
//
// So after stripping, every surviving `workspaces/<name>` token must be
// CLASSIFIED: either it is in the manifest's `preserve` allowlist (an
// instructional placeholder, a reserved meta-dir, a metavariable — each verified
// in context) or the content does not ship. Unrecognized ⇒ REFUSE. That is the
// fail-closed direction: a new foreign workspace name becomes a loud build
// failure naming the file and the token, instead of two lines of somebody else's
// internal directory structure in a shipped skill.
//
// Deliberately NOT matched: a token preceded by `/`. `/workspaces/ml` and
// `path="/workspaces/data"` in the PACT examples are ABSOLUTE container paths
// inside unrelated code samples, not repo-relative workspace references. Fixing
// that in the MATCHER is correct; allowlisting `ml` and `data` would have bought
// the same green while leaving the matcher wrong for every future absolute path.
// ────────────────────────────────────────────────────────────────

/** Thrown by `assertNoUnclassifiedWorkspaceRef`. Typed so callers can tell a
 *  disclosure refusal from an I/O error and never conflate the two. */
export class WorkspaceDisclosureError extends Error {
  constructor(message, { file, names }) {
    super(message);
    this.name = "WorkspaceDisclosureError";
    this.code = "UNCLASSIFIED_WORKSPACE_REF";
    this.file = file;
    this.names = names;
  }
}

// Not preceded by `/` (absolute container paths are not repo workspace refs) and
// not preceded by a word char (so `myworkspaces/foo` does not match).
const WS_REF_RE = /(^|[^A-Za-z0-9_./-])[Ww]orkspaces\/([A-Za-z0-9_][A-Za-z0-9_.-]*)/g; // sentence-case too (measured: "Workspaces/<name>/…" shipped as an item title)

/**
 * Every distinct `workspaces/<name>` name referenced in `content`.
 * @returns {string[]} sorted, de-duplicated names.
 */
export function workspaceRefNames(content) {
  if (typeof content !== "string") return [];
  const out = new Set();
  for (const m of content.matchAll(WS_REF_RE)) out.add(m[2]);
  return [...out].sort();
}

/**
 * REFUSE content that still names an unclassified workspace after stripping.
 *
 * @param {string} content   post-strip content about to be written/shipped.
 * @param {{file?: string, preserve?: string[]}} [opts]
 * @throws {WorkspaceDisclosureError} fail-closed; nothing is written by design —
 *   this function performs no I/O, so a throwing caller has written nothing.
 */
export function assertNoUnclassifiedWorkspaceRef(content, opts = {}) {
  const { file = "<content>", preserve } = opts;

  // REPO-CLASS SCOPING, the same restriction the derivation already applies to
  // its live arm — and the reason this is not simply "fail closed on a missing
  // ledger". `loom-workspace-names.json` is `loom_only`: shipping the list of
  // names to be scrubbed would hand every consumer the inventory the scrub
  // exists to remove. So off loom the ledger is ABSENT BY DESIGN, and a bare
  // fail-closed read would make this refuse every `workspaces/<name>` token in
  // every consumer's own content — where those names are the CONSUMER's
  // workspaces, which they are entitled to keep and which loom has no standing
  // to classify.
  //
  // At loom the ledger MUST be present, so a failed read there is a real fault
  // and throws rather than silently disabling the scan. That is the distinction
  // that keeps this from being a silent fallback: absent-off-loom is by design,
  // absent-AT-loom is loud.
  if (preserve === undefined) {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const manifest = readWorkspaceNameManifest();
    const isLoom = isLoomSourceTree();
    if (!isLoom) return; // ledger absent by design; consumer owns its own names
    if (manifest.preserve.length === 0 && manifest.strip.length === 0) {
      throw new WorkspaceDisclosureError(
        "the workspace-name ledger .claude/bin/lib/loom-workspace-names.json is missing or " +
          "unreadable AT LOOM, where it is required. Refusing rather than emitting with the " +
          "disclosure fence's floor silently reduced to the hardcoded canonical names.",
        { file, names: [] },
      );
    }
  }

  const allowed = new Set(preserve ?? readWorkspaceNameManifest().preserve);
  const offenders = workspaceRefNames(content).filter((n) => !allowed.has(n));
  if (offenders.length === 0) return;
  throw new WorkspaceDisclosureError(
    `unclassified workspace reference(s) in ${file}: ` +
      offenders.map((n) => `workspaces/${n}`).join(", ") +
      "\nEach name must be CLASSIFIED in .claude/bin/lib/loom-workspace-names.json:\n" +
      "  - a real internal workspace  -> append to `strip` (it will be scrubbed)\n" +
      "  - an instructional placeholder / meta-dir / metavariable -> append to `preserve`\n" +
      "Refusing to emit rather than ship an unclassified internal path.",
    { file, names: offenders },
  );
}

// ────────────────────────────────────────────────────────────────
// Self-test fixtures — committed alongside the helper per
// rules/cc-artifacts.md Rule 9. Each fixture is structurally:
//   name:     short label
//   input:    raw content
//   expected: post-strip content
// Fail-loud on mismatch; CLI mode prints first 3 diff lines.
// ────────────────────────────────────────────────────────────────
// Fixture orgs are RUNTIME-DERIVED, never literals (Tier-1, 2026-10-04), and the
// WHOLE list is built LAZILY (Tier-1 round 2): a module-load-time derivation
// called orgSets() at import, so a PRESENT-but-malformed canon-identity
// declaration threw AT IMPORT — reintroducing exactly the F1 import-throw the
// lazy design removed. `buildSelfTestFixtures()` runs inside selftest() only.
// The no-config fallback keeps the SHAPE the armed patterns need, and the
// private-armed rows SKIP by explicit flag (`requiresConfig: true`).
function buildSelfTestFixtures() {
  const FIXTURE_ORG = privateOrgSlugs()[0] || "northwind-labs";
  // The PUBLIC org is what the templates LIVE IN and what clone/runner URLs
  // correctly name — the fixtures assert IDENTITY SURVIVAL for it, never a
  // rewrite (Tier-1 re-run, 2026-10-04: public ≠ private). Derived from the same
  // declaration (F5: no hard-coded public literal anywhere in the fixtures); the
  // no-config fallback is a SYNTHETIC placeholder, not a real org, so a
  // config-less consumer still exercises the survival shape without embedding
  // any org's name.
  const FIXTURE_PUBLIC_ORG = orgSets().public[0] || "example-public-org";
  return [
  {
    name: "derived-path-prefix-forms",
    requiresConfig: true,
    input:
      `See https://github.com/${FIXTURE_ORG}/loom and git@github.com:${FIXTURE_ORG}/x.git, ` +
      `run gh repo view --repo ${FIXTURE_ORG}/x, fetch raw.githubusercontent.com/${FIXTURE_ORG}/main/x.md, ` +
      `or gh api repos/${FIXTURE_ORG}/some-repo/issues. ` +
      `Also gh api -X GET repos/${FIXTURE_ORG}/some-repo, gh api /repos/${FIXTURE_ORG}/x, ` +
      `and gh repo view ${FIXTURE_ORG}/x.`,
    expected:
      "See https://github.com/<org>/loom and git@github.com:<org>/x.git, " +
      "run gh repo view --repo <org>/x, fetch raw.githubusercontent.com/<org>/main/x.md, " +
      "or gh api repos/<org>/<repo>/issues. " +
      "Also gh api -X GET repos/<org>/<repo>, gh api /repos/<org>/<repo>, " +
      "and gh repo view <org>/<repo>.",
  },
  {
    name: "derived-case-insensitive",
    requiresConfig: true,
    input: `See GitHub.com/${FIXTURE_ORG.toUpperCase()}/loom.`,
    // The rewrite emits the CANONICAL lowercase host + `<org>`: case folding
    // matches the input; the replacement normalizes it.
    expected: "See github.com/<org>/loom.",
  },
  {
    name: "derived-underscore-tail",
    requiresConfig: true,
    input: `The org token ${FIXTURE_ORG}_x appears here.`,
    expected: "The org token <org>_x appears here.",
  },
  {
    name: "loom-workspace-path-backticked",
    input:
      "See `workspaces/multi-cli-coc/02-plans/07-loom-multi-cli-spec-v6.md` for the spec.",
    expected: "See (loom-internal reference) for the spec.",
  },
  {
    name: "loom-workspace-path-bare",
    input: "Origin: workspaces/multi-cli-coc/journal/0042-DECISION.md cites this.",
    expected: "Origin: (loom-internal reference) cites this.",
  },
  // loom#1914 — the SPACE-delimited form that evaded the slash-only fence and
  // reached four files in loom's own emitted .codex/.gemini trees. Verbatim
  // shape of the measured leak (from .claude/commands/onboard.md:92).
  {
    name: "loom-workspace-path-space-delimited",
    input:
      "F14 M7 Shard E (workspaces/multi-operator-coc 02-plans/01-architecture.md §7.4) — read-path.",
    expected: "F14 M7 Shard E ((loom-internal reference) §7.4) — read-path.",
  },
  // The NEGATIVE pole of the same widening. Without this the fixture set above
  // is satisfied by a fence that strips everything after the workspace name,
  // which would eat prose. The following word has no `/`, so the whitespace
  // arm must NOT fire.
  {
    name: "preserve-workspace-name-followed-by-prose",
    input: "The workspaces/multi-cli-coc workspace holds the v6 spec.",
    expected: "The workspaces/multi-cli-coc workspace holds the v6 spec.",
  },
  // ── loom#1930 — trailing-slash / no-subpath forms (the CRITICAL leak shape) ──
  // Violation poles: each of these shipped VERBATIM in `.codex/`/`.gemini/`
  // before the optional-subpath fix. The first is the verbatim live leak with
  // the workspace name substituted for a canonical one.
  {
    name: "loom-workspace-trailing-slash-backticked",
    input:
      "- Workspace plan + per-shard disposition catalogs at `workspaces/multi-cli-coc/`",
    expected: "- Workspace plan + per-shard disposition catalogs at (loom-internal reference)",
  },
  {
    name: "loom-workspace-no-subpath-backticked",
    input: "Catalogs live at `workspaces/multi-operator-coc` today.",
    expected: "Catalogs live at (loom-internal reference) today.",
  },
  // loom-workspace arm 4 — the bare name closed by punctuation (measured on the
  // fork-conference docket, 2026-09-04). Compliant pole: the prose form directly
  // above (`preserve-workspace-name-followed-by-prose`) and a name that is a
  // PREFIX of a longer token.
  {
    name: "loom-workspace-bare-name-punctuated",
    input: "MO-OPT W2 core (workspaces/multi-operator-coc, brief directive #1) builds the ceremony.",
    expected: "MO-OPT W2 core ((loom-internal reference), brief directive #1) builds the ceremony.",
  },
  {
    name: "loom-workspace-bare-name-before-paren",
    input: "The keystone: workspaces/multi-operator-coc (receipt 0330). Then the rest.",
    expected: "The keystone: (loom-internal reference) (receipt 0330). Then the rest.",
  },
  {
    name: "loom-workspace-bare-name-sentence-end",
    input: "The receipt lives in workspaces/multi-cli-coc.",
    expected: "The receipt lives in (loom-internal reference).",
  },
  {
    name: "preserve-workspace-name-prefix-of-longer-token",
    input: "Compare workspaces/multi-cli-coc-v2 (a different name) with the canonical one.",
    expected: "Compare workspaces/multi-cli-coc-v2 (a different name) with the canonical one.",
  },
  {
    name: "loom-workspace-trailing-slash-bare",
    input: "Catalogs at workspaces/multi-cli-coc/ hold the shard dispositions.",
    expected: "Catalogs at (loom-internal reference) hold the shard dispositions.",
  },
  // Compliant pole for the SAME arm: a glob is load-bearing in `paths:`
  // frontmatter and CI path filters, so `*` after the slash must NOT strip —
  // the carve-out rule 5e makes for `packages/`, applied to `workspaces/`.
  {
    name: "preserve-loom-workspace-glob-bare",
    input: 'paths: ["workspaces/multi-cli-coc/**"]',
    expected: 'paths: ["workspaces/multi-cli-coc/**"]',
  },
  // ── loom#1930 — whitespace-arm OVER-STRIP poles ──────────────────
  // Violation poles BEFORE the fix: each of these had its slashed prose token
  // eaten and the sentence mangled. The pre-existing negative fixture used prose
  // with NO slash, so it never reached this boundary.
  {
    name: "preserve-prose-and-or-after-workspace-name",
    input: "See workspaces/multi-cli-coc and/or the sync workspace.",
    expected: "See workspaces/multi-cli-coc and/or the sync workspace.",
  },
  {
    name: "preserve-prose-ci-cd-after-workspace-name",
    input: "See workspaces/multi-cli-coc CI/CD notes for the matrix.",
    expected: "See workspaces/multi-cli-coc CI/CD notes for the matrix.",
  },
  {
    name: "preserve-prose-24-7-after-workspace-name",
    input: "The workspaces/multi-operator-coc 24/7 rotation is documented.",
    expected: "The workspaces/multi-operator-coc 24/7 rotation is documented.",
  },
  {
    name: "preserve-prose-tcp-ip-after-workspace-name",
    input: "See workspaces/sync-upflow TCP/IP details in the appendix.",
    expected: "See workspaces/sync-upflow TCP/IP details in the appendix.",
  },
  // …and the compliant pole of the SAME arm still strips: a genuine
  // space-delimited path tail (dot-extension) must not regress to preserved.
  {
    name: "loom-workspace-space-delimited-still-strips",
    input: "Read workspaces/sync-upflow 02-plans/01-architecture.md first.",
    expected: "Read (loom-internal reference) first.",
  },
  // ── loom#1930 — the manifest floor: an ARCHIVED name still strips ──
  // `loom-command` is not a top-level `workspaces/` directory (it lives under
  // `workspaces/_archive/`), so the pre-1930 live-readdir alternation had
  // dropped it. It is in the committed manifest, so it strips regardless of
  // whether the directory is present, archived, or gone.
  {
    name: "loom-workspace-archived-name-still-strips",
    input: "Origin: `workspaces/loom-command/02-plans/01-x.md` cites this.",
    expected: "Origin: (loom-internal reference) cites this.",
  },
  // ── loom#1930 — a FOREIGN internal name (undervivable at loom) strips ──
  // The verbatim CRITICAL leak. Neither name exists in loom's `workspaces/` nor
  // in its git history; both are recorded in the manifest, which is the only
  // mechanism that can reach them.
  {
    name: "foreign-workspace-name-strips-from-manifest",
    input:
      "Origin: `workspaces/use-feedback-triage/journal/0003-GAP-test-skip-masks-ai-failures.md`.",
    expected: "Origin: (loom-internal reference).",
  },
  {
    name: "foreign-workspace-trailing-slash-strips-from-manifest",
    input:
      "- Workspace plan + per-shard disposition catalogs at `workspaces/issue-781-todo-nnn-cleanup/`",
    expected: "- Workspace plan + per-shard disposition catalogs at (loom-internal reference)",
  },
  // Prefix-pair coverage: `sync` is a manifest name AND a strict prefix of
  // `sync-upflow`, so the longer name must strip whole with no `-upflow/…`
  // residue. NOTE, so this fixture is not read as more than it is: it passes
  // with AND without the longest-first sort (mutation M5 is inert against it),
  // because regex backtracking already resolves the collision. It pins the
  // OUTCOME, not the ordering mechanism — no fixture here discriminates the
  // sort, and none claims to.
  {
    name: "longest-name-wins-over-prefix-name",
    input: "See `workspaces/sync-upflow/briefs/00-brief.md` for the anchor.",
    expected: "See (loom-internal reference) for the anchor.",
  },
  {
    name: "sibling-workspaces-backticked",
    input:
      "Compare `kailash-py/workspaces/foo/` and `kailash-rs/workspaces/bar/`.",
    expected: "Compare workspace artifacts and workspace artifacts.",
  },
  {
    name: "gh-api-concrete-repo",
    requiresConfig: true,
    input:
      `Diagnose: \`gh api repos/${FIXTURE_ORG}/kailash-rs/actions/runs\`.`,
    expected: "Diagnose: `gh api repos/<org>/<repo>/actions/runs`.",
  },
  {
    name: "packages-backticked",
    input:
      "Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to fix the bug.",
    expected: "Edit the ml package (`src/kailash_ml/trainable.py`) to fix the bug.",
  },
  {
    name: "packages-bare-prose",
    input: "The path packages/kailash-dataflow/src/dataflow/adapters/mongodb.py is internal.",
    expected:
      "The path the dataflow package directory src/dataflow/adapters/mongodb.py is internal.",
  },
  {
    name: "sibling-dot-claude-example",
    input:
      "Like `kailash-py/.claude/rules/foo.md` references work fine.",
    expected: "Like the sibling SDK's `.claude/rules/foo.md` references work fine.",
  },
  {
    name: "preserve-crates-path",
    input:
      "The `crates/kailash-pact/` crate provides governance primitives.",
    expected:
      "The `crates/kailash-pact/` crate provides governance primitives.",
  },
  {
    name: "preserve-pypi-package-name",
    input: 'Add "kailash-dataflow>=2.0.3" to dependencies.',
    expected: 'Add "kailash-dataflow>=2.0.3" to dependencies.',
  },
  {
    name: "preserve-prose-repo-mention",
    input: "Users of the kailash-rs repo should pin via Cargo.toml.",
    expected: "Users of the kailash-rs repo should pin via Cargo.toml.",
  },
  {
    name: "idempotent-on-already-stripped",
    input: "See (loom-internal reference) and the dataflow package (`x.py`).",
    expected: "See (loom-internal reference) and the dataflow package (`x.py`).",
  },
  {
    name: "workspace-tree-header",
    input: "Tree:\n`kailash-rs/`\n├── src\n└── tests",
    expected: "Tree:\n`<workspace-root>/`\n├── src\n└── tests",
  },
  {
    name: "monorepo-subpackage-backticked",
    input:
      "**Source**: `packages/kaizen-agents/src/kaizen_agents/supervisor.py`",
    expected:
      "**Source**: the kaizen-agents package (`src/kaizen_agents/supervisor.py`)",
  },
  {
    name: "monorepo-subpackage-bare",
    input: "Run the grep against packages/kaizen-agents/tests/ for callers.",
    expected:
      "Run the grep against the kaizen-agents package directory tests/ for callers.",
  },
  {
    name: "trailing-slash-no-subpath-backticked",
    input: "- `packages/kailash-align/` -- Source code",
    expected: "- the align package directory -- Source code",
  },
  {
    name: "trailing-slash-no-subpath-bare",
    input: "git log <last-tag>..HEAD -- packages/kailash-dataflow/  → changes?",
    expected:
      "git log <last-tag>..HEAD -- the dataflow package directory  → changes?",
  },
  {
    name: "trailing-slash-monorepo-backticked",
    input: "MOVE it to `packages/kaizen-agents/` for the monorepo layout.",
    expected:
      "MOVE it to the kaizen-agents package directory for the monorepo layout.",
  },
  {
    name: "preserve-paths-frontmatter-glob",
    input: 'paths: ["packages/kailash-dataflow/**"]',
    expected: 'paths: ["packages/kailash-dataflow/**"]',
  },
  {
    name: "preserve-ci-path-filter-glob",
    input: '      - "packages/kailash-dataflow/**"\n      - "packages/kaizen-agents/**"',
    expected:
      '      - "packages/kailash-dataflow/**"\n      - "packages/kaizen-agents/**"',
  },
  {
    name: "preserve-consumer-monorepo-path",
    input: "Put shared code under packages/my-lib/src/index.ts in your repo.",
    expected:
      "Put shared code under packages/my-lib/src/index.ts in your repo.",
  },
  {
    name: "idempotent-on-extended-outputs",
    input:
      "See the kaizen-agents package (`src/kaizen_agents/supervisor.py`) and the align package directory for detail.",
    expected:
      "See the kaizen-agents package (`src/kaizen_agents/supervisor.py`) and the align package directory for detail.",
  },
  {
    name: "multiple-patterns-one-pass",
    requiresConfig: true,
    input:
      `From \`workspaces/multi-cli-coc/journal/0001.md\`, edit \`packages/kailash-kaizen/tests/foo.py\` and run \`gh api repos/${FIXTURE_ORG}/kailash-py/issues\`.`,
    expected:
      "From (loom-internal reference), edit the kaizen package (`tests/foo.py`) and run `gh api repos/<org>/<repo>/issues`.",
  },
  // ── #673 BUILD-scoped subset (buildMode:true) ──────────────────────
  // The disclosure-class rewrites (workspace paths + canon org) STILL fire;
  // package/repo self-references are PRESERVED verbatim.
  {
    name: "build-subset-strips-loom-workspace-path",
    buildMode: true,
    input:
      "See `workspaces/multi-cli-coc/02-plans/07-loom-multi-cli-spec-v6.md` for the spec.",
    expected: "See (loom-internal reference) for the spec.",
  },
  {
    name: "build-subset-strips-canon-org-slug",
    requiresConfig: true,
    buildMode: true,
    input:
      `Diagnose: \`gh api repos/${FIXTURE_ORG}/kailash-rs/actions/runs\`.`,
    expected: "Diagnose: `gh api repos/<org>/<repo>/actions/runs`.",
  },
  {
    name: "build-subset-strips-sibling-workspaces",
    buildMode: true,
    input: "Compare `kailash-py/workspaces/foo/` and `kailash-rs/workspaces/bar/`.",
    expected: "Compare workspace artifacts and workspace artifacts.",
  },
  {
    name: "build-subset-PRESERVES-packages-path",
    buildMode: true,
    input:
      "Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to fix the bug.",
    expected:
      "Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to fix the bug.",
  },
  {
    name: "build-subset-PRESERVES-crates-path",
    buildMode: true,
    input:
      "The `crates/kailash-pact/` crate provides governance primitives.",
    expected:
      "The `crates/kailash-pact/` crate provides governance primitives.",
  },
  {
    name: "build-subset-PRESERVES-sibling-dot-claude",
    buildMode: true,
    input: "Like `kailash-py/.claude/rules/foo.md` references work fine.",
    expected: "Like `kailash-py/.claude/rules/foo.md` references work fine.",
  },
  {
    name: "build-subset-mixed-strips-disclosure-preserves-package",
    requiresConfig: true,
    buildMode: true,
    input:
      `From \`workspaces/multi-cli-coc/journal/0001.md\`, edit \`packages/kailash-kaizen/tests/foo.py\` and run \`gh api repos/${FIXTURE_ORG}/kailash-py/issues\`.`,
    expected:
      "From (loom-internal reference), edit `packages/kailash-kaizen/tests/foo.py` and run `gh api repos/<org>/<repo>/issues`.",
  },
  // ── #673-A2: generic loom-workspace strip (not just multi-cli-coc) ──
  // USE lane: any current loom workspace dir strips (multi-operator-coc was
  // the proven leak in rules/knowledge-convergence.md).
  {
    name: "loom-workspace-multi-operator-coc-backticked",
    input:
      "Origin: `workspaces/multi-operator-coc/02-plans/01-architecture.md` §5 cites this.",
    expected: "Origin: (loom-internal reference) §5 cites this.",
  },
  {
    name: "loom-workspace-non-multi-cli-bare",
    input: "See workspaces/ecosystem-operating-model/02-plans/05-x.md for detail.",
    expected: "See (loom-internal reference) for detail.",
  },
  {
    name: "build-subset-strips-multi-operator-coc",
    buildMode: true,
    input:
      "Origin: `workspaces/multi-operator-coc/02-plans/01-architecture.md` cites this.",
    expected: "Origin: (loom-internal reference) cites this.",
  },
  {
    name: "build-subset-strips-other-loom-workspace",
    buildMode: true,
    input: "See workspaces/sync-upflow/briefs/00-brief.md for the value anchor.",
    expected: "See (loom-internal reference) for the value anchor.",
  },
  // Provably-scoped: a NON-loom workspace name (instructional / synthetic) is
  // PRESERVED verbatim on BOTH lanes — the derived set strips loom names only.
  {
    name: "preserve-non-loom-workspace-instructional",
    input: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
    expected: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
  },
  {
    name: "build-subset-PRESERVES-non-loom-workspace",
    buildMode: true,
    input: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
    expected: "Put your plans under `workspaces/my-project/02-plans/` in your repo.",
  },
  // loom#1930 — the optional-subpath widening must NOT reach non-loom names.
  // Without this pole, a fence that stripped `workspaces/<anything>/` would pass
  // every other fixture in this file.
  {
    name: "preserve-non-loom-workspace-trailing-slash",
    input: "Create `workspaces/my-project/` and put your briefs there.",
    expected: "Create `workspaces/my-project/` and put your briefs there.",
  },
  {
    name: "preserve-non-loom-workspace-no-subpath",
    input: "Name it `workspaces/my-project` in your own repo.",
    expected: "Name it `workspaces/my-project` in your own repo.",
  },
  // ── #673-A2: PRIVATE slug — orgs/ form + bare token ────────────────
  // USE lane: both broadened forms strip (were form-narrow to repos/ before).
  {
    name: "gh-api-orgs-form-strips-private-slug",
    requiresConfig: true,
    input: `Run \`gh api orgs/${FIXTURE_ORG}/actions/hosted-runners\`.`,
    expected: "Run `gh api orgs/<org>/actions/hosted-runners`.",
  },
  // ── PUBLIC org: identity SURVIVAL on BOTH lanes ────────────────────
  // The public org is the one the templates LIVE IN; naming it in clone URLs
  // and runner endpoints is correct, so no rule may rewrite it (Tier-1
  // re-run, 2026-10-04 — the earlier model conflated the two org sets).
  {
    name: "public-org-slug-identity-survival",
    input: `The templates live at github.com/${FIXTURE_PUBLIC_ORG}/kailash-coc-claude-py.`,
    expected: `The templates live at github.com/${FIXTURE_PUBLIC_ORG}/kailash-coc-claude-py.`,
  },
  {
    name: "public-org-slug-bare-token-survival",
    input: `Runner group \`${FIXTURE_PUBLIC_ORG}\` is where the templates run.`,
    expected: `Runner group \`${FIXTURE_PUBLIC_ORG}\` is where the templates run.`,
  },
  // BUILD lane: orgs/ form + bare token both strip (disclosure-class).
  {
    name: "build-subset-strips-orgs-form-private-slug",
    requiresConfig: true,
    buildMode: true,
    input: `Run \`gh api orgs/${FIXTURE_ORG}/actions/hosted-runners\`.`,
    expected: "Run `gh api orgs/<org>/actions/hosted-runners`.",
  },
  {
    name: "build-subset-public-org-slug-survival",
    buildMode: true,
    input: `The templates live at github.com/${FIXTURE_PUBLIC_ORG}/kailash-coc-claude-py.`,
    expected: `The templates live at github.com/${FIXTURE_PUBLIC_ORG}/kailash-coc-claude-py.`,
  },
  ];
}

// ────────────────────────────────────────────────────────────────
// Fail-closed-scan fixtures (loom#1930). Bipolar: every REFUSE pole has a
// matching ALLOW pole, so a scanner that refused everything — or nothing —
// reds instead of passing.
//   refuse: true  → assertNoUnclassifiedWorkspaceRef MUST throw, and `names`
//                   MUST equal the listed offenders exactly (not merely be
//                   non-empty: a scanner that reports the wrong token is a
//                   different defect wearing the same exit code).
//   refuse: false → MUST NOT throw.
// ────────────────────────────────────────────────────────────────
// The allowlist the classification fixtures below run against — fixed, so their
// verdicts do not vary with the checkout's repo class or with edits to the
// loom_only ledger.
const SCAN_PRESERVE = ["_certify", "_archive", "my-project", "X"];

const SCAN_FIXTURES = [
  {
    name: "scan-refuses-foreign-name",
    input: "Origin: `workspaces/use-feedback-triage/journal/0003-GAP.md`.",
    refuse: true,
    names: ["use-feedback-triage"],
  },
  {
    name: "scan-refuses-unknown-name-trailing-slash",
    input: "Catalogs at `workspaces/some-unrecorded-ws/`",
    refuse: true,
    names: ["some-unrecorded-ws"],
  },
  {
    name: "scan-reports-every-offender-not-just-the-first",
    input: "See workspaces/aaa-unknown/x.md and workspaces/bbb-unknown/y.md.",
    refuse: true,
    names: ["aaa-unknown", "bbb-unknown"],
  },
  {
    name: "scan-allows-preserved-instructional-name",
    input: "Create `workspaces/my-project/briefs/` in your repo.",
    refuse: false,
  },
  {
    name: "scan-allows-reserved-meta-dir",
    input: "Receipts go to `workspaces/_certify/.pending/brief.md`.",
    refuse: false,
  },
  {
    name: "scan-allows-metavariable",
    input: "Archive with `git mv workspaces/X workspaces/_archive/X`.",
    refuse: false,
  },
  // The absolute-container-path pole. `/workspaces/ml` is a filesystem path in a
  // PACT code sample, NOT a repo workspace reference. The matcher must not see
  // it at all — this is why `ml` and `data` are absent from `preserve`.
  {
    name: "scan-ignores-absolute-container-path",
    input: 'WorkspaceConfig(id="data-ws", path="/workspaces/data")\n  path: /workspaces/ml',
    refuse: false,
  },
  {
    name: "scan-ignores-word-prefixed-token",
    input: "The myworkspaces/internal-thing directory is unrelated.",
    refuse: false,
  },
  // Post-strip content is clean by construction — the whole point is that the
  // scan runs AFTER the rewrites, so a stripped loom path never reaches it.
  {
    name: "scan-allows-already-stripped-content",
    input: "See (loom-internal reference) for the spec.",
    refuse: false,
  },
];

function scanSelftest({ verbose = false } = {}) {
  let pass = 0;
  const failures = [];
  for (const fx of SCAN_FIXTURES) {
    let threw = null;
    try {
      // An EXPLICIT preserve list, deliberately. These fixtures test the
      // classification logic, which must give the same verdict in every repo;
      // routing them through the ledger would make the result depend on the
      // checkout's class and on a loom_only file that is absent by design off
      // loom. The repo-class scoping itself is covered by the two cases below,
      // which exercise it directly instead of leaking it into all nine.
      assertNoUnclassifiedWorkspaceRef(fx.input, {
        file: fx.name,
        preserve: SCAN_PRESERVE,
      });
    } catch (e) {
      threw = e;
    }
    let ok;
    if (fx.refuse) {
      ok =
        threw instanceof WorkspaceDisclosureError &&
        JSON.stringify(threw.names) === JSON.stringify(fx.names);
    } else {
      ok = threw === null;
    }
    if (ok) {
      pass++;
      if (verbose) console.log(`  PASS  ${fx.name}`);
    } else {
      failures.push({
        name: fx.name,
        expected: fx.refuse ? `throw with names ${JSON.stringify(fx.names)}` : "no throw",
        actual: threw ? `${threw.name}: ${JSON.stringify(threw.names ?? null)}` : "no throw",
      });
    }
  }
  // ── repo-class scoping of the scan (loom#1930) ──
  // The ledger is loom_only, so off loom it is ABSENT BY DESIGN and the scan
  // must NO-OP rather than refuse a consumer's own workspace names. Both poles
  // are asserted: a bare fail-closed read would pass an "it refuses" test while
  // breaking every consumer emission, and a bare no-op would pass an "it allows"
  // test while silently disabling the fence at loom.
  {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );
    const atLoom = isLoomSourceTree();
    const sample = "See `workspaces/some-consumer-workspace/02-plans/x.md`.";
    let threw = null;
    try {
      assertNoUnclassifiedWorkspaceRef(sample, { file: "scoping-probe" });
    } catch (e) {
      threw = e;
    }
    const name = atLoom
      ? "scan-REFUSES-an-unclassified-name-at-loom (ledger present)"
      : "scan-NO-OPS-off-loom (ledger absent by design; consumer owns its names)";
    const ok = atLoom ? threw instanceof WorkspaceDisclosureError : threw === null;
    if (ok) {
      pass++;
      if (verbose) console.log(`  PASS  ${name}`);
    } else {
      failures.push({
        name,
        expected: atLoom ? "throw (WorkspaceDisclosureError)" : "no throw",
        actual: threw ? `${threw.name}` : "no throw",
      });
    }
  }

  if (failures.length) {
    console.error(
      `strip-build-internal scan-selftest: ${pass} pass, ${failures.length} fail`,
    );
    for (const f of failures) {
      console.error(`  FAIL  ${f.name}`);
      // LOG-HYGIENE (Tier-1 r4): fixture diffs embed the DERIVED private slug at
      // loom, and this text reaches terminals, CI logs and pasted bug reports —
      // every value is redacted before it is printed.
      console.error(`    expected: ${redactPrivateIdentity(f.expected)}`);
      console.error(`    actual:   ${redactPrivateIdentity(f.actual)}`);
    }
    return false;
  }
  console.log(`strip-build-internal scan-selftest: ${pass}/${pass} pass`);
  return true;
}

// ── F6 (security read, r4-v4) REDACTION SELFTEST ────────────────────────────
// The value-redaction sweep was INCOMPLETE in three ways, each fixed and each
// pinned here BEHAVIOURALLY, with the control that proves the case would RED on
// the pre-fix behaviour:
//   (a) orgSets() printed a NON-STRING config entry via JSON.stringify, echoing
//       a value-shaped payload into the thrown message. Fixed: the TYPE only.
//   (b) redactPrivateIdentity replaced slugs in CONFIG ORDER, so a short slug
//       that is a PREFIX of a longer one consumed the prefix first and left the
//       longer slug's tail visible (short slug first produced a
//       `<PRIVATE-ORG>-<tail>` residue, never a whole-span mask).
//       Fixed: LONGEST-FIRST ordering.
//   (e) the scanner matches through `foldForGate` (NFKD + marks stripped +
//       lowercase) while the redactor matched with `/i` alone — and those two
//       DISAGREE on compatibility spellings. MEASURED: `/k/i.test("K")` is
//       FALSE while `"K".toLowerCase() === "k"`, so a Unicode-spelled value
//       the scanner fired on was NOT masked by the redactor — a raw-value leak
//       into the very log the gate was printing. Fixed: the redactor's second
//       pass folds with the SAME `foldForGate` the scanner uses, so a scanner
//       hit is ALWAYS maskable.
// The fixtures below are SYNTHETIC and self-contained (an explicit slug list, or
// a sandboxed config copy) — no dependence on the ambient canon-identity config,
// so the section runs identically at loom, in a seed-shaped fork and in a
// consumer tree.
function f6RedactionSelftest({ verbose = false } = {}) {
  let pass = 0;
  const failures = [];
  const check = (name, ok, detail = "") => {
    if (ok) {
      pass++;
      if (verbose) console.log(`  PASS  ${name}`);
    } else {
      failures.push({ name, detail });
    }
  };
  const rid = (s) => redactPrivateIdentity(String(s));

  // ── (b) LONGEST-FIRST: a short slug that is a PREFIX of a longer one ──
  {
    const SLUGS = ["zz-synthetic-org", "zz-synthetic-org-holdings"];
    const long = redactPrivateIdentity("see zz-synthetic-org-holdings here", SLUGS);
    const short = redactPrivateIdentity("see zz-synthetic-org here", SLUGS);
    const clean = redactPrivateIdentity("nothing to mask here", SLUGS);
    // Failure on the pre-fix ORDER would read "see <PRIVATE-ORG>-holdings here" —
    // the longer slug's tail surviving because the prefix consumed it first.
    check(
      "F6b longest-first: the longer slug is masked WHOLE (no tail residue)",
      long === "see <PRIVATE-ORG> here",
      `expected "see <PRIVATE-ORG> here", got ${JSON.stringify(long)}`,
    );
    check(
      "F6b longest-first: the shorter slug alone still masks (the ordering does not disarm the prefix)",
      short === "see <PRIVATE-ORG> here",
      `got ${JSON.stringify(short)}`,
    );
    check("F6b bipolar control: clean text is untouched", clean === "nothing to mask here", `got ${JSON.stringify(clean)}`);
  }

  // ── (e) ONE FOLD: the scanner's foldForGate and the redactor's match agree ──
  {
    const SLUG = "zz-synthetic-ok";
    const KELVIN = "zz-synthetic-oK"; // U+212A KELVIN SIGN spells the final `k`
    const IDOT = "zz-synthetİc-ok"; // U+0130 folds to `i` under NFKD, SPLITS under toLowerCase
    // CONTROLS FIRST: the spellings must actually differ from the slug, and `/i`
    // must miss them — otherwise the redactor would mask them even with the
    // pre-fix Pass-1-only body and the case would pin nothing.
    check("F6e control: the Kelvin spelling differs from the slug", KELVIN !== SLUG, "");
    check(
      "F6e control: /i alone does NOT match the Kelvin spelling (the pre-fix leak)",
      !new RegExp(escapeRx(SLUG), "i").test(KELVIN),
      "if /i matched here the pre-fix redactor would have masked it — fixture would be vacuous",
    );
    check(
      "F6e control: /i alone does NOT match the dotted-İ spelling",
      !new RegExp(escapeRx(SLUG), "i").test(IDOT),
      "",
    );
    // THE SCANNER'S PREDICATE: its matching runs through foldForGate, so a token
    // whose folded form equals the folded slug IS a scanner hit.
    check(
      "F6e scanner-fold: foldForGate(Kelvin spelling) folds to the slug — the scanner FIRES on it",
      foldForGate(KELVIN) === foldForGate(SLUG),
      `folded=${JSON.stringify(foldForGate(KELVIN))} slug-folded=${JSON.stringify(foldForGate(SLUG))}`,
    );
    check(
      "F6e scanner-fold: foldForGate(dotted-İ spelling) folds to the slug",
      foldForGate(IDOT) === foldForGate(SLUG),
      `folded=${JSON.stringify(foldForGate(IDOT))}`,
    );
    // THE SEAM: a scanner hit is ALWAYS maskable by the redactor.
    check(
      "F6e mask: the Kelvin spelling is MASKED by the redactor (a scanner hit is maskable)",
      redactPrivateIdentity(`see ${KELVIN} here`, [SLUG]) === "see <PRIVATE-ORG> here",
      `got ${JSON.stringify(redactPrivateIdentity(`see ${KELVIN} here`, [SLUG]))}`,
    );
    check(
      "F6e mask: the dotted-İ spelling is MASKED by the redactor",
      redactPrivateIdentity(`see ${IDOT} here`, [SLUG]) === "see <PRIVATE-ORG> here",
      `got ${JSON.stringify(redactPrivateIdentity(`see ${IDOT} here`, [SLUG]))}`,
    );
    // BIPOLAR: Pass 1 still owns the plain case-variants, and clean text stays clean.
    check(
      "F6e bipolar: the ASCII upper-case spelling masks via Pass 1",
      redactPrivateIdentity("see ZZ-SYNTHETIC-OK here", [SLUG]) === "see <PRIVATE-ORG> here",
      "",
    );
    check(
      "F6e bipolar: clean text is untouched by the folded pass",
      redactPrivateIdentity("nothing here", [SLUG]) === "nothing here",
      "",
    );
  }

  // ── (a) orgSets() NON-STRING entry: type only, never the entry ──
  {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "strip-f6-orgsets-"));
    try {
      const libDir = path.join(sandbox, ".claude", "bin", "lib");
      fs.mkdirSync(libDir, { recursive: true });
      fs.cpSync(path.dirname(fileURLToPath(import.meta.url)), libDir, { recursive: true });
      const cfgPath = path.join(sandbox, ".claude", "canon-identity-values.json");
      const run = (cfg) => {
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));
        return spawnSync(
          process.execPath,
          [path.join(libDir, "strip-build-internal.mjs"), "--assert-private-org-config"],
          { encoding: "utf8" },
        );
      };
      // The OLD message interpolated `JSON.stringify(s)`; the planted entry is an
      // OBJECT whose payload must never reach stdout/stderr.
      const SENTINEL = "zz-f6-sentinel-payload";
      const dirty = run({ private_org_slugs: ["zz-synthetic-valid-org", { planted: SENTINEL }] });
      const dirtyOut = `${dirty.stdout || ""}${dirty.stderr || ""}`;
      check("F6a: a NON-STRING config entry HALTS (rc=1)", dirty.status === 1, `rc=${dirty.status} out=${rid(dirtyOut).slice(0, 160)}`);
      check(
        "F6a: the message NAMES the defect and prints the TYPE only",
        /NON-STRING/.test(dirtyOut) && /type object/.test(dirtyOut),
        `out=${rid(dirtyOut).slice(0, 160)}`,
      );
      check(
        "F6a: the message does NOT echo the entry's payload (the pre-fix JSON.stringify leak)",
        !dirtyOut.includes(SENTINEL),
        "the entry value must never reach a message a human or CI log will read",
      );
      // BIPOLAR: the same sandbox with a VALID config exits 0 — the assertion
      // above is not a blanket refusal of every config.
      const okCfg = run({ private_org_slugs: ["zz-synthetic-valid-org"] });
      check(
        "F6a bipolar control: a valid config exits 0 and reports its count",
        okCfg.status === 0 && /private org config OK: 1 slug/.test(okCfg.stdout || ""),
        `rc=${okCfg.status} out=${JSON.stringify((okCfg.stdout || "").trim())}`,
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }

  if (failures.length) {
    console.error(`strip-build-internal redaction-selftest: ${pass} pass, ${failures.length} fail`);
    for (const f of failures) {
      console.error(`  FAIL  ${f.name}`);
      if (f.detail) console.error(`    ${rid(f.detail)}`);
    }
    return false;
  }
  console.log(`strip-build-internal redaction-selftest: ${pass}/${pass} pass`);
  return true;
}

/**
 * The RATCHET (loom#1930). Fails when a workspace that EXISTS right now — top
 * level or under `_archive/` — is absent from the committed manifest's `strip`
 * list.
 *
 * It has to fire while the directory still exists, because that is the only
 * moment the omission is recoverable: once the directory is archived away or
 * deleted, there is nothing left to compare the manifest against and the name is
 * gone for good. This is what stops the committed floor from going stale, which
 * is the single assumption the whole fix rests on.
 *
 * Loom-only by construction: `liveLoomWorkspaceDirs()` returns [] off a
 * `coc-source` checkout, so this is a no-op (and reports so) elsewhere rather
 * than failing a consumer's build over loom's bookkeeping.
 */
function verifyManifest() {
  const live = liveLoomWorkspaceDirs();
  if (live.length === 0) {
    console.log(
      "strip-build-internal --verify-manifest: not a coc-source checkout (or no workspaces/) — nothing to verify.",
    );
    return true;
  }
  const { strip, preserve } = readWorkspaceNameManifest();
  const known = new Set([...strip, ...preserve, ...CANONICAL_LOOM_WS]);
  const missing = [...new Set(live)].filter((n) => !known.has(n)).sort();
  if (missing.length) {
    console.error(
      `strip-build-internal --verify-manifest: ${missing.length} live workspace name(s) NOT recorded in ` +
        ".claude/bin/lib/loom-workspace-names.json:",
    );
    for (const n of missing) console.error(`  - ${n}`);
    console.error(
      "Append each to `strip` (a real workspace) or `preserve` (a meta-dir).\n" +
        "Recording it NOW is what keeps it stripping after it is archived or deleted.",
    );
    return false;
  }
  console.log(
    `strip-build-internal --verify-manifest: ${live.length} live workspace name(s), all recorded (${strip.length} in strip, ${preserve.length} in preserve).`,
  );
  return true;
}

function selftest({ verbose = false } = {}) {
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const skippedNames = [];
  const failures = [];
  for (const fx of buildSelfTestFixtures()) {
    if (privateOrgSlugs().length === 0 && fx.requiresConfig === true) {
      // CONFIG-GATED rows are declared BY FLAG (`requiresConfig: true`), never by
      // a name pattern, and every skip is NAMED on BOTH the pass and the fail
      // paths. SKIP BY CONFIG, NOT REPO TYPE (cc-architect ruling, 2026-10-04):
      // a private-armed rewrite cannot fire when there are no private slugs, so
      // these rows skip on ANY tree that lacks its own canon-identity-values.json
      // — pre-init forks and consumers alike — and RUN the moment a config
      // exists (loom, an initialized fork), where a broken set FAILS them loudly.
      // Deleting `.claude/VERSION` cannot flip this either way.
      skipped++;
      skippedNames.push(fx.name);
      continue;
    }
    const { stripped } = stripBuildInternalReferences(fx.input, {
      buildMode: fx.buildMode === true,
    });
    if (stripped === fx.expected) {
      pass++;
      if (verbose) console.log(`  PASS  ${fx.name}`);
    } else {
      fail++;
      failures.push({
        name: fx.name,
        expected: fx.expected,
        actual: stripped,
      });
    }
  }
  if (fail > 0) {
    console.error(`strip-build-internal selftest: ${pass} pass, ${fail} fail`);
    if (skipped) {
      console.error(`  (skipped without a config: ${skippedNames.join(", ")})`);
    }
    for (const f of failures) {
      console.error(`  FAIL  ${f.name}`);
      // LOG-HYGIENE (Tier-1 r4): see the scan-selftest printer — every printed
      // value is redacted; the derived private slug must never reach a log.
      console.error(`    expected: ${redactPrivateIdentity(JSON.stringify(f.expected))}`);
      console.error(`    actual:   ${redactPrivateIdentity(JSON.stringify(f.actual))}`);
    }
    return false;
  }
  console.log(
    `strip-build-internal selftest: ${pass}/${pass} pass${skipped ? ` (${skipped} skipped without a config: ${skippedNames.join(", ")})` : ""}`,
  );
  // The rewrite fixtures and the fail-closed scan are two halves of one
  // contract — the rewrites strip what is KNOWN, the scan refuses what is not.
  // Running only the first half would report a green for a fence with no floor.
  // The F6 REDACTION section is the third half: a gate that FIRES but cannot
  // MASK its own hit prints the value it exists to withhold.
  return f6RedactionSelftest({ verbose }) && scanSelftest({ verbose });
}

// ────────────────────────────────────────────────────────────────
// CLI entry point — runnable for sync-flow / debugging / pre-commit.
//
//   node strip-build-internal.mjs --selftest
//     Run all fixtures; exit 0 on full pass, 1 otherwise.
//
//   node strip-build-internal.mjs --check <file>
//     Read <file>, report which rewrite rules would fire, exit 0
//     if file is clean (no rewrites), 1 if it would be modified.
//
//   node strip-build-internal.mjs --apply <input> [--out <output>]
//     Read <input>, write stripped to <output> (defaults to stdout).
//
// Used by:
//   - rules/cc-artifacts.md Rule 9 (audit fixtures via --selftest)
//   - agents/management/coc-sync.md Step 3a (--check as post-sync audit)
//   - .claude/bin/emit-cli-artifacts.mjs (library import; in-process call)
//   - .claude/bin/sync-tier-aware.mjs (library import since #473; #475 adds
//     write-time strip of plain-global copy actions + the variant_only
//     strip-dirty completeness gate)
// ────────────────────────────────────────────────────────────────
async function cli() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      `Usage:\n` +
        `  --selftest               Run fixtures, exit 0 on pass.\n` +
        `  --verify-manifest        Assert every live workspace name is recorded.\n` +
        `  --assert-private-org-config  Distribution gate: exit 1 unless the private org set resolves non-empty.\n` +
        `  --assert-fork-identity-derived  MANUAL sanity check (not a gate, no callers): exit 1 unless\n` +
        `                               the org derived from this clone's own origin is in the\n` +
        `                               declaration's private orgs. Trusts origin; local-path /\n` +
        `                               unparseable remotes are UNKNOWN and refuse.\n` +
        `  --check <file>           Report rules that would fire on <file>.\n` +
        `  --apply <file> [--out X] Strip <file>; write to X or stdout.\n`,
    );
    return 0;
  }
  if (args[0] === "--selftest") {
    return selftest({ verbose: args.includes("-v") }) ? 0 : 1;
  }
  if (args[0] === "--verify-manifest") {
    return verifyManifest() ? 0 : 1;
  }
  if (args[0] === "--assert-private-org-config") {
    // The DISTRIBUTION-TIME LOUD assertion (F1/F4). Prints the COUNT only —
    // never the values — so a CI log or console cannot become a disclosure
    // surface; exits 1 with the typed message when absent/malformed/empty.
    try {
      const slugs = assertPrivateOrgConfig();
      console.log(`private org config OK: ${slugs.length} slug(s) resolved`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  if (args[0] === "--assert-fork-identity-derived") {
    // MANUAL SANITY CHECK, not a gate (HIGH-1 relabel): no entrypoint calls it,
    // it is a checklist item a human runs before distributing. It TRUSTS
    // `origin` — if origin points into canon's org (the client-template repo, or
    // a path that merely looks like it) a copied canon declaration passes and a
    // correct client-only one fails — so WITHOUT canon data it cannot detect a
    // copied declaration and nothing here claims otherwise. The enforced fence
    // is the distribution-time identity gate over the WRITTEN tree. It refuses
    // with UNKNOWN when the origin cannot say what org this clone belongs to
    // (no remote, a local path, an unparseable shape).
    const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    // THE REQUIRE IS RESOLVED FROM THIS FILE (.claude/bin/lib/), SO IT NEEDS TWO
    // LEVELS. The first version read "../hooks/lib/…", which resolves to
    // .claude/bin/hooks/lib/ — a path that does not exist. MODULE_NOT_FOUND was
    // caught by the generic handler below and reported as "no resolvable origin
    // remote", so the gate refused EVERY tree, canon's own included, while the
    // pure-function suite stayed green. A load failure is now reported as
    // itself; only a git failure may claim "no resolvable remote".
    let gse = null;
    try {
      gse = createRequire(import.meta.url)("../../hooks/lib/git-subprocess-env.js");
    } catch (e) {
      process.stderr.write(
        "the shared git-subprocess envelope (.claude/hooks/lib/git-subprocess-env.js) could not be loaded " +
          `(${e && e.code ? e.code : "load error"}) — this fork's own identity cannot be derived (fail closed). Refusing.\n`,
      );
      return 1;
    }
    let remoteUrl = null;
    try {
      const gitArgs = ["-C", repoRootDir, "remote", "get-url", "origin"];
      remoteUrl = execFileSync(gse.resolveGitBinary(), gitArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: gse.gitEnvForArgs(gitArgs),
      }).trim();
    } catch {
      remoteUrl = null;
    }
    let declared = [];
    try {
      const s = orgSets();
      // PRIVATE ONLY (spec item 2): the orgs a fork declares it must NEVER ship.
      // Including the public set would let the public half satisfy a check whose
      // question is about the PRIVATE declaration.
      declared = [...s.private];
    } catch {
      declared = [];
    }
    const verdict = forkIdentityDerivedVerdict({ remoteUrl, declared });
    if (!verdict.ok) {
      process.stderr.write(`${verdict.reason}. Refusing.\n`);
      return 1;
    }
    console.log(`MANUAL CHECK (origin-trusted, NOT a gate): the org DERIVED from this clone's own origin is in the declaration's private orgs (${[...new Set(declared.map((x) => String(x).trim().toLowerCase()))].length} declared org(s)) — it cannot detect a copied declaration`);
    return 0;
  }
  if (args[0] === "--check") {
    const fp = args[1];
    if (!fp) {
      process.stderr.write("--check requires a file path\n");
      return 2;
    }
    const content = fs.readFileSync(fp, "utf8");
    const { stripped, applied } = stripBuildInternalReferences(content);
    if (stripped === content) {
      console.log(`clean: ${fp}`);
      return 0;
    }
    console.log(`would-rewrite: ${fp}`);
    for (const desc of applied) console.log(`  - ${desc}`);
    return 1;
  }
  if (args[0] === "--apply") {
    const fp = args[1];
    if (!fp) {
      process.stderr.write("--apply requires a file path\n");
      return 2;
    }
    const content = fs.readFileSync(fp, "utf8");
    const { stripped } = stripBuildInternalReferences(content);
    const outIdx = args.indexOf("--out");
    if (outIdx >= 0 && args[outIdx + 1]) {
      fs.writeFileSync(args[outIdx + 1], stripped);
    } else {
      process.stdout.write(stripped);
    }
    return 0;
  }
  process.stderr.write(`unknown args: ${args.join(" ")}\n`);
  return 2;
}

// Run CLI when invoked directly; skip when imported as a module.
// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) {
  cli().then((code) => process.exit(code));
}
