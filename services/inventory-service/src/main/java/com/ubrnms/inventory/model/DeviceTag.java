package com.ubrnms.inventory.model;

import lombok.Data;
import lombok.NoArgsConstructor;

/** Metadata tag applied to a device (NMS-IV-06). */
@Data
@NoArgsConstructor
public class DeviceTag {
    private String type;  // circle, city, identifier
    private String value;
}
