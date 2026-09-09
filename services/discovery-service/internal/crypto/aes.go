// Package crypto provides AES-256-GCM encryption utilities for protecting
// sensitive SNMP credential material at rest (WO-014).
//
// Security requirements:
//   - The encryption key must be exactly 32 bytes (256 bits) for AES-256.
//   - A random 12-byte nonce is generated per encryption operation and
//     prepended to the ciphertext. The final stored value is nonce||ciphertext.
//   - The key MUST come from an environment variable or HashiCorp Vault; it
//     must never be hard-coded in source files or appear in logs.
//
// Ciphertext format: base64url(nonce[12] || ciphertext)
// This encoding is URL-safe and avoids padding issues with JSON storage.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	// keyLength is the required AES-256 key length in bytes.
	keyLength = 32
	// nonceLength is the standard GCM nonce size in bytes.
	nonceLength = 12
	// EnvKeyVar is the environment variable name for the encryption key.
	// The value must be exactly 32 bytes when interpreted as raw bytes,
	// or a 64-character hex string decoded to 32 bytes.
	EnvKeyVar = "CREDENTIAL_ENCRYPTION_KEY"
)

// ErrKeyTooShort is returned when the provided key is not exactly 32 bytes.
var ErrKeyTooShort = errors.New("encryption key must be exactly 32 bytes (AES-256)")

// ErrCiphertextTooShort is returned when the ciphertext is shorter than the nonce.
var ErrCiphertextTooShort = errors.New("ciphertext is too short; data may be corrupt")

// Encryptor performs AES-256-GCM encryption and decryption using a fixed key.
// It is safe for concurrent use from multiple goroutines.
type Encryptor struct {
	aead cipher.AEAD
}

// NewEncryptorFromEnv creates an Encryptor whose key is read from the
// CREDENTIAL_ENCRYPTION_KEY environment variable. Returns an error if the
// variable is not set or if the key is not exactly 32 bytes.
//
// Call this once at service startup and reuse the returned Encryptor.
func NewEncryptorFromEnv() (*Encryptor, error) {
	raw := os.Getenv(EnvKeyVar)
	if raw == "" {
		return nil, fmt.Errorf("crypto: %s environment variable is not set", EnvKeyVar)
	}
	return NewEncryptor([]byte(raw))
}

// NewEncryptor creates an Encryptor with the provided 32-byte key.
// Returns ErrKeyTooShort if the key length is not exactly 32 bytes.
func NewEncryptor(key []byte) (*Encryptor, error) {
	if len(key) != keyLength {
		return nil, fmt.Errorf("%w: got %d bytes", ErrKeyTooShort, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("crypto: failed to create AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("crypto: failed to create GCM: %w", err)
	}
	return &Encryptor{aead: aead}, nil
}

// Encrypt encrypts plaintext using AES-256-GCM and returns a base64url-encoded
// string of the form base64url(nonce || ciphertext).
//
// A fresh random nonce is generated for every call, making identical plaintexts
// produce different ciphertexts. The nonce is authenticated as part of GCM.
func (e *Encryptor) Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil // empty input produces empty output — callers handle empty fields
	}
	nonce := make([]byte, nonceLength)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("crypto: failed to generate nonce: %w", err)
	}
	// Seal appends the ciphertext (and GCM authentication tag) to nonce.
	ciphertext := e.aead.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.URLEncoding.EncodeToString(ciphertext), nil
}

// Decrypt decrypts a base64url-encoded ciphertext produced by Encrypt.
// Returns ErrCiphertextTooShort if the decoded bytes are shorter than the nonce.
// Returns an error if the authentication tag verification fails (tamper detection).
func (e *Encryptor) Decrypt(encoded string) (string, error) {
	if encoded == "" {
		return "", nil // symmetric with Encrypt — empty encoded → empty plain
	}
	data, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("crypto: base64 decode failed: %w", err)
	}
	if len(data) < nonceLength {
		return "", ErrCiphertextTooShort
	}
	nonce, ciphertext := data[:nonceLength], data[nonceLength:]
	plaintext, err := e.aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("crypto: decryption failed (authentication tag mismatch): %w", err)
	}
	return string(plaintext), nil
}
