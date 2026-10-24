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
 * into the recorded line, the call binding, the TTL, the use ledger — are properties OF
 * THE LIBRARY, and every consumer inherits them without re-testing. Testing them once,
 * here, is what makes each adoption free.
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
 *   9  CALL BINDING (60–72): a receipt for call A lifts A, does NOT lift B, is NOT
 *      consumed by B, and B's refusal is NAMED and VISIBLE; the digest's canonical
 *      serialization is pinned by a known-answer recomputation
 *  10  TTL (73–78): stale and future-dated receipts refused and left in place
 *  11  THE USE LEDGER (79–88): one row per honoured receipt, in the MAIN checkout, never
 *      a row for a refused one, and an unrecordable use is REFUSED with the receipt put back
 *  12  the non-destructive PEEK (89–91) applies the consume path's own validity test
 *
 * RECEIPTS ARE CALL-BOUND JSON (2026-10-10). Every receipt below is the one-line JSON
 * object `{digest, reason, written_at}` the library documents, built by `receipt()`.
 * A tree in which a receipt is HONOURED must be a real git repository: the use ledger is
 * resolved to the MAIN checkout through git, and an unresolvable one REFUSES the override
 * (case 86). So `gitRepo()` builds every tree whose case expects an honour, and the trees
 * that expect a refusal for some OTHER reason are git repos too — otherwise they would be
 * refused for the ledger, and pass for the wrong reason.
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
 * The 2026-10-10 binding cases (60–91) carry their own measured matrix, recorded in the
 * lane's report and in the commit that landed them; their `redsUnder` column names the
 * mutation each one exists to catch.
 *
 * ── the ENOENT-ONLY presence probe + its remedy (loom B1 durable-io lane, cases 58, 59, 92, 93;
 *    92 and 93 were 60 and 61 on the lane and were renumbered when it rebased onto the binding set).
 *    MEASURED 2026-10-13 against lane commit 607bb2b26 (tree 1eb56b2215d7) on a git-archive COPY
 *    via `trestle run` on a remote fleet host as uid 1001 (so 92 ran its real mode-000 branch).
 *    Unmutated baseline in the same battery: 63/63. Reach proof: the replacement matched once and
 *    the file's sha256 changed; the non-empty red-set proves the line executed. Neither mutation
 *    red anything in delegation-default, append-sink-hardening or transport-filesystem.
 *
 *   M-P5  the presence probe returns `absent` on ANY lstat failure   → 58 59 92 93
 *         (93 joins because with no stderr line there is no remedy to name the parent)
 *   M-P8  drop the probe-failure remedy (every refusal says "replace
 *         it with a plain regular file")                           → 93
 *
 * THE HOOK-BOUNDARY COLUMN IS THE POINT. Several of these mutations were ALSO read through
 * `audit-fixtures/dispatch-contract/run.mjs`, which drives the real hook as a child process.
 * A shared library's own fixtures can only show the contract holds in isolation; the paired
 * e2e reds show a consumer actually DEPENDS on it, which is what stops this module being
 * quietly bypassed by the next guard that adopts it.
 *
 * Pure functions plus throwaway tmpdirs (git repositories where a case needs one). No
 * network, no live session. Every tree is a runner-created `mkdtemp`, so concurrent lanes
 * cannot collide, and the only ledger rows written are inside those trees.
 */

import "../_lib/no-ambient-git.cjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";

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
// tree while the other is still reading it). realpath'd so the main-checkout comparison in the
// ledger cases is not split by a /var vs /private/var spelling.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "override-receipt-")));
const RECEIPT_REL = path.join(".claude", "test-authz", "allow");
const ENV_VAR = "COC_TEST_OVERRIDE_GATE";

// A trust-state redirect inherited from the operator's shell would re-point the ledger's
// main-checkout resolution (state-resolver honours it when it is a valid learning dir). The
// cases below build their own repositories and must not depend on the caller's environment.
delete process.env.CLAUDE_TRUST_STATE_DIR;

/** Two distinct calls. A receipt for A must lift A and nothing else. */
const CALL_A = { tool: "Task", input: { prompt: "lift call A", subagent_type: "analyst" }, ids: ["test/finding-a"] };
const CALL_B = { tool: "Task", input: { prompt: "lift call B", subagent_type: "analyst" }, ids: ["test/finding-a"] };
const DIGEST_A = L.callDigestOf(CALL_A.tool, CALL_A.input, CALL_A.ids);
const DIGEST_B = L.callDigestOf(CALL_B.tool, CALL_B.input, CALL_B.ids);

/** Build a gate rooted at a throwaway tree. `extraRoots` mirrors real consumer use. */
function gateAt(cwdRoot, extraRoots = []) {
  return L.createOverrideGate({
    receiptRel: RECEIPT_REL,
    envVar: ENV_VAR,
    extraRoots: () => extraRoots,
    cwd: cwdRoot,
  });
}

/** A directory that is ALSO a git repository, so the use ledger can resolve its main checkout. */
function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  dir = fs.realpathSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (fs.realpathSync(top) !== dir) throw new Error("receipt fixture STEP0 root mismatch");
  return dir;
}

/** The receipt line, exactly as a blocked caller writes it. */
function receipt(digest, reason, writtenAt) {
  return JSON.stringify({
    digest,
    reason,
    written_at: writtenAt || new Date().toISOString(),
  });
}

