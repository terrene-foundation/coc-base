/**
 * lib/deferral-surface.js
 *
 * Phase-2 deferral-registry session-start surface. Third sibling of
 * `open-pr-surface.js` ("what is ON the board?") and `unlanded-work-surface.js`
 * ("what never GOT to the board?"); this one answers "what did we PROMISE to
 * build and then not build?" — the 117 dated deferrals in
 * `.claude/test-harness/phase2-deferrals.json`.
 *
 * § Why this surface exists at all
 * --------------------------------
 * The registry is already GREEN and already dated. Its own header states the
 * blindness this closes verbatim: "a deferral that expires on a quiet day is not
 * detected on the day it expires; it is detected on the next PR or push touching
 * `.claude/**`". So the backlog is enforced only when someone happens to edit the
 * artifact tree, and it is surfaced to an operator NEVER. Measured before this
 * landed: all five REGISTERED SessionStart hooks contained zero deferral
 * mentions, and the composed `additionalContext` a real operator sees carried
 * zero (2,414 chars, 0 hits, with the same line-matcher firing on the "Trust
 * Posture" line in the same output — so the zero was a true negative, not a dead
 * matcher).
 *
 * § Why the TOTAL, not a delta
 * ----------------------------
 * Measured at design time: 0 past-expiry, 0 within 30 days, earliest expiry
 * 2026-09-29. A delta-only surface emits NOTHING for 46 days — it would
 * reproduce the exact silence it exists to answer. So the TOTAL is the standing
 * signal and the delta rides ALONGSIDE it, never instead of it. This is the one
 * deliberate divergence from `unlanded-work-surface.js` property 3 (no stored
 * last-seen state): there, the total was already load-bearing and the pointer
 * added only novelty; here the pointer is additive and a lost/absent pointer
 * degrades to "first check", never to a fabricated `+0`.
 *
 * § Design contract — the four properties, same shape as the two siblings
 * ----------------------------------------------------------------------
 *   1. FAIL-OPEN / TRI-STATE. Never blocks, never hangs, never throws. THREE
 *      distinct states, and the distinction is the whole point:
 *        undefined → registry ABSENT → skip SILENTLY (a consumer has no
 *                    registry; a warning there would be pure noise).
 *        null      → registry PRESENT but unreadable/unparseable/wrong-shape →
 *                    "deferral counts NOT verified this session". NEVER rendered
 *                    as a clean or zero board.
 *        summary   → the counts.
 *      Collapsing null into "0 deferrals" is the one bug that would make this
 *      surface lie, so a test pins that the unreadable branch carries no zero
 *      count at all.
 *   2. COUNTS COME FROM THE PRODUCER'S OWN SEMANTICS. Which keys are entries and
 *      when an entry is EXPIRED are decided by
 *      `.claude/bin/phase2-deferral-integrity.mjs`, not re-invented here. See
 *      § Producer parity.
 *   3. RENDER COUNTS, IDS AND DATES ONLY. `reason` and `graduation` are long
 *      free-text derived from ingested proposals and are NEVER rendered; the
 *      ids and dates that ARE rendered go through the ONE shared sanitizer.
 *      See § Injection safety.
 *   4. NO FIELD-SET COUPLING. A parallel lane is backfilling an `accepted_by`
 *      field into every entry. This reads `expires` and `risk` and ignores
 *      everything else, so an added field is invisible to it.
 *
 * § Producer parity (instrument-discipline.md MUST-4)
 * ---------------------------------------------------
 * A field's semantics are fixed by its PRODUCER, not by the reader's question.
 * Three semantics are mirrored from `phase2-deferral-integrity.mjs`:
 *   - `probe_authorship_deferrals` keys beginning `_` are META, not entries
 *     (`_README`); the producer skips them, so this does too — and it applies
 *     the same skip to `deferrals`, which has no `_` keys today but is the same
 *     shape and would otherwise drift.
 *   - `rollout` is a REAL deferral (the producer runs the identical
 *     `validateDeferralDeclaration` over it), so it counts. That single entry is
 *     the difference between 116 and 117.
 *   - `acknowledged_non_deferrals` are explicitly NOT deferrals and are NOT
 *     counted.
 * EXPIRY is `Date.parse(`${exp}T23:59:59Z`)` with an ISO round-trip check, and
 * EXPIRED iff `now > ts` — reproduced byte-for-byte from the producer's
 * `expiryTimestamp` + its `if (nowMs > ts)` branch. It is reproduced rather than
 * imported because the producer is ESM and this is a CommonJS hook lib that
 * cannot `require()` it synchronously. That duplication is the drift risk, so
 * `deferral-surface.test.mjs` imports BOTH and asserts they agree across a date
 * table spanning the boundary — the duplication is pinned, not merely noted.
 *
 * § Injection safety
 * ------------------
 * The rendered block lands VERBATIM in SessionStart additionalContext the agent
 * reads as authoritative. Registry ids are in-repo and author-controlled, but
 * the registry ingests proposals from BUILD and USE streams, so ids are treated
 * as untrusted: every id and date goes through `sanitizeTitle` — the SAME
 * sanitizer `open-pr-surface.js` applies to PR titles, imported rather than
 * re-implemented (`security.md` § Multi-Site Kwarg Plumbing: one helper, every
 * caller routes through it). `risk` renders only if it is a member of a CLOSED
 * LITERAL band set; anything else renders as the fixed string `unknown-band`, so
 * a crafted band string cannot reach the context at all.
 *
 * § Schema recognition — the wrong-shaped registry (E6, 2026-08-14)
 * -----------------------------------------------------------------
 * A file that PARSES but carries no producer section is not a registry. Before
 * this, `{"nonsense": true}` rendered "✓ Phase-2 Deferral Backlog Verified
 * Empty" — MEASURED, at the real `computeDeferralState`/`formatDeferralBlock`.
 * That is `instrument-discipline.md` MUST-1 relocated from an absent file to a
 * wrong-shaped one: the block was identical whether the registry was genuinely
 * clean or was never a registry at all, so no output of it could have falsified
 * "the backlog is empty".
 *
 * The unparseable case was ALREADY correct (loud "counts NOT verified"), so the
 * gap was exactly one branch wide: parseable-but-not-a-registry. It now takes
 * the same NOT-VERIFIED branch, which is also what this file's own § Design
 * contract property 1 already CLAIMED ("wrong-shape → null") — the fix makes the
 * code match a contract it was already documenting.
 *
 * FALSIFYING RESULT, pinned by `consumer-deferral-cascade.test.mjs`: a registry
 * with no recognized schema rendering the verified-empty block.
 *
 * § Scope — what a green from this surface does NOT cover
 * -------------------------------------------------------
 * Stated here because "the deferral surface shipped" must never be read as "the
 * deferral gap is closed" (`evidence-first-claims.md` MUST-6: name the scope a
 * green covers AND what it excludes).
 *
 * COVERS: whichever registry § Distribution resolves — loom's own at loom, the
 * consumer's own at a consumer — at session start.
 *
 * EXCLUDES, explicitly:
 *   - Any CALENDAR guarantee, FROM THIS SURFACE. This is SESSION-triggered, so a
 *     repo nobody opens surfaces nothing, and that exclusion is unchanged.
 *     What DID change is the CI expiry gate, which this comment used to cite as
 *     the SAME blindness: `.github/workflows/coc-artifact-eval.yml` now carries
 *     a `schedule:` arm (`cron: "17 6 * * 1"`, weekly) alongside its activity
 *     arms (`pull_request` / `merge_group` / `push` / `workflow_dispatch`), and
 *     the structural job's `if:` admits a scheduled run — both of its conjuncts
 *     are satisfied by `github.event_name != 'pull_request'` — so the expiry
 *     step DOES fire on the calendar. The calendar hole is therefore closed AT
 *     THE WORKFLOW, for loom's own registry, on a 7-day bound. It is NOT closed
 *     here: a green from THIS surface still carries no calendar claim, and the
 *     two instruments answer different questions rather than substituting for
 *     one another. See the CALENDAR ARM block at `on:` in that workflow for the
 *     cadence, its cost arithmetic, and what a scheduled run does NOT report
 *     (it reds the run; it blocks no merge, because no merge is in flight).
 *
 *     SCOPED, and the scope is the whole point of E6: that arm runs in LOOM's
 *     repo over LOOM's registry. A CONSUMER gets no calendar guarantee from
 *     either instrument — its `.claude/deferrals.json` is read only when someone
 *     opens a session there, and the workflow that fires weekly is not theirs.
 *     A dormant consumer's deferral therefore still expires unseen. That is the
 *     R1 accepted residual in the E6 lane report — named, with an acceptor, a
 *     revisit trigger and a calendar backstop — not an oversight, and not fixed
 *     here. (Verified at merge rather than inherited: the `schedule:` arm and
 *     its `cron: "17 6 * * 1"` were read off the workflow's own `on:` block on
 *     this tree, comments excluded.)
 *   - Whether a consumer USES its registry. Shipping a scaffold makes recording
 *     a deferral POSSIBLE and makes an empty backlog legible; it does not make
 *     anyone write a row. The obligation half is `deferral-registry-locality.md`.
 *
 * DELIBERATELY DROPPED AT THIS MERGE — the "Any CONSUMER's visibility into its
 * OWN deferrals … it is `loom_only`" exclusion that stood here until now. E6 is
 * exactly the change that falsifies it: the lib CASCADES, and its registry ships
 * beside it. Keeping main's side would have restored a claim this same commit
 * disproves, and its closing sentence pointed at `deferral-surface.test.mjs`
 * mutation M2-c as the regression lock — a test this PR INVERTED, so the pointer
 * would have dangled too. § Distribution below carries the current account,
 * including which premise of the old fence was measured FALSE.
 *
 * § Distribution — CASCADES (E6, 2026-08-14; was loom_only)
 * --------------------------------------------------------
 * The prior fence was correct for the prior design and is now wrong for this
 * one. Its reasoning: the reader would ship everywhere while the file it read
 * shipped nowhere, so a consumer would get a surface reading an absent file.
 *
 * ONE PREMISE OF THAT ARGUMENT WAS FALSE AND IS WITHDRAWN. It said the cascading
 * hook would "print a clean board" at every consumer. MEASURED, an absent
 * registry returns `undefined`, which `formatDeferralBlock` renders as `null` —
 * the surface emits NOTHING. The failure would have been SILENT ABSENCE, not a
 * false all-clear. The fence was still right (a surface that can never report is
 * not a surface), but for a milder reason than recorded, and the false version is
 * not repeated here. The acceptance list carried the same false premise; it is
 * corrected in the same change.
 *
 * What actually makes the cascade sound is the SECOND registry path
 * (`CONSUMER_REGISTRY_REL`), which reaches every target — so the reader and a
 * true-for-that-repo file arrive together. MEASURED with the distributor's own
 * `buildPlan` against the real manifest, both poles on one tree:
 *   - `hooks/lib/deferral-surface.js` → skip/loom_only BEFORE, copy/always_include
 *     AFTER, on BOTH lanes for EVERY target.
 *   - `.claude/deferrals.json` → copy/always_include on BOTH lanes for EVERY
 *     target, including the tier-less `prism` lane.
 *   - `.claude/test-harness/phase2-deferrals.json` → skip/EXCLUDE on both lanes
 *     (loom's own registry still ships nowhere, which is why the second path
 *     exists). NOTE: the prior text here said `no_tier_match`; re-measured, the
 *     reason is `exclude` (the `test-harness/**` universal entry). The outcome
 *     was right, the reason was stale.
 *
 * The caller (`session-start.js`) still requires this lib LAZILY inside a
 * try/catch — the #840 broken-on-import pattern. That is now belt-and-braces
 * rather than load-bearing, and it stays: it is what keeps a consumer mid-way
 * through a partial sync from taking the whole SessionStart hook down.
 *
 * @see open-pr-surface.js, unlanded-work-surface.js — the two siblings.
 */

