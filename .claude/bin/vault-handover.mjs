#!/usr/bin/env node
/**
 * vault-handover.mjs — derive, verify, and archive the Obsidian vault handover pair.
 *
 * @what The runnable face of `CLAUDE.md` § STANDING DIRECTIVE — Vault Handover.
 *       Three subcommands:
 *         plan     — derive TODAY's per-day `##` and print every representation
 *                    of it a session must write (filenames, frontmatter `seq`,
 *                    `pairs_with`, and the absolute paths the `/clear` seed
 *                    names). Read the strings from here; never re-derive them.
 *         verify   — the gate. Reds when a pair's filename `##`, frontmatter
 *                    `seq`, `pairs_with` or fenced seed paths disagree, or when
 *                    a seed path does not resolve, or when a pair is half-present.
 *         archive  — move a pair into `archive/` and rewrite its dependent
 *                    fields, or refuse. Never a bare `mv`.
 *
 * @why  Before this tool the directive was executed entirely by hand and nothing
 *       could disagree with the result. Measured 2026-09-15: the live pair was
 *       named `-01-` (the correct per-day `##`) while its frontmatter `seq`, its
 *       body prose and its `/clear` seed all said `08` (the per-session count),
 *       so the seed sent the next session to two files that do not exist and its
 *       first two reads failed. See `lib/vault-handover.mjs` for the full
 *       measurement and the five invariants.
 *
 * @usage
 *   node .claude/bin/vault-handover.mjs plan [--date YYYY-MM-DD] [--json]
 *   node .claude/bin/vault-handover.mjs verify [--json]
 *   node .claude/bin/vault-handover.mjs verify --fix
 *   node .claude/bin/vault-handover.mjs archive <YYYY-MM-DD-##> [--apply]
 *
 * @vault-path resolution, in order — the operator's path is NEVER hardcoded here
 *   (this file is source-controlled; the path is per-operator, and baking it in
 *   would put an operator path into a distributable tree):
 *     1. --vault <dir>
 *     2. $COC_VAULT_HANDOVER_DIR
 *     3. .claude/bin/vault-handover.local.json :: handover_dir
 *   Unresolvable => LOUD refusal naming all three, never a guess. The path for
 *   THIS operator is written in `CLAUDE.md` § STANDING DIRECTIVE.
 *
 * @distribution SHIPS since 2026-10-10: `.claude/bin/**` is fail-closed since
 *   F1030d (#1051), and this file is an explicit `ALWAYS_INCLUDE` entry
 *   (`sync-tier-aware.mjs:1843-1846`) because the shipped `handover-render.mjs`
 *   spawns it. The PATH never ships: `.claude/bin/*.local.json` is fenced by
 *   LOOM_LOCAL_PATTERNS. Verify rather than trust: `sync-tier-aware.mjs --dry-run`.
 *
 * @exit 0 clean · 1 findings (verify) / refusal (archive) · 2 usage or config error
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ARCHIVE_SUBDIR,
  KINDS,
  collectEntries,
  derivePlan,
  deriveNextSeq,
  handoverBasename,
  looseHandoverName,
  normalizeFile,
  pad2,
  parseHandoverName,
  resolveVaultDir as resolveVaultDirIn,
  VAULT_LOCAL_CONFIG,
  verifyEntries,
} from "./lib/vault-handover.mjs";

const LOCAL_CONFIG = VAULT_LOCAL_CONFIG;

function fail(msg, code = 2) {
  process.stderr.write(`vault-handover: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--apply" || a === "--fix" || a === "--all") {
      out.flags[a.slice(2)] = true;
    } else if (a === "--vault" || a === "--date") {
      const v = argv[++i];
      if (!v) fail(`${a} requires a value`);
      out.flags[a.slice(2)] = v;
    } else if (a.startsWith("--")) {
      fail(`unknown flag ${a}`);
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * Resolve the vault directory. Refuses loudly rather than guessing. The ORDER
 * lives in `lib/vault-handover.mjs::resolveVaultDir`, shared with
 * `handover-render.mjs`; this function only owns the CLI's refusal text.
 */
