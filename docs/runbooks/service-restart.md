# Runbook: Service Restart / Recovery

**Severity:** P2–P1 depending on service  
**Audience:** NOC / Platform Engineering  
**Runbook URL:** https://runbooks.ubrnms.example.com/service-restart

---

## Symptom

- Grafana alert `ServiceDown` fires for one or more microservices.
- Health check endpoint (`/healthz` or `/actuator/health`) returns non-2xx or times out.
- Dependent services report upstream errors.

---

## Diagnostic Steps

1. **Identify the affected service** from the alert label `job`.

2. **Check pod status in Kubernetes:**
   ```bash
   kubectl get pods -n ubr-platform -l app.kubernetes.io/name=<service-name>
   kubectl describe pod <pod-name> -n ubr-platform
   ```

3. **Review recent logs:**
   ```bash
   kubectl logs -n ubr-platform -l app.kubernetes.io/name=<service-name> --tail=200
   # For crash loops, check previous container:
   kubectl logs -n ubr-platform <pod-name> --previous --tail=200
   ```

4. **Check resource pressure:**
   ```bash
   kubectl top pods -n ubr-platform
   kubectl top nodes
   ```

5. **Check events for OOMKill or scheduling failures:**
   ```bash
   kubectl get events -n ubr-platform --sort-by='.lastTimestamp' | tail -30
   ```

---

## Resolution Steps

### Case A — Pod in CrashLoopBackOff

1. Identify root cause from logs (OOM, configuration error, dependency failure).
2. If OOM: temporarily increase memory limit via Helm:
   ```bash
   helm upgrade ubrnms-<env>-<service> helm-charts/<service> \
     --set resources.limits.memory=2Gi --reuse-values
   ```
3. If config error: update the relevant Secret or ConfigMap, then rollout restart:
   ```bash
   kubectl rollout restart deployment/<service-name> -n ubr-platform
   ```

### Case B — Pod stuck in Pending

1. Check for unschedulable nodes: `kubectl get nodes`
2. If node capacity is exhausted, scale node pool in the cloud console.
3. If PVC is unbound: `kubectl get pvc -n ubr-platform`

### Case C — Healthy pod but service returns errors

1. Check downstream dependencies (MongoDB, Kafka, Redis):
   ```bash
   kubectl exec -it <pod> -n ubr-platform -- curl -s http://localhost:8080/actuator/health | jq
   ```
2. If dependency issue, refer to the relevant runbook (MongoDB Failover, Kafka Management).

### Force Restart (last resort)

```bash
kubectl rollout restart deployment/<service-name> -n ubr-platform
kubectl rollout status deployment/<service-name> -n ubr-platform
```

---

## Verification

```bash
# Wait for deployment rollout
kubectl rollout status deployment/<service-name> -n ubr-platform

# Confirm health
curl -f https://api.<env>.ubrnms.example.com/api/v1/<service>/health

# Confirm alert resolved in Grafana within 2 minutes
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L1 NOC | #noc-alerts Slack | Alert fires |
| L2 Platform Engineering | @platform-oncall PagerDuty | No resolution after 15 min |
| L3 Service Owner | See CODEOWNERS | Root cause requires code change |
