NMS · Documentation Playbook
How the in-app documentation system is built, structured, deployed, and maintained

v1.0 · 2026-11-06

---

Contents

1. Codebase facts (read before implementing)
2. Objective
3. Application profile and personas
4. Page inventory
5. Documentation structure
6. Implementation — Phase 1 · Data layer
7. Implementation — Phase 2 · UI
8. Implementation — Phase 3 · PDF export
9. Implementation — Phase 4 · CI validation
10. CSS guidelines
11. Maintenance
12. Success criteria

---

## 1. Codebase Facts

Verify these before writing a single line. All were confirmed against the running repo.

| Fact | Value |
|------|-------|
| All live UI routes | `/v2/*` registered in `frontend/src/v2/V2App.tsx` |
| Docs route | `/v2/docs/:slug?` — added to `V2App.tsx`; not `App.tsx` |
| Sidebar nav file | `frontend/src/v2/components/layout/V2Sidebar.tsx` — `NAV_GROUPS` array |
| CSS variable family | `--vf-*` from `v2-theme.css`; never `--bg-primary`, `--accent-primary` |
| Markdown package | `react-markdown` + `remark-gfm` — must `npm install` first |
| Search package | `fuse.js` — must `npm install` first |
| PDF package | `jspdf` + `html2canvas` — browser-side, no backend; must `npm install` first |
| Page count | 29 V2 pages (see Section 4) |
| API specs present | 10 of ~28 services have `api-specs/*.yaml` |
| `scripts/docs/` | Does not exist — create it |
| Existing CI pattern | `.github/workflows/cicd-nms-{service}-dev.yaml` |
| `frontend/src/types/` | Exists — add `docs.ts` here |
| `frontend/src/data/docs/` | Does not exist — create it |
| Product name in UI | **NMS** — not "UBR NMS", not "UBR Open NMS" |

---

## 2. Objective

Build a live, in-app documentation system that:

- Renders at `/v2/docs` inside the existing V2 shell with its own collapsible sidebar
- Covers all 29 application pages with structured content written for the target personas
- Supports full-text search across all pages (Fuse.js, < 150 ms)
- Exports a single page or the entire playbook as a downloadable PDF (browser-side)
- Auto-validates on every PR that touches `frontend/src/` or `api-specs/`
- Auto-syncs the API reference from `api-specs/*.yaml` on push to `main`

---

## 3. Application Profile and Personas

**Product:** NMS — Airtel Telecom FCAPS Platform  
**Domain:** Telecommunications (Fault, Configuration, Accounting, Performance, Security)  
**Frontend:** React 19 · TypeScript · Vite  
**Backend:** Node.js (api-gateway), Java (product-definition-service), Python (report-service)

### Personas

| Persona | Role | Primary use |
|---------|------|-------------|
| Network Admin | `role: Admin` | Full system access, user management, config approval |
| NOC Operator | `role: Operator` | Alarm handling, device monitoring, KPI dashboards |
| Field Engineer | `role: Operator` | Discovery, onboarding, troubleshooting |
| Viewer | `role: Viewer` | Read-only dashboards and reports |
| Descriptor Author | `role: descriptor_author` / `descriptor_admin` | MIB uploads, Custom UI Builder, Product Definitions |

---

## 4. Page Inventory

Every page below requires a documentation entry. Slug is the URL segment under `/v2/docs/`.

| Page file | Route | Doc slug | Primary persona |
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

## 5. Documentation Structure

Five sections. Every page slug in Section 4 must appear in one of them.

```
GETTING STARTED
  introduction · quick-start-operator · quick-start-admin · quick-start-discovery

NETWORK OPERATIONS
  alarm-management · kpi-monitoring · kpi-operations · kpi-drilldown
  topology · device-inventory · device-detail · node-view · device-groups · reports

CONFIGURATION & OPERATIONS
  discovery · discovery-audit · onboarding · config-management
  troubleshoot · release-validation · compliance

FRAMEWORK & ADMINISTRATION
  product-definitions · descriptor-registry · mib-builder · node-view-designer
  framework-ops · org-hierarchy · notifications · security-audit
  administration · user-profile

REFERENCE
  glossary · api-reference · architecture · release-notes
```

