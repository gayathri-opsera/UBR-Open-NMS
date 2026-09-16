# SNMP Test Agent — pure-Python BER SNMP responder for UBR NMS e2e testing.
#
# No external dependencies, no root needed. Listens on UDP 1161.
# Responds to MIB-II system group OIDs (.1.3.6.1.2.1.1.*) with Linux device data.
# Community string: "public"
#
# sysObjectID: .1.3.6.1.4.1.8072.3.2.10  ← Net-SNMP Linux x86_64
#   UBR NMS classifier → Vendor=Net-SNMP, Model=Linux, GenericDeviceType=SERVER
#
# Test from host (after docker compose up):
#   snmpget -v2c -c public -p 1161 localhost 1.3.6.1.2.1.1.5.0

FROM python:3.11-slim

COPY agent.py /app/agent.py

# UDP 1161 — non-privileged port, no root needed
EXPOSE 1161/udp

CMD ["python", "/app/agent.py"]
