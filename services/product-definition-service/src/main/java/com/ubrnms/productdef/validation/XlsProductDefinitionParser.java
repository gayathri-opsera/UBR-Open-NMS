package com.ubrnms.productdef.validation;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Parses an XLS/XLSX Product Definition workbook into a {@link NormalizedProductDefinition}.
 *
 * <p>Required sheets (case-insensitive): <b>Identity</b>, <b>Fingerprints</b>,
 * <b>Protocols</b>, <b>Parameters</b>.  Missing or misspelled sheet names produce
 * sheet-level errors rather than cell-level errors, so operators know immediately
 * which tab is wrong.
 *
 * <p>Headers are matched case-insensitively to tolerate minor spreadsheet variations.
 */
@Slf4j
@Component
public class XlsProductDefinitionParser {

    private static final String SHEET_IDENTITY     = "identity";
    private static final String SHEET_FINGERPRINTS = "fingerprints";
    private static final String SHEET_PROTOCOLS    = "protocols";
    private static final String SHEET_PARAMETERS   = "parameters";

    public NormalizedProductDefinition parse(byte[] bytes, List<ValidationError> errors) {
        Workbook workbook;
        try {
            workbook = new XSSFWorkbook(new ByteArrayInputStream(bytes));
        } catch (Exception e) {
            errors.add(ValidationError.builder()
                    .code("XLS_PARSE_ERROR")
                    .field("document")
                    .message("Workbook could not be opened — ensure the file is a valid .xlsx document: "
                            + sanitize(e.getMessage()))
                    .severity("ERROR")
                    .build());
            return null;
        }

        try {
            // Validate all required sheets exist before reading content
            Sheet identitySheet     = findSheet(workbook, SHEET_IDENTITY);
            Sheet fingerprintSheet  = findSheet(workbook, SHEET_FINGERPRINTS);
            Sheet protocolSheet     = findSheet(workbook, SHEET_PROTOCOLS);
            Sheet parameterSheet    = findSheet(workbook, SHEET_PARAMETERS);

            boolean missingSheets = false;
            if (identitySheet == null) {
                errors.add(sheetErr("Identity"));
                missingSheets = true;
            }
            if (fingerprintSheet == null) {
                errors.add(sheetErr("Fingerprints"));
                missingSheets = true;
            }
            if (protocolSheet == null) {
                errors.add(sheetErr("Protocols"));
                missingSheets = true;
            }
            if (parameterSheet == null) {
                errors.add(sheetErr("Parameters"));
                missingSheets = true;
            }
            if (missingSheets) return null;

            NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder =
                    NormalizedProductDefinition.builder();

            parseIdentitySheet(identitySheet, builder, errors);
            parseFingerprintsSheet(fingerprintSheet, builder, errors);
            parseProtocolsSheet(protocolSheet, builder, errors);
            parseParametersSheet(parameterSheet, builder, errors);

            return builder.build();
        } finally {
            try { workbook.close(); } catch (Exception ignored) {}
        }
    }

    // ── Sheet finders ─────────────────────────────────────────────────────────

    private Sheet findSheet(Workbook wb, String name) {
        for (int i = 0; i < wb.getNumberOfSheets(); i++) {
            if (wb.getSheetName(i).trim().equalsIgnoreCase(name)) {
                return wb.getSheetAt(i);
            }
        }
        return null;
    }

    private ValidationError sheetErr(String name) {
        return ValidationError.builder()
                .code("MISSING_SHEET")
                .field("sheet." + name)
                .message("Required sheet '" + name + "' is missing or misspelled")
                .severity("ERROR")
                .build();
    }

    // ── Identity sheet ────────────────────────────────────────────────────────

    private void parseIdentitySheet(Sheet sheet,
                                     NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                     List<ValidationError> errors) {
        // Identity sheet: two-column key-value layout (column A = key, column B = value)
        Map<String, String> kv = readKeyValueSheet(sheet);
        builder.name(kv.get("name"))
               .vendor(kv.get("vendor"))
               .model(kv.get("model"))
               .firmwareFrom(kv.get("firmwarefrom"))
               .firmwareTo(kv.get("firmwareto"))
               .productFamily(kv.get("productfamily"))
               .deviceType(kv.get("devicetype"));
    }

    private Map<String, String> readKeyValueSheet(Sheet sheet) {
        Map<String, String> map = new LinkedHashMap<>();
        for (Row row : sheet) {
            if (row == null) continue;
            Cell keyCell = row.getCell(0);
            Cell valCell = row.getCell(1);
            if (keyCell == null) continue;
            String key = cellString(keyCell);
            if (key == null || key.isBlank()) continue;
            String val = valCell != null ? cellString(valCell) : null;
            map.put(key.trim().toLowerCase().replace(" ", ""), val);
        }
        return map;
    }

    // ── Fingerprints sheet ────────────────────────────────────────────────────

    private void parseFingerprintsSheet(Sheet sheet,
                                         NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                         List<ValidationError> errors) {
        Map<String, Integer> headers = readHeaderRow(sheet);
        if (headers.isEmpty()) {
            builder.fingerprints(List.of());
            return;
        }
        List<NormalizedProductDefinition.FingerprintEntry> list = new ArrayList<>();
        for (int i = 1; i <= sheet.getLastRowNum(); i++) {
            Row row = sheet.getRow(i);
            if (row == null) continue;
            NormalizedProductDefinition.FingerprintEntry entry =
                    NormalizedProductDefinition.FingerprintEntry.builder()
                            .sysObjectId(cellAt(row, headers, "sysobjectid"))
                            .sysDescrPattern(cellAt(row, headers, "sysdescrpattern"))
                            .firmwareFrom(cellAt(row, headers, "firmwarefrom"))
                            .firmwareTo(cellAt(row, headers, "firmwareto"))
                            .build();
            if (entry.getSysObjectId() != null) list.add(entry);
        }
        builder.fingerprints(list);
    }

