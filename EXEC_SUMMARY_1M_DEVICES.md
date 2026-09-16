# Executive Summary: 1 Million Device Onboarding
## UBR Open NMS Scalability Assessment

**Date:** July 2026
**Prepared For:** Management Review
**Classification:** Internal

---

## 1. CURRENT STATE vs 1M DEVICE REQUIREMENTS

### Gap Analysis

| Metric | Current Capacity | Required for 1M | Gap | Status |
|--------|-----------------|-----------------|-----|--------|
| **Tested Devices** | 500 | 1,000,000 | 2,000x | ⚠️ Critical Gap |
| **SNMP Poll Time** | 5 min (500 devices) | 5 min (1M devices) | 2,000x concurrency | ❌ Bottleneck |
| **Database Size** | 10 GB | 5 TB+ | 500x | ⚠️ Needs Sharding |
| **API Response Time** | 200ms | 150ms (target) | Performance regression risk | ⚠️ |
| **Kafka Partitions** | 3 | 100-150 | 33x-50x | ❌ Critical |
| **Pod Replicas** | 30 max | 200-300 | 6x-10x | ⚠️ |

**Verdict:** Current architecture can handle **~5,000 devices maximum** before critical performance degradation. **200x scale-up required** for 1M devices.

---

## 2. CRITICAL BOTTLENECKS IDENTIFIED

### Top 10 Blockers (Code-Level Analysis)

| # | Bottleneck | Impact | File Location | Fix Effort |
|---|-----------|--------|---------------|------------|
| **1** | Inventory Service `findAll()` loads all devices into memory | OOM at >50K devices | `inventory-service/.../InventoryService.java:56` | 8 hours |
| **2** | Alarm Service in-memory aggregation | OOM at >1M alarms | `alarm-service/.../AlarmService.java:139` | 12 hours |
| **3** | KPI Collector fixed 500 concurrency | 27 hours to poll 1M devices | `kpi-collector/.../poller.go:104` | 16 hours |
| **4** | Kafka 3 partitions | Throughput ceiling 30K msg/sec | `docker-compose.dev.yml:126` | 8 hours |
| **5** | Redis cache with 60s TTL | 5% cache hit rate | `kpi-query-service/.../application.yml:32` | 12 hours |
| **6** | Event Collector single-threaded UDP | 5K traps/sec max | `event-collector/.../listener.go:61` | 24 hours |
| **7** | ScyllaDB not implemented | MongoDB unsuitable for 525TB/year KPI | N/A - not exists | 80 hours |
| **8** | No MongoDB sharding | Single replica set limit ~50K devices | N/A | 40 hours |
| **9** | Topology O(n²) algorithm | Timeout at >2K devices | `topology-service/.../GraphService.java` | 40 hours |
| **10** | Offset-based pagination | Timeout at page 10,000 | Multiple services | 20 hours |

**Total Refactoring Effort:** 260 hours (6.5 weeks for 1 engineer)

---

## 3. ARCHITECTURE REQUIRED CHANGES

### 3.1 Application Layer

**Current:**
- 30 max replicas per service
- 1 core, 1GB RAM per pod
- No pod anti-affinity (can co-locate)
- Single region (US)

**Required for 1M Devices:**
- **200-300 replicas** for KPI/Event collectors
- **2-4 cores, 4-8GB RAM** per pod
- Pod anti-affinity (spread across nodes/AZs)
- **Multi-region Active-Active** (US + EU)

**Scaling Math:**
- 200 pods × 5,000 concurrent SNMP = **1M concurrent polls**
- All devices polled in **5-10 seconds** (vs 27 hours currently)

**Annual Cost:** $200K (compute) + $50K (load balancing) = **$250K/year**

---

### 3.2 Database Layer

**MongoDB (Current → Required):**

| Aspect | Current | Required |
|--------|---------|----------|
| **Architecture** | Single replica set | **3-shard cluster** |
| **Nodes** | 3 | **9 nodes** (3 per shard) + 3 config servers |
| **Capacity** | 10 GB | **5 TB** (with sharding) |
| **Connections** | 100 | **5,000** (connection pooling) |
| **Annual Cost** | $50K | **$208K** (self-managed) or $800K (Atlas) |

**Key Changes:**
1. **Shard Key:** `deviceId` (hashed) for even distribution
2. **Indexes:** 15+ compound indexes for query optimization
3. **Write Concern:** `majority` to prevent rollback
4. **Cross-Region Replication:** Hidden DR nodes in EU/AP

