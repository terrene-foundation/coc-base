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
 * EXTRACTS identity from a repo's `operators.roster.json` + tenant denylist at
 * RUNTIME. It is therefore safe to SYNC + PUBLISH (`.claude/bin/**`): a consumer
 * receiving it sees only the extraction logic, never a literal canon token.
 *
 * deriveDynamicTokens(repoDir) returns { scrub, gate }:
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
import { readFileSync, readdirSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Read a file as UTF-8 text, or null when it is binary (NUL-byte sniff over the
 * first 8 KiB). Every NON-binary file is therefore scrubbed + gated by DEFAULT
 * (fail-safe: unknown text extensions — .py, .csv, extensionless — are covered).
 * Redteam PR#438 closed the prior isText() extension-allowlist blind spot.
 */
export function readTextOrNull(f) {
  let buf;
  try { buf = readFileSync(f); } catch { return null; }
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null; // binary → skip
  return buf.toString("utf8");
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

function harvestPgpUid(pubkeyText, gate, scrub) {
  if (typeof pubkeyText !== "string") return;
  for (const block of pubkeyText.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g) || []) {
    let decoded = "";
    try {
      const b64 = block
        .replace(/-----(BEGIN|END) PGP PUBLIC KEY BLOCK-----/g, "")
        .replace(/^(Comment|Version):.*$/gm, "")
        .replace(/\n=[^\n]{4}\s*$/, "")
        .replace(/\s+/g, "");
      decoded = Buffer.from(b64, "base64").toString("latin1");
    } catch { continue; }
    for (const m of decoded.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      gate.push(m[0]); scrub.push([m[0], "maintainer@example.com"]);
      const lp = m[0].split("@")[0];
      if (lp.length > 2) {
        gate.push(lp); scrub.push([lp, "maintainer"]);
        // MO-R1-H2: a dotted localpart like "alex.kim" is gated, but its
        // hyphenated/concatenated forms ("alex-kim","alexkim") are distinct
        // strings an includes()-grep misses.
        for (const v of separatorVariants(lp)) { gate.push(v); scrub.push([v, "maintainer"]); }
      }
    }
    for (const m of decoded.matchAll(/([A-Z][A-Za-z.'’-]+(?: [A-Z][A-Za-z.'’-]+)+) <[^>]+>/g)) {
      gate.push(m[1]); scrub.push([m[1], "Example Maintainer"]);
      for (const v of separatorVariants(m[1].toLowerCase())) { gate.push(v); scrub.push([v, "example-maintainer"]); }
    }
  }
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
 * Throws (fail-closed) naming every escaping link + its resolved target.
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
        catch { escaped.push(`${path.relative(root, full)} -> <unresolvable/dangling>`); continue; }
        if (real !== root && !real.startsWith(root + path.sep)) {
          escaped.push(`${path.relative(root, full)} -> ${real}`);
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
  return /\/(Users|home)\/(?!<user>|runner\b|example\b)([A-Za-z][\w.-]*)/g;
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
 * canonical synthetic placeholders. Deliberately EXCLUDED: `esperie` (the REAL
 * maintainer home — a
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
  // (scan-synced-disclosure already treats `/Users/me/` as a benign placeholder).
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

/** A neutralize SENTINEL is the angle-bracket placeholder form (`<canon-owner>`). */
function isNeutralizeSentinel(value) {
  return typeof value === "string" && /^<[^>]*>$/.test(value);
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
  const pairs = merged
    .sort((a, b) => b[0].length - a[0].length)
    .filter(([f]) => (_seen.has(f) ? false : (_seen.add(f), true)));
  const homepathRe = makeHomepathRe(); // fresh per scrubber (g-flag lastIndex state)
  // Default: UNCONDITIONAL rewrite (byte-identical to the pre-carve-out behavior).
  // *.test.mjs carve-out: a REPLACE-CALLBACK preserves a match ONLY when its
  // captured username (group 2) is a recognized SYNTHETIC fixture user; any other
  // home — incl. a REAL contributor's — is still rewritten to `/<kind>/<user>`,
  // closing the non-token-home leak (#1141-7 rt1-security).
  const homepathReplace = preserveSyntheticFixtureHomes
    ? (full, kind, username) =>
        SYNTHETIC_FIXTURE_USERS.has(String(username).toLowerCase()) ? full : `/${kind}/<user>`
    : "/$1/<user>";
  return (text) => {
    let txt = text;
    for (const [from, to] of pairs) { if (txt.includes(from)) txt = txt.split(from).join(to); }
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
 *        disclosure-tenant-denylist.json + operators.roster.json.
 * @returns {{ scrub: [string,string][], gate: string[] }}
 */
export function deriveDynamicTokens(repoDir) {
  const scrub = [], gate = [];

  // (1) customer/tenant tokens from the denylist SSOT — gate AND self-scrub (so
  // a NEW tenant token added to the denylist self-scrubs without a STATIC edit).
  const denyPath = path.join(repoDir, ".claude/disclosure-tenant-denylist.json");
  if (existsSync(denyPath)) {
    let toks;
    try { toks = JSON.parse(readFileSync(denyPath, "utf8")).tokens || []; }
    catch (e) {
      throw new Error(
        `disclosure-tenant-denylist.json present but unparseable: ${e.message} ` +
        `(refusing to proceed with a silently-disabled tenant gate)`,
      );
    }
    for (const t of toks) {
      if (typeof t === "string" && t.trim()) { gate.push(t); scrub.push([t, "a downstream tenant"]); }
    }
  }

  // (2) operator identity from the roster.
  const rosterPath = path.join(repoDir, ".claude/operators.roster.json");
  if (existsSync(rosterPath)) {
    const txt = readFileSync(rosterPath, "utf8");
    let r;
    try { r = JSON.parse(txt); }
    catch (e) {
      throw new Error(
        `operators.roster.json present but unparseable: ${e.message} ` +
        `(refusing to proceed with a silently-disabled identity gate)`,
      );
    }
    const personsRaw = (r && (r.persons || r.operators)) || [];
    // The CANONICAL roster shape is a map (person_id → record, schema:59), so the
    // person_id is the KEY, not a field. The pre-W2 derive iterated VALUES only,
    // never gating the map-key person_id — the same latent-gap class as the
    // principal omission below (canon's publish passed only because the org-slug
    // catch-all incidentally covered it). Iterate ENTRIES so the key is harvested.
    const entries = Array.isArray(personsRaw)
      ? personsRaw.map((p) => [null, p])
      : Object.entries(personsRaw);
    const fps = new Set();
    for (const [pid, p] of entries) {
      if (typeof pid === "string" && pid.length > 2) { gate.push(pid); scrub.push([pid, "maintainer"]); }
      if (!p || typeof p !== "object") continue;
      for (const k of (p.keys || [])) {
        // verified_id = GPG 40-hex OR SSH "SHA256:base64" (roster schema:120-123).
        // The fingerprint IS the authenticating identity regardless of algorithm;
        // harvest any non-trivial value, not just hex (HIGH-1: the prior
        // ^[0-9A-Fa-f]{16,}$ regex silently dropped every SSH verified_id).
        if (k && typeof k.fingerprint === "string" && k.fingerprint.trim().length >= 16) fps.add(k.fingerprint.trim());
        // (3) NAME + EMAIL from each parsed pubkey's PGP UID packets.
        if (k && typeof k.pubkey === "string") harvestPgpUid(k.pubkey, gate, scrub);
      }
      // display_id/github_login/person_id are the GitHub-provider bindings;
      // `principal` is the azure-devops Entra UPN binding (roster schema:84) —
      // NEW in W2: the pre-W2 derive omitted it, so an ADO-provider owner's UPN
      // slipped both the publish gate AND (absent this) the ceremony gate.
      for (const k of ["display_id", "github_login", "person_id", "principal"]) {
        if (p[k] && typeof p[k] === "string" && p[k].length > 2) { gate.push(p[k]); scrub.push([p[k], "maintainer"]); }
      }
    }
    if (fps.size === 0) for (const h of (txt.match(/[0-9A-F]{40}/g) || [])) fps.add(h); // fallback only
    for (const h of fps) { scrub.push([h, synthHex(h)]); gate.push(h); }

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
    for (const [val, repl] of [[g.repo_owner, "<canon-owner>"], [g.ado_project, "<ado-project>"]]) {
      if (typeof val === "string" && val.length > 2 && !val.startsWith("PLACEHOLDER-")) { gate.push(val); scrub.push([val, repl]); }
    }
    if (typeof g.root_commit === "string" && /^[0-9a-fA-F]{7,64}$/.test(g.root_commit) && !/^0+$/.test(g.root_commit)) {
      gate.push(g.root_commit); scrub.push([g.root_commit, synthHex(g.root_commit)]);
    }
  }
  return { scrub, gate };
}
