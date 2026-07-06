# UBR Open Network Management System (UBR NMS)

**Airtel Telecom FCAPS Platform** | Node.js · Java · Go · Python · React

---

## Directory Layout

```
UBR-Open-NMS/
├── api-specs/              # OpenAPI 3.0 YAML specs for all 11 REST services
├── docs/                   # Architecture diagrams, runbooks, ADRs
├── frontend/               # React SPA (Vite + TypeScript)
├── helm-charts/            # Kubernetes Helm charts for all microservices
├── scripts/                # Build, deploy, and data-migration scripts
├── shared-libs/
│   ├── go/                 # Go model structs + shared utility package
│   ├── java/               # Java POJOs + shared Spring utilities
│   ├── json-schemas/       # Language-neutral JSON Schema definitions
│   ├── python/             # Python dataclasses + shared utilities
│   ├── test-fixtures/      # Mock data fixtures (3 samples per model)
│   └── typescript/         # TypeScript interfaces + shared Node.js utilities
└── services/
    ├── api-gateway/        # Node.js — JWT validation, RBAC, routing, rate-limiting
    ├── auth-service/       # Node.js — LDAP/JWT auth, RBAC, session management
    ├── alarm-service/      # Node.js — Alarm correlation, deduplication, acknowledgement
    ├── audit-service/      # Node.js — Immutable audit logging (1-year retention)
    ├── config-push-worker/ # Python — NETCONF/CLI/TR-069 device communication
    ├── config-service/     # Node.js — Template CRUD, config push, approval workflow
    ├── discovery-service/  # Go — mTLS device onboarding, SNMP/ICMP scan
    ├── event-collector/    # Node.js — SNMP trap and syslog ingestion → Kafka
    ├── inventory-service/  # Java/Spring Boot — Device CRUD, search, birth certificates
    ├── kpi-aggregation/    # Java — 15-min/1-hour/daily KPI rollups → ScyllaDB
    ├── kpi-collector/      # Go — SNMP KPI polling → Kafka raw-kpi topic
    ├── kpi-query/          # Node.js — KPI time-series queries, threshold management
    ├── notification-service/ # Node.js — SSE real-time alerts, multi-channel rules
    ├── report-service/     # Python — Async report generation (PDF/XLSX/CSV)
    └── topology-service/   # Go — Network graph computation, map view
```

---

## Technology Stack

| Service           | Language  | Framework       | Database        |
|-------------------|-----------|-----------------|-----------------|
| api-gateway       | Node.js   | Express 4       | Redis           |
| auth-service      | Node.js   | Express 4       | MongoDB + Redis |
| alarm-service     | Node.js   | Express 4       | MongoDB         |
| audit-service     | Node.js   | Express 4       | MongoDB         |
| config-service    | Node.js   | Express 4       | MongoDB         |
| event-collector   | Node.js   | Express 4       | Kafka           |
| kpi-query         | Node.js   | Express 4       | ScyllaDB        |
| notification-service | Node.js | Express 4      | Redis + Kafka   |
| inventory-service | Java 17   | Spring Boot 3   | MongoDB         |
| kpi-aggregation   | Java 17   | Spring Boot 3   | ScyllaDB        |
| discovery-service | Go 1.22   | net/http        | MongoDB         |
| kpi-collector     | Go 1.22   | net/http        | Kafka           |
| topology-service  | Go 1.22   | net/http        | MongoDB         |
| config-push-worker | Python 3.12 | FastAPI      | MongoDB         |
| report-service    | Python 3.12 | FastAPI      | MongoDB         |
| frontend          | TypeScript | React + Vite   | —               |

---

## Infrastructure

- **Message Bus**: Kafka (topics: raw-alarms, processed-alarms, raw-kpi, config-push, device-discovered, netcool-alarms-forward, mycom-kpi-export, inventory-sync)
- **Cache / Session Store**: Redis Cluster
- **Document Store**: MongoDB (alarms, devices, configs, users, audit)
- **Time-Series**: ScyllaDB (KPI data, 1-week TTL)
- **Service Mesh**: Istio with mTLS
- **Container Platform**: Kubernetes + NGINX Ingress
- **Observability**: Prometheus + Grafana

---

## Quick Start

```bash
# 1. Start the full local stack (MongoDB, Redis, Kafka + all services)
docker compose -f docker-compose.dev.yml up --build -d

# 2. Seed the database with realistic test data
make seed
# or directly: cd scripts && npm install && node seed.js

# 3. Open the UI
open http://localhost:5173
```

---

## Seed Data

The `scripts/seed.js` script populates all MongoDB collections with realistic data
so every UI feature can be tested immediately.

| Collection         | What is seeded |
|--------------------|----------------|
| `users`            | 5 users (admin, operator, noc_operator, viewer, disabled) |
| `organizations`    | 2 orgs: Airtel Delhi & Airtel Mumbai |
| `hierarchy_views`  | 2 circles: Delhi North, Mumbai West |
| `networks`         | 3 networks (DN, DS, MW) |
| `devices`          | **14 devices** — 3 BTS, 8 CPE, 3 IDU across Delhi & Mumbai |
| `birth_certificates` | 5 auto-registration records |
| `alarms`           | **10 alarms** — 2 CRITICAL, 2 MAJOR, 2 MINOR, 1 WARNING, 1 ACK, 2 CLEARED |
| `alarm_thresholds` | 8 default threshold rules |
| `kpi_warm`         | **1,521 hourly buckets** — 7 days × 9 devices (RSSI, SNR, CPU, throughput, …) |
| `config_templates` | 4 templates: BTS-Standard, CPE-Home, CPE-Enterprise, IDU-P2P |
| `config_versions`  | 4 config change history records |
| `pending_commands` | 2 in-flight device commands (REBOOT, FIRMWARE_UPGRADE) |
| `topology_nodes`   | 14 nodes mirroring the device fleet |

### Login credentials after seeding

| Role       | Username      | Password          |
|------------|---------------|-------------------|
| Admin      | `admin`       | `Admin@NMS2024!`  |
| Operator   | `operator`    | `Operator@NMS2024!` |
| NOC Ops    | `noc_operator`| `NocOp@NMS2024!`  |
| Viewer     | `viewer`      | `Viewer@NMS2024!` |

```bash
# Re-seed from scratch (drops all NMS collections first)
make seed-reset
# or: cd scripts && node seed.js --reset

# Target a different MongoDB instance
MONGO_URL=mongodb://user:pass@host:27017 make seed
```

---

## Other Make targets

```bash
# Build all services (stubs)
make build-all

# Run all tests
make test-all

# Lint all code
make lint-all
```

---

## Contribution Guidelines

1. **Branching**: `feature/<WO-ID>-short-description` off `dev`
2. **Commits**: Must follow `[WO-<id>] <description>` format (enforced by git hook)
3. **Tests**: All code must have ≥80% unit test coverage
4. **Pre-commit**: The Forge pre-commit checklist must be completed before any WO commit
5. **API Changes**: Update the corresponding `api-specs/*.yaml` in the same PR
6. **Security**: No secrets committed — use `.env.example` and environment variables
7. **Code Review**: All PRs require at least one review before merge to `main`

---

*Built for Airtel Telecom — Managed by Senao Networks*
