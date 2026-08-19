#!/usr/bin/env node
/**
 * burndown-integrity — fixtures for `rules/burndown-integrity.md` and its
 * generator `.claude/bin/burndown-build.mjs`.
 *
 * BIPOLAR BY CONSTRUCTION. A generator shown only to REFUSE proves it can say
 * "no"; it does not prove it can say anything else. Half the cases below are
 * builds that MUST SUCCEED — a clean register, a manifest whose source array has
 * been REORDERED, an owner refresh correctly outranking a same-day agent one. If
 * the generator refuses those, it is a rubber stamp pointed the other way and is
 * just as useless as one that never refuses at all.
 *
 * HOW EACH CASE DISCRIMINATES. Every case builds a REAL temporary git repository
 * on disk — real committed source files, real manifest — and invokes the REAL
 * binary as a subprocess, reading its EXIT CODE and its stdout/stderr. Nothing is
 * mocked and no internal is reached around, so a case cannot pass against an
 * implementation the command line would not.
 *
 * THE LEVER IS THE SOURCE STATE, not a flag: same binary, same arguments,
 * different committed content. That is what makes each pair meaningful — the two
 * poles differ ONLY in the thing the clause is about.
 *
 * EXIT CODES ARE ASSERTED EXACTLY, never as "non-zero". `exit 2` (UNRUNNABLE,
 * refused, no block) and `exit 1` (stale block) mean different things, and a case
 * that accepts either cannot tell a refusal from a stale-block report.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TOOL = process.env.BURNDOWN_TOOL || path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");

let pass = 0;
const failures = [];

// `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS counts.
// An indented or symbol-prefixed line is invisible to it.
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

// ── fixture repo construction ───────────────────────────────────────────────
const REGISTER = {
  _note: "fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "REG-NN-SLUG",
  items: [
    { id: "REG-01-A", page: "Alpha", status: "Signed off" },
    { id: "REG-02-A", page: "Alpha", status: "Signed off" },
    { id: "REG-03-A", page: "Alpha", status: "Signed off" },
    { id: "REG-04-B", page: "Beta", status: "In progress" },
    { id: "REG-05-B", page: "Beta", status: "Not started" },
  ],
};
const GROWTH = {
  _note: "fixture",
  _generated: "2026-08-10",
  _authority: "agent",
  _id_convention: "CONV-NN-SLUG",
  items: [
    { id: "CONV-01-EXTRA", page: "Beta", status: "Not started" },
    { id: "CONV-02-EXTRA", page: "Beta", status: "Not started" },
  ],
};
const REFRESH = {
  _note: "fixture",
  _generated: "2026-08-12",
  _authority: "owner",
  _id_convention: "existing ids only",
  items: [{ id: "REG-01-A", status: "Blocked on you" }],
};
const MANIFEST = {
  _schema: "burndown-manifest/v1",
  target: "REGISTER.md",
  pages: ["Alpha", "Beta"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
};

function j(o) {
  return JSON.stringify(o, null, 2) + "\n";
}

/** Build a real git repo. `files` is a {relpath: contents} map, all committed. */
function mkRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "burndown-fx-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "fx@example.invalid"],
    ["config", "user.name", "fx"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

function baseFiles(extra = {}) {
  return {
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(REGISTER),
    "burndown-manifest.json": j(MANIFEST),
    ...extra,
  };
}

function run(dir, args = []) {
  const r = spawnSync("node", [TOOL, "--repo", dir, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// ── COMPLIANT POLE — these MUST succeed ─────────────────────────────────────

check("compliant/clean-register-builds", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return r.code === 0 && /ALL PAGES/.test(r.out) ? true : `exit ${r.code}, out=${r.out.slice(0, 200)}`;
});

check("compliant/binding-clause-is-verbatim-in-block", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return r.out.includes(
    "These are the only counts. Any figure quoted anywhere is this block verbatim, or it is wrong.",
  )
    ? true
    : "binding clause missing from the generated block";
});

check("compliant/closed-vocabulary-carried-inside-block", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  const need = ["Signed off", "Built-not-walked", "In progress", "Not started", "Blocked on you", "Open"];
  const missing = need.filter((n) => !r.out.includes(n));
  return missing.length === 0 ? true : `block omits ${missing.join(", ")}`;
});

check("compliant/blocked-count-labels-named-in-block", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return ["done", "complete", "closed", "finished", "remaining"].every((w) => r.out.includes(w))
    ? true
    : "the block does not name the BLOCKED count labels";
});

check("compliant/growth-split-columns-present", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  return r.out.includes("Open: from original register") && r.out.includes("Open: arrived since")
    ? true
    : "growth-split columns absent";
});

check("compliant/manifest-source-REORDER-yields-identical-block", () => {
  // Precedence is (date, authority, precedence, filename) — NEVER list position.
  const fwd = { ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 },
  ] };
  const rev = { ...MANIFEST, sources: [...fwd.sources].reverse() };
  const extra = { "burndown/growth.json": j(GROWTH), "burndown/refresh.json": j(REFRESH) };
  const a = run(mkRepo(baseFiles({ ...extra, "burndown-manifest.json": j(fwd) })));
  const b = run(mkRepo(baseFiles({ ...extra, "burndown-manifest.json": j(rev) })));
  if (a.code !== 0 || b.code !== 0) return `exit ${a.code}/${b.code}`;
  const strip = (s) => s.replace(/^(generated_from_sha|sources_digest): .*$/gm, "$1: X");
  return strip(a.out) === strip(b.out) ? true : "reordering the manifest changed the counts";
});

