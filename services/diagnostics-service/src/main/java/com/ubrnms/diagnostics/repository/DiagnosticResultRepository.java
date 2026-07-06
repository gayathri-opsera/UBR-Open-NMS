package com.ubrnms.diagnostics.repository;

import com.ubrnms.diagnostics.model.DiagnosticResult;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.List;

public interface DiagnosticResultRepository extends MongoRepository<DiagnosticResult, String> {
    List<DiagnosticResult> findByDeviceIdOrderByRequestedAtDesc(String deviceId);
}
