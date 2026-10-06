#!/usr/bin/env node
/**
 * burndown-trace — fixtures for `burndown-trace-write-guard.js`, the write-time
 * enforcement surface of the id → tracker-row → context-artifact chain.
 *
 * BIPOLAR PER ARM, which is the point. Each arm has a pole that MUST fire and a
 * pole that MUST stay silent:
 *
 *   arm (1) structural  → `block` on a broken chain   | intact chain → SILENT
 *   arm (2) semantic    → `advisory` on a moved anchor| unchanged anchors → SILENT
 *   scoping: no manifest / no tracker / non-chain surface → SILENT on BOTH arms
 *   fail-open: no generator / unparseable manifest / a PRE-EXISTING exit-2
 *              refusal carrying no LINK lines → never `block`
 *
 * A guard shown only to FIRE proves it can say "no". The silent poles are what
 * prove it can say anything else. And because this guard RELAYS a verdict rather
 * than computing one, every firing pole asserts the FAILURE IDENTITY — which id,
 * which LINK-n leg, which arm, which severity — not a bare exit code. A bare exit
 * code cannot tell a LINK-1 finding from a LINK-3 one, and a suite that only reads
 * exit codes would stay green if the guard reported the wrong leg for every write.
 *
 * The hook is invoked as a REAL subprocess over REAL stdin payloads against REAL
 * temporary git repositories running a REAL copy of the generator. Nothing is
 * mocked, so a case cannot pass against a hook the harness would not actually run.
 *
 * NEGATIVE CONTROL, run at authoring time and recorded rather than assumed
 * (`instrument-discipline.md` MUST-2): this suite was run against two mutants —
 * a guard neutered to always pass through, and one forced to always block. The
 * measured counts are in the report for this change. Every firing pole reds under
 * the first; every silent pole reds under the second. Re-run with
 * `BURNDOWN_TRACE_FIXTURE_MUTANT=passthrough|block` to reproduce.
 */
import "../_lib/no-ambient-git.cjs";
import { copyStaticImportClosure } from "../_lib/static-import-closure.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const HOOKS = path.join(REPO_ROOT, ".claude", "hooks");
const GUARD = path.join(HOOKS, "burndown-trace-write-guard.js");
const GENERATOR = path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");
const GIT_ENV_LIB = path.join(HOOKS, "lib", "git-subprocess-env.js");

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

// ── fixture repos ──────────────────────────────────────────────────────────

const REGISTER = {
  _note: "trace fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "RN",
  items: [
    { id: "R1-alpha-item", page: "Alpha", status: "Signed off" },
    { id: "R2-alpha-item", page: "Alpha", status: "In progress" },
  ],
};

function ledger(rows) {
  return [
    "# Forest Ledger",
    "",
    "| ID | item | value_anchor |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.id} | ${r.item || "thing"} | ${r.anchor} |`),
    "",
  ].join("\n");
}

const INTACT_ROWS = [
  { id: "R1-alpha-item", anchor: "journal/0001-a.md" },
  { id: "R2-alpha-item", anchor: "journal/0001-a.md" },
];
const INTACT_JOURNALS = { "journal/0001-a.md": "The ruling behind R1-alpha-item and R2-alpha-item lives here.\n" };

/**
 * @param rows        ledger rows; `null` ⇒ do not declare a tracker at all
 * @param journals    extra tracked files, path → body
 * @param withManifest false ⇒ a repo that has no burndown whatsoever
 * @param anchorRoots  declared durable roots
 */
