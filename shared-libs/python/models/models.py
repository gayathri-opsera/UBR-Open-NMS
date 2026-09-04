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
AuditOutcome = Literal["success", "failure", "denied", "blocked", "pending"]
KPIGranularity = Literal["raw", "15min", "1hour", "daily"]
ConfigStatus = Literal["pending", "queued", "running", "completed", "failed", "rolled_back"]
ConfigProtocol = Literal["NETCONF", "CLI", "TR-069"]
DiscoveryParadigm = Literal["UBR_CALL_HOME", "GENERIC_SNMP", "GENERIC_CLI", "UNKNOWN"]
IdentityAuthority = Literal["UBR", "GENERIC", "UNKNOWN"]
BootstrapState = Literal[
    "PENDING", "AUTHENTICATED", "CHECK_IN_RECEIVED",
    "REALTIME_ESTABLISHED", "FAILED", "UNKNOWN"
]
RetentionClass = Literal[
    "audit", "security", "onboarding", "alarm_incident",
    "config_history", "evidence_export", "legacy"
]


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

    # ── WO-002 authority fields ───────────────────────────────────────────────
    schema_version: Optional[str] = "1.0"
    discovery_paradigm: Optional[DiscoveryParadigm] = None
    identity_authority: Optional[IdentityAuthority] = None
    online_state_authority: Optional[IdentityAuthority] = None
    bootstrap_state: Optional[BootstrapState] = None
    last_check_in_at: Optional[datetime] = None
    last_realtime_at: Optional[datetime] = None
    capability_profile_id: Optional[str] = None
    # Opaque reference only — never the credential value
    credential_ref: Optional[str] = None
    config_version: Optional[str] = None

    # ── WO-004 sysObjectID ───────────────────────────────────────────────────
    sys_object_id: Optional[str] = None


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
    # ── WO-008 retention class ────────────────────────────────────────────────
    retention_class: Optional[RetentionClass] = None


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
    # ── WO-008 retention class ────────────────────────────────────────────────
    retention_class: Optional[RetentionClass] = None


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
