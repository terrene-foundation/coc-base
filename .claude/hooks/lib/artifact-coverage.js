/**
 * artifact-coverage.js — the PURE PREDICATES behind
 * `coc-artifact-eval-coverage.md`'s edit-time detector (graduated from
 * phase2-deferrals.json 2026-09-13): an edit to a `.claude/`
 * prose artifact that lands NO eval coverage for it — no `eval-manifest.json`
 * row, no probe suite on disk, and no sanctioned declaration of the absence.
 *
 * --- HOW THIS DIFFERS FROM `coc-eval-all.mjs`, AND WHY BOTH ARE WARRANTED ----
 * `specs-authority.md` Rule 9 forbids one broken thing producing two findings
 * from two tools. These two tools are DISJOINT by construction, on BOTH axes:
 *
 *   coc-eval-all.mjs  reads the manifest and RUNS each REGISTERED entry's
 *                     structural fixtures. Its subject is the set of rows that
 *                     EXIST; its question is "does this registered scanner
 *                     still grade its fixtures correctly?" An artifact with NO
 *                     row is INVISIBLE to it — there is nothing to iterate.
 *                     It runs in CI, over the whole tree, after the push.
 *
 *   this module       reads the manifest as an AUTHORITY and asks the opposite
 *                     question about ONE file: "is this artifact ABSENT from
 *                     every coverage surface?" It never runs a scanner, never
 *                     grades a fixture, and says nothing about a registered
 *                     artifact. It fires at edit time, before the push.
 *
 * The overlap is empty: the registered set is exactly what the scanner covers
 * and exactly what this predicate WITHDRAWS on. One broken artifact therefore
 * produces at most one finding, from whichever tool can see it.
 *
 * --- DERIVED, NEVER HAND-LISTED --------------------------------------------
 * The two conventions this predicate needs are both read from the manifest's
 * OWN SHAPE rather than restated as a path template, because a predicate keyed
 * on a naming convention a newer convention outgrew is this corpus's recurring
 * defect class:
 *   - the ARTIFACT-ID index  ← every entry's key AND the basename of its
 *                              `fixturesDir` AND the stem of its `probes` path.
 *                              An artifact matching ANY of the three is
 *                              registered, so a future manifest that keys rows
 *                              differently from the file basename still reads
 *                              correctly here.
 *   - the PROBE PATH shape   ← the directory and filename suffix are computed
 *                              from the `probes` values already in the manifest
 *                              (`<dir>/<id><suffix>`). With no entry carrying a
 *                              probes path the shape is UNKNOWN and the
 *                              predicate returns NO finding — a smaller true
 *                              answer, never a false accusation.
 * There is no literal `.probes.json` and no literal probes directory in the
 * decision path below; both appear only as the shape the manifest exhibits.
 *
 * --- THE SANCTIONED CLEAN POLES ---------------------------------------------
 * The rule names three declared ways an artifact legitimately ships without
 * live coverage. Each is honoured here, and each is LIVE-CHECKED — an expired
 * declaration is not a declaration (MUST-4: "an EXPIRED declaration is not a
 * declaration"), so a stale row does not launder a gap into a permanent green:
 *   _declared_empty        (eval-manifest) — the whole manifest declares zero
 *                          structural coverage; every artifact is covered by it.
 *   _deferred_probes       (eval-manifest, keyed by probe PATH) — a suite that
 *                          IS on disk but unregistered.
 *   probe_authorship_      (phase2-deferrals.json, keyed by probe PATH) — a
 *   deferrals              suite that is UNWRITTEN. MUST-4 calls this "the ONLY
 *                          honest exit" for that state.
 *
 * --- SCOPE OF SILENCE — read before citing this predicate's quiet ------------
 * IN scope: `.claude/{rules,agents,commands,skills}/**.md` — the PROSE artifact
 * types whose mandated tier is a probe suite (MUST-1's per-type table).
 * OUT of scope, deliberately and not by oversight:
 *   - `.claude/hooks/**` and `.claude/bin/**`. Their mandated tier is a
 *     STRUCTURAL fixture set with a real scanner, which is precisely what
 *     `coc-eval-all.mjs` already iterates and reds in CI. Firing here too would
 *     be the second finding Rule 9 forbids.
 *   - `_`-prefixed files and `README.md` — navigation, not behaviour-shaping
 *     deliverables; they shape no agent licence and owe no probe.
 *   - non-`.md` files anywhere in the artifact tree.
 *   - EVERY question about whether coverage that DOES exist is ADEQUATE. This
 *     predicate answers presence, never adequacy. Its silence over a registered
 *     artifact means "a row exists", NOT "the artifact is probed well"
 *     (`instrument-discipline.md` MUST-4: an instrument is scoped to the
 *     question it was built for).
 *   - The ARTIFACT TYPE behind a matched id. `deriveManifestIndex` builds ONE
 *     flat id set across every row, so a `type:"rule"` row SILENCES a
 *     same-stemmed artifact of a DIFFERENT type. This is a live FALSE-CLEAN
 *     class, not a hypothetical: at arming, 2026-09-18, of the 14 skill files
 *     this predicate was quiet on, exactly ONE (`background-process-discipline`,
 *     then the only `type:"skill"` row) was genuinely covered (as of 2026-09-27
 *     `trinity` is a second `type:"skill"` row), and the other 13 are silenced by a rule or command
 *     row sharing their stem or their skill-directory name — e.g. the 444-line
 *     skill `skills/12-testing-strategies/probe-driven-verification.md` is
 *     silenced by the `type:"rule"` row for `rules/probe-driven-verification.md`,
 *     a different artifact whose mandatory probe properties are different ones.
 *     So this predicate's quiet over a SKILL was close to meaningless as of the
 *     2026-09-18 measurement.
 *     Fixing it makes the predicate fire MORE, never less.
 *   - WHAT THE EDIT DID. The verdict is a property of the FILE, never of the
 *     diff, so `coc-artifact-eval-coverage.md` MUST-1's same-codify PLUMBING
 *     CARVE-OUT (a cross-reference or allowlist-registration edit adding no
 *     load-bearing MUST / MUST NOT / BLOCKED clause) is structurally invisible
 *     here. That carve-out is the one CONFIRMED false-positive class, and it is
 *     routed at the guard's advisory rather than predicated on — see the guard's
 *     ONE CONFIRMED FALSE-POSITIVE CLASS note (under ARMED) and its
 *     `agent_must_report` item 4 (`artifact-coverage-guard.js`).
 *
 * --- PURITY -----------------------------------------------------------------
 * NOTHING here touches the filesystem, spawns a process, or reads the
 * environment. The manifest, the deferrals registry and the on-disk probe
 * inventory all arrive on the context object, so the fixtures drive the REAL
 * predicates with a SYNTHETIC manifest and never depend on the live one. All
 * I/O lives in `../artifact-coverage-guard.js`.
 *
 * Origin: graduated from `phase2-deferrals.json::deferrals`
 * ["coc-artifact-eval-coverage.md#artifact-edit-without-coverage"] 2026-09-13,
 * whose own reason was "This rule is the one that mandates probe and fixture
 * coverage for other artifacts, so leaving its own enforcement to gate-review
 * means the coverage mandate is itself uncovered."
 */

