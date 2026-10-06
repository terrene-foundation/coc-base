# build-repo-release-discipline — Extended Examples

Companion to `.claude/rules/build-repo-release-discipline.md`; full illustrative examples extracted verbatim.

## Rule 1 — Complete package enumeration

```bash
# DO — enumerate packages whose main > pypi, include all in the release scope
for pkg in kailash kailash-dataflow kailash-nexus kailash-kaizen kailash-mcp \
           kailash-ml kailash-align kailash-pact; do
  main_version=$(grep '^version' packages/$pkg/pyproject.toml 2>/dev/null | head -1 | cut -d'"' -f2)
  [ -z "$main_version" ] && main_version=$(grep '^version' pyproject.toml | head -1 | cut -d'"' -f2)
  pypi_version=$(curl -s https://pypi.org/pypi/$pkg/json | python -c 'import sys, json; print(json.load(sys.stdin)["info"]["version"])')
  if [ "$main_version" != "$pypi_version" ]; then
    echo "RELEASE NEEDED: $pkg main=$main_version pypi=$pypi_version"
  fi
done

# DO NOT — only release the package you touched
/release kailash-kaizen  # but kailash-ml main 0.17.0 > pypi 0.15.2 is left stale
```

## Rule 3 — Session release-scope example

```markdown
# DO — enumerate once, reference throughout

Release scope for this session (at session start, before first merge):
| Package | main | PyPI | Release needed? |
|-----------------|-------|-------|-----------------|
| kailash | 2.8.25| 2.8.11| YES (14 patches)|
| kailash-dataflow| 2.0.12| 2.0.12| NO |
| kailash-kaizen | 2.9.0 | 2.7.5 | YES (minor) |
| kailash-ml | 0.17.0| 0.15.2| YES (2 minors) |
| kailash-align | 0.4.0 | 0.3.2 | YES (minor) |
| kailash-pact | 0.9.0 | 0.8.2 | YES (minor) |

Release cycle at end of session: kailash + kaizen + ml + align + pact.

# DO NOT — derive release scope only for the PR's package at merge time
```

## Rule 5 — Mechanical version-anchor sweep

```bash
# DO — pre-merge mechanical sweep, run on every PR review
for pkg_dir in packages/*/; do
  pkg=$(basename "$pkg_dir")
  src_changed=$(git diff origin/main...HEAD -- "$pkg_dir/src/" --name-only | wc -l)
  ver_changed=$(git diff origin/main...HEAD -- "$pkg_dir/pyproject.toml" "$pkg_dir/src/*/__init__.py" \
    | grep -cE '^\+\s*(version|__version__)\s*=' )
  if [ "$src_changed" -gt 0 ] && [ "$ver_changed" -lt 2 ]; then
    echo "BLOCKED: $pkg src changed but version bump missing in same PR"
    exit 1
  fi
done

# DO NOT — defer the check to /release
# (Wave 4 PR #632 modified the mcp package directory src/.../auth/{providers,oauth}.py
#  but mcp pyproject stayed at 0.2.9. Caught only at /release-time enumeration,
#  required a separate fix-PR #634 to bump mcp 0.2.9 → 0.2.10. Net cost:
#  one extra PR, one extra CI cycle, one extra admin merge, ~15min of pacing.)
```
