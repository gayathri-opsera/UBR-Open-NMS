package crypto

import (
	"strings"
	"testing"
)

// testKey is a fixed 32-byte key for use in unit tests only.
var testKey = []byte("test-key-must-be-32-bytes-exactly") // exactly 32 bytes

func TestEncryptDecrypt_Roundtrip(t *testing.T) {
	enc, err := NewEncryptor(testKey)
	if err != nil {
		t.Fatalf("NewEncryptor failed: %v", err)
	}
	plaintext := "public"
	ciphertext, err := enc.Encrypt(plaintext)
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}
	if ciphertext == plaintext {
		t.Error("ciphertext must differ from plaintext")
	}

	decrypted, err := enc.Decrypt(ciphertext)
	if err != nil {
		t.Fatalf("Decrypt failed: %v", err)
	}
	if decrypted != plaintext {
		t.Errorf("Decrypt(%q) = %q, want %q", ciphertext, decrypted, plaintext)
	}
}

func TestEncrypt_EmptyPlaintext_ReturnsEmpty(t *testing.T) {
	enc, _ := NewEncryptor(testKey)
	out, err := enc.Encrypt("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "" {
		t.Errorf("expected empty output for empty input, got %q", out)
	}
}

func TestDecrypt_EmptyEncoded_ReturnsEmpty(t *testing.T) {
	enc, _ := NewEncryptor(testKey)
	out, err := enc.Decrypt("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "" {
		t.Errorf("expected empty output for empty encoded, got %q", out)
	}
}

func TestEncrypt_DifferentNonceEachCall(t *testing.T) {
	enc, _ := NewEncryptor(testKey)
	c1, _ := enc.Encrypt("same")
	c2, _ := enc.Encrypt("same")
	if c1 == c2 {
		t.Error("two encryptions of the same value should produce different ciphertexts (different nonces)")
	}
}

func TestNewEncryptor_ShortKey_ReturnsError(t *testing.T) {
	_, err := NewEncryptor([]byte("too-short"))
	if err == nil {
		t.Fatal("expected error for short key")
	}
	if !strings.Contains(err.Error(), "32 bytes") {
		t.Errorf("expected key length error, got: %v", err)
	}
}

func TestDecrypt_TamperedCiphertext_ReturnsError(t *testing.T) {
	enc, _ := NewEncryptor(testKey)
	ciphertext, _ := enc.Encrypt("secret")
	// Flip the last byte of the base64-encoded ciphertext.
	tampered := ciphertext[:len(ciphertext)-1] + "X"
	_, err := enc.Decrypt(tampered)
	if err == nil {
		t.Error("expected error for tampered ciphertext")
	}
}

func TestDecrypt_TooShortCiphertext_ReturnsError(t *testing.T) {
	enc, _ := NewEncryptor(testKey)
	// "YQ==" decodes to 1 byte, which is < nonceLength (12).
	_, err := enc.Decrypt("YQ==")
	if err == nil {
		t.Fatal("expected ErrCiphertextTooShort")
	}
}
