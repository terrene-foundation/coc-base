import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isMainModule } from './entry-point.mjs';

const families = {
  analysis: ['analyze', 'design', 'inspect', 'cli-audit', 'cc-audit', 'i-audit'],
  verification: ['test', 'validate', 'redteam', 'conformance-walk', 'test-harness-probe', 'doctor', 'vet'],
  engineering: ['implement', 'api', 'db', 'ai', 'sdk', 'i-harden', 'i-polish'],
  planning: ['todos', 'start', 'ws', 'worktree', 'maintain', 'pickup', 'sweep', 'autonomize'],
  knowledge: ['codify', 'learn', 'journal', 'reconcile-notes', 'wrapup', 'distill'],
  delivery: ['release', 'deploy', 'publish-template', 'sync-to-use', 'sync-to-build', 'sync-from-build', 'sync-from-use', 'sync-from-canon', 'sync-from-downstream', 'sync-from-template', 'sync'],
  identity: ['whoami', 'claims', 'claim', 'release-claim', 'posture', 'enroll', 'onboard', 'ecosystem-init', 'clean-instantiate', 'certify'],
  governance: ['cross-repo-authorize', 'govern', 'fork-conference', 'migrate', 'onboard-stack', 'repos', 'settings'],
  cost: ['cost-audit'],
};
const str = (description) => ({ type: 'string', minLength: 1, description });
const strings = (description) => ({ type: 'array', items: str(description) });
const choice = (...values) => ({ type: 'string', enum: values });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items) => ({ type: 'array', items });
const checks = array(object({ name: str('Actual check name'), verdict: choice('pass', 'fail', 'unrun'), evidence_refs: strings('Reference to observed check evidence') }));
const results = {
  analysis: object({ scope: str('Examined scope'), findings: array(object({ severity: choice('critical', 'high', 'medium', 'low', 'info'), finding: str('Concrete finding'), evidence_refs: strings('Observed supporting evidence') })), recommendations: strings('Action supported by the analysis') }),
  verification: object({ scope: str('Measured scope and excluded surfaces'), checks, remaining_gaps: strings('Unverified or failing requirement') }),
  engineering: object({ changed_paths: strings('Actual modified path'), checks, remaining_work: strings('Incomplete implementation work') }),
  planning: object({ workspace: str('Resolved workspace or explicit absence'), actions: array(object({ action: str('Concrete planned or performed action'), state: choice('planned', 'completed', 'blocked'), evidence_refs: strings('Plan or execution evidence') })), remaining_work: strings('Unfinished work or gate') }),
  knowledge: object({ artifacts: strings('Knowledge artifact actually read or written'), repo_class: choice('coc-source', 'coc-use-template', 'coc-build', 'coc-project', 'unknown'), routing: str('Actual class-derived routing; coc-source codify creates no upstream proposal'), remaining_work: strings('Unfinished capture or verification') }),
  delivery: object({ target: str('Exact release, deployment, or sync destination'), action: str('Authorized action or preparation performed'), authorization: str('Existing authority evidence or explicit pending approval; never inferred from this schema'), checks, delivered_refs: strings('Actual delivered revision, receipt or artifact; empty when not delivered') }),
  identity: object({ operation: str('Exact identity, claim, posture or enrollment subcommand'), verified_identity: str('Resolved identity or explicit unverified state'), state_changes: strings('Actual state transition and receipt; empty when read-only'), pending_gates: strings('Unfulfilled human, signature or quorum gate') }),
  governance: object({ operation: str('Exact governed operation'), targets: strings('Explicitly scoped target'), decisions: strings('Observed decision and its authority'), pending_gates: strings('Unfulfilled structural gate') }),
  cost: object({ measured_sessions: { type: 'integer', minimum: 0 }, priced_coverage: str('Actual pricing source and covered usage'), unpriced_coverage: str('Unpriced or unavailable usage; distinguish from subscription quota'), evidence_refs: strings('Actual token/pricing accounting inputs') }),
};

