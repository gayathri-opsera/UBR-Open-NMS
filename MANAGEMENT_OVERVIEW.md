# UBR Open Network Management System (NMS)
## Comprehensive Technical Overview & Roadmap

**Document Version:** 1.0
**Date:** July 2026
**Classification:** Internal - Management Review

---

## Executive Summary

UBR Open NMS is a modern, cloud-native network management system designed for managing wireless telecommunications equipment including BTS (Base Transceiver Stations), CPE (Customer Premises Equipment), and IDU (Indoor Units). The system leverages a polyglot microservices architecture built on industry-standard technologies including Kubernetes, Apache Kafka, and React, providing enterprise-grade scalability, reliability, and operational capabilities.

---

## 1. Technology Stack

### 1.1 Frontend Architecture

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| UI Framework | React | 19.2.7 | Component-based user interface |
| Language | TypeScript | 6.0.2 | Type-safe development |
| Build Tool | Vite | 8.1.1 | Fast development & production builds |
| State Management | React Query | 5.101.2 | Server state synchronization |
| Routing | React Router | 6.30.4 | Client-side navigation |
| Data Visualization | D3.js, Recharts, Leaflet | Latest | Charts, graphs, and mapping |
| HTTP Client | Axios | 1.18.1 | API communication |

**Key Features:**
- Modern, responsive single-page application (SPA)
- Real-time updates via Server-Sent Events (SSE)
- Interactive network topology visualization
- Customizable dashboard layouts with MongoDB persistence
- Comprehensive device management interface

### 1.2 Backend Microservices

The system comprises **24 specialized microservices** implemented in four programming languages, optimized for their specific use cases:

| Language | Services | Use Case |
|----------|----------|----------|
| **Node.js** (8 services) | API Gateway, Auth, KPI Query, Notification, Audit | High I/O, rapid development, SSE streaming |
| **Java** (6 services) | Alarm, Inventory, Config, KPI Aggregation, Diagnostics, Health Monitor | Enterprise reliability, Spring Boot ecosystem |
| **Go** (7 services) | Event Collector, KPI Collector, Discovery, Topology, 4x Forwarders | High performance, low latency, concurrency |
| **Python** (3 services) | Config Push Worker, Report Service | Device protocol libraries, async processing |

#### Core Services Overview

**1. API Gateway (Node.js)**
- Entry point for all client requests
- JWT token validation and RBAC enforcement
- Circuit breaker pattern for fault tolerance
- Rate limiting and request routing
- Endpoints: `:3010` (dev), `:443` (prod)

**2. Authentication Service (Node.js)**
- LDAP-first authentication with MongoDB fallback
- JWT token generation (RS256 algorithm)
- Account lockout after 3 failed attempts
- Circuit breaker for LDAP connectivity issues
- Role-based access control (ADMIN, OPERATOR, VIEWER)

**3. Alarm Service (Java/Spring Boot)**
- Alarm ingestion, correlation, and deduplication
- Severity levels: CRITICAL, MAJOR, MINOR, WARNING, INFO
- States: NEW, ACKNOWLEDGED, CLEARED
- Kafka consumer: `raw-alarms` → `processed-alarms`
- MongoDB storage with TTL-based auto-cleanup

**4. Inventory Service (Java/Spring Boot)**
- Device lifecycle management (register, update, decommission)
- Birth certificate generation (immutable device identity)
- Support for BTS, CPE, and IDU device types
- Geographic information (lat/lon/elevation/azimuth/tilt)
- External system synchronization via Kafka

**5. Discovery Service (Go)**
- Device onboarding with HMAC-SHA256 authentication
- mTLS certificate management
- SNMP/ICMP network scanning
- Automatic device registration workflow
- Publishes `device-discovered` events

**6. Event Collector (Go)**
- SNMP trap receiver (UDP port 161)
- Syslog receiver (UDP port 514)
- Vendor-specific alarm normalization
- High-throughput Kafka producer

**7. KPI Collector (Go)**
- SNMP polling (5-minute intervals, configurable)
- SNMPv2c and SNMPv3 support
- Vendor-specific OID collection (Huawei, generic MIB-II)
- Metrics: CPU, memory, RSSI, SNR, throughput, latency, packet loss
- Prometheus metrics for observability

**8. Config Push Worker (Python/FastAPI)**
- Multi-protocol device configuration:
  - **NETCONF** (RFC 6241) for BTS/IDU
  - **TR-069/CWMP** for CPE auto-configuration
  - **SSH/CLI** for legacy devices
- Asynchronous Kafka consumer
- Pending command queue for offline devices

**9. KPI Aggregation Service (Java/Spring Boot)**
- 15-minute bucketing of raw KPI data
- Hourly and daily rollup calculations
- Percentile metrics (P95, P99)
- ScyllaDB storage with 90-day raw TTL, 1-year aggregated

**10. Topology Service (Go)**
- Network graph computation
- Geospatial mapping with GeoJSON export
- Link health analysis
- Real-time connectivity updates

**11. Notification Service (Node.js)**
- Real-time browser notifications (SSE)
- Email integration (SendGrid)
- SMS integration (Twilio)
- Webhook support for external systems
- Rule-based alarm routing

### 1.3 Infrastructure Components

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Message Bus | Apache Kafka | 7.6.1 | Event-driven communication |
| Document Store | MongoDB | 7.0 | Primary data persistence |
| Time-Series DB | ScyllaDB | 5.1+ | KPI metrics storage |
| Cache/Sessions | Redis | 7.0 | Session management, caching |
| Container Platform | Docker | 20.10+ | Application containerization |
| Orchestration | Kubernetes | 1.28+ | Container orchestration |
| Package Manager | Helm | 3.14+ | Kubernetes deployments |
| Service Mesh | Istio | 1.17+ | mTLS, traffic management (optional) |
| Monitoring | Prometheus | 2.45+ | Metrics collection |
| Dashboards | Grafana | 10.0+ | Visualization and alerting |

**Kafka Configuration:**
- 7-day message retention
- 3 partitions per topic for horizontal scalability
- Key topics: `raw-alarms`, `processed-alarms`, `kpi-events`, `inventory-events`, `operational-events`, `audit-events`
- Dead Letter Queue (DLQ) topics for error handling

**MongoDB Configuration:**
- Replica set deployment for high availability
- Collections: devices, alarms, users, config-templates, audit-logs, custom-dashboards
- Sharding strategy for devices and alarms in production

**ScyllaDB Configuration:**
- Ring topology (3-10 nodes)
- Replication factor: 3
- TTL policies: 90 days (raw data), 1 year (aggregated)
- Keyspaces: `kpi_raw`, `kpi_warm`, `kpi_cold`

---

## 2. System Architecture & Design Patterns

### 2.1 Architectural Patterns

**1. Microservices Architecture**
- 24 independent, loosely coupled services
- Each service owns its data domain
- Polyglot approach (Node.js, Java, Go, Python) optimized per use case

**2. Event-Driven Architecture**
- Kafka as central event bus
- Asynchronous communication for scalability
- Event sourcing for audit trail
- CQRS (Command Query Responsibility Segregation) for KPI queries

**3. Circuit Breaker Pattern**
- API Gateway implements circuit breakers for all downstream services
- LDAP authentication with fallback to local MongoDB
- Graceful degradation during service outages

**4. API Gateway Pattern**
- Single entry point for all client requests
- Cross-cutting concerns: authentication, authorization, rate limiting, logging
- Request routing and load balancing

**5. Database Per Service**
- Each service manages its own data store
- No direct database access between services
- Data synchronization via Kafka events

