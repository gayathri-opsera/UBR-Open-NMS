// Package model defines domain types for the parameter polling capability.
//
// These types represent the current-value contract between the poller and the
// framework read API. Credential material must never appear in any field of
// any type in this package.
package model

import "time"

// FreshnessState describes the staleness of a polled parameter value.
type FreshnessState string

const (
	// FreshnessStateFresh means the value was collected within the poll interval.
	FreshnessStateFresh FreshnessState = "FRESH"
	// FreshnessStateStale means the last successful collection exceeded the poll interval.
	FreshnessStateStale FreshnessState = "STALE"
	// FreshnessStateFailed means the last poll attempt failed with no prior successful value.
	FreshnessStateFailed FreshnessState = "FAILED"
	// FreshnessStateUnmapped means the parameter has no read reference in the active registry.
	FreshnessStateUnmapped FreshnessState = "UNMAPPED"
	// FreshnessStateUnknownDevice means the device has no associated active Product Definition.
	FreshnessStateUnknownDevice FreshnessState = "UNKNOWN_DEVICE"
)

// ParameterReadStatus is the outcome of the most recent poll attempt for a single parameter.
type ParameterReadStatus string

const (
	ParameterReadStatusSuccess       ParameterReadStatus = "SUCCESS"
	ParameterReadStatusUnreachable   ParameterReadStatus = "UNREACHABLE"
	ParameterReadStatusAuthFailure   ParameterReadStatus = "AUTH_FAILURE"
	ParameterReadStatusTimeout       ParameterReadStatus = "TIMEOUT"
	ParameterReadStatusUnmapped      ParameterReadStatus = "UNMAPPED"
	ParameterReadStatusAdapterError  ParameterReadStatus = "ADAPTER_ERROR"
	ParameterReadStatusRegistryStale ParameterReadStatus = "REGISTRY_STALE"
	ParameterReadStatusUnknown       ParameterReadStatus = "UNKNOWN"
)

// PollFailureCategory is the top-level failure classification for a read attempt.
type PollFailureCategory string

const (
	PollFailureCategoryUnreachable   PollFailureCategory = "UNREACHABLE"
	PollFailureCategoryAuthFailure   PollFailureCategory = "AUTH_FAILURE"
	PollFailureCategoryTimeout       PollFailureCategory = "TIMEOUT"
	PollFailureCategoryUnmapped      PollFailureCategory = "UNMAPPED_PARAMETER"
	PollFailureCategoryAdapterError  PollFailureCategory = "ADAPTER_ERROR"
	PollFailureCategoryRegistryStale PollFailureCategory = "REGISTRY_STALE"
	PollFailureCategoryUnknown       PollFailureCategory = "UNKNOWN"
)

