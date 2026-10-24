// Guard foundation — Codex CLI adapter (S3).
//
// Renders a Codex config fragment from the CLI-neutral policy
// (policy/protected-paths.json, loaded through policy.mjs::loadPolicy). The Codex
// layer is ONE adapter beside the OS launcher profiles (os-profile/*); it is never
// the dependency. What Codex cannot express is returned in `gaps`, never dropped.
//
// SHAPE — permission profiles, not sandbox_mode. Measured by S0 on codex-cli
// 0.162.1: `sandbox_mode = "workspace-write"` makes <root>/.git read-only
// recursively (including a linked worktree's resolved gitdir), which breaks
// commits. The beta permission profiles (learn.chatgpt.com/docs/permissions)
// express per-path access under the workspace roots — "More specific entries
// override broader entries" — and the config reference says not to combine them
// with sandbox_mode or [sandbox_workspace_write]. So this adapter emits a
// profile extending ":workspace", re-opens ".git" for writing, and marks each
// protected repo path "read".
//
// VERIFICATION STATE — read from adapters/codex-measured.json, the receipt
// tests/codex-measure/receipt.mjs DERIVES from a measure.sh log (`codex sandbox
// -C <scratch repo> -P loom-guard` at the user layer AND a trusted project's
// .codex/config.toml). No path is listed here: a hand-typed list both drifts from
// the policy and decides protected-path membership on its own (#1422). A key is
// `verified: true` ONLY when the receipt quotes a refusal it causes:
//   - a "read" entry: the unsandboxed control ALLOWED the write, both layers
//     REFUSED it ("Operation not permitted"), and the profile with every read
//     entry removed ALLOWED it again — so the entry is what refuses.
//   - `extends = ":workspace"`: a write outside every root was refused, and
//     without `extends` codex sandbox aborted before running anything.
//   - ".git" = "write" and the absolute "write" entries: measured redundant
//     (receipt `measured_redundant`), so never verified.
//   - `default_permissions`: UNDETERMINED — codex sandbox requires -P.
// A policy row added after the measurement has no receipt entry and stays
// UNVERIFIED until measure.sh is re-run. An unreadable or malformed receipt
// verifies nothing and is a declared gap — it never verifies by default.
//
// CLI:  node codex.mjs render [--worktrees <dir>] [--tmp <dir>]... [--home <dir>]  -> TOML on stdout

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "../policy/policy.mjs";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";

export const ADAPTER_KIND = "codex";
export const PROFILE_NAME = "loom-guard";
export const MEASUREMENT_FILE = fileURLToPath(new URL("./codex-measured.json", import.meta.url));
const EVIDENCE = "documented (learn.chatgpt.com/docs/permissions, beta), relayed by S0; no refusal caused by this key was measured";
const DENIED = /Operation not permitted/;

/** Read the measurement receipt. Never throws: an unreadable receipt verifies nothing. */
export function loadMeasurement(file = MEASUREMENT_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `measurement receipt unreadable (${e.code || e.name})` };
  }
}

function receiptProblem(m) {
  if (!m || typeof m !== "object") return "measurement receipt absent";
  if (m.error) return m.error;
  if (typeof m.codex_version !== "string" || !Array.isArray(m.read)) return "measurement receipt malformed";
  return null;
}

function measuredEvidence(m, fullKey, rel, value) {
  const how = `${m.codex_version}, ${m.harness}, ${m.measured_on}, policy ${String(m.policy_sha256).slice(0, 8)}`;
  if (fullKey === `permissions.${PROFILE_NAME}.extends` && value === ":workspace") {
    const e = m.extends;
    if (e && typeof e.refused === "string" && DENIED.test(e.refused)) return `refused outside every root: "${e.refused}" (${how}); ${e.without_extends}`;
    return null;
  }
  if (rel === null || value !== "read") return null;
  const e = m.read.find((x) => x && x.path === rel);
  if (!e || typeof e.refused !== "string" || !DENIED.test(e.refused) || e.control !== "ALLOWED" || e.without_read_entries !== "ALLOWED") return null;
  return `refused: "${e.refused}" (${how}); unsandboxed control ALLOWED; with the read entries removed, ALLOWED`;
}

function validate(policy) {
  if (!policy || policy.version !== 1 || !Array.isArray(policy.protected_write)) {
    throw new TypeError("policy must be version 1 with a protected_write array");
  }
}

const dirOf = (glob) => glob.replace(/\/\*\*$/, "");
const hasWildcard = (p) => /[*?[\]{}]/.test(p);
const q = (s) => JSON.stringify(String(s));

/**
 * Render the Codex adapter. `params` = { worktrees, tmp: [dirs], home } are
 * render-time anchor values (absolute). `measurement` is the receipt (default: the
 * shipped codex-measured.json). Deterministic: policy order, then params.
 */
