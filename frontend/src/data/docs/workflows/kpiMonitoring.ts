import type { DocPage } from '../../../types/docs';

export const KPI_MONITORING_PAGE: DocPage = {
  slug: 'kpi-monitoring',
  title: 'KPI Monitoring',
  description: 'Monitor network performance KPIs in real-time and historically. Understand polling intervals, rollup tiers, threshold alerting, and the KPI drilldown.',
  readTime: 7,
  appRoute: '/v2/kpi',
  personas: ['Admin', 'Operator'],
  lastUpdated: '2026-11-06',
  content: `# KPI Monitoring

The KPI page (\`/v2/kpi\`) provides aggregated performance metrics across your device fleet with time-range selection, group filtering, and threshold alerting.

## Polling and Rollup Tiers

NMS collects SNMP metrics on a 4-tier schedule:

| Tier | Frequency | Used for |
|------|-----------|---------|
| **Real-time** | 2–5 seconds | Live Node View parameters (read-only sections) |
| **Near-real-time** | 5–10 seconds | Monitor tab on Node View |
| **Short-term** | 5 minutes | Link stats, error rates |
| **Standard** | 30–60 seconds | General OID polling |

Collected data is rolled up at:
- **15-minute** averages for intra-day charts
- **Hourly** averages for 7-day views
- **Daily** averages for 30+ day trend views

Rollups are computed by the \`kpi-aggregation\` service automatically.

## KPI Dashboard

The main KPI page shows fleet-wide summaries:
- **Top N** devices by CPU/memory/error rate
- **Heatmap** — all devices, colour-coded by health score
- **Trend chart** — selected metric over selected time range

### Selecting Metrics
Use the **Metric** dropdown to switch between available KPIs. The list is dynamic — it shows only metrics that have data for the current device group selection.

### Time Range
Choose from: Last 1h / 6h / 24h / 7d / 30d / Custom. Custom lets you pick an exact start/end date.

## KPI Operations Summary

Go to **KPI → Operations Summary** (\`/v2/kpi/operations\`) for a daily at-a-glance view:
- Circle-wise uptime percentage
- Alarm volume by severity
- Top 10 most-alarmed devices
- Mean Time to Acknowledge (MTTA) and Mean Time to Repair (MTTR)

This page auto-refreshes every 5 minutes.

## KPI Drilldown

Click any device in a KPI chart or table to open the **KPI Drilldown** (\`/v2/kpi/drilldown\`). This shows:
- All available metrics for the selected device
- Overlay comparison with peer devices in the same group
- Annotation markers where alarms occurred during the time window
- Download raw data as CSV

## Threshold Alerting

Thresholds are configured per metric per device group. When a metric exceeds the threshold, a KPI alert is raised (visible in the Alarms page as severity MINOR/WARNING depending on how far over the threshold the value is).

Configure thresholds: **Config** → **KPI Thresholds** (Admin only).
`,
  faqs: [
    {
      question: 'Why is there a gap in my KPI chart?',
      answer: 'A gap means the device was not responding to SNMP polls during that period. Check the Alarms tab for a DOWN alarm around the same time window.',
    },
    {
      question: 'How far back can I see historical KPIs?',
      answer: 'Raw 5-minute data is retained for 30 days. Hourly rollups for 1 year. Daily rollups indefinitely. Use the Custom time range to access older data.',
    },
    {
      question: 'Can I export KPI data to Excel?',
      answer: 'Yes — from the KPI Drilldown page, click **Download CSV**. For scheduled reports, go to the Reports page and create a KPI report template.',
    },
  ],
};
