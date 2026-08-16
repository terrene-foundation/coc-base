/**
 * upflow-self-repo.js — derive THIS repo's own identity for the
 * `upstream-issue-hygiene.md` MUST-4 ("Open, Never Complete") fence.
 *
 * WHY THIS MODULE EXISTS. The first cut of the MUST-4 fence took `selfRepoRef`
 * as a DESCRIPTOR FIELD and compared it against `repoRef` — but both operands
 * then came off the same caller-authored object, so `{repoRef: X, selfRepoRef: X}`
 * cleared it trivially. Deriving the identity from the environment rather than
 * accepting it from the caller is NECESSARY for the fence to mean anything —
 * and it is not SUFFICIENT to make the identity unforgeable, which this module
 * does not attempt and cannot achieve (see the bound below).
 *
 * TWO LATER ROUNDS EACH *MOVED* THE CALLER-AUTHORED OPERAND INSTEAD OF REMOVING
 * IT — `selfRepoRef` became a `_deriveSelfFn` injection seam, then a `cwd` field.
 * Either one still let a caller choose the answer: substituting the deriver is
 * self-evident, and pointing `cwd` at a scratch directory holding a forged
 * `.claude/VERSION` and no git remote made the dirname fallback in
 * `version-utils.js::readRepoIdentity` yield `slug: null`, at which point the
 * forged declaration was the only slug left and the fence returned `ok:true` on
 * an arbitrary upstream. Both seams are now GONE, in production and in tests:
 * `deriveSelfRepoRef` takes exactly one parameter, and the adapters hardcode
 * `process.cwd()`.
 *
 * WHAT IS AUTHORITATIVE, AND WHAT IS NOT.
 *   - The LIVE GIT REMOTE (`git -C <cwd> remote get-url origin`) is the SOLE
 *     source of the identity. If it cannot be read, or does not parse to an
 *     owner/name pair, the fence REFUSES. There is deliberately NO dirname
 *     fallback: a directory name is caller-chosen, and that fallback was the
 *     exploit path above.
 *   - `.claude/VERSION::repo` is a CROSS-CHECK ONLY. It can REFUSE (when it
 *     disagrees with the remote) but it can NEVER SUPPLY the identity. A forged
 *     VERSION file is therefore powerless — the worst it can do is deny a
 *     completion, which is the safe direction.
 *
 * WHAT THIS IS AND IS NOT EVIDENCE OF (`instrument-discipline.md` MUST-1 asks
 * what result the instrument would produce if the proposition were false). This
 * refuses any completion whose target does not match the identity derived from
 * the working tree the process runs in. That CLOSES the accident class — which
 * IS the originating incident — and raises the cost of a deliberate act, since
 * the caller must now stand up a tree whose origin remote names the upstream
 * rather than fill in a field. It is NOT a boundary against a caller that can
 * choose its own working directory: `process.cwd()` is selected by whoever
 * launches the process, so a scratch tree with `origin` pointed at the upstream
 * derives that upstream and clears the fence. It cannot be such a boundary — a
 * caller running arbitrary code in-process can replace this module outright.
 * Removing the descriptor seams was still correct: they were forgeable by
 * writing one object literal, which is not the same cost at all.
 *
 * ONE SHARED HELPER, NOT PER-CALL-SITE (`security.md` § Credential Decode Helpers):
 * both VCS adapters route through this, so the two providers cannot normalize
 * differently — the drift shape `security.md` § Enforcement-Surface Parity blocks.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { resolveGitBinary, gitEnv } = require("./git-subprocess-env.js");

/**
 * Normalize one repo-identity component the SAME way `version-utils.js::
 * declaredSelfRepo` does — lowercase, strip a trailing `.git`, drop ADO `_git`
 * routing segments. Divergent normalization between the derivation source and
 * the comparator produced a FALSE "cross-repo" refusal against a maintainer
 * whose repoRef was built from a remote URL (`.git` retained) — fail-closed,
 * but it accused them of the exact violation they were not committing.
 */
function normalizeComponent(v) {
  if (v === undefined || v === null) return null;
  const raw = String(v);
  // Repo-identity components are ASCII on both providers, per the validators
  // that already gate them — each quoted from its source, since the ASCII
  // property is the only thing claimed here and a mis-attributed pattern would
  // hide which component permits what:
  //   github-login.js:33 GITHUB_LOGIN_RE   /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/
  //   github-login.js:37 GITHUB_REPO_RE    /^[a-zA-Z0-9._-]{1,100}$/
  //   ado-login.js:52    ADO_ORG_RE        /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
  //   ado-login.js       ADO_PROJECT_RE / ADO_REPO_RE  /^[A-Za-z0-9._-]{1,64}$/
  // (Line numbers are given only where they have held; the ADO_PROJECT_RE /
  // ADO_REPO_RE citation said `ado-login.js:61-62`, correct when written and
  // shifted +10 by a later edit to that file, so it pointed at prose. The
  // constant NAMES are stable and greppable, the line numbers are not; the
  // pattern bodies above are what this comment actually asserts.)
  // Note ADO_ORG_RE admits NEITHER dots NOR underscores and caps at 63 — it is
  // materially tighter than the project/repo pattern, so no VALIDATOR-GATED org
  // can carry a `.git` suffix for the strip below to act on. Stated with that
  // qualifier because the unqualified form was false on the half that matters:
  // the DERIVED org comes from an ungated URL path segment (`_parseAdo` reads
  // `segs[0]`), so `https://dev.azure.com/foo.git/proj/_git/repo` DOES reach
  // the strip and derives org `foo`. Inert in practice — ADO forbids dots in
  // org names, so no such org exists, and the derived value is what the request
  // is addressed to either way — but this file's standard is precise claims,
  // and it has already had to correct two comments that asserted more than the
  // code guaranteed. All five are ASCII-only,
  // which is the property this guard rests on. Reject non-ASCII BEFORE lowercasing to close the
  // locale-aware
  // case-fold surface — Turkish "İ".toLowerCase() resolves to "i" on
  // locale-aware engines, and U+212A KELVIN SIGN lowercases to ASCII "k" under
  // Unicode default case-folding, so a non-ASCII component could otherwise
  // compare equal to an ASCII one. Node's `.toLowerCase()` is
  // locale-INDEPENDENT, but the guard makes the property structural rather than
  // engine-dependent — the same guard `github-login.js::normalizeLogin` and
  // `ado-login.js::normalizePrincipal` carry. Zero-length input needs no
  // separate guard here: the trailing `s && ...` below already returns null.
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(raw)) return null;
  const s = raw
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  // PATH-SHAPE REJECTION, and it must come AFTER the `.git` strip because the
  // strip is what CREATES the dangerous value: `"...git"` -> `".."`. Both sides
  // of every comparison normalize identically, so a `..` would clear the fence
  // and then reach an interpolated request path. On ADO that is a repo-scope
  // ESCAPE — `${org}/${project}/_apis/git/repositories/../pullrequests/${id}`
  // collapses to the PROJECT-scoped PR address, which is not scoped to any
  // repository, and `ADO_REPO_RE`/`ADO_PROJECT_RE` both permit dots so
  // `"...git"` is a valid caller value. `security.md` § Path Containment: test
  // the canonical form, then USE the canonical form — a `..` surviving the
  // canonicalization is exactly the containment miss that section blocks.
  // Note both adapters already guard `..` on `head`/`base` (BODY positions);
  // the repo components reach PATH positions and were unguarded.
  if (s === "." || s === ".." || s.includes("/") || s.includes("\\"))
    return null;
  // POSITIVE ALLOWLIST, replacing what was a four-member denylist (`.`, `..`,
  // `/`, `\`). Everything else in the `\x00-\x7f` range the ASCII guard admits
  // used to survive to an interpolated request path — `?` and `#` (which
  // TERMINATE a path: `.../repositories/repo?x=1/pullrequests/5` addresses
  // `repo` with the rest as query string), percent-encoded separators (`%2e%2e`
  // reconstitutes `..` under RFC 3986 §6.2.2.2 normalization at any server or
  // proxy that decodes), and raw control bytes (`\x00`, `\r`, `\n`).
  //
  // Measured, so the change is not theoretical: an origin of
  // `https://dev.azure.com/org/proj/_git/repo?x=1` derived `ado.repo` as
  // `"repo?x=1"` before this line existed.
  //
  // REACHABILITY WAS ALREADY CLOSED, and this is defense-in-depth, stated so no
  // reader mistakes it for a live-bug fix: both adapters call `validateRepoRef`
  // as their FIRST statement, and the fence requires the derived component to
  // COMPARE EQUAL to a `repoRef` component that has passed GITHUB_REPO_RE /
  // ADO_REPO_RE — neither of which admits any of these bytes. So the dangerous
  // derived value could never match a caller value and always refused. That
  // safety depended on a SECOND module's regex staying strict; the allowlist
  // here makes it a property of this function.
  //
  // The set is the UNION of what the providers' validators accept across the
  // component classes quoted above — `GITHUB_LOGIN_RE` and `ADO_ORG_RE` admit
  // neither `.` nor `_`, so the intersection would be narrower and would reject
  // legitimate repo names. UNION is what the safety argument below actually
  // needs (no legitimate component is refused); an earlier draft said
  // "INTERSECTION", which named the wrong set for a correct conclusion.
  // (`[A-Za-z0-9._-]`, quoted with line numbers above), so no legitimate owner,
  // name, org, project, or repo is affected. A denylist would have to enumerate
  // every future dangerous byte; this closes the class (`cc-artifacts.md`
  // Rule 10 — positive allowlists where the vocabulary is enumerable).
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s && s !== "_git" ? s : null;
}

/**
 * Read the origin remote URL. Returns null on ANY failure (no remote, not a git
 * repo, git unresolvable, timeout) — the caller turns that into a refusal.
 *
 * ROUTED THROUGH THE SHARED GIT ALLOWLIST (`git-subprocess-env.js`), as the
 * three sibling guards (`violation-patterns.js`, `guard-path-scope.js`,
 * `coordination-mode.js`) already are — `security.md` § Enforcement-Surface
 * Parity: a fail-closed dimension lands at EVERY surface through ONE shared
 * function, or the un-routed surface becomes the bypass.
 *
 * Two things the routing buys, and this fence needs BOTH:
 *   - `gitEnv()` builds the child's environment from constants, so NOTHING is
 *     inherited. `GIT_DIR` outranks repository DISCOVERY, so neither `cwd:` nor
 *     `-C <path>` pins WHICH repository git resolves — an ambient `GIT_DIR`
 *     pointing at a clone of the upstream would otherwise make this derivation
 *     return the UPSTREAM's slug, which is a fence bypass, not a nuisance.
 *   - `resolveGitBinary()` returns an ABSOLUTE path, so the spawn itself performs
 *     no PATH lookup. Stated precisely, because an earlier draft of this comment
 *     claimed it "removes the PATH lookup" outright and that is stronger than the
 *     code: `git-subprocess-env.js::resolveGitBinary` tries a FIXED CANDIDATE LIST
 *     first and falls back to `_resolveViaPath(process.env.PATH)` (`:156`) when no
 *     candidate resolves — which is the normal case on nix / asdf / conda / Scoop
 *     hosts. So PATH still selects the binary on those hosts; what is removed is
 *     the lookup at spawn time, not PATH's role in resolution. A PATH-planted
 *     `git` defeats the fence regardless of the env, which the next paragraph's
 *     in-process bound already covers.
 *
 * An unresolvable git returns null → the caller's typed refusal. That is the
 * TIGHTEST ranking the shared module's caller contract requires: git that
 * cannot answer is INDETERMINATE, never a clean derivation.
 */
