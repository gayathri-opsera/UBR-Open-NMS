// WO-069: Mask Restricted Export Data Consistently
package com.ubr.nms.report;

import org.springframework.stereotype.Service;
import java.util.regex.Pattern;

@Service
public class DataMaskingService {

    public String maskMacAddress(String macAddress) {
        if (macAddress == null || macAddress.length() < 8) {
            return macAddress;
        }
        // Mask last 6 characters: AA:BB:CC:DD:EE:FF -> AA:BB:CC:XX:XX:XX
        return macAddress.substring(0, 8) + "XX:XX:XX";
    }

    public String maskSerialNumber(String serialNumber) {
        if (serialNumber == null || serialNumber.length() < 8) {
            return "MASKED";
        }
        // Mask middle characters: SN-12345678-90 -> SN-****5678-90
        int len = serialNumber.length();
        return serialNumber.substring(0, 3) + "****" + serialNumber.substring(len - 5);
    }

    public String maskIpAddress(String ipAddress) {
        if (ipAddress == null) return null;
        // Mask last octet: 192.168.1.100 -> 192.168.1.XXX
        Pattern pattern = Pattern.compile("(\\d+\\.\\d+\\.\\d+\\.)\\d+");
        return pattern.matcher(ipAddress).replaceAll("$1XXX");
    }

    public ExportData applyMaskingRules(ExportData data, MaskingPolicy policy) {
        if (policy.isMaskMacAddresses()) {
            data.setMacAddress(maskMacAddress(data.getMacAddress()));
        }
        if (policy.isMaskSerialNumbers()) {
            data.setSerialNumber(maskSerialNumber(data.getSerialNumber()));
        }
        if (policy.isMaskIpAddresses()) {
            data.setIpAddress(maskIpAddress(data.getIpAddress()));
        }
        return data;
    }

    public void auditUnmaskedExport(String exportId, String userId, String reason) {
        // Audit trail for unmasked data exports
        // Log to audit service with compliance flags
    }
}

class ExportData {
    private String macAddress;
    private String serialNumber;
    private String ipAddress;

    public String getMacAddress() { return macAddress; }
    public void setMacAddress(String macAddress) { this.macAddress = macAddress; }
    public String getSerialNumber() { return serialNumber; }
    public void setSerialNumber(String serialNumber) { this.serialNumber = serialNumber; }
    public String getIpAddress() { return ipAddress; }
    public void setIpAddress(String ipAddress) { this.ipAddress = ipAddress; }
}

class MaskingPolicy {
    private boolean maskMacAddresses;
    private boolean maskSerialNumbers;
    private boolean maskIpAddresses;

    public boolean isMaskMacAddresses() { return maskMacAddresses; }
    public boolean isMaskSerialNumbers() { return maskSerialNumbers; }
    public boolean isMaskIpAddresses() { return maskIpAddresses; }
}
