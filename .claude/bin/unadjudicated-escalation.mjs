#!/usr/bin/env node
/**
 * unadjudicated-escalation — the detector for `sweep-completeness.md` MUST-4.
 *
 * ONE question:
 *
 *     "Has any step emitted the SAME unadjudicated verdict on 3 consecutive
 *      runs, with nothing recorded that adjudicates it?"
 *
 * WHY THIS EXISTS (loom#1722)
 * ───────────────────────────
 * `/sweep`'s Sweep 5 emitted `manual-supplement-required` for FIVE consecutive
 * sessions. Every one of those emissions was HONEST — Sweep 5 in
 * repo-level-specs mode is blocked from the orchestration-mode N/A sentinel and
 * loom has no equivalent check, so the row correctly refused to claim clean.
 * That is exactly what made it invisible. It occupied a slot in every report,
 * read as coverage, and answered nothing.
 *
 * `instrument-discipline.md` MUST-1 already says a check that cannot
 * discriminate is not evidence. The gap it leaves is the one this tool closes:
 * a check that NEVER discriminates is never ESCALATED. It just keeps printing.
 *
 * WHY THE STATE LIVES IN THE REPORTS, NOT IN A LEDGER
 * ──────────────────────────────────────────────────
 * Repetition is only detectable with state carried across sessions, and there
 * were two candidates. A private counter file was rejected: a counter is a
 * SECOND thing that can be wrong, it drifts from the reports silently, and —
 * decisively — a session that finds an inconvenient count can reset it with one
 * write and nothing downstream can tell. `completion-criterion.md` names that
 * exact move (a counter reset on an observation) as a failure.
 *
 * The committed sweep reports under `workspaces/*<no-slash>/04-validate/` and the
 * root `SWEEP-*.md` are the DURABLE RECEIPTS of what each run actually emitted.
 * The streak is therefore a MEASUREMENT over ground truth, recomputed from
 * scratch on every invocation, with no stored number to tamper with. Deleting a
 * report to shorten a streak is a visible deletion in the diff; editing one is a
 * visible edit. That asymmetry is the whole reason for the choice.
 *
 * THRESHOLD = 3, AND WHY IT IS NOT TUNABLE
 * ────────────────────────────────────────
 * The 1st emission is the honest labeling `sweep-completeness.md` MUST-2
 * MANDATES; the 2nd can be a fix genuinely in flight. By the 3rd the placeholder
 * has survived two intervening chances to change and is demonstrably stable, not
 * transient. 3 is also the corpus's existing "pattern, not incident" constant
 * (`trust-posture.md` MUST-4's 3x-same-rule-in-30d window), so the number is
 * INHERITED rather than invented.
 *
 * There is deliberately NO `--threshold` flag. A gate whose severity the gated
 * party can raise is not a gate; the one dodge this tool must not offer is
 * `--threshold 99`.
 *
 * THE STREAK KEY IS THE VERDICT, NEVER THE SECTION LABEL
 * ──────────────────────────────────────────────────────
 * The key is the VERDICT TOKEN alone. Step attribution (`Sweep 5`) is carried
 * as REPORTING METADATA on every hit and never enters the key.
 *
 * This is the fix for a defect the first cut shipped with. The key was
 * `<step>/<verdict>`, where the step came from a `Sweep N` token that had to
 * appear on the SAME LINE as the verdict. That made the streak sensitive to
 * report FORMATTING: a row rendered `- **[MED]** \`manual-supplement-required\``
 * instead of `- **[MED][Sweep 5] \`manual-supplement-required\``  minted a NEW
 * key (`unattributed/…`) and silently zeroed the old one. Nothing was
 * adjudicated; the label moved.
 *
 * That was not hypothetical. It had ALREADY happened in this repo: measured
 * 2026-08-16 against the committed reports, `Sweep 5/manual-supplement-required`
 * stood at a streak of 0 across eight emissions spanning five reports, because
 * the newest run rendered the row without a `Sweep N` token. The escalation this
 * tool exists to raise was, at that moment, not raised for that verdict.
 *
 * It also handed the gated party a silent dodge — drop the section label once
 * every third run and the threshold is never reached — which is the same
 * standing-exemption move MUST-4 was written to close, re-entering through the
 * instrument instead of through the report.
 *
 * ONE NORMALIZER OWNS THE KEY. `normalizeVerdictKey` is applied on BOTH sides,
 * emission and disposition, so the two can never drift into different grammars.
 * A legacy `<step>/<verdict>` disposition key still resolves — the step prefix
 * was always incidental to what the sentinel names — so sentinels already
 * committed keep working. The consequence is stated rather than hidden: a
 * disposition is VERDICT-scoped, so it suppresses that verdict wherever it is
 * emitted, not only under the step that happened to emit it first.
 *
 * The invariant is PINNED IN THE SELF-CHECK (§ TWO FENCES (a)): the same verdict
 * with and without a step label must produce ONE key. If a later edit makes the
 * key section-sensitive again, the tool exits 2 and reports nothing rather than
 * quietly resuming the split-key behaviour.
 *
 * A DISPOSITION SUPPRESSES, IT NEVER RESETS
 * ─────────────────────────────────────────
 * The escape from escalation is not silence, it is a dated, attributed record:
 *
 *   <!-- unadjudicated-disposition:v1 key="manual-supplement-required"
 *        issue=1722 owner=<handle> until=2026-09-30 -->
 *
 * All four fields are REQUIRED; an incomplete sentinel is not a disposition and
 * is reported as malformed rather than honoured. It suppresses escalation while
 * `until` is in the future — the count keeps climbing underneath, so the day
 * `until` passes the escalation returns on its own with no counter having been
 * cleared. A permanent exemption is therefore not expressible; only a dated one
 * that a human must renew in the open is.
 *
 * TWO FENCES AGAINST A VACUOUS GREEN (instrument-discipline.md MUST-1/MUST-3)
 * ──────────────────────────────────────────────────────────────────────────
 *   (a) SELF-CHECK FIRST. Before reading the repo at all, the extractor is
 *       fired at pinned known-answer samples in BOTH polarities. If it fails to
 *       find the verdict in the positive sample, or finds one in the negative,
 *       the tool exits 2 and reports nothing. A matcher that cannot emit its
 *       falsifying result here has no business printing a verdict here.
 *   (b) NO SILENT ZERO. Scanning zero reports is reported as `reports=0` with an
 *       explicit note, never as a clean bill. So is a report whose basename
 *       carries no date (it cannot be ordered, so it is surfaced, not dropped),
 *       and so is a malformed disposition sentinel.
 *
 * The output prints every HIT with `path:line` rather than a tally
 * (`instrument-discipline.md` MUST-3(b)), so an over-match is visible to the
 * reader instead of silently inflating a streak.
 *
 * KNOWN BOUND, stated rather than implied: the grammar below is LEXICAL. It
 * recognises the verdict vocabulary this corpus actually emits; a run that
 * invents new wording for "I could not adjudicate this" is not seen. That bound
 * is why MUST-4's enforcement is `halt-and-report` at gate-review and only
 * `advisory` at the hook layer — this tool is the cheap structural half, not the
 * whole gate.
 *
 * USAGE
 *   node .claude/bin/unadjudicated-escalation.mjs
 *   node .claude/bin/unadjudicated-escalation.mjs --json
 *   node .claude/bin/unadjudicated-escalation.mjs --root <dir>   # fixture repos
 *   node .claude/bin/unadjudicated-escalation.mjs --today 2026-08-16
 *
 * EXIT CODES
 *   0 = no verdict stands at or past the threshold without a live disposition.
 *   1 = at least one ESCALATION IS OWED (or a malformed disposition was found).
 *   2 = bad arguments, or the self-check failed (the tool refuses to report).
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

// The threshold. Deliberately a constant and not a flag — see § THRESHOLD.
export const THRESHOLD = 3;

// ── the verdict grammar ─────────────────────────────────────────────────────
// The vocabulary this corpus emits for "this step could not be adjudicated
// here".
export const UNADJUDICATED_VERDICTS = Object.freeze([
  "manual-supplement-required",
  "unadjudicated",
  "cannot-adjudicate",
  "adjudication-blocked",
  "na-blocked",
]);

const VERDICT_ALT = UNADJUDICATED_VERDICTS.join("|");

// A line EMITS a verdict when the token appears either
//   (a) as a VALUE — inside backticks, which is how every real emission in this
//       corpus renders it (`- **[MED][Sweep 5] \`manual-supplement-required\`**`,
//       `**Sweep 5 (spec-vs-source).** \`manual-supplement-required\``,
//       `| … Finding: \`manual-supplement-required\` |`), or
//   (b) under an explicit finding TAG — a `[Sweep N]` bracket or a leading
//       `FINDING`, which is the shape `skills/sweep/SKILL.md` § 6b prints.
//
// The value/tag requirement is what separates an EMISSION from PROSE ABOUT one.
// It was derived by reading the real rows, not assumed: a first cut requiring a
// `[Sweep N]` bracket matched 3 of the 5 reports actually carrying the verdict
// and reported a streak of 0 — a non-discriminating instrument in this rule's
// own sense. The sentence "Sweep 5 ran clean; nothing was left unadjudicated"
// is deliberately NOT a hit, and is pinned as a negative control below.
const VERDICT_VALUE_RE = new RegExp("`\\s*(" + VERDICT_ALT + ")\\s*`", "i");
const VERDICT_TAGGED_RE = new RegExp(
  "(?:\\[\\s*sweep\\s*[0-9]|^\\s*FINDING\\b).*?\\b(" + VERDICT_ALT + ")\\b",
  "i",
);

// Step attribution. Matches both `[Sweep 5]` and bare `Sweep 5`; the `\s*#?\s*`
// separator deliberately excludes `sweep-2026-08-14`, so a filename mentioned in
// prose never attributes a verdict to a step.
//
// REPORTING ONLY. This never enters the streak key — see § THE STREAK KEY IS THE
// VERDICT. It tells a reader WHERE the verdict was emitted; it does not decide
// WHETHER two emissions are the same thing.
const STEP_RE = /\bsweep\s*#?\s*([0-9]+[a-z]?)\b/i;

/**
 * The ONE key grammar, applied on both sides (emission and disposition) so the
 * two cannot drift apart.
 *
 * The key is the verdict token, lowercased. A LEGACY `<step>/<verdict>`
 * disposition key is accepted and normalized to its verdict: the step prefix was
 * always incidental to what the sentinel names, so sentinels already committed
 * against the old grammar keep resolving.
 */