function mkRepo({ rows = INTACT_ROWS, journals = INTACT_JOURNALS, withManifest = true, anchorRoots = ["journal/", "workspaces/"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-trace-"));
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude", "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "journal"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "burndown", "register.json"), JSON.stringify(REGISTER, null, 2));
  fs.writeFileSync(path.join(dir, "src", "thing.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "REGISTER.md"), "# R\n");

  if (withManifest) {
    const manifest = {
      _schema: "burndown-manifest/v1",
      target: "REGISTER.md",
      pages: ["Alpha"],
      sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
    };
    if (rows !== null) {
      manifest.tracker = { path: ".session-notes.shared.md", kind: "forest-ledger", anchor_roots: anchorRoots };
    }
    fs.writeFileSync(path.join(dir, "burndown-manifest.json"), JSON.stringify(manifest, null, 2));
  }
  // The ledger file exists either way — a repo can carry one without DECLARING it,
  // which is exactly the "no tracker declared" pole.
  fs.writeFileSync(path.join(dir, ".session-notes.shared.md"), ledger(rows === null ? INTACT_ROWS : rows));

  for (const [rel, body] of Object.entries(journals)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  // The generator + its STATIC relative-import closure, DERIVED from the tree
  // (fcecaa28f added `./lib/entry-point.mjs`; a hand-kept copy goes stale the
  // moment the graph moves). Two small files today — the 3.9 MB hooks lib tree
  // stays out, as the note below explains for the one PATH-resolved lib.
  copyStaticImportClosure({ fromRoot: REPO_ROOT, toRoot: dir, entries: [GENERATOR] });
  // The generator resolves its git envelope at `<bin>/../hooks/lib/`, and REFUSES
  // (typed, never a silent drop to the ambient environment) when it is absent —
  // an inherited GIT_DIR outranks repository discovery, so an un-enveloped query
  // is answered by whatever repo the environment names. A fixture repo that
  // carries the generator without it therefore answers UNRUNNABLE to every case
  // here, which reads as 23 failures that have nothing to do with this guard.
  // Only this one file is copied, not the 3.9 MB lib tree: it is the sole
  // dependency the forest-ledger path reaches, and copying the tree into every
  // fixture repo in this suite would cost ~175 MB per run.
  fs.mkdirSync(path.join(dir, ".claude", "hooks", "lib"), { recursive: true });
  fs.copyFileSync(GIT_ENV_LIB, path.join(dir, ".claude", "hooks", "lib", "git-subprocess-env.js"));
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "h@x.invalid"],
    ["config", "user.name", "h"],
    // A FIXTURE MUST DEPEND ON NOTHING OUTSIDE ITSELF. `git init` INHERITS global
    // config, and this machine sets `commit.gpgsign = true` with
    // `gpg.format = openpgp` globally — verified by init-ing a bare temp repo and
    // reading the inherited value back, not assumed. Every fixture commit would
    // then spawn gpg, and under the concurrent runs this suite's own mutation
    // harness performs, gpg-agent contention makes `git commit` exit 128 at
    // random. That surfaces here as a THROW out of `execFileSync` inside
    // `mkRepo`, which `check()` reports as a FAIL — indistinguishable, inside a
    // mutant run, from "the mutation killed this case". A kill count measured
    // without this pin is taken on an instrument that can fail for a reason
    // unrelated to the mutation, so it does not mean what it appears to.
    // Established pattern, not a new one: ~7 sibling runners already pin it
    // (wrapup-verify, sync-preflight-local-mods, worktree-stale-base-ref,
    // clean-instantiate, burndown-integrity, burndown-quote-hooks, …).
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fx"],
  ]) {
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

// ── running the guard ──────────────────────────────────────────────────────

/**
 * Optionally swap in a MUTANT guard, so the negative control is reproducible by
 * anyone reading this file rather than being a claim in a commit message.
 */
function guardFor(dir) {
  const mutant = process.env.BURNDOWN_TRACE_FIXTURE_MUTANT;
  if (!mutant) return GUARD;
  const p = path.join(dir, "mutant-guard.js");
  if (mutant === "passthrough") {
    fs.writeFileSync(p, 'process.stdout.write(JSON.stringify({continue:true})+"\\n");\n');
  } else if (mutant === "block") {
    fs.writeFileSync(
      p,
      'process.stdout.write(JSON.stringify({continue:false,hookSpecificOutput:{hookEventName:"PostToolUse",' +
        'permissionDecision:"deny",permissionDecisionReason:"STRUCTURAL ARM (burndown-traceability/MUST-1) LINK-1 R2-alpha-item"}})+"\\n");\n' +
        "process.exit(2);\n",
    );
  } else {
    throw new Error(`unknown BURNDOWN_TRACE_FIXTURE_MUTANT '${mutant}'`);
  }
  return p;
}

function runHook(dir, payload) {
  const r = spawnSync("node", [guardFor(dir)], {
    cwd: dir,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    timeout: 20000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** Write the file, then hand the guard the payload the host would hand it. */
function writePayload(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: abs } };
}

function parsed(res) {
  const line = res.out.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The text the AGENT actually receives — never a field the host drops. */
function delivered(res) {
  const j = parsed(res);
  const hso = (j && j.hookSpecificOutput) || {};
  return [hso.permissionDecisionReason || "", hso.additionalContext || "", res.err || ""].join("\n");
}

/** "block" | "advisory" | "context" | "silent" — the guard's observable verdict. */
function verdictOf(res) {
  const j = parsed(res);
  if (!j) return "silent";
  if (res.code === 2 && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === "deny") return "block";
  const ctx = (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || "";
  if (!ctx) return "silent";
  return /SEMANTIC ARM/.test(ctx) ? "advisory" : "context";
}

function expectBlock(res, { id, leg }) {
  if (verdictOf(res) !== "block") return `expected a BLOCK, got ${verdictOf(res)}: ${delivered(res).slice(0, 300)}`;
  if (res.code !== 2) return `block must exit 2, got ${res.code}`;
  const d = delivered(res);
  if (!/STRUCTURAL ARM \(burndown-traceability\/MUST-1\)/.test(d)) return "the payload does not identify the STRUCTURAL arm / MUST-1";
  if (!new RegExp(`${leg}\\s+${id}\\b`).test(d)) return `the payload does not name '${leg} ${id}': ${d.slice(0, 400)}`;
  if (/SEMANTIC ARM/.test(d)) return "a block payload carried semantic-arm content — the arms are not separate";
  return true;
}

function expectSilent(res) {
  if (res.code !== 0) return `expected exit 0, got ${res.code}`;
  const v = verdictOf(res);
  return v === "silent" ? true : `expected SILENT, got ${v}: ${delivered(res).slice(0, 300)}`;
}

/** Anything that is not the blocking arm. Used for the fail-open poles. */
function expectNotBlock(res) {
  if (res.code !== 0) return `expected exit 0 (fail open), got ${res.code}`;
  return verdictOf(res) !== "block" ? true : `BLOCKED on an unknown: ${delivered(res).slice(0, 300)}`;
}

// ── arm (1) STRUCTURAL: the firing poles, one per leg ──────────────────────

check("arm1/LINK-1 — a dangling item id BLOCKS, and the payload names the id and the leg", () => {
  // R2-alpha-item is a burndown item with NO ledger row: the status word has nowhere to go.
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
  return expectBlock(res, { id: "R2-alpha-item", leg: "LINK-1" });
});

check("arm1/LINK-2 — a free-prose value_anchor BLOCKS and names LINK-2", () => {
  const d = mkRepo({
    rows: [
      { id: "R1-alpha-item", anchor: "journal/0001-a.md" },
      { id: "R2-alpha-item", anchor: "decided in the standup" },
    ],
  });
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
  return expectBlock(res, { id: "R2-alpha-item", leg: "LINK-2" });
});

check("arm1/LINK-2 — an anchor OUTSIDE anchor_roots (.session-notes.d/) BLOCKS and names LINK-2", () => {
  // The rule's named case: a MEMORY surface /reconcile-notes may prune is a link
  // with an expiry date. This pole is distinct from free prose — the cell here IS
  // a resolvable, tracked, id-carrying path; only its ROOT disqualifies it.
  const d = mkRepo({
    rows: [
      { id: "R1-alpha-item", anchor: "journal/0001-a.md" },
      { id: "R2-alpha-item", anchor: ".session-notes.d/someoperator.md" },
    ],
    journals: { ...INTACT_JOURNALS, ".session-notes.d/someoperator.md": "R2-alpha-item was ruled on here.\n" },
  });
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
  if (expectBlock(res, { id: "R2-alpha-item", leg: "LINK-2" }) !== true) return expectBlock(res, { id: "R2-alpha-item", leg: "LINK-2" });
  return /outside every declared durable root/.test(delivered(res))
    ? true
    : "blocked for the wrong reason — this pole must fail on the ROOT, not on resolvability";
});

check("arm1/LINK-3 — a resolvable anchor with NO back-reference BLOCKS and names LINK-3", () => {
  // The anchor exists, is tracked, and is under a durable root. The ONLY defect is
  // that `git grep -F R2-alpha-item` never finds it. If the guard reported LINK-2 here it
  // would be relaying the wrong leg while still exiting 2, which is why every
  // firing pole asserts the leg and not the exit code.
  const d = mkRepo({
    rows: [
      { id: "R1-alpha-item", anchor: "journal/0001-a.md" },
      { id: "R2-alpha-item", anchor: "journal/0002-b.md" },
    ],
    journals: { "journal/0001-a.md": "The ruling behind R1-alpha-item.\n", "journal/0002-b.md": "An unrelated ruling.\n" },
  });
  const res = runHook(d, writePayload(d, "journal/0003-new.md", "some new context\n"));
  return expectBlock(res, { id: "R2-alpha-item", leg: "LINK-3" });
});

check("arm1/LINK-2 — an UNTRACKED anchor file BLOCKS (a link only for whoever wrote it)", () => {
  const d = mkRepo({
    rows: [
      { id: "R1-alpha-item", anchor: "journal/0001-a.md" },
      { id: "R2-alpha-item", anchor: "journal/0009-untracked.md" },
    ],
  });
  fs.writeFileSync(path.join(d, "journal", "0009-untracked.md"), "R2-alpha-item ruling, never staged.\n");
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  return expectBlock(res, { id: "R2-alpha-item", leg: "LINK-2" });
});

check("arm1/a MULTI-finding chain names EVERY leg it found, not just the first", () => {
  const d = mkRepo({
    rows: [{ id: "R2-alpha-item", anchor: "journal/0002-b.md" }],
    journals: { "journal/0002-b.md": "unrelated\n" },
  });
  const res = runHook(d, writePayload(d, "journal/0003-new.md", "context\n"));
  if (verdictOf(res) !== "block") return `expected a BLOCK, got ${verdictOf(res)}`;
  const dtx = delivered(res);
  const legs = [/LINK-1\s+R1-alpha-item\b/.test(dtx), /LINK-3\s+R2-alpha-item\b/.test(dtx)];
  return legs.every(Boolean) ? true : `expected both LINK-1 R1-alpha-item and LINK-3 R2-alpha-item: ${dtx.slice(0, 400)}`;
});

// ── arm (1) STRUCTURAL: the silent poles ───────────────────────────────────

check("arm1/SILENT on an INTACT chain — the pole that proves it can say something other than no", () => {
  const d = mkRepo();
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
  return expectSilent(res);
});

check("arm1/SILENT when the manifest declares NO tracker (absent ≠ broken)", () => {
  // The ledger FILE is present and the write lands on a chain surface. What is
  // missing is the DECLARATION, and the generator answers exit 0 "declares NO
  // tracker". That is an absent result, and this guard does not convert it to one.
  const d = mkRepo({ rows: null });
  const res = runHook(d, writePayload(d, "burndown/notes.md", "notes\n"));
  return expectSilent(res);
});

check("arm1/SILENT in a repo with NO burndown-manifest.json at all", () => {
  const d = mkRepo({ withManifest: false });
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  return expectSilent(res);
});

check("arm1/SILENT on a NON-chain surface while the chain is genuinely BROKEN", () => {
  // The scope predicate, not the finding. The same tree BLOCKS on a journal write
  // (asserted next door), so a pass here cannot be the chain merely being intact.
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  const control = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (verdictOf(control) !== "block") return "the control write did not block — this tree is not broken, so the pole proves nothing";
  const res = runHook(d, writePayload(d, "src/thing.ts", "export const y = 2;\n"));
  return expectSilent(res);
});

check("arm1/SILENT on a file OUTSIDE the project even when it is named like a chain surface", () => {
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bd-outside-"));
  fs.mkdirSync(path.join(outside, "journal"), { recursive: true });
  const abs = path.join(outside, "journal", "0001-a.md");
  fs.writeFileSync(abs, "not ours\n");
  const res = runHook(d, { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: abs } });
  return expectSilent(res);
});

// ── the teeth, pinned ──────────────────────────────────────────────────────

check("teeth/a structural finding exits 2 with a deny decision and does NOT halt the agent", () => {
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  const j = parsed(res);
  if (!j) return "no JSON emitted";
  if (res.code !== 2) return `expected exit 2, got ${res.code}`;
  if (j.continue === false) return `continue:false ends the agent's turn; a block must not halt, got ${JSON.stringify(j).slice(0, 200)}`;
  const hso = j.hookSpecificOutput || {};
  return hso.permissionDecision === "deny" && typeof hso.permissionDecisionReason === "string"
    ? true
    : `expected a deny decision with a reason, got ${JSON.stringify(hso).slice(0, 200)}`;
});

check("teeth/the ARM IDENTITY reaches the agent through `why`, since rule_id is NOT a delivery channel", () => {
  // MEASURED, not assumed: `instructAndWait`'s signature does not read `rule_id`,
  // so the literal string only reaches the reader because the guard writes it into
  // the body. A guard that relied on the parameter would deliver an unattributed
  // finding while every surface reported success.
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  const j = parsed(res);
  if (j && Object.prototype.hasOwnProperty.call(j, "rule_id")) {
    return "rule_id surfaced as a top-level field — this suite's premise is stale, re-check the contract";
  }
  return /burndown-traceability\/MUST-1/.test(delivered(res))
    ? true
    : `the rule id never reached the agent: ${delivered(res).slice(0, 300)}`;
});

// ── arm (2) SEMANTIC: advisory only ────────────────────────────────────────

check("arm2/a CHANGED value_anchor emits an ADVISORY — continue:true, exit 0, never a block", () => {
  const d = mkRepo();
  const res = runHook(
    d,
    writePayload(
      d,
      ".session-notes.shared.md",
      ledger([
        { id: "R1-alpha-item", anchor: "journal/0001-a.md" },
        { id: "R2-alpha-item", anchor: "journal/0002-b.md" },
      ]),
    ),
  );
  if (verdictOf(res) !== "advisory") return `expected an ADVISORY, got ${verdictOf(res)}: ${delivered(res).slice(0, 300)}`;
  if (res.code !== 0) return `an advisory must exit 0, got ${res.code}`;
  const j = parsed(res);
  if (j.continue !== true) return `expected continue:true, got ${JSON.stringify(j).slice(0, 200)}`;
  const dtx = delivered(res);
  if (!/SEMANTIC ARM \(burndown-traceability\/MUST-2, advisory/.test(dtx)) return "the payload does not identify the SEMANTIC arm / MUST-2";
  if (/STRUCTURAL ARM/.test(dtx)) return "an advisory payload carried structural-arm content — the arms are not separate";
  return /changed\s+R2-alpha-item: journal\/0001-a\.md → journal\/0002-b\.md/.test(dtx)
    ? true
    : `the advisory does not name the moved anchor: ${dtx.slice(0, 400)}`;
});

check("arm2/an ADDED ledger row with a real anchor emits an ADVISORY naming it as added", () => {
  const d = mkRepo();
  const res = runHook(
    d,
    writePayload(
      d,
      ".session-notes.shared.md",
      ledger([...INTACT_ROWS, { id: "R7", anchor: "journal/0001-a.md" }]),
    ),
  );
  if (verdictOf(res) !== "advisory") return `expected an ADVISORY, got ${verdictOf(res)}`;
  return /added\s+R7 → journal\/0001-a\.md/.test(delivered(res)) ? true : `not named as added: ${delivered(res).slice(0, 300)}`;
});

check("arm2/the advisory STATES the link status it observed rather than implying clean", () => {
  // The measured reachability fact this guard's header records: editing the
  // tracker dirties it, so the generator refuses on the committed-and-unmodified
  // gate before it reaches leg 1. The honest status is UNKNOWN, and the advisory
  // must SAY so — an advisory that read as "the link resolves" would be asserting
  // a check that did not run.
  const d = mkRepo();
  const res = runHook(
    d,
    writePayload(d, ".session-notes.shared.md", ledger([INTACT_ROWS[0], { id: "R2-alpha-item", anchor: "journal/0002-b.md" }])),
  );
  const dtx = delivered(res);
  if (!/LINK STATUS: UNKNOWN/.test(dtx)) return `no link status stated: ${dtx.slice(0, 300)}`;
  return /NOT a clean result/.test(dtx) ? true : "the UNKNOWN did not say it is not clean";
});

check("arm2/SILENT when the tracker is rewritten with the SAME anchors (no-false-positive pole)", () => {
  const d = mkRepo();
  const res = runHook(d, writePayload(d, ".session-notes.shared.md", ledger(INTACT_ROWS)));
  return expectSilent(res);
});

check("arm2/SILENT on a TYPOGRAPHY-only anchor edit — backticks are not a new ruling", () => {
  // `journal/x.md` and journal/x.md are the same pointer. A differ keyed on raw
  // cell text would fire here and train people to stop rendering the table.
  const d = mkRepo();
  const res = runHook(
    d,
    writePayload(
      d,
      ".session-notes.shared.md",
      ledger([
        { id: "R1-alpha-item", anchor: "`journal/0001-a.md`" },
        { id: "R2-alpha-item", anchor: "**journal/0001-a.md**" },
      ]),
    ),
  );
  return expectSilent(res);
});

check("arm2/SILENT when a NEW row's anchor is decoration rather than a pointer", () => {
  // Nothing to adjudicate: an empty cell asserts no ruling. The STRUCTURAL arm
  // owns that case once the id becomes a burndown item.
  const d = mkRepo();
  const res = runHook(d, writePayload(d, ".session-notes.shared.md", ledger([...INTACT_ROWS, { id: "R8", anchor: "TBD" }])));
  return expectSilent(res);
});

check("arm2/SILENT on a NON-tracker chain surface that happens to contain a ledger table", () => {
  // The semantic arm reads value_anchor cells only from the DECLARED tracker.
  // A copy of the table in a journal entry is not the ledger and moving a cell
  // there changes no link.
  const d = mkRepo();
  const res = runHook(
    d,
    writePayload(d, "journal/0004-copy.md", ledger([{ id: "R1-alpha-item", anchor: "journal/0002-b.md" }])),
  );
  return expectSilent(res);
});

check("arm2/a tracker write over a BROKEN committed chain still yields UNKNOWN, never a block", () => {
  // NAMED FOR WHAT IT ASSERTS, not for what it was reached for. The two arms
  // firing on ONE write is UNREACHABLE by construction: the structural arm needs
  // LINK lines, which need a clean tracker, and the semantic arm needs an anchor
  // change, which makes the tracker dirty. So "precedence" cannot be exercised.
  // What CAN be exercised, and is the load-bearing half, is that a dirty tracker
  // over a genuinely broken committed chain does NOT block — the guard must not
  // read a committed-and-unmodified refusal as a link finding.
  const d = mkRepo();
  // Break LINK-3 for R2-alpha-item in the COMMITTED tree, then move R2-alpha-item's anchor in the write.
  fs.writeFileSync(path.join(d, "journal", "0001-a.md"), "The ruling behind R1-alpha-item only.\n");
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "drop R2-alpha-item backref"], { cwd: d });
  // Control: the same tree DOES block on a non-tracker write, so a pass below is
  // the dirty-tracker path and not an accidentally-intact chain.
  const control = runHook(d, writePayload(d, "journal/0003-new.md", "context\n"));
  if (expectBlock(control, { id: "R2-alpha-item", leg: "LINK-3" }) !== true) {
    return `the control did not block on LINK-3 R2-alpha-item, so this pole proves nothing: ${delivered(control).slice(0, 300)}`;
  }
  const res = runHook(
    d,
    writePayload(d, ".session-notes.shared.md", ledger([INTACT_ROWS[0], { id: "R2-alpha-item", anchor: "journal/0002-b.md" }])),
  );
  if (verdictOf(res) === "block") return "a dirty-tracker write BLOCKED — a pre-existing refusal was read as a link finding";
  return /LINK STATUS: UNKNOWN/.test(delivered(res)) ? true : `expected an UNKNOWN status: ${delivered(res).slice(0, 300)}`;
});

// ── fail-open: could-not-check must never render as checked-clean ──────────

check("failopen/a PRE-EXISTING exit-2 refusal with NO LINK lines does NOT block", () => {
  // A declared source mid-edit — the ORDINARY state while someone edits the
  // register. The generator exits 2, but for the committed-and-unmodified gate,
  // not for a leg. Reading that as a link finding would block every write in a
  // repo whose register is open in an editor.
  const d = mkRepo();
  fs.writeFileSync(path.join(d, "burndown", "register.json"), JSON.stringify({ ...REGISTER, _note: "mid-edit" }, null, 2));
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  return expectNotBlock(res);
});

check("failopen/that same refusal is SURFACED as UNKNOWN, not swallowed into silence", () => {
  // The whole point: "could not check" and "checked, clean" are opposite facts.
  // The INTACT pole above is silent; this one must not be.
  const d = mkRepo();
  fs.writeFileSync(path.join(d, "burndown", "register.json"), JSON.stringify({ ...REGISTER, _note: "mid-edit" }, null, 2));
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  const dtx = delivered(res);
  if (verdictOf(res) === "silent") return "an unchecked chain rendered exactly like a clean one";
  if (!/LINK STATUS: UNKNOWN/.test(dtx)) return `no UNKNOWN status surfaced: ${dtx.slice(0, 300)}`;
  return /uncommitted modifications/.test(dtx)
    ? true
    : `the surfaced reason does not quote the generator's refusal: ${dtx.slice(0, 300)}`;
});

check("failopen/a SELF-INFLICTED unknown is NOT re-announced — the tautology pole", () => {
  // The refusal names the very file this write touched ("the tracker you are
  // editing has uncommitted modifications"). That is a restatement of the write,
  // not information, and emitting it on every tracker edit is how an advisory
  // channel gets ignored. Paired with the case above, which fires on an unknown
  // the write did NOT cause — the two poles together are what make the
  // suppression a scope decision rather than a swallow.
  const d = mkRepo();
  const res = runHook(d, writePayload(d, ".session-notes.shared.md", ledger(INTACT_ROWS)));
  return expectSilent(res);
});

check("failopen/the SAME tracker write DOES surface an unknown it did not cause", () => {
  // Lever: which file is dirty. Same repo, same write, same bytes — only the
  // pre-existing dirt differs. If this pole and the one above both passed for a
  // reason other than the self-inflicted test, they could not disagree.
  const d = mkRepo();
  fs.writeFileSync(path.join(d, "burndown", "register.json"), JSON.stringify({ ...REGISTER, _note: "mid-edit" }, null, 2));
  const res = runHook(d, writePayload(d, ".session-notes.shared.md", ledger(INTACT_ROWS)));
  if (verdictOf(res) === "silent") return "an unknown caused by ANOTHER file was suppressed as self-inflicted";
  return /register\.json/.test(delivered(res)) ? true : `the surfaced reason names the wrong file: ${delivered(res).slice(0, 300)}`;
});

check("failopen/an ABSENT generator is fully SILENT — a repo cannot be nagged about a tool it lacks", () => {
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  fs.rmSync(path.join(d, ".claude", "bin", "burndown-build.mjs"));
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  return expectSilent(res);
});

check("failopen/an UNPARSEABLE manifest is fully SILENT — scope is uncomputable", () => {
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
  fs.writeFileSync(path.join(d, "burndown-manifest.json"), "{ not json");
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  return expectSilent(res);
});

check("failopen/a DUPLICATE ledger row does not block and does not fabricate an anchor diff", () => {
  // The generator refuses on a duplicate id; the semantic differ declines rather
  // than picking one of two rows and naming a change nobody made.
  const d = mkRepo();
  const res = runHook(
    d,
    writePayload(d, ".session-notes.shared.md", ledger([...INTACT_ROWS, { id: "R2-alpha-item", anchor: "journal/0002-b.md" }])),
  );
  if (verdictOf(res) === "block") return "blocked on a duplicate row";
  return !/SEMANTIC ARM/.test(delivered(res)) ? true : "fabricated an anchor diff from an ambiguous table";
});

for (const [label, payload] of [
  ["malformed stdin", "{not json"],
  ["empty stdin", ""],
  ["a payload with no file_path", JSON.stringify({ hook_event_name: "PostToolUse", tool_input: {} })],
]) {
  check(`failopen/${label} passes through at exit 0 with no finding`, () => {
    const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
    const res = runHook(d, payload);
    return expectSilent(res);
  });
}

check("failopen/an unreadable written file does not block", () => {
  const d = mkRepo();
  const res = runHook(d, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(d, ".session-notes.shared.md.missing") },
  });
  return expectNotBlock(res);
});

// ── ledger integrity: a DETECTED forgery is not an UNKNOWN ─────────────────
//
// The signed-event-log gate does not speak in `LINK-n`. Its findings render as
// `  line 4: [bad-signature] …`, so before this arm existed every one of them —
// a signature that does not verify, an append onto a CLOSED generation, a fork —
// fell through to `unknown` and passed through as advisory, rendering a detected
// forgery identically to a source being mid-edit.
//
// WHY THESE POLES DRIVE THE GENERATOR'S REFUSAL THROUGH A STUB, stated rather
// than slipped in. Every other pole in this file runs the REAL generator, and
// that is the right default. It cannot be the default here: producing a genuine
// `[bad-signature]` needs a declared event-log tracker, a roster, real signing
// keys, and a record forged after signing — a fixture that would exercise
// `signed-log.js` (which has its own suite, `burndown-log-verification/`) rather
// than the thing under test, which is this guard's CLASSIFICATION of a refusal
// it did not compute. The guard is a RELAY; what these poles must pin is which
// rung it relays each refusal onto.
//
// The stub is therefore held to the generator's OWN rendering, and the shape is
// PINNED against `burndown-build.mjs` by the last check in this section — so a
// generator that changes its refusal format reds here instead of silently
// leaving the stub testing a shape nothing emits any more.
const REFUSAL_PREAMBLE = "burndown-build: REFUSING —";

/** Replace the fixture repo's generator with one that emits a fixed refusal. */
function stubRefusal(dir, stderrText, code = 2) {
  fs.writeFileSync(
    path.join(dir, ".claude", "bin", "burndown-build.mjs"),
    `process.stderr.write(${JSON.stringify(stderrText)});\nprocess.exit(${code});\n`,
  );
}

/** The generator's own line shape: `burndown-build.mjs:1392|1415|1426`. */
function findingLine(n, kind, why) {
  return `  line ${n}: [${kind}] ${why}`;
}

function ledgerRepo(stderrText, code = 2) {
  const d = mkRepo();
  stubRefusal(d, stderrText, code);
  return d;
}

/** Every integrity kind blocks, and the payload names the kind it blocked on. */
for (const [kind, why] of [
  ["bad-signature", "record 'rec_x' by 'someoperator@example.com' carries a signature that does NOT verify over its own bytes"],
  ["closed-generation-append", "record appends to generation 'burndown-event/v1', which the manifest CLOSED"],
  ["fork", "FORK: 'op' has two records at seq 4 with different content. One position, two histories."],
  ["chain-break", "'op' declares prev_hash \"abc\" but this emitter's previous record hashes to \"def\""],
  // Included on a reachability argument rather than a demonstration — see the
  // note beside `INTEGRITY_KINDS` in the guard. The measured middle-delete case
  // raises this ALONGSIDE chain-break, so this pole is what pins the disposition
  // for a refusal where it arrives on its own.
  ["seq-gap", "'op' jumped to seq 3; the previous record for this emitter was seq 1. A gap is a REMOVED record."],
  ["unattributed", "record carries no verified_id"],
  ["missing-seq", "seq is null; expected an integer ≥ 1"],
  ["unhashable", "record could not be canonically hashed"],
  ["unparseable", "Unexpected token } in JSON at position 12"],
  ["unsigned-or-unverifiable-record", "record carries no signature block"],
  ["no-signer-fingerprint", "the roster entry for 'op' declares no fingerprint"],
  ["no-records", "the log declares a suite but carries no records to verify"],
  ["unclassifiable", "record could not be classified against any declared generation"],
]) {
  check(`ledger/[${kind}] is a DETECTED integrity finding — it BLOCKS, it is not an UNKNOWN`, () => {
    const d = ledgerRepo(`${REFUSAL_PREAMBLE} event log '.session-notes.shared.md':\n${findingLine(4, kind, why)}\n`);
    const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
    if (verdictOf(res) !== "block") {
      return `expected a BLOCK, got ${verdictOf(res)}: ${delivered(res).slice(0, 300)}`;
    }
    if (res.code !== 2) return `a block must exit 2, got ${res.code}`;
    const dtx = delivered(res);
    if (!/STRUCTURAL ARM \(burndown-traceability\/MUST-1\)/.test(dtx)) {
      return "the payload does not identify the STRUCTURAL arm / MUST-1";
    }
    if (/LINK STATUS: UNKNOWN/.test(dtx)) return "a detected forgery was reported as an UNKNOWN chain status";
    // The KIND, not just the exit code. A guard that blocked while naming the
    // wrong finding would still exit 2, and the operator would chase the wrong
    // record — the same reason every LINK pole above asserts its leg.
    return dtx.includes(`[${kind}]`) ? true : `the payload does not name '[${kind}]': ${dtx.slice(0, 400)}`;
  });
}

/** The INDETERMINATE kinds: the verifier could not reach a verdict. */
for (const [kind, why] of [
  ["verification-unavailable", "the key resolver threw for 'op': roster unreadable"],
  ["unrostered-signer", "'op' is not on the roster, so no key can be resolved"],
  ["undeclared-generation", "record is stamped with a generation the manifest does not declare"],
]) {
  check(`ledger/[${kind}] is INDETERMINATE — advisory UNKNOWN, never teeth`, () => {
    // "Could not check" is not "checked, and it is forged". Blocking here would
    // make an unreachable roster indistinguishable from a forgery, which is the
    // over-fire that trains people to route around the guard.
    const d = ledgerRepo(`${REFUSAL_PREAMBLE} event log '.session-notes.shared.md':\n${findingLine(3, kind, why)}\n`);
    const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
    if (verdictOf(res) === "block") return `BLOCKED on an INDETERMINATE finding: ${delivered(res).slice(0, 300)}`;
    if (res.code !== 0) return `expected exit 0 (fail open), got ${res.code}`;
    return /LINK STATUS: UNKNOWN/.test(delivered(res))
      ? true
      : `the indeterminate refusal was not surfaced as UNKNOWN: ${delivered(res).slice(0, 300)}`;
  });
}

check("ledger/an integrity kind BESIDE an indeterminate one still BLOCKS — the verdict reached wins", () => {
  // The laundering path this closes: if one unresolvable sibling downgraded the
  // whole refusal, an attacker would only need to co-append one record signed by
  // an unrostered id to make every forged record beside it pass as advisory.
  const d = ledgerRepo(
    `${REFUSAL_PREAMBLE} event log '.session-notes.shared.md':\n` +
      `${findingLine(2, "unrostered-signer", "'ghost' is not on the roster")}\n` +
      `${findingLine(9, "bad-signature", "record 'rec_z' carries a signature that does NOT verify")}\n`,
  );
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (verdictOf(res) !== "block") return `expected a BLOCK, got ${verdictOf(res)}: ${delivered(res).slice(0, 300)}`;
  return delivered(res).includes("[bad-signature]") ? true : "blocked without naming the integrity finding";
});

// ── `no-signer-fingerprint` KEEPS THE RUNG, LOSES THE ACCUSATION ────────────
//
// The kind blocks (pinned by the integrity loop above) but it is the one
// integrity kind that is NOT a claim about the record: `signed-log.js` raises it
// when the resolver returns no fingerprint, or one under the length floor, and
// in both cases the verifier never reached the bytes. The shared integrity
// wording told the reader the verifier RAN and not to re-sign — which points an
// operator at a record nobody accused while the broken roster entry goes
// unedited. These two poles pin the split so the prose cannot silently revert.

check("ledger/[no-signer-fingerprint] ALONE names the ROSTER — it does not accuse the record", () => {
  const d = ledgerRepo(
    `${REFUSAL_PREAMBLE} event log '.session-notes.shared.md':\n` +
      `${findingLine(4, "no-signer-fingerprint", "the key resolver returned a fingerprint of 2 character(s) for 'op'; the floor is 16")}\n`,
  );
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "some new context\n"));
  if (verdictOf(res) !== "block") return `expected a BLOCK, got ${verdictOf(res)}: ${delivered(res).slice(0, 300)}`;
  if (res.code !== 2) return `a block must exit 2, got ${res.code}`;
  const dtx = delivered(res);
  // The claim that must be ABSENT. It is the one an operator acts on wrongly.
  if (/The verifier RAN/.test(dtx)) return `told the operator the verifier RAN, which it did not: ${dtx.slice(0, 400)}`;
  if (/Do NOT re-emit or re-sign the record to make this/.test(dtx)) {
    return `told the operator not to re-sign a record that was never accused: ${dtx.slice(0, 400)}`;
  }
  if (!/VERIFICATION COULD NOT RUN/.test(dtx)) return `does not say verification could not run: ${dtx.slice(0, 400)}`;
  if (!/ROSTER EDIT/.test(dtx)) return `does not point the operator at the roster: ${dtx.slice(0, 400)}`;
  return /\[no-signer-fingerprint\]/.test(dtx) ? true : `the payload does not name the kind: ${dtx.slice(0, 400)}`;
});