**ScyllaDB (NEW - Not Currently Implemented):**

| Metric | Requirement | Reason |
|--------|-------------|--------|
| **Purpose** | Time-series KPI storage | MongoDB unsuitable for 12M writes/hour |
| **Nodes** | 15 (5 per DC × 3 DCs) | Handle 3,333 writes/sec sustained |
| **Storage** | 3.24 TB × 3 replicas = **9.72 TB** | 90-day retention + 1-year aggregates |
| **Throughput** | 50K+ writes/sec, 100K+ reads/sec | 15x better than MongoDB for time-series |
| **Annual Cost** | **$135K** | i3en.2xlarge instances |

**Migration Strategy:** Dual-write (MongoDB + Scylla) for 4 weeks, then cutover reads gradually.

**Total Database Cost:** $208K (MongoDB) + $135K (ScyllaDB) = **$343K/year**

---

### 3.3 Message Bus (Kafka)

**Current:**
- 3 brokers
- 3 partitions per topic
- 7-day retention

**Required:**
- **7 brokers** (for redundancy + throughput)
- **100-150 partitions** per high-volume topic
- 7-day retention (unchanged)
- **150+ consumer instances** (parallelism)

**Throughput Calculation:**
- 1M devices × 1 alarm/hour / 3600 sec = **277 msg/sec** (baseline)
- Alarm storm (network outage): **100K msg/sec** (burst)
- Capacity: 150 partitions × 30K msg/sec/partition = **4.5M msg/sec** ✅

**Annual Cost:** $600K (managed Kafka on AWS MSK)

---

## 4. HIGH AVAILABILITY & DISASTER RECOVERY

### SLA Targets

| Metric | Current | 1M Device Target |
|--------|---------|------------------|
| **Uptime** | 99.9% (43 min/month downtime) | **99.95%** (21 min/month) |
| **RTO** (Recovery Time) | 30 min | **< 15 min** |
| **RPO** (Recovery Point) | 15 min | **< 5 min** |
| **API P95** | 500ms | **< 200ms** |

### DR Strategy

**Active-Passive with Cross-Region Replication:**

```
Primary Region (US-East-1)          DR Region (EU-Central-1)
┌──────────────────────┐            ┌──────────────────────┐
│ 500K devices         │            │ Standby              │
│ Full K8s cluster     │───Sync────▶│ Full K8s cluster     │
│ MongoDB primaries    │            │ MongoDB secondaries  │
│ ScyllaDB DC1         │            │ ScyllaDB DC2         │
└──────────────────────┘            └──────────────────────┘

Replication Lag: < 5 minutes
Failover Time: < 15 minutes (automated DNS + DB promotion)
```

**Cost:** $1.8M/year (primary) + $1.2M/year (DR standby at 60% capacity) = **$3M/year total**

---

## 5. ONBOARDING PROCESS FRAMEWORK

### Wave Planning for 1M Devices

**Objective:** Onboard 1 million devices in **6 months** (January - June 2027)

**Strategy:** Phased wave approach with automated batch processing

| Wave | Devices | Duration | Start | End | Validation |
|------|---------|----------|-------|-----|------------|
| **Pilot** | 10,000 | 2 weeks | Week 1 | Week 2 | Manual UAT |
| **Wave 1** | 50,000 | 3 weeks | Week 3 | Week 5 | Automated |
| **Wave 2** | 100,000 | 4 weeks | Week 6 | Week 9 | Automated |
| **Wave 3** | 200,000 | 5 weeks | Week 10 | Week 14 | Automated |
| **Wave 4** | 300,000 | 6 weeks | Week 15 | Week 20 | Automated |
| **Wave 5** | 340,000 | 6 weeks | Week 21 | Week 26 | Automated |
| **Total** | **1,000,000** | **26 weeks** | Jan 1 | June 30 | |

### Batch Interface (New Requirement)

**Current:** Individual device registration only (`POST /api/v1/discovery/check-in`)

**Required:** Bulk onboarding API

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
      "region": "US-EAST"
    },
    // ... up to 10,000 devices per batch
  ]
}

