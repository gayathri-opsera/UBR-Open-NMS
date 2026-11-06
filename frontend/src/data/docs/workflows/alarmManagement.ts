import type { DocPage } from '../../../types/docs';

export const ALARM_MANAGEMENT_PAGE: DocPage = {
  slug: 'alarm-management',
  title: 'Alarm Management',
  description:
    'Monitor, acknowledge, and clear network alarms in real-time. Understand severity levels, SLAs, and the alarm state machine.',
  readTime: 7,
  appRoute: '/v2/alarms',
  personas: ['Operator', 'Admin'],
  lastUpdated: '2026-11-06',
  content: `# Alarm Management

The Alarms page (\`/v2/alarms\`) provides a real-time feed of all active network events. The page updates automatically via **Server-Sent Events (SSE)** — no manual refresh needed.

## Alarm Severity Levels

| Severity | Colour | Typical SLA | Examples |
|----------|--------|-------------|---------|
| **CRITICAL** | 🔴 Red | 15 minutes | Link down, device unreachable, power failure |
| **MAJOR** | 🟠 Orange | 1 hour | High error rate, temperature warning |
| **MINOR** | 🟡 Yellow | 4 hours | Intermittent connectivity, low signal |
| **WARNING** | 🔵 Blue | Informational | Threshold approaching |
| **INFO** | ⚪ Grey | Informational | Config change, device reboot |

## Alarm State Machine

\`\`\`
NEW ──► ACKNOWLEDGED ──► CLEARED
 │                          ▲
 └──────────────────────────┘ (auto-clear when SNMP condition resolves)
\`\`\`

| State | Meaning |
|-------|---------|
| **NEW** | Alarm fired, no one has acknowledged it |
| **ACKNOWLEDGED** | NOC operator has seen it and is working on it |
| **CLEARED** | Condition resolved (automatically or manually) |

## Alarm Correlation

UBR NMS uses a **60-second sliding window** to deduplicate noisy alarms. If the same device fires the same alarm code with the same severity within 60 seconds, only one entry is created. The \`eventCount\` field shows how many raw events were merged.

## Working with Alarms

### Acknowledge an Alarm
1. Click the alarm row to expand it
2. Click **Acknowledge**
3. Optionally add a note (e.g. "Dispatched field team, ETA 30 min")
4. The alarm turns from red to amber in the list

### Add Notes
Click the speech bubble icon on any alarm to add a timestamped note. Notes are visible to all operators and are included in alarm export.

### Clear an Alarm Manually
If the condition is resolved but the SNMP clear trap was not received:
1. Expand the alarm
2. Click **Clear**
3. Add a reason note

### Suppress a Device
To prevent a device from generating alarms during maintenance:
1. Go to **Inventory** → find the device → **Device Detail**
2. Click **Maintenance Mode** (top right)
3. Set the duration (up to 24 hours)
4. All NEW alarms from this device are suppressed and labelled MAINTENANCE

## Filtering and Search

Use the filter bar above the table to filter by:
- **Severity** — multi-select
- **State** — NEW / ACKNOWLEDGED / CLEARED
- **Device Group** — filter by hierarchy node
- **Alarm Code** — search by SNMP trap OID or friendly name
- **Time Range** — last 1h / 6h / 24h / 7d / custom

## Export

Click **Export** (top right) to download the filtered alarm list as CSV. For scheduled alarm reports, use the **Reports** page (\`/v2/reports\`).
`,
  faqs: [
    {
      question: 'Why do I see the same alarm appear twice?',
      answer:
        'If the 60-second deduplication window has passed and the condition fires again, a new alarm is created. This can happen with intermittent link flaps. Use the **Suppress** feature if a device is known to be unstable during maintenance.',
    },
    {
      question: 'Why did an alarm disappear without me clearing it?',
      answer:
        'UBR NMS auto-clears alarms when it receives the corresponding SNMP clear trap from the device. This is normal SNMP trap-pair behaviour (e.g. linkDown / linkUp).',
    },
    {
      question: 'How do I get notified of CRITICAL alarms by email or SMS?',
      answer:
        'Go to **Notifications** (\`/v2/notifications\`) and configure a notification rule. You can send emails, SMS, or webhook callbacks when alarm severity meets a threshold.',
    },
    {
      question: 'What is the maximum number of alarms stored?',
      answer:
        'Active alarms are stored indefinitely. Cleared alarms are retained for 90 days by default (configurable by Admin). Historical alarm events are archived to cold storage after 90 days.',
    },
  ],
};
