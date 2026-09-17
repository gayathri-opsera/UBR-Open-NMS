package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.ProductDefinitionLifecycleEvent;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface ProductDefinitionLifecycleEventRepository
        extends MongoRepository<ProductDefinitionLifecycleEvent, String> {

    /** Returns all lifecycle events for a product definition, newest first. */
    List<ProductDefinitionLifecycleEvent> findByProductDefinitionIdOrderByOccurredAtDesc(
            String productDefinitionId);

    /** Returns all lifecycle events for a specific version of a definition. */
    List<ProductDefinitionLifecycleEvent> findByProductDefinitionIdAndVersionId(
            String productDefinitionId, String versionId);

    /**
     * Returns events by correlation ID — enables tracing a single API request
     * across all events it generated (e.g. activation that also archived old version).
     */
    List<ProductDefinitionLifecycleEvent> findByCorrelationId(String correlationId);
}
