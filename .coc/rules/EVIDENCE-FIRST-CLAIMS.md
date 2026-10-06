---
id: "EVIDENCE-FIRST-CLAIMS"
---

# Evidence-First Claims — No Assertion Without Quoted Evidence

See `.claude/guides/rule-extracts/evidence-first-claims.md` for full DO/DO-NOT blocks, BLOCKED-rationalization corpora, the `cat -v` decode walkthrough, the structural-finding carve-out, and the complete E1/E2/E3 origin narrative.

Diagnostic, root-cause, anomaly, and security claims MUST be grounded in evidence quoted **inline, in the same message as the claim**. Inference is permitted — but labeled as inference, never asserted as fact. The security/anomaly subclass carries the strictest bar: quote the triggering bytes, decoded.

## MUST Rules

### 1. Diagnostic And Root-Cause Claims Cite The Evidence Inline

Any statement of WHY something failed MUST quote the supporting log line, command output, exit code, or file content in the same message. "X failed because Y" without the evidence for Y is BLOCKED; reading the log precedes naming the cause.

**Why:** A symptom is consistent with many causes; naming one before reading the evidence builds the next action on a confident-but-wrong diagnosis. See guide.

### 2. Security / Anomaly Claims Quote The Triggering Bytes, Decoded

Any claim of compromise, injection, tampering, or "suspicious" data MUST quote the exact triggering bytes inline AND decode the WHOLE suspect span (`hexdump -C` / `od -c`) BEFORE characterizing it. A `cat -v` rendering is display encoding, NOT content. Byte-less structural findings substitute inline repro steps + observed output; fabricating a byte-quote OR suppressing a byte-less real finding are BOTH BLOCKED.

**Why:** A false security claim is worse than silence — it triggers escalation and consumes trust real findings need; one hexdump settles whether `e2 80 94` is an em-dash or a payload. See guide.

### 3. An Errored Or Empty Command Is Zero Evidence, Never Confirmation

A command that exited non-zero, hit an invalid flag, timed out, or returned empty provides no findings — it does NOT "confirm" any hypothesis. An errored SECURITY detector is NOT an all-clear: re-run it correctly OR surface "detection did not run; threat status UNKNOWN".

**Why:** An errored command and a clean-but-empty result are indistinguishable in raw output yet opposite in meaning. See guide.

### 4. Inference Is Labeled As Inference; Only Quoted Observation Is Stated As Fact

"I see [quoted X]" is a fact; "this suggests [Y]" is an inference and MUST carry a hypothesis marker. Presenting an inference in the grammar of an observation is BLOCKED.

**Why:** The reader cannot act correctly if they cannot tell known from guessed; fact-grammar is the form every confabulation takes. See guide.

### 5. A Verification Instrument Is Shown Capable Of The OPPOSITE Verdict Before Its Result Is Banked

MUST-3 governs a command that FAILED; this governs one that SUCCEEDED and answered a DIFFERENT question. Before banking a verification result the instrument MUST be shown able to return the opposite verdict. Two BLOCKED shapes: a **self-derived oracle**, whose expected value is computed FROM the subject so both agree by construction; and a **wrong-question instrument** — e.g. a TWO-DOT `git diff base..HEAD` on a branch BEHIND base, which renders base's newer commits as REVERSIONS (use `base...HEAD`).

**BLOCKED rationalizations:** "the command exited 0" / "it returned a real number" / "the assertion passed" / "I read the output myself" / "it's the same check CI runs" / "the diff is the diff, both forms show the changes".

**Why:** A confident wrong answer from a WORKING command is invisible at read time — the transcript shows a clean exit and a plausible result. See guide.

### 6. An Instrument's SCOPE Is Established Before Its Green Is Generalized

MUST-5 asks whether an instrument can fail AT ALL; this asks whether it can fail FOR THIS CLASS. One that PASSES its negative control can still be BLIND to a class its execution model, compiled feature set, mutation point, dependency context, or engine dialect excludes. State the scope a green covers and what it EXCLUDES; generalizing past it is BLOCKED. Five shapes: guide.

**BLOCKED rationalizations:** "the suite is green" / "the negative control passed, so the instrument is sound" / "both runners run the same tests" / "the feature flag only adds tests, it cannot remove coverage" / "more kills is stronger evidence" / "it passes in the suite, standalone is the same thing" / "the in-memory engine is the same SQL".

**Why:** A negative control proves the instrument can MOVE, not that it can SEE the class under review — so a blind green is indistinguishable from a covering one, and more dangerous, since the control makes it look verified.

## MUST NOT

- State a security / compromise / injection / tampering claim without quoting the triggering bytes inline — **Why:** unfalsifiable from the reader's side; triggers costly escalation on a possibly-invented threat.
- Characterize `cat -v` / escaped-byte renderings as content without decoding to the real codepoint first — **Why:** the rendering is not the byte.
- Treat an errored, timed-out, or empty command result as confirmation of any hypothesis — **Why:** absence-of-result is not evidence.
- Assert a root-cause claim before reading the log / output / file that would show the cause — **Why:** the log disambiguates; asserting first builds the next action on a guess.
- Bank a verification result from an instrument never shown able to return the opposite verdict, or generalize a green past the class its instrument could observe — **Why:** a check that cannot fail, or cannot fail for this class, reports `pass` for every input including the ones it exists to catch.

Depth — extended rationale for the MUST NOT bullets above, plus the MUST-5 and MUST-6 BLOCKED-rationalization corpora, which stay inline in this rule — lives in `.claude/guides/rule-extracts/evidence-first-claims.md`.

Depth — the Trust-Posture Wiring, the rule-graph cross-references and the Origin record — lives in `.claude/skills/32-trust-posture/wiring/evidence-first-claims.md`, which every validator reads as part of this rule.
