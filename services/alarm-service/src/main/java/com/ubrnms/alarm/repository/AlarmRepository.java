package com.ubrnms.alarm.repository;

import com.ubrnms.alarm.model.Alarm;
import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.data.mongodb.repository.Query;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface AlarmRepository extends MongoRepository<Alarm, String> {

    Optional<Alarm> findByAlarmId(String alarmId);

    // Dedup window lookup (time-bounded — used for non-persistent alarm sources)
    Optional<Alarm> findTopByDeviceIdAndAlarmTypeAndStateAndDedupWindowStartAfterOrderByRaisedAtDesc(
            String deviceId, String alarmType, String state, Instant windowStart);

    // Persistent-condition dedup: find any ACTIVE alarm regardless of age.
    // Used for threshold alarms that remain breached indefinitely (e.g. sys_uptime
    // always above threshold) so that only one alarm exists until it clears.
    Optional<Alarm> findTopByDeviceIdAndAlarmTypeAndStateOrderByRaisedAtDesc(
            String deviceId, String alarmType, String state);

    // State-scoped queries
    List<Alarm> findByStateOrderByRaisedAtDesc(String state);

    List<Alarm> findBySeverityAndStateOrderByRaisedAtDesc(String severity, String state);

    List<Alarm> findByDeviceIdAndStateOrderByRaisedAtDesc(String deviceId, String state);

    List<Alarm> findByNetworkIdOrderByRaisedAtDesc(String networkId);

    @Query("{ 'raisedAt': { $gte: ?0, $lte: ?1 } }")
    List<Alarm> findByTimeRange(Instant from, Instant to);

    @Query(value = "{ 'raisedAt': { $gte: ?0, $lte: ?1 } }", fields = "{ 'alarmType': 1, '_id': 0 }")
    List<Alarm> findAlarmTypesByTimeRange(Instant from, Instant to);

    // Top-N reported: grouping is done in service via Java stream
    List<Alarm> findByRaisedAtBetween(Instant from, Instant to);
}
