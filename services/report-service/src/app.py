"""FastAPI application for Report Service."""
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
async def download_report(report_id: str):
    result = await svc.get_download(report_id)
    if result is None:
        raise HTTPException(404, "Report not found or not yet complete")
    data, content_type = result
    ext = "xlsx" if "spreadsheet" in content_type else "csv"
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
