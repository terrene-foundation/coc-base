/**
 * dispatch-contract.js — the PURE decision half of the dispatch-contract guard
 * (`orchestrator-context-economy.md` MUST-5 + MUST-6).
 *
 * The predicates are deliberately asymmetric in the signal each rests on — and the asymmetry is
 * load-bearing, because it is what decides which of them may carry teeth. (a) and (b) read PROSE
 * and are capped at `halt-and-report`; (c) reads the FILESYSTEM and blocks. See § (c) inline.
 * (e) `detectLaneBriefWithoutPartition` — wip-discipline MUST-9 — reads prose on every half and
 * costs throughput rather than a turn when missed, so it is capped LOWER still, at `advisory`.
 * See § (e) inline.
 *
 *   (a) NAMED DISPATCH WITHOUT A PUSH-DELIVERY INSTRUCTION — MUST-6.
 *       A dispatch carrying a `name` creates a PERSISTENT MAILBOX agent. That shape never
 *       auto-returns: it stops, and its output reaches the orchestrator only if the brief told it
 *       to PUSH (`SendMessage` to main). A one-shot "return your findings" contract — correct for
 *       an UNNAMED dispatch, whose final message IS the return value — is a no-op against a mailbox
 *       agent, and the lane reads as idle. The `name` half is STRUCTURAL (a field present in
 *       `tool_input` at this moment and nowhere else); the "does the brief say to push" half is
 *       LEXICAL, which caps the finding at halt-and-report per `hook-output-discipline.md` MUST-2.
 *
 *   (b) WRITE-IMPLYING TASK ROUTED TO A READ-ONLY AGENT — MUST-5.
 *       The tool inventory is read from the target agent's OWN frontmatter `tools:` line — a
 *       PARSED DOCUMENT FIELD, which `hook-output-discipline.md` MUST-5(a) names as a fencing-grade
 *       signal. The trigger half ("does this task imply writing") is lexical prose classification,
 *       so the COMPOSED finding is capped at halt-and-report too. Stated plainly rather than
 *       inflated: only the inventory half is structural, and a detector is no stronger than its
 *       weakest half.
 *
 * BOTH FAIL OPEN. An unresolvable agent type, an unreadable agents dir, a malformed payload, a
 * missing `tools:` line — every one returns null. A guard that guesses when it cannot see produces
 * false positives on exactly the dispatches it least understands, and a noisy advisory is one the
 * orchestrator learns to skip past.
 *
 * NO PROMPT TEXT IS RETAINED. Findings carry a bounded, truncated evidence string; nothing here
 * writes to disk.
 *
 * Origin: `orchestrator-context-economy.md` § Origin (co-owner-directed, 2026-08-16).
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The dispatch tools whose `tool_input` this module knows how to read. */
const DELEGATION_TOOLS = ["Task", "Agent"];

/**
 * Tools that let a lane WRITE. An agent lacking every one of these cannot do write-implying work,
 * which is the whole of predicate (b)'s structural half.
 */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "MultiEdit"];

/** Cap on evidence echoed back into a hook advisory. */
const EVIDENCE_MAX = 180;

/**
 * Lexical markers for an explicit PUSH delivery instruction. `SendMessage` is the tool that
 * actually delivers; the prose variants are the shapes a brief legitimately uses to name it.
 * Deliberately NARROW — a false "this brief is fine" (miss) costs one advisory that did not fire,
 * while a false "this brief is broken" (false positive) costs orchestrator trust in every later
 * advisory. Under an asymmetric cost the recall/precision trade goes to precision.
 */
const DELIVERY_INSTRUCTION_RX =
  /\bSendMessage\b|\bsend[- ]?message\b|\bpush\s+(?:your\s+)?(?:findings|results?|report|conclusions?)\b|\bmessage\s+(?:the\s+)?(?:main|orchestrator|parent)\b|\breport\s+back\s+(?:to|via)\s+(?:the\s+)?(?:main|orchestrator|parent|SendMessage)\b/i;

/**
 * Lexical markers for a task that implies PRODUCING or MUTATING a file. Verbs only — a noun like
 * "the write path" is not a mandate to write, and matching it would fire on every code-reading
 * brief about I/O.
 */
const WRITE_INTENT_RX =
  /\b(?:write|create|author|edit|modify|update|patch|implement|refactor|rename|delete|remove|fix|add)\b[^.!?]{0,80}?\b(?:file|files|rule|rules|hook|hooks|test|tests|fixture|fixtures|probe|probes|doc|docs|documentation|script|scripts|manifest|module|function|agent|agents|command|commands|skill|skills|config|schema)\b|\b(?:apply|land|commit)\s+(?:the\s+)?(?:patch|change|changes|edit|edits|fix)\b|\bcreate\s+(?:a\s+)?new\s+file\b/i;

/**
 * Prose that explicitly SCOPES a dispatch read-only. When present the write-intent match is
 * withdrawn: a brief saying "READ-ONLY … do not edit any file" that also says "the rule I am
 * writing" is describing the CALLER's work, not the lane's. Without this arm, investigation briefs
 * — the single most common correct use of a read-only agent — would be the detector's loudest
 * false-positive class.
 */
const READ_ONLY_SCOPE_RX =
  /\bREAD[- ]ONLY\b|\bdo\s+NOT\s+(?:edit|write|modify|create)\b|\bdon't\s+(?:edit|write|modify|create)\b|\bwithout\s+(?:editing|writing|modifying)\b|\bno\s+(?:edits?|writes?)\b/i;

/** Truncate + single-line an evidence fragment so an advisory stays bounded. */
function clip(s, max = EVIDENCE_MAX) {
  if (typeof s !== "string") return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** The dispatch NAME, or "" when the dispatch is unnamed. Structural. */
function dispatchNameOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const n = toolInput.name;
  return typeof n === "string" ? n.trim() : "";
}

/** The requested subagent type, or "" when absent. Structural. */
function subagentTypeOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const t = toolInput.subagent_type ?? toolInput.subagentType;
  return typeof t === "string" ? t.trim() : "";
}

/** The dispatch brief. Both `prompt` and `description` are read; they are one prose surface here. */
function promptOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const parts = [];
  if (typeof toolInput.prompt === "string") parts.push(toolInput.prompt);
  if (typeof toolInput.description === "string")
    parts.push(toolInput.description);
  return parts.join("\n");
}

/** True when the brief names an explicit push-delivery mechanism. Lexical. */
function hasPushDeliveryInstruction(prompt) {
  return typeof prompt === "string" && DELIVERY_INSTRUCTION_RX.test(prompt);
}

/** True when the brief is explicitly scoped read-only. Lexical. */
function isScopedReadOnly(prompt) {
  return typeof prompt === "string" && READ_ONLY_SCOPE_RX.test(prompt);
}

/**
 * True when the brief implies producing or mutating a file AND is not explicitly scoped read-only.
 * Lexical.
 */
function impliesWrite(prompt) {
  if (typeof prompt !== "string" || prompt === "") return false;
  if (isScopedReadOnly(prompt)) return false;
  return WRITE_INTENT_RX.test(prompt);
}

/**
 * Parse one agent file's frontmatter into `{ name, tools }`. Returns null unless BOTH a `name:` and
 * a `tools:` line are present inside the leading `---` fence — a file we cannot fully parse must
 * not contribute a half-record that later reads as "declares no write tools".
 */
function parseAgentFrontmatter(text) {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let name = "";
  let toolsRaw = null;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "---") break;
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "name") name = m[2].trim().replace(/^["']|["']$/g, "");
    else if (m[1] === "tools") toolsRaw = m[2].trim();
  }
  if (!name || toolsRaw === null) return null;
  const tools = toolsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return { name, tools };
}

