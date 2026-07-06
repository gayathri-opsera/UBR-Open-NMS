# Runbook: Kafka Topic Management

**Audience:** Platform Engineering  
**Runbook URL:** https://runbooks.ubrnms.example.com/kafka-topic-management

---

## Create a Topic

```bash
kubectl exec -it kafka-0 -n ubr-data -- kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --create \
  --topic <topic-name> \
  --partitions 12 \
  --replication-factor 3 \
  --config retention.ms=604800000 \
  --config min.insync.replicas=2
```

Standard topics and their settings:

| Topic | Partitions | Retention | Notes |
|-------|-----------|-----------|-------|
| `raw-alarms` | 12 | 7 days | High-throughput alarm events |
| `kpi-events` | 24 | 3 days | High-volume KPI data |
| `inventory-events` | 6 | 14 days | Device inventory changes |
| `netcool-alarms-forward` | 6 | 3 days | Netcool forwarder output |
| `mycom-kpi-forward` | 12 | 3 days | Mycom forwarder output |
| `mobinet-inventory-sync` | 6 | 7 days | Mobinet sync events |
| `operational-events` | 6 | 7 days | Syslog-bound events |
| `raw-alarms-dlq` | 3 | 30 days | Dead-letter queue |

---

## Delete a Topic

> **Warning:** Deleting a topic permanently removes all messages.

```bash
kubectl exec -it kafka-0 -n ubr-data -- kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --delete \
  --topic <topic-name>
```

---

## List Consumer Groups and Lag

```bash
# List all consumer groups
kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --list

# Show lag for a specific group
kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --group <consumer-group>
```

---

## Rebalance Partitions

```bash
# Generate reassignment plan
kubectl exec -it kafka-0 -n ubr-data -- kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --topics-to-move-json-file /tmp/topics.json \
  --broker-list "0,1,2" \
  --generate > /tmp/plan.json

# Execute reassignment
kubectl exec -it kafka-0 -n ubr-data -- kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file /tmp/plan.json \
  --execute

# Verify completion
kubectl exec -it kafka-0 -n ubr-data -- kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file /tmp/plan.json \
  --verify
```

---

## Reset Consumer Offset (replay messages)

```bash
# Dry-run first
kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group <consumer-group> \
  --topic <topic-name> \
  --reset-offsets --to-earliest --dry-run

# Execute (stop consumer first!)
kubectl scale deployment <service> -n ubr-platform --replicas=0
kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group <consumer-group> \
  --topic <topic-name> \
  --reset-offsets --to-earliest --execute
kubectl scale deployment <service> -n ubr-platform --replicas=<original>
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L2 Platform | @platform-oncall | Consumer lag > 100K |
| L3 Kafka Specialist | @kafka-team | Broker failure / data loss |
