---
name: docker-dev-env-patterns
description: "Docker dev-container patterns. Use when 'git commit -S fails in container', 'gpg-agent read-only / General error', 'gem installed but require fails in plain shell', or 'BUNDLE_PATH LoadError'."
---

# Docker Dev-Environment Patterns

> **Skill Metadata** — load when authoring or debugging a Dockerized dev
> environment (dev-container, `bin/dev`, compose dev stack) for a COC template.
> Two MUST-class patterns surfaced during real user-flow walks of a Dockerized
> dev stack. Each is structural — the symptom is confusing and the fix is a
> design property, not a tweak.

## Summary

| Pattern                                      | Failure the user hits                                                                                                                                                              | Structural fix                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — Cross-Platform GPG Keyring Bootstrap** | `git commit -S` cannot sign inside the container on a macOS host (`gpg: can't connect to the gpg-agent: Read-only file system` OR `gpg: failed to start gpg-agent: General error`) | Side-mount the host keyring READ-ONLY at `/host-gnupg`; `bin/dev setup` populates a FRESH container-side `~/.gnupg` via prune-then-copy + denylist tar |
| **B — Bundler Shared-Env Trap**              | A gem installs fine but `ruby -e 'require "<gem>"'` fails with `LoadError` in a plain shell — only `bundle exec` works                                                             | Unset `BUNDLE_PATH` **and** `BUNDLE_APP_CONFIG` (`env -u`) in every overlay-install path so bundler installs flat into `GEM_HOME`                      |

---

## Pattern A — Cross-Platform GPG Keyring Bootstrap

### The trap

Directly mounting the host `~/.gnupg` into a Linux container **cannot** deliver
`git commit -S` signing on a macOS host (the dominant developer surface). Two
structural failure modes, depending on mount mode:

1. **`:ro` mount** → `gpg: can't connect to the gpg-agent: Read-only file
system`. The Linux gpg-agent needs a _writable_ directory for its socket;
   a read-only mount denies it.
2. **`rw` mount** → `gpg: failed to start gpg-agent: General error`. The host
   macOS socket files (`S.gpg-agent`, `.#lk<HOSTNAME>.local.NNNNN`) leak into
   the container and confuse the Linux agent's startup probe.

The macOS↔Linux gpg-agent ABI gap is the root cause — the host's agent socket
is not usable by the container's agent, and either mount mode breaks.

### The structural fix

Side-mount the host keyring **read-only** at `/host-gnupg` (NOT at
`/home/<user>/.gnupg`). Then `bin/dev setup` populates a FRESH container-side
`~/.gnupg` by **prune-then-copy** with a **denylist tar**:

```bash
# bin/dev setup (sketch — the load-bearing shape, not a drop-in)
[ -d /host-gnupg ] || { echo "no host keyring side-mounted; skipping gpg bootstrap"; exit 0; }
umask 077                                   # no permissive-bits window before chmod
rm -rf "$GNUPGHOME"                          # prune: revoked-on-host keys vanish here too
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
# denylist tar: copy EVERYTHING except the host agent sockets/locks
tar -C /host-gnupg --exclude='S.gpg-agent*' --exclude='.#lk*' -cf - . \
  | tar -C "$GNUPGHOME" -xf -
chmod 700 "$GNUPGHOME/private-keys-v1.d" 2>/dev/null || true   # GnuPG checks this subdir's bits
```

### Why each design property matters

- **Side-mount (not direct mount):** crosses the macOS↔Linux gpg-agent ABI gap;
  the host keyring stays immutable from the container via `:ro`.
- **Prune-then-copy (not additive `cp`):** a key revoked on the host disappears
  from the container too. Additive copy leaves revoked keys usable inside the
  container — a real security gap.
- **Denylist (not allowlist):** survives GnuPG version drift. Legacy
  `pubring.gpg` and future state (`tofu.db`, new files) inherit the copy
  automatically; an allowlist silently drops anything it didn't enumerate.
  Covers `pubring.kbx`, `pubring.gpg`, `openpgp-revocs.d`, `tofu.db`, `gpg.conf`,
  `trustdb.gpg`, `private-keys-v1.d`, and any future GnuPG state.
- **`umask 077` BEFORE copy:** no permissive-bits window between the copy and
  the `chmod` — keys never briefly exist group/other-readable.
- **`700` on `private-keys-v1.d` explicitly:** GnuPG checks the group/other bits
  on the secret-key subdir specifically and refuses to use it otherwise.

### Cons — the revocation trust window (state honestly)

The prune-then-copy revocation property is **bounded**: propagation happens at
the NEXT `bin/dev setup` (the postCreate boundary), NOT in real time. An
operator who revokes a key on the host but does NOT immediately re-run
`bin/dev setup` retains the revoked key inside any long-lived container until the
next setup. The documented mitigation for a compromised-key scenario is to
rebuild the workspace: `docker compose down workspace && ./bin/dev setup`. State
this con alongside the pros — the revocation guarantee is "next setup," not
"instant."

