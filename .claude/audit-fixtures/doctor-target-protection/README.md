# doctor-target-protection — F76

Fixture lock for the `loom doctor --targets` check in `.claude/bin/loom-doctor.mjs`.

## What it guards

F76 asserts: *the 9 Gate-2 target repos have no required status check, so merges there
are unverified by construction.* That is a claim about other repos' branch protection,
and it is only worth what the instrument measuring it is worth.

`loom doctor --targets` enumerates the Gate-2 targets from the ecosystem config's
`remote_links` (`build.*` + `use-template.*`; `loom` / `atelier` / `command` are not
distribution destinations), resolves each repo's **default branch**, and reports two
dimensions per target:

- does the default branch carry **≥1 REQUIRED status check**, and
- is **`enforce_admins`** on.

It is **read-only and report-only**. loom does not own a target's branch protection and
MUST NOT edit it (`repo-scope-discipline.md`); the target's owner remediates.

## What it prints — both poles, named

| target state | row |
|---|---|
| ≥1 required context **and** `enforce_admins` on | `✓ [OK] gate2-target:<key>: <org>/<repo>@<branch> — N required check(s): …; enforce_admins=on` |
| ≥1 required context, `enforce_admins` **off** | `! [WARN] … — N required check(s): …; enforce_admins=OFF (an admin merge bypasses every required check above)` |
| no required check | `✗ [CRIT] … — NO required status check (<reason>); enforce_admins=<v>. A PR into this target can never reach "CI green" …` |
| probe did not answer | `✗ [CRIT] … — protection UNKNOWN (<reason>): <detail>` |

Four unprotected reasons are kept apart, because each has a different remedy at the
target: `no-branch-protection`, `required-status-checks-absent`,
`required-status-checks-null`, `required-status-checks-empty`.

## Fail-closed

An API error, a bare 404, a permission denial, an unparseable body, a missing `gh`, a
failed default-branch lookup, or an unloadable classifier all report **UNKNOWN at `crit`**
— the same severity as unprotected, never `ok`, never `warn`. An errored detector is not
an all-clear (`evidence-first-claims.md` MUST-3).

A **bare** HTTP 404 is deliberately treated as UNKNOWN, not as "unprotected": GitHub
returns 404 both when a branch genuinely has no protection (body `Branch not protected`)
and when the repo/branch is absent or invisible to the token. Only the explicit
`Branch not protected` body is read as determinate. This is stricter on that one axis
than the Gate-2 driver's own probe, whose verdict semantics gate an exit-6 merge refusal
and are left untouched.

## Why key-presence, not optional chaining

GitHub **omits** `required_status_checks` entirely for one repo state and returns it
`null` for another, and separately returns it present with zero contexts.
`p.required_status_checks?.contexts?.length` collapses all three to one falsy value, so
such an implementation prints the same thing whether F76 is true or false — a
non-discriminating instrument, worthless for this question
(`instrument-discipline.md` MUST-1). `Object.prototype.hasOwnProperty` keeps the states
apart and gives each its own reason. The same discipline applies to `enforce_admins`: an
**absent** key classifies `unknown`, never `off`, because absence is not observation.

## SSOT

The required-status-check classifier is **not** re-implemented here. It is the same
exported `classifyTargetVerifiability` the Gate-2 driver refuses on, pinned by
`audit-fixtures/gate2-target-verifiability/`. Two independent copies of a fail-closed
classifier is the drift class `security.md` § Enforcement-Surface Parity exists to
prevent. Only the `enforce_admins` dimension — which the driver does not classify — is
new here. Mutation **M7** below is what makes that reuse checkable rather than asserted.

## Opt-in

`--targets` is off by default. Every other doctor check is local, and a default-surfaced
command must not fan out N cross-repo API calls on an unattended invocation. A default
run at a clone that HAS targets still prints a visible `NOT PROBED` row, because an unrun
check rendered as silence is indistinguishable from a clean one.

