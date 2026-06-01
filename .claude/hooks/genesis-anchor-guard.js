#!/usr/bin/env node
/**
 * Hook: genesis-anchor-guard
 * Event: PreToolUse on sign / `git commit` / `git push` / roster-touching writes
 *
 * Shard A0b-2a (workspaces/multi-operator-coc/02-plans/01-architecture.md §4.3).
 *
 * BEHAVIOR — fail-CLOSED:
 *   The hook verifies the LATEST cached, signed, owner-bound `genesis-anchor`
 *   or `genesis-migration` (fold rule 9a/9c). Zero-network.
 *
 *   - No verifying owner-bound anchor in the log AND no in-progress enrollment
 *     ceremony in the worktree → hard `block` (exit 2).
 *   - Local roster's genesis_generation < signature-verified peer high-water
 *     observed in folded `genesis-migration` records → degrade to
 *     `halt-and-report` (NOT block — exit 0 + stderr advisory).
 *
 *   Verification is process-local structural — a deterministic cryptographic
 *   signature check is NOT a lexical signal, so it qualifies as a `block`-grade
 *   structural fact per `rules/hook-output-discipline.md` MUST-2:
 *     "Block severity is for structural facts the agent cannot rationalize
 *      away (e.g., ... pre-commit exit code non-zero; `git status --porcelain`
 *      non-empty before `--hard`)."
 *
 *   ≤5s execution budget per `cc-artifacts.md` Rule 7 (setTimeout fallback
 *   returns {continue: true} on timeout, fail-OPEN on hook-internal hang —
 *   the fail-CLOSED behavior applies to the cryptographic check, not the
 *   timeout safety net).
 *
 * ENV OVERRIDES (test injection only):
 *   COC_GENESIS_GUARD_LOG_PATH    — path to coordination-log.jsonl
 *   COC_GENESIS_GUARD_ROSTER_PATH — path to operators.roster.json
 *   COC_GENESIS_GUARD_ENROLLMENT_MARKER — path that, if exists, signals
 *                                          an in-progress enrollment ceremony
 *
 * Production resolves these via state-resolver.js (the main checkout) per
 * trust-posture.md MUST Rule 1.
 */

"use strict";

const TIMEOUT_MS = 5000;

// setTimeout fallback per cc-artifacts.md Rule 7. The timeout path emits
// {continue: true} — a hook-internal hang MUST NOT block the agent forever.
// The fail-CLOSED behavior of THIS hook is a deliberate exit 2 below; the
// timeout is the safety net for that path's pathology.
const fallback = setTimeout(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(1);
}, TIMEOUT_MS);

const fs = require("fs");
const path = require("path");
const { emit } = require(path.join(__dirname, "lib", "instruct-and-wait.js"));
const { foldGenesisAnchor } = require(
  path.join(__dirname, "lib", "fold-genesis-anchor.js"),
);
const cocSign = require(path.join(__dirname, "lib", "coc-sign.js"));
const { isUnenrolled } = require(
  path.join(__dirname, "lib", "roster-schema-validate.js"),
);
const { isMutationTool } = require(
  path.join(__dirname, "lib", "tool-classes.js"),
);

function passthrough() {
  clearTimeout(fallback);
  process.stdout.write(JSON.stringify({ continue: true }) + "\n");
  process.exit(0);
}