check("ledger/[no-signer-fingerprint] BESIDE a real forgery keeps BOTH readings", () => {
  // A mixed refusal must not lose the accusation for the record that IS accused,
  // nor spread it onto the one that is not. The bad-signature framing stays and
  // the roster rows are called out as the separate thing they are.
  const d = ledgerRepo(
    `${REFUSAL_PREAMBLE} event log '.session-notes.shared.md':\n` +
      `${findingLine(2, "no-signer-fingerprint", "the roster entry for 'op' declares no fingerprint")}\n` +
      `${findingLine(9, "bad-signature", "record 'rec_z' carries a signature that does NOT verify")}\n`,
  );
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (verdictOf(res) !== "block") return `expected a BLOCK, got ${verdictOf(res)}: ${delivered(res).slice(0, 300)}`;
  const dtx = delivered(res);
  if (!/\[bad-signature\]/.test(dtx)) return "blocked without naming the integrity finding";
  if (!/The verifier RAN/.test(dtx)) return `dropped the accusation for the record that IS accused: ${dtx.slice(0, 400)}`;
  return /1 of these are \[no-signer-fingerprint\]/.test(dtx)
    ? true
    : `the roster rows were not distinguished from the forgery: ${dtx.slice(0, 500)}`;
});

check("ledger/an UNRECOGNISED bracketed kind stays UNKNOWN — the arm does not over-fire", () => {
  // The pre-existing-refusal case this file already reasons about must survive:
  // a kind this guard has never heard of is not evidence of anything, and
  // defaulting it to teeth would give every future upstream finding kind a block
  // nobody reviewed.
  const d = ledgerRepo(
    `${REFUSAL_PREAMBLE} event log '.session-notes.shared.md':\n` +
      `${findingLine(5, "some-kind-invented-tomorrow", "a finding class this guard has never seen")}\n`,
  );
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (verdictOf(res) === "block") return `BLOCKED on an unrecognised kind: ${delivered(res).slice(0, 300)}`;
  return /LINK STATUS: UNKNOWN/.test(delivered(res)) ? true : `not surfaced as UNKNOWN: ${delivered(res).slice(0, 300)}`;
});

