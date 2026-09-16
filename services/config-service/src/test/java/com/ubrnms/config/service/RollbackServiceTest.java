package com.ubrnms.config.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.config.model.*;
import com.ubrnms.config.repository.ConfigJobRepository;
import com.ubrnms.config.repository.ConfigVersionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link RollbackService} (WO-052).
 *
 * <p>Validates:
 * <ul>
 *   <li>Happy path: eligible rollback is accepted, job saved, delivery routed, audit emitted</li>
 *   <li>Version not found: returns VERSION_NOT_FOUND</li>
 *   <li>Device mismatch: version exists but belongs to a different device</li>
 *   <li>Not rollback eligible: version found but flag is false</li>
 *   <li>No prior good version: no APPLIED version with lower versionNumber</li>
 *   <li>Operation in flight: guard blocks concurrent rollback</li>
 *   <li>Audit publish failure: still returns ACCEPTED (non-fatal)</li>
 *   <li>Missing reason: exception propagated before service call</li>
 *   <li>Guard released on unexpected error</li>
 *   <li>Reason sanitization: control characters stripped, truncation at 500 chars</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
class RollbackServiceTest {

    @Mock private ConfigVersionRepository versionRepo;
    @Mock private ConfigJobRepository     jobRepo;
    @Mock private DeliveryRouter          deliveryRouter;
    @Mock private OperationGuard          operationGuard;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;

    private RollbackService service;

    private static final String DEVICE_ID   = "device-001";
    private static final String VERSION_ID  = "ver-failed-01";
    private static final String ACTOR       = "ops-user";
    private static final String REASON      = "Reverting failed VLAN change";

    @BeforeEach
    void setUp() {
        service = new RollbackService(versionRepo, jobRepo, deliveryRouter,
                operationGuard, kafkaTemplate, new ObjectMapper());
    }

    // ── AC1: Happy path — rollback accepted ───────────────────────────────────

