# 📘 UBR NMS Documentation Playbook — Implementation Prompt

**Target Application:** UBR Open Network Management System (Airtel Telecom FCAPS Platform)
**Updated:** November 2026
**Purpose:** Create comprehensive, maintainable, in-app product documentation with PDF export capability

---

## ⚠️ CODEBASE REALITY — Read Before Implementing

> These facts were verified against the actual repo. The playbook is written to match the real code, not assumptions.

| Fact | Value |
|------|-------|
| All live UI routes | `/v2/*` registered in `frontend/src/v2/V2App.tsx` |
| Docs route to add | `/v2/docs/:slug?` — added to `V2App.tsx`, NOT `App.tsx` |
| Sidebar nav file | `frontend/src/v2/components/layout/V2Sidebar.tsx` — `NAV_GROUPS` array |
| CSS variables | `--vf-*` family (from `v2-theme.css`) — NOT `--bg-primary`, `--accent-primary` |
| Markdown package | `react-markdown` + `remark-gfm` — **NOT installed**, must add |
| Search package | `fuse.js` — **NOT installed**, must add |
| PDF approach | `jsPDF` + `html2canvas` on the frontend — **NOT installed**, must add. WeasyPrint is NOT in the Python report-service. No puppeteer in gateway. |
| Actual page count | 29 V2 pages (see full list in Section 2) |
| API specs exist | 10 of ~28 services have `api-specs/*.yaml` files |
| `scripts/docs/` dir | Does NOT exist — must create |
| Existing CI pattern | `.github/workflows/cicd-ubr-nms-{service}-dev.yaml` |
| `frontend/src/types/` | Exists (has 1 file) — add `docs.ts` here |
| `frontend/src/data/docs/` | Does NOT exist — must create |

---

## 🎯 OBJECTIVE

Build a **live documentation system** for UBR NMS that:
1. **Lives in the codebase** (`frontend/src/data/docs/`) as TypeScript modules
2. **Renders in-app** at `/v2/docs` route with sidebar navigation inside the existing V2 shell
3. **Exports to PDF** using `jsPDF` + `html2canvas` (browser-side, no backend dependency)
4. **Supports full-text search** across all pages using `fuse.js`
5. **Validates automatically** via a CI script on PRs that touch `frontend/src/`
6. **Covers all 29 actual pages** of the application

---

## 📋 APPLICATION PROFILE (Verified)

- **Name:** UBR Open Network Management System (UBR NMS)
- **Domain:** Telecommunications FCAPS (Fault, Config, Accounting, Performance, Security)
- **Users:** Airtel Telecom network operations teams
- **Frontend:** React 19 + TypeScript + Vite (at `frontend/`)
- **Backend:** Polyglot microservices — Node.js (api-gateway), Java (product-definition-service), Python (report-service)
- **Deployment:** Kubernetes + Kafka + MongoDB + Redis

### User Personas
1. **Network Admin** (`role: Admin`) — Full system access, user management, config approval
2. **NOC Operator** (`role: Operator`) — Alarm handling, device monitoring, KPI dashboards
3. **Field Engineer** (`role: Operator`) — Device discovery, onboarding, troubleshooting
4. **Viewer** (`role: Viewer`) — Read-only dashboards and reports
5. **Descriptor Author** (`role: descriptor_author` / `descriptor_admin`) — MIB uploads, Custom UI Builder, Product Definitions

---

## 🗺️ ALL 29 APP PAGES — Documentation Coverage Plan

Every page needs a corresponding doc entry. Mapped to doc slug and persona:

| Page File | Route | Doc Slug | Primary Persona |
|-----------|-------|----------|----------------|
| `V2DashboardPage` | `/v2/dashboard` | `dashboard` | All |
| `V2CustomDashboardPage` | `/v2/dashboards` | `custom-dashboards` | All |
| `V2DevicesPage` | `/v2/devices` | `device-inventory` | Operator, Admin |
| `V2DeviceDetailPage` | `/v2/devices/:id` | `device-detail` | Operator, Admin |
| `V2AlarmsPage` | `/v2/alarms` | `alarm-management` | Operator, Admin |
| `V2TopologyPage` | `/v2/topology` | `topology` | Operator, Admin |
| `V2KpiPage` | `/v2/kpi` | `kpi-monitoring` | Operator, Admin |
| `V2KpiOperationsSummaryPage` | `/v2/kpi/operations` | `kpi-operations` | Admin |
| `V2KpiDrilldownPage` | `/v2/kpi/drilldown` | `kpi-drilldown` | Operator, Admin |
| `V2ConfigPage` | `/v2/config` | `config-management` | Admin, Operator |
| `V2HierarchyPage` | `/v2/hierarchy` | `org-hierarchy` | Admin |
| `V2TroubleshootPage` | `/v2/troubleshoot` | `troubleshoot` | Admin, Operator |
| `V2ReportsPage` | `/v2/reports` | `reports` | All |
| `V2ReleaseValidationPage` | `/v2/release-validation` | `release-validation` | Admin, Operator |
| `V2CompliancePage` | `/v2/compliance` | `compliance` | Admin |
| `V2DiscoveryPage` | `/v2/discovery` | `discovery` | Admin, Operator |
| `V2DiscoveryAuditPage` | `/v2/discovery/audit` | `discovery-audit` | Admin |
| `V2UnifiedOnboardingPage` | `/v2/onboarding` | `onboarding` | Admin, Operator |
| `V2GroupsPage` | `/v2/groups` | `device-groups` | Admin, Operator |
| `V2NotificationsPage` | `/v2/notifications` | `notifications` | Admin |
| `V2AdminPage` | `/v2/admin` | `administration` | Admin |
| `V2ProfilePage` | `/v2/profile` | `user-profile` | All |
| `V2FrameworkOperationsPage` | `/v2/framework` | `framework-ops` | Admin, Operator |
| `V2ProductDefinitionPage` | `/v2/product-definitions` | `product-definitions` | Admin, descriptor_admin |
| `V2DescriptorPage` | `/v2/descriptors` | `descriptor-registry` | descriptor_admin, descriptor_author |
| `V2MibBuilderPage` | `/v2/mib-builder` | `mib-builder` | Admin |
| `V2NodeViewDesignerPage` | `/v2/node-view-designer` | `node-view-designer` | Admin, descriptor_admin |
| `AdaptiveDeviceParameterPanelsPage` | `/v2/devices/:id/framework-parameters` | `node-view` | Admin, Operator |
| `V2SecurityAuditPage` | `/v2/security-audit` | `security-audit` | Admin |

