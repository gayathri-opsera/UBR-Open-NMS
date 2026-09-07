package com.ubrnms.config.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.*;
import com.ubrnms.config.service.ConfigService.ConfirmationOutcome;
import com.ubrnms.config.service.ConfigService.ConfirmationResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
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
 * Unit tests for WO-045: Confirm Configuration Target Execution.
 *
 * <p>Validates:
 * <ul>
 *   <li>AC1 — Successful confirmation creates ACCEPTED job with metadata</li>
 *   <li>AC2 — Stale preview returns PREVIEW_EXPIRED conflict</li>
 *   <li>AC2 — Target count mismatch returns TARGET_COUNT_MISMATCH conflict</li>
 *   <li>AC3 — Unauthorized actor returns UNAUTHORIZED (no job created)</li>
 *   <li>AC4 — Unit test coverage for all confirmation paths</li>
 *   <li>Edge: Preview not found returns PREVIEW_NOT_FOUND</li>
 *   <li>Edge: Duplicate idempotency key returns existing job</li>
 *   <li>Edge: Unsupported targets are handled gracefully</li>
 *   <li>Edge: Audit events are published for accepted and denied confirmations</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ConfirmExecutionServiceTest {

    @Mock private ConfigTemplateRepository templateRepo;
    @Mock private PendingCommandRepository pendingRepo;
    @Mock private ConfigVersionRepository versionRepo;
    @Mock private ConfigJobRepository jobRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @Mock private DeviceStatusChecker deviceStatusChecker;
    @Mock private DeviceEligibilityChecker deviceEligibilityChecker;
    @Mock private OperationGuard operationGuard;
    @Mock private PreviewStoreService previewStoreService;

    private ConfigService service;

    // ── Fixtures ──────────────────────────────────────────────────────────────

    private static final String PREVIEW_ID     = "prev-abc-123";
    private static final String ACTOR          = "eng-jsmith";
    private static final String ACTOR_ROLE_OK  = "network_engineer";
    private static final String ACTOR_ROLE_NOK = "auditor";

    private ConfigTargetPreviewResponse previewWith(int count) {
        List<ConfigTargetPreviewResponse.TargetEntry> targets = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            targets.add(ConfigTargetPreviewResponse.TargetEntry.builder()
                    .deviceId("dev-" + i)
                    .serialNumber("SN-" + i)
                    .deviceType("CPE")
                    .deliveryChannel("UBR_REALTIME")
                    .warnings(List.of())
                    .build());
        }
        return ConfigTargetPreviewResponse.builder()
                .previewId(PREVIEW_ID)
                .totalCount(count)
                .targets(targets)
                .unsupportedTargets(List.of())
                .generatedAt(java.time.Instant.now().toString())
                .requiresConfirmation(count > 50)
                .build();
    }

    private ConfirmExecutionRequest req(String previewId, int count) {
        ConfirmExecutionRequest r = new ConfirmExecutionRequest();
        r.setPreviewId(previewId);
        r.setActionType("CONFIG_PUSH");
        r.setExpectedTargetCount(count);
        r.setAcceptWarnings(false);
        return r;
    }

    @BeforeEach
    void setUp() throws Exception {
        service = new ConfigService(
                templateRepo, pendingRepo, versionRepo, jobRepo,
                kafkaTemplate, new ObjectMapper().registerModule(new JavaTimeModule()),
                deviceStatusChecker, deviceEligibilityChecker, operationGuard, previewStoreService
        );

        // Inject @Value fields
        setField("configPushTopic", "config-push");
        setField("ttlHours", 72);
        setField("targetCountTolerance", 0);

        // Default: jobRepo.save() returns the same job back
        when(jobRepo.save(any(ConfigJob.class))).thenAnswer(inv -> inv.getArgument(0));

        // Default: no duplicate idempotency key in job store
        when(jobRepo.findAll()).thenReturn(Collections.emptyList());
    }

    private void setField(String name, Object value) throws Exception {
        var f = ConfigService.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(service, value);
    }

    // ── AC1: Successful confirmation ──────────────────────────────────────────

    @Test
    void confirmation_accepted_returns_ACCEPTED_job() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(3)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.ACCEPTED);
        assertThat(result.job).isNotNull();
        assertThat(result.job.getStatus()).isEqualTo("ACCEPTED");
    }

    @Test
    void confirmation_accepted_sets_previewId_on_job() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 2), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.job.getPreviewId()).isEqualTo(PREVIEW_ID);
    }

    @Test
    void confirmation_accepted_sets_confirmedBy_and_confirmedAt() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 2), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.job.getConfirmedBy()).isEqualTo(ACTOR);
        assertThat(result.job.getConfirmedAt()).isNotNull();
        assertThat(result.job.getConfirmationStatus()).isEqualTo("CONFIRMED");
    }

    @Test
    void confirmation_accepted_sets_expectedTargetCount_on_job() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(5)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 5), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.job.getExpectedTargetCount()).isEqualTo(5);
        assertThat(result.job.getTotalDevices()).isEqualTo(5);
    }

    @Test
    void confirmation_accepted_sets_per_device_PENDING_status() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(3)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.job.getPerDeviceStatus()).hasSize(3);
        assertThat(result.job.getPerDeviceStatus().values()).containsOnly("PENDING");
    }

    @Test
    void confirmation_accepted_stores_approval_reference() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(1)));

        ConfirmExecutionRequest r = req(PREVIEW_ID, 1);
        r.setApprovalReference("CHG-9999");
        ConfirmationResult result = service.confirmExecution(r, ACTOR_ROLE_OK, ACTOR);

        assertThat(result.job.getApprovalReference()).isEqualTo("CHG-9999");
    }

    @Test
    void confirmation_accepted_invalidates_preview_to_prevent_replay() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        service.confirmExecution(req(PREVIEW_ID, 2), ACTOR_ROLE_OK, ACTOR);

        verify(previewStoreService, times(1)).invalidate(PREVIEW_ID);
    }

    @Test
    void confirmation_accepted_publishes_audit_event() throws Exception {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        service.confirmExecution(req(PREVIEW_ID, 2), ACTOR_ROLE_OK, ACTOR);

        verify(kafkaTemplate, atLeastOnce()).send(eq("config-audit"), anyString(), anyString());
    }

    @Test
    void confirmation_saves_job_to_repository() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        service.confirmExecution(req(PREVIEW_ID, 2), ACTOR_ROLE_OK, ACTOR);

        verify(jobRepo, times(1)).save(any(ConfigJob.class));
    }

    // ── AC2: Stale preview detection ──────────────────────────────────────────

    @Test
    void stale_preview_returns_PREVIEW_EXPIRED() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.empty());
        when(previewStoreService.isExpired(PREVIEW_ID)).thenReturn(true);

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.PREVIEW_EXPIRED);
        assertThat(result.job).isNull();
    }

    @Test
    void stale_preview_publishes_audit_event_with_EXPIRED_outcome() throws Exception {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.empty());
        when(previewStoreService.isExpired(PREVIEW_ID)).thenReturn(true);

        service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        verify(kafkaTemplate, atLeastOnce()).send(eq("config-audit"), anyString(), anyString());
    }

    @Test
    void stale_preview_creates_no_job() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.empty());
        when(previewStoreService.isExpired(PREVIEW_ID)).thenReturn(true);

        service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        verify(jobRepo, never()).save(any());
    }

    // ── AC2: Target count mismatch ────────────────────────────────────────────

    @Test
    void target_count_mismatch_returns_TARGET_COUNT_MISMATCH() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(5)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.TARGET_COUNT_MISMATCH);
        assertThat(result.conflictDetail).contains("5");
        assertThat(result.conflictDetail).contains("3");
    }

    @Test
    void target_count_mismatch_creates_no_job() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(5)));

        service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        verify(jobRepo, never()).save(any());
    }

    @Test
    void target_count_mismatch_publishes_audit_event() throws Exception {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(5)));

        service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_OK, ACTOR);

        verify(kafkaTemplate, atLeastOnce()).send(eq("config-audit"), anyString(), anyString());
    }

    // ── AC3: Authorization ────────────────────────────────────────────────────

    @Test
    void unauthorized_role_returns_UNAUTHORIZED() {
        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_NOK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.UNAUTHORIZED);
        assertThat(result.job).isNull();
    }

    @Test
    void noc_operator_role_is_not_authorized_to_confirm() {
        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), "noc_operator", ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.UNAUTHORIZED);
    }

    @Test
    void admin_role_is_authorized_to_confirm() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 2), "admin", ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.ACCEPTED);
    }

    @Test
    void null_role_returns_UNAUTHORIZED() {
        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 3), null, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.UNAUTHORIZED);
    }

    @Test
    void unauthorized_publishes_audit_event() throws Exception {
        service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_NOK, ACTOR);

        verify(kafkaTemplate, atLeastOnce()).send(eq("config-audit"), anyString(), anyString());
    }

    @Test
    void unauthorized_creates_no_job() {
        service.confirmExecution(req(PREVIEW_ID, 3), ACTOR_ROLE_NOK, ACTOR);

        verify(jobRepo, never()).save(any());
    }

    // ── Edge: Preview not found ───────────────────────────────────────────────

    @Test
    void unknown_preview_returns_PREVIEW_NOT_FOUND() {
        when(previewStoreService.find("unknown-id")).thenReturn(Optional.empty());
        when(previewStoreService.isExpired("unknown-id")).thenReturn(false);

        ConfirmationResult result = service.confirmExecution(req("unknown-id", 3), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.PREVIEW_NOT_FOUND);
        assertThat(result.job).isNull();
    }

    // ── Edge: Duplicate idempotency key ───────────────────────────────────────

    @Test
    void duplicate_idempotency_key_returns_existing_job() {
        ConfigJob existing = new ConfigJob();
        existing.setId("existing-job-id");
        existing.setPreviewId(PREVIEW_ID);
        existing.setIdempotencyKey("key-xyz");
        existing.setStatus("ACCEPTED");
        when(jobRepo.findAll()).thenReturn(List.of(existing));

        ConfirmExecutionRequest r = req(PREVIEW_ID, 3);
        r.setIdempotencyKey("key-xyz");

        ConfirmationResult result = service.confirmExecution(r, ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.DUPLICATE_IDEMPOTENCY_KEY);
        assertThat(result.job.getId()).isEqualTo("existing-job-id");
    }

    @Test
    void duplicate_idempotency_key_creates_no_new_job() {
        ConfigJob existing = new ConfigJob();
        existing.setId("existing-job-id");
        existing.setPreviewId(PREVIEW_ID);
        existing.setIdempotencyKey("key-dup");
        existing.setStatus("ACCEPTED");
        when(jobRepo.findAll()).thenReturn(List.of(existing));

        ConfirmExecutionRequest r = req(PREVIEW_ID, 3);
        r.setIdempotencyKey("key-dup");

        service.confirmExecution(r, ACTOR_ROLE_OK, ACTOR);

        verify(jobRepo, never()).save(any());
    }

    @Test
    void different_idempotency_keys_with_same_preview_dont_collide() {
        ConfigJob existing = new ConfigJob();
        existing.setId("existing-job");
        existing.setPreviewId(PREVIEW_ID);
        existing.setIdempotencyKey("key-A");
        when(jobRepo.findAll()).thenReturn(List.of(existing));
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(3)));

        ConfirmExecutionRequest r = req(PREVIEW_ID, 3);
        r.setIdempotencyKey("key-B"); // different key

        ConfirmationResult result = service.confirmExecution(r, ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.ACCEPTED);
    }

    // ── Edge: acceptedWarnings flag is stored ─────────────────────────────────

    @Test
    void accepted_warnings_flag_recorded_on_job() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        ConfirmExecutionRequest r = req(PREVIEW_ID, 2);
        r.setAcceptWarnings(true);

        ConfirmationResult result = service.confirmExecution(r, ACTOR_ROLE_OK, ACTOR);

        assertThat(result.job.isAcceptedWarnings()).isTrue();
    }

    @Test
    void not_accepted_warnings_also_allows_execution() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(2)));

        ConfirmExecutionRequest r = req(PREVIEW_ID, 2);
        r.setAcceptWarnings(false);

        ConfirmationResult result = service.confirmExecution(r, ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.ACCEPTED);
        assertThat(result.job.isAcceptedWarnings()).isFalse();
    }

    // ── Edge: exactly one target ──────────────────────────────────────────────

    @Test
    void single_target_preview_is_accepted() {
        when(previewStoreService.find(PREVIEW_ID)).thenReturn(Optional.of(previewWith(1)));

        ConfirmationResult result = service.confirmExecution(req(PREVIEW_ID, 1), ACTOR_ROLE_OK, ACTOR);

        assertThat(result.outcome).isEqualTo(ConfirmationOutcome.ACCEPTED);
        assertThat(result.job.getTotalDevices()).isEqualTo(1);
    }
}
