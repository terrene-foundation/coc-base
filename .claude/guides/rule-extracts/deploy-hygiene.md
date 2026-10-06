# deploy-hygiene — Extended Examples

Companion to `.claude/rules/deploy-hygiene.md`; full illustrative examples extracted verbatim.

## Rule 11 — Cancel superseded deploys with SSH keep-alives

```yaml
# DO — cancel in-progress, ssh keep-alive
concurrency:
  group: auto-deploy-${{ github.ref_name }}
  cancel-in-progress: true

steps:
  - name: Deploy
    run: |
      ssh -i ~/.ssh/deploy_key.pem \
        -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
        ubuntu@$DEPLOY_HOST bash <<'REMOTE'
        cd ~/app && git pull && \
        docker compose -f docker-compose.prod.yml up -d
      REMOTE

# DO NOT — queue every deploy; waste a full build cycle per superseded merge
concurrency:
  group: auto-deploy-main
  cancel-in-progress: false # BLOCKED on idempotent deploy workflows
# OR — concurrency block omitted entirely (defaults to no cancellation)
```

## Rule 11 — Documented non-idempotent exception

```yaml
# DO — exception with explicit audit comment
concurrency:
  group: prod-migrate-${{ github.ref_name }}
  # cancel-in-progress: false because Step 3 (`alembic upgrade head`) is
  # non-transactional for SQLite production; a cancelled migration leaves
  # the schema in a half-applied state that the next run cannot detect.
  cancel-in-progress: false

# DO NOT — exception with no comment
concurrency:
  group: prod-migrate-main
  cancel-in-progress: false # ← which step is non-idempotent? unaudited.
```
