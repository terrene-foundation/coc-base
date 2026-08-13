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
 * The receipt lives at `.claude/cross-repo-authz/<date>-<slug>-<digest8>.md` — NOT
 * under `journal/`, NOT under the integrity-guarded `.claude/learning/`. It is a
 * working-tree file, greppable within the guard's FRONTMATTER-TIMESTAMP window
 * (`violation-patterns.js::_receiptTimestampMs` parses the receipt's own
 * `timestamp:`/`date:` field; filesystem mtime is explicitly REPUDIATED there
 * because git rewrites it on checkout / worktree-add / clone). ENFORCEMENT never
 * consults git, so an uncommitted receipt clears `repo-scope-discipline.md`
 * condition 4 identically to a committed one.
 *
 * WHETHER to commit it is REPO-CLASS-dependent (2026-08-03, the LOCALITY axis —
 * see `readRepoClass` / `shouldCommitReceipt` below). At loom (`coc-source`) the
 * receipt is a durable forensic witness and committing is disclosure-safe: it is
 * in NO sync tier and is excluded-by-default from the positive-INCLUDE publish
 * allowlist, so it never cascades to a consumer. Those fences govern content
 * flowing OUT OF LOOM and cover NOTHING written into another repo, so at a BUILD
 * repo / USE template / downstream consumer the receipt stays LOCAL — loom's sync
 * gitignores the directory there (`sync-manifest.yaml::target_owned`,
 * `publish: local_only`). The pre-2026-08-03 tool printed and stamped
 * an unconditional "commit it", which is how kailash-py and kailash-rs came to
 * track operator-correlatable receipts in a public-fork-lane history.
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
import { createHash } from "crypto";
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
// script), so Date is available. The leading date is for HUMAN ordering only:
// the guard ages a receipt by its `timestamp:` FRONTMATTER, never by the
// filename and never by filesystem mtime (`violation-patterns.js::
// _receiptTimestampMs`). Nothing downstream parses this filename.
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

/**
 * 8-hex discriminator over the FULL, UNTRUNCATED `(target, action, mode)`
 * triple. Two properties, both load-bearing (loom RS-71):
 *
 *  1. `mode` IS IN THE TRIPLE, DELIBERATELY. Without it a `read` receipt and a
 *     `write` receipt for the same (target, action) resolve to ONE filename, so
 *     writing the cheap read receipt DESTROYS the write authorization —
 *     measured, not theorised: `hasCrossRepoAuthorizationReceipt(t, cwd,
 *     "write")` went `true` → `false`. That is the ceremony's central tier
 *     (repo-scope-discipline.md § Affordance, read/write tier D) defeated by the
 *     filename alone, with exit 0 and no warning. Any future edit that drops
 *     `mode` from this triple re-opens it; the fixture
 *     `RS-71-tier-defeat-measured` is the tripwire.
 *  2. It is computed over the UNTRUNCATED inputs, while `slugify` truncates at
 *     48 chars. Two distinct actions sharing a 48-char prefix collide in the
 *     slug and are separated only here.
 *
 * The join is LENGTH-PREFIXED so it is injective: no delimiter can be forged
 * from within a field (`a|b` and `a` + `|b` hash differently).
 */
function tripleDigest(target, action, mode) {
  const parts = [target, action, mode].map((v) => {
    const s = String(v);
    return `${s.length}:${s}`;
  });
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 8);
}

/**
 * Create-or-fail write (`flag: "wx"`), never a clobber.
 *
 * `writeFileSync` with the default flag SILENTLY overwrites. On this surface the
 * overwritten bytes are a prior authorization receipt — the ONLY distinguisher
 * between an authorized and an unauthorized cross-repo action
 * (repo-scope-discipline.md condition 4: "present = in-scope, absent = critical
 * L1"). Destroying one silently is the RS-71 defect.
 *
 * On EEXIST we do NOT overwrite and do NOT hard-fail: we take the next free
 * `-2`, `-3`, … suffix, so BOTH receipts survive and the forensic record is
 * append-only. NAMED DEVIATION from RS-71's stated "create-or-fail": a hard
 * failure would deadlock a legitimate re-authorization of the same triple after
 * the 6-hour window expires (same date ⇒ same base name), and the operator's
 * escape from that deadlock is `rm` — which destroys the receipt this function
 * exists to preserve. The load-bearing half of "create-or-fail" is that the
 * write MUST NOT clobber; `wx` + retry holds that exactly. Exhausting the
 * suffix budget DOES fail loudly rather than falling back to an overwrite.
 *
 * Returns the path actually written.
 */
