#!/usr/bin/env node
/**
 * Bipolar fixtures for the synthetic-load guard (`ci-cost-discipline` MUST-7, journal/0609).
 *
 * EVERY COMMAND STRING BELOW IS DATA. Nothing here executes a classified command: the
 * predicate is a pure function over strings, and the end-to-end cases hand the hook a JSON
 * payload on stdin. A fixture that launched `stress-ng` to prove the guard refuses it would be
 * the incident this guard exists for.
 *
 * What these MUST prove, per pair: the guard returns BOTH verdicts, with IDENTITY (rule_id +
 * kind + matched word), so a guard that fires on everything and one that fires on nothing both
 * red. The no-false-positive poles are the ones the brief named, verbatim.
 */
import "../_lib/no-ambient-git.cjs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const LIB = path.resolve(here, "../../hooks/lib/synthetic-load.js");
const HOOK = path.resolve(here, "../../hooks/synthetic-load-guard.js");
const L = require_(LIB);
const G = require_(HOOK);
const { instructAndWait } = require_(path.resolve(here, "../../hooks/lib/instruct-and-wait.js"));

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    process.stdout.write(`PASS ${name}\n`);
  } else {
    failures.push(`${name}: ${detail}`);
    process.stdout.write(`FAIL ${name}\n`);
  }
}
const show = (v) => JSON.stringify(v);
const summary = (fs_) => fs_.map((f) => `${f.severity}/${f.kind}/${f.matched}`).join(", ") || "[]";

function hasFinding(findings, id) {
  return findings.some(
    (f) =>
      f.rule_id === L.RULE_ID &&
      f.kind === id.kind &&
      f.severity === id.severity &&
      f.matched === id.matched &&
      (id.copies === undefined || f.copies === id.copies),
  );
}
const BLOCK = (matched) => ({ kind: "load-tool", severity: "block", matched });
const BUSY = (matched) => ({ kind: "busy-loop", severity: "halt-and-report", matched });
const FAN = (matched, copies) => ({ kind: "fan-out", severity: "halt-and-report", matched, copies });

function red(name, command, id) {
  const r = L.classifyCommand(command);
  check(name, hasFinding(r, id), `expected ${show(id)} for ${show(command)}; got ${summary(r)}`);
  return r;
}
function green(name, command) {
  const r = L.classifyCommand(command);
  check(name, r.length === 0, `expected SILENT for ${show(command)}; got ${summary(r)}`);
  return r;
}
function polesDiffer(name, a, b) {
  check(name, summary(a) !== summary(b), `both poles returned ${summary(a)} — the pair is VACUOUS`);
}

// ── INTERFACE CONTRACT (the backstop imports these names) ───────────────────
check("contract-RULE_ID", L.RULE_ID === "ci-cost-discipline/MUST-7", show(L.RULE_ID));
check("contract-exports-are-functions",
  ["classifyCommand", "classifyArgv", "isBusyLoopBody"].every((k) => typeof L[k] === "function"),
  Object.keys(L).join(","));
check("contract-LOAD_TOOL_WORDS-array-and-set-shaped",
  Array.isArray(L.LOAD_TOOL_WORDS) && L.LOAD_TOOL_WORDS.includes("stress-ng") &&
    L.LOAD_TOOL_WORDS.has("stress") && L.LOAD_TOOL_WORDS.size === L.LOAD_TOOL_WORDS.length &&
    Object.isFrozen(L.LOAD_TOOL_WORDS) && !L.LOAD_TOOL_WORDS.has("node"),
  "must answer includes/has/size and exclude non-load words");
{
  const f = L.classifyCommand("stress-ng --cpu 8")[0] || {};
  check("contract-finding-carries-exactly-the-five-fields",
    show(Object.keys(f).sort()) === show(["evidence", "kind", "matched", "rule_id", "severity"]), show(f));
}

// ── PAIR 1 — the INCIDENT command, and the async wait that must not trip it ─
const INCIDENT = 'node -e "const e=Date.now()+900*1000;while(Date.now()<e){}"';
const p1r = red("pair1-red-incident-busy-loop-is-reported", INCIDENT, BUSY("node -e"));
const p1g = green("pair1-green-async-poll-with-setTimeout-is-silent",
  'node -e "(async()=>{while(true){if(await ready())break;await new Promise(r=>setTimeout(r,100))}})()"');
polesDiffer("pair1-poles-differ", p1r, p1g);
check("pair1-incident-is-NOT-a-block-lexical-cap", p1r.every((f) => f.severity !== "block"),
  "an interpreter body is read lexically; MUST-2 caps it at halt-and-report");

// ── PAIR 2 — dedicated load tools at command position BLOCK; mentions do not ─
const p2r = red("pair2-red-stress-ng", "stress-ng --cpu 8 --timeout 60", BLOCK("stress-ng"));
const p2g = green("pair2-green-echoed-mention", 'echo "stress-ng --cpu 8"');
polesDiffer("pair2-poles-differ", p2r, p2g);
red("pair2-red-stress", "stress --cpu 4", BLOCK("stress"));
red("pair2-red-absolute-path", "/usr/local/bin/stress-ng --cpu 1", BLOCK("stress-ng"));
green("pair2-green-grep-mention", "grep -n stress-ng notes.md");
green("pair2-green-help", "stress-ng --help");
green("pair2-green-version", "stress-ng --version");
green("pair2-green-install", "brew install stress-ng");
green("pair2-green-command-v-lookup", "command -v stress-ng");
green("pair2-green-which", "which stress-ng");

// ── PAIR 3 — wrappers do NOT lift the block; a wrapper OPERAND is not a command ─
red("pair3-red-timeout-bounded-is-STILL-a-block", "timeout 60 stress-ng --cpu 8", BLOCK("stress-ng"));
red("pair3-red-nice", "nice -n 19 stress-ng -c 2", BLOCK("stress-ng"));
red("pair3-red-nohup-background", "nohup stress-ng --cpu 8 &", BLOCK("stress-ng"));
red("pair3-red-sudo-user", "sudo -u root stress-ng --cpu 1", BLOCK("stress-ng"));
red("pair3-red-env-assign", "env FOO=1 stress-ng --cpu 1", BLOCK("stress-ng"));
red("pair3-red-caffeinate", "caffeinate -i stress-ng --cpu 2", BLOCK("stress-ng"));
red("pair3-red-taskpolicy", "taskpolicy -c utility stress-ng --cpu 2", BLOCK("stress-ng"));
red("pair3-red-exec", "exec stress-ng -c 1", BLOCK("stress-ng"));
red("pair3-red-timeout-signal-flag", "timeout -s KILL 60 stress-ng --cpu 1", BLOCK("stress-ng"));
const p3r = red("pair3-red-timeout-then-tool", "timeout 5 stress-ng -c 1", BLOCK("stress-ng"));
const p3g = green("pair3-green-timeout-grep-names-tool-as-ARGUMENT", "timeout 5 grep -rn stress-ng .");
polesDiffer("pair3-poles-differ", p3r, p3g);

// ── PAIR 4 — nested bodies and groups are commands too ──────────────────────
red("pair4-red-bash-c", "bash -c 'stress-ng --cpu 8'", BLOCK("stress-ng"));
red("pair4-red-sh-c-yes-discard", 'sh -c "yes > /dev/null"', BLOCK("yes"));
red("pair4-red-zsh-lc-cluster", "zsh -lc 'stress-ng --cpu 1'", BLOCK("stress-ng"));
red("pair4-red-eval", 'eval "stress-ng --cpu 2"', BLOCK("stress-ng"));
red("pair4-red-env-S", 'env -S "stress-ng --cpu 2"', BLOCK("stress-ng"));
red("pair4-red-subshell", "(stress-ng --cpu 2)", BLOCK("stress-ng"));
red("pair4-red-brace-group", "{ stress-ng --cpu 2; }", BLOCK("stress-ng"));
red("pair4-red-and-chain", "cd /tmp && stress-ng --cpu 2", BLOCK("stress-ng"));
red("pair4-red-semicolon-chain", "echo hi; stress-ng --cpu 2", BLOCK("stress-ng"));
const p4r = red("pair4-red-command-substitution", "x=$(stress-ng --cpu 1)", BLOCK("stress-ng"));
const p4g = green("pair4-green-single-quoted-substitution-is-literal", "echo '$(stress-ng --cpu 1)'");
polesDiffer("pair4-poles-differ", p4r, p4g);

