package com.ubrnms.inventory.model.hierarchy;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/** Second tier — e.g., circle or region within an organization. */
@Data
@NoArgsConstructor
@Document(collection = "hierarchy_views")
public class HierarchyView {
    @Id
    private String id;
    @Indexed
    private String organizationId;
    private String name;       // e.g., "North Circle"
    private String type;       // circle, region, zone
    private boolean active = true;
    @CreatedDate  private Instant createdAt;
    @LastModifiedDate private Instant updatedAt;
}
