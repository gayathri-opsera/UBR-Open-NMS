"""Report query builders for MongoDB collections."""
from datetime import datetime
from typing import Optional


def alarm_history_query(scope: dict, from_dt: datetime, to_dt: datetime) -> dict:
    """Build MongoDB query for alarm history report."""
    query: dict = {
        "raisedAt": {"$gte": from_dt, "$lte": to_dt},
    }
    if org := scope.get("organizationId"):
        query["organizationId"] = org
    if hier := scope.get("hierarchyId"):
        query["hierarchyId"] = hier
    if net := scope.get("networkId"):
        query["networkId"] = net
    return query


def kpi_summary_query(scope: dict, from_dt: datetime, to_dt: datetime,
                       granularity: str = "1HOUR") -> dict:
    """Build MongoDB query for KPI warm storage."""
    query: dict = {
        "bucketStart": {"$gte": from_dt, "$lte": to_dt},
        "granularity": granularity,
    }
    if org := scope.get("organizationId"):
        query["organizationId"] = org
    if hier := scope.get("hierarchyId"):
        query["hierarchyId"] = hier
    if net := scope.get("networkId"):
        query["networkId"] = net
    return query


def inventory_query(scope: dict) -> dict:
    """Build MongoDB query for inventory summary."""
    query: dict = {}
    if org := scope.get("organizationId"):
        query["organizationId"] = org
    if hier := scope.get("hierarchyId"):
        query["hierarchyId"] = hier
    if net := scope.get("networkId"):
        query["networkId"] = net
    return query


def top_alarms_query(scope: dict, from_dt: datetime, to_dt: datetime) -> list:
    """Build MongoDB aggregation pipeline for top-alarm analytics."""
    match_stage: dict = {
        "$match": alarm_history_query(scope, from_dt, to_dt)
    }
    return [
        match_stage,
        {"$group": {
            "_id": {"alarmType": "$alarmType", "severity": "$severity"},
            "count": {"$sum": 1},
            "affectedDevices": {"$addToSet": "$deviceId"},
        }},
        {"$sort": {"count": -1}},
        {"$limit": 100},
    ]