function writeReceipt(root, body) {
  const p = path.join(root, RECEIPT_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

/** Run `fn` with stderr captured; returns [result, capturedText]. */
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (x) => {
    chunks.push(String(x));
    return true;
  };
  try {
    return [fn(), chunks.join("")];
  } finally {
    process.stderr.write = orig;
  }
}

const ledgerAt = (root) => path.join(root, L.USE_LEDGER_REL);
function ledgerRows(root) {
  try {
    return fs
      .readFileSync(ledgerAt(root), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
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
  const root = gitRepo(path.join(TMP, "receipt-valid"));
  const g = gateAt(root);

  check(
    "10",
    "NO receipt on disk is NOT an override",
    g.consumeReceipt(DIGEST_A) === null,
    "reject pole",
    "M-e",
  );

  writeReceipt(root, "");
  check(
    "11",
    "an EMPTY receipt is NOT an override",
    captureStderr(() => g.consumeReceipt(DIGEST_A))[0] === null,
    "a non-empty REASON is the price of the override",
    "M-g: accept any existing file regardless of content",
  );

  writeReceipt(root, receipt(DIGEST_A, "   \n\t  "));
  check(
    "12",
    "a WHITESPACE-ONLY reason is NOT an override",
    captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A))[0] === null,
    "trim before the emptiness test",
    "M-g",
  );

  writeReceipt(root, receipt(DIGEST_A, "  nested placement genuinely required for X  "));
  const hit = gateAt(root).consumeReceipt(DIGEST_A);
  check(
    "13",
    "a receipt bound to THIS call with a non-empty reason IS an override",
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
  const root = gitRepo(path.join(TMP, "receipt-undeletable"));
  const g = gateAt(root);
  const p = writeReceipt(root, receipt(DIGEST_A, "genuine reason, but the dir is locked"));
  const dir = path.dirname(p);
  const before = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500); // r-x: the file stays READABLE, the unlink cannot succeed

  let res, threw = null, err = "";
  try {
    [res, err] = captureStderr(() => g.consumeReceipt(DIGEST_A));
  } catch (e) {
    threw = e;
  } finally {
    fs.chmodSync(dir, before); // always restore, or the temp tree cannot be cleaned
  }

  check(
    "18a",
    "an UNDELETABLE receipt is NOT honoured as an override — and it is the UNLINK that refused it",
    threw === null && res === null && err.includes(L.REFUSAL.UNDELETABLE),
    `threw=${threw ? threw.code || threw.name : "no"} res=${res === null ? "null" : JSON.stringify(res?.source)} named=${err.includes(L.REFUSAL.UNDELETABLE)}`,
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
// reached. Skipping past it is safe BECAUSE it is undeletable: its unlink fails
// identically every call, so it can never be honoured and can never disarm anything.
{
  const inv = gitRepo(path.join(TMP, "m1-invoking"));
  const main = gitRepo(path.join(TMP, "m1-main"));
  const pInv = writeReceipt(inv, receipt(DIGEST_A, "poisoned, and undeletable"));
  writeReceipt(main, receipt(DIGEST_A, "legitimate operator receipt"));
  const dir = path.dirname(pInv);
  const before = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500); // r-x: file stays READABLE, the unlink cannot succeed

  let res, threw = null;
  try {
    [res] = captureStderr(() => gateAt(inv, [main]).consumeReceipt(DIGEST_A));
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
  const a = gitRepo(path.join(TMP, "m1-all-a"));
  const b = gitRepo(path.join(TMP, "m1-all-b"));
  const pa = writeReceipt(a, receipt(DIGEST_A, "undeletable A"));
  const pb = writeReceipt(b, receipt(DIGEST_A, "undeletable B"));
  const da = path.dirname(pa), db = path.dirname(pb);
  const ma = fs.statSync(da).mode, mb = fs.statSync(db).mode;
  fs.chmodSync(da, 0o500);
  fs.chmodSync(db, 0o500);
  let res;
  try {
    [res] = captureStderr(() => gateAt(a, [b]).consumeReceipt(DIGEST_A));
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
  gitRepo(root);
  const p = writeReceipt(root, receipt(DIGEST_A, "genuine reason, undeletable dir"));
  const dir = path.dirname(p);
  const before = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500);
  let line = "";
  try {
    [, line] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  } finally {
    fs.chmodSync(dir, before);
    fs.rmSync(root, { recursive: true, force: true });
  }

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
  const root = gitRepo(path.join(TMP, "m3-symlink"));
  const secret = path.join(TMP, "m3-out-of-tree-secret");
  const SENTINEL = "SENTINEL_OUT_OF_TREE_BYTES";
  // The out-of-tree file is even shaped like a VALID receipt for this call, so the only
  // thing that can refuse it is the containment of the read.
  fs.writeFileSync(secret, receipt(DIGEST_A, `aws_secret_access_key = ${SENTINEL}`));
  const p = path.join(root, RECEIPT_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.symlinkSync(secret, p);

  let res, threw = null, line = "";
  try {
    [res, line] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  } catch (e) {
    threw = e;
  }

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
  const root = gitRepo(path.join(TMP, "m3-legit"));

  const [absentRes, quiet] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  check(
    "50",
    "an ABSENT candidate is silent (no stderr on the ordinary path)",
    absentRes === null && quiet.length === 0,
    `stderr-bytes=${quiet.length}`,
    "M-aa: make the presence probe loud — every guard call would then emit a line",
  );

  const p = writeReceipt(root, receipt(DIGEST_A, "  nested placement genuinely required for X  "));
  const hit = gateAt(root).consumeReceipt(DIGEST_A);
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
    fs.existsSync(p) === false && gateAt(root).consumeReceipt(DIGEST_A) === null,
    "the hardened read must not break the unlink half",
    "M-bb",
  );
}

// ── 3g2. ENOENT-ONLY quiet path — a FAILED presence probe is not absence ──
// The probe decides QUIET vs LOUD. It used to return `absent` on ANY lstat failure, so an
// EACCES/ELOOP/ENOTDIR at the receipt path read exactly like "no receipt" — the
// absence-reads-as-clean shape. Only ENOENT stays quiet now; anything else falls through
// to the guarded read, whose refusal is LOUD. Case 50 is the quiet pole for 58, 59 and 92, and 93
// pins that the LOUD line's remedy points at the parent directory, which is where the fault is.
{
  const loudOf = (root) => {
    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (x) => { chunks.push(String(x)); return true; };
    let res;
    try {
      res = gateAt(root).consumeReceipt();
    } finally {
      process.stderr.write = orig;
    }
    return { res, err: chunks.join("") };
  };

  // ENOTDIR: the receipt's parent directory is a regular FILE.
  const rootA = path.join(TMP, "probe-enotdir");
  fs.mkdirSync(path.join(rootA, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(rootA, path.dirname(RECEIPT_REL)), "not a directory\n");
  const a = loudOf(rootA);
  check(
    "58",
    "an ENOTDIR presence probe is LOUD (refused + warning), never a silent absent",
    a.res === null && /could NOT be safely read/.test(a.err),
    `stderr=${JSON.stringify(a.err.slice(0, 160))}`,
    "M-P5: restore `return absent` on every lstat failure in the presence probe",
  );

  // ELOOP: the receipt's parent directory is a self-referential symlink.
  const rootB = path.join(TMP, "probe-eloop");
  fs.mkdirSync(path.join(rootB, ".claude"), { recursive: true });
  const loop = path.join(rootB, path.dirname(RECEIPT_REL));
  fs.symlinkSync(loop, loop);
  const b = loudOf(rootB);
  check(
    "59",
    "an ELOOP presence probe is LOUD (refused + warning), never a silent absent",
    b.res === null && /could NOT be safely read/.test(b.err),
    `stderr=${JSON.stringify(b.err.slice(0, 160))}`,
    "M-P5",
  );

  // EACCES: the receipt's parent directory cannot be searched. EMITTED ON BOTH BRANCHES, so the
  // case count never depends on the uid: as non-root a real mode-000 directory denies the probe;
  // as root (which bypasses DAC, so mode 000 denies nothing) the same EACCES is driven
  // deterministically by a lying `lstatSync` on that parent and everything beneath it — the
  // lying-instrument technique delegation-default 190 uses. `seamFired` proves the root branch
  // actually reached the probe rather than passing vacuously.
  const rootC = path.join(TMP, "probe-eacces");
  fs.mkdirSync(path.join(rootC, ".claude"), { recursive: true });
  const sealed = path.join(rootC, path.dirname(RECEIPT_REL));
  fs.mkdirSync(sealed, { mode: 0o700 });
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  let c;
  let seamFired = 0;
  if (isRoot) {
    const realLs = fs.lstatSync;
    fs.lstatSync = (q, ...rest) => {
      const s = String(q);
      if (s === sealed || s.startsWith(sealed + path.sep)) {
        seamFired++;
        const e = new Error("EACCES: fixture"); e.code = "EACCES"; throw e;
      }
      return realLs.call(fs, q, ...rest);
    };
    try { c = loudOf(rootC); } finally { fs.lstatSync = realLs; }
  } else {
    fs.chmodSync(sealed, 0o000);
    try { c = loudOf(rootC); } finally { fs.chmodSync(sealed, 0o700); }
  }
  check(
    "92",
    "an EACCES presence probe (unsearchable parent) is LOUD (refused + warning), never a silent absent",
    c.res === null && /could NOT be safely read/.test(c.err) && /EACCES/.test(c.err) &&
      (isRoot ? seamFired > 0 : true),
    `branch=${isRoot ? "root (lying lstat seam, fired " + seamFired + "x)" : "non-root (real mode 000)"} ` +
      `stderr=${JSON.stringify(c.err.slice(0, 160))}`,
    "M-P5",
  );

  // THE REMEDY IS BIPOLAR. A presence-probe failure (58/59/92) is a PARENT-DIRECTORY problem —
  // nothing need occupy the receipt path at all — so its remedy must name the parent. An
  // OCCUPIED receipt path (here a directory standing where the receipt file belongs) keeps the
  // "replace it with a plain regular file" remedy. One assertion covering both poles stops a
  // remedy that always (or never) names the parent from passing.
  const rootD = path.join(TMP, "probe-occupied");
  fs.mkdirSync(path.join(rootD, RECEIPT_REL), { recursive: true });
  const d = loudOf(rootD);
  const parentRemedy = (s) => /PARENT DIRECTORY/.test(s);
  check(
    "93",
    "a refusal's remedy names the PARENT directory exactly when the presence probe failed",
    parentRemedy(a.err) && parentRemedy(b.err) && parentRemedy(c.err) &&
      d.res === null && /could NOT be safely read/.test(d.err) && !parentRemedy(d.err) &&
      /plain regular file/.test(d.err),
    `enotdir=${parentRemedy(a.err)} eloop=${parentRemedy(b.err)} eacces=${parentRemedy(c.err)} ` +
      `occupied=${parentRemedy(d.err)} occupiedStderr=${JSON.stringify(d.err.slice(0, 120))}`,
    "M-P8: drop the probe-failure remedy (every refusal says 'replace it with a plain regular file')",
  );

  // THE DIRECT PATH. Every case above reaches the refusal through a gate, i.e. through the
  // caller's de-duplicating `onRefused` callback. `readReceiptState` passes NO callback, so its
  // refusal is written by `readReceiptGuarded`'s own direct branch — a branch no other case
  // pins: silencing it, or flipping its receipt fate, left the whole suite green (B1 rebase
  // security check, LOW-2). The occupied path from 93 is reused, read with no gate at all.
  const [direct, directErr] = captureStderr(() => L.readReceiptState(rootD, RECEIPT_REL, "invoking tree"));
  check(
    "94",
    "the DIRECT path (no callback) writes its own refusal line, and says the receipt was left in place",
    direct.state === "refused" &&
      new RegExp("^\\[override-receipt\\] RECEIPT-UNREADABLE: receipt " + RECEIPT_REL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") +
        " under the invoking tree could NOT be safely read").test(directErr) &&
      /NOT honoured, NOT consumed — left in place\./.test(directErr),
    `state=${direct.state} stderr=${JSON.stringify(directErr.slice(0, 200))}`,
    "M-RES3: silence the direct branch's emitRefusalLine · M-RES4: pass leftInPlace=false on the direct branch",
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
    try {
      [res] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
    } catch (e) {
      threw = e;
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
  const inRoot = gitRepo(path.join(TMP, "m3-symlink-inside"));
  const realInside = path.join(inRoot, ".claude", "real-authz-inside");
  fs.mkdirSync(realInside, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(inRoot, AUTHZ_REL)), { recursive: true });
  fs.symlinkSync(realInside, path.join(inRoot, AUTHZ_REL));
  fs.writeFileSync(
    path.join(realInside, path.basename(RECEIPT_REL)),
    receipt(DIGEST_A, "in-repo symlink is fine"),
  );
  const [inRes, quietIn] = captureStderr(() => gateAt(inRoot).consumeReceipt(DIGEST_A));

  check(
    "54",
    "a receipt behind an IN-REPO symlinked dir is still honoured (and silently)",
    inRes?.reason === "in-repo symlink is fine" && quietIn.length === 0,
    `reason=${JSON.stringify(inRes?.reason)} stderr-bytes=${quietIn.length}`,
    "M-dd: refuse on `isSymbolicLink()` instead of on containment — kills a benign operator layout",
  );

  // REJECT POLE — target ESCAPES the root. Identical shape, one difference: where it points.
  const outRoot = gitRepo(path.join(TMP, "m3-symlink-escape"));
  const escape = fs.mkdtempSync(path.join(os.tmpdir(), "override-receipt-escape-"));
  fs.mkdirSync(path.join(outRoot, ".claude"), { recursive: true });
  fs.symlinkSync(escape, path.join(outRoot, AUTHZ_REL));
  fs.writeFileSync(
    path.join(escape, path.basename(RECEIPT_REL)),
    receipt(DIGEST_A, "out-of-tree receipt"),
  );
  const [outRes, loudOut] = captureStderr(() => gateAt(outRoot).consumeReceipt(DIGEST_A));

  check(
    "55",
    "a receipt behind an ESCAPING symlinked dir is REFUSED, loudly",
    outRes === null && /could NOT be safely read/.test(loudOut),
    `res=${outRes === null ? "null" : "HONOURED"} loud=${loudOut.length > 0}`,
    "M-ee: drop the containment check — an out-of-tree file could then lift an in-repo gate",
  );
  check(
    "56",
    "the two containment poles DIFFER (not a vacuous pair)",
    (inRes !== null) !== (outRes !== null),
    "in-repo honoured, escaping refused — same shape, opposite verdicts",
    "vacuity guard: a blanket refuse-or-accept makes both poles agree",
  );

  // An occupied path must report `refused`, never `absent` — the stderr line and the typed
  // reason must not describe the same event differently.
  const [states] = captureStderr(() => [
    L.readReceiptState(outRoot, RECEIPT_REL, "invoking tree").state,
    L.readReceiptState(path.join(TMP, "m3-nothing-here"), RECEIPT_REL).state,
  ]);
  check(
    "57",
    "readReceiptState reports `refused` (not `absent`) for an occupied-but-unreadable path",
    states[0] === "refused" && states[1] === "absent",
    `escaping=${states[0]} nothing=${states[1]}`,
    "M-ff: fold `refused` into `absent` — a loud stderr refusal beside a reason saying 'absent'",
  );
  fs.rmSync(escape, { recursive: true, force: true });
}

// ── 4. ONE-SHOT consumption ─────────────────────────────────────────────────
// The single property that separates an AUDITED override from a DISARMED gate.
{
  const root = gitRepo(path.join(TMP, "one-shot"));
  const g = gateAt(root);
  const p = writeReceipt(root, receipt(DIGEST_A, "first and only use"));

  const first = g.consumeReceipt(DIGEST_A);
  const stillOnDisk = fs.existsSync(p);
  const second = g.consumeReceipt(DIGEST_A);

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
  const root = gitRepo(path.join(TMP, "precedence"));
  const g = gateAt(root);
  const p = writeReceipt(root, receipt(DIGEST_A, "receipt reason"));

  const viaEnv = g.resolveOverride({ digest: DIGEST_A, env: { [ENV_VAR]: "1" } });
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
    g.resolveOverride({ digest: DIGEST_A, env: {} })?.source === "receipt",
    "fall-through arm",
    "M-h",
  );
  check(
    "22",
    "with neither channel armed, resolveOverride is null",
    gateAt(path.join(TMP, "nothing-here")).resolveOverride({ digest: DIGEST_A, env: {} }) === null,
    "the all-clear pole — without it a gate that overrides everything passes",
    "M-e",
  );
}

// ── 6. the reason is RECORDED, not merely required ──────────────────────────
{
  const root = gitRepo(path.join(TMP, "recorded"));
  const g = gateAt(root);
  writeReceipt(root, receipt(DIGEST_A, "worktree pre-created out of band by the operator"));
  const ov = g.resolveOverride({ digest: DIGEST_A, env: {} });
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
  const instr = g.formatOverrideInstruction(DIGEST_A);
  check(
    "27",
    "formatOverrideInstruction names the receipt path AND the one-shot property",
    instr.includes(RECEIPT_REL) && /one-shot|consumed/i.test(instr),
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
    gateAt(path.join(TMP, "does-not-exist-at-all")).resolveOverride({ digest: DIGEST_A, env: {} }) === null,
    "fail open",
    "M-n: let the fs error escape",
  );
  check(
    "34",
    "a receipt path that is a DIRECTORY is not an override and does not throw",
    (() => {
      const root = path.join(TMP, "dir-receipt");
      fs.mkdirSync(path.join(root, RECEIPT_REL), { recursive: true });
      return captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A))[0] === null;
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

// ── 9. CALL BINDING — a receipt for call A lifts A, and NOTHING ELSE ─────────
// Until 2026-10-10 any non-empty receipt lifted any blocked call on the channel: one written
// for blocked dispatch A lifted whichever blocked dispatch arrived first. These cases are the
// binding's two poles plus the NEGATIVE CONTROL that makes them discriminate: 60 is the
// accept pole on the SAME tree shape as 61–64, so a gate that refuses everything fails 60,
// and a gate that ignores the digest fails 61–64.
{
  const root = gitRepo(path.join(TMP, "bind"));
  const p = writeReceipt(root, receipt(DIGEST_A, "written for call A only"));
  const bytesBefore = fs.readFileSync(p, "utf8");

  const gB = gateAt(root);
  const [resB, errB] = captureStderr(() => gB.resolveOverride({ digest: DIGEST_B, env: {} }));
  check(
    "61",
    "a receipt written for call A does NOT lift call B",
    resB === null,
    `res=${resB === null ? "null" : "HONOURED"}`,
    "M-BIND: drop the digest comparison — any receipt lifts any blocked call again",
  );
  check(
    "62",
    "call B does NOT consume call A's receipt — it is left in place, byte-identical",
    fs.existsSync(p) && fs.readFileSync(p, "utf8") === bytesBefore,
    `onDisk=${fs.existsSync(p)}`,
    "M-BIND / M-CONSUME-ON-MISMATCH: spend the receipt before checking the call",
  );
  check(
    "63",
    "B's refusal is NAMED and LOUD on stderr",
    errB.includes(L.REFUSAL.DIGEST_MISMATCH) && /left in place/.test(errB),
    `stderr=${JSON.stringify(errB.slice(0, 120))}`,
    "M-SILENT-MISMATCH: refuse quietly — 'your receipt was refused' reads as 'there is no receipt'",
  );
  check(
    "64",
    "B's refusal reaches the AGENT-VISIBLE block text too (formatOverrideInstruction)",
    gB.formatOverrideInstruction(DIGEST_B).includes(L.REFUSAL.DIGEST_MISMATCH) &&
      gB.refusalLines().some((l) => l.includes(L.REFUSAL.DIGEST_MISMATCH)),
    `lines=${gB.refusalLines().length}`,
    "M-NOTES: drop the refusal notes from the block text — stderr alone is not the agent channel on a non-blocking path",
  );

  // The ACCEPT pole, on the SAME receipt B just refused: it was genuinely left usable.
  const resA = gateAt(root).resolveOverride({ digest: DIGEST_A, env: {} });
  check(
    "60",
    "the SAME receipt still lifts call A after B was refused (accept pole / negative control)",
    resA?.source === "receipt" && resA?.reason === "written for call A only" && resA?.digest === DIGEST_A,
    `source=${resA?.source} digest=${resA?.digest === DIGEST_A}`,
    "M-REFUSE-ALL: a gate that refuses every receipt passes 61–64 and fails here",
  );
}

// ── 9b. what the digest covers — every element moves it, nothing else does ───
{
  const base = { tool: "Task", input: { prompt: "p", subagent_type: "s" }, ids: ["r/1", "r/2"] };
  const d = (o) => L.callDigestOf(o.tool, o.input, o.ids);
  const d0 = d(base);
  check(
    "65",
    "the digest MOVES with the tool, the subagent type, the prompt and the finding ids",
    d0 !== d({ ...base, tool: "Agent" }) &&
      d0 !== d({ ...base, input: { prompt: "p", subagent_type: "t" } }) &&
      d0 !== d({ ...base, input: { prompt: "q", subagent_type: "s" } }) &&
      d0 !== d({ ...base, ids: ["r/1"] }),
    `d0=${d0.slice(0, 12)}`,
    "M-PARTIAL: drop an element from the serialization — calls differing only in it share a receipt",
  );
  check(
    "66",
    "finding-id ORDER and DUPLICATES do not move it, and `description` is not bound",
    d0 === d({ ...base, ids: ["r/2", "r/1", "r/1"] }) &&
      d0 === d({ ...base, input: { prompt: "p", subagent_type: "s", description: "rephrased" } }),
    "sorted + de-duplicated ids; an honest retry may rephrase its description",
    "M-ORDER: hash the ids in arrival order — the same block can print two digests",
  );
  // KNOWN-ANSWER: recompute the documented serialization independently. A change to the
  // library's serialization that is not ALSO a change to its documentation reds here.
  const documented = crypto
    .createHash("sha256")
    .update(
      JSON.stringify(["coc-override-receipt/call-digest/v1", "Task", "s", "p", ["r/1", "r/2"]]),
      "utf8",
    )
    .digest("hex");
  check(
    "67",
    "the digest equals sha256 over the DOCUMENTED canonical JSON array (known answer)",
    d0 === documented && L.CALL_DIGEST_DOMAIN === "coc-override-receipt/call-digest/v1",
    `lib=${d0.slice(0, 12)} documented=${documented.slice(0, 12)}`,
    "M-SERIAL: change the serialization without the header — receipts written from the docs stop matching",
  );
  // Each pair moves ONE delimiter across the subagent/prompt boundary: a serialization that
  // JOINS the elements with that delimiter maps both members of its pair to the same bytes.
  const forged = ["\n", "|", "\u0000"].filter(
    (sep) =>
      L.computeCallDigest({ tool: "T", subagentType: `a${sep}b`, prompt: "c", findingIds: [] }) ===
      L.computeCallDigest({ tool: "T", subagentType: "a", prompt: `b${sep}c`, findingIds: [] }),
  );
  check(
    "68",
    "a delimiter inside one element cannot forge an element boundary",
    forged.length === 0,
    `colliding delimiters=${JSON.stringify(forged)}`,
    "M-JOIN: join the elements with a delimiter instead of JSON-encoding them",
  );
  check(
    "69",
    "a shell call binds its COMMAND, and a tool with neither prompt nor command binds its whole input",
    L.callPromptOf({ command: "git worktree add x" }) === "git worktree add x" &&
      L.callDigestOf("EnterWorktree", { path: "/a" }, ["r"]) !==
        L.callDigestOf("EnterWorktree", { path: "/b" }, ["r"]),
    "principal input per tool shape",
    "M-PRINCIPAL: bind only `prompt` — every Bash and EnterWorktree call digests the same",
  );
}

// ── 9c. a call with NO digest honours nothing, and says so ──────────────────
{
  const root = gitRepo(path.join(TMP, "no-digest"));
  const p = writeReceipt(root, receipt(DIGEST_A, "a receipt the consumer forgot to bind"));
  const [res, err] = captureStderr(() => gateAt(root).resolveOverride({ env: {} }));
  const [legacy] = captureStderr(() => gateAt(root).resolveOverride({}));
  check(
    "70",
    "a consumer that passes NO digest honours NO receipt (fails safe), and names why",
    res === null && legacy === null && fs.existsSync(p) && err.includes(L.REFUSAL.NO_CALL_DIGEST),
    `res=${res === null} legacy=${legacy === null} named=${err.includes(L.REFUSAL.NO_CALL_DIGEST)}`,
    "M-NODIGEST: treat a missing digest as a wildcard — an un-updated consumer is unbound again",
  );
}

// ── 9d. what counts as a receipt at all ─────────────────────────────────────
{
  const root = gitRepo(path.join(TMP, "malformed"));
  const shapes = [
    ["legacy plain-text one-liner", "nested placement genuinely required for X"],
    ["template placeholder left as the reason", receipt(DIGEST_A, L.REASON_PLACEHOLDER)],
    ["an extra field", JSON.stringify({ digest: DIGEST_A, reason: "r", written_at: new Date().toISOString(), land_first: "x" })],
    ["no written_at", JSON.stringify({ digest: DIGEST_A, reason: "r" })],
    ["a zoneless written_at", JSON.stringify({ digest: DIGEST_A, reason: "r", written_at: "2026-10-10T12:00:00" })],
    ["an upper-case digest", receipt(DIGEST_A.toUpperCase(), "r")],
  ];
  const refused = [];
  for (const [label, body] of shapes) {
    const p = writeReceipt(root, body);
    const [res, err] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
    if (res === null && fs.existsSync(p) && err.includes(L.REFUSAL.MALFORMED)) refused.push(label);
  }
  check(
    "71",
    "every malformed receipt is REFUSED by name and LEFT IN PLACE",
    refused.length === shapes.length,
    `refused ${refused.length}/${shapes.length}: missing=${shapes.map((s) => s[0]).filter((l) => !refused.includes(l)).join("; ")}`,
    "M-LENIENT: accept the legacy line or the placeholder — the retired free override comes back",
  );
  // ACCEPT pole for 71: the same tree, a well-formed receipt, honoured.
  writeReceipt(root, receipt(DIGEST_A, "well formed"));
  check(
    "72",
    "a WELL-FORMED receipt in the same tree IS honoured (71 is not a dead channel)",
    gateAt(root).consumeReceipt(DIGEST_A)?.reason === "well formed",
    "accept pole for the shape gate",
    "M-REFUSE-ALL",
  );
}

// ── 10. TTL — measured from the receipt's OWN written_at ────────────────────
{
  const root = gitRepo(path.join(TMP, "ttl"));
  const min = 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();

  const pStale = writeReceipt(root, receipt(DIGEST_A, "stale", iso(Date.now() - L.RECEIPT_TTL_MS - 2 * min)));
  const [stale, errStale] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  check(
    "73",
    "a receipt older than the TTL is REFUSED",
    stale === null,
    `ttl=${L.RECEIPT_TTL_MS / min}min`,
    "M-TTL: drop the age check — a forgotten receipt lifts a later identical call",
  );
  check(
    "74",
    "the stale receipt is LEFT IN PLACE and the refusal is NAMED",
    fs.existsSync(pStale) && errStale.includes(L.REFUSAL.STALE),
    `onDisk=${fs.existsSync(pStale)}`,
    "M-TTL-CONSUME: spend a stale receipt instead of leaving it",
  );

  writeReceipt(root, receipt(DIGEST_A, "fresh enough", iso(Date.now() - L.RECEIPT_TTL_MS + 2 * min)));
  check(
    "75",
    "a receipt INSIDE the TTL is honoured (the accept pole beside 73)",
    gateAt(root).consumeReceipt(DIGEST_A)?.reason === "fresh enough",
    "TTL - 2 min",
    "M-TTL-SHORT: a TTL that refuses honest receipts is a dead channel",
  );

  const pFut = writeReceipt(root, receipt(DIGEST_A, "from the future", iso(Date.now() + 5 * min)));
  const [fut, errFut] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  check(
    "76",
    "a FUTURE-dated receipt is REFUSED by name and left in place (no window stretching)",
    fut === null && fs.existsSync(pFut) && errFut.includes(L.REFUSAL.FUTURE_DATED),
    `named=${errFut.includes(L.REFUSAL.FUTURE_DATED)}`,
    "M-FUTURE: drop the skew check — written_at:2099 makes a receipt immortal",
  );

  writeReceipt(root, receipt(DIGEST_A, "clock skew", iso(Date.now() + 10 * 1000)));
  check(
    "77",
    "a written_at a few seconds ahead (inside the skew) is honoured",
    gateAt(root).consumeReceipt(DIGEST_A)?.reason === "clock skew",
    `skew=${L.RECEIPT_FUTURE_SKEW_MS / 1000}s`,
    "M-SKEW-ZERO: a zero skew refuses a receipt written in the same second on a stepped clock",
  );
  check(
    "78",
    "the TTL is a NAMED constant of fifteen minutes",
    L.RECEIPT_TTL_MS === 15 * min,
    `RECEIPT_TTL_MS=${L.RECEIPT_TTL_MS}`,
    "a changed TTL must change its justification in the library header too",
  );
}

// ── 11. THE USE LEDGER — one row per honoured receipt, in the MAIN checkout ──
{
  const root = gitRepo(path.join(TMP, "ledger"));
  const reason = "recorded reason, never stored in clear";
  writeReceipt(root, receipt(DIGEST_A, reason));
  const consumer = { session_id: "sess-123", agent_id: "agent-xyz", agent_type: "tdd-implementer", tool_use_id: "tu-1" };
  const before = ledgerRows(root).length;
  const ov = gateAt(root).consumeReceipt(DIGEST_A, { consumer });
  const rows = ledgerRows(root);
  const row = rows[rows.length - 1] || {};

  check(
    "79",
    "an honoured receipt appends EXACTLY ONE ledger row",
    ov !== null && rows.length === before + 1,
    `before=${before} after=${rows.length}`,
    "M-NOLEDGER: drop the append — the override is honoured and unrecorded",
  );
  check(
    "80",
    "the row carries the digest, a HASH of the reason, the consumer identity and a timestamp",
    row.digest === DIGEST_A &&
      row.reason_sha256 === crypto.createHash("sha256").update(reason, "utf8").digest("hex") &&
      row.consumer?.session_id === "sess-123" &&
      row.consumer?.agent_id === "agent-xyz" &&
      row.consumer?.agent_type === "tdd-implementer" &&
      typeof row.at === "string" && !Number.isNaN(Date.parse(row.at)) &&
      row.channel === RECEIPT_REL.split(path.sep).join("/"),
    `row=${JSON.stringify(row).slice(0, 160)}`,
    "M-ROW: drop a field — the use cannot be attributed after the session ends",
  );
  check(
    "81",
    "the reason itself is NOT stored in clear",
    !fs.readFileSync(ledgerAt(root), "utf8").includes(reason),
    "operator free text stays in the transcript, not the ledger",
    "M-CLEAR: write the reason instead of its hash",
  );

  // NEGATIVE CONTROL — refused receipts write NO row.
  writeReceipt(root, receipt(DIGEST_A, "for A"));
  captureStderr(() => gateAt(root).consumeReceipt(DIGEST_B));
  writeReceipt(root, receipt(DIGEST_A, "stale", new Date(Date.now() - L.RECEIPT_TTL_MS - 60000).toISOString()));
  captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  check(
    "82",
    "a REFUSED receipt (another call's, a stale one) writes NO ledger row",
    ledgerRows(root).length === rows.length,
    `rows=${ledgerRows(root).length} expected=${rows.length}`,
    "M-ROW-ON-REFUSAL: append before validating — the ledger records overrides that never happened",
  );
}

// ── 11b. the ledger is the MAIN checkout's, not the invoking worktree's ─────
{
  const main = gitRepo(path.join(TMP, "ledger-main"));
  execFileSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  const wt = path.join(TMP, "ledger-linked-worktree");
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "fixture-lane", wt], { stdio: "ignore" });
  writeReceipt(wt, receipt(DIGEST_A, "override from inside a linked worktree"));
  const ov = gateAt(wt, [main]).consumeReceipt(DIGEST_A);
  check(
    "83",
    "a receipt consumed in a LINKED WORKTREE is recorded in the MAIN checkout's ledger",
    ov !== null && ledgerRows(main).some((r) => r.digest === DIGEST_A && r.found_under === "invoking tree"),
    `mainRows=${ledgerRows(main).length}`,
    "M-LEDGER-ROOT: resolve the ledger against the invoking tree — the row dies with the worktree",
  );
  check(
    "84",
    "and NOT in the worktree's own tree",
    !fs.existsSync(ledgerAt(wt)),
    `wtLedger=${fs.existsSync(ledgerAt(wt))}`,
    "M-LEDGER-ROOT",
  );
}

// ── 11c. an UNRECORDABLE use is refused, and the receipt survives it ────────
{
  // Ledger WRITE refused: the sink path is a DIRECTORY, so the hardened append cannot open it.
  const root = gitRepo(path.join(TMP, "ledger-unwritable"));
  fs.mkdirSync(ledgerAt(root), { recursive: true });
  const p = writeReceipt(root, receipt(DIGEST_A, "cannot be recorded"));
  const bytes = fs.readFileSync(p, "utf8");
  const [res, err] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  check(
    "85",
    "a use that cannot be RECORDED is NOT honoured, is named, and the receipt is put back",
    res === null &&
      err.includes(L.REFUSAL.LEDGER_WRITE_FAILED) &&
      fs.existsSync(p) &&
      fs.readFileSync(p, "utf8").trim() === bytes.trim(),
    `res=${res === null} named=${err.includes(L.REFUSAL.LEDGER_WRITE_FAILED)} onDisk=${fs.existsSync(p)}`,
    "M-HONOUR-UNRECORDED: return the override when the append fails — the incident class the ledger exists to close",
  );

  // Main checkout UNRESOLVABLE: not a git repository at all.
  const bare = path.join(TMP, "ledger-no-git");
  const pb = writeReceipt(bare, receipt(DIGEST_A, "no repository to record in"));
  const [resB, errB] = captureStderr(() => gateAt(bare).consumeReceipt(DIGEST_A));
  check(
    "86",
    "with NO resolvable main checkout the override is refused BEFORE the claim, receipt untouched",
    resB === null && errB.includes(L.REFUSAL.LEDGER_UNRESOLVED) && fs.existsSync(pb),
    `named=${errB.includes(L.REFUSAL.LEDGER_UNRESOLVED)}`,
    "M-LEDGER-FALLBACK: record in the invoking tree when git cannot answer — a fail-open ledger",
  );

  // ACCEPT pole for 85/86: the same receipt in a writable repository is honoured.
  const ok = gitRepo(path.join(TMP, "ledger-writable"));
  writeReceipt(ok, receipt(DIGEST_A, "can be recorded"));
  check(
    "87",
    "the same receipt in a recordable repository IS honoured (85/86 are not a dead channel)",
    gateAt(ok).consumeReceipt(DIGEST_A)?.reason === "can be recorded",
    "accept pole",
    "M-REFUSE-ALL",
  );
  check(
    "88",
    "the ledger path is the documented one",
    L.USE_LEDGER_REL === path.join(".claude", "learning", "override-receipt-uses.jsonl"),
    `USE_LEDGER_REL=${L.USE_LEDGER_REL}`,
    "a moved ledger must move its gitignore_additions entry and its readers",
  );
}

// ── 12. the PEEK holds a receipt to the consume path's own test ─────────────
{
  const root = gitRepo(path.join(TMP, "peek"));
  const p = writeReceipt(root, receipt(DIGEST_A, "peeked, not spent"));
  const g = gateAt(root);
  const peekA = g.peekReceipt(DIGEST_A);
  check(
    "89",
    "peekReceipt returns the receipt valid for THIS call without consuming it",
    peekA?.reason === "peeked, not spent" && fs.existsSync(p),
    `reason=${JSON.stringify(peekA?.reason)}`,
    "M-PEEK-CONSUMES: unlink on peek — a refusal that peeked destroys the receipt it names",
  );
  const [peekB] = captureStderr(() => g.peekReceipt(DIGEST_B));
  check(
    "90",
    "peekReceipt does NOT report another call's receipt as present",
    peekB === null,
    "a peek must never price or debit a receipt this call may not spend",
    "M-PEEK-RAW: peek the raw text — the WIP debt and price gates act on a receipt for another command",
  );
  writeReceipt(root, receipt(DIGEST_A, "stale", new Date(Date.now() - L.RECEIPT_TTL_MS - 60000).toISOString()));
  const [peekStale] = captureStderr(() => gateAt(root).peekReceipt(DIGEST_A));
  check(
    "91",
    "peekReceipt does NOT report a STALE receipt as present",
    peekStale === null,
    "same TTL test as the consume path",
    "M-PEEK-RAW",
  );
}

{
  const assert = require("node:assert/strict");
  const library = path.join(REPO, ".claude/hooks/lib/override-receipt.js");
  const source = fs.readFileSync(library, "utf8");
  const start = source.indexOf("function consumeReceipt(digest, ctx)");
  const filter = "if (peekSelections.has(digest) && (!selected || selected.path !== c.abs)) continue;";
  assert.equal(source.slice(start).split(filter).length, 2, "consume-path mutation target reached once");
  const Module = require("node:module");
  const instance = new Module(library);
  instance.filename = library;
  instance.paths = Module._nodeModulePaths(path.dirname(library));
  const contentGuard = /if \(selected && selected\.sha256 !== v\.sha256\) \{[\s\S]*?\n      \}/;
  assert.equal(source.slice(start).split(contentGuard).length, 2, "content guardian mutation reached once");
  instance._compile(source.slice(0, start) + source.slice(start).replace(filter, "").replace(contentGuard, ""), library);
  const exercise = (subject, name) => {
    const first = gitRepo(path.join(TMP, `peek-spend-${name}-first`));
    const second = gitRepo(path.join(TMP, `peek-spend-${name}-second`));
    const pricedPath = writeReceipt(first, receipt(DIGEST_A, "first price"));
    const otherPath = writeReceipt(second, receipt(DIGEST_A, "different price"));
    const gate = subject.createOverrideGate({ receiptRel: RECEIPT_REL, envVar: ENV_VAR, cwd: first, extraRoots: () => [second] });
    const peek = gate.peekReceipt(DIGEST_A);
    assert.equal(peek.path, pricedPath, "first receipt reached pricing");
    const originalRename = fs.renameSync;
    let spent, loud;
    try {
      fs.renameSync = (from, to) => {
        if (from === pricedPath) throw Object.assign(new Error("fixture undeletable"), { code: "EACCES" });
        return originalRename(from, to);
      };
      [spent, loud] = captureStderr(() => gate.consumeReceipt(DIGEST_A));
    } finally { fs.renameSync = originalRename; }
    return { peek, spent, loud, pricedPath, otherPath };
  };
  const actual = exercise(L, "real");
  const samePath = (value) => assert.ok(value.spent === null || value.spent.consumedPath === value.peek.path,
    "R1-OR-L1 priced path must equal spent path");
  samePath(actual);
  check("R1-OR-L1", "undeletable priced receipt refuses without spending the other receipt",
    actual.spent === null && fs.existsSync(actual.pricedPath) && fs.existsSync(actual.otherPath) &&
      actual.loud.includes(L.REFUSAL.UNDELETABLE), "priced first receipt retained; second receipt retained", "M-PEEK-PATH");
  const mutant = exercise(instance.exports, "mutant");
  assert.equal(mutant.spent?.consumedPath, mutant.otherPath, "mutation reached alternative receipt spend");
  assert.throws(() => samePath(mutant), /R1-OR-L1/);
  check("R1-OR-L1-mutation-red", "removing path binding and its content guardian reds priced/spent identity", true,
    "different receipt was spent by the reached mutant", "M-PEEK-PATH");
}

// Exact restoration measures bytes, including the absence of a final newline.
{
  const root = gitRepo(path.join(TMP, "rollback-exact-bytes"));
  fs.mkdirSync(ledgerAt(root), { recursive: true });
  const bytes = Buffer.from(receipt(DIGEST_A, "exact byte rollback"));
  const p = writeReceipt(root, bytes);
  const [result, loud] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  const after = fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0);
  check("R2-OR-BYTES", "failed ledger restores the exact original receipt bytes without adding a newline",
    result === null && loud.includes(L.REFUSAL.LEDGER_WRITE_FAILED) && after.equals(bytes),
    `before=${bytes.length} after=${after.length} byteEqual=${after.equals(bytes)}`,
    "M-RESTORE-NEWLINE: text restoration changes the conserved receipt bytes");
}

// Same path and same call digest do not mean the same priced receipt content.
{
  const root = gitRepo(path.join(TMP, "peek-content-replacement"));
  const p = writeReceipt(root, receipt(DIGEST_A, "original priced content"));
  const gate = gateAt(root);
  const peek = gate.peekReceipt(DIGEST_A);
  const replacement = Buffer.from(receipt(DIGEST_A, "replacement unpriced content"));
  fs.writeFileSync(p, replacement);
  const [spent, loud] = captureStderr(() => gate.consumeReceipt(DIGEST_A));
  check("R2-OR-CONTENT", "replacing priced content at the same path refuses without spending or ledgering it",
    peek?.reason === "original priced content" && spent === null &&
    fs.existsSync(p) && fs.readFileSync(p).equals(replacement) && ledgerRows(root).length === 0 && loud.includes(L.REFUSAL.CONTENT_CHANGED),
    `peek=${peek?.reason} spent=${spent !== null} rows=${ledgerRows(root).length} loud=${loud.trim()}`,
    "M-PEEK-CONTENT: bind only the pathname or normalized digest, not exact priced bytes");
}

{
  const root = gitRepo(path.join(TMP, "peek-byte-only-replacement"));
  const original = Buffer.from(receipt(DIGEST_A, "identical parsed receipt"));
  const p = writeReceipt(root, original);
  const gate = gateAt(root);
  const peek = gate.peekReceipt(DIGEST_A);
  const replacement = Buffer.concat([original, Buffer.from("\n")]);
  fs.writeFileSync(p, replacement);
  const [spent, loud] = captureStderr(() => gate.consumeReceipt(DIGEST_A));
  check("R2-OR-RAW-PEEK", "even identical parsed JSON is refused when its priced raw bytes changed",
    peek?.reason === "identical parsed receipt" && spent === null && loud.includes(L.REFUSAL.CONTENT_CHANGED) &&
      fs.existsSync(p) && fs.readFileSync(p).equals(replacement) && ledgerRows(root).length === 0,
    `before=${original.length} after=${replacement.length} spent=${spent !== null} loud=${loud.trim()}`,
    "M-PEEK-NORMALIZED: hash trimmed or canonical JSON instead of the raw receipt bytes");
}

// Rollback collision retains both the newer public receipt and the private claim.
{
  const root = gitRepo(path.join(TMP, "rollback-collision"));
  fs.mkdirSync(ledgerAt(root), { recursive: true });
  const oldBytes = Buffer.from(receipt(DIGEST_A, "old claimed receipt"));
  const newBytes = Buffer.from(receipt(DIGEST_A, "newer public receipt"));
  const p = writeReceipt(root, oldBytes);
  const originalLink = fs.linkSync;
  const originalRename = fs.renameSync;
  let reached = false, claim = null, spent, loud;
  const collide = (from, to) => {
    if (to === p && from !== p) {
      reached = true;
      claim = from;
      fs.writeFileSync(p, newBytes, { flag: "wx" });
    }
  };
  try {
    fs.linkSync = (from, to, ...args) => {
      collide(from, to);
      return originalLink(from, to, ...args);
    };
    fs.renameSync = (from, to, ...args) => {
      collide(from, to);
      return originalRename(from, to, ...args);
    };
    [spent, loud] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  } finally { fs.linkSync = originalLink; fs.renameSync = originalRename; }
  check("R2-OR-NOCLOBBER", "rollback collision preserves newer public bytes and old private claim bytes",
    reached && spent === null && fs.readFileSync(p).equals(newBytes) &&
      claim !== null && fs.existsSync(claim) && fs.readFileSync(claim).equals(oldBytes) &&
      loud.includes(L.REFUSAL.LEDGER_WRITE_FAILED),
    `reached=${reached} oldClaimRetained=${claim !== null && fs.existsSync(claim)} loud=${loud.trim()}`,
    "M-RESTORE-CLOBBER: rename overwrites the newer public receipt instead of link EEXIST");
}

// The receipt can change after discovery but before its atomic rename claim.
{
  const root = gitRepo(path.join(TMP, "validate-claimed-file"));
  const p = writeReceipt(root, receipt(DIGEST_A, "initial valid receipt"));
  const replacement = Buffer.from(receipt(DIGEST_B, "wrong call claimed bytes"));
  const originalRename = fs.renameSync;
  let reached = false, spent, loud;
  try {
    fs.renameSync = (from, to, ...args) => {
      if (from === p && !reached) {
        reached = true;
        fs.writeFileSync(p, replacement);
      }
      return originalRename(from, to, ...args);
    };
    [spent, loud] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  } finally { fs.renameSync = originalRename; }
  check("R2-OR-CLAIMED", "the bytes actually renamed into the claim are revalidated for this call",
    reached && spent === null && loud.includes(L.REFUSAL.DIGEST_MISMATCH) &&
      fs.existsSync(p) && fs.readFileSync(p).equals(replacement) && ledgerRows(root).length === 0,
    `reached=${reached} spent=${spent !== null} rows=${ledgerRows(root).length} loud=${loud.trim()}`,
    "M-VALIDATE-PRECLAIM: honor a stale discovery read instead of claimed bytes");
}

{
  const root = gitRepo(path.join(TMP, "recorded-claim-cleanup-failure"));
  const bytes = Buffer.from(receipt(DIGEST_A, "recorded must not rearm"));
  const p = writeReceipt(root, bytes);
  const originalUnlink = fs.unlinkSync;
  let claim = null, spent, loud;
  try {
    fs.unlinkSync = (file, ...args) => {
      if (path.basename(file) === "receipt" && path.basename(path.dirname(file)).startsWith(".override-claim-")) {
        claim = file;
        throw Object.assign(new Error("fixture claim cleanup failure"), { code: "EACCES" });
      }
      return originalUnlink(file, ...args);
    };
    [spent, loud] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  } finally { fs.unlinkSync = originalUnlink; }
  const replay = gateAt(root).consumeReceipt(DIGEST_A);
  check("R2-OR-POSTLEDGER", "failed cleanup after recorded use retains private bytes without rearming public receipt",
    spent?.reason === "recorded must not rearm" && claim !== null && fs.existsSync(claim) &&
      fs.readFileSync(claim).equals(bytes) && !fs.existsSync(p) && replay === null && ledgerRows(root).length === 1 &&
      loud.includes(L.REFUSAL.CLAIM_CLEANUP_FAILED),
    `reached=${claim !== null} honored=${spent !== null} replay=${replay !== null} rows=${ledgerRows(root).length}`,
    "M-POSTLEDGER-RESTORE: restore an already ledgered receipt and permit replay");
}

// Both processes wait for GO before independently claiming one actual receipt.
{
  const root = gitRepo(path.join(TMP, "competing-process-claims"));
  const p = writeReceipt(root, receipt(DIGEST_A, "one receipt two processes"));
  const library = path.join(REPO, ".claude/hooks/lib/override-receipt.js");
  const program = `const L=require(${JSON.stringify(library)});process.send('ready');` +
    `process.once('message',()=>{const gate=L.createOverrideGate({receiptRel:${JSON.stringify(RECEIPT_REL)},` +
    `envVar:${JSON.stringify(ENV_VAR)},cwd:${JSON.stringify(root)}});` +
    `const result=gate.consumeReceipt(${JSON.stringify(DIGEST_A)});` +
    `process.send({honored:result!==null},()=>process.disconnect());});`;
  const workers = [0, 1].map(() => {
    const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let result = null, stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("message", message => message === "ready" ? resolve() : reject(new Error("claim worker not ready")));
    });
    child.on("message", message => { if (message && typeof message === "object") result = message; });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve({ status, result, stderr }));
    });
    return { child, ready, done };
  });
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.send("go");
  const results = await Promise.all(workers.map(worker => worker.done));
  const honored = results.filter(result => result.result?.honored).length;
  check("R2-OR-PROCESS", "two actual processes atomically claim one receipt exactly once",
    results.every(result => result.status === 0 && result.result !== null) &&
      honored === 1 && ledgerRows(root).length === 1 && !fs.existsSync(p),
    `honored=${honored} ledgerRows=${ledgerRows(root).length} processes=${JSON.stringify(results)}`,
    "M-CLAIM-NONATOMIC: both processes honor a discovery read without exclusive claim");
}

