/**
 * override-availability.js — "is the one-shot override still UNSPENT?" answered
 * from the LEDGER, never from a directory listing of the receipt directory.
 *
 * ── THE MEASURED GAP ────────────────────────────────────────────────────────
 *
 * A dispatched agent spent a one-shot, human-authorised escape without its owner
 * knowing. The instrument the owner would have read to find out — a DIRECTORY
 * LISTING of the override receipt directory (`.claude/wip-authz/`) — returns THE
 * SAME ANSWER for "never spent" and "already spent", because a receipt is
 * CONSUMED ON USE: `lib/override-receipt.js` UNLINKS it as it honours it. So at
 * rest the directory shows `README.md`, `override-ledger.jsonl` and
 * `burndown-queue.jsonl` in BOTH states, byte for byte. The listing's output is
 * CONSTANT across the hypothesis, which is the exact shape
 * `rules/instrument-discipline.md` MUST-1 refuses as evidence: a result that
 * cannot differ carries zero information, whatever it printed.
 *
 * ── THE DISCRIMINATOR IS THE LEDGER ─────────────────────────────────────────
 *
 * `override-ledger.jsonl` gains exactly ONE row per HONOURED override
 * (`wip-discipline-guard.js::recordOverride`, which writes the row through
 * `appendSinkLine` and never blocks the honoured override on bookkeeping). Spend
 * state is therefore derivable from a ROW'S PRESENCE, and from nothing else. The
 * receipt's own presence is deliberately NOT read here: it cannot distinguish
 * the two states, so letting it touch the answer would smuggle the very defect
 * this module exists to close.
 *
 * ── SCOPE, STATED SO IT IS NOT READ PAST ────────────────────────────────────
 *
 * This answers SPEND STATE ONLY. It does NOT answer "may this actor spend it
 * now" — the owner-only rule, the `land_first` debt that refuses the NEXT
 * override while a named lane is still open, and the env channel are the DOOR's
 * questions and live with the door's gate. Reading this module's `available` as
 * an authorisation is reading it past its scope (`instrument-discipline.md`
 * MUST-4): soundness for "has it been spent" carries no information about "is
 * this spend permitted".
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────
 *
 * A ledger this module cannot READ yields `unknown`, never `available`. The
 * third verdict is load-bearing: `unknown` reported as `available` is a spent
 * one-shot reading as an armed one, which is the failure direction that costs
 * the owner an override they believe is still theirs. A caller MUST treat
 * `unknown` as NOT available.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Where the one-shot receipt and its ledger live, repo-relative. */
const RECEIPT_REL = path.join(".claude", "wip-authz", "wip-limit-allow");
const LEDGER_REL = path.join(".claude", "wip-authz", "override-ledger.jsonl");

/** A ledger past this size is not this file's ledger; refuse rather than parse. */
const LEDGER_MAX_BYTES = 1 << 20; // 1 MiB

/**
 * Read the ledger rows. Returns the DISCRIMINATION (`read` / `absent` / `refused`)
 * rather than collapsing it, because `absent` (nothing was ever spent) and
 * `refused` (something occupies the path that this module will not read) are
 * OPPOSITE facts that a single `null` would merge into one — the merge
 * `lib/override-receipt.js::readReceiptState` documents for its own callers.
 *
 * Rows that do not parse as JSON are SKIPPED, not fatal: the ledger is
 * append-only and a torn final line is a real state, while refusing on it would
 * answer `unknown` about a file whose earlier rows plainly record a spend.
 */
function readLedgerRows(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "absent", rows: 0 };
    return { state: "refused", rows: 0 };
  }
  // A symlink, directory, FIFO or device at the ledger path is not readable
  // content; a dangling one is not an absent ledger either.
  if (!st.isFile()) return { state: "refused", rows: 0 };
  if (st.size > LEDGER_MAX_BYTES) return { state: "refused", rows: 0 };
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { state: "refused", rows: 0 };
  }
  let rows = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      rows += 1;
    } catch {
      /* torn or hand-edited line — skip it, never fatal */
    }
  }
  return { state: "read", rows };
}

/**
 * @param {object} opts
 * @param {string} opts.root      tree the ledger is relative to (the MAIN
 *                                checkout, so a linked worktree reads the ONE
 *                                ledger every worktree writes)
 * @param {string} [opts.ledgerRel]
 * @returns {{state:"available"|"spent"|"unknown", ledger_rows:number|null,
 *            ledger_state:"read"|"absent"|"refused", ledger_path:string, why:string}}
 */
function overrideAvailability(opts = {}) {
  const root = typeof opts.root === "string" && opts.root ? opts.root : "";
  const ledgerRel =
    typeof opts.ledgerRel === "string" && opts.ledgerRel
      ? opts.ledgerRel
      : LEDGER_REL;
  if (!root) {
    return {
      state: "unknown",
      ledger_rows: null,
      ledger_state: "refused",
      ledger_path: ledgerRel,
      why: "no root given — the ledger's location is undecidable",
    };
  }
  const abs = path.resolve(root, ledgerRel);
  const got = readLedgerRows(abs);
  if (got.state === "refused") {
    return {
      state: "unknown",
      ledger_rows: null,
      ledger_state: "refused",
      ledger_path: abs,
      why:
        "the ledger occupies a path this module will not read (not a regular file, or over the size bound) — " +
        "a spend CANNOT be ruled out, so the answer is unknown and a caller MUST treat it as NOT available",
    };
  }
  if (got.rows > 0) {
    return {
      state: "spent",
      ledger_rows: got.rows,
      ledger_state: got.state,
      ledger_path: abs,
      why: `${got.rows} honoured override(s) recorded — the one-shot has been spent`,
    };
  }
  return {
    state: "available",
    ledger_rows: 0,
    ledger_state: got.state,
    ledger_path: abs,
    why:
      got.state === "absent"
        ? "no ledger and no recorded spend — the one-shot is unspent"
        : "ledger present and empty — no override has been recorded, so the one-shot is unspent",
  };
}

module.exports = {
  overrideAvailability,
  readLedgerRows,
  RECEIPT_REL,
  LEDGER_REL,
  LEDGER_MAX_BYTES,
};
