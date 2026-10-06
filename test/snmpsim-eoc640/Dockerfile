# EOC640 Wireless Backhaul Unit — SNMP Simulator
#
# sysObjectID:     .1.3.6.1.4.1.26928.1.640
# sysDescrPattern: EOC640.*
# productDefinitionId: eoc-eoc640-wireless-backhaul-unit
#
# Build: docker build -t nms-eoc640-snmpsim ./test/snmpsim-eoc640
# Run (BTS): docker run -e DEVICE_MODE=BTS -p 1164:1164/udp nms-eoc640-snmpsim
# Run (CPE): docker run -e DEVICE_MODE=CPE -e SNMP_PORT=1165 -p 1165:1165/udp nms-eoc640-snmpsim

FROM python:3.11-slim

WORKDIR /app
COPY agent.py /app/agent.py

ENV SNMP_PORT=1164
ENV SNMP_COMMUNITY=public
ENV DEVICE_MODE=BTS
ENV DEVICE_NAME=EOC640-BTS-01
ENV DEVICE_IP=192.168.100.20
ENV DEVICE_SERIAL=EOC640-BTS-SN-001

EXPOSE 1164/udp

CMD ["python", "/app/agent.py"]
