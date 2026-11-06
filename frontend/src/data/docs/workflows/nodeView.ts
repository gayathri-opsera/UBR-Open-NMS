import type { DocPage } from '../../../types/docs';

export const NODE_VIEW_PAGE: DocPage = {
  slug: 'node-view',
  title: 'Node View — Live SNMP Parameters',
  description:
    'View real-time SNMP parameter values for any device using the Node View tab on the Device Detail page. Understand the two render modes and live refresh behaviour.',
  readTime: 8,
  appRoute: '/v2/devices',
  personas: ['Admin', 'Operator'],
  lastUpdated: '2026-11-06',
  content: `# Node View — Live SNMP Parameters

The **Node View** tab appears on the Device Detail page (\`/v2/devices/:id\`) when the device has a Product Definition or a MIB Builder descriptor linked to it. It shows real-time SNMP parameter values grouped into logical sections.

## Two Render Modes

### Mode 1 — MIB Builder Descriptor (Preview Layout)
Used when the device has a published MIB Builder wireframe (\`registryVersion: "ui-builder"\`).

Appearance:
- Full-width card per section with a coloured header bar
- **Uppercase** parameter labels
- OID displayed in monospace below the label (e.g. \`1.3.6.1.4.1.14125.2.1.1.1\`)
- 2-column responsive grid for parameter values
- **Apply (SNMP SET)** / **Revert** buttons for writable sections
- Section header shows either \`Read-only · polled every N s\` or \`Read-write objects — changes are sent as one SNMP SET\`

### Mode 2 — Java Product Definition (Sidebar Layout)
Used when the device uses a classic Java registry definition.

Appearance:
- Left sidebar with page navigation (Wireless / Network / Management / Monitor)
- Tabbed groups within each page
- Parameter fields with inline edit for writable parameters

## Live Refresh

| Section type | Refresh behaviour |
|-------------|-------------------|
| **Monitor sections** (all read-only) | Live-polled every N seconds (set in MIB Builder, min 2s, max 300s) |
| **Configuration sections** (any writable field) | Polled on page load only |
| **Monitor page (Java mode)** | Polled every 2s (Link tabs) or 5s (others) |

Live refresh uses a **dedicated endpoint**: \`GET /api/v1/node-view/:deviceId/monitor-live?groups=...\`

This endpoint does precise SNMP GETs for specific OIDs rather than a full walk — keeping the refresh fast and low-impact on the device.

## Applying a Configuration Change (SNMP SET)

1. In a **Read-write** section, modify one or more values
2. Changed fields highlight in amber
3. Click **Apply (SNMP SET)** — the gateway sends a single SNMP SET PDU with all changed OIDs
4. Success: values update immediately and return to normal highlighting
5. Error: a toast shows the SNMP error (e.g. \`noAccess\`, \`wrongValue\`, \`commitFailed\`)
6. Click **Revert** at any time before applying to discard local changes

## Status Indicators

| Label | Meaning |
|-------|---------|
| 🟢 Live value | Polled within the last refresh interval |
| 🟡 STALE | Last successful poll was > 2× the refresh interval ago |
| ⚫ NOT_POLLED | Device has never been successfully polled for this OID |
| ❌ Error | SNMP GET returned an error (check device credentials) |

## Why is my Node View empty?

The Node View only appears when **at least one** of these is true:
1. The device has a **Product Definition ID** linked (visible in Device Detail → Overview → Framework tab)
2. The device has a **MIB Builder descriptor published** that is associated with this device type

If the tab is missing, link a Product Definition via **Inventory** → edit device → **Framework**.

## Index-based Tables

For OIDs with table indices (e.g. interface statistics, per-port counters), the Node View renders a data table with one row per index instance. The index column shows the SNMP index value and a friendly name when available from the MIB.
`,
  faqs: [
    {
      question: 'What does "STALE" mean?',
      answer:
        'STALE means the last successful SNMP poll for this OID was more than twice the configured refresh interval ago. Common causes: device temporarily unreachable, SNMP agent overloaded, or network congestion. The value shown is the last known good value.',
    },
    {
      question: 'Why can\'t I set live refresh on a section with writable fields?',
      answer:
        'Live refresh is only allowed when ALL fields in a section are read-only. This is a safety constraint: automatically polling a read-write section could cause unintended side effects on some SNMP agents. Move writable fields to a separate section to enable live refresh on the read-only part.',
    },
    {
      question: 'How do I add new parameters to the Node View?',
      answer:
        'If the device uses a MIB Builder descriptor, go to **Custom UI Builder** (\`/v2/mib-builder\`), open the descriptor, add the new OIDs, and re-publish. The Node View updates immediately for all devices linked to that descriptor. If using a Java Product Definition, contact your system administrator.',
    },
    {
      question: 'The Apply button is greyed out — why?',
      answer:
        'The Apply button is active only when at least one field value has been changed locally. Modify a value first, then Apply becomes clickable.',
    },
  ],
};
