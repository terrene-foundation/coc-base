// Guard foundation — load, pin-check and validate the CLI-neutral write policy.
//
// Every generator (os-profile/seatbelt.mjs, os-profile/linux.mjs, adapters/*.mjs)
// reads the policy through loadPolicy(), so a policy that fails its schema or its
// sha256 pin is refused once, here, before anything is rendered from it.
//
// CLI:  node policy.mjs validate [<policy.json>]   -> exit 0 valid, 1 invalid
//       node policy.mjs pin [<policy.json>]        -> prints the canonical sha256

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../../../bin/lib/entry-point.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POLICY_PATH = path.join(HERE, "protected-paths.json");
export const ANCHORS = ["repo", "home", "config_dir", "worktrees", "tmp", "vault"];

// True when a repo-anchored protected row covers `rel`: an exact path, or a
// `<dir>/**` row whose directory contains it.
export function repoProtects(policy, rel) {
  return policy.protected_write.some((r) => r.anchor === "repo"
    && (r.path === rel || (r.path.endsWith("/**") && rel.startsWith(r.path.slice(0, -2)))));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The pin covers the whole document except its own integrity member.
export function canonicalSha256(policy) {
  const { integrity, ...body } = policy;
  return crypto.createHash("sha256").update(canonical(body)).digest("hex");
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const HOST = /^(\*\.)?[a-z0-9.-]+(:[0-9]{1,5})?$/;

function isRelPath(p) {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

function exactKeys(obj, required, optional, where, errors) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    errors.push(`${where}: not an object`);
    return false;
  }
  for (const k of required) if (!(k in obj)) errors.push(`${where}: missing ${k}`);
  for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) errors.push(`${where}: unknown key ${k}`);
  return true;
}

function checkPathRules(list, where, errors, ids) {
  if (!Array.isArray(list) || list.length === 0) return errors.push(`${where}: must be a non-empty array`);
  list.forEach((r, i) => {
    const at = `${where}[${i}]`;
    if (!exactKeys(r, ["id", "anchor", "path", "reason"], [], at, errors)) return;
    if (!ID.test(r.id)) errors.push(`${at}: bad id ${r.id}`);
    if (ids.has(r.id)) errors.push(`${at}: duplicate id ${r.id}`);
    ids.add(r.id);
    if (!ANCHORS.includes(r.anchor)) errors.push(`${at}: unknown anchor ${r.anchor}`);
    if (!isRelPath(r.path)) errors.push(`${at}: path must be relative with no '..': ${r.path}`);
    if (typeof r.reason !== "string" || !r.reason) errors.push(`${at}: empty reason`);
  });
}