function resolveVaultDir(flagValue) {
  const r = resolveVaultDirIn({
    flag: flagValue,
    env: process.env.COC_VAULT_HANDOVER_DIR,
    repoRoot: findRepoRoot(),
  });
  if (r.ok) return r.dir;
  const tried = r.tried;
  // An EXPLICIT --vault that does not resolve is a HARD ERROR, never a
  // fallthrough. Falling through to $COC_VAULT_HANDOVER_DIR meant a typo'd
  // flag silently operated on a DIFFERENT vault — and on the writing paths
  // (`--fix`, `archive --apply`) that rewrites and moves files in a directory
  // the operator did not name, with no warning and a success exit.
  if (r.kind === "explicit-not-dir") {
    fail(
      `--vault ${flagValue} is not a directory.\n` +
        `  An explicitly named vault that does not resolve is refused outright — it is NOT\n` +
        `  silently replaced by $COC_VAULT_HANDOVER_DIR or the local config, because a typo\n` +
        `  would then rewrite or move files in a vault you did not name.`,
    );
  }
  if (r.kind === "config-unreadable") fail(r.reason);
  fail(
    `cannot resolve the vault handover directory.\n` +
      `  Tried, in order:\n` +
      (tried.length ? tried.map((t) => `    - ${t} (not a directory)`).join("\n") + "\n" : "") +
      `    - --vault <dir>\n` +
      `    - $COC_VAULT_HANDOVER_DIR\n` +
      `    - ${LOCAL_CONFIG} :: handover_dir\n` +
      `  The path for this operator is written in CLAUDE.md ` +
      `§ STANDING DIRECTIVE — Vault Handover. It is deliberately not hardcoded here.`,
  );
}

/**
 * Subdirectories this tool never opens. Reported WITH a clean verdict so the
 * verdict carries its own scope rather than implying whole-vault coverage.
 */
function listUnscannedSubdirs(vaultDir) {
  try {
    return fs
      .readdirSync(vaultDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ARCHIVE_SUBDIR)
      .map((d) => `${d.name}/`)
      .sort();
  } catch {
    return [];
  }
}

function findRepoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, ".claude"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Every handover basename in the vault, live dir AND archive — the seq population. */
function allHandoverNames(vaultDir) {
  const names = [];
  for (const dir of [vaultDir, path.join(vaultDir, ARCHIVE_SUBDIR)]) {
    let listing;
    try {
      listing = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const base of listing) {
      if (parseHandoverName(base) || looseHandoverName(base)) names.push(base);
    }
  }
  return names;
}

function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
  ].join("-");
}

