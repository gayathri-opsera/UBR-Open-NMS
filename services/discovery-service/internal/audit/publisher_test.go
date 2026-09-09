package audit_test

import (
	"context"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/audit"
)

func TestNoopPublisher_Publish(t *testing.T) {
	pub := &audit.NoopPublisher{}
	evt := audit.NewEvent("discovery-service", "discovery.run.created", "DiscoveryRun", "run-001", "success")
	if err := pub.Publish(context.Background(), evt); err != nil {
		t.Fatalf("NoopPublisher.Publish() unexpected error: %v", err)
	}
}

func TestNewEvent_Fields(t *testing.T) {
	evt := audit.NewEvent("discovery-service", "discovery.run.completed", "DiscoveryRun", "run-abc", "success")
	if evt.EventID == "" {
		t.Error("EventID must be populated")
	}
	if evt.SchemaVersion != audit.SchemaVersion {
		t.Errorf("SchemaVersion = %q, want %q", evt.SchemaVersion, audit.SchemaVersion)
	}
	if evt.Action != "discovery.run.completed" {
		t.Errorf("Action = %q", evt.Action)
	}
	if evt.Outcome != "success" {
		t.Errorf("Outcome = %q", evt.Outcome)
	}
}
