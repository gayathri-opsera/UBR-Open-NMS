package com.ubrnms.inventory.model.hierarchy;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/** Pre-assignment record: a serial has been registered to a network before onboarding. */
@Data
@NoArgsConstructor
@Document(collection = "device_pre_assignments")
@CompoundIndex(def = "{'serialNumber': 1}", unique = true)
public class DevicePreAssignment {
    @Id
    private String id;
    private String serialNumber;
    private String deviceType;
    private String networkId;
    private String organizationId;
    private String hierarchyId;
    private Instant preAssignedAt;
    private boolean onboarded = false;
}
