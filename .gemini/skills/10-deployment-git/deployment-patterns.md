---
name: deployment-patterns
description: "Docker and Kubernetes deployment patterns for containerized applications. Use for 'Docker Compose', 'Kubernetes deployment', 'container orchestration', 'health checks', or 'secrets management'."
---

# Deployment Patterns

## Docker Compose Service Architecture

```yaml
services:
  backend:
    build:
      context: .
      dockerfile: docker/Dockerfile.backend
      target: ${BUILD_TARGET:-production}
    container_name: ${PROJECT_NAME}_backend
    environment:
      - DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      - REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0
      - JWT_SECRET_KEY=${JWT_SECRET_KEY}
    ports: ["${BACKEND_PORT:-8000}:8000"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    networks: [app_frontend, app_backend]
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: "4", memory: 8G }
        reservations: { cpus: "2", memory: 4G }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [postgres_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [app_backend]
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes: [redis_data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [app_backend]
    restart: unless-stopped
    command: >
      redis-server --appendonly yes --maxmemory 1gb
      --maxmemory-policy allkeys-lru --requirepass ${REDIS_PASSWORD}

volumes:
  postgres_data:
  redis_data:

networks:
  app_frontend:
  app_backend:
    internal: true
```

## Environment Configuration Template

```bash
# ==============================================================================
# APPLICATION
# ==============================================================================
ENVIRONMENT=production
DEBUG=false
BUILD_TARGET=production

# ==============================================================================
# DATABASE (PostgreSQL)
# ==============================================================================
POSTGRES_DB=app_db
POSTGRES_USER=app_user
POSTGRES_PASSWORD=change_this_to_secure_password
POSTGRES_PORT=5432
DATABASE_POOL_SIZE=20
DATABASE_MAX_OVERFLOW=40
DATABASE_POOL_TIMEOUT=30

# ==============================================================================
# REDIS
# ==============================================================================
REDIS_PASSWORD=change_this_to_secure_redis_password
REDIS_PORT=6379
REDIS_EXPIRE_SECONDS=7200
REDIS_MAX_CONNECTIONS=50

# ==============================================================================
# AUTHENTICATION
# ==============================================================================
# Generate with: openssl rand -hex 32
JWT_SECRET_KEY=change_this_to_a_secure_random_key_minimum_32_characters
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=480

# ==============================================================================
# CORS / FRONTEND
# ==============================================================================
CORS_ORIGINS=http://localhost:3000,https://app.yourdomain.com
FRONTEND_URL=https://app.yourdomain.com

# ==============================================================================
# PORTS
# ==============================================================================
BACKEND_PORT=8000
FRONTEND_PORT=3000

# SECURITY: Never commit .env. Use secrets manager in production. Rotate regularly.
```

## Secret Generation

```bash
openssl rand -hex 32   # JWT secret (64 hex chars)
openssl rand -hex 16   # Database/Redis passwords
openssl rand -base64 24  # Strong alphanumeric (24 chars)
```

## Kubernetes Backend Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  replicas: 3
  selector: { matchLabels: { app: backend } }
  template:
    metadata: { labels: { app: backend } }
    spec:
      containers:
        - name: backend
          image: your-registry/backend:latest
          ports: [{ containerPort: 8000 }]
          env:
            - name: DATABASE_URL
              valueFrom:
                { secretKeyRef: { name: app-secrets, key: database-url } }
            - name: JWT_SECRET_KEY
              valueFrom:
                { secretKeyRef: { name: app-secrets, key: jwt-secret } }
          envFrom: [{ configMapRef: { name: app-config } }]
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits: { cpu: 2000m, memory: 4Gi }
          livenessProbe:
            httpGet: { path: /health, port: 8000 }
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /ready, port: 8000 }
            initialDelaySeconds: 10
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata: { name: backend-service }
spec:
  selector: { app: backend }
  ports: [{ protocol: TCP, port: 8000, targetPort: 8000 }]
  type: ClusterIP
```

## PostgreSQL StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    spec:
      containers:
        - name: postgres
          image: postgres:15-alpine
          ports: [{ containerPort: 5432 }]
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                { secretKeyRef: { name: app-secrets, key: postgres-password } }
          volumeMounts:
            [{ name: postgres-storage, mountPath: /var/lib/postgresql/data }]
          resources:
            requests: { cpu: 500m, memory: 2Gi }
            limits: { cpu: 2000m, memory: 4Gi }
  volumeClaimTemplates:
    - metadata: { name: postgres-storage }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 50Gi } }
```

## HPA

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: backend-hpa }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: backend }
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
    - type: Resource
      resource:
        { name: memory, target: { type: Utilization, averageUtilization: 80 } }
```

## ConfigMap and Secrets

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: app-config }
data:
  ENVIRONMENT: "production"
  LOG_LEVEL: "INFO"
---
apiVersion: v1
kind: Secret
metadata: { name: app-secrets }
type: Opaque
# Prefer: kubectl create secret generic app-secrets --from-literal=database-url="..." --from-literal=jwt-secret="..."
```

## Health Check Endpoints

```python
from nexus import Nexus
from nexus.http import JSONResponse, status

app = Nexus()

@app.get("/health", status_code=status.HTTP_200_OK)
async def health_check():
    return {"status": "healthy"}

@app.get("/ready", status_code=status.HTTP_200_OK)
async def readiness_check():
    try:
        await db.execute("SELECT 1")
        await redis.ping()
        return {"status": "ready"}
    except Exception:
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"status": "not ready"})
```

## Deployment Workflows

```bash
# Docker Compose setup
cp .env.example .env
sed -i "s/change_this_jwt/$(openssl rand -hex 32)/" .env
docker-compose up -d && docker-compose ps

# Kubernetes deployment
kubectl create namespace production
kubectl create secret generic app-secrets \
  --from-literal=database-url="postgresql://..." \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" -n production
kubectl apply -f k8s/ -n production

# Rolling update (zero downtime)
kubectl set image deployment/backend backend=your-registry/backend:v2.0.0 -n production
kubectl rollout status deployment/backend -n production
kubectl rollout undo deployment/backend -n production  # Rollback
```

## Troubleshooting

```bash
docker-compose logs -f backend                           # Container logs
kubectl logs -f deployment/backend -n production         # K8s logs
docker-compose exec backend env | grep DATABASE_URL      # Verify env vars
docker stats                                             # Resource usage
kubectl top pods -n production
```
