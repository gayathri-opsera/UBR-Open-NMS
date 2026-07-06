package com.ubrnms.kpiquery.service;

import com.ubrnms.kpiquery.model.KpiAggregate;
import com.ubrnms.kpiquery.model.MetricStats;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.PrintWriter;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class KpiExportService {

    private final KpiQueryService queryService;

    public void exportCsv(List<KpiAggregate> data, List<String> metrics,
                           HttpServletResponse response) throws IOException {
        response.setContentType("text/csv");
        response.setHeader("Content-Disposition", "attachment; filename=kpi-export.csv");
        List<Map<String, Object>> rows = queryService.buildExportRows(data, metrics);
        if (rows.isEmpty()) { response.getWriter().println("no data"); return; }

        Set<String> headers = rows.get(0).keySet();
        PrintWriter w = response.getWriter();
        w.println(String.join(",", headers));
        for (Map<String, Object> row : rows) {
            w.println(headers.stream()
                    .map(h -> safe(row.get(h)))
                    .reduce((a, b) -> a + "," + b).orElse(""));
        }
        w.flush();
    }

    public void exportXls(List<KpiAggregate> data, List<String> metrics,
                           HttpServletResponse response) throws IOException {
        response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition", "attachment; filename=kpi-export.xlsx");
        List<Map<String, Object>> rows = queryService.buildExportRows(data, metrics);

        try (Workbook wb = new XSSFWorkbook()) {
            Sheet sheet = wb.createSheet("KPI Data");
            if (rows.isEmpty()) { wb.write(response.getOutputStream()); return; }

            List<String> headers = new ArrayList<>(rows.get(0).keySet());
            Row hdr = sheet.createRow(0);
            for (int i = 0; i < headers.size(); i++) hdr.createCell(i).setCellValue(headers.get(i));

            int rowNum = 1;
            for (Map<String, Object> row : rows) {
                Row r = sheet.createRow(rowNum++);
                for (int c = 0; c < headers.size(); c++) {
                    Object v = row.get(headers.get(c));
                    r.createCell(c).setCellValue(v != null ? v.toString() : "");
                }
            }
            wb.write(response.getOutputStream());
        }
    }

    private String safe(Object o) {
        return o != null ? o.toString().replace(",", ";") : "";
    }
}