check("compliant/owner-refresh-outranks-same-day-agent-refresh", () => {
  // THE FILENAMES ARE LOAD-BEARING AND DELIBERATELY INVERTED. This case read
  // `a-agent.json` / `z-owner.json` before, and the LAST precedence key is the
  // path — so the owner file sorted last, and won, BY ALPHABET. Measured: with
  // the `_authority` comparison DELETED from byPrecedence the case still PASSED,
  // while a filename-swapped repo flipped from blockedOnYou=1 to inProgress=1.
  // It could not falsify the claim in its name. Naming the owner file FIRST
  // alphabetically leaves the authority key as the ONLY thing that can produce
  // the owner-wins result, so deleting that key now reds this case.
  const agentSameDay = { ..._clone(REFRESH), _authority: "agent", items: [{ id: "REG-02-A", status: "In progress" }] };
  const ownerSameDay = { ..._clone(REFRESH), _authority: "owner", items: [{ id: "REG-02-A", status: "Blocked on you" }] };
  const m = { ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/a-owner.json", kind: "status-refresh", precedence: 0 },
    { path: "burndown/z-agent.json", kind: "status-refresh", precedence: 0 },
  ] };
  const d = mkRepo(baseFiles({
    "burndown/a-owner.json": j(ownerSameDay),
    "burndown/z-agent.json": j(agentSameDay),
    "burndown-manifest.json": j(m),
  }));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 200)}`;
  const all = JSON.parse(r.out).all;
  // Owner said 'Blocked on you'; agent said 'In progress'. Same date. Owner wins.
  return all.blockedOnYou === 1 && all.inProgress === 1
    ? true
    : `owner refresh did not win: blocked=${all.blockedOnYou} inprog=${all.inProgress}`;
});

check("compliant/rows-partition-and-all-pages-is-the-sum", () => {
  const d = mkRepo(baseFiles({
    "burndown/growth.json": j(GROWTH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }),
  }));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}`;
  const { pages, all } = JSON.parse(r.out);
  const keys = ["total", "signedOff", "builtNotWalked", "inProgress", "notStarted", "blockedOnYou", "open", "openFromRegister", "openArrivedSince"];
  for (const p of [...pages, all]) {
    const parts = p.signedOff + p.builtNotWalked + p.inProgress + p.notStarted + p.blockedOnYou;
    if (parts !== p.total) return `row ${p.name} does not partition (${parts} vs ${p.total})`;
    if (p.open !== p.total - p.signedOff) return `row ${p.name} open wrong`;
    if (p.openFromRegister + p.openArrivedSince !== p.open) return `row ${p.name} split wrong`;
  }
  for (const k of keys) {
    if (pages.reduce((a, x) => a + x[k], 0) !== all[k]) return `ALL PAGES ${k} is not the sum`;
  }
  return true;
});

check("compliant/check-passes-on-a-freshly-written-block", () => {
  const d = mkRepo(baseFiles());
  const w = run(d, ["--write"]);
  if (w.code !== 0) return `write exit ${w.code}`;
  const c = run(d, ["--check"]);
  return c.code === 0 ? true : `check exit ${c.code}: ${c.err.slice(0, 200)}`;
});

// R-STRUCT-1 (2026-08-18 redteam): `--quote` is the affordance the rule calls "the
// correct path is the cheap one", and for `Open` it emitted a BARE count — exactly
// the shape MUST-3 blocks. Neither hook arm could catch it: the token is VALID so
// the structural arm passes it, and the lexical arm fires only on UNtokened counts.
// Bipolar on the lever, so a fix that appended the split to EVERY bucket also reds.
check("compliant/quote-of-Open-carries-the-growth-split", () => {
  const d = mkRepo(baseFiles({
    "burndown/growth.json": j(GROWTH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }),
  }));
  const r = run(d, ["--quote", "ALL PAGES/Open"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 200)}`;
  if (!/Open: from original register/.test(r.out) || !/Open: arrived since/.test(r.out)) {
    return `MUST-3: the Open quote carries no growth split: ${r.out.trim()}`;
  }
  // All three figures must be TOKENISED, or the split is prose the reader cannot check.
  const toks = r.out.match(/\d+⟨[0-9a-f]{6}⟩/g) || [];
  if (toks.length !== 3) return `expected 3 tokenised counts in the Open quote, got ${toks.length}`;
  // BUG-C shape (2026-08-18 security redteam): this revalidation step read
  // `run(d, ["--verify-quote","-"])` — stdin, with NOTHING piped in. Measured, that
  // returns exit 0 and "no tokenised counts found; nothing to validate", so
  // `v.code === 0` passed WITHOUT the quote ever being looked at, the `|| /all
  // valid/` disjunct was dead, and the failure message below could never print. The
  // quote is now fed in as a FILE and the outcome asserted positively: all three
  // figures, all valid. Reds if any split figure stops revalidating.
  const v = verifyText(d, r.out);
  if (v.code !== 0) return `the split figures do not revalidate: exit ${v.code} ${v.err.slice(0, 200)}`;
  return /3 tokenised count\(s\) all valid/.test(v.out)
    ? true
    : `expected all 3 split figures validated, got: ${v.out.trim().slice(0, 160)}`;
});