export function phaseFamily(phase) {
  if (!/^[a-z][a-z0-9-]*$/.test(phase)) throw new Error('invalid phase name');
  const family = Object.keys(families).find((key) => families[key].includes(phase));
  if (!family) throw new Error(`No reviewed result contract for phase ${phase}`);
  return family;
}

export function buildSchema(phase) {
  const family = phaseFamily(phase);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `coc-${phase}`,
    ...object({
      phase: { type: 'string', const: phase },
      execution_mode: { type: 'string', const: phase === 'certify' ? 'human-solo' : 'headless-with-gates' },
      status: choice('completed', 'needs_input', 'blocked'),
      summary: str('Concrete outcome; do not call unrun or pending work complete'),
      evidence: array(object({ kind: choice('file', 'command', 'observation', 'receipt'), reference: str('Actual source, command, observation or receipt'), outcome: choice('pass', 'fail', 'unrun', 'observed'), detail: str('Observed result and limits') })),
      outputs: array(object({ path: str('Actual artifact path'), change: choice('created', 'updated', 'read'), description: str('Actual artifact purpose') })),
      errors: array(object({ code: str('Failure identity'), message: str('Concrete failure') })),
      required_inputs: array(object({ id: str('Stable input identifier'), prompt: str('Exact missing information or human gate'), reason: str('Why execution cannot continue') })),
      next_actions: strings('Concrete next action within existing authority'),
      result: { ...results[family], type: ['object', 'null'], description: `${family} outcome; null only when blocked or awaiting input` },
    }),
  };
}

function canonicalInside(root, relative) {
  const boundary = fs.realpathSync(root);
  const candidate = fs.realpathSync(path.join(boundary, relative));
  const rel = path.relative(boundary, candidate);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(candidate).isFile()) throw new Error(`Path outside repository or not an ordinary file: ${relative}`);
  return candidate;
}

export function phaseContract(root, phase) {
  const expected = buildSchema(phase);
  const schemaPath = canonicalInside(root, `.claude/wrappers/schemas/${phase}.schema.json`);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  if (JSON.stringify(schema) !== JSON.stringify(expected)) throw new Error(`Unrecognized or stale result contract for ${phase}`);
  const native = `.agents/skills/coc-${phase}/SKILL.md`;
  const selected = fs.existsSync(path.join(root, native)) ? native : `.codex/prompts/${phase}.md`;
  const procedurePath = canonicalInside(root, selected);
  if (!fs.readFileSync(procedurePath, 'utf8').trim()) throw new Error(`Phase instructions for ${phase} are empty`);
  return { phase, family: phaseFamily(phase), execution_mode: expected.properties.execution_mode.const, schemaPath, procedurePath };
}

export function catalog(root) {
  const dir = path.join(root, '.claude/wrappers/schemas');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.schema.json')).sort().flatMap((name) => {
    const phase = name.slice(0, -12);
    const native = path.join(root, `.agents/skills/coc-${phase}/SKILL.md`);
    const legacy = path.join(root, `.codex/prompts/${phase}.md`);
    if (!fs.existsSync(native) && !fs.existsSync(legacy)) return [];
    return [phaseContract(root, phase)];
  });
}