---

## 6. Implementation · Phase 1 — Data Layer

### Step 1 · Install dependencies

```bash
cd frontend
npm install react-markdown remark-gfm fuse.js jspdf html2canvas
```

Add to `frontend/package.json` scripts:

```json
"docs:validate": "node ../scripts/docs/validate-docs.mjs"
```

### Step 2 · Type definitions

**File:** `frontend/src/types/docs.ts`

```typescript
export type DocPersona =
  | 'Admin' | 'Operator' | 'Viewer'
  | 'descriptor_admin' | 'descriptor_author' | 'All';

export interface DocSection {
  id: string;           // "getting-started"
  title: string;        // "GETTING STARTED"
  icon: string;         // emoji
  pages: DocPage[];
}

export interface DocPage {
  slug: string;         // URL segment
  title: string;
  description: string;  // 1–2 sentence summary; shown in search results
  readTime: number;     // minutes at 250 words/min
  content: string;      // full Markdown
  appRoute?: string;    // "/v2/alarms"
  personas?: DocPersona[];
  subpages?: DocPage[];
  faqs?: DocFaqItem[];
  faqTitle?: string;
  lastUpdated: string;  // ISO date "2026-11-06" — required; used for stale check
  autoGenerated?: boolean;
}

export interface DocFaqItem {
  question: string;
  answer: string;       // Markdown
}

export interface DocSearchEntry {
  slug: string;
  title: string;
  description: string;
  sectionTitle: string;
  content: string;      // plain text, markdown stripped
}
```

### Step 3 · Directory structure

```bash
mkdir -p frontend/src/data/docs/workflows
mkdir -p frontend/src/data/docs/operations
mkdir -p frontend/src/data/docs/framework
mkdir -p frontend/src/data/docs/reference
mkdir -p scripts/docs
```

```
frontend/src/data/docs/
├── index.ts                    ← DOC_SECTIONS[], findPage(), buildSearchIndex()
├── gettingStarted.ts
├── workflows/
│   ├── index.ts                ← WORKFLOWS_SECTION
│   ├── alarmManagement.ts
│   ├── kpiMonitoring.ts
│   ├── topology.ts
│   ├── deviceInventory.ts
│   ├── nodeView.ts
│   ├── deviceGroups.ts
│   └── reports.ts
├── operations/
│   ├── index.ts                ← OPERATIONS_SECTION
│   ├── discovery.ts
│   ├── onboarding.ts
│   ├── configManagement.ts
│   ├── troubleshoot.ts
│   ├── releaseValidation.ts
│   └── compliance.ts
├── framework/
│   ├── index.ts                ← FRAMEWORK_SECTION
│   ├── productDefinitions.ts
│   ├── descriptorRegistry.ts
│   ├── mibBuilder.ts
│   ├── nodeViewDesigner.ts
│   ├── frameworkOps.ts
│   ├── orgHierarchy.ts
│   ├── notifications.ts
│   ├── securityAudit.ts
│   ├── administration.ts
│   └── userProfile.ts
└── reference/
    ├── index.ts                ← REFERENCE_SECTION
    ├── glossary.ts
    ├── apiReference.ts         ← auto-generated from api-specs/
    ├── architecture.ts
    └── releaseNotes.ts
```

### Step 4 · Main index

**File:** `frontend/src/data/docs/index.ts`

```typescript
import type { DocSection, DocPage, DocSearchEntry } from '../../types/docs';
// ... import each section

export const DOC_SECTIONS: DocSection[] = [
  GETTING_STARTED_SECTION,
  WORKFLOWS_SECTION,
  OPERATIONS_SECTION,
  FRAMEWORK_SECTION,
  REFERENCE_SECTION,
];

export function findPage(slug: string): DocPage | null { /* recursive */ }
export function buildSearchIndex(): DocSearchEntry[] { /* strips markdown */ }
```

### Step 5 · Content requirements per page

Each `DocPage` object must include:

