/**
 * Version tracking utilities for CO/COC artifact ecosystem.
 *
 * Each repo has a .claude/VERSION file (JSON) with type-specific fields:
 *   - coc-source:        version, no upstream (loom/)
 *   - coc-use-template:  upstream.build_version (coc-claude-py, coc-claude-rs)
 *   - coc-build:         upstream.build_version (kailash-py, kailash-rs)
 *   - coc-project:       upstream.template_version (downstream projects)
 *
 * The session-start hook calls checkVersion() to:
 *   1. Read local VERSION (auto-create if missing with detected type)
 *   2. Source repos: report source status
 *   3. Template/BUILD repos: display tracked build version info (no fetch)
 *   4. Downstream projects: display tracked template version info (no fetch)
 *   5. Legacy repos with version_url: fetch remote and compare
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Read the local .claude/VERSION file.
 * @param {string} cwd - project root
 * @returns {object|null} parsed VERSION or null if missing
 */
function readLocalVersion(cwd) {
  return readLocalVersionState(cwd).value;
}

/**
 * Read `.claude/VERSION` and say WHY it produced nothing. `readLocalVersion`'s
 * bare `catch { return null }` collapses ENOENT, EACCES, EISDIR, ELOOP and a
 * JSON parse failure into one value that reads as "absent" — and the bootstrap
 * branch acts on "absent" by CREATING-OR-TRUNCATING the file. So a CORRUPT
 * VERSION was silently replaced at every SessionStart.
 *
 * That is the repo-CLASS root of trust. At loom it would rewrite a ~362 KB
 * `type: coc-source` declaration into an 11-line `coc-project` stub — the one
 * downgrade that makes `isManifestOwnerClass` false, no-opping emit Validator 15,
 * Validator 17's half B, and V16's presence classifier while printing green
 * (#1399). `validate-bash-command.js:768` BLOCKS exactly that at the Bash
 * boundary; produced here it needs no Bash call and no Edit call, so both fences
 * are bypassed by construction.
 *
 * ONLY a genuine ENOENT is bootstrappable. Everything else is present-but-
 * unreadable: report it, never repair it. Same disposition the sibling authority
 * takes — `bin/lib/manifest-source.mjs::readRepoClass` fails CLOSED on every
 * unresolvable shape rather than guessing a class.
 *
 * @returns {{value: object|null, state: "ok"|"absent"|"corrupt", reason: string|null}}
 */
