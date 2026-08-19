#!/usr/bin/env node
/**
 * burndown-quote-hooks — fixtures for the two enforcement surfaces of
 * `burndown-integrity.md`: `burndown-quote-write-guard.js` (PostToolUse) and
 * `burndown-quote-stop-guard.js` (Stop), plus their shared seam
 * `hooks/lib/burndown-quote.js`.
 *
 * BIPOLAR PER ARM, which is the point. Each arm has a pole that MUST fire and a
 * pole that MUST stay silent:
 *
 *   arm (1) invalid token   → fires with severity `block`   | valid token → silent
 *   arm (2) untokened count → fires `halt-and-report`       | tokened count → silent
 *   scoping: no manifest    → silent on BOTH arms (this is what stops arm (2)
 *                             crying wolf in every repo that has no burndown)
 *   fail-open: unreadable / unparseable / absent generator → silent, never a guess
 *
 * A guard shown only to FIRE proves it can say "no". The silent poles are what
 * prove it can say anything else — and for arm (2), whose detection is lexical,
 * the silent poles are the ONLY evidence it is not noise.
 *
 * The hooks are invoked as REAL subprocesses over REAL stdin payloads against
 * REAL temporary git repositories. Nothing is mocked, so a case cannot pass
 * against a hook the harness would not actually run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS = path.join(REPO_ROOT, ".claude", "hooks");
const WRITE_GUARD = path.join(HOOKS, "burndown-quote-write-guard.js");
const STOP_GUARD = path.join(HOOKS, "burndown-quote-stop-guard.js");
const GENERATOR = path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");

let pass = 0;
const failures = [];
function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

const REGISTER = {
  _note: "hook fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "REG-NN",
  items: [
    { id: "R1", page: "Alpha", status: "Signed off" },
    { id: "R2", page: "Alpha", status: "In progress" },
    { id: "R3", page: "Beta", status: "Not started" },
  ],
};
const MANIFEST = {
  _schema: "burndown-manifest/v1",
  target: "REGISTER.md",
  pages: ["Alpha", "Beta"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
};

/** A repo that HAS a burndown. `withManifest:false` gives one that does not. */
function mkRepo({ withManifest = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-hook-"));
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "journal"), { recursive: true });
  fs.writeFileSync(path.join(dir, "burndown", "register.json"), JSON.stringify(REGISTER, null, 2));
  if (withManifest) {
    fs.writeFileSync(path.join(dir, "burndown-manifest.json"), JSON.stringify(MANIFEST, null, 2));
  }
  fs.writeFileSync(path.join(dir, "REGISTER.md"), "# Register\n");
  fs.copyFileSync(GENERATOR, path.join(dir, ".claude", "bin", "burndown-build.mjs"));
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "h@x.invalid"],
    ["config", "user.name", "h"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fx"],
  ]) {
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

function validQuote(dir, bucket = "ALL PAGES/Open") {
  const r = spawnSync("node", [path.join(dir, ".claude", "bin", "burndown-build.mjs"), "--quote", bucket], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`--quote failed: ${r.stderr}`);
  return r.stdout.trim();
}

function runHook(script, dir, payload) {
  const r = spawnSync("node", [script], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    timeout: 15000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** A hook "fired" iff it emitted a finding rather than a bare passthrough. */
function fired(res) {
  const blob = res.out + res.err;
  return /burndown-integrity\/MUST-[12]|Burndown quote INVALID|NO provenance token/.test(blob);
}

function writePayload(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: abs } };
}

function transcriptPayload(dir, text) {
  const tp = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(
    tp,
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n",
  );
  return { hook_event_name: "Stop", transcript_path: tp };
}

// ── arm (1): INVALID TOKEN → fires, severity block ──────────────────────────

check("arm1/write-guard FIRES on an invalid token in a journal entry", () => {
  const d = mkRepo();
  const q = validQuote(d);
  const tampered = q.replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const res = runHook(WRITE_GUARD, d, writePayload(d, "journal/0001-x.md", `Status: ${tampered}\n`));
  if (!fired(res)) return `did not fire. out=${res.out.slice(0, 300)}`;
  return /block/i.test(res.out + res.err) ? true : "fired but not at severity block";
});

check("arm1/write-guard is SILENT on a VALID token (the no-false-positive pole)", () => {
  const d = mkRepo();
  const res = runHook(WRITE_GUARD, d, writePayload(d, "journal/0001-x.md", `Status: ${validQuote(d)}\n`));
  return !fired(res) ? true : `fired on a valid quote: ${(res.out + res.err).slice(0, 300)}`;
});

check("arm1/stop-guard FIRES on an invalid token in the reply", () => {
  const d = mkRepo();
  const tampered = validQuote(d).replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `We are at ${tampered} right now.`));
  return fired(res) ? true : `did not fire. out=${res.out.slice(0, 300)}`;
});