## Measured mutations (2026-08-17, `LOOM_DOCTOR=<mutant>`)

Unmutated control: **46/46 PASS, exit 0**.

| # | Mutation | Result |
|---|----------|--------|
| M1 | `classifyEnforceAdmins` returns `{verdict:"on"}` unconditionally | exit 1, 37/41 — reds both admin poles + the no-protection row + the discrimination case |
| M2 | `hasOwnKey(p,"enforce_admins")` → `!p?.enforce_admins` | exit 1, 40/41 — reds `discrimination/absent-vs-null-enforce-admins` ONLY |
| M3 | the fail-closed unknown-precedence branch in `buildTargetCheck` → `if (false)` | exit 1, 36/41 — reds all five `failclosed/*` verdict cases |
| M4 | a bare HTTP 404 mapped to `not-found` (reads a permission denial as "unprotected") | exit 1, 40/41 — reds `failclosed/bare-404-is-unknown-not-unprotected` ONLY |
| M5 | `notProbedRow` returns `null` always (unrun check rendered as silence) | exit 1, 40/41 — reds `wiring/not-probed-row-is-emitted-rather-than-omitted` ONLY |
| M6 | `parseFlags` defaults `targets: true` (probe no longer opt-in) | exit 1, 40/41 — reds `wiring/probe-is-opt-in-and-off-by-default` ONLY |
| M7 | the SSOT classifier replaced by a local `?.`-chained re-derivation | exit 1, 38/41 — reds the three `required_status_checks` ABSENT/NULL/EMPTY discrimination cases |
| M8 | `firstLine` returns the raw line (control-byte escape removed) | exit 1, 40/41 — reds `failclosed/control-bytes-in-remote-text-are-escaped` ONLY |
| M9 | the `--fix` branch drops `targetRows` (`--fix --targets` silently ignored) | exit 1, 40/41 — reds `wiring/fix-mode-still-reports-target-rows` ONLY |
| M10 | `resolveTargetRepoArg` accepts any non-empty slug (fence removed entirely) | exit 1, 34/41 — reds all seven `targetrepo/*` cases |
| M11 | the refusal no longer short-circuits — an un-allowlisted slug is probed anyway | exit 1, 40/41 — reds `targetrepo/refusal-costs-ZERO-gh-api-calls` ONLY |
| M12 | the allowlist widened to EVERY `remote_links` entry, not the enumerated targets | exit 1, 40/41 — reds `targetrepo/allowlist-EXCLUDES-non-enumerated-remote-links` ONLY |
| M13 | `--target-repo` no longer implies `--targets` | exit 1, 40/41 — reds `wiring/target-repo-implies-targets` ONLY |
| M14 | `validateBaseRef` returns `{ok:true}` always (the base fence removed — the PRE-FIX state) | exit 1, 42/46 — reds the four adversarial `base/*` poles; the COMPLIANT pole stays green |
| M15 | over-fix: `validateBaseRef` bans every `/` | exit 1, 45/46 — reds `base/a-LEGITIMATE-slashed-branch-is-accepted` ONLY |
| M16 | the SINK check removed, flag-boundary check kept | exit 1, 45/46 — reds `base/the-SINK-validates-too-not-only-the-flag-boundary` ONLY |

M2, M4–M6, M8, M9 and M11–M13 each red exactly ONE case, which is what makes those cases
readable as evidence about their own proposition rather than as generic smoke. M7 is the
case that would otherwise be missing: without it, a reviewer could not tell whether the
`required_status_checks` discrimination cases pin real behaviour or merely inherit a
sibling fixture's green. M10 and M3 red broadly because each removes a whole contract
rather than one branch of it.

## `--target-repo` is an ALLOWLIST, and that is load-bearing

The flag exists so the live known-answer control (fire the instrument at a repo whose
protection state is independently known) is ONE command rather than a hand-written script
calling exported functions. An owed measurement that is awkward to take is one that never
gets taken.

