"""Centralised configuration loaded from environment variables."""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
    KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "config-push-worker")
    KAFKA_TOPIC_CONFIG_PUSH = os.getenv("KAFKA_TOPIC_CONFIG_PUSH", "config-push")
    KAFKA_TOPIC_DEVICE_CHECKIN = os.getenv("KAFKA_TOPIC_DEVICE_CHECKIN", "device-discovered")

    MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
    MONGO_DB = os.getenv("MONGO_DB", "ubrnms_config")

    NETCONF_PORT = int(os.getenv("NETCONF_PORT", "830"))
    SSH_PORT = int(os.getenv("SSH_PORT", "22"))
    TR069_PORT = int(os.getenv("TR069_PORT", "7547"))

    PUSH_TIMEOUT_S = int(os.getenv("PUSH_TIMEOUT_S", "30"))
    RETRY_ATTEMPTS = int(os.getenv("RETRY_ATTEMPTS", "3"))
    RETRY_BASE_DELAY_S = float(os.getenv("RETRY_BASE_DELAY_S", "5.0"))

    METRICS_PORT = int(os.getenv("METRICS_PORT", "9094"))

    DEVICE_USERNAME = os.getenv("DEVICE_USERNAME", "admin")
    DEVICE_PASSWORD = os.getenv("DEVICE_PASSWORD", "")
    NETCONF_KEY_FILE = os.getenv("NETCONF_KEY_FILE", "")
