#!/usr/bin/env node
// remote-ref-reap.mjs — classify every remote branch ref by CONTENT and reap the
// ones whose content is already on the base branch.
//
// THE GAP THIS CLOSES. Local drainage was real and measured (branches 10 → 3,
// worktrees 8 → 2, each verified against origin) and it left 97% of the ref
// population untouched, because that population was REMOTE refs and nothing in
// the repo deletes one: `gh pr merge --delete-branch` reaps only a branch that
// had a PR, `git branch -d` reaps only the local ref, and the CI doctrine that
// makes a wave affordable — "a pushed branch with no open PR fires zero CI and
// is free" — is exactly what manufactures pushed-and-never-PR'd remote refs.
// Measured on loom the day this landed: 616 remote refs, 526 landed by
// ancestry, 24 landed by content, 66 carrying unlanded work.
//
// CONTENT, NEVER AGE. A 90-day branch whose content is on main is safe to delete
// regardless of age; a 10-day branch with unlanded work is not. Age is reported
// because it is cheap; it decides nothing.
//
// TWO LANDED VERDICTS, ONE OF THEM A HEURISTIC:
//
//   LANDED-ANCESTOR  `git merge-base --is-ancestor <ref> <base>` — the ref's
//                    tip IS on the base. Sound.
//   LANDED-CONTENT   the tip is not on the base but `git cherry <base> <ref>`
//                    emits no `+` line — every patch-id is present (a rebased,
//                    squashed or cherry-picked lane). A HEURISTIC: patch-ids
//                    ignore context, so `--apply` leaves this class alone unless
//                    `--include-content-landed` is passed.
//   UNLANDED         `git cherry` emits N `+` lines — MEASURED unlanded content.
//   CONTENT-UNMEASURED  the tip is not on the base and `git cherry` emitted NO
//                    line at all — every commit beyond the base is a MERGE or an
//                    EMPTY commit, which have no patch-id, so "no `+` line" here
//                    means nothing was measured, not that everything landed (an
//                    evil merge carries content in neither parent). Never reaped.
//   UNKNOWN          git could not answer; never reaped.
//
// PROVENANCE DECIDES FIRST, WHERE IT WAS RECORDED. Landing rewrites commits, so the two
// verdicts above misreport a replayed lane in BOTH directions (a conflict-resolved
// landing reads UNLANDED; a patch cherry-picked by hand reads LANDED-CONTENT). Where the
// repository records landings (`.claude/bin/landing-provenance.json`), each ref is first
// judged by `landedVerdicts` (`hooks/lib/landed-map.js`, symbol `landedVerdicts`) against
// the SAME base:
//
//   LANDED-PROVENANCE  `Landed-From` trailers on the base cover every commit of the
//                    branch AND every covering trailer is BACKED (`landed-map.js::
//                    landingBacking`): the landing ledger `land-lane` wrote at landing
//                    time names that source, branch and kind with a carrier of the same
//                    patch, or the carrier's own patch equals the source's. Reaped by
//                    `--apply` with no flag (archive first, merge scan still applies)
//                    ONLY when the base is a REMOTE-tracking ref of the swept remote;
//                    against a local `--base` it is reported, never deleted on. NOT
//                    recorded in the adjudication ledger (see below).
//   PROVENANCE-UNBACKED  covered by trailers, but at least one covering trailer is
//                    backed by NEITHER the landing ledger NOR the same change — trailer
//                    TEXT alone, which anyone who can push to the integration branch can
//                    write. Never deleted; each unbacked source -> carrier is listed.
//   UNLANDED         (decidedBy: provenance) forked after the cutover and not covered —
//                    even when its patch-ids ARE on the base. Never content-compared.
//   PROVENANCE-UNMEASURED  provenance could not answer for a branch it owns — including
//                    EVERY ref of a run whose map could not be built while the config
//                    exists (`no-map`); never reaped and never resolved by content. A
//                    `no-map` run REFUSES `--apply` outright (exit 2,
//                    `summary.refused = "provenance-unavailable"`), and
//                    `--include-content-landed` does not bypass that.
//
// ONLY a branch the verdict marks `fallback` (forked before the cutover, no commit of
// its own, or no config at all) takes the ancestry / patch-id path above. Every row carries
// `decidedBy` (provenance | ancestry | content | unmeasured) and the text report names
// the instrument on every line.
//
// A patch-id is a HISTORY fact, not a TREE fact: a branch whose patch matches a
// base commit that the base later REVERTED reads LANDED-CONTENT while its tree
// still differs. That is why the heuristic class is flag-gated and never default.
//
// THE VERDICT IS RECORDED, NOT THROWN AWAY. `--apply` writes the recovery ref AND,
// for every ref reaped on an ANCESTRY PROOF, a `landed` entry in
// `<toplevel>/.claude/ref-adjudications.json` carrying that proof. A ref reaped on
// the patch-id HEURISTIC gets NO entry and falls to the 30-day adjudication window
// (`check-archive-adjudication.mjs`). See § THE VERDICT IS RECORDED WHERE IT IS
// MEASURED below for why the two classes part company.
//
// SAFETY. Deleting a remote ref is visible to every clone and has no reflog on
// the remote. So (1) the default is REPORT-ONLY; (2) `--apply` first writes a
// LOCAL recovery ref `refs/archive/remote/<stamp>/<branch>` at the tip — in THIS
// clone only, never pushed, no reflog on the remote — then deletes on the remote;
// (4) the remote's own DEFAULT branch (the target of `refs/remotes/<remote>/HEAD`),
// the base, `HEAD`, and every `--protect` glob are never candidates; (3) a branch that is the head of an OPEN pull request
// is never reaped, and when the PR list cannot be read (`gh` missing or failing)
// `--apply` REFUSES (exit 2) rather than guessing — `--no-pr-check` is the
// explicit override for a remote without a PR forge; (5) the BASE itself must be
// corroborated as this repository's trunk before anything is deleted. A
// `COC_TRUNK_REF` override that merely RESOLVES is not enough: point it at a
// content SUPERSET of every lane and every lane reads landed. Such a base is
// REPORTED against and `--apply` REFUSES on it (exit 2, `summary.refused =
// "trunk-unverified"`) — see `hooks/lib/trunk-ref.js::resolveTrunkForDeletion`.
//
// USAGE
//   node .claude/bin/remote-ref-reap.mjs                    # report
//   node .claude/bin/remote-ref-reap.mjs --json             # machine-readable report
//   node .claude/bin/remote-ref-reap.mjs --apply            # reap LANDED-ANCESTOR refs (archive first)
//   node .claude/bin/remote-ref-reap.mjs --apply --include-content-landed
//   node .claude/bin/remote-ref-reap.mjs --only feat/x --only fix/y --apply
//   node .claude/bin/remote-ref-reap.mjs --remote origin --base origin/main
//   node .claude/bin/remote-ref-reap.mjs --protect "release/*" --protect develop --apply
//
// EXIT CODES  0 report written / every requested deletion succeeded;
//             1 usage, an unanswerable repository, or an unresolvable trunk;
//             2 --apply refused (unverified base, stale fetch, PR heads unknown)
//               or at least one deletion failed.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/entry-point.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { resolveGitBinary, gitEnvForArgs } = createRequire(import.meta.url)(path.join(HERE, "..", "hooks", "lib", "git-subprocess-env.js"));
// THE PROTECTION FLOOR, shared with the hook path rather than copied. MEASURED
// 2026-09-10: `preserve/s50-coord-predicate-983303d1` is LANDED-BY-CONTENT on
// origin/main, so a ref named for its own preservation was one
// `--apply --include-content-landed` away from deletion — the default
// `--protect` set was EMPTY. `isProtectedName` is the same predicate
// `reap-on-landing.js::classify` guards with; ONE function, never N copies
// (`security.md` § Enforcement-Surface Parity).
const { isProtectedName, PROTECTED_PREFIXES } = createRequire(import.meta.url)(path.join(HERE, "..", "hooks", "lib", "reap-on-landing.js"));
// THE DELETION-GRADE RESOLVER, not the lenient `trunkRef` this tool used to call.
// `trunkRef`'s own docblock (`trunk-ref.js:224-237`) says it "CANNOT distinguish a
// real trunk from a guess" and returns a `COC_TRUNK_REF` override AS DECLARED
// without probing it at all. That is tolerable for a surface that only READS
// landedness — a wrong base makes FEWER branches look landed, so it under-reports
// — and it is the wrong bar for THIS tool, which deletes refs on a REMOTE where
// there is no reflog. The error direction inverts: a base that merely CONTAINS
// every lane's content makes every lane read landed. `resolveTrunkForDeletion`
// accepts an override only when corroborated by a source the operator does not
// control through that one variable (`refs/remotes/<remote>/HEAD`, `<remote>/dev`,
// `<remote>/main`), and returns a THIRD verdict `"unverified"` for anything else.
const { resolveTrunkForDeletion } = createRequire(import.meta.url)(path.join(HERE, "..", "hooks", "lib", "trunk-ref.js"));
// LANDING PROVENANCE, READ BEFORE ANY CONTENT COMPARISON. Landing rewrites commits
// (replay, squash, conflict fix), so after the fact neither ancestry nor patch-ids
// can say whether a branch was landed: a conflict-resolved landing reads UNLANDED
// here and a patch cherry-picked by hand reads LANDED-CONTENT. The lander RECORDS
// the link as trailers on the integration branch (`Landed-From: <branch>@<sha>`), and
// `landedVerdict` (hooks/lib/landed-map.js::landedVerdict) is the ONE policy every "is this
// branch landed?" tool applies. See `decideRefVerdict` below.
const landedMap = createRequire(import.meta.url)(path.join(HERE, "..", "hooks", "lib", "landed-map.js"));

