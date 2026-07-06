# Runbook: Capacity Scaling (Manual HPA Adjustment)

**Audience:** Platform Engineering  
**Runbook URL:** https://runbooks.ubrnms.example.com/capacity-scaling

---

## When to Scale Manually

- Anticipated traffic spike (planned events, maintenance windows).
- HPA is enabled but is reacting too slowly.
- Load test or disaster recovery drill in progress.

---

## Scale a Service (Immediate)

```bash
# Scale up immediately (bypasses HPA temporarily)
kubectl scale deployment <service-name> -n ubr-platform --replicas=<count>

# Verify pods are running
kubectl rollout status deployment/<service-name> -n ubr-platform
kubectl get pods -n ubr-platform -l app.kubernetes.io/name=<service-name>
```

## Adjust HPA Limits Permanently

```bash
helm upgrade ubrnms-prod-<service> helm-charts/<service> \
  --set autoscaling.minReplicas=<min> \
  --set autoscaling.maxReplicas=<max> \
  --set autoscaling.targetCPUUtilizationPercentage=<target> \
  --reuse-values
```

## Reference Scaling Table

| Service | Normal Min | Normal Max | Storm Min | Storm Max |
|---------|-----------|-----------|-----------|-----------|
| alarm-service | 4 | 16 | 8 | 32 |
| event-collector | 6 | 20 | 12 | 40 |
| kpi-collector | 8 | 30 | 16 | 60 |
| kpi-aggregation-service | 4 | 12 | 8 | 24 |
| api-gateway | 2 | 10 | 4 | 20 |

## Retrieve Logs for Troubleshooting

```bash
# Follow live logs
kubectl logs -f -n ubr-platform -l app.kubernetes.io/name=<service> --max-log-requests=10

# Last N lines from all pods
kubectl logs -n ubr-platform -l app.kubernetes.io/name=<service> --tail=500

# Export to file
kubectl logs -n ubr-platform <pod-name> > /tmp/<service>-$(date +%Y%m%d%H%M).log

# Search across all pods for an error
kubectl logs -n ubr-platform -l app.kubernetes.io/name=<service> --tail=2000 \
  | grep -E "ERROR|CRITICAL|Exception" | sort | uniq -c | sort -rn
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L2 Platform | @platform-oncall | Cannot stabilize with scaling |
| L3 Infra | @infra-team | Node pool capacity exhausted |