"use strict";

/**
 * The prose-artifact subtrees. Listed rather than derived because the rule's
 * per-type table is prose and carries no machine-readable form; the OMISSIONS
 * (hooks, bin) are the load-bearing part and are argued in the header above.
 */
const PROSE_ARTIFACT_DIRS = ["rules", "agents", "commands", "skills"];

const FINDING_ID = "coc-artifact-eval-coverage/artifact-edit-without-coverage";

/** Bound every evidence string so a long path cannot flood the response. */
const EVIDENCE_MAX = 300;

function sanitize(s) {
  if (typeof s !== "string") return "";
  const flat = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > EVIDENCE_MAX
    ? flat.slice(0, EVIDENCE_MAX) + "..."
    : flat;
}

/**
 * Normalize an absolute-or-relative path to a repo-relative POSIX path, or
 * null when it does not lie under the given project dir. Pure string work.
 */
function toRepoRelative(filePath, projectDir) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  let p = filePath.replace(/\\/g, "/").trim();
  if (typeof projectDir === "string" && projectDir.trim()) {
    let root = projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === root) return null;
    if (p.startsWith(root + "/")) p = p.slice(root.length + 1);
  }
  p = p.replace(/^\.\//, "");
  if (p.startsWith("/")) {
    // Absolute, and not under the project dir we were told about. Recover the
    // `.claude/...` tail if there is one rather than declaring it out of scope
    // on a project-dir mismatch (a smaller true answer beats a false clean).
    const idx = p.indexOf("/.claude/");
    if (idx === -1) return null;
    p = p.slice(idx + 1);
  }
  return p;
}

