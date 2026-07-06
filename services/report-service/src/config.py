import os
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB_ALARMS = os.getenv("MONGO_DB_ALARMS", "ubrnms_alarms")
MONGO_DB_INVENTORY = os.getenv("MONGO_DB_INVENTORY", "ubrnms_inventory")
MONGO_DB_KPI = os.getenv("MONGO_DB_KPI", "ubrnms_kpi")
MONGO_DB_REPORTS = os.getenv("MONGO_DB_REPORTS", "ubrnms_reports")

PORT = int(os.getenv("PORT", 8091))

SMTP_HOST = os.getenv("SMTP_HOST", "localhost")
SMTP_PORT = int(os.getenv("SMTP_PORT", 25))
SMTP_FROM = os.getenv("SMTP_FROM", "noreply@ubrnms.local")

REPORT_TYPES = ["alarm-history", "kpi-summary", "inventory-summary", "top-alarms"]
MAX_EXPORT_ROWS = int(os.getenv("MAX_EXPORT_ROWS", 50000))