check("arm1/stop-guard is SILENT on a VALID token", () => {
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `We are at ${validQuote(d)} right now.`));
  return !fired(res) ? true : `fired on a valid quote: ${(res.out + res.err).slice(0, 300)}`;
});

// ── arm (2): UNTOKENED COUNT → fires halt-and-report, never block ───────────

check("arm2/stop-guard FIRES on a count-shaped claim with no token", () => {
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, "We have 3 open items and 2 signed off."));
  return fired(res) ? true : `did not fire. out=${res.out.slice(0, 300)}`;
});

check("arm2/never escalates to block — halt-and-report is the ceiling (MUST-2)", () => {
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, "We have 3 open items and 2 signed off."));
  if (!fired(res)) return "did not fire at all";
  if (/\bBLOCK\b/.test(res.out + res.err)) {
    return "a LEXICAL finding rendered as BLOCK — hook-output-discipline MUST-2 forbids this";
  }
  return true;
});

// MEASURED CEILING, pinned so nobody reads a `block` severity at Stop as teeth.
// `Stop` is a STOP_LIKE event: instructAndWait returns {continue:true,
// systemMessage} and exitCode 0 for EVERY severity. The blocking teeth are on
// the PostToolUse guard, and the next case pins that asymmetry.
check("ceiling/Stop CANNOT block even on a structural invalid-token finding", () => {
  const d = mkRepo();
  const tampered = validQuote(d).replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `We are at ${tampered}.`));
  if (!fired(res)) return "did not fire";
  if (res.code !== 0) return `Stop exited ${res.code}; STOP_LIKE events must exit 0`;
  let j;
  try { j = JSON.parse(res.out.trim().split("\n").pop()); } catch { return "no JSON emitted"; }
  return j.continue === true && typeof j.systemMessage === "string"
    ? true
    : `expected {continue:true, systemMessage}, got ${JSON.stringify(j).slice(0, 160)}`;
});

check("teeth/PostToolUse DOES block on the same structural finding (the asymmetry)", () => {
  const d = mkRepo();
  const tampered = validQuote(d).replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const res = runHook(WRITE_GUARD, d, writePayload(d, "journal/0003-z.md", `At ${tampered}.`));
  if (!fired(res)) return "did not fire";
  if (res.code !== 2) return `expected exit 2 (block), got ${res.code}`;
  let j;
  try { j = JSON.parse(res.out.trim().split("\n").pop()); } catch { return "no JSON emitted"; }
  return j.continue === false ? true : `expected continue:false, got ${JSON.stringify(j).slice(0, 160)}`;
});

check("arm2/is SILENT when the count already carries its token", () => {
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `We have ${validQuote(d)} right now.`));
  return !fired(res) ? true : `fired on a tokenised count: ${(res.out + res.err).slice(0, 300)}`;
});

// The lookahead `(?!⟨)` is what stops arm (2) firing on an ALREADY-COMPLIANT
// count. The case above does NOT exercise it: `--quote` renders
// "2⟨tok⟩ of 3 `Open`", where a backtick sits between the number and the bucket
// word, so the regex never reaches the lookahead and the case would pass with
// the lookahead deleted. Measured: removing `(?!⟨)` left this suite fully green.
// THIS case puts a tokenised count DIRECTLY adjacent to a bucket word, which is
// the only shape that can tell the two apart.
//
// MEASURED OUTCOME, recorded rather than assumed: even WITH this case, deleting
// `(?!⟨)` leaves the suite green. That is an INERT mutation, not a vacuous test,
// and the reason is determinable — the token always immediately follows the
// digits, so the `⟨` character itself already prevents the bucket alternation
// from matching. The lookahead is genuinely redundant with the rest of the
// pattern. It is kept as defensive documentation of intent; do not read its
// deletion surviving as evidence this case is weak.
check("arm2/is SILENT on a full canonical quote — and arm1 accepts it", () => {
  // A BARE `N⟨tok⟩` is INVALID by design since BUG-1: without an adjacent bucket
  // and denominator the token binds only an integer, which is how one certifying
  // "5 of 7 Open" validated a sentence claiming "5 of 5 signed off". So the shape
  // that must stay silent is the FULL canonical quote, not a naked token.
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `We are at ${validQuote(d)} right now.`));
  return !fired(res) ? true : `fired on a canonical quote: ${(res.out + res.err).slice(0, 300)}`;
});


