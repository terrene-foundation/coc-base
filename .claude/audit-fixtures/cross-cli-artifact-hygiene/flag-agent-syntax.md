# Sample todo with CC-native delegation syntax (BLOCKED)

- Reviewer agent approves (`Agent({subagent_type: "reviewer", ...})`).
- Security reviewer agent approves (`Agent({subagent_type: "security-reviewer", ...})`).
- Run `Agent(subagent_type="testing-specialist", run_in_background=true, prompt="...")`.
