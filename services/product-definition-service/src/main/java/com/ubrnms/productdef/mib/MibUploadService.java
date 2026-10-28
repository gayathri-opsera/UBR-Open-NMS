package com.ubrnms.productdef.mib;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Orchestrates the MIB upload → parse → XML generation pipeline.
 *
 * <p>Workflow:
 * <ol>
 *   <li>Accept raw MIB file bytes and filename.</li>
 *   <li>Delegate to {@link MibParser} to extract all OBJECT-TYPE definitions with
 *       correct OID, type, access, and index classification.</li>
 *   <li>Delegate to {@link MibToDescriptorGenerator} to produce a discovery XML
 *       conforming to {@code urn:nms:productdef:1.0}.</li>
 *   <li>Return a structured response containing the parsed object list, statistics,
 *       and the generated XML — the caller (controller) can then submit the XML
 *       through the standard upload pipeline.</li>
 * </ol>
 *
 * <p>The generated XML can be submitted directly to
 * {@code POST /api/v1/framework/product-definitions/upload} as {@code Content-Type: application/xml}
 * and will enter the normal Validate → Stage → Activate lifecycle. No special handling
 * is required downstream; the MIB origin is recorded in the XML comment header.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MibUploadService {

    private final MibParser              mibParser;
    private final MibToDescriptorGenerator generator;

    /**
     * Parses a MIB file and generates the discovery XML descriptor.
     *
     * @param bytes    raw bytes of the uploaded MIB file
     * @param filename original filename from the multipart upload
     * @return structured result with parsed objects, statistics, and generated XML
     * @throws IllegalArgumentException if the file is empty or cannot be parsed as a MIB
     */
    public ParsedMibResult parseMibAndGenerateXml(byte[] bytes, String filename) {
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("MIB file is empty — no data received");
        }

        // Validate file looks like a MIB (heuristic: must contain OBJECT-TYPE or DEFINITIONS)
        String preview = new String(bytes, 0, Math.min(bytes.length, 2000),
                java.nio.charset.StandardCharsets.UTF_8).toUpperCase();
        if (!preview.contains("OBJECT-TYPE") && !preview.contains("DEFINITIONS")
                && !preview.contains("MODULE-IDENTITY")) {
            throw new IllegalArgumentException(
                    "File does not appear to be a MIB file. "
                    + "Expected OBJECT-TYPE, MODULE-IDENTITY, or DEFINITIONS ::= BEGIN declarations.");
        }

        log.info("Parsing MIB file: {} ({} bytes)", filename, bytes.length);

        // Parse the MIB
        ParsedMibResult result = mibParser.parse(bytes, filename);

        if (result.getObjects().isEmpty()) {
            throw new IllegalArgumentException(
                    "No accessible OBJECT-TYPE definitions found in the MIB. "
                    + "Ensure the file contains standard SMIv2 OBJECT-TYPE declarations with "
                    + "MAX-ACCESS read-only or read-write.");
        }

        // Generate the discovery XML
        String xml = generator.generate(result);
        result.setGeneratedXml(xml);

        log.info("MIB parsed successfully: module={} vendor={} objects={} scalars={} tables={}",
                result.getModuleName(), result.getVendor(), result.getTotalObjects(),
                result.getScalarCount(),
                result.getSingleIndexCount() + result.getDoubleIndexCount() + result.getTripleIndexCount());

        return result;
    }

    /**
     * Builds the API response body for the {@code POST /parse-mib} endpoint.
     *
     * <p>Returns a structured map containing:
     * <ul>
     *   <li>{@code moduleName} — MIB module name</li>
     *   <li>{@code vendor} — inferred vendor name</li>
     *   <li>{@code productLine} — inferred product/model name</li>
     *   <li>{@code enterpriseOid} — base enterprise OID</li>
     *   <li>{@code statistics} — counts by index type</li>
     *   <li>{@code objects} — list of parsed object summaries</li>
     *   <li>{@code generatedXml} — the complete discovery XML</li>
     *   <li>{@code warnings} — any parse warnings</li>
     * </ul>
     */
    public Map<String, Object> buildApiResponse(ParsedMibResult result) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("moduleName",    result.getModuleName());
        resp.put("vendor",        result.getVendor());
        resp.put("productLine",   result.getProductLine());
        resp.put("enterpriseOid", result.getEnterpriseOid());

        // Statistics
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("totalObjects",      result.getTotalObjects());
        stats.put("scalarCount",       result.getScalarCount());
        stats.put("singleIndexCount",  result.getSingleIndexCount());
        stats.put("doubleIndexCount",  result.getDoubleIndexCount());
        stats.put("tripleIndexCount",  result.getTripleIndexCount());
        stats.put("enumCount",         result.getEnumCount());
        resp.put("statistics", stats);

        // Object summaries (lightweight — don't send full enum value maps in list)
        List<Map<String, Object>> objectList = result.getObjects().stream()
                .map(obj -> {
                    Map<String, Object> o = new LinkedHashMap<>();
                    o.put("name",       obj.getName());
                    o.put("oid",        obj.getOid());
                    o.put("nmsDataType",obj.getNmsDataType());
                    o.put("access",     obj.getAccess());
                    o.put("indexType",  obj.getIndexType().name());
                    o.put("indexLabel", obj.getIndexType().label());
                    o.put("section",    obj.getSection());
                    o.put("subSection", obj.getSubSection());
                    o.put("isEnum",     "ENUM".equals(obj.getNmsDataType()));
                    o.put("enumValueCount", obj.getEnumValues().size());
                    if (obj.getDescription() != null && !obj.getDescription().isBlank()) {
                        o.put("description", obj.getDescription());
                    }
                    if (obj.getUnits() != null && !obj.getUnits().isBlank()) {
                        o.put("units", obj.getUnits());
                    }
                    return o;
                })
                .toList();
        resp.put("objects", objectList);

        // Generated XML
        resp.put("generatedXml", result.getGeneratedXml());

        // Warnings
        if (result.getWarnings() != null && !result.getWarnings().isEmpty()) {
            resp.put("warnings", result.getWarnings());
        }

        return resp;
    }
}