function _readOriginRemote(cwd) {
  // CLEAR FIRST. `_lastGitStderr` is module-scope and was assigned ONLY in the
  // catch below, never reset — so a later call that returned null through a
  // branch which sets nothing (`!gitBin`, or empty stdout) left the PREVIOUS
  // call's stderr standing, and `deriveSelfRepoRef` spliced it into a refusal as
  // `git said: …`. That states, in the grammar of an observation, something git
  // never said on THAT call, about a repo it was never asked about
  // (`evidence-first-claims.md` MUST-4) — and it re-emits operator-environment
  // text from an unrelated directory into a second refusal `reason` that
  // `/codify` Step-7c may embed in a journal or PR body
  // (`user-flow-validation.md` MUST-6). Production runs one-shot per node
  // invocation so the multi-call precondition is not met there, but the
  // differential oracle drives ~30 URLs in ONE process, which is shipped code.
  _lastGitStderr = null;
  const gitBin = resolveGitBinary();
  if (!gitBin) return null;
  try {
    const out = execFileSync(gitBin, ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      // stderr is CAPTURED, not discarded. It was `"ignore"`, which collapsed
      // every git failure into one reason string naming three causes — and the
      // most common real cause in a container or on a shared machine is a
      // FOURTH the message never named: `detected dubious ownership`
      // (safe.directory). A maintainer hitting that was sent looking for a
      // missing remote they actually have. The bytes are surfaced by the caller,
      // truncated; see `_readOriginRemote`'s return contract below.
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
      env: gitEnv(),
    });
    const s = typeof out === "string" ? out.trim() : "";
    return s || null;
  } catch (err) {
    // Return the FIRST stderr line so the refusal can name what git said.
    // Bounded to 200 chars and newline-free: this string reaches a refusal
    // `reason` that is logged, and an unbounded echo of subprocess output is a
    // log-injection surface. It carries no remote URL — git's ownership and
    // not-a-repo errors name a PATH, and the URL-bearing errors are not on this
    // failure path — but it IS operator-environment text, so it is truncated
    // rather than trusted (`security.md` § "No secrets in logs" is about
    // credentials; this is the adjacent hygiene).
    const raw =
      err && typeof err.stderr === "string"
        ? err.stderr
        : err && err.stderr
          ? String(err.stderr)
          : "";
    const first = raw.split("\n").find((l) => l.trim());
    _lastGitStderr = first ? first.trim().slice(0, 200) : null;
    return null;
  }
}

// Set by `_readOriginRemote` on failure; read once by `deriveSelfRepoRef` to
// enrich its refusal. Module-scope because the failure and the message are two
// frames apart and threading a second return value would change the helper's
// contract for every caller. Deliberately NOT part of any security decision —
// it is diagnostic text only, never an operand.
let _lastGitStderr = null;

/**
 * Read origin's PUSH url. Returns null when git cannot answer.
 *
 * `git remote get-url --push origin` returns the FETCH url when no distinct
 * `pushurl` is configured, so on an ordinary single-identity remote this returns
 * the same string as `_readOriginRemote` and the caller's comparison is a no-op.
 * It differs in git's triangular configurations — of which there are THREE, and
 * an earlier revision of this sentence said it "differs ONLY in git's triangular
 * workflow, which is precisely the case the caller refuses". Both halves were
 * false: `remote.origin.pushurl` is only ONE of the three forms, and the other
 * two left this read returning the FETCH url, so the caller saw agreement and
 * never refused. Measured, with `remote.pushDefault=fork` and no pushurl on
 * origin: `git remote get-url --push origin` returned the upstream, and
 * `deriveSelfRepoRef` returned ok=true. That is why this helper resolves the
 * EFFECTIVE push remote rather than asking about origin's own pushurl.
 *
 * Deliberately does NOT touch `_lastGitStderr`: that variable carries the
 * diagnostic for the FETCH read, which is the one whose failure denies the
 * identity. A failure here is not itself fatal — the caller treats a null as
 * "no distinct push url to disagree with", which is the same disposition as an
 * ordinary remote. That is the safe direction: this check can only ADD a
 * refusal, never remove one, so being unable to run it cannot authorize
 * anything the fetch-derived identity did not already authorize.
 */
function _readPushRemote(cwd) {
  const gitBin = resolveGitBinary();
  if (!gitBin) return null;
  const run = (args) => {
    try {
      const out = execFileSync(gitBin, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3000,
        env: gitEnv(),
      });
      const s = typeof out === "string" ? out.trim() : "";
      return s || null;
    } catch {
      return null;
    }
  };

  // RESOLVE THE EFFECTIVE PUSH REMOTE, not origin's own pushurl. An earlier cut
  // asked only `git remote get-url --push origin`, which answers exactly one
  // question — "does origin carry a distinct pushurl?" — and git has THREE
  // documented triangular configurations. Measured, with `remote.pushDefault`
  // set to a different remote:
  //     fetch       : <upstream>
  //     push@origin : <upstream>      <-- unchanged, so the old check saw nothing
  //     pushDefault : fork
  // i.e. pushes went to the fork while the check reported agreement, and the
  // fence then derived the upstream and authorized a merge on it — the exact
  // pre-guard behavior, for two of the three forms.
  //
  // Precedence is git's own, and it has FOUR levels, not three. Quoting
  // `git help config` under `remote.pushDefault` verbatim: "The remote to push
  // to by default. Overrides branch.<name>.remote for all branches, and is
  // overridden by branch.<name>.pushRemote for specific branches." So the chain
  // is:
  //     branch.<current>.pushRemote  →  remote.pushDefault
  //       →  branch.<current>.remote  →  `origin`
  //
  // The third level was MISSING and its absence was a live bypass in the most
  // ORDINARY fork layout there is — no attacker, no unusual config:
  //     git clone <upstream>                     # origin = UPSTREAM
  //     git remote add fork <my-fork>
  //     git checkout -b upflow/x --track fork/upflow/x   # branch.<x>.remote=fork
  // With pushRemote and pushDefault both unset, the resolver fell through to
  // `origin`, `git remote get-url --push origin` returned the UPSTREAM, the
  // pushurl matched the fetch url, the triangular check was SKIPPED, and the
  // fence derived the UPSTREAM as self — authorizing a merge on it while real
  // pushes from that tree went to the fork. That is byte-for-byte the scenario
  // the triangular block above was written to refuse, reached one config key
  // over. An earlier revision of this comment claimed the three-level chain WAS
  // "git's own precedence"; that was false against git's own documentation and
  // is corrected here rather than silently rewritten, because a comment
  // asserting a completeness the code lacks is the defect class this file
  // exists to stop.
  let remoteName = null;
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") {
    remoteName = run(["config", "--get", `branch.${branch}.pushRemote`]);
  }
  if (!remoteName) remoteName = run(["config", "--get", "remote.pushDefault"]);
  if (!remoteName && branch && branch !== "HEAD") {
    remoteName = run(["config", "--get", `branch.${branch}.remote`]);
  }
  if (!remoteName) remoteName = "origin";

  return run(["remote", "get-url", "--push", remoteName]);
}

/**
 * Do two parsed remotes name the SAME repository?
 *
 * Compares the FULL derived identity, and each component is load-bearing:
 *   - HOST, because an owner/name pair alone does not say WHERE the repo lives
 *     (`vcs-github-adapter.js` states this for its own host check). Fetch
 *     `github.com/o/r` against push `internal-mirror.example/o/r` is a real
 *     triangular setup whose slugs are identical.
 *   - The ADO ORG, because for an ADO remote `_parseRemoteUrl` sets
 *     `owner = ado.project` and `name = ado.repo` — the org rides ONLY on
 *     `.ado.org`. A slug comparison therefore drops it entirely, so
 *     `dev.azure.com/upstream-org/Proj/_git/Repo` and
 *     `dev.azure.com/my-org/Proj/_git/Repo` both reduce to `proj/repo` and
 *     compare EQUAL.
 *
 * The first cut of the triangular check compared `${owner}/${name}` and shipped
 * exactly that hole — re-instancing, inside the new guard, the defect this
 * module's own header raises against `version-utils.js::normalizeRemoteIdentity`
 * ("structurally loses `<org>`, so an ADO fence built on it could never compare
 * org at all"). Reuses the same predicates the fence itself uses rather than
 * hand-rolling a fourth comparison path, which is how the components were lost.
 */
function _sameDerivedIdentity(a, b) {
  if (!a || !b) return false;
  // ADO-ness must match: an ADO identity and a non-ADO one are never the same
  // repo even if their owner/name happen to coincide.
  if (!!a.ado !== !!b.ado) return false;

  if (a.ado) {
    // ADO: the org/collection/project/repo QUAD is the identity, and the host is
    // DELIBERATELY excluded. `_parseAdo` has already gated the host to a closed
    // Azure DevOps set, and the SAME repository is addressed by several of those
    // hosts depending on transport — `dev.azure.com` for https and
    // `ssh.dev.azure.com` for ssh are one repo, as are `<org>.visualstudio.com`
    // and `vs-ssh.visualstudio.com`.
    //
    // COMPARING THE RAW HOST HERE SHIPPED A LOCKOUT. The first cut of this
    // function tested `normalizeComponent(a.host) !== normalizeComponent(b.host)`
    // for BOTH shapes, which refused an ordinary ADO clone whose push url merely
    // uses ssh:
    //   fetch https://dev.azure.com/<org>/<proj>/_git/<repo>
    //   push  git@ssh.dev.azure.com:v3/<org>/<proj>/<repo>
    // — a maintainer locked out of their own repo, the same class as the ADO
    // collection-form regression this module already records. Every instrument
    // reported green on it: the differential drives SINGLE remotes and never a
    // fetch/push pair, and the fence suite's only permissive triangular case was
    // GitHub. The ADO permissive case added alongside this fix is what reds it.
    //
    // Cross-org is still caught, because `_parseAdo` derives `org` from the
    // subdomain on the `<org>.visualstudio.com` form and from the path
    // elsewhere, so a different org yields a different `ado.org` on every form.
    //
    // CROSS-COLLECTION IS CAUGHT HERE TOO, and this call site needed NO change
    // to get it: routing ADO through `isSelfRepoAdo` rather than hand-rolling a
    // fourth comparison path is what made the quad widening reach the
    // triangular guard automatically. Both operands are DERIVED here, so both
    // genuinely carry the collection — this is the lane the cross-collection
    // defect was reported on, and `_sameDerivedIdentity` is not where it lived.
    return isSelfRepoAdo(a.ado, b.ado);
  }

  // Non-ADO: the host IS part of the identity — an owner/name pair alone does
  // not say WHERE the repo lives, which is the same argument
  // `vcs-github-adapter.js` makes for its own host check. Fetch
  // `github.com/o/r` against push `internal-mirror.example/o/r` is two repos.
  //
  // FAIL CLOSED on an un-normalizable host. `normalizeComponent` returns null
  // for anything outside `[A-Za-z0-9._-]`, so two DIFFERENT bracketed IPv6
  // authorities would both normalize to null and compare EQUAL — a fail-OPEN
  // default inside a fail-closed gate. Not reachable today (neither provider
  // serves IPv6 literals), closed anyway on this file's own standard that a
  // known-incorrect comparison becomes a bypass the moment a caller compares
  // differently.
  const ha = normalizeComponent(a.host);
  const hb = normalizeComponent(b.host);
  if (ha === null || hb === null) return false;
  if (ha !== hb) return false;
  return isSelfRepo({ owner: a.owner, name: a.name }, b);
}