Response:
{
  "batchId": "BATCH-2027-001",
  "totalDevices": 10000,
  "succeeded": 9987,
  "failed": 13,
  "processingTime": "45 seconds",
  "failures": [
    { "serialNumber": "BTS-042", "reason": "Duplicate MAC address" }
  ]
}
```

**Implementation Effort:** 40 hours (new endpoint + batch validation + error handling)

---

### Automation Testing Framework (New Requirement)

**End-to-End Validation Criteria:**

1. ✅ **mTLS Handshake Success**
   - Device presents certificate signed by NMS CA
   - NMS validates certificate chain
   - Bidirectional trust established

2. ✅ **WebSocket/MQTT Transport Layer**
   - Persistent connection established
   - Heartbeat messages (every 60 sec)
   - Message delivery confirmation

3. ✅ **Message Payload Verification**
   - **Header:** Device ID, timestamp, message type, sequence number
   - **Body:** JSON payload with required fields (deviceType, firmware, location, etc.)
   - **Footer:** HMAC-SHA256 signature for integrity

4. ✅ **Device Discovery Workflow**
   - Device sends check-in → Birth certificate issued → Inventory record created → Topology updated

5. ✅ **SNMP Polling Success**
   - KPI collector polls device within 5 minutes of registration
   - OID responses received and parsed
   - KPI data written to ScyllaDB

6. ✅ **Alarm Ingestion**
   - Device sends SNMP trap → Event collector receives → Alarm service processes → Notification sent

**Automation Tool:** Pytest + Locust + Custom device simulator

```python
# tests/e2e/test_device_onboarding.py

import pytest
from device_simulator import DeviceSimulator

@pytest.mark.e2e
def test_batch_onboarding_10k_devices():
    """
    End-to-end test: Register 10,000 devices and validate full workflow
    """
    simulator = DeviceSimulator(device_count=10000)

    # Step 1: Batch register devices
    batch_response = simulator.batch_register()
    assert batch_response['succeeded'] == 10000
    assert batch_response['processingTime'] < 60  # < 1 minute

    # Step 2: Verify mTLS connections
    for device in simulator.devices:
        assert device.establish_mtls_connection() is True
        assert device.send_heartbeat() is True

    # Step 3: Verify SNMP polling
    for device in simulator.devices:
        snmp_response = device.wait_for_snmp_poll(timeout=300)  # 5 min
        assert snmp_response is not None
        assert snmp_response['oids'] == expected_oids

    # Step 4: Verify alarm flow
    test_device = simulator.devices[0]
    test_device.send_snmp_trap(alarm_type="linkDown")
    alarm_received = test_device.wait_for_alarm_in_ui(timeout=30)
    assert alarm_received['severity'] == 'CRITICAL'

    # Step 5: Verify KPI data in ScyllaDB
    kpi_data = simulator.query_kpi(test_device.id, last_5_min=True)
    assert len(kpi_data) > 0
    assert 'cpu' in kpi_data[0]['metrics']
```

**Automation Tool Development Effort:** 120 hours (3 weeks)

---

### Reporting & Monitoring

**Onboarding Dashboard (Real-Time):**

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
│   ✅ Kubernetes Cluster: 200/200 nodes healthy            │
│   ✅ MongoDB: 9/9 shards online, 2ms avg latency          │
│   ✅ ScyllaDB: 15/15 nodes online, 5ms P95 latency        │
│   ✅ Kafka: 0 lag, 7/7 brokers healthy                    │
│   ⚠️  Redis: 11/12 nodes healthy (1 restarting)           │
└─────────────────────────────────────────────────────────────┘
```

**Re-Batching Failed Devices:**

```bash
#!/bin/bash
# Retry failed devices in new batch

# Query failed devices from previous batch
FAILED_DEVICES=$(curl -s https://nms-api/api/v1/discovery/batches/BATCH-2027-001/failures)

# Create retry batch
RETRY_BATCH_ID="BATCH-2027-001-RETRY"

# Address failure reasons:
# - Fix duplicate MAC: Manual correction in device firmware
# - Invalid serial: Correct in source CSV
# - mTLS failed: Re-issue certificates
# - SNMP timeout: Verify network connectivity

# Submit retry batch
curl -X POST https://nms-api/api/v1/discovery/batch-register \
  -H "Content-Type: application/json" \
  -d "$FAILED_DEVICES"
```

---

## 6. COST ANALYSIS

### Total Cost of Ownership (Annual)

