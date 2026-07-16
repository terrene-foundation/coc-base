#!/usr/bin/env node
/**
 * clean-instantiate.mjs — MO-OPT W2 CLIENT-clone CLEAR ceremony.
 *
 * A client that clones/templates canon (loom + builds + use-templates) to
 * instantiate its OWN ecosystem inherits canon's committed coordination-
 * substrate identity: the genesis trust-root + GPG pubkey/fingerprint + the
 * roster owner, the journal (entries carrying the inline fingerprint), the
 * team-memory facts, the ecosystem.json registry, and the tenant denylist.
 * `/ecosystem-init` does NOT clear them — it PRESUMES the client owner is
 * already enrolled. This ceremony is the clear-then-bootstrap step that runs
 * BEFORE `/ecosystem-init`, on the CLIENT clone (canon is never touched).
 *
 *   DRY RUN (default):  node .claude/bin/clean-instantiate.mjs [--root <dir>]
 *       → snapshots canon trust-identity, previews the clear plan, writes
 *         NOTHING. Exit 0.
 *   APPLY:              node .claude/bin/clean-instantiate.mjs --apply [--root <dir>]
 *                          [--upstream-canon-url <url>] [--ecosystem-id <label>]
 *       → performs the clear, then runs the FAIL-CLOSED assert-zero gate:
 *         ANY residual canon trust-identity token OR structural disclosure
 *         finding ABORTS with exit 1 (never a silent "clean").
 *
 * SCOPE (brief S3 — operator/TRUST identity): this clears the coordination
 * SUBSTRATE (roster/genesis/coordination-log/journal/team-memory/ecosystem/
 * tenant-denylist) via 6 structured surfaces, DELETES the loom-only canon-publish
 * tooling (scripts/publish-to-public.mjs — carries non-derivable static canon
 * identity), THEN runs a WHOLE-TREE NEUTRALIZE pass that scrubs every remaining
 * non-binary file (the ~130+ test-harness/audit fixtures, workspaces, prose/config
 * the 6 surfaces never touch) so the fail-closed assert-zero gate has something to
 * pass over — the gate greps the WHOLE tree, so without the whole-tree neutralize a
 * real client clone fails-closed with no mechanism to become clean. If the gate
 * STILL surfaces residual trust-identity it FAILS CLOSED so the client addresses it
 * — the ceremony never silently claims clean; the neutralize FEEDS the gate, never
 * disables it.
 *
 * The "what counts as canon identity" judgement is the SHARED identity-scrub lib
 * (.claude/bin/lib/identity-scrub.mjs) — the same `deriveDynamicTokens` runtime
 * extraction the public-fork fence uses for its DYNAMIC half (incl. the PGP-UID
 * name/email harvest + separator-variant derivation) — so the two fences' dynamic
 * gate cannot drift (MO-OPT W2-0/D2). The publish fence ADDITIONALLY unions a
 * loom-only hand-maintained static residual (EXTRA_IDENTITY_TOKENS) that is
 * DELIBERATELY not shipped into this synced ceremony — relocating it here would
 * ship literal canon identity to every consumer (MO-OPT holistic redteam MO-R1-H2).
 *
 * Node ESM. roster-schema-validate.js is CommonJS (createRequire).
 */
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveDynamicTokens, walkFiles, readTextOrNull, synthHex, makeScrubber, SCRUB_MODES, assertNoSymlinkEscape,
} from "./lib/identity-scrub.mjs";
// clause-e.2 key basenames/suffixes — SAME source the runtime tripwire scans, so the
// clean-instantiate DELETE fence and the committed-key tripwire never drift (redteam #965 R3).
import { FORBIDDEN_KEY_BASENAMES, FORBIDDEN_KEY_SUFFIXES } from "./lib/mesh-keys.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const { validate: validateRoster } = require("../hooks/lib/roster-schema-validate.js");

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { apply: false, root: null, upstreamCanonUrl: null, ecosystemId: "client-ecosystem", resetHistory: false, scannerPath: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--apply") a.apply = true;
    else if (t === "--reset-history") a.resetHistory = true;
    else if (t === "--root") a.root = argv[++i];
    else if (t === "--upstream-canon-url") a.upstreamCanonUrl = argv[++i];
    else if (t === "--ecosystem-id") a.ecosystemId = argv[++i];
    // --scanner-path: TEST-ONLY injection seam (mirrors edition-emit.mjs's
    // checkClientTemplateCompleteness/runOutputDisclosureScan `{ scannerPath }` opt) that
    // overrides assertZero's structural-scanner invocation. ENV-GATED (F7 A23 redteam R2
    // LOW): honored ONLY when process.env.CLEAN_INSTANTIATE_TEST_MODE === "1" -- without that
    // marker the flag is silently IGNORED (falls back to the real scanner), so a production
    // invocation cannot be steered onto a hostile/no-op scanner via this flag. Exists solely
    // so the regression suite can drive assertZero's fail-closed scanner-errored-with-zero-
    // findings branch without touching the real scan-synced-disclosure.mjs. Unset (the
    // default) always resolves to the real scanner, in EVERY invocation mode.
    else if (t === "--scanner-path") {
      const scannerPathArg = argv[++i];
      if (process.env.CLEAN_INSTANTIATE_TEST_MODE === "1") a.scannerPath = scannerPathArg;
      // else: silently ignored (not a usage error) -- the real scanner runs regardless.
    }
    else if (t === "-h" || t === "--help") { a.help = true; }
    else { a.bad = t; }
  }
  return a;
}

