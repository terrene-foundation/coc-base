#!/usr/bin/env node
/**
 * validate-cert-bank.mjs — content validator for /certify question banks.
 *
 * Closes PR #355 R1 security MED-1: bank-template injection vector. The
 * per-repo `specs/_certification.yaml` is authored by the repo owner; bank
 * questions execute in the operator's session context. A malicious or
 * compromised bank could (a) embed prompt-injection payloads coercing the
 * orchestrator, (b) reference `cites_spec_section:` paths outside the
 * trusted prefix set, (c) instruct the operator to paste secrets as
 * answer prose.
 *
 * This validator runs at probe start and EXITS NON-ZERO on any finding.
 * /certify's command body invokes it; a non-zero exit halts the cycle
 * BEFORE Phase B starts.
 *
 * Per rules/security.md § Input Validation + rules/zero-tolerance.md
 * Rule 3 (no silent fallbacks): findings are surfaced loudly with file
 * + question id + check name + remediation; no silent-skip path.
 *
 * Usage:
 *   node .claude/bin/validate-cert-bank.mjs [path/to/bank.yaml]
 *   (default path: specs/_certification.yaml)
 *
 * Origin: PR #355 R1 multi-agent self-referential redteam (2026-05-26),
 * security-reviewer MED-1 (bank-template injection vector unaddressed).
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve as resolvePath, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse YAML via python3 + pyyaml (universally available; emit.mjs's
// regex-YAML approach is too fragile for the nested bank schema).
// Returns the parsed object or throws if YAML is invalid / python is absent.
function parseYaml(text) {
  try {
    const out = execFileSync(
      "python3",
      ["-c", "import sys, json, yaml; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)"],
      { input: text, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(out);
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    throw new Error(
      `python3 + pyyaml unavailable or YAML invalid: ${err.message}${stderr ? "\n" + stderr : ""}`,
    );
  }
}

// ─── policy ──────────────────────────────────────────────────────────────────

// Allowed `cites_spec_section:` prefixes — positive allowlist per
// cc-artifacts.md Rule 10 (enumerable vocabulary uses positive allowlist).
// Citations to anything outside this set are BLOCKED: the bank cannot point
// at .env, .ssh/, repo-internal data files, or off-repo paths.
const CITATION_PREFIX_ALLOWLIST = ["specs/", "rules/", ".claude/"];

// Length caps — prevent the bank from embedding a multi-KB prompt that
// would exhaust orchestrator context or hide injection payloads in scrollback.
const MAX_PROMPT_CHARS = 1000;
const MAX_RUBRIC_CHARS = 400;
const MAX_OPTION_CHARS = 300;
const MAX_EXPECTED_CHARS = 600;

// Injection-pattern signals — lexical signal at advisory severity per
// hook-output-discipline.md MUST-2 (lexical regex MUST NOT carry block).
// These are RED FLAGS for review, not hard blocks. Combined with the
// length caps + citation allowlist + structural shape check, the validator
// produces a fail-loud signal the bank curator MUST address before merge.
const INJECTION_SIGNALS = [
  /ignore (?:all|previous|prior|above) instructions/i,
  /system prompt/i,
  /reveal (?:your|the) (?:prompt|instructions|system)/i,
  /jailbreak/i,
  /\bDAN\b/i, // "Do Anything Now" jailbreak shorthand (case-insensitive — security R2 LOW-1)
  /\bact as\b/i,
  /you are now/i,
  /forget (?:your|the) (?:rules|instructions|guidelines)/i,
];

// Secret-shaped tokens — refuse if the bank example/prompt embeds anything
// that looks like a credential. The bank curator must use redaction tokens
// (<API_KEY>, ${TOKEN}) in example prose.
//
// Known limit per security R2 LOW-2: these patterns are ASCII-only. A token
// embedded with zero-width-joiner (U+200D) or other unicode normalization
// tricks (e.g., "sk-‍XXXX") will not match. Acceptable for advisory
// scan; per `rules/probe-driven-verification.md` MUST-1 lexical scans are
// advisory-grade by design. Tighten if a real bypass is observed in the
// wild.
const SECRET_SHAPE = [
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub PAT", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
];

// ─── findings collection ─────────────────────────────────────────────────────

const findings = [];

function flag({ severity, kind, qid, field, evidence, remediation }) {
  findings.push({ severity, kind, qid, field, evidence, remediation });
}

// ─── validation ──────────────────────────────────────────────────────────────

function validateCitation(path, qid, field) {
  if (typeof path !== "string" || !path) {
    flag({
      severity: "HIGH",
      kind: "missing-citation",
      qid,
      field,
      evidence: `${field} is not a non-empty string`,
      remediation: `Add a ${field} value pointing at a trusted prefix (${CITATION_PREFIX_ALLOWLIST.join(" / ")}).`,
    });
    return;
  }
  // Strip optional `:line-range` suffix for prefix check.
  const justPath = path.split(":")[0];
  if (isAbsolute(justPath)) {
    flag({
      severity: "HIGH",
      kind: "absolute-citation-path",
      qid,
      field,
      evidence: `${field}: ${path}`,
      remediation: `Cite repo-relative paths only; absolute paths can escape the citation allowlist.`,
    });
    return;
  }
  if (justPath.includes("..")) {
    flag({
      severity: "HIGH",
      kind: "parent-traversal-citation",
      qid,
      field,
      evidence: `${field}: ${path}`,
      remediation: `Cite repo-relative paths without ".." traversal — use a stable spec/rule path under the allowlist.`,
    });
    return;
  }
  const allowed = CITATION_PREFIX_ALLOWLIST.some((p) => justPath.startsWith(p));
  if (!allowed) {
    flag({
      severity: "HIGH",
      kind: "citation-prefix-not-allowed",
      qid,
      field,
      evidence: `${field}: ${path}`,
      remediation: `Cite only paths under ${CITATION_PREFIX_ALLOWLIST.join(" / ")}; bank cannot reference operator state, secrets, or arbitrary repo paths.`,
    });
  }
}

function validateLength(value, qid, field, maxChars) {
  if (typeof value !== "string") return;
  if (value.length > maxChars) {
    flag({
      severity: "MED",
      kind: "length-cap-exceeded",
      qid,
      field,
      evidence: `${field}: ${value.length} chars (cap ${maxChars})`,
      remediation: `Shorten ${field} to ≤${maxChars} chars; long prompts hide injection payloads in scrollback and exhaust orchestrator context.`,
    });
  }
}

function scanInjection(value, qid, field) {
  if (typeof value !== "string") return;
  for (const pat of INJECTION_SIGNALS) {
    const m = value.match(pat);
    if (m) {
      flag({
        severity: "HIGH",
        kind: "injection-pattern",
        qid,
        field,
        evidence: `${field} matches ${pat}: "${m[0]}"`,
        remediation: `Rewrite ${field} to avoid prompt-injection signal patterns; these terms suggest the bank is trying to coerce the orchestrator.`,
      });
    }
  }
}

function scanSecrets(value, qid, field) {
  if (typeof value !== "string") return;
  for (const { name, re } of SECRET_SHAPE) {
    const m = value.match(re);
    if (m) {
      flag({
        severity: "CRIT",
        kind: "secret-shape",
        qid,
        field,
        evidence: `${field} contains ${name}-shaped token: "${m[0].slice(0, 12)}..."`,
        remediation: `Replace the credential with a redaction token (<API_KEY>, \${TOKEN}); bank prose MUST NOT embed real or example-real credentials.`,
      });
    }
  }
}

function validateQuestion(q, sectionId) {
  const qid = q.id || `<section ${sectionId}: unnamed>`;

  if (!q.id || typeof q.id !== "string") {
    flag({
      severity: "HIGH",
      kind: "missing-id",
      qid,
      field: "id",
      evidence: "question lacks unique id",
      remediation: "Add an `id:` field unique across the whole bank.",
    });
  }

  if (!q.kind || !["multiple_choice", "short_answer"].includes(q.kind)) {
    flag({
      severity: "HIGH",
      kind: "invalid-kind",
      qid,
      field: "kind",
      evidence: `kind: ${q.kind}`,
      remediation: "Set kind to `multiple_choice` or `short_answer`.",
    });
  }

  validateCitation(q.cites_spec_section, qid, "cites_spec_section");
  validateLength(q.prompt, qid, "prompt", MAX_PROMPT_CHARS);
  scanInjection(q.prompt, qid, "prompt");
  scanSecrets(q.prompt, qid, "prompt");

  if (q.kind === "multiple_choice") {
    if (!Array.isArray(q.options) || q.options.length < 2) {
      flag({
        severity: "HIGH",
        kind: "insufficient-options",
        qid,
        field: "options",
        evidence: `options has ${(q.options || []).length} entries`,
        remediation: "Multiple-choice questions MUST have ≥2 options.",
      });
    } else {
      q.options.forEach((opt, i) => {
        const optText = typeof opt === "object" ? Object.values(opt)[0] : opt;
        validateLength(String(optText), qid, `options[${i}]`, MAX_OPTION_CHARS);
        scanInjection(String(optText), qid, `options[${i}]`);
        scanSecrets(String(optText), qid, `options[${i}]`);
      });
    }
    if (q.expected === undefined || q.expected === null) {
      flag({
        severity: "HIGH",
        kind: "missing-expected",
        qid,
        field: "expected",
        evidence: "expected is null/undefined",
        remediation: "Set `expected:` to the letter (A/B/C/D) of the correct option.",
      });
    }
  } else if (q.kind === "short_answer") {
    if (typeof q.expected !== "string" || !q.expected.trim()) {
      flag({
        severity: "HIGH",
        kind: "missing-expected",
        qid,
        field: "expected",
        evidence: "expected is empty",
        remediation: "Set `expected:` to the canonical answer prose for short_answer questions.",
      });
    } else {
      validateLength(q.expected, qid, "expected", MAX_EXPECTED_CHARS);
      scanSecrets(q.expected, qid, "expected");
    }
    if (!Array.isArray(q.grading_rubric) || q.grading_rubric.length < 1) {
      flag({
        severity: "HIGH",
        kind: "missing-rubric",
        qid,
        field: "grading_rubric",
        evidence: "grading_rubric absent or empty",
        remediation: "Short-answer questions MUST have a `grading_rubric:` list of acceptance criteria.",
      });
    } else {
      q.grading_rubric.forEach((bullet, i) => {
        validateLength(String(bullet), qid, `grading_rubric[${i}]`, MAX_RUBRIC_CHARS);
        scanInjection(String(bullet), qid, `grading_rubric[${i}]`);
        scanSecrets(String(bullet), qid, `grading_rubric[${i}]`);
      });
    }
  }
}

function validateBank(bankPath) {
  if (!existsSync(bankPath)) {
    flag({
      severity: "CRIT",
      kind: "bank-missing",
      qid: "<bank>",
      field: "file",
      evidence: `${bankPath} does not exist`,
      remediation: `Seed the bank from .claude/templates/specs/_certification.yaml.`,
    });
    return;
  }
  const stat = statSync(bankPath);
  if (stat.size > 100 * 1024) {
    flag({
      severity: "MED",
      kind: "bank-oversize",
      qid: "<bank>",
      field: "file",
      evidence: `${bankPath} is ${stat.size} bytes (cap 100KB)`,
      remediation: "A 100% gate against a >100KB bank is impractical and suggests bank-bloat; split into focused per-section banks if needed.",
    });
  }
  let raw;
  try {
    raw = readFileSync(bankPath, "utf8");
  } catch (err) {
    flag({
      severity: "CRIT",
      kind: "bank-unreadable",
      qid: "<bank>",
      field: "file",
      evidence: `read failed: ${err.message}`,
      remediation: "Ensure the bank file is readable by the running process.",
    });
    return;
  }
  let doc;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    flag({
      severity: "CRIT",
      kind: "bank-yaml-invalid",
      qid: "<bank>",
      field: "yaml",
      evidence: `YAML parse failed: ${err.message}`,
      remediation: "Fix YAML syntax errors in the bank.",
    });
    return;
  }
  if (!doc || typeof doc !== "object") {
    flag({
      severity: "CRIT",
      kind: "bank-empty",
      qid: "<bank>",
      field: "root",
      evidence: "parsed bank is empty or non-object",
      remediation: "Bank must be a YAML object with `version`, `bank_version`, and `sections` keys.",
    });
    return;
  }
  if (doc.version !== 1) {
    flag({
      severity: "HIGH",
      kind: "bank-version-mismatch",
      qid: "<bank>",
      field: "version",
      evidence: `version: ${doc.version} (expected 1)`,
      remediation: "Set `version: 1` per the schema in skills/42-certify/SKILL.md.",
    });
  }
  if (typeof doc.bank_version !== "string" || !doc.bank_version.trim()) {
    flag({
      severity: "MED",
      kind: "bank-version-missing",
      qid: "<bank>",
      field: "bank_version",
      evidence: "bank_version is empty or non-string",
      remediation: "Set `bank_version:` to a free-text operator-visible identifier (e.g. <repo>-2026-05-26).",
    });
  }
  if (!Array.isArray(doc.sections)) {
    flag({
      severity: "CRIT",
      kind: "bank-no-sections",
      qid: "<bank>",
      field: "sections",
      evidence: "sections is not an array",
      remediation: "Add a `sections:` list with at least one section.",
    });
    return;
  }
  // Track ids for cross-section uniqueness.
  const seenIds = new Set();
  for (const section of doc.sections) {
    if (!section || typeof section !== "object") continue;
    const sid = section.id || "<unnamed section>";
    if (Array.isArray(section.questions)) {
      for (const q of section.questions) {
        if (q && typeof q === "object") {
          if (q.id && seenIds.has(q.id)) {
            flag({
              severity: "HIGH",
              kind: "duplicate-question-id",
              qid: q.id,
              field: "id",
              evidence: `id ${q.id} appears in multiple questions`,
              remediation: "Question ids MUST be unique across the whole bank.",
            });
          }
          if (q.id) seenIds.add(q.id);
          validateQuestion(q, sid);
        }
      }
    }
  }
}

// ─── reporter ────────────────────────────────────────────────────────────────

function summarize() {
  const order = { CRIT: 0, HIGH: 1, MED: 2, LOW: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const counts = { CRIT: 0, HIGH: 0, MED: 0, LOW: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  const lines = [];
  lines.push("");
  lines.push("validate-cert-bank — findings");
  lines.push("─".repeat(60));
  if (findings.length === 0) {
    lines.push("  no findings; bank passed all checks");
  } else {
    for (const f of findings) {
      lines.push(`  [${f.severity}] ${f.kind} — ${f.qid} (${f.field})`);
      lines.push(`         evidence: ${f.evidence}`);
      lines.push(`         remediation: ${f.remediation}`);
    }
  }
  lines.push("─".repeat(60));
  lines.push(
    `summary: ${counts.CRIT} CRIT / ${counts.HIGH} HIGH / ${counts.MED} MED / ${counts.LOW} LOW — ${counts.CRIT + counts.HIGH} blocking`,
  );
  lines.push("");
  return { text: lines.join("\n"), blocking: counts.CRIT + counts.HIGH };
}

// ─── main ────────────────────────────────────────────────────────────────────

const bankPath = process.argv[2] || "specs/_certification.yaml";
const absPath = resolvePath(process.cwd(), bankPath);

validateBank(absPath);
const { text, blocking } = summarize();
process.stdout.write(text);
process.exit(blocking > 0 ? 1 : 0);
