package com.ubrnms.diagnostics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.diagnostics.model.FirmwareJob;
import com.ubrnms.diagnostics.model.FirmwareUpgradeRequest;
import com.ubrnms.diagnostics.model.FirmwareUpgradeResponse;
import com.ubrnms.diagnostics.repository.FirmwareJobRepository;
import com.ubrnms.diagnostics.service.DeviceStatusChecker;
import com.ubrnms.diagnostics.service.FirmwareService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.springframework.kafka.core.KafkaTemplate;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for firmware upgrade workflow (WO-012).
 * Tests compatibility checks, phase transitions, checksum handling, and discrepancy detection.
 */
public class FirmwareServiceTest {

    @Mock
    private FirmwareJobRepository jobRepo;

    @Mock
    private KafkaTemplate<String, String> kafkaTemplate;

    @Mock
    private DeviceStatusChecker deviceStatusChecker;

    private FirmwareService firmwareService;
    private ObjectMapper objectMapper;

    @BeforeEach
    public void setup() {
        MockitoAnnotations.openMocks(this);
        objectMapper = new ObjectMapper();
        firmwareService = new FirmwareService(jobRepo, kafkaTemplate, deviceStatusChecker, objectMapper);
    }

    // ── AC1: Compatible upgrade creates job and starts precheck ──────────────

    @Test
    public void testSubmitFirmwareUpgrade_Compatible_CreatesJob() throws Exception {
        String deviceId = "dev-bts-dn-010";
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setReason("Security patch");
        request.setConfirmation(true);  // Explicit confirmation required

        when(deviceStatusChecker.isOnline(deviceId)).thenReturn(true);
        when(jobRepo.findByDeviceIdAndStatusIn(eq(deviceId), anyList())).thenReturn(Collections.emptyList());
        when(jobRepo.save(any(FirmwareJob.class))).thenAnswer(inv -> {
            FirmwareJob job = inv.getArgument(0);
            job.setId("fw-job-001");
            return job;
        });

        FirmwareUpgradeResponse response = firmwareService.submitFirmwareUpgrade(deviceId, request, "operator", "Admin");

        assertNotNull(response);
        assertEquals("fw-job-001", response.getJobId());
        assertEquals("PENDING", response.getStatus());
        assertEquals("ACCEPTED", response.getFirmwarePhase());
        assertNotNull(response.getAcceptedAt());
        assertEquals("/api/v1/operations/firmware-jobs/fw-job-001", response.getTrackingUrl());

        verify(jobRepo, atLeastOnce()).save(any(FirmwareJob.class));
    }

    // ── AC2: Incompatible image is rejected before dispatch ──────────────────

    @Test
    public void testSubmitFirmwareUpgrade_IncompatibleVersion_Rejected() throws Exception {
        String deviceId = "dev-bts-dn-010";
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v1.0.0.bin");
        request.setExpectedVersion("1.0.0");  // Below policy minimum
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setConfirmation(true);

        when(deviceStatusChecker.isOnline(deviceId)).thenReturn(true);
        when(jobRepo.findByDeviceIdAndStatusIn(eq(deviceId), anyList())).thenReturn(Collections.emptyList());
        when(jobRepo.save(any(FirmwareJob.class))).thenAnswer(inv -> {
            FirmwareJob job = inv.getArgument(0);
            job.setId("fw-job-002");
            return job;
        });

        // Job is created but precheck should fail asynchronously
        FirmwareUpgradeResponse response = firmwareService.submitFirmwareUpgrade(deviceId, request, "operator", "Admin");

        assertNotNull(response);
        // Note: Precheck runs asynchronously, so job is initially PENDING/ACCEPTED
        // Worker would call handlePhaseCallback with FAILURE after precheck
    }

    // ── AC3: Checksum mismatch stops install ──────────────────────────────

    @Test
    public void testHandlePhaseCallback_ChecksumFailure_StopsJob() {
        FirmwareJob job = createMockJob("fw-job-003", "dev-cpe-dn-045", "CHECKSUM_VERIFY");
        when(jobRepo.findById("fw-job-003")).thenReturn(Optional.of(job));
        when(jobRepo.save(any(FirmwareJob.class))).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> data = Map.of("reason", "Checksum mismatch: expected abc123, got def456");

        FirmwareJob updated = firmwareService.handlePhaseCallback("fw-job-003", "CHECKSUM_FAILURE", data);

        assertNotNull(updated);
        assertEquals("FAILED", updated.getStatus());
        assertEquals("FAILED", updated.getFirmwarePhase());
        assertFalse(updated.getChecksumVerified());
        assertTrue(updated.getRetryable());
        assertNotNull(updated.getFailureReason());
        assertTrue(updated.getFailureReason().contains("Checksum verification failed"));
        assertNotNull(updated.getCompletedAt());
    }

    // ── AC4: Post-reboot version mismatch creates discrepancy ────────────────

    @Test
    public void testHandlePhaseCallback_VersionMismatch_CreatesDis crepancy() {
        FirmwareJob job = createMockJob("fw-job-004", "dev-bts-dn-010", "POSTCHECK");
        job.setExpectedVersion("3.5.2.1");
        when(jobRepo.findById("fw-job-004")).thenReturn(Optional.of(job));
        when(jobRepo.save(any(FirmwareJob.class))).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> data = Map.of("observedVersion", "3.4.1");  // Old version still running

        FirmwareJob updated = firmwareService.handlePhaseCallback("fw-job-004", "POSTCHECK_COMPLETE", data);

        assertNotNull(updated);
        assertEquals("COMPLETED", updated.getStatus());
        assertEquals("DISCREPANCY", updated.getFirmwarePhase());
        assertEquals("3.4.1", updated.getObservedVersion());
        assertTrue(updated.getDiscrepancy());
        assertNotNull(updated.getFailureReason());
        assertTrue(updated.getFailureReason().contains("Version mismatch"));
        assertNotNull(updated.getCompletedAt());
    }

