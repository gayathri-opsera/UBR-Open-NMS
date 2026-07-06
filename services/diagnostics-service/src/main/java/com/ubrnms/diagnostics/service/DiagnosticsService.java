package com.ubrnms.diagnostics.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.diagnostics.model.DiagnosticResult;
import com.ubrnms.diagnostics.repository.DiagnosticResultRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class DiagnosticsService {

    private final DiagnosticResultRepository resultRepo;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final StringRedisTemplate redisTemplate;
    private final DeviceStatusChecker deviceStatusChecker;
    private final ObjectMapper objectMapper;

    @Value("${kafka.topics.diag-commands:diag-commands}")
    private String diagCommandsTopic;

    @Value("${kafka.topics.audit-events:audit-events}")
    private String auditTopic;

    @Value("${diagnostics.timeout-seconds:60}")
    private int timeoutSeconds;

    @Value("${diagnostics.reboot-timeout-seconds:5}")
    private int rebootTimeoutSeconds;

    @Value("${diagnostics.cache-ttl-seconds:300}")
    private int cacheTtlSeconds;

    // ── Command execution ──────────────────────────────────────────

    public DiagnosticResult executeLogs(String deviceId, String actor, String role) {
        return execute(deviceId, "LOGS", actor, role, Map.of("action", "retrieve_logs"), timeoutSeconds);
    }

    public DiagnosticResult executeSpeedTest(String deviceId, String actor, String role) {
        return execute(deviceId, "SPEED_TEST", actor, role, Map.of("action", "speed_test"), timeoutSeconds);
    }

    public DiagnosticResult executeSpectrumAnalysis(String deviceId, String actor, String role) {
        return execute(deviceId, "SPECTRUM", actor, role, Map.of("action", "spectrum_analysis"), timeoutSeconds);
    }

    public DiagnosticResult executeReboot(String deviceId, String actor, String role) {
        return execute(deviceId, "REBOOT", actor, role, Map.of("action", "reboot"), rebootTimeoutSeconds);
    }

    public DiagnosticResult getStats(String deviceId, String actor, String role) {
        // Stats are read from cache first
        String cacheKey = "diag:stats:" + deviceId;
        String cached = redisTemplate.opsForValue().get(cacheKey);
        if (cached != null) {
            try {
                DiagnosticResult result = objectMapper.readValue(cached, DiagnosticResult.class);
                result.setStatus("SUCCESS");
                return result;
            } catch (Exception ignored) {}
        }
        return execute(deviceId, "STATS", actor, role, Map.of("action", "get_stats"), timeoutSeconds);
    }

    // ── Result retrieval ───────────────────────────────────────────

    public List<DiagnosticResult> getHistory(String deviceId) {
        return resultRepo.findByDeviceIdOrderByRequestedAtDesc(deviceId);
    }

    public Optional<DiagnosticResult> getResult(String id) {
        return resultRepo.findById(id);
    }

    // ── Private helpers ────────────────────────────────────────────

    DiagnosticResult execute(String deviceId, String commandType,
                              String actor, String role,
                              Map<String, Object> params, int timeout) {
        DiagnosticResult dr = new DiagnosticResult();
        dr.setDeviceId(deviceId);
        dr.setCommandType(commandType);
        dr.setActor(actor);
        dr.setRole(role);
        dr.setRequestedAt(Instant.now());

        if (!deviceStatusChecker.isOnline(deviceId)) {
            dr.setStatus("DEVICE_OFFLINE");
            dr.setErrorMessage("Device offline — diagnostic commands require an active device connection.");
            dr.setCompletedAt(Instant.now());
            dr = resultRepo.save(dr);
            publishAudit(dr);
            return dr;
        }

        dr.setStatus("PENDING");
        dr = resultRepo.save(dr);

        // Publish command to diag-commands Kafka topic (Config Push Worker picks it up)
        try {
            Map<String, Object> cmd = new LinkedHashMap<>();
            cmd.put("diagId", dr.getId());
            cmd.put("deviceId", deviceId);
            cmd.put("commandType", commandType);
            cmd.put("params", params);
            cmd.put("timeoutSeconds", timeout);
            cmd.put("actor", actor);
            kafkaTemplate.send(diagCommandsTopic, deviceId, objectMapper.writeValueAsString(cmd));
        } catch (Exception e) {
            log.error("Failed to publish diag command", e);
            dr.setStatus("FAILURE");
            dr.setErrorMessage("Failed to enqueue command: " + e.getMessage());
            dr.setCompletedAt(Instant.now());
            dr = resultRepo.save(dr);
        }

        publishAudit(dr);

        // Cache the result skeleton for 5 minutes
        try {
            String cacheKey = "diag:" + commandType.toLowerCase() + ":" + deviceId;
            redisTemplate.opsForValue().set(cacheKey, objectMapper.writeValueAsString(dr),
                    Duration.ofSeconds(cacheTtlSeconds));
        } catch (Exception ignored) {}

        return dr;
    }

    /** Apply a completed result from the diag-results Kafka topic. */
    public DiagnosticResult applyResult(String diagId, String status,
                                         Map<String, Object> resultData, String errorMessage) {
        return resultRepo.findById(diagId).map(dr -> {
            dr.setStatus(status);
            dr.setResult(resultData);
            dr.setErrorMessage(errorMessage);
            dr.setCompletedAt(Instant.now());
            dr.setDurationMs(dr.getCompletedAt().toEpochMilli() - dr.getRequestedAt().toEpochMilli());
            DiagnosticResult saved = resultRepo.save(dr);
            // Update cache
            try {
                String cacheKey = "diag:" + dr.getCommandType().toLowerCase() + ":" + dr.getDeviceId();
                redisTemplate.opsForValue().set(cacheKey, objectMapper.writeValueAsString(saved),
                        Duration.ofSeconds(cacheTtlSeconds));
            } catch (Exception ignored) {}
            publishAudit(saved);
            return saved;
        }).orElse(null);
    }

    private void publishAudit(DiagnosticResult dr) {
        try {
            Map<String, Object> audit = new LinkedHashMap<>();
            audit.put("eventType", "DIAGNOSTIC_COMMAND");
            audit.put("actor", dr.getActor());
            audit.put("deviceId", dr.getDeviceId());
            audit.put("commandType", dr.getCommandType());
            audit.put("status", dr.getStatus());
            audit.put("timestamp", dr.getRequestedAt().toString());
            kafkaTemplate.send(auditTopic, dr.getDeviceId(), objectMapper.writeValueAsString(audit));
        } catch (Exception e) {
            log.error("Failed to publish audit event", e);
        }
    }
}
