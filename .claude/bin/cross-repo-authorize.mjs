#!/usr/bin/env node
/**
 * cross-repo-authorize — write the User-Authorized Exception receipt that
 * clears a bounded cross-repo action, in a location a NORMAL (non-codify)
 * session can write.
 *
 * Closes the RC6 deadlock (journal/0488): `repo-scope-discipline.md`
 * § User-Authorized Exception condition 4 requires a journaled receipt BEFORE
 * a cross-repo action, but `journal/` is `/codify`-gated by the integrity
 * guard — so the receipt the hook (`violation-patterns.js::
 * hasCrossRepoAuthorizationReceipt`) greps was structurally un-producible
 * outside a codify session, and the exception was unsatisfiable in exactly the
 * sessions (normal downstream work) where it is needed.
 *
 * The receipt lives at `.claude/cross-repo-authz/<date>-<slug>.md` — NOT under
 * `journal/`, NOT under the integrity-guarded `.claude/learning/`. It is a
 * COMMITTED working-tree file (durable forensic witness per
 * `repo-scope-discipline.md` "receipt present = in-scope, absent = critical L1"
 * + `commit_workspaces_for_team`), greppable in the working tree within the
 * hook's mtime window. It is operator/session state in NO sync tier and is
 * excluded-by-default from the positive-INCLUDE publish allowlist, so it never
 * cascades to a consumer.
 *
 * This tool ONLY writes the receipt (the un-typo-able marker + the five
 * conditions). The AGENT drives the restate→user-confirm ceremony in chat per
 * `.claude/commands/cross-repo-authorize.md`; the tool is invoked AFTER the
 * user confirms, so no receipt lands without a confirmed authorization.
 *
 * Tier semantics (D — journal/0488): a WRITE receipt carries all five
 * conditions (the receipt is the sole distinguisher between an authorized and
 * an unauthorized cross-repo WRITE — byte-identical in the target's history).
 * A user-directed READ carries conditions 1+2+3+5 with condition-4 downgraded
 * to this one-line affordance receipt (NOT eliminated) — a read leaves no
 * durable trace in the target, so condition 4 protects a failure mode reads do
 * not have.
 *
 * Usage:
 *   node .claude/bin/cross-repo-authorize.mjs \
 *     --target <owner/repo> --action "<bounded action>" \
 *     --instruction "<verbatim user instruction>" --mode <read|write> \
 *     [--requester <display_id>] [--repo-root <path>] [--json]
 *
 * Exit codes: 0 = receipt written; 1 = usage / validation error.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const TARGET_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODES = new Set(["read", "write"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`cross-repo-authorize: ${msg}\n`);
  process.exit(1);
}

function repoToplevel(startDir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    return null;
  }
}

// Deterministic date + slug — this is a normal node CLI (NOT a workflow
// script), so Date is available; the receipt filename is timestamped for
// human ordering, but the hook matches on file mtime, not the filename date.
function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const target = args.target;
  const action = args.action;
  const instruction = args.instruction;
  const mode = args.mode;
  const requester = args.requester || process.env.COC_DISPLAY_ID || "unknown";

  if (!target || target === true) fail("missing --target <owner/repo>");
  if (!TARGET_RE.test(target))
    fail(`--target ${target} is not a valid <owner/repo> slug`);
  if (!action || action === true) fail('missing --action "<bounded action>"');
  if (!mode || !MODES.has(mode))
    fail("missing/invalid --mode (must be read|write)");
  if (mode === "write" && (!instruction || instruction === true))
    fail('a WRITE receipt MUST carry --instruction "<verbatim user instruction>" (condition 1)');

  // Reject marker-injection: a newline or the literal `cross-repo-authorized:`
  // in any free-text field could forge a SECOND authorization line (a receipt
  // for target X that also clears target Y). The hook matches the marker
  // anchored per-line, so a smuggled `\ncross-repo-authorized: victim/repo write`
  // would otherwise authorize an unrelated target. Reject at the source.
  for (const [name, val] of [
    ["action", action],
    ["instruction", instruction],
    ["requester", requester],
  ]) {
    if (typeof val === "string" && (/[\r\n]/.test(val) || /cross-repo-authorized:/i.test(val)))
      fail(`--${name} MUST NOT contain a newline or the literal "cross-repo-authorized:" (marker-injection guard)`);
  }

  const root = repoToplevel(args["repo-root"] || process.cwd());
  if (!root) fail("not inside a git working tree");

  const dir = path.join(root, ".claude", "cross-repo-authz");
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  const date = isoDateUTC(now);
  const ts = now.toISOString();
  const slug = slugify(`${target}-${action}`) || "cross-repo";
  const fileName = `${date}-${slug}.md`;
  const filePath = path.join(dir, fileName);

  // The marker line MUST match violation-patterns.js::
  // hasCrossRepoAuthorizationReceipt exactly: `cross-repo-authorized: <slug> <mode>`.
  // The <mode> qualifier is TIER-ENFORCING: a WRITE action is cleared ONLY by a
  // `write` receipt; a READ action accepts read OR write. Without it a cheap
  // read receipt would clear a write (the design's central tier defeated).
  const marker = `cross-repo-authorized: ${target} ${mode}`;
  const verbatim =
    instruction && instruction !== true ? instruction : "(read; verbatim instruction not required for a downgraded condition-4 read receipt)";

  // The conditions are OBLIGATIONS the ceremony (`.claude/commands/cross-repo-authorize.md`)
  // MUST have satisfied before this receipt was written — NOT facts this CLI can
  // itself verify (a Node process cannot read the session transcript). The
  // verbatim-instruction field below is the real forensic anchor; a gate-review
  // verifies these obligations against the session (evidence-first-claims.md).
  const conditionsBlock =
    mode === "write"
      ? [
          "condition_1_user_initiated: REQUIRED — a genuine user turn (see verbatim below)",
          "condition_2_explicit_specific: REQUIRED — names the target repo AND the exact bounded action",
          "condition_3_confirmed: REQUIRED — the ceremony restated action+target and the user confirmed yes/no BEFORE this write",
          "condition_4_receipt_before_acting: SATISFIED — THIS receipt is the durable witness, written BEFORE the command runs",
          "condition_5_scoped_exactly: REQUIRED — only the named action against only the named repo",
        ]
      : [
          "condition_1_user_initiated: REQUIRED — a genuine user turn",
          "condition_2_explicit_specific: REQUIRED — names the target repo AND the exact bounded READ",
          "condition_3_confirmed: REQUIRED — the ceremony restated action+target and the user confirmed yes/no BEFORE this write",
          "condition_4_receipt_before_acting: DOWNGRADED (READ tier) — one-line affordance receipt; a read leaves no durable trace in the target",
          "condition_5_scoped_exactly: REQUIRED — only the named read against only the named repo",
        ];

  const body = `---
type: cross-repo-authorization-receipt
date: ${date}
timestamp: ${ts}
requester: ${requester}
target: ${target}
action: ${action}
mode: ${mode}
---

# Cross-Repo Authorization Receipt

${marker}

## Bounded action

- **Target repo:** ${target}
- **Action (${mode}):** ${action}
- **Requester (display_id):** ${requester}
- **Authorized at:** ${ts}

## Verbatim user instruction

> ${verbatim.replace(/\n/g, "\n> ")}

## Five-condition attestation (repo-scope-discipline.md § User-Authorized Exception)

${conditionsBlock.map((l) => `- ${l}`).join("\n")}

<!--
  This receipt is the ONLY distinguisher between an authorized and an
  unauthorized cross-repo action. It is written by
  .claude/bin/cross-repo-authorize.mjs AFTER the user confirmed the restated
  action+target in chat, and BEFORE the action runs. The hook
  (violation-patterns.js::hasCrossRepoAuthorizationReceipt) greps this file's
  marker line within its mtime window; commit it for durable team audit.
-->
`;

  fs.writeFileSync(filePath, body, { mode: 0o644 });

  const rel = path.relative(root, filePath);
  const result = {
    ok: true,
    receipt: rel,
    target,
    action,
    mode,
    marker,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      [
        `✅ Cross-repo authorization receipt written: ${rel}`,
        `   target: ${target}   action (${mode}): ${action}`,
        `   marker: ${marker}`,
        "",
        "Next steps:",
        `  1. Commit the receipt for durable team audit:`,
        `       git add ${rel} && git commit -m "chore(authz): cross-repo ${mode} authorization for ${target}"`,
        `  2. Proceed with ONLY the named ${mode} against ONLY ${target} — no incidental scope creep.`,
        "",
      ].join("\n") + "\n",
    );
  }
  process.exit(0);
}

main();
