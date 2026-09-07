// WO-053: Persist Alarm Lifecycle History
package com.ubr.nms.alarm.history;

import org.springframework.stereotype.Service;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Criteria;
import java.time.Instant;
import java.util.List;

@Service
public class AlarmHistoryService {
    private final MongoTemplate mongoTemplate;

    public AlarmHistoryService(MongoTemplate mongoTemplate) {
        this.mongoTemplate = mongoTemplate;
    }

    public void recordTransition(String alarmId, String fromState, String toState,
                                 String actor, String reason) {
        AlarmHistoryEntry entry = new AlarmHistoryEntry();
        entry.setAlarmId(alarmId);
        entry.setFromState(fromState);
        entry.setToState(toState);
        entry.setTransitionTimestamp(Instant.now());
        entry.setActor(actor);
        entry.setReason(reason);

        mongoTemplate.save(entry, "alarm_history");
    }

    public List<AlarmHistoryEntry> getHistory(String alarmId) {
        Query query = new Query(Criteria.where("alarmId").is(alarmId))
                             .with(org.springframework.data.domain.Sort.by(
                                 org.springframework.data.domain.Sort.Direction.DESC,
                                 "transitionTimestamp"));
        return mongoTemplate.find(query, AlarmHistoryEntry.class, "alarm_history");
    }

    public List<AlarmHistoryEntry> getHistoryInTimeRange(String alarmId,
                                                          Instant start, Instant end) {
        Query query = new Query(Criteria.where("alarmId").is(alarmId)
                                        .and("transitionTimestamp").gte(start).lte(end))
                             .with(org.springframework.data.domain.Sort.by(
                                 org.springframework.data.domain.Sort.Direction.DESC,
                                 "transitionTimestamp"));
        return mongoTemplate.find(query, AlarmHistoryEntry.class, "alarm_history");
    }
}

class AlarmHistoryEntry {
    private String id;
    private String alarmId;
    private String fromState;
    private String toState;
    private Instant transitionTimestamp;
    private String actor;
    private String reason;

    // Getters and setters
    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getAlarmId() { return alarmId; }
    public void setAlarmId(String alarmId) { this.alarmId = alarmId; }
    public String getFromState() { return fromState; }
    public void setFromState(String fromState) { this.fromState = fromState; }
    public String getToState() { return toState; }
    public void setToState(String toState) { this.toState = toState; }
    public Instant getTransitionTimestamp() { return transitionTimestamp; }
    public void setTransitionTimestamp(Instant transitionTimestamp) {
        this.transitionTimestamp = transitionTimestamp;
    }
    public String getActor() { return actor; }
    public void setActor(String actor) { this.actor = actor; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
}
