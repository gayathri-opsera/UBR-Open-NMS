// Package proto provides adapter functions that convert between the existing
// hand-written Go model structs (models package) and the Protobuf-generated
// wire types (WO-024).
//
// # Why adapters exist
//
// Proto3 defaults differ from Go idiomatic nil semantics:
//   - int64/float64 default to 0, not nil
//   - string defaults to "", not nil
//   - optional wrappers (google.protobuf.Int64Value) used for true nullable int64
//
// These adapters encapsulate all edge-case handling so consuming services
// don't need to understand proto nullability rules.
//
// # Usage (Kafka publishing path)
//
//	event := proto.DeviceEntityToProtoMap(device)
//	bytes, _ := json.Marshal(event)   // send over Kafka
//
// # Usage (Kafka consuming path)
//
//	var msg proto.DeviceProtoMap
//	json.Unmarshal(kafkaBytes, &msg)
//	device := proto.DeviceEntityFromProtoMap(msg)
package proto

import (
	"time"

	"github.com/airtel-ubrnms/shared-libs/models"
)

// DeviceProtoMap is the JSON-serialisable intermediate representation that
// matches the field names and types emitted by the Protobuf JSON serialiser
// (proto-json format). It bridges the gap until the real generated structs are
// available after running `buf generate`.
//
// Deprecated: replaced by the buf-generated DeviceEntity message type after
// `go generate ./...` is executed.
type DeviceProtoMap struct {
	DeviceID           string  `json:"deviceId"`
	SerialNumber       string  `json:"serialNumber"`
	MacAddress         string  `json:"macAddress"`
	IPAddress          string  `json:"ipAddress,omitempty"`
	DeviceType         string  `json:"deviceType,omitempty"`
	Model              string  `json:"model,omitempty"`
	FirmwareVersion    string  `json:"firmwareVersion,omitempty"`
	Region             string  `json:"region,omitempty"`
	Status             string  `json:"status"`
	UptimeSeconds      int64   `json:"uptimeSeconds,omitempty"`
	ConnectedBTSSerial string  `json:"connectedBtsSerial,omitempty"`
	ConnectedCPECount  int32   `json:"connectedCpeCount,omitempty"`
	ConnectedIDUCount  int32   `json:"connectedIduCount,omitempty"`
	OrganizationID     string  `json:"organizationId,omitempty"`
	NetworkID          string  `json:"networkId,omitempty"`
	Latitude           float64 `json:"latitude,omitempty"`
	Longitude          float64 `json:"longitude,omitempty"`
	CreatedAtMilli     int64   `json:"createdAtMilli,omitempty"`
	UpdatedAtMilli     int64   `json:"updatedAtMilli,omitempty"`
}

// AlarmProtoMap mirrors the proto AlarmRecord JSON format.
type AlarmProtoMap struct {
	AlarmID          string `json:"alarmId"`
	DeviceID         string `json:"deviceId"`
	AlarmName        string `json:"alarmName"`
	AlarmDescription string `json:"alarmDescription,omitempty"`
	Severity         string `json:"severity"`
	State            string `json:"state"`
	CorrelationGroup string `json:"correlationGroup,omitempty"`
	RootCause        string `json:"rootCause,omitempty"`
	Acknowledged     bool   `json:"acknowledged"`
	AcknowledgedBy   string `json:"acknowledgedBy,omitempty"`
	RaisedAtMilli    int64  `json:"raisedAtMilli"`
	ClearedAtMilli   int64  `json:"clearedAtMilli,omitempty"`
}

// KPIProtoMap mirrors the proto KPIDataPoint JSON format.
type KPIProtoMap struct {
	DeviceID       string  `json:"deviceId"`
	KPIName        string  `json:"kpiName"`
	Value          float64 `json:"value"`
	Unit           string  `json:"unit,omitempty"`
	Granularity    string  `json:"granularity,omitempty"`
	TimestampMilli int64   `json:"timestampMilli"`
}

// ── DeviceEntity adapters ─────────────────────────────────────────────────────

