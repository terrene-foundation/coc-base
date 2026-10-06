/*
 * auto-format-cases — the ONE definition of what this suite asserts about
 * `.claude/hooks/auto-format.js`.
 *
 * WHY THIS MODULE EXISTS
 *   The suite is consumed by TWO surfaces with different output contracts:
 *     - `run.mjs`            the ci-audit-fixtures.json runner (PASS/FAIL lines)
 *     - `auto-format-scan.mjs`  the eval-manifest scanner (--root/--json, exit code)
 *   Two copies of one predicate is the defect `bin/lib/audit-fixture-runners.mjs`
 *   was written to end; the predicate therefore lives here ONCE and both surfaces
 *   resolve through it.
 *
 * WHAT THESE PIN, and why it is DISPATCH rather than formatting:
 * the patch changes which EXTENSIONS reach the formatter. It does not change what
 * the formatter does once reached. So every assertion here is about the dispatch
 * decision — asserting `formatter === "prettier"` would require `npx` to resolve
 * prettier and would flake in a sandboxed or offline CI. The green poles therefore
 * assert `formatter !== "unsupported file type"` (dispatched — "prettier" on
 * success, "none" when prettier is unavailable), which discriminates exactly the
 * property the patch changes and nothing else.
 *
 * CORRECTED, and the superseded claim is quoted rather than smoothed away. The
 * sentence above used to continue "…which also keeps the suite
 * OFFLINE-DETERMINISTIC". That was true of the ASSERTION and FALSE of the
 * EXECUTION, and the difference is what broke this suite. The green poles drive
 * the LIVE hook, and the hook itself shells out to `npx --yes prettier@<pin>
 * --write` on every extension it dispatches — so a question about DISPATCH was
 * being paid for at the price of a full FORMAT, nine times per pass. MEASURED:
 * one `.yaml` spawn 11524ms on this host, ~90s for the nine, against a 22000ms
 * aggregate budget; six of nine lanes never ran. The arms are offline-deterministic
 * NOW because `evaluate()` stubs the hook's `npx` (see § THE HOOK'S OWN `npx` IS
 * STUBBED), not because asserting the dispatch decision ever made them so.
 *
 * THE SUBJECT IS THE LIVE HOOK, NEVER A COPY. Every case drives
 * `<repo>/.claude/hooks/auto-format.js` as it sits on disk. A fixture case
 * directory supplies only an EXPECTATION MAP (`expect.json`); it never supplies a
 * hook. That is load-bearing: a fixture holding its own copy of the subject would
 * agree with itself by construction, which is the self-derived oracle
 * `evidence-first-claims.md` MUST-5 blocks and the exact defect `bin/verdict.mjs`
 * records having shipped and then removed from its own fixture path.
 *
 * TWO ARMS ARE CONDITIONAL, AND THEY ARE THE ONLY ONES. The pin-resolution arm and
 * the anti-vacuity arm both need `npx` to reach the registry, and they deliberately
 * keep the REAL npx — a registry probe is the whole of what they assert. Every
 * other arm is offline-deterministic (see the CORRECTED note above for what that
 * cost to make true). A conditional arm that cannot reach the registry returns
 * `skipped: true` and is scored by NEITHER surface — never a pass it did not earn.
 *
 * THEIR SKIP NOTES NAME A CAUSE THAT WAS MEASURED. A skip reason is a claim about
 * the world, and three of them here used to be asserted rather than observed:
 * "npx unreachable" was printed when the aggregate budget had been spent and npx
 * was never touched, and again when npx TIMED OUT having demonstrably worked
 * seconds earlier; "prettier unavailable offline" was printed on every road out of
 * the anti-vacuity probe. BUDGET-SPENT, TIMED-OUT, EXITED-NON-ZERO and
 * GENUINELY-UNREACHABLE are now four distinct notes, because they are four
 * different facts and only one of them is about the registry.
 */
import "../_lib/no-ambient-git.cjs";
import { execFileSync } from "node:child_process";

/**
 * The per-`npx` ceiling, well under `coc-eval-core.mjs::scannerTimeoutMs()` (30000ms)
 * so that a slow registry degrades this suite to its DECLARED skip rather than
 * killing the scanner and failing the whole structural gate.
 */