function validateShape(schema, value, at = '$') {
  if (value === null && Array.isArray(schema.type) && schema.type.includes('null')) return;
  const type = Array.isArray(schema.type) ? 'object' : schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected object`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${at}.${key}: unexpected field`);
      validateShape(schema.properties[key], value[key], `${at}.${key}`);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
    value.forEach((item, i) => validateShape(schema.items, item, `${at}[${i}]`));
  } else if (type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum) throw new Error(`${at}: expected nonnegative safe integer`);
  } else if (type === 'string' && (typeof value !== 'string' || (schema.minLength && !value.trim()))) throw new Error(`${at}: expected nonempty string`);
  if (schema.const !== undefined && value !== schema.const) throw new Error(`${at}: wrong constant`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at}: invalid enum value`);
}

export function validateResult(phase, value) {
  validateShape(buildSchema(phase), value);
  if (value.status === 'completed' && (value.result === null || !value.evidence.length || value.errors.length || value.required_inputs.length)) throw new Error('completed requires a concrete result and evidence, with no errors or pending inputs');
  if (value.status === 'completed') {
    const family = phaseFamily(phase), result = value.result;
    const observed = new Set(value.evidence.filter(e => e.outcome !== 'unrun').map(e => e.reference));
    const positive = new Set(value.evidence.filter(e => ['observed', 'pass'].includes(e.outcome)).map(e => e.reference));
    if (!(family === 'analysis' ? observed : positive).size) throw new Error('completed requires observed evidence, not only unrun or failed execution');
    const refs = (list, permitted, label) => {
      if (!list.length || list.some(ref => !permitted.has(ref))) throw new Error(`${label} requires references to matching observed evidence`);
    };
    if (family === 'analysis') for (const finding of result.findings) refs(finding.evidence_refs, observed, 'analysis finding');
    if (family === 'planning') {
      if (result.remaining_work.length) throw new Error('completed planning cannot retain unfinished work or gates');
      for (const action of result.actions) {
        if (action.state === 'blocked' || (action.state === 'planned' && !['todos', 'sweep'].includes(phase))) throw new Error('completed operation cannot retain blocked or unperformed actions');
        refs(action.evidence_refs, positive, 'completed planning action');
      }
    }
    if (['engineering', 'knowledge'].includes(family) && result.remaining_work.length) throw new Error('completed cannot retain unfinished implementation or capture work');
    if (['identity', 'governance'].includes(family) && result.pending_gates.length) throw new Error('completed cannot retain pending structural gates');
    if (family === 'verification' && result.remaining_gaps.length) throw new Error('completed verification cannot retain failing or unverified requirements');
    if (['engineering', 'verification', 'delivery'].includes(family)) {
      for (const check of result.checks) {
        if (check.verdict !== 'pass') throw new Error('completed execution cannot contain failed or unrun checks');
        refs(check.evidence_refs, positive, 'completed check');
      }
      if (family === 'verification' && !result.checks.length) throw new Error('completed verification requires executed checks');
      if (family === 'engineering' && !result.changed_paths.length && !result.checks.length) throw new Error('completed implementation requires changed artifacts or verification of an existing implementation');
      if (family === 'delivery' && !result.delivered_refs.length) throw new Error('completed delivery requires an actual delivery or preparation receipt');
    }
  }
  if (value.status === 'needs_input' && !value.required_inputs.length) throw new Error('needs_input requires explicit missing inputs');
  if (value.status === 'blocked' && !value.errors.length) throw new Error('blocked requires an identified error');
  if (phase === 'certify' && value.status === 'completed') throw new Error('human-solo certification cannot complete through headless dispatch');
  return value;
}

export function humanGate(phase) {
  return validateResult(phase, {
    phase, execution_mode: 'human-solo', status: 'needs_input',
    summary: 'Certification requires the operator to answer the consent and knowledge gate in an interactive session.',
    evidence: [], outputs: [], errors: [], result: null,
    required_inputs: [{ id: 'operator-solo-gate', prompt: 'Invoke the certification skill interactively; the operator must answer without AI assistance.', reason: 'Canonical certification requires explicit consent and unassisted operator answers.' }],
    next_actions: ['$coc-certify'],
  });
}

export function checkEntry(root, phase, args) {
  const hookPath = canonicalInside(root, '.claude/hooks/analyze-completeness-guard.js');
  const requireHook = createRequire(hookPath);
  const { decideAnalyzeGate, ADVANCING_SKILLS } = requireHook(hookPath);
  if (!ADVANCING_SKILLS.has(phase)) return decideAnalyzeGate({ repoDir: root, toolName: 'Skill', skillName: phase, args });
  const { requireMainCheckout } = requireHook('./lib/state-resolver.js');
  const main = requireMainCheckout(root);
  if (!main.ok) {
    process.stderr.write(`coc: analyze-completeness UNKNOWN: main checkout unidentifiable (${main.reason}); the canonical advisory disposition permits continuing without a gate verdict.\n`);
    return { action: 'unknown', reason: main.reason };
  }
  const decision = decideAnalyzeGate({ repoDir: main.repoDir, toolName: 'Skill', skillName: phase, args });
  if (decision.action === 'block') throw new Error(`analyze-completeness blocked ${phase}: workspace ${decision.workspace} has empty required trees: ${decision.emptyTrees.join(', ')}`);
  return decision;
}

function schemaDirectory(boundary, relative) {
  const candidate = path.join(boundary, relative);
  const resolved = fs.realpathSync(candidate);
  const rel = path.relative(boundary, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || resolved !== candidate || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Unsafe schema directory: ${relative}`);
  }
  return resolved;
}

