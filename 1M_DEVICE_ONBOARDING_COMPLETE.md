# UBR Open NMS: 1 Million Device Onboarding Strategy
## Comprehensive Architecture, Scalability & Deployment Framework

**Document Version:** 2.0
**Date:** July 2026
**Classification:** Internal - Production Readiness Review
**Target Scale:** 1,000,000 Devices

---

## Executive Summary

This document provides a comprehensive strategy for onboarding 1 million network devices into the UBR Open NMS platform. Based on detailed codebase analysis, we have identified critical architectural bottlenecks, required infrastructure changes, and a phased onboarding approach with wave planning, automation, validation frameworks, and regulatory compliance.

**Key Findings:**
- **Current Capacity:** 500 devices (tested), ~5,000 devices (theoretical maximum with current architecture)
- **Gap to Target:** 200x scale-up required
- **Critical Bottlenecks:** 10 identified (database queries, Kafka partitions, SNMP polling, cache strategy)

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Architecture Review](#2-architecture-review)
3. [Critical Bottlenecks](#3-critical-bottlenecks)
4. [Database Architecture for 1M Devices](#4-database-architecture-for-1m-devices)
5. [Application Scaling Strategy](#5-application-scaling-strategy)
6. [High Availability & Disaster Recovery](#6-high-availability--disaster-recovery)
7. [Environment Readiness](#7-environment-readiness)
8. [Onboarding Process Framework](#8-onboarding-process-framework)
9. [Wave Planning & Execution](#9-wave-planning--execution)
10. [Automation & Testing Strategy](#10-automation--testing-strategy)
11. [Regulatory Audit & Compliance](#11-regulatory-audit--compliance)
12. [Monitoring & Reporting](#12-monitoring--reporting)
13. [AI Enablement](#13-ai-enablement)
14. [Implementation Roadmap](#14-implementation-roadmap)
15. [Risk Assessment](#15-risk-assessment)

---

# 1. CURRENT STATE ANALYSIS

## 1.1 Current Capacity vs 1M Device Requirements

### Gap Analysis

| Metric | Current Capacity | Required for 1M | Gap | Status |
|--------|-----------------|-----------------|-----|--------|
| **Tested Devices** | 500 | 1,000,000 | 2,000x | ⚠️ Critical Gap |
| **SNMP Poll Time** | 5 min (500 devices) | 5 min (1M devices) | 2,000x concurrency needed | ❌ Bottleneck |
| **Database Size** | 10 GB | 5 TB+ | 500x | ⚠️ Needs Sharding |
| **API Response Time** | 200ms | 150ms (target) | Performance improvement needed | ⚠️ |
| **Kafka Partitions** | 3 | 100-150 | 33x-50x | ❌ Critical |
| **Pod Replicas** | 30 max | 200-300 | 6x-10x | ⚠️ |
| **MongoDB Architecture** | Single replica set | 3-shard cluster | Architecture change | ❌ Critical |
| **ScyllaDB** | Not implemented | 15-node cluster | New component | ❌ Critical |

**Verdict:** Current architecture can handle **~5,000 devices maximum** before critical performance degradation.

---

## 1.2 Code-Level Bottleneck Analysis

Based on detailed codebase review, the following code-level issues prevent 1M device scale:

### Bottleneck #1: Inventory Service N+1 Query Pattern

**File:** `/services/inventory-service/src/main/java/com/ubrnms/inventory/service/InventoryService.java:56-64`

```java
public List<Device> listDevices(String deviceType, String status, int page, int limit) {
    List<Device> all = deviceRepo.findAll();  // ← LOADS ALL DEVICES INTO MEMORY
    return all.stream()
            .filter(d -> deviceType == null || deviceType.equalsIgnoreCase(d.getDeviceType()))
            .filter(d -> status == null || status.equalsIgnoreCase(d.getStatus()))
            .skip((long) page * limit)
            .limit(limit)
            .collect(Collectors.toList());
}
```

**Impact at 1M Devices:**
- Memory: 1M devices × 5KB avg = **5GB heap per request**
- GC pause: **5-10 seconds** per major GC
- Response time: **2-5 seconds** per API call
- Concurrent requests: **Instant OOM** with 3+ concurrent calls

**Required Fix:**

```java
public Page<Device> listDevices(String deviceType, String status, Pageable pageable) {
    Specification<Device> spec = Specification.where(null);

    if (deviceType != null) {
        spec = spec.and((root, query, cb) -> cb.equal(root.get("deviceType"), deviceType));
    }

    if (status != null) {
        spec = spec.and((root, query, cb) -> cb.equal(root.get("status"), status));
    }

    return deviceRepo.findAll(spec, pageable);  // Database-side pagination
}

// Required MongoDB index:
db.devices.createIndex({ deviceType: 1, status: 1 })
```

---

### Bottleneck #2: Alarm Service In-Memory Aggregation

**File:** `/services/alarm-service/src/main/java/com/ubrnms/alarm/service/AlarmService.java:139-150`

```java
public List<Map.Entry<String, Long>> getTopReported(Instant from, Instant to, int limit) {
    return alarmRepo.findByRaisedAtBetween(from, to).stream()  // Loads ALL alarms
            .collect(Collectors.groupingBy(Alarm::getAlarmType, Collectors.counting()))
            .entrySet().stream()
            .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
            .limit(limit)
            .collect(Collectors.toList());
}
```

**Impact at 1M Devices:**
- Alarms/day: 1M devices × 5 alarms/day = **5M alarms/day**
- 30-day query: **150M alarms loaded into memory**
- Memory: 150M × 2KB = **300GB** (impossible)

**Required Fix:**

```java
public List<AlarmTypeCount> getTopReported(Instant from, Instant to, int limit) {
    // Use MongoDB aggregation pipeline
    Aggregation aggregation = Aggregation.newAggregation(
        Aggregation.match(Criteria.where("raisedAt").gte(from).lte(to)),
        Aggregation.group("alarmType").count().as("count"),
        Aggregation.sort(Sort.Direction.DESC, "count"),
        Aggregation.limit(limit)
    );

    return mongoTemplate.aggregate(aggregation, "alarms", AlarmTypeCount.class)
        .getMappedResults();
}

// Required index:
db.alarms.createIndex({ raisedAt: 1, alarmType: 1 })
```

---

### Bottleneck #3: KPI Collector Concurrency Limit

**File:** `/services/kpi-collector/internal/poller/poller.go:104`

```go
func (p *Poller) Start(ctx context.Context) error {
    devices := p.deviceLookup.GetAllDevices()  // Gets all 1M devices
    p.PollAll(ctx, devices, pollCycle, 500)    // Hardcoded 500 concurrent
}

func (p *Poller) PollAll(ctx context.Context, devices []model.Device,
    pollCycle int64, maxConcurrency int) {
    sem := make(chan struct{}, maxConcurrency)  // Fixed semaphore

    for _, dev := range devices {
        sem <- struct{}{}  // Block if 500 goroutines active
        go func(d model.Device) {
            defer func() { <-sem }()
            p.pollDevice(ctx, d, pollCycle)
        }(dev)
    }
}
```

**Impact at 1M Devices:**
- 500 concurrent polls × 10sec timeout = **50 seconds per batch**
- 1M devices / 500 concurrent = **2,000 batches**
- Total poll time: **2,000 × 50 sec = 100,000 sec = 27.7 hours** ❌

**Required Fix:**

```go
func (p *Poller) Start(ctx context.Context) error {
    // Use consistent hashing to partition devices across poller instances
    podName := os.Getenv("POD_NAME")  // kpi-collector-0, kpi-collector-1, ...
    podIndex, totalPods := p.getPodInfo(podName)

    devices := p.deviceLookup.GetDevicesForPod(podIndex, totalPods)

    // Increase concurrency to 5,000 per pod
    maxConcurrency := getEnvInt("MAX_SNMP_CONCURRENCY", 5000)
    p.PollAll(ctx, devices, pollCycle, maxConcurrency)
}

// With 200 pods × 5,000 concurrent = 1M concurrent polls
// All devices polled within 10-second timeout window ✅
```

---

### Bottleneck #4: Kafka Partition Count

**File:** `docker-compose.dev.yml:126-134`

```yaml
kafka-topics:
  command: >
    kafka-topics --create --topic raw-alarms --partitions 3 --replication-factor 1
```

**Impact at 1M Devices:**
- 3 partitions = max **3 consumer instances** per consumer group
- Throughput ceiling: ~10K-30K messages/sec per partition = **30K-90K total**
- Alarm storms (network outage) = 100K+ alarms/sec ❌ (insufficient)

**Required Changes:**

```bash
# Increase partitions to 100-200
kafka-topics --alter --topic raw-alarms --partitions 100
kafka-topics --alter --topic processed-alarms --partitions 100
kafka-topics --alter --topic kpi-events --partitions 150
kafka-topics --alter --topic inventory-events --partitions 50
```

**Kafka Broker Scaling:**

| Topic | Current Partitions | Required Partitions | Replication Factor |
|-------|-------------------|---------------------|-------------------|
| `raw-alarms` | 3 | 100 | 3 |
| `processed-alarms` | 3 | 100 | 3 |
| `kpi-events` | 3 | 150 | 3 |
| `inventory-events` | 3 | 50 | 3 |
| `operational-events` | 3 | 30 | 3 |

---

### Bottleneck #5: Redis Cache Design Issues

**File:** `/services/kpi-query-service/src/main/resources/application.yml:32`

```yaml
kpi:
  cache:
    ttl-seconds: 60  # Only 60 seconds TTL
```

**File:** `/services/kpi-query-service/src/main/java/com/ubrnms/kpiquery/service/KpiQueryService.java:41`

```java
@Cacheable(value = "kpi-device",
           key = "#deviceId + ':' + #granularity + ':' + #from + ':' + #to")
```

**Problems:**
1. **Cache key too specific:** Includes exact timestamps → different milliseconds = cache miss
2. **TTL too short:** 60 sec means 1M cache evictions/min
3. **No cache warming:** Cold start = thundering herd

**Required Fix:**

```java
// Round timestamps to 5-minute buckets for better cache hit rate
@Cacheable(value = "kpi-device",
           key = "#deviceId + ':' + #granularity + ':' + " +
                 "T(java.time.Instant).ofEpochMilli(#from.toEpochMilli() / 300000 * 300000) + ':' + " +
                 "T(java.time.Instant).ofEpochMilli(#to.toEpochMilli() / 300000 * 300000)")
public List<KpiAggregate> queryDevice(String deviceId, String granularity, Instant from, Instant to) {
    // Implementation
}

// Increase TTL
kpi:
  cache:
    ttl-seconds: 600  # 10 minutes
```

---

### Additional Critical Bottlenecks

| # | Component | Issue | Impact | Priority |
|---|-----------|-------|--------|----------|
| **6** | MongoDB Connection Pool | Max 100 connections | Pool exhaustion | HIGH |
| **7** | ScyllaDB | Not implemented | MongoDB unsuitable for time-series at scale | CRITICAL |
| **8** | Event Collector | Single-threaded UDP listener | 5K traps/sec max | HIGH |
| **9** | Topology Service | O(n²) graph algorithm | Timeout at >2K devices | MEDIUM |
| **10** | API Pagination | Offset-based | Timeout at page 10,000 | HIGH |

---

# 2. ARCHITECTURE REVIEW

## 2.1 Application Support for Horizontal Scaling

### Current State

**Kubernetes HPA Configuration:**
```yaml
# services/kpi-collector/values.yaml
autoscaling:
  enabled: true
  minReplicas: 8
  maxReplicas: 30        # INSUFFICIENT for 1M devices
  targetCPUUtilizationPercentage: 50

resources:
  limits:
    cpu: "1"             # Too low
    memory: "1Gi"        # Too low
```

**Analysis:**
✅ **What Works:**
- All services have HPA enabled
- Stateless service design
- Kubernetes-native with Helm charts
- Circuit breaker pattern

❌ **What Doesn't Scale:**
- Max replicas too low (30 can handle ~15K concurrent polls)
- Memory/CPU limits insufficient
- No pod anti-affinity (pods can cluster on same nodes)
- No priority classes (critical pods can be evicted)

---

### Required Changes for 1M Devices

**Service Scaling Requirements:**

| Service | Current Max Replicas | Required Replicas | CPU/Pod | Memory/Pod |
|---------|---------------------|-------------------|---------|------------|
| **KPI Collector** | 30 | 200-300 | 2 cores | 4Gi |
| **Event Collector** | 20 | 100-150 | 2 cores | 4Gi |
| **Alarm Service** | 16 | 50-80 | 4 cores | 8Gi |
| **Inventory Service** | 12 | 40-60 | 2 cores | 4Gi |
| **API Gateway** | 10 | 30-50 | 2 cores | 2Gi |
| **Topology Service** | 8 | 30-50 | 4 cores | 16Gi |

**Updated HPA Configuration:**

```yaml
# services/kpi-collector/values-prod-1m.yaml
kpi-collector:
  autoscaling:
    enabled: true
    minReplicas: 50
    maxReplicas: 300
    metrics:
      - type: Resource
        resource:
          name: cpu
          target:
            type: Utilization
            averageUtilization: 60
      - type: Resource
        resource:
          name: memory
          target:
            type: Utilization
            averageUtilization: 70
    behavior:
      scaleDown:
        stabilizationWindowSeconds: 600  # Wait 10 min before scaling down
        policies:
          - type: Percent
            value: 10
            periodSeconds: 120
      scaleUp:
        stabilizationWindowSeconds: 60
        policies:
          - type: Percent
            value: 50
            periodSeconds: 60

  resources:
    requests:
      cpu: "1"
      memory: "2Gi"
    limits:
      cpu: "2"
      memory: "4Gi"

  podDisruptionBudget:
    enabled: true
    minAvailable: 40

  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            topologyKey: kubernetes.io/hostname
            labelSelector:
              matchLabels:
                app: kpi-collector
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: workload-type
                operator: In
                values:
                  - edge-collectors
```

---

### Regional Deployment Strategy

**Multi-Region Active-Active Architecture:**

```
                    ┌─────────────────────┐
                    │  Global Load Bal.   │
                    │  (GeoDNS routing)   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
    ┌──────────────────┐              ┌──────────────────┐
    │   Region US-1    │              │   Region EU-1    │
    │   (Active)       │◄────Sync────►│   (Active)       │
    ├──────────────────┤              ├──────────────────┤
    │ • 500K devices   │              │ • 500K devices   │
    │ • R/W traffic    │              │ • R/W traffic    │
    │ • MongoDB P+S    │              │ • MongoDB P+S    │
    │ • ScyllaDB (DC1) │              │ • ScyllaDB (DC2) │
    │ • Kafka cluster  │              │ • Kafka cluster  │
    └──────────────────┘              └──────────────────┘
           │                                   │
    ┌──────▼───────┐                   ┌──────▼───────┐
    │  US Devices  │                   │  EU Devices  │
    │  (500K)      │                   │  (500K)      │
    └──────────────┘                   └──────────────┘
```

**Region Selection Criteria:**

| Region | Devices | Use Case | Latency Requirement |
|--------|---------|----------|---------------------|
| **US-East-1** | 500K | Primary (North America devices) | < 50ms |
| **EU-Central-1** | 500K | Primary (Europe/Africa devices) | < 50ms |
| **AP-Southeast-1** | Standby | DR + Asia-Pacific devices (future) | < 100ms |
| **SA-East-1** | Standby | DR + South America devices (future) | < 100ms |

**Scaling Limits:**

| Resource | Soft Limit (Alert) | Hard Limit (Throttle) | Current | 1M Target |
|----------|-------------------|---------------------|---------|-----------|
| Kubernetes Pods | 10,000/cluster | 15,000/cluster | 150 | 2,000-3,000 |
| Kubernetes Nodes | 800/cluster | 1,000/cluster | 10 | 150-200 |
| MongoDB Connections | 8,000 | 10,000 | 500 | 5,000 |
| Kafka Messages/sec | 80,000 | 100,000 | 1,000 | 50,000-80,000 |
| API Requests/sec | 40,000 | 50,000 | 500 | 10,000-20,000 |
| SNMP Polls/sec | 3,000 | 5,000 | 100 | 3,500 |

---

## 2.2 Database Support for Replication

### MongoDB Replication Strategy

**Current Configuration:**
```javascript
// docker-compose.dev.yml
mongodb:
  image: mongo:7.0
  command: --replSet rs0      // Single replica set (dev only)
```

**Problem:** No production sharding, no cross-region replication configured.

**Required Architecture for 1M Devices:**

```
MongoDB Sharded Cluster (Production):

                  ┌────────────────┐
                  │  mongos Router │  (4-6 instances)
                  └────────┬───────┘
                           │
        ┌──────────────────┼──────────────┐
        ▼                  ▼              ▼
   ┌────────┐         ┌────────┐     ┌────────┐
   │ Shard 1│         │ Shard 2│     │ Shard 3│
   │ 333K   │         │ 333K   │     │ 333K   │
   │devices │         │devices │     │devices │
   └────┬───┘         └────┬───┘     └────┬───┘
        │                  │              │
   ┌────▼────┐        ┌────▼────┐    ┌────▼────┐
   │Primary  │        │Primary  │    │Primary  │
   │+2 Sec.  │        │+2 Sec.  │    │+2 Sec.  │
   └─────────┘        └─────────┘    └─────────┘
        │                  │              │
   ┌────▼──────────┬───────▼──────┬───────▼─────┐
   │               │              │             │
Config Servers (3 nodes, replica set for shard metadata)
```

---

# 3. CRITICAL BOTTLENECKS

## 3.1 Bottleneck Summary Table

| # | Component | Current Limit | 1M Device Need | Gap | Priority |
|---|-----------|--------------|----------------|-----|----------|
| **1** | Inventory `findAll()` query | 50K devices | 1M devices | 20x | CRITICAL |
| **2** | Alarm in-memory aggregation | 1M alarms | 150M alarms | 150x | CRITICAL |
| **3** | KPI Collector concurrency | 500 concurrent | 1M concurrent | 2,000x | CRITICAL |
| **4** | Kafka partition count | 3 partitions | 100+ partitions | 33x | CRITICAL |
| **5** | Redis cache design | 5% hit rate | 80% hit rate | 16x | HIGH |
| **6** | MongoDB connection pool | 100 connections | 5,000 connections | 50x | HIGH |
| **7** | ScyllaDB (not implemented) | N/A | Required | ∞ | CRITICAL |
| **8** | Event Collector UDP | 5K traps/sec | 50K traps/sec | 10x | HIGH |
| **9** | Topology graph algorithm | O(n²) | O(n log n) | N/A | MEDIUM |
| **10** | API pagination | Offset-based | Cursor-based | N/A | HIGH |

---

## 3.2 Infrastructure Limitations

### Kubernetes Cluster Limits

| Resource | Soft Limit | Hard Limit | Current Usage | 1M Target | Status |
|----------|-----------|------------|---------------|-----------|--------|
| Pods per Node | 100 | 110 | 15 | 100 | ✅ OK |
| Pods per Cluster | 10,000 | 15,000 | 150 | 2,500 | ✅ OK |
| Nodes per Cluster | 800 | 1,000 | 10 | 200 | ✅ OK |
| Services per Cluster | 8,000 | 10,000 | 30 | 50 | ✅ OK |
| ConfigMaps | 10,000 | 20,000 | 25 | 100 | ✅ OK |
| Secrets | 10,000 | 20,000 | 15 | 50 | ✅ OK |

**Conclusion:** Kubernetes platform limits are **not a bottleneck** for 1M devices.

---

### Database Limits

| Resource | MongoDB Limit | ScyllaDB Limit | Required for 1M | Status |
|----------|--------------|----------------|-----------------|--------|
| Max Connections | 10,000 | 100,000+ | 5,000 | ✅ OK |
| Max Collections | Unlimited | N/A | 20 | ✅ OK |
| Max Document Size | 16 MB | N/A | 50 KB avg | ✅ OK |
| Max Write Throughput | ~100K writes/sec | 1M+ writes/sec | 50K writes/sec | ✅ OK |
| Max Storage per Node | 5 TB | 10 TB | 3 TB/node | ✅ OK |

**Conclusion:** Database limits are **not a bottleneck** with proper sharding/clustering.

---

## 3.3 Network & Protocol Limitations

### SNMP Protocol Considerations

**UDP Packet Loss:**
- SNMP uses UDP (connectionless, no retries)
- Expected packet loss: 0.1-1% in normal networks
- At 1M devices × 12 samples/hour = 12M packets/hour
- Packet loss: 12K-120K packets/hour = **data gaps**

**Mitigation Strategy:**

```go
// Implement application-level retry
func (p *Poller) pollDeviceWithRetry(dev model.Device, maxRetries int) error {
    for attempt := 0; attempt < maxRetries; attempt++ {
        err := p.pollDevice(dev)
        if err == nil {
            return nil
        }

        if isTimeout(err) {
            time.Sleep(time.Duration(attempt) * 100 * time.Millisecond)
            continue
        }

        return err
    }

    return fmt.Errorf("poll failed after %d retries", maxRetries)
}
```

**SNMPv3 Overhead:**
- Authentication + encryption adds 10-20% latency
- CPU overhead: 5-10% per SNMP session
- Memory overhead: 50-100 KB per session for crypto context
- At 1M devices: Total memory overhead 50-100 GB distributed across poller pods

**Protocol Evaluation:**

| Protocol | Overhead | Security | Adoption | Recommendation |
|----------|----------|----------|----------|----------------|
| **SNMPv3** | Medium | Strong | Universal | ✅ Use for all devices |
| **NETCONF** | High (XML) | Strong (SSH) | BTS, Routers | ✅ Use for config only |
| **gRPC/gNMI** | Low (Protobuf) | Strong (TLS) | Modern devices | 🔄 Future consideration |
| **TR-069** | Medium (SOAP) | Medium | CPE only | ✅ Keep for CPE |

---

Continue to Part 4: Database Architecture...


# 4. DATABASE ARCHITECTURE FOR 1M DEVICES

## 4.1 MongoDB Sharding Implementation

### Sharding Key Strategy

```javascript
// Collection: devices
// Shard Key: deviceId (hashed)
sh.shardCollection("ubrnms_inventory.devices", { deviceId: "hashed" })

// Why hashed?
// - Even distribution across shards
// - deviceId is immutable (good shard key)
// - Prevents hotspots (vs range-based sharding)
```

### Collection Sharding Strategy

| Collection | Size (1M devices) | Shard Key | Shards | Replication |
|------------|-------------------|-----------|--------|-------------|
| **devices** | 5 GB | `deviceId: hashed` | 3 | RF=3 |
| **alarms** | 50 GB | `raisedAt: 1, deviceId: 1` | 5 | RF=3 |
| **audit_logs** | 20 GB | `timestamp: 1` | 3 | RF=3 |
| **config_templates** | 500 MB | `templateId: hashed` | 1 | RF=3 |
| **users** | 10 MB | `userId: hashed` | 1 | RF=3 |
| **custom_dashboards** | 100 MB | `userId: hashed` | 1 | RF=3 |

### Index Strategy for 1M Devices

```javascript
// === CRITICAL INDEXES FOR INVENTORY SERVICE ===

// 1. Primary shard key (hashed for even distribution)
db.devices.createIndex({ deviceId: "hashed" })

// 2. Query optimization indexes
db.devices.createIndex({ deviceType: 1, status: 1, createdAt: -1 })
db.devices.createIndex({ macAddress: 1 }, { unique: true })
db.devices.createIndex({ serialNumber: 1 }, { unique: true })
db.devices.createIndex({ ipAddress: 1 })
db.devices.createIndex({ "location.coordinates": "2dsphere" })

// 3. Partial indexes (reduce index size for active devices only)
db.devices.createIndex(
  { status: 1, lastSeenAt: 1 },
  {
    partialFilterExpression: {
      status: { $in: ["ONLINE", "DEGRADED"] }
    },
    name: "active_devices"
  }
)

// === ALARM SERVICE INDEXES ===

// Time-series compound index
db.alarms.createIndex({ raisedAt: 1, deviceId: 1, severity: 1 })
db.alarms.createIndex({ deviceId: 1, state: 1, raisedAt: -1 })

// TTL index (auto-delete old alarms after 30 days)
db.alarms.createIndex(
  { ttlExpiry: 1 },
  { expireAfterSeconds: 0 }
)

// Deduplication window index
db.alarms.createIndex({
  deviceId: 1,
  alarmType: 1,
  dedupWindowStart: 1
})

// === CONFIG SERVICE INDEXES ===

db.config_templates.createIndex({ templateId: "hashed" })
db.config_history.createIndex({ deviceId: 1, pushedAt: -1 })
db.config_history.createIndex(
  { pushedAt: 1 },
  { expireAfterSeconds: 7776000 }  // 90 days
)

// === AUDIT SERVICE INDEXES ===

db.audit_logs.createIndex({ timestamp: 1, actor: 1 })
db.audit_logs.createIndex(
  { timestamp: 1 },
  { expireAfterSeconds: 31536000 }  // 1 year
)
```

### Replication Configuration

```javascript
// Production replica set config (per shard)
rs.initiate({
  _id: "shard1-rs",
  members: [
    { _id: 0, host: "mongo-shard1-1:27017", priority: 10 },   // Primary preferred
    { _id: 1, host: "mongo-shard1-2:27017", priority: 5 },    // Secondary
    { _id: 2, host: "mongo-shard1-3:27017", priority: 1 },    // Secondary
    { _id: 3, host: "mongo-shard1-dr:27017", priority: 0, hidden: true, votes: 0 }  // DR node
  ],
  settings: {
    chainingAllowed: false,
    heartbeatTimeoutSecs: 10,
    electionTimeoutMillis: 10000,
    catchUpTimeoutMillis: 60000,
    getLastErrorModes: {
      multiDC: { datacenter: 2 }
    }
  }
})

// Write Concern (for critical operations like device registration)
db.devices.insertOne(
  { deviceId: "BTS-001", ... },
  { writeConcern: { w: "majority", j: true, wtimeout: 5000 } }
)

// Read Preference (for reports, non-critical reads)
db.devices.find().readPref("secondaryPreferred")
```

### Cross-Region Replication

```
Region US-1 (Primary)                    Region EU-1 (Secondary)
┌──────────────────────┐                ┌──────────────────────┐
│  Shard 1: US-1-1 (P) │───────────────▶│  Shard 1: EU-1-1 (S) │
│  Shard 2: US-1-2 (P) │───────────────▶│  Shard 2: EU-1-2 (S) │
│  Shard 3: US-1-3 (P) │───────────────▶│  Shard 3: EU-1-3 (S) │
└──────────────────────┘                └──────────────────────┘
         │                                        │
         └────────────▶  Change Streams  ◀────────┘
                       (real-time sync)

// For Active-Active write conflicts:
// - Use distributed counter for device counters
// - Last-Write-Wins with vector clocks
// - Conflict-free Replicated Data Types (CRDTs) for dashboard layouts
```

### Chunk Distribution Analysis

```javascript
// Monitor chunk distribution across shards
sh.status()

// Expected distribution for 1M devices:
// - 1M devices / 1000 chunks = 1,000 devices per chunk
// - 1000 chunks / 3 shards = ~333 chunks per shard
// - Each shard: ~333K devices

// Check for imbalanced shards
db.getSiblingDB("config").chunks.aggregate([
  { $group: { _id: "$shard", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
])

// Identify jumbo chunks (> 64MB, won't auto-split)
db.getSiblingDB("config").chunks.find({ jumbo: true }).count()

// Manual split if needed
sh.splitAt("ubrnms_inventory.devices", { deviceId: ObjectId("...") })
```

---

## 4.2 ScyllaDB Time-Series Strategy

### Why ScyllaDB for KPI Data

**Problem with MongoDB for Time-Series at 1M Scale:**
- **Write volume:** 1M devices × 12 samples/hour = 12M writes/hour = 3,333 writes/sec
- **Data volume:** 1M devices × 365 days × 288 samples/day × 5KB/sample = **525 TB/year**
- MongoDB struggles with time-series writes (index pressure, compaction lag)

**ScyllaDB Advantages:**
- Native time-series support
- Write throughput: 1M+ writes/sec per cluster
- TTL-based automatic data expiration
- Token-aware routing for low latency
- Linear scalability (add nodes = add capacity)

### ScyllaDB Cluster Architecture

```
ScyllaDB Cluster (3 Datacenters):

DC1 (US-East)          DC2 (EU-Central)        DC3 (AP-Southeast)
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ Node 1       │       │ Node 1       │       │ Node 1       │
│ Node 2       │◄─────►│ Node 2       │◄─────►│ Node 2       │
│ Node 3       │       │ Node 3       │       │ Node 3       │
│ Node 4       │       │ Node 4       │       │ Node 4       │
│ Node 5       │       │ Node 5       │       │ Node 5       │
└──────────────┘       └──────────────┘       └──────────────┘
     333K                   333K                   333K
   devices                devices                devices

Replication Strategy: NetworkTopologyStrategy
  - DC1: RF=3 (3 replicas in US-East)
  - DC2: RF=3 (3 replicas in EU-Central)
  - DC3: RF=3 (3 replicas in AP-Southeast)

Consistency: LOCAL_QUORUM (2 of 3 replicas in local DC)
```

### Schema Design

```sql
-- Keyspace
CREATE KEYSPACE ubrnms_kpi
WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'DC1': 3,
  'DC2': 3,
  'DC3': 3
};

-- Table: Raw KPI samples (5-min granularity)
CREATE TABLE kpi_raw (
  device_id text,
  metric_type text,
  bucket_start timestamp,
  sample_time timestamp,
  value double,
  unit text,
  PRIMARY KEY ((device_id, metric_type), bucket_start, sample_time)
) WITH
  CLUSTERING ORDER BY (bucket_start DESC, sample_time DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_size': 1,
    'compaction_window_unit': 'DAYS'
  }
  AND default_time_to_live = 7776000;  -- 90 days TTL

-- Table: Aggregated 15-min buckets
CREATE TABLE kpi_15min (
  device_id text,
  metric_type text,
  bucket_start timestamp,
  min_value double,
  max_value double,
  avg_value double,
  p95_value double,
  p99_value double,
  sample_count int,
  PRIMARY KEY ((device_id, metric_type), bucket_start)
) WITH
  CLUSTERING ORDER BY (bucket_start DESC)
  AND default_time_to_live = 31536000;  -- 1 year TTL

-- Table: Hourly aggregates
CREATE TABLE kpi_hourly (
  device_id text,
  metric_type text,
  hour_start timestamp,
  min_value double,
  max_value double,
  avg_value double,
  PRIMARY KEY ((device_id, metric_type), hour_start)
) WITH
  CLUSTERING ORDER BY (hour_start DESC)
  AND default_time_to_live = 63072000;  -- 2 years TTL

-- Network-wide aggregates (for dashboard overview)
CREATE TABLE kpi_network_hourly (
  network_id text,
  metric_type text,
  hour_start timestamp,
  device_count int,
  avg_value double,
  p50_value double,
  p95_value double,
  p99_value double,
  PRIMARY KEY ((network_id, metric_type), hour_start)
) WITH CLUSTERING ORDER BY (hour_start DESC);
```

### Capacity Planning

| Metric | Value | Calculation |
|--------|-------|-------------|
| **Devices** | 1,000,000 | |
| **Metrics/Device** | 10 | CPU, memory, RSSI, SNR, throughput, latency, packet loss, uptime, temp, power |
| **Sample Frequency** | 5 min | 12 samples/hour |
| **Samples/Day** | 120M | 1M × 10 × 12 × 2 (15min rollup) |
| **Write Rate** | 3,333/sec | 120M / 86400 sec |
| **Sample Size** | 100 bytes | deviceId + metric + timestamps + value + metadata |
| **Daily Data** | 12 GB | 120M × 100 bytes |
| **90-Day Raw** | 1.08 TB | 12 GB × 90 |
| **1-Year Aggregated** | 2.16 TB | Hourly aggregates smaller |
| **Total Storage** | 3.24 TB | With replication RF=3: **9.72 TB** |

### Migration Strategy from MongoDB

**Phase 1: Dual-Write**
```java
@Service
public class KpiWriteService {
    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private CqlSession scyllaSession;

    public void writeKpi(KpiSample sample) {
        // Write to MongoDB (existing path)
        mongoTemplate.save(sample, "kpi_raw");

        // Also write to ScyllaDB (new path)
        PreparedStatement stmt = scyllaSession.prepare(
            "INSERT INTO kpi_raw (device_id, metric_type, bucket_start, sample_time, value, unit) " +
            "VALUES (?, ?, ?, ?, ?, ?) USING TTL ?"
        );

        scyllaSession.executeAsync(
            stmt.bind(
                sample.getDeviceId(),
                sample.getMetricType(),
                sample.getBucketStart(),
                sample.getSampleTime(),
                sample.getValue(),
                sample.getUnit(),
                7776000
            )
        );
    }
}
```

**Phase 2: Gradual Read Migration**
```java
@Service
public class KpiQueryService {
    @Value("${kpi.read-from-scylla-percentage:0}")
    private int scyllaReadPercentage;  // Feature flag: 0-100

    public List<KpiAggregate> queryDevice(String deviceId, Instant from, Instant to) {
        if (ThreadLocalRandom.current().nextInt(100) < scyllaReadPercentage) {
            return queryFromScylla(deviceId, from, to);
        } else {
            return queryFromMongo(deviceId, from, to);
        }
    }
}

// Rollout schedule:
// Week 1-2: scyllaReadPercentage=10 (10% traffic)
// Week 3-4: scyllaReadPercentage=25
// Week 5-6: scyllaReadPercentage=50
// Week 7-8: scyllaReadPercentage=100 (full cutover)
```

**Phase 3: Deprecate MongoDB KPI Collections**
```bash
# Archive MongoDB KPI data
mongodump --db ubrnms_kpi --archive=kpi_archive_$(date +%Y%m%d).gz --gzip

# Drop MongoDB KPI collections (after verification)
db.kpi_raw.drop()
db.kpi_15min.drop()
db.kpi_hourly.drop()
```

---

## 4.3 Database Connection Pooling

### MongoDB Connection Pool Configuration

```yaml
# services/inventory-service/src/main/resources/application-prod.yml

spring:
  data:
    mongodb:
      uri: mongodb://user:pass@mongo-shard1:27017,mongo-shard2:27017,mongo-shard3:27017/ubrnms_inventory?replicaSet=rs0
      options:
        maxPoolSize: 500
        minPoolSize: 100
        maxIdleTimeMS: 300000
        maxLifeTimeMS: 1800000
        waitQueueTimeoutMS: 30000
        serverSelectionTimeoutMS: 30000
        connectTimeoutMS: 10000
        socketTimeoutMS: 60000

# With 50 inventory service pods × 500 connections = 25,000 total connections
# MongoDB cluster: 3 shards × 10,000 connections/shard = 30,000 capacity ✅
```

### ScyllaDB Connection Configuration

```yaml
# services/kpi-query-service/src/main/resources/application-prod.yml

spring:
  data:
    cassandra:
      contact-points: scylla-node1,scylla-node2,scylla-node3
      port: 9042
      keyspace-name: ubrnms_kpi
      local-datacenter: DC1
      
      pool:
        idle-timeout: 120s
        pool-timeout: 5s
        heartbeat-interval: 30s
        
      request:
        timeout: 10s
        consistency: LOCAL_QUORUM
        serial-consistency: LOCAL_SERIAL
        
      advanced:
        connection:
          max-requests-per-connection: 1024
          pool:
            local:
              size: 4
            remote:
              size: 1

# 50 KPI query pods × 4 connections × 15 nodes = 3,000 connections
# ScyllaDB limit: ~100K connections/node = 1.5M total ✅
```

---

Continue with Part 5 in next chunk...


# 5. APPLICATION SCALING STRATEGY

## 5.1 Service-by-Service Scaling Requirements

### KPI Collector Scaling

**Current Bottleneck:**
- 30 pods × 500 concurrent = 15,000 concurrent polls
- Time to poll 1M devices: Over 27 hours ❌

**Target Architecture:**
- 200 pods × 5,000 concurrent = **1M concurrent polls**
- All devices polled within **5-10 seconds** ✅

**Implementation with Consistent Hashing:**

```go
// services/kpi-collector/internal/coordinator/coordinator.go

package coordinator

import (
    "context"
    "hash/fnv"
    "os"
    "strconv"
    "strings"
)

type DeviceCoordinator struct {
    podIndex  int
    totalPods int
}

func NewCoordinator() *DeviceCoordinator {
    podName := os.Getenv("POD_NAME")  // e.g., "kpi-collector-42"
    parts := strings.Split(podName, "-")
    podIndex, _ := strconv.Atoi(parts[len(parts)-1])

    totalPods, _ := strconv.Atoi(os.Getenv("TOTAL_PODS"))

    return &DeviceCoordinator{
        podIndex:  podIndex,
        totalPods: totalPods,
    }
}

// Consistent hashing: assign devices to pods
func (c *DeviceCoordinator) ShouldPollDevice(deviceID string) bool {
    h := fnv.New32a()
    h.Write([]byte(deviceID))
    hash := h.Sum32()

    assignedPod := int(hash % uint32(c.totalPods))
    return assignedPod == c.podIndex
}

func (c *DeviceCoordinator) GetAssignedDevices(allDevices []model.Device) []model.Device {
    assigned := make([]model.Device, 0, len(allDevices)/c.totalPods+1)

    for _, dev := range allDevices {
        if c.ShouldPollDevice(dev.DeviceID) {
            assigned = append(assigned, dev)
        }
    }

    return assigned
}
```

---

### Event Collector Scaling

**Current Bottleneck:**
- Single-threaded UDP listener
- Blocking Kafka publish
- Maximum 5K traps/sec

**Target Architecture:**
- Worker pool pattern
- Async Kafka publish
- 100 pods handling **50K+ traps/sec**

**Implementation:**

```go
// services/event-collector/internal/listener/listener.go

package listener

import (
    "net"
    "sync"
)

type UDPListener struct {
    conn       *net.UDPConn
    workerPool chan []byte
    kafka      *KafkaProducer
}

func NewUDPListener(port int, workerCount int) (*UDPListener, error) {
    addr := &net.UDPAddr{Port: port}
    conn, err := net.ListenUDP("udp", addr)
    if err != nil {
        return nil, err
    }

    // Set large receive buffer to prevent packet drops
    conn.SetReadBuffer(10 * 1024 * 1024)  // 10 MB

    return &UDPListener{
        conn:       conn,
        workerPool: make(chan []byte, workerCount*2),
        kafka:      NewKafkaProducer(),
    }, nil
}

func (l *UDPListener) Start(workerCount int) error {
    // Start worker goroutines
    var wg sync.WaitGroup
    for i := 0; i < workerCount; i++ {
        wg.Add(1)
        go l.worker(&wg)
    }

    // Read UDP packets in tight loop
    go func() {
        buf := make([]byte, 65535)
        for {
            n, remoteAddr, err := l.conn.ReadFromUDP(buf)
            if err != nil {
                slog.Error("UDP read error", "error", err)
                continue
            }

            // Copy packet data (buf is reused)
            packet := make([]byte, n)
            copy(packet, buf[:n])

            // Non-blocking send to worker pool
            select {
            case l.workerPool <- packet:
                // Packet queued successfully
            default:
                // Worker pool full, drop packet (increment metric)
                metrics.UDPPacketsDropped.Inc()
            }
        }
    }()

    wg.Wait()
    return nil
}

func (l *UDPListener) worker(wg *sync.WaitGroup) {
    defer wg.Done()

    for packet := range l.workerPool {
        alarm := normalizer.ParseSNMPTrap(packet)
        if alarm == nil {
            continue
        }

        // Async Kafka publish (non-blocking)
        l.kafka.PublishAsync("raw-alarms", alarm.DeviceID, alarm)
    }
}
```

---

### Alarm Service Optimization

**Refactor Aggregation to MongoDB Pipeline:**

```java
@Service
public class AlarmService {

    @Autowired
    private MongoTemplate mongoTemplate;

    public List<AlarmTypeCount> getTopReported(Instant from, Instant to, int limit) {
        // Use MongoDB aggregation pipeline (runs on database server)
        Aggregation aggregation = Aggregation.newAggregation(
            // Stage 1: Filter by time range
            Aggregation.match(
                Criteria.where("raisedAt").gte(from).lte(to)
            ),

            // Stage 2: Group by alarmType and count
            Aggregation.group("alarmType")
                .count().as("count")
                .first("alarmType").as("alarmType"),

            // Stage 3: Sort by count descending
            Aggregation.sort(Sort.Direction.DESC, "count"),

            // Stage 4: Limit results
            Aggregation.limit(limit)
        );

        AggregationResults<AlarmTypeCount> results = mongoTemplate.aggregate(
            aggregation,
            "alarms",
            AlarmTypeCount.class
        );

        return results.getMappedResults();
    }
}
```

---

# 6. HIGH AVAILABILITY & DISASTER RECOVERY

## 6.1 Disaster Recovery Architecture

### RTO/RPO Targets

| Service Tier | RTO (Recovery Time Objective) | RPO (Recovery Point Objective) | Backup Strategy |
|--------------|------------------------------|-------------------------------|-----------------|
| **Critical (Inventory, Auth)** | < 15 minutes | < 5 minutes | Continuous replication |
| **Important (Alarm, Config)** | < 1 hour | < 15 minutes | 15-minute snapshots |
| **Standard (Reports, Audit)** | < 4 hours | < 1 hour | Hourly snapshots |
| **Low Priority (Dashboards)** | < 24 hours | < 24 hours | Daily snapshots |

### MongoDB DR Strategy

**Continuous Backup with Point-in-Time Recovery:**

```bash
#!/bin/bash
# MongoDB backup script

# Full backup (daily at 2 AM)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
S3_BUCKET="s3://ubr-nms-backups"

mongodump \
  --host mongo-shard1:27017,mongo-shard2:27017,mongo-shard3:27017 \
  --oplog \
  --gzip \
  --archive=/backup/mongodb_full_${TIMESTAMP}.gz

# Upload to S3 (cross-region replication enabled)
aws s3 cp /backup/mongodb_full_${TIMESTAMP}.gz \
  ${S3_BUCKET}/full/ \
  --storage-class STANDARD_IA

# Verify backup integrity
mongorestore \
  --archive=/backup/mongodb_full_${TIMESTAMP}.gz \
  --gzip \
  --dryRun
```

**Cross-Region Replication:**

```javascript
// MongoDB replica set with DR node in different region
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "mongo-us-1:27017", priority: 10 },      // US primary
    { _id: 1, host: "mongo-us-2:27017", priority: 5 },       // US secondary
    { _id: 2, host: "mongo-us-3:27017", priority: 5 },       // US secondary
    { _id: 3, host: "mongo-eu-1:27017", priority: 0, hidden: true, votes: 0 },  // EU DR
    { _id: 4, host: "mongo-ap-1:27017", priority: 0, hidden: true, votes: 0 }   // AP DR
  ]
})

// DR nodes:
// - hidden: Don't serve reads
// - votes: 0 (won't participate in elections)
// - priority: 0 (never become primary)
// - Purpose: Real-time replication for disaster recovery
```

---

### ScyllaDB DR Strategy

**Cross-Datacenter Replication:**

```sql
-- Keyspace with multi-DC replication
CREATE KEYSPACE ubrnms_kpi
WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'DC_US': 3,      -- 3 replicas in US datacenter
  'DC_EU': 3,      -- 3 replicas in EU datacenter
  'DC_AP': 2       -- 2 replicas in AP datacenter (DR only)
};

-- Consistency levels for different operations:

-- Writes: LOCAL_QUORUM (2 of 3 in local DC)
session.execute(
  statement.setConsistencyLevel(ConsistencyLevel.LOCAL_QUORUM)
);

-- Reads: LOCAL_ONE (fastest, eventually consistent)
session.execute(
  statement.setConsistencyLevel(ConsistencyLevel.LOCAL_ONE)
);
```

---

## 6.2 Failover Procedures

### Application Failover (Region US → EU)

```bash
#!/bin/bash
# Automated failover script

# Step 1: Verify EU region health
if ! kubectl --context eu-cluster get nodes | grep Ready; then
  echo "ERROR: EU cluster not healthy"
  exit 1
fi

# Step 2: Update DNS (GeoDNS failover)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "nms.ubr.example.com",
        "Type": "A",
        "SetIdentifier": "EU-Failover",
        "Weight": 100,
        "TTL": 60,
        "ResourceRecords": [{"Value": "203.0.113.10"}]
      }
    }]
  }'

# Step 3: Promote MongoDB secondaries in EU to primaries
mongo --host mongo-eu-1:27017 << 'EOF'
rs.stepDown()
EOF

# Step 4: Scale up EU Kubernetes pods
kubectl --context eu-cluster scale deployment --replicas=200 -n ubr-nms --all

# Step 5: Verify traffic flow
for i in {1..100}; do
  curl -s https://nms.ubr.example.com/api/v1/healthz || echo "FAIL $i"
  sleep 1
done

echo "Failover to EU complete. Monitor dashboards."
```

### Database Failover

**MongoDB Replica Set Automatic Failover:**
- Election timeout: **10 seconds**
- Clients auto-reconnect via connection string
- No manual intervention required

**ScyllaDB Node Failure:**
- Token-aware driver routes to replica automatically
- Gossip protocol detects failure in ~10 seconds
- Hinted handoff ensures no data loss
- No manual intervention required

### Worst-Case Scenario: Full Region Loss

| Recovery Step | Action |
|---------------|--------|
| **Detection** | Health checks fail, alerts triggered |
| **DNS Failover** | Route 53 redirects traffic to EU |
| **Database Promotion** | EU secondaries become primaries |
| **Pod Scale-Up** | EU Kubernetes scales to full capacity |
| **Verification** | Smoke tests, monitoring validation |

**Total RTO:** Within 15-minute SLA ✅
**RPO:** < 5 minutes ✅

---

# 7. ENVIRONMENT READINESS

## 7.1 Pre-Production Checklist

### Lower Environment (Dev/QA)

| Component | Requirement | Status |
|-----------|-------------|--------|
| **Kubernetes Cluster** | 3 nodes, 32 GB RAM/node | ✅ |
| **MongoDB** | Replica set (3 nodes) | ✅ |
| **Kafka** | 3 brokers | ✅ |
| **Redis** | Single instance | ✅ |
| **ScyllaDB** | Single node (dev) | ⚠️ Needs setup |
| **Load Balancer** | NGINX Ingress | ✅ |
| **Monitoring** | Prometheus + Grafana | ✅ |
| **CI/CD** | GitHub Actions | ✅ |
| **Device Simulator** | 500 devices | ✅ |

### Pre-Production Environment

| Component | Requirement | Status | Priority |
|-----------|-------------|--------|----------|
| **Kubernetes Cluster** | 20 nodes, 64 GB RAM/node | ❌ | CRITICAL |
| **MongoDB** | 3-shard cluster (9 nodes) | ❌ | CRITICAL |
| **Kafka** | 5 brokers, 100 partitions/topic | ❌ | CRITICAL |
| **Redis** | Cluster (6 nodes) | ❌ | HIGH |
| **ScyllaDB** | 9-node cluster (3 DCs) | ❌ | CRITICAL |
| **Load Balancer** | AWS ALB with WAF | ❌ | HIGH |
| **Monitoring** | Full observability stack | ❌ | MEDIUM |
| **Device Simulator** | 50,000 devices | ❌ | CRITICAL |

### Production Environment

| Component | Requirement | Status | Priority |
|-----------|-------------|--------|----------|
| **Kubernetes Cluster** | 200 nodes, 64 GB RAM/node | ❌ | CRITICAL |
| **MongoDB** | 3 shards × 4 replicas | ❌ | CRITICAL |
| **Kafka** | 7 brokers, 150 partitions | ❌ | CRITICAL |
| **Redis** | Cluster (12 nodes) | ❌ | HIGH |
| **ScyllaDB** | 15 nodes (5 per DC × 3 DCs) | ❌ | CRITICAL |
| **Load Balancer** | Multi-region GeoDNS | ❌ | HIGH |
| **Monitoring** | Enterprise APM + logging | ❌ | MEDIUM |
| **DR Site** | Full replica in EU | ❌ | HIGH |

---

# 8. ONBOARDING PROCESS FRAMEWORK

## 8.1 Batch Interface (New Requirement)

**Current:** Individual device registration only via `POST /api/v1/discovery/check-in`

**Required:** Bulk onboarding API for efficient mass deployment

### API Specification

```
POST /api/v1/discovery/batch-register

Request:
{
  "batchId": "BATCH-2027-001",
  "devices": [
    {
      "serialNumber": "BTS-001",
      "macAddress": "00:11:22:33:44:55",
      "ipAddress": "10.0.1.100",
      "deviceType": "BTS",
      "model": "Huawei RAN-5000",
      "firmware": "9.0.1",
      "region": "US-EAST",
      "location": {
        "latitude": 40.7128,
        "longitude": -74.0060,
        "elevation": 10,
        "address": "123 Main St, New York, NY"
      }
    }
    // ... up to 10,000 devices per batch
  ]
}

Response (Success):
{
  "batchId": "BATCH-2027-001",
  "status": "PROCESSING",
  "totalDevices": 10000,
  "submittedAt": "2027-01-15T10:30:00Z",
  "estimatedCompletionTime": "2027-01-15T10:31:00Z",
  "trackingUrl": "/api/v1/discovery/batches/BATCH-2027-001/status"
}

Response (Status Check):
GET /api/v1/discovery/batches/BATCH-2027-001/status

{
  "batchId": "BATCH-2027-001",
  "status": "COMPLETED",
  "totalDevices": 10000,
  "succeeded": 9987,
  "failed": 13,
  "inProgress": 0,
  "processingTime": "45 seconds",
  "successRate": "99.87%",
  "failures": [
    {
      "serialNumber": "BTS-042",
      "reason": "Duplicate MAC address",
      "errorCode": "DUPLICATE_MAC"
    },
    {
      "serialNumber": "BTS-103",
      "reason": "Invalid serial number format",
      "errorCode": "INVALID_SERIAL"
    }
  ]
}
```

---

# 9. WAVE PLANNING & EXECUTION

## 9.1 Phased Onboarding Strategy

**Objective:** Onboard 1 million devices over 26 weeks (6 months)

### Wave Schedule

| Wave | Devices | Duration | Cumulative | Target Success Rate |
|------|---------|----------|------------|---------------------|
| **Pilot** | 10,000 | 2 weeks | 10,000 | 95%+ |
| **Wave 1** | 50,000 | 3 weeks | 60,000 | 98%+ |
| **Wave 2** | 100,000 | 4 weeks | 160,000 | 98.5%+ |
| **Wave 3** | 200,000 | 5 weeks | 360,000 | 99%+ |
| **Wave 4** | 300,000 | 6 weeks | 660,000 | 99.5%+ |
| **Wave 5** | 340,000 | 6 weeks | 1,000,000 | 99.5%+ |

### Wave Execution Process

```
Pre-Wave Planning (1 week before)
  │
  ├─ Prepare device inventory CSV
  ├─ Validate device credentials
  ├─ Pre-provision certificates
  ├─ Update capacity (scale up services)
  └─ Conduct dry-run with simulator
  │
  ▼
Wave Execution (Duration varies)
  │
  ├─ Day 1: Submit batch 1 (10K devices)
  │   ├─ Monitor success rate
  │   ├─ Address failures in real-time
  │   └─ Verify end-to-end connectivity
  │
  ├─ Day 2-N: Submit remaining batches
  │   ├─ Throttle rate based on system health
  │   ├─ Re-batch failed devices
  │   └─ Daily status reports
  │
  ▼
Post-Wave Validation (3 days)
  │
  ├─ Verify all devices registered
  ├─ Confirm SNMP polling active
  ├─ Validate alarm ingestion
  ├─ Check KPI data collection
  ├─ Generate wave completion report
  └─ Address remaining failures
```

---

# 10. AUTOMATION & TESTING STRATEGY

## 10.1 End-to-End Validation Criteria

### Test Scenarios

**1. mTLS Handshake Success**
```python
def test_mtls_handshake(device):
    # Device presents certificate signed by NMS CA
    cert = device.get_certificate()
    assert cert.is_signed_by(NMS_CA)
    
    # NMS validates certificate chain
    connection = device.establish_mtls_connection(nms_endpoint)
    assert connection.is_secure()
    assert connection.cipher_suite in APPROVED_CIPHERS
    
    # Bidirectional trust established
    assert connection.peer_verified()
```

**2. WebSocket/MQTT Transport Layer**
```python
def test_websocket_transport(device):
    # Persistent connection established
    ws = device.connect_websocket(nms_endpoint)
    assert ws.is_connected()
    
    # Heartbeat messages (every 60 sec)
    for i in range(3):
        heartbeat = ws.wait_for_message(timeout=65)
        assert heartbeat.type == "HEARTBEAT"
        ws.send_ack(heartbeat.sequence_number)
    
    # Message delivery confirmation
    test_message = device.create_test_message()
    ws.send(test_message)
    ack = ws.wait_for_ack(timeout=5)
    assert ack.message_id == test_message.id
```

**3. Message Payload Verification**
```python
def test_message_payload(device):
    message = device.send_check_in()
    
    # Header validation
    assert message.header.device_id == device.device_id
    assert message.header.timestamp is not None
    assert message.header.message_type == "DEVICE_CHECK_IN"
    assert message.header.sequence_number > 0
    
    # Body validation
    assert message.body.deviceType in ["BTS", "CPE", "IDU"]
    assert message.body.firmware is not None
    assert message.body.location is not None
    
    # Footer validation (HMAC-SHA256)
    computed_hmac = hmac.sha256(message.header + message.body, device.secret_key)
    assert message.footer.signature == computed_hmac
```

**4. Device Discovery Workflow**
```python
def test_device_discovery_workflow(device):
    # Step 1: Device sends check-in
    response = device.send_check_in()
    assert response.status_code == 200
    
    # Step 2: Birth certificate issued
    birth_cert = response.json()["birthCertificate"]
    assert birth_cert["deviceId"] == device.device_id
    assert birth_cert["certificateId"] is not None
    
    # Step 3: Inventory record created
    inventory_record = nms_api.get_device(device.device_id)
    assert inventory_record["serialNumber"] == device.serial_number
    
    # Step 4: Topology updated
    topology = nms_api.get_topology()
    assert device.device_id in topology["nodes"]
```

**5. SNMP Polling Success**
```python
def test_snmp_polling(device):
    # Register device
    device.register()
    
    # Wait for KPI collector to poll (within 5 minutes)
    kpi_data = device.wait_for_snmp_poll(timeout=300)
    assert kpi_data is not None
    
    # Verify OID responses
    assert "cpu" in kpi_data
    assert "memory" in kpi_data
    assert "rssi" in kpi_data
    
    # Verify data written to ScyllaDB
    db_data = scylla.query_kpi(device.device_id, last_5_min=True)
    assert len(db_data) > 0
```

**6. Alarm Ingestion**
```python
def test_alarm_ingestion(device):
    # Send SNMP trap
    device.send_snmp_trap(alarm_type="linkDown", severity="CRITICAL")
    
    # Verify event collector receives trap
    assert event_collector.received_trap(device.device_id, timeout=5)
    
    # Verify alarm service processes
    alarm = nms_api.wait_for_alarm(device.device_id, timeout=10)
    assert alarm["severity"] == "CRITICAL"
    assert alarm["state"] == "NEW"
    
    # Verify notification sent
    notification = user.wait_for_notification(timeout=30)
    assert notification["alarmId"] == alarm["id"]
```

---

## 10.2 Automation Testing Framework

### Test Suite Architecture

```python
# tests/e2e/test_device_onboarding.py

import pytest
from device_simulator import DeviceSimulator, DeviceProfile

@pytest.mark.e2e
class TestMassDeviceOnboarding:
    
    @pytest.fixture(scope="class")
    def simulator(self):
        return DeviceSimulator(
            device_count=10000,
            device_types=["BTS", "CPE", "IDU"],
            distribution={"BTS": 0.3, "CPE": 0.6, "IDU": 0.1}
        )
    
    def test_batch_registration_10k_devices(self, simulator):
        """Test batch registration of 10,000 devices"""
        batch_response = simulator.batch_register()
        
        assert batch_response["totalDevices"] == 10000
        assert batch_response["succeeded"] >= 9900  # 99% success rate
        
        # Wait for batch completion
        status = simulator.wait_for_batch_completion(timeout=300)
        assert status["status"] == "COMPLETED"
    
    def test_mtls_connections(self, simulator):
        """Verify mTLS connections for all devices"""
        for device in simulator.devices[:100]:  # Sample 100 devices
            assert device.establish_mtls_connection() is True
            assert device.send_heartbeat() is True
    
    def test_snmp_polling_coverage(self, simulator):
        """Verify SNMP polling for all devices within 5 minutes"""
        start_time = time.time()
        
        for device in simulator.devices:
            kpi_data = device.wait_for_snmp_poll(timeout=300)
            assert kpi_data is not None
        
        total_time = time.time() - start_time
        assert total_time < 300  # All devices polled within 5 minutes
    
    def test_alarm_end_to_end(self, simulator):
        """Test alarm flow from device to UI"""
        test_device = simulator.devices[0]
        
        # Send test alarm
        test_device.send_snmp_trap(alarm_type="cpuHigh", severity="WARNING")
        
        # Verify alarm appears in UI
        alarm = test_device.wait_for_alarm_in_ui(timeout=30)
        assert alarm["severity"] == "WARNING"
        assert alarm["deviceId"] == test_device.device_id
    
    def test_kpi_data_persistence(self, simulator):
        """Verify KPI data is written to ScyllaDB"""
        test_device = simulator.devices[0]
        
        # Wait for multiple poll cycles
        time.sleep(600)  # 10 minutes
        
        # Query ScyllaDB for KPI data
        kpi_data = scylla.query_kpi(
            test_device.device_id,
            from_time=time.time() - 600,
            to_time=time.time()
        )
        
        assert len(kpi_data) >= 2  # At least 2 samples (5-min interval)
    
    @pytest.mark.performance
    def test_concurrent_registrations(self, simulator):
        """Test system performance under concurrent load"""
        # Register 1,000 devices concurrently
        results = simulator.batch_register_concurrent(
            batch_size=1000,
            concurrency=100
        )
        
        assert results["avgResponseTime"] < 2000  # < 2 seconds
        assert results["successRate"] > 0.99  # > 99%
```

---

Continue with Part 11: Regulatory Audit in next message...


# 11. REGULATORY AUDIT & COMPLIANCE

## 11.1 Pre-Production Regulatory Audit

### Audit Objectives

**Purpose:** Ensure the UBR Open NMS platform and 1M device onboarding process comply with industry regulations, security standards, and internal policies before production deployment.

**Scope:** Infrastructure, application security, data protection, network security, operational procedures, and onboarding workflows.

---

## 11.2 Compliance Frameworks

### Applicable Regulations & Standards

| Framework | Applicability | Requirements | Status |
|-----------|--------------|--------------|--------|
| **SOC 2 Type II** | Service Provider Security | Access controls, encryption, monitoring, incident response | ⚠️ In Progress |
| **ISO 27001** | Information Security | ISMS, risk management, security controls | ⚠️ Needs Certification |
| **GDPR** | Personal Data Protection | Data minimization, consent, right to erasure | ✅ Compliant |
| **HIPAA** | Healthcare Data (if applicable) | PHI protection, access logs, encryption | N/A (No PHI) |
| **PCI DSS** | Payment Card Data (if applicable) | Secure transmission, access control | N/A (No card data) |
| **NIST Cybersecurity Framework** | Risk Management | Identify, Protect, Detect, Respond, Recover | ⚠️ Partial |
| **FCC Regulations** | Telecommunications Equipment | Equipment certification, interference standards | ✅ Devices certified |
| **NERC CIP** | Critical Infrastructure | Asset identification, security management | ⚠️ If managing grid devices |

---

## 11.3 Security Audit Checklist

### Infrastructure Security

**Network Security:**
- [ ] **Firewall Rules:** All ingress/egress traffic whitelisted
- [ ] **DDoS Protection:** CloudFlare or AWS Shield enabled
- [ ] **WAF Rules:** OWASP Top 10 protections configured
- [ ] **Network Segmentation:** Production isolated from dev/test
- [ ] **VPN Access:** Admin access via VPN only
- [ ] **Port Restrictions:** Only 443 (HTTPS), 161 (SNMP), 514 (Syslog) open

**Kubernetes Security:**
- [ ] **Pod Security Policies:** Enforced (no privileged containers)
- [ ] **Network Policies:** Inter-pod communication restricted
- [ ] **RBAC:** Role-based access control configured
- [ ] **Secrets Management:** Kubernetes Secrets encrypted at rest
- [ ] **Image Scanning:** All container images scanned for vulnerabilities
- [ ] **Admission Controllers:** OPA or Kyverno policies enforced

**Database Security:**
- [ ] **Encryption at Rest:** MongoDB encryption enabled
- [ ] **Encryption in Transit:** TLS 1.3 for all connections
- [ ] **Authentication:** Strong passwords, no default credentials
- [ ] **Access Control:** IP whitelisting, VPC isolation
- [ ] **Backup Encryption:** S3 backups encrypted with KMS
- [ ] **Audit Logging:** All database access logged

---

### Application Security

**Authentication & Authorization:**
- [ ] **JWT Security:** RS256 algorithm, 1-hour expiry
- [ ] **Password Policy:** Min 12 characters, complexity enforced
- [ ] **Account Lockout:** 3 failed attempts, 15-min lockout
- [ ] **MFA:** Multi-factor authentication available
- [ ] **Session Management:** Secure cookies, httpOnly flag
- [ ] **RBAC Enforcement:** All endpoints verify roles

**Input Validation:**
- [ ] **SQL Injection:** Parameterized queries used
- [ ] **XSS Protection:** Input sanitization, CSP headers
- [ ] **CSRF Protection:** CSRF tokens implemented
- [ ] **File Upload:** File type validation, size limits
- [ ] **API Rate Limiting:** 100 req/min per user

**Code Security:**
- [ ] **Dependency Scanning:** npm audit, OWASP Dependency Check
- [ ] **SAST:** SonarQube scans on every PR
- [ ] **DAST:** OWASP ZAP scans in staging
- [ ] **Secret Detection:** GitLeaks prevents secret commits
- [ ] **Code Review:** All changes peer-reviewed

---

### Data Protection & Privacy

**GDPR Compliance:**
- [ ] **Data Minimization:** Only necessary device data collected
- [ ] **Consent Management:** User opt-in for analytics
- [ ] **Right to Erasure:** Device deletion API implemented
- [ ] **Data Portability:** Device export API available
- [ ] **Privacy Policy:** Published and accessible
- [ ] **Data Retention:** 1-year audit log, 90-day KPI data
- [ ] **Data Breach Notification:** Procedure documented (72-hour notification)

**Data Classification:**

| Data Type | Classification | Encryption | Retention | Access Control |
|-----------|----------------|------------|-----------|----------------|
| **Device Credentials** | Confidential | Encrypted at rest | Permanent | Admin only |
| **User Passwords** | Confidential | bcrypt hashed | Until changed | System only |
| **KPI Metrics** | Internal | Encrypted in transit | 90 days | Authenticated users |
| **Alarm Data** | Internal | Encrypted in transit | 30 days | Authenticated users |
| **Audit Logs** | Confidential | Encrypted at rest/transit | 1 year | Admin + Security team |
| **Device Location** | Sensitive | Encrypted at rest/transit | Permanent | Role-based |

---

### Operational Security

**Access Management:**
- [ ] **Principle of Least Privilege:** Users have minimum required access
- [ ] **Privileged Access Management:** Admin actions logged
- [ ] **SSH Key Management:** Keys rotated quarterly
- [ ] **Service Accounts:** Unique per service, no shared credentials
- [ ] **Access Reviews:** Quarterly access audit

**Incident Response:**
- [ ] **Incident Response Plan:** Documented and tested
- [ ] **Security Monitoring:** 24/7 SOC or alerting
- [ ] **Log Aggregation:** All logs sent to SIEM
- [ ] **Forensics Capability:** Immutable audit trail
- [ ] **Breach Notification:** Procedure for user/regulator notification

**Change Management:**
- [ ] **Change Approval:** All prod changes require approval
- [ ] **Rollback Plan:** Every deployment has rollback procedure
- [ ] **Maintenance Windows:** Scheduled with user notification
- [ ] **Post-Change Validation:** Smoke tests after deployment

---

## 11.4 Device Onboarding Security Audit

### Device Authentication & Authorization

**Certificate Management:**
- [ ] **PKI Infrastructure:** Internal CA for device certificates
- [ ] **Certificate Lifecycle:** Automated issuance, renewal, revocation
- [ ] **Certificate Validation:** CRL/OCSP checking enabled
- [ ] **Key Length:** Minimum 2048-bit RSA or 256-bit ECC
- [ ] **Certificate Pinning:** Birth certificates store device public keys

**HMAC Verification:**
```python
# Audit: Verify HMAC signature validation in discovery service
def audit_hmac_verification():
    # Test with valid HMAC
    valid_device = create_test_device()
    response = valid_device.send_check_in()
    assert response.status_code == 200
    
    # Test with invalid HMAC (tampered payload)
    invalid_device = create_test_device()
    invalid_device.tamper_payload()
    response = invalid_device.send_check_in()
    assert response.status_code == 401  # Unauthorized
    
    # Test with replay attack (old timestamp)
    replay_device = create_test_device()
    replay_device.set_timestamp(time.time() - 3600)  # 1 hour old
    response = replay_device.send_check_in()
    assert response.status_code == 401  # Rejected
```

### Network Security Audit

**SNMPv3 Configuration:**
- [ ] **SNMPv1/v2c Disabled:** Only SNMPv3 allowed
- [ ] **Authentication:** SHA-256 or stronger
- [ ] **Encryption:** AES-256 or stronger
- [ ] **User Isolation:** Unique SNMP credentials per device
- [ ] **Community String:** No default/weak community strings

**TLS Configuration:**
- [ ] **TLS Version:** TLS 1.3 only (1.2 minimum)
- [ ] **Cipher Suites:** Only strong ciphers (ECDHE, AES-GCM)
- [ ] **Certificate Validation:** Mutual TLS enforced
- [ ] **Perfect Forward Secrecy:** Enabled

---

## 11.5 Compliance Testing

### Pre-Production Compliance Tests

**Test 1: Unauthorized Access Prevention**
```bash
#!/bin/bash
# Test: Attempt unauthorized API access

# Without JWT token
curl -X GET https://nms.example.com/api/v1/devices
# Expected: 401 Unauthorized

# With expired JWT token
curl -X GET https://nms.example.com/api/v1/devices \
  -H "Authorization: Bearer $EXPIRED_TOKEN"
# Expected: 401 Unauthorized

# With insufficient permissions (VIEWER accessing admin endpoint)
curl -X POST https://nms.example.com/api/v1/users \
  -H "Authorization: Bearer $VIEWER_TOKEN"
# Expected: 403 Forbidden
```

**Test 2: Data Encryption Verification**
```bash
# Test: Verify TLS 1.3 enforcement
openssl s_client -connect nms.example.com:443 -tls1_2
# Expected: Connection refused (TLS 1.2 disabled)

openssl s_client -connect nms.example.com:443 -tls1_3
# Expected: Connection successful

# Test: Verify cipher suites
nmap --script ssl-enum-ciphers -p 443 nms.example.com
# Expected: Only strong ciphers (ECDHE-RSA-AES256-GCM-SHA384, etc.)
```

**Test 3: GDPR Right to Erasure**
```python
# Test: Verify device data deletion
def test_gdpr_right_to_erasure():
    # Register test device
    device = register_test_device()
    device_id = device["deviceId"]
    
    # Verify device exists
    assert nms_api.get_device(device_id) is not None
    
    # Request deletion
    nms_api.delete_device(device_id)
    
    # Verify device deleted from all systems
    assert nms_api.get_device(device_id) is None  # Inventory
    assert scylla.query_kpi(device_id) == []  # KPI data
    assert mongo.alarms.find({"deviceId": device_id}).count() == 0  # Alarms
    
    # Verify audit log entry
    audit_log = mongo.audit_logs.find_one({"action": "DELETE_DEVICE", "resourceId": device_id})
    assert audit_log is not None
```

**Test 4: Audit Trail Verification**
```python
# Test: Verify all critical actions are logged
def test_audit_trail():
    critical_actions = [
        "USER_LOGIN",
        "DEVICE_REGISTER",
        "CONFIG_PUSH",
        "ALARM_ACKNOWLEDGE",
        "USER_CREATE",
        "USER_DELETE",
        "FIRMWARE_UPGRADE"
    ]
    
    for action in critical_actions:
        # Perform action
        perform_action(action)
        
        # Verify audit log entry
        audit_log = mongo.audit_logs.find_one({
            "action": action,
            "timestamp": {"$gte": datetime.now() - timedelta(minutes=1)}
        })
        
        assert audit_log is not None
        assert audit_log["actor"] is not None
        assert audit_log["ipAddress"] is not None
```

---

## 11.6 Regulatory Audit Report Template

### Executive Summary

**Audit Date:** [Date]
**Auditor:** [Name, Title]
**Scope:** UBR Open NMS Platform - 1M Device Onboarding
**Status:** ✅ Pass / ⚠️ Pass with Findings / ❌ Fail

### Audit Findings

| Finding ID | Category | Severity | Description | Remediation | Status |
|------------|----------|----------|-------------|-------------|--------|
| F-001 | Authentication | High | MFA not enforced for admin users | Implement MFA requirement | Open |
| F-002 | Encryption | Medium | MongoDB encryption at rest not enabled | Enable encryption in prod config | Open |
| F-003 | Access Control | Low | Service account keys not rotated quarterly | Implement key rotation policy | Open |
| F-004 | Monitoring | Medium | No alerting for failed login attempts > 10 | Configure AlertManager rule | Open |
| F-005 | Compliance | High | GDPR data retention policy not enforced | Implement TTL indexes | Open |

### Compliance Matrix

| Requirement | Compliant | Evidence | Notes |
|-------------|-----------|----------|-------|
| **SOC 2 - CC6.1 (Logical Access)** | ⚠️ Partial | JWT authentication, RBAC | MFA needed for admin |
| **SOC 2 - CC6.6 (Encryption)** | ⚠️ Partial | TLS 1.3 in transit | At-rest encryption needed |
| **SOC 2 - CC7.2 (Monitoring)** | ✅ Yes | Prometheus, Grafana, AlertManager | Complete |
| **ISO 27001 - A.9.2 (User Access)** | ✅ Yes | RBAC, access logs | Complete |
| **ISO 27001 - A.12.4 (Logging)** | ✅ Yes | Immutable audit logs | Complete |
| **GDPR - Art. 17 (Right to Erasure)** | ✅ Yes | Delete device API, verified | Complete |
| **GDPR - Art. 32 (Security)** | ⚠️ Partial | Encryption, access control | At-rest encryption needed |
| **NIST CSF - Protect** | ⚠️ Partial | Access control, encryption | MFA, at-rest encryption needed |

### Recommendations

**Priority 1 (Must Fix Before Production):**
1. Enable MongoDB encryption at rest
2. Implement MFA for admin users
3. Enforce GDPR data retention policies with TTL indexes

**Priority 2 (Fix Within 3 Months of Production):**
1. Implement automated service account key rotation
2. Configure alerting for security events
3. Conduct penetration testing

**Priority 3 (Continuous Improvement):**
1. Pursue ISO 27001 certification
2. Implement SOC 2 Type II attestation
3. Regular security training for engineers

---

## 11.7 Production Readiness Sign-Off

### Approval Checklist

**Technical Approval:**
- [ ] **CTO Approval:** Architecture reviewed and approved
- [ ] **VP Engineering:** Code quality and test coverage approved
- [ ] **Lead Security Engineer:** Security audit findings addressed
- [ ] **Lead DBA:** Database architecture approved

**Operational Approval:**
- [ ] **VP Operations:** Runbooks and procedures documented
- [ ] **NOC Manager:** 24/7 monitoring and alerting configured
- [ ] **Incident Manager:** Incident response plan tested
- [ ] **Capacity Planner:** Infrastructure capacity validated

**Compliance Approval:**
- [ ] **Chief Compliance Officer:** Regulatory requirements met
- [ ] **Data Protection Officer:** GDPR compliance verified
- [ ] **Legal Counsel:** Terms of service and privacy policy approved
- [ ] **Internal Audit:** Audit findings remediated or accepted

**Executive Approval:**
- [ ] **CEO:** Business case approved
- [ ] **CFO:** Budget allocated
- [ ] **Board of Directors:** Strategic alignment confirmed

### Sign-Off Form

```
PRODUCTION DEPLOYMENT APPROVAL

Project: UBR Open NMS - 1 Million Device Onboarding
Date: [Date]
Environment: Production

I hereby approve the deployment of the UBR Open NMS platform to production
with the capacity to onboard 1 million devices. I confirm that:

1. All Priority 1 audit findings have been remediated
2. Security controls are adequate for the risk profile
3. Operational procedures are documented and tested
4. Regulatory compliance requirements are met
5. Disaster recovery procedures are in place

Approved By:
_____________________________    ____________
[Name], [Title]                  Date

_____________________________    ____________
[Name], [Title]                  Date

_____________________________    ____________
[Name], [Title]                  Date
```

---

# 12. MONITORING & REPORTING

## 12.1 Onboarding Dashboard (Real-Time)

### Dashboard Metrics

```
┌─────────────────────────────────────────────────────────────┐
│ UBR NMS: 1M Device Onboarding Dashboard                    │
├─────────────────────────────────────────────────────────────┤
│ Current Wave: Wave 3 (200,000 devices)                     │
│ Progress: ████████████████░░░░░░ 65% (130,000 / 200,000)  │
│ ETA: 2 weeks 3 days                                         │
├─────────────────────────────────────────────────────────────┤
│ Success Rate: 99.87% (129,830 succeeded, 170 failed)      │
│ Avg Registration Time: 2.3 seconds/device                  │
│ Current Throughput: 1,200 devices/minute                   │
├─────────────────────────────────────────────────────────────┤
│ Top Failure Reasons:                                        │
│   1. Duplicate MAC address (87 devices)                    │
│   2. Invalid serial number format (45 devices)             │
│   3. mTLS certificate validation failed (23 devices)       │
│   4. SNMP connectivity timeout (15 devices)                │
├─────────────────────────────────────────────────────────────┤
│ Infrastructure Health:                                      │
│   ✅ Kubernetes: 200/200 nodes healthy                    │
│   ✅ MongoDB: 9/9 shards online, 2ms avg latency          │
│   ✅ ScyllaDB: 15/15 nodes online, 5ms P95 latency        │
│   ✅ Kafka: 0 lag, 7/7 brokers healthy                    │
│   ⚠️  Redis: 11/12 nodes healthy (1 restarting)           │
└─────────────────────────────────────────────────────────────┘
```

### Key Performance Indicators (KPIs)

| KPI | Target | Current | Status |
|-----|--------|---------|--------|
| **Onboarding Success Rate** | > 99% | 99.87% | ✅ On Track |
| **Avg Registration Time** | < 3 sec | 2.3 sec | ✅ Exceeding |
| **SNMP Poll Coverage** | 100% within 5 min | 100% | ✅ On Track |
| **Alarm Delivery Latency** | < 10 sec | 8 sec | ✅ On Track |
| **API Response P95** | < 200ms | 150ms | ✅ Exceeding |
| **System Uptime** | 99.95% | 99.98% | ✅ Exceeding |

---

## 12.2 Re-Batching Failed Devices

### Failure Analysis & Remediation

```bash
#!/bin/bash
# Retry failed devices in new batch

# Query failed devices from previous batch
FAILED_DEVICES=$(curl -s https://nms-api/api/v1/discovery/batches/BATCH-2027-001/failures)

# Analyze failure reasons
echo "$FAILED_DEVICES" | jq '.failures[] | .errorCode' | sort | uniq -c

# Output:
#  87 DUPLICATE_MAC
#  45 INVALID_SERIAL
#  23 MTLS_FAILED
#  15 SNMP_TIMEOUT

# Remediation actions:
# - DUPLICATE_MAC: Update device firmware, clear MAC table
# - INVALID_SERIAL: Correct in source CSV
# - MTLS_FAILED: Re-issue certificates
# - SNMP_TIMEOUT: Verify network connectivity

# Create retry batch
RETRY_BATCH_ID="BATCH-2027-001-RETRY"

curl -X POST https://nms-api/api/v1/discovery/batch-register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "$FAILED_DEVICES"

# Monitor retry batch
watch -n 5 "curl -s https://nms-api/api/v1/discovery/batches/$RETRY_BATCH_ID/status | jq '.'"
```

---

# 13. AI ENABLEMENT

## 13.1 AI-Assisted Onboarding Optimization

### Predictive Failure Detection

**Use Case:** Predict which devices are likely to fail onboarding based on historical patterns.

```python
# ML Model: Random Forest Classifier
# Features: device_type, firmware_version, vendor, region, network_latency
# Target: onboarding_success (True/False)

import pandas as pd
from sklearn.ensemble import RandomForestClassifier

# Load historical onboarding data
df = pd.read_csv("onboarding_history.csv")

# Features
X = df[["device_type", "firmware_version", "vendor", "region", "network_latency"]]
y = df["onboarding_success"]

# Train model
model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X, y)

# Predict failure probability for upcoming batch
upcoming_batch = pd.read_csv("wave3_devices.csv")
failure_prob = model.predict_proba(upcoming_batch[X.columns])[:, 0]

# Flag high-risk devices (> 20% failure probability)
high_risk = upcoming_batch[failure_prob > 0.2]
print(f"High-risk devices: {len(high_risk)}")

# Proactive remediation
for idx, device in high_risk.iterrows():
    if device["firmware_version"] < "9.0":
        send_firmware_upgrade_notice(device)
    if device["network_latency"] > 100:
        schedule_network_optimization(device)
```

---

### Intelligent Batch Sizing

**Use Case:** Dynamically adjust batch size based on real-time system health.

```python
def calculate_optimal_batch_size():
    # Get current system metrics
    cpu_usage = prometheus.query("avg(cpu_usage)")
    memory_usage = prometheus.query("avg(memory_usage)")
    kafka_lag = prometheus.query("sum(kafka_consumer_lag)")
    db_latency = prometheus.query("avg(mongodb_query_latency)")
    
    # Scoring algorithm
    health_score = (
        (1 - cpu_usage) * 0.3 +
        (1 - memory_usage) * 0.3 +
        (1 - min(kafka_lag / 10000, 1)) * 0.2 +
        (1 - min(db_latency / 100, 1)) * 0.2
    )
    
    # Batch size: 5K (poor health) to 20K (excellent health)
    optimal_batch_size = int(5000 + (health_score * 15000))
    
    return optimal_batch_size

# Adaptive onboarding
while devices_remaining > 0:
    batch_size = calculate_optimal_batch_size()
    submit_batch(devices[:batch_size])
    devices = devices[batch_size:]
    time.sleep(300)  # 5-min interval
```

---

### Anomaly Detection for Device Behavior

**Use Case:** Detect abnormal device behavior post-onboarding.

```python
# ML Model: Isolation Forest for anomaly detection
# Features: cpu_usage, memory_usage, packet_loss, alarm_count, kpi_variance

from sklearn.ensemble import IsolationForest

# Train on normal device behavior
normal_devices = scylla.query_kpi(status="NORMAL", last_30_days=True)
X_train = extract_features(normal_devices)

model = IsolationForest(contamination=0.05, random_state=42)
model.fit(X_train)

# Detect anomalies in newly onboarded devices
new_devices = scylla.query_kpi(onboarded_last_week=True)
X_test = extract_features(new_devices)

anomalies = model.predict(X_test)  # -1 = anomaly, 1 = normal

# Alert operations team
for idx, device in enumerate(new_devices):
    if anomalies[idx] == -1:
        send_alert(f"Anomaly detected: {device['deviceId']}")
```

---

# 14. IMPLEMENTATION ROADMAP

## 14.1 Phased Implementation Timeline

### Phase 1: Foundation (Months 1-6)

**Q1 (Months 1-3):**
- Refactor critical bottlenecks
- Implement MongoDB sharding
- Increase Kafka partitions
- Deploy ScyllaDB cluster
- Implement batch onboarding API
- **Deliverable:** System supports 50K devices

**Q2 (Months 4-6):**
- Build automation testing framework
- Setup Pre-Production environment
- Infrastructure as Code (Terraform)
- Pilot onboarding: 10K devices
- **Deliverable:** Validated onboarding process

---

### Phase 2: Scale-Up (Months 7-12)

**Q3 (Months 7-9):**
- Setup Production environment
- Deploy DR site (EU region)
- Wave 1-2 onboarding: 150K devices
- Performance tuning
- **Deliverable:** System supports 200K devices

**Q4 (Months 10-12):**
- Wave 3 onboarding: 200K devices (cumulative: 350K)
- Optimize query performance
- Implement multi-region Active-Active (optional)
- **Deliverable:** System supports 500K devices

---

### Phase 3: Full Scale (Months 13-18)

**Q1 Next Year (Months 13-15):**
- Wave 4 onboarding: 300K devices (cumulative: 650K)
- Fine-tune HPA policies
- Expand ScyllaDB cluster if needed
- **Deliverable:** System supports 750K devices

**Q2 Next Year (Months 16-18):**
- Wave 5 onboarding: 340K devices (cumulative: 990K)
- Final 10K devices onboarded
- **MILESTONE: 1 MILLION DEVICES LIVE**
- Post-deployment monitoring & optimization
- **Deliverable:** Production-grade 1M device NMS

---

# 15. RISK ASSESSMENT

## 15.1 Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| Database performance degradation | High | Medium | Early sharding, aggressive indexing, query optimization |
| Kafka broker failures during onboarding | High | Low | 7 brokers with RF=3, DLQ topics, monitoring |
| SNMP polling overload | High | Medium | Increase KPI collector replicas to 300, circuit breakers |
| Network bandwidth saturation | Medium | Low | 25 Gbps network for edge nodes, traffic shaping |
| Vendor device incompatibility | Medium | High | Extensive pre-validation, device simulator with 100+ profiles |
| Team knowledge gaps | Medium | High | Training, hire specialists |
| Delayed infrastructure provisioning | High | Medium | Start IaC development early, parallel provisioning |

---

## 15.2 Operational Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| Human error during deployment | High | Medium | Automation, peer review, canary deployments |
| Insufficient runbook documentation | Medium | High | Comprehensive runbooks, incident drills |
| Inadequate monitoring coverage | Medium | Medium | Prometheus metrics, Grafana dashboards, AlertManager |
| On-call fatigue | Low | Medium | Rotate on-call duties, automate remediation |
| Configuration drift | Medium | Low | Infrastructure as Code, configuration management |

---

## 15.3 Success Criteria

### Onboarding Phase

✅ **Pilot (10K devices):** 95%+ success rate, < 3 sec/device
✅ **Wave 1-2 (150K devices):** 98%+ success rate, < 2.5 sec/device
✅ **Wave 3-5 (840K devices):** 99%+ success rate, < 2 sec/device
✅ **Full 1M:** 99.5%+ success rate, < 2 sec/device

### Performance

✅ **SNMP Poll Cycle:** All 1M devices polled within 5 minutes
✅ **API Response P95:** < 200ms
✅ **Alarm Delivery:** < 10 seconds
✅ **Dashboard Load:** < 3 seconds

### Reliability

✅ **Uptime SLA:** 99.95% (21 min/month max)
✅ **RTO:** < 15 minutes
✅ **RPO:** < 5 minutes
✅ **Zero data loss during onboarding**

---

## CONCLUSION

The UBR Open NMS platform requires significant architectural enhancements to scale from 500 to 1 million devices. Key challenges include database sharding, time-series data management, SNMP polling concurrency, and regulatory compliance.

**Feasibility:** ✅ Achievable with proper investment and execution
**Timeline:** 18-24 months to full 1M device capacity
**Critical Success Factors:**
1. Executive commitment to scope and timeline
2. Skilled engineering team with distributed systems expertise
3. Phased approach with extensive testing at each stage
4. Strong DevOps culture and automation-first mindset
5. Regulatory compliance throughout development
6. Close collaboration with device vendors

**Next Steps:**
1. Present to executive leadership for approval
2. Recruit engineering team
3. Kickoff Phase 1 development
4. Conduct regulatory pre-audit
5. Begin infrastructure provisioning

---

**Document Prepared By:** UBR NMS Architecture Team
**Reviewed By:** CTO, VP Engineering, VP Operations, Chief Compliance Officer
**Approval Required:** CEO, CFO, Board of Directors

**Last Updated:** July 14, 2026
**Version:** 2.0

---

END OF DOCUMENT