/**
 * Split a remote URL into `{host, segments}`. Handles `scheme://host/path` and
 * scp-style `git@host:path`.
 *
 * The returned `host` is the authority with things removed in this order:
 * anything from the first `#` or `?` onward — ON THE SCHEME BRANCH ONLY, see
 * below — then userinfo (everything through the last `@`), then the port, then
 * case.
 *
 * THE CUT IS SCHEME-BRANCH-ONLY, and stating it unconditionally here was wrong
 * for every scp remote. It models CURL, which git uses for http/https; OpenSSH
 * has no such terminator and splits user@host at the last `@`. Applying it to
 * the scp branch put the decoy in the RETAINED host and the real host in the
 * discarded userinfo — the measured `git@github.com#@evil.com:o/r` defect.
 * On the scheme branch the cut MUST precede the userinfo split — see the comment on
 * it. Returns null when no host is present (a bare local path is not a hosting
 * identity) or when the authority is empty after the cuts.
 */
function _splitRemoteUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;

  let authority;
  let rest;
  // The scheme MUST be ANCHORED at the start. An unanchored `indexOf("://")`
  // finds the first `://` ANYWHERE, including one sitting in the PATH of an
  // scp-style remote, and then reads the authority out of the middle of the
  // string: `evil.com:x/https://github.com/o/r` yielded authority `github.com`
  // (measured: `indexOf("://")` = 16) and cleared a caller's host check on a
  // remote whose real host is `evil.com`. That is the SAME check-vs-use
  // divergence the fragment/query cut below exists to prevent, reached by a
  // different route, so it is closed the same way — structurally, at the parse.
  // Anchoring sends that input to the scp-style branch, where the authority is
  // `evil.com` and the provider host check then refuses. Scheme charset is
  // RFC-3986 (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`).
  // The `#`/`?` authority cut belongs to the SCHEME branch ONLY, because it
  // models CURL's parsing — and curl is what git uses for https. Applying it to
  // the scp-style branch models nothing: OpenSSH does not treat `#`/`?` as
  // authority terminators at all. An earlier revision applied the cut to BOTH
  // branches and justified it in prose that had the operand order backwards; it
  // claimed cutting an scp authority "yields `evil.com` where ssh would connect
  // to `github.com` — a DISAGREEMENT that resolves as a refusal". The opposite
  // happened, because the cut runs BEFORE the userinfo split, so the `#` payload
  // lands in the DISCARDED userinfo and the RETAINED host is the decoy:
  //
  //   git@github.com#@evil.com:org/repo      (well-formed scp-style; git accepts it)
  //     cut at `#`      -> "git@github.com"
  //     lastIndexOf("@")-> host "github.com"   <- fence reads GITHUB
  //     ssh -G          -> host evil.com       <- ssh CONNECTS to EVIL  (measured)
  //
  // That is strictly worse than the unanchored-scheme defect fixed alongside it:
  // that one produced a URL `git ls-remote` REFUSES, so nothing was reachable,
  // whereas this remote is well-formed and FETCHES. Scoping the cut to the
  // scheme branch makes each branch model its OWN resolver: the scp branch now
  // splits at the last `@` exactly as OpenSSH does, so the authority above
  // resolves to `evil.com` and the provider host check refuses.
  let isSchemeForm = false;
  const schemeMatch = s.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  if (schemeMatch) {
    isSchemeForm = true;
    const afterScheme = s.slice(schemeMatch[0].length);
    const firstSlash = afterScheme.indexOf("/");
    authority =
      firstSlash === -1 ? afterScheme : afterScheme.slice(0, firstSlash);
    rest = firstSlash === -1 ? "" : afterScheme.slice(firstSlash + 1);
  } else if (s.includes(":")) {
    const colon = s.indexOf(":");
    authority = s.slice(0, colon);
    rest = s.slice(colon + 1);
  } else {
    return null; // bare filesystem path — no host, not a hosting identity
  }

  // SCHEME FORM ONLY: terminate the authority at the first `#` or `?`, BEFORE
  // the userinfo split below. curl ends the authority at either character, so
  // `https://evil.com#@github.com/o/r` resolves EVIL.COM; without this cut the
  // `lastIndexOf("@")` below would take `github.com` as the host and a caller's
  // host check would pass on a URL git resolves elsewhere. Neither provider's
  // real authorities contain these characters, so no legitimate remote is
  // affected.
  if (isSchemeForm) {
    const authCut = authority.search(/[#?]/);
    if (authCut !== -1) authority = authority.slice(0, authCut);
  }

  // Both forms split userinfo at the LAST `@` — RFC 3986 for the scheme form,
  // OpenSSH's own rule for the scp form (verified: `ssh -G git@github.com#@evil.com`
  // prints `host evil.com`, `user git@github.com#`).
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);

  // ASCII GUARD ON THE HOST, symmetric with `normalizeComponent`'s. The host is
  // an identity operand compared against closed sets (`GITHUB_HOSTS`,
  // `isAdoHost`), exactly like the components — but it was the ONE such operand
  // reaching `.toLowerCase()` with no ASCII precheck, so the locale/case-fold
  // surface that guard exists to close was open here. Placed AFTER the userinfo
  // split on purpose: userinfo is discarded and may legitimately be non-ASCII,
  // so guarding the whole authority would refuse remotes that are fine.
  //
  // NOT A LIVE BYPASS TODAY, and this is not claimed as one. Exhaustively
  // scanned U+0080–U+10FFFF (skipping surrogates) for code points whose
  // `.toLowerCase()` is a pure-ASCII letter: the result is EXACTLY ONE,
  // U+212A KELVIN SIGN → "k". U+0130 yields "i"+U+0307 (two code units), so it
  // cannot forge "i". No member of the current host sets contains a "k", so
  // nothing is forgeable at this commit.
  //
  // (An earlier revision of this sentence named U+212B ANGSTROM SIGN as a second
  // member and then parenthetically noted its lowercase "å" is non-ASCII —
  // contradicting, in the same breath, the set it was enumerating. The scan
  // above replaces the enumeration with its measured result.)
  //
  // It is closed anyway because THIS FILE'S OWN STANDARD, stated at the IPv6
  // comment below, is that "safe-by-accident becomes a bypass the moment a
  // caller compares hosts differently" — and `vcs-github-adapter.js` explicitly
  // schedules that change ("A GHES deployment adds its appliance host here").
  // A GHES appliance host containing "k" (`github.k8s.corp`) is forgeable by
  // `github.<U+212A>8s.corp`, which lowercases into the set while git and ssh
  // resolve the distinct IDN host. The guard is what makes the property
  // structural rather than a coincidence of the current set's spelling.
  //
  // PRINTABLE ASCII, NOT ALL OF ASCII — and the narrowing is the point. The
  // first cut of this guard was `[\x00-\x7f]`, which ADMITS every C0 control
  // byte and DEL. That admission was not inert: it is the residual INSIDE the
  // class the guard was written for.
  //
  //   https://contoso<LF>.visualstudio.com/<proj>/_git/<repo>
  //     host                           -> "contoso\n.visualstudio.com"
  //     endsWith(".visualstudio.com")  -> TRUE  (the ADO subdomain branch runs)
  //     org = host.slice(0, indexOf(".")) -> "contoso\n"
  //     normalizeComponent -> .trim()  -> "contoso"
  //
  // — the SAME org the legitimate `contoso.visualstudio.com` derives. Measured
  // in a real repo before this narrowing: `deriveSelfRepoRef` returned ok:true
  // with `ado {org:"contoso",...}` and `completeUpflowPR` returned
  // `ok:true fired:true`. A refuse→authorize flip, not a cosmetic parse defect.
  //
  // THE SIBLING GUARD IN `normalizeComponent` IS DELIBERATELY STILL
  // `[\x00-\x7f]` AND MUST STAY THAT WAY. It runs immediately before a POSITIVE
  // `[A-Za-z0-9._-]` allowlist that strips every control byte anyway, so
  // narrowing it there would be redundant. The HOST path is the one with no
  // second gate — `host` is compared against the closed sets directly — which is
  // why exactly one of the two moved.
  //
  // Reachability is ~zero, and that is stated rather than glossed: nothing
  // fetches such a remote, the same disposition the `#`/`?` and IPv6 notes in
  // this function already record. It is closed because THIS FILE'S OWN STANDARD
  // (see the IPv6 comment below) is that a known-INCORRECT parse is what each of
  // this module's host defects began as — safe-by-accident becomes a bypass the
  // moment a caller compares hosts differently. Instrumented by
  // `audit-fixtures/upflow-open-never-complete/`
  // ::ado/control-byte-authority-refuses-at-derivation, whose permissive twin
  // `ado/allow-own-repo-visualstudio-subdomain-form` drives the byte-identical
  // remote WITHOUT the control byte and must keep resolving.
  //
  // No legitimate authority is affected: every character a real host, a port, a
  // bracketed IPv6 literal, or a userinfo-stripped authority can carry lies in
  // `\x20-\x7e`.
  // eslint-disable-next-line no-control-regex
  if (!/^[\x20-\x7e]*$/.test(authority)) return null;

  // No trailing-dot normalization is applied, and that is deliberate: DNS
  // treats `github.com.` as the same absolute name, but this returns it
  // verbatim, so it does not match a caller's host set and the derivation
  // REFUSES. That is the fail-closed direction and is intended — do not "fix"
  // it by stripping the dot without re-checking every host-set comparison.
  // IPv6 literals are BRACKETED, and the port split below is colon-delimited —
  // so a naive `split(":")[0]` returns `"["` for `https://[::1]/o/r`, which is
  // not a host at all. Take the bracketed span whole, then any `:port` after
  // the closing bracket. Found by a differential check against the real
  // resolvers (`ssh -G` for scp forms, WHATWG `URL` for scheme forms), which
  // reported derived `[` vs oracle `[::1]`.
  //
  // The OUTCOME was already safe — `[` matches no entry in GITHUB_HOSTS and is
  // not an ADO host, so the fence refused — and neither provider serves an IPv6
  // literal, so this refuses either way. It is corrected because a
  // known-INCORRECT parse is what each of this PR's three host defects began as:
  // safe-by-accident becomes a bypass the moment a caller compares hosts
  // differently. Parity with the resolver is the property; the refusal is a
  // consequence, not the guarantee.
  let host;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null; // unterminated literal — refuse
    host = authority
      .slice(0, close + 1)
      .trim()
      .toLowerCase();
  } else {
    host = authority.split(":")[0].trim().toLowerCase();
  }
  if (!host) return null;

  const segments = String(rest)
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;
  return { host, segments };
}

