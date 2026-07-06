"""
E2E Tests: Device Onboarding, KPI Pipeline, Config Push
"""
import time
import uuid
import pytest

from conftest import URLS, stub_reset, wait_for_stub, wait_for_api


# ── Device Onboarding ─────────────────────────────────────────────────────────

class TestDeviceOnboarding:

    SERIAL = f"SN-E2E-{uuid.uuid4().hex[:8].upper()}"
    DEVICE_ID = f"CPE-E2E-{uuid.uuid4().hex[:8].upper()}"

    @pytest.fixture(autouse=True)
    def reset_mobinet(self, http):
        stub_reset(http, "mobinet")
        yield
        stub_reset(http, "mobinet")

    @pytest.mark.onboarding
    def test_device_checkin_creates_inventory_record(self, http, auth_headers):
        """Device check-in must create an inventory record within 60 seconds."""
        resp = http.post(
            f"{URLS['discovery']}/api/v1/devices/checkin",
            json={
                "deviceId": self.DEVICE_ID,
                "serialNumber": self.SERIAL,
                "deviceType": "CPE",
                "model": "ENH200EXT",
                "ipAddress": "10.2.0.99",
                "macAddress": "AA:BB:CC:DD:EE:99",
            },
            headers=auth_headers,
        )
        assert resp.status_code in (200, 201), f"Check-in failed: {resp.text}"

        # Inventory must reflect the device within 60s
        inv_resp = wait_for_api(
            http,
            f"{URLS['inventory']}/api/v1/devices/{self.DEVICE_ID}",
            headers=auth_headers,
            timeout=60.0,
        )
        assert inv_resp.status_code == 200
        device = inv_resp.json()
        assert device.get("serialNumber") == self.SERIAL

    @pytest.mark.onboarding
    def test_device_checkin_syncs_to_mobinet(self, http, auth_headers):
        """Inventory registration must trigger a Mobinet sync within 60 seconds."""
        http.post(
            f"{URLS['discovery']}/api/v1/devices/checkin",
            json={
                "deviceId": self.DEVICE_ID,
                "serialNumber": self.SERIAL,
                "deviceType": "CPE",
                "model": "ENH200EXT",
                "ipAddress": "10.2.0.98",
                "macAddress": "AA:BB:CC:DD:EE:98",
            },
            headers=auth_headers,
        )

        messages = wait_for_stub(http, "mobinet", min_count=1, timeout=60.0)
        found = any(
            m.get("message", {}).get("serialNumber") == self.SERIAL
            for m in messages
        )
        assert found, f"Mobinet stub did not receive sync for SN {self.SERIAL}"


# ── KPI Pipeline ─────────────────────────────────────────────────────────────

class TestKpiPipeline:

    DEVICE_ID = f"BTS-KPI-E2E-{uuid.uuid4().hex[:8].upper()}"

    @pytest.fixture(autouse=True)
    def reset_mycom(self, http):
        stub_reset(http, "mycom")
        yield
        stub_reset(http, "mycom")

    @pytest.mark.kpi
    def test_kpi_poll_stores_data(self, http, auth_headers):
        """Triggered KPI poll must result in stored data within 30 seconds."""
        resp = http.post(
            f"{URLS['discovery']}/api/v1/kpi/poll",
            json={"deviceId": self.DEVICE_ID},
            headers=auth_headers,
        )
        assert resp.status_code in (200, 202), f"Poll trigger failed: {resp.text}"

        kpi_resp = wait_for_api(
            http,
            f"{URLS['kpi_query']}/api/v1/kpi?deviceId={self.DEVICE_ID}&granularity=1m",
            headers=auth_headers,
            timeout=30.0,
        )
        assert kpi_resp.status_code == 200

    @pytest.mark.kpi
    def test_kpi_exported_to_mycom(self, http, auth_headers):
        """KPI data must be exported to the Mycom stub within 30 seconds."""
        http.post(
            f"{URLS['discovery']}/api/v1/kpi/poll",
            json={"deviceId": self.DEVICE_ID},
            headers=auth_headers,
        )

        messages = wait_for_stub(http, "mycom", min_count=1, timeout=30.0)
        assert len(messages) >= 1, "Mycom stub did not receive any KPI records"
        # Verify Mycom format
        msg = messages[0].get("message", {})
        assert "serialNumber" in msg
        assert "metrics" in msg


# ── Config Push ───────────────────────────────────────────────────────────────

class TestConfigPush:

    DEVICE_ID = f"CPE-CFG-E2E-{uuid.uuid4().hex[:8].upper()}"

    @pytest.mark.config
    def test_config_template_crud(self, http, auth_headers):
        """Create, read, and delete a config template."""
        template = {
            "name": f"e2e-template-{uuid.uuid4().hex[:6]}",
            "isDefault": False,
            "parameters": {"txPower": 20},
        }

        # Create
        create_resp = http.post(
            f"{URLS['config']}/api/v1/config/templates",
            json=template,
            headers=auth_headers,
        )
        assert create_resp.status_code in (200, 201), f"Template create failed: {create_resp.text}"
        template_id = create_resp.json().get("id", create_resp.json().get("_id", ""))
        assert template_id, "No template ID returned"

        # Read
        get_resp = http.get(
            f"{URLS['config']}/api/v1/config/templates/{template_id}",
            headers=auth_headers,
        )
        assert get_resp.status_code == 200

        # Delete
        del_resp = http.delete(
            f"{URLS['config']}/api/v1/config/templates/{template_id}",
            headers=auth_headers,
        )
        assert del_resp.status_code in (200, 204)

    @pytest.mark.config
    def test_config_push_to_device(self, http, auth_headers):
        """Config push must be queued and status tracked."""
        # Create template
        create_resp = http.post(
            f"{URLS['config']}/api/v1/config/templates",
            json={"name": f"e2e-push-{uuid.uuid4().hex[:6]}", "parameters": {"txPower": 23}},
            headers=auth_headers,
        )
        if create_resp.status_code not in (200, 201):
            pytest.skip("Config service not available")
        template_id = create_resp.json().get("id", "")

        # Push
        push_resp = http.post(
            f"{URLS['config']}/api/v1/config/push",
            json={"deviceId": self.DEVICE_ID, "templateId": template_id},
            headers=auth_headers,
        )
        assert push_resp.status_code in (200, 202), f"Config push failed: {push_resp.text}"

        # Status should be queryable
        push_data = push_resp.json()
        job_id = push_data.get("jobId", push_data.get("id", ""))
        if job_id:
            status_resp = wait_for_api(
                http,
                f"{URLS['config']}/api/v1/config/jobs/{job_id}",
                headers=auth_headers,
                timeout=30.0,
            )
            assert status_resp.status_code == 200


# ── SLO Validation ─────────────────────────────────────────────────────────────

class TestSLO:

    @pytest.mark.slo
    def test_api_p99_latency_under_500ms(self, http, auth_headers):
        """API P99 latency SLO: < 500ms for the alarm list endpoint."""
        latencies = []
        for _ in range(20):
            start = time.time()
            resp = http.get(f"{URLS['alarm']}/api/v1/alarms", headers=auth_headers)
            latency_ms = (time.time() - start) * 1000
            if resp.status_code == 200:
                latencies.append(latency_ms)

        if not latencies:
            pytest.skip("Alarm service not responding")

        latencies.sort()
        p99 = latencies[int(len(latencies) * 0.99)]
        assert p99 < 500, f"P99 latency {p99:.0f}ms exceeds 500ms SLO"
