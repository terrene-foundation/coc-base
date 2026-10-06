#!/usr/bin/env node
/**
 * burndown-trace-write-guard.js — the write-time enforcement surface of
 * `burndown-traceability.md`: the id → tracker-row → context-artifact chain.
 *
 * @hook-event: PostToolUse:Edit|Write|NotebookEdit (guard) — the write is the
 *   subject, and PostToolUse is the only event where the WRITTEN CONTENT exists
 *   on disk to be checked. A PreToolUse variant would inspect `tool_input`
 *   before the file lands; that works for Write but not for Edit (whose result
 *   is a merge), and the chain is a property of the TREE, not of one tool_input.
 *   The matcher is exactly the write-tool set — a `*` matcher would pay a node
 *   spawn on every Read/Grep to reach a passthrough, which
 *   `hook-event-selection.md` MUST-3 fails.
 *
 * ── TWO ARMS, DELIBERATELY SEPARATE ────────────────────────────────────────
 *
 * (1) STRUCTURAL — `block`, rule_id `burndown-traceability/MUST-1`.
 *     Fires when the write touched a chain surface AND
 *     `burndown-build.mjs --check-links` exited 2 with EITHER parseable
 *     `LINK-1|LINK-2|LINK-3` finding lines (a broken chain) OR a refusal
 *     carrying a bracketed LEDGER-INTEGRITY finding kind (a tampered event
 *     log). The second class did not exist when this guard was written, and
 *     for a while every one of its findings — a record whose signature does
 *     NOT verify, an append onto a CLOSED generation, a fork, a chain break —
 *     landed in the `unknown` bucket below and passed through as advisory,
 *     rendering a DETECTED FORGERY identically to a source being mid-edit.
 *     Those are opposite facts, which is the one thing the ladder at the foot
 *     of this header exists to prevent, so they are separated here.
 *
 *     WHY THIS ONE CAN BLOCK, stated so nobody downgrades it by reflex.
 *     `hook-output-discipline.md` MUST-2 reserves `block` for facts a regex
 *     cannot misread, and bars `block` on a LEXICAL signal. Nothing here is
 *     lexical. The VERDICT is computed by the generator out of deterministic
 *     facts — is there a ledger row with this id (a Map lookup over a parsed
 *     table), does `git ls-files` list the anchor path, does the anchor file's
 *     bytes contain the id, does this record's signature verify against the
 *     roster key bound to its `verified_id` — and this hook does not re-derive
 *     any of them. The regex below only LOCATES the finding lines the
 *     generator has ALREADY decided; it is the `journal-write-guard.js`
 *     `fs.existsSync` class that MUST-2 names as blockable, not the
 *     prose-scanning class it forbids. Surface rewrite cannot evade it either:
 *     rewording a ledger row does not make an absent journal file exist, and
 *     rewording a signed record changes the bytes the signature covers.
 *
 *     AND WHY ONLY SOME OF THE KINDS. `verification-unavailable`,
 *     `unrostered-signer` and `undeclared-generation` say the verifier could
 *     not REACH a verdict — no key, no resolver, a schema nothing declares.
 *     "Could not check" is the ladder's ASKED-AND-GOT-NO-ANSWER rung, not a
 *     detected forgery, so those stay advisory. A refusal carrying BOTH goes
 *     to the teeth: a verdict that WAS reached is not weakened by a sibling
 *     record whose verdict was not.
 *
 * (2) SEMANTIC — `advisory`, rule_id `burndown-traceability/MUST-2`.
 *     Whether an anchor points at the RIGHT ruling is a judgment no check can
 *     make. It is emitted ONLY as `additionalContext` on a passthrough
 *     (`continue: true`, exit 0) and NEVER through a blocking `instructAndWait`.
 *     Trigger: the write added or changed a `value_anchor` cell in the tracker
 *     and the structural arm did not fire — the link may resolve, but nobody
 *     has confirmed it is the right ruling.
 *
 *     REACHABILITY, MEASURED — and why the trigger is NOT the literal
 *     conjunction "chain INTACT AND an anchor changed". The generator holds the
 *     tracker to `assertCommittedAndUnmodified`. Measured on a scratch repo:
 *     editing one `value_anchor` cell to another VALID anchor makes
 *     `--check-links` exit 2 with
 *     "declared source '.session-notes.shared.md' has uncommitted modifications
 *     against HEAD" and ZERO `LINK-n` lines. So for the ONLY file that carries
 *     `value_anchor` cells, "an anchor just changed" and "the chain reports
 *     INTACT" are MUTUALLY EXCLUSIVE within one write. Shipping the literal
 *     conjunction would ship a clause that can never fire — a stub wearing the
 *     grammar of a feature (`zero-tolerance.md` Rule 2). The arm therefore
 *     fires on the anchor change and STATES the link status it actually
 *     observed (INTACT / NOT CHECKED / UNKNOWN), which is the fact the operator
 *     needs and the one the conjunction was reaching for.
 *
 * ── SCOPE: WHAT A GREEN HERE COVERS, AND WHAT IT EXCLUDES ──────────────────
 * (`evidence-first-claims.md` MUST-6 — a silent guard is not a clean chain.)
 *
 * COVERS: a write, through Edit/Write/NotebookEdit, to a chain surface — the
 * declared tracker, a `.session-notes*` path OTHER than a `.d/` fragment,
 * `burndown/**`, `burndown-manifest.json`, or a file under a declared
 * `anchor_root` — in a repo that has BOTH a `burndown-manifest.json` and the
 * generator.
 *
 * EXCLUDES, structurally and not fixably here:
 *   · `.session-notes.d/**` fragments, BY RULING rather than by structure —
 *     see `isChainSurface` for the reasoning and do not restore them.
 *   · every write that does NOT go through those tools. A Bash heredoc or `>`
 *     redirect writes the same file and this hook never sees it.
 *   · the tracker's own edits, for the STRUCTURAL arm. Writing the tracker
 *     dirties it, the generator refuses on the committed-and-unmodified gate
 *     before it reaches leg 1, and the honest report is UNKNOWN, not clean —
 *     which is exactly what this hook then says.
 *   · anything the generator itself cannot see. This hook adds no verdict of
 *     its own; it relays one.
 *
 * ── FAIL-OPEN LADDER (`cc-artifacts.md` Rule 7) ────────────────────────────
 * Two different unknowns, and they MUST NOT render identically:
 *   NOT IN SCOPE / CANNOT ASK  → fully SILENT. No manifest, unparseable
 *     manifest, no generator, non-chain surface, malformed stdin, path outside
 *     the project. Nothing is claimed in either direction and a repo without a
 *     burndown pays nothing.
 *   ASKED AND GOT NO ANSWER    → ADVISORY context saying the link status is
 *     UNKNOWN. An exit 2 carrying NO `LINK-n` lines AND no recognised
 *     integrity kind is a PRE-EXISTING generator refusal (a source mid-edit, a
 *     duplicate ledger row, an unparseable table), NOT a finding; likewise a
 *     spawn error, a timeout, or any other exit code. "Could not check" and
 *     "checked, clean" are opposite facts and rendering them the same is the
 *     whole failure this guard exists to avoid — and so is rendering "checked,
 *     and it is FORGED" as either of them, which is what arm (1) now catches.
 * Every `catch` below is one of these two by design, and each says which.
 */