// ── PAIR 5 — `yes` is load only when nothing consumes it ────────────────────
const p5r = red("pair5-red-yes-to-dev-null", "yes > /dev/null", BLOCK("yes"));
const p5g = green("pair5-green-yes-into-head", "yes | head -n 3");
polesDiffer("pair5-poles-differ", p5r, p5g);
red("pair5-red-yes-attached-redirect-background", "yes >/dev/null &", BLOCK("yes"));
red("pair5-red-yes-ampersand-redirect", "yes &> /dev/null", BLOCK("yes"));
red("pair5-red-yes-fd1-append", "yes 1>>/dev/null", BLOCK("yes"));
red("pair5-red-yes-background-no-consumer", "yes &", BLOCK("yes"));
green("pair5-green-yes-into-installer", "yes y | some-installer");
green("pair5-green-man-yes", "man yes");
green("pair5-green-yes-to-shell-variable-target", 'yes > "$OUT"');

// ── PAIR 6 — other load generators and their bounded / consumed twins ───────
red("pair6-red-openssl-speed", "openssl speed", BLOCK("openssl speed"));
red("pair6-red-openssl-speed-multi", "openssl speed -multi 16 rsa2048", BLOCK("openssl speed"));
green("pair6-green-openssl-rand", "openssl rand -hex 16");
red("pair6-red-sysbench-cpu", "sysbench cpu run", BLOCK("sysbench cpu"));
red("pair6-red-sysbench-legacy-test-flag", "sysbench --test=cpu run", BLOCK("sysbench cpu"));
green("pair6-green-sysbench-cpu-help", "sysbench cpu help");
green("pair6-green-sysbench-fileio", "sysbench fileio run");
red("pair6-red-dd-zero-to-null-unbounded", "dd if=/dev/zero of=/dev/null", BLOCK("dd"));
red("pair6-red-dd-urandom-bs", "dd if=/dev/urandom of=/dev/null bs=1m", BLOCK("dd"));
green("pair6-green-dd-with-count", "dd if=/dev/zero of=/dev/null count=100");
green("pair6-green-dd-to-image", "dd if=/dev/zero of=img bs=1m count=10");
red("pair6-red-cat-urandom-to-null", "cat /dev/urandom > /dev/null", BLOCK("cat /dev/urandom"));
green("pair6-green-cat-urandom-into-head", "cat /dev/urandom | head -c 16");
green("pair6-green-head-bounded-read", "head -c 16 /dev/urandom");
red("pair6-red-md5-dev-zero", "md5 /dev/zero", BLOCK("md5"));
red("pair6-red-sha256sum-stdin-zero", "sha256sum < /dev/zero", BLOCK("sha256sum"));
green("pair6-green-sha256sum-file", "sha256sum package.json");
red("pair6-red-7z-benchmark", "7z b", BLOCK("7z b"));
green("pair6-green-7z-extract", "7z x archive.7z");

// ── PAIR 7 — MUST-3: shell variables and data surfaces are silent ───────────
green("pair7-green-variable-command", "$CMD --cpu 8");
green("pair7-green-variable-wrapper", "$WRAP stress-ng --cpu 8");
green("pair7-green-substituted-command-name", "$(which stress-ng) --cpu 8");
green("pair7-green-commit-message-body", 'git commit -m "while true; do :; done"');
green("pair7-green-gh-body", 'gh issue create --body "stress-ng --cpu 8"');
green("pair7-green-heredoc-DATA-body",
  "cat > notes.md <<'EOF'\nstress-ng --cpu 8\nwhile true; do :; done\nnode -e 'while(true){}'\nEOF");
green("pair7-green-comment", "ls # stress-ng --cpu 8");
green("pair7-green-js-string-mentions-loop", "node -e \"const s='while(true){}'; console.log(s)\"");
green("pair7-green-echo-to-file", "echo 'while(true){}' > x.js");

// ── PAIR 8 — interpreter busy loops (halt-and-report) vs real work ──────────
red("pair8-red-node-eval", "node --eval 'while(true){}'", BUSY("node --eval"));
red("pair8-red-node-for-ever", "node -e 'for(;;){}'", BUSY("node -e"));
red("pair8-red-node-print-empty-statement", 'node -p "while(1);"', BUSY("node -p"));
red("pair8-red-node-do-while", "node -e 'do{}while(true)'", BUSY("node -e"));
red("pair8-red-node-counter-body", "node -e 'let i=0;while(true){i++}'", BUSY("node -e"));
red("pair8-red-node-time-guarded-break", "node -e 'const e=Date.now()+5e5;while(true){if(Date.now()>e)break}'", BUSY("node -e"));
red("pair8-red-node-math-random-body", "node -e 'while(true){Math.random()}'", BUSY("node -e"));
red("pair8-red-node-wrapped-timeout", "timeout 900 node -e 'for(;;){}'", BUSY("node -e"));
green("pair8-green-node-console", 'node -e "console.log(1)"');
green("pair8-green-node-small-counter", "node -e 'for(let i=0;i<10;i++){}'");
green("pair8-green-node-break-without-clock", "node -e 'while(true){i++;if(i>5)break}'");
green("pair8-green-node-poll-on-fs", "node -e \"while(!fs.existsSync(p)){}\"");
green("pair8-green-node-io-in-body", "node -e \"while(Date.now()<e){ require('fs').statSync('x') }\"");
green("pair8-green-node-script-file", "node server.js");
red("pair8-red-python-while-true", "python -c 'while True: pass'", BUSY("python -c"));
red("pair8-red-python-time-bound-multiline", 'python3 -c "import time; e=time.time()+900\nwhile time.time()<e: pass"', BUSY("python3 -c"));
red("pair8-red-python-ansi-c-body", "python3 -c $'while True:\\n    pass'", BUSY("python3 -c"));
red("pair8-red-python-huge-range", "python3 -c 'for _ in range(10**10): pass'", BUSY("python3 -c"));
green("pair8-green-python-repl-bridge", 'python -u -c "import sys;exec(eval(sys.stdin.readline()))"');
green("pair8-green-python-sleep-body", "python3 -c 'import time\nwhile True: time.sleep(1)'");
green("pair8-green-python-input-loop", 'python -c "while True: print(input())"');
green("pair8-green-python-small-range", 'python3 -c "for i in range(10): pass"');
red("pair8-red-perl-modifier", "perl -e '1 while 1'", BUSY("perl -e"));
red("pair8-red-perl-block", "perl -e 'while(1){}'", BUSY("perl -e"));
red("pair8-red-perl-time-bound", "perl -e 'my $e=time+900; 1 while time < $e'", BUSY("perl -e"));
green("pair8-green-perl-read-loop-flag", "perl -ne 'print if /x/' f");
green("pair8-green-perl-sleep", "perl -e 'while(1){sleep 1}'");
red("pair8-red-ruby-loop-braces", "ruby -e 'loop {}'", BUSY("ruby -e"));
red("pair8-red-ruby-loop-do", "ruby -e 'loop do end'", BUSY("ruby -e"));
red("pair8-red-ruby-time-bound", "ruby -e 'e=Time.now+900; while Time.now<e; end'", BUSY("ruby -e"));
green("pair8-green-ruby-sleep", "ruby -e 'loop { sleep 1 }'");
green("pair8-green-ruby-puts", "ruby -e 'loop { puts gets }'");