function readLocalVersionState(cwd) {
  const versionPath = path.join(cwd, ".claude", "VERSION");
  let content;
  try {
    content = fs.readFileSync(versionPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // Genuinely nothing there — the ONLY bootstrappable shape. Note a DANGLING
      // SYMLINK also lands here (readFileSync resolves the link, then ENOENTs on
      // the target), which is why the write itself must additionally refuse to
      // follow links rather than trusting this classification alone.
      return { value: null, state: "absent", reason: null };
    }
    return {
      value: null,
      state: "corrupt",
      reason: `unreadable (${e && e.code ? e.code : "unknown error"})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return {
      value: null,
      state: "corrupt",
      reason: `not valid JSON (${e.message})`,
    };
  }
  // `null` and other falsy JSON parse fine but reach the same `!local` branch by
  // a different route, so a fix that only caught a parse THROW would still
  // truncate here.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      value: null,
      state: "corrupt",
      reason: `parsed to ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}, not a JSON object`,
    };
  }
  return { value: parsed, state: "ok", reason: null };
}

/**
 * Fetch upstream VERSION from GitHub (via curl, no dependencies).
 * Times out after 3 seconds to avoid blocking session start.
 * @param {string} url - raw GitHub URL to VERSION file
 * @returns {object|null} parsed remote VERSION or null on failure
 */
function fetchUpstreamVersion(url) {
  if (!url) return null;
  try {
    const result = execFileSync("curl", ["-sf", "--max-time", "3", url], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Compare local tracked upstream version vs actual remote version.
 * @param {object} local - local VERSION object
 * @param {object} remote - remote VERSION object (fetched from GitHub)
 * @returns {object} { status, message, localVersion, remoteVersion, changelog }
 *   status: "current" | "update-available" | "unknown"
 */
function compareVersions(local, remote) {
  if (!local || !local.upstream) {
    return { status: "source", message: "This is a source repo (no upstream)" };
  }

  if (!remote) {
    return {
      status: "unknown",
      message: `Could not reach upstream (${local.upstream.name}). Offline or repo not public.`,
      localVersion: local.version,
      trackedUpstream: local.upstream.version,
    };
  }

  const tracked = local.upstream.version;
  const actual = remote.version;

  if (tracked === actual) {
    return {
      status: "current",
      message: `Artifacts current with ${local.upstream.name} v${actual}`,
      localVersion: local.version,
      trackedUpstream: tracked,
    };
  }

  // Find changelog entries newer than what we track
  const newEntries = (remote.changelog || []).filter((entry) => {
    return entry.version !== tracked && isNewer(entry.version, tracked);
  });

  const changeSummary = newEntries
    .map((e) => `  v${e.version} (${e.date}): ${e.summary}`)
    .join("\n");

  return {
    status: "update-available",
    message: `Update available: ${local.upstream.name} v${tracked} → v${actual}`,
    localVersion: local.version,
    trackedUpstream: tracked,
    remoteVersion: actual,
    changelog: changeSummary || `  v${actual}: (no changelog details)`,
  };
}

/**
 * Simple semver comparison: is a newer than b?
 * Returns false for missing/malformed inputs (NaN guard).
 */
function isNewer(a, b) {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i];
    const bi = pb[i];
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if ((ai || 0) > (bi || 0)) return true;
    if ((ai || 0) < (bi || 0)) return false;
  }
  return false;
}

/**
 * Detect repo type for bootstrap based on directory structure.
 * @param {string} cwd - project root
 * @returns {string} "coc-build" | "coc-project"
 */
function detectRepoType(cwd) {
  const hasPyproject = fs.existsSync(path.join(cwd, "pyproject.toml"));
  const hasCargo = fs.existsSync(path.join(cwd, "Cargo.toml"));
  const hasPackages = fs.existsSync(path.join(cwd, "packages"));
  const hasSrc = fs.existsSync(path.join(cwd, "src"));

  if ((hasPackages || hasSrc) && (hasPyproject || hasCargo)) {
    return "coc-build";
  }
  return "coc-project";
}

// Bounded timeout (ms) for the SessionStart replica-freshness probe. Kept well
// below sync-from-canon-fetch's own 30s ls-remote timeout: that 30s bound is for
// the human-invoked /sync-from-canon pull; a SessionStart advisory MUST be snappy
// and best-effort, so a truly-hung network is cut here long before git's own cap.
const REPLICA_FRESHNESS_TIMEOUT_MS = 4000;

/**
 * Spawn the SHIPPED read-only canon-tip probe (sync-from-canon-fetch.mjs, #576)
 * and parse its `--json` result. SYNCHRONOUS + bounded-timeout + best-effort so
 * it is safe from the SessionStart hook: a slow/unreachable canon degrades to a
 * soft result, NEVER a hang or a throw. This REUSES the shipped getUpstreamCanon
 * + git-ls-remote path verbatim (the CLI's first act is getUpstreamCanon; it does
 * ls-remote ONLY in the fork case) — no re-implementation of remote resolution,
 * no drift. checkVersion runs once per session start, so the probe fires at most
 * once per session (no repeated call to cache across a session).
 *
 * @param {string} cwd - project root (the replica/canon repo)
 * @param {number} timeoutMs - outer wall-clock bound
 * @returns {object} the parsed CLI result ({status:"canon-root"|"fetched"|"error"…})
 *   or {status:"probe-failed", reason} on any spawn/timeout/parse failure.
 *   NEVER throws.
 */
function runCanonFetchProbe(cwd, timeoutMs) {
  const script = path.join(cwd, ".claude", "bin", "sync-from-canon-fetch.mjs");
  try {
    const out = execFileSync("node", [script, "--json"], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return JSON.parse(out);
  } catch (e) {
    // The CLI exits 1 on a resolution/ls-remote error but still writes its
    // `{status:"error",subtype,…}` JSON to stdout (fork confirmed, remote read
    // failed) — recover it so a fork's soft failure is distinguishable from a
    // spawn failure. A timeout / missing script / unparseable output has no
    // recoverable status → "probe-failed" (indeterminate; treated as canon-safe
    // by the caller). NEVER rethrow: this is advisory version info, not a gate.
    if (e && e.stdout) {
      try {
        return JSON.parse(String(e.stdout));
      } catch {
        /* fall through to probe-failed */
      }
    }
    const timedOut = !!(
      e &&
      (e.killed || e.code === "ETIMEDOUT" || e.signal === "SIGTERM")
    );
    return {
      status: "probe-failed",
      reason: timedOut ? "timed out" : (e && e.code) || "probe error",
    };
  }
}

/**
 * Replica-vs-canon freshness for a resolver-mapped verbatim replica of loom.
 *
 * A replica copies canon's `.claude/VERSION` (type:coc-source) verbatim, so it
 * hits checkVersion's coc-source branch and — before this — early-returned
 * "Source repo", making a drifted replica UNABLE to self-detect drift from canon.
 * "Am I a replica" is decided SOLELY by the ecosystem-config upstream-canon
 * pointer (via the shipped probe's getUpstreamCanon), NEVER by detectRepoType
 * layout cues (which are wrong for a resolver-mapped layout).
 *
 * Returns null when fork-ness is NOT positively confirmed (canon-root, OR an
 * indeterminate probe failure) — the caller then runs the ORIGINAL early-return
 * BYTE-UNCHANGED. Returns a {status, messages[]} object only when the probe
 * POSITIVELY confirms a fork (status "fetched" or a fork-only "error").
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {(cwd:string)=>object} [opts.runFetchFn] - injectable probe (test seam)
 * @param {number} [opts.timeoutMs]
 * @returns {{status:string, messages:string[]}|null}  never throws
 */
function resolveReplicaFreshness(cwd, opts = {}) {
  const runFetch =
    opts.runFetchFn ||
    ((c) =>
      runCanonFetchProbe(c, opts.timeoutMs || REPLICA_FRESHNESS_TIMEOUT_MS));
  let res;
  try {
    res = runFetch(cwd);
  } catch {
    // Defense-in-depth: the real probe never throws, but a fault in an injected
    // seam MUST still fail soft (no hang, no throw at SessionStart).
    return null;
  }

  // canon-root (getUpstreamCanon null) OR an indeterminate probe failure: we did
  // NOT positively confirm a fork → behave exactly as canon (byte-unchanged).
  if (!res || res.status === "canon-root" || res.status === "probe-failed") {
    return null;
  }

  if (res.status === "fetched") {
    const tip = res.tip ? String(res.tip).slice(0, 12) : null;
    if (tip) {
      return {
        status: "replica",
        messages: [
          `[VERSION] Replica of canon — canon HEAD is ${tip}. Run /sync-from-canon to review upstream drift.`,
        ],
      };
    }
    return {
      status: "replica-unknown",
      messages: [
        `[VERSION] Replica of canon — canon ref '${res.ref || "HEAD"}' not advertised; could not read canon tip. Run /sync-from-canon.`,
      ],
    };
  }

  // status "error": the CLI reached this only AFTER passing the canon-root gate,
  // so getUpstreamCanon was non-null → fork CONFIRMED, but the remote read failed
  // (ls-remote-failed / unresolved-canon-remote / scheme-rejected). Soft note; a
  // network timeout here is EXPECTED and reported, never a hang or throw.
  const reason = res.subtype || res.reason || "unreachable";
  return {
    status: "replica-unreachable",
    messages: [
      `[VERSION] Replica of canon — could not reach canon (${reason}); showing local version only (advisory).`,
    ],
  };
}

/**
 * Main entry point for session-start hook.
 * @param {string} cwd - project root
 * @param {object} [opts] - test seam: { resolveReplicaFreshnessFn, runFetchFn, timeoutMs }
 * @returns {object} { status, messages[] } for stderr output
 */
function checkVersion(cwd, opts = {}) {
  const localState = readLocalVersionState(cwd);
  let local = localState.value;

  // PRESENT-BUT-UNREADABLE IS NOT ABSENT. Bootstrapping repairs a repo that has
  // no declaration; it must never "repair" one it merely failed to read, because
  // the repair is a create-or-TRUNCATE of the class root of trust. Report and
  // return — the owner fixes it where the change is visible in a diff.
  if (localState.state === "corrupt") {
    return {
      status: "corrupt-version",
      messages: [
        `[VERSION] ⚠ .claude/VERSION is present but ${localState.reason} — NOT overwritten.`,
        `[VERSION] Repair it by hand (it declares this repo's class; a wrong \`type\` silently disables emit validators). Nothing was changed automatically.`,
      ],
    };
  }

  if (!local) {
    // Auto-create VERSION if .claude/ exists but VERSION doesn't (per 08-versioning.md)
    const claudeDir = path.join(cwd, ".claude");
    if (fs.existsSync(claudeDir)) {
      const detectedType = detectRepoType(cwd);
      const bootstrapped = {
        version: "0.0.0",
        type: detectedType,
        updated: new Date().toISOString().split("T")[0],
        description:
          "Auto-created — run /sync to pull latest template artifacts",
        upstream:
          detectedType === "coc-build"
            ? {
                source: "unknown",
                build_version: "0.0.0",
                synced_at: null,
              }
            : {
                template: "unknown",
                template_version: "0.0.0",
                synced_at: null,
              },
      };
      const versionPath = path.join(claudeDir, "VERSION");
      try {
        // O_EXCL|O_NOFOLLOW — a SECOND, INDEPENDENT fence, deliberately not
        // relying on the state classification above being right.
        //   O_EXCL     refuses if anything is already there, so this can only
        //              ever CREATE, never truncate. The default `writeFileSync`
        //              flag is "w" (create-or-truncate), which is what made a
        //              corrupt VERSION destroyable.
        //   O_NOFOLLOW refuses to write THROUGH a symlink. A dangling
        //              `.claude/VERSION -> /some/other/file` reads as ENOENT
        //              (state "absent"), and a following write would create the
        //              link's TARGET — clobbering an arbitrary out-of-tree path,
        //              unprompted, at SessionStart. Mirrors the O_NOFOLLOW
        //              posture `bin/lib/manifest-source.mjs` already takes on the
        //              read side, where ELOOP is a tamper tripwire (#569).
        const fd = fs.openSync(
          versionPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o644,
        );
        try {
          fs.writeFileSync(fd, JSON.stringify(bootstrapped, null, 2) + "\n");
        } finally {
          fs.closeSync(fd);
        }
        local = bootstrapped;
        return {
          status: "bootstrapped",
          messages: [
            `[VERSION] Created initial VERSION file (v0.0.0, type: ${detectedType})`,
            "[VERSION] Run /sync to pull latest template artifacts",
          ],
        };
      } catch (e) {
        // EEXIST / ELOOP here mean the two fences above REFUSED — something is
        // at that path after all (a race, or a symlink). That is a finding, not
        // a no-op: swallowing it silently is the error-hiding pattern
        // `zero-tolerance.md` Rule 3 blocks, and it is precisely the case an
        // operator needs to see.
        const code = e && e.code;
        if (code === "EEXIST" || code === "ELOOP") {
          return {
            status: "corrupt-version",
            messages: [
              `[VERSION] ⚠ Refused to create .claude/VERSION: a ${code === "ELOOP" ? "SYMLINK" : "file"} already occupies that path (${code}).`,
              `[VERSION] Nothing was written. Inspect it — a symlinked VERSION would redirect this repo's class declaration outside the repo.`,
            ],
          };
        }
        return { status: "no-version", messages: [] };
      }
    }
    return { status: "no-version", messages: [] };
  }

  const messages = [
    `[VERSION] ${local.description || local.type} v${local.version}`,
  ];

  const repoType = local.type || "coc-project";
  const upstream = local.upstream || {};

  // --- Source repos: fetch remote, compare ---
  if (repoType === "coc-source" || !local.upstream) {
    // F-353 Item 2: a resolver-mapped verbatim REPLICA of canon also carries
    // type:coc-source (its VERSION is a byte copy of canon's) but declares an
    // upstream-canon in ecosystem.json. For a replica, surface canon's current
    // tip so the session can self-detect drift — before this, a drifted replica
    // could NEVER self-detect. Fork-only: on CANON (getUpstreamCanon null →
    // canon-root) resolveReplicaFreshness returns null and the ORIGINAL
    // early-return below runs BYTE-UNCHANGED. Best-effort + bounded-timeout: a
    // slow/unreachable canon degrades to a soft note, never a hang or throw
    // (advisory version info, not a security gate).
    const resolveFreshness =
      opts.resolveReplicaFreshnessFn || resolveReplicaFreshness;
    const freshness = resolveFreshness(cwd, opts);
    if (freshness) {
      for (const m of freshness.messages) messages.push(m);
      return { status: freshness.status, messages };
    }
    if (!local.upstream) {
      messages.push("[VERSION] Source repo — no upstream to check");
    } else {
      messages.push("[VERSION] Source repo (coc-source)");
    }
    return { status: "source", messages };
  }

  // --- USE template / BUILD repos: display tracked version info ---
  // But first: is this repo's declared class credible? When a user creates a
  // repo via "Use this template" on GitHub they inherit the template's VERSION
  // verbatim, including `type: coc-use-template` — but their repo is actually a
  // downstream project (coc-project). That mis-declaration is REPORTED here,
  // never repaired in place: `.claude/VERSION` is the repo-CLASS root of trust
  // (`lib/manifest-source.mjs::readRepoClass` trusts `type` verbatim; a forged
  // class silently no-ops emit Validators 15/16/17 while printing green, #1399),
  // and `validate-bash-command.js` BLOCKS an agent from writing it at the Bash
  // boundary. A SessionStart hook that rewrites it on a schedule is the same
  // forgery with a longer reach, so this branch is READ-ONLY. See § class-
  // declaration credibility below for the predicate and the migration note.
  if (repoType === "coc-use-template" || repoType === "coc-build") {
    if (repoType === "coc-use-template") {
      const advisory = templateClassAdvisory(cwd, local);
      if (advisory) {
        for (const m of advisory) messages.push(m);
        const buildVer = upstream.build_version || "unknown";
        const syncedAt = upstream.synced_at
          ? ` synced ${upstream.synced_at}`
          : "";
        messages.push(
          `[VERSION] COC artifacts from loom v${local.version}, build v${buildVer}${syncedAt}`,
        );
        return { status: "class-advisory", messages };
      }
    }
    const buildVer = upstream.build_version || "unknown";
    const syncedAt = upstream.synced_at ? ` synced ${upstream.synced_at}` : "";
    messages.push(
      `[VERSION] COC artifacts from loom v${local.version}, build v${buildVer}${syncedAt}`,
    );
    return { status: "tracked", messages };
  }

  // --- Downstream projects: display template tracking info ---
  if (repoType === "coc-project") {
    const tmpl = upstream.template || "unknown";
    const tmplVer = upstream.template_version || "unknown";
    const syncedAt = upstream.synced_at ? `, synced ${upstream.synced_at}` : "";
    messages.push(
      `[VERSION] COC from template ${tmpl}, v${tmplVer}${syncedAt}`,
    );
    if (tmpl === "unknown") {
      messages.push(
        `[VERSION] ⚠ Template unknown — set upstream.template in .claude/VERSION (e.g., "kailash-coc-claude-py") then run /sync`,
      );
    }
    return { status: "tracked", messages };
  }

  // --- Fallback: legacy repos with upstream.version_url (source-style fetch) ---
  const remote = fetchUpstreamVersion(upstream.version_url);
  const result = compareVersions(local, remote);

  if (result.status === "current") {
    messages.push(`[VERSION] ${result.message}`);
  } else if (result.status === "update-available") {
    messages.push(`[VERSION] ⚠ ${result.message}`);
    messages.push("[VERSION] Changes:");
    messages.push(result.changelog);
    messages.push("[VERSION] Run /sync to update artifacts");
  } else {
    messages.push(`[VERSION] ${result.message}`);
  }

  return { status: result.status, messages };
}