| Field | Requirement |
|-------|-------------|
| `slug` | Matches the slug in Section 4 exactly |
| `title` | Matches the page name in the app |
| `description` | One sentence; used in search results and as the page callout |
| `content` | Minimum 300 words; use Markdown headings, tables, code blocks |
| `lastUpdated` | ISO date of the most recent content edit |
| `faqs` | At least 2 for pages with complex workflows (MIB Builder, Node View, etc.) |
| `appRoute` | The `/v2/...` path this page documents; enables the "Open in app" link |

### Step 6 · NMS-specific content priorities

Write these first — they cover features with the highest support volume.

**`mib-builder`** — Custom UI Builder

Include:
- 3-step flow: MIB Library → Build Screen → Preview & Publish
- Widget type table (textfield, number, gauge, status-badge, dropdown, toggle, data-table)
- `liveRefreshSeconds` rule: only available when all fields in a section are read-only; min 2 s, max 300 s
- How to re-publish after editing (creates new version; Node View updates immediately)
- Troubleshooting: NOT_POLLED, STALE, descriptor not linked

**`node-view`** — Live SNMP Parameters

Include:
- Two render modes: MIB Builder descriptor (`registryVersion: "ui-builder"`) vs Java Product Definition
- Live refresh: Monitor sections poll via `GET /api/v1/node-view/:deviceId/monitor-live`
- Apply (SNMP SET) / Revert buttons for read-write sections
- Status values: STALE, NOT_POLLED, Error

**`alarm-management`**

Include:
- Severity table: CRITICAL (15 min SLA), MAJOR (1 hr), MINOR (4 hr), WARNING, INFO
- State machine: NEW → ACKNOWLEDGED → CLEARED
- 60-second deduplication window
- SSE push (no manual refresh needed)

**`product-definitions`**

Include:
- Difference from MIB Builder: Product Definitions are XML/JSON Java registry entries; MIB Builder creates UI-only wireframes
- MIB Upload tab: auto-generates XML from uploaded `.mib` file
- Lifecycle: Draft → Staged → Active → Superseded; rollback by re-activating

**`descriptor-registry`**

Include:
- 9-state lifecycle: Draft → InReview → Approved → Published → Deprecated → Archived → Superseded → Rejected → Purged
- Maker-checker: author submits, different user approves
- Delete guard: published descriptors must be deprecated before they can be archived

---

## 7. Implementation · Phase 2 — UI

### Step 1 · Register the route

**File:** `frontend/src/v2/V2App.tsx`

```typescript
// Near other lazy imports:
const V2DocsPage = lazy(() => import('./pages/V2DocsPage'));

// Inside <Routes>, before the "*" catch-all:
<Route path="docs/:slug?" element={<V2DocsPage />} />
```

### Step 2 · Add sidebar entry

**File:** `frontend/src/v2/components/layout/V2Sidebar.tsx`

Add at the bottom of `NAV_GROUPS`:

```typescript
{
  label: 'Help',
  items: [
    { path: '/v2/docs', label: 'Documentation', icon: <BookIcon /> },
  ],
},
```

Add `BookIcon` SVG with the other icon functions:

```typescript
function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
```

### Step 3 · Page component

**File:** `frontend/src/v2/pages/V2DocsPage.tsx`

Minimum requirements:

| Feature | Implementation |
|---------|---------------|
| Collapsible sidebar | Collapses to 48 px icon-only strip; state in `useState` |
| Section tree | Groups from `DOC_SECTIONS`; collapsible per section |
| Active highlight | Left border `3px solid var(--vf-accent)` on active slug |
| Search box | Fuse.js, threshold 0.35, keys: title × 0.5, description × 0.3, content × 0.2 |
| Search results | Dropdown, max 8 results, closes on outside click |
| Markdown renderer | `ReactMarkdown` with `remark-gfm`; custom renderers for all block types |
| Read time | Auto-computed at 250 words/min from stripped markdown |
| "Open in app" link | `NavLink` to `page.appRoute` when set |
| FAQ accordion | Renders `page.faqs`; expand/collapse with chevron rotation |
| Prev / Next | Flat list of all pages in section order; buttons at bottom of content |
| Export this page | `jsPDF` + `html2canvas` on content `<div>`; lazy-imported |
| Export full playbook | Renders all pages off-screen, paginates into one PDF; progress overlay |
| CSS | Only `--vf-*` variables; no hardcoded colour literals |

