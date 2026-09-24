package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.ProductDefinitionActiveVersion;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface ProductDefinitionActiveVersionRepository
        extends MongoRepository<ProductDefinitionActiveVersion, String> {

    /**
     * Returns the active version pointer for a specific product definition + firmware range.
     * At most one document may exist per (productDefinitionId, firmwareFrom, firmwareTo) tuple.
     */
    Optional<ProductDefinitionActiveVersion> findByProductDefinitionIdAndFirmwareFromAndFirmwareTo(
            String productDefinitionId, String firmwareFrom, String firmwareTo);

    /** Returns all active version pointers for a product definition (across firmware ranges). */
    List<ProductDefinitionActiveVersion> findByProductDefinitionId(String productDefinitionId);

    /**
     * Returns active version pointers across all product definitions with a matching
     * fingerprint value.  Used by conflict detection to find overlapping registrations.
     */
    List<ProductDefinitionActiveVersion> findByVendorAndModel(String vendor, String model);
}
