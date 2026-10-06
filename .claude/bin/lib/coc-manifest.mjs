#!/usr/bin/env node
/*
 * coc-manifest.mjs — shared manifest-loader + artifact-compose primitives.
 *
 * W0 of the coc-universal workstream (decisions/00 D1-D4; wave-plan W0).
 * Extracts the neutral manifest-reading + variant-compose layer that BOTH
 * emit-cli-artifacts.mjs (per-CLI tree producer) AND emit-coc.mjs (unified
 * `.coc/` producer) depend on, so emit-coc no longer imports from
 * emit-cli-artifacts. This unblocks retiring per-CLI emission (wave W5)
 * without breaking the `.coc/` producer (01-analysis/00 §3 sequencing risk
 * #2). The functions below are moved VERBATIM from emit-cli-artifacts.mjs
 * (same behavior, byte-identical emit) — only the file location + the
 * sibling import paths (`./lib/X` → `./X`) and REPO's depth changed.
 *
 * Symbols (24): REPO, safeWriteFileSync, ensureTrailingNewline,
 *   writeTextArtifactSync, safeReadFileSync, globToRegex,
 *   matchesAnyGlob, loadExclusions, loadLoomOnly, loadFlatList,
 *   loadUniversalExclude, loadLaneExclusions, loadVariantOnly, loadTiers,
 *   loadTargetTierSubscriptions, loadTargetVariant, buildTierFilter,
 *   composeArtifactBody, rewriteClaudePathsForCli, walkFiles,
 *   loadSurfaceRoles, loadTargetRole, surfaceRolesAllow, deliveryVerdict.
 *
 * The count is produced STRUCTURALLY — `Object.keys(await import(...)).length`,
 * imported in place so the `./slot-parser.mjs` sibling resolves. A grep or a
 * hand-count is not the instrument: this header read 14 against an actual 17
 * before loom#1684 touched it, and 16 against 19 after, because the three
 * surface-role symbols were never listed. Re-measure; do not increment.
 *
 * Node ESM, zero external deps (mirrors emit.mjs / emit-cli-artifacts.mjs).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyOverlay } from "./slot-parser.mjs";
import { resolveOverlay } from "./variant-overlay.mjs";
import { stripBuildInternalReferences } from "./strip-build-internal.mjs";
// loom#1386 — this module is ALWAYS_INCLUDE (shipped verbatim to every repo
// class), and on the three classes that FORBID sync-manifest.yaml each of the
// seven manifest reads below threw ENOENT. `readManifestSource` is the ONE
// class-aware discriminator: `null` ⇔ the manifest is EXPECTED-absent; a LOUD
// throw covers absent-at-loom AND present-but-unreadable (never conflated —
// zero-tolerance.md Rule 3). See lib/manifest-source.mjs for the D1/D2/D3
// disposition contract each call site below cites.
import {
  readManifestSource,
  readCliEmitProjection,
  requireManifestSource,
  requireManifestSourceForTarget,
} from "./manifest-source.mjs";

// REPO = repo root. This module lives at `.claude/bin/lib/`, i.e. THREE
// levels below the root (lib → bin → .claude → root), so REPO resolves
// `..` THREE times — one deeper than emit-cli-artifacts.mjs / emit.mjs
// (which live at `.claude/bin/`, two levels, two `..`). Do NOT "simplify"
// to two `..`: that resolves to `.claude/` and every manifest read below
// (loadExclusions / loadTiers / composeArtifactBody) reads the wrong path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..");

// ────────────────────────────────────────────────────────────────
// Symlink-safe write (mirrors emit.mjs to keep TOCTOU closed)
// ────────────────────────────────────────────────────────────────
function safeWriteFileSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_TRUNC |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

// ────────────────────────────────────────────────────────────────
// Text-artifact terminator contract (loom#1684)
// ────────────────────────────────────────────────────────────────
// EVERY text artifact an emitter writes ends with EXACTLY ONE LF.
//
// The BUILD-py target runs pre-commit's `end-of-file-fixer`, and the Gate-2
// driver commits INTO that target — so the hook rewrites loom's emitted bytes
// and ABORTS the commit, blocking the whole BUILD-py distribution lane. The
// contract is two-sided because that hook is two-sided: it APPENDS a missing
// terminator AND STRIPS extra ones. A one-sided "append if absent" fix leaves
// the too-many case (the actual #1684 offender) unrepaired, and a `tail -c1`
// sweep cannot even see it.
//
// Three cases, matching `end_of_file_fixer.fix_file` **for CR-free input** —
// which is the whole of what these emitters produce (see the scope note below):
//   ""            → ""      zero-byte stays zero-byte (the `.gitkeep` sentinel
//                           emit-coc pins to EMPTY_SHA256; the hook's seek(-1)
//                           raises on an empty file and it returns unchanged)
//   "\n\n"        → ""      an all-newline file is truncated to empty
//   "a" / "a\n\n" → "a\n"   everything else gets exactly one
//
// SCOPE — the equivalence is NOT unconditional, and the earlier revision of this
// comment said "exactly" without qualification. That was an over-claim; it is
// withdrawn. Corrected by EXECUTING the real hook (`fix_file` from the
// pre-commit-hooks checkout under `~/.cache/pre-commit`), not by inference:
//
//   input        eof-fixer    this helper    agree?
//   "a"          "a\n"        "a\n"          yes
//   "a\n"        "a\n"        "a\n"          yes
//   "a\n\n"      "a\n"        "a\n"          yes
//   ""           ""           ""             yes
//   "\n\n"       ""           ""             yes
//   "a\r\n"      "a\r\n"      "a\r\n"        yes
//   "a\r\n\r\n"  "a\r\n"      "a\r\n\r\n"    NO — hook truncates, we no-op
//   "a\r\r"      "a\r"        "a\r\r\n"      NO — hook truncates, we append
//   "a\r\r\n"    "a\r"        "a\r\r\n"      NO — hook truncates, we no-op
//
// The hook treats `\r` as a line break (`last_character not in {b'\n', b'\r'}`);
// this regex is `/\n+$/`, LF-only. Every divergence therefore requires a CR in
// the input, and each one would recreate the #1684 abort.
//
// Why the residual is nonetheless CLOSED rather than merely accepted: CR is
// structurally excluded from emitted output, and that exclusion is now ENFORCED,
// not assumed. `emitter-trailing-newline.test.mjs` asserts every emitted text
// artifact across all three emitters is CR-free (measured at that suite's
// landing: 1160 files, 0 CR-bearing, with a planted-CR control confirming the
// scanner fires). So no input reaching this helper can hit a divergent row.
// Deliberately NOT "fixed" by stripping CR here: that would mutate content on a
// path no emitter exercises, trading a structurally-unreachable divergence for a
// live behavioural change.
function ensureTrailingNewline(text) {
  const body = text.replace(/\n+$/, "");
  return body === "" ? "" : `${body}\n`;
}

// The ONE write path for emitted TEXT artifacts. `safeWriteFileSync` stays a
// pure security primitive (O_NOFOLLOW, no content transform); this wrapper owns
// the terminator contract so it cannot drift across the ~13 emitter write sites.
// Binary/Buffer payloads (the byte-copy fallback) keep using safeWriteFileSync
// directly — a byte copy must stay byte-exact.
function writeTextArtifactSync(filePath, text) {
  safeWriteFileSync(filePath, ensureTrailingNewline(text));
}

// Symlink-safe read (mirrors safeWriteFileSync to keep the source side
// TOCTOU-closed). O_NOFOLLOW raises ELOOP if the leaf component is a
// symlink — so a symlink swapped in for an artifact source between the
// existsSync probe and the read raises instead of silently reading the
// attacker's target. Guards the leaf only (same caveat as the write
// side); loom's .claude artifact tree carries zero symlinks (#569).
function safeReadFileSync(filePath, encoding) {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    return fs.readFileSync(fd, encoding);
  } finally {
    fs.closeSync(fd);
  }
}

// ────────────────────────────────────────────────────────────────
// Glob matcher (subset: ** and * against POSIX paths)
// ────────────────────────────────────────────────────────────────
// Matches patterns like:
//   skills/30-claude-code-patterns/**   → prefix match
//   agents/cc-architect.md              → exact match
//   commands/cc-audit.md                → exact match
//   guides/claude-code/**               → prefix match
// BRACES AND A LEADING `./` (2026-09-25). Claude Code's path matcher expands
// `{a,b}` sets and reads `./x` as `x`. This matcher used to ESCAPE `{}`, so a
// brace glob matched NOTHING: a 20,000 B rule declaring
// `**/*.{md,mjs,js,json,yaml,py,rs,ts}` loaded in practically every session and
// was charged to none, and never entered the ledger. Sets expand innermost-first
// (nesting works); a group with no top-level comma (`{x}`) stays literal, as in a
// shell. Kept byte-identical between coc-manifest.mjs and
// check-rule-injection-budget.mjs, and pinned by that tool's mirror-parity test.
function expandBraces(glob) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((alt) => expandBraces(head + alt + tail));
}

// `?` is ONE non-`/` character (2026-09-25), as in Claude Code's matcher. It
// was escaped to a literal, so `**/?*` matched no real path and a rule using it
// charged nothing. Measured: no emitted-artifact or manifest glob changes
// verdict (emit-cli-artifacts --out diffs clean against the parent).
function globBody(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return escaped
    .replace(/\?/g, "__ONECHAR__")
    .replace(/(^|\/)\*\*\//g, "$1__ANYSEGS__")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*")
    .replace(/__ANYSEGS__/g, "(?:.*/)?")
    .replace(/__ONECHAR__/g, "[^/]");
}

function globSource(glob) {
  const bodies = expandBraces(glob.replace(/^\.\//, "")).map(globBody);
  return bodies.length === 1 ? `^${bodies[0]}$` : `^(?:${bodies.join("|")})$`;
}

function globToRegex(glob) {
  // Escape regex metacharacters, then re-expand glob tokens. `?` is one non-`/`
  // character (never a regex 0-or-1 quantifier) — see globBody().
  // A `**/` at the START of the pattern OR immediately after a `/` matches ZERO
  // or more path segments, so it compiles to `(?:.*/)?` — which keeps the `/`
  // boundary (a bare `.*` would substring-match `yx` for `**/x`). Measured
  // against Claude Code 2.1.226: the LEADING case 2/2 (loom#1597), the INTERIOR
  // case 2/2 on three glob shapes (S21-GLOB-INTERIOR.md). Both positions are
  // zero-or-more in CC; treating the interior as >=1 silently defeated 12 corpus
  // globs' stated intent. Brace sets and a leading `./`: see expandBraces().
  return new RegExp(globSource(glob));
}

function matchesAnyGlob(relPath, globs) {
  for (const g of globs) {
    if (globToRegex(g).test(relPath)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → cli_emit_exclusions
// ────────────────────────────────────────────────────────────────
// Minimal YAML reader scoped to the exclusions stanza. We don't pull in
// a YAML library — the structure here is simple enough (two lists of
// strings) that line-oriented parsing is safe. Falls back to empty
// arrays if the stanza is missing so the emitter never silently does
// the wrong thing (exclusions absent → emit everything → caller sees
// unexpected files and investigates).
function loadExclusions() {
  // F95 — the loom#1386 D1 disposition for THIS stanza was WRONG, and the
  // correction is measured, not argued. D1 reasoned "a repo whose class FORBIDS
  // the manifest distributes NOTHING, so no-exclusions is the TRUE answer".
  // That holds for `loom_only` (a fan-out list) and for `surface_roles` (whose
  // consumer short-circuits), but NOT here: a multi-CLI USE template runs the
  // project-local `emit-cli-artifacts.mjs` FOR ITSELF at /migrate time, so an
  // empty exclusion list does not mean "withhold nothing from nobody" — it means
  // EMIT EVERYTHING to `.codex/**` and `.gemini/**`, including the artifacts
  // loom explicitly declared withheld.
  //
  // Measured on a fixture built from `sync-tier-aware.mjs --dry-run --json`'s own
  // delivered file set for `kailash-coc-py` (2695 files, VERSION::type
  // coc-use-template): the delivered emitter produced 406 artifacts with the
  // declarations readable and 473 without — 67 one-directional over-emissions
  // (`skills/co-reference/**`, `skills/30-claude-code-patterns/**`, `cost-audit`,
  // `.gemini/agents/cc-architect.md`). Control first: injecting
  // `agents/analysis/analyst.md` into both exclusion lists moved exactly the two
  // expected paths, so the empty-diff verdict was available and this instrument
  // discriminates here.
  //
  // So the read order is manifest FIRST (loom itself, and any owner-class repo),
  // then the F95 PROJECTION (`.claude/.coc-cli-emit.yaml`) that loom writes to an
  // elected multi-CLI template. Empty stays the answer ONLY when neither exists —
  // a template that was never elected runs no per-CLI emitter, so it has nothing
  // to over-emit.
  const src = readManifestSource(REPO) ?? readCliEmitProjection(REPO);
  if (src == null) return { codex: [], gemini: [] };
  const lines = src.split("\n");

  const result = { codex: [], gemini: [] };
  let inStanza = false;
  let currentCli = null;

  for (const line of lines) {
    if (/^cli_emit_exclusions:\s*$/.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with :)
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // CLI key (2-space indent)
    const cliMatch = line.match(/^ {2}([a-z]+):\s*$/);
    if (cliMatch) {
      currentCli = cliMatch[1];
      if (!(currentCli in result)) result[currentCli] = [];
      continue;
    }

    // List entry (4-space indent, leading dash)
    const entryMatch = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (entryMatch && currentCli) {
      // Strip surrounding quotes, THEN inline ` # ...` comments — matching
      // loadTiers/loadLoomOnly. Closes a latent footgun (W4 redteam R-LOW): the
      // prior asymmetry meant an inline comment on a cli_emit_exclusions entry
      // would corrupt the glob, so rationale had to live on full comment lines
      // only. Behavior-preserving for current data (no entry carries a ` #`).
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result[currentCli].push(cleaned);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → loom_only (top-level FLAT glob list)
// ────────────────────────────────────────────────────────────────
// F104 — loom-only artifacts are a POSITIVE never-sync declaration.
// A source path matching any glob here is skipped for EVERY target
// (cc/codex/gemini × every lang), BEFORE tier classification. Same flat
// list shape as `obsoleted:` / `exclude:`: a top-level key whose body is a
// list of `- <glob>` entries (NO nested CLI sub-keys). Bare source-relative
// globs (`agents/management/coc-sync.md`) matched against the manifest-
// relative path the emit functions build (`agents/...`).
function loadLoomOnly() {
  // D1 DISTRIBUTION-DECLARATION (loom#1386). `loom_only` is a POSITIVE
  // never-sync list — artifacts loom keeps for itself. A consumer holds no such
  // list because it fans nothing out; the empty set is exact, and it is what the
  // stanza-absent path below already returns.
  return loadFlatList("loom_only");
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → exclude (top-level FLAT glob list, UNIVERSAL)
// ────────────────────────────────────────────────────────────────
// The lane-AGNOSTIC never-distribute fence `sync-tier-aware.mjs::classifyFile`
// applies at step 3, BEFORE always-include and before the class-exclude at step
// 4. Distinct from `loadExclusions()` (which reads `cli_emit_exclusions`, the
// PER-CLI axis) — the names are close and the axes are not: this one is CLI-
// blind and feeds `deliveryVerdict`; that one is applied inside each emitter's
// per-CLI branch.
//
// Entries are `.claude/`-RELATIVE globs (`commands/repos.md`, `learning/**`),
// the same space the emitters build their `manifestRel` in, so they are used as
// declared. `normalizeFateEntry` is deliberately NOT applied: it exists to
// reconcile the repo-ROOT-relative purge lists, and no `exclude:` entry uses
// that convention.
function loadUniversalExclude() {
  return loadFlatList("exclude");
}

// Read a top-level FLAT list stanza (`<key>:` followed by `  - <entry>` lines).
// The shape `loom_only:` / `exclude:` / `use_exclude:` / `obsoleted:` and their
// lane siblings all share. Returns [] when the manifest is EXPECTED-absent
// (D1 DISTRIBUTION-DECLARATION, loom#1386) or the stanza is missing.
function loadFlatList(key) {
  const src = readManifestSource(REPO);
  if (src === null) return [];
  const lines = src.split("\n");

  const result = [];
  let inStanza = false;
  const head = new RegExp(`^${key}:\\s*$`);

  for (const line of lines) {
    if (head.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with `:`).
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // List entry (2-space indent, leading dash). Strip inline comments.
    const entryMatch = line.match(/^ {2}-\s*(.+?)\s*$/);
    if (entryMatch) {
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result.push(cleaned);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → per-LANE distribution-fate exclusions
// ────────────────────────────────────────────────────────────────
// `loom_only` is lane-AGNOSTIC (never leaves loom). The manifest ALSO carries
// two LANE-SCOPED axes that an emitter writing into a distributed tree MUST
// honour, exactly as `sync-tier-aware.mjs` does for the `.claude/` tree:
//
//   USE lane   → `use_exclude`   (class exclude; classifyFile step 4)
//              ∪ `obsoleted` ∪ `use_obsoleted`     (buildPlan purgeList)
//   BUILD lane → `build_exclude` (class exclude; classifyFile step 4)
//              ∪ `obsoleted` ∪ `build_obsoleted`   (buildPlan purgeList)
//
// The class-exclude half answers "never SHIP this here"; the purge half answers
// "actively DELETE this here". Both are composed, because an artifact the
// distributor deletes from a target must not be handed straight back by a
// derived-tree emitter writing into that same target.
//
// The two halves use DIFFERENT path conventions (documented at the manifest's
// `build_obsoleted:` header): class-exclude entries are `.claude/`-RELATIVE
// globs; purge entries are repo-ROOT-relative and carry the `.claude/` prefix,
// and a directory entry ends in `/`. `normalizeFateEntry` reconciles both onto
// the manifest-relative glob space the emitters match against — the SAME
// `.claude/`-prefix normalization `emit.mjs::_collectDeclaredArtifactPatterns`
// applies, plus a trailing-`/` → `/**` expansion so a dir entry matches its
// descendants under `globToRegex` (which anchors with `$`, so a bare
// `test-harness/` would match nothing at all).
//
// `lane: "all"` returns [] — the NO-LANE-FILTER form, for full-corpus callers
// (grammar/parity gates) whose question is about the corpus, not distribution.
const LANE_FATE_BLOCKS = {
  use: { classExclude: "use_exclude", laneObsoleted: "use_obsoleted" },
  build: { classExclude: "build_exclude", laneObsoleted: "build_obsoleted" },
};

function normalizeFateEntry(entry) {
  const stripped = entry.replace(/^\.claude\//, "");
  return stripped.endsWith("/") ? `${stripped}**` : stripped;
}

function loadLaneExclusions(lane) {
  if (lane === "all") return [];
  const blocks = LANE_FATE_BLOCKS[lane];
  if (!blocks) {
    throw new Error(
      `coc-manifest: unknown lane "${lane}" — expected "use", "build", or "all".`,
    );
  }
  const raw = [
    ...loadFlatList(blocks.classExclude),
    ...loadFlatList("obsoleted"),
    ...loadFlatList(blocks.laneObsoleted),
  ];
  return [...new Set(raw.map(normalizeFateEntry))];
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → variant_only.<axis> (ADDITION lane: axis → entry list)
// ────────────────────────────────────────────────────────────────
// Structurally identical to `tiers:` (top-level key → sub-keys → list-of-string),
// so the parsing below is loadTiers' verbatim shape.
//
// D1 DECLARED-EMPTY, not D3. The D1-vs-D3 test in lib/manifest-source.mjs is what
// the EMPTY value DOES downstream, and here it is BENIGN: `variant_only` is the
// ADDITION half of the variant lane, and on a manifest-forbidden class the
// additions have ALREADY been resolved to their `dest` by Gate-2 — a consumer has
// no `variants/` tree left to add from, so "no additions" is literally true there
// rather than a fallback. Contrast `tiers` (D3), whose empty value matches NOTHING
// and would silently compose an emission that drops every artifact.
//
// Returns { <axis>: [entry, ...] } with entries as declared — `.claude/`-relative
// paths like `variants/rs/rules/build-speed.md`.
function loadVariantOnly() {
  const src = readManifestSource(REPO);
  if (src === null) return {};
  const lines = src.split("\n");

  const result = {};
  let inStanza = false;
  let currentAxis = null;

  for (const line of lines) {
    if (/^variant_only:\s*$/.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with :)
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // Axis key (2-space indent)
    const axisMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (axisMatch) {
      currentAxis = axisMatch[1];
      result[currentAxis] = [];
      continue;
    }

    // List entry (4-space indent, leading dash). Skip comments.
    const entryMatch = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (entryMatch && currentAxis) {
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result[currentAxis].push(cleaned);
    }
  }

  return result;
}

// sync-manifest.yaml → tiers.* (top-level tier → glob list)
// ────────────────────────────────────────────────────────────────
// Mirrors loadExclusions: line-oriented parsing, no YAML library. The
// tiers stanza is structurally identical to cli_emit_exclusions (a
// top-level key with sub-keys whose values are list-of-string).
function loadTiers() {
  // D3 REFUSE-LOUDLY (loom#1386, reclassified from D1 by loom#1394's partition
  // audit). Tiers are subscription buckets a SPLITTER offers its targets; on a
  // manifest-forbidden class there are none.
  //
  // Returning `{}` was SAFE, but only as a CALL-GRAPH property: the sole caller
  // `buildTierFilter` returns early when no `--target` is named, and with one it
  // refuses at `loadTargetTierSubscriptions` (D3) first — so the empty map was
  // unreachable. Two problems with resting on that. It is ORDER-DEPENDENT (swap
  // the `loadTargetTierSubscriptions` and `loadTiers` calls in buildTierFilter
  // and `{}` becomes reachable, with nothing enforcing the order), and
  // `loadTiers` is exported here AND re-exported by emit-cli-artifacts.mjs, so
  // "its only caller" is a forward-looking assumption rather than a guarantee —
  // any new caller or out-of-tree script would get `{}` silently.
  //
  // Refusing makes the guarantee structural at zero behavioural cost: the one
  // legitimate reader already sits behind a D3 refusal. An empty tier map is
  // especially dangerous because it matches NOTHING — a caller would compose an
  // emission that drops every artifact while reporting success.
  const src = requireManifestSource("tiers", REPO);
  const lines = src.split("\n");

  const result = {};
  let inStanza = false;
  let currentTier = null;

  for (const line of lines) {
    if (/^tiers:\s*$/.test(line)) {
      inStanza = true;
      continue;
    }
    if (!inStanza) continue;

    // End of stanza: a new top-level key (column 0, ends with :)
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // Tier key (2-space indent)
    const tierMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (tierMatch) {
      currentTier = tierMatch[1];
      result[currentTier] = [];
      continue;
    }

    // List entry (4-space indent, leading dash). Skip comments.
    const entryMatch = line.match(/^ {4}-\s*(.+?)\s*$/);
    if (entryMatch && currentTier) {
      const val = entryMatch[1].replace(/^["']|["']$/g, "");
      // Strip trailing inline comments (` # ...`)
      const cleaned = val.replace(/\s+#.*$/, "").trim();
      if (cleaned) result[currentTier].push(cleaned);
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → repos.<target>.tier_subscriptions
// ────────────────────────────────────────────────────────────────
// Returns the ordered list of tier names the named target subscribes to.
// Inline-list form: `tier_subscriptions: [cc, coc-core, kailash]`.
// Returns null if the target is unknown (caller decides whether to halt).
// Returns empty array [] if the target declares an empty subscription
// (e.g. retired prism — manifest declares [] structurally).
function loadTargetTierSubscriptions(target) {
  // D3 TARGET-RESOLUTION (loom#1386) — REFUSE, never answer. `null` here is
  // already overloaded ("target unknown → caller halts"), so folding
  // "manifest-forbidden class" into it would produce a halt whose message names
  // the wrong defect. A repo that FORBIDS the manifest has no sync targets at
  // all; refusing names that.
  const src = requireManifestSourceForTarget(target, "tier_subscriptions", REPO);
  const lines = src.split("\n");

  let inRepos = false;
  let inTarget = false;

  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;

    // End of repos stanza: new top-level key
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }

    // Target key (2-space indent, e.g. "  py:")
    const targetMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (targetMatch) {
      inTarget = targetMatch[1] === target;
      continue;
    }

    // tier_subscriptions inline list (4-space indent under target)
    if (inTarget) {
      const tsMatch = line.match(/^ {4}tier_subscriptions:\s*\[(.*?)\]\s*$/);
      if (tsMatch) {
        return tsMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → repos.<target>.variant
// ────────────────────────────────────────────────────────────────
// Returns the language-axis variant slug (py / rs / base / null).
// The variant determines which `variants/<lang>/...` overlay tree applies
// when composing per-CLI artifacts (commands, skills, agents) for the
// target's language axis. Returns null when target is unknown OR when
// repos.<target>.variant is absent.
function loadTargetVariant(target) {
  if (!target) return null;
  // D3 TARGET-RESOLUTION (loom#1386) — REFUSE. Answering `null` would read as
  // "target declares no variant" and SILENTLY drop the language overlay axis,
  // emitting a base-composed tree under a language target's name.
  const src = requireManifestSourceForTarget(target, "repos.<target>.variant", REPO);
  const lines = src.split("\n");

  let inRepos = false;
  let inTarget = false;
  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }
    const targetMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (targetMatch) {
      inTarget = targetMatch[1] === target;
      continue;
    }
    if (inTarget) {
      const vMatch = line.match(/^ {4}variant:\s*(.+?)\s*$/);
      if (vMatch) {
        return vMatch[1].replace(/^["']|["']$/g, "");
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → repos.<target>.role  (D3 / W2-b)
// ────────────────────────────────────────────────────────────────
// Returns the per-TARGET role the emit lane reads to select a consumer
// subset (W3-d / the deferred W2-c tail). Mirrors loadTargetVariant's
// line-oriented parse but reads the `role:` scalar. Returns null when the
// target is unknown OR repos.<target>.role is absent (py/rs are
// intentionally unset → full emission, invariant #7 back-compat).
function loadTargetRole(target) {
  if (!target) return null;
  // D3 TARGET-RESOLUTION (loom#1386) — REFUSE. `null` means "role unset →
  // surface EVERYTHING" (invariant #7 back-compat), so answering null on a
  // manifest-forbidden class would fail OPEN: every de-surfaced command would
  // surface for a target whose role could not be read.
  const src = requireManifestSourceForTarget(target, "repos.<target>.role", REPO);
  const lines = src.split("\n");

  let inRepos = false;
  let inTarget = false;
  for (const line of lines) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true;
      continue;
    }
    if (!inRepos) continue;
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      break;
    }
    const targetMatch = line.match(/^ {2}([a-zA-Z_][\w-]*):\s*$/);
    if (targetMatch) {
      inTarget = targetMatch[1] === target;
      continue;
    }
    if (inTarget) {
      const rMatch = line.match(/^ {4}role:\s*(.+?)\s*$/);
      if (rMatch) {
        return rMatch[1].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// sync-manifest.yaml → surface_roles  (D3 / W2-b; consumed W3-d)
// ────────────────────────────────────────────────────────────────
// POSITIVE per-artifact role restriction (mirrors loom_only's positive
// shape, NOT an exclude:-style denylist — emit-cli-artifacts ignores
// exclude:, so a surface restriction expressed as exclusion would silently
// leak, feedback_emit_cli_ignores_exclude / #638). A top-level key whose
// entries are `<manifest-rel-path>: [role, role]`. Returns a map
// { "commands/analyze.md": ["build","use-consumer"], ... }. An artifact
// with NO entry is DEFAULT-SURFACED (surfaces for every role — open
// decision #5). The role vocabulary is the closed set {platform, build,
// use-consumer} (D2); validation is the validate-emit surface-role-
// membership check, NOT this loader (a dumb data endpoint per
// agent-reasoning.md).
function loadSurfaceRoles() {
  // D1 DISTRIBUTION-DECLARATION (loom#1386). `surface_roles` restricts which
  // ROLE an artifact surfaces for at a DESTINATION. Empty is safe by
  // construction here: `surfaceRolesAllow` short-circuits `true` whenever
  // targetRole is null, which it always is on a manifest-forbidden class (its
  // D3 sibling `loadTargetRole` refuses before any role can be resolved). So the
  // empty map is never the thing that decides surfacing — it is the
  // default-surfaced state the stanza-absent path already returns.
  return parseSurfaceRolesStanza(readManifestSource(REPO)).entries;
}

// The same read, with the UNREAD lines returned instead of discarded. A caller
// that must not score a corpus against a partially-read authority (the
// role-blind checkers) reads THIS; `loadSurfaceRoles` above keeps the map-only
// signature the emitters use.
function loadSurfaceRolesDiagnostics() {
  return parseSurfaceRolesStanza(readManifestSource(REPO));
}

// ── the stanza parser, PURE over its source text ────────────────────────────
//
// Split out of `loadSurfaceRoles` so it can be exercised against a synthetic
// manifest. The loaders resolve `REPO` from their own file location and take no
// override, so while the parse lived inline the ONLY way to test a malformed
// stanza was to mutate the live manifest or re-type the function into a
// replica — and a re-typed replica is a second claim about the world, not a
// measurement of this one (`instrument-discipline.md` MUST-6(c)).
//
// TWO CHANGES OF SUBSTANCE, and the second is the load-bearing one:
//
//   (1) It now READS two forms the inline-flow-only matcher silently dropped —
//       a trailing `# comment` after the list, and the BLOCK-SEQUENCE form a
//       YAML formatter emits. The comment case was a pure ASYMMETRY inside this
//       file: the sibling `loadFlatList` above has carried
//       `val.replace(/\s+#.*$/, "")` all along, and this parser did not, so the
//       same comment that is handled one stanza over deleted an entry here.
//
//   (2) Every line inside the stanza that is NOT blank, NOT a comment, and NOT
//       consumed by a recognised form is RETURNED in `unparsed` with its line
//       NUMBER and its TEXT. It is not silently skipped.
//
// Why (2) is a consumed-line RECONCILIATION rather than the obvious
// entry-count compare: a count is defeated by compensating errors — one entry
// dropped while one stray line is miscounted as an entry nets to zero and
// reports agreement. Tracking which lines the parser actually CONSUMED cannot
// net out, and it yields the offending LINE, which is what an author can act
// on. A refusal that says only "expected 19, got 18" sends the reader to diff
// two lists by hand, and a refusal an author cannot act on gets disabled.
//
// The parser does NOT guess at the forms it cannot read. A bare scalar
// (`key: build`), a 4-space-indented entry, an anchor/alias, and a nested
// mapping are each REPORTED, never coerced: inferring a one-element list from
// `key: build` would be this function deciding what the operator meant, and the
// whole failure being fixed here is a parser quietly deciding something.
function parseSurfaceRolesStanza(src) {
  if (src === null || src === undefined) return { entries: {}, unparsed: [] };
  const lines = src.split("\n");

  const entries = {};
  const unparsed = [];
  const unquote = (s) => s.replace(/^["']|["']$/g, "");

  let inStanza = false;
  // A key that opened a block sequence and is still collecting its `- role`
  // items. Held across iterations, flushed when anything else arrives.
  let pending = null;

  const flushPending = () => {
    if (!pending) return;
    if (pending.roles.length > 0) entries[pending.key] = pending.roles;
    else
      unparsed.push({
        lineNo: pending.lineNo,
        line: pending.line,
        reason: "opens a block but no `    - <role>` items follow it",
      });
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (!inStanza) {
      if (/^surface_roles:\s*$/.test(line)) inStanza = true;
      continue;
    }

    // End of stanza: a new top-level key (column 0, ends with `:`).
    if (/^[a-zA-Z_][^:]*:\s*$/.test(line) && !line.startsWith(" ")) {
      flushPending();
      break;
    }

    if (/^\s*$/.test(line)) continue; // blank
    if (/^\s*#/.test(line)) continue; // whole-line comment

    // Block-sequence item, but ONLY while a key is open to receive it. A
    // dangling `- x` under no key falls through to `unparsed` below.
    const seq = line.match(/^ {3,}-\s*(.+?)\s*$/);
    if (seq && pending) {
      const v = unquote(seq[1].replace(/\s+#.*$/, "").trim());
      if (v) pending.roles.push(v);
      continue;
    }

    flushPending();

    // Inline flow entry: `  path: [role, role]`, trailing comment tolerated.
    const inline = line.match(/^ {2}(\S+):\s*\[(.*?)\]\s*(?:#.*)?$/);
    if (inline) {
      const key = unquote(inline[1]);
      const roles = inline[2]
        .split(",")
        .map((r) => unquote(r.trim()))
        .filter(Boolean);
      if (key) entries[key] = roles;
      else unparsed.push({ lineNo, line, reason: "entry has an empty key" });
      continue;
    }

    // Key opening a block sequence: `  path:` and nothing but a comment after.
    const blockHead = line.match(/^ {2}(\S+):\s*(?:#.*)?$/);
    if (blockHead) {
      pending = { key: unquote(blockHead[1]), roles: [], lineNo, line };
      continue;
    }

    unparsed.push({
      lineNo,
      line,
      reason:
        "not a recognised entry — expected `  <path>: [role, role]` or " +
        "`  <path>:` followed by `    - <role>` items",
    });
  }

  flushPending(); // stanza ran to EOF with a block still open

  return { entries, unparsed };
}

// surfaceRolesAllow — TRUE if an artifact at `manifestRel` surfaces for
// `targetRole`. Default-surfaced (no entry) → always true. A null
// targetRole (no --target, or a target with no declared role — py/rs)
// → always true (back-compat full emission). Otherwise true IFF the
// artifact's declared role list INCLUDES targetRole.
function surfaceRolesAllow(surfaceRoles, manifestRel, targetRole) {
  if (!targetRole) return true; // no role to filter on → keep (back-compat)
  const declared = surfaceRoles && surfaceRoles[manifestRel];
  if (!declared) return true; // default-surfaced (no restriction)
  return declared.includes(targetRole);
}

// ────────────────────────────────────────────────────────────────
// deliveryVerdict — the CLI-BLIND delivery PREFIX for CLI-tree emission (F92).
//
// NOT "the delivery oracle": it is the prefix of the chain that every CLI
// shares, and it is deliberately PARTIAL. Per-CLI `cli_emit_exclusions` and the
// per-emitter structural exclusion sets (CODEX_AGENT_STRUCTURAL_EXCLUSIONS /
// GEMINI_AGENT_STRUCTURAL_EXCLUSIONS) are applied by each emitter AFTER this
// predicate returns `delivered: true`, so a `delivered` verdict means "not
// fenced by any CLI-BLIND axis", NEVER "this file will be written". A caller
// reading it as total will over-report the delivered surface. The earlier
// "THE delivery oracle" framing asserted a totality the code does not deliver
// (`instrument-bipolarity.md` MUST-4); the symbol name is kept — it is accurate
// for what the function returns given its inputs, and the over-claim lived in
// this prose, not in the identifier.
//
// ONE predicate answering "does `manifestRel` reach THIS target?", so the
// per-emitter copies stop drifting. Before F92 `emit-cli-artifacts.mjs` held
// FIVE independent copies of this chain (emitCommands, emitSkills,
// buildRulesReferenceIndex, emitCodexAgentPrompts, emitGeminiAgents) and only
// ONE of them — the rules-reference index, fixed by F93 — honoured the
// per-lane distribution fate. Measured divergence at F92 landing:
//
//   * BUILD lane, target rs/py: `commands/{deploy,sync-from-downstream,
//     sync-from-template}.md` measure `skip/build_exclude` in the authoritative
//     `sync-tier-aware.mjs --build rs --dry-run --json` plan, yet the four
//     lane-blind emitters wrote all three into `.codex/prompts/` AND
//     `.gemini/commands/` — 6 artifacts delivered to a `build_multi_cli: true`
//     target that the CC lane deliberately withholds.
//   * loom's OWN self-emit (no `--target`): F93's unconditional laneExclude in
//     the index DROPPED `rules/{cross-repo,cross-sdk-inspection,
//     loom-csq-boundary,documentation}.md` — four rules loom itself is governed
//     by — from the one channel Codex/Gemini have. Fixing one copy had created
//     a NEW disagreement, which is the F92 argument in miniature.
//
// ORDER IS LOAD-BEARING and mirrors `sync-tier-aware.mjs::classifyFile`, the
// authoritative plan-action producer (`rules/artifact-flow.md` § MUST NOT):
// `loom_only` is tested at classifyFile step 2b BEFORE tier inclusion at step
// 5, with the universal `exclude` fence (step 3) and the class-exclude fence
// (step 4) between them, in that order. Any reordering that tests tier before
// the fences OVER-REPORTS the delivered surface.
//
// The CLI-BLIND axes this predicate implements are classifyFile steps 2b, 3, 4
// and 5. It does NOT implement steps 2 (`loom_local`), 2a (`reserved_local`) or
// 2c (BUILD-lane always-include): the emitters walk only `.claude/{commands,
// skills,agents,rules}`, whose members those three steps never match. That is
// the exact scope of the "mirrors classifyFile" claim — it is a mirror of the
// steps reachable from this walk set, not of the whole function.
//
//   1. loom_only    — positive never-sync, total, wins over everything.
//   2. exclude      — the UNIVERSAL fence (classifyFile step 3). Lane-AGNOSTIC
//                     and, unlike lane fate below, NOT gated on `hasTarget`:
//                     `exclude:` is loom's declaration that a path leaves the
//                     `.claude/` tree for no derived tree at all, loom's own
//                     `.codex/`/`.gemini/` included — which is why the eleven
//                     `exclude:`'d command/agent paths are ALSO `loom_only`
//                     today and why loom's own codex tree already carries
//                     neither `/repos` nor `/inspect`. That redundancy is what
//                     masked this fence's ABSENCE before F92-b: an
//                     `exclude:`-only entry (measured: `commands/certify.md`
//                     declared under `exclude:` alone) was written to BOTH
//                     `.codex/prompts/certify.md` and
//                     `.gemini/commands/certify.toml`. The redundancy is now
//                     pinned by `delivery-oracle.test.mjs` so it cannot lapse
//                     silently.
//   3. lane fate    — `use_exclude`/`build_exclude` ∪ obsoleted. Gated on
//                     `hasTarget`: lane fate is a property of a DELIVERY TO a
//                     target, and loom's own `.codex/`/`.gemini/` trees are not
//                     a delivery. classifyFile has no such gate because it is
//                     ONLY ever invoked for a target — there is no no-target
//                     mode to guard. This is the gate F93 lacked.
//   4. surface_roles— per-artifact role restriction (inert when targetRole is
//                     null, which is exactly the no-target case).
//   5. tier         — subscription inclusion. `tierExempt` carries the declared
//                     `variant_only` ADDITION carve-out: such a rule has no
//                     global path to test, so testing it against the tier globs
//                     asks the wrong question and drops it.
//
// Per-CLI `cli_emit_exclusions` are deliberately NOT folded in: they are a
// per-CLI axis each emitter applies inside its own CLI branch (codex/gemini
// can diverge for the same artifact), and two of the five compose additional
// structural exclusions. This predicate is the CLI-BLIND prefix all five share.
//
// Returns `{ delivered, reason }`. When withheld, `reason` is one of
// "loom_only", "exclude", "lane_exclude", "surface_role" or "no_tier_match";
// otherwise "delivered". Those six are the function's own return sites,
// immediately below (coc-manifest.mjs:884-910).
//
// That is NOT classifyFile's reason vocabulary. An earlier revision of this
// paragraph claimed it was — "the same vocabulary classifyFile reports, so a
// divergence between the two surfaces is greppable rather than inferred" —
// and that was measured FALSE and is withdrawn. The two sets INTERSECT in
// exactly three strings ("loom_only", "exclude", "no_tier_match"); the other
// three emitted here appear NOWHERE as a reason in classifyFile
// (sync-tier-aware.mjs:4017):
//   - "lane_exclude" COLLAPSES a distinction the distributor KEEPS. classifyFile
//     is invoked per-lane and reports "use_exclude" or "build_exclude" off the
//     `mode` ternary at sync-tier-aware.mjs:4122; this predicate is
//     lane-BLIND and only tests the caller-supplied `laneExclude` list, so it
//     cannot name which lane withheld the file.
//   - "surface_role" and "delivered" have no classifyFile counterpart at all.
//     Conversely classifyFile carries reasons this predicate never emits: its
//     copy-side labels ("always_include", "build_only_always_include",
//     "tier_match") and two never-sync skips this predicate does not model
//     ("loom_local", "reserved_local").
// So a divergence between the two surfaces is NOT greppable by reason string —
// it has to be established fence-by-fence.
//
// Both sets were read (not tallied) at 938b7624 over exactly this file pair,
// and NOTHING recomputes them — treat the membership above as STALE until
// re-derived. Cheap re-derivation, self-locating so it survives line drift:
//   grep -n 'reason:' .claude/bin/lib/coc-manifest.mjs
//   awk '/^function classifyFile\(/,/^}/' .claude/bin/sync-tier-aware.mjs \
//     | grep -n 'reason:'
// READ the hits, do not tally them. Two traps make the tallies lie in OPPOSITE
// directions: the first grep also matches THESE documentation lines, and one
// classifyFile site is a `mode` ternary emitting TWO strings from ONE line.
// Control, so a zero from that matcher reads as a true negative rather than a
// dead grep: `grep -c no_tier_match .claude/bin/sync-tier-aware.mjs` is
// non-zero (17 at 938b7624), while `grep -c lane_exclude` on the same file is
// 0 — the same matcher, one token present and one absent.
// ────────────────────────────────────────────────────────────────
function deliveryVerdict({
  manifestRel,
  loomOnly,
  universalExclude,
  laneExclude,
  surfaceRoles,
  targetRole,
  tierFilter,
  hasTarget,
  tierExempt = false,
}) {
  // A caller that supplies lane fate but no `hasTarget` would silently
  // OVER-deliver (fall through the gate and emit what the lane withholds) —
  // the exact failure class this oracle exists to close. Refuse loudly rather
  // than default (zero-tolerance.md Rule 3: no silent fallback). Callers with
  // no lane axis at all (unit tests exercising one fence) pass neither and are
  // unaffected.
  if (laneExclude && laneExclude.length && typeof hasTarget !== "boolean") {
    throw new TypeError(
      "deliveryVerdict: `laneExclude` supplied without a boolean `hasTarget` — " +
        "lane fate is a property of a DELIVERY TO a target and cannot be " +
        "evaluated without knowing whether one exists.",
    );
  }
  if (loomOnly && loomOnly.length && matchesAnyGlob(manifestRel, loomOnly)) {
    return { delivered: false, reason: "loom_only" };
  }
  // classifyFile step 3 — the UNIVERSAL `exclude:` fence. No `hasTarget` gate
  // (see the ORDER block above): lane fate is a property of a delivery TO a
  // target, `exclude:` is a property of the path itself.
  if (
    universalExclude &&
    universalExclude.length &&
    matchesAnyGlob(manifestRel, universalExclude)
  ) {
    return { delivered: false, reason: "exclude" };
  }
  if (
    hasTarget &&
    laneExclude &&
    laneExclude.length &&
    matchesAnyGlob(manifestRel, laneExclude)
  ) {
    return { delivered: false, reason: "lane_exclude" };
  }
  if (!surfaceRolesAllow(surfaceRoles, manifestRel, targetRole)) {
    return { delivered: false, reason: "surface_role" };
  }
  if (!tierExempt && tierFilter && !matchesAnyGlob(manifestRel, tierFilter)) {
    return { delivered: false, reason: "no_tier_match" };
  }
  return { delivered: true, reason: "delivered" };
}

// ────────────────────────────────────────────────────────────────
// composeArtifactBody — apply variant overlays to a non-rule artifact
// ────────────────────────────────────────────────────────────────
// Mirrors emit.mjs::composeRule for the commands/skills/agents axes.
// Resolution order (each layer composed on top of the previous):
//   1. Global at .claude/<category>/<relPath> (required base)
//   2. Language overlay  variants/<lang>/<category>/<relPath>
//   3. CLI overlay       variants/<cli>/<category>/<relPath>
//   4. Ternary overlay   variants/<lang>-<cli>/<category>/<relPath>
//
// Two overlay forms are supported (auto-detected per file):
//   - Slot-keyed: file contains `<!-- slot:NAME -->` markers; composed
//                 via slot-parser::applyOverlay (slot bodies replace
//                 matching slots in the running composed body).
//   - Full-file:  variant file is the deployed content; replaces
//                 composed body entirely (no slot markers present).
//
// Returns the composed body string. Caller is responsible for parsing
// frontmatter from the returned body (frontmatter may differ between
// global and full-file variant — variant wins on full-file, slot
// composition preserves global frontmatter unless slots cover it).
//
// Without `lang` (legacy emit-everything mode), only the CLI-axis
// overlay is applied.
//
// Return shape: { body, destRelPath } | null
//   body:        composed file content
//   destRelPath: relPath on the destination tree. Equals input relPath UNLESS
//                the manifest declares an explicit overlay whose basename
//                differs from the global (true rename — e.g.
//                skills/.../python-version-bump.md → rust-version-bump.md on rs).
//
// Overlay resolution per axis uses resolveOverlay() from lib/variant-overlay.mjs:
//   - manifest-explicit + file missing → halt (manifest defect)
//   - manifest-null                    → skip overlay for this axis
//   - manifest-explicit / path-mirror  → apply if file exists
function composeArtifactBody(category, relPath, cli, lang, { rewritePaths = true } = {}) {
  const globalPath = path.join(REPO, ".claude", category, relPath);
  if (!fs.existsSync(globalPath)) return null;
  let composed = safeReadFileSync(globalPath, "utf8");
  let destRelPath = relPath;

  const axes = [];
  if (lang) axes.push(lang);
  if (cli) axes.push(cli);
  if (lang && cli) axes.push(`${lang}-${cli}`);

  for (const axis of axes) {
    const res = resolveOverlay(category, relPath, axis);
    if (res.kind === "manifest-null") continue;
    if (!fs.existsSync(res.path)) {
      if (res.kind === "manifest-explicit") {
        process.stderr.write(
          `emit-cli-artifacts: sync-manifest.yaml::variants declares overlay ` +
            `'${path.relative(REPO, res.path)}' for ${category}/${relPath} ` +
            `axis '${axis}', but the file is missing — halt (manifest defect).\n`,
        );
        process.exit(2);
      }
      continue;
    }
    const overlay = safeReadFileSync(res.path, "utf8");
    if (overlay.includes("<!-- slot:")) {
      // Slot-keyed: compose via slot-parser
      const { composed: c } = applyOverlay(composed, overlay);
      composed = c;
    } else {
      // Full-file replacement
      composed = overlay;
    }
    // Renames carry through the destination basename — last explicit wins.
    if (res.kind === "manifest-explicit" && res.destRelPath !== relPath) {
      destRelPath = res.destRelPath;
    }
  }
  // Strip BUILD-internal references before returning. Per
  // .claude/agents/management/coc-sync.md Step 3a — every artifact
  // landing in a USE template MUST be stripped of paths the USE
  // consumer cannot resolve (workspaces/multi-cli-coc/, packages/
  // kailash-*/, gh api repos/<concrete-org>/kailash-*, etc.). The
  // transform is idempotent; running on already-clean content is a
  // no-op. See .claude/bin/lib/strip-build-internal.mjs for the
  // codified pattern set + audit fixtures.
  const { stripped } = stripBuildInternalReferences(composed);
  // CLI-aware path rewrite: at loom the source body references
  // .claude/{skills,commands,agents}/ because that IS where CC stores
  // them. For codex / gemini emissions the consumer's CLI looks under
  // .agents/skills/ and .codex/{prompts,agents}/ or .gemini/{skills,commands,agents}/.
  // Without this rewrite, a Codex consumer reading the emitted prompt
  // sees `.claude/skills/04-kaizen/SKILL.md` and looks for it where
  // their CLI does not — surfaced as drift in a downstream consumer (#205).
  // Shared-runtime paths (hooks, learning, VERSION, bin, sync markers,
  // rules, guides, codex-mcp-guard) stay `.claude/` since they're
  // consumed identically across all three CLIs.
  const rewritten = rewritePaths ? rewriteClaudePathsForCli(stripped, cli, { sourcePath: relPath }) : stripped;
  return { body: rewritten, destRelPath };
}

