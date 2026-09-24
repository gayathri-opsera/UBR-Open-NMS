package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.ValidationReport;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

public interface ValidationReportRepository extends MongoRepository<ValidationReport, String> {

    Optional<ValidationReport> findByDefinitionIdAndVersionId(String definitionId, String versionId);
}
