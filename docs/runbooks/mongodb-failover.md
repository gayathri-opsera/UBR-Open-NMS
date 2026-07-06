# Runbook: MongoDB Failover

**Severity:** P1 (data-path impact)  
**Audience:** Platform Engineering / DBA  
**Runbook URL:** https://runbooks.ubrnms.example.com/mongodb-failover

---

## Symptom

- Alert `MongoDBReplicationLag` fires (lag > 30 seconds).
- Services report `MongoTimeoutException` or connection failures.
- Primary replica is unreachable.

---

## Diagnostic Steps

1. **Connect to the replica set:**
   ```bash
   kubectl exec -it mongodb-0 -n ubr-data -- mongosh --eval "rs.status()"
   ```

2. **Identify current primary:**
   ```bash
   kubectl exec -it mongodb-0 -n ubr-data -- mongosh --eval \
     "rs.status().members.filter(m => m.stateStr === 'PRIMARY')"
   ```

3. **Check replication lag:**
   ```bash
   kubectl exec -it mongodb-0 -n ubr-data -- mongosh --eval \
     "rs.printSecondaryReplicationInfo()"
   ```

4. **Check oplog window:**
   ```bash
   kubectl exec -it mongodb-0 -n ubr-data -- mongosh --eval "rs.printReplicationInfo()"
   ```

---

## Resolution Steps

### Case A — Primary unreachable, automatic election pending

MongoDB replica sets elect a new primary automatically within ~10 seconds. Monitor:
```bash
watch -n2 "kubectl exec -it mongodb-0 -n ubr-data -- mongosh --quiet --eval \"rs.isMaster().primary\""
```

If election does not complete after 30 seconds, proceed to Case B.

### Case B — Force manual stepdown / election

```bash
# Connect to the primary
kubectl exec -it <primary-pod> -n ubr-data -- mongosh --eval "rs.stepDown()"
```

### Case C — Primary pod is down, no quorum

1. Identify the most up-to-date secondary:
   ```bash
   kubectl exec -it mongodb-1 -n ubr-data -- mongosh --eval \
     "rs.status().members.sort((a,b) => b.optime.ts - a.optime.ts)[0]"
   ```

2. Force reconfiguration (data-loss risk — use only in disaster):
   ```bash
   kubectl exec -it <best-secondary> -n ubr-data -- mongosh --eval \
     "rs.reconfig({_id:'rs0', members:[{_id:0, host:'mongodb-0.mongodb-headless.ubr-data:27017', priority:1}]}, {force:true})"
   ```

3. Restart crashed primary pod:
   ```bash
   kubectl delete pod mongodb-0 -n ubr-data
   kubectl rollout status statefulset/mongodb -n ubr-data
   ```

4. Re-add secondary members:
   ```bash
   kubectl exec -it mongodb-0 -n ubr-data -- mongosh --eval \
     "rs.add('mongodb-1.mongodb-headless.ubr-data:27017')"
   ```

---

## Verification

```bash
# Confirm PRIMARY is elected
kubectl exec -it mongodb-0 -n ubr-data -- mongosh --quiet --eval "rs.isMaster().ismaster"

# Confirm write succeeds
kubectl exec -it mongodb-0 -n ubr-data -- mongosh ubrnms --eval \
  "db.healthcheck.insertOne({ts: new Date()}); db.healthcheck.deleteOne({ts: {'\$type': 'date'}})"

# Check Grafana: MongoDBReplicationLag alert resolves
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L2 Platform | @platform-oncall | Alert fires |
| L3 DBA | @dba-team | Data consistency concerns |
| MongoDB Support | support.mongodb.com | Replication corruption |