// ── PAIR 9 — shell loops ────────────────────────────────────────────────────
const p9r = red("pair9-red-while-colon", "while :; do :; done", BUSY("while-loop"));
const p9g = green("pair9-green-while-true-sleep", "while true; do sleep 1; done");
polesDiffer("pair9-poles-differ", p9r, p9g);
red("pair9-red-while-true-true", "while true; do true; done", BUSY("while-loop"));
red("pair9-red-until-false", "until false; do :; done", BUSY("until-loop"));
red("pair9-red-c-style-for-ever", "for ((;;)); do :; done", BUSY("for-loop"));
red("pair9-red-brace-range-huge", "for i in {1..100000000}; do :; done", BUSY("for-loop"));
red("pair9-red-seq-range-huge", "for i in $(seq 1 100000000); do :; done", BUSY("for-loop"));
red("pair9-red-multiline", "while true\ndo\n  :\ndone", BUSY("while-loop"));
red("pair9-red-arith-body", "i=0; while :; do i=$((i+1)); done", BUSY("while-loop"));
red("pair9-red-date-time-bound", "end=$(( $(date +%s) + 900 )); while [ $(date +%s) -lt $end ]; do :; done", BUSY("while-loop"));
red("pair9-red-bash-c-nested", "bash -c 'while :; do :; done'", BUSY("while-loop"));
red("pair9-red-sh-c-backgrounded", 'sh -c "while true; do :; done" &', BUSY("while-loop"));
green("pair9-green-read-loop", 'while read -r l; do echo "$l"; done < f');
green("pair9-green-curl-poll", "until curl -sf localhost:3000; do sleep 1; done");
green("pair9-green-kill-0-poll", 'while kill -0 "$pid"; do sleep 2; done');
green("pair9-green-glob-for", "for f in *.md; do :; done");
green("pair9-green-small-range", "for i in {1..10}; do :; done");
green("pair9-green-sleep", "sleep 5");
green("pair9-green-sleep-in-substitution", "while :; do x=$(sleep 1); done");

// ── PAIR 10 — stdin-fed programs ────────────────────────────────────────────
red("pair10-red-node-heredoc", "node <<'EOF'\nwhile(true){}\nEOF", BUSY("node (stdin program)"));
red("pair10-red-python-dash-heredoc", "python3 - <<'EOF'\nwhile True:\n    pass\nEOF", BUSY("python3 (stdin program)"));
red("pair10-red-bash-heredoc", "bash <<'EOF'\nwhile :; do :; done\nEOF", BUSY("while-loop"));
red("pair10-red-here-string", "node <<< 'while(true){}'", BUSY("node (stdin program)"));
const p10r = red("pair10-red-echo-pipe", "echo 'while(true){}' | node", BUSY("node (stdin program)"));
const p10g = green("pair10-green-echo-pipe-console", "echo 'console.log(1)' | node");
polesDiffer("pair10-poles-differ", p10r, p10g);
green("pair10-green-expandable-heredoc-body-skipped", "node <<EOF\nwhile($X){}\nEOF");

// ── PAIR 11 — fan-out ───────────────────────────────────────────────────────
const p11r = red("pair11-red-for-list-background", 'for i in 1 2 3 4; do node -e "while(true){}" & done', FAN("for-loop &", 4));
const p11g = green("pair11-green-for-list-background-sleep", "for i in 1 2 3; do sleep 1 & done; wait");
polesDiffer("pair11-poles-differ", p11r, p11g);
red("pair11-red-repeated-segments", "node -e 'for(;;){}' & node -e 'for(;;){}' &", FAN("&", 2));
red("pair11-red-xargs-P", "seq 8 | xargs -P 8 -I{} node -e 'while(true){}'", FAN("xargs -P", 8));
red("pair11-red-parallel", "parallel -j 4 \"node -e 'while(true){}'\" ::: 1 2 3 4", FAN("parallel", 4));
red("pair11-red-seq-subshell-loops", "for i in $(seq 1 16); do (while :; do :; done) & done", FAN("for-loop &", 16));
red("pair11-red-unbounded-spawner", "while true; do node -e 'for(;;){}' & done", FAN("while-loop &", "unbounded"));
{
  const r = red("pair11-red-yes-twice-keeps-the-block", "yes > /dev/null & yes > /dev/null &", BLOCK("yes"));
  check("pair11-yes-twice-also-reports-fan-out", hasFinding(r, FAN("&", 2)), summary(r));
}
green("pair11-green-xargs-echo", "seq 4 | xargs -P 4 -n 1 echo");
green("pair11-green-parallel-jobs", "npm test & npm run lint & wait");
{
  const r = L.classifyCommand("for i in 1; do node -e 'for(;;){}' & done");
  check("pair11-green-single-copy-is-not-fan-out", !r.some((f) => f.kind === "fan-out"), summary(r));
}

// ── PAIR 13 — process substitution RUNS its body ────────────────────────────
// `tokenize` does not group `<(…)`, so before the dedicated scan these words landed outside any
// command position and the launch was silent. Each green pole is the SAME carrier command with a
// harmless body, so a pair that both-reds means the scan fires on the carrier, not the body.
const p13r = red("pair13-red-process-substitution-input", "head <(stress-ng --cpu 8)", BLOCK("stress-ng"));
const p13g = green("pair13-green-process-substitution-git-log", "head <(git log)");
polesDiffer("pair13-poles-differ", p13r, p13g);
red("pair13-red-process-substitution-output", "tee >(stress-ng --cpu 1) < f", BLOCK("stress-ng"));
red("pair13-red-process-substitution-diff-two", "diff <(sort a) <(stress-ng --cpu 2)", BLOCK("stress-ng"));
red("pair13-red-process-substitution-busy-loop", "head <(node -e 'while(true){}')", BUSY("node -e"));
green("pair13-green-process-substitution-two-harmless", "diff <(sort a) <(sort b)");
green("pair13-green-quoted-not-a-substitution", "echo '<(stress-ng --cpu 8)'");

// ── PAIR 14 — a HERE-STRING to a shell is its script ────────────────────────
const p14r = red("pair14-red-here-string-to-bash", 'bash <<<"stress-ng --cpu 8"', BLOCK("stress-ng"));
const p14g = green("pair14-green-here-string-echo", 'bash <<<"echo hi"');
polesDiffer("pair14-poles-differ", p14r, p14g);
red("pair14-red-here-string-shell-loop", 'sh <<<"while :; do :; done"', BUSY("while-loop"));
green("pair14-green-here-string-variable-body-fails-open", 'bash <<<"$CMD"');

// ── PAIR 15 — find's command-running actions ────────────────────────────────
const p15r = red("pair15-red-find-exec", "find . -exec stress-ng \\;", BLOCK("stress-ng"));
const p15g = green("pair15-green-find-exec-grep", "find . -exec grep -n x {} \\;");
polesDiffer("pair15-poles-differ", p15r, p15g);
red("pair15-red-find-execdir-nested-sh-c", "find . -execdir sh -c 'stress-ng' \\;", BLOCK("stress-ng"));
red("pair15-red-find-exec-plus-form", "find . -name '*.c' -exec stress-ng {} +", BLOCK("stress-ng"));
red("pair15-red-find-exec-busy-loop", "find . -exec node -e 'while(true){}' \\;", BUSY("node -e"));
green("pair15-green-find-plain", "find . -name '*.md'");
green("pair15-green-find-exec-rm", "find . -name '*.tmp' -exec rm {} \\;");

