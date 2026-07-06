package com.ubrnms.healthmonitor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.healthmonitor.model.HealthThreshold;
import com.ubrnms.healthmonitor.model.SelfHealthAlarm;
import com.ubrnms.healthmonitor.model.SelfHealthAlarm.Category;
import com.ubrnms.healthmonitor.service.HealthMonitorService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.client.RestTemplate;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@MockitoSettings(strictness = Strictness.LENIENT)
class HealthMonitorServiceTest {

    private KafkaTemplate<String, String> kafkaTemplate;
    private RestTemplate restTemplate;
    private HealthMonitorService service;
    private ObjectMapper objectMapper;

    private static final HealthThreshold DEFAULT_THRESHOLDS = HealthThreshold.builder()
            .cpuPercent(80.0)
            .memoryFreePercent(20.0)
            .storagePercent(85.0)
            .loginFailWindowMinutes(5)
            .loginFailMax(5)
            .temperatureCelsius(0)
            .build();

    @BeforeEach
    void setup() throws Exception {
        kafkaTemplate = mock(KafkaTemplate.class);
        restTemplate = mock(RestTemplate.class);

        objectMapper = new ObjectMapper();
        objectMapper.registerModule(new JavaTimeModule());
        objectMapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

        service = new HealthMonitorService(kafkaTemplate, objectMapper, restTemplate);
        // Inject required @Value fields via reflection
        setField(service, "prometheusUrl", "http://localhost:9090");
        setField(service, "alarmTopic", "raw-alarms");
        setField(service, "serviceNames", List.of("auth-service", "alarm-service"));
        setField(service, "infraComponents", List.of("kafka", "mongodb"));
    }

    // ── CPU threshold ──────────────────────────────────────────────────────

    @Test
    void evaluateCpu_raisesAlarmWhenExceeded() {
        service.evaluateCpu("test-service", 90.0, DEFAULT_THRESHOLDS);

        verify(kafkaTemplate, times(1)).send(eq("raw-alarms"), contains("SELF-HEALTH:test-service"), anyString());
    }

