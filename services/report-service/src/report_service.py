"""Async report generation engine."""
import asyncio
import hashlib
import json
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
        self._audit_col   = self._client["audit"]["audit_events"]  # WO-068
        self._events_col  = self._client["events"]["northbound_events"]  # WO-068

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
            # WO-068: CTSO/TSOC incident evidence is JSON-only
            if report_type == "CTSO_TSOC_INCIDENT_EVIDENCE":
                evidence = await self._collect_incident_evidence(scope, from_dt, to_dt)
                data = json.dumps(evidence, indent=2, default=str).encode('utf-8')
                ct = "application/json"
                row_count = sum(
                    len(evidence.get("alarmTimeline", [])),
                    len(evidence.get("auditEvents", [])),
                    len(evidence.get("affectedDevices", [])),
                )
            else:
                rows, headers = await self._fetch_data(report_type, scope, from_dt, to_dt)
                if fmt == "xls":
                    data = generate_xls(headers, rows)
                    ct = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                else:
                    data = generate_csv(headers, rows)
                    ct = "text/csv"
                row_count = len(rows)

            await self._reports_col.update_one({"_id": report_id}, {"$set": {
                "status": "DONE", "rowCount": row_count,
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

    # ── WO-068: CTSO/TSOC Incident Evidence ────────────────────────────────────────

    async def _collect_incident_evidence(self, scope: dict,
                                          from_dt: datetime, to_dt: datetime) -> dict:
        """
        Assemble CTSO/TSOC incident evidence package containing:
        - Alarm timeline with lifecycle events
        - Audit trail references
        - Affected inventory summary
        - Northbound integration metadata (when available)
        - Checksums and generation provenance
        """
        # Extract lookup criteria from scope
        alarm_id = scope.get("alarmId")
        correlation_id = scope.get("correlationId")
        incident_ref = scope.get("incidentRef")
        device_id = scope.get("deviceId")

        if not any([alarm_id, correlation_id, incident_ref, device_id]):
            raise ValueError(
                "CTSO/TSOC evidence requires at least one of: "
                "alarmId, correlationId, incidentRef, deviceId"
            )

        # Collect alarm timeline
        alarm_timeline = await self._collect_alarm_timeline(
            alarm_id, correlation_id, device_id, from_dt, to_dt
        )

        # Collect audit events
        audit_events = await self._collect_audit_events(
            alarm_id, correlation_id, device_id, from_dt, to_dt
        )

        # Collect affected inventory
        affected_devices = await self._collect_affected_inventory(
            alarm_timeline, device_id
        )

        # Collect northbound integration metadata (best-effort)
        integration_metadata = await self._collect_integration_metadata(
            alarm_id, correlation_id, from_dt, to_dt
        )

        # Build evidence package
        evidence = {
            "reportType": "CTSO_TSOC_INCIDENT_EVIDENCE",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "generatedBy": "report-service",
            "lookupCriteria": {
                "alarmId": alarm_id,
                "correlationId": correlation_id,
                "incidentRef": incident_ref,
                "deviceId": device_id,
                "timeRange": {
                    "from": from_dt.isoformat(),
                    "to": to_dt.isoformat(),
                },
            },
            "alarmTimeline": alarm_timeline,
            "auditEvents": audit_events,
            "affectedDevices": affected_devices,
            "integrationMetadata": integration_metadata,
            "evidenceCompleteness": self._assess_completeness(
                alarm_timeline, audit_events, affected_devices
            ),
            "privacyPolicyVersion": "1.0",
        }

        # Apply data masking (WO-069)
        evidence = self._mask_sensitive_fields(evidence)

        # Compute checksum
        evidence_json = json.dumps(evidence, sort_keys=True, default=str)
        checksum = hashlib.sha256(evidence_json.encode('utf-8')).hexdigest()
        evidence["checksum"] = checksum

        return evidence

    async def _collect_alarm_timeline(self, alarm_id: Optional[str],
                                       correlation_id: Optional[str],
                                       device_id: Optional[str],
                                       from_dt: datetime, to_dt: datetime) -> list:
        """Collect alarm lifecycle timeline ordered by timestamp."""
        query: dict = {
            "raisedAt": {"$gte": from_dt, "$lte": to_dt},
        }
        if alarm_id:
            query["alarmId"] = alarm_id
        if correlation_id:
            query["correlationId"] = correlation_id
        if device_id:
            query["deviceId"] = device_id

        alarms = await self._alarms_col.find(query).sort("raisedAt", 1).to_list(length=1000)

        timeline = []
        for alarm in alarms:
            # Build lifecycle events for this alarm
            events = []
            if raised_at := alarm.get("raisedAt"):
                events.append({
                    "state": "RAISED",
                    "timestamp": raised_at.isoformat() if hasattr(raised_at, 'isoformat') else str(raised_at),
                    "severity": alarm.get("severity"),
                })
            if acked_at := alarm.get("acknowledgedAt"):
                events.append({
                    "state": "ACKNOWLEDGED",
                    "timestamp": acked_at.isoformat() if hasattr(acked_at, 'isoformat') else str(acked_at),
                    "acknowledgedBy": alarm.get("acknowledgedBy"),
                })
            if escalated_at := alarm.get("escalatedAt"):
                events.append({
                    "state": "ESCALATED",
                    "timestamp": escalated_at.isoformat() if hasattr(escalated_at, 'isoformat') else str(escalated_at),
                    "escalatedTo": alarm.get("escalatedTo"),
                })
            if cleared_at := alarm.get("clearedAt"):
                events.append({
                    "state": "CLEARED",
                    "timestamp": cleared_at.isoformat() if hasattr(cleared_at, 'isoformat') else str(cleared_at),
                })

            timeline.append({
                "alarmId": alarm.get("alarmId") or str(alarm.get("_id", "")),
                "deviceId": alarm.get("deviceId"),
                "alarmType": alarm.get("alarmType"),
                "severity": alarm.get("severity"),
                "correlationId": alarm.get("correlationId"),
                "lifecycleEvents": events,
            })

        return timeline if timeline else [{"status": "unavailable", "reason": "No alarms found for criteria"}]

    async def _collect_audit_events(self, alarm_id: Optional[str],
                                     correlation_id: Optional[str],
                                     device_id: Optional[str],
                                     from_dt: datetime, to_dt: datetime) -> list:
        """Collect audit events without exposing restricted payload values."""
        query: dict = {
            "timestamp": {"$gte": from_dt, "$lte": to_dt},
        }
        if alarm_id:
            query["$or"] = [
                {"resource": alarm_id},
                {"metadata.alarmId": alarm_id},
            ]
        elif correlation_id:
            query["correlationId"] = correlation_id
        elif device_id:
            query["$or"] = [
                {"resource": device_id},
                {"metadata.deviceId": device_id},
            ]

        events = await self._audit_col.find(query).sort("timestamp", 1).to_list(length=1000)

        audit_trail = []
        for event in events:
            audit_trail.append({
                "eventId": str(event.get("_id", "")),
                "timestamp": event.get("timestamp").isoformat() if hasattr(event.get("timestamp"), 'isoformat') else str(event.get("timestamp")),
                "actor": event.get("actor"),
                "action": event.get("action"),
                "resource": event.get("resource"),
                "outcome": event.get("outcome"),
                "correlationId": event.get("correlationId"),
                # Metadata without sensitive payload
                "resourceType": event.get("metadata", {}).get("resourceType"),
            })

        return audit_trail if audit_trail else [{"status": "unavailable", "reason": "No audit events found"}]

    async def _collect_affected_inventory(self, alarm_timeline: list,
                                           device_id: Optional[str]) -> list:
        """Collect inventory summary for affected devices."""
        device_ids = set()
        if device_id:
            device_ids.add(device_id)

        # Extract device IDs from alarm timeline
        for alarm in alarm_timeline:
            if isinstance(alarm, dict) and alarm.get("deviceId"):
                device_ids.add(alarm["deviceId"])

        if not device_ids:
            return [{"status": "unavailable", "reason": "No devices identified"}]

        devices = await self._inv_col.find({"deviceId": {"$in": list(device_ids)}}).to_list(length=100)

        inventory = []
        for device in devices:
            inventory.append({
                "deviceId": device.get("deviceId"),
                "deviceType": device.get("deviceType"),
                "model": device.get("model"),
                "networkId": device.get("networkId"),
                "status": device.get("status"),
            })

        return inventory if inventory else [{"status": "unavailable", "reason": "Devices not found in inventory"}]

    async def _collect_integration_metadata(self, alarm_id: Optional[str],
                                             correlation_id: Optional[str],
                                             from_dt: datetime, to_dt: datetime) -> list:
        """Collect northbound delivery/replay references when available (best-effort)."""
        query: dict = {
            "timestamp": {"$gte": from_dt, "$lte": to_dt},
        }
        if correlation_id:
            query["correlationId"] = correlation_id
        elif alarm_id:
            query["metadata.alarmId"] = alarm_id

        try:
            events = await self._events_col.find(query).to_list(length=100)
            metadata = []
            for event in events:
                metadata.append({
                    "eventId": str(event.get("_id", "")),
                    "deliveryStatus": event.get("deliveryStatus"),
                    "destination": event.get("destination"),
                    "timestamp": event.get("timestamp").isoformat() if hasattr(event.get("timestamp"), 'isoformat') else str(event.get("timestamp")),
                })
            return metadata if metadata else [{"status": "unavailable", "reason": "No integration events"}]
        except Exception as e:
            log.warning("Integration metadata collection failed: %s", e)
            return [{"status": "unavailable", "reason": f"Collection error: {str(e)}"}]

    def _assess_completeness(self, alarm_timeline: list,
                             audit_events: list, affected_devices: list) -> dict:
        """
        Assess evidence completeness and mark missing sections.
        """
        return {
            "alarmData": "complete" if alarm_timeline and not any(
                a.get("status") == "unavailable" for a in alarm_timeline
            ) else "unavailable",
            "auditData": "complete" if audit_events and not any(
                e.get("status") == "unavailable" for e in audit_events
            ) else "unavailable",
            "inventoryData": "complete" if affected_devices and not any(
                d.get("status") == "unavailable" for d in affected_devices
            ) else "unavailable",
        }

    def _mask_sensitive_fields(self, evidence: dict) -> dict:
        """
        Apply WO-069 data masking policy to incident evidence.
        Masks restricted fields (tokens, secrets, credentials, PII).
        """
        # List of sensitive field name patterns
        sensitive_patterns = [
            "password", "secret", "token", "key", "credential",
            "hmac", "private_key", "certificate", "connection_string",
            "api_key", "auth_token", "bearer", "jwt", "ssn", "credit_card",
        ]

        def mask_recursive(obj):
            if isinstance(obj, dict):
                return {
                    k: "[REDACTED]" if any(pattern in k.lower() for pattern in sensitive_patterns)
                    else mask_recursive(v)
                    for k, v in obj.items()
                }
            elif isinstance(obj, list):
                return [mask_recursive(item) for item in obj]
            else:
                return obj

        return mask_recursive(evidence)
