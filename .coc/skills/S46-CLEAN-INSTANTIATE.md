---
id: "S46-CLEAN-INSTANTIATE"
name: 46-clean-instantiate
description: /clean-instantiate procedure — clear canon operator/trust identity from a client clone before /ecosystem-init. Contamination-surface map, fail-closed assert-zero gate, troubleshooting.
---

# /clean-instantiate — Clear-Then-Bootstrap Procedure

The clear-then-bootstrap ceremony a client runs ONCE on a freshly-cloned/templated canon repo, BEFORE
`/ecosystem-init`, to strip canon's coordination-substrate identity so the client's new ecosystem
carries ZERO canon operator/trust identity (brief directive #1 — non-contaminating instantiation).

- **Engine**: `.claude/bin/clean-instantiate.mjs` (dry-run default; `--apply` performs the clear).
- **Identity judgement**: `.claude/bin/lib/identity-scrub.mjs::deriveDynamicTokens(repoDir)` — the SAME
  gate `scripts/publish-to-public.mjs` uses for the public fork, so the two disclosure fences cannot drift.
- **Command**: `.claude/commands/clean-instantiate.md` (the two-step human gate + handoff).

## Contamination-surface map (what carries canon identity, and the disposition)

| #   | Surface                                                                                                                                                                                       | Canon identity carried                                                                      | Clear disposition                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `.claude/operators.roster.json`                                                                                                                                                               | genesis trust-root + GPG pubkey/fingerprint + owner display/login/principal + `role: owner` | **reset to schema-valid PLACEHOLDER** (PLACEHOLDER- owner, synthetic key, all-zero root_commit)                                                             |
| 2   | `journal/*.md`                                                                                                                                                                                | filenames + frontmatter `verified_id`/`person_id`/`display_id`; inline fingerprints         | **DELETE** (canon's decisions are not the client's; `publish-to-public.mjs` already excludes `journal/` from the public fork — same disposition)            |
| 3   | `.claude/team-memory/*.md`                                                                                                                                                                    | `promoted_by.{display_id,verified_id}`                                                      | **clear fact files** (keep `README.md` index)                                                                                                               |
| 4   | `.claude/bin/ecosystem.json`                                                                                                                                                                  | real per-ecosystem org slugs / registry / `upstream_canon`                                  | **reset to placeholder** + set `upstream_canon` to the captured origin URL (W2-b)                                                                           |
| 5   | `.claude/disclosure-tenant-denylist.json`                                                                                                                                                     | loom-only tenant token list                                                                 | **reset to `{tokens: []}`**                                                                                                                                 |
| 6   | per-clone coordination STATE (`.claude/learning/coordination-log.jsonl*`, `posture.json*`, `violations.jsonl`, `observations.jsonl`, `.initialized`, `codify-lease.json`, clone-init witness) | runtime trust state                                                                         | **clear if present** (gitignored — a raw clone omits them, but a `cp -r`/template copy carries them). NOT `learning-codified.json` (insight, not identity). |
| 7   | `.claude/trust-root.json`                                                                                                                                                                     | every canon signer's FULL pubkey (PGP armor whose base64 encodes the UID; SSH key bodies), `person_id`/`role`, canon's `root_commit` anchor | **DELETE** — not neutralize: a token scrub leaves the key material byte-identical and the UID decodable. Absent = "not adopted"; after `/ecosystem-init` writes the real roster, a repository that carries the `build-trust-root.mjs` tool (a loom-ecosystem fork) derives its own with that tool's `--write` mode; a repository without the tool keeps it absent |
| 8   | `burndown/` (the data dir only)                                                                                                                                                               | canon's SIGNED burndown event log (`verified_id` per record), register, issue inventory     | **DELETE** — same class as `journal/`; `BURNDOWN.md` and `burndown-manifest.json` are siblings and stay (same boundary as the client-template edition)     |
| 9   | `.claude/cross-repo-authz/`                                                                                                                                                                   | authorization receipts: filenames + bodies name canon org slugs and private work            | **DELETE** — the client re-produces its own via `/cross-repo-authorize` (client-template edition parity)                                                   |
| 10  | `.claude/VERSION`                                                                                                                                                                             | canon org slugs (`upstream.repo`, `version_url`) + the codify changelog                     | **reset to `{version: "0.0.0", type}`** — no upstream, no changelog; the clone's own `coc-*` `type` is kept (fallback `coc-source`); hooks still read it     |
| 11  | `.claude/bin/lib/loom-workspace-names.json` (loom-only)                                                                                                                                       | `strip` = canon's internal workspace inventory                                              | **reset** to the client-template edition's bytes (edition-emit's exported generator); left in place, and gated, where that generator is absent             |

GAP A (W2-c): the roster is also added to `sync-manifest.yaml::gitignore_additions`, so a `/whoami
--enroll` at a USE-template/consumer can no longer make the roster committable and ship to consumers.

## The fail-closed assert-zero gate

The engine snapshots canon tokens via `deriveDynamicTokens(root).gate` BEFORE the clear (filtering out
PLACEHOLDER-/synthetic markers), performs the clear, then asserts ZERO of those tokens survive ANYWHERE
in the tree, AND runs `scan-synced-disclosure.mjs --check --root <tree>` for structural shapes. ANY
residual → **exit 1** — the ceremony never silently claims clean.

**Substring collisions are adjudicated, exactly as at publish.** The token gate is deliberately
UNBOUNDED while the neutralize is word-bounded, so a short canon token embedded in an unrelated
identifier survives the neutralize and reaches the gate. It clears ONLY where the ratified benign
(token, host) registry (`.claude/disclosure-benign-collisions.json`, read by the publish fences'
own `disclosure-adjudication.mjs`) vouches for that exact pair — loaded BEFORE the clear, since the
neutralize rewrites the registry too. A standalone occurrence never clears; an unreadable registry is a
hit. Where the adjudication lib is absent (it is loom-only), nothing is suppressed. An exit 1 naming a
file and a canon token with no key-material or scanner line is therefore an UNRATIFIED collision:
adjudicate it (LLM judges, human ratifies into the registry), never hand-edit the gate.

**Preserved synthetic fixture homes are not findings.** The neutralize keeps SYNTHETIC fixture homes
in loom's own detector fixtures so they still fire in the fork; the structural scan runs with
`--allow-synthetic-fixture-homes` (the same flag the client-template edition gate uses), which admits
ONLY synthetic-set names inside the fixture corpus. Any other shape in those files still fails closed.

**Key material is gated separately from tokens.** A token grep cannot see a UID inside base64, so the
engine ALSO snapshots, pre-clear, every armor base64 body line and SSH key body from the roster and the
trust root, and fails closed if any survives anywhere (reported as `<file> ~ <canon signer key material:
N fragment(s)>` — the file and a count, never the key bytes). A `.claude/trust-root.json` present after
the clear is a hit by PRESENCE too, since nothing in the ceremony writes one. The structural scanner
never inspects `trust-root.json` (never-synced path), so these two checks are its only coverage.

**Scope (brief S3 — operator/TRUST identity):** the gate targets the high-specificity trust tokens
(GPG/SSH fingerprints, PGP names/emails, principals, person-ids, tenant tokens, AND the **genesis
trust-root** — `repo_owner` + `root_commit`), which live in the carriers it clears. Bare org-slug
genericization in PROSE is the publish-fence's concern; the assert-zero gate SURFACES residual prose
identity (fail-closed) so the client addresses it — it does not silently scrub it.

**`.git` history is OUT of the working-tree gate.** A `git clone` of canon retains canon's full history
in `.git/` (commit authorship, pre-clear journal blobs, the real root_commit) — assert-zero walks the
working tree only, so it CANNOT reach history. The engine never claims the CLONE is clean while that
history exists: it scopes its pass to "working tree" and directs the operator to `--reset-history`
(re-anchors a fresh root, discarding canon history) or a manual history-strip BEFORE `git push`.
Re-running `--apply` on an already-cleared clone is refused (the canon snapshot can no longer be derived).

The ceremony's own placeholder `.claude/bin/ecosystem.json` is exempted from the STRUCTURAL scanner's
`nonfoundation-org-slug` finding only (its `upstream_canon` necessarily names a canon org, by design);
the token gate still scans its content for actual canon tokens.

## Coordination stays OFF until /ecosystem-init (S1/S2)

The placeholder roster's genesis (`repo_owner: "PLACEHOLDER-…"`, `root_commit: "0000000"`) reads as
**not-yet-anchored** (`coordination-mode.js::_isGenesisAnchored`, W2-c residual 1), so a freshly-cleared
client is coordination-**OFF** (non-disruptive) until `/ecosystem-init` re-anchors with a real owner +
root_commit. This is the explicit-enablement guarantee (S2): the substrate turns ON only by the
documented ceremony, never by mere presence of a pulled placeholder.

## Troubleshooting

- **Exit 1, "ASSERT-ZERO FAILED", token hits in prose files**: canon identity survives outside the
  cleared carriers (e.g. a rule Origin footer, a workspace note). Either the client cloned the PRIVATE
  canon (clone the already-scrubbed PUBLIC distribution instead) or genericize the flagged files.
- **Exit 1, "structural scanner findings" NOT on ecosystem.json**: the structural scanner found a
  home-path/org-slug/hostname shape; inspect the named file.
- **Exit 2, "no .claude/"**: not a COC repo — run from the clone root, or pass `--root <dir>`.
- **Exit 2, "non-regular file(s) (FIFO / socket / device)"**: the tree holds a special file (listed
  root-relatively). Reading or writing one blocks forever, so the ceremony refuses before touching
  anything. Remove them and re-run. A **symlink** at a config path the ceremony reads (roster, trust
  root, VERSION, the adjudication registry) is refused the same way — config reads never follow links.
- **The root prints as `<clone-root>`**: deliberate — the absolute path carries your home directory.
  Run from inside the clone (or pass a path under the current directory) to see it relative.
- **upstream_canon shows a placeholder URL**: the clone had no `origin` remote; pass
  `--upstream-canon-url <git-url>` explicitly.

## Eval-harness gate

`.claude/test-harness/tests/clean-instantiate.test.mjs` (subprocess probes) + `identity-scrub.test.mjs`
(structural probes) MUST be green before the wave's redteam convergence (brief eval-gate directive).