function readStdinSync() {
  try {
    const data = fs.readFileSync(0, "utf8");
    if (!data || !data.trim()) return {};
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Resolve the log + roster paths. Production code path uses
// state-resolver.js to find the main checkout; for shard A0b-2a we keep
// the resolution explicit + env-overridable so tests can inject fixtures.
function resolvePaths() {
  const logEnv = process.env.COC_GENESIS_GUARD_LOG_PATH;
  const rosterEnv = process.env.COC_GENESIS_GUARD_ROSTER_PATH;
  if (logEnv && rosterEnv) {
    return { logPath: logEnv, rosterPath: rosterEnv };
  }
  // Fall back to the conventional locations relative to this hook file.
  // .claude/hooks/genesis-anchor-guard.js → ../learning/coordination-log.jsonl
  // .claude/hooks/genesis-anchor-guard.js → ../operators.roster.json
  const repoClaude = path.join(__dirname, "..");
  return {
    logPath:
      logEnv || path.join(repoClaude, "learning", "coordination-log.jsonl"),
    rosterPath: rosterEnv || path.join(repoClaude, "operators.roster.json"),
  };
}

// Watched-tool predicate: this hook fires on sign-relevant tool calls. The
// design plan §4.3 names these as pre-tool-use for sign / `git commit` /
// `git push` / roster-touching writes. We accept the payload's tool_name +
// (for Bash) command string and apply a positive allowlist; non-matches
// pass through silently.
function isWatchedTool(payload) {
  const tool = payload && payload.tool_name;
  if (!tool) return false;
  const input = (payload && payload.tool_input) || {};
  if (tool === "Bash") {
    const cmd = (input.command || "").trim();
    // Sign / commit / push / roster ops. We DO NOT try to expand shell
    // variables (per hook-output-discipline.md MUST-3 — pre-expansion
    // command strings cannot be evaluated). If the agent runs a literal
    // `git commit` we catch it; if it runs `$GITCMD commit` we let it
    // through (the structural fact "literal git commit" is what gates).
    if (/\bgit\s+(commit|push)\b/.test(cmd)) return true;
    if (/\bssh-keygen\s+-Y\s+sign\b/.test(cmd)) return true;
    if (/\bgpg\s+.*--sign\b/.test(cmd)) return true;
    return false;
  }
  // F14 C2 iter-3 root-cause fix: roster-touching writes via any
  // mutation tool MUST fire the guard. MultiEdit and NotebookEdit can
  // also target operators.roster.json (MultiEdit batch-edit, NotebookEdit
  // if the roster is ever surfaced through a notebook tool). Routing
  // through isMutationTool() closes the bypass per autonomous-execution.md
  // MUST Rule 4.
  if (isMutationTool(tool)) {
    // NotebookEdit uses notebook_path; cover both.
    const filePath =
      input.file_path || input.filePath || input.notebook_path || "";
    // Roster ops: any edit to the operators.roster.json
    if (filePath.endsWith("/operators.roster.json")) return true;
    if (filePath === "operators.roster.json") return true;
    return false;
  }
  return false;
}

/**
 * HIGH-2 (M0 security review): the enrollment marker MUST be a signed
 * file whose signature verifies against a candidate signer's pubkey
 * present in the roster (which MAY be PLACEHOLDER-prefixed during a
 * fresh genesis). An unsigned one-byte marker was a free-bypass — any
 * `touch /tmp/marker && export COC_GENESIS_GUARD_ENROLLMENT_MARKER=...`
 * collapsed the guard's fail-CLOSED behavior.
 *
 * The marker shape (architecture §4.3, M0 security review HIGH-2):
 *   {
 *     ceremony_start_ts: "<ISO>",
 *     candidate_signer_fingerprint: "<active-signing-key-fingerprint>",
 *     target_repo_owner: "<github-login>",
 *     target_root_commit: "<sha>",
 *     sig: "<detached-sig over canonicalSerialize(marker-without-sig)>"
 *   }
 *
 * Verification:
 *   - parse the marker JSON; reject malformed
 *   - canonical-serialize the marker WITHOUT `sig`
 *   - resolve candidate_signer_fingerprint to a roster person's pubkey
 *     (including PLACEHOLDER-prefixed entries so a fresh genesis ceremony
 *     can run before the genesis-owner's person_id is finalized)
 *   - cocSign.verify(bytes, marker.sig, pubkey, {keyType})
 *   - returns true only when verify reports ok && valid
 *
 * On any failure (marker absent, malformed, wrong key, tampered content)
 * the function returns false and the guard's no-anchor branch fires
 * fail-CLOSED. NO silent bypass.
 */
function checkEnrollmentInProgress(roster) {
  const markerPath = process.env.COC_GENESIS_GUARD_ENROLLMENT_MARKER;
  if (!markerPath || !fs.existsSync(markerPath)) return false;

  let raw;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return false;
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!marker || typeof marker !== "object") return false;
  if (typeof marker.sig !== "string" || !marker.sig) return false;
  if (
    typeof marker.candidate_signer_fingerprint !== "string" ||
    !marker.candidate_signer_fingerprint
  ) {
    return false;
  }
  if (
    typeof marker.ceremony_start_ts !== "string" ||
    typeof marker.target_repo_owner !== "string" ||
    typeof marker.target_root_commit !== "string"
  ) {
    return false;
  }

  // Find the candidate signer's pubkey in the roster. Scan ALL persons
  // including PLACEHOLDER- entries: a fresh genesis has the genesis-owner
  // pre-populated but the placeholders are still mixed in.
  if (!roster || !roster.persons) return false;
  let pubkey = null;
  let keyType = "ssh";
  for (const person of Object.values(roster.persons)) {
    if (!person || !Array.isArray(person.keys)) continue;
    for (const k of person.keys) {
      if (k && k.fingerprint === marker.candidate_signer_fingerprint) {
        pubkey = k.pubkey;
        keyType = k.type || "ssh";
        break;
      }
    }
    if (pubkey) break;
  }
  if (!pubkey) return false;

  const { sig, ...core } = marker;
  let bytes;
  try {
    bytes = cocSign.canonicalSerialize(core);
  } catch {
    return false;
  }
  let r;
  try {
    r = cocSign.verify(bytes, sig, pubkey, { keyType });
  } catch {
    return false;
  }
  return !!(r && r.ok === true && r.valid === true);
}

function loadRoster(rosterPath) {
  if (!fs.existsSync(rosterPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  } catch {
    return null;
  }
}

// NOTE (F72 anti-narrowing): this counts ANY parseable JSON line as a record —
// it does NOT filter on `type === "genesis-anchor"` or verify signatures. The
// F72 fresh-vs-enrolled discriminator (`records.length === 0` in the no-roster
// branch) depends on this: over-counting is fail-CLOSED (a stray parseable line
// trips the enrolled→block branch, never the fresh→advisory branch). Do NOT
// narrow this to genesis-anchor-only — that would let a partially-written log
// read as `length === 0` (fresh) on a roster-absent repo, weakening the
// discriminator toward fail-OPEN. (security-reviewer LOW-1, journal/0176.)
function loadLogRecords(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  const records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      records.push(rec);
    } catch {
      // Skip malformed lines — they cannot be folded. A malformed line is
      // a structural-NULL: we have insufficient information to verify
      // anything, so it contributes neither to the trust root nor to the
      // peer high-water.
    }
  }
  return records;
}