const fs = require("fs");
const path = require("path");
const { sanitizeTitle } = require("./open-pr-surface");

/**
 * The registry, repo-root-relative. NOT configurable: a configurable path would
 * let an environment variable choose which file answers "how many deferrals are
 * open", and the surface would publish that file's number as this repo's backlog.
 */
const REGISTRY_REL = path.join(
  ".claude",
  "test-harness",
  "phase2-deferrals.json",
);

/**
 * The CONSUMER registry (E6, 2026-08-14). A build / use / project repo has no
 * `.claude/test-harness/` — that whole subtree is `exclude:`d from every lane
 * (MEASURED: `.claude/test-harness/phase2-deferrals.json` classifies
 * `skip/exclude` on both the use and build lanes for every target). So a
 * consumer's OWN deferrals need a path that actually reaches it, and this is
 * that path: shipped as `{"deferrals": {}}` and listed concretely in
 * `sync-tier-aware.mjs::ALWAYS_INCLUDE`, so it copies to EVERY target on BOTH
 * lanes — including the tier-less `prism` lane, which no tier membership could
 * reach.
 *
 * WHY A SECOND PATH RATHER THAN MOVING THE FIRST. loom's registry is
 * loom-corpus-specific: its entries name loom rule files. A consumer must not
 * inherit that backlog (the "generate your own snapshot" reasoning
 * `hook-event-grandfather.json` records), and loom must not lose its own. Two
 * paths, resolved in a FIXED order, is the whole mechanism.
 */