/**
 * Azure DevOps identity from a parsed remote, or null when the remote is not
 * ADO-shaped. Forms handled — FIVE, and this list is load-bearing: an earlier
 * four-entry version of it omitted the collection form, a fix was written
 * against the short list, and it REGRESSED that form into a maintainer lockout.
 * Keep this in sync with the inline count block in the body.
 *   https://dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>.visualstudio.com/<project>/_git/<repo>
 *   https://<org>.visualstudio.com/<collection>/<project>/_git/<repo>  (legacy)
 *   git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
 * `vs-ssh.visualstudio.com` takes the org-from-path branch, NOT the subdomain
 * one (it is excluded explicitly), so it follows the ssh/v3 shape.
 *
 * This parses ADO SEPARATELY on purpose. `version-utils.js::
 * normalizeRemoteIdentity` keeps only the LAST TWO path segments and drops
 * `_git`, which structurally loses `<org>` — so an ADO fence built on it could
 * never compare org at all.
 */
function _parseAdo(host, segments) {
  const isAdoHost =
    host === "dev.azure.com" ||
    host === "ssh.dev.azure.com" ||
    host === "vs-ssh.visualstudio.com" ||
    host.endsWith(".visualstudio.com");
  if (!isAdoHost) return null;

  let segs = segments.slice();
  // SSH-FORM ONLY. `v3` is the ssh path prefix; stripping it on EVERY ado host
  // permanently locked out a maintainer whose ADO ORG is literally named `v3`
  // (valid under ADO_ORG_RE): `https://dev.azure.com/v3/proj/_git/repo` lost its
  // org segment, fell to the `segs.length !== 3` guard and returned null. Fail-
  // CLOSED, so a lockout not a bypass — but still a wrong answer, and gating the
  // strip on the two ssh hosts costs nothing.
  if (
    (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") &&
    segs[0] &&
    segs[0].toLowerCase() === "v3"
  )
    segs = segs.slice(1);
  segs = segs.filter((p) => p.toLowerCase() !== "_git");

  // KNOWN DEFECT, NOT FIXED — recorded because the obvious fix is wrong and I
  // could not establish the right one. Only `_git` is filtered, so ADO's OTHER
  // routing segment `_ssh` is treated as a NAME. Measured:
  //   ssh://acct@vs-ssh.visualstudio.com:22/Proj/_ssh/Repo
  //     -> {org: "proj", project: "_ssh", repo: "repo"}     <- MIS-DERIVED
  // The 4-segment collection variant refuses on the count, so only the
  // 3-segment form mis-derives.
  //
  // Filtering `_ssh` alongside `_git` does NOT fix it — traced, and it trades
  // one wrong answer for another: the 3-segment form then refuses (correct),
  // but the 4-segment form becomes ["Collection","Proj","Repo"] and derives
  // org=Collection, which is wrong in a new way. A correct parse needs to know
  // where the org lives in the `_ssh` form, and that is ADO ground truth this
  // repo cannot check.
  //
  // FAIL-CLOSED in effect: the bogus project `_ssh` (or a wrong org) is
  // compared against the caller's `repoRef` and mismatches, so a completion is
  // refused rather than misdirected. Left as a wrong DERIVATION that refuses,
  // which is not the same as a correct refusal — the distinction this file
  // already draws for the 2-segment ambiguity below.
  //
  // Deliberately not guessed at: acting on an incomplete enumeration of ADO
  // URL forms is precisely what caused the collection-form regression this file
  // records above. Settling it needs a real ADO org emitting `_ssh` clone URLs.

  // VALIDATE EVERY SEGMENT BEFORE ANY IS USED OR DROPPED.
  //
  // The clause used to read "BEFORE ANY IS DROPPED", and the collection slot
  // was the thing being dropped. Nothing is dropped any more — the collection
  // is RETAINED as the quad's fourth component — so the property is restated in
  // its general form rather than deleted along with the drop it named. It is
  // still load-bearing, and for the SAME reason: until this line the collection
  // slot was the ONE position in the whole parser whose content never passed
  // `normalizeComponent` — a junk drawer that let a dirty path clear the count
  // check:
  //
  //   https://realorg.visualstudio.com/realproj#/proj2/_git/repo2
  //     filter -> ["realproj#", "proj2", "repo2"]   3, passes the count
  //     slice  -> ["proj2", "repo2"]                the dirty one is GONE
  //     derived-> {org: realorg, project: proj2, repo: repo2}   (measured)
  //
  // A COMMENT IN THIS FUNCTION PREVIOUSLY CLAIMED THIS COULD NOT HAPPEN — that
  // an injection "would need three CLEAN segments and cannot forge them,
  // because the `#`/`?` necessarily lands ON a segment". False, and refuted by
  // measurement: it never needed three clean segments, only two plus a slot
  // whose contents are thrown away. The claim held for RETAINED slots and was
  // stated as if it held for all of them. Recorded rather than quietly
  // replaced, because a security comment asserting a property the code lacks is
  // the exact defect class this file keeps re-learning.
  //
  // Harm was ~zero — `#` truncates the path at curl and `?` collides with git's
  // own `/info/refs?service=…`, so neither remote is fetchable, and the cwd
  // bound in the module header dominates anyway. Fixed regardless: the IPv6
  // note above refuses to rely on safe-by-accident, and this is the same shape.
  //
  // Validating first also closes the class rather than the instance — anchoring
  // on `_git` position would NOT have, since the junk sits BEFORE the anchor.
  if (segs.some((p) => normalizeComponent(p) === null)) return null;

  let org = null;
  // The legacy TFS/VSTS collection, or null on every form that has no
  // collection slot. Declared here so both branches below can see it.
  let collection = null;
  // EXACTLY three labels. `endsWith(".visualstudio.com")` alone also accepts a
  // MULTI-label subdomain, and `org` is cut at the FIRST dot — so
  // `victimorg.attacker.visualstudio.com` derived `org = "victimorg"`: a tree
  // whose origin names a host the operator does not own derived an org they do
  // not have, and the completion PATCH is addressed to `victimorg/...`.
  // Reachability is low (needs a record at the second label), but "safe by
  // accident" is the standard this file refuses everywhere else.
  const isOrgSubdomain =
    host.endsWith(".visualstudio.com") &&
    host !== "vs-ssh.visualstudio.com" &&
    host.split(".").length === 3;
  // EXACT counts, same reasoning as the GitHub branch above and the same
  // measured defect: the path is never cut at `#`/`?`, so
  // `.../realorg/realproj/_git/realrepo#/otherproj/otherrepo` filtered to
  // ["realorg","realproj","realrepo#","otherproj","otherrepo"] and the trailing
  // pair won — deriving {org: realorg, project: OTHERPROJ, repo: OTHERREPO},
  // i.e. the real org with an attacker-chosen project/repo, which is what the
  // completion PATCH is then addressed to.
  //
  // After the `v3` strip and `_git` filter the legitimate forms are exact:
  //   dev.azure.com/<org>/<project>/_git/<repo>      -> 3 (org, project, repo)
  //   ssh.dev.azure.com:v3/<org>/<project>/<repo>    -> 3
  //   <org>.visualstudio.com/<project>/_git/<repo>   -> 2 (org comes from host)
  //   <org>.visualstudio.com/<collection>/<project>/_git/<repo> -> 3 (legacy)
  //
  // The legacy collection form is the ONE place a trailing pair is still taken
  // from three segments, and it is safe ONLY BECAUSE every segment — INCLUDING
  // the collection that is about to be discarded — is passed through
  // `normalizeComponent` first, at the validate-before-drop line above. THE TWO
  // ARE COUPLED: relax the allowlist, or move that check after the slice, and
  // this reopens.
  //
  // An earlier version of this comment argued the safety differently and was
  // WRONG. It said an injection "would need three CLEAN segments and cannot
  // produce them, because the `#`/`?` necessarily lands ON a segment". That is
  // true only of RETAINED segments; the discarded collection slot was an
  // unvalidated junk drawer, and `.../realproj#/proj2/_git/repo2` cleared the
  // count with two clean segments and derived proj2/repo2 (measured). The
  // validate-before-drop line is what makes the property real.
  if (isOrgSubdomain) {
    org = host.slice(0, host.indexOf("."));
    // The org-subdomain form takes an OPTIONAL leading COLLECTION segment:
    //   <org>.visualstudio.com/<project>/_git/<repo>                    -> 2
    //   <org>.visualstudio.com/DefaultCollection/<project>/_git/<repo>  -> 3
    // The second is the legacy TFS/VSTS collection URL and is a REAL form.
    // Recorded because a first cut of this exactness fix required exactly 2 and
    // REGRESSED it — that remote derived correctly before the fix and refused
    // after, locking out any maintainer still on a collection URL. It was
    // caught by widening the legitimate-form check, not by review; the
    // enumeration this fix was written against listed four forms and this was
    // not among them.
    //
    // KNOWN AMBIGUITY IN THE 2-SEGMENT CASE, measured and recorded because it
    // cannot be resolved from the URL alone. ADO permits OMITTING the project
    // segment when the project and repository names match, so a 2-segment
    // subdomain path is genuinely ambiguous:
    //   <org>.visualstudio.com/<project>/_git/<repo>     -> [project, repo]
    //   <org>.visualstudio.com/<collection>/_git/<repo>  -> [collection, repo]
    // Both filter to two segments and nothing in the string distinguishes them.
    // This code takes the first reading, so a project-omitted URL DERIVES THE
    // COLLECTION AS THE PROJECT — measured:
    //   .../DefaultCollection/_git/repo -> {project: "defaultcollection", ...}
    // which is wrong.
    //
    // PRE-EXISTING, not introduced by the collection allowance above: the old
    // last-two rule produced the identical pair. It is FAIL-CLOSED in effect —
    // the wrong project is then compared against the caller's `repoRef.project`
    // and mismatches, so the completion is refused rather than misdirected —
    // but it is a wrong derivation, not a correct refusal, and the distinction
    // matters to anyone reading a refusal reason that names a project they
    // never used. Resolving it needs a signal outside the URL (an API lookup),
    // which this module deliberately does not do.
    if (segs.length !== 2 && segs.length !== 3) return null;
    // THE COLLECTION IS RETAINED, NOT DROPPED — it is the FOURTH component of
    // the ADO identity. This line used to be `segs = segs.slice(1)` and the
    // value went nowhere, which meant cross-collection was not discriminated
    // ANYWHERE: the parse discarded it, the ADO `repoRef` had no field for it,
    // and `isSelfRepoAdo` compared org/project/repo only. In legacy TFS/VSTS a
    // collection is a NAMESPACE, so this pair names two DIFFERENT repositories
    // and yet derived an IDENTICAL triple and compared EQUAL (measured:
    // ALLOWED, transport fired):
    //   https://<org>.visualstudio.com/DefaultCollection/<proj>/_git/<repo>
    //   https://<org>.visualstudio.com/OtherCollection/<proj>/_git/<repo>
    // No arrangement of the triple could separate them — the component was
    // absent from the model, which is why this was an identity-MODEL change
    // (triple → quad) rather than a comparison tweak. Instrumented by
    // `ado/triangular-cross-collection-same-org-project-repo-refuses` and
    // `ado/cross-collection-same-org-project-repo-refuses`.
    if (segs.length === 3) {
      collection = segs[0];
      segs = segs.slice(1);
    }
    // ONLY THIS FORM CARRIES A COLLECTION. `dev.azure.com/<org>/<project>/_git/
    // <repo>`, `ssh.dev.azure.com:v3/...`, and the 2-segment
    // `<org>.visualstudio.com/<project>/_git/<repo>` have NO collection slot, so
    // `collection` stays null on all of them. That null is what keeps the
    // widening backward-compatible for every existing caller: two modern forms
    // compare null-to-null and are unaffected. It is NOT a wildcard — see
    // `_normalizeCollection`, where absent resolves to the DEFAULT collection
    // and is then compared like any other value, so a NON-default collection
    // still differs from an absent side.
  } else {
    // NOT INDEPENDENTLY LOAD-BEARING, and measured to be so rather than
    // assumed. Relaxing this line alone to `< 3` reds NOTHING — the suite stays
    // fully green — because everything it then admits is refused by the
    // `segs.length !== 2` gate below: that gate demands `n - 1 === 2`, i.e.
    // `n === 3`, which is what this line already enforces. So this is a
    // defensive restatement, not a tested guard, and a reader must not cite a
    // green suite under a mutation here as evidence the ADO count is
    // instrumented. Per `instrument-discipline.md` MUST-2(b) a non-reddening
    // mutation leaves two live hypotheses — vacuous test OR inert mutation —
    // and this one is resolved as INERT by the arithmetic above.
    //
    // (An earlier revision of this comment cited "the suite stays 35/35". The
    // suite was 35 cases when that was written and grew the next commit; the
    // bare count decayed while the claim around it stayed true. Stated as a
    // property now, so there is no number left to go stale — the same remedy
    // the fixture README prescribes for itself.)
    //
    // THE PAIR (this line AND the gate below) IS THE HONEST MUTATION, and as of
    // this commit it is INSTRUMENTED — by
    // `ado/exact-segment-count-rejects-all-clean-extra-segments`, which drives
    // an ADO remote whose extra segments are ALL CLEAN. That shape is required:
    // every other ADO multi-segment case carries a DIRTY segment that the
    // validate-before-drop check catches first, so none of them can reach these
    // gates. A previous revision asserted the pair was "how the originating
    // exploit was actually closed", which a reader would take as a claim that
    // the pair was tested; an adversarial round measured it and found the pair
    // redded NOTHING and was VACUOUS, not inert. The claim is recorded here
    // rather than quietly replaced, because a false claim about an instrument
    // in a security comment is the exact class this file has now logged three
    // times.
    if (segs.length !== 3) return null; // exactly org + project + repo
    org = segs[0];
    segs = segs.slice(1);
  }
  // THIS is the load-bearing ADO count gate (see the note above).
  if (segs.length !== 2) return null;

  const ado = {
    org: normalizeComponent(org),
    // NULL MEANS "THIS URL FORM CARRIES NO COLLECTION", never "we could not
    // read one" — the two are kept distinguishable by the guard below.
    collection: collection === null ? null : normalizeComponent(collection),
    project: normalizeComponent(segs[segs.length - 2]),
    repo: normalizeComponent(segs[segs.length - 1]),
  };
  if (!ado.org || !ado.project || !ado.repo) return null;
  // A collection segment that was PRESENT but does not normalize is a PARSE
  // FAILURE, not an absent collection — collapsing it to null would turn a
  // dirty segment into the value that matches every collection-less remote.
  // SUBSUMED BY, NOT REDUNDANT WITH, the validate-before-use check above — and
  // that is a MEASUREMENT, not a reading of the code. Deleting either guard
  // ALONE leaves the fixture suite green; deleting BOTH reds
  // `ado/discarded-collection-slot-rejects-dirty-segment`. So each guard covers
  // the other on the current segment set, and the green each shows alone is
  // resolved as SUBSUMPTION rather than left as the two live hypotheses
  // `instrument-discipline.md` MUST-2(b) would otherwise require (vacuous test
  // OR inert mutation). Kept BOTH deliberately: this one is the guard that
  // still holds if a future refactor moves or drops the early check — which is
  // exactly what happened to the collection slot itself once already.
  if (collection !== null && !ado.collection) return null;
  return ado;
}

/**
 * Parse a remote URL into `{host, owner, name, ado}`. `owner`/`name` are the
 * path's EXACTLY TWO components (ADO: project/repo, matching the shape both
 * adapters compare on); `ado` is populated only for ADO remotes. Said as
 * "exactly two", not "the last two": the body requires the exact count, and the
 * last-two phrasing describes the rule that fragment-injected segments
 * defeated.
 *
 * `host` is RETURNED, not just used internally. It was previously destructured,
 * consulted only for ADO detection, and then discarded — which left `owner/name`
 * as a HOST-FREE pair. A GitHub caller comparing against that pair is asking
 * "does this path match?" and not "on which host?", so an internal mirror at
 * `https://<internal-host>/<org>/<repo>` derived as `<org>/<repo>` and cleared a
 * fence whose merge would then go to github.com/<org>/<repo> — a DIFFERENT repo
 * than the remote names. Mirrors of upstream templates are ordinary, so that is
 * realistic confusion, not only an attack. The host is normalized by
 * `_splitRemoteUrl` — fragment/query cut (SCHEME BRANCH ONLY), userinfo and
 * port stripped, lowercased, in that order (see that function); the
 * PROVIDER-appropriate host check belongs to each adapter, which knows its own
 * host set.
 */
function _parseRemoteUrl(url) {
  const split = _splitRemoteUrl(url);
  if (!split) return null;
  const { host, segments } = split;

  const ado = _parseAdo(host, segments);
  if (ado) return { host, owner: ado.project, name: ado.repo, ado };

  // AN ADO-FAMILY HOST THAT DID NOT PARSE AS ADO REFUSES — it does NOT fall
  // through to the generic owner/name parse below. Without this, tightening
  // `isOrgSubdomain` to exactly three labels merely CHANGED the wrong answer:
  // `victimorg.attacker.visualstudio.com/proj/_git/repo` stopped deriving
  // {org: victimorg} and instead derived {owner: "proj", name: "repo",
  // ado: null} off the generic path — still a derived identity from a host the
  // operator does not own, just wearing a different shape. Measured at both
  // poles before and after this clause. An ADO-family host whose path is not
  // ADO-shaped is unparseable, and unparseable is a REFUSAL here, never a
  // fallback to a parser that was written for a different host family.
  if (
    host === "dev.azure.com" ||
    host === "ssh.dev.azure.com" ||
    host.endsWith(".visualstudio.com")
  ) {
    return null;
  }

  // EXACTLY two segments, not "at least two, take the last two". Every GitHub
  // remote that resolves has exactly two path segments — `https://github.com/o/r[.git]`,
  // `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`. A "last two" rule
  // silently accepts extra leading segments, and the fragment/query cut applied
  // to the AUTHORITY does not touch the PATH, so anything after a `#`/`?` in the
  // path became segments and the LAST TWO won:
  //
  //   https://github.com/evil/repo#/upstream/repo
  //     segments -> ["evil", "repo#", "upstream", "repo"]
  //     last two -> upstream/repo        <- derived identity
  //     the URL actually names evil/repo
  //
  // Measured, both the `#` and `?` forms. `git ls-remote` REFUSES such a remote
  // (`fatal: .../info/refs not valid`), so it is not fetchable and the capability
  // delta over the module header's disclosed bound is ~zero — it is a PARSE
  // defect, ranked accordingly, not a new privilege. Fixed structurally anyway:
  // exactness closes the whole class in one comparison instead of adding a third
  // cut, and it also refuses a pasted browser URL (`/o/r/tree/main`), which the
  // "last two" rule silently derived as `tree/main`.
  const parts = segments.filter((p) => p.toLowerCase() !== "_git");
  if (parts.length !== 2) return null;
  const owner = normalizeComponent(parts[0]);
  const name = normalizeComponent(parts[1]);
  if (!owner || !name) return null;
  return { host, owner, name, ado: null };
}

/**
 * The slug `.claude/VERSION::repo` DECLARES, normalized, or null when the file
 * is absent, unreadable, unparseable, or declares no owner/name slug. Parsing
 * goes through `version-utils.js::declaredSelfRepo` so the declaration is read
 * by exactly one parser repo-wide.
 *
 * This value is used ONLY to REFUSE on disagreement. It is never a source of
 * identity, so a missing or forged VERSION cannot widen what the fence allows.
 */
function _declaredSlug(cwd) {
  let local;
  try {
    const fs = require("fs");
    local = JSON.parse(
      fs.readFileSync(path.join(cwd, ".claude", "VERSION"), "utf8"),
    );
  } catch {
    return null;
  }
  try {
    const vu = require(path.join(__dirname, "version-utils.js"));
    const declared = vu.declaredSelfRepo(local);
    if (!declared || !declared.slug) return null;
    const parts = String(declared.slug).split("/");
    const owner = normalizeComponent(parts[0]);
    const name = normalizeComponent(parts[1]);
    return owner && name ? `${owner}/${name}` : null;
  } catch {
    return null;
  }
}

/**
 * Derive this repo's OWN identity from the live git remote.
 *
 * `cwd` is the ONLY parameter, in production and in tests: there is no
 * `selfRepoRef` field and no deriver to substitute, so a caller cannot hand this
 * function an answer directly. It can still CHOOSE one. Naming the directory
 * selects WHICH working tree's origin remote is read, and therefore which
 * identity comes back — that is not a leftover seam, it is what this function
 * does. See the module header for what that does and does not make it evidence
 * of.
 *
 * `self.host` is the origin remote's host, normalized by `_splitRemoteUrl`
 * (fragment/query cut on the SCHEME BRANCH ONLY, userinfo and port stripped,
 * lowercased — in that order; on that branch the cut precedes the userinfo
 * split, which is what makes the host agree with what curl resolves. The scp
 * branch takes no cut and splits at the last `@`, which is what makes it agree
 * with ssh). It is carried so a caller can check the identity was derived
 * from a host that provider serves — an owner/name pair alone says nothing about
 * WHERE the repo lives. The check itself belongs to the calling adapter, which
 * knows its own host set; this module does not rank hosts.
 *
 * @param {string} cwd repo directory
 * @returns {{ok:true, self:{host:string,owner:string,name:string,
 *                           ado:{org:string,project:string,repo:string}|null,
 *                           source:"remote"}}
 *          |{ok:false, reason:string}}
 */
function deriveSelfRepoRef(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    return {
      ok: false,
      reason:
        "no repo directory given, so this repo's own identity cannot be derived; " +
        "refusing to authorize a completion",
    };
  }

  const url = _readOriginRemote(cwd);
  if (!url) {
    return {
      ok: false,
      reason:
        "`git remote get-url origin` yielded no remote for this working tree " +
        `(no origin, not a git repo, dubious ownership, or git unavailable${
          _lastGitStderr
            ? ` — git said: ${reasonText(_lastGitStderr)}`
            : ""
        }); the live remote is the ` +
        "only authoritative self-identity and there is deliberately no directory-name " +
        "fallback, so a completion cannot be authorized",
    };
  }

  const parsed = _parseRemoteUrl(url);
  if (!parsed) {
    // The raw URL is NOT echoed — it may carry credentials in userinfo
    // (`security.md` § "No secrets in logs").
    const split = _splitRemoteUrl(url);
    // BOUNDED, not merely sanitized. `_splitRemoteUrl` returns the authority up
    // to the first `/`, and nothing upstream caps its length — a megabyte
    // authority produced a megabyte refusal reason, which is logged and which
    // `/codify` Step-7c may embed in a PR body. `sanitizeForReason` alone does
    // NOT shorten (it replaces characters one-for-one), so the bound has to come
    // from `reasonText`, which composes the same sanitization with the 256-code-
    // point cap every other free-form refusal operand now carries. The scrub half
    // is inert here (an authority reaching this line has no `scheme://` prefix to
    // match) and is taken for uniformity, not because this site needs it.
    const where = split
      ? `host ${reasonText(split.host)}`
      : "no parseable host";
    return {
      ok: false,
      reason:
        `the origin remote does not parse to an owner/name pair (${where}); ` +
        "self-identity is unprovable, refusing to authorize a completion",
    };
  }

  const slug = `${parsed.owner}/${parsed.name}`;

  // TRIANGULAR-REMOTE REFUSAL. The derivation above reads the FETCH url, and
  // `git remote get-url --push origin` returns the fetch url UNLESS a distinct
  // `pushurl` is configured. In ONE of git's documented triangular forms —
  // `git clone <upstream> && git remote set-url --push origin <fork>` —
  // `remote.origin.url` IS the upstream, so this fence derived the UPSTREAM and
  // authorized a merge on it from a downstream contributor's tree. No attacker
  // and no unusual setup is required, and that population is EXACTLY the one
  // MUST-4 exists to stop.
  //
  // The module's literal claim stayed true throughout ("refuses any completion
  // whose target does not match the identity derived from the working tree") —
  // what failed was the INFERENCE from that identity to "the repo you ARE".
  //
  // Compared on DERIVED IDENTITY, not raw URL, so the common benign case where
  // pushurl differs only in transport (`git@github.com:o/r.git` vs
  // `https://github.com/o/r.git`) resolves to the same slug and does NOT refuse.
  // Only a genuine identity disagreement refuses, and refusing is the fail-closed
  // direction: when fetch and push name different repos, "the repo you are" has
  // no single answer, so no completion can be authorized on either.
  const pushUrl = _readPushRemote(cwd);
  const pushParsed =
    pushUrl && pushUrl !== url ? _parseRemoteUrl(pushUrl) : null;
  // AN UNPARSEABLE PUSH URL IS NOT EVIDENCE OF DISAGREEMENT — it is the ABSENCE
  // of evidence, and refusing on it shipped a LOCKOUT on a legitimate remote.
  // The legacy VSTS SSH clone form
  //   ssh://<org>@vs-ssh.visualstudio.com:22/<org>/<proj>/_ssh/<repo>
  // does not parse, because `_parseAdo` filters only `_git` and so the 4-segment
  // `_ssh` shape misses the segment-count gate. That parse gap is PRE-EXISTING
  // and separately recorded as a known defect; what this guard added was turning
  // it into a refusal, since before the guard a push url was never parsed at all.
  //
  // Skipping cannot widen anything. The FETCH url is the SOLE authoritative
  // identity (§ WHAT IS AUTHORITATIVE above), and this block is a cross-check
  // that can only ever ADD a refusal — the same disposition `_declaredSlug`
  // takes, where a read failure returns null and skips rather than refusing. So
  // an unparseable push url restores exactly the pre-guard behaviour, inside the
  // bound this module already discloses, instead of inventing a refusal against
  // a repo the maintainer legitimately owns.
  if (pushParsed && !_sameDerivedIdentity(parsed, pushParsed)) {
    // BOUNDED (`reasonText`), not merely sanitized. `_splitRemoteUrl` applies no
    // length cap to `host`, and `sanitizeForReason` replaces one-for-one without
    // shortening — so a megabyte authority produced a megabyte refusal reason,
    // which is logged and which /codify Step-7c may embed in a PR body. This is
    // the SAME defect the bounded `where` operand above documents fixing;
    // bounding one site and not its sibling is exactly the asymmetry
    // `security.md` § Enforcement-Surface Parity forbids.
    const describe = (d) =>
      reasonText(
        d.ado
          ? `${d.host} ${d.ado.org}/${d.ado.project}/${d.ado.repo}`
          : `${d.host} ${d.owner}/${d.name}`,
      );
    return {
      ok: false,
      reason:
        `this working tree has a triangular remote — it fetches from ${describe(parsed)} ` +
        `but pushes to ${describe(pushParsed)}; ` +
        "the two disagree about which repo this tree IS, so a completion " +
        "cannot be authorized on either (configure a single-identity remote, " +
        "or complete the PR from a clone of the repo you are merging on)",
    };
  }

  const declared = _declaredSlug(cwd);
  if (declared && declared !== slug) {
    return {
      ok: false,
      reason:
        `.claude/VERSION::repo (${declared}) disagrees with the origin remote (${slug}); ` +
        "self-identity is unprovable, refusing to authorize a completion",
    };
  }

  return {
    ok: true,
    self: {
      host: parsed.host,
      owner: parsed.owner,
      name: parsed.name,
      ado: parsed.ado,
      source: "remote",
    },
  };
}

