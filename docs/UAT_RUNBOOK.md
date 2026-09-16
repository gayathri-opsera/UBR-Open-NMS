# WO-071: Customer UAT Runbook

## Prerequisites

- UBR NMS deployed and accessible
- Test devices configured (BTS, CPE, IDU)
- Test user accounts created with appropriate roles
- Network connectivity validated

## Test Scenarios

### 1. Device Onboarding
**Objective**: Validate UBR call-home and generic SNMP discovery

**Steps**:
1. Navigate to Discovery → Discovery Management
2. Enable "UBR Call-Home" mode
3. Enable "Generic SNMP" mode
4. Power on test BTS device (Serial: TEST-BTS-001)
5. Verify device appears in Inventory within 5 minutes
6. Check device status shows "ONLINE" with green indicator

**Expected Outcome**: Device onboarded, visible in inventory, online status established

### 2. KPI Monitoring
**Objective**: Verify KPI collection and threshold breaches

**Steps**:
1. Navigate to Monitoring → KPI Dashboard
2. Select device TEST-BTS-001
3. View latency, packet loss, throughput metrics
4. Configure threshold: Latency > 50ms = WARNING
5. Generate test traffic to trigger breach

**Expected Outcome**: KPI data displays, threshold breach generates alarm

### 3. Alarm Management
**Objective**: Validate alarm lifecycle and notifications

**Steps**:
1. Navigate to Alarms → Active Alarms
2. Verify alarm from Step 2 appears
3. Acknowledge alarm
4. Verify notification sent (check email/webhook)
5. Clear alarm condition
6. Verify alarm auto-clears

**Expected Outcome**: Full alarm lifecycle functional, notifications delivered

### 4. Configuration Management
**Objective**: Push configuration to device

**Steps**:
1. Navigate to Configuration → Templates
2. Select device TEST-BTS-001
3. Apply configuration template
4. Verify configuration pushed successfully
5. View configuration history

**Expected Outcome**: Configuration applied, version history maintained

### 5. Topology Visualization
**Objective**: Verify topology discovery and visualization

**Steps**:
1. Navigate to Topology → Network Map
2. Verify TEST-BTS-001 and connected CPE devices shown
3. Check parent-child relationships correct
4. View device health overlay
5. Filter by device type

**Expected Outcome**: Topology accurate, relationships correct, health displayed

### 6. SLA Reporting
**Objective**: Generate QoS compliance reports

**Steps**:
1. Navigate to Reports → SLA Reports
2. Select device TEST-BTS-001
3. Set time range: Last 24 hours
4. Generate report
5. Export to PDF

**Expected Outcome**: Report generated, metrics accurate, export successful

### 7. User Access Control
**Objective**: Validate RBAC enforcement

**Steps**:
1. Login as "operator" role user
2. Verify read-only access to devices
3. Attempt configuration change (should fail)
4. Login as "admin" role user
5. Verify full access including configuration

**Expected Outcome**: RBAC enforced, appropriate permissions per role

### 8. Evidence Export
**Objective**: Export incident evidence package

**Steps**:
1. Navigate to Alarms → Active Alarms
2. Select critical alarm
3. Click "Export Evidence"
4. Verify ZIP package downloaded
5. Extract and verify contents (alarms.json, kpi_data.json, topology.json)

**Expected Outcome**: Evidence package complete, all data included

### 9. Failover Testing
**Objective**: Validate system resilience

**Steps**:
1. Monitor active devices
2. Simulate service failure (stop one service container)
3. Verify graceful degradation
4. Restart service
5. Verify recovery

**Expected Outcome**: System maintains availability, recovers automatically

### 10. Audit Trail
**Objective**: Verify audit logging compliance

**Steps**:
1. Navigate to Admin → Audit Log
2. Search for configuration changes from Step 4
3. Verify all actions logged with timestamp, user, details
4. Export audit log for time range
5. Verify export completeness

**Expected Outcome**: All actions audited, export complete and accurate

## Test Data Setup

### Test Devices
- **BTS**: Serial TEST-BTS-001, MAC AA:BB:CC:DD:01:01, IP 10.100.1.1
- **CPE-1**: Serial TEST-CPE-001, MAC AA:BB:CC:DD:02:01, IP 10.100.2.1
- **CPE-2**: Serial TEST-CPE-002, MAC AA:BB:CC:DD:02:02, IP 10.100.2.2

### Test Users
- **Admin**: admin@test.local / Admin@123
- **Operator**: operator@test.local / Operator@123
- **Auditor**: auditor@test.local / Auditor@123

## Acceptance Criteria

- All 10 scenarios pass without errors
- Performance meets SLA: <2s page load, <5s API response
- No security vulnerabilities identified
- Audit trail complete for all actions
- Evidence exports contain required data

## Troubleshooting

### Device Not Onboarding
- Check network connectivity
- Verify discovery mode enabled
- Check device certificates
- Review discovery service logs

### Alarms Not Triggering
- Verify KPI collection active
- Check threshold configuration
- Review alarm service logs
- Validate device online status

### Performance Issues
- Check database connection pool
- Review Kafka consumer lag
- Verify Redis cache hit rate
- Check resource utilization

## Sign-Off

**Tested By**: _________________  **Date**: _________

**Approved By**: _________________  **Date**: _________

**Notes**: ________________________________________________
