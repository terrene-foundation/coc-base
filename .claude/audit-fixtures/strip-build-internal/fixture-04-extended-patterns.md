# Extended pattern set — #477 item 1 (trailing-slash + BUILD monorepo sub-packages)

**Source**: `packages/kaizen-agents/src/kaizen_agents/supervisor.py`

Run the parity grep against packages/kaizen-agents/tests/ before landing.

Install layout:

- `packages/kailash-align/` -- Source code
- `packages/kaizen-agents/` -- Monorepo agent framework

Compare with git log <last-tag>..HEAD -- packages/kailash-dataflow/ to scope changes.

Preserved (load-bearing glob + consumer monorepo):

paths: ["packages/kailash-dataflow/**"]

      - "packages/kailash-dataflow/**"
      - "packages/kaizen-agents/**"

Put your shared code under packages/my-lib/src/index.ts in your own repo.