/**
 * Does `repoRef` name the SAME repo as the derived self-identity?
 * Both sides go through `normalizeComponent`, so the derivation source and the
 * comparator cannot drift.
 */
function isSelfRepo(repoRef, self) {
  if (!repoRef || !self) return false;
  const a = normalizeComponent(repoRef.owner);
  const b = normalizeComponent(repoRef.name);
  return a !== null && b !== null && a === self.owner && b === self.name;
}

/**
 * ADO shape: {org, collection, project, repo} — a QUAD, all four compared, all
 * four sourced from the DERIVATION (`deriveSelfRepoRef(...).self.ado`) on the
 * `selfAdo` side. A null/absent `selfAdo` returns false: an origin remote that
 * is not ADO-shaped cannot authorize an ADO completion, and no component may
 * fall back to a value read off `repoRef`.
 *
 * WHY `collection` CANNOT USE THE OTHER THREE LEGS' RULE. `org`/`project`/`repo`
 * treat null as fatal, because every ADO URL form carries all three and a null
 * there means the parse failed. The collection is different: it is ABSENT BY
 * CONSTRUCTION on three of the four recognized forms (`dev.azure.com`,
 * `ssh.dev.azure.com:v3`, and the 2-segment `<org>.visualstudio.com`), present
 * only on the legacy 3-segment `<org>.visualstudio.com/<collection>/...`. So
 * null is a legitimate VALUE here, not a failure, and it needs its own rule.
 *
 * THE RULE: absent IS the default collection, so it is NORMALIZED and COMPARED
 * like the other three legs rather than routed around the comparison. See
 * `_normalizeCollection`. Two collection-less remotes still compare equal, which
 * is what makes the widening backward-compatible for every existing caller and
 * every modern-form case; a NON-default collection still differs from an absent
 * side in both directions, so cross-collection stays closed.
 *
 * AN EARLIER VERSION OF THIS DOCSTRING ARGUED THE OPPOSITE — "absent matches
 * ONLY absent", on the reasoning that letting absent match present would make
 * this leg one that can never fail. That reasoning is correct about WILDCARDS
 * and wrong about DEFAULTS, and the rule it produced shipped a maintainer
 * lockout: an ordinary ADO clone mid-URL-migration (legacy https fetch, modern
 * ssh push, ONE repository) compared present-vs-absent and refused itself.
 * `_normalizeCollection` carries the measurement and the full post-mortem.
 *
 * The distinction that keeps this from being the never-fails leg: normalizing is
 * not wildcarding. Absent resolves to ONE specific value (`defaultcollection`)
 * and is then compared; it does not match anything else. Both directions are
 * pinned by fixtures that red independently.
 */
