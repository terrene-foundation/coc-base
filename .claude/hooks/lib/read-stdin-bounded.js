"use strict";

// OOM backstop ceiling for the accumulated stdin buffer (security redteam LOW-1).
// 10 MiB — orders of magnitude above any real tool-event payload (the largest is a
// Write tool_input.content); purely a runaway-producer guard, not a functional limit.
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

/**
 * Event-driven, bounded, non-blocking stdin reader for tool-event hooks.
 *
 * WHY THIS EXISTS (#859 sub-issue 1): the previous per-hook form
 * `fs.readFileSync(0, "utf8")` BLOCKS the event loop for the whole read. A
 * blocked loop cannot fire timers, so each hook's mandated `setTimeout`
 * fallback (`cc-artifacts.md` Rule 7) never runs while the read is pending —
 * on an open, never-closing stdin the hook hangs past its own budget and the
 * fallback fleet is defeated. This reader is event-driven
 * (`process.stdin.on('data'|'end')` resolving a Promise, modeled on the
 * canonical `detect-violations.js::readStdin`), so the loop stays live and the
 * hook's outer fallback timer keeps working.
 *
 * Fail-OPEN by contract (`cc-artifacts.md` Rule 7): every non-happy path — no
 * piped stdin (TTY), empty input, JSON parse error, stream error, or the
 * open-no-EOF bounded-timer expiry, OR a buffer exceeding `MAX_STDIN_BYTES` —
 * resolves the passthrough default (`{}` by default) rather than throwing, so a
 * stdin hiccup never hard-blocks the session. The bounded internal timer is what
 * makes the open-no-EOF case resolve instead of hanging; it is deliberately
 * shorter than the calling hook's own outer fallback so the reader hands
 * control back for a graceful passthrough before the outer safety net fires.
 * (That relationship — reader timer < outer fallback — is the invariant; the
 * specific pair is per-hook. The default 2000 sits under the fleet's common
 * 5000 outer net, and a hook that widens one MUST widen the other:
 * `validate-prod-deploy.js` runs 6000 inside 14000.) The
 * `MAX_STDIN_BYTES` ceiling additionally bounds the buffer SIZE (not just the
 * wait), so a never-EOF producer cannot grow it unboundedly inside the window.
 *
 * Callers that must distinguish a FAILED/EMPTY read from a genuine payload (e.g.
 * a fail-closed-when-declared guard) pass `{ fallback: null }`: `null` then
 * signals "no usable payload" distinctly from a real `{}` the caller parsed.
 *
 * `onRawText` (loom#1588 round 2) hands back the bytes that DID arrive, on every
 * settle path including the failed ones. WHY IT EXISTS: distinguishing a failed
 * read is only half of what a GATE needs. `fallback` answers "could I parse
 * this?"; a gate must also answer "what was on the wire?", because the two
 * ceilings here — `maxBytes` and `timeoutMs` — both discard a buffer that
 * usually still CONTAINS the command being adjudicated. Without this, a hook
 * that cannot parse its payload has no text to fall back to and must choose
 * between allowing everything and blocking everything. See
 * `validate-prod-deploy.js` § UNREADABLE STDIN.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2000] bounded wait for EOF on an open,
 *   never-closing stdin. On expiry the promise resolves `fallback`.
 * @param {number} [opts.maxBytes=MAX_STDIN_BYTES] OOM-backstop ceiling on the
 *   accumulated buffer; past it the promise resolves `fallback` (overridable
 *   only to make the backstop testable — production uses the default).
 * @param {*} [opts.fallback={}] value resolved on any non-happy path.
 * @param {(rawText: string) => void} [opts.onRawText] invoked once, at settle,
 *   with the raw accumulated stdin text (`""` if nothing arrived) — including on
 *   the timeout / over-ceiling / parse-error paths where the buffer is otherwise
 *   dropped. Its own throw is swallowed: a caller bug MUST NOT convert this
 *   reader's fail-open contract into a hang.
 * @returns {Promise<*>} the parsed JSON payload, or `fallback`.
 */
function readStdinBounded(opts = {}) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 2000;
  const maxBytes =
    typeof opts.maxBytes === "number" && opts.maxBytes > 0
      ? opts.maxBytes
      : MAX_STDIN_BYTES;
  const fallback = Object.prototype.hasOwnProperty.call(opts, "fallback")
    ? opts.fallback
    : {};
  const onRawText =
    typeof opts.onRawText === "function" ? opts.onRawText : null;

  return new Promise((resolve) => {
    const stdin = process.stdin;
    let settled = false;
    let data = "";
    let timer = null;

    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onRawText) {
        try {
          onRawText(data);
        } catch {
          // A caller-supplied callback MUST NOT be able to break the fail-open
          // contract documented above; swallow and continue to resolve.
          //
          // WHAT THE SWALLOW COSTS, NAMED SO IT IS NOT REDISCOVERED AS A SURPRISE
          // (loom#1588 round 3). A caller that gates on the raw text — today only
          // validate-prod-deploy.js — keeps whatever value it had before the
          // throw, i.e. "" on the first settle. For that hook an empty
          // `rawStdinText` reads as "no deploy token present", so an unreadable
          // DEPLOY would be ALLOWED rather than refused. It is not reachable now:
          // every callback in the fleet is a bare assignment, which cannot throw.
          // The swallow stays because the alternative is worse — an exception here
          // escapes the Promise executor, rejects the read, and converts a
          // fail-open reader into a hang for every hook that uses it. A caller
          // whose callback can genuinely throw must do its own try/catch INSIDE
          // the callback and record the failure, rather than rely on this.
        }
      }
      try {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
        stdin.removeListener("error", onError);
      } catch {
        // best-effort listener cleanup
      }
      resolve(value);
    };

    const onData = (chunk) => {
      data += chunk;
      // OOM backstop (security redteam LOW-1): the timer bounds WAIT, not SIZE — a
      // producer streaming without EOF could grow `data` unboundedly within the
      // window. Past a generous ceiling far above any real tool-event payload,
      // fail-open (resolve fallback); a payload this large is not genuine hook stdin.
      if (data.length > maxBytes) done(fallback);
    };
    const onEnd = () => {
      if (!data || !data.trim()) return done(fallback);
      try {
        done(JSON.parse(data));
      } catch {
        done(fallback);
      }
    };
    const onError = () => done(fallback);

    // No piped stdin (interactive TTY) — nothing to read; fail-open now.
    if (stdin.isTTY) return done(fallback);

    try {
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("error", onError);
    } catch {
      return done(fallback);
    }

    // Bounded-timer for the open-no-EOF case: resolve the passthrough default
    // so the event loop is never held on a stream that never closes. Left REF'd
    // so it is guaranteed to fire even if the stdin handle drops its own ref.
    timer = setTimeout(() => done(fallback), timeoutMs);
  });
}

module.exports = { readStdinBounded };