check("compliant/quote-of-a-non-Open-bucket-carries-NO-split", () => {
  const d = mkRepo(baseFiles());
  const r = run(d, ["--quote", "ALL PAGES/Signed off"]);
  if (r.code !== 0) return `exit ${r.code}`;
  if (/Open: from original register|Open: arrived since/.test(r.out)) {
    return `the split was appended to a non-Open bucket: ${r.out.trim()}`;
  }
  return /\d+⟨[0-9a-f]{6}⟩ of \d+ `Signed off`/.test(r.out) ? true : `unexpected shape: ${r.out.trim()}`;
});

check("compliant/selftest-exits-zero", () => {
  const r = spawnSync("node", [TOOL, "--selftest"], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 && /SELFTEST OK/.test(r.stdout) ? true : `exit ${r.status}`;
});

check("compliant/selftest-prints-both-poles-of-the-growth-split", () => {
  const r = spawnSync("node", [TOOL, "--selftest"], { cwd: REPO_ROOT, encoding: "utf8" });
  return /'Open: arrived since' = 0/.test(r.stdout) && /'Open: arrived since' = 2/.test(r.stdout)
    ? true
    : "selftest does not state both poles of the discriminating column";
});

// ── THE SECURITY LANE'S EXPLOITS, ported as bipolar pairs ───────────────────
// Each of these PASSED before the fix. The compliant pole of every pair is the
// honest form of the same sentence, so a fix that simply rejected everything
// would fail here too.

function quoteOf(d, bucket) {
  const r = spawnSync("node", [TOOL, "--repo", d, "--quote", bucket], { cwd: d, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`--quote failed: ${r.stderr}`);
  return r.stdout.trim();
}
function verifyText(d, text) {
  const f = path.join(d, "q.txt");
  fs.writeFileSync(f, text);
  return run(d, ["--verify-quote", f]);
}

check("BUG1/violation — a token lifted onto a DIFFERENT bucket+denominator is REJECTED", () => {
  // BUG-C (2026-08-18 security redteam): this case asserted `/denominator|bucket/`,
  // and the MISSING-CONTEXT refusal contains BOTH words — so the assertion could not
  // tell the recompute branch from the missing-context branch, and the case passed
  // on the wrong one. Proven by narrowing it to `/contradicts token/`, which RED-ed
  // and printed the missing-context message. Two changes, both needed: the sentence
  // now keeps the canonical `of <denom> \`<label>\`` slot INTACT (the old `**` broke
  // it, which is why it never reached the recompute), and the assertion pins the
  // branch the case NAMES. Distinct from the canonical-form case below by its lever:
  // there the contradiction is a bare canonical sentence, here it is EMBEDDED IN
  // PROSE, which is the shape a report actually ships.
  const d = mkRepo(baseFiles());
  const open = quoteOf(d, "ALL PAGES/Open").match(/\d+⟨[0-9a-f]{6}⟩/)[0];
  // Truth is 2 of 5 Signed off; this claims completion against a reused Open token.
  const r = verifyText(d, `We are done — ALL PAGES — ${open} of 2 \`Signed off\` across the board.`);
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  if (/no verifiable /.test(r.err)) {
    return `rejected for MISSING context — this case must exercise the recompute branch: ${r.err.slice(0, 160)}`;
  }
  return /contradicts token/.test(r.err) && /denominator 2/.test(r.err) && /Signed off/.test(r.err)
    ? true
    : `no context contradiction named: ${r.err.slice(0, 200)}`;
});

check("BUG1/violation — a CANONICAL-FORM contradiction is caught by the RECOMPUTE, not by missing context", () => {
  // WHY THIS CASE EXISTS, measured during integration: the original exploit
  // (`**N⟨tok⟩ of 2** signed off`) stopped reaching the recompute branch once the
  // label parse became positional — the `**` breaks the canonical slot, so it is
  // now rejected for MISSING context instead. That fixture therefore passed for a
  // reason unrelated to the clause it names, the same shape M3 caught earlier.
  // This case states the contradiction in PERFECT canonical form, so the only
  // thing that can reject it is the digest recomputation.
  const d = mkRepo(baseFiles());
  const q = quoteOf(d, "ALL PAGES/Open");
  const pair = q.match(/\d+⟨[0-9a-f]{6}⟩/)[0];
  const r = verifyText(d, `ALL PAGES — ${pair} of 2 \`Signed off\``);
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  if (/no verifiable /.test(r.err)) {
    return "rejected for MISSING context — this case must exercise the recompute branch";
  }
  return /contradicts token/.test(r.err) && /denominator 2/.test(r.err) && /Signed off/.test(r.err)
    ? true
    : `wrong rejection reason: ${r.err.slice(0, 200)}`;
});

check("BUG1/compliant — the honest canonical quote still VALIDATES", () => {
  const d = mkRepo(baseFiles());
  const r = verifyText(d, `Status: ${quoteOf(d, "ALL PAGES/Open")} and holding.`);
  return r.code === 0 ? true : `honest quote rejected: exit ${r.code} ${r.err.slice(0, 200)}`;
});

check("BUG1/violation — a BARE token with no bucket/denominator is REJECTED", () => {
  const d = mkRepo(baseFiles());
  const bare = quoteOf(d, "ALL PAGES/Open").match(/\d+⟨[0-9a-f]{6}⟩/)[0];
  const r = verifyText(d, `We are at ${bare} right now.`);
  return r.code === 1 && /no verifiable row\/denominator\/bucket/.test(r.err)
    ? true
    : `exit ${r.code}: ${r.err.slice(0, 200)}`;
});

// \u2500\u2500 ROW SUBSTITUTION (BUG-A, 2026-08-18 security redteam) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// The suite had ZERO row-substitution cases while `verifyQuotes`'s own refusal text
// ASSERTED row binding ("That token certifies N of D 'L' on ROW"). Measured, three
// of the four hashed fields were positionally bound and the ROW was not: it matched
// first-in-index-order ANYWHERE in the preceding 120 chars, with a silent
// `|| known.row` fallback that RE-INJECTED the certified row on a miss.
//
// The lever is a register where two pages share a total, so the DENOMINATOR cannot
// separate them and only the row can: Alpha is 1 of 3 Open, Gamma is 3 of 3.
const ROW_REGISTER = {
  _generated: "2026-08-01",
  _authority: "owner",
  items: [
    { id: "REG-01-A", page: "Alpha", status: "Signed off" },
    { id: "REG-02-A", page: "Alpha", status: "Signed off" },
    { id: "REG-03-A", page: "Alpha", status: "Not started" },
    { id: "REG-04-G", page: "Gamma", status: "In progress" },
    { id: "REG-05-G", page: "Gamma", status: "Not started" },
    { id: "REG-06-G", page: "Gamma", status: "Not started" },
  ],
};
function mkRowRepo() {
  return mkRepo({
    "REGISTER.md": "# Register\n",
    "burndown/register.json": j(ROW_REGISTER),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["Alpha", "Gamma"], sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 }] }),
  });
}
// Each entry lies about GAMMA (truly 3 of 3) while carrying ALPHA's token (1 of 3).
// The first is the CONTROL: it rejected before the fix too, which is what shows the
// verifier could reject AT ALL here and that the others' passes were a real gap.
for (const [why, render] of [
  ["CONTROL-adjacent-row", (t) => `Gamma \u2014 1\u27E8${t}\u27E9 of 3 \`Open\``],
  ["heading-with-trailing-words", (t) => `### Gamma status as of today\n\n1\u27E8${t}\u27E9 of 3 \`Open\` \u2014 nearly clear`],
  ["a-newline-between-row-and-count", (t) => `Now for Gamma. The page stands at\n1\u27E8${t}\u27E9 of 3 \`Open\``],
  ["a-period-between-row-and-count", (t) => `Now for Gamma. The page stands at 1\u27E8${t}\u27E9 of 3 \`Open\``],
  ["the-row-placed-AFTER-the-count", (t) => `1\u27E8${t}\u27E9 of 3 \`Open\` on Gamma`],
  ["more-than-40-chars-of-prose", (t) => `Gamma, which the owner reviewed last Tuesday afternoon, is at 1\u27E8${t}\u27E9 of 3 \`Open\``],
]) {
  check(`BUGA/violation \u2014 a token lifted onto a DIFFERENT ROW is REJECTED (${why})`, () => {
    const d = mkRowRepo();
    const tok = quoteOf(d, "Alpha/Open").match(/[0-9a-f]{6}/)[0];
    const r = verifyText(d, render(tok));
    if (r.code !== 1) return `expected exit 1, got ${r.code}: ${(r.out + r.err).slice(0, 200)}`;
    // Either branch is a correct rejection, but it must name the ROW dimension \u2014
    // an exit-1 for some unrelated reason would not pin this clause.
    return /row 'Gamma' \(certified 'Alpha'\)|no verifiable row/.test(r.err)
      ? true
      : `rejected, but not on the ROW dimension: ${r.err.slice(0, 200)}`;
  });
}