function isSelfRepoAdo(repoRef, selfAdo) {
  if (!repoRef || !selfAdo) return false;
  for (const k of ["org", "project", "repo"]) {
    const l = normalizeComponent(repoRef[k]);
    const r = normalizeComponent(selfAdo[k]);
    if (l === null || r === null || l !== r) return false;
  }
  // ABSENT IS NOT A THIRD STATE — IT IS THE DEFAULT COLLECTION, so it is
  // NORMALIZED AND COMPARED like every other component above, not routed around
  // the comparison. See `_normalizeCollection` for why, and for the lockout the
  // first cut of this shipped.
  const lc = _normalizeCollection(repoRef.collection);
  const rc = _normalizeCollection(selfAdo.collection);
  return lc !== null && rc !== null && lc === rc;
}

/**
 * Normalize an ADO collection component, resolving ABSENT to the DEFAULT
 * COLLECTION so it can be COMPARED rather than special-cased.
 *
 * ABSENT IS NOT A THIRD STATE. `undefined` (the field was never set — every
 * pre-quad `repoRef`), `null` (a form with no collection slot), and `""` all
 * mean "the caller did not name a collection", and on the hosted ADO hosts this
 * module gates, not naming one addresses the org's DEFAULT collection. Of the
 * four recognized forms, only the legacy 3-segment org-subdomain URL carries a
 * collection segment at all; `dev.azure.com/<org>/<project>/_git/<repo>`, the
 * ssh v3 form, and the 2-segment subdomain form all address the default. So
 * absent and `DefaultCollection` name the SAME namespace and MUST compare equal.
 *
 * THE FIRST CUT OF THE QUAD GOT THIS WRONG AND SHIPPED A MAINTAINER LOCKOUT.
 * It ruled "absent matches ONLY absent", reasoning that letting absent match
 * present would make the leg one that can never fail. That reasoning was sound
 * about wildcards and wrong about DEFAULTS: it is exactly the OVER-tightening
 * direction, and it refused an ordinary ADO clone mid-URL-migration — legacy
 * https fetch, modern ssh push, ONE repository — because one side parsed a
 * collection and the other had no slot for one. Measured: `deriveSelfRepoRef`
 * returned ok:false with a triangular-remote refusal whose two printed operands
 * were IDENTICAL (`contoso/platform/coc-rs` on both sides). That is the SAME
 * lockout class `_sameDerivedIdentity` records having shipped once already via
 * raw-host comparison, reached by a new route — and every instrument was green,
 * because the only permissive triangular case drove the modern form on BOTH
 * sides and so compared absent-to-absent under any rule.
 *
 * NORMALIZING IS NOT WILDCARDING, and the distinction is the whole point: a
 * NON-default collection still differs from an absent side, so cross-collection
 * stays closed (`OtherCollection` != `defaultcollection`). Both directions are
 * pinned — `ado/mixed-form-triangular-default-collection-allows` reds if this
 * reverts to absent-matches-only-absent, and
 * `ado/non-default-collection-vs-absent-still-refuses` reds if it becomes a
 * wildcard. A one-sided pair could not tell those apart.
 *
 * SCOPE: `DefaultCollection` is the default collection name on the hosted hosts
 * in this module's closed set. On-prem Azure DevOps Server, where a collection
 * may be named anything and there need be no default, is already recorded as
 * OUT OF SCOPE for this module.
 */