// ── PAIR 16 — command-running wrappers (the SHARED table, not a local copy) ──
const p16r = red("pair16-red-watch", "watch stress-ng --cpu 1", BLOCK("stress-ng"));
const p16g = green("pair16-green-watch-git-status", "watch -n 5 git status");
polesDiffer("pair16-poles-differ", p16r, p16g);
red("pair16-red-flock", "flock /tmp/l stress-ng -c 1", BLOCK("stress-ng"));
red("pair16-red-flock-body-form", "flock /tmp/l -c 'stress-ng --cpu 1'", BLOCK("stress-ng"));
red("pair16-red-watch-exec-form", "watch -x stress-ng --cpu 1", BLOCK("stress-ng"));
red("pair16-red-chronic", "chronic stress-ng --cpu 1", BLOCK("stress-ng"));
red("pair16-red-unbuffer", "unbuffer stress-ng --cpu 1", BLOCK("stress-ng"));
red("pair16-red-script-c", "script -c 'stress-ng --cpu 1' /dev/null", BLOCK("stress-ng"));
red("pair16-red-su-c", "su -c 'stress-ng --cpu 1'", BLOCK("stress-ng"));
red("pair16-red-watch-busy-loop", "watch node -e 'while(true){}'", BUSY("node -e"));
green("pair16-green-flock-git", "flock /tmp/l git gc");
green("pair16-green-watch-uptime", "watch -n 2 uptime");
// `parallel` is in the same shared table but is handled locally, because only the local reading
// carries the `-j` degree. This pins that it did NOT get routed away into the generic extraction.
red("pair16-red-parallel-still-reports-copies", "parallel -j 4 \"node -e 'while(true){}'\" ::: 1 2 3 4", FAN("parallel", 4));

// ── PAIR 17 — case folding (APFS folds; an exact-case test does not) ────────
const p17r = red("pair17-red-uppercase-tool", "STRESS-NG --cpu 8", BLOCK("stress-ng"));
const p17g = green("pair17-green-uppercase-mention", 'echo "STRESS-NG --cpu 8"');
polesDiffer("pair17-poles-differ", p17r, p17g);
red("pair17-red-uppercase-interpreter", 'NODE -e "while(true){}"', BUSY("node -e"));
red("pair17-red-mixed-case-wrapper", "TIMEOUT 60 Stress-NG --cpu 1", BLOCK("stress-ng"));
green("pair17-green-uppercase-help", "STRESS-NG --help");

// ── PAIR 21 — the fold is TOTAL, not per-site ──────────────────────────────
// PAIR 17 pinned the fold where it was first applied. These rows pin it at every OTHER surface that
// resolves a word through the filesystem, because the defect was the INCONSISTENCY: `wrapperNested`
// folded its `find` arm and read the shared-wrapper arm raw, so `watch stress-ng --cpu 1` BLOCKED
// while `Watch stress-ng --cpu 1` was SILENT — both spellings executing the same binary here.
// Every red below is paired with its lower-case twin, so a row that passes only because the guard
// blocks everything is visible: the greens are the same surfaces with a non-load command.
for (const [tag, upper, lower] of [
  ["command-running-wrapper", "Watch stress-ng --cpu 1", "watch stress-ng --cpu 1"],
  ["wrapper-all-caps", "WATCH stress-ng --cpu 1", "watch stress-ng --cpu 1"],
  ["find-exec", "FIND . -exec stress-ng \\;", "find . -exec stress-ng \\;"],
  ["flock", "FLOCK /tmp/l stress-ng -c 1", "flock /tmp/l stress-ng -c 1"],
  ["caffeinate", "CAFFEINATE -s stress-ng --cpu 4", "caffeinate -s stress-ng --cpu 4"],
  // The PREFIX and the target fold together: `scanCommandPrefix` reads its prefix table raw too,
  // so folding only the wrapper left this one silent.
  ["prefix-and-wrapper", "TIMEOUT 60 WATCH stress-ng --cpu 1", "timeout 60 watch stress-ng --cpu 1"],
])
  for (const [pole, cmd] of [["upper", upper], ["lower", lower]])
    red(`pair21-red-${tag}-${pole}`, cmd, BLOCK("stress-ng"));
// The no-false-positive pole for the SAME folded surfaces: a folded wrapper word must not make the
// command it runs load. Both spellings stay silent, so the fold added detection, not noise.
green("pair21-green-watch-git-status-upper", "WATCH -n 5 git status");
green("pair21-green-watch-git-status-lower", "watch -n 5 git status");
green("pair21-green-find-name-upper", "FIND . -name '*.js'");
green("pair21-green-flock-git-upper", "FLOCK /tmp/l git gc");
green("pair21-green-mention-upper", 'echo "WATCH stress-ng --cpu 1"');
// `parallel` is folded BUT excluded from the nested extraction, so its local `-j` reading survives:
// the upper-case spelling must still carry the `copies` count, not be routed away and lose it.
red("pair21-red-parallel-upper-keeps-copies", "PARALLEL -j 4 \"node -e 'while(true){}'\" ::: 1 2 3 4", FAN("parallel", 4));
// The TABLE's own mixed-case entries. `burnP5` … `burnBX` are the CANONICAL spellings of six of the
// fourteen load tools, and the consumer only ever asks the folded form — so an exact-case set made
// the spelling a user actually types unmatchable. Measured before the fix: `burnP5` → `[]`.
for (const w of ["burnP5", "burnp5", "BURNP5", "burnMMX", "burnbx", "burnK7"])
  red(`pair21-red-table-mixed-case-${w}`, `${w} &`, BLOCK(w.replace(/[A-Z]/g, (c) => c.toLowerCase())));
check("pair21-table-has-is-fold-symmetric",
  ["burnP5", "burnp5", "BURNP5", "stress-ng", "STRESS-NG"].every((w) => L.LOAD_TOOL_WORDS.has(w)) &&
    ["cat", "CAT", "dd", "DD"].every((w) => L.CONDITIONAL_LOAD_TOOL_WORDS.has(w)) &&
    !L.LOAD_TOOL_WORDS.has("node") && !L.LOAD_TOOL_WORDS.has("NODE"),
  "the word tables must answer the same for either spelling, and still exclude non-load words");
// Device paths: the directory components live on the folding volume, so `/DEV/zero` is the same
// file. The fold is over-broad by exactly `/dev/ZERO`, which resolves nowhere — the safe direction.
red("pair21-red-infinite-source-upper-dir", "cat /DEV/zero > /dev/null", BLOCK("cat /dev/zero"));
red("pair21-red-discard-sink-upper", "yes > /DEV/null", BLOCK("yes"));
green("pair21-green-ordinary-file-is-not-a-device", "cat /tmp/Dev/Zero > /dev/null");
// A folded PIPE carrier: `ECHO … | node` feeds the interpreter the same bytes `echo` would.
red("pair21-red-piped-program-upper", "ECHO 'while(true){}' | node", BUSY("node (stdin program)"));
green("pair21-green-piped-program-not-busy", "ECHO 'console.log(1)' | node");
// A folded shell BUILTIN inside a loop body: unfolded, `TRUE` read as impure work and suppressed
// the finding for a loop that in fact spins.
red("pair21-red-sh-loop-body-upper-true", "while :; do TRUE; done", BUSY("while-loop"));
green("pair21-green-sh-loop-body-does-work", "while :; do curl -s http://x; sleep 1; done");
// DELIBERATELY NOT FOLDED — flags are parsed by the tool, not resolved by the kernel. `--HELP` is
// an unknown option to stress-ng, which still runs the stressors, so the exemption must NOT apply.
red("pair21-red-uppercase-flag-is-not-an-info-flag", "stress-ng --HELP", BLOCK("stress-ng"));
green("pair21-green-lowercase-flag-is-an-info-flag", "stress-ng --help");
// DELIBERATELY NOT FOLDED — bash matches reserved words case-sensitively; `WHILE` is a command
// word, not a loop keyword, so nothing here is a shell busy loop.
green("pair21-green-uppercase-shell-keyword-is-not-a-loop", "WHILE :; do :; done");

