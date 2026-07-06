package com.ubrnms.inventory.model.hierarchy;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;

/** Top-level organizational unit. */
@Data
@NoArgsConstructor
@Document(collection = "organizations")
public class Organization {
    @Id
    private String id;
    private String name;
    private String description;
    private boolean active = true;
    @CreatedDate  private Instant createdAt;
    @LastModifiedDate private Instant updatedAt;
}
