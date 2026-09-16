package com.ubrnms.productdef.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ubrnms.productdef.model.*;
import com.ubrnms.productdef.repository.ProductDefinitionVersionRepository;
import com.ubrnms.productdef.repository.ValidationReportRepository;
import com.ubrnms.productdef.validation.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * Core business logic for Product Definition ingestion.
 *
 * <p>Responsibilities:
 * <ol>
 *   <li>Detect the file format (XML / XLS / JSON) from content-type and/or magic bytes.</li>
 *   <li>Delegate parsing to the appropriate format parser.</li>
 *   <li>Run validation through {@link ProductDefinitionValidationService}.</li>
 *   <li>Generate deterministic {@code definitionId} and {@code versionId}.</li>
 *   <li>Detect duplicate uploads by SHA-256 content hash.</li>
 *   <li>Persist {@link ProductDefinitionVersion} and {@link ValidationReport}.</li>
 * </ol>
 *
 * <p>This service throws {@link IllegalArgumentException} for client errors (4xx) and
 * {@link IllegalStateException} for server-side failures (5xx).  Controllers must catch
 * and translate them to the correct HTTP status.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProductDefinitionService {

    private final XmlProductDefinitionParser  xmlParser;
    private final XlsProductDefinitionParser  xlsParser;
    private final JsonProductDefinitionParser jsonParser;
    private final ProductDefinitionValidationService validationService;
    private final ProductDefinitionVersionRepository versionRepository;
    private final ValidationReportRepository         reportRepository;
    private final ObjectMapper objectMapper;

    // ── Upload entry point ────────────────────────────────────────────────────

    /**
     * Ingests an uploaded product definition file.
     *
     * @param fileBytes      raw file bytes
     * @param contentType    MIME type declared by the client (e.g. {@code application/xml})
     * @param description    optional operator description
     * @param actorUserId    authenticated user's ID
     * @param actorUsername  authenticated user's username
     * @param actorRole      authenticated user's role
     * @param correlationId  request correlation ID from gateway headers
     * @return the persisted {@link ProductDefinitionVersion}
     */
    public ProductDefinitionVersion upload(byte[] fileBytes,
                                            String contentType,
                                            String description,
                                            String actorUserId,
                                            String actorUsername,
                                            String actorRole,
                                            String correlationId) {

        if (fileBytes == null || fileBytes.length == 0)
            throw new IllegalArgumentException("Upload file is empty — no data received");

        String format = detectFormat(fileBytes, contentType);
        String contentHash = sha256Hex(fileBytes);

        // Duplicate detection — same bytes already uploaded
        Optional<ProductDefinitionVersion> existing = versionRepository.findByContentHash(contentHash);
        if (existing.isPresent()) {
            log.info("[{}] Duplicate upload detected for hash {} — returning existing version {}",
                    correlationId, contentHash, existing.get().getVersionId());
            throw new IllegalArgumentException(
                    "This file has already been uploaded (versionId=" + existing.get().getVersionId()
                    + "). Upload a new file to create a new version.");
        }

        // Parse
        List<ValidationError> parseErrors = new ArrayList<>();
        NormalizedProductDefinition normalized = parse(fileBytes, format, parseErrors);

        // Generate IDs
        String definitionId = (normalized != null && normalized.getVendor() != null && normalized.getModel() != null)
                ? buildDefinitionId(normalized.getVendor(), normalized.getModel())
                : "unknown-" + contentHash.substring(0, 8);
        String versionId = UUID.randomUUID().toString();

        // Validate (skip structural validation if parsing already failed)
        ValidationReport report;
        if (normalized == null) {
            report = ValidationReport.builder()
                    .definitionId(definitionId)
                    .versionId(versionId)
                    .status("INVALID")
                    .errors(parseErrors)
                    .warnings(List.of())
                    .parameterCount(0)
                    .fingerprintCount(0)
                    .protocolCount(0)
                    .normalizedSummary("Parse failed — see errors")
                    .correlationId(correlationId)
                    .build();
        } else {
            report = validationService.validate(normalized, definitionId, versionId, correlationId);
            // Append any parse-phase warnings
            if (!parseErrors.isEmpty()) {
                List<ValidationError> allErrors = new ArrayList<>(report.getErrors());
                allErrors.addAll(parseErrors);
                report.setErrors(allErrors);
                report.setStatus("INVALID");
            }
        }

        // Build version record
        String normalizedJson = null;
        if (normalized != null) {
            try {
                normalizedJson = objectMapper.writeValueAsString(Map.of(
                        "name",    normalized.getName()   != null ? normalized.getName()   : "",
                        "vendor",  normalized.getVendor() != null ? normalized.getVendor() : "",
                        "model",   normalized.getModel()  != null ? normalized.getModel()  : "",
                        "fingerprints",    normalized.getFingerprints()      == null ? 0 : normalized.getFingerprints().size(),
                        "protocols",       normalized.getSupportedProtocols() == null ? 0 : normalized.getSupportedProtocols().size(),
                        "parameterGroups", normalized.getParameterGroups()   == null ? 0 : normalized.getParameterGroups().size()
                ));
            } catch (Exception e) {
                log.warn("[{}] Failed to serialize normalized summary — storing null", correlationId);
            }
        }

        ProductDefinitionVersion version = new ProductDefinitionVersion();
        version.setDefinitionId(definitionId);
        version.setVersionId(versionId);
        version.setName(normalized != null ? normalized.getName() : null);
        version.setVendor(normalized != null ? normalized.getVendor() : null);
        version.setModel(normalized != null ? normalized.getModel() : null);
        version.setLifecycleStatus("DRAFT");
        version.setValidationStatus(report.getStatus());
        version.setContentHash(contentHash);
        version.setUploadedFormat(format);
        version.setDescription(description);
        version.setActorUserId(actorUserId);
        version.setActorUsername(actorUsername);
        version.setActorRole(actorRole);
        version.setCorrelationId(correlationId);
        version.setNormalizedMetadataJson(normalizedJson);

        ProductDefinitionVersion saved = versionRepository.save(version);
        reportRepository.save(report);

        log.info("[{}] Persisted product definition version {} for definition {} — status={}",
                correlationId, versionId, definitionId, report.getStatus());

        return saved;
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    public ProductDefinitionVersion getVersion(String definitionId, String versionId) {
        return versionRepository.findByDefinitionIdAndVersionId(definitionId, versionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "No version found for definitionId=" + definitionId + " versionId=" + versionId));
    }

    public List<ProductDefinitionVersion> listVersions(String definitionId) {
        return versionRepository.findByDefinitionIdOrderByCreatedAtDesc(definitionId);
    }

    public ValidationReport getReport(String definitionId, String versionId) {
        return reportRepository.findByDefinitionIdAndVersionId(definitionId, versionId)
                .orElseThrow(() -> new NoSuchElementException(
                        "No report found for definitionId=" + definitionId + " versionId=" + versionId));
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Detects the file format.  Content-type is checked first; magic-byte sniffing is
     * used as fallback for clients that send an incorrect or generic MIME type.
     */
    private String detectFormat(byte[] bytes, String contentType) {
        if (contentType != null) {
            String ct = contentType.toLowerCase();
            if (ct.contains("xml"))                  return "XML";
            if (ct.contains("spreadsheet") || ct.contains("excel") || ct.contains("xls")) return "XLS";
            if (ct.contains("json"))                 return "JSON";
        }
        // Magic bytes: XLSX = PK\x03\x04 (ZIP); XML = <?xml or <
        if (bytes.length >= 4
                && bytes[0] == 0x50 && bytes[1] == 0x4B
                && bytes[2] == 0x03 && bytes[3] == 0x04) return "XLS";
        String prefix = new String(bytes, 0, Math.min(bytes.length, 100), StandardCharsets.UTF_8).trim();
        if (prefix.startsWith("<?xml") || prefix.startsWith("<"))  return "XML";
        if (prefix.startsWith("{") || prefix.startsWith("["))       return "JSON";
        throw new IllegalArgumentException(
                "Unable to determine file format — supply Content-Type: application/xml, "
                + "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, or application/json");
    }

    private NormalizedProductDefinition parse(byte[] bytes, String format, List<ValidationError> errors) {
        return switch (format) {
            case "XML"  -> xmlParser.parse(bytes, errors);
            case "XLS"  -> xlsParser.parse(bytes, errors);
            case "JSON" -> jsonParser.parse(bytes, errors);
            default -> throw new IllegalArgumentException("Unsupported format: " + format);
        };
    }

    /**
     * Builds a stable, URL-safe definitionId from vendor + model.
     * Example: "cisco" + "ASR 1000" → "cisco-asr-1000"
     */
    private String buildDefinitionId(String vendor, String model) {
        return (vendor + "-" + model)
                .toLowerCase()
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("^-|-$", "");
    }

    private String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(bytes);
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable — JVM configuration error", e);
        }
    }
}