// ── PAIR 22 — a CHAIN of wrappers resolves to the innermost command word ────
// The defect these pin: a LOCALLY-modelled wrapper (`EXTRA_WRAPPERS` — `cpulimit`, `taskpolicy`,
// `numactl`) chained in FRONT of a command-running wrapper escaped the `block` tier entirely,
// because the local→shared token rewrite existed in `resolveSlot` and NOT in `wrapperNested`, and
// both shared walks (`scanCommandPrefix`, `nestedCommandStrings`) read such a word as the COMMAND
// NAME and stop. Measured before the fix: `cpulimit -l 50 watch stress-ng` → SILENT, while
// `watch stress-ng --cpu 1` (PAIR 16) blocked.
//
// THE NEAR-MISS IS PINNED TOO, and it is why the class survived earlier probes: a LEADING shared
// wrapper sets `scanCommandPrefix`'s `sawWrapper`, after which every bare operand — including the
// unmodelled local wrapper — is skipped, so `nice -n 19 cpulimit -l 50 flock /tmp/l stress-ng`
// ALWAYS blocked. Any probe that led with `timeout`/`nice` reported the chain covered. Both
// spellings are rows here, so a future regression that re-narrows the walk to the lenient path
// reds on the local-wrapper-FIRST rows while the `nice`-first row stays green.
const p22r = red("pair22-red-local-wrapper-chained-before-watch", "cpulimit -l 50 watch stress-ng", BLOCK("stress-ng"));
const p22g = green("pair22-green-local-wrapper-chained-before-benign", "cpulimit -l 50 watch -n 5 git status");
polesDiffer("pair22-poles-differ", p22r, p22g);
// One row per chain FAMILY: local→nested, local→find, local→local→nested, and the shared-table
// chains the brief named. The brief's own probe list, verbatim, is the red half.
for (const [tag, cmd] of [
  ["cpulimit-watch", "cpulimit -l 50 watch stress-ng"],
  ["nice-flock", "nice -n 19 flock /tmp/l stress-ng"],
  ["timeout-nohup-watch", "timeout 60 nohup watch stress-ng"],
  ["setarch-taskset", "setarch x86_64 taskset -c 0 stress-ng"],
  ["strace-watch-sh", "strace -f watch sh -c 'stress-ng'"],
  ["taskpolicy-watch", "taskpolicy -c background watch stress-ng"],
  ["numactl-watch", "numactl -C 0 watch stress-ng"],
  ["cpulimit-flock", "cpulimit -l 50 flock /tmp/l stress-ng"],
  ["cpulimit-find-exec", "cpulimit -l 50 find . -exec stress-ng \\;"],
  ["cpulimit-caffeinate", "cpulimit -l 50 caffeinate stress-ng"],
  ["cpulimit-chronic", "cpulimit -l 50 chronic stress-ng"],
  ["two-local-then-nested", "cpulimit -l 50 taskpolicy -c background watch stress-ng"],
  ["local-then-two-nested", "cpulimit -l 50 watch flock /tmp/l watch stress-ng"],
  ["cpulimit-watch-exec-form", "cpulimit -l 50 watch -x stress-ng --cpu 1"],
  ["cpulimit-flock-body-form", "cpulimit -l 50 flock /tmp/l -c 'stress-ng --cpu 1'"],
  ["path-qualified-local-wrapper", "/usr/bin/cpulimit -l 50 watch stress-ng"],
  // The NEAR-MISS spelling: this one blocked BEFORE the fix, through `sawWrapper` leniency.
  ["shared-wrapper-first-near-miss", "nice -n 19 cpulimit -l 50 flock /tmp/l stress-ng"],
])
  red(`pair22-red-${tag}`, cmd, BLOCK("stress-ng"));
// The chain is folded on EVERY link, not only the first: a local wrapper and the nested wrapper
// after it both resolve through the filesystem, so both spellings run the same binaries here.
for (const [tag, cmd] of [
  ["cpulimit-watch", "CPULIMIT -l 50 WATCH stress-ng"],
  ["nice-flock", "NICE -n 19 FLOCK /tmp/l stress-ng"],
  ["timeout-nohup-watch", "TIMEOUT 60 NOHUP WATCH stress-ng"],
  ["setarch-taskset", "SETARCH x86_64 TASKSET -c 0 stress-ng"],
  ["strace-watch-sh", "STRACE -f WATCH SH -c 'stress-ng'"],
  ["path-qualified-local-wrapper", "/usr/bin/CPULIMIT -l 50 WATCH stress-ng"],
])
  red(`pair22-red-upper-${tag}`, cmd, BLOCK("stress-ng"));
red("pair22-red-xvfbrun-timeout-yes-sink", "xvfb-run -a timeout 30 yes > /dev/null", BLOCK("yes"));
red("pair22-red-upper-xvfbrun-timeout-yes-sink", "XVFB-RUN -a TIMEOUT 30 YES > /dev/null", BLOCK("yes"));
// The chain carries the halt-and-report classes through too, not only `load-tool`.
red("pair22-red-chain-to-busy-loop", "cpulimit -l 50 watch node -e 'while(true){}'", BUSY("node -e"));
red("pair22-red-chain-keeps-parallel-copies", "cpulimit -l 50 parallel -j 4 \"node -e 'while(true){}'\" ::: 1 2 3 4", FAN("parallel", 4));

// THE SUBSTITUTION IS BOUNDED AT THE TARGET, and these rows are what caught that. The local→shared
// rewrite maps `cpulimit` onto a surrogate with NO option grammar; applied to the WHOLE segment it
// also rewrote a local wrapper sitting INSIDE the nested wrapper's operands, so `-l` was read as a
// bare flag and `50` landed in the command slot. Measured on the intermediate fix:
// `watch cpulimit -l 50 stress-ng` went `block` → SILENT. Past the target the word is only CASE
// FOLDED, which keeps its identity and lets the recursion read it with this module's `OPERAND_FLAGS`.
red("pair22-red-local-wrapper-inside-nested-operands", "watch cpulimit -l 50 stress-ng", BLOCK("stress-ng"));
red("pair22-red-local-wrapper-inside-nested-operands-upper", "watch CPULIMIT -l 50 stress-ng", BLOCK("stress-ng"));
red("pair22-red-local-wrapper-inside-flock-operands", "flock /tmp/l cpulimit -l 50 stress-ng", BLOCK("stress-ng"));
green("pair22-green-local-wrapper-inside-nested-operands-benign", "watch cpulimit -l 50 git status");