---

## 🏗️ DOCUMENTATION STRUCTURE

### 5 Sections — `DOC_SECTIONS` array

```
GETTING STARTED
  ├── introduction            (What is UBR NMS?)
  ├── quick-start-operator    (NOC Operator quick start)
  ├── quick-start-admin       (Admin quick start)
  └── quick-start-discovery   (Discover your first device)

NETWORK OPERATIONS
  ├── alarm-management        (V2AlarmsPage)
  ├── kpi-monitoring          (V2KpiPage + sub-pages)
  ├── topology                (V2TopologyPage)
  ├── device-inventory        (V2DevicesPage)
  ├── device-detail           (V2DeviceDetailPage + Node View tab)
  ├── node-view               (AdaptiveDeviceParameterPanelsPage — live SNMP parameters)
  ├── device-groups           (V2GroupsPage)
  └── reports                 (V2ReportsPage)

CONFIGURATION & OPERATIONS
  ├── discovery               (V2DiscoveryPage)
  ├── onboarding              (V2UnifiedOnboardingPage)
  ├── config-management       (V2ConfigPage)
  ├── troubleshoot            (V2TroubleshootPage)
  ├── release-validation      (V2ReleaseValidationPage)
  └── compliance              (V2CompliancePage)

FRAMEWORK & ADMINISTRATION
  ├── product-definitions     (V2ProductDefinitionPage — upload XML/JSON)
  ├── descriptor-registry     (V2DescriptorPage — 9-state lifecycle)
  ├── mib-builder             (V2MibBuilderPage — Custom UI Builder)
  ├── node-view-designer      (V2NodeViewDesignerPage)
  ├── framework-ops           (V2FrameworkOperationsPage)
  ├── org-hierarchy           (V2HierarchyPage)
  ├── notifications           (V2NotificationsPage)
  ├── security-audit          (V2SecurityAuditPage)
  ├── administration          (V2AdminPage)
  └── user-profile            (V2ProfilePage)

REFERENCE
  ├── glossary                (BTS, CPE, IDU, FCAPS, MIB, OID, SNMP, etc.)
  ├── api-reference           (auto-generated from api-specs/*.yaml — 10 services)
  ├── architecture            (microservices map, data flows)
  └── release-notes           (version history)
```

---

## 🛠️ IMPLEMENTATION GUIDE

### Step 0: Install Missing Dependencies

```bash
cd frontend

# Markdown renderer
npm install react-markdown remark-gfm

# Full-text search
npm install fuse.js

# PDF export (browser-side, no backend needed)
npm install jspdf html2canvas
npm install --save-dev @types/jspdf
```

Add to `frontend/package.json` scripts:
```json
{
  "scripts": {
    "docs:validate": "node ../scripts/docs/validate-docs.mjs"
  }
}
```

---

### Phase 1: TypeScript Data Structure

#### 1.1 Define Core Interfaces

**File:** `frontend/src/types/docs.ts`

```typescript
// ── Core doc types ────────────────────────────────────────────────────────────

export type DocPersona = 'Admin' | 'Operator' | 'Viewer' | 'descriptor_admin' | 'descriptor_author' | 'All';

export interface DocSection {
  id: string;             // "getting-started"
  title: string;          // "GETTING STARTED"
  icon: string;           // emoji: "📚"
  pages: DocPage[];
  /** If set, only users with one of these roles see this section in the sidebar */
  requiresRole?: DocPersona[];
  defaultCollapsed?: boolean;
}

export interface DocPage {
  slug: string;           // URL segment: "alarm-management"
  title: string;
  description: string;    // 1–2 sentence summary (used in search)
  readTime: number;       // minutes (auto-validated at 250 words/min)
  content: string;        // Full markdown — use template literals
  /** Route in the app this page documents, e.g. "/v2/alarms" */
  appRoute?: string;
  personas?: DocPersona[];
  subpages?: DocPage[];
  faqs?: DocFaqItem[];
  faqTitle?: string;
  lastUpdated: string;    // ISO date: "2026-11-06"  — REQUIRED, used for stale check
  /** Auto-generated pages (e.g. API Reference) — validator skips content length check */
  autoGenerated?: boolean;
}

export interface DocFaqItem {
  question: string;
  answer: string;         // Markdown-formatted
}

// ── Search index entry ────────────────────────────────────────────────────────

export interface DocSearchEntry {
  slug: string;
  title: string;
  description: string;
  sectionTitle: string;
  content: string;        // plain text (markdown stripped) for indexing
}
```

