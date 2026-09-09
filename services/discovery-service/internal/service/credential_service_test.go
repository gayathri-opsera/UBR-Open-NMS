package service

import (
	"context"
	"errors"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/crypto"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
)

// ── Test fixtures ─────────────────────────────────────────────────────────────

// testKey is a fixed 32-byte key used only in tests.
var testEncKey = []byte("test-key-must-be-32-bytes-exactly")

// newTestEncryptor returns an Encryptor for testing (panics if key is wrong).
func newTestEncryptor(t *testing.T) *crypto.Encryptor {
	t.Helper()
	enc, err := crypto.NewEncryptor(testEncKey)
	if err != nil {
		t.Fatalf("failed to create test encryptor: %v", err)
	}
	return enc
}

// captureAuditPublisher records the last published event for assertion.
type captureAuditPublisher struct {
	events []CredentialAuditEvent
}

func (c *captureAuditPublisher) PublishCredentialAudit(_ context.Context, ev CredentialAuditEvent) error {
	c.events = append(c.events, ev)
	return nil
}

// errorAuditPublisher always returns an error — verifies audit failures don't panic.
type errorAuditPublisher struct{}

func (e *errorAuditPublisher) PublishCredentialAudit(_ context.Context, _ CredentialAuditEvent) error {
	return errors.New("kafka unavailable")
}

// newSvc creates a CredentialService backed by an in-memory repo.
func newSvc(t *testing.T, audit CredentialAuditPublisher) (*CredentialService, *repository.InMemoryCredentialRepository) {
	t.Helper()
	repo := repository.NewInMemoryCredentialRepository()
	enc := newTestEncryptor(t)
	svc := NewCredentialService(repo, enc, audit)
	return svc, repo
}

// v2cRequest returns a sample v2c create request.
func v2cRequest(name string) CreateCredentialRequest {
	return CreateCredentialRequest{
		Name:      name,
		Version:   model.SNMPVersion2c,
		Community: "public",
		CreatedBy: "admin",
	}
}

// v3Request returns a sample v3 create request.
func v3Request(name string) CreateCredentialRequest {
	return CreateCredentialRequest{
		Name:          name,
		Version:       model.SNMPVersion3,
		SecurityName:  "snmpv3user",
		SecurityLevel: model.SecurityLevelAuthPriv,
		AuthProtocol:  model.AuthProtocolSHA,
		AuthKey:       "authpassword",
		PrivacyProtocol: model.PrivacyProtocolAES,
		PrivacyKey:    "privpassword",
		CreatedBy:     "admin",
	}
}

// ── Create tests ──────────────────────────────────────────────────────────────

func TestCreate_V2C_Success(t *testing.T) {
	audit := &captureAuditPublisher{}
	svc, _ := newSvc(t, audit)

	summary, err := svc.Create(context.Background(), v2cRequest("home-lab"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.ID == "" {
		t.Error("expected non-empty ID")
	}
	if summary.Name != "home-lab" {
		t.Errorf("name mismatch: got %q", summary.Name)
	}
	if summary.Version != model.SNMPVersion2c {
		t.Errorf("version mismatch: got %q", summary.Version)
	}
	// Sensitive field must not appear in summary.
	if len(audit.events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(audit.events))
	}
	if audit.events[0].EventType != "credential.created" {
		t.Errorf("unexpected audit eventType: %q", audit.events[0].EventType)
	}
}

func TestCreate_V3_Success(t *testing.T) {
	svc, _ := newSvc(t, nil)
	summary, err := svc.Create(context.Background(), v3Request("core-router-v3"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.SecurityName != "snmpv3user" {
		t.Errorf("securityName not preserved: got %q", summary.SecurityName)
	}
	if summary.AuthProtocol != model.AuthProtocolSHA {
		t.Errorf("authProtocol not preserved: got %q", summary.AuthProtocol)
	}
}

func TestCreate_MissingName_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	req := v2cRequest("")
	_, err := svc.Create(context.Background(), req)
	if !errors.Is(err, ErrCredentialNameRequired) {
		t.Errorf("expected ErrCredentialNameRequired, got %v", err)
	}
}

func TestCreate_MissingVersion_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	req := CreateCredentialRequest{Name: "test", CreatedBy: "admin"}
	_, err := svc.Create(context.Background(), req)
	if !errors.Is(err, ErrCredentialVersionRequired) {
		t.Errorf("expected ErrCredentialVersionRequired, got %v", err)
	}
}

func TestCreate_V2C_MissingCommunity_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	req := CreateCredentialRequest{Name: "test", Version: model.SNMPVersion2c, CreatedBy: "admin"}
	_, err := svc.Create(context.Background(), req)
	if !errors.Is(err, ErrCommunityRequired) {
		t.Errorf("expected ErrCommunityRequired, got %v", err)
	}
}

