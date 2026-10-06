/*
 * The git environment every forest-ledger fixture spawn uses. A separate module so the
 * ONE constant the setup calls read can be tested in a child process started with a
 * poisoned GIT_DIR (review-cor-MEDIUM-2) — an in-process test of the builder alone left
 * the constant free to regress, and it did not red when it was restored to the old form.
 *
 * Neutralise operator/CI global+system git config so a throwaway repo cannot inherit
 * init.templateDir / core.hooksPath and run external hooks (journal/0090 security M-2),
 * AND drop the WHOLE inherited GIT_* family, not a named few. Spreading process.env used
 * to carry GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE through, so every setup commit landed
 * in whatever repository the environment named — the inherited-GIT_DIR class the
 * validator's envelope closes, sitting in the suite that proves it. A denylist of names is
 * one variable behind; dropping the prefix is not. Case-insensitive, because environment
 * names are on Windows.
 */
export function hermeticEnv(base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !/^git_/i.test(k)));
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

export const HERMETIC_ENV = hermeticEnv();
