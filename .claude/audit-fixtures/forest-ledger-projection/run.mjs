#!/usr/bin/env node
/**
 * Audit-fixture runner for the DERIVED FOREST-LEDGER PROJECTION — A2/C3 of
 * `workspaces/runtime-enforcement-2026-08-14/02-plans/tracker-log-projection-acceptance.md`.
 *
 * ── WHY THIS SUITE EXISTS, STATED AS A MEASUREMENT AND NOT AS A CHORE ────────
 *
 * V2 asked for the 29 `audit-fixtures/forest-ledger/` pairs to re-baseline and to
 * be shown STILL DISCRIMINATING. MEASURED at this shard's landing: **0 of 29
 * re-baselined.** That is a TRUE negative, not a blind green — the same runner was
 * fired at a known-answer case first (`hasReceipt()` forced to `true`, which flips
 * `fixture-04-close-no-receipt` from exit 1 to exit 0) and it went RED with 4
 * failures, then green again on restore.
 *
 * The reason 0 moved is structural: those 29 pairs are inputs to
 * `bin/validate-forest-ledger.mjs`, which checks the STRUCTURE of a hand-authored
 * forest ledger. That contract did not change — hand-authored forest ledgers still
 * exist, at `workspaces/<name>/.session-notes.shared.md`, and they keep the
 * `coc-ledger` row-merge because row-merge is right semantics THERE. What changed
 * is the ROOT ledger, which became a projection of a log, and NOTHING in that
 * suite ever asserted anything about it.
 *
 * So the honest discharge of V2 is not to churn 29 files whose subject is
 * unchanged. It is to observe that a set which passes identically before and after
 * has stopped testing the thing that moved — and to ship the set that DOES test
 * it. That is this file.
 *
 * ── SHAPE (`instrument-bipolarity.md` MUST-1/2) ──────────────────────────────
 *
 * Every case belongs to a `pair` and carries a `pole` of `red` or `green`. The two
 * poles of a pair MUST reach DIFFERENT verdicts — a pair whose poles agree is
 * asserting nothing, and this runner FAILS on that condition explicitly rather
 * than reporting two passes. The `red` pole names a failure IDENTITY (what
 * SPECIFICALLY goes wrong), never merely "is not ok".
 *
 * ── ESTABLISHED RED (`instrument-discipline.md` MUST-2) ──────────────────────
 *
 * Each case's `reds_under` names a mutation to the code under test that makes THAT
 * pole fail. Every mutation named below is one that RESTORES THE PRE-A2 BEHAVIOUR
 * — an upsert that leaves hand-edits standing, a status projected verbatim, a fold
 * with no weight fence, a check that fails open. A fixture set that survives those
 * mutations would be passing against both the old and the new contract, which is
 * the exact vacuity V2 names. They were run; the reddened poles are recorded in
 * the landing commit.
 *
 * Hermetic: every case builds its own tmpdir and synthesizes its own JSONL. The
 * fold validates the caller-half fields and does not verify signatures, so a case
 * needs no signing key and no enrolled identity. Class B is the ONE deliberate
 * exception and says so.
 */

import "../_lib/no-ambient-git.cjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "..", "hooks", "lib");
const REPO_ROOT = join(HERE, "..", "..", "..");

const layout = require(join(LIB, "session-notes-layout.js"));
const events = require(join(LIB, "burndown-events.js"));

const { regenerateForestLedger, SHARED_LEDGER_NAME } = layout;
const { foldProjection, projectStatus, buildEvent, EVENTS_REL, SEE_BURNDOWN } = events;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * One well-formed ON-DISK log line. `display_id` is the stamped half `appendStamped`
 * adds; the fold reads it for the `owner` column, so a fixture supplies it directly.
 *
 * `sig_alg`/`seq`/`prev_hash` are the OTHER stamped half. `buildEvent` returns the
 * CALLER half only and deliberately stamps none of them, but `_walk` — the fold both
 * `foldEvents` and `foldProjection` share — applies `validateRecord` to every line it
 * reads, and that predicate REQUIRES all three on a `burndown-event/v2` record:
 * `sig_alg` a declared suite, `seq` an integer >= 1, `prev_hash` 64-hex or null (null
 * iff `seq === 1`). Without them every synthesized line is SKIPPED as malformed and
 * every projection case folds to zero rows.
 *
 * `seq: 1` / `prev_hash: null` on each line is a well-formed SHAPE, which is all
 * `validateRecord` decides — it is documented shape-only and per-line, and whole-log
 * chain consistency belongs to `signed-log.js::verifyChain`, which the fold never runs.
 *
 * The envelope sits AFTER `buildEvent` and before an explicit `envelope` override so a
 * case can drive a malformed-envelope branch; `buildEvent` itself strips unknown keys,
 * so passing one through `partial` would be silently dropped.
 */
function line(partial, displayId = "op-a", envelope = {}) {
  return JSON.stringify({
    id: `rec_${Math.random().toString(16).slice(2)}`,
    timestamp: "2026-08-23T00:00:00.000Z",
    display_id: displayId,
    ...buildEvent(partial),
    sig_alg: "openpgp",
    seq: 1,
    prev_hash: null,
    ...envelope,
  });
}

const genesis = (item_id, status, extra = {}) =>
  line({
    kind: "genesis",
    item_id,
    item: `item text for ${item_id}`,
    value_anchor: `\`workspaces/w/ctx.md#${item_id}\``,
    status,
    authority: "agent",
    source: "fixture",
    ...extra,
  });

const transition = (item_id, status, authority = "agent") =>
  line({
    kind: "transition",
    item_id,
    item: `LIVE item text for ${item_id}`,
    value_anchor: `\`workspaces/w/ctx.md#${item_id}\``,
    status,
    authority,
    source: "fixture",
  });

/**
 * A well-formed PROPOSAL — a valid on-disk record the fold deliberately does not fold
 * (it lands in `skipped[]` with kind `proposal-inert`). The shape behind the
 * `refuse-only-unreadable-skips` pair.
 */
const proposalFor = (item_id) =>
  line({
    kind: "proposal",
    item_id,
    item: `item text for ${item_id}`,
    value_anchor: `\`workspaces/w/ctx.md#${item_id}\``,
    authority: "agent",
    source: "fixture",
    proposed_status: "Signed off",
    reason: "measured closed in session",
  });

