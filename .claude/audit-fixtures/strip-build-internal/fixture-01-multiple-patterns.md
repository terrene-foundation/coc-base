# Example rule body — exercises every active rewrite

See `workspaces/multi-cli-coc/02-plans/07-loom-multi-cli-spec-v6.md`
for the source. Origin paragraph references workspaces/multi-cli-coc/journal/0001-DECISION.md
for context.

Compare `kailash-py/workspaces/foo/` to `kailash-rs/workspaces/bar/` —
both live in sibling SDK trees.

Edit `packages/kailash-ml/src/kailash_ml/trainable.py` to add the missing
guard. The path packages/kailash-dataflow/src/dataflow/adapters/mongodb.py
shows the same pattern.

Diagnose CI failures with `gh api repos/esperie-enterprise/kailash-rs/actions/runs`.

For descriptive cross-repo examples, `kailash-py/.claude/rules/foo.md` is fine.

Tree layout:
`kailash-rs/`
├── crates
└── workspaces
