"""Canonical data model dataclasses for UBR NMS — shared-libs/python."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Literal, Optional

DeviceType = Literal["BTS", "CPE", "IDU"]
DeviceStatus = Literal["online", "offline", "provisioning", "decommissioned"]
AlarmSeverity = Literal["CRITICAL", "MAJOR", "MINOR", "WARNING", "INDETERMINATE", "CLEARED"]
AlarmState = Literal["RAISED", "ACKNOWLEDGED", "CLEARED"]
UserRole = Literal["admin", "operator", "user"]
AuditOutcome = Literal["success", "failure", "denied"]
KPIGranularity = Literal["raw", "15min", "1hour", "daily"]
ConfigStatus = Literal["pending", "queued", "running", "completed", "failed", "rolled_back"]
ConfigProtocol = Literal["NETCONF", "CLI", "TR-069"]


@dataclass
class DeviceTag:
    key: str
    value: str


@dataclass
class DeviceEntity:
    device_id: str
    serial_number: str
    mac_address: str
    device_type: DeviceType
    status: DeviceStatus
    ip_address: Optional[str] = None
    model: Optional[str] = None
    firmware_version: Optional[str] = None
    region: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    elevation: Optional[float] = None
    azimuth: Optional[int] = None
    tilt: Optional[int] = None
    uptime_seconds: Optional[int] = None
    connected_bts_serial: Optional[str] = None
    connected_cpe_count: int = 0
    connected_idu_count: int = 0
    tags: List[DeviceTag] = field(default_factory=list)
    organization_id: Optional[str] = None
    network_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class AlarmRecord:
    alarm_id: str
    device_id: str
    alarm_name: str
    severity: AlarmSeverity
    state: AlarmState
    raised_at: datetime
    device_type: Optional[DeviceType] = None
    alarm_description: Optional[str] = None
    correlation_group: Optional[str] = None
    root_cause: Optional[str] = None
    acknowledged: bool = False
    acknowledged_by: Optional[str] = None
    cleared_at: Optional[datetime] = None
    ttl_expiry: Optional[datetime] = None


@dataclass
class KPIDataPoint:
    device_id: str
    kpi_name: str
    value: float
    timestamp: datetime
    serial_number: Optional[str] = None
    device_type: Optional[DeviceType] = None
    unit: Optional[str] = None
    poll_interval: int = 300
    granularity: KPIGranularity = "raw"


@dataclass
class ConfigTemplate:
    template_id: str
    template_name: str
    device_type: DeviceType
    parameters: Optional[Dict] = None
    validation_schema: Optional[Dict] = None
    version: int = 1
    created_by: Optional[str] = None
    is_default: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class ConfigJob:
    job_id: str
    template_id: str
    device_ids: List[str]
    status: ConfigStatus
    created_by: str
    parameters: Optional[Dict] = None
    protocol: ConfigProtocol = "NETCONF"
    approved_by: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    ttl_expiry: Optional[datetime] = None
    created_at: Optional[datetime] = None


@dataclass
class UserSession:
    session_id: str
    user_id: str
    role: UserRole
    created_at: datetime
    last_active_at: datetime
    username: Optional[str] = None
    ip_address: Optional[str] = None
    user_agent: Optional[str] = None
    refresh_token: Optional[str] = None
    expires_at: Optional[datetime] = None


@dataclass
class AuditActor:
    user_id: str
    username: str
    role: str
    ip_address: Optional[str] = None


@dataclass
class AuditResource:
    type: str
    id: str


@dataclass
class AuditEntry:
    audit_id: str
    actor: AuditActor
    action: str
    resource: AuditResource
    outcome: AuditOutcome
    timestamp: datetime
    payload: Optional[Dict] = None
    error_message: Optional[str] = None


@dataclass
class BirthCertificate:
    serial_number: str
    mac_address: str
    model: str
    device_type: DeviceType
    registered_at: datetime
    firmware: Optional[str] = None
    system_name: Optional[str] = None
    ip_address: Optional[str] = None
    public_key: Optional[str] = None
    hmac_signature: Optional[str] = None
    organization_id: Optional[str] = None
    network_id: Optional[str] = None
