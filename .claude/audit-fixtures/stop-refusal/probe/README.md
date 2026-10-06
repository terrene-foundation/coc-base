# The live `Stop`-hook contract probe

This directory is the **promoted** form of the throwaway `.probe-artifact/` scaffolding that
produced the measurement `../run.mjs` cites. It is committed so the result is **reproducible**
rather than merely asserted.

## Why it is NOT in CI, stated plainly

`../run.mjs` pins the **JSON shapes our code emits**. It does **not** run this probe, and no CI job
does either. Three reasons, none of them convenience:

1. **Not hermetic.** It needs a live model and network.
2. **Not deterministic.** Its verdict is a *model output* (`PROBE_CONTINUED` vs `BASELINE_OK`), not
   a value a gate can compare.
3. **CI is LLM-free by design.** The loom↔csq boundary keeps it that way; a fixture that quietly
   imported an LLM dependency into the audit gate would breach it.

So the evidence is split, and the split is the honest part: **the host contract is evidenced by
this probe; the emitted shape is evidenced by `../run.mjs`. Neither stands in for the other.** A
green audit-fixture run is *never* evidence that the host still behaves as measured here.

## Re-running it by hand

```bash
mkdir -p /tmp/stophook-probe/.claude/hooks
cp probe.js            /tmp/stophook-probe/.claude/hooks/probe.js
cp probe-settings.json /tmp/stophook-probe/.claude/settings.json
rm -f /tmp/stophook-probe/fire.log      # the probe's own fire counter

cd /tmp/stophook-probe
PROBE_MODE=none     claude -p 'reply with exactly BASELINE_OK'   # control
PROBE_MODE=decision claude -p 'reply with exactly BASELINE_OK'   # decision:"block"
PROBE_MODE=continue claude -p 'reply with exactly BASELINE_OK'   # continue:false
cat /tmp/stophook-probe/fire.log
```

Read `fire.log` for the fire count and the `stop_hook_active` value per invocation; read the
model's reply for which arm actually redirected it.

**The experiment is bounded.** `probe.js` refuses **at most once** — it returns `{}` immediately
whenever `stop_hook_active === true` — so a wrong hypothesis costs one turn, not the host's full
eight-block override.

## The result

`./measurement-2026-08-20.json` records all three arms, the observed `Stop` payload key set, the
documentation that corroborates it, and — the section worth reading — **what the probe does NOT
establish**. `SessionEnd` and `PreCompact` were never probed, which is why
`instruct-and-wait.js::assertRefusalShape` *throws* for those events instead of assuming the `Stop`
result carries over.