check("BUGA/violation \u2014 the row is matched POSITIONALLY, not first-in-index-order", () => {
  // `Alpha is fine; ALL PAGES \u2014 1\u27E8alpha-token\u27E9 of 3 \`Open\`` validated because
  // `Alpha` matched FIRST in index order and equalled the certified row, while the
  // sentence attributed the count to ALL PAGES. Reds if the row search goes back to
  // scanning the whole `before` window instead of the slot adjacent to the count.
  const d = mkRowRepo();
  const tok = quoteOf(d, "Alpha/Open").match(/[0-9a-f]{6}/)[0];
  const r = verifyText(d, `Alpha is fine; ALL PAGES \u2014 1\u27E8${tok}\u27E9 of 3 \`Open\``);
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  return /row 'ALL PAGES' \(certified 'Alpha'\)/.test(r.err)
    ? true
    : `did not read the ADJACENT row: ${r.err.slice(0, 200)}`;
});

check("BUGA2/violation \u2014 EVERY token in the canonical --quote output is row-bound", () => {
  // The generator's OWN MUST-3 output was emitting a row-unbound token. Measured
  // before the fix: swapping the row on the canonical `Open` quote rejected 2 of 3
  // tokens and the THIRD \u2014 `arrived since`, the column MUST-3 calls the
  // highest-value one \u2014 still validated, 78 chars past the row name. This asserts
  // the count exactly, so 2-of-3 reds. Reds if the growth split goes back to
  // hanging off the first figure instead of repeating the full canonical triple.
  const d = mkRowRepo();
  const canon = quoteOf(d, "ALL PAGES/Open");
  const n = (canon.match(/\d+\u27E8[0-9a-f]{6}\u27E9/g) || []).length;
  if (n !== 3) return `expected 3 tokenised counts in the Open quote, got ${n}`;
  const r = verifyText(d, canon.split("ALL PAGES").join("Alpha"));
  if (r.code !== 1) return `expected exit 1, got ${r.code}`;
  return /3 of 3 tokenised count\(s\) FAILED/.test(r.err)
    ? true
    : `not every token was row-bound: ${(r.err.match(/\d+ of \d+ tokenised.*/) || ["?"])[0]}`;
});