---

#### 1.2 Create Directory Structure

```bash
mkdir -p frontend/src/data/docs/workflows
mkdir -p frontend/src/data/docs/operations
mkdir -p frontend/src/data/docs/framework
mkdir -p frontend/src/data/docs/reference
mkdir -p scripts/docs
```

```
frontend/src/data/docs/
├── index.ts                        ← main export: DOC_SECTIONS[]
├── gettingStarted.ts               ← Section 1
├── workflows/
│   ├── index.ts
│   ├── alarmManagement.ts
│   ├── kpiMonitoring.ts
│   ├── topology.ts
│   ├── deviceInventory.ts
│   ├── deviceDetail.ts
│   ├── nodeView.ts                 ← live SNMP parameter view (Node View tab)
│   ├── deviceGroups.ts
│   └── reports.ts
├── operations/
│   ├── index.ts
│   ├── discovery.ts
│   ├── onboarding.ts
│   ├── configManagement.ts
│   ├── troubleshoot.ts
│   ├── releaseValidation.ts
│   └── compliance.ts
├── framework/
│   ├── index.ts
│   ├── productDefinitions.ts       ← upload XML/JSON, activate, rollback
│   ├── descriptorRegistry.ts       ← 9-state lifecycle, maker-checker
│   ├── mibBuilder.ts               ← Custom UI Builder: 3-step MIB → screen flow
│   ├── nodeViewDesigner.ts
│   ├── frameworkOps.ts
│   ├── orgHierarchy.ts
│   ├── notifications.ts
│   ├── securityAudit.ts
│   ├── administration.ts
│   └── userProfile.ts
└── reference/
    ├── index.ts
    ├── glossary.ts
    ├── apiReference.ts             ← auto-generated from api-specs/*.yaml
    ├── architecture.ts
    └── releaseNotes.ts
```

---

#### 1.3 Main Index Export

**File:** `frontend/src/data/docs/index.ts`

```typescript
import type { DocSection, DocPage, DocSearchEntry } from '../../types/docs.js';
import { GETTING_STARTED_SECTION } from './gettingStarted.js';
import { WORKFLOWS_SECTION } from './workflows/index.js';
import { OPERATIONS_SECTION } from './operations/index.js';
import { FRAMEWORK_SECTION } from './framework/index.js';
import { REFERENCE_SECTION } from './reference/index.js';

export type { DocSection, DocPage, DocSearchEntry };

export const DOC_SECTIONS: DocSection[] = [
  GETTING_STARTED_SECTION,
  WORKFLOWS_SECTION,
  OPERATIONS_SECTION,
  FRAMEWORK_SECTION,
  REFERENCE_SECTION,
];

/** Find a page by slug across all sections (recursive) */
export function findPage(slug: string): DocPage | null {
  for (const section of DOC_SECTIONS) {
    const found = findPageRecursive(section.pages, slug);
    if (found) return found;
  }
  return null;
}

function findPageRecursive(pages: DocPage[], slug: string): DocPage | null {
  for (const page of pages) {
    if (page.slug === slug) return page;
    if (page.subpages) {
      const hit = findPageRecursive(page.subpages, slug);
      if (hit) return hit;
    }
  }
  return null;
}

/** Build a flat search index for Fuse.js */
export function buildSearchIndex(): DocSearchEntry[] {
  const entries: DocSearchEntry[] = [];
  for (const section of DOC_SECTIONS) {
    for (const page of section.pages) {
      collectSearchEntries(entries, page, section.title);
    }
  }
  return entries;
}

function collectSearchEntries(
  entries: DocSearchEntry[],
  page: DocPage,
  sectionTitle: string,
): void {
  entries.push({
    slug: page.slug,
    title: page.title,
    description: page.description,
    sectionTitle,
    // Strip markdown for indexing — simple approach, good enough for Fuse
    content: page.content.replace(/[#*`\[\]()>_~]/g, ' ').replace(/\s+/g, ' ').trim(),
  });
  if (page.subpages) {
    page.subpages.forEach((sp) => collectSearchEntries(entries, sp, sectionTitle));
  }
}
```

---

#### 1.4 UBR-NMS-Specific Content to Write (Priority Order)

Write these files first — they cover the most-used features:

**`gettingStarted.ts`**
```typescript
import type { DocSection } from '../../types/docs.js';

