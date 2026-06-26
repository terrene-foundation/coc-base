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
 * tenant-denylist). Bare org-slug genericization in PROSE is the publish-fence's
 * concern (clients clone the already-scrubbed public distribution); if the
 * assert-zero gate surfaces residual prose trust-identity it FAILS CLOSED so the
 * client addresses it — the ceremony never silently claims clean.
 *
 * The "what counts as canon identity" judgement is the SHARED identity-scrub lib
 * (.claude/bin/lib/identity-scrub.mjs) — the exact gate the public-fork fence
 * uses — so the two fences cannot drift (MO-OPT W2-0/D2).
 *
 * Node ESM. roster-schema-validate.js is CommonJS (createRequire).
 */
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDynamicTokens, walkFiles, readTextOrNull, synthHex } from "./lib/identity-scrub.mjs";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const { validate: validateRoster } = require("../hooks/lib/roster-schema-validate.js");

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { apply: false, root: null, upstreamCanonUrl: null, ecosystemId: "client-ecosystem", resetHistory: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--apply") a.apply = true;
    else if (t === "--reset-history") a.resetHistory = true;
    else if (t === "--root") a.root = argv[++i];
    else if (t === "--upstream-canon-url") a.upstreamCanonUrl = argv[++i];
    else if (t === "--ecosystem-id") a.ecosystemId = argv[++i];
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
function gitOriginUrl(dir) {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
/** Commit count of the clone's history (0 if not a git repo / no commits). */
function gitHistoryCount(dir) {
  try {
    return parseInt(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), 10) || 0;
  } catch { return 0; }
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

  return done;
}

// ── fail-closed assert-zero gate ─────────────────────────────────────────────
function assertZero(root, canonTokens) {
  const lc = canonTokens.map((t) => t.toLowerCase());
  const hits = [];
  walkFiles(root, (f) => {
    if (f.includes(`${path.sep}.git${path.sep}`)) return; // skip the .git object store
    const txt = readTextOrNull(f); if (txt === null) return;
    const lower = txt.toLowerCase();
    const rel = path.relative(root, f);
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
  try {
    // stdio pipe (not the default that lets the child's stderr reach the
    // console) so the scanner's findings are CAPTURED into e.stderr for the
    // filter — never leaked raw to the operator's terminal, and never silently
    // un-captured (which would make the structural cross-check a no-op).
    execFileSync("node", [path.join(SCRIPT_DIR, "scan-synced-disclosure.mjs"), "--check", "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    scannerFindings = ((e.stdout || "") + (e.stderr || ""))
      .split("\n").map((l) => l.trim()).filter((l) => /\[SHAPE:/.test(l))
      // EXACT-path anchor (HIGH-2): the scanner emits `<relpath>:<line>  [SHAPE:…]`,
      // so require ecosystem.json to be followed by the `:<line>` separator. A
      // `startsWith` prefix would also drop a sibling like `ecosystem.json.bak` /
      // `ecosystem.json.d/leak.md` — letting a structural shape on an adversarial
      // sibling escape the gate. Only the ceremony's OWN ecosystem.json is exempt.
      .filter((l) => !/^\.claude\/bin\/ecosystem\.json:\d/.test(l));
  }
  return { hits, scannerOk: scannerFindings.length === 0, scannerOut: scannerFindings.slice(0, 30).join("\n") };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const a = parseArgs(process.argv);
  if (a.help) { console.log("usage: clean-instantiate.mjs [--apply] [--reset-history] [--root <dir>] [--upstream-canon-url <url>] [--ecosystem-id <label>]"); return 0; }
  if (a.bad) { console.error(`unknown argument: ${a.bad}`); return 2; }

  const root = a.root ? path.resolve(a.root) : (gitToplevel(process.cwd()) || process.cwd());
  if (!existsSync(path.join(root, ".claude"))) { console.error(`✗ ${root} has no .claude/ — not a COC repo`); return 2; }
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

  const canonTokens = snapshotCanonTokens(root);
  console.log(`\n=== clean-instantiate (${a.apply ? "APPLY" : "DRY RUN"}) — root: ${root} ===`);
  console.log(`canon trust-identity tokens snapshotted: ${canonTokens.length}`);

  if (!a.apply) {
    const preview = assertZero(root, canonTokens);
    const historyN = gitHistoryCount(root);
    console.log(`\nDRY RUN — would clear: roster→placeholder · journal/ DELETE · team-memory facts · ecosystem.json→placeholder · tenant-denylist→empty · coordination state`);
    console.log(`current tree carries ${preview.hits.length} canon-token occurrence(s) across ${new Set(preview.hits.map((h) => h.split("  ~  ")[0])).size} file(s) (these would be cleared/surfaced).`);
    console.log(`upstream_canon would be set to: ${a.upstreamCanonUrl || "(placeholder)"}`);
    if (historyN > 0) console.log(`⚠ .git/ carries ${historyN} commit(s) of canon HISTORY (authorship, pre-clear blobs, the real root_commit) — NOT cleared by the working-tree clear. Pass --reset-history to re-anchor a fresh root, or strip history before pushing.`);
    console.log(`\nRun with --apply to perform the clear + fail-closed assert-zero gate.`);
    return 0;
  }

  const done = performClear(root, a);
  console.log("\nCLEARED:"); for (const d of done) console.log(`  ✓ ${d}`);

  const { hits, scannerOk, scannerOut } = assertZero(root, canonTokens);
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
  if (historyN > 0) {
    if (a.resetHistory) {
      const rr = resetHistory(root);
      if (rr.ok) {
        console.log(`✓ HISTORY RESET — .git/ re-anchored to a fresh root commit (${historyN} canon commit(s) discarded).`);
      } else {
        console.log(`✓ canon .git/ HISTORY DISCARDED (${historyN} commit(s) removed), but the fresh commit did not complete: ${rr.error}`);
        console.log(`  → run \`git -C ${root} add -A && git -C ${root} commit -m "Clean ecosystem instantiation"\` manually. Canon history is already gone — safe to push once committed.`);
      }
    } else {
      console.log(`\n⚠ .git/ STILL CARRIES ${historyN} COMMIT(S) OF CANON HISTORY (commit authorship, pre-clear`);
      console.log(`  journal blobs, the real root_commit). The working tree is clean, but this history WILL`);
      console.log(`  ship on \`git push\`. Re-run with --reset-history to re-anchor a fresh root, OR strip`);
      console.log(`  history yourself, BEFORE pushing. Do NOT treat the clone as canon-free until then.`);
    }
  }
  console.log(`\nNext: run /ecosystem-init to re-anchor genesis to YOUR owner, then /enroll operators.`);
  return 0;
}

process.exit(main());