/**
 * Is this repo-relative path a PROSE COC artifact this predicate governs?
 * Returns `{inScope, reason, subtree}` — `reason` names the withdrawal so the
 * fixtures can assert WHICH scope restriction fired, not merely that one did.
 */
function classifyArtifactPath(relPath) {
  if (typeof relPath !== "string" || !relPath) {
    return { inScope: false, reason: "no-path" };
  }
  const parts = relPath.split("/").filter(Boolean);
  if (parts[0] !== ".claude" || parts.length < 3) {
    return { inScope: false, reason: "outside-artifact-tree" };
  }
  const subtree = parts[1];
  if (!PROSE_ARTIFACT_DIRS.includes(subtree)) {
    return { inScope: false, reason: "not-a-prose-artifact-subtree" };
  }
  const base = parts[parts.length - 1];
  if (!base.endsWith(".md")) {
    return { inScope: false, reason: "not-a-markdown-artifact" };
  }
  if (base.startsWith("_") || base === "README.md") {
    return { inScope: false, reason: "navigation-not-artifact" };
  }
  return { inScope: true, reason: "prose-artifact", subtree, base };
}

/**
 * Candidate artifact ids for a path, most specific first. A flat
 * `.claude/rules/foo.md` yields `foo`; a nested skill file additionally yields
 * its directory name, which is how a skill is keyed when the file is `SKILL.md`
 * or similar. Any candidate matching the manifest counts as registered.
 */
function candidateIds(relPath) {
  const parts = relPath.split("/").filter(Boolean);
  const ids = [];
  const stem = parts[parts.length - 1].replace(/\.md$/, "");
  if (stem) ids.push(stem);
  if (parts.length >= 4) {
    const dir = parts[parts.length - 2];
    if (dir && !ids.includes(dir)) ids.push(dir);
  }
  return ids;
}

function baseName(p) {
  return typeof p === "string" ? p.split("/").filter(Boolean).pop() || "" : "";
}

function dirName(p) {
  if (typeof p !== "string") return "";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

/**
 * DERIVED registration index + probe-path shape, read out of the manifest the
 * caller supplies. Returns `{ids:Set, probeDir:string|null, probeSuffix:string|null}`.
 * `probeDir`/`probeSuffix` are null when no entry exhibits a probes path — the
 * shape is then UNKNOWN and the caller must not accuse.
 */
function deriveManifestIndex(manifest) {
  const ids = new Set();
  const dirCounts = new Map();
  const suffixCounts = new Map();
  if (!manifest || typeof manifest !== "object") {
    return { ids, probeDir: null, probeSuffix: null };
  }
  for (const [key, entry] of Object.entries(manifest)) {
    if (key.startsWith("_")) continue;
    ids.add(key);
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.fixturesDir === "string") {
      const b = baseName(entry.fixturesDir);
      if (b) ids.add(b);
    }
    if (typeof entry.probes === "string" && entry.probes) {
      const b = baseName(entry.probes);
      const d = dirName(entry.probes);
      if (d) dirCounts.set(d, (dirCounts.get(d) || 0) + 1);
      if (b.startsWith(key) && b.length > key.length) {
        const suf = b.slice(key.length);
        suffixCounts.set(suf, (suffixCounts.get(suf) || 0) + 1);
        ids.add(key);
      }
      // The stem under the derived suffix is also an id alias.
      for (const suf of suffixCounts.keys()) {
        if (b.endsWith(suf)) ids.add(b.slice(0, b.length - suf.length));
      }
    }
  }
  const pick = (m) => {
    let best = null;
    let n = 0;
    for (const [k, v] of m) {
      if (v > n) {
        best = k;
        n = v;
      }
    }
    return best;
  };
  return { ids, probeDir: pick(dirCounts), probeSuffix: pick(suffixCounts) };
}

/**
 * Is a declaration LIVE? A declaration with an `expires` in the past is not a
 * declaration (MUST-4). A missing `expires` is permitted by the manifest's own
 * `_declared_empty` / `_deferred_probes` shape (`{reason, graduation}`), so its
 * absence is not treated as expiry.
 */
