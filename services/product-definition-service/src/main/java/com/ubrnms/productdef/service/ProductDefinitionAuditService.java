package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.ProductDefinitionLifecycleEvent;
import com.ubrnms.productdef.repository.ProductDefinitionLifecycleEventRepository;
import com.ubrnms.productdef.repository.ProductDefinitionVersionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;

/**
 * Read-only audit history service for Product Definition lifecycle events (WO-020).
 *
 * <p>All write paths are handled by {@link ProductDefinitionLifecycleService} —
 * this service exposes the immutable audit log for retrieval only.
 *
 * <p><b>Immutability guarantee:</b> This service contains no update or delete
 * methods.  Callers that hold a reference to this service cannot mutate audit
 * records through it; the underlying MongoDB collection is also protected by
 * absence of update calls in the repository.
 *
 * <p><b>Authorization note:</b> The controller is responsible for enforcing
 * role-based access control before calling this service.  Audit history is
 * available only to Admin and SuperAdmin roles; Operators see a 403.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductDefinitionAuditService {

    private final ProductDefinitionLifecycleEventRepository eventRepo;
    private final ProductDefinitionVersionRepository        versionRepo;

    /** Maximum page size the API will honour (prevents unbounded result sets). */
    private static final int MAX_PAGE_SIZE = 100;
    /** Default page size. */
    private static final int DEFAULT_PAGE_SIZE = 20;

    // ── Paginated audit history ───────────────────────────────────────────────

    /**
     * Returns a paginated, chronologically descending audit history for a given
     * Product Definition.
     *
     * <p>Results are sorted by {@code occurredAt} descending (newest first) then by
     * {@code id} descending for stable tie-breaking within the same timestamp.
     *
     * @param definitionId the definition to retrieve history for
     * @param page         0-indexed page number
     * @param pageSize     number of records per page (capped at {@link #MAX_PAGE_SIZE})
     * @return a {@link Page} of {@link ProductDefinitionLifecycleEvent} records
     * @throws NoSuchElementException if no events exist for the definition
     */
    public Page<ProductDefinitionLifecycleEvent> getAuditHistory(
            String definitionId,
            int page,
            int pageSize) {

        int effectiveSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
        Pageable pageable = PageRequest.of(
                Math.max(page, 0),
                effectiveSize,
                Sort.by(Sort.Direction.DESC, "occurredAt", "id")
        );

        Page<ProductDefinitionLifecycleEvent> result =
                eventRepo.findByProductDefinitionId(definitionId, pageable);

        log.debug("[audit-history] definitionId={} page={} pageSize={} totalElements={}",
                definitionId, page, effectiveSize, result.getTotalElements());

        return result;
    }

    /**
     * Returns a flat audit history (up to {@link #MAX_PAGE_SIZE} records) for cases
     * where the caller does not need pagination metadata.
     *
     * @param definitionId the definition to retrieve history for
     * @return list of lifecycle events, newest first
     */
    public List<ProductDefinitionLifecycleEvent> getAuditHistoryList(String definitionId) {
        return getAuditHistory(definitionId, 0, MAX_PAGE_SIZE).getContent();
    }

    // ── Response envelope helper ──────────────────────────────────────────────

    /**
     * Builds the standard paginated audit history API response map.
     *
     * <p>The shape is: {@code { events: [...], pagination: { page, pageSize, total, totalPages } }}.
     */
    public Map<String, Object> buildPageResponse(Page<ProductDefinitionLifecycleEvent> page) {
        return Map.of(
            "events", page.getContent(),
            "pagination", Map.of(
                "page",       page.getNumber(),
                "pageSize",   page.getSize(),
                "total",      page.getTotalElements(),
                "totalPages", page.getTotalPages()
            )
        );
    }

    // ── Lineage helper ────────────────────────────────────────────────────────

    /**
     * Returns the predecessor version ID for a given version (WO-020 lineage AC-1).
     *
     * <p>Traverses the {@code predecessorVersionId} chain to return the direct
     * predecessor.  Returns {@code null} if this is the first version of the definition.
     */
    public String getPredecessorVersionId(String definitionId, String versionId) {
        return versionRepo.findByDefinitionIdAndVersionId(definitionId, versionId)
                .map(v -> v.getPredecessorVersionId())
                .orElse(null);
    }
}
