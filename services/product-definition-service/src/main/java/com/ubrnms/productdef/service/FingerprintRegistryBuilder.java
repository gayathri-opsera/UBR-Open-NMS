package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.FingerprintRegistryEntry;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Converts a {@link NormalizedProductDefinition} into {@link FingerprintRegistryEntry} records.
 *
 * <p>One entry is produced per {@link NormalizedProductDefinition.FingerprintEntry} declared
 * in the definition.  Each entry captures the fingerprint value, type, product identity,
 * firmware range, and protocol hints needed by the discovery service to resolve inbound
 * device signatures to a specific product definition without re-parsing the full definition.
 *
 * <p>This builder is stateless and deterministic — given the same input it always produces
 * the same output, making it safe to call on every activation or rollback.
 */
@Slf4j
@Service
public class FingerprintRegistryBuilder {

    /**
     * Builds the complete set of fingerprint registry entries for a product definition.
     *
     * @param normalized        the normalised metadata from the activated definition
     * @param productDefinitionId stable definition ID (e.g. {@code cisco-asr-1000})
     * @param versionId         version ID of the definition being activated
     * @param registryVersion   the new registry version counter to stamp on each entry
     * @return list of entries ready to be persisted; never null, may be empty
     */
    public List<FingerprintRegistryEntry> build(
            NormalizedProductDefinition normalized,
            String productDefinitionId,
            String versionId,
            long registryVersion) {

        List<FingerprintRegistryEntry> entries = new ArrayList<>();

        if (normalized.getFingerprints() == null || normalized.getFingerprints().isEmpty()) {
            log.warn("Definition {} version {} has no fingerprints — registry will be empty",
                    productDefinitionId, versionId);
            return entries;
        }

        List<String> protocols = normalized.getSupportedProtocols() != null
                ? normalized.getSupportedProtocols()
                : List.of();

        for (NormalizedProductDefinition.FingerprintEntry fp : normalized.getFingerprints()) {
            boolean hasOid     = fp.getSysObjectId()    != null && !fp.getSysObjectId().isBlank();
            boolean hasBanner  = fp.getSysDescrPattern() != null && !fp.getSysDescrPattern().isBlank();

            if (!hasOid && !hasBanner) {
                // Truly empty fingerprint — skip and warn so operators know to fix the definition
                log.warn("Skipping completely empty fingerprint (no sysObjectId and no sysDescrPattern) "
                        + "in definition {} — add at least one identifier", productDefinitionId);
                continue;
            }

            // Determine firmware range: fingerprint-level overrides definition-level
            String fwFrom = (fp.getFirmwareFrom() != null) ? fp.getFirmwareFrom() : normalized.getFirmwareFrom();
            String fwTo   = (fp.getFirmwareTo()   != null) ? fp.getFirmwareTo()   : normalized.getFirmwareTo();

            // ── SNMP OID entry (classic SNMP sysObjectID fingerprint) ─────────
            if (hasOid) {
                FingerprintRegistryEntry oidEntry = FingerprintRegistryEntry.builder()
                        .productDefinitionId(productDefinitionId)
                        .versionId(versionId)
                        .fingerprintType("SNMP_OID")
                        .fingerprintValue(fp.getSysObjectId())
                        .sysObjectId(fp.getSysObjectId())
                        .sysDescrPattern(fp.getSysDescrPattern())   // carry pattern too if present
                        .vendor(normalized.getVendor())
                        .model(normalized.getModel())
                        .productFamily(normalized.getProductFamily())
                        .deviceType(normalized.getDeviceType())
                        .firmwareFrom(fwFrom)
                        .firmwareTo(fwTo)
                        .supportedProtocols(protocols)
                        .registryVersion(registryVersion)
                        .build();
                entries.add(oidEntry);
            }

            // ── Pattern / banner entry (SSH banner, HTTP header, sysDescr regex) ──
            // Created when sysDescrPattern is present — regardless of whether sysObjectId
            // is also present.  This supports devices discovered via REST/SSH/banner
            // that have no SNMP agent (e.g. EOC640 backhaul radios, non-SNMP CPEs).
            if (hasBanner) {
                FingerprintRegistryEntry bannerEntry = FingerprintRegistryEntry.builder()
                        .productDefinitionId(productDefinitionId)
                        .versionId(versionId)
                        .fingerprintType("BANNER")
                        .fingerprintValue(fp.getSysDescrPattern())
                        .sysObjectId(fp.getSysObjectId())           // may be null for banner-only devices
                        .sysDescrPattern(fp.getSysDescrPattern())
                        .vendor(normalized.getVendor())
                        .model(normalized.getModel())
                        .productFamily(normalized.getProductFamily())
                        .deviceType(normalized.getDeviceType())
                        .firmwareFrom(fwFrom)
                        .firmwareTo(fwTo)
                        .supportedProtocols(protocols)
                        .registryVersion(registryVersion)
                        .build();
                entries.add(bannerEntry);
                log.debug("Created BANNER fingerprint entry '{}' for definition {}",
                        fp.getSysDescrPattern(), productDefinitionId);
            }

            if (!hasOid) {
                log.info("Definition {} uses banner-only fingerprint '{}' (no SNMP OID) — "
                        + "discovery will match via sysDescrPattern", productDefinitionId, fp.getSysDescrPattern());
            }
        }

        log.debug("Built {} fingerprint registry entries for definition {} version {} at registryVersion={}",
                entries.size(), productDefinitionId, versionId, registryVersion);
        return entries;
    }
}
