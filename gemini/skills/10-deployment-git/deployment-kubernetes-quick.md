---
name: deployment-kubernetes-quick
description: "Kubernetes deployment basics. Use when asking 'kubernetes deployment', 'k8s kailash', or 'kubernetes setup'."
---

# Kubernetes Deployment Quick Start

> **Skill Metadata**
> Category: `deployment`
> Priority: `LOW`
> SDK Version: `0.9.25+`

## Kubernetes Manifests

### Deployment
```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kailash-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: kailash-app
  template:
    metadata:
      labels:
        app: kailash-app
    spec:
      containers:
      - name: app
        image: my-kailash-app:latest
        ports:
        - containerPort: 8000
        env:
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: kailash-secrets
              key: openai-api-key
        - name: DATABASE_URL
          valueFrom:
            configMapKeyRef:
              name: kailash-config
              key: database-url
        - name: RUNTIME_TYPE
          value: "async"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
```

### Service
```yaml
# service.yaml
# Note: LoadBalancer type requires a cloud provider (AWS, GCP, Azure).
# For local/on-prem, use NodePort or ClusterIP with an Ingress controller.
apiVersion: v1
kind: Service
metadata:
  name: kailash-app
spec:
  type: LoadBalancer
  selector:
    app: kailash-app
  ports:
  - port: 80
    targetPort: 8000
```

### ConfigMap
```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kailash-config
data:
  database-url: postgresql://user@db:5432/mydb
```

### Secret

> **Recommended**: Use `kubectl create secret generic` instead of manually base64-encoding values:
> ```bash
> kubectl create secret generic kailash-secrets \
>   --from-literal=openai-api-key="sk-your-key-here"
> ```

```yaml
# secret.yaml — if you must use a manifest, values must be base64-encoded
apiVersion: v1
kind: Secret
metadata:
  name: kailash-secrets
type: Opaque
data:
  openai-api-key: <base64-encoded-key>
```

## Deployment Commands

```bash
# Apply manifests
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secret.yaml

# Check status
kubectl get pods
kubectl get services

# View logs
kubectl logs -f deployment/kailash-app

# Scale replicas
kubectl scale deployment kailash-app --replicas=5
```

## Best Practices

1. **Health checks** - Liveness and readiness probes
2. **Resource limits** - Set memory/CPU limits
3. **Secrets** - Use Kubernetes secrets for sensitive data
4. **ConfigMaps** - For configuration
5. **Horizontal scaling** - Multiple replicas
6. **Rolling updates** - Zero-downtime deployments

<!-- Trigger Keywords: kubernetes deployment, k8s kailash, kubernetes setup, k8s workflows -->
