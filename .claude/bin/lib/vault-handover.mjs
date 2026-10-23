/**
 * vault-handover.mjs — ONE derivation of a vault handover pair's identity.
 *
 * @what The pure library behind `.claude/bin/vault-handover.mjs`. It owns the
 *       single derivation of a handover pair's identity (date + `##` seq) and
 *       every representation of it that must agree: the FILENAME, the
 *       frontmatter `seq`, the `pairs_with` wikilink, and the file paths named
 *       inside the wrapup's fenced `/clear` seed.
 *
 * @why  The contract for these files lives in loom's `CLAUDE.md` § STANDING
 *       DIRECTIVE — Vault Handover, and NOTHING executed it. Measured on
 *       2026-09-15: `commands/wrapup.md`, `commands/sweep.md`,
 *       `skills/wrapup/SKILL.md` and `skills/sweep/SKILL.md` each contain ZERO
 *       occurrences of either vault-destination token named in that directive,
 *       and no `seq` field guidance (controls that fire on the same matchers:
 *       `CLAUDE.md` returns 1 for the directory token; `.claude/bin/` returns 7
 *       for `burndown`). No script anywhere in the repo referenced the vault
 *       path at all. So every session re-derived FOUR representations of one
 *       integer by hand, from prose, with nothing comparing them.
 *
 *       The 2026-09-15 pair is what that costs. It was the EIGHTH pair of a
 *       continuous run whose first seven were dated 2026-09-14. The filename
 *       took the PER-DAY sequence (`01` — correct per the directive); the
 *       frontmatter `seq`, the body prose and the `/clear` seed's two absolute
 *       paths took the PER-SESSION count (`08`). The seed therefore instructed
 *       the next session to read `2026-09-15-08-{sweep,wrapup}.md`, which do
 *       not exist, and that session's first two reads both failed.
 *
 * @invariants (enforced by `verifyEntries`)
 *   1. filename `date` == frontmatter `date`
 *   2. filename `##` == frontmatter `seq` (both zero-padded 2-digit)
 *   3. `pairs_with` names the SIBLING of this exact pair (same date + seq,
 *      opposite kind) as a slug-free wikilink
 *   4. every handover path inside THE `/clear` SEED BLOCK names THIS pair, and
 *      resolves on disk as written
 *   5. a pair is COMPLETE — a `-sweep` has its `-wrapup` and vice versa
 *   6. every frontmatter field the directive requires is PRESENT
 *
 * @scoping Invariant 4 is scoped to THE SEED BLOCK — the fenced block under the
 *       `/clear` seed heading — and NOT to every fenced block in the document.
 *       That distinction is load-bearing and was found by review. The directive
 *       requires a wrapup record "corrections made in-session recorded rather
 *       than smoothed", and such a record QUOTES a previous pair's wrong seed
 *       inside a fence. A whole-document rule reds on that honest record, and a
 *       whole-document REWRITE destroys it — the tool would erase the very
 *       correction the directive exists to preserve, then report CLEAN.
 *       Anchor measured across the live corpus: all 12 wrapups carry exactly one
 *       `/clear seed` heading, all 12 sweeps carry zero.
 *
 * @non-goals Not a writer of report CONTENT. It derives and checks identity
 *            only; the sweep/wrapup bodies stay authored. Body PROSE is
 *            deliberately unchecked — rewriting narrative is not this tool's
 *            business, and a prose sentence is not a path anyone pastes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The per-operator config naming the vault directory (gitignored; never shipped). */
export const VAULT_LOCAL_CONFIG = ".claude/bin/vault-handover.local.json";

/**
 * The ONE name of the archive subdirectory. The CLI (`archive`, `verify`, the
 * seq population) and the cycle renderer's pair lookup all join it onto the
 * vault, so they cannot disagree about where archived pairs live. `verifyFile`
 * does not read it: it trusts the `archived` flag the enumeration set.
 */