// CLI-aware path rewrite — see composeArtifactBody for rationale.
// codex: .claude/skills → .agents/skills; .claude/commands → .codex/prompts; .claude/agents → .codex/agents
// gemini: .claude/skills → .gemini/skills; .claude/commands → .gemini/commands; .claude/agents → .gemini/agents
// cc / null: no rewrite.
//
// Source-authoring documents describe the canonical tree on every CLI. Other
// documents can mix source citations with runtime links; preserve source clauses,
// CC ownership-table rows and fenced examples rather than rewriting their authority.
// Shared clause traversal keeps relocation and path rewriting on the same
// authority boundary. A shorter nested fence never closes an outer example.
function mapArtifactMarkdownClauses(body, transform, { sourceAuthority = false, sourcePath = "" } = {}) {
  sourceAuthority ||= /(?:^|\/)[^/]*authoring(?:\/|\.md$)/.test(sourcePath);
  let fence = null;
  return body.split(/(\r?\n)/).map((line) => {
    const marker = line.match(/^\s*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return line;
    }
    const rowAuthority = /^\s*\|\s*(?:CC|Claude(?: Code)?)\s*\|/i.test(line);
    return line.split(/(;[ \t]*|[.!?][ \t]+)/).map((clause) => transform(clause, {
      sourceAuthority: sourceAuthority || rowAuthority || /\b(?:source|canonical|authoritative|author(?:ing|ed|s)?|ownership)\b/i.test(clause),
    })).join("");
  }).join("");
}

