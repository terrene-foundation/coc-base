# knowledge-convergence — Full Rule Examples

These examples are preserved from canonical `a19f76aa`; the governing clauses
remain in `.claude/rules/knowledge-convergence.md`. The rule carries compact examples and links here for the full forms.

## Example 1

```text
# DO — fragment hand-written; log appended; projection regenerated
.session-notes.d/alice.md   ← alice's fragment (alice-only writer)
burndown/events.jsonl       ← APPEND-ONLY signed events (appendEvent); THE LOG
.session-notes.shared.md    ← THE PROJECTION: regenerated from foldEvents via
                              atomic .tmp+rename(); owner: from the event's
                              stamped display_id/person_id/verified_id —
                              UNSIGNED, never verified; NO merge driver

# DO — the fragment names its own operator in frontmatter (rendered: the extract)
person_id + verified_id     ← AUTHORITATIVE attribution; display_id is signage

# DO NOT — single shared file, a hand-edited row, or a driver on a projection
.session-notes              ← one operator's write wins; the other's lost
| F91 | … | in progress |   ← edited in place; regenerate reverts it
.session-notes.shared.md merge=coc-ledger  ← merges CLEAN, matches no fold

# DO NOT — attribute by stripping the filename (display_id collisions are LEGAL)
displayId = basename(f, ".md")  ← two humans both called "alex" ⇒ silently merged
```

## Example 2

```text
# DO — fold-anchored slot via reserveJournalSlotSigned(repoDir, {dir, identity, type, topic});
#      emits the signed journal-slot-reservation record AND returns the reservation;
#      writes journal/NNNN-<display_id>-TYPE-slug.md (e.g. 0042-alice-DECISION-foo.md)
#      with frontmatter verified_id+person_id+display_id; on close emit signed
#      journal-body-anchor coordination-log record (buildAnchorRecord partial →
#      coc-emit.js::emitSignedRecord fills the chain envelope + signs + appends).

# DO NOT — fs scan high-water (race) + plain NNNN-TYPE-slug filename + no body anchor
```

## Example 3

```text
# DO — Step 0: res = acquireCodifyLease({displayId, scopeFiles}); on conflict, surface
#      res.conflicting.display_id verbatim + STOP; on ok, edits on res.branch
#      (the RECORDED branch — authorization is lease COVERAGE + signer, NOT the
#      branch NAME's shape) → PR + admin-merge; release via repoDir only.

# DO NOT — proceed without lease (concurrent /codify clobbers latest.yaml), or
#          supply leasePath to release (misroutes per Sec-MED-3; helper ignores it).
```

## Example 4

```text
# DO — split rule: one fact per file; frontmatter signed:true, promoted_by:
#      {display_id, verified_id}, body_anchor sha256 stamped by coc-append
.claude/team-memory/canonical-build-targets.md   ← one fact
.claude/team-memory/deploy-window-policy.md      ← one fact

# DO NOT — aggregate (two operators promoting concurrently silently clobber)
.claude/team-memory/team-memory.md               ← multiple facts in one body
```

## Example 5

```text
# DO — read-only ≤150-line body; resolve identity → team-memory → workspace →
#      posture → claims → codify lease → rules-changed → Action Items.
#      Procedure detail lives in skills/41-onboard/SKILL.md.

# DO NOT — oversized body that writes state (acquireCodifyLease, runs roster
#          genesis ceremony) or reorders sections per "urgency"
```

## Example 6

```text
# DO — stamped, signed, refuse-on-overflow
r = appendStamped(repoDir, ".claude/learning/violations.jsonl", partial, {identity});
if (!r.ok) { /* surface r.reason; do NOT silently truncate evidence and retry */ }

# DO NOT — bare append, no identity stamping, silent truncate on overflow
fs.appendFileSync(".claude/learning/violations.jsonl", JSON.stringify(partial) + "\n");
# no verified_id, no sig — forensic scan cannot attribute the row to a human
```
