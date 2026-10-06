"use strict";

/**
 * push-preflight — PURE predicates for the CI-parity pre-flight advisory.
 *
 * WHY THIS EXISTS, quoted from the deferral row it graduates
 * (`phase2-deferrals.json::deferrals["ci-cost-discipline.md#push-preflight-detector"]`):
 *
 *   "Nothing fires at push time, which is the only moment the cost is still
 *    avoidable — by the time /codify reviews it, the run has already been bought
 *    and destroyed. The measured waste this rule targets (474 of 483 cancelled
 *    CI-minutes) accrues entirely in that unmonitored window."
 *
 * The contract enforced is `ci-cost-discipline.md` MUST-1, which EXTENDS
 * `git.md` § "Pre-FIRST-Push CI Parity Discipline — SCOPED By Default" from the
 * first push to every subsequent push on an open PR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE PREDICATES, EACH WITH ITS OWN SCOPE RESTRICTION. Every restriction
 * WITHDRAWS a match; none of them adds one. The detector therefore UNDER-fires
 * by construction, which is the correct direction for an advisory.
 *
 * (a) IS THIS A CI-SPENDING `git push`? Answered by `parseGitInvocations` from
 *     the SHARED parser (`git-command-parse.js`), never by a fresh regex — that
 *     parser already models `cd x && git push`, `git -C /repo push`,
 *     `sudo git push`, `sh -c 'git push'`, quoting, heredocs and comments, and a
 *     `^\s*git\s+push` anchor misses every one of them (loom#1549 HIGH-3).
 *     WITHDRAWN: `--dry-run`/`-n` (no ref moves, no workflow triggers), a remote
 *     that is named and is not `origin`, a tag-only push, a branch DELETION, and
 *     any invocation the parser marks `unresolvable` (fail open on an unknown).
 *
 * (b) DOES THE TARGET BRANCH ALREADY EXIST ON THE REMOTE? This is a PROXY for
 *     "has an open PR", and the header states what it does and does not
 *     establish, because reading it for more than it measures would be
 *     `instrument-discipline.md` MUST-4.
 *
 *       WHAT IT ESTABLISHES: a push that CREATES a remote branch cannot be
 *       re-firing CI on an open PR, because no PR exists for a ref the remote
 *       has never seen. So `refs/remotes/<remote>/<branch>` ABSENT is a sound
 *       withdrawal — the first-push case is exactly what `git.md` already
 *       governs, and MUST-1 is the clause for the SUBSEQUENT pushes.
 *       WHAT IT DOES NOT ESTABLISH: that a PR is open. A branch can exist on the
 *       remote with no PR, with a merged PR, or with a closed one. On those the
 *       advisory still fires and is speaking about a push whose in-flight run is
 *       not a PR run. That is an accepted over-fire, and it is why this is
 *       capped below `block`.
 *       WHY NOT READ THE REAL PR STATE: `lib/open-pr-surface.js::getOpenPullRequests`
 *       is a `gh` round-trip, and its own header records that "execFileSync blocks
 *       the event loop, so the hook's own setTimeout cannot preempt them" — a
 *       `cc-artifacts.md` Rule 7 timer CANNOT bound a synchronous network call.
 *       A network read here would hang every `git push` in the repo behind
 *       whatever GitHub is doing. The smaller TRUE answer, read offline from a
 *       git object, is the right degrade.
 *
 * (c) DID A CI-PARITY INVOCATION HAPPEN THIS SESSION, AFTER THE LAST PUSH?
 *     Answered from the transcript's `tool_use` records. A transcript `tool_use`
 *     `input.command` is a STRUCTURAL TOOL-CALL RECORD — the harness's own log of
 *     an argv it dispatched — not the agent's prose about what it did. That
 *     distinction is load-bearing for the severity argument below.
 *
 *     THE PARITY SET IS DERIVED FROM ITS AUTHORITY, NOT HAND-LISTED
 *     (BUILDER-COMMON: "a predicate keyed on a naming convention a newer
 *     convention outgrew is the recurring defect class in this repo"). The
 *     authority is `.github/workflows/*.yml` — the commands CI itself runs, which
 *     is definitionally what a LOCAL parity run mirrors. `deriveParitySignatures`
 *     reads each `run:` step with YAML BLOCK-SCALAR semantics (a `>` folded
 *     block is ONE command; a `|` literal block is one per line) and reduces
 *     each command to `<program>[ <operand>]` signatures, where <operand> is
 *     either a MODE-SELECTING flag that belongs to the program's identity
 *     (`node --test`, but never a `CODE_DISPATCHING_FLAGS` member) or the first
 *     positional, admitted under every spelling `_operandForms` normalizes to.
 *     `isParityInvocation` looks operands up under those SAME forms — the
 *     deriver and the recognizer share one grammar by construction. Measured on loom at
 *     authoring time this yields the repo's real gate set (`node
 *     .claude/bin/validate-xref-integrity.mjs`, `node
 *     .claude/bin/run-harness-suites.mjs`, `node .claude/bin/check-descoping.mjs`,
 *     … ) — RE-DERIVE rather than citing that list, per
 *     `instrument-discipline.md` MUST-6; it moves with the workflows.
 *
 *     ONE HAND-LISTED ELEMENT, DECLARED: `SHELL_NOISE` below, the shell builtins
 *     and plumbing verbs (`if`, `echo`, `cd`, `git`, `gh`, …) that appear in
 *     `run:` steps but are not gates. There is no in-repo authority enumerating
 *     "which words are not a test command", so it is hand-listed and named here
 *     rather than passed off as derived. Its failure mode is BENIGN in the
 *     detector's safe direction: a missing entry makes the recognizer MORE
 *     generous, which makes the advisory QUIETER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEGRADE SAFELY, NEVER TO A FALSE CLEAN. Each unknown resolves to SILENCE with
 * its OWN named reason, so an unanswerable case is never recorded as a measured
 * all-clear (`instrument-discipline.md` MUST-1 / the sibling
 * `ci-runner-saturation.js` INDETERMINATE arm). `remote-branch-unknown`,
 * `no-parity-authority` and `transcript-unreadable` are each distinct from
 * `parity-ran-this-session`.
 *
 * PURE. Nothing here touches the filesystem, the network, the clock or a
 * subprocess. Every input arrives as text or a plain object, so
 * `.claude/audit-fixtures/push-preflight/run.mjs` drives these directly with no
 * live repo.
 */

