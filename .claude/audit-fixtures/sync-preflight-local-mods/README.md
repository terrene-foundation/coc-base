# `sync-preflight-local-mods` fixtures

Structural fixtures for `.claude/bin/sync-preflight-local-mods.mjs`, per `cc-artifacts.md` Rule 9.

**Run:** `node .claude/audit-fixtures/sync-preflight-local-mods/run.mjs` — exits 0 on all-pass,
1 on any mismatch.

## Layout

Inline cases in `run.mjs`, not per-case sidecars. Sanctioned by `cc-artifacts.md` Rule 9
("MAY use per-fixture sidecar files OR inline-case definition in `run.mjs`"); chosen here because
every case needs a CONSTRUCTED git repo with a specific commit history, which a static sidecar
cannot carry.

## What the cases bind

| Class                    | Cases      | Property                                                                              |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| **DID-NOT-RUN → exit 1** | 01–05, 05b | Every way the run can fail to happen exits **1, never 0**                             |
| ran-clean vs at-risk     | 06–08      | 0 when all shared artifacts are sync-authored; 2 on a consumer commit or a dirty file |
| scope                    | 09–10      | Preserved `project/` subdirs excluded; the unscanned-`bin/` residual asserted         |
| override + report shape  | 11–13      | `--sync-subject-re` reclassifies; JSON carries `at_risk` + 6 `scanned_dirs`           |

**The 01–05b class is the load-bearing one.** A tool that returns 0 when it could not run is
indistinguishable, at the call site, from one that ran clean — a non-discriminating instrument in
the sense of `instrument-discipline.md` MUST-1. Case **13** is the same property from the other
side: a clean run and a did-not-run both print "no findings", so the `Scanned: N files` line is
what tells them apart, and 13 asserts it is present on the 0 path.

Case **10** deliberately asserts a GAP rather than a capability: `.claude/bin/` is outside the six
scanned dirs, so a consumer edit there is replaced with no warning. If the scanned set ever widens,
case 10 reddens — which is the point. Widening the set means updating case 10, the tool's header
residual, and the residual paragraph in BOTH `commands/sync-from-template.md` and
`variants/rs/commands/sync-from-template.md`, in the same change.

## Established RED (2026-08-10)

Green tests are only readable against a demonstrated red (`instrument-discipline.md` MUST-2). The
tool is net-new, so there is no pre-fix baseline; the red was established by MUTATION instead, and
the mutation was shown to REACH the code before its result was read (MUST-2(b)):

1. `main()`'s catch arm changed from `process.exit(1)` to a sentinel write + `process.exit(0)`.
2. Direct invocation printed `MUTATION-REACHED-THIS-LINE` on stderr — the mutation EXECUTES; the
   result is therefore readable rather than a second non-discriminating instrument.
3. Suite went **14/14 → 8/14**, reddening exactly cases 01, 02, 03, 04, 05, 05b — the DID-NOT-RUN
   class and nothing else.
4. Mutation reverted; suite back to **14/14**, runner exit 0 (read unpiped — a `| tail` masks the
   runner's own status with `tail`'s).