// NO-FALSE-POSITIVE POLES — a chain of wrappers around benign work is ORDINARY INSTRUCTED WORK,
// and `hook-output-discipline.md`'s MUST NOT is that the guard never blocks it. These are the
// brief's four poles verbatim, plus the surfaces the chain fix newly reaches.
for (const [tag, cmd] of [
  ["cpulimit-watch-git-status", "cpulimit -l 50 watch -n 5 git status"],
  ["nice-flock-git-gc", "nice -n 19 flock /tmp/l git gc"],
  ["timeout-nohup-npm-build", "timeout 60 nohup npm run build"],
  ["strace-make", "strace -f make -j4"],
  ["cpulimit-watch-cargo-check", "cpulimit -l 50 watch -n 5 cargo check"],
  ["two-local-then-timeout-pytest", "nice -n 19 cpulimit -l 50 timeout 600 pytest tests/"],
  ["taskpolicy-watch-cargo", "taskpolicy -c background watch -n 5 cargo check"],
  ["cpulimit-watch-uptime", "cpulimit -l 50 watch -n 2 uptime"],
  // The tool word is an OPERAND of `grep`, not a command — a chain in front must not change that.
  ["chain-over-grep-mention", "timeout 60 nohup watch -n 5 grep -rn stress-ng notes.md"],
  ["chain-mention-in-echo", "echo 'cpulimit -l 50 watch stress-ng'"],
  ["chain-to-info-flag", "cpulimit -l 50 watch stress-ng --help"],
  // A local wrapper word as a grep OPERAND must not be read as a wrapper.
  ["local-wrapper-word-as-grep-operand", "watch -n 5 grep -rn cpulimit notes.md"],
  ["upper-cpulimit-watch-git-status", "CPULIMIT -l 50 WATCH -n 5 git status"],
  ["upper-strace-make", "STRACE -f MAKE -j4"],
])
  green(`pair22-green-${tag}`, cmd);
// MUST-3 fail-open survives the chain: an opaque word in the wrapper slot, or in the wrapped slot,
// is not resolvable without evaluating shell, so both stay silent.
green("pair22-green-opaque-wrapper-slot", "$WRAP -l 50 watch stress-ng");
green("pair22-green-opaque-wrapped-slot", "cpulimit -l 50 watch $CMD");
// The recursion's bound is `MAX_DEPTH` (6) and it FAILS OPEN, per the module's whole disposition.
// Pinned so a future "unbounded walk" regression is visible as a behaviour change, not a silent one.
red("pair22-red-nested-chain-within-depth-cap", "watch watch watch stress-ng", BLOCK("stress-ng"));
green("pair22-green-nested-chain-past-depth-cap-fails-open",
  "watch watch watch watch watch watch watch watch watch watch stress-ng");

// ── PAIR 18 — a PROJECT-LOCAL path is not the system tool ──────────────────
// The no-false-positive direction of the whole guard: `./stress` is a repo script, and Go's
// x/tools ships one by that name. Both poles are `stress`; only the SPELLING differs.
const p18r = red("pair18-red-bare-word-still-blocks", "stress --cpu 4", BLOCK("stress"));
const p18g = green("pair18-green-relative-path-is-not-the-tool", "./stress --cpu 4");
polesDiffer("pair18-poles-differ", p18r, p18g);
green("pair18-green-relative-help", "./stress --help");
green("pair18-green-scripts-dir", "scripts/stress --cpu 4");
green("pair18-green-bin-dir", "bin/stress -c 2");
red("pair18-red-absolute-system-path-still-blocks", "/usr/bin/stress --cpu 4", BLOCK("stress"));

// ── PAIR 19 — duplicate-slash spellings name the same device ───────────────
const p19r = red("pair19-red-dd-double-slash", "dd if=//dev/zero of=/dev/null", BLOCK("dd"));
const p19g = green("pair19-green-dd-bounded", "dd if=/dev/zero of=out bs=1m count=10");
polesDiffer("pair19-poles-differ", p19r, p19g);
red("pair19-red-cat-double-slash", "cat //dev/zero > /dev/null", BLOCK("cat /dev/zero"));
red("pair19-red-dot-segment", "dd if=/dev/./zero of=/dev/null", BLOCK("dd"));
red("pair19-red-double-slash-sink", "dd if=/dev/zero of=//dev/null", BLOCK("dd"));
red("pair19-red-hash-double-slash", "md5 //dev/zero", BLOCK("md5"));
green("pair19-green-similar-real-path", "cat /dev/zero.bak > out");

// ── PAIR 20 — a huge BOUND is not a long loop unless the step is additive ───
// `while(x<1e12){x=x*2}` reaches the bound in 40 iterations; reporting it is a false positive on
// arithmetic that is not load. Both poles carry the SAME bound, so only the step separates them.
const p20r = red("pair20-red-additive-counter-still-halts", "node -e 'let x=0;while(x<1e12){x+=1}'", BUSY("node -e"));
const p20g = green("pair20-green-doubling-counter-is-not-load", "node -e 'let x=1;while(x<1e12){x=x*2}'");
polesDiffer("pair20-poles-differ", p20r, p20g);
green("pair20-green-python-doubling", "python3 -c 'n=1\nwhile n<10**9: n*=2'");
red("pair20-red-python-additive", "python3 -c 'n=0\nwhile n<10**9: n+=1'", BUSY("python3 -c"));
green("pair20-green-js-for-multiplicative-step", "node -e 'for(let i=1;i<1e12;i*=2){}'");
red("pair20-red-js-for-additive-step", "node -e 'for(let i=0;i<1e12;i++){}'", BUSY("node -e"));
green("pair20-green-sh-for-multiplicative-step", "for ((i=1;i<10000000;i*=2)); do :; done");
red("pair20-red-sh-for-additive-step", "for ((i=0;i<10000000;i++)); do :; done", BUSY("for-loop"));
// A constant-true or time-bound loop never consults the step at all.
red("pair20-red-time-bound-unaffected", "node -e 'const e=Date.now()+9e5;while(Date.now()<e){}'", BUSY("node -e"));

// ── PAIR 12 — test runners and bounded benchmarks are silent ────────────────
for (const c of ["node --test", "pytest", "pytest -q tests/", "cargo nextest run", "hyperfine 'git status'", "npm test", "watch -n 1 uptime"]) {
  green(`pair12-green-${c.replace(/[^A-Za-z0-9]+/g, "-")}`, c);
}

// ── ORDERING + FAIL-OPEN ────────────────────────────────────────────────────
{
  const r = L.classifyCommand("node -e 'for(;;){}'; stress-ng --cpu 1");
  check("order-block-findings-come-first", r.length >= 2 && r[0].severity === "block" && r[1].severity !== "block", summary(r));
}
check("failopen-null", show(L.classifyCommand(null)) === "[]", "");
check("failopen-number", show(L.classifyCommand(42)) === "[]", "");
check("failopen-empty", show(L.classifyCommand("   ")) === "[]", "");
check("failopen-oversized", show(L.classifyCommand("stress-ng " + "x".repeat(300 * 1024))) === "[]", "over the input cap is not parsed");
check("failopen-unterminated-quote", Array.isArray(L.classifyCommand("node -e 'while(true){")), "");
check("failopen-unknown-lang", L.isBusyLoopBody("cobol", "PERFORM FOREVER").busy === false, "");
check("failopen-argv-null", L.classifyArgv(null) === null, "");
check("failopen-argv-nonstring", L.classifyArgv(["node", 5]) === null, "");

