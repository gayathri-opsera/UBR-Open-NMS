// Package main provides a CLI signing helper for the UBR NMS Auth-Info / Auth-Signature
// HMAC protocol defined in WO-015.
//
// Usage:
//
//	go run sign.go -secret <hex-or-plaintext-secret> -device <mac-addr> -path <request-path> [-body <json-body>]
//
// The tool prints the Auth-Info and Auth-Signature header values to stdout.
// Use these headers when testing southbound UBR check-in endpoints manually (curl, Postman, etc.).
//
// Example:
//
//	go run sign.go \
//	  -secret "my-device-secret" \
//	  -device "AA:BB:CC:DD:EE:FF" \
//	  -path "/api/v1/discovery/check-in" \
//	  -body '{"serialNumber":"SN12345678","macAddress":"AA:BB:CC:DD:EE:FF"}'
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"math/big"
	"os"
	"time"
)

const nonceLength = 30
const nonceCharset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

func main() {
	secret := flag.String("secret", "", "HMAC secret for the device (required)")
	deviceID := flag.String("device", "", "Device MAC address for Auth-Info id= field (required)")
	path := flag.String("path", "/api/v1/discovery/check-in", "Request path")
	body := flag.String("body", "", "Raw request body (optional, defaults to empty)")
	flag.Parse()

	if *secret == "" || *deviceID == "" {
		fmt.Fprintln(os.Stderr, "Error: -secret and -device are required")
		flag.Usage()
		os.Exit(1)
	}

	nonce, err := generateNonce(nonceLength)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error generating nonce: %v\n", err)
		os.Exit(1)
	}

	ts := time.Now().Unix()
	authInfo := fmt.Sprintf("id=%s,timestamp=%d,nonce=%s", *deviceID, ts, nonce)
	sig := computeAuthSignature(*secret, authInfo, *path, []byte(*body))

	fmt.Printf("Auth-Info: %s\n", authInfo)
	fmt.Printf("Auth-Signature: %s\n", sig)
	fmt.Println()
	fmt.Println("# Example curl command:")
	fmt.Printf("curl -X POST http://localhost:8081%s \\\n", *path)
	fmt.Printf("  -H 'Content-Type: application/json' \\\n")
	fmt.Printf("  -H 'Auth-Info: %s' \\\n", authInfo)
	fmt.Printf("  -H 'Auth-Signature: %s' \\\n", sig)
	if *body != "" {
		fmt.Printf("  -d '%s'\n", *body)
	}
}

// computeAuthSignature implements the WO-015 HMAC canonical message:
// Auth-Info_header_value + "\n" + request_path + "\n" + raw_body_bytes
func computeAuthSignature(secret, authInfo, path string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(authInfo))
	mac.Write([]byte("\n"))
	mac.Write([]byte(path))
	mac.Write([]byte("\n"))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// generateNonce produces a cryptographically random nonce of the given length.
func generateNonce(length int) (string, error) {
	result := make([]byte, length)
	for i := range result {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(nonceCharset))))
		if err != nil {
			return "", err
		}
		result[i] = nonceCharset[n.Int64()]
	}
	return string(result), nil
}