function rewriteClaudePathsForCli(body, cli, options = {}) {
  if (cli !== "codex" && cli !== "gemini") return body;
  return mapArtifactMarkdownClauses(body, (clause, { sourceAuthority }) =>
    sourceAuthority ? clause : rewriteRuntimePaths(clause, cli, options.canMap || (() => true)), options);
}

function rewriteRuntimePaths(body, cli, canMap) {
  // commands path differs: codex calls them "prompts", gemini calls them "commands".
  const commandsTarget = cli === "codex" ? "prompts" : "commands";
  const exclusions = /\.claude\/(?:skills|agents)\//.test(body) ? loadExclusions()[cli] : [];
  const mapped = (whole, prefix, destination) => canMap(whole.slice(prefix.length), destination) ? `${prefix}${destination}` : whole;
  return body
    // Keep source references for expertise withheld from the native CLI catalog.
    // The source material still ships under .claude; rewriting it would invent a
    // file in a destination the same exclusion oracle deliberately never emits.
    .replace(/(^|[^a-zA-Z0-9._/-])\.claude\/skills\/([A-Za-z0-9._/-]*)/g,
      (whole, prefix, rest) => rest && matchesAnyGlob(`skills/${rest.split("/")[0]}/SKILL.md`, exclusions)
        ? whole
        : mapped(whole, prefix, `.${cli === "codex" ? "agents" : "gemini"}/skills/${rest}`))
    // .claude/commands/<name>.md → .codex/prompts/<name>.md  (Codex keeps .md)
    //                            → .gemini/commands/<name>.toml (Gemini emits TOML)
    // PY-3-A3: the directory was rewritten but the EXTENSION was not, so every
    // Gemini-lane citation of a command pointed at `.gemini/commands/<name>.md`
    // — a file that does not exist, because emitCommands writes `<name>.toml` on
    // that lane. Measured on a full emit: 11 dangling `.md` citations across the
    // enrollment/onboarding path (the first commands a new Gemini operator
    // walks), 0 correct `.toml` ones. The loom SOURCE is clean (0 wrong / 169
    // correct), so this rewrite was the sole producer.
    // The filename-bearing form MUST run BEFORE the bare-directory form below,
    // which would otherwise consume the prefix and strand the extension.
    // `[A-Za-z0-9._-]+` excludes `/`, so a match cannot cross a directory
    // boundary — commands are flat under `.claude/commands/`.
    .replace(
      /(^|[^a-zA-Z0-9._/-])\.claude\/commands\/([A-Za-z0-9._-]+)\.md\b/g,
      (whole, prefix, name) => mapped(whole, prefix, `.${cli}/${commandsTarget}/${name}.${cli === "gemini" ? "toml" : "md"}`),
    )
    // Bare-directory form (a citation naming the dir, not a specific command).
    .replace(/(^|[^a-zA-Z0-9._/-])\.claude\/commands\/(?![A-Za-z0-9._-])/g,
      (whole, prefix) => mapped(whole, prefix, `.${cli}/${commandsTarget}/`))
    // Native agents are flat on both lanes; Codex now registers TOML definitions.
    // Source filenames and frontmatter names must agree with the emitted identity.
    .replace(
      /(^|[^a-zA-Z0-9._/-])\.claude\/agents\/(?:((?:[A-Za-z0-9._-]+\/)*)([A-Za-z0-9._-]+)\.md\b)?/g,
      (whole, pre, group, name) => {
        if (!name) return mapped(whole, pre, `.${cli}/agents/`);
        if (matchesAnyGlob(`agents/${group}${name}.md`, exclusions)) return whole;
        return mapped(whole, pre, `.${cli}/agents/${name}.${cli === "codex" ? "toml" : "md"}`);
      },
    );
}

