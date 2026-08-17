#!/usr/bin/env node
/**
 * Audit fixtures — `upstream-issue-hygiene.md` MUST-4 (Open, Never Complete).
 *
 * Locks the structural fence on `completeUpflowPR` in BOTH VCS adapters: a PR
 * may only be completed on the repo the caller IS, so a downstream consumer's
 * Step-7c upflow can open a PR against its upstream and can NEVER merge it.
 *
 * THE FENCE DERIVES THE SELF-IDENTITY FROM `process.cwd()`; IT DOES NOT ACCEPT
 * ONE. There is no `selfRepoRef` field and no `_deriveSelfFn` seam: no identity,
 * `cwd`, or deriver value is taken off the caller's DESCRIPTOR
 * (`deriveSelfRepoRef` does take a `cwd` argument, which both adapters hardcode
 * to `process.cwd()`; what was removed is the caller's ability to SUPPLY one) —
 * in production OR in these fixtures. The caller-authored operand was MOVED
 * TWICE before it was removed — three shapes across two corrections
 * (`selfRepoRef` → `_deriveSelfFn` → `cwd`) — and a Tier-1 redteam defeated each
 * shape in turn; an earlier cut of THIS FILE then drove the fence through the
 * `_deriveSelfFn` seam, which meant the suite was exercising an injection point
 * rather than the fence.
 *
 * WHAT A GREEN RUN DOES AND DOES NOT SHOW. A green run does NOT show the fence
 * is an identity boundary. `process.cwd()` is selected by whoever launches the
 * process, so a scratch tree whose `origin` points at the upstream derives that
 * upstream and clears the fence. What these cases lock is that the fence refuses
 * any completion whose target does not match the identity derived from the
 * working tree the process runs in — which CLOSES the accident class (the
 * originating incident) and RAISES THE COST of a deliberate act. It is NOT a
 * boundary against a caller that can choose its own working directory, and
 * cannot be: a caller able to run arbitrary in-process code can replace the
 * module outright.
 *
 * HOW THIS SUITE DRIVES IT INSTEAD — a real repo, in a child process.
 * Each case (1) mkdtemps a directory, (2) `git init`s it and configures the
 * origin remote that case needs, (3) optionally writes a `.claude/VERSION`,
 * (4) spawns a CHILD `node` with `cwd` set to that directory, which requires the
 * adapter by absolute path, builds a spy transport in-process, calls
 * `completeUpflowPR`, and prints one line of JSON, (5) asserts on that JSON, and
 * (6) removes the tree. `cwd` is set at the PROCESS boundary — the only place it
 * can be set now — so the fixture reaches the fence exactly the way a real
 * session does.
 *
 * TRANSPORT injection stays: that is the NETWORK seam, and it is what makes
 * "did the fence refuse BEFORE any call went out?" answerable. IDENTITY
 * injection is what is gone.
 *
 * WHAT EACH CASE ASSERTS: `ok`, `fired` (did the transport get reached?),
 * `error === null`, AND — on every refusal case — `expectReason`, a substring
 * or RegExp naming WHICH refusal fired.
 *
 * The third is load-bearing — deleting a fail-closed guard usually makes the
 * next line throw on `undefined`, which a bare `ok === false` assertion happily
 * accepts as a refusal. Asserting the refusal is a TYPED refusal rather than a
 * crash is what gives those guards an instrument.
 *
 * The FOURTH is the same discipline one step further. `ok`/`fired`/`error` say
 * only THAT a refusal happened; the fence has SIX distinct refusal branches
 * (underivable-no-remote, underivable-unparseable, VERSION-disagreement,
 * non-GitHub host, non-ADO remote, cross-repo target) — plus, downstream of the
 * fence, the path/enum shape guards on the two values the caller still authors
 * (`prId`, `mergeMethod`) — and a case can pass via a DIFFERENT branch than the
 * one its `mutation:` field names — at which point the
 * recorded mutation is INERT and the case is no longer an instrument for it.
 * That is not hypothetical: `gh/bare-path-remote-refuses` under its own recorded
 * mutation refuses at the host check instead of the bare-path guard, so without
 * `expectReason` the mutation leaves the case green (README § "Row 9
 * re-measured"). `expectReason` is matched against `"<error label> | <reason>"`
 * as a SUBSTRING (or RegExp) deliberately — pinning whole sentences would red
 * the suite on every prose tweak.
 *
 * Layout: inline-case runner (the variant `cc-artifacts.md` Rule 9 sanctions —
 * see `.claude/audit-fixtures/codex-dispatcher/README.md` § "Fixture layout").
 *
 * Every case records, in `mutation:`, the specific source change that REDS it.
 * Those mutations were EXECUTED one at a time, per `instrument-discipline.md`
 * MUST-2(b): a mutation that does not red leaves two live hypotheses (vacuous
 * test OR inert mutation), so an un-run `mutation:` field is a claim, not
 * evidence.
 * PROVENANCE IS NOT UNIFORM ACROSS ROWS, so this header does not assert that it
 * is: some rows were measured in the LIVE tree, others against a byte-copy of
 * `.claude/hooks/` in a scratch sandbox (chosen while sibling agents were
 * editing the adapters concurrently). README.md § Mutation validity records
 * which is which, per row, along with the verdicts and the cases each reddened.
 * That per-pass method statement is the authority — read it there rather than
 * inferring a single provenance from this comment.
 *
 * Run: node .claude/audit-fixtures/upflow-open-never-complete/run.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "../../hooks/lib");
const GH = path.join(LIB, "vcs-github-adapter.js");
const ADO = path.join(LIB, "vcs-azure-adapter.js");

const RESULT_PREFIX = "@@UPFLOW-FENCE-RESULT@@";

// ---------------------------------------------------------------------------
// Real temp repos
// ---------------------------------------------------------------------------

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * Build a throwaway git repo.
 *
 * `dirName` is the repo directory's NAME, and it is load-bearing in the
 * no-remote cases: naming the directory after the repo the caller is trying to
 * merge is what makes those cases discriminating against a restored
 * directory-name fallback. Without it, "no remote refuses" would also pass
 * against a build that DID fall back to the dirname.
 *
 * @returns {{root:string, repo:string}} `root` is what the caller removes.
 */
function makeRepo({ dirName, remote, pushRemote, pushDefaultRemote, version }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upflow-fence-"));
  const repo = path.join(root, dirName);
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]);
  if (remote) git(repo, ["remote", "add", "origin", remote]);
  // `pushRemote` configures git's TRIANGULAR workflow — origin fetches from one
  // repo and pushes to another. Without it no case could exercise the
  // fetch-vs-push identity disagreement, and the derivation reads only the fetch
  // url, so the triangular guard had no instrument.
  if (pushRemote)
    git(repo, ["remote", "set-url", "--push", "origin", pushRemote]);
  // `pushDefaultRemote` configures git's OTHER triangular form: a second remote
  // plus `remote.pushDefault`. This one is invisible to `get-url --push origin`
  // — measured: origin's push url stays the FETCH url — so a check that asks
  // only about origin's own pushurl reports agreement while pushes go
  // elsewhere. Without this option no case could drive that form.
  if (pushDefaultRemote) {
    git(repo, ["remote", "add", "fork", pushDefaultRemote]);
    git(repo, ["config", "remote.pushDefault", "fork"]);
  }
  if (version) {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".claude", "VERSION"),
      JSON.stringify(version, null, 2) + "\n",
      "utf8",
    );
  }
  return { root, repo };
}

/**
 * The child program. Runs with `cwd` = the temp repo, so the adapter's
 * hardcoded `process.cwd()` resolves there. The spy transport RECORDS whether
 * it was reached: "did the fence refuse before any network call?" is the
 * discriminating question — a fence that merged and then returned `ok:false`
 * would satisfy a naive `ok === false` assertion.
 */
function childProgram(adapterPath, prRef) {
  return [
    `const adapter = require(${JSON.stringify(adapterPath)});`,
    `let fired = false;`,
    // CAPTURES THE ENDPOINT, not just whether it fired. Both adapters build the
    // request path from the DERIVED identity rather than the caller's `repoRef`
    // ("check and use are the same bytes"), and that construction had NO
    // instrument until this argument was recorded: reverting either adapter to
    // interpolate `repoRef` changed no value the harness read, so no case could
    // red. GitHub passes the path as a string first arg; ADO passes an object
    // with a `path` property — both shapes are normalized here.
    `let endpoint = null;`,
    `const transport = (a) => { fired = true; endpoint = (a && typeof a === "object") ? (a.path || null) : (typeof a === "string" ? a : null); return { ok: true, status: 200, body: { merged: true, sha: "deadbeef" } }; };`,
    `let r = null, error = null;`,
    // The `_deriveSelfFn` seam must arrive as a REAL FUNCTION, not the sentinel
    // string. `JSON.stringify` cannot carry a function, so the sentinel is
    // swapped for a literal here. This is load-bearing: a NAIVE restoration
    // (`(prRef._deriveSelfFn || derive)(cwd)`) would throw on a string and red
    // via `error !== null`, but a DEFENSIVE one
    // (`typeof x === "function" ? x(...) : derive(process.cwd())`) — the shape a
    // careful author would actually write — would fall through on a string and
    // leave the case GREEN. With a real function it is honored, the derivation
    // returns the upstream, and the case flips refuse→authorize as intended.
    `try { r = adapter.completeUpflowPR(transport, ${JSON.stringify(
      prRef,
    ).replace(
      '"__must_be_ignored__"',
      '(function(){ return {ok:true, self:{host:"github.com", owner:"terrene-foundation", name:"kailash-coc-claude-py", ado:null, source:"remote"}}; })',
    )}); }`,
    `catch (e) { error = (e && e.message) ? e.message : String(e); }`,
    `process.stdout.write(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({`,
    `  ok: !!(r && r.ok), fired, error, endpoint,`,
    `  reason: (r && r.reason) || null,`,
    // The adapters' `_fail(error, reason)` short LABEL. Carried separately
    // because two ADO branches share a label while their reasons differ, and
    // two GitHub branches share reason wording while their labels differ — the
    // pair discriminates where neither field alone does.
    `  label: (r && r.error) || null,`,
    `}) + "\\n");`,
  ].join("\n");
}

