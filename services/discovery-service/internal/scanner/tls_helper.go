// Package scanner — TLS helper for probe executors (WO-008).
// Separated to keep the main orchestrator file free of crypto/tls imports.
package scanner

import (
	"crypto/tls"
	"net/http"
)

// setInsecureTLS configures the transport to skip TLS certificate verification.
// This is intentional for probe-only connections to managed devices that commonly
// use self-signed certificates. No auth material is ever transmitted.
func setInsecureTLS(tr *http.Transport) {
	tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // probe-only: no auth material sent
}