/**
 * Build `Map<agentName, string[]>` by walking `<root>/.claude/agents/**\/*.md`.
 *
 * Returns an EMPTY map on any failure. An empty map makes every lookup unresolvable, which makes
 * predicate (b) return null everywhere — the fail-open direction. `readAgentInventory` is the only
 * function in this module that touches the filesystem, so the two detectors below stay pure and
 * directly probeable with an injected map.
 */

// ── SHADOWING SIDE CHANNEL ────────────────────────────────────────────────────
//
// `.claude/agents/**` is not a signed surface: most rostered agents declare
// `Write`/`Edit`, and any merged PR can add a file there. A file declaring
// `name: <an-existing-agent>` with a narrower `tools:` line therefore SHADOWS the
// real agent, because the inventory keys on `name:` with last-writer-wins.
//
// Surfaced by an adversarial review of the WIP lane-opening predicate, where the
// consequence is concrete: shadow a Bash-holding agent with a read-only record and
// the capability fence clears every dispatch of it. Self-disarm needs no Bash.
//
// Kept as a SEPARATE query rather than folded into the map's VALUES, so the reader
// stays one function and each consumer picks its own fail direction.
//
// CARRIED ON THE INVENTORY ITSELF, not in a module-level root-keyed registry. The
// registry shape (removed 2026-09-14) could not tell an UN-PRIMED root from a
// genuinely CLEAN one: both returned `new Set()`, i.e. "no duplicates", i.e. clean.
// That is the non-discriminating instrument `instrument-discipline.md` MUST-1 blocks
// as evidence — and its own docstring pushed the burden onto a consumer it gave no
// means to discharge ("a fail-CLOSED consumer must treat an un-primed call as
// unresolved"), with nothing exposed to tell the two apart. MEASURED before the fix:
// `duplicateAgentNames("/nonexistent")` and `duplicateAgentNames(".")` both returned
// an empty set on a repo with 39 agents and zero duplicates. Attaching the fact to
// the object it describes makes the distinction STRUCTURAL: a Map that carries the
// marker was scanned, one that does not was not, and a hand-built Map (every fixture
// `new Map([...])`) correctly reads UNKNOWN rather than clean.
const SHADOWED = Symbol("shadowedAgentNames");

/**
 * Agent names declared by MORE THAN ONE file under `<root>/.claude/agents/**`.
 *
 * @param {Map<string,string[]>} inventory a map returned by `readAgentInventory`.
 * @returns {Set<string>|null} the shadowed names, or **`null` for UNKNOWN** when the
 *   map did not come from a directory scan. Tri-state on purpose: an empty Set means
 *   "scanned, none found", `null` means "never looked" — collapsing the two is what
 *   made the previous shape unusable as a fence.
 */
function duplicateAgentNames(inventory) {
  if (!inventory || typeof inventory.get !== "function") return null;
  const s = inventory[SHADOWED];
  return s instanceof Set ? s : null;
}

function readAgentInventory(rootDir) {
  const out = new Map();
  const _dupes = new Set();
  // Non-enumerable so the marker never shows up in a spread, `Object.keys`, or a
  // JSON render of the map wrapper; Symbol-keyed so it cannot collide with an agent
  // name. Attached BEFORE the walk, so even a throw mid-walk leaves the map marked
  // as scanned rather than reading as never-looked.
  Object.defineProperty(out, SHADOWED, { value: _dupes, enumerable: false });
  const base = path.join(rootDir || ".", ".claude", "agents");
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) {
        let text;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const rec = parseAgentFrontmatter(text);
        if (rec) {
          // SHADOWING: the map is keyed on the frontmatter `name:`, NOT the
          // filename, and this is last-writer-wins over readdir order. Two files
          // may therefore declare the same name, and the one that survives is an
          // artefact of directory iteration. Recorded on a side channel rather
          // than resolved here, because the right disposition DIFFERS per
          // consumer and this reader must not pick one for both. `canWrite` /
          // `detectWriteTaskToReadOnlyAgent` read `out` and must keep failing
          // OPEN on an unknown type; `detectShadowedAgentDispatch` reads the
          // side channel and surfaces the ambiguity itself. Additive — `out` is
          // unchanged, so no existing caller's behaviour moves.
          if (out.has(rec.name)) _dupes.add(rec.name);
          out.set(rec.name, rec.tools);
        }
      }
    }
  };
  walk(base, 0);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────
// (c) A DECLARED WORKING DIRECTORY THAT DOES NOT EXIST — the STRUCTURAL predicate.
//
// SEVERITY: `block`, and this is the ONE arm in this module that may carry teeth.
//
// The two predicates above rest on a lexical read of prose, so `hook-output-discipline.md`
// MUST-2 caps them at `halt-and-report`. This one rests on `fs.existsSync` — a filesystem
// FACT, which MUST-2 names explicitly as a block-grade signal.
//
// WHY "no stronger than its weakest half" does NOT transfer here. In predicate (b) the
// lexical half is part of the VERDICT: a brief that merely READS write-y produces a finding
// directly, so a prose rewrite changes the answer. Here the lexical half is only a SCOPE
// GATE — it selects WHICH token to test — and the verdict is issued by the filesystem. An
// over-matched token cannot produce a block on its own: it must ALSO parse as an absolute
// path AND that path must be absent from disk. And the evasion direction is safe: phrasing
// that dodges the anchor set yields NO extraction, which is a MISS (fail open), not a
// bypass of a decision already made.
//
// COST ASYMMETRY, which is what actually justifies teeth over an advisory:
//   - False positive: one `git worktree add`, or one one-shot receipt, in the same turn.
//   - False negative: the dispatched agent's STEP-0 assertion correctly refuses, and the
//     ENTIRE dispatch is wasted. Measured this session: a lane dispatched at a worktree
//     path that did not exist. The orchestrator cannot see the harm at call time — which is
//     precisely when `halt-and-report` would hand the decision back to it.
// ───────────────────────────────────────────────────────────────────────────────────────

/**
 * An ABSOLUTE path token (POSIX `/...` or Windows `C:\...`).
 *
 * The lookbehind is the URL / relative-path fence, and each excluded character is there for
 * a measured reason:
 *   `:` and `/` → `https://host/x` must not yield `//host/x`
 *   alphanumerics → `host/x` is relative, not a root path
 *   `.`          → `./x` and `../x` are relative
 *   `~`          → `~/repos/x` is home-relative; `existsSync` does NOT expand it, so
 *                  testing it would fabricate a missing-path verdict on a valid brief
 */
