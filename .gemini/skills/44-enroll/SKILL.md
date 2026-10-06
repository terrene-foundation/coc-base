---
name: 44-enroll
description: /enroll procedure — register an operator into an existing ecosystem via /whoami --register (roster, PR-gated) + seed per-operator gitignored local-links, then hand off to /onboard.
---

# /enroll — Operator Enrollment Procedure

The procedure backing `.gemini/commands/enroll.toml` (the once-per-operator ceremony for joining an
ecosystem already configured by `/ecosystem-init`). The command body holds the three load-bearing
invariants; this skill holds the step-by-step procedure and the exact tool-call shapes.

Three onboarding surfaces (`rules/enrollment-operations.md`): `/onboard` (read, every session),
`/enroll` (operator, once), `/ecosystem-init` (fork, once). They share ZERO write-authority.

## Ceremony steps: B1 → B2 → B3

### B1 — roster registration (wraps `/whoami --register`)

Invoke the EXISTING `/whoami --register` path (`.gemini/commands/whoami.toml`). It is the ONLY roster-write
path (`multi-operator-coordination.md` §1); `/enroll` does NOT re-implement it. The `/whoami --register`
flow:

1. **Collect inputs**: `display_id` (advisory handle), `github_login` (or `principal` Entra UPN on an ADO
   ecosystem), `host_role` (`human` | `ci`), signing-key `{type: ssh|gpg, fingerprint, pubkey}`.
2. **Derive `person_id`** = `pid-<display_id>-<short-fingerprint>` (first 8 chars of sha256 of the pubkey
   body); immutable.
3. **Cut a feature branch** off `main`: `git checkout -b "codify/${display_id}-$(date -u +%Y-%m-%d)" origin/main`
   — NEVER write `operators.roster.json` directly to `main` (branch protection rejects it).
4. **Refuse-then-assign, then schema-validate.** The `person_id` is checked UP FRONT — before it is ever
   used as a map key — against `roster-schema-validate.js::isUnsafeMapKey`; an unsafe key is a typed
   refusal with NOTHING written. Only then is the entry assigned and the in-memory roster validated via
   the same module; a `valid: false` is a hard stop. The ordering is load-bearing: validate-AFTER-assign
   cannot catch this class, because `__proto__` mutates the prototype without creating an own key for the
   validator to see, and `constructor`/`prototype`/`toString` satisfy the schema's propertyNames pattern.
