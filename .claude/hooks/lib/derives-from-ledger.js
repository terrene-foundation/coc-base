"use strict";

/**
 * derives-from-ledger.js — loom#1228 (W1 item B1, the S-1 provenance-edge producer, loom lane).
 *
 * The BEST-EFFORT LOCAL STAGING SINK for the `derives_from[]` PROV-edge stream + the emit helper
 * `/codify` calls at its Step 3/4 artifact-emission point (`.claude/commands/codify.md` § "3.
 * Update existing agents" + § "4. Update existing skills"). loom EMITS here; the kailash-rs S-1
 * consumer (#1951) is expected to DRAIN this sink and persist into the local DataFlow
 * accountability store.
 *
 * THIS IS NOT THE STORE. It is a per-session append-only JSONL staging file — the loom side of the
 * producer/consumer seam, exactly analogous to how `artifact-activation-ledger.js` is the staging
 * half of the loom→kailash-S-3 activation seam and `provenance-ledger.js` the degraded-local half
 * of the loom↔csq provenance seam. loom does NOT build the DataFlow store (the "no coding"
 * charter); it stages edges for the engine to ingest.
 *
 * ORPHAN STATUS — READ THIS BEFORE CITING THIS MODULE AS A CAPABILITY (`rules/orphan-detection.md`;
 * `rules/user-flow-validation.md` MUST-8). Only the PRODUCER half exists. As of 2026-07-25 there
 * is NO drain, NO reverse index, and NO "where did artifact X come from?" query surface anywhere
 * in this repo or downstream — the consumer is gated on kailash-rs **#1951** (loom#1228 item B1's
 * dependency), which has not shipped. Edges written here accumulate in a gitignored local sink and
 * are read by nothing. That is the DESIGNED v0 state (loom freezes the emit-side shape first so
 * S-1 ratifies against a tripwire — emit contract § 5), not a converged end-to-end capability.
 *
 * TRANSPORT DECISION (v0). The emit contract § 5 Q3 leaves transport OPEN — a drained staging sink
 * (mirroring the ArtifactActivationEvent sibling) vs a direct DataFlow store write (the design
 * § 1.4 phrasing) — as an explicit **v0→v1 coordination point, NOT a v0 field-shape question**.
 * v0 stages to a sink because (a) the direct-store-write alternative is unimplementable today (the
 * kailash-rs S-1 store does not exist), and (b) the staging sink is the SHIPPED #1209 precedent in
 * this same producer folder. When #1951 confirms the transport it expects, that answer rides the
 * coordinated v0→v1 bump; the field shape is unaffected either way.
 *
 * BEST-EFFORT / NEVER-THROWS. Every helper returns a result object and NEVER throws into the
 * caller's halting path — a capture failure degrades provenance, it NEVER blocks `/codify`
 * (`rules/hook-output-discipline.md`: an observability emitter fails open). The FAIL-LOUD half of
 * the contract lives one layer down in `derives-from-edge.js` (`buildDerivesFromEdge` THROWS, so a
 * malformed edge never reaches the sink); this layer converts that throw into a returned error.
 * The two halves together are the emit contract § 2 "validated at emit + validate time" mandate:
 * loud at construction, open at capture.
 *
 * DISCLOSURE CONTAINMENT. The sink lives under `.claude/learning/derives-from/` — the same
 * per-clone, never-committed operator-correlatable state class as `.claude/learning/provenance/`
 * (F101-2) and `.claude/learning/artifact-activation/` (#1209). Gitignored; never committed. This
 * is also the STRUCTURAL half of the emit contract § 3 mesh fence: the readable accountability
 * graph stays LOCAL, and nothing here pushes a readable anchor into the mesh `kp://` name-blind
 * plane (the in-band half is the `MESH_URN_RE` whole-record scan in `derives-from-edge.js`).
 *
 * Origin: loom#1228 item B1.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
// loom#1349 — the ONE hardened append primitive; see append-sink.js for the six defenses.
const { appendSinkLine } = require("./append-sink.js");

const {
  buildDerivesFromEdge,
  validateEdgeAnchorsResolve,
} = require("./derives-from-edge.js");

/**
 * Per-session sink file. Injective session_id → filename mapping (sanitized token + 8-char sha256
 * of the raw id), identical to the artifact-activation + provenance ledgers' fencing: two raw ids
 * that sanitize to the same token still land on distinct files; the charclass strips every path
 * separator so a crafted session_id cannot traverse out of the sink dir.
 */