### 2.2 Communication Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    Client Applications                            │
│                 (React SPA, Mobile Apps)                          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTPS/JWT
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                        API Gateway                                 │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ JWT Validation → RBAC Check → Rate Limit → Route Request   │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────┬──────────┬──────────┬──────────┬──────────┬───────────────┘
       │          │          │          │          │
       │ REST     │ REST     │ REST     │ REST     │ REST
       ▼          ▼          ▼          ▼          ▼
   ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
   │ Auth │  │Alarm │  │ KPI  │  │Inven-│  │Config│
   │      │  │      │  │Query │  │tory  │  │      │
   └───┬──┘  └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘
       │        │         │         │         │
       │        │         │         │         │
       └────────┴─────────┴─────────┴─────────┘
                         │
                    Kafka Event Bus
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   Device    │   │   Network   │   │  External   │
│   Agents    │   │  Equipment  │   │   Systems   │
│ (Edge Svc)  │   │ (SNMP/CLI)  │   │(Netcool/etc)│
└─────────────┘   └─────────────┘   └─────────────┘
```

### 2.3 Network Topology

```
┌────────────────────────────────────────────────────────────────┐
│                    Load Balancer / Ingress                     │
│                    (NGINX + TLS Termination)                   │
└────────────────────────────┬───────────────────────────────────┘
                             │
┌────────────────────────────┴───────────────────────────────────┐
│                    Kubernetes Cluster                          │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │               Service Mesh (Istio - Optional)            │ │
│  │                   mTLS between services                  │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Compute   │  │    Data     │  │    Edge     │          │
│  │   Pool      │  │    Pool     │  │    Pool     │          │
│  │             │  │             │  │             │          │
│  │ API Gateway │  │ KPI Agg     │  │ Event Coll  │          │
│  │ Auth Svc    │  │ Topology    │  │ KPI Coll    │          │
│  │ Alarm Svc   │  │ Config Svc  │  │ Discovery   │          │
│  │ Inventory   │  │             │  │             │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└────────────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  MongoDB    │     │  ScyllaDB   │     │   Kafka     │
│ Replica Set │     │   Cluster   │     │  Cluster    │
│  (3 nodes)  │     │  (3+ nodes) │     │ (3 brokers) │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## 3. Server Configurations & Deployment Architecture

### 3.1 Development Environment

**Configuration:** Single-node Docker Compose
- **Infrastructure:** All services containerized on single host
- **Frontend:** Vite dev server (localhost:5173)
- **Backend:** Docker Compose stack (24 services + MongoDB + Redis + Kafka)
- **Resource Requirements:** 16GB RAM minimum, 50GB disk
- **Setup Time:** ~5 minutes
- **Use Case:** Local development, testing

**Default Credentials:**
- Admin: `admin / Admin@NMS2024!`
- Operator: `operator / Operator@NMS2024!`

### 3.2 Staging Environment

**Configuration:** Kubernetes cluster (2-4 replicas per service)
- **Node Count:** 3-5 nodes minimum
- **Node Specs:** 8 vCPU, 32GB RAM per node
- **Deployment:** Helm chart with `values-staging.yaml`
- **HPA:** Enabled, CPU target 70%
- **Ingress:** NGINX with TLS
- **Database:** MongoDB replica set (3 nodes), Redis cluster (3 nodes)
- **Kafka:** 3 brokers, 3 Zookeeper nodes
- **Monitoring:** Prometheus + Grafana + AlertManager
- **Use Case:** Integration testing, QA validation, pre-production testing

### 3.3 Production Environment

**Configuration:** Multi-zone Kubernetes cluster (2-30 replicas per service)

**Node Pools:**
1. **Compute Pool** (6-10 nodes)
   - Node specs: 8 vCPU, 32GB RAM
   - Services: API Gateway, Auth, Alarm, Inventory, Notification
   - HPA: 2-10 replicas per service

2. **Data Pool** (4-8 nodes)
   - Node specs: 16 vCPU, 64GB RAM
   - Services: KPI Aggregation, Topology, Config Service
   - HPA: 4-12 replicas per service

3. **Edge Pool** (6-12 nodes)
   - Node specs: 8 vCPU, 16GB RAM (CPU-optimized)
   - Services: Event Collector, KPI Collector, Discovery
   - HPA: 6-20 replicas per service

**Database Infrastructure:**
- **MongoDB:** Sharded cluster (3+ config servers, 2+ shards, 3 replicas per shard)
- **ScyllaDB:** Ring topology (3-10 nodes), replication factor 3
- **Redis:** Cluster mode (6+ nodes), persistence enabled

**Kafka Infrastructure:**
- 3-5 brokers
- 3 Zookeeper nodes (or KRaft mode in Kafka 3.3+)
- Strimzi operator for Kubernetes management