check("ledger/an integrity kind in the refusal's PROSE does not mint a verdict — the shape is anchored", () => {
  // THE NO-FALSE-POSITIVE POLE FOR THE MATCHER ITSELF. `[bad-signature]` appears
  // here inside an ordinary sentence, not as a `line <n>: [<kind>]` finding. A
  // matcher that hunted brackets anywhere would block on a generator whose
  // refusal merely EXPLAINS what a bad signature is — a block manufactured out
  // of prose, which is exactly what `hook-output-discipline.md` MUST-2 forbids.
  const d = ledgerRepo(
    `${REFUSAL_PREAMBLE} declared source 'burndown/register.json' has uncommitted modifications ` +
      `against HEAD. (Unrelated: a [bad-signature] finding would be reported per record.)\n`,
  );
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (verdictOf(res) === "block") return `BLOCKED on a bracket appearing in prose: ${delivered(res).slice(0, 300)}`;
  return /LINK STATUS: UNKNOWN/.test(delivered(res)) ? true : `not surfaced as UNKNOWN: ${delivered(res).slice(0, 300)}`;
});

check("ledger/an integrity refusal at an exit code OTHER than 2 stays UNKNOWN", () => {
  // The relay reads the generator's REFUSAL protocol, not any stderr that
  // mentions a kind. Exit 1 is a crash, and a crash carries no verdict.
  const d = ledgerRepo(`${REFUSAL_PREAMBLE}\n${findingLine(4, "bad-signature", "does NOT verify")}\n`, 1);
  const res = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  return expectNotBlock(res);
});