/**
 * Apply the landed-map policy to ONE ref. Pure. `v` is `landedVerdict(...)`
 * (landed-map.js::landedVerdict), or null when no map was consulted; `legacy` is a thunk
 * running this tool's pre-provenance ancestry + `git cherry` classification and
 * returning `{ verdict, unlanded, decidedBy }`.
 *
 *   decided                  -> the RECORD decides; `legacy` is NEVER called. A
 *                               trailer-covered branch is LANDED-PROVENANCE even when
 *                               it is not the same change (a conflict-resolved landing); a
 *                               post-cutover branch with no covering trailer is
 *                               UNLANDED even when its patch IS on the base.
 *   fallback (predates, ancestry, no-config)
 *                            -> ONLY here does the legacy comparison run.
 *   neither (unknown, and no-map: a config whose map cannot be built)
 *                            -> PROVENANCE-UNMEASURED: never landed, never reaped, and
 *                               NOT resolved by content, because the one instrument
 *                               entitled to answer for this branch failed.
 */
export function decideRefVerdict(v, legacy) {
  if (v && v.decided) {
    return v.landed
      ? { verdict: "LANDED-PROVENANCE", unlanded: 0, decidedBy: "provenance" }
      : { verdict: "UNLANDED", unlanded: (v.outstanding || []).length, decidedBy: "provenance" };
  }
  if (!v || v.fallback) return legacy();
  return { verdict: "PROVENANCE-UNMEASURED", unlanded: null, decidedBy: "unmeasured" };
}

/**
 * The instrument that decided a row, in words, so a reader can tell a RECORDED
 * landing from a RECONSTRUCTED one. Pure.
 */
export function instrumentLabel(entry, base) {
  const p = entry.provenance || {};
  const tip = p.tip ? p.tip.slice(0, 12) : "?";
  const why = p.status === "predates" ? "branch predates recording"
    : p.status === "ancestry" ? "no commit of its own beyond the base"
      : p.status === "no-config" ? "landing provenance not recorded in this repository"
        : p.status === "no-map" ? `provenance map UNAVAILABLE: ${p.why || "no reason recorded"}`
          : p.status || "no provenance consulted";
  switch (entry.decidedBy) {
    case "provenance":
      if (entry.verdict === "LANDED-PROVENANCE") return `provenance: Landed-From trailers on ${base}@${tip}, backed by the landing ledger or the same change`;
      if (entry.verdict === "PROVENANCE-UNBACKED") {
        const n = ((entry.backing && entry.backing.unbacked) || []).length;
        return `provenance: Landed-From trailers on ${base}@${tip} claim it, but ${n} source commit(s) are backed by NEITHER the landing ledger NOR the same change — trailer text alone; NOT deletable (${entry.remedy})`;
      }
      return `provenance: ${p.status}, ${entry.unlanded} source commit(s) with no landing trailer on ${base}@${tip}`;
    case "ancestry": return `ancestry: tip is an ancestor of ${base} (${why})`;
    case "content": return `content: git cherry patch-ids (${why})`;
    case "unmeasured": return `UNMEASURED: provenance could not answer (${p.why || p.status || "unknown"}); not resolved by content`;
    default: return `git could not answer (${why})`;
  }
}

