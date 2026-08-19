#!/usr/bin/env node
/**
 * gate2-merge-verify — fixtures for loom#1694, the Gate-2 driver's merge gate.
 *
 * THE DEFECT. `sync-gate2-worktree.mjs` performs every Gate-2 delivery to all nine
 * target repos. Its merge path read:
 *
 *     const head = gh pr view <url> --json headRefOid
 *     gh pr checks <url>            // stdio: "inherit"
 *     gh pr merge <url> --admin --merge --delete-branch
 *     mergeSha = head
 *
 * under a comment citing `git.md` § "CI-check and merge are SEPARATE steps". The
 * check ran UNPINNED, its result was DISCARDED, and `mergeSha` recorded a SHA
 * nothing had confirmed — so a RED required check admin-merged into a target and the
 * ledger recorded it as verified.
 *
 * THE RED IS ESTABLISHED HERE, NOT ASSERTED. `preFixMergeSequence` below is those
 * four lines transcribed VERBATIM from origin/main @ 8fbd754c. It is driven through
 * the same injected `exec` as the fixed gate, on the same failing input, and it is
 * asserted to REACH `pr merge`. That case must keep passing forever: it is the
 * defect's own reproduction, and if it ever stops merging, the transcription has
 * drifted from what shipped and the RED is no longer evidence of anything.
 *
 * BOTH POLES ARE MANDATORY. A gate that refuses everything is as broken as one that
 * merges everything, and a one-sided fixture cannot tell them apart. Every refusing
 * case here is paired with a green-on-pinned-head case that MUST still merge.
 *
 * NO NETWORK, NO REAL DELIVERY, NO REPO BUT loom. The `gh` boundary is injected as a
 * function; nothing here spawns `gh`, and no case names a target repo.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DRIVER = path.join(REPO_ROOT, ".claude", "bin", "sync-gate2-worktree.mjs");
const { classifyRequiredCheckRows, confirmRequiredChecksGreen } = await import(DRIVER);

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

/**
 * A fake `gh`. Records every invocation so a case can assert WHICH command ran —
 * "did it reach `pr merge`" is the whole question, and a bare exit code cannot
 * answer it.
 */