export const ARCHIVE_SUBDIR = "archive";

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the vault handover directory — ONE resolution order for every caller
 * (the `vault-handover.mjs` CLI and `handover-render.mjs`), so the two can never
 * disagree about which vault a pair belongs in:
 *   1. an explicit `flag` (`--vault`) — which must resolve, or the result is a
 *      HARD failure, never a fallthrough: a typo'd flag silently replaced by the
 *      env value would write into a vault nobody named;
 *   2. `env` (`$COC_VAULT_HANDOVER_DIR`), when it is a directory;
 *   3. `<repoRoot>/.claude/bin/vault-handover.local.json :: handover_dir`.
 *
 * Returns data, never exits: the CLI turns a failure into its LOUD refusal, the
 * renderer turns `kind: "unresolved"` into a DECLARED skip (a machine with no
 * vault is a legitimate configuration, not an error) and every other kind into a
 * failure.
 *
 * @returns {{ok:true, dir:string, source:string} |
 *           {ok:false, kind:"explicit-not-dir"|"config-unreadable"|"unresolved",
 *            tried:string[], reason:string}}
 */
export function resolveVaultDir({ flag, env, repoRoot, isDir = isDirectory } = {}) {
  const tried = [];
  if (flag) {
    if (!isDir(flag)) {
      return { ok: false, kind: "explicit-not-dir", tried: [`--vault ${flag}`], reason: `--vault ${flag} is not a directory` };
    }
    return { ok: true, dir: path.resolve(flag), source: "--vault" };
  }
  if (env) {
    tried.push(`$COC_VAULT_HANDOVER_DIR=${env}`);
    if (isDir(env)) return { ok: true, dir: path.resolve(env), source: "$COC_VAULT_HANDOVER_DIR" };
  }
  if (repoRoot) {
    const cfgPath = path.join(repoRoot, VAULT_LOCAL_CONFIG);
    if (fs.existsSync(cfgPath)) {
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch (e) {
        return { ok: false, kind: "config-unreadable", tried, reason: `${VAULT_LOCAL_CONFIG} is present but unreadable: ${e.message}` };
      }
      const dir = cfg && cfg.handover_dir;
      if (dir) {
        tried.push(`${VAULT_LOCAL_CONFIG}::handover_dir=${dir}`);
        if (isDir(dir)) return { ok: true, dir: path.resolve(dir), source: VAULT_LOCAL_CONFIG };
      }
    }
  }
  return {
    ok: false,
    kind: "unresolved",
    tried,
    reason: "no vault directory resolved from --vault, $COC_VAULT_HANDOVER_DIR, or " + VAULT_LOCAL_CONFIG,
  };
}

/** Conforming handover basename: `YYYY-MM-DD-##-{sweep,wrapup}.md`. */
export const HANDOVER_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{2})-(sweep|wrapup)\.md$/;

/**
 * Looser shape used ONLY to tell "a handover file with a malformed name" from
 * "an unrelated markdown file". A file matching this but not
 * HANDOVER_NAME_RE is a finding, never silently skipped — silently skipping is
 * how a file drops out of the audited population.
 */
const HANDOVER_NAME_LOOSE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)-(sweep|wrapup)\.md$/;

/** Heading that anchors the `/clear` seed block. */
const SEED_HEADING_RE = /^#{1,6}\s+.*\/clear\b.*\bseed\b/i;

/** The frontmatter fields the directive requires on BOTH members. */
export const REQUIRED_FIELDS = [
  "date",
  "seq",
  "kind",
  "title",
  "repo",
  "trunk",
  "tags",
  "pairs_with",
];

/** `##` is two digits, so a day cannot hold more than this many pairs. */
export const MAX_SEQ = 99;

export const KINDS = ["sweep", "wrapup"];

