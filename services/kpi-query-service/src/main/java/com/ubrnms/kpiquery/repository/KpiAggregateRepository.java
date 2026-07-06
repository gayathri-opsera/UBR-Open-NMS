package com.ubrnms.kpiquery.repository;

import com.ubrnms.kpiquery.model.KpiAggregate;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.time.Instant;
import java.util.List;

public interface KpiAggregateRepository extends MongoRepository<KpiAggregate, String> {
    List<KpiAggregate> findByDeviceIdAndGranularityAndBucketStartBetweenOrderByBucketStartAsc(
            String deviceId, String granularity, Instant from, Instant to);
    List<KpiAggregate> findByNetworkIdAndGranularityAndBucketStartBetween(
            String networkId, String granularity, Instant from, Instant to);
    List<KpiAggregate> findByOrganizationIdAndGranularityAndBucketStartBetween(
            String organizationId, String granularity, Instant from, Instant to);
}