check("BUGA/compliant \u2014 the canonical quote for EACH row still validates", () => {
  // The no-false-positive pole. A fix that simply refused everything reds here, and
  // so does one that binds the row so tightly the generator's own output fails it.
  const d = mkRowRepo();
  for (const row of ["Alpha", "Gamma", "ALL PAGES"]) {
    for (const bucket of ["Open", "Signed off"]) {
      const q = quoteOf(d, `${row}/${bucket}`);
      const r = verifyText(d, `Status: ${q} and holding.`);
      if (r.code !== 0) return `honest ${row}/${bucket} quote rejected: exit ${r.code} ${r.err.slice(0, 160)}`;
    }
  }
  return true;
});

for (const [label, digit] of [["FULLWIDTH", "\uFF15"], ["ARABIC-INDIC", "\u0665"]]) {
  check(`BUG2/violation — a ${label} digit beside a token is REJECTED, not skipped`, () => {
    const d = mkRepo(baseFiles());
    const q = quoteOf(d, "ALL PAGES/Open");
    const tok = q.match(/[0-9a-f]{6}/)[0];
    const denom = q.match(/of (\d+)/)[1];
    const r = verifyText(d, `We are at ${digit}⟨${tok}⟩ of ${denom} \`Open\`.`);
    return r.code === 1 && /non-ASCII digits/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 200)}`;
  });
}

check("BUG2/compliant — the same sentence in ASCII digits VALIDATES", () => {
  const d = mkRepo(baseFiles());
  const r = verifyText(d, `We are at ${quoteOf(d, "ALL PAGES/Open")}.`);
  return r.code === 0 ? true : `exit ${r.code}: ${r.err.slice(0, 200)}`;
});

check("BUG3/violation — a SYMLINKED declared source REFUSES (exit 2)", () => {
  const d = mkRepo(baseFiles());
  fs.writeFileSync(path.join(d, "elsewhere.json"), j({ ..._clone(REGISTER), items: [] }));
  fs.rmSync(path.join(d, "burndown", "register.json"));
  fs.symlinkSync("../elsewhere.json", path.join(d, "burndown", "register.json"));
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "symlink"], { cwd: d, stdio: "ignore" });
  const r = run(d);
  return r.code === 2 && /SYMLINK/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 200)}`;
});

check("BUG3/compliant — a REGULAR declared source still builds", () => {
  const r = run(mkRepo(baseFiles()));
  return r.code === 0 && /ALL PAGES/.test(r.out) ? true : `exit ${r.code}`;
});

check("disclosure/refusals name a REPO-RELATIVE path, never the operator's absolute tree", () => {
  const d = mkRepo(baseFiles({ "burndown/register.json": "{ not json" }));
  const r = run(d);
  if (r.code !== 2) return `expected exit 2, got ${r.code}`;
  if (r.err.includes(d)) return `refusal leaked the absolute path: ${r.err.slice(0, 160)}`;
  return /burndown\/register\.json/.test(r.err) ? true : "refusal does not name the relative path";
});

// ── VIOLATION POLE — these MUST refuse, with exit 2 exactly ─────────────────

/**
 * `reasonRx` is NOT decoration — it is what makes each case pin ITS OWN clause.
 *
 * Measured, and the reason this parameter exists: a mutation disabling the
 * closed-vocabulary check (`if (!ASSIGNABLE.includes(status))` → `if (0)`) left
 * this suite GREEN at 33/33. The unknown status flowed through to a `STATUS_KEY`
 * miss, produced NaN, and tripped the PARTITION assertion instead — so the case
 * still saw exit 2 and still saw the banner, and passed for a reason that had
 * nothing to do with the clause it was named for. Asserting the exit code alone
 * cannot tell one refusal from another. It asserts the refusal REASON now.
 */
