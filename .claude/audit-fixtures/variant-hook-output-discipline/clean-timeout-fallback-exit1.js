// FIXTURE (clean) — the ONE legitimate raw-exit path, named explicitly in
// hook-output-discipline.md § MUST NOT: the cc-artifacts.md Rule 7 timeout
// fallback, which MUST emit {continue: true} first. This is the live shape of
// variants/rs/hooks/build-cache-guard.js and build-cache-gc.js; a check that
// flagged it would false-positive on compliant rs overlays. Expects: PASS.
const TIMEOUT_MS = 9000;
const _timeout = setTimeout(() => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(1);
}, TIMEOUT_MS);

process.stdin.on("end", () => {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
});