export function normalizeVerdictKey(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  return slash === -1 ? s : s.slice(slash + 1).trim();
}

// A disposition sentinel. All four attributes are required; a sentinel missing
// any of them is MALFORMED and is never honoured.
const DISPOSITION_RE = /<!--\s*unadjudicated-disposition:v1\s+([^>]*?)-->/gi;
const ISO_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

// ── self-check samples (the known-answer control) ───────────────────────────
// Every POSITIVE line below is a REAL row shape lifted from this repo's own
// committed sweep reports, not an idealized one. That distinction is the point:
// the first version of this matcher passed a self-check built from invented
// samples and still could not see 2 of the 5 reports carrying the verdict.
const SAMPLE_POSITIVE = [
  "## Findings",
  "- [MED][Sweep 4] two remote branches without PRs — Disposition: reap next cycle",
  "- **[MED][Sweep 5] `manual-supplement-required`** — `spec_count=0` AND `specs/` EXISTS, so this",
  "- **Sweep 5 (spec-vs-source).** `manual-supplement-required` — see D2. NOT clean, NOT N/A.",
  "FINDING [Sweep 5] manual-supplement-required — spec authority is at specs/;",
  "| 5 specs | REPO-LEVEL mode — sentinel deliberately NOT emitted. Finding: `manual-supplement-required` |",
].join("\n");

