#!/usr/bin/env node
/**
 * burndown-target-containment — fixtures for the TARGET write sink of
 * `.claude/bin/burndown-build.mjs`, against `security.md` § Path Containment.
 *
 * WHAT THESE PIN, and why the sibling suite did not already pin it.
 * `burndown-integrity/run.mjs` is 105 cases about WHAT IS COUNTED — the sources, the
 * precedence ladder, the digest, the refusal banner. Not one of them touches WHERE THE
 * BLOCK IS WRITTEN. The target was turned into an absolute path by `path.join` alone
 * and then written through, and `assertRepoRelative` — the one shape check on it — is
 * a STRING check: it rejects a leading `/`, a `..` SEGMENT, `:` and whitespace, every
 * one of them a property of the text. A symlink is a property of the FILESYSTEM, and
 * no string check can see one. Measured on the pre-fix binary, both poles exited 0
 * printing `burndown: wrote block into …` while splicing the block into a file in
 * /tmp. It splices rather than truncates, so the primitive is out-of-tree CONTENT
 * INJECTION, not destruction — and it reports success, which is worse.
 *
 * THE COMPLIANT POLE IS NOT DECORATION. A containment fix that refuses the legitimate
 * write is a worse defect than the one it closes, and it is the easy failure to ship:
 * `os.tmpdir()` on macOS sits under a symlinked `/private` prefix, so comparing a
 * realpath'd candidate against a RAW root refuses every ordinary build. MEASURED under
 * exactly that mutation: 50 of the sibling suite's compliant cases went red. That is
 * why `compliant/write-through-a-symlinked-repo-root-succeeds` builds its repo behind
 * an EXPLICIT symlink rather than relying on the platform's tmpdir — the macOS
 * accident does not reach Linux CI, and a pole that only discriminates on one
 * platform is not a pole.
 *
 * WHICH BRANCH EACH POLE ACTUALLY EXERCISES, established by mutation rather than by
 * reading the source. Disabling the `lstat` symlink refusal and re-running the
 * OUTSIDE-pointing leaf pole still refused — the containment comparison catches it on
 * its own. So that pole does NOT discriminate the `lstat` branch, and a suite built
 * only from it would have scored a deleted `lstat` branch as covered.
 * `leaf-symlink-INSIDE-repo` is the pole that isolates it: under the same mutation it
 * exits 0 and the block lands in a file the manifest never names, while the shipped
 * code refuses. Both poles are kept, each for the branch it actually reaches.
 *
 * EXIT CODES ARE ASSERTED EXACTLY. This file's ladder reserves 1 for STALE and 2 for
 * UNRUNNABLE, and the NUL cases below exist precisely because two crashes were
 * MEASURED landing on 1 — a refusal misreported as staleness, one of them with the
 * operator's absolute path in the stack trace. A case that accepted "non-zero" could
 * not tell the bug from the fix.
 *
 * VICTIMS ARE BUILT IN A UNIQUE /tmp PATH KEYED ON THE PID AND REMOVED. Nothing here
 * points at a real file, and the assertions read the victim's DIGEST before and after
 * — "the tool refused" and "the out-of-tree file is untouched" are two different
 * claims, and only the second is the one that matters.
 */
import "../_lib/no-ambient-git.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TOOL = process.env.BURNDOWN_TOOL || path.join(REPO_ROOT, ".claude", "bin", "burndown-build.mjs");

// Every temporary artefact this run creates, removed in a `finally` so a thrown case
// does not leave a victim behind.
const SCRATCH = [];
function scratchDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bd-contain-${process.pid}-${tag}-`));
  SCRATCH.push(d);
  return d;
}

let pass = 0;
const failures = [];

// `PASS <name>` at column 0 is the shape run-audit-fixtures.mjs::CASE_PASS counts.
function check(name, fn) {
  let ok;
  try {
    ok = fn();
  } catch (e) {
    ok = `threw: ${e && e.message}`;
  }
  if (ok === true) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${typeof ok === "string" ? ` — ${ok}` : ""}`);
  }
}

// ── fixture construction ────────────────────────────────────────────────────
const REGISTER = {
  _note: "fixture",
  _generated: "2026-08-01",
  _authority: "owner",
  _id_convention: "REG-NN-SLUG",
  items: [
    { id: "REG-01-A", page: "Alpha", status: "Signed off" },
    { id: "REG-02-A", page: "Alpha", status: "In progress" },
  ],
};
const j = (o) => JSON.stringify(o, null, 2) + "\n";
const manifestFor = (target) => ({
  _schema: "burndown-manifest/v1",
  target,
  pages: ["Alpha"],
  sources: [{ path: "burndown/register.json", kind: "register", precedence: 0 }],
});

