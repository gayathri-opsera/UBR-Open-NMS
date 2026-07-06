package com.ubrnms.config.model;

import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * A named configuration template supporting all 12 NMS-CF-01 parameter categories.
 */
@Data
@NoArgsConstructor
@Document(collection = "config_templates")
public class ConfigTemplate {
    @Id
    private String id;

    @Indexed(unique = true)
    private String name;
    private String description;
    private String deviceType;   // BTS, CPE, IDU, ALL
    private boolean isDefault;

    // 12 parameter categories (NMS-CF-01)
    private String managementIpType;    // DHCP, STATIC
    private String staticIp;
    private String staticSubnet;
    private String staticGateway;

    private String ssid24;
    private String password24;
    private String ssid5;
    private String password5;
    private Integer channel24;
    private Integer channel5;
    private Integer txPower24;
    private Integer txPower5;

    private String speedDuplex;         // AUTO, 100FULL, etc.
    private String portUpDown;          // UP, DOWN
    private Boolean wifiRestart;
    private Boolean deviceReboot;

    private String firmwareVersion;
    private String firmwareUrl;

    private Integer vlanId;
    private String qosProfile;

    // Free-form additional parameters
    private Map<String, Object> additionalParams = new HashMap<>();

    private String createdBy;
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;
}
