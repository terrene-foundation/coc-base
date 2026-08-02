#!/usr/bin/env node
/**
 * emit-derives-from.mjs — loom#1228 (W1 item B1, the S-1 provenance-edge PRODUCER, loom lane).
 *
 * THE RUNNABLE FIRING PATH for the `derives_from[]` PROV edge. `/codify` invokes THIS at its
 * Step 3/4 artifact-emission point (`.claude/commands/codify.md` § "3. Update existing agents" +
 * § "4. Update existing skills"); the record shape + every hygiene invariant live one layer down in
 * `.claude/hooks/lib/derives-from-edge.js`, and the staging sink in `derives-from-ledger.js`.
 *
 * WHY A BIN AND NOT JUST THE LIBRARY: `rules/specs-authority.md` Rule 11 marks the emission
 * MANDATORY and BLOCKED-if-omitted, but a library plus a prose instruction is only invocable by an
 * agent hand-writing a `node -e` one-liner that embeds the whole artifacts array — so in practice
 * the mandate silently would not fire, while Rule 11's own completeness detector is deferred to the
 * unbuilt kailash-rs #1951 consumer. Unenforced AND unverifiable is the failure class `journal/0488`
 * minted the `/cross-repo-authorize` affordance to close ("the ceremony had no producer and the
 * receipt was un-producible"). A named, runnable command is the producer.
 *
 * EXIT CONTRACT — this is a CLI, NOT a fail-open hook. It reports loudly:
 *   0 — every artifact's edge staged (or an explicit empty `artifacts: []` = nothing to stage)
 *   1 — ≥1 record REJECTED (a citation defect, a refused sink, or an internal fault)
 *   2 — usage error: the payload was absent, unparseable, or structurally wrong
 * The fail-OPEN guarantee belongs to the LIBRARY (a capture failure never throws into `/codify`);
 * this CLI's job is to make a rejection VISIBLE to the caller, so it exits non-zero with the typed
 * reason instead of swallowing it.
 *
 * USAGE — JSON on stdin, using the CONTRACT's snake_case field names (the same names the frozen v0
 * record carries, so an author reads one vocabulary in Rule 11, the contract, and here):
 *
 *   echo '{
 *     "session_id": "sess-abc",
 *     "artifacts": [
 *       { "artifact_type": "rule", "artifact_id": "specs-authority",
 *         "derives_from": [ { "anchor": "specs/x.md#§Some Heading", "anchor_kind": "spec" } ] },
 *       { "artifact_type": "skill", "artifact_id": "some-skill", "derives_from": [] }
 *     ]
 *   }' | node .claude/bin/emit-derives-from.mjs
 *
 * `derives_from: []` is the first-class ORPHAN signal — pass it, never omit the artifact.
 * Optional: `"repo_dir"` (defaults to cwd; the sink anchors at the discovered repo root either way)
 * and `"now_iso"` (an ISO-8601 timestamp; defaults to now — supplied by tests for determinism).
 *
 * ORPHAN STATUS: this stages edges to a local gitignored sink. NOTHING drains it — no reverse
 * index, no query surface; the consumer is kailash-rs #1951 and is NOT built. Do not read a
 * successful exit as end-to-end provenance.
 */

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { emitCodifyArtifactEdges, _resolveRepoRoot } = require("../hooks/lib/derives-from-ledger.js");
const { readStdinBounded } = require("../hooks/lib/read-stdin-bounded.js");

const EXIT_OK = 0;
const EXIT_REJECTED = 1;
const EXIT_USAGE = 2;

/**
 * Cap the batch, for symmetry with the library's `MAX_DERIVES_FROM`. The only prior bound was the
 * 10 MiB stdin backstop, which is measured in UTF-16 code units and so is not a work bound: each
 * artifact costs its own file reads. A `/codify` pass touching >256 artifacts is a payload bug.
 */
const MAX_ARTIFACTS = 256;

// R1345-S6 — the containment guard resolves through the LIBRARY's own `_resolveRepoRoot`,
// not a copy of it. The guard is only meaningful if its notion of "the repo root" is the
// SAME one the sink anchors at; a duplicated walker held that equal by convention, and the
// duplicate's own comment ("mirrors the library ... so they agree") is not a mechanism.
// Sharing the callee is what makes them agree by construction.

// A unique sentinel so an absent / unparseable / timed-out payload is DISTINGUISHABLE from a
// legitimately-empty object. `readStdinBounded` resolves its `fallback` on every non-happy path,
// so without a sentinel a parse failure would be indistinguishable from `{}` and would exit 2 for
// the wrong reason (or worse, look like a valid empty payload).
const NO_PAYLOAD = Symbol("no-payload");

function usage(msg) {
  process.stderr.write(
    `emit-derives-from: ${msg}\n\n` +
      `Usage: echo '<json>' | node .claude/bin/emit-derives-from.mjs\n` +
      `  payload: { "session_id": "<id>", "artifacts": [ { "artifact_type": "agent|skill|rule|hook",\n` +
      `             "artifact_id": "<id>", "derives_from": [ { "anchor": "<path>#§<section>" |\n` +
      `             "<path>::<symbol>", "anchor_kind": "spec|artifact|workspace" } ] } ] }\n` +
      `  \`derives_from: []\` is the ORPHAN signal — emit it, never omit the artifact.\n` +
      `  See rules/specs-authority.md Rule 11 + skills/30-claude-code-patterns/derives-from-emission.md\n`,
  );
  return EXIT_USAGE;
}

