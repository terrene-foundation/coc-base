#!/usr/bin/env node
/**
 * Audit-fixture runner for `.claude/hooks/lib/override-receipt.js` — the SHARED
 * "structural guard that blocks, with an audited override" mechanism, shipped WITH the
 * library per `cc-artifacts.md` Rule 9.
 *
 * WHY A SHARED LIBRARY HAS ITS OWN FIXTURE SET, separate from its consumers': a
 * consumer's fixtures exercise the gate only along the ONE path that consumer takes.
 * The properties that make an override AUDITED rather than FREE — one-shot
 * consumption, the empty-reason refusal, env-does-not-consume, the reason surviving
 * into the recorded line — are properties OF THE LIBRARY, and a second consumer
 * (`wip-discipline-guard.js`, concurrent lane) inherits them without re-testing.
 * Testing them once, here, is what makes the second adoption free.
 *
 * COVERAGE SHAPE — one case per PROPERTY A WRONG EDIT WOULD SILENTLY BREAK:
 *
 *   1  receipt discovery: which absolute paths are searched, in what order
 *   2  the env channel: what counts as "set"
 *   3  the receipt channel: what counts as a valid receipt
 *   4  ONE-SHOT consumption — the property that stops one override disarming the gate
 *   5  precedence: env wins, and env must NOT eat the receipt
 *   6  the reason is RECORDED, not merely required non-empty
 *   7  sanitisation of an untrusted reason before it is echoed back
 *   8  fail-open / no-throw on every unreadable input
 *
 * BIPOLAR BY CONSTRUCTION: every property carries BOTH an accept pole and a reject
 * pole. A set that only asserts "override honoured" passes identically against a gate
 * that honours everything (i.e. a disarmed gate); a set that only asserts "no
 * override" passes identically against a gate whose override channel is dead — and a
 * dead override channel is exactly the "documented but unreachable" defect the
 * nested-worktree guard's header calls out for an env-only design. Both poles are
 * required to tell those apart.
 *
 * ESTABLISHED RED, MEASURED (`instrument-discipline.md` MUST-2). Before this library
 * existed the whole set failed to load (`MODULE_NOT_FOUND`, exit 1) — verified against the
 * unmodified tree. Each property was then pinned by a mutation asserted to change the file's
 * bytes and re-verified at 36/36 after a byte-identical restore. As OBSERVED:
 *
 *   M-t   remove the one-shot unlink            → 16 17   (and 75 76 at the hook boundary)
 *   M-g   accept an EMPTY receipt               → 11 12
 *   M-i   drop the reason from the record       → 23      (and 74 at the hook boundary)
 *   M-k   check the receipt BEFORE the env      → 19 20 21
 *   M-f   loosen the env test to truthiness     → 07 08
 *   M-d   delete the env channel                → 05 09 19 20 21 26  (and 77 78 e2e)
 *   M-b   drop extraRoots                       → 02
 *   M-o   allow a gate with no receiptRel       → 35
 *   M-l   sanitiser returns the raw value       → 28 29 30
 *
 * THE HOOK-BOUNDARY COLUMN IS THE POINT. Four of these mutations were ALSO read through
 * `audit-fixtures/dispatch-contract/run.mjs`, which drives the real hook as a child process.
 * A shared library's own fixtures can only show the contract holds in isolation; the paired
 * e2e reds show a consumer actually DEPENDS on it, which is what stops this module being
 * quietly bypassed by the next guard that adopts it.
 *
 * Pure functions plus throwaway tmpdirs. No network, no live session, no sink.
 * Every tmpdir is keyed on `process.pid` so concurrent lanes cannot collide.
 */

import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const L = require(path.join(REPO, ".claude/hooks/lib/override-receipt.js"));

const cases = [];
function check(id, name, cond, detail, redsUnder) {
  cases.push({ id, name, pass: !!cond, detail, redsUnder });
}