Markdown component renderers — required variable usage:

| Element | Background | Text |
|---------|-----------|------|
| `<pre>` / `<code>` block | `var(--vf-code-bg)` | `var(--vf-text-primary)` |
| Inline `<code>` | `var(--vf-code-bg)` | `var(--vf-code-text)` |
| `<th>` | `var(--vf-th-bg)` | `var(--vf-text-muted)` |
| `<td>` | — | `var(--vf-text-primary)` |
| `<blockquote>` | `var(--vf-blockquote-bg)` | `var(--vf-text-secondary)` |
| Hover states | `var(--vf-hover)` or `var(--vf-hover-accent)` | — |

---

## 8. Implementation · Phase 3 — PDF Export

### Single-page export

Triggered by "This Page" button. Captures the content `<div>` with `html2canvas { scale: 2, backgroundColor: '#ffffff' }`. Paginates across A4 pages in `jsPDF`. Saves as `NMS-{slug}.pdf`.

### Full playbook export

Triggered by "Export Full Playbook" button.

Steps:
1. Collect all pages from `DOC_SECTIONS` in order.
2. Create a hidden off-screen `<div>` (width: 794 px, position: fixed, left: −9999 px).
3. For each page: inject HTML via `innerHTML` using a lightweight markdown-to-HTML converter; capture with `html2canvas { scale: 1.5 }`; add to `jsPDF`.
4. Prepend a cover page (branding, page count, generation date) and a table of contents.
5. Show a progress overlay with an animated progress bar ("Rendering page N of total").
6. Download as `NMS-Documentation-Playbook.pdf`.

The markdown-to-HTML converter must handle: fenced code blocks, h1–h4, blockquotes, bold, inline code, tables, unordered and ordered lists, horizontal rules, paragraphs.

Both buttons are disabled while any export is in progress.

---

## 9. Implementation · Phase 4 — CI Validation

### Validation script

**File:** `scripts/docs/validate-docs.mjs`

Runs via: `node scripts/docs/validate-docs.mjs` (from repo root) or `npm run docs:validate` (from `frontend/`).

Checks:

| Check | Failure condition |
|-------|-----------------|
| Required fields | Any page missing `slug`, `title`, `lastUpdated`, or `content` (< 100 chars) |
| Broken internal links | Any `[text](/v2/docs/slug)` where `slug` is not in the page list |
| Stale pages | `lastUpdated` more than 90 days ago |
| Coverage | Any slug from the 34-slug required list is absent |

Exits `1` on any error; exits `0` on warnings only.

Required slugs (34 total):

```
introduction, quick-start-operator, quick-start-admin, quick-start-discovery,
alarm-management, kpi-monitoring, kpi-operations, kpi-drilldown, topology,
device-inventory, device-detail, node-view, device-groups, reports,
discovery, discovery-audit, onboarding, config-management,
troubleshoot, release-validation, compliance,
product-definitions, descriptor-registry, mib-builder, node-view-designer,
framework-ops, org-hierarchy, notifications, security-audit,
administration, user-profile,
glossary, api-reference, architecture, release-notes
```

Implementation note: The script must work without a compiled build — use regex extraction of `slug:`, `title:`, `lastUpdated:`, and `content:` fields from TypeScript source files directly.

### API reference sync

**File:** `scripts/docs/sync-api-reference.mjs`

Reads all `api-specs/*.yaml` files (excluding `components.yaml`). Parses paths and HTTP methods with a minimal YAML reader (no external dependencies). Rewrites the `content` field of the `api-reference` page in `frontend/src/data/docs/reference/index.ts`.

Coverage note to include in the generated content: 10 of ~28 services have published specs. Services without specs are covered in the Architecture page.

### GitHub Actions workflow

**File:** `.github/workflows/docs-validation.yml`

```yaml
on:
  pull_request:
    paths: ['frontend/src/**', 'api-specs/**', 'scripts/docs/**']
  push:
    branches: [main]

jobs:
  validate-docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: frontend/package-lock.json }
      - run: npm ci
        working-directory: frontend
      - run: node scripts/docs/validate-docs.mjs

  sync-api-reference:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
        with: { token: '${{ secrets.GITHUB_TOKEN }}' }
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node scripts/docs/sync-api-reference.mjs
      - run: |
          git config user.name "NMS Docs Bot"
          git config user.email "docs-bot@nms.local"
          git add frontend/src/data/docs/reference/index.ts
          git diff --cached --quiet || git commit -m "docs: sync API reference [skip ci]" && git push
```

