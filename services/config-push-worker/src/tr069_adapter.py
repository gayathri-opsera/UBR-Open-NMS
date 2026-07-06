"""TR-069/CWMP adapter for CPE device configuration."""
import logging
from typing import Any
from xml.etree import ElementTree as ET

log = logging.getLogger(__name__)

CWMP_NS = "urn:dslforum-org:cwmp-1-0"

TR069_PARAM_MAP = {
    "ssid24": "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID",
    "ssid5":  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID",
    "password24": "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase",
    "password5":  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase",
    "channel24": "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel",
    "channel5":  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel",
    "txPower24": "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TransmitPower",
    "staticIp":  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress",
    "vlanId":    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.X_VendorName_VLAN",
}


def build_set_parameter_values_rpc(params: dict[str, Any]) -> str:
    """Build a CWMP SetParameterValues SOAP message for the given params."""
    param_list = []
    for key, value in params.items():
        if key in TR069_PARAM_MAP and value is not None:
            param_list.append((TR069_PARAM_MAP[key], str(value)))

    soap = ET.Element("SOAP-ENV:Envelope")
    soap.set("xmlns:SOAP-ENV", "http://schemas.xmlsoap.org/soap/envelope/")
    soap.set("xmlns:SOAP-ENC", "http://schemas.xmlsoap.org/soap/encoding/")
    soap.set("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")
    soap.set("xmlns:xsd", "http://www.w3.org/2001/XMLSchema")
    soap.set("xmlns:cwmp", CWMP_NS)
    body = ET.SubElement(soap, "SOAP-ENV:Body")
    spv = ET.SubElement(body, "cwmp:SetParameterValues")
    pl = ET.SubElement(spv, "ParameterList")
    pl.set("SOAP-ENC:arrayType", f"cwmp:ParameterValueStruct[{len(param_list)}]")

    for name, value in param_list:
        pvs = ET.SubElement(pl, "ParameterValueStruct")
        ET.SubElement(pvs, "Name").text = name
        v_el = ET.SubElement(pvs, "Value")
        v_el.set("xsi:type", "xsd:string")
        v_el.text = value

    return ET.tostring(soap, encoding="unicode")


async def tr069_push(host: str, port: int, params: dict[str, Any], timeout: int) -> None:
    """Send a TR-069 SetParameterValues RPC to a CPE device."""
    try:
        import aiohttp  # noqa: PLC0415
    except ImportError:
        raise RuntimeError("aiohttp not installed")

    soap_body = build_set_parameter_values_rpc(params)
    url = f"http://{host}:{port}/cwmp"

    import aiohttp as _aiohttp
    async with _aiohttp.ClientSession() as session:
        async with session.post(
            url, data=soap_body,
            headers={"Content-Type": "text/xml; charset=utf-8",
                     "SOAPAction": f'"{CWMP_NS}#SetParameterValues"'},
            timeout=_aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            if resp.status not in (200, 204):
                raise RuntimeError(f"TR-069 push failed: HTTP {resp.status}")
    log.info("TR-069 push succeeded for %s", host)