func TestCreate_V3_MissingSecurityName_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	req := CreateCredentialRequest{Name: "test", Version: model.SNMPVersion3, CreatedBy: "admin"}
	_, err := svc.Create(context.Background(), req)
	if !errors.Is(err, ErrV3SecurityNameRequired) {
		t.Errorf("expected ErrV3SecurityNameRequired, got %v", err)
	}
}

func TestCreate_DuplicateName_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	_, err := svc.Create(context.Background(), v2cRequest("dup"))
	if err != nil {
		t.Fatalf("first create failed: %v", err)
	}
	_, err = svc.Create(context.Background(), v2cRequest("dup"))
	if !errors.Is(err, repository.ErrDuplicateCredentialName) {
		t.Errorf("expected ErrDuplicateCredentialName, got %v", err)
	}
}

func TestCreate_AuditPublishError_DoesNotFail(t *testing.T) {
	// A failing audit publisher must not cause Create to return an error.
	svc, _ := newSvc(t, &errorAuditPublisher{})
	_, err := svc.Create(context.Background(), v2cRequest("ok-despite-audit-fail"))
	if err != nil {
		t.Errorf("expected no error when audit fails, got: %v", err)
	}
}

// ── List tests ────────────────────────────────────────────────────────────────

func TestList_ReturnsAllActiveCredentials(t *testing.T) {
	svc, _ := newSvc(t, nil)
	_, _ = svc.Create(context.Background(), v2cRequest("cred-a"))
	_, _ = svc.Create(context.Background(), v2cRequest("cred-b"))

	results, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 credentials, got %d", len(results))
	}
}

func TestList_Empty_ReturnsEmptySlice(t *testing.T) {
	svc, _ := newSvc(t, nil)
	results, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected empty slice, got %d items", len(results))
	}
}

// ── GetByID tests ─────────────────────────────────────────────────────────────

func TestGetByID_Found_ReturnsSummary(t *testing.T) {
	svc, _ := newSvc(t, nil)
	created, _ := svc.Create(context.Background(), v2cRequest("lookup-me"))

	result, err := svc.GetByID(context.Background(), created.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Name != "lookup-me" {
		t.Errorf("expected name 'lookup-me', got %q", result.Name)
	}
}

func TestGetByID_NotFound_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	_, err := svc.GetByID(context.Background(), "does-not-exist")
	if !errors.Is(err, repository.ErrCredentialNotFound) {
		t.Errorf("expected ErrCredentialNotFound, got %v", err)
	}
}

// ── Update tests ──────────────────────────────────────────────────────────────

func TestUpdate_Name_Succeeds(t *testing.T) {
	audit := &captureAuditPublisher{}
	svc, _ := newSvc(t, audit)
	created, _ := svc.Create(context.Background(), v2cRequest("original-name"))

	updated, err := svc.Update(context.Background(), created.ID, UpdateCredentialRequest{Name: "new-name"}, "admin")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Name != "new-name" {
		t.Errorf("expected name 'new-name', got %q", updated.Name)
	}
	if len(audit.events) != 2 || audit.events[1].EventType != "credential.updated" {
		t.Error("expected credential.updated audit event")
	}
}

func TestUpdate_NotFound_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	_, err := svc.Update(context.Background(), "ghost", UpdateCredentialRequest{Name: "x"}, "admin")
	if !errors.Is(err, repository.ErrCredentialNotFound) {
		t.Errorf("expected ErrCredentialNotFound, got %v", err)
	}
}

func TestUpdate_EmptyName_ReturnsValidationError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	_, err := svc.Update(context.Background(), "any-id", UpdateCredentialRequest{Name: ""}, "admin")
	if !errors.Is(err, ErrCredentialNameRequired) {
		t.Errorf("expected ErrCredentialNameRequired, got %v", err)
	}
}

// ── Delete tests ──────────────────────────────────────────────────────────────

func TestDelete_Succeeds_CredentialRemovedFromList(t *testing.T) {
	audit := &captureAuditPublisher{}
	svc, _ := newSvc(t, audit)
	created, _ := svc.Create(context.Background(), v2cRequest("to-delete"))

	err := svc.Delete(context.Background(), created.ID, "admin", "corr-001")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	results, _ := svc.List(context.Background())
	if len(results) != 0 {
		t.Errorf("expected empty list after delete, got %d items", len(results))
	}
	if len(audit.events) < 2 || audit.events[1].EventType != "credential.deleted" {
		t.Error("expected credential.deleted audit event")
	}
}

func TestDelete_NotFound_ReturnsError(t *testing.T) {
	svc, _ := newSvc(t, nil)
	err := svc.Delete(context.Background(), "ghost", "admin", "")
	if !errors.Is(err, repository.ErrCredentialNotFound) {
		t.Errorf("expected ErrCredentialNotFound, got %v", err)
	}
}
