# Container-internal devcontainer home fixture (MUST pass clean)

Container-internal devcontainer user homes are NOT host operator homes —
they are the fixed non-root user the devcontainer base image ships, the
same across every consumer's container. Neither the py `dev` user nor the
rs `vscode` user carries operator/tenant identity, so the `operator-home-path`
shape MUST NOT flag them (the `/home/dev/` + `/home/vscode/` allowlist
entries). None of the following may flag.

py variant — fixed container user `dev` (uid/gid 1000), cache-volume targets:

    - uv-cache:/home/dev/.cache/uv
    target=/home/dev/.cache/uv

rs variant — fixed container user `vscode` (uid/gid 1000), host-CLI carry-in
mounts + the GPG side-mount prose (host SOURCE side uses `${HOME}`, never a
literal operator home):

    - ${HOME}/.claude:/home/vscode/.claude
    - ${HOME}/.codex:/home/vscode/.codex
    - ${HOME}/.gemini:/home/vscode/.gemini
    # SIDE-mounted (NOT at /home/vscode/.gnupg) read-only
    # a direct ${HOME}/.gnupg:/home/vscode/.gnupg mount leaks the host socket

These are in-container DESTINATION paths for the base-image-provided fixed
user — not a client codename, third-party org, or a real operator's host
home. A real operator home (`/home/<operator>/`) carries the operator's
actual username, fails the anchored `dev`/`vscode` prefixes, and still flags.
