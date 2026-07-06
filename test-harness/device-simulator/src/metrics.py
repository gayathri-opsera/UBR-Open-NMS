"""
Prometheus metrics for the device fleet simulator.
"""
from prometheus_client import Counter, Gauge, start_http_server


simulated_devices_active = Gauge(
    "simulated_devices_active",
    "Number of currently active (ONLINE) simulated devices",
)

simulated_events_generated_total = Counter(
    "simulated_events_generated_total",
    "Total simulated events generated",
    ["event_type"],  # "snmp_trap" | "syslog" | "kpi_poll"
)

simulated_checkins_total = Counter(
    "simulated_checkins_total",
    "Total simulated device check-ins",
)


def start_metrics_server(port: int = 9100):
    """Start the Prometheus metrics HTTP server."""
    start_http_server(port)
