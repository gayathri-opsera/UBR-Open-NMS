"""
Tests for shared Python metrics library (ubrnms_metrics.py).
Verifies: metric registration, counter increments, histogram observations,
and Prometheus text format output.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../python/src"))

import pytest
from prometheus_client import CollectorRegistry, generate_latest, CONTENT_TYPE_LATEST
from ubrnms_metrics import NmsMetrics


@pytest.fixture
def registry():
    """Fresh Prometheus registry for each test."""
    return CollectorRegistry()


@pytest.fixture
def metrics(registry):
    return NmsMetrics(service_name="test-service", registry=registry)


# ── Counter tests ────────────────────────────────────────────────────────────

def test_http_requests_total_increments(metrics, registry):
    metrics.http_requests_total.labels(method="GET", path="/api/v1/alarms", status="200").inc()
    metrics.http_requests_total.labels(method="GET", path="/api/v1/alarms", status="200").inc()
    metrics.http_requests_total.labels(method="POST", path="/api/v1/alarms", status="201").inc()

    output = generate_latest(registry).decode()
    assert "http_requests_total" in output
    assert 'method="GET"' in output
    assert 'status="200"' in output


def test_kafka_messages_consumed_increments(metrics, registry):
    metrics.kafka_messages_consumed.labels(topic="raw-alarms").inc(5)
    output = generate_latest(registry).decode()
    assert "kafka_messages_consumed_total" in output
    assert 'topic="raw-alarms"' in output


def test_redis_cache_hits_misses(metrics, registry):
    metrics.redis_cache_hits.labels(cache="kpi").inc(3)
    metrics.redis_cache_misses.labels(cache="kpi").inc(1)
    output = generate_latest(registry).decode()
    assert "redis_cache_hits_total" in output
    assert "redis_cache_misses_total" in output


# ── Histogram tests ──────────────────────────────────────────────────────────

def test_http_request_duration_histogram(metrics, registry):
    metrics.http_request_duration.labels(method="GET", path="/api/v1/devices").observe(0.042)
    metrics.http_request_duration.labels(method="GET", path="/api/v1/devices").observe(0.120)

    output = generate_latest(registry).decode()
    assert "http_request_duration_seconds_bucket" in output
    assert "http_request_duration_seconds_sum" in output
    assert "http_request_duration_seconds_count" in output


def test_db_query_duration_histogram(metrics, registry):
    with metrics.time_db_operation("findOne"):
        pass  # instant operation

    output = generate_latest(registry).decode()
    assert "db_query_duration_seconds" in output
    assert 'operation="findOne"' in output


def test_report_generation_duration_histogram(metrics, registry):
    with metrics.time_report_generation("alarm_history"):
        pass

    output = generate_latest(registry).decode()
    assert "report_generation_duration_seconds" in output
    assert 'report_type="alarm_history"' in output


# ── Gauge tests ───────────────────────────────────────────────────────────────

def test_kafka_consumer_lag_gauge(metrics, registry):
    metrics.kafka_consumer_lag.labels(topic="netcool-alarms-forward", partition="0").set(42)
    output = generate_latest(registry).decode()
    assert "kafka_consumer_lag" in output
    assert '42.0' in output


def test_db_connections_active_gauge(metrics, registry):
    metrics.db_connections_active.labels(db="mongodb").set(5)
    output = generate_latest(registry).decode()
    assert "db_connections_active" in output


# ── Prometheus text format compliance ─────────────────────────────────────────

def test_output_is_valid_prometheus_format(metrics, registry):
    metrics.http_requests_total.labels(method="GET", path="/test", status="200").inc()
    output = generate_latest(registry).decode()

    # Must start with # HELP and # TYPE lines
    assert "# HELP" in output
    assert "# TYPE" in output

    # Each metric family must have the right type declarations
    assert "# TYPE http_requests_total counter" in output
    assert "# TYPE http_request_duration_seconds histogram" in output
    assert "# TYPE kafka_consumer_lag gauge" in output


def test_metric_naming_conventions(metrics, registry):
    """Verify naming conventions: snake_case, _total for counters, _seconds for durations."""
    output = generate_latest(registry).decode()

    # All counters end in _total
    counter_names = [
        "http_requests_total",
        "kafka_messages_consumed_total",
        "redis_cache_hits_total",
        "redis_cache_misses_total",
    ]
    for name in counter_names:
        assert name in output, f"Missing counter metric: {name}"

    # All duration histograms end in _seconds
    histogram_names = [
        "http_request_duration_seconds",
        "db_query_duration_seconds",
        "redis_operations_duration_seconds",
    ]
    for name in histogram_names:
        assert name in output, f"Missing histogram metric: {name}"