// Collision-free BY CONSTRUCTION: `mkdtempSync` appends its own random suffix, so the tag is a
// plain literal. Interpolating `process.pid` here would be the shape
// `audit-fixture-tempdir-uniqueness.test.mjs` flags — a root the runner only HOPES is unique
// (a pid is reused after wraparound, and two gate invocations can then tear down each other's
// tree while the other is still reading it).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "override-receipt-"));
const RECEIPT_REL = path.join(".claude", "test-authz", "allow");
const ENV_VAR = "COC_TEST_OVERRIDE_GATE";

/** Build a gate rooted at a throwaway tree. `extraRoots` mirrors real consumer use. */
function gateAt(cwdRoot, extraRoots = []) {
  return L.createOverrideGate({
    receiptRel: RECEIPT_REL,
    envVar: ENV_VAR,
    extraRoots: () => extraRoots,
    cwd: cwdRoot,
  });
}

function writeReceipt(root, body) {
  const p = path.join(root, RECEIPT_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

// ── 1. receipt discovery ────────────────────────────────────────────────────
{
  const invoking = path.join(TMP, "invoking");
  const main = path.join(TMP, "main");
  fs.mkdirSync(invoking, { recursive: true });
  fs.mkdirSync(main, { recursive: true });
  const g = gateAt(invoking, [main]);
  const cands = g.receiptCandidates();

  check(
    "01",
    "the INVOKING tree's receipt path is searched first",
    cands[0] === path.join(invoking, RECEIPT_REL),
    `first=${cands[0]}`,
    "M-a: drop the cwd candidate",
  );
  check(
    "02",
    "an extra root (the main checkout) is ALSO searched",
    cands.includes(path.join(main, RECEIPT_REL)),
    `cands=${cands.length}`,
    "M-b: drop extraRoots — this is the 'documented but unreachable' defect",
  );
  check(
    "03",
    "duplicate roots collapse to ONE candidate",
    gateAt(invoking, [invoking]).receiptCandidates().length === 1,
    "dedup",
    "M-c: drop the dedup guard",
  );
  check(
    "04",
    "every candidate is ABSOLUTE",
    cands.length > 0 && cands.every((c) => path.isAbsolute(c)),
    `n=${cands.length}`,
    "a relative candidate resolves against the hook's cwd, not the repo's",
  );
}

// ── 2. the env channel ──────────────────────────────────────────────────────
{
  const root = path.join(TMP, "env");
  fs.mkdirSync(root, { recursive: true });
  const g = gateAt(root);

  check(
    "05",
    "env set to '1' IS an override",
    g.envOverride({ [ENV_VAR]: "1" })?.source === "env",
    "accept pole",
    "M-d: delete the env channel",
  );
  check(
    "06",
    "env ABSENT is NOT an override",
    g.envOverride({}) === null,
    "reject pole",
    "M-e: return an override unconditionally",
  );
  check(
    "07",
    "env set to '0' is NOT an override",
    g.envOverride({ [ENV_VAR]: "0" }) === null,
    "only the literal '1' arms it",
    "M-f: loosen to a truthiness test",
  );
  check(
    "08",
    "env set to '' is NOT an override",
    g.envOverride({ [ENV_VAR]: "" }) === null,
    "empty string must not arm it",
    "M-f",
  );
  check(
    "09",
    "the env override names its CHANNEL for the record",
    (g.envOverride({ [ENV_VAR]: "1" })?.channel || "").includes(ENV_VAR),
    "channel is recorded",
    "blank the channel string",
  );
}

// ── 3. what counts as a valid receipt ───────────────────────────────────────
{
  const root = path.join(TMP, "receipt-valid");
  fs.mkdirSync(root, { recursive: true });
  const g = gateAt(root);

  check(
    "10",
    "NO receipt on disk is NOT an override",
    g.consumeReceipt() === null,
    "reject pole",
    "M-e",
  );

  writeReceipt(root, "");
  check(
    "11",
    "an EMPTY receipt is NOT an override",
    g.consumeReceipt() === null,
    "a non-empty REASON is the price of the override",
    "M-g: accept any existing file regardless of content",
  );

  writeReceipt(root, "   \n\t  \n");
  check(
    "12",
    "a WHITESPACE-ONLY receipt is NOT an override",
    g.consumeReceipt() === null,
    "trim before the emptiness test",
    "M-g",
  );

  writeReceipt(root, "  nested placement genuinely required for X  \n");
  const hit = g.consumeReceipt();
  check(
    "13",
    "a receipt with a non-empty reason IS an override",
    hit?.source === "receipt",
    "accept pole",
    "M-h: delete the receipt channel",
  );
  check(
    "14",
    "the reason is returned TRIMMED and intact",
    hit?.reason === "nested placement genuinely required for X",
    `reason=${JSON.stringify(hit?.reason)}`,
    "M-i: drop the reason from the return — this is the RECORDED half",
  );
}

// ── 3b. an UNDELETABLE receipt is NOT an override (H1) ──────────────────
// The one-shot property (§ 4 below) is enforced by the UNLINK. When the unlink FAILS the
// receipt is durable, and this module's own header calls a durable receipt "worse than no
// receipt at all" — it lifts the gate for every later call in the session. Until 2026-09-07
// this path returned the override anyway, with detail asserting "CONSUMED (deleted)": a
// false claim about an action that did not happen, disarming all three consumer guards.
{
  const root = path.join(TMP, "receipt-undeletable");
  fs.mkdirSync(root, { recursive: true });
  const g = gateAt(root);
  const p = writeReceipt(root, "genuine reason, but the dir is locked");
  const dir = path.dirname(p);
  const before = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500); // r-x: the file stays READABLE, the unlink cannot succeed

  let res, threw = null;
  try {
    res = g.consumeReceipt();
  } catch (e) {
    threw = e;
  } finally {
    fs.chmodSync(dir, before); // always restore, or the temp tree cannot be cleaned
  }

  check(
    "18a",
    "an UNDELETABLE receipt is NOT honoured as an override",
    threw === null && res === null,
    `threw=${threw ? threw.code || threw.name : "no"} res=${res === null ? "null" : JSON.stringify(res?.source)}`,
    "M-u: honour it anyway — a durable receipt disarms the gate for the whole session",
  );
  check(
    "18b",
    "the receipt is STILL on disk (the precondition actually held)",
    fs.existsSync(p),
    "positive control: if this is false the chmod did not bite and 18a proves nothing",
    "control",
  );
}

// ── 3c. M1 — an undeletable candidate MUST NOT kill the ones behind it ──
// The one-shot unlink correctly refuses to honour a receipt it cannot delete (18a). But
// refusing the whole CALL made one poisoned receipt a DENIAL OF SERVICE on the escape
// hatch: candidates are invoking-tree-FIRST, so an undeletable receipt there is found
// first on every call and an operator's receipt in the main checkout could never be
// reached — leaving all three consumer guards (wip-discipline, nested-worktree,
// dispatch-contract) with a `block` and no working escape. Skipping past it is safe
// BECAUSE it is undeletable: its unlink fails identically every call, so it can never be
// honoured and can never disarm anything.
{
  const inv = path.join(TMP, "m1-invoking");
  const main = path.join(TMP, "m1-main");
  fs.mkdirSync(inv, { recursive: true });
  fs.mkdirSync(main, { recursive: true });
  const pInv = writeReceipt(inv, "poisoned, and undeletable");
  writeReceipt(main, "legitimate operator receipt");
  const dir = path.dirname(pInv);
  const before = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500); // r-x: file stays READABLE, the unlink cannot succeed

  let res, threw = null;
  try {
    res = gateAt(inv, [main]).consumeReceipt();
  } catch (e) {
    threw = e;
  } finally {
    fs.chmodSync(dir, before);
  }

  check(
    "37",
    "an UNDELETABLE candidate does not block a legitimate receipt behind it",
    threw === null && res?.reason === "legitimate operator receipt",
    `threw=${threw ? threw.code || threw.name : "no"} reason=${JSON.stringify(res?.reason)}`,
    "M-v: `return null` instead of `continue` — one poisoned receipt DoS's the escape hatch",
  );
  check(
    "38",
    "the undeletable receipt is STILL on disk (the precondition actually held)",
    fs.existsSync(pInv),
    "positive control: if this is false the chmod did not bite and 37 proves nothing",
    "control",
  );
  check(
    "39",
    "the honoured override is the one from the EXTRA root, not the poisoned candidate",
    res?.consumedPath === path.join(main, RECEIPT_REL),
    `consumedPath=${res?.consumedPath}`,
    "M-v — the reject pole for 37: it must skip TO the sibling, not mis-report the poisoned one",
  );
}

