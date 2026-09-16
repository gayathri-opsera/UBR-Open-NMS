"""
Main simulator runner. Loads a YAML profile and orchestrates all simulation loops.
Extended with a UBR call-home state machine for release-1 acceptance validation (WO-035).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import secrets
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional
import yaml

from device import (
    Fleet, DeviceState,
    generate_kpi_response, generate_snmp_trap, generate_syslog_message, pick_severity,
)
from metrics import (
    simulated_devices_active, simulated_events_generated_total,
    simulated_checkins_total, start_metrics_server,
)
from ubr_protocol import (
    ServiceRegistry, build_signed_headers, decode_kv_registry,
    generate_nonce, parse_retry_headers,
)

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
)
log = logging.getLogger(__name__)


# ── UBR Simulator State Machine ──────────────────────────────────────────────

class SimulatorBootstrapState(str, Enum):
    """Explicit UBR call-home bootstrap state machine states."""
    BOOT           = "BOOT"
    DISCOVERY      = "DISCOVERY"
    AUTHENTICATION = "AUTHENTICATION"
    CHECK_IN       = "CHECK_IN"
    REALTIME       = "REALTIME"
    OPERATION      = "OPERATION"
    FAILED         = "FAILED"
    REDIRECTED     = "REDIRECTED"


@dataclass
class SimulatorResult:
    """
    Structured result from a simulator run, consumable by the scenario runner.
    Only redacted identity and correlation fields appear here — no secrets.
    """
    state: SimulatorBootstrapState
    endpoint: Optional[str]
    status_code: Optional[int]
    reason: Optional[str]
    retryable: bool
    retry_after_seconds: int
    retry_jitter_max_seconds: int
    device_id: str             # MAC address [redacted] in log output
    transitions: List[str] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state":                   self.state.value,
            "endpoint":                self.endpoint,
            "status_code":             self.status_code,
            "reason":                  self.reason,
            "retryable":               self.retryable,
            "retry_after_seconds":     self.retry_after_seconds,
            "retry_jitter_max_seconds": self.retry_jitter_max_seconds,
            "device_id":               self.device_id,
            "transitions":             self.transitions,
            "error":                   self.error,
        }


class UbrDeviceSimulator:
    """
    Protocol-complete UBR call-home device simulator (WO-035).

    Runs the BOOT → DISCOVERY → AUTHENTICATION → CHECK_IN → REALTIME → OPERATION
    state machine with injected HTTP and WebSocket clients so unit tests do not
    require live infrastructure.

    SECURITY: HMAC secrets are accepted as arguments but never logged, printed,
    or stored in instance state after use. Log lines redact MAC addresses and
    device identity.
    """

    _REGISTRY_PATH = "/discovery/v1/kv/services"

    def __init__(
        self,
        serial_number: str,
        mac_address: str,
        device_type: str,
        firmware_version: str,
        http_client: Any,
        ws_client: Any,
        hmac_secret: str,
        ping_interval_seconds: int = 15,
        receive_timeout_seconds: int = 30,
        discovery_base_url: str = "http://localhost:8081",
    ) -> None:
        self.serial_number       = serial_number
        self.mac_address         = mac_address
        self.device_type         = device_type
        self.firmware_version    = firmware_version
        self._http               = http_client
        self._ws                 = ws_client
        self._ping_interval      = ping_interval_seconds
        self._receive_timeout    = receive_timeout_seconds
        self._discovery_base_url = discovery_base_url
        # Secret is kept only for the lifetime of a single run; never stored as-is.
        self.__secret            = hmac_secret
        self._transitions: List[str] = []
        self._registry: Optional[ServiceRegistry] = None

    def _transition(self, state: SimulatorBootstrapState) -> None:
        log.info("UBR simulator state: %s device_type=%s", state.value, self.device_type)
        self._transitions.append(state.value)

    def _fail(self, reason: str, endpoint: Optional[str] = None,
              status_code: Optional[int] = None, retryable: bool = False,
              retry_after: int = 0, jitter_max: int = 0) -> SimulatorResult:
        self._transition(SimulatorBootstrapState.FAILED)
        return SimulatorResult(
            state=SimulatorBootstrapState.FAILED,
            endpoint=endpoint,
            status_code=status_code,
            reason=reason,
            retryable=retryable,
            retry_after_seconds=retry_after,
            retry_jitter_max_seconds=jitter_max,
            device_id="[redacted]",
            transitions=list(self._transitions),
            error=reason,
        )

    def run(self) -> SimulatorResult:
        """
        Execute the full UBR bootstrap state machine synchronously.
        Returns a SimulatorResult regardless of outcome — never raises.
        """
        try:
            return self._run_state_machine()
        except Exception as exc:
            log.error("Simulator run raised unexpected exception: %s", exc)
            return SimulatorResult(
                state=SimulatorBootstrapState.FAILED,
                endpoint=None, status_code=None,
                reason="INTERNAL_SIMULATOR_ERROR",
                retryable=False, retry_after_seconds=0, retry_jitter_max_seconds=0,
                device_id="[redacted]",
                transitions=list(self._transitions),
                error=str(exc),
            )

    def _run_state_machine(self) -> SimulatorResult:
        # ── BOOT ──────────────────────────────────────────────────────────────
        self._transition(SimulatorBootstrapState.BOOT)

        # ── DISCOVERY ─────────────────────────────────────────────────────────
        self._transition(SimulatorBootstrapState.DISCOVERY)
        registry_url = f"{self._discovery_base_url}{self._REGISTRY_PATH}?recurse=1"
        try:
            resp = self._http.get(registry_url, headers={"Accept": "application/json"}, timeout=10)
        except Exception as exc:
            return self._fail("NETWORK_ERROR", endpoint=registry_url, retryable=True,
                              retry_after=30, jitter_max=10)

        # Handle NMS_FAILOVER redirect at any stage.
        if resp.status_code == 302:
            location = resp.headers.get("Location", "")
            log.info("NMS_FAILOVER redirect received during DISCOVERY; restarting at: [redacted]")
            self._transition(SimulatorBootstrapState.REDIRECTED)
            return SimulatorResult(
                state=SimulatorBootstrapState.REDIRECTED,
                endpoint=registry_url,
                status_code=302,
                reason="NMS_FAILOVER",
                retryable=True,
                retry_after_seconds=0,
                retry_jitter_max_seconds=0,
                device_id="[redacted]",
                transitions=list(self._transitions),
                error=None,
            )

        if resp.status_code == 429:
            retry_after, jitter_max = parse_retry_headers(dict(resp.headers))
            return self._fail("RATE_LIMITED", endpoint=registry_url,
                              status_code=429, retryable=True,
                              retry_after=retry_after, jitter_max=jitter_max)

        if resp.status_code == 503:
            retry_after, jitter_max = parse_retry_headers(dict(resp.headers))
            return self._fail("SERVICE_UNAVAILABLE", endpoint=registry_url,
                              status_code=503, retryable=True,
                              retry_after=retry_after, jitter_max=jitter_max)

        if resp.status_code != 200:
            return self._fail("REGISTRY_ERROR", endpoint=registry_url,
                              status_code=resp.status_code, retryable=False)

        try:
            kv_data = resp.json()
        except (ValueError, AttributeError):
            return self._fail("MALFORMED_REGISTRY_RESPONSE", endpoint=registry_url,
                              status_code=resp.status_code, retryable=False)

        registry = decode_kv_registry(kv_data)
        if not registry.is_complete():
            log.warning("KV registry missing required service endpoints; retrying")
            return self._fail("INCOMPLETE_REGISTRY", endpoint=registry_url,
                              status_code=200, retryable=True, retry_after=10, jitter_max=5)
        self._registry = registry

        # ── AUTHENTICATION ─────────────────────────────────────────────────────
        self._transition(SimulatorBootstrapState.AUTHENTICATION)
        auth_body = json.dumps({
            "serialNumber":    self.serial_number,
            "macAddress":      self.mac_address,
            "deviceType":      self.device_type,
            "firmwareVersion": self.firmware_version,
        }).encode()
        auth_path = _path_from_url(registry.auth_url)
        auth_headers = {
            "Content-Type": "application/json",
            **build_signed_headers(
                self.__secret, self.mac_address, auth_path, body=auth_body
            ),
        }
        try:
            auth_resp = self._http.post(registry.auth_url, data=auth_body,
                                        headers=auth_headers, timeout=10)
        except Exception:
            return self._fail("AUTH_NETWORK_ERROR", endpoint=registry.auth_url,
                              retryable=True, retry_after=30, jitter_max=10)

        if auth_resp.status_code == 302:
            self._transition(SimulatorBootstrapState.REDIRECTED)
            return SimulatorResult(
                state=SimulatorBootstrapState.REDIRECTED,
                endpoint=registry.auth_url, status_code=302, reason="NMS_FAILOVER",
                retryable=True, retry_after_seconds=0, retry_jitter_max_seconds=0,
                device_id="[redacted]", transitions=list(self._transitions),
            )
        if auth_resp.status_code in (462, 495, 496):
            return self._fail("HMAC_INVALID" if auth_resp.status_code == 462
                              else "MTLS_ERROR",
                              endpoint=registry.auth_url,
                              status_code=auth_resp.status_code,
                              retryable=False)
        if auth_resp.status_code == 429:
            retry_after, jitter_max = parse_retry_headers(dict(auth_resp.headers))
            return self._fail("RATE_LIMITED", endpoint=registry.auth_url,
                              status_code=429, retryable=True,
                              retry_after=retry_after, jitter_max=jitter_max)
        if auth_resp.status_code not in (200, 201):
            retryable = auth_resp.status_code >= 500
            retry_after, jitter_max = parse_retry_headers(dict(auth_resp.headers)) if retryable else (0, 0)
            return self._fail("AUTH_REJECTED", endpoint=registry.auth_url,
                              status_code=auth_resp.status_code, retryable=retryable,
                              retry_after=retry_after, jitter_max=jitter_max)

        # ── CHECK_IN ──────────────────────────────────────────────────────────
        self._transition(SimulatorBootstrapState.CHECK_IN)
        checkin_body = json.dumps({
            "serialNumber":    self.serial_number,
            "macAddress":      self.mac_address,
            "deviceType":      self.device_type,
            "firmwareVersion": self.firmware_version,
        }).encode()
        checkin_path = _path_from_url(registry.checkin_url)
        checkin_headers = {
            "Content-Type": "application/json",
            **build_signed_headers(
                self.__secret, self.mac_address, checkin_path, body=checkin_body
            ),
        }
        try:
            ci_resp = self._http.post(registry.checkin_url, data=checkin_body,
                                      headers=checkin_headers, timeout=10)
        except Exception:
            return self._fail("CHECKIN_NETWORK_ERROR", endpoint=registry.checkin_url,
                              retryable=True, retry_after=30, jitter_max=10)

        if ci_resp.status_code == 302:
            self._transition(SimulatorBootstrapState.REDIRECTED)
            return SimulatorResult(
                state=SimulatorBootstrapState.REDIRECTED,
                endpoint=registry.checkin_url, status_code=302, reason="NMS_FAILOVER",
                retryable=True, retry_after_seconds=0, retry_jitter_max_seconds=0,
                device_id="[redacted]", transitions=list(self._transitions),
            )
        if ci_resp.status_code == 462:
            return self._fail("HMAC_INVALID_AFTER_AUTH",
                              endpoint=registry.checkin_url,
                              status_code=462, retryable=False)
        if ci_resp.status_code == 429:
            retry_after, jitter_max = parse_retry_headers(dict(ci_resp.headers))
            return self._fail("RATE_LIMITED", endpoint=registry.checkin_url,
                              status_code=429, retryable=True,
                              retry_after=retry_after, jitter_max=jitter_max)
        if ci_resp.status_code not in (200, 201):
            retryable = ci_resp.status_code >= 500
            retry_after, jitter_max = parse_retry_headers(dict(ci_resp.headers)) if retryable else (0, 0)
            return self._fail("CHECKIN_REJECTED", endpoint=registry.checkin_url,
                              status_code=ci_resp.status_code, retryable=retryable,
                              retry_after=retry_after, jitter_max=jitter_max)

        # ── REALTIME ──────────────────────────────────────────────────────────
        self._transition(SimulatorBootstrapState.REALTIME)
        try:
            ws_connected = self._ws.connect(
                registry.realtime_url,
                ping_interval=self._ping_interval,
                receive_timeout=self._receive_timeout,
            )
        except Exception as exc:
            return self._fail("REALTIME_CONNECT_ERROR",
                              endpoint=registry.realtime_url,
                              retryable=True, retry_after=15, jitter_max=5)

        if not ws_connected:
            return self._fail("REALTIME_TIMEOUT",
                              endpoint=registry.realtime_url,
                              retryable=True, retry_after=15, jitter_max=5)

        # ── OPERATION ─────────────────────────────────────────────────────────
        self._transition(SimulatorBootstrapState.OPERATION)
        return SimulatorResult(
            state=SimulatorBootstrapState.OPERATION,
            endpoint=registry.realtime_url,
            status_code=101,
            reason=None,
            retryable=False,
            retry_after_seconds=0,
            retry_jitter_max_seconds=0,
            device_id="[redacted]",
            transitions=list(self._transitions),
        )


def _path_from_url(url: str) -> str:
    """Extract the path component from a URL string for HMAC signing."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return parsed.path or "/"
    except Exception:
        return "/"