function main() {
  const GIT = resolveGitBinary();
  if (!GIT) { process.stderr.write("remote-ref-reap: no usable git binary on PATH\n"); process.exit(1); }
  // THE ENVELOPE IS CHOSEN PER CALL, NOT ONCE. This tool is the MIXED-WRAPPER shape
  // `git-subprocess-env.js:636-688` was written for: most of its calls are local reads
  // (`for-each-ref`, `cherry`, `merge-base`, `rev-list`, `diff-tree`, `update-ref`) and
  // TWO of them reach the remote — `fetch --prune` and the `push --delete` that IS the
  // tool's whole purpose. Both of those are in `NET_SUBCOMMANDS`
  // (`git-subprocess-env.js:626-634`).
  //
  // A single frozen `gitEnv()` is therefore wrong for one half of the calls whichever
  // half it is built for, and this tool had frozen the TIGHT one: MEASURED with a
  // recording `core.sshCommand` against an `ssh://` remote, the `push --delete` child's
  // environment carried NO `SSH_AUTH_SOCK` line at all, so agent auth, proxy routing and
  // TLS trust anchors were all stripped from the one call that needs them. On any host
  // that reaches its forge through an agent, a proxy or an intercepting CA that is a
  // delete which archives locally and then FAILS (exit 2) — and, worse, a `fetch --prune`
  // whose failure `git()` discards as `null`, so the whole classification then runs
  // against a STALE ref list while reporting success. The helper names that outcome for
  // exactly this shape — "not fail-closed, it is fail-BROKEN"
  // (`git-subprocess-env.js:667-673`).
  //
  // `gitEnvForArgs` keeps least privilege as the default — an unrecognised subcommand
  // gets the tight profile — so this widens nothing for the local reads.
  const gitEnvFor = (args) => gitEnvForArgs(args);

  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const values = (flag) => argv.reduce((a, x, i) => (x === flag && argv[i + 1] && !argv[i + 1].startsWith("--") ? a.concat(argv[i + 1]) : a), []); // a following flag is never a value: `--only --apply` must not swallow the apply
  const onlys = values("--only");
  const protects = values("--protect");
  // `--ledger` gets the F8 treatment on its own account: `val()` would happily take a
  // following FLAG as the path, which would write a junk file named `--apply` AND
  // consume the apply. The sibling holes in `--remote`/`--base` are NOT widened or
  // closed here — changing how an existing flag parses is a behaviour change this
  // change does not carry.
  const ledgerGiven = (() => {
    const i = argv.indexOf("--ledger");
    if (i < 0) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) {
      process.stderr.write("remote-ref-reap: --ledger needs a path, and a value that looks like a flag is never consumed — re-run with an explicit path.\n");
      process.exit(1);
    }
    return v;
  })();
  // F8 — AN UNPARSED RESTRICTION IS NOT AN ABSENT RESTRICTION. `values()` refuses to
  // consume a following FLAG as a value, which is right; what was wrong is what happened
  // next. `--only --apply` left `onlys` EMPTY, and empty means "sweep everything", so a
  // typo that DROPPED the restriction silently widened the sweep from one branch to the
  // whole remote — on the run that also carried `--apply`. The safe reading of a
  // restriction the tool could not parse is REFUSAL, never the unrestricted set.
  for (const flag of ["--only", "--protect"]) {
    const appearances = argv.filter((x) => x === flag).length;
    const accepted = flag === "--only" ? onlys.length : protects.length;
    if (appearances > accepted) {
      process.stderr.write(`remote-ref-reap: ${flag} given ${appearances} time(s) but only ${accepted} value(s) accepted — a value that looks like a flag is never consumed, and an unparsed restriction MUST NOT read as 'no restriction'. Re-run with an explicit value.\n`);
      process.exit(1);
    }
  }

  if (has("--help") || has("-h")) {
    process.stdout.write([
      "remote-ref-reap — classify remote branch refs by CONTENT; reap the landed ones",
      "",
      "  --remote <name>            remote to sweep (default: origin)",
      "  --base <ref>               base the content is measured against (default: <remote>/main)",
      "  --only <branch>            restrict to named branch(es); repeatable",
      "  --protect <glob>           never a candidate (exact name or * glob); repeatable. WIDENS the floor",
      "                             below, never narrows it. The remote's default branch, the base and",
      "                             HEAD are always protected, as are the preserve/ backup/ salvage/ wip/",
      "                             namespaces (reported as summary.protectedByFloor)",
      "  --json                     machine-readable report",
      "  --apply                    write a LOCAL recovery ref refs/archive/remote/<stamp>/<branch>, then delete on the remote",
      "  --include-content-landed   with --apply, also reap LANDED-CONTENT (patch-id heuristic)",
      "  --no-pr-check              with --apply, skip the open-PR head check (no forge, or gh unavailable)",
      "  --no-fetch                 do not `git fetch --prune` first",
      "  --ledger <path>            adjudication ledger to record into (default: <toplevel>/.claude/ref-adjudications.json)",
      "  --no-record                with --apply, do NOT record a verdict for the refs archived",
      "",
      "Default is REPORT-ONLY. Age is reported, never used to decide.",
      "Under --apply, every ref archived on an ANCESTRY PROOF (LANDED-ANCESTOR) also gets a",
      "`landed` verdict written to the ledger, carrying the proof that established it. A ref",
      "archived on the patch-id HEURISTIC (LANDED-CONTENT) gets NO entry: the heuristic did not",
      "establish landedness, and a terminal verdict it cannot support is worse than none.",
    ].join("\n") + "\n");
    process.exit(0);
  }

  const REMOTE = val("--remote", "origin");
  const BASE_GIVEN = val("--base", null);
  const APPLY = has("--apply");
  const INCLUDE_CONTENT = has("--include-content-landed");
  const NO_PR_CHECK = has("--no-pr-check");
  const JSON_OUT = has("--json");
  const NO_FETCH = has("--no-fetch");
  const NO_RECORD = has("--no-record");
  const cwd = process.cwd();

  function git(args) {
    const r = spawnSync(GIT, args, { cwd, encoding: "utf8", timeout: 60000, env: gitEnvFor(args) });
    if (r.error || r.status !== 0) return null; // INDETERMINATE for every caller; each treats null as "could not answer"
    return (r.stdout || "").replace(/\n$/, "");
  }

  const top = git(["rev-parse", "--show-toplevel"]);
  if (top === null) { process.stderr.write("remote-ref-reap: not inside a git repository\n"); process.exit(1); }
  // F1 — THE FETCH'S RETURN VALUE IS THE WHOLE POINT OF FETCHING. This call used to be
  // issued and DISCARDED. `git()` returns null on failure, so a fetch that could not
  // reach the remote left the run measuring a STALE remote-tracking ref list while every
  // surface reported success — a ref deleted upstream still reads as a live candidate,
  // and a branch pushed upstream since the last fetch is invisible. Staleness is not a
  // cosmetic defect for a tool that DELETES: it is classification against a world that no
  // longer exists. `--apply` therefore REFUSES, and a report-only run DECLARES it.
  let fetchFailed = false;
  if (!NO_FETCH && git(["fetch", "--prune", "--quiet", REMOTE]) === null) fetchFailed = true;
  // The base defaults to the remote's DECLARED default branch (refs/remotes/<remote>/HEAD), the same
  // source the WIP guard's door reads, so the two instruments never measure against different bases.
  const headTarget = git(["symbolic-ref", "-q", `refs/remotes/${REMOTE}/HEAD`]);
  const DEFAULT_BRANCH = headTarget && headTarget.startsWith(`refs/remotes/${REMOTE}/`) ? headTarget.slice(`refs/remotes/${REMOTE}/`.length) : null;
  // THE INTEGRATION TRUNK (directive 2026-09-10). Composed, not replaced: when no
  // override and no dev exist, the resolver yields `<remote>/main` and the remote's
  // DECLARED default still wins, so behaviour is unchanged for any repo that has
  // not adopted dev. Explicit --base beats everything, as before.
  const TRUNK_D = resolveTrunkForDeletion({ repoDir: cwd, remote: REMOTE });
  // THREE VERDICTS, AND THEY DO NOT COLLAPSE INTO TWO.
  //
  // UNDETERMINED — no usable ref at all (an override that does not resolve, or a
  // tree git could not probe). There is no base to report against, which is what
  // this tool ALREADY did about it: the old code handed the unresolvable override
  // straight to `BASE` and exited 1 at the `BASE_SHA` check. Same exit, with the
  // reason NAMED instead of a bare "does not resolve".
  if (!BASE_GIVEN && TRUNK_D.status === "undetermined") {
    process.stderr.write(`remote-ref-reap: the integration trunk could not be resolved — ${TRUNK_D.reason || "no reason was recorded"}. Nothing was classified and nothing was deleted; pass --base <ref> to name the base explicitly.\n`);
    process.exit(1);
  }
  // UNVERIFIED — a ref that RESOLVES but is not shown to be this repository's trunk.
  // REPORTING stays on (it is still the base the operator asked for) and every
  // DELETION is withheld: `--apply` REFUSES below, and the report says so rather
  // than printing a "would delete N" sentence that is false.
  //
  // SCOPED TO THE RESOLVER, NOT TO `--base`. An explicit `--base <ref>` is an argv
  // token the operator types on the same command line as `--apply`; `COC_TRUNK_REF`
  // is AMBIENT — inheritable from a shell profile or a parent process, and invisible
  // on the destructive command line. Those are different trust classes, and this is a
  // decision rather than an oversight: widening the gate to `--base` would also change
  // how a documented flag behaves, which is not this finding.
  const BASE_UNVERIFIED = !BASE_GIVEN && TRUNK_D.status === "unverified" ? TRUNK_D.reason : null;
  const TRUNK = TRUNK_D.ref;
  // Composition unchanged, INCLUDING the string compare: `<remote>/main` from the
  // fallback ladder still defers to the remote's DECLARED default, so a repo whose
  // default is not `main` behaves exactly as before.
  const BASE = BASE_GIVEN || (TRUNK !== `${REMOTE}/main`
    ? TRUNK
    : (DEFAULT_BRANCH ? `${REMOTE}/${DEFAULT_BRANCH}` : `${REMOTE}/main`));
  // The sha, not just the name: it is what makes a recorded verdict RE-DERIVABLE by a
  // stranger months later. `<remote>/dev` names a moving target; the sha names the
  // commit the ancestry proof was actually taken against.
  const BASE_SHA = git(["rev-parse", "--verify", "--quiet", BASE]);
  if (BASE_SHA === null) { process.stderr.write(`remote-ref-reap: base ref ${BASE} does not resolve\n`); process.exit(1); }
  // THE PROVENANCE MAP — built ONCE per run, against the SAME base sha every verdict
  // below is measured against. `!MAP.ok` is never an empty map: with no config the
  // legacy classification is unchanged; with a config whose map cannot be built the run
  // says so LOUDLY, every verdict is UNMEASURED (the core's `no-map` verdict is
  // `fallback:false`, `landed-map.js::landedVerdicts`), and `--apply` REFUSES below.
  //
  // `useCache: false` — this is a DESTRUCTIVE path. The cache is keyed by (tip,
  // cutover) and is only a speed-up, but it is a file any process on this machine can
  // write (`<git-common-dir>/landed-map-cache.json`); a deletion must rest on the
  // trailers as they are in the object store NOW, never on a cached reading of them.
  //
  // WHICH CONFIG: the one COMMITTED at the base being judged (`landed-map.js::loadConfigAt`),
  // the working tree's only when the base carries none. Whether this repository records
  // landings is a property of the integration branch, not of the checkout the tool is run
  // from; read from the working tree alone, a checkout without the file (an older
  // worktree) took the legacy path and judged post-cutover lanes by patch-id.
  const CONFIG_AT = landedMap.loadConfigAt(top, BASE_SHA);
  const MAP = CONFIG_AT.absent
    ? landedMap.buildLandedMap({ repoDir: top, ref: BASE_SHA, useCache: false })
    : CONFIG_AT.ok
      ? landedMap.buildLandedMap({ repoDir: top, ref: BASE_SHA, config: CONFIG_AT.config, useCache: false })
      : { ok: false, noConfig: false, why: `the config committed at ${BASE} is unreadable: ${CONFIG_AT.why}` };
  // PROVENANCE MAY ONLY AUTHORIZE A DELETION WHEN THE BASE IS A REMOTE-TRACKING REF.
  // Trailers on a LOCAL branch are written by whoever holds this clone — an unpushed
  // local `dev` with a hand-made `Landed-From` naming any branch would otherwise make
  // that branch deletable ON THE REMOTE, for every clone. So with a local `--base` (or a
  // bare sha) provenance verdicts are still COMPUTED and REPORTED, but never
  // apply-eligible. `--symbolic-full-name` names the ref BASE resolves to; a sha or an
  // unresolvable name yields no `refs/remotes/<remote>/` prefix ⇒ not eligible.
  //
  // A REMOTE-TRACKING BASE IS NECESSARY, NOT SUFFICIENT. Nothing vets the trailers on the
  // remote's integration branch either: `dev` runs no CI, and the push gate that checks a
  // `Landed-From` value runs only in a clone where that hook is installed — a `git push
  // --no-verify`, or any clone without the hook, puts trailer TEXT on `origin/dev`
  // unchecked. So every LANDED-PROVENANCE ref must ALSO be BACKED
  // (`landed-map.js::landingBacking`, applied in `applyBacking` below) before it is
  // deletable; an unbacked one is PROVENANCE-UNBACKED and never deleted.
  const BASE_FULL = git(["rev-parse", "--symbolic-full-name", BASE]) || "";
  const BASE_REMOTE_TRACKING = BASE_FULL.startsWith(`refs/remotes/${REMOTE}/`);
  const PROVENANCE = MAP.ok
    ? { status: "ok", ref: BASE, refFull: BASE_FULL || null, tip: MAP.tip, cutover: MAP.cutover, cached: MAP.cached, invalidTrailers: MAP.invalid.length, why: null, applyEligible: BASE_REMOTE_TRACKING }
    : { status: MAP.noConfig ? "no-config" : "no-map", ref: BASE, refFull: BASE_FULL || null, tip: null, cutover: null, cached: false, invalidTrailers: 0, why: MAP.why, applyEligible: false };
  if (PROVENANCE.status === "no-map") process.stderr.write(`remote-ref-reap: LANDING PROVENANCE UNAVAILABLE — ${MAP.why}. This repository records landings, so no verdict below is resolved by ancestry/patch-id: every ref is UNMEASURED, and --apply REFUSES.\n`);
  if (MAP.ok && !BASE_REMOTE_TRACKING) process.stderr.write(`remote-ref-reap: base ${BASE} is not a remote-tracking ref of ${REMOTE} (resolves to ${BASE_FULL || "no symbolic ref"}); LANDED-PROVENANCE verdicts are REPORTED but never deleted on — trailers on a local ref were written by this clone alone.\n`);
  if (MAP.ok && MAP.invalid.length) process.stderr.write(`remote-ref-reap: WARNING ${MAP.invalid.length} unreadable landing trailer(s) on ${BASE}; run \`node .claude/bin/landed-map.mjs --ref ${BASE_SHA}\` to list them.\n`);

  const baseBranch = BASE.startsWith(`${REMOTE}/`) ? BASE.slice(REMOTE.length + 1) : null;
  const raw = git(["for-each-ref", `refs/remotes/${REMOTE}/`, "--format=%(refname)%09%(objectname)%09%(committerdate:unix)"]);
  if (raw === null) { process.stderr.write("remote-ref-reap: could not enumerate remote refs\n"); process.exit(1); }

  // Local branches and what they track — reported, not decided on: deleting a
  // tracked remote ref leaves the local branch intact with a stale upstream.
  const tracking = new Map();
  for (const line of (git(["for-each-ref", "refs/heads/", "--format=%(refname:short)%09%(upstream:short)"]) || "").split("\n")) {
    const [local, up] = line.split("\t"); if (up) tracking.set(up, (tracking.get(up) || []).concat(local));
  }

  // Open PR heads: an open PR's head is never reaped. Unknown ⇒ --apply refuses.
  const PR_LIMIT = 500;
  function openPrHeads() {
    if (NO_PR_CHECK) return { known: true, heads: new Set(), skipped: true };
    const gh = process.env.COC_GH_BIN || "gh";
    // F5 — THE GATE MUST ANSWER ABOUT THE REPOSITORY BEING DELETED FROM. `gh pr list`
    // with no `--repo` resolves the forge from the CWD's git remotes, which is a
    // DIFFERENT question from "what is open on the remote this run is reaping". Under
    // `--remote upstream` the two diverge outright, and the answer still looked valid.
    const url = git(["remote", "get-url", REMOTE]);
    const args = ["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "headRefName"];
    if (url) args.push("--repo", url);
    // F7 — the child gets an EXPLICIT environment rather than this process's whole one.
    // `gh` genuinely needs a credential source, so the allowlist is deliberately narrow
    // and named; anything absent from it simply does not reach the child.
    const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "", GH_TOKEN: process.env.GH_TOKEN || "", GITHUB_TOKEN: process.env.GITHUB_TOKEN || "", GH_HOST: process.env.GH_HOST || "", GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || "", NO_COLOR: "1" };
    for (const k of Object.keys(env)) if (env[k] === "") delete env[k];
    const r = spawnSync(gh, args, { cwd, encoding: "utf8", timeout: 60000, env });
    if (r.error || r.status !== 0) return { known: false, heads: new Set(), skipped: false, error: r.error ? r.error.message : (r.stderr || "").trim().slice(0, 200) };
    try {
      const rows = JSON.parse(r.stdout);
      // F4 — A TRUNCATED LIST IS INDISTINGUISHABLE FROM A COMPLETE ONE. At exactly the
      // limit the answer is "at least this many", and the heads beyond it are unknown —
      // so an open PR could be missing from the set and its branch reaped. Refuse.
      if (Array.isArray(rows) && rows.length >= PR_LIMIT) {
        return { known: false, heads: new Set(), skipped: false, error: `open PR list hit the --limit ${PR_LIMIT} ceiling; the heads beyond it are UNKNOWN, so an open PR's branch could be reaped` };
      }
      return { known: true, heads: new Set(rows.map((p) => p.headRefName)), skipped: false };
    } catch (e) { return { known: false, heads: new Set(), skipped: false, error: e.message }; }
  }
  const pr = openPrHeads();

  const globMatch = (glob, name) => new RegExp("^" + glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name);
  const now = Math.floor(Date.now() / 1000);
  const refs = [];
  const skipped = [];
  const protectedByFloor = [];
  // --protect skips were SILENT while floor skips were reported, so an operator
  // passing --protect saw a total that had quietly shrunk. Same disclosure either way.
  const protectedByGlob = [];
  // THE MASKED-MERGE HOLE, closed 2026-09-08. The legacy classifier already refuses the merge-ONLY
  // case, but a branch whose non-merge commits ALL matched upstream while it ALSO carries a
  // merge with content in neither parent scores LANDED-CONTENT and was eligible under
  // `--include-content-landed`. `git cherry` cannot see it: merges have NO patch-id, so the
  // matched siblings mask the merge entirely.
  //
  // MEASURED on this repo, which is why this is not a hypothetical: `wip/1475-batched-gitrun`
  // is a PUSHED GIT STASH — a 3-parent commit whose combined diff is 81123 B of content
  // present in none of its parents (`_gitRun` stdin plumbing absent from the base). It scored
  // LANDED-CONTENT, and a bare `--apply --include-content-landed` would have deleted it.
  //
  // The combined diff (`diff-tree --cc`) is exactly the right instrument: it reports ONLY
  // hunks that differ from EVERY parent, so a non-empty result IS content the patch-id scan
  // structurally could not have measured. Empty is the ordinary case and costs one call per
  // candidate ref.
  //
  // Applied to LANDED-CONTENT (patch-ids cannot see a merge) AND to LANDED-PROVENANCE: a
  // trailer covers the branch's NON-MERGE commits only (`rev-list --no-merges`,
  // landed-map.js::branchStatus), so a merge carrying content in NO parent is invisible to it too.
  function scanMerges(entry) {
    const merges = git(["rev-list", "--merges", `${BASE}..${entry.sha}`]);
    if (merges === null) {
      // The scan itself failed. A check that could not run is NOT a clean answer, so the ref
      // stops being reap-eligible rather than defaulting to safe-looking silence.
      entry.mergeScan = "FAILED";
      entry.mergeCarriesContent = true;
    } else {
      const shas = merges.split("\n").filter(Boolean);
      entry.mergeScan = shas.length ? `${shas.length} merge(s)` : "no merges";
      let carried = 0;
      for (const m of shas) {
        const cc = git(["diff-tree", "--cc", "--no-commit-id", m]);
        if (cc === null) { carried = -1; break; }          // unreadable ⇒ treat as carrying
        if (cc.trim()) carried += 1;
      }
      entry.mergeCarriesContent = carried !== 0;
      if (carried > 0) entry.mergeScan += ` — ${carried} carrying content in NO parent`;
      if (carried < 0) entry.mergeScan += " — combined diff unreadable";
    }
  }

  const pending = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [full, sha, ts] = line.split("\t");
    // The FULL refname, never `refname:short`: git shortens `refs/remotes/origin/HEAD`
    // to the bare `origin`, which would enter the sweep as a branch named after the remote.
    const prefix = `refs/remotes/${REMOTE}/`;
    if (!full.startsWith(prefix)) continue;
    const branch = full.slice(prefix.length);
    const short = `${REMOTE}/${branch}`;
    if (branch === "HEAD" || (baseBranch && branch === baseBranch) || branch === DEFAULT_BRANCH) continue;
    // F2 — A NAME BEGINNING WITH `-` IS SKIPPED LOUDLY, NEVER PASSED ALONG. spawnSync
    // with an argument array defeats the SHELL, so such a name cannot inject a command —
    // but it is still handed to git as its own argv token, where git's own parser may
    // read it as an OPTION rather than a value. Refusing the class is cheaper than
    // reasoning about which of git's parsers are option-terminated.
    if (branch.startsWith("-")) { skipped.push(branch); continue; }
    // The FLOOR first — a caller may widen protection with --protect, never narrow it.
    if (isProtectedName(branch)) { protectedByFloor.push(branch); continue; }
    if (protects.some((g) => globMatch(g, branch))) { protectedByGlob.push(branch); continue; } // a protected long-lived branch is never a candidate, whatever its verdict
    if (onlys.length && !onlys.includes(branch)) continue;
    const entry = { ref: short, branch, sha, ageDays: ts ? Math.round((now - Number(ts)) / 86400) : null, trackedBy: tracking.get(short) || [], prOpen: pr.known ? pr.heads.has(branch) : null, verdict: "UNKNOWN", unlanded: null, archived: null, deleted: false, adjudicated: null, error: null };
    // PROVENANCE FIRST (`decideRefVerdict` above). This legacy ancestry + patch-id path
    // runs ONLY when the verdict says `fallback`; a DECIDED verdict never content-compares.
    const legacy = () => {
      const out = { verdict: "UNKNOWN", unlanded: null, decidedBy: "none" };
      const ancArgs = ["merge-base", "--is-ancestor", sha, BASE];
      const anc = spawnSync(GIT, ancArgs, { cwd, encoding: "utf8", timeout: 30000, env: gitEnvFor(ancArgs) });
      if (anc.status === 0) out.verdict = "LANDED-ANCESTOR";
      else if (anc.status === 1) {
        const cherry = git(["cherry", BASE, sha]);
        if (cherry === null) out.verdict = "UNKNOWN";
        else {
          const lines = cherry.split("\n").filter(Boolean);
          const n = lines.filter((l) => l.startsWith("+")).length;
          out.unlanded = n;
          // NO line at all means no patch-id was measured (merge-only or empty commits beyond the base) —
          // that is "unmeasured", never "landed": an evil merge carries content in neither parent.
          out.verdict = lines.length === 0 ? "CONTENT-UNMEASURED" : n === 0 ? "LANDED-CONTENT" : "UNLANDED";
        }
      }
      if (out.verdict === "LANDED-ANCESTOR") out.decidedBy = "ancestry";
      else if (out.verdict !== "UNKNOWN") out.decidedBy = "content";
      return out;
    };
    pending.push({ entry, full, legacy });
  }
  // ONE bulk provenance pass over every candidate, with the tips THIS run enumerated
  // (`landedVerdicts`, hooks/lib/landed-map.js::landedVerdicts): the verdict and any deletion
  // judge the same sha, and a ref that moves after the read is caught by the lease.
  const verdicts = landedMap.landedVerdicts({ repoDir: top, branches: pending.map((p) => ({ ref: p.full, name: p.entry.branch, tip: p.entry.sha })), map: MAP, ref: BASE_SHA });
  // THE LANDING LEDGER, read ONCE per run (`landed-map.js::readLandingLedger`): what
  // `land-lane` recorded, in this clone's common dir, as it replayed each source commit.
  // Read lazily — only a run with a LANDED-PROVENANCE row needs it.
  let LEDGER = null;
  // A TRAILER IS TEXT; BACKING IS EVIDENCE. `Landed-From: <branch>@<sha>` on the base is
  // what made the ref LANDED-PROVENANCE, and anyone who can push to the integration
  // branch can type one (see "A REMOTE-TRACKING BASE IS NECESSARY, NOT SUFFICIENT" above:
  // nothing vets `origin/dev` off a hook-installed clone). Before the ref is deletable, every covering trailer must
  // be backed by the landing ledger or by the same change (`landed-map.js::landingBacking` / `::sameChange`);
  // otherwise it is PROVENANCE-UNBACKED. Own commits are the branch's non-merge commits
  // not on the map tip — the set the trailers were judged over.
  function applyBacking(entry) {
    let backing;
    try {
      const own = git(["rev-list", "--no-merges", entry.sha, `^${MAP.tip}`]);
      if (own === null) throw new Error(`could not list the own commits of ${entry.ref} beyond ${MAP.tip.slice(0, 12)}`);
      if (LEDGER === null) LEDGER = landedMap.readLandingLedger(top);
      backing = landedMap.landingBacking(top, { map: MAP, own: own.split("\n").filter(Boolean), ledger: LEDGER });
    } catch (e) {
      // A check that could not RUN is never a backed answer.
      backing = { backed: false, unbacked: [{ source: null, carrier: null, why: `backing could not be measured: ${e.message}` }] };
    }
    entry.backing = { backed: backing.backed === true, unbacked: backing.unbacked || [] };
    if (!entry.backing.backed) {
      entry.verdict = "PROVENANCE-UNBACKED";
      entry.remedy = "verify by hand; retire applies the same binding";
    }
  }
  pending.forEach(({ entry, legacy }, i) => {
    const v = verdicts[i];
    entry.provenance = { status: v.status, decided: Boolean(v.decided), tip: MAP.ok ? MAP.tip : null, landedCommits: v.landedCommits || [], outstanding: v.outstanding || [], why: v.why || null };
    const d = decideRefVerdict(v, legacy);
    entry.verdict = d.verdict;
    entry.unlanded = d.unlanded;
    entry.decidedBy = d.decidedBy;
    if (entry.verdict === "LANDED-PROVENANCE") applyBacking(entry);
    if (entry.verdict === "LANDED-CONTENT" || entry.verdict === "LANDED-PROVENANCE") scanMerges(entry);
    refs.push(entry);
  });

  // ── THE VERDICT IS RECORDED WHERE IT IS MEASURED ────────────────────────────
  //
  // THE DEFECT THIS CLOSES. This tool already COMPUTES landedness — that is how it
  // chooses what to reap. It then threw that verdict away and wrote a bare recovery
  // ref at `refs/archive/remote/<stamp>/<branch>`, so months later the same question
  // had to be answered again from scratch. The artifact was created at the moment of
  // MAXIMUM information and adjudicated at the moment of MINIMUM. MEASURED on this
  // repo 2026-09-11: a full content adjudication of 615 archive refs cost an entire
  // pass to discover that 93% of the non-ancestor tail was noise.
  //
  // ONLY AN ANCESTRY PROOF IS RECORDABLE, and this is the whole discrimination.
  //
  //   LANDED-ANCESTOR  `git merge-base --is-ancestor <sha> <base>` exit 0. The tip IS
  //                    reachable from the base. A PROOF; it is what `landed` means,
  //                    and `check-archive-adjudication.mjs` admits an agent-written
  //                    `landed` precisely because it is a MEASUREMENT. Recorded, with
  //                    the proof inline so a stranger can re-run it.
  //
  //   LANDED-CONTENT   a patch-id match with NO ancestry. This tool's own header
  //                    calls it a HEURISTIC and says why: "a patch-id is a HISTORY
  //                    fact, not a TREE fact", so a branch whose patch matches a base
  //                    commit the base later REVERTED reads LANDED-CONTENT while its
  //                    tree still differs. It is enough to justify a deletion the
  //                    operator opted into with `--include-content-landed`; it is NOT
  //                    enough to justify a TERMINAL verdict that silences the recovery
  //                    ref for good. NO ENTRY — the ref falls to the 30-day window and
  //                    gets a human. That is the correct outcome, not a gap: MEASURED
  //                    on this repo, the non-ancestor tail is where 100% of the real
  //                    inventory was (18 DROP, 8 LANDABLE, 1 UNKNOWN of 95).
  //
  //   LANDED-PROVENANCE a `Landed-From` trailer on the base names every commit of the
  //                    branch, BACKED by the landing ledger or the same change (landed-map.js::sameChange). That
  //                    justifies the deletion (archive first, as always) — but it is a CLAIM, not
  //                    a measurement of the archived tree: a conflict-resolved landing
  //                    lands DIFFERENT bytes from the source tip this archive holds.
  //                    `landed` would assert "this recovery copy holds nothing that is
  //                    not on the trunk", which a trailer does not establish. NO ENTRY,
  //                    for the same reason as LANDED-CONTENT.
  //
  // So a ref this tool CANNOT classify soundly gets NO entry, and the window still
  // fires on it. The tool never becomes a writer of verdicts it did not measure.
  //
  // WHICH REFS. Every ref whose ARCHIVE REF WAS WRITTEN — whether or not the remote
  // delete then succeeded. The ledger records what is IN the archive namespace, and a
  // delete that failed leaves the archive ref standing (the tool keeps it deliberately);
  // an archive ref with no verdict is exactly the un-adjudicated state this closes.
  //
  // WHICH LEDGER. `<toplevel>/.claude/ref-adjudications.json` — the repo being SWEPT,
  // never the repo this script happens to live in. `update-ref` writes the archive ref
  // into the cwd's ref store, so the ledger that records it belongs to the same repo.
  // Resolving it from `import.meta.url` instead would make a run against any other
  // checkout write into loom's committed ledger.
  //
  // AN ABSENT LEDGER IS NOT MINTED. The ledger is a committed artifact with a schema
  // and a rationale; a tool that silently creates one in any repo it is pointed at is
  // overreach. Absent ⇒ LOUD skip. UNREADABLE ⇒ LOUD and exit 2: an archive ref written
  // with its verdict dropped on the floor is this change's own failure mode, and it must
  // not be reported in the grammar of a clean run (`conservation-gate.md` MUST-4).
  //
  // AN EXISTING KEY IS NEVER OVERWRITTEN. A human verdict outranks a tool's, and two
  // runs inside one second share a stamp and therefore a key.
  function recordLandedVerdicts(rows, { ledgerPath, stamp }) {
    const rec = { ledger: ledgerPath, status: null, detail: "", recorded: [], notRecordable: [], preserved: [] };
    const archived = rows.filter((r) => r.archived);
    for (const r of archived) {
      if (r.verdict === "LANDED-ANCESTOR") continue;
      rec.notRecordable.push({ ref: r.archived, branch: r.branch, verdict: r.verdict });
    }
    const candidates = archived.filter((r) => r.verdict === "LANDED-ANCESTOR");
    if (!archived.length) { rec.status = "nothing-archived"; rec.detail = "no archive ref was written, so there is nothing to record"; return rec; }
    if (!fs.existsSync(ledgerPath)) {
      rec.status = "NO-LEDGER";
      rec.detail = `no ledger at ${ledgerPath} — NOT created: the ledger is a committed artifact and this tool does not mint one. ${candidates.length} recordable verdict(s) were DROPPED; those archive refs stay un-adjudicated and will red once past their window.`;
      return rec;
    }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); }
    catch (e) {
      rec.status = "LEDGER-UNREADABLE";
      rec.detail = `ledger at ${ledgerPath} could not be read or parsed (${e.message}); ${candidates.length} recordable verdict(s) were DROPPED. The archive refs EXIST and are un-adjudicated.`;
      return rec;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      rec.status = "LEDGER-UNREADABLE";
      rec.detail = `ledger at ${ledgerPath} is not a JSON object; ${candidates.length} recordable verdict(s) were DROPPED.`;
      return rec;
    }
    if (doc.adjudications === undefined) doc.adjudications = {};
    if (!doc.adjudications || typeof doc.adjudications !== "object" || Array.isArray(doc.adjudications)) {
      rec.status = "LEDGER-UNREADABLE";
      rec.detail = `ledger at ${ledgerPath} declares 'adjudications' but it is not an object; ${candidates.length} recordable verdict(s) were DROPPED.`;
      return rec;
    }
    // ONE clock reading, rendered twice: the record's date and the refname's stamp can
    // never disagree, because they are the same instant.
    const on = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    for (const r of candidates) {
      if (Object.prototype.hasOwnProperty.call(doc.adjudications, r.archived)) { rec.preserved.push(r.archived); continue; }
      doc.adjudications[r.archived] = {
        verdict: "landed",
        reason: `archived by remote-ref-reap.mjs --apply before deleting ${REMOTE}/${r.branch} on the remote. The tip was an ancestor of ${BASE} at archive time — the ancestry PROOF, not the patch-id heuristic — so its content is already on the trunk and this recovery copy holds nothing that is not.`,
        evidence: `\`git merge-base --is-ancestor ${r.sha} ${BASE_SHA}\` exit 0, measured by remote-ref-reap.mjs at ${stamp} against ${BASE} (${BASE_SHA}). Re-derive with that exact command: exit 0 confirms, exit 1 refutes.`,
        adjudicated_by: "remote-ref-reap.mjs",
        adjudicated_on: on,
      };
      rec.recorded.push(r.archived);
    }
    if (!rec.recorded.length) {
      rec.status = rec.preserved.length ? "preserved-existing" : "nothing-recordable";
      rec.detail = rec.preserved.length
        ? `every candidate already carried a ledger entry; ${rec.preserved.length} left untouched (an existing verdict is never overwritten)`
        : `${rec.notRecordable.length} ref(s) were archived but none on an ancestry proof, so none is recordable — each falls to the adjudication window, which is the intended outcome`;
      return rec;
    }
    // ATOMIC: a crash mid-write must not truncate a committed artifact. Same-directory
    // temp so the rename stays within one filesystem.
    const tmp = `${ledgerPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, ledgerPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* best effort; a leaked temp must not mask the real error */ }
      rec.status = "LEDGER-UNWRITABLE";
      rec.detail = `ledger at ${ledgerPath} could not be written (${e.message}); ${rec.recorded.length} verdict(s) were DROPPED.`;
      rec.recorded = [];
      return rec;
    }
    rec.status = "recorded";
    rec.detail = `${rec.recorded.length} landed verdict(s) written to ${ledgerPath}`;
    return rec;
  }

  // `baseVerified` is reported for EVERY run, not only the refusing one: a JSON
  // consumer must be able to tell a report measured against a corroborated trunk
  // from one measured against a base nothing corroborates, and those two are
  // otherwise byte-identical (`conservation-gate.md` MUST-4).
  const summary = { total: refs.length, byVerdict: {}, prCheck: pr.known ? (pr.skipped ? "skipped" : "ok") : "unknown", defaultBranch: DEFAULT_BRANCH, baseVerified: !BASE_UNVERIFIED, baseUnverifiedReason: BASE_UNVERIFIED, protected: protects, protectedFloor: PROTECTED_PREFIXES, protectedByFloor, protectedByGlob, fetch: NO_FETCH ? "skipped" : fetchFailed ? "FAILED" : "ok", skippedNames: skipped, provenance: PROVENANCE, byDecidedBy: {} };
  for (const r of refs) summary.byVerdict[r.verdict] = (summary.byVerdict[r.verdict] || 0) + 1;
  // WHICH INSTRUMENT decided each verdict, tallied: a RECORDED landing and a
  // RECONSTRUCTED one are different grades of evidence and must not share a count.
  for (const r of refs) summary.byDecidedBy[r.decidedBy] = (summary.byDecidedBy[r.decidedBy] || 0) + 1;
  // LANDED-PROVENANCE is reapable by default (a RECORD, not a heuristic), unless a merge
  // beyond the base carries content the trailers could not cover.
  // …and only when the map was read off a REMOTE-tracking base (`PROVENANCE.applyEligible`).
  const provenanceReapable = PROVENANCE.applyEligible ? refs.filter((r) => r.verdict === "LANDED-PROVENANCE" && !r.mergeCarriesContent).length : 0;

  let exit = 0;
  if (APPLY) {
    const ghBin = process.env.COC_GH_BIN;
    // F7 — `COC_GH_BIN` names a program this tool EXECUTES, and its answer decides which
    // branches are safe to delete. A test seam is fine; an arbitrary interpreter chosen by
    // the ambient environment on a destructive run is not. Under `--apply` it must be an
    // absolute path whose basename is exactly `gh`.
    // Bound to the case where the gate ACTUALLY RUNS: under `--no-pr-check` no `gh` is
    // spawned at all, so the variable names a program nothing executes and refusing on it
    // would be a fence with no hazard behind it.
    const ghBinOk = NO_PR_CHECK || !ghBin || (path.isAbsolute(ghBin) && path.basename(ghBin) === "gh");
    // FIRST in the chain, because it invalidates the BASE every verdict below was
    // measured against — the other refusals are about the sweep, this one is about
    // the ruler. Nothing is archived and nothing is deleted.
    if (BASE_UNVERIFIED) {
      process.stderr.write(`remote-ref-reap: --apply REFUSED — ${BASE_UNVERIFIED} No archive ref was written and no ref was deleted. Re-run with the override removed, point COC_TRUNK_REF at a ref this repository corroborates as its trunk (refs/remotes/${REMOTE}/HEAD, ${REMOTE}/dev, or ${REMOTE}/main), or pass --base ${BASE} to state deliberately that this is the base you want deletions measured against.\n`);
      summary.refused = "trunk-unverified";
      exit = 2;
    } else if (fetchFailed) {
      process.stderr.write(`remote-ref-reap: --apply REFUSED — \`git fetch --prune ${REMOTE}\` FAILED, so the remote-ref list is STALE and every verdict below is measured against a world that may no longer exist; re-run once the remote is reachable, or pass --no-fetch to state deliberately that you are classifying a known-stale list\n`);
      summary.refused = "fetch-failed";
      exit = 2;
    } else if (PROVENANCE.status === "no-map") {
      // THE RECORD THIS REPOSITORY DECLARED AUTHORITATIVE COULD NOT BE READ. With a
      // config present, ancestry and patch-ids are exactly the instruments landing
      // provenance replaced (a conflict-resolved landing reads UNLANDED, a hand
      // cherry-pick reads LANDED-CONTENT), so NO ref is deleted on this run — not the
      // LANDED-ANCESTOR class and not `--include-content-landed`'s heuristic class
      // either: the refusal is run-wide and precedes eligibility.
      process.stderr.write(`remote-ref-reap: --apply REFUSED — landing provenance is configured here but its map could not be built (${PROVENANCE.why}); no ref is deleted on a run whose landing record is unreadable, whatever --include-content-landed says. No archive ref was written and no ref was deleted. Repair the map (\`node .claude/bin/landed-map.mjs --ref ${BASE_SHA}\`), then re-run.\n`);
      summary.refused = "provenance-unavailable";
      exit = 2;
    } else if (!ghBinOk) {
      process.stderr.write(`remote-ref-reap: --apply REFUSED — COC_GH_BIN is set to ${ghBin}, which is not an absolute path named \`gh\`; the open-PR gate decides which branches are deletable, so it will not be taken from an arbitrary program on a destructive run\n`);
      summary.refused = "gh-bin-untrusted";
      exit = 2;
    } else if (!pr.known) {
      process.stderr.write(`remote-ref-reap: --apply REFUSED — open PR heads could not be read (${pr.error || "gh unavailable"}); pass --no-pr-check only for a remote with no PR forge\n`);
      summary.refused = "pr-heads-unknown"; // visible to a JSON-only reader, not only on stderr
      exit = 2;
    } else {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // YYYYMMDDTHHMMSS — two runs on one day never overwrite each other's archive
      for (const r of refs) {
        // `mergeCarriesContent` disqualifies a LANDED-CONTENT ref outright: the patch-id heuristic
        // did not measure that merge, so "landed" was never established for it. LANDED-ANCESTOR is
        // unaffected — it rests on an ancestry PROOF, not on patch-ids. LANDED-PROVENANCE is
        // eligible WITHOUT a flag (the landing was RECORDED and its trailers BACKED —
        // `applyBacking` turns an unbacked one into PROVENANCE-UNBACKED, which is never
        // eligible), and carries the same merge disqualifier: its trailers cover non-merge
        // commits only. LANDED-PROVENANCE additionally needs a REMOTE-tracking base
        // (`applyEligible`).
        const eligible = r.verdict === "LANDED-ANCESTOR"
          || (PROVENANCE.applyEligible && r.verdict === "LANDED-PROVENANCE" && !r.mergeCarriesContent)
          || (INCLUDE_CONTENT && r.verdict === "LANDED-CONTENT" && !r.mergeCarriesContent);
        if (!eligible || r.prOpen) continue;
        const archive = `refs/archive/remote/${stamp}/${r.branch}`;
        if (git(["update-ref", archive, r.sha]) === null) { r.error = `archive ref not written: ${archive}`; exit = 2; continue; }
        r.archived = archive;
        // F3 — THE DELETE IS A COMPARE-AND-SWAP. Between the classification read and this
        // push, someone can advance the branch; a plain delete would then destroy work
        // that was never measured. `--force-with-lease=<ref>:<sha>` in its EXPLICIT-VALUE
        // form makes the remote reject the delete unless the branch is still at the very
        // sha this run archived. The BARE form is NOT equivalent and is not used: it
        // consults the local tracking ref, which a fetch can refresh out from under the
        // check (measured in `sync-gate2-worktree.test.mjs:2134`).
        // F2 — `:refs/heads/<branch>` rather than `--delete <branch>`: the refspec form
        // never places a remote-supplied name in a position git could read as an option.
        const delArgs = ["push", `--force-with-lease=refs/heads/${r.branch}:${r.sha}`, REMOTE, `:refs/heads/${r.branch}`];
        const del = spawnSync(GIT, delArgs, { cwd, encoding: "utf8", timeout: 60000, env: gitEnvFor(delArgs) });
        if (del.status === 0) r.deleted = true; else { r.error = `delete refused: ${(del.stderr || "").trim().slice(0, 200)}`; exit = 2; }
      }
      // AFTER the sweep, never before: the ledger records refs whose archive ref was
      // actually written, and that is not known until `update-ref` has run.
      if (NO_RECORD) {
        summary.adjudication = { status: "skipped", detail: "--no-record was passed; the archive refs written by this run carry NO verdict and will red once past their window", ledger: null, recorded: [], notRecordable: [], preserved: [] };
      } else {
        const ledgerPath = path.resolve(ledgerGiven || path.join(top, ".claude", "ref-adjudications.json"));
        const rec = recordLandedVerdicts(refs, { ledgerPath, stamp });
        for (const r of refs) if (rec.recorded.includes(r.archived)) r.adjudicated = "landed";
        summary.adjudication = rec;
        // A verdict this run MEASURED and then failed to record is this change's own
        // failure mode. It is never folded into a green.
        if (rec.status === "LEDGER-UNREADABLE" || rec.status === "LEDGER-UNWRITABLE") {
          process.stderr.write(`remote-ref-reap: VERDICTS DROPPED — ${rec.detail}\n`);
          exit = 2;
        } else if (rec.status === "NO-LEDGER") {
          process.stderr.write(`remote-ref-reap: ${rec.detail}\n`);
        }
      }
    }
    summary.deleted = refs.filter((r) => r.deleted).length;
    summary.failed = refs.filter((r) => r.error).length;
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ remote: REMOTE, base: BASE, apply: APPLY, includeContentLanded: INCLUDE_CONTENT, summary, refs }, null, 2) + "\n");
  } else {
    const w = (s, n) => String(s).padEnd(n);
    process.stdout.write(`remote-ref-reap — ${REMOTE} against ${BASE}: ${summary.total} ref(s); PR check: ${summary.prCheck}${APPLY ? " — APPLY" : " — REPORT ONLY"}\n`);
    // F1 — a report built on a failed fetch DECLARES it. Silence here would be a stale
    // classification wearing the grammar of a current one.
    if (fetchFailed) process.stdout.write(`STALE: \`git fetch --prune ${REMOTE}\` FAILED — every verdict below is measured against a possibly-outdated remote-ref list.\n`);
    // The base itself is declared UNVERIFIED before any verdict is printed, so the
    // rows below are never read as deletion-grade.
    if (BASE_UNVERIFIED) process.stdout.write(`UNVERIFIED BASE: ${BASE_UNVERIFIED} Verdicts below are REPORTED against it; NO ref is deletable on that evidence, and \`--apply\` REFUSES (exit 2).\n`);
    if (skipped.length) process.stdout.write(`SKIPPED ${skipped.length} ref(s) whose name begins with '-' (never passed to git as an argv token): ${skipped.join(", ")}\n`);
    // The protected floor is an EXCLUSION, and an undisclosed exclusion makes this
    // report under-count with no signal. These refs are never reaped by design; that
    // is a reason to CLASSIFY them differently, never a reason to stop reporting them.
    if (protectedByGlob.length) process.stdout.write(`PROTECTED-BY-GLOB ${protectedByGlob.length} ref(s) skipped by --protect (${protects.join(", ")}) — never reaped and NOT landedness-tested: ${protectedByGlob.join(", ")}\n`);
    if (protectedByFloor.length) process.stdout.write(`PROTECTED ${protectedByFloor.length} ref(s) held by the floor (${PROTECTED_PREFIXES.join(", ")}) — NEVER reaped, and NOT landedness-tested, so their landed status is UNKNOWN here: ${protectedByFloor.join(", ")}\n`);
    // WHICH INSTRUMENT this run could use, before any verdict: a recorded landing and a
    // reconstructed one must never be read as the same grade of evidence.
    process.stdout.write(PROVENANCE.status === "ok"
      ? `PROVENANCE: Landed-From trailers on ${BASE}@${PROVENANCE.tip.slice(0, 12)} (recording since cutover ${PROVENANCE.cutover.slice(0, 12)}${PROVENANCE.cached ? ", cached map" : ""}) decide every branch forked after the cutover; ancestry/patch-id decide only what predates it.${PROVENANCE.applyEligible ? "" : ` REPORT-ONLY for provenance: ${BASE} is not a remote-tracking ref of ${REMOTE}, so no LANDED-PROVENANCE ref is deletable on it.`}\n`
      : PROVENANCE.status === "no-config"
        ? "PROVENANCE: not recorded in this repository (no .claude/bin/landing-provenance.json) — every verdict below is RECONSTRUCTED by ancestry/patch-id.\n"
        : `PROVENANCE UNAVAILABLE: ${PROVENANCE.why} — this repository records landings, so every verdict below is UNMEASURED (never resolved by ancestry/patch-id) and \`--apply\` REFUSES.\n`);
    for (const [k, v] of Object.entries(summary.byVerdict)) process.stdout.write(`  ${w(k, 22)} ${v}\n`);
    process.stdout.write("\n" + w("verdict", 22) + w("unlanded", 9) + w("age(d)", 7) + w("pr", 4) + "branch  [decided by]\n");
    for (const r of refs.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.branch.localeCompare(b.branch))) {
      process.stdout.write(`${w(r.verdict, 22)}${w(r.unlanded === null ? "-" : r.unlanded, 9)}${w(r.ageDays === null ? "-" : r.ageDays, 7)}${w(r.prOpen === null ? "?" : r.prOpen ? "open" : "-", 4)}${r.branch}${r.trackedBy.length ? `  (tracked by ${r.trackedBy.join(", ")})` : ""}${r.deleted ? "  DELETED" : ""}${r.archived && !r.deleted ? "  archived" : ""}${r.adjudicated ? `  adjudicated=${r.adjudicated}` : ""}${r.error ? `  ERROR ${r.error}` : ""}  [${instrumentLabel(r, BASE)}]${r.mergeCarriesContent ? `  NOT REAPABLE: ${r.mergeScan}` : ""}\n`);
    }
    // HITS, never a tally: every unbacked source -> carrier is named, so the hand
    // verification the remedy asks for has its input on the page.
    const unbackedRows = refs.filter((r) => r.verdict === "PROVENANCE-UNBACKED");
    if (unbackedRows.length) {
      process.stdout.write(`\nPROVENANCE-UNBACKED ${unbackedRows.length} ref(s) — covered by Landed-From trailers that neither the landing ledger nor the same change (landed-map.js::sameChange) backs; NEVER deleted. Remedy: verify by hand; retire applies the same binding.\n`);
      for (const r of unbackedRows) {
        for (const u of r.backing.unbacked) process.stdout.write(`  ${r.branch}  ${u.source ? u.source.slice(0, 12) : "?"} -> ${u.carrier ? u.carrier.slice(0, 12) : "?"}${u.why ? `  (${u.why})` : ""}\n`);
      }
    }
    // HITS, never a tally: every ref archived WITHOUT a recordable verdict is named,
    // because each one is a ref the window will still have to fire on.
    const adj = summary.adjudication;
    if (adj) {
      process.stdout.write(`\nADJUDICATION: ${adj.status} — ${adj.detail}\n`);
      for (const r of adj.recorded) process.stdout.write(`  recorded landed   ${r}\n`);
      for (const r of adj.preserved) process.stdout.write(`  left untouched    ${r} (already carried a verdict; a tool never overwrites one)\n`);
      for (const n of adj.notRecordable) process.stdout.write(`  NO VERDICT        ${n.ref} — archived on ${n.verdict}, which is not an ancestry proof; falls to the adjudication window for a human\n`);
    }
    if (!APPLY && PROVENANCE.status === "no-map") {
      process.stdout.write(`\nREPORT ONLY, AND NO DELETION IS PROPOSED. \`--apply\` would REFUSE with exit 2: the landing-provenance map could not be built (${PROVENANCE.why}). Nothing would be archived and nothing deleted.\n`);
    } else if (!APPLY && BASE_UNVERIFIED) {
      // The "would delete N" sentence below would be FALSE here — `--apply` refuses
      // on this base — and a report-only run that printed it would be advertising a
      // deletion the tool will not perform.
      process.stdout.write(`\nREPORT ONLY, AND NO DELETION IS PROPOSED. \`--apply\` would REFUSE with exit 2 against this base: ${BASE_UNVERIFIED} Nothing would be archived and nothing deleted. To reap, re-run once the base is corroborated, or name it yourself with --base.\n`);
    } else if (!APPLY) {
      const n = (summary.byVerdict["LANDED-ANCESTOR"] || 0);
      process.stdout.write(`\nREPORT ONLY. \`--apply\` would write a LOCAL recovery ref (this clone only, never pushed) at refs/archive/remote/<stamp>/<branch> and delete ${n} LANDED-ANCESTOR ref(s)${provenanceReapable ? ` plus ${provenanceReapable} LANDED-PROVENANCE` : ""}${INCLUDE_CONTENT ? ` plus ${summary.byVerdict["LANDED-CONTENT"] || 0} LANDED-CONTENT` : " (add --include-content-landed for the patch-id heuristic class)"}; open-PR heads are never reaped.\n`);
      if (summary.byVerdict["PROVENANCE-UNBACKED"]) process.stdout.write(`It would delete NONE of the ${summary.byVerdict["PROVENANCE-UNBACKED"]} PROVENANCE-UNBACKED ref(s): trailer text with no ledger row or same change behind it is not deletion-grade.\n`);
      const wouldRecord = NO_RECORD ? 0 : n;
      const wouldNot = INCLUDE_CONTENT ? (summary.byVerdict["LANDED-CONTENT"] || 0) : 0;
      if (provenanceReapable) process.stdout.write(`It would record NO verdict for the ${provenanceReapable} LANDED-PROVENANCE ref(s): a trailer RECORDS the landing but does not measure the archived tree, so those fall to the adjudication window.\n`);
      process.stdout.write(`It would record ${wouldRecord} \`landed\` verdict(s) into ${path.resolve(ledgerGiven || path.join(top, ".claude", "ref-adjudications.json"))}${NO_RECORD ? " — SUPPRESSED by --no-record" : ", each carrying the ancestry proof that established it"}${wouldNot ? `, and NO verdict for ${wouldNot} LANDED-CONTENT ref(s): the patch-id heuristic did not establish landedness, so those fall to the adjudication window for a human` : ""}.\n`);
    }
  }
  process.exitCode = exit; // never process.exit() after a large stdout write: a pipe flushes asynchronously and the report would be cut at 64 KiB
}

// Entry-point check: .claude/bin/lib/entry-point.mjs (symlink-safe; importing this module — as its
// unit tests do — runs nothing).
if (isMainModule(import.meta.url)) main();
