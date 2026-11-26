"""Explicit, read-only MCP adapters for the panel database."""
from contextlib import closing
from datetime import date, timedelta

from dashboard_api import (
    get_day_detail, get_metric_detail, get_overview, get_pro_insights,
    get_workout_detail_full, get_workouts_list,
)
from db import open_health_db
from ecg import list_records


def integer(args, key, default, low, high):
    value = args.get(key, default)
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{key} is outside its allowed range")
    return value


def iso_date(args, key, required=False):
    value = args.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or len(value) != 10 or date.fromisoformat(value).isoformat() != value:
        raise ValueError(f"{key} must be a date in YYYY-MM-DD format")
    return value


def text(args, key, default=None):
    value = args.get(key, default)
    if not isinstance(value, str) or not value or len(value) > 100:
        raise ValueError(f"{key} must be a non-empty string")
    return value


def boolean(args, key):
    value = args.get(key, False)
    if type(value) is not bool:
        raise ValueError(f"{key} must be a boolean")
    return value


def range_dates(args, required=False):
    start = iso_date(args, "start_date", required)
    end = iso_date(args, "end_date", required)
    if start and end and (date.fromisoformat(end) - date.fromisoformat(start)).days not in range(3662):
        raise ValueError("Invalid date range (maximum 3661 days)")
    return start, end


def read(database, tool, args):
    if tool == "get_health_overview":
        result = get_overview(database, integer(args, "days", 30, 1, 365))
        result.pop("sync_status", None)
        return result
    if tool == "get_day_detail":
        return get_day_detail(database, iso_date(args, "date", True))
    if tool == "get_metric_detail":
        scope = text(args, "scope", "W")
        if scope not in {"D", "W", "M", "6M", "Y"}:
            raise ValueError("Invalid scope")
        return get_metric_detail(database, text(args, "metric"), scope, iso_date(args, "end_date"))
    if tool == "list_workouts":
        start, end = range_dates(args)
        sport = text(args, "sport") if args.get("sport") else ""
        return get_workouts_list(database, sport, integer(args, "limit", 30, 1, 500), start, end)
    if tool == "get_workout_detail":
        series = boolean(args, "include_series")
        result = get_workout_detail_full(
            database, integer(args, "workout_id", None, 1, 2**63 - 1), 400 if series else 20,
        )
        if not series:
            for key in ("gps_track", "hr_series", "cadence_series", "posture_series"):
                result.pop(key, None)
        return result
    if tool == "get_pro_insights":
        return get_pro_insights(database)
    if tool == "get_ecg_records":
        return list_records(database, integer(args, "days", 30, 1, 365), boolean(args, "include_waveform"))
    if tool not in {"get_daily_summary", "get_sleep_sessions"}:
        raise ValueError("Unknown tool")
    with closing(open_health_db(database, readonly=True)) as con:
        if tool == "get_daily_summary":
            start, end = range_dates(args, True)
            fields = args.get("fields")
            allowed = {row["name"] for row in con.execute("PRAGMA table_info(daily_summary)")}
            if fields is not None:
                if not isinstance(fields, list) or any(type(field) is not str or field not in allowed for field in fields):
                    raise ValueError("Invalid daily summary fields")
                names = dict.fromkeys(["date", *fields])
                columns = ", ".join('"' + name.replace('"', '""') + '"' for name in names)
            else:
                columns = "*"
            rows = con.execute(f"SELECT {columns} FROM daily_summary WHERE date BETWEEN ? AND ? ORDER BY date", (start, end))
            return {"daily_summary": [dict(row) for row in rows]}
        days = integer(args, "days", 14, 1, 365)
        latest = con.execute("SELECT max(date) FROM sleep_sessions").fetchone()[0]
        if latest is None:
            return {"sessions": []}
        start = (date.fromisoformat(latest) - timedelta(days=days - 1)).isoformat()
        rows = con.execute("SELECT * FROM sleep_sessions WHERE date >= ? ORDER BY start_ms DESC", (start,))
        return {"sessions": [dict(row) for row in rows]}