{
  const root = gitRepo(path.join(TMP, "raw-byte-read"));
  const bytes = Buffer.concat([Buffer.from('{"reason":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const p = writeReceipt(root, bytes);
  const { readSinkFile } = require(path.join(REPO, ".claude/hooks/lib/append-sink.js"));
  const options = { repoDir: root, sinkPath: p, maxBytes: L.RECEIPT_MAX_BYTES };
  const normal = readSinkFile(options);
  const raw = readSinkFile({ ...options, rawBytes: true });
  check("R2-OR-RAW-DEFAULT", "ordinary readSinkFile shape does not acquire a rawBytes field",
    normal.ok && !Object.prototype.hasOwnProperty.call(normal, "rawBytes"),
    `normalOK=${normal.ok} keys=${Object.keys(normal)}`, "M-RAW-DEFAULT: publish optional field to all existing callers");
  check("R2-OR-RAW-BYTES", "opt-in readSinkFile returns original invalid UTF-8 bytes from the descriptor read",
    raw.ok && Buffer.isBuffer(raw.rawBytes) && raw.rawBytes.equals(bytes) && raw.bytes === bytes.length,
    `rawOK=${raw.ok} bytes=${raw.bytes} expected=${bytes.length}`,
    "M-RAW-DECODE: reconstruct raw bytes from decoded replacement-character text");
  const capped = readSinkFile({ ...options, rawBytes: true, maxBytes: bytes.length - 1 });
  check("R2-OR-RAW-CAP", "opt-in raw bytes do not expose a prefix of an over-cap read",
    !capped.ok && capped.overCap === true && !Object.prototype.hasOwnProperty.call(capped, "rawBytes"),
    `ok=${capped.ok} overCap=${capped.overCap}`, "M-RAW-CAP: publish partial bytes on a refused read");
  const link = p + "-symlink";
  fs.symlinkSync(p, link);
  const normalLink = readSinkFile({ ...options, sinkPath: link });
  const rawLink = readSinkFile({ ...options, sinkPath: link, rawBytes: true });
  check("R2-OR-RAW-IDENTITY", "raw opt-in retains the ordinary symlink refusal and exposes no raw payload",
    !normalLink.ok && !rawLink.ok && normalLink.error === rawLink.error &&
      rawLink.error === "symlink refused" && !Object.prototype.hasOwnProperty.call(rawLink, "rawBytes"),
    `normal=${normalLink.error} raw=${rawLink.error}`, "M-RAW-UNSAFE-READ: bypass the identity fence for raw bytes");
  const valid = receipt(DIGEST_A, "INVALID_BYTE_SLOT");
  const invalid = Buffer.concat([Buffer.from(valid.split("INVALID_BYTE_SLOT")[0]), Buffer.from([0xff]),
    Buffer.from(valid.split("INVALID_BYTE_SLOT")[1])]);
  fs.writeFileSync(p, invalid);
  const [spent, loud] = captureStderr(() => gateAt(root).consumeReceipt(DIGEST_A));
  check("R2-OR-UTF8", "an invalid UTF-8 receipt is refused without consuming or replacing its bytes",
    spent === null && fs.existsSync(p) && fs.readFileSync(p).equals(invalid) && ledgerRows(root).length === 0 && loud.includes(L.REFUSAL.UNREADABLE),
    `spent=${spent !== null} rows=${ledgerRows(root).length} loud=${loud.trim()}`,
    "M-RECEIPT-UTF8: replacement-character decoding authorizes bytes that were not a UTF-8 receipt");
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