check("arm2/is SILENT on ordinary prose numbers that are not burndown buckets", () => {
  const d = mkRepo();
  const prose = "The suite runs 33 cases in 12 seconds across 5 files and exits 0.";
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, prose));
  return !fired(res) ? true : `fired on ordinary prose: ${(res.out + res.err).slice(0, 300)}`;
});

// ── BUG-4 / BUG-5: an UNKNOWN is reported, never rendered as clean ─────────

function unknownOf(d, text) {
  const lib = require(path.join(HOOKS, "lib", "burndown-quote.js"));
  return lib.verifyText(d, text);
}

check("BUG4/violation — a scan past the size cap returns UNKNOWN, not clean", () => {
  const d = mkRepo();
  const bad = validQuote(d).replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const big = "x".repeat(300 * 1024) + "\n" + bad;
  const res = unknownOf(d, big);
  if (res.ran) return "a truncated scan reported ran:true — the conflation BUG-4 names";
  return res.unknown && /scan cap/.test(res.unknown)
    ? true
    : `no UNKNOWN reason recorded: ${JSON.stringify(res).slice(0, 200)}`;
});

check("BUG4/compliant — the same quote UNDER the cap is checked and found invalid", () => {
  const d = mkRepo();
  const bad = validQuote(d).replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const res = unknownOf(d, `Status: ${bad}`);
  return res.ran && res.invalid.length === 1 && !res.unknown
    ? true
    : `expected a checked invalid, got ${JSON.stringify(res).slice(0, 200)}`;
});

// ── BUG-B: the cap is recorded on BOTH arms, not just the one with a token ────
// BUG-4's fix survived textually but not semantically. `verifyText` returned at
// `!tokenPresent` BEFORE its own size check, so the cap branch was UNREACHABLE for
// untokened text — which is the ONLY path arm (2) uses. The BUG-4 case above cannot
// see this: its fixture carries a token, so it enters through the other door.

check("BUGB/violation — an over-cap UNTOKENED count records the cap, not a silent miss", () => {
  // The rule's OWN MUST-2 archetype (`7 left`), pushed past the cap. Measured
  // before the fix: verifyText → {ran:false, unknown:NULL} and
  // detectUntokenedCounts → [] — a silent miss on BOTH arms at once.
  const d = mkRepo();
  const sentence = "We have 7 left and 3 open.";
  const big = "x".repeat(262 * 1024) + "\n" + sentence;
  const res = unknownOf(d, big);
  if (res.ran) return "a truncated scan reported ran:true";
  return res.unknown && /scan cap/.test(res.unknown)
    ? true
    : `the cap was NOT recorded on the untokened path: ${JSON.stringify(res).slice(0, 200)}`;
});

check("BUGB/compliant — the SAME untokened sentence UNDER the cap is NOT an unknown", () => {
  // The no-false-positive pole: a complete scan must not start reporting unknowns.
  // The lever is length and nothing else — same sentence, same repo.
  const d = mkRepo();
  const sentence = "We have 7 left and 3 open.";
  const res = unknownOf(d, sentence);
  if (res.unknown) return `a complete scan reported an unknown: ${res.unknown}`;
  const lib = require(path.join(HOOKS, "lib", "burndown-quote.js"));
  return lib.detectUntokenedCounts(d, sentence).length === 2
    ? true
    : "the lexical arm did not see the archetype it is written around";
});

check("BUG5/violation — one uncommitted source yields UNKNOWN, not a silent pass", () => {
  const d = mkRepo();
  const q = validQuote(d);
  // Dirty the declared source — the NORMAL state while someone edits the register.
  fs.writeFileSync(path.join(d, "burndown", "register.json"), JSON.stringify({ ...REGISTER, _note: "edited" }, null, 2));
  const res = unknownOf(d, `Status: ${q}`);
  if (res.ran) return "a refused verification reported ran:true";
  return res.unknown && /did not run/.test(res.unknown)
    ? true
    : `no UNKNOWN surfaced: ${JSON.stringify(res).slice(0, 200)}`;
});

