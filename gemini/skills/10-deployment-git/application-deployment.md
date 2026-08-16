---
description: "Application deployment onboarding and runbook patterns. Use when /deploy --onboard is invoked or when creating deploy/deployment-config.md."
---

# Application Deployment

For applications that ship running code (containers, edge functions, VMs, k8s, mobile stores). Distinct from SDK release (PyPI/crates.io/npm), which uses `release-runbook.md`.

## When To Use

- `/deploy --onboard` is invoked and `deploy/deployment-config.md` does not exist
- Adding deployment to a project that has none
- Migrating between deployment platforms
- Auditing an existing `deployment-config.md` for completeness

## The Problem This Solves

The single most common deployment failure mode is "fix is committed but not deployed — production still running old bundle". Without a config-driven `/deploy` command and a state-tracking file, the agent has no way to know:

- What "production code" means in this repo
- How to query current deployed revision
- What gates must pass before shipping
- Whether HEAD is in sync with production

`deployment-config.md` answers all four questions explicitly, making `/deploy --check` and `/wrapup`'s drift detection possible.

## deployment-config.md Schema

Every application repo MUST have `deploy/deployment-config.md` with these sections. The YAML frontmatter is the machine-readable contract; the prose body is the human runbook.

```markdown
---
deploy:
  type: application # vs "sdk" — sdk repos use /release instead
  platform: <name> # azure-container-apps | cloud-run | fly | vercel | k8s | ec2 | other
  environment: production # or staging if this config is for a non-prod env

  # Files that constitute "production code" — drift in these triggers
  # /deploy --check warnings and /wrapup blocking.
  production_paths:
    - "src/**"
    - "frontend/**"
    - "Dockerfile"
    - "deploy/**"
    - "kubernetes/**"

  # Shell command to run the actual deploy.
  deploy_command: "bash deploy/scripts/deploy.sh"

  # Shell command that returns the currently-deployed commit SHA (or short hash).
  # Output should be a single line — the SHA or "unknown".
  deploy_check_command: |
    az containerapp revision list \
      --name <app-name> --resource-group <rg> \
      --query "[?properties.active][0].properties.template.revisionSuffix" \
      -o tsv

  # File where /deploy writes the deployed commit SHA on success.
  # /deploy --check reads this when the cloud query is unavailable.
  deploy_state_file: "deploy/.last-deployed"

  # Pre-deploy gates that MUST pass before deploy_command runs.
  # Each gate is { name, command, why }. Skipping requires --skip-gates + reason.
  gates:
    - name: tests
      command: "pytest tests/ -x --tb=short"
      why: "Catch regressions before they reach users"
    - name: lint
      command: "ruff check src/"
      why: "Block style violations from polluting production"
    - name: build
      command: "docker build -t app:test ."
      why: "Verify Dockerfile is valid before pushing to registry"

  # REQUIRED: live URL the user-visible check will fetch.
  live_url: "https://app.example.com"

  # REQUIRED: shell command that returns 0 ONLY if users are seeing the new code.
  # MUST fetch from outside the system (curl with no-cache headers) and verify
  # an externally-observable property — bundle hash, build SHA endpoint, version
  # header, etc. NEVER trust container logs or deploy command exit codes.
  user_visible_check: |
    LIVE_BUNDLE=$(curl -fsSL -H "Cache-Control: no-cache" -H "Pragma: no-cache" "$LIVE_URL" \
      | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
    EXPECTED_BUNDLE=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
    test -n "$EXPECTED_BUNDLE" || { echo "no expected bundle in dist/index.html"; exit 1; }
    test "$LIVE_BUNDLE" = "$EXPECTED_BUNDLE" || \
      { echo "STALE: live=$LIVE_BUNDLE expected=$EXPECTED_BUNDLE"; exit 1; }

  # Optional: shell command to invalidate caches if user_visible_check fails on first attempt.
  # Examples: aws cloudfront create-invalidation, wrangler purge, fastly purge, etc.
  cache_invalidation_command: |
    az cdn endpoint purge --resource-group rg-igai --profile-name cdn --name app \
      --content-paths '/*'

  # Optional: traffic check command for platforms with traffic splitting.
  # Returns 0 only if the new revision is receiving 100% of traffic (or whatever
  # percentage the deploy strategy declares).
  traffic_check_command: |
    az containerapp revision list --name app --resource-group rg-igai \
      --query "[?properties.trafficWeight==`100`].name" -o tsv | grep -q "$NEW_REVISION"

  # Optional smoke test run AFTER successful deploy AND user-visible check.
  smoke_test_command: |
    curl -fsSL https://api.example.com/healthz | grep -q '"ok":true'

  # Optional: paths that NEVER trigger deploy hygiene (test files, docs).
  ignore_paths:
    - "tests/**"
    - "docs/**"
    - "*.md"

  staging_required: false # if true, deploy_command first ships to staging
---

# Deployment Runbook

[Project-specific runbook content — platform setup, secrets, troubleshooting, rollback procedure]
```