function gitToplevel(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
function gitRemoteUrl(dir, remote) {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", remote], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
function gitOriginUrl(dir) {
  return gitRemoteUrl(dir, "origin");
}
/**
 * All configured remote NAMES for `dir` (F7 A23 redteam R2 MED — remote-name completeness
 * gap). A clone with canon-identity history already pushed under a DIFFERENT remote name
 * (e.g. `backup`, `canon-mirror`, or a renamed-then-re-added origin) was previously invisible:
 * `origin` alone read "unpushed" and neither S9's pre-mutation refusal nor S6's post-clear
 * advisory fired for the remote that actually carried the published identity. Callers now
 * enumerate every remote via this helper instead of hardcoding "origin".
 *
 * Mirrors the `gitHistoryCount` fail-closed split (F7 A23 redteam R3 MED — the prior
 * `catch { return [] }` collapsed TWO distinct cases into "safe": (a) genuinely no `.git`
 * / no remotes configured -> SAFE (nothing can be published), and (b) `.git` EXISTS with a
 * real configured remote but `git remote` itself ERRORED (transient I/O, a corrupt
 * `.git/config`, a permission quirk) -> UNKNOWN, which MUST fail-closed rather than read as
 * "no remotes". Without the split, case (b) let the S9 destructive-clear gate
 * (assertOriginNotPublished) proceed even though S9 exists to refuse exactly that when a
 * remote may be published (evidence-first-claims.md MUST-3: an errored probe is never an
 * all-clear).
 * @returns {string[]|null} [] when `dir` genuinely has no `.git` (safe, nothing to enumerate);
 *   the remote-name array on success; `null` when `.git` EXISTS but `git remote` ERRORED
 *   (status UNKNOWN — callers MUST fail-closed, never treat as "no remotes").
 */
function gitAllRemotes(dir) {
  if (!existsSync(path.join(dir, ".git"))) return []; // not a git clone -> no remotes, genuinely safe
  try {
    return execFileSync("git", ["-C", dir, "remote"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch { return null; } // .git present but the command ERRORED -> UNKNOWN (fail-closed)
}
/**
 * Commit count of the clone's history. Returns 0 when there is genuinely no history (no `.git`), and
 * -1 = history-status UNKNOWN when `.git` EXISTS but the count ERRORS (broken git / unreadable object
 * DB). The caller treats -1 as fail-CLOSED (runs the history guidance, assuming history is present)
 * rather than mapping an errored command to "0 commits" -- evidence-first-claims.md MUST-3. Without
 * this split, an errored count silently suppresses the whole S6/S7/S8 fail-closed honesty cluster
 * (which fires only when historyN != 0).
 */
function gitHistoryCount(dir) {
  if (!existsSync(path.join(dir, ".git"))) return 0; // not a git clone -> no history to strip
  try {
    return parseInt(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), 10) || 0;
  } catch { return -1; } // .git present but the count ERRORED -> UNKNOWN (fail-closed)
}

/**
 * S6 — REMOTE-AWARENESS probe (#886 defect-1 / defect-2; F7 A23 redteam R2 MED extended it from a
 * single hardcoded "origin" probe to ANY named remote). The pre-#886 messages said "strip history
 * before pushing", which PRESUMES an unpushed window. But "instantiation is a publish": a repo created
 * FROM canon-as-template already carries canon's objects on a remote server-side BEFORE this ceremony
 * runs, and a published git object CANNOT be deleted by force-push/reset (it is served by SHA even with
 * no ref). This probe distinguishes the two paths for a GIVEN remote so the guidance is HONEST:
 *   - "unpushed"  — the remote has NO refs (a fresh empty remote): the local-clone-then-fresh-push path;
 *                   stripping history BEFORE the first push genuinely works.
 *   - "published" — the remote HAS refs (objects already server-side): destroy+recreate the remote; the real
 *                   fix is SOURCE-PREVENTION (clone the pre-scrubbed template edition, never canon).
 *   - "unknown"   — the probe errored / offline / the named remote doesn't exist: FAIL-CLOSED — an errored
 *                   probe is NOT an all-clear (evidence-first-claims.md MUST-3); treat as published-risk
 *                   (destroy+recreate).
 * DETECTION-ONLY: it cannot remediate, and `ls-remote` sees ref TIPS only — it cannot certify remote
 * OBJECT cleanliness (a dangling published object survives with no ref). The message bounds that.
 * @param {string} dir
 * @param {string} [remote="origin"] the remote NAME to probe. Callers enumerate every configured
 *   remote via gitAllRemotes() rather than hardcoding "origin" — see assertOriginNotPublished (S9)
 *   and emitHistoryGuidance (S6).
 * @returns {"unpushed"|"published"|"unknown"}
 */
function probeRemotePublished(dir, remote = "origin") {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-remote", remote], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
    return out === "" ? "unpushed" : "published";
  } catch {
    return "unknown"; // offline / remote doesn't exist / auth fail → fail-closed, NOT all-clear
  }
}

/**
 * S9 — PRE-CLEAR fail-closed guard (F7 A2/#886/#890 hardening; F7 A23 redteam R2 MED extended it
 * from a single "origin" check to EVERY configured remote). Refuses to run the DESTRUCTIVE clear
 * when `root` has ANY remote that is ALREADY PUBLISHED (carries refs server-side --
 * `probeRemotePublished(root, remote) === "published"`) OR unprobeable-but-configured. A
 * published remote at this point in the ceremony is either:
 *   (a) canon itself — the operator is running the ceremony directly inside canon's own
 *       checkout, where `origin` (unless re-pointed) is git's default = the URL cloned
 *       FROM, and canon is by definition already published; or
 *   (b) a client remote the operator has ALREADY pushed canon-identity-laden history to --
 *       under ANY remote name, not only "origin" (e.g. `backup`, `canon-mirror`, or a
 *       renamed-then-re-added origin). A single-"origin" probe made this class invisible:
 *       `origin` could read "unpushed" while a DIFFERENT remote silently carried the
 *       published canon identity, and neither this gate nor S6's advisory ever fired for it.
 * BOTH are the exact scenario the ceremony exists to prevent (the brief's directive:
 * never silently proceed to delete/mutate against a published canon remote). This is
 * the PRE-mutation gate — the refusal is loud and nonzero BEFORE any file is touched,
 * unlike the POST-clear advisory guidance (S6/S7/S8, emitHistoryGuidance) which only
 * ran after the working tree was already mutated.
 *
 * Per-remote disposition (MED-3 discriminator, extended per-remote): for each configured
 * remote, "published" hard-fails; "unknown" + a resolvable remote URL (the remote IS
 * configured but the probe itself ERRORED -- offline / auth failure / dead remote) is NOT
 * evidence of safety and fail-closes to the SAME "ALREADY PUBLISHED"-risk disposition
 * (evidence-first-claims.md MUST-3: an errored probe is never an all-clear); "unpushed"
 * proceeds. A repo with NO remotes configured AT ALL (a plain `git init`, gitAllRemotes ->
 * []) is the genuinely-safe case -- nothing has ever been pushed anywhere -- and does NOT
 * trip this gate; it remains additionally covered by the fail-closed "assume published"
 * ADVISORY guidance in emitHistoryGuidance (S6), which runs AFTER a successful clear and
 * does not block the ceremony.
 *
 * ONE MORE tier, ABOVE per-remote (F7 A23 redteam R3 MED): if `gitAllRemotes(root)` itself
 * returns `null` -- `.git` EXISTS but the ENUMERATION command (`git remote`) ERRORED (a
 * corrupt `.git/config`, a permission quirk, a broken git binary) -- the gate cannot even
 * learn WHICH remotes are configured, let alone probe them. This is distinct from AND
 * upstream of the "no remotes at all" genuinely-safe disposition above: an enumeration
 * failure is UNKNOWN, not "zero remotes", and fail-closes immediately with a dedicated typed
 * refusal (evidence-first-claims.md MUST-3) BEFORE the per-remote loop ever runs.
 *
 * @param {string} root
 * @returns {{ ok: boolean, error?: string }}
 */
function assertOriginNotPublished(root) {
  const remotes = gitAllRemotes(root);
  if (remotes === null) {
    // .git EXISTS but `git remote` itself ERRORED -- UNKNOWN is NOT an all-clear
    // (evidence-first-claims.md MUST-3). A configured remote may be published and this
    // gate cannot see it; fail-closed with a typed, actionable refusal, distinct from the
    // genuinely-safe "no remotes at all" disposition below.
    return {
      ok: false,
      error:
        "could not enumerate remotes ('git remote' ERRORED even though .git/ exists) -- refusing to " +
        "run the CLEAR ceremony (--apply performs NO mutation when this guard fires): a configured " +
        "remote may be ALREADY PUBLISHED and this gate cannot see it (evidence-first-claims.md MUST-3: " +
        "an errored probe is never an all-clear). Investigate the git error (a corrupt .git/config, a " +
        "permission issue, a broken git binary) and re-run once 'git -C <root> remote' succeeds.",
    };
  }
  if (remotes.length === 0) return { ok: true }; // fresh `git init`, no remotes at all -> genuinely safe

  const failing = [];
  for (const remote of remotes) {
    const status = probeRemotePublished(root, remote);
    if (status === "unpushed") continue; // this remote is safe
    failing.push({ remote, url: gitRemoteUrl(root, remote), status });
  }
  if (failing.length === 0) return { ok: true };

  const lines = failing
    .map(({ remote, url, status }) => {
      const urlPart = url ? ` (${url})` : "";
      const reason =
        status === "published"
          ? "ALREADY PUBLISHED (`git ls-remote` returned refs)"
          : "configured but could NOT be probed (offline / auth failure / dead remote) -- fail-closed: " +
            "an unprobeable CONFIGURED remote is treated as ALREADY-PUBLISHED-risk, NOT an all-clear " +
            "(evidence-first-claims.md MUST-3)";
      return `  - ${remote}${urlPart}: ${reason}`;
    })
    .join("\n");

  return {
    ok: false,
    error:
      `${failing.length} remote(s) are ALREADY PUBLISHED or could NOT be probed -- refusing to run the CLEAR ` +
      "ceremony (--apply performs NO mutation when this guard fires):\n" +
      lines +
      "\n\nEach is either canon itself (a remote still naming the URL you cloned FROM) or a client remote " +
      "you have already pushed canon-identity-laden history to -- both are the disclosure this ceremony " +
      "exists to prevent. Re-point EVERY offending remote to a FRESH, EMPTY remote before running --apply " +
      "(`git remote set-url <remote> <new-empty-remote>`), remove the stale remote entirely " +
      "(`git remote remove <remote>`), or instantiate from the pre-scrubbed client-template edition " +
      "(scripts/publish-to-private-template.mjs) instead of cloning canon directly.",
  };
}

/**
 * S7 — LOCAL object-store scan (#886). assertZero walks the WORKING TREE and SKIPS `.git`, so canon
 * identity in HISTORY (pre-clear journal blobs, commit authorship, the real root_commit) is invisible
 * to it. This scans the LOCAL object store — every blob reachable from any ref (`rev-list --objects
 * --all`) — for the snapshotted canon tokens, so the ceremony can HONESTLY report "your local .git is
 * dirty" rather than only "N commits exist". BOUNDED CLAIM (evidence-first): this sees the LOCAL store
 * ONLY — it CANNOT certify REMOTE cleanliness (the remote may carry unreachable/dangling published
 * objects a local scan never sees). Fail-CLOSED: a scan error returns ok:false (detection did not run
 * → status UNKNOWN, never an all-clear). Capped at `maxBlobs` with a logged truncation (no silent cap).
 * @returns {{ ok: boolean, ran: boolean, hits: string[], scanned: number, truncated: boolean, error?: string }}
 */
function scanObjectStore(root, canonTokens, { maxBlobs = 5000 } = {}) {
  const lc = canonTokens.map((t) => t.toLowerCase());
  const hits = [];
  let scanned = 0, truncated = false;
  try {
    const objs = execFileSync("git", ["-C", root, "rev-list", "--objects", "--all"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      .split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of objs) {
      const sha = line.split(" ")[0];
      if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
      // Only blobs carry content text; skip trees/commits/tags for the token grep (commit AUTHOR
      // identity is caught by the working-tree roster snapshot + the count warning, not here).
      let type;
      try { type = execFileSync("git", ["-C", root, "cat-file", "-t", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { continue; }
      if (type !== "blob") continue;
      if (scanned >= maxBlobs) { truncated = true; break; }
      let content;
      try { content = execFileSync("git", ["-C", root, "cat-file", "-p", sha], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { continue; }
      scanned++; // count only blobs actually READ + grepped (a read failure does not inflate the count)
      // grep ALL blob content: a binary blob won't carry a clean canon-token substring, and if
      // it somehow does, flagging it is the fail-closed direction (no space/NUL pre-filter).
      const lower = content.toLowerCase();
      for (let i = 0; i < lc.length; i++) { if (lower.includes(lc[i])) { hits.push(`blob ${sha.slice(0, 12)}  ~  ${canonTokens[i]}`); break; } }
    }
    return { ok: true, ran: true, hits, scanned, truncated };
  } catch (e) {
    // FAIL-CLOSED: the scan did not complete → status UNKNOWN, never reported as clean.
    return { ok: false, ran: false, hits, scanned, truncated, error: String((e && e.message) || e).slice(0, 200) };
  }
}
/**
 * Re-anchor a fresh git root: a `git clone` of canon carries the ENTIRE canon
 * history in .git/ (commit authorship, pre-clear journal blobs, the real
 * root_commit) — assert-zero walks the WORKING TREE only, so history is the one
 * canon-identity carrier the token gate cannot reach (HIGH-3). --reset-history
 * removes .git and commits the cleared tree as a fresh root, so nothing canon
 * survives a subsequent `git push`.
 */
function resetHistory(root) {
  // The disclosure-critical step is the .git REMOVAL (canon history gone); the
  // re-commit is a convenience. Neutralize inherited global config that could
  // make the commit fail (`commit.gpgsign`, AND `core.hooksPath` → a hostile/
  // inherited pre-commit hook) so a fresh client without signing set up still
  // commits cleanly. Surface a failed commit as an actionable message — never a
  // raw uncaught throw (hook-output-discipline) — and report that history is
  // ALREADY discarded regardless, so the disclosure goal holds either way.
  rmSync(path.join(root, ".git"), { recursive: true, force: true });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "inherit"] });
  try {
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=Clean Instantiation", "-c", "user.email=noreply@example.com",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "-q", "--allow-empty", "-m", "Clean ecosystem instantiation (fresh root)");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
/** Is this tree already a cleared placeholder? (its genesis repo_owner is a PLACEHOLDER- sentinel) */
function isAlreadyCleared(root) {
  const rp = path.join(root, ".claude", "operators.roster.json");
  if (!existsSync(rp)) return false;
  try {
    const g = (JSON.parse(readFileSync(rp, "utf8")) || {}).genesis || {};
    return typeof g.repo_owner === "string" && g.repo_owner.startsWith("PLACEHOLDER-");
  } catch { return false; }
}

// ── filtered canon-token snapshot (drop placeholder + synthetic markers so a
//    re-run over an already-cleared tree does not grep for placeholder tokens) ──
// A synthHex placeholder is "DEADBEEF…" repeated then TRUNCATED to length — so a
// non-multiple-of-8 length (e.g. a future SSH-shaped synthetic) ends mid-"deadbeef"
// and the old /^(deadbeef)+$/ whole-repeat anchor MISSED it (MED-3). Match any
// prefix of the infinite "deadbeef" stream, length-agnostic.
function isSynthHex(t) {
  const low = String(t).toLowerCase();
  if (low.length === 0) return false;
  for (let i = 0; i < low.length; i++) if (low[i] !== "deadbeef"[i % 8]) return false;
  return true;
}
function isPlaceholderToken(t) {
  if (typeof t !== "string") return true;
  if (t.startsWith("PLACEHOLDER-") || t.startsWith("placeholder-")) return true;
  if (isSynthHex(t)) return true;                 // synthHex output (any length)
  if (t === "PLACEHOLDER" || t === "maintainer") return true;
  return false;
}
function snapshotCanonTokens(root) {
  const { gate } = deriveDynamicTokens(root);
  return [...new Set(gate.filter((t) => typeof t === "string" && t.length >= 3 && !isPlaceholderToken(t)))];
}
// Snapshot BOTH the fail-closed gate token list AND the [from,to] scrub pairs in a
// SINGLE pre-clear derive. Both MUST be captured BEFORE performClear resets the
// carriers (roster → placeholder etc.) — a post-clear re-derive returns near-empty,
// so the whole-tree neutralize pass could not clear the tokens the gate greps for.
// gate ⊆ scrub-froms (identity-scrub emits a scrub pair for every gated token), so
// neutralize(scrubPairs) removes exactly what assertZero(canonTokens) greps.
function snapshotCanonIdentity(root) {
  const { gate, scrub } = deriveDynamicTokens(root);
  const canonTokens = [...new Set(gate.filter((t) => typeof t === "string" && t.length >= 3 && !isPlaceholderToken(t)))];
  return { canonTokens, scrubPairs: scrub };
}

// ── placeholder artifacts ────────────────────────────────────────────────────
function placeholderRoster() {
  return {
    $schema: "./operators.roster.schema.json",
    genesis: {
      repo_owner: "PLACEHOLDER-owner",
      repo_owner_kind: "user",
      root_commit: "0000000",
      genesis_generation: 0,
    },
    persons: {
      "PLACEHOLDER-owner": {
        display_id: "placeholder-owner",
        role: "owner",
        host_role: "human",
        github_login: "PLACEHOLDER-owner",
        // keys has minItems 1 (schema) — a schema-valid stub the client's
        // /ecosystem-init replaces. Synthetic uppercase-40-hex fingerprint
        // (DEADBEEF…, filtered out of the assert-zero canon-token snapshot);
        // a NON-PGP-block pubkey so the identity-scrub derive harvests nothing.
        keys: [{ type: "gpg", fingerprint: synthHex("X".repeat(40)), pubkey: "PLACEHOLDER" }],
      },
    },
  };
}
function placeholderEcosystem(upstreamUrl, ecosystemId) {
  return {
    schema_version: 1,
    ecosystem: {
      id: ecosystemId || "client-ecosystem",
      // W2-b: a non-null upstream_canon makes getUpstreamCanon() return a
      // pointer → ecosystem-config recognizes this clone as the FORK side
      // (recognizeBoundary). The fork→canon write-fence's operative ACTIVATION
      // stays #576-gated (the entry-point hook is registered at F3 Level-1;
      // autonomous detection is #576-gated); setting the pointer is the
      // "unblock" S5 needs.
      upstream_canon: { remote: "upstream", url: upstreamUrl || "git@example.com:<canon-org>/<canon-repo>.git" },
    },
    registry: { host: "docker.io", org: "PLACEHOLDER-registry-org" },
    remote_links: {},
    vcs: { default_provider: "github", overrides: {} },
    deploy: { default_targets: [], per_project: {} },
  };
}

// ── the CLEAR steps (only run under --apply) ─────────────────────────────────
function performClear(root, opts) {
  const done = [];
  const claude = path.join(root, ".claude");

  // (a) roster → schema-valid placeholder
  const rosterPath = path.join(claude, "operators.roster.json");
  if (existsSync(rosterPath)) {
    const placeholder = placeholderRoster();
    const res = validateRoster(placeholder);
    if (!res.valid) throw new Error(`placeholder roster failed schema validation: ${JSON.stringify(res.errors)}`);
    writeFileSync(rosterPath, JSON.stringify(placeholder, null, 2) + "\n");
    done.push("roster → placeholder");
  }

  // (b) DELETE journal/ (D1: canon's institutional decisions are not the client's)
  const journalDir = path.join(root, "journal");
  if (existsSync(journalDir)) { rmSync(journalDir, { recursive: true, force: true }); done.push("journal/ → DELETED"); }

  // (c) team-memory: delete signed fact files (promoted_by identity); keep README index
  const tmDir = path.join(claude, "team-memory");
  if (existsSync(tmDir)) {
    let cleared = 0;
    for (const e of readdirSync(tmDir)) {
      if (e === "README.md" || !e.endsWith(".md")) continue;
      rmSync(path.join(tmDir, e), { force: true }); cleared++;
    }
    if (cleared) done.push(`team-memory → ${cleared} fact file(s) cleared`);
  }

  // (d) ecosystem.json → placeholder (+ upstream_canon, W2-b)
  const ecoPath = path.join(claude, "bin", "ecosystem.json");
  if (existsSync(ecoPath)) {
    writeFileSync(ecoPath, JSON.stringify(placeholderEcosystem(opts.upstreamCanonUrl, opts.ecosystemId), null, 2) + "\n");
    done.push("ecosystem.json → placeholder (+ upstream_canon)");
  }

  // (e) disclosure-tenant-denylist → empty
  const denyPath = path.join(claude, "disclosure-tenant-denylist.json");
  if (existsSync(denyPath)) {
    writeFileSync(denyPath, JSON.stringify({ tokens: [] }, null, 2) + "\n");
    done.push("disclosure-tenant-denylist → empty");
  }

  // (f) clear per-repo coordination STATE (gitignored; a raw clone omits them, but
  //     a cp -r / template copy carries them). NOT learning-codified.json (insight,
  //     not identity). The clone-init witness lives outside .claude/learning (F52).
  const learning = path.join(claude, "learning");
  const stateFiles = [
    "coordination-log.jsonl", "coordination-log.jsonl.lock", "posture.json", "posture.json.bak",
    "violations.jsonl", "observations.jsonl", ".initialized", "codify-lease.json",
  ];
  let stateCleared = 0;
  for (const f of stateFiles) { const p = path.join(learning, f); if (existsSync(p)) { rmSync(p, { force: true }); stateCleared++; } }
  for (const w of [path.join(root, ".git", "coc-clone-init-witness"), path.join(claude, "learning", ".coc-clone-init-witness")]) {
    if (existsSync(w)) { rmSync(w, { force: true }); stateCleared++; }
  }
  if (stateCleared) done.push(`coordination state → ${stateCleared} file(s) cleared`);

  // (g) DELETE scripts/publish-to-public.mjs — canon→PUBLIC-fork publish tooling.
  //     Disposition: EXCLUDE (delete), NOT neutralize. It is loom-only (already in
  //     community-membership.mjs EXCLUDE_WITHIN + KILL_BASENAMES — never ships to any
  //     non-canon surface), it is hard-wired to CANON's specific public fork + org, so
  //     it is meaningless to a client's own ecosystem, AND its loom-only STATIC_SCRUB /
  //     EXTRA_IDENTITY_TOKENS literals carry canon identity the DYNAMIC gate cannot
  //     derive (e.g. gh-login variants, a canon project name, a lowercased tenant token,
  //     the email domain). The whole-tree NEUTRALIZE pass below clears every token the
  //     gate greps, but those non-derivable static literals are gate-invisible — so
  //     scrubbing would leave a half-neutralized broken script still carrying real canon
  //     identity. Deleting removes them wholesale, consistent with the file's existing
  //     never-ships-downstream status. If a client later wants public-fork publishing,
  //     that is net-new ecosystem-parameterized work, not canon's hard-wired script.
  const publishTooling = path.join(root, "scripts", "publish-to-public.mjs");
  if (existsSync(publishTooling)) { rmSync(publishTooling, { force: true }); done.push("scripts/publish-to-public.mjs → DELETED (loom-only canon-publish tooling)"); }

  // (h) DELETE the mesh LOCAL HANDLE VAULT — the client↔handle DEANONYMIZATION
  //     map (knowledge-mesh spec 02 clause (e.4)). Disposition: DELETE (not
  //     neutralize), the same class as journal/ above: the vault is per-ecosystem
  //     deanonymization data (canon's client↔handle pairs), meaningless AND
  //     disclosure-critical to a client. A client instantiated from a template
  //     that carried the vault would inherit canon's FULL client↔handle mapping.
  //     Keys never live in a file (env/keychain only, clause e.2), so the file is
  //     the map alone; deleting it removes the deanonymization table wholesale.
  //     The registry tuples + node records under .claude/mesh/ are HANDLES-ONLY
  //     (no readable names — they cannot deanonymize) and are left for the
  //     whole-tree neutralize + assert-zero gate to handle like any other file.
  //     BASENAME-ANYWHERE walk (redteam #965 R1): a `cp -r`'d template may carry
  //     the vault at a NON-default nested path (per-level monorepo topology) or
  //     a rename/backup (handle-vault.json.bak) that an exact-path delete + the
  //     canon-token assert-zero (blind to client-name content) would BOTH miss,
  //     letting the client inherit canon's client↔handle map. Delete every
  //     handle-vault.json* basename anywhere in the tree, case-insensitively.
  //     KEY MATERIAL (clause e.2) — the higher-value secret — gets the SAME cp -r
  //     defense on this leg (redteam #965 R3 F-CLEAN-KEY). A `cp -r`'d working tree
  //     carries gitignored files, so a stray canon `.claude/mesh/k_eco`/`k`/`*.key`
  //     survives the gitignore commit-fence AND is invisible to the canon-token
  //     assert-zero (a random-hex key carries no identity token) — the fork would
  //     inherit canon's content-commitment/minting key. Scoped to a `.claude/mesh/`
  //     dir (NOT basename-anywhere) to match the gitignore + tripwire scope and
  //     spare a legit `foo.pem` elsewhere in the fork; the basename/suffix set is
  //     imported from mesh-keys so it can never drift from the tripwire.
  const meshDirFrag = `${path.sep}.claude${path.sep}mesh${path.sep}`;
  let meshVaultDeleted = 0, meshKeyDeleted = 0;
  walkFiles(root, (f) => {
    if (f.includes(`${path.sep}.git${path.sep}`)) return; // never touch the .git object store
    const base = path.basename(f).toLowerCase();
    if (base.startsWith("handle-vault.json")) {
      rmSync(f, { force: true }); meshVaultDeleted++;
      return;
    }
    if (
      f.includes(meshDirFrag) &&
      (FORBIDDEN_KEY_BASENAMES.has(base) || FORBIDDEN_KEY_SUFFIXES.some((s) => base.endsWith(s)))
    ) {
      rmSync(f, { force: true }); meshKeyDeleted++;
    }
  });
  if (meshVaultDeleted) done.push(`mesh handle-vault.json → ${meshVaultDeleted} DELETED (client↔handle deanonymization map, basename-anywhere; spec-02 clause e.4)`);
  if (meshKeyDeleted) done.push(`mesh key material → ${meshKeyDeleted} DELETED (.claude/mesh/-scoped; a cp -r carries gitignored key files; spec-02 clause e.2)`);

  return done;
}

// ── whole-tree NEUTRALIZE pass ───────────────────────────────────────────────
// performClear's 6 structured surfaces neutralize only the coordination substrate
// (roster/journal/team-memory/ecosystem/tenant-denylist/state). But assertZero greps
// the WHOLE working tree for every canon token, and canon identity ALSO lives across
// ~130+ unstructured files the 6 surfaces never touch (test-harness fixtures, audit
// fixtures, workspaces, prose/config). Without this pass, assertZero correctly
// fails-closed on a real client clone but the ceremony gives the client no mechanism
// to neutralize those files. This pass walks every non-binary tracked file and applies
// the shared identity-scrub in NEUTRALIZE mode (placeholder pairs + operator-home-path
// scrub, NO real substitute identity), writing back the neutralized content — so the
// tokens the fail-closed backstop greps are actually removed BEFORE it runs.
//
// It is FED BY the pre-clear scrub pairs (snapshotCanonIdentity) — a post-clear
// re-derive returns near-empty. It PRESERVES the ecosystem.json upstream_canon.url
// exemption by SKIPPING that one file (performClear rewrote it to a placeholder whose
// ONLY canon token is the legit upstream_canon.url a fork is REQUIRED to name; the
// token-gate exemption in assertZero handles that file's grep). It NEVER weakens
// assertZero — it feeds it; assertZero remains the fail-closed backstop after this runs.
function neutralizeWholeTree(root, scrubPairs) {
  // assertZero greps case-INSENSITIVELY (it lowercases both the token and the file),
  // but the shared makeScrubber replaces case-SENSITIVELY (the publish fence handles
  // case by ENUMERATING both forms in its loom-only STATIC_SCRUB — a mechanism this
  // synced ceremony deliberately lacks). A canon token whose on-disk case differs from
  // the derived SSOT case (e.g. denylist `<TENANT>` vs a path token `<tenant>-<region>`) would then
  // survive the neutralize yet still trip assertZero — the exact defect-4 "fails-closed
  // with no mechanism" this shard closes. Since identity-scrub.mjs (S1) is case-sensitive
  // by contract and MUST NOT change here, augment each [from,to] pair with its lower- and
  // upper-case variants so makeScrubber clears every case assertZero can match. (The `to`
  // placeholders — "a downstream tenant" / "<canon-owner>" / synthHex — never re-introduce
  // a token, so the augmentation cannot loop.)
  const augmented = [];
  for (const [from, to] of scrubPairs) {
    for (const v of new Set([from, from.toLowerCase(), from.toUpperCase()])) augmented.push([v, to]);
  }
  const scrub = makeScrubber(augmented, { mode: SCRUB_MODES.NEUTRALIZE });
  // SHAPE-PRESERVE *.test.mjs disclosure fixtures: a second scrubber that applies
  // the SAME dynamic canon-token pairs but routes the structural operator-home-path
  // rewrite through a SYNTHETIC-USERNAME ALLOWLIST (identity-scrub.mjs's
  // SYNTHETIC_FIXTURE_USERS). loom's disclosure TESTS (e.g. sync-from-canon.test.mjs)
  // plant a SYNTHETIC `/Users/jdoe/...` operator-home shape as a fixture so the REAL
  // scanner fires and the test verifies the halt path; an unconditional homepath
  // rewrite would rewrite that fixture to `/Users/<user>/`, which the scanner then
  // EXCLUDES — silently neutering the disclosure test (a green test that verifies
  // nothing) in the client fork. The allowlist preserves ONLY recognized synthetic
  // fixture usernames and STILL rewrites any OTHER operator home — including a REAL
  // contributor's non-token macOS home — so a real operator-PII home in a *.test.mjs
  // cannot survive into the client's new ecosystem (the #1141-7 rt1-security leak the
  // prior blanket skip opened; the SOURCE-mode scanner ALSO excludes *.test.mjs from
  // every shape, so the homepath rewrite is the only defense for a non-token home).
  // The dynamic canon-IDENTITY scrub STILL runs on *.test.mjs (a real canon token in
  // a test file is still neutralized — many loom *.test.mjs carry derived canon tokens
  // the scrub must clear for a real canon clone to pass; the exact count is runtime-
  // derived against a live canon clone, not statically knowable here), and assertZero's
  // canon-token grep still covers *.test.mjs as the fail-closed backstop.
  const scrubTestFixture = makeScrubber(augmented, { mode: SCRUB_MODES.NEUTRALIZE, preserveSyntheticFixtureHomes: true });
  const ECO_REL = path.join(".claude", "bin", "ecosystem.json");
  let neutralized = 0;
  walkFiles(root, (f) => {
    if (f.includes(`${path.sep}.git${path.sep}`)) return; // never rewrite the .git object store
    const rel = path.relative(root, f);
    if (rel === ECO_REL) return; // preserve the ceremony's own placeholder + upstream_canon.url
    const before = readTextOrNull(f); if (before === null) return; // binary → skip (fail-safe)
    // *.test.mjs → homepath-skipping scrubber (shape-preserve synthetic fixtures);
    // every other file → full neutralize (real operator homes MUST be rewritten).
    const isTestFixture = /\.test\.mjs$/.test(path.basename(f));
    const after = (isTestFixture ? scrubTestFixture : scrub)(before);
    if (after !== before) { writeFileSync(f, after); neutralized++; }
  });
  return neutralized;
}

// ── fail-closed assert-zero gate ─────────────────────────────────────────────
/**
 * @param {string} root
 * @param {string[]} canonTokens
 * @param {{ scannerPath?: string }} [opts]  scannerPath overrides the structural-scanner
 *   invocation below -- TEST-ONLY seam (see parseArgs's `--scanner-path`, ENV-GATED on
 *   process.env.CLEAN_INSTANTIATE_TEST_MODE === "1"), mirrors edition-emit.mjs's
 *   `runOutputDisclosureScan(tree, repoRoot, { scannerPath })`. Unset (the default,
 *   `undefined` — always the case outside CLEAN_INSTANTIATE_TEST_MODE) always resolves to
 *   the real scan-synced-disclosure.mjs.
 */
function assertZero(root, canonTokens, opts = {}) {
  const lc = canonTokens.map((t) => t.toLowerCase());
  const hits = [];
  const ECO_REL = path.join(".claude", "bin", "ecosystem.json");
  walkFiles(root, (f) => {
    if (f.includes(`${path.sep}.git${path.sep}`)) return; // skip the .git object store
    // Binary → SKIP here (fail-safe on THIS ceremony). INTENTIONAL divergence from edition-emit.mjs's
    // checkClientTemplateCompleteness LAYER 3, which fails CLOSED on any binary (#886 Wave-2 gate LOW-2):
    // clean-instantiate operates on a CLIENT's already-cloned tree that may legitimately carry the
    // client's OWN binary content (logos, PDFs) — failing closed on every binary would block the
    // ceremony on the client's own files. edition-emit CREATES the seed FROM canon, where a binary is
    // suspicious, so it fails closed. Residual (moot at 0 tracked canon binaries): a client cloning a
    // tree with a canon-bearing binary passes this CLEAR ceremony green while the EMIT fence would have
    // blocked — acceptable because emit is the PRIMARY M1 source-prevention path and the client owns
    // their tree's binaries. A raw NUL-corrupted SOURCE reads as binary here too, but the emit LAYER 3
    // is the fence that catches that class at the source (the client-template is built by emit, not clean).
    let txt = readTextOrNull(f); if (txt === null) return;
    const rel = path.relative(root, f);
    // MO-OPT holistic post-multi-wave redteam (MO-OPT-1): the ceremony's OWN
    // placeholder ecosystem.json legitimately carries upstream_canon.url = the
    // canon clone URL (git@host:<repo_owner>/<repo>.git) — a fork is REQUIRED to
    // name the canon it forked from (W2-b). That URL CONTAINS repo_owner, which
    // the CRIT-1 genesis harvest puts in the canon-token snapshot, so the
    // documented DEFAULT invocation (origin-derived URL, no --upstream-canon-url)
    // would token-hit its OWN legitimate pointer and fail closed. Redact ONLY the
    // upstream_canon.url VALUE before the grep — any canon token ELSEWHERE in this
    // file (e.g. a registry.org the clear missed) still fails. Token-gate twin of
    // the structural-scanner ecosystem.json exemption below.
    if (rel === ECO_REL) {
      try {
        const eco = JSON.parse(txt);
        const url = eco && eco.ecosystem && eco.ecosystem.upstream_canon && eco.ecosystem.upstream_canon.url;
        if (typeof url === "string" && url) txt = txt.split(url).join("<upstream-canon-url>");
      } catch { /* unparseable → grep the raw text (fail-closed) */ }
    }
    const lower = txt.toLowerCase();
    for (let i = 0; i < lc.length; i++) if (lower.includes(lc[i])) hits.push(`${rel}  ~  ${canonTokens[i]}`);
  });
  // Structural disclosure shapes (home paths, org slugs, hostnames the literal
  // token list lacks) — reuse the framework's own Gate-2 scanner over the tree.
  // The scanner flags `.claude/bin/ecosystem.json` under --root by design (in a
  // CONSUMER tree it would be a never-synced leak), but the clean-instantiate
  // CLIENT legitimately OWNS its ecosystem.json and its upstream_canon pointer
  // necessarily names a canon org — NOT residual canon identity. Drop findings
  // on that one ceremony-written placeholder; the token gate above still scans
  // its content for actual canon tokens. Any OTHER structural finding fails.
  let scannerFindings = [];
  let scannerErrored = false;
  const scannerBin = opts.scannerPath || path.join(SCRIPT_DIR, "scan-synced-disclosure.mjs");
  try {
    // stdio pipe (not the default that lets the child's stderr reach the
    // console) so the scanner's findings are CAPTURED into e.stderr for the
    // filter — never leaked raw to the operator's terminal, and never silently
    // un-captured (which would make the structural cross-check a no-op).
    execFileSync("node", [scannerBin, "--check", "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const rawOut = (e.stdout || "") + (e.stderr || "");
    const rawFindings = rawOut.split("\n").map((l) => l.trim()).filter((l) => /\[SHAPE:/.test(l));
    if (rawFindings.length === 0) {
      // FAIL-CLOSED (evidence-first-claims.md MUST-3 / F7 A2 — the ceremony is a VERIFIER
      // here, not a trust actor). The scanner exits 1 with `[SHAPE:…]` lines for a genuine
      // finding, and exit 0 (no catch at all) for a genuinely clean run — so entering this
      // catch with ZERO `[SHAPE:]` lines means the scanner did NOT run to completion (a bad
      // arg, a malformed input file, an uncaught exception), which is NOT the same as
      // "0 findings". Silently converting that into a pass is exactly the "cleaner treated
      // as trust actor" failure mode this gate exists to close — treat it as scanner-status
      // UNKNOWN, never an all-clear.
      scannerErrored = true;
    } else {
      // EXACT-path anchor (HIGH-2): the scanner emits `<relpath>:<line>  [SHAPE:…]`,
      // so require ecosystem.json to be followed by the `:<line>` separator. A
      // `startsWith` prefix would also drop a sibling like `ecosystem.json.bak` /
      // `ecosystem.json.d/leak.md` — letting a structural shape on an adversarial
      // sibling escape the gate. Only the ceremony's OWN ecosystem.json is exempt.
      scannerFindings = rawFindings.filter((l) => !/^\.claude\/bin\/ecosystem\.json:\d/.test(l));
    }
  }
  return {
    hits,
    scannerOk: !scannerErrored && scannerFindings.length === 0,
    scannerOut: scannerErrored
      ? "structural scanner exited WITHOUT emitting any [SHAPE:] findings -- it did NOT run to " +
        "completion (fail-closed, NOT an all-clear); investigate the scan-synced-disclosure.mjs " +
        "invocation (bad args / malformed input file / uncaught exception)."
      : scannerFindings.slice(0, 30).join("\n"),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
/**
 * S6+S7 — HONEST, probe-aware .git-history guidance (#886 defect-1/2). The pre-#886 message said
 * "strip history before pushing", which PRESUMES an unpushed window. Because "instantiation is a
 * publish", canon objects may ALREADY be on origin server-side (a published git object cannot be
 * deleted by force-push/reset). This runs (S7) the LOCAL object-store scan for canon tokens in
 * history, then (S6) the remote-awareness probe, and emits guidance scoped to the ACTUAL path.
 * DETECTION-ONLY: it certifies the LOCAL store only and cannot certify REMOTE cleanliness.
 * @param {boolean} applied  true in the APPLY path (worktree already cleared), false in DRY RUN
 */
function emitHistoryGuidance(root, historyN, canonTokens, applied) {
  const histDesc = historyN < 0
    ? "an UNDETERMINED number of (git history count ERRORED -- fail-closed: assume history PRESENT)"
    : `${historyN} commit(s) of`;
  console.log(`\u26a0 .git/ carries ${histDesc} canon HISTORY (authorship, pre-clear blobs, the real root_commit) -- NOT reached by the working-tree clear.`);
  // S7 -- scan the LOCAL object store (assertZero skips .git; history is the carrier it cannot reach).
  const store = scanObjectStore(root, canonTokens);
  if (!store.ran) {
    console.log(`  \u26a0 .git/ object-store scan DID NOT RUN (${store.error || "error"}) -- history canon-status UNKNOWN (fail-closed: assume dirty).`);
  } else if (store.hits.length) {
    const bound = store.truncated ? ` (first ${store.scanned} blob(s), TRUNCATED)` : ` (${store.scanned} blob(s))`;
    console.log(`  \u26a0 .git/ LOCAL object store carries ${store.hits.length} canon-token hit(s) in history${bound}:`);
    for (const h of store.hits.slice(0, 20)) console.log(`       ${h}`);
  } else {
    const bound = store.truncated ? ` (first ${store.scanned} blob(s) scanned, TRUNCATED -- more unscanned)` : ` (${store.scanned} blob(s) scanned)`;
    console.log(`  .git/ local object store: 0 canon-token hits${bound}. This certifies the LOCAL store ONLY -- it CANNOT certify REMOTE cleanliness (a dangling published object survives with no ref).`);
  }
  // S6 -- remote-awareness: is ANY configured remote already carrying published objects?
  // (F7 A23 redteam R2 MED: extended from a single hardcoded "origin" probe to every remote --
  // a canon-identity push under a non-"origin" name, e.g. `backup`/`canon-mirror`, was
  // previously invisible to this advisory.) A repo with NO remotes configured at all is
  // checked against the conventional "origin" name for messaging -- matches the pre-multi-remote
  // behavior: this is the ADVISORY layer (never blocks), so it stays fail-closed/assume-published
  // even when nothing has been pushed anywhere yet, unlike S9's pre-mutation gate above (which
  // treats the truly-no-remotes-configured case as safe).
  // F7 A23 redteam R3 MED: gitAllRemotes() can now return `null` (.git present, `git remote`
  // ERRORED -- status UNKNOWN). This advisory layer folds that into the SAME fail-closed
  // "probe origin by name / assume published" path as the empty-array case below -- it already
  // never treats absence-of-evidence as an all-clear, so `null` needs no separate branch, only
  // a truthy-array guard that does not throw on `null.length`.
  const remotes = gitAllRemotes(root);
  if (remotes === null) {
    console.log(`  ⚠ could not enumerate remotes ('git remote' ERRORED even though .git/ exists) -- remote-status UNKNOWN, treated as if a remote may be published (fail-closed).`);
  }
  const remoteNamesToWarn = remotes && remotes.length ? remotes : ["origin"];
  let anyRemoteRisk = false;
  for (const remote of remoteNamesToWarn) {
    const status = probeRemotePublished(root, remote);
    if (status === "unpushed") {
      console.log(`  remote '${remote}' has NO refs (fresh/unpushed) -- the local-clone-then-fresh-push path. Re-run with --reset-history (or strip history) BEFORE the first push to '${remote}'; that genuinely prevents canon objects reaching it.`);
      continue;
    }
    anyRemoteRisk = true;
    const why = status === "published"
      ? `remote '${remote}' ALREADY carries objects`
      : `remote '${remote}' could NOT be probed (offline / no such remote / auth) -- fail-closed: assume published`;
    console.log(`  ${why}. A published git object CANNOT be deleted by force-push/reset (served by SHA even with no ref), so "strip before pushing" does NOT help here:`);
    console.log(`    -> DESTROY + RECREATE the remote repo (delete it, create a fresh empty one), then push the cleared tree.`);
  }
  if (anyRemoteRisk) {
    console.log(`    -> PREVENT AT THE SOURCE: instantiate from the pre-scrubbed client-template edition (scripts/publish-to-private-template.mjs), never from a canon clone -- the client template never carries canon objects.`);
  }
  if (!applied) console.log(`  (DRY RUN -- no clear performed yet; --apply runs the clear + fail-closed gate.)`);
}


function main() {
  const a = parseArgs(process.argv);
  if (a.help) { console.log("usage: clean-instantiate.mjs [--apply] [--reset-history] [--root <dir>] [--upstream-canon-url <url>] [--ecosystem-id <label>]"); return 0; }
  if (a.bad) { console.error(`unknown argument: ${a.bad}`); return 2; }

  const root = a.root ? path.resolve(a.root) : (gitToplevel(process.cwd()) || process.cwd());
  if (!existsSync(path.join(root, ".claude"))) { console.error(`✗ ${root} has no .claude/ — not a COC repo`); return 2; }

  // HIGH — symlink-escape / arbitrary-file-write guard (holistic redteam; made
  // UNCONDITIONAL by the F7 redteam MEDIUM/LOW-2 fix — see
  // identity-scrub.mjs::assertNoSymlinkEscape for the guard's own doc + why it now
  // lives there). walkFiles (identity-scrub.mjs) resolves entries with statSync,
  // which FOLLOWS symlinks and recurses THROUGH a symlinked dir. A git-tracked
  // symlink (mode 120000) materializes as a real OS symlink on checkout, so EVERY
  // walkFiles-driven pass in this ceremony would follow it: neutralizeWholeTree's
  // `writeFileSync(f, after)` would write THROUGH the symlink to whatever it points
  // at, and BOTH the DRY-RUN preview's assertZero AND the --apply branch's assertZero
  // read walk would read through it too — either way, a symlink whose target sits
  // OUTSIDE `root` turns this ceremony into a write (or read) against an arbitrary
  // path on the client's machine.
  //
  // This assertion now runs UNCONDITIONALLY, at the top of main(), immediately after
  // resolving `root` — BEFORE isAlreadyCleared (reads operators.roster.json), BEFORE
  // gitOriginUrl/upstreamCanonUrl resolution, BEFORE the DRY-RUN preview's assertZero,
  // and BEFORE the --apply branch's performClear/neutralizeWholeTree/assertZero — so a
  // DRY RUN (the default, no-flag invocation) is guarded exactly like --apply, not only
  // the destructive path. Pre-fix, this guard sat inside `if (a.apply)`, so the
  // documented default (dry-run) invocation walked + read the tree with NO symlink
  // check at all. No step in this ceremony CREATES a symlink (performClear /
  // neutralizeWholeTree only writeFileSync / rmSync already-known paths), so this
  // single up-front assertion covers every later read/write walk with no
  // re-materialization needed — nothing between here and assertZero can (re-)introduce
  // an escaping symlink. On a hit, this throws; the ceremony hard-fails (nonzero exit)
  // with NO prior mutation, never a partial clear.
  try {
    assertNoSymlinkEscape(root);
  } catch (e) {
    console.error(`✗ ${e && e.message ? e.message : String(e)}`);
    console.error("  refusing to run clean-instantiate (no read/mutation of the tree when this guard fires).");
    return 2;
  }

  if (!a.upstreamCanonUrl) a.upstreamCanonUrl = gitOriginUrl(root); // the URL the client cloned canon from

  // MED-1: a re-run cannot re-derive the canon snapshot — the carriers are
  // already placeholders, so deriveDynamicTokens returns near-empty and the gate
  // would FALSE-pass even if the first run left residue. Refuse rather than
  // silently claim clean; verification belongs against the FIRST run's output.
  if (a.apply && isAlreadyCleared(root)) {
    console.error(`✗ ${root} is already cleared (roster genesis is a PLACEHOLDER-).\n` +
      `  Re-running --apply cannot re-derive the canon snapshot (the carriers are gone), so it\n` +
      `  cannot honestly re-verify. If you need to confirm the clear, check the FIRST run's output,\n` +
      `  or re-clone canon and run --apply once. (To re-anchor your OWN ecosystem, use /ecosystem-init.)`);
    return 2;
  }

  // S9 — PRE-CLEAR fail-closed guard: refuse (nonzero, NO mutation) rather than clear a tree
  // whose origin is already a published remote (canon itself, or a client remote already
  // pushed to). Runs only when the tree is NOT already cleared (a fresh, un-cleared tree is
  // exactly the risky case; an already-cleared tree that later got pushed is the correct,
  // safe end state and MUST NOT be blocked here).
  if (a.apply) {
    const remoteGuard = assertOriginNotPublished(root);
    if (!remoteGuard.ok) {
      console.error(`✗ ${remoteGuard.error}`);
      return 2;
    }
  }

  // Snapshot the gate tokens AND the scrub pairs in ONE pre-clear derive (the
  // neutralize pass below needs the pairs; a post-clear re-derive returns empty).
  const { canonTokens, scrubPairs } = snapshotCanonIdentity(root);
  console.log(`\n=== clean-instantiate (${a.apply ? "APPLY" : "DRY RUN"}) — root: ${root} ===`);
  console.log(`canon trust-identity tokens snapshotted: ${canonTokens.length}`);

  if (!a.apply) {
    const preview = assertZero(root, canonTokens, { scannerPath: a.scannerPath });
    const historyN = gitHistoryCount(root);
    console.log(`\nDRY RUN — would clear: roster→placeholder · journal/ DELETE · team-memory facts · ecosystem.json→placeholder · tenant-denylist→empty · coordination state · scripts/publish-to-public.mjs DELETE · mesh handle-vault.json DELETE · whole-tree NEUTRALIZE`);
    console.log(`current tree carries ${preview.hits.length} canon-token occurrence(s) across ${new Set(preview.hits.map((h) => h.split("  ~  ")[0])).size} file(s) (these would be cleared/surfaced).`);
    console.log(`upstream_canon would be set to: ${a.upstreamCanonUrl || "(placeholder)"}`);
    if (historyN !== 0) emitHistoryGuidance(root, historyN, canonTokens, false); // != 0: >0 real history OR -1 errored-unknown -> fail-closed
    console.log(`\nRun with --apply to perform the clear + whole-tree neutralize + fail-closed assert-zero gate.`);
    return 0;
  }

  const done = performClear(root, a);
  console.log("\nCLEARED:"); for (const d of done) console.log(`  ✓ ${d}`);

  // Whole-tree NEUTRALIZE — clear the ~130+ token-carrying files the 6 structured
  // surfaces above never touch (test-harness/audit fixtures, workspaces, prose/config),
  // BEFORE the fail-closed assert-zero backstop greps for them. Fed by the pre-clear
  // scrub pairs; skips .git + the ceremony's own ecosystem.json (upstream_canon.url).
  const neutralized = neutralizeWholeTree(root, scrubPairs);
  console.log(`  ✓ whole-tree neutralize → ${neutralized} file(s) rewritten`);

  const { hits, scannerOk, scannerOut } = assertZero(root, canonTokens, { scannerPath: a.scannerPath });
  console.log("");
  if (hits.length || !scannerOk) {
    console.error(`✗ ASSERT-ZERO FAILED — residual canon identity remains in the WORKING TREE (nothing is "clean"):`);
    for (const h of hits.slice(0, 40)) console.error("   " + h);
    if (!scannerOk) { console.error("   structural scanner findings:"); console.error(scannerOut); }
    return 1;
  }
  console.log(`✓ WORKING-TREE ASSERT-ZERO PASSED — 0 canon trust-identity tokens + structural scanner clean.`);

  // HIGH-3: the working tree is clean, but a `git clone` of canon retains the
  // ENTIRE canon history in .git/ — the one carrier assert-zero cannot reach.
  // Never claim the CLONE is clean while that history exists; either reset it
  // (opt-in, destructive) or scope the claim + direct the operator loudly.
  const historyN = gitHistoryCount(root);
  if (historyN !== 0) {
    if (historyN > 0 && a.resetHistory) {
      const rr = resetHistory(root);
      if (rr.ok) {
        console.log(`✓ HISTORY RESET — .git/ re-anchored to a fresh root commit (${historyN} canon commit(s) discarded).`);
      } else {
        console.log(`✓ canon .git/ HISTORY DISCARDED (${historyN} commit(s) removed), but the fresh commit did not complete: ${rr.error}`);
        console.log(`  → run \`git -C ${root} add -A && git -C ${root} commit -m "Clean ecosystem instantiation"\` manually. Canon history is already gone — safe to push once committed.`);
      }
    } else {
      emitHistoryGuidance(root, historyN, canonTokens, true);
    }
  }
  console.log(`\nNext: run /ecosystem-init to re-anchor genesis to YOUR owner, then /enroll operators.`);
  return 0;
}

process.exit(main());