    // ── Protocols sheet ───────────────────────────────────────────────────────

    private void parseProtocolsSheet(Sheet sheet,
                                      NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                      List<ValidationError> errors) {
        Map<String, Integer> headers = readHeaderRow(sheet);
        List<String> types = new ArrayList<>();
        for (int i = 1; i <= sheet.getLastRowNum(); i++) {
            Row row = sheet.getRow(i);
            if (row == null) continue;
            String type = cellAt(row, headers, "type");
            if (type != null && !type.isBlank()) types.add(type.toUpperCase());
        }
        builder.supportedProtocols(types);
    }

    // ── Parameters sheet ──────────────────────────────────────────────────────

    private void parseParametersSheet(Sheet sheet,
                                       NormalizedProductDefinition.NormalizedProductDefinitionBuilder builder,
                                       List<ValidationError> errors) {
        Map<String, Integer> headers = readHeaderRow(sheet);
        // All parameters go into the "default" group in XLS format unless GroupName column present
        List<NormalizedProductDefinition.ParameterEntry> entries = new ArrayList<>();
        Map<String, List<NormalizedProductDefinition.ParameterEntry>> grouped = new LinkedHashMap<>();

        for (int i = 1; i <= sheet.getLastRowNum(); i++) {
            Row row = sheet.getRow(i);
            if (row == null) continue;

            String id = cellAt(row, headers, "id");
            if (id == null || id.isBlank()) continue;

            var pb = NormalizedProductDefinition.ParameterEntry.builder()
                            .id(id)
                            .displayName(cellAt(row, headers, "displayname"))
                            .dataType(cellAt(row, headers, "datatype"))
                            .unit(cellAt(row, headers, "unit"))
                            .defaultValue(cellAt(row, headers, "defaultvalue"))
                            .snmpOid(cellAt(row, headers, "oid"))
                            .cliCommand(cellAt(row, headers, "clicommand"))
                            .cliParseRegex(cellAt(row, headers, "cliparseregex"))
                            .apiPath(cellAt(row, headers, "apipath"))
                            .grpcPath(cellAt(row, headers, "grpcpath"))
                            .thresholdHigh(cellAt(row, headers, "thresholdhigh"))
                            .thresholdLow(cellAt(row, headers, "thresholdlow"));

            String minStr = cellAt(row, headers, "minvalue");
            String maxStr = cellAt(row, headers, "maxvalue");
            if (minStr != null) { try { pb.minValue(Double.parseDouble(minStr)); } catch (NumberFormatException ignored) {} }
            if (maxStr != null) { try { pb.maxValue(Double.parseDouble(maxStr)); } catch (NumberFormatException ignored) {} }

            String visibleStr = cellAt(row, headers, "uivisibleto");
            if (visibleStr != null && !visibleStr.isBlank()) {
                List<String> roles = new ArrayList<>();
                for (String r : visibleStr.split(",")) {
                    String t = r.trim();
                    if (!t.isEmpty()) roles.add(t);
                }
                pb.uiVisibleTo(roles);
            }

            String groupName = cellAt(row, headers, "groupname");
            if (groupName == null || groupName.isBlank()) groupName = "default";
            grouped.computeIfAbsent(groupName, k -> new ArrayList<>()).add(pb.build());
        }

        List<NormalizedProductDefinition.ParameterGroup> groups = new ArrayList<>();
        grouped.forEach((gname, params) ->
                groups.add(NormalizedProductDefinition.ParameterGroup.builder()
                        .groupName(gname)
                        .parameters(params)
                        .build()));
        builder.parameterGroups(groups);
    }

    // ── Sheet parsing helpers ─────────────────────────────────────────────────

    private Map<String, Integer> readHeaderRow(Sheet sheet) {
        Map<String, Integer> headers = new LinkedHashMap<>();
        Row headerRow = sheet.getRow(0);
        if (headerRow == null) return headers;
        for (Cell cell : headerRow) {
            String name = cellString(cell);
            if (name != null && !name.isBlank()) {
                // Normalize: lowercase, strip spaces
                headers.put(name.trim().toLowerCase().replace(" ", ""), cell.getColumnIndex());
            }
        }
        return headers;
    }

    private String cellAt(Row row, Map<String, Integer> headers, String key) {
        Integer col = headers.get(key);
        if (col == null) return null;
        Cell cell = row.getCell(col);
        return cell != null ? cellString(cell) : null;
    }

    private String cellString(Cell cell) {
        if (cell == null) return null;
        return switch (cell.getCellType()) {
            case STRING  -> cell.getStringCellValue().trim();
            case NUMERIC -> {
                double d = cell.getNumericCellValue();
                // Return integer form when value has no fractional part
                yield d == Math.floor(d) ? String.valueOf((long) d) : String.valueOf(d);
            }
            case BOOLEAN -> String.valueOf(cell.getBooleanCellValue());
            case FORMULA -> {
                try { yield String.valueOf(cell.getStringCellValue()).trim(); }
                catch (Exception e) { yield String.valueOf(cell.getNumericCellValue()); }
            }
            default -> null;
        };
    }

    private String sanitize(String msg) {
        if (msg == null) return "unknown error";
        return msg.length() > 200 ? msg.substring(0, 200) + "..." : msg;
    }
}
