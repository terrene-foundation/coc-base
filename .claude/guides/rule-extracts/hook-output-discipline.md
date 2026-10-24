# Hook Output Discipline — depth extract

Companion to `.claude/rules/hook-output-discipline.md`; the depth below is relocated verbatim.

## MUST-3 — shell-variable examples

```javascript
// DO — skip when captured group references shell variable
const m = command.match(/\bgh\b[^|;]*--repo\s+([^\s]+)/);
if (!m) return null;
const targetRepo = m[1];
// Pre-expansion shell variable cannot be evaluated at hook invocation time.
if (/^\$\{?\w+\}?$/.test(targetRepo) || /\$\(/.test(targetRepo) || /`/.test(targetRepo)) {
  return null;
}
// ... proceed with literal-string comparison

// DO NOT — evaluate the literal "$REPO" string against cwd basename
const cwdBase = path.basename(cwd);
if (!targetRepo.includes(cwdBase)) return { severity: "block", ... };  // false positive
```

## MUST-5 — parsed-signal examples

```javascript
// DO — dispatch on the parsed subcommand POSITION; the verb is where the grammar puts it
for (const g of parseGitInvocations(cmd)) {
  if (
    FENCED.has(g.sub) &&
    !isNonMutating(g.argv, VALUE_FLAGS[g.sub], NON_MUTATING[g.sub])
  )
    return {
      rule_id: "trust-posture/L3",
      severity: "block",
      evidence: `parsed verb: git ${g.sub}`,
    };
}

// DO — a lexical PROPOSITION, exactly determinable: is this literal token present in this file set?
if (publishedFiles.some((f) => read(f).includes(PRIVATE_TOKEN)))
  return {
    rule_id: "artifact-flow/disclosure",
    severity: "block",
    evidence: `token in ${f}`,
  };

// DO NOT — regex over the joined string, then `block`
if (/\bgit\s+commit(?![\w-])/.test(cmd))
  return { severity: "block", evidence: cmd };
// `git -C /other/repo commit` walks straight through; `echo "git commit -m x"` fires it.

// DO NOT — "repair" the regex by scanning the SAME joined string for a non-mutating marker
if (/\bgit\s+commit/.test(cmd) && !/--dry-run|--help|-n/.test(cmd))
  return { severity: "block", evidence: cmd };
// `git commit -m "fix the --dry-run bug"` now passes — the flag-shaped token was a flag's VALUE;
// and `-n` is `--no-verify` on commit (which COMMITS) but `--dry-run` on push, so one shared
// marker list gets exactly one of the two wrong, in the dangerous direction.
```

## MUST-5 — proposition and technique

**The discriminator is the PROPOSITION, not the technique.** String matching is not the defect. A check asserting that a LITERAL token is absent from an enumerated file set is exact and structural however it is spelled. A check inferring intent, adequacy, or completeness from prose is not, however carefully its regex is written. Ask what the check ASSERTS, then ask whether a rewrite preserving the meaning changes the answer.

## MUST-4 — audit-fixture layout example

```text
# DO — fixture set covers the three predicate classes
.claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/
  clean-current-repo.txt              ← "gh issue list --repo current-org/current-repo"; expects null
  flag-explicit-other-repo.txt        ← "gh issue list --repo other-org/other-repo"; expects halt-and-report
  skip-shell-variable.txt             ← "gh issue list --repo \"$REPO\""; expects null (Rule 3)
  skip-command-substitution.txt       ← "gh issue list --repo $(gh repo view -q .nameWithOwner)"; expects null

# DO NOT — only happy-path fixture; shell-variable regression silently re-introduced
.claude/audit-fixtures/violation-patterns/detectRepoScopeDriftBash/
  flag-explicit-other-repo.txt
```