/**
 * Known USE template repos — GitHub slugs that ARE actual templates.
 * If a repo's git remote matches one of these, it's the real template,
 * not a downstream project created from it.
 */
const KNOWN_TEMPLATE_REPOS = {
  // CC-only legacy templates (clis: [claude]).
  "terrene-foundation/kailash-coc-claude-py": "kailash-coc-claude-py",
  "terrene-foundation/kailash-coc-claude-rs": "kailash-coc-claude-rs",
  "terrene-foundation/kailash-coc-claude-rb": "kailash-coc-claude-rb",
  "terrene-foundation/kailash-coc-claude-prism": "kailash-coc-claude-prism",
  // Multi-CLI USE templates (clis: [claude, codex, gemini]). These repos
  // ship `type: coc-use-template` on main (re-typed from the pre-existing #407
  // `coc-project` drift by the sync-upflow Wave-3 distribution). These
  // KNOWN_TEMPLATE_REPOS entries make `isActualTemplateRepo` return true
  // (dir-basename / git-remote match), so session-start's checkVersion() does
  // NOT run the `coc-use-template && !isActualTemplateRepo` auto-correct branch
  // — the re-typed VERSION stays `coc-use-template` instead of being rewritten
  // back to `coc-project` on every session start (the perpetual `M .claude/VERSION`
  // drift #407 closed). Authoritative sync targets per sync-manifest.yaml::repos
  // (py.templates + rs.templates carrying clis:[claude,codex,gemini]);
  // kailash-coc-rb / use-template.rb were the forward-declared multi-CLI Ruby
  // sibling; the rb USE lane was RETIRED in #423 Phase 1 (Ruby ships as bindings
  // via the rs all-bindings template). This entry is retained only so tooling
  // identifies a lingering retired-template repo, NOT mis-classifying it as a
  // downstream project — mirrors the claude-rb retention.
  "terrene-foundation/kailash-coc-py": "kailash-coc-py",
  "terrene-foundation/kailash-coc-rs": "kailash-coc-rs",
  "terrene-foundation/kailash-coc-rb": "kailash-coc-rb",
  // Base-variant (non-Kailash, language-agnostic) USE templates — same
  // bug class as the multi-CLI templates above. coc-base is multi-CLI
  // (clis:[claude,codex,gemini]); coc-claude-base is its CC-only sibling.
  // Both are live sync targets per sync-manifest.yaml::repos.base.templates
  // and ship type:coc-use-template, so without these they drift to coc-project
  // every session start exactly like #407. Closed in-pass per the #407 redteam
  // (autonomous-execution.md MUST-4 same-bug-class, zero-tolerance.md Rule 1a).
  "terrene-foundation/coc-base": "coc-base",
  "terrene-foundation/coc-claude-base": "coc-claude-base",
};

