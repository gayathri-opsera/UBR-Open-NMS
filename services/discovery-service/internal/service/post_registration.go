// Package service — PostRegistrationOrchestrator triggers initial KPI collection
// and topology discovery after a generic device is registered in inventory (WO-031).
//
// Design principles:
//   - Downstream trigger failures never roll back the inventory record.
//   - Idempotency keys (runId:deviceId) prevent duplicate collection/topology jobs
//     on repeated rediscovery of an already-managed device.
//   - Deferred or unsupported devices are SKIPPED — triggers are never emitted.
//   - Topology walk is SKIPPED when no SNMP management protocol is available
//     (device does not support LLDP/CDP discovery via the probed management port).
//   - All trigger outcomes are returned to callers for inclusion in discovery run
//     status responses and for operator troubleshooting.
package service

import (
	"fmt"
	"log/slog"
	"time"

	sharedmodels "github.com/airtel-ubrnms/shared-libs/go/models"
	"github.com/google/uuid"
)

// TriggerActionType names the type of post-registration downstream action.
type TriggerActionType string

const (
	ActionInitialKpiCollection TriggerActionType = "INITIAL_KPI_COLLECTION"
	ActionInitialTopologyWalk  TriggerActionType = "INITIAL_TOPOLOGY_WALK"
)

// TriggerActionStatus is the outcome of a single downstream trigger attempt.
type TriggerActionStatus string

const (
	TriggerAccepted TriggerActionStatus = "ACCEPTED"
	TriggerSkipped  TriggerActionStatus = "SKIPPED"
	TriggerFailed   TriggerActionStatus = "FAILED"
	TriggerPending  TriggerActionStatus = "PENDING"
)

// PostRegistrationAction is the outcome of one downstream trigger action for a
// device registration event.
type PostRegistrationAction struct {
	ActionType            TriggerActionType
	Status                TriggerActionStatus
	Reason                string
	DownstreamReferenceID string
	IdempotencyKey        string
	AttemptedAt           time.Time
	CorrelationID         string
}

// PostRegistrationInput carries all the context needed to decide and emit triggers.
type PostRegistrationInput struct {
	RunID             string
	InventoryDeviceID string
	IP                string
	CorrelationID     string
	SysObjectID       string
	DiscoveryParadigm string
	DriverID          string
	CapabilityProfileID string
	// ManagementProtocols lists protocols confirmed open during port-probing.
	// Used to decide whether topology walk is supported for this device.
	// Values: SNMP, NETCONF, SSH, HTTP, HTTPS.
	ManagementProtocols []string
	// IsRediscovery is true when the device already existed in inventory before
	// this registration. When true, triggers are suppressed (SKIPPED) unless
	// the caller explicitly sets ForceRefresh.
	IsRediscovery bool
	// ForceRefresh forces trigger emission even for rediscovered devices.
	ForceRefresh bool
}

// TriggerPublisher abstracts Kafka publication of post-registration trigger events.
type TriggerPublisher interface {
	PublishKpiCollectionTrigger(sharedmodels.InitialKpiCollectionTriggerEvent) error
	PublishTopologyWalkTrigger(sharedmodels.InitialTopologyWalkTriggerEvent) error
}

// PostRegistrationOrchestrator implements WO-031 post-registration action emission.
type PostRegistrationOrchestrator struct {
	publisher TriggerPublisher
}

// NewPostRegistrationOrchestrator constructs the orchestrator.
func NewPostRegistrationOrchestrator(pub TriggerPublisher) *PostRegistrationOrchestrator {
	return &PostRegistrationOrchestrator{publisher: pub}
}

// Trigger emits initial KPI collection and topology walk trigger events for a
// newly registered generic device. Returns the list of action outcomes for
// inclusion in the discovery run result.
func (o *PostRegistrationOrchestrator) Trigger(input PostRegistrationInput) []PostRegistrationAction {
	var actions []PostRegistrationAction

	// Only GENERIC_SNMP devices get post-registration triggers.
	if input.DiscoveryParadigm != "GENERIC_SNMP" {
		return []PostRegistrationAction{
			skipAction(ActionInitialKpiCollection, "NON_GENERIC_PARADIGM", input.CorrelationID),
			skipAction(ActionInitialTopologyWalk, "NON_GENERIC_PARADIGM", input.CorrelationID),
		}
	}

	idempotencyKey := fmt.Sprintf("%s:%s", input.RunID, input.InventoryDeviceID)

	// ── Initial KPI Collection ────────────────────────────────────────────────

	kpiAction := o.triggerKpiCollection(input, idempotencyKey)
	actions = append(actions, kpiAction)

	// ── Initial Topology Walk ─────────────────────────────────────────────────

	topologyAction := o.triggerTopologyWalk(input, idempotencyKey)
	actions = append(actions, topologyAction)

	return actions
}

