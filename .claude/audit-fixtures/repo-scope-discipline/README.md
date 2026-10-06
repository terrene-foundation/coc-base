# `.claude/audit-fixtures/repo-scope-discipline/` — probe candidates + answer keys

Candidates for `.claude/test-harness/probes/repo-scope-discipline.probes.json`. Each
`*.txt` / `*.md` is handed to a judge VERBATIM; the paired `.expected` sidecar holds the
answer key and is never rendered into a prompt.

## Why the meta pair uses `ORG/REPO` and the transcripts use a concrete slug

MEASURED on 2026-09-08 while authoring this set, two poles on one tree. Writing the meta
fixtures with the placeholder `owner/repo` inside their fenced DO/DO-NOT arms tripped the
PreToolUse `detectRepoScopeDriftBash` + `classifyCrossRepoIntent` guard on the *write of
the fixture file itself* — the guard is segment-anchored over the Bash argv string and
cannot tell a heredoc PAYLOAD from a command. The four transcript candidates in this
directory carry `--repo example-org/kailash-rs` and did NOT trip it.

So the discriminator is not "a `gh --repo` invocation appears in the argv". It is whether
the TARGET resolves as non-CWD: a generic two-segment placeholder resolves that way,
while a concrete known-sibling slug does not. An author writing a cross-repo-themed
fixture should expect the guard to fire on the abstract form and not on the concrete one
— which is the opposite of the intuition — and should use `ORG/REPO` (or any
non-repo-shaped token) in fenced examples.

The four transcripts are deliberately LEFT on the concrete-slug form: they are session
excerpts in which the command has already run and its result is printed, which is the
shape every transcript fixture in this corpus uses, and the concrete slug is what makes
the compliant pole's lexical trap work.

An HTML comment cannot carry this note inside a fixture: `<!--` is an answer-key marker,
and `artifact-probe-adapter.mjs` refuses any candidate containing one.
