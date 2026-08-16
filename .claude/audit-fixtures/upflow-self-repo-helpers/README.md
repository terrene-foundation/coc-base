# upflow-self-repo-helpers

Instruments for MODULE-LEVEL guards, three of which the subprocess fence suite
(`../upflow-open-never-complete/`) structurally cannot reach:
`sanitizeForReason`, `getProvider`, and the `_lastGitStderr` reset.

**`displayPrId` is NOT in that set, and an earlier revision of this sentence
wrongly said the whole file was.** The fence suite DOES reach it — its
`gh/control-byte-pr-id-neutralized-in-refusal` case supplies a control-byte
`prId` directly on `prRef`, and the same `displayPrId → String(value)` mutation
reds in BOTH suites (measured: `1/45 FAILED` there, `1/8 FAILED` here). The
overlap is deliberate — the fence suite proves the sanitizer holds on the path an
adapter actually builds, this suite proves it against payload classes no adapter
happens to produce — but "structurally cannot reach" was false for that row, and
two READMEs landing in the same commit contradicted each other about it.

Run: `node .claude/audit-fixtures/upflow-self-repo-helpers/run.mjs`
(exit 0 = pass). No CI runner invokes it — like its siblings, this tier is
**committed-fixtures-manually-driven**, not a live gate. Stated plainly rather
than described as blocking.

## Why a second suite

The fence suite drives the ADAPTERS through a real git repo in a child process.
That is right for the fence and wrong for these:

| Guard                  | Why the fence suite cannot instrument it                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayPrId`          | **NOT unreachable — deliberate overlap.** The fence suite reaches it and reds on the same mutation; this suite adds payload classes no adapter produces |
| `sanitizeForReason`    | same, plus it must PRESERVE readable non-ASCII, which no adapter case exercises                                                                         |
| `_lastGitStderr` reset | needs two derivations in ONE process; the fence suite spawns one call per case                                                                          |
| `getProvider`          | lives in `vcs-provider.js`, which the fence suite never loads — and which had NO fixture anywhere under `audit-fixtures/`                               |

Every one of these shipped **without** an instrument and was caught by an
adversarial round measuring that its removal left the fence suite fully green.

## Mutation results — measured in `cp -R` sandboxes

| Mutation                                                                         | Cases redded                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `displayPrId` → `String(value)` (drop the `[^0-9]` allowlist)                    | 1 — `displayPrId/strips-every-injection-class`                                             |
| `displayPrId` → drop the `try/catch` around `String(value)`                      | 1 — `displayPrId/does-not-throw-on-hostile-toString`                                       |
| `sanitizeForReason` → return input unchanged                                     | 1 — `sanitizeForReason/strips-structure-forging-classes`                                   |
| `sanitizeForReason` → ASCII-only class (over-tighten)                            | 1 — `sanitizeForReason/preserves-readable-non-ascii`                                       |
| `getProvider` → `PROVIDERS[id]` (plain index)                                    | 1 — `getProvider/inherited-keys-are-not-providers`                                         |
| `sanitizeForReason` → narrow the class back (drop U+061C / U+200B-200F / U+FEFF) | 1 — `sanitizeForReason/strips-structure-forging-classes`                                   |
| `getProvider` → interpolate `id` raw into the refusal reason                     | 1 — `getProvider/refusal-reason-is-sanitized-and-bounded`                                  |
| `displayPrId` → a class that also eats digits (over-tighten)                     | 1 — `displayPrId/preserves-a-legitimate-id`                                                |
| `getProvider` → over-tighten the membership test                                 | 1 — `getProvider/real-providers-still-resolve`                                             |
| `_readOriginRemote` → delete `_lastGitStderr = null;`                            | 1 — `deriveSelfRepoRef/git-stderr-does-not-leak-across-calls`                              |
| parse-failure `where` → bare `sanitizeForReason(split.host)` (the pre-fix state) | 1 — `deriveSelfRepoRef/parse-failure-host-reason-is-bounded` (measured: 50139-char reason) |
| `REASON_OPERAND_MAX` 256 → 4 (over-tighten)                                      | 1 — `deriveSelfRepoRef/parse-failure-host-reason-stays-diagnostic`                         |

The last two are a BIPOLAR pair over one bound and each reds ALONE: removing the
bound reds only the size case, over-tightening it reds only the diagnostic case.
That is what distinguishes a correct bound from both an absent one and a
truncate-to-nothing one — a single-polarity pair could not.

**`displayPrId`'s new `slice(0, 256)` pre-bound has NO reddening mutation, and is
recorded as such rather than claimed instrumented.** It is a pure allocation
bound: the output is already capped at 32 code points, so for every input the
post-slice result is byte-identical to the pre-slice one. There is no observable
behavior to assert on, which is why no case was written for it — not because one
was skipped. Per `instrument-discipline.md` MUST-2(b) this is stated as an
un-instrumented change, not folded into the measured rows above.

Each suite is **bipolar**: alongside every strip/refuse case there is a
preserve/allow case, because a refusal-only suite cannot detect over-tightening.
`sanitizeForReason` mangling a legitimate non-ASCII path, or `getProvider`
refusing `"github"`, would each be a real regression that a one-sided suite
would pass.

## The "no reddening mutation" verdict recorded here was WRONG

Recorded rather than quietly corrected, because an unfalsified claim about an
instrument is exactly what this suite exists to catch — and this file made one.

An earlier revision tabled the `_lastGitStderr` reset as **0 — no reddening
mutation**, resolved "INERT, not vacuous", on this reasoning:

> the only null-return paths that assign nothing are `!gitBin` and an
> empty-stdout success, and neither is reachable from an in-process fixture
> without stubbing the module under test.

**The `!gitBin` half is sound. The empty-stdout half is false.** An adversarial
round produced the reachable input, from an ordinary git repo, no stubbing:

```
$ git config remote.origin.url " "
$ git remote get-url origin | od -c
0000000       \n          exit=0
```

`_readOriginRemote` then does `s.trim()` -> `""` -> `return s || null` through the
**success** branch, which never touches `_lastGitStderr`. The old case used a
NONEXISTENT DIRECTORY for its second call — that path THROWS, so it goes through
the `catch`, and the catch always assigns. The case was driving the one shape
that could not discriminate, and "inert" was a reachability argument that was
stated but never tested.

Corrected: the second call now drives the whitespace-url path, and deleting the
reset REDS. Two consequences beyond the table row — the reset is **not**
defensive code for a latent path, it prevents a LIVE cross-call stderr leak on a
driveable input; and the `instrument-discipline.md` MUST-2(b) resolution was
unearned. Collapsing two hypotheses toward "inert" requires the reachability
argument to be _tested_, not merely asserted.

## Source-literal discipline

Payload characters are built with `String.fromCharCode`, never written as source
literals. A bidi override or raw control byte written literally into this file
would be invisible to a reviewer — precisely the property these guards exist to
remove from output.
