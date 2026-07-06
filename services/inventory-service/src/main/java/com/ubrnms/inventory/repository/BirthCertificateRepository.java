package com.ubrnms.inventory.repository;

import com.ubrnms.inventory.model.BirthCertificate;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

public interface BirthCertificateRepository extends MongoRepository<BirthCertificate, String> {
    Optional<BirthCertificate> findBySerialNumber(String serialNumber);
}
