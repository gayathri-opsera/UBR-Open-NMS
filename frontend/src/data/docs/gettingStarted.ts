import type { DocSection } from '../../types/docs';

export const GETTING_STARTED_SECTION: DocSection = {
  id: 'getting-started',
  title: 'GETTING STARTED',
  icon: '📚',
  pages: [
    {
      slug: 'introduction',
      title: 'What is NMS?',
      description:
        'An overview of the NMS — a cloud-native FCAPS platform for Airtel telecom infrastructure.',
      readTime: 6,
      appRoute: '/v2/dashboard',
      personas: ['All'],
      lastUpdated: '2026-11-06',
      content: `# What is NMS?

**NMS** is a cloud-native FCAPS platform for managing wireless telecommunications infrastructure — BTS (Base Transceiver Stations), CPE (Customer Premises Equipment), and IDU (Indoor Units) — across Airtel's network.

## Core Capabilities

| Capability | Description |
|------------|-------------|
| **Device Inventory** | Register, monitor, and decommission network devices with full lifecycle tracking |
| **Alarm Management** | Real-time SNMP trap ingestion, correlation, and NOC acknowledgment workflow |
| **KPI Monitoring** | SNMP polling with 15-min/hourly/daily rollups and threshold alerting |
| **Config Management** | Template-based push via NETCONF / TR-069 / CLI |
| **Network Topology** | Live graph computation and geospatial map |
| **Discovery** | SNMP/ICMP subnet scanning + mTLS device self-registration |
| **Custom UI Builder** | Build SNMP parameter screens from MIB files without coding |
| **Reports** | Async PDF/XLSX/CSV generation with scheduling |
| **Compliance & Audit** | Automated policy checks and full audit trail |
| **Framework Operations** | Multi-vendor adapter health, guided failure analysis |

## User Personas

### Rajesh — NOC Operator, Delhi North
Monitors 1,200 BTS devices. When a CRITICAL alarm fires, he sees it via real-time SSE push, acknowledges it in 2 clicks, and dispatches a field team — all without leaving the Alarms page. MTTR reduced from 45 min → 12 min.

### Priya — Network Admin
Manages config templates for 3,000+ CPE devices. Updates a TR-069 template, previews the diff, and pushes to 500 devices in one batch. Config changes: 2 days → 30 minutes.

### Amit — Field Engineer
Discovers a new IDU using the Discovery page, scans the subnet, and the device auto-registers via mTLS. Assigned to "Mumbai West" hierarchy and immediately monitored. Device onboarding: 1 hour → 5 minutes.

### Dhruv — Descriptor Author
Uploads an EnGenius SENAO MIB file into the Custom UI Builder, maps 15 OIDs to display widgets, and publishes a live screen for the Node View. Field engineers immediately see real-time SNMP values without any backend code change. New device type onboarded: 2-week dev sprint → under 1 hour.

## Navigation Structure

The left sidebar organises all features by category:

- **Overview** — Dashboard, My Dashboards
- **Network** — Inventory, Alarms, Topology, KPI, Device Groups
- **Operations** — Config, Troubleshoot, Reports, Discovery, Onboarding, Release Validation, Compliance
- **Admin** — Org Hierarchy, Notifications, Admin
- **Framework** — Framework Ops, Product Definitions, Descriptor Registry, Node View Designer, Custom UI Builder, Security & Audit
- **Help** — Documentation (you are here)

## Technical Architecture

NMS is built as polyglot microservices deployed on Kubernetes:

\`\`\`
Browser (React 19 + Vite)
    │
    ▼
api-gateway (Node.js / Express)   ← primary backend
    ├── inventory-service          (Node.js, MongoDB)
    ├── alarm-service              (Node.js, MongoDB + Kafka)
    ├── kpi-query-service          (Node.js, ScyllaDB)
    ├── config-service             (Node.js)
    ├── topology-service           (Node.js)
    ├── discovery-service          (Node.js)
    ├── notification-service       (Node.js)
    ├── audit-service              (Node.js)
    ├── report-service             (Python FastAPI)
    └── product-definition-service (Java Spring Boot)
\`\`\`
`,
      faqs: [
        {
          question: 'What SNMP versions does NMS support?',
          answer:
            'SNMP v1, v2c, and v3 (with USM authentication and AES-128 privacy). v3 is recommended for production — configure it in the device credentials section under Admin.',
        },
        {
          question: 'How many devices can NMS manage?',
          answer:
            'The reference architecture handles 10,000+ devices per cluster. SNMP polling uses a distributed worker pool, Kafka buffers trap events, and ScyllaDB stores KPI time-series at scale.',
        },
        {
          question: 'Is NMS multi-tenant?',
          answer:
            'Yes. Devices are assigned to Org Hierarchy nodes. Role-based access control (RBAC) ensures operators only see devices in their circle. Admin users see everything.',
        },
      ],
    },

    {
      slug: 'quick-start-operator',
      title: 'Quick Start: NOC Operator',
      description:
        'Get productive in 10 minutes — monitor alarms, check device health, and view KPI dashboards.',
      readTime: 5,
      appRoute: '/v2/alarms',
      personas: ['Operator'],
      lastUpdated: '2026-11-06',
      content: `# Quick Start: NOC Operator

You will be monitoring live alarms and device health in under 10 minutes.

## Step 1 — Log In

Navigate to your NMS URL and log in with your credentials. You will land on the **Dashboard** at \`/v2/dashboard\`.

## Step 2 — Check Live Alarms

Click **Alarms** in the left sidebar (\`/v2/alarms\`).

The alarm table updates in **real-time** via Server-Sent Events — you do not need to refresh the page. Alarms are colour-coded by severity:

| Colour | Severity | SLA |
|--------|----------|-----|
| 🔴 Red | CRITICAL | 15 minutes |
| 🟠 Orange | MAJOR | 1 hour |
| 🟡 Yellow | MINOR | 4 hours |
| 🔵 Blue | WARNING | — |
| ⚪ Grey | INFO | — |

## Step 3 — Acknowledge an Alarm

1. Click the alarm row to expand details.
2. Click **Acknowledge** and optionally add a note (e.g. "Dispatching field team").
3. The alarm moves to the ACKNOWLEDGED state — it stays visible but is no longer counted in the unacknowledged total.

## Step 4 — Check Device Health

Click **Inventory** → find the device → click its row to open **Device Detail**.

The detail page shows:
- **Overview** — uptime, last seen, IP, model, firmware
- **Alarms** tab — active alarms for this device
- **KPI** tab — real-time and historical metrics
- **Node View** tab — live SNMP parameter values (if configured)
- **Config** tab — running configuration (if supported)

## Step 5 — Monitor KPIs

Click **KPI** in the sidebar (\`/v2/kpi\`). Select a device group and time window to see aggregated performance metrics.

For a quick daily health summary go to **KPI → Operations Summary** (\`/v2/kpi/operations\`).
`,
    },

    {
      slug: 'quick-start-admin',
      title: 'Quick Start: Network Admin',
      description:
        'Set up your first device group, configure SNMP credentials, push a config template, and manage users.',
      readTime: 8,
      appRoute: '/v2/admin',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Quick Start: Network Admin

## Step 1 — Set Up Organisation Hierarchy

Navigate to **Admin → Org / Hierarchy** (\`/v2/hierarchy\`). Create your circle and cluster nodes to match your geographic/organisational structure. All devices are assigned to leaf nodes in this tree, and RBAC is enforced at the hierarchy level.

## Step 2 — Add SNMP Credentials

Go to **Admin** (\`/v2/admin\`) → **Credential Vault**. Add an SNMP credential profile:
- **v2c**: community string
- **v3**: username, auth protocol (MD5/SHA), auth passphrase, priv protocol (AES-128/DES), priv passphrase

## Step 3 — Discover Devices

Go to **Discovery** (\`/v2/discovery\`). Enter the subnet CIDR (e.g. \`192.168.10.0/24\`), select your SNMP credential profile, and click **Start Scan**. Responding devices appear in the results table. Select all and click **Onboard** to add them to inventory.

## Step 4 — Assign to Hierarchy

After onboarding, go to **Inventory** and filter by "unassigned". Bulk-select the new devices and assign them to the correct hierarchy node.

## Step 5 — Push a Config Template

Go to **Config** (\`/v2/config\`). Select or create a template, preview the rendered config, select target devices (up to 500), and click **Push**. Monitor progress in the Config Jobs table.

## Step 6 — Manage Users

Go to **Admin → Users**. Add users, assign roles (Admin / Operator / Viewer / descriptor_admin / descriptor_author), and restrict to hierarchy nodes as needed.
`,
    },

    {
      slug: 'quick-start-discovery',
      title: 'Quick Start: Discover Your First Device',
      description: 'Discover and onboard a new device into NMS using subnet scanning and mTLS auto-registration.',
      readTime: 4,
      appRoute: '/v2/discovery',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Quick Start: Discover Your First Device

## Prerequisites

- Device is reachable on the network (ICMP ping succeeds)
- You know the SNMP community string or v3 credentials
- You have an Admin or Operator role

## Method A — Subnet Scan

1. Go to **Discovery** (\`/v2/discovery\`)
2. Click **New Scan**
3. Enter: **Subnet** (e.g. \`10.1.5.0/24\`), **SNMP Profile** (from your credential vault)
4. Click **Start Scan** — the scan runs asynchronously (progress bar shown)
5. When complete, devices appear in the **Results** table with IP, sysDescr, and SNMP response time
6. Select the devices you want to add → click **Onboard Selected**
7. Devices are added to Inventory with status **NEW**

## Method B — Manual Add

If you know the IP address:
1. Go to **Inventory** → **Add Device**
2. Fill in IP, SNMP profile, expected product definition
3. Click **Save** — the system polls the device immediately to verify connectivity

## Method C — mTLS Auto-Registration

For devices that support the NMS agent:
1. Install the UBR agent on the device (see your hardware vendor documentation)
2. The agent presents an mTLS certificate to the registration endpoint
3. The device auto-appears in Inventory with status **PENDING_APPROVAL**
4. Admin approves from **Onboarding** (\`/v2/onboarding\`)

## After Discovery

Assign the device to a hierarchy node, link a Product Definition (if available), and verify SNMP polling is active by checking the **Node View** tab on the device detail page.
`,
    },
  ],
};
