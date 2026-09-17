#!/usr/bin/env python3
import base64
import pathlib
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEV = ROOT / "dev"

jwt_priv_b64 = base64.b64encode((DEV / "jwt_private.pem").read_bytes()).decode()
jwt_pub_b64 = base64.b64encode((DEV / "jwt_public.pem").read_bytes()).decode()

MONGO = "mongo.ubr-data:27017"
REDIS_HOST = "redis.ubr-data"
KAFKA = "kafka.ubr-data:9092"


def env(pairs):
    return [{"name": k, "value": str(v)} for k, v in pairs]


JAVA_PROBE = {"liveness": {"path": "/actuator/health"}, "readiness": {"path": "/actuator/health"}}

common_disable = {"autoscaling": {"enabled": False}, "replicaCount": 1, "networkPolicy": {"enabled": False}}

values = {
    "auth-service": {
        **common_disable,
        "containerPort": 3001,
        "env": env([
            ("NODE_ENV", "development"),
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("AUTH_PORT", "3001"),
            ("CORS_ORIGIN", "http://localhost:5173"),
            ("MAX_CONCURRENT_SESSIONS", "20"),
            ("JWT_PRIVATE_KEY", jwt_priv_b64),
            ("JWT_PUBLIC_KEY", jwt_pub_b64),
            ("LDAP_URL", "ldap://localhost:389"),
            ("LDAP_TLS_REJECT_UNAUTHORIZED", "false"),
        ]),
        "ingress": {"enabled": False},
    },
    "alarm-service": {
        **common_disable,
        "containerPort": 8083,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_alarms"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8083"),
        ]),
    },
    "inventory-service": {
        **common_disable,
        "containerPort": 8082,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_inventory"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8082"),
        ]),
    },
    "kpi-aggregation-service": {
        **common_disable,
        "containerPort": 8088,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_kpi"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8088"),
        ]),
    },
    "kpi-query-service": {
        **common_disable,
        "containerPort": 8089,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_kpi"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8089"),
        ]),
    },
    "diagnostics-service": {
        **common_disable,
        "containerPort": 8090,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_diagnostics"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8090"),
        ]),
    },
    "config-management-service": {
        **common_disable,
        "containerPort": 8084,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_config"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8084"),
        ]),
    },
    "topology-service": {
        **common_disable,
        "containerPort": 8086,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_topology"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8086"),
        ]),
    },
    "health-monitor": {
        **common_disable,
        "containerPort": 8092,
        "probes": JAVA_PROBE,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_health"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "8092"),
            ("PROMETHEUS_URL", "http://prometheus.ubr-monitoring:9090"),
            ("SPRING_APPLICATION_JSON", ""),
        ]),
    },
    "report-service": {
        **common_disable,
        "containerPort": 8091,
        "env": env([
            ("PORT", "8091"),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_reports"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
        ]),
    },
    "notification-service": {
        **common_disable,
        "containerPort": 3003,
        "env": env([
            ("NODE_ENV", "development"),
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_notifications"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "3003"),
            ("KAFKA_ENABLED", "true"),
        ]),
    },
    "audit-service": {
        **common_disable,
        "containerPort": 3007,
        "env": env([
            ("NODE_ENV", "development"),
            ("KAFKA_BROKERS", KAFKA),
            ("MONGO_URI", f"mongodb://{MONGO}/ubrnms_audit"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("LOG_LEVEL", "info"),
            ("PORT", "3007"),
            ("KAFKA_ENABLED", "true"),
        ]),
    },
    "event-collector": {
        **common_disable,
        "containerPort": 9090,
        "env": env([
            ("KAFKA_BROKERS", KAFKA),
            ("KAFKA_ENABLED", "true"),
            ("HTTP_PORT", "9090"),
            ("LOG_LEVEL", "info"),
        ]),
    },
    "discovery-service": {
        **common_disable,
        "containerPort": 8081,
        "env": env([
            ("PORT", "8081"),
            ("KAFKA_BROKERS", KAFKA),
            ("KAFKA_ENABLED", "true"),
            ("HMAC_SECRET", "dev-hmac-secret-change-in-prod"),
            ("LOG_LEVEL", "info"),
            ("SNMP_DEFAULT_COMMUNITY", "public"),
            ("SNMP_CONCURRENCY", "10"),
            ("SNMP_PORT", "1161"),
            ("ICMP_PING_TIMEOUT_MS", "2000"),
            ("ICMP_PING_RETRIES", "1"),
            ("INVENTORY_SERVICE_URL", "http://ubrnms-inventory-service"),
        ]),
    },
    "api-gateway": {
        **common_disable,
        "containerPort": 3000,
        "env": env([
            ("NODE_ENV", "development"),
            ("LOG_LEVEL", "info"),
            ("PORT", "3000"),
            ("REDIS_HOST", REDIS_HOST),
            ("REDIS_PORT", "6379"),
            ("JWT_PUBLIC_KEY", jwt_pub_b64),
            ("JWT_ISSUER", "ubr-nms"),
            ("JWT_AUDIENCE", "ubr-nms-api"),
            ("CORS_ORIGIN", "http://localhost:5173"),
            ("AUTH_SERVICE_URL", "http://ubrnms-auth-service.ubr-platform"),
            ("INVENTORY_SERVICE_URL", "http://ubrnms-inventory-service.ubr-platform"),
            ("ALARM_SERVICE_URL", "http://ubrnms-alarm-service.ubr-platform"),
            ("CONFIG_SERVICE_URL", "http://ubrnms-config-management-service.ubr-platform"),
            ("DISCOVERY_SERVICE_URL", "http://ubrnms-discovery-service.ubr-platform"),
            ("TOPOLOGY_SERVICE_URL", "http://ubrnms-topology-service.ubr-platform"),
            ("AUDIT_SERVICE_URL", "http://ubrnms-audit-service.ubr-platform"),
            ("NOTIFICATION_SERVICE_URL", "http://ubrnms-notification-service.ubr-platform"),
            ("KPI_SERVICE_URL", "http://ubrnms-kpi-query-service.ubr-platform"),
            ("REPORT_SERVICE_URL", "http://ubrnms-report-service.ubr-platform"),
            ("DIAGNOSTICS_SERVICE_URL", "http://ubrnms-diagnostics-service.ubr-platform"),
            ("EVENT_COLLECTOR_URL", "http://ubrnms-event-collector.ubr-platform"),
        ]),
        "ingress": {"enabled": False},
    },
    "kpi-collector": {
        "replicaCount": 0,
        "autoscaling": {"enabled": False},
        "networkPolicy": {"enabled": False},
    },
    "frontend": {
        "replicaCount": 1,
        "autoscaling": {"enabled": False},
        "networkPolicy": {"enabled": False},
        "env": env([
            ("API_GATEWAY_UPSTREAM", "ubrnms-api-gateway.ubr-ingress"),
        ]),
    },
}

out_path = pathlib.Path(__file__).resolve().parent / "values-kind.yaml"
with out_path.open("w") as f:
    yaml.dump(values, f, default_flow_style=False, sort_keys=False)

print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")
