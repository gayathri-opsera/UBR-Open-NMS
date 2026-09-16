package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.ProductDefinitionVersion;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface ProductDefinitionVersionRepository extends MongoRepository<ProductDefinitionVersion, String> {

    Optional<ProductDefinitionVersion> findByDefinitionIdAndVersionId(String definitionId, String versionId);

    List<ProductDefinitionVersion> findByDefinitionIdOrderByCreatedAtDesc(String definitionId);

    Optional<ProductDefinitionVersion> findByContentHash(String contentHash);
}
