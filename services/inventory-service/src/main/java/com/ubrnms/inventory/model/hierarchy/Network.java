package com.ubrnms.inventory.model.hierarchy;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/** Third tier — a managed network group within a hierarchy view. */
@Data
@NoArgsConstructor
@Document(collection = "networks")
public class Network {
    @Id
    private String id;
    @Indexed private String organizationId;
    @Indexed private String hierarchyId;
    private String name;
    private boolean active = true;
    @CreatedDate  private Instant createdAt;
    @LastModifiedDate private Instant updatedAt;
}
