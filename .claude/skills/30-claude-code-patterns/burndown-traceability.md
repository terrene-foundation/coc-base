# Burndown Traceability — depth

Depth for `rules/burndown-traceability.md`. The rule carries the normative clauses; everything that would not change a decision at read time lives here.

---

## 1. The anchor grammar, exactly

A `value_anchor` cell resolves iff ALL of these hold. Each is checked by `burndown-build.mjs::resolveAnchor`. Most carry a bipolar fixture pole in `.claude/audit-fixtures/burndown-integrity/run.mjs`; conditions 3 (repo-relative) and 6 (unreadable) do NOT, and neither does the `DEFAULT_ANCHOR_ROOTS` fallback — stated rather than implied, because “each has a pole” was the claim and it was false.

| # | Condition | Refusal when it fails |
| - | --------- | --------------------- |
| 1 | not a NON_ANCHOR (`""`, `-`, `—`, `–`, `n/a`, `na`, `tbd`, `todo`, `?`, `none`, `pending`) | `decoration, not a pointer` |
| 2 | the path segment contains no whitespace | `free prose, not a resolvable pointer` |
| 3 | repo-relative — no leading `/`, no `..` segment | `not a repo-relative path` |
| 4 | starts with a declared `anchor_roots` prefix | `outside every declared durable root` |
| 5 | `git ls-files -- <p>` returns exactly `<p>` | `not a tracked file` |
| 6 | readable | `could not be read: <code>` |
| 7 | if `#fragment`, the file contains that string | `does not contain that string` |
| 8 | the file contains the item id VERBATIM | `does not carry the id … LINK-3` |

**Typography is stripped before any of this runs.** `` `path` ``, `**path**`, `[text](href)` and a bare path are the same pointer. A checker that rejected the rendered form would train people to write bare paths into a markdown table, which is the opposite of what the ledger wants — the same reasoning `burndown-integrity.md`'s quote verifier gives for accepting a bolded quote.

Four further conditions are NOT in the table because they are not properties of the cell — they gate the id, the ledger table, and the roots. Each closes a bypass that was MEASURED reporting `chain INTACT`:

| Condition | Refusal | The bypass it closes |
| --------- | ------- | -------------------- |
| the item id is ≥ 8 characters | `the id is N character(s); the floor is 8` | LINK-3 is a substring test, so an id of `e` matched essentially every file |
| exactly ONE ledger table, outside any fenced code block | `candidate ledger tables` / `no parseable ledger table … outside a fenced code block` | a ```-fenced decoy renders as a documentation example and became THE ledger |
| every row's cell count equals the header's, `\|` escaped | `has N cells but the header declares M` | GFM ignores excess cells when rendering, so an escaped-pipe shift was invisible |
| no `anchor_root` admits the burndown's own inputs, `.session-notes*`, or the repo root | `admits the burndown's own input` / `is MEMORY` | `["burndown/"]` let every row anchor at the register, which contains every id by construction |

**Condition 5 is stronger than "tracked".** The anchor's bytes are read from the COMMITTED object (`git show HEAD:<p>`), never the working tree. That one choice closes four holes at once: a chain verifiable against uncommitted bytes; a worktree symlink swap defeating an INDEX-derived mode check; the check-to-use TOCTOU that `security.md` § Path Containment says a realpath re-check does NOT close; and a FIFO hanging the read. A worktree copy that differs from HEAD is refused separately, because the committed bytes are what was VERIFIED while the worktree bytes are what a human will OPEN.

**Condition 5 is the one people argue with.** "The file exists, I can see it" is true and irrelevant: an untracked file reaches no other operator, survives no clone, and vanishes from the next checkout with no diff anyone could have objected to. The declared burndown sources are held to exactly this standard; an anchor held to a lower one would be a link only for whoever wrote it.

---

## 2. Why `.session-notes.d/` is refused BY NAME

This is the originating failure, and it is worth stating as mechanism rather than as a rule.

A `.session-notes.d/<operator>.md` fragment is a MEMORY surface. `/reconcile-notes` exists to prune it — "prune landed rows against cited durable receipts" is its stated job. Pruning it is not a mistake; it is the surface working correctly.

So the sequence that produced this rule was:

1. Session 42 bootstraps `burndown/register.json` from the forest-ledger rows in `.session-notes.d/<operator>.md` (`904b3053`). The register records ids and statuses. It does not copy the rulings, because at that moment the rulings are right there in the fragment.
2. A later session reconciles the fragment (`f07281c6`, "reconcile the fragment for s46 and bound it under the ceiling"). The rows go.
3. The register still reports `In progress` for `F87-upflow-loop`. Nothing anywhere says why.

No one did anything wrong at any step. The defect is that the register's only link to its context was a surface with a documented expiry, and nothing in the system knew that.

**Recovery is possible and worth doing before declaring context lost:**

```bash
git log --oneline -S '<id-or-ordinal>' --all       # find the commit that had it
git show <sha>^:.session-notes.d/<operator>.md     # read the pre-prune content
```

Eleven of this register's twenty-six rulings were recovered exactly this way. Two (`F89`, `F90`) recovered nothing, and (loom-internal reference) says so in those sections rather than filling the gap with a plausible sentence. A fabricated ruling is worse than an absent one: it is unfalsifiable from the reader's side and it ends the search that would have found the real one.

---

## 3. The id-collision evidence behind MUST-3

`burndown/register.json::_id_convention` reads:

> `F-NN` — the forest-ledger id already in use in the session notes, kept verbatim so a row stays greppable across both surfaces.

Following that literally means anchoring on bare `F87`. Measured on `6ddf06b1`:

| bare id | `journal/0174` (2026-05-29) | register (2026-08-19) |
| ------- | --------------------------- | --------------------- |
| `F87` | extract MUST-7 sub-clauses to a depth-file | upflow loop still open |
| `F89` | loom verifier bugs + VERSION bump | sync completeness over budget |
| `F90` | live `refs/coc/coordination` transport | wrapup reminder non-discriminating |
| `F91` | `strip-build-internal` malformed-link defect | remove nested worktrees |

Four collisions in one register. Every one of them would have produced a link that RESOLVED — the file exists, is tracked, is under a durable root, and contains the string `F87`. LINK-1, LINK-2 and every mechanical check would have gone green while pointing at another session's decision.

**This is the reason MUST-3's collision class — and MUST-4's judgment half — stay at gate-review and cannot move to the hook.** A chain that resolves is not yet a chain that is right, and no structural check distinguishes them. The rule is explicit that the semantic arm is capped at `advisory` for exactly this reason: shipping `block` on "is this the right ruling?" would be `block` on a judgment, which `hook-output-discipline.md` MUST-2 forbids.

The forward fix is the DESCRIPTIVE SUFFIX. `F87-upflow-loop` is unique where `F87` is not, which is why LINK-3 demands the full id verbatim and why the register's own stated convention is the thing that was wrong.

---

## 4. Where the teeth sit, and why each is where it is

| Layer | Mechanism | Severity | Why not higher / lower |
| ----- | --------- | -------- | ---------------------- |
| Generator | `build()` calls `checkLinks()` BEFORE `tally()` | exit 2, no block | Refusing the BLOCK rather than annotating it: a footnote saying some items are untraceable is what gets dropped when someone quotes the table. Gating in `build()` means `--write`, `--check`, `--json` and `--quote` are all on the same fact — there is no mode that emits a count for an unreachable item. |
| Hook, structural arm | `burndown-trace-write-guard.js` | `block` | The verdict is the generator's, from a Map lookup, `git ls-files`, and a substring test. The hook's regex only LOCATES finding lines already decided. `hook-output-discipline.md` MUST-5(a) § Signal selection, which enumerates “a filesystem or git-object fact” as blockable. |
| Hook, semantic arm | same file | `advisory` | "Is this the right ruling?" is a judgment. Emitted as passthrough context, never `instructAndWait`. |
| Gate review | reviewer at `/redteam`, cc-architect at `/codify` | halt-and-report | The collision class above. Nothing structural sees it. |

**The scoping decision that keeps the hook from crying wolf.** It fires only when the written file is a chain surface AND a `burndown-manifest.json` exists. A repo with no burndown pays nothing and sees nothing. `.session-notes.d/**` is deliberately EXCLUDED from the scope predicate even though `.session-notes.shared.md` is included: a fragment participates in no leg, so a finding surfaced on a fragment write is always about the tree and never about the bytes just written, and per-operator fragment writes are frequent enough that it would train people to ignore the channel — which is how a real finding then goes unread.

**Two unknowns that must not render alike**, and the ladder the guard uses:

- *Not in scope, or cannot ask* → fully silent. No manifest, unparseable manifest, no generator, non-chain surface, malformed stdin, path outside the project.
- *Asked and got no answer* → advisory UNKNOWN. Exit 2 with no `LINK-n` lines is a PRE-EXISTING generator refusal (a source mid-edit), not a link finding. So are a spawn error and a timeout.

Collapsing those two into one silent passthrough would make "checked, clean" and "could not check" identical at the reader's end, which is the failure `burndown-integrity.md` MUST NOT § "Read a refused build as clean" already names.

---

## 5. Ordering constraint when adopting this

**Backfill the tracker BEFORE registering the hook.** The guard blocks writes to chain surfaces — `journal/`, `workspaces/`, `specs/`, `todos/`, `burndown/`, the tracker — whenever the chain is broken. On a repo whose chain is not yet intact that includes the journal entry recording the backfill, so registering first locks you out of the fix.

Order that works:

1. Add `tracker` to `burndown-manifest.json` (the checker is inert without it).
2. `node .claude/bin/burndown-build.mjs --check-links` — read the full finding list; it reports EVERY broken item in one run, deliberately, so a 26-row backfill is one cycle rather than 26.
3. Author the context artifact; commit it (condition 5 needs it tracked).
4. Add the tracker rows; commit.
5. `--check-links` again — expect `chain INTACT — N item(s)`.
6. Only now add the hook to `settings.json`.

---

## 6. What is NOT covered, stated rather than implied

- **Writes that do not go through `Edit`/`Write`/`NotebookEdit`.** A Bash heredoc or `>` redirect writes the same file and the matcher never fires. Structural to the Bash surface, not fixable in this guard — the same bound `burndown-integrity.md` records for its own hooks.
- **Whether an anchor names the RIGHT ruling.** § 3 is the whole argument. Gate review is the layer, permanently.
- **Orphan ledger rows.** A row whose ID is in no source is NOT a finding. The ledger is broader than the burndown; LINK-1 runs from the ITEMS outward, never from the ledger inward, or the ledger becomes unusable for anything else.
- **Status correctness.** Nothing here reads a status. `burndown-integrity.md` owns the vocabulary and the counts; this owns reachability only.
- **Scale.** The checker does one `git ls-files` per item, so cost is linear in register size. Measured at 26 items on this tree the whole run is well under a second; no repo with a large register has been measured.

---

## Origin

See `rules/burndown-traceability.md` § Origin. Authored 2026-08-21 against `6ddf06b1` from an operator directive; the measurement, the pruning post-mortem and the collision table are all from that tree and are re-derivable with the commands quoted above.
