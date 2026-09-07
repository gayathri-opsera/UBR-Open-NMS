package com.ubrnms.config.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link ConfigService} focusing on WO-033 delivery eligibility gate.
 */
@ExtendWith(MockitoExtension.class)
class ConfigServiceDeliveryGateTest {

    @Mock ConfigTemplateRepository templateRepo;
    @Mock PendingCommandRepository pendingRepo;
    @Mock ConfigVersionRepository versionRepo;
    @Mock ConfigJobRepository jobRepo;
    @Mock KafkaTemplate<String, String> kafkaTemplate;
    @Mock DeviceStatusChecker statusChecker;
    @Mock DeviceEligibilityChecker eligibilityChecker;
    @Mock OperationGuard operationGuard;
    @Mock PreviewStoreService previewStoreService;
    @Mock DeliveryRouter deliveryRouter;
    @Mock ConfigDiffSanitizer configDiffSanitizer;

    private ConfigService service;

    @BeforeEach
    void setup() throws Exception {
        service = new ConfigService(templateRepo, pendingRepo, versionRepo, jobRepo,
                kafkaTemplate, new ObjectMapper(), statusChecker, eligibilityChecker, operationGuard,
                previewStoreService, deliveryRouter, configDiffSanitizer);
        setField(service, "configPushTopic", "config-push");
        setField(service, "ttlHours", 72);
    }

    // ── pushConfig: PENDING_ASSIGNMENT blocks delivery ────────────────────────

    @Test
    void pushConfig_returnsDeliveryWithheld_whenDeviceIsPendingAssignment() {
        when(eligibilityChecker.checkEligibility("dev-1"))
            .thenReturn(DeviceEligibilityChecker.IneligibilityReason.PENDING_ASSIGNMENT);

        ConfigService.PushResult result = service.pushConfig("dev-1", "tmpl-1", "actor", false);

        assertThat(result.type).isEqualTo(ConfigService.PushResult.Type.DELIVERY_WITHHELD);
        assertThat(result.withheldReason).isEqualTo("PENDING_ASSIGNMENT");
        verify(statusChecker, never()).isOnline(any());
        verify(kafkaTemplate, never()).send(any(), any(), any());
    }

    @Test
    void pushConfig_returnsDeliveryWithheld_whenDeviceIsConfigWithheld() {
        when(eligibilityChecker.checkEligibility("dev-2"))
            .thenReturn(DeviceEligibilityChecker.IneligibilityReason.CONFIG_WITHHELD);

        ConfigService.PushResult result = service.pushConfig("dev-2", "tmpl-1", "actor", false);

        assertThat(result.type).isEqualTo(ConfigService.PushResult.Type.DELIVERY_WITHHELD);
        assertThat(result.withheldReason).isEqualTo("CONFIG_WITHHELD");
        verify(statusChecker, never()).isOnline(any());
    }

    @Test
    void pushConfig_proceeds_whenDeviceIsEligible() {
        when(eligibilityChecker.checkEligibility("dev-3")).thenReturn(null);
        when(operationGuard.acquire(any(), any(), any(), any())).thenReturn(java.util.Optional.empty());
        when(statusChecker.isOnline("dev-3")).thenReturn(true);
        when(versionRepo.countByDeviceId("dev-3")).thenReturn(0);

        ConfigService.PushResult result = service.pushConfig("dev-3", "tmpl-1", "actor", false);

        assertThat(result.type).isEqualTo(ConfigService.PushResult.Type.PUBLISHED);
        verify(kafkaTemplate).send(eq("config-push"), eq("dev-3"), any());
    }

    // ── bulkPush: PENDING_ASSIGNMENT skips the device ─────────────────────────

    @Test
    void bulkPush_skipsDevice_whenPendingAssignment() {
        String eligibleId = "dev-eligible";
        String pendingId = "dev-pending";

        when(eligibilityChecker.checkEligibility(eligibleId)).thenReturn(null);
        when(eligibilityChecker.checkEligibility(pendingId))
            .thenReturn(DeviceEligibilityChecker.IneligibilityReason.PENDING_ASSIGNMENT);
        when(operationGuard.acquire(eq(eligibleId), any(), any(), any()))
            .thenReturn(java.util.Optional.empty());
        when(operationGuard.acquire(eq(pendingId), any(), any(), any()))
            .thenReturn(java.util.Optional.empty());
        when(statusChecker.isOnline(eligibleId)).thenReturn(true);
        when(versionRepo.countByDeviceId(eligibleId)).thenReturn(0);

        ConfigJob job = new ConfigJob();
        job.setId("job-1");
        when(jobRepo.save(any())).thenAnswer(inv -> {
            ConfigJob j = inv.getArgument(0);
            if (j.getId() == null) j.setId("job-1");
            return j;
        });

        ConfigJob result = service.bulkPush(List.of(eligibleId, pendingId), "tmpl-1", "actor");

        assertThat(result.getPerDeviceStatus().get(eligibleId)).isEqualTo("PUBLISHED");
        assertThat(result.getPerDeviceStatus().get(pendingId))
            .startsWith("WITHHELD:PENDING_ASSIGNMENT");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static void setField(Object target, String name, Object value) throws Exception {
        Class<?> cls = target.getClass();
        while (cls != null) {
            try {
                var f = cls.getDeclaredField(name);
                f.setAccessible(true);
                f.set(target, value);
                return;
            } catch (NoSuchFieldException e) {
                cls = cls.getSuperclass();
            }
        }
        throw new NoSuchFieldException(name);
    }
}
