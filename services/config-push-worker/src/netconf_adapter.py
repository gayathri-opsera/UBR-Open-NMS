"""NETCONF push adapter using ncclient (mocked in tests)."""
import asyncio
import logging
from typing import Any

log = logging.getLogger(__name__)

# ncclient is imported lazily so that tests don't require it installed
try:
    from ncclient import manager as nc_manager  # type: ignore
    NCCLIENT_AVAILABLE = True
except ImportError:
    NCCLIENT_AVAILABLE = False


def _build_netconf_xml(params: dict[str, Any]) -> str:
    """Convert flat params dict to a basic NETCONF <config> edit fragment."""
    elements = "\n".join(
        f"    <{k}>{v}</{k}>" for k, v in params.items() if v is not None
    )
    return f"""<config>
  <device-config xmlns="urn:ubr:nms:config">
{elements}
  </device-config>
</config>"""


async def netconf_push(host: str, port: int, username: str, password: str,
                        key_file: str, params: dict[str, Any], timeout: int) -> None:
    """Push configuration to a device via NETCONF."""
    xml = _build_netconf_xml(params)
    if not NCCLIENT_AVAILABLE:
        raise RuntimeError("ncclient not installed")

    def _sync_push():
        with nc_manager.connect(
            host=host, port=port, username=username, password=password or None,
            key_filename=key_file or None,
            hostkey_verify=False,
            timeout=timeout,
        ) as m:
            m.edit_config(target="running", config=xml)

    await asyncio.wait_for(
        asyncio.get_event_loop().run_in_executor(None, _sync_push),
        timeout=timeout,
    )
    log.info("NETCONF push succeeded for %s", host)
