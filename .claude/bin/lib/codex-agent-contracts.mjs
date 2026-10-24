import crypto from 'node:crypto';

const TOOL_ADAPTATIONS = Object.freeze({
  Read: 'read-only file inspection through exec_command',
  Grep: 'read-only rg through exec_command',
  Glob: 'read-only file enumeration through exec_command',
  Bash: 'exec_command and write_stdin',
  Edit: 'apply_patch', Write: 'apply_patch or an explicitly permitted write command',
  Task: 'spawn_agent, send_message and agent result collection',
  Agent: 'spawn_agent, send_message and agent result collection',
  WebFetch: 'web open', WebSearch: 'web search_query',
});
const digest = source => crypto.createHash('sha256').update(source).digest('hex');

export function codexAgentContract({ name, source, canonical, effective, frontmatter, provenanceRegistered = false }) {
  const raw = effective.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const hooks = raw.match(/^hooks:\s*\n((?:[ \t].*(?:\n|$)|\s*\n)*)/m)?.[1] || null;
  const tools = String(frontmatter.tools || '').split(',').map(tool => tool.trim()).filter(Boolean);
  const provenanceOnly = hooks !== null && /^  PreToolUse:\n    - matcher: ["']\*["']\n      hooks:\n        - type: command\n          command: ['"]node ["']?\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/provenance-capture-tool\.js["']?['"]\n          timeout: 5\s*$/.test(hooks);
  const contract = {
    name, source, source_sha256: digest(canonical), effective_sha256: digest(effective),
    declarations: { model: frontmatter.model || null, tools, hooks },
    model: { disposition: 'inherit-parent', reason: 'Claude model aliases have no asserted provider-equivalent Codex mapping' },
    tools: { disposition: tools.length ? 'instruction-only' : 'inherit-parent', native_boundary: false,
      mappings: tools.map(tool => ({ source: tool, adapter: TOOL_ADAPTATIONS[tool] || null,
        disposition: TOOL_ADAPTATIONS[tool] ? 'instruction-only' : 'unsupported; request an explicit permitted alternative' })) },
    hooks: { disposition: hooks === null ? 'none-declared' : provenanceOnly && provenanceRegistered ? 'shared-global-registration' : 'unsupported-per-agent-hook-semantics',
      handler: provenanceOnly ? 'provenance-capture-tool.js' : null,
      native_agent_hook_field: false, live_child_execution_verified: false },
    sandbox: { disposition: 'role default may be overridden by parent runtime policy', effective_child_isolation_verified: false },
  };
  const instructions = tools.length ? '\n\n## Canonical role tool contract\n\n' +
    `Source inventory: ${tools.join(', ')}. Stay within these capabilities; a native shell must not expand the role into omitted write or network capabilities. ` +
    tools.map(tool => `${tool}: ${TOOL_ADAPTATIONS[tool] || 'no mapped native operation; request an explicit permitted alternative'}`).join('; ') +
    '. These are role instructions, not a native tool permission boundary. Parent policy still applies.\n' : '';
  return { contract, instructions };
}
