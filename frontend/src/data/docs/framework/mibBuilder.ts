import type { DocPage } from '../../../types/docs';

export const MIB_BUILDER_PAGE: DocPage = {
  slug: 'mib-builder',
  title: 'Custom UI Builder (MIB Builder)',
  description:
    'Build live SNMP parameter screens from MIB files without writing code. Upload a MIB, select OIDs, design sections with widgets, set live refresh, and publish to Node View.',
  readTime: 12,
  appRoute: '/v2/mib-builder',
  personas: ['Admin'],
  lastUpdated: '2026-11-06',
  content: `# Custom UI Builder (MIB Builder)

The Custom UI Builder (\`/v2/mib-builder\`) lets you create live SNMP parameter screens for any device type — without writing any backend code. Once published, the screen appears as the **Node View** tab on every device of that type.

> **Role required:** Admin only.

## 3-Step Flow

\`\`\`
Step 1: MIB Library        Step 2: Build Screen       Step 3: Preview & Publish
─────────────────────      ──────────────────────      ────────────────────────
Upload .mib file     →     Drag OIDs into sections  →  Preview with live data
Parse OIDs               Set widgets & access          Publish to Node View
Select objects           Set liveRefreshSeconds
\`\`\`

---

## Step 1 — MIB Library

### Uploading a MIB File

1. Navigate to **Custom UI Builder** (\`/v2/mib-builder\`)
2. Click **Upload MIB**
3. Select your \`.mib\` file (SMIv2 format)
4. Click **Upload and Parse**

The parser extracts:
- All \`OBJECT-TYPE\` definitions with their OIDs
- Syntax types (\`INTEGER\`, \`DisplayString\`, \`Counter32\`, etc.)
- Access mode (\`read-only\`, \`read-write\`, \`not-accessible\`)
- Description text from the MIB
- Table indices (INDEX clause)

### MIB Object List

After parsing, the object list shows all OIDs in the MIB organised by prefix. Use the search box to filter by name or OID.

**Columns:**
| Column | Meaning |
|--------|---------|
| OID | Full dotted-decimal OID |
| Name | MIB object name |
| Syntax | SNMP data type |
| Access | read-only / read-write |
| Description | From MIB definition |

Select the objects you want to include in your screen (tick the checkboxes), then click **Continue to Build Screen**.

---

## Step 2 — Build Screen

### Sections

A screen is organised into **sections**. Each section becomes a card in the Node View. Create sections for logical groupings, e.g.:
- **Monitor** — read-only real-time stats
- **Configuration** — writable settings
- **Radio** — wireless radio parameters
- **Interface** — per-port statistics

### Adding Fields to a Section

Drag OIDs from the left panel into a section, or click **Add Field** and select from the OID list.

For each field you can configure:

| Setting | Options |
|---------|---------|
| **Display Name** | Custom label (shown in Node View) |
| **Widget Type** | (see Widget Types below) |
| **Access** | read-only / read-write (overrides MIB default if needed) |
| **Unit** | Optional unit label (e.g. "dBm", "Mbps", "%") |
| **Description** | Tooltip text shown on hover |

### Widget Types

| Widget | Best for |
|--------|---------|
| **textfield** | String values, IP addresses, firmware version |
| **number** | Numeric counters, rates (read-only display) |
| **gauge** | Signal strength, CPU %, memory % (0–100 range) |
| **status-badge** | Enum/integer mapped to labels (e.g. 1=UP, 2=DOWN) |
| **dropdown** | Writable enum values |
| **toggle** | Boolean writable OIDs (0/1) |
| **data-table** | OID tables with SNMP index (e.g. interface table) |

### Live Refresh (liveRefreshSeconds)

You can set a live refresh interval on any section where **all fields are read-only**.

> ⚠️ **Rule:** Live refresh is NOT available on sections with any writable field. This is a safety constraint — polling a read-write section automatically could have unintended side effects on some SNMP agents.

To enable:
1. Make sure all fields in the section are set to **read-only**
2. Click the section header → **Section Settings**
3. Set **Live Refresh** to your desired interval (minimum 2 s, maximum 300 s)

Recommended refresh intervals by data type:

| Data type | Recommended interval |
|-----------|---------------------|
| Signal strength / RSSI | 5 s |
| Error counters | 10 s |
| Traffic throughput | 5 s |
| CPU / Memory | 10 s |
| Temperature | 30 s |
| Configuration state | 60 s |

### Field Ordering

Drag fields within a section to reorder. The order is exactly what appears in the Node View 2-column grid (left-to-right, top-to-bottom).

### Index Configuration (for Tables)

If you add an OID that is part of an SNMP table (e.g. \`ifTable\`):
- The builder automatically detects the table INDEX clause
- Select which index column(s) to show
- Choose a friendly name mapping if the index values map to labels

---

## Step 3 — Preview & Publish

### Preview

The Preview pane shows an exact replica of what the Node View will look like. If the device is live (connected and selected in the preview toolbar), it shows real SNMP values polled on demand.

Preview checks:
- Layout (column widths, label truncation)
- Widget rendering for each data type
- Live refresh counter (shows "Live — refreshing every N s")

### Publishing

When the screen looks correct:
1. Click **Publish**
2. Confirm the publish action — this creates a new **node_view_wireframes** document with \`registryVersion: "ui-builder"\`
3. The screen is immediately live for all devices of this type

> **Re-publishing:** Any time you edit a published descriptor and click Publish again, a new version is created. The Node View for all linked devices updates within seconds (no device restart needed).

---

## Linking Descriptors to Devices

A published MIB Builder descriptor is linked to devices by **sysObjectID prefix** or by explicit assignment:

- **Auto-link:** When a device is polled and its sysObjectID matches the descriptor's registered prefix, the descriptor is automatically applied
- **Manual link:** In Inventory → Device Detail → Edit → set "MIB Builder Descriptor"

---

## Descriptor Versioning

Each Publish action creates a new version. Previous versions are retained and can be restored from the **Descriptor Registry** (\`/v2/descriptors\`).

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Node View shows "No descriptor found" | Device not linked to descriptor | Manually assign in device edit, or verify sysObjectID prefix match |
| Live refresh not working | Section has writable fields | Move writable fields to a separate section |
| OID shows "NOT_POLLED" | OID not reachable | Verify OID exists on device; check with SNMP Walk in Troubleshoot page |
| Parse failed on upload | Non-SMIv2 MIB or syntax error | Validate MIB with an SMIv2 linter; some proprietary MIBs require import dependencies |
`,
  faqs: [
    {
      question: 'Can I include OIDs from multiple MIB files in one screen?',
      answer: 'Yes — upload all required MIB files to the MIB Library first, then build a screen that draws OIDs from multiple uploaded MIBs.',
    },
    {
      question: 'What happens if two descriptors match the same device sysObjectID?',
      answer: 'The most recently published descriptor takes precedence. If you need to override for a specific device, use the manual link in Device Detail → Edit.',
    },
    {
      question: 'Can non-Admin users use the MIB Builder?',
      answer: 'The Custom UI Builder page requires Admin role. Building and publishing screens is an Admin-only operation. The resulting Node View can be seen by all roles that can access Device Detail (Operator, Viewer).',
    },
    {
      question: 'Is there a limit on how many OIDs a descriptor can have?',
      answer: 'There is no hard limit in the application. However, for performance: keep sections under 50 fields, and avoid setting live refresh < 5 s for sections with more than 20 OIDs (this would generate a large SNMP PDU).',
    },
  ],
};
