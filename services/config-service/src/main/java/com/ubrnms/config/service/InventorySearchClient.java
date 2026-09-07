package com.ubrnms.config.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.config.model.ConfigTargetPreviewRequest.TargetFilters;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;

/**
 * HTTP client for querying the inventory service device search API (WO-039).
 *
 * <p>Translates {@link TargetFilters} into inventory query parameters and
 * returns a raw list of device attribute maps.  Caller is responsible for
 * mapping these to target entries.
 *
 * <p>On any transport or parsing error, returns an empty list so that
 * {@link TargetResolverService} can propagate a structured 503 to the caller.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class InventorySearchClient {

    private final ObjectMapper objectMapper;

    @Value("${inventory.service.url:http://nms-inventory:8082}")
    private String inventoryUrl;

    /** Timeout per inventory HTTP request. */
    private static final Duration HTTP_TIMEOUT = Duration.ofSeconds(10);

    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();

    /**
     * Queries inventory with the provided filters, paging up to {@code limit} records.
     * Returns a raw list of device attribute maps (never null).
     *
     * @throws InventoryServiceException if inventory returns a non-2xx status
     */
    public List<Map<String, Object>> search(TargetFilters filters, int limit) {
        if (filters == null) return Collections.emptyList();

        UriComponentsBuilder uriBuilder = UriComponentsBuilder
            .fromUriString(inventoryUrl)
            .path("/api/v1/devices")
            .queryParam("limit", Math.min(limit, 2000));

        if (isSet(filters.getDeviceType()))       uriBuilder.queryParam("deviceType",        filters.getDeviceType());
        if (isSet(filters.getSysObjectID()))       uriBuilder.queryParam("sysObjectID",       filters.getSysObjectID());
        if (isSet(filters.getVendor()))            uriBuilder.queryParam("vendor",            filters.getVendor());
        if (isSet(filters.getModel()))             uriBuilder.queryParam("model",             filters.getModel());
        if (isSet(filters.getRegion()))            uriBuilder.queryParam("region",            filters.getRegion());
        if (isSet(filters.getOrganizationId()))    uriBuilder.queryParam("organizationId",    filters.getOrganizationId());
        if (isSet(filters.getNetworkId()))         uriBuilder.queryParam("networkId",         filters.getNetworkId());
        if (isSet(filters.getDiscoveryParadigm())) uriBuilder.queryParam("discoveryParadigm", filters.getDiscoveryParadigm());
        if (isSet(filters.getStatus()))            uriBuilder.queryParam("status",            filters.getStatus());
        if (isSet(filters.getCapabilityProfileId())) uriBuilder.queryParam("capabilityProfileId", filters.getCapabilityProfileId());
        if (isSet(filters.getIpAddress()))         uriBuilder.queryParam("ipAddress",         filters.getIpAddress());
        if (isSet(filters.getOnboardingGateState())) uriBuilder.queryParam("onboardingGateState", filters.getOnboardingGateState());

        if (filters.getSerialNumbers() != null && !filters.getSerialNumbers().isEmpty()) {
            filters.getSerialNumbers().forEach(sn -> uriBuilder.queryParam("serialNumber", sn));
        }
        if (filters.getMacAddresses() != null && !filters.getMacAddresses().isEmpty()) {
            filters.getMacAddresses().forEach(mac -> uriBuilder.queryParam("macAddress", mac));
        }

        URI uri = uriBuilder.build().toUri();
        log.debug("Inventory search: {}", uri);

        try {
            HttpRequest req = HttpRequest.newBuilder()
                .uri(uri)
                .timeout(HTTP_TIMEOUT)
                .GET()
                .build();

            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() < 200 || resp.statusCode() >= 300) {
                log.warn("Inventory search returned status={} uri={}", resp.statusCode(), uri);
                throw new InventoryServiceException(resp.statusCode(),
                    "Inventory service returned HTTP " + resp.statusCode());
            }

            return parseDeviceList(resp.body());
        } catch (InventoryServiceException e) {
            throw e;
        } catch (IOException | InterruptedException e) {
            Thread.currentThread().interrupt();
            log.error("Inventory search transport failure uri={}", uri, e);
            throw new InventoryServiceException(503, "Inventory service unreachable: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> parseDeviceList(String body) {
        try {
            Object parsed = objectMapper.readValue(body, Object.class);
            if (parsed instanceof List<?> list) {
                return (List<Map<String, Object>>) list;
            }
            if (parsed instanceof Map<?, ?> map) {
                // Spring paginated response: {"content": [...], "totalElements": N}
                Object content = map.get("content");
                if (content instanceof List<?> list) return (List<Map<String, Object>>) list;
                // Fall through to devices key variants
                for (String key : new String[]{"data", "devices", "items"}) {
                    if (map.get(key) instanceof List<?> l) return (List<Map<String, Object>>) l;
                }
            }
            return Collections.emptyList();
        } catch (Exception e) {
            log.warn("Failed to parse inventory response body; returning empty list", e);
            return Collections.emptyList();
        }
    }

    private static boolean isSet(String v) {
        return v != null && !v.isBlank();
    }

    /** Thrown when the inventory service returns a non-2xx response. */
    public static class InventoryServiceException extends RuntimeException {
        public final int status;
        public InventoryServiceException(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