// ── plan ────────────────────────────────────────────────────────────────────
function cmdPlan(args) {
  const vaultDir = resolveVaultDir(args.flags.vault);
  const date = args.flags.date ?? todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got "${date}"`);
  const seq = deriveNextSeq(date, allHandoverNames(vaultDir));
  const plan = derivePlan({ date, seq, vaultDir });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  const out = [];
  out.push(`vault:  ${vaultDir}`);
  out.push(`date:   ${date}`);
  out.push(`##:     ${plan.seq}   (per-day sequence, derived from what is already on disk)`);
  out.push("");
  out.push("Write EXACTLY these two files — copy the strings, do not re-derive them:");
  for (const kind of KINDS) {
    const f = plan.files[kind];
    out.push("");
    out.push(`  ${f.absolutePath}`);
    out.push(`    ---`);
    out.push(`    date: ${f.frontmatter.date}`);
    out.push(`    seq: "${f.frontmatter.seq}"`);
    out.push(`    kind: ${f.frontmatter.kind}`);
    out.push(`    title: <one line>`);
    out.push(`    repo: loom`);
    out.push(`    trunk: <branch>`);
    out.push(`    tags: [...]`);
    out.push(`    pairs_with: "${f.frontmatter.pairs_with}"`);
    out.push(`    ---`);
  }
  out.push("");
  out.push("The /clear seed inside the wrapup's fenced block MUST name these two paths:");
  for (const p of plan.seedPaths) out.push(`  ${p}`);
  out.push("");
  out.push("Then gate it:  node .claude/bin/vault-handover.mjs verify");
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

// ── verify ──────────────────────────────────────────────────────────────────
function cmdVerify(args) {
  const vaultDir = resolveVaultDir(args.flags.vault);
  const archiveDir = path.join(vaultDir, ARCHIVE_SUBDIR);
  const entries = [...collectEntries(vaultDir), ...collectEntries(archiveDir, { archived: true })];

  if (entries.length === 0) {
    fail(
      `no handover files found under ${vaultDir} (or its ${ARCHIVE_SUBDIR}/). ` +
        `An empty population makes this check non-discriminating, so it refuses ` +
        `rather than reporting a clean run.`,
    );
  }

  if (args.flags.fix) return applyFix(vaultDir, archiveDir, entries, args);

  const findings = verifyEntries(entries);
  if (args.flags.json) {
    process.stdout.write(
      `${JSON.stringify({ vault: vaultDir, files_checked: entries.length, findings }, null, 2)}\n`,
    );
    return findings.length ? 1 : 0;
  }

  if (findings.length === 0) {
    // State the SCOPE with the verdict. "CLEAN" alone invites reading a
    // partial pass as a whole-vault one, and the directories this never opens
    // are silent in a way indistinguishable from a true negative
    // (`rules/instrument-discipline.md` MUST-3).
    const unscanned = listUnscannedSubdirs(vaultDir);
    process.stdout.write(
      `vault-handover: CLEAN — ${entries.length} handover files, all six invariants hold.\n` +
        `  scope: ${vaultDir} and ${ARCHIVE_SUBDIR}/ only.\n` +
        (unscanned.length
          ? `  NOT SCANNED (${unscanned.length} other subdir(s), no verdict either way): ${unscanned.join(", ")}\n`
          : `  no other subdirectories present.\n`),
    );
    return 0;
  }

  const lines = [
    `vault-handover: ${findings.length} finding(s) across ${entries.length} handover files in ${vaultDir}`,
    "",
  ];
  for (const f of findings) lines.push(`  [${f.code}] ${f.file}\n      ${f.detail}`);
  lines.push("");
  lines.push(
    `Remediate with --fix (derives every field FROM THE FILENAME, which the directive defines as the per-day ##), or correct by hand.`,
  );
  process.stderr.write(`${lines.join("\n")}\n`);
  return 1;
}

function applyFix(vaultDir, archiveDir, entries, args) {
  const changedFiles = [];
  const refused = [];
  for (const e of entries) {
    if (!parseHandoverName(e.basename)) {
      refused.push(
        `${e.basename}: filename is not conforming; --fix derives from the filename and will not guess a pair's identity. Rename it, then re-run.`,
      );
      continue;
    }
    let result;
    try {
      result = normalizeFile({ basename: e.basename, text: e.text, seedDir: e.dir });
    } catch (err) {
      refused.push(`${e.basename}: ${err.message}`);
      continue;
    }
    if (result.changed.length === 0) continue;
    fs.writeFileSync(path.join(e.dir, e.basename), result.text);
    changedFiles.push({ file: e.basename, dir: e.dir, changed: result.changed });
  }

  const post = verifyEntries([
    ...collectEntries(vaultDir),
    ...collectEntries(archiveDir, { archived: true }),
  ]);

  const out = [];
  out.push(`vault-handover --fix: rewrote ${changedFiles.length} file(s)`);
  for (const c of changedFiles) {
    out.push(`  ${c.file}`);
    for (const d of c.changed) out.push(`      ${d}`);
  }
  for (const r of refused) out.push(`  REFUSED ${r}`);
  out.push("");
  out.push(
    post.length === 0
      ? `post-fix verify: CLEAN`
      : `post-fix verify: ${post.length} finding(s) REMAIN — these need a human:`,
  );
  for (const f of post) out.push(`  [${f.code}] ${f.file}\n      ${f.detail}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return post.length || refused.length ? 1 : 0;
}

// ── archive ─────────────────────────────────────────────────────────────────
function cmdArchive(args) {
  const vaultDir = resolveVaultDir(args.flags.vault);
  const stem = args._[0];
  if (!stem || !/^\d{4}-\d{2}-\d{2}-\d{2}$/.test(stem)) {
    fail(`archive requires a pair stem YYYY-MM-DD-## (got "${stem ?? ""}")`);
  }
  const [date, seq] = [stem.slice(0, 10), stem.slice(11)];
  const archiveDir = path.join(vaultDir, ARCHIVE_SUBDIR);

  const members = KINDS.map((kind) => ({
    kind,
    basename: handoverBasename(date, seq, kind),
    from: path.join(vaultDir, handoverBasename(date, seq, kind)),
    to: path.join(archiveDir, handoverBasename(date, seq, kind)),
  }));

  const missing = members.filter((m) => !fs.existsSync(m.from));
  if (missing.length) {
    fail(
      `REFUSED — the directive requires TWO files, never one, and archiving half a pair strands the other.\n` +
        missing.map((m) => `  absent: ${m.from}`).join("\n"),
      1,
    );
  }
  const occupied = (file) => {
    try { fs.lstatSync(file); return true; }
    catch (e) { if (e.code === "ENOENT") return false; throw e; }
  };
  const canonicalVault = fs.realpathSync(vaultDir);
  if (occupied(archiveDir)) {
    const st = fs.lstatSync(archiveDir);
    if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(archiveDir) !== path.join(canonicalVault, ARCHIVE_SUBDIR)) {
      fail("REFUSED — archive directory is not a contained real directory", 1);
    }
  }
  const collisions = members.filter((m) => occupied(m.to));
  if (collisions.length) {
    fail(
      `REFUSED — destination already occupied; this tool never overwrites a handover:\n` +
        collisions.map((m) => `  exists: ${m.to}`).join("\n"),
      1,
    );
  }

  if (!args.flags.apply) {
    const lines = [`archive ${stem} (dry run — pass --apply to perform it)`];
    for (const m of members) lines.push(`  ${m.from}\n    -> ${m.to}`);
    lines.push(
      `  and rewrite each file's fenced seed paths to ${archiveDir}/ so they still resolve after the move.`,
    );
    lines.push(
      `  pairs_with needs NO rewrite: it is a slug-free wikilink, which is why the directive requires that shape.`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // PREPARE BOTH MEMBERS BEFORE TOUCHING THE DISK.
  //
  // The earlier shape normalized-and-moved one member at a time, so a
  // `normalizeFile` throw on the SECOND member (a wrapup with no frontmatter,
  // say) left the first already written to archive/ and unlinked from the
  // source — the tool severing the very pair whose two-ness its own refusal
  // exists to enforce, and reporting it as an uncaught stack trace. Every
  // failure that can be detected from CONTENT is now raised while the disk is
  // still untouched.
  const prepared = [];
  for (const m of members) {
    const text = fs.readFileSync(m.from, "utf8");
    let next;
    try {
      ({ text: next } = normalizeFile({ basename: m.basename, text, seedDir: archiveDir }));
    } catch (e) {
      fail(
        `REFUSED — cannot prepare ${m.basename} for the move, so NOTHING was moved:\n` +
          `  ${e.message}\n` +
          `  Both members are still in place. Fix that file, then re-run.`,
        1,
      );
    }
    prepared.push({ ...m, next });
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  if (fs.lstatSync(archiveDir).isSymbolicLink() || fs.realpathSync(archiveDir) !== path.join(canonicalVault, ARCHIVE_SUBDIR)) {
    fail("REFUSED — archive directory changed or escapes the vault", 1);
  }
  const moved = [];
  // Write every destination BEFORE unlinking any source, so an interruption
  // mid-loop leaves both copies rather than half a pair.
  for (const m of prepared) fs.writeFileSync(m.to, m.next, { flag: "wx", mode: 0o600 });
  for (const m of prepared) {
    fs.unlinkSync(m.from);
    moved.push(m);
  }

  const post = verifyEntries(collectEntries(archiveDir, { archived: true }));
  const relevant = post.filter((f) => f.file.startsWith(stem));
  const out = [`archived ${stem}:`];
  for (const m of moved) out.push(`  ${m.from} -> ${m.to}`);
  out.push(
    relevant.length === 0
      ? `  post-move verify on the moved pair: CLEAN`
      : `  post-move verify: ${relevant.length} finding(s) on the moved pair:`,
  );
  for (const f of relevant) out.push(`    [${f.code}] ${f.file} — ${f.detail}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return relevant.length ? 1 : 0;
}

// ── dispatch ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const sub = argv[0];
const args = parseArgs(argv.slice(1));

const USAGE = `usage:
  vault-handover.mjs plan    [--date YYYY-MM-DD] [--vault DIR] [--json]
  vault-handover.mjs verify  [--vault DIR] [--json | --fix]
  vault-handover.mjs archive <YYYY-MM-DD-##> [--vault DIR] [--apply]`;

switch (sub) {
  case "plan":
    process.exitCode = cmdPlan(args);
    break;
  case "verify":
    process.exitCode = cmdVerify(args);
    break;
  case "archive":
    process.exitCode = cmdArchive(args);
    break;
  case "-h":
  case "--help":
  case undefined:
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = sub === undefined ? 2 : 0;
    break;
  default:
    fail(`unknown subcommand "${sub}"\n${USAGE}`);
}
