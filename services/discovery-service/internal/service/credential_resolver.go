package service

import (
	"context"
	"fmt"

	"github.com/airtel-ubrnms/discovery-service/internal/crypto"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
	"github.com/airtel-ubrnms/discovery-service/internal/scanner"
)

// StaticCommunityResolver returns a fixed community string for all hosts (dev / direct entry).
type StaticCommunityResolver struct {
	Community string
}

func (s *StaticCommunityResolver) ResolveCredential(_ string) (string, bool, error) {
	if s.Community == "" {
		return "", false, nil
	}
	return "static", true, nil
}

// StoredCredentialResolver resolves SNMP credentials from the credential store by ID (WO-027).
type StoredCredentialResolver struct {
	repo         repository.CredentialRepository
	encryptor    *crypto.Encryptor
	credentialID string
	community    string // decrypted community for v1/v2c; never logged
}

// NewStoredCredentialResolver loads and decrypts the credential referenced by credentialID.
func NewStoredCredentialResolver(
	ctx context.Context,
	repo repository.CredentialRepository,
	enc *crypto.Encryptor,
	credentialID string,
) (*StoredCredentialResolver, error) {
	if credentialID == "" {
		return nil, fmt.Errorf("credentialId is required")
	}
	rec, err := repo.FindByID(ctx, credentialID)
	if err != nil {
		return nil, err
	}
	r := &StoredCredentialResolver{repo: repo, encryptor: enc, credentialID: credentialID}
	if rec.EncryptedCommunity != "" && enc != nil {
		plain, decErr := enc.Decrypt(rec.EncryptedCommunity)
		if decErr != nil {
			return nil, decErr
		}
		r.community = plain
	}
	return r, nil
}

func (r *StoredCredentialResolver) ResolveCredential(_ string) (string, bool, error) {
	if r.community != "" {
		return r.credentialID, true, nil
	}
	return "", false, nil
}

// Community returns the decrypted community for SNMP clients that need it.
// Callers must not log the return value.
func (r *StoredCredentialResolver) Community() string {
	return r.community
}

var _ scanner.SNMPCredentialResolver = (*StaticCommunityResolver)(nil)
var _ scanner.SNMPCredentialResolver = (*StoredCredentialResolver)(nil)
