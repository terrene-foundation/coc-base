#!/usr/bin/env node
/**
 * Bipolar fixtures for `.claude/bin/check-agents-md-size.mjs`.
 *
 * Every arm is a POLE PAIR: an input the gate must flag and a near-miss input it
 * must pass. A gate that reds on everything is not a gate, so each RED here has
 * a GREEN twin that differs in the one property under test — and each RED asserts
 * a failure IDENTITY (`agents-md-size/...`), never a bare non-zero
 * (`instrument-bipolarity.md` MUST-2).
 */

"use strict";

import {
  parseCapFromConfigToml,
  effectiveCap,
  deriveWarnBand,
  assess,
  CODEX_DEFAULT_CAP,
  EXIT,
} from "../../bin/check-agents-md-size.mjs";

let passed = 0;
let failed = 0;
// Emit ONE line per case in the shape `run-audit-fixtures.mjs` parses
// (`/^[ \t]*(?:PASS|ok)[ \t]+\S/`). Printing only on failure looks fine when the
// file is run directly — 28/28 green — while the CI runner counts ZERO cases and
// reds as `0p/0f 0c` against its min_cases floor. That is the same
// absence-reads-as-clean shape this gate exists for, one layer up: a suite whose
// silence on success is indistinguishable from a suite that never ran.
function check(name, actual, expected) {
  if (String(actual) === String(expected)) {
    passed += 1;
    process.stdout.write(`  PASS  ${name} → ${String(actual)}\n`);
  } else {
    failed += 1;
    process.stdout.write(
      `  FAIL  ${name} → got ${JSON.stringify(String(actual))}, want ${JSON.stringify(String(expected))}\n`,
    );
  }
}

// ---- (a) THE CAP IS READ, NOT ASSUMED -----------------------------------
check("cap:read-from-config", parseCapFromConfigToml("project_doc_max_bytes = 65536"), 65536);
check("cap:read-with-whitespace", parseCapFromConfigToml("  project_doc_max_bytes   =  1024  "), 1024);
check("cap:consumer-own-value-wins", effectiveCap("project_doc_max_bytes = 99999").cap, 99999);
// GREEN twin of the comment pole: an ACTIVE key next to a commented one still reads.
check(
  "cap:active-key-alongside-comment",
  parseCapFromConfigToml("# project_doc_max_bytes = 999\nproject_doc_max_bytes = 4096"),
  4096,
);
// RED pole: a COMMENTED key must NOT set the cap — otherwise a consumer who
// commented it out is measured against a cap nothing enforces.
check("cap:commented-key-ignored", parseCapFromConfigToml("# project_doc_max_bytes = 999"), "null");
check("cap:trailing-comment-stripped", parseCapFromConfigToml("project_doc_max_bytes = 512 # why"), 512);
check("cap:non-numeric-ignored", parseCapFromConfigToml("project_doc_max_bytes = big"), "null");

// ---- (c) FAIL CLOSED ON AN UNREADABLE CAP -------------------------------
// This is the LIVE case: Codex's default is 32 KiB and this corpus's AGENTS.md
// exceeds it, so an unreadable config must NOT pass.
check("failclosed:no-config-uses-codex-default", effectiveCap(null).cap, CODEX_DEFAULT_CAP);
check("failclosed:no-config-marked-unreadable", effectiveCap(null).readable, "false");
check("failclosed:unparsed-marked-unreadable", effectiveCap("model = \"gpt\"\n").readable, "false");
check("failclosed:source-names-which-fallback", effectiveCap(null).source, "codex-default-no-config");
{
  // The real shape: 52,737 B AGENTS.md, no config -> measured against 32 KiB -> EXCEEDS.
  const { cap } = effectiveCap(null);
  const r = assess({ sizeBytes: 52737, cap, band: 10348 });
  check("failclosed:real-corpus-exceeds-default", r.identity, "agents-md-size/exceeds-cap");
  check("failclosed:real-corpus-exit", r.exit, EXIT.EXCEEDS);
  // GREEN twin: the SAME file under the consumer's declared 64 KiB cap is fine.
  const ok = assess({ sizeBytes: 52737, cap: 65536, band: 10348 });
  check("failclosed:same-file-ok-under-declared-cap", ok.verdict, "OK");
}

// ---- (b) THE WARNING BAND FIRES BEFORE THE CLIFF ------------------------
{
  const band = 10348;
  // RED: headroom smaller than one large baseline rule's emitted contribution.
  const warn = assess({ sizeBytes: 65536 - 5000, cap: 65536, band });
  check("band:approaching-identity", warn.identity, "agents-md-size/approaching-cap");
  check("band:approaching-exit", warn.exit, EXIT.APPROACHING);
  // GREEN twin: one byte MORE headroom than the band -> OK. Same cap, same band,
  // differing only in the property under test.
  const ok = assess({ sizeBytes: 65536 - band - 1, cap: 65536, band });
  check("band:just-outside-is-ok", ok.verdict, "OK");
  // Boundary is exact, not fuzzy: headroom === band is OK (band is a floor).
  const edge = assess({ sizeBytes: 65536 - band, cap: 65536, band });
  check("band:headroom-equals-band-is-ok", edge.verdict, "OK");
  // At the cap itself, EXCEEDS outranks APPROACHING.
  const at = assess({ sizeBytes: 65536, cap: 65536, band });
  check("band:at-cap-is-exceeds-not-approaching", at.identity, "agents-md-size/exceeds-cap");
}

// ---- THE BAND IS DERIVED, AND SAYS WHEN IT IS NOT -----------------------
{
  // Loom's measured shape: 42,856 raw largest / 218,429 raw total / 52,737 emitted.
  const d = deriveWarnBand({
    agentsSize: 52737,
    largestBaselineRaw: 42856,
    totalBaselineRaw: 218429,
  });
  check("derive:is-derived", d.derived, "true");
  check("derive:matches-measured-band", d.band, 10348);
  // The headroom on this tree (12,799 B) is only just above that band — the
  // finding a round number would have hidden. Pin it so a future emission
  // change that erases the margin reds here.
  check("derive:corpus-is-one-rule-from-cliff", String(65536 - 52737 > d.band), "true");
  check("derive:margin-is-thin", String(65536 - 52737 - d.band < 3000), "true");
  // RED pole: no corpus to calibrate against -> must SAY it is a fallback rather
  // than return a number that looks derived.
  const f = deriveWarnBand({ agentsSize: 52737, largestBaselineRaw: 0, totalBaselineRaw: 0 });
  check("derive:fallback-flagged", f.derived, "false");
  check("derive:fallback-has-reason", String(Boolean(f.reason)), "true");
}

// ---- VERDICTS ARE DISTINCT (a collapsed verdict space hides the cliff) ---
{
  const ids = new Set([
    assess({ sizeBytes: 10, cap: 65536, band: 10348 }).identity,
    assess({ sizeBytes: 60000, cap: 65536, band: 10348 }).identity,
    assess({ sizeBytes: 70000, cap: 65536, band: 10348 }).identity,
  ]);
  check("verdicts:three-distinct-identities", ids.size, 3);
  check("verdicts:exit-ok-is-zero", EXIT.OK, 0);
  check("verdicts:unmeasured-is-not-a-pass", String(EXIT.UNMEASURED !== EXIT.OK), "true");
}

process.stdout.write(`\nagents-md-size fixtures: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
