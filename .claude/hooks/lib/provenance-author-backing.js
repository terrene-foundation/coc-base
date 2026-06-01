"use strict";

/**
 * provenance-author-backing.js — F101-3 (loom#411 governance-as-DNA, loom lane).
 *
 * The author-VERIFIABILITY layer. A journal entry's `author:` frontmatter field
 * (human | agent | co-authored per rules/journal.md) is a CLAIM. This module
 * answers ONE question against the LIVE per-session provenance ledger (the
 * F101-2 capture stream): is a `human`/`co-authored` author claim BACKED by at
 * least one real `HumanInput` provenance event in this session?
 *
 *   author: human | co-authored  + ≥1 session HumanInput  → "backed"
 *   author: human | co-authored  + 0  session HumanInput  → "unbacked"
 *   author: agent                                         → "n/a-agent"
 *   ledger absent / unreadable / no session               → "undetermined"
 *
 * VERIFIABLE, NOT TRUSTED (rule journal-author-discipline MUST-1): the check
 * reads the LIVE ledger, never the frontmatter's own assertion, notes, or
 * memory. An agent-surfaced entry renders "n/a — agent-surfaced", never
 * "BACKED by human input" (MUST-2).
 *
 * SECRETS FENCE (security.md "no secrets in logs"): the ledger stores
 * `prompt_sha256` (a commitment), NEVER verbatim prompt content. This module
 * COUNTS events where `kind === "HumanInput"` (the closed taxonomy kind from
 * provenance-event.js::EVENT_KINDS). It MUST NOT read, parse, or emit any event
 * PAYLOAD content — only the `kind` discriminator. A count is not a disclosure.
 *
 * REGISTRY-class, NOT structural (hook-output-discipline.md MUST-2): this reads
 * a ledger file + matches frontmatter — a registry signal, the same class as
 * the journal-write-guard slot-reservation lookup. An EMPTY ledger is AMBIGUOUS
 * (degraded capture vs a genuine false claim), so the caller's disposition for
 * "unbacked"/"undetermined" is `severity: "halt-and-report"`, NEVER `block`.
 * `block` is reserved for irrefutable structural signals (fs.existsSync).
 *
 * Origin: F101-3 (journal/0192 §Deferred + #411 item 2; F101-1 schema journal/0190;
 * F101-2 capture journal/0188 §D).
 */

const fs = require("fs");
const path = require("path");

const { _ledgerPath } = require(path.join(__dirname, "provenance-ledger.js"));

/**
 * Cosmetic label for the author-backing status. Per MUST-2: an agent-surfaced
 * entry MUST render "n/a — agent-surfaced", never "BACKED by human input".
 *
 * @param {string} status one of "backed"|"unbacked"|"n/a-agent"|"undetermined"
 * @returns {string} human-readable label
 */
function backingLabel(status) {
  switch (status) {
    case "backed":
      return "BACKED by human input";
    case "unbacked":
      return "UNBACKED — author claim not backed by a session HumanInput event";
    case "n/a-agent":
      return "n/a — agent-surfaced";
    case "undetermined":
    default:
      return "undetermined — no live session ledger to verify against";
  }
}

/**
 * Normalize a raw `author:` frontmatter value to the closed author vocabulary.
 * Tolerant of surrounding whitespace + case; unknown values are returned
 * lowercased so the dispatch can treat them as the human-class default
 * (co-authored is the journal.md "default when uncertain").
 *
 * @param {*} raw
 * @returns {?string}
 */
function _normalizeAuthor(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  return v;
}

/**
 * Count `HumanInput` events in the per-session provenance ledger. Best-effort:
 * a missing or unreadable ledger returns null (→ "undetermined"); a present,
 * readable ledger returns the count (which MAY be 0).
 *
 * SECRETS FENCE: parses each line ONLY to read `event.kind`. The event payload
 * (which carries `prompt_sha256` etc.) is NEVER read or emitted here.
 *
 * @param {string} ledgerPath absolute path to the ledger
 * @returns {?number} HumanInput count, or null if the ledger is absent/unreadable
 */
function _countHumanInput(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    // Present but unreadable → undetermined (the honest "we can't tell").
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let count = 0;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      // A single corrupt line does not invalidate the rest — skip it. The
      // chain-corruption path is handled by provenance-ledger's _deriveChainHead;
      // here we only count well-formed HumanInput events.
      continue;
    }
    // ONLY the `kind` discriminator is read — never the payload (secrets fence).
    if (ev && ev.kind === "HumanInput") count += 1;
  }
  return count;
}

/**
 * Check whether a journal entry's author claim is backed by a session
 * HumanInput provenance event.
 *
 * @param {object} a
 * @param {string} a.repoDir            MAIN-checkout repo dir (caller resolves it)
 * @param {string} a.session            session id (from the hook payload)
 * @param {string} a.frontmatterAuthor  the `author:` value from the entry's YAML
 * @returns {{ status: string, humanInputCount: ?number, ledgerPath: ?string, label: string }}
 *   status ∈ "backed" | "unbacked" | "n/a-agent" | "undetermined"
 */
function checkAuthorBacking(a) {
  const repoDir = a && typeof a.repoDir === "string" ? a.repoDir : null;
  const session = a && typeof a.session === "string" ? a.session : null;
  const author = _normalizeAuthor(a && a.frontmatterAuthor);

  // Author "agent" → "n/a-agent" regardless of ledger state. An agent-surfaced
  // entry makes no human-input claim, so there is nothing to verify (MUST-2).
  if (author === "agent") {
    return {
      status: "n/a-agent",
      humanInputCount: null,
      ledgerPath: null,
      label: backingLabel("n/a-agent"),
    };
  }

  // No session id, or no repoDir → cannot resolve a ledger → undetermined.
  if (!repoDir || !session || session.trim().length === 0) {
    return {
      status: "undetermined",
      humanInputCount: null,
      ledgerPath: null,
      label: backingLabel("undetermined"),
    };
  }

  // Resolve the ledger via the canonical helper — do NOT re-derive the path.
  let ledgerPath;
  try {
    ledgerPath = _ledgerPath(repoDir, session);
  } catch {
    return {
      status: "undetermined",
      humanInputCount: null,
      ledgerPath: null,
      label: backingLabel("undetermined"),
    };
  }

  const count = _countHumanInput(ledgerPath);

  // Ledger absent or unreadable → undetermined (degraded capture is ambiguous,
  // NOT a false claim; the caller halts-and-reports, never blocks).
  if (count === null) {
    return {
      status: "undetermined",
      humanInputCount: null,
      ledgerPath,
      label: backingLabel("undetermined"),
    };
  }

  // author human | co-authored (or any non-agent value — co-authored is the
  // journal.md default-when-uncertain): backed iff ≥1 HumanInput event.
  const status = count >= 1 ? "backed" : "unbacked";
  return {
    status,
    humanInputCount: count,
    ledgerPath,
    label: backingLabel(status),
  };
}

module.exports = {
  checkAuthorBacking,
  backingLabel,
  _normalizeAuthor,
  _countHumanInput,
};