func (o *PostRegistrationOrchestrator) triggerKpiCollection(
	input PostRegistrationInput, idempotencyKey string,
) PostRegistrationAction {
	// Idempotency: skip duplicate collection jobs on rediscovery unless explicitly requested.
	if input.IsRediscovery && !input.ForceRefresh {
		return skipAction(ActionInitialKpiCollection, "REDISCOVERY_DEDUPLICATION", input.CorrelationID)
	}

	protocolHints := snmpProtocolHints(input.ManagementProtocols)
	if len(protocolHints) == 0 {
		// No SNMP port available — collection cannot proceed.
		return skipAction(ActionInitialKpiCollection, "NO_SNMP_MANAGEMENT_PROTOCOL", input.CorrelationID)
	}

	evt := sharedmodels.InitialKpiCollectionTriggerEvent{
		EventID:             uuid.NewString(),
		RunID:               input.RunID,
		InventoryDeviceID:   input.InventoryDeviceID,
		IP:                  input.IP,
		CorrelationID:       input.CorrelationID,
		IdempotencyKey:      idempotencyKey,
		SysObjectID:         input.SysObjectID,
		DiscoveryParadigm:   "GENERIC_SNMP",
		DriverID:            input.DriverID,
		CapabilityProfileID: input.CapabilityProfileID,
		ProtocolHints:       protocolHints,
		IsRediscovery:       input.IsRediscovery,
		Timestamp:           time.Now().UTC(),
	}

	if err := o.publisher.PublishKpiCollectionTrigger(evt); err != nil {
		slog.Error("WO-031: failed to publish KPI collection trigger",
			"deviceId", input.InventoryDeviceID, "correlationId", input.CorrelationID, "err", err)
		return failAction(ActionInitialKpiCollection, "PUBLISH_FAILED", input.CorrelationID, idempotencyKey)
	}

	slog.Info("WO-031: KPI collection trigger accepted",
		"deviceId", input.InventoryDeviceID, "idempotencyKey", idempotencyKey)

	return PostRegistrationAction{
		ActionType:     ActionInitialKpiCollection,
		Status:         TriggerAccepted,
		IdempotencyKey: idempotencyKey,
		AttemptedAt:    time.Now().UTC(),
		CorrelationID:  input.CorrelationID,
	}
}

func (o *PostRegistrationOrchestrator) triggerTopologyWalk(
	input PostRegistrationInput, idempotencyKey string,
) PostRegistrationAction {
	// Idempotency: skip for rediscovery unless refresh explicitly requested.
	if input.IsRediscovery && !input.ForceRefresh {
		return skipAction(ActionInitialTopologyWalk, "REDISCOVERY_DEDUPLICATION", input.CorrelationID)
	}

	// Topology walk requires LLDP/CDP-capable management protocol.
	topologyProtocols := topologyCapableProtocols(input.ManagementProtocols)
	if len(topologyProtocols) == 0 {
		slog.Info("WO-031: topology walk skipped — no LLDP/CDP-capable protocol",
			"deviceId", input.InventoryDeviceID)
		return skipAction(ActionInitialTopologyWalk, "NO_TOPOLOGY_PROTOCOL", input.CorrelationID)
	}

	evt := sharedmodels.InitialTopologyWalkTriggerEvent{
		EventID:            uuid.NewString(),
		RunID:              input.RunID,
		InventoryDeviceID:  input.InventoryDeviceID,
		IP:                 input.IP,
		CorrelationID:      input.CorrelationID,
		IdempotencyKey:     idempotencyKey,
		SysObjectID:        input.SysObjectID,
		DiscoveryParadigm:  "GENERIC_SNMP",
		SupportedProtocols: topologyProtocols,
		IsRediscovery:      input.IsRediscovery,
		Timestamp:          time.Now().UTC(),
	}

	if err := o.publisher.PublishTopologyWalkTrigger(evt); err != nil {
		slog.Error("WO-031: failed to publish topology walk trigger",
			"deviceId", input.InventoryDeviceID, "correlationId", input.CorrelationID, "err", err)
		return failAction(ActionInitialTopologyWalk, "PUBLISH_FAILED", input.CorrelationID, idempotencyKey)
	}

	slog.Info("WO-031: topology walk trigger accepted",
		"deviceId", input.InventoryDeviceID, "idempotencyKey", idempotencyKey)

	return PostRegistrationAction{
		ActionType:     ActionInitialTopologyWalk,
		Status:         TriggerAccepted,
		IdempotencyKey: idempotencyKey,
		AttemptedAt:    time.Now().UTC(),
		CorrelationID:  input.CorrelationID,
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func skipAction(at TriggerActionType, reason, correlationID string) PostRegistrationAction {
	return PostRegistrationAction{
		ActionType:    at,
		Status:        TriggerSkipped,
		Reason:        reason,
		AttemptedAt:   time.Now().UTC(),
		CorrelationID: correlationID,
	}
}

func failAction(at TriggerActionType, reason, correlationID, idempotencyKey string) PostRegistrationAction {
	return PostRegistrationAction{
		ActionType:     at,
		Status:         TriggerFailed,
		Reason:         reason,
		IdempotencyKey: idempotencyKey,
		AttemptedAt:    time.Now().UTC(),
		CorrelationID:  correlationID,
	}
}

// snmpProtocolHints returns SNMP-relevant hints from the open management protocol list.
func snmpProtocolHints(protocols []string) []string {
	for _, p := range protocols {
		if p == "SNMP" {
			return []string{"SNMP"}
		}
	}
	return nil
}

// topologyCapableProtocols returns protocols that support LLDP/CDP neighbour discovery.
// SNMP is the primary protocol for LLDP-MIB and CDP-MIB walking.
func topologyCapableProtocols(protocols []string) []string {
	var out []string
	for _, p := range protocols {
		switch p {
		case "SNMP":
			out = append(out, "SNMP_NEIGHBOR")
		case "NETCONF":
			out = append(out, "LLDP")
		}
	}
	return out
}