// Every NEGATIVE line is a shape that MUST NOT be counted: a clean row, a
// structural sentinel, prose discussing the verdict rather than emitting it,
// and a filename that contains the word "sweep".
const SAMPLE_NEGATIVE = [
  "## Findings",
  "- [LOW][Sweep 4] one stale draft PR — Disposition: FIXED inline (commit `8e67ad3`)",
  "<!-- sweep-redteam:v1:N/A reason=orchestration-mode no_specs=true no_tool=true -->",
  "Sweep 5 ran clean against the repo-level tree; nothing was left unadjudicated.",
  "Compared against workspaces/x/04-validate/sweep-2026-08-13.md from the prior cycle.",
].join("\n");

// ── extraction ──────────────────────────────────────────────────────────────

/**
 * Pull every unadjudicated verdict row out of one report's text.
 * Fenced code regions are skipped so a report QUOTING an example row does not
 * manufacture a streak; the count of skipped fenced hits is returned so the
 * skip is visible rather than silent.
 */
export function extractVerdicts(text) {
  const hits = [];
  let fencedSkipped = 0;
  let inFence = false;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const verdict = VERDICT_VALUE_RE.exec(line) || VERDICT_TAGGED_RE.exec(line);
    if (!verdict) continue;
    if (inFence) {
      fencedSkipped++;
      continue;
    }
    const step = STEP_RE.exec(line);
    // Attribution is REPORTING metadata and is deliberately NOT part of the key
    // (§ THE STREAK KEY IS THE VERDICT). A verdict this grammar cannot attribute
    // to a step counts identically to one it can — that is the whole point: a
    // formatting change must not be able to mint a new key or zero an old one.
    hits.push({
      key: normalizeVerdictKey(verdict[1]),
      step: step ? `Sweep ${step[1].toLowerCase()}` : "unattributed",
      line: i + 1,
      text: line.trim(),
    });
  }
  return { hits, fencedSkipped };
}

