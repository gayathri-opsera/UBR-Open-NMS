package com.ubrnms.productdef;

import com.ubrnms.productdef.model.NormalizedProductDefinition;
import com.ubrnms.productdef.model.ValidationError;
import com.ubrnms.productdef.validation.XlsProductDefinitionParser;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

class XlsProductDefinitionParserTest {

    private XlsProductDefinitionParser parser;

    @BeforeEach
    void setUp() {
        parser = new XlsProductDefinitionParser();
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    void parse_validWorkbook_returnsNormalizedDefinition() throws Exception {
        byte[] bytes = buildValidWorkbook();
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(errors).isEmpty();
        assertThat(result).isNotNull();
        assertThat(result.getName()).isEqualTo("NodeB 3900");
        assertThat(result.getVendor()).isEqualTo("Huawei");
        assertThat(result.getModel()).isEqualTo("BTS3900");
    }

    @Test
    void parse_validWorkbook_parsesFingerprints() throws Exception {
        byte[] bytes = buildValidWorkbook();
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        assertThat(result.getFingerprints()).hasSize(1);
        assertThat(result.getFingerprints().get(0).getSysObjectId())
                .isEqualTo(".1.3.6.1.4.1.2011.1.1");
    }

    @Test
    void parse_validWorkbook_parsesProtocols() throws Exception {
        byte[] bytes = buildValidWorkbook();
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        assertThat(result.getSupportedProtocols()).containsExactlyInAnyOrder("SNMP", "REST");
    }

    @Test
    void parse_validWorkbook_parsesParameters() throws Exception {
        byte[] bytes = buildValidWorkbook();
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());

        assertThat(result.getParameterGroups()).hasSize(1);
        NormalizedProductDefinition.ParameterEntry p = result.getParameterGroups().get(0).getParameters().get(0);
        assertThat(p.getId()).isEqualTo("rssi");
        assertThat(p.getDataType()).isEqualTo("FLOAT");
        assertThat(p.getSnmpOid()).isEqualTo(".1.3.6.1.4.1.2011.6.3.1.1");
    }

    @Test
    void parse_validWorkbook_parameterNumericRange() throws Exception {
        byte[] bytes = buildValidWorkbook();
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());
        NormalizedProductDefinition.ParameterEntry p = result.getParameterGroups().get(0).getParameters().get(0);
        assertThat(p.getMinValue()).isEqualTo(-140.0);
        assertThat(p.getMaxValue()).isEqualTo(-44.0);
    }

    // ── Missing required sheets ───────────────────────────────────────────────

    @Test
    void parse_missingIdentitySheet_returnsNullWithError() throws Exception {
        byte[] bytes = buildWorkbookWithout("Identity");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "MISSING_SHEET".equals(e.getCode())
                && e.getField().contains("Identity"));
    }

    @Test
    void parse_missingFingerprintsSheet_returnsNullWithError() throws Exception {
        byte[] bytes = buildWorkbookWithout("Fingerprints");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "MISSING_SHEET".equals(e.getCode())
                && e.getField().contains("Fingerprints"));
    }

    @Test
    void parse_missingParametersSheet_returnsNullWithError() throws Exception {
        byte[] bytes = buildWorkbookWithout("Parameters");
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(bytes, errors);

        assertThat(result).isNull();
    }

    // ── Case-insensitive sheet matching ───────────────────────────────────────

    @Test
    void parse_sheetsWithDifferentCase_areAccepted() throws Exception {
        byte[] bytes = buildWorkbookWithNames("IDENTITY", "FINGERPRINTS", "PROTOCOLS", "PARAMETERS");
        NormalizedProductDefinition result = parser.parse(bytes, new ArrayList<>());
        assertThat(result).isNotNull();
        assertThat(result.getVendor()).isEqualTo("Huawei");
    }

    // ── Malformed input ───────────────────────────────────────────────────────

    @Test
    void parse_notAnXlsx_returnsNullWithError() {
        byte[] notXlsx = "this is not a workbook".getBytes();
        List<ValidationError> errors = new ArrayList<>();

        NormalizedProductDefinition result = parser.parse(notXlsx, errors);

        assertThat(result).isNull();
        assertThat(errors).anyMatch(e -> "XLS_PARSE_ERROR".equals(e.getCode()));
    }

    @Test
    void parse_emptyBytes_returnsNullWithError() {
        List<ValidationError> errors = new ArrayList<>();
        NormalizedProductDefinition result = parser.parse(new byte[0], errors);
        assertThat(result).isNull();
        assertThat(errors).isNotEmpty();
    }

    // ── Builder helpers ───────────────────────────────────────────────────────

    private byte[] buildValidWorkbook() throws Exception {
        return buildWorkbookWithNames("Identity", "Fingerprints", "Protocols", "Parameters");
    }

    private byte[] buildWorkbookWithNames(String identity, String fingerprints,
                                          String protocols, String parameters) throws Exception {
        try (XSSFWorkbook wb = new XSSFWorkbook()) {
            addIdentitySheet(wb, identity);
            addFingerprintsSheet(wb, fingerprints);
            addProtocolsSheet(wb, protocols);
            addParametersSheet(wb, parameters);
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            wb.write(baos);
            return baos.toByteArray();
        }
    }

    private byte[] buildWorkbookWithout(String excludeSheet) throws Exception {
        try (XSSFWorkbook wb = new XSSFWorkbook()) {
            if (!"Identity".equalsIgnoreCase(excludeSheet))     addIdentitySheet(wb, "Identity");
            if (!"Fingerprints".equalsIgnoreCase(excludeSheet)) addFingerprintsSheet(wb, "Fingerprints");
            if (!"Protocols".equalsIgnoreCase(excludeSheet))    addProtocolsSheet(wb, "Protocols");
            if (!"Parameters".equalsIgnoreCase(excludeSheet))   addParametersSheet(wb, "Parameters");
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            wb.write(baos);
            return baos.toByteArray();
        }
    }

    private void addIdentitySheet(Workbook wb, String name) {
        Sheet s = wb.createSheet(name);
        row(s, 0, "Name", "NodeB 3900");
        row(s, 1, "Vendor", "Huawei");
        row(s, 2, "Model", "BTS3900");
        row(s, 3, "FirmwareFrom", "V300R019C00");
        row(s, 4, "FirmwareTo", "V300R023C00");
        row(s, 5, "ProductFamily", "NodeB 3900 Series");
    }

    private void addFingerprintsSheet(Workbook wb, String name) {
        Sheet s = wb.createSheet(name);
        row(s, 0, "SysObjectId", "SysDescrPattern", "FirmwareFrom", "FirmwareTo");
        row(s, 1, ".1.3.6.1.4.1.2011.1.1", ".*Huawei.*NodeB.*", "V300R019C00", "V300R023C00");
    }

    private void addProtocolsSheet(Workbook wb, String name) {
        Sheet s = wb.createSheet(name);
        row(s, 0, "Type");
        row(s, 1, "SNMP");
        row(s, 2, "REST");
    }

    private void addParametersSheet(Workbook wb, String name) {
        Sheet s = wb.createSheet(name);
        row(s, 0, "Id", "DisplayName", "DataType", "Unit", "MinValue", "MaxValue",
                "OID", "GroupName");
        row(s, 1, "rssi", "RSSI", "FLOAT", "dBm", "-140", "-44",
                ".1.3.6.1.4.1.2011.6.3.1.1", "radio");
    }

    private void row(Sheet sheet, int rowNum, String... values) {
        Row row = sheet.createRow(rowNum);
        for (int i = 0; i < values.length; i++) {
            row.createCell(i).setCellValue(values[i]);
        }
    }
}