// Verify a record's signature against a roster pubkey, using the same
// shape the fold predicate uses. Returns boolean.
function verifyRecord(record, roster) {
  if (!record || !record.sig || !record.verified_id || !record.person_id)
    return false;
  if (!roster || !roster.persons) return false;
  const person = roster.persons[record.person_id];
  if (!person) return false;
  if (isUnenrolled(record.person_id)) return false;
  const key = (person.keys || []).find(
    (k) => k.fingerprint === record.verified_id,
  );
  if (!key) return false;
  try {
    const { sig, ...core } = record;
    const bytes = cocSign.canonicalSerialize(core);
    const r = cocSign.verify(bytes, record.sig, key.pubkey, {
      keyType: key.type,
    });
    return r && r.ok === true && r.valid === true;
  } catch {
    return false;
  }
}

// Fold the log to find:
//   - the LATEST verifying owner-bound genesis-anchor-or-migration
//   - the peer-observed genesis_generation high-water (max across signature-
//     verified genesis-migration records)
//
// "Latest" is by seq for the trust-root computation; rule 9a's first-wins
// applies during normal fold, but the GUARD asks a slightly different
// question: "is there a verifying owner-bound anchor available?" — we run
// the fold predicate and check if foldState.trustRoot ends up non-null.
function foldChain(records, roster) {
  let state = { trustRoot: null };
  let peerHighWater =
    roster && roster.genesis ? roster.genesis.genesis_generation || 0 : 0;
  let observedAnchor = null;
  let observedMigration = null;
  for (const rec of records) {
    if (rec.type === "genesis-anchor") {
      const result = foldGenesisAnchor(rec, state, roster, cocSign.verify);
      if (result.accepted) {
        state = result.foldState;
        observedAnchor = rec;
      }
      // A trust-root fork detected here is itself a block-grade signal,
      // but A0b-2a's guard only enforces the absence-of-anchor and
      // peer-generation-partition cases per the shard contract; fork
      // surfacing is the fold engine's job in A2a. We still capture the
      // first verifying anchor for the trust-root presence check.
    } else if (rec.type === "genesis-migration") {
      // Verify the migration record signature (signed by an owner per
      // rule 9c). A2a/A3 will fold the full migration semantics; for
      // the guard we need only the genesis_generation observation.
      if (verifyRecord(rec, roster)) {
        observedMigration = rec;
        const gen =
          rec.content &&
          rec.content.genesis &&
          rec.content.genesis.genesis_generation;
        if (Number.isInteger(gen) && gen > peerHighWater) {
          peerHighWater = gen;
        }
      }
    }
  }
  return {
    trustRoot: state.trustRoot,
    peerHighWater,
    observedAnchor,
    observedMigration,
  };
}

