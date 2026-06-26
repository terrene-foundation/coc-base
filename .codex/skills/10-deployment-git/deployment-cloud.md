# Cloud Deployment Principles

General principles for deploying to cloud providers. The agent MUST research current specifics via web search — this document covers stable concepts only.

## CLI Authentication (Stable)

The CLI authentication method is the stable interface to cloud providers. Always use SSO.

### AWS

```bash
# Configure SSO (one-time)
aws configure sso
# Login
aws sso login --profile <profile-name>
# Verify
aws sts get-caller-identity --profile <profile-name>
```

### Azure

```bash
# Login with browser
az login
# Set subscription
az account set --subscription <subscription-id>
# Verify
az account show
```

### GCP

```bash
# Login with browser
gcloud auth login
# Set project
gcloud config set project <project-id>
# Verify
gcloud auth list
```

## General Principles

### Managed vs Self-Hosted

| Factor              | Managed          | Self-Hosted         |
| ------------------- | ---------------- | ------------------- |
| Operational burden  | Low              | High                |
| Cost at small scale | Higher           | Lower               |
| Cost at large scale | Often higher     | Can optimize        |
| Patching/updates    | Provider handles | Your responsibility |
| Customization       | Limited          | Full control        |
| Backup/recovery     | Built-in         | Must configure      |

**Default recommendation**: Start managed, move to self-hosted only when cost or customization demands it.

### Right-Sizing

Before provisioning new resources:

1. Check for existing reserved instances or savings plans
2. Start with the smallest viable size
3. Monitor actual usage for 1-2 weeks
4. Right-size based on observed patterns
5. Consider spot/preemptible for non-production workloads

### SSL/TLS

- Use provider-managed certificates where possible (free, auto-renewed)
- AWS: ACM (free for use with ALB, CloudFront)
- Azure: App Service Managed Certificates, Azure Front Door
- GCP: Google-managed SSL certificates
- External: Let's Encrypt with certbot (free, auto-renewed)

### DNS

- Keep DNS with the cloud provider for simplest integration
- AWS: Route53
- Azure: Azure DNS
- GCP: Cloud DNS
- External: Cloudflare (also provides CDN, DDoS protection)

### Monitoring

Minimum production monitoring:

1. **Health checks** — automated endpoint checks, alert on failure
2. **Metrics** — CPU, memory, disk, request rate, error rate, latency
3. **Logging** — centralized, searchable, retained for compliance period
4. **Alerting** — route to on-call (email, Slack, PagerDuty)

### Security Baseline

1. **Secrets in secrets manager** — never in env vars on the host, never committed
2. **Least privilege IAM** — each service gets only the permissions it needs
3. **Network isolation** — private subnets for databases, public only for load balancers
4. **WAF** — consider for public-facing web applications
5. **Vulnerability scanning** — automated scanning of containers and dependencies
6. **Encryption at rest** — enable for all data stores

### Containerization

If deploying via Docker:

```dockerfile
# Multi-stage build for smaller images
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY . .

# Non-root user
RUN useradd -r appuser
USER appuser

# Health check (uses python since slim images don't include curl)
HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3000/health')" || exit 1

CMD ["python", "-m", "app.main"]
```

Essential `.dockerignore`:

```
.git
.env
__pycache__
*.pyc
.pytest_cache
node_modules
.venv
```

## What to Research Live

The agent should always research these before executing — they change frequently:

- Current instance type recommendations and pricing
- Current managed service tiers and features
- Current CLI command syntax and flags
- Region availability for specific services
- Current security best practices and compliance requirements
- Current IaC tool versions and syntax (Terraform, CDK, Pulumi)

Use `web search` and CLI `--help` rather than relying on trained knowledge.
