---
id: "INSTRUMENT-DISCIPLINE"
---

# Instrument Discipline — A Check That Cannot Discriminate Is Not Evidence

Before any check, probe, fixture, or test result is cited as evidence, ONE test governs it:

> **Would this instrument produce a DIFFERENT result if the proposition were false?**

If not, it is not evidence — whatever it printed.

Depth — worked cases, per-clause BLOCKED corpora, subject test — lives in `.claude/guides/rule-extracts/instrument-discipline.md`.

## MUST Rules

### 1. Name The Falsifying Result Before Citing Any Check As Evidence

State what the instrument would have printed had the proposition been FALSE. No nameable falsifying result ⇒ BLOCKED as evidence: re-instrument, or report the question UNANSWERED. Having run, exited 0, or printed a plausible value does not satisfy this.

```bash
# DO — can return the other answer, and that is stated
gh pr checks "$N" --json name,state -q '.[]|select(.state!="SUCCESS")'   # non-empty ⇒ NOT green
# DO NOT — output constant across the hypothesis
git status --porcelain      # empty on "nothing done" AND on "all committed"
```

**BLOCKED rationalizations:** "the command ran clean" / "it exited 0" / "the number looked right" / "that's how we always check it" / "it's a sanity check, not proof".

**Why:** A result consistent with both branches carries zero information: acting on it is acting on a guess wearing the grammar of a measurement.

### 2. A Passing Test Is An Instrument

**(a)** A green test, fixture, suite, or probe reports on the behavior it NAMES and MUST clear MUST-1 first; citing a green without having established the run would RED in that behavior's absence is BLOCKED. **(b)** A mutation that does NOT red the test is read under MUST-5(b), never as a vacuity verdict.

```bash
# DO — establish the red, and prove the mutation executes, before reading either green
git stash && pytest -k revocation   # or cargo nextest run -E 'test(revocation)'
<mutate>; <assert mutated line runs>; <run test>          # then the result is readable
# DO NOT — cite a green alone, or read a non-reddening mutation as a verdict
pytest -q   # "412 pass"; <mutate>; still green → "vacuous"  ← also an INERT mutation
```

**BLOCKED rationalizations:** "the suite is green" / "CI passed" / "the test is named for that behavior" / "it would have failed if it were broken" / "I changed the code and nothing failed" / "the mutation was obviously reachable" / "the test must be vacuous then".

**Why:** A test asserting nothing about its named behavior passes identically whether that behavior is present or absent.

### 3. Show The Instrument Fires HERE, And Read The Hits

Naming the falsifying result (MUST-1) does not show THIS tool can emit it. **(a)** Fire the instrument at a known-answer case first; never-shown-to-fire-here is BLOCKED as evidence, however sound its logic. **(b)** Read the matches, not the tally — including what a count COUNTS.

```bash
# DO — the control fires against a case already known to hold the pattern
git grep -c 'process\.exit(0)' -- path/known-to-have-it.js  # prints 8 ⇒ matcher works HERE
git grep -n 'severity: "block"' -- .claude/rules/           # then READ each hit in context
# DO NOT — cite an empty result from an instrument never shown to fire, or report the tally
grep -rn 'process\.exit([12])' .claude/hooks/  # silently no-matches under this repo's ugrep
node --test tests/integration/*.test.js        # "tests 14" counts FILES; inner harness ran 350
```

**BLOCKED rationalizations:** "it returned empty, so there are none" / "grep is grep" / "that flag is POSIX" / "it works on my other machine" / "the tally is the finding" / "I read a sample and they all looked fine" / "the count went down, so the fix landed" / "`ls` and `head` both agree, so the path is right" / "a control for a one-line check is ceremony".

**Why:** A sound check can be physically unable to emit its falsifying result here, so its silence is indistinguishable from a true negative and survives reasoning-only review; and no control catches an over-match — only reading the hits does.

### 4. An Instrument Is Scoped To The Question It Was BUILT For

Soundness for question A carries NO information about question B. Reading a check built for A to answer a DIFFERENT question B re-triggers MUST-1 for B: name what it would print were B FALSE; unnameable ⇒ B is UNANSWERED. **A field's semantics are fixed by its PRODUCER, not by the reader's question.**

```bash
# DO — the second question gets its OWN falsifying result named against THIS instrument
# a simulator built to PARTITION N PRs into merge-order groups, now asked "will they conflict?"
# ⇒ it never opens a diff, so no output of it could show a conflict: UNANSWERED, re-instrument
git merge-tree "$(git merge-base A B)" A B | grep -c '^<<<<<<<'   # >0 ⇒ they DO conflict
# DO NOT — read the sound-for-A instrument as though it had answered B
# "the simulator returned 4 clean groups, so the PRs don't conflict"  ← it never looked
gh run view "$ID" --json jobs -q '.jobs[].labels'   # records what the job REQUESTED, not the host
```