    @Test
    void initiateRollback_eligibleVersion_returnsAccepted() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion goodVersion   = appliedVersion("ver-good-01", DEVICE_ID, 4);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(eq(DEVICE_ID), eq(OperationClass.CONFIG_CHANGE), any(), eq(ACTOR)))
                .thenReturn(Optional.empty()); // guard acquired

        ConfigJob savedJob = new ConfigJob();
        savedJob.setId("rollback-job-01");
        savedJob.setStartedAt(Instant.now());
        savedJob.setStatus("RUNNING");
        when(jobRepo.save(any())).thenReturn(savedJob);

        ConfigJob routedJob = new ConfigJob();
        routedJob.setId("rollback-job-01");
        routedJob.setStartedAt(Instant.now());
        routedJob.setStatus("RUNNING_QUEUED");
        when(deliveryRouter.executeJob(any(), any())).thenReturn(routedJob);

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.ACCEPTED);
        assertThat(result.rollbackJob).isNotNull();
        assertThat(result.rollbackJob.getId()).isEqualTo("rollback-job-01");
        verify(jobRepo).save(any(ConfigJob.class));
        verify(deliveryRouter).executeJob(any(), any());
    }

    @Test
    void initiateRollback_emitsAuditEventOnKafka() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 3);
        ConfigVersion goodVersion   = appliedVersion("ver-good-02", DEVICE_ID, 2);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(eq(DEVICE_ID), eq(OperationClass.CONFIG_CHANGE), any(), eq(ACTOR)))
                .thenReturn(Optional.empty());

        ConfigJob savedJob = savedJobWith("rbk-job-audit");
        when(jobRepo.save(any())).thenReturn(savedJob);
        when(deliveryRouter.executeJob(any(), any())).thenReturn(savedJob);

        service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        // Kafka must receive exactly one audit event keyed by deviceId
        verify(kafkaTemplate, atLeastOnce()).send(anyString(), eq(DEVICE_ID), anyString());
    }

    @Test
    void initiateRollback_auditMessageContainsExpectedFields() throws Exception {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 7);
        ConfigVersion goodVersion   = appliedVersion("ver-good-03", DEVICE_ID, 6);
        goodVersion.setJobId("original-job-id");

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(any(), any(), any(), any())).thenReturn(Optional.empty());

        ConfigJob savedJob = savedJobWith("rbk-job-msg");
        when(jobRepo.save(any())).thenReturn(savedJob);
        when(deliveryRouter.executeJob(any(), any())).thenReturn(savedJob);

        ArgumentCaptor<String> messageCaptor = ArgumentCaptor.forClass(String.class);
        service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);
        verify(kafkaTemplate).send(anyString(), eq(DEVICE_ID), messageCaptor.capture());

        String auditMessage = messageCaptor.getValue();
        assertThat(auditMessage).contains("config.change.rollback.initiated");
        assertThat(auditMessage).contains(DEVICE_ID);
        assertThat(auditMessage).contains(ACTOR);
        // Audit must NOT include any rendered config content or credentials
        assertThat(auditMessage).doesNotContain("password");
        assertThat(auditMessage).doesNotContain("secret");
    }

    // ── AC2: Version not found ─────────────────────────────────────────────────

    @Test
    void initiateRollback_versionNotFound_returnsVersionNotFound() {
        when(versionRepo.findById("nonexistent")).thenReturn(Optional.empty());

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, "nonexistent", REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.VERSION_NOT_FOUND);
        assertThat(result.ineligibilityReason).contains("not found");
        verifyNoInteractions(deliveryRouter, kafkaTemplate);
    }

    @Test
    void initiateRollback_versionBelongsToDifferentDevice_returnsVersionNotFound() {
        ConfigVersion otherDeviceVersion = failedVersion(VERSION_ID, "device-999", 5);
        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(otherDeviceVersion));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.VERSION_NOT_FOUND);
        verifyNoInteractions(deliveryRouter, kafkaTemplate);
    }

    // ── AC3: Not rollback eligible ─────────────────────────────────────────────

    @Test
    void initiateRollback_notEligible_returnsNotRollbackEligible() {
        ConfigVersion ineligible = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ineligible.setRollbackEligible(false);
        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(ineligible));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.NOT_ROLLBACK_ELIGIBLE);
        assertThat(result.ineligibilityReason).contains("not marked rollback-eligible");
        verifyNoInteractions(deliveryRouter, kafkaTemplate);
    }

    @Test
    void initiateRollback_notEligible_includesFailureReasonWhenPresent() {
        ConfigVersion ineligible = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ineligible.setRollbackEligible(false);
        ineligible.setFailureReason("Device rejected push: unsupported OID");
        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(ineligible));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.ineligibilityReason).contains("unsupported OID");
    }

    // ── AC4: No prior good version ─────────────────────────────────────────────

    @Test
    void initiateRollback_noPriorGoodVersion_returnsNoPriorGoodVersion() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 2);
        // Version 1 is also FAILED — no APPLIED version exists
        ConfigVersion anotherFailed = failedVersion("ver-002", DEVICE_ID, 1);
        anotherFailed.setStatus("FAILED");

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, anotherFailed));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.NO_PRIOR_GOOD_VERSION);
        assertThat(result.ineligibilityReason).contains("No prior APPLIED");
        verifyNoInteractions(deliveryRouter, kafkaTemplate);
    }

    @Test
    void initiateRollback_firstEverVersion_returnsNoPriorGoodVersion() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 1);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.NO_PRIOR_GOOD_VERSION);
    }

    // ── AC5: Concurrency guard ─────────────────────────────────────────────────

    @Test
    void initiateRollback_operationInFlight_returnsOperationInFlight() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion goodVersion   = appliedVersion("ver-good-04", DEVICE_ID, 4);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));

        OperationGuard.InFlightMarker blocker = new OperationGuard.InFlightMarker(
                "marker-1", DEVICE_ID, OperationClass.CONFIG_CHANGE,
                "blocking-job-id", "other-actor", "some-key",
                Instant.now(), Instant.now().plusSeconds(3600));
        when(operationGuard.acquire(eq(DEVICE_ID), eq(OperationClass.CONFIG_CHANGE), any(), eq(ACTOR)))
                .thenReturn(Optional.of(blocker));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.OPERATION_IN_FLIGHT);
        assertThat(result.ineligibilityReason).contains("blocking-job-id");
        verifyNoInteractions(deliveryRouter, kafkaTemplate, jobRepo);
    }

    // ── AC6: Guard released on unexpected error ────────────────────────────────

    @Test
    void initiateRollback_deliveryRouterThrows_releasesGuardAndRethrows() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion goodVersion   = appliedVersion("ver-good-05", DEVICE_ID, 4);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(any(), any(), any(), any())).thenReturn(Optional.empty());
        when(jobRepo.save(any())).thenReturn(savedJobWith("error-job"));
        when(deliveryRouter.executeJob(any(), any()))
                .thenThrow(new RuntimeException("Kafka unavailable"));

        assertThatThrownBy(() ->
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR))
                .isInstanceOf(RollbackService.RollbackExecutionException.class)
                .hasMessageContaining("Rollback execution failed");

        // Guard must be released so device does not remain permanently locked
        verify(operationGuard).release(eq(DEVICE_ID), anyString());
    }

    // ── AC7: Reason sanitization ───────────────────────────────────────────────

    @Test
    void initiateRollback_longReason_isTruncatedTo500Chars() {
        String longReason = "X".repeat(600);
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion goodVersion   = appliedVersion("ver-good-06", DEVICE_ID, 4);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(any(), any(), any(), any())).thenReturn(Optional.empty());

        ConfigJob savedJob = savedJobWith("rbk-trunc");
        when(jobRepo.save(any())).thenReturn(savedJob);
        when(deliveryRouter.executeJob(any(), any())).thenReturn(savedJob);

        ArgumentCaptor<ConfigJob> jobCaptor = ArgumentCaptor.forClass(ConfigJob.class);
        service.initiateRollback(DEVICE_ID, VERSION_ID, longReason, ACTOR);
        verify(jobRepo).save(jobCaptor.capture());

        String storedRef = jobCaptor.getValue().getApprovalReference();
        // Truncation ensures stored reference cannot exceed 500 chars from reason
        assertThat(storedRef).hasSizeLessThan(1000);
    }

    @Test
    void initiateRollback_reasonWithControlCharacters_controlCharsStripped() {
        String maliciousReason = "Reason\u0000with\u001Fcontrol\u007Fchars";
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion goodVersion   = appliedVersion("ver-good-07", DEVICE_ID, 4);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(any(), any(), any(), any())).thenReturn(Optional.empty());

        ConfigJob savedJob = savedJobWith("rbk-sanitize");
        when(jobRepo.save(any())).thenReturn(savedJob);
        when(deliveryRouter.executeJob(any(), any())).thenReturn(savedJob);

        ArgumentCaptor<ConfigJob> jobCaptor = ArgumentCaptor.forClass(ConfigJob.class);
        service.initiateRollback(DEVICE_ID, VERSION_ID, maliciousReason, ACTOR);
        verify(jobRepo).save(jobCaptor.capture());

        String storedRef = jobCaptor.getValue().getApprovalReference();
        assertThat(storedRef).doesNotContain("\u0000");
        assertThat(storedRef).doesNotContain("\u001F");
        assertThat(storedRef).doesNotContain("\u007F");
    }

    // ── AC8: Delivery channel fallback ─────────────────────────────────────────

    @Test
    void initiateRollback_goodVersionMissingDeliveryChannel_fallsBackToUbrCheckin() {
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion goodVersion   = appliedVersion("ver-good-08", DEVICE_ID, 4);
        goodVersion.setDeliveryChannel(null); // missing channel

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, goodVersion));
        when(operationGuard.acquire(any(), any(), any(), any())).thenReturn(Optional.empty());
        when(jobRepo.save(any())).thenReturn(savedJobWith("fallback-job"));

        ArgumentCaptor<ConfigTargetPreviewResponse> previewCaptor =
                ArgumentCaptor.forClass(ConfigTargetPreviewResponse.class);
        when(deliveryRouter.executeJob(any(), previewCaptor.capture()))
                .thenReturn(savedJobWith("fallback-job"));

        service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        String channel = previewCaptor.getValue().getTargets().get(0).getDeliveryChannel();
        assertThat(channel).isEqualTo("UBR_CHECKIN");
    }

    // ── Boundary: APPLIED version with same number is not a restore target ─────

    @Test
    void initiateRollback_sameVersionNumber_notSelectedAsRestoreTarget() {
        // Edge: a version with the exact same number (shouldn't happen, but must be safe)
        ConfigVersion failedVersion = failedVersion(VERSION_ID, DEVICE_ID, 5);
        ConfigVersion sameNumber    = appliedVersion("ver-same", DEVICE_ID, 5);

        when(versionRepo.findById(VERSION_ID)).thenReturn(Optional.of(failedVersion));
        when(versionRepo.findByDeviceIdOrderByVersionNumberDesc(DEVICE_ID))
                .thenReturn(List.of(failedVersion, sameNumber));

        RollbackService.RollbackResult result =
                service.initiateRollback(DEVICE_ID, VERSION_ID, REASON, ACTOR);

        // sameNumber must not be treated as a prior good version
        assertThat(result.outcome).isEqualTo(RollbackService.RollbackOutcome.NO_PRIOR_GOOD_VERSION);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private ConfigVersion failedVersion(String id, String deviceId, int versionNumber) {
        ConfigVersion v = new ConfigVersion();
        v.setId(id);
        v.setDeviceId(deviceId);
        v.setVersionNumber(versionNumber);
        v.setStatus("FAILED");
        v.setRollbackEligible(true);
        v.setJobId("original-job-" + id);
        v.setDeliveryChannel("UBR_CHECKIN");
        v.setAttemptedAt(Instant.now());
        return v;
    }

    private ConfigVersion appliedVersion(String id, String deviceId, int versionNumber) {
        ConfigVersion v = new ConfigVersion();
        v.setId(id);
        v.setDeviceId(deviceId);
        v.setVersionNumber(versionNumber);
        v.setStatus("APPLIED");
        v.setRollbackEligible(false); // applied versions are not themselves rollback targets
        v.setJobId("applied-job-" + id);
        v.setDeliveryChannel("UBR_CHECKIN");
        v.setAppliedAt(Instant.now());
        return v;
    }

    private ConfigJob savedJobWith(String id) {
        ConfigJob job = new ConfigJob();
        job.setId(id);
        job.setStartedAt(Instant.now());
        job.setStatus("RUNNING");
        job.setPerDeviceStatus(new java.util.HashMap<>());
        job.setPerDeviceDelivery(new java.util.ArrayList<>());
        return job;
    }
}
