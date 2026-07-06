"""
E2E Test: Authentication Flow
Login → access protected endpoint → refresh token → logout → verify access denied
"""
import time
import pytest
import httpx

from conftest import URLS, ADMIN_USER, ADMIN_PASS, auth_headers


class TestAuthFlow:

    @pytest.mark.auth
    def test_login_returns_tokens(self, http):
        resp = http.post(
            f"{URLS['auth']}/api/v1/auth/login",
            json={"username": ADMIN_USER, "password": ADMIN_PASS},
        )
        assert resp.status_code == 200, f"Login failed: {resp.text}"
        data = resp.json()
        assert "accessToken" in data, "Response missing accessToken"
        assert len(data["accessToken"]) > 10, "accessToken appears empty"

    @pytest.mark.auth
    def test_protected_endpoint_accessible_with_token(self, http, auth_headers):
        resp = http.get(f"{URLS['alarm']}/api/v1/alarms", headers=auth_headers)
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

    @pytest.mark.auth
    def test_protected_endpoint_rejects_without_token(self, http):
        resp = http.get(f"{URLS['alarm']}/api/v1/alarms")
        assert resp.status_code in (401, 403), (
            f"Expected 401/403 without token, got {resp.status_code}"
        )

    @pytest.mark.auth
    def test_token_refresh(self, http):
        # Login to get tokens
        login_resp = http.post(
            f"{URLS['auth']}/api/v1/auth/login",
            json={"username": ADMIN_USER, "password": ADMIN_PASS},
        )
        assert login_resp.status_code == 200
        refresh_token = login_resp.json().get("refreshToken", "")
        if not refresh_token:
            pytest.skip("Refresh tokens not supported in this environment")

        # Refresh
        refresh_resp = http.post(
            f"{URLS['auth']}/api/v1/auth/refresh",
            json={"refreshToken": refresh_token},
        )
        assert refresh_resp.status_code == 200, f"Refresh failed: {refresh_resp.text}"
        new_token = refresh_resp.json().get("accessToken", "")
        assert len(new_token) > 10, "New access token appears empty"

    @pytest.mark.auth
    def test_logout_invalidates_session(self, http):
        # Login
        login_resp = http.post(
            f"{URLS['auth']}/api/v1/auth/login",
            json={"username": ADMIN_USER, "password": ADMIN_PASS},
        )
        assert login_resp.status_code == 200
        token = login_resp.json()["accessToken"]

        # Logout
        logout_resp = http.post(
            f"{URLS['auth']}/api/v1/auth/logout",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert logout_resp.status_code in (200, 204), f"Logout failed: {logout_resp.text}"

        # Access after logout — should be rejected
        post_logout = http.get(
            f"{URLS['alarm']}/api/v1/alarms",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert post_logout.status_code in (401, 403), (
            f"Expected token to be invalidated after logout, got {post_logout.status_code}"
        )

    @pytest.mark.auth
    def test_invalid_credentials_rejected(self, http):
        resp = http.post(
            f"{URLS['auth']}/api/v1/auth/login",
            json={"username": "nonexistent", "password": "wrongpassword"},
        )
        assert resp.status_code in (401, 403, 400), (
            f"Expected auth failure, got {resp.status_code}"
        )