    @Test
    void evaluateCpu_noAlarmWhenBelowThreshold() {
        service.evaluateCpu("test-service", 50.0, DEFAULT_THRESHOLDS);
        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    @Test
    void evaluateCpu_clearsAlarmOnRecovery() {
        // Raise first
        service.evaluateCpu("test-service", 90.0, DEFAULT_THRESHOLDS);
        // Recover
        service.evaluateCpu("test-service", 50.0, DEFAULT_THRESHOLDS);

        // Two Kafka sends: one raise, one clear
        ArgumentCaptor<String> keyCaptor = ArgumentCaptor.forClass(String.class);
        verify(kafkaTemplate, times(2)).send(eq("raw-alarms"), keyCaptor.capture(), anyString());
    }

    // ── Memory threshold ───────────────────────────────────────────────────

    @Test
    void evaluateMemory_raisesAlarmWhenBelow() {
        service.evaluateMemory("test-service", 10.0, DEFAULT_THRESHOLDS);
        verify(kafkaTemplate, times(1)).send(eq("raw-alarms"), contains("MEMORY_LOW"), anyString());
    }

    @Test
    void evaluateMemory_noAlarmWhenAboveThreshold() {
        service.evaluateMemory("test-service", 50.0, DEFAULT_THRESHOLDS);
        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    // ── Storage threshold ──────────────────────────────────────────────────

    @Test
    void evaluateStorage_raisesAlarmWhenExceeded() {
        service.evaluateStorage("test-service", 90.0, DEFAULT_THRESHOLDS);
        verify(kafkaTemplate, times(1)).send(eq("raw-alarms"), contains("STORAGE_HIGH"), anyString());
    }

    @Test
    void evaluateStorage_noAlarmWhenBelowThreshold() {
        service.evaluateStorage("test-service", 70.0, DEFAULT_THRESHOLDS);
        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    // ── Login attempts ─────────────────────────────────────────────────────

    @Test
    void evaluateLoginAttempts_raisesAlarmWhenExceeded() {
        // Mock Prometheus returning 10 failures
        when(restTemplate.getForObject(anyString(), eq(java.util.Map.class)))
                .thenReturn(mockPromResult("10"));

        service.evaluateLoginAttempts(DEFAULT_THRESHOLDS);

        verify(kafkaTemplate, times(1)).send(eq("raw-alarms"), contains("LOGIN_ATTEMPTS"), anyString());
    }

    @Test
    void evaluateLoginAttempts_noAlarmWhenBelowThreshold() {
        when(restTemplate.getForObject(anyString(), eq(java.util.Map.class)))
                .thenReturn(mockPromResult("2"));

        service.evaluateLoginAttempts(DEFAULT_THRESHOLDS);

        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    // ── Temperature ────────────────────────────────────────────────────────

    @Test
    void evaluateTemperature_raisesAlarmWhenExceeded() {
        when(restTemplate.getForObject(anyString(), eq(java.util.Map.class)))
                .thenReturn(mockPromResult("85.0"));

        HealthThreshold thr = HealthThreshold.builder()
                .cpuPercent(80.0).memoryFreePercent(20.0).storagePercent(85.0)
                .loginFailWindowMinutes(5).loginFailMax(5)
                .temperatureCelsius(70.0)
                .build();

        service.evaluateTemperature(thr);

        verify(kafkaTemplate, times(1)).send(eq("raw-alarms"), contains("TEMPERATURE_HIGH"), anyString());
    }

    // ── Alarm lifecycle ────────────────────────────────────────────────────

    @Test
    void raiseAlarm_deduplicatesFlood() {
        var alarm = buildAlarm("svc", Category.CPU_HIGH, "MAJOR");
        service.raiseAlarm(alarm);
        service.raiseAlarm(alarm); // duplicate
        // Only one Kafka message should be sent
        verify(kafkaTemplate, times(1)).send(anyString(), anyString(), anyString());
    }

    @Test
    void clearAlarm_publishesClearMessage() throws Exception {
        var alarm = buildAlarm("svc", Category.SERVICE_DOWN, "CRITICAL");
        service.raiseAlarm(alarm);
        service.clearAlarm(alarm.getAlarmId());

        ArgumentCaptor<String> valueCaptor = ArgumentCaptor.forClass(String.class);
        verify(kafkaTemplate, times(2)).send(anyString(), anyString(), valueCaptor.capture());

        String clearJson = valueCaptor.getAllValues().get(1);
        SelfHealthAlarm clearAlarm = objectMapper.readValue(clearJson, SelfHealthAlarm.class);
        assertEquals("CLEAR", clearAlarm.getState());
    }

    // ── Threshold CRUD ─────────────────────────────────────────────────────

    @Test
    void updateThresholds_persistsNewValues() {
        HealthThreshold updated = HealthThreshold.builder()
                .cpuPercent(90.0).memoryFreePercent(15.0).storagePercent(95.0)
                .loginFailWindowMinutes(10).loginFailMax(10).temperatureCelsius(75.0)
                .build();

        service.updateThresholds(updated);

        assertEquals(90.0, service.getThresholds().getCpuPercent());
        assertEquals(75.0, service.getThresholds().getTemperatureCelsius());
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private SelfHealthAlarm buildAlarm(String service, Category category, String severity) {
        return SelfHealthAlarm.builder()
                .alarmId("SELF-HEALTH:" + service + ":" + category.name())
                .alarmName(category.name())
                .severity(severity)
                .description("test alarm")
                .state("ACTIVE")
                .source("NMS-SELF-HEALTH")
                .serviceName(service)
                .category(category)
                .measuredValue(95.0)
                .threshold(80.0)
                .build();
    }

    @SuppressWarnings("unchecked")
    private java.util.Map<String, Object> mockPromResult(String value) {
        return java.util.Map.of(
                "status", "success",
                "data", java.util.Map.of(
                        "resultType", "vector",
                        "result", List.of(
                                java.util.Map.of(
                                        "metric", java.util.Map.of(),
                                        "value", List.of(System.currentTimeMillis() / 1000.0, value)
                                )
                        )
                )
        );
    }

    private void setField(Object target, String name, Object value) throws Exception {
        java.lang.reflect.Field f = target.getClass().getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }
}