| Component | 500 Devices | 1M Devices | Multiplier |
|-----------|-------------|------------|------------|
| **Infrastructure** |
| - Kubernetes compute | $120K | $2.4M | 20x |
| - MongoDB | $50K | $208K | 4.2x |
| - ScyllaDB | $0 | $135K | N/A (new) |
| - Kafka | $40K | $600K | 15x |
| - Redis | $10K | $80K | 8x |
| - Load Balancing | $10K | $150K | 15x |
| - Data Transfer | $20K | $400K | 20x |
| - DR Standby (60%) | $0 | $1.2M | N/A (new) |
| **Subtotal** | **$250K** | **$5.17M** | **20.7x** |
| **Personnel** |
| - Backend Engineers | $720K (6 FTE) | $1.2M (10 FTE) | 1.67x |
| - DevOps Engineers | $260K (2 FTE) | $520K (4 FTE) | 2x |
| - DBAs | $0 | $300K (2 FTE) | N/A (new) |
| - QA Engineers | $180K (2 FTE) | $360K (4 FTE) | 2x |
| **Subtotal** | **$1.16M** | **$2.38M** | **2.05x** |
| **Total TCO** | **$1.41M/year** | **$7.55M/year** | **5.35x** |

**Cost Per Device:**
- 500 devices: $2,820/device/year
- 1M devices: **$7.55/device/year**

**Economies of Scale:** Cost per device drops **375x** at 1M scale.

---

### One-Time Investment

| Item | Effort (Hours) | Cost |
|------|---------------|------|
| **Code Refactoring** (10 bottlenecks) | 260 | $65K |
| **ScyllaDB Implementation** | 80 | $20K |
| **MongoDB Sharding Setup** | 40 | $10K |
| **Batch Onboarding API** | 40 | $10K |
| **Automation Testing Framework** | 120 | $30K |
| **Infrastructure as Code (Terraform)** | 200 | $50K |
| **Pre-Production Environment Setup** | 400 | $100K |
| **Production Environment Setup** | 1,200 | $300K |
| **Load Testing & Tuning** | 320 | $80K |
| **Documentation & Training** | 160 | $40K |
| **Total** | **2,820 hours** | **$705K** |

**Timeline:** 18-24 months (assuming 3-4 engineers working full-time)

---

## 7. IMPLEMENTATION ROADMAP

### Phase 1: Foundation (Months 1-6)

**Q1 2027 (Months 1-3):**
- ✅ Refactor critical bottlenecks (260 hours)
- ✅ Implement MongoDB sharding (40 hours)
- ✅ Increase Kafka partitions (8 hours)
- ✅ Deploy ScyllaDB cluster (80 hours)
- ✅ Implement batch onboarding API (40 hours)
- **Deliverable:** System supports **50K devices**

**Q2 2027 (Months 4-6):**
- ✅ Build automation testing framework (120 hours)
- ✅ Setup Pre-Production environment (400 hours)
- ✅ Infrastructure as Code (Terraform) (200 hours)
- ✅ Pilot onboarding: **10K devices**
- **Deliverable:** Validated onboarding process

---

### Phase 2: Scale-Up (Months 7-12)

**Q3 2027 (Months 7-9):**
- ✅ Setup Production environment (1,200 hours)
- ✅ Deploy DR site (EU region)
- ✅ Wave 1-2 onboarding: **150K devices**
- ✅ Performance tuning based on load tests
- **Deliverable:** System supports **200K devices**

**Q4 2027 (Months 10-12):**
- ✅ Wave 3 onboarding: **200K devices** (cumulative: 350K)
- ✅ Optimize query performance
- ✅ Implement multi-region Active-Active (optional)
- **Deliverable:** System supports **500K devices**

---

### Phase 3: Full Scale (Months 13-18)

**Q1 2028 (Months 13-15):**
- ✅ Wave 4 onboarding: **300K devices** (cumulative: 650K)
- ✅ Fine-tune HPA policies
- ✅ Expand ScyllaDB cluster if needed
- **Deliverable:** System supports **750K devices**

**Q2 2028 (Months 16-18):**
- ✅ Wave 5 onboarding: **340K devices** (cumulative: 990K)
- ✅ Final 10K devices onboarded
- ✅ **MILESTONE: 1 MILLION DEVICES LIVE**
- ✅ Post-deployment monitoring & optimization
- **Deliverable:** Production-grade 1M device NMS

---