/**
 * Resolve the REPO ROOT the sink must live at, by walking upward from `repoDir` for the nearest
 * `.git` or `.claude`. Returns null when neither is found.
 *
 * Load-bearing because `repoDir` defaults to `process.cwd()`: an ORPHAN row (`derives_from: []`)
 * iterates zero anchors, so nothing about the tree is ever touched and the write proceeds wherever
 * cwd happens to point. With anchors present, resolution fails first and nothing is written — the
 * empty-array case is the one that can escape. Anchoring at the discovered ROOT (rather than at an
 * arbitrary cwd) also keeps the sink under the path the gitignore fence covers.
 */
function _resolveRepoRoot(startDir) {
  let dir;
  try {
    dir = fs.realpathSync(startDir);
  } catch {
    return null;
  }
  for (;;) {
    // `.git` ONLY — deliberately NOT `.claude`. Every Claude Code install has `$HOME/.claude`, so
    // accepting `.claude` as the root marker made `$HOME` itself resolve as a "repo root": an ORPHAN
    // row (which touches no anchor and so cannot fail resolution first) then landed in
    // `$HOME/.claude/learning/derives-from/` — untracked, unignored, in the user's GLOBAL config
    // dir, i.e. exactly what this function's own refusal message claims to prevent. A repo is a
    // repo because it has `.git`.
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function _sinkPath(repoDir, session) {
  const hasSession = typeof session === "string" && session.trim().length > 0;
  const safe = hasSession
    ? session.replace(/[^A-Za-z0-9._-]/g, "_")
    : "unknown-session";
  const suffix = hasSession
    ? crypto.createHash("sha256").update(session, "utf8").digest("hex").slice(0, 8)
    : "00000000";
  return path.join(
    repoDir,
    ".claude",
    "learning",
    "derives-from",
    `${safe}-${suffix}.jsonl`,
  );
}

/**
 * Emit ONE DerivesFromEdge to the local staging sink. Best-effort: returns a result object; NEVER
 * throws. The two rejection classes are distinguished in the result so a caller can tell a
 * MALFORMED edge (a contract violation — the agent's citation is wrong) from a SINK-WRITE failure
 * (an environment problem — provenance degraded, nothing to fix in the citation):
 *   - `{ ok: false, stage: "validate", error }` — shape or anchor-resolution rejection (fail-loud
 *     one layer down, surfaced here rather than rethrown).
 *   - `{ ok: false, stage: "sink",     error }` — the record was valid; the append failed.
 *
 * @param {object}  a
 * @param {string}  a.repoDir        repo root the anchors resolve against (caller resolves it)
 * @param {string}  a.artifactType   agent|skill|rule|hook
 * @param {string}  a.artifactId     the generated Entity identity
 * @param {Array}   a.derivesFrom    DerivationSource[] — `[]` IS VALID and is the orphan signal
 * @param {string}  a.sessionId      session id
 * @param {string}  [a.nowIso]       ISO-8601 timestamp (caller supplies; testable)
 * Anchor tree-resolution is UNCONDITIONAL — there is no opt-out parameter by design (see the
 * comment at the resolution call).
 * @returns {{ ok: boolean, edge?: object, sinkPath?: string, stage?: string, error?: string }}
 */
function emitDerivesFromEdge(a) {
  const pre = _validateOnly(a);
  if (!pre.ok) return pre;
  return _appendToSink(pre.root, pre.edge);
}

/**
 * The VALIDATE half of an emission — resolve the repo root, build the edge (shape gate), and
 * resolve every anchor against the tree — WITHOUT writing. Shared by `emitDerivesFromEdge` and the
 * batch preflight so the two cannot drift: a batch that preflights with different rules than the
 * write path would re-open the partial-batch class from the other side.
 * @returns {{ok:true, edge:object, root:string} | {ok:false, stage:string, edge?:object, error:string}}
 */
function _validateOnly(a) {
  const repoDir = (a && a.repoDir) || process.cwd();
  const root = _resolveRepoRoot(repoDir);
  if (root === null)
    return {
      ok: false,
      stage: "sink",
      error:
        `no repo root found at or above ${JSON.stringify(repoDir)} (looked for .git) — refusing ` +
        `to write a provenance sink outside a repo, where it would be neither tracked nor covered ` +
        `by the gitignore fence`,
    };
  let edge;
  try {
    edge = buildDerivesFromEdge({
      artifactType: a.artifactType,
      artifactId: a.artifactId,
      // NOT defaulted to [] on a missing/garbage value: `[]` is the meaningful ORPHAN SIGNAL, so
      // silently manufacturing it from `undefined` would forge an orphan claim the caller never
      // made. An absent array is a caller bug and is rejected fail-loud below.
      derivesFrom: a.derivesFrom,
      sessionId:
        typeof a.sessionId === "string" && a.sessionId.trim()
          ? a.sessionId
          : "unknown-session",
      timestamp: a.nowIso || new Date().toISOString(),
    });
  } catch (e) {
    // A tagged contract violation is the CALLER's citation being wrong; anything else (a limit, a
    // bug here) is INTERNAL. Reporting the latter as "validate" would send the reader to audit a
    // citation that was fine.
    return {
      ok: false,
      stage: e && e.contract_violation ? "validate" : "internal",
      error: e && e.message ? e.message : String(e),
    };
  }

  // UNCONDITIONAL. There is deliberately no opt-out: a record staged without tree verification is
  // BYTE-IDENTICAL to a verified one, so the consumer's unbacked-anchor sweep — the whole point of
  // the edge — could not tell them apart, and Rule 11 invariant 2 states resolution is
  // unconditional. (An in-band `anchors_verified` field is NOT the fix: that widens the frozen v0
  // shape and needs S-1 coordination.)
  // R1345-H1 — resolve anchors against `root` (the DISCOVERED repo root), NOT the raw caller
  // `repoDir`. Those were different bases: the sink is written at `root`, so a `repo_dir` pointing
  // at a SUBDIRECTORY resolved every citation relative to that subdir while the record landed at the
  // repo root — and the frozen v0 record carries NEITHER base, so no consumer could ever reconstruct
  // which one a stored anchor was verified against. Rule 11 invariant 2 requires resolution against
  // the CURRENT tree; a caller-chosen base made the invariant satisfiable while meaningless (the
  // anchor resolves at emit time and resolves to nothing — or to a DIFFERENT file with a colliding
  // relative path — when the consumer re-resolves it from the root). One derived base, always.
  const res = validateEdgeAnchorsResolve({ repoDir: root, edge });
  if (!res.ok)
    return {
      ok: false,
      stage: "validate",
      edge,
      error: `anchor resolution failed:\n  - ${res.errors.join("\n  - ")}`,
    };

  return { ok: true, edge, root };
}

/**
 * Append ONE record to the per-session sink.
 *
 * loom#1349 R1 F4 — this function previously carried its OWN copy of all five defenses (ancestor
 * containment before mkdir, hard-link refusal on the fd, O_NOFOLLOW, per-append fchmod, O_NONBLOCK
 * for a planted FIFO). It was the FIRST append-only sink in the repo to reach that bar, and
 * `append-sink.js` is that shape extracted. Keeping both would be exactly the drift
 * `security.md` § Multi-Site Kwarg Plumbing forbids — and it bit immediately: the F1 fd-identity
 * guard (intermediate-component TOCTOU) would otherwise have had to be written twice, in two
 * files, by two future maintainers. One implementation, one place to harden.
 */
function _appendToSink(root, edge) {
  const w = appendSinkLine({
    repoDir: root,
    sinkPath: _sinkPath(root, edge.session_id),
    line: JSON.stringify(edge),
  });
  if (!w.ok) return { ok: false, stage: "sink", edge, error: `${w.error} — ${w.reason}` };
  return { ok: true, edge, sinkPath: w.sinkPath };
}

/**
 * Emit ONE edge per artifact touched in a `/codify` Step 3/4 pass. Returns a per-artifact result
 * array plus roll-up counters, so the orchestrator can report "N edges staged, M rejected" without
 * inspecting each row. NEVER throws.
 *
 * Every artifact in `artifacts` gets a record — including one with `derivesFrom: []`, which is the
 * first-class ORPHAN row the reverse-index sweep reads (emit contract § 2; design § 1.6 AC 2).
 * Dropping an orphan artifact from the batch is exactly the failure the empty array exists to
 * prevent, so this helper never filters.
 *
 * @param {object} a
 * @param {string} a.repoDir
 * @param {string} a.sessionId
 * @param {Array<{artifactType: string, artifactId: string, derivesFrom: Array}>} a.artifacts
 * @param {string} [a.nowIso]
 * @returns {{ ok: boolean, staged: number, rejected: number, orphans: number, results: Array }}
 */
function emitCodifyArtifactEdges(a) {
  // A MISSING / non-array `artifacts` is a CALLER BUG and is rejected with a diagnostic — NOT
  // silently coerced to `[]`. Coercing conflates two different states that need different
  // responses: "this codify pass touched no artifacts" (legitimate, nothing to stage) vs "the
  // caller forgot to pass the array" (a bug that would silently stage nothing and report
  // `ok:false` with zero explanation). Same reasoning as the missing-`derivesFrom` rejection one
  // layer down, where defaulting would forge an orphan claim.
  if (!a || !Array.isArray(a.artifacts))
    return {
      ok: false,
      staged: 0,
      rejected: 0,
      orphans: 0,
      results: [],
      error:
        "artifacts MUST be an array (got " +
        (a ? typeof a.artifacts : "no args") +
        ") — an EMPTY array is accepted and means 'this pass touched no artifacts'",
    };
  // An explicit EMPTY array is legitimate and distinguishable: ok:true with staged 0.
  if (a.artifacts.length === 0)
    return { ok: true, staged: 0, rejected: 0, orphans: 0, results: [], empty: true };

  const artifacts = a.artifacts;
  // VALIDATE EVERY ARTIFACT BEFORE WRITING ANY ROW. Per-artifact independent writes meant a batch
  // where A resolved and B did not exited non-zero WITH A's ROW ALREADY ON DISK — and the mandated
  // remedy (fix B's anchor, re-run) then appended a SECOND, byte-identical row for A (verified: 3
  // rows for 2 artifacts). A JSONL append can never be fully atomic (a crash mid-loop still leaves
  // a partial batch), so this closes the COMMON, deterministic case — a rejection — and the residual
  // crash case is covered by the contract-level dedup rule stated in the emit contract + Rule 11
  // (last row wins per `artifact_id` + `session_id`). Cheaper and safer than defining supersession
  // for a partial batch nobody asked for.
  const preflight = artifacts.map((art) =>
    _validateOnly({
      repoDir: a.repoDir,
      artifactType: art && art.artifactType,
      artifactId: art && art.artifactId,
      derivesFrom: art && art.derivesFrom,
      sessionId: a.sessionId,
      nowIso: a.nowIso,
    }),
  );
  if (preflight.some((p) => !p.ok))
    return {
      ok: false,
      staged: 0,
      rejected: preflight.filter((p) => !p.ok).length,
      orphans: 0,
      results: preflight,
      atomic_refusal: true,
      error:
        "no rows written — the batch is validated in full before any append, so a rejected " +
        "citation cannot leave a partial batch that a re-run would duplicate",
    };

  const results = artifacts.map((art) =>
    emitDerivesFromEdge({
      repoDir: a.repoDir,
      artifactType: art && art.artifactType,
      artifactId: art && art.artifactId,
      derivesFrom: art && art.derivesFrom,
      sessionId: a.sessionId,
      nowIso: a.nowIso,
    }),
  );
  const staged = results.filter((r) => r.ok).length;
  const orphans = results.filter(
    (r) => r.ok && r.edge && r.edge.derives_from.length === 0,
  ).length;
  return {
    ok: staged === results.length,
    staged,
    rejected: results.length - staged,
    orphans,
    results,
  };
}

module.exports = {
  emitDerivesFromEdge,
  emitCodifyArtifactEdges,
  _sinkPath,
  // Exported so the CLI's cross-repo containment guard uses THIS resolver rather than a
  // copy of it (R1345-S6). The guard's whole correctness rests on its notion of "the repo
  // root" matching the one the sink anchors at; a duplicated walker keeps them equal only
  // by convention, and a comment is not a mechanism. Same doctrine the sibling redaction
  // fix applies — ONE shared callee, because a per-surface copy is precisely what lets the
  // two drift apart later (security.md § Enforcement-Surface Parity).
  _resolveRepoRoot,
};