### The `[ -d /host-gnupg ]` guard is load-bearing — preserve it verbatim

The directory predicate `[ -d /host-gnupg ]` at the top of the bootstrap is a
**safety guard**, not a convenience. Without it, `rm -rf "$GNUPGHOME"` runs
unconditionally and wipes `~/.gnupg` inside EVERY container — including those
with no GPG configured and no side-mount. Any template that implements this
pattern MUST preserve the directory-predicate guard verbatim.

Substituting an env-var sentinel (`${ENABLE_GPG:-}`) is **BLOCKED**: an env-var
sentinel does not fire when unset, while the directory predicate fires correctly
on the actual side-mount state. The guard tests the real precondition (is the
host keyring actually mounted?), not an operator's memory to set a flag. This is
the same structural class as a load-bearing kwarg that MUST land at every call
site — the guard MUST land at every implementation, not just the first.

---

## Pattern B — Bundler Shared-Env Trap

### The trap

`BUNDLE_PATH=<anything>` exported in ANY layer — image `ENV`, compose
`environment:`, host shell, `.env`, `.bundle/config` — forces bundler's
_isolated_ nested-layout install path (`<base-path>/ruby/<ver>/gems/...`), which
is NOT on the default `Gem.path`. Result: a gem installed via an overlay
(`Gemfile.user`) is on disk but `ruby -e 'require "<gem>"'` fails with `LoadError`
in a plain shell — only `bundle exec` works.

This is a **silent** NFR violation: the user sees `bundle install` succeed, then
`require` fails, with no obvious correlation between the two.

### The structural fix

In every overlay-install path that runs `bundle install`, defensively unset BOTH
variables:

```bash
env -u BUNDLE_PATH -u BUNDLE_APP_CONFIG bundle install
```

- `BUNDLE_PATH` is the primary trap.
- `BUNDLE_APP_CONFIG` is the secondary: it points at `.bundle/config`, which can
  _re-supply_ `BUNDLE_PATH`. Unsetting only the primary leaves the secondary path
  open.

With both unset, bundler installs system-wide into `GEM_HOME` (flat layout) and
the same shell can `require "<gem>"` directly.

### Defense in depth

Ship a CI smoke test that asserts the trap variable is absent inside the built
image:

```bash
[ -z "${BUNDLE_PATH:-}" ] || { echo "BUNDLE_PATH set in image — Pattern B regression"; exit 1; }
```

This catches any regression that re-introduces the trap — a future Dockerfile
`ENV BUNDLE_PATH=...`, or a base-image change that defaults it.

### Generalizes to — the shared-env-vs-isolated-install class

Pattern B is the Ruby instance of a broader class: **a tool that has BOTH an
"isolated" and a "shared/system" install path, where an inherited environment
variable silently flips it to the isolated path that the default resolver
doesn't see.** The same trap shape appears in other ecosystems — author the
analog explicitly when a template ships that language's dev container:

- **Python — venv vs system site-packages:** `PIP_TARGET` / `PYTHONPATH` /
  `VIRTUAL_ENV` inherited into a layer can route `pip install` to a directory the
  running interpreter's `sys.path` doesn't include. A package installs "OK" yet
  `import <pkg>` fails in a plain `python` shell — only the venv-activated shell
  sees it. Same fix shape: ensure the install target and the interpreter's
  resolution path are the SAME location (one shared venv, `VIRTUAL_ENV` +
  `PATH` set at the image layer so every subprocess inherits it).
- **Node — `npm install --prefix` / `npm_config_prefix` vs global:** an inherited
  `npm_config_prefix` (or a stray `--prefix`) installs to a tree not on
  `NODE_PATH` / the global resolution path. The binary/module is on disk but
  `require()` / the global CLI can't find it. Same fix shape: unset the
  redirecting env var on the install path, or align the prefix with the resolver.

The lesson that generalizes: **when a dev-container overlay installs into a
tool that distinguishes isolated from shared install layouts, an inherited env
var is the silent redirector — unset it on the install path, or align the
install target with the runtime's default resolver.**

---

## Cross-template inheritance

- **Pattern A is host-OS-portable** (macOS + Linux dev hosts both benefit) and
  language-agnostic — the gpg-agent ABI gap is a host:OS concern, not a binding
  concern. It applies UNCHANGED to a Python-binding dev container, a Ruby one, or
  any template that ships GPG-signed commits from inside a container.
- **Pattern B is Ruby-specific at the surface** but its lesson (tool-isolated vs
  shared-env install defaults) generalizes per the "Generalizes to" subsection
  above. When a non-Ruby template lands a Docker dev environment, author the
  matching language's analog from that subsection rather than copying the Ruby
  fix verbatim.