// Returns a list of errors; empty means valid. Mirrors protected-paths.schema.json
// and adds the cross-reference rules a JSON Schema cannot state.
export function validatePolicy(policy) {
  const errors = [];
  if (!exactKeys(policy, ["version", "anchors", "protected_write", "writable", "trusted_writers", "network", "integrity"], ["description", "phases"], "policy", errors)) return errors;
  if (policy.version !== 1) errors.push(`version: expected 1, got ${policy.version}`);
  if (exactKeys(policy.anchors, ANCHORS, [], "anchors", errors)) {
    for (const a of ANCHORS) if (typeof policy.anchors[a] !== "string") errors.push(`anchors.${a}: not a string`);
  }
  const protectedIds = new Set();
  checkPathRules(policy.protected_write, "protected_write", errors, protectedIds);
  checkPathRules(policy.writable, "writable", errors, new Set(protectedIds));

  // Commits must keep working: objects, refs, index and locks are never protected.
  for (const r of policy.protected_write || []) {
    if (r.anchor === "repo" && /^\.git\/(objects|refs|index|HEAD|worktrees|logs)(\/|$)/.test(r.path)) {
      errors.push(`protected_write ${r.id}: ${r.path} would break git commit`);
    }
    if (r.anchor === "repo" && (r.path === "**" || r.path === ".git/**" || r.path === ".git")) {
      errors.push(`protected_write ${r.id}: ${r.path} is too broad`);
    }
  }

  if (!Array.isArray(policy.trusted_writers)) errors.push("trusted_writers: not an array");
  else {
    const seen = new Set();
    policy.trusted_writers.forEach((w, i) => {
      const at = `trusted_writers[${i}]`;
      if (!exactKeys(w, ["id", "entry", "paths", "reason"], [], at, errors)) return;
      if (!ID.test(w.id) || seen.has(w.id)) errors.push(`${at}: bad or duplicate id ${w.id}`);
      seen.add(w.id);
      if (!isRelPath(w.entry)) errors.push(`${at}: entry must be repo-relative`);
      // A trusted writer's own code must be protected, or writing it is the escape.
      if (!Array.isArray(policy.protected_write) || !repoProtects(policy, w.entry)) {
        errors.push(`${at}: entry ${w.entry} is not itself in protected_write`);
      }
      if (!Array.isArray(w.paths) || w.paths.length === 0) errors.push(`${at}: paths must be non-empty`);
      else for (const id of w.paths) if (!protectedIds.has(id)) errors.push(`${at}: unknown protected id ${id}`);
    });
  }

  // Declared phases: writes that happen BEFORE any profile exists (fork
  // instantiation). They name protected ids, and grant no in-sandbox route.
  if (policy.phases !== undefined) {
    if (!Array.isArray(policy.phases)) errors.push("phases: not an array");
    else policy.phases.forEach((ph, i) => {
      const at = `phases[${i}]`;
      if (!exactKeys(ph, ["id", "when", "ceremonies", "writes", "reason"], [], at, errors)) return;
      if (!ID.test(ph.id)) errors.push(`${at}: bad id ${ph.id}`);
      if (typeof ph.when !== "string" || !/pre-profile/.test(ph.when)) errors.push(`${at}: when must declare a pre-profile phase`);
      if (!Array.isArray(ph.ceremonies) || ph.ceremonies.length === 0) errors.push(`${at}: ceremonies must be non-empty`);
      if (!Array.isArray(ph.writes) || ph.writes.length === 0) errors.push(`${at}: writes must be non-empty`);
      else for (const id of ph.writes) if (!protectedIds.has(id)) errors.push(`${at}: unknown protected id ${id}`);
      if (typeof ph.reason !== "string" || !ph.reason) errors.push(`${at}: empty reason`);
    });
  }

  if (!Array.isArray(policy.network)) errors.push("network: not an array");
  else policy.network.forEach((n, i) => {
    const at = `network[${i}]`;
    if (!exactKeys(n, ["purpose", "hosts"], [], at, errors)) return;
    if (n.hosts !== "any" && !(Array.isArray(n.hosts) && n.hosts.length && n.hosts.every((h) => HOST.test(h)))) {
      errors.push(`${at}: hosts must be "any" or host[:port] strings`);
    }
  });

  if (exactKeys(policy.integrity, ["sha256", "sha256_over", "signature"], [], "integrity", errors)) {
    const want = canonicalSha256(policy);
    if (policy.integrity.sha256 !== want) errors.push(`integrity.sha256: pinned ${policy.integrity.sha256}, computed ${want}`);
    if (policy.integrity.signature !== null && typeof policy.integrity.signature !== "string") errors.push("integrity.signature: must be null or a string");
  }
  return errors;
}

export class PolicyError extends Error {}

export function loadPolicy(file = POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  const errors = validatePolicy(policy);
  if (errors.length) throw new PolicyError(`invalid policy ${file}:\n  ${errors.join("\n  ")}`);
  return policy;
}

if (isMainModule(import.meta.url)) {
  const [cmd, file = POLICY_PATH] = process.argv.slice(2);
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  if (cmd === "pin") {
    process.stdout.write(`${canonicalSha256(policy)}\n`);
  } else if (cmd === "validate") {
    const errors = validatePolicy(policy);
    for (const e of errors) process.stderr.write(`${e}\n`);
    process.stdout.write(errors.length ? `INVALID (${errors.length})\n` : "VALID\n");
    process.exit(errors.length ? 1 : 0);
  } else {
    process.stderr.write("usage: policy.mjs validate|pin [<policy.json>]\n");
    process.exit(2);
  }
}
