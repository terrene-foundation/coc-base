#!/usr/bin/env node
/*
 * Audit fixtures for `.claude/hooks/context-meter.js` + `lib/context-meter.js`
 * (cc-artifacts.md Rule 9). Every case drives the REAL hook as a subprocess over
 * stdin — the same entry the dispatcher runs — against synthetic transcripts in a
 * fresh `git init` scratch repo (so the main-checkout state resolver answers) and a
 * CONTROLLED env: every variable the meter reads is stripped from the parent env and
 * set per case, so the operator's own CLAUDE_CODE_AUTO_COMPACT_WINDOW cannot leak in.
 *
 * Bipolar: each behaviour is pinned by a case that must SPEAK and a case that must
 * stay SILENT (or a WARNING-present / WARNING-absent pair), so a hook that always
 * emits, or never emits, reds at least one arm.
 *
 * Exit 0 = all checks pass. Exit 1 = ≥1 check failed.
 */

import "../_lib/no-ambient-git.cjs";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, utimesSync, existsSync, readdirSync, cpSync, unlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "..", "hooks", "context-meter.js");

let passed = 0;
let failed = 0;
function check(name, cond, details) {
  if (cond) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stderr.write(`  FAIL  ${name}\n`);
    if (details) process.stderr.write(`        ${details}\n`);
  }
}

const METER_ENV = [
  "COC_HANDOVER_AT_TOKENS",
  "COC_HANDOVER_HEADROOM_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "COC_HOOK_ENGINE_SELFTEST",
];

const ROOT = mkdtempSync(join(tmpdir(), "context-meter-fx-"));
const REPO = join(ROOT, "repo");
mkdirSync(REPO);
execFileSync("git", ["init", "-q", REPO]);

let seq = 0;
function sid() {
  return `fx-session-${++seq}`;
}

