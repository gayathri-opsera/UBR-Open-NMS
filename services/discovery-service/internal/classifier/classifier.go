// Package classifier maps SNMP fingerprint evidence (sysObjectID, sysDescr) to
// vendor/model/device-type assignments for generic discovery (WO-030).
//
// The release-1 scope covers common router, switch, firewall, and server families.
// Devices with unrecognised OIDs are deferred with DEFERRED_UNSUPPORTED and a
// clear operator-visible reason; they are never silently registered as placeholders.
//
// Authority rules:
//   - UBR call-home fields (serialNumber, macAddress, deviceType, online-state) are
//     NEVER overwritten by generic discovery enrichment.
//   - Generic discovery may only set: sysObjectID, sysDescr, vendor, model,
//     genericDeviceType, capabilityProfileId, driverId, and discoveryParadigm (when
//     no prior identity authority exists).
package classifier

import (
	"strings"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
)

// ClassificationStatus indicates the outcome of classifying a fingerprint.
type ClassificationStatus string

const (
	ClassificationRecognised ClassificationStatus = "RECOGNISED"
	ClassificationDeferred   ClassificationStatus = "DEFERRED_UNSUPPORTED"
	ClassificationError      ClassificationStatus = "CLASSIFICATION_ERROR"
)

// ClassificationResult holds the output of classifying a single SNMP fingerprint.
type ClassificationResult struct {
	Status             ClassificationStatus `json:"classificationStatus"`
	Vendor             string              `json:"vendor,omitempty"`
	Model              string              `json:"model,omitempty"`
	GenericDeviceType  string              `json:"genericDeviceType,omitempty"` // ROUTER, SWITCH, FIREWALL, SERVER, UNKNOWN
	CapabilityProfileID string             `json:"capabilityProfileId,omitempty"`
	DriverID           string              `json:"driverId,omitempty"`
	DeferReason        string              `json:"deferReason,omitempty"`
	CorrelationID      string              `json:"correlationId,omitempty"`
}

// OIDMapping defines how a matched OID prefix maps to classification fields.
type OIDMapping struct {
	Vendor            string
	Model             string
	GenericDeviceType string
	CapabilityProfile string
	DriverID          string
}