const CONSUMER_REGISTRY_REL = path.join(".claude", "deferrals.json");

/**
 * Resolution order. FIRST PATH THAT EXISTS WINS — never a merge, never a sum.
 *
 * At loom both files are on disk (loom ships the consumer scaffold from its own
 * tree), and loom's own registry is first, so loom's counts are byte-identical
 * to what they were before this path existed. At a consumer only the second
 * exists. A merge would have made loom's number depend on a file loom does not
 * use, and a sum would have double-counted at loom — both are the same class of
 * quiet arithmetic the tri-state exists to keep out of this surface.
 */
const REGISTRY_CANDIDATES = [REGISTRY_REL, CONSUMER_REGISTRY_REL];

/**
 * The keys that make a parsed object A REGISTRY AT ALL.
 *
 * Every one is a section `phase2-deferral-integrity.mjs` reads by name
 * (`registry.deferrals`, `registry.probe_authorship_deferrals`,
 * `registry.rollout`, `registry.acknowledged_non_deferrals`), so the set is the
 * PRODUCER'S, not this reader's (`instrument-discipline.md` MUST-4). A file
 * carrying none of them is not a registry with nothing in it — it is not a
 * registry, and § Schema recognition explains why those must not render alike.
 */
const RECOGNIZED_SECTIONS = [
  "deferrals",
  "probe_authorship_deferrals",
  "rollout",
  "acknowledged_non_deferrals",
];

