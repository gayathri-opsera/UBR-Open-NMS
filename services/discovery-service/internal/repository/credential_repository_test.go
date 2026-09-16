package repository_test

import (
	"context"
	"testing"

	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
)

// ── Fixtures ──────────────────────────────────────────────────────────────────

func sampleCred() *model.SNMPCredential {
	return &model.SNMPCredential{
		Name:               "office-v2c",
		Description:        "Office network community string",
		Version:            model.SNMPVersion2c,
		EncryptedCommunity: "enc:aes256:abc123==",
		CreatedBy:          "admin",
	}
}

func sampleV3Cred() *model.SNMPCredential {
	return &model.SNMPCredential{
		Name:                "datacenter-v3",
		Description:         "Data-center SNMPv3 auth+priv",
		Version:             model.SNMPVersion3,
		SecurityName:        "snmpuser",
		SecurityLevel:       model.SecurityLevelAuthPriv,
		AuthProtocol:        model.AuthProtocolSHA256,
		EncryptedAuthKey:    "enc:aes256:authkey==",
		PrivacyProtocol:     model.PrivacyProtocolAES256,
		EncryptedPrivacyKey: "enc:aes256:privkey==",
		CreatedBy:           "admin",
	}
}

// ── Create ────────────────────────────────────────────────────────────────────

func TestCreate_AssignsIDAndTimestamps(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	created, err := repo.Create(ctx, sampleCred())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.ID == "" {
		t.Error("expected non-empty ID after Create")
	}
	if created.CreatedAt.IsZero() {
		t.Error("expected non-zero CreatedAt")
	}
	if created.UpdatedAt.IsZero() {
		t.Error("expected non-zero UpdatedAt")
	}
	if !created.Active {
		t.Error("expected Active=true on newly created credential")
	}
}

func TestCreate_StoresAllFields(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	cred := sampleV3Cred()
	created, err := repo.Create(ctx, cred)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Name != cred.Name {
		t.Errorf("Name: got %q want %q", created.Name, cred.Name)
	}
	if created.SecurityName != cred.SecurityName {
		t.Errorf("SecurityName: got %q want %q", created.SecurityName, cred.SecurityName)
	}
	if created.AuthProtocol != cred.AuthProtocol {
		t.Errorf("AuthProtocol: got %q want %q", created.AuthProtocol, cred.AuthProtocol)
	}
	if created.EncryptedAuthKey != cred.EncryptedAuthKey {
		t.Errorf("EncryptedAuthKey should be stored but was lost")
	}
}

func TestCreate_DuplicateName_ReturnsDuplicateError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	if _, err := repo.Create(ctx, sampleCred()); err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	_, err := repo.Create(ctx, sampleCred())
	if err == nil {
		t.Fatal("expected error on duplicate name, got nil")
	}
	if err != repository.ErrDuplicateCredentialName {
		t.Errorf("expected ErrDuplicateCredentialName, got %v", err)
	}
}

// ── FindByID ──────────────────────────────────────────────────────────────────

func TestFindByID_ReturnsCreatedCredential(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	created, _ := repo.Create(ctx, sampleCred())

	found, err := repo.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID() error = %v", err)
	}
	if found.ID != created.ID {
		t.Errorf("ID mismatch: got %q want %q", found.ID, created.ID)
	}
	if found.Name != created.Name {
		t.Errorf("Name mismatch: got %q want %q", found.Name, created.Name)
	}
}

func TestFindByID_NotFound_ReturnsError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	_, err := repo.FindByID(ctx, "non-existent-id")
	if err != repository.ErrCredentialNotFound {
		t.Errorf("expected ErrCredentialNotFound, got %v", err)
	}
}

func TestFindByID_EmptyID_ReturnsInvalidError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	_, err := repo.FindByID(ctx, "")
	if err != repository.ErrInvalidCredentialID {
		t.Errorf("expected ErrInvalidCredentialID for empty ID, got %v", err)
	}
}

// ── FindAll ───────────────────────────────────────────────────────────────────

