#!/usr/bin/env node
/**
 * coc-roster-register.mjs — the canonical roster-write executable for
 * `/whoami --register`.
 *
 * WHAT THIS REPLACES, AND WHY IT IS A FILE. Until this landed, the `--register`
 * ceremony was a heredoc INSIDE `commands/whoami.md`, written fresh to
 * `$TMPDIR/coc-roster-register.cjs` on every run. That shape has three defects
 * that only a committed file removes:
 *   1. A fence added to it is regenerated from the markdown each run, so it can
 *      be edited away with no diff on any executable.
 *   2. Nothing can test it. `instrument-discipline.md` MUST-2 asks for a
 *      mutation that REDS a test; an artefact that does not exist between runs
 *      has no line to mutate. A prior lane needing to fence this ceremony had to
 *      attach its fence to `roster-schema-validate.js` instead.
 *   3. It has no version, no registry entry, and no `--help`.
 *
 * WHY IT STAYS SCRIPT-BY-PATH. `hooks/validate-bash-command.js`
 * (`detectStateFileMutationSegmentAware`, Layer 3) BLOCKS any interpreter-led
 * command whose COMMAND STRING carries a protected state-file path —
 * `operators.roster.json` among them. This file keeps that path in its BODY and
 * takes every input from `process.env`, so the sanctioned invocation is a bare
 * `node .claude/bin/coc-roster-register.mjs` with an env prefix that names no
 * protected path. That is the same contract the heredoc satisfied; being
 * committed does not relax it. Passing the roster path as an ARGUMENT would put
 * the literal back on the scanned command line — so there is deliberately no
 * `--roster` flag. Tests redirect via `COC_REPO_DIR`, a repo ROOT, which carries
 * no protected token.
 *
 * The lexical guard is defense-in-depth. The load-bearing protections are
 * branch protection on `operators.roster.json`, schema validation, and the PR
 * gate — none of which this file may substitute for.
 *
 * REFUSALS. Every refusal of the prose ceremony is preserved; three are ADDED
 * (see `--help`). No refusal was removed. Any exit != 0 writes NOTHING.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isMainModule } from "./lib/entry-point.mjs";

const require = createRequire(import.meta.url);

// THE single durable roster writer. Shared with `add-key-ceremony.js` and
// `clean-instantiate.mjs` -- one function, not three copies that drift
// (`security.md` para Enforcement-Surface Parity).
const { writeRosterAtomic } = require("../hooks/lib/roster-write.js");
// The hardened READ half of the same contract, from the module the writer above already
// takes its flag set from. Two reads below (`rosterPath` and `schemaPath`) were plain
// `readFileSync`; `readFileHardened` owns the open(2) flag set in ONE place
// (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` plus an fstat regular-file check on the HELD fd) per
// `security.md` § "Multi-Site Kwarg Plumbing". It is not state-dir-bound — it takes an
// arbitrary path — and it is already in this file's require closure transitively via
// `roster-write.js`, so this adds no new module-resolution failure mode.
const { readFileHardened } = require("../hooks/lib/state-io.js");

/*
 * EVERY git THIS FILE SPAWNS ROUTES THROUGH THE SHARED ENVELOPE
 * (`.claude/hooks/lib/git-subprocess-env.js`), per `rules/security.md`
 * § Enforcement-Surface Parity and the loom#1471 G7 ratchet over `.claude/bin/**`.
 *
 * WHY IT MATTERS HERE SPECIFICALLY, not as ceremony. The single git this file runs
 * answers R5 — "am I on main?" — the gate that stops a roster write from landing
 * outside a codify branch. `-C`/`cwd:` choose a DIRECTORY; only a constants-built
 * env chooses the REPOSITORY, so an inherited `GIT_DIR` makes a decoy repo answer
 * "codify/x" for a checkout sitting on main, and R5 passes on a tree it never read.
 * A PATH-resolved `git` is the same defeat with an attacker-supplied binary.
 *
 * `symbolic-ref --short HEAD` is a LOCAL read — nothing reaches a remote — so it
 * takes the STRICTER `gitEnv()` profile, not `gitNetEnv()`.
 *
 * Loaded through `createRequire` (the module is CommonJS — the established
 * .mjs->CJS bridge in this directory, same as `check-ratchet-monotonicity.mjs`).
 * The load is GUARDED so a missing module cannot kill `--help` or `--selftest`,
 * and absence is NOT swallowed: it THROWS at the call site into R5's pre-existing
 * UNKNOWN branch, which prints a loud `R5 UNKNOWN` on stderr and leaves
 * server-side branch protection as the load-bearing control — the same path an
 * absent git already took. There is deliberately NO ambient fallback: a green R5
 * obtained from an unenveloped git is the defeat this comment exists to prevent.
 */
