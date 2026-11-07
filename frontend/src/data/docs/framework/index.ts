import type { DocSection } from '../../../types/docs';
import { MIB_BUILDER_PAGE } from './mibBuilder';

export const FRAMEWORK_SECTION: DocSection = {
  id: 'framework-admin',
  title: 'FRAMEWORK & ADMINISTRATION',
  icon: '🔧',
  pages: [
    {
      slug: 'product-definitions',
      title: 'Product Definitions',
      description:
        'Upload XML/JSON device definition files, validate them, activate for production use, and manage the version lifecycle including rollback.',
      readTime: 8,
      appRoute: '/v2/product-definitions',
      personas: ['Admin', 'descriptor_admin'],
      lastUpdated: '2026-11-06',
      content: `# Product Definitions

Product Definitions (\`/v2/product-definitions\`) define how NMS understands a device type — what OIDs to poll, how to map values, what KPI metrics to compute, and what config templates apply.

> **Role required:** Admin, descriptor_admin, or descriptor_author

## Difference from MIB Builder

| | Product Definition | MIB Builder Descriptor |
|--|-------------------|----------------------|
| **Format** | XML or JSON file | UI-designed screen |
| **Who creates it** | Java dev team or descriptor_admin | Admin using the MIB Builder UI |
| **What it controls** | Full SNMP polling + KPI + config | Node View UI only |
| **Stored as** | Java registry + MongoDB | \`node_view_wireframes\` MongoDB collection |

## Uploading a Product Definition

1. Go to **Product Definitions** (\`/v2/product-definitions\`)
2. Click **Upload**
3. Select your XML or JSON definition file
4. Click **Validate** — the system checks:
   - Schema compliance
   - OID format validity
   - Required sections present (identity, polling, kpi)
   - No conflicting sysObjectID with existing active definitions
5. If validation passes, click **Save as Draft**

### MIB Upload Tab

The Product Definition page also has a **MIB Upload** tab that lets you:
1. Upload a raw \`.mib\` file
2. Auto-generate a draft Product Definition XML from the parsed MIB
3. Review and customise the generated XML
4. Submit through the standard Product Definition workflow

This is an accelerated path for new device types when you have the MIB file but no existing XML definition.

## Product Definition Lifecycle

\`\`\`
Draft → Staged → Active → Superseded
         ↑
     (rollback re-activates)
\`\`\`

| State | Meaning |
|-------|---------|
| **Draft** | Uploaded, not yet in use |
| **Staged** | In canary testing on selected devices |
| **Active** | Live — applies to all matching devices |
| **Superseded** | Replaced by a newer version; retained for rollback |

## Activating a Definition

After staging and validating:
1. Select the definition
2. Click **Activate**
3. Confirm — the previous Active version moves to Superseded

## Rollback

If a new Product Definition causes issues:
1. Find the previous Superseded version
2. Click **Re-activate**
3. Devices switch back to the previous definition immediately
`,
      faqs: [
        {
          question: 'What is the difference between a Product Definition and a Descriptor?',
          answer:
            'A Product Definition (XML/JSON) defines the full device behaviour — polling schedule, KPI computation, alarm mapping, config templates. A Descriptor (from MIB Builder) defines only the Node View UI — what parameters to show and how. Both can coexist for the same device type.',
        },
      ],
    },

    {
      slug: 'descriptor-registry',
      title: 'Descriptor Registry',
      description:
        'Manage the lifecycle of all MIB Builder descriptors — 9-state lifecycle, maker-checker approval, version history, and delete guard.',
      readTime: 6,
      appRoute: '/v2/descriptors',
      personas: ['Admin', 'descriptor_admin', 'descriptor_author'],
      lastUpdated: '2026-11-06',
      content: `# Descriptor Registry

The Descriptor Registry (\`/v2/descriptors\`) manages all MIB Builder descriptors through a strict 9-state lifecycle with maker-checker approval.

## 9-State Lifecycle

\`\`\`
Draft → InReview → Approved → Published → Deprecated → Archived
   ↑        ↓          ↓
   └── Rejected    Superseded → Purged
\`\`\`

| State | Description |
|-------|-------------|
| **Draft** | Being built in the MIB Builder; not visible to end users |
| **InReview** | Submitted for approval; locked for editing |
| **Approved** | Approved by admin; ready to publish |
| **Published** | Live — visible in Node View for linked devices |
| **Deprecated** | Still functional, but marked as end-of-life |
| **Archived** | No longer applied to new devices; retained for history |
| **Superseded** | A newer version has been published; this version is inactive |
| **Rejected** | Approval was denied; returned to author with comments |
| **Purged** | Soft-deleted; not recoverable via UI (admin DB op only) |

## Maker-Checker

1. **Author** (descriptor_author role) builds the descriptor and clicks **Submit for Review**
2. **Reviewer** (descriptor_admin or Admin) sees it in the InReview queue
3. Reviewer can Approve (→ Approved) or Reject with comments (→ Rejected → returned to Draft)
4. After approval, the author (or admin) clicks **Publish** to make it live

## Delete Guard

Published descriptors **cannot be hard-deleted**. They must be Deprecated first, then Archived. This ensures audit history is preserved and existing Node Views continue to function during the transition.

## Version History

Click any descriptor → **Version History** to see all previous versions with:
- State at each version
- Who published it
- When it was published
- What changed (diff of field list)

Click **Restore** on any version to bring it back to Approved state for re-publishing.
`,
    },

    MIB_BUILDER_PAGE,

    {
      slug: 'node-view-designer',
      title: 'Node View Designer',
      description:
        'Design Node View sections and labels before uploading a MIB — plan your screen structure, index levels, and display layout upfront.',
      readTime: 5,
      appRoute: '/v2/node-view-designer',
      personas: ['Admin', 'descriptor_admin'],
      lastUpdated: '2026-11-06',
      content: `# Node View Designer

The Node View Designer (\`/v2/node-view-designer\`) is a **pre-MIB planning tool** that lets you design the structure of a Node View screen before you have a MIB file.

> **Role required:** Admin or descriptor_admin

## When to Use This

Use the Node View Designer when:
- You are planning a new device type integration and want to agree on the screen structure with stakeholders before the MIB is available
- You want to design the display labels and section grouping independently of the OID mapping
- You need to spec out index levels and table display before parsing

## Design Canvas

The Designer shows a drag-and-drop canvas with:
- **Section blocks** — add, name, and reorder sections
- **Field placeholders** — add fields with display name, intended widget type, and expected access mode
- **Index configuration** — specify how table indices should be displayed

## Exporting the Design

Once the screen design is agreed:
1. Click **Export Design**
2. Download a JSON spec file
3. Upload this file when creating a new descriptor in the MIB Builder — it pre-populates the section structure

## Design Templates

The Designer includes built-in templates for common device types:
- **Wireless AP** — Radio, Interface, Management, Monitor sections
- **CPE** — WAN, LAN, Wireless, VoIP, System sections
- **BTS** — Cell, Carrier, TRX, Backhaul sections
`,
    },

    {
      slug: 'framework-ops',
      title: 'Framework Operations',
      description:
        'Monitor multi-vendor adapter health, view live adapter status, analyse guided failures, and manage framework component versions.',
      readTime: 6,
      appRoute: '/v2/framework',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Framework Operations

The Framework Operations page (\`/v2/framework\`) provides a centralised health dashboard for all device adapters, polling workers, and framework components.

## Adapter Health

Each device type (product definition) has a corresponding **adapter** that handles SNMP polling, trap processing, and config push. The adapter health panel shows:

| Metric | Description |
|--------|-------------|
| Status | 🟢 Healthy / 🟡 Degraded / 🔴 Down |
| Poll Success Rate | % of SNMP polls that succeeded in the last hour |
| Avg Response Time | Mean SNMP response time in ms |
| Error Rate | % of polls returning an error |
| Active Devices | Number of devices using this adapter |

## Component Status

Shows the health of internal framework components:
- **SNMP Worker Pool** — thread pool utilisation and queue depth
- **Trap Listener** — trap ingestion rate and backlog
- **Config Push Worker** — active config jobs and failure count
- **KPI Aggregator** — rollup latency and backlog depth

## Guided Failure Analysis

When a device adapter shows Degraded or Down status, click **Analyse** to get a guided root-cause walkthrough:
1. Checks network connectivity to affected devices
2. Checks SNMP credential validity
3. Checks adapter version compatibility
4. Suggests remediation steps

## Adapter Version Management

Displays the current version of each adapter and whether a newer version is available. Click **Update Adapter** to deploy the latest version (requires Admin role; triggers a rolling update with no downtime).
`,
    },

    {
      slug: 'org-hierarchy',
      title: 'Org / Hierarchy',
      description: 'Manage the organisational hierarchy — circles, clusters, and sites — that devices are assigned to.',
      readTime: 4,
      appRoute: '/v2/hierarchy',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Org / Hierarchy

The Org Hierarchy page (\`/v2/hierarchy\`) manages the tree structure used to organise devices geographically and organisationally.

## Hierarchy Structure

\`\`\`
Root
└── Circle (e.g. "Delhi North")
    └── Cluster (e.g. "Central Delhi")
        └── Site (e.g. "Connaught Place BTS")
            └── Devices
\`\`\`

You can have up to 6 levels. The structure matches your operational org chart.

## Creating Nodes

1. Click the **+** icon next to a node to add a child
2. Enter: Name, Code (short identifier), Type, Coordinates (optional for map view)
3. Click **Save**

## Assigning Devices

Drag a device (from the Devices panel on the right) onto a hierarchy node. Or use **Inventory → Bulk Assign** to assign many devices at once.

## RBAC and Hierarchy

Assign users to specific hierarchy nodes in **Admin → Users**. A user assigned to "Delhi North" can only see devices under that node. Admin users see the full hierarchy.

## Export

Click **Export** to download the full hierarchy as a JSON tree or CSV (flat list with node path).
`,
    },

    {
      slug: 'notifications',
      title: 'Notifications',
      description: 'Configure alert rules for email, SMS, and webhook delivery when alarms or threshold events occur.',
      readTime: 4,
      appRoute: '/v2/notifications',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Notifications

The Notifications page (\`/v2/notifications\`) lets Admins configure automated alerts delivered via email, SMS, or webhook when specific alarm or threshold conditions are met.

## Notification Rules

A notification rule consists of:
- **Trigger** — alarm severity (CRITICAL/MAJOR), device group, hierarchy node, specific alarm code
- **Channel** — Email / SMS / Webhook / Slack (via webhook)
- **Recipients** — email addresses, phone numbers, or webhook URL
- **Cooldown** — minimum time between notifications for the same trigger (prevents spam)

## Creating a Rule

1. Click **New Rule**
2. Set the trigger condition
3. Select channel
4. Add recipients
5. Set cooldown (default: 5 minutes)
6. Click **Save and Enable**

## Email Notifications

Emails include: device name, alarm severity, alarm code, description, and a direct link to the alarm in NMS.

Configure your SMTP server in **Admin → System Settings → Email**.

## Webhook

Send a JSON payload to any HTTP endpoint:
\`\`\`json
{
  "event": "alarm.fired",
  "severity": "CRITICAL",
  "device": "BTS-DL-001",
  "ip": "10.1.5.100",
  "alarmCode": "linkDown",
  "timestamp": "2026-11-06T14:00:00Z",
  "url": "https://nms.ubr.in/v2/alarms?id=alarm-123"
}
\`\`\`

## Testing a Rule

Click **Test** on any rule to send a sample notification immediately (without waiting for a real alarm).
`,
    },

    {
      slug: 'security-audit',
      title: 'Security & Audit',
      description: 'Manage zero-trust security controls, RBAC role mapping, credential vault, and view the full system audit log.',
      readTime: 6,
      appRoute: '/v2/security-audit',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Security & Audit

The Security & Audit page (\`/v2/security-audit\`) is the control centre for NMS security settings.

## Zero-Trust Controls

| Control | Setting |
|---------|---------|
| **Session Timeout** | Idle session expiry (default: 30 minutes) |
| **MFA Requirement** | Enforce TOTP for all Admin users |
| **IP Allowlist** | Restrict login to specific IP ranges |
| **Certificate Pinning** | Require client certificates for API access |
| **Audit Retention** | How long audit logs are retained (default: 365 days) |

## Credential Vault

The credential vault stores SNMP community strings and v3 credentials encrypted at rest (AES-256). Credentials are referenced by **profile name** in device config and never exposed in plaintext in the UI.

### Adding a Credential
1. Click **Add Credential**
2. Select type: SNMPv2c (community string) or SNMPv3 (USM)
3. Fill in the profile name and credentials
4. Click **Save**

Credentials can be tested against a device IP directly from the vault (runs a sysDescr SNMP GET).

## RBAC Role Mapping

| Role | Permissions |
|------|------------|
| **Admin** | Full system access |
| **Operator** | Monitor, acknowledge alarms, push config, run diagnostics |
| **Viewer** | Read-only: dashboards, inventory, alarms, KPIs |
| **descriptor_admin** | Approve and publish descriptors + product definitions |
| **descriptor_author** | Create and submit descriptors for review |

## System Audit Log

Every user action in NMS is logged with:
- Timestamp (UTC)
- User (username + role)
- Action (login, alarm acknowledge, config push, descriptor publish, etc.)
- Target (device name, descriptor name, etc.)
- IP address
- Result (success / failure + error code)

Filter the audit log by user, action type, date range, or target. Export as CSV for external SIEM ingestion.
`,
    },

    {
      slug: 'administration',
      title: 'Administration',
      description: 'Manage users, roles, system settings, integrations, and perform system-wide admin tasks.',
      readTime: 5,
      appRoute: '/v2/admin',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Administration

The Administration page (\`/v2/admin\`) is accessible only to Admin users and provides system-wide configuration.

## User Management

| Task | How |
|------|-----|
| Add user | Admin → Users → Add User |
| Set role | Select user → Edit → Role |
| Restrict to hierarchy | Select user → Edit → Hierarchy Access |
| Reset password | Select user → Reset Password (sends email) |
| Disable user | Select user → Disable (retains audit history) |

## System Settings

Configure global system behaviour:
- **SNMP Polling Defaults** — default community, timeout, retries
- **Alarm Retention** — how long cleared alarms are kept
- **KPI Retention** — raw data, 15-min, hourly, daily rollup retention
- **Report Storage** — where generated reports are stored
- **Email** — SMTP server for notifications
- **API Keys** — generate API keys for external integrations

## Integrations

Configure third-party integrations:
- **LDAP / Active Directory** — user authentication delegation
- **Syslog** — forward all NMS audit events to your enterprise syslog
- **SNMP Trap Forwarding** — re-forward raw traps to a secondary NMS
- **ServiceNow / Jira** — auto-create incidents from CRITICAL alarms

## System Health

Admin → System Health shows:
- Service status (all microservices with uptime and last restart time)
- Database connection pool status
- Kafka consumer lag
- Redis cache hit rate
`,
    },

    {
      slug: 'user-profile',
      title: 'User Profile',
      description: 'Manage your personal account settings — password, MFA, theme, language, and notification preferences.',
      readTime: 3,
      appRoute: '/v2/profile',
      personas: ['All'],
      lastUpdated: '2026-11-06',
      content: `# User Profile

The Profile page (\`/v2/profile\`) lets you manage your personal account settings.

## Available Settings

| Setting | Description |
|---------|-------------|
| **Display Name** | Your name as shown in the UI and audit log |
| **Email** | Used for password reset and report delivery |
| **Password** | Change your password (current password required) |
| **MFA** | Set up TOTP (Google Authenticator compatible) |
| **Theme** | Light / Dark / System |
| **Language** | Interface language (English only in current release) |
| **Timezone** | Timestamps in the UI are shown in your selected timezone |

## Setting Up MFA

1. Go to Profile → Security → Enable MFA
2. Scan the QR code with your authenticator app
3. Enter the 6-digit code to confirm
4. Save your backup codes in a secure location

## Notification Preferences

Set which alarm severity levels send you a personal notification (in-app toast + optional email). This is separate from the system-wide notification rules configured by Admin.
`,
    },
  ],
};
