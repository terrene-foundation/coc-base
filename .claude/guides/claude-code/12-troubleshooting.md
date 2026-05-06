# Guide 12: Troubleshooting

## Introduction

This guide helps you **diagnose and fix common issues** you may encounter while using this setup. Issues are organized by symptom for quick reference.

---

## Part 1: Installation Issues

### Issue: "Command not found: claude"

**Symptom**: Running `claude` in terminal shows command not found.

**Causes**:

1. Claude Code not installed
2. npm global binaries not in PATH

**Solutions**:

```bash
# Check if installed
npm list -g @anthropic-ai/claude-code

# If not installed
npm install -g @anthropic-ai/claude-code

# If installed but not in PATH
npm config get prefix
# Add that path/bin to your PATH

# For bash (~/.bashrc)
export PATH="$(npm config get prefix)/bin:$PATH"

# For zsh (~/.zshrc)
export PATH="$(npm config get prefix)/bin:$PATH"

# Reload shell
source ~/.bashrc  # or source ~/.zshrc
```

### Issue: "Authentication failed"

**Symptom**: Claude Code won't authenticate with Anthropic.

**Solutions**:

1. **Re-authenticate**:

```bash
claude --logout
claude
# Follow authentication flow
```

2. **Use API key directly**:

```bash
export ANTHROPIC_API_KEY="your-key-here"
claude
```

3. **Check API key validity** at https://console.anthropic.com

### Issue: "Permission denied" on hooks

**Symptom**: Hooks fail with permission errors.

**Solution**:

```bash
# Make hook scripts executable
chmod +x .claude/hooks/*.js
```

---

## Part 2: Hook Issues

### Issue: Hook timeout

**Symptom**: "[HOOK TIMEOUT] hook-name exceeded limit"

**Causes**:

1. Hook script too slow
2. Network issues in hook
3. Infinite loop in hook

**Solutions**:

1. **Increase timeout** in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "command": ".claude/hooks/slow-hook.js",
            "timeout": 60 // Increase from default
          }
        ]
      }
    ]
  }
}
```

2. **Optimize hook script** - reduce operations
3. **Add timeout handling** in hook:

```javascript
const TIMEOUT_MS = 5000;
setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);
```

### Issue: Hook blocking incorrectly

**Symptom**: Valid operations are being blocked.

**Solution**:

Check the hook's blocking patterns:

```javascript
// In validate-bash-command.js
const dangerousPatterns = [
  // Review these patterns
];
```

Add exceptions for your use case or adjust patterns.

### Issue: Hooks not running

**Symptom**: Hooks don't seem to execute.

**Solutions**:

1. **Check settings.json syntax**:

```bash
# Validate JSON
python -m json.tool .claude/settings.json
```

2. **Check matcher patterns**:

```json
"matcher": "Edit|Write"  // Regex pattern
```

3. **Verify hook path**:

```bash
ls -la .claude/hooks/your-hook.js
```

---

## Part 3: Agent Issues

### Issue: Agent not found

**Symptom**: "Agent 'xxx-specialist' not found"

**Solutions**:

1. **Check agent file exists**:

```bash
ls .claude/agents/xxx-specialist.md
```

2. **Check agent name** in frontmatter:

```markdown
---
name: xxx-specialist # Must match
---
```

### Issue: Agent giving incorrect advice

**Symptom**: Agent recommendations don't work.

**Solutions**:

1. **Check skill references** in agent file
2. **Update agent with correct patterns**
3. **Report issue** - agent may need update

### Issue: Agent delegation not happening

**Symptom**: Claude doesn't delegate when expected.

**Solutions**:

1. **Request explicitly**:

```
> Use the dataflow-specialist to help with this
```

2. **Check rules** in `.claude/rules/agents.md`
3. **Use trigger words** that match agent descriptions

---

## Part 4: Skill/Command Issues

### Issue: Command not loading skill

**Symptom**: `/db` doesn't load DataFlow context.

**Solutions**:

1. **Check command file** exists:

```bash
ls .claude/commands/db.md
```

2. **Check SKILL.md** exists:

```bash
ls .claude/skills/02-dataflow/SKILL.md
```

3. **Verify frontmatter** format in both files

### Issue: Wrong patterns loaded

**Symptom**: Claude uses outdated or incorrect patterns.

**Solutions**:

1. **Clear context**:

```
> /clear
```

2. **Reload specific skill**:

```
> /db
```

3. **Update skill files** with correct patterns

---

## Part 5: Rule Enforcement Issues

### Issue: Rule not being followed

**Symptom**: Claude ignores a rule (e.g., commits without review).

**Solutions**:

1. **Remind Claude explicitly**:

```
> Remember: security review is required before commits
```

2. **Check rule file** syntax and clarity
3. **Make rule MUST instead of SHOULD**

### Issue: Rule conflict

**Symptom**: Claude seems confused between two rules.

**Solution**:

Add priority in rule file:

```markdown
## Priority

