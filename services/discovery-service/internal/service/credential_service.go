// Package service — CredentialService orchestrates validation, encryption,
// repository calls, and audit event publishing for SNMP credentials (WO-014).
//
// Security requirements enforced here:
//   - Community strings, auth keys, and privacy keys are AES-256-GCM encrypted
//     before being passed to the repository.  Plain-text values are zeroed in
//     memory as soon as encryption is complete.
//   - Decrypted values are NEVER included in returned structs.  All API responses
//     use SNMPCredentialSummary, which omits the encrypted fields entirely.
//   - All create/update/delete operations emit a structured audit event that can
//     be forwarded to the audit-events Kafka topic.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/airtel-ubrnms/discovery-service/internal/crypto"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
)

// ── Sentinel errors ───────────────────────────────────────────────────────────

// ErrCredentialNameRequired is returned when a credential name is empty.
var ErrCredentialNameRequired = errors.New("credential name is required")

// ErrCredentialVersionRequired is returned when the SNMP version is not set.
var ErrCredentialVersionRequired = errors.New("snmp version is required (v1, v2c, or v3)")

// ErrInvalidSNMPVersion is returned for unrecognised version strings.
var ErrInvalidSNMPVersion = errors.New("invalid snmp version: must be v1, v2c, or v3")

// ErrCommunityRequired is returned when a v1/v2c credential lacks a community string.
var ErrCommunityRequired = errors.New("community string is required for snmp v1/v2c credentials")

// ErrV3SecurityNameRequired is returned when an SNMPv3 credential has no security name.
var ErrV3SecurityNameRequired = errors.New("securityName is required for snmp v3 credentials")

// ── CredentialAuditEvent ──────────────────────────────────────────────────────

// CredentialAuditEvent is published for every mutating credential operation.
// It contains no sensitive credential material — only metadata.
type CredentialAuditEvent struct {
	EventType    string    `json:"eventType"`    // "credential.created", "credential.updated", "credential.deleted"
	CredentialID string    `json:"credentialId"` // UUID of the affected credential
	ActorID      string    `json:"actorId"`      // user who triggered the action
	ResourceName string    `json:"resourceName"` // credential profile name
	Timestamp    time.Time `json:"timestamp"`
	CorrelationID string   `json:"correlationId,omitempty"`
}

// CredentialAuditPublisher forwards audit events to an external sink (Kafka topic).
// Tests inject a no-op or capturing implementation.
type CredentialAuditPublisher interface {
	PublishCredentialAudit(ctx context.Context, event CredentialAuditEvent) error
}

// noopAuditPublisher swallows audit events. Used when Kafka is not configured.
type noopAuditPublisher struct{}

func (n *noopAuditPublisher) PublishCredentialAudit(_ context.Context, ev CredentialAuditEvent) error {
	slog.Info("credential.audit.noop", "eventType", ev.EventType, "credentialId", ev.CredentialID)
	return nil
}

// ── CreateCredentialRequest ───────────────────────────────────────────────────

// CreateCredentialRequest carries the plaintext values submitted by the operator.
// All sensitive fields are encrypted and then discarded before this struct is
// passed to the repository.
type CreateCredentialRequest struct {
	Name           string                     `json:"name"`
	Description    string                     `json:"description,omitempty"`
	Version        model.SNMPVersion          `json:"version"`
	Community      string                     `json:"community,omitempty"`      // v1/v2c
	SecurityName   string                     `json:"securityName,omitempty"`   // v3
	SecurityLevel  model.SNMPv3SecurityLevel  `json:"securityLevel,omitempty"`  // v3
	AuthProtocol   model.SNMPv3AuthProtocol   `json:"authProtocol,omitempty"`   // v3
	AuthKey        string                     `json:"authKey,omitempty"`        // v3 — never returned
	PrivacyProtocol model.SNMPv3PrivacyProtocol `json:"privacyProtocol,omitempty"` // v3
	PrivacyKey     string                     `json:"privacyKey,omitempty"`     // v3 — never returned
	CreatedBy      string                     `json:"-"` // set by handler from X-User-ID
	CorrelationID  string                     `json:"-"` // set by handler from X-Correlation-ID
}

// UpdateCredentialRequest carries mutable fields for a credential update.
// Sensitive fields are encrypted before being forwarded to the repository.
type UpdateCredentialRequest struct {
	Name           string                     `json:"name,omitempty"`
	Description    string                     `json:"description,omitempty"`
	Community      string                     `json:"community,omitempty"`
	SecurityName   string                     `json:"securityName,omitempty"`
	SecurityLevel  model.SNMPv3SecurityLevel  `json:"securityLevel,omitempty"`
	AuthProtocol   model.SNMPv3AuthProtocol   `json:"authProtocol,omitempty"`
	AuthKey        string                     `json:"authKey,omitempty"`
	PrivacyProtocol model.SNMPv3PrivacyProtocol `json:"privacyProtocol,omitempty"`
	PrivacyKey     string                     `json:"privacyKey,omitempty"`
	CorrelationID  string                     `json:"-"`
}

