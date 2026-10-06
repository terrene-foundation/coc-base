---
id: "STATE-FILE-WRITE-GUARD"
paths: ["deploy/**", "**/.last-deployed-*", "**/.last-smoke-result-*", "**/.last-interactions-smoke-result-*", "**/state-file-write-guard.*", "**/validate-state-file.*", "**/post-deploy-smoke.*"]
---

# State-File Write Guard — Validator-Driven Deploy Claims

See `.claude/guides/rule-extracts/state-file-write-guard.md` for full BLOCKED-rationalization corpus, extended DO/DO NOT examples (override-ordering JS, atomic-update protocol steps), composition table, and Origin post-mortem.

A project's deploy state file is the canonical signal for whether a deploy is GREEN. Agents producing GREEN claims based on judgment ("page loaded, no console errors") rather than a wrapper-validated contract scan ship false-GREEN at high frequency: the contract scan catches AI-panel stubs, missing data, partial subsets, and silent backend degradation that surface signals miss.

The agent does NOT decide whether a deploy is GREEN — the validator does. The agent runs the validator (or its wrapper), reads the verdict, and writes accordingly. Pure-text rules at write time are demonstrably insufficient — the structural defense (PreToolUse hook + verdict-tier matrix + signature mechanism) closes the bypass. Loom ships the canonical pattern as a parameterized library: `hooks/lib/state-file-write-guard.js` (T1/T2/T3/T4 tier classifier + signature emitter + override check + honest-YELLOW gap validator) plus `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` for the Bash mutation coverage. Both are pure logic; consumers supply the config the lib consumes. Project-specific surface (path globs, validator binary, contract spec, smoke spec) lives in the consumer; the invariant pattern lives at loom.

## MUST Rules

### 1. Hand-Writing Deploy State Without The Wrapper Is BLOCKED

The agent MUST NOT hand-write a project's deploy state file via the Write tool unless the JSON content carries a verdict-tier-validated signature (T1 GREEN or T2 honest-YELLOW per Rule 2). Projects with the discipline enabled enforce structurally; projects without the hook MUST treat this rule as the prose contract.

```bash
# DO — wrapper writes signed file; agent's Write echoes that content
bash scripts/smoke/run-post-deploy-smoke.sh <env>
# DO NOT — hand-craft the JSON and Write it (T3 BLOCK + remediation)
```

**Why:** Judgment-based GREEN claims ship false-GREEN at high frequency because surface signals (page-loaded, no console errors) do not see contract-level gaps (AI-panel stubs, partial data). The wrapper's contract scan IS the verification.

### 2. Tier Matrix — The Validator Decides, Not The Agent

Projects route every protected Write/Edit through a project-supplied validator running in `--mode=hook`. The validator returns one of four tiers via `hooks/lib/state-file-write-guard.js::tierClassify({...})`; the hook acts on the tier, not on agent intent:

| Tier                       | Condition                                                                                            | Hook decision      |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| **T1 — Verified GREEN**    | detached SIGNATURE valid + bound to the pinned signer + contract scan passes + zero prohibited stubs | ALLOW              |
| **T2 — Honest YELLOW**     | `verification_status: "YELLOW"` AND every gap explicitly enumerated                                  | ALLOW              |
| **T3 — Unsupported claim** | `"GREEN"` BUT signature missing/invalid/wrong-signer, trust root UNWIRED, OR contract scan fails     | BLOCK + diagnostic |
| **T4 — Hook bypass**       | Edit/Write against the structural defense, contract docs, or trust root, OR Bash mutation of any     | BLOCK + escalate   |

T3 diagnostic surfaces THREE remediation paths: (a) re-run wrapper to verify GREEN, (b) write YELLOW with enumerated gaps per Rule 3, (c) take the project's documented remediation step then path (a).

**Why:** Each "validator is wrong, override and continue" rationalization is the precise failure mode the tier matrix prevents. If the validator is wrong, fix is to update the contract artifacts atomically (Rule 7), not bypass once. Bypassing teaches the agent the gate is negotiable, which it is not.

### 3. Honest YELLOW Acceptance Criteria

A `verification_status: "YELLOW"` write is accepted iff: (1) the project-defined gap-list field is non-empty; (2) every contract gap surfaced by the smoke / contract scan is enumerated; (3) each entry references the failing identifier (free-text rationale fine; the identifier MUST be present).

```json
// DO — honest YELLOW with enumerated gaps + identifiers
{ "verification_status": "YELLOW",
  "<gap_list_field>": ["<failing-id-1> degraded; tracked in #N", "<failing-id-2> partial; tracked in #M"] }
// DO NOT — claim YELLOW without enumerating
{ "verification_status": "YELLOW", "<gap_list_field>": ["some things are degraded"] }
```

**Why:** YELLOW is the honest acknowledgement of a partially-broken deploy. Without per-gap enumeration referencing the specific failing identifier, the next session inherits an unfalsifiable "things are kinda working" state and the gaps cascade.

### 4. Trust Root Protection — The Trust Root Binds A SIGNER, Not A Content Hash

The trust root is a **detached SIGNATURE over `canonical-body || smoke-report || interactions-report`, verified against a public key and BOUND to a signer fingerprint the consumer resolved from the roster/anchor** — never a keyless content hash, and never a fingerprint read off the file under verification.

**The canonical body is the state file with BOTH attestation fields removed** — the signature field AND the digest field — and it is the SAME body both attestations are computed over. `hooks/lib/state-file-write-guard.js::composeSignedBytes` is the single exported implementation; producers and the verifier MUST both call it rather than re-deriving the framing (stripping only ONE field makes the two attestations mutually recursive, so no production order satisfies both and T1 becomes unreachable for an honest file). The signature MUST cover all three artifacts, segments length-prefixed: signing the state file ALONE is a binding-scope regression against the digest it replaces, since a file legitimately signed for an EARLIER deploy could be replayed against attacker-chosen reports. Consumers wire it by passing `trustRoot: {expectedFingerprint, publicKey, verifyDetachedSignature}` into `tierClassify` (the lib is pure, so the verifier is INJECTED). An unwired trust root FAILS CLOSED to T3.

A keyless `sha256(canonical-body || smoke-report || interactions-report)` — SAME canonical body, both attestation fields removed — is retained ONLY as an optional cheap INTEGRITY pre-filter (`contentDigestField`). It proves the three artifacts are mutually consistent; it proves NOTHING about who produced them, because any actor able to write the state file can recompute it. A digest match can never reach T1, and a digest MISMATCH diagnostic MUST NOT claim "trust root forged" — a condition the digest structurally cannot detect.

Forgeable smoke reports still mean forgeable signature INPUT, so the hook MUST additionally T4-block direct Write/Edit on the project's smoke-report paths AND T4-block Bash mutation of those paths.

```js
// DO — trust root binds a pinned signer; fingerprint from the roster/anchor
tierClassify({
  ...cfg,
  trustRoot: {
    expectedFingerprint: rosterFingerprintFor(operator), // NOT from the state file
    publicKey: rosterPublicKeyFor(operator),
    verifyDetachedSignature: cocSign.verify, // (content, sig, pubKey, {expectedFpr})
  },
});

// DO NOT — a keyless digest as the trust root (any writer can recompute it),
// or a fingerprint the state file declares about itself (rewriting the file
// rewrites the expectation with it — the same defect one level up)
```

