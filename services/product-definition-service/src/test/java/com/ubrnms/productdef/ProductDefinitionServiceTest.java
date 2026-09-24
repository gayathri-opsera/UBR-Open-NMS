package com.ubrnms.productdef;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.ubrnms.productdef.model.*;
import com.ubrnms.productdef.repository.ProductDefinitionVersionRepository;
import com.ubrnms.productdef.repository.ValidationReportRepository;
import com.ubrnms.productdef.service.ProductDefinitionService;
import com.ubrnms.productdef.validation.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ProductDefinitionServiceTest {

    @Mock private ProductDefinitionVersionRepository versionRepo;
    @Mock private ValidationReportRepository reportRepo;

    private ProductDefinitionService service;

    @BeforeEach
    void setUp() {
        ObjectMapper om = new ObjectMapper().registerModule(new JavaTimeModule());
        XmlProductDefinitionParser  xmlParser  = new XmlProductDefinitionParser();
        JsonProductDefinitionParser jsonParser = new JsonProductDefinitionParser(om);
        XlsProductDefinitionParser  xlsParser  = new XlsProductDefinitionParser();
        ProductDefinitionValidationService validationService = new ProductDefinitionValidationService();

        service = new ProductDefinitionService(
                xmlParser, xlsParser, jsonParser, validationService,
                versionRepo, reportRepo, om);
    }

    // ── Upload — happy path ───────────────────────────────────────────────────

    @Test
    void upload_validXml_persistsVersionAndReport() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.xml");
        when(versionRepo.findByContentHash(anyString())).thenReturn(Optional.empty());
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(reportRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ProductDefinitionVersion version = service.upload(
                bytes, "application/xml", "test upload",
                "user-1", "admin", "FRAMEWORK_ADMIN", "corr-1");

        assertThat(version.getValidationStatus()).isEqualTo("VALID");
        assertThat(version.getUploadedFormat()).isEqualTo("XML");
        assertThat(version.getLifecycleStatus()).isEqualTo("DRAFT");
        assertThat(version.getVendor()).isEqualTo("Cisco");
        verify(versionRepo).save(any());
        verify(reportRepo).save(any());
    }

    @Test
    void upload_validJson_persistsVersionAndReport() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.json");
        when(versionRepo.findByContentHash(anyString())).thenReturn(Optional.empty());
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(reportRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        ProductDefinitionVersion version = service.upload(
                bytes, "application/json", null,
                "user-1", "admin", "FRAMEWORK_ADMIN", "corr-2");

        assertThat(version.getUploadedFormat()).isEqualTo("JSON");
        assertThat(version.getVendor()).isEqualTo("Ericsson");
    }

    // ── Duplicate detection ───────────────────────────────────────────────────

    @Test
    void upload_duplicateHash_throwsIllegalArgument() throws Exception {
        byte[] bytes = loadFixture("fixtures/valid-definition.xml");
        ProductDefinitionVersion existing = new ProductDefinitionVersion();
        existing.setVersionId("existing-version-id");
        when(versionRepo.findByContentHash(anyString())).thenReturn(Optional.of(existing));

        assertThatThrownBy(() -> service.upload(bytes, "application/xml", null,
                "u1", "admin", "FRAMEWORK_ADMIN", "corr-3"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already been uploaded");
    }

    // ── Format detection ──────────────────────────────────────────────────────

    @Test
    void upload_emptyBytes_throwsIllegalArgument() {
        assertThatThrownBy(() -> service.upload(new byte[0], "application/xml", null,
                "u1", "admin", "FRAMEWORK_ADMIN", "corr-4"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("empty");
    }

    @Test
    void upload_unknownFormat_throwsIllegalArgument() {
        // Format detection throws before repo is consulted — no stubbing needed
        byte[] bytes = "some random binary content 12345".getBytes(StandardCharsets.UTF_8);

        assertThatThrownBy(() -> service.upload(bytes, "application/octet-stream", null,
                "u1", "admin", "FRAMEWORK_ADMIN", "corr-5"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("format");
    }

    // ── Invalid file — parse failure stored as INVALID version ───────────────

    @Test
    void upload_invalidXml_persistsInvalidVersion() throws Exception {
        byte[] bytes = loadFixture("fixtures/invalid-missing-identity.xml");
        when(versionRepo.findByContentHash(anyString())).thenReturn(Optional.empty());
        when(versionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(reportRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        // Missing identity → INVALID status (validation errors)
        ProductDefinitionVersion version = service.upload(
                bytes, "application/xml", null,
                "u1", "admin", "FRAMEWORK_ADMIN", "corr-6");

        assertThat(version.getValidationStatus()).isEqualTo("INVALID");
        verify(reportRepo).save(any());
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    @Test
    void getVersion_found_returnsVersion() {
        ProductDefinitionVersion v = new ProductDefinitionVersion();
        v.setDefinitionId("cisco-asr");
        v.setVersionId("v1");
        when(versionRepo.findByDefinitionIdAndVersionId("cisco-asr", "v1"))
                .thenReturn(Optional.of(v));

        ProductDefinitionVersion result = service.getVersion("cisco-asr", "v1");
        assertThat(result.getVersionId()).isEqualTo("v1");
    }

    @Test
    void getVersion_notFound_throwsNoSuchElement() {
        when(versionRepo.findByDefinitionIdAndVersionId(any(), any())).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.getVersion("x", "y"))
                .isInstanceOf(NoSuchElementException.class);
    }

    @Test
    void listVersions_returnsOrderedList() {
        when(versionRepo.findByDefinitionIdOrderByCreatedAtDesc("cisco-asr"))
                .thenReturn(List.of(new ProductDefinitionVersion(), new ProductDefinitionVersion()));

        assertThat(service.listVersions("cisco-asr")).hasSize(2);
    }

    @Test
    void getReport_notFound_throwsNoSuchElement() {
        when(reportRepo.findByDefinitionIdAndVersionId(any(), any())).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.getReport("x", "y"))
                .isInstanceOf(NoSuchElementException.class);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private byte[] loadFixture(String path) throws Exception {
        try (var is = getClass().getClassLoader().getResourceAsStream(path)) {
            assertThat(is).as("fixture not found: %s", path).isNotNull();
            return is.readAllBytes();
        }
    }
}
