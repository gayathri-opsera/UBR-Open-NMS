# Ubiquiti AirMax RADIO SNMP Simulator
#
# Pure-Python SNMPv1/v2c agent simulating a Ubiquiti AirMax AC backhaul radio.
# Enterprise OID: .1.3.6.1.4.1.41112  (Ubiquiti Networks)
# sysObjectID:    .1.3.6.1.4.1.41112.1.6
#
# The UBR NMS classifyByOid maps this prefix to:
#   vendor=Ubiquiti  model=AirMax AC  genericDeviceType=RADIO
#   productDefinitionId=ubiquiti-airmax-radio
#
# Build: docker build -t ubr-radio-snmpsim ./test/snmpsim-radio
# Run:   docker run -e SNMP_PORT=1164 -p 1164:1164/udp ubr-radio-snmpsim

FROM python:3.11-slim

WORKDIR /app
COPY agent.py /app/agent.py

ENV SNMP_PORT=1164
ENV SNMP_COMMUNITY=public
ENV DEVICE_NAME=UBR-RADIO-01
ENV DEVICE_IP=192.168.100.20
ENV DEFAULT_LAT=17.3850
ENV DEFAULT_LON=78.4867

EXPOSE 1164/udp

CMD ["python", "/app/agent.py"]