5. **Commit + push + open PR** — the PR enters the branch-protection + review chain. Merge is NEVER a
   direct push and NEVER an owner-self-attesting admin-merge (the §6.4 gate matrix's job).

New operators default to `role: contributor`. Promotion to `senior`/`owner` is a SEPARATE quorum gate
(`--owner-add` for owners, a 2-of-N roster edit for senior) — NOT part of `/enroll`.

**Business-role caveat (Q1).** The three business roles are the advisory `business_roles` enum at
`operators.roster.schema.json:94-105` (`platform-engineer` / `capability-engineer` / `business-consultant`),
ORTHOGONAL to the authority `role` and NEVER quorum-eligible (`multi-operator-coordination.md` §1).
`/enroll` places the operator into an AUTHORITY role; `business_roles` is an additive field the operator
or an owner may set later — it never touches the `display_id`/`verified_id`/`person_id` authority triple.
`product-owner` is NOT a roster value (the brief author sits outside the delivery substrate).

### The `--register` canonical writer

The step-4 writer, extracted from `commands/whoami.md` per `cc-artifacts.md` Rule 3 (reference
material → skills) when the `--add-key` ceremony landed.

**It is now COMMITTED at `.claude/bin/coc-roster-register.mjs` — do NOT author a scratch copy.**
It is run BY ITS OWN PATH as its own command, which is the shape
`validate-bash-command.js::detectStateFileMutationSegmentAware` sanctions for a canonical state-file
writer: the protected roster path stays inside the script body, never on the run command line. Being
committed rather than written to a temp path at ceremony time is what makes it reviewable in a diff and
testable in CI (`.claude/bin/coc-roster-register.test.mjs`, registered in `ci-suites-bin.json`) — a
ceremony script authored fresh into `/tmp` on each run is verified by nobody and can drift silently
between operators, which is the defect this replaced.

Its refusal contract (R1–R8, exit codes, and what each one preserves or adds) is printed by `--help` and
is NOT restated here per `specs-authority.md` Rule 9.

```bash
PERSON_ID="$person_id" DISPLAY_ID="$display_id" GH_LOGIN="$github_login" HOST_ROLE="$host_role" KEY_TYPE="$key_type" FP="$fp" PUBKEY="$pubkey" node .claude/bin/coc-roster-register.mjs
```

The historical temp-path form is retained below ONLY as the record of what the committed script
replaced. Do not run it.

```bash
cat > "${TMPDIR:-/tmp}/coc-roster-register.cjs" <<'CEREMONY'
const fs = require("fs");
const path = require("path");
const ROSTER = ".claude/operators.roster.json";
// require() resolves from the SCRIPT's dir (/tmp), not cwd; path.resolve rebinds to repo root.
const v = require(path.resolve(".claude/hooks/lib/roster-schema-validate.js"));
const r = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
const pid = process.env.PERSON_ID;
// Refuse an unsafe person_id UP FRONT — BEFORE any assignment. `constructor`,
// `prototype`, `toString`, `hasOwnProperty` all SATISFY the schema's
// propertyNames pattern, and `__proto__` assigns through the prototype SETTER
// without creating an own key at all — so assign-then-validate either accepts
// the key or silently no-ops while reporting success. Refusing first is the
// only ordering that leaves the roster untouched on refusal.
if (typeof pid !== "string" || !pid || v.isUnsafeMapKey(pid)) {
  console.error(`refused (unsafe-person-id): person_id ${JSON.stringify(pid)} shadows a JavaScript Object.prototype member and is never a legitimate person_id; nothing was written`);
  process.exit(1);
}
r.persons[pid] = {
  display_id: process.env.DISPLAY_ID,
  role: "contributor",
  github_login: process.env.GH_LOGIN,
  host_role: process.env.HOST_ROLE,
  keys: [{ type: process.env.KEY_TYPE, fingerprint: process.env.FP, pubkey: process.env.PUBKEY }],
};
const result = v.validate(r);
if (!result.valid) { console.error("schema validation failed:", result.errors); process.exit(1); }  // valid:false is a hard stop
fs.writeFileSync(ROSTER, JSON.stringify(r, null, 2) + "\n");
CEREMONY
```

Run it **from the repo root** — the cwd both the roster read and the `path.resolve(...)` lib lookup
resolve against — supplying every input ON the invocation. The script reads each from `process.env`, so
without the env prefix the run writes `undefined` and the schema validator fails closed (the documented
walk never completes a registration):

```bash
# SUPERSEDED — the committed script above is the one to run. Kept as the record
# of the temp-path form it replaced, so a reader who finds this shape in an older
# transcript can see why it is no longer used.
PERSON_ID="$person_id" DISPLAY_ID="$display_id" GH_LOGIN="$github_login" HOST_ROLE="$host_role" KEY_TYPE="$key_type" FP="$fp" PUBKEY="$pubkey" node "${TMPDIR:-/tmp}/coc-roster-register.cjs"
```

### Adding a key to an existing person_id

`--register` MINTS a new `person_id`. It is the WRONG ceremony for an operator who already has one and
just got a second machine, rotated to a new key, or wants to sign with ssh where they enrolled gpg.
Running `--register` for that produces a SECOND `person_id` for one human — which fragments the identity
`multi-operator-coordination.md` §1 designates as the unit of authority, and (once `authority` binds to a
signer role) leaves an owner unable to assert owner authority while signing with the fragment's key.

The right ceremony is `/whoami --add-key`, backed by `.claude/hooks/lib/add-key-ceremony.js`. Same
branch-then-PR shape as `--register`; `--apply` writes the WORKING TREE only.

```bash
git checkout -b "codify/addkey-$(date -u +%Y-%m-%d)" origin/main
node .claude/hooks/lib/add-key-ceremony.js --person-id "$pid" --new-key ~/.ssh/id_ed25519.pub           # plan
node .claude/hooks/lib/add-key-ceremony.js --person-id "$pid" --new-key ~/.ssh/id_ed25519.pub --apply   # write
git add .claude/operators.roster.json && git commit && git push -u origin HEAD && gh pr create
```

Four properties worth knowing before you run it:

1. **Self-service is PROVEN, not asserted.** The request is canonical-serialized and SIGNED with the
   caller's key, then verified against the pubkey the roster ALREADY stores for that fingerprint.
   Naming an enrolled fingerprint proves nothing — the roster is a committed file, so every enrolled
   fingerprint is public to anyone with a clone. The signed request binds both the target `person_id`
   and the new fingerprint, so a signature cannot be replayed onto a different add-key.
2. **Someone else's `person_id` is REFUSED** (`not-self-service`), not partially handled. That is a
   quorum-gated roster edit and belongs to a different ceremony.
3. **Append-only is re-checked, not assumed.** `assertAppendOnlyKeys` requires the pre-image key list to
   be a PREFIX of the post-image list, element-for-element — one predicate that rejects removal,
   replacement AND reorder at once (a set comparison would accept a reorder; a length comparison would
   accept a replacement). `assertIdentityInvariant` pins `role`, `github_login`, `principal`, `host_role`,
   `display_id`, `business_roles`, the `person_id` set, and the `genesis` block.
4. **`--check-against <candidate.json>`** runs both predicates over a roster diff the process did NOT
   construct. That is the reviewable form — the one a PR gate can run over a proposed
   `operators.roster.json` — and it is why they are predicates over two images rather than invariants
   claimed by the builder.

For GPG, `--new-key-type gpg --new-pubkey <armored-file>` is REQUIRED: there is no on-disk armored file
to infer, and shelling out to an ambient keyring would make the stored pubkey depend on which keyring
answered. A bare non-40-hex key id is refused rather than enrolled as a fingerprint that never resolves.

### B2 — local-links registration (per-operator, gitignored — invariant 2)

Write the operator's NAME→on-disk-path bindings to `loom-links.local.json`:

1. Copy the committed example `.claude/bin/loom-links.local.example.json` (it carries the canonical
   sublayout as synthetic tokens — `example/build/py`, `example/use/py`, peers `loom`/`atelier`).
2. Edit each binding to the operator's ACTUAL on-disk layout. The canonical sublayout hint
   (stated in full here; its loom/BUILD-side statement — `cross-repo.md` § "Canonical Sublayout
   (Recommended — F61)" — is NOT distributed to USE) is `~/repos/kailash/{build,use}/<slug>`
   with `~/repos/{loom,atelier}` as peers — but the resolver is layout-agnostic, so any layout works as
   long as it is declared.
3. NO disclosure gate — the file is gitignored and per-machine; it never syncs and never reaches a
   committed/public surface (contrast the ecosystem-SHARED `remote_links` in `/ecosystem-init` C1, which
   IS disclosure-fenced). Precedence: `$LOOM_LINKS_CONFIG` > `loom-links.local.json` > fail-loud
   (`loom-links.mjs`).

Pre-existing operators on any other layout (flat `~/repos/<slug>`, nested) proceed unchanged.

### B3 — hand off (invariant 3)

Print: "Enrollment PR opened — the roster row is live in your working tree now, and becomes team-visible
once the PR merges to `main`. Run `/onboard` at the start of every session." `/enroll` does NOT perform the
session-entry reads (roster + posture + team-memory + claims) — that is `/onboard`'s read-only job
(`knowledge-convergence.md` MUST-5).

The print string MUST NOT say "Enrolled": B1 step 5 ends at an OPEN PR (merge is never a direct push and
never an owner-self-attesting admin-merge), so a bare "Enrolled" claims a completion that has not happened.
Work is NOT blocked in the meantime — `resolveIdentity` reads the WORKING-TREE roster, so `/certify` and the
session-entry reads see the row before merge. Mirror any change to this string in `commands/enroll.md` § B3
in the SAME shard (`rules/command-skill-parity.md` MUST-2).

## Why a separate command (not a `/whoami` flag)

`/enroll` is intentionally thin (B1 delegates to `/whoami --register`, B2 is a local-file seed) but is a
SEPARATE command because the three named surfaces (`/onboard`/`/enroll`/`/ecosystem-init`) are the
`02-ga` core distinction — each names a distinct lifecycle moment, and folding `/enroll` into a
`/whoami --register --with-links` flag would lose the operator-facing surface name. The `02-ga` Q5
fold-vs-keep deliberation was adjudicated KEEP-SEPARATE at W8a redteam.

## Distinction from the other two surfaces

| If the operator…                             | Run               |
| -------------------------------------------- | ----------------- |
| is setting up a NEW fork (no ecosystem yet)  | `/ecosystem-init` |
| is JOINING an existing, configured ecosystem | `/enroll`         |
| is starting any session in a repo they're in | `/onboard`        |