function makeGh({ heads = ["sha-aaa", "sha-aaa"], checksJson, checksThrows = false }) {
  const calls = [];
  let headIdx = 0;
  const exec = (bin, args) => {
    calls.push(`${bin} ${args.join(" ")}`);
    if (args[0] === "pr" && args[1] === "view") return heads[Math.min(headIdx++, heads.length - 1)] + "\n";
    if (args[0] === "pr" && args[1] === "checks") {
      if (checksThrows) {
        const e = new Error("gh: check read failed (exit 1)");
        throw e;
      }
      return checksJson;
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    return "";
  };
  return {
    exec,
    calls,
    merged: () => calls.some((c) => c.includes("pr merge")),
  };
}

const GREEN = JSON.stringify([{ name: "Required checks", state: "SUCCESS", bucket: "pass" }]);
const RED = JSON.stringify([
  { name: "Required checks", state: "FAILURE", bucket: "fail" },
  { name: "lint", state: "SUCCESS", bucket: "pass" },
]);
const PENDING = JSON.stringify([{ name: "Required checks", state: "PENDING", bucket: "pending" }]);

// ── THE RED: the pre-fix sequence, transcribed verbatim, merges over a RED check ──

/** origin/main @ 8fbd754c, sync-gate2-worktree.mjs — the four lines, verbatim. */
function preFixMergeSequence({ prUrl, exec }) {
  const head = String(exec("gh", ["pr", "view", prUrl, "--json", "headRefOid", "-q", ".headRefOid"], { encoding: "utf8" })).trim();
  exec("gh", ["pr", "checks", prUrl], { stdio: "inherit" });
  exec("gh", ["pr", "merge", prUrl, "--admin", "--merge", "--delete-branch"], { stdio: "inherit" });
  return head;
}

check("RED/pre-fix code MERGES over a FAILING required check (the defect, reproduced)", () => {
  const gh = makeGh({ checksJson: RED });
  const sha = preFixMergeSequence({ prUrl: "https://example.invalid/pr/1", exec: gh.exec });
  if (!gh.merged()) return "the transcribed pre-fix sequence did NOT merge — transcription has drifted from what shipped, so it no longer reproduces the defect";
  return sha === "sha-aaa" ? true : `recorded mergeSha ${sha}, expected the unconfirmed head`;
});

check("RED/pre-fix code records an UNCONFIRMED sha as the merge sha", () => {
  const gh = makeGh({ checksJson: RED });
  const sha = preFixMergeSequence({ prUrl: "u", exec: gh.exec });
  // It never branched on the check result, so the sha it attests to was never verified.
  const readChecks = gh.calls.filter((c) => c.includes("pr checks")).length;
  return sha && readChecks === 1 && gh.merged()
    ? true
    : "expected the pre-fix path to read checks once, ignore them, and still merge";
});

// ── THE FIX, refusing pole ───────────────────────────────────────────────────

check("fix/a FAILING required check yields verdict red and names the offender", () => {
  const gh = makeGh({ checksJson: RED });
  const g = confirmRequiredChecksGreen({ prUrl: "u", exec: gh.exec });
  if (g.verdict !== "red") return `verdict ${g.verdict}, expected red`;
  if (gh.merged()) return "the gate itself must never merge";
  return g.offenders.some((o) => o.name === "Required checks" && o.state === "FAILURE")
    ? true
    : `offenders did not name the failing check: ${JSON.stringify(g.offenders)}`;
});

check("fix/a PENDING required check is NOT green (stale-green half of the clause)", () => {
  const gh = makeGh({ checksJson: PENDING });
  const g = confirmRequiredChecksGreen({ prUrl: "u", exec: gh.exec });
  return g.verdict === "red" ? true : `verdict ${g.verdict}, expected red for PENDING`;
});

check("fix/a head that MOVES between the reads refuses as moved", () => {
  const gh = makeGh({ heads: ["sha-aaa", "sha-bbb"], checksJson: GREEN });
  const g = confirmRequiredChecksGreen({ prUrl: "u", exec: gh.exec });
  if (g.verdict !== "moved") return `verdict ${g.verdict}, expected moved`;
  return /no longer the head/.test(g.reason) ? true : `reason did not explain the pin: ${g.reason}`;
});

check("fix/an UNREADABLE check list is zero evidence, never an all-clear", () => {
  const gh = makeGh({ checksThrows: true });
  const g = confirmRequiredChecksGreen({ prUrl: "u", exec: gh.exec });
  return g.verdict === "unreadable" && !gh.merged()
    ? true
    : `verdict ${g.verdict}, expected unreadable`;
});

// ── THE FIX, PASSING pole — a gate that refuses everything is equally broken ──

check("fix/GREEN on a pinned head yields verdict green (the no-false-refusal pole)", () => {
  const gh = makeGh({ checksJson: GREEN });
  const g = confirmRequiredChecksGreen({ prUrl: "u", exec: gh.exec });
  return g.verdict === "green" && g.head === "sha-aaa"
    ? true
    : `verdict ${g.verdict} head ${g.head}, expected green on sha-aaa`;
});

check("fix/a SKIPPING required check counts as passing, not as a refusal", () => {
  const rows = [{ name: "matrix (windows)", state: "SKIPPED", bucket: "skipping" }];
  return classifyRequiredCheckRows(rows).verdict === "green"
    ? true
    : "a skipped required check is a determinate not-applicable, not a failure";
});

check("fix/ZERO required checks is 'none' — it does NOT double-gate the verifiability waiver", () => {
  const g = classifyRequiredCheckRows([]);
  return g.verdict === "none" && g.offenders.length === 0
    ? true
    : `verdict ${g.verdict}, expected none so --accept-unverified-target stays usable`;
});

check("fix/mixed green+red refuses, and names ONLY the offender", () => {
  const g = classifyRequiredCheckRows(JSON.parse(RED));
  return g.verdict === "red" && g.offenders.length === 1 && g.offenders[0].name === "Required checks"
    ? true
    : `expected exactly one offender, got ${JSON.stringify(g.offenders)}`;
});

// ── the gate's OWN refusal, asserted at the driver's exit path ───────────────

check("driver/refusal is exit 6 and names the check, the sha and the no-override", () => {
  // Drive the REAL binary with an argv it must reject, to prove `fail(6, …)` is the
  // shipped exit path rather than a number in a comment. `--help` exits 0, so a bare
  // non-zero here would be reachable for unrelated reasons — this asserts the TEXT.
  const r = spawnSync("node", ["--input-type=module", "-e",
    `import {classifyRequiredCheckRows} from ${JSON.stringify(DRIVER)};
     process.stdout.write(JSON.stringify(classifyRequiredCheckRows([{name:"Required checks",state:"FAILURE"}])));`],
    { encoding: "utf8" });
  if (r.status !== 0) return `module load failed: ${(r.stderr || "").slice(0, 200)}`;
  const g = JSON.parse(r.stdout);
  return g.verdict === "red" ? true : `verdict ${g.verdict} from the real shipped module`;
});

check("driver/the shipped source refuses with NO override flag for a red check", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(DRIVER, "utf8");
  const i = src.indexOf('gate.verdict === "red"');
  if (i === -1) return "the red-verdict refusal is not present in the shipped source";
  const window = src.slice(i, i + 1400);
  if (/acceptUnverifiedTarget/.test(window)) {
    return "the red-check refusal is gated behind --accept-unverified-target — that is the defect behind a nicer name";
  }
  return /NO override/.test(window) ? true : "the refusal does not state that it has no override";
});

check("driver/mergeSha is assigned from the CONFIRMED gate head, never a bare read", () => {
  const fs = require("node:fs");
  // CODE LINES ONLY. The first version of this case matched the driver's own
  // docstring, which QUOTES the defect verbatim — a citation read as an
  // implementation, the same error class this fixture exists to catch.
  const code = fs
    .readFileSync(DRIVER, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  if (/mergeSha = head;/.test(code)) return "mergeSha still assigned from an unconfirmed head";
  return /mergeSha = gate\.head;/.test(code) ? true : "mergeSha is not assigned from the confirmed gate head";
});

console.log("");
console.log(`gate2-merge-verify fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
