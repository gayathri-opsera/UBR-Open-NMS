import type { DocSection } from '../../../types/docs';
import { ALARM_MANAGEMENT_PAGE } from './alarmManagement';
import { NODE_VIEW_PAGE } from './nodeView';
import { DEVICE_INVENTORY_PAGE, DEVICE_DETAIL_PAGE } from './deviceInventory';
import { KPI_MONITORING_PAGE } from './kpiMonitoring';

export const WORKFLOWS_SECTION: DocSection = {
  id: 'network-operations',
  title: 'NETWORK OPERATIONS',
  icon: '🌐',
  pages: [
    ALARM_MANAGEMENT_PAGE,
    KPI_MONITORING_PAGE,
    {
      slug: 'kpi-operations',
      title: 'KPI Operations Summary',
      description: 'Daily at-a-glance view of circle-wise uptime, alarm volumes, MTTA, and MTTR.',
      readTime: 3,
      appRoute: '/v2/kpi/operations',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# KPI Operations Summary

The Operations Summary (\`/v2/kpi/operations\`) provides a daily health briefing for NOC managers.

## What It Shows

- **Circle Uptime %** — availability per org hierarchy node over the selected time window
- **Alarm Volume** — bar chart of alarm counts by severity (last 24h / 7d)
- **Top 10 Most-Alarmed Devices** — click any row to jump to that device's detail
- **MTTA** — Mean Time to Acknowledge (time from NEW to ACKNOWLEDGED)
- **MTTR** — Mean Time to Repair (time from NEW to CLEARED)
- **SLA Compliance** — percentage of CRITICAL alarms acknowledged within the 15-minute SLA

## Auto-Refresh

This page auto-refreshes every 5 minutes. The refresh timestamp is shown in the top-right corner.

## KPI Drilldown

Go to **KPI → Drilldown** (\`/v2/kpi/drilldown\`) for per-device metric comparison with peer overlay and alarm annotations.
`,
    },
    DEVICE_INVENTORY_PAGE,
    DEVICE_DETAIL_PAGE,
    NODE_VIEW_PAGE,
    {
      slug: 'topology',
      title: 'Network Topology',
      description: 'Visualise device interconnections as a live graph. Navigate the network map, identify failure islands, and drill down to device detail.',
      readTime: 5,
      appRoute: '/v2/topology',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Network Topology

The Topology page (\`/v2/topology\`) shows all managed devices as a live interconnection graph. The layout is computed from LLDP/CDP adjacency data collected via SNMP.

## Graph View

Nodes represent devices, edges represent physical or logical links. Node colour reflects device status:
- 🟢 Green — UP
- 🔴 Red — DOWN or CRITICAL alarm
- 🟠 Orange — DEGRADED
- ⚪ Grey — MAINTENANCE or NEW

Click a node to open a mini-panel with the device name, IP, status, and active alarm count. Double-click or click **Open Detail** to go to the full Device Detail page.

## Map View

Switch to **Map** mode (top right) to overlay devices on a geographic map using their configured GPS coordinates. Devices without coordinates appear in a list panel on the left.

## Filtering

Filter by: Device Group / Hierarchy Node / Status / Link Type (physical / LAG / VLAN).

## Failure Islands

The topology engine automatically highlights **failure islands** — groups of devices that are isolated from the core network due to upstream link failures. These appear with a red border around the island cluster.

## Export

Click **Export PNG** to download the current topology graph as a PNG image. The map view can be exported as a PDF.
`,
    },
    {
      slug: 'device-groups',
      title: 'Device Groups',
      description: 'Organise devices into logical groups for bulk operations, KPI aggregation, and access control.',
      readTime: 4,
      appRoute: '/v2/groups',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Device Groups

Device Groups (\`/v2/groups\`) let you organise devices into logical collections for monitoring, reporting, and bulk operations.

## Creating a Group

1. Click **New Group**
2. Enter a name and optional description
3. Select a **match rule**:
   - **Manual** — add devices by selecting them individually
   - **Tag-based** — devices with matching tags are auto-added
   - **Hierarchy-based** — all devices under a hierarchy node

## Using Groups

Groups appear as filter options across all pages (Inventory, Alarms, KPI, Topology, Reports). KPI charts can be scoped to a single group for focused monitoring.

## Group RBAC

You can restrict a group so that only users assigned to it can see the member devices. This is useful for multi-team environments where different teams manage different device sets.
`,
    },
    {
      slug: 'reports',
      title: 'Reports',
      description: 'Generate, schedule, and download PDF, XLSX, and CSV reports for alarms, KPIs, compliance, and device inventory.',
      readTime: 5,
      appRoute: '/v2/reports',
      personas: ['All'],
      lastUpdated: '2026-11-06',
      content: `# Reports

The Reports page (\`/v2/reports\`) lets you generate, schedule, and download network management reports.

## Report Types

| Type | Format | Contents |
|------|--------|---------|
| **Alarm Summary** | PDF, CSV | Alarm counts by severity, top devices, MTTA/MTTR |
| **Device Inventory** | XLSX, CSV | Full device list with status, model, firmware |
| **KPI Performance** | PDF, XLSX | Metric trends for selected device group and time range |
| **Compliance Audit** | PDF | Policy check results, failed devices, remediation summary |
| **Config Change Log** | CSV | Config push history, diff summary, operator who made the change |

## Generating a Report

1. Click **New Report**
2. Select report type
3. Configure parameters (device group, time range, metrics)
4. Click **Generate**

Report generation is **asynchronous** — you get a notification when the report is ready. Reports stay available for 30 days.

## Scheduling Reports

1. Click **Schedule** on any report template
2. Set frequency: Daily / Weekly / Monthly
3. Set delivery time (UTC)
4. Optionally add email recipients

Scheduled reports run automatically and are emailed as PDF/XLSX attachments.

## Downloading

Click the **Download** button on any completed report. Available formats are shown per report type.
`,
    },
  ],
};
