---
name: frontmatter-directive-trust-surface
description: "Opt-in privilege-bearing directives (execution-class, connector target, capability, tool allowlist) from markdown MUST be column-0 frontmatter, never a body scan (which fails open)."
---

# Frontmatter Is The Directive Trust Surface — Never A Body Scan

Authoritative reference for any parser that extracts an **opt-in, privilege-bearing directive** from a HUMAN-AUTHORED markdown artifact — where the directive raises the artifact's authority (what it may execute, which system it may reach, what capability it grants, which tools it may call).

## Summary

An opt-in / privilege-bearing directive — an **execution-class** opt-in, a **connector target-system**, a **capability grant**, a **tool allowlist** — MUST be read from a **column-0 frontmatter field**, NEVER scanned from the markdown BODY. The frontmatter has NO rendering surface, so the directive cannot be disguised as inert code. Reading it there is a **structural close** of the whole review-evasion class. A hand-rolled body scan is whack-a-mole and eventually fails OPEN.

The four privilege-bearing directive classes this covers:

| Class                   | Example directive         | What a misread WIDENS                             |
| ----------------------- | ------------------------- | ------------------------------------------------- |
| Execution-class opt-in  | `command-class: exec`     | Lets an artifact RUN, not just describe           |
| Connector target-system | `target-system: prod-db`  | Points a connector at a higher-privilege target   |
| Capability grant        | `capabilities: [network]` | Unlocks a capability the artifact otherwise lacks |
| Tool allowlist          | `tools: [Bash, Write]`    | Expands the tool set the artifact may invoke      |

If a misread of the directive would **WIDEN authority**, it belongs in frontmatter. That is the scope test — not "never scan the body" (see § The deliberate exception).

## Why a body scan fails open

To read a directive from the body correctly, the parser MUST distinguish a **LIVE directive** from a **DOCUMENTATION EXAMPLE** — a directive shown inside a fenced, indented, or nested code block, present to teach the reader, not to be executed. Deciding "is this token live or example?" is exactly the job of a CommonMark renderer.

So a body scan must **emulate a CommonMark renderer**. And any divergence between the scanner's emulation and the reviewer's actually-RENDERED view is a **review-evasion fail-OPEN**: the reviewer reads the token as inert example code and approves the artifact; the scanner reads it as a live directive and grants the authority. The reviewer signed off on a document that does something they never saw.

The emulation is unwinnable because the evasion surface is open-ended:

`````text
# The whack-a-mole escalation a body parser never finishes
fenced code block            ```exec ...```          → parser learns to skip ``` fences
mismatched / nested fence    ````  ```exec  ````     → nested fence re-exposes the token
indented code block          ····command-class: exec → 4-space indent is also a code block
CRLF / trailing whitespace   ```exec␍  /  ```·       → fence-close matching drifts
zero-width / BOM             ﻿--- ... ---        → the "frontmatter" delimiter is not pristine
`````

Each patch closes one bypass and the next adversarial round opens another. The frontmatter position removes the surface entirely: there is no code-block context at column 0 above the first content line, so there is nothing to disguise the directive as.

````text
# DO — the directive lives in column-0 frontmatter (no rendering surface, nothing to disguise)
---
command-class: exec
target-system: staging
---
# Body may freely SHOW `command-class: exec` in an example fence — it is inert there.

# DO NOT — the directive is scanned from the body (must emulate CommonMark → eventually fails open)
# Body: a fenced ```command-class: exec``` example the reviewer sees as inert
# but the scanner reads as a live grant.
````

## The two structural halves

Moving the directive to frontmatter is necessary but not sufficient. Pair it with:

1. **Fail-closed default.** An ABSENT field resolves to the **most-restrictive** value (no execution, no target, no capability, empty allowlist). A directive that unlocks authority must be affirmatively present, never inferred.
2. **A bounded, pristine-ASCII frontmatter-fence reader.** The reader that finds the closing `---` MUST **refuse any non-pristine-ASCII `---` line** — a delimiter carrying a BOM, zero-width character, trailing whitespace, or CRLF drift is rejected, not silently accepted as the fence. This closes the last emulation seam at the one place frontmatter still parses text: its own delimiters.

```text
# DO — fail-closed default + strict column-0 scalar reader
directive = frontmatter.get("command-class", MOST_RESTRICTIVE)   # absent → tightest
# find_closing_fence refuses any --- line that is not pristine ASCII

# DO NOT — default to a permissive value, or accept a fuzzy fence
directive = frontmatter.get("command-class", "exec")             # absent → WIDE (fail-open)
```

## The deliberate exception — a fail-closed body scan is fine

The rule is **"frontmatter for any directive whose misread WIDENS authority"**, NOT "never scan the body." A body scan that is **fail-CLOSED in every direction** carries no fail-open surface and is permitted:

- A body token that could only **REFUSE / tighten** (a scan that can add a restriction but never remove one) has no evasion payoff — hiding it as an example just means the restriction does not apply, which is the safe direction.
- A body scan whose every misread is a **limit that only tightens** is safe to keep in the body.

The discriminator is the **direction of the misread**: WIDENS → frontmatter (structural); only-tightens → body scan is acceptable. Do not over-apply the rule to inert or restrictive body content.

## Reviewer checklist

Run when auditing any parser that ingests human-authored markdown and acts on it:

1. **Enumerate the privilege-bearing directives.** For each token the parser reads that raises authority (execution, target, capability, tool), ask: does a misread WIDEN?
2. **Confirm each WIDENING directive is a column-0 frontmatter field**, not a body scan. A body scan for a widening directive is the finding.
3. **Confirm the fail-closed default.** Absent field → most-restrictive. A permissive default is a fail-open.
4. **Confirm the fence reader is pristine-ASCII-strict.** A `---` line with BOM / zero-width / trailing-space / CRLF must be refused, not accepted.
5. **Confirm the deliberate exception is scoped correctly.** Any remaining body scan reads only tokens whose every misread tightens.

## Origin

kailash-coc-conformer W2b/W2c/W2d adapters (PR #1877, the conformer is a public kailash crate). **8 adversarial redteam rounds** to 2-consecutive-clean proved that a body scan emulating CommonMark is unwinnable — every round the parser closed one code-block bypass, the next round opened another (nested fence, indented block, CRLF drift, zero-width delimiter). The root-cause fix moved `command-class` (the execution opt-in) and `target-system` (the connector target) OUT of the body and into **frontmatter**, read by a strict column-0 scalar reader, plus a `find_closing_fence` that refuses any non-pristine-ASCII `---` line. The class closed structurally; the whack-a-mole ended.

## Cross-references

- `.claude/rules/security.md` — Input Validation + the fail-closed sanitizer contract (this pattern is the same fail-closed discipline at the directive-extraction boundary).
- `.gemini/skills/18-security-patterns/SKILL.md` — the security-patterns index.
- Companion posture skills in this directory: `dataflow-rls-posture.md`, `docker-disclosure-scrub.md`.