/**
 * Read ceiling. The registry is ~200 KB today. A pathological file must not be
 * slurped into a hook on the session-start critical path, and refusing to read
 * it is the UNREADABLE state (null), never a silent zero.
 */
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

/** Rendered-row cap for named past-expiry entries; truncation is disclosed. */
const LIST_LIMIT = 10;

/**
 * The CLOSED literal band set, mirroring the producer's `RISK_MAX_HORIZON_DAYS`
 * keys. A literal array, never derived from the registry being read: deriving it
 * would let the file under inspection widen the set of strings that reach the
 * agent's context.
 */
const RISK_BANDS = ["security", "trust", "process", "hygiene"];

/** Where the last-seen count lives; see § Why the TOTAL, not a delta. */
const LAST_SEEN_FILE = ".deferral-surface-last-seen.json";

/**
 * The producer's expiry semantics, reproduced. `T23:59:59Z` means an entry is
 * live through the whole of its expiry day; the round-trip check rejects
 * `2026-02-31`, which `Date.parse` would otherwise roll forward into March.
 *
 * Pinned against the producer by `deferral-surface.test.mjs` — see
 * § Producer parity for why this is a copy and not an import.
 * @param {unknown} exp
 * @returns {number|null} epoch ms, or null if not a real ISO calendar date
 */
function expiryTimestamp(exp) {
  if (typeof exp !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(exp)) return null;
  const ts = Date.parse(`${exp}T23:59:59Z`);
  if (Number.isNaN(ts) || new Date(ts).toISOString().slice(0, 10) !== exp)
    return null;
  return ts;
}

/**
 * Read + parse the registry. Tri-state, and the three cases are NOT collapsed:
 *   undefined → the file is not there (a consumer, a fresh clone) → skip silent
 *   null      → the file IS there and could not be read/parsed/shaped → warn
 *   object    → the parsed registry
 *
 * Fail-open: nothing here throws. Note the deliberate asymmetry — an absent file
 * is silent, but a present-and-broken one is LOUD, because a broken registry is
 * precisely when the backlog is most likely to be silently wrong.
 * @param {string} cwd
 * @returns {object|null|undefined}
 */
function readRegistry(cwd) {
  const file = resolveRegistryPath(cwd);
  if (file === null) return undefined; // absent everywhere → not this repo's concern
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined; // raced away between resolve and stat
  }
  try {
    if (!st.isFile() || st.size > MAX_REGISTRY_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    if (!hasRecognizedSchema(parsed)) return null; // § Schema recognition
    return parsed;
  } catch {
    return null; // present but unreadable → UNVERIFIED, never zero
  }
}