const _ADO_DEFAULT_COLLECTION = "defaultcollection";

function _normalizeCollection(v) {
  if (v === undefined || v === null || v === "") {
    return _ADO_DEFAULT_COLLECTION;
  }
  return normalizeComponent(v);
}

/**
 * Render a caller-supplied PR id for INCLUSION IN A REFUSAL STRING. Display
 * only — never an operand, and never a substitute for `PR_NUMBER_RE`, which
 * still gates the value that reaches a request path.
 *
 * WHY THIS EXISTS. Both adapters interpolate `prRef.prId` into refusal `reason`
 * strings that fire BEFORE the `PR_NUMBER_RE` validation — the identity checks
 * come first by design, so an unvalidated id reaches three GitHub refusals and
 * one ADO refusal. Those reasons are logged and may be embedded in a PR body or
 * journal by `/codify` Step-7c, so a `prId` carrying newlines or terminal
 * control bytes is a log-injection surface: a forged second log line, or an
 * escape sequence, in text a human reads as the tool's own output. Bounded by
 * the module's disclosed in-process caller-trust bound, hence display-hardening
 * rather than a new gate.
 *
 * ONE SHARED HELPER, both adapters, per `security.md` § Enforcement-Surface
 * Parity — the same reason `normalizeComponent` is shared rather than copied.
 */
function displayPrId(value) {
  if (value === undefined || value === null) return "<none>";
  // `String(value)` INVOKES a caller-authored `toString`, which may throw — and
  // this runs inside the refusal path, so a throw here converts a typed
  // `{ok:false, reason}` refusal into an uncaught exception. The suite already
  // distrusts that shape: it asserts `error === null` precisely because "a crash
  // reads as a refusal to any assertion that only checks ok === false".
  let s;
  try {
    s = String(value);
  } catch {
    return "<unstringifiable>";
  }
  // POSITIVE ALLOWLIST, not a denylist. A PR id's legitimate vocabulary is
  // `[0-9]` — `PR_NUMBER_RE` / `ADO_PR_ID_RE` accept nothing else — so anything
  // else is replaced with a visible `?` rather than dropped, and a stripped
  // payload cannot silently close up into a plausible id.
  //
  // THE FIRST CUT WAS A DENYLIST (`[\x00-\x1f\x7f-\x9f]`) and it was INCOMPLETE
  // against its OWN stated threat. Measured: U+202E RIGHT-TO-LEFT OVERRIDE and
  // U+2028 LINE SEPARATOR both SURVIVED it, so a caller could still visually
  // reorder — or line-break — the refusal text a human reads as this tool's
  // output. (The C1 half was correct: JS strings are UTF-16 code units, so
  // U+0085 is the single unit 0x85 and was matched.) The denylist would have had
  // to enumerate every future dangerous code point; the allowlist closes the
  // class and cannot be outrun — `cc-artifacts.md` Rule 10, and the identical
  // reasoning `normalizeComponent` states above for exactly this reason.
  // BOUND BEFORE the walk. The output is capped at 32 code points below, so
  // nothing past that survives — but `replace` over the WHOLE input and then
  // `Array.from` over the WHOLE result allocated proportional to the INPUT, so a
  // megabyte `prId` cost a megabyte of work to produce 32 characters. 256 UTF-16
  // units is >8x the output cap, so it cannot change the result: a code point is
  // at most 2 units, so 256 units always yields at least 128 code points, and the
  // truncation branch below fires long before the cut is reachable. The capability
  // delta is ~zero (this caller is in-process, `security.md` in-process trust
  // bound) — it is the same cheap pre-bound `_scrubAndBound` takes, applied for
  // consistency rather than against a live threat.
  const cleaned = s.slice(0, 256).replace(/[^0-9]/g, "?");
  // Slice on code POINTS, not UTF-16 units, so truncation cannot leave a lone
  // surrogate at the boundary. (Post-allowlist every retained char is ASCII, so
  // this is belt-and-braces against a future relaxation of the class above.)
  const points = Array.from(cleaned);
  return points.length > 32 ? `${points.slice(0, 32).join("")}…` : cleaned;
}

/**
 * Neutralize the log-injection classes in FREE-FORM diagnostic text bound for a
 * refusal `reason` — a derived host, git's stderr. Display only, never an
 * operand.
 *
 * WHY A SECOND HELPER RATHER THAN `displayPrId`. A PR id has an enumerable
 * vocabulary (`[0-9]`) so it gets a positive allowlist. A host or a git error
 * message does not — the whole value of surfacing git's stderr is that it names
 * a path the operator recognizes, and an ASCII-only allowlist would mangle any
 * non-ASCII path into unreadability, defeating the diagnostic this exists to
 * provide. So this removes the classes that can FORGE STRUCTURE in a log or
 * terminal and preserves everything else.
 *
 * WHY IT IS NEEDED AT ALL: these two operands sit in the SAME template literals
 * `displayPrId` already sanitizes, and were left raw. `trim()` strips only
 * LEADING/TRAILING whitespace, so an INTERIOR newline survives — measured:
 * `"gitlab\ninternal.example".trim()` retains the `\n`. A remote whose authority
 * carries one derives a `host` containing it, the host fails the provider check,
 * and the refusal `reason` — which `/codify` Step-7c may embed in a PR body or
 * journal — carries a forged second line. Sanitizing `prId` while leaving its
 * neighbours raw is an enforcement-surface asymmetry (`security.md`
 * § Enforcement-Surface Parity): the argument for one is the argument for all.
 *
 * Classes removed (replaced with a visible `?`, never dropped):
 *   C0 + DEL + C1   — newline/CR forge a log line; ESC starts a terminal escape
 *   U+2028 / U+2029 — LINE / PARAGRAPH SEPARATOR (line breaks that are not \n)
 *   U+202A–U+202E   — bidi embeddings + overrides (Trojan-Source visual reorder)
 *   U+2066–U+2069   — bidi isolates (same class)
 */
function sanitizeForReason(text) {
  if (text === undefined || text === null) return "";
  let s;
  try {
    s = String(text);
  } catch {
    return "<unstringifiable>";
  }
  // Written as explicit \u escapes, NOT literal characters. The literals are
  // invisible or direction-changing in an editor, so a source-level copy of
  // this class would be the very payload it defends against — a reviewer
  // could not see what the character class contains.
  // eslint-disable-next-line no-control-regex
  return s.replace(
    // Directional MARKS (U+061C ALM, U+200E LRM, U+200F RLM) are in the same
    // Trojan-Source class as the embeddings/overrides and were missing: they
    // are invisible strong-direction characters that reorder adjacent
    // neutrals. Zero-widths (U+200B-U+200D) and U+FEFF hide content and split
    // tokens rather than reorder, which is the same forge-structure-in-a-log
    // outcome, so they go too.
    // The HIDE-CONTENT half of this class was incomplete against its own stated
    // threat and was extended after an adversarial round. U+200B-200D and U+FEFF
    // were included on the reasoning that they "hide content and split tokens
    // rather than reorder" \u2014 and U+2060-2064 (WORD JOINER + the invisible
    // operators) and U+FE00-FE0F (variation selectors) do exactly that too, and
    // were surviving.
    //
    // U+E0000-E007F IS THE ONE THAT MATTERS MOST. The Unicode TAG block encodes
    // printable ASCII invisibly (U+E0020-E007F), which is the canonical channel
    // for smuggling text past a human reader. These reasons are logged AND may
    // be embedded by /codify Step-7c in a PR body or journal entry that a
    // downstream AGENT reads, so an invisible instruction here is a
    // prompt-injection vector, not a display-cosmetics issue. Requires the `u`
    // flag for the astral range.
    //
    // WHY NOT A POSITIVE ALLOWLIST, given this file argues for one 60 lines up
    // in `displayPrId`: that argument holds where the vocabulary is enumerable
    // (`[0-9]` for a PR id). Here the whole point is to preserve arbitrary
    // readable non-ASCII \u2014 git's stderr names paths the operator must recognize
    // \u2014 so an allowlist would mangle the diagnostic this text exists to provide.
    // The denylist is the right strategy for THIS operand and the wrong one for
    // that one; what was missing was completeness within the strategy.
    /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u00ad\u180e\u115f\u1160\u3164]/gu,
    "?",
  );
}

// ---------------------------------------------------------------------------
// REFUSAL-OPERAND BOUND + SCRUB — the shared wrapper over `sanitizeForReason`.
//
// `sanitizeForReason` above removes the character CLASSES that forge structure.
// These three helpers add the two things it deliberately does not do — BOUND the
// length and SCRUB URL userinfo — and are the single implementation both VCS
// adapters consume. They live HERE, next to `sanitizeForReason`, because that is
// the sanitization SSOT; they cannot live in `vcs-provider.js`, which `require`s
// BOTH adapters at load time, so an adapter requiring it back would be a cycle
// that leaves `PROVIDERS.github` as an empty object.
//
// They were briefly duplicated once per adapter (the change that landed the
// sanitization sweep could not touch this file, which a concurrent lane owned).
// The drift risk that created was the BOUND value specifically, and the
// cross-adapter parity case in `audit-fixtures/upflow-refusal-operand-
// sanitization/` REDS if the two ever disagree — that case now guards this
// single definition instead.
//
// WHY A LENGTH BOUND AT ALL. `sanitizeForReason` replaces characters one-for-one
// and does not shorten. A remote returning a megabyte error body, or a transport
// throwing a megabyte message, produced a megabyte refusal reason — logged, and
// possibly embedded in a PR body.
//
// WHY A URL-USERINFO SCRUB (`security.md` § "No secrets in logs"). The deriver
// in this file deliberately does NOT echo the raw remote URL, because its
// userinfo may hold a PAT, and truncates git's stderr to 200 chars for the same
// reason. The adapters' catch blocks had neither guard, and a transport built on
// a PAT-in-URL remote throws an `Error` embedding `https://user:<PAT>@host/...`.
// The mask is the canonical `scheme://***@host` form of `observability.md` § 6.2,
// so a `***@` grep finds every masked site. The HOST is preserved on the shapes
// that matter most — any URL with NO `@` is untouched entirely — but that intent
// is only PARTIALLY held: see `_URL_USERINFO_RE`, where masking greedily to the
// last `@` is chosen over leaking, and an `@` in a PATH therefore costs the host.
// The `***@` grep-auditability the rule turns on is unaffected. SCOPE, stated rather than
// implied: this scrubs URL userinfo ONLY. A credential a transport surfaces some
// other way (an `Authorization: Basic <b64>` header echoed into an error string)
// is NOT covered by this regex.
const REASON_OPERAND_MAX = 256; // code points, per operand