/**
 * Check if this repo is actually a USE template repo (not just derived from one).
 * Checks directory name (monorepo safeguard) and git remote origin.
 *
 * LEGACY / TRANSITIONAL. This predicate can only recognize CANON's own templates
 * — a client-fork ecosystem's template is by definition not named
 * `terrene-foundation/kailash-coc-*`, so it answers `false` there. It is retained
 * ONLY as a silencer for canon templates that do not yet declare `repo` in their
 * `.claude/VERSION`. Nothing gates a WRITE on it any more (see
 * `templateClassAdvisory`), so a `false` here costs at most one advisory message.
 * Delete this map once every canon template stamps its own `repo` slug.
 */
function isActualTemplateRepo(cwd) {
  const dirName = path.basename(cwd);
  if (Object.values(KNOWN_TEMPLATE_REPOS).includes(dirName)) {
    return true;
  }
  try {
    let remote = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    // Normalize SSH URLs: git@github.com:owner/repo.git → owner/repo
    if (remote.startsWith("git@")) {
      remote = (remote.split(":")[1] || "").replace(/\.git$/, "");
    }
    for (const slug of Object.keys(KNOWN_TEMPLATE_REPOS)) {
      if (remote.includes(slug)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Class-declaration credibility (read-only) ──────────────────────────────
//
// "Use this template" produces a BYTE COPY, so no file-PRESENCE signal can ever
// discriminate a template from a repo created out of one — the copy carries every
// marker the original had. The only durable discriminator is a declaration that
// INVALIDATES ITSELF on copy: the VERSION names the repo it was authored FOR, and
// that is compared against this repo's own runtime identity (git remote origin).
// The template's copy keeps naming the template; the derived repo's remote does
// not. This is why a boolean `"is_template": true` would be WRONG — it survives
// the copy intact and would silence the very case it must catch.
//
//   .claude/VERSION → { "repo": "<owner>/<name>" }   // may also be a bare <name>
//
// A fork ecosystem's template declares its OWN slug and is then indistinguishable
// from canon's to this predicate — which is the whole point of removing the
// hardcoded name list from the decision path.

/**
 * Normalize any git remote URL to { slug, name }.
 * Handles `git@host:owner/repo.git`, `https://host/owner/repo.git`,
 * `ssh://git@host/owner/repo`, and Azure DevOps `.../<org>/<project>/_git/<repo>`.
 * `slug` is the last TWO path segments, `name` the last one; both lowercased.
 * Returns { slug: null, name: null } for anything unparseable.
 *
 * The `_git` path marker is DROPPED, not kept: on Azure DevOps it is a literal
 * routing segment, not an owner, so keeping it yields the nonsense slug
 * `_git/<repo>` — which then never equals any real declaration and would accuse
 * every ADO-hosted template of being a copy. Dropping it recovers the meaningful
 * `<project>/<repo>` pair. Clients DO clone into ADO layouts
 * (`repo-scope-discipline.md` § MUST NOT), so this is a live path, not a curio.
 */
function normalizeRemoteIdentity(url) {
  if (!url || typeof url !== "string") return { slug: null, name: null };
  let s = url.trim();
  if (!s) return { slug: null, name: null };
  // scp-style `git@host:owner/repo.git` → keep only the part after the colon
  if (!s.includes("://") && s.includes(":")) s = s.slice(s.indexOf(":") + 1);
  // URL forms → drop scheme + userinfo + host
  if (s.includes("://")) {
    const afterScheme = s.slice(s.indexOf("://") + 3);
    const firstSlash = afterScheme.indexOf("/");
    s = firstSlash === -1 ? "" : afterScheme.slice(firstSlash + 1);
  }
  s = s.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = s.split("/").filter((p) => p && p !== "_git");
  if (parts.length === 0) return { slug: null, name: null };
  const name = parts[parts.length - 1].toLowerCase();
  const slug =
    parts.length >= 2
      ? `${parts[parts.length - 2].toLowerCase()}/${name}`
      : null;
  return { slug, name };
}

/**
 * This repo's own runtime identity, read from git remote origin.
 * Bounded timeout; never throws. Falls back to the directory basename, which is
 * the pre-existing monorepo safeguard and the only signal available with no
 * remote configured.
 * @returns {{slug:string|null, name:string|null, source:"remote"|"dirname"}}
 */
function readRepoIdentity(cwd) {
  try {
    const remote = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const id = normalizeRemoteIdentity(remote);
    if (id.name) return { ...id, source: "remote" };
  } catch {
    /* no remote / not a repo / git absent → dirname fallback below */
  }
  const base = path.basename(cwd || "");
  return {
    slug: null,
    name: base ? base.toLowerCase() : null,
    source: "dirname",
  };
}

/**
 * The self-identity a VERSION declares, if any.
 * @returns {{slug:string|null, name:string|null}|null} null when undeclared
 */
function declaredSelfRepo(local) {
  const raw = local && typeof local.repo === "string" ? local.repo.trim() : "";
  if (!raw) return null;
  const cleaned = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  // Drop `_git` on BOTH sides. `normalizeRemoteIdentity` strips this ADO routing
  // segment from the derived identity, so a HAND-WRITTEN
  // `repo: "project/_git/name"` (someone pasting an ADO browser URL) would
  // otherwise be parsed asymmetrically against it. Name-anchoring makes the
  // present-day impact nil, but the two parsers comparing the same string
  // differently is the drift shape this change exists to remove.
  const parts = cleaned.split("/").filter((p) => p && p !== "_git");
  if (parts.length === 0) return null;
  const name = parts[parts.length - 1].toLowerCase();
  const slug =
    parts.length >= 2
      ? `${parts[parts.length - 2].toLowerCase()}/${name}`
      : null;
  return { slug, name };
}

/**
 * Classify how credible this repo's `coc-use-template` declaration is.
 * PURE with respect to the filesystem — reads git metadata, writes nothing.
 *
 * @returns {"self-declared"|"known-template"|"mismatch"|"undetermined"}
 *   self-declared  — VERSION::repo matches this repo's own identity → it IS a
 *                    template (canon's or a fork's; they look identical here).
 *   known-template — legacy canon allowlist match (no VERSION::repo yet).
 *   mismatch       — VERSION::repo names a DIFFERENT repo than this one, on two
 *                    real identities. High confidence: copied from a template.
 *   undetermined   — no self-declaration and no allowlist match, or identity
 *                    unreadable. Reported, never acted on.
 *
 * THE COMPARISON IS NAME-ANCHORED, and deliberately so. The repo NAME is the one
 * component that survives every legitimate relocation — an org rename, a
 * host migration, an ADO `<org>/<project>/_git/<repo>` layout, a mirror — while
 * "Use this template" is precisely the operation that CHANGES it (the user names
 * their new repo). Owner-level disagreement alone is therefore evidence of a move,
 * not of a copy, and this returns `self-declared` for it: a matching name with a
 * differing owner is far more likely a fork of the template than a repo built out
 * of one. Requiring full-slug equality is what produced a false "you are a copy"
 * verdict against every ADO-hosted fork template.
 *
 * The residual false-NEGATIVE — deriving a repo from a template AND giving it the
 * template's exact name — is accepted knowingly. Both branches are advisory-only
 * now, so the cost of a miss is one unprinted hint, whereas the cost of a false
 * accusation is an operator following a wrong instruction into a corrupted class.
 */
function classifyTemplateDeclaration(cwd, local) {
  const declared = declaredSelfRepo(local);
  const actual = readRepoIdentity(cwd);

  if (declared) {
    if (declared.slug && actual.slug && declared.slug === actual.slug) {
      return "self-declared"; // strongest: exact owner/name agreement
    }
    if (declared.name && actual.name) {
      if (declared.name === actual.name) return "self-declared";
      // Only a git remote is a strong enough identity to call a mismatch; a
      // directory name differs benignly all the time (clone into any folder).
      return actual.source === "remote" ? "mismatch" : "undetermined";
    }
    return "undetermined";
  }

  if (isActualTemplateRepo(cwd)) return "known-template";
  return "undetermined";
}

/**
 * The advisory lines for a `coc-use-template` declaration that could not be
 * confirmed. Returns null when the declaration is credible (no output — canon
 * templates stay byte-identical to the pre-fix behaviour).
 *
 * NEVER writes, NEVER throws: on any internal failure it degrades to null, which
 * leaves `.claude/VERSION` untouched and the session starting normally.
 *
 * The suggested value is always this repo's OWN identity, preferring the full
 * `<owner>/<name>` slug and falling back to the bare name — never a raw remote
 * fragment. A hint the operator would be wrong to follow is worse than no hint:
 * they would be hand-editing the class root of trust on our instruction.
 */
function templateClassAdvisory(cwd, local) {
  let verdict, actual;
  try {
    verdict = classifyTemplateDeclaration(cwd, local);
    actual = readRepoIdentity(cwd);
  } catch {
    return null;
  }
  if (verdict === "self-declared" || verdict === "known-template") return null;

  const me = actual.slug || actual.name || "this repo";
  const suggest = actual.slug || actual.name;
  // Only offer a `repo` value when we actually resolved one.
  const declareFix = suggest
    ? `set "repo": "${suggest}"`
    : `add a "repo": "<owner>/<name>" naming this repo`;
  // Deliberately names only `git remote get-url origin` — the exact input this
  // predicate read. Pointing at a richer class-inspection tool would be a
  // dangling instruction on any consumer that does not carry it (loom#1228).
  const verify = `Confirm this repo's identity with: git remote get-url origin`;

  if (verdict === "mismatch") {
    const d = declaredSelfRepo(local) || {};
    const declared = d.slug || d.name || local.repo;
    return [
      `[VERSION] ⚠ Class declaration looks stale: .claude/VERSION says type "coc-use-template" for repo "${declared}", but this repo is "${me}".`,
      `[VERSION] If it was created FROM that template, set "type": "coc-project" (and upstream.template to the template you pull from). If it IS a template, ${declareFix}. Nothing was changed automatically. ${verify}`,
    ];
  }
  return [
    `[VERSION] ⚠ Declared type "coc-use-template" could not be confirmed for "${me}" — .claude/VERSION declares no "repo".`,
    `[VERSION] If this IS a USE template, ${declareFix} in .claude/VERSION. If it was created FROM one, set "type": "coc-project". Nothing was changed automatically. ${verify}`,
  ];
}

/**
 * Compute the VERSION a template-derived repo SHOULD carry: coc-use-template →
 * coc-project with downstream upstream fields. PURE — returns the suggested
 * object and writes nothing. `.claude/VERSION` is the repo-CLASS root of trust
 * (#1399); the class is repaired by its owner, never by a hook.
 *
 * @returns {object} the suggested VERSION object (never null)
 */
function computeTemplateDerivedCorrection(cwd, original) {
  const templateName = guessTemplateName(cwd, original);
  const templateSlug = templateName
    ? Object.entries(KNOWN_TEMPLATE_REPOS).find(
        ([, name]) => name === templateName,
      )?.[0] || null
    : null;

  const corrected = {
    version: original.version || "0.0.0",
    type: "coc-project",
    description: original.description
      ? original.description.replace(/USE template/i, "downstream project")
      : "Downstream project (auto-corrected from template)",
    updated: new Date().toISOString().split("T")[0],
    upstream: {
      template: templateName || "unknown",
      template_repo: templateSlug || null,
      template_version: original.version || "0.0.0",
      synced_at: (original.upstream || {}).synced_at || null,
      sdk_packages: (original.upstream || {}).sdk_packages || {},
    },
  };

  return corrected;
}

// Deprecated alias. Kept for one cycle so any out-of-tree caller keeps resolving,
// but it NO LONGER WRITES `.claude/VERSION` — the silent SessionStart rewrite of
// the repo-CLASS root of trust was the defect this change removes. It now returns
// the same suggested object `computeTemplateDerivedCorrection` does, and says so
// once per process rather than mutating anything.
let deprecationAnnounced = false;
function correctTemplateDerivedVersion(cwd, original) {
  if (!deprecationAnnounced) {
    deprecationAnnounced = true;
    console.error(
      "[VERSION] correctTemplateDerivedVersion() is deprecated and no longer writes " +
        ".claude/VERSION (the repo-class root of trust is repaired by its owner, #1399). " +
        "Use computeTemplateDerivedCorrection() for the suggested object.",
    );
  }
  return computeTemplateDerivedCorrection(cwd, original);
}

/**
 * Guess which template this repo was derived from.
 * Uses the variant field or upstream.name from the original VERSION.
 */
function guessTemplateName(cwd, original) {
  const variant = original.variant;
  if (variant) {
    return `kailash-coc-claude-${variant}`;
  }
  // Check git remote for template repo name hints
  try {
    const remote = execFileSync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    // Check if the repo was CREATED from a template — git initial commit
    // may reference the template. Also check first commit message.
  } catch {}
  // Check description — but "Rust-backed" bindings means rs template,
  // even though "Python/Ruby" appears first in the description.
  const desc = (original.description || "").toLowerCase();
  if (
    desc.includes("rust-backed") ||
    desc.includes("kailash-rs") ||
    desc.includes("rs bindings")
  ) {
    return "kailash-coc-claude-rs";
  }
  if (desc.includes("prism") || desc.includes("composable")) {
    return "kailash-coc-claude-prism";
  }
  if (desc.includes("ruby") && !desc.includes("rust")) {
    return "kailash-coc-claude-rb";
  }
  if (desc.includes("python") || desc.includes("-py")) {
    return "kailash-coc-claude-py";
  }
  // Check upstream.name or upstream.source
  const upstreamName = (original.upstream || {}).name || "";
  if (upstreamName) {
    return "kailash-coc-claude-py";
  }
  return null;
}

module.exports = {
  readLocalVersion,
  readLocalVersionState,
  fetchUpstreamVersion,
  compareVersions,
  checkVersion,
  detectRepoType,
  isActualTemplateRepo,
  normalizeRemoteIdentity,
  readRepoIdentity,
  declaredSelfRepo,
  classifyTemplateDeclaration,
  templateClassAdvisory,
  computeTemplateDerivedCorrection,
  correctTemplateDerivedVersion,
  resolveReplicaFreshness,
  runCanonFetchProbe,
  REPLICA_FRESHNESS_TIMEOUT_MS,
};
