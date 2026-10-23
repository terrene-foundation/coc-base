#!/usr/bin/env node
/**
 * handover-render.mjs — validate a cycle-handover SEED, then project it.
 *
 * @what CYCLE.md shard S2 (`workspaces/context-budget-2026-10-10/design/CYCLE.md`
 *       §1.4 step 3, §2.1–§2.3). Two subcommands:
 *         validate  structural check of a seed against the fixed schema: the
 *                   five resume questions answerable, `resume=` token present,
 *                   ≤ 8,000 bytes (target 4,000). Over the cap is REFUSED,
 *                   never truncated. Writes nothing.
 *         render    validate, then run the writer-side BINDING
 *                   (lib/handover-render.mjs::handoverBinding: written= within skew
 *                   of the tool's stamp; ASSIGNMENT declared, its ledger readable,
 *                   holding the objective verbatim and fresh; one OWNED line per
 *                   delegated session), then — only if both accept — write every projection
 *                   (session-notes fragment CURRENT section, declared ledger
 *                   events, forest ledger, vault pair) and print a receipt in
 *                   which each projection is `ok | skipped | failed`.
 *
 * @why  The handover must be bounded and must not need a human at any step. One
 *       tool call turns the agent-written seed into every durable record; a
 *       surface that cannot be written is reported, never prompted for.
 *
 * @usage
 *   node .claude/bin/handover-render.mjs validate <seed-file> [--json]
 *   node .claude/bin/handover-render.mjs render <seed-file> [--repo DIR]
 *        [--fragment FILE] [--events FILE] [--vault DIR] [--json]
 *
 *   --repo      repo root (default: nearest ancestor of cwd holding .claude/)
 *   --fragment  session-notes fragment to render into (default: the resolved
 *               operator's `.session-notes.d/<id>.md`)
 *   --events    JSON array of {item_id, item, value_anchor, status} transitions
 *               to append (authority=agent, source=handover-render)
 *   --vault     vault handover dir (else $COC_VAULT_HANDOVER_DIR, else
 *               .claude/bin/vault-handover.local.json); none ⇒ declared skip
 *
 * @distribution SHIPS: on `ALWAYS_INCLUDE` in `sync-tier-aware.mjs:1843-1846`
 *   (2026-10-10), because the shipped `/wrapup --cycle` invokes it. The vault
 *   PATH stays operator-local (`*.local.json` is LOOM_LOCAL_PATTERNS-fenced); a
 *   consumer with no vault gets a declared `skipped`.
 *
 * After a SUCCESSFUL render the handover is STAMPED into this terminal's
 * `coc-context-state/v1` record via `hooks/lib/context-state.js::stampHandover`
 * (CYCLE.md §4.3) — the only writer that can make `boundary.ready` true. The
 * record lives under $CLAUDE_CONFIG_DIR; that variable is REQUIRED for the stamp
 * and its path is never guessed. "rendered" and "stamped" are DISTINCT outcomes
 * (receipt fields `rendered`, `stamped`, `stamp`; top-level `ok` = both), and a
 * render that was not stamped is NEVER reported as a completed handover. The
 * seed must be `<main-checkout>/.claude/learning/handoff/seed-<token>.md`
 * (≤ 8,000 B) or the stamp refuses it.
 *
 * @exit 0 accepted (validate) / rendered AND stamped (render)
 *       1 seed REFUSED (schema, or the handover binding) — nothing was projected
 *       2 usage error, or the seed file is unreadable
 *       3 render: at least one projection FAILED (or the seed moved mid-render);
 *         the stamp is NOT attempted
 *       4 render: every projection ok/skipped, but NOT STAMPED — CLAUDE_CONFIG_DIR
 *         is unset or not an existing directory (no boundary can fire)
 *       5 render: every projection ok/skipped, but the stamp REFUSED (seed
 *         re-hash mismatch, seed outside the handoff dir / misnamed / over cap,
 *         or the state record unwritable) — no boundary can fire
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { handoverBinding, renderProjections, roleField, stampRenderedHandover } from "./lib/handover-render.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_LIB = path.join(HERE, "..", "hooks", "lib");
const seedLib = require(path.join(HOOK_LIB, "handover-seed.js"));

const USAGE = `usage:
  handover-render.mjs validate <seed-file> [--json]
  handover-render.mjs render   <seed-file> [--repo DIR] [--fragment FILE] [--events FILE] [--vault DIR] [--json]`;

function usage(msg) {
  process.stderr.write(`handover-render: ${msg}\n${USAGE}\n`);
  return 2;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const valued = new Set(["--repo", "--fragment", "--events", "--vault"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.flags.json = true;
    else if (valued.has(a)) {
      const v = argv[++i];
      if (!v) return { error: `${a} requires a value` };
      out.flags[a.slice(2)] = v;
    } else if (a.startsWith("--")) return { error: `unknown flag ${a}` };
    else out._.push(a);
  }
  return out;
}

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".claude"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function printValidation(v, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: v.ok, refused: v.refused, bytes: v.bytes, sha256: v.sha256, target_bytes: v.target_bytes, cap_bytes: v.cap_bytes, header: v.header, findings: v.findings, warnings: v.warnings }, null, 2)}\n`);
    return;
  }
  const lines = [seedLib.summarize(v)];
  for (const f of v.findings) lines.push(`  [${f.code}] ${f.section}${f.question ? ` (Q${f.question})` : ""}: ${f.detail}`);
  for (const w of v.warnings) lines.push(`  warning: ${w}`);
  (v.ok ? process.stdout : process.stderr).write(`${lines.join("\n")}\n`);
}

/** The real dependencies — the same modules the hooks use, never re-implemented. */
function realDeps() {
  const operatorId = require(path.join(HOOK_LIB, "operator-id.js"));
  const layout = require(path.join(HOOK_LIB, "session-notes-layout.js"));
  const events = require(path.join(HOOK_LIB, "burndown-events.js"));
  const vaultCli = path.join(HERE, "vault-handover.mjs");
  return {
    resolveIdentity: (repo) => operatorId.resolveIdentity(repo),
    fragmentPathFor: layout.fragmentPathFor,
    // Identity AND key, both required to sign — the pairing todo-durable-guard
    // learned end-to-end (identity alone refuses every append).
    resolveSigning: (repo) => {
      const id = operatorId.resolveIdentity(repo);
      const key = operatorId._discoverSigningKey(repo, {});
      if (!id || !id.verified_id || !id.person_id) {
        return { why: !id ? "no identity resolved" : !id.verified_id ? "no verified_id (no signing key configured)" : "no person_id (un-rostered — run /whoami --register)" };
      }
      if (!key || !key.keyPath) return { why: "no signing key discovered (set `git config user.signingkey`)" };
      return {
        identity: { verified_id: id.verified_id, person_id: id.person_id, display_id: id.display_id },
        signOpts: { keyType: key.keyType, keyPath: key.keyPath },
      };
    },
    readEventsLog: (repo) => {
      try {
        return fs.readFileSync(path.join(repo, "burndown", "events.jsonl"), "utf8");
      } catch (e) {
        if (e && e.code === "ENOENT") return "";
        throw e;
      }
    },
    foldProjection: events.foldProjection,
    buildEvent: events.buildEvent,
    appendEvent: events.appendEvent,
    regenerateForestLedger: (repo) => layout.regenerateForestLedger(repo),
    runVaultCli: (args) => spawnSync(process.execPath, [vaultCli, ...args], { encoding: "utf8", timeout: 30000 }),
  };
}

