package com.ubrnms.alarm.service;

import com.ubrnms.alarm.model.Alarm;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.PrintWriter;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExportService {

    private static final String[] HEADERS = {
            "alarmId", "deviceId", "deviceType", "alarmType", "alarmName",
            "severity", "state", "description", "source",
            "raisedAt", "clearedAt", "acknowledgedBy", "networkId", "organizationId"
    };

    public void exportCsv(List<Alarm> alarms, HttpServletResponse response) throws IOException {
        response.setContentType("text/csv");
        response.setHeader("Content-Disposition", "attachment; filename=alarms.csv");
        PrintWriter writer = response.getWriter();
        writer.println(String.join(",", HEADERS));
        for (Alarm a : alarms) {
            writer.println(String.join(",",
                    safe(a.getAlarmId()), safe(a.getDeviceId()), safe(a.getDeviceType()),
                    safe(a.getAlarmType()), safe(a.getAlarmName()), safe(a.getSeverity()),
                    safe(a.getState()), safe(a.getDescription()), safe(a.getSource()),
                    safe(a.getRaisedAt()), safe(a.getClearedAt()), safe(a.getAcknowledgedBy()),
                    safe(a.getNetworkId()), safe(a.getOrganizationId())
            ));
        }
        writer.flush();
    }

    public void exportXls(List<Alarm> alarms, HttpServletResponse response) throws IOException {
        response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition", "attachment; filename=alarms.xlsx");
        try (Workbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("Alarms");
            Row header = sheet.createRow(0);
            for (int i = 0; i < HEADERS.length; i++) header.createCell(i).setCellValue(HEADERS[i]);
            int rowNum = 1;
            for (Alarm a : alarms) {
                Row row = sheet.createRow(rowNum++);
                Object[] vals = {
                        a.getAlarmId(), a.getDeviceId(), a.getDeviceType(), a.getAlarmType(),
                        a.getAlarmName(), a.getSeverity(), a.getState(), a.getDescription(),
                        a.getSource(), safe(a.getRaisedAt()), safe(a.getClearedAt()),
                        a.getAcknowledgedBy(), a.getNetworkId(), a.getOrganizationId()
                };
                for (int c = 0; c < vals.length; c++)
                    row.createCell(c).setCellValue(vals[c] != null ? vals[c].toString() : "");
            }
            wb.write(response.getOutputStream());
        }
    }

    private String safe(Object o) { return o != null ? o.toString().replace(",", ";") : ""; }
}
