#!/usr/bin/env node
/**
 * Audit fixtures for `.claude/bin/validate-quoted-content.mjs`.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-1/2). Every failure
 * identity ships a RED pole that MUST be caught and a GREEN twin that MUST
 * pass, and the harness asserts the two verdicts DIFFER — an identical-verdict
 * pair is VACUOUS and fails here, because a fixture set satisfied by a checker
 * that reports everything (or nothing) is not a gate.
 *
 * Assertions are on the failure IDENTITY, never on an exit code or a count.
 * "The checker returned non-zero" is consistent with the checker being broken
 * in some unrelated way — the failure `instrument-discipline.md` MUST-1 names.
 *
 * ON-DISK, not synthesised in memory, so a reviewer can SEE the planted defect
 * (one deleted line in `red-omission.md`, one invented entry in
 * `red-fabricated.md`, one cut line in `red-truncation.md`) instead of taking a
 * generator's word for what it planted. Each RED pole's GREEN twin is the same
 * document with only that one difference.
 *
 * `green-illustrative.md` is the pole that decides whether the gate SURVIVES
 * rather than whether it FIRES. Its seven blocks would every one red loudly if
 * the locator scoped them; a checker that flags them is red on every commit
 * forever, and a red-forever check is the one an operator learns to ignore —
 * after which a genuinely fabricated quotation reads exactly like every other
 * day.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeDocument,
  compareLineBlock,
  loadCorpusFloor,
  selfTest,
  ID,
} from "../../bin/validate-quoted-content.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATING = new Set([
  ID.FABRICATED,
  ID.OMISSION,
  ID.TRUNCATION,
  ID.MEMBER_OMISSION,
  ID.SECTION_UNRESOLVED,
  ID.SECTION_AMBIGUOUS,
]);

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  process.stdout.write(`  PASS  ${n}\n`);
};
const no = (n, d) => {
  fail++;
  process.stderr.write(`  FAIL  ${n}\n        ${d}\n`);
};
const assert = (n, c, d) => (c ? ok(n) : no(n, d));

function verdict(pole) {
  const rel = `${pole}.md`;
  const abs = path.join(HERE, rel);
  const r = analyzeDocument({
    relPath: rel,
    text: fs.readFileSync(abs, "utf8"),
    readSource: (a) => fs.readFileSync(a, "utf8"),
    root: HERE, // cited paths resolve inside the fixture dir, never the repo
  });
  return {
    ids: r.findings.filter((f) => GATING.has(f.id)).map((f) => f.id),
    all: r.findings,
    coverage: r.coverage,
    compared: r.compared || [],
    blocks: r.blockCount,
    enums: r.enumCount,
    volume: r.volume,
  };
}

const key = (ids) => JSON.stringify([...ids].sort());

// ── CONTROL FIRST. Every assertion below reads findings off `analyzeDocument`.
// If the fixture root were mistyped, or block extraction silently returned
// nothing, every pole would report zero findings and the whole suite would go
// green on nothing. Establish that the documents are being READ and that blocks
// are being EXTRACTED, BEFORE any verdict is trusted.
{
  const v = verdict("red-omission");
  assert(
    "control: the RED omission document is read and its blocks extracted",
    v.blocks === 2,
    `expected 2 blocks in red-omission.md, got ${v.blocks} — a suite over zero blocks passes vacuously`,
  );
  assert(
    "control: the fixture source resolves inside the fixture dir",
    fs.existsSync(path.join(HERE, "sources", "severity-rank.js")),
    "sources/severity-rank.js is missing; every comparison would be unresolvable",
  );
}

// ── The three failure identities, each as a RED/GREEN pair.
const pairs = [
  {
    name: "undeclared-omission (THE CANONICAL REGRESSION: the deleted register entry)",
    red: "red-omission",
    green: "green-omission",
    identity: ID.OMISSION,
  },
  {
    name: "fabricated-line (an entry the source does not contain)",
    red: "red-fabricated",
    green: "green-fabricated",
    identity: ID.FABRICATED,
  },
  {
    name: "undeclared-truncation (a prefix rendering as a complete line)",
    red: "red-truncation",
    green: "green-truncation",
    identity: ID.TRUNCATION,
  },
  {
    name: "undeclared-member-omission (THE SEVEN-VS-EIGHT REGRESSION: the missing verdict kind)",
    red: "red-member-omission",
    green: "green-member-omission",
    identity: ID.MEMBER_OMISSION,
  },
  {
    name: "fabricated-line under a SECTION anchor (in the file, not in the named section)",
    red: "red-section-anchor",
    green: "green-section-anchor",
    identity: ID.FABRICATED,
  },
  {
    name: "unresolved-section-anchor (the anchor names no section)",
    red: "red-section-missing",
    green: "green-section-anchor",
    identity: ID.SECTION_UNRESOLVED,
  },
  {
    name: "ambiguous-section-anchor (the anchor names two sections)",
    red: "red-section-duplicate",
    green: "green-section-single",
    identity: ID.SECTION_AMBIGUOUS,
  },
  {
    name: "a WEAK anchor (MUST-N clause, unquoted §) over a fence is a reference, not an attribution",
    red: "red-strong-anchor-fence",
    green: "green-weak-anchor-fence",
    identity: ID.FABRICATED,
  },
  {
    name: "an elision declared in the ATTRIBUTION LINE below the block is read",
    red: "red-trailer-omission",
    green: "green-trailer-elision",
    identity: ID.OMISSION,
  },
];

for (const p of pairs) {
  const red = verdict(p.red);
  const green = verdict(p.green);

  assert(
    `${p.name} — RED pole names the identity ${p.identity}`,
    red.ids.includes(p.identity),
    `expected ${p.identity} in ${p.red}.md; got [${red.ids.join(", ") || "none"}]`,
  );
  assert(
    `${p.name} — GREEN twin is clean`,
    green.ids.length === 0,
    `${p.green}.md must produce no gating finding; got [${green.ids.join(", ")}]`,
  );
  assert(
    `${p.name} — the two verdicts DIFFER (not a vacuous pair)`,
    key(red.ids) !== key(green.ids),
    `both poles returned ${key(red.ids)} — an identical-verdict pair is VACUOUS ` +
      `(instrument-bipolarity.md MUST-1) and proves nothing about the checker`,
  );
}

// ── The canonical regression, pinned harder than "some finding fired".
{
  const v = verdict("red-omission");
  const om = v.all.filter((f) => f.id === ID.OMISSION);
  assert(
    "canonical regression: the omission names the DELETED register entry by content",
    om.some((f) => /post-mortem/.test(f.sample || "")),
    `the finding must identify \`"post-mortem": 0,\` as the absent line; got ` +
      om.map((f) => f.sample).join(" | "),
  );
  assert(
    "canonical regression: the defective fence is reached by CITATION INHERITANCE",
    om.some((f) => f.inherited === true),
    "the second fence carries no citation of its own; without inheritance the " +
      "locator scores it uncited and skips the defect entirely",
  );
}

// ── The SEVEN-VS-EIGHT regression, pinned harder than "some finding fired".
{
  const v = verdict("red-member-omission");
  assert(
    "control: the RED member-omission document's ENUMERATION is extracted",
    v.enums === 1,
    `expected 1 enumeration in red-member-omission.md, got ${v.enums} — a member ` +
      `assertion over zero enumerations passes vacuously`,
  );
  const mo = v.all.filter((f) => f.id === ID.MEMBER_OMISSION);
  assert(
    "seven-vs-eight: the finding names the MISSING verdict kind by content",
    mo.some((f) => /env-abort/.test(f.sample || "")),
    `the finding must identify \`env-abort\` as the absent member; got ` +
      mo.map((f) => f.sample).join(" | "),
  );
  assert(
    "seven-vs-eight: the finding reports the ACTUAL member counts, not a bare verdict",
    mo.some((f) => /defines 8 member/.test(f.detail || "") && /shows 7/.test(f.detail || "")),
    `the finding must state 8-defined vs 7-shown so a reader can act without ` +
      `re-deriving it; got ${mo.map((f) => f.detail).join(" | ")}`,
  );
  // The line-level identity MUST NOT fire here. A missing LINE and a missing
  // MEMBER are different defects with different fixes, and collapsing them
  // would tell the reader to go looking for the wrong thing.
  assert(
    "seven-vs-eight: it reds as a MEMBER omission, not as a line-level one",
    !v.ids.includes(ID.OMISSION) && !v.ids.includes(ID.FABRICATED),
    `the table is not a reproduced line region; got [${v.ids.join(", ")}]`,
  );
}

// ── SECTION ANCHORS, pinned by IDENTITY: which site, which anchor, which scope.
{
  const fenceOf = (pole) => {
    const lines = fs.readFileSync(path.join(HERE, `${pole}.md`), "utf8").split("\n");
    const open = lines.findIndex((l) => /^```/.test(l));
    const close = lines.findIndex((l, i) => i > open && /^```\s*$/.test(l));
    return { line: open + 1, body: lines.slice(open + 1, close) };
  };

  const g = verdict("green-section-anchor");
  assert(
    "section anchor: the GREEN pole is COMPARED, scoped to the named heading",
    g.volume.comparisons === 1 &&
      g.compared.some((c) => c.scope === "heading" && /§ "2\. Beta rules"/.test(c.cite)),
    `expected one comparison scoped to § "2. Beta rules"; got comparisons=` +
      `${g.volume.comparisons}, compared=${JSON.stringify(g.compared.map((c) => [c.line, c.scope, c.cite]))}`,
  );

  const redFence = fenceOf("red-section-anchor");
  const r = verdict("red-section-anchor");
  assert(
    "section anchor: the RED finding names the SITE and the anchor",
    r.all.some(
      (f) =>
        f.id === ID.FABRICATED &&
        f.relPath === "red-section-anchor.md" &&
        f.line === redFence.line &&
        /§ "2\. Beta rules"/.test(f.cite),
    ),
    `expected ${ID.FABRICATED} at red-section-anchor.md:${redFence.line} citing § "2. Beta rules"; got ` +
      JSON.stringify(r.all.map((f) => [f.id, f.line, f.cite])),
  );
  // CONTROL: the RED block is verbatim in the cited FILE, so the red above is
  // the section scoping — a whole-file comparator would have passed it.
  const whole = compareLineBlock({
    blockLines: redFence.body,
    sourceLines: fs.readFileSync(path.join(HERE, "sources", "sectioned.md"), "utf8").split("\n"),
  });
  assert(
    "section anchor: control — the RED block passes against the WHOLE file",
    whole.findings.length === 0 && whole.matched === redFence.body.length,
    `whole-file comparison should be clean; got ${JSON.stringify(whole.findings.map((f) => f.id))}, ` +
      `matched ${whole.matched}/${redFence.body.length}`,
  );

  const miss = verdict("red-section-missing");
  const missFence = fenceOf("red-section-missing");
  assert(
    "unresolved anchor: the finding names the site and the missing heading, and nothing is compared",
    miss.all.some(
      (f) => f.id === ID.SECTION_UNRESOLVED && f.line === missFence.line && /3\. Gamma rules/.test(f.sample || ""),
    ) && miss.volume.comparisons === 0,
    `got ${JSON.stringify(miss.all.map((f) => [f.id, f.line, f.sample]))}, comparisons=${miss.volume.comparisons}`,
  );

  const dup = verdict("red-section-duplicate");
  assert(
    "ambiguous anchor: the finding names BOTH candidate sections, and nothing is compared",
    dup.all.some((f) => f.id === ID.SECTION_AMBIGUOUS && /lines \d+, \d+/.test(f.detail || "")) &&
      dup.volume.comparisons === 0,
    `got ${JSON.stringify(dup.all.map((f) => [f.id, f.detail]))}, comparisons=${dup.volume.comparisons}`,
  );

  const forms = verdict("green-anchor-forms");
  assert(
    "anchor forms: all four blocks are COMPARED and clean",
    forms.ids.length === 0 && forms.volume.comparisons === 4,
    `expected 4 clean comparisons; got ids=[${forms.ids.join(",")}], comparisons=${forms.volume.comparisons}, ` +
      `coverage=[${forms.coverage.map((c) => c.reason).join(",")}]`,
  );
  const weak = verdict("green-weak-anchor-fence");
  const strong = verdict("red-strong-anchor-fence");
  assert(
    "weak anchors: both fences are LOCATED, compared NONE, and each is declared unanchored coverage",
    weak.blocks === 2 &&
      weak.volume.comparisons === 0 &&
      weak.coverage.filter((c) => c.reason === "unanchored-citation").length === 2,
    `blocks=${weak.blocks} comparisons=${weak.volume.comparisons} coverage=[${weak.coverage.map((c) => c.reason).join(",")}]`,
  );
  const trailerGreen = verdict("green-trailer-elision");
  assert(
    "trailer elision: the GREEN pole IS compared — its pass is the declaration, not a skip",
    trailerGreen.volume.comparisons === 1 && trailerGreen.compared.some((c) => /severity-rank\.js:17-23/.test(c.cite)),
    `comparisons=${trailerGreen.volume.comparisons} compared=${JSON.stringify(trailerGreen.compared.map((c) => c.cite))}`,
  );
  assert(
    "weak anchors: the STRONG-anchor twin compares both fences",
    strong.blocks === 2 && strong.volume.comparisons === 2,
    `blocks=${strong.blocks} comparisons=${strong.volume.comparisons}`,
  );

  for (const [scope, re, why] of [
    ["heading", /§ "1\. Alpha\s+rules"/, "a quoted heading hard-wrapped across a line break"],
    ["banner", /header § "WHY THIS EXISTS"/, "a code-header banner"],
    ["file", /\.\/sources\/severity-rank\.js::SEVERITY_RANK/, "a dot-rooted ::Symbol"],
    ["clause", /MUST-2/, "a MUST-N rule clause"],
  ]) {
    assert(
      `anchor forms: ${why} is resolved and compared (scope ${scope})`,
      forms.compared.some((c) => c.scope === scope && re.test(c.cite)),
      `compared=${JSON.stringify(forms.compared.map((c) => [c.line, c.scope, c.cite]))}`,
    );
  }
}

// ── NO-FALSE-POSITIVE poles. These decide whether the gate survives.
{
  const v = verdict("green-enumeration-not-claiming");
  assert(
    "non-claiming enumerations: none of the five is flagged",
    v.ids.length === 0,
    `a deliberate subset, a hedged list, an undeterminable set, an uncited table ` +
      `and a teaching list must never red; got [${v.ids.join(", ")}]`,
  );
  assert(
    "non-claiming enumerations: all five are genuinely PRESENT in the pole",
    v.enums === 5,
    `the clean verdict above is vacuous unless the enumerations exist; extracted ${v.enums}`,
  );
  // Each refusal REASON is pinned by name. Without this the pole could pass
  // because the enumerations were dropped for some unrelated reason — a clean
  // verdict is only evidence if it is clean for the reason claimed.
  const reasons = new Set(v.coverage.map((c) => c.reason));
  for (const [reason, why] of [
    ["enumeration-partial-subset", "a deliberate 3-of-8 must be refused on the STRUCTURAL ratio"],
    ["declared-partial-enumeration", "a hedged 7-of-8 must be forgiven for its DECLARED hedge"],
    ["enumeration-not-extractable", "members in no source structure must be refused, not guessed"],
  ]) {
    assert(
      `non-claiming enumerations: ${reason} is DECLARED as coverage`,
      reasons.has(reason),
      `${why}; coverage reasons were [${[...reasons].join(", ")}]`,
    );
  }
  // The two silently-dropped classes are dropped, not coverage-reported: an
  // uncited enumeration and a teaching one never claimed to reproduce anything.
  // The uncited and teaching enumerations are dropped SILENTLY — they never
  // claimed to reproduce anything. Counted at the ENUMERATION level: the
  // file-level `file-not-compared` row is a separate contract (this pole
  // compares nothing, so it correctly earns that row too) and is excluded here
  // rather than allowed to inflate the count.
  const enumLevel = v.coverage.filter((c) => !/^file-/.test(c.reason));
  assert(
    "non-claiming enumerations: the uncited + teaching classes are dropped SILENTLY",
    enumLevel.length === 3,
    `exactly the three comparable-but-refused classes belong in enumeration-level ` +
      `coverage; got ${enumLevel.length} rows [${enumLevel.map((c) => c.reason).join(", ")}]`,
  );
  assert(
    "non-claiming enumerations: the file itself is ALSO labelled as compared-nothing",
    v.coverage.some((c) => c.reason === "file-not-compared") && v.volume.comparisons === 0,
    `this pole refuses every enumeration, so its clean verdict is about nothing and ` +
      `the file-level row must say so; comparisons=${v.volume.comparisons}, reasons=` +
      `[${v.coverage.map((c) => c.reason).join(", ")}]`,
  );
}

{
  const v = verdict("green-declared-elision");
  assert(
    "declared elision: an ANNOUNCED omission is a PASS",
    v.ids.length === 0,
    `a declared elision must not red; got [${v.ids.join(", ")}]`,
  );
  // Without this, the pole above could pass because the block is absent rather
  // than because the checker correctly forgave it. The clean verdict is only
  // evidence if the thing it is clean ABOUT is actually there.
  const text = fs.readFileSync(path.join(HERE, "green-declared-elision.md"), "utf8");
  assert(
    "declared elision: the pole genuinely OMITS the entry and genuinely marks it",
    !text.includes('"post-mortem": 0,') && /^\s*\.\.\.\s*$/m.test(text),
    "the pole must drop the same line the RED pole drops AND carry the marker; " +
      "otherwise the clean verdict is vacuous",
  );
}

{
  const v = verdict("green-illustrative");
  assert(
    "illustrative blocks: none of the seven is flagged",
    v.ids.length === 0,
    `illustrative/teaching/output/schema/annotated/unanchored/ambiguous blocks ` +
      `must never red; got [${v.ids.join(", ")}]`,
  );
  assert(
    "illustrative blocks: all seven are genuinely PRESENT in the pole",
    v.blocks === 7,
    `the clean verdict above is vacuous unless the blocks exist; extracted ${v.blocks}`,
  );
  // The two classes that are REPORTED as coverage rather than silently dropped
  // must actually be reported — a silent skip and a declared skip look the same
  // in a pass/fail tally and are opposite in meaning.
  const reasons = new Set(v.coverage.map((c) => c.reason));
  assert(
    "illustrative blocks: the weak-attribution classes are DECLARED as coverage, not silently dropped",
    reasons.has("unanchored-citation") && reasons.has("ambiguous-citation"),
    `expected unanchored-citation and ambiguous-citation in coverage; got ${[...reasons].join(", ")}`,
  );
}

// ── COMPARISON VOLUME. The pole pair for the vacuous-green class: a file the
// gate EXAMINED versus a file it merely SCANNED. On the finding axis the two are
// identical — both report zero — which is precisely the failure, so the poles are
// asserted on VOLUME and on the coverage LABEL, never on findings.
{
  const examined = verdict("green-omission");
  const unexamined = verdict("green-nothing-compared");

  assert(
    "volume: both poles report ZERO findings — this is the trap, not the test",
    examined.ids.length === 0 && unexamined.ids.length === 0,
    `the pair is only meaningful while both are finding-clean; got ` +
      `[${examined.ids.join(",")}] and [${unexamined.ids.join(",")}]`,
  );
  assert(
    "volume: the EXAMINED pole genuinely compared its blocks",
    examined.volume.comparisons > 0 && examined.volume.blocks_compared === examined.blocks,
    `green-omission.md must compare every block it locates; located ` +
      `${examined.blocks}, compared ${examined.volume.blocks_compared}`,
  );
  assert(
    "volume: the UNEXAMINED pole genuinely LOCATED blocks and compared NONE",
    unexamined.volume.blocks_located > 0 && unexamined.volume.comparisons === 0,
    `green-nothing-compared.md must locate blocks and compare none — otherwise the ` +
      `pole is vacuous; located ${unexamined.volume.blocks_located}, compared ` +
      `${unexamined.volume.comparisons}`,
  );
  assert(
    "volume: the UNEXAMINED pole says so, and is not silent",
    unexamined.coverage.some((c) => c.reason === "file-not-compared"),
    `a file whose clean verdict is about NOTHING must emit file-not-compared; got ` +
      `[${unexamined.coverage.map((c) => c.reason).join(", ")}]`,
  );
  assert(
    "volume: the EXAMINED pole does NOT carry the not-compared label",
    !examined.coverage.some((c) => /^file-(not-compared|has-no-quoted-content)$/.test(c.reason)),
    `a genuinely examined file must not be labelled unexamined; got ` +
      `[${examined.coverage.map((c) => c.reason).join(", ")}]`,
  );
  assert(
    "volume: the two poles are DISTINGUISHABLE (not a vacuous pair)",
    key(examined.coverage.map((c) => c.reason)) !== key(unexamined.coverage.map((c) => c.reason)),
    `both poles produced the same coverage labels — a consumer could not tell an ` +
      `examined file from a scanned one, which is the whole defect`,
  );
}

// ── The corpus floor's own declaration must exist and be usable. A floor that
// silently fails to load enforces nothing, and the run would exit 0 having
// compared anything at all — including nothing.
{
  const floor = loadCorpusFloor();
  assert(
    "corpus floor: the declaration loads and carries both declared minima",
    floor && Number.isInteger(floor.min_comparisons) && Number.isInteger(floor.min_files_examined),
    "loadCorpusFloor() returned no usable declaration — the whole-run anti-vacuity " +
      "floor would be silently unenforced",
  );
}

// ── The shipped negative control, re-run here so the fixture step exercises it
// too. Its pole pairs run over synthetic input with no filesystem, so they
// cannot be disarmed by a change to these files.
if (!selfTest()) no("shipped --self-test pole pairs", "see failures above");
else ok("shipped --self-test pole pairs pass");

process.stdout.write(`\nquoted-content fixtures: ${pass} pass, ${fail} fail\n`);
if (fail === 0) process.stdout.write("ALL PASS\n");
process.exit(fail === 0 ? 0 : 1);