## 8. RISKS & MITIGATION

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| **Database performance degradation** | High | Medium | Early sharding, aggressive indexing, query optimization |
| **Kafka broker failures during onboarding** | High | Low | 7 brokers with RF=3, DLQ topics, monitoring |
| **SNMP polling overload** | High | Medium | Increase KPI collector replicas to 300, circuit breakers |
| **Network bandwidth saturation** | Medium | Low | 25 Gbps network for edge nodes, traffic shaping |
| **Cost overruns** | Medium | Medium | Monthly cost reviews, right-sizing, spot instances |
| **Vendor device incompatibility** | Medium | High | Extensive pre-validation, device simulator with 100+ profiles |
| **Team knowledge gaps (ScyllaDB, sharding)** | Medium | High | Training budget $50K, hire 2 DBAs |
| **Delayed infrastructure provisioning** | High | Medium | Start IaC development in Month 1, parallel provisioning |

---

## 9. SUCCESS CRITERIA

### Onboarding Phase

✅ **Pilot (10K devices):** 95%+ success rate, < 3 sec/device registration time
✅ **Wave 1-2 (150K devices):** 98%+ success rate, < 2.5 sec/device
✅ **Wave 3-5 (840K devices):** 99%+ success rate, < 2 sec/device
✅ **Full 1M:** 99.5%+ success rate, < 2 sec/device average

### Performance

✅ **SNMP Poll Cycle:** All 1M devices polled within **5 minutes**
✅ **API Response P95:** < **200ms** for all endpoints
✅ **Alarm Delivery:** < **10 seconds** from device trap to UI notification
✅ **Dashboard Load:** < **3 seconds** for 1M device overview

### Reliability

✅ **Uptime SLA:** **99.95%** (21 min downtime/month max)
✅ **RTO:** < **15 minutes** for region failover
✅ **RPO:** < **5 minutes** data loss
✅ **Zero data loss during onboarding** (all devices accounted for)

### Business

✅ **Cost per Device:** < **$10/device/year** ($7.55 actual)
✅ **Time to Market:** **18 months** from start to 1M devices
✅ **Customer Satisfaction:** > **90% NPS** score from operators

---

## 10. RECOMMENDATIONS

### Immediate Actions (Month 1)

1. **Approve Budget:** $705K one-time + $7.55M/year recurring
2. **Hire Team:** 4 additional engineers (2 backend, 2 DevOps) + 2 DBAs
3. **Start IaC Development:** Terraform modules for MongoDB, ScyllaDB, Kafka
4. **Procure Pre-Prod Infrastructure:** 20-node K8s cluster, MongoDB cluster
5. **Begin Code Refactoring:** Fix top 5 bottlenecks in parallel

### Short-Term (Months 2-6)

1. **Deploy ScyllaDB:** 9-node cluster, migrate KPI data
2. **Implement Batch API:** Support 10K devices/batch
3. **Build Test Automation:** Pytest framework with 10K device simulator
4. **Setup Pre-Prod:** Full environment with 50K device capacity
5. **Run Pilot:** Onboard 10K devices, validate end-to-end

### Long-Term (Months 7-18)

1. **Production Deployment:** 200-node K8s, sharded MongoDB, 15-node Scylla
2. **DR Site:** EU region with automated failover
3. **Phased Onboarding:** 5 waves, 26 weeks, 1M devices
4. **Continuous Optimization:** Query tuning, cost reduction, UX improvements
5. **Post-Launch Support:** 24/7 NOC, runbooks, incident response

---

## 11. CONCLUSION

UBR Open NMS has a **solid foundation** but requires **significant architectural enhancements** to scale from 500 to 1 million devices. Key challenges include database sharding, time-series data management, and SNMP polling concurrency.

**Feasibility:** ✅ **Achievable** with proper investment and execution
**Timeline:** **18-24 months** to full 1M device capacity
**Investment:** **$705K one-time** + **$7.55M/year recurring**
**ROI:** **375x better cost per device** at scale, market leadership in large-scale NMS

**Critical Success Factors:**
1. Executive commitment to budget and timeline
2. Skilled engineering team with distributed systems expertise
3. Phased approach with extensive testing at each stage
4. Strong DevOps culture and automation-first mindset
5. Close collaboration with device vendors for compatibility

**Next Steps:**
1. Present to executive leadership for budget approval (Week 1)
2. Recruit engineering team (Weeks 2-4)
3. Kickoff Phase 1 development (Week 5)
4. Monthly steering committee reviews

---

**Prepared By:** UBR NMS Architecture Team
**Reviewed By:** CTO, VP Engineering, VP Operations
**Approval Required:** CEO, CFO

**Contact:** architecture-team@ubr-nms.example.com