check("ledger/the stub's refusal shape IS the generator's own — pinned against burndown-build.mjs", () => {
  // NOT a substitute for the behavioral poles above; a fence around them. They
  // drive a stub, so they would keep passing against a shape the real generator
  // no longer emits. This reds the moment that drift happens.
  const src = fs.readFileSync(GENERATOR, "utf8");
  const hits = (src.match(/line \$\{f\.line\}: \[\$\{f\.kind\}\] \$\{f\.why\}/g) || []).length;
  if (hits < 3) {
    return `expected the 3 refusal renderers (signatures, closed-generation, chain) to use \`line <n>: [<kind>] <why>\`, found ${hits} — the stub above is now testing a shape the generator does not emit`;
  }
  // And the kinds themselves are real: a typo'd kind in the guard's table would
  // make every pole above green against a string nothing produces.
  const lib = fs.readFileSync(path.join(HOOKS, "lib", "signed-log.js"), "utf8");
  const missing = ["bad-signature", "closed-generation-append", "fork", "chain-break", "verification-unavailable", "unrostered-signer"].filter(
    (k) => !lib.includes(`kind: "${k}"`),
  );
  return missing.length === 0 ? true : `signed-log.js does not emit these kinds: ${missing.join(", ")}`;
});

// ── scope: the surfaces the predicate claims, exercised one by one ─────────

