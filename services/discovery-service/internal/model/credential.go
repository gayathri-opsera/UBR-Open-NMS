// Package model — SNMP credential domain types (WO-002).
//
// SNMPCredential represents a stored SNMP credential profile for use by the
// generic discovery engine. Credentials are never returned in plain text by
// API endpoints; the encryptedCommunity/authKey/privacyKey fields are
// always redacted at the handler layer before sending responses to clients.
package model

import "time"

// SNMPVersion enumerates the supported SNMP protocol versions.
type SNMPVersion string

const (
	SNMPVersion1  SNMPVersion = "v1"
	SNMPVersion2c SNMPVersion = "v2c"
	SNMPVersion3  SNMPVersion = "v3"
)

// SNMPv3SecurityLevel enumerates SNMPv3 security levels.
type SNMPv3SecurityLevel string

const (
	SecurityLevelNoAuthNoPriv SNMPv3SecurityLevel = "noAuthNoPriv"
	SecurityLevelAuthNoPriv   SNMPv3SecurityLevel = "authNoPriv"
	SecurityLevelAuthPriv     SNMPv3SecurityLevel = "authPriv"
)

// SNMPv3AuthProtocol enumerates supported SNMPv3 authentication protocols.
type SNMPv3AuthProtocol string

const (
	AuthProtocolMD5    SNMPv3AuthProtocol = "MD5"
	AuthProtocolSHA    SNMPv3AuthProtocol = "SHA"
	AuthProtocolSHA256 SNMPv3AuthProtocol = "SHA256"
)

// SNMPv3PrivacyProtocol enumerates supported SNMPv3 privacy (encryption) protocols.
type SNMPv3PrivacyProtocol string

const (
	PrivacyProtocolDES   SNMPv3PrivacyProtocol = "DES"
	PrivacyProtocolAES   SNMPv3PrivacyProtocol = "AES"
	PrivacyProtocolAES256 SNMPv3PrivacyProtocol = "AES256"
)

// SNMPCredential is the data model persisted in MongoDB's snmp_credentials collection.
//
// Security requirements (WO-002):
//   - encryptedCommunity and encryptedAuthKey and encryptedPrivacyKey store
//     AES-256-GCM encrypted values; plaintext must never be persisted.
//   - These fields must be redacted before the struct is serialised for API responses.
type SNMPCredential struct {
	// ID is the MongoDB ObjectID hex string — primary key.
	ID string `bson:"_id,omitempty" json:"id"`

	// Name is the operator-assigned label for this credential profile.
	// Must be unique within a tenant. Used for display and selection in the UI.
	Name string `bson:"name" json:"name"`

	// Description is an optional human-readable note.
	Description string `bson:"description,omitempty" json:"description,omitempty"`

	// Version is the SNMP protocol version this credential applies to.
	Version SNMPVersion `bson:"version" json:"version"`

	// EncryptedCommunity is the AES-256-GCM encrypted community string for
	// SNMP v1 and v2c. Never set for v3 credentials. Never returned in API responses.
	EncryptedCommunity string `bson:"encryptedCommunity,omitempty" json:"-"`

	// ── SNMPv3 fields ────────────────────────────────────────────────────────

	// SecurityName is the SNMPv3 username (plaintext — not a secret).
	SecurityName string `bson:"securityName,omitempty" json:"securityName,omitempty"`

	// SecurityLevel is the SNMPv3 security level.
	SecurityLevel SNMPv3SecurityLevel `bson:"securityLevel,omitempty" json:"securityLevel,omitempty"`

	// AuthProtocol is the SNMPv3 authentication protocol.
	AuthProtocol SNMPv3AuthProtocol `bson:"authProtocol,omitempty" json:"authProtocol,omitempty"`

	// EncryptedAuthKey is the AES-256-GCM encrypted SNMPv3 auth passphrase.
	// Never returned in API responses.
	EncryptedAuthKey string `bson:"encryptedAuthKey,omitempty" json:"-"`

	// PrivacyProtocol is the SNMPv3 privacy (encryption) protocol.
	PrivacyProtocol SNMPv3PrivacyProtocol `bson:"privacyProtocol,omitempty" json:"privacyProtocol,omitempty"`

	// EncryptedPrivacyKey is the AES-256-GCM encrypted SNMPv3 privacy passphrase.
	// Never returned in API responses.
	EncryptedPrivacyKey string `bson:"encryptedPrivacyKey,omitempty" json:"-"`

	// ── Metadata ─────────────────────────────────────────────────────────────

	// CreatedBy is the user identity that created this credential profile.
	CreatedBy string `bson:"createdBy" json:"createdBy"`

	// CreatedAt is the UTC timestamp when the credential was first created.
	CreatedAt time.Time `bson:"createdAt" json:"createdAt"`

	// UpdatedAt is the UTC timestamp of the last modification.
	UpdatedAt time.Time `bson:"updatedAt" json:"updatedAt"`

	// Active indicates whether this credential is currently in use.
	// Soft-deleted credentials are set to active=false rather than physically deleted.
	Active bool `bson:"active" json:"active"`
}

// SNMPCredentialSummary is a safe, redacted view of SNMPCredential
// for use in API list/get responses. No encrypted fields are included.
type SNMPCredentialSummary struct {
	ID            string               `json:"id"`
	Name          string               `json:"name"`
	Description   string               `json:"description,omitempty"`
	Version       SNMPVersion          `json:"version"`
	SecurityName  string               `json:"securityName,omitempty"`
	SecurityLevel SNMPv3SecurityLevel  `json:"securityLevel,omitempty"`
	AuthProtocol  SNMPv3AuthProtocol   `json:"authProtocol,omitempty"`
	PrivacyProtocol SNMPv3PrivacyProtocol `json:"privacyProtocol,omitempty"`
	CreatedBy     string               `json:"createdBy"`
	CreatedAt     time.Time            `json:"createdAt"`
	UpdatedAt     time.Time            `json:"updatedAt"`
	Active        bool                 `json:"active"`
}

// Redact returns a safe SNMPCredentialSummary view with all encrypted fields omitted.
func (c *SNMPCredential) Redact() SNMPCredentialSummary {
	return SNMPCredentialSummary{
		ID:              c.ID,
		Name:            c.Name,
		Description:     c.Description,
		Version:         c.Version,
		SecurityName:    c.SecurityName,
		SecurityLevel:   c.SecurityLevel,
		AuthProtocol:    c.AuthProtocol,
		PrivacyProtocol: c.PrivacyProtocol,
		CreatedBy:       c.CreatedBy,
		CreatedAt:       c.CreatedAt,
		UpdatedAt:       c.UpdatedAt,
		Active:          c.Active,
	}
}