/** Parse every disposition sentinel out of one report's text. */
export function extractDispositions(text) {
  const live = [];
  const malformed = [];
  DISPOSITION_RE.lastIndex = 0;
  let m;
  while ((m = DISPOSITION_RE.exec(String(text))) !== null) {
    const raw = m[1];
    const attrs = {};
    const attrRe = /([a-z_]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"']+))/gi;
    let a;
    while ((a = attrRe.exec(raw)) !== null) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? "";
    }
    const missing = ["key", "issue", "owner", "until"].filter((k) => !attrs[k]);
    if (missing.length > 0 || !ISO_DATE_RE.test(attrs.until || "")) {
      malformed.push({
        raw: m[0].trim(),
        missing: missing.length > 0 ? missing : ["until (not an ISO date)"],
      });
      continue;
    }
    // Normalized through the SAME function the emission side uses, so a legacy
    // `<step>/<verdict>` sentinel still resolves and the two grammars cannot
    // drift. `key_raw` is retained so the report can echo what was written.
    live.push({
      key: normalizeVerdictKey(attrs.key),
      key_raw: attrs.key,
      issue: attrs.issue,
      owner: attrs.owner,
      until: attrs.until,
    });
  }
  return { live, malformed };
}

// ── report discovery + ordering ─────────────────────────────────────────────

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every committed sweep report, oldest first.
 *
 * ORDERING is by the ISO date in the BASENAME, tiebroken by the basename
 * itself, so `sweep-2026-08-13b.md` sorts after `sweep-2026-08-13.md` — two
 * runs on one day are two runs. A report whose basename carries no date cannot
 * be placed in the sequence; it is returned as `undated` and SURFACED, never
 * silently dropped.
 */
export function discoverReports(root) {
  const found = [];
  const undated = [];

  const consider = (abs) => {
    const base = basename(abs);
    const d = ISO_DATE_RE.exec(base);
    const rel = relative(root, abs);
    if (!d) {
      undated.push(rel);
      return;
    }
    found.push({ path: abs, rel, date: d[1], base });
  };

  const wsDir = join(root, "workspaces");
  for (const ws of safeReadDir(wsDir)) {
    if (!ws.isDirectory()) continue;
    const validate = join(wsDir, ws.name, "04-validate");
    for (const f of safeReadDir(validate)) {
      if (!f.isFile()) continue;
      if (!/^sweep.*\.md$/i.test(f.name)) continue;
      consider(join(validate, f.name));
    }
  }

  for (const f of safeReadDir(root)) {
    if (!f.isFile()) continue;
    if (!/^SWEEP.*\.md$/.test(f.name)) continue;
    consider(join(root, f.name));
  }

  found.sort((a, b) => (a.date === b.date ? a.base.localeCompare(b.base) : a.date.localeCompare(b.date)));
  return { reports: found, undated };
}

// ── the measurement ─────────────────────────────────────────────────────────

