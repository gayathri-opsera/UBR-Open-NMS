package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.FingerprintRegistryEntry;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface FingerprintRegistryRepository extends MongoRepository<FingerprintRegistryEntry, String> {

    /** Returns all entries currently registered for a product definition. */
    List<FingerprintRegistryEntry> findByProductDefinitionId(String productDefinitionId);

    /**
     * Returns all entries for a specific fingerprint value across all definitions.
     * Used by conflict detection to find competing definitions with the same OID or pattern.
     */
    List<FingerprintRegistryEntry> findByFingerprintValue(String fingerprintValue);

    /** Deletes all registry entries for a product definition (used during registry rebuild). */
    void deleteByProductDefinitionId(String productDefinitionId);

    /** Returns entries for a specific registry version (useful for freshness checks). */
    List<FingerprintRegistryEntry> findByProductDefinitionIdAndRegistryVersion(
            String productDefinitionId, long registryVersion);
}