**BLOCKED rationalizations:** "the script already ran, no need for another" / "it's the same data" / "the field is right there in the output" / "it was correct the last time I used it" / "the tool is well-tested" / "I'm only reading one more field off it" / "the output is plausible for both questions" / "the producer and I mean the same thing by that name" / "it discriminates, I already checked" / "it's one question, not two — the check covers the whole claim" / "I'm verifying the change as a whole, so there is no second question to name".

**Why:** Discrimination belongs to the PROPOSITION, not the tool — so a value plausible for B survives a self-review that only ever asked about A.

### 5. A Behaviour Change Is Not Verified Until A Mutation Of It REDS Something

After ANY behaviour change, MUTATE it and confirm a case REDS before reading any green as covering it — a green over a real behaviour change IS the finding. **(a)** Prove the mutation REACHED the code BEFORE reading its result. **(b)** An EMPTY red-set resolves nothing — vacuous case OR inert mutation, e.g. a defense-in-depth SIBLING absorbing it — so resolve it with a DOUBLE mutation dropping both, never a vacuity verdict.

```bash
# DO — mutate, prove it reached the code, THEN read the red-set
<mutate>; <assert the mutated line runs>; <run suite>    # names reds ⇒ that behaviour is covered
<drop the sibling too>; <run suite>                      # reds ⇒ the sibling was the absorber
# DO NOT — read the green, or call an empty red-set "vacuous"
<change behaviour>; <run suite>   # "99/99 green" ⇒ NOT evidence; that IS the finding
```

**BLOCKED rationalizations:** "the suite is green" / "it's a small change" / "the existing cases cover it" / "I'll add a test if it breaks" / "the change is obviously covered by what's already there" / "the mutation didn't red, so the test is vacuous" / "writing a case for it now is teaching to the test" / "the review round will catch it" / "I read the diff and the cases, they line up".

**Why:** cases test the behaviour that existed when they were written, so NEW behaviour is un-covered by default — the green measures the case set's age, not the change.

### 6. A Cited Measurement Carries Its STATE And A DERIVED Input Set

MUST-5's object is a BEHAVIOUR CHANGE, discharged by RE-DERIVING it; this clause's object is a FIGURE cited outside its producing turn, discharged WITHOUT recomputing it. A turn holding BOTH is bound by BOTH. **(a)** A figure restated later MUST carry its measured state and input set. **(b)** It MUST ship a CHEAP predicate answering "have those inputs moved?" without recomputing it; absent one the verdict is **STALE — a THIRD verdict**, and reporting it CURRENT or FALSE are BOTH BLOCKED. **(c)** Answer PER LEVEL, never once for all: any level not SHOWN fixed in the command MUST be emitted from what it READ; hand-typing one is BLOCKED.

```text
# DO — state + a PER-LEVEL answer + a predicate that recomputes nothing
"115 rows at 6e33d92 over .claude/rules/*.md"; set=$(build --emit-read-set); check --digest
# sources: DECLARED = SHOWN fixed (the command reads ONLY that list, and refuses otherwise)
# members: DISCOVERED = everything else, incl. anything you cannot show fixed ⇒ emitted from what it READ
# STALE ⇒ "UNANSWERED until re-run", never "current" and never "false"
# DO NOT — bare figure, ONE answer for a two-level set, a hand-typed DISCOVERED
#          level, a collapsed third verdict, or citing to dodge MUST-5
"115 rows" · sources: [a.md, b.md] · "STALE, so the claim is FALSE"
"members: DECLARED" — asserted, never SHOWN, of a level the command finds at run time: the typed
              list is a SECOND claim about the world, not the command's input
"I am the citer, so I need not re-derive" — said of a behaviour change in the SAME diff
```

**BLOCKED rationalizations:** "I measured it this session" / "it was right an hour ago" / "nothing has changed since" / "the SHA is in the transcript above" / "if it were stale someone would have noticed" / "stale just means wrong" / "the manifest lists the sources" / "I know what it reads" / "the input set is static" / "the predicate reports CURRENT, so we're fine" / "I am the CITER here, so my remedy must NOT re-derive" / "MUST-5 binds whoever changes behaviour, and that is not the hat I am wearing" / "the sources are declared, so the members are declared too" / "the input set is one list, so one answer covers it" / "the reference implementation declares its sources, so (c) is satisfied".

**Why:** Recency is not freshness, so an unchecked figure is re-cited on trust until a decision rests on it; and an under-declared input set reports CURRENT while the claim is false, so the check vouches for the stale figure.

## MUST NOT

- Report a question ANSWERED, or treat a lexical match (grep, keyword scan, string presence) as a verdict on a semantic property, when no result the instrument could have produced would have falsified the proposition

**Why:** A token's presence is consistent with assertion, negation and quotation alike; a confident wrong answer ends the search for the right instrument.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/instrument-discipline.md`, which every validator reads as part of this rule.
