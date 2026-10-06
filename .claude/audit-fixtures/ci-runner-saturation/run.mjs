#!/usr/bin/env node
/**
 * Bipolar fixtures for the CI runner-saturation guard.
 *
 * Every case injects its inputs — no network, no clock, no repo — so each pole
 * is exercised deterministically. The one thing these MUST prove is that the
 * predicate can return BOTH verdicts, because a guard that can only ever go
 * silent is indistinguishable from one that is wired correctly and finds nothing
 * (`instrument-bipolarity.md` MUST-1).
 *
 * PAIR 3 is the load-bearing one. It pins the SCOPE defect measured while the
 * guard was being written: an org-wide "any self-hosted runner idle" count read
 * 28 total / 5 idle and said "capacity available", while the pool the job
 * actually requests was 0 of 16 and every run queued. Scoped wrong, the guard is
 * silent through exactly the saturation it exists to catch.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const L = require_("../../hooks/lib/ci-runner-saturation.js");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL ${name}`);
  }
}
function polesDiffer(name, a, b) {
  check(name, a !== b, `both poles returned "${a}" — the pair is VACUOUS and proves nothing`);
}

// ── PAIR 1 — does the guard fire at all, and stay quiet when it should? ──────
const full = { total: 16, idle: 0, saturated: true, applicable: true, pool: "self-hosted,kailash-linux" };
const free = { total: 16, idle: 5, saturated: false, applicable: true, pool: "self-hosted,kailash-linux" };

const red1 = L.assessCiSaturation({ command: "git push", pool: full, blanket: { granted: false } });
const green1 = L.assessCiSaturation({ command: "git push", pool: free, blanket: { granted: false } });
check("pair1-red-saturated-pool-ASKS", red1.verdict === "ask", `got ${red1.verdict}`);
check("pair1-green-capacity-available-is-SILENT", green1.verdict === "silent", `got ${green1.verdict}`);
polesDiffer("pair1-poles-differ", red1.verdict, green1.verdict);

// ── PAIR 2 — INDETERMINATE is silence, and is NOT an all-clear ───────────────
// A probe that could not answer must not spend the operator's attention, but it
// must also not be recorded as "not saturated" — the two are opposite in meaning
// and identical under a truthiness test (`instrument-discipline.md` MUST-1).
const indet = L.assessCiSaturation({ command: "git push", pool: null, blanket: { granted: false } });
check("pair2-indeterminate-is-silent", indet.verdict === "silent", `got ${indet.verdict}`);
check(
  "pair2-indeterminate-is-NAMED-not-conflated-with-capacity",
  indet.detail.why === "probe-indeterminate",
  `an unknown must be distinguishable from a measured all-clear; got why=${indet.detail.why}`,
);
check(
  "pair2-capacity-available-carries-its-OWN-reason",
  green1.detail.why === "capacity-available",
  `got why=${green1.detail.why}`,
);
polesDiffer("pair2-poles-differ", indet.detail.why, green1.detail.why);

// ── PAIR 3 — SCOPE: the pool the job REQUESTS, not the org-wide count ────────
// Fixture mirrors the real measurement: 8 macOS runners (5 idle) + 16 linux
// runners (0 idle). Org-wide reads "5 idle"; the requested pool is saturated.
const ROWS = [
  ...Array.from({ length: 8 }, (_, i) => ({
    busy: i < 3,
    labels: ["self-hosted", "macOS", "ARM64"],
  })),
  ...Array.from({ length: 16 }, () => ({
    busy: true,
    labels: ["self-hosted", "Linux", "X64", "kailash-linux"],
  })),
];
const fakeGh = () => ({
  status: 0,
  stdout: ROWS.map((r) => JSON.stringify(r)).join("\n"),
});

const scoped = L.probePool("acme", [["self-hosted", "kailash-linux"]], fakeGh);
const unscoped = L.probePool("acme", [["self-hosted"]], fakeGh);
check(
  "pair3-red-REQUESTED-pool-is-saturated",
  scoped && scoped.saturated === true && scoped.idle === 0 && scoped.total === 16,
  `the requested pool is 0/16 idle and must read saturated; got ${JSON.stringify(scoped)}`,
);
check(
  "pair3-green-bare-self-hosted-set-sees-the-idle-macs",
  unscoped && unscoped.saturated === false && unscoped.idle > 0,
  `a bare [self-hosted] request CAN be satisfied by the idle macOS runners; got ${JSON.stringify(unscoped)}`,
);
polesDiffer("pair3-poles-differ", String(scoped && scoped.saturated), String(unscoped && unscoped.saturated));
check(
  "pair3-CRITICAL-scoped-verdict-differs-from-org-wide",
  scoped.saturated === true && unscoped.saturated === false,
  "this is the defect the pair exists to pin: org-wide said 'capacity available' while the requested pool was full. If both poles agree, the scoping regressed and the guard is silent on real saturation.",
);

// ── PAIR 4 — a repo with NO self-hosted pool costs nothing ───────────────────
// Load-bearing for cascade: this ships to every downstream BUILD and USE target,
// most of which have no local pool at all and must not pay for the guard.
const hostedOnly = () => ({
  status: 0,
  stdout: [{ busy: false, labels: ["ubuntu-latest"] }].map((r) => JSON.stringify(r)).join("\n"),
});
const noPool = L.probePool("acme", [["self-hosted"]], hostedOnly);
check(
  "pair4-green-no-self-hosted-pool-is-applicable-false",
  noPool && noPool.applicable === false && noPool.saturated === false,
  `got ${JSON.stringify(noPool)}`,
);
const noPoolVerdict = L.assessCiSaturation({ command: "git push", pool: noPool, blanket: { granted: false } });
check(
  "pair4-green-and-therefore-SILENT",
  noPoolVerdict.verdict === "silent" && noPoolVerdict.detail.why === "no-self-hosted-pool",
  `got ${JSON.stringify(noPoolVerdict)}`,
);
check(
  "pair4-red-a-requested-set-with-NO-matching-runner-is-not-saturation",
  (() => {
    // A set nothing matches means the job can never be scheduled — a
    // misconfiguration, not a full pool. Folding it into "0 idle" would send the
    // operator to buy capacity that already exists.
    const r = L.probePool("acme", [["self-hosted", "nonexistent-label"]], fakeGh);
    return r && r.applicable === false;
  })(),
  "an unschedulable set must not masquerade as saturation",
);

// ── PAIR 5 — the blanket: granted, expired, and fail-closed ─────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-authz-fixture-"));
const dir = path.join(root, ".claude", "ci-authz");
fs.mkdirSync(dir, { recursive: true });
const bf = path.join(dir, "github-hosted-allow");
const NOW = Date.parse("2026-08-29T13:00:00Z");

fs.writeFileSync(bf, "batch CI work\nexpires: 2026-08-29T18:00:00Z\n");
const grantedB = L.readBlanket(root, NOW);
fs.writeFileSync(bf, "batch CI work\nexpires: 2026-08-29T09:00:00Z\n");
const expiredB = L.readBlanket(root, NOW);
fs.writeFileSync(bf, "");
const emptyB = L.readBlanket(root, NOW);
fs.writeFileSync(bf, "batch CI work\nexpires: not-a-date\n");
const badB = L.readBlanket(root, NOW);

check("pair5-green-future-expiry-is-granted", grantedB.granted === true, JSON.stringify(grantedB));
check("pair5-red-past-expiry-is-NOT-granted", expiredB.granted === false && expiredB.basis === "expired", JSON.stringify(expiredB));
check("pair5-red-empty-file-is-NOT-a-grant", emptyB.granted === false, "a stray touch must not authorize minute-spend");
check(
  "pair5-red-unparseable-expiry-FAILS-CLOSED",
  badB.granted === false && badB.basis === "expires-unparseable",
  "an operator who tried to bound the grant and mistyped it must not receive an unbounded one",
);
polesDiffer("pair5-poles-differ", String(grantedB.granted), String(expiredB.granted));
check(
  "pair5-granted-blanket-SILENCES-a-saturated-pool",
  L.assessCiSaturation({ command: "git push", pool: full, blanket: grantedB }).verdict === "silent",
  "a live grant is the whole point of the blanket",
);
check(
  "pair5-EXPIRED-blanket-does-NOT-silence",
  L.assessCiSaturation({ command: "git push", pool: full, blanket: expiredB }).verdict === "ask",
  "an expired grant must stop working, or 'session + expiry' is decoration",
);
fs.rmSync(root, { recursive: true, force: true });

// ── PAIR 6 — command discrimination ─────────────────────────────────────────
check("pair6-red-push-triggers-ci", L.triggersCi("git push") === true, "");
check("pair6-green-status-does-not", L.triggersCi("git status") === false, "");
check("pair6-green-commit-does-not", L.triggersCi('git commit -m "x"') === false, "a commit starts no workflow");
check("pair6-green-dry-run-push-does-not", L.triggersCi("git push --dry-run") === false, "a dry-run push starts no run");
check("pair6-red-push-survives-shell-grouping", L.triggersCi("(git push origin main)") === true, "a pair of parentheses must not be a bypass");
polesDiffer("pair6-poles-differ", String(L.triggersCi("git push")), String(L.triggersCi("git status")));

// ── PAIR 7 — a MALFORMED expiry LINE fails CLOSED, not open ─────────────────
// PAIR 5's unparseable pole is `expires: not-a-date` — a SINGLE TOKEN, which
// matched the old `(\S+)` shape and so reached `Date.parse`. Both poles of that
// pair therefore sat on the SAME side of the branch this pair exercises: a value
// CONTAINING WHITESPACE did not match the regex at all, fell to the `else` arm,
// and was GRANTED for 8h from mtime. The two spellings below are the ordinary
// ones an operator actually types.
const root7 = fs.mkdtempSync(path.join(os.tmpdir(), "ci-authz-ws-"));
const dir7 = path.join(root7, ".claude", "ci-authz");
fs.mkdirSync(dir7, { recursive: true });
const bf7 = path.join(dir7, "github-hosted-allow");
const NOW7 = Date.parse("2026-08-29T13:00:00Z");

fs.writeFileSync(bf7, "batch CI work\nexpires: 2026-08-30T06:00:00Z  # end of session\n");
const commentB = L.readBlanket(root7, NOW7);
fs.writeFileSync(bf7, "batch CI work\nexpires: 2026-08-30 06:00:00Z\n");
const spaceB = L.readBlanket(root7, NOW7);
fs.writeFileSync(bf7, "batch CI work\nexpires:\n");
const emptyValueB = L.readBlanket(root7, NOW7);

check(
  "pair7-red-trailing-comment-expiry-FAILS-CLOSED",
  commentB.granted === false && commentB.basis === "expires-unparseable",
  `a value Date.parse cannot read must fail CLOSED, and must be NAMED as unparseable rather than ` +
    `silently taking the 8h mtime default; got ${JSON.stringify(commentB)}`,
);
check(
  "pair7-green-space-separated-expiry-is-HONOURED-as-explicit",
  spaceB.granted === true &&
    spaceB.basis === "explicit-expires" &&
    spaceB.expiresAt === 1788069600000,
  `the operator DID bound this grant (space instead of 'T' is an ordinary spelling Date.parse ` +
    `reads); it must be honoured at THAT instant, not replaced by the mtime default. ` +
    `basis="default-ttl-from-mtime" here means the regex never matched. Got ${JSON.stringify(spaceB)}`,
);
check(
  "pair7-red-bare-expires-key-with-no-value-FAILS-CLOSED",
  emptyValueB.granted === false && emptyValueB.basis === "expires-unparseable",
  `an operator who typed the key and no value tried to bound the grant; got ${JSON.stringify(emptyValueB)}`,
);
polesDiffer("pair7-poles-differ", commentB.basis, spaceB.basis);
check(
  "pair7-CRITICAL-neither-spelling-reaches-the-mtime-DEFAULT",
  commentB.basis !== "default-ttl-from-mtime" && spaceB.basis !== "default-ttl-from-mtime",
  "this is the defect the pair exists to pin: a whitespace-bearing expiry used to miss the regex " +
    "entirely and be GRANTED for 8h from mtime — fail-OPEN on exactly the input the rule text " +
    "promises refusal for. If either basis is the default, the loose capture regressed.",
);
fs.rmSync(root7, { recursive: true, force: true });

// ── PAIR 8 — label matching is CASE-INSENSITIVE, as GitHub's is ─────────────
// The API returns labels as REGISTERED, and `runs-on` is written by hand, so the
// two disagree in case routinely. An exact-case comparison sends a real request
// down the zero-matching-runner path — which, before PAIR 9's fix, was silence.
const ROWS_MIXED = [
  ...Array.from({ length: 8 }, (_, i) => ({
    busy: i < 3,
    labels: ["Self-Hosted", "macOS", "ARM64"],
  })),
  ...Array.from({ length: 16 }, () => ({
    busy: true,
    labels: ["Self-Hosted", "Linux", "X64", "kailash-linux"],
  })),
];
const fakeGhMixed = () => ({
  status: 0,
  stdout: ROWS_MIXED.map((r) => JSON.stringify(r)).join("\n"),
});

// Workflow spells the labels differently from the registry — both directions.
const WF = [
  "jobs:",
  "  structural:",
  "    runs-on: [self-hosted, Kailash-Linux]",
  "  mac:",
  "    runs-on: [Self-Hosted, macOS]",
].join("\n");
const parsedSets = L.requestedSelfHostedLabelSets(
  "/nonexistent",
  () => ["ci.yml"],
  () => WF,
);
check(
  "pair8-workflow-labels-are-CASEFOLDED-at-the-parse-boundary",
  JSON.stringify(parsedSets) ===
    JSON.stringify([
      ["self-hosted", "kailash-linux"],
      ["self-hosted", "macos"],
    ]),
  `both sides must fold to one case or the comparison disagrees with GitHub's scheduler; ` +
    `got ${JSON.stringify(parsedSets)}`,
);

const mixedRed = L.probePool("acme", parsedSets, fakeGhMixed);
const mixedGreen = L.probePool("acme", [["Self-Hosted", "macOS"]], fakeGhMixed);
check(
  "pair8-red-case-mismatched-request-still-reads-SATURATED",
  mixedRed &&
    mixedRed.applicable === true &&
    mixedRed.saturated === true &&
    mixedRed.pool === "self-hosted,kailash-linux" &&
    mixedRed.total === 16,
  `\`runs-on: [self-hosted, Kailash-Linux]\` against runners registered \`Self-Hosted\`/` +
    `\`kailash-linux\` SCHEDULES on GitHub, so it must read as the saturated 0/16 pool — not as ` +
    `unmatched. applicable:false here is the case-sensitivity defect. Got ${JSON.stringify(mixedRed)}`,
);
check(
  "pair8-green-case-mismatched-request-with-capacity-is-NOT-saturated",
  mixedGreen &&
    mixedGreen.applicable === true &&
    mixedGreen.saturated === false &&
    mixedGreen.idle === 5,
  `the idle macOS runners must still be seen through a case mismatch; got ${JSON.stringify(mixedGreen)}`,
);
polesDiffer(
  "pair8-poles-differ",
  String(mixedRed && mixedRed.saturated),
  String(mixedGreen && mixedGreen.saturated),
);
check(
  "pair8-CRITICAL-case-mismatch-does-NOT-collapse-to-inapplicable",
  mixedRed.applicable === true && mixedGreen.applicable === true,
  "this is the defect the pair exists to pin: exact-case `includes` matched zero runners, which " +
    "routed a real request to `unschedulable` and (pre-PAIR-9) to silence — the guard went quiet " +
    "on precisely the saturation it exists to catch, reached by a spelling GitHub accepts.",
);

// ── PAIR 9 — UNSCHEDULABLE is a NAMED state, not silence ───────────────────
// Three distinct facts used to return the byte-identical `{applicable:false,
// pool:null}`: the org runs no self-hosted pool; this repo requests no
// self-hosted set; every requested set matches zero runners. Collapsing them is
// what made PAIR 8's defect INVISIBLE rather than merely wrong.
const unsched = L.probePool("acme", [["self-hosted", "nonexistent-label"]], fakeGh);
const noRunners = L.probePool("acme", [["self-hosted"]], hostedOnly);
const noRequest = L.probePool("acme", [], fakeGh);

check(
  "pair9-red-unschedulable-carries-its-OWN-reason-AND-names-the-set",
  unsched &&
    unsched.applicable === false &&
    unsched.reason === "unschedulable" &&
    unsched.pool === "self-hosted,nonexistent-label",
  `the computed \`unschedulable\` state must LEAVE the loop — a bare \`continue\` discards it and ` +
    `the caller cannot tell it from silence; got ${JSON.stringify(unsched)}`,
);
check(
  "pair9-green-no-self-hosted-runners-carries-a-DIFFERENT-reason",
  noRunners && noRunners.applicable === false && noRunners.reason === "no-self-hosted-runners",
  `got ${JSON.stringify(noRunners)}`,
);
check(
  "pair9-green-no-requested-set-carries-a-THIRD-reason",
  noRequest && noRequest.applicable === false && noRequest.reason === "no-requested-set",
  `got ${JSON.stringify(noRequest)}`,
);
check(
  "pair9-CRITICAL-three-inapplicable-states-are-PAIRWISE-DISTINCT",
  new Set([unsched.reason, noRunners.reason, noRequest.reason]).size === 3,
  "this is the defect the pair exists to pin: all three returned an identical silent verdict, so " +
    "no caller — and no operator — could tell a misconfigured label from a repo the guard simply " +
    "does not apply to.",
);

const unschedVerdict = L.assessCiSaturation({
  command: "git push",
  pool: unsched,
  blanket: { granted: false },
});
const noRunnersVerdict = L.assessCiSaturation({
  command: "git push",
  pool: noRunners,
  blanket: { granted: false },
});
check(
  "pair9-red-unschedulable-SURFACES-as-notify-not-silence",
  unschedVerdict.verdict === "notify" &&
    unschedVerdict.detail.why === "unschedulable" &&
    unschedVerdict.detail.pool === "self-hosted,nonexistent-label",
  `got ${JSON.stringify(unschedVerdict)}`,
);
check(
  "pair9-green-no-self-hosted-pool-STAYS-silent",
  noRunnersVerdict.verdict === "silent" && noRunnersVerdict.detail.why === "no-self-hosted-pool",
  `a repo with no local pool must still cost nothing — the notify arm must not widen into it; ` +
    `got ${JSON.stringify(noRunnersVerdict)}`,
);
polesDiffer("pair9-poles-differ", unschedVerdict.verdict, noRunnersVerdict.verdict);
check(
  "pair9-notify-is-NOT-ask-so-the-push-is-never-gated-on-a-misconfiguration",
  unschedVerdict.verdict !== "ask",
  "an unschedulable set is a misconfiguration to report, not a pool-spend choice to authorize; " +
    "raising it to `ask` would make the guard refuse-shaped on a fail-open surface",
);

console.log(`ci-runner-saturation fixtures: ${pass} pass, ${failures.length} fail`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
