"""
E2E Test: Alarm Pipeline
SNMP trap → correlation → Netcool forward → SSE notification
SLO: end-to-end latency < 3 seconds
"""
import time
import uuid
import pytest

from conftest import URLS, stub_reset, wait_for_stub, wait_for_api


DEVICE_ID = "E2E-BTS-ALARM-001"


@pytest.fixture(autouse=True)
def reset_stubs(http):
    """Reset Netcool stub before each test."""
    stub_reset(http, "netcool")
    yield
    stub_reset(http, "netcool")


class TestAlarmPipeline:

    @pytest.mark.alarm
    def test_snmp_trap_generates_alarm(self, http, auth_headers):
        """Sending an SNMP trap must create an alarm in the NMS."""
        event_id = str(uuid.uuid4())
        resp = http.post(
            f"{URLS['event_collector']}/api/v1/events/trap",
            json={
                "version": "2c",
                "community": "public",
                "agentAddr": "10.1.0.1",
                "enterprise": "1.3.6.1.4.1.28776.1",
                "genericTrap": 2,
                "specificTrap": 0,
                "deviceId": DEVICE_ID,
                "varBinds": [
                    {"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": 12345},
                    {"oid": "1.3.6.1.4.1.28776.1.1", "type": "OctetString", "value": event_id},
                ],
            },
            headers=auth_headers,
        )
        assert resp.status_code in (200, 202), f"Trap submission failed: {resp.text}"

        # Alarm must appear in NMS within 3 seconds (SLO)
        alarm_resp = wait_for_api(
            http,
            f"{URLS['alarm']}/api/v1/alarms?deviceId={DEVICE_ID}&state=ACTIVE",
            headers=auth_headers,
            timeout=3.0,
        )
        assert alarm_resp.status_code == 200
        alarms = alarm_resp.json()
        assert len(alarms) > 0, "No alarm created for SNMP trap"

    @pytest.mark.alarm
    @pytest.mark.slo
    def test_alarm_pipeline_latency_under_3_seconds(self, http, auth_headers):
        """Alarm pipeline SLO: trap → alarm in NMS < 3 seconds."""
        start = time.time()
        device_id = f"E2E-SLO-{uuid.uuid4().hex[:8]}"

        resp = http.post(
            f"{URLS['event_collector']}/api/v1/events/trap",
            json={
                "version": "2c", "community": "public",
                "agentAddr": "10.1.0.2", "enterprise": "1.3.6.1.4.1.28776.1",
                "genericTrap": 2, "specificTrap": 0,
                "deviceId": device_id, "varBinds": [],
            },
            headers=auth_headers,
        )
        assert resp.status_code in (200, 202)

        alarm_resp = wait_for_api(
            http,
            f"{URLS['alarm']}/api/v1/alarms?deviceId={device_id}&state=ACTIVE",
            headers=auth_headers,
            timeout=3.0,
        )
        latency = time.time() - start
        assert alarm_resp.status_code == 200
        assert latency < 3.0, f"SLO violated: alarm pipeline latency was {latency:.2f}s (> 3s)"

    @pytest.mark.alarm
    def test_alarm_forwarded_to_netcool_stub(self, http, auth_headers):
        """Alarm must be forwarded to the Netcool stub."""
        resp = http.post(
            f"{URLS['event_collector']}/api/v1/events/trap",
            json={
                "version": "2c", "community": "public",
                "agentAddr": "10.1.0.3", "enterprise": "1.3.6.1.4.1.28776.1",
                "genericTrap": 2, "specificTrap": 0,
                "deviceId": DEVICE_ID, "varBinds": [],
            },
            headers=auth_headers,
        )
        assert resp.status_code in (200, 202)

        messages = wait_for_stub(http, "netcool", min_count=1, timeout=10.0)
        assert len(messages) >= 1, "Netcool stub did not receive alarm"
        # Verify Netcool message format
        msg = messages[0]["message"]
        assert "alarmId" in msg
        assert "severity" in msg
        assert "state" in msg

    @pytest.mark.alarm
    def test_alarm_clear_correlation(self, http, auth_headers):
        """A clear trap must close the corresponding raise alarm."""
        device_id = f"E2E-CLEAR-{uuid.uuid4().hex[:8]}"

        # Send raise
        http.post(
            f"{URLS['event_collector']}/api/v1/events/trap",
            json={
                "version": "2c", "community": "public",
                "agentAddr": "10.1.0.4", "enterprise": "1.3.6.1.4.1.28776.1",
                "genericTrap": 2, "specificTrap": 0,
                "deviceId": device_id, "varBinds": [],
            },
            headers=auth_headers,
        )
        wait_for_api(
            http,
            f"{URLS['alarm']}/api/v1/alarms?deviceId={device_id}&state=ACTIVE",
            headers=auth_headers, timeout=5.0,
        )

        # Send clear
        http.post(
            f"{URLS['event_collector']}/api/v1/events/trap",
            json={
                "version": "2c", "community": "public",
                "agentAddr": "10.1.0.4", "enterprise": "1.3.6.1.4.1.28776.1",
                "genericTrap": 3, "specificTrap": 0,
                "deviceId": device_id, "varBinds": [],
            },
            headers=auth_headers,
        )

        # Alarm must be CLEAR within 5 seconds
        clear_resp = wait_for_api(
            http,
            f"{URLS['alarm']}/api/v1/alarms?deviceId={device_id}&state=CLEAR",
            headers=auth_headers, timeout=5.0,
        )
        assert clear_resp.status_code == 200
        alarms = clear_resp.json()
        assert len(alarms) > 0, "Alarm not cleared"