check("BUG5/violation — the Stop guard SURFACES that unknown rather than passing silently", () => {
  const d = mkRepo();
  const q = validQuote(d);
  fs.writeFileSync(path.join(d, "burndown", "register.json"), JSON.stringify({ ...REGISTER, _note: "edited" }, null, 2));
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `Status: ${q}`));
  return /DID NOT RUN/.test(res.out + res.err)
    ? true
    : `the guard stayed silent on an unknown: ${(res.out + res.err).slice(0, 200)}`;
});

check("BUG5/compliant — a CLEAN source tree verifies and stays silent", () => {
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `Status: ${validQuote(d)}`));
  return !fired(res) && !/DID NOT RUN/.test(res.out + res.err)
    ? true
    : `fired on a clean tree: ${(res.out + res.err).slice(0, 200)}`;
});

// ── arm (2) vocabulary: the rule's OWN archetype ──────────────────────────

for (const phrase of ["7 left", "3 outstanding", "5 remaining", "2 pending", "4 unresolved", "6 to go"]) {
  check(`arm2/violation — "${phrase}" is surfaced (MUST-2's canonical shape)`, () => {
    const d = mkRepo();
    const res = runHook(STOP_GUARD, d, transcriptPayload(d, `We have ${phrase} on the register.`));
    return fired(res) ? true : `silent on "${phrase}" — the archetype MUST-2 names`;
  });
}

check("arm2/compliant — the honest DENOMINATOR of a valid quote is NOT flagged", () => {
  // Before the mask, `5⟨tok⟩ of 7 Open` tripped arm (2) on "7 Open" — the guard
  // complaining about the truthful half while arm (1) missed the lie.
  const d = mkRepo();
  const q = validQuote(d).replace(/`/g, ""); // strip backticks: the shape that used to trip
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, `Status: ${q}`));
  return !fired(res) ? true : `flagged the honest denominator: ${(res.out + res.err).slice(0, 250)}`;
});

// ── scoping: NO MANIFEST ⇒ silent on both arms ─────────────────────────────

check("scope/stop-guard is SILENT in a repo with NO burndown, even on bucket words", () => {
  const d = mkRepo({ withManifest: false });
  const res = runHook(STOP_GUARD, d, transcriptPayload(d, "We have 3 open items and 2 signed off."));
  return !fired(res) ? true : "fired in a repo that has no burndown at all";
});

check("scope/write-guard is SILENT in a repo with NO burndown", () => {
  const d = mkRepo({ withManifest: false });
  const res = runHook(WRITE_GUARD, d, writePayload(d, "journal/0001-x.md", "5 open, 2 signed off\n"));
  return !fired(res) ? true : "fired in a repo that has no burndown at all";
});

check("scope/write-guard ignores a NON-durable surface", () => {
  const d = mkRepo();
  const tampered = validQuote(d).replace(/(\d+)⟨/, (m, n) => `${Number(n) + 5}⟨`);
  const res = runHook(WRITE_GUARD, d, writePayload(d, "src/thing.ts", `// ${tampered}\n`));
  return !fired(res) ? true : "fired on a non-durable surface";
});

// ── fail-open: every unknown is silent, and exit 0 ─────────────────────────

for (const [label, script, payload] of [
  ["malformed payload", STOP_GUARD, "{not json"],
  ["empty payload", STOP_GUARD, ""],
  ["malformed payload", WRITE_GUARD, "{not json"],
]) {
  check(`fail-open/${path.basename(script)} passes through on a ${label}`, () => {
    const d = mkRepo();
    const r = spawnSync("node", [script], {
      cwd: d,
      input: payload,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: d },
      timeout: 15000,
    });
    if (r.status !== 0) return `exit ${r.status}, expected 0 (fail-open)`;
    return !fired({ out: r.stdout || "", err: r.stderr || "" }) ? true : "fired on an unknown";
  });
}

check("fail-open/stop-guard raises NO BLOCKING finding when the transcript does not exist", () => {
  // RENAMED AND RE-ASSERTED (2026-08-18 security redteam, FINDING-E). This read
  // "is silent when the transcript path does not exist" and asserted `!fired(res)`
  // — but `fired()` matches only the arm-1/arm-2 finding markers, so it is BLIND to
  // an advisory passthrough carrying `additionalContext`. The case would have gone
  // green whether the guard surfaced the unknown or swallowed it, which is the same
  // shape as the BUG-C fixture next door. Fail-open means exit 0 and no BLOCKING
  // finding; it does NOT mean silence, and an unreadable transcript is now surfaced
  // (see the FINDING-E cases below). Both halves are asserted here explicitly.
  const d = mkRepo();
  const res = runHook(STOP_GUARD, d, { hook_event_name: "Stop", transcript_path: path.join(d, "nope.jsonl") });
  if (res.code !== 0) return `exit ${res.code}, expected 0 (fail-open)`;
  return !fired(res) ? true : "raised a blocking-class finding on an unreadable transcript";
});

