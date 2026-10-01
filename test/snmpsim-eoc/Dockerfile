# EOC Configurations_GUI SNMP Simulator
#
# Pure-Python SNMPv1/v2c agent simulating an EOC A60 (BTS) or A61 (CPE).
# Enterprise OID: .1.3.6.1.4.1.52619  (52619 = EOC Networks)
# sysObjectID:    .1.3.6.1.4.1.52619.1.1
#
# The UBR NMS classifyByOid maps this prefix to:
#   vendor=EOC  model=Configurations_GUI  genericDeviceType=RADIO
#   productDefinitionId=Configurations_GUI
#
# Build: docker build -t eoc-snmpsim ./test/snmpsim-eoc
# Run (BTS): docker run -e DEVICE_MODE=BTS -e DEVICE_NAME=EOC-BTS-01 \
#              -p 1162:1162/udp eoc-snmpsim
# Run (CPE): docker run -e DEVICE_MODE=CPE -e DEVICE_NAME=EOC-CPE-01 \
#              -e SNMP_PORT=1163 -p 1163:1163/udp eoc-snmpsim

FROM python:3.11-slim

WORKDIR /app
COPY agent.py /app/agent.py

# Default: BTS on port 1162
ENV SNMP_PORT=1162
ENV SNMP_COMMUNITY=public
ENV DEVICE_MODE=BTS
ENV DEVICE_NAME=EOC-BTS-01
ENV DEVICE_IP=192.168.100.10

EXPOSE 1162/udp

CMD ["python", "/app/agent.py"]
