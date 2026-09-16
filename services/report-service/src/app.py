"""FastAPI application for Report Service."""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from report_service import ReportService

logging.basicConfig(level=logging.INFO,
                    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}')

app = FastAPI(title="UBR NMS Report Service", version="1.0.0")
svc = ReportService()

# Prometheus metrics
try:
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../shared/metrics/python/src"))
    from ubrnms_metrics import setup_metrics
    setup_metrics(app, service_name="report-service")
except Exception:
    pass  # metrics library not available in all envs


# ── Pydantic models ────────────────────────────────────────────────────────────

class ReportRequest(BaseModel):
    reportType: str
    scope: dict = {}
    from_dt: Optional[datetime] = None
    to_dt: Optional[datetime] = None
    format: str = "csv"


class ScheduleRequest(BaseModel):
    reportType: str
    scope: dict = {}
    cronExpression: str
    email: Optional[str] = None
    format: str = "csv"


# ── Retention class mapper (WO-008) ───────────────────────────────────────────

RETENTION_CLASS_MAP = {
    "audit_log": "audit",
    "alarm":     "alarm_incident",
    "config":    "config_history",
    "security":  "security",
    "onboarding": "onboarding",
}


def get_retention_class(report_type: str) -> str:
    """Derive retentionClass from report type for evidence export records."""
    for key, cls in RETENTION_CLASS_MAP.items():
        if key in report_type.lower():
            return cls
    return "audit"  # default


def compute_checksum(data: bytes) -> tuple[str, str]:
    """Compute SHA-256 checksum of export data. Returns (checksum_hex, algorithm)."""
    try:
        digest = hashlib.sha256(data).hexdigest()
        return digest, "SHA-256"
    except Exception:
        return "not_applicable", "not_applicable"