// ── classifyArgv + isBusyLoopBody (the backstop's entry points) ─────────────
{
  // EVERY argv assertion below carries the FULL identity — rule_id AND kind AND severity AND
  // matched. The backstop consumes this entry point and routes on all four, so a check that
  // omits one cannot tell a correct finding from one re-tiered or re-attributed underneath it.
  const a = L.classifyArgv(["/usr/bin/stress-ng", "--cpu", "8"]);
  check("argv-red-dedicated-tool-basenamed",
    !!a && a.rule_id === L.RULE_ID && a.kind === "load-tool" && a.severity === "block" && a.matched === "stress-ng", show(a));
  check("argv-green-yes-without-context-is-null", L.classifyArgv(["yes"]) === null, "argv carries no redirect, so yes is not load by itself");
  const y = L.classifyArgv(["yes"], { stdoutDiscard: true });
  check("argv-red-yes-with-discard-context",
    !!y && y.rule_id === L.RULE_ID && y.kind === "load-tool" && y.severity === "block" && y.matched === "yes", show(y));
  const n = L.classifyArgv(["node", "-e", "while(true){}"]);
  check("argv-red-node-busy",
    !!n && n.rule_id === L.RULE_ID && n.kind === "busy-loop" && n.severity === "halt-and-report" && n.matched === "node -e", show(n));
  const s = L.classifyArgv(["sh", "-c", "while :; do :; done"]);
  check("argv-red-sh-c-busy",
    !!s && s.rule_id === L.RULE_ID && s.kind === "busy-loop" && s.severity === "halt-and-report" && s.matched === "while-loop", show(s));
  // The argv path must inherit the new spellings too — the backstop reads a process table, where a
  // wrapper and its wrapped command arrive as ONE argv.
  const w = L.classifyArgv(["watch", "stress-ng", "--cpu", "1"]);
  check("argv-red-command-running-wrapper",
    !!w && w.rule_id === L.RULE_ID && w.kind === "load-tool" && w.severity === "block" && w.matched === "stress-ng", show(w));
  check("argv-green-project-local-path", L.classifyArgv(["./stress", "--cpu", "4"]) === null, "a repo script is not the system tool");
  const u = L.classifyArgv(["/usr/local/bin/STRESS-NG", "--cpu", "2"]);
  check("argv-red-case-folded",
    !!u && u.rule_id === L.RULE_ID && u.kind === "load-tool" && u.severity === "block" && u.matched === "stress-ng", show(u));
  // The ARGV entry point folds too. It reaches `wrapperNested` through a re-quoted segment
  // (`'WATCH' 'stress-ng'`), so the fold has to survive the quote bytes — measured before the fix:
  // `classifyArgv(["WATCH","stress-ng"])` → null while the lower-case twin blocked.
  for (const [tag, argv] of [
    ["wrapper-upper", ["WATCH", "stress-ng"]],
    ["wrapper-mixed", ["Watch", "stress-ng", "--cpu", "1"]],
    ["find-upper", ["FIND", ".", "-exec", "stress-ng", ";"]],
    ["prefix-upper", ["TIMEOUT", "60", "WATCH", "stress-ng"]],
  ]) {
    const a = L.classifyArgv(argv);
    check(`argv-red-folded-${tag}`,
      !!a && a.rule_id === L.RULE_ID && a.kind === "load-tool" && a.severity === "block" && a.matched === "stress-ng",
      `${show(argv)} → ${show(a)}`);
  }
  check("argv-red-folded-table-entry", (L.classifyArgv(["burnP5"]) || {}).matched === "burnp5",
    show(L.classifyArgv(["burnP5"])));
  check("argv-green-folded-wrapper-over-benign", L.classifyArgv(["WATCH", "-n", "5", "git", "status"]) === null,
    "a folded wrapper must not make the command it runs load");
  // PAIR 22 at the ARGV boundary. The process-table backstop sees the WHOLE chain as one argv, so
  // the local→shared rewrite has to survive the re-quoted segment exactly as the fold does.
  // Measured before the fix: `classifyArgv(["cpulimit","-l","50","watch","stress-ng"])` → null.
  for (const [tag, argv] of [
    ["local-wrapper-chain", ["cpulimit", "-l", "50", "watch", "stress-ng"]],
    ["local-wrapper-chain-upper", ["CPULIMIT", "-l", "50", "WATCH", "stress-ng"]],
    ["taskpolicy-chain", ["taskpolicy", "-c", "background", "watch", "stress-ng"]],
    ["two-local-chain", ["cpulimit", "-l", "50", "taskpolicy", "-c", "background", "watch", "stress-ng"]],
    ["shared-wrapper-first-near-miss", ["nice", "-n", "19", "cpulimit", "-l", "50", "flock", "/tmp/l", "stress-ng"]],
    // The bound: a local wrapper INSIDE the nested wrapper's operands keeps its own option grammar.
    ["local-wrapper-inside-operands", ["watch", "cpulimit", "-l", "50", "stress-ng"]],
  ]) {
    const a = L.classifyArgv(argv);
    check(`argv-red-chain-${tag}`,
      !!a && a.rule_id === L.RULE_ID && a.kind === "load-tool" && a.severity === "block" && a.matched === "stress-ng",
      `${show(argv)} → ${show(a)}`);
  }
  // The argv no-false-positive poles for the same chains.
  for (const [tag, argv] of [
    ["local-wrapper-chain-benign", ["cpulimit", "-l", "50", "watch", "-n", "5", "git", "status"]],
    ["nice-flock-benign", ["nice", "-n", "19", "flock", "/tmp/l", "git", "gc"]],
    ["strace-make-benign", ["strace", "-f", "make", "-j4"]],
    ["local-wrapper-inside-operands-benign", ["watch", "cpulimit", "-l", "50", "git", "status"]],
  ])
    check(`argv-green-chain-${tag}`, L.classifyArgv(argv) === null, `${show(argv)} → ${show(L.classifyArgv(argv))}`);
  check("argv-green-server", L.classifyArgv(["node", "server.js"]) === null, "");
  check("argv-green-repl-bridge", L.classifyArgv(["python3", "-u", "-c", "import sys;exec(eval(sys.stdin.readline()))"]) === null, "");
}
{
  const cases = [
    ["node", "while(Date.now()<e){}", true],
    ["node", "setInterval(()=>{},1000)", false],
    ["python", "while True: pass", true],
    ["python", "while True:\n    time.sleep(1)", false],
    ["perl", "for(;;){}", true],
    ["perl", "while(<STDIN>){print}", false],
    ["ruby", "loop {}", true],
    ["ruby", "loop { sleep 1 }", false],
    ["sh", "while :; do :; done", true],
    ["sh", "while true; do sleep 1; done", false],
  ];
  for (const [lang, body, busy] of cases) {
    const r = L.isBusyLoopBody(lang, body);
    check(`body-${busy ? "red" : "green"}-${lang}-${body.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 30)}`,
      r.busy === busy && (busy ? r.evidence.length > 0 : r.evidence === ""), show(r));
  }
}

