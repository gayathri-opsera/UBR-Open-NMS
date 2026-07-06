# Runbook: Database Backup and Restore

**Audience:** Platform Engineering / DBA  
**Runbook URL:** https://runbooks.ubrnms.example.com/database-backup-restore

---

## MongoDB Backup

### On-demand backup

```bash
# Exec into the primary pod
kubectl exec -it mongodb-0 -n ubr-data -- \
  mongodump \
    --host rs0/mongodb-0.mongodb-headless.ubr-data:27017 \
    --username admin \
    --password "${MONGODB_ADMIN_PASSWORD}" \
    --authenticationDatabase admin \
    --out /tmp/dump-$(date +%Y%m%d%H%M)

# Copy dump to local machine
kubectl cp ubr-data/mongodb-0:/tmp/dump-<timestamp> ./backups/mongodb-<timestamp>
```

### Scheduled backup via CronJob (applied by Helm)

Backup runs daily at 02:00 UTC and uploads to object storage. Check status:

```bash
kubectl get cronjobs -n ubr-data
kubectl get jobs -n ubr-data --sort-by='.metadata.creationTimestamp' | tail -5
```

---

## MongoDB Restore

```bash
# Copy backup into the pod
kubectl cp ./backups/mongodb-<timestamp> ubr-data/mongodb-0:/tmp/restore

# Restore (will overwrite existing data)
kubectl exec -it mongodb-0 -n ubr-data -- \
  mongorestore \
    --host rs0/mongodb-0.mongodb-headless.ubr-data:27017 \
    --username admin \
    --password "${MONGODB_ADMIN_PASSWORD}" \
    --authenticationDatabase admin \
    --drop \
    /tmp/restore
```

---

## Redis Backup

Redis uses RDB snapshots (configured in `redis.conf`):

```bash
# Trigger manual save
kubectl exec -it redis-0 -n ubr-data -- redis-cli BGSAVE

# Check save status
kubectl exec -it redis-0 -n ubr-data -- redis-cli LASTSAVE

# Copy RDB file
kubectl cp ubr-data/redis-0:/data/dump.rdb ./backups/redis-$(date +%Y%m%d).rdb
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L2 Platform | @platform-oncall | Backup failure |
| L3 DBA | @dba-team | Data corruption / restore issues |