function digest(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * Build a real committed git repo INSIDE `dir`. `decorate` runs before the commit and
 * is where a case plants its symlink, so the link is COMMITTED as mode 120000 exactly
 * as a hostile checkout would carry it.
 */
function mkRepo(dir, { target = "REGISTER.md", manifest = null, files = {}, decorate = null } = {}) {
  fs.mkdirSync(path.join(dir, "burndown"), { recursive: true });
  fs.writeFileSync(path.join(dir, "burndown", "register.json"), j(REGISTER));
  fs.writeFileSync(path.join(dir, "burndown-manifest.json"), j(manifest || manifestFor(target)));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (decorate) decorate(dir);
  for (const a of [
    ["init", "-q"],
    ["config", "user.email", "fx@example.invalid"],
    ["config", "user.name", "fx"],
    // Never inherit the operator's signing config: under concurrent runners gpg-agent
    // contention makes `git commit` fail with exit 128 at random. The ~20 sibling
    // runners all pin this; it is the established pattern, not a new one.
    ["config", "commit.gpgsign", "false"],
    ["add", "-A"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

function run(dir, args = ["--write"], repoArg = dir) {
  const r = spawnSync("node", [TOOL, "--repo", repoArg, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

const REFUSED = (r) => r.code === 2 && /^UNRUNNABLE — refusing because/m.test(r.err);
// C0 minus the whitespace `\s` already covers, plus DEL. A raw byte from this class
// on stderr is the rendering hazard `safeCell` exists to stop.
const RAW_CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}` +
    `${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const DEL = String.fromCharCode(127);

// ══ VIOLATION POLE — every one of these MUST refuse ═════════════════════════

check("violation/leaf-symlink-out-of-repo-is-refused", () => {
  const box = scratchDir("leafout");
  const victim = path.join(box, "victim.txt");
  fs.writeFileSync(victim, "ORIGINAL OUT-OF-TREE CONTENT\n");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { decorate: (d) => fs.symlinkSync(victim, path.join(d, "REGISTER.md")) });
  const r = run(repo);
  return REFUSED(r) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("violation/leaf-symlink-out-of-repo-leaves-the-victim-BYTE-IDENTICAL", () => {
  // The refusal and the victim's integrity are DIFFERENT claims. A tool can refuse
  // after having already written. Only the digest settles it.
  const box = scratchDir("leafoutd");
  const victim = path.join(box, "victim.txt");
  fs.writeFileSync(victim, "ORIGINAL OUT-OF-TREE CONTENT\n");
  const before = digest(victim);
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { decorate: (d) => fs.symlinkSync(victim, path.join(d, "REGISTER.md")) });
  run(repo);
  return digest(victim) === before ? true : "the out-of-tree victim was MODIFIED despite the refusal";
});

check("violation/leaf-symlink-out-of-repo-emits-NO-success-line", () => {
  // A refused build that still prints `wrote block into …` is the exact confusion the
  // UNRUNNABLE banner exists to prevent.
  const box = scratchDir("leafoutq");
  const victim = path.join(box, "victim.txt");
  fs.writeFileSync(victim, "x\n");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { decorate: (d) => fs.symlinkSync(victim, path.join(d, "REGISTER.md")) });
  const r = run(repo);
  return !/wrote block into/.test(r.out) ? true : `stdout claimed success: ${r.out.slice(0, 120)}`;
});

check("violation/directory-COMPONENT-symlink-out-of-repo-is-refused", () => {
  // The leaf is a perfectly ordinary name; the ESCAPE is one component up. A fix that
  // only lstat'd the leaf would pass this.
  const box = scratchDir("dirout");
  const outside = path.join(box, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "REGISTER.md"), "ORIGINAL OUT-OF-TREE CONTENT\n");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { target: "docs/REGISTER.md", decorate: (d) => fs.symlinkSync(outside, path.join(d, "docs")) });
  const r = run(repo);
  return REFUSED(r) && /OUTSIDE the repository/.test(r.err) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("violation/directory-COMPONENT-symlink-leaves-the-victim-BYTE-IDENTICAL", () => {
  const box = scratchDir("dird");
  const outside = path.join(box, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const victim = path.join(outside, "REGISTER.md");
  fs.writeFileSync(victim, "ORIGINAL OUT-OF-TREE CONTENT\n");
  const before = digest(victim);
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { target: "docs/REGISTER.md", decorate: (d) => fs.symlinkSync(outside, path.join(d, "docs")) });
  run(repo);
  return digest(victim) === before ? true : "the out-of-tree victim was MODIFIED despite the refusal";
});

check("violation/directory-COMPONENT-symlink-is-caught-on-a-NONEXISTENT-leaf", () => {
  // First `--write` into a fresh tree: the leaf does not exist, so `realpathSync` on it
  // throws ENOENT and the PARENT is resolved instead. If that fallback resolved nothing,
  // the escape would be uncatchable at exactly the moment it is planted.
  const box = scratchDir("dirnew");
  const outside = path.join(box, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { target: "docs/REGISTER.md", decorate: (d) => fs.symlinkSync(outside, path.join(d, "docs")) });
  const r = run(repo);
  const leaked = fs.existsSync(path.join(outside, "REGISTER.md"));
  return REFUSED(r) && !leaked ? true : `exit ${r.code}, out-of-tree file created=${leaked}`;
});

check("violation/leaf-symlink-pointing-INSIDE-the-repo-is-refused", () => {
  // Containment ALONE passes this — the destination is in-tree. Established by
  // mutation: with the `lstat` refusal disabled this exits 0 and the block lands in
  // ELSEWHERE.md, a file the manifest never names, which `--check` would then read
  // back from somewhere it never declared. This is the pole that isolates that branch.
  const box = scratchDir("leafin");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, {
    files: { "ELSEWHERE.md": "# elsewhere, in-repo\n" },
    decorate: (d) => fs.symlinkSync("ELSEWHERE.md", path.join(d, "REGISTER.md")),
  });
  const r = run(repo);
  return REFUSED(r) && /is a SYMLINK/.test(r.err) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("violation/leaf-symlink-INSIDE-the-repo-leaves-the-DESTINATION-unwritten", () => {
  const box = scratchDir("leafind");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, {
    files: { "ELSEWHERE.md": "# elsewhere, in-repo\n" },
    decorate: (d) => fs.symlinkSync("ELSEWHERE.md", path.join(d, "REGISTER.md")),
  });
  run(repo);
  const dest = fs.readFileSync(path.join(repo, "ELSEWHERE.md"), "utf8");
  return dest === "# elsewhere, in-repo\n" ? true : "the link's DESTINATION was written through";
});

check("violation/SIBLING-directory-whose-name-EXTENDS-the-root-is-refused", () => {
  // `/…/repo-evil` against a root of `/…/repo`: a bare `startsWith(root)` accepts it,
  // and it is outside the repository. This is the pole for the `root + path.sep` guard.
  const box = scratchDir("sibling");
  const repo = path.join(box, "repo");
  const evil = path.join(box, "repo-evil");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(evil, { recursive: true });
  const victim = path.join(evil, "REGISTER.md");
  fs.writeFileSync(victim, "ORIGINAL SIBLING-DIR CONTENT\n");
  const before = digest(victim);
  mkRepo(repo, { target: "docs/REGISTER.md", decorate: (d) => fs.symlinkSync(evil, path.join(d, "docs")) });
  const r = run(repo);
  return REFUSED(r) && digest(victim) === before
    ? true
    : `exit ${r.code}, victim changed=${digest(victim) !== before}`;
});

check("violation/DANGLING-symlink-target-fails-CLOSED", () => {
  // Resolution cannot succeed, so containment cannot be shown. The contract is to
  // refuse, never to fall back to the lexical path.
  const box = scratchDir("dangle");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, {
    decorate: (d) => fs.symlinkSync(path.join(box, "does-not-exist-", String(process.pid)), path.join(d, "REGISTER.md")),
  });
  const r = run(repo);
  return REFUSED(r) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("violation/CHECK-mode-refuses-a-symlinked-target-too", () => {
  // `--check` READS through the target. That is out-of-tree content DISCLOSURE rather
  // than injection, and it is the same containment failure; the resolve is shared so
  // both modes are covered by construction — this pins that it stays so.
  const box = scratchDir("checkmode");
  const victim = path.join(box, "victim.txt");
  fs.writeFileSync(victim, "SECRET OUT-OF-TREE CONTENT\n");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { decorate: (d) => fs.symlinkSync(victim, path.join(d, "REGISTER.md")) });
  const r = run(repo, ["--check"]);
  return REFUSED(r) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("violation/refusal-names-the-target-RELATIVE-never-the-absolute-tree", () => {
  // Every sibling refusal in the generator names a repo-relative path; an absolute one
  // prints the operator's real tree into transcripts, PR comments and CI logs.
  const box = scratchDir("nodisc");
  const victim = path.join(box, "victim.txt");
  fs.writeFileSync(victim, "x\n");
  const repo = fs.mkdtempSync(path.join(box, "repo-"));
  mkRepo(repo, { decorate: (d) => fs.symlinkSync(victim, path.join(d, "REGISTER.md")) });
  const r = run(repo);
  // `REFUSED(r) &&` is load-bearing, not belt-and-braces. Without it this case PASSED
  // against the pre-fix binary — which never refused at all, so it printed no path and
  // satisfied "leaked no absolute path" VACUOUSLY. A pole that is true because the
  // event never happened cannot discriminate the fix. Verified: with this conjunct it
  // reds pre-fix; without it, it greens.
  return REFUSED(r) && !r.err.includes(repo) && !r.err.includes(box)
    ? true
    : `exit ${r.code}; refusal leaked an absolute path or did not fire: ${r.err.slice(0, 200)}`;
});

// ── NUL / control bytes: exit 2, never the STALE code ───────────────────────

check("violation/NUL-in-TARGET-refuses-with-exit-2-not-the-STALE-code-1", () => {
  // MEASURED pre-fix: this reached `node:fs::getValidatedPath`, threw a
  // non-`Unrunnable` error, stack-traced and exited 1 — the code reserved for STALE.
  const repo = scratchDir("nultgt");
  mkRepo(repo, { target: `REGISTER.md${NUL}evil` });
  const r = run(repo);
  return REFUSED(r) ? true : `exit ${r.code} (1 = STALE, the misreport); err=${r.err.slice(0, 160)}`;
});

check("violation/NUL-in-TARGET-emits-no-stack-trace", () => {
  const repo = scratchDir("nultgts");
  mkRepo(repo, { target: `REGISTER.md${NUL}evil` });
  const r = run(repo);
  return !/\n\s+at /.test(r.err) ? true : `stack trace present: ${r.err.slice(0, 200)}`;
});

check("violation/NUL-in-TARGET-leaks-no-absolute-path", () => {
  // The pre-fix `node:fs` trace carried the operator's absolute path — the one thing
  // this generator is otherwise careful never to print.
  const repo = scratchDir("nultgtl");
  mkRepo(repo, { target: `REGISTER.md${NUL}evil` });
  const r = run(repo);
  return !r.err.includes(repo) ? true : `absolute path leaked: ${r.err.slice(0, 200)}`;
});

check("violation/NUL-in-a-SOURCE-path-refuses-with-exit-2-not-1", () => {
  // MEASURED pre-fix: `execFileSync` rejected the argv entry
  // (`ERR_INVALID_ARG_VALUE … must be a string without null bytes`), which threw out
  // of `git()` uncaught and exited 1.
  const repo = scratchDir("nulsrc");
  const m = manifestFor("REGISTER.md");
  m.sources = [{ path: `burndown/register.json${NUL}evil`, kind: "register", precedence: 0 }];
  mkRepo(repo, { manifest: m });
  const r = run(repo);
  return REFUSED(r) ? true : `exit ${r.code}; err=${r.err.slice(0, 160)}`;
});

check("violation/NUL-in-a-SOURCE-path-emits-no-stack-trace", () => {
  const repo = scratchDir("nulsrcs");
  const m = manifestFor("REGISTER.md");
  m.sources = [{ path: `burndown/register.json${NUL}evil`, kind: "register", precedence: 0 }];
  mkRepo(repo, { manifest: m });
  const r = run(repo);
  return !/\n\s+at /.test(r.err) ? true : `stack trace present: ${r.err.slice(0, 200)}`;
});

check("violation/a-C0-control-byte-in-TARGET-is-refused", () => {
  // MEASURED pre-fix: exit 0. Silently accepted and written to a control-byte filename.
  const repo = scratchDir("soh");
  mkRepo(repo, { target: `REGISTER.md${SOH}` });
  const r = run(repo);
  return REFUSED(r) ? true : `exit ${r.code}`;
});

check("violation/a-DEL-byte-in-TARGET-is-refused", () => {
  const repo = scratchDir("del");
  mkRepo(repo, { target: `REGISTER.md${DEL}` });
  const r = run(repo);
  return REFUSED(r) ? true : `exit ${r.code}`;
});

check("violation/the-refusal-message-carries-NO-raw-control-byte", () => {
  // The value was scrubbed through `safeCell` while the LABEL beside it was
  // interpolated raw, and one caller builds its label AS `source '<entry.path>'` — so
  // the byte reached stderr anyway. Both halves are scrubbed now; this pins it.
  //
  // HOW THIS ONE DISCRIMINATES, stated because the usual instrument does not. It
  // PASSES against the pre-fix binary, so the before/after comparison proves nothing
  // here — pre-fix the C0 range never reached this refusal at all (it crashed in
  // `node:fs` / `execFileSync` first), so there was no message to contain a raw byte.
  // Its discriminating instrument is a MUTATION instead: reverting the label to a bare
  // `${label}` interpolation reds this case while every other case in the suite stays
  // green. Measured, not assumed.
  const repo = scratchDir("scrub");
  const m = manifestFor("REGISTER.md");
  m.sources = [{ path: `burndown/register.json${NUL}evil`, kind: "register", precedence: 0 }];
  mkRepo(repo, { manifest: m });
  const r = run(repo);
  return !RAW_CONTROL.test(r.err) ? true : "a raw control byte reached stderr";
});

// ══ COMPLIANT POLE — every one of these MUST succeed ════════════════════════
//
// A containment fix that blocks the legitimate write is a worse defect than the one it
// closes. These are the cases that catch that, and they are not ceremony: the
// raw-root mutation reds them while every violation pole above stays green.

check("compliant/an-ordinary-in-repo-write-still-succeeds", () => {
  const repo = scratchDir("ok1");
  mkRepo(repo);
  const r = run(repo);
  return r.code === 0 && /wrote block into REGISTER\.md/.test(r.out) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("compliant/the-SUCCESS-line-names-the-declared-path-not-the-absolute-tree", () => {
  // A REGRESSION THIS SUITE CAUGHT, kept as a pole. Once `targetAbs` became the
  // CANONICAL path, the success message's `path.relative(repo, targetAbs)` was
  // comparing a RAW root against a resolved candidate — the same one-sided-resolver
  // mistake as the bug being fixed, relocated into the output. Observed: an ordinary
  // write printed `wrote block into ../../../../../../private/var/folders/…`, putting
  // the operator's absolute tree on stdout. The refusals in this generator are all
  // worded to avoid exactly that; the success path must match them.
  const repo = scratchDir("okdisc");
  mkRepo(repo);
  const r = run(repo);
  return r.code === 0 && /wrote block into REGISTER\.md/.test(r.out) && !/\.\.\//.test(r.out) && !r.out.includes(repo)
    ? true
    : `stdout=${r.out.slice(0, 200)}`;
});

check("compliant/the-block-actually-lands-in-the-declared-target", () => {
  const repo = scratchDir("ok2");
  mkRepo(repo);
  run(repo);
  const body = fs.readFileSync(path.join(repo, "REGISTER.md"), "utf8");
  return /ALL PAGES/.test(body) ? true : "the declared target carries no generated block";
});

check("compliant/write-through-a-symlinked-repo-ROOT-succeeds", () => {
  // THE two-sided-resolve pole, and the reason it plants an EXPLICIT symlink rather
  // than leaning on the platform: macOS `os.tmpdir()` already sits behind `/private`,
  // Linux CI's does not, and a pole that only discriminates on one platform is not a
  // pole. Comparing a realpath'd candidate against a RAW root reds this everywhere.
  const box = scratchDir("symroot");
  const real = path.join(box, "real");
  fs.mkdirSync(real, { recursive: true });
  mkRepo(real);
  const link = path.join(box, "link");
  fs.symlinkSync(real, link);
  const r = run(real, ["--write"], link); // --repo points at the SYMLINK
  return r.code === 0 && /wrote block into/.test(r.out) ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("compliant/a-target-in-a-real-SUBDIRECTORY-succeeds", () => {
  const repo = scratchDir("ok3");
  mkRepo(repo, { target: "docs/REGISTER.md", files: { "docs/REGISTER.md": "# R\n" } });
  const r = run(repo);
  return r.code === 0 && /ALL PAGES/.test(fs.readFileSync(path.join(repo, "docs", "REGISTER.md"), "utf8"))
    ? true
    : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("compliant/the-FIRST-write-to-a-not-yet-existing-target-succeeds", () => {
  // The ENOENT fallback must resolve the PARENT and carry on, not fail closed on the
  // ordinary case. Without it every fresh repo's first `--write` would refuse.
  const repo = scratchDir("ok4");
  mkRepo(repo, { target: "NEW-REGISTER.md" });
  const r = run(repo);
  return r.code === 0 && fs.existsSync(path.join(repo, "NEW-REGISTER.md"))
    ? true
    : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("compliant/CHECK-reports-current-immediately-after-a-write", () => {
  // End to end through the shared resolve: if the two modes ever resolved to different
  // files, the block would be written to one and read back from the other.
  const repo = scratchDir("ok5");
  mkRepo(repo);
  const w = run(repo);
  const c = run(repo, ["--check"]);
  return w.code === 0 && c.code === 0 && /is current/.test(c.out)
    ? true
    : `write=${w.code} check=${c.code}; ${c.err.slice(0, 160)}`;
});

check("compliant/a-non-ASCII-target-filename-is-NOT-over-blocked", () => {
  // The control-byte class must not become a general non-ASCII ban. `naïve` carries
  // multi-byte codepoints and no control bytes, and is a legitimate path.
  const repo = scratchDir("ok6");
  mkRepo(repo, { target: "naïve-REGISTER.md" });
  const r = run(repo);
  return r.code === 0 ? true : `exit ${r.code}; err=${r.err.slice(0, 200)}`;
});

check("compliant/a-manifest-in-a-SUBDIRECTORY-resolves-its-target-beside-itself", () => {
  // The target is relative to the MANIFEST's directory, not the repo root. The resolve
  // must preserve that or it would silently relocate every non-root manifest's block.
  const repo = scratchDir("ok7");
  // The ROOT target is created deliberately: the negative half of this case is "the
  // root copy was NOT written", and an ABSENT file satisfies that trivially, which
  // would make the assertion pass for the wrong reason.
  mkRepo(repo, { files: { "REGISTER.md": "# root\n" } });
  // Sources are manifest-dir-relative too, so the sub-manifest needs its OWN source.
  fs.mkdirSync(path.join(repo, "sub", "burndown"), { recursive: true });
  fs.writeFileSync(path.join(repo, "sub", "burndown", "register.json"), j(REGISTER));
  const m = manifestFor("REGISTER.md");
  fs.writeFileSync(path.join(repo, "sub", "burndown-manifest.json"), j(m));
  fs.writeFileSync(path.join(repo, "sub", "REGISTER.md"), "# sub\n");
  execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "sub"], { cwd: repo, stdio: "ignore" });
  const r = run(repo, ["--manifest", "sub/burndown-manifest.json", "--write"]);
  if (r.code !== 0) return `exit ${r.code}; err=${r.err.slice(0, 200)}`;
  const wroteSub = /ALL PAGES/.test(fs.readFileSync(path.join(repo, "sub", "REGISTER.md"), "utf8"));
  const wroteRoot = /ALL PAGES/.test(fs.readFileSync(path.join(repo, "REGISTER.md"), "utf8"));
  return wroteSub && !wroteRoot ? true : `sub=${wroteSub} root=${wroteRoot}`;
});

check("compliant/every-refusal-above-used-exit-2-and-none-used-exit-1", () => {
  // The ladder itself, asserted once over the whole containment family. Exit 1 means
  // STALE; a containment refusal landing there is a refusal misreported as a stale
  // block, which is how both NUL crashes presented before the fix.
  const box = scratchDir("ladder");
  const victim = path.join(box, "victim.txt");
  fs.writeFileSync(victim, "x\n");
  const codes = [];
  {
    const repo = fs.mkdtempSync(path.join(box, "a-"));
    mkRepo(repo, { decorate: (d) => fs.symlinkSync(victim, path.join(d, "REGISTER.md")) });
    codes.push(run(repo).code);
  }
  {
    const repo = fs.mkdtempSync(path.join(box, "b-"));
    mkRepo(repo, { target: `REGISTER.md${NUL}x` });
    codes.push(run(repo).code);
  }
  {
    const repo = fs.mkdtempSync(path.join(box, "c-"));
    mkRepo(repo, { target: `REGISTER.md${SOH}` });
    codes.push(run(repo).code);
  }
  return codes.every((c) => c === 2) ? true : `exit codes were ${codes.join(",")}, expected all 2`;
});

// ── summary ─────────────────────────────────────────────────────────────────
try {
  console.log(`\nburndown-target-containment: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`FAILED: ${failures.join(", ")}`);
  }
} finally {
  for (const d of SCRATCH) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort — a leftover in os.tmpdir() is not worth failing the run over */
    }
  }
}
process.exit(failures.length ? 1 : 0);