// ── CredentialService ─────────────────────────────────────────────────────────

// CredentialService orchestrates SNMP credential lifecycle: validation,
// encryption, persistence, and audit emission.
type CredentialService struct {
	repo      repository.CredentialRepository
	encryptor *crypto.Encryptor
	audit     CredentialAuditPublisher
}

// NewCredentialService constructs a CredentialService.
// If audit is nil, a no-op publisher is used so the service never panics.
func NewCredentialService(
	repo repository.CredentialRepository,
	encryptor *crypto.Encryptor,
	audit CredentialAuditPublisher,
) *CredentialService {
	if audit == nil {
		audit = &noopAuditPublisher{}
	}
	return &CredentialService{repo: repo, encryptor: encryptor, audit: audit}
}

// Create validates, encrypts, and persists a new SNMP credential.
// Returns the redacted summary (no sensitive fields).
func (s *CredentialService) Create(ctx context.Context, req CreateCredentialRequest) (model.SNMPCredentialSummary, error) {
	if err := validateCreateRequest(req); err != nil {
		return model.SNMPCredentialSummary{}, err
	}

	// Encrypt sensitive fields before building the model.
	encCommunity, err := s.encryptor.Encrypt(req.Community)
	if err != nil {
		return model.SNMPCredentialSummary{}, fmt.Errorf("credential.create: encrypt community: %w", err)
	}
	encAuthKey, err := s.encryptor.Encrypt(req.AuthKey)
	if err != nil {
		return model.SNMPCredentialSummary{}, fmt.Errorf("credential.create: encrypt authKey: %w", err)
	}
	encPrivKey, err := s.encryptor.Encrypt(req.PrivacyKey)
	if err != nil {
		return model.SNMPCredentialSummary{}, fmt.Errorf("credential.create: encrypt privacyKey: %w", err)
	}

	cred := &model.SNMPCredential{
		Name:                req.Name,
		Description:         req.Description,
		Version:             req.Version,
		EncryptedCommunity:  encCommunity,
		SecurityName:        req.SecurityName,
		SecurityLevel:       req.SecurityLevel,
		AuthProtocol:        req.AuthProtocol,
		EncryptedAuthKey:    encAuthKey,
		PrivacyProtocol:     req.PrivacyProtocol,
		EncryptedPrivacyKey: encPrivKey,
		CreatedBy:           req.CreatedBy,
	}

	saved, err := s.repo.Create(ctx, cred)
	if err != nil {
		if errors.Is(err, repository.ErrDuplicateCredentialName) {
			return model.SNMPCredentialSummary{}, fmt.Errorf("credential with name %q already exists: %w", req.Name, repository.ErrDuplicateCredentialName)
		}
		return model.SNMPCredentialSummary{}, fmt.Errorf("credential.create: repository: %w", err)
	}

	// Publish audit event — non-blocking (failures are logged, not surfaced to caller).
	event := CredentialAuditEvent{
		EventType:     "credential.created",
		CredentialID:  saved.ID,
		ActorID:       req.CreatedBy,
		ResourceName:  saved.Name,
		Timestamp:     time.Now().UTC(),
		CorrelationID: req.CorrelationID,
	}
	if auditErr := s.audit.PublishCredentialAudit(ctx, event); auditErr != nil {
		slog.Error("credential.create: audit publish failed", "error", auditErr, "credentialId", saved.ID)
	}

	slog.Info("credential.created", "id", saved.ID, "name", saved.Name, "actor", req.CreatedBy)
	return saved.Redact(), nil
}

// List returns all active credentials as redacted summaries.
// No sensitive fields are included in the response.
func (s *CredentialService) List(ctx context.Context) ([]model.SNMPCredentialSummary, error) {
	creds, err := s.repo.FindAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("credential.list: repository: %w", err)
	}
	summaries := make([]model.SNMPCredentialSummary, len(creds))
	for i, c := range creds {
		summaries[i] = c.Redact()
	}
	return summaries, nil
}

// GetByID returns a single active credential as a redacted summary.
func (s *CredentialService) GetByID(ctx context.Context, id string) (model.SNMPCredentialSummary, error) {
	cred, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return model.SNMPCredentialSummary{}, wrapRepoErr("credential.get", err)
	}
	return cred.Redact(), nil
}