// ── FINDING-E: an unreadable transcript is an UNKNOWN, not "nothing to check" ──
// `readFinalAssistantText` returned "" for an absent/unreadable transcript AND for
// a reply that genuinely had no text, and the caller mapped both onto one silent
// passthrough. `verifyText` was given a third state for exactly this reason one
// layer down; its caller was not. Each case below reds against the pre-fix guard.

for (const [label, mk] of [
  ["a MISSING transcript file", (d) => ({ hook_event_name: "Stop", transcript_path: path.join(d, "nope.jsonl") })],
  ["NO transcript_path at all", () => ({ hook_event_name: "Stop" })],
  ["an EMPTY transcript file", (d) => {
    const tp = path.join(d, "empty.jsonl");
    fs.writeFileSync(tp, "");
    return { hook_event_name: "Stop", transcript_path: tp };
  }],
]) {
  check(`FINDING-E/violation — ${label} SURFACES an unknown, never a silent pass`, () => {
    const d = mkRepo();
    const res = runHook(STOP_GUARD, d, mk(d));
    if (res.code !== 0) return `exit ${res.code}, expected 0 (an unknown must still fail open)`;
    return /DID NOT RUN/.test(res.out + res.err)
      ? true
      : `the guard passed through silently: ${(res.out + res.err).slice(0, 200)}`;
  });
}

check("FINDING-E/compliant — an assistant turn with NO text block stays SILENT", () => {
  // The no-false-positive pole, and the reason the third state is drawn at "did we
  // see ANY assistant entry" rather than "did we get text". A tool-only turn is the
  // measured-17.3% ordinary case; surfacing an unknown on every one of those would
  // cry wolf until the advisory is ignored, which is how a real unknown gets missed.
  const d = mkRepo();
  const tp = path.join(d, "notext.jsonl");
  fs.writeFileSync(
    tp,
    JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] } }) + "\n",
  );
  const res = runHook(STOP_GUARD, d, { hook_event_name: "Stop", transcript_path: tp });
  const blob = res.out + res.err;
  return res.code === 0 && !fired(res) && !/DID NOT RUN/.test(blob)
    ? true
    : `fired on a genuinely text-free reply: ${blob.slice(0, 200)}`;
});

check("fail-open/write-guard is silent when the written file cannot be read", () => {
  const d = mkRepo();
  const res = runHook(WRITE_GUARD, d, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(d, "journal", "missing.md") },
  });
  return res.code === 0 && !fired(res) ? true : `exit ${res.code}`;
});

check("fail-open/hooks exit 0 on UNKNOWNS — fail-open governs errors, not findings", () => {
  // Deliberately NOT "exits 0 on every path": a genuine finding on a DURABLE
  // write exits 2, and that is the teeth. An earlier revision of this case
  // asserted exit 0 unconditionally and would have passed against a write-guard
  // with no enforcement at all — it was scoring the absence of the feature.
  const d = mkRepo();
  const unknowns = [
    [STOP_GUARD, { hook_event_name: "Stop" }],                       // no transcript_path
    [WRITE_GUARD, { hook_event_name: "PostToolUse", tool_input: {} }], // no file_path
  ];
  for (const [script, payload] of unknowns) {
    const r = runHook(script, d, payload);
    if (r.code !== 0) return `${path.basename(script)} exited ${r.code} on an UNKNOWN; must fail open`;
    if (fired(r)) return `${path.basename(script)} fired on an UNKNOWN`;
  }
  return true;
});

// ── the lib's own scoping predicate ────────────────────────────────────────

check("lib/verifyText reports ran:false (UNKNOWN) rather than clean when it cannot run", () => {
  const lib = require(path.join(HOOKS, "lib", "burndown-quote.js"));
  const d = mkRepo({ withManifest: false });
  const res = lib.verifyText(d, "some 5⟨abcdef⟩ text");
  return res.ran === false && res.invalid.length === 0
    ? true
    : "an unrunnable verification must not report clean";
});

console.log("");
console.log(`burndown-quote-hooks fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