## Onboarding Flow (Step-by-Step)

### Step 1: Detect Platform From Repo

Read these files in order; the first match wins:

| Indicator                                 | Platform              |
| ----------------------------------------- | --------------------- |
| `containerapps/`, `bicep/`, Azure CLI use | azure-container-apps  |
| `app.yaml`, `cloudbuild.yaml`             | google-cloud-run      |
| `fly.toml`                                | fly                   |
| `vercel.json`, `next.config.*` + Vercel   | vercel                |
| `kubernetes/`, `k8s/`, `helm/`            | k8s                   |
| `Dockerfile` + `docker-compose.prod.yml`  | docker-compose        |
| `Procfile` + Heroku CLI                   | heroku                |
| `serverless.yml`                          | serverless-framework  |
| `wrangler.toml`                           | cloudflare-workers    |
| `terraform/` + EC2 / VM resources         | terraform-managed-vms |

If multiple match, ASK the human which one is the production target — multi-platform setups are common (e.g., Cloud Run + Cloudflare for assets).

### Step 2: Ask Structured Questions

Required questions (block onboarding until answered):

1. **What command runs the production deploy?** (Existing script? Make target? Manual `gcloud run deploy ...`?)
2. **What query returns the currently-deployed commit?** (Cloud CLI command, container annotation lookup, deployed health endpoint exposing build SHA)
3. **What paths constitute "production code"?** (Defaults: `src/**`, `frontend/**`, `Dockerfile`, `deploy/**` — adjust to repo structure)
4. **What gates must pass before each deploy?** (Tests, lint, build, security scan — get the actual commands the project uses)
5. **Is staging required before production?** (If yes, `staging_required: true` and document the staging deploy command)

Optional (improve config quality):

6. Smoke test command? (Health endpoint, basic API call)
7. Rollback procedure? (Document in runbook body)
8. Secret/config management? (Where do env vars come from at deploy time?)
9. Notification on deploy success/failure? (Slack webhook, email, none)

### Step 3: Research Current Best Practices

Cloud platform CLIs change frequently — `az containerapp` flags in 2024 differ from 2025; `gcloud run` revision queries change syntax. Do **NOT** rely on encoded knowledge.

For the chosen platform, web search:

- Latest CLI version + breaking changes in last 12 months
- Recommended way to query "current production revision"
- Recommended way to roll back to a previous revision
- Common gotchas (e.g., Container Apps revision suffix conflicts, Cloud Run cold start during deploy)

### Step 4: Write deployment-config.md

Use the schema above. Fill in EVERY required field — never leave a placeholder. If a field is genuinely not applicable, document why in a comment within the frontmatter.

### Step 5: Validate the Config By Dry-Run

Before declaring onboarding complete:

1. Run `deploy_check_command` — should return a SHA or "unknown" without erroring
2. Run each gate command — verify they all pass on the current HEAD
3. Run `/deploy --check` — should produce a clear status output

If any of these fail, fix the underlying command in the config before proceeding.

### Step 6: Present to Human

STOP and present the full `deployment-config.md` for review. Walk through:

- Platform decision and why
- The deploy_command and what it does
- The drift detection mechanism
- Each gate and why it's there
- The runbook body

Wait for explicit approval before treating onboarding as complete.

## The Six Levels Of Deploy Failure (and how the schema catches each)

| Level | Failure                                                                        | Schema field / mechanism that catches it                          |
| ----- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| L1    | Code committed but never deployed                                              | `production_paths` + `/wrapup` deploy state check                 |
| L2    | Deploy command ran but new revision didn't take traffic                        | `traffic_check_command`                                           |
| L3    | New revision live, users still see old assets (cache, SW, etc.)                | `user_visible_check`                                              |
| L4    | Build "succeeded" by bypassing gates (`vite build` not `tsc -b && vite build`) | `gates` (declared build command must run as-is)                   |
| L5    | Dockerfile ships stale local `dist/` instead of rebuilding                     | Dockerfile lint in `gates` (forbid `COPY dist/`)                  |
| L6    | "BUILD SUCCEEDED" reported, no deploy ever ran                                 | `/deploy` Step 0–5 checklist (build/gates Step 2; execute Step 3) |

`user_visible_check` is critical for L3. The Step 0–5 `/deploy` checklist (see `commands/deploy.md`) is critical for L6 — it forbids reporting any partial step as completion.

The agent's repeated failure mode is treating "command exited 0" as evidence of "users see new code". None of the six layers' commands return non-zero on the failure they map to:

- L1: `git commit` returns 0 even though no deploy ran
- L2: `kubectl apply` returns 0 even if traffic stays on old revision
- L3: `docker restart` returns 0 even if CDN serves stale cache
- L4: `vite build` returns 0 even if `tsc` would have failed
- L5: `docker build` returns 0 even if it copies a 2-day-old `dist/`
- L6: `npm run build` returns 0 — and the agent reports this as deploy success while the freshly-built artifact sits on local disk untouched

Every layer needs its own external check. The Step 0–5 checklist exists because you cannot rely on any single command's exit code to mean what the agent thinks it means.

## Cache Layers To Check

When `user_visible_check` fails after a "successful" deploy, these are the layers in front of your origin that might be serving stale content. Check in this order:

1. **Cloud platform traffic split** — `az containerapp ingress traffic show`, `gcloud run services describe`, `kubectl get virtualservice`. New revision exists but old still gets traffic.
2. **Reverse proxy in front of origin** — nginx/Caddy/Traefik with internal cache
3. **CDN edge cache** — Cloudflare, CloudFront, Fastly, Azure CDN, Akamai. Use the platform's invalidation API in `cache_invalidation_command`.
4. **Browser HTTP cache** — wrong `Cache-Control` headers on HTML response. HTML should be `Cache-Control: no-cache, must-revalidate` so it always re-validates.
5. **Service worker / PWA cache** — old service worker holding the old bundle hash. May require service worker version bump.
6. **Build artifact mismatch** — `dist/index.html` references a JS hash that wasn't included in the deployed image. Re-run build, verify dist/ matches what was pushed.
7. **Sticky session affinity** — load balancer routing existing sessions to old pods/revisions even after the new one is live.

## Frontend Deployment Patterns (Vite, Docker, Next.js)

Frontend apps deploy in three common shapes. Each has different build outputs, bundle hash patterns, `user_visible_check` strategies, and `COPY` traps. The agent MUST detect which pattern is in use and use the matching verification.

### Detection

Read these in order; the first match determines the pattern:

| File / config                                              | Pattern                  | Build output        |
| ---------------------------------------------------------- | ------------------------ | ------------------- |
| `next.config.*` with `output: "standalone"`                | Next.js standalone (SSR) | `.next/standalone/` |
| `next.config.*` with `output: "export"`                    | Next.js static export    | `out/`              |
| `next.config.*` (default) + `vercel.json` or Vercel deploy | Next.js serverless       | `.next/` (Vercel)   |
| `next.config.*` (default), no Vercel                       | Next.js Node SSR         | `.next/`            |
| `vite.config.*` + `Dockerfile`                             | Vite + Docker            | `dist/`             |
| `vite.config.*` only                                       | Vite static SPA          | `dist/`             |

### Pattern A — Vite Static SPA

**Build:** `npm run build` (declared in `package.json`, typically `tsc -b && vite build`)
**Output:** `dist/index.html` referencing `dist/assets/index-[hash].js`
**Deploy targets:** S3+CloudFront, Cloudflare Pages, Netlify, GitHub Pages, nginx in container, any static host

```yaml
deploy:
  type: application
  platform: vite-static
  production_paths:
    ["src/**", "public/**", "index.html", "vite.config.*", "package.json"]
  deploy_command: "npm run build && bash deploy/upload.sh"
  user_visible_check: |
    LIVE=$(curl -fsSL -H "Cache-Control: no-cache" "$LIVE_URL")
    LIVE_HASH=$(echo "$LIVE" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
    EXPECTED=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' dist/index.html | head -1)
    test -n "$EXPECTED" || { echo "no expected hash in dist/index.html"; exit 1; }
    test "$LIVE_HASH" = "$EXPECTED" || { echo "STALE: live=$LIVE_HASH expected=$EXPECTED"; exit 1; }
```

**`COPY` trap:** Static hosts that serve from object storage need a fresh upload of `dist/`, but the agent MUST run `npm run build` immediately before the upload — never upload an old `dist/` from disk.

### Pattern B — Vite + Docker

**Build:** `npm run build` happens INSIDE the Dockerfile, NOT on the host
**Output:** Image with `dist/` baked in, served by nginx/Caddy/static-server
**Deploy targets:** Container Apps, Cloud Run, ECS, k8s, fly.io

```dockerfile
# DO: multi-stage, build inside Docker
FROM node:20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build              # ← runs the declared build, fails honestly on TS errors

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# DO NOT:
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/   # BLOCKED — ships stale local dist/
```

`user_visible_check` is identical to Pattern A — the bundle hash is in the deployed `index.html`.

### Pattern C — Next.js Standalone (Docker SSR)

**Config:** `next.config.js` has `output: "standalone"`
**Build:** `next build` produces `.next/standalone/` (Node server) and `.next/static/` (static assets)
**Deploy targets:** Container Apps, Cloud Run, ECS, k8s, fly.io
**Bundle hash:** lives in HTML as `_next/static/chunks/[name]-[hash].js`, AND there's a build ID in `.next/BUILD_ID`

```dockerfile
# DO: build inside Docker
FROM node:20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build              # produces .next/standalone/ and .next/static/

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
CMD ["node", "server.js"]

# DO NOT:
FROM node:20-slim
COPY .next/ ./.next/           # BLOCKED — ships stale local .next/
COPY out/ ./out/               # BLOCKED — same for static export
```

```yaml
deploy:
  type: application
  platform: next-standalone-container-apps
  production_paths:
    [
      "src/**",
      "app/**",
      "pages/**",
      "public/**",
      "next.config.*",
      "package.json",
    ]
  deploy_command: "bash deploy/scripts/deploy.sh"
  user_visible_check: |
    LIVE_BUILD_ID=$(curl -fsSL -H "Cache-Control: no-cache" "$LIVE_URL" \
      | grep -oE '"buildId":"[^"]+"' | head -1 | sed 's/.*:"//;s/"//')
    EXPECTED_BUILD_ID=$(cat .next/BUILD_ID)
    test -n "$EXPECTED_BUILD_ID" || { echo "no .next/BUILD_ID"; exit 1; }
    test "$LIVE_BUILD_ID" = "$EXPECTED_BUILD_ID" || \
      { echo "STALE: live=$LIVE_BUILD_ID expected=$EXPECTED_BUILD_ID"; exit 1; }
```

