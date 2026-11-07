import type { DocSection } from '../../../types/docs';

export const OPERATIONS_SECTION: DocSection = {
  id: 'configuration-operations',
  title: 'CONFIGURATION & OPERATIONS',
  icon: '⚙️',
  pages: [
    {
      slug: 'discovery',
      title: 'Discovery',
      description: 'Scan subnets to find new devices, run SNMP/ICMP probes, and onboard discovered devices into inventory.',
      readTime: 6,
      appRoute: '/v2/discovery',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Discovery

The Discovery page (\`/v2/discovery\`) scans your network for devices that can be managed by NMS.

## Scan Methods

### SNMP Scan
Sends SNMP GET for \`sysDescr\` (OID \`1.3.6.1.2.1.1.1.0\`) to every IP in the target subnet. Devices that respond are catalogued with their system description, OID prefix, and response time.

### ICMP Ping Scan
Faster than SNMP — pings each IP and records round-trip time. Useful for initial reachability mapping before SNMP is configured.

### Combined Scan (recommended)
Runs ICMP first (fast), then SNMP on responsive hosts only.

## Running a Scan

1. Click **New Scan**
2. Enter: **Subnet CIDR** (e.g. \`10.1.5.0/24\`), **SNMP Credential Profile**, **Scan Method**
3. Optionally set: **Timeout** (1–10 s per host), **Concurrency** (10–200 parallel probes)
4. Click **Start Scan**

Scans run asynchronously. The progress bar shows hosts scanned / total. Large subnets (/16) may take several minutes.

## Scan Results

| Column | Description |
|--------|-------------|
| IP | Host IP |
| Hostname | Resolved DNS name (if available) |
| SNMP Status | ✅ Responding / ❌ No response |
| sysDescr | Device system description from SNMP |
| Response Time | SNMP round-trip in ms |
| Already Managed | ⚠️ if this IP is already in inventory |

## Onboarding from Scan Results

1. Select the devices you want to add (checkboxes)
2. Click **Onboard Selected**
3. Optionally assign to a device group and hierarchy node in the confirmation dialog
4. Devices are added to Inventory with status **NEW**

## Discovery Audit

Go to **Discovery → Audit** to see a full history of all scans: who ran them, subnets covered, devices found, and devices onboarded.
`,
      faqs: [
        {
          question: 'The scan returned no results even though devices are reachable — why?',
          answer: 'Check that (1) the SNMP credential profile is correct for those devices, (2) the NMS server\'s IP is in the SNMP allowed-hosts list on the device (community ACL), and (3) UDP port 161 is not blocked by a firewall between NMS and the target subnet.',
        },
      ],
    },
    {
      slug: 'discovery-audit',
      title: 'Discovery Audit',
      description: 'Review the complete history of discovery scans — who ran them, subnets covered, and devices found vs onboarded.',
      readTime: 3,
      appRoute: '/v2/discovery',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Discovery Audit

The Discovery Audit log provides a full history of all network scans for compliance and troubleshooting.

## What Is Logged

| Field | Example |
|-------|---------|
| Scan ID | \`disc-2026-11-06-001\` |
| Operator | \`rajesh.kumar\` |
| Subnet | \`10.1.5.0/24\` |
| Start / End | 2026-11-06 14:00 UTC / 14:03 UTC |
| Hosts Scanned | 254 |
| Responding | 42 |
| SNMP Responding | 38 |
| Onboarded | 12 |
| Credential Profile | \`snmpv3-prod\` |

## Export

Click **Export CSV** to download the audit log. Useful for change management reviews and compliance audits.
`,
    },
    {
      slug: 'onboarding',
      title: 'Onboarding',
      description: 'Review and approve devices pending onboarding, including mTLS auto-registered devices and devices awaiting hierarchy assignment.',
      readTime: 4,
      appRoute: '/v2/onboarding',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Onboarding

The Onboarding page (\`/v2/onboarding\`) is a unified queue for all devices that need an admin action before they enter active monitoring.

## Onboarding Queue

Devices appear in this queue when their status is:
- **PENDING_APPROVAL** — mTLS auto-registered; needs admin approval
- **NEW** — discovered/added manually but not yet assigned to a hierarchy node
- **MISSING_CREDENTIALS** — added but no valid SNMP credential profile

## Approving a Device

1. Click the device row
2. Review the auto-detected: IP, sysDescr, certificate (for mTLS), and detected product definition
3. Set: Hierarchy Node, Device Group, Name, SNMP Credential (if not set)
4. Click **Approve** — device moves to inventory with status **UP** (after first poll succeeds)

## Bulk Approval

Select multiple devices with matching properties → **Bulk Approve** → set shared settings (group, hierarchy) → confirm.

## Rejecting a Device

If a device should not be managed (e.g. rogue device), click **Reject**. The device is flagged and its certificate (if mTLS) is added to a blocklist. It will not be able to re-register automatically.
`,
    },
    {
      slug: 'config-management',
      title: 'Configuration Management',
      description: 'Create config templates, preview rendered configs, push to device groups, and track config change history.',
      readTime: 7,
      appRoute: '/v2/config',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Configuration Management

The Config page (\`/v2/config\`) lets you manage device configurations at scale using templates.

## Config Protocols Supported

| Protocol | Used for |
|----------|---------|
| **NETCONF** | Modern Cisco, Juniper, Nokia devices |
| **TR-069 / CWMP** | CPE (home/business routers, IDUs) |
| **SSH/CLI** | Legacy devices without NETCONF |
| **SNMP SET** | Simple OID-based config (also available via Node View) |

## Config Templates

Templates use **Jinja2** syntax with device variables interpolated at push time.

Example TR-069 template snippet:
\`\`\`jinja2
Device.ManagementServer.URL = {{ cwmp_acs_url }}
Device.ManagementServer.Username = {{ device.serial }}
Device.ManagementServer.PeriodicInformInterval = {{ inform_interval | default(300) }}
\`\`\`

### Creating a Template
1. Go to **Config → Templates**
2. Click **New Template**
3. Select protocol and device type
4. Write the template body
5. Set variables with default values
6. Click **Validate** — the system checks syntax and required variable coverage
7. **Save** the template

## Pushing a Config

1. Go to **Config → Push**
2. Select a template
3. Preview rendered config (with device variable substitution shown)
4. Select target devices (up to 500 at a time)
5. Click **Push Now** or **Schedule Push**

Pushes run asynchronously. Track progress in the **Config Jobs** table.

## Config Jobs

Each push creates a **Config Job** with:
- Status: QUEUED → IN_PROGRESS → COMPLETED / FAILED / PARTIAL
- Per-device result (success / error message)
- Diff: before/after config for each device (where protocol supports read-back)

## Config History

Every successful push is logged in **Config History** with the operator name, timestamp, template, and resulting config. Click any history entry to see the full diff.

## Rollback

Select a historical config entry → click **Re-push** to restore a device to a previous config state.
`,
    },
    {
      slug: 'troubleshoot',
      title: 'Troubleshoot',
      description: 'Run on-demand SNMP walks, pings, traceroutes, and diagnostics against any device without leaving the browser.',
      readTime: 5,
      appRoute: '/v2/troubleshoot',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Troubleshoot

The Troubleshoot page (\`/v2/troubleshoot\`) gives NOC operators live diagnostic tools without requiring SSH access to the device.

## Available Tools

### ICMP Ping
Sends N pings from the NMS server to the target device. Shows min/avg/max RTT and packet loss percentage.

### SNMP Walk
Walks any OID subtree and displays the result as a table with OID, type, and value. Useful for verifying SNMP connectivity and exploring device MIBs.

### SNMP GET
Fetches the value of a specific OID. Enter the full OID (e.g. \`1.3.6.1.2.1.1.1.0\`) or the MIB name (\`sysDescr.0\`).

### Traceroute
Shows the network path from the NMS server to the device. Useful for diagnosing routing issues.

### Port Probe
TCP connect to a specified port. Checks if NETCONF (830), SSH (22), TR-069 (7547), or any custom port is reachable.

## Running a Diagnostic

1. Select a **Device** from the dropdown (or type the IP directly)
2. Select the **Tool**
3. Set any tool-specific parameters
4. Click **Run**

Results appear in a scrollable terminal-style output panel. All diagnostic runs are logged in the Audit trail.

## Bulk Ping

Select multiple devices → **Bulk Ping** to test reachability across a device group quickly. Results show as a colour-coded status table.
`,
    },
    {
      slug: 'release-validation',
      title: 'Release Validation',
      description: 'Validate firmware and software releases before deploying to production — run automated checks, compare configs, and approve releases.',
      readTime: 5,
      appRoute: '/v2/release-validation',
      personas: ['Admin', 'Operator'],
      lastUpdated: '2026-11-06',
      content: `# Release Validation

The Release Validation page (\`/v2/release-validation\`) manages the firmware/software release lifecycle from staging to production approval.

## Release Workflow

\`\`\`
Upload Release → Validate → Stage (canary) → Monitor → Approve → Full Rollout
\`\`\`

## Uploading a Release

1. Click **New Release**
2. Upload the firmware binary or software package
3. Set: Device Model(s), Release Version, Release Notes URL
4. Click **Upload**

## Automated Validation Checks

After upload, the system automatically runs:
- **Hash verification** — SHA-256 checksum match
- **Signature check** — vendor signature validation (if configured)
- **Compatibility matrix** — checks the release supports the targeted hardware versions
- **Regression tests** — if test suites are configured, runs SNMP OID comparison before/after on a lab device

## Canary Deployment

Before full rollout, deploy to a small canary group:
1. Click **Stage to Canary** → select the canary device group
2. Monitor for 24–72 hours — KPI charts and alarm rates are auto-compared with baseline
3. If healthy: click **Approve for Production**
4. If issues found: click **Rollback Canary**

## Approving a Release

Releases require dual approval (maker-checker):
1. Author submits for approval
2. A second Admin user reviews and approves
3. Only then is the release eligible for full production rollout
`,
    },
    {
      slug: 'compliance',
      title: 'Compliance',
      description: 'Run automated compliance checks against network policy rules. View pass/fail results, download compliance reports, and track remediation.',
      readTime: 5,
      appRoute: '/v2/compliance',
      personas: ['Admin'],
      lastUpdated: '2026-11-06',
      content: `# Compliance

The Compliance page (\`/v2/compliance\`) runs automated policy checks across your device fleet and shows pass/fail results.

## Policy Types

| Policy | Checks |
|--------|--------|
| **Security Baseline** | SNMP v3 enforced, default community strings not in use, firmware version not in CVE list |
| **Config Compliance** | Required config parameters present (e.g. NTP server, syslog destination) |
| **Availability SLA** | Device uptime % meets defined SLA threshold |
| **Firmware Currency** | Device firmware is within N versions of the latest approved release |
| **Certificate Validity** | mTLS certificates not expired or expiring within 30 days |

## Running a Compliance Check

1. Click **Run Check**
2. Select policy set(s) and device group
3. Click **Start**

Checks run asynchronously. Results appear in the **Results** table.

## Results Table

| Column | Meaning |
|--------|---------|
| Device | Device name and IP |
| Policy | Which policy this row covers |
| Status | ✅ PASS / ❌ FAIL / ⚠️ WARNING |
| Details | Specific finding (e.g. "SNMP v2c community 'public' in use") |
| Last Checked | Timestamp |

## Remediation

For failed checks, click **Remediate** to open a guided fix:
- **Config fixes** — generates a config template to push the corrective setting
- **Credential fixes** — links to the Admin credential management page
- **Firmware fixes** — links to Release Validation

## Compliance Report

Click **Export Report** to download a PDF compliance summary. This report is suitable for regulatory audits (SOC2, TRAI requirements).
`,
    },
  ],
};