// ── HOOK DECISION — override receipt, env channel, sanitization (hermetic) ──
const quiet = (fn) => {
  const w = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    return fn();
  } finally {
    process.stderr.write = w;
  }
};
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "synthetic-load-guard-"));
const decideIn = (dir, command, env) => quiet(() => G.decide({ command, cwd: dir, env: env || {}, extraRoots: () => [] }));
const receiptAt = (dir) => path.join(dir, G.RECEIPT_REL);
const writeReceipt = (dir, body) => {
  fs.mkdirSync(path.dirname(receiptAt(dir)), { recursive: true });
  fs.writeFileSync(receiptAt(dir), body);
};
const tmpDirs = [];
{
  const d = mk();
  tmpDirs.push(d);
  const noOverride = decideIn(d, "stress-ng --cpu 8 --timeout 60");
  check("hook-red-block-without-override", !!noOverride && noOverride.severity === "block", show(noOverride && noOverride.severity));
  const rendered = noOverride ? quiet(() => instructAndWait(noOverride)) : null;
  // Every payload dereference is null-safe: a mutation that silences or re-tiers the hook must
  // produce a NAMED red here, never a TypeError that aborts the runner and skips later cases.
  check("hook-red-block-renders-exit-2-deny",
    !!rendered && rendered.exitCode === 2 && rendered.json?.hookSpecificOutput?.permissionDecision === "deny",
    show(rendered && rendered.json));
  const denyReason = String(rendered?.json?.hookSpecificOutput?.permissionDecisionReason ?? "");
  check("hook-red-block-names-rule-and-receipt",
    denyReason.includes("ci-cost-discipline/MUST-7") && denyReason.includes(G.RECEIPT_REL),
    "the block must name the rule and state the escape");
  check("hook-red-block-six-fields",
    !!noOverride && ["what_happened", "why", "agent_must_wait", "user_summary"].every((k) => typeof noOverride[k] === "string" && noOverride[k]) &&
      Array.isArray(noOverride.agent_must_report) && noOverride.agent_must_report.length > 0,
    "hook-output-discipline MUST-1");

  writeReceipt(d, "operator asked for a 60s stress-ng calibration run on an idle box\n");
  const honoured = decideIn(d, "stress-ng --cpu 8 --timeout 60");
  check("hook-green-receipt-with-reason-downgrades-to-advisory", !!honoured && honoured.severity === "advisory", show(honoured && honoured.severity));
  check("hook-green-receipt-reason-is-RECORDED",
    !!honoured && honoured.what_happened.includes("Override HONOURED") && honoured.what_happened.includes("calibration run"),
    show(honoured && honoured.what_happened));
  check("hook-green-receipt-is-CONSUMED", !fs.existsSync(receiptAt(d)), "a one-shot receipt must be deleted as it is honoured");
  check("hook-poles-differ-block-vs-override", (noOverride && noOverride.severity) !== (honoured && honoured.severity), "");
  const next = decideIn(d, "stress-ng --cpu 8 --timeout 60");
  check("hook-red-next-call-after-consumption-blocks-again", !!next && next.severity === "block", show(next && next.severity));
}
{
  const d = mk();
  tmpDirs.push(d);
  writeReceipt(d, "   \n");
  const r = decideIn(d, "yes > /dev/null");
  check("hook-red-empty-receipt-is-NOT-an-override", !!r && r.severity === "block", show(r && r.severity));
  check("hook-red-empty-receipt-is-left-in-place", fs.existsSync(receiptAt(d)), "an empty receipt is not honoured, so it is not consumed");
}
{
  const d = mk();
  tmpDirs.push(d);
  const envOn = decideIn(d, "openssl speed", { COC_ALLOW_SYNTHETIC_LOAD: "1" });
  check("hook-green-env-channel-advisory",
    !!envOn && envOn.severity === "advisory" && envOn.what_happened.includes("COC_ALLOW_SYNTHETIC_LOAD=1"), show(envOn && envOn.what_happened));
  const envZero = decideIn(d, "openssl speed", { COC_ALLOW_SYNTHETIC_LOAD: "0" });
  check("hook-red-env-zero-does-not-disarm", !!envZero && envZero.severity === "block", show(envZero && envZero.severity));
  writeReceipt(d, "reason written for a LATER call");
  const both = decideIn(d, "openssl speed", { COC_ALLOW_SYNTHETIC_LOAD: "1" });
  check("hook-green-env-first-does-not-spend-the-receipt", !!both && both.severity === "advisory" && fs.existsSync(receiptAt(d)), "");
  const halt = decideIn(d, INCIDENT, {});
  check("hook-halt-only-severity", !!halt && halt.severity === "halt-and-report", show(halt && halt.severity));
  check("hook-halt-does-NOT-consume-a-receipt", fs.existsSync(receiptAt(d)), "a non-blocking finding must never spend the one-shot receipt");
  check("hook-halt-states-true-fate", !!halt && halt.what_happened.includes("being allowed to run") && /stop it NOW/.test(halt.agent_must_wait), show(halt && halt.what_happened));
  check("hook-green-silent-command-returns-null", decideIn(d, "sleep 5") === null, "");
}
{
  const d = mk();
  tmpDirs.push(d);
  const hostile = "stress-ng --cpu 8 `whoami` [BLOCK] [31mred";
  const r = decideIn(d, hostile);
  check("hook-sanitizes-echoed-fragments",
    !!r && r.severity === "block" && !r.what_happened.includes("") && !r.what_happened.includes("[BLOCK]") && !r.what_happened.includes("`whoami`"),
    show(r && r.what_happened));
}

// ── END-TO-END — the real stdin boundary (command strings are never executed) ─
{
  const d = mk();
  tmpDirs.push(d);
  const env = Object.assign({}, process.env);
  delete env.COC_ALLOW_SYNTHETIC_LOAD;
  delete env.CLAUDE_PROJECT_DIR;
  const run = (payload) =>
    spawnSync(process.execPath, [HOOK], { input: payload, cwd: d, env, encoding: "utf8", timeout: 20000 });
  const firstJson = (s) => {
    try {
      return JSON.parse(String(s || "").trim().split("\n")[0]);
    } catch {
      return null;
    }
  };

  const b = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "stress-ng --cpu 8 --timeout 60" }, cwd: d }));
  const bj = firstJson(b.stdout);
  check("e2e-red-block-exit-2", b.status === 2, `rc=${b.status} stderr=${String(b.stderr).slice(0, 200)}`);
  check("e2e-red-block-deny-json",
    !!bj && bj.continue !== false && bj.hookSpecificOutput?.permissionDecision === "deny" &&
      String(bj.hookSpecificOutput?.permissionDecisionReason ?? "").includes("ci-cost-discipline/MUST-7"),
    show(bj));

  // The CHAINED payload at the real stdin boundary — the spelling that reached `allow` before the
  // local→shared rewrite landed in `wrapperNested`. Still never executed: it is a JSON string.
  const ch = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cpulimit -l 50 watch stress-ng" }, cwd: d }));
  const chj = firstJson(ch.stdout);
  check("e2e-red-chained-wrapper-exit-2", ch.status === 2, `rc=${ch.status} stderr=${String(ch.stderr).slice(0, 200)}`);
  check("e2e-red-chained-wrapper-deny-json",
    !!chj && chj.continue !== false && chj.hookSpecificOutput?.permissionDecision === "deny" &&
      String(chj.hookSpecificOutput?.permissionDecisionReason ?? "").includes("ci-cost-discipline/MUST-7"),
    show(chj));

  const c2 = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "Stress-NG --cpu 8" }, cwd: d }));
  check("e2e-red-mixed-case-exit-2", c2.status === 2, `rc=${c2.status} stderr=${String(c2.stderr).slice(0, 200)}`);

  // The chain's no-false-positive pole at the SAME boundary: ordinary instructed work must pass.
  const cg = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "cpulimit -l 50 watch -n 5 git status" }, cwd: d }));
  check("e2e-green-chained-wrapper-benign-exit-0",
    cg.status === 0 && String(cg.stdout).trim() === '{"continue":true}', `rc=${cg.status} out=${cg.stdout}`);

  const s = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "sleep 5" }, cwd: d }));
  check("e2e-green-silent-exit-0-continue", s.status === 0 && String(s.stdout).trim() === '{"continue":true}', `rc=${s.status} out=${s.stdout}`);

  const h = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: INCIDENT }, cwd: d }));
  const hj = firstJson(h.stdout);
  check("e2e-halt-exit-0-with-context",
    h.status === 0 && !!hj && hj.continue === true && /busy-loop/.test(String(hj.hookSpecificOutput?.additionalContext ?? "")),
    `rc=${h.status} out=${String(h.stdout).slice(0, 200)}`);

  const bad = run("not json at all");
  check("e2e-failopen-malformed-stdin", bad.status === 0 && String(bad.stdout).trim() === '{"continue":true}', `rc=${bad.status} out=${bad.stdout}`);

  const gem = run(JSON.stringify({ tool_name: "run_shell_command", hook_event_name: "BeforeTool", tool_input: { command: "yes > /dev/null" }, cwd: d }));
  check("e2e-red-not-gated-on-cc-tool-or-event-names", gem.status === 2, `rc=${gem.status}`);
}

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });

process.stdout.write(`synthetic-load-guard fixtures: ${pass} pass, ${failures.length} fail\n`);
if (failures.length) {
  for (const f of failures) process.stderr.write(`  FAIL ${f}\n`);
  process.exit(1);
}
process.exit(0);