function refuses(name, files, reasonRx, args = []) {
  check(name, () => {
    const d = mkRepo(baseFiles(files.commit || {}));
    if (files.mutate) files.mutate(d);
    const r = run(d, args);
    if (r.code !== 2) return `expected exit 2, got ${r.code}. err=${r.err.slice(0, 200)}`;
    if (!/^UNRUNNABLE — refusing because /m.test(r.err)) return "no UNRUNNABLE banner on stderr";
    if (!reasonRx.test(r.err)) {
      return `refused for the WRONG reason — wanted ${reasonRx}, got: ${r.err.split("\n")[0]}`;
    }
    return true;
  });
}

refuses("violation/uncommitted-source-refuses", {
  mutate: (d) => {
    fs.writeFileSync(path.join(d, "burndown", "growth.json"), j(GROWTH));
    fs.writeFileSync(path.join(d, "burndown-manifest.json"), j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }));
    execFileSync("git", ["add", "burndown-manifest.json"], { cwd: d, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "declare only"], { cwd: d, stdio: "ignore" });
    // growth.json is declared but NEVER committed.
  },
}, /is not committed/);

refuses("violation/modified-source-refuses", {
  mutate: (d) => {
    const p = path.join(d, "burndown", "register.json");
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    doc.items[0].status = "Blocked on you";
    fs.writeFileSync(p, j(doc)); // modified vs HEAD, never committed
  },
}, /uncommitted modifications against HEAD/);

refuses("violation/status-outside-closed-vocabulary-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    doc.items[0].status = "Mostly there";
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /outside the closed vocabulary/);

for (const word of ["done", "complete", "closed", "finished", "remaining"]) {
  refuses(
    `violation/blocked-count-label-'${word}'-refuses`,
    {
      mutate: (d) => {
        const doc = _clone(REGISTER);
        doc.items[0].status = word;
        _commitFile(d, "burndown/register.json", j(doc));
      },
    },
    /is a BLOCKED label/,
  );
}

refuses("violation/status-refresh-introducing-unknown-id-refuses", {
  mutate: (d) => {
    _commitFile(d, "burndown/refresh.json", j({ ..._clone(REFRESH), items: [{ id: "GHOST-99", status: "In progress" }] }));
    _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 },
    ] }));
  },
}, /introduced an id that no register or growth source declares/);

refuses("violation/item-on-undeclared-page-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    doc.items.push({ id: "REG-06-G", page: "Gamma", status: "Not started" });
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /is not declared in the manifest pages/);

refuses("violation/source-declared-twice-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "register", precedence: 0 },
    { path: "burndown/register.json", kind: "register", precedence: 1 },
  ] })),
}, /is declared twice in the manifest/);

refuses("violation/empty-source-list-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [] })),
}, /declares no sources/);

refuses("violation/wrong-schema-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, _schema: "burndown/v0" })),
}, /expected .burndown-manifest\/v1./);

refuses("violation/missing-authority-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    delete doc._authority;
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /declares _authority/);

refuses("violation/missing-generated-date-refuses", {
  mutate: (d) => {
    const doc = _clone(REGISTER);
    delete doc._generated;
    _commitFile(d, "burndown/register.json", j(doc));
  },
}, /no valid _generated date/);

refuses("violation/unknown-source-kind-refuses", {
  mutate: (d) => _commitFile(d, "burndown-manifest.json", j({ ...MANIFEST, sources: [
    { path: "burndown/register.json", kind: "notes", precedence: 0 },
  ] })),
}, /declares kind/);

// ── the refusal must not be mistakable for a pass ───────────────────────────

check("violation/refusal-prints-NOTHING-resembling-a-clean-summary", () => {
  const d = mkRepo(baseFiles());
  fs.writeFileSync(path.join(d, "burndown", "register.json"), j({ ..._clone(REGISTER), _authority: "nobody" }));
  const r = run(d);
  if (r.code !== 2) return `expected exit 2, got ${r.code}`;
  const all = r.out + r.err;
  // Every token a reader would scan for to conclude "it worked".
  for (const tok of ["ALL PAGES", "| page |", "Signed off |", "SELFTEST OK", "is current", "✓", "OK\n"]) {
    if (all.includes(tok)) return `refusal output contains clean-summary token ${JSON.stringify(tok)}`;
  }
  if (r.out.trim() !== "") return `refusal wrote to stdout: ${JSON.stringify(r.out.slice(0, 120))}`;
  return /This is exit 2\. It is NOT a pass\./.test(r.err) ? true : "refusal does not say it is not a pass";
});

check("violation/refusal-exit-is-2-not-1-so-it-is-distinguishable-from-stale", () => {
  const bad = mkRepo(baseFiles());
  fs.writeFileSync(path.join(bad, "burndown", "register.json"), j({ ..._clone(REGISTER), _authority: "nobody" }));
  const refusal = run(bad);
  const stale = mkRepo(baseFiles());
  run(stale, ["--write"]);
  const t = path.join(stale, "REGISTER.md");
  // Token-agnostic edit: bump the FIRST tokenised value in the table, leaving its
  // token behind. That is exactly the tamper the block is designed to expose, and
  // it does not depend on the table's column widths or rendering.
  fs.writeFileSync(
    t,
    fs.readFileSync(t, "utf8").replace(/\| Alpha \| (\d+)⟨/, (m, n) => `| Alpha | ${Number(n) + 6}⟨`),
  );
  const staleRun = run(stale, ["--check"]);
  return refusal.code === 2 && staleRun.code === 1
    ? true
    : `refusal=${refusal.code} (want 2), stale=${staleRun.code} (want 1)`;
});

