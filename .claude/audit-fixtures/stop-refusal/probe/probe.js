// The LIVE host-contract probe behind the opt-in `Stop` hand-back refusal.
//
// PROMOTED VERBATIM from the throwaway `.probe-artifact/` scaffolding that produced the 2026-08-20
// measurement recorded in `./measurement-2026-08-20.json`. It is committed so the measurement is
// REPRODUCIBLE rather than merely asserted — but it is NOT run by `../run.mjs` and NOT run in CI:
// it needs a live model and network, its verdict is a model output rather than a deterministic
// value, and the loom↔csq boundary keeps CI LLM-free. See `./README.md` to re-run it by hand.
//
// Isolated Stop-hook contract probe. Throwaway sandbox — nothing to do with loom.
// Answers, by measurement: does `decision:"block"` force continuation? does
// `continue:false` halt? is `stop_hook_active` set on re-invocation?
const fs = require("fs");
const LOG = "/tmp/stophook-probe/fire.log";

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (e) { /* no stdin */ }
let inp = {};
try { inp = JSON.parse(raw); } catch (e) { /* non-JSON */ }

const prior = fs.existsSync(LOG)
  ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).length
  : 0;
fs.appendFileSync(
  LOG,
  JSON.stringify({
    fire: prior + 1,
    mode: process.env.PROBE_MODE || "none",
    stop_hook_active: inp.stop_hook_active,
    input_keys: Object.keys(inp).sort(),
  }) + "\n",
);

// BOUND THE EXPERIMENT. The harness overrides only after 8 consecutive blocks;
// this probe refuses AT MOST ONCE, so a wrong hypothesis cannot cost 8 turns.
if (inp.stop_hook_active === true) {
  console.log(JSON.stringify({}));
  process.exit(0);
}

const mode = process.env.PROBE_MODE || "none";
if (mode === "decision") {
  console.log(JSON.stringify({
    decision: "block",
    reason: "PROBE_INSTRUCTION: reply with exactly the token PROBE_CONTINUED and nothing else.",
  }));
} else if (mode === "continue") {
  console.log(JSON.stringify({
    continue: false,
    stopReason: "PROBE: continue-false fired.",
  }));
} else {
  console.log(JSON.stringify({}));
}
process.exit(0);
