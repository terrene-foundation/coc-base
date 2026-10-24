#!/bin/bash
# Runs INSIDE the sandbox under test, cwd = a scratch repo. usage: probe.sh <generated.toml> <outside-dir>
# One line per attempt: ALLOWED <label> | REFUSED <label> :: <first 160 bytes of the error>, with the outside
# dir and the repo replaced by <outside>/<repo> FIRST — a long absolute path otherwise cut the quote short.
# The protected targets are every `"<path>" = "read"` entry of the generated profile, so the
# probe exercises exactly what the adapter emitted — nothing hand-listed.
TOML=$1; OUTSIDE=$2
try() {
  label=$1; shift
  if out=$("$@" 2>&1); then echo "ALLOWED $label"; else
    msg=$(printf '%s' "$out" | tr '\n' ' '); msg=${msg//"$OUTSIDE"/<outside>}; msg=${msg//"$PWD"/<repo>}
    echo "REFUSED $label :: $(printf '%s' "$msg" | head -c 160)"; fi
}
grep -E '^"[^/][^"]*" = "read"' "$TOML" | sed -E 's/^"([^"]*)".*/\1/' | while IFS= read -r p; do
  if [ -d "$p" ]; then try "protected:$p" sh -c "echo x > '$p/probe-new'"; else try "protected:$p" sh -c "echo x >> '$p'"; fi
done
try outside:sibling-dir           sh -c "echo x > '$OUTSIDE/probe'"
try benign:workspaces-write       sh -c 'echo x > workspaces/w.txt'
try benign:git-commit             sh -c 'echo y > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t commit -qm b'
try benign:mktemp                 sh -c 'd=$(mktemp -d) && echo x > "$d/f"'
