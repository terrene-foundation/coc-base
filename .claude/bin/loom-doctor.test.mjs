#!/usr/bin/env node
/**
 * Unit tests for .claude/bin/loom-doctor.mjs (W3-a, onboarding-portability).
 *
 * Drives runDoctor() through injected seams (exec / readFile / role+resolver
 * fns / nodeVersion) so every check branch is exercised deterministically
 * without touching the real environment. Per probe-driven-verification.md
 * MUST-3 these are STRUCTURAL probes (status enum + summary counts + report
 * shape), not lexical regex against prose.
 *
 * Run: node --test .claude/bin/loom-doctor.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  runDoctor,
  formatReport,
  runFix,
  formatFixReport,
  parseFlags,
  exitCode,
} from "./loom-doctor.mjs";
import { LinkError } from "./lib/loom-links.mjs";

// A baseline all-green environment; individual tests override one seam.
function greenOpts(over = {}) {
  return {
    resolveRole: () => "platform",
    resolveAll: () => new Map([["build.py", { kind: "path", value: "/x" }]]),
    isConfigured: () => true,
    nodeVersion: "20.0.0",
    // exec: every probe succeeds (version + auth). `git config --get` for the
    // merge driver returns a registered value; autocrlf is unset (empty).
    exec: (cmd, args) => {
      if (args.includes("--get")) {
        if (args.includes("merge.coc-ledger.driver")) {
          return { ok: true, missing: false, code: 0, stdout: ".claude/hooks/lib/coc-ledger.js %O %A %B %P" };
        }
        return { ok: false, missing: false, code: 1, stdout: "" }; // autocrlf unset
      }
      return { ok: true, missing: false, code: 0, stdout: `${cmd} ok`, stderr: "" };
    },
    readFile: () => "* text=auto\n*.sh eol=lf\n.session-notes.shared.md merge=coc-ledger\n",
    ...over,
  };
}

function byId(result, id) {
  return result.checks.find((c) => c.id === id);
}

test("all-green environment → every check ok, summary counts match", () => {
  const r = runDoctor(greenOpts());
  assert.equal(r.schema_version, 1);
  assert.equal(r.summary.crit, 0);
  assert.equal(r.summary.warn, 0);
  // 10 checks (incl. merge-driver + ado-readiness). The green baseline is a
  // GitHub-authed clone with no roster, so ado-readiness correctly skips (info);
  // the other 9 are ok. info does not trip the "address items" / set -e gate.
  assert.equal(r.checks.length, 10);
  assert.equal(r.summary.ok, 9);
  assert.equal(byId(r, "ado-readiness").status, "info");
});

test("role null → warn with actionable remediation", () => {
  const r = runDoctor(greenOpts({ resolveRole: () => null }));
  const role = byId(r, "role");
  assert.equal(role.status, "warn");
  assert.match(role.remediation, /\.coc-role/);
});

test("role resolution throws LinkError → crit", () => {
  const r = runDoctor(
    greenOpts({
      resolveRole: () => {
        throw new LinkError("config-error", "invalid role \"boss\"");
      },
    }),
  );
  const role = byId(r, "role");
  assert.equal(role.status, "crit");
  assert.match(role.detail, /config-error/);
});

test("node below floor → crit", () => {
  const r = runDoctor(greenOpts({ nodeVersion: "16.20.0" }));
  assert.equal(byId(r, "node").status, "crit");
});

test("git missing → crit", () => {
  const r = runDoctor(
    greenOpts({
      exec: (cmd, args) => {
        if (cmd === "git" && args.includes("--version")) return { ok: false, missing: true };
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "git").status, "crit");
});

test("core.autocrlf=true → line-endings warn with fix remediation", () => {
  const r = runDoctor(
    greenOpts({
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: true, missing: false, code: 0, stdout: "true" };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  const le = byId(r, "line-endings");
  assert.equal(le.status, "warn");
  assert.match(le.remediation, /core\.autocrlf false/);
});

test("gh present but unauthenticated → warn + authed:false", () => {
  const r = runDoctor(
    greenOpts({
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "gh" && args[0] === "auth") return { ok: false, missing: false, code: 1, stderr: "not logged in" };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "gh").status, "warn");
  assert.equal(byId(r, "gh").authed, false);
});

test("both hosts unauthenticated → vcs-host warn", () => {
  const r = runDoctor(
    greenOpts({
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "gh" && args.includes("--version")) return { ok: false, missing: true };
        if (cmd === "az" && args.includes("--version")) return { ok: false, missing: true };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "vcs-host").status, "warn");
});

test("resolver not configured → info (USE-consumer case)", () => {
  const r = runDoctor(greenOpts({ isConfigured: () => false }));
  assert.equal(byId(r, "resolver").status, "info");
});

test("resolver error cells → warn naming the failing keys", () => {
  const r = runDoctor(
    greenOpts({
      resolveAll: () =>
        new Map([
          ["build.py", { kind: "path", value: "/ok" }],
          ["use-template.rs", { kind: "error", error: "not-found: /missing" }],
        ]),
    }),
  );
  const res = byId(r, "resolver");
  assert.equal(res.status, "warn");
  assert.match(res.detail, /use-template\.rs/);
});

test("formatReport renders every check line + a summary line", () => {
  const out = formatReport(runDoctor(greenOpts()));
  assert.match(out, /loom doctor/);
  assert.match(out, /resolver:/);
  assert.match(out, /ok ·/);
  assert.match(out, /Ready for \/onboard\./);
});

// ── ado-readiness check (W5-b) ───────────────────────────────────────────────
//
// All config-presence, never a live Graph probe. ADO-targeting is detected via
// roster.genesis.provider OR the az-only-authed inference; a non-ADO clone skips.

// readFile that returns a roster body for operators.roster.json and the green
// .gitattributes contract for every other path.
function rosterReadFile(genesis) {
  return (p) =>
    /operators\.roster\.json$/.test(String(p))
      ? JSON.stringify({ genesis })
      : "* text=auto\n*.sh eol=lf\n.session-notes.shared.md merge=coc-ledger\n";
}

test("ado-readiness: roster provider=azure-devops with org+project → ok (no shell-out)", () => {
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ provider: "azure-devops", repo_owner: "myorg", ado_project: "myproject" }),
    }),
  );
  const a = byId(r, "ado-readiness");
  assert.equal(a.status, "ok");
  assert.match(a.detail, /myorg\/myproject/);
});

test("ado-readiness: ADO-targeted, no roster org/project, az devops configured → ok", () => {
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ provider: "azure-devops" }), // provider but no org/project
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "az" && args[0] === "extension") return { ok: true, missing: false, code: 0, stdout: "azure-devops 1.0" };
        if (cmd === "az" && args[0] === "devops")
          return { ok: true, missing: false, code: 0, stdout: "organization = https://dev.azure.com/myorg\nproject = myproject\n" };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "ado-readiness").status, "ok");
});

test("ado-readiness: ADO-targeted, az devops extension absent → warn + add remediation", () => {
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ provider: "azure-devops" }),
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "az" && args[0] === "extension") return { ok: false, missing: true };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  const a = byId(r, "ado-readiness");
  assert.equal(a.status, "warn");
  assert.match(a.remediation, /az extension add --name azure-devops/);
});

test("ado-readiness: ADO-targeted, extension present but unconfigured → warn + configure remediation", () => {
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ provider: "azure-devops" }),
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "az" && args[0] === "extension") return { ok: true, missing: false, code: 0, stdout: "azure-devops 1.0" };
        if (cmd === "az" && args[0] === "devops") return { ok: true, missing: false, code: 0, stdout: "" }; // no defaults
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  const a = byId(r, "ado-readiness");
  assert.equal(a.status, "warn");
  assert.match(a.detail, /organization \+ project/);
  assert.match(a.remediation, /az devops configure --defaults/);
});

test("ado-readiness: GitHub-only clone (no roster, gh authed) → info skip", () => {
  // The green baseline is exactly this: gh + az both authed, no roster.
  // gh authed means the az-only inference does NOT fire → skip.
  const r = runDoctor(greenOpts());
  assert.equal(byId(r, "ado-readiness").status, "info");
});

test("ado-readiness: roster absent (readFile null) + az-only authed → inference fires (warn)", () => {
  // The truly-falsy roster branch: defaultReadFile returns null when the file is
  // absent, so `if (rosterRaw)` is skipped entirely — no authoritative signal,
  // Signal-2 inference legitimately applies.
  const r = runDoctor(
    greenOpts({
      readFile: (p) => (/operators\.roster\.json$/.test(String(p)) ? null : "* text=auto\n"),
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "gh" && args.includes("--version")) return { ok: false, missing: true }; // gh absent
        if (cmd === "az" && args[0] === "extension") return { ok: true, missing: false, code: 0, stdout: "azure-devops 1.0" };
        if (cmd === "az" && args[0] === "devops") return { ok: true, missing: false, code: 0, stdout: "" }; // unconfigured
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "ado-readiness").status, "warn");
});

test("ado-readiness: roster provider=github + az-only authed → inference SUPPRESSED (info skip)", () => {
  // The HIGH-finding case: a GitHub-genesis roster with gh auth lapsed but az authed.
  // The authoritative non-Azure roster MUST suppress the Signal-2 inference.
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ provider: "github", github_login: "alice" }),
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "gh" && args[0] === "auth") return { ok: false, missing: false, code: 1, stderr: "not logged in" };
        return { ok: true, missing: false, code: 0, stdout: "ok" }; // az authed
      },
    }),
  );
  assert.equal(byId(r, "ado-readiness").status, "info");
});

test("ado-readiness: roster present, provider ABSENT (github default) + az-only authed → info skip", () => {
  // Schema default: provider absent ⇒ github. Still authoritative → suppress inference.
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ repo_owner: "someorg" }), // no provider key
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "gh" && args[0] === "auth") return { ok: false, missing: false, code: 1, stderr: "not logged in" };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "ado-readiness").status, "info");
});

test("ado-readiness: ADO-targeted, `az devops configure --list` errors → warn names the error (not 'unconfigured')", () => {
  const r = runDoctor(
    greenOpts({
      readFile: rosterReadFile({ provider: "azure-devops" }),
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "az" && args[0] === "extension") return { ok: true, missing: false, code: 0, stdout: "azure-devops 1.0" };
        if (cmd === "az" && args[0] === "devops") return { ok: false, missing: false, code: 1, stderr: "extension broken" };
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  const a = byId(r, "ado-readiness");
  assert.equal(a.status, "warn");
  assert.match(a.detail, /errored/);
});

test("ado-readiness: az-only authed, gh missing, no roster → inferred ADO-targeted", () => {
  const r = runDoctor(
    greenOpts({
      readFile: () => "* text=auto\n", // unparseable roster body → JSON.parse-catch path (no authoritative signal)
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" };
        if (cmd === "gh" && args.includes("--version")) return { ok: false, missing: true }; // gh absent
        if (cmd === "az" && args[0] === "extension") return { ok: true, missing: false, code: 0, stdout: "azure-devops 1.0" };
        if (cmd === "az" && args[0] === "devops") return { ok: true, missing: false, code: 0, stdout: "" }; // unconfigured
        return { ok: true, missing: false, code: 0, stdout: "ok" }; // az version+account ok → az authed
      },
    }),
  );
  // Inference fired (az authed, gh not) → it evaluated config and found it missing.
  assert.equal(byId(r, "ado-readiness").status, "warn");
});

// ── merge-driver check ───────────────────────────────────────────────────────

test("merge-driver: .gitattributes uses coc-ledger but driver unregistered → warn", () => {
  const r = runDoctor(
    greenOpts({
      exec: (cmd, args) => {
        if (args.includes("--get")) return { ok: false, missing: false, code: 1, stdout: "" }; // nothing registered
        return { ok: true, missing: false, code: 0, stdout: "ok" };
      },
    }),
  );
  assert.equal(byId(r, "merge-driver").status, "warn");
});

test("merge-driver: no coc-ledger reference in .gitattributes → info", () => {
  const r = runDoctor(greenOpts({ readFile: () => "* text=auto\n" }));
  assert.equal(byId(r, "merge-driver").status, "info");
});

// ── W3-b runFix (bounded SAFE auto-repair) ───────────────────────────────────

// A recording exec/writeFile so a test can assert WHICH surfaces were touched.
function recordingFixOpts(result, over = {}) {
  const calls = { exec: [], writes: [], init: 0 };
  const opts = {
    exec: (cmd, args) => {
      calls.exec.push([cmd, ...args].join(" "));
      return { ok: true, missing: false, code: 0, stdout: "" };
    },
    writeFile: (p, c) => calls.writes.push({ path: p, content: c }),
    invokeInit: () => {
      calls.init++;
      return { ok: true, detail: "wrote loom-links.local.json" };
    },
    cocRolePath: "/tmp/test/.coc-role",
    ...over,
  };
  return { calls, fix: runFix(result, opts) };
}

// A result with each repairable finding in its actionable state.
function repairableResult() {
  return runDoctor(
    greenOpts({
      resolveRole: () => null, // role warn
      isConfigured: () => false, // resolver info (USE-consumer)
      exec: (cmd, args) => {
        if (args.includes("--get")) {
          if (args.includes("merge.coc-ledger.driver")) return { ok: false, code: 1, stdout: "" }; // unregistered → warn
          return { ok: true, code: 0, stdout: "true" }; // autocrlf=true → warn
        }
        return { ok: true, code: 0, stdout: "ok" };
      },
    }),
  );
}

test("runFix applies autocrlf=false + registers the merge driver", () => {
  const { calls, fix } = recordingFixOpts(repairableResult());
  assert.ok(calls.exec.some((c) => /config core\.autocrlf false/.test(c)));
  assert.ok(calls.exec.some((c) => /config merge\.coc-ledger\.driver/.test(c)));
  assert.ok(fix.applied.some((a) => /autocrlf=false/.test(a)));
  assert.ok(fix.applied.some((a) => /merge\.coc-ledger/.test(a)));
});

test("runFix seeds the resolver via invokeInit when resolver is absent", () => {
  const { calls } = recordingFixOpts(repairableResult());
  assert.equal(calls.init, 1);
});

test("runFix role: no --role → manual (NO silent guess, D2), no write", () => {
  const { calls, fix } = recordingFixOpts(repairableResult()); // role omitted
  assert.equal(calls.writes.length, 0);
  assert.ok(fix.manual.some((m) => /no silent guess/.test(m)));
});

test("runFix role: invalid --role → manual rejection, no write", () => {
  const { calls, fix } = recordingFixOpts(repairableResult(), { role: "boss" });
  assert.equal(calls.writes.length, 0);
  assert.ok(fix.manual.some((m) => /invalid/.test(m)));
});

test("runFix role: valid --role → writes .coc-role to the role path", () => {
  const { calls, fix } = recordingFixOpts(repairableResult(), { role: "use-consumer" });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].path, "/tmp/test/.coc-role");
  assert.equal(calls.writes[0].content, "use-consumer\n");
  assert.ok(fix.applied.some((a) => /\.coc-role = use-consumer/.test(a)));
});

test("runFix NEVER touches hook-mediated state (posture/coordination-log/roster)", () => {
  const { calls } = recordingFixOpts(repairableResult(), { role: "platform" });
  const allTargets = [...calls.exec, ...calls.writes.map((w) => w.path)].join(" | ");
  assert.doesNotMatch(allTargets, /posture\.json|coordination-log|operators\.roster|\.claude\/learning/);
  // The ONLY filesystem write target is the configured cocRolePath (a constant,
  // never interpolated from --role). Pin it as the sole write surface (LOW-3).
  for (const w of calls.writes) {
    assert.equal(w.path, "/tmp/test/.coc-role", "runFix must write ONLY to cocRolePath");
  }
});

test("runFix on a clean result → nothing to repair", () => {
  const fix = runFix(runDoctor(greenOpts()), {
    exec: () => ({ ok: true }),
    writeFile: () => assert.fail("clean result must not write"),
    invokeInit: () => assert.fail("clean result must not seed"),
  });
  assert.equal(fix.applied.length, 0);
  assert.match(formatFixReport(fix), /nothing to repair/);
});

// ── W3-c CLI helpers (parseFlags + exitCode gateability) ─────────────────────

test("parseFlags reads --json/--fix/--strict and --role (both forms)", () => {
  assert.deepEqual(parseFlags(["--json"]), { help: false, json: true, fix: false, strict: false, role: null });
  assert.equal(parseFlags(["--fix", "--role", "platform"]).role, "platform");
  assert.equal(parseFlags(["--fix", "--role=build"]).role, "build");
  assert.equal(parseFlags(["--strict"]).strict, true);
});

test("exitCode: CRIT gates non-zero only under --strict/--json; interactive stays 0", () => {
  const crit = { summary: { crit: 2 } };
  const clean = { summary: { crit: 0 } };
  assert.equal(exitCode(crit, { strict: true }), 1);
  assert.equal(exitCode(crit, { json: true }), 1);
  assert.equal(exitCode(crit, {}), 0); // interactive: a human report never trips set -e
  assert.equal(exitCode(clean, { strict: true }), 0);
});