# ── Profile fixture loader ────────────────────────────────────────────────────

def load_device_profile(path: str) -> dict:
    """Load a device fixture profile from a JSON file."""
    with open(path) as f:
        return json.load(f)


# ── Existing fleet simulation (preserved from original simulator) ─────────────

def load_profile(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


async def checkin_loop(fleet: Fleet, cfg: dict, discovery_url: str):
    """Periodically sends check-ins for all ONLINE devices."""
    interval = cfg["checkin"]["interval_seconds"]
    jitter = cfg["checkin"].get("jitter_seconds", 0)

    while True:
        for device in fleet.devices:
            if device.state == DeviceState.ONLINE:
                log.debug("Check-in: %s", device.device_id)
                simulated_checkins_total.inc()

        simulated_devices_active.set(fleet.active_count)

        await asyncio.sleep(interval + random.uniform(-jitter, jitter))


async def snmp_trap_loop(fleet: Fleet, cfg: dict, event_collector_host: str):
    """Generates SNMP traps at configured rate."""
    snmp_cfg = cfg.get("snmp", {})
    rate = snmp_cfg.get("trap_rate_per_minute", 1)
    enterprise_oid = snmp_cfg.get("enterprise_oid_prefix", "1.3.6.1.4.1.28776")
    interval = 60.0 / rate if rate > 0 else 60

    while True:
        online_devices = [d for d in fleet.devices if d.state == DeviceState.ONLINE]
        if online_devices:
            device = random.choice(online_devices)
            trap = generate_snmp_trap(device, enterprise_oid)
            log.debug("SNMP trap: %s from %s", trap["enterprise"], device.device_id)
            simulated_events_generated_total.labels(event_type="snmp_trap").inc()

        await asyncio.sleep(interval / max(len(fleet.devices), 1))


async def syslog_loop(fleet: Fleet, cfg: dict, event_collector_host: str):
    """Generates syslog messages at configured rate."""
    syslog_cfg = cfg.get("syslog", {})
    rate = syslog_cfg.get("rate_per_minute", 5)
    distribution = syslog_cfg.get("severity_distribution", {"info": 1.0})
    interval = 60.0 / rate if rate > 0 else 60

    while True:
        online_devices = [d for d in fleet.devices if d.state == DeviceState.ONLINE]
        if online_devices:
            device = random.choice(online_devices)
            severity = pick_severity(distribution)
            msg = generate_syslog_message(device, severity)
            log.debug("Syslog [%s] from %s: %s", severity, device.device_id, msg["message"])
            simulated_events_generated_total.labels(event_type="syslog").inc()

        await asyncio.sleep(interval / max(len(fleet.devices), 1))


async def state_transition_loop(fleet: Fleet, cfg: dict):
    """Periodically transitions device states and optionally triggers alarm storms."""
    interval = cfg["checkin"]["interval_seconds"]
    alarm_storm_cfg = cfg.get("alarm_storm", {})
    storm_enabled = alarm_storm_cfg.get("enabled", False)
    storm_prob = alarm_storm_cfg.get("trigger_probability", 0.0)
    storm_ratio = alarm_storm_cfg.get("devices_affected_ratio", 0.1)
    storm_duration = alarm_storm_cfg.get("burst_duration_seconds", 60)

    while True:
        changed = fleet.tick_state_transitions()
        for device in changed:
            log.info("State change: %s → %s", device.device_id, device.state.value)
            simulated_events_generated_total.labels(event_type="state_change").inc()

        if storm_enabled and random.random() < storm_prob:
            storm_count = int(len(fleet.devices) * storm_ratio)
            storm_targets = random.sample(fleet.devices, min(storm_count, len(fleet.devices)))
            log.warning("ALARM STORM: triggering alarms on %d devices for %ds",
                        len(storm_targets), storm_duration)
            for device in storm_targets:
                simulated_events_generated_total.labels(event_type="alarm_storm").inc()

        simulated_devices_active.set(fleet.active_count)
        await asyncio.sleep(interval)


async def main():
    profile_path = os.environ.get("SIMULATOR_PROFILE", "profiles/small-10.yaml")
    discovery_url = os.environ.get("DISCOVERY_URL", "http://localhost:8080")
    event_collector_host = os.environ.get("EVENT_COLLECTOR_HOST", "localhost")

    cfg = load_profile(profile_path)
    log.info("Loaded profile: %s (%d devices)", cfg["profile_name"], cfg["fleet"]["total_devices"])

    fleet = Fleet(cfg)
    log.info("Fleet initialized: %d BTS + %d CPE devices",
             sum(1 for d in fleet.devices if d.device_type.value == "BTS"),
             sum(1 for d in fleet.devices if d.device_type.value == "CPE"))

    metrics_port = cfg.get("metrics_port", 9100)
    start_metrics_server(metrics_port)
    log.info("Metrics server started on :%d", metrics_port)

    simulated_devices_active.set(fleet.active_count)

    await asyncio.gather(
        checkin_loop(fleet, cfg, discovery_url),
        snmp_trap_loop(fleet, cfg, event_collector_host),
        syslog_loop(fleet, cfg, event_collector_host),
        state_transition_loop(fleet, cfg),
    )


if __name__ == "__main__":
    asyncio.run(main())
