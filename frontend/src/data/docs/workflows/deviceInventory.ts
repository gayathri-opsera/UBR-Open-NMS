import type { DocPage } from '../../../types/docs';

export const DEVICE_INVENTORY_PAGE: DocPage = {
  slug: 'device-inventory',
  title: 'Device Inventory',
  description: 'Browse, search, filter, and manage all network devices. Understand device states, bulk operations, and the device lifecycle.',
  readTime: 6,
  appRoute: '/v2/devices',
  personas: ['Admin', 'Operator'],
  lastUpdated: '2026-11-06',
  content: `# Device Inventory

The Inventory page (\`/v2/devices\`) is the central registry of all managed network devices in UBR NMS.

## Device States

| State | Meaning |
|-------|---------|
| **UP** | Device is responding to SNMP polls and within normal thresholds |
| **DOWN** | Device is not responding to SNMP polls (unreachable) |
| **DEGRADED** | Device responds but has active MAJOR/CRITICAL alarms |
| **MAINTENANCE** | Manually put into maintenance mode; alarms are suppressed |
| **NEW** | Recently onboarded, not yet assigned to a hierarchy node |
| **DECOMMISSIONED** | Removed from active monitoring; retained for audit history |

## Searching and Filtering

Use the search bar to find devices by:
- **Name** — partial match, case-insensitive
- **IP address** — exact or prefix match (e.g. \`10.1.5\`)
- **Serial number** — exact match
- **Model** — e.g. \`ENS620EXT\`

Filter chips let you narrow by: Status / Device Group / Hierarchy Node / Product Type / Last Seen.

## Device Table Columns

| Column | Description |
|--------|-------------|
| Name | Device hostname or friendly name |
| IP | Management IP address |
| Status | UP / DOWN / DEGRADED / MAINTENANCE / NEW |
| Model | Hardware model from SNMP sysDescr |
| Group | Assigned device group |
| Last Seen | Last successful SNMP poll timestamp |
| Alarms | Count of active CRITICAL + MAJOR alarms |

## Bulk Operations

Select multiple devices using the checkbox column, then use the **Bulk Actions** dropdown:
- **Assign to Group** — move to a device group
- **Set Hierarchy** — assign to an org hierarchy node
- **Enable Maintenance** — suppress alarms for all selected
- **Export** — download selected device details as CSV
- **Delete** — remove from inventory (requires Admin role; device is decommissioned, not hard-deleted)

## Column Customisation

Click the **Columns** button (top right of the table) to show/hide columns and reorder them. Your preference is saved in browser local storage.

## CSV Export

Click **Export** (top right) to download the full inventory (filtered) as CSV. Fields include all device metadata, last-seen timestamps, and active alarm counts.
`,
  faqs: [
    {
      question: 'How do I add a device manually?',
      answer: 'Click **Add Device** (top right of the Inventory page). Enter the IP address, select an SNMP credential profile, and optionally set a name and hierarchy. The device is polled immediately upon saving.',
    },
    {
      question: 'A device shows UP but its alarms say CRITICAL — is that correct?',
      answer: 'Yes. Status UP means the device responds to SNMP polls (it is reachable). CRITICAL alarms relate to thresholds or specific OID conditions (e.g. link down on a port) which can fire even on a reachable device.',
    },
    {
      question: 'How do I permanently remove a device?',
      answer: 'Select the device(s) and use **Bulk Actions → Delete**. This marks them as DECOMMISSIONED and removes them from active monitoring. Historical alarms and KPI data are retained for the configured retention period.',
    },
  ],
};

export const DEVICE_DETAIL_PAGE: DocPage = {
  slug: 'device-detail',
  title: 'Device Detail',
  description: 'Deep-dive into a single device — overview, alarms, KPIs, Node View live parameters, config, and audit history.',
  readTime: 5,
  appRoute: '/v2/devices',
  personas: ['Admin', 'Operator'],
  lastUpdated: '2026-11-06',
  content: `# Device Detail

Clicking any device in Inventory opens the Device Detail page (\`/v2/devices/:id\`). This is the single pane of glass for a device.

## Tabs

| Tab | Contents |
|-----|----------|
| **Overview** | IP, model, firmware, uptime, last seen, serial, hierarchy, product definition |
| **Alarms** | Active alarms scoped to this device; same filter/ack controls as the global Alarms page |
| **KPI** | Metric charts scoped to this device; selectable time range |
| **Node View** | Live SNMP parameters (if product definition or MIB Builder descriptor linked) |
| **Config** | Current running config, diff from last push, config push history |
| **Audit** | Full audit log — who changed what and when |

## Maintenance Mode

Click **Maintenance Mode** (top right header) to suppress all new alarms from this device. Set a duration (15 min to 24 hr). The device appears with a 🔧 badge in inventory and the alarm count is excluded from dashboards.

## Edit Device

Click **Edit** (top right) to update: name, IP, SNMP credential profile, hierarchy assignment, device group, and Product Definition link.

## Framework Parameters

If the device has a Product Definition with Adaptive Panel support, a **Framework Parameters** link appears. This opens the full parameter panel at \`/v2/devices/:id/framework-parameters\`.
`,
};