**Ingress & Security:**
- NGINX Ingress with TLS (Let's Encrypt or corporate CA)
- Web Application Firewall (WAF) rules
- DDoS protection
- Sticky sessions for SSE connections

**High Availability:**
- Multi-zone deployment (3 availability zones)
- Pod anti-affinity rules
- Automatic failover for stateful services
- 99.9% SLA target

### 3.4 Edge Deployment (Offline Capable)

**Configuration:** Single-node or lightweight cluster
- **Scenario:** Small sites, limited connectivity, edge computing
- **Infrastructure:** Docker Compose or K3s (lightweight Kubernetes)
- **Database:** MongoDB standalone or SQLite with sync capability
- **Message Bus:** RabbitMQ (lighter than Kafka) or file-based queue
- **Monitoring:** Prometheus → push to central server when online
- **Use Case:** Remote sites, temporary deployments, disaster recovery

---

## 4. Device Onboarding Capabilities

### 4.1 Current Support

#### Supported Device Types

**1. BTS (Base Transceiver Station)**
- **Description:** Mast-top radio equipment for cellular networks
- **Vendors:** Huawei, Ericsson, Nokia
- **Onboarding:** Automatic check-in via Discovery Service
- **Configuration:** NETCONF (RFC 6241) + SSH/CLI fallback
- **Monitoring:** SNMP polling (5-min intervals), SNMP traps
- **Key Attributes:** site_id, azimuth, tilt, carrier_aggregation, frequency_bands
- **KPIs Collected:** CPU, memory, RSSI, SNR, throughput, latency, packet loss, uptime

**2. CPE (Customer Premises Equipment)**
- **Description:** Subscriber-side wireless access points (residential/enterprise)
- **Vendors:** Generic (compliant with TR-069 standard)
- **Onboarding:** Automatic check-in via Discovery Service
- **Configuration:** TR-069/CWMP (Auto Configuration Server)
- **Monitoring:** SNMP polling (generic MIB-II), SNMP traps
- **Key Attributes:** SSID, WiFi channel, TX power, VLAN, static IP
- **KPIs Collected:** CPU, memory, connected clients, bandwidth usage, signal strength

**3. IDU (Indoor Unit)**
- **Description:** Point-to-Point backhaul dishes and radios
- **Vendors:** Cambium Networks, Ubiquiti, Mikrotik
- **Onboarding:** Automatic check-in via Discovery Service
- **Configuration:** NETCONF + TR-069 hybrid
- **Monitoring:** SNMP polling + SNMP traps
- **Key Attributes:** link_partner, frequency, polarization, antenna_gain, modulation
- **KPIs Collected:** Link capacity, signal level, modulation rate, error ratio, latency

#### Onboarding Workflow

```
Device Boots
    ↓
POST /api/v1/discovery/check-in
    ├─ Payload: serialNumber, macAddress, ipAddress, deviceType,
    │           model, firmware, publicKey, hmacSignature
    ↓
Discovery Service validates HMAC-SHA256 signature
    ↓
Birth Certificate created (immutable identity record)
    ↓
Kafka event: device-discovered
    ↓
┌───────────────┬─────────────────┐
↓               ↓                 ↓
Inventory       Topology          Config Push
Service         Service           Worker
(registers      (adds to          (queues pending
 device)        network graph)     commands)
```

**Security:**
- HMAC-SHA256 signature verification (shared secret per device type)
- Device public key storage for mTLS
- Birth certificate prevents device spoofing
- Certificate pinning for future communications

### 4.2 Roadmap: Future Device Types

#### Phase 1 (Q3 2026 - 3 months)

**1. Switches (Layer 2/3)**
- **Vendors:** Cisco Catalyst, Arista, Juniper EX series
- **Protocol:** NETCONF/YANG models
- **KPIs:** Port statistics, VLAN config, STP topology, MAC tables, ARP tables
- **Complexity:** Medium (well-defined YANG models available)
- **Effort:** 120-160 hours

**2. Access Points (Enterprise WiFi)**
- **Vendors:** Cisco Meraki, Aruba, Ruckus
- **Protocol:** Controller APIs (REST) + SNMP
- **KPIs:** Client count, channel utilization, roaming stats, RF interference
- **Complexity:** Medium (vendor-specific APIs)
- **Effort:** 100-140 hours

#### Phase 2 (Q4 2026 - 4 months)

**3. Routers (Edge/Core)**
- **Vendors:** Cisco IOS-XR, Juniper MX series, Nokia SR
- **Protocol:** NETCONF/YANG, gRPC (gNMI/gNOI)
- **KPIs:** BGP sessions, OSPF neighbors, interface stats, routing tables, QoS metrics
- **Complexity:** High (complex routing protocols, large data volumes)
- **Effort:** 200-280 hours

**4. Firewalls / Security Appliances**
- **Vendors:** Palo Alto, Fortinet, Check Point
- **Protocol:** Vendor REST APIs
- **KPIs:** Session count, threat detections, throughput, VPN tunnels
- **Complexity:** Medium-High (security context required)
- **Effort:** 160-200 hours

#### Phase 3 (2027 - 6 months)

**5. Optical Transport Equipment (DWDM/OTN)**
- **Vendors:** Ciena, Infinera, ADVA
- **Protocol:** TL1, NETCONF
- **KPIs:** Optical power, wavelength stability, FEC errors, latency
- **Complexity:** High (specialized domain knowledge)
- **Effort:** 240-320 hours

**6. SD-WAN Edge Devices**
- **Vendors:** Cisco Viptela, VMware VeloCloud, Silver Peak
- **Protocol:** Vendor-specific APIs
- **KPIs:** Tunnel health, application performance, link quality, failover events
- **Complexity:** High (multi-vendor, overlay networks)
- **Effort:** 200-260 hours

**7. IoT Gateways**
- **Vendors:** Generic (LoRaWAN, NB-IoT, Zigbee)
- **Protocol:** MQTT, CoAP, REST
- **KPIs:** Connected sensors, message rate, battery levels, coverage
- **Complexity:** Medium (new protocols)
- **Effort:** 140-180 hours

### 4.3 Scalability Considerations

**Current Capacity:**
- **Tested:** 500 devices (device simulator)
- **Theoretical:** 5,000 devices per cluster (with HPA at max replicas)
- **Database:** MongoDB sharding supports 50,000+ devices
- **Kafka:** Throughput tested at 100,000 messages/sec

**Bottlenecks:**
- SNMP polling (KPI Collector): CPU-bound, scales with replicas
- Alarm correlation (Alarm Service): Memory-bound, requires tuning for >10,000 devices
- Topology computation (Topology Service): Graph algorithms O(n²), needs optimization for >2,000 devices

**Scaling Strategy:**
- Horizontal: HPA for all stateless services
- Vertical: Increase node specs for data-intensive services
- Partitioning: Kafka topic partitioning by device region
- Caching: Redis caching for frequently accessed device data

---

## 5. Device-to-NMS Communication Flow

### 5.1 Edge Agent Communication

**Current Implementation:**

The system uses a **push-pull hybrid model**:

**1. Device Registration (Push)**
```
Device → POST /api/v1/discovery/check-in
    ├─ Headers: Content-Type: application/json
    ├─ Body: {
    │    "serialNumber": "BTS-001-2024",
    │    "macAddress": "00:11:22:33:44:55",
    │    "ipAddress": "192.168.1.100",
    │    "deviceType": "BTS",
    │    "model": "Huawei RAN-Box-5000",
    │    "firmware": "9.0.1",
    │    "publicKey": "-----BEGIN PUBLIC KEY-----...",
    │    "hmacSignature": "<HMAC-SHA256 of payload>"
    │  }
    ↓
Discovery Service validates HMAC
    ↓
Response: Birth Certificate (200 OK)
    ├─ {
    │    "certificateId": "cert-uuid-123",
    │    "device": { ...device info... },
    │    "issuedAt": "2026-07-14T10:30:00Z",
    │    "nmsEndpoint": "https://nms.example.com",
    │    "pollingInterval": 300,
    │    "reportingTopics": ["device-metrics", "device-alarms"]
    │  }
```

**2. Configuration Pull (Pull)**
```
Device → GET /api/v1/config/pending/{deviceId}
    ├─ Headers: Authorization: Bearer <device-jwt>
    ↓
Config Service checks pending commands queue
    ↓
Response: Pending config commands (200 OK) or No Pending (204 No Content)
    ├─ {
    │    "commands": [
    │      {
    │        "id": "cmd-uuid-456",
    │        "type": "CONFIG_PUSH",
    │        "protocol": "NETCONF",
    │        "config": { "wifi": "2.4", "ssid": "UBR-Net", "channel": 6 }
    │      }
    │    ]
    │  }
    ↓
Device applies config
    ↓
Device → POST /api/v1/config/result
    ├─ Body: {
    │    "commandId": "cmd-uuid-456",
    │    "status": "SUCCESS",
    │    "appliedAt": "2026-07-14T10:35:00Z"
    │  }
```

**3. KPI/Alarm Reporting (Push)**
```
Device → SNMP Trap (UDP 161) or POST /api/v1/events
    ↓
Event Collector / KPI Collector
    ↓
Kafka: raw-alarms, kpi-events
```

**Edge Agent Responsibilities:**
- Periodic check-in (configurable, default 5 minutes)
- Pull pending configuration commands
- Report execution results
- Send SNMP traps for critical alarms
- Send KPI data via SNMP (polled by KPI Collector)

### 5.2 SNMP-Based Communication

**SNMP Versions Supported:**
- **SNMPv1:** Basic read-only (deprecated, legacy support)
- **SNMPv2c:** Community string-based (widely used)
- **SNMPv3:** User-based authentication + encryption (recommended)

**SNMP Operations:**

**1. SNMP Polling (GET/GETNEXT/GETBULK)**
```
KPI Collector → SNMP GET (OID 1.3.6.1.4.1.2011.6.2.1.1.0)
    ├─ Target: Device IP (from inventory)
    ├─ Port: 161/udp
    ├─ Community: "ubr-monitor" (v2c) or User creds (v3)
    ↓
Device responds with OID value
    ↓
KPI Collector normalizes OID → metric name
    ↓
Kafka: kpi-events → KPI Aggregation Service
```

**2. SNMP Traps (Asynchronous Alarms)**
```
Device → SNMP TRAP (Destination: Event Collector IP:161)
    ├─ Trap OID: 1.3.6.1.4.1.2011.5.25.129.2.0.1 (Huawei linkDown)
    ├─ VarBinds: interface, state, timestamp
    ↓
Event Collector receives trap
    ↓
Normalizer translates vendor OID → canonical alarm
    ↓
Kafka: raw-alarms → Alarm Service
```

**SNMP Configuration (Device Side):**
```bash
# SNMPv3 User Creation (example for Huawei)
snmp-agent usm-user v3 ubr-nms authentication-mode sha <auth-password>
snmp-agent usm-user v3 ubr-nms privacy-mode aes128 <priv-password>
snmp-agent trap enable
snmp-agent target-host trap address udp-domain 10.0.1.10 params securityname ubr-nms v3
```

**SNMP OID Mapping (Examples):**
| Vendor | OID | Metric | Unit |
|--------|-----|--------|------|
| Huawei | 1.3.6.1.4.1.2011.6.2.1.1.0 | CPU Usage | % |
| Huawei | 1.3.6.1.4.1.2011.6.2.1.2.0 | Memory Usage | % |
| Generic | 1.3.6.1.2.1.25.3.2.1.5.1 | RSSI | dBm |
| Generic | 1.3.6.1.2.1.2.2.1.10.{ifIndex} | Interface RX bytes | bytes |
| Generic | 1.3.6.1.2.1.2.2.1.16.{ifIndex} | Interface TX bytes | bytes |

### 5.3 Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Network Devices                        │
│  (BTS, CPE, IDU, Switches, APs, Routers, Firewalls)       │
└────┬──────────────┬──────────────┬────────────────┬─────────┘
     │              │              │                │
     │ SNMP Traps   │ SNMP Polls   │ Check-in      │ Syslog
     │ (UDP 161)    │ (UDP 161)    │ (HTTPS)       │ (UDP 514)
     │              │              │                │
     ▼              ▼              ▼                ▼
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│  Event  │   │   KPI   │   │Discovery│   │  Event  │
│Collector│   │Collector│   │ Service │   │Collector│
└────┬────┘   └────┬────┘   └────┬────┘   └────┬────┘
     │             │             │             │
     └─────────────┴─────────────┴─────────────┘
                   │
              Kafka Event Bus
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
┌─────────┐   ┌─────────┐   ┌─────────┐
│  Alarm  │   │   KPI   │   │Inventory│
│ Service │   │  Agg    │   │ Service │
└─────────┘   └─────────┘   └─────────┘
```

---

## 6. Deployment Scenarios

### 6.1 Private Cloud with Internet Connectivity

**Architecture:**
- Full cloud-native deployment on Kubernetes
- Internet access for:
  - Online map tiles (OpenStreetMap, Mapbox)
  - External integrations (SendGrid email, Twilio SMS)
  - Software updates (Helm charts, Docker images)
  - NTP synchronization
  - DNS resolution

**Network Requirements:**
- **Inbound:** HTTPS (443), SSH (22 for admin), SNMP traps (161/udp), Syslog (514/udp)
- **Outbound:** HTTPS (443), SMTP (587), DNS (53), NTP (123)

**Security Measures:**
- Firewall rules: Whitelist specific domains (maps API, email gateway)
- TLS certificate validation (Let's Encrypt or corporate CA)
- Egress filtering: Block unknown destinations
- Audit logging: All outbound connections logged

**Compliance Considerations:**
- GDPR: Data residency (MongoDB/ScyllaDB in EU region)
- SOC 2: Encryption at rest + in transit, access logging
- HIPAA: PHI data protection (if applicable)
- ISO 27001: Security controls documented

**Advantages:**
- Access to online map services (better UX)
- Easy software updates
- Cloud-based integrations (email, SMS)

**Disadvantages:**
- Internet dependency for some features
- Potential compliance issues (data egress)

### 6.2 Private Cloud without Internet (Fully Offline)

**Architecture:**
- Air-gapped Kubernetes cluster
- No external connectivity
- Self-contained deployment with all dependencies bundled

**Required Modifications:**

**1. Map Tiles (Offline Support)**
- **Current:** Online tiles from OpenStreetMap/Mapbox
- **Offline Solution:**
  - Pre-download map tiles for geographic region (50GB-500GB depending on zoom levels)
  - Host tile server: TileServer GL or Martin
  - Configure Leaflet to use local tile server
  - Implementation: `frontend/src/components/topology/MapView.tsx` tile URL override

**2. NTP Synchronization**
- **Solution:** Local NTP server (Chrony or ntpd) on private network
- **Configuration:** All nodes point to local NTP server

**3. DNS Resolution**
- **Solution:** Local DNS server (CoreDNS, BIND)
- **Configuration:** Kubernetes CoreDNS configured for local zones

**4. Email/SMS Notifications**
- **Solution:**
  - Email: Local SMTP relay (Postfix) → internal mail server
  - SMS: API gateway to corporate SMS gateway or disable feature
  - Alternative: Webhook notifications to internal monitoring systems

**5. Software Updates**
- **Solution:**
  - Pre-package all Docker images in TAR format
  - Include Helm charts in deployment bundle
  - Manual import process: `docker load -i <image>.tar`
  - Local Docker registry (Harbor) for image distribution

**Network Requirements:**
- **Inbound:** HTTPS (443), SNMP traps (161/udp), Syslog (514/udp)
- **Outbound:** None (fully isolated)

**Deployment Package Contents:**
1. Docker images (TAR archives) - ~15GB
2. Helm charts - ~50MB
3. MongoDB database seed - ~10MB
4. Map tiles (optional, region-specific) - 50GB-500GB
5. Installation scripts - ~5MB
6. Documentation - ~100MB

**Advantages:**
- Complete air-gap security
- No compliance concerns about data egress
- Suitable for high-security environments (military, government)

**Disadvantages:**
- No online maps (unless pre-loaded)
- Manual software updates required
- No cloud integrations (email/SMS require alternatives)

### 6.3 Hybrid Deployment (Offline-First with Optional Online)

**Architecture:**
- Default offline operation
- Automatic detection of internet connectivity
- Fallback to online services when available

**Feature Matrix:**

| Feature | Offline Mode | Online Mode |
|---------|--------------|-------------|
| Core NMS | ✓ Full | ✓ Full |
| Device Management | ✓ Full | ✓ Full |
| Alarm Monitoring | ✓ Full | ✓ Full |
| KPI Collection | ✓ Full | ✓ Full |
| Map Visualization | ✓ Local tiles | ✓ Online tiles (better quality) |
| Email Notifications | ✓ Local SMTP | ✓ SendGrid |
| SMS Notifications | ✗ Disabled | ✓ Twilio |
| Software Updates | ✗ Manual | ✓ Automatic |

**Implementation:**
- Frontend: `navigator.onLine` detection + tile server fallback
- Backend: Health check to external endpoint (e.g., `https://www.google.com/generate_204`)
- Configuration: `DEPLOYMENT_MODE=hybrid` environment variable

---

## 7. Packaging for Offline Deployment

### 7.1 Deployment Bundle Structure

```
ubr-nms-offline-v1.0.0/
├── README.md                          # Installation guide
├── LICENSE                            # Software license
├── install.sh                         # Automated installer
├── uninstall.sh                       # Cleanup script
│
├── docker-images/                     # Pre-built Docker images (TAR)
│   ├── api-gateway-v1.0.0.tar        (250 MB)
│   ├── auth-service-v1.0.0.tar       (240 MB)
│   ├── alarm-service-v1.0.0.tar      (380 MB - Java)
│   ├── inventory-service-v1.0.0.tar  (370 MB - Java)
│   ├── kpi-collector-v1.0.0.tar      (80 MB - Go)
│   ├── event-collector-v1.0.0.tar    (75 MB - Go)
│   ├── ... (18 more services)
│   ├── mongodb-7.0.tar               (600 MB)
│   ├── redis-7.0.tar                 (120 MB)
│   ├── kafka-7.6.1.tar               (850 MB)
│   ├── zookeeper-3.8.tar             (450 MB)
│   ├── nginx-ingress-v1.8.tar        (300 MB)
│   └── MANIFEST.txt                  # Image inventory + checksums
│   Total: ~15 GB
│
├── helm-charts/                       # Kubernetes deployment charts
│   ├── ubrnms-1.0.0.tgz              # Umbrella chart
│   ├── auth-service-1.0.0.tgz
│   ├── alarm-service-1.0.0.tgz
│   └── ... (22 more charts)
│
├── kubernetes/                        # Pre-deployment setup
│   ├── namespaces.yaml               # Kubernetes namespaces
│   ├── storage-class.yaml            # Persistent volume setup
│   ├── secrets.yaml.template         # Secret templates (user fills)
│   └── ingress.yaml                  # NGINX Ingress config
│
├── database/                          # Database initialization
│   ├── mongodb-init.js               # MongoDB collections + indexes
│   ├── seed-data.json                # Sample devices, users, alarms
│   └── scylladb-schema.cql           # ScyllaDB keyspace + tables
│
├── maps/                              # Offline map tiles (OPTIONAL)
│   ├── tiles/                        # OSM tiles (zoom 0-15)
│   │   └── ... (50GB-500GB)
│   ├── tileserver-gl/                # Tile server Docker image
│   └── config.json                   # Tile server config
│
├── dependencies/                      # System dependencies
│   ├── kubectl-v1.28.0               # Kubernetes CLI (Linux/Mac/Win)
│   ├── helm-v3.14.0                  # Helm package manager
│   ├── k3s-installer.sh              # Lightweight K8s (for edge)
│   └── docker-compose-v2.20.0        # Docker Compose (for dev)
│
├── scripts/                           # Utility scripts
│   ├── load-images.sh                # Import Docker images
│   ├── deploy-kubernetes.sh          # Kubernetes deployment
│   ├── deploy-docker-compose.sh      # Docker Compose deployment
│   ├── configure-offline-maps.sh     # Configure local tile server
│   ├── backup.sh                     # Backup databases
│   └── restore.sh                    # Restore from backup
│
├── docs/                              # Documentation
│   ├── installation-guide.pdf        # Step-by-step setup
│   ├── architecture-overview.pdf     # System architecture
│   ├── troubleshooting.pdf           # Common issues
│   └── user-manual.pdf               # End-user guide
│
└── CHECKSUM.sha256                   # Bundle integrity verification

Total bundle size:
- Without maps: ~20 GB
- With maps (regional): ~70 GB - 520 GB
```

### 7.2 Installation Process

**Prerequisites:**
- Linux host (Ubuntu 22.04, RHEL 8+, or equivalent)
- Docker 20.10+ installed
- Kubernetes cluster (K3s, Kubeadm, or managed) OR Docker Compose
- 16GB RAM minimum (32GB recommended)
- 100GB disk minimum (500GB recommended with maps)

**Step-by-Step Installation:**

```bash
# 1. Extract bundle
tar -xzf ubr-nms-offline-v1.0.0.tar.gz
cd ubr-nms-offline-v1.0.0

# 2. Verify integrity
sha256sum -c CHECKSUM.sha256

# 3. Load Docker images
./scripts/load-images.sh
# Output: Loaded 24 images, 3 infrastructure images

# 4. Configure secrets (edit with your values)
cp kubernetes/secrets.yaml.template kubernetes/secrets.yaml
nano kubernetes/secrets.yaml
# Set: JWT keys, LDAP credentials, database passwords

# 5. Deploy (choose one)

# Option A: Kubernetes (Production)
./scripts/deploy-kubernetes.sh --environment production
# Installs: Namespaces, PVCs, Helm charts, Ingress

# Option B: Docker Compose (Development/Edge)
./scripts/deploy-docker-compose.sh --environment dev
# Starts: All 24 services + MongoDB + Redis + Kafka

# 6. (Optional) Configure offline maps
./scripts/configure-offline-maps.sh --region north-america --zoom-levels 0-15
# Starts local tile server, configures frontend

# 7. Verify installation
kubectl get pods -n ubr-nms  # (Kubernetes)
# OR
docker-compose ps            # (Docker Compose)

# 8. Access UI
echo "UI available at: https://<your-server-ip>"
echo "Default credentials: admin / Admin@NMS2024!"
```

**Installation Time:**
- Image loading: 15-20 minutes (depends on disk I/O)
- Kubernetes deployment: 10-15 minutes (service startup)
- Docker Compose deployment: 5-8 minutes
- **Total: 20-35 minutes**

### 7.3 Offline Map Support

**Map Tile Architecture:**

**Online Mode:**
```
Frontend (Leaflet) → https://api.mapbox.com/styles/.../tiles/{z}/{x}/{y}
```

**Offline Mode:**
```
Frontend (Leaflet) → http://tileserver.ubr-nms.svc:8080/styles/ubr/{z}/{x}/{y}.png
```

**Tile Server Options:**

**1. TileServer GL (Recommended)**
- **Description:** Lightweight, GPU-accelerated map tile server
- **Format:** Vector tiles (MBTiles) or raster tiles
- **Size:** 50GB (zoom 0-12, 1 country), 500GB (zoom 0-15, 1 continent)
- **Deployment:** Docker container, deployed via Helm

**2. Martin**
- **Description:** PostgreSQL/PostGIS-backed tile server
- **Format:** Vector tiles
- **Size:** Similar to TileServer GL
- **Deployment:** Requires PostGIS database

**Map Tile Configuration:**

```typescript
// frontend/src/components/topology/MapView.tsx

const MapView: React.FC = () => {
  const isOnline = navigator.onLine;
  const tileLayerUrl = isOnline
    ? 'https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}'
    : 'http://tileserver.ubr-nms.svc:8080/styles/ubr/{z}/{x}/{y}.png';

  return (
    <MapContainer center={[51.505, -0.09]} zoom={13}>
      <TileLayer
        url={tileLayerUrl}
        attribution='&copy; OpenStreetMap contributors'
        id='mapbox/streets-v11'
        accessToken={process.env.VITE_MAPBOX_TOKEN}
      />
      {/* Device markers */}
    </MapContainer>
  );
};
```

**Tile Pre-Download:**
```bash
# Using Tile Downloader (OSM)
tile-downloader \
  --region north-america \
  --bbox "-125.0,24.0,-66.0,49.0" \
  --zoom-min 0 \
  --zoom-max 12 \
  --output ./maps/tiles/

# Convert to MBTiles (for TileServer GL)
mb-util --image_format=png ./maps/tiles/ ./maps/tiles.mbtiles
```

---

## 8. Security & Compliance

### 8.1 Security Architecture

**Authentication Flow:**
```
User → Login (username/password)
  ↓
Auth Service → LDAP Bind (primary)
  ├─ Success: Fetch LDAP attributes
  │    ↓
  │  Create/update user in MongoDB (shadow record)
  │    ↓
  │  Generate JWT (RS256, 1-hour expiry)
  │    ↓
  │  Return: { accessToken, refreshToken (7 days) }
  │
  ├─ Failure: Increment fail counter (Redis)
  │    ├─ 3 failures → Account lockout (15 min)
  │    └─ Return: 401 Unauthorized
  │
  └─ LDAP Unavailable (circuit breaker open)
       ↓
     Fallback: MongoDB authentication
       ↓
     Generate JWT
```

**Authorization (RBAC):**

| Role | Permissions |
|------|------------|
| **ADMIN** | User management, system config, LDAP settings, audit log access, all OPERATOR permissions |
| **OPERATOR** | Device CRUD, config push, alarm acknowledge, report generation, dashboard customization |
| **VIEWER** | Read-only: Dashboard, device info, alarms, KPI charts, topology view |

**JWT Payload:**
```json
{
  "sub": "user-uuid-123",
  "username": "jdoe",
  "role": "ADMIN",
  "email": "jdoe@example.com",
  "iss": "ubr-nms",
  "aud": "ubr-nms-api",
  "iat": 1720960000,
  "exp": 1720963600
}
```

**API Gateway Security Middleware:**
```javascript
// 1. CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS.split(','),
  credentials: true
}));

// 2. Security headers
app.use(helmet({
  strictTransportSecurity: { maxAge: 31536000 },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    }
  }
}));

// 3. Rate limiting
app.use('/api/v1/auth', rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
}));

// 4. JWT validation
app.use('/api/*', authenticate, requireRole(['ADMIN', 'OPERATOR', 'VIEWER']));
```

### 8.2 Security Features

**1. Encryption**
- **In Transit:** TLS 1.3 (api-gateway ↔ clients), mTLS (service-to-service with Istio)
- **At Rest:** MongoDB encryption at storage engine layer (configurable), disk encryption (OS-level)
- **Field-Level:** Password hashing with bcrypt (cost factor 10)

**2. Secret Management**
- **Storage:** Kubernetes Secrets (base64-encoded), environment variables
- **Rotation:** Manual (JWT keypair regeneration script)
- **Access:** Restricted to service account namespaces

**3. Audit Logging**
- **Events:** User login, config push, device modification, user creation/deletion, alarm acknowledgement
- **Format:** JSON structured logs
- **Retention:** 1 year (MongoDB TTL index)
- **Output:** Kafka `operational-events` → Syslog forwarder → SIEM

**4. Network Security**
- **Ingress:** NGINX with WAF rules (ModSecurity)
- **Egress:** Firewall rules (whitelist specific domains)
- **Service Mesh:** Istio with automatic mTLS between pods
- **Network Policies:** Kubernetes NetworkPolicy objects (restrict pod-to-pod)

**5. Vulnerability Management**
- **Image Scanning:** Trivy (Docker image vulnerabilities)
- **Dependency Scanning:** npm audit, Dependabot (GitHub)
- **SAST:** SonarQube (static code analysis)
- **DAST:** OWASP ZAP (dynamic application security testing)

### 8.3 Compliance Considerations (Internet-Enabled)

**Data Protection (GDPR, CCPA):**
- **Personal Data:** User credentials, email addresses
- **Storage:** EU/US data residency options (MongoDB region selection)
- **Retention:** Configurable (default: 1 year audit logs, 7 days Kafka)
- **Right to Erasure:** User deletion API (`DELETE /api/v1/users/{id}`)
- **Data Portability:** Export API (`GET /api/v1/users/{id}/export`)

**Access Control (SOC 2, ISO 27001):**
- **Principle of Least Privilege:** RBAC enforcement
- **MFA:** LDAP-based (if LDAP server supports)
- **Session Management:** 1-hour access token, 7-day refresh token
- **Account Lockout:** 3 failed attempts → 15-minute lockout

**Data Integrity (SOC 2, HIPAA):**
- **Audit Trail:** Immutable audit logs (append-only MongoDB collection)
- **Non-Repudiation:** HMAC signatures on critical actions
- **Backup:** Daily automated backups (MongoDB, ScyllaDB)

**Network Security (PCI DSS, NIST):**
- **Firewall:** Whitelist outbound domains (maps API, email gateway)
- **TLS:** Certificate pinning for critical services
- **Intrusion Detection:** Suricata (network IDS) or Falco (Kubernetes runtime)

**Policy Violations to Prevent:**
- **Data Exfiltration:** Egress filtering (block unknown destinations)
- **Unauthorized Access:** JWT expiry enforcement, RBAC validation
- **Malware:** Image scanning (Trivy), runtime security (Falco)
- **DDoS:** Rate limiting, Cloudflare (if using CDN)

**Audit Recommendations:**
1. Regular penetration testing (quarterly)
2. Vulnerability scanning (weekly)
3. Access log review (monthly)
4. Compliance attestation (annually)

---

## 9. Feature Summary

### 9.1 Currently Available Features

#### Core NMS Capabilities
✅ **Device Management**
- Device registration (BTS, CPE, IDU)
- Birth certificate generation (immutable identity)
- Device CRUD operations (create, read, update, decommission)
- Device grouping and tagging
- Geographic location management (lat/lon/elevation/azimuth/tilt)
- Firmware version tracking

✅ **Alarm Management**
- Real-time alarm ingestion (SNMP traps, syslog)
- Alarm severity levels (CRITICAL, MAJOR, MINOR, WARNING, INFO)
- Alarm states (NEW, ACKNOWLEDGED, CLEARED)
- Alarm correlation and deduplication
- Alarm acknowledgement workflow
- Top-reported alarms analytics
- Alarm history and audit trail

✅ **KPI Monitoring**
- SNMP polling (5-minute intervals, configurable)
- SNMPv2c and SNMPv3 support
- KPI metrics: CPU, memory, RSSI, SNR, throughput, latency, packet loss
- 15-minute aggregation buckets
- Hourly and daily rollups
- Time-series queries with filtering
- KPI threshold rules

✅ **Network Topology**
- Automatic topology discovery
- Interactive network map (Leaflet + D3.js)
- Device connectivity visualization
- Link health indicators
- Geospatial device placement
- Topology refresh (manual/automatic)

✅ **Configuration Management**
- Multi-protocol config push:
  - NETCONF (RFC 6241) for BTS/IDU
  - TR-069/CWMP for CPE
  - SSH/CLI for legacy devices
- Config template CRUD
- Config approval workflow
- Config history and rollback
- Pending command queue (for offline devices)

✅ **User Management & Security**
- LDAP authentication with MongoDB fallback
- JWT-based authorization (RS256)
- Role-based access control (ADMIN, OPERATOR, VIEWER)
- Account lockout policy (3 failed attempts)
- Session management
- Audit logging (1-year retention)

✅ **Reporting**
- Alarm summary reports (PDF, XLSX, CSV)
- KPI trend reports
- Device inventory reports
- Network health reports
- Scheduled report generation

✅ **Real-Time Notifications**
- Server-Sent Events (SSE) for browser push
- Email notifications (SendGrid integration)
- SMS notifications (Twilio integration)
- Webhook support for external systems
- Notification rule engine

✅ **Dashboard & Visualization**
- Real-time KPI widgets
- Alarm feed (live updates)
- Topology mini-map
- Custom dashboard layouts (MongoDB-backed persistence)
- Responsive UI (desktop, tablet, mobile)

✅ **External Integrations**
- IBM Netcool/OMNIbus forwarder (alarm export)
- Ericsson MyComm forwarder (KPI export)
- Mobinet inventory synchronization
- Syslog forwarder (SIEM integration)

✅ **Operational Tools**
- Health monitoring (Prometheus metrics)
- Structured logging (JSON)
- Distributed tracing ready (correlation IDs)
- Circuit breakers for fault tolerance
- Horizontal pod autoscaling (HPA)

### 9.2 Features Not Yet Implemented

#### High Priority (Planned)

🔲 **Advanced Device Support**
- Switches (Cisco, Arista, Juniper) - Phase 1
- Enterprise access points (Meraki, Aruba) - Phase 1
- Routers (Cisco IOS-XR, Juniper MX) - Phase 2
- Firewalls (Palo Alto, Fortinet) - Phase 2
- Optical transport (DWDM/OTN) - Phase 3
- SD-WAN edge devices - Phase 3
- IoT gateways (LoRaWAN, NB-IoT) - Phase 3

🔲 **Advanced Analytics**
- Machine learning-based anomaly detection
- Predictive failure analysis
- Capacity planning recommendations
- Root cause analysis (RCA) automation
- Network performance optimization suggestions

🔲 **Workflow Automation**
- Auto-remediation workflows (self-healing)
- Config change approval chains (multi-level)
- Scheduled maintenance windows
- Bulk operations (multi-device config push)
- Device firmware upgrade orchestration

🔲 **Enhanced Security**
- Multi-factor authentication (MFA/2FA)
- Certificate-based device authentication (full mTLS)
- Encryption at rest (database-level)
- Security policy compliance scanning
- Intrusion detection integration

🔲 **Advanced Reporting**
- SLA compliance reports
- Custom report builder (drag-and-drop)
- Report scheduling (daily/weekly/monthly)
- Executive dashboards
- Comparative analysis reports

🔲 **Multi-Tenancy**
- Tenant isolation (data segregation)
- Tenant-specific RBAC
- White-label UI customization
- Per-tenant resource quotas

🔲 **API Enhancements**
- GraphQL API (in addition to REST)
- WebSocket support (in addition to SSE)
- API versioning (v2, v3)
- Rate limiting per user/tenant
- API usage analytics

#### Medium Priority (Future Roadmap)

🔲 **Mobile Applications**
- Native iOS app
- Native Android app
- Push notifications
- Offline mode

🔲 **Advanced Topology**
- Layer 2/3 topology discovery (LLDP, CDP)
- Network path visualization
- Traffic flow analysis
- Network simulation mode

🔲 **AI/ML Features**
- Chatbot for NMS operations ("Claude NMS Assistant")
- Natural language queries ("Show me critical alarms in NYC")
- Automated incident reports generation
- Smart alarm correlation (reduce noise)

🔲 **Edge Computing**
- Edge node management
- Distributed NMS deployment
- Offline-first architecture
- Sync-on-connect (edge ↔ central)

🔲 **Compliance & Governance**
- Built-in compliance reporting (GDPR, HIPAA, SOC 2)
- Policy enforcement engine
- Data retention policies
- Automated compliance scanning

#### Low Priority (Backlog)

🔲 **Advanced Integrations**
- ServiceNow integration (ITSM)
- Jira integration (ticketing)
- Slack/Teams integration (ChatOps)
- Ansible playbook execution
- Terraform provider (infrastructure as code)

🔲 **Performance Enhancements**
- GraphQL subscriptions for real-time updates
- WebAssembly for frontend performance
- Database query optimization (indexes, sharding)
- Edge caching (CDN for static assets)

🔲 **Developer Tools**
- Public SDK (JavaScript, Python, Go)
- Developer sandbox environment
- API mock server
- Postman collection

---

## 10. Effort Estimates & Timeline

### 10.1 Device Onboarding Roadmap

| Device Type | Complexity | Effort (Hours) | Timeline | Team Size | Dependencies |
|-------------|-----------|---------------|----------|-----------|--------------|
| **Phase 1** |
| Switches (L2/L3) | Medium | 120-160 | Q3 2026 (3 months) | 2 engineers | NETCONF/YANG models |
| Enterprise APs | Medium | 100-140 | Q3 2026 (3 months) | 2 engineers | Vendor API access |
| **Phase 2** |
| Routers | High | 200-280 | Q4 2026 (4 months) | 3 engineers | gRPC/gNMI support |
| Firewalls | Medium-High | 160-200 | Q4 2026 (4 months) | 2 engineers | Security context |
| **Phase 3** |
| Optical (DWDM/OTN) | High | 240-320 | 2027 (6 months) | 3 engineers | Domain expertise, TL1 |
| SD-WAN Edge | High | 200-260 | 2027 (6 months) | 3 engineers | Multi-vendor APIs |
| IoT Gateways | Medium | 140-180 | 2027 (4 months) | 2 engineers | MQTT/CoAP support |

**Assumptions:**
- Engineers have prior experience with network protocols
- Vendor documentation and test equipment available
- Parallel development where feasible

### 10.2 Feature Development Estimates

| Feature | Complexity | Effort (Hours) | Timeline | Team Size | Notes |
|---------|-----------|---------------|----------|-----------|-------|
| **Advanced Analytics** |
| ML Anomaly Detection | High | 320-400 | 6 months | 2 data scientists + 1 engineer | Requires historical data |
| Predictive Failure | Very High | 400-600 | 8-12 months | 2 data scientists + 2 engineers | Complex ML models |
| Root Cause Analysis | High | 280-360 | 5 months | 2 engineers | Graph algorithms |
| **Workflow Automation** |
| Auto-Remediation | High | 240-320 | 4 months | 3 engineers | Safety testing critical |
| Multi-Level Approval | Medium | 120-160 | 2 months | 2 engineers | Workflow engine |
| Bulk Operations | Medium | 160-200 | 3 months | 2 engineers | Transaction handling |
| **Security Enhancements** |
| MFA/2FA | Medium | 80-120 | 2 months | 1 engineer | TOTP library |
| Full mTLS | Medium-High | 160-200 | 3 months | 2 engineers | Certificate management |
| Encryption at Rest | Medium | 120-160 | 2 months | 1 engineer | Database config |
| **Multi-Tenancy** |
| Data Isolation | High | 280-360 | 5 months | 3 engineers | Database schema changes |
| Tenant RBAC | Medium | 160-200 | 3 months | 2 engineers | Extends existing RBAC |
| White-Label UI | Medium | 120-160 | 2 months | 2 frontend engineers | Theming system |
| **Mobile Apps** |
| iOS App | High | 400-600 | 6-9 months | 2 iOS engineers | Swift, push notifications |
| Android App | High | 400-600 | 6-9 months | 2 Android engineers | Kotlin, push notifications |
| **API Enhancements** |
| GraphQL API | Medium-High | 240-320 | 4 months | 2 engineers | Schema design |
| WebSocket Support | Medium | 120-160 | 2 months | 2 engineers | Replace/augment SSE |

### 10.3 Infrastructure Scaling Estimates

| Scenario | Current | Phase 1 (1 year) | Phase 2 (2 years) | Phase 3 (3+ years) |
|----------|---------|------------------|-------------------|-------------------|
| **Devices Managed** | 500 | 2,000 | 10,000 | 50,000 |
| **Concurrent Users** | 50 | 200 | 1,000 | 5,000 |
| **Kafka Messages/sec** | 1,000 | 5,000 | 20,000 | 100,000 |
| **MongoDB Size** | 10 GB | 50 GB | 500 GB | 5 TB |
| **ScyllaDB Size** | 50 GB | 200 GB | 2 TB | 20 TB |
| **Kubernetes Nodes** | 3-5 | 10-15 | 30-50 | 100+ |
| **Required Effort** | Baseline | 400-600 hrs (scaling) | 800-1200 hrs (sharding) | 1500+ hrs (distributed) |

**Scaling Challenges:**
1. **Database Sharding:** MongoDB sharding required at 10,000+ devices
2. **Topology Performance:** Graph algorithms need optimization at 2,000+ devices
3. **Kafka Partitioning:** Increase partitions from 3 to 10-20 at 20,000+ messages/sec
4. **Frontend Performance:** Virtual scrolling, pagination, lazy loading
5. **Network Bandwidth:** 100Mbps → 1Gbps → 10Gbps

### 10.4 Total Cost of Ownership (TCO) Estimate

**Infrastructure Costs (Annual):**

| Environment | Cloud (AWS/Azure) | On-Premise | Hybrid |
|-------------|-------------------|------------|--------|
| **Development** | $5,000 | $10,000 (hardware) | $7,500 |
| **Staging** | $25,000 | $50,000 | $37,500 |
| **Production (Small)** | $100,000 | $200,000 | $150,000 |
| **Production (Medium)** | $400,000 | $800,000 | $600,000 |
| **Production (Large)** | $1,500,000 | $3,000,000 | $2,250,000 |

**Personnel Costs (Annual):**

| Role | Headcount | Salary (avg) | Total |
|------|-----------|--------------|-------|
| Backend Engineers (Go/Java/Node.js/Python) | 6 | $120,000 | $720,000 |
| Frontend Engineers (React/TypeScript) | 3 | $110,000 | $330,000 |
| DevOps Engineers | 2 | $130,000 | $260,000 |
| Data Scientists (ML/Analytics) | 2 | $140,000 | $280,000 |
| QA Engineers | 2 | $90,000 | $180,000 |
| Technical Lead | 1 | $160,000 | $160,000 |
| Product Manager | 1 | $130,000 | $130,000 |
| **Total** | **17** | | **$2,060,000** |

**Additional Costs:**
- Software licenses (MongoDB Enterprise, ScyllaDB Enterprise, SNMP tools): $50,000/year
- Third-party services (SendGrid, Twilio, Mapbox): $10,000/year
- Training & conferences: $30,000/year
- Miscellaneous (tools, subscriptions): $20,000/year

**Total TCO (Production Medium):**
- Infrastructure: $600,000
- Personnel: $2,060,000
- Additional: $110,000
- **Grand Total: $2,770,000/year**

---

## 11. Risk Assessment & Mitigation

### 11.1 Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| Database scalability bottleneck | High | Medium | Early sharding implementation, ScyllaDB for time-series |
| Kafka message loss | High | Low | Replication factor 3, DLQ topics, monitoring |
| SNMP polling overload | Medium | Medium | HPA for KPI Collector, polling interval tuning |
| Topology graph performance | Medium | High | Algorithm optimization, caching, pagination |
| Third-party API downtime | Medium | Low | Circuit breakers, fallback mechanisms |

### 11.2 Security Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| Unauthorized access | Critical | Medium | JWT expiry, RBAC, MFA (roadmap) |
| Data exfiltration | Critical | Low | Egress filtering, audit logging, encryption |
| SNMP community string leak | High | Medium | SNMPv3 enforcement, credential rotation |
| DDoS attack | High | Medium | Rate limiting, Cloudflare, WAF |
| Insider threat | High | Low | Audit logging, least privilege, separation of duties |

### 11.3 Operational Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| Service outage (single service) | Medium | Low | Circuit breakers, graceful degradation |
| Database corruption | Critical | Very Low | Daily backups, replica sets, point-in-time recovery |
| Kafka broker failure | High | Low | 3 brokers, automatic failover |
| Network partition | High | Low | Multi-zone deployment, service mesh |
| Runbook gaps | Medium | Medium | Comprehensive documentation, incident drills |

---

## 12. Recommendations

### 12.1 Short-Term (Q3 2026)

1. **Complete Phase 1 Device Support** (Switches, APs)
   - Effort: 220-300 hours
   - Team: 2 engineers
   - ROI: Expand addressable market

2. **Implement MFA/2FA**
   - Effort: 80-120 hours
   - Team: 1 engineer
   - ROI: Improved security posture, compliance requirement

3. **Optimize Topology Performance**
   - Effort: 120-160 hours
   - Team: 1 engineer
   - ROI: Support 2,000+ devices without degradation

4. **Offline Map Support**
   - Effort: 60-80 hours
   - Team: 1 frontend engineer
   - ROI: Enable fully offline deployments

### 12.2 Medium-Term (Q4 2026 - Q1 2027)

1. **Phase 2 Device Support** (Routers, Firewalls)
   - Effort: 360-480 hours
   - Team: 3 engineers
   - ROI: Enterprise feature parity

2. **Multi-Tenancy**
   - Effort: 560-720 hours
   - Team: 3-4 engineers
   - ROI: SaaS offering, revenue multiplier

3. **ML Anomaly Detection**
   - Effort: 320-400 hours
   - Team: 2 data scientists + 1 engineer
   - ROI: Differentiation, proactive monitoring

4. **GraphQL API**
   - Effort: 240-320 hours
   - Team: 2 engineers
   - ROI: Developer experience, mobile app foundation

### 12.3 Long-Term (2027+)

1. **Mobile Applications** (iOS + Android)
   - Effort: 800-1200 hours
   - Team: 4 mobile engineers
   - ROI: Field technician support, executive dashboards

2. **Phase 3 Device Support** (Optical, SD-WAN, IoT)
   - Effort: 580-760 hours
   - Team: 3-4 engineers
   - ROI: Comprehensive network management

3. **Predictive Analytics**
   - Effort: 400-600 hours
   - Team: 2 data scientists + 2 engineers
   - ROI: Reduce downtime, optimize maintenance

4. **Edge Computing Architecture**
   - Effort: 600-800 hours
   - Team: 3-4 engineers
   - ROI: Offline-first deployments, edge analytics

---

## 13. Conclusion

UBR Open NMS is a production-ready, enterprise-grade network management system with a modern architecture designed for scalability, reliability, and operational excellence. The system currently supports BTS, CPE, and IDU devices with comprehensive monitoring, alarming, configuration, and reporting capabilities.

**Key Strengths:**
- Polyglot microservices architecture (24 services)
- Event-driven design with Apache Kafka
- Multi-protocol device communication (SNMP, NETCONF, TR-069, SSH/CLI)
- Cloud-native deployment (Kubernetes + Helm)
- Comprehensive security (LDAP, JWT, RBAC, audit logging)
- Offline deployment support

**Strategic Opportunities:**
- Expand device support (switches, routers, firewalls, optical)
- Implement multi-tenancy for SaaS offering
- Add ML-based predictive analytics
- Develop mobile applications
- Enhance automation capabilities

**Investment Required:**
- Phase 1 (2026): ~$300,000 (infrastructure) + $2M (personnel)
- Phase 2 (2027): ~$600,000 (infrastructure) + $2.5M (personnel)
- Phase 3 (2028+): ~$1.5M (infrastructure) + $3M+ (personnel)

The system is well-positioned to scale from small deployments (500 devices) to enterprise-scale (50,000+ devices) with appropriate infrastructure investment and engineering resources.

---

**Document Prepared By:** UBR NMS Architecture Team
**Review Cycle:** Quarterly
**Next Review:** October 2026
**Classification:** Internal - Management Review

---

## Appendix A: Contact Information

- **Technical Lead:** [Name TBD]
- **Product Manager:** [Name TBD]
- **DevOps Lead:** [Name TBD]
- **Security Officer:** [Name TBD]

## Appendix B: References

1. [OpenAPI Specifications](./api-specs/)
2. [Architectural Decision Records](./docs/adr/decisions.md)
3. [Developer Onboarding Guide](./docs/onboarding.md)
4. [Runbooks](./docs/runbooks/)
5. [Helm Charts](./helm-charts/)
6. [Monitoring Dashboards](./monitoring/dashboards/)

## Appendix C: Glossary

- **ACS:** Auto Configuration Server (TR-069)
- **BTS:** Base Transceiver Station
- **CPE:** Customer Premises Equipment
- **CWMP:** CPE WAN Management Protocol (TR-069)
- **DLQ:** Dead Letter Queue
- **DWDM:** Dense Wavelength Division Multiplexing
- **HPA:** Horizontal Pod Autoscaler (Kubernetes)
- **IDU:** Indoor Unit
- **mTLS:** Mutual TLS
- **NETCONF:** Network Configuration Protocol (RFC 6241)
- **NMS:** Network Management System
- **OID:** Object Identifier (SNMP)
- **RBAC:** Role-Based Access Control
- **SNMP:** Simple Network Management Protocol
- **SSE:** Server-Sent Events
- **TR-069:** Technical Report 069 (CPE auto-configuration)
- **TTL:** Time To Live