// FAIL-SAFE BY CONSTRUCTION, AFTER TWO CLEVERER VERSIONS EACH LEAKED. Mask
// everything between `scheme://` and the LAST `@` in the whitespace-free run.
// No attempt is made to tell userinfo from a path — because the string cannot
// tell them apart, and both previous attempts to try leaked a credential.
//
// THE AMBIGUITY IS IRREDUCIBLE, which is the whole reason this is greedy.
//     https://build:12/AbCdEf@host   <- userinfo whose PASSWORD contains `/`
//     https://host:8443/path@frag    <- host:PORT, `@` in the PATH
// These are the same shape: `<word>:<digits>/<more>@<rest>`. RFC 3986 requires a
// `/` in userinfo to be percent-encoded, so the first is malformed — but this
// function reads TRANSPORT ERROR TEXT, where a user's raw-configured password
// arrives exactly that way. Nothing in the string distinguishes them.
//
// THE TWO FAILED ATTEMPTS, recorded because each looked correct and each shipped:
//   1. `[^\s/@]{0,4096}@` — a run that cannot cross `/`. Kept paths out, and
//      MISSED every password containing `/`. The base64 alphabet is A-Za-z0-9+/=,
//      so base64 service credentials and Azure storage keys landed in the miss.
//      Measured: `https://user:abc/def@host` returned verbatim.
//   2. `[^\s@:/]{0,512}(?::(?!\d+[/\s]|\d+$)[^\s@]{0,4096})?@` — a lookahead
//      meant to separate a PORT from a PASSWORD. It leaked any password matching
//      `^\d+/` (measured: `https://build:12/AbCdEf@dev.azure.com/...` verbatim;
//      ~1 in 350 base64 keys, and deterministic for `<digits>/<rest>` tokens),
//      AND still destroyed the host it was added to protect on IPv6 literals
//      (`https://[::1]:8443/a/b@c` -> `https://***@c`) and on any port terminated
//      by something other than `/` or whitespace.
//
// SO THE DIRECTION IS CHOSEN, NOT DERIVED: over-mask a diagnostic rather than
// leak a credential (`security.md` § "No secrets in logs"). Every credential
// shape masks — bare token, `user:pass`, slash-bearing, digit-slash, IPv6 host.
//
// THE COST, STATED PLAINLY: a URL containing an `@` IN ITS PATH loses its host
// (`https://github.com/acme/tree@v2` -> `https://***@v2`). That weakens the
// host-preservation intent of `observability.md` § 6.2's
// `scheme://***@host[:port]/path` form for that input class, and the intent is
// only PARTIALLY held now — deliberately, and only in the direction that cannot
// leak. What keeps the practical cost small is that a URL with NO `@` is not
// touched at all, and that is the overwhelming majority of transport errors:
// `https://github.com:8443/acme/widget.git 404` passes through with host, port
// and path intact. Whitespace also still bounds the run, so
// `fatal: https://host:8443 — contact admin@example.com` is left alone.
//
// Linearity: one bounded greedy run over a class that excludes whitespace,
// terminated by a literal `@`. No nesting, no ambiguous adjacency, so no
// backtracking blowup; the whole scan is additionally capped by `_SCRUB_WINDOW`.
// The bound is `_SCRUB_WINDOW`-sized so the run cannot be the limiting factor
// inside the window.
//
// Five polarities are pinned, each redding alone: bare token, `user:pass`,
// slash-bearing password, DIGIT-slash password (the case that reopened the leak),
// and no-`@`-means-untouched (the over-mask bound — without it, "mask
// everything" would pass).
// TWO PATTERNS, ONE PER INPUT FORMAT — because a single bound cannot serve both
// and trying to make one do it oscillated twice.
//
// The whitespace-only bound is correct for PLAIN TEXT (`reasonText`,
// `reasonFromError`): their input is transport/diagnostic prose, and any
// character removed from the run is a character a raw-configured password may
// contain, which re-opens the leak class. That is exactly how the `/` bound and
// then the `"` bound each leaked — measured for `"`:
//     https://oauth2:abc"def@github.com/a.git  ->  credential VERBATIM
//
// The quote bound is correct for JSON (`reasonOperand`, the only helper that
// calls `JSON.stringify`): there the input has no inter-token whitespace, so a
// whitespace-only run crossed FIELD BOUNDARIES and fabricated a false host —
//     {"url":"https://dev.azure.com/a/b/_git/c","user":"x@acme.com"}
//       ->  {"url":"https://***@acme.com"}
// — and a BARE `"` cannot appear inside a JSON string value, so it is the field
// delimiter rather than a character a credential might carry. Crossing an
// ESCAPED quote is what lets a quote-bearing credential still mask; see
// `_URL_USERINFO_JSON_RE` below, where the first attempt at this got the
// mechanism wrong and leaked.
//
// THE PATTERN THAT KEPT REGENERATING THIS BUG, named so the next editor does not
// repeat it: every prior revision was justified against the PREVIOUS round's
// failure and never re-checked against the failure the previous fix existed to
// prevent — scope-widening under a narrowing rationale, four times. Any future
// edit here MUST carry a case at BOTH polarities: a credential of the shape it
// newly admits/excludes must still MASK, and the over-mask bound must still HOLD.
const _URL_USERINFO_TEXT_RE =
  /([A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/)[^\s]{0,8192}@/g;
// ESCAPE-AWARE, and the plain `[^\s"]` form it replaces did NOT mask a
// quote-bearing credential — the comment above claimed it did, on the reasoning
// that "the backslash, not the quote, is what the run meets". That is false: a
// character class is applied PER CHARACTER, so a preceding `\` does not shield
// the `"` from `[^\s"]`. Measured against the shipped `[^\s"]`:
//   reasonOperand({url:'https://oauth2:abc"def@dev.azure.com/x'})
//     -> {"url":"https://oauth2:abc\"def@dev.azure.com/x"}   credential VERBATIM
// The run stopped at the escaped quote and never reached the terminating `@`.
//
// The alternation crosses an ESCAPE PAIR (`\\.`) but still stops at a BARE `"`,
// which is the actual JSON field delimiter — an unescaped `"` cannot occur inside
// a string value, so it and only it ends the field. Both properties therefore
// hold at once: a credential containing a quote masks, and the field boundary
// still contains the run.
//
// The two alternatives are DISJOINT — `[^\s"\\]` excludes the backslash that
// `\\.` starts with — so there is no ambiguous adjacency to backtrack across.
// Re-measured on 200KB adversarial inputs (backslash-dense, plain, mixed): 1ms,
// 7ms, 0ms.
const _URL_USERINFO_JSON_RE =
  /([A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/)(?:\\.|[^\s"\\]){0,8192}@/g;

// UTF-16 units the scrub examines. Two reasons it is a WINDOW, not the whole
// string. (1) COST: with an UNBOUNDED scheme run the replace was quadratic in
// the operand length — measured, a 200 kB operand hung the fixture suite past
// 120 s. The bounded quantifiers above remove the quadratic; this window caps
// the linear term. (2) SUFFICIENCY: nothing past REASON_OPERAND_MAX code points
// reaches the output anyway, and this window is ~16x that. RESIDUAL, recorded
// rather than implied: a URL whose userinfo is ITSELF longer than the window
// has no terminating @ inside it, so it does not match and its leading code
// points would survive. Real PATs are under ~100 chars, so this is stated, not
// relied upon.
const _SCRUB_WINDOW = 8192;

function _scrubAndBound(s, re) {
  const win = s.length > _SCRUB_WINDOW ? s.slice(0, _SCRUB_WINDOW) : s;
  const scrubbed = win.replace(re || _URL_USERINFO_TEXT_RE, "$1***@");
  // Cheap pre-bound in UTF-16 units BEFORE the code-point walk, so a megabyte
  // operand does not allocate a megabyte array. A code point is at most 2 units,
  // so slicing at 2*MAX+2 units can never leave fewer than MAX+1 code points —
  // i.e. the truncation branch below is always the one taken when this fires,
  // and a surrogate half stranded by this cut always sits at index >= MAX and is
  // dropped by it.
  const pre =
    scrubbed.length > REASON_OPERAND_MAX * 2 + 2
      ? scrubbed.slice(0, REASON_OPERAND_MAX * 2 + 2)
      : scrubbed;
  const points = Array.from(pre); // code points, so no lone surrogate at the cut
  return points.length > REASON_OPERAND_MAX
    ? `${sanitizeForReason(points.slice(0, REASON_OPERAND_MAX).join(""))}…`
    : sanitizeForReason(pre);
}

/**
 * A BARE interpolation (`${x}` with no JSON quoting) — path fragments, hosts,
 * principals, a nested validator's `reason`.
 */
function reasonText(value) {
  let s;
  try {
    s = typeof value === "string" ? value : String(value);
  } catch {
    // `String(value)` invokes a caller/remote-authored `toString`, which may
    // throw — and this runs INSIDE the refusal path, so a throw here converts a
    // typed `{ok:false, reason}` into an uncaught exception. The sibling fence
    // suite asserts `error === null` precisely because a crash reads as a
    // refusal to any assertion that only checks `ok === false`.
    return "<unstringifiable>";
  }
  return _scrubAndBound(s);
}

/**
 * The replacement for every former `JSON.stringify(x)` operand. Keeps the JSON
 * rendering — its diagnostic value IS the shape (`{"message":"Not Found"}`, not
 * `[object Object]`) and it keeps a numeric status bare — then sanitizes and
 * bounds it.
 */
function reasonOperand(value) {
  let s;
  try {
    s = JSON.stringify(value);
  } catch {
    // Circular structure, a BigInt, or a hostile `toJSON` that throws.
    s = undefined;
  }
  if (typeof s !== "string") {
    // `JSON.stringify` also returns undefined for undefined / function / symbol.
    try {
      s = String(value);
    } catch {
      return "<unstringifiable>";
    }
  }
  // JSON input -> the field-delimiter bound.
  return _scrubAndBound(s, _URL_USERINFO_JSON_RE);
}

/**
 * The replacement for every former
 * `${err && err.message ? err.message : String(err)}` interpolation. The
 * transport is INJECTED, so this text is attacker-influencable in the same way
 * a remote body is, and it is the operand most likely to carry a credential.
 */
function reasonFromError(err) {
  let s;
  try {
    // A property GETTER can throw, as can `toString` on a non-Error throwable
    // (a transport may throw a string, a null, or anything else).
    const m = err && err.message;
    s = m ? String(m) : String(err);
  } catch {
    return "<unstringifiable transport error>";
  }
  return _scrubAndBound(typeof s === "string" ? s : String(s));
}

module.exports = {
  _ADO_DEFAULT_COLLECTION,
  deriveSelfRepoRef,
  isSelfRepo,
  isSelfRepoAdo,
  normalizeComponent,
  displayPrId,
  REASON_OPERAND_MAX,
  reasonText,
  reasonOperand,
  reasonFromError,
  sanitizeForReason,
};
