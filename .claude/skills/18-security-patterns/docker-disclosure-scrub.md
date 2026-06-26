---
name: docker-disclosure-scrub
description: "Build-time disclosure scrub for public Docker template artifacts. Use for 'Dockerfile leaks', 'pre-build disclosure gate', or auditing Dockerfile/compose for leaked operator/cloud/IP identifiers."
---

# Docker Disclosure Scrub — Build-Time Public-Surface Gate

> **Skill Metadata** — load when a template ships Docker artifacts in a PUBLIC
> repository and you need a mechanical, deterministic scrub that runs BEFORE any
> image build. This is the **build-time** enforcement counterpart to
> `rules/upstream-issue-hygiene.md` MUST-2 (which governs **runtime** public-
> surface redaction). Every Docker artifact a public template ships is a
> disclosure surface; this gate flags operator, cloud, and network identifiers
> at the source before they become permanent public record.

## Summary

A 9-check mechanical grep battery over the Docker artifact file-set. Every check
is **positive-allowlist-tightened** — a novel disclosure shape is FLAGGED, not
silently passed (the allowlist enumerates what is permitted; everything else
fails). Each check emits FAIL output naming `file:line` so the operator fixes at
the source. Runs in CI as the FIRST workflow step (before any image build) AND
locally during developer pre-push. Mechanical, deterministic, `O(files × lines)`.

The file-set (`M2_FILES`) the scrub covers:

```
Dockerfile  bin/dev  docker-compose.yml  .devcontainer/devcontainer.json
.dockerignore  .gitignore  .env.example  requirements-user.txt
Gemfile.user  Dockerfile.user  compose.override.yml.example
```

## The 9 checks

| #       | Checks for                                                                                                                                                 | Allowlist / exemptions                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | Operator-home leaks (`/Users/<name>/`, `/home/<name>/`)                                                                                                    | comment lines + the container's own devcontainer home path are exempt                                                                                     |
| **(b)** | Literal API-key shapes (`sk-*`, `ghp_*`, `AIza*`, `eyJ*` JWT, `AKIA*`)                                                                                     | placeholder strings (`your-key-here`, `EXAMPLE`) exempt                                                                                                   |
| **(c)** | `--build-arg` with secret-shaped values (`KEY=`, `TOKEN=`, `SECRET=`, `PASSWORD=`, `API=`)                                                                 | —                                                                                                                                                         |
| **(d)** | `COPY`/`ADD` of secret or host-config dirs (`.env`, `.claude/`, `.codex/`, `.gemini/`, `.ssh/`, `.gnupg/`, `secrets/`) in `Dockerfile` + `Dockerfile.user` | —                                                                                                                                                         |
| **(e)** | `.dockerignore` coverage assertion against the mandatory list                                                                                              | list below                                                                                                                                                |
| **(f)** | Machine hostnames + operator identifiers                                                                                                                   | placeholder pattern: `<operator-host-N>`-style slugs only; `operator-id` / `verified_id` / `person_id` literals from coordination-log records are flagged |
| **(g)** | GitHub org slugs beyond the public allowlist                                                                                                               | allowlist: `terrene-foundation`, `esperie`, `nodesource`, `microsoft`, `anthropic-ai`, `openai`, `google`, `modelcontextprotocol`, `devcontainers`        |
| **(h)** | Cloud account / project / org identifier shapes                                                                                                            | enumerated below                                                                                                                                          |
| **(i)** | Internal RFC-1918 / link-local IP shapes                                                                                                                   | `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `169.254.x.x`                                                                                                 |

Checks **(a)–(g)** surfaced at the original M3 disclosure-scrub pass; checks
**(h)** and **(i)** were added to close cloud-identifier and internal-IP leak
shapes a security review surfaced. The battery is a SUPERSET that only grows.

### Check (e) — mandatory `.dockerignore` coverage list

The `.dockerignore` MUST contain at least:

```
.env
**/.env
secrets/
*.pem
*.key
.claude/learning/
workspaces/
compose.override.yml
*.local
Gemfile.user.lock
```

Check (e) FAILS if any entry is missing. (Follow-up: this list MAY be lifted to a
manifest fixture so downstream consumers extend it without forking the skill
prose — until then it lives inline here.)

### Check (h) — cloud account / project / org identifier shapes

Flag (none of these have a legitimate place in a public template's Docker
artifacts):

- **AWS:** 12-digit account IDs in ARNs; ECR URLs
  `<accountid>.dkr.ecr.<region>.amazonaws.com`; IAM ARNs
  `arn:aws:iam::<accountid>:role/...`
- **GCP:** project IDs in `gcr.io/<project-id>/...`;
  `<project>.iam.gserviceaccount.com`
- **OpenAI:** org IDs `org-<24-base62>`
- **Anthropic:** API key prefix `sk-ant-*` — a DISTINCT shape from OpenAI's
  `sk-*` (which check (b) catches by accident only when the suffix is ≥15 chars);
  `sk-ant-*` MUST be flagged explicitly
- **Cloudflare:** API tokens (`CF-API-...`); account-id 32-hex strings

### Check (i) — internal IP shapes

Flag RFC-1918 + link-local literals — a non-trivial leak surface when copy-pasted
from a staging `compose` file: `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`,
`169.254.x.x`.

## Authoring discipline — placeholders, not literals

When this skill (or the workflow that implements it) is authored at loom, every
operator-host reference MUST use `<operator-host-N>` placeholders per the
`ci-runners.operator.local.example.md` convention — NEVER a literal real-host
string. The shipped artifact carries only generic placeholders; the operator's
real values live in a gitignored local file, never in a synced `.claude/`
artifact (the same `#260`/`#252` disclosure class the resolver-config design
fences). The skill body is itself a public-surface artifact — it MUST pass its
own check (f).

## Where it runs

- **CI:** as the FIRST workflow step, BEFORE any image build — a disclosure that
  reaches the build context is already in the build cache / layers.
- **Local pre-push:** the same battery, so the developer catches it before the
  bytes leave the machine.

## Relationship to `upstream-issue-hygiene.md`

`rules/upstream-issue-hygiene.md` MUST-2 governs what a human redacts from a
RUNTIME public surface (an upstream issue body, a proposal). This skill is the
BUILD-TIME mechanical counterpart for Docker artifacts: where MUST-2 is a
human-judgment redaction gate on prose, this is a deterministic grep gate on
build-context files. They stack — the same downstream-context tokens MUST-2
fences (operator paths, identifiers, org slugs) are exactly what checks (a),
(f), (g) flag in the Docker surface.
