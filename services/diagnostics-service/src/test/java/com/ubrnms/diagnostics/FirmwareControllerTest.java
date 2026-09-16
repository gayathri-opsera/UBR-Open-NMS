package com.ubrnms.diagnostics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.diagnostics.controller.FirmwareController;
import com.ubrnms.diagnostics.model.FirmwareJob;
import com.ubrnms.diagnostics.model.FirmwareUpgradeRequest;
import com.ubrnms.diagnostics.model.FirmwareUpgradeResponse;
import com.ubrnms.diagnostics.service.FirmwareService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Integration tests for firmware upgrade HTTP endpoints (WO-012).
 */
@WebMvcTest(FirmwareController.class)
public class FirmwareControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockBean
    private FirmwareService firmwareService;

    @Test
    public void testSubmitFirmwareUpgrade_Success_Returns202() throws Exception {
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setReason("Security patch");
        request.setConfirmation(true);

        FirmwareUpgradeResponse response = new FirmwareUpgradeResponse(
                "fw-job-001",
                "PENDING",
                "ACCEPTED",
                Instant.now(),
                "PENDING",
                "/api/v1/operations/firmware-jobs/fw-job-001"
        );

        when(firmwareService.submitFirmwareUpgrade(eq("dev-bts-dn-010"), any(FirmwareUpgradeRequest.class), anyString(), anyString()))
                .thenReturn(response);

        mockMvc.perform(post("/api/v1/operations/devices/dev-bts-dn-010/firmware-upgrade")
                        .header("X-Actor", "operator")
                        .header("X-Role", "Admin")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.jobId").value("fw-job-001"))
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andExpect(jsonPath("$.firmwarePhase").value("ACCEPTED"));
    }

    @Test
    public void testSubmitFirmwareUpgrade_Conflict_Returns409() throws Exception {
        FirmwareUpgradeRequest request = new FirmwareUpgradeRequest();
        request.setImageRef("firmware-images/ubr-bts-a60-v3.5.2.1.bin");
        request.setExpectedVersion("3.5.2.1");
        request.setChecksumAlgorithm("SHA256");
        request.setChecksumValue("abc123def456");
        request.setTransferMethod("HTTP");
        request.setConfirmation(true);

        when(firmwareService.submitFirmwareUpgrade(eq("dev-bts-dn-010"), any(FirmwareUpgradeRequest.class), anyString(), anyString()))
                .thenThrow(new IllegalStateException("Device dev-bts-dn-010 has an in-flight firmware operation"));

        mockMvc.perform(post("/api/v1/operations/devices/dev-bts-dn-010/firmware-upgrade")
                        .header("X-Actor", "operator")
                        .header("X-Role", "Admin")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("OPERATION_CONFLICT"));
    }

    @Test
    public void testGetFirmwareJobStatus_Success_Returns200() throws Exception {
        FirmwareJob job = new FirmwareJob();
        job.setId("fw-job-001");
        job.setDeviceId("dev-bts-dn-010");
        job.setExpectedVersion("3.5.2.1");
        job.setFirmwarePhase("TRANSFER");
        job.setStatus("IN_PROGRESS");
        job.setTransferProgress(45);

        when(firmwareService.getJob("fw-job-001")).thenReturn(Optional.of(job));

        mockMvc.perform(get("/api/v1/operations/firmware-jobs/fw-job-001"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("fw-job-001"))
                .andExpect(jsonPath("$.firmwarePhase").value("TRANSFER"))
                .andExpect(jsonPath("$.transferProgress").value(45));
    }

    @Test
    public void testGetFirmwareJobStatus_NotFound_Returns404() throws Exception {
        when(firmwareService.getJob("nonexistent")).thenReturn(Optional.empty());

        mockMvc.perform(get("/api/v1/operations/firmware-jobs/nonexistent"))
                .andExpect(status().isNotFound());
    }

    @Test
    public void testGetFirmwareJobHistory_Success_Returns200() throws Exception {
        FirmwareJob job1 = new FirmwareJob();
        job1.setId("fw-job-001");
        job1.setDeviceId("dev-bts-dn-010");
        job1.setFirmwarePhase("SUCCEEDED");

        FirmwareJob job2 = new FirmwareJob();
        job2.setId("fw-job-002");
        job2.setDeviceId("dev-bts-dn-010");
        job2.setFirmwarePhase("FAILED");

        when(firmwareService.getJobHistory("dev-bts-dn-010")).thenReturn(List.of(job1, job2));

        mockMvc.perform(get("/api/v1/operations/devices/dev-bts-dn-010/firmware-jobs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].id").value("fw-job-001"))
                .andExpect(jsonPath("$[1].id").value("fw-job-002"));
    }
}