// ParameterValue is a single polled current-value record keyed by
// (deviceId, groupId, parameterId, registryVersion). It is the unit of persistence
// written by the poller and read by the framework API.
//
// Credential references must never appear here — the poller only stores values,
// not the credentials used to collect them.
type ParameterValue struct {
	// DeviceID is the inventory device identifier.
	DeviceID string `json:"deviceId" bson:"deviceId"`
	// GroupID is the parameter group identifier from the Product Definition.
	GroupID string `json:"groupId" bson:"groupId"`
	// ParameterID is the stable parameter identifier.
	ParameterID string `json:"parameterId" bson:"parameterId"`
	// Label is the human-readable parameter label.
	Label string `json:"label" bson:"label"`
	// DataType is the declared type (e.g. "counter", "gauge", "string").
	DataType string `json:"dataType,omitempty" bson:"dataType,omitempty"`
	// Unit is the unit string for numeric values (e.g. "dBm", "%").
	Unit string `json:"unit,omitempty" bson:"unit,omitempty"`
	// Value is the raw string representation of the current value.
	// Empty string means the value is unknown or the poll failed.
	Value string `json:"value,omitempty" bson:"value,omitempty"`
	// ValueNumeric is the float64 parse of Value when applicable.
	// Nil when the value is a string or the poll failed.
	ValueNumeric *float64 `json:"valueNumeric,omitempty" bson:"valueNumeric,omitempty"`
	// Source is the protocol used to collect this value (e.g. "SNMP", "CLI", "REST", "gRPC").
	Source string `json:"source,omitempty" bson:"source,omitempty"`
	// CollectedAt is the timestamp of the most recent poll attempt (success or failure).
	CollectedAt time.Time `json:"collectedAt" bson:"collectedAt"`
	// PollIntervalSeconds is the configured poll interval for this parameter group.
	PollIntervalSeconds int `json:"pollIntervalSeconds" bson:"pollIntervalSeconds"`
	// FreshnessState is the staleness classification of this value.
	FreshnessState FreshnessState `json:"freshnessState" bson:"freshnessState"`
	// ReadStatus is the outcome of the most recent poll attempt.
	ReadStatus ParameterReadStatus `json:"readStatus" bson:"readStatus"`
	// LastSuccessAt is the timestamp of the last successful value collection.
	// Nil when the parameter has never been successfully polled.
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty" bson:"lastSuccessAt,omitempty"`
	// FailureCategory is the top-level failure classification when ReadStatus != SUCCESS.
	FailureCategory PollFailureCategory `json:"failureCategory,omitempty" bson:"failureCategory,omitempty"`
	// FailureReason is the operator-visible description of the failure.
	// Must never contain credential material.
	FailureReason string `json:"failureReason,omitempty" bson:"failureReason,omitempty"`
	// RegistryVersion is the active registry version used to resolve this parameter.
	RegistryVersion string `json:"registryVersion" bson:"registryVersion"`
	// ProductDefinitionID ties this value to the matched Product Definition.
	ProductDefinitionID string `json:"productDefinitionId" bson:"productDefinitionId"`
}

// ParameterGroup bundles all current-value records for a single parameter group.
type ParameterGroup struct {
	GroupID    string           `json:"groupId"`
	Label      string           `json:"label"`
	Parameters []ParameterValue `json:"parameters"`
}

// CurrentValueResponse is the envelope returned by the framework current-value API.
type CurrentValueResponse struct {
	Status string              `json:"status"`
	Data   *CurrentValueData   `json:"data,omitempty"`
	Error  *CurrentValueError  `json:"error,omitempty"`
}

// CurrentValueData is the success payload for GET /parameters/current.
type CurrentValueData struct {
	DeviceID            string           `json:"deviceId"`
	ProductDefinitionID string           `json:"productDefinitionId"`
	RegistryVersion     string           `json:"registryVersion"`
	Groups              []ParameterGroup `json:"groups"`
}

// CurrentValueError is the failure payload for the current-value API.
type CurrentValueError struct {
	Code          string            `json:"code"`
	Message       string            `json:"message"`
	Details       map[string]any    `json:"details,omitempty"`
	CorrelationID string            `json:"correlationId"`
}

// RegistryParamRef describes how to read a single parameter via a protocol adapter.
// Credential references stay as opaque strings — no secret values appear here.
type RegistryParamRef struct {
	// ParameterID is the stable parameter identifier.
	ParameterID string
	// Label is the human-readable parameter label.
	Label string
	// DataType is the declared type.
	DataType string
	// Unit is the unit string.
	Unit string
	// Protocol is the preferred read protocol for this parameter (SNMP, CLI, REST, gRPC).
	Protocol string
	// ReadRef is the protocol-specific read reference (OID, CLI command, REST path, gRPC method).
	ReadRef string
	// CredentialRef is the opaque credential identifier for adapter auth.
	// Never contains the actual credential secret.
	CredentialRef string
}

// RegistryGroupMetadata is the polling metadata for a parameter group from the active registry.
type RegistryGroupMetadata struct {
	GroupID             string
	Label               string
	PollIntervalSeconds int
	Parameters          []RegistryParamRef
}

// RegistryDeviceProfile is the full polling profile for a device from the active registry.
type RegistryDeviceProfile struct {
	DeviceID            string
	ProductDefinitionID string
	RegistryVersion     string
	Groups              []RegistryGroupMetadata
}