/**
 * Consecutive-run streak per verdict key, counted BACKWARDS from the most
 * recent run and stopping at the first run that did not carry the key.
 *
 * Counting backwards is load-bearing: what MUST-4 governs is a verdict that is
 * STILL repeating, not one that repeated three times last quarter and was then
 * fixed. A key absent from the newest run has a streak of 0.
 *
 * The only thing that breaks a streak is the newest run NOT EMITTING THE VERDICT
 * — the report saying something different, which is a visible edit. Re-labelling
 * the section it sits under cannot break it, because the label is not in the key.
 */
export function computeStreaks(runs) {
  const keys = new Set();
  for (const r of runs) for (const k of r.keys) keys.add(k);

  const out = [];
  for (const key of [...keys].sort()) {
    let streak = 0;
    const window = [];
    const steps = new Set();
    for (let i = runs.length - 1; i >= 0; i--) {
      if (!runs[i].keys.has(key)) break;
      streak++;
      window.unshift(runs[i]);
      for (const s of runs[i].stepsByKey?.get(key) ?? []) steps.add(s);
    }
    // Attribution is reported, not keyed. More than one entry here is exactly
    // the case that used to split into separate keys and reset the count.
    out.push({ key, streak, window, steps: [...steps].sort() });
  }
  return out;
}

function selfCheck() {
  const failures = [];

  const pos = extractVerdicts(SAMPLE_POSITIVE);
  const posKeys = pos.hits.map((h) => h.key);
  const wantKeys = [
    "manual-supplement-required",
    "manual-supplement-required",
    "manual-supplement-required",
    "manual-supplement-required",
  ];
  if (JSON.stringify(posKeys) !== JSON.stringify(wantKeys)) {
    failures.push(
      `positive control: expected ${JSON.stringify(wantKeys)}, got ${JSON.stringify(posKeys)}`,
    );
  }

  // Attribution still reaches the REPORT even though it left the key — the
  // positive sample carries three labelled rows and one unlabelled one.
  const posSteps = pos.hits.map((h) => h.step);
  const wantSteps = ["Sweep 5", "Sweep 5", "Sweep 5", "unattributed"];
  if (JSON.stringify(posSteps) !== JSON.stringify(wantSteps)) {
    failures.push(
      `attribution control: expected ${JSON.stringify(wantSteps)}, got ${JSON.stringify(posSteps)}`,
    );
  }

  // KEY-STABILITY CONTROL — the regression fence for the defect this tool
  // shipped with (§ THE STREAK KEY IS THE VERDICT). The SAME verdict, once with
  // a step label and once without, MUST produce ONE key. If an edit ever makes
  // the key section-sensitive again, the tool refuses to report rather than
  // silently resuming the split-key behaviour that zeroed a live streak.
  const labelled = extractVerdicts(
    "- **[MED][Sweep 5] `manual-supplement-required`** — spec_count=0 and specs/ exists.",
  );
  const unlabelled = extractVerdicts(
    "- **[MED]** `manual-supplement-required` — spec_count=0 and specs/ exists.",
  );
  if (labelled.hits.length !== 1 || unlabelled.hits.length !== 1) {
    failures.push(
      "key-stability control: expected exactly 1 hit from each polarity, got " +
        `${labelled.hits.length} labelled / ${unlabelled.hits.length} unlabelled`,
    );
  } else if (labelled.hits[0].key !== unlabelled.hits[0].key) {
    failures.push(
      "key-stability control: a section label changed the streak key " +
        `(${JSON.stringify(labelled.hits[0].key)} vs ${JSON.stringify(unlabelled.hits[0].key)}) — ` +
        "dropping a label would reset a live streak",
    );
  }

  // A LEGACY `<step>/<verdict>` disposition key must still resolve to the
  // verdict, so sentinels committed against the old grammar keep suppressing.
  if (normalizeVerdictKey("Sweep 5/manual-supplement-required") !== "manual-supplement-required") {
    failures.push("legacy-key control: a `<step>/<verdict>` disposition key no longer normalizes");
  }

  const neg = extractVerdicts(SAMPLE_NEGATIVE);
  if (neg.hits.length !== 0) {
    failures.push(`negative control: expected 0 hits, got ${JSON.stringify(neg.hits.map((h) => h.key))}`);
  }

  const good = extractDispositions(
    '<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" issue=1722 owner=someone until=2026-09-30 -->',
  );
  if (good.live.length !== 1 || good.malformed.length !== 0) {
    failures.push("disposition control: a complete sentinel was not accepted");
  }

  const bad = extractDispositions(
    '<!-- unadjudicated-disposition:v1 key="Sweep 5/manual-supplement-required" owner=someone -->',
  );
  if (bad.live.length !== 0 || bad.malformed.length !== 1) {
    failures.push("disposition control: an incomplete sentinel was not rejected");
  }

  return failures;
}

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { json: false, root: DEFAULT_ROOT, today: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--root") opts.root = resolve(argv[++i] ?? "");
    else if (a === "--today") opts.today = argv[++i] ?? "";
    else return { error: `unknown argument: ${a}` };
  }
  if (opts.today != null && !ISO_DATE_RE.test(opts.today)) {
    return { error: `--today must be an ISO date (YYYY-MM-DD), got: ${opts.today}` };
  }
  return opts;
}