const RECEIPT_SUFFIX_BUDGET = 50;
function writeReceiptNoClobber(dir, baseName, body) {
  for (let n = 1; n <= RECEIPT_SUFFIX_BUDGET; n++) {
    const name = n === 1 ? `${baseName}.md` : `${baseName}-${n}.md`;
    const full = path.join(dir, name);
    try {
      fs.writeFileSync(full, body, { mode: 0o644, flag: "wx" });
      return full;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  fail(
    `refusing to overwrite an existing receipt: ${baseName}.md and ${RECEIPT_SUFFIX_BUDGET - 1} ` +
      `suffixed siblings all exist in ${dir}. A receipt is the sole distinguisher between an ` +
      `authorized and an unauthorized cross-repo action; this tool never clobbers one. ` +
      `Archive or remove the spent receipts, then re-run the ceremony.`,
  );
}

/**
 * Read this repo's CLASS from `.claude/VERSION::type` — the discriminator
 * `issue-triage-routing.md` already mandates reading before any class-dependent
 * disposition. Returns the declared type string, or null when it cannot be read.
 *
 * Used for exactly one decision: whether the receipt should be COMMITTED. That
 * is a repo-class property, not a content property — see `shouldCommitReceipt`.
 *
 * TRAP (loom#1426) — DO NOT widen this reader into a general trust input. It
 * parses `.claude/VERSION` and returns `type` VERBATIM: no signature, no
 * cross-check, no corroborating source. The `catch` fails closed on an
 * UNREADABLE file only; it cannot fail closed on a file that reads fine and
 * lies. So the class is attacker-authorable by anyone who can write a JSON file
 * in the repo, and every consumer of it inherits that.
 *
 * That is survivable HERE precisely because of the polarity `shouldCommitReceipt`
 * chose: only `coc-source` may commit, so a DEMOTION (any other value, or an
 * unreadable file) costs a durable audit trail and nothing else, while the
 * dangerous direction — a repo forging `coc-source` to be told "commit it" and
 * putting an operator `display_id` into a public history forever — requires
 * PROMOTING to the one privileged value. Any future edit that inverts this
 * polarity, or that routes a second decision through the same field, converts a
 * lost audit trail into a real forge. `manifest-source.mjs::readRepoClass` is the
 * sibling reader with the same verbatim-trust property (loom#1399).
 *
 * Why this trap is recorded on THIS function rather than on the guard it
 * concerns: loom#1426 is the state-file write guard over-blocking read-only
 * commands that merely MENTION a protected path — it has now fired on five
 * separate actors, EVERY one of them while verifying or documenting the guard
 * itself, and in three of those cases the actor changed the TOOL rather than the
 * assertion being tested. The recurring conclusion is that the MATCHER is wrong
 * (it keys on a protected-path literal appearing anywhere in the command, not on
 * that path being the write TARGET), not that the policy should be relaxed —
 * relaxing removes a real control to fix a semantics bug. The narrowing
 * direction the issue's residuals (k)/(l)/(m) leave open is destination-
 * awareness: decide on the redirect target. This function is where a maintainer
 * reaching for "make it repo-class-aware" would arrive, and it is exactly the
 * input that cannot carry that weight.
 */
function readRepoClass(root) {
  try {
    const raw = fs.readFileSync(path.join(root, ".claude", "VERSION"), "utf8");
    const t = JSON.parse(raw).type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/**
 * Should this repo COMMIT its cross-repo authorization receipts?
 *
 * ONLY `coc-source` (loom) may. The ceremony's containment argument — that
 * `.claude/cross-repo-authz/` is never distributed, guaranteed by
 * `sync-tier-aware` no_tier_match + `edition-emit.mjs::CLIENT_TEMPLATE_REMOVE` +
 * `community-membership` EXCLUDE_WITHIN — describes fences on content flowing
 * OUT OF LOOM. A receipt committed INTO a BUILD repo or a USE template has THAT
 * repo's git history as its distribution channel, which no loom fence covers,
 * and the receipt carries the requester's operator display_id.
 *
 * FAIL-CLOSED on an unreadable/absent `.claude/VERSION`: an unknown class is
 * treated as NOT-loom, so the tool advises keeping the receipt local. The cost
 * of a wrong "keep local" is a lost durable audit trail; the cost of a wrong
 * "commit" is operator identity in a public repo's history forever. Enforcement
 * is identical either way — the guard greps the working tree, not git.
 */
function shouldCommitReceipt(repoClass) {
  return repoClass === "coc-source";
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

  // Repo class decides ONE thing: commit vs keep-local (see shouldCommitReceipt).
  const repoClass = readRepoClass(root);
  const commitReceipt = shouldCommitReceipt(repoClass);

  const now = new Date();
  const date = isoDateUTC(now);
  const ts = now.toISOString();
  const slug = slugify(`${target}-${action}`) || "cross-repo";
  // `mode` is in the digest DELIBERATELY — see tripleDigest. Without it a read
  // receipt and a write receipt for one (target, action) share a filename and
  // the read silently revokes the write.
  const baseName = `${date}-${slug}-${tripleDigest(target, action, mode)}`;

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

  // The trailer's locality guidance is REPO-CLASS-AWARE. The pre-2026-08-03
  // trailer stamped an unconditional "commit it for durable team audit" into
  // EVERY receipt at EVERY repo, carrying loom's containment argument to repos
  // that argument does not cover — which is how kailash-py and kailash-rs came
  // to track operator-correlatable receipts in a public-fork-lane history.
  const localityNote = commitReceipt
    ? "LOCALITY: this repo is `type: coc-source` (loom). COMMIT this receipt for\n" +
      "  durable team audit. Committing is disclosure-safe HERE because\n" +
      "  `.claude/cross-repo-authz/` never leaves loom: sync-tier-aware matches no\n" +
      "  tier (no_tier_match), edition-emit.mjs::CLIENT_TEMPLATE_REMOVE strips it,\n" +
      "  and community-membership EXCLUDE_WITHIN fences the public-fork publish."
    : `LOCALITY: this repo is \`type: ${repoClass || "unknown"}\` — NOT loom. DO NOT COMMIT\n` +
      "  this receipt; leave it on disk. The three fences that make committing safe at\n" +
      "  loom (sync-tier-aware no_tier_match, edition-emit CLIENT_TEMPLATE_REMOVE,\n" +
      "  community-membership EXCLUDE_WITHIN) all govern content flowing OUT OF LOOM\n" +
      "  and cover nothing written INTO this repo — whose own git history is its\n" +
      "  distribution channel, and this file carries the requester's display_id.\n" +
      "  loom's sync gitignores `.claude/cross-repo-authz/` here\n" +
      "  (sync-manifest.yaml::target_owned, publish: local_only); do not override it.\n" +
      "  That same declaration ALSO vetoes any loom purge of this directory — your\n" +
      "  receipts are yours, and loom must neither publish nor delete them.\n" +
      "  Only DURABLE MULTI-SESSION audit is traded away — the hook's working-tree\n" +
      "  grep above is unaffected.";

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
  marker line in the WORKING TREE — not in git — so enforcement does not depend
  on whether this file is committed. It ages the receipt by the timestamp:
  FRONTMATTER above (a 6h window, two-sided against a future-dated typo), and
  NOT by filesystem mtime: git rewrites mtime on checkout / worktree-add /
  clone, so mtime is not a reliable authorization-age bound. Editing that
  timestamp: field is editing the authorization's expiry.

  ${localityNote}
-->
`;

  const filePath = writeReceiptNoClobber(dir, baseName, body);

  const rel = path.relative(root, filePath);
  const result = {
    ok: true,
    receipt: rel,
    target,
    action,
    mode,
    marker,
    // Repo-class-aware locality disposition — consumed by the tests and by any
    // caller scripting the ceremony. `repo_class: null` means .claude/VERSION
    // was unreadable, which fails CLOSED to commit_receipt: false.
    repo_class: repoClass,
    commit_receipt: commitReceipt,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    // Step 1 is REPO-CLASS-AWARE. The unconditional "commit the receipt" this
    // replaces is what operators followed verbatim at kailash-py / kailash-rs,
    // committing operator-correlatable receipts into a public-fork-lane history.
    const step1 = commitReceipt
      ? [
          `  1. Commit the receipt for durable team audit (this repo is type: ${repoClass}):`,
          `       git add ${rel} && git commit -m "chore(authz): cross-repo ${mode} authorization for ${target}"`,
        ]
      : [
          `  1. DO NOT COMMIT this receipt — leave it on disk (this repo is type: ${repoClass || "unknown"}, not coc-source).`,
          `       loom's sync gitignores .claude/cross-repo-authz/ here; the guard greps the`,
          `       WORKING TREE and ages this receipt by its own timestamp: frontmatter (6h),`,
          `       not by git, so enforcement is unaffected. Committing`,
          `       would put the requester's display_id in this repo's history, which none of`,
          `       loom's three distribution fences covers.`,
        ];
    process.stdout.write(
      [
        `✅ Cross-repo authorization receipt written: ${rel}`,
        `   target: ${target}   action (${mode}): ${action}`,
        `   marker: ${marker}`,
        "",
        "Next steps:",
        ...step1,
        `  2. Proceed with ONLY the named ${mode} against ONLY ${target} — no incidental scope creep.`,
        "",
      ].join("\n") + "\n",
    );
  }
  process.exit(0);
}

main();
