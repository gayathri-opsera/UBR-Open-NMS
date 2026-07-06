"""Core config push worker: consumes Kafka events and dispatches to adapters."""
import asyncio
import json
import logging
import time
from datetime import datetime, timezone

from prometheus_client import Counter, Histogram

from .config import Config
from .netconf_adapter import _build_netconf_xml, netconf_push
from .cli_adapter import _params_to_cli_commands, cli_push
from .tr069_adapter import build_set_parameter_values_rpc, tr069_push
from .retry import retry_async

log = logging.getLogger(__name__)

config_push_total = Counter(
    "config_push_total", "Total config push operations by status",
    ["status", "protocol"]
)
config_push_duration = Histogram(
    "config_push_duration_seconds", "Config push duration in seconds",
    buckets=[1, 5, 10, 15, 20, 30, 60]
)
pending_drained_total = Counter(
    "pending_commands_drained_total", "Total pending commands drained to devices"
)


class ConfigPushWorker:
    def __init__(self, mongo_db, kafka_producer=None):
        self.db = mongo_db
        self.producer = kafka_producer

    async def handle_push_event(self, event: dict) -> dict:
        """Process a single config-push event. Returns result dict."""
        device_id = event.get("deviceId")
        template_id = event.get("templateId")
        job_id = event.get("jobId")
        actor = event.get("actor", "system")

        template = await self._get_template(template_id)
        device = await self._get_device(device_id)

        if not template or not device:
            return self._fail(device_id, job_id, "Template or device not found", "UNKNOWN")

        params = self._template_to_params(template)
        protocol = self._select_protocol(device)
        host = device.get("ipAddress", device_id)

        start = time.monotonic()
        try:
            await retry_async(
                lambda: self._dispatch(protocol, host, params),
                attempts=Config.RETRY_ATTEMPTS,
                base_delay=Config.RETRY_BASE_DELAY_S,
                label=f"push:{device_id}",
            )
            elapsed = time.monotonic() - start
            config_push_total.labels(status="SUCCESS", protocol=protocol).inc()
            config_push_duration.observe(elapsed)
            await self._update_job(job_id, device_id, "SUCCESS")
            return {"deviceId": device_id, "status": "SUCCESS", "protocol": protocol,
                    "durationMs": int(elapsed * 1000)}
        except asyncio.TimeoutError:
            config_push_total.labels(status="TIMEOUT", protocol=protocol).inc()
            await self._update_job(job_id, device_id, "TIMEOUT")
            return self._fail(device_id, job_id, "Timeout after 30s", protocol)
        except Exception as exc:
            if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
                config_push_total.labels(status="TIMEOUT", protocol=protocol).inc()
                await self._update_job(job_id, device_id, "TIMEOUT")
                return self._fail(device_id, job_id, "Timeout after 30s", protocol)
            config_push_total.labels(status="FAILURE", protocol=protocol).inc()
            await self._update_job(job_id, device_id, f"FAILURE: {exc}")
            return self._fail(device_id, job_id, str(exc), protocol)

    async def drain_pending_commands(self, device_id: str) -> int:
        """Deliver PENDING commands to a device that has come back online."""
        drained = 0
        cursor = self.db.pending_commands.find(
            {"deviceId": device_id, "status": "PENDING"}
        ).sort("createdAt", 1)

        async for cmd in cursor:
            # Check TTL
            if cmd.get("expiresAt") and cmd["expiresAt"] < datetime.now(tz=timezone.utc):
                await self.db.pending_commands.update_one(
                    {"_id": cmd["_id"]}, {"$set": {"status": "EXPIRED"}}
                )
                continue

            result = await self.handle_push_event({
                "deviceId": device_id,
                "templateId": cmd.get("templateId"),
                "jobId": cmd.get("jobId"),
                "actor": cmd.get("actor", "system"),
            })

            status = "DELIVERED" if result.get("status") == "SUCCESS" else "FAILED"
            await self.db.pending_commands.update_one(
                {"_id": cmd["_id"]},
                {"$set": {"status": status, "deliveredAt": datetime.now(tz=timezone.utc)}}
            )
            if status == "DELIVERED":
                drained += 1
                pending_drained_total.inc()

        return drained

    # ── private helpers ──────────────────────────────────────────────

    async def _dispatch(self, protocol: str, host: str, params: dict) -> None:
        if protocol == "NETCONF":
            await netconf_push(host, Config.NETCONF_PORT,
                               Config.DEVICE_USERNAME, Config.DEVICE_PASSWORD,
                               Config.NETCONF_KEY_FILE, params, Config.PUSH_TIMEOUT_S)
        elif protocol == "TR069":
            await tr069_push(host, Config.TR069_PORT, params, Config.PUSH_TIMEOUT_S)
        else:
            await cli_push(host, Config.SSH_PORT,
                           Config.DEVICE_USERNAME, Config.DEVICE_PASSWORD,
                           params, Config.PUSH_TIMEOUT_S)

    def _select_protocol(self, device: dict) -> str:
        dtype = device.get("type", "").upper()
        if dtype == "CPE":
            return "TR069"
        caps = device.get("capabilities", [])
        if "NETCONF" in caps:
            return "NETCONF"
        return "CLI"

    def _template_to_params(self, template: dict) -> dict:
        skip = {"_id", "id", "name", "description", "deviceType", "isDefault",
                "createdBy", "createdAt", "updatedAt"}
        return {k: v for k, v in template.items() if k not in skip and v is not None}

    async def _get_template(self, template_id: str) -> dict | None:
        if not template_id:
            return None
        return await self.db.config_templates.find_one({"_id": template_id}) or \
               await self.db.config_templates.find_one({"id": template_id})

    async def _get_device(self, device_id: str) -> dict | None:
        if not device_id:
            return None
        return await self.db.devices.find_one({"deviceId": device_id}) or \
               await self.db.devices.find_one({"serialNumber": device_id})

    async def _update_job(self, job_id: str | None, device_id: str, status: str) -> None:
        if not job_id:
            return
        await self.db.config_jobs.update_one(
            {"_id": job_id},
            {"$set": {f"perDeviceStatus.{device_id}": status}},
        )

    @staticmethod
    def _fail(device_id: str, job_id: str | None, reason: str, protocol: str) -> dict:
        return {"deviceId": device_id, "jobId": job_id,
                "status": "FAILURE", "reason": reason, "protocol": protocol}