const ABS_PATH_RX =
  // eslint-disable-next-line no-useless-escape
  /(?<![A-Za-z0-9_:/\\~.-])(\/[^\s"'`()[\]{}<>|,;]+|[A-Za-z]:[\\/][^\s"'`()[\]{}<>|,;]+)/g;

/**
 * The SCOPE GATE: prose that marks the following path as a place the lane is told to WORK,
 * as opposed to a file it is merely told to read. Anchored to the END of a bounded lookback
 * window and forbidden from crossing a sentence boundary (`[^.!?]`), so an anchor in a
 * previous sentence cannot capture an unrelated path.
 */
const WORKDIR_ANCHOR_RX =
  /\b(?:cd|chdir|worktree|work[- ]?tree|working[- ]?director(?:y|ies)|workdir|cwd|root(?:ed)?\s+(?:at|in)|work(?:ing)?\s+(?:only\s+)?(?:in|from|at)|located\s+at|checkout|repo(?:sitory)?\s+at)\b[^.!?]{0,60}$/i;

/** How far back to look for an anchor. Bounded so a long brief cannot spin the hook. */
const ANCHOR_LOOKBACK = 140;

/**
 * Prose marking the anchored path as one the lane is told to STAY OUT OF, rather than one
 * it is told to work in. Same bounded, sentence-fenced shape as `WORKDIR_ANCHOR_RX`, and
 * applied to the SAME lookback window.
 *
 * WHY THIS EXISTS, measured rather than supposed: `cd` is an anchor token, and
 * "NEVER cd to /x" anchors IDENTICALLY to "cd /x". Before this guard, a brief that pinned
 * its real root AND forbade a non-existent sibling emitted `block` on the FORBIDDEN path —
 * a `block` on a correct brief, which is the register operators switch off
 * (`hook-output-discipline.md` MUST NOT, detectors that block instructed work).
 *
 * Fail-open by construction: suppressing extraction yields [], and [] is "nothing
 * measured", which this module already refuses to turn into a finding.
 */
const WORKDIR_PROHIBITION_RX =
  /\b(?:never|do\s+not|don'?t|must\s+not|avoid|outside(?:\s+of)?|other\s+lanes'?|off[- ]limits)\b[^.!?]{0,80}$/i;

/**
 * Prose saying the path will be BROUGHT INTO EXISTENCE by this very brief. Applied
 * GLOBALLY (not windowed) and biased toward fail-open: if the brief anywhere instructs
 * creation, a not-yet-existing path is the EXPECTED state, not a dead spawn.
 */
const WILL_CREATE_RX =
  /\bgit\s+worktree\s+add\b|\bmkdir\b|\bwill\s+(?:be\s+)?creat|\bcreate\s+(?:it|the\s+(?:dir|directory|folder|worktree|tree))\b|\bcreate\s+it\s+if\b|\bif\s+(?:it\s+)?(?:does\s+not|doesn't)\s+exist\b|\bdoes\s+not\s+(?:yet\s+)?exist\b/i;

/** Punctuation that is prose, not a path component, when it trails a path token. */
function trimPathPunctuation(p) {
  return p.replace(/[.,;:!?'"`)\]}]+$/, "");
}

/**
 * Does this brief say it will BRING ITS WORKING DIRECTORY INTO EXISTENCE?
 *
 * A named seam over `WILL_CREATE_RX`. It was exported so a SECOND consumer —
 * `lane-opening-capability.js`, the predicate for the WIP ceiling's
 * `PreToolUse:Task|Agent` arm — would read the SAME sentence rather than copy the
 * regex; that consumer asked the inverse of `detectMissingWorkdirPath`'s question
 * ("does the brief open a lane" vs "is a declared path missing when the brief did
 * NOT promise to create it") and both turned on this one discriminator.
 *
 * THAT CONSUMER IS GONE (2026-09-14). The `Task|Agent` arm was deregistered on
 * 2026-08-29 (`b77a71603`) and its code and predicate were deleted once the dead
 * branch was measured; the export is retained as a named seam over the regex, but
 * it currently has NO caller, and this paragraph says so rather than leaving a
 * second-reader claim the tree no longer supports. If a second reader returns, the
 * one-regex-one-meaning argument above applies again unchanged
 * (`security.md` § Enforcement-Surface Parity).
 *
 * Fail-open by construction: a brief this cannot read returns false, which for
 * `detectMissingWorkdirPath` means "test the path" — it does not manufacture a
 * verdict.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
function briefDeclaresWorkdirCreation(prompt) {
  return typeof prompt === "string" && WILL_CREATE_RX.test(prompt);
}

/**
 * Absolute paths the brief designates as a WORKING DIRECTORY for the lane.
 *
 * Returns [] for every unknown — no prose, a relative path, a URL, or a path with no
 * workdir anchor in front of it. [] means "nothing measured", and nothing measured must
 * never become a finding.
 *
 * @param {string} prompt
 * @returns {string[]} deduped absolute paths
 */
function extractDeclaredWorkdirs(prompt) {
  if (typeof prompt !== "string" || prompt === "") return [];
  const out = [];
  ABS_PATH_RX.lastIndex = 0;
  let m;
  while ((m = ABS_PATH_RX.exec(prompt)) !== null) {
    const raw = m[1];
    const start = m.index;
    const before = prompt.slice(Math.max(0, start - ANCHOR_LOOKBACK), start);
    if (!WORKDIR_ANCHOR_RX.test(before)) continue;
    // NEGATIVE FENCE: the anchor sits inside a prohibition, so this path is one the lane
    // is told to AVOID. Extracting it turns "never go here" into "you are rooted here".
    if (WORKDIR_PROHIBITION_RX.test(before)) continue;
    // BRACE TRUNCATION: `ABS_PATH_RX` excludes `{`, `}` and `,`, so a shell brace
    // expansion — `/repos/lane-{a,b,c}`, the ordinary way a brief names a SET of sibling
    // paths — stops the token at the prefix `/repos/lane-`. That prefix is not a path and
    // has never existed, so testing it fabricates a missing-path verdict. MEASURED: the
    // character immediately after the token is deterministically `{` in that case, and is
    // never `{` for a legitimate pin.
    if (prompt[start + raw.length] === "{") continue;
    const cleaned = trimPathPunctuation(raw);
    // A bare "/" carries no information and is never a real worktree designation.
    if (cleaned.length < 2) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

/**
 * The STRUCTURAL predicate — a brief that roots a lane at an absolute path which is not
 * there. Such a dispatch cannot succeed: the STEP-0 assertion every worktree brief is
 * required to carry (`agents.md` § Worktree Orchestration) will correctly refuse, and the
 * whole agent turn is spent discovering that.
 *
 * @param {object} toolInput  the PreToolUse `tool_input`
 * @param {object} [opts]
 * @param {function} [opts.existsSync] injectable resolver; defaults to the real fs so the
 *                                     production path is the DEFAULT rather than an
 *                                     opt-in a caller can forget to wire.
 * @returns {{rule_id:string,severity:string,evidence:string,missing:string[]}|null}
 */
function detectMissingWorkdirPath(toolInput, opts) {
  const exists =
    opts && typeof opts.existsSync === "function"
      ? opts.existsSync
      : fs.existsSync;

  const prompt = promptOf(toolInput);
  if (prompt === "") return null;

  // Fail open when the brief itself creates the directory.
  if (WILL_CREATE_RX.test(prompt)) return null;

  const declared = extractDeclaredWorkdirs(prompt);
  if (declared.length === 0) return null;

  const missing = [];
  for (const p of declared) {
    let present;
    try {
      present = exists(p);
    } catch {
      // An unmeasurable path is an UNKNOWN. A guard that cannot measure must not block.
      return null;
    }
    if (!present) missing.push(p);
  }
  if (missing.length === 0) return null;

  return {
    // Attributed to `agents.md` § Worktree Orchestration, whose clause-scoped wiring
    // (2026-08-11) states that the nested-worktree guard carries the PLACEMENT half
    // structurally and that the ABSOLUTE-path-pin half is NOT reached by it. This is that
    // half. Deliberately NOT re-homed onto orchestrator-context-economy, which owns the
    // two lexical predicates above and nothing here.
    rule_id: "agents/worktree-orchestration-absolute-path-pin",
    severity: "block",
    missing,
    evidence:
      `the brief roots this lane at ${missing.length === 1 ? "a path that does not exist" : "paths that do not exist"}: ` +
      `${missing.map((p) => clip(p, 120)).join(", ")}. This dispatch cannot succeed — the STEP-0 ` +
      `assertion will refuse and the entire agent turn is spent discovering that. Create the ` +
      `worktree/directory FIRST (the orchestrator creates it, per agents.md § Worktree ` +
      `Orchestration), then re-issue with the path that now exists.`,
  };
}

/**
 * Tri-state, deliberately NOT a boolean: "yes it can write", "no it cannot", "I do not know".
 * Collapsing UNKNOWN into either pole is the non-discriminating-instrument shape — a built-in type
 * (`general-purpose`, `Explore`) has no file under `.claude/agents/`, and reading its absence as
 * "declares no write tools" would fire on the most common dispatch in the repo.
 */
function canWrite(agentType, inventory) {
  if (!agentType || !inventory || typeof inventory.get !== "function")
    return null;
  const tools = inventory.get(agentType);
  if (!Array.isArray(tools)) return null;
  if (tools.includes("*")) return true;
  return tools.some((t) => WRITE_TOOLS.includes(t));
}

/**
 * MUST-6 — a NAMED dispatch whose brief carries no push-delivery instruction.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @returns {{rule_id:string,severity:string,evidence:string}|null}
 */
function detectNamedDispatchWithoutDelivery(toolInput) {
  const name = dispatchNameOf(toolInput);
  if (!name) return null; // UNNAMED dispatch auto-returns; the contract does not apply.
  const prompt = promptOf(toolInput);
  if (prompt === "") return null; // Nothing to read; fail open rather than guess.
  if (hasPushDeliveryInstruction(prompt)) return null;
  return {
    rule_id: "orchestrator-context-economy/MUST-6",
    severity: "halt-and-report",
    evidence:
      `named dispatch "${clip(name, 60)}" carries no push-delivery instruction. A NAMED dispatch ` +
      `is a persistent mailbox agent: it never auto-returns, so a one-shot "return your findings" ` +
      `contract delivers nothing and the lane reads as idle. Either instruct it to SendMessage the ` +
      `orchestrator when done, or drop the name and dispatch it unnamed.`,
  };
}

/**
 * A dispatch to an agent name declared by MORE THAN ONE file under `.claude/agents/**`.
 *
 * WHY THIS IS A FINDING AND NOT HYGIENE NOISE. `readAgentInventory` is last-writer-wins over
 * readdir order, so for a shadowed name the tool set the orchestrator BELIEVES it granted and the
 * one the harness resolves are decided by directory iteration. That lands on a LIVE consumer, not
 * only on the deleted capability fence: `detectWriteTaskToReadOnlyAgent` fires on `canWrite ===
 * false`, so a shadowed name whose read-only record happens to survive yields a MUST-5 finding
 * against an agent that may in fact be write-capable — and the reverse resolution yields silence
 * against one that is not. Under shadowing that detector does not fail open; it fails ARBITRARILY,
 * and nothing in its evidence says so.
 *
 * SEVERITY — `halt-and-report`, deliberately NOT `block`, and this is a narrowing of what the
 * signal would permit. The evidence is purely structural (two files on disk declare one name; no
 * lexical half at all), which `hook-output-discipline.md` MUST-2 would allow teeth for. Teeth are
 * declined on the cost asymmetry this module uses for the workdir arm: a false negative here does
 * NOT waste the turn by construction — the dispatch may run correctly, or halt at a tool boundary
 * that names itself — while a block would refuse every dispatch to that name for a repo-hygiene
 * defect the orchestrator may not own and did not commit in this turn. Handing the decision back
 * is the whole point: the orchestrator can see BOTH records and pick, which is exactly the moment
 * the deleted fence used to cover.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @param {Map<string,string[]>} inventory agent-name → declared tools, from `readAgentInventory`
 * @returns {{rule_id:string,severity:string,evidence:string}|null}
 */
function detectShadowedAgentDispatch(toolInput, inventory) {
  const agentType = subagentTypeOf(toolInput);
  if (!agentType) return null;
  const shadowed = duplicateAgentNames(inventory);
  // UNKNOWN (`null`) is not clean. A map that was never scanned cannot answer the question, so
  // this arm reports NOTHING rather than an all-clear — the fail-open direction, chosen because a
  // finding invented from an unscanned map would be a claim about a corpus nobody read.
  if (!shadowed || !shadowed.has(agentType)) return null;
  const declared = inventory.get(agentType) || [];
  return {
    rule_id: "agents/agent-definition-shadowing",
    severity: "halt-and-report",
    evidence:
      `dispatch to "${clip(agentType, 60)}" — that agent name is declared by MORE THAN ONE file ` +
      `under .claude/agents/. Which definition wins is last-writer-wins over directory iteration, ` +
      `so the tool grant this dispatch actually receives is not the one you can read off any single ` +
      `file; the resolved set this run is [${clip(declared.join(", "), 80)}]. Every capability read ` +
      `of this name — including this guard's own MUST-5 write-capability check — is arbitrary until ` +
      `it is resolved. Rename or delete one of the declaring files, then re-issue.`,
  };
}

/**
 * MUST-5 — a write-implying task routed to an agent whose declared tools cannot write.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @param {Map<string,string[]>} inventory agent-name → declared tools
 * @returns {{rule_id:string,severity:string,evidence:string}|null}
 */
function detectWriteTaskToReadOnlyAgent(toolInput, inventory) {
  const agentType = subagentTypeOf(toolInput);
  if (!agentType) return null;
  const writable = canWrite(agentType, inventory);
  if (writable !== false) return null; // true → fine; null → UNKNOWN, fail open.
  const prompt = promptOf(toolInput);
  if (!impliesWrite(prompt)) return null;
  const declared = inventory.get(agentType) || [];
  return {
    rule_id: "orchestrator-context-economy/MUST-5",
    severity: "halt-and-report",
    evidence:
      `dispatch to "${clip(agentType, 60)}" implies producing or mutating a file, but that agent ` +
      `declares tools [${clip(declared.join(", "), 80)}] — none of ${WRITE_TOOLS.join("/")}. The ` +
      `lane will halt at the first file-edit boundary. Re-target a write-capable agent, or scope ` +
      `the brief READ-ONLY and do the edits in the orchestrator.` +
      writeCapableHint(inventory, agentType),
  };
}

/**
 * Name the WRITE-CAPABLE alternatives, derived from the SAME inventory that decided the mismatch.
 *
 * WHY THIS EXISTS, measured rather than supposed. This detector fired correctly three times in one
 * session against the same orchestrator, and was worked around all three times — not because the
 * finding was wrong or unclear, but because of an ASYMMETRY IN REMEDY COST. It named two correct
 * remedies ("re-target a write-capable agent", "scope the brief READ-ONLY") and left BOTH as
 * research: re-targeting means knowing which agent types can write, which is a lookup the
 * orchestrator does not have in hand at dispatch time. Meanwhile the WRONG remedy — send the
 * running agent a correction — is one call away and feels responsive. A halt-and-report whose
 * correct remedy costs more than its incorrect one selects for the incorrect one, and it does so
 * reliably enough to look like negligence when it is structure.
 *
 * The third instance cost a full round trip: a read-only lane produced a complete change
 * SPECIFICATION it could not apply, which then had to be handed to a second agent to type in.
 *
 * So the fix is not a louder message. It is to make the correct remedy the CHEAP one, by carrying
 * the answer the orchestrator would otherwise have to go and find. The list is DERIVED from the
 * live inventory through `canWrite` — the same predicate that produced the finding — so it cannot
 * drift from it and cannot name an agent that does not exist. If the inventory is unreadable the
 * hint is OMITTED rather than guessed: a wrong re-target suggestion would spend the trust this
 * advisory needs, and silence here costs only the research it already cost.
 *
 * @param {Map<string,string[]>} inventory agent-name → declared tools
 * @param {string} exclude the agent type that was just refused
 * @returns {string} a leading-space hint, or "" when nothing can be named
 */
function writeCapableHint(inventory, exclude) {
  if (!inventory || typeof inventory.keys !== "function") return "";
  let names;
  try {
    names = Array.from(inventory.keys());
  } catch {
    return "";
  }
  const capable = names
    .filter((n) => n && n !== exclude && canWrite(n, inventory) === true)
    .sort();
  if (capable.length === 0) return "";
  // Cap the list: an exhaustive roster is another thing to read past. A handful is enough to make
  // the swap mechanical, and the count tells the reader the list was trimmed rather than partial.
  const shown = capable.slice(0, 6);
  const more = capable.length - shown.length;
  return ` Write-capable here: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`;
}

/**
 * worktree-isolation MUST-10 — a brief that will build a REPOSITORY FIXTURE without pinning where
 * git runs. Folded into that rule rather than minting a new one: the corpus sits at its declared
 * ceiling, where adding a rule requires retiring one, and the obligation belongs with the contract
 * that already governs where delegated work operates.
 *
 * ORIGIN, measured: a security lens dispatched to build adversarial git fixtures ran its commands
 * with no `-C`, so every one resolved to the ORCHESTRATOR'S OWN CHECKOUT. Nine fixture commits
 * landed on the repo, nine junk branches appeared, the working tree left its branch, `origin` was
 * repointed at a non-existent path, and SEVEN branches were pushed to the real remote. Nothing was
 * lost — every tip was recorded before deletion and the refs were archived — but the repair cost a
 * session, and the cause was one sentence absent from a brief.
 *
 * The containment clause has been carried by hand in every brief since. Prose that must be
 * remembered per-dispatch is exactly what this predicate replaces: it fires at the moment the
 * orchestrator is about to send an unpinned fixture brief, which is where the incident began.
 *
 * SEVERITY `halt-and-report`, never `block`: the predicate is LEXICAL over prompt prose, and
 * `hook-output-discipline.md` MUST-2 bars `block` on a lexical signal. The ceiling is the same one
 * `detectNamedDispatchWithoutDelivery` sits at, for the same reason.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @returns {{rule_id:string,severity:string,evidence:string}|null}
 */
function detectUnpinnedFixtureDispatch(toolInput) {
  const prompt = promptOf(toolInput);
  if (!prompt) return null;
  // Does the brief ask for a REPOSITORY fixture? Both halves must be present: a git-repository noun
  // AND a build verb. "read the git log" is neither.
  const buildsRepo =
    /\b(?:git\s+(?:init|repo|repository|fixture)|repo(?:sitory)?\s+fixture|fixture\s+repo(?:sitory)?|commit-tree|scratch\s+repo(?:sitory)?)\b/i.test(
      prompt,
    ) &&
    /\b(?:build|create|author|construct|set\s?up|make|plant|stage)\b/i.test(
      prompt,
    );
  if (!buildsRepo) return null;
  // Is the target PINNED? Only MUST-10's two compliant forms count — see fixtureContainmentOf.
  const { form } = fixtureContainmentOf(prompt);
  if (form === "pin" || form === "forbid") return null;
  const REMEDY =
    "Pin EVERY git call with an absolute `-C <scratch path>` (or `--git-dir`) and assert its " +
    "resolved toplevel before the first write, or state the containment clause (this lane needs " +
    "no repository fixture; never run a git write command).";
  if (form === "pin-without-assertion") {
    return {
      rule_id: "worktree-isolation/MUST-10",
      severity: "halt-and-report",
      evidence:
        "this brief asks the lane to BUILD a repository fixture and pins every git call, but " +
        "mandates no STEP-0 assertion. MUST-10's PIN is both halves: `-C` aimed at a directory that " +
        "is not yet a repository walks UP to the nearest enclosing one, and only an assertion that " +
        "the resolved `rev-parse --show-toplevel` equals the scratch path catches that. " +
        REMEDY,
    };
  }
  return {
    rule_id: "worktree-isolation/MUST-10",
    severity: "halt-and-report",
    evidence:
      "this brief asks the lane to BUILD a repository fixture and pins no git target. An unpinned " +
      "git command resolves to whatever tree the process happens to sit in — measured once as the " +
      "ORCHESTRATOR'S OWN checkout: nine commits landed on the repo and seven branches were pushed " +
      "to the real remote. " +
      REMEDY,
  };
}

/**
 * A git target flag as a TOKEN: `-C` (case-sensitive — `git -c` sets config) or `--git-dir`, never
 * a substring of a longer word. Replaced by TARGET_SENTINEL before the case-insensitive tests run,
 * so the `i` flag those tests need can never widen `-C` into `-c`.
 */
const GIT_TARGET_FLAG_TOKEN_RX =
  /(^|[\s`'"(/])(?:-C|--git-dir)(?=[\s`'"</=]|$)/g;
const TARGET_SENTINEL = "\u0001T";

/** A universal quantifier over git calls — "every git call", "each command", "all invocations". */
const EVERY_GIT_CALL_RX =
  /\b(?:every|each|all)\s+(?:(?:single|one|of\s+(?:its|your|the|their))\s+)?(?:git\s+)?(?:calls?|commands?|invocations?)\b/i;

/** The target is ABSOLUTE: said so, or a concrete absolute path follows the flag. */
const ABSOLUTE_TARGET_RX = new RegExp(
  String.raw`\babsolute\b|\u0001T[\s=]+[\x60'"]?(?:\/|~\/|[A-Za-z]:[\\/])`,
  "i",
);

/**
 * The flag is mentioned only to be REJECTED — "do not use `-C`", or MUST-10's own DO NOT
 * "`git -C` never establishes cwd". Either vetoes the unit it sits in.
 */
const TARGET_FLAG_NEGATED_RX = new RegExp(
  [
    String.raw`\b(?:do\s+not|don'?t|never|must\s+not|should\s+not|avoid)\s+(?:\w+\s+){0,3}?[\x60'"]?(?:git\s+)?\u0001T`,
    String.raw`\u0001T[\x60'"]?\s+(?:<[^>]*>[\x60'"]?\s+|[^\s<]\S*\s+)?(?:never|does\s+not|doesn'?t|cannot|can'?t|won'?t|is\s+not|isn'?t)\b`,
  ].join("|"),
  "i",
);

/** The STEP-0 half, stated inside the pin instruction itself. */
const ASSERTION_IN_UNIT_RX =
  /\bassert(?:s|ed|ing|ions?)?\b|\brev-parse\s+--show-toplevel\b/i;

/**
 * The STEP-0 half anywhere in the brief, bound to a PINNED path: `git -C <path> rev-parse
 * --show-toplevel`. A BARE `rev-parse --show-toplevel` elsewhere is the lane's own worktree STEP-0,
 * which says nothing about the fixture's target, so it is never read as this half.
 */
const PATH_BOUND_ASSERTION_RX =
  /\u0001T[\s=]+(?:<[^>]*>|[`'"]?[^\s`'"]+[`'"]?)\s+rev-parse\s+--show-toplevel\b/;

/**
 * MUST-10's FORBID form.
 *
 * TWO SPELLINGS, and the second exists because the first PUNISHED PRECISION. Until
 * 2026-09-13 this was the canonical sentence ALONE — `never run a git write` — and a brief
 * that forbade git writes MORE specifically scored as carrying no containment at all.
 * MEASURED: a brief reading "NEVER run `git push`, `git reset --hard`, `git clean -f`,
 * `git checkout --`, `git restore`, or `git stash`" is strictly STRONGER than the canonical
 * phrase and matched NOTHING, so MUST-10 fired on six consecutive dispatches whose briefs
 * were safer than the one it would have accepted. Six findings that were correct about the
 * FORM and wrong about the RISK is how an advisory teaches its reader to skim it.
 *
 * The generic spelling is kept verbatim — it is what the finding text tells operators to
 * write, and narrowing that would break the remedy the message prescribes.
 *
 * ENUMERATED spelling, deliberately conservative: a negated `run` in the SAME unit as TWO OR
 * MORE distinct destructive git verbs. TWO is the load-bearing bound. One verb is reachable
 * by ordinary prose — "never run `git push` until CI is green" is a scheduling remark, not a
 * containment clause — while two distinct verbs in one negated sentence is the shape of a
 * deliberate prohibition and is not written by accident. Widening a WITHDRAWAL predicate is
 * where false NEGATIVES enter: every phrase added here can silence a real finding, so the
 * bar is a shape that costs the author intent to produce.
 */
const FORBID_GIT_WRITES_RX = /\bnever\s+run\s+a\s+git\s+write\b/i;

/** A destructive git verb, in the spellings briefs actually use. */
const DESTRUCTIVE_GIT_VERB_RX =
  /\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore|stash|commit|merge|rebase|worktree\s+add|branch\s+-[dD])/gi;

/** A negated imperative: the clause must FORBID, not merely mention. */
const NEGATED_RUN_RX =
  /\b(?:never|do\s+not|don't|must\s+not|no)\b[^.!?]{0,80}?\brun\b/i;

/**
 * True when the brief carries EITHER the canonical forbid sentence or an enumerated
 * prohibition. Unit-scoped for the enumerated form so a negation in one sentence cannot
 * borrow verbs from another.
 *
 * @param {string} prompt the dispatch brief
 * @returns {boolean}
 */
function forbidsGitWrites(prompt) {
  if (typeof prompt !== "string" || !prompt) return false;
  if (FORBID_GIT_WRITES_RX.test(prompt)) return true;
  const units = prompt
    .replace(/\r/g, "")
    .split(/\n\s*\n|(?<=[.!?])\s+|\n(?=\s*(?:[-*•]|\d+[.)])\s)/);
  for (const u of units) {
    if (!NEGATED_RUN_RX.test(u)) continue;
    const verbs = new Set(
      (u.match(DESTRUCTIVE_GIT_VERB_RX) || []).map((v) =>
        v.toLowerCase().replace(/\s+/g, " "),
      ),
    );
    if (verbs.size >= 2) return true;
  }
  return false;
}

/**
 * worktree-isolation MUST-10 — WHICH of the rule's two compliant forms a brief carries.
 *
 *   "pin"                    every git call carries an absolute `-C`/`--git-dir` AND a STEP-0
 *                            assertion is mandated
 *   "pin-without-assertion"  the universal absolute pin, with no assertion
 *   "forbid"                 the lane runs no git write at all
 *   "none"                   neither — including `-C` mentioned only to reject it, and a pin that
 *                            covers SOME calls ("use -C for the init")
 *
 * The PIN is recognised as an INSTRUCTION, not as a token. Within ONE unit (a sentence, list item,
 * or paragraph, hard wraps joined) it needs all of: a `-C`/`--git-dir` token, a universal
 * quantifier over git calls, an absolute marker (the word, or a concrete absolute path — the path
 * is usually unknowable when the brief is written, so a `<scratch path>` placeholder qualifies when
 * called absolute), and no negation of the flag.
 *
 * WHY THE ASSERTION IS REQUIRED. MUST-10's PIN branch reads: "every git call carries an absolute
 * `-C <scratch path>` (or `--git-dir`), WITH a STEP-0 assertion comparing resolved `git rev-parse
 * --show-toplevel` to that path and refusing on mismatch". The half is load-bearing: `-C` aimed at
 * a directory that is not yet a repository walks UP to the nearest enclosing one, so a pin without
 * the assertion can still land in the orchestrator's checkout.
 *
 * ORIGIN of this shape, measured 2026-09-12: the previous test accepted only a literal
 * `-C /abs`, `--git-dir`, or the FORBID phrase, so it fired on every brief carrying the canonical
 * containment clause ("an absolute `-C <scratch path>`/`cwd` on every git call, asserted before the
 * first write") — the rule's own PIN form — while a bare `-C /tmp/x` pinning one call went silent.
 *
 * @param {string} prompt
 * @returns {{form: "pin"|"pin-without-assertion"|"forbid"|"none"}}
 */
function fixtureContainmentOf(prompt) {
  if (typeof prompt !== "string" || !prompt) return { form: "none" };
  const marked = prompt.replace(
    GIT_TARGET_FLAG_TOKEN_RX,
    `$1${TARGET_SENTINEL}`,
  );
  const units = marked
    .replace(/\r/g, "")
    .split(/\n\s*\n|(?<=[.!?])\s+|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)
    .map((u) => u.replace(/\s+/g, " "));
  let universalPin = false;
  let asserted = PATH_BOUND_ASSERTION_RX.test(marked);
  for (const u of units) {
    if (
      u.includes(TARGET_SENTINEL) &&
      EVERY_GIT_CALL_RX.test(u) &&
      ABSOLUTE_TARGET_RX.test(u) &&
      !TARGET_FLAG_NEGATED_RX.test(u)
    ) {
      universalPin = true;
      if (ASSERTION_IN_UNIT_RX.test(u)) asserted = true;
    }
  }
  if (universalPin && asserted) return { form: "pin" };
  if (forbidsGitWrites(prompt)) return { form: "forbid" };
  if (universalPin) return { form: "pin-without-assertion" };
  return { form: "none" };
}

// ───────────────────────────────────────────────────────────────────────────────────────
// (e) A LANE-ORCHESTRATOR BRIEF WITH NO FAN-OUT / PARTITION INSTRUCTION — wip-discipline MUST-9.
//
// SEVERITY: `advisory`, the LOWEST tier this module emits, and it may never rise. Every half of
// this predicate reads PROSE — which brief is a lane orchestrator's, and whether it instructs
// fan-out — so `hook-output-discipline.md` MUST-2 caps it below `block`, and it sits below
// `halt-and-report` too: a brief missing the partition instruction still produces a working
// lane, only a serial one. The cost of the miss is throughput, not a lost turn.
//
// THE SUBJECT EXISTS ONLY HERE. `journal/0608` item 6 names dispatch time as a delivery surface
// for the `journal/0607` contract: a lane is a mini-orchestrator (decision 1) that fans out under
// the partition contract (decision 2). The orchestrator that received that contract still briefed
// every lane as a single serial worker — knowing the rule was not the failure; nothing delivered
// it at the moment the brief was written. `tool_input.prompt` at `PreToolUse:Task|Agent` is that
// moment (`hook-event-selection.md` — the brief exists now and nowhere earlier).
//
// THE DISCRIMINATION IS THE WHOLE JOB, and it runs in three gates, each fail-OPEN:
//   1. LANE     — the brief names a lane worktree: a sibling `<parent>/.<slug>-wt/<name>` path,
//                 or a STEP-0 `rev-parse --show-toplevel` assertion paired with a branch check.
//                 Read over the FULL brief.
//   2. ROLE     — the brief GRANTS commit authority in the second person / imperative, and does
//                 NOT deny it. A LEAF worker brief also names the lane worktree, so gate 1 cannot
//                 tell the two apart; the leaf's tell is a denial ("you EDIT files only", "do not
//                 commit", "do not dispatch sub-agents"), and any denial VETOES. Read over the
//                 brief with QUOTED SUB-BRIEFS STRIPPED, because an orchestrator brief routinely
//                 quotes the leaf brief it wants dispatched, and that quote's denials describe
//                 the WORKER, not the reader.
//   3. PARTITION— which of fan-out / disjoint write sets / single committer the brief never
//                 instructs. Read over the FULL brief, quotes included: a partition element that
//                 appears only inside a quoted sub-brief still reaches the lane, and silence is
//                 the safe direction for an advisory.
//
// PRECISION OVER RECALL, stated as the design and not discovered as a defect: every ambiguity
// resolves toward silence (a denial vetoes a grant; a negated fan-out still counts as fan-out;
// the partition contract cited by name counts for both of its elements). A noisy advisory is one
// the orchestrator learns to skip, which disarms every OTHER finding this guard carries.
// ───────────────────────────────────────────────────────────────────────────────────────

/** The three partition elements, in the order the advisory names them. */
const PARTITION_ELEMENTS = [
  "fan-out",
  "disjoint write sets",
  "single committer",
];

/**
 * A sibling lane-worktree path, `<parent>/.<slug>-wt/<name>`. The name must start alphanumeric, so
 * a DOC PLACEHOLDER (`.<repo-slug>-wt/<name>`) never reads as a real lane.
 */
const LANE_WORKTREE_PATH_RX =
  /[\\/]\.[A-Za-z0-9][A-Za-z0-9._-]*-wt[\\/][A-Za-z0-9][A-Za-z0-9._-]*/;

/** The STEP-0 toplevel assertion `agents.md` § Worktree Orchestration mandates. */
const STEP0_TOPLEVEL_RX = /\brev-parse\s+--show-toplevel\b/;

/** The branch half of a STEP-0 assertion. Required alongside the toplevel half. */
const STEP0_BRANCH_RX =
  /\brev-parse\s+--abbrev-ref\s+HEAD\b|\bsymbolic-ref\b|\bbranch\s+--show-current\b|\bwrong\s+branch\b/i;

/** Sentence-initial or second-person head for an imperative denial. */
const DENY_HEAD =
  String.raw`(?:^|[.!?:;(]\s*|\byou\s+)` +
  String.raw`(?:do\s+not|don'?t|never|must\s+not|may\s+not|should\s+not|shall\s+not|cannot|can'?t)\s+`;

/**
 * A LEAF brief's tell: the reader is denied dispatch, denied commits, or confined to editing.
 * The commit-denial arm ignores ordinary orchestrator hygiene that names a DIFFERENT object —
 * "never commit to main", "do not commit secrets" — which an orchestrator brief carries too.
 */
const LEAF_DENIAL_RX = new RegExp(
  [
    DENY_HEAD +
      String.raw`(?:\w+\s+){0,2}?(?:dispatch|spawn|launch|delegate\s+to|start)\s+(?:any\s+|further\s+|more\s+|new\s+|other\s+)?(?:sub-?agents?|agents?|workers?|teammates?)\b`,
    String.raw`\bno\s+sub-?agents?\b`,
    String.raw`\byou\s+(?:only\s+)?edit\s+(?:files\s+)?only\b`,
    String.raw`\bedit\s+files\s+only\b`,
    DENY_HEAD +
      String.raw`(?:\w+\s+){0,2}?(?:git\s+)?(?:add\/)?commit(?![\w-])` +
      String.raw`(?!\S*\s+(?:(?:directly\s+)?(?:to|on|onto|into)\s+[\x60'"]?(?:main|master|dev|trunk)\b|(?:any\s+)?(?:secrets?|credentials?|tokens?|keys?|\.env|generated|binaries|large)\b))`,
    String.raw`\bno\s+commits?\b`,
  ].join("|"),
  "im",
);

/** Commit authority GRANTED to the reader — second person or sentence-initial imperative only. */
const COMMIT_GRANT_RX = new RegExp(
  [
    String.raw`\byou\s+(?:are|'re|act\s+as)\s+(?:the\s+|a\s+)?(?:sole|only|single|one)\s+committer\b`,
    String.raw`\byou\s+(?:are|'re|act\s+as)\s+(?:the\s+|a\s+|this\s+)?(?:lane(?:'s)?\s+orchestrator|lane\s+owner|mini[- ]orchestrator)\b`,
    String.raw`\byou\s+(?:may|can|will|must|should|shall)\s+(?:also\s+)?(?:git\s+)?(?:commit|land)\b`,
    String.raw`\byou\s+(?:own|hold|have)\s+(?:the\s+)?commit\s+(?:authority|rights?|access)\b`,
    String.raw`(?:^|[.!?:;]\s+)(?:commit|land)\s+(?:(?:your|the|all|each|every|this)\s+)?(?:\w+\s+){0,3}?(?:to|on|onto)\s+(?:the\s+|this\s+|your\s+)?(?:lane\s+)?branch\b`,
  ].join("|"),
  "im",
);

/** Element 1 — the lane dispatches more than one agent. */
const FAN_OUT_RX = new RegExp(
  [
    String.raw`\bfan(?:s|ned|ning)?[- ]?out\b`,
    String.raw`\bmini[- ]orchestrators?\b`,
    String.raw`\b(?:dispatch|spawn|launch|run|start)(?:es|ed|ing|s)?\s+(?:\w+\s+){0,4}?(?:agents|sub-?agents|workers|teammates)\b[^.!?\n]{0,80}?\b(?:in\s+parallel|concurrently|simultaneously|at\s+once)\b`,
    String.raw`\b(?:in\s+parallel|concurrently)\b[^.!?\n]{0,40}?\b(?:agents|sub-?agents|workers)\b`,
    String.raw`\bparallel\s+(?:\w+\s+){0,2}?(?:agents|sub-?agents|workers|dispatch(?:es)?)\b`,
    String.raw`\bas\s+many\s+agents\b`,
  ].join("|"),
  "i",
);

/** Element 2 — writing agents take disjoint file sets. The contract cited by name counts. */
const DISJOINT_WRITE_SETS_RX = new RegExp(
  [
    String.raw`\bdisjoint\b[^.!?\n]{0,40}?\b(?:files?|file[- ]sets?|write[- ]sets?|sets?|paths?|scopes?)\b`,
    String.raw`\bnon-?overlapping\b[^.!?\n]{0,30}?\b(?:files?|write|paths?|sets?)\b`,
    String.raw`\b(?:file|write)[- ]sets?\b[^.!?\n]{0,30}?\b(?:must\s+not|never|do\s+not|don'?t)\s+overlap\b`,
    String.raw`\bpartition\s+contract\b`,
  ].join("|"),
  "i",
);

/** Element 3 — exactly one committer serializes commits. The contract cited by name counts. */
const SINGLE_COMMITTER_RX = new RegExp(
  [
    String.raw`\b(?:sole|single|only|one)\s+committer\b`,
    String.raw`\b(?:serialize|serialise)s?\s+(?:all\s+)?commits\b`,
    String.raw`\b(?:agents?|sub-?agents?|workers?|they)\s+(?:do\s+not|don'?t|never|must\s+not|may\s+not)\s+(?:git\s+)?commit(?![\w-])`,
    String.raw`\bonly\s+you\s+commit(?![\w-])`,
    String.raw`\bpartition\s+contract\b`,
  ].join("|"),
  "i",
);

/**
 * The brief with QUOTED SUB-BRIEFS removed: fenced blocks, `>` blockquote lines, and double-quoted
 * spans. Used for the ROLE gate only — see gate 2 above for why the partition gate does not use it.
 */
function stripQuotedSubBriefs(prompt) {
  if (typeof prompt !== "string") return "";
  return prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/"[^"]{0,2000}"|“[^”]{0,2000}”/g, " ");
}

/** Gate 1 — does the brief name a lane worktree? Lexical. */
function namesLaneWorktree(prompt) {
  if (typeof prompt !== "string" || prompt === "") return false;
  if (LANE_WORKTREE_PATH_RX.test(prompt)) return true;
  return STEP0_TOPLEVEL_RX.test(prompt) && STEP0_BRANCH_RX.test(prompt);
}

/** Gate 3 — the partition elements this brief never instructs, in `PARTITION_ELEMENTS` order. */
function missingPartitionElements(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const missing = [];
  if (!FAN_OUT_RX.test(text)) missing.push(PARTITION_ELEMENTS[0]);
  if (!DISJOINT_WRITE_SETS_RX.test(text)) missing.push(PARTITION_ELEMENTS[1]);
  if (!SINGLE_COMMITTER_RX.test(text)) missing.push(PARTITION_ELEMENTS[2]);
  return missing;
}

/**
 * The three gates as one record, so a fixture can assert WHY a brief was silent rather than only
 * THAT it was — a silent leaf must be silent on its ROLE, not on a lane gate that never matched.
 *
 * @param {string} prompt
 * @returns {{namesLane:boolean, grantsCommit:boolean, leafDenial:boolean,
 *            role:"orchestrator"|"leaf"|"none", missing:string[]}}
 */
function classifyLaneBrief(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const own = stripQuotedSubBriefs(text);
  const namesLane = namesLaneWorktree(text);
  const leafDenial = LEAF_DENIAL_RX.test(own);
  const grantsCommit = COMMIT_GRANT_RX.test(own);
  const role = !namesLane
    ? "none"
    : leafDenial
      ? "leaf"
      : grantsCommit
        ? "orchestrator"
        : "none";
  return {
    namesLane,
    grantsCommit,
    leafDenial,
    role,
    missing: role === "orchestrator" ? missingPartitionElements(text) : [],
  };
}

/**
 * wip-discipline MUST-9 — a lane-orchestrator brief that does not instruct fan-out under the
 * partition contract.
 *
 * @param {object} toolInput the PreToolUse `tool_input` for a Task/Agent call
 * @returns {{rule_id:string,severity:string,evidence:string,missing:string[]}|null}
 */
function detectLaneBriefWithoutPartition(toolInput) {
  // An absent or malformed brief reads as "" and classifies `none` at the lane gate — fail open
  // without a second, redundant empty-prompt gate that no case could ever tell apart from it.
  const c = classifyLaneBrief(promptOf(toolInput));
  if (c.role !== "orchestrator") return null; // leaf worker, or no lane named.
  if (c.missing.length === 0) return null; // compliant.
  return {
    rule_id: "wip-discipline/MUST-9",
    severity: "advisory",
    missing: c.missing,
    evidence:
      `this lane-orchestrator brief (it names a lane worktree and grants commit authority) is ` +
      `missing the partition instruction(s): ${c.missing.join(", ")}. Per rules/wip-discipline.md ` +
      `MUST-9 a lane is a mini-orchestrator, not a single serial worker — the WIP ceiling binds ` +
      `worktrees and branches, never agents. Brief it to dispatch as many agents as its items ` +
      `support, in parallel inside this one worktree; writing agents take DISJOINT file sets; the ` +
      `lane orchestrator is the SINGLE committer; read-only agents are unbounded; build contention ` +
      `goes to per-agent build dirs, never another worktree. Add the missing instruction(s), or ` +
      `state why this lane genuinely carries a single item.`,
  };
}

/**
 * Run ALL SIX predicates against one dispatch. Returns an array (possibly empty) — never null —
 * so a caller cannot mistake "no findings" for "did not run".
 *
 * Findings are MIXED-SEVERITY by design: the lexical predicates emit `halt-and-report` (MUST-5,
 * MUST-6, worktree-isolation MUST-10) or `advisory` (wip-discipline MUST-9), the missing-workdir
 * one emits `block`, and the agent-shadowing one is structural but deliberately capped at
 * `halt-and-report` (see its docstring for why teeth are declined). Callers MUST split on `severity` rather than treating the array as uniform —
 * `dispatch-contract-guard.js` does exactly that, and renders every non-block finding in ONE
 * response, so two predicates firing on one brief never double-fire.
 *
 * @param {object} [opts] forwarded to `detectMissingWorkdirPath` (notably `existsSync`).
 */
function inspectDispatch(toolName, toolInput, inventory, opts) {
  if (!DELEGATION_TOOLS.includes(toolName)) return [];
  const findings = [];
  const a = detectNamedDispatchWithoutDelivery(toolInput);
  if (a) findings.push(a);
  const b = detectWriteTaskToReadOnlyAgent(toolInput, inventory);
  if (b) findings.push(b);
  // Ordered immediately after MUST-5 because it QUALIFIES it: when both fire, the reader needs the
  // shadowing line to know the MUST-5 verdict above it was resolved by readdir order.
  const f = detectShadowedAgentDispatch(toolInput, inventory);
  if (f) findings.push(f);
  const c = detectMissingWorkdirPath(toolInput, opts);
  if (c) findings.push(c);
  const d = detectUnpinnedFixtureDispatch(toolInput);
  if (d) findings.push(d);
  const e = detectLaneBriefWithoutPartition(toolInput);
  if (e) findings.push(e);
  return findings;
}

/**
 * The override gate's identity, declared HERE (beside the predicates) rather than in the hook, so
 * the fixture harness and any second consumer read the same two constants the guard uses. The
 * mechanism itself lives in `lib/override-receipt.js` and is shared with `nested-worktree-guard.js`.
 */
const OVERRIDE_RECEIPT_REL = path.join(
  ".claude",
  "dispatch-authz",
  "dispatch-contract-allow",
);
const OVERRIDE_ENV = "COC_ALLOW_DISPATCH_CONTRACT";

module.exports = {
  DELEGATION_TOOLS,
  WRITE_TOOLS,
  EVIDENCE_MAX,
  OVERRIDE_RECEIPT_REL,
  OVERRIDE_ENV,
  clip,
  dispatchNameOf,
  subagentTypeOf,
  promptOf,
  hasPushDeliveryInstruction,
  isScopedReadOnly,
  impliesWrite,
  extractDeclaredWorkdirs,
  briefDeclaresWorkdirCreation,
  detectMissingWorkdirPath,
  parseAgentFrontmatter,
  readAgentInventory,
  duplicateAgentNames,
  canWrite,
  detectNamedDispatchWithoutDelivery,
  detectWriteTaskToReadOnlyAgent,
  detectShadowedAgentDispatch,
  detectUnpinnedFixtureDispatch,
  fixtureContainmentOf,
  PARTITION_ELEMENTS,
  stripQuotedSubBriefs,
  namesLaneWorktree,
  missingPartitionElements,
  classifyLaneBrief,
  detectLaneBriefWithoutPartition,
  inspectDispatch,
};
