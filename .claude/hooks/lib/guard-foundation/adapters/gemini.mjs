// Guard foundation — Gemini CLI adapter stub (S3). Declares the GAP explicitly.
//
// No Gemini CLI setting has been identified or measured that denies writes to
// specific paths, so this adapter emits NO Gemini configuration (`settings:
// null`) and one gap per protected path. Under Gemini the guard is the OS
// profile the launcher applies (os-profile/*) and nothing else. Replace this
// stub only with keys measured against a real Gemini build — never guessed ones.

export const ADAPTER_KIND = "gemini";

function validate(policy) {
  if (!policy || policy.version !== 1 || !Array.isArray(policy.protected_write)) {
    throw new TypeError("policy must be version 1 with a protected_write array");
  }
}

/** Generate the Gemini declaration for `policy`. Deterministic; `params` unused. */
export function generateGeminiAdapter(policy, params = {}) {
  validate(policy);
  void params;
  const gaps = policy.protected_write.map((entry) => `${entry.id}: GAP — no Gemini-native write deny; OS profile only`);
  if (Array.isArray(policy.network) && policy.network.length) gaps.push("network: GAP — no Gemini-native network policy; not enforced by this adapter");
  return {
    kind: ADAPTER_KIND,
    status: "GAP",
    settings: null,
    gaps,
    declaration: `GAP: the Gemini adapter enforces nothing. Enforcement under Gemini is the OS profile only (${gaps.length} gap(s)).`,
    policySha256: policy.integrity?.sha256 ?? null,
  };
}
