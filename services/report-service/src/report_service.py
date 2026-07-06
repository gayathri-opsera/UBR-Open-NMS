"""Async report generation engine."""
import asyncio
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

import motor.motor_asyncio

from config import (
    MONGO_URI, MONGO_DB_ALARMS, MONGO_DB_INVENTORY, MONGO_DB_KPI,
    MONGO_DB_REPORTS, MAX_EXPORT_ROWS,
)
from query_builders import (
    alarm_history_query, kpi_summary_query, inventory_query, top_alarms_query,
)
from export import (
    generate_csv, generate_xls,
    alarm_doc_to_row, kpi_doc_to_row, top_alarm_doc_to_row, inventory_doc_to_row,
    ALARM_HISTORY_HEADERS, KPI_SUMMARY_HEADERS, TOP_ALARMS_HEADERS, INVENTORY_HEADERS,
)

log = logging.getLogger(__name__)


class ReportService:
    def __init__(self, client: motor.motor_asyncio.AsyncIOMotorClient = None):
        self._client = client or motor.motor_asyncio.AsyncIOMotorClient(MONGO_URI)
        self._reports_col = self._client[MONGO_DB_REPORTS]["reports"]
        self._alarms_col  = self._client[MONGO_DB_ALARMS]["alarms"]
        self._kpi_col     = self._client[MONGO_DB_KPI]["kpi_warm"]
        self._inv_col     = self._client[MONGO_DB_INVENTORY]["devices"]
        self._schedules_col = self._client[MONGO_DB_REPORTS]["report_schedules"]

    # ── Public API ────────────────────────────────────────────────

    async def request_report(self, report_type: str, scope: dict,
                              from_dt: datetime, to_dt: datetime,
                              fmt: str = "csv") -> str:
        report_id = str(uuid.uuid4())
        await self._reports_col.insert_one({
            "_id": report_id,
            "reportType": report_type,
            "scope": scope,
            "from": from_dt,
            "to": to_dt,
            "format": fmt,
            "status": "PENDING",
            "requestedAt": datetime.now(timezone.utc),
        })
        asyncio.create_task(self._generate(report_id, report_type, scope,
                                            from_dt, to_dt, fmt))
        return report_id

    async def get_report(self, report_id: str) -> Optional[dict]:
        return await self._reports_col.find_one({"_id": report_id})

    async def get_download(self, report_id: str) -> Optional[tuple[bytes, str]]:
        doc = await self._reports_col.find_one({"_id": report_id})
        if doc and doc.get("status") == "DONE":
            return doc.get("data"), doc.get("contentType", "text/csv")
        return None

    async def create_schedule(self, schedule: dict) -> str:
        sid = str(uuid.uuid4())
        schedule["_id"] = sid
        schedule["createdAt"] = datetime.now(timezone.utc)
        schedule["status"] = "ACTIVE"
        await self._schedules_col.insert_one(schedule)
        return sid

    async def list_schedules(self) -> list:
        return await self._schedules_col.find({"status": "ACTIVE"}).to_list(length=200)

    # ── Internal generation ───────────────────────────────────────

    async def _generate(self, report_id: str, report_type: str,
                         scope: dict, from_dt: datetime, to_dt: datetime,
                         fmt: str) -> None:
        try:
            rows, headers = await self._fetch_data(report_type, scope, from_dt, to_dt)
            if fmt == "xls":
                data = generate_xls(headers, rows)
                ct = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            else:
                data = generate_csv(headers, rows)
                ct = "text/csv"
            await self._reports_col.update_one({"_id": report_id}, {"$set": {
                "status": "DONE", "rowCount": len(rows),
                "data": data, "contentType": ct,
                "completedAt": datetime.now(timezone.utc),
            }})
        except Exception as exc:
            log.exception("Report generation failed for %s", report_id)
            await self._reports_col.update_one({"_id": report_id}, {"$set": {
                "status": "FAILED", "errorMessage": str(exc),
            }})

    async def _fetch_data(self, report_type: str, scope: dict,
                           from_dt: datetime, to_dt: datetime) -> tuple[list, list]:
        if report_type == "alarm-history":
            q = alarm_history_query(scope, from_dt, to_dt)
            docs = await self._alarms_col.find(q).limit(MAX_EXPORT_ROWS).to_list(length=MAX_EXPORT_ROWS)
            return [alarm_doc_to_row(d) for d in docs], ALARM_HISTORY_HEADERS

        elif report_type == "kpi-summary":
            q = kpi_summary_query(scope, from_dt, to_dt)
            docs = await self._kpi_col.find(q).limit(MAX_EXPORT_ROWS).to_list(length=MAX_EXPORT_ROWS)
            return [kpi_doc_to_row(d) for d in docs], KPI_SUMMARY_HEADERS

        elif report_type == "top-alarms":
            pipeline = top_alarms_query(scope, from_dt, to_dt)
            docs = await self._alarms_col.aggregate(pipeline).to_list(length=100)
            return [top_alarm_doc_to_row(d) for d in docs], TOP_ALARMS_HEADERS

        elif report_type == "inventory-summary":
            q = inventory_query(scope)
            docs = await self._inv_col.find(q).limit(MAX_EXPORT_ROWS).to_list(length=MAX_EXPORT_ROWS)
            return [inventory_doc_to_row(d) for d in docs], INVENTORY_HEADERS

        raise ValueError(f"Unknown report type: {report_type}")
