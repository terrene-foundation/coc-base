#!/usr/bin/env node
/*
 * arm-coverage — a positive control per ARM, not per MATCHER.
 *
 * WHY THIS EXISTS (loom, 2026-09-01)
 * ----------------------------------
 * Six of seven defects found in one branch review shared ONE shape: a positive
 * control proved the matcher FIRES; it never proved the matcher COVERS.
 *
 * The measured instance. `wip-discipline/run.mjs` pinned the claim "no bare
 * append sink remains under `.claude/hooks/`" with `/\bfs\.appendFileSync\s*\(/`,
 * under a control asserting that regex matches `fs.appendFileSync(`. The control
 * was TRUE. The claim was FALSE: the live violator was
 * `await fs.promises.appendFile(...)`, which that regex cannot match. Both poles
 * on one tree — `true` on the control, `false` on the live code — and the case
 * `pair20-scope-claim-holds-no-bare-append-sink-remains` asserted the claim held
 * WHILE IT WAS FALSE. `evidence-first-claims.md` MUST-6 exactly: a green
 * generalised past the class its instrument could observe, with the control
 * making it look VERIFIED.
 *
 * The repair was to widen the matcher and to write, in prose, "every widened arm
 * must be shown to fire; an arm never demonstrated to fire carries no information
 * when it returns empty." Prose is a habit. This module makes it MECHANICAL: an
 * arm is not a regex branch the author remembers to control, it is a DECLARED
 * ROW that must produce a firing before the instrument's silence may be read.
 *
 * THE CONTRACT
 * ------------
 * `instrument-discipline.md` MUST-3(a): an instrument never shown to fire HERE
 * is BLOCKED as evidence, however sound its logic. An instrument built from N
 * arms has N places to be silently broken, so it owes N firings, not one. A
 * composite that fires on one spelling licenses nothing about the others — that
 * is the whole defect above.
 *
 * WHAT THIS DOES *NOT* CLAIM, stated so no caller over-reads a green.
 *   - It proves each DECLARED arm can fire. It cannot know an arm you never
 *     declared, so it bounds the instrument to the shapes you enumerated and
 *     says nothing about the ones you did not. Widening the instrument without
 *     adding a row here re-opens the exact hole.
 *   - It reads the COMPOSITE probe's verdict, not which internal branch produced
 *     it. That is deliberate: the § Scope-style claims these back are claims
 *     about SHAPES the instrument can observe, not about its branch structure.
 *   - `blind` rows are the over-match half (`instrument-discipline.md` MUST-3(b),
 *     reading the hits rather than the tally). They are OPTIONAL and their
 *     absence is not evidence of no over-match.
 *
 * USING IT
 * --------
 *   import { assertArmsFire } from "../_lib/arm-coverage.mjs";
 *
 *   assertArmsFire(check, {
 *     id: "pair20-scope-matcher",
 *     probe: (sample) => appendShapedSite(sample, 0),
 *     arms: [
 *       { name: "sync", sample: ['fs.appendFileSync(p, l);'],
 *         why: "the spelling the original regex knew" },
 *       { name: "promise", sample: ['await fs.promises.appendFile(p, l);'],
 *         why: "the live violator the original regex could not see" },
 *     ],
 *     blind: [
 *       { name: "truncating-write", sample: ['fs.writeFileSync(p, b);'],
 *         why: "~40 honest atomic writers must stay silent" },
 *     ],
 *   });
 *
 * `check` is the caller's own case emitter, `(name, ok, detail) => void`, so
 * rows land in the suite's existing PASS/FAIL grammar and count toward its
 * `min_cases` floor. Emitting through the caller — rather than printing here —
 * is what lets the helper be tested by passing a COLLECTOR in place of `check`,
 * which is how its own discrimination is proven (see `selfProof` below).
 *
 * Returns `{ dead, overreach, errors, rows }` for callers that want to assert on
 * the outcome programmatically.
 */

