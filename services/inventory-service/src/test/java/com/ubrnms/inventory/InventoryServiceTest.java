package com.ubrnms.inventory;

import com.ubrnms.inventory.model.BirthCertificate;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.model.DeviceTag;
import com.ubrnms.inventory.repository.BirthCertificateRepository;
import com.ubrnms.inventory.repository.DeviceRepository;
import com.ubrnms.inventory.service.InventoryService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.kafka.core.KafkaTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class InventoryServiceTest {

    @Mock private DeviceRepository deviceRepo;
    @Mock private BirthCertificateRepository bcRepo;
    @Mock private KafkaTemplate<String, String> kafkaTemplate;
    @InjectMocks private InventoryService service;

    @BeforeEach
    void injectObjectMapper() throws Exception {
        var field = InventoryService.class.getDeclaredField("objectMapper");
        field.setAccessible(true);
        field.set(service, new ObjectMapper().registerModule(new JavaTimeModule()));
        var topicField = InventoryService.class.getDeclaredField("inventorySyncTopic");
        topicField.setAccessible(true);
        topicField.set(service, "inventory-sync");
        var radiusField = InventoryService.class.getDeclaredField("defaultRadiusKm");
        radiusField.setAccessible(true);
        radiusField.set(service, 1.0);
    }

    @Test
    void createDevice_persistsAndPublishes() {
        Device d = new Device();
        d.setSerialNumber("SN-001");
        d.setMacAddress("AA:BB:CC:DD:EE:FF");
        d.setIpAddress("10.0.0.1");
        d.setLatitude(1.0);
        d.setLongitude(103.0);

        when(deviceRepo.save(any())).thenReturn(d);
        Device result = service.createDevice(d);

        assertThat(result.getSerialNumber()).isEqualTo("SN-001");
        verify(deviceRepo).save(d);
        verify(kafkaTemplate).send(eq("inventory-sync"), eq("SN-001"), anyString());
    }

    @Test
    void updateDevice_throwsWhenNotFound() {
        when(deviceRepo.findById("nonexistent")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.updateDevice("nonexistent", new Device()))
                .isInstanceOf(InventoryService.ResourceNotFoundException.class);
    }

    @Test
    void createBirthCertificate_immutableAfterCreation() {
        BirthCertificate bc = new BirthCertificate();
        bc.setSerialNumber("SN-002");

        when(bcRepo.findBySerialNumber("SN-002")).thenReturn(Optional.empty());
        when(bcRepo.save(any())).thenReturn(bc);

        BirthCertificate saved = service.createBirthCertificate(bc);
        assertThat(saved.getSerialNumber()).isEqualTo("SN-002");
        assertThat(saved.getCapturedAt()).isNotNull();
    }

    @Test
    void createBirthCertificate_conflictIfAlreadyExists() {
        when(bcRepo.findBySerialNumber("SN-003")).thenReturn(Optional.of(new BirthCertificate()));
        BirthCertificate bc = new BirthCertificate();
        bc.setSerialNumber("SN-003");
        assertThatThrownBy(() -> service.createBirthCertificate(bc))
                .isInstanceOf(InventoryService.ConflictException.class);
    }

    @Test
    void updateTags_replacesTagsOnDevice() {
        Device d = new Device();
        d.setId("dev-001");
        d.setSerialNumber("SN-004");

        when(deviceRepo.findById("dev-001")).thenReturn(Optional.of(d));
        when(deviceRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        DeviceTag tag = new DeviceTag();
        tag.setType("circle");
        tag.setValue("North Circle");

        Device result = service.updateTags("dev-001", List.of(tag));
        assertThat(result.getTags()).hasSize(1);
        assertThat(result.getTags().get(0).getValue()).isEqualTo("North Circle");
    }

    @Test
    void upsertFromDiscovery_createsNewDevice() {
        when(deviceRepo.findBySerialNumber("SN-005")).thenReturn(Optional.empty());
        when(deviceRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Map<String, Object> event = Map.of(
            "serialNumber", "SN-005",
            "macAddress", "11:22:33:44:55:66",
            "ipAddress", "192.168.1.10",
            "deviceType", "BTS",
            "softwareVersion", "v3.0",
            "latitude", 1.3,
            "longitude", 103.8
        );

        Device result = service.upsertFromDiscovery(event);
        assertThat(result.getSerialNumber()).isEqualTo("SN-005");
        assertThat(result.getStatus()).isEqualTo("ACTIVE");
        verify(kafkaTemplate).send(eq("inventory-sync"), eq("SN-005"), anyString());
    }
}