/** A throwaway repo root carrying a log at the canonical relative path. */
function repoWith(logLines) {
  const dir = mkdtempSync(join(tmpdir(), "flp-"));
  mkdirSync(join(dir, EVENTS_REL, ".."), { recursive: true });
  writeFileSync(join(dir, EVENTS_REL), `${logLines.join("\n")}\n`);
  return dir;
}

/** git, quietly, against a throwaway tree. */
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

/** Make `dir` a repository with everything currently in it COMMITTED. */
function commitAll(dir, message) {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "user.name", "fixture");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message || "fixture baseline");
  return dir;
}

/**
 * A throwaway repo carrying a log AND a generator manifest declaring `tracker.max_rows`
 * — the surface `session-notes-continuity.md` MUST-3 requires a projection's ceiling to
 * be declared on. Pass `maxRows: null` to write NO manifest at all, which is how the
 * fail-closed fallback is exercised.
 *
 * IT IS A REAL GIT REPOSITORY AND THE MANIFEST IS COMMITTED, and that is not scenery.
 * `_resolveProjectionCeiling` now holds the manifest to the same
 * committed-and-unmodified guard `burndown-build.mjs::loadManifest` holds every OTHER
 * manifest read to (`security.md` § Enforcement-Surface Parity). Before this suite
 * git-inited, its declared-ceiling pair ran against a working-tree-only manifest and
 * the GREEN pole passed anyway — 5 rows is under a declared 5 AND under the 277-row
 * fallback, so the pole could not tell a honoured declaration from a fallback wearing
 * the same number. That is why every declared-ceiling case below now asserts
 * `ceiling_declared` / `ceiling_source` and not merely the row count.
 *
 * `committed: false` writes the manifest and does NOT commit it — the fail-open this
 * guard closes.
 */
function repoWithCeiling(logLines, maxRows, opts = {}) {
  const dir = repoWith(logLines);
  const committed = opts.committed !== false;
  if (maxRows !== null && committed) {
    writeFileSync(
      join(dir, "burndown-manifest.json"),
      JSON.stringify({ tracker: { path: EVENTS_REL, max_rows: maxRows } }),
    );
  }
  commitAll(dir);
  if (maxRows !== null && !committed) {
    writeFileSync(
      join(dir, "burndown-manifest.json"),
      JSON.stringify({ tracker: { path: EVENTS_REL, max_rows: maxRows } }),
    );
  }
  return dir;
}

/** Does the ceiling `source` string name the MANIFEST, or the fail-closed default? */
const sourceKind = (s) =>
  /burndown-manifest\.json::tracker\.max_rows$/.test(String(s || ""))
    ? "manifest"
    : /MUST-3 fail-closed default/.test(String(s || ""))
      ? "fallback"
      : "unrecognized";

/**
 * A checklist-shaped todo — the EXACT producer shape behind the line-vs-row defect.
 * `PostToolUse:TodoWrite` sets `item: t.content` VERBATIM and `validateEvent` accepts a
 * newline in any field (it checks type, non-empty, and <=512 chars only), so a
 * multi-line todo is ordinary input, not a crafted payload.
 */
const checklist = (n) =>
  `Land the ceiling fix\n${Array.from({ length: n }, (_, i) => `- step ${i + 1}: verify`).join("\n")}`;

/** N rows whose item text carries `k` embedded line breaks each. */
const nMultiLineRows = (n, k = 25) =>
  Array.from({ length: n }, (_, i) => genesis(`M${i + 1}`, "Not started", { item: checklist(k) }));

/** The projection's line count as the file actually holds it. */
const lineCountOf = (dir) => {
  const t = ledgerOf(dir);
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n").length;
};

/** N synthetic genesis rows — one distinct item each, so rows === N. */
const nRows = (n) => Array.from({ length: n }, (_, i) => genesis(`C${i + 1}`, "Not started"));

const ledgerExists = (dir) => {
  try {
    readFileSync(join(dir, SHARED_LEDGER_NAME), "utf8");
    return true;
  } catch {
    return false;
  }
};

const ledgerOf = (dir) => readFileSync(join(dir, SHARED_LEDGER_NAME), "utf8");

const statusCellFor = (text, id) => {
  const row = text.split("\n").find((l) => l.startsWith(`| ${id} `));
  return row ? row.split("|").map((c) => c.trim())[5] : null;
};

// ── cases ────────────────────────────────────────────────────────────────────

