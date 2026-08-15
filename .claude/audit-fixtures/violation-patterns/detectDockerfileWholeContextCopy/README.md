# `deploy-hygiene/9a` — positive-COPY audit fixtures

Fixtures for `violation-patterns.js::detectDockerfileWholeContextCopy`, landed
WITH the detector per `cc-artifacts.md` Rule 9. Run by
`.claude/test-harness/tests/deploy-hygiene-positive-copy.test.mjs`, registered in
`ci-suites.json` — an unregistered suite is an unarmed gate (loom#1368).

**Severity is `advisory`, and that is the rule's call, not the detector's.**
`deploy-hygiene.md` §9a's Wiring block states it: "per `hook-output-discipline.md`
MUST-2 a lexical `COPY . .` tripwire MAY pair as advisory but MUST NOT carry
`block`". The Dockerfile parse is structural, but whether an image is a
COC-CONSUMER image — the clause's actual subject — is not readable off the tool
call.

## Bipolar by construction

Nine fixtures, five flagging and four clean. The clean pole is not padding: three
of the four lock a specific over-match this detector would otherwise commit, and
each was written because the naive implementation fails it.

| Fixture | Verdict | What it locks |
| --- | --- | --- |
| `flag-copy-dot-dot.Dockerfile` | FLAG | the canonical `COPY . .` |
| `flag-copy-dot-absolute-dest.Dockerfile` | FLAG | `COPY . /app` — dest shape must not matter |
| `flag-line-continuation.Dockerfile` | FLAG | `COPY \` + newline: a line-at-a-time scan reads the continuation as a bare `. .` with no instruction keyword and MISSES it entirely |
| `flag-mixed-sources.Dockerfile` | FLAG | `COPY src/ . /app/` — a whole-context source hiding among positive ones; only the LAST arg is the destination |
| `flag-lowercase-instruction.Dockerfile` | FLAG | `copy . /srv` — Dockerfile instructions are case-insensitive |
| `clean-positive-copy.Dockerfile` | clean | the DO shape from §9a verbatim |
| `clean-multistage-from-stage.Dockerfile` | clean | `COPY --from=builder . .` copies from a build STAGE, not the build context. Per-clone state and `.git/` are unreachable from a stage filesystem, so the leak §9a names cannot occur. Flagging it would fire on ordinary multi-stage builds — the fastest way to get a detector switched off |
| `clean-commented-out.Dockerfile` | clean | `# COPY . .` in a comment is documentation, not an instruction |
| `clean-single-arg-copy.Dockerfile` | clean | `COPY entrypoint.sh` has no destination arg, so it has no source to classify |

A tenth case has no file because it is a PATH-gate case, asserted directly in the
test: prose containing the literal `COPY . .` at a non-Dockerfile path must NOT
flag. This corpus documents the antipattern in `deploy-hygiene.md` itself and in
`skills/10-deployment-git/`, so a content-only scan would fire on the very rule
that defines the violation.

## Fire rate, measured — not assumed

Against every Dockerfile tracked in this repo (`git ls-files`, basename-matched):
**0 of 3 fired.** All three dev-container templates already positive-COPY. A
detector that fires on ~100% of inputs is as useless as one that never fires; this
one is silent on the compliant corpus and flags each constructed violation.
