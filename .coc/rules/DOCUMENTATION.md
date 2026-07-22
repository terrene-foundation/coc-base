---
id: "DOCUMENTATION"
paths: ["README.md", "docs/**", "CHANGELOG.md"]
---

# Documentation Rules

## Version Numbers Must Match pyproject.toml

Update on version bump: `README.md`, `docs/index.rst`, `docs/getting_started.rst`, each package's README.

**Why:** Mismatched version numbers cause users to install the wrong version or doubt they have the correct package.

## Repository URLs

All GitHub URLs MUST point to `terrene-foundation/kailash-py` (the monorepo).

```
✅ https://github.com/terrene-foundation/kailash-py
❌ https://github.com/terrene-foundation/kailash-sdk
❌ https://github.com/terrene-foundation/kailash-kaizen
```

Clone: `git clone https://github.com/terrene-foundation/kailash-py.git`

**Why:** Wrong repo URLs send users to 404 pages or stale forks, destroying first-impression trust and blocking onboarding.

## MUST NOT

- Dead link references (paths that don't exist in repo)
- Placeholder URLs (`your-org`, `YOUR_USERNAME`) in production docs
- Internal domain names (`studio.kailash.ai`) — use `example.com`
- Internal project names or session references

**Why:** Dead links, placeholders, and internal references leak unprofessional artifacts into public-facing docs and may expose internal infrastructure details.

## Update Triggers

Review docs when: version bumped, repo restructured, package added/removed, URLs changed.

## Sphinx Build

`cd docs && python build_docs.py` must build without warnings on release.

**Why:** Sphinx warnings indicate broken cross-references, missing modules, or formatting errors that render as garbled output on the published docs site.
