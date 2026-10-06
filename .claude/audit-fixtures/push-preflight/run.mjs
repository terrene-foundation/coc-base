#!/usr/bin/env node
/**
 * Bipolar fixtures for the push pre-flight guard
 * (`.claude/hooks/lib/push-preflight.js`, rendered by
 * `.claude/hooks/push-preflight-guard.js`).
 *
 * Every case injects its inputs as plain objects — no repo, no network, no git,
 * no clock — so each pole is exercised deterministically and this runner works
 * from a bare checkout.
 *
 * WHY BOTH POLES ON EVERY PREDICATE (`instrument-bipolarity.md` MUST-2,
 * BUILDER-COMMON § FIXTURES). This detector is capped at an advisory, so an
 * INERT one is indistinguishable from a clean session — a set that only ever
 * asserts silence would pass identically against a detector that never fires,
 * and a set that only ever asserts firing would pass against one that fires on
 * everything. So each of the three scope-restriction predicates carries a
 * flag pole AND a clean pole, and every failure prints the FAILURE IDENTITY the
 * predicate returned, never a bare non-zero exit.
 *
 * The load-bearing pairs:
 *   - `flag-parity-ran-only-before-the-last-push` vs
 *     `clean-repush-with-a-scoped-parity-run` — the same session, the same
 *     parity command, separated ONLY by whether it ran inside the window since
 *     the last push. A whole-session scan scores the flag pole clean.
 *   - `flag-parity-only-quoted-inside-a-heredoc` — the parity command is IN the
 *     transcript and was never RUN. A substring match scores it clean.
 *   - `clean-pending-push-already-written-to-the-transcript` — the pending push
 *     is already the last record. Left in, it closes the window on itself and
 *     the advisory is silent forever.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const L = require_(path.join(HERE, "..", "..", "hooks", "lib", "push-preflight.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL ${name} — ${detail}`);
  }
}

// ── The fixture sweep: every flag-/clean- pole in this directory ─────────────
const files = fs
  .readdirSync(HERE)
  .filter((f) => /^(flag|clean)-.*\.txt$/.test(f))
  .sort();

if (files.length === 0) {
  console.log("FAIL fixture-discovery — no flag-/clean- fixtures found");
  process.exit(1);
}

let sawFlag = 0;
let sawClean = 0;

for (const f of files) {
  let fx;
  try {
    fx = JSON.parse(fs.readFileSync(path.join(HERE, f), "utf8"));
  } catch (e) {
    check(f, false, `fixture is not readable JSON (${e.message})`);
    continue;
  }
  const expected = fx.expect || {};
  const sigs = L.deriveParitySignatures(fx.input.workflows);
  const got = L.assessPushPreflight({
    command: fx.input.command,
    remoteBranchExists: fx.input.remoteBranchExists,
    transcriptText: fx.input.transcriptText,
    paritySignatures: sigs,
  });
  const expectFlag = f.startsWith("flag-");
  if (expectFlag) sawFlag++;
  else sawClean++;

  check(
    `${f}::verdict`,
    got.verdict === expected.verdict,
    `expected verdict "${expected.verdict}", got "${got.verdict}" ` +
      `(predicate returned why="${got.detail && got.detail.why}")`,
  );
  check(
    `${f}::why`,
    got.detail && got.detail.why === expected.why,
    `expected failure identity why="${expected.why}", got why="${got.detail && got.detail.why}" ` +
      `[verdict=${got.verdict}]`,
  );
  check(
    `${f}::filename-matches-verdict`,
    (got.verdict === "flag") === expectFlag,
    `the filename declares ${expectFlag ? "flag" : "clean"} but the predicate returned ` +
      `"${got.verdict}" (why=${got.detail && got.detail.why})`,
  );
}

// Anti-vacuity: the set must contain BOTH poles, or it proves nothing about a
// detector that is inert or that fires on everything.
check(
  "bipolarity::set-contains-both-poles",
  sawFlag >= 3 && sawClean >= 3,
  `flag poles=${sawFlag}, clean poles=${sawClean} — a single-pole set passes ` +
    "identically against an inert detector",
);

// ── Unit poles on the DERIVATION, which no end-to-end case can isolate ──────
const WF = [
  "jobs:\n  g:\n    steps:\n      - run: |\n          echo hi\n          node .claude/bin/validate-xref-integrity.mjs\n          git push origin main\n      - run: pre-commit run --all-files\n",
];
const sigs = L.deriveParitySignatures(WF);
check(
  "derivation::names-the-two-word-gate-signature",
  sigs.has("node .claude/bin/validate-xref-integrity.mjs"),
  `derived set did not carry the gate signature: ${[...sigs].join(", ")}`,
);
check(
  "derivation::admits-a-non-dispatching-program-bare",
  sigs.has("pre-commit"),
  `derived set did not carry "pre-commit": ${[...sigs].join(", ")}`,
);
check(
  "derivation::refuses-a-bare-dispatching-interpreter",
  !sigs.has("node"),
  'a bare "node" signature makes every node call read as a parity run and the ' +
    "detector INERT; derived set: " + [...sigs].join(", "),
);
check(
  "derivation::refuses-shell-noise-and-git",
  !sigs.has("git") && !sigs.has("echo") && !sigs.has("git push"),
  `a git/echo signature would make a push read as its own parity run; derived set: ${[...sigs].join(", ")}`,
);
check(
  "derivation::no-authority-yields-an-EMPTY-set-not-a-guess",
  L.deriveParitySignatures([]).size === 0 &&
    L.deriveParitySignatures(null).size === 0,
  "an absent authority must derive nothing rather than a hand-rolled default",
);

// ── Unit poles on the DERIVER/RECOGNIZER SYMMETRY (claims 2 + 3) ────────────
// The deriver must EMIT what the recognizer LOOKS UP. Both halves below were
// asymmetric: the recognizer already read `<prog> <words[1]>` verbatim (flag or
// not) and compared operands RAW, while the deriver refused flag operands and
// emitted operands RAW. Each pole names the spelling it locks.
const WF_SYM = [
  "jobs:\n  g:\n    steps:\n" +
    "      - name: suites\n        run: >\n          node --test\n" +
    "          .claude/test-harness/tests/a.test.mjs\n" +
    "          .claude/test-harness/tests/b.test.mjs\n" +
    "      - run: node .claude/bin/check-descoping.mjs\n" +
    "      - name: probe\n        run: node -e 'console.log(1)'\n" +
    "      - run: python -m pip install --quiet pyyaml\n" +
    "      - run: |\n          node .claude/bin/validate-emit.mjs\n          node .claude/bin/emit.mjs\n",
];
const symSigs = L.deriveParitySignatures(WF_SYM);

check(
  "derivation::admits-a-mode-selecting-flag-on-a-dispatching-program",
  symSigs.has("node --test"),
  "`node --test` is the test RUNNER — the flag is part of the program's identity, " +
    "and the recognizer already looks this spelling up; derived: " + [...symSigs].join(", "),
);
check(
  "derivation::refuses-a-code-dispatching-flag",
  !symSigs.has("node -e") && !symSigs.has("python -m"),
  "a code-eval/module-select flag says nothing about WHAT ran; minting it as a gate " +
    "signature scores every ad-hoc probe as a parity run (FALSE SILENCE); derived: " +
    [...symSigs].join(", "),
);
check(
  "derivation::folds-a-FOLDED-scalar-into-one-command",
  !symSigs.has(".claude/test-harness/tests/a.test.mjs") &&
    !symSigs.has("a.test.mjs"),
  "YAML `>` JOINS its lines into one command; read line-by-line, each suite path " +
    "becomes a bogus bare-filename PROGRAM signature; derived: " + [...symSigs].join(", "),
);
check(
  "derivation::keeps-a-LITERAL-scalar's-lines-separate",
  symSigs.has("node .claude/bin/validate-emit.mjs") &&
    symSigs.has("node .claude/bin/emit.mjs"),
  "YAML `|` keeps each line its OWN command; folding it would lose every gate " +
    "after the first; derived: " + [...symSigs].join(", "),
);
check(
  "recognizer::matches-an-operand-spelled-with-a-leading-dot-slash",
  L.isParityInvocation("node ./.claude/bin/check-descoping.mjs", symSigs) === true,
  "`./x` and `x` are the same gate; a RAW operand comparison makes them two",
);
check(
  "recognizer::matches-an-operand-spelled-as-an-absolute-path",
  L.isParityInvocation("node /repo/.claude/bin/check-descoping.mjs", symSigs) === true,
  "this repo's agents are instructed to use absolute paths, so the absolute " +
    "spelling is the COMMON local form of the very command CI runs",
);
check(
  "recognizer::matches-an-operand-whose-DIRECTORY-half-is-a-variable",
  L.isParityInvocation("node $REPO/.claude/bin/check-descoping.mjs", symSigs) === true,
  "the expansion sits in the directory half; the file name is literal",
);
check(
  "recognizer::still-MISSES-an-unrelated-gate-of-the-same-shape",
  L.isParityInvocation("node .claude/bin/some-other-tool.mjs", symSigs) === false,
  "ANTI-VACUITY: operand normalization must not degrade into matching any `node <path>`",
);
check(
  "recognizer::still-MISSES-a-code-eval-probe",
  L.isParityInvocation("node -e 'console.log(1)'", symSigs) === false &&
    L.isParityInvocation("python -m pip install foo", symSigs) === false,
  "the flag-operand admission must not reach the code-dispatching flags",
);

// ── Unit poles on the parity RECOGNIZER's segment anchoring ─────────────────
check(
  "recognizer::fires-on-a-real-invocation",
  L.isParityInvocation("node .claude/bin/validate-xref-integrity.mjs", sigs) === true,
  "the recognizer did not fire on a command the derived set names",
);
check(
  "recognizer::fires-after-a-cd-and-a-wrapper",
  L.isParityInvocation("cd /repo && pre-commit run --files a.py", sigs) === true,
  "a parity run reached through `cd &&` must still count as having run",
);
check(
  "recognizer::stays-silent-on-a-heredoc-body",
  L.isParityInvocation(
    "cat > /tmp/r.sh <<'EOF'\npre-commit run --all-files\nEOF",
    sigs,
  ) === false,
  "text WRITTEN into a heredoc was scored as a command RUN",
);
check(
  "recognizer::stays-silent-on-a-shell-comment",
  L.isParityInvocation("ls -la  # pre-commit run --all-files", sigs) === false,
  "a commented-out parity command was scored as having run",
);
check(
  "recognizer::stays-silent-on-an-empty-signature-set",
  L.isParityInvocation("pre-commit run", new Set()) === false,
  "an empty authority must not resolve any command as parity",
);

// ── Unit poles on the push classifier's scope restrictions ──────────────────
const cls = (c) => L.classifyPush(c);
check("classifier::plain-push-is-in-scope", cls("git push origin feat/x").inScope === true, "missed a plain push");
check(
  "classifier::bare-push-defaults-to-origin-and-current-branch",
  cls("git push").inScope === true && cls("git push").branch === null,
  `bare push: ${JSON.stringify(cls("git push"))}`,
);
check(
  "classifier::reads-the-DST-half-of-a-refspec",
  cls("git push origin HEAD:feat/x").branch === "feat/x",
  `got branch=${cls("git push origin HEAD:feat/x").branch}`,
);
check(
  "classifier::dry-run-withdrawn",
  cls("git push --dry-run origin feat/x").inScope === false,
  "a --dry-run push buys no run and must be withdrawn",
);
check(
  "classifier::second-segment-push-after-a-dry-run-is-still-seen",
  cls("git push --dry-run origin feat/x && git push origin feat/x").inScope === true,
  "short-circuiting on the leading dry run goes silent on a push that DOES buy a run",
);
check(
  "classifier::tag-only-withdrawn",
  cls("git push origin --tags").inScope === false,
  "a tag-only push lands no branch head",
);
check(
  "classifier::unresolvable-is-its-own-identity",
  cls('eval "git push origin $BRANCH"').why === "unresolvable-push",
  "an unknown must be named, not collapsed into not-a-push; got " +
    JSON.stringify(cls('eval "git push origin $BRANCH"')),
);
// Every WITHDRAWAL names WHICH scope restriction produced the silence. Collapsed
// into one identity, a fixture cannot tell a dry-run withdrawal from a tag-only
// one, and a regression in either reads as the other still working.
for (const [c, want] of [
  ["git push --dry-run origin feat/x", "dry-run"],
  ["git push fork feat/x", "non-origin-remote"],
  ["git push origin --tags", "tag-only-push"],
  ["git push origin :feat/x", "delete-push"],
  ["git status", "not-a-push"],
]) {
  check(
    `classifier::withdrawal-identity::${want}`,
    cls(c).why === want,
    `"${c}" should withdraw as "${want}", got "${cls(c).why}"`,
  );
}

// ── Unit poles on the transcript reader ─────────────────────────────────────
const goodRow = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
});
check(
  "transcript::reads-a-tool_use-command",
  L.transcriptBashCommands(goodRow).commands[0] === "ls",
  "a well-formed Bash tool_use record was not read",
);
check(
  "transcript::skips-a-half-line-without-throwing",
  L.transcriptBashCommands('{"type":"assist' + "\n" + goodRow).commands.length === 1,
  "a tail read slices mid-line; the fragment must be skipped, never thrown on",
);
check(
  "transcript::ignores-a-non-Bash-tool_use",
  L.transcriptBashCommands(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { command: "pre-commit run" } }] },
    }),
  ).commands.length === 0,
  "only a dispatched Bash argv is evidence that a command RAN",
);

console.log("");
if (failures.length) {
  console.log(`RESULT: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAILED CASE: ${f}`);
  process.exit(1);
}
console.log(`RESULT: ${pass} passed, 0 failed (${files.length} fixture files)`);
process.exit(0);