// ── 3d. M1 reject pole — refusal is still TOTAL when every candidate fails ──
{
  const a = path.join(TMP, "m1-all-a");
  const b = path.join(TMP, "m1-all-b");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const pa = writeReceipt(a, "undeletable A");
  const pb = writeReceipt(b, "undeletable B");
  const da = path.dirname(pa), db = path.dirname(pb);
  const ma = fs.statSync(da).mode, mb = fs.statSync(db).mode;
  fs.chmodSync(da, 0o500);
  fs.chmodSync(db, 0o500);
  let res;
  try {
    res = gateAt(a, [b]).consumeReceipt();
  } finally {
    fs.chmodSync(da, ma);
    fs.chmodSync(db, mb);
  }
  check(
    "40",
    "when EVERY candidate is undeletable the result is null (continue is not a bypass)",
    res === null,
    `res=${res === null ? "null" : JSON.stringify(res?.source)}`,
    "M-w: honour an undeletable receipt after skipping — `continue` must not become a way in",
  );
}

// ── 3e. M2 — the surfaced line MUST NOT carry an operator home path ──
// stderr lands in the transcript agents quote into journals and PRs
// (`user-flow-validation.md` MUST-6), and an absolute candidate is
// `/Users/<operator>/repos/...` — exactly `identity-scrub.mjs::makeHomepathRe`'s shape.
{
  const root = fs.mkdtempSync(path.join(os.homedir(), ".override-receipt-fixture-"));
  const p = writeReceipt(root, "genuine reason, undeletable dir");
  const dir = path.dirname(p);
  const before = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500);
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { chunks.push(String(x)); return true; };
  try {
    gateAt(root).consumeReceipt();
  } finally {
    process.stderr.write = orig;
    fs.chmodSync(dir, before);
    fs.rmSync(root, { recursive: true, force: true });
  }
  const line = chunks.join("");

  check(
    "41",
    "the refusal line is EMITTED (absence must be loud, not silent)",
    line.includes("[override-receipt]"),
    `line=${JSON.stringify(line.slice(0, 90))}`,
    "M-x: drop the stderr write — a silent refusal reads as 'no receipt'",
  );
  check(
    "42",
    "the refusal line carries NO operator home path",
    !line.includes(os.homedir()) && !/\/(Users|home)\/[A-Za-z][\w.-]*/.test(line),
    `homedir-present=${line.includes(os.homedir())}`,
    "M-y: emit the ABSOLUTE candidate path — leaks operator PII into the transcript",
  );
  check(
    "43",
    "the refusal line carries the RELATIVE receipt path instead",
    line.includes(RECEIPT_REL),
    `rel=${RECEIPT_REL}`,
    "M-y — without the relative path the operator cannot find the file at all",
  );
  check(
    "44",
    "the refusal line names WHICH root the receipt was found under",
    /invoking tree|extra root #\d+/.test(line),
    "root is identified by a fixed LABEL, never a basename (a basename can be a tenant token)",
    "M-y — 'a receipt somewhere could not be deleted' is not operator-actionable",
  );
}