/**
 * The first candidate that EXISTS, or null when none do.
 *
 * Existence — not readability — decides WHICH file is the registry; whether that
 * file is then readable is `readRegistry`'s question. Splitting it this way keeps
 * a broken loom registry from silently falling through to a consumer scaffold
 * that would answer "0 open" for it.
 *
 * DELIBERATELY NOT try/catch-WRAPPED. A non-string `cwd` throws out of
 * `path.join` here, propagates through `readRegistry` — which is exactly the one
 * throw site `computeDeferralState`'s catch was written for — and lands on the
 * `undefined` (silent skip) disposition, because at that point nothing is known
 * about any registry. Swallowing it here would return `null` from this function
 * and `undefined` from `readRegistry` by a DIFFERENT route, killing the only
 * demonstrated reach into that catch and making this file's own § Design
 * contract commentary about it false. `deferral-surface.test.mjs` asserts the
 * throw as its reach proof, so the swallow REDs there — which is how it was
 * caught.
 * @param {string} cwd
 * @returns {string|null} absolute path, or null when neither candidate exists
 */
function resolveRegistryPath(cwd) {
  for (const rel of REGISTRY_CANDIDATES) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Does this parsed object carry at least one RECOGNIZED, CORRECTLY-SHAPED
 * producer section? (§ Schema recognition)
 *
 * A recognized key present but wrong-shaped (`{"deferrals": 5}`) counts as NO
 * schema, so it lands on the same NOT-VERIFIED branch — the file is broken
 * either way, and the branch that says so is the honest one.
 * @param {object} parsed
 * @returns {boolean}
 */
function hasRecognizedSchema(parsed) {
  return RECOGNIZED_SECTIONS.some((k) => {
    const v = parsed[k];
    return !!v && typeof v === "object" && !Array.isArray(v);
  });
}

/**
 * Every deferral in the registry, flattened to `{key, section, expires, risk}`.
 *
 * Reads ONLY `expires` and `risk` off each entry, so the parallel `accepted_by`
 * backfill — or any future field — passes through unnoticed (property 4).
 * @param {object} registry
 * @returns {Array<{key:string,section:string,expires:unknown,risk:unknown}>}
 */
function collectEntries(registry) {
  const out = [];
  const pushSection = (section, obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [key, decl] of Object.entries(obj)) {
      if (key.startsWith("_")) continue; // `_README` and other meta keys
      if (!decl || typeof decl !== "object" || Array.isArray(decl)) continue;
      out.push({ key, section, expires: decl.expires, risk: decl.risk });
    }
  };
  pushSection("detector", registry.deferrals);
  pushSection("probe", registry.probe_authorship_deferrals);
  // The ROOT deferral. The producer validates it with the same
  // `validateDeferralDeclaration` it runs over every per-rule entry, so it is an
  // entry; omitting it is what makes a count read 116 instead of 117.
  const rollout = registry.rollout;
  if (rollout && typeof rollout === "object" && !Array.isArray(rollout)) {
    out.push({
      key: "rollout (trust-posture.md § Two-Phase Rollout)",
      section: "rollout",
      expires: rollout.expires,
      risk: rollout.risk,
    });
  }
  return out;
}

/**
 * Reduce the registry to the renderable summary.
 *
 * Tri-state in, tri-state out: undefined → undefined, null → null. An UNDATED
 * entry gets its OWN bucket rather than being folded into either "fine" or
 * "past expiry" — an entry with no readable date never ages out, which is the
 * permanent-by-default bug the registry exists to close, so silently counting it
 * as healthy would be the exact silent fallback `zero-tolerance.md` Rule 3
 * blocks.
 *
 * @param {object|null|undefined} registry
 * @param {{now?:number,lastSeen?:number|null}} [opts]
 * @returns {object|null|undefined}
 */
function computeDeferralSummary(registry, opts = {}) {
  if (registry === undefined) return undefined;
  if (registry === null) return null;
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const lastSeen =
    Number.isInteger(opts.lastSeen) && opts.lastSeen >= 0
      ? opts.lastSeen
      : null;

  const entries = collectEntries(registry);
  const pastExpiry = [];
  let undated = 0;
  let nextTs = null;
  let nextKey = null;
  let nextExpires = null;
  const bySection = { detector: 0, probe: 0, rollout: 0 };

  for (const e of entries) {
    if (e.section in bySection) bySection[e.section] += 1;
    const ts = expiryTimestamp(e.expires);
    if (ts === null) {
      undated += 1;
      continue;
    }
    if (now > ts) {
      pastExpiry.push({ key: e.key, expires: e.expires, risk: e.risk, ts });
      continue;
    }
    if (nextTs === null || ts < nextTs) {
      nextTs = ts;
      nextKey = e.key;
      nextExpires = e.expires;
    }
  }

  pastExpiry.sort((a, b) => a.ts - b.ts); // longest-overdue first

  return {
    open: entries.length,
    pastExpiryCount: pastExpiry.length,
    pastExpiry: pastExpiry.slice(0, LIST_LIMIT),
    pastExpiryTruncated: pastExpiry.length > LIST_LIMIT,
    undated,
    nextExpires,
    nextKey,
    bySection,
    lastSeen,
    // null (not 0) when there is no pointer: "no prior reading" and "no change
    // since the prior reading" are different facts and the renderer says so.
    delta: lastSeen === null ? null : entries.length - lastSeen,
  };
}