// A surface is IN SCOPE iff a write to it can produce an observable verdict. For
// every surface EXCEPT the tracker that observable is the broken-chain block; the
// tracker cannot produce one (writing it dirties it), so its in-scope proof is the
// semantic advisory, which no out-of-scope path can reach.
for (const [label, rel, body, expect] of [
  ["a burndown/ file", "burndown/notes.md", "body\n", "block"],
  ["a nested burndown/ path", "burndown/extra/x.md", "body\n", "block"],
  ["a file under a declared anchor_root", "workspaces/w/notes.md", "body\n", "block"],
  [
    "the declared tracker",
    ".session-notes.shared.md",
    ledger([{ id: "R1-alpha-item", anchor: "journal/0002-b.md" }]),
    "advisory",
  ],
]) {
  check(`scope/${label} IS a chain surface — a write there is adjudicated`, () => {
    const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
    const res = runHook(d, writePayload(d, rel, body));
    return verdictOf(res) === expect ? true : `expected ${expect}, got ${verdictOf(res)}: ${delivered(res).slice(0, 250)}`;
  });
}

check("scope/a .session-notes.d/ FRAGMENT is EXCLUDED — silent on a genuinely broken chain", () => {
  // THE RULING, pinned. A `.d/` fragment participates in no leg: the generator
  // refuses anchors into it by name, because /reconcile-notes is entitled to
  // prune it. So a finding surfaced on a fragment write is always about the tree
  // and never about the bytes just written — the same crying-wolf shape
  // `selfInflicted()` suppresses, on a surface written often enough to train
  // people out of reading the channel.
  //
  // THE CONTROL IS THE LOAD-BEARING HALF. A silent pole is indistinguishable
  // from a guard that stopped working, so the SAME repo must be shown still
  // firing: one write to the tracker (in scope) and one to a journal file (in
  // scope), both on this very tree, before the fragment's silence means anything.
  const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });

  const journalControl = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (expectBlock(journalControl, { id: "R2-alpha-item", leg: "LINK-1" }) !== true) {
    return `the journal control did not block, so this tree proves nothing: ${delivered(journalControl).slice(0, 250)}`;
  }
  const trackerControl = runHook(
    d,
    writePayload(d, ".session-notes.shared.md", ledger([{ id: "R1-alpha-item", anchor: "journal/0002-b.md" }])),
  );
  if (verdictOf(trackerControl) !== "advisory") {
    return `the tracker control fell silent (${verdictOf(trackerControl)}) — the guard may simply be off, not scoped`;
  }

  // Same repo, same broken chain, same guard invocation. Only the PATH differs.
  const res = runHook(d, writePayload(d, ".session-notes.d/someoperator.md", "an operator memory fragment\n"));
  return expectSilent(res);
});