let gitSubprocessEnv = null;
try {
  gitSubprocessEnv = require("../hooks/lib/git-subprocess-env.js");
} catch {
  gitSubprocessEnv = null; // absent -> R5 UNKNOWN (loud), never an ambient git
}

/** Roster path fragment — kept OFF every command line by construction. */
const ROSTER_REL = path.join(".claude", "operators.roster.json");

/** The role a `--register` proposal may mint. Promotion is a separate quorum
 *  gate (`--owner-add` for owners, a 2-of-N roster edit for senior), so this is
 *  hardcoded and is deliberately NOT operator-supplied. */
const REGISTER_ROLE = "contributor";

const ENV_KEYS = {
  PERSON_ID: "person_id",
  DISPLAY_ID: "display_id",
  GH_LOGIN: "github_login",
  PRINCIPAL: "principal",
  HOST_ROLE: "host_role",
  KEY_TYPE: "type",
  FP: "fingerprint",
  PUBKEY: "pubkey",
};

const HELP = `coc-roster-register.mjs — canonical roster writer for /whoami --register

USAGE (bare command; the roster path is NEVER an argument)
  PERSON_ID=... DISPLAY_ID=... GH_LOGIN=... HOST_ROLE=... \\
  KEY_TYPE=... FP=... PUBKEY=... node .claude/bin/coc-roster-register.mjs

  --help       print this
  --selftest   run the built-in negative controls (writes nothing)

ENVIRONMENT
  PERSON_ID   pid-<display_id>-<first 8 of sha256(pubkey)>   (required)
  DISPLAY_ID  advisory handle                                 (required)
  HOST_ROLE   human | ci                                      (required)
  KEY_TYPE    ssh | gpg                                       (required)
  FP          signing-key fingerprint (the verified_id)       (required)
  PUBKEY      armored public key body                         (required)
  GH_LOGIN    GitHub collaborator login   (required unless PRINCIPAL)
  PRINCIPAL   Entra UPN, azure-devops provider (alternative to GH_LOGIN)
  COC_REPO_DIR  repo root override; defaults to cwd. Tests only.

REFUSALS PRESERVED FROM THE PROSE CEREMONY
  R1  role is hardcoded "${REGISTER_ROLE}"; it is not readable from the environment.
  R2  schema validation failure is a HARD STOP — nothing is written. (exit 1)
  R3  absent inputs never produce a write.

REFUSALS ADDED BY THIS EXECUTABLE (none removed)
  R4  missing required inputs are named explicitly instead of being written as
      \`undefined\` and left for the schema to reject. Strictly earlier, never
      later, than R3. (exit 2)
  R5  refuses on branch main/master — the prose ceremony says "NEVER writes
      directly to main" but nothing enforced it locally. UNKNOWN branch (no git,
      detached HEAD) WARNS and proceeds: server-side branch protection is the
      load-bearing control, and failing closed there would block the documented
      genesis flow. (exit 3)
  R6  refuses to silently overwrite an existing person_id with DIFFERENT content
      — the prose ceremony's \`persons[id] = {...}\` clobbered keys with no
      signal. An IDENTICAL re-run is an idempotent no-op (exit 0), so a retry
      after a partial failure still works. (exit 4)
  R7  refuses a person_id that fails the schema's own \`persons.propertyNames\`
      pattern, BEFORE assignment. The prose ceremony assigned first; a
      person_id of \`__proto__\` mutated the prototype instead of adding an own
      property, so the validator saw an unchanged roster and passed. The pattern
      is READ FROM THE SCHEMA, never restated here. (exit 5)
  R8  GH_LOGIN and PRINCIPAL are mutually exclusive. (exit 2)
`;

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Resolve the roster path from a repo ROOT (never from an argument). */
export function rosterPathFor(repoDir) {
  return path.join(repoDir, ROSTER_REL);
}

