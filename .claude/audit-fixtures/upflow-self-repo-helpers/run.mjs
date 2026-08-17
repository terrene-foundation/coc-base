#!/usr/bin/env node
/**
 * upflow-self-repo-helpers — instruments for the MODULE-LEVEL guards that the
 * subprocess fence suite structurally cannot reach.
 *
 * WHY A SECOND SUITE. `upflow-open-never-complete/run.mjs` drives the ADAPTERS
 * through a real git repo in a child process. That is the right shape for the
 * fence, and the wrong shape for three guards:
 *   - `_lastGitStderr`'s reset needs TWO derivations in ONE process; the fence
 *     suite spawns exactly one call per case.
 *   - `getProvider` is in a different module (`vcs-provider.js`) that the fence
 *     suite never loads — and which had NO fixture anywhere in audit-fixtures/.
 *   - `sanitizeForReason` / `displayPrId` are pure functions whose contract is
 *     about which bytes DO NOT survive; asserting that through an adapter
 *     refusal string only reaches the cases an adapter happens to produce.
 *
 * Each of these shipped WITHOUT an instrument and was caught by an adversarial
 * round measuring that its removal left the fence suite fully green. Per
 * `cc-artifacts.md` Rule 9 a guard ships with the fixture that reds when it is
 * removed; per `instrument-discipline.md` MUST-1 each assertion below states a
 * result the guard's ABSENCE would produce.
 *
 * Mutations that red each case are recorded in README.md, measured.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "..", "hooks", "lib");

const selfRepo = require(path.join(LIB, "upflow-self-repo.js"));
const { getProvider } = require(path.join(LIB, "vcs-provider.js"));

// Built from char codes, never as source literals: a bidi override or a raw
// control byte written literally into this file would be invisible to a reviewer
// — the exact property these guards exist to remove from output.
const NL = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const RLO = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
const LSEP = String.fromCharCode(0x2028); // LINE SEPARATOR
const NEL = String.fromCharCode(0x85); // C1 NEL
// Added after an adversarial round found the class incomplete against the
// Trojan-Source threat it DECLARES: the directional MARKS are invisible
// strong-direction characters that reorder adjacent neutrals, same class as the
// overrides, and were surviving. Zero-widths hide content / split tokens.
const ALM = String.fromCharCode(0x061c); // ARABIC LETTER MARK
const LRM = String.fromCharCode(0x200e); // LEFT-TO-RIGHT MARK
const RLM = String.fromCharCode(0x200f); // RIGHT-TO-LEFT MARK
const ZWSP = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
const BOM = String.fromCharCode(0xfeff); // ZERO WIDTH NO-BREAK SPACE
const CSI8 = String.fromCharCode(0x9b); // C1 8-bit CSI (ANSI without ESC)
// Added after an adversarial round found the class still incomplete against the
// hide-content half of its OWN stated threat. The zero-widths above were
// included with the rationale "hide content and split tokens" — these hide
// content identically and were not:
const WJ = String.fromCharCode(0x2060); // WORD JOINER
const INVPLUS = String.fromCharCode(0x2064); // INVISIBLE PLUS
const VS16 = String.fromCharCode(0xfe0f); // VARIATION SELECTOR-16
// The Unicode TAG block is the canonical invisible-text-smuggling channel:
// U+E0020-E007F encode printable ASCII invisibly, so an entire instruction can
// ride inside a host or an error message. These reasons reach PR bodies and
// journals that a downstream AGENT reads, which makes this an injection channel
// rather than a log-cosmetics issue.
const TAG_A = String.fromCodePoint(0xe0041); // TAG LATIN CAPITAL A
const TAG_CANCEL = String.fromCodePoint(0xe007f); // CANCEL TAG

const cases = [];
const t = (name, mutation, fn) => cases.push({ name, mutation, fn });

// ---------------------------------------------------------------------------
// displayPrId — positive allowlist over [0-9]
// ---------------------------------------------------------------------------

t(
  "displayPrId/strips-every-injection-class",
  "upflow-self-repo.js::displayPrId — return String(value) unchanged, or revert the [^0-9] allowlist to the [\\x00-\\x1f\\x7f-\\x9f] denylist",
  () => {
    // The denylist this replaced caught the first two and MISSED the last three.
    // Measured before the fix: U+202E and U+2028 survived verbatim.
    for (const payload of [NL, ESC, NUL, NEL, RLO, LSEP]) {
      const out = selfRepo.displayPrId(`77${payload}evil`);
      if (out.includes(payload)) {
        return `payload U+${payload.charCodeAt(0).toString(16).padStart(4, "0")} survived: ${JSON.stringify(out)}`;
      }
    }
    return null;
  },
);

t(
  "displayPrId/preserves-a-legitimate-id",
  "upflow-self-repo.js::displayPrId — replace the allowlist with a class that also eats digits",
  () => {
    // The over-tightening polarity. A sanitizer that mangles valid ids makes
    // every refusal message useless, and a strip-only suite cannot detect it.
    const out = selfRepo.displayPrId(4242);
    return out === "4242"
      ? null
      : `expected "4242", got ${JSON.stringify(out)}`;
  },
);

t(
  "displayPrId/does-not-throw-on-hostile-toString",
  "upflow-self-repo.js::displayPrId — drop the try/catch around String(value)",
  () => {
    // `String(value)` INVOKES caller code. A throw here converts a typed
    // {ok:false, reason} refusal into an uncaught exception, and the fence suite
    // asserts error === null precisely because a crash reads as a refusal to any
    // assertion that only checks ok === false.
    const hostile = {
      toString() {
        throw new Error("hostile");
      },
    };
    try {
      const out = selfRepo.displayPrId(hostile);
      return typeof out === "string"
        ? null
        : `expected a string, got ${typeof out}`;
    } catch (err) {
      return `threw instead of returning a placeholder: ${err && err.message}`;
    }
  },
);

// ---------------------------------------------------------------------------
// sanitizeForReason — free-form diagnostic text
// ---------------------------------------------------------------------------

t(
  "sanitizeForReason/strips-structure-forging-classes",
  "upflow-self-repo.js::sanitizeForReason — return the input unchanged, or drop the \\u2028/\\u202a-\\u202e/\\u2066-\\u2069 members from the class",
  () => {
    for (const payload of [
      NL,
      ESC,
      NUL,
      NEL,
      CSI8,
      RLO,
      LSEP,
      ALM,
      LRM,
      RLM,
      ZWSP,
      BOM,
      WJ,
      INVPLUS,
      VS16,
      TAG_A,
      TAG_CANCEL,
    ]) {
      const out = selfRepo.sanitizeForReason(`host${payload}evil.example`);
      if (out.includes(payload)) {
        return `payload U+${payload.charCodeAt(0).toString(16).padStart(4, "0")} survived: ${JSON.stringify(out)}`;
      }
    }
    return null;
  },
);

t(
  "sanitizeForReason/preserves-readable-non-ascii",
  "upflow-self-repo.js::sanitizeForReason — replace the class with an ASCII-only allowlist",
  () => {
    // The over-tightening polarity, and the reason this is a SEPARATE helper
    // from displayPrId. Git's stderr names paths the operator must recognize; an
    // ASCII-only allowlist would mangle any non-ASCII path into unreadability,
    // destroying the diagnostic value this text exists to provide.
    const out = selfRepo.sanitizeForReason("/srv/café/repo: dubious ownership");
    return out === "/srv/café/repo: dubious ownership"
      ? null
      : `legitimate non-ASCII path was mangled: ${JSON.stringify(out)}`;
  },
);

// ---------------------------------------------------------------------------
// _lastGitStderr reset — needs two derivations in ONE process
// ---------------------------------------------------------------------------

t(
  "deriveSelfRepoRef/git-stderr-does-not-leak-across-calls",
  // THIS CASE WAS PREVIOUSLY RECORDED AS HAVING NO REDDENING MUTATION, resolved
  // "INERT, not vacuous". THAT VERDICT WAS WRONG, and it is worth stating why,
  // because it is the exact failure this suite exists to catch — an unfalsified
  // claim about an instrument.
  //
  // The reasoning rested on: "the only null-return paths that assign nothing are
  // `!gitBin` and an empty-stdout success, and neither is reachable from an
  // in-process fixture without stubbing." The `!gitBin` half is sound. The
  // empty-stdout half is FALSE — an adversarial round produced the reachable
  // input, from an ordinary repo with no stubbing:
  //     git config remote.origin.url " "
  //     git remote get-url origin   ->  exit 0, stdout " \n"
  // which `.trim()`s to "" and returns null through the SUCCESS branch. The
  // earlier case used a nonexistent directory for call 2, which THROWS and so
  // goes through the catch — and the catch always assigns. So the case was
  // driving the one shape that could not discriminate, and the "inert" verdict
  // was a reachability argument that did not hold.
  //
  // Corrected: call 2 now drives the whitespace-url path, the mutation REDS, and
  // the reset is not merely defensive — it prevents a LIVE cross-call leak.
  "upflow-self-repo.js::_readOriginRemote — delete the `_lastGitStderr = null;` reset at function entry",
  () => {
    // Call 1 fails with a stderr naming THIS directory; call 2 fails on a
    // directory git cannot even enter. Call 2's refusal must not quote call 1's
    // message — that would assert, in the grammar of an observation, something
    // git never said on that call about a repo it was never asked about.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-"));
    try {
      const repo = path.join(root, "a-repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
      // Call 1: a real git repo with NO origin. git EXITS NON-ZERO and writes
      // "error: No such remote 'origin'" to stderr, so the catch assigns.
      const first = selfRepo.deriveSelfRepoRef(repo);
      if (first.ok) return "setup invariant broken: call 1 should refuse";

      // Call 2 MUST take a null-return path that assigns NOTHING, or this case
      // cannot discriminate. A WHITESPACE-ONLY origin url is that path, and it
      // is an ordinary repo — no stubbing:
      //     git config remote.origin.url " "
      //     git remote get-url origin   ->  exits 0, stdout " \n"
      // `_readOriginRemote` then does `s.trim()` -> "" -> `return s || null`,
      // i.e. the SUCCESS branch, which never touches `_lastGitStderr`.
      const repo2 = path.join(root, "b-repo");
      fs.mkdirSync(repo2);
      execFileSync("git", ["init", "-q"], { cwd: repo2, stdio: "ignore" });
      execFileSync("git", ["config", "remote.origin.url", " "], {
        cwd: repo2,
        stdio: "ignore",
      });
      const second = selfRepo.deriveSelfRepoRef(repo2);
      if (second.ok) return "setup invariant broken: call 2 should refuse";
      if (
        second.reason.includes("a-repo") ||
        second.reason.includes("git said")
      ) {
        return `call 2's refusal leaked call 1's stderr: ${JSON.stringify(second.reason.slice(0, 200))}`;
      }
      return null;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// getProvider — own-property lookup
// ---------------------------------------------------------------------------

t(
  "getProvider/inherited-keys-are-not-providers",
  "vcs-provider.js::getProvider — revert to `const adapter = PROVIDERS[id];` (a plain index inherits from Object.prototype)",
  () => {
    // `Object.freeze` on an object LITERAL leaves Object.prototype on the chain,
    // so PROVIDERS["constructor"] is the Object function — TRUTHY — and the
    // "unknown provider" refusal never fires. The id arrives from
    // roster.genesis.provider and from a coordination-log record's
    // content.provider, so it is externally authorable.
    for (const key of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
    ]) {
      const r = getProvider(key);
      if (r.ok) return `inherited key "${key}" resolved as a provider`;
    }
    return null;
  },
);

t(
  "getProvider/refusal-reason-is-sanitized-and-bounded",
  "vcs-provider.js::getProvider — interpolate `id` raw into the refusal reason again",
  () => {
    // `id` arrives from `roster.genesis.provider` and from a coordination-log
    // record's `content.provider` — the module's own comment says so — and it
    // was interpolated raw and unbounded into a reason that is logged. This was
    // the sharpest instance of the enforcement-surface asymmetry: two operands
    // in the adapters were sanitized while this one, in a sibling module one
    // require away from the same helper, was not.
    const r = getProvider(`evil${NL}FORGED: ok`);
    if (r.ok) return "a forged provider id resolved";
    if (r.reason.includes(NL))
      return `newline survived: ${JSON.stringify(r.reason)}`;
    const long = getProvider("z".repeat(500));
    return long.reason.length < 300
      ? null
      : `unbounded id produced a ${long.reason.length}-char reason`;
  },
);

t(
  "getProvider/real-providers-still-resolve",
  "vcs-provider.js::getProvider — over-tighten the membership test so a real id stops resolving",
  () => {
    // The permissive polarity: a refusal-only pair cannot detect a fix that
    // breaks legitimate resolution.
    for (const id of ["github", "azure-devops"]) {
      const r = getProvider(id);
      if (!r.ok) return `legitimate provider "${id}" was refused: ${r.reason}`;
    }
    const dflt = getProvider(undefined);
    return dflt.ok && dflt.providerId === "github"
      ? null
      : "the undefined -> github default regressed";
  },
);

t(
  "deriveSelfRepoRef/parse-failure-host-reason-is-bounded",
  "upflow-self-repo.js::deriveSelfRepoRef — put the parse-failure `where` back on bare `sanitizeForReason(split.host)` (drop `reasonText`)",
  () => {
    // `_splitRemoteUrl` returns the authority up to the first `/` and NOTHING
    // upstream caps it. `sanitizeForReason` replaces characters one-for-one and
    // does NOT shorten, so a huge authority produced a refusal `reason` as large
    // as the remote — logged, and embeddable in a PR body by /codify Step-7c.
    //
    // The remote below SPLITS (printable-ASCII authority) but does NOT PARSE
    // (one path segment, so no owner/name pair), which is exactly the branch
    // that interpolates the host.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-hostbound-"));
    try {
      const repo = path.join(root, "r");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
      const hugeHost = `${"h".repeat(50000)}.example.com`;
      execFileSync(
        "git",
        ["remote", "add", "origin", `https://${hugeHost}/only-one-segment`],
        { cwd: repo, stdio: "ignore" },
      );
      const r = selfRepo.deriveSelfRepoRef(repo);
      if (r.ok) return "setup invariant broken: this remote must not parse";
      if (!/does not parse to an owner\/name pair/.test(r.reason)) {
        return `setup invariant broken: took a different refusal branch: ${r.reason.slice(0, 120)}`;
      }
      // The bound is 256 code points on the OPERAND; the surrounding prose is
      // fixed-size. 1000 is comfortably above the bounded total and orders of
      // magnitude below the 50k unbounded one, so this cannot pass by accident.
      return r.reason.length < 1000
        ? null
        : `unbounded host produced a ${r.reason.length}-char refusal reason`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

t(
  "deriveSelfRepoRef/parse-failure-host-reason-stays-diagnostic",
  "upflow-self-repo.js::deriveSelfRepoRef — over-tighten the bound (e.g. slice the operand to a few chars) so the host stops being identifiable",
  () => {
    // The PERMISSIVE polarity. The case above alone cannot distinguish a correct
    // bound from a truncate-to-nothing bug: both produce a short reason. The
    // whole point of naming the host is that an operator recognizes it, so a
    // normal-length host MUST survive intact.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "helpers-hostkeep-"));
    try {
      const repo = path.join(root, "r");
      fs.mkdirSync(repo);
      execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://git.example.com/only-one-segment"],
        { cwd: repo, stdio: "ignore" },
      );
      const r = selfRepo.deriveSelfRepoRef(repo);
      if (r.ok) return "setup invariant broken: this remote must not parse";
      return r.reason.includes("git.example.com")
        ? null
        : `a legitimate host stopped being identifiable: ${JSON.stringify(r.reason)}`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------

let failed = 0;
for (const c of cases) {
  let err = null;
  try {
    err = c.fn();
  } catch (e) {
    err = `threw: ${e && e.message}`;
  }
  if (err) {
    failed += 1;
    console.log(`  not ok ${c.name}`);
    console.log(`      ${err}`);
  } else {
    console.log(`  ok ${c.name}`);
  }
}

const total = cases.length;
if (failed) {
  console.log(`\nupflow-self-repo-helpers: ${failed}/${total} FAILED`);
  process.exit(1);
}
console.log(`\nupflow-self-repo-helpers: ${total}/${total} PASS`);