export const GETTING_STARTED_SECTION: DocSection = {
  id: 'getting-started',
  title: 'GETTING STARTED',
  icon: '📚',
  pages: [
    {
      slug: 'introduction',
      title: 'What is UBR NMS?',
      description: 'An overview of the UBR Open Network Management System — a cloud-native FCAPS platform for Airtel telecom infrastructure.',
      readTime: 6,
      appRoute: '/v2/dashboard',
      personas: ['All'],
      lastUpdated: '2026-11-06',
      content: `# What is UBR NMS?

**UBR Open Network Management System** is a cloud-native FCAPS platform for managing
wireless telecommunications infrastructure — BTS (Base Transceiver Stations),
CPE (Customer Premises Equipment), and IDU (Indoor Units) — across Airtel's network circles.

## Core Capabilities

| Capability | What it does |
|------------|-------------|
| **Device Inventory** | Register, monitor, and decommission network devices |
| **Alarm Management** | Real-time SNMP trap ingestion, correlation, and acknowledgment |
| **KPI Monitoring** | SNMP polling → 15-min/hourly/daily rollups with threshold alerting |
| **Config Management** | Template-based push via NETCONF/TR-069/CLI |
| **Network Topology** | Live graph computation + geospatial map |
| **Discovery** | SNMP/ICMP subnet scanning + mTLS device registration |
| **Custom UI Builder** | Build SNMP parameter screens from MIB files without coding |
| **Reports** | Async PDF/XLSX/CSV report generation with scheduling |

## Who uses UBR NMS?

**Rajesh — NOC Operator, Delhi North circle**
Monitors 1,200 BTS devices from the operations centre. When a CRITICAL alarm fires,
he sees it instantly via real-time SSE push, acknowledges it, and dispatches a field team
— all without leaving the Alarms page.
*Outcome: MTTR reduced from 45 minutes to 12 minutes.*

**Priya — Network Admin**
Manages config templates for 3,000+ CPE devices. Updates a TR-069 template,
previews the diff, and pushes to 500 devices in one batch.
*Outcome: Config changes that took 2 days now take 30 minutes.*

**Amit — Field Engineer**
Discovers a new IDU using the Discovery page, scans the subnet, and the device
auto-registers via mTLS. He assigns it to the "Mumbai West" hierarchy and it is
immediately monitored.
*Outcome: Device onboarding from 1 hour to 5 minutes.*

**Dhruv — Descriptor Author**
Uploads the EnGenius SENAO MIB file into the Custom UI Builder, maps 15 OIDs to
display widgets, and publishes a live screen for the Node View. Field engineers
immediately see real-time SNMP values without any backend code change.
*Outcome: New device type onboarded in under 1 hour instead of a 2-week dev sprint.*

## Navigation

The left sidebar organises all features by category:

- **Overview** — Dashboard, My Dashboards
- **Network** — Inventory, Alarms, Topology, KPI, Device Groups
- **Operations** — Config, Troubleshoot, Reports, Discovery, Onboarding
- **Admin** — Org Hierarchy, Notifications, Admin
- **Framework** — Framework Ops, Product Definitions, Descriptor Registry, Node View Designer, Custom UI Builder, Security & Audit
`,
      faqs: [
        {
          question: 'What protocols does UBR NMS support?',
          answer: 'SNMP v1/v2c/v3 for monitoring and trap ingestion, NETCONF and TR-069 for config push, SSH/CLI for legacy devices, and mTLS for device registration.',
        },
        {
          question: 'How many devices can UBR NMS manage?',
          answer: 'The reference architecture handles 10,000+ devices per cluster using Kafka for event streaming and ScyllaDB for time-series KPI storage.',
        },
      ],
    },
    // quick-start-operator, quick-start-admin, quick-start-discovery pages follow same pattern
  ],
};
```

**`workflows/alarmManagement.ts`** — write full alarm lifecycle:
- NEW → ACKNOWLEDGED → CLEARED state machine
- Severity levels: CRITICAL (15 min SLA), MAJOR (1 hr), MINOR (4 hr), WARNING, INFO
- How SSE streams keep the page live (no manual refresh needed)
- How to acknowledge, add notes, clear, suppress
- Alarm correlation: 60-second sliding window, same device+code+severity = deduplicated
- FAQ: "Why do I see the same alarm twice?" / "How do I silence a noisy device?"

**`workflows/nodeView.ts`** — write Node View (live SNMP parameter view):
- How the Node View tab appears on `V2DeviceDetailPage`
- Two modes: Java Product Definition (sidebar nav) vs MIB Builder descriptor (card preview)
- `registryVersion: 'ui-builder'` → Preview layout (uppercase labels, OID below, 2-column grid)
- Live refresh: Monitor groups poll every 5 s via `GET /node-view/:id/monitor-live`
- Configuration groups: Apply (SNMP SET) / Revert buttons
- FAQ: "Why is my device showing 'NOT_POLLED'?" / "What does STALE mean?"

**`framework/mibBuilder.ts`** — write Custom UI Builder (most complex new feature):
- 3-step flow: 1 MIB Library → 2 Build Screen → 3 Preview & Publish
- Stage 1: Upload `.mib` file, MIB parser extracts all OIDs, select the objects to expose
- Stage 2: Drag fields into sections (Configuration / Monitor), assign widgets, set access (read-only vs read-write), set `liveRefreshSeconds` per section (min 2 s, max 300 s — only for all-read-only sections)
- Stage 3: Preview with sample data, publish → creates `node_view_wireframes` document
- Widget types: textfield, dropdown, slider, toggle, gauge, status-badge, data-table
- Published screen immediately appears in Node View for linked devices
- FAQ: "Why can't I set live refresh on a section with writable fields?" / "How do I re-publish after editing?"

**`framework/productDefinitions.ts`** — write Product Definition lifecycle:
- Upload XML or JSON definition file
- Validation against schema
- Stages: Draft → Staged → Active → Superseded
- Rollback: re-activate a previous version
- Linked to devices via `productDefinitionId`
- Difference from MIB Builder: Product Definitions are XML-based Java registry entries; MIB Builder creates UI-only wireframes

**`framework/descriptorRegistry.ts`** — write Descriptor Registry:
- 9-state lifecycle: Draft → Review → Approved → Published → Deprecated → Archived → Superseded → Rejected → Purged
- Maker-checker: author submits, admin approves
- Published descriptors cannot be deleted (only deprecated)
- Each published version creates an ACTIVE wireframe in `node_view_wireframes`

---

### Phase 2: UI Components

#### 2.1 Docs Page Component

**File:** `frontend/src/v2/pages/V2DocsPage.tsx`

> NOTE: This is a V2 page — lives in `frontend/src/v2/pages/`, NOT `frontend/src/pages/`.

```typescript
import React, { useState, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Fuse from 'fuse.js';
import { DOC_SECTIONS, findPage, buildSearchIndex } from '../../data/docs/index.js';
import type { DocPage } from '../../types/docs.js';

// ── Lazy-import jsPDF only when user clicks Export ────────────────────────────
async function exportToPdf(page: DocPage, contentEl: HTMLElement) {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);
  const canvas = await html2canvas(contentEl, { scale: 2, useCORS: true });
  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pdfW = pdf.internal.pageSize.getWidth();
  const pdfH = (canvas.height * pdfW) / canvas.width;
  pdf.addImage(imgData, 'PNG', 0, 0, pdfW, pdfH);
  pdf.save(`UBR-NMS-${page.slug}.pdf`);
}

