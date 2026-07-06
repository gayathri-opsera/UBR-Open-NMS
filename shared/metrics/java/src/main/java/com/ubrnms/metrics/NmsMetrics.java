package com.ubrnms.metrics;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Shared Prometheus metrics registry for all UBR NMS Java/Spring Boot services.
 *
 * Services inject this bean and call the provided helper methods to record
 * standard metrics. All metric names follow Prometheus naming conventions:
 *   - snake_case
 *   - _total suffix for counters
 *   - _seconds suffix for duration histograms
 *   - _bytes suffix for size metrics
 */
@Component
@RequiredArgsConstructor
public class NmsMetrics {

    private final MeterRegistry registry;

    // ── HTTP metrics ───────────────────────────────────────────────────────

    /**
     * Records one HTTP request. Call after the response is sent.
     *
     * @param method  HTTP method (GET, POST, …)
     * @param path    normalized path template (e.g. /api/v1/alarms)
     * @param status  HTTP status code (200, 404, …)
     */
    public void recordHttpRequest(String method, String path, int status) {
        Counter.builder("http_requests_total")
                .description("Total HTTP requests")
                .tag("method", method)
                .tag("path", path)
                .tag("status", String.valueOf(status))
                .register(registry)
                .increment();
    }

    /**
     * Returns a Timer.Sample to measure HTTP request duration. The caller
     * should call {@code sample.stop(httpRequestDurationTimer(method, path))}
     * when the request completes.
     */
    public Timer.Sample startHttpTimer() {
        return Timer.start(registry);
    }

    public Timer httpRequestDurationTimer(String method, String path) {
        return Timer.builder("http_request_duration_seconds")
                .description("HTTP request duration")
                .tag("method", method)
                .tag("path", path)
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(registry);
    }

    /**
     * Registers a gauge for in-flight HTTP requests. Pass a supplier backed
     * by an {@link AtomicInteger} that the caller increments/decrements.
     */
    public void registerInFlightGauge(String serviceName, Supplier<Number> supplier) {
        Gauge.builder("http_requests_in_flight", supplier)
                .description("In-flight HTTP requests")
                .tag("service", serviceName)
                .register(registry);
    }

    // ── Kafka metrics ──────────────────────────────────────────────────────

    public void recordKafkaMessage(String topic) {
        Counter.builder("kafka_messages_consumed_total")
                .description("Total Kafka messages consumed")
                .tag("topic", topic)
                .register(registry)
                .increment();
    }

    public void setKafkaConsumerLag(String topic, int partition, long lag) {
        Gauge.builder("kafka_consumer_lag", () -> lag)
                .description("Kafka consumer lag")
                .tag("topic", topic)
                .tag("partition", String.valueOf(partition))
                .register(registry);
    }

    // ── Database metrics ───────────────────────────────────────────────────

    public Timer dbQueryTimer(String operation) {
        return Timer.builder("db_query_duration_seconds")
                .description("Database query duration")
                .tag("operation", operation)
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(registry);
    }

    public void registerDbConnectionsGauge(String dbType, Supplier<Number> supplier) {
        Gauge.builder("db_connections_active", supplier)
                .description("Active database connections")
                .tag("db", dbType)
                .register(registry);
    }

    // ── Redis/cache metrics ────────────────────────────────────────────────

    public void recordCacheHit(String cacheName) {
        Counter.builder("redis_cache_hits_total")
                .description("Redis cache hits")
                .tag("cache", cacheName)
                .register(registry)
                .increment();
    }

    public void recordCacheMiss(String cacheName) {
        Counter.builder("redis_cache_misses_total")
                .description("Redis cache misses")
                .tag("cache", cacheName)
                .register(registry)
                .increment();
    }

    public Timer redisOperationTimer(String operation) {
        return Timer.builder("redis_operations_duration_seconds")
                .description("Redis operation duration")
                .tag("operation", operation)
                .register(registry);
    }

    // ── Service-specific helpers ───────────────────────────────────────────

    public void recordAlarmCorrelated(String correlationType) {
        Counter.builder("alarms_correlated_total")
                .description("Total correlated alarms")
                .tag("type", correlationType)
                .register(registry)
                .increment();
    }

    public Timer alarmCorrelationTimer() {
        return Timer.builder("alarm_correlation_latency_seconds")
                .description("Alarm correlation processing latency")
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(registry);
    }

    public void recordEventReceived(String source) {
        Counter.builder("events_received_total")
                .description("Total events received")
                .tag("source", source)
                .register(registry)
                .increment();
    }

    public Timer ingestionLatencyTimer() {
        return Timer.builder("event_ingestion_latency_seconds")
                .description("Event ingestion end-to-end latency")
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(registry);
    }

    public void recordKpiPoll(String deviceType) {
        Counter.builder("kpi_polls_completed_total")
                .description("Total KPI polls completed")
                .tag("deviceType", deviceType)
                .register(registry)
                .increment();
    }

    public Timer kpiPollDurationTimer() {
        return Timer.builder("kpi_poll_duration_seconds")
                .description("KPI poll duration")
                .register(registry);
    }
}
