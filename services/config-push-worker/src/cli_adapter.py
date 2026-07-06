"""SSH/CLI push adapter using Paramiko."""
import asyncio
import logging
from typing import Any

log = logging.getLogger(__name__)

try:
    import paramiko  # type: ignore
    PARAMIKO_AVAILABLE = True
except ImportError:
    PARAMIKO_AVAILABLE = False


def _params_to_cli_commands(params: dict[str, Any]) -> list[str]:
    """Convert a flat params dict to vendor-neutral CLI commands."""
    commands = []
    if params.get("ssid24"):
        commands.append(f"set wifi 2.4 ssid {params['ssid24']}")
    if params.get("ssid5"):
        commands.append(f"set wifi 5 ssid {params['ssid5']}")
    if params.get("channel24"):
        commands.append(f"set wifi 2.4 channel {params['channel24']}")
    if params.get("txPower24"):
        commands.append(f"set wifi 2.4 tx-power {params['txPower24']}")
    if params.get("vlanId"):
        commands.append(f"set vlan {params['vlanId']}")
    if params.get("deviceReboot"):
        commands.append("reboot")
    # Additional params pass-through
    for k, v in params.items():
        if k not in {"ssid24", "ssid5", "channel24", "txPower24", "vlanId", "deviceReboot"}:
            commands.append(f"set {k} {v}")
    return commands


async def cli_push(host: str, port: int, username: str, password: str,
                   params: dict[str, Any], timeout: int) -> None:
    """Push configuration to a device via SSH/CLI."""
    commands = _params_to_cli_commands(params)
    if not PARAMIKO_AVAILABLE:
        raise RuntimeError("paramiko not installed")

    def _sync_push():
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(host, port=port, username=username, password=password, timeout=timeout)
        try:
            chan = client.invoke_shell()
            for cmd in commands:
                chan.send(cmd + "\n")
                asyncio.sleep(0.2)
        finally:
            client.close()

    await asyncio.wait_for(
        asyncio.get_event_loop().run_in_executor(None, _sync_push),
        timeout=timeout,
    )
    log.info("CLI push succeeded for %s (%d commands)", host, len(commands))
