# coverage-skip-readme
#
# A `_README.md` inside the artifact tree: navigation, not a behaviour-shaping
# deliverable. It licenses no agent behaviour and owes no probe.
#
# expect: (silent)
{
  "filePath": ".claude/rules/local/_README.md",
  "manifest": {
    "agents": {
      "type": "rule",
      "scanner": null,
      "fixturesDir": ".claude/audit-fixtures/agents",
      "expected": {},
      "probes": ".claude/test-harness/probes/agents.probes.json"
    },
    "wrapup": {
      "type": "command",
      "scanner": null,
      "fixturesDir": ".claude/audit-fixtures/wrapup",
      "expected": {},
      "probes": ".claude/test-harness/probes/wrapup.probes.json"
    }
  },
  "probeInventory": [],
  "probeAuthorshipDeferrals": {},
  "now": "2026-09-13T00:00:00Z"
}
