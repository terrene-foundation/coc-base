/**
 * emit-axes.mjs — the ONE declaration of loom's two emission axes.
 *
 * loom#1501 (L4). Both arrays below previously existed as THREE independent
 * literals apiece, kept aligned only by prose ("SSOT NOTE: … when you touch
 * either array, re-grep `declaredTargets` in emit.mjs"). Prose-enforced SSOT
 * is the shape that drifts, and it had already drifted in two directions at
 * once — measured, not predicted:
 *
 *   emit.mjs::EMIT_LANGS                    ["py","rs","rb","base","prism"]
 *   validate-emit.mjs::VARIANT_LANGS        ["py","rs","rb","base","prism"]
 *   validate-proximity-band.mjs::VALID_LANGS ["py","rs","base"]      ← drifted
 *
 * The third copy rejected `--lang rb` and `--lang prism` outright:
 *
 *   validate-proximity-band.mjs --lang rb → exit 2
 *     "error: --lang must be one of py, rs, base; got 'rb'"
 *   validate-proximity-band.mjs --lang py → exit 0, empty stderr   (control)
 *
 * That is the SAME defect this lane fixed at `emit.mjs --lang` — a declared
 * lane rejected by a validator that derived its valid set from something other
 * than the declaration — reproduced at a sibling surface with no shared callee.
 * `security.md` § Enforcement-Surface Parity mandates the same-PR sweep and
 * names the remedy exactly: ONE shared function, not N synchronised copies.
 * So the copies are retired rather than re-aligned; re-aligning three literals
 * leaves the next lane the identical trap.
 *
 * THE SET IS A DECLARATION, NEVER A DISK PROBE. `.claude/variants/` and this
 * list are not the same set in either direction:
 *
 *   declared-but-absent   `rb` is a declared lane with no overlay directory.
 *                         A lane whose overrides are all inherited is
 *                         legitimate — composition falls through to base.
 *   absent-but-present    `.claude/variants/codex/` and `/gemini/` exist but
 *                         are CLI overlays, not lang lanes. A disk-derived
 *                         check accepts `--lang codex`, which is not a lane.
 *
 * A disk-derived check is therefore wrong in BOTH directions at once: it
 * rejects a real lane and accepts two non-lanes.
 *
 * `base` IS A LANE, NOT A SYNONYM FOR "NO OVERLAY". It has its own overlay
 * (`.claude/variants/base/rules/agents.md`) and its own bytes. Measured on
 * the codex CLI:
 *
 *   emit.mjs --cli codex --lang base --dry-run   →  54143B   "[codex base]"
 *   emit.mjs --cli codex             --dry-run   →  53168B   "[codex]"
 *
 * 975 bytes apart. Any consumer treating `--lang base` as "omit the flag"
 * measures the no-overlay composition while the operator asked for the `base`
 * lane — a valid measurement of the WRONG lane, which is the reading
 * `instrument-discipline.md` MUST-1 forbids. `validate-proximity-band.mjs`
 * did exactly this, inside the gate whose entire job is reporting how close an
 * emission sits to the byte ceiling.
 */

/**
 * The language axis. Order is significant only for error-message stability.
 * @type {readonly string[]}
 */
export const EMIT_LANGS = Object.freeze(["py", "rs", "rb", "base", "prism"]);

/**
 * The CLI axis.
 * @type {readonly string[]}
 */
export const EMIT_CLIS = Object.freeze(["codex", "gemini"]);
