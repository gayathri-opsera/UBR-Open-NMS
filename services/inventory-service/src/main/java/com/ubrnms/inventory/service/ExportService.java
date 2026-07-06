package com.ubrnms.inventory.service;

import com.opencsv.CSVWriter;
import com.ubrnms.inventory.model.Device;
import com.ubrnms.inventory.repository.DeviceRepository;
import lombok.RequiredArgsConstructor;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.io.ByteArrayOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ExportService {

    private final DeviceRepository deviceRepo;

    @Value("${inventory.export.max-rows:10000}")
    private int maxRows;

    private static final String[] CSV_HEADERS = {
        "id", "deviceType", "serialNumber", "model", "macAddress", "ipAddress",
        "firmwareVersion", "status", "latitude", "longitude", "azimuth", "region", "createdAt"
    };

    public byte[] exportCsv() throws Exception {
        List<Device> devices = deviceRepo.findAll(PageRequest.of(0, maxRows)).getContent();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (CSVWriter writer = new CSVWriter(new OutputStreamWriter(baos, StandardCharsets.UTF_8))) {
            writer.writeNext(CSV_HEADERS);
            for (Device d : devices) {
                writer.writeNext(toRow(d));
            }
        }
        return baos.toByteArray();
    }

    public byte[] exportXls() throws Exception {
        List<Device> devices = deviceRepo.findAll(PageRequest.of(0, maxRows)).getContent();
        try (Workbook wb = new XSSFWorkbook(); ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            Sheet sheet = wb.createSheet("Devices");
            Row header = sheet.createRow(0);
            for (int i = 0; i < CSV_HEADERS.length; i++) {
                Cell cell = header.createCell(i);
                cell.setCellValue(CSV_HEADERS[i]);
            }
            int rowNum = 1;
            for (Device d : devices) {
                Row row = sheet.createRow(rowNum++);
                String[] values = toRow(d);
                for (int i = 0; i < values.length; i++) {
                    row.createCell(i).setCellValue(values[i] != null ? values[i] : "");
                }
            }
            wb.write(baos);
            return baos.toByteArray();
        }
    }

    private String[] toRow(Device d) {
        return new String[]{
            d.getId(),
            d.getDeviceType(),
            d.getSerialNumber(),
            d.getModel(),
            d.getMacAddress(),
            d.getIpAddress(),
            d.getFirmwareVersion(),
            d.getStatus(),
            String.valueOf(d.getLatitude()),
            String.valueOf(d.getLongitude()),
            String.valueOf(d.getAzimuth()),
            d.getRegion(),
            d.getCreatedAt() != null ? d.getCreatedAt().toString() : ""
        };
    }
}