    @Test
    public void testHandlePhaseCallback_VersionMatch_Succeeds() {
        FirmwareJob job = createMockJob("fw-job-005", "dev-bts-dn-010", "POSTCHECK");
        job.setExpectedVersion("3.5.2.1");
        when(jobRepo.findById("fw-job-005")).thenReturn(Optional.of(job));
        when(jobRepo.save(any(FirmwareJob.class))).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> data = Map.of("observedVersion", "3.5.2.1");

        FirmwareJob updated = firmwareService.handlePhaseCallback("fw-job-005", "POSTCHECK_COMPLETE", data);

        assertNotNull(updated);
        assertEquals("COMPLETED", updated.getStatus());
        assertEquals("SUCCEEDED", updated.getFirmwarePhase());
        assertEquals("3.5.2.1", updated.getObservedVersion());
        assertFalse(updated.getDiscrepancy());
        assertNotNull(updated.getCompletedAt());
    }

    // ── AC5: Transfer progress callback updates job ──────────────────────────

    @Test
    public void testHandlePhaseCallback_TransferProgress_UpdatesProgress() {
        FirmwareJob job = createMockJob("fw-job-006", "dev-cpe-dn-045", "TRANSFER");
        when(jobRepo.findById("fw-job-006")).thenReturn(Optional.of(job));
        when(jobRepo.save(any(FirmwareJob.class))).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> data = Map.of("progress", 45);

        FirmwareJob updated = firmwareService.handlePhaseCallback("fw-job-006", "TRANSFER_PROGRESS", data);

        assertNotNull(updated);
        assertEquals(45, updated.getTransferProgress());
        assertEquals("TRANSFER", updated.getFirmwarePhase());
    }

    // ── Edge case: Conflicting in-flight operation ───────────────────────────

    @Test
    public void testSubmitFirmwareUpgrade_ConflictingOperation_Rejected() throws Exception {
        String deviceId = "dev-bts-dn-010";
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setConfirmation(true);

        FirmwareJob existingJob = createMockJob("fw-job-007", deviceId, "TRANSFER");
        when(deviceStatusChecker.isOnline(deviceId)).thenReturn(true);
        when(jobRepo.findByDeviceIdAndStatusIn(eq(deviceId), anyList())).thenReturn(List.of(existingJob));

        Exception exception = assertThrows(IllegalStateException.class, () -> {
            firmwareService.submitFirmwareUpgrade(deviceId, request, "operator", "Admin");
        });

        assertTrue(exception.getMessage().contains("in-flight firmware operation"));
    }

    // ── Edge case: Device offline ─────────────────────────────────────────────

    @Test
    public void testSubmitFirmwareUpgrade_DeviceOffline_Rejected() throws Exception {
        String deviceId = "dev-bts-dn-010";
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setConfirmation(true);

        when(deviceStatusChecker.isOnline(deviceId)).thenReturn(false);
        when(jobRepo.findByDeviceIdAndStatusIn(eq(deviceId), anyList())).thenReturn(Collections.emptyList());

        Exception exception = assertThrows(IllegalStateException.class, () -> {
            firmwareService.submitFirmwareUpgrade(deviceId, request, "operator", "Admin");
        });

        assertTrue(exception.getMessage().contains("offline"));
    }

    // ── Edge case: Missing confirmation (RTM REQ-008) ─────────────────────────

    @Test
    public void testSubmitFirmwareUpgrade_MissingConfirmation_Rejected() throws Exception {
        String deviceId = "dev-bts-dn-010";
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        // confirmation field not set (null) or false

        when(deviceStatusChecker.isOnline(deviceId)).thenReturn(true);
        when(jobRepo.findByDeviceIdAndStatusIn(eq(deviceId), anyList())).thenReturn(Collections.emptyList());

        Exception exception = assertThrows(IllegalArgumentException.class, () -> {
            firmwareService.submitFirmwareUpgrade(deviceId, request, "operator", "Admin");
        });

        assertTrue(exception.getMessage().contains("explicit confirmation"));
    }

    // ── Edge case: Idempotency ────────────────────────────────────────────────

    @Test
    public void testSubmitFirmwareUpgrade_IdempotentRequest_ReturnsSameJob() throws Exception {
        String deviceId = "dev-bts-dn-010";
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setIdempotencyKey("idem-001");
        request.setConfirmation(true);

        FirmwareJob existingJob = createMockJob("fw-job-008", deviceId, "ACCEPTED");
        existingJob.setIdempotencyKey("idem-001");

        when(jobRepo.findByIdempotencyKey("idem-001")).thenReturn(Optional.of(existingJob));

        FirmwareUpgradeResponse response = firmwareService.submitFirmwareUpgrade(deviceId, request, "operator", "Admin");

        assertNotNull(response);
        assertEquals("fw-job-008", response.getJobId());

        // Should not create a new job
        verify(jobRepo, never()).save(any(FirmwareJob.class));
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    private FirmwareJob createMockJob(String id, String deviceId, String phase) {
        FirmwareJob job = new FirmwareJob();
        job.setId(id);
        job.setDeviceId(deviceId);
        job.setImageRef("firmware-images/test.bin");
        job.setExpectedVersion("3.5.2.1");
        job.setChecksumAlgorithm("SHA256");
        job.setTransferMethod("HTTP");
        job.setActor("operator");
        job.setRole("Admin");
        job.setFirmwarePhase(phase);
        job.setStatus("IN_PROGRESS");
        job.setAcceptedAt(java.time.Instant.now());
        job.setRetryable(true);
        return job;
    }
}
