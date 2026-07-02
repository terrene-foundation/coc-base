---
id: "STATE-FILE-WRITE-GUARD"
paths: ["deploy/**", "**/.last-deployed-*", "**/.last-smoke-result-*", "**/.last-interactions-smoke-result-*", "**/state-file-write-guard.*", "**/validate-state-file.*", "**/post-deploy-smoke.*"]
---

# State-File Write Guard — Validator-Driven Deploy Claims

See `.claude/guides/rule-extracts/state-file-write-guard.md` for full BLOCKED-rationalization corpus, extended DO/DO NOT examples (override-ordering JS, atomic-update protocol steps), composition table, and Origin post-mortem.

A project's deploy state file is the canonical signal for whether a deploy is GREEN. Agents producing GREEN claims based on judgment ("page loaded, no console errors") rather than a wrapper-validated contract scan ship false-GREEN at high frequency: the contract scan catches AI-panel stubs, missing data, partial subsets, and silent backend degradation that surface signals miss.

The agent does NOT decide whether a deploy is GREEN — the validator does. The agent runs the validator (or its wrapper), reads the verdict, and writes accordingly. Pure-text rules at write time are demonstrably insufficient — the structural defense (PreToolUse hook + verdict-tier matrix + signature mechanism) closes the bypass. Loom ships the canonical pattern as a parameterized library: `hooks/lib/state-file-write-guard.js` (verdict tier classifier T1/T2/T3/T4 + signature emitter + override env-var check + honest-YELLOW gap validator) plus `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` for the three-layer Bash mutation coverage. Both are pure logic with no project-specific assumptions; consumers supply a config (state-file shape field names, override env-var name, smoke + interactions report content, contract-scan verdict shape) the lib consumes. Project-specific surface (path globs, validator binary, contract spec, smoke spec) lives in the consumer; the invariant pattern lives at loom.

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

| Tier                       | Condition                                                                                        | Hook decision      |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------ |
| **T1 — Verified GREEN**    | signature valid + contract scan passes + zero prohibited stubs                                   | ALLOW              |
| **T2 — Honest YELLOW**     | `verification_status: "YELLOW"` AND every gap explicitly enumerated                              | ALLOW              |
| **T3 — Unsupported claim** | `"GREEN"` BUT signature missing/invalid OR contract scan fails                                   | BLOCK + diagnostic |
| **T4 — Hook bypass**       | Edit/Write against the structural defense, contract docs, or trust root, OR Bash mutation of any | BLOCK + escalate   |

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

### 4. Trust Root Protection — Smoke Reports Are Wrapper-Only

The validator's signature is `sha256(state-file-without-signature || smoke-report || interactions-report)`. Forgeable smoke reports = forgeable signatures = forgeable GREEN. The hook MUST T4-block direct Write/Edit on the project's smoke-report paths AND T4-block Bash mutation of those paths.

```bash
# DO — wrapper produces both reports + state file in one atomic run
bash scripts/smoke/run-post-deploy-smoke.sh <env>
# DO NOT — hand-edit the smoke report so the validator signs forged GREEN
```

**Why:** Closing only the state-file door while leaving the trust-root door open is the same failure mode at a more dangerous level — agent who could not write GREEN directly can hand-write the smoke report (no protection), then run `validate-state-file --mode=emit-signature` (allowed; wrapper-driven), shipping a "signed" state file built on fraudulent signature input.

### 5. Bash-Layer Mutation Coverage — Four Layers

The Bash-side detection MUST cover four layers, not just shell redirects:

- **Layer 1**: redirect / heredoc / `tee` / `sed -i` / `jq -i` / `cat <<EOF >`. The redirect matcher MUST recognize every file-writing form — `>`, `>>`, `>|` (force-clobber), `&>`, `&>>`, and fd-prefixed `N>` / `N>>` / `N>|` (e.g. `2> <state>` writes stderr to the file) — while excluding fd-DUPLICATION (`2>&1`, `>&2`, whose target is a descriptor, not a file) via the capture class, and MUST scan EVERY redirect target on the line (not just the first). A `(?:^|[^&\d2])>`-style matcher that misses `>|`/`&>`/`N>` is BLOCKED (#745 redteam Finding 1). The segment splitter MUST treat `>|` as one redirect token, NOT split it on the `|` as a pipe.
- **Layer 2**: `cp`, `mv`, `rm`, `dd of=`, `rsync`, `install`, `truncate`, `ln`, `chmod`, `chown`, `touch`, `sponge`.
- **Layer 3**: interpreter bodies (`python`, `node`, `ruby`, `perl`, `bash`, `sh`) — per-line quoted `-c`/`-e`/`-m` forms PLUS a fallback for a command / pipeline-segment **led by** `python`/`node`/`ruby`/`perl` (covers `-m`, unquoted, script-arg, `--eval=`, and stdin-heredoc `python3 - <<PY … PY` forms). Anchoring on the leading interpreter token restores parity with the removed `Bash(python:*<state>*)` / `Bash(node:*<state>*)` deny globs (which anchored on the interpreter as the command executable) **without** false-positive-flagging prose (`echo "python … <path>"`) or interpreter-as-search-arg (`grep python <path>`).
- **Layer 4 — heredoc write+RUN bundle (#764 item 3; whole-command STRUCTURAL pass, `detectHeredocWriteRunBundle`).** The three layers above are per-line / per-segment; they cannot see a bundle that WRITES a script via heredoc AND RUNS it in ONE command — `cat > s.cjs <<EOF … fs.writeFileSync("<protected>") … EOF && node s.cjs` — because `splitShellSegments` is NOT heredoc-aware: the heredoc body's internal `;` (e.g. `writeFileSync(…);`) fractures the interpreter-lead (`node s.cjs`) from the protected-path write across sibling segments, so no per-segment `detectStateFileMutation` call sees both. `detectStateFileMutationSegmentAware` therefore runs a whole-command fallback pass, `detectHeredocWriteRunBundle(command, pathRx)`, matching the STRUCTURAL write→execute conjunction: **(a)** a heredoc whose WRITTEN-SCRIPT body — the target of a `>`/`>>` redirect, a `tee`/`sponge`/`cp`/`install` stdin-sink, or a `dd of=` sink — contains a protected PATH LITERAL anywhere (matched by `pathRx` SUBSTRING — NOT a write-verb allowlist, NOT a prefix-anchored write-call regex, so `open(p,"w")` / `os.rename`, a `./`- / absolute- / `${VAR}`-prefixed path, and a requoted call all still match), AND **(b)** that SAME written script is SUBSEQUENTLY EXECUTED by an interpreter (`node`/`nodejs`/`python`/`python3`/`ruby`/`perl`/`bash`/`sh`/`zsh`) in the same command, matched by TOKEN identity on the write target (`./`-normalized; leading `VAR=val` prefixes stripped, per hook-output-discipline.md MUST-3 the token is NEVER expanded — identity holds regardless of what the var expands to). The conjunction justifies `severity:block` per `hook-output-discipline.md` MUST-2 because it is STRUCTURAL — a real write-a-script-touching-a-protected-path-AND-run-it dataflow, one indirection deeper than the Layer-1 heredoc-to-protected-path redirect the guard already blocks — NOT a lexical form. Surface rewrites of the script NAME, path PREFIX, QUOTING, write VERB, or DELIMITER SHAPE do not evade the detector's coverage. The WRITE-SURFACE and INTERPRETER allowlists are POSITIVE (`cc-artifacts.md` Rule 10): the write surface covers `>`/`>>` + `tee`/`sponge`/`cp`/`install` stdin-sinks + `dd of=`; the interpreter set covers the standard shells + common script interpreters (`node`/`python`/`ruby`/`perl`/`deno`/`bun`/`php`/`tsx`/`Rscript`/`lua`/…); a write-verb or interpreter OUTSIDE either allowlist (a `patch` write, an exotic interpreter, a `mv`-rename dataflow hop) is a documented residual (see § Known residuals), forever-defended by the signed-fold / fail-closed-to-L1 layer. The opener is parsed with bash quote-removal + escape (numeric `<<9`, quoted `<<"9"`, hyphenated `<<'a-b'`, partially-quoted `<<E"O"F`, ANSI-C/locale `<<$'EOF'` / `<<$"EOF"` — all close on their dequoted terminator, not the narrow `[A-Za-z_]` an earlier cut used), and the `<<<` here-string form is STRUCTURALLY excluded (a char-scan, not a regex lookahead a shifted re-match can slip past into a phantom-body evasion). A heredoc opener is committed ONLY when its close line exists downstream, so a decoy `<<WORD` (an arithmetic `1<<4`, a quoted/commented `<<X`) with no close is IGNORED rather than swallowing the RUN line into a phantom body — an unclosed heredoc can only ADD to the scanned surface, never hide from it (fail-toward-more-scanning); and `tee` collects EVERY operand (`tee a b`, `|& tee`, backslash-in-quote args) so executing ANY written file is caught. A fail-closed BACKSTOP covers any residual divergence between this hand-written parser's terminator/close derivation and bash's (an ANSI-C `<<$'EO\x46'` escape, a same-line arithmetic `1<<4` opener with a seeded close, a `\r`-seeded early close): such a divergence can only SPILL the real body + RUN line into `structural`, so if the protected path appears on a structural line AND a structural-written script is executed on a structural line it flags — the per-body `pathRx.test(hd.body)` gate runs before the structural exec-scan and cannot see a truncated body, but the backstop can. TWO residual classes remain, listed in § Known residuals as (a)/(d): var-INDIRECT exec where the write and run use DIFFERENT tokens resolving to the same file (a SHARED var token still matches, identity holding pre-expansion), and — one root cause — a RUN segment NOT recognized as interpreter-led after `VAR=` stripping: a non-`VAR=` command prefix (`sudo`/`env`/`nice`/subshell), direct shebang/executable-bit invocation (`chmod +x s && ./s`), OR shell sourcing (`source s` / `. s`). The forever-defense for both is the signed-fold / fail-closed-to-L1 integrity layer, NOT this interceptor. It does NOT false-block doc/rule/test AUTHORING (which WRITES a file but does NOT execute it, so (b) fails structurally): the LEXICAL heredoc-body write-call regex a prior attempt shipped hard-blocked writing a doc that merely QUOTED `writeFileSync(".claude/…")` — the exact self-block on editing THIS rule's fixtures — which the structural write→execute conjunction avoids. The git-commit exception needs NO special skip in this pass: a commit-MESSAGE heredoc either has no redirect-target script (its body is git's STDIN, `git commit -F- <<MSG`) OR its target file is consumed by `git` (`git commit -F msg.txt`), never by an interpreter — so (b) fails; a heredoc chained AFTER `git commit` (`git commit -m x && cat >s.cjs <<EOF …write… EOF; node s.cjs`) is analyzed on its own write→exec merits, never skipped (strictly tighter than a scoped git-commit skip). Delimiter-close is STRUCTURAL: a plain `<<EOF` closes ONLY on an exactly-`EOF` line (no leading whitespace); a `<<-EOF` strips leading TABS only (never spaces).

**Known residuals (path-based interceptor limits — symmetric with any command-form denylist).** Six vectors are NOT covered by EITHER the hook or the removed deny-matrix, and are accepted: (a) variable-assembled / indirected paths (`P=…; rm "$P"`) — the literal path is absent from the command string, so no path-matcher can resolve it (correct per `hook-output-discipline.md` MUST-3, which forbids in-hook shell expansion); (b) interactive editors (`vim`/`ex`/`ed`/`nano`/`emacs -batch`) — neither layer keys on editor verbs; (c) a script file whose hardcoded body writes the path (`python3 write_state.py`, path not on the command line) — note this residual is the mechanism the SANCTIONED canonical-writer ceremonies rely on by design (the `/whoami --register` roster write + the `/certify` coordination-log anchor each write via a ceremony script invoked by its own path, the protected path living in the script body; these are the licensed writers, not bypasses). A future hardening that closes residual (c) MUST keep those canonical-writer ceremony runs ACCEPTED — `.claude/test-harness/tests/register-roster-write-guard.test.mjs` pins that contract so the regression fails LOUDLY. The #764-item-3 Layer-4 `detectHeredocWriteRunBundle` pass (above) is exactly such a hardening applied to ONE narrow sub-case: a WRITE-then-RUN BUNDLE in a SINGLE command is now CLOSED (a heredoc-written script whose body touches a protected path AND is executed in the SAME command blocks), while the pure by-path ceremony-writer stays ACCEPTED because the ceremony's write (test `NEW-C`) and run (tests `NEW-A`/`NEW-A2`/`NEW-B`) are SEPARATE Bash invocations — each command string is analyzed independently and neither alone satisfies the write+run conjunction (write-in-one-command + run-in-another = OK; write+run in ONE command = BLOCK). Residual (c) as a whole — a hardcoded-body script write NOT bundled with its own execution in the same command — remains open and ceremony-relied-upon; (d) an interpreter behind a command prefix (`sudo`/`env`/`time`/`nice`/a `VAR=val` assignment / a subshell) — the Layer-3 fallback anchors on the interpreter as the leading token of a command segment, the same limit the removed `Bash(python*<state>*)` prefix-glob had (it anchored on the command starting with `python`). The Layer-4 bundle pass (above) shares this non-interpreter-led root cause: its RUN half likewise requires a recognized interpreter lead, so a shebang/executable-bit (`chmod +x s && ./s`) or shell-sourced (`source s` / `. s`) run of the heredoc-written script is the same accepted residual (forever-defense: the signed-fold / fail-closed-to-L1 layer); (e) a `cd` into `.claude/learning/` followed by a bare-relative-path redirect (`cd .claude/learning && echo > posture.json`) — `STATE_PATH_RX` anchors on the literal `.claude/learning/` prefix, which the bare relative path lacks after the `cd` (issue #745 Evasion 2). Residual (e) is the SAME class as (a): the literal protected-path prefix is absent from the mutating segment's token, so no path-matcher can resolve it without in-hook shell expansion (forbidden by `hook-output-discipline.md` MUST-3); closing it at the path-matcher layer is BLOCKED for the same reason (a) is; (f) a glob-metacharacter redirect target (`echo x > .claude/learning/posture.jso[n]`, `posture.jso?`, `posture.js*n`) — bash expands the glob to the real file at runtime, but the pre-expansion token carries a `[`/`?`/`*` that `STATE_PATH_RX` cannot match (the glob must expand to exactly one file, else bash errors "ambiguous redirect"). Residual (f) is the SAME class as (a)/(e): the literal protected path is absent from the pre-expansion command string, so no path-matcher can resolve it without in-hook glob expansion (forbidden by `hook-output-discipline.md` MUST-3). (g) PATH-AS-DATA indirection — the protected path is written to a DATAFILE (not the executed script) and the executed script READS it at runtime (`echo <path> > /tmp/pf; node -e '…read /tmp/pf…write…'`); the literal path is a datafile byte, not present in the executed script, so neither the per-body check nor the backstop resolves it — SAME class as (a) var-indirect and reproducible with NO heredoc; (h) a WRITE VERB or INTERPRETER outside the POSITIVE allowlists (Layer 4 above) — a `patch`/`ed` write, a `mv`-rename dataflow hop, or an interpreter absent from `RUN_INTERPRETER_RX`; broadening the allowlists (`sponge`/`cp`/`install`; `deno`/`bun`/`php`/…) narrows this residual but a positive allowlist is never exhaustive. Sub-case: a listed SINK verb behind a command PREFIX (`sudo tee s`, `env cp /dev/stdin s`) is not stage-lead-recognized — the WRITE-half analogue of (d) (a `>`/`dd of=` write behind a prefix IS still caught, since those scan the whole line, not the stage lead). Residuals (a)–(f) were equally open under the prior `Bash(verb:path)` deny-matrix; the deepest forever-defense for the coordination log + posture state is the signed-fold / fail-closed-to-L1 integrity layer, not the command interceptor. The Layer-3 fallback ALSO over-blocks one narrow benign shape the prefix-glob did not: a compound command that BOTH reads a state file AND runs an UNRELATED interpreter in a sibling segment (`cat <state> && python3 unrelated.py`) flags because the path-match is tested against the whole command while the interpreter leads a later segment. This is a fail-CLOSED over-block (a blocked read; remediation: split the compound command), accepted deliberately so the stdin-heredoc cross-line write (`python3 - <<PY … <path> … PY`, path on a body line) stays covered — narrowing the path-match to the led segment alone would re-open that write vector, the wrong (fail-open) trade for a trust-substrate control.

**Git-commit-body exception is SEGMENT-AWARE + MASK-NOT-SKIP (#745).** A `git commit -m "…"` / `git commit -F <file>` MESSAGE body is documentation prose that may contain arbitrary shell-like syntax (a mutation verb or a state path mentioned in the message). The exception MUST be applied via `detectStateFileMutationSegmentAware(command, pathRx)`, which: (1) splits the command on top-level UNQUOTED `&&`/`||`/`;`/`|` (quote-aware; separators inside single/double quotes are prose, not split points); (2) for a COMMIT segment MASKS its quoted body (replaces quoted content with filler) then runs detection on the masked segment; (3) for every other segment runs detection as-is. A whole-command skip (the pre-#745 form, `isGitCommitWithBody ? null : detect(...)`) is BLOCKED: it let `git commit -m x && rm <state>` ride the skip because the leading-anchor `[^|;]*` did not exclude `&` (issue #745 Evasion 1). A whole-SEGMENT skip is also insufficient: `git commit -m x > <state>` (a redirect ON the commit segment — the same exploitation primitive) rode it; mask-not-skip exposes the unquoted redirect target while the masked message body still cannot false-flag. Quote-awareness + masking are jointly load-bearing for the no-false-positive contract: `git commit -m "cleanup && rm <state>"` keeps the operator inside the quotes (one segment) AND masks the body, so a mentioned verb/path never flags — a naive split-on-`&&` OR a run-detection-on-the-raw-commit-segment would each re-expose the false positive. TWO further constraints are load-bearing (both redteam-surfaced): (1) masking assumes a quoted body is inert, but `$(…)`/backtick command-substitution AND bash-5.3 `${ …;}`/`${| …;}` funsubs EXECUTE inside double quotes, and `$'…'` ANSI-C quoting desyncs the quote scan — so a commit segment containing any of those MUST fail closed by ALSO scanning the RAW (unmasked) segment (`${x}` parameter expansion runs no command and MUST NOT trigger the re-scan) (`git commit -m "$(rm <state>)"` and `git commit -m $'\'' && rm <state>` MUST block; a benign `$(…)` with no state path MUST NOT over-block). (2) the commit-body recognizer MUST accept the common inline-body forms — `-m`, attached `-m"…"`, combined `-am`, `--message[= ]`, `-F`, `--file[= ]` — a `\s-m\s`-only anchor FALSE-POSITIVE-blocks a legit `git commit -am "…<verb> <state>…"` whose message merely mentions a verb + state path.

Projects opting in MUST consume the shared helper at `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` (or its segment-aware wrapper `detectStateFileMutationSegmentAware` when a git-commit-body exception applies, as `validate-bash-command.js` does) rather than hand-rolling per-project bash regexes; per-project hand-rolls drift from the shared coverage as new bypass classes emerge. The file-tool path (Write/Edit) routes through `hooks/lib/state-file-write-guard.js::tierClassify({...})` — same shared-lib discipline for the same drift reason.

```bash
# DO — read via cat/jq/grep (no layer matches); use wrapper for writes
cat <state-file>
# DO NOT — Layer 2/3 bypass redirect-only detection
cp /tmp/forged.json <state-file>             # Layer 2 BLOCK
python -c "open('<state-file>','w').write('{}')"  # Layer 3 BLOCK
```

**Why:** Layer 2 and Layer 3 silently bypass redirect-only detection. A `cp /tmp/forged.json <state-file>` accomplishes the exact same forgery as `cat <<EOF > <state-file>`. Cost of Layer-3 false-positive is "use cat instead" — tiny — vs cost of Layer-2/3 false-negative (forged GREEN ships) — the entire failure mode this guard exists to close.

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

- **Severity:** `block` for projects that wire the structural hook (env-var override is the documented escape hatch); `advisory` for projects without a hook (rule is prose discipline).
- **Grace period:** N/A — baseline rule landed by global emission, not newly-authored for this repo. Per-project enforcement begins when the project wires the hook.
- **Regression-within-grace:** N/A at the global rule layer (no grace). Project-specific instantiations adopt their own grace + regression policy when wired. A consumer that ships the hook then later ships a Write/Bash bypassing it triggers `regression_within_grace` per `trust-posture.md` MUST Rule 4 — emergency downgrade L5→L4.
- **Cumulative threshold:** T3 unsupported-claim detections log to the shared `violations.jsonl` per `trust-posture.md` MUST Rule 4 cumulative path (3× same-rule in 30d → drop one posture; 5× total in 30d → drop one posture).
- **Receipt requirement:** none at the global rule layer. Project-specific instantiations MAY require `[ack: state-file-write-guard]` on first edit of a protected path; project's call.
- **Detection mechanism:** project-supplied PreToolUse hook calling `hooks/lib/violation-patterns.js::detectStateFileMutation(command, pathRx)` for the bash layer + `hooks/lib/state-file-write-guard.js::tierClassify(...)` for the file-tool layer + project-supplied validator producing the `contractScanResult` input.

## Composition

This rule is the **per-deploy claim** layer; `rules/trust-posture.md` is the **per-repo authority** layer. T3 unsupported-claim detections log to the shared `violations.jsonl`; cumulative T3 violations cross the trust-posture downgrade threshold and the agent's repo-wide authority degrades on the next session. The deploy claim being blocked is the single-event defense; the posture downgrade is the cross-session learning.

## Cross-references

- `rules/trust-posture.md` — composition partner (per-repo authority layer)
- `rules/zero-tolerance.md` Rule 3 — silent-fallbacks parent class
- `rules/hook-output-discipline.md` MUST-2 — block-severity structural-signal requirement
- `.claude/hooks/lib/violation-patterns.js::detectStateFileMutation` — shared three-layer Bash-side helper
- `.claude/hooks/lib/violation-patterns.js::detectHeredocWriteRunBundle` — Layer-4 whole-command heredoc write+RUN-bundle helper (#764 item 3; called as the fallback pass inside `detectStateFileMutationSegmentAware`)
- `.claude/audit-fixtures/violation-patterns/detectHeredocWriteRunBundle/` — 22 flag + 5 clean fixtures (per cc-artifacts.md Rule 9)
- `.claude/test-harness/tests/register-roster-write-guard.test.mjs` — `BUNDLE` (write+run blocks) + `NEW-A`/`NEW-A2`/`NEW-B`/`NEW-C` (separate-invocation ceremony stays accepted)
- `.claude/hooks/lib/state-file-write-guard.js` — parameterized file-tool tier classifier + signature emitter + override + gap validator
- `.claude/test-harness/tests/state-file-write-guard.test.mjs` — structural regression suite (38 cases)

Origin: 2026-05-05 — false-GREEN deploy claim; v1 hook self-redteam surfaced four follow-up gaps (Layer 2/3 bash, smoke-report trust root, contract-doc protection, override-ordering); v2 closed them. Issue #25 (loom) endorsed global adoption; PR #125 (2026-05-10) lifted the institutional-knowledge layer (this rule) + Bash-side helper. Subsequent lift (2026-05-10): the parameterized file-tool library `state-file-write-guard.js` lifted at loom per the loom-distillation principle (loom owns canonical global patterns, not consumer-specific implementations). Project-specific surface (path globs, validator binary, contract spec, smoke spec) stays at the consumer. See guide for full post-mortem.