// ── 3f. M3 — the receipt read is NOT a symlink read primitive ──────────────
// `existsSync` -> `readFileSync` -> `unlinkSync` are all path-based and all follow
// symlinks. `ln -s ~/.aws/credentials <receipt>` made that file's first bytes the
// override "reason", which is echoed into the agent-visible advisory and the
// user-visible line (`safeField` neutralizes control chars but PRESERVES content).
// Bounded by what the hook process can read — i.e. everything the operator can read.
{
  const root = path.join(TMP, "m3-symlink");
  const secret = path.join(TMP, "m3-out-of-tree-secret");
  const SENTINEL = "SENTINEL_OUT_OF_TREE_BYTES";
  fs.writeFileSync(secret, `aws_secret_access_key = ${SENTINEL}\n`);
  const p = path.join(root, RECEIPT_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.symlinkSync(secret, p);

  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { chunks.push(String(x)); return true; };
  let res, threw = null;
  try {
    const g = gateAt(root);
    res = g.consumeReceipt();
  } catch (e) {
    threw = e;
  } finally {
    process.stderr.write = orig;
  }
  const line = chunks.join("");

  check(
    "45",
    "a SYMLINKED receipt is NOT honoured as an override",
    threw === null && res === null,
    `threw=${threw ? threw.code || threw.name : "no"} res=${res === null ? "null" : "HONOURED"}`,
    "M-z: read the receipt by path again — restores the symlink read primitive",
  );
  check(
    "46",
    "the link target's CONTENT never reaches the returned override",
    JSON.stringify(res ?? null).indexOf(SENTINEL) === -1,
    "the whole point: out-of-tree bytes must not become the 'stated reason'",
    "M-z",
  );
  check(
    "47",
    "the link target's CONTENT never reaches the surfaced stderr line either",
    line.indexOf(SENTINEL) === -1,
    "a refusal must not publish the untrusted bytes it exists to contain",
    "M-z2: echo the reader's `reason` (which embeds content + the absolute path) instead of its typed code",
  );
  check(
    "48",
    "the refusal is SURFACED, not silent",
    /could NOT be safely read/.test(line),
    `line=${JSON.stringify(line.slice(0, 90))}`,
    "M-x — a silent refusal is byte-identical to 'no receipt' (conservation-gate MUST-4)",
  );
  check(
    "49",
    "the symlink TARGET is untouched (this was a read primitive, never a delete one)",
    fs.existsSync(secret) && fs.readFileSync(secret, "utf8").includes(SENTINEL),
    "positive control on the threat model as filed",
    "control",
  );
}

// ── 3g. M3 NO-FALSE-POSITIVE POLE — the hardening must not be INERT ────────
// A refusal that refuses everything is not safe, it is a dead override channel — the
// "documented but unreachable" defect this module exists to answer. The legitimate
// regular-file receipt MUST still be read, and an ordinary absent candidate MUST stay
// QUIET (or every guard invocation emits a line).
{
  const root = path.join(TMP, "m3-legit");
  fs.mkdirSync(root, { recursive: true });

  const quiet = [];
  const orig0 = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { quiet.push(String(x)); return true; };
  let absentRes;
  try {
    absentRes = gateAt(root).consumeReceipt();
  } finally {
    process.stderr.write = orig0;
  }
  check(
    "50",
    "an ABSENT candidate is silent (no stderr on the ordinary path)",
    absentRes === null && quiet.join("").length === 0,
    `stderr-bytes=${quiet.join("").length}`,
    "M-aa: make the presence probe loud — every guard call would then emit a line",
  );

  const p = writeReceipt(root, "  nested placement genuinely required for X  \n");
  const hit = gateAt(root).consumeReceipt();
  check(
    "51",
    "a LEGITIMATE regular-file receipt is STILL honoured after the hardening",
    hit?.source === "receipt" &&
      hit?.reason === "nested placement genuinely required for X",
    `reason=${JSON.stringify(hit?.reason)}`,
    "M-bb: refuse every candidate — an inert guard is a dead escape hatch, not a safe one",
  );
  check(
    "52",
    "and it is still CONSUMED (the one-shot property survives the hardening)",
    fs.existsSync(p) === false && gateAt(root).consumeReceipt() === null,
    "the hardened read must not break the unlink half",
    "M-bb",
  );
}

// ── 3h. M3 second-order — a planted FIFO must not HANG the guard ──────────
// The old read was `readFileSync` by path. Against a FIFO (or a character device) that
// call BLOCKS until a writer appears, and a blocking synchronous read starves the hook's
// own 8s fallback timer — the timer cannot fire during it, so the guard wedges the
// session rather than failing open. The shared reader opens
// `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and then `fstat`s for a regular file, so a FIFO is
// refused without any blocking read.
{
  const root = path.join(TMP, "m3-fifo");
  const p = path.join(root, RECEIPT_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let made = false;
  try {
    execFileSync("mkfifo", [p], { stdio: "ignore" });
    made = true;
  } catch {
    made = false; // no mkfifo on this platform — the case reports SKIPPED-as-pass below
  }

  if (made) {
    const t0 = Date.now();
    let res, threw = null;
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      res = gateAt(root).consumeReceipt();
    } catch (e) {
      threw = e;
    } finally {
      process.stderr.write = orig;
    }
    const ms = Date.now() - t0;
    check(
      "53",
      "a FIFO at the receipt path is REFUSED, and does not block the guard",
      threw === null && res === null && ms < 2000,
      `elapsed=${ms}ms res=${res === null ? "null" : "HONOURED"}`,
      "M-cc: drop O_NONBLOCK/the regular-file fstat — readFileSync on a FIFO hangs until a writer appears, starving the 8s fallback timer",
    );
    try {
      fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  } else {
    check("53", "mkfifo unavailable — FIFO refusal not exercised on this platform", true,
      "declared SKIP, not a silent pass", "platform");
  }
}

// ── 3i. M3 containment is keyed on ESCAPE, not on symlink-ness ────────────
// Load-bearing distinction, and the one a reader is most likely to get wrong: the
// hardening does NOT refuse "a symlink". It refuses a path that resolves OUTSIDE every
// declared root, because containment resolves candidate AND root through the same
// resolver (`security.md` § Path Containment). A benign in-repo symlink — an operator who
// symlinks `.claude/wip-authz` to somewhere else inside the same tree — keeps working and
// keeps quiet. Both poles are pinned so a future "simplification" to a plain
// `lstat().isSymbolicLink()` refusal reds here instead of silently killing that operator's
// escape hatch.
{
  const AUTHZ_REL = path.dirname(RECEIPT_REL);

  // ACCEPT POLE — target stays INSIDE the root.
  const inRoot = path.join(TMP, "m3-symlink-inside");
  const realInside = path.join(inRoot, ".claude", "real-authz-inside");
  fs.mkdirSync(realInside, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(inRoot, AUTHZ_REL)), { recursive: true });
  fs.symlinkSync(realInside, path.join(inRoot, AUTHZ_REL));
  fs.writeFileSync(path.join(realInside, path.basename(RECEIPT_REL)), "in-repo symlink is fine\n");
  const quietIn = [];
  const o1 = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { quietIn.push(String(x)); return true; };
  let inRes;
  try { inRes = gateAt(inRoot).consumeReceipt(); } finally { process.stderr.write = o1; }

  check(
    "54",
    "a receipt behind an IN-REPO symlinked dir is still honoured (and silently)",
    inRes?.reason === "in-repo symlink is fine" && quietIn.join("").length === 0,
    `reason=${JSON.stringify(inRes?.reason)} stderr-bytes=${quietIn.join("").length}`,
    "M-dd: refuse on `isSymbolicLink()` instead of on containment — kills a benign operator layout",
  );

  // REJECT POLE — target ESCAPES the root. Identical shape, one difference: where it points.
  const outRoot = path.join(TMP, "m3-symlink-escape");
  const escape = fs.mkdtempSync(path.join(os.tmpdir(), "override-receipt-escape-"));
  fs.mkdirSync(path.join(outRoot, ".claude"), { recursive: true });
  fs.symlinkSync(escape, path.join(outRoot, AUTHZ_REL));
  fs.writeFileSync(path.join(escape, path.basename(RECEIPT_REL)), "out-of-tree receipt\n");
  const loudOut = [];
  const o2 = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => { loudOut.push(String(x)); return true; };
  let outRes;
  try { outRes = gateAt(outRoot).consumeReceipt(); } finally { process.stderr.write = o2; }

  check(
    "55",
    "a receipt behind an ESCAPING symlinked dir is REFUSED, loudly",
    outRes === null && /could NOT be safely read/.test(loudOut.join("")),
    `res=${outRes === null ? "null" : "HONOURED"} loud=${loudOut.join("").length > 0}`,
    "M-ee: drop the containment check — an out-of-tree file could then lift an in-repo gate",
  );
  check(
    "56",
    "the two containment poles DIFFER (not a vacuous pair)",
    (inRes !== null) !== (outRes !== null),
    "in-repo honoured, escaping refused — same shape, opposite verdicts",
    "vacuity guard: a blanket refuse-or-accept makes both poles agree",
  );

  // The discrimination `wip-discipline-guard.js::receiptPriceViolation` needs: an occupied
  // path must report `refused`, never `absent` — the stderr line and the typed reason must
  // not describe the same event differently.
  check(
    "57",
    "readReceiptState reports `refused` (not `absent`) for an occupied-but-unreadable path",
    L.readReceiptState(outRoot, RECEIPT_REL, "invoking tree").state === "refused" &&
      L.readReceiptState(path.join(TMP, "m3-nothing-here"), RECEIPT_REL).state === "absent",
    `escaping=${L.readReceiptState(outRoot, RECEIPT_REL).state}`,
    "M-ff: fold `refused` into `absent` — a loud stderr refusal beside a reason saying 'absent'",
  );
}

// ── 4. ONE-SHOT consumption ─────────────────────────────────────────────────
// The single property that separates an AUDITED override from a DISARMED gate.
{
  const root = path.join(TMP, "one-shot");
  fs.mkdirSync(root, { recursive: true });
  const g = gateAt(root);
  const p = writeReceipt(root, "first and only use");

  const first = g.consumeReceipt();
  const stillOnDisk = fs.existsSync(p);
  const second = g.consumeReceipt();

  check(
    "15",
    "the FIRST call honours the receipt",
    first?.reason === "first and only use",
    "accept pole",
    "M-h",
  );
  check(
    "16",
    "the receipt file is DELETED as it is honoured",
    stillOnDisk === false,
    `onDisk=${stillOnDisk}`,
    "M-j: remove the unlink — one override would disarm the gate forever",
  );
  check(
    "17",
    "the SECOND call is NOT an override (gate re-arms)",
    second === null,
    "the one-shot property",
    "M-j",
  );
  check(
    "18",
    "the honoured override reports WHICH path was consumed",
    first?.consumedPath === p,
    `consumedPath=${first?.consumedPath}`,
    "blank consumedPath — the record must name the file",
  );
}

// ── 5. precedence: env wins, and env must NOT eat the receipt ───────────────
{
  const root = path.join(TMP, "precedence");
  fs.mkdirSync(root, { recursive: true });
  const g = gateAt(root);
  const p = writeReceipt(root, "receipt reason");

  const viaEnv = g.resolveOverride({ [ENV_VAR]: "1" });
  const receiptSurvived = fs.existsSync(p);

  check(
    "19",
    "with env set, resolveOverride reports the ENV channel",
    viaEnv?.source === "env",
    `source=${viaEnv?.source}`,
    "M-k: check the receipt before the env",
  );
  check(
    "20",
    "the env channel does NOT consume a receipt written for a later call",
    receiptSurvived === true,
    `survived=${receiptSurvived}`,
    "M-k — an env run must not silently spend the agent's one-shot receipt",
  );
  check(
    "21",
    "with env UNSET, resolveOverride falls through to the receipt",
    g.resolveOverride({})?.source === "receipt",
    "fall-through arm",
    "M-h",
  );
  check(
    "22",
    "with neither channel armed, resolveOverride is null",
    gateAt(path.join(TMP, "nothing-here")).resolveOverride({}) === null,
    "the all-clear pole — without it a gate that overrides everything passes",
    "M-e",
  );
}

// ── 6. the reason is RECORDED, not merely required ──────────────────────────
{
  const root = path.join(TMP, "recorded");
  fs.mkdirSync(root, { recursive: true });
  const g = gateAt(root);
  writeReceipt(root, "worktree pre-created out of band by the operator");
  const ov = g.resolveOverride({});
  const line = g.formatOverrideLine(ov);

  check(
    "23",
    "the recorded line QUOTES the stated reason",
    line.includes("worktree pre-created out of band by the operator"),
    `line=${line.slice(0, 120)}`,
    "M-i: render the line without the reason — 'non-empty' would then be the only bar",
  );
  check(
    "24",
    "the recorded line names the CHANNEL",
    /receipt/i.test(line),
    "channel is recorded",
    "blank the channel",
  );
  check(
    "25",
    "the recorded line states the receipt was CONSUMED",
    /consumed/i.test(line),
    "one-shot is surfaced, not just implemented",
    "drop the consumed wording",
  );
  check(
    "26",
    "an ENV override renders a line too, naming the env var",
    g.formatOverrideLine(g.envOverride({ [ENV_VAR]: "1" })).includes(ENV_VAR),
    "both channels are recordable",
    "M-d",
  );
  check(
    "27",
    "formatOverrideInstruction names the receipt path AND the one-shot property",
    g.formatOverrideInstruction().includes(RECEIPT_REL) &&
      /one-shot|consumed/i.test(g.formatOverrideInstruction()),
    "the escape must be reachable from the block text",
    "an unreachable escape is the MUST NOT the override answers",
  );
}

// ── 7. sanitisation of an untrusted reason ──────────────────────────────────
// The reason is agent-authored and is echoed back into text the agent reads as
// authoritative — a prompt-injection and terminal-escape surface.
{
  check(
    "28",
    "control characters are stripped",
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f-\x9f]/.test(L.safeField("a\x1b[31mb\x07c", "fb")),
    "ANSI/OSC introducers neutralised",
    "M-l: return the raw value",
  );
  check(
    "29",
    "square brackets are stripped so a status marker cannot be FORGED",
    !L.safeField("[BLOCK] fake marker", "fb").includes("["),
    "marker forgery closed",
    "M-l",
  );
  check(
    "30",
    "an over-long reason is bounded and marked truncated",
    L.safeField("x".repeat(500), "fb").length <= L.FIELD_MAX + 1 &&
      L.safeField("x".repeat(500), "fb").endsWith("…"),
    "bounded echo",
    "M-m: drop the length bound",
  );
  check(
    "31",
    "an empty/non-string value falls back rather than rendering blank",
    L.safeField("", "FALLBACK") === "FALLBACK" &&
      L.safeField(null, "FALLBACK") === "FALLBACK",
    "no silent empty field",
    "M-l",
  );
  check(
    "32",
    "an ordinary reason passes through unmangled",
    L.safeField("worktree pre-created by operator", "fb") ===
      "worktree pre-created by operator",
    "the no-false-positive pole for the sanitiser",
    "over-aggressive stripping",
  );
}