/** The opposite kind — the sibling `pairs_with` must name. */
export function siblingKind(kind) {
  return kind === "sweep" ? "wrapup" : "sweep";
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Normalize line endings so every downstream regex sees plain `\n`. */
export function normalizeEol(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * @returns {{date:string, seq:string, kind:string}|null} null when the name is
 *          not a handover file at all. A MALFORMED handover name returns null
 *          too, so callers pair this with `looseHandoverName` to distinguish
 *          "not ours" from "ours and broken".
 */
export function parseHandoverName(basename) {
  const m = HANDOVER_NAME_RE.exec(basename);
  if (!m) return null;
  return { date: m[1], seq: m[2], kind: m[3] };
}

/**
 * @returns {{date:string, middle:string, kind:string}|null} a name that LOOKS
 *          like a handover file (date prefix + kind suffix) regardless of
 *          whether its `##` field is well-formed.
 */
export function looseHandoverName(basename) {
  const m = HANDOVER_NAME_LOOSE_RE.exec(basename);
  if (!m) return null;
  return { date: m[1], middle: m[2], kind: m[3] };
}

/** The canonical basename for a pair member. The ONLY place it is spelled. */
export function handoverBasename(date, seq, kind) {
  return `${date}-${pad2(seq)}-${kind}.md`;
}

/**
 * The canonical `pairs_with` value: a wikilink to the sibling WITHOUT the repo
 * slug or any path segment, per the directive's `"[[2026-09-13-01-wrapup]]"`
 * example. Slug-free is not cosmetic — Obsidian resolves a bare basename, so a
 * slug-free link survives the pair being moved into `archive/`, while a
 * path-bearing one breaks on the move and has to be rewritten. Every rewrite
 * is a chance to miss a field, which is the defect this file exists to end.
 */
export function canonicalPairsWith(date, seq, kind) {
  return `[[${date}-${pad2(seq)}-${siblingKind(kind)}]]`;
}

/**
 * Minimal YAML-subset frontmatter reader: the leading `---` fenced block, flat
 * `key: value` scalars only. Deliberately NOT a YAML parser — the fields this
 * checks are flat scalars, and a dependency-free reader keeps this runnable in
 * a bare vault directory.
 *
 * A block with no closing `---` is `present: false`: an unterminated block is
 * not frontmatter, and reporting it as present with zero fields produced a
 * cascade of phantom findings on CRLF files before EOL normalization landed.
 *
 * @returns {{present:boolean, fields:Object<string,string>, endLine:number}}
 */
export function parseFrontmatter(text) {
  const lines = normalizeEol(text).split("\n");
  if (lines[0]?.trim() !== "---") return { present: false, fields: {}, endLine: -1 };
  const fields = {};
  let lastKey = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { present: true, fields, endLine: i };
    const m = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(lines[i]);
    if (m) {
      lastKey = m[1];
      fields[lastKey] = cleanScalar(m[2]);
      continue;
    }
    // A YAML BLOCK SEQUENCE continues its key across indented `- item` lines,
    // and `tags:` — which the directive requires — is always written that way.
    // Without this the key line reads as an EMPTY value and the presence check
    // reports the directive's own canonical shape as a missing field.
    const item = /^[ \t]+-[ \t]+(.*)$/.exec(lines[i]);
    if (item && lastKey) {
      fields[lastKey] = fields[lastKey]
        ? `${fields[lastKey]}, ${cleanScalar(item[1])}`
        : cleanScalar(item[1]);
    }
  }
  return { present: false, fields: {}, endLine: -1 };
}

/**
 * Strip surrounding quotes and an unquoted trailing `# comment`. A `#` INSIDE
 * quotes is content, not a comment — stripping it would corrupt a title.
 */
function cleanScalar(raw) {
  let v = raw.trim();
  const quoted = /^(['"])([\s\S]*)\1\s*(?:#.*)?$/.exec(v);
  if (quoted) return quoted[2];
  v = v.replace(/\s+#.*$/, "");
  return v.trim();
}

/**
 * Extract the inner target of a `pairs_with` wikilink.
 * @returns {{target:string, basename:string, hasPathSegment:boolean}|null}
 */
export function parsePairsWith(raw) {
  if (!raw) return null;
  const m = /\[\[([^\]]+)\]\]/.exec(raw);
  if (!m) return null;
  const target = m[1].trim();
  const basename = target.split("/").pop();
  return { target, basename, hasPathSegment: target.includes("/") };
}

/**
 * Scan fenced-code-block boundaries. Tracks the fence CHARACTER **and LENGTH**,
 * so a longer outer fence correctly contains a shorter inner one and a `~~~`
 * block is not closed by a triple backtick.
 *
 * @returns {{ranges:Array<{start:number,end:number}>, unclosed:number|null}}
 *          `end` is exclusive. `unclosed` is the 1-based line of a fence that
 *          never closed, which is REPORTED rather than silently swallowing the
 *          remainder of the document as fenced content.
 */
export function scanFences(text) {
  const lines = normalizeEol(text).split("\n");
  const ranges = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (!m) continue;
    const char = m[1][0];
    const len = m[1].length;
    if (open === null) {
      open = { char, len, start: i + 1 };
    } else if (char === open.char && len >= open.len) {
      ranges.push({ start: open.start, end: i });
      open = null;
    }
  }
  return { ranges, unclosed: open ? open.start : null };
}

/**
 * Locate THE `/clear` seed block: the first fenced block beginning after the
 * seed heading. Returns `{found:false}` when the document has no such heading,
 * which callers surface as a finding rather than falling back to scanning every
 * fence (§ @scoping).
 */
export function findSeedBlock(text) {
  const lines = normalizeEol(text).split("\n");
  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SEED_HEADING_RE.test(lines[i])) {
      headingLine = i;
      break;
    }
  }
  const { ranges, unclosed } = scanFences(text);
  if (headingLine < 0) return { found: false, unclosed };
  const block = ranges.find((r) => r.start > headingLine);
  if (!block) return { found: false, headingLine: headingLine + 1, unclosed };
  return {
    found: true,
    headingLine: headingLine + 1,
    start: block.start,
    end: block.end,
    unclosed,
  };
}