// releaseOneOIDPrefixes is the bounded, auditable release-1 classification map.
// Keys are numeric OID prefixes (leading dot included). The longest matching prefix wins.
//
// This list is intentionally bounded to avoid false classification of unsupported devices.
// Add entries only after vendor certification and explicit product team approval.
var releaseOneOIDPrefixes = []struct {
	prefix  string
	mapping OIDMapping
}{
	// Cisco Catalyst switches
	{".1.3.6.1.4.1.9.1", OIDMapping{Vendor: "Cisco", Model: "Catalyst", GenericDeviceType: "SWITCH", CapabilityProfile: "cap-cisco-switch-v1", DriverID: "drv-cisco-snmp-v1"}},
	// Cisco IOS routers
	{".1.3.6.1.4.1.9.5", OIDMapping{Vendor: "Cisco", Model: "IOS Router", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-cisco-router-v1", DriverID: "drv-cisco-snmp-v1"}},
	// Cisco ASA firewalls
	{".1.3.6.1.4.1.9.9.5", OIDMapping{Vendor: "Cisco", Model: "ASA", GenericDeviceType: "FIREWALL", CapabilityProfile: "cap-cisco-asa-v1", DriverID: "drv-cisco-snmp-v1"}},
	// Juniper Networks
	{".1.3.6.1.4.1.2636", OIDMapping{Vendor: "Juniper", Model: "JunOS", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-juniper-snmp-v1", DriverID: "drv-juniper-snmp-v1"}},
	// HP/Aruba ProCurve switches
	{".1.3.6.1.4.1.11.2.3.7", OIDMapping{Vendor: "HP", Model: "ProCurve Switch", GenericDeviceType: "SWITCH", CapabilityProfile: "cap-hp-switch-v1", DriverID: "drv-hp-snmp-v1"}},
	// HP Servers (Integrated Lights-Out)
	{".1.3.6.1.4.1.232", OIDMapping{Vendor: "HP", Model: "ProLiant", GenericDeviceType: "SERVER", CapabilityProfile: "cap-hp-server-v1", DriverID: "drv-hp-snmp-v1"}},
	// Palo Alto Networks firewalls
	{".1.3.6.1.4.1.25461", OIDMapping{Vendor: "Palo Alto", Model: "NGFW", GenericDeviceType: "FIREWALL", CapabilityProfile: "cap-paloalto-fw-v1", DriverID: "drv-paloalto-snmp-v1"}},
	// Fortinet FortiGate
	{".1.3.6.1.4.1.12356.101", OIDMapping{Vendor: "Fortinet", Model: "FortiGate", GenericDeviceType: "FIREWALL", CapabilityProfile: "cap-fortinet-fw-v1", DriverID: "drv-fortinet-snmp-v1"}},
	// Dell servers
	{".1.3.6.1.4.1.674", OIDMapping{Vendor: "Dell", Model: "PowerEdge", GenericDeviceType: "SERVER", CapabilityProfile: "cap-dell-server-v1", DriverID: "drv-dell-snmp-v1"}},
	// Linux servers (net-snmp)
	{".1.3.6.1.4.1.8072.3", OIDMapping{Vendor: "Net-SNMP", Model: "Linux", GenericDeviceType: "SERVER", CapabilityProfile: "cap-linux-server-v1", DriverID: "drv-generic-snmp-v1"}},

	// ── Release-1 expansion (WO-004): additional major network equipment vendors ─

	// Huawei Technologies — routers and switches
	{".1.3.6.1.4.1.2011.2.23", OIDMapping{Vendor: "Huawei", Model: "Quidway Switch", GenericDeviceType: "SWITCH", CapabilityProfile: "cap-huawei-switch-v1", DriverID: "drv-huawei-snmp-v1"}},
	{".1.3.6.1.4.1.2011.5.25", OIDMapping{Vendor: "Huawei", Model: "NetEngine Router", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-huawei-router-v1", DriverID: "drv-huawei-snmp-v1"}},

	// Nokia (formerly Alcatel-Lucent) — service routers
	{".1.3.6.1.4.1.637.61.1", OIDMapping{Vendor: "Nokia", Model: "7750 SR", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-nokia-router-v1", DriverID: "drv-nokia-snmp-v1"}},
	{".1.3.6.1.4.1.6527", OIDMapping{Vendor: "Nokia", Model: "TiMOS Router", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-nokia-router-v1", DriverID: "drv-nokia-snmp-v1"}},

	// Ericsson — radio network equipment
	{".1.3.6.1.4.1.193.81", OIDMapping{Vendor: "Ericsson", Model: "MINI-LINK", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-ericsson-router-v1", DriverID: "drv-ericsson-snmp-v1"}},
	{".1.3.6.1.4.1.193.140", OIDMapping{Vendor: "Ericsson", Model: "Radio Base Station", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-ericsson-rbs-v1", DriverID: "drv-ericsson-snmp-v1"}},

	// ZTE Corporation — switches and transport equipment
	{".1.3.6.1.4.1.3902.1082", OIDMapping{Vendor: "ZTE", Model: "ZXR10 Switch", GenericDeviceType: "SWITCH", CapabilityProfile: "cap-zte-switch-v1", DriverID: "drv-zte-snmp-v1"}},
	{".1.3.6.1.4.1.3902.1015", OIDMapping{Vendor: "ZTE", Model: "ZXR10 Router", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-zte-router-v1", DriverID: "drv-zte-snmp-v1"}},

	// MikroTik — RouterOS routers and switches
	{".1.3.6.1.4.1.14988.1", OIDMapping{Vendor: "MikroTik", Model: "RouterOS", GenericDeviceType: "ROUTER", CapabilityProfile: "cap-mikrotik-router-v1", DriverID: "drv-mikrotik-snmp-v1"}},

	// Arista Networks — data-center switches
	{".1.3.6.1.4.1.30065.1", OIDMapping{Vendor: "Arista", Model: "EOS Switch", GenericDeviceType: "SWITCH", CapabilityProfile: "cap-arista-switch-v1", DriverID: "drv-arista-snmp-v1"}},
}

// Classify maps an SNMP fingerprint result to a ClassificationResult.
// It applies the longest-prefix rule on sysObjectID, then falls back to
// sysDescr keyword heuristics only when no OID match is found and the OID
// is absent (partial fingerprint).
//
// Devices with unrecognised sysObjectIDs are always DEFERRED_UNSUPPORTED.
func Classify(fp model.SNMPFingerprintResult, correlationID string) ClassificationResult {
	base := ClassificationResult{CorrelationID: correlationID}

	// If fingerprinting itself failed, classification cannot proceed.
	if fp.Status != model.SNMPFingerprintSuccess && fp.Status != model.SNMPFingerprintPartial {
		base.Status = ClassificationError
		base.DeferReason = "FINGERPRINT_" + string(fp.FailureCategory)
		return base
	}

	// Try OID-based classification (most authoritative).
	if fp.SysObjectID != "" {
		if mapping, ok := matchOIDPrefix(fp.SysObjectID); ok {
			return ClassificationResult{
				Status:              ClassificationRecognised,
				Vendor:              mapping.Vendor,
				Model:               mapping.Model,
				GenericDeviceType:   mapping.GenericDeviceType,
				CapabilityProfileID: mapping.CapabilityProfile,
				DriverID:            mapping.DriverID,
				CorrelationID:       correlationID,
			}
		}
		// OID present but not in release-1 scope — defer with transparency.
		base.Status = ClassificationDeferred
		base.DeferReason = "OID_NOT_IN_RELEASE_SCOPE"
		return base
	}

	// No OID but sysDescr is available — attempt keyword heuristic classification.
	if fp.SysDescr != "" {
		if result, ok := classifyFromSysDescr(fp.SysDescr, correlationID); ok {
			return result
		}
	}

	// No usable evidence — defer.
	base.Status = ClassificationDeferred
	base.DeferReason = "INSUFFICIENT_FINGERPRINT_EVIDENCE"
	return base
}

// matchOIDPrefix returns the OIDMapping for the longest matching prefix of the given OID.
// Returns (zero, false) if no prefix matches.
func matchOIDPrefix(oid string) (OIDMapping, bool) {
	var bestLen int
	var bestMapping OIDMapping
	found := false

	for _, entry := range releaseOneOIDPrefixes {
		if strings.HasPrefix(oid, entry.prefix) && len(entry.prefix) > bestLen {
			bestLen = len(entry.prefix)
			bestMapping = entry.mapping
			found = true
		}
	}
	return bestMapping, found
}

// classifyFromSysDescr applies keyword heuristics to sysDescr when no OID is available.
// This is a best-effort fallback; OID-based matching is always preferred.
func classifyFromSysDescr(sysDescr, correlationID string) (ClassificationResult, bool) {
	desc := strings.ToLower(sysDescr)
	switch {
	case strings.Contains(desc, "cisco") && strings.Contains(desc, "ios"):
		return ClassificationResult{
			Status: ClassificationRecognised, Vendor: "Cisco", Model: "IOS",
			GenericDeviceType: "ROUTER", CapabilityProfileID: "cap-cisco-router-v1",
			DriverID: "drv-cisco-snmp-v1", CorrelationID: correlationID,
		}, true
	case strings.Contains(desc, "juniper") || strings.Contains(desc, "junos"):
		return ClassificationResult{
			Status: ClassificationRecognised, Vendor: "Juniper", Model: "JunOS",
			GenericDeviceType: "ROUTER", CapabilityProfileID: "cap-juniper-snmp-v1",
			DriverID: "drv-juniper-snmp-v1", CorrelationID: correlationID,
		}, true
	case strings.Contains(desc, "linux"):
		return ClassificationResult{
			Status: ClassificationRecognised, Vendor: "Linux", Model: "net-snmp",
			GenericDeviceType: "SERVER", CapabilityProfileID: "cap-linux-server-v1",
			DriverID: "drv-generic-snmp-v1", CorrelationID: correlationID,
		}, true
	}
	return ClassificationResult{}, false
}

// MergeRegistrationPayload builds the inventory registration payload by merging
// classification results with SNMP fingerprint evidence.
// Authority rules are enforced: UBR call-home identity fields are never overwritten.
func MergeRegistrationPayload(
	fp model.SNMPFingerprintResult,
	cl ClassificationResult,
	existingParadigm string, // empty if new device; "UBR_CALL_HOME" if existing UBR device
) RegistrationPayload {
	p := RegistrationPayload{
		IP:               fp.IP,
		RunID:            fp.RunID,
		CorrelationID:    fp.CorrelationID,
		SysObjectID:      fp.SysObjectID,
		SysDescr:         fp.SysDescr,
		ClassificationStatus: string(cl.Status),
		DeferReason:      cl.DeferReason,
	}

	if cl.Status == ClassificationRecognised {
		p.Vendor = cl.Vendor
		p.Model = cl.Model
		p.GenericDeviceType = cl.GenericDeviceType
		p.CapabilityProfileID = cl.CapabilityProfileID
		p.DriverID = cl.DriverID
	}

	// Apply authority rules: only set authority metadata when this is not a UBR call-home device.
	if existingParadigm != "UBR_CALL_HOME" {
		p.DiscoveryParadigm = "GENERIC_SNMP"
		p.IdentityAuthority = "GENERIC"
		p.OnlineStateAuthority = "GENERIC"
	}
	// If existingParadigm == "UBR_CALL_HOME": we're enriching an existing UBR device.
	// sysObjectID and sysDescr are added as enrichment; authority fields are preserved.

	return p
}

// RegistrationPayload is the merged payload sent to inventory-service for upsert.
type RegistrationPayload struct {
	IP                   string `json:"ip"`
	RunID                string `json:"runId"`
	CorrelationID        string `json:"correlationId,omitempty"`
	Vendor               string `json:"vendor,omitempty"`
	Model                string `json:"model,omitempty"`
	GenericDeviceType    string `json:"genericDeviceType,omitempty"`
	CapabilityProfileID  string `json:"capabilityProfileId,omitempty"`
	DriverID             string `json:"driverId,omitempty"`
	SysObjectID          string `json:"sysObjectID,omitempty"`
	SysDescr             string `json:"sysDescr,omitempty"`
	DiscoveryParadigm    string `json:"discoveryParadigm,omitempty"`
	IdentityAuthority    string `json:"identityAuthority,omitempty"`
	OnlineStateAuthority string `json:"onlineStateAuthority,omitempty"`
	ClassificationStatus string `json:"classificationStatus"`
	DeferReason          string `json:"deferReason,omitempty"`
}