// DeviceEntityToProtoMap converts a models.DeviceEntity into the proto-json wire format.
//
// Edge cases:
//   - zero-value time.Time fields are represented as 0 milliseconds (proto absent)
//   - nil pointer *string fields (ConnectedBTSSerial) become "" in proto
//   - enum values are represented as their string name to match proto stringEnums=true
func DeviceEntityToProtoMap(d models.DeviceEntity) DeviceProtoMap {
	m := DeviceProtoMap{
		DeviceID:          d.DeviceID,
		SerialNumber:      d.SerialNumber,
		MacAddress:        d.MacAddress,
		IPAddress:         orEmpty(d.IPAddress),
		DeviceType:        string(d.DeviceType),
		Model:             orEmpty(d.Model),
		FirmwareVersion:   orEmpty(d.FirmwareVersion),
		Region:            orEmpty(d.Region),
		Status:            string(d.Status),
		UptimeSeconds:     d.UptimeSeconds,
		ConnectedCPECount: int32(d.ConnectedCPECount),
		ConnectedIDUCount: int32(d.ConnectedIDUCount),
		OrganizationID:    orEmpty(d.OrganizationID),
		NetworkID:         orEmpty(d.NetworkID),
		Latitude:          d.Latitude,
		Longitude:         d.Longitude,
	}
	// Nullable pointer field — convert to empty string (proto absent) when nil.
	if d.ConnectedBTSSerial != nil {
		m.ConnectedBTSSerial = *d.ConnectedBTSSerial
	}
	// Zero time.Time means unset — leave milli at 0 (proto absent sentinel).
	if !d.CreatedAt.IsZero() {
		m.CreatedAtMilli = d.CreatedAt.UnixMilli()
	}
	if !d.UpdatedAt.IsZero() {
		m.UpdatedAtMilli = d.UpdatedAt.UnixMilli()
	}
	return m
}

// DeviceEntityFromProtoMap converts a proto-json DeviceProtoMap back into a models.DeviceEntity.
//
// Edge cases:
//   - proto empty string ("") is converted to nil/empty for optional fields
//   - proto milli 0 means absent timestamp — returned as zero time.Time
//   - ConnectedBTSSerial becomes a *string pointer (nil when absent)
func DeviceEntityFromProtoMap(m DeviceProtoMap) models.DeviceEntity {
	d := models.DeviceEntity{
		DeviceID:          m.DeviceID,
		SerialNumber:      m.SerialNumber,
		MacAddress:        m.MacAddress,
		DeviceType:        models.DeviceType(m.DeviceType),
		Status:            models.DeviceStatus(m.Status),
		UptimeSeconds:     m.UptimeSeconds,
		ConnectedCPECount: int(m.ConnectedCPECount),
		ConnectedIDUCount: int(m.ConnectedIDUCount),
		Latitude:          m.Latitude,
		Longitude:         m.Longitude,
	}
	// Normalise proto empty-string defaults back to Go zero values.
	d.IPAddress       = m.IPAddress
	d.Model           = m.Model
	d.FirmwareVersion = m.FirmwareVersion
	d.Region          = m.Region
	d.OrganizationID  = m.OrganizationID
	d.NetworkID       = m.NetworkID

	if m.ConnectedBTSSerial != "" {
		d.ConnectedBTSSerial = &m.ConnectedBTSSerial
	}
	if m.CreatedAtMilli != 0 {
		t := time.UnixMilli(m.CreatedAtMilli)
		d.CreatedAt = t
	}
	if m.UpdatedAtMilli != 0 {
		t := time.UnixMilli(m.UpdatedAtMilli)
		d.UpdatedAt = t
	}
	return d
}

// ── AlarmRecord adapters ──────────────────────────────────────────────────────

// AlarmRecordToProtoMap converts models.AlarmRecord to wire format.
func AlarmRecordToProtoMap(a models.AlarmRecord) AlarmProtoMap {
	m := AlarmProtoMap{
		AlarmID:          a.AlarmID,
		DeviceID:         a.DeviceID,
		AlarmName:        a.AlarmName,
		AlarmDescription: a.AlarmDescription,
		Severity:         string(a.Severity),
		State:            string(a.State),
		CorrelationGroup: a.CorrelationGroup,
		RootCause:        a.RootCause,
		Acknowledged:     a.Acknowledged,
		RaisedAtMilli:    a.RaisedAt.UnixMilli(),
	}
	if a.AcknowledgedBy != nil {
		m.AcknowledgedBy = *a.AcknowledgedBy
	}
	if a.ClearedAt != nil {
		m.ClearedAtMilli = a.ClearedAt.UnixMilli()
	}
	return m
}

// AlarmRecordFromProtoMap converts proto wire format back to models.AlarmRecord.
func AlarmRecordFromProtoMap(m AlarmProtoMap) models.AlarmRecord {
	a := models.AlarmRecord{
		AlarmID:          m.AlarmID,
		DeviceID:         m.DeviceID,
		AlarmName:        m.AlarmName,
		AlarmDescription: m.AlarmDescription,
		Severity:         models.AlarmSeverity(m.Severity),
		State:            models.AlarmState(m.State),
		CorrelationGroup: m.CorrelationGroup,
		RootCause:        m.RootCause,
		Acknowledged:     m.Acknowledged,
		RaisedAt:         time.UnixMilli(m.RaisedAtMilli),
	}
	if m.AcknowledgedBy != "" {
		ack := m.AcknowledgedBy
		a.AcknowledgedBy = &ack
	}
	if m.ClearedAtMilli != 0 {
		t := time.UnixMilli(m.ClearedAtMilli)
		a.ClearedAt = &t
	}
	return a
}

// ── helpers ───────────────────────────────────────────────────────────────────

func orEmpty(s string) string {
	return s
}
