"use strict";
const fs = require("fs");
const path = require("path");

function physicalPath(value, base) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  try {
    if (!path.isAbsolute(value) && (typeof base !== "string" || !path.isAbsolute(base))) return null;
    const raw = path.isAbsolute(value) ? value : base + path.sep + value;
    return fs.realpathSync.native(raw);
  } catch { return null; }
}

function gitTargetContextIsUnknown(g) {
  if (!g || g.unresolvable === "command" || g.unresolvable === "subcommand") return true;
  const context = g.targetContext;
  if (!context) return g.unresolvable === "dir";
  if (!Array.isArray(context.unknown) || context.unknown.length || !Array.isArray(context.chdir)) return true;
  const shellChdir = context.shellChdir || [];
  if (!Array.isArray(shellChdir)) return true;
  let opaque = false;
  for (const selector of [...shellChdir, ...context.chdir]) {
    if (!selector || typeof selector.value !== "string") return true;
    if (selector.unexpandable) opaque = true;
    else if (path.isAbsolute(selector.value)) opaque = false;
  }
  if (opaque) return true;
  for (const key of ["workTree", "gitDir"]) {
    const selector = context[key];
    if (selector !== null && selector !== undefined && (!selector || typeof selector.value !== "string" || !selector.value || selector.unexpandable)) return true;
  }
  return false;
}

function resolveGitTargetContext(g, payloadCwd) {
  const result = { known: false, cwd: null, workTree: null, gitDir: null, target: null, detail: null };
  const unknown = (detail) => ({ ...result, detail });
  result.cwd = physicalPath(payloadCwd, process.cwd());
  if (!g || !result.cwd) return unknown("payload directory is unresolvable");
  if (g.unresolvable === "command" || g.unresolvable === "subcommand") return unknown("git command is unresolvable");
  const context = g.targetContext;
  if (!context) {
    if (g.unresolvable === "dir") return unknown("git target directory is unresolvable");
    result.target = g.dir ? physicalPath(g.dir, result.cwd) : result.cwd;
    if (!result.target) return unknown("git target directory is unresolvable");
    result.cwd = result.target;
    return { ...result, known: true };
  }
  for (const key of ["workTree", "gitDir"]) {
    const selector = context[key];
    if (selector && !selector.unexpandable && typeof selector.value === "string" && path.isAbsolute(selector.value)) result[key] = physicalPath(selector.value, "");
  }
  if (!Array.isArray(context.unknown) || context.unknown.length) return unknown("git target context is opaque");
  if (!Array.isArray(context.chdir)) return unknown("git chdir sequence is malformed");
  const shellChdir = context.shellChdir || [];
  if (!Array.isArray(shellChdir)) return unknown("shell directory sequence is malformed");
  let shellResult;
  try {
    shellResult = require("./git-command-parse.js").resolveShellCdSequence(shellChdir, payloadCwd);
  } catch (error) {
    return unknown("shell directory resolver failed (" + String(error.code || error.message) + ")");
  }
  if (!shellResult || !shellResult.known) return unknown("shell directory sequence is unresolvable");
  let current = physicalPath(shellResult.dir, "");
  let expansionUnknown = false;
  for (const selector of context.chdir) {
    if (!selector || typeof selector.value !== "string") return unknown("directory selector is malformed");
    if (selector.value === "" && !selector.unexpandable) continue;
    if (selector.unexpandable) expansionUnknown = true;
    else if (path.isAbsolute(selector.value)) expansionUnknown = false;
    current = selector.unexpandable ? null : physicalPath(selector.value, current);
    if (!current && !selector.unexpandable && path.isAbsolute(selector.value)) current = physicalPath(selector.value, "");
  }
  result.cwd = current;
  if (!current) return unknown("git chdir sequence is unresolvable" + (expansionUnknown ? " (shell expansion)" : ""));
  for (const key of ["workTree", "gitDir"]) {
    const selector = context[key];
    if (selector === null || selector === undefined) continue;
    if (!selector || typeof selector.value !== "string" || selector.unexpandable) return unknown(key + " selector is unresolvable");
    result[key] = physicalPath(selector.value, current);
    if (!result[key]) return unknown(key + " selector is unresolvable");
  }
  result.target = result.workTree || result.cwd;
  return { ...result, known: true };
}

function gitProbeArgs(context, args) {
  if (!context || !context.known) return null;
  return ["-C", context.cwd,
    ...(context.gitDir ? ["--git-dir=" + context.gitDir] : []),
    ...(context.workTree ? ["--work-tree=" + context.workTree] : []), ...args];
}

function gitOptionFlags(g) {
  const flags = new Set();
  const values = new Set(g && g.sub === "clean" ? ["-e", "--exclude"] : ["--pathspec-from-file"]);
  const argv = g && Array.isArray(g.argv) ? g.argv : [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") break;
    if (values.has(token)) { i++; continue; }
    if (typeof token !== "string") continue;
    if (/^--[^=]+$/.test(token)) flags.add(token);
    else if (/^-[^-]/.test(token)) {
      for (let j = 1; j < token.length; j++) {
        const flag = "-" + token[j];
        if (values.has(flag)) { if (j === token.length - 1) i++; break; }
        flags.add(flag);
      }
    }
  }
  return flags;
}
module.exports = { physicalPath, gitTargetContextIsUnknown, resolveGitTargetContext, gitProbeArgs, gitOptionFlags };
