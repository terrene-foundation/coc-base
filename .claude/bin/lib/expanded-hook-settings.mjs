/**
 * expanded-hook-settings — the ONE way tooling reads "which hooks are registered".
 *
 * Since the hook consolidation (one dispatch.js process per event), a
 * consolidated event's settings.json entry is `dispatch.js <Event>` and its
 * detectors live in `.claude/hooks/dispatch-registry.json`. Every tool that
 * reasons about per-hook registrations (event, matcher, script, timeout) must
 * read the EXPANDED view, or it sees one hook called dispatch.js and nothing
 * else — which for a validator is a silent fail-open.
 *
 * The registry library is located relative to the settings file it expands
 * (`<dir of settings.json>/hooks/lib/dispatch-registry.js`), so the same call
 * works in loom, in an emitted consumer tree, and in a test's temp root. A tree
 * without the library has nothing dispatched and is returned unchanged; a
 * MALFORMED registry throws (a validator must not pass over it).
 *
 * Default is the EFFECTIVE view (what the dispatcher would actually run here);
 * pass `{ declared: true }` for every registry row regardless of eligibility.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import hookEngine from "../../hooks/lib/hook-engine.js";

const require_ = createRequire(import.meta.url);

export function registryLibFor(settingsPath) {
  const lib = path.join(path.dirname(path.resolve(settingsPath)), "hooks", "lib", "dispatch-registry.js");
  if (!fs.existsSync(lib)) return null;
  return require_(lib);
}

/** Expand an already-parsed settings object that was read from `settingsPath`. */
export function expandHookSettings(settings, settingsPath, opts = {}) {
  const R = registryLibFor(settingsPath);
  if (!R) return settings;
  const root = path.resolve(path.dirname(path.resolve(settingsPath)), "..");
  return R.expandSettingsObject(settings, root, opts);
}

/** Read + parse + expand `settingsPath`. */
export function readExpandedHookSettings(settingsPath, opts = {}) {
  return expandHookSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")), settingsPath, opts);
}

/**
 * RAW ∪ EXPANDED, per event: the dispatcher entry itself (a script the host
 * runs) AND every detector behind it. For tools that ask "is this script
 * reached by some registration" — where dispatch.js and the detectors are all
 * genuinely reached.
 */
export function unionHookSettings(settings, settingsPath, opts = {}) {
  const expanded = expandHookSettings(settings, settingsPath, opts);
  if (expanded === settings) return settings;
  const hooks = {};
  for (const src of [settings?.hooks || {}, expanded?.hooks || {}]) {
    for (const [ev, groups] of Object.entries(src)) {
      if (!Array.isArray(groups)) continue;
      hooks[ev] = (hooks[ev] || []).concat(groups);
    }
  }
  return { ...settings, hooks };
}

function isNativePolicyLauncher(root, command) {
  const prefix = /^(?:unset NODE_OPTIONS NODE_PATH; exec |)node[ \t]+/.exec(command);
  if (!prefix) return false;
  const tail = /[ \t]+--native-policy[ \t]*$/.exec(command);
  if (!tail) return false;
  const target = command.slice(prefix[0].length, tail.index);
  const legacy = '"$(git rev-parse --show-toplevel)/.claude/hooks/lib/codex-hook-runtime.js"';
  const resolver = `"$(node -e 'const fs=require("node:fs"),path=require("node:path");let p=fs.realpathSync(process.cwd());while(!fs.existsSync(path.join(p,".git"))){const q=path.dirname(p);if(q===p)throw Error("no repository root");p=q;}process.stdout.write(p);')/.claude/hooks/lib/codex-hook-runtime.js"`;
  try {
    const canonical = (file) => path.normalize(fs.realpathSync(file));
    const canonicalRoot = canonical(root);
    const localHook = (file) => {
      const resolved = canonical(path.join(canonicalRoot, ".claude/hooks/lib", file));
      const relative = path.relative(canonicalRoot, resolved);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
          path.resolve(path.dirname(resolved), "../../..") !== canonicalRoot || !fs.statSync(resolved).isFile()) {
        throw new Error("native hook implementation is not an ordinary file owned by this repository");
      }
      return resolved;
    };
    const expected = localHook("codex-hook-runtime.js");
    localHook("codex-native-policy.js");
    if (target === legacy || target === resolver) return true;
    const quoted = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)')$/.exec(target);
    const literal = quoted ? quoted[1] ?? quoted[2] : target;
    if (literal.startsWith("-") || !/^[A-Za-z0-9_./ -]*\.claude\/hooks\/lib\/codex-hook-runtime\.js$/.test(literal) ||
        (quoted === null && /\s/.test(literal))) return false;
    return canonical(path.resolve(canonicalRoot, literal)) === expected;
  } catch {
    return false;
  }
}

/** Native Codex PreToolUse bridge registration, shared by reachability and
 * provenance validators. This proves source registration, not operator trust,
 * deployed state, or payload-semantic equivalence. Unknown inventory is empty.
 */
export function nativeCodexHookNames(root, settings) {
  const found = new Set();
  const registered = (settings?.hooks?.PreToolUse || []).some((group) =>
    group.matcher === "*" && (group.hooks || []).some((hook) =>
      hook.type === "command" && typeof hook.command === "string" &&
      isNativePolicyLauncher(root, hook.command)));
  if (!registered || !["codex-native-policy.js", "codex-hook-runtime.js"].every((file) =>
    fs.existsSync(path.join(root, ".claude/hooks/lib", file)))) return found;
  try {
    const settingsPath = path.join(root, ".claude/settings.json");
    const source = readExpandedHookSettings(settingsPath);
    // These are native names and the bridge's supported CC projections. Read,
    // Glob, Grep, Skill, Task and NotebookEdit are not created by the adapter.
    const names = ["Bash", "Edit", "Write", "Agent", "shell", "shell_command", "exec_command", "unified_exec", "apply_patch", "spawn_agent", "collaborationspawn_agent"];
    for (const group of source?.hooks?.PreToolUse || []) {
      if (!names.some((name) => hookEngine.matcherMatches(group.matcher, name, "PreToolUse")) && !String(group.matcher || "").split(/[|,]/).some((name) => /^mcp__/.test(name.trim()))) continue;
      for (const hook of group.hooks || []) {
        if (hook.type !== "command" || typeof hook.command !== "string") continue;
        const re = /\.claude\/hooks\/([A-Za-z0-9_.-]+\.js)(?![A-Za-z0-9])/g;
        for (const match of hook.command.matchAll(re)) found.add(match[1]);
      }
    }
  } catch {
    // A malformed registry is unknown registration, never additional coverage.
    found.clear();
  }
  return found;
}
