package com.ubrnms.productdef.repository;

import com.ubrnms.productdef.model.IdempotencyRecord;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

public interface IdempotencyRecordRepository extends MongoRepository<IdempotencyRecord, String> {

    /**
     * Looks up an idempotency record by its composite key
     * ({@code "<operation>:<callerSuppliedKey>"}).
     */
    Optional<IdempotencyRecord> findByCompositeKey(String compositeKey);
}
