"""Kafka message dataclasses for UBR NMS canonical event schemas."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Literal, Optional

from .models import AlarmSeverity, AlarmState, DeviceType


@dataclass
class RawAlarmData:
    device_type: DeviceType
    device_id: str


@dataclass
class RawAlarmMessage:
    """Kafka raw-alarms topic. 'time' maps to JSON key 'Time' per BRD format."""
    alarm_id: str
    alarm_name: str
    severity: AlarmSeverity
    state: Literal["RAISED", "CLEARED"]
    time: datetime
    data: RawAlarmData
    alarm_description: Optional[str] = None


@dataclass
class ProcessedAlarmMessage:
    alarm_id: str
    device_id: str
    alarm_name: str
    severity: AlarmSeverity
    state: AlarmState
    correlation_group: str
    raised_at: datetime
    device_type: Optional[DeviceType] = None
    alarm_description: Optional[str] = None
    root_cause: Optional[str] = None
    acknowledged: bool = False
    processed_at: Optional[datetime] = None


@dataclass
class RawKPIMessage:
    device_id: str
    kpi_name: str
    value: float
    timestamp: datetime
    serial_number: Optional[str] = None
    device_type: Optional[DeviceType] = None
    unit: Optional[str] = None


@dataclass
class ConfigPushMessage:
    job_id: str
    device_id: str
    template_id: str
    protocol: Literal["NETCONF", "CLI", "TR-069"]
    parameters: dict
    device_type: Optional[DeviceType] = None
    approved_by: Optional[str] = None
    ttl_expiry: Optional[datetime] = None
    enqueued_at: Optional[datetime] = None


@dataclass
class DeviceDiscoveredMessage:
    device_id: str
    serial_number: str
    mac_address: str
    device_type: DeviceType
    discovered_at: datetime
    ip_address: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None


@dataclass
class NetcoolAlarmForwardMessage:
    """Northbound Netcool forwarding. 'time' maps to JSON key 'Time'."""
    alarm_id: str
    alarm_name: str
    severity: AlarmSeverity
    alarm_description: str
    state: AlarmState
    time: datetime
    data: RawAlarmData


@dataclass
class EthernetPort:
    port_id: Optional[str] = None
    tx_bytes_total: Optional[int] = None
    rx_bytes_total: Optional[int] = None
    tx_errors_pct: Optional[float] = None
    rx_errors_pct: Optional[float] = None
    link_uptime: Optional[int] = None


@dataclass
class Wireless5GhzRadio:
    tx_power_dbm: Optional[float] = None
    rx_signal_strength_dbm: Optional[float] = None
    channel_utilization_pct: Optional[float] = None
    snr_db: Optional[float] = None
    connected_clients: Optional[int] = None
    modulation: Optional[str] = None
    throughput_mbps: Optional[float] = None


@dataclass
class MycomKPIExportMessage:
    device_id: str
    serial_number: str
    timestamp: datetime
    ip_address: Optional[str] = None
    wireless_5ghz_radio: Optional[Wireless5GhzRadio] = None
    ethernet_ports: List[EthernetPort] = field(default_factory=list)


@dataclass
class InventorySyncMessage:
    ip_address: str
    mac_address: str
    serial_number: str
    model: str
    firmware: str
    system_name: Optional[str] = None
    device_type: Optional[DeviceType] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    region: Optional[str] = None
    organization_id: Optional[str] = None
    sync_source: Optional[Literal["mobinet", "telemedia", "manual"]] = None
    synced_at: Optional[datetime] = None
