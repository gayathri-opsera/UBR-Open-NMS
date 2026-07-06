package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.Map;

/** A versioned snapshot of a device's configuration. */
@Data
@NoArgsConstructor
@Document(collection = "config_versions")
@CompoundIndex(def = "{'deviceId': 1, 'versionNumber': -1}")
public class ConfigVersion {
    @Id
    private String id;
    private String deviceId;
    private int versionNumber;
    private String templateId;
    private String actor;
    private Map<String, Object> previousValues;
    private Map<String, Object> newValues;
    private Instant appliedAt;
    private String status;   // APPLIED, PENDING, FAILED
}