export default function V2DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [openFaqs, setOpenFaqs] = useState<Set<number>>(new Set());
  const contentRef = React.useRef<HTMLDivElement>(null);

  const activeSlug = slug || 'introduction';
  const page = findPage(activeSlug);

  // Build Fuse.js search index (memoised — only built once)
  const searchIndex = useMemo(() => buildSearchIndex(), []);
  const fuse = useMemo(
    () => new Fuse(searchIndex, { keys: ['title', 'description', 'content'], threshold: 0.35, minMatchCharLength: 2 }),
    [searchIndex],
  );
  const searchResults = useMemo(
    () => (searchQuery.trim().length > 1 ? fuse.search(searchQuery).slice(0, 8) : []),
    [fuse, searchQuery],
  );

  const handleExport = useCallback(async () => {
    if (!page || !contentRef.current) return;
    setExporting(true);
    try { await exportToPdf(page, contentRef.current); }
    catch (e) { console.error('PDF export failed', e); }
    finally { setExporting(false); }
  }, [page]);

  const toggleFaq = (i: number) =>
    setOpenFaqs((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--vf-canvas)' }}>

      {/* ── LEFT SIDEBAR ── */}
      <nav style={{
        width: 240, flexShrink: 0, overflowY: 'auto',
        background: 'var(--vf-surface)', borderRight: '1px solid var(--vf-border-subtle)',
        padding: '12px 0',
      }}>
        {/* Search box */}
        <div style={{ padding: '0 12px 12px' }}>
          <input
            type="search"
            placeholder="Search docs…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 13,
              background: 'var(--vf-input-bg)', border: '1px solid var(--vf-border-default)',
              color: 'var(--vf-text-primary)', outline: 'none',
            }}
          />
          {searchResults.length > 0 && (
            <div style={{
              marginTop: 4, background: 'var(--vf-elevated)', border: '1px solid var(--vf-border-subtle)',
              borderRadius: 6, overflow: 'hidden', boxShadow: 'var(--vf-shadow-md)',
            }}>
              {searchResults.map(({ item }) => (
                <button
                  key={item.slug}
                  onClick={() => { navigate(`/v2/docs/${item.slug}`); setSearchQuery(''); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
                    color: 'var(--vf-text-primary)', borderBottom: '1px solid var(--vf-border-subtle)',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{item.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginTop: 2 }}>{item.sectionTitle}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Section tree */}
        {DOC_SECTIONS.map((section) => (
          <div key={section.id}>
            <div style={{
              padding: '6px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--vf-text-muted)',
            }}>
              {section.icon} {section.title}
            </div>
            {section.pages.map((p) => (
              <button
                key={p.slug}
                onClick={() => navigate(`/v2/docs/${p.slug}`)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 12px 6px 20px', background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 13, color: p.slug === activeSlug ? 'var(--vf-accent)' : 'var(--vf-text-primary)',
                  fontWeight: p.slug === activeSlug ? 600 : 400,
                  borderLeft: p.slug === activeSlug ? '3px solid var(--vf-accent)' : '3px solid transparent',
                }}
              >
                {p.title}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* ── MAIN CONTENT ── */}
      <main style={{ flex: 1, overflowY: 'auto', padding: '32px 48px', maxWidth: 900 }}>
        {!page ? (
          <div style={{ color: 'var(--vf-text-muted)', padding: 40 }}>Page not found.</div>
        ) : (
          <div ref={contentRef}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
              <div>
                <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: 'var(--vf-text-primary)' }}>
                  {page.title}
                </h1>
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--vf-text-muted)', display: 'flex', gap: 16 }}>
                  <span>📖 {page.readTime} min read</span>
                  <span>🕐 Updated {new Date(page.lastUpdated).toLocaleDateString()}</span>
                  {page.appRoute && (
                    <button
                      onClick={() => navigate(page.appRoute!)}
                      style={{ background: 'none', border: 'none', color: 'var(--vf-accent)', cursor: 'pointer', fontSize: 13, padding: 0 }}
                    >
                      → Open in app
                    </button>
                  )}
                </div>
              </div>
              <button
                onClick={() => void handleExport()}
                disabled={exporting}
                style={{
                  background: 'var(--vf-accent)', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                  opacity: exporting ? 0.6 : 1,
                }}
              >
                {exporting ? '⏳ Exporting…' : '📄 Export PDF'}
              </button>
            </div>

            {/* Markdown body */}
            <div style={{ fontSize: 15, lineHeight: 1.75, color: 'var(--vf-text-primary)' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.content}</ReactMarkdown>
            </div>

            {/* FAQ Accordion */}
            {page.faqs && page.faqs.length > 0 && (
              <div style={{ marginTop: 48, borderTop: `2px solid var(--vf-border-subtle)`, paddingTop: 24 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16, color: 'var(--vf-text-primary)' }}>
                  {page.faqTitle ?? 'Frequently Asked Questions'}
                </h2>
                {page.faqs.map((faq, i) => (
                  <div key={i} style={{ borderBottom: `1px solid var(--vf-border-subtle)`, padding: '12px 0' }}>
                    <button
                      onClick={() => toggleFaq(i)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', width: '100%',
                        background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                        fontSize: 15, fontWeight: 600, color: 'var(--vf-text-primary)', padding: 0,
                      }}
                    >
                      {faq.question}
                      <span style={{ marginLeft: 12, flexShrink: 0 }}>{openFaqs.has(i) ? '▲' : '▼'}</span>
                    </button>
                    {openFaqs.has(i) && (
                      <div style={{ marginTop: 10, fontSize: 14, color: 'var(--vf-text-secondary)', lineHeight: 1.65 }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{faq.answer}</ReactMarkdown>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
```

---

#### 2.2 Register the Route in `frontend/src/v2/V2App.tsx`

Add these two lines in the existing pattern — the lazy import near the top and the Route in the `<Routes>` block:

```typescript
// Add near other lazy imports (~line 51):
const V2DocsPage = lazy(() => import('./pages/V2DocsPage'));

// Add inside <Routes> (~line 229, before the catch-all "*" route):
<Route path="docs/:slug?" element={<V2DocsPage />} />
```

---

#### 2.3 Add Navigation Entry in `frontend/src/v2/components/layout/V2Sidebar.tsx`

Add a new group at the **bottom** of the `NAV_GROUPS` array (after the Framework group, before the closing `]`):

```typescript
// Add after the Framework group in NAV_GROUPS array:
{
  label: 'Help',
  items: [
    { path: '/v2/docs', label: 'Documentation', icon: <BookIcon /> },
  ],
},
```

Add the `BookIcon` SVG with the other icon definitions at the bottom of the file:

```typescript
function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
```

---

### Phase 3: PDF Export (Browser-Side — No Backend)

The playbook uses `jsPDF` + `html2canvas` running entirely in the browser.
No Python WeasyPrint, no puppeteer, no backend endpoint needed.

The `exportToPdf` function is already included inline in `V2DocsPage.tsx` above.
It is lazy-imported only when the user clicks "Export PDF" to keep the main bundle small.

**Limitation:** Code blocks with syntax highlighting and complex CSS may not render perfectly.
For production-quality PDFs, a future enhancement could add a `POST /api/v1/docs/export/:slug`
endpoint to the api-gateway using `puppeteer` (Node.js), but that is out of scope for the initial release.

---

### Phase 4: CI Validation Script

#### 4.1 Create Validation Script

**File:** `scripts/docs/validate-docs.mjs`

```javascript
/**
 * UBR NMS Documentation Validator
 * Run via: npm run docs:validate (from /frontend)
 *
 * Checks:
 * 1. All pages have required fields (slug, title, description, readTime, lastUpdated, content)
 * 2. No broken internal /v2/docs/ links
 * 3. Read time accuracy (±2 min at 250 words/min)
 * 4. No pages stale for > 90 days
 * 5. Coverage: every APP_PAGES entry has a matching doc slug
 */

// NOTE: This script uses Node.js ES modules (--input-type=module or .mjs extension)
// It imports the compiled JS from the frontend build, not TS directly.
// Run `npm run build` in /frontend before running this script in CI.

const ERRORS = [];
const WARNINGS = [];
const WORDS_PER_MIN = 250;
const STALE_DAYS = 90;

// All 29 app page routes that must have documentation
const APP_ROUTES_REQUIRING_DOCS = [
  'dashboard', 'custom-dashboards', 'device-inventory', 'device-detail',
  'alarm-management', 'kpi-monitoring', 'kpi-operations', 'kpi-drilldown',
  'topology', 'config-management', 'org-hierarchy', 'troubleshoot', 'reports',
  'release-validation', 'compliance', 'discovery', 'discovery-audit',
  'onboarding', 'device-groups', 'notifications', 'administration', 'user-profile',
  'framework-ops', 'product-definitions', 'descriptor-registry', 'mib-builder',
  'node-view-designer', 'node-view', 'security-audit',
];

// Dynamic import of compiled docs
const { DOC_SECTIONS } = await import('../../frontend/dist/assets/index.js')
  .catch(() => {
    console.error('❌ Run `npm run build` in /frontend first.');
    process.exit(1);
  });

const allPages = collectAllPages(DOC_SECTIONS);
const allSlugs = new Set(allPages.map((p) => p.slug));

// 1. Required fields
for (const { page, sectionId } of allPages) {
  if (!page.slug)        ERRORS.push(`Section "${sectionId}": page missing slug`);
  if (!page.title)       ERRORS.push(`Page "${page.slug}": missing title`);
  if (!page.description) ERRORS.push(`Page "${page.slug}": missing description`);
  if (!page.readTime)    ERRORS.push(`Page "${page.slug}": missing readTime`);
  if (!page.lastUpdated) ERRORS.push(`Page "${page.slug}": missing lastUpdated`);
  if (!page.autoGenerated && (!page.content || page.content.length < 100))
    ERRORS.push(`Page "${page.slug}": content too short (${page.content?.length ?? 0} chars)`);
}

// 2. Broken internal links
for (const { page } of allPages) {
  const linkRegex = /\[([^\]]+)\]\(\/v2\/docs\/([^)]+)\)/g;
  let m;
  while ((m = linkRegex.exec(page.content)) !== null) {
    if (!allSlugs.has(m[2]))
      ERRORS.push(`Page "${page.slug}": broken link → /v2/docs/${m[2]}`);
  }
}

// 3. Read time accuracy
for (const { page } of allPages) {
  if (page.autoGenerated) continue;
  const wordCount = page.content.split(/\s+/).length;
  const estimated = Math.ceil(wordCount / WORDS_PER_MIN);
  if (Math.abs(estimated - page.readTime) > 2)
    WARNINGS.push(`Page "${page.slug}": readTime ${page.readTime} min but content is ~${estimated} min`);
}

// 4. Stale check
const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
for (const { page } of allPages) {
  if (page.lastUpdated && new Date(page.lastUpdated).getTime() < cutoff)
    WARNINGS.push(`Page "${page.slug}": not updated in ${STALE_DAYS}+ days (${page.lastUpdated})`);
}

// 5. Coverage
for (const requiredSlug of APP_ROUTES_REQUIRING_DOCS) {
  if (!allSlugs.has(requiredSlug))
    ERRORS.push(`Missing doc page for app route: "${requiredSlug}"`);
}

// Report
const totalPages = allPages.length;
const coveredCount = APP_ROUTES_REQUIRING_DOCS.filter((s) => allSlugs.has(s)).length;
const coveragePct = Math.round((coveredCount / APP_ROUTES_REQUIRING_DOCS.length) * 100);

console.log('\n📚 UBR NMS Documentation Validation\n');
console.log(`  Sections : ${DOC_SECTIONS.length}`);
console.log(`  Pages    : ${totalPages}`);
console.log(`  Coverage : ${coveredCount}/${APP_ROUTES_REQUIRING_DOCS.length} required pages (${coveragePct}%)`);

if (ERRORS.length)   { console.log(`\n❌ ${ERRORS.length} error(s):`);   ERRORS.forEach((e) => console.log(`   • ${e}`)); }
if (WARNINGS.length) { console.log(`\n⚠️  ${WARNINGS.length} warning(s):`); WARNINGS.forEach((w) => console.log(`   • ${w}`)); }

if (!ERRORS.length && !WARNINGS.length) console.log('\n✅ All checks passed!\n');

process.exit(ERRORS.length > 0 ? 1 : 0);

// ── helpers ───────────────────────────────────────────────────────────────────
function collectAllPages(sections) {
  const result = [];
  for (const section of sections) {
    for (const page of section.pages) {
      result.push({ page, sectionId: section.id });
      if (page.subpages) page.subpages.forEach((sp) => result.push({ page: sp, sectionId: section.id }));
    }
  }
  return result;
}
```

---

#### 4.2 Auto-Generate API Reference from OpenAPI Specs

**File:** `scripts/docs/sync-api-reference.mjs`

> **Note:** Only 10 of ~28 services have specs in `api-specs/`. The generated doc will state clearly that the remaining services are not yet spec'd.

```javascript
/**
 * Auto-generates api-reference doc page from api-specs/*.yaml
 * Run manually or in CI when api-specs/ files change.
 * Output: frontend/src/data/docs/reference/apiReference.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';
import yaml from 'js-yaml';

const SPEC_FILES = globSync('api-specs/*.yaml').filter((f) => !f.includes('components'));
const OUTPUT = 'frontend/src/data/docs/reference/apiReference.ts';

let markdown = `# API Reference

REST API documentation auto-generated from OpenAPI 3.0 specs in \`api-specs/\`.

> **Dev base URL:** \`http://localhost:3100/api/v1\`
> **Auth:** All requests require \`Authorization: Bearer <JWT>\` obtained from \`POST /auth/login\`

> ⚠️ **Coverage note:** ${SPEC_FILES.length} of ~28 UBR NMS services have published OpenAPI specs.
> Services without specs (api-gateway, event-collector, kpi-collector, product-definition-service, etc.)
> are documented in the [Architecture](/v2/docs/architecture) page.

---

`;

for (const specPath of SPEC_FILES) {
  const spec = yaml.load(readFileSync(specPath, 'utf8'));
  const name = spec.info?.title ?? specPath;
  markdown += `## ${name}\n\n${spec.info?.description ?? ''}\n\n`;
  markdown += `| Method | Path | Description |\n|--------|------|-------------|\n`;
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (op && typeof op === 'object' && op.summary) {
        markdown += `| **${method.toUpperCase()}** | \`${path}\` | ${op.summary} |\n`;
      }
    }
  }
  markdown += `\n---\n\n`;
}

const ts = `/**
 * AUTO-GENERATED — DO NOT EDIT
 * Source: api-specs/*.yaml
 * Run: node scripts/docs/sync-api-reference.mjs
 * Last generated: ${new Date().toISOString()}
 */
import type { DocPage } from '../../../types/docs.js';

export const API_REFERENCE_PAGE: DocPage = {
  slug: 'api-reference',
  title: 'API Reference',
  description: 'REST API documentation for UBR NMS microservices, auto-generated from OpenAPI specs.',
  readTime: 20,
  lastUpdated: '${new Date().toISOString().split('T')[0]}',
  autoGenerated: true,
  content: \`${markdown.replace(/`/g, '\\`')}\`,
};
`;

writeFileSync(OUTPUT, ts);
console.log(`✅ API Reference written to ${OUTPUT} (${SPEC_FILES.length} specs)`);
```

---

#### 4.3 Add GitHub Actions Workflow

**File:** `.github/workflows/docs-validation.yml`

> Follows the existing workflow naming convention in this repo.

```yaml
name: Documentation Validation

on:
  pull_request:
    paths:
      - 'frontend/src/**'
      - 'api-specs/**'
      - 'scripts/docs/**'
  push:
    branches: [main]

jobs:
  validate-docs:
    name: Validate Documentation
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json

      - name: Install frontend dependencies
        run: npm ci
        working-directory: frontend

      - name: Build frontend (needed for doc imports)
        run: npm run build
        working-directory: frontend

      - name: Validate documentation
        run: node scripts/docs/validate-docs.mjs

  sync-api-reference:
    name: Sync API Reference
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install js-yaml
        run: npm install js-yaml glob

      - name: Generate API Reference from OpenAPI specs
        run: node scripts/docs/sync-api-reference.mjs

      - name: Commit if changed
        run: |
          git config user.name "UBR Docs Bot"
          git config user.email "docs-bot@ubrnms.local"
          git add frontend/src/data/docs/reference/apiReference.ts
          git diff --cached --quiet || git commit -m "docs: auto-sync API Reference [skip ci]"
          git push
```

---

## 📐 CSS GUIDELINES

> **Critical:** Use `--vf-*` CSS variables only. These are defined in `frontend/src/v2/styles/v2-theme.css`.
> Do NOT use `--bg-primary`, `--accent-primary`, or any other variable family.

| Purpose | Correct variable |
|---------|----------------|
| Page background | `var(--vf-canvas)` |
| Card/surface | `var(--vf-surface)` |
| Elevated (dropdowns) | `var(--vf-elevated)` |
| Primary text | `var(--vf-text-primary)` |
| Secondary text | `var(--vf-text-secondary)` |
| Muted/hint text | `var(--vf-text-muted)` |
| Accent / links | `var(--vf-accent)` |
| Borders | `var(--vf-border-subtle)` / `var(--vf-border-default)` |
| Input background | `var(--vf-input-bg)` |
| Monospace font | `var(--vf-font-mono)` |

---

## ✅ SUCCESS CRITERIA

| Criterion | Target |
|-----------|--------|
| Required page coverage | 29/29 (100%) |
| Broken internal links | 0 |
| Stale pages (>90 days) | 0 at launch |
| Read time accuracy | Within ±2 min |
| CI validation | Passes on every PR |
| PDF export | Works for all pages |
| Search returns results | Within 150 ms |
| Mobile layout | Readable on 375 px width |

---

## 🔄 MAINTENANCE

### Weekly
- [ ] Check CI for stale doc warnings
- [ ] Update `lastUpdated` on any page whose feature changed

### On every PR that modifies a feature page
- [ ] Corresponding doc page updated or `lastUpdated` bumped
- [ ] `npm run docs:validate` passes locally

### When `api-specs/*.yaml` changes
- [ ] Run `node scripts/docs/sync-api-reference.mjs` (or let CI do it)

### When a new V2 page is added
1. Add the page file to the 29-page coverage list in `validate-docs.mjs`
2. Create a new doc page TypeScript file
3. Add the slug to the appropriate section in `index.ts`

---

## 🚀 IMPLEMENTATION ORDER (8 Weeks)

| Week | Deliverable |
|------|-------------|
| 1 | Install deps · create `types/docs.ts` · create directory structure · write `index.ts` · write `gettingStarted.ts` with Introduction + 2 Quick Starts |
| 2 | Add `/v2/docs` route to `V2App.tsx` · add sidebar nav entry · build `V2DocsPage.tsx` with sidebar, search, markdown renderer |
| 3 | Write 8 Network Operations doc pages (alarms, KPI, topology, devices, node-view, etc.) |
| 4 | Write 6 Operations doc pages (discovery, onboarding, config, troubleshoot, compliance, etc.) |
| 5 | Write 10 Framework & Admin doc pages (MIB Builder, product definitions, descriptor registry, security audit, etc.) |
| 6 | Write 4 Reference pages · run `sync-api-reference.mjs` · add CI workflow |
| 7 | PDF export testing · search quality tuning · mobile layout · accessibility pass |
| 8 | Deploy · user testing with 3 NOC operators · fix feedback |

**Estimated effort:** 1 developer, 6–8 weeks