That convenience must not become an arbitrary cross-repo READ affordance sitting outside
the `/cross-repo-authorize` ceremony — an escape hatch that also escapes its own
authorization is a worse defect than the gap it closes (`repo-scope-discipline.md`). So:

- Accepted: the Gate-2 targets `--targets` **already** probes (by resolver key or by
  `owner/repo` slug), plus **this repo's own `origin`**, which is not a cross-repo read.
- Refused: everything else, at `crit`, **before any API call is issued** — measured at 0
  `gh api` invocations against a call-recording stub, with the compliant pole (an
  allowlisted target still issuing exactly 1 probe) measured on the same tree.
- Deliberately refused too: `loom` / `atelier` / `command`. They are declared in
  `remote_links` but are NOT Gate-2 targets, so admitting them would reach repos
  `--targets` does not. The flag NARROWS the enumeration and cannot widen it.

Net reach added by the flag: **none**. It selects from the set `--targets` already
carries. M11 and M12 are what keep that claim checkable rather than asserted.

**Known limit, stated rather than implied:** `--targets` itself performs its cross-repo
reads without verifying a `/cross-repo-authorize` receipt — the operator is expected to
hold one, and the command doc says so. That is a property of the check as a whole, not of
this flag, and closing it means teaching the check to read `.claude/cross-repo-authz/`.
Out of scope here; recorded so nobody reads the fence above as covering it.

## The BASE ref is fenced too (B-1)

The repo half of `repos/<slug>/branches/<base>/protection` was allowlisted with care and
the BASE half was left free-form — un-allowlisted reach on exactly the axis the repo fence
denies. Found by adversarial review, measured on the unfenced build:

```
--target-base "main/protection/../../../../evil/repo/branches/main"
→ gh api repos/example/target-py/branches/main/protection/../../../../evil/repo/branches/main/protection
→ row rendered [OK]
```

`validateBaseRef` is git's own `check-ref-format` grammar plus two deliberate additions,
`%` and `#`. Both are legal in a git ref and illegal here, because the string does not
stay a ref — it becomes part of a URL: `%2e%2e` is a `..` the SERVER decodes after any
literal check, and `#` truncates the request client-side. `#` is in the set because the
fixture caught it; the first fence passed every other hostile form and let `main#frag`
through.

Enforced at TWO surfaces through ONE helper (`security.md` § Enforcement-Surface Parity):
the flag boundary in `runTargetChecks`, for a clean operator message with zero API calls,
and the SINK in `probeTargetProtectionStrict`, which no caller can bypass — including the
API-derived default branch name and any future caller. M16 is what keeps the second one
honest.

**It is NOT a slash ban.** Branch names legitimately contain `/`, so
`base/a-LEGITIMATE-slashed-branch-is-accepted` exists as the compliant pole and M15 (ban
every `/`) reds it alone. A fence that refused `release/v1.2.3` would be the wrong fix.

**Wire behaviour is deliberately NOT relied upon and NOT claimed.** Whether a given `gh`
build collapses `..` client-side, sends it literally, or GitHub 404s it is unresolved —
settling it needs a live request to a non-CWD repo this lane holds no receipt for, and
during the REST outage a 404 there would be the outage rather than a negative result.
Rejecting a traversal segment in a path component you interpolate is correct regardless
of the client, so the poles assert the REFUSAL, never what the wire does.

## Why the bare-404 strictness is not hypothetical (measured 2026-08-17)

The `failclosed/bare-404-is-unknown-not-unprotected` case exists because GitHub REST
returns `Not Found` both for a resource that is absent and for one the caller cannot
see. On 2026-08-17 a third cause was MEASURED on loom's own repo — REST returning
`Not Found` for resources that demonstrably EXIST:

| probe (own repo, no cross-repo read) | result |
| --- | --- |
| `repos/example-org/loom` | ok — `default_branch: main`, `permissions.admin: true` |
| GraphQL `branchProtectionRules` | `pattern: main`, `requiredStatusCheckContexts: ["Required checks"]`, `isAdminEnforced: true` |
| `repos/…/rulesets` | `[]` — protection is CLASSIC, not a ruleset |
| `repos/…/branches/main/protection` | **HTTP 503**, persistent across 15+ attempts over ~4 min |
| `repos/…/branches/main` | **HTTP 404 `Not Found`** — for a branch `git ls-remote` resolves |
| `repos/…/commits` | **HTTP 404 `Not Found`** — for a repo with 4946 reachable commits |

The last two rows are the load-bearing ones: the known answer is held locally in git, so
`Not Found` there is provably FALSE. Under this degradation the Gate-2 driver's probe —
whose regex accepts a bare `Not Found` as `not-found` — classifies `unverifiable` /
`no-branch-protection`, i.e. it reports a protected branch as unprotected. This probe
returns `unknown` for the same input. That difference is the whole point of the case, and
it is now evidenced rather than merely designed for.

Independently corroborated in the same session by a different lane, on different
endpoints: `gh api .../check-runs` returned 404 for SHAs that demonstrably have runs.

## A GraphQL cross-check does NOT close the ruleset class

When the REST endpoint is untrustworthy the natural fallback is GraphQL. It closes the
OUTAGE class and **not** the ruleset class, and the difference is easy to miss because
both read like "the protection on this branch".

Measured on loom in ONE query, so the two fields are shown to be independent surfaces
rather than assumed to be:

```
branchProtectionRules -> [{pattern:"main", requiredStatusCheckContexts:["Required checks"], isAdminEnforced:true}]
rulesets              -> []
```

A repo protected ONLY by a repository ruleset inverts that — empty `branchProtectionRules`,
non-empty `rulesets` — so a cross-check reading `branchProtectionRules` alone reports it
unprotected, the same false negative the classic REST endpoint gives. A cross-check must
query BOTH fields, or it has swapped one blind instrument for another
(`instrument-discipline.md` MUST-4: soundness for one question carries no information
about a different one).

## OPEN: this fixture's distribution fate is inherited, not declared

`audit-fixtures/**` is a SYNCED tier, so this directory ships to USE templates — where
`sync-gate2-worktree.mjs` is fenced `loom_only` and several cases here would red if run.
It is inert there only because consumers receive no runner registry, which is a property
of today's wiring, not a fence.

Deliberately NOT resolved in this shard, and NOT unique to this fixture: the sibling
`audit-fixtures/gate2-target-verifiability/` imports the same loom-only module and ships
on the same glob. Fencing one and not the other would create an asymmetry the next reader
cannot explain from the artifacts, and a `loom_only` entry pulls in `validate-emit`
check-8 carve-outs beyond this shard's budget.

The open question is therefore about the PRECEDENT, scoped to both fixtures: under
`knowledge-cascade-routing.md` MUST-2 a distribution fate is supposed to be DECLARED, and
"matches a synced glob" is inheritance, not a declaration. Recorded here so the next
reader knows it was seen and left, rather than never noticed.

## The live CLI path, measured without a network call

The 31 cases above drive the injected seams. The CLI path (`defaultExec` → `spawnSync`
→ the probes) is a DIFFERENT question and was exercised separately against a local `gh`
STUB placed on `PATH` — no repo was contacted. It produced all four row types across the
real 9-target enumeration (1 `OK`, 1 `WARN`, 1 `CRIT` UNKNOWN from a stubbed 403, 6
`CRIT` unprotected), and `--targets --strict` exited 1. Re-run that way before trusting a
live run; a live run is a cross-repo READ and needs a `/cross-repo-authorize` receipt.

## Running

```bash
node .claude/audit-fixtures/doctor-target-protection/run.mjs   # 46/46, exit 0
node .claude/bin/run-audit-fixtures.mjs --only doctor-target-protection
```

No network. Every probe seam is injected, so each `gh` outcome (protected, 404
`Branch not protected`, bare 404, 403, HTTP 500, unparseable body, `gh` absent) is
exercised without a live repo and without any cross-repo call.