check("violation/hand-edited-block-is-detected-by-check", () => {
  const d = mkRepo(baseFiles());
  run(d, ["--write"]);
  const t = path.join(d, "REGISTER.md");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace("**ALL PAGES**", "**ALL PAGES (hand-adjusted)**"));
  const r = run(d, ["--check"]);
  return r.code === 1 && /STALE/.test(r.err) ? true : `exit ${r.code}`;
});

check("violation/missing-block-is-detected-by-check", () => {
  const d = mkRepo(baseFiles());
  const r = run(d, ["--check"]);
  return r.code === 1 && /carries NO generated block/.test(r.err) ? true : `exit ${r.code}`;
});

check("compliant/sources-digest-changes-when-a-source-changes", () => {
  // (c) a block whose sources moved is STALE and detectable.
  const a = run(mkRepo(baseFiles()));
  const withGrowth = mkRepo(baseFiles({
    "burndown/growth.json": j(GROWTH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/growth.json", kind: "growth", precedence: 0 },
    ] }),
  }));
  const b = run(withGrowth);
  const dig = (s) => (s.match(/^sources_digest: (\S+)$/m) || [])[1];
  return dig(a.out) && dig(b.out) && dig(a.out) !== dig(b.out)
    ? true
    : "sources_digest did not change when the declared source set changed";
});

check("compliant/block-records-the-sha-it-was-generated-from", () => {
  const d = mkRepo(baseFiles());
  const r = run(d);
  const sha = (r.out.match(/^generated_from_sha: (\S+)$/m) || [])[1];
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  return sha === head ? true : `recorded ${sha}, HEAD is ${head}`;
});

// ── PRECEDENCE TOTALITY, AMBIGUITY, AND STALENESS ───────────────────────────
// Added 2026-08-18 after a correctness redteam. Each pins a defect that was LIVE
// and that the pre-existing cases could not see; each is named with the mutation
// that reds it.

check("compliant/manifest-source-REORDER-SAME-BASENAME-yields-identical-block", () => {
  // THE DISCRIMINATING FORM of the reorder case above. That one uses three
  // DISTINCT basenames (register/growth/refresh), so the comparator's filename key
  // resolved them whether or not the ordering was TOTAL — it passed against a
  // comparator that fell through to array position, which is exactly the property
  // it claims to test. Two sources sharing a basename in different directories is
  // the case that tells them apart: before the fix this returned Signed off 0 in
  // one order and 1 in the other. Reds if byPrecedence's last key is basename.
  const files = (order) => ({
    "REGISTER.md": "# Register\n",
    "burndown/x/reg.json": j({ _generated: "2026-08-01", _authority: "owner",
      items: [{ id: "R1", page: "Alpha", status: "Signed off" }] }),
    "burndown/y/reg.json": j({ _generated: "2026-08-01", _authority: "owner",
      items: [{ id: "R1", page: "Alpha", status: "Not started" }] }),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["Alpha"], sources: order }),
  });
  const fwd = [
    { path: "burndown/x/reg.json", kind: "register", precedence: 0 },
    { path: "burndown/y/reg.json", kind: "register", precedence: 0 },
  ];
  const a = run(mkRepo(files(fwd)), ["--json"]);
  const b = run(mkRepo(files([...fwd].reverse())), ["--json"]);
  if (a.code !== 0 || b.code !== 0) return `exit ${a.code}/${b.code}`;
  return a.out === b.out ? true : "reordering two same-basename sources CHANGED the counts";
});

check("refusal/non-integer-precedence-is-refused-not-read-as-zero", () => {
  // `precedence: "5"` was silently coerced to 0, flipping which source won and so
  // flipping the count, with no diagnostic. Reds if the coercion returns.
  const d = mkRepo(baseFiles({ "burndown-manifest.json": j({ ...MANIFEST,
    sources: [{ path: "burndown/register.json", kind: "register", precedence: "5" }] }) }));
  const r = run(d);
  return r.code === 2 && /not an integer/.test(r.err) ? true : `exit ${r.code}: ${r.err.slice(0, 160)}`;
});

check("compliant/integer-precedence-still-builds", () => {
  const d = mkRepo(baseFiles({ "burndown-manifest.json": j({ ...MANIFEST,
    sources: [{ path: "burndown/register.json", kind: "register", precedence: 5 }] }) }));
  return run(d).code === 0 ? true : "a numeric precedence must still build";
});

check("compliant/--check-stays-GREEN-across-commits", () => {
  // `generated_from_sha` is HEAD, and it was part of the equality comparison, so
  // --check reported STALE after the very commit that landed the block — and after
  // every commit thereafter. The fixed point was unreachable: regenerating carried
  // the new HEAD, committing it moved HEAD again. Reds if the sha is compared.
  const d = mkRepo(baseFiles());
  if (run(d, ["--write"]).code !== 0) return "write failed";
  execFileSync("git", ["add", "-A"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "land the block"], { cwd: d, stdio: "ignore" });
  if (run(d, ["--check"]).code !== 0) return "STALE immediately after committing the block";
  _commitFile(d, "unrelated.txt", "x\n");
  return run(d, ["--check"]).code === 0 ? true : "STALE after an unrelated commit";
});