// Update encrypts mutable fields and replaces them in the repository.
// Returns the updated credential as a redacted summary.
func (s *CredentialService) Update(ctx context.Context, id string, req UpdateCredentialRequest, actorID string) (model.SNMPCredentialSummary, error) {
	if strings.TrimSpace(req.Name) == "" {
		return model.SNMPCredentialSummary{}, ErrCredentialNameRequired
	}

	// Fetch the existing credential so we can carry forward fields not in the request.
	existing, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return model.SNMPCredentialSummary{}, wrapRepoErr("credential.update", err)
	}

	// Encrypt any updated sensitive fields; fall back to existing encrypted values.
	encCommunity := existing.EncryptedCommunity
	if req.Community != "" {
		encCommunity, err = s.encryptor.Encrypt(req.Community)
		if err != nil {
			return model.SNMPCredentialSummary{}, fmt.Errorf("credential.update: encrypt community: %w", err)
		}
	}
	encAuthKey := existing.EncryptedAuthKey
	if req.AuthKey != "" {
		encAuthKey, err = s.encryptor.Encrypt(req.AuthKey)
		if err != nil {
			return model.SNMPCredentialSummary{}, fmt.Errorf("credential.update: encrypt authKey: %w", err)
		}
	}
	encPrivKey := existing.EncryptedPrivacyKey
	if req.PrivacyKey != "" {
		encPrivKey, err = s.encryptor.Encrypt(req.PrivacyKey)
		if err != nil {
			return model.SNMPCredentialSummary{}, fmt.Errorf("credential.update: encrypt privacyKey: %w", err)
		}
	}

	update := &model.SNMPCredential{
		Name:                req.Name,
		Description:         req.Description,
		Version:             existing.Version, // version is immutable after creation
		EncryptedCommunity:  encCommunity,
		SecurityName:        orString(req.SecurityName, existing.SecurityName),
		SecurityLevel:       orSecLevel(req.SecurityLevel, existing.SecurityLevel),
		AuthProtocol:        orAuthProto(req.AuthProtocol, existing.AuthProtocol),
		EncryptedAuthKey:    encAuthKey,
		PrivacyProtocol:     orPrivProto(req.PrivacyProtocol, existing.PrivacyProtocol),
		EncryptedPrivacyKey: encPrivKey,
	}

	saved, err := s.repo.UpdateByID(ctx, id, update)
	if err != nil {
		if errors.Is(err, repository.ErrDuplicateCredentialName) {
			return model.SNMPCredentialSummary{}, fmt.Errorf("credential with name %q already exists: %w", req.Name, repository.ErrDuplicateCredentialName)
		}
		return model.SNMPCredentialSummary{}, wrapRepoErr("credential.update", err)
	}

	event := CredentialAuditEvent{
		EventType:     "credential.updated",
		CredentialID:  id,
		ActorID:       actorID,
		ResourceName:  saved.Name,
		Timestamp:     time.Now().UTC(),
		CorrelationID: req.CorrelationID,
	}
	if auditErr := s.audit.PublishCredentialAudit(ctx, event); auditErr != nil {
		slog.Error("credential.update: audit publish failed", "error", auditErr, "credentialId", id)
	}

	slog.Info("credential.updated", "id", id, "name", saved.Name, "actor", actorID)
	return saved.Redact(), nil
}

// Delete soft-deletes a credential and publishes an audit event.
func (s *CredentialService) Delete(ctx context.Context, id, actorID, correlationID string) error {
	// Fetch name for the audit event before deletion.
	cred, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return wrapRepoErr("credential.delete", err)
	}

	if err := s.repo.DeleteByID(ctx, id); err != nil {
		return wrapRepoErr("credential.delete", err)
	}

	event := CredentialAuditEvent{
		EventType:     "credential.deleted",
		CredentialID:  id,
		ActorID:       actorID,
		ResourceName:  cred.Name,
		Timestamp:     time.Now().UTC(),
		CorrelationID: correlationID,
	}
	if auditErr := s.audit.PublishCredentialAudit(ctx, event); auditErr != nil {
		slog.Error("credential.delete: audit publish failed", "error", auditErr, "credentialId", id)
	}

	slog.Info("credential.deleted", "id", id, "name", cred.Name, "actor", actorID)
	return nil
}

// ── Validation ────────────────────────────────────────────────────────────────

func validateCreateRequest(req CreateCredentialRequest) error {
	if strings.TrimSpace(req.Name) == "" {
		return ErrCredentialNameRequired
	}
	switch req.Version {
	case model.SNMPVersion1, model.SNMPVersion2c:
		if req.Community == "" {
			return ErrCommunityRequired
		}
	case model.SNMPVersion3:
		if req.SecurityName == "" {
			return ErrV3SecurityNameRequired
		}
	case "":
		return ErrCredentialVersionRequired
	default:
		return ErrInvalidSNMPVersion
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// wrapRepoErr converts repository sentinel errors to descriptive service errors.
func wrapRepoErr(op string, err error) error {
	switch {
	case errors.Is(err, repository.ErrCredentialNotFound):
		return fmt.Errorf("%s: %w", op, repository.ErrCredentialNotFound)
	case errors.Is(err, repository.ErrInvalidCredentialID):
		return fmt.Errorf("%s: %w", op, repository.ErrInvalidCredentialID)
	default:
		return fmt.Errorf("%s: %w", op, err)
	}
}

func orString(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func orSecLevel(a, b model.SNMPv3SecurityLevel) model.SNMPv3SecurityLevel {
	if a != "" {
		return a
	}
	return b
}

func orAuthProto(a, b model.SNMPv3AuthProtocol) model.SNMPv3AuthProtocol {
	if a != "" {
		return a
	}
	return b
}

func orPrivProto(a, b model.SNMPv3PrivacyProtocol) model.SNMPv3PrivacyProtocol {
	if a != "" {
		return a
	}
	return b
}