/**
 * Read the person_id constraint from the schema itself so this file never
 * restates it (`specs-authority.md` Rule 9). Returns a RegExp or null when the
 * schema does not declare one.
 */
export function personIdPatternFrom(schema) {
  const p = schema?.properties?.persons?.propertyNames?.pattern;
  return typeof p === "string" && p.length > 0 ? new RegExp(p) : null;
}

/** Collect + refuse on inputs. Pure over an env-shaped object. */
export function collectInput(env) {
  const missing = [];
  const get = (k) => {
    const v = env[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const ghLogin = get("GH_LOGIN");
  const principal = get("PRINCIPAL");
  if (ghLogin && principal) {
    throw new Refusal(
      2,
      "R8: GH_LOGIN and PRINCIPAL are mutually exclusive — an operator binds via one provider identity, not two.",
    );
  }
  for (const k of ["PERSON_ID", "DISPLAY_ID", "HOST_ROLE", "KEY_TYPE", "FP", "PUBKEY"]) {
    if (!get(k)) missing.push(k);
  }
  if (!ghLogin && !principal) missing.push("GH_LOGIN (or PRINCIPAL for azure-devops)");
  if (missing.length) {
    throw new Refusal(
      2,
      `R4: refusing to write — required input(s) absent or empty: ${missing.join(", ")}. ` +
        `Nothing was written. (The prose ceremony wrote \`undefined\` here and relied on the schema to reject it.)`,
    );
  }
  const person = {
    display_id: get("DISPLAY_ID"),
    role: REGISTER_ROLE,
    host_role: get("HOST_ROLE"),
    keys: [{ type: get("KEY_TYPE"), fingerprint: get("FP"), pubkey: get("PUBKEY") }],
  };
  if (ghLogin) person.github_login = ghLogin;
  else person.principal = principal;
  return { personId: get("PERSON_ID"), person };
}

/**
 * Apply the registration to an in-memory roster.
 *
 * @returns {{roster: object, changed: boolean}} `changed:false` means the entry
 *   was already present and byte-identical — an idempotent no-op, not a write.
 * @throws {Refusal} R6 on a differing overwrite, R7 on an unsafe person_id.
 */
export function applyRegistration(roster, personId, person, personIdPattern) {
  if (personIdPattern && !personIdPattern.test(personId)) {
    throw new Refusal(
      5,
      `R7: refusing person_id ${JSON.stringify(personId)} — it does not satisfy the schema's ` +
        `persons.propertyNames pattern (${personIdPattern.source}). Refused BEFORE assignment: ` +
        `assigning first would let a prototype-shaped key mutate the prototype instead of adding ` +
        `an own property, which the validator cannot see.`,
    );
  }
  if (!roster || typeof roster !== "object" || Array.isArray(roster)) {
    throw new Refusal(1, "R2: roster is not an object — refusing to write.");
  }
  const persons = roster.persons;
  if (!persons || typeof persons !== "object" || Array.isArray(persons)) {
    throw new Refusal(1, "R2: roster.persons is not an object — refusing to write.");
  }
  if (Object.prototype.hasOwnProperty.call(persons, personId)) {
    const existing = JSON.stringify(persons[personId]);
    if (existing === JSON.stringify(person)) return { roster, changed: false };
    throw new Refusal(
      4,
      `R6: person_id ${personId} is already in the roster with DIFFERENT content. ` +
        `Refusing to overwrite. A person_id is immutable and derived from the pubkey, so a ` +
        `differing entry under the same id is an identity mutation, not a registration. ` +
        `Existing: ${existing}`,
    );
  }
  Object.defineProperty(persons, personId, {
    value: person,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return { roster, changed: true };
}

/**
 * Refuse on main/master; WARN-and-proceed when the branch cannot be determined.
 * Fail-OPEN on UNKNOWN is deliberate: server-side branch protection on
 * `operators.roster.json` is the load-bearing control, and a hard stop here
 * would break the documented fresh-repo genesis flow.
 */
export function branchRefusal(repoDir, runGit = defaultRunGit) {
  let branch;
  try {
    branch = runGit(repoDir);
  } catch {
    return { refuse: false, warn: "R5 UNKNOWN: could not determine the current branch (no git, or a detached HEAD). Proceeding; server-side branch protection remains the load-bearing control." };
  }
  if (branch === "main" || branch === "master") {
    return {
      refuse: true,
      message:
        `R5: refusing to write the roster on branch '${branch}'. /whoami --register NEVER writes ` +
        `directly to main — cut a codify/<display_id>-<date> branch off origin/main first.`,
    };
  }
  return { refuse: false, warn: null };
}

/**
 * `symbolic-ref --short HEAD`, NOT `rev-parse --abbrev-ref HEAD`. Measured: on a
 * repo with no commits yet, rev-parse exits non-zero ("ambiguous argument
 * 'HEAD'") and R5 silently degrades to UNKNOWN — which is precisely a fresh-repo
 * genesis bootstrap, the case where writing the roster on main matters most.
 * symbolic-ref reads the ref HEAD points at and answers correctly with zero
 * commits. It still throws on a detached HEAD, which stays UNKNOWN by design.
 */
function defaultRunGit(repoDir) {
  if (!gitSubprocessEnv) {
    throw new Error(
      "the shared git-subprocess envelope (.claude/hooks/lib/git-subprocess-env.js) is ABSENT, " +
        "so the branch could not be read with a constants-built environment; refusing an " +
        "ambient git, whose inherited GIT_DIR would let a decoy repository answer R5",
    );
  }
  const gitBin = gitSubprocessEnv.resolveGitBinary();
  if (!gitBin) {
    throw new Error(
      "no ABSOLUTE git binary resolved (candidate list + PATH search both empty); refusing a " +
        "PATH-resolved git, whose planted binary answers R5 with a fabricated branch",
    );
  }
  const out = execFileSync(gitBin, ["symbolic-ref", "--short", "HEAD"], {
    cwd: repoDir,
    env: gitSubprocessEnv.gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!out || out === "HEAD") throw new Error("detached HEAD");
  return out;
}

/** The R2 refusal for an ABSENT roster. ONE definition, because it is now reachable
 *  from two places — the `existsSync` guard below and the ENOENT arm of the read that
 *  follows it — and a prose message duplicated across two throw sites drifts. */
function noRosterRefusal(repoDir) {
  return new Refusal(
    1,
    `R2: no roster at ${ROSTER_REL} under ${repoDir}. /whoami --register assumes an EXISTING ` +
      `roster; a fresh repo's first roster is hand-authored (skills/45-genesis-bootstrap).`,
  );
}

/** The whole ceremony, injectable for tests. Writes at most once, last. */
export function runRegistration({ repoDir, env, runGit = defaultRunGit, validate, schema }) {
  const rosterPath = rosterPathFor(repoDir);
  if (!fs.existsSync(rosterPath)) {
    throw noRosterRefusal(repoDir);
  }
  const { personId, person } = collectInput(env);
  const br = branchRefusal(repoDir, runGit);
  if (br.refuse) throw new Refusal(3, br.message);

  let roster;
  // `rosterRaw` is the compare-and-swap PRE-IMAGE: the exact bytes this process
  // parsed. The write below proves they have not moved before replacing them.
  let rosterRaw;
  // Through `state-io.js::_readFileHardened` (exported as `readFileHardened`; `state-io.js:388-438`). The `existsSync`
  // guard above does NOT divert a planted FIFO — it returns TRUE for one — so the plain
  // `readFileSync` that lived here BLOCKED FOREVER in open(2), wedging the whole tool
  // BEFORE its CAS ever ran. A hang is not a refusal, and the try/catch that used to
  // wrap this could not reach one. `O_NOFOLLOW` would not have closed it either; the
  // `O_NONBLOCK` plus regular-file fstat that `readFileHardened` owns is what does.
  const preimage = readFileHardened(rosterPath);
  if (!preimage.ok) {
    // ENOENT keeps its ABSENT meaning and the guard's exact refusal — the read also
    // closes the window between that check and this one.
    if (preimage.code === "ENOENT") throw noRosterRefusal(repoDir);
    // Everything else — FIFO, symlink, directory, permissions — is UNREADABLE, never
    // ABSENT. Collapsing the two would treat an attacker's entry as "no roster yet",
    // which is `zero-tolerance.md` Rule 3's silent-fallback shape and would let this
    // tool clobber a roster it never managed to read.
    throw new Refusal(1, `R2: roster is not readable — refusing to write. ${preimage.reason}`);
  }
  // `.toString("utf8")` reproduces byte-for-byte what `readFileSync(p, "utf8")` returned.
  // That matters here specifically: `rosterRaw` is passed to the writer as `expectBytes`
  // and compared with `!==`, so a lossy decode would turn every CAS into a mismatch.
  rosterRaw = preimage.value.toString("utf8");
  try {
    roster = JSON.parse(rosterRaw);
  } catch (err) {
    throw new Refusal(1, `R2: roster is not parseable JSON — refusing to write. ${err.message}`);
  }
  const { changed } = applyRegistration(roster, personId, person, personIdPatternFrom(schema));
  const result = validate(roster);
  if (!result.valid) {
    throw new Refusal(
      1,
      `R2: schema validation failed — NOTHING was written.\n  ${(result.errors || []).join("\n  ")}`,
    );
  }
  if (changed) {
    // Written through the SHARED atomic roster writer, never a bare
    // `writeFileSync`: the target is never truncated (a crash leaves the whole
    // old roster or the whole new one), and the compare-and-swap refuses when a
    // concurrent enrollment moved the file between this read and this write --
    // which would otherwise discard that operator's key while reporting success.
    const written = writeRosterAtomic({
      rosterPath,
      roster,
      expectBytes: rosterRaw,
    });
    if (!written.ok) {
      throw new Refusal(
        1,
        `R2: roster validated but was NOT written -- ${written.reason}`,
      );
    }
  }
  return { changed, personId, warn: br.warn, rosterPath };
}

/* ------------------------------- selftest -------------------------------- */

/** Negative controls. Each names the result it would print were the refusal
 *  ABSENT, so a green here discriminates (`instrument-discipline.md` MUST-1). */
export function selftest() {
  const pat = /^(PLACEHOLDER-)?(?!_)[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const ok = (name, fn) => {
    try {
      fn();
      return { name, pass: true };
    } catch (err) {
      return { name, pass: false, err: err.message };
    }
  };
  const throwsWith = (code, fn) => {
    let caught = null;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    if (!caught) throw new Error(`expected a refusal (exit ${code}); none was thrown`);
    if (caught.code !== code) throw new Error(`expected exit ${code}, got ${caught.code}: ${caught.message}`);
  };
  const base = { PERSON_ID: "pid-a-1", DISPLAY_ID: "a", GH_LOGIN: "a", HOST_ROLE: "human", KEY_TYPE: "ssh", FP: "SHA256:x", PUBKEY: "ssh-ed25519 AAAA" };
  const results = [
    ok("R4 refuses absent DISPLAY_ID", () => throwsWith(2, () => collectInput({ ...base, DISPLAY_ID: "" }))),
    ok("R8 refuses GH_LOGIN + PRINCIPAL together", () => throwsWith(2, () => collectInput({ ...base, PRINCIPAL: "u@d" }))),
    ok("R1 role is not env-readable", () => {
      const { person } = collectInput({ ...base, ROLE: "owner", role: "owner" });
      if (person.role !== REGISTER_ROLE) throw new Error(`role became ${person.role}`);
    }),
    ok("R7 refuses __proto__ before assignment", () =>
      throwsWith(5, () => applyRegistration({ persons: {} }, "__proto__", { x: 1 }, pat))),
    ok("R6 refuses a differing overwrite", () =>
      throwsWith(4, () => applyRegistration({ persons: { "pid-a-1": { role: "owner" } } }, "pid-a-1", { role: "contributor" }, pat))),
    ok("R6 identical re-run is a no-op", () => {
      const p = { role: "contributor" };
      const r = applyRegistration({ persons: { "pid-a-1": { role: "contributor" } } }, "pid-a-1", p, pat);
      if (r.changed !== false) throw new Error("expected changed:false");
    }),
    ok("R5 refuses on main", () => {
      const r = branchRefusal("/nonexistent", () => "main");
      if (!r.refuse) throw new Error("expected a refusal on main");
    }),
    ok("R5 warns, does not refuse, on UNKNOWN branch", () => {
      const r = branchRefusal("/nonexistent", () => { throw new Error("no git"); });
      if (r.refuse || !r.warn) throw new Error("expected warn-and-proceed");
    }),
    ok("happy path adds an own enumerable property", () => {
      const roster = { persons: {} };
      applyRegistration(roster, "pid-a-1", { role: "contributor" }, pat);
      if (!Object.prototype.hasOwnProperty.call(roster.persons, "pid-a-1")) throw new Error("no own property");
    }),
  ];
  return results;
}

/* ---------------------------------- CLI ---------------------------------- */

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--selftest")) {
    const results = selftest();
    for (const r of results) {
      process.stdout.write(`${r.pass ? "ok  " : "FAIL"} ${r.name}${r.pass ? "" : ` — ${r.err}`}\n`);
    }
    const failed = results.filter((r) => !r.pass).length;
    process.stdout.write(`${results.length - failed}/${results.length} negative controls pass\n`);
    return failed === 0 ? 0 : 1;
  }
  const repoDir = process.env.COC_REPO_DIR || process.cwd();
  const validator = require(path.resolve(repoDir, ".claude/hooks/lib/roster-schema-validate.js"));
  const schemaPath = path.join(repoDir, ".claude", "operators.roster.schema.json");
  let schema = null;
  // Through `state-io.js::readFileHardened`, for the same reason as the roster read above:
  // `schemaPath` lives in the SAME directory as the roster, so the actor who can plant a
  // FIFO at one can plant it at the other. The `catch {}` this replaces expressed an
  // intent — degrade to the validator's own propertyNames check, never silently weaker
  // overall — but a blocking open(2) never throws, so a planted FIFO hung the tool BEFORE
  // R7 ever ran. The degrade is preserved for every genuinely unreadable schema.
  const schemaRead = readFileHardened(schemaPath);
  if (schemaRead.ok) {
    try {
      schema = JSON.parse(schemaRead.value.toString("utf8"));
    } catch {
      /* malformed JSON degrades exactly as an unreadable schema does, in the else arm. */
    }
  } else if (schemaRead.code !== "ENOENT") {
    // ABSENT and UNREADABLE are different facts. An absent schema is the documented
    // degrade and stays quiet; a planted FIFO / symlink / directory is an active
    // artefact and gets named, because `zero-tolerance.md` Rule 3 forbids swallowing it.
    process.stderr.write(
      `WARN: ${path.join(".claude", "operators.roster.schema.json")} is UNREADABLE ` +
        `(${schemaRead.reason}); R7 degrades to the validator's own propertyNames check.\n`,
    );
  }
  try {
    const r = runRegistration({ repoDir, env: process.env, validate: validator.validate, schema });
    if (r.warn) process.stderr.write(`${r.warn}\n`);
    process.stdout.write(
      r.changed
        ? `registered ${r.personId} as ${REGISTER_ROLE}; roster written. Commit + push + open the PR next.\n`
        : `${r.personId} already present with identical content — no write (idempotent re-run).\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return err instanceof Refusal ? err.code : 1;
  }
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; a lexical compare exits 0 silently).
if (isMainModule(import.meta.url)) process.exit(main(process.argv.slice(2)));
