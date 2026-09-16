package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/airtel-ubrnms/discovery-service/internal/crypto"
	"github.com/airtel-ubrnms/discovery-service/internal/model"
	"github.com/airtel-ubrnms/discovery-service/internal/repository"
	"github.com/airtel-ubrnms/discovery-service/internal/service"
)

// ── Test helpers ──────────────────────────────────────────────────────────────

var testEncKey = []byte("test-key-must-be-32-bytes-exactly")

func newTestHandler(t *testing.T) *CredentialHandler {
	t.Helper()
	enc, err := crypto.NewEncryptor(testEncKey)
	if err != nil {
		t.Fatalf("encryptor: %v", err)
	}
	repo := repository.NewInMemoryCredentialRepository()
	svc := service.NewCredentialService(repo, enc, nil)
	return NewCredentialHandler(svc)
}

// doRequest performs an HTTP request and returns the recorder.
func doRequest(t *testing.T, handler http.HandlerFunc, method, path string, body interface{}, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	handler(rr, req)
	return rr
}

// adminHeaders returns headers simulating an Admin user.
func adminHeaders() map[string]string {
	return map[string]string{"X-User-Role": "Admin", "X-User-ID": "admin-user"}
}

// v2cBody returns a valid create request body.
func v2cBody(name string) map[string]interface{} {
	return map[string]interface{}{
		"name":      name,
		"version":   "v2c",
		"community": "public",
	}
}

// chiWithParam builds a chi request context with a URL param set.
func chiWithParam(r *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// doChiRequest performs a request passing a chi URL param.
func doChiRequest(t *testing.T, handlerFn http.HandlerFunc, method, urlParam, paramValue string, body interface{}, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, "/", &buf)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req = chiWithParam(req, urlParam, paramValue)
	rr := httptest.NewRecorder()
	handlerFn(rr, req)
	return rr
}

// ── POST /credentials ─────────────────────────────────────────────────────────

func TestCreateCredential_Admin_Returns201(t *testing.T) {
	h := newTestHandler(t)
	rr := doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("prod-cred"), adminHeaders())
	if rr.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp model.SNMPCredentialSummary
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ID == "" {
		t.Error("expected non-empty ID in response")
	}
}

func TestCreateCredential_NonAdmin_Returns403(t *testing.T) {
	h := newTestHandler(t)
	rr := doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("x"), map[string]string{"X-User-Role": "ReadOnly"})
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestCreateCredential_NoRole_Returns403(t *testing.T) {
	h := newTestHandler(t)
	rr := doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("x"), nil)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 when role is missing, got %d", rr.Code)
	}
}

func TestCreateCredential_MissingName_Returns400(t *testing.T) {
	h := newTestHandler(t)
	body := map[string]interface{}{"version": "v2c", "community": "public"}
	rr := doRequest(t, h.CreateCredential, http.MethodPost, "/", body, adminHeaders())
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing name, got %d", rr.Code)
	}
}

func TestCreateCredential_MissingCommunity_Returns400(t *testing.T) {
	h := newTestHandler(t)
	body := map[string]interface{}{"name": "test", "version": "v2c"}
	rr := doRequest(t, h.CreateCredential, http.MethodPost, "/", body, adminHeaders())
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing community, got %d", rr.Code)
	}
}

// ── GET /credentials ──────────────────────────────────────────────────────────

func TestListCredentials_WithRole_Returns200(t *testing.T) {
	h := newTestHandler(t)
	rr := doRequest(t, h.ListCredentials, http.MethodGet, "/", nil, map[string]string{"X-User-Role": "Admin"})
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestListCredentials_NoRole_Returns403(t *testing.T) {
	h := newTestHandler(t)
	rr := doRequest(t, h.ListCredentials, http.MethodGet, "/", nil, nil)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 when no role, got %d", rr.Code)
	}
}

