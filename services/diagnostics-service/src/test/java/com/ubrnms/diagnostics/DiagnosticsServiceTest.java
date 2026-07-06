package com.ubrnms.diagnostics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.diagnostics.model.DiagnosticResult;
import com.ubrnms.diagnostics.repository.DiagnosticResultRepository;
import com.ubrnms.diagnostics.service.DefaultDeviceStatusChecker;
import com.ubrnms.diagnostics.service.DiagnosticsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.kafka.core.KafkaTemplate;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class DiagnosticsServiceTest {

    @Mock private DiagnosticResultRepository resultRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @Mock private StringRedisTemplate redisTemplate;
    @Mock private ValueOperations<String, String> valueOps;
    @Spy  private DefaultDeviceStatusChecker statusChecker;
    @InjectMocks private DiagnosticsService service;

    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());

    @BeforeEach
    void setup() throws Exception {
        setField("objectMapper", mapper);
        setField("diagCommandsTopic", "diag-commands");
        setField("auditTopic", "audit-events");
        setField("timeoutSeconds", 60);
        setField("rebootTimeoutSeconds", 5);
        setField("cacheTtlSeconds", 300);
        when(redisTemplate.opsForValue()).thenReturn(valueOps);
        when(resultRepo.save(any())).thenAnswer(inv -> {
            DiagnosticResult r = inv.getArgument(0);
            if (r != null && r.getId() == null) r.setId("test-id-" + System.nanoTime());
            return r;
        });
    }

    void setField(String name, Object value) throws Exception {
        var f = DiagnosticsService.class.getDeclaredField(name);
        f.setAccessible(true); f.set(service, value);
    }

    // ── Offline device rejection ───────────────────────────────────

    @Test
    void execute_offlineDevice_returnsDeviceOfflineStatus() {
        // statusChecker is in-memory, default = offline
        DiagnosticResult result = service.executeLogs("offline-dev", "noc1", "Operator");
        assertThat(result.getStatus()).isEqualTo("DEVICE_OFFLINE");
        assertThat(result.getErrorMessage()).contains("offline");
        verify(kafkaTemplate, never()).send(eq("diag-commands"), anyString(), anyString());
    }

    @Test
    void execute_onlineDevice_publishesCommandAndReturnsPending() {
        statusChecker.markOnline("online-dev");
        DiagnosticResult result = service.executeSpeedTest("online-dev", "noc1", "Operator");
        assertThat(result.getStatus()).isEqualTo("PENDING");
        verify(kafkaTemplate).send(eq("diag-commands"), eq("online-dev"), anyString());
    }

    // ── Each command type ──────────────────────────────────────────

    @Test
    void executeLogs_setsCommandTypeCorrectly() {
        statusChecker.markOnline("dev-logs");
        DiagnosticResult r = service.executeLogs("dev-logs", "admin", "Admin");
        assertThat(r.getCommandType()).isEqualTo("LOGS");
    }

    @Test
    void executeSpeedTest_setsCommandTypeCorrectly() {
        statusChecker.markOnline("dev-st");
        DiagnosticResult r = service.executeSpeedTest("dev-st", "admin", "Admin");
        assertThat(r.getCommandType()).isEqualTo("SPEED_TEST");
    }

    @Test
    void executeSpectrumAnalysis_setsCommandTypeCorrectly() {
        statusChecker.markOnline("dev-sp");
        DiagnosticResult r = service.executeSpectrumAnalysis("dev-sp", "admin", "Admin");
        assertThat(r.getCommandType()).isEqualTo("SPECTRUM");
    }

    @Test
    void executeReboot_setsCommandTypeCorrectly() {
        statusChecker.markOnline("dev-rb");
        DiagnosticResult r = service.executeReboot("dev-rb", "admin", "Admin");
        assertThat(r.getCommandType()).isEqualTo("REBOOT");
    }

    // ── Audit event generation ─────────────────────────────────────

    @Test
    void execute_publishesAuditEvent() {
        statusChecker.markOnline("dev-audit");
        service.executeLogs("dev-audit", "noc1", "Operator");
        verify(kafkaTemplate).send(eq("audit-events"), eq("dev-audit"), anyString());
    }

    @Test
    void offlineCommand_publishesAuditEvent() {
        service.executeLogs("offline-for-audit", "noc1", "Operator");
        verify(kafkaTemplate).send(eq("audit-events"), eq("offline-for-audit"), anyString());
    }

    // ── Timeout handling ───────────────────────────────────────────

    @Test
    void applyResult_updatesStatusAndDuration() {
        DiagnosticResult pending = new DiagnosticResult();
        pending.setId("dr-1"); pending.setDeviceId("dev-x");
        pending.setCommandType("LOGS"); pending.setRequestedAt(Instant.now().minusSeconds(10));

        when(resultRepo.findById("dr-1")).thenReturn(Optional.of(pending));
        when(resultRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        DiagnosticResult result = service.applyResult("dr-1", "SUCCESS",
                Map.of("logs", "syslog content here"), null);
        assertThat(result.getStatus()).isEqualTo("SUCCESS");
        assertThat(result.getDurationMs()).isGreaterThan(0);
        assertThat(result.getResult()).containsKey("logs");
    }

    @Test
    void applyResult_setsTimeoutStatus() {
        DiagnosticResult pending = new DiagnosticResult();
        pending.setId("dr-2"); pending.setDeviceId("dev-y");
        pending.setCommandType("SPEED_TEST");
        pending.setRequestedAt(Instant.now().minusSeconds(65));

        when(resultRepo.findById("dr-2")).thenReturn(Optional.of(pending));
        when(resultRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        DiagnosticResult result = service.applyResult("dr-2", "TIMEOUT", null, "Command timed out");
        assertThat(result.getStatus()).isEqualTo("TIMEOUT");
        assertThat(result.getErrorMessage()).contains("timed out");
    }
}
