package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.FingerprintRegistryEntry;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ProductDefinitionActiveVersion;
import com.ubrnms.productdef.repository.FingerprintRegistryRepository;
import com.ubrnms.productdef.repository.ProductDefinitionActiveVersionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Detects activation conflicts before a Product Definition version is committed active.
 *
 * <p>Conflict checks guard against:
 * <ol>
 *   <li>Exact duplicate fingerprints — two active definitions sharing an identical sysObjectId
 *       and overlapping firmware ranges would make discovery ambiguous.</li>
 *   <li>Overlapping banner / sysDescr patterns — substring patterns that could match the
 *       same device banner text simultaneously.</li>
 *   <li>Overlapping firmware ranges — two active definitions for the same vendor+model
 *       with ranges that intersect, making firmware-range-based selection ambiguous.</li>
 *   <li>Duplicate parameter identifiers — parameter IDs that are not unique within a
 *       group, which would produce ambiguous polling and display behaviour.</li>
 * </ol>
 *
 * <p>Unsupported protocol references (e.g. an adapter mapping for a protocol not listed
 * in {@code supportedProtocols}) are flagged as warnings rather than hard blocks, because
 * partial mappings may be intentional during incremental rollout.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductDefinitionConflictService {

    private final FingerprintRegistryRepository      fingerprintRepo;
    private final ProductDefinitionActiveVersionRepository activeVersionRepo;

    /**
     * Result object returned by {@link #detect}.  Non-empty {@code conflicts} means
     * activation must be rejected; non-empty {@code warnings} are informational.
     */
    public record ConflictResult(List<String> conflicts, List<String> warnings) {
        public boolean hasConflicts() { return !conflicts.isEmpty(); }
    }

    /**
     * Runs all conflict checks for the given definition and normalized metadata.
     *
     * <p>Checks are run in full even after the first conflict is found so the caller
     * can return a comprehensive error message rather than requiring the operator to
     * fix and retry one conflict at a time.
     *
     * @param productDefinitionId the definition being activated (excluded from self-conflict checks)
     * @param normalized          the normalised metadata of the version being activated
     * @return a {@link ConflictResult} containing any conflicts and warnings
     */
    public ConflictResult detect(String productDefinitionId, NormalizedProductDefinition normalized) {
        List<String> conflicts = new ArrayList<>();
        List<String> warnings  = new ArrayList<>();

        checkFingerprintConflicts(productDefinitionId, normalized, conflicts);
        checkFirmwareRangeOverlap(productDefinitionId, normalized, conflicts);
        checkDuplicateParameterIds(normalized, conflicts);
        checkUnsupportedProtocolReferences(normalized, warnings);

        return new ConflictResult(conflicts, warnings);
    }

    // ── Private check methods ─────────────────────────────────────────────────

    /**
     * Checks for exact duplicate sysObjectId fingerprints and overlapping banner patterns
     * from other active definitions.
     */
    private void checkFingerprintConflicts(
            String productDefinitionId,
            NormalizedProductDefinition normalized,
            List<String> conflicts) {

        if (normalized.getFingerprints() == null) return;

        for (NormalizedProductDefinition.FingerprintEntry fp : normalized.getFingerprints()) {
            if (fp.getSysObjectId() == null) continue;

            List<FingerprintRegistryEntry> existing = fingerprintRepo.findByFingerprintValue(fp.getSysObjectId());
            for (FingerprintRegistryEntry entry : existing) {
                // Skip entries from the same definition (self-activation or re-activation)
                if (productDefinitionId.equals(entry.getProductDefinitionId())) continue;

                if (firmwareRangesOverlap(
                        fp.getFirmwareFrom() != null ? fp.getFirmwareFrom() : normalized.getFirmwareFrom(),
                        fp.getFirmwareTo()   != null ? fp.getFirmwareTo()   : normalized.getFirmwareTo(),
                        entry.getFirmwareFrom(),
                        entry.getFirmwareTo())) {
                    conflicts.add(String.format(
                            "CONFLICTING_FINGERPRINT: sysObjectId '%s' overlaps with active definition '%s' "
                          + "(firmwareRange: [%s, %s]). Two definitions cannot share an exact fingerprint "
                          + "within overlapping firmware ranges.",
                            fp.getSysObjectId(), entry.getProductDefinitionId(),
                            entry.getFirmwareFrom(), entry.getFirmwareTo()));
                }
            }

            // Check banner pattern overlaps for the same OID
            if (fp.getSysDescrPattern() != null && !fp.getSysDescrPattern().isBlank()) {
                List<FingerprintRegistryEntry> bannerExisting =
                        fingerprintRepo.findByFingerprintValue(fp.getSysDescrPattern());
                for (FingerprintRegistryEntry entry : bannerExisting) {
                    if (productDefinitionId.equals(entry.getProductDefinitionId())) continue;
                    conflicts.add(String.format(
                            "CONFLICTING_FINGERPRINT: sysDescr pattern '%s' overlaps with active definition '%s'. "
                          + "Substring banner patterns that match the same text create ambiguous fingerprint resolution.",
                            fp.getSysDescrPattern(), entry.getProductDefinitionId()));
                }
            }
        }
    }

    /**
     * Checks whether another active definition for the same vendor+model has an
     * overlapping firmware range.
     */
    private void checkFirmwareRangeOverlap(
            String productDefinitionId,
            NormalizedProductDefinition normalized,
            List<String> conflicts) {

        if (normalized.getVendor() == null || normalized.getModel() == null) return;

        List<ProductDefinitionActiveVersion> activeForModel =
                activeVersionRepo.findByVendorAndModel(normalized.getVendor(), normalized.getModel());

        for (ProductDefinitionActiveVersion active : activeForModel) {
            if (productDefinitionId.equals(active.getProductDefinitionId())) continue;

            if (firmwareRangesOverlap(
                    normalized.getFirmwareFrom(), normalized.getFirmwareTo(),
                    active.getFirmwareFrom(),     active.getFirmwareTo())) {
                conflicts.add(String.format(
                        "CONFLICTING_FIRMWARE_RANGE: definition '%s' for %s %s firmware [%s, %s] "
                      + "overlaps with active definition '%s' firmware [%s, %s]. "
                      + "Overlapping firmware ranges for the same vendor+model make selection ambiguous.",
                        productDefinitionId, normalized.getVendor(), normalized.getModel(),
                        normalized.getFirmwareFrom(), normalized.getFirmwareTo(),
                        active.getProductDefinitionId(), active.getFirmwareFrom(), active.getFirmwareTo()));
            }
        }
    }

    /**
     * Checks that all parameter IDs within each group are unique.
     * Duplicate IDs within a group would produce ambiguous polling and display behaviour.
     */
    private void checkDuplicateParameterIds(
            NormalizedProductDefinition normalized,
            List<String> conflicts) {

        if (normalized.getParameterGroups() == null) return;

        for (NormalizedProductDefinition.ParameterGroup group : normalized.getParameterGroups()) {
            if (group.getParameters() == null) continue;

            Set<String> seen = new HashSet<>();
            for (NormalizedProductDefinition.ParameterEntry param : group.getParameters()) {
                if (param.getId() != null && !seen.add(param.getId())) {
                    conflicts.add(String.format(
                            "DUPLICATE_PARAMETER_ID: parameter id '%s' appears more than once in group '%s'. "
                          + "Parameter IDs must be unique within a group.",
                            param.getId(), group.getGroupName()));
                }
            }
        }
    }

    /**
     * Warns when a parameter's adapter mapping references a protocol not listed in
     * {@code supportedProtocols}.  This is a warning rather than a hard conflict
     * because partial mappings may be intentional.
     */
    private void checkUnsupportedProtocolReferences(
            NormalizedProductDefinition normalized,
            List<String> warnings) {

        List<String> declared = normalized.getSupportedProtocols() != null
                ? normalized.getSupportedProtocols()
                : List.of();

        if (normalized.getParameterGroups() == null) return;

        for (NormalizedProductDefinition.ParameterGroup group : normalized.getParameterGroups()) {
            if (group.getParameters() == null) continue;

            for (NormalizedProductDefinition.ParameterEntry param : group.getParameters()) {
                if (param.getSnmpOid()    != null && !declared.contains("SNMP"))
                    warnings.add(param.getId() + " references SNMP mapping but SNMP not in supportedProtocols");
                if (param.getCliCommand() != null && !declared.contains("CLI"))
                    warnings.add(param.getId() + " references CLI mapping but CLI not in supportedProtocols");
                if (param.getApiPath()    != null && !declared.contains("REST"))
                    warnings.add(param.getId() + " references REST mapping but REST not in supportedProtocols");
                if (param.getGrpcPath()   != null && !declared.contains("GRPC"))
                    warnings.add(param.getId() + " references GRPC mapping but GRPC not in supportedProtocols");
            }
        }
    }

    /**
     * Returns true when two firmware ranges overlap.
     *
     * <p>A null range bound is treated as "unbounded" — a definition with null firmware
     * bounds applies to all firmware versions and therefore overlaps with any other range.
     * Two null-bounded definitions for the same product identity always conflict.
     */
    public static boolean firmwareRangesOverlap(String aFrom, String aTo, String bFrom, String bTo) {
        // If either definition covers all firmware versions (null bounds), they overlap
        if (aFrom == null || aTo == null || bFrom == null || bTo == null) return true;

        // Lexicographic comparison for version strings (e.g. "21.Q1" < "23.Q4")
        // aFrom <= bTo AND bFrom <= aTo
        return aFrom.compareTo(bTo) <= 0 && bFrom.compareTo(aTo) <= 0;
    }
}
