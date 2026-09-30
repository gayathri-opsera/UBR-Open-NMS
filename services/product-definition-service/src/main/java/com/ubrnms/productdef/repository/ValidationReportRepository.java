package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.ValidationReport;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

public interface ValidationReportRepository extends MongoRepository<ValidationReport, String> {

    Optional<ValidationReport> findByDefinitionIdAndVersionId(String definitionId, String versionId);

    /** Delete the validation report for a specific version. */
    void deleteByDefinitionIdAndVersionId(String definitionId, String versionId);
}
