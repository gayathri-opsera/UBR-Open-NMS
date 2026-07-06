"""
Main simulator runner. Loads a YAML profile and orchestrates all simulation loops.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import sys
import yaml

from device import (
    Fleet, DeviceState,
    generate_kpi_response, generate_snmp_trap, generate_syslog_message, pick_severity,
)
from metrics import (
    simulated_devices_active, simulated_events_generated_total,
    simulated_checkins_total, start_metrics_server,
)

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
)
log = logging.getLogger(__name__)


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
                # In integration test mode: POST to Discovery Service
                log.debug("Check-in: %s", device.device_id)
                simulated_checkins_total.inc()

        # Update active device gauge
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

        # Alarm storm
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
