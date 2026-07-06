"""
UBR NMS — shared Prometheus metrics for Python/FastAPI services.

Usage:
    from ubrnms_metrics import setup_metrics, NmsMetrics

    app = FastAPI()
    setup_metrics(app, service_name="report-service")
    metrics = NmsMetrics(service_name="report-service")
"""

from prometheus_client import Counter, Histogram, Gauge, CollectorRegistry, REGISTRY
from prometheus_fastapi_instrumentator import Instrumentator
from typing import Optional
import time


def setup_metrics(app, service_name: str, registry=REGISTRY):
    """
    Attaches prometheus-fastapi-instrumentator to a FastAPI app.
    Exposes /metrics endpoint automatically.
    """
    Instrumentator(
        should_group_status_codes=False,
        should_group_untemplated=True,
        excluded_handlers=["/healthz", "/readyz", "/metrics"],
    ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


class NmsMetrics:
    """
    Service-level Prometheus metrics following UBR NMS naming conventions.
    Instantiate once per service and reuse across request handlers.
    """

    def __init__(self, service_name: str, registry=REGISTRY):
        labels = {"service": service_name}

        # HTTP
        self.http_requests_total = Counter(
            "http_requests_total",
            "Total HTTP requests",
            ["method", "path", "status"],
            registry=registry,
        )
        self.http_request_duration = Histogram(
            "http_request_duration_seconds",
            "HTTP request duration in seconds",
            ["method", "path"],
            buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
            registry=registry,
        )
        self.http_requests_in_flight = Gauge(
            "http_requests_in_flight",
            "In-flight HTTP requests",
            ["service"],
            registry=registry,
        )

        # Kafka
        self.kafka_messages_consumed = Counter(
            "kafka_messages_consumed_total",
            "Total Kafka messages consumed",
            ["topic"],
            registry=registry,
        )
        self.kafka_consumer_lag = Gauge(
            "kafka_consumer_lag",
            "Kafka consumer lag",
            ["topic", "partition"],
            registry=registry,
        )

        # Database
        self.db_query_duration = Histogram(
            "db_query_duration_seconds",
            "Database query duration in seconds",
            ["operation"],
            buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
            registry=registry,
        )
        self.db_connections_active = Gauge(
            "db_connections_active",
            "Active database connections",
            ["db"],
            registry=registry,
        )

        # Redis / cache
        self.redis_cache_hits = Counter(
            "redis_cache_hits_total",
            "Redis cache hits",
            ["cache"],
            registry=registry,
        )
        self.redis_cache_misses = Counter(
            "redis_cache_misses_total",
            "Redis cache misses",
            ["cache"],
            registry=registry,
        )
        self.redis_op_duration = Histogram(
            "redis_operations_duration_seconds",
            "Redis operation duration in seconds",
            ["operation"],
            buckets=[0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
            registry=registry,
        )

        # Service-specific
        self.reports_generated = Counter(
            "reports_generated_total",
            "Total reports generated",
            ["report_type"],
            registry=registry,
        )
        self.report_generation_duration = Histogram(
            "report_generation_duration_seconds",
            "Report generation duration in seconds",
            ["report_type"],
            registry=registry,
        )

        self._service_name = service_name

    def time_db_operation(self, operation: str):
        """Context manager to record database query duration."""
        return self.db_query_duration.labels(operation=operation).time()

    def time_report_generation(self, report_type: str):
        """Context manager to record report generation duration."""
        return self.report_generation_duration.labels(report_type=report_type).time()