function schemaLeaf(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw new Error('Unsafe schema output');
  return stat;
}

function writeSchemas(root) {
  const nofollow = fs.constants.O_NOFOLLOW;
  const nonblock = fs.constants.O_NONBLOCK;
  if (!Number.isInteger(nofollow) || nofollow <= 0 || !Number.isInteger(nonblock) || nonblock <= 0) throw new Error('Safe schema output flags unavailable');
  const boundary = fs.realpathSync(root);
  const commandDir = schemaDirectory(boundary, '.claude/commands');
  const outputDir = schemaDirectory(boundary, '.claude/wrappers/schemas');
  const commands = fs.readdirSync(commandDir).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3));
  const plans = [...new Set([...commands, 'sync'])].map(name => {
    const body = JSON.stringify(buildSchema(name), null, 2) + '\n';
    const file = path.join(outputDir, `${name}.schema.json`);
    return { file, body, before: schemaLeaf(file) };
  });
  const opened = [];
  try {
    for (const plan of plans) {
      const flags = fs.constants.O_WRONLY | nofollow | nonblock | (plan.before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
      const fd = fs.openSync(plan.file, flags, 0o666);
      opened.push({ ...plan, fd });
      const actual = fs.fstatSync(fd);
      if (!actual.isFile() || actual.nlink !== 1 || (plan.before && (actual.dev !== plan.before.dev || actual.ino !== plan.before.ino))) throw new Error('Unsafe schema output descriptor');
      if (schemaDirectory(boundary, '.claude/wrappers/schemas') !== outputDir || fs.realpathSync(plan.file) !== plan.file) throw new Error('Schema output path changed');
    }
    for (const { fd, body } of opened) {
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, body);
    }
  } finally {
    for (const { fd } of opened) fs.closeSync(fd);
  }
}

function main(argv) {
  const [action, root, phase, file] = argv;
  if (action === 'schemas') {
    writeSchemas(root);
    return;
  }
  if (action === 'list') { for (const row of catalog(root)) process.stdout.write(row.phase + '\n'); return; }
  if (action === 'catalog') { process.stdout.write(JSON.stringify(catalog(root), null, 2) + '\n'); return; }
  if (action === 'inspect') { process.stdout.write(phaseContract(root, phase).execution_mode + '\n'); return; }
  if (action === 'human-gate') { phaseContract(root, phase); process.stdout.write(JSON.stringify(humanGate(phase)) + '\n'); return; }
  if (action === 'check-entry') { phaseContract(root, phase); checkEntry(root, phase, file || ''); return; }
  if (action === 'validate') { phaseContract(root, phase); const result = validateResult(phase, JSON.parse(fs.readFileSync(file, 'utf8'))); process.stdout.write(result.status + '\n'); return; }
  throw new Error('Unknown command-catalog operation');
}

if (isMainModule(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`coc: ${error.message}\n`); process.exitCode = 4; }
}
