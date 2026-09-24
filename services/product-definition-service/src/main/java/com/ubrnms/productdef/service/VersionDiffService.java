package com.ubrnms.productdef.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ParameterRegistryEntry;
import com.ubrnms.productdef.model.ProductDefinitionVersion;
import com.ubrnms.productdef.model.VersionDiffResult;
import com.ubrnms.productdef.repository.ParameterRegistryRepository;
import com.ubrnms.productdef.repository.ProductDefinitionVersionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Compares parameter metadata between two uploaded Product Definition versions.
 *
 * <p>Registry entries are keyed by stable {@code productDefinitionId} (the definition ID)
 * with a {@code versionId} field on each entry. Only the active version's entries may
 * remain in MongoDB after activation; when registry rows are missing for a version,
 * parameters are rebuilt from persisted {@code normalizedMetadataJson} on the version record.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VersionDiffService {

    private final ProductDefinitionVersionRepository versionRepo;
    private final ParameterRegistryRepository        parameterRegistryRepo;
    private final ParameterRegistryBuilder           parameterRegistryBuilder;
    private final ObjectMapper                         objectMapper;

    public VersionDiffResult diff(String definitionId, String fromVersionId, String toVersionId) {
        ProductDefinitionVersion fromVersion = versionRepo
                .findByDefinitionIdAndVersionId(definitionId, fromVersionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "Version not found: definitionId=" + definitionId + " versionId=" + fromVersionId));
        ProductDefinitionVersion toVersion = versionRepo
                .findByDefinitionIdAndVersionId(definitionId, toVersionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "Version not found: definitionId=" + definitionId + " versionId=" + toVersionId));

        Map<String, ParameterRegistryEntry> fromParams = indexByParameterId(
                loadParametersForVersion(definitionId, fromVersionId, fromVersion));
        Map<String, ParameterRegistryEntry> toParams = indexByParameterId(
                loadParametersForVersion(definitionId, toVersionId, toVersion));

        List<VersionDiffResult.ParamChange> added = new ArrayList<>();
        List<VersionDiffResult.ParamChange> removed = new ArrayList<>();
        List<VersionDiffResult.ParamChange> modified = new ArrayList<>();
        List<VersionDiffResult.ParamChange> moved = new ArrayList<>();
        List<VersionDiffResult.ParamChange> permissionChanged = new ArrayList<>();

        for (Map.Entry<String, ParameterRegistryEntry> entry : toParams.entrySet()) {
            if (!fromParams.containsKey(entry.getKey())) {
                ParameterRegistryEntry p = entry.getValue();
                added.add(VersionDiffResult.ParamChange.builder()
                        .parameterId(p.getParameterId())
                        .label(p.getDisplayName())
                        .toGroupId(p.getGroupId())
                        .toDataType(p.getDataType())
                        .toReadOnly(p.isReadOnly())
                        .summary("Added parameter '" + p.getParameterId() + "' in group '" + p.getGroupId() + "'")
                        .build());
            }
        }

        for (Map.Entry<String, ParameterRegistryEntry> entry : fromParams.entrySet()) {
            if (!toParams.containsKey(entry.getKey())) {
                ParameterRegistryEntry p = entry.getValue();
                removed.add(VersionDiffResult.ParamChange.builder()
                        .parameterId(p.getParameterId())
                        .label(p.getDisplayName())
                        .fromGroupId(p.getGroupId())
                        .fromDataType(p.getDataType())
                        .fromReadOnly(p.isReadOnly())
                        .summary("Removed parameter '" + p.getParameterId() + "' from group '" + p.getGroupId() + "'")
                        .build());
            }
        }

        for (String parameterId : fromParams.keySet()) {
            if (!toParams.containsKey(parameterId)) {
                continue;
            }
            ParameterRegistryEntry from = fromParams.get(parameterId);
            ParameterRegistryEntry to = toParams.get(parameterId);

            if (!Objects.equals(from.getGroupId(), to.getGroupId())) {
                moved.add(VersionDiffResult.ParamChange.builder()
                        .parameterId(parameterId)
                        .label(to.getDisplayName() != null ? to.getDisplayName() : from.getDisplayName())
                        .fromGroupId(from.getGroupId())
                        .toGroupId(to.getGroupId())
                        .fromDataType(from.getDataType())
                        .toDataType(to.getDataType())
                        .fromReadOnly(from.isReadOnly())
                        .toReadOnly(to.isReadOnly())
                        .summary(String.format(
                                "Parameter '%s' moved from group '%s' to '%s'",
                                parameterId, from.getGroupId(), to.getGroupId()))
                        .build());
            }

            if (from.isReadOnly() != to.isReadOnly()) {
                permissionChanged.add(VersionDiffResult.ParamChange.builder()
                        .parameterId(parameterId)
                        .label(to.getDisplayName() != null ? to.getDisplayName() : from.getDisplayName())
                        .fromGroupId(from.getGroupId())
                        .toGroupId(to.getGroupId())
                        .fromReadOnly(from.isReadOnly())
                        .toReadOnly(to.isReadOnly())
                        .summary(String.format(
                                "Parameter '%s' readOnly changed from %s to %s",
                                parameterId, from.isReadOnly(), to.isReadOnly()))
                        .build());
            }

            if (metadataChanged(from, to)) {
                modified.add(VersionDiffResult.ParamChange.builder()
                        .parameterId(parameterId)
                        .label(to.getDisplayName())
                        .fromGroupId(from.getGroupId())
                        .toGroupId(to.getGroupId())
                        .fromDataType(from.getDataType())
                        .toDataType(to.getDataType())
                        .fromReadOnly(from.isReadOnly())
                        .toReadOnly(to.isReadOnly())
                        .summary(buildMetadataChangeSummary(from, to))
                        .build());
            }
        }

        return VersionDiffResult.builder()
                .definitionId(definitionId)
                .fromVersionId(fromVersionId)
                .toVersionId(toVersionId)
                .added(added)
                .removed(removed)
                .modified(modified)
                .moved(moved)
                .permissionChanged(permissionChanged)
                .build();
    }

    private List<ParameterRegistryEntry> loadParametersForVersion(
            String definitionId, String versionId, ProductDefinitionVersion versionRecord) {

        List<ParameterRegistryEntry> fromRegistry = parameterRegistryRepo
                .findByProductDefinitionId(definitionId)
                .stream()
                .filter(e -> versionId.equals(e.getVersionId()))
                .toList();

        if (!fromRegistry.isEmpty()) {
            return fromRegistry;
        }

        NormalizedProductDefinition normalized = parseNormalizedMetadata(versionRecord);
        if (normalized == null) {
            log.warn("No registry or normalized metadata for definition {} version {}", definitionId, versionId);
            return List.of();
        }

        return parameterRegistryBuilder.build(normalized, definitionId, versionId, 0L);
    }

    private NormalizedProductDefinition parseNormalizedMetadata(ProductDefinitionVersion version) {
        String json = version.getNormalizedMetadataJson();
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(json, NormalizedProductDefinition.class);
        } catch (Exception e) {
            log.error("Failed to parse normalizedMetadataJson for version {}", version.getVersionId(), e);
            return null;
        }
    }

    private static Map<String, ParameterRegistryEntry> indexByParameterId(List<ParameterRegistryEntry> entries) {
        return entries.stream()
                .filter(e -> e.getParameterId() != null && !e.getParameterId().isBlank())
                .collect(Collectors.toMap(
                        ParameterRegistryEntry::getParameterId,
                        Function.identity(),
                        (a, b) -> b,
                        LinkedHashMap::new));
    }

    private static boolean metadataChanged(ParameterRegistryEntry from, ParameterRegistryEntry to) {
        return !Objects.equals(nullToEmpty(from.getDataType()), nullToEmpty(to.getDataType()))
                || !Objects.equals(nullToEmpty(from.getUnit()), nullToEmpty(to.getUnit()))
                || !Objects.equals(nullToEmpty(from.getDisplayName()), nullToEmpty(to.getDisplayName()));
    }

    private static String buildMetadataChangeSummary(ParameterRegistryEntry from, ParameterRegistryEntry to) {
        List<String> parts = new ArrayList<>();
        if (!Objects.equals(nullToEmpty(from.getDisplayName()), nullToEmpty(to.getDisplayName()))) {
            parts.add("label '" + from.getDisplayName() + "' → '" + to.getDisplayName() + "'");
        }
        if (!Objects.equals(nullToEmpty(from.getDataType()), nullToEmpty(to.getDataType()))) {
            parts.add("dataType '" + from.getDataType() + "' → '" + to.getDataType() + "'");
        }
        if (!Objects.equals(nullToEmpty(from.getUnit()), nullToEmpty(to.getUnit()))) {
            parts.add("unit '" + from.getUnit() + "' → '" + to.getUnit() + "'");
        }
        return "Parameter '" + from.getParameterId() + "' modified: " + String.join(", ", parts);
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
