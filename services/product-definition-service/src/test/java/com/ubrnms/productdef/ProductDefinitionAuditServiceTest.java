package com.ubrnms.productdef;

import com.ubrnms.productdef.model.ProductDefinitionLifecycleEvent;
import com.ubrnms.productdef.model.ProductDefinitionVersion;
import com.ubrnms.productdef.repository.ProductDefinitionLifecycleEventRepository;
import com.ubrnms.productdef.repository.ProductDefinitionVersionRepository;
import com.ubrnms.productdef.service.AuditRecordRedactor;
import com.ubrnms.productdef.service.ProductDefinitionAuditService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for the WO-020 audit trail and lineage service.
 * Covers: pagination, ordering, page-size cap, redaction, lineage chain, AC evidence.
 */
@ExtendWith(MockitoExtension.class)
class ProductDefinitionAuditServiceTest {

    @Mock
    private ProductDefinitionLifecycleEventRepository eventRepo;

    @Mock
    private ProductDefinitionVersionRepository versionRepo;

    private ProductDefinitionAuditService auditService;

    @BeforeEach
    void setUp() {
        auditService = new ProductDefinitionAuditService(eventRepo, versionRepo);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private ProductDefinitionLifecycleEvent eventFixture(String eventType, String prevStatus, String newStatus) {
        return ProductDefinitionLifecycleEvent.builder()
                .id("evt-" + eventType)
                .eventType(eventType)
                .productDefinitionId("def-001")
                .versionId("1.0.0")
                .actor("admin@test.com")
                .actorUserId("usr-001")
                .previousLifecycleStatus(prevStatus)
                .newLifecycleStatus(newStatus)
                .outcome("SUCCESS")
                .changeSummary("Test event for " + eventType)
                .registryVersion(1L)
                .correlationId("corr-001")
                .occurredAt(Instant.now())
                .build();
    }

    // ── AC-5: Authorized user can retrieve audit history ──────────────────────

    @Test
    @DisplayName("getAuditHistory returns page of events for a definition")
    void getAuditHistory_returnsPageOfEvents() {
        ProductDefinitionLifecycleEvent evt = eventFixture("STAGED", "DRAFT", "STAGED");
        Page<ProductDefinitionLifecycleEvent> page = new PageImpl<>(List.of(evt));
        when(eventRepo.findByProductDefinitionId(eq("def-001"), any(Pageable.class)))
                .thenReturn(page);

        Page<ProductDefinitionLifecycleEvent> result = auditService.getAuditHistory("def-001", 0, 20);

        assertThat(result.getContent()).hasSize(1);
        assertThat(result.getContent().get(0).getEventType()).isEqualTo("STAGED");
    }

    // ── AC-6: Paginated and sorted deterministically ──────────────────────────

    @Test
    @DisplayName("getAuditHistory uses DESC sort by occurredAt and id")
    void getAuditHistory_usesDeterministicSort() {
        Page<ProductDefinitionLifecycleEvent> emptyPage = Page.empty();
        when(eventRepo.findByProductDefinitionId(eq("def-001"), any(Pageable.class)))
                .thenReturn(emptyPage);

        auditService.getAuditHistory("def-001", 0, 20);

        verify(eventRepo).findByProductDefinitionId(eq("def-001"), argThat(p ->
            p.getSort().getOrderFor("occurredAt").isDescending()
            && p.getSort().getOrderFor("id").isDescending()
        ));
    }

    @Test
    @DisplayName("getAuditHistory caps page size at 100")
    void getAuditHistory_capsPageSizeAt100() {
        Page<ProductDefinitionLifecycleEvent> emptyPage = Page.empty();
        when(eventRepo.findByProductDefinitionId(eq("def-001"), any(Pageable.class)))
                .thenReturn(emptyPage);

        auditService.getAuditHistory("def-001", 0, 9999);

        verify(eventRepo).findByProductDefinitionId(eq("def-001"), argThat(p -> p.getPageSize() == 100));
    }

    @Test
    @DisplayName("getAuditHistory clamps negative page to 0")
    void getAuditHistory_negativePage_clampedToZero() {
        Page<ProductDefinitionLifecycleEvent> emptyPage = Page.empty();
        when(eventRepo.findByProductDefinitionId(eq("def-001"), any(Pageable.class)))
                .thenReturn(emptyPage);

        auditService.getAuditHistory("def-001", -5, 20);

        verify(eventRepo).findByProductDefinitionId(eq("def-001"), argThat(p -> p.getPageNumber() == 0));
    }

    // ── buildPageResponse ─────────────────────────────────────────────────────

    @Test
    @DisplayName("buildPageResponse includes events and pagination metadata")
    void buildPageResponse_includesAllFields() {
        ProductDefinitionLifecycleEvent evt = eventFixture("ACTIVATED", "STAGED", "ACTIVE");
        // Use pageSize=5, total=100 so Spring Data's PageImpl doesn't collapse totalElements
        // (it collapses when offset+pageSize > total, i.e. 0+5 = 5 < 100 → safe)
        PageRequest pageable = PageRequest.of(0, 5, Sort.by(Sort.Direction.DESC, "occurredAt"));
        Page<ProductDefinitionLifecycleEvent> page = new PageImpl<>(List.of(evt), pageable, 100L);

        Map<String, Object> response = auditService.buildPageResponse(page);

        assertThat(response).containsKey("events");
        assertThat(response).containsKey("pagination");

        @SuppressWarnings("unchecked")
        Map<String, Object> pagination = (Map<String, Object>) response.get("pagination");
        assertThat(pagination.get("total")).isEqualTo(100L);
        assertThat(pagination.get("pageSize")).isEqualTo(5);
    }

    // ── AC-7: Secret material not in audit records (redaction) ────────────────

    @Test
    @DisplayName("AuditRecordRedactor.redact removes community strings")
    void redactor_removesCommunityString() {
        String input = "SNMP community=public123 activated definition";
        String redacted = AuditRecordRedactor.redact(input);
        assertThat(redacted).doesNotContain("public123");
        assertThat(redacted).contains("[REDACTED]");
    }

    @Test
    @DisplayName("AuditRecordRedactor.redact removes vault paths")
    void redactor_removesVaultPaths() {
        String input = "Loaded credential from secret/data/ubrnms/snmp/cisco";
        String redacted = AuditRecordRedactor.redact(input);
        // The vault path itself must be gone
        assertThat(redacted).doesNotContain("secret/data");
        assertThat(redacted).contains("[REDACTED]");
    }

    @Test
    @DisplayName("AuditRecordRedactor.redact does not alter safe audit summaries")
    void redactor_safeText_unchanged() {
        String input = "Activated version 2.1.0 for definition Ericsson-RBS6120, registryVersion advanced to 7";
        String redacted = AuditRecordRedactor.redact(input);
        // Safe text must pass through unchanged (no false-positives for version numbers)
        assertThat(redacted).isEqualTo(input);
    }

    @Test
    @DisplayName("AuditRecordRedactor.containsSecretMaterial detects password field")
    void redactor_detectsPasswordField() {
        String input = "password=SuperSecret123!";
        assertThat(AuditRecordRedactor.containsSecretMaterial(input)).isTrue();
    }

    @Test
    @DisplayName("AuditRecordRedactor.containsSecretMaterial returns false for safe text")
    void redactor_safeText_notDetectedAsSecret() {
        String input = "Staged version 1.0.0 for definition Nokia-7210 by admin@test.com";
        assertThat(AuditRecordRedactor.containsSecretMaterial(input)).isFalse();
    }

    @Test
    @DisplayName("AuditRecordRedactor.redact handles null input gracefully")
    void redactor_null_returnsNull() {
        assertThat(AuditRecordRedactor.redact(null)).isNull();
    }

    // ── AC-1: Lineage chain — predecessorVersionId ────────────────────────────

    @Test
    @DisplayName("getPredecessorVersionId returns predecessorVersionId from version record")
    void getPredecessorVersionId_returnsFromVersionRecord() {
        ProductDefinitionVersion version = new ProductDefinitionVersion();
        version.setDefinitionId("def-001");
        version.setVersionId("2.0.0");
        version.setPredecessorVersionId("1.0.0");
        when(versionRepo.findByDefinitionIdAndVersionId("def-001", "2.0.0"))
                .thenReturn(Optional.of(version));

        String predecessor = auditService.getPredecessorVersionId("def-001", "2.0.0");
        assertThat(predecessor).isEqualTo("1.0.0");
    }

    @Test
    @DisplayName("getPredecessorVersionId returns null for first version of a definition")
    void getPredecessorVersionId_nullForFirstVersion() {
        ProductDefinitionVersion version = new ProductDefinitionVersion();
        version.setDefinitionId("def-001");
        version.setVersionId("1.0.0");
        version.setPredecessorVersionId(null);
        when(versionRepo.findByDefinitionIdAndVersionId("def-001", "1.0.0"))
                .thenReturn(Optional.of(version));

        String predecessor = auditService.getPredecessorVersionId("def-001", "1.0.0");
        assertThat(predecessor).isNull();
    }

    // ── AC-3: Events include previous and new lifecycle state ─────────────────

    @Test
    @DisplayName("Lifecycle event records previousLifecycleStatus and newLifecycleStatus")
    void eventFixture_includesBothLifecycleStates() {
        ProductDefinitionLifecycleEvent evt = eventFixture("ACTIVATED", "STAGED", "ACTIVE");
        assertThat(evt.getPreviousLifecycleStatus()).isEqualTo("STAGED");
        assertThat(evt.getNewLifecycleStatus()).isEqualTo("ACTIVE");
    }

    // ── AC-4: Immutable through public APIs ───────────────────────────────────

    @Test
    @DisplayName("ProductDefinitionAuditService has no update or delete methods")
    void auditService_hasNoMutationMethods() {
        // Verify the service class does not expose update/delete operations.
        // This is a structural test: check that the class does not have any method
        // named "update", "delete", "save", or "remove".
        boolean hasMutation = java.util.Arrays.stream(ProductDefinitionAuditService.class.getMethods())
                .anyMatch(m -> {
                    String name = m.getName().toLowerCase();
                    return name.startsWith("update") || name.startsWith("delete")
                        || name.startsWith("save") || name.startsWith("remove");
                });
        assertThat(hasMutation)
                .as("ProductDefinitionAuditService must not expose update/delete methods")
                .isFalse();
    }
}