This rule takes precedence over [other rule] when [condition].
```

---

## Part 6: Testing Issues

### Issue: "Mocking detected" warning

**Symptom**: validate-workflow flags mock usage.

**Solutions**:

1. **For Tier 1 (unit tests)**: Mocking is allowed, move to `tests/unit/`

2. **For Tier 2-3**: Replace mocks with real infrastructure:

```python
# Instead of
@patch('dataflow.create')
def test_create(mock_create):
    ...

# Use
@pytest.fixture
def db():
    return DataFlow("sqlite:///:memory:")

def test_create(db):
    # Real database
    ...
```

### Issue: Tests failing in CI but passing locally

**Symptom**: Tests work locally but fail in CI.

**Solutions**:

1. **Check database setup** in CI
2. **Verify environment variables** in CI
3. **Check for test isolation** issues
4. **Add CI-specific fixtures**

---

## Part 7: Learning System Issues

### Issue: Observations not being logged

**Symptom**: No observations appearing in `learning/observations.jsonl`.

**Solutions**:

1. **Check learning directory** exists:

```bash
ls -la .claude/learning/
```

2. **Check session hooks** are running (session-end hook captures observations)

3. **Check observation types** - the system captures `user_correction`, `rule_violation`, `session_accomplishment`, and `decision_reference` types

### Issue: Learning digest not updating

**Symptom**: `learning-digest.json` is stale or empty.

**Solutions**:

1. **Run digest-builder manually**:

```bash
node scripts/learning/digest-builder.js
```

2. **Accumulate more observations** first - the digest builder needs sufficient data

3. **Use /codify** to process the digest into real artifacts (skills, rules)

---

## Part 8: Performance Issues

### Issue: Claude responses are slow

**Symptom**: Long delays before responses.

**Solutions**:

1. **Reduce loaded context**:

```
> /clear
```

2. **Load only needed skills**:

```
> /db  # Instead of /sdk /db /api /ai /test all at once
```

3. **Break up large tasks**

### Issue: High token usage

**Symptom**: Hitting usage limits quickly.

**Solutions**:

1. **Be concise** in requests
2. **Use commands** to load specific context
3. **Avoid re-reading** files Claude already read
4. **Batch operations** instead of one at a time

---

## Part 9: Common Error Messages

### "workflow.execute(runtime) detected"

**Problem**: Using wrong execution pattern.

**Fix**:

```python
# Wrong
workflow.execute(runtime)

# Correct
runtime.execute(workflow.build())
```

### "Relative import detected"

**Problem**: Using relative imports.

**Fix**:

```python
# Wrong
from ..workflow import builder

# Correct
from kailash.workflow.builder import WorkflowBuilder
```

### "Primary key must be named 'id'"

**Problem**: DataFlow model with wrong primary key.

**Fix**:

```python
@db.model
class User:
    id: int  # Must be named 'id'
    # NOT: user_id: int
```

### "Real infrastructure recommended violation"

**Problem**: Using mocks in Tier 2-3 tests.

**Fix**: Replace mocks with real infrastructure (see Part 6).

---

## Part 10: Getting Help

### Self-Help Resources

1. **This guide series** - Read relevant sections
2. **Skill documentation** - `.claude/skills/`
3. **Agent README** - `.claude/agents/_README.md`
4. **Error troubleshooting skill** - `/31-error-troubleshooting`

### Asking Claude for Help

```
> I'm getting error "[error message]" when [action]. What should I check?
```

Claude will consult relevant skills and agents.

### Reporting Issues

For persistent issues:

1. Document the exact error
2. Note the steps to reproduce
3. Check if it's a configuration issue
4. Report at https://github.com/anthropics/claude-code/issues

---

## Part 11: Quick Diagnostic Checklist

When something isn't working:

- [ ] Is Claude Code installed? (`claude --version`)
- [ ] Are you in the right directory? (`.claude/` exists)
- [ ] Is `settings.json` valid JSON?
- [ ] Are hook scripts executable? (`chmod +x`)
- [ ] Are skill files properly formatted?
- [ ] Is the agent file correctly named?
- [ ] Have you tried `/clear` and starting fresh?
- [ ] Is your API key valid?

---

## Part 12: Key Takeaways

### Common Issue Categories

| Category     | First Thing to Check          |
| ------------ | ----------------------------- |
| Installation | PATH configuration            |
| Hooks        | Permissions and timeout       |
| Agents       | File existence and name match |
| Skills       | SKILL.md format               |
| Rules        | Rule file syntax              |
| Testing      | Test tier and mocking         |
| Learning     | observations.jsonl + digest   |
| Performance  | Context loading               |

### When All Else Fails

```
> /clear

# Start fresh
> claude

# Minimal reproduction
> [Simplest version of what you're trying to do]
```

---

## Conclusion

This completes the guide series. You now have comprehensive documentation for:

1. Understanding Claude Code
2. Understanding this setup
3. Installation and first run
4. Commands
5. Agents
6. Skills
7. Hooks
8. Rules
9. Learning
10. Daily workflows
11. Advanced usage
12. Troubleshooting

For questions not covered here, use the setup's skills and agents - they contain extensive documentation on every component.

---

## Navigation

- **Previous**: [11 - Advanced Usage](11-advanced-usage.md)
- **Home**: [README.md](README.md)