// ---- main -------------------------------------------------------------------

try {
  const payload = readStdinSync();
  // PreToolUse event names: CC uses "PreToolUse". Codex/Gemini variants
  // would map their pre-tool events; this hook is registered per-CLI
  // by sync-manifest.yaml at land time.
  const hookEvent = payload.hook_event_name || "PreToolUse";

  if (!isWatchedTool(payload)) {
    passthrough();
  }

  const { logPath, rosterPath } = resolvePaths();

  // Load the coordination-log records up-front: they are the substrate-native
  // "has this repo ever enrolled?" signal. Enrollment (/whoami --enroll-genesis)
  // ALWAYS writes a signed `genesis-anchor` record into this log (operators.
  // roster.README.md § "Why the live file ships with PLACEHOLDER" step 3), so an
  // empty/absent log ⟺ never-enrolled. `loadLogRecords` returns [] when the log
  // file is absent.
  const records = loadLogRecords(logPath);

  // The roster is REQUIRED context for an ENROLLED repo: without it we cannot
  // identify the owner-bound key, so we cannot verify any anchor.
  const roster = loadRoster(rosterPath);
  if (!roster) {
    // F72 (issue #379) — fresh-consumer vs enrolled-then-deleted discrimination.
    // Mirrors trust-posture.md MUST-2 (fresh repo vs corrupt state) and the
    // scaffold-roster advisory branch below: distinguish a USE-template consumer
    // that received the substrate hooks but NEVER enrolled (no roster AND empty
    // coordination log) from an enrolled repo whose roster was deleted (roster
    // gone BUT the log still carries enrollment records).
    if (records.length === 0) {
      // Fresh-substrate adopter: no roster + no coordination-log records =
      // never enrolled. Advisory pass-through so the consumer can land its
      // first commits (this is exactly what the enrollment ceremony itself
      // requires). Once enrollment writes the first genesis-anchor record into
      // the log, the enrolled-then-deleted fail-CLOSED branch below takes over.
      // The coordination LOG is the correct signal here — NOT `.initialized`,
      // which the posture hook writes on a fresh consumer's FIRST session even
      // when no enrollment has occurred (using `.initialized` would wrongly
      // hard-block a never-enrolled consumer that merely ran one session).
      emit({
        hookEvent,
        severity: "advisory",
        what_happened:
          "Sign/commit/push attempted on a fresh-substrate-adopter repo (no operators roster; coordination log empty/absent = never enrolled).",
        why: "multi-operator-coc/genesis-anchor-guard — fresh-substrate-adopter branch (F72 / issue #379): no roster + empty coordination log = never-enrolled; advisory pass-through mirrors trust-posture.md MUST-2 fresh-repo semantics + the scaffold-roster branch. Once an enrollment record lands in the log, fail-CLOSED takes over.",
        agent_must_report: [
          "State that the repo is in fresh-substrate-adopter state (no roster, empty coordination log)",
          "Schedule the enrollment ceremony (/whoami --enroll-genesis) as the M9.x follow-up before the next /release",
        ],
        agent_must_wait:
          "Continue; enrollment is the M9.x follow-up. No block.",
        user_summary:
          "genesis-anchor-guard — fresh-substrate adopter advisory; enrollment outstanding",
      });
      // emit() exits 0 here (severity:advisory → continue:true); control does not return.
    }

    // Enrolled-then-deleted: the coordination log carries enrollment records but
    // the roster is gone. This is the guard-escape-by-roster-deletion attack
    // (HIGH-2, M0 security review): without a roster we cannot resolve any
    // candidate signer's pubkey, so the signed-marker bypass is unreachable.
    // Fail-CLOSED. (operators.roster.json is a tracked, committed file — the
    // correct recovery is `git checkout` it, not re-enrollment.)
    emit({
      hookEvent,
      severity: "block",
      what_happened:
        "Sign/commit/push/roster-edit attempted but operators roster is missing or unreadable while the coordination log carries prior enrollment records — this repo WAS enrolled.",
      why: "multi-operator-coc/genesis-anchor-guard — fail-CLOSED: roster missing while the coordination log carries enrollment records = enrolled-then-deleted; no verifiable trust root (architecture §2.3 + §4.3, journal/0117)",
      agent_must_report: [
        "Quote the exact tool call that was attempted",
        "State that the operators.roster.json is missing or unreadable while the coordination log carries prior enrollment records",
        "Recommend restoring operators.roster.json from version control (it is a tracked, committed file) rather than re-enrolling",
      ],
      agent_must_wait:
        "Do not retry the sign/commit/push until the roster is restored.",
      user_summary:
        "genesis-anchor-guard — roster missing on a previously-enrolled repo; restore from version control",
    });
    // emit() exits; we never return here
  }

  const { trustRoot, peerHighWater } = foldChain(records, roster);

  if (trustRoot === null) {
    // M9.1 R1 Bootstrap-1 — scaffolded-but-not-enrolled fresh-repo branch.
    // Mirrors trust-posture.md MUST-2 (fresh repo vs corrupt state). When
    // the roster is structurally a SCAFFOLD (genesis.repo_owner carries
    // the documented PLACEHOLDER-* prefix convention from the schema
    // template) AND the coordination log is ABSENT, the repo has never
    // been enrolled — this is the fresh-substrate-adopter case, not an
    // attack surface. The guard emits `advisory` (not `block`) so the
    // repo can land its first commits, which is what the enrollment
    // ceremony itself requires.
    //
    // M9.1 R3 Sec-R3-S-03 — use the shared `isUnenrolled(personId)`
    // predicate from `roster-schema-validate.js:261` (which matches the
    // documented `PLACEHOLDER-*` prefix convention per
    // `operators.roster.schema.json:27`), NOT a literal-string match.
    // The prior literal sentinel `PLACEHOLDER-replace-at-enrollment` was
    // narrower than the documented convention and would fail-CLOSED
    // every commit for downstream adopters whose scaffold uses a
    // conformant variant like `PLACEHOLDER-acme-foundation`.
    //
    // Detection uses two structural primitives both rooted in the schema
    // template (operators.roster.schema.json): (a) the shared
    // PLACEHOLDER-* prefix predicate is process-local deterministic per
    // hook-output-discipline.md MUST-2; (b) `fs.existsSync(logPath)` is
    // likewise a structural file-system check. Once enrollment writes a
    // real repo_owner + persons + first signed `genesis-anchor` into the
    // log, the guard's fail-CLOSED branch (below) takes over normally.
    const isScaffoldRoster =
      roster.genesis && isUnenrolled(roster.genesis.repo_owner);
    const logAbsent = !require("fs").existsSync(logPath);
    if (isScaffoldRoster && logAbsent) {
      // Fresh substrate adopter: roster is a scaffold, log has never been
      // initialized. Surface advisory so the operator knows enrollment is
      // outstanding, but allow the commit through.
      emit({
        hookEvent,
        severity: "advisory",
        what_happened:
          "Sign/commit/push attempted on a fresh-substrate-adopter repo (roster is scaffold; coordination log absent).",
        why: "multi-operator-coc/genesis-anchor-guard — fresh-substrate-adopter branch (M9.1 Bootstrap-1): scaffold roster + absent log = never-enrolled; advisory pass-through mirrors trust-posture.md MUST-2 fresh-repo semantics. Once enrollment lands, fail-CLOSED takes over.",
        agent_must_report: [
          "State that the repo is in fresh-substrate-adopter state (scaffold roster + absent log)",
          "Schedule the enrollment ceremony as M9.x follow-up before the next /release",
        ],
        agent_must_wait:
          "Continue; enrollment is the M9.x follow-up. No block.",
        user_summary:
          "genesis-anchor-guard — fresh-substrate adopter advisory; enrollment outstanding",
      });
      // emit() exits 0 here (severity:advisory → continue:true); control does not return.
    }

    // No verifying owner-bound anchor in the log.
    // HIGH-2: enrollment-in-progress bypass requires a SIGNED marker
    // whose signature verifies under a candidate signer's pubkey in the
    // roster. Unsigned / tampered / wrong-key markers fall through to
    // the fail-CLOSED emit below.
    if (checkEnrollmentInProgress(roster)) {
      // Enrollment in progress — pass through to allow the ceremony itself
      // to complete (it MUST write the genesis-anchor as part of its flow).
      passthrough();
    }
    emit({
      hookEvent,
      severity: "block",
      what_happened:
        "Sign/commit/push/roster-edit attempted with no verifying owner-bound genesis-anchor in the coordination log.",
      why: "multi-operator-coc/genesis-anchor-guard — fail-CLOSED per architecture §4.3 + §2.3 + journal/0117 (the §4.5 genesis residual is bounded BY this guard)",
      agent_must_report: [
        "Quote the exact tool call that was attempted",
        "State that no signature-verifying owner-bound genesis-anchor is present in the coordination log",
        "Run /whoami --enroll-genesis to establish the trust root, OR confirm an enrollment ceremony is already in progress via the COC_GENESIS_GUARD_ENROLLMENT_MARKER env var",
      ],
      agent_must_wait:
        "Do not retry the sign/commit/push until the trust root is established by the enrollment ceremony.",
      user_summary:
        "genesis-anchor-guard — no trust root; enrollment ceremony required",
    });
  }

  // Trust root present + verifying. Check genesis-generation partition.
  const localGen = (roster.genesis && roster.genesis.genesis_generation) || 0;
  if (peerHighWater > localGen) {
    // Degraded to halt-and-report per architecture §4.3.
    emit({
      hookEvent,
      severity: "halt-and-report",
      what_happened: `Local genesis_generation (${localGen}) is below peer-observed high-water (${peerHighWater}) per signature-verified genesis-migration record(s) in the log.`,
      why: "multi-operator-coc/genesis-anchor-guard — post-migration partition (architecture §4.3 + §2.2 fold rule 9d + R7-A-02/R8-S-04)",
      agent_must_report: [
        "Quote the exact tool call that was attempted",
        `State that the local roster's genesis_generation is ${localGen} but a signature-verifying genesis-migration record at generation ${peerHighWater} is folded in the log`,
        "Fetch the latest refs/coc/coordination-genN to converge before proceeding",
      ],
      agent_must_wait:
        "Do not retry until the local genesis_generation is at or above the peer high-water.",
      user_summary: `genesis-anchor-guard — stale-root advisory (local gen ${localGen} < peer high-water ${peerHighWater})`,
    });
  }

  // All checks passed.
  passthrough();
} catch (err) {
  // Defense-in-depth. Any unexpected exception during the guard's own
  // logic MUST NOT block the agent — the timeout-fallback semantics
  // apply: pass through with a {continue: true}. Crypto-check failures
  // are NOT exceptions; they take the structured-emit path above.
  try {
    process.stderr.write(
      `[ADVISORY] genesis-anchor-guard internal error: ${err && err.message ? err.message : String(err)}\n`,
    );
  } catch {
    // ignored — stderr write failure is best-effort
  }
  passthrough();
}