check("refusal/--check-still-reds-on-a-hand-edited-block", () => {
  // The COMPLIANT POLE's opposite: excluding the sha must not blind --check. A
  // hand-edit and a moved source must both still exit 1.
  const d = mkRepo(baseFiles());
  run(d, ["--write"]);
  const t = path.join(d, "REGISTER.md");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace("**ALL PAGES**", "**ALL PAGES (edited)**"));
  if (run(d, ["--check"]).code !== 1) return "a hand-edited block was NOT reported stale";
  const d2 = mkRepo(baseFiles());
  run(d2, ["--write"]);
  const moved = _clone(REGISTER);
  moved.items[3].status = "Signed off";
  _commitFile(d2, "burndown/register.json", j(moved));
  const r = run(d2, ["--check"]);
  return r.code === 1 && /sources_digest/.test(r.err) ? true : `moved source: exit ${r.code}`;
});

check("refusal/ambiguous---quote-refuses-rather-than-answering-another-question", () => {
  // The normalizer folds spaces and hyphens, so pages `A B` and `A-B` collided and
  // `hits[0]` won: asking for one returned the OTHER page's count WITH A VALID
  // TOKEN. Reds if quoteFor goes back to taking the first hit.
  const reg = { _generated: "2026-08-01", _authority: "owner", items: [
    { id: "R1", page: "A B", status: "Signed off" },
    { id: "R2", page: "A-B", status: "Not started" },
  ] };
  const d = mkRepo({ "REGISTER.md": "# R\n", "burndown/register.json": j(reg),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["A B", "A-B"], sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 }] }) });
  const amb = run(d, ["--quote", "ab/open"]);
  if (amb.code !== 2 || !/AMBIGUOUS/.test(amb.err)) return `ambiguous quote: exit ${amb.code}`;
  // ...and the EXACT form must still answer, with the RIGHT page's number.
  const exact = run(d, ["--quote", "A-B/Open"]);
  return exact.code === 0 && /^A-B — 1/.test(exact.out.trim())
    ? true
    : `exact quote: exit ${exact.code}, out=${exact.out.trim().slice(0, 80)}`;
});

check("refusal/status-refresh-cannot-silently-move-an-item-between-pages", () => {
  // A refresh carrying a different `page` was accepted and the move DISCARDED: no
  // error, and counts that were plausible and wrong for the page being read.
  const refresh = { _generated: "2026-08-12", _authority: "owner",
    items: [{ id: "REG-04-B", page: "Alpha", status: "In progress" }] };
  const d = mkRepo(baseFiles({ "burndown/refresh.json": j(refresh),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 }] }) }));
  const r = run(d);
  return r.code === 2 && /cannot move an item between pages/.test(r.err)
    ? true : `exit ${r.code}: ${r.err.slice(0, 160)}`;
});

check("compliant/status-refresh-WITHOUT-a-page-still-refreshes", () => {
  const d = mkRepo(baseFiles({ "burndown/refresh.json": j(REFRESH),
    "burndown-manifest.json": j({ ...MANIFEST, sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 },
      { path: "burndown/refresh.json", kind: "status-refresh", precedence: 0 }] }) }));
  const r = run(d, ["--json"]);
  if (r.code !== 0) return `exit ${r.code}: ${r.err.slice(0, 160)}`;
  return JSON.parse(r.out).all.blockedOnYou === 1 ? true : "the refresh did not apply";
});

check("refusal/a-page-named-ALL-PAGES-is-refused", () => {
  // `ALL PAGES` is the DERIVED row; a declared page of that name would put two rows
  // under one name and make a quote naming it ambiguous.
  const reg = { _generated: "2026-08-01", _authority: "owner",
    items: [{ id: "R1", page: "ALL PAGES", status: "Signed off" }] };
  const d = mkRepo({ "REGISTER.md": "# R\n", "burndown/register.json": j(reg),
    "burndown-manifest.json": j({ ...MANIFEST, pages: ["ALL PAGES"], sources: [
      { path: "burndown/register.json", kind: "register", precedence: 0 }] }) });
  const r = run(d);
  return r.code === 2 && /reserved DERIVED row/.test(r.err) ? true : `exit ${r.code}`;
});

check("refusal/a-duplicated-page-declaration-is-refused", () => {
  const d = mkRepo(baseFiles({ "burndown-manifest.json":
    j({ ...MANIFEST, pages: ["Alpha", "Beta", "Alpha"] }) }));
  const r = run(d);
  return r.code === 2 && /more than once/.test(r.err) ? true : `exit ${r.code}`;
});

// ── helpers ─────────────────────────────────────────────────────────────────
function _clone(o) {
  return JSON.parse(JSON.stringify(o));
}
function _commitFile(dir, rel, body) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "mutate"], { cwd: dir, stdio: "ignore" });
}

console.log("");
console.log(`burndown-integrity fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failing: ${failures.join(", ")}`);
  process.exit(1);
}