---

## 10. CSS Guidelines

Use only `--vf-*` variables. These are defined in `frontend/src/v2/styles/v2-theme.css` for both dark (default) and light (`html[data-theme="light"]`) themes.

### Variable reference

| Purpose | Variable | Dark value | Light value |
|---------|----------|-----------|------------|
| Page background | `--vf-canvas` | `#07111f` | `#f5f6fa` |
| Card / surface | `--vf-surface` | `#0d1b2a` | `#ffffff` |
| Elevated (dropdowns) | `--vf-elevated` | `#112240` | `#ffffff` |
| Primary text | `--vf-text-primary` | `#ffffff` | `#0a0f1e` |
| Secondary text | `--vf-text-secondary` | `#cbd5e1` | `#1e293b` |
| Muted / hint | `--vf-text-muted` | `#94a3b8` | `#475569` |
| Accent | `--vf-accent` | `#4d9eff` | `#4f46e5` |
| Borders | `--vf-border-subtle` / `--vf-border-default` | — | — |
| Input background | `--vf-input-bg` | `#0f1e30` | `#f9fafb` |
| Hover background | `--vf-hover` | `rgba(255,255,255,0.07)` | `rgba(79,70,229,0.06)` |
| Accent hover | `--vf-hover-accent` | `rgba(77,158,255,0.12)` | `rgba(79,70,229,0.10)` |
| Code block background | `--vf-code-bg` | `rgba(0,0,0,0.30)` | `#f1f5f9` |
| Inline code text | `--vf-code-text` | `#93c5fd` | `#4f46e5` |
| Table header background | `--vf-th-bg` | `rgba(255,255,255,0.05)` | `#f8f9ff` |
| Blockquote background | `--vf-blockquote-bg` | `rgba(255,165,0,0.07)` | `#fffbeb` |
| Warning colour | `--vf-warning` | `#f59e0b` | `#d97706` |

### Prohibited patterns

Do not use any of the following in `V2DocsPage.tsx` or any doc-related component:

- Hardcoded hex colours (`#1e1e2e`, `#ffffff`, `#111827`, etc.)
- `rgba(0,0,0,X)` or `rgba(255,255,255,X)` as background values
- Variables not in the `--vf-*` family
- Fallback values that differ between themes (e.g. `var(--vf-X, #darkcolor)`)

---

## 11. Maintenance

### On every PR that modifies a feature page

- Update the corresponding doc page content.
- Bump `lastUpdated` to today.
- Run `npm run docs:validate` locally before pushing.

### When `api-specs/*.yaml` changes

Run `node scripts/docs/sync-api-reference.mjs` (or let the CI job on `main` do it automatically).

### When a new V2 page is added

1. Add its slug to the required-slugs list in `scripts/docs/validate-docs.mjs`.
2. Create a new `DocPage` object in the appropriate section file.
3. Add the slug to `DOC_SECTIONS` in `index.ts`.
4. CI will fail on the next PR if the slug is missing — this is intentional.

### Stale page process

When CI reports a stale page (> 90 days since `lastUpdated`):
1. Review the page content against the current state of the feature.
2. Update content where the feature has changed.
3. Bump `lastUpdated`.
4. If the feature has not changed, bump `lastUpdated` only (adds no content).

---

## 12. Success Criteria

| Criterion | Target |
|-----------|--------|
| Required slug coverage | 34/34 (100%) |
| Broken internal links | 0 |
| Stale pages at launch | 0 |
| CI validation | Passes on every PR |
| Single-page PDF export | Works on all 34 pages |
| Full playbook PDF export | Produces one downloadable file from all 34 pages |
| Search response time | < 150 ms |
| Light-mode consistency | All elements use `--vf-*` variables; no hardcoded colours |
| Product name | "NMS" throughout — no "UBR NMS", "UBR Open NMS", or "UBR Open Network Management System" |
