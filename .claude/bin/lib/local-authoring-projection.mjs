import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// The repo's ONE git-subprocess envelope (`rules/security.md` § Enforcement-Surface
// Parity; loom#1471): every git this repo spawns routes through it — absolute binary +
// constants-built env — never a bare `execFileSync('git', …)`. Loaded lazily per the
// house pattern (bound to its own line) so a fixture that relocates this module rebases
// the resolution the same way; a load failure degrades to the fixture path below.
const requireCjs = createRequire(import.meta.url);
import { isManifestOwnerClass, readManifestSource } from './manifest-source.mjs';
import { loadExclusions } from './coc-manifest.mjs';

export function privateAuthoringSourceReason(relative) {
  return relative.split(/[\\/]/).some(leaf => /^(?:\.git|\.env(?:\..*)?|node_modules|credentials(?:\..*)?|auth\.json|trust-root\.json|operators\.roster\.json)$/.test(leaf) || /\.(?:local|state)\./.test(leaf))
    ? 'private or runtime-state name; content was not read' : null;
}

export function resolveEmissionProfile({ profile = 'auto', repo, cli, target, targetRoot, guardOnly } = {}) {
  if (profile !== 'auto') return profile;
  if (target != null || targetRoot != null || guardOnly || cli === 'gemini') return 'distribution';
  const root = fs.realpathSync(repo);
  if (fs.lstatSync(path.join(root, '.claude')).isSymbolicLink()) throw new Error('source profile refuses a symlinked .claude root');
  if (!isManifestOwnerClass(root)) return 'distribution';
  const rows = readManifestSource(root).split(/\r?\n/).filter(line => /^source_local_codex_profile:/.test(line));
  if (!rows.length) return 'distribution';
  if (rows.length !== 1 || !/^source_local_codex_profile:\s*local-authoring\s*(?:#.*)?$/.test(rows[0])) {
    throw new Error('source_local_codex_profile must declare local-authoring exactly once');
  }
  return 'local-authoring';
}

// PORTABLE MODE CONTRACT — the ONE definition, shared by the producer below and by the
// consumer (`community-membership.mjs::contributorsFromRecords`). The only contractual bits
// of a source's mode are the GIT-TRACKED executability class (100644 / 100755): git stores no
// other permission bit, so group/other rwx is checkout environment (umask, filesystem) and
// never repo state. Recording the raw `stat.mode & 0o777` therefore makes a committed
// projection CHURN, and the consumer red, on byte-identical content whenever a machine
// materializes 0664 / 0600. The exec bit REMAINS contractual: 0755 stays distinct from 0644
// on both sides, so a source that gains or loses its exec bit still reds.
export const portableMode = (mode) => ((mode & 0o111) ? 0o755 : 0o644);

// Contract: specs/distribution/tier-and-surface-model.md, source-local projection.
export function localAuthoringProjection({ profile = 'distribution', repo, cli, target,
  targetRoot, guardOnly = false } = {}) {
  if (profile === 'distribution') return { profile, options: {}, sources: [], excluded: [] };
  if (profile !== 'local-authoring') throw new Error(`unknown emission profile: ${profile}`);
  if (cli !== 'codex' || target != null || targetRoot != null || guardOnly) {
    throw new Error('local-authoring requires a coc-source repository, --cli codex, and no target, target-root or guard-only mode');
  }
  const root = fs.realpathSync(repo);
  const claude = path.join(root, '.claude');
  if (fs.lstatSync(claude).isSymbolicLink()) throw new Error('local-authoring refuses a symlinked .claude root');
  if (!isManifestOwnerClass(root)) throw new Error('local-authoring requires a coc-source repository');
  const sources = [], excluded = [];
  // DETERMINISM CONTRACT (fixed 2026-10-08) — the projection is a CHECKED-IN generated artifact
  // compared byte-wise by `check-cli-emit-drift.mjs` on hosts that never see this checkout.
  // MEASURED defect: an UNTRACKED private-named file (this authoring machine's
  // `.claude/commands/.env`) added an `excluded[]` entry a clone without it could never
  // reproduce, so the committed bytes matched on one host and drifted on every other. The ledger
  // therefore records a private-named path ONLY when it is TRACKED — repo state, identical in
  // every clone — and skips an untracked one SILENTLY (host state; its bytes are still never
  // read, and the skip removes it from `universalExclude` exactly as an absent file would be on
  // any other host). A tree that is not a git repository cannot answer trackedness; there the
  // check degrades to the prior presence-based recording (test fixtures).
  let trackedRel = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lib = requireCjs(path.join(here, '..', '..', 'hooks', 'lib', 'git-subprocess-env.js'));
    if (typeof lib.resolveGitBinary !== 'function' || typeof lib.gitEnvForArgs !== 'function') throw new Error('git-subprocess-env incompatible');
    const gitArgs = ['-C', root, 'ls-files', '-z', '--', '.claude'];
    const out = execFileSync(lib.resolveGitBinary({}), gitArgs, {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      env: lib.gitEnvForArgs(gitArgs),
    });
    trackedRel = new Set(out.toString('utf8').split('\0').filter(Boolean));
  } catch {
    trackedRel = null;
  }
  const inspect = (absolute, relative) => {
    const privateReason = privateAuthoringSourceReason(relative);
    if (privateReason) {
      const relClaude = `.claude/${relative}`;
      const tracked = trackedRel === null
        || trackedRel.has(relClaude)
        || [...trackedRel].some((p) => p.startsWith(`${relClaude}/`));
      if (tracked) excluded.push({ source: relClaude, reason: privateReason });
      return;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`local-authoring refuses symlink or special source: ${relative}`);
    }
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(root + path.sep)) throw new Error(`local-authoring source escapes repository: ${relative}`);
    if (relative === 'rules/local') {
      excluded.push({ source: '.claude/rules/local/', reason: 'deployment-local rules are never projected' });
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) inspect(path.join(absolute, entry), `${relative}/${entry}`);
    } else {
      sources.push({ source: `.claude/${relative}`, sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'), mode: portableMode(stat.mode) });
    }
  };
  for (const category of ['agents', 'commands', 'skills', 'rules']) inspect(path.join(claude, category), category);
  const exclusions = loadExclusions();
  return { profile, sources, excluded, options: {
    localAuthoring: true, hasTarget: false, tierFilter: null, loomOnly: [],
    universalExclude: excluded.flatMap(row => {
      const relative = row.source.replace(/^\.claude\//, '').replace(/\/$/, '');
      return [relative, `${relative}/**`];
    }),
    laneExclude: [], surfaceRoles: {}, targetRole: null, lang: null,
    exclusions: Object.fromEntries(['codex', 'gemini'].map(cliName => [cliName,
      (exclusions[cliName] || []).filter(glob => glob.startsWith('rules/'))])),
  } };
}