func TestListCredentials_ReturnsCreatedItems(t *testing.T) {
	h := newTestHandler(t)
	doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("list-me"), adminHeaders())

	rr := doRequest(t, h.ListCredentials, http.MethodGet, "/", nil, adminHeaders())
	var items []model.SNMPCredentialSummary
	json.NewDecoder(rr.Body).Decode(&items)
	if len(items) != 1 {
		t.Errorf("expected 1 item, got %d", len(items))
	}
}

// ── GET /credentials/{credentialId} ──────────────────────────────────────────

func TestGetCredential_Found_Returns200(t *testing.T) {
	h := newTestHandler(t)
	createRR := doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("get-me"), adminHeaders())
	var created model.SNMPCredentialSummary
	json.NewDecoder(createRR.Body).Decode(&created)

	rr := doChiRequest(t, h.GetCredential, http.MethodGet, "credentialId", created.ID, nil, adminHeaders())
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestGetCredential_NotFound_Returns404(t *testing.T) {
	h := newTestHandler(t)
	rr := doChiRequest(t, h.GetCredential, http.MethodGet, "credentialId", "ghost-id", nil, adminHeaders())
	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

// ── PUT /credentials/{credentialId} ──────────────────────────────────────────

func TestUpdateCredential_Admin_Returns200(t *testing.T) {
	h := newTestHandler(t)
	createRR := doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("update-me"), adminHeaders())
	var created model.SNMPCredentialSummary
	json.NewDecoder(createRR.Body).Decode(&created)

	updateBody := map[string]string{"name": "updated-name"}
	rr := doChiRequest(t, h.UpdateCredential, http.MethodPut, "credentialId", created.ID, updateBody, adminHeaders())
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var updated model.SNMPCredentialSummary
	json.NewDecoder(rr.Body).Decode(&updated)
	if updated.Name != "updated-name" {
		t.Errorf("expected name 'updated-name', got %q", updated.Name)
	}
}

func TestUpdateCredential_NonAdmin_Returns403(t *testing.T) {
	h := newTestHandler(t)
	rr := doChiRequest(t, h.UpdateCredential, http.MethodPut, "credentialId", "any", map[string]string{"name": "x"}, map[string]string{"X-User-Role": "Viewer"})
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestUpdateCredential_NotFound_Returns404(t *testing.T) {
	h := newTestHandler(t)
	rr := doChiRequest(t, h.UpdateCredential, http.MethodPut, "credentialId", "ghost", map[string]string{"name": "x"}, adminHeaders())
	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

// ── DELETE /credentials/{credentialId} ───────────────────────────────────────

func TestDeleteCredential_Admin_Returns204(t *testing.T) {
	h := newTestHandler(t)
	createRR := doRequest(t, h.CreateCredential, http.MethodPost, "/", v2cBody("delete-me"), adminHeaders())
	var created model.SNMPCredentialSummary
	json.NewDecoder(createRR.Body).Decode(&created)

	rr := doChiRequest(t, h.DeleteCredential, http.MethodDelete, "credentialId", created.ID, nil, adminHeaders())
	if rr.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rr.Code)
	}
}

func TestDeleteCredential_NonAdmin_Returns403(t *testing.T) {
	h := newTestHandler(t)
	rr := doChiRequest(t, h.DeleteCredential, http.MethodDelete, "credentialId", "any", nil, map[string]string{"X-User-Role": "ReadOnly"})
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestDeleteCredential_NotFound_Returns404(t *testing.T) {
	h := newTestHandler(t)
	rr := doChiRequest(t, h.DeleteCredential, http.MethodDelete, "credentialId", "ghost", nil, adminHeaders())
	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

// ── Security: no sensitive fields in responses ────────────────────────────────

func TestCreateCredential_ResponseHasNoCommunityString(t *testing.T) {
	h := newTestHandler(t)
	rr := doRequest(t, h.CreateCredential, http.MethodPost, "/", map[string]interface{}{
		"name": "sec-test", "version": "v2c", "community": "s3cr3t-community",
	}, adminHeaders())

	body := rr.Body.String()
	if bytes.Contains([]byte(body), []byte("s3cr3t-community")) {
		t.Error("SECURITY: community string must not appear in the HTTP response")
	}
}