// ── 8. fail-open / no-throw on unreadable input ─────────────────────────────
{
  check(
    "33",
    "a gate over a NON-EXISTENT tree yields no override and does not throw",
    gateAt(path.join(TMP, "does-not-exist-at-all")).resolveOverride({}) === null,
    "fail open",
    "M-n: let the fs error escape",
  );
  check(
    "34",
    "a receipt path that is a DIRECTORY is not an override and does not throw",
    (() => {
      const root = path.join(TMP, "dir-receipt");
      fs.mkdirSync(path.join(root, RECEIPT_REL), { recursive: true });
      return gateAt(root).consumeReceipt() === null;
    })(),
    "readFileSync on a dir throws EISDIR — must be caught",
    "M-n",
  );
  check(
    "35",
    "createOverrideGate REFUSES a missing receiptRel rather than silently no-op'ing",
    (() => {
      try {
        L.createOverrideGate({ envVar: ENV_VAR });
        return false;
      } catch {
        return true;
      }
    })(),
    "a misconfigured gate must be LOUD at construction, never a dead channel",
    "M-o: default receiptRel to something — a silently dead override channel",
  );
  check(
    "36",
    "createOverrideGate REFUSES a missing envVar",
    (() => {
      try {
        L.createOverrideGate({ receiptRel: RECEIPT_REL });
        return false;
      } catch {
        return true;
      }
    })(),
    "same LOUD-at-construction contract",
    "M-o",
  );
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* best effort */
}

let failed = 0;
for (const c of cases) {
  const tag = c.pass ? "PASS" : "FAIL";
  if (!c.pass) failed++;
  process.stdout.write(`${tag}  ${c.id}  ${c.name}  [${c.detail}]\n`);
}
process.stdout.write(`\n${cases.length - failed}/${cases.length} cases pass\n`);
process.exit(failed === 0 ? 0 : 1);
