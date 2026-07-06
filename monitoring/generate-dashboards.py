#!/usr/bin/env python3
"""
Generate Grafana dashboard JSON files for UBR NMS monitoring.
Dashboards: executive-overview, noc-operations, platform-health,
            kafka-monitoring, database-monitoring, slo-compliance.
"""
import json
import pathlib
import uuid

OUT = pathlib.Path(__file__).parent / "dashboards"
OUT.mkdir(exist_ok=True)

SERVICES = [
    "auth-service", "alarm-service", "inventory-service",
    "kpi-aggregation-service", "kpi-query-service", "diagnostics-service",
    "report-service", "config-management-service", "topology-service",
    "notification-service", "audit-service", "event-collector",
    "kpi-collector", "discovery-service", "api-gateway",
]


def uid():
    return uuid.uuid4().hex[:9]


def panel(pid: int, title: str, panel_type: str, x: int, y: int, w: int, h: int,
          targets: list, field_config: dict = None, options: dict = None) -> dict:
    p = {
        "id": pid,
        "title": title,
        "type": panel_type,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": field_config or {"defaults": {}, "overrides": []},
        "options": options or {},
    }
    return p


def target(expr: str, legend: str = "", ref: str = "A") -> dict:
    return {
        "expr": expr,
        "legendFormat": legend or expr[:30],
        "refId": ref,
    }


def stat_panel(pid, title, expr, x, y, w=4, h=4, unit="short", thresholds=None):
    return panel(
        pid, title, "stat", x, y, w, h,
        targets=[target(expr, title)],
        field_config={
            "defaults": {
                "unit": unit,
                "thresholds": thresholds or {
                    "mode": "absolute",
                    "steps": [{"color": "green", "value": None}, {"color": "red", "value": 80}],
                },
            },
            "overrides": [],
        },
        options={"reduceOptions": {"calcs": ["lastNotNull"]}, "orientation": "auto", "textMode": "auto"},
    )


def timeseries_panel(pid, title, targets, x, y, w=12, h=8, unit="short"):
    return panel(
        pid, title, "timeseries", x, y, w, h,
        targets=targets,
        field_config={"defaults": {"unit": unit}, "overrides": []},
        options={"legend": {"placement": "bottom"}, "tooltip": {"mode": "multi"}},
    )


def gauge_panel(pid, title, expr, x, y, w=4, h=4, unit="s", max_val=5):
    return panel(
        pid, title, "gauge", x, y, w, h,
        targets=[target(expr)],
        field_config={
            "defaults": {
                "unit": unit,
                "max": max_val,
                "thresholds": {
                    "mode": "absolute",
                    "steps": [
                        {"color": "green", "value": None},
                        {"color": "orange", "value": max_val * 0.6},
                        {"color": "red", "value": max_val * 0.9},
                    ],
                },
            },
            "overrides": [],
        },
    )


def dashboard(title: str, uid_str: str, panels: list, tags: list = None) -> dict:
    return {
        "id": None,
        "uid": uid_str,
        "title": title,
        "tags": tags or ["ubrnms"],
        "timezone": "browser",
        "schemaVersion": 36,
        "version": 1,
        "refresh": "30s",
        "panels": panels,
        "time": {"from": "now-1h", "to": "now"},
        "templating": {
            "list": [
                {
                    "name": "datasource",
                    "type": "datasource",
                    "query": "prometheus",
                    "current": {"text": "Prometheus", "value": "Prometheus"},
                }
            ]
        },
    }


# ── 1. Executive Overview ─────────────────────────────────────────────────────
exec_panels = [
    stat_panel(1, "System Health", 'sum(up{job=~".+-service"}) / count(up{job=~".+-service"}) * 100',
               0, 0, 4, 4, unit="percent"),
    stat_panel(2, "Total Devices Managed", 'count(up{job="discovery-service"})',
               4, 0, 4, 4),
    stat_panel(3, "Active Alarms", 'count(ALERTS{alertstate="firing"})',
               8, 0, 4, 4, thresholds={
                   "mode": "absolute",
                   "steps": [{"color": "green", "value": None}, {"color": "yellow", "value": 10}, {"color": "red", "value": 50}],
               }),
    gauge_panel(4, "Alarm Pipeline Latency P99",
                'histogram_quantile(0.99, rate(alarm_correlation_latency_seconds_bucket[5m]))',
                12, 0, 4, 4, unit="s", max_val=3),
    timeseries_panel(5, "Services Status (% Up)",
                     [target('sum(up{job=~".+-service"}) / count(up{job=~".+-service"}) * 100', "Availability %")],
                     0, 4, 24, 8, unit="percent"),
]
(OUT / "executive-overview.json").write_text(json.dumps(
    dashboard("UBR NMS — Executive Overview", "exec-001", exec_panels, ["ubrnms", "executive"]), indent=2
))

# ── 2. NOC Operations ─────────────────────────────────────────────────────────
noc_panels = [
    timeseries_panel(1, "Alarm Rate (alarms/min)",
                     [target('rate(kafka_messages_consumed_total{topic="raw-alarms"}[1m]) * 60', "Alarm rate/min")],
                     0, 0, 12, 8),
    timeseries_panel(2, "Device Online/Offline",
                     [
                         target('count(up{job="discovery-service"} == 1)', "Online"),
                         target('count(up{job="discovery-service"} == 0)', "Offline"),
                     ],
                     12, 0, 12, 8),
    gauge_panel(3, "Alarm→Dashboard Latency P99",
                'histogram_quantile(0.99, rate(alarm_correlation_latency_seconds_bucket[5m]))',
                0, 8, 8, 6, unit="s", max_val=3),
    timeseries_panel(4, "Netcool Forwarding Rate",
                     [target('rate(netcool_alarms_forwarded_total[1m]) * 60', "Forwarded/min")],
                     8, 8, 16, 6),
]
(OUT / "noc-operations.json").write_text(json.dumps(
    dashboard("UBR NMS — NOC Operations", "noc-001", noc_panels, ["ubrnms", "noc"]), indent=2
))

