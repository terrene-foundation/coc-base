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
 * Extracted from publish-to-public.mjs (the pre-W2 single source) per MO-OPT
 * W2-0 (workspaces/multi-operator-optional). The ADO `principal` (Entra UPN)
 * harvest is NEW here — the pre-W2 deriveDynamicTokens did NOT extract it, so an
 * azure-devops-provider roster's owner identity would have slipped both fences.
 *
 * Node ESM, zero dependencies.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
    for (const [val, repl] of [[g.repo_owner, "<canon-owner>"], [g.ado_project, "<ado-project>"]]) {
      if (typeof val === "string" && val.length > 2 && !val.startsWith("PLACEHOLDER-")) { gate.push(val); scrub.push([val, repl]); }
    }
    if (typeof g.root_commit === "string" && /^[0-9a-fA-F]{7,64}$/.test(g.root_commit) && !/^0+$/.test(g.root_commit)) {
      gate.push(g.root_commit); scrub.push([g.root_commit, synthHex(g.root_commit)]);
    }
  }
  return { scrub, gate };
}
