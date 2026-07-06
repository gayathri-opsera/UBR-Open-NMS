# UBR Open Network Management System — Documentation

## Contents

- [Developer Onboarding Guide](onboarding.md)
- [API Documentation](api/index.html) (OpenAPI / Swagger UI)
- [Architecture Decision Records](adr/decisions.md)

### Operational Runbooks

| Runbook | When to Use |
|---------|-------------|
| [Service Restart / Recovery](runbooks/service-restart.md) | Pod is down, CrashLoopBackOff, 5xx errors |
| [MongoDB Failover](runbooks/mongodb-failover.md) | Primary unreachable, replication lag |
| [Kafka Topic Management](runbooks/kafka-topic-management.md) | Create/delete topics, reset offsets, rebalance |
| [Alarm Storm Handling](runbooks/alarm-storm.md) | Consumer lag critical, alarm rate spike |
| [Capacity Scaling](runbooks/capacity-scaling.md) | Pre-scale for events, log retrieval |
| [Certificate Rotation](runbooks/certificate-rotation.md) | TLS expiry, JWT secret rotation |
| [Database Backup / Restore](runbooks/database-backup-restore.md) | Scheduled and on-demand backup/restore |
