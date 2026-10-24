#!/bin/bash
# Measure codex-cli sandbox behaviour for the S3 adapter (guard foundation).
# usage: measure.sh <lane WT> <out dir>
# Writes ONLY under <out dir> (scratch repos, scratch CODEX_HOMEs, measure.log, codex-measured.json) and the
# harness's .outside-probe dir (removed on exit). Never ~/.codex. The receipt is derived from the log by
# receipt.mjs; copy <out dir>/codex-measured.json to adapters/ after reading it.
# `codex sandbox` (0.162.1) REQUIRES --permission-profile, so every sandboxed mode names one;
# whether `default_permissions` applies WITHOUT -P cannot be observed through this subcommand.
set -u
WT=$1; OUT=$(cd "$2" && pwd -P); HERE=$(cd "$(dirname "$0")" && pwd -P)
PROBE="$HERE/probe.sh"
OUTSIDE="$HERE/.outside-probe"; trap 'rm -rf "$HERE/.outside-probe"' EXIT  # top level: an EXIT trap set inside the piped main never fired
main() {
codex --version
TMPROOT=$(cd "${TMPDIR:-/tmp}" && pwd -P)
node "$WT/.claude/hooks/lib/guard-foundation/adapters/codex.mjs" render --tmp "$TMPROOT" > "$OUT/generated.toml" || { echo "GENERATOR FAILED"; exit 2; }
echo "== generated.toml"; cat "$OUT/generated.toml"
# OUTSIDE must lie outside every root :workspace makes writable — NOT under /tmp or TMPDIR,
# which :workspace allows (measured: a /tmp sibling stayed writable under the profile). The
# harness's own directory in the lane checkout is outside the scratch repo; removed on exit.
mkdir -p "$OUTSIDE"

mk_repo() { # every protected read entry exists in the repo, so a refusal is about the write, not ENOENT
  local r; r=$(mktemp -d "$OUT/repo.XXXXXX"); r=$(cd "$r" && pwd -P)
  git -C "$r" init -q; mkdir -p "$r/workspaces" "$r/.claude/hooks"; echo a > "$r/.claude/hooks/a.js"
  grep -E '^"[^/][^"]*" = "read"' "$OUT/generated.toml" | sed -E 's/^"([^"]*)".*/\1/' | while IFS= read -r p; do
    [ -e "$r/$p" ] && continue; mkdir -p "$(dirname "$r/$p")"; echo '{}' > "$r/$p"
  done
  git -C "$r" add -A && git -C "$r" -c user.email=t@t -c user.name=t commit -qm init; echo "$r"
}
mk_home() { local h; h=$(mktemp -d "$OUT/codexhome.XXXXXX"); (cd "$h" && pwd -P); }
variant() { # <name> <sed expression> -> a profile with one line removed
  sed -E "$2" "$OUT/generated.toml" > "$OUT/$1.toml"; cmp -s "$OUT/$1.toml" "$OUT/generated.toml" && { echo "VARIANT $1 DID NOT CHANGE THE PROFILE"; exit 3; }; echo "$OUT/$1.toml"
}
run_mode() { # <name> <toml or ''> <layer user|project> <profile>
  local name=$1 toml=$2 layer=$3 prof=$4 h r; h=$(mk_home); r=$(mk_repo)
  if [ "$layer" = user ]; then [ -n "$toml" ] && cp "$toml" "$h/config.toml"
  else mkdir -p "$r/.codex"; [ -n "$toml" ] && cp "$toml" "$r/.codex/config.toml"; printf '[projects.%s]\ntrust_level = "trusted"\n' "\"$r\"" > "$h/config.toml"; fi
  echo "== MODE $name (layer=$layer profile=$prof)"
  ( cd "$r" && CODEX_HOME="$h" codex sandbox -C "$r" -P "$prof" -- bash "$PROBE" "$OUT/generated.toml" "$OUTSIDE" 2>&1 ); echo "   sandbox-exit=$?"
  echo "   ground truth outside the sandbox: commits=$(git -C "$r" rev-list --count HEAD) status:"; git -C "$r" status --porcelain | sed 's/^/     /'
}

R=$(mk_repo); echo "== MODE M0-no-sandbox"; ( cd "$R" && bash "$PROBE" "$OUT/generated.toml" "$OUTSIDE" ); rm -f "$OUTSIDE/probe"
run_mode M2-user-layer       "$OUT/generated.toml" user    loom-guard;  rm -f "$OUTSIDE/probe"
run_mode M3-project-layer    "$OUT/generated.toml" project loom-guard;  rm -f "$OUTSIDE/probe"
run_mode M4-builtin-workspace ""                    user    :workspace;  rm -f "$OUTSIDE/probe"
run_mode M5-no-git-reopen    "$(variant no-git-reopen '/^"\.git" = "write"/d')"         user loom-guard; rm -f "$OUTSIDE/probe"
run_mode M6-no-read-entries  "$(variant no-read-entries '/^"[^/][^"]*" = "read"/d')"      user loom-guard; rm -f "$OUTSIDE/probe"
run_mode M7-no-tmp-write     "$(variant no-tmp-write '/^"\/[^"]*" = "write"/d')"         user loom-guard; rm -f "$OUTSIDE/probe"
run_mode M8-no-extends       "$(variant no-extends '/^extends = /d')"                   user loom-guard; rm -f "$OUTSIDE/probe"
echo "== DONE"
}
main 2>&1 | tee "$OUT/measure.log"
node "$HERE/receipt.mjs" "$OUT/measure.log" "$HERE" "$OUT" > "$OUT/codex-measured.json"; echo "receipt-exit=$?"