// ────────────────────────────────────────────────────────────────
// Build tier filter: union of glob patterns across subscribed tiers.
// Returns null when no target (caller emits everything per legacy mode).
// Halts with exit 2 when target is provided but tier_subscriptions is
// missing — per sync-flow.md § Gate 2 → Process step 3 (loom: /sync-to-use), that is a manifest
// defect, not a fall-through-to-all-tiers fallback.
// ────────────────────────────────────────────────────────────────
function buildTierFilter(target) {
  if (!target) return null;
  const subs = loadTargetTierSubscriptions(target);
  if (subs === null) {
    process.stderr.write(
      `emit-cli-artifacts: target '${target}' not found in sync-manifest.yaml::repos.* — halt.\n`,
    );
    process.exit(2);
  }
  if (subs.length === 0) {
    process.stderr.write(
      `emit-cli-artifacts: target '${target}' has empty tier_subscriptions ` +
        `(retired/structural-defect halt per sync-flow.md § Gate 2 → Process step 3 (loom: /sync-to-use)) — refusing to emit.\n`,
    );
    process.exit(2);
  }
  const tiers = loadTiers();
  const globs = [];
  for (const tier of subs) {
    const patterns = tiers[tier];
    if (!patterns) {
      process.stderr.write(
        `emit-cli-artifacts: tier '${tier}' (subscribed by ${target}) ` +
          `not found in sync-manifest.yaml::tiers.* — halt.\n`,
      );
      process.exit(2);
    }
    globs.push(...patterns);
  }
  return globs;
}

// ────────────────────────────────────────────────────────────────
// Directory walker — yields { absPath, relPath } for files only
// ────────────────────────────────────────────────────────────────
function* walkFiles(root, rel = "") {
  const full = rel ? path.join(root, rel) : root;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const entryRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(root, entryRel);
    } else if (entry.isFile()) {
      yield {
        absPath: path.join(full, entry.name),
        relPath: entryRel,
      };
    }
  }
}

export {
  REPO,
  safeWriteFileSync,
  ensureTrailingNewline,
  writeTextArtifactSync,
  safeReadFileSync,
  globToRegex,
  matchesAnyGlob,
  loadExclusions,
  loadLoomOnly,
  loadFlatList,
  loadUniversalExclude,
  loadLaneExclusions,
  loadVariantOnly,
  loadTiers,
  loadTargetTierSubscriptions,
  loadTargetVariant,
  loadTargetRole,
  loadSurfaceRoles,
  loadSurfaceRolesDiagnostics,
  parseSurfaceRolesStanza,
  surfaceRolesAllow,
  deliveryVerdict,
  buildTierFilter,
  composeArtifactBody,
  rewriteClaudePathsForCli,
  mapArtifactMarkdownClauses,
  walkFiles,
};
