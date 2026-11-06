import type { DocSection } from '../../../types/docs';

export const REFERENCE_SECTION: DocSection = {
  id: 'reference',
  title: 'REFERENCE',
  icon: '📖',
  pages: [
    {
      slug: 'glossary',
      title: 'Glossary',
      description:
        'Definitions for all UBR NMS, telecom, and SNMP terminology used throughout the platform.',
      readTime: 8,
      lastUpdated: '2026-11-06',
      content: `# Glossary

## Network Management Terms

**BTS — Base Transceiver Station**
A fixed radio transceiver that communicates with mobile devices. Managed by UBR NMS for Airtel's wireless network.

**CPE — Customer Premises Equipment**
Devices installed at a customer site: routers, modems, IDUs. Managed via TR-069 / CWMP.

**IDU — Indoor Unit**
The indoor part of a point-to-point microwave link. Pairs with an ODU (Outdoor Unit).

**FCAPS**
ITU-T framework for network management: Fault, Configuration, Accounting, Performance, Security.

**NOC — Network Operations Centre**
The team responsible for monitoring and operating the network 24×7.

**MTTA — Mean Time to Acknowledge**
Average time from an alarm firing (NEW) to an operator acknowledging it. Target: < 5 minutes for CRITICAL.

**MTTR — Mean Time to Repair**
Average time from an alarm firing (NEW) to it being resolved (CLEARED).

**SLA — Service Level Agreement**
Target response times: CRITICAL = 15 min, MAJOR = 1 hr, MINOR = 4 hr.

---

## SNMP Terms

**SNMP — Simple Network Management Protocol**
The primary protocol used by UBR NMS to monitor and control network devices. UDP-based, port 161 (queries) and 162 (traps).

**OID — Object Identifier**
A dotted-decimal address identifying a specific managed object in the SNMP MIB tree. Example: \`1.3.6.1.2.1.1.1.0\` = sysDescr.

**MIB — Management Information Base**
A structured text file (SMIv2 format) that defines the OIDs a device supports, their data types, and descriptions. UBR NMS parses MIBs in the Custom UI Builder.

**sysDescr** (OID: \`1.3.6.1.2.1.1.1.0\`)
The device system description string. Used for device identification and auto-matching to Product Definitions.

**sysObjectID** (OID: \`1.3.6.1.2.1.1.2.0\`)
The vendor-assigned unique OID prefix for this device type. Used to auto-link MIB Builder descriptors.

**SNMP Trap**
An unsolicited notification sent from the device to UBR NMS when an event occurs (e.g. link down). UBR NMS listens for traps on UDP port 162.

**SNMP GET**
A query from UBR NMS to the device requesting the current value of an OID.

**SNMP SET**
A command from UBR NMS to the device to change the value of a writable OID. Used by Node View Apply (SNMP SET) button.

**SNMP Walk**
Traverses an OID subtree, fetching all values. Available in the Troubleshoot page.

**SNMPv3 USM — User-Based Security Model**
The security layer for SNMPv3: provides authentication (MD5/SHA) and encryption (AES-128/DES).

**Community String**
The SNMPv1/v2c shared "password" — a plain-text string sent with every SNMP request. Use SNMPv3 in production.

---

## UBR NMS Specific Terms

**Product Definition**
An XML or JSON file that defines how UBR NMS manages a specific device type — polling schedule, KPI mappings, alarm rules, and config templates.

**MIB Builder Descriptor**
A UI-designed screen definition (stored in \`node_view_wireframes\`) that determines what SNMP parameters are shown in the Node View and how they are displayed.

**registryVersion**
A field on a device's linked wireframe. \`"ui-builder"\` means the device uses a MIB Builder descriptor for its Node View. Any other value means a Java Product Definition.

**liveRefreshSeconds**
The interval (in seconds) at which a read-only Node View section is live-polled. Set in the MIB Builder. Minimum 2 s, maximum 300 s. Only effective when all fields in the section are read-only.

**Node View**
The tab on Device Detail that shows real-time SNMP parameters for a device. Rendered either in MIB Builder descriptor mode or Java Product Definition mode.

**monitor-live endpoint**
\`GET /api/v1/node-view/:deviceId/monitor-live?groups=...\` — the backend endpoint that performs precise SNMP GETs for specific OIDs and returns current values. Called by the frontend's live refresh timer.

**Maker-Checker**
A dual-approval workflow for descriptor publishing: one user creates/submits (maker), a different user approves/publishes (checker). Prevents single-user errors in production.

**mTLS — Mutual TLS**
Device authentication where both the UBR NMS server and the device present certificates. Used for auto-registration in the Onboarding flow.

**SSE — Server-Sent Events**
A one-directional HTTP streaming mechanism used by UBR NMS to push real-time alarm updates to the browser. The Alarms page stays live without polling.

**Vite**
The build tool used for the UBR NMS frontend. Content-hashed JS/CSS bundles ensure the browser always loads the latest version after a deployment.

---

## Status Values

| Status | Context | Meaning |
|--------|---------|---------|
| UP | Device | Device is responding to SNMP polls |
| DOWN | Device | Device is not responding |
| DEGRADED | Device | Responding but has active CRITICAL/MAJOR alarms |
| MAINTENANCE | Device | Alarms suppressed during planned maintenance |
| NEW | Device | Onboarded but not yet assigned to hierarchy |
| STALE | Node View value | Last poll was > 2× the refresh interval ago |
| NOT_POLLED | Node View value | OID has never been successfully polled |
| NEW | Alarm | Alarm has fired, not yet acknowledged |
| ACKNOWLEDGED | Alarm | Operator has seen it and is working on it |
| CLEARED | Alarm | Condition resolved |
`,
    },

    {
      slug: 'api-reference',
      title: 'API Reference',
      description:
        'REST API documentation for all UBR NMS microservices. 10 of ~28 services have published OpenAPI 3.0 specs.',
      readTime: 15,
      lastUpdated: '2026-11-06',
      autoGenerated: true,
      content: `# API Reference

REST API documentation for UBR NMS microservices.

> **Dev base URL:** \`http://localhost:3100/api/v1\`
> **Auth:** All endpoints require \`Authorization: Bearer <JWT>\`
> Get a token via \`POST /auth/login\` with \`{ username, password }\`

> ⚠️ **Coverage:** 10 of ~28 services have published OpenAPI 3.0 specs. Services without specs (api-gateway, event-collector, kpi-collector, kpi-aggregation, config-push-worker, product-definition-service) are covered in the [Architecture](/v2/docs/architecture) page.

---

## Auth Service

Authentication, JWT management, user administration, and SSO.

| Method | Path | Description |
|--------|------|-------------|
| POST | \`/auth/login\` | Authenticate with username + password; returns JWT pair |
| POST | \`/auth/refresh\` | Refresh access token using refresh token |
| POST | \`/auth/logout\` | Revoke refresh token |
| GET | \`/users\` | List all users (Admin only) |
| GET | \`/users/:id\` | Get user by ID |
| PUT | \`/users/:id/change-password\` | Change password |
| GET | \`/auth/sso/initiate\` | Initiate OIDC/SAML SSO login |
| GET | \`/auth/sso/callback/oidc\` | OIDC callback handler |

---

## Inventory Service

Device lifecycle management — create, read, update, decommission, search, and export.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/inventory/onboarding-status\` | List devices by onboarding status |
| GET | \`/inventory/onboarding-status/:id\` | Get onboarding status for a device |
| GET | \`/devices\` | List all devices (paginated, filterable) |
| POST | \`/devices/search\` | Full-text + field search across inventory |
| GET | \`/devices/export\` | Export inventory as CSV |
| GET | \`/devices/:id\` | Get device by ID |
| PUT | \`/devices/:id\` | Update device metadata |
| DELETE | \`/devices/:id\` | Decommission device |
| GET | \`/devices/:id/birth-certificate\` | Device provenance and registration history |
| POST | \`/devices/generic\` | Add a generic device manually |

---

## Alarm Service

SNMP trap ingestion, alarm lifecycle management, and export.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/alarms\` | List alarms (severity, state, device group filters) |
| GET | \`/alarms/top-reported\` | Top N most-alarmed devices |
| GET | \`/alarms/export\` | Export alarms as CSV |
| GET | \`/alarms/:id\` | Get alarm by ID |
| PUT | \`/alarms/:id/acknowledge\` | Acknowledge alarm with optional note |

---

## KPI Query Service

Retrieve time-series KPI data, latest values, and threshold configuration.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/kpi\` | Query KPI data (device, metric, from, to, resolution) |
| GET | \`/kpi/latest\` | Latest metric values for selected devices |
| GET | \`/kpi/thresholds\` | List configured thresholds |
| POST | \`/kpi/thresholds\` | Create threshold |
| PUT | \`/kpi/thresholds/:id\` | Update threshold |

---

## Discovery Service

Network scanning, device check-in, and discovery mode management.

| Method | Path | Description |
|--------|------|-------------|
| POST | \`/discovery/scan\` | Start a new subnet scan |
| GET | \`/discovery/scan/:scanId/status\` | Get scan progress and results |
| GET | \`/discovery/runs\` | List past scan runs |
| POST | \`/discovery/check-in\` | Device self-registration (mTLS) |
| GET | \`/kv/services\` | Service registry (internal) |
| POST | \`/device\` | Onboard a device from scan results |
| GET | \`/discovery/modes\` | List discovery modes |
| PUT | \`/discovery/modes/:mode\` | Set discovery mode |

---

## Config Service

Config template management and push operations.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/config/templates\` | List config templates |
| POST | \`/config/templates\` | Create template |
| PUT | \`/config/templates/:id\` | Update template |
| DELETE | \`/config/templates/:id\` | Delete template |
| POST | \`/config/push\` | Push config to a single device |
| POST | \`/config/bulk-push\` | Push config to multiple devices |
| GET | \`/config/jobs/:id/status\` | Get config job status |

---

## Topology Service

Network graph computation and geographic map data.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/topology\` | Full network graph (nodes + edges) |
| GET | \`/topology/device/:id\` | Neighbours of a specific device |
| GET | \`/topology/map\` | Devices with GPS coordinates for map view |

---

## Notification Service

Alert rules and real-time event streaming.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/notifications/stream\` | SSE stream of real-time alarm events |
| GET | \`/notifications/rules\` | List notification rules |
| POST | \`/notifications/rules\` | Create rule |
| PUT | \`/notifications/rules/:id\` | Update rule |
| DELETE | \`/notifications/rules/:id\` | Delete rule |

---

## Audit Service

Immutable audit log and retention policy management.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/audit\` | Query audit log (user, action, date range filters) |
| GET | \`/audit/:id\` | Get single audit entry |
| GET | \`/audit/export\` | Export audit log as CSV |
| GET | \`/audit/retention-policies\` | List retention policies |

---

## Report Service

Async report generation, status polling, and download.

| Method | Path | Description |
|--------|------|-------------|
| GET | \`/reports\` | List reports (paginated) |
| POST | \`/reports/generate\` | Request a new report (async) |
| GET | \`/reports/:id\` | Get report status |
| GET | \`/reports/:id/download\` | Download completed report (XLSX/CSV) |
`,
    },

    {
      slug: 'architecture',
      title: 'Architecture',
      description:
        'UBR NMS system architecture — microservices, data flows, Kafka topics, MongoDB collections, and deployment topology.',
      readTime: 10,
      lastUpdated: '2026-11-06',
      content: `# Architecture

## System Overview

UBR NMS is a cloud-native microservices platform deployed on Kubernetes. All services communicate through the **api-gateway** (the single entry point for the browser) and an internal **Kafka message bus** for async events.

## Microservices

| Service | Language | Primary data store | Purpose |
|---------|----------|-------------------|---------|
| **api-gateway** | Node.js / Express | Redis (cache) | Single entry point; SNMP polling orchestration; Node View |
| **auth-service** | Node.js | MongoDB (users) | JWT auth, SSO, RBAC |
| **inventory-service** | Node.js | MongoDB | Device lifecycle, onboarding |
| **alarm-service** | Node.js | MongoDB + Kafka | Trap ingestion, deduplication, state machine |
| **kpi-query-service** | Node.js | ScyllaDB | KPI time-series query |
| **kpi-collector** | Node.js | ScyllaDB | SNMP polling → KPI write |
| **kpi-aggregation** | Node.js | ScyllaDB | 15m/hourly/daily rollups |
| **config-service** | Node.js | MongoDB | Config template + push job management |
| **config-push-worker** | Node.js | — | NETCONF / TR-069 / SSH config push |
| **discovery-service** | Node.js | MongoDB | Subnet scanning, mTLS registration |
| **topology-service** | Node.js | MongoDB | Graph computation from LLDP data |
| **notification-service** | Node.js | MongoDB + Redis | SSE streams, alert rules, email/SMS |
| **audit-service** | Node.js | MongoDB | Immutable audit log |
| **report-service** | Python (FastAPI) | MongoDB + filesystem | XLSX/CSV report generation |
| **product-definition-service** | Java (Spring Boot) | MongoDB | XML/JSON definition registry, MIB parser |
| **event-collector** | Node.js | Kafka | SNMP trap listener (UDP 162) |

## Data Flow — Alarm (SNMP Trap)

\`\`\`
Device sends SNMP trap (UDP 162)
  ↓
event-collector (listener) → Kafka topic: raw.traps
  ↓
alarm-service (consumer) → correlate → deduplicate
  ↓ (write to MongoDB)
alarm-service → Kafka topic: alarms.fired
  ↓
notification-service (consumer) → check rules → send email/SMS/webhook
  ↓
notification-service → SSE stream → browser (real-time update on Alarms page)
\`\`\`

## Data Flow — SNMP Poll (KPI)

\`\`\`
kpi-collector (scheduler) → SNMP GET for each device+OID
  ↓
kpi-collector → write raw 5s/5min samples → ScyllaDB
  ↓
kpi-aggregation (cron) → compute 15min/hourly/daily averages → ScyllaDB
  ↓
kpi-query-service → serve to browser via api-gateway
\`\`\`

## Data Flow — Node View Live Refresh

\`\`\`
Browser timer (liveRefreshSeconds) fires
  ↓
GET /api/v1/node-view/:deviceId/monitor-live?groups=...
  ↓
api-gateway → SNMP GET for exact OIDs in selected groups
  ↓
Return JSON with current values
  ↓
Browser overlays values onto cached state (no flicker)
\`\`\`

## MongoDB Collections (Key)

| Collection | Purpose |
|------------|---------|
| \`devices\` | Inventory — all devices |
| \`alarms\` | Active and historical alarms |
| \`kpi_thresholds\` | Metric threshold rules |
| \`config_templates\` | Config push templates |
| \`config_jobs\` | Config push job history |
| \`discovery_runs\` | Discovery scan history |
| \`notification_rules\` | Alert routing rules |
| \`audit_logs\` | Immutable audit events |
| \`node_view_wireframes\` | MIB Builder published screens |
| \`ui_descriptor_drafts\` | MIB Builder drafts |
| \`product_definitions\` | Product Definition versions |

## Deployment

All services run as Kubernetes Deployments. Horizontal pod autoscaling is configured for high-load services (kpi-collector, alarm-service, api-gateway).

\`\`\`
Kubernetes Cluster
├── Namespace: ubrnms-prod
│   ├── api-gateway         (3 replicas)
│   ├── alarm-service       (2 replicas)
│   ├── kpi-collector       (N replicas — scaled by device count)
│   ├── kpi-aggregation     (1 replica — leader election)
│   ├── product-definition  (2 replicas, Java)
│   └── ... (all other services)
├── Namespace: ubrnms-data
│   ├── MongoDB (3-node replica set)
│   ├── ScyllaDB (3-node cluster)
│   ├── Kafka (3 brokers)
│   └── Redis (1 primary + 1 replica)
└── Namespace: ubrnms-ingress
    └── nginx-ingress-controller
\`\`\`
`,
    },

    {
      slug: 'release-notes',
      title: 'Release Notes',
      description: 'Version history and changelog for UBR NMS.',
      readTime: 5,
      lastUpdated: '2026-11-06',
      content: `# Release Notes

## v2.0.0 — November 2026

### New Features

#### Custom UI Builder (MIB Builder)
- Upload any SMIv2 MIB file and build a live SNMP parameter screen in 3 steps
- Supports 7 widget types: textfield, number, gauge, status-badge, dropdown, toggle, data-table
- Live refresh for read-only sections (min 2 s, max 300 s)
- Published screens immediately live in Node View for all linked devices
- Full descriptor lifecycle with 9-state workflow and maker-checker approval

#### Node View V2
- New Preview layout for MIB Builder descriptors — uppercase labels, OID in monospace, 2-column grid
- Apply (SNMP SET) / Revert buttons for writable sections
- Live refresh using \`monitor-live\` endpoint (precise SNMP GETs, not full walk)
- Dual-mode detection: MIB Builder descriptor (\`registryVersion: "ui-builder"\`) vs Java Product Definition

#### Node View Designer
- Pre-MIB planning tool for designing screen structure before MIB upload
- Design templates for Wireless AP, CPE, BTS device types
- Export design spec for direct import into MIB Builder

#### Product Definition — MIB Upload Tab
- Auto-generate Product Definition XML from uploaded MIB file
- Review and customise before submitting through standard workflow

#### Documentation System
- In-app documentation at \`/v2/docs\` — full product docs with search and PDF export
- 29 app pages documented
- Full-text search powered by Fuse.js
- PDF export via jsPDF + html2canvas (browser-side, no backend dependency)

### Improvements

- Alarm deduplication window reduced from 5 min to 60 s for faster NOC response
- KPI drilldown: added peer device comparison overlay
- Topology: failure island detection and highlighting
- Discovery: combined scan mode (ICMP first, then SNMP on responsive hosts)
- Config: added template variable validation and coverage check
- Compliance: added certificate validity check
- Reports: XLSX output now includes summary sheet

### Bug Fixes

- Fixed Node View live refresh not activating on Monitor sections with all read-only fields
- Fixed alarm SSE stream disconnecting after 30 seconds (keep-alive headers now sent)
- Fixed topology not showing LLDP neighbours for devices with large MAC tables
- Fixed config push job showing IN_PROGRESS indefinitely when device is unreachable

---

## v1.5.0 — August 2026

- Added Adaptive Device Parameter Panels (framework-parameters route)
- KPI Operations Summary page
- KPI Drilldown with time-range comparison
- Release Validation with canary deployment support
- Compliance page with 5 policy types

---

## v1.0.0 — March 2026

- Initial production release
- Core FCAPS: Alarms, Inventory, KPI, Config, Topology, Discovery
- Dashboard, Custom Dashboards
- SNMP v1/v2c/v3 support
- mTLS device auto-registration
- Role-based access control (5 roles)
`,
    },
  ],
};
