// CLEAN fixture — the legitimate per-dev verified_id signing path
// (operator-id.js::resolveIdentity shape): it reads `user.signingkey` and derives
// the fingerprint. NO model / LLM key token appears anywhere, so the
// co-occurrence requirement never fires on it (invariant ii — the check MUST NOT
// false-flag the real signing path).
function resolveIdentity(repoDir) {
  const raw = git(["-C", repoDir, "config", "--get", "user.signingkey"]);
  const signingKey = raw.trim();
  return { verified_id: fingerprintOf(signingKey) };
}