func TestFindAll_EmptyRepo_ReturnsEmptySlice(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	results, err := repo.FindAll(ctx)
	if err != nil {
		t.Fatalf("FindAll() error = %v", err)
	}
	if results == nil {
		t.Error("expected non-nil slice for empty repo")
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

func TestFindAll_ReturnsOnlyActiveCredentials(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	c1, _ := repo.Create(ctx, sampleCred())
	_, _ = repo.Create(ctx, sampleV3Cred())

	// Soft-delete first credential.
	if err := repo.DeleteByID(ctx, c1.ID); err != nil {
		t.Fatalf("DeleteByID() error = %v", err)
	}

	results, err := repo.FindAll(ctx)
	if err != nil {
		t.Fatalf("FindAll() error = %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 active credential, got %d", len(results))
	}
	if results[0].Name != sampleV3Cred().Name {
		t.Errorf("expected v3 cred to remain, got %q", results[0].Name)
	}
}

// ── UpdateByID ────────────────────────────────────────────────────────────────

func TestUpdateByID_UpdatesFieldsAndTimestamp(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	created, _ := repo.Create(ctx, sampleCred())
	originalCreatedAt := created.CreatedAt

	update := &model.SNMPCredential{
		Name:               "office-v2c-updated",
		Version:            model.SNMPVersion2c,
		EncryptedCommunity: "enc:aes256:newkey==",
	}

	updated, err := repo.UpdateByID(ctx, created.ID, update)
	if err != nil {
		t.Fatalf("UpdateByID() error = %v", err)
	}
	if updated.Name != "office-v2c-updated" {
		t.Errorf("expected updated Name, got %q", updated.Name)
	}
	if !updated.UpdatedAt.After(originalCreatedAt) {
		t.Error("expected UpdatedAt to be after CreatedAt")
	}
	// CreatedAt must not change.
	if !updated.CreatedAt.Equal(originalCreatedAt) {
		t.Error("CreatedAt must not change on update")
	}
}

func TestUpdateByID_NotFound_ReturnsError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	_, err := repo.UpdateByID(ctx, "nonexistent", sampleCred())
	if err != repository.ErrCredentialNotFound {
		t.Errorf("expected ErrCredentialNotFound, got %v", err)
	}
}

func TestUpdateByID_DuplicateName_ReturnsError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	c1, _ := repo.Create(ctx, sampleCred())
	_, _ = repo.Create(ctx, sampleV3Cred())

	// Try to rename c1 to the same name as c2.
	update := &model.SNMPCredential{Name: sampleV3Cred().Name, Version: model.SNMPVersion2c}
	_, err := repo.UpdateByID(ctx, c1.ID, update)
	if err != repository.ErrDuplicateCredentialName {
		t.Errorf("expected ErrDuplicateCredentialName, got %v", err)
	}
}

// ── DeleteByID ────────────────────────────────────────────────────────────────

func TestDeleteByID_SoftDeletesSetsActiveFalse(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	created, _ := repo.Create(ctx, sampleCred())

	if err := repo.DeleteByID(ctx, created.ID); err != nil {
		t.Fatalf("DeleteByID() error = %v", err)
	}

	// FindByID should still find the document (soft delete preserves it).
	found, err := repo.FindByID(ctx, created.ID)
	if err != nil {
		t.Fatalf("FindByID after soft delete error = %v", err)
	}
	if found.Active {
		t.Error("expected Active=false after soft delete")
	}
}

func TestDeleteByID_NotFound_ReturnsError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	err := repo.DeleteByID(ctx, "nonexistent")
	if err != repository.ErrCredentialNotFound {
		t.Errorf("expected ErrCredentialNotFound, got %v", err)
	}
}

func TestDeleteByID_EmptyID_ReturnsInvalidError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()
	ctx := context.Background()

	err := repo.DeleteByID(ctx, "")
	if err != repository.ErrInvalidCredentialID {
		t.Errorf("expected ErrInvalidCredentialID for empty ID, got %v", err)
	}
}

// ── Context cancellation ──────────────────────────────────────────────────────

func TestCreate_CancelledContext_ReturnsError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err := repo.Create(ctx, sampleCred())
	if err == nil {
		t.Fatal("expected error for cancelled context, got nil")
	}
}

func TestFindByID_CancelledContext_ReturnsError(t *testing.T) {
	repo := repository.NewInMemoryCredentialRepository()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := repo.FindByID(ctx, "some-id")
	if err == nil {
		t.Fatal("expected error for cancelled context, got nil")
	}
}