/**
 * Strip surrounding decoration from a path token so a quoted, backticked, or
 * markdown-linked seed path is read as the path it names. Without this, a
 * correct pair whose seed paths are quoted reported `seed-ref-unresolvable`
 * forever and `--fix` could not clear it — a permanent false positive is how a
 * gate gets switched off.
 */
function stripDecoration(prefix) {
  return prefix.replace(/^[\s"'`([<]+/, "");
}

/** Is this an absolute path, counting `~/` which resolves to a real location? */
function isAbsoluteish(p) {
  return p.startsWith("/") || p.startsWith("~/");
}

/** Resolve `~` so a home-relative seed path is checked against the real file. */
export function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Handover-file references inside THE `/clear` seed block.
 */
export function extractSeedRefs(text) {
  const block = findSeedBlock(text);
  const out = {
    found: block.found,
    refs: [],
    unclosed: block.unclosed,
    headingLine: block.headingLine,
  };
  if (!block.found) return out;
  const lines = normalizeEol(text).split("\n");
  for (let i = block.start; i < block.end; i++) {
    const re = /(\S*?)(\d{4}-\d{2}-\d{2})-(\d{1,4})-(sweep|wrapup)\.md/g;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      const prefix = stripDecoration(m[1]);
      out.refs.push({
        raw: `${prefix}${m[2]}-${m[3]}-${m[4]}.md`,
        prefix,
        line: i + 1,
        date: m[2],
        seq: m[3],
        kind: m[4],
        absolute: isAbsoluteish(prefix),
      });
    }
  }
  return out;
}

/**
 * Derive the NEXT per-day seq for `date` from the names already present.
 * `##` is a PER-DAY sequence per the directive, so the derivation counts by
 * DATE and ignores how many sessions or how many days a run spanned — the
 * precise confusion that produced `seq: "08"` under a `-01-` filename.
 *
 * Archived names are included by the CALLER (which passes both directories): a
 * pair moved into `archive/` still consumed its slot for that day.
 *
 * Only names whose `##` field is a 1-2 digit number participate. A junk name
 * like `2026-09-15-99999-sweep.md` would otherwise set `max` to 99999 and hand
 * the operator `100000` — a seq the canonical name regex cannot even express.
 *
 * @throws when the day is exhausted, rather than emitting an unusable name.
 */
export function deriveNextSeq(date, existingBasenames) {
  let max = 0;
  for (const base of existingBasenames) {
    const parsed = parseHandoverName(base) ?? looseHandoverName(base);
    if (!parsed || parsed.date !== date) continue;
    const seqField = parsed.seq ?? parsed.middle;
    if (!/^\d{1,2}$/.test(seqField)) continue;
    const n = Number.parseInt(seqField, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (max >= MAX_SEQ) {
    throw new Error(
      `deriveNextSeq: ${date} already holds pair ${pad2(max)}; the directive's \`##\` is two digits, so ${MAX_SEQ} is the last slot in a day. Refusing to emit an unusable name.`,
    );
  }
  return pad2(max + 1);
}

/**
 * The FULL identity of a pair, derived once. Every caller reads its strings
 * from here instead of re-deriving them, which is the whole point: four
 * representations cannot disagree when one function emits all four.
 */
export function derivePlan({ date, seq, vaultDir }) {
  const s = pad2(seq);
  const out = { date, seq: s, files: {} };
  for (const kind of KINDS) {
    const basename = handoverBasename(date, s, kind);
    out.files[kind] = {
      basename,
      absolutePath: vaultDir ? path.join(vaultDir, basename) : basename,
      frontmatter: {
        date,
        seq: s,
        kind,
        pairs_with: canonicalPairsWith(date, s, kind),
      },
    };
  }
  out.seedPaths = KINDS.map((k) => out.files[k].absolutePath);
  return out;
}

/**
 * @typedef {{code:string, file:string, detail:string}} Finding
 */

/**
 * Check ONE file's representations against each other.
 */
export function verifyFile(entry) {
  const { basename, dir } = entry;
  const text = normalizeEol(entry.text);
  const exists = entry.exists ?? ((p) => fs.existsSync(p));
  const findings = [];
  const add = (code, detail) => findings.push({ code, file: basename, detail });

  const name = parseHandoverName(basename);
  if (!name) {
    const loose = looseHandoverName(basename);
    add(
      "filename-nonconforming",
      loose
        ? `name has a '${loose.middle}' field where a zero-padded 2-digit ## belongs; expected ${loose.date}-NN-${loose.kind}.md`
        : `not parseable as YYYY-MM-DD-##-{sweep,wrapup}.md`,
    );
    return findings;
  }

  const fm = parseFrontmatter(text);
  if (!fm.present) {
    add("frontmatter-missing", "no leading --- frontmatter block, or it is never closed");
    return findings;
  }

  // Invariant 6 — every directive-required field is PRESENT.
  for (const field of REQUIRED_FIELDS) {
    if (fm.fields[field] === undefined || fm.fields[field] === "") {
      add(
        "frontmatter-field-missing",
        `the directive requires \`${field}\`, which is absent or empty`,
      );
    }
  }

  // Invariant 1 — date
  if (fm.fields.date !== undefined && fm.fields.date !== name.date) {
    add(
      "date-mismatch",
      `filename says ${name.date}, frontmatter date says ${fm.fields.date} — resolve by hand; --fix will NOT overwrite a date, because which one is right depends on when the session actually ran`,
    );
  }

  // Invariant 2 — seq. The 2026-09-15 defect lands here.
  const fmSeq = fm.fields.seq;
  if (fmSeq !== undefined && fmSeq !== name.seq) {
    add(
      "seq-mismatch",
      `filename ## is ${name.seq}, frontmatter seq is "${fmSeq}"` +
        (pad2(fmSeq) === name.seq
          ? " (same number, not zero-padded — pad it)"
          : " — the per-day ## and the frontmatter seq disagree about this pair's identity"),
    );
  }

  if (fm.fields.kind !== undefined && fm.fields.kind !== name.kind) {
    add("kind-mismatch", `filename kind is ${name.kind}, frontmatter kind is ${fm.fields.kind}`);
  }

  // Invariant 3 — pairs_with
  const pw = parsePairsWith(fm.fields.pairs_with);
  if (fm.fields.pairs_with !== undefined && !pw) {
    add("pairs-with-malformed", `pairs_with is "${fm.fields.pairs_with}" — expected a [[wikilink]]`);
  } else if (pw) {
    const expected = `${name.date}-${name.seq}-${siblingKind(name.kind)}`;
    if (pw.basename !== expected) {
      add(
        "pairs-with-target-mismatch",
        `pairs_with names "${pw.basename}", this pair's sibling is "${expected}"`,
      );
    }
    if (pw.hasPathSegment) {
      add(
        "pairs-with-carries-path",
        `pairs_with is "${pw.target}"; the directive requires a slug-free wikilink, e.g. "${canonicalPairsWith(name.date, name.seq, name.kind)}" — a path-bearing link breaks when the pair moves to archive/`,
      );
    }
  }

  // Invariant 4 — the `/clear` SEED BLOCK names THIS pair and resolves.
  const seed = extractSeedRefs(text);
  if (seed.unclosed !== null && seed.unclosed !== undefined) {
    add(
      "fence-unclosed",
      `a code fence opened at line ${seed.unclosed} is never closed; the seed block cannot be delimited reliably`,
    );
  }
  if (name.kind === "wrapup" && !seed.found) {
    // Only a WRAPUP carries the seed (measured: 12/12 wrapups have the heading,
    // 0/12 sweeps do).
    add(
      "seed-block-not-found",
      seed.headingLine
        ? `a /clear seed heading is at line ${seed.headingLine} but no fenced block follows it — the seed cannot be checked`
        : `no /clear seed heading found; the directive requires the wrapup carry the seed in a fenced code block`,
    );
  }
  for (const ref of seed.refs) {
    if (ref.date !== name.date || pad2(ref.seq) !== name.seq) {
      add(
        "seed-ref-seq-mismatch",
        `the /clear seed at line ${ref.line} names ${ref.date}-${ref.seq}-${ref.kind}.md, but this file is ${name.date}-${name.seq}-${name.kind}.md — the next session would read a path that is not this pair`,
      );
    }
    const resolved = ref.absolute
      ? expandHome(ref.raw)
      : path.resolve(dir, ref.raw.replace(/^\.\//, ""));
    if (!exists(resolved)) {
      // A pair moved into archive/ by a bare `mv` keeps a seed naming its former
      // LIVE slot; `archive` and `--fix` both re-derive that path through
      // `normalizeFile`. Name the shape and its one-command repair rather than
      // reporting it as a seed that never resolved. This does NOT resolve the
      // ref against the pair's directory — the finding still reds, so the seed
      // the next session reads is still required to be the path that exists,
      // and a LIVE (top-level) pair is never eligible for this branch. Archive
      // membership is the ENUMERATION's fact (`collectEntries(dir, { archived })`),
      // never the directory's NAME — a vault that is itself named `archive`
      // holds live pairs.
      const refBase = handoverBasename(ref.date, pad2(ref.seq), ref.kind);
      const strandedByMove =
        ref.absolute &&
        ref.date === name.date &&
        pad2(ref.seq) === name.seq &&
        entry.archived === true &&
        path.resolve(resolved) === path.resolve(path.dirname(dir), refBase) &&
        exists(path.join(dir, refBase));
      if (strandedByMove) {
        add(
          "seed-ref-stale-after-move",
          `the /clear seed at line ${ref.line} names ${resolved}, this pair's former live location; the pair now sits in ${path.join(dir, refBase)} — it was moved without \`archive\`, which rewrites the seed. Repair: vault-handover verify --fix`,
        );
        continue;
      }
      add(
        "seed-ref-unresolvable",
        `the /clear seed at line ${ref.line} names ${resolved}, which does not exist`,
      );
    }
  }

  return findings;
}

/**
 * Whole-directory verification, including pair completeness (invariant 5).
 */
export function verifyEntries(entries) {
  const findings = [];
  for (const e of entries) findings.push(...verifyFile(e));

  // Invariant 5 — completeness. Grouped dir -> stem -> kinds with NESTED MAPS
  // rather than a composite string key. A string key needs a separator, and no
  // separator is safe here: a directory path may legitimately contain a space,
  // so splitting one back apart is lossy. (The first cut of this function used a
  // raw NUL byte as that separator. It WORKED — every test passed — while making
  // the whole file unsearchable: grep classifies a NUL-bearing file as binary
  // and returns nothing, so every matcher aimed at this file silently reported
  // no match. A check that cannot be searched is one nobody can audit.)
  const seen = new Map();
  for (const e of entries) {
    const name = parseHandoverName(e.basename);
    if (!name) continue;
    const stem = `${name.date}-${name.seq}`;
    if (!seen.has(e.dir)) seen.set(e.dir, new Map());
    const byStem = seen.get(e.dir);
    if (!byStem.has(stem)) byStem.set(stem, new Set());
    byStem.get(stem).add(name.kind);
  }
  for (const [dir, byStem] of seen) {
    for (const [stem, kinds] of byStem) {
      for (const kind of KINDS) {
        if (!kinds.has(kind)) {
          findings.push({
            code: "pair-incomplete",
            file: `${stem}-${siblingKind(kind)}.md`,
            detail: `in ${dir}: the ${kind} half of pair ${stem} is absent — the directive requires TWO files, never one`,
          });
        }
      }
    }
  }
  return findings;
}

/** Read every handover file under a directory (non-recursive) for verification. */
export function collectEntries(dir, { archived = false } = {}) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const base of names) {
    if (!base.endsWith(".md")) continue;
    if (!parseHandoverName(base) && !looseHandoverName(base)) continue;
    const full = path.join(dir, base);
    if (!fs.statSync(full).isFile()) continue;
    out.push({ basename: base, dir, archived, text: fs.readFileSync(full, "utf8") });
  }
  return out;
}

/**
 * Rewrite ONE file so every representation agrees with the authority (the
 * FILENAME, which the directive defines as the per-day `##`).
 *
 * SCOPE, deliberately narrow (§ @scoping): only frontmatter fields, and only
 * handover paths inside THE `/clear` seed block. `date` is NEVER rewritten —
 * which of the two dates is correct depends on when the session ran, and
 * silently overwriting it loses that fact on any session crossing midnight.
 */
export function normalizeFile({ basename, text, seedDir }) {
  const name = parseHandoverName(basename);
  if (!name) {
    throw new Error(
      `normalizeFile: "${basename}" is not a conforming handover name; rename it first — this tool will not guess a pair's identity`,
    );
  }
  const changed = [];
  const src = normalizeEol(text);
  const lines = src.split("\n");
  const fm = parseFrontmatter(src);
  if (!fm.present) {
    throw new Error(`normalizeFile: "${basename}" has no frontmatter block, or it is never closed`);
  }

  // `date` is absent on purpose — see the scope note above.
  const want = {
    seq: `"${name.seq}"`,
    kind: name.kind,
    pairs_with: `"${canonicalPairsWith(name.date, name.seq, name.kind)}"`,
  };

  const present = new Set();
  for (let i = 1; i < fm.endLine; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    present.add(m[1]);
    if (!(m[1] in want)) continue;
    const next = `${m[1]}: ${want[m[1]]}`;
    if (lines[i] !== next) {
      changed.push(`${m[1]}: ${m[2].trim()} -> ${want[m[1]]}`);
      lines[i] = next;
    }
  }

  // Add any of the three derivable fields that are absent entirely. Without
  // this, a file missing `seq:` reported a finding that --fix could never clear,
  // so every later run re-reported it — a permanently red gate.
  const additions = [];
  for (const [key, value] of Object.entries(want)) {
    if (!present.has(key)) {
      additions.push(`${key}: ${value}`);
      changed.push(`${key}: (absent) -> ${value}`);
    }
  }
  if (additions.length) lines.splice(fm.endLine, 0, ...additions);

  // Seed refs -> this pair, in the directory the pair now lives in. Scoped to
  // THE seed block: a fenced QUOTATION of an earlier pair's seed is a record the
  // directive requires be kept, and rewriting it is destroying evidence.
  const seedAfterInsert = findSeedBlock(lines.join("\n"));
  if (seedAfterInsert.found) {
    const dir = seedDir ?? ".";
    for (let i = seedAfterInsert.start; i < seedAfterInsert.end; i++) {
      const before = lines[i];
      lines[i] = before.replace(
        /(\S*?)(\d{4}-\d{2}-\d{2})-(\d{1,4})-(sweep|wrapup)\.md/g,
        (_all, prefix, _d, _s, kind) => {
          const clean = stripDecoration(prefix);
          const decoration = prefix.slice(0, prefix.length - clean.length);
          const target = handoverBasename(name.date, name.seq, kind);
          return isAbsoluteish(clean)
            ? `${decoration}${path.join(dir, target)}`
            : `${decoration}${clean}${target}`;
        },
      );
      if (lines[i] !== before) {
        changed.push(`seed line ${i + 1}: ${before.trim()} -> ${lines[i].trim()}`);
      }
    }
  }

  return { text: lines.join("\n"), changed };
}
