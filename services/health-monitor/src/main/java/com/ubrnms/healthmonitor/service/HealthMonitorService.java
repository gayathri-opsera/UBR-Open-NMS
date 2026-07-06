package com.ubrnms.healthmonitor.service;

import com.ubrnms.healthmonitor.model.HealthThreshold;
import com.ubrnms.healthmonitor.model.SelfHealthAlarm;
import com.ubrnms.healthmonitor.model.SelfHealthAlarm.Category;
import com.ubrnms.healthmonitor.model.SystemHealthStatus;
import com.ubrnms.healthmonitor.model.SystemHealthStatus.OverallStatus;
import com.ubrnms.healthmonitor.model.SystemHealthStatus.ServiceStatus;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Core self-health monitor. Runs on a scheduled interval, queries Prometheus
 * for service metrics, evaluates thresholds, and publishes self-health alarms.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class HealthMonitorService {

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    @Value("${health-monitor.prometheus-url}")
    private String prometheusUrl;

    @Value("${health-monitor.kafka-topic}")
    private String alarmTopic;

    @Value("${health-monitor.services}")
    private List<String> serviceNames;

    @Value("${health-monitor.infrastructure}")
    private List<String> infraComponents;

    private final AtomicReference<HealthThreshold> thresholds = new AtomicReference<>(
            HealthThreshold.builder()
                    .cpuPercent(80.0)
                    .memoryFreePercent(20.0)
                    .storagePercent(85.0)
                    .loginFailWindowMinutes(5)
                    .loginFailMax(5)
                    .temperatureCelsius(0) // disabled by default
                    .build()
    );

    // Last known health snapshot
    private final AtomicReference<SystemHealthStatus> lastSnapshot = new AtomicReference<>();

    // Track active alarm IDs to avoid re-raising the same alarm
    private final Set<String> activeAlarms = ConcurrentHashMap.newKeySet();

    @Scheduled(fixedDelayString = "${health-monitor.check-interval-seconds:30}000")
    public void runHealthCheck() {
        log.debug("Running self-health check");
        HealthThreshold thr = thresholds.get();
        List<ServiceStatus> statuses = new ArrayList<>();
        Map<String, Boolean> infraStatus = new LinkedHashMap<>();
        boolean hasCritical = false;
        boolean hasDegraded = false;

        // 1. Check each microservice
        for (String svc : serviceNames) {
            double cpu = querySingleValue(promQuery(
                    "rate(process_cpu_seconds_total{job=\"" + svc + "\"}[1m]) * 100"));
            double memFree = querySingleValue(promQuery(
                    "(node_memory_MemAvailable_bytes{job=\"" + svc + "\"} / node_memory_MemTotal_bytes{job=\"" + svc + "\"}) * 100"));
            double storage = querySingleValue(promQuery(
                    "(1 - node_filesystem_free_bytes{job=\"" + svc + "\",mountpoint=\"/\"} / node_filesystem_size_bytes{job=\"" + svc + "\",mountpoint=\"/\"}) * 100"));

            boolean up = (cpu >= 0); // negative sentinel = service unreachable

            evaluateCpu(svc, cpu, thr);
            evaluateMemory(svc, memFree, thr);
            evaluateStorage(svc, storage, thr);
            if (!up) {
                raiseAlarm(buildAlarm(svc, Category.SERVICE_DOWN, "CRITICAL",
                        svc + " is DOWN", -1, 0));
                hasCritical = true;
            } else {
                clearAlarm(alarmId(svc, Category.SERVICE_DOWN));
            }

            String statusStr = !up ? "DOWN" : (cpu > thr.getCpuPercent() || memFree < thr.getMemoryFreePercent()) ? "DEGRADED" : "UP";
            if ("DEGRADED".equals(statusStr)) hasDegraded = true;
            if ("DOWN".equals(statusStr)) hasCritical = true;

            statuses.add(ServiceStatus.builder()
                    .name(svc).up(up)
                    .cpuPercent(Math.max(0, cpu))
                    .memoryFreePercent(Math.max(0, memFree))
                    .storagePercent(Math.max(0, storage))
                    .status(statusStr)
                    .build());
        }

        // 2. Check infrastructure connectivity
        for (String comp : infraComponents) {
            boolean reachable = checkInfraConnectivity(comp);
            infraStatus.put(comp, reachable);
            if (!reachable) {
                raiseAlarm(buildAlarm(comp, Category.INTERFACE_DOWN, "CRITICAL",
                        comp + " interface unreachable", -1, 0));
                hasCritical = true;
            } else {
                clearAlarm(alarmId(comp, Category.INTERFACE_DOWN));
            }
        }

        // 3. Login attempts
        evaluateLoginAttempts(thr);

        // 4. Temperature (if enabled)
        if (thr.getTemperatureCelsius() > 0) {
            evaluateTemperature(thr);
        }

        OverallStatus overall = hasCritical ? OverallStatus.CRITICAL
                : hasDegraded ? OverallStatus.DEGRADED
                : OverallStatus.HEALTHY;

        lastSnapshot.set(SystemHealthStatus.builder()
                .overall(overall)
                .checkedAt(Instant.now())
                .services(statuses)
                .infrastructure(infraStatus)
                .build());
    }

    // ── Threshold evaluators ───────────────────────────────────────────────

    public void evaluateCpu(String service, double cpu, HealthThreshold thr) {
        String id = alarmId(service, Category.CPU_HIGH);
        if (cpu > thr.getCpuPercent()) {
            raiseAlarm(buildAlarm(service, Category.CPU_HIGH, "MAJOR",
                    service + " CPU at " + String.format("%.1f", cpu) + "% (threshold " + thr.getCpuPercent() + "%)",
                    cpu, thr.getCpuPercent()));
        } else {
            clearAlarm(id);
        }
    }

    public void evaluateMemory(String service, double memFreePercent, HealthThreshold thr) {
        String id = alarmId(service, Category.MEMORY_LOW);
        if (memFreePercent >= 0 && memFreePercent < thr.getMemoryFreePercent()) {
            raiseAlarm(buildAlarm(service, Category.MEMORY_LOW, "MAJOR",
                    service + " free memory at " + String.format("%.1f", memFreePercent) + "% (threshold " + thr.getMemoryFreePercent() + "%)",
                    memFreePercent, thr.getMemoryFreePercent()));
        } else {
            clearAlarm(id);
        }
    }

    public void evaluateStorage(String service, double storagePercent, HealthThreshold thr) {
        String id = alarmId(service, Category.STORAGE_HIGH);
        if (storagePercent > thr.getStoragePercent()) {
            raiseAlarm(buildAlarm(service, Category.STORAGE_HIGH, "MAJOR",
                    service + " storage at " + String.format("%.1f", storagePercent) + "% (threshold " + thr.getStoragePercent() + "%)",
                    storagePercent, thr.getStoragePercent()));
        } else {
            clearAlarm(id);
        }
    }

    public void evaluateLoginAttempts(HealthThreshold thr) {
        double failCount = querySingleValue(promQuery(
                "increase(auth_login_failures_total[" + thr.getLoginFailWindowMinutes() + "m])"));
        String id = alarmId("auth-service", Category.LOGIN_ATTEMPTS);
        if (failCount >= thr.getLoginFailMax()) {
            raiseAlarm(buildAlarm("auth-service", Category.LOGIN_ATTEMPTS, "WARNING",
                    "Too many login failures: " + (int) failCount + " in " + thr.getLoginFailWindowMinutes() + " minutes",
                    failCount, thr.getLoginFailMax()));
        } else {
            clearAlarm(id);
        }
    }

    public void evaluateTemperature(HealthThreshold thr) {
        double temp = querySingleValue(promQuery("node_hwmon_temp_celsius"));
        String id = alarmId("infrastructure", Category.TEMPERATURE_HIGH);
        if (temp > thr.getTemperatureCelsius()) {
            raiseAlarm(buildAlarm("infrastructure", Category.TEMPERATURE_HIGH, "MAJOR",
                    "Temperature at " + String.format("%.1f", temp) + "°C (threshold " + thr.getTemperatureCelsius() + "°C)",
                    temp, thr.getTemperatureCelsius()));
        } else {
            clearAlarm(id);
        }
    }

    // ── Alarm lifecycle ────────────────────────────────────────────────────

    public void raiseAlarm(SelfHealthAlarm alarm) {
        String id = alarm.getAlarmId();
        if (activeAlarms.contains(id)) {
            return; // already raised, avoid flood
        }
        activeAlarms.add(id);
        publishAlarm(alarm);
    }

    public void clearAlarm(String alarmId) {
        if (!activeAlarms.contains(alarmId)) {
            return;
        }
        activeAlarms.remove(alarmId);
        SelfHealthAlarm clear = SelfHealthAlarm.builder()
                .alarmId(alarmId)
                .alarmName("Self-health alarm cleared")
                .severity("CLEAR")
                .description("Alarm condition resolved: " + alarmId)
                .state("CLEAR")
                .timestamp(Instant.now())
                .source("NMS-SELF-HEALTH")
                .build();
        publishAlarm(clear);
    }

    private void publishAlarm(SelfHealthAlarm alarm) {
        try {
            String json = objectMapper.writeValueAsString(alarm);
            kafkaTemplate.send(alarmTopic, alarm.getAlarmId(), json);
        } catch (Exception e) {
            log.error("Failed to publish self-health alarm", e);
        }
    }

    // ── Getters / setters for REST API ─────────────────────────────────────

    public SystemHealthStatus getLatestSnapshot() {
        return lastSnapshot.get();
    }

    public HealthThreshold getThresholds() {
        return thresholds.get();
    }

    public void updateThresholds(HealthThreshold updated) {
        thresholds.set(updated);
        log.info("Thresholds updated: {}", updated);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private String alarmId(String service, Category category) {
        return "SELF-HEALTH:" + service + ":" + category.name();
    }

    private SelfHealthAlarm buildAlarm(String service, Category category, String severity,
                                       String description, double value, double threshold) {
        return SelfHealthAlarm.builder()
                .alarmId(alarmId(service, category))
                .alarmName(category.name().replace("_", " ").toLowerCase())
                .severity(severity)
                .description(description)
                .state("ACTIVE")
                .timestamp(Instant.now())
                .source("NMS-SELF-HEALTH")
                .serviceName(service)
                .category(category)
                .measuredValue(value)
                .threshold(threshold)
                .build();
    }

    private String promQuery(String query) {
        return prometheusUrl + "/api/v1/query?query=" + query;
    }

    /**
     * Queries Prometheus instant query endpoint and returns the first scalar value.
     * Returns -1.0 if the query fails (service unreachable or no data).
     */
    double querySingleValue(String url) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> resp = restTemplate.getForObject(url, Map.class);
            if (resp == null) return -1.0;
            @SuppressWarnings("unchecked")
            Map<String, Object> data = (Map<String, Object>) resp.get("data");
            if (data == null) return -1.0;
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> result = (List<Map<String, Object>>) data.get("result");
            if (result == null || result.isEmpty()) return -1.0;
            @SuppressWarnings("unchecked")
            List<Object> value = (List<Object>) result.get(0).get("value");
            if (value == null || value.size() < 2) return -1.0;
            return Double.parseDouble(value.get(1).toString());
        } catch (Exception e) {
            log.debug("Prometheus query failed: {}", e.getMessage());
            return -1.0;
        }
    }

    /**
     * Checks whether an infrastructure component is reachable by querying its
     * Prometheus 'up' metric. Returns false on any failure.
     */
    boolean checkInfraConnectivity(String component) {
        double up = querySingleValue(promQuery("up{job=\"" + component + "\"}"));
        return up == 1.0;
    }
}
