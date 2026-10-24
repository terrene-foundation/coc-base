/**
 * guard-foundation/shell-effects.js — L1 provider: the ORDERED effects a raw
 * shell command WOULD produce.
 *
 * L1 SCOPE (skeleton). The contract is: determine ONLY what is plainly
 * present in the command text, and return `undetermined` — bounded, with the
 * unresolved span named — for everything else. The skeleton recognises a
 * narrow, fully-safe PLAIN command grammar and an executor set; it models no
 * quoting, no redirection, no separators, no flags. Every unrecognised shape
 * SAFE-FAILS to undetermined. The failure direction is deliberate: an
 * over-triggered undetermined costs L3 one conservative branch; a
 * mis-parsed effect would hand L3 a WRONG FACT, which is the one direction
 * no guard layer may ever produce.
 *
 * WHAT IS MODELED (and why exactly this much):
 *   - unknown command name            -> undetermined (NO effect model entry;
 *     an unmapped command is NOT assumed effect-free — "no effects" is a
 *     claim the provider cannot make from absence)
 *   - cat PATH...                     -> read-bytes per path (ordered)
 *   - cp A B                          -> read-bytes(A->process), write-bytes(A->B)
 *   - mv A B                          -> write-bytes(A->B), delete(A)
 *   - rm PATH...                      -> delete per path (ordered)
 *   - EXECUTOR SCRIPT                 -> read-bytes(SCRIPT), load-and-execute(SCRIPT)
 *     carried under a bounded UNDETERMINED verdict: the script body is not
 *     resolved here, so the loaded program's own effects are unknown.
 *     A script/executor NEVER reads as determined.
 *   - dynamic expansion ($(...), backticks, ${...}, <(...), >(...), bare $)
 *     -> bounded undetermined naming the expansion span. Single-quoted spans
 *     are scanned through (a `$` there is literal), so the reason stays true.
 *
 * READ-BYTES vs LOAD-AND-EXECUTE is split per the effect model: an executor
 * yields BOTH effects, in order, because reading a file's bytes and loading
 * them AS CODE are independently policed (effects.js header).
 *
 * ALL EFFECTS ARE PROSPECTIVE. `bytes.basis` is "unknown" throughout the
 * skeleton: established byte counts (stat of a read target, here-string
 * length) are a later-iteration concern and, per the effect model, an unknown
 * byte count does not by itself flip the verdict.
 *
 * Style: CommonJS, zero-dep, pure — no fs, no spawn, no policy.
 */

"use strict";

const {
  EFFECT_KINDS,
  ENDPOINT_KINDS,
  endpoint,
  effect,
  effectList,
} = require("./effects.js");
const {
  determinedEffects,
  undeterminedEffects,
  missingFactReason,
} = require("./contract.js");

/**
 * The PLAIN grammar: single spaces between non-empty tokens drawn from
 * [A-Za-z0-9_./~+=:@,-]. Everything outside it (quotes, tabs, newlines,
 * `|`/`;`/`&`/`>`/`<`/globs, `$`, backticks) is refused before tokenization,
 * so a token in an accepted command can never be a mis-split fragment of a
 * quoted word. Narrow on purpose: the accepted set is exactly the set whose
 * tokenization cannot be wrong.
 */
const PLAIN_COMMAND = /^[A-Za-z0-9_./~+=:@,-]+(?: [A-Za-z0-9_./~+=:@,-]+)*$/;

/** Commands whose operand is a SCRIPT/executor file loaded as code. */
const EXECUTORS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "deno",
  "bun",
  "source",
  ".",
]);

/**
 * Dynamic constructs, checked in order at each position (the `$` entry MUST
 * stay last so `$(` / `${` win). `closer` bounds the reported span.
 */
const DYNAMIC_MARKERS = [
  { token: "$(", closer: ")", name: "command substitution" },
  { token: "`", closer: "`", name: "backtick command substitution" },
  { token: "${", closer: "}", name: "parameter expansion" },
  { token: "<(", closer: ")", name: "process substitution" },
  { token: ">(", closer: ")", name: "process substitution" },
  { token: "$", closer: null, name: "variable expansion" },
];

/**
 * findDynamic — the first dynamic construct outside single quotes.
 * Quote handling is deliberately minimal: toggling on `'` keeps the REASON
 * truthful for the common literal-quote case; escaped constructs are not
 * modelled, and that over-trigger lands on undetermined (the safe direction).
 */
function findDynamic(raw) {
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;
    for (const marker of DYNAMIC_MARKERS) {
      if (!raw.startsWith(marker.token, i)) continue;
      let end;
      if (marker.closer === null) {
        let j = i + 1;
        while (j < raw.length && /[A-Za-z0-9_]/.test(raw[j])) j++;
        end = j > i + 1 ? j : i + 1;
      } else {
        const close = raw.indexOf(marker.closer, i + marker.token.length);
        end = close === -1 ? raw.length : close + 1;
      }
      return { span: raw.slice(i, end), name: marker.name };
    }
  }
  return null;
}

function _readBytes(fromPath, toKind, toValue) {
  return effect(EFFECT_KINDS.READ_BYTES, {
    from: endpoint(ENDPOINT_KINDS.PATH, fromPath),
    to: endpoint(toKind, toValue),
  });
}

