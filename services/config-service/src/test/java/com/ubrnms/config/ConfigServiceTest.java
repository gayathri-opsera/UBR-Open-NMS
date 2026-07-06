package com.ubrnms.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.*;
import com.ubrnms.config.service.ConfigService;
import com.ubrnms.config.service.DeviceStatusChecker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.kafka.core.KafkaTemplate;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ConfigServiceTest {

    @Mock private ConfigTemplateRepository templateRepo;
    @Mock private PendingCommandRepository pendingRepo;
    @Mock private ConfigVersionRepository versionRepo;
    @Mock private ConfigJobRepository jobRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @Mock private DeviceStatusChecker deviceStatusChecker;
    @InjectMocks private ConfigService service;

    @BeforeEach
    void injectFields() throws Exception {
        var f = ConfigService.class.getDeclaredField("objectMapper");
        f.setAccessible(true); f.set(service, new ObjectMapper().registerModule(new JavaTimeModule()));
        var t = ConfigService.class.getDeclaredField("configPushTopic");
        t.setAccessible(true); t.set(service, "config-push");
        var h = ConfigService.class.getDeclaredField("ttlHours");
        h.setAccessible(true); h.set(service, 72);
    }

    // ── Template CRUD ──────────────────────────────────────────────

    @Test
    void createTemplate_savesAndReturns() {
        ConfigTemplate t = new ConfigTemplate();
        t.setName("default-bts"); t.setDeviceType("BTS");
        when(templateRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ConfigTemplate result = service.createTemplate(t);
        assertThat(result.getName()).isEqualTo("default-bts");
        assertThat(result.getCreatedAt()).isNotNull();
        verify(templateRepo).save(any());
    }

    @Test
    void setDefault_clearsOldDefault() {
        ConfigTemplate oldDefault = new ConfigTemplate();
        oldDefault.setId("old"); oldDefault.setDefault(true);

        ConfigTemplate newTemplate = new ConfigTemplate();
        newTemplate.setId("new"); newTemplate.setDefault(false);

        when(templateRepo.findByIsDefaultTrue()).thenReturn(Optional.of(oldDefault));
        when(templateRepo.findById("new")).thenReturn(Optional.of(newTemplate));
        when(templateRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ConfigTemplate result = service.setDefault("new");
        assertThat(result.isDefault()).isTrue();
        assertThat(oldDefault.isDefault()).isFalse();
        verify(templateRepo, times(2)).save(any());
    }

    // ── Offline command policy ─────────────────────────────────────

    @Test
    void pushConfig_offlineDeviceIndividualCommand_returnsDeviceOffline() {
        when(deviceStatusChecker.isOnline("offline-dev")).thenReturn(false);

        ConfigService.PushResult result = service.pushConfig("offline-dev", "t1", "admin", false);
        assertThat(result.type).isEqualTo(ConfigService.PushResult.Type.DEVICE_OFFLINE);
        verify(pendingRepo, never()).save(any());
    }

    @Test
    void pushConfig_offlineDeviceFirmwareUpgrade_queuesCommand() {
        when(deviceStatusChecker.isOnline("offline-dev")).thenReturn(false);
        PendingCommand cmd = new PendingCommand();
        cmd.setId("cmd-1");
        when(pendingRepo.save(any())).thenReturn(cmd);

        ConfigService.PushResult result = service.pushConfig("offline-dev", "t1", "admin", true);
        assertThat(result.type).isEqualTo(ConfigService.PushResult.Type.QUEUED);
        assertThat(result.queuedCommandId).isEqualTo("cmd-1");
        verify(pendingRepo).save(any());
    }

    @Test
    void pushConfig_onlineDevice_publishesAndRecordsVersion() {
        when(deviceStatusChecker.isOnline("online-dev")).thenReturn(true);
        when(versionRepo.countByDeviceId("online-dev")).thenReturn(2);
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ConfigService.PushResult result = service.pushConfig("online-dev", "t1", "admin", false);
        assertThat(result.type).isEqualTo(ConfigService.PushResult.Type.PUBLISHED);
        verify(kafkaTemplate).send(eq("config-push"), eq("online-dev"), anyString());
        verify(versionRepo).save(argThat(v -> v.getVersionNumber() == 3));
    }

    // ── TTL expiration ─────────────────────────────────────────────

    @Test
    void expireStaleCommands_marksExpiredCommands() {
        PendingCommand stale = new PendingCommand();
        stale.setId("s1"); stale.setStatus("PENDING");
        stale.setExpiresAt(Instant.now().minus(1, ChronoUnit.HOURS));

        when(pendingRepo.findByStatusAndExpiresAtBefore(eq("PENDING"), any()))
                .thenReturn(List.of(stale));
        when(pendingRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        service.expireStaleCommands();
        assertThat(stale.getStatus()).isEqualTo("EXPIRED");
        verify(pendingRepo).save(stale);
    }

    // ── Version history ────────────────────────────────────────────

    @Test
    void getVersionHistory_returnsSortedVersions() {
        ConfigVersion v1 = new ConfigVersion(); v1.setVersionNumber(1);
        ConfigVersion v2 = new ConfigVersion(); v2.setVersionNumber(2);
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc("dev-x"))
                .thenReturn(List.of(v2, v1));

        List<ConfigVersion> history = service.getVersionHistory("dev-x");
        assertThat(history).hasSize(2);
        assertThat(history.get(0).getVersionNumber()).isEqualTo(2);
    }

    // ── Bulk job tracking ──────────────────────────────────────────

    @Test
    void bulkPush_tracksProgressCorrectly() {
        when(deviceStatusChecker.isOnline("dev-online")).thenReturn(true);
        when(deviceStatusChecker.isOnline("dev-offline")).thenReturn(false);
        when(versionRepo.countByDeviceId(any())).thenReturn(0);
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(pendingRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(jobRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ConfigJob job = service.bulkPush(List.of("dev-online", "dev-offline"), "t1", "admin");
        assertThat(job.getTotalDevices()).isEqualTo(2);
        assertThat(job.getSuccessCount()).isEqualTo(1);
        assertThat(job.getPerDeviceStatus().get("dev-online")).isEqualTo("PUBLISHED");
        assertThat(job.getPerDeviceStatus().get("dev-offline")).isEqualTo("QUEUED");
        assertThat(job.getStatus()).isEqualTo("PARTIAL");
    }
}