"use strict";

const TIMEOUT_MS = 4000;
// The child gets strictly less than the outer net, so a hung generator resolves
// through the ADVISORY-UNKNOWN path rather than through the blind fallback.
const CHILD_TIMEOUT_MS = 3000;
let fallback = null;

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { readStdinBounded } = require("./lib/read-stdin-bounded.js");
// Every git a guard spawns routes through the helper: an ABSOLUTE binary plus an
// env built from CONSTANTS (`security.md` § Multi-Site Kwarg Plumbing). The env
// half is load-bearing here and not ceremony — it pins GIT_CONFIG_GLOBAL and
// GIT_CONFIG_SYSTEM to the null device, so this guard's `git show` cannot inherit
// an operator's `commit.gpgsign`, signing config, or aliases. Anything inherited
// would make the guard's verdict depend on whose machine it ran on.
const { resolveGitBinary, gitEnv } = require(
  path.join(__dirname, "lib", "git-subprocess-env.js"),
);

function passthrough(context) {
  if (fallback) clearTimeout(fallback);
  try {
    const out = { continue: true };
    if (context) {
      out.hookSpecificOutput = { hookEventName: "PostToolUse", additionalContext: context };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch {}
  process.exit(0);
}

const MANIFEST_BASENAME = "burndown-manifest.json";
const GENERATOR_REL = path.join(".claude", "bin", "burndown-build.mjs");

// Kept in step with `burndown-build.mjs::DEFAULT_ANCHOR_ROOTS`. Duplicated
// rather than imported ON PURPOSE: that file is an ESM script that RUNS
// `main()` at import time, so requiring it from a hook would execute a build.
const DEFAULT_ANCHOR_ROOTS = ["journal/", "workspaces/", "specs/", "todos/", "briefs/"];

// Cells that are decoration, not a pointer — same list the generator refuses on.
const NON_ANCHORS = new Set(["", "-", "—", "–", "n/a", "na", "tbd", "todo", "?", "none", "pending"]);

// The VERDICT predicate is deliberately BROADER than the extraction regex below.
// If an odd id defeats the field split, the write still blocks and the raw
// refusal is quoted — degrading the report, never the verdict.
const HAS_LINK_FINDING = /^[ \t]*LINK-[123][ \t]/m;
const LINK_FINDING_LINE = /^[ \t]*(LINK-[123])[ \t]+([^:]+):[ \t]*(.*)$/;

// ── the LEDGER-INTEGRITY refusal class ─────────────────────────────────────
//
// The signed-event-log gate does not speak in `LINK-n`. Its findings render as
// `  line 4: [bad-signature] …` — `burndown-build.mjs:1392|1415|1426` build that
// line from `{line, kind, why}` records that `hooks/lib/signed-log.js` produces.
// The shape is ANCHORED, not free-form bracket-hunting: only a line whose whole
// prefix is `line <n>: [<kind>]` counts, so a bracket appearing anywhere in the
// refusal's PROSE cannot mint a verdict.
const FINDING_KIND_LINE = /^[ \t]*line[ \t]+\d+:[ \t]*\[([a-z][a-z0-9-]*)\]/;

// DETECTED. The verifier reached a verdict and the verdict is that the log is
// not what its producer wrote — a signature that does not verify, an append onto
// a generation the manifest closed, one seq with two histories, a declared
// prev_hash that hashes to nothing here, a record with no attributable emitter,
// bytes that will not parse or hash. Each is computed by the generator out of
// deterministic facts, the same class as the LINK legs.
//
// `seq-gap` IS HERE ON A REACHABILITY ARGUMENT, NOT ON A DEMONSTRATION, and the
// difference is recorded so nobody later cites this line as evidence it was
// measured. What WAS measured: a committed middle-record deletion raises
// `[seq-gap]` and `[chain-break]` TOGETHER on the same line (probed against
// `verifyChain` with an intact 3-record control returning zero findings), so the
// flagship case already blocks through `chain-break` and `seq-gap` adds nothing
// there. What was NOT established is that a seq-gap-ALONE refusal is
// unreachable. An integrity finding whose unreachability is unproven does not
// get to sit on the advisory rung on the strength of that gap, so it defaults to
// teeth: if it is genuinely unreachable the arm simply never fires on it, which
// costs nothing, and if it is not, the fail-open was real. Ruled by the lane
// orchestrator on this guard's own residual.
const INTEGRITY_KINDS = new Set([
  "bad-signature",
  "closed-generation-append",
  "fork",
  "chain-break",
  "seq-gap",
  "unattributed",
  "missing-seq",
  "unhashable",
  "unparseable",
  "unsigned-or-unverifiable-record",
  "no-signer-fingerprint",
  "no-records",
  "unclassifiable",
]);

// INDETERMINATE — AND THIS SET IS INERT TODAY. READ THAT BEFORE EDITING IT.
//
// `classifyFindingKinds` below returns `{integrity, indeterminate}`, but its ONE
// call site — the `r.status === 2` arm of `checkLinks()` — destructures
// `{ integrity }` alone, and nothing in this file or any other reads the
// `.indeterminate` half. So membership HERE has zero behavioural effect: a kind
// named in this set and a kind nobody has ever heard of take the identical path.
// Neither is in `INTEGRITY_KINDS`, so the arm falls through to the `unknown`
// (advisory) return at the bottom of `checkLinks`, and that fall-through — not
// this list — is the whole mechanism by which a kind added upstream defaults to
// advisory instead of silently gaining teeth. `INTEGRITY_KINDS` is the sole LIVE
// list; an earlier note here credited this one with that property, which was
// true of the SYSTEM and false of the line it sat beside.
//
// SO: DO NOT REACH FOR THIS SET TO CHANGE A DISPOSITION. Moving a name OUT of it
// does not give that kind teeth, and adding one does not take teeth away. The
// only edit that moves a kind between the rungs is an edit to `INTEGRITY_KINDS`.
//
// It is kept, not deleted, because the disposition it records is CORRECT and is
// the reason these kinds are absent from the live list: the verifier could not
// RUN for the record — the key resolver threw, the signer is not on the roster,
// the generation is one nothing declares. Absence of a verdict is not a verdict,
// so blocking on them would make an unreachable roster look like a forgery.
// Written down, a reader auditing the taxonomy at the point of edit can tell "we
// considered these and they are advisory" from "nobody has looked at these yet",
// which are opposite facts about the same output; and this is the natural home
// for the second half of the split if the `indeterminate` return is ever wired to
// a report of its own. `signed-log.js::verifyLogSignatures` returns the last two
// with `indeterminate: true` explicitly, at the top of the function, BEFORE any
// record is examined: they mean the verifier was never configured (no suite
// policy, no key resolver), which is the purest form of "could not run".
const INDETERMINATE_KINDS = new Set([
  "verification-unavailable",
  "unrostered-signer",
  "undeclared-generation",
  "no-suite-policy",
  "no-key-resolver",
  // The signer named has no roster key of the type this generation is verified
  // with, so nothing could verify that record. A record fault, but not a forgery
  // — and reported per-line rather than as a batch outage.
  "signer-key-type-mismatch",
]);

/**
 * The bracketed finding kinds a refusal carries, split by what they mean.
 * @returns {{integrity: Array<{kind: string, why: string}>, indeterminate: string[]}}
 */
function classifyFindingKinds(err) {
  const integrity = [];
  const indeterminate = [];
  for (const line of err.split(/\r?\n/)) {
    const m = FINDING_KIND_LINE.exec(line);
    if (!m) continue;
    const kind = m[1];
    if (INTEGRITY_KINDS.has(kind)) integrity.push({ kind, why: line.trim() });
    else if (INDETERMINATE_KINDS.has(kind)) indeterminate.push(kind);
  }
  return { integrity, indeterminate };
}

function readManifest(projectDir) {
  // NOT IN SCOPE / CANNOT ASK on every failure — silent.
  try {
    const p = path.join(projectDir, MANIFEST_BASENAME);
    if (!fs.existsSync(p)) return null;
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : null;
  } catch {
    return null; // unparseable manifest ⇒ scope is uncomputable ⇒ silent
  }
}

function anchorRootsOf(manifest) {
  const t = manifest.tracker;
  if (!t || typeof t !== "object") return [];
  if (t.anchor_roots === undefined) return [...DEFAULT_ANCHOR_ROOTS];
  if (!Array.isArray(t.anchor_roots)) return [...DEFAULT_ANCHOR_ROOTS];
  const roots = t.anchor_roots.filter((r) => typeof r === "string" && r).map((r) => (r.endsWith("/") ? r : `${r}/`));
  return roots.length ? roots : [...DEFAULT_ANCHOR_ROOTS];
}

function trackerRelOf(manifest) {
  const t = manifest.tracker;
  if (!t || typeof t !== "object" || typeof t.path !== "string" || !t.path) return null;
  return t.path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Does this write touch the chain at all?
 *
 * ── `.session-notes.d/**` IS DELIBERATELY EXCLUDED. DO NOT "RESTORE" IT. ──
 *
 * The `.d/` fragment subtree is NOT a chain surface, and its absence here is a
 * ruling, not an oversight. A fragment participates in NO leg: the generator
 * refuses anchors into it BY NAME, because it is a MEMORY surface that
 * `/reconcile-notes` is entitled to prune — and pruning it is what removed the
 * context for fourteen of this register's ids already. So a finding surfaced on
 * a fragment write is ALWAYS about the tree and NEVER about the bytes just
 * written.
 *
 * That is the same crying-wolf shape `selfInflicted()` below exists to
 * suppress, and the precedent is deliberate: an advisory or a block that
 * restates a fact the write did not cause trains people to ignore the channel,
 * which is how a REAL finding then goes unread. Per-operator fragment writes
 * are frequent enough for that to happen quickly. The tracker itself
 * (`.session-notes.shared.md`) STAYS in scope — that one genuinely is a chain
 * surface — so the exclusion is the `.d/` subtree alone, not the
 * `.session-notes` prefix.
 *
 * Ruled 2026-08-21 by the lane orchestrator on this guard's own scope finding.
 */
function isChainSurface(rel, roots, trackerRel) {
  if (!rel) return false;
  const p = rel.replace(/\\/g, "/");
  // Checked FIRST, because TWO later branches would otherwise re-admit the
  // subtree and the ordering is the only thing that stops either. MEASURED, not
  // reasoned — each mutation below reds a different fixture pole:
  //   · the generic `.session-notes` prefix branch three lines down matches
  //     EVERY `.d/` fragment. Deleting this line, or moving it after that
  //     branch, reds both fragment poles.
  //   · the `anchor_roots` branch re-admits it in a deployment that declares
  //     `.session-notes.d/` as a durable root. Checking roots BEFORE this line
  //     reds the second fragment pole alone.
  if (/(^|\/)\.session-notes\.d\//.test(p)) return false;
  if (trackerRel && p === trackerRel) return true;
  if (p === MANIFEST_BASENAME || p.endsWith(`/${MANIFEST_BASENAME}`)) return true;
  if (/(^|\/)\.session-notes/.test(p)) return true;
  if (/(^|\/)burndown\//.test(p)) return true;
  return roots.some((r) => p.startsWith(r));
}

/** Run the generator's own chain check. Never throws — returns a verdict object. */
function checkLinks(projectDir) {
  const gen = path.join(projectDir, GENERATOR_REL);
  try {
    if (!fs.existsSync(gen)) return { kind: "no-generator" }; // CANNOT ASK ⇒ silent
  } catch {
    return { kind: "no-generator" };
  }
  let r;
  try {
    r = spawnSync(process.execPath, [gen, "--check-links"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // ASKED AND GOT NO ANSWER — deliberate fail-open, surfaced not swallowed.
    return { kind: "unknown", why: `the chain checker could not be run (${(e && e.message) || e})` };
  }
  const err = (r.stderr || "").toString();
  const out = (r.stdout || "").toString();
  if (r.error || r.status === null) {
    return {
      kind: "unknown",
      why: `the chain checker did not complete (${(r.error && r.error.message) || `killed by ${r.signal || "timeout"}`})`,
    };
  }
  if (r.status === 0) {
    // The generator distinguishes these two itself, and so does this hook: a
    // repo with no declared tracker has not been checked, it is not clean.
    if (/declares NO tracker/.test(out)) return { kind: "not-checked", banner: out.trim() };
    return { kind: "intact", banner: out.trim() };
  }
  if (r.status === 2 && HAS_LINK_FINDING.test(err)) {
    const findings = [];
    for (const line of err.split(/\r?\n/)) {
      const m = LINK_FINDING_LINE.exec(line);
      if (m) findings.push({ leg: m[1], id: m[2].trim(), why: m[3].trim() });
    }
    return { kind: "broken", findings, raw: err.trim() };
  }
  if (r.status === 2) {
    // Checked AFTER the LINK arm and never instead of it: the two refusal
    // families are emitted by different gates and a build stops at the first,
    // so a refusal carries one or the other, never both. Order therefore costs
    // nothing and keeps the LINK arm's behaviour byte-identical.
    //
    // An integrity kind WINS over any indeterminate kind in the same refusal.
    // The alternative — downgrade the whole refusal because one sibling record
    // could not be checked — would let a single unrostered signer launder every
    // forged record beside it, which is the failure this arm exists to close.
    const { integrity } = classifyFindingKinds(err);
    if (integrity.length > 0) return { kind: "ledger-integrity", findings: integrity, raw: err.trim() };
  }
  // Exit 2 with NO LINK lines and no recognised integrity kind is a PRE-EXISTING
  // refusal, not a finding — and any other exit code is an answer this hook
  // cannot read. Both are ASKED AND GOT NO ANSWER.
  const firstLine = (err.split(/\r?\n/).find((l) => l.trim()) || `exit ${r.status}`).trim();
  return { kind: "unknown", why: firstLine };
}

// ── the tracker's value_anchor diff (the semantic arm's own evidence) ───────
//
// A LENIENT re-implementation of the generator's header-name table read. It is
// deliberately NOT the generator's: that one REFUSES loudly on a malformed
// table because a build must not proceed on one, whereas this one must fail
// OPEN and simply decline to fire. Same discipline in the part that matters —
// columns are found BY HEADER NAME, never by position, so a ledger layout
// change cannot silently re-point this at the wrong column.

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

function stripDecoration(cell) {
  let s = (cell || "").trim();
  s = s.replace(/^\[([^\]]*)\]\([^)]*\)$/, "$1");
  s = s.replace(/^[*_`]+/, "").replace(/[*_`]+$/, "");
  return s.trim();
}

/** @returns {Map<string,string>|null} id → decoded anchor cell; null = unreadable. */
function parseAnchors(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  let headerAt = -1;
  let cols = null;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const lower = splitRow(lines[i]).map((c) => c.toLowerCase());
    if (!lower.includes("id")) continue;
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    headerAt = i;
    cols = lower;
    break;
  }
  if (headerAt === -1 || !cols.includes("value_anchor")) return null;
  const idAt = cols.indexOf("id");
  const anchorAt = cols.indexOf("value_anchor");
  const rows = new Map();
  for (let i = headerAt + 2; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) {
      if (lines[i].trim() === "") continue;
      break;
    }
    const cells = splitRow(lines[i]);
    if (cells.length <= Math.max(idAt, anchorAt)) continue;
    const id = stripDecoration(cells[idAt]);
    if (!id) continue;
    // A duplicate id makes the anchor for that id ambiguous — the generator
    // refuses on it, and a diff computed over an ambiguous table would name a
    // change nobody made. Decline rather than guess.
    if (rows.has(id)) return null;
    rows.set(id, stripDecoration(cells[anchorAt]));
  }
  return rows;
}

/** The HEAD image of `rel`, or "" when there is no committed image (a new file). */
function headImage(projectDir, rel) {
  try {
    const r = spawnSync(resolveGitBinary(), ["show", `HEAD:${rel}`], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    if (r.error || r.status !== 0) return ""; // no HEAD, or not in HEAD ⇒ all rows are new
    return (r.stdout || "").toString();
  } catch {
    return ""; // CANNOT ASK — treated as "no committed image", never as a change
  }
}

/** @returns {Array<{id,from,to,kind}>} anchor cells this write added or changed. */
function anchorChanges(projectDir, rel, text) {
  const next = parseAnchors(text);
  if (!next) return []; // unreadable ⇒ decline to fire (fail open)
  const prev = parseAnchors(headImage(projectDir, rel)) || new Map();
  const out = [];
  for (const [id, to] of next) {
    if (NON_ANCHORS.has(to.toLowerCase())) continue; // blanked/placeholder: nothing to adjudicate
    if (!prev.has(id)) out.push({ id, from: null, to, kind: "added" });
    else if (prev.get(id) !== to) out.push({ id, from: prev.get(id), to, kind: "changed" });
  }
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────

function linkStatusLine(verdict) {
  if (verdict.kind === "intact") return "LINK STATUS: INTACT — every burndown item resolves id → row → tracked context artifact.";
  if (verdict.kind === "not-checked") return "LINK STATUS: NOT CHECKED — the manifest declares no tracker, so no link was checked. That is an absent result, not a clean one.";
  return `LINK STATUS: UNKNOWN — the chain checker did not reach the legs: ${verdict.why}. This is NOT a clean result.`;
}

async function main() {
  let payload;
  try {
    payload = await readStdinBounded();
  } catch {
    return passthrough(null); // malformed stdin ⇒ CANNOT ASK ⇒ silent
  }
  const p = payload && typeof payload === "object" ? payload : {};

  const filePath = (p.tool_input && (p.tool_input.file_path || p.tool_input.notebook_path)) || "";
  if (!filePath) return passthrough(null);

  const rel = (path.isAbsolute(filePath) ? path.relative(PROJECT_DIR, filePath) : filePath).replace(/\\/g, "/");
  if (rel.startsWith("..")) return passthrough(null); // outside the project — not ours

  const manifest = readManifest(PROJECT_DIR);
  if (!manifest) return passthrough(null); // no burndown here ⇒ pay nothing, say nothing

  const roots = anchorRootsOf(manifest);
  const trackerRel = trackerRelOf(manifest);
  if (!isChainSurface(rel, roots, trackerRel)) return passthrough(null);

  const verdict = checkLinks(PROJECT_DIR);
  if (verdict.kind === "no-generator") return passthrough(null); // CANNOT ASK ⇒ silent

  // ── ARM (1) STRUCTURAL — block ───────────────────────────────────────────
  // Two refusal families, ONE disposition. Both are verdicts the generator
  // reached out of deterministic facts, so both get the teeth; only the report
  // differs, because "this id has no ledger row" and "this record's signature
  // does not verify" are not the same instruction to the reader.
  if (verdict.kind === "broken" || verdict.kind === "ledger-integrity") {
    const shown = verdict.findings.slice(0, 5);

    // `no-signer-fingerprint` KEEPS ITS TEETH AND LOSES THE ACCUSATION.
    //
    // It is the one kind on the integrity rung that is not a claim about the
    // record. `signed-log.js` raises it in two places and both mean the verifier
    // never reached the bytes: the resolver returned key material with no
    // `fingerprint`, or one shorter than the floor — and a value too short to
    // name one key gives the identity bind nothing to compare the signing key
    // against, so the signature is never actually put to the test. Either way
    // the roster is what is broken.
    //
    // The shared wording said the verifier RAN and told the reader not to
    // re-emit or re-sign. Both are wrong here and wrong in a costly direction:
    // they point an operator at a record that was never accused while the roster
    // entry that actually failed goes unedited. The floor widening this kind to
    // fire on a PRESENT-but-too-short fingerprint made that misdirection reach
    // cases it did not reach before, which is why it is split out rather than
    // left to the reader to notice. The rung does not move — an unbindable
    // signer identity is still a reason to stop.
    const rosterFindings =
      verdict.kind === "ledger-integrity" ? verdict.findings.filter((f) => f.kind === "no-signer-fingerprint") : [];
    const rosterOnly = rosterFindings.length > 0 && rosterFindings.length === verdict.findings.length;

    const rosterBody =
      `STRUCTURAL ARM (burndown-traceability/MUST-1). The generator's own chain check ` +
      `(\`node .claude/bin/burndown-build.mjs --check-links\`) exited 2 with ` +
      `${verdict.findings.length} [no-signer-fingerprint] finding(s). VERIFICATION COULD NOT RUN for ` +
      `these records. The roster entry for the signer carries no fingerprint, or one too short to bind ` +
      `an identity — and the bind needs a full fingerprint to compare the signing key against, so there ` +
      `was nothing to hold these signatures to. Nothing here says the record is wrong:\n` +
      shown.map((f) => `  [${f.kind}] ${f.why}`).join("\n") +
      (verdict.findings.length > shown.length ? `\n  … and ${verdict.findings.length - shown.length} more` : "") +
      `\nRun the command above for the full list. THE FIX IS A ROSTER EDIT — give that signer's roster ` +
      `entry its full fingerprint, then re-run the check. Re-emitting or re-signing the record changes ` +
      `nothing, because the record was never what was in question.`;

    const mixedRosterNote = rosterFindings.length
      ? `\n${rosterFindings.length} of these are [no-signer-fingerprint]: for those the verifier could ` +
        `NOT run — the signer's roster entry is missing a fingerprint or carries one too short to bind ` +
        `an identity — and the fix is a ROSTER edit. Those records are not accused.`
      : "";

    const body =
      verdict.kind === "broken"
        ? `STRUCTURAL ARM (burndown-traceability/MUST-1). The generator's own chain check ` +
          `(\`node .claude/bin/burndown-build.mjs --check-links\`) exited 2 with ` +
          `${verdict.findings.length} broken link(s). Each is a deterministic fact — a missing ledger ` +
          `row, an anchor git does not track, a context file that does not carry the id — not a reading ` +
          `of anyone's prose:\n` +
          shown.map((f) => `  ${f.leg}  ${f.id}: ${f.why}`).join("\n") +
          (verdict.findings.length > shown.length ? `\n  … and ${verdict.findings.length - shown.length} more` : "") +
          `\nRun the command above for the full list. A burndown status with no path back to the ruling ` +
          `behind it is a status word with nowhere to go.`
        : rosterOnly
          ? rosterBody
          : `STRUCTURAL ARM (burndown-traceability/MUST-1). The generator's own chain check ` +
            `(\`node .claude/bin/burndown-build.mjs --check-links\`) exited 2 with ` +
            `${verdict.findings.length} LEDGER-INTEGRITY finding(s). The verifier RAN and its verdict is ` +
            `that the event log is not what its producer wrote — a signature over the record's own bytes, ` +
            `a hash chain, a closed generation. None of it is a reading of anyone's prose:\n` +
            shown.map((f) => `  [${f.kind}] ${f.why}`).join("\n") +
            (verdict.findings.length > shown.length ? `\n  … and ${verdict.findings.length - shown.length} more` : "") +
            `\nRun the command above for the full list. Do NOT re-emit or re-sign the record to make this ` +
            `pass — an unverified signed log is an unsigned log, and the question is who wrote those bytes.` +
            mixedRosterNote;

    if (fallback) clearTimeout(fallback);
    try {
      // `instructAndWait` RETURNS `{json, exitCode}` — it does NOT write stdout.
      // Returning it without emitting is a silent no-op: the finding is computed
      // in full and then discarded, and every surface reports success. That is
      // the result-not-delivered failure class, and the sibling guard shipped it
      // once before its fixtures caught it.
      //
      // `rule_id` is NOT a delivery channel. `instructAndWait`'s signature does
      // not read it, so it never reaches the agent — measured, not assumed. It
      // is passed for fleet consistency with the sibling guards; the ARM
      // IDENTITY that actually reaches the reader is the first clause of `why`
      // below, which is why each arm names itself there in full.
      const { instructAndWait } = require("./lib/instruct-and-wait.js");
      const emitted = instructAndWait({
        hookEvent: "PostToolUse",
        severity: "block",
        rule_id: "burndown-traceability/MUST-1",
        what_happened:
          verdict.kind === "broken"
            ? `A write to the chain surface '${rel}' left the traceability chain BROKEN for ` +
              `${verdict.findings.length} burndown item(s).`
            : rosterOnly
              ? `A write to the chain surface '${rel}' was made against an event log ` +
                `${verdict.findings.length} of whose record(s) could NOT be verified at all — the signer's ` +
                `roster entry carries no usable fingerprint.`
              : `A write to the chain surface '${rel}' was made against an event log carrying ` +
                `${verdict.findings.length} LEDGER-INTEGRITY finding(s).`,
        why: body,
        agent_must_report:
          verdict.kind === "broken"
            ? [
                `File written: ${rel}`,
                ...shown.map((f) => `${f.leg} ${f.id}: ${f.why}`),
                "Backfill the tracker row / anchor rather than adjusting the status word.",
              ]
            : [
                `File written: ${rel}`,
                ...shown.map((f) => `[${f.kind}] ${f.why}`),
                rosterOnly
                  ? "Verification could not RUN for these records. Fix the ROSTER entry for that signer — " +
                    "it is missing a fingerprint or carries one too short to bind an identity. The record " +
                    "is not accused, and re-signing or re-emitting it clears nothing."
                  : "Report the integrity finding to the operator. Do NOT re-sign or re-emit the record to clear it.",
                ...(rosterOnly || !rosterFindings.length
                  ? []
                  : [
                      `${rosterFindings.length} of the above are [no-signer-fingerprint] — verification could ` +
                        `not run for those records; fix the signer's ROSTER entry. Those records are not accused.`,
                    ]),
              ],
      });
      process.stdout.write(JSON.stringify(emitted.json) + "\n");
      process.exit(emitted.exitCode);
    } catch {
      // Even the emit path fails OPEN — the finding is surfaced as context
      // rather than lost, and the write is not blocked on an emitter bug.
      return passthrough(body);
    }
  }

  // ── ARM (2) SEMANTIC — advisory only, never a block ──────────────────────
  let changes = [];
  if (trackerRel && rel === trackerRel) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(PROJECT_DIR, rel), "utf8");
    } catch {
      text = null; // CANNOT ASK — the semantic arm declines, silently
    }
    if (text !== null) changes = anchorChanges(PROJECT_DIR, rel, text);
  }

  if (changes.length > 0) {
    const shown = changes.slice(0, 8);
    const body =
      `SEMANTIC ARM (burndown-traceability/MUST-2, advisory — this write was NOT blocked). ` +
      `The write ${changes.length === 1 ? "sets" : "sets"} ${changes.length} value_anchor cell(s) in ` +
      `'${rel}':\n` +
      shown
        .map((c) =>
          c.kind === "added"
            ? `  added    ${c.id} → ${c.to}`
            : `  changed  ${c.id}: ${c.from} → ${c.to}`,
        )
        .join("\n") +
      (changes.length > shown.length ? `\n  … and ${changes.length - shown.length} more` : "") +
      `\n${linkStatusLine(verdict)}\n` +
      `Whether an anchor resolves is mechanical and is the STRUCTURAL arm's question. Whether it ` +
      `points at the RIGHT ruling is a judgment no check makes, which is why this is advisory: ` +
      `confirm each anchor above names the decision behind that item, and say so.`;

    if (fallback) clearTimeout(fallback);
    try {
      const { instructAndWait } = require("./lib/instruct-and-wait.js");
      const emitted = instructAndWait({
        hookEvent: "PostToolUse",
        severity: "advisory",
        rule_id: "burndown-traceability/MUST-2",
        what_happened: `A write to the tracker '${rel}' added or changed ${changes.length} value_anchor cell(s).`,
        why: body,
        agent_must_report: [
          `Tracker: ${rel}`,
          ...shown.map((c) => (c.kind === "added" ? `added ${c.id} → ${c.to}` : `changed ${c.id}: ${c.from} → ${c.to}`)),
          "Confirm each anchor names the ruling behind that item — the check cannot.",
        ],
      });
      // Advisory at PostToolUse: `{continue:true, additionalContext}`, exit 0.
      // Asserted, not assumed — an advisory that ever carried exit 2 would be a
      // semantic judgment wearing structural teeth.
      if (emitted.exitCode !== 0 || emitted.json.continue !== true) return passthrough(body);
      process.stdout.write(JSON.stringify(emitted.json) + "\n");
      process.exit(0);
    } catch {
      return passthrough(body); // fail OPEN, finding retained as plain context
    }
  }

  // Nothing to adjudicate. An UNKNOWN is still surfaced — it is the one result
  // that must never render as a clean chain.
  //
  // WITH ONE EXCEPTION, and it is a scope decision, not a swallow. When the
  // generator's refusal NAMES THE FILE THIS WRITE JUST TOUCHED, the unknown is
  // a mechanical consequence of the write being in progress ("the tracker you
  // are editing has uncommitted modifications"), which is a tautology rather
  // than information. Emitting it on every tracker/manifest/source edit is the
  // crying-wolf shape that gets advisories ignored — which is how a REAL
  // unknown then goes unread. The information is not lost where it matters: an
  // unknown caused by SOMETHING ELSE still surfaces (the pole next door pins
  // that), and a tracker write that actually changed an anchor gets the arm-2
  // advisory, which carries the same status line verbatim.
  if (verdict.kind === "unknown" && !selfInflicted(verdict, rel)) {
    return passthrough(linkStatusLine(verdict));
  }
  return passthrough(null);
}

/** Does the refusal name the very file this write touched? */
function selfInflicted(verdict, rel) {
  return typeof verdict.why === "string" && verdict.why.includes(`'${rel}'`);
}

// hookMain — the ONE entry, run by the CLI guard at the bottom of this file AND
// in-process by lib/hook-engine.js (dispatch.js). It arms the fallback timer the
// file used to arm at load time, then runs main() with the SAME catch handler.
function hookMain() {
  // Armed BEFORE any work, per `cc-artifacts.md` Rule 7.
  fallback = setTimeout(() => passthrough(null), TIMEOUT_MS);
  if (typeof fallback.unref === "function") fallback.unref();
  return main().catch(() => passthrough(null));
}

module.exports = { hookMain };

// CLI entry. The default path is exactly hookMain() — no engine dependency, so a
// tree that copies this hook without lib/hook-engine.js runs it unchanged. The
// selftest path replays the run through the in-process engine (hook-engine.js::runCli).
if (require.main === module) {
  if (process.env.COC_HOOK_ENGINE_SELFTEST === "1") require("./lib/hook-engine.js").runCli(hookMain, __filename);
  else hookMain();
}