function _flagReason(command, name, args, flags) {
  if (flags.length > 0) {
    return `flags not modelled in the L1 skeleton (${flags.join(" ")}): effect semantics of ${name} not statically resolved`;
  }
  if (args.length === 0) {
    return missingFactReason(`${name} operand (no path operand given)`);
  }
  return `${name}: arity not modelled in the L1 skeleton for: ${command}`;
}

/**
 * effectsForShellCommand — THE shell provider.
 *
 * @param {string} rawCommand - the raw command text as the caller would run it
 * @param {object} [ctx] - reserved for later iterations (cwd, expansion
 *   context); ignored by the skeleton and NEVER used to guess a fact.
 * @returns {{verdict: string, effects: Array, reason: string|null, unresolved?: Array}}
 */
function effectsForShellCommand(rawCommand, ctx = {}) {
  void ctx;

  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return undeterminedEffects(missingFactReason("command"), [], []);
  }

  if (!PLAIN_COMMAND.test(rawCommand)) {
    const dynamic = findDynamic(rawCommand);
    if (dynamic) {
      return undeterminedEffects(
        `dynamic expansion not statically resolvable (${dynamic.name}): effects depend on runtime values`,
        [],
        [{ span: dynamic.span, reason: dynamic.name }],
      );
    }
    return undeterminedEffects(
      "shell word structure not parsed in the L1 skeleton (quoting/redirection/separators/flags): effects not statically resolvable",
      [],
      [{ span: rawCommand, reason: "unparsed shell word structure" }],
    );
  }

  const argv = rawCommand.split(" ");
  const name = argv[0];
  const args = argv.slice(1);
  const flags = args.filter((a) => a.startsWith("-"));

  if (EXECUTORS.has(name)) {
    if (args.length === 0 || flags.length > 0) {
      return undeterminedEffects(
        args.length === 0
          ? missingFactReason(`${name} program operand (inline programs / stdin are not statically resolvable)`)
          : `executor ${name} invoked with flags (${flags.join(" ")}): inline program text is not statically resolvable`,
        [],
        [{ span: rawCommand, reason: "executor program text unresolved" }],
      );
    }
    const script = args[0];
    // read-bytes and load-and-execute are SEPARATE ordered effects: reading
    // the script's bytes and loading them AS CODE are independently policed.
    const partial = effectList([
      _readBytes(script, ENDPOINT_KINDS.PROCESS, "process"),
      effect(EFFECT_KINDS.LOAD_AND_EXECUTE, {
        from: endpoint(ENDPOINT_KINDS.PATH, script),
        to: endpoint(ENDPOINT_KINDS.PROCESS, "process"),
      }),
    ]);
    return undeterminedEffects(
      `script body not statically resolved: the loaded program's own effects (${script}) are unknown to L1`,
      partial,
      [{ span: script, reason: "script body unresolved" }],
    );
  }

  if (name === "cat") {
    if (args.length === 0 || flags.length > 0) {
      return undeterminedEffects(_flagReason(rawCommand, name, args, flags), [], [
        { span: rawCommand, reason: "cat operand unresolved" },
      ]);
    }
    return determinedEffects(
      effectList(args.map((p) => _readBytes(p, ENDPOINT_KINDS.PROCESS, "process"))),
    );
  }

  if (name === "cp") {
    if (flags.length > 0 || args.length !== 2) {
      return undeterminedEffects(_flagReason(rawCommand, name, args, flags), [], [
        { span: rawCommand, reason: "cp arity/flags unresolved" },
      ]);
    }
    const [src, dst] = args;
    return determinedEffects(
      effectList([
        _readBytes(src, ENDPOINT_KINDS.PROCESS, "process"),
        effect(EFFECT_KINDS.WRITE_BYTES, {
          from: endpoint(ENDPOINT_KINDS.PATH, src),
          to: endpoint(ENDPOINT_KINDS.PATH, dst),
        }),
      ]),
    );
  }

  if (name === "mv") {
    if (flags.length > 0 || args.length !== 2) {
      return undeterminedEffects(_flagReason(rawCommand, name, args, flags), [], [
        { span: rawCommand, reason: "mv arity/flags unresolved" },
      ]);
    }
    const [src, dst] = args;
    return determinedEffects(
      effectList([
        effect(EFFECT_KINDS.WRITE_BYTES, {
          from: endpoint(ENDPOINT_KINDS.PATH, src),
          to: endpoint(ENDPOINT_KINDS.PATH, dst),
        }),
        effect(EFFECT_KINDS.DELETE, { from: endpoint(ENDPOINT_KINDS.PATH, src) }),
      ]),
    );
  }

  if (name === "rm") {
    if (args.length === 0 || flags.length > 0) {
      return undeterminedEffects(_flagReason(rawCommand, name, args, flags), [], [
        { span: rawCommand, reason: "rm operand unresolved" },
      ]);
    }
    return determinedEffects(
      effectList(args.map((p) => effect(EFFECT_KINDS.DELETE, { from: endpoint(ENDPOINT_KINDS.PATH, p) }))),
    );
  }

  return undeterminedEffects(
    `no effect model entry for command "${name}": an unmapped command is not assumed effect-free`,
    [],
    [{ span: name, reason: "unmodeled command" }],
  );
}

module.exports = {
  PLAIN_COMMAND,
  EXECUTORS,
  DYNAMIC_MARKERS,
  findDynamic,
  effectsForShellCommand,
};
