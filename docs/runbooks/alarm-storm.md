# Runbook: Alarm Storm Handling

**Severity:** P1  
**Audience:** NOC / Platform Engineering  
**Runbook URL:** https://runbooks.ubrnms.example.com/alarm-storm

---

## Symptom

- Alert `KafkaConsumerLagCritical` fires on `raw-alarms` topic.
- Alarm rate in NOC dashboard exceeds 1,000 alarms/minute.
- Alarm service CPU and memory spike.
- Netcool/Mycom forwarding falls behind.

---

## Diagnostic Steps

1. **Measure current alarm ingest rate:**
   ```bash
   kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
     --bootstrap-server localhost:9092 \
     --describe --group alarm-service-group
   ```

2. **Identify the source of the storm** (check event collector logs):
   ```bash
   kubectl logs -n ubr-platform -l app.kubernetes.io/name=event-collector \
     --tail=500 | grep -E "agentAddr|enterprise" | sort | uniq -c | sort -rn | head -20
   ```

3. **Check which device/subnet is generating excess events:**
   ```bash
   kubectl exec -it <alarm-service-pod> -n ubr-platform -- \
     curl -s localhost:8080/api/v1/alarms/stats?groupBy=deviceId | jq '.[0:10]'
   ```

---

## Resolution Steps

### Step 1 — Scale up alarm service

```bash
kubectl scale deployment alarm-service -n ubr-platform --replicas=12
kubectl scale deployment event-collector -n ubr-platform --replicas=20
```

### Step 2 — Apply rate limiting on event collector

```bash
kubectl set env deployment/event-collector -n ubr-platform \
  TRAP_RATE_LIMIT_PER_IP=100 \
  TRAP_RATE_LIMIT_WINDOW_MS=1000
kubectl rollout restart deployment/event-collector -n ubr-platform
```

### Step 3 — Block storm source temporarily (if single device)

```bash
# Add IP to blocklist ConfigMap
kubectl edit configmap event-collector-blocklist -n ubr-platform
# Add device IP to 'blockedSources' array, save, then reload:
kubectl rollout restart deployment/event-collector -n ubr-platform
```

### Step 4 — Increase Kafka consumer parallelism

```bash
# Increase partition consumers for alarm-service group
helm upgrade ubrnms-prod-alarm-service helm-charts/alarm-service \
  --set env.KAFKA_CONCURRENCY=12 --reuse-values
```

### Step 5 — After storm subsides, scale back down

```bash
kubectl scale deployment alarm-service -n ubr-platform --replicas=4
kubectl scale deployment event-collector -n ubr-platform --replicas=6
# Remove IP blocklist entries
```

---

## Verification

```bash
# Lag should return to < 10K within 10 minutes of scaling
kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe --group alarm-service-group | grep raw-alarms
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L1 NOC | #noc-alerts-critical | Storm detected |
| L2 Platform | @platform-oncall | Cannot contain within 15 min |
| L3 Network Ops | @network-team | Storm originates from customer network |
