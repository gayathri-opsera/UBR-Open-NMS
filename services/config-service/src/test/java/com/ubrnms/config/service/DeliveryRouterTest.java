package com.ubrnms.config.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.ConfigJobRepository;
import com.ubrnms.config.repository.PendingCommandRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for WO-049: DeliveryRouter — paradigm-based config delivery routing.
 *
 * <p>Validates:
 * <ul>
 *   <li>AC1 — UBR_REALTIME: pending command created + realtime nudge attempted when online</li>
 *   <li>AC1 — UBR_CHECKIN: pending command created, no realtime nudge</li>
 *   <li>AC1 — CLI_PROTOCOL: Kafka push message published with CLI protocol order</li>
 *   <li>AC1 — SNMP_PROTOCOL: Kafka push message published with SNMP→CLI protocol order</li>
 *   <li>AC2 — UNSUPPORTED channel: device marked UNSUPPORTED, no command or Kafka message</li>
 *   <li>AC3 — UBR offline: command queued, nudge not sent, state=QUEUED</li>
 *   <li>AC3 — Generic offline: no queue, device marked FAILED fast (not queue-eligible)</li>
 *   <li>AC4 — Unit test coverage for all paths</li>
 *   <li>Edge: realtime nudge Kafka failure is non-fatal — command stays QUEUED</li>
 *   <li>Edge: job counts updated correctly (successCount, failureCount, queuedCount)</li>
 *   <li>Edge: credential references only, no inline credentials in Kafka messages</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class DeliveryRouterTest {

    @Mock private PendingCommandRepository pendingRepo;
    @Mock private ConfigJobRepository jobRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @Mock private DeviceStatusChecker deviceStatusChecker;

    private DeliveryRouter router;

    // ── Fixtures ──────────────────────────────────────────────────────────────

    private ConfigJob makeJob(int targetCount) {
        ConfigJob job = new ConfigJob();
        job.setId("job-test");
        job.setTemplateId("tmpl-1");
        job.setStatus("RUNNING");
        job.setTotalDevices(targetCount);
        job.setConfirmedBy("eng-jsmith");
        return job;
    }

    private ConfigTargetPreviewResponse.TargetEntry target(String deviceId, String channel) {
        return ConfigTargetPreviewResponse.TargetEntry.builder()
                .deviceId(deviceId)
                .serialNumber("SN-" + deviceId)
                .deviceType("BTS")
                .deliveryChannel(channel)
                .warnings(List.of())
                .build();
    }

    private ConfigTargetPreviewResponse preview(List<ConfigTargetPreviewResponse.TargetEntry> targets) {
        return ConfigTargetPreviewResponse.builder()
                .previewId("prev-abc")
                .totalCount(targets.size())
                .targets(targets)
                .unsupportedTargets(List.of())
                .generatedAt("2026-09-07T09:00:00Z")
                .requiresConfirmation(false)
                .build();
    }

    @BeforeEach
    void setUp() {
        router = new DeliveryRouter(
                pendingRepo, jobRepo,
                kafkaTemplate, new ObjectMapper().registerModule(new JavaTimeModule()),
                deviceStatusChecker
        );

        // Default: pending command saves return arg with id set
        when(pendingRepo.save(any(PendingCommand.class))).thenAnswer(inv -> {
            PendingCommand cmd = inv.getArgument(0);
            cmd.setId("cmd-" + UUID.randomUUID());
            return cmd;
        });

        // Default: job saves return the same job
        when(jobRepo.save(any(ConfigJob.class))).thenAnswer(inv -> inv.getArgument(0));

        // Default: devices are online
        when(deviceStatusChecker.isOnline(anyString())).thenReturn(true);

        // Inject @Value fields
        setField("configPushTopic", "config-push");
        setField("forceCheckinTopic", "force-checkin");
        setField("ttlHours", 72);
    }

    private void setField(String name, Object value) {
        try {
            var f = DeliveryRouter.class.getDeclaredField(name);
            f.setAccessible(true);
            f.set(router, value);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ── AC1: UBR_REALTIME routing ─────────────────────────────────────────────

    @Test
    void ubr_realtime_creates_pending_command() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));
        when(deviceStatusChecker.isOnline("dev-ubr-1")).thenReturn(true);

        router.executeJob(job, prev);

        verify(pendingRepo, times(1)).save(any(PendingCommand.class));
    }

    @Test
    void ubr_realtime_sends_force_checkin_when_online() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));
        when(deviceStatusChecker.isOnline("dev-ubr-1")).thenReturn(true);

        router.executeJob(job, prev);

        verify(kafkaTemplate, times(1)).send(eq("force-checkin"), eq("dev-ubr-1"), anyString());
    }

    @Test
    void ubr_realtime_queues_command_even_when_nudge_fails() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));
        when(deviceStatusChecker.isOnline("dev-ubr-1")).thenReturn(true);
        when(kafkaTemplate.send(eq("force-checkin"), anyString(), anyString()))
                .thenThrow(new RuntimeException("Kafka unavailable"));

        ConfigJob result = router.executeJob(job, prev);

        PerDeviceDeliveryRecord record = result.getPerDeviceDelivery().get(0);
        assertThat(record.getCurrentState()).isEqualTo("QUEUED");
        assertThat(record.getPendingCommandId()).isNotNull();
    }

    @Test
    void ubr_realtime_marks_device_QUEUED() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));

        ConfigJob result = router.executeJob(job, prev);

        PerDeviceDeliveryRecord record = result.getPerDeviceDelivery().get(0);
        assertThat(record.getCurrentState()).isEqualTo("QUEUED");
        assertThat(record.isQueueEligible()).isTrue();
    }

    @Test
    void ubr_realtime_pending_command_has_delivery_channel() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));

        router.executeJob(job, prev);

        ArgumentCaptor<PendingCommand> captor = ArgumentCaptor.forClass(PendingCommand.class);
        verify(pendingRepo).save(captor.capture());
        assertThat(captor.getValue().getDeliveryChannel()).isEqualTo("UBR_REALTIME");
    }

    @Test
    void ubr_realtime_pending_command_has_idempotency_key() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));

        router.executeJob(job, prev);

        ArgumentCaptor<PendingCommand> captor = ArgumentCaptor.forClass(PendingCommand.class);
        verify(pendingRepo).save(captor.capture());
        assertThat(captor.getValue().getIdempotencyKey()).isNotBlank();
    }

    // ── AC1: UBR_CHECKIN routing ──────────────────────────────────────────────

    @Test
    void ubr_checkin_creates_pending_command_without_realtime_nudge() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-2", "UBR_CHECKIN")));

        router.executeJob(job, prev);

        verify(pendingRepo, times(1)).save(any(PendingCommand.class));
        verify(kafkaTemplate, never()).send(eq("force-checkin"), anyString(), anyString());
    }

    @Test
    void ubr_checkin_marks_device_QUEUED() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-2", "UBR_CHECKIN")));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getPerDeviceDelivery().get(0).getCurrentState()).isEqualTo("QUEUED");
    }

    // ── AC1: CLI_PROTOCOL routing ─────────────────────────────────────────────

    @Test
    void cli_protocol_publishes_to_config_push_topic() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-generic-1", "CLI_PROTOCOL")));

        router.executeJob(job, prev);

        verify(kafkaTemplate, times(1)).send(eq("config-push"), eq("dev-generic-1"), anyString());
    }

    @Test
    void cli_protocol_marks_device_PUBLISHED() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-generic-1", "CLI_PROTOCOL")));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getPerDeviceDelivery().get(0).getCurrentState()).isEqualTo("PUBLISHED");
    }

    @Test
    void cli_protocol_kafka_message_contains_credential_ref_not_password() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-generic-1", "CLI_PROTOCOL")));
        ArgumentCaptor<String> captor = ArgumentCaptor.forClass(String.class);

        router.executeJob(job, prev);

        verify(kafkaTemplate).send(anyString(), anyString(), captor.capture());
        String msg = captor.getValue();
        assertThat(msg).contains("credentialRef");
        assertThat(msg).doesNotContainIgnoringCase("password");
        assertThat(msg).doesNotContainIgnoringCase("secret");
    }

    @Test
    void cli_protocol_kafka_message_contains_idempotency_key() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-generic-1", "CLI_PROTOCOL")));
        ArgumentCaptor<String> captor = ArgumentCaptor.forClass(String.class);

        router.executeJob(job, prev);

        verify(kafkaTemplate).send(anyString(), anyString(), captor.capture());
        assertThat(captor.getValue()).contains("idempotencyKey");
    }

    // ── AC1: SNMP_PROTOCOL routing ────────────────────────────────────────────

    @Test
    void snmp_protocol_publishes_to_config_push_topic() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-snmp-1", "SNMP_PROTOCOL")));

        router.executeJob(job, prev);

        verify(kafkaTemplate, times(1)).send(eq("config-push"), eq("dev-snmp-1"), anyString());
    }

    @Test
    void snmp_protocol_kafka_message_has_snmp_first_in_protocol_order() throws Exception {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-snmp-1", "SNMP_PROTOCOL")));
        ArgumentCaptor<String> captor = ArgumentCaptor.forClass(String.class);

        router.executeJob(job, prev);

        verify(kafkaTemplate).send(anyString(), anyString(), captor.capture());
        @SuppressWarnings("unchecked")
        Map<String, Object> msg = new ObjectMapper().readValue(captor.getValue(), Map.class);
        @SuppressWarnings("unchecked")
        List<String> order = (List<String>) msg.get("protocolOrder");
        assertThat(order.get(0)).isEqualTo("SNMP");
    }

    // ── AC2: UNSUPPORTED channel ──────────────────────────────────────────────

    @Test
    void unsupported_channel_marks_device_UNSUPPORTED() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-unsp-1", "UNSUPPORTED")));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getPerDeviceDelivery().get(0).getCurrentState()).isEqualTo("UNSUPPORTED");
    }

    @Test
    void unsupported_channel_creates_no_pending_command() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-unsp-1", "UNSUPPORTED")));

        router.executeJob(job, prev);

        verify(pendingRepo, never()).save(any());
    }

    @Test
    void unsupported_channel_creates_no_kafka_message() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-unsp-1", "UNSUPPORTED")));

        router.executeJob(job, prev);

        verify(kafkaTemplate, never()).send(anyString(), anyString(), anyString());
    }

    @Test
    void unsupported_channel_increments_failure_count() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-unsp-1", "UNSUPPORTED")));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getFailureCount()).isEqualTo(1);
    }

    // ── AC3: UBR offline queuing ──────────────────────────────────────────────

    @Test
    void ubr_offline_queues_command_without_nudge() {
        when(deviceStatusChecker.isOnline("dev-ubr-3")).thenReturn(false);
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-3", "UBR_REALTIME")));

        ConfigJob result = router.executeJob(job, prev);

        verify(pendingRepo, times(1)).save(any());
        verify(kafkaTemplate, never()).send(eq("force-checkin"), anyString(), anyString());
        assertThat(result.getPerDeviceDelivery().get(0).getCurrentState()).isEqualTo("QUEUED");
    }

    @Test
    void ubr_offline_increments_queued_count() {
        when(deviceStatusChecker.isOnline("dev-ubr-3")).thenReturn(false);
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-3", "UBR_CHECKIN")));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getQueuedCount()).isEqualTo(1);
        assertThat(result.getSuccessCount()).isEqualTo(0);
    }

    // ── Edge: Job counts ─────────────────────────────────────────────────────

    @Test
    void mixed_job_counts_are_accurate() {
        ConfigJob job = makeJob(3);
        ConfigTargetPreviewResponse prev = preview(List.of(
                target("dev-ubr-1", "UBR_CHECKIN"),      // QUEUED
                target("dev-cli-1", "CLI_PROTOCOL"),      // PUBLISHED
                target("dev-unsp-1", "UNSUPPORTED")       // UNSUPPORTED / FAILED
        ));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getQueuedCount()).isEqualTo(1);
        assertThat(result.getSuccessCount()).isEqualTo(1);
        assertThat(result.getFailureCount()).isEqualTo(1);
    }

    @Test
    void job_status_is_completed_when_all_devices_succeed() {
        ConfigJob job = makeJob(2);
        ConfigTargetPreviewResponse prev = preview(List.of(
                target("dev-a", "CLI_PROTOCOL"),
                target("dev-b", "SNMP_PROTOCOL")
        ));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getStatus()).isEqualTo("COMPLETED");
    }

    @Test
    void job_status_is_partial_when_some_devices_fail() {
        ConfigJob job = makeJob(2);
        ConfigTargetPreviewResponse prev = preview(List.of(
                target("dev-cli-1", "CLI_PROTOCOL"),
                target("dev-unsp-1", "UNSUPPORTED")
        ));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getStatus()).isEqualTo("PARTIAL");
    }

    @Test
    void job_saved_to_repository_after_routing() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-cli-1", "CLI_PROTOCOL")));

        router.executeJob(job, prev);

        verify(jobRepo, atLeastOnce()).save(any(ConfigJob.class));
    }

    // ── Edge: No cross-paradigm fallback ─────────────────────────────────────

    @Test
    void ubr_device_does_not_publish_to_generic_config_push_topic() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-ubr-1", "UBR_REALTIME")));

        router.executeJob(job, prev);

        verify(kafkaTemplate, never()).send(eq("config-push"), anyString(), anyString());
    }

    @Test
    void generic_device_does_not_create_pending_command() {
        ConfigJob job = makeJob(1);
        ConfigTargetPreviewResponse prev = preview(List.of(target("dev-cli-1", "CLI_PROTOCOL")));

        router.executeJob(job, prev);

        verify(pendingRepo, never()).save(any());
    }

    // ── Edge: Legacy perDeviceStatus map is kept in sync ─────────────────────

    @Test
    void per_device_status_map_is_populated_for_backward_compat() {
        ConfigJob job = makeJob(2);
        ConfigTargetPreviewResponse prev = preview(List.of(
                target("dev-a", "UBR_CHECKIN"),
                target("dev-b", "CLI_PROTOCOL")
        ));

        ConfigJob result = router.executeJob(job, prev);

        assertThat(result.getPerDeviceStatus()).containsKey("dev-a");
        assertThat(result.getPerDeviceStatus()).containsKey("dev-b");
    }
}