function hookRecordFor(v, repoRoot) {
  try {
    const stateLib = require(path.join(HOOK_LIB, "context-state.js"));
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (!cfg) return {};
    const st = stateLib.readState(stateLib.locateState({ configDir: cfg, repoDir: repoRoot, pid: process.ppid }));
    const h = st.state === "ok" && st.data && st.data.handover;
    if (!h || h.seed_sha256 !== v.sha256) return {};
    const first = Date.parse(h.first_written_at || h.written_at || "");
    return {
      seedWrittenMs: Number.isFinite(first) ? first : undefined,
      transcriptPath: typeof h.transcript_path === "string" && path.isAbsolute(h.transcript_path) ? h.transcript_path : null,
    };
  } catch (e) {
    process.stderr.write(`handover-render: the seed-write record could not be read (${(e && e.message) || e}) — anchoring on the render clock, no transcript\n`);
    return {};
  }
}

function main(argv) {
  const sub = argv[0];
  if (sub === "-h" || sub === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (sub !== "validate" && sub !== "render") return usage(sub ? `unknown subcommand "${sub}"` : "a subcommand is required");
  const args = parseArgs(argv.slice(1));
  if (args.error) return usage(args.error);
  if (args._.length !== 1) return usage("exactly one <seed-file> is required");

  const seedPath = path.resolve(args._[0]);
  const repoRoot = path.resolve(args.flags.repo || findRepoRoot(process.cwd()) || process.cwd());
  let seedBuf;
  try {
    seedBuf = fs.readFileSync(seedPath);
  } catch (e) {
    process.stderr.write(`handover-render: cannot read seed ${seedPath}: ${e.message}\n`);
    return 2;
  }
  const v = seedLib.validateSeed(seedBuf, { repoDir: repoRoot });

  if (sub === "validate") {
    printValidation(v, args.flags.json);
    return v.ok ? 0 : 1;
  }

  if (!v.ok) {
    printValidation(v, args.flags.json);
    process.stderr.write("handover-render: seed REFUSED — no projection was written.\n");
    return 1;
  }

  if (!args.flags.repo && !findRepoRoot(process.cwd())) return usage("no repo root found from cwd; pass --repo");

  // The writer-side binding (stamp vs written=, ASSIGNMENT + ledger, OWNED collapse) runs
  // on the SAME clock reading the projections carry, so the refusal and the record agree.
  // The seed-write HOOK's record for THESE bytes (sha-bound): its clock anchors the skew and
  // age checks (S4) and its transcript is where the objective is traced to the owner (S1).
  // No record for these bytes ⇒ the render's own clock, and no transcript (refused if an
  // objective is declared).
  const hook = hookRecordFor(v, repoRoot);
  const binding = handoverBinding(v, { nowMs: Date.now(), seedWrittenMs: hook.seedWrittenMs, transcriptPath: hook.transcriptPath });
  if (!binding.ok) {
    printValidation({ ...v, ok: false, refused: true, findings: binding.findings }, args.flags.json);
    process.stderr.write("handover-render: seed REFUSED by the handover binding — no projection was written.\n");
    return 1;
  }

  const receipt = renderProjections(
    {
      seedPath,
      seedBuf,
      seedText: seedBuf.toString("utf8"),
      validation: v,
      repoRoot,
      trunk: roleField(v, "trunk") || "unknown",
      fragmentPath: args.flags.fragment ? path.resolve(args.flags.fragment) : null,
      eventsFile: args.flags.events ? path.resolve(args.flags.events) : null,
      vaultFlag: args.flags.vault || null,
      env: process.env,
      stampMs: binding.stamp.ms,
    },
    realDeps(),
  );

  const stateLib = require(path.join(HOOK_LIB, "context-state.js"));
  const handoffLib = require(path.join(HOOK_LIB, "compaction-handoff.js"));
  const stamp = stampRenderedHandover(
    { receipt, repoRoot, env: process.env, pid: process.ppid },
    { stampHandover: stateLib.stampHandover, resolveHandoffDir: handoffLib.resolveHandoffDir, locateState: stateLib.locateState },
  );
  receipt.rendered = receipt.ok;
  receipt.stamp = stamp;
  receipt.stamped = stamp.status === "stamped";
  receipt.ok = receipt.rendered && receipt.stamped;
  const rc = !receipt.rendered ? 3 : receipt.stamped ? 0 : stamp.code === "no-config-dir" ? 4 : 5;

  if (!receipt.rendered) {
    /* the INCOMPLETE line below carries it; the stamp was not attempted */
  } else if (!receipt.stamped) {
    process.stderr.write(`handover-render: RENDERED but NOT STAMPED (exit ${rc}) — ${stamp.detail}. No boundary can fire on this handover.\n`);
  }

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    const head = !receipt.rendered ? "HANDOVER INCOMPLETE" : receipt.stamped ? "HANDOVER WRITTEN" : "HANDOVER RENDERED NOT STAMPED";
    const out = [`${head} ${v.sha256.slice(0, 8)} — ${v.bytes} B, resume ${v.header.resume_token}`];
    for (const [name, p] of Object.entries(receipt.projections)) out.push(`  ${name.padEnd(13)} ${p.status.padEnd(7)} ${p.detail}`);
    for (const e of receipt.handover.errors.filter((x) => x.startsWith("seed"))) out.push(`  seed          failed  ${e}`);
    out.push(`  ${"stamp".padEnd(13)} ${stamp.status.padEnd(7)} ${stamp.detail}`);
    for (const w of receipt.warnings) out.push(`  warning: ${w}`);
    process.stdout.write(`${out.join("\n")}\n`);
  }
  return rc;
}

process.exitCode = main(process.argv.slice(2));