const CASES = [
  // ═════ PAIR 1 — the render-time authority fence ═══════════════════════════
  // The finding this pair exists for: `burndown-genesis.mjs` sourced `status`
  // from `manifest.sources`, so all 267 shipped genesis events carry
  // OWNER-VOCABULARY statuses under `authority: "agent"`. Projecting them
  // verbatim renders 267 owner adjudications no owner made.
  {
    pair: "authority-fence",
    pole: "red",
    failure_identity: "agent-minted-owner-status",
    name: "an agent-authority event carrying `Signed off` MUST NOT project `Signed off`",
    reds_under:
      "projectStatus(): `return e.status` unconditionally — i.e. restore the pre-A2 verbatim projection",
    run: () =>
      projectStatus({ status: "Signed off", authority: "agent", kind: "genesis" }),
    expect: SEE_BURNDOWN,
  },
  {
    pair: "authority-fence",
    pole: "green",
    name: "an OWNER-authority event carrying `Signed off` projects it verbatim",
    reds_under: 'projectStatus(): drop the `e.authority !== "owner"` conjunct',
    run: () =>
      projectStatus({ status: "Signed off", authority: "owner", kind: "transition" }),
    expect: "Signed off",
  },
  {
    pair: "authority-fence-passthrough",
    pole: "green",
    name: "a NON-owner-vocabulary status launders no authority and passes through",
    reds_under: "projectStatus(): neutralize every status instead of only owner-vocabulary ones",
    run: () => projectStatus({ status: "todo:in_progress", authority: "agent" }),
    expect: "todo:in_progress",
  },
  {
    pair: "authority-fence-passthrough",
    pole: "red",
    failure_identity: "unreadable-status-silently-rendered",
    name: "a missing status is the neutral passthrough, never `undefined` in a cell",
    reds_under: "projectStatus(): drop the typeof guard",
    run: () => projectStatus({ authority: "agent" }),
    expect: SEE_BURNDOWN,
  },

  // ═════ PAIR 2 — the C5 weight fence, INSIDE the projection fold ═══════════
  {
    pair: "c5-weight-fence",
    pole: "red",
    failure_identity: "genesis-reverts-live-work",
    name: "a genesis AFTER a live transition MUST NOT overwrite it, and the skip is recorded",
    reds_under: "_walk(): remove the `weights.get(item_id) === 'live'` fence branch",
    run: () => {
      const f = foldProjection(
        [transition("X1", "todo:in_progress"), genesis("X1", "Not started")].join("\n"),
      );
      return {
        item: f.rows.get("X1").item,
        skipped: f.skipped.length,
        why: /migration_baseline weight never overwrites live/.test(f.skipped[0]?.why || ""),
      };
    },
    expect: { item: "LIVE item text for X1", skipped: 1, why: true },
  },
  {
    pair: "c5-weight-fence",
    pole: "green",
    name: "a live transition AFTER a genesis DOES win, with nothing skipped",
    reds_under: "_walk(): fence on weight in BOTH directions (refuse live-over-genesis too)",
    run: () => {
      const f = foldProjection(
        [genesis("X1", "Not started"), transition("X1", "todo:in_progress")].join("\n"),
      );
      return { item: f.rows.get("X1").item, skipped: f.skipped.length };
    },
    expect: { item: "LIVE item text for X1", skipped: 0 },
  },

  // ═════ PAIR 3 — the no-op discipline (leak T1) ════════════════════════════
  // `burndown-build.mjs` asserts the tracker is COMMITTED AND UNMODIFIED before
  // reading it, so a regeneration that rewrote identical bytes would take the
  // gate unrunnable from the first run until someone committed.
  {
    pair: "noop-discipline",
    pole: "green",
    name: "a second regeneration over an already-correct projection writes NOTHING",
    reds_under: "regenerateForestLedger(): drop the `current === next` early return",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        const first = regenerateForestLedger(dir);
        const second = regenerateForestLedger(dir);
        return { first: first.action, second: second.action, changed: second.changed };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { first: "written", second: "unchanged", changed: false },
  },
  {
    pair: "noop-discipline",
    pole: "red",
    failure_identity: "hand-edit-survives-regeneration",
    name: "a hand-edited projection IS rewritten — the edit does not survive",
    reds_under:
      "regenerateForestLedger(): compare only row COUNT instead of bytes — i.e. restore an upsert that leaves foreign cells standing",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const edited = ledgerOf(dir).replace("see burndown", "Signed off");
        writeFileSync(join(dir, SHARED_LEDGER_NAME), edited);
        const r = regenerateForestLedger(dir);
        return { action: r.action, status_after: statusCellFor(ledgerOf(dir), "A1") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { action: "written", status_after: SEE_BURNDOWN },
  },

  // ═════ PAIR 4 — `--check` NEVER fails open ════════════════════════════════
  {
    pair: "check-never-fails-open",
    pole: "red",
    failure_identity: "in-sync-verdict-from-an-instrument-that-never-looked",
    name: "`--check` against an ABSENT log refuses; it does not report in_sync",
    reds_under:
      "regenerateForestLedger(): make the unreadable-log branch return {ok:true, in_sync:true} — the fail-open the write path is allowed and the check path is not",
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), "flp-nolog-"));
      try {
        const r = regenerateForestLedger(dir, { check: true });
        return { ok: r.ok, error: r.error, in_sync: r.in_sync };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: false, error: "event log unreadable", in_sync: undefined },
  },
  {
    pair: "check-never-fails-open",
    pole: "green",
    name: "`--check` over a readable log and a freshly written projection reports in_sync",
    reds_under: "regenerateForestLedger(): compare against LEDGER_HEADER instead of the rendered bytes",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const r = regenerateForestLedger(dir, { check: true });
        return { ok: r.ok, in_sync: r.in_sync, drift: r.drift };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, in_sync: true, drift: null },
  },

  // ═════ PAIR 5 — the C3 core: a fabricated row is DETECTED ═════════════════
  // A row present in the FILE and in NO event is the signature of BOTH failure
  // modes C3 names — a hand-edit, and a row-keyed merge that produced a table
  // belonging to neither branch's fold.
  {
    pair: "fabrication-detected",
    pole: "red",
    failure_identity: "row-in-file-belongs-to-no-event",
    name: "a row with no backing event is reported as extra_in_file, by id",
    reds_under: "_describeLedgerDrift(): drop the extra-in-file loop",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const fabricated = ledgerOf(dir).replace(
          /\n$/,
          "\n| GHOST-1 | op-b | fabricated by a row merge | `workspaces/w/ctx.md#GHOST-1` | Signed off |\n",
        );
        writeFileSync(join(dir, SHARED_LEDGER_NAME), fabricated);
        const r = regenerateForestLedger(dir, { check: true });
        return {
          in_sync: r.in_sync,
          extra: r.drift.extra_in_file,
          named: r.drift.sample.extra_in_file[0],
          missing: r.drift.missing_from_file,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { in_sync: false, extra: 1, named: "GHOST-1", missing: 0 },
  },
  {
    pair: "fabrication-detected",
    pole: "green",
    name: "an untouched projection reports no drift at all",
    reds_under: "_describeLedgerDrift(): compare rendered lines without trimming the table region",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started"), genesis("A2", "In progress")]);
      try {
        regenerateForestLedger(dir);
        const r = regenerateForestLedger(dir, { check: true });
        return { in_sync: r.in_sync, rows: r.rows };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { in_sync: true, rows: 2 },
  },

  // ═════ PAIR 5b — a HEADER-only drift is SURFACED, not all-zeros ════════════
  // `in_sync` is a WHOLE-FILE byte compare; the three counts compare ROWS only.
  // A stale PREAMBLE with identical rows used to report 0/0/0 beside
  // `in_sync:false` — a reader saw "nothing further" while the file provably
  // differed. Fixed 2026-10-03: the drift report carries the differing lines.
  {
    pair: "header-drift-surfaced",
    pole: "red",
    failure_identity: "header-only-drift-reports-all-zeros",
    name: "a stale preamble with identical rows is reported by LINE, not as an all-zero drift",
    reds_under: "_describeLedgerDrift(): drop the first_differing_lines scan",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const headerStale = ledgerOf(dir).replace(/^.*\n/, "# Forest Ledger (hand-edited preamble)\n");
        writeFileSync(join(dir, SHARED_LEDGER_NAME), headerStale);
        const r = regenerateForestLedger(dir, { check: true });
        const first = (r.drift.first_differing_lines || [])[0] || null;
        return {
          in_sync: r.in_sync,
          rows_clean: r.drift.missing_from_file + r.drift.extra_in_file + r.drift.cells_differ,
          first_line_number: first ? first.line : null,
          file_line: first ? first.file : null,
          fold_present: Boolean(first && typeof first.fold === "string"),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: {
      in_sync: false,
      rows_clean: 0,
      first_line_number: 1,
      file_line: "# Forest Ledger (hand-edited preamble)",
      fold_present: true,
    },
  },
  {
    pair: "header-drift-surfaced",
    pole: "green",
    name: "a fresh projection reports NO first_differing_lines — the new field is not a constant",
    reds_under: "_describeLedgerDrift(): populate first_differing_lines even when the file is in sync",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const r = regenerateForestLedger(dir, { check: true });
        return { in_sync: r.in_sync, drift: r.drift };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { in_sync: true, drift: null },
  },

  // ═════ PAIR 6 — a partially-readable log REFUSES, never renders short ═════
  {
    pair: "refuse-partial-log",
    pole: "red",
    failure_identity: "projection-silently-short-a-row",
    name: "one malformed log line refuses the whole regeneration",
    reds_under:
      "regenerateForestLedger(): drop the `folded.skipped.length > 0` guard — the projection then renders N-1 rows and the gate reports the missing item as a vanished row",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started"), "{not json", genesis("A2", "Not started")]);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, error: r.error, skipped: (r.skipped || []).length };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: false, error: "event log has unreadable lines", skipped: 1 },
  },
  {
    pair: "refuse-partial-log",
    pole: "green",
    name: "a clean log renders every row",
    reds_under: "regenerateForestLedger(): treat a blank trailing line as unreadable",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started"), genesis("A2", "Not started")]);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, rows: r.rows, lines: r.lines };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // 23 header lines + N rows — the projection's size stated as a FUNCTION, so a
    // header edit that quietly eats the MUST-3 headroom reds here.
    expect: { ok: true, rows: 2, lines: 25 },
  },

  // ═════ PAIR 7 — the derived table stays READABLE by both readers ══════════
  {
    pair: "readers-agree",
    pole: "green",
    name: "the rendered projection is locatable by the writer's own table parser",
    reds_under: "renderForestLedgerProjection(): drop the separator row",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const loc = layout.locateLedgerTable(ledgerOf(dir));
        return { ok: loc.ok, hasRow: loc.ok && loc.rows.has("A1"), cols: loc.ok && loc.cols.length };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, hasRow: true, cols: 5 },
  },
  {
    pair: "readers-agree",
    pole: "red",
    failure_identity: "banner-mints-a-second-candidate-table",
    name: "the DO-NOT-EDIT banner must not create a second candidate table",
    reds_under:
      "renderForestLedgerProjection(): put a `| ID | … |` line plus a separator inside the comment banner",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started")]);
      try {
        regenerateForestLedger(dir);
        const loc = layout.locateLedgerTable(ledgerOf(dir));
        return { ok: loc.ok, kind: loc.kind };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, kind: undefined },
  },

  // ═════ PAIR 8 — the DECLARED ceiling REFUSES, and never truncates ═════════
  // `session-notes-continuity.md` MUST-3. The red pole is the whole point: a
  // projection one row past its declared bound must REFUSE TO EMIT, leaving the
  // file on disk untouched. A generator that trimmed to fit would pass a naive
  // "did it stay under the ceiling" check while dropping work with no diff.
  {
    pair: "ceiling-declared",
    pole: "green",
    name: "exactly AT the declared ceiling, the projection emits — and the DECLARATION is what bound it",
    reds_under:
      "regenerateForestLedger(): make the ceiling comparison `>=` instead of `>`; or _resolveProjectionCeiling(): fall back unconditionally (the row count alone would still pass — `ceiling_source` is what catches it)",
    run: () => {
      // 279 rows: past the 277-row FALLBACK, under the declared 300. So this pole
      // can ONLY pass if the declaration was honoured — the numeric coincidence at
      // 5-vs-277 that let the previous version of this pole pass either way is gone.
      const dir = repoWithCeiling(nRows(279), 300);
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          action: r.action,
          rows: r.rows,
          wrote: ledgerExists(dir),
          declared: r.ceiling_declared,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // `ceiling_declared` is absent from the SUCCESS shape, so the discriminator here
    // is the row count crossing the fallback: 279 emits only under the declaration.
    expect: { ok: true, action: "written", rows: 279, wrote: true, declared: undefined },
  },
  {
    pair: "ceiling-declared",
    pole: "red",
    failure_identity: "over-ceiling-projection-emitted-or-truncated",
    name: "one row PAST the declared ceiling refuses, and writes nothing",
    reds_under:
      "regenerateForestLedger(): drop the `_resolveProjectionCeiling` guard, or make it slice `folded.rows` to fit instead of returning {ok:false}",
    run: () => {
      const dir = repoWithCeiling(nRows(6), 5);
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          error: r.error,
          rows: r.rows,
          max_rows: r.max_rows,
          declared: r.ceiling_declared,
          source: sourceKind(r.ceiling_source),
          wrote: ledgerExists(dir),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    // `source: "manifest"` is the discriminator the raw `max_rows: 5` cannot be: a
    // fallback would report 277 here, but a future fallback that happened to compute
    // 5 would be indistinguishable on the number alone.
    expect: {
      ok: false,
      error: "projection ceiling exceeded",
      rows: 6,
      max_rows: 5,
      declared: true,
      source: "manifest",
      wrote: false,
    },
  },

  // ═════ PAIR 9 — an UNDECLARED ceiling FAILS CLOSED, never open ════════════
  // MUST-3: "until a ceiling is declared for a given projection, the 300-line
  // ceiling above applies to it unchanged". A missing manifest must therefore read
  // as the STRICT case. This pair also pins the header-overhead arithmetic: with
  // 23 header lines the 300-line default lands at 277 rows, so 277 emits and 278
  // refuses. A header edit that eats the headroom reds the green pole here.
  {
    pair: "ceiling-fail-closed",
    pole: "green",
    name: "with NO manifest, 277 rows still emits (300-line default, 23 header lines)",
    reds_under:
      "_resolveProjectionCeiling(): subtract a hardcoded header count instead of deriving it from renderForestLedgerProjection",
    run: () => {
      const dir = repoWithCeiling(nRows(277), null);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, rows: r.rows, lines: r.lines };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, rows: 277, lines: 300 },
  },
  {
    pair: "ceiling-fail-closed",
    pole: "red",
    failure_identity: "absent-declaration-read-as-unbounded",
    name: "with NO manifest, 278 rows REFUSES — absent is the strict case, not the permissive one",
    reds_under:
      "_resolveProjectionCeiling(): return {maxRows: Infinity} when the manifest is missing or unparseable",
    run: () => {
      const dir = repoWithCeiling(nRows(278), null);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, error: r.error, rows: r.rows, max_rows: r.max_rows, declared: r.ceiling_declared };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: {
      ok: false,
      error: "projection ceiling exceeded",
      rows: 278,
      max_rows: 277,
      declared: false,
    },
  },

  // ═════ PAIR 10 — supersession is a RECORD, not a tally ════════════════════
  // The fold is last-wins where `parseLedger` refused duplicates outright. Under
  // the log a supersession is an APPEND: the diff shows one added line and says
  // nothing about what it displaced. So the fold names WHICH line lost.
  {
    pair: "supersession-recorded",
    pole: "green",
    name: "one event per item records no supersession",
    reds_under: "_walk(): push a superseded row unconditionally rather than on `rows.has(e.item_id)`",
    run: () => {
      const f = foldProjection(`${[genesis("S1", "Not started"), genesis("S2", "Not started")].join("\n")}\n`);
      return { rows: f.rows.size, superseded: f.superseded.length };
    },
    expect: { rows: 2, superseded: 0 },
  },
  {
    pair: "supersession-recorded",
    pole: "red",
    failure_identity: "supersession-invisible-to-the-reviewer",
    name: "a second event for the same item names BOTH line ordinals, not just a count",
    reds_under:
      "_walk(): delete the `superseded.push({...})` block — the fold then reports last-wins with no hits, leaving a reviewer a number and nothing to look at",
    run: () => {
      const f = foldProjection(
        `${[genesis("S1", "Not started"), transition("S1", "todo:in_progress")].join("\n")}\n`,
      );
      return { rows: f.rows.size, superseded: f.superseded };
    },
    expect: {
      rows: 1,
      superseded: [{ item_id: "S1", superseded_line: 1, superseded_by_line: 2 }],
    },
  },

  // ═════ PAIR 11 — ONE ROW IS ONE LINE ══════════════════════════════════════
  // The root cause of the line-vs-row breach. `_renderLedgerRow` escaped `|` but
  // not `\n`, so a cell could END THE ROW mid-table — and, because MUST-3 is
  // stated in LINES while the manifest declares ROWS, it silently unbound the two
  // units the ceiling arithmetic equates.
  {
    pair: "row-is-one-line",
    pole: "red",
    failure_identity: "embedded-newline-splits-one-row-across-many-lines",
    name: "an item carrying 25 line breaks still renders as exactly ONE table line",
    reds_under: "_renderLedgerRow(): drop the `\\r\\n|\\r|\\n` → `\\\\n` escape from `cell()`",
    run: () => {
      const rows = new Map([
        ["N1", { id: "N1", owner: "op-a", item: checklist(25), anchorRaw: "`w/ctx.md#N1`", status: "Not started" }],
      ]);
      const text = layout.renderForestLedgerProjection(rows, {});
      const body = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
      const tableRows = body.filter((l) => l.startsWith("| N1 "));
      return {
        table_lines_for_one_row: tableRows.length,
        // 23 header lines + exactly 1 row.
        total_lines: body.length,
        raw_newline_in_output: /\n/.test(tableRows[0] || "x\n"),
      };
    },
    expect: { table_lines_for_one_row: 1, total_lines: 24, raw_newline_in_output: false },
  },
  {
    pair: "row-is-one-line",
    pole: "green",
    name: "the escape LOSES NOTHING — every line of the item survives, escaped, in the cell",
    reds_under:
      "_renderLedgerRow(): replace the newline with a space, or drop the offending text — either passes the line-count pole above while silently discarding content",
    run: () => {
      const item = "first line\nsecond line\nthird | with a pipe";
      const rows = new Map([
        ["N2", { id: "N2", owner: "op-a", item, anchorRaw: "`w/ctx.md#N2`", status: "Not started" }],
      ]);
      const text = layout.renderForestLedgerProjection(rows, {});
      const row = text.split("\n").find((l) => l.startsWith("| N2 "));
      const cell = row.split(" | ")[2];
      return {
        cell,
        // Both escapes hold at once: the pipe fix that was already correct is not
        // regressed by the newline fix.
        pipe_still_escaped: cell.includes("\\|"),
        segments_preserved: cell.split("\\n").length,
      };
    },
    expect: {
      cell: "first line\\nsecond line\\nthird \\| with a pipe",
      pipe_still_escaped: true,
      segments_preserved: 3,
    },
  },

  // ═════ PAIR 12 — THE CEILING MEASURES LINES, NOT ROWS ═════════════════════
  // MEASURED before the fix, on the shipped log's shape: 268 rows — UNDER the
  // 277-row ceiling — rendered 541 LINES, past MUST-3's 300-line bound by 241,
  // and `regenerateForestLedger` returned `ok: true`. `.session-notes.shared.md`
  // is a MUST-2 no-truncate-read surface carrying `block` teeth at
  // `PreToolUse:Read`, so the breach is not cosmetic.
  {
    pair: "ceiling-measures-lines",
    pole: "green",
    name: "268 CHECKLIST-shaped rows emit at 291 lines, not 541 — the projection stays under 300",
    reds_under:
      "_renderLedgerRow(): drop the newline escape — the same 268 rows then render 541 lines and this pole reds on both `lines` and `file_lines`",
    run: () => {
      const dir = repoWithCeiling(nMultiLineRows(268), null);
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          rows: r.rows,
          lines: r.lines,
          file_lines: r.ok ? lineCountOf(dir) : null,
          under_must3: r.ok && lineCountOf(dir) <= 300,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, rows: 268, lines: 291, file_lines: 291, under_must3: true },
  },
  {
    pair: "ceiling-measures-lines",
    pole: "red",
    failure_identity: "refusal-reports-arithmetic-it-did-not-measure",
    name: "the refusal carries the MEASURED line count, not `rows + headerLines`",
    reds_under:
      "regenerateForestLedger(): move `renderForestLedgerProjection` back BELOW the ceiling check — `lines` is then undefined in the refusal, because there is no render to measure",
    run: () => {
      const dir = repoWithCeiling(nMultiLineRows(278), null);
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          error: r.error,
          rows: r.rows,
          lines: r.lines,
          max_lines: r.max_lines,
          over: r.over,
          wrote: ledgerExists(dir),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: {
      ok: false,
      error: "projection ceiling exceeded",
      rows: 278,
      lines: 301,
      max_lines: 300,
      over: "rows",
      wrote: false,
    },
  },

  // ═════ PAIR 13 — THE CEILING'S OWN MANIFEST READ IS GUARDED ═══════════════
  // `security.md` § Enforcement-Surface Parity. EVERY manifest read in
  // `burndown-build.mjs` goes through `loadManifest` →
  // `assertCommittedAndUnmodified`, and `_readEventsGuarded` in this very call
  // chain refuses a symlinked LOG — while the ceiling's manifest read was a bare
  // `JSON.parse(readFileSync(...))`. So the bound MUST-3 makes fail-closed on
  // ABSENCE was fail-OPEN on a working-tree-only manifest.
  {
    pair: "manifest-must-be-committed",
    pole: "red",
    failure_identity: "uncommitted-manifest-lifts-the-ceiling",
    name: "an UNCOMMITTED `max_rows: 100000` does not raise the ceiling — it falls back to 277",
    reds_under:
      "_readManifestGuarded(): drop the `_gitCommittedAndUnmodified` call — 400 rows then emit under a declaration no reviewer ever saw",
    run: () => {
      const dir = repoWithCeiling(nRows(400), 100000, { committed: false });
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          error: r.error,
          rows: r.rows,
          max_rows: r.max_rows,
          declared: r.ceiling_declared,
          source: sourceKind(r.ceiling_source),
          names_untracked: /untracked/.test(String(r.ceiling_source || "")),
          wrote: ledgerExists(dir),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: {
      ok: false,
      error: "projection ceiling exceeded",
      rows: 400,
      max_rows: 277,
      declared: false,
      source: "fallback",
      names_untracked: true,
      wrote: false,
    },
  },
  {
    pair: "manifest-must-be-committed",
    pole: "green",
    name: "the SAME declaration, COMMITTED and unmodified, IS honoured",
    reds_under:
      "_readManifestGuarded(): return `{ok:false}` unconditionally, or _resolveProjectionCeiling(): always fall back — the guard would then be a blanket refusal rather than a verification",
    run: () => {
      // 400 rows past the 277 fallback, under a committed 500. Only a HONOURED
      // declaration emits here, so the pole cannot pass off a fallback as a pass.
      const dir = repoWithCeiling(nRows(400), 500);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, action: r.action, rows: r.rows, lines: r.lines, wrote: ledgerExists(dir) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, action: "written", rows: 400, lines: 423, wrote: true },
  },

  // ═════ PAIR 14 — A SYMLINKED MANIFEST DECLARES NOTHING ════════════════════
  // git stores the LINK TEXT as the blob while the reader follows it to the
  // TARGET, so a committed-and-clean symlink is a declaration whose content
  // nobody reviewed — the BUG-3 shape `assertCommittedAndUnmodified` names, and
  // the shape `_readEventsGuarded` already refuses for the LOG.
  {
    pair: "manifest-symlink-refused",
    pole: "red",
    failure_identity: "symlinked-manifest-declares-the-ceiling",
    name: "a COMMITTED symlink pointing out of the repo does not declare a ceiling",
    reds_under:
      "_readManifestGuarded(): drop the `st.isSymbolicLink()` refusal AND the mode-120000 branch of _gitCommittedAndUnmodified()",
    run: () => {
      const dir = repoWith(nRows(400));
      const outside = mkdtempSync(join(tmpdir(), "flp-outside-"));
      try {
        // 500, NOT 100000: an absurd number would be caught by the declaration cap
        // (PAIR 15) even with every symlink guard removed, so the `ok:false` here
        // would be masked and this pole would be asserting a label, not a defence.
        // 500 is inside the cap and above the 277 fallback, so ONLY the symlink
        // guards stand between the link target and a honoured declaration.
        writeFileSync(join(outside, "evil.json"), JSON.stringify({ tracker: { max_rows: 500 } }));
        symlinkSync(join(outside, "evil.json"), join(dir, "burndown-manifest.json"));
        commitAll(dir);
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          rows: r.rows,
          max_rows: r.max_rows,
          declared: r.ceiling_declared,
          source: sourceKind(r.ceiling_source),
          names_symlink: /symlink/.test(String(r.ceiling_source || "")),
          wrote: ledgerExists(dir),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
    expect: {
      ok: false,
      rows: 400,
      max_rows: 277,
      declared: false,
      source: "fallback",
      names_symlink: true,
      wrote: false,
    },
  },
  {
    pair: "manifest-symlink-refused",
    pole: "green",
    name: "a REGULAR committed manifest at the same path declares normally",
    reds_under: "_readManifestGuarded(): treat every manifest as a symlink (refuse unconditionally)",
    run: () => {
      const dir = repoWithCeiling(nRows(400), 450);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, rows: r.rows, wrote: ledgerExists(dir) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, rows: 400, wrote: true },
  },

  // ═════ PAIR 15 — A DECLARATION DOES NOT REPEAL THE RULE ═══════════════════
  // `declaredRows` was validated only as `Number.isInteger && >= 1`, so
  // `max_rows: 100000` was a WELL-FORMED declaration and the bound was gone.
  // MUST-3 lets a projection declare its own ceiling; it does not let one opt out.
  {
    pair: "declaration-capped",
    pole: "red",
    failure_identity: "declaration-larger-than-the-rule-it-narrows",
    name: "a COMMITTED `max_rows: 100000` is past the 900-line cap and falls back to 277",
    reds_under: "_resolveProjectionCeiling(): drop the PROJECTION_DECLARED_LINE_CAP branch",
    run: () => {
      const dir = repoWithCeiling(nRows(400), 100000);
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          rows: r.rows,
          max_rows: r.max_rows,
          declared: r.ceiling_declared,
          source: sourceKind(r.ceiling_source),
          names_cap: /900-line cap/.test(String(r.ceiling_source || "")),
          wrote: ledgerExists(dir),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: {
      ok: false,
      rows: 400,
      max_rows: 277,
      declared: false,
      source: "fallback",
      names_cap: true,
      wrote: false,
    },
  },
  {
    pair: "declaration-capped",
    pole: "green",
    name: "a declaration INSIDE the cap (800 rows = 823 lines) is honoured in full",
    reds_under:
      "_resolveProjectionCeiling(): cap on rows instead of on LINES, or set the cap below 3× the 300-line default — this pole then reds while the red pole above still passes",
    run: () => {
      const dir = repoWithCeiling(nRows(800), 800);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, rows: r.rows, lines: r.lines, wrote: ledgerExists(dir) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, rows: 800, lines: 823, wrote: true },
  },

  // ═════ PAIR — ONLY an UNREADABLE skip refuses; a well-formed skip renders ══
  // NAMED REGRESSION CASE (`coc-artifact-eval-coverage.md` MUST-2). The refusal counted
  // `folded.skipped.length`, and `skipped[]` also holds WELL-FORMED records a fold fence
  // declined. One pending proposal (`burndown/events.jsonl` line 635) therefore made the
  // shipped-projection case below report "event log has unreadable lines" over a log whose
  // every line read clean. The two poles differ by exactly the unreadable line.
  {
    pair: "refuse-only-unreadable-skips",
    pole: "red",
    failure_identity: "unreadable-line-hidden-behind-a-benign-skip",
    name: "an unreadable line still refuses beside a pending proposal, and the refusal names ONLY the unreadable line",
    reds_under:
      "regenerateForestLedger(): stop refusing on `skipClasses.unreadable` (treat every skip as benign) — the projection then renders short the unreadable row",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started"), proposalFor("A1"), "{not json"]);
      try {
        const r = regenerateForestLedger(dir);
        return {
          ok: r.ok,
          error: r.error,
          skipped: (r.skipped || []).length,
          namesLine3: /line 3:/.test(r.reason || ""),
          namesProposalLine: /line 2:/.test(r.reason || ""),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: false, error: "event log has unreadable lines", skipped: 2, namesLine3: true, namesProposalLine: false },
  },
  {
    pair: "refuse-only-unreadable-skips",
    pole: "green",
    name: "a log whose only skip is a pending proposal RENDERS — a valid record is not an unreadable line",
    reds_under:
      "regenerateForestLedger(): refuse on `folded.skipped.length > 0` again — the bare-count refusal that failed the shipped ledger",
    run: () => {
      const dir = repoWith([genesis("A1", "Not started"), proposalFor("A1")]);
      try {
        const r = regenerateForestLedger(dir);
        return { ok: r.ok, rows: r.rows, skipped: (r.skipped || []).length, wrote: ledgerExists(dir) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    expect: { ok: true, rows: 1, skipped: 1, wrote: true },
  },
];

// ── run: Class A (hermetic pole pairs) ───────────────────────────────────────

function eq(got, expect) {
  if (expect === null || typeof expect !== "object") return JSON.stringify(got) === JSON.stringify(expect);
  if (got === null || typeof got !== "object") return false;
  for (const [k, v] of Object.entries(expect)) {
    if (JSON.stringify(got[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

let failures = 0;
const verdicts = new Map();

for (const c of CASES) {
  let got;
  try {
    got = c.run();
  } catch (err) {
    got = { threw: (err && err.message) || String(err) };
  }
  const ok = eq(got, c.expect);
  if (!verdicts.has(c.pair)) verdicts.set(c.pair, new Map());
  verdicts.get(c.pair).set(c.pole, JSON.stringify(got));
  if (ok) {
    console.log(`PASS  [${c.pair}/${c.pole}] ${c.name}`);
  } else {
    failures++;
    console.log(
      `FAIL  [${c.pair}/${c.pole}] ${c.name}\n      expected ${JSON.stringify(c.expect)}\n      got      ${JSON.stringify(got)}`,
    );
  }
}

// ── Class A2: bipolarity itself is asserted, not assumed ─────────────────────
// `instrument-bipolarity.md` MUST-2 — two poles that reach the SAME verdict are
// asserting nothing about the predicate between them, however green they look.
for (const [pair, poles] of verdicts) {
  if (poles.size !== 2) {
    failures++;
    console.log(`FAIL  [${pair}] not bipolar — poles present: ${[...poles.keys()].join(", ")}`);
    continue;
  }
  if (poles.get("red") === poles.get("green")) {
    failures++;
    console.log(
      `FAIL  [${pair}] poles AGREE (${poles.get("red")}) — the pair discriminates nothing`,
    );
  } else {
    console.log(`PASS  [${pair}] bipolar — poles reach different verdicts`);
  }
}

// ── Class B: the SHIPPED projection is in sync with the SHIPPED log ──────────
// The one deliberately non-hermetic case, and the reason it earns that: this is
// the standing detector for the C3 failure — a hand-edit, or a merge that
// fabricated a table belonging to neither branch's fold, reds HERE and nowhere
// else. If this reds, run `node .claude/bin/forest-ledger-project.mjs`
// and inspect the diff BEFORE committing it: an `extra_in_file` id is work that
// exists in no event and would be silently dropped.
{
  const r = regenerateForestLedger(REPO_ROOT, { check: true });
  if (r.ok && r.in_sync) {
    console.log(`PASS  [shipped-projection] in sync with the log (${r.rows} rows, ${r.lines} lines)`);
  } else {
    failures++;
    console.log(
      `FAIL  [shipped-projection] ${r.ok ? "DRIFT" : r.error}: ${
        r.ok ? JSON.stringify(r.drift) : r.reason
      }`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ARM — THE DECLARED NARROWING (loom s67, finding S66-1)
// ═══════════════════════════════════════════════════════════════════════════
//
// The ceiling refusal names two sanctioned remedies and only one was built, so an
// operator following the message could not take the route it recommended. These
// cases pin the two properties that make a narrowing safe rather than a silent
// truncation. Both are measured through `regenerateForestLedger` on a real repo,
// not through the resolver in isolation, because the failure they guard against
// is end-to-end: a projection that renders fewer rows than the log holds and does
// not say so.
{
  const mkNarrowRepo = (declaration) => {
    // Uses this suite's OWN `genesis`/`transition` helpers rather than hand-rolled
    // envelopes: they route through `buildEvent`, which is what makes a line pass
    // `validateRecord`. A hand-rolled line skips the fold as malformed and every
    // case below would then measure the malformed-line refusal instead of the
    // narrowing — a fixture passing for an unrelated reason.
    //
    // `reg-1` is genesised AND later transitioned; `todo-x` is transition-only.
    // That first item is the whole point: it separates "ever genesised" from
    // "the winning event's kind".
    const dir = repoWith([
      genesis("reg-1", "see burndown"),
      transition("reg-1", "todo:active"),
      transition("todo-x", "todo:completed"),
    ]);
    const manifest = { tracker: { path: EVENTS_REL, kind: "event-log", min_rows: 1, max_rows: 50 } };
    if (declaration) manifest.tracker.narrowing = declaration;
    writeFileSync(join(dir, "burndown-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    commitAll(dir, "narrowing fixture baseline");
    return dir;
  };

  const narrowCases = [
    {
      name: "a register item that LATER receives a transition STILL renders",
      why: "membership is 'ever carried a genesis', not the winning event's kind — keying on the winner would evict a register row the moment real work touched it, with no diff",
      reds_under: "_walk(): record registerIds from the WINNING event's kind instead of from every genesis",
      run: () => {
        const dir = mkNarrowRepo({ render_kinds: ["genesis"], reason: "register only" });
        try {
          const r = regenerateForestLedger(dir, {});
          if (!r.ok) return `refused: ${r.reason}`;
          const body = readFileSync(join(dir, SHARED_LEDGER_NAME), "utf8");
          if (!body.includes("reg-1")) return "reg-1 was EVICTED by its own later transition";
          if (body.includes("todo-x")) return "todo-x rendered, but it is not a register item";
          if (!/NARROWED: this projection renders 1 of 2 folded row\(s\)/.test(body)) {
            return "the narrowing is not STATED in the artifact — a narrowed page must not read as complete";
          }
          return "ok";
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      expect: "ok",
    },
    {
      name: "an UNCOMMITTED declaration is not honoured — it renders EVERYTHING",
      why: "fail-closed here means render all: a narrowing that cannot be verified must never silently shrink the projection",
      reds_under: "_resolveProjectionNarrowing(): honour the manifest without the guarded (committed + unmodified) read",
      run: () => {
        const dir = mkNarrowRepo(null);
        try {
          // Add the declaration WITHOUT committing it.
          const m = JSON.parse(readFileSync(join(dir, "burndown-manifest.json"), "utf8"));
          m.tracker.narrowing = { render_kinds: ["genesis"], reason: "register only" };
          writeFileSync(join(dir, "burndown-manifest.json"), JSON.stringify(m, null, 2) + "\n");
          const r = regenerateForestLedger(dir, {});
          if (!r.ok) return `refused: ${r.reason}`;
          const body = readFileSync(join(dir, SHARED_LEDGER_NAME), "utf8");
          if (!body.includes("todo-x")) return "the UNCOMMITTED declaration narrowed the projection";
          if (/NARROWED/.test(body)) return "the artifact claims a narrowing that was not honoured";
          return "ok";
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      expect: "ok",
    },
    {
      name: "an unknown render_kind renders EVERYTHING rather than narrowing to a typo's set",
      why: "a kind outside the schema's closed set would match nothing; honouring it would narrow to zero rows while reporting a clean declaration",
      reds_under: "_resolveProjectionNarrowing(): drop the KINDS membership check",
      run: () => {
        const dir = mkNarrowRepo({ render_kinds: ["genesiss"], reason: "typo" });
        try {
          const r = regenerateForestLedger(dir, {});
          if (!r.ok) return `refused: ${r.reason}`;
          const body = readFileSync(join(dir, SHARED_LEDGER_NAME), "utf8");
          if (!body.includes("todo-x") || !body.includes("reg-1")) return "a typo'd kind narrowed the projection";
          return "ok";
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      expect: "ok",
    },
    {
      name: "a declaration with no reason renders EVERYTHING",
      why: "a narrowing with no stated reason is not auditable, and the artifact would have nothing to print",
      reds_under: "_resolveProjectionNarrowing(): make `reason` optional",
      run: () => {
        const dir = mkNarrowRepo({ render_kinds: ["genesis"] });
        try {
          const r = regenerateForestLedger(dir, {});
          if (!r.ok) return `refused: ${r.reason}`;
          const body = readFileSync(join(dir, SHARED_LEDGER_NAME), "utf8");
          return body.includes("todo-x") ? "ok" : "a reasonless declaration narrowed the projection";
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      expect: "ok",
    },
  ];

  for (const c of narrowCases) {
    let got;
    try {
      got = c.run();
    } catch (e) {
      got = `threw: ${(e && e.message) || String(e)}`;
    }
    if (got === c.expect) {
      console.log(`PASS  [narrowing] ${c.name}`);
    } else {
      failures++;
      console.log(`FAIL  [narrowing] ${c.name}\n        ${got}\n        reds under: ${c.reds_under}`);
    }
  }
}

console.log(`\n${failures === 0 ? "all" : `${failures} FAILED —`} projection fixtures (${CASES.length} poles, ${verdicts.size} pairs + bipolarity + shipped-projection + narrowing)`);
process.exit(failures === 0 ? 0 : 1);
