# EnGenius EOC655 SNMP Simulator  (SENAO-MIB / ENGENIUS-MIB)
#
# Enterprise OID: 1.3.6.1.4.1.14125.123  (EnGenius Networks EOC655)
# sysObjectID:    1.3.6.1.4.1.14125.123.2.2  (ptmp = outdoor Point-to-MultiPoint)
#
# Build:
#   docker build -t senao-snmpsim ./test/snmpsim-senao
#
# Run (BTS, default):
#   docker run --rm -p 1165:1165/udp senao-snmpsim
#
# Run (CPE):
#   docker run --rm -e DEVICE_MODE=CPE -e SNMP_PORT=1165 -p 1165:1165/udp senao-snmpsim
#
# Quick SNMP test from host (requires net-snmp):
#   snmpget  -v2c -c public -p 1165 localhost 1.3.6.1.2.1.1.2.0
#   snmpwalk -v2c -c public -p 1165 localhost 1.3.6.1.4.1.14125.123

FROM python:3.11-slim

WORKDIR /app
COPY agent.py /app/agent.py

ENV SNMP_PORT=1165
ENV SNMP_COMMUNITY=public
ENV DEVICE_MODE=BTS
ENV DEVICE_NAME=ENB-BTS-01
ENV DEVICE_IP=192.168.100.50
ENV SSID=UBR-EOC655-SECTOR1

EXPOSE 1165/udp

CMD ["python", "/app/agent.py"]
