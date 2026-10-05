package com.ubrnms.productdef.service;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ParameterRegistryEntry;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Converts a {@link NormalizedProductDefinition} into {@link ParameterRegistryEntry} records.
 *
 * <p>One entry is produced per parameter in every parameter group of the definition.
 * Entries capture adapter mappings (SNMP OID, CLI command, REST API path, gRPC field path),
 * UI hints (display name, role visibility, thresholds), and data-type information needed
 * by the adaptive parameter panel and the alarm threshold evaluator.
 *
 * <p>This builder is stateless and deterministic — safe to call on every activation
 * or rollback.  Duplicate parameter IDs within the same group are detected and skipped
 * with a warning to prevent ambiguous registry state.
 */
@Slf4j
@Service
public class ParameterRegistryBuilder {

    /**
     * Builds the complete set of parameter registry entries for a product definition.
     *
     * @param normalized          the normalised metadata from the activated definition
     * @param productDefinitionId stable definition ID (e.g. {@code cisco-asr-1000})
     * @param versionId           version ID of the definition being activated
     * @param registryVersion     the new registry version counter to stamp on each entry
     * @return list of entries ready to be persisted; never null, may be empty
     */
    public List<ParameterRegistryEntry> build(
            NormalizedProductDefinition normalized,
            String productDefinitionId,
            String versionId,
            long registryVersion) {

        List<ParameterRegistryEntry> entries = new ArrayList<>();

        if (normalized.getParameterGroups() == null || normalized.getParameterGroups().isEmpty()) {
            log.warn("Definition {} version {} has no parameter groups — parameter registry will be empty",
                    productDefinitionId, versionId);
            return entries;
        }

        java.util.Map<String, Set<String>> seenByGroup = new java.util.HashMap<>();
        for (NormalizedProductDefinition.ParameterGroup group : normalized.getParameterGroups()) {
            if (group.getGroupName() == null || group.getGroupName().isBlank()) {
                log.warn("Skipping parameter group with null/blank groupName in definition {}",
                        productDefinitionId);
                continue;
            }
            if (group.getParameters() == null || group.getParameters().isEmpty()) {
                log.debug("Parameter group '{}' in definition {} is empty — skipping",
                        group.getGroupName(), productDefinitionId);
                continue;
            }

            // Track IDs within this group to detect duplicates
            // Keyed by group name so repeated group names cannot violate the unique index
            Set<String> seenIds = seenByGroup.computeIfAbsent(group.getGroupName(), k -> new HashSet<>());
            int fallbackOrder = 0;

            for (NormalizedProductDefinition.ParameterEntry param : group.getParameters()) {
                if (param.getId() == null || param.getId().isBlank()) {
                    log.warn("Skipping parameter with null/blank id in group '{}', definition {}",
                            group.getGroupName(), productDefinitionId);
                    continue;
                }

                // Duplicate parameter IDs within the same group are a data-quality problem.
                // Skip duplicates with a warning rather than persisting ambiguous entries.
                if (!seenIds.add(param.getId())) {
                    log.warn("Duplicate parameter id '{}' in group '{}' of definition {} — skipping duplicate",
                            param.getId(), group.getGroupName(), productDefinitionId);
                    continue;
                }

                int position = ++fallbackOrder;
                ParameterRegistryEntry entry = ParameterRegistryEntry.builder()
                        .productDefinitionId(productDefinitionId)
                        .versionId(versionId)
                        .groupId(group.getGroupName())
                        .parameterId(param.getId())
                        .displayName(param.getDisplayName())
                        .dataType(param.getDataType())
                        .unit(param.getUnit())
                        .defaultValue(param.getDefaultValue())
                        .minValue(param.getMinValue())
                        .maxValue(param.getMaxValue())
                        .enumValues(param.getEnumValues())
                        // adapter mappings
                        .snmpOid(param.getSnmpOid())
                        .cliCommand(param.getCliCommand())
                        .cliParseRegex(param.getCliParseRegex())
                        .apiPath(param.getApiPath())
                        .grpcPath(param.getGrpcPath())
                        // UI metadata
                        .uiVisibleTo(param.getUiVisibleTo())
                        .thresholdHigh(param.getThresholdHigh())
                        .thresholdLow(param.getThresholdLow())
                        .subGroup(param.getSubGroup())
                        .uiWidget(param.getUiWidget())
                        .readOnly(Boolean.TRUE.equals(param.getReadOnly()))
                        .displayOrder(param.getDisplayOrder() > 0 ? param.getDisplayOrder() : position)
                        .registryVersion(registryVersion)
                        .build();

                entries.add(entry);
            }
        }

        log.debug("Built {} parameter registry entries for definition {} version {} at registryVersion={}",
                entries.size(), productDefinitionId, versionId, registryVersion);
        return entries;
    }
}