/** Render a sample compactly for a failure detail without dumping a whole file. */
function show(sample) {
  const s = Array.isArray(sample) ? sample.join("\\n") : String(sample);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/**
 * Run `probe` and normalise BOTH outcomes that mean "this arm did not fire":
 * a falsy verdict, and a throw. A throwing probe is a DEAD arm, never a crashed
 * suite — a crash is indistinguishable from a real regression, which is the
 * failure mode `_lib/repo-class.mjs` records for this same corpus.
 */
function fire(probe, sample) {
  try {
    return { fired: Boolean(probe(sample)), threw: null };
  } catch (e) {
    return { fired: false, threw: e && e.message ? e.message : String(e) };
  }
}

/**
 * Assert every DECLARED arm of an instrument fires against its own known-positive,
 * and (optionally) that declared non-matching shapes stay silent.
 *
 * Emits, through the caller's `check`:
 *   `<id>-arm-<name>`        one per arm    — MUST fire
 *   `<id>-blind-<name>`      one per blind  — MUST stay silent
 *   `<id>-EVERY-ARM-FIRED`   one aggregate  — names EVERY dead arm at once, and
 *                                             is the row that catches STRUCTURAL
 *                                             misuse (no arms declared, duplicate
 *                                             names, non-callable probe). Without
 *                                             it `arms: []` would emit zero rows
 *                                             and pass in silence — the vacuity
 *                                             this module exists to refuse.
 */
export function assertArmsFire(check, spec) {
  const { id, probe, arms, blind = [] } = spec || {};
  const dead = [];
  const overreach = [];
  const errors = [];
  let rows = 0;

  const emit = (name, ok, detail) => {
    rows += 1;
    check(name, ok, detail);
  };

  if (typeof id !== "string" || !id) errors.push("`id` must be a non-empty string");
  if (typeof probe !== "function") errors.push("`probe` must be a function");
  if (!Array.isArray(arms) || arms.length === 0) {
    errors.push(
      "`arms` must be a NON-EMPTY array — an instrument with no declared arm has " +
        "shown nothing, and a zero-row pass is the vacuity this helper refuses",
    );
  }

  const seen = new Set();
  for (const a of Array.isArray(arms) ? arms : []) {
    if (!a || typeof a.name !== "string" || !a.name) {
      errors.push("every arm needs a non-empty `name`");
      continue;
    }
    if (seen.has(a.name)) errors.push(`duplicate arm name: ${a.name}`);
    seen.add(a.name);
  }
  for (const b of Array.isArray(blind) ? blind : []) {
    if (!b || typeof b.name !== "string" || !b.name) errors.push("every blind row needs a non-empty `name`");
  }

  if (errors.length === 0) {
    for (const a of arms) {
      const r = fire(probe, a.sample);
      if (!r.fired) dead.push(a.name);
      emit(
        `${id}-arm-${a.name}`,
        r.fired,
        r.threw
          ? `arm "${a.name}" THREW on its own known-positive (${r.threw}) — a throwing arm has not been shown to fire; sample: ${show(a.sample)}`
          : `arm "${a.name}" did NOT fire on its own known-positive, so its silence against the real tree carries no information` +
            `${a.why ? ` (${a.why})` : ""}; sample: ${show(a.sample)}`,
      );
    }
    for (const b of blind) {
      const r = fire(probe, b.sample);
      if (r.fired) overreach.push(b.name);
      emit(
        `${id}-blind-${b.name}`,
        !r.fired && !r.threw,
        r.threw
          ? `blind row "${b.name}" THREW (${r.threw}) — a probe that cannot run on this shape has not been shown to stay silent on it; sample: ${show(b.sample)}`
          : `blind row "${b.name}" FIRED on a shape the instrument must not match — the widening over-matches` +
            `${b.why ? ` (${b.why})` : ""}; sample: ${show(b.sample)}`,
      );
    }
  }

  emit(
    `${id}-EVERY-ARM-FIRED`,
    errors.length === 0 && dead.length === 0,
    errors.length
      ? `arm-coverage MISUSE: ${errors.join("; ")}`
      : `DEAD ARM(S): ${JSON.stringify(dead)} — each was declared as a shape this instrument covers and none of them fired against its own known-positive. An arm that cannot fire contributes nothing when it returns empty (instrument-discipline.md MUST-3(a)), so the instrument's silence against the real tree does NOT establish the claim it was cited for.`,
  );

  return { dead, overreach, errors, rows };
}

/**
 * The helper is itself an instrument, so it owes its own firing (MUST-3(a)) —
 * otherwise the module that exists to stop unproven instruments ships as one,
 * one level up. This runs BOTH poles against a collector and returns what a
 * caller must assert on:
 *
 *   RED   — a probe that matches only "alpha" against arms {alpha, beta}:
 *           the `beta` row MUST be false and the aggregate MUST be false naming
 *           `beta`.
 *   GREEN — the SAME arms against a probe that matches both: every row true.
 *
 * The two poles differ only in the probe, so a green pole that also reds (or a
 * red pole that greens) is visible as a VERDICT DIFFERENCE, not as two
 * separately-plausible outcomes (`instrument-bipolarity.md` MUST-1).
 */
export function selfProof() {
  const run = (probe) => {
    const rows = [];
    const collect = (name, ok, detail) => rows.push({ name, ok, detail });
    const result = assertArmsFire(collect, {
      id: "selfproof",
      probe,
      arms: [
        { name: "alpha", sample: "alpha" },
        { name: "beta", sample: "beta" },
      ],
      blind: [{ name: "gamma", sample: "gamma" }],
    });
    return { rows, result, row: (n) => rows.find((r) => r.name === `selfproof-${n}`) };
  };
  return {
    // A matcher that knows ONE of the two declared shapes — the exact defect.
    red: run((s) => s === "alpha"),
    // The same declaration, with the arm repaired.
    green: run((s) => s === "alpha" || s === "beta"),
  };
}