async def emit_evidence_export_audit(
    actor: str,
    report_id: str,
    report_type: str,
    export_scope: dict,
    data: Optional[bytes],
    retention_class: str,
) -> None:
    """Emit an evidence.exported audit record via internal HTTP (fire-and-forget).
    Includes actor, exportScope, timestamp, checksum/checksumAlgorithm, retentionClass (WO-008).
    """
    import os, json
    from urllib import request as urllib_request

    checksum, checksum_algorithm = compute_checksum(data) if data else ("not_applicable", "not_applicable")

    audit_payload = {
        "actor": {"userId": actor, "username": actor, "role": "system"},
        "action": "evidence.exported",
        "resource": "report",
        "resourceId": report_id,
        "outcome": "success",
        "retentionClass": retention_class,
        "payload": {
            "exportScope": export_scope,
            "reportType": report_type,
            "checksum": checksum,
            "checksumAlgorithm": checksum_algorithm,
        },
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "serviceSource": "report-service",
    }

    try:
        audit_url = os.environ.get("AUDIT_SERVICE_URL", "http://nms-audit:3007")
        req = urllib_request.Request(
            f"{audit_url}/api/v1/audit/events",
            data=json.dumps(audit_payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib_request.urlopen(req, timeout=3)
    except Exception as e:
        logging.warning("Failed to emit evidence export audit event: %s", e)


# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/readyz")
async def readyz():
    return {"status": "ready"}


# ── Report CRUD ────────────────────────────────────────────────────────────────

@app.post("/api/v1/reports/generate", status_code=202)
async def generate_report(req: ReportRequest):
    from_dt = req.from_dt or datetime.now(timezone.utc).replace(hour=0, minute=0, second=0)
    to_dt   = req.to_dt or datetime.now(timezone.utc)
    report_id = await svc.request_report(
        req.reportType, req.scope, from_dt, to_dt, req.format)
    return {"reportId": report_id, "status": "PENDING"}


@app.get("/api/v1/reports/{report_id}")
async def get_report_status(report_id: str):
    doc = await svc.get_report(report_id)
    if not doc:
        raise HTTPException(404, "Report not found")
    return {"reportId": report_id, "status": doc.get("status"),
            "rowCount": doc.get("rowCount"), "completedAt": doc.get("completedAt")}


@app.get("/api/v1/reports/{report_id}/download")
async def download_report(report_id: str, actor: str = Query(default="system")):
    result = await svc.get_download(report_id)
    if result is None:
        raise HTTPException(404, "Report not found or not yet complete")
    data, content_type = result
    ext = "xlsx" if "spreadsheet" in content_type else "csv"

    # Fetch report metadata for the evidence export audit record
    doc = await svc.get_report(report_id)
    report_type = doc.get("reportType", "unknown") if doc else "unknown"
    export_scope = doc.get("scope", {}) if doc else {}
    retention_class = get_retention_class(report_type)

    # Emit evidence export audit event (WO-008): fire-and-forget
    await emit_evidence_export_audit(actor, report_id, report_type, export_scope, data, retention_class)

    return Response(content=data, media_type=content_type,
                    headers={"Content-Disposition": f"attachment; filename=report-{report_id}.{ext}"})


# ── Schedules ──────────────────────────────────────────────────────────────────

@app.post("/api/v1/reports/schedules", status_code=201)
async def create_schedule(req: ScheduleRequest):
    sid = await svc.create_schedule(req.model_dump())
    return {"scheduleId": sid, "status": "ACTIVE"}


@app.get("/api/v1/reports/schedules")
async def list_schedules():
    return await svc.list_schedules()


# ── WO-068: CTSO/TSOC Incident Evidence Export ────────────────────────────────

class IncidentEvidenceRequest(BaseModel):
    alarmId: Optional[str] = None
    correlationId: Optional[str] = None
    incidentRef: Optional[str] = None
    deviceId: Optional[str] = None
    from_dt: Optional[datetime] = None
    to_dt: Optional[datetime] = None


@app.post("/api/reports/incident-evidence", status_code=202)
async def request_incident_evidence(req: IncidentEvidenceRequest):
    """Request CTSO/TSOC incident evidence package (WO-068)."""
    # Build scope from lookup criteria
    scope = {}
    if req.alarmId:
        scope["alarmId"] = req.alarmId
    if req.correlationId:
        scope["correlationId"] = req.correlationId
    if req.incidentRef:
        scope["incidentRef"] = req.incidentRef
    if req.deviceId:
        scope["deviceId"] = req.deviceId

    # Default time range: last 7 days
    from_dt = req.from_dt or datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    to_dt = req.to_dt or datetime.now(timezone.utc)

    # Request evidence package
    report_id = await svc.request_incident_evidence(scope, from_dt, to_dt)

    return {"reportId": report_id, "status": "PENDING"}


@app.get("/api/reports/incident-evidence/{report_id}")
async def get_incident_evidence_status(report_id: str):
    """Get incident evidence package status and data (WO-068)."""
    doc = await svc.get_report(report_id)
    if not doc:
        raise HTTPException(404, "Evidence package not found")

    response = {
        "reportId": report_id,
        "status": doc.get("status"),
        "completedAt": doc.get("completedAt"),
        "evidence": doc.get("evidence")
    }

    return response


@app.get("/api/reports/incident-evidence/{report_id}/download")
async def download_incident_evidence(report_id: str, actor: str = Query(default="system")):
    """Download incident evidence package as JSON (WO-068)."""
    doc = await svc.get_report(report_id)
    if not doc or doc.get("status") != "COMPLETED":
        raise HTTPException(404, "Evidence package not found or not yet complete")

    import json
    evidence = doc.get("evidence", {})
    data = json.dumps(evidence, indent=2).encode()

    # Emit audit event
    await emit_evidence_export_audit(
        actor, report_id, "CTSO_TSOC_INCIDENT_EVIDENCE",
        doc.get("scope", {}), data, "security"
    )

    return Response(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename=incident-evidence-{report_id}.json"}
    )
