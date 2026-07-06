package com.ubrnms.kpi.repository;

import com.ubrnms.kpi.model.KpiAggregate;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface KpiAggregateRepository extends MongoRepository<KpiAggregate, String> {
    Optional<KpiAggregate> findByDeviceIdAndBucketStartAndGranularity(
            String deviceId, Instant bucketStart, String granularity);
    List<KpiAggregate> findByDeviceIdAndGranularityAndBucketStartBetween(
            String deviceId, String granularity, Instant from, Instant to);
    List<KpiAggregate> findByGranularityAndBucketStart(String granularity, Instant bucketStart);
}