/** A band name, or the fixed string for anything outside the closed set. */
function renderBand(risk) {
  return RISK_BANDS.includes(risk) ? risk : "unknown-band";
}

/** `1 detector` / `2 detectors`. The block is read by a person; agreement matters. */
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Render the agent-visible block. Tri-state in, mirroring both siblings:
 *   undefined → null  (no registry here; skip silently)
 *   null      → the NOT-VERIFIED warning (never a zero/clean board)
 *   summary   → the standing status line
 * `registryRel` names the file in the rendered prose. It DEFAULTS to loom's
 * registry so every existing caller and fixture renders byte-identically; the
 * SessionStart caller passes the path actually resolved, so a consumer is told
 * about ITS file rather than about a loom path it does not have.
 *
 * @param {object|null|undefined} summary
 * @param {string} [registryRel]
 * @returns {string|null}
 */
function formatDeferralBlock(summary, registryRel = null) {
  // UNKNOWN, not "loom's". This defaulted to `REGISTRY_REL` and that was a
  // defect of exactly the kind this file exists to prevent: a value plausible
  // for BOTH questions ("which file did we read?" / "which file does loom
  // read?"), so a caller that never threaded the resolved path got loom's path
  // rendered into a consumer's session context, naming a file absent from that
  // tree (`instrument-discipline.md` MUST-4). MEASURED on a consumer tree
  // holding ONLY `.claude/deferrals.json`: the `one row` branch named loom's
  // path, and the `broken` branch named it AND cited a validator that does not
  // ship there. `renderDeferralBlock` below is the entry point that cannot get
  // this wrong; a bare `null` here means the path is genuinely unknown and NO
  // path claim is made at all.
  const reg =
    typeof registryRel === "string" && registryRel ? registryRel : null;
  if (summary === undefined) return null;
  if (summary === null) {
    // Deliberately carries NO count of any kind. An unreadable registry that
    // rendered "0 open" would be a confident lie in the one state where the
    // backlog is most likely to be wrong. This is ALSO the branch a file that
    // parses but carries no producer section takes (§ Schema recognition) —
    // "not a registry" and "a broken registry" are the same actionable state.
    //
    // The remediation is gated on WHICH candidate actually resolved.
    // `phase2-deferral-integrity.mjs` is loom's validator and does NOT ship
    // (MEASURED: skip/no_tier_match on both lanes for every target), so it is
    // named ONLY when loom's own registry is the file that failed. When the path
    // is UNKNOWN the tool is not named either — a remediation we cannot confirm
    // is runnable here is not a remediation.
    const subject = reg ? `\`${reg}\`` : "The deferral registry";
    const remedy =
      reg === REGISTRY_REL
        ? "Run `node .claude/bin/phase2-deferral-integrity.mjs`"
        : `Repair ${reg ? `\`${reg}\`` : "it"} — it MUST be a JSON object ` +
          `carrying at least one of ` +
          `${RECOGNIZED_SECTIONS.map((k) => `\`${k}\``).join(", ")}`;
    return (
      "# ⚠ Deferral counts NOT verified this session\n\n" +
      `${subject} is present but could not be ` +
      "read, parsed, or shaped as a deferral registry. The deferral backlog is " +
      `UNKNOWN — this is NOT an empty backlog. ${remedy} ` +
      "before trusting any claim about what is or is not deferred."
    );
  }

  const seg = [`${summary.open} open`, `${summary.pastExpiryCount} past-expiry`];
  if (summary.undated) seg.push(`${summary.undated} UNDATED`);
  if (summary.nextExpires)
    seg.push(`next ${sanitizeTitle(summary.nextExpires)}`);
  if (summary.delta === null) seg.push("first check");
  else if (summary.delta === 0) seg.push("no change since last check");
  else
    seg.push(
      `${summary.delta > 0 ? "+" : ""}${summary.delta} since last check`,
    );

  // A genuinely EMPTY registry gets a POSITIVE, hook-verified confirmation —
  // the same shape open-pr-surface uses for a clean board, and the reason this
  // state is legible at all. "0 open, verified this session" and "counts NOT
  // verified" are opposite facts; if the empty case rendered flatly they would
  // read the same at a glance, which is the collapse the tri-state exists to
  // prevent.
  const head =
    summary.pastExpiryCount > 0 || summary.undated > 0
      ? "# ⚠ Phase-2 Deferrals PAST DUE"
      : summary.open === 0
        ? "# ✓ Phase-2 Deferral Backlog Verified Empty"
        : "# Phase-2 Deferral Backlog";

  const lines = [head, "", `deferrals: ${seg.join(" · ")}`];

  if (summary.open === 0) {
    lines.push(
      "",
      "The registry was read at session start and declares **no** open deferrals " +
        "— a live, hook-verified empty backlog, not an unread one. The absence of " +
        "this line means NOT VERIFIED, never empty.",
    );
    return lines.join("\n");
  }

  if (summary.pastExpiryCount > 0) {
    lines.push(
      "",
      "PAST EXPIRY — the declared graduation condition has come due. Satisfy it " +
        "(build the detector / author the probes and DELETE the entry) or renew " +
        "it on the record with a fresh date; silence is not renewal:",
    );
    for (const e of summary.pastExpiry) {
      lines.push(
        `- ${sanitizeTitle(e.key)} (expired ${sanitizeTitle(e.expires)}, ${renderBand(e.risk)})`,
      );
    }
    if (summary.pastExpiryTruncated) {
      lines.push(
        `…and ${summary.pastExpiryCount - summary.pastExpiry.length} more.`,
      );
    }
  }

  if (summary.undated > 0) {
    lines.push(
      "",
      `${plural(summary.undated, "entry carries", "entries carry")} no readable ` +
        "`expires` date. An undated deferral never ages out — that is the " +
        "permanent-by-default bug this registry exists to close, so it is counted " +
        "here separately and is NOT part of the past-expiry figure above.",
    );
  }

  lines.push(
    "",
    `Composition: ${plural(summary.bySection.detector, "deferred Phase-2 detector", "deferred Phase-2 detectors")}, ` +
      `${plural(summary.bySection.probe, "deferred probe suite", "deferred probe suites")}, ` +
      `${plural(summary.bySection.rollout, "root rollout", "root rollouts")}. Registry: ` +
      // Same UNKNOWN discipline as the null branch: name the file only when the
      // resolver told us which one it was. Naming loom's path here was the
      // `one row` half of the measured defect.
      `${reg ? `\`${reg}\`` : "this repo's own deferral registry"}. Graduating one DECREMENTS ` +
      "this count; a slice that leaves it flat graduated nothing.",
  );

  return lines.join("\n");
}

/**
 * Resolve the last-seen pointer's directory. Routed through the SAME state
 * resolver every other per-clone artifact uses, so a worktree session reads and
 * writes the MAIN checkout's pointer rather than minting a private one per
 * worktree. Fail-open: an unresolvable state dir means no delta, never a throw.
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveLastSeenDir(cwd) {
  try {
    const { resolveStateDir } = require("./state-resolver.js");
    const dir = resolveStateDir(cwd);
    return typeof dir === "string" && dir ? dir : null;
  } catch {
    return null;
  }
}

/**
 * The previously recorded open-count, or null when there is none.
 *
 * null is returned for EVERY failure — absent, unreadable, malformed, negative,
 * non-integer — and null renders as "first check", never as a delta. A pointer
 * that cannot be read must not be able to fabricate a movement figure.
 * @param {string} cwd
 * @returns {number|null}
 */
function readLastSeen(cwd) {
  const dir = resolveLastSeenDir(cwd);
  if (!dir) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, LAST_SEEN_FILE), "utf8"),
    );
    const n = parsed && parsed.open;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Record the open-count for the next session.
 *
 * Written via tmp+rename so a concurrent worktree session can never observe a
 * torn file. Concurrency is otherwise benign: every session reads the same
 * registry, so racing writers write the same number. Carries a COUNT and a
 * timestamp only — no operator id, no path, nothing correlatable
 * (`security.md` § "No secrets in logs" / `upstream-issue-hygiene.md` MUST-2).
 * Never called when the count is UNVERIFIED — an unreadable registry must not
 * overwrite a good pointer with a guess.
 * @param {string} cwd
 * @param {number} open
 * @returns {boolean} true iff the pointer was durably written
 */
function writeLastSeen(cwd, open) {
  if (!Number.isInteger(open) || open < 0) return false;
  const dir = resolveLastSeenDir(cwd);
  if (!dir) return false;
  const target = path.join(dir, LAST_SEEN_FILE);
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    if (!fs.existsSync(dir)) return false; // never CREATE the state dir from here
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ open, at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

/**
 * Orchestrating helper: read, summarize, and advance the pointer.
 *
 * Returns undefined (no registry → skip silently), null (unreadable →
 * NOT-VERIFIED), or the summary. Fail-open: any unexpected error degrades to
 * undefined, which renders nothing — a surface that broke must not become a
 * banner claiming the backlog is unknown for a reason it cannot name.
 * @param {string} cwd
 * @param {{now?:number,persist?:boolean}} [opts]
 * @returns {object|null|undefined}
 */
function computeDeferralState(cwd, opts = {}) {
  // Tracks whether the registry was OBSERVED to exist before anything else ran.
  // The catch below needs it: `undefined` and `null` are different claims, and a
  // blanket `undefined` would collapse them. At loom — where the registry DOES
  // exist — an unexpected internal failure returning `undefined` renders NOTHING,
  // which reads as "no registry here" when the truth is "the registry is there
  // and we failed to account for it". That is the same conflation the tri-state
  // exists to prevent, one layer up from `readRegistry`.
  //
  // HONEST SCOPE: this asymmetry is NOT shown reachable. The two throw sites the
  // catch can plausibly see are `readRegistry` (which throws only BEFORE it knows
  // anything — a non-string `cwd` failing `path.join`, hence `undefined`, which is
  // correct) and `computeDeferralSummary` (defensive throughout; no input has been
  // found that makes it throw). A gate-review lens traced reachability here and
  // could not demonstrate it either. So this is a correct DISPOSITION on a path
  // not proven live, not a fix for an observed bug — recorded that way rather
  // than dressed up as one.
  let registryKnownPresent = false;
  try {
    const registry = readRegistry(cwd);
    registryKnownPresent = registry !== undefined;
    const summary = computeDeferralSummary(registry, {
      now: opts.now,
      lastSeen: readLastSeen(cwd),
    });
    if (summary && opts.persist !== false) writeLastSeen(cwd, summary.open);
    return summary;
  } catch {
    // Present-but-unaccounted-for is UNVERIFIED, never a silent skip.
    return registryKnownPresent ? null : undefined;
  }
}

/**
 * Resolve, summarize and render in ONE call — the entry point every caller
 * should use, and the reason `formatDeferralBlock`'s path argument no longer
 * carries a misleading default.
 *
 * The two-call shape (`formatDeferralBlock(computeDeferralState(cwd))`) is the
 * shape a reasonable caller writes, and it silently dropped the resolved path,
 * so the block named loom's registry at a consumer that does not have it. That
 * is not a caller mistake to document — it is an API that invites one, so the
 * correct pairing is made structural here instead.
 *
 * @param {string} cwd
 * @param {{now?:number,persist?:boolean}} [opts]
 * @returns {string|null} the agent-visible block, or null to render nothing
 */
function renderDeferralBlock(cwd, opts = {}) {
  const summary = computeDeferralState(cwd, opts);
  // Resolved AFTER the state call: the same existence check decided which file
  // was read, so the name and the counts cannot come from different files.
  let rel = null;
  try {
    rel = resolveRegistryRel(cwd);
  } catch {
    rel = null; // fail-open — an unknown path renders no path claim
  }
  return formatDeferralBlock(summary, rel);
}

/**
 * The REPO-RELATIVE path of the registry actually in play, or null when neither
 * candidate exists. What the renderer names in its prose. Never throws.
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveRegistryRel(cwd) {
  for (const rel of REGISTRY_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(cwd, rel))) return rel;
    } catch {
      // non-string cwd — fall through to null
    }
  }
  return null;
}

module.exports = {
  readRegistry,
  renderDeferralBlock,
  resolveRegistryPath,
  resolveRegistryRel,
  hasRecognizedSchema,
  collectEntries,
  computeDeferralSummary,
  formatDeferralBlock,
  computeDeferralState,
  readLastSeen,
  writeLastSeen,
  expiryTimestamp,
  REGISTRY_REL,
  CONSUMER_REGISTRY_REL,
  REGISTRY_CANDIDATES,
  RECOGNIZED_SECTIONS,
  LAST_SEEN_FILE,
  LIST_LIMIT,
  RISK_BANDS,
  MAX_REGISTRY_BYTES,
};
