package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.ParameterRegistryEntry;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;
import java.util.Optional;

public interface ParameterRegistryRepository extends MongoRepository<ParameterRegistryEntry, String> {

    /** Returns all parameter entries for a product definition. */
    List<ParameterRegistryEntry> findByProductDefinitionId(String productDefinitionId);

    /** Returns all parameter entries for a specific group within a definition. */
    List<ParameterRegistryEntry> findByProductDefinitionIdAndGroupId(
            String productDefinitionId, String groupId);

    /** Looks up a single parameter entry by definition + group + parameter ID. */
    Optional<ParameterRegistryEntry> findByProductDefinitionIdAndGroupIdAndParameterId(
            String productDefinitionId, String groupId, String parameterId);

    /** Deletes all parameter entries for a product definition (used during registry rebuild). */
    void deleteByProductDefinitionId(String productDefinitionId);

    /** Returns entries for a specific registry version (useful for freshness checks). */
    List<ParameterRegistryEntry> findByProductDefinitionIdAndRegistryVersion(
            String productDefinitionId, long registryVersion);
}
