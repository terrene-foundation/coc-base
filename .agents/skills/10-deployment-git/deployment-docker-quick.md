---
name: deployment-docker-quick
description: "Docker deployment quick start. Use when asking 'docker deployment', 'containerize kailash', or 'docker setup'."
---

# Docker Deployment Quick Start

> **Skill Metadata**
> Category: `deployment`
> Priority: `HIGH`
> SDK Version: `0.9.25+`

## Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Create non-root user
RUN useradd -r appuser
USER appuser

# Expose API port
EXPOSE 8000

# Kailash runtime configuration
ENV RUNTIME_TYPE=async

# Health check using python (curl not available on slim images)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=40s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run with async runtime (Docker-optimized)
CMD ["python", "app.py"]
```

## Application Setup

```python
# app.py
import os
from kailash.api.workflow_api import WorkflowAPI
from kailash.workflow.builder import WorkflowBuilder

workflow = WorkflowBuilder()
workflow.add_node("LLMNode", "chat", {
    "provider": "openai",
    "model": os.environ.get("LLM_MODEL", "gpt-4"),
    "prompt": "{{input.message}}"
})

# WorkflowAPI defaults to AsyncLocalRuntime (Docker-optimized)
api = WorkflowAPI(workflow.build())
api.run(host="0.0.0.0", port=8000)
```

## Build and Run

```bash
# Build image
docker build -t my-kailash-app .

# Run container
docker run -p 8000:8000 \
  -e OPENAI_API_KEY=${OPENAI_API_KEY} \
  my-kailash-app

# Access API
curl http://localhost:8000/health
```

## Docker Compose

```yaml
services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - DATABASE_URL=postgresql://user:${DB_PASSWORD}@db:5432/mydb
      - RUNTIME_TYPE=async
    depends_on:
      - db

  db:
    image: postgres:15
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=mydb
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

```bash
# Run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f app
```

## Production Considerations

1. **Use AsyncLocalRuntime** - Default in WorkflowAPI
2. **Environment variables** - For secrets
3. **Health checks** - `/health` endpoint
4. **Multi-stage builds** - Smaller images
5. **Non-root user** - Security best practice
6. **Volume mounts** - For persistent data

<!-- Trigger Keywords: docker deployment, containerize kailash, docker setup, kailash docker -->