**Critical:** Next.js bakes the build ID into every page's HTML as `__NEXT_DATA__.buildId`. If the live build ID doesn't match `.next/BUILD_ID`, the deploy didn't reach users — period. This is more reliable than chunk hashes because Next.js may serve old chunks from CDN cache while still updating the HTML.

### Pattern D — Next.js Static Export

**Config:** `next.config.js` has `output: "export"`
**Build:** `next build` produces `out/` (pure static files, no Node server)
**Deploy targets:** Same as Pattern A (S3, Cloudflare Pages, nginx static, etc.)

```yaml
deploy:
  platform: next-export-static
  production_paths:
    ["src/**", "app/**", "pages/**", "public/**", "next.config.*"]
  deploy_command: "npm run build && bash deploy/upload-out.sh"
  user_visible_check: |
    LIVE=$(curl -fsSL -H "Cache-Control: no-cache" "$LIVE_URL")
    LIVE_CHUNK=$(echo "$LIVE" | grep -oE '_next/static/chunks/main-[A-Za-z0-9_-]+\.js' | head -1)
    EXPECTED=$(grep -oE '_next/static/chunks/main-[A-Za-z0-9_-]+\.js' out/index.html | head -1)
    test "$LIVE_CHUNK" = "$EXPECTED" || { echo "STALE: live=$LIVE_CHUNK expected=$EXPECTED"; exit 1; }
```

**`COPY` trap:** Same as Pattern A — never `COPY out/` from local disk into a container; always rebuild inside.

### Pattern E — Next.js on Vercel (Serverless)

**Config:** `next.config.js` (default) + project linked to Vercel
**Build:** Vercel runs `next build` server-side; you MUST NOT run `next build` locally and ship its output
**Deploy command:** `vercel deploy --prod` (or `vercel --prod`)
**Bundle hash:** same `__NEXT_DATA__.buildId` pattern as Pattern C

```yaml
deploy:
  platform: next-vercel
  production_paths:
    ["src/**", "app/**", "pages/**", "public/**", "next.config.*"]
  deploy_command: "vercel deploy --prod --yes"
  deploy_check_command: |
    vercel inspect "$LIVE_URL" --token "$VERCEL_TOKEN" 2>/dev/null \
      | grep -oE 'meta\.gitCommitSha[[:space:]]+[a-f0-9]+' | awk '{print $2}'
  user_visible_check: |
    LIVE_BUILD_ID=$(curl -fsSL -H "Cache-Control: no-cache" "$LIVE_URL" \
      | grep -oE '"buildId":"[^"]+"' | head -1 | sed 's/.*:"//;s/"//')
    DEPLOYED_SHA=$(vercel inspect "$LIVE_URL" --token "$VERCEL_TOKEN" 2>/dev/null \
      | grep -oE 'commit[[:space:]]+[a-f0-9]+' | awk '{print $2}')
    test "$DEPLOYED_SHA" = "$(git rev-parse HEAD)" || \
      { echo "STALE: vercel=$DEPLOYED_SHA HEAD=$(git rev-parse HEAD)"; exit 1; }
```

**Vercel-specific traps:**

- **Preview vs production** — `vercel deploy` (no `--prod`) creates a preview URL, NOT production. Must use `--prod` or production stays on the previous deployment.
- **Branch protection** — if the production branch is protected, only pushes to that branch trigger production deploys; manual `vercel deploy --prod` from a feature branch is rejected silently.
- **Build cache** — Vercel caches `node_modules` and `.next/cache`. A build can succeed locally but fail on Vercel due to the cached state. NEVER rely on local `next build` to predict Vercel build outcome.