**Why:** A keyless hash proves integrity, never authenticity — a GREEN claim gated on it is only as trustworthy as write-access to the file it attests. Under the bounded-trust threat model (`multi-operator-coordination.md` §1 — the adversary is a legitimate team member WITH repo write access) that is no control at all: the attacker recomputes the hash for free. Binding to a pinned signer is what makes "verified" mean something, and it is the standard the sibling cryptographic paths already hold. Separately, closing only the state-file door while leaving the smoke-report door open is the same failure mode one level more dangerous — an agent who could not write GREEN directly can hand-write the smoke report, then run the wrapper's signing mode, shipping a signed state file built on fraudulent signature input. Sibling-path precedent + the replay walkthrough: extract § "Rule 4 — Smoke-report trust root".

Origin: loom#1427 — `state-file-write-guard.js::verifySignature` was a keyless sha256 self-consistency compare (0 occurrences of `fingerprint`/`expectedFpr`/`gpg`/`verified_id` in the module), while its T3 diagnostic asserted "Trust root forged" for a condition it could not detect. Fixed by injecting a real detached-signature verifier bound to a roster-resolved fingerprint, renaming the digest helpers to `emitContentDigest`/`verifyContentDigest` (old names retained as deprecated aliases per `zero-tolerance.md` Rule 6a), and failing closed when the trust root is unwired.

### 5. Bash-Layer Mutation Coverage — Four Layers

The Bash-side detection MUST cover four layers, not just shell redirects:

- **Layer 1**: redirect / heredoc / `tee` / `sed -i` / `jq -i` / `cat <<EOF >`. The redirect matcher MUST recognize every file-writing form — `>`, `>>`, `>|`, `&>`, `&>>`, and fd-prefixed `N>` / `N>>` / `N>|` — while excluding fd-DUPLICATION (`2>&1`, `>&2`, whose target is a descriptor, not a file), and MUST scan EVERY redirect target on the line, not just the first. A matcher that misses `>|`/`&>`/`N>` is BLOCKED (#745 Finding 1). The segment splitter MUST treat `>|` as one redirect token, NOT split it on the `|` as a pipe.
- **Layer 2**: the file-util verbs — `cp`, `mv`, `rm`, `dd of=`, `rsync`, `install`, `truncate`, `ln`, `chmod`, `chown`, `touch`, `sponge`.
- **Layer 3**: interpreter bodies (`python`, `node`, `ruby`, `perl`, `bash`, `sh`) that **WRITE** the protected path — per-line quoted `-c`/`-e`/`-m` forms PLUS a fallback for a command / pipeline-segment **led by** an interpreter (covers `-m`, unquoted, script-arg, `--eval=`, and stdin-heredoc forms). Anchoring on the leading interpreter token restores parity with the removed `Bash(python:*<state>*)` deny globs **without** false-positive-flagging prose or interpreter-as-search-arg (`grep python <path>`). **Read-vs-write gate (#1292):** BOTH Layer-3 branches MUST be gated on the positive write-allowlist `STATE_INTERP_WRITE_RX` — Layer 3 is a MUTATION detector, so a body that only READS the path carries no write token and PASSES; only a write vector AND the path flags. **Both branches MUST consult ONE shared predicate — `hasInterpreterWriteSignal()` (#1337, per `security.md` § Enforcement-Surface Parity)** — so a vector added for one branch can never be silently absent from the other. The allowlist MUST be function-agnostic (it matches the write VECTOR, not the API name) and grouped BY SURFACE in `STATE_INTERP_WRITE_SOURCES` so a new language/API has an obvious home — seven groups: (1) mode + open flags, (2) node fs write APIs, (3) destructive/replacement ops, (4) python, (5) ruby, (6) shell-out from the body, (7) dynamic dispatch / obfuscation (an un-analyzable body in a command naming authority state fails CLOSED). Separately, `STATE_INTERP_INPLACE_RX` covers the perl/ruby **`-i` in-place flag** — the one write vector living in ARGV rather than the body — anchored on a perl/ruby line lead so a `-i` belonging to another utility (`grep -i`) is not read as one. **Documentation-body masking (#1292):** `detectStateFileMutationSegmentAware` masks a state-write example quoted as DATA inside a non-interpreter wrapper, so a write example quoted in an issue body/commit message does NOT fire, while a REAL interpreter execution and the stdin-heredoc case still do. Per-group vector lists, the deliberate ABSENCES (`File.open`/`File.new` are mode-gated, not listed), and the call-anchoring that keeps prose clean: extract § "(i) — the interpreter write-vector allowlist".
- **Layer 4 — heredoc write+RUN bundle (#764 item 3; whole-command STRUCTURAL pass, `detectHeredocWriteRunBundle`).** The three layers above are per-line / per-segment; they cannot see a bundle that WRITES a script via heredoc AND RUNS it in ONE command (`cat > s.cjs <<EOF … fs.writeFileSync("<protected>") … EOF && node s.cjs`), because `splitShellSegments` is NOT heredoc-aware — the body's internal `;` fractures the interpreter-lead from the protected-path write across sibling segments, so no per-segment call sees both. `detectStateFileMutationSegmentAware` therefore runs a whole-command fallback pass matching the STRUCTURAL write→execute conjunction: **(a)** a heredoc whose WRITTEN-SCRIPT body — the target of a `>`/`>>` redirect, a `tee`/`sponge`/`cp`/`install` stdin-sink, or a `dd of=` sink — contains a protected PATH LITERAL anywhere (matched by `pathRx` SUBSTRING, NOT a write-verb allowlist and NOT a prefix-anchored write-call regex), AND **(b)** that SAME written script is SUBSEQUENTLY EXECUTED by an allowlisted interpreter in the same command, matched by TOKEN identity on the write target (`./`-normalized, leading `VAR=val` stripped; per `hook-output-discipline.md` MUST-3 the token is NEVER expanded — identity holds regardless of what the var expands to). The conjunction justifies `severity:block` per `hook-output-discipline.md` MUST-2 because it is STRUCTURAL — a real write-a-script-touching-a-protected-path-AND-run-it dataflow — NOT a lexical form. Surface rewrites of the script NAME, path PREFIX, QUOTING, write VERB, or DELIMITER SHAPE do not evade it. The WRITE-SURFACE and INTERPRETER allowlists MUST be POSITIVE (`cc-artifacts.md` Rule 10); a write-verb or interpreter OUTSIDE either is a documented residual (§ Known residuals (h)), forever-defended by the signed-fold / fail-closed-to-L1 layer. A heredoc opener MUST be committed ONLY when its close line exists downstream, so a decoy `<<WORD` with no close is IGNORED rather than swallowing the RUN line into a phantom body (fail-toward-more-scanning). A fail-closed BACKSTOP covers any divergence between this parser's close derivation and bash's, since such a divergence can only SPILL the real body + RUN line into `structural`, where the backstop still flags. TWO residual classes remain, listed as (a)/(d). It does NOT false-block doc/rule/test AUTHORING (which WRITES a file but does NOT execute it, so (b) fails structurally), and the git-commit exception needs NO special skip here: a commit-MESSAGE heredoc's target is git's STDIN or a git-consumed file, never an interpreter. Opener/quote-removal grammar, the `<<<` here-string exclusion, `tee` multi-operand collection, and the delimiter-close rules: extract § "Layer 4 — heredoc parser mechanics".

**Severity by layer — the detection LAYER (and, at Layer 3, the target-path CLASS) sets the severity, not a flat block (#1293, "Option X").** `validate-bash-command.js` routes: **Layers 1, 2, and 4 → `severity:block`** (a redirect operator / a file-util verb on a literal path / a heredoc write-then-run bundle are structurally-unambiguous command-shape signals a surface rewrite cannot evade — the teeth `hook-output-discipline.md` MUST-2 permits). Note on "Layer 4": `detectHeredocWriteRunBundle` emits a NUMERIC `{layer: 1}`, so the `layer === 1` structural branch covers it — a router audit will find no `layer === 4` case, by design.

**Layer 3 splits by target-path CLASS (Option X):** a Layer-3 interpreter-body write to a **BOUNDED path** (`observations.jsonl` / `.heartbeat-cache` / `.session-end-cache`) → **`severity:halt-and-report`** (advisory, non-blocking); a Layer-3 write to **non-fold-derived AUTONOMY/AUTHORITY state** (`posture.json`/`.bak`/`.tmp`, `.initialized`, `presence-mechanism.json`, `violations.jsonl`, `operators.roster.*`, `coordination-log.jsonl` — matched by `LAYER3_BLOCK_RX`) → **`severity:block`** (kept). Layer 3 is a lexical scan of an interpreter body — it cannot tell an executed write from a read-only body or a documentation-quoted example without a full shell parser, so it is where BOTH recurring false-positive classes lived.

Demoting the BOUNDED Layer-3 severity to advisory closes the recurring false-positive class ROOT-CAUSE (not per-class-patch). The demotion is scoped by whether the forged write is **neutralized WITHOUT relying on a fold** — the fold does NOT run on a coordination-OFF repo (the DEFAULT downstream; `multi-operator-coordination.md` § Opt-in). `observations.jsonl` qualifies; the **block set does NOT**, because on an OFF repo nothing re-derives them and their forgery would STAND. Prose-mentions of the block-set paths are rare, so the FP cost of keeping their block is ~0 — **a premise #1363 found FALSE as originally shipped and RESTORED by fixing its root cause, not by demoting the severity**. With § "The prose exception is QUOTE-AWARE …" (below) in place that premise holds again; **demoting the block-set severity remains a same-class violation** per § Trust Posture Wiring. The #635 guarantee is preserved. Per-path forgery consequences + the defeated-mask analysis: extract § "Layer-3 path-class justification".

**MUST-2 deviation (acknowledged).** The `LAYER3_BLOCK_RX` block is itself a lexical-signal block, which `hook-output-discipline.md` MUST-2 ("`severity:block` MUST NOT come from lexical regex alone") forbids by default. Keeping it is a **DELIBERATE, co-owner-ratified, risk-based deviation**: it is **fail-closed** (it only ever over-blocks a rare genuine write to a high-value path, NEVER under-blocks), the paths are the highest-value forgery targets, and their prose-FP risk is ~0. **This deviation is scoped to `LAYER3_BLOCK_RX` and does not license a lexical `block` elsewhere.** The detector functions are severity-agnostic — they return `{layer, kind}`; the severity policy lives at the consumer, so a project wiring the hook inherits this mapping via `validate-bash-command.js`.

**Known residuals (path-based interceptor limits — symmetric with any command-form denylist).** The vectors below are NOT covered by EITHER the hook or the removed deny-matrix, and are accepted: **(a)** variable-assembled / indirected paths (`P=…; rm "$P"`) — the literal is absent from the command string, so no path-matcher can resolve it without in-hook shell expansion, forbidden by `hook-output-discipline.md` MUST-3. **(b)** interactive editors (`vim`/`ed`/`nano`/`emacs -batch`) — no layer keys on editor verbs. **(c)** a script whose hardcoded body writes the path — the mechanism the SANCTIONED canonical-writer ceremonies rely on BY DESIGN (`/whoami --register`, the `/certify` coordination-log anchor); they are licensed writers, not bypasses. **A future hardening that closes (c) MUST keep those ceremony runs ACCEPTED** — `register-roster-write-guard.test.mjs` pins it so the regression fails LOUDLY. Layer 4 is such a hardening on ONE sub-case: write+run in ONE command = BLOCK, write-in-one + run-in-another = OK. **(d)** an interpreter behind a command prefix (`sudo`/`env`/`VAR=val`/subshell) — Layer 3 anchors on the interpreter as segment lead; Layer 4's RUN half shares the root cause. **(e)** a `cd` then bare-relative redirect, **(f)** a glob-metacharacter target, **(g)** PATH-AS-DATA indirection — all SAME class as (a): the literal is absent pre-expansion, so closing them at the path-matcher layer is BLOCKED for the same MUST-3 reason. **(h)** a WRITE VERB or INTERPRETER outside the POSITIVE Layer-4 allowlists. **(i)** an interpreter WRITE via a vector outside `STATE_INTERP_WRITE_RX` — note `--write` can NEVER be treated as a signal, because the SANCTIONED `reconcile-settings-deny.mjs --write <state>` writer uses exactly that flag and is a pinned CLEAN fixture; **#1337 substantially narrowed this**. A positive allowlist is STILL never exhaustive ("every ALLOWLISTED write blocks" — the honest claim); the forever-defense for (a)–(i) is the signed-fold / fail-closed-to-L1 integrity layer, NOT the command interceptor. Per-residual mechanism, the #1337 corpus and its five second-pass evasions, and the equally-open status under the prior deny-matrix: extract §§ "Residual mechanics (a)–(i)" + "(i) — the interpreter write-vector allowlist". (j) **[#1337, NARROWED]** the Layer-3 fallback's whole-command scope over-blocks a compound command that BOTH reads a state file AND runs an UNRELATED interpreter in a sibling segment. #1337 narrows it — when NOTHING outside the interpreter's own segment can contribute to its argv (**no heredoc opener, no `$(…)`/backtick/`$'…'`, and no `$` parameter reference anywhere**), the path + write tests are scoped to the interpreter-led SEGMENT, and EVERY such segment is tested so a read on line 1 cannot mask a write on line 3. When ANY of the three IS present the WHOLE-command scope MUST be retained UNCHANGED — narrowing THOSE would be the fail-OPEN trade a trust-substrate control must never take. The residual is therefore an over-block, never an under-block. (k) **[#1363 → CLOSED loom#1703]** `STATE_PATH_RX` is UNANCHORED, so a `/tmp` sandbox path matched — the detector had no notion of WHICH repo root a state path belonged to. **Shipped fix:** `hooks/lib/state-target-scope.js::createStateTargetScope` resolves the matched TOKEN into a `scope` field on the detector's result — **`in-tree`** (→ block), **`out-of-tree`** (owned by no repo and not `~/.claude` → no finding; this IS the (k) narrowing), **`unresolved`** (→ still BLOCKED, fail-closed, but the message says so instead of claiming a structural match). Resolution MUST be SYMMETRIC per `security.md` § Path Containment (candidate and boundary root BOTH through `fs.realpathSync`), and "IN-TREE" is deliberately **"any repo's state, plus `~/.claude`"**, NOT "this repo only". **Scoped honestly — the resolve closes the LEXICAL-bypass class and does NOT defeat the check-to-use TOCTOU**, which needs enforcement at the sink. The one `$VAR` narrowing is a single `process.env` LOOKUP, NOT shell expansion (MUST-3 intact). **The Edit/Write lane (`guard-path-scope.js`) is NOT covered** — only the BASH lane is closed and the Edit/Write half is owed its own shard. Detail: extract § "(k) — the detector is not root-scoped". (l) **[#1363 → PARTIALLY CLOSED loom#1703]** a heredoc written to a NON-protected scratch file whose body quotes a write EXAMPLE was scanned as command text — so the guard's remediation for an honest reviewer was OBFUSCATION, the shape residuals (a)/(e)/(f) treat as an ATTACKER technique. **loom#1703 closes the SHELL-OPERATION half**: a heredoc body is never parsed by the shell as command text, so for Layers 1 and 2 it is just a quoting form their masker did not cover, and the wrapper blanks heredoc BODIES in a THIRD, length-preserving STRUCTURE view feeding those two layers ONLY. **Layers 3 and 4 keep reading the raw scan view and are untouched**, so the control #1426 named is not deleted. Masking MUST stay GATED on `heredocBodiesAreInertData` AND on DELIMITER QUOTING — with an UNQUOTED `<<EOF` bash performs command substitution while building the body, so a body containing `$` or a backtick MUST be left VISIBLE (an unconditional mask was MEASURED as a live fail-open). **WHAT REMAINS OPEN:** the LAYER-3 half is NOT closed, because masking Layer 3 would delete the control; pinned by `state-target-scope-1703.test.mjs` § RESIDUAL. **ONE CONTROL WAS GIVEN UP, recorded rather than dropped:** an inert heredoc quoting `rm <state>` with NO execution anywhere no longer flags at Layer 2; the write-THEN-run form still blocks at Layer 4. Detail: extract § "(l) — heredoc to a non-protected scratch file". (m) **[#1390 review → CLOSED loom#1426]** the Layer-4 BACKSTOP fired on "protected-path mention + ANY redirect + ANY executed script" — the written target need NOT have been the executed file — so a READ-ONLY inspection blocked. The width was never load-bearing: a `>` OPERAND entered the EXECUTED set, so `anyTargetExecuted` was satisfied by the redirect matching ITSELF. The fix skips output-redirect operands; INPUT (`<`) operands MUST STAY, because `node < f.js` genuinely executes `f.js`. This narrows FALSE positives only, the bash-parse-divergence defence is untouched, and the ONE flag-side verdict given up moves to the TIGHTER Layer 1. Mutation-measured anti-vacuity evidence: extract § "(m) — the Layer-4 backstop's real trigger". (n) **[#1390 review S12, OPEN — under-block, PRE-EXISTING]** `splitShellSegments` does not split on a lone `&`, and the segment-aware caller does not pass `newlineSeparates`, so a prose-carrier lead plus a NEWLINE-joined interpreter write rides through as ONE masked segment. Traced against the PRE-EXISTING `GIT_COMMIT_WITH_BODY_RX`, so NOT introduced by #1363 — which does add new entry points to it. Recorded per `zero-tolerance.md` Rule 1a; the fix changes segmentation for EVERY caller of the shared splitter, so it owes its own shard. Executed evidence + ablation matrices for (k)–(n): extract § "#1363 / #1390 residuals".

**Authoring a probe or a report that TOUCHES a protected path — read this BEFORE you are blocked (loom#1426).** Every layer's shared precondition is a protected-path LITERAL in the command string, which nearly every legitimate command investigating this machinery satisfies. Four affordances, in order of preference; NONE is obfuscation, and splitting a literal across string concatenation to evade the matcher is **BLOCKED** — it is the attacker technique residuals (a)/(e)/(f) name, and doing it trains the reflex the guard exists to catch.

1. **Put the literal in a FILE, not the command.** Write the probe into a scratch dir and run it by path; the command line then carries no protected path, so no layer engages — the sanctioned-ceremony shape (residual (c)).
2. **Split the command at the boundary.** Read in one invocation, run in another: write-in-one + run-in-another is accepted BY CONSTRUCTION while write+run in ONE command blocks.
3. **Prefer a non-interpreter reader.** `cat` / `jq` / `grep` on a protected path matches no layer at all.
4. **Compose the literal INSIDE a scratch file**, never in the command, when a probe must construct many path variants.

If you are blocked anyway, the block is a FINDING: record the exact command and which layer fired, and file it against this rule rather than reaching for a workaround. Five actors were blocked before #1426 and each worked around it silently, which is why the defect survived four rounds.

**Git-commit-body exception is SEGMENT-AWARE + MASK-NOT-SKIP (#745).** A `git commit -m "…"` / `git commit -F <file>` MESSAGE body is documentation prose that may contain arbitrary shell-like syntax (a mutation verb or a state path mentioned in the message). The exception MUST be applied via `detectStateFileMutationSegmentAware(command, pathRx)`, which: (1) splits the command on top-level UNQUOTED `&&`/`||`/`;`/`|` (quote-aware; separators inside single/double quotes are prose, not split points); (2) for a COMMIT segment MASKS its quoted body (replaces quoted content with filler) then runs detection on the masked segment; (3) for every other segment runs detection as-is. A whole-command skip (the pre-#745 form) is BLOCKED: it let `git commit -m x && rm <state>` ride the skip (#745 Evasion 1). A whole-SEGMENT skip is also insufficient — `git commit -m x > <state>` rode it, and mask-not-skip exposes the unquoted redirect target while the masked message body still cannot false-flag. Quote-awareness + masking are jointly load-bearing for the no-false-positive contract. TWO further constraints are load-bearing (both redteam-surfaced): (1) masking assumes a quoted body is inert, but `$(…)`/backtick command-substitution AND bash-5.3 `${ …;}`/`${| …;}` funsubs EXECUTE inside double quotes, and `$'…'` ANSI-C quoting desyncs the quote scan — so a commit segment containing any of those MUST fail closed by ALSO scanning the RAW (unmasked) segment (`${x}` parameter expansion runs no command and MUST NOT trigger the re-scan; a benign `$(…)` with no state path MUST NOT over-block). (2) the commit-body recognizer MUST accept the common inline-body forms — `-m`, attached `-m"…"`, combined `-am`, `--message[= ]`, `-F`, `--file[= ]` — a `\s-m\s`-only anchor FALSE-POSITIVE-blocks a legit `git commit -am "…<verb> <state>…"`. Worked evasion/no-false-positive cases: extract § "Git-commit-body exception".

Projects opting in MUST consume the shared helper at `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` (or its segment-aware wrapper `detectStateFileMutationSegmentAware` when a git-commit-body exception applies, as `validate-bash-command.js` does) rather than hand-rolling per-project bash regexes; per-project hand-rolls drift from the shared coverage as new bypass classes emerge. The file-tool path (Write/Edit) routes through `hooks/lib/state-file-write-guard.js::tierClassify({...})` — same shared-lib discipline for the same drift reason.

**The `pathRx` itself is now SHARED too, and the sharing is structurally enforced (loom#1422).** The detector's genericity over `pathRx` is what let the ANSWER fragment even while the DETECTOR stayed shared: "is this a protected state path?" was decided independently at ~10 sites across 4 hooks. Every one is now BUILT from a single declarative registry, `PROTECTED_PATHS` in `hooks/lib/guard-path-scope.js`; surface membership is per-row (`bash` / `layer3` / `direct` / `coordMode` / `postureGate`) because the surfaces genuinely differ. Adding a protected path is one row; adding a fail-closed DIMENSION is one edit to the builder, which is what `security.md` § Enforcement-Surface Parity asks for. `tests/integration/multi-operator/protected-path-predicate-1422.test.js` walks `.claude/hooks/**` and FAILS if any hook re-derives the decision locally — with a planted-violation control that must fire. The `CANONICAL_DENY_FLOOR` triplication is deliberately OUT of scope: each copy is a hardcoded trust anchor so poisoning the mutable bin cannot lower the enforced floor, and consolidating it would destroy that independence. Per-site inventory + per-row surface rationale: extract § "The shared pathRx registry".

**Three dimensions landed through that registry** (each of which would previously have needed the same edit at ~10 sites):

- **Redundant path forms (loom#1409).** `.claude//X` and `.claude/./X` resolve to the same file as `.claude/X` under POSIX, but only the canonical spelling was fenced, on every layer. The bypass costs one character, needs no symlink and no race, and a `"$DIR/" + "/file"` join produces it by accident. The fix widens the SEPARATOR token the registry joins segments with, so all four layers inherit it; whole-command normalization was rejected because the detector deliberately operates on segments and masks doc-carrier bodies. `..` is DELIBERATELY not folded in: `//` and `/./` are no-ops, while a `..` segment names a DIFFERENT file.
- **`.claude/settings.local.json` (loom#1429 AC-3).** It carries an `env` block reaching every hook subprocess — the same authority class as `settings.json` — but matched neither regex. BASH LANE ONLY, deliberately: `/settings` legitimately writes it with file tools, so an Edit fence would over-block a documented happy path; the file-tool side is covered by `settings-deny-drift-guard.js`'s dangerous-env scan.
- **`.claude/bin/ecosystem.json` (loom#1441).** The coordination MASTER SWITCH above every other fence — a `coordination.enabled:false` there disables all 10 gate call sites — and it was fenced on NO lane. Now on the Bash lane AND integrity-guard's DIRECT set (Rule 5 lockstep). NOT added to `permissions.deny`: `/ecosystem-init` writes it with file tools on a fresh fork, the same reason `.claude/VERSION` is absent from `CANONICAL_STATE_DENY`. This fences the AGENT write vector only — it does NOT verify the file's commit state at runtime, so a non-agent process can still leave an uncommitted canonical config, a residual explicitly not claimed closed (`coordination-mode.js` § HONEST LIMITS).

**The prose exception is QUOTE-AWARE and covers EVERY prose carrier (#1363).** The
mask above is what stops a state path MENTIONED in a message from flagging. Two
gaps made it self-sealing — an accurate bug report, commit message, or PR
description ABOUT a state file tripped the guard PROTECTING that file, so the
detector suppressed its own defect reports.

1. **The executing-construct test MUST be quote-aware.** A `$(…)`, backtick,
   `$'…'`, or `${ …;}` forces the fail-closed RAW re-scan ONLY where the shell
   would ACT on it — unquoted, or inside a DOUBLE-quoted span (with `\$` / `` \` ``
   honored as escapes). **Inside a SINGLE-quoted span every byte is literal**, so
   nothing there can execute; matching a construct there is a false positive.
   Markdown code-quoting a command inside a quoted prose body
   (``git commit -m 'fix `node -e` handling of <state>'``) is ordinary practice and
   MUST NOT block. Fail-closed cases are UNCHANGED: an unterminated quote, and
   `$'…'` at an unquoted position, both still fail closed.

   **Which test a site uses is decided by DIRECTION, never by a file list.**
   QUOTE-AWARE where a MATCH RELAXES detection (treats content as inert, narrows
   scope, masks a payload) — an over-match there is fail-OPEN. FLAT where a MATCH
   TIGHTENS it — an over-match there is fail-CLOSED and free. **Converting a
   TIGHTENING site to the quote-aware form makes it match LESS and moves it
   fail-OPEN: BLOCKED.** Surviving flat uses are NOT a migration backlog; a
   `/redteam` round MUST NOT "finish the migration" by count. Per-site accounting
   - the executed no-narrowing check: extract § "Directional invariant".

2. **The prose-carrier recognizer MUST be a POSITIVE allowlist on BOTH axes** —
   an allowlisted COMMAND paired with a flag that means "human message" FOR THAT
   COMMAND (`cc-artifacts.md` Rule 10). Covering only `git commit` +
   `gh (issue|pr) create|edit --body` + `echo`/`printf` left `git tag -m`,
   `git notes -m`, `gh release --notes`, `gh gist --desc`, and
   `gh pr comment|review --body` raw-scanned. Both axes are load-bearing: a flat
   `-m` mask would wrongly swallow `python3 -m <module>` (execution) and
   `git revert -m 2` (a mainline PARENT NUMBER, not a message); a denylist of
   "commands that execute" would silently admit every unlisted interpreter.
   Masking stays mask-NOT-skip, so a real unquoted redirect/verb on a prose
   carrier's segment (`git tag -m 'x' > <state>`) still fires at Layer 1.

**Why:** the narrowing is by QUOTE CONTEXT and COMMAND IDENTITY — both
structural shell facts — not by "this looks like prose". It removes only
matches the shell provably cannot execute, so it cannot convert a real mutation
into a pass; the preserved-behavior fixtures below pin that.

**The narrowing MUST re-use the ORIGINAL character classes, never a
hand-enumerated copy** (`FUNSUB_BLANK_RX` = the same `[\s|]` the flat regex uses).
Hand-enumerating is BLOCKED: the first implementation dropped SIX members of JS
`\s`, each a MEASURED BLOCK→PASS regression (#1390 review S6). A narrowing
justified by QUOTE CONTEXT never licenses shrinking a CHARACTER CLASS; on the
fail-closed side over-matching is free, so class parity is the floor. See extract
§ "The blank-set lesson".

```bash
# DO — read via cat/jq/grep (no layer matches); use wrapper for writes
cat <state-file>
node -e "JSON.parse(require('fs').readFileSync('<state-file>'))"   # read — PASSES post-#1292 (no write token)
# DO NOT — Layer 1/2 bypass redirect-only detection (structural → severity:block)
cp /tmp/forged.json <state-file>             # Layer 2 BLOCK (verb + literal path)
echo '{}' > <state-file>                      # Layer 1 BLOCK (redirect + literal path)
# ADVISORY (non-blocking, #1293 Option X) — Layer 3 on a BOUNDED path
node -e "require('fs').appendFileSync('.claude/learning/observations.jsonl','{}')"  # Layer 3 halt-and-report (surfaces, does NOT block)
# BLOCK (#1293 Option X) — Layer 3 on non-fold-derived AUTONOMY/AUTHORITY state
python -c "open('.claude/learning/posture.json','w').write('{}')"  # Layer 3 BLOCK (posture = trusted L5 grant, not fold-derived on coord-OFF)
node -e "require('fs').writeFileSync('.claude/operators.roster.json','{}')"  # Layer 3 BLOCK (committed quorum-gated authority)
```

**Why:** Layer 1/2/4 are structurally-unambiguous command-shape signals (a redirect operator / a file-util verb on a LITERAL path / a heredoc write-then-run bundle) → `severity:block` per `hook-output-discipline.md` MUST-2; a `cp /tmp/forged.json <state-file>` accomplishes the exact same forgery as `cat <<EOF > <state-file>` and both are hard-blocked. **loom#1703 makes that claim EARNED rather than asserted, and splits the case where it is not true.** Every hit carries a `scope` field from the path-identity oracle (§ Known residuals (k)): on `in-tree` the message keeps "structurally-unambiguous", now a statement about a computed canonical path rather than token adjacency; on `unresolved` the command STILL BLOCKS, fail-closed, but the message MUST name the match as LEXICAL and say the hook does not expand shell syntax (MUST-3). Before #1703 both printed the same sentence, so a reader could not tell a true positive from a documented over-block — precisely what `hook-output-discipline.md` MUST-2 forbids `block` severity from doing. **Layer 3 is `halt-and-report` (advisory, non-blocking) per #1293 — but ONLY for the BOUNDED state set**, whose forged write is neutralized WITHOUT relying on a fold: a lexical body-scan cannot distinguish an executed write from a read-only body or a documentation-quoted example, which MUST-2 forbids carrying `block`. **Non-fold-derived AUTONOMY/AUTHORITY state KEEPS `severity:block` at Layer 3** (`LAYER3_BLOCK_RX`), because the signed-fold defense is UNAVAILABLE on a coordination-OFF repo and their forgery would STAND. The signed-fold / fail-closed-to-L1 layer is the load-bearing forgery defense for surface-rewrite residuals; the Layer-1/2/4 and `LAYER3_BLOCK_RX` blocks are boundary defense-in-depth. Both path sets are enumerated in § Severity-by-layer above.

### 6. Override Env-Var Is Checked FIRST

The override env-var (e.g. `<PROJECT>_HOOK_OVERRIDE_STATE_GUARD=1`) MUST be checked at the top of every routing function (file-tool path AND bash path), BEFORE any T4 / T3 / signature / contract-doc check. SELF-first ordering makes the rule-promised escape hatch dead code for hook-self / contract-doc / smoke-report edits.

```javascript
// DO — override checked first; covers every protected category
if (process.env.OVERRIDE_ENV_VAR === "1") return { block: false, tier: "OVERRIDE" };
if (HOOK_SELF_PATTERNS.some(...)) return { block: true, tier: "T4" };
// DO NOT — SELF check first (override never reached for SELF paths)
```

**Why:** Check-order makes the documented override either live or dead. SELF-first makes "set the override env var to perform an atomic update" a contradiction — the only path becomes stripping the hook from settings.json (unprotected), performing the update, and restoring the hook — desynchronizes documented contract from enforced behavior.

### 7. Override Protocol — Atomic Updates Only

To update the contract (add/remove a prohibited string, add a new identifier, change tier semantics): edit the project's contract spec + smoke manifest + smoke spec + validator + hook + rule instantiation + regression suite atomically in ONE commit. The override env-var bypasses the hook for the duration set in the hook environment (via `.claude/settings.local.json` env block, OR strip-and-restore on `.claude/settings.json` with net-zero diff).

Using the override MUST be authorized in chat by the user AND followed by a same-session commit covering all artifacts in lockstep. Leaving the override active across sessions is BLOCKED.

**Why:** The override exists for genuine atomic-update commits, not workflow convenience. Each use must be in-session, authorized, and bounded — same discipline as `--no-verify` on git commits.

## MUST NOT

- Skip the wrapper because the smoke "would pass anyway"

**Why:** Pre-emptively asserting the smoke would pass is the same judgment-based reasoning that produces false-GREEN. The contract scan catches what the agent's walk does not.

- Modify the validator, hook, rule, spec, manifest, smoke spec, or regression test without updating the others atomically

**Why:** The artifacts form a contract. Drift between any two opens the gap that the contract closes.

- Suppress prohibited contract strings to make the smoke pass

**Why:** The prohibited list is the structural ban. Hiding stubs to pass the smoke is the precise fraud the gate exists to prevent.

- Hand-write the smoke report to forge a signed state file

**Why:** The smoke report is the validator's trust root. The signature attests the wrapper produced these reports; bypassing the wrapper invalidates the entire mechanism.

## Trust Posture Wiring

- **Severity:** `block` for the structurally-unambiguous Bash layers (1/2/4) + the file-tool tier matrix in projects that wire the structural hook (env-var override is the documented escape hatch); `halt-and-report` (advisory, non-blocking) for the Bash Layer-3 interpreter-body scan (#1293, per `hook-output-discipline.md` MUST-2); `advisory` for projects without a hook (rule is prose discipline).
- **Grace period:** N/A — baseline rule landed by global emission, not newly-authored for this repo. Per-project enforcement begins when the project wires the hook.
- **Regression-within-grace:** N/A at the global rule layer (no grace). Project-specific instantiations adopt their own grace + regression policy when wired. A consumer that ships the hook then later ships a Write/Bash bypassing it triggers `regression_within_grace` per `trust-posture.md` MUST Rule 4 — emergency downgrade L5→L4.
- **Cumulative threshold:** T3 unsupported-claim detections log to the shared `violations.jsonl` per `trust-posture.md` MUST Rule 4 cumulative path (3× same-rule in 30d → drop one posture; 5× total in 30d → drop one posture).
- **Receipt requirement:** none at the global rule layer. Project-specific instantiations MAY require `[ack: state-file-write-guard]` on first edit of a protected path; project's call.
- **Detection mechanism:** project-supplied PreToolUse hook calling `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` for the bash layer + `hooks/lib/state-file-write-guard.js::tierClassify(...)` for the file-tool layer + project-supplied validator producing the `contractScanResult` input. **Probes: REGISTERED** — `.claude/test-harness/probes/state-file-write-guard.probes.json` (18 rows, 9 bipolar pairs; fixtures `.claude/audit-fixtures/state-file-write-guard/`; probe-only, pinned in `probe-suite-integrity.test.mjs`). Registration buys DISPATCHABILITY, never execution — a green CI run is NEVER evidence these probes passed.

### Trust Posture Wiring — Layer-3 Severity Demotion (#1293)

Applies to the **Bash Layer-3 severity-by-path-class split** (added 2026-07-22, loom#1293, disposition Option X); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. The pre-existing § Trust Posture Wiring above had its **Severity field accuracy-touched** by this change (Rule 5 lockstep required it — leaving the stale line would have been a doc↔impl drift); its REMAINING pre-existing fields stay grandfathered until each is itself `/codify`-touched. Clause-scoped precedent: `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge.

- **Severity:** `halt-and-report` at the hook layer for a BOUNDED Layer-3 interpreter-body match (a lexical body-scan MUST NOT carry `block` per `hook-output-discipline.md` MUST-2); the `LAYER3_BLOCK_RX` block KEEPS `block` as a DELIBERATE, ratified, fail-closed MUST-2 deviation (acknowledged in § "Severity by layer"). `halt-and-report` at gate-review (reviewer + security-reviewer + cc-architect confirm the BOUNDED Layer-3 set — `observations.jsonl`/`.heartbeat-cache`/`.session-end-cache` — emits advisory; the `LAYER3_BLOCK_RX` set — `posture.json`/`.bak`/`.tmp`, `.initialized`, `presence-mechanism.json`, `violations.jsonl`, `operators.roster.*`, `coordination-log.jsonl` — keeps `block`; Layers 1/2/4 keep `block`; and the impl↔rule↔fixtures moved in lockstep per Rule 5).
- **Grace period:** 7 days from clause landing (2026-07-22 → 2026-07-29).
- **Cumulative posture impact:** same-class violations (re-promoting the BOUNDED Layer-3 body-scan to `block`, OR demoting a Layer 1/2/4 structural signal OR any `LAYER3_BLOCK_RX` autonomy/authority path's Layer-3 block to advisory) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a severity-by-layer property is review-layer-plus-structural-hook and the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: state-file-write-guard]` IFF `posture.json::pending_verification` includes the `state-file-write-guard` rule_id.
- **Detection mechanism:** Phase 1 (structural + review) — the audit fixtures at `.claude/audit-fixtures/violation-patterns/detectStateFileMutation/` pin the layer classification; the severity routing is asserted by `.claude/test-harness/tests/validate-bash-command-state-severity.test.mjs` (Layer 1/2 → block; heredoc write-run bundle to an autonomy path → block; `LAYER3_BLOCK_RX` → block/exit-2; BOUNDED Layer-3 → halt-and-report/exit-0; + the two #1293 AC repros). Gate-review: reviewer + security-reviewer + cc-architect confirm the layer+path-class→severity mapping + the lockstep impl/rule/fixture move (Rule 5). Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no new hook detector (the mapping is enforced in `validate-bash-command.js` directly).
- **Violation scope:** the Bash Layer-3 severity-by-path-class clause ONLY (clause-scoped); the pre-existing § Trust Posture Wiring's remaining fields stay grandfathered until each is itself `/codify`-touched (its Severity field was accuracy-touched here, per the grandfather note above).
- **Origin:** loom#1293 (root-cause architectural resolution). Disposition Option X: the initial broad carve-out (demote all non-authority Layer-3, treating posture.json/violations/observations as "fold-caches re-derived away") was REFUTED by the security redteam — on a coordination-OFF repo (the default downstream) no fold runs, so posture.json/.initialized/presence/violations forgeries would stand; Option X keeps them blocked and demotes only the genuinely-bounded observations.jsonl + ephemeral caches. Cross-ref `hook-output-discipline.md` MUST-2 (lexical signals never carry `block` — the block-set is the ratified fail-closed deviation).

### Clause-scoped wiring — Prose exception is QUOTE-AWARE and covers every prose carrier (added 2026-07-26)

Applies to the **§ "The prose exception is QUOTE-AWARE and covers EVERY prose carrier (#1363)"** clause ONLY (its two numbered MUSTs); ships canonical-8-field-compliant per `trust-posture.md` MUST-8. The pre-existing grandfathered sections of this file — including the § Severity-by-layer wiring above — stay on their own wiring until each is itself `/codify`-touched (clause-scoped precedent: `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `halt-and-report` at gate-review (reviewer + security-reviewer + cc-architect confirm the executing-construct test is quote-aware at ALL THREE call sites — the per-line Layer-1/2 mask choice, the segment fail-close, and the body-flag VALUE inertness check — that the prose-carrier recognizer is a positive allowlist on BOTH the command and flag axes, and that masking stays mask-NOT-skip); `advisory` at the hook layer per `hook-output-discipline.md` MUST-2 (no structural tool-call-time signal — quote-context correctness is judgment-bearing over a diff).
- **Grace period:** 7 days from clause landing (2026-07-26 → 2026-08-02).
- **Cumulative posture impact:** same-class violations (re-introducing a flat "executing construct anywhere" test; widening the prose-carrier mask on ONE axis only — a bare flag set with no command allowlist, or a command allowlist admitting an interpreter; converting mask-not-skip into a segment SKIP) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the 7-day grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a quote-context/allowlist-shape property is review-layer-plus-fixture and does not warrant an instant-drop key; minting one would drag `trust-posture.md`, a self-referential-codify allowlist file, into a self-ref edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition § Severity-by-layer and `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: state-file-write-guard]` IFF `posture.json::pending_verification` includes the `state-file-write-guard` rule_id.
- **Detection mechanism:** Phase 1 (structural) — the 18 committed fixtures at `.claude/audit-fixtures/violation-patterns/detectStateFileMutationSegmentAware/{clean,flag}-f3-1363-*`, one per scope-restriction predicate, each case-name naming its finding id; 8 `clean-*` rows FLAGGED before the fix and are clean after, and 10 pin PRESERVED fail-closed behavior. Per-row inventory: extract § "(l)". Runner: `../detectStateFileMutation/test.mjs`, iterating both fixture dirs. Gate-review: reviewer + security-reviewer + cc-architect confirm the lockstep impl/rule/fixture move (Rule 5). Phase 2 (deferred per `trust-posture.md` § Two-Phase Rollout) — no new hook detector; the property is enforced in `violation-patterns.js` directly.
- **Violation scope:** the § "prose exception is QUOTE-AWARE" clause ONLY (clause-scoped); the pre-existing grandfathered sections stay exempt until each is itself `/codify`-touched.
- **Origin:** loom#1363, filed downstream with an EXECUTED A–F matrix, then reproduced FOUR times unprompted at loom in one session; root-caused by a 61-case carrier × quote-style × backtick matrix. Issue Defect 4 (demote the lexical `block`) was NOT taken — § Severity-by-layer records that block as a co-owner-ratified fail-closed MUST-2 deviation whose demotion is itself a same-class posture violation, so the FP root cause was fixed instead. Full matrix + the Defect-3 sync-lag finding: extract § "(l)".

### Clause-scoped wiring — Layer-4 backstop requires a REAL write→exec correlation (added 2026-08-13, loom#1426)

Applies to the **residual (m) closure** ONLY — the Layer-4 backstop's target↔exec correlation, and the § "Authoring a probe or a report that TOUCHES a protected path" affordance that accompanies it. Ships canonical-8-field-compliant per `trust-posture.md` MUST-8. Every other section of this file, including the two clause-scoped blocks above, stays on its own wiring (clause-scoped precedent: `security.md` § Enforcement-Surface Parity + `git.md` § CI-check/merge).

- **Severity:** `block` at the hook layer, KEPT and now genuinely EARNED under `hook-output-discipline.md` MUST-2 — this is NOT one of the file's recorded MUST-2 deviations: the Layer-4 signal is a same-file write→EXECUTE dataflow, a command-SHAPE fact rather than a lexical form. Before #1426 the BACKSTOP arm did not meet that bar (its conjuncts had no dataflow relation), so closing (m) restores the entitlement the rule already claimed rather than relaxing it. `halt-and-report` at gate-review (reviewer + security-reviewer + cc-architect confirm the correlation is by TOKEN IDENTITY on a write target, that INPUT-redirect operands remain executable-script candidates, and that no `flag-*` bundle fixture was re-pinned to `null` to make a change pass).
- **Grace period:** 7 days from clause landing (2026-08-13 → 2026-08-20).
- **Cumulative posture impact:** same-class violations (re-admitting output-redirect operands as executed tokens; dropping INPUT-redirect operands from the executed set; re-pinning a `flag-*` bundle fixture to `null` rather than fixing the detector; or re-orphaning the fixture directory by removing its `runFixtureDir` call) contribute to `trust-posture.md` MUST-4 cumulative-window math (3× same-rule in 30d → drop 1 posture; 5× total in 30d → drop 1 posture).
- **Regression-within-grace:** a same-class violation within the grace window routes through the GENERIC `regression_within_grace` emergency trigger per `trust-posture.md` MUST-4 (1× = drop 1 posture) — NO dedicated per-clause trigger key (a detector-correlation property is fixture-plus-review-layer and does not warrant an instant-drop key; minting one would drag `trust-posture.md`, a `self-referential-codify.md` allowlist file, into a self-referential edit; the universal trigger already covers it). Named deviation from the canonical key-per-clause shape, recorded here per `trust-posture.md` Rule 8 — the same no-dedicated-key disposition § Severity-by-layer and `security.md` § Enforcement-Surface Parity took.
- **Receipt requirement:** SessionStart soft-gate `[ack: state-file-write-guard]` IFF `posture.json::pending_verification` includes the `state-file-write-guard` rule_id (shared rule_id; one ack covers every clause in this file).
- **Detection mechanism:** Phase 1 (structural). `.claude/audit-fixtures/violation-patterns/detectHeredocWriteRunBundle/` — 25 `flag-*` + 10 `clean-*` pairs, executed via `../detectStateFileMutation/test.mjs` (which runs locally + at gate-review; it is NOT in the CI structural job — see § Cross-references for the measured bound, and do NOT read a green CI as evidence these passed), which also enforces the reachability + `NO_PROTECTED_PATH_FIXTURES` anti-vacuity floor on them. Anti-vacuity is MEASURED, not assumed (mutation reach confirmed by an in-branch flag per `instrument-discipline.md` MUST-2(b)); the mutation matrix and the five RED-then-green `clean-1426-*` rows are in extract § "(m)". Gate-review: reviewer + security-reviewer + cc-architect confirm the impl/rule/fixture lockstep move (Rule 5). Phase 2 (deferred) — no new hook detector; the property lives in `violation-patterns.js`.
- **Violation scope:** the residual-(m) closure + the probe-authoring affordance ONLY (clause-scoped); residuals (k) and (l) remain OPEN and are NOT covered by this clause.
- **Origin:** loom#1426. Five actors blocked, every one while verifying or documenting this guard; the residual text said a narrowing analysis was owed and nothing tracked it. The analysis found the backstop's width was an artefact, not the fail-closed defence it was recorded as. The obfuscation-training tension the issue names is answered by the affordance, not by a detector relaxation.

## Composition

This rule is the **per-deploy claim** layer; `rules/trust-posture.md` is the **per-repo authority** layer. T3 unsupported-claim detections log to the shared `violations.jsonl`; cumulative T3 violations cross the trust-posture downgrade threshold and the agent's repo-wide authority degrades on the next session. The deploy claim being blocked is the single-event defense; the posture downgrade is the cross-session learning.

## Cross-references

- `rules/trust-posture.md` — composition partner (per-repo authority layer)
- `rules/zero-tolerance.md` Rule 3 — silent-fallbacks parent class
- `rules/hook-output-discipline.md` MUST-2 — block-severity structural-signal requirement
- `.claude/hooks/lib/violation-patterns.js::detectStateFileMutation` — shared three-layer Bash-side helper
- `.claude/hooks/lib/violation-patterns.js::detectHeredocWriteRunBundle` — Layer-4 whole-command heredoc write+RUN-bundle helper (#764 item 3; called as the fallback pass inside `detectStateFileMutationSegmentAware`)
- `.claude/audit-fixtures/violation-patterns/detectHeredocWriteRunBundle/` — 25 flag + 10 clean fixtures (per cc-artifacts.md Rule 9), wired through `../detectStateFileMutation/test.mjs` at loom#1426 after being orphaned since #764. **Scope of that claim, stated rather than implied:** that runner executes locally and at gate-review and is deliberately ABSENT from the CI structural job, so **a green CI run is NOT evidence these fixtures passed** — run the runner. Orphan measurement + the ReDoS-bound reason CI declines it: extract § "(m) — the Layer-4 backstop's real trigger"
- `.claude/test-harness/tests/register-roster-write-guard.test.mjs` — `BUNDLE` (write+run blocks) + `NEW-A`/`NEW-A2`/`NEW-B`/`NEW-C` (separate-invocation ceremony stays accepted)
- `.claude/hooks/lib/state-file-write-guard.js` — parameterized file-tool tier classifier + signature emitter + override + gap validator
- `.claude/test-harness/tests/state-file-write-guard.test.mjs` — structural regression suite (38 cases)
- `.claude/test-harness/tests/validate-bash-command-state-severity.test.mjs` — #1293 severity-by-layer regression lock, Option X (Layer 1/2 + heredoc-bundle-to-autonomy → block; Layer 3 `LAYER3_BLOCK_RX` autonomy/authority — posture/.initialized/presence/violations/roster/coordination-log → block; Layer 3 bounded — observations.jsonl/caches → advisory; + the two #1293 acceptance-criteria repros)

**Length rationale — atomic state-claim contract.** This rule exceeds 200 body lines because its signer binding, four-tier verdict matrix, override ordering, four-layer severity mapping, accepted residuals (a)–(n), and four wiring blocks must be evaluated together to decide whether a protected write is allowed. The existing F100 extraction already moved recovery mechanics and incident narratives to the companion; keeping the remaining conditions adjacent prevents a summary from granting GREEN, override, or advisory treatment while omitting the constraint that limits it.

Origin: 2026-05-05 — false-GREEN deploy claim; v1 hook self-redteam surfaced four follow-up gaps (Layer 2/3 bash, smoke-report trust root, contract-doc protection, override-ordering); v2 closed them. loom #25 endorsed global adoption; PR #125 lifted this rule + the Bash-side helper, and the parameterized file-tool library followed per the loom-distillation principle. Project-specific surface stays at the consumer. Full post-mortem: extract § Origin.

**Extraction record (F100, 2026-08-20).** `emit-coc.mjs` measured this rule's emitted
`.coc/` artifact at **85330B against the 61440B
`FILE_SIZE_WARN_BYTES` producer budget — over by 23890B**. Depth moved to the paired
`guides/rule-extracts/state-file-write-guard.md`, which is not `.coc/`-emitted:
residual (a)–(i) mechanism, the `STATE_INTERP_WRITE_SOURCES` seven-group enumeration +
the #1337 corpus, Layer-4 heredoc parser mechanics, the Layer-3 per-path forgery
analysis, the git-commit worked evasions, the `PROTECTED_PATHS` site inventory, and the
(k)/(l)/(m) + #1363/#1426 measurement narratives. **RETAINED IN FULL, verified by count
and traced span:** every MUST/MUST NOT, BLOCKED entry, DO/DO-NOT block and `**Why:**`;
all seven Rule headings; the tier matrix; the four-layer severity mapping; the residual
register (a)–(n) with status markers; all four Trust-Posture-Wiring blocks with their
canonical field labels. One PRE-EXISTING inaccuracy corrected in passing: § Known
residuals opened "Six vectors are NOT covered" while enumerating fourteen.

**Rule 10 / Rule 11 disposition — NEITHER FIRES.** Rule 10 § "Trigger scope" limits it
to `priority: 0` + `scope: baseline` rules; this is `priority: 10` + `scope:
path-scoped`, so it does not contribute to baseline emission. This is a
STRUCTURAL-CLEANUP extraction against the `emit-coc.mjs` PRODUCER budget — a different
gate from Rule 10's proximity band — and is NOT Rule-11 recurrence input. Same
disposition and reasoning as `wave-loop.md`'s extraction record.