export function generateCodexAdapter(policy, params = {}, measurement = loadMeasurement()) {
  validate(policy);
  const problem = receiptProblem(measurement);
  const keys = [];
  const coverage = [];
  const gaps = [];
  const workspaceEntries = [[".git", "write", "re-open .git under :workspace so commits work (S0 measured workspace-write makes it read-only)"]];
  const absoluteEntries = [];

  for (const r of policy.protected_write) {
    if (r.anchor === "repo") {
      const rel = dirOf(r.path);
      if (hasWildcard(rel)) {
        coverage.push({ id: r.id, path: r.path, anchor: r.anchor, layer: "os-profile-only", note: "glob shape not expressible as a Codex filesystem key" });
        gaps.push(`${r.id}: glob ${r.path} not expressible in Codex; OS profile only`);
        continue;
      }
      workspaceEntries.push([rel, "read", r.reason || r.id]);
      coverage.push({ id: r.id, path: r.path, anchor: r.anchor, layer: "codex-native-unverified+os-profile", note: `":workspace_roots" entry ${q(rel)} = "read"` });
      if (rel.startsWith(".git/")) gaps.push(`${r.id}: in a linked worktree .git is a file and the gitdir lies elsewhere; whether this entry reaches it is unmeasured`);
    } else if (r.anchor === "home") {
      coverage.push({ id: r.id, path: r.path, anchor: r.anchor, layer: "codex-native-unverified+os-profile", note: "outside every workspace root, so read-only under :workspace (unverified)" });
    } else {
      coverage.push({ id: r.id, path: r.path, anchor: r.anchor, layer: "os-profile-only", note: `anchor ${r.anchor} is not expressible in a project Codex config` });
      gaps.push(`${r.id}: anchor ${r.anchor} is not expressible in a project Codex config; OS profile only`);
    }
  }

  for (const w of Array.isArray(policy.writable) ? policy.writable : []) {
    if (w.anchor === "repo") continue; // the workspace root itself
    if (w.anchor === "worktrees" && params.worktrees) absoluteEntries.push([params.worktrees, "write", w.id]);
    else if (w.anchor === "tmp" && Array.isArray(params.tmp)) for (const t of params.tmp) absoluteEntries.push([t, "write", w.id]);
    else if (w.anchor === "home" && params.home && !hasWildcard(dirOf(w.path))) absoluteEntries.push([path.join(params.home, dirOf(w.path)), "write", w.id]);
    else gaps.push(`writable ${w.id}: anchor ${w.anchor} not rendered (parameter absent or not expressible); Codex keeps it read-only`);
  }
  for (const t of Array.isArray(policy.trusted_writers) ? policy.trusted_writers : []) {
    gaps.push(`trusted writer ${t.id}: Codex has no per-writer allowance; sanctioned writes go through the broker`);
  }
  if (problem) gaps.push(`codex measurement: ${problem}; every key UNVERIFIED`);
  for (const n of Array.isArray(policy.network) ? policy.network : []) {
    gaps.push(`network "${n.purpose}": no permission-profile network key is measured; not rendered (host allowlists are a gap)`);
  }

  const lines = [
    "# GENERATED by .claude/hooks/lib/guard-foundation/adapters/codex.mjs from",
    `# policy/protected-paths.json (sha256 ${policy.integrity?.sha256 ?? "unpinned"}) — do not edit.`,
    "# An EXTRA layer: the OS profile the launcher applies is the guard. VERIFIED = a measured refusal.",
  ];
  const assign = (table, key, value, rel = null) => {
    const fullKey = table ? `${table}.${key}` : key;
    const measured = problem ? null : measuredEvidence(measurement, fullKey, rel, value);
    keys.push({ key: fullKey, value, verified: measured !== null, evidence: measured ?? EVIDENCE });
    lines.push(`${key} = ${q(value)} # ${measured ? `VERIFIED ${measurement.codex_version}` : "UNVERIFIED"}`);
  };
  assign(null, "default_permissions", PROFILE_NAME);
  lines.push("", `[permissions.${PROFILE_NAME}]`);
  assign(`permissions.${PROFILE_NAME}`, "extends", ":workspace");
  lines.push("", `[permissions.${PROFILE_NAME}.filesystem.":workspace_roots"]`);
  for (const [rel, mode] of workspaceEntries) assign(`permissions.${PROFILE_NAME}.filesystem.":workspace_roots"`, q(rel), mode, rel);
  if (absoluteEntries.length) {
    lines.push("", `[permissions.${PROFILE_NAME}.filesystem]`);
    for (const [abs, mode] of absoluteEntries) assign(`permissions.${PROFILE_NAME}.filesystem`, q(abs), mode);
  }
  lines.push("");
  return { kind: ADAPTER_KIND, toml: lines.join("\n"), keys, coverage, gaps, policySha256: policy.integrity?.sha256 ?? null };
}

if (isMainModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const params = { tmp: [] };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--worktrees") params.worktrees = rest[++i];
    else if (rest[i] === "--tmp") params.tmp.push(rest[++i]);
    else if (rest[i] === "--home") params.home = rest[++i];
    else { process.stderr.write(`unknown argument ${rest[i]}\n`); process.exit(2); }
  }
  if (cmd !== "render") { process.stderr.write("usage: codex.mjs render [--worktrees <dir>] [--tmp <dir>]... [--home <dir>]\n"); process.exit(2); }
  process.stdout.write(generateCodexAdapter(loadPolicy(), params).toml);
}