// ── transcript builders ─────────────────────────────────────────────────────
function asst(usage, extra = {}) {
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "x" }], usage },
    ...extra,
  });
}
function usage(total, o = {}) {
  // Split the total across all four fields so every one of them carries weight.
  return {
    input_tokens: o.input ?? 2,
    cache_read_input_tokens: o.cacheRead ?? total - 2 - 1000 - 500,
    cache_creation_input_tokens: o.cacheCreate ?? 1000,
    output_tokens: o.output ?? 500,
  };
}
function userLine(text) {
  return JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: text } });
}
function transcript(lines) {
  const p = join(ROOT, `t-${++seq}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// Every case gets its OWN terminal config dir (CLAUDE_CONFIG_DIR) unless it opts out,
// so each case's coc-context-state.json is its own and no case reads another's.
function run({ event = "UserPromptSubmit", transcriptPath, session, env = {}, extra = {}, cfg, noConfigDir = false }) {
  const childEnv = { ...process.env };
  for (const k of METER_ENV) delete childEnv[k];
  const cfgDir = noConfigDir ? null : cfg || mkdtempSync(join(ROOT, "cfg-"));
  if (cfgDir) childEnv.CLAUDE_CONFIG_DIR = cfgDir;
  Object.assign(childEnv, env);
  const payload = { hook_event_name: event, session_id: session, cwd: REPO, transcript_path: transcriptPath, ...extra };
  if (event === "PostToolUse") Object.assign(payload, { tool_name: "Read", tool_input: { file_path: "/x" } });
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: childEnv, encoding: "utf8", timeout: 15000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim());
  } catch {
    /* left null — a case reds on it */
  }
  const ctx = json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, ctx, cfg: cfgDir };
}

function stateIn(cfgDir) {
  try {
    return JSON.parse(readFileSync(join(cfgDir, "coc-context-state.json"), "utf8"));
  } catch {
    return null;
  }
}

const BACKSTOP_ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "40.81632653061225" };
// → backstop (1,000,000 − 20,000) × 40.8163% = 400,000; handover 340,000; overdue 370,000.

// 1. UserPromptSubmit below the handover point — exactly ONE line; state written.
{
  const r = run({ transcriptPath: transcript([userLine("hi"), asst(usage(212000))]), session: sid() });
  check("ups-below: exit 0", r.status === 0, `status=${r.status} stderr=${r.stderr}`);
  // default handover = ASSUMED_BACKSTOP_TOKENS 500,000 − 60,000 headroom = 440,000;
  // floor(212,000 × 100 / 440,000) = floor(48.18) = 48.
  check("ups-below: one line, exact text (default handover 440k)", r.ctx === "[CTX] 212k/440k handover (48%)", JSON.stringify(r.ctx));
  const st = stateIn(r.cfg);
  check(
    "ups-below: coc-context-state/v1 written with tokens, band, points",
    st && st.schema === "coc-context-state/v1" && st.tokens.used === 212000 && st.tokens.source === "transcript-usage" &&
      st.band === "GREEN" && st.points.handover_tokens === 440000 && st.points.source === "fallback-default" && st.seq === 1 &&
      st.cwd === REPO && typeof st.updated_at === "string",
    JSON.stringify(st),
  );
}

// 2. All four usage fields are summed (cache_read is the largest term).
{
  const u = { input_tokens: 7, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000, output_tokens: 993 };
  const r = run({ transcriptPath: transcript([asst(u)]), session: sid() });
  check("sum: input+cache_read+cache_creation+output", stateIn(r.cfg).tokens.used === 153000, JSON.stringify(stateIn(r.cfg)));
}

// 3. PostToolUse: first reading speaks, +30k silent (state still written), cumulative +50k speaks.
{
  const s = sid();
  const cfg = mkdtempSync(join(ROOT, "cfg-"));
  const a = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(100000))]), session: s, cfg });
  check("post: first reading emits", a.ctx === "[CTX] 100k/440k handover (22%)", JSON.stringify(a.ctx));
  const b = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(130000))]), session: s, cfg });
  check("post: +30k stays silent", b.json && b.json.continue === true && b.ctx === null, b.stdout);
  const st = stateIn(cfg);
  check("post: silent call still samples into the state file (seq 2, 130k)", st && st.seq === 2 && st.tokens.used === 130000, JSON.stringify(st));
  const c = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(150000))]), session: s, cfg });
  check("post: +50k since last EMITTED emits", c.ctx === "[CTX] 150k/440k handover (34%)", JSON.stringify(c.ctx));
  check("post: seq strictly increases (3)", stateIn(cfg).seq === 3, JSON.stringify(stateIn(cfg)));
}

// A session's FIRST reading arms the start-above-handover guard, so every band case
// first warms its session up with a GREEN reading (the guard itself is case 15).
function warm(session, env, cfg) {
  return run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(100000))]), session, env, cfg });
}

// 4. Bands: GREEN / HANDOVER-DUE / HANDOVER-OVERDUE / BACKSTOP — the firm lines on EVERY call.
{
  const s = sid();
  const cfg = mkdtempSync(join(ROOT, "cfg-"));
  warm(s, BACKSTOP_ENV, cfg);
  const t = transcript([asst(usage(345000))]);
  const due = /^\[CTX\] HANDOVER-DUE 345k ≥ 340k handover — start the handover now: write the SEED first/;
  const a = run({ event: "PostToolUse", transcriptPath: t, session: s, env: BACKSTOP_ENV, cfg });
  const b = run({ event: "PostToolUse", transcriptPath: t, session: s, env: BACKSTOP_ENV, cfg });
  check("due: first call firm line", due.test(a.ctx || ""), JSON.stringify(a.ctx));
  check("due: repeat call (no rise) still firm", due.test(b.ctx || ""), JSON.stringify(b.ctx));
  // The handover is a checkpoint, never a stop: the line must say keep working and must not
  // tell the session to end its turn or open nothing new (owner fleet instruction, 2026-10-19).
  check("due: says keep working, never stop", /KEEP WORKING/.test(a.ctx || "") && !/end the turn|open nothing new/.test(a.ctx || ""), JSON.stringify(a.ctx));
  check("due: state band HANDOVER-DUE, not suppressed", stateIn(cfg).band === "HANDOVER-DUE" && stateIn(cfg).handover_suppressed === null, JSON.stringify(stateIn(cfg)));
  const c = run({ transcriptPath: t, session: s, env: BACKSTOP_ENV });
  check("due: UserPromptSubmit firm too", due.test(c.ctx || ""), JSON.stringify(c.ctx));
  const g = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(339000))]), session: sid(), env: BACKSTOP_ENV });
  check("green pole at 339k: not a band line", g.ctx === "[CTX] 339k/340k handover (99%) · backstop 400k" && stateIn(g.cfg).band === "GREEN", JSON.stringify(g.ctx));
  const so = sid();
  warm(so, BACKSTOP_ENV);
  const o = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(371000))]), session: so, env: BACKSTOP_ENV });
  check("overdue at backstop−30k: checkpoint write then continue", /^\[CTX\] HANDOVER-OVERDUE 371k ≥ 370k — write a current SEED, then keep working the queue/.test(o.ctx || "") && stateIn(o.cfg).band === "HANDOVER-OVERDUE", JSON.stringify(o.ctx));
  const so2 = sid();
  warm(so2, BACKSTOP_ENV);
  const o2 = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(369000))]), session: so2, env: BACKSTOP_ENV });
  check("overdue pole at 369k: still DUE", /^\[CTX\] HANDOVER-DUE/.test(o2.ctx || ""), JSON.stringify(o2.ctx));
  const sk = sid();
  warm(sk, BACKSTOP_ENV);
  const kk = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(401000))]), session: sk, env: BACKSTOP_ENV });
  check("backstop band at ≥400k", /^\[CTX\] BACKSTOP 401k ≥ 400k — CC compaction is imminent/.test(kk.ctx || "") && stateIn(kk.cfg).band === "BACKSTOP", JSON.stringify(kk.ctx));
  const sn = sid();
  warm(sn, {});
  // no env: default handover 440,000; overdue = 440,000 + 30,000 = 470,000.
  const nb = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(471000))]), session: sn });
  check("no backstop known: overdue = handover + 30k (470k)", /^\[CTX\] HANDOVER-OVERDUE 471k ≥ 470k/.test(nb.ctx || "") && stateIn(nb.cfg).points.overdue_tokens === 470000, JSON.stringify(nb.ctx));
}

// 5. Missing / corrupt transcript → UNKNOWN, never 0; band null, never GREEN.
{
  const r = run({ transcriptPath: join(ROOT, "does-not-exist.jsonl"), session: sid() });
  check("missing: UNKNOWN line", /^\[CTX\] UNKNOWN\/440k handover — transcript could not be opened \(ENOENT\)/.test(r.ctx || ""), JSON.stringify(r.ctx));
  const st = stateIn(r.cfg);
  check("missing: state tokens.used null (not 0), band null (not GREEN)", st && st.tokens.used === null && st.tokens.source === "unknown" && st.band === null, JSON.stringify(st));
  check("missing: loud on stderr", /reading UNKNOWN/.test(r.stderr), r.stderr);
  const r2 = run({ transcriptPath: transcript(["{not json", "garbage", '{"type":"assistant"']), session: sid() });
  check("corrupt: UNKNOWN line", /^\[CTX\] UNKNOWN\/440k/.test(r2.ctx || ""), JSON.stringify(r2.ctx));
  check("corrupt: never reports 0k", !/\b0k\//.test(r2.ctx || ""), r2.ctx);
  const r3 = run({ event: "PostToolUse", transcriptPath: join(ROOT, "nope.jsonl"), session: sid() });
  check("unknown on PostToolUse: silent", r3.ctx === null && r3.json && r3.json.continue === true, r3.stdout);
}

// 6. Sidechain and synthetic zero-usage records are ignored.
{
  const r = run({ transcriptPath: transcript([asst(usage(120000)), asst(usage(900000), { isSidechain: true })]), session: sid() });
  check("sidechain: ignored (reads 120k, not 900k)", r.ctx === "[CTX] 120k/440k handover (27%)", JSON.stringify(r.ctx));
  const r2 = run({
    transcriptPath: transcript([
      asst(usage(120000)),
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }),
    ]),
    session: sid(),
  });
  check("synthetic zero-usage: ignored (reads 120k, not 0k)", r2.ctx === "[CTX] 120k/440k handover (27%)", JSON.stringify(r2.ctx));
  const r3 = run({ transcriptPath: transcript([asst(usage(900000), { isSidechain: true })]), session: sid() });
  check("sidechain-only transcript: UNKNOWN", /^\[CTX\] UNKNOWN/.test(r3.ctx || ""), JSON.stringify(r3.ctx));
}

// 7. Backstop from env = (window − 20k reserve) × pct; handover = backstop − headroom;
//    headroom below 30k (or unparseable) ⇒ headroom_invalid ⇒ NO handover point.
{
  const t = transcript([asst(usage(100000))]);
  const r = run({ transcriptPath: t, session: sid(), env: BACKSTOP_ENV });
  check("backstop: (1M−20k)×40.8163% = 400k; handover 400k − 60k", r.ctx === "[CTX] 100k/340k handover (29%) · backstop 400k", JSON.stringify(r.ctx));
  const st = stateIn(r.cfg);
  check("backstop: state points (fallback-env, 400000/340000/370000, ok)", st.points.backstop_tokens === 400000 && st.points.handover_tokens === 340000 && st.points.overdue_tokens === 370000 && st.points.source === "fallback-env" && st.points.window_tokens === 1000000 && st.points.handover_status === "ok", JSON.stringify(st.points));
  const r2 = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "100000" } });
  check("headroom env: handover = 400k − 100k", r2.ctx === "[CTX] 100k/300k handover (33%) · backstop 400k", JSON.stringify(r2.ctx));
  const h30 = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "30000" } });
  check("headroom at the 30k minimum: valid (handover 370k)", h30.ctx === "[CTX] 100k/370k handover (27%) · backstop 400k", JSON.stringify(h30.ctx));
  const h29 = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "29999" } });
  check("headroom below 30k: headroom_invalid, NO handover point", h29.ctx === "[CTX] 100k · no handover point (headroom_invalid) · backstop 400k", JSON.stringify(h29.ctx));
  check("headroom below 30k: state handover null + status", stateIn(h29.cfg).points.handover_tokens === null && stateIn(h29.cfg).points.handover_status === "headroom_invalid" && stateIn(h29.cfg).band === "GREEN", JSON.stringify(stateIn(h29.cfg).points));
  const hx = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "lots" } });
  check("unparseable headroom: headroom_invalid, loud", hx.ctx === "[CTX] 100k · no handover point (headroom_invalid) · backstop 400k" && /headroom_invalid/.test(hx.stderr), `${hx.ctx} / ${hx.stderr}`);
  const sNull = sid();
  warm(sNull, { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "1000" });
  const nf = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(390000))]), session: sNull, env: { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "1000" } });
  // The +290k rise speaks (informational); what must NEVER appear on a null handover is a
  // handover-family line.
  check("never fire on null: 390k with no handover point gives no HANDOVER line", nf.ctx === "[CTX] 390k · no handover point (headroom_invalid) · backstop 400k" && stateIn(nf.cfg).band === "GREEN", nf.stdout);
  const nf2 = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(395000))]), session: sNull, env: { ...BACKSTOP_ENV, COC_HANDOVER_HEADROOM_TOKENS: "1000" } });
  check("never fire on null: no every-call firm line (+5k is silent)", nf2.ctx === null, nf2.stdout);
  const r3 = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_AT_TOKENS: "450000" } });
  check("explicit handover above the backstop: headroom_invalid, no handover", r3.ctx === "[CTX] 100k · no handover point (headroom_invalid) · backstop 400k", JSON.stringify(r3.ctx));
  const r3b = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_AT_TOKENS: "380000" } });
  check("explicit handover 20k under the backstop: headroom_invalid", r3b.ctx === "[CTX] 100k · no handover point (headroom_invalid) · backstop 400k", JSON.stringify(r3b.ctx));
  const r3c = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_AT_TOKENS: "370000" } });
  check("explicit handover exactly 30k under the backstop: valid", r3c.ctx === "[CTX] 100k/370k handover (27%) · backstop 400k", JSON.stringify(r3c.ctx));
  const r4 = run({ transcriptPath: t, session: sid(), env: { ...BACKSTOP_ENV, COC_HANDOVER_AT_TOKENS: "300k" } });
  check("explicit 300k: valid", r4.ctx === "[CTX] 100k/300k handover (33%) · backstop 400k", JSON.stringify(r4.ctx));
  const r5 = run({ transcriptPath: t, session: sid(), env: { COC_HANDOVER_AT_TOKENS: "lots" } });
  check("invalid handover env: ignored (default), loud on stderr", r5.ctx === "[CTX] 100k/440k handover (22%)" && /COC_HANDOVER_AT_TOKENS/.test(r5.stderr), `${r5.ctx} / ${r5.stderr}`);
  // 500k POLE — the owner's live shape: pct set, window env UNSET ⇒ CC's own model window
  // (ASSUMED_MODEL_WINDOW_TOKENS 1,000,000): floor((1,000,000 − 20,000) × 51.02040816326531 / 100)
  // = 500,000 backstop; handover 500,000 − 60,000 = 440,000; overdue 500,000 − 30,000 = 470,000;
  // floor(100,000 × 100 / 440,000) = 22.
  const PCT_ONLY = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "51.02040816326531" };
  const p1 = run({ transcriptPath: t, session: sid(), env: PCT_ONLY });
  check("500k pole: pct set + window UNSET ⇒ model window 1M ⇒ backstop 500k, handover 440k", p1.ctx === "[CTX] 100k/440k handover (22%) · backstop 500k", JSON.stringify(p1.ctx));
  const p1s = stateIn(p1.cfg).points;
  check("500k pole: state points (fallback-env, 500000/440000/470000, window 1000000)", p1s.backstop_tokens === 500000 && p1s.handover_tokens === 440000 && p1s.overdue_tokens === 470000 && p1s.window_tokens === 1000000 && p1s.source === "fallback-env" && p1s.handover_status === "ok", JSON.stringify(p1s));
  check("500k pole: the state RECORDS that the 1M window was assumed (window_assumed:true)", p1s.window_assumed === true, JSON.stringify(p1s));
  const p5 = run({ transcriptPath: t, session: sid(), env: { ...PCT_ONLY, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" } });
  check("500k pole: an explicitly SET window is not recorded as assumed (window_assumed:false)", stateIn(p5.cfg).points.window_assumed === false && stateIn(p5.cfg).points.backstop_tokens === 500000, JSON.stringify(stateIn(p5.cfg).points));
  const p2 = run({ transcriptPath: t, session: sid(), env: { ...PCT_ONLY, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "" } });
  check("500k pole: an EMPTY window env reads as unset (backstop 500k)", p2.ctx === "[CTX] 100k/440k handover (22%) · backstop 500k", JSON.stringify(p2.ctx));
  const p3 = run({ transcriptPath: t, session: sid(), env: { ...PCT_ONLY, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "lots" } });
  check("500k pole: an explicit UNPARSEABLE window is not replaced by the model window (no backstop; default handover)", p3.ctx === "[CTX] 100k/440k handover (22%)" && stateIn(p3.cfg).points.backstop_tokens === null, `${p3.ctx} ${JSON.stringify(stateIn(p3.cfg).points)}`);
  const p4 = run({ transcriptPath: t, session: sid(), env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" } });
  check("500k pole: window set + pct UNSET ⇒ no backstop (the model window needs a pct)", p4.ctx === "[CTX] 100k/440k handover (22%)" && stateIn(p4.cfg).points.backstop_tokens === null, `${p4.ctx}`);
}

// 8. csq points file: PRESENT ⇒ authoritative + silent (even with a null handover, even
//    when old); CORRUPT ⇒ loud, NO env fallback; ONLY ABSENT ⇒ env points + emit.
{
  const t = transcript([asst(usage(100000))]);
  const cfgWith = (body) => {
    const d = mkdtempSync(join(ROOT, "cfg-"));
    if (body !== undefined) writeFileSync(join(d, "csq-context-points.json"), body);
    return d;
  };
  const pts = (o = {}) =>
    JSON.stringify({
      schema_version: 1,
      handover_tokens: 250000,
      backstop_tokens: 300000,
      headroom_tokens: 50000,
      window_tokens: 1000000,
      model: "m",
      source: "pct_override",
      handover_status: "ok",
      cc_auto_compact_window: 1000000,
      cc_autocompact_pct_override: 40.8,
      computed_at: new Date().toISOString(),
      ...o,
    });
  const s = sid();
  const cfg = cfgWith(pts());
  const present = run({ transcriptPath: t, session: s, cfg, env: BACKSTOP_ENV });
  check("csq present: emits NOTHING to context", present.json && present.json.continue === true && present.ctx === null, present.stdout);
  const st = stateIn(cfg);
  check("csq present: state carries csq points (source csq, overdue = backstop − 30k)", st && st.points.handover_tokens === 250000 && st.points.backstop_tokens === 300000 && st.points.overdue_tokens === 270000 && st.points.headroom_tokens === 50000 && st.points.source === "csq" && st.points.csq_points === "present" && st.tokens.used === 100000, JSON.stringify(st));
  const presentPost = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(260000))]), session: s, cfg });
  check("csq present: silent even over csq's handover, band still recorded", presentPost.ctx === null && stateIn(cfg).band === "HANDOVER-DUE", presentPost.stdout);
  const old = run({ transcriptPath: t, session: sid(), env: BACKSTOP_ENV, cfg: cfgWith(pts({ computed_at: "2020-01-01T00:00:00Z" })) });
  check("csq computed_at years old: still authoritative (no age rule)", old.ctx === null && stateIn(old.cfg).points.handover_tokens === 250000, old.stdout);
  for (const status of ["below_floor", "no_backstop"]) {
    const o = status === "no_backstop" ? { handover_tokens: null, backstop_tokens: null, headroom_tokens: null, handover_status: status, source: "autocompact_disabled" } : { handover_tokens: null, handover_status: status };
    const cs = sid();
    const ccfg = cfgWith(pts(o));
    warm(cs, BACKSTOP_ENV, ccfg);
    const n = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(360000))]), session: cs, env: BACKSTOP_ENV, cfg: ccfg });
    check(`csq null handover (${status}): no line, NO env fallback`, n.ctx === null, n.stdout);
    const np = stateIn(ccfg).points;
    check(`csq null handover (${status}): state handover null, source csq, status recorded`, np.handover_tokens === null && np.source === "csq" && np.handover_status === status && np.overdue_tokens === null, JSON.stringify(np));
  }
  const absent = run({ transcriptPath: t, session: sid(), env: BACKSTOP_ENV, cfg: cfgWith(undefined) });
  check("csq ABSENT (pole): env fallback emits", absent.ctx === "[CTX] 100k/340k handover (29%) · backstop 400k" && !/csq/.test(absent.stderr), `${absent.ctx} / ${absent.stderr}`);
  check("csq absent: state says absent, fallback-env", stateIn(absent.cfg).points.csq_points === "absent" && stateIn(absent.cfg).points.source === "fallback-env");
  const corrupt = run({ transcriptPath: t, session: sid(), env: BACKSTOP_ENV, cfg: cfgWith("{ not json") });
  check("csq corrupt: NO env fallback — reading with no handover point", corrupt.ctx === "[CTX] 100k · no handover point (points_corrupt)", JSON.stringify(corrupt.ctx));
  check("csq corrupt: reported LOUDLY on stderr", /CORRUPT/.test(corrupt.stderr), corrupt.stderr);
  check("csq corrupt: state says corrupt with the reason", stateIn(corrupt.cfg).points.csq_points === "corrupt" && /not valid JSON/.test(stateIn(corrupt.cfg).points.csq_reason || ""));
  const bad = (name, o) => {
    const r = run({ transcriptPath: t, session: sid(), env: BACKSTOP_ENV, cfg: cfgWith(pts(o)) });
    check(`csq ${name}: corrupt, not trusted`, /no handover point \(points_corrupt\)/.test(r.ctx || "") && /CORRUPT/.test(r.stderr), `${r.ctx} / ${r.stderr}`);
  };
  bad("wrong-typed handover", { handover_tokens: "250k" });
  bad("unknown source", { source: "made_up" });
  bad("unknown handover_status", { handover_status: "maybe" });
  bad("handover set but status not ok", { handover_status: "below_floor" });
  bad("model over 128 chars", { model: "m".repeat(129) });
  const m128 = run({ transcriptPath: t, session: sid(), env: BACKSTOP_ENV, cfg: cfgWith(pts({ model: "m".repeat(128) })) });
  check("csq model of exactly 128 chars: accepted (pole)", m128.ctx === null && stateIn(m128.cfg).points.csq_points === "present", m128.stdout);
  const pathy = cfgWith(pts({ model: "../../pwned-model" }));
  run({ transcriptPath: t, session: sid(), cfg: pathy });
  check("csq path-shaped value: never used as a path (nothing created)", !existsSync(join(pathy, "..", "..", "pwned-model")) && !existsSync(join(pathy, "..", "pwned-model")));
}

// 9. Sub-agent calls are not metered (no line, no state write).
{
  const r = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(380000))]), session: sid(), extra: { agent_id: "a1b2c3" } });
  check("subagent: silent even over the handover point", r.ctx === null && r.json && r.json.continue === true, r.stdout);
  check("subagent: no state written for the parent's terminal", stateIn(r.cfg) === null);
}

// 10. Compaction: a boundary newer than the last usage ⇒ post-compaction estimate;
//     a fall re-bases the PostToolUse baseline silently.
{
  const s = sid();
  run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(300000))]), session: s });
  const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: { trigger: "auto", preTokens: 400000, postTokens: 21365 } });
  const a = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(300000)), boundary]), session: s });
  check("compaction: a fall re-bases silently", a.ctx === null, a.stdout);
  check("compaction: state source compaction-estimate", stateIn(a.cfg).tokens.source === "compaction-estimate" && stateIn(a.cfg).tokens.used === 21365, JSON.stringify(stateIn(a.cfg)));
  const b = run({ transcriptPath: transcript([asst(usage(300000)), boundary]), session: s });
  check("compaction: estimate line", b.ctx === "[CTX] ~21k/440k handover (4%, post-compaction estimate)", JSON.stringify(b.ctx));
  const c = run({ event: "PostToolUse", transcriptPath: transcript([boundary, asst(usage(80000))]), session: s });
  check("after re-base: +59k from 21k emits", c.ctx === "[CTX] 80k/440k handover (18%)", JSON.stringify(c.ctx));
  const noPost = JSON.stringify({ type: "system", subtype: "compact_boundary", isSidechain: false, compactMetadata: {} });
  const d = run({ transcriptPath: transcript([asst(usage(300000)), noPost]), session: sid() });
  check("compaction without postTokens: UNKNOWN, not the stale 300k", /^\[CTX\] UNKNOWN\/440k handover — compacted/.test(d.ctx || ""), JSON.stringify(d.ctx));
}

// 11. Bounded tail: a >256KB tool_result after the last usage is crossed by the 2MB retry.
{
  const big = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "y".repeat(600 * 1024) }] } });
  const r = run({ transcriptPath: transcript([asst(usage(150000)), big]), session: sid() });
  check("tail retry: usage beyond 256KB found in the 2MB window", r.ctx === "[CTX] 150k/440k handover (34%)", JSON.stringify(r.ctx));
  const huge = JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "y".repeat(3 * 1024 * 1024) }] } });
  const r2 = run({ transcriptPath: transcript([asst(usage(150000)), huge]), session: sid() });
  check("tail bound: beyond 2MB is UNKNOWN, never a whole-file read", /^\[CTX\] UNKNOWN\/440k handover — no usage-bearing main-thread assistant record in the last 2048KB/.test(r2.ctx || ""), JSON.stringify(r2.ctx));
}

// 12. The state file is READ-MODIFY-WRITE: foreign fields preserved, seq continues.
{
  const cfg = mkdtempSync(join(ROOT, "cfg-"));
  const foreign = {
    schema: "coc-context-state/v1",
    seq: 41,
    terminal: { config_dir: cfg, claude_pid: 1 },
    handover: { state: "written", seed_sha256: "ab".repeat(32), at_tokens: 341207 },
    boundary: { ready: true, preferred: "clear" },
    resume: { injected: false, attempts: 0 },
  };
  writeFileSync(join(cfg, "coc-context-state.json"), JSON.stringify(foreign));
  run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg });
  const st = stateIn(cfg);
  check("rmw: seq continues from 41 to 42", st && st.seq === 42, JSON.stringify(st && st.seq));
  check(
    // `boundary` is NOT asserted here: the S1 shard's activityBoundary rewrites it on
    // every activity event inside the same locked write (lib/context-state.js).
    "rmw: handover / resume / terminal preserved byte-for-value",
    st && JSON.stringify(st.handover) === JSON.stringify(foreign.handover) &&
      JSON.stringify(st.resume) === JSON.stringify(foreign.resume) && JSON.stringify(st.terminal) === JSON.stringify(foreign.terminal),
    JSON.stringify(st),
  );
  check("rmw: meter's own fields overwritten", st && st.tokens.used === 120000 && st.band === "GREEN");

  const cfg2 = mkdtempSync(join(ROOT, "cfg-"));
  writeFileSync(join(cfg2, "coc-context-state.json"), "{ torn");
  const c = run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg: cfg2 });
  check("corrupt state file: replaced LOUDLY", /was CORRUPT/.test(c.stderr) && stateIn(cfg2) && stateIn(cfg2).seq === 1, c.stderr);

  const cfg3 = mkdtempSync(join(ROOT, "cfg-"));
  const victim = join(ROOT, "victim.json");
  writeFileSync(victim, "untouched\n");
  symlinkSync(victim, join(cfg3, "coc-context-state.json"));
  const l = run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg: cfg3 });
  check("symlinked state file: refused, link target untouched", readFileSync(victim, "utf8") === "untouched\n" && /context state not written/.test(l.stderr), l.stderr);
  check("symlinked state file: the line still emits (fail-open)", l.ctx === "[CTX] 120k/440k handover (27%)", JSON.stringify(l.ctx));

  const cfg4 = mkdtempSync(join(ROOT, "cfg-"));
  writeFileSync(join(cfg4, "coc-context-state.json.lock"), "999 held\n");
  const h = run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg: cfg4 });
  check("held lock: write skipped LOUDLY, no clobber", /lock not acquired/.test(h.stderr) && stateIn(cfg4) === null, h.stderr);
  const cfg5 = mkdtempSync(join(ROOT, "cfg-"));
  const lock5 = join(cfg5, "coc-context-state.json.lock");
  writeFileSync(lock5, "999 crashed\n");
  const past = new Date(Date.now() - 60000);
  utimesSync(lock5, past, past);
  run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg: cfg5 });
  check("stale lock (crashed writer): broken and written", stateIn(cfg5) && stateIn(cfg5).seq === 1);
}

// 13. Fallback location when CLAUDE_CONFIG_DIR is unset / not a directory.
{
  const r = run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), noConfigDir: true });
  const fbDir = join(REPO, ".claude", "learning", "context-state");
  // The key is the first NON-shell ancestor (here: this fixture, which spawned node with no
  // shell) qualified by its start-time hash — lib/context-meter.js::stableTerminalKey.
  const fbName = readdirSync(fbDir).find((n) => new RegExp(`^${process.pid}-[0-9a-f]{8}\\.json$`).test(n));
  let st = null;
  try {
    st = JSON.parse(readFileSync(join(fbDir, fbName), "utf8"));
  } catch {
    /* red below */
  }
  check("fallback: <main-checkout>/.claude/learning/context-state/<pid>-<start-hash>.json", st && st.schema === "coc-context-state/v1" && st.tokens.used === 120000, `${fbName} ${r.stderr}`);
  check("fallback: dir gitignored", readFileSync(join(fbDir, ".gitignore"), "utf8") === "*\n");
  const before = readdirSync(fbDir).length;
  const r2 = run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), noConfigDir: true, env: { CLAUDE_CONFIG_DIR: join(ROOT, "no-such-dir") } });
  check("CR-STAMP-DIR · RED: a set-but-missing CLAUDE_CONFIG_DIR is REFUSED (never a guessed fallback file)", /refusing to guess a state path/.test(r2.stderr) && readdirSync(fbDir).length === before, r2.stderr);
  const okCfg = mkdtempSync(join(ROOT, "cfg-"));
  run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg: okCfg });
  check("CR-STAMP-DIR · GREEN: an existing CLAUDE_CONFIG_DIR is used", stateIn(okCfg) && stateIn(okCfg).tokens.used === 120000 && !existsSync(join(ROOT, "no-such-dir")));
}

// 14. Never blocks: no case ever exits 2 or emits a deny / continue:false.
{
  const r = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(999000))]), session: sid() });
  check("never blocks: exit 0, continue true, no decision field", r.status === 0 && r.json.continue === true && !("decision" in r.json) && !r.json.hookSpecificOutput.permissionDecision, r.stdout);
  const bad = spawnSync(process.execPath, [HOOK], { input: "not json at all", encoding: "utf8", timeout: 15000 });
  check("unparseable payload: passthrough exit 0", bad.status === 0 && bad.stdout.trim() === '{"continue":true}', `${bad.status} ${bad.stdout}`);
}

// 15. Start-above-handover guard: a session whose FIRST reading is already ≥ handover
//     fires NO handover lines (else handover → /clear → restart above → loop).
{
  const s = sid();
  const cfg = mkdtempSync(join(ROOT, "cfg-"));
  const a = run({ transcriptPath: transcript([asst(usage(345000))]), session: s, env: BACKSTOP_ENV, cfg });
  check("start-above: no HANDOVER line on the first turn", a.ctx === "[CTX] 345k/340k handover · handover SUPPRESSED (session started above the handover point) · backstop 400k", JSON.stringify(a.ctx));
  check("start-above: state handover_suppressed recorded", stateIn(cfg).handover_suppressed === "start-above-handover" && stateIn(cfg).band === "HANDOVER-DUE", JSON.stringify(stateIn(cfg)));
  const b = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(350000))]), session: s, env: BACKSTOP_ENV, cfg });
  check("start-above: no firm every-call line at PostToolUse", b.ctx === null, b.stdout);
  const c = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(372000))]), session: s, env: BACKSTOP_ENV, cfg });
  check("start-above: still suppressed into OVERDUE", c.ctx === null && stateIn(cfg).handover_suppressed === "start-above-handover", c.stdout);
  // re-arm: a reading below the point (a compaction), then a genuine crossing
  run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(100000))]), session: s, env: BACKSTOP_ENV, cfg });
  check("re-arm: a reading below handover clears the suppression", stateIn(cfg).handover_suppressed === null, JSON.stringify(stateIn(cfg)));
  const d = run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(345000))]), session: s, env: BACKSTOP_ENV, cfg });
  check("re-arm: the next crossing fires HANDOVER-DUE", /^\[CTX\] HANDOVER-DUE 345k/.test(d.ctx || ""), JSON.stringify(d.ctx));
  // pole: a session that STARTED below, then crossed, is never suppressed
  const s2 = sid();
  const cfg2 = mkdtempSync(join(ROOT, "cfg-"));
  run({ transcriptPath: transcript([asst(usage(300000))]), session: s2, env: BACKSTOP_ENV, cfg: cfg2 });
  const e = run({ transcriptPath: transcript([asst(usage(345000))]), session: s2, env: BACKSTOP_ENV, cfg: cfg2 });
  check("pole: started below, crossed ⇒ HANDOVER-DUE fires, not suppressed", /^\[CTX\] HANDOVER-DUE 345k/.test(e.ctx || "") && stateIn(cfg2).handover_suppressed === null, JSON.stringify(e.ctx));
  // csq present: the guard is still recorded for csq to read
  const s3 = sid();
  const cfg3 = mkdtempSync(join(ROOT, "cfg-"));
  writeFileSync(join(cfg3, "csq-context-points.json"), JSON.stringify({ schema_version: 1, handover_tokens: 250000, backstop_tokens: 300000, headroom_tokens: 50000, window_tokens: 1000000, model: "m", source: "pct_override", handover_status: "ok", computed_at: new Date().toISOString() }));
  run({ transcriptPath: transcript([asst(usage(260000))]), session: s3, cfg: cfg3 });
  check("csq present + start above csq's handover: suppression recorded", stateIn(cfg3).handover_suppressed === "start-above-handover", JSON.stringify(stateIn(cfg3)));
}

// ── ROUND-1 FINDINGS (context-boundary security round) — one NAMED case per id ──
const requireLib = createRequire(import.meta.url);
const LIB = requireLib(join(HERE, "..", "..", "hooks", "lib", "context-meter.js"));
const monoNow = () => Number(process.hrtime.bigint() / 1000000n);

{
  const lag = requireLib(join(HERE, "..", "..", "hooks", "lib", "context-state.js")).FRESH_SEED_MAX_TOKEN_LAG;
  for (const [band, tokens] of [["GREEN", 339000], ["HANDOVER-DUE", 345000], ["HANDOVER-OVERDUE", 371000], ["BACKSTOP", 401000]]) {
    const s = sid(), cfg = mkdtempSync(join(ROOT, "fresh-cfg-"));
    warm(s, BACKSTOP_ENV, cfg);
    const tp = transcript([asst(usage(tokens))]), metadata = statSync(tp);
    const writeSeed = at => writeFileSync(join(cfg, "coc-context-state.json"), JSON.stringify({
      ...stateIn(cfg), handover: { state: "written", session_id: s, written_at: new Date().toISOString(),
        transcript_path: tp, transcript_ino: metadata.ino, transcript_dev: metadata.dev, seed_offset: 0,
        seed_sha256: "ab".repeat(32), at_tokens: at },
    }));
    writeSeed(tokens - lag);
    const fresh = run({ transcriptPath: tp, session: s, cfg, env: BACKSTOP_ENV });
    check("fresh seed " + band + ": keep working, no rewrite", /seed current; keep working the queue/.test(fresh.ctx || "") && !/write.*SEED|alone, before/.test(fresh.ctx || ""), JSON.stringify(fresh.ctx));
    if (band !== "GREEN") {
      writeSeed(tokens - lag - 1);
      const stale = run({ event: "PostToolUse", transcriptPath: tp, session: s, cfg, env: BACKSTOP_ENV });
      check("stale seed " + band + ": write checkpoint then continue", /write.*SEED/.test(stale.ctx || "") && !/seed current|alone, before/.test(stale.ctx || ""), JSON.stringify(stale.ctx));
    }
  }
}

// H2 — every metered event replaces the lock-free activity nonce.
{
  const cfg = mkdtempSync(join(ROOT, "cfg-"));
  const act = () => {
    try {
      return JSON.parse(readFileSync(join(cfg, "coc-context-state.activity.json"), "utf8")).nonce;
    } catch {
      return null;
    }
  };
  run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg });
  const n1 = act();
  run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(121000))]), session: sid(), cfg });
  const n2 = act();
  const seqBefore = stateIn(cfg).seq;
  const pre = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: REPO, tool_name: "Bash", tool_input: { command: "x" } }), env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, encoding: "utf8", timeout: 15000 });
  const n3 = act();
  check("H2 · every metered event (UserPromptSubmit, PostToolUse) replaces the activity nonce", /^[0-9a-f]{32}$/.test(n1 || "") && n2 && n2 !== n1, `${n1} ${n2}`);
  check("C · PreToolUse is NOT a meter event (the transcript witnesses a tool start): no marker, no state write", n3 === n2 && stateIn(cfg).seq === seqBefore && pre.stdout.trim() === '{"continue":true}', `${n2} ${n3} seq=${stateIn(cfg).seq} ${pre.stdout}`);
}

// R2-C3 — the marker names the session that wrote it (the consumer refuses a boundary of
// another session); a malformed or absent session_id is recorded as null (matches nothing).
{
  const cfg = mkdtempSync(join(ROOT, "cfg-"));
  const marker = () => {
    try {
      return JSON.parse(readFileSync(join(cfg, "coc-context-state.activity.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const sA = sid();
  run({ transcriptPath: transcript([asst(usage(120000))]), session: sA, cfg });
  const m1 = marker();
  const sB = sid();
  run({ event: "PostToolUse", transcriptPath: transcript([asst(usage(121000))]), session: sB, cfg });
  const m2 = marker();
  run({ transcriptPath: transcript([asst(usage(122000))]), session: "bad session id with spaces", cfg });
  const m3 = marker();
  check("R2-C3 · GREEN: a UserPromptSubmit bump records ITS session_id; a PostToolUse bump records ITS own", m1 && m1.session_id === sA && m2 && m2.session_id === sB && m2.nonce !== m1.nonce, JSON.stringify([m1, m2]));
  check("R2-C3 · RED: a malformed session_id is recorded as null (a marker no boundary can match)", m3 && m3.session_id === null && m3.nonce !== m2.nonce, JSON.stringify(m3));
  const L2 = LIB.readActivity({ ok: true, dir: cfg, file: join(cfg, "coc-context-state.json") });
  check("R2-C3 · readActivity returns the recorded session_id (null for the malformed one)", L2.state === "ok" && L2.session_id === null && L2.nonce === m3.nonce, JSON.stringify(L2));
}

// H2 — the fallback write (context-state lib unavailable) writes boundary.ready:false.
{
  const sandbox = mkdtempSync(join(ROOT, "hooks-copy-"));
  cpSync(join(HERE, "..", "..", "hooks"), join(sandbox, "hooks"), { recursive: true });
  unlinkSync(join(sandbox, "hooks", "lib", "context-state.js"));
  const cfgRed = mkdtempSync(join(ROOT, "cfg-"));
  writeFileSync(join(cfgRed, "coc-context-state.json"), JSON.stringify({ schema: "coc-context-state/v1", seq: 3, boundary: { ready: true, committed: true, activity_nonce: "a".repeat(32) } }));
  const r = spawnSync(process.execPath, [join(sandbox, "hooks", "context-meter.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: REPO, transcript_path: transcript([asst(usage(120000))]) }), env: { ...process.env, CLAUDE_CONFIG_DIR: cfgRed }, encoding: "utf8", timeout: 15000 });
  const red = stateIn(cfgRed);
  check("H2 · RED: with context-state.js unavailable the meter still writes boundary.ready:false", red && red.boundary && red.boundary.ready === false && /context-state library unavailable/.test(JSON.stringify(red.boundary)) && /writing boundary.ready=false directly/.test(r.stderr), `${JSON.stringify(red && red.boundary)} ${r.stderr.slice(0, 200)}`);
  const cfgGreen = mkdtempSync(join(ROOT, "cfg-"));
  writeFileSync(join(cfgGreen, "coc-context-state.json"), JSON.stringify({ schema: "coc-context-state/v1", seq: 3, boundary: { ready: true, committed: true } }));
  run({ transcriptPath: transcript([asst(usage(120000))]), session: sid(), cfg: cfgGreen });
  check("H2 · GREEN: with the library present the boundary write is the library's (activityBoundary)", stateIn(cfgGreen).boundary.ready === false && stateIn(cfgGreen).boundary.last_event === "UserPromptSubmit" && !/context-state library unavailable/.test(JSON.stringify(stateIn(cfgGreen).boundary)));
}

// M5 — the lock: owner-verified release, monotonic staleness, rename-and-verify break.
{
  const dir = mkdtempSync(join(ROOT, "lock-"));
  const file = join(dir, "state.json");
  const lock = `${file}.lock`;
  let survived = false;
  LIB.withStateLock(file, () => {
    // Someone (wrongly) broke OUR lock mid-section and took a fresh one of their own.
    unlinkSync(lock);
    writeFileSync(lock, JSON.stringify({ pid: 2, mono: monoNow() }) + "\n");
  });
  survived = existsSync(lock) && /"pid":2/.test(readFileSync(lock, "utf8"));
  check("M5 · RED: release never unlinks a lock that is no longer the holder's own (owner nonce, even on a reused inode)", survived, existsSync(lock) ? readFileSync(lock, "utf8") : "lock gone");
  if (existsSync(lock)) unlinkSync(lock);
  LIB.withStateLock(file, () => null);
  check("M5 · GREEN: release removes the holder's own lock", !existsSync(lock));
  writeFileSync(lock, JSON.stringify({ pid: 3, mono: monoNow() }) + "\n");
  const ino = statSync(lock).ino;
  const past = new Date(Date.now() - 60000);
  utimesSync(lock, past, past);
  let ran = false;
  const r = LIB.withStateLock(file, () => {
    ran = true;
  });
  check("M5 · a FRESH lock (monotonic stamp now) is never broken, whatever its mtime says", !ran && r && r.ok === false && existsSync(lock) && statSync(lock).ino === ino, JSON.stringify(r));
  writeFileSync(lock, JSON.stringify({ pid: 4, mono: monoNow() - 60000 }) + "\n");
  let ran2 = false;
  LIB.withStateLock(file, () => {
    ran2 = true;
  });
  check("M5 · a STALE lock (monotonic stamp 60s old) is broken and the section runs", ran2 && !existsSync(lock));
}

// LOW6 — the fallback key is the first NON-shell ancestor, stable across invocations.
{
  const libPath = join(HERE, "..", "..", "hooks", "lib", "context-meter.js");
  const probe = () => {
    const code = `const L=require(${JSON.stringify(libPath)});const k=L.stableTerminalKey(process.ppid);process.stdout.write(JSON.stringify({ppid:process.ppid,key:k.ok?k.key:null,reason:k.reason||null}))`;
    // A compound command: the shell does NOT exec node (measured), so node's parent is the
    // per-invocation shell — the case the raw-ppid key got wrong.
    const r = spawnSync("sh", ["-c", `"${process.execPath}" -e '${code.replace(/'/g, "'\\''")}' && true`], { encoding: "utf8", timeout: 20000 });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { ppid: null, key: null, reason: r.stderr.slice(0, 200) };
    }
  };
  const a = probe();
  const b = probe();
  check("LOW6 · RED: under a non-exec'ing shell the raw parent pid CHANGES per invocation (the old key)", a.ppid && b.ppid && a.ppid !== b.ppid && a.ppid !== process.pid, JSON.stringify([a, b]));
  check("LOW6 · GREEN: stableTerminalKey is IDENTICAL across both invocations and names the non-shell ancestor", a.key && a.key === b.key && a.key.startsWith(`${process.pid}-`) && /^\d+-[0-9a-f]{8}$/.test(a.key), JSON.stringify([a, b]));
}

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* scratch under os.tmpdir() */
}

process.stdout.write(`\ncontext-meter fixtures: ${passed}/${passed + failed} passed\n`);
process.exit(failed === 0 ? 0 : 1);
