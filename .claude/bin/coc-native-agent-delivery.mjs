#!/usr/bin/env node
// Reconcile only prior receipt-owned native agents; unknown files never become owned.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readDeliveryLock, isOwnedBy } from './coc-delivery-lock.mjs';
import { assertPrivateOrgConfig, assertTreeFreeOfPrivateIdentity } from './lib/strip-build-internal.mjs';
import gitSubprocessEnv from '../hooks/lib/git-subprocess-env.js';

const { resolveGitBinary, gitEnv } = gitSubprocessEnv;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// The declaration THIS installed tree would gate from (the helper is installed
// into the consumer's tree at `.claude/bin/`, so this resolves THAT tree's file).
const CANON_IDENTITY_PATH = path.resolve(SCRIPT_DIR, '..', 'canon-identity-values.json');

/** True when a canon identity DECLARATION file exists (r4-v6 LOW-2). Mirrors
 * `emit-cli-artifacts.mjs::canonIdentityConfigPresent`: ENOENT alone is the
 * consumer case; any OTHER access failure counts as PRESENT so the assert path
 * runs and fails closed on the read error (only absence is benign). Promotion
 * into `lib/strip-build-internal.mjs` is the right end state; local here
 * because the shared lib is outside this round's file set. */
function canonIdentityConfigPresent() {
  try {
    fs.accessSync(CANON_IDENTITY_PATH, fs.constants.F_OK);
    return true;
  } catch (e) {
    return !(e && e.code === 'ENOENT');
  }
}
const GENERATOR = 'coc-native-agent-delivery.mjs';
const RECEIPT = '.codex/native-agents-receipt.json';
const CATALOG = '.codex/agents';
const AGENT = /^\.codex\/agents\/[a-z][a-z0-9_-]*\.toml$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function rootDirectory(value) {
  const root = path.resolve(value);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`root is not an ordinary directory: ${root}`);
  // Resolve platform aliases (/tmp on macOS) once; descendants are checked below.
  return fs.realpathSync(root);
}
function contained(root, relative, kind = 'file') {
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    const stat = exists(cursor);
    if (!stat) return null;
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) {
      throw new Error(`unsafe path component: ${relative}`);
    }
    if (i === parts.length - 1 && !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) {
      throw new Error(`unexpected path type: ${relative}`);
    }
  }
  return cursor;
}
function bytesAt(root, relative) {
  const file = contained(root, relative);
  if (!file) return null;
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error(`file exceeds delivery limit: ${relative}`);
  return fs.readFileSync(file);
}
function same(a, b) { return a === null ? b === null : b !== null && a.equals(b); }
function parseReceipt(bytes) {
  if (bytes === null) return { files: {} };
  const receipt = JSON.parse(bytes.toString('utf8'));
  if (receipt.schema_version !== 1 || receipt.generator !== GENERATOR ||
      !/^[a-f0-9]{40}$/.test(receipt.source_commit || '') || !receipt.files ||
      Array.isArray(receipt.files) || typeof receipt.files !== 'object') throw new Error('invalid native-agent receipt');
  for (const [relative, digest] of Object.entries(receipt.files)) {
    if (!AGENT.test(relative) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid receipt path or digest');
  }
  return receipt;
}
function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--source', '--target', '--source-commit'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) {
      throw new Error('usage: --source <emitted-root> --target <repo-root> --source-commit <40-hex-sha>');
    }
    args[argv[i]] = argv[i + 1];
  }
  if (!args['--source'] || !args['--target'] || !/^[a-f0-9]{40}$/.test(args['--source-commit'] || '')) throw new Error('source, target and actual source commit are required');
  return args;
}
function reconcile(args) {
  const source = rootDirectory(args['--source']);
  const target = rootDirectory(args['--target']);
  const within = (a, b) => a === b || b.startsWith(a + path.sep);
  if (within(source, target) || within(target, source)) throw new Error('source and target must be separate trees');
  const gitBin = resolveGitBinary();
  const git = (...argv) => execFileSync(gitBin, ['-C', target, ...argv], { encoding: 'utf8', env: gitEnv(), timeout: 10000 });
  if (fs.realpathSync(git('rev-parse', '--show-toplevel').trim()) !== target) throw new Error('target must be the Git checkout root');
  const currentOwnership = readDeliveryLock(target);
  if (currentOwnership.state !== 'ok') throw new Error(`current ownership evidence is ${currentOwnership.state}; no files changed`);
  for (const rel of ['.claude/sync-preserve.yaml', '.claude/sync-preserve.local.yaml']) {
    if (exists(path.join(target, rel))) throw new Error(`${rel} requires preservation review; no files changed`);
  }
  const catalog = contained(source, CATALOG, 'directory');
  if (!catalog) throw new Error('emitted native-agent catalog is missing (empty must be explicit)');
  contained(target, CATALOG, 'directory');
  const receiptBytes = bytesAt(target, RECEIPT);
  const previous = parseReceipt(receiptBytes);
  const expected = new Map();
  for (const name of fs.readdirSync(catalog).sort()) {
    const rel = `${CATALOG}/${name}`;
    if (!AGENT.test(rel)) throw new Error(`unexpected emitted catalog entry: ${name}`);
    const bytes = bytesAt(source, rel);
    if (!bytes?.length) throw new Error(`empty emitted agent: ${rel}`);
    expected.set(rel, bytes);
  }
  const snapshots = new Map();
  const writes = new Map();
  const retire = [];
  const unmanaged = [];
  const files = {};
  const cleanTracked = rel => git('ls-files', '-z', '--', rel).split('\0').includes(rel) &&
    git('status', '--porcelain', '--untracked-files=all', '--', rel).trim() === '';
  const installed = contained(target, CATALOG, 'directory');
  const names = installed ? fs.readdirSync(installed).sort() : [];
  for (const name of names) {
    if (!name.endsWith('.toml')) continue;
    const rel = `${CATALOG}/${name}`;
    bytesAt(target, rel); // Refuse symlinks without following even custom entries.
    if (!Object.hasOwn(previous.files, rel) && !expected.has(rel)) unmanaged.push(rel);
    if (expected.has(rel.toLowerCase()) && !expected.has(rel)) throw new Error(`case-alias collision: ${rel}`);
  }
  for (const rel of new Set([...expected.keys(), ...Object.keys(previous.files)])) {
    const installedBytes = bytesAt(target, rel);
    snapshots.set(rel, installedBytes);
    const oldHash = previous.files[rel];
    const incoming = expected.get(rel);
    if (incoming) {
      if (installedBytes !== null && !oldHash) {
        if (!same(installedBytes, incoming)) throw new Error(`unowned collision: ${rel}`);
        unmanaged.push(rel); // Equality is not ownership; never enroll this file.
        continue;
      }
      if (installedBytes !== null && hash(installedBytes) !== oldHash) throw new Error(`modified receipt-owned agent: ${rel}`);
      if (!same(installedBytes, incoming)) {
        if (installedBytes === null && git('status', '--porcelain', '--', rel).trim()) throw new Error(`pending deletion: ${rel}`);
        if (installedBytes !== null && !cleanTracked(rel)) throw new Error(`unclean or untracked update: ${rel}`);
        writes.set(rel, incoming);
      }
      files[rel] = hash(incoming);
    } else if (installedBytes !== null) {
      // Current ownership is a deletion veto, not a copy fence. Copy approval is
      // the caller's separate shared/preserved-path preflight.
      if (isOwnedBy(rel, currentOwnership.lock.consumer_owned)) throw new Error(`consumer-owned deletion veto: ${rel}`);
      if (hash(installedBytes) !== oldHash || !cleanTracked(rel)) throw new Error(`stale agent requires ownership review: ${rel}`);
      retire.push(rel);
    }
  }
  const next = Buffer.from(JSON.stringify({ schema_version: 1, generator: GENERATOR,
    source_commit: args['--source-commit'], files: Object.fromEntries(Object.entries(files).sort()) }, null, 2) + '\n');
  if (same(receiptBytes, next) && writes.size === 0 && retire.length === 0) {
    return { installed: [], retired: [], unmanaged, receipt: RECEIPT, changed: false };
  }
  // Preflight is complete. Stage every byte and recovery copy before replacing
  // installed files. Unexpected IO failure is reported with recovery bytes;
  // there is no claim of multi-file transactional rollback.
  fs.mkdirSync(path.join(target, '.codex'), { recursive: true });
  const staging = fs.mkdtempSync(path.join(target, '.codex/.native-agent-delivery-'));
  let applying = false;
  try {
    for (const [rel, bytes] of writes) fs.writeFileSync(path.join(staging, path.basename(rel) + '.next'), bytes, { flag: 'wx' });
    for (const [rel, bytes] of snapshots) if (bytes !== null) fs.writeFileSync(path.join(staging, path.basename(rel) + '.before'), bytes, { flag: 'wx' });
    if (receiptBytes !== null) fs.writeFileSync(path.join(staging, 'receipt.before'), receiptBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(staging, 'receipt.next'), next, { flag: 'wx' });
    const freshOwnership = readDeliveryLock(target);
    if (freshOwnership.state !== 'ok' || !same(freshOwnership.bytes, currentOwnership.bytes)) throw new Error('ownership evidence changed during preflight');
    if (!same(bytesAt(target, RECEIPT), receiptBytes)) throw new Error('receipt changed during preflight');
    for (const [rel, bytes] of snapshots) if (!same(bytesAt(target, rel), bytes)) throw new Error(`agent changed during preflight: ${rel}`);
    contained(target, CATALOG, 'directory');
    // r4-v4 (security read F2): this tool REPLACES files in a live consumer
    // target — the SHARED canonical-set identity gate runs over the staged bytes
    // BEFORE the renames that commit them (fail-closed pre-apply: nothing
    // installed if the gate refuses).
    //
    // ROLE SPLIT, three states (r4-v6 LOW-2, mirroring emit-cli-artifacts):
    //   • declaration ABSENT (consumer, /migrate Step 6) → informational line,
    //     no refusal — refusing a consumer's own delivery is the F6 defect;
    //   • declaration PRESENT → `assertPrivateOrgConfig()` runs FIRST, so a
    //     present-but-EMPTY private set REFUSES (a broken declaration must
    //     never silently disarm the gate);
    //   • declaration PRESENT + non-empty → the staged bytes are scanned armed.
    if (canonIdentityConfigPresent()) {
      const privateSlugs = assertPrivateOrgConfig();
      assertTreeFreeOfPrivateIdentity(staging, { slugs: privateSlugs, label: "coc-native-agent-delivery staging" });
    } else {
      process.stderr.write(
        "coc-native-agent-delivery: no .claude/canon-identity-values.json in this tree — the private-slug scan over the staged agents is INERT here (consumer-side delivery; the distribution entrypoints assert the config before they distribute).\n",
      );
    }
    applying = true;
    fs.mkdirSync(path.join(target, CATALOG), { recursive: true });
    for (const rel of writes.keys()) fs.renameSync(path.join(staging, path.basename(rel) + '.next'), path.join(target, rel));
    for (const rel of retire) fs.unlinkSync(path.join(target, rel));
    fs.renameSync(path.join(staging, 'receipt.next'), path.join(target, RECEIPT));
  } catch (error) {
    if (!applying) fs.rmSync(staging, { recursive: true });
    throw new Error(`${error.message}${applying ? `; partial apply possible, recovery bytes retained at ${staging}` : '; installed files unchanged'}`);
  }
  fs.rmSync(staging, { recursive: true });
  return { installed: [...writes.keys()], retired: retire, unmanaged, receipt: RECEIPT, changed: true };
}
try {
  console.log(JSON.stringify(reconcile(argumentsFor(process.argv.slice(2)))));
} catch (error) {
  console.error(`Native-agent delivery refused: ${JSON.stringify(error.message)}`);
  process.exitCode = 1;
}