const HELP = `unadjudicated-escalation — sweep-completeness.md MUST-4 detector.

Escalates any step that emitted the SAME unadjudicated verdict on ${THRESHOLD}
consecutive runs with no live disposition. The streak is measured from the
COMMITTED sweep reports; there is no stored counter, and no --threshold flag.

  --json            machine-readable
  --root <dir>      repository root to scan (default: this checkout)
  --today <ISO>     evaluate disposition expiry as of this date
  --help

Exit: 0 nothing owed · 1 escalation owed · 2 bad args / self-check failed.
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    process.stderr.write(`unadjudicated-escalation: ${opts.error}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const selfCheckFailures = selfCheck();
  if (selfCheckFailures.length > 0) {
    process.stderr.write(
      "unadjudicated-escalation: SELF-CHECK FAILED — the matcher could not be shown to discriminate here, so no verdict is reported.\n" +
        selfCheckFailures.map((f) => `  - ${f}\n`).join(""),
    );
    return 2;
  }

  const root = opts.root;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`unadjudicated-escalation: --root does not resolve to a directory: ${root}\n`);
    return 2;
  }
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const { reports, undated } = discoverReports(root);

  const runs = [];
  const allHits = [];
  const malformedDispositions = [];
  const dispositionsByRun = [];
  let fencedSkipped = 0;

  for (const r of reports) {
    let text = "";
    try {
      text = readFileSync(r.path, "utf8");
    } catch {
      text = "";
    }
    const { hits, fencedSkipped: fs } = extractVerdicts(text);
    fencedSkipped += fs;
    const { live, malformed } = extractDispositions(text);
    for (const h of hits) allHits.push({ ...h, rel: r.rel });
    for (const m of malformed) malformedDispositions.push({ ...m, rel: r.rel });
    const stepsByKey = new Map();
    for (const h of hits) {
      if (!stepsByKey.has(h.key)) stepsByKey.set(h.key, new Set());
      stepsByKey.get(h.key).add(h.step);
    }
    runs.push({ rel: r.rel, date: r.date, keys: new Set(hits.map((h) => h.key)), stepsByKey });
    dispositionsByRun.push({ rel: r.rel, live });
  }

  const streaks = computeStreaks(runs);
  const findings = [];

  for (const s of streaks) {
    if (s.streak < THRESHOLD) continue;
    const windowRels = new Set(s.window.map((w) => w.rel));
    const covering = dispositionsByRun
      .filter((d) => windowRels.has(d.rel))
      .flatMap((d) => d.live.filter((l) => l.key === s.key).map((l) => ({ ...l, rel: d.rel })));
    const liveCovering = covering.filter((c) => c.until >= today);
    const expired = covering.filter((c) => c.until < today);
    findings.push({
      key: s.key,
      steps: s.steps,
      streak: s.streak,
      first_run: s.window[0]?.rel ?? null,
      last_run: s.window[s.window.length - 1]?.rel ?? null,
      escalation_owed: liveCovering.length === 0,
      suppressed_by: liveCovering[0] ?? null,
      expired_dispositions: expired,
    });
  }

  const owed = findings.filter((f) => f.escalation_owed);
  const suppressed = findings.filter((f) => !f.escalation_owed);
  const failed = owed.length > 0 || malformedDispositions.length > 0;

  const sentinel =
    `<!-- unadjudicated-escalation:v1 threshold=${THRESHOLD} runs=${runs.length} ` +
    `keys=${streaks.length} escalations=${owed.length} suppressed=${suppressed.length} -->`;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          threshold: THRESHOLD,
          today,
          runs_scanned: runs.length,
          runs: runs.map((r) => ({ rel: r.rel, date: r.date, keys: [...r.keys] })),
          undated_reports: undated,
          fenced_hits_skipped: fencedSkipped,
          hits: allHits,
          streaks: streaks.map((s) => ({ key: s.key, steps: s.steps, streak: s.streak })),
          findings,
          malformed_dispositions: malformedDispositions,
          escalations_owed: owed.length,
          sentinel,
          passed: !failed,
        },
        null,
        2,
      ) + "\n",
    );
    return failed ? 1 : 0;
  }

  const out = [];
  out.push(`unadjudicated-escalation — sweep-completeness.md MUST-4 (threshold ${THRESHOLD}, as of ${today})`);
  out.push("");
  out.push(`  reports scanned: ${runs.length}`);
  if (runs.length === 0) {
    out.push("  NOTE: zero sweep reports were found under this root. That is NOT a clean bill —");
    out.push("        the instrument had nothing to read. Confirm the root before reading this as 0.");
  }
  if (undated.length > 0) {
    out.push(`  undated reports (cannot be ordered, so NOT counted as runs): ${undated.length}`);
    for (const u of undated) out.push(`    - ${u}`);
  }
  if (fencedSkipped > 0) {
    out.push(`  fenced example rows skipped (quoted, not emitted): ${fencedSkipped}`);
  }
  out.push("");

  if (allHits.length === 0) {
    out.push("  no unadjudicated verdict rows found.");
  } else {
    out.push("  hits (read these, not the tally):");
    for (const h of allHits) out.push(`    ${h.rel}:${h.line}  ${h.key}  [${h.step}]`);
    out.push("");
    out.push("  streaks (consecutive runs, counted back from the most recent):");
    for (const s of streaks) {
      const flag = s.streak >= THRESHOLD ? "  <= AT/PAST THRESHOLD" : "";
      const attribution = s.steps.length > 0 ? `  (emitted under: ${s.steps.join(", ")})` : "";
      out.push(`    ${String(s.streak).padStart(3)} x  ${s.key}${attribution}${flag}`);
    }
  }
  out.push("");

  for (const f of suppressed) {
    out.push(
      `  SUPPRESSED  ${f.key} (${f.streak}x) — disposition issue=${f.suppressed_by.issue} ` +
        `owner=${f.suppressed_by.owner} until=${f.suppressed_by.until} in ${f.suppressed_by.rel}`,
    );
    out.push("              the count keeps climbing; escalation returns when `until` passes.");
  }
  for (const f of owed) {
    out.push(`  ESCALATION OWED  ${f.key} — ${f.streak} consecutive runs, no live disposition.`);
    out.push(`                   first ${f.first_run}`);
    out.push(`                   last  ${f.last_run}`);
    for (const e of f.expired_dispositions) {
      out.push(`                   EXPIRED disposition until=${e.until} (${e.rel}) — renew it or author the check.`);
    }
    out.push("                   Surface as a Decision Point: author the missing check, OR record");
    out.push('                   <!-- unadjudicated-disposition:v1 key="…" issue=N owner=… until=YYYY-MM-DD -->');
  }
  for (const m of malformedDispositions) {
    out.push(`  MALFORMED DISPOSITION  ${m.rel} — missing ${m.missing.join(", ")}`);
    out.push(`                         ${m.raw}`);
  }

  out.push("");
  out.push(failed ? `  x ${owed.length} escalation(s) owed, ${malformedDispositions.length} malformed disposition(s)` : "  ok nothing at or past threshold without a live disposition");
  out.push(sentinel);
  process.stdout.write(out.join("\n") + "\n");
  return failed ? 1 : 0;
}

// Entry-point guard. BOTH sides go through realpathSync, never the lexical
// string: on macOS a temp dir is reached as `/var/folders/…` while
// `import.meta.url` renders `/private/var/folders/…`, so a string comparison
// makes the module silently DECLINE to run and exit 0 — a false green from a
// tool that never executed (`security.md` § Path Containment, same class).
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  process.exit(main());
}