# ── 3. Platform Health (one row per service) ──────────────────────────────────
ph_panels = []
pid = 1
for i, svc in enumerate(SERVICES):
    row_y = i * 8
    ph_panels.extend([
        timeseries_panel(pid, f"{svc} — CPU %",
                         [target(f'rate(process_cpu_seconds_total{{job="{svc}"}}[5m]) * 100', "CPU %")],
                         0, row_y, 6, 8, unit="percent"),
        timeseries_panel(pid + 1, f"{svc} — Memory MB",
                         [target(f'process_resident_memory_bytes{{job="{svc}"}} / 1024 / 1024', "MB")],
                         6, row_y, 6, 8, unit="decmbytes"),
        timeseries_panel(pid + 2, f"{svc} — Request Rate",
                         [target(f'rate(http_requests_total{{job="{svc}"}}[1m])', "req/s")],
                         12, row_y, 6, 8, unit="reqps"),
        timeseries_panel(pid + 3, f"{svc} — Error Rate %",
                         [target(f'rate(http_requests_total{{job="{svc}",status=~"5.."}}[1m]) / rate(http_requests_total{{job="{svc}"}}[1m]) * 100', "5xx %")],
                         18, row_y, 6, 8, unit="percent"),
    ])
    pid += 4

(OUT / "platform-health.json").write_text(json.dumps(
    dashboard("UBR NMS — Platform Health", "platform-001", ph_panels, ["ubrnms", "platform"]), indent=2
))

# ── 4. Kafka Monitoring ───────────────────────────────────────────────────────
kafka_panels = [
    timeseries_panel(1, "Consumer Lag by Topic",
                     [target('kafka_consumer_lag', "{{ topic }}/{{ partition }}")],
                     0, 0, 12, 8),
    timeseries_panel(2, "Messages Consumed/sec",
                     [target('rate(kafka_messages_consumed_total[1m])', "{{ topic }}")],
                     12, 0, 12, 8),
    timeseries_panel(3, "Alarm Pipeline Lag",
                     [target('kafka_consumer_lag{topic="raw-alarms"}', "raw-alarms lag")],
                     0, 8, 12, 8),
    timeseries_panel(4, "Netcool Forward Lag",
                     [target('kafka_consumer_lag{topic="netcool-alarms-forward"}', "forward lag")],
                     12, 8, 12, 8),
]
(OUT / "kafka-monitoring.json").write_text(json.dumps(
    dashboard("UBR NMS — Kafka Monitoring", "kafka-001", kafka_panels, ["ubrnms", "kafka"]), indent=2
))

# ── 5. Database Monitoring ────────────────────────────────────────────────────
db_panels = [
    timeseries_panel(1, "MongoDB Active Connections",
                     [target('mongodb_connections_current', "connections")],
                     0, 0, 12, 8),
    timeseries_panel(2, "MongoDB Query Latency P99",
                     [target('histogram_quantile(0.99, rate(db_query_duration_seconds_bucket{db="mongodb"}[5m]))', "p99 ms")],
                     12, 0, 12, 8, unit="s"),
    timeseries_panel(3, "Redis Cache Hit Rate",
                     [target('rate(redis_cache_hits_total[1m]) / (rate(redis_cache_hits_total[1m]) + rate(redis_cache_misses_total[1m])) * 100', "hit %")],
                     0, 8, 12, 8, unit="percent"),
    timeseries_panel(4, "Redis Operation Latency P99",
                     [target('histogram_quantile(0.99, rate(redis_operations_duration_seconds_bucket[5m]))', "p99")],
                     12, 8, 12, 8, unit="s"),
]
(OUT / "database-monitoring.json").write_text(json.dumps(
    dashboard("UBR NMS — Database Monitoring", "db-001", db_panels, ["ubrnms", "database"]), indent=2
))

# ── 6. SLO Compliance ─────────────────────────────────────────────────────────
slo_panels = [
    gauge_panel(1, "Alarm Pipeline P99 vs 3s SLO",
                'histogram_quantile(0.99, rate(alarm_correlation_latency_seconds_bucket[5m]))',
                0, 0, 8, 6, unit="s", max_val=3),
    gauge_panel(2, "API P99 vs 500ms SLO",
                'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))',
                8, 0, 8, 6, unit="s", max_val=0.5),
    gauge_panel(3, "KPI Aggregation P99 vs 30s SLO",
                'histogram_quantile(0.99, rate(kpi_poll_duration_seconds_bucket[5m]))',
                16, 0, 8, 6, unit="s", max_val=30),
    timeseries_panel(4, "SLO Error Budget — Alarm Pipeline",
                     [
                         target('histogram_quantile(0.99, rate(alarm_correlation_latency_seconds_bucket[1h]))', "P99 1h"),
                         {"expr": "3", "legendFormat": "SLO Target (3s)", "refId": "B"},
                     ],
                     0, 6, 24, 8, unit="s"),
]
(OUT / "slo-compliance.json").write_text(json.dumps(
    dashboard("UBR NMS — SLO Compliance", "slo-001", slo_panels, ["ubrnms", "slo"]), indent=2
))

print("Generated dashboards:")
for f in sorted(OUT.glob("*.json")):
    print(f"  {f.name}")