### Quick Reference: Bundle Hash Detection By Framework

| Framework          | Build output      | Hash extraction grep                                           | Reference file            |
| ------------------ | ----------------- | -------------------------------------------------------------- | ------------------------- |
| Vite               | `dist/`           | `index-[A-Za-z0-9_-]+\.js`                                     | `dist/index.html`         |
| Next.js standalone | `.next/`          | `"buildId":"[^"]+"` (from `__NEXT_DATA__`)                     | `.next/BUILD_ID`          |
| Next.js export     | `out/`            | `_next/static/chunks/main-[A-Za-z0-9_-]+\.js`                  | `out/index.html`          |
| Next.js Vercel     | `.next/` (remote) | `"buildId":"[^"]+"` + `vercel inspect` for commit SHA          | `vercel inspect` output   |
| CRA (legacy React) | `build/`          | `static/js/main\.[A-Za-z0-9]+\.js`                             | `build/index.html`        |
| SvelteKit static   | `build/`          | `_app/immutable/entry/start\.[A-Za-z0-9_-]+\.js`               | `build/index.html`        |
| Astro              | `dist/`           | `_astro/[a-z]+\.[A-Za-z0-9_-]+\.js`                            | `dist/index.html`         |
| Remix              | `build/client/`   | `assets/root-[A-Za-z0-9_-]+\.js` (Vite-mode) or build manifest | `build/client/index.html` |

If your framework is missing from this table, the detection pattern is always the same:

1. After running the project's build command, find the output directory's main HTML file
2. Grep for the asset URL pattern that includes a content hash (look for hex/base64 strings of length ≥ 8)
3. The same grep against the live URL response is the `user_visible_check`

### Three `COPY` Traps To Refuse In Any Dockerfile

```dockerfile
# BLOCKED — Vite
COPY dist/ /usr/share/nginx/html/

# BLOCKED — Next.js
COPY .next/ ./.next/
COPY out/ ./

# BLOCKED — CRA
COPY build/ /usr/share/nginx/html/
```

The replacement is always the same: a multi-stage Dockerfile where the build runs `RUN npm run build` (or the declared build command) inside an early stage, and the final stage copies `--from=<build_stage>` so the artifacts are guaranteed to match the source tree at image-build time.

## Common Mistakes To Avoid

### 0. Treating "deploy command exited 0" as proof of "users see new code"

The single most common failure. The deploy command's exit code only tells you the deploy command finished — not that users are receiving the new code. ALWAYS run `user_visible_check` after every deploy. If `user_visible_check` is missing from a project's `deployment-config.md`, the config is incomplete.

### 1. Hardcoding project-specific paths in the global onboarding

The platform detection list above is a guide, not a rule. Each project's `production_paths` are project-specific — don't carry over paths from a previous onboarding.

### 2. Skipping the cloud CLI research step

Encoded knowledge of cloud CLIs is stale within months. Always web-search for the latest syntax of the deploy_check_command BEFORE writing it into the config.

### 3. Treating the runbook body as optional

The YAML frontmatter is what `/deploy` reads. The prose body is what the human reads when something breaks at 2 AM. Both are required.

### 4. Reusing a stale release-specialist agent configuration

If the project's `release-specialist` agent references EC2/promote.sh/docker-compose (a stale config from older template versions), that configuration is stale. Update it to match the new `deployment-config.md` BEFORE running `/deploy` — otherwise the agent's mental model contradicts the config.

## See Also

- `commands/deploy.md` — the command that consumes this config
- `rules/deploy-hygiene.md` — the "committed ≠ deployed" enforcement
- `skills/10-deployment-git/deployment-cloud.md` — platform-specific patterns
- `skills/10-deployment-git/release-runbook.md` — for SDK release (the OTHER deployment type)