/** Map the contract's snake_case payload onto the ledger's camelCase args. */
function toLedgerArtifacts(raw) {
  return raw.map((a) => ({
    artifactType: a && a.artifact_type,
    artifactId: a && a.artifact_id,
    // Pass THROUGH untouched (including `undefined`): the library rejects a missing array
    // fail-loud rather than defaulting to `[]`, because defaulting would forge an orphan claim
    // the caller never made. Do not "helpfully" default it here either.
    derivesFrom: a && a.derives_from,
  }));
}

async function main() {
  const payload = await readStdinBounded({ fallback: NO_PAYLOAD });
  if (payload === NO_PAYLOAD)
    return usage("no readable JSON payload on stdin (absent, unparseable, or timed out)");
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    return usage("payload MUST be a JSON object");
  if (typeof payload.session_id !== "string" || payload.session_id.trim() === "")
    return usage("payload.session_id MUST be a non-empty string");
  if (!Array.isArray(payload.artifacts))
    return usage(
      "payload.artifacts MUST be an array (an EMPTY array is accepted and means " +
        "'this pass touched no artifacts')",
    );
  if (payload.artifacts.length > MAX_ARTIFACTS)
    return usage(
      `payload.artifacts MUST carry at most ${MAX_ARTIFACTS} entries ` +
        `(got ${payload.artifacts.length}); each costs its own file reads`,
    );
  for (const [i, a] of payload.artifacts.entries())
    if (a === null || typeof a !== "object" || Array.isArray(a))
      return usage(`payload.artifacts[${i}] MUST be an object`);

  // R1345-H1 — `repo_dir` arrives from UNTRUSTED stdin, so it MUST NOT be able to select a repo
  // other than the one this CLI is running in. Unconstrained it is a CROSS-REPO WRITE primitive:
  // pointed at a sibling checkout, the sink lands THERE via a plain `fs.writeSync` (so the
  // `gh`-oriented repo-scope hook never fires), and the row — operator-correlatable by this
  // feature's own gitignore rationale — lands outside the gitignore fence, which exists only in
  // repos that already synced this change.
  // The check lives HERE, at the untrusted-input boundary, and NOT in the library: the library is
  // legitimately driven against an explicit repo by tests and by other in-process tooling, so
  // containment there would break trusted callers while adding nothing against this threat.
  // Both sides resolved through the SAME resolver before comparison (security.md § Path Containment).
  const requestedRepoDir =
    typeof payload.repo_dir === "string" ? payload.repo_dir : process.cwd();
  const requestedRoot = _resolveRepoRoot(requestedRepoDir);
  const ownRoot = _resolveRepoRoot(process.cwd());
  if (requestedRoot === null || ownRoot === null || requestedRoot !== ownRoot)
    return usage(
      `payload.repo_dir ${JSON.stringify(requestedRepoDir)} resolves to repo root ` +
        `${JSON.stringify(requestedRoot)}, which is not this process's repo root ` +
        `${JSON.stringify(ownRoot)} — refusing to stage a provenance record into another repository`,
    );

  const res = emitCodifyArtifactEdges({
    // R1345-S6 — hand the library the RESOLVED root, never the raw caller value. Passing
    // `requestedRepoDir` meant the guard validated one value and the library re-resolved a
    // DIFFERENT one (twice per artifact: once in preflight, once in the write pass), so a
    // path re-pointed between check and use would land the sink in another repo — and the
    // sink's own containment would then confirm containment inside that wrong repo. Passing
    // the already-resolved root removes the re-resolution entirely rather than narrowing the
    // window (security.md § Path Containment: the check and the use must be the same value).
    repoDir: requestedRoot,
    sessionId: payload.session_id,
    nowIso: typeof payload.now_iso === "string" ? payload.now_iso : undefined,
    artifacts: toLedgerArtifacts(payload.artifacts),
  });

  if (res.empty) {
    process.stdout.write("emit-derives-from: no artifacts in payload — nothing staged\n");
    return EXIT_OK;
  }

  // Per-artifact reporting: a rejection names the artifact AND the stage, so the caller can tell a
  // citation defect (fix the anchor) from a refused sink (an environment problem) from an internal
  // fault — the three lanes the library keeps distinguishable.
  res.results.forEach((r, i) => {
    const id = payload.artifacts[i] && payload.artifacts[i].artifact_id;
    if (r.ok) return;
    process.stderr.write(
      `  REJECTED [${r.stage}] ${JSON.stringify(id)}: ${r.error}\n`,
    );
  });
  // A batch-level error (e.g. the atomic refusal) carries no per-row rejection, so it MUST be
  // surfaced rather than discarded — and the exit MUST derive from `res.ok`, not only from the
  // `rejected` counter. Deriving it from a redundant counter is what silently breaks on the next
  // edit, and THIS exit code is the compensating control Rule 11 invariant 1 leans on.
  if (res.error) process.stderr.write(`  ${res.error}\n`);
  process.stdout.write(
    `emit-derives-from: staged ${res.staged}/${res.results.length} ` +
      `(orphan rows: ${res.orphans}, rejected: ${res.rejected})\n`,
  );
  const staged = res.results.find((r) => r.ok);
  if (staged && staged.sinkPath) process.stdout.write(`  sink: ${staged.sinkPath}\n`);
  return res.ok && res.rejected === 0 ? EXIT_OK : EXIT_REJECTED;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // A throw HERE is an internal fault in this CLI, not a caller-citation defect; surface it and
    // exit non-zero rather than reporting a false success.
    process.stderr.write(
      `emit-derives-from: internal fault: ${e && e.message ? e.message : String(e)}\n`,
    );
    process.exit(EXIT_REJECTED);
  },
);