function boundedMs(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A negative value reaches `execFileSync` and throws ERR_OUT_OF_RANGE INSIDE the
  // catch that degrades an arm to `skipped` — so a typo'd env var would silently
  // disarm the check it was meant to tune. Refuse loudly instead.
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${envName}="${raw}" is not a positive number of milliseconds; refusing rather than silently skipping the arms it governs`);
  }
  return n;
}
const NPX_TIMEOUT_MS = boundedMs("AUTO_FORMAT_NPX_TIMEOUT_MS", 10000);
/** Per-spawn ceiling; the AGGREGATE ceiling below is the one that fits the budget. */
const HOOK_TIMEOUT_MS = boundedMs("AUTO_FORMAT_HOOK_TIMEOUT_MS", 20000);
/**
 * TOTAL wall clock this scan may spend in ANY spawn — the 9 `drive()` calls and the
 * npx arms alike.
 * Sized against `coc-eval-core.mjs::scannerTimeoutMs()` (30000ms at `.claude/bin/
 * coc-eval-core.mjs:124-126`) with room for the rest of the scan: a measured warm
 * baseline is ~9.1-9.7s, so 22s leaves the scanner comfortably inside 30s even when
 * every spawn is slow. Exceeding it degrades the affected arms to their DECLARED skip
 * instead of letting the harness SIGTERM the scanner and score it `grade: null`.
 */
const TOTAL_BUDGET_MS = boundedMs("AUTO_FORMAT_TOTAL_BUDGET_MS", 22000);
/**
 * What `drive()` returns when the hook spawn could not complete in budget. It is a
 * DISTINCT value, not `REFUSED` and not `"<none>"`: a timed-out spawn tells us
 * nothing about the dispatch decision, and scoring it as either pole would be a
 * verdict this scan did not earn (`probe-driven-verification.md` MUST-7 — UNRUNNABLE
 * is not a verdict). Rows built from it are marked `skipped` below.
 */
const TIMED_OUT = "<hook-spawn-timed-out>";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..", "..");
export const HOOK = path.join(REPO, ".claude", "hooks", "auto-format.js");

/**
 * A payload MEASURED to corrupt under prettier's markdown printer: a code span
 * containing ESCAPED backticks. Shape (2) of the two corruption triggers — it
 * carries no ">" at all, so a fix scoped to the blockquote case would leave it live.
 */
export const CORRUPTING_MD = [
  "Re-shaped so each now reads `Depth: \\`skills/18-security-patterns/<f>.md\\`.`",
  "and the provenance moved to a TRAILING `Origin: …` sentence, which `abridgeV6` peels.",
  "Every `MUST` / `MUST NOT` / `BLOCKED` / `**Why:**` / Wiring token count is unchanged.",
  "",
].join("\n");

/**
 * Every dispatch lane the hook is trusted for, with a body that a formatter would
 * visibly rewrite. COVERAGE IS THE HOOK'S WHOLE MANDATE, not a sample of it: an
 * earlier revision covered yaml/yml/json/js only, and MEASURED on this tree that
 * was strictly weaker than it read — deleting ".ts", ".tsx" or ".jsx" from the
 * prettier extension list, or removing the entire ".py" branch, passed every case
 * AND the registry floor. Every lane the hook dispatches now has a pole, so a
 * narrowing of ANY lane reds a NAMED case rather than a count.
 *
 * `.py` is asserted on the DISPATCH DECISION, never on a formatter name. Its
 * branch returns "black", "ruff", or "none (black/ruff not found)" depending on
 * what the machine has installed; all three differ from "unsupported file type"
 * and only deleting the branch produces that.
 */
export const GREEN_LANES = [
  ["yaml", "a:   1\n"],
  ["yml", "a:   1\n"],
  ["json", '{"a":  1}\n'],
  ["js", "const x =  1\n"],
  ["jsx", "const x = <a b= 'c' />\n"],
  ["ts", "const x:  number = 1\n"],
  ["tsx", "const x = <a b= 'c' />\n"],
  ["py", "x  =  1\n"],
];

export const REFUSED = "unsupported file type";

/**
 * The stable check-id set, in evaluation order. These ids are what an
 * eval-manifest `expected` case pins in `critical_failures`, so they are an
 * EXTERNAL contract: renaming one silently un-pins a fixture's detection class.
 */
export const CHECK_IDS = Object.freeze([
  "dispatch-md-refused",
  "md-byte-identical",
  ...GREEN_LANES.map(([ext]) => `dispatch-${ext}`),
  "pin-declared",
  "pin-no-bare-call-sites",
  "pin-call-sites-present",
  // F2 — the version is DERIVED from the pin, not re-typed.
  "pin-version-derived",
  // F1 (HIGH) — the resolved-cache fast path must REFUSE a planted program. The
  // reviewer's finding: with these predicates unpinned, a mutated hook ran an
  // arbitrary cached "prettier" and all 40 suites stayed green.
  // `sec-correct-runs` is the POSITIVE pole: without it the three negatives pass
  // vacuously whenever the fixture's computed dir differs from the hook's.
  "sec-correct-runs",
  "sec-decoy-not-run",
  "sec-wrong-name-not-run",
  "sec-wrong-version-not-run",
  "sec-no-npx-record-not-run",
  "pin-resolves",
  "red-pole-payload-corrupts",
]);

/**
 * The expectation map the LIVE hook is supposed to satisfy. A fixture case that
 * declares exactly this is the CLEAN pole; one that flips a field is the
 * violation pole, and the scanner must report it non-zero.
 */
export const CANONICAL_EXPECT = Object.freeze({
  dispatch: Object.freeze({
    md: false,
    ...Object.fromEntries(GREEN_LANES.map(([ext]) => [ext, true])),
  }),
  pin_declared: true,
  bare_call_sites: 0,
  min_pinned_call_sites: 2,
  payload_corrupts_under_pin: true,
});

function row(id, label, expected, actual, { critical = true, skipped = false, note = null } = {}) {
  return { id, label, expected, actual, passed: skipped ? null : actual === expected, critical, skipped, note };
}

/**
 * Evaluate every case against the LIVE hook, under the supplied expectation map.
 *
 * @param {object} expect  an expectation map of CANONICAL_EXPECT's shape. Missing
 *                         fields fall back to the canonical value, so a fixture
 *                         declares only what it means to assert.
 * @returns {{rows: object[], failed: string[]}}
 */
export function evaluate(expect = CANONICAL_EXPECT) {
  const want = {
    ...CANONICAL_EXPECT,
    ...expect,
    dispatch: { ...CANONICAL_EXPECT.dispatch, ...(expect.dispatch || {}) },
  };

  const rows = [];
  const lab = mkdtempSync(path.join(tmpdir(), "auto-format-fixtures-"));

  // ── THE HOOK'S OWN `npx` IS STUBBED FOR THE DISPATCH ARMS ─────────────────
  //
  // WHAT THIS FIXES. The header above claims the dispatch arms are
  // "offline-deterministic". That was true of the ASSERTION and false of the
  // EXECUTION, and the gap is what spent the budget. Each green lane drives the
  // LIVE hook, and the hook's own .js/.ts/.json/.yaml branches reach a formatter
  // for every one of them. So a question about which EXTENSIONS the hook
  // dispatches was being answered by paying for the whole FORMAT, nine times.
  //
  // CORRECTED (reviewer F4) — HOW the hook reaches a formatter CHANGED, and the
  // earlier wording here ("shell out to `npx --yes prettier@<pin> --write`") is no
  // longer the whole story: perf/hook-cost added a resolved-cache fast path that
  // starts the pinned prettier's own entry file directly and SKIPS `npx` when the
  // cache entry is present. That made the arms' cost host-dependent (a warm cache
  // formats for real; a cold one pays npx) and, worse, would have made the STUB
  // below bypassable. Hence `FAST_PATH_CACHE` in HOOK_ENV: the virtual-arms run
  // with `npm_config_cache` pointed at an EMPTY directory, so the fast path finds
  // no `_npx` entry and every lane takes the stubbed-`npx` road this file was
  // built around — deterministic on any host, warm cache or not.
  // MEASURED on this host: one `.yaml` spawn 11524ms, `npx --yes prettier@3.9.6
  // --version` 9650ms standalone — npx is REACHABLE here and simply slow, so the
  // nine spawns cost ~90s against a 22000ms aggregate budget. Six of nine lanes
  // never ran, and their skip notes blamed an environment that was working.
  //
  // WHY A STUB IS SOUND, AND WHAT IT DOES NOT GIVE UP. The dispatch decision is
  // `ext in [list]`, taken BEFORE npx is reached, and BOTH prettier call sites
  // return a non-REFUSED formatter name when the spawn fails ("none (prettier not
  // found)" / "none"). So the poles still separate on exactly the property under
  // test. PROVEN BY MUTATION, reach shown first: with `".ts"` deleted from the
  // hook's extension list on a COPY, the `.ts` lane returns "unsupported file
  // type" under this same stub while all eight siblings are unchanged — the named
  // case reds and nothing else does. Nor is the npx ARGV left unasserted: its
  // shape is pinned statically by `pin-no-bare-call-sites` and
  // `pin-call-sites-present`, which read the hook's source, and its BINDING is
  // pinned by `pin-resolves` below — and those two arms deliberately keep the REAL
  // npx, since a registry probe is the whole of what they assert.
  // MEASURED after the change: the nine spawns total 4787ms, from ~90000ms.
  //
  // THE STUB IS SHOWN TO FIRE HERE rather than assumed (instrument-discipline.md
  // MUST-3(a)): a PATH that failed to shadow npx would silently restore the
  // network dependence this block exists to remove, and would read as a pass. The
  // control below refuses loudly instead, in the first milliseconds and on stderr,
  // on the same reasoning `boundedMs` refuses a typo'd env var rather than
  // silently disarming the arms it governs.
  const stubBin = path.join(lab, ".stub-bin");
  mkdirSync(stubBin);
  writeFileSync(path.join(stubBin, "npx"), "#!/bin/sh\nexit 127\n");
  chmodSync(path.join(stubBin, "npx"), 0o755);
  // FAST_PATH_CACHE — an EMPTY npm cache for the arms that stub `npx`, so the
  // hook's resolved-cache fast path (perf/hook-cost) finds no `_npx` entry and the
  // stub is not bypassable. Without it the arms are host-dependent: on a machine
  // with a warm cache the hook formats for real and never reaches the stub.
  const FAST_PATH_CACHE = path.join(lab, ".empty-npm-cache");
  mkdirSync(FAST_PATH_CACHE, { recursive: true });
  const HOOK_ENV = {
    ...process.env,
    PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
    npm_config_cache: FAST_PATH_CACHE,
  };
  let stubFires = false;
  try {
    execFileSync("npx", ["--version"], { env: HOOK_ENV, stdio: "ignore", timeout: 5000 });
  } catch {
    stubFires = true;
  }
  if (!stubFires) {
    rmSync(lab, { recursive: true, force: true });
    throw new Error(
      "the npx stub does not shadow the real npx on this platform; refusing rather than " +
        "silently reverting the dispatch arms to a network-dependent spawn that would skip on budget",
    );
  }
  // ONE deadline for EVERY spawn in this scan, hook and npx alike. An earlier
  // revision armed it here and closed over it in `drive()` ONLY, leaving the two
  // `npx` sites bounded per-spawn at NPX_TIMEOUT_MS each. `tryResolve` is called
  // TWICE (the pin, then the control), so 3 x 10000 = the ENTIRE 30000ms scanner
  // budget sat OUTSIDE the 22000ms cap, for a declared composed ceiling of 52000ms.
  // All three Tier-1 arms converged on it, and one measured ELAPSED_S=30 with the
  // hook budget forced to 1ms — i.e. npx alone consumed the whole scanner budget.
  // The comment then claimed "the scan as a whole cannot outlive the scanner's
  // budget", which was false on the tree that shipped it. That is this commit's own
  // headline lesson — a per-item cap is not an aggregate cap — left unapplied one
  // function over in the same file, plus a code-surface claim contradicted by the
  // file's own constants (`zero-tolerance.md` Rule 3e).
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  /** Remaining aggregate budget, floored at 1ms; `null` once it is spent. */
  const budgetLeft = () => {
    const r = deadline - Date.now();
    return r > 0 ? r : null;
  };
  const drive = (file) => {
    const payload = JSON.stringify({ tool_input: { file_path: file }, cwd: lab });
    // BOUNDED BY THE REMAINING TOTAL, not by a fixed per-spawn value — and that
    // distinction is the whole finding. A previous revision bounded each spawn at
    // 20000ms and claimed it "covers every npx BELOW it". It does cover them, and
    // it does NOT bound their SUM: `drive()` runs 9 times (once for markdown, once
    // per `GREEN_LANES` extension, and GREEN_LANES has 8 members), so 9 x 20000 is
    // 180000ms against the 30000ms
    // `coc-eval-core.mjs::scannerTimeoutMs()` budget this bound exists to fit.
    // Two Tier-1 arms measured it independently — one with a 5s npx shim produced a
    // 46.32s total in which EVERY spawn stayed inside its own bound and none was
    // killed, and warm baseline is ~9.1-9.7s, so a SINGLE stalled spawn already
    // exceeds 30s. A per-item cap is not an aggregate cap; that lesson was applied
    // to the diagnostic printer in the same commit and not to this file.
    //
    // Each spawn now gets whatever remains of TOTAL_BUDGET_MS, so the scan as a
    // whole cannot outlive the scanner's budget however many spawns stall.
    // A TIMEOUT IS RETURNED, NEVER THROWN. An earlier revision let `execFileSync`'s
    // ETIMEDOUT propagate out of `drive()`, out of `evaluate()`, and out of the
    // scanner — which exits 1 with ZERO stdout. `coc-eval-core.mjs` then sees a
    // NUMERIC status, takes its clean-exit branch, and compares 1 against the
    // fixture's declared `exit`, so a KILLED scan is presented as an ordinary
    // verdict mismatch. That is the same kill-laundering class the sibling fixture
    // removed its signal handlers to avoid, reintroduced here in the same change.
    // Returning a sentinel keeps the scan's own verdict machinery in control.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return TIMED_OUT;
    let out;
    try {
      out = execFileSync("node", [HOOK], {
        input: payload,
        encoding: "utf8",
        timeout: Math.min(HOOK_TIMEOUT_MS, remaining),
        // The stubbed PATH — see § THE HOOK'S OWN `npx` IS STUBBED above. Scoped
        // to the HOOK spawn ONLY: `tryResolve` and the anti-vacuity arm below
        // inherit this process's environment and keep the real npx.
        env: HOOK_ENV,
      });
    } catch (e) {
      // ETIMEDOUT ONLY. An earlier revision also tested `e.killed`, which a Tier-1
      // arm measured DEAD on node v25.9.0: `killed` is `undefined` across every
      // probed class — SIGSEGV, SIGABRT, maxBuffer overflow, plain non-zero exit,
      // AND the genuine timeout it was presumably added for, which is caught by the
      // `code` test instead. An un-fired defensive disjunct reads as coverage while
      // providing none (`instrument-bipolarity.md` MUST-4). Narrow is also correct
      // here: a crashing hook MUST rethrow rather than be scored a budget skip.
      if (e && e.code === "ETIMEDOUT") return TIMED_OUT;
      throw e;
    }
    return JSON.parse(out).hookSpecificOutput?.formatter ?? "<none>";
  };

  try {
    // ---- MARKDOWN POLE: the corruption class must stay un-dispatched ---------
    // Re-adding ".md" to the extension list reds THIS case. That is the disarm
    // resistance: the corruption class cannot be reintroduced silently. The pole
    // asserts a failure IDENTITY (the `formatter` string) per
    // instrument-bipolarity.md MUST-2, never a bare exit code.
    const md = path.join(lab, "case.md");
    writeFileSync(md, CORRUPTING_MD);
    const beforeMd = readFileSync(md, "utf8");
    const mdFormatter = drive(md);
    if (mdFormatter === TIMED_OUT) {
      rows.push(
        row("dispatch-md-refused", "markdown dispatch decision (failure identity)", null, null, {
          skipped: true,
          note: "hook spawn exceeded its budget; UNRUNNABLE, scored by NEITHER polarity",
        }),
      );
    } else {
      rows.push(
        row(
          "dispatch-md-refused",
          "markdown dispatch decision (failure identity)",
          want.dispatch.md ? `dispatched (!= "${REFUSED}")` : REFUSED,
          want.dispatch.md ? (mdFormatter !== REFUSED ? `dispatched (!= "${REFUSED}")` : mdFormatter) : mdFormatter,
        ),
      );
    }
    // Only meaningful as the CONSEQUENCE of a refusal — a fixture expecting
    // markdown to be dispatched cannot ALSO be checked for byte-identity. That
    // is a genuine NOT-APPLICABLE, and it is emitted as a `skipped` ROW rather
    // than as silence, for the same reason the TIMED_OUT branch below is:
    // "not applicable" is a VERDICT about a declared id, and a verdict that
    // renders as an absent row is indistinguishable from one that never ran.
    //
    // MEASURED, bipolar, on the fixtures CI runs: with this branch silent the
    // violation pole emitted 14 of 15 declared CHECK_IDS with `md-byte-identical`
    // in neither `checks` nor `skipped`, while the clean pole emitted all 15 —
    // so the shortfall tracked the POLE, not a timeout, and reproduced on every
    // structural eval rather than only under budget exhaustion. The commit that
    // introduced the TIMED_OUT row fixed the RARE branch and left the
    // UNCONDITIONAL one open, one `if` outward.
    //
    // A TIMED-OUT SPAWN EMITS A skipped ROW, IT DOES NOT VANISH. An earlier revision
    // guarded this site with `&& mdFormatter !== TIMED_OUT` and pushed NOTHING, while
    // its SIBLING TIMED_OUT row-emission sites each pushed `skipped: true`. Measured by
    // the Tier-1 redteam: 15 declared CHECK_IDS, 14 accounted for, `md-byte-identical`
    // in neither `checks` nor `skipped`. `CHECK_IDS` is an EXTERNAL contract — a
    // consumer reconciling it against the emitted rows got 15 vs 14 with no account —
    //
    // CORRECTED: this sentence read "the three sibling TIMED_OUT sites" and the commit
    // body said "the ONE site of four". Both are wrong and are withdrawn rather than
    // reworded away. There are THREE row-emission sites, not four, so this one has TWO
    // siblings — the other two `TIMED_OUT` occurrences are sentinel RETURNS inside
    // `drive()`, which emit no row and are therefore not sites of this kind. The count
    // is left UNSPELLED above deliberately: it is the third arithmetic claim in this
    // chain to ship wrong, and a number nobody needs is a number that can rot.
    // and an unaccounted row is the "UNRUNNABLE is not a verdict" collapse
    // (`probe-driven-verification.md` MUST-7) this very file cites, broken at one of
    // the four sites the change touched.
    if (want.dispatch.md) {
      rows.push(
        row("md-byte-identical", "markdown file is left BYTE-IDENTICAL", null, null, {
          skipped: true,
          note: "fixture expects markdown to be DISPATCHED, so byte-identity is not applicable here",
        }),
      );
    } else if (mdFormatter === TIMED_OUT) {
      rows.push(
        row("md-byte-identical", "markdown file is left BYTE-IDENTICAL", null, null, {
          skipped: true,
          note: "hook spawn exceeded its budget; the refusal it is a consequence of never ran",
        }),
      );
    } else {
      rows.push(
        row("md-byte-identical", "markdown file is left BYTE-IDENTICAL", true, readFileSync(md, "utf8") === beforeMd),
      );
    }

    // ---- GREEN POLES: the kept lanes still dispatch --------------------------
    // Without these, "delete the whole hook" would pass the markdown pole. They
    // are what make the cut NARROW rather than a blanket disarm.
    for (const [ext, body] of GREEN_LANES) {
      const f = path.join(lab, `case.${ext}`);
      writeFileSync(f, body);
      const got = drive(f);
      if (got === TIMED_OUT) {
        rows.push(
          row(`dispatch-${ext}`, `.${ext} dispatch decision`, null, null, {
            skipped: true,
            note: "hook spawn exceeded its budget; UNRUNNABLE, scored by NEITHER polarity",
          }),
        );
      } else {
        rows.push(row(`dispatch-${ext}`, `.${ext} dispatch decision`, want.dispatch[ext], got !== REFUSED));
      }
    }

    // ---- The formatter version is PINNED at every call site ------------------
    // An unpinned `npx prettier` resolves whatever sits in the npx cache, so the
    // behaviour of the lanes above is operator-dependent and can change with no diff.
    const src = readFileSync(HOOK, "utf8");
    const pinned = (src.match(/"--yes",\s*PRETTIER_PIN/g) || []).length;
    const bare = (src.match(/\[\s*"prettier"\s*,/g) || []).length;
    const pinDecl = src.match(/const PRETTIER_PIN\s*=\s*"(prettier@(\d+\.\d+\.\d+))"/);
    rows.push(row("pin-declared", "PRETTIER_PIN constant is declared", want.pin_declared, Boolean(pinDecl)));
    rows.push(row("pin-no-bare-call-sites", "every prettier call site is pinned (bare invocations)", want.bare_call_sites, bare));
    rows.push(row("pin-call-sites-present", "pinned call sites present", true, pinned >= want.min_pinned_call_sites));

    // ---- F2: the version is DERIVED FROM the pin, never re-typed -------------
    // A second hand-written copy of the version can drift from the pin while every
    // check still passes; the declaration must therefore be an EXPRESSION over
    // PRETTIER_PIN, and the literal version must not be re-typed anywhere else.
    const versionDecl = src.match(/const PRETTIER_PIN_VERSION\s*=\s*([^;]+);/);
    const nameDecl = src.match(/const PRETTIER_PIN_NAME\s*=\s*([^;]+);/);
    const derivedFromPin =
      Boolean(versionDecl) &&
      /PRETTIER_PIN\b/.test(versionDecl[1]) &&
      Boolean(nameDecl) &&
      /PRETTIER_PIN\b/.test(nameDecl[1]);
    // The pin's OWN halves, computed here independently of how the hook derives
    // them, so "the two agree" is a real comparison and not a restatement.
    const pinAt = pinDecl ? pinDecl[1].lastIndexOf("@") : -1;
    const pinNameHalf = pinAt > 0 ? pinDecl[1].slice(0, pinAt) : "";
    const pinVersionHalf = pinAt > 0 ? pinDecl[1].slice(pinAt + 1) : "";
    rows.push(
      row(
        "pin-version-derived",
        "PRETTIER_PIN_NAME / PRETTIER_PIN_VERSION are parsed from PRETTIER_PIN",
        true,
        derivedFromPin && pinNameHalf === "prettier" && /^\d+\.\d+\.\d+$/.test(pinVersionHalf),
      ),
    );

    // ---- F1 (HIGH): the resolved-cache fast path REFUSES a planted program ----
    // NOTHING pinned the name/version predicates: a reviewer mutated them and all
    // 40 suites stayed green. Each case below plants a program that WOULD write a
    // marker file if it were executed, at the directory the resolver derives, and
    // requires that it is never run — the marker IS the falsifier.
    const secRoot = path.join(lab, ".sec-cache");
    // (a) DERIVED FROM THE HOOK'S OWN PIN, never re-typed (reviewer finding 2a).
    // A second hand-written copy of the spec is a copy that can drift from the pin
    // the hook actually uses — and this fixture's whole job is to compute the SAME
    // directory the hook computes.
    const SEC_PIN = pinDecl ? pinDecl[1] : null;
    const secHash = SEC_PIN
      ? createHash("sha512").update(SEC_PIN).digest("hex").slice(0, 16)
      : null;
    const plantCache = (label, { dirName, name, version, npxPackages = null }) => {
      const marker = path.join(lab, `marker-${label}`);
      const installDir = path.join(secRoot, "_npx", dirName);
      const pkgDir = path.join(installDir, "node_modules", "prettier");
      mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
      writeFileSync(
        path.join(pkgDir, "bin", "planted.cjs"),
        `require("fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n`,
      );
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name, version, bin: "./bin/planted.cjs" }),
      );
      // The INSTALL-DIR manifest, as npm writes it:
      // `<installDir>/package.json` carries `_npx: { packages }` (libnpmexec).
      if (npxPackages) {
        writeFileSync(
          path.join(installDir, "package.json"),
          JSON.stringify({ dependencies: {}, _npx: { packages: npxPackages } }),
        );
      }
      return marker;
    };
    // Returns BOTH the formatter and whether the hook CRASHED — a crash is not a
    // pass (reviewer finding 2c).
    const driveWithCache = (file, cacheRoot) => {
      const payload = JSON.stringify({ tool_input: { file_path: file }, cwd: lab });
      let out;
      try {
        out = execFileSync("node", [HOOK], {
          input: payload,
          encoding: "utf8",
          timeout: HOOK_TIMEOUT_MS,
          env: { ...HOOK_ENV, npm_config_cache: cacheRoot },
        });
      } catch (e) {
        return { formatter: "<hook-error>", crashed: true, detail: String(e.message).slice(0, 80) };
      }
      try {
        return {
          formatter: JSON.parse(out).hookSpecificOutput?.formatter ?? "<none>",
          crashed: false,
          detail: "",
        };
      } catch {
        return { formatter: "<unparseable-stdout>", crashed: true, detail: out.slice(0, 80) };
      }
    };
    // (b) A POSITIVE CASE IS MANDATORY (reviewer finding 2b). Without one, nothing
    // proves the fixture's computed directory EQUALS the hook's — every negative
    // case would pass just as happily if the two disagreed, because a hook looking
    // in the WRONG place also never runs the planted program.
    const SEC_CASES = [
      ["sec-correct-runs", "the CORRECT name+version in the computed _npx dir DOES run", {
        dirName: secHash,
        name: "prettier",
        version: SEC_PIN ? SEC_PIN.slice(SEC_PIN.lastIndexOf("@") + 1) : null,
        npxPackages: SEC_PIN ? [SEC_PIN] : null,
      }, "runs"],
      // EACH NEGATIVE CASE BELOW CARRIES A VALID `_npx.packages`, DELIBERATELY.
      // `_npx` is a SECOND, independent refusal reason; leaving it absent here would
      // let it mask the predicate each case names — a mutant that removes the name
      // check would still be refused by `_npx`, the case would stay green, and the
      // mutation would look like it did nothing. With the record present, the ONLY
      // thing refusing each case is the property in its NAME. (The `_npx` defence
      // has its own case, below.)
      // A DECOY in a DIFFERENT `_npx` directory: the old scan picked by readdir
      // order and would have run this. The derived single candidate never looks.
      ["sec-decoy-not-run", "a decoy prettier in ANOTHER _npx dir is NOT run", {
        dirName: "0000000000000000",
        name: "prettier",
        version: SEC_PIN ? SEC_PIN.slice(SEC_PIN.lastIndexOf("@") + 1) : null,
        npxPackages: SEC_PIN ? [SEC_PIN] : null,
      }, "not-run"],
      ["sec-wrong-name-not-run", "a cached package with the WRONG name is NOT run", {
        dirName: secHash,
        name: "not-prettier",
        version: SEC_PIN ? SEC_PIN.slice(SEC_PIN.lastIndexOf("@") + 1) : null,
        npxPackages: SEC_PIN ? [SEC_PIN] : null,
      }, "not-run"],
      ["sec-wrong-version-not-run", "a cached package with the WRONG version is NOT run", {
        dirName: secHash,
        name: "prettier",
        version: "0.0.0-not-the-pin",
        npxPackages: SEC_PIN ? [SEC_PIN] : null,
      }, "not-run"],
      // The `_npx` corroboration's OWN pole (reviewer finding 5): everything about
      // the package is right, but the install dir does not record THIS spec.
      ["sec-no-npx-record-not-run", "a package the install dir does not record for this spec is NOT run", {
        dirName: secHash,
        name: "prettier",
        version: SEC_PIN ? SEC_PIN.slice(SEC_PIN.lastIndexOf("@") + 1) : null,
        npxPackages: ["some-other-tool@1.2.3"],
      }, "not-run"],
    ];
    for (const [id, label, spec, want] of SEC_CASES) {
      rmSync(path.join(secRoot), { recursive: true, force: true });
      const marker = plantCache(id, spec);
      const target = path.join(lab, `${id}.json`);
      writeFileSync(target, '{"a":  1}\n');
      const r = driveWithCache(target, secRoot);
      const ran = existsSync(marker);
      let ok;
      let why;
      if (!SEC_PIN) {
        ok = false;
        why = "no PRETTIER_PIN parsed from the hook — the fixture cannot compute a directory";
      } else if (r.crashed) {
        // (c) A CRASHING HOOK IS A FAIL, not a pass. `<hook-error>` satisfies
        // "formatter !== prettier", so without this clause every negative case
        // below would go GREEN on a hook that does not run at all.
        ok = false;
        why = `hook CRASHED (${r.detail})`;
      } else if (want === "runs") {
        ok = ran && r.formatter === "prettier";
        why = `marker=${ran ? "RAN" : "absent"} formatter=${r.formatter}`;
      } else {
        ok = !ran && r.formatter !== "prettier";
        why = `marker=${ran ? "RAN" : "absent"} formatter=${r.formatter}`;
      }
      rows.push(row(id, label, true, ok, { note: ok ? null : why }));
    }

    // ---- The pin RESOLVES to the pinned version ------------------------------
    // The three assertions above read SOURCE TEXT: they prove the specifier is
    // written, not that it BINDS. A pin that is honoured and a pin that is
    // silently ignored are byte-identical in source.
    // BUDGET-SPENT IS NOT UNREACHABLE, AND CONFLATING THEM PRINTED A CAUSE NOBODY
    // MEASURED. This returned plain `null` when the aggregate budget was gone, so
    // the arm took the offline road and reported "npx unreachable (control also
    // failed)" — on a host where `npx --yes prettier@3.9.6 --version` MEASURABLY
    // exits 0 in 9650ms. The note named an environment fact the scan never probed,
    // which is the unnameable-falsifying-result class (instrument-discipline.md
    // MUST-1) in the skip REASON rather than in the verdict. A distinct sentinel
    // keeps the two apart all the way to the reported note.
    const BUDGET_SPENT = Symbol("budget-spent");
    const TIMED_OUT_NPX = Symbol("npx-timed-out");
    const tryResolve = (spec) => {
      const left = budgetLeft();
      if (left === null) return BUDGET_SPENT;
      try {
        return execFileSync("npx", ["--yes", spec, "--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          // BOUNDED BY THE SHARED DEADLINE, not by NPX_TIMEOUT_MS alone. The
          // per-spawn value is a ceiling; the aggregate is what has to fit inside
          // `coc-eval-core.mjs::scannerTimeoutMs()` (30000ms), and `tryResolve` is
          // called TWICE (the pin, then the control) so this site alone could spend
          // 20000ms before the anti-vacuity call below spent another 10000ms. A
          // timeout raises, so it takes the SAME road as an offline failure and the
          // arm degrades to its declared `skipped`.
          timeout: Math.min(NPX_TIMEOUT_MS, left),
        }).trim();
      } catch (e) {
        // A TIMEOUT IS NOT AN UNREACHABLE REGISTRY, and reporting it as one was the
        // second misattribution in this arm. MEASURED on this host: `npx --yes
        // prettier@3.9.6 --version` exits 0 in 9650ms standalone, i.e. npx WORKS and
        // simply does not fit inside the 10000ms per-spawn ceiling once the scan's
        // own load is on the machine. The old bare `catch` folded ETIMEDOUT in with
        // ENOENT and with a non-zero exit, so "we did not wait long enough" and "the
        // registry is not there" printed the same sentence.
        if (e && e.code === "ETIMEDOUT") return TIMED_OUT_NPX;
        return null;
      }
    };
    if (!pinDecl) {
      rows.push(row("pin-resolves", "the pin RESOLVES to its pinned version", null, null, { skipped: true, note: "no PRETTIER_PIN declared to resolve" }));
    } else {
      const resolved = tryResolve(pinDecl[1]);
      if (resolved === BUDGET_SPENT) {
        rows.push(
          row("pin-resolves", "pin resolution", null, null, {
            skipped: true,
            note: "aggregate spawn budget was spent before this arm; npx was NOT probed, so nothing here is evidence about the registry",
          }),
        );
      } else if (resolved === TIMED_OUT_NPX) {
        rows.push(
          row("pin-resolves", "pin resolution", null, null, {
            skipped: true,
            note: `npx did not return within ${NPX_TIMEOUT_MS}ms; it was NOT shown unreachable and the pin was NOT shown bad — this host is too slow for this arm, which is an environment fact about LATENCY, not about the registry`,
          }),
        );
      } else if (resolved !== null) {
        rows.push(row("pin-resolves", "the pin RESOLVES to its pinned version", pinDecl[2], resolved));
      } else {
        // "could not resolve" has TWO causes and they are opposite in meaning:
        // npx is unreachable (legitimate offline skip) vs npx works and THIS
        // specifier is bad (a real defect). A bare skip would score a bogus pin
        // as clean — absence reading as a pass. So separate them with a control
        // the environment must satisfy.
        const control = tryResolve("prettier@3.8.0");
        if (control === TIMED_OUT_NPX) {
          rows.push(
            row("pin-resolves", "pin resolution", null, null, {
              skipped: true,
              note: `the pin failed outright, but the discriminating control TIMED OUT at ${NPX_TIMEOUT_MS}ms rather than answering; unreachable-registry vs bad-pin is UNDETERMINED`,
            }),
          );
        } else if (control === BUDGET_SPENT) {
          // The control is what tells an unreachable registry from a bad pin. If it
          // never ran, NEITHER verdict is available and the arm reports that — it
          // does not fall through to the offline note, which would assert the very
          // thing the control was there to establish.
          rows.push(
            row("pin-resolves", "pin resolution", null, null, {
              skipped: true,
              note: "the pin did not resolve, and the aggregate budget was spent before the discriminating control could run; unreachable-registry vs bad-pin is UNDETERMINED",
            }),
          );
        } else if (control !== null) {
          rows.push(row("pin-resolves", "the pin RESOLVES (control resolved, so the PIN is the defect)", pinDecl[2], `UNRESOLVABLE:${pinDecl[1]}`));
        } else {
          rows.push(row("pin-resolves", "pin resolution", null, null, { skipped: true, note: "npx unreachable (control also failed); NOT a pass" }));
        }
      }
    }

    // ---- ANTI-VACUITY: the payload really is a corrupting input --------------
    // Without this the markdown pole is satisfiable by a payload prettier would
    // not have touched anyway, and the suite would pass while proving nothing.
    //
    // The version is READ FROM THE DECLARATION (`pinDecl[1]`), never written here.
    // A hardcoded literal is correct exactly until the first pin bump, after which
    // this case verifies corruption under a version the hook NO LONGER INVOKES.
    if (!pinDecl) {
      rows.push(row("red-pole-payload-corrupts", "anti-vacuity", null, null, { skipped: true, note: "no PRETTIER_PIN declared to test against" }));
    } else {
      let corrupts = null;
      let budgetSpent = false;
      let timedOut = false;
      const vacuityLeft = budgetLeft();
      try {
        if (vacuityLeft === null) {
          budgetSpent = true;
          throw new Error("budget spent");
        }
        const formatted = execFileSync("npx", ["--yes", pinDecl[1], "--parser", "markdown"], {
          input: CORRUPTING_MD,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          // Bounded by the SAME shared deadline as every other spawn in this scan,
          // which is the point: "whatever budget the first call left" is now
          // enforced rather than merely observed.
          timeout: Math.min(NPX_TIMEOUT_MS, vacuityLeft),
        });
        corrupts = formatted !== CORRUPTING_MD;
      } catch (e) {
        /* leave null rather than asserting a green we did not earn — but RECORD
           which road we came in on, so the note reports a cause that was measured
           rather than the standing "offline" claim this branch used to print. */
        if (e && e.code === "ETIMEDOUT") timedOut = true;
      }
      if (corrupts === null) {
        // The note is DERIVED from what this scan already measured, never asserted.
        // "prettier unavailable offline" was a standing claim about the environment
        // made by a branch that reached it whenever the spawn did not complete —
        // including when the budget had been spent and npx was never touched, and
        // including on a host where the SIBLING arm above had just resolved the pin.
        const pinRow = rows.find((r) => r.id === "pin-resolves");
        const pinResolved = pinRow !== undefined && pinRow.skipped === false && pinRow.passed === true;
        const note = budgetSpent
          ? "aggregate spawn budget was spent before this arm; prettier was NOT probed for corruption"
          : timedOut
            ? `the markdown probe did not return within ${NPX_TIMEOUT_MS}ms; LATENCY, not an absent registry — corruption was NOT probed`
            : pinResolved
              ? "the pin RESOLVED in the arm above, so this is not an offline host: the markdown probe itself exited non-zero"
              : "the pinned prettier could not be run here; corruption was NOT probed";
        rows.push(row("red-pole-payload-corrupts", "anti-vacuity", null, null, { skipped: true, note }));
      } else {
        rows.push(
          row(
            "red-pole-payload-corrupts",
            `the RED-pole payload genuinely corrupts under the DECLARED pin (${pinDecl[1]})`,
            want.payload_corrupts_under_pin,
            corrupts,
          ),
        );
      }
    }
  } finally {
    rmSync(lab, { recursive: true, force: true });
  }

  return { rows, failed: rows.filter((r) => r.passed === false).map((r) => r.id) };
}
