---
name: path-containment
description: "Resolve + normalize both candidate and boundary before a path/spawn-allowlist trust decision. Use for 'path escapes boundary', 'symlink bypass', 'directory traversal', 'spawn allowlist', or auditing a containment check that compares lexical strings."
---

# Path Containment — Resolve And Normalize Before The Trust Decision

> **Skill Metadata** — load when authoring or auditing a security decision that
> tests a filesystem path against a containment boundary (a sandbox root, an
> allowed-directory tree) OR a spawn / executable allowlist. This is the depth
> reference for `rules/security.md` § "Path Containment — Resolve And Normalize
> Before The Trust Decision" (the compact baseline MUST); every DO/DO-NOT, the
> TOCTOU-at-sink detail, the OS-normalization matrix, and the cross-language
> examples live here.

## The rule in one line

A path/spawn-allowlist trust decision MUST decide on the **REAL canonical form** —
BOTH the candidate AND the boundary root resolved through symlinks with the **SAME
resolver** AND **OS-normalized** — never the lexical string; **fail closed** if the
path will not resolve.

## Why the lexical string is not the path

A lexical containment check (`candidate.startswith(root)`, `root in
os.path.abspath(candidate)`, `path.resolve()` without symlink resolution) reasons
about the STRING, not the file the string names. A symlink sitting at a
lexically-contained location can point ANYWHERE — including outside the boundary:

```
boundary_root = /srv/sandbox
candidate     = /srv/sandbox/plugins/manifest      # lexically contained ✓
               → but plugins/manifest is a symlink → /etc/cron.d/payload
```

The string `/srv/sandbox/plugins/manifest` passes every prefix/`startswith` check,
yet reading or `execFileSync`-ing it touches `/etc/cron.d/payload` — out of tree.
Only resolving the candidate through its symlinks reveals the real target; only
resolving the ROOT too makes the comparison sound (the root itself may be, or sit
under, a symlink).

## DO / DO-NOT

```text
# DO — resolve BOTH sides through the SAME resolver, then compare canonical forms
#      fail closed if resolution raises (missing/circular/permission)
# DO NOT — compare a resolved candidate against a RAW (unresolved) root
# DO NOT — trust the lexical string (startswith / prefix / abspath-only)
# DO NOT — claim the realpath re-check defeats TOCTOU (it does not — see below)
```

### Python

```python
import os

def assert_contained(candidate: str, boundary_root: str) -> str:
    # resolve BOTH through the SAME resolver (os.path.realpath follows symlinks)
    try:
        real_root = os.path.realpath(boundary_root, strict=True)
        real_cand = os.path.realpath(candidate, strict=True)   # fail closed
    except OSError as e:
        raise SecurityError(f"path will not resolve: {e}")      # NEVER proceed
    # commonpath on the RESOLVED forms; guard the "sibling prefix" trap
    if os.path.commonpath([real_root, real_cand]) != real_root:
        raise SecurityError("path escapes containment boundary")
    return real_cand
```

`startswith(real_root)` alone is WRONG even on resolved forms: `/srv/sandbox2`
starts with `/srv/sandbox`. Use `commonpath` (or append `os.sep` before the
prefix test).

### Node.js

```js
const fs = require("fs");
const path = require("path");

function assertContained(candidate, boundaryRoot) {
  let realRoot, realCand;
  try {
    realRoot = fs.realpathSync(boundaryRoot); // same resolver, both sides
    realCand = fs.realpathSync(candidate); // throws ENOENT/ELOOP → fail closed
  } catch (e) {
    throw new Error(`path will not resolve: ${e.code}`);
  }
  const rel = path.relative(realRoot, realCand);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes containment boundary");
  }
  return realCand;
}
```

### Rust

```rust
use std::fs;
use std::path::Path;

fn assert_contained(candidate: &Path, boundary_root: &Path) -> Result<PathBuf, SecurityError> {
    // std::fs::canonicalize follows symlinks AND requires the path to exist → fail closed
    let real_root = fs::canonicalize(boundary_root).map_err(|_| SecurityError::Unresolvable)?;
    let real_cand = fs::canonicalize(candidate).map_err(|_| SecurityError::Unresolvable)?;
    if !real_cand.starts_with(&real_root) {   // component-wise; NOT a string prefix
        return Err(SecurityError::Escapes);
    }
    Ok(real_cand)
}
```

`Path::starts_with` is component-wise (safe), unlike a raw `str::starts_with` — the
`/srv/sandbox2` sibling-prefix trap does not apply to `Path::starts_with`.

## OS normalization — the second half of "canonical"

Resolving symlinks is necessary but not the whole normalization. Before the
comparison, normalize the OS-specific shapes an attacker (or a portability bug)
can exploit:

| Dimension                  | Trap                                                               | Normalize by                                                 |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Separators**             | `\` vs `/`; mixed on Windows                                       | resolve to the platform separator before comparing           |
| **Windows drive-relative** | `C:foo` (relative to CWD on drive C:) vs `C:\foo`                  | fully qualify against the drive's CWD                        |
| **Case folding**           | Windows/macOS default case-insensitive FS; `PAYLOAD` == `payload`  | compare case-insensitively on those FSes                     |
| **Executable suffix**      | spawn allowlist for `git` matches `git.exe` / `git.bat` on Windows | platform-gate the suffix set; resolve to the real executable |
| **Trailing dots/spaces**   | Windows strips `foo.` → `foo`, `foo ` → `foo`                      | strip per Windows rules before comparing                     |
| **UNC / `\\?\` prefixes**  | `\\?\C:\...` bypasses normalization; `\\server\share`              | canonicalize away the extended-length prefix                 |

The spawn-allowlist case is the same shape one language over: resolve the resolved
executable path, apply OS-aware separators, platform-gate the suffix, and qualify
Windows drive-relative forms — then test membership against the RESOLVED allowlist,
never the raw invocation string. (kailash-mcp #1833 is this pattern in Rust.)

## TOCTOU — the resolve is necessary-but-NOT-sufficient

**Do NOT over-claim the realpath check defeats TOCTOU.** The resolve closes the
**lexical-bypass** class — a symlink whose target escapes the boundary can no
longer pass a string check. It does NOT close the **time-of-check-to-time-of-use**
race: between your `realpath` (the CHECK) and the `open`/`exec`/`read` (the USE),
an attacker with write access to any component of the path can **swap a directory
for a symlink**, so the bytes you validated are not the bytes you touch.

```
t0  realpath(candidate) → /srv/sandbox/data/file        (CHECK passes)
t1  attacker: rm data; ln -s /etc data                   (swap between check and use)
t2  open(candidate)     → /etc/file                       (USE touches out-of-tree)
```

TOCTOU is closed only by enforcement **AT the sink**, atomically with the access:

- **`O_NOFOLLOW`** on the final `open` — refuses if the final component is a
  symlink (Linux/BSD; `open(path, O_NOFOLLOW | O_RDONLY)`).
- **`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`** (Linux ≥5.6) — the kernel
  enforces containment during resolution; no check/use gap.
- **fd-based traversal** — `open` the boundary root once, then `openat` each
  component relative to that fd, so the validated root cannot be swapped under you.
- **Rust:** `std::fs::File::options().custom_flags(libc::O_NOFOLLOW)`; the
  `openat`/`cap-std` crates for capability-scoped roots.

The layered posture: **resolve-both-sides** (this skill's baseline) closes the
lexical class at check time; **fd-based / `O_NOFOLLOW`** at the sink closes the
race at use time. Shipping the first and calling TOCTOU handled is the over-claim
the source redteam caught — both layers are required for a hostile-writer threat
model.

## Fail-closed discipline

- Resolution that raises (missing path with `strict=True`, `ELOOP` circular
  symlink, permission denied) MUST reject — NEVER fall through to the lexical
  string or proceed on the unresolved candidate.
- A boundary root that itself will not resolve is a configuration error → reject
  the whole operation, do not silently treat the raw root as canonical.
- Unknown/unrecognized OS shape → treat as OUTSIDE the boundary (tightest).

## BLOCKED rationalizations

- "The lexical path is already inside the boundary" — the STRING is; the file it
  names may be a symlink pointing out.
- "realpath on the candidate is enough, the root is a constant" — the root may be
  (or sit under) a symlink; resolve BOTH with the SAME resolver.
- "The realpath re-check also closes TOCTOU" — it does NOT; the swap happens
  between the check and the sink. Enforce at the sink.
- "Config-supplied paths are trusted, they can't be symlinks" — the config value
  is a string; the filesystem decides what it resolves to.
- "commonpath/startswith on resolved forms is fine" — a raw string `startswith`
  hits the `/srv/sandbox2` sibling-prefix trap; use `commonpath` / component-wise
  `Path::starts_with` / `path.relative` + `..` test.

## Cross-references

- **Baseline MUST:** `rules/security.md` § "Path Containment — Resolve And
  Normalize Before The Trust Decision".
- **Fail-closed sibling:** `rules/security.md` § "Enforcement-Surface Parity"
  (unrecognized value ranks tightest) — the same fail-closed-at-the-boundary shape
  applied to authorization surfaces.
- **Redactor / min-length floors:** `rules/security.md` § "Redactor Contract"
  (another fail-closed-with-typed-error contract).

## Origin

BUILD `SECURITY-PATH-CONTAINMENT-2026-07-16`. (1) A COC eval-harness
manifest-scanner path check used a LEXICAL `resolve()` only; a symlink at a
lexically-contained path whose target escaped the boundary passed the string check
and would have `execFileSync`'d out-of-tree code — fixed by a `realpathSync`
re-check resolving BOTH candidate and root. (2) kailash-mcp #1833 spawn-allowlist
series (resolved-path allowlist + OS-aware separators + platform-gated suffix +
Windows drive-relative) — the same pattern one language over. The source redteam
caught and removed an over-claim that the realpath re-check defeated TOCTOU; that
correction is preserved here as the necessary-but-not-sufficient scoping.
