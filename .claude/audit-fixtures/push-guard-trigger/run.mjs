#!/usr/bin/env node
/**
 * Structural fixtures for `loom-doctor.mjs::classifyPushGuardTrigger` — the
 * detector for the pre-push TRIGGER's installation state.
 *
 * WHAT A GREEN HERE SHOWS: that the classifier's three states are decided
 * correctly from a state descriptor, that UNKNOWN is never folded into ABSENT
 * or INSTALLED, and that the state→status table is the one the report renders.
 *
 * WHAT A GREEN HERE DOES **NOT** SHOW, stated so it is not read as more:
 *   - that the tracked trigger `.githooks/pre-push` is INSTALLED anywhere. It
 *     is deliberately inert; nothing activates it.
 *   - that the GATHERER reads git correctly. These cases start from a
 *     descriptor, so `gatherPushGuardTriggerState` is NOT under test here; its
 *     git-resolution behaviour is exercised by the real `loom doctor` run and
 *     by `loom-doctor.test.mjs` seams.
 *   - that a real hook BEHAVES. `triggerDelegates` is a content match.
 *
 * BIPOLAR BY CONSTRUCTION (`instrument-bipolarity.md` MUST-1/2). Every state
 * gets a FIRING pole (`flag-*`, a non-ok verdict) and a SILENCE pole
 * (`clean-*`, an ok/info verdict). Each RED pole pins a failure IDENTITY — the
 * finding code, the doctor status, AND the state — never a bare "not ok", since
 * a bare non-ok is satisfied by a classifier that condemns every input.
 *
 * THE ANSWER KEY IS A SEPARATE FILE from the input, on purpose: a fixture
 * carrying its own expectation inline can be silently edited into agreement
 * with whatever the code currently does.
 *
 * THE LOAD-BEARING PAIRS, each converging at its most similar point:
 *   clean-installed / flag-absent-not-executable
 *       SAME BYTES but for `triggerExecutable`. A presence-only checker scores
 *       BOTH clean — and measured on git 2.54.0 a non-executable hook is
 *       IGNORED (git prints a `hint:`, the push lands, rc=0), so that checker
 *       would report a gate that is not running.
 *   clean-not-applicable-consumer / flag-absent-no-hook
 *       SAME BYTES but for `delegatePresent`. This is the loom-vs-consumer
 *       split: `loom-doctor.mjs` is `always_include`, so the SAME code runs at
 *       every USE template and downstream clone, where `crit` would be a false
 *       alarm. The pair proves the split is decided on a measured fact.
 *   flag-unknown-dir-unresolved / flag-absent-no-hook
 *       BOTH have `triggerPresent: false`. A classifier that checked presence
 *       before resolution would call the unresolved case ABSENT — folding an
 *       UNKNOWN into a FAILURE, which is the `instrument-discipline.md` MUST-1
 *       violation in the direction that looks responsible.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyPushGuardTrigger,
  pushGuardTriggerStatus,
} from "../../bin/loom-doctor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Finding → the stable identity the answer key is written in. */
const identify = (v) => `${v.code} ${pushGuardTriggerStatus(v.state)} ${v.state}`;

const cases = readdirSync(HERE)
  .filter((f) => /^(flag|clean)-.*\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

// ── harness anti-vacuity fences, BEFORE any case runs ───────────────────────
if (cases.length === 0) {
  console.error("FAIL harness/no-cases: found zero `flag-*.json` / `clean-*.json` fixtures.");
  process.exit(1);
}
const flags = cases.filter((c) => c.startsWith("flag-"));
const cleans = cases.filter((c) => c.startsWith("clean-"));
if (flags.length === 0 || cleans.length === 0) {
  console.error(
    `FAIL harness/not-bipolar: ${flags.length} firing pole(s) and ${cleans.length} silence pole(s); ` +
      "a set missing either pole cannot distinguish a working classifier from a broken one.",
  );
  process.exit(1);
}

let pass = 0;
const red = [];
for (const name of cases) {
  let descriptor;
  let expect;
  try {
    descriptor = JSON.parse(readFileSync(join(HERE, `${name}.json`), "utf8"));
  } catch (err) {
    red.push({ name, expect: "<readable input>", got: `unparseable input: ${err.message}` });
    console.log(`FAIL ${name} — input is not parseable JSON: ${err.message}`);
    continue;
  }
  try {
    // A missing sidecar is a FAIL, never a skip: an absent answer key and a
    // satisfied one are otherwise indistinguishable.
    expect = readFileSync(join(HERE, `${name}.expected`), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .join("\n");
  } catch {
    red.push({ name, expect: "<no .expected sidecar>", got: "" });
    console.log(`FAIL ${name} — no .expected answer key beside it`);
    continue;
  }

  let got;
  try {
    got = identify(classifyPushGuardTrigger(descriptor.state));
  } catch (err) {
    got = `THREW: ${err.message}`;
  }

  // POLE-DIRECTION FENCE. Beyond matching the key, a `flag-` case MUST NOT
  // resolve to an ok/info status and a `clean-` case MUST NOT resolve to
  // warn/crit — otherwise a key edited in the wrong direction would let a
  // mislabelled pole pass, and the bipolarity above would be nominal only.
  const status = got.split(" ")[1];
  const firing = status === "crit" || status === "warn";
  const directionOk = name.startsWith("flag-") ? firing : !firing;

  if (got === expect && directionOk) {
    pass += 1;
    console.log(`PASS ${name} — ${got}`);
  } else if (got !== expect) {
    red.push({ name, expect, got });
    console.log(`FAIL ${name} — expected [${expect}] got [${got}]`);
  } else {
    red.push({ name, expect: `${expect} (pole direction)`, got: `${got} — wrong pole direction` });
    console.log(
      `FAIL ${name} — matches its key but the POLE DIRECTION is wrong: a ${name.split("-")[0]}- ` +
        `case resolved to status '${status}'`,
    );
  }
}

console.log(
  `\npush-guard-trigger fixtures: ${pass} passed, ${red.length} failed (${cases.length} cases; ` +
    `${flags.length} firing poles, ${cleans.length} silence poles).`,
);
if (red.length > 0) {
  console.log("\nRED SET — each line names the case and the identity mismatch:");
  for (const r of red) console.log(`  ${r.name} :: expected [${r.expect}] :: observed [${r.got}]`);
  process.exit(1);
}
process.exit(0);