check("scope/a manifest declaring .session-notes.d/ as an anchor_root NEVER blocks — two independent reasons", () => {
  // RE-POINTED, and the reason is recorded rather than quietly absorbed. This pole
  // was written to prove ORDERING inside `isChainSurface`: that the `.session-notes.d/`
  // exclusion is checked BEFORE the anchor_root prefix branch, so a deployment
  // declaring that subtree as a root could not re-admit it. That scenario is now
  // UNREACHABLE from the generator's side: `burndown-build.mjs` refuses such a
  // manifest outright (`is MEMORY — /reconcile-notes is entitled to prune it`),
  // because a self-declared root with no floor made the whole gate vacuous from one
  // line. So the generator never emits a LINK finding for this configuration at all.
  //
  // Keeping the old assertion would have been keeping a pole whose stated reason no
  // longer holds — it would still pass, and it would pass for a reason that has
  // nothing to do with ordering. What is asserted now is the property that IS live
  // and IS worth pinning: this configuration must never reach the block arm, by
  // EITHER route. The hook's ordering still holds independently (the sibling pole
  // above proves a fragment write stays silent on a genuinely broken chain, with a
  // control that blocks on the same tree); this one pins that a generator refusal
  // carrying no LINK lines degrades to advisory rather than to teeth.
  const d = mkRepo({
    rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }],
    anchorRoots: ["journal/", ".session-notes.d/"],
  });
  // Both surfaces, because "never blocks" is the claim: the fragment itself, and an
  // ordinary chain surface under the same poisoned manifest.
  const onFragment = runHook(d, writePayload(d, ".session-notes.d/someoperator.md", "fragment\n"));
  if (verdictOf(onFragment) === "block") return "blocked on the fragment write";
  const onJournal = runHook(d, writePayload(d, "journal/0002-new.md", "context\n"));
  if (verdictOf(onJournal) === "block") {
    return "blocked on a chain surface under a manifest the generator refuses outright — a non-LINK refusal must degrade to advisory, never to teeth";
  }
  return true;
});

for (const [label, rel] of [
  ["ordinary source", "src/thing.ts"],
  ["the burndown TARGET file", "REGISTER.md"],
  ["a root doc", "README.md"],
]) {
  check(`scope/${label} is NOT a chain surface — silent even on a broken chain`, () => {
    const d = mkRepo({ rows: [{ id: "R1-alpha-item", anchor: "journal/0001-a.md" }] });
    const res = runHook(d, writePayload(d, rel, "body\n"));
    return expectSilent(res);
  });
}

console.log("");
console.log(`burndown-trace fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