const path = require("path");
const { parseGitInvocations } = require(
  path.join(__dirname, "git-command-parse.js"),
);

// ── (a) IS THIS A CI-SPENDING `git push`? ───────────────────────────────────

/** Flags that CONSUME the next word, so their value is never read as a positional. */
const PUSH_VALUE_FLAGS = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
  "--force-with-lease",
  "--force-if-includes",
]);
// `--force-with-lease` is in that set only for its SEPARATED form; the attached
// `--force-with-lease=ref:sha` form carries its value inside the token, and the
// bare form takes none. Treating a bare `--force-with-lease origin main` as
// value-consuming would eat the remote — so the separated case is admitted only
// when the following word looks like a lease spec (contains a `:`), below.

const DRY_RUN = new Set(["--dry-run", "-n"]);
const DELETE_FLAGS = new Set(["--delete", "-d"]);

/**
 * Split a push invocation's `argv` into its flags and its positionals.
 * `argv` is the parser's POST-SUBCOMMAND TOKEN array — never the joined `args`
 * string, whose own note is that it cannot tell a real `--dry-run` FLAG from the
 * same characters inside a quoted argument (loom#1715 L-6).
 */
function _splitPushArgv(argv) {
  const flags = [];
  const positionals = [];
  if (!Array.isArray(argv)) return { flags, positionals };
  for (let i = 0; i < argv.length; i++) {
    const t = String(argv[i] == null ? "" : argv[i]);
    if (t === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(String(argv[j]));
      break;
    }
    if (t.startsWith("-")) {
      flags.push(t);
      if (PUSH_VALUE_FLAGS.has(t)) {
        const next = argv[i + 1];
        if (t === "--force-with-lease" || t === "--force-if-includes") {
          // Only consumes a word when that word is a lease spec.
          if (typeof next === "string" && next.includes(":")) i++;
        } else if (next !== undefined) {
          i++;
        }
      }
      continue;
    }
    positionals.push(t);
  }
  return { flags, positionals };
}

/**
 * The BRANCH this push lands on the remote, or null when it names none
 * (so the caller falls back to the current branch).
 *
 * Refspec grammar handled: `src:dst`, `+src:dst` (force), a bare `dst`,
 * `HEAD:dst`, and a bare `HEAD`. The DST half is what the remote gains, so that
 * is the half read; `refs/heads/` is stripped so the name matches what
 * `refs/remotes/<remote>/<name>` is spelled with.
 */
