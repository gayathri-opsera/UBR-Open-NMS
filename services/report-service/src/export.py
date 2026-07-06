"""CSV and XLS generation for report data."""
import csv
import io
from typing import Any

import openpyxl


def generate_csv(headers: list[str], rows: list[dict]) -> bytes:
    """Produce CSV bytes from a list of dicts."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=headers, extrasaction="ignore",
                            lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


def generate_xls(headers: list[str], rows: list[dict]) -> bytes:
    """Produce XLSX bytes from a list of dicts."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Report"
    ws.append(headers)
    for row in rows:
        ws.append([_safe(row.get(h)) for h in headers])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _safe(v: Any) -> str:
    if v is None:
        return ""
    return str(v)


# ── Column definitions per report type ────────────────────────────────────────

ALARM_HISTORY_HEADERS = [
    "alarmId", "deviceId", "severity", "alarmType", "raisedAt",
    "clearedAt", "duration", "state", "acknowledgedBy",
]

KPI_SUMMARY_HEADERS = [
    "deviceId", "granularity", "bucketStart",
    "rssi_avg", "rssi_min", "rssi_max",
    "snr_avg", "snr_min", "snr_max",
    "cpuUtilization_avg", "throughputUL_avg", "throughputDL_avg",
    "sampleCount",
]

TOP_ALARMS_HEADERS = [
    "alarmType", "severity", "count", "affectedDeviceCount",
]

INVENTORY_HEADERS = [
    "deviceId", "deviceType", "manufacturer", "model",
    "firmwareVersion", "status", "networkId", "organizationId",
]


def alarm_doc_to_row(doc: dict) -> dict:
    raised = doc.get("raisedAt") or doc.get("timestamp")
    cleared = doc.get("clearedAt")
    duration = ""
    if raised and cleared:
        try:
            dur_s = (cleared - raised).total_seconds()
            duration = f"{int(dur_s)}s"
        except Exception:
            pass
    return {
        "alarmId": doc.get("alarmId") or str(doc.get("_id", "")),
        "deviceId": doc.get("deviceId", ""),
        "severity": doc.get("severity", ""),
        "alarmType": doc.get("alarmType", ""),
        "raisedAt": _safe(raised),
        "clearedAt": _safe(cleared),
        "duration": duration,
        "state": doc.get("state", ""),
        "acknowledgedBy": doc.get("acknowledgedBy", ""),
    }


def kpi_doc_to_row(doc: dict) -> dict:
    metrics = doc.get("metrics") or {}

    def stat(key: str, stat_name: str) -> str:
        s = metrics.get(key)
        return _safe(s.get(stat_name) if isinstance(s, dict) else None)

    return {
        "deviceId": doc.get("deviceId", ""),
        "granularity": doc.get("granularity", ""),
        "bucketStart": _safe(doc.get("bucketStart")),
        "rssi_avg": stat("rssi", "avg"),
        "rssi_min": stat("rssi", "min"),
        "rssi_max": stat("rssi", "max"),
        "snr_avg": stat("snr", "avg"),
        "snr_min": stat("snr", "min"),
        "snr_max": stat("snr", "max"),
        "cpuUtilization_avg": stat("cpuUtilization", "avg"),
        "throughputUL_avg": stat("throughputUL", "avg"),
        "throughputDL_avg": stat("throughputDL", "avg"),
        "sampleCount": doc.get("sampleCount", 0),
    }


def top_alarm_doc_to_row(doc: dict) -> dict:
    id_part = doc.get("_id") or {}
    return {
        "alarmType": id_part.get("alarmType", "") if isinstance(id_part, dict) else "",
        "severity": id_part.get("severity", "") if isinstance(id_part, dict) else "",
        "count": doc.get("count", 0),
        "affectedDeviceCount": len(doc.get("affectedDevices") or []),
    }


def inventory_doc_to_row(doc: dict) -> dict:
    return {h: _safe(doc.get(h)) for h in INVENTORY_HEADERS}
