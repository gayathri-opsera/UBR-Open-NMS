FROM python:3.11-slim
WORKDIR /app
COPY agent.py /app/agent.py
ENV SNMP_PORT=1168 \
    SNMP_COMMUNITY=public \
    DEVICE_NAME=srx300-fw-01 \
    DEVICE_IP=192.168.100.30
EXPOSE 1168/udp
CMD ["python", "/app/agent.py"]