function isLiveDeclaration(decl, nowISO) {
  if (!decl || typeof decl !== "object") return false;
  if (typeof decl.expires === "string" && decl.expires.trim()) {
    const exp = Date.parse(decl.expires);
    const now = Date.parse(typeof nowISO === "string" && nowISO ? nowISO : "");
    if (Number.isFinite(exp) && Number.isFinite(now) && exp < now) return false;
  }
  return true;
}

/**
 * The verdict. PURE — every input is supplied by the caller.
 *
 * @param {object} ctx
 * @param {string}  ctx.filePath     the Edit/Write tool_input.file_path
 * @param {string} [ctx.projectDir]  repo root, for relativizing an absolute path
 * @param {object}  ctx.manifest     the parsed eval-manifest.json (the AUTHORITY)
 * @param {object} [ctx.probeAuthorshipDeferrals] phase2-deferrals.json::probe_authorship_deferrals
 * @param {Set<string>|Array<string>|function} [ctx.probeInventory] probe paths present on disk
 * @param {string} [ctx.now]         ISO date used for the expiry check
 * @returns {Array<{rule_id,severity,evidence,artifact,probe_path}>}
 */
function inspectArtifactCoverage(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};

  const rel = toRepoRelative(c.filePath, c.projectDir);
  if (!rel) return [];
  const cls = classifyArtifactPath(rel);
  if (!cls.inScope) return [];

  // FAIL OPEN on an unreadable/unparseable authority (`cc-artifacts.md` Rule 7):
  // with no manifest we cannot tell a registered artifact from an unregistered
  // one, and accusing on a guess is worse than staying quiet.
  if (!c.manifest || typeof c.manifest !== "object") return [];

  const { ids, probeDir, probeSuffix } = deriveManifestIndex(c.manifest);
  const candidates = candidateIds(rel);

  // WITHDRAW 1 — already registered under any candidate id.
  if (candidates.some((id) => ids.has(id))) return [];

  // WITHDRAW 2 — the whole manifest declares zero coverage, and that declaration
  // is still live. A stale one is NOT a declaration and falls through.
  if (isLiveDeclaration(c.manifest._declared_empty, c.now)) return [];

  // The probe-path shape must be DERIVABLE before any probe claim is made.
  if (!probeDir || !probeSuffix) return [];
  const probePaths = candidates.map((id) => `${probeDir}/${id}${probeSuffix}`);

  // WITHDRAW 3 — a probe suite already exists on disk for this artifact.
  const inv = c.probeInventory;
  const present = (p) => {
    try {
      if (typeof inv === "function") return Boolean(inv(p));
      if (inv instanceof Set) return inv.has(p);
      if (Array.isArray(inv)) return inv.includes(p);
    } catch {
      return false;
    }
    return false;
  };
  if (probePaths.some(present)) return [];

  // WITHDRAW 4 — a LIVE sanctioned declaration of the absence, either arm.
  const deferredProbes =
    c.manifest._deferred_probes &&
    typeof c.manifest._deferred_probes === "object"
      ? c.manifest._deferred_probes
      : {};
  const authorship =
    c.probeAuthorshipDeferrals && typeof c.probeAuthorshipDeferrals === "object"
      ? c.probeAuthorshipDeferrals
      : {};
  for (const p of probePaths) {
    if (isLiveDeclaration(deferredProbes[p], c.now)) return [];
    if (isLiveDeclaration(authorship[p], c.now)) return [];
  }

  return [
    {
      rule_id: FINDING_ID,
      severity: "advisory",
      artifact: rel,
      probe_path: probePaths[0],
      evidence: sanitize(
        `\`${rel}\` has no row in eval-manifest.json under any of [${candidates.join(", ")}], ` +
          `no probe suite at \`${probePaths[0]}\`, and no live _declared_empty / _deferred_probes / ` +
          `probe_authorship_deferrals declaration covering it. MUST-1: a prose artifact added or ` +
          `modified in a /codify ships a probe set; MUST-4: its Detection block names the binding.`,
      ),
    },
  ];
}

module.exports = {
  EVIDENCE_MAX,
  FINDING_ID,
  PROSE_ARTIFACT_DIRS,
  candidateIds,
  classifyArtifactPath,
  deriveManifestIndex,
  inspectArtifactCoverage,
  isLiveDeclaration,
  toRepoRelative,
};