function runInRepo(repo, adapterPath, prRef, extraEnv) {
  const res = spawnSync(
    process.execPath,
    ["-e", childProgram(adapterPath, prRef)],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 30000,
      // `extraEnv` exists for ONE case: the ambient-`GIT_DIR` probe. The
      // derivation routes `git` through `git-subprocess-env.js::gitEnv()`, which
      // builds the child env from constants so nothing is inherited — and that
      // routing closes a documented FENCE BYPASS (`GIT_DIR` outranks repository
      // discovery, so neither `cwd:` nor `-C` pins WHICH repo git resolves).
      // Until this hook existed no case set `GIT_DIR`, so removing `gitEnv()`
      // changed no value the harness read.
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    },
  );
  const line = String(res.stdout || "")
    .split("\n")
    .find((l) => l.startsWith(RESULT_PREFIX));
  if (!line) {
    throw new Error(
      `child produced no result line (status=${res.status}) — stderr: ` +
        String(res.stderr || "")
          .trim()
          .slice(0, 400),
    );
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const GH_SELF = { owner: "terrene-foundation", name: "kailash-coc-rs" };
const GH_UPSTREAM = {
  owner: "terrene-foundation",
  name: "kailash-coc-claude-py",
};
const GH_SELF_REMOTE =
  "https://github.com/terrene-foundation/kailash-coc-rs.git";

// CONTROL BYTES ARE BUILT FROM CHAR CODES, never written as source literals.
// A raw C0 byte in this file is invisible to a reviewer — the exact property the
// guards under test exist to remove from output — and a shell `$(...)` round-trip
// silently STRIPS a literal newline from a payload, so the construction has to
// happen in node. A raw U+212A in this suite's test input was caught once on this
// branch for the same class of reason.
const CTRL_LF = String.fromCharCode(10);

const ADO_SELF = { org: "contoso", project: "platform", repo: "coc-rs" };
const ADO_UPSTREAM = {
  org: "contoso",
  project: "platform",
  repo: "coc-template",
};
const ADO_SELF_REMOTE = "https://dev.azure.com/contoso/platform/_git/coc-rs";

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases = [
  // ---- GitHub -------------------------------------------------------------
  {
    name: "gh/refuse-downstream-merging-upstream",
    mutation:
      "vcs-github-adapter.js::completeUpflowPR — delete the `if (!selfRepo.isSelfRepo(repoRef, d.self))` refusal block",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    prRef: { repoRef: GH_UPSTREAM, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    name: "gh/non-github-host-remote-refuses",
    mutation:
      "vcs-github-adapter.js::completeUpflowPR — drop the `GITHUB_HOSTS.has(d.self.host)` refusal",
    // THE HOST CHECK'S ONLY INSTRUMENT. The remote's PATH is identical to this
    // repo's own (`terrene-foundation/kailash-coc-rs`), so owner+name match self
    // exactly; ONLY the host differs. Without the host check the fence would
    // authorize a merge on github.com/terrene-foundation/kailash-coc-rs from a
    // tree whose origin is an internal GitLab mirror — a DIFFERENT repo than the
    // remote names. A predicate sweep measured that dropping the host check left
    // the suite fully GREEN: every other GitHub case uses a github.com remote, a
    // bare path, or no remote, so none could distinguish it.
    repo: {
      dirName: "kailash-coc-rs",
      remote:
        "https://gitlab.internal.example/terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "non-GitHub self-identity refused",
  },
  {
    // THE OWNER LEG'S ONLY INSTRUMENT. Every OTHER GitHub refusal case shares an
    // owner with self (`terrene-foundation/...` vs `terrene-foundation/...`) and
    // differs only in NAME, so the name leg carries all of them and dropping
    // `a === self.owner` left the suite fully GREEN — measured, 16/16. That is
    // the same "leg that can never fail" defect the ADO `org` comparison had
    // (README row 5), reproduced on the primary lane. This case is the one that
    // differs in OWNER while holding NAME equal, so it is the only thing
    // standing between a cross-owner completion and `ok:true`.
    name: "gh/cross-owner-same-name-refuses",
    mutation:
      "upflow-self-repo.js::isSelfRepo — drop the `a === self.owner` leg, keeping only `b === self.name`",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    prRef: { repoRef: { owner: "fabrikam", name: "kailash-coc-rs" }, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    name: "gh/allow-maintainer-merging-own-repo",
    mutation:
      "upflow-self-repo.js::isSelfRepo — `return false;` at the top (fence becomes unconditional)",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: true, fired: true },
  },
  {
    name: "gh/case-insensitive-own-repo-still-allowed",
    mutation: "upflow-self-repo.js::normalizeComponent — drop `.toLowerCase()`",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    prRef: {
      repoRef: { owner: "Terrene-Foundation", name: "Kailash-COC-RS" },
      prId: 77,
    },
    expect: { ok: true, fired: true },
    // Caller passes MIXED CASE; the path must carry the DERIVED lowercase form.
    // Reverting the adapter to interpolate `repoRef` yields
    // `repos/Terrene-Foundation/Kailash-COC-RS/...` and reds here.
    expectEndpoint: "repos/terrene-foundation/kailash-coc-rs/pulls/",
  },
  {
    // Remote deliberately carries NO `.git`, target does. If the remote also
    // ended in `.git`, dropping the strip would mangle BOTH sides identically
    // and the case would stay green — an inert mutation, not a passing test.
    name: "gh/dot-git-suffix-own-repo-still-allowed",
    mutation:
      'upflow-self-repo.js::normalizeComponent — drop `.replace(/\\.git$/i, "")`',
    repo: {
      dirName: "kailash-coc-rs",
      remote: "https://github.com/terrene-foundation/kailash-coc-rs",
    },
    adapter: GH,
    prRef: {
      repoRef: { owner: "terrene-foundation", name: "kailash-coc-rs.git" },
      prId: 77,
    },
    expect: { ok: true, fired: true },
    // Caller passes a `.git` suffix; the path must carry the DERIVED stripped
    // form. Interpolating `repoRef` yields `.../kailash-coc-rs.git/pulls/`.
    expectEndpoint: "repos/terrene-foundation/kailash-coc-rs/pulls/",
  },
  {
    // THE ORIGINAL EXPLOIT, reconstructed exactly: no origin remote, a
    // directory named after the target repo, and a `.claude/VERSION` declaring
    // that same repo. Under the defeated build the dirname fallback yielded
    // `slug: null`, the forged declaration was the only slug left, and the
    // fence returned ok:true on an arbitrary upstream. It must REFUSE.
    name: "gh/no-origin-remote-refuses",
    mutation:
      "upflow-self-repo.js::deriveSelfRepoRef — on `!url`, fall back to `_declaredSlug(cwd)` as an identity SOURCE instead of refusing",
    repo: {
      dirName: "kailash-coc-rs",
      remote: null,
      version: { repo: "terrene-foundation/kailash-coc-rs" },
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "yielded no remote for this working tree",
  },
  {
    // A bare filesystem path is not a hosting identity. The path's last two
    // segments spell the target, so a build that treated it as one would
    // authorize.
    // THE AUTHORITY-CUT'S ONLY INSTRUMENT — and its removal is fail-OPEN, which
    // is what makes this a refusal case rather than a normalization one. Without
    // the `#`/`?` truncation, `authority` is `evil.com#@github.com`,
    // `lastIndexOf("@")` yields host `github.com` (clearing GITHUB_HOSTS), and
    // the path yields exactly GH_SELF — so the fence AUTHORIZES a merge against
    // a repo the remote does not name. curl, which git uses for https,
    // terminates the authority at `#`, so git would resolve `evil.com`.
    // Before this case existed, NO fixture remote contained `#` or `?` at all,
    // so both truncation lines were a no-op across the whole suite.
    name: "gh/fragment-authority-spoof-refuses",
    mutation:
      "upflow-self-repo.js::_splitRemoteUrl — drop the `authCut` truncation at the first `#`/`?`",
    repo: {
      dirName: "kailash-coc-rs",
      remote:
        "https://evil.com#@github.com/terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    // Pins the HOST branch: the derivation must resolve `evil.com`, not the
    // `github.com` decoy after the `@`.
    expectReason: "non-GitHub self-identity refused",
  },
  {
    // Query-delimiter sibling of the case above. `?` is the other authority
    // terminator curl honors, and `search(/[#?]/)` takes whichever comes first.
    name: "gh/query-authority-spoof-refuses",
    mutation:
      "upflow-self-repo.js::_splitRemoteUrl — drop the `authCut` truncation at the first `#`/`?`",
    repo: {
      dirName: "kailash-coc-rs",
      remote:
        "https://evil.com?@github.com/terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "non-GitHub self-identity refused",
  },
  {
    // THIRD authority-spoof route, and the one NEITHER sibling above covered:
    // the SCHEME itself was unanchored. `_splitRemoteUrl` used
    // `indexOf("://")`, which finds the first `://` ANYWHERE — including one
    // sitting in the PATH of an scp-style remote — and then read the authority
    // out of the middle of the string. Measured on the pre-fix code:
    // `"evil.com:x/https://github.com/o/r".indexOf("://")` = 16, so `afterScheme`
    // began at `github.com` and the derivation returned the DECOY host, clearing
    // a caller's `GITHUB_HOSTS` check on a remote whose real host is `evil.com`.
    //
    // Reachability, stated honestly rather than inflated: `git remote add`
    // ACCEPTS this string and `git remote get-url` returns it verbatim (both
    // measured), so the derivation genuinely receives it — but `git ls-remote`
    // refuses it (`fatal: protocol 'evil.com:x/https' is not supported`), so it
    // is not a fetchable remote. The delta over the module header's disclosed
    // in-process bound is therefore ~zero; this is pinned as a CHECK-vs-USE
    // divergence (the fence believing it is a repo git cannot reach), which is
    // the same class as the `#`/`?` cut, not as a new privilege escalation.
    // FRAGMENT-INJECTED PATH SEGMENTS — the fourth and last member of the
    // authority/path-spoof family, and the one the host-parity differential
    // structurally CANNOT see, because the host it derives is entirely correct.
    // The `#`/`?` cut applies to the AUTHORITY; the PATH was never cut, and
    // `_parseRemoteUrl` took the LAST TWO segments:
    //
    //   https://github.com/evil/repo#/upstream/repo
    //     segments -> ["evil", "repo#", "upstream", "repo"]
    //     last two -> upstream/repo     <- derived identity, host github.com
    //     the URL actually names evil/repo
    //
    // So the fence would have authorized a completion against `upstream/repo`
    // from a tree whose remote names `evil/repo`. Measured, both `#` and `?`.
    //
    // Bounded the same way as its unanchored-scheme sibling, and for the same
    // measured reason: `git ls-remote` REFUSES this remote
    // (`fatal: .../info/refs not valid: is this a git repository?`), so it is
    // not fetchable and grants nothing beyond the module header's disclosed
    // in-process bound. A PARSE defect, ranked as one.
    //
    // This case is why the differential is NOT sufficient on its own: only an
    // adapter-level drive proves the TRANSPORT never fired.
    name: "gh/fragment-injected-path-segments-refuse",
    mutation:
      "upflow-self-repo.js::_parseRemoteUrl — relax `parts.length !== 2` back to `< 2` with the last-two-segments rule",
    repo: {
      dirName: "kailash-coc-rs",
      remote: "https://github.com/evil/repo#/terrene-foundation/kailash-coc-rs",
    },
    adapter: GH,
    // repoRef names the repo the FRAGMENT smuggles in — the exact match the
    // pre-fix derivation would have produced, so under the mutation this
    // derives, compares EQUAL, and fires.
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair (host github.com)",
  },
  {
    // PATH-POSITION BYTE ALLOWLIST. `normalizeComponent` used a four-member
    // DENYLIST (`.`, `..`, `/`, `\`), so every other byte the ASCII guard
    // admits survived into an interpolated request path — `?`/`#` (which
    // TERMINATE a path), percent-encoded separators (`%2e%2e` reconstitutes
    // `..` under RFC 3986 §6.2.2.2 at any decoding proxy), and control bytes.
    // Measured pre-fix: this exact remote derived `ado.repo` = `"repo?x=1"`.
    //
    // Pinned as DEFENSE-IN-DEPTH, not a live-bug regression guard — and the
    // distinction is recorded so a later reader does not overstate it. Both
    // adapters call `validateRepoRef` FIRST, and the fence needs the derived
    // component to compare EQUAL to a `repoRef` that passed GITHUB_REPO_RE /
    // ADO_REPO_RE, neither of which admits `?`. So this never reached the
    // transport; what changed is that the safety no longer depends on a
    // SECOND module's regex staying strict.
    name: "ado/path-terminator-byte-in-remote-refuses",
    mutation:
      "upflow-self-repo.js::normalizeComponent — revert the `/^[A-Za-z0-9._-]+$/` allowlist to the four-member `.`/`..`/`/`/`\\` denylist",
    repo: {
      dirName: "kailash-coc-rs",
      remote: "https://dev.azure.com/contoso/proj/_git/repo?x=1",
    },
    adapter: ADO,
    // repoRef is deliberately VALID and `?`-free. An earlier draft of this case
    // put `repo?x=1` in the repoRef too, and it refused — but at
    // `validateRepoRef`, the CALLER-side gate, which would refuse with or
    // without the allowlist under test. That is a fixture asserting the wrong
    // invariant: green, and proving nothing about this predicate. Keeping the
    // repoRef valid puts the `?` ONLY on the derivation side, which is the side
    // the allowlist governs.
    prRef: {
      repoRef: { org: "contoso", project: "proj", repo: "repo" },
      prId: 77,
    },
    expect: { ok: false, fired: false },
    // THE REASON IS WHAT DISCRIMINATES, and it is why this case is not vacuous.
    // Both branches refuse, so `ok:false` alone would pass either way:
    //   WITH the allowlist  -> the component is rejected during parsing, so no
    //                          owner/name pair forms -> DERIVATION refusal.
    //   WITHOUT it          -> `ado.repo` becomes "repo?x=1", a pair forms, and
    //                          it refuses one step later at the identity
    //                          COMPARISON against repoRef.repo "repo".
    // Pinning the derivation reason is the only assertion that tells them apart.
    expectReason: "does not parse to an owner/name pair",
  },
  {
    // FOURTH authority-spoof route, and the most serious of the four: the
    // `#`/`?` authority cut was applied to the scp-style branch, where it
    // models NOTHING. curl terminates an authority at `#`/`?` (so the cut is
    // right for the scheme branch); OpenSSH does not, and splits user@host at
    // the LAST `@`. Because the cut ran BEFORE the userinfo split, the `#`
    // payload landed in the DISCARDED userinfo and the RETAINED host was the
    // decoy — the exact inverse of what the code's own comment claimed.
    //
    // BOTH halves measured, because the ssh-splitting rule is the load-bearing
    // step and knowledge is not evidence:
    //   ssh -G 'git@github.com#@evil.com'  ->  host evil.com, user git@github.com#
    //   deriveSelfRepoRef (pre-fix)        ->  ok:true, host "github.com"
    //
    // Unlike the unanchored-scheme sibling above, `git remote add` accepts this
    // AND it is a well-formed scp URL git hands straight to ssh — so it is a
    // LIVE, FETCHING remote resolving to evil.com while the fence reads
    // github.com. The "git refuses the URL anyway" mitigation that bounded the
    // sibling's severity does NOT apply here.
    name: "gh/scp-userinfo-fragment-spoof-refuses",
    mutation:
      "upflow-self-repo.js::_splitRemoteUrl — apply the `#`/`?` authCut to the scp-style branch again (drop the `isSchemeForm` guard)",
    repo: {
      dirName: "kailash-coc-rs",
      remote: "git@github.com#@evil.com:terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    // Pins the HOST branch: the derivation must resolve `evil.com` — where ssh
    // would actually connect — not the `github.com` decoy before the `#`.
    expectReason: "non-GitHub self-identity refused",
  },
  {
    name: "gh/unanchored-scheme-authority-spoof-refuses",
    mutation:
      'upflow-self-repo.js::_splitRemoteUrl — unanchor the scheme test back to `s.includes("://")` + `s.indexOf("://")`',
    repo: {
      dirName: "kailash-coc-rs",
      remote:
        "evil.com:x/https://github.com/terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    // THE REFUSAL BRANCH MOVED EARLIER, and the assertion follows it rather
    // than the reverse. This case originally pinned the HOST check
    // ("non-GitHub self-identity refused"). The later exact-segment-count fix in
    // `_parseRemoteUrl` refuses this remote at PARSE time — the scp path here is
    // `x/https://github.com/…`, five segments, not two — so the host check is no
    // longer reached. Both are correct refusals; only the branch changed, and
    // that is recorded rather than papered over by loosening the assertion.
    //
    // The new string proves MORE than the old one: it names `host evil.com`, so
    // it pins BOTH the parse branch AND the fact that the authority resolved to
    // the real host rather than the `github.com` decoy. A regression that
    // unanchored the scheme would derive `github.com` and produce neither.
    expectReason: "does not parse to an owner/name pair (host evil.com)",
  },
  {
    // THE REGRESSION GUARD FOR THE ORIGINATING CRIT. The caller-authored
    // identity operand was removed three times — `selfRepoRef`, then
    // `_deriveSelfFn`, then `cwd` — and NOTHING detected its return. Measured:
    // restoring `deriveSelfRepoRef((prRef && prRef.cwd) || process.cwd())` left
    // the suite fully GREEN while a forged tree merged on the upstream. That is
    // the exact defect this whole change exists to fix, reintroducible with no
    // test signal.
    //
    // This case injects ALL THREE removed seams onto the descriptor at once,
    // pointed at a decoy tree whose origin IS the upstream, and targets the
    // upstream. The fence must IGNORE every one of them and refuse, because the
    // real `process.cwd()` is the self repo. If any seam is honored the
    // derivation returns the upstream, `isSelfRepo` matches, and the merge
    // fires — flipping this case refuse→authorize.
    name: "gh/descriptor-identity-seams-are-ignored",
    mutation:
      "vcs-github-adapter.js::completeUpflowPR — restore any caller-authored identity seam, e.g. `deriveSelfRepoRef((prRef && prRef.cwd) || process.cwd())`",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    decoyRepo: {
      dirName: "kailash-coc-claude-py",
      remote: "https://github.com/terrene-foundation/kailash-coc-claude-py.git",
    },
    decoyMode: "descriptor-seam",
    decoySelfRepoRef: {
      owner: "terrene-foundation",
      name: "kailash-coc-claude-py",
    },
    adapter: GH,
    prRef: { repoRef: GH_UPSTREAM, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    // THE ADO SIBLING OF THE CASE ABOVE, and it did not exist until an
    // adversarial round went looking for it. CRIT-2 (the caller-authored
    // identity seam) was fixed at BOTH adapters but instrumented at ONE:
    // restoring `deriveSelfRepoRef((prRef && prRef.cwd) || process.cwd())` in
    // the ADO adapter left the suite FULLY GREEN. Driven directly under that
    // mutation, the ADO adapter returned
    //   {"ok":true,"fired":true,
    //    "ep":"contoso/platform/_apis/git/repositories/coc-template/
    //          pullrequests/42?api-version=7.1"}
    // i.e. it MERGED ON THE UPSTREAM while every fixture still passed. The
    // GitHub case above is labelled the regression guard for the originating
    // CRIT; this is the half of that guard that was missing.
    //
    // Same shape, ADO-shaped: cwd is the SELF repo, the decoy's origin IS the
    // upstream, all three removed seams are injected pointing at the decoy, and
    // the target is the upstream. The fence must ignore every seam and refuse
    // because the real `process.cwd()` is self. Honoring any seam derives the
    // upstream, `isSelfRepoAdo` matches, and the merge fires — refuse→authorize.
    name: "ado/descriptor-identity-seams-are-ignored",
    mutation:
      "vcs-azure-adapter.js::completeUpflowPR — restore any caller-authored identity seam, e.g. `deriveSelfRepoRef((prRef && prRef.cwd) || process.cwd())`",
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    decoyRepo: {
      dirName: "coc-template",
      remote: "https://dev.azure.com/contoso/platform/_git/coc-template",
    },
    decoyMode: "descriptor-seam",
    decoySelfRepoRef: ADO_UPSTREAM,
    adapter: ADO,
    prRef: { repoRef: ADO_UPSTREAM, prId: 42 },
    expect: { ok: false, fired: false },
    expectReason: "refusing to complete",
  },
  {
    // THE ONLY INSTRUMENT FOR THE ADO EXACT-SEGMENT-COUNT PAIR, and the shape
    // is load-bearing: the extra segments are ALL CLEAN. Every other ADO
    // multi-segment case carries a DIRTY segment (`#`, `?`, a percent-encoded
    // separator) that `normalizeComponent` nulls at the validate-before-drop
    // check, so none of them ever reaches the two count gates — which is why
    // the pair mutation redded NOTHING before this case existed, and why the
    // source comment claiming the pair was the tested mutation was false.
    //
    // Arithmetic, measured not argued. Segments after the `_git` filter:
    //   [realorg, realproj, realrepo, extra, otherrepo]            (n=5)
    // UNMUTATED: `segs.length !== 3` refuses at n=5 -> derivation null ->
    //   the adapter refuses as underivable.
    // PAIR-MUTATED (`!== 3`->`< 3` AND `!== 2`->`< 2`): n=5 passes the first
    //   gate, org = segs[0] = "realorg", slice(1) leaves n=4, which passes the
    //   second, and project/repo are taken as the LAST TWO -> "extra" /
    //   "otherrepo". That is exactly the value the adversarial probe measured.
    // The target below is that MUTATED derivation, so the mutation flips this
    // case refuse->AUTHORIZE. Targeting the real self repo instead would refuse
    // under BOTH, and the case could not discriminate.
    name: "ado/exact-segment-count-rejects-all-clean-extra-segments",
    mutation:
      "upflow-self-repo.js::_parseAdo — the PAIR: relax `segs.length !== 3` to `< 3` AND `segs.length !== 2` to `< 2` (either alone is inert)",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://dev.azure.com/realorg/realproj/_git/realrepo/extra/otherrepo",
    },
    adapter: ADO,
    prRef: {
      repoRef: { org: "realorg", project: "extra", repo: "otherrepo" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    // BRANCH PIN. Without it this case can pass via a DIFFERENT refusal branch
    // than its `mutation:` names, at which point the recorded mutation is inert
    // and the case is decoration — the failure the header cites
    // `gh/bare-path-remote-refuses` for. Its absence also falsified this file's
    // own stated `expectReason`-count equality (28 vs 29) the round it landed.
    expectReason: "does not parse to an owner/name pair",
  },
  {
    // THE HOST ASCII GUARD'S ONLY INSTRUMENT. The guard rejects a non-ASCII
    // authority BEFORE `.toLowerCase()`, because U+212A KELVIN SIGN lowercases
    // to ASCII "k" — so on a deployment whose appliance host contains a "k"
    // (`github.k8s.corp`, the GHES host `vcs-github-adapter.js` explicitly
    // schedules), `github.<U+212A>8s.corp` would lowercase INTO the host set
    // while git and ssh resolve a different IDN host.
    //
    // Until this case existed the guard had NO instrument: every host in this
    // suite is pure ASCII, so deleting the guard line changed no value any case
    // read and the suite stayed fully green. The one non-ASCII byte in the
    // corpus sits in a PATH segment, which exercises `normalizeComponent`'s
    // guard instead — a different line.
    //
    // Uses U+212A in the AUTHORITY. Unmutated: the guard refuses at derivation.
    // With the guard removed: the authority lowercases to `github.k8s.corp`,
    // which is not in GITHUB_HOSTS either — so the naive assertion `ok===false`
    // would NOT discriminate. The branch pin is what makes it red: the refusal
    // moves from "underivable" to "non-GitHub self-identity".
    name: "gh/non-ascii-authority-refuses-at-derivation",
    mutation:
      "upflow-self-repo.js::_splitRemoteUrl — delete the `if (!/^[\\x00-\\x7f]*$/.test(authority)) return null;` guard",
    repo: {
      dirName: "kailash-coc-rs",
      remote:
        "https://github.\u212A8s.corp/terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair",
  },
  {
    // THE OTHER HALF OF THE SAME GUARD — the residual INSIDE its own character
    // class. The sibling case above drives a non-ASCII authority; this one
    // drives a C0 CONTROL BYTE, which the guard's original `[\x00-\x7f]` class
    // ADMITTED. That admission was not inert:
    //
    //   https://contoso<LF>.visualstudio.com/platform/_git/coc-rs
    //     host                -> "contoso\n.visualstudio.com"
    //     endsWith(".visualstudio.com")  -> TRUE, so the ADO subdomain branch runs
    //     org = host.slice(0, indexOf(".")) -> "contoso\n"
    //     normalizeComponent  -> .trim() -> "contoso"
    //
    // i.e. the control-byte authority derives the SAME org as the legitimate
    // `contoso.visualstudio.com`. Measured before the fix, in a real repo:
    //     derive   -> ok:true  self.ado {org:"contoso",project:"platform",repo:"coc-rs"}
    //     complete -> ok:true  fired:true
    // — an AUTHORIZED completion on a remote whose host git resolves elsewhere.
    //
    // `normalizeComponent`'s sibling guard is DELIBERATELY still `[\x00-\x7f]`
    // and must stay: it runs before a POSITIVE `[A-Za-z0-9._-]` allowlist that
    // strips controls anyway. The HOST path is the one with no second gate.
    //
    // Reachability is ~zero (nothing fetches such a remote — see the IPv6 note
    // in `_splitRemoteUrl`), so this is a refuse→authorize flip in a parse, not
    // a live bypass. It is fixed and instrumented on this file's own standard:
    // safe-by-accident becomes a bypass the moment a caller compares hosts
    // differently.
    //
    // The payload is built with `String.fromCharCode`, never a source literal:
    // a raw control byte written into this file is invisible to a reviewer, and
    // a raw U+212A in test input was already caught once on this branch.
    //
    // The PERMISSIVE polarity for the same parse path is
    // `ado/allow-own-repo-visualstudio-subdomain-form` below, which drives the
    // byte-identical remote WITHOUT the control byte and expects ok:true. Both
    // are required: a refusal-only pair cannot distinguish this fix from a
    // refuse-everything parser (commit `1a25ee1` on this branch scored exactly
    // that as clean).
    name: "ado/control-byte-authority-refuses-at-derivation",
    mutation:
      "upflow-self-repo.js::_splitRemoteUrl — widen the host guard back to `/^[\\x00-\\x7f]*$/` (from `/^[\\x20-\\x7e]*$/`)",
    repo: {
      dirName: "coc-rs",
      remote: `https://contoso${CTRL_LF}.visualstudio.com/platform/_git/coc-rs`,
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair",
    // The control byte must not survive into the refusal blob either — with the
    // guard widened the derivation succeeds and this assertion is moot, but if a
    // future change makes the host reach the reason it reds here rather than
    // silently forging a log line.
    expectReasonAbsent: CTRL_LF,
  },
  {
    // THE ONLY INSTRUMENT FOR `displayPrId`, and it needs the NEGATIVE
    // assertion: a sanitizer's contract is that something does NOT appear, so
    // every positive check in this harness is blind to it. Collapsing
    // `displayPrId` to `String(value)` left the suite fully green, because no
    // case carried a control byte in `prId` at all — every id in the corpus is
    // `77`, `42`, or a traversal string of plain ASCII.
    //
    // The newline is injected into a refusal that fires BEFORE `PR_NUMBER_RE`
    // (the identity checks run first by design), which is exactly why the id
    // reaches a refusal string unvalidated. The refusal `reason` is logged and
    // `/codify` Step-7c may embed it in a PR body — so a raw newline there is a
    // forged log line in text a human reads as this tool's output.
    name: "gh/control-byte-pr-id-neutralized-in-refusal",
    mutation:
      "upflow-self-repo.js::displayPrId — return `String(value)` unchanged (drop the [^0-9] allowlist)",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    prRef: { repoRef: GH_UPSTREAM, prId: "77\nFORGED-LOG-LINE: merged" },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
    // The payload MUST NOT survive into the refusal blob.
    expectReasonAbsent: "\nFORGED-LOG-LINE",
  },
  {
    // THE TRIANGULAR-REMOTE GUARD'S INSTRUMENT. `git clone <upstream> &&
    // git remote set-url --push origin <fork>` is git's DOCUMENTED triangular
    // workflow, and it leaves `remote.origin.url` pointing at the upstream — so
    // a fence deriving from the fetch url alone derived the UPSTREAM and
    // authorized a merge on it from a downstream contributor's tree. No attacker
    // and no unusual setup: that is the ordinary configuration for the exact
    // population MUST-4 exists to stop.
    //
    // Shape: fetch = the upstream, push = this consumer's fork, target = the
    // upstream. Before the guard this case AUTHORIZED (fetch-derived identity
    // matched the target). With it, the disagreement refuses.
    name: "gh/triangular-remote-refuses-when-fetch-and-push-disagree",
    mutation:
      "upflow-self-repo.js::deriveSelfRepoRef — delete the `_readPushRemote` triangular-disagreement block",
    repo: {
      dirName: "kailash-coc-rs",
      remote: "https://github.com/terrene-foundation/kailash-coc-claude-py.git",
      pushRemote: "https://github.com/some-consumer/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_UPSTREAM, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "triangular remote",
  },
  {
    // THE PERMISSIVE POLARITY of the case above, and NOT optional: a
    // refusal-only pair cannot detect OVER-tightening, and this guard's obvious
    // failure mode is refusing a legitimate maintainer. A push url that differs
    // only in TRANSPORT (ssh vs https) names the SAME repo, so it must still
    // authorize. Reds if the comparison is ever changed from derived identity to
    // raw URL string.
    name: "gh/triangular-same-identity-different-transport-allows",
    mutation:
      "upflow-self-repo.js::deriveSelfRepoRef — compare the raw pushUrl string against `url` instead of comparing derived slugs",
    repo: {
      dirName: "kailash-coc-rs",
      remote: GH_SELF_REMOTE,
      pushRemote: "git@github.com:terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: true, fired: true },
  },
  {
    // THE HOST ARM of the triangular comparison. The first cut compared the
    // `owner/name` SLUG, so a push url on a DIFFERENT HOST with the same path
    // compared EQUAL and no refusal fired — while `vcs-github-adapter.js` states
    // for its own host check that "an owner/name pair alone does not say WHERE
    // the repo lives". An internal mirror is, in that file's words, an ordinary
    // thing to have. Reds if the comparison is narrowed back to the slug.
    name: "gh/triangular-same-slug-different-host-refuses",
    mutation:
      "upflow-self-repo.js::_sameDerivedIdentity — drop the host equality test (compare owner/name only)",
    repo: {
      dirName: "kailash-coc-rs",
      remote: GH_SELF_REMOTE,
      pushRemote:
        "https://internal-mirror.example/terrene-foundation/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "triangular remote",
  },
  {
    // THE ADO ORG ARM, and the sharpest of the three: for an ADO remote
    // `_parseRemoteUrl` sets owner = ado.project and name = ado.repo, so the ORG
    // rides only on `.ado.org` and a slug comparison drops it ENTIRELY. Both
    // urls below reduce to the SAME project-and-repo pair, compare equal, and
    // the fence then
    // authorized a completion on the UPSTREAM org — the originating failure mode
    // of this whole change, reached through the one component `_parseAdo` exists
    // to preserve. No attacker and no unusual setup: an ordinary cross-org
    // triangular clone.
    name: "ado/triangular-cross-org-same-project-repo-refuses",
    mutation:
      "upflow-self-repo.js::_sameDerivedIdentity — compare `${owner}/${name}` instead of routing ADO through isSelfRepoAdo",
    repo: {
      dirName: "coc-rs",
      remote: "https://dev.azure.com/upstream-org/platform/_git/coc-rs",
      pushRemote: "https://dev.azure.com/my-org/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: {
      repoRef: { org: "upstream-org", project: "platform", repo: "coc-rs" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "triangular remote",
  },
  {
    // THE `remote.pushDefault` FORM. Measured: with pushDefault set to another
    // remote, `git remote get-url --push origin` still returns the FETCH url —
    // so the first cut, which asked only that question, saw agreement while
    // pushes went to the fork. Two of git's three documented triangular
    // configurations were invisible to it. Reds if `_readPushRemote` is
    // narrowed back to `["remote","get-url","--push","origin"]`.
    // THE ADO PERMISSIVE POLARITY, and its absence let a LOCKOUT ship green.
    // `dev.azure.com` (https) and `ssh.dev.azure.com` (ssh) address the SAME
    // repository — the transport differs, the identity does not. A first cut of
    // `_sameDerivedIdentity` compared the raw host for both shapes and therefore
    // REFUSED this remote: a maintainer on an ordinary ADO clone with an ssh
    // push url, locked out of their own repo. Same class as the ADO
    // collection-form regression this suite already records.
    //
    // It shipped because every existing instrument was blind to it. The
    // differential oracle drives SINGLE remotes and never a fetch/push PAIR; the
    // only permissive triangular case was GitHub, where https and ssh share the
    // host `github.com`, so it agreed under every candidate comparison and could
    // not discriminate. This case is the missing sibling.
    //
    // Reds if the ADO branch is ever made to compare the raw host again.
    name: "ado/triangular-same-identity-different-transport-allows",
    mutation:
      "upflow-self-repo.js::_sameDerivedIdentity — compare the raw host on the ADO branch too (instead of the org/project/repo triple alone)",
    repo: {
      dirName: "coc-rs",
      remote: ADO_SELF_REMOTE,
      pushRemote: "git@ssh.dev.azure.com:v3/contoso/platform/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: true, fired: true },
  },
  {
    // THE MIXED-FORM TRIANGULAR LOCKOUT THE QUAD WIDENING CREATED, and the
    // reason `_collectionAbsent` is no longer a comparison operand.
    //
    // ONLY the legacy 3-segment org-subdomain form carries a collection; the
    // ssh v3 form has no slot for one. So an ordinary ADO clone mid-URL-
    // migration — legacy https fetch, modern ssh push, ONE repository —
    // derived collection=DefaultCollection on one side and null on the other.
    // Under the first cut of the quad ("absent matches ONLY absent") that
    // present-vs-absent pair REFUSED, and the refusal was the triangular
    // lockout: org, project and repo all identical, the tree locked out of its
    // own repo. Measured before the fix:
    //   derive ok:false — "fetches from contoso.visualstudio.com
    //   contoso/platform/coc-rs but pushes to ssh.dev.azure.com
    //   contoso/platform/coc-rs; the two disagree about which repo this tree IS"
    // — the two operands the reason prints are IDENTICAL, which is the tell.
    //
    // THIS IS THE SAME CLASS THIS MODULE ALREADY SHIPPED ONCE (see the raw-host
    // comparison lockout recorded in `_sameDerivedIdentity`), reached by a new
    // route, and every instrument was green: the pre-existing permissive
    // triangular case drives the MODERN form on BOTH sides, so both collections
    // are absent, the compare is absent-vs-absent, and it passes no matter what
    // the rule is. A permissive case that cannot red is not an instrument.
    //
    // THE FIX IS SEMANTIC, NOT A SPECIAL CASE: an absent collection IS the
    // DEFAULT collection. `dev.azure.com/<org>/...` and the 2-segment
    // subdomain form both address the org's default collection, which on the
    // hosted hosts this module gates is named `DefaultCollection`. So absent
    // normalizes to `defaultcollection` and is COMPARED rather than
    // side-channelled. Cross-collection stays closed — `OtherCollection` still
    // differs from an absent/default side — which the sibling refusal cases
    // below pin.
    name: "ado/mixed-form-triangular-default-collection-allows",
    mutation:
      "upflow-self-repo.js::isSelfRepoAdo — restore the absent-matches-only-absent rule (`if (lAbsent !== rAbsent) return false;`) instead of normalizing absent to the default collection",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/DefaultCollection/platform/_git/coc-rs",
      pushRemote: "git@ssh.dev.azure.com:v3/contoso/platform/coc-rs",
    },
    adapter: ADO,
    prRef: {
      repoRef: { ...ADO_SELF, collection: "DefaultCollection" },
      prId: 42,
    },
    expect: { ok: true, fired: true },
  },
  {
    // THE PERMISSIVE HALF'S OWN GUARD: absent normalizing to the default must
    // NOT become a wildcard. A NON-default collection on one side and an absent
    // (= default) side are DIFFERENT repositories and must still refuse. Without
    // this case the fix above could be "make absent match anything" and nothing
    // would red.
    name: "ado/non-default-collection-vs-absent-still-refuses",
    mutation:
      "upflow-self-repo.js::isSelfRepoAdo — make an absent collection match ANY present collection (a wildcard) instead of normalizing to the default",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/OtherCollection/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    expectReason: "collection",
  },
  {
    // THE LEGACY VSTS SSH CLONE FORM AS A PUSH URL — a lockout vector the
    // triangular guard newly created out of a pre-existing parse gap.
    // `_parseAdo` filters only `_git`, so the 4-segment `_ssh` shape
    //   ssh://<org>@vs-ssh.visualstudio.com:22/<org>/<proj>/_ssh/<repo>
    // misses the segment-count gate and does not parse. Before this guard
    // existed no push url was ever parsed, so the gap was inert; the guard
    // turned it into "pushes to an unparseable url" and refused a maintainer on
    // a real, documented clone url.
    //
    // The disposition is that an unparseable push url is the ABSENCE of evidence
    // of disagreement, not evidence of it — so the check skips rather than
    // refuses. Reds if the guard ever refuses on a null `pushParsed` again.
    // NOTE this case does NOT assert the `_ssh` form parses; it asserts that
    // failing to parse a PUSH url does not deny a completion. The parse gap
    // itself is recorded separately as a known defect.
    name: "ado/unparseable-legacy-ssh-push-url-does-not-lock-out",
    mutation:
      "upflow-self-repo.js::deriveSelfRepoRef — refuse when `pushParsed` is null (treat an unparseable push url as disagreement)",
    repo: {
      dirName: "coc-rs",
      remote: ADO_SELF_REMOTE,
      pushRemote:
        "ssh://contoso@vs-ssh.visualstudio.com:22/contoso/platform/_ssh/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: true, fired: true },
  },
  {
    name: "gh/triangular-push-default-remote-refuses",
    mutation:
      "upflow-self-repo.js::_readPushRemote — resolve only origin's own pushurl, ignoring branch.<n>.pushRemote and remote.pushDefault",
    repo: {
      dirName: "kailash-coc-rs",
      remote: GH_SELF_REMOTE,
      pushDefaultRemote: "https://github.com/some-consumer/kailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "triangular remote",
  },
  {
    // THE `gitEnv()` ROUTING'S ONLY INSTRUMENT. `git-subprocess-env.js` exists
    // because `GIT_DIR` outranks repository DISCOVERY: neither `cwd:` nor
    // `-C <path>` pins WHICH repository git resolves, so an ambient `GIT_DIR`
    // pointing at a clone of the upstream would make the derivation return the
    // UPSTREAM's slug — the module's own docstring calls that "a fence bypass,
    // not a nuisance". Until this case existed NO fixture set `GIT_DIR`, so
    // removing `env: gitEnv()` changed no value the harness read.
    //
    // Shape: cwd is the SELF repo; a decoy repo whose origin is the UPSTREAM is
    // built alongside and the child's ambient `GIT_DIR` points at it. The
    // derivation must still resolve SELF, so the self-targeted merge SUCCEEDS.
    // Chosen over an upstream-targeted refusal because a refusal is what a
    // BROKEN derivation also produces — this shape fails in the loud direction.
    name: "gh/ambient-git-dir-cannot-redirect-derivation",
    mutation:
      "upflow-self-repo.js::_readOriginRemote — drop `env: gitEnv()` from the execFileSync options, letting the child inherit the ambient environment",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    decoyRepo: {
      dirName: "kailash-coc-claude-py",
      remote: "https://github.com/terrene-foundation/kailash-coc-claude-py.git",
    },
    decoyMode: "git-dir",
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: true, fired: true },
    expectEndpoint: "repos/terrene-foundation/kailash-coc-rs/pulls/",
  },
  {
    // THE PATH-SHAPE REJECTION'S ONLY INSTRUMENT. `normalizeComponent` strips a
    // trailing `.git`, and that strip is what CREATES the dangerous value:
    // `"...git"` -> `".."`. Both sides of the comparison normalize identically,
    // so WITHOUT the rejection the fence PASSES on a `..` and interpolates it
    // into the request path. On ADO that is a repo-scope ESCAPE — the path
    // collapses to the PROJECT-scoped PR address, which is scoped to no
    // repository at all — and both `ADO_REPO_RE` and `ADO_PROJECT_RE` permit
    // dots, so `"...git"` is a valid caller value there.
    //
    // Both adapters already guarded `..` on `head`/`base` (BODY positions) while
    // leaving the repo components (PATH positions) open. This case was added
    // because the guard closing that gap shipped with NO instrument — the sixth
    // time in this change a fix landed untested.
    name: "gh/dot-dot-component-refuses",
    mutation:
      'upflow-self-repo.js::normalizeComponent — delete the `s === "." || s === ".." || s.includes("/")` path-shape rejection',
    repo: {
      dirName: "kailash-coc-rs",
      remote: "https://github.com/terrene-foundation/...git",
    },
    adapter: GH,
    // Target normalizes to `..` too, so without the rejection BOTH sides agree
    // and the fence authorizes — the flip this case exists to catch.
    prRef: {
      repoRef: { owner: "terrene-foundation", name: "...git" },
      prId: 77,
    },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair",
  },
  {
    name: "gh/bare-path-remote-refuses",
    mutation:
      "upflow-self-repo.js::_parseRemoteUrl — when `_splitRemoteUrl` returns null, fall back to the last two path segments as owner/name",
    repo: {
      dirName: "kailash-coc-rs",
      remote: "/srv/mirrors/terrene-foundation/kailash-coc-rs",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    // THE BRANCH IS THE ASSERTION HERE. Without `expectReason` the recorded
    // mutation is INERT: a last-two-segments fallback yields owner/name but no
    // host, so the case still refuses — at the `GITHUB_HOSTS` check, not at the
    // bare-path guard it names. Pinning the derivation-layer message is what
    // keeps this case an instrument for its own mutation (README § "Row 9
    // re-measured").
    expectReason: "does not parse to an owner/name pair (no parseable host)",
  },
  {
    // A forged VERSION naming a DIFFERENT repo, against a real remote naming
    // this one. VERSION is a refuse-only cross-check: it can never SUPPLY the
    // identity, so it cannot authorize a completion on the repo it names.
    name: "gh/forged-version-cannot-authorize-its-named-repo",
    mutation:
      "upflow-self-repo.js::deriveSelfRepoRef — prefer `_declaredSlug(cwd)` over the remote when present (VERSION supplies the identity)",
    repo: {
      dirName: "kailash-coc-rs",
      remote: GH_SELF_REMOTE,
      version: { repo: "terrene-foundation/kailash-coc-claude-py" },
    },
    adapter: GH,
    prRef: { repoRef: GH_UPSTREAM, prId: 77 },
    expect: { ok: false, fired: false },
    // Refuses at the DERIVATION's disagreement check, before the target is ever
    // compared — the same branch as its sibling below. That is what makes this
    // case unable to instrument the cross-check on its own (see the sibling's
    // comment); pinning the branch records it rather than leaving it implied.
    expectReason: "disagrees with the origin remote",
  },
  {
    // Same tree; target now AGREES with the remote. Still refuses, because the
    // declaration disagrees and the identity is therefore unprovable. This is
    // the only case that instruments the cross-check itself: in the case above
    // the target-mismatch refusal would fire regardless.
    name: "gh/version-remote-disagreement-refuses-even-own-repo",
    mutation:
      "upflow-self-repo.js::deriveSelfRepoRef — delete the `declared && declared !== slug` refusal",
    repo: {
      dirName: "kailash-coc-rs",
      remote: GH_SELF_REMOTE,
      version: { repo: "terrene-foundation/kailash-coc-claude-py" },
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "disagrees with the origin remote",
  },
  {
    // THE ASCII PRE-CHECK'S ONLY INSTRUMENT. `normalizeComponent` rejects a
    // non-ASCII component BEFORE lowercasing. The remote's repo name here begins
    // with U+212A KELVIN SIGN, which Unicode case-folds to ASCII "k": with the
    // guard the component normalizes to null, the remote does not parse, and the
    // fence refuses; WITHOUT it the name folds to "kailash-coc-rs", matches self
    // exactly, and the merge is AUTHORIZED. So this is a refuse→authorize flip
    // on `ok`/`fired`, not only a branch change.
    //
    // Stated honestly, because the mutation's REACH and its live-bug status are
    // different questions: Node's `toLowerCase` is locale-INDEPENDENT, and both
    // providers' own validators already confine repoRef components to ASCII, so
    // the guard's job is to make the property STRUCTURAL on the one path those
    // validators do not cover — the origin remote, which nothing validates. This
    // case locks that property; it is not evidence of a reachable defect on
    // github.com, whose repo names are ASCII by construction.
    name: "gh/non-ascii-remote-component-refuses",
    mutation:
      "upflow-self-repo.js::normalizeComponent — delete the `if (!/^[\\x00-\\x7f]*$/.test(raw)) return null;` ASCII pre-check",
    repo: {
      dirName: "kailash-coc-rs",
      // U+212A KELVIN SIGN + "ailash-coc-rs" — written as a `\u212A` ESCAPE, not
      // a raw character, so this file stays ASCII and the codepoint is legible in
      // review. That is load-bearing rather than cosmetic. The raw character sat
      // here for a while under a comment already claiming it was an escape, and
      // any normalizing pass that folded it to ASCII "k" — a lint, an editor, a
      // copy through a Unicode-folding tool — would have turned this case into a
      // silent NO-OP: the remote would derive cleanly as
      // `terrene-foundation/kailash-coc-rs`, match GH_SELF, authorize, and stop
      // exercising the ASCII guard entirely, with nothing anywhere going red.
      // That is the inert-case failure this whole suite exists to prevent, so it
      // does not get to live inside the suite.
      remote: "https://github.com/terrene-foundation/\u212Aailash-coc-rs.git",
    },
    adapter: GH,
    prRef: { repoRef: GH_SELF, prId: 77 },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair (host github.com)",
  },

  // ---- Azure DevOps (provider parity — the un-fenced provider is the bypass)
  {
    name: "ado/refuse-downstream-completing-upstream",
    mutation:
      "vcs-azure-adapter.js::completeUpflowPR — delete the `if (!selfRepo.isSelfRepoAdo(repoRef, selfAdo))` refusal block",
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    adapter: ADO,
    prRef: { repoRef: ADO_UPSTREAM, prId: 42 },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    // Userinfo form (`https://<org>@dev.azure.com/...`) — exercises the
    // authority-userinfo strip, without which the host is not an ADO host at
    // all and this legitimate merge would be refused.
    name: "ado/allow-maintainer-completing-own-repo-userinfo-form",
    mutation:
      'upflow-self-repo.js::_splitRemoteUrl — drop the userinfo strip (`authority.lastIndexOf("@")`)',
    repo: {
      dirName: "coc-rs",
      remote: "https://contoso@dev.azure.com/contoso/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: true, fired: true },
  },
  {
    name: "ado/case-insensitive-own-repo-still-allowed",
    mutation: "upflow-self-repo.js::normalizeComponent — drop `.toLowerCase()`",
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    adapter: ADO,
    prRef: {
      repoRef: { org: "Contoso", project: "Platform", repo: "COC-RS" },
      prId: 42,
    },
    expect: { ok: true, fired: true },
    // ADO twin: caller passes MIXED CASE, path must carry the derived form.
    expectEndpoint: "contoso/platform/_apis/git/repositories/coc-rs/",
  },
  {
    // THE HIGHEST-VALUE CASE. Under the defeated build `org` was read off
    // `repoRef` while project/repo came from the derivation, so the org leg
    // self-compared and could never fail: a foreign org with a matching
    // project+repo completed. All three components must come from the remote.
    name: "ado/cross-org-same-project-and-repo-refuses",
    mutation:
      'upflow-self-repo.js::isSelfRepoAdo — drop `org` from the compared key list (`["project", "repo"]`)',
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    adapter: ADO,
    prRef: {
      repoRef: { org: "fabrikam", project: "platform", repo: "coc-rs" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    // Pins the TARGET-COMPARE branch. Both underivable branches share a label,
    // so a case that drifted into either would still read as "a refusal" without
    // this; here it also asserts the refusal is the org leg's, not a derivation
    // failure that would fire for a repo with no ADO remote at all.
    expectReason: "cross-repo completion refused",
  },
  {
    // THE PROJECT LEG'S ONLY INSTRUMENT. Sibling of the cross-ORG case above and
    // of `gh/cross-owner-same-name-refuses`. A predicate sweep measured that
    // dropping `project` from `isSelfRepoAdo`'s compared keys left the suite
    // fully GREEN: the existing ADO cases differ in ORG (cross-org) or in REPO
    // (upstream), never in PROJECT alone, so no case could distinguish it.
    // Third instance of the same "leg that can never fail" defect — after the
    // ADO `org` leg and the GitHub `owner` leg.
    name: "ado/cross-project-same-org-and-repo-refuses",
    mutation:
      "upflow-self-repo.js::isSelfRepoAdo — drop `project` from the compared keys, leaving org+repo",
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    adapter: ADO,
    prRef: {
      repoRef: { org: "contoso", project: "otherproject", repo: "coc-rs" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    // A repo whose origin is not an ADO remote cannot prove an ADO identity.
    // The mutation is the historical self-compare shape, which is what this
    // guard exists to keep out.
    // THE ADO HOST PREDICATE'S ONLY INSTRUMENT — and it is FAIL-OPEN, which is
    // why it needs its own case rather than sharing the sibling below.
    // `_parseAdo`'s `if (!isAdoHost) return null;` IS the ADO adapter's host
    // fence; unlike GitHub there is no `GITHUB_HOSTS`-style allowlist at the
    // adapter. Deleting it leaves the suite green while ANY 3-or-more-segment
    // non-ADO remote (an internal GitLab/Gitea mirror) parses as org/project/
    // repo and AUTHORIZES a completion against a repo the remote does not name.
    //
    // The sibling `ado/non-ado-remote-refuses` cannot cover this: it drives a
    // 2-segment GitHub remote, which the org/project/repo count check refuses
    // FIRST, so the host predicate is never the discriminator there. Three
    // segments is what reaches it. (That check read `segs.length < 3` when this
    // comment was written and is now `!== 3` — see the exact-count fix in
    // `_parseAdo`; the reasoning is unchanged, the citation is updated so it
    // does not describe a guard that no longer exists.)
    //
    // REFUSAL BRANCH MOVED, recorded rather than hidden: this case previously
    // refused at the ADO adapter's `!selfAdo` branch ("is not an Azure DevOps
    // remote"). The exact-count fix now refuses it one step EARLIER, in
    // `_parseRemoteUrl`'s generic branch — a non-ADO host with three path
    // segments is not two, so no owner/name pair forms at all. Still a correct
    // refusal, and it still discriminates: under the stated mutation `_parseAdo`
    // accepts the gitlab host, the three segments become a valid org/project/
    // repo triple, and the derivation SUCCEEDS.
    name: "ado/three-segment-non-ado-remote-refuses",
    mutation:
      "upflow-self-repo.js::_parseAdo — delete the `if (!isAdoHost) return null;` host predicate",
    repo: {
      dirName: "coc-rs",
      remote: "https://gitlab.internal.example/contoso/platform/coc-rs.git",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    // Pins the host in the reason text, which is the load-bearing half: it
    // proves the derivation resolved `gitlab.internal.example` and refused ON
    // that, rather than refusing for some unrelated parse reason.
    expectReason:
      "does not parse to an owner/name pair (host gitlab.internal.example)",
  },
  {
    name: "ado/non-ado-remote-refuses",
    mutation:
      "vcs-azure-adapter.js::completeUpflowPR — replace the `if (!selfAdo)` refusal with the self-compare fallback `let selfAdo = d.self.ado; if (!selfAdo) selfAdo = repoRef;`",
    repo: { dirName: "coc-rs", remote: GH_SELF_REMOTE },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    // SPLITS THE SHARED LABEL. `vcs-azure-adapter.js` emits
    // `completeUpflowPR: self-identity underivable` from BOTH the `!d.ok` branch
    // and this `!selfAdo` branch, so `label` alone cannot say which fired —
    // exactly the wrong-branch-pass hole `gh/bare-path-remote-refuses` was fixed
    // for. The reason is where the two diverge, so it is what gets pinned.
    expectReason: "is not an Azure DevOps remote",
  },
  {
    name: "ado/allow-own-repo-ssh-v3-form",
    mutation:
      "upflow-self-repo.js::_parseAdo — drop the leading-`v3` segment strip",
    repo: {
      dirName: "coc-rs",
      remote: "git@ssh.dev.azure.com:v3/contoso/platform/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: true, fired: true },
  },
  {
    name: "ado/allow-own-repo-visualstudio-subdomain-form",
    mutation:
      "upflow-self-repo.js::_parseAdo — drop the `isOrgSubdomain` branch that takes `<org>` from the host",
    repo: {
      dirName: "coc-rs",
      remote: "https://contoso.visualstudio.com/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: true, fired: true },
  },
  {
    // REGRESSION GUARD FOR A FALSE REFUSAL THIS SUITE DID NOT CATCH.
    // The legacy TFS/VSTS collection URL carries a COLLECTION segment ahead of
    // the project: `<org>.visualstudio.com/DefaultCollection/<project>/_git/<repo>`.
    // The first cut of the exact-segment-count fix required the org-subdomain
    // form to be exactly 2 segments and REFUSED this — a remote that derived
    // correctly before the fix. That is a maintainer lockout: the operator
    // could no longer complete a PR on their own repo.
    //
    // It was caught by manually widening the legitimate-form sweep, NOT by this
    // suite and NOT by review — every ADO case here drove a collection-less
    // URL, and the recommendation the fix was written from enumerated four
    // forms without this one. This case exists so the next tightening of
    // `_parseAdo` reds instead of silently locking someone out.
    //
    // PERMISSIVE by design: `expect ok:true, fired:true`. A refusal-only suite
    // cannot detect an over-tightening, because every over-tightening looks
    // like a correct refusal.
    //
    // `repoRef` now STATES the collection. It did not have to before the ADO
    // identity became a QUAD, because the collection was discarded by the parse
    // and no comparison could see it. Stating it is what keeps this case
    // PERMISSIVE under the quad: an unstated collection no longer matches a
    // present one (that polarity is the sibling case
    // `ado/unstated-collection-does-not-match-a-nondefault-collection-form`).
    name: "ado/allow-own-repo-legacy-collection-form",
    mutation:
      "upflow-self-repo.js::_parseAdo — require the org-subdomain form to be exactly 2 segments (drop the optional collection)",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/DefaultCollection/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: {
      repoRef: { ...ADO_SELF, collection: "DefaultCollection" },
      prId: 42,
    },
    expect: { ok: true, fired: true },
  },
  {
    // THE DEFECT THIS QUAD EXISTS TO CLOSE, on the DERIVED×DERIVED lane — two
    // remotes that differ ONLY in their collection segment. In legacy TFS/VSTS
    // a collection is a NAMESPACE, so these name two different repositories:
    //   fetch https://<org>.visualstudio.com/DefaultCollection/<proj>/_git/<repo>
    //   push  https://<org>.visualstudio.com/OtherCollection/<proj>/_git/<repo>
    // Before the collection was retained through `_parseAdo` both sides reduced
    // to an IDENTICAL {org, project, repo} triple, `_sameDerivedIdentity`
    // compared them EQUAL, the triangular guard saw no disagreement, and the
    // completion fired (measured: ok=true fired=true).
    //
    // NOT fixable by any rearrangement of the triple — the collection was
    // absent from the identity model entirely. This case is the instrument for
    // the widening, and it is the ONE that reds if the collection is dropped
    // from the parse again.
    name: "ado/triangular-cross-collection-same-org-project-repo-refuses",
    mutation:
      "upflow-self-repo.js::_parseAdo — drop `collection` from the returned ADO identity (revert the quad to a triple)",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/DefaultCollection/platform/_git/coc-rs",
      pushRemote:
        "https://contoso.visualstudio.com/OtherCollection/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: {
      repoRef: { ...ADO_SELF, collection: "DefaultCollection" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "triangular remote",
  },
  {
    // THE SAME DEFECT ON THE ADAPTER LANE — caller-stated collection vs derived
    // collection, both PRESENT and different. The triangular case above reds
    // through `_sameDerivedIdentity`; this one isolates the `isSelfRepoAdo`
    // collection leg itself, reached directly from `completeUpflowPR`.
    //
    // Both cases are needed for the same reason the README records three times
    // (the ADO `org` leg, the GitHub `owner` leg, the ADO `project` leg): a leg
    // exercised only through a sibling path is a leg no case can isolate.
    name: "ado/cross-collection-same-org-project-repo-refuses",
    mutation:
      "upflow-self-repo.js::isSelfRepoAdo — delete the collection comparison (compare org/project/repo only)",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/OtherCollection/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: {
      repoRef: { ...ADO_SELF, collection: "DefaultCollection" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    // THE ABSENT-vs-PRESENT POLARITY, caller side unstated. `repoRef` names no
    // collection; the derived self is on a NON-DEFAULT one. An unstated
    // collection is NOT a wildcard — it resolves to the org's DEFAULT
    // collection, which is a different namespace from `OtherCollection`, so
    // this refuses.
    //
    // BOTH POLARITY CASES ORIGINALLY DROVE `DefaultCollection` AND WERE WRONG.
    // They asserted that an absent collection differs from `DefaultCollection`,
    // which pinned the mixed-form maintainer lockout as correct behavior — an
    // ordinary clone with a legacy https fetch and a modern ssh push refused
    // itself. The cases were not merely passing over a bug, they were the
    // reason it looked instrumented. Corrected to a NON-DEFAULT collection,
    // which is what actually makes the two sides different repositories and
    // preserves what these cases were FOR: absent must not become a wildcard.
    name: "ado/unstated-collection-does-not-match-a-nondefault-collection-form",
    mutation:
      "upflow-self-repo.js::isSelfRepoAdo — treat an absent `repoRef.collection` as matching any derived collection",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/OtherCollection/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    // THE MIRROR POLARITY — caller STATES a NON-DEFAULT collection, derived
    // self is on a collection-less (modern `dev.azure.com`) form, which
    // resolves to the default. Different namespaces, so it refuses. Both
    // polarities are cased because a one-sided nullable comparison is
    // asymmetric by construction, and only a pair can show it is not.
    //
    // The default-vs-absent direction is the OPPOSITE assertion and is pinned
    // separately by `ado/mixed-form-triangular-default-collection-allows`;
    // together the three cover absent-matches-default, absent-differs-from-
    // non-default, and non-default-differs-from-absent.
    name: "ado/stated-nondefault-collection-does-not-match-a-collection-free-form",
    mutation:
      "upflow-self-repo.js::isSelfRepoAdo — treat an absent derived collection as matching any stated `repoRef.collection`",
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    adapter: ADO,
    prRef: {
      repoRef: { ...ADO_SELF, collection: "OtherCollection" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "cross-repo completion refused",
  },
  {
    // THE VALIDATOR LEG. `repoRef.collection` is a NEW caller-authored operand,
    // so it needs the same shape guard the other three carry — otherwise the
    // quad's fourth field is the one place a caller can put anything. Refuses
    // at `validateRepoRef`, BEFORE the fence, like the sibling org/project/repo
    // guards.
    //
    // `Default Collection` (with the space) is the realistic bad value: ADO
    // permits spaces in display names and the URL-safe form is what the
    // derivation reads off the remote, so a caller transcribing the display
    // name is the ordinary way to reach this branch.
    name: "ado/invalid-collection-in-repo-ref-refuses",
    mutation:
      "vcs-azure-adapter.js::validateRepoRef — delete the `ref.collection` validation branch",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/DefaultCollection/platform/_git/coc-rs",
    },
    adapter: ADO,
    prRef: {
      repoRef: { ...ADO_SELF, collection: "Default Collection" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "repoRef.collection",
  },
  {
    // The injection sibling of the case above, and the reason allowing THREE
    // segments there does not reopen the fragment-path hole. A `#`/`?` always
    // lands ON a segment, and the `normalizeComponent` allowlist nulls it:
    //   `.../platform/_git/coc-rs#/x` -> ["platform","coc-rs#","x"]
    //   normalizeComponent("coc-rs#") -> null  (measured)
    // so three segments cannot be forged CLEAN, and four fail the count.
    // THE COLLECTION ALLOWANCE AND THE CHARACTER ALLOWLIST ARE COUPLED — this
    // case is what reds if the allowlist is ever relaxed.
    // THE DISCARDED-SLOT INJECTION, and the case that refuted a security claim
    // this file's sibling comment previously asserted. The collection segment
    // is dropped by `slice(1)`, and it was the ONE position in the parser whose
    // content never passed `normalizeComponent` — an unvalidated junk drawer.
    // So the injection never needed three CLEAN segments, only two plus that
    // slot:
    //
    //   https://realorg.visualstudio.com/realproj#/proj2/_git/repo2
    //     filter -> ["realproj#","proj2","repo2"]  3, passes the count
    //     slice  -> ["proj2","repo2"]              the dirty one is discarded
    //     derived-> {org: realorg, project: proj2, repo: repo2}   (MEASURED)
    //
    // The sibling case below drives a dirty RETAINED segment and passed
    // throughout — which is exactly why the false claim survived: the suite
    // instrumented the half that held and not the half that did not.
    //
    // Harm ~zero (neither form is fetchable: `#` truncates at curl, `?`
    // collides with git's `/info/refs?service=…`), so this is a parse defect,
    // not an escalation. Fixed anyway rather than left safe-by-accident.
    name: "ado/discarded-collection-slot-rejects-dirty-segment",
    // THE RECORDED MUTATION IS NOW THE PAIR, AND THAT IS A CORRECTION.
    // This case's mutation used to be the validate-before-use check ALONE, and
    // that was accurate until the collection stopped being discarded. Retaining
    // it added a SECOND guard on the same byte — the present-but-unnormalizable
    // check at the end of `_parseAdo` — so deleting either one alone now leaves
    // the suite GREEN. Measured, both directions, rather than assumed:
    //   delete the validate-before-use check ALONE  -> GREEN 53/53
    //   delete the tail collection guard ALONE      -> GREEN 53/53
    //   delete BOTH                                 -> RED, this case
    // Per `instrument-discipline.md` MUST-2(b) the two greens are RESOLVED, not
    // left as live hypotheses: each is SUBSUMED by its sibling (the pair's RED
    // is what shows the byte is still guarded), not vacuous. The stale
    // single-guard mutation is replaced rather than left standing, because an
    // un-reddening `mutation:` field is precisely what this suite's README
    // rules out as evidence.
    mutation:
      "upflow-self-repo.js::_parseAdo — the PAIR: delete BOTH the `segs.some(normalizeComponent === null)` validate-before-use check AND the trailing `if (collection !== null && !ado.collection) return null;` guard (either alone leaves the suite green)",
    repo: {
      dirName: "coc-rs",
      remote: "https://contoso.visualstudio.com/platform#/proj2/_git/repo2",
    },
    adapter: ADO,
    // repoRef names what the injection smuggles in, so under the mutation this
    // derives, compares EQUAL, and fires.
    prRef: {
      repoRef: { org: "contoso", project: "proj2", repo: "repo2" },
      prId: 42,
    },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair",
  },
  {
    name: "ado/collection-form-does-not-admit-fragment-injection",
    mutation:
      "upflow-self-repo.js::normalizeComponent — remove the `/^[A-Za-z0-9._-]+$/` allowlist",
    repo: {
      dirName: "coc-rs",
      remote:
        "https://contoso.visualstudio.com/platform/_git/coc-rs#/otherproj",
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    expectReason: "does not parse to an owner/name pair",
  },
  {
    // The ADO adapter's underivable branch. Its instrument is `error === null`:
    // deleting the guard does not flip `ok`, it makes `d.self.ado` throw — and a
    // crash reads as a refusal to any assertion that only checks `ok === false`.
    name: "ado/no-origin-remote-refuses-typed-not-throws",
    mutation:
      "vcs-azure-adapter.js::completeUpflowPR — delete the `if (!d || !d.ok)` underivable refusal (the next line then throws on `d.self`)",
    repo: {
      dirName: "coc-rs",
      remote: null,
      // Value is incidental to the assertion — this case has NO remote and must
      // refuse regardless; the declaration exists only to prove `VERSION` cannot
      // RESCUE a missing remote. Written with the Foundation slug because the
      // synced-disclosure scanner matches any other `owner/name`-shaped literal
      // as a possible org slug, and a synthetic ADO project/repo pair is not
      // worth an allowlist edit to that fence.
      version: { repo: "terrene-foundation/coc-rs" },
    },
    adapter: ADO,
    prRef: { repoRef: ADO_SELF, prId: 42 },
    expect: { ok: false, fired: false },
    // The other half of the shared-label split (see the case above). Pins the
    // DERIVATION-layer message, which only the `!d.ok` branch forwards.
    expectReason: "yielded no remote for this working tree",
  },

  // ---- Path-interpolation guards (downstream of the fence) ------------------
  // These three do NOT exercise a fence branch. They sit one step LATER, at the
  // shape guards on the two values still authored by the caller after the fence
  // has sourced every repo component from the derivation. `prId` is interpolated
  // straight into the request path, which makes it the last caller-controlled
  // path content on a path that was just hardened to source everything else from
  // `d.self` / `selfAdo` — so its guard is load-bearing, not decorative.
  //
  // Each uses a remote that CLEARS the fence (self remote + self repoRef), which
  // is what lets the case reach the guard at all; a cross-repo target would be
  // refused earlier and the case would instrument the fence again instead.
  {
    name: "gh/non-numeric-pr-id-refuses",
    mutation:
      "vcs-github-adapter.js::completeUpflowPR — delete the `PR_NUMBER_RE.test(String(prId))` prId guard block",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    // Path traversal in the PR-number position: with the guard gone this
    // interpolates into `repos/<o>/<n>/pulls/<HERE>/merge` and the request
    // addresses a different repo's PR than the fence just authorized.
    prRef: { repoRef: GH_SELF, prId: "77/../../repos/other/x/pulls/1" },
    expect: { ok: false, fired: false },
    expectReason: "prId must match /^[0-9]+$/ (PR number)",
  },
  {
    name: "gh/invalid-merge-method-refuses",
    mutation:
      "vcs-github-adapter.js::completeUpflowPR — delete the `MERGE_METHOD_RE.test(mergeMethod)` guard block",
    repo: { dirName: "kailash-coc-rs", remote: GH_SELF_REMOTE },
    adapter: GH,
    // `mergeMethod` reaches the request BODY rather than the path, so this is
    // the enum guard rather than a traversal one. No pre-existing case passed
    // `mergeMethod` at all, so the whole guard was un-instrumented.
    prRef: { repoRef: GH_SELF, prId: 77, mergeMethod: "force-push" },
    expect: { ok: false, fired: false },
    expectReason: "mergeMethod must be one of merge|squash|rebase",
  },
  {
    name: "ado/non-numeric-pr-id-refuses",
    mutation:
      "vcs-azure-adapter.js::completeUpflowPR — delete the `ADO_PR_ID_RE.test(String(prId))` prId guard block",
    repo: { dirName: "coc-rs", remote: ADO_SELF_REMOTE },
    adapter: ADO,
    prRef: {
      repoRef: ADO_SELF,
      prId: "42/../../pullrequests/1",
    },
    expect: { ok: false, fired: false },
    // "(PR id)" not "(PR number)" — the two providers' guards word the tail
    // differently, so this also pins WHICH adapter refused.
    expectReason: "prId must match /^[0-9]+$/ (PR id)",
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * The string `expectReason` is matched against: the adapter's short `_fail`
 * label joined to its long reason. Substring/RegExp, never whole-sentence — see
 * the header.
 */
function refusalBlob(out) {
  return [out.label, out.reason].filter(Boolean).join(" | ");
}

function reasonMatches(expectReason, blob) {
  if (expectReason === undefined) return true;
  return expectReason instanceof RegExp
    ? expectReason.test(blob)
    : blob.includes(expectReason);
}

let failed = 0;
for (const c of cases) {
  let made = null;
  let decoy = null;
  try {
    made = makeRepo(c.repo);
    // `c.decoyRepo` builds a SECOND repo and points the child's ambient
    // `GIT_DIR` at it. Used only by the ambient-GIT_DIR probe.
    let extraEnv;
    let prRef = c.prRef;
    if (c.decoyRepo) {
      decoy = makeRepo(c.decoyRepo);
      if (c.decoyMode === "git-dir") {
        extraEnv = { GIT_DIR: path.join(decoy.repo, ".git") };
      } else if (c.decoyMode === "descriptor-seam") {
        // Inject the ONCE-REMOVED caller-authored identity seams onto the
        // descriptor, pointed at the decoy. The decoy path only exists at
        // runtime, so it cannot be written into the static case.
        // `decoySelfRepoRef` carries the PROVIDER-SHAPED forged identity —
        // `{owner,name}` on GitHub, `{org,project,repo}` on ADO. It must match
        // the adapter under test: injecting a GitHub-shaped `selfRepoRef` into
        // the ADO adapter would be ignored for being the wrong SHAPE rather
        // than for being caller-authored, which is a weaker assertion than the
        // one this case claims to make.
        prRef = {
          ...c.prRef,
          cwd: decoy.repo,
          selfRepoRef: c.decoySelfRepoRef,
          _deriveSelfFn: "__must_be_ignored__",
        };
      }
    }
    const out = runInRepo(made.repo, c.adapter, prRef, extraEnv);
    const blob = refusalBlob(out);
    const reasonOk = reasonMatches(c.expectReason, blob);
    // `expectEndpoint` pins the request path the adapter actually built. Only
    // meaningful on ALLOW cases whose `repoRef` differs in BYTES from the
    // derived identity (mixed case, `.git` suffix) — everywhere else the two
    // are identical and the assertion cannot discriminate.
    const endpointOk =
      c.expectEndpoint === undefined
        ? true
        : c.expectEndpoint instanceof RegExp
          ? c.expectEndpoint.test(String(out.endpoint || ""))
          : String(out.endpoint || "").includes(c.expectEndpoint);
    // `expectReasonAbsent` is the NEGATIVE assertion, and it is the only shape
    // that can instrument a SANITIZER. A sanitizer's job is that something does
    // NOT appear in the output, so every positive assertion in this harness is
    // blind to it: `displayPrId` could be collapsed to `String(value)` and every
    // ok/fired/reason-contains check would still pass. Asserting the raw payload
    // is ABSENT from the refusal blob is what reds when the guard is removed.
    const reasonAbsentOk =
      c.expectReasonAbsent === undefined
        ? true
        : !blob.includes(c.expectReasonAbsent);
    const pass =
      out.ok === c.expect.ok &&
      out.fired === c.expect.fired &&
      out.error === null &&
      reasonOk &&
      reasonAbsentOk &&
      endpointOk;
    if (pass) {
      console.log(`  ok ${c.name}`);
    } else {
      failed++;
      console.log(
        `  not ok ${c.name}` +
          `\n      expected ok=${c.expect.ok} fired=${c.expect.fired} error=null` +
          (c.expectReason === undefined
            ? ""
            : `\n      expected reason to contain: ${c.expectReason}`) +
          `\n      actual   ok=${out.ok} fired=${out.fired} error=${out.error}` +
          (reasonOk ? "" : `\n      WRONG REFUSAL BRANCH`) +
          (endpointOk
            ? ""
            : `\n      WRONG ENDPOINT — expected to contain: ${c.expectEndpoint}` +
              `\n      actual endpoint: ${out.endpoint || "(none)"}`) +
          `\n      reason:  ${blob || "(none)"}`,
      );
    }
  } catch (err) {
    failed++;
    console.log(`  not ok ${c.name} — THREW: ${err && err.message}`);
  } finally {
    if (made) fs.rmSync(made.root, { recursive: true, force: true });
    if (decoy) fs.rmSync(decoy.root, { recursive: true, force: true });
  }
}

console.log(
  failed === 0
    ? `\nupflow-open-never-complete: ${cases.length}/${cases.length} PASS`
    : `\nupflow-open-never-complete: ${failed}/${cases.length} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