function _refspecBranch(spec) {
  let s = String(spec || "").replace(/^\+/, "");
  const colon = s.lastIndexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  s = s.replace(/^refs\/heads\//, "");
  if (!s || s === "HEAD") return null;
  return s;
}

const _isTagRef = (s) =>
  /(^|:)(\+)?refs\/tags\//.test(String(s || "")) ||
  /^refs\/tags\//.test(String(s || ""));

/**
 * Classify one Bash command as an in-scope CI-spending push, or say why not.
 *
 * @returns {{inScope: true, remote: string, branch: string|null, argv: string[]}
 *          |{inScope: false, why: string}}
 */
function classifyPush(command) {
  if (typeof command !== "string" || !command.includes("push")) {
    return { inScope: false, why: "not-a-push" };
  }
  let invocations;
  try {
    invocations = parseGitInvocations(command);
  } catch {
    // The shared parser is documented never to throw; if it ever does, an
    // unknown resolves to silence rather than to a guess (cc-artifacts Rule 7).
    return { inScope: false, why: "parse-failed" };
  }
  let sawUnresolvable = false;
  // Each WITHDRAWAL carries its OWN identity, so a silence names which scope
  // restriction produced it rather than collapsing five distinct reasons into
  // one (`instrument-bipolarity.md` MUST-2 — a pole names a failure identity).
  let withdrawal = null;
  for (const inv of invocations) {
    if (!inv) continue;
    if (inv.unresolvable) {
      sawUnresolvable = true;
      continue;
    }
    if (inv.sub !== "push") continue;
    const { flags, positionals } = _splitPushArgv(inv.argv);
    if (flags.some((f) => DRY_RUN.has(f))) {
      withdrawal = "dry-run"; // buys no run: no ref moves, no workflow triggers
      continue;
    }
    if (flags.some((f) => DELETE_FLAGS.has(f))) {
      withdrawal = "delete-push"; // removes a ref; lands nothing
      continue;
    }
    const remote = positionals[0] || "origin";
    // Scoped to `origin` DELIBERATELY. A named non-origin remote is a fork or a
    // mirror whose PR surface this predicate cannot see, so it is withdrawn
    // rather than guessed at — an under-fire, which is the safe direction.
    if (remote !== "origin") {
      withdrawal = "non-origin-remote";
      continue;
    }
    const specs = positionals.slice(1);
    if (
      (flags.includes("--tags") && specs.length === 0) ||
      (specs.length > 0 && specs.every(_isTagRef))
    ) {
      withdrawal = "tag-only-push";
      continue;
    }
    if (specs.some((s) => String(s).startsWith(":"))) {
      withdrawal = "delete-push"; // `:branch` refspec
      continue;
    }
    const named = specs.map(_refspecBranch).filter(Boolean);
    return {
      inScope: true,
      remote,
      branch: named.length > 0 ? named[0] : null,
      argv: Array.isArray(inv.argv) ? inv.argv.slice() : [],
    };
  }
  // A RESOLVED withdrawal outranks an unresolvable sibling: the segment we could
  // read tells us more than the one we could not.
  if (withdrawal) return { inScope: false, why: withdrawal };
  if (sawUnresolvable) return { inScope: false, why: "unresolvable-push" };
  return { inScope: false, why: "not-a-push" };
}

// ── (c) THE PARITY SET, DERIVED FROM `.github/workflows/*.yml` ──────────────

/**
 * Shell builtins and plumbing verbs that appear in `run:` steps but never
 * constitute a gate. HAND-LISTED — see the header's declaration. `git` and `gh`
 * are members because a `git push` in a workflow must never make a `git push` in
 * the transcript read as a parity run, which would make the detector inert.
 */
const SHELL_NOISE = new Set([
  "if", "fi", "then", "else", "elif", "for", "while", "do", "done", "case",
  "esac", "set", "shift", "return", "exit", "trap", "local", "function",
  "echo", "printf", "cat", "cd", "pwd", "mkdir", "rm", "cp", "mv", "ls", "ln",
  "touch", "chmod", "chown", "export", "source", ".", "true", "false", "test",
  "[", "[[", "sleep", "date", "env", "which", "type", "read", "wait", "kill",
  "sed", "awk", "tr", "cut", "head", "tail", "sort", "uniq", "wc", "grep",
  "egrep", "fgrep", "xargs", "find", "tee", "diff", "cmp", "basename",
  "dirname", "realpath", "readlink", "mktemp", "curl", "wget", "tar", "unzip",
  "gzip", "sha256sum", "shasum", "jq", "yq", "git", "gh", "sudo", "apt-get",
  "brew", "install",
]);

/**
 * Programs that DISPATCH — an interpreter or a multi-verb front-end whose
 * identity says nothing about what ran. HAND-LISTED, and declared here for the
 * same reason `SHELL_NOISE` is: there is no in-repo authority enumerating them.
 *
 * For these, only the TWO-WORD signature is admitted. Measured on loom: the
 * workflows invoke `node .claude/bin/<gate>.mjs` throughout, so admitting a bare
 * `node` would make EVERY `node` call in the transcript read as a parity run and
 * the detector near-INERT. Unlike `SHELL_NOISE`, a missing entry here makes the
 * recognizer MORE generous and the advisory QUIETER, so this list fails in the
 * safe direction too — but it is the list that decides whether the instrument
 * can fire at all, so it is stated rather than buried.
 */
const DISPATCHING_PROGRAMS = new Set([
  "node", "python", "python3", "py", "npm", "npx", "pnpm", "yarn", "bun",
  "deno", "uv", "uvx", "poetry", "cargo", "go", "dotnet", "java", "ruby",
  "bundle", "rake", "perl", "make", "just", "task", "bash", "sh", "zsh",
  "docker", "podman", "kubectl", "terraform", "gradle", "mvn",
]);

/**
 * Flags that make their program evaluate CALLER-SUPPLIED CODE or select an
 * arbitrary module, so `<program> <flag>` says nothing about what ran.
 * HAND-LISTED for the same reason the two sets above are, and measured on loom
 * rather than imagined: the workflows carry `node -e '<script>'` and
 * `python -m pip install`, and admitting either spelling as a gate signature
 * would score every ad-hoc `node -e` probe in a transcript as a parity run —
 * a FALSE SILENCE, which is the one direction this detector must not fail in.
 * Everything NOT listed here is admitted, so the failure mode of a missing
 * entry is the loud one.
 */
const CODE_DISPATCHING_FLAGS = new Set([
  "-e", "--eval", "-p", "--print", "-c", "-m", "--module", "-i",
  "--interactive", "--exec",
]);

const _looksLikeCommandWord = (w) =>
  /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(w) || /^[A-Za-z0-9_./+-]+$/.test(w);

/** Strip ONE layer of matched surrounding quotes. */
function _unquote(s) {
  const t = String(s == null ? "" : s);
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * The spellings ONE operand is admitted under. Called by BOTH
 * `deriveParitySignatures` and `isParityInvocation`, which is the whole point:
 * an operand compared RAW makes `.claude/bin/x.mjs` and `./.claude/bin/x.mjs`
 * two different gates, so a local run of the very command CI runs misses.
 *
 * Two forms, both bounded: the path with a leading `./` removed, and its
 * BASENAME. The basename form is what admits the absolute-path spelling this
 * repo's agents are instructed to use, and it is why a `$VAR`-rooted path still
 * resolves — the expansion sits in the directory half, never in the file name.
 * A form still carrying a shell metacharacter after normalization is DROPPED
 * rather than guessed at.
 */
function _operandForms(raw) {
  const op = _unquote(raw);
  if (!op) return [];
  const out = [];
  const plain = op.replace(/^\.\//, "");
  for (const f of [plain, plain.replace(/^.*\//, "")]) {
    if (!f || out.includes(f)) continue;
    if (/["'`$(){}]/.test(f)) continue;
    out.push(f);
  }
  return out;
}

/**
 * Derive the project's CI command signatures from workflow YAML text.
 *
 * PURE over an array of file CONTENTS (the guard does the reading), so a fixture
 * can hand it synthetic YAML. Returns a Set of `"<program>"` and
 * `"<program> <operand>"` strings; a command matches when EITHER spelling is
 * present, so `node .claude/bin/x.mjs` is recognised specifically while a bare
 * `pytest` is recognised generally.
 *
 * @param {string[]} texts
 * @returns {Set<string>}
 */
function deriveParitySignatures(texts) {
  const sigs = new Set();
  if (!Array.isArray(texts)) return sigs;
  const commandLines = [];
  for (const raw of texts) {
    if (typeof raw !== "string") continue;
    const lines = raw.split("\n");
    let inBlock = false;
    // YAML block-scalar SEMANTICS, not line-by-line text. A FOLDED scalar (`>`)
    // joins its lines into ONE command, so `node --test` on one line and its
    // suites on the next are a SINGLE invocation; a LITERAL scalar (`|`) keeps
    // each line a separate command. Reading a folded block line-by-line both
    // LOSES the real command and MINTS one bogus signature per continuation
    // line (measured on loom: bare test-file basenames entered the parity set).
    let folded = false;
    let indent = 0;
    let buf = [];
    const flush = () => {
      if (buf.length) commandLines.push(buf.join(" "));
      buf = [];
    };
    for (const line of lines) {
      const m = line.match(/^(\s*)-?\s*run:\s*(\|-?|>-?)?\s*(.*)$/);
      if (m) {
        flush();
        if (m[3]) commandLines.push(m[3]);
        inBlock = Boolean(m[2]);
        folded = Boolean(m[2] && m[2].startsWith(">"));
        indent = m[1].length;
        continue;
      }
      if (!inBlock) continue;
      const body = line.match(/^(\s*)(\S.*)$/);
      if (!body || body[1].length <= indent) {
        flush();
        inBlock = false;
        continue;
      }
      if (folded) buf.push(body[2]);
      else commandLines.push(body[2]);
    }
    flush();
  }
  for (const line of commandLines) {
    for (const seg of String(line).split(/&&|\|\||[;|]/)) {
      const cleaned = seg.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
      if (!cleaned || cleaned.startsWith("#")) continue;
      const words = cleaned.split(/\s+/);
      let prog = words[0];
      if (!prog || prog.includes("=") || /["'`$(){}]/.test(prog)) continue;
      prog = prog.replace(/^.*\//, "");
      if (!_looksLikeCommandWord(prog)) continue;
      if (SHELL_NOISE.has(prog)) continue;
      if (!DISPATCHING_PROGRAMS.has(prog)) sigs.add(prog);
      const raw = words[1];
      if (!raw) continue;
      if (raw.startsWith("-")) {
        // A MODE-SELECTING flag belongs to the program's IDENTITY, not to its
        // arguments: `node --test` names the test runner as surely as `pytest`
        // names pytest. Admitted because `isParityInvocation` ALREADY looks up
        // `<prog> <words[1]>` verbatim, flag or not — the deriver refusing to
        // EMIT what the recognizer LOOKS UP is the asymmetry that dropped every
        // one of this repo's `node --test` steps from the parity set.
        if (!CODE_DISPATCHING_FLAGS.has(raw)) sigs.add(`${prog} ${raw}`);
        continue;
      }
      for (const form of _operandForms(raw)) sigs.add(`${prog} ${form}`);
    }
  }
  return sigs;
}

/**
 * Does this command invoke something in the derived parity set?
 *
 * Segment-anchored via the SHARED separators: heredoc bodies and shell comments
 * are removed before matching, so a parity command QUOTED inside a heredoc or
 * written after a `#` does not count as having been RUN. `stripHeredocBodies` is
 * required from `violation-patterns.js`, never copied.
 */
function isParityInvocation(command, signatures) {
  if (typeof command !== "string" || !command) return false;
  if (!signatures || typeof signatures.has !== "function" || signatures.size === 0) {
    return false;
  }
  let surface;
  try {
    const {
      stripHeredocBodies,
      splitShellSegments,
    } = require(path.join(__dirname, "violation-patterns.js"));
    const { stripShellComments, stripShellGroupDelimiters } = require(
      path.join(__dirname, "git-command-parse.js"),
    );
    surface = splitShellSegments(stripShellComments(stripHeredocBodies(command)), {
      newlineSeparates: true,
    }).map(stripShellGroupDelimiters);
  } catch {
    return false; // unknown => not counted as parity => the SAFE direction is
    // to under-report parity, which makes the advisory LOUDER, so this arm is
    // instead compensated by `assessPushPreflight`'s `no-parity-authority` and
    // `transcript-unreadable` silences.
  }
  for (const seg of surface) {
    const cleaned = String(seg)
      .trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
    if (!cleaned) continue;
    const words = cleaned.split(/\s+/);
    const prog = String(words[0] || "").replace(/^.*\//, "");
    if (!prog) continue;
    if (signatures.has(prog)) return true;
    const raw = words[1];
    if (!raw) continue;
    if (raw.startsWith("-")) {
      if (signatures.has(`${prog} ${raw}`)) return true;
      continue;
    }
    // SAME normalization the deriver applied, or `.claude/bin/x.mjs` and
    // `./.claude/bin/x.mjs` are two different gates.
    for (const form of _operandForms(raw)) {
      if (signatures.has(`${prog} ${form}`)) return true;
    }
  }
  return false;
}

// ── The transcript read (pure over TEXT; the guard supplies the bytes) ──────

/**
 * Every `Bash` tool_use command in transcript text, in order.
 *
 * The transcript is JSONL; each assistant row carries `message.content` blocks,
 * and a dispatched Bash call appears as `{type:"tool_use", name:"Bash",
 * input:{command}}`. A malformed or half-line row (the tail read slices
 * mid-line) is SKIPPED, never thrown on.
 *
 * @returns {{commands: string[], rows: number, parsed: number}}
 */
function transcriptBashCommands(text) {
  const out = [];
  let rows = 0;
  let parsed = 0;
  if (typeof text !== "string" || !text) return { commands: out, rows, parsed };
  for (const line of text.split("\n")) {
    if (!line) continue;
    rows++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    parsed++;
    const blocks =
      entry && entry.message && Array.isArray(entry.message.content)
        ? entry.message.content
        : [];
    for (const b of blocks) {
      if (!b || b.type !== "tool_use") continue;
      const name = String(b.name || "");
      if (name !== "Bash") continue;
      const c = b.input && b.input.command;
      if (typeof c === "string" && c) out.push(c);
    }
  }
  return { commands: out, rows, parsed };
}

// ── The assessment ──────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.command            the pending Bash command
 * @param {boolean|null} o.remoteBranchExists  true / false / null=unknown
 * @param {string} o.transcriptText     raw JSONL tail, or "" when unavailable
 * @param {Set<string>} o.paritySignatures
 * @returns {{verdict:"flag"|"silent", detail:{why:string, branch?:string|null,
 *           lastPushSeen?:boolean, parityCandidates?:number}}}
 */
function assessPushPreflight(o) {
  const opts = o || {};
  const cls = classifyPush(opts.command);
  if (!cls.inScope) return { verdict: "silent", detail: { why: cls.why } };

  // (b) — the git-object proxy. Unknown is its OWN reason, never a clean.
  if (opts.remoteBranchExists === false) {
    return {
      verdict: "silent",
      detail: { why: "first-push-no-remote-branch", branch: cls.branch },
    };
  }
  if (opts.remoteBranchExists !== true) {
    return {
      verdict: "silent",
      detail: { why: "remote-branch-unknown", branch: cls.branch },
    };
  }

  const sigs = opts.paritySignatures;
  if (!sigs || typeof sigs.has !== "function" || sigs.size === 0) {
    return { verdict: "silent", detail: { why: "no-parity-authority" } };
  }

  const text = typeof opts.transcriptText === "string" ? opts.transcriptText : "";
  if (!text) {
    return { verdict: "silent", detail: { why: "transcript-unreadable" } };
  }
  const { commands } = transcriptBashCommands(text);
  if (commands.length === 0) {
    return { verdict: "silent", detail: { why: "transcript-unreadable" } };
  }

  // The PENDING push may already have been written to the transcript by the time
  // PreToolUse fires. Drop a TRAILING record identical to it, or the detector
  // would measure the window after its own subject and be silent forever.
  const pending = String(opts.command);
  const hist = commands.slice();
  while (hist.length && hist[hist.length - 1] === pending) hist.pop();

  let lastPushIdx = -1;
  for (let i = 0; i < hist.length; i++) {
    if (classifyPush(hist[i]).inScope) lastPushIdx = i;
  }
  const window = hist.slice(lastPushIdx + 1);
  const ranParity = window.some((c) => isParityInvocation(c, sigs));
  if (ranParity) {
    return {
      verdict: "silent",
      detail: {
        why: "parity-ran-this-session",
        branch: cls.branch,
        lastPushSeen: lastPushIdx >= 0,
      },
    };
  }
  return {
    verdict: "flag",
    detail: {
      why: "no-parity-since-last-push",
      branch: cls.branch,
      lastPushSeen: lastPushIdx >= 0,
      parityCandidates: window.length,
    },
  };
}

module.exports = {
  classifyPush,
  deriveParitySignatures,
  isParityInvocation,
  transcriptBashCommands,
  assessPushPreflight,
  SHELL_NOISE,
  DISPATCHING_PROGRAMS,
};
