package service_test

import (
	"errors"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/service"
	sharedmodels "github.com/airtel-ubrnms/shared-libs/models"
)

// ── Fake TriggerPublisher ─────────────────────────────────────────────────────

type fakeTriggerPublisher struct {
	kpiEvents      []sharedmodels.InitialKpiCollectionTriggerEvent
	topologyEvents []sharedmodels.InitialTopologyWalkTriggerEvent
	kpiErr         error
	topologyErr    error
}

func (f *fakeTriggerPublisher) PublishKpiCollectionTrigger(evt sharedmodels.InitialKpiCollectionTriggerEvent) error {
	f.kpiEvents = append(f.kpiEvents, evt)
	return f.kpiErr
}

func (f *fakeTriggerPublisher) PublishTopologyWalkTrigger(evt sharedmodels.InitialTopologyWalkTriggerEvent) error {
	f.topologyEvents = append(f.topologyEvents, evt)
	return f.topologyErr
}

func genericInput(ip, deviceID, runID string, protocols []string) service.PostRegistrationInput {
	return service.PostRegistrationInput{
		RunID:               runID,
		InventoryDeviceID:   deviceID,
		IP:                  ip,
		CorrelationID:       "corr-test",
		SysObjectID:         ".1.3.6.1.4.1.9.1.1208",
		DiscoveryParadigm:   "GENERIC_SNMP",
		DriverID:            "drv-cisco-snmp-v1",
		ManagementProtocols: protocols,
		IsRediscovery:       false,
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestTrigger_NewDevice_BothTriggersAccepted(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.1", "inv-001", "run-1", []string{"SNMP"})
	actions := orch.Trigger(input)

	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}

	kpiAction := findAction(actions, service.ActionInitialKpiCollection)
	if kpiAction == nil || kpiAction.Status != service.TriggerAccepted {
		t.Errorf("expected KPI trigger ACCEPTED, got %+v", kpiAction)
	}

	topologyAction := findAction(actions, service.ActionInitialTopologyWalk)
	if topologyAction == nil || topologyAction.Status != service.TriggerAccepted {
		t.Errorf("expected topology trigger ACCEPTED, got %+v", topologyAction)
	}

	if len(pub.kpiEvents) != 1 {
		t.Errorf("expected 1 KPI event published, got %d", len(pub.kpiEvents))
	}
	if len(pub.topologyEvents) != 1 {
		t.Errorf("expected 1 topology event published, got %d", len(pub.topologyEvents))
	}
}

func TestTrigger_NewDevice_NoSNMP_BothSkipped(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.2", "inv-002", "run-2", []string{"HTTP", "HTTPS"})
	actions := orch.Trigger(input)

	kpiAction := findAction(actions, service.ActionInitialKpiCollection)
	if kpiAction == nil || kpiAction.Status != service.TriggerSkipped {
		t.Errorf("expected KPI SKIPPED for HTTP-only device, got %+v", kpiAction)
	}
	topologyAction := findAction(actions, service.ActionInitialTopologyWalk)
	if topologyAction == nil || topologyAction.Status != service.TriggerSkipped {
		t.Errorf("expected topology SKIPPED for HTTP-only device, got %+v", topologyAction)
	}
	if len(pub.kpiEvents) != 0 {
		t.Error("expected no KPI events for HTTP-only device")
	}
}

func TestTrigger_Rediscovery_BothSkippedWithoutForceRefresh(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.3", "inv-003", "run-3", []string{"SNMP"})
	input.IsRediscovery = true
	input.ForceRefresh = false

	actions := orch.Trigger(input)

	for _, a := range actions {
		if a.Status != service.TriggerSkipped {
			t.Errorf("expected SKIPPED for rediscovery without force refresh, got %s for %s", a.Status, a.ActionType)
		}
		if a.Reason != "REDISCOVERY_DEDUPLICATION" {
			t.Errorf("expected REDISCOVERY_DEDUPLICATION reason, got %s", a.Reason)
		}
	}
	if len(pub.kpiEvents) != 0 || len(pub.topologyEvents) != 0 {
		t.Error("expected no events published for rediscovery without force refresh")
	}
}

func TestTrigger_Rediscovery_ForceRefresh_BothAccepted(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.4", "inv-004", "run-4", []string{"SNMP"})
	input.IsRediscovery = true
	input.ForceRefresh = true

	actions := orch.Trigger(input)

	kpiAction := findAction(actions, service.ActionInitialKpiCollection)
	if kpiAction == nil || kpiAction.Status != service.TriggerAccepted {
		t.Errorf("expected KPI ACCEPTED with ForceRefresh, got %+v", kpiAction)
	}
}

func TestTrigger_KpiPublishFails_FailedWithoutRollback(t *testing.T) {
	pub := &fakeTriggerPublisher{kpiErr: errors.New("kafka unavailable")}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.5", "inv-005", "run-5", []string{"SNMP"})
	actions := orch.Trigger(input)

	kpiAction := findAction(actions, service.ActionInitialKpiCollection)
	if kpiAction == nil || kpiAction.Status != service.TriggerFailed {
		t.Errorf("expected KPI FAILED on publish error, got %+v", kpiAction)
	}
	if kpiAction.Reason != "PUBLISH_FAILED" {
		t.Errorf("expected PUBLISH_FAILED reason, got %s", kpiAction.Reason)
	}
	// Topology walk should still be attempted independently.
	topologyAction := findAction(actions, service.ActionInitialTopologyWalk)
	if topologyAction == nil {
		t.Error("expected topology action even after KPI failure")
	}
}

func TestTrigger_TopologyPublishFails_KpiStillAccepted(t *testing.T) {
	pub := &fakeTriggerPublisher{topologyErr: errors.New("kafka unavailable")}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.6", "inv-006", "run-6", []string{"SNMP"})
	actions := orch.Trigger(input)

	kpiAction := findAction(actions, service.ActionInitialKpiCollection)
	if kpiAction == nil || kpiAction.Status != service.TriggerAccepted {
		t.Errorf("expected KPI ACCEPTED even when topology fails, got %+v", kpiAction)
	}
	topologyAction := findAction(actions, service.ActionInitialTopologyWalk)
	if topologyAction == nil || topologyAction.Status != service.TriggerFailed {
		t.Errorf("expected topology FAILED on publish error, got %+v", topologyAction)
	}
}

func TestTrigger_IdempotencyKey_IncludesRunAndDeviceId(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.7", "inv-007", "run-7", []string{"SNMP"})
	actions := orch.Trigger(input)

	kpiAction := findAction(actions, service.ActionInitialKpiCollection)
	expectedKey := "run-7:inv-007"
	if kpiAction == nil || kpiAction.IdempotencyKey != expectedKey {
		t.Errorf("expected idempotency key %s, got %s", expectedKey, kpiAction.IdempotencyKey)
	}
}

func TestTrigger_NonGenericParadigm_BothSkipped(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := service.PostRegistrationInput{
		RunID:               "run-8",
		InventoryDeviceID:   "inv-008",
		IP:                  "10.0.0.8",
		CorrelationID:       "corr-8",
		DiscoveryParadigm:   "UBR_CALL_HOME", // non-generic
		ManagementProtocols: []string{"SNMP"},
	}
	actions := orch.Trigger(input)

	for _, a := range actions {
		if a.Status != service.TriggerSkipped {
			t.Errorf("expected SKIPPED for UBR device, got %s for %s", a.Status, a.ActionType)
		}
	}
}

func TestTrigger_SNMPProtocol_TopologyUsesLLDPMIB(t *testing.T) {
	pub := &fakeTriggerPublisher{}
	orch := service.NewPostRegistrationOrchestrator(pub)

	input := genericInput("10.0.0.9", "inv-009", "run-9", []string{"SNMP"})
	orch.Trigger(input)

	if len(pub.topologyEvents) == 0 {
		t.Fatal("expected topology event published")
	}
	evt := pub.topologyEvents[0]
	if len(evt.SupportedProtocols) == 0 {
		t.Error("expected SupportedProtocols populated for SNMP device")
	}
	found := false
	for _, p := range evt.SupportedProtocols {
		if p == "SNMP_NEIGHBOR" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected SNMP_NEIGHBOR in SupportedProtocols, got %v", evt.SupportedProtocols)
	}
}

// ── helper ────────────────────────────────────────────────────────────────────

func findAction(actions []service.PostRegistrationAction, at service.TriggerActionType) *service.PostRegistrationAction {
	for i := range actions {
		if actions[i].ActionType == at {
			return &actions[i]
		}
	}
	return nil
}
