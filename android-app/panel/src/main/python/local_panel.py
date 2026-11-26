"""Local adapter for the original dashboard endpoints. No network service is created."""

from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sqlite3
from threading import RLock
from urllib.parse import parse_qs

from dashboard_api import (
    export_workout_gpx, get_day_detail, get_metric_detail, get_overview, get_pro_insights,
    get_workout_detail_full, get_workouts_list,
)
from db import open_health_db, upsert_batch
from ecg import get_record, list_records
from health_import import (
    extract_daily_summary, extract_devices, extract_sleep_sessions, extract_vitals, extract_workouts,
)

# _import_lock serializes background import_snapshot / clear_database calls;
# _db_lock only wraps brief read queries, incremental base copy, and final os.replace.
_import_lock = RLock()
_db_lock = RLock()

_optional_tables = {
    "hihealth_device": "_id deviceName model manufacturer firmwareVersion",
    "hihealth_stat_day": "date stat_type value modified_time _id",
    "sample_sequence": "start_time end_time type_id sub_type_id meta_data data modified_time merged",
    "sample_session_core": "start_time end_time type_id merged",
    "sample_point_health": "type_id start_time value merged modified_time",
    "sample_point_health_stress": "type_id start_time value merged modified_time",
    "sample_point": "type_id start_time value merged",
}
_normalized_tables = {"daily_summary", "sleep_sessions", "workouts", "vitals_points"}
_source_modified_tables = (
    "hihealth_stat_day",
    "sample_point",
    "sample_point_health",
    "sample_point_health_stress",
    "sample_sequence",
    "sample_session",
    "sample_session_core",
)


def _get_max_source_modified_ms(con):
    max_ms = 0
    for tbl in _source_modified_tables:
        try:
            row = con.execute(f"SELECT MAX(modified_time) FROM {tbl};").fetchone()
            if row and row[0] is not None:
                max_ms = max(max_ms, int(row[0]))
        except sqlite3.OperationalError:
            continue
    return max_ms


def _prepare_incremental_base(database, temporary):
    """If a valid normalized DB exists, copy it as incremental base and return last_source_modified_ms."""
    with _db_lock:
        if not database.exists():
            return None
        try:
            with closing(open_health_db(database, readonly=True)) as existing:
                meta_row = existing.execute(
                    "SELECT value FROM sync_meta WHERE key = 'last_source_modified_ms';"
                ).fetchone()
                if not meta_row or not meta_row[0]:
                    return None
                last_mod = int(meta_row[0])
                if last_mod <= 0:
                    return None
                daily_cnt = existing.execute("SELECT COUNT(*) FROM daily_summary;").fetchone()[0]
                if daily_cnt <= 0:
                    return None
            shutil.copy2(database, temporary)
            return last_mod
        except (sqlite3.Error, ValueError, OSError):
            _remove_database(temporary)
            return None


def import_snapshot(
    source_path,
    database_path,
    offset_minutes,
    mode_label="本机导入",
    source_db_signature="",
    allow_incremental=True,
):
    """Validate, normalize (incrementally when possible), and atomically replace the local DB."""
    source, database = Path(source_path), Path(database_path)
    temporary = database.with_name("panel-import.sqlite")
    timezone = dt.timezone(dt.timedelta(minutes=int(offset_minutes)))
    now = dt.datetime.now(timezone)
    now_ms = int(now.timestamp() * 1000)

    with _import_lock:
        _remove_database(temporary)
        incremental = False
        daily_total = 0
        workouts_total = 0
        try:
            with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as source_db:
                source_db.row_factory = sqlite3.Row
                source_db.execute("PRAGMA trusted_schema=OFF")
                row = source_db.execute("PRAGMA quick_check(1)").fetchone()
                if not row or row[0] != "ok":
                    raise ValueError("数据库完整性检查失败，请选择完整快照")
                tables = {r[0] for r in source_db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if _normalized_tables <= tables:
                    with closing(sqlite3.connect(temporary)) as target:
                        source_db.backup(target)
                    meta = {
                        "last_synced_iso": now.isoformat(timespec="seconds"),
                        "last_mode": str(mode_label or "本机导入"),
                    }
                    if source_db_signature:
                        meta["source_db_signature"] = str(source_db_signature)
                    with closing(open_health_db(temporary)) as target:
                        upsert_batch(target, {"sync_meta": meta})
                        daily_total = target.execute("SELECT COUNT(*) FROM daily_summary;").fetchone()[0]
                        workouts_total = target.execute("SELECT COUNT(*) FROM workouts;").fetchone()[0]
                        _finalize(target)
                elif tables.intersection({"hihealth_stat_day", "sample_sequence", "sample_session_core", "sample_point_health"}):
                    for name, columns in _optional_tables.items():
                        if name not in tables:
                            empty = ", ".join(f"NULL AS {column}" for column in columns.split())
                            source_db.execute(f"CREATE TEMP VIEW {name} AS SELECT {empty} WHERE 0")

                    last_mod = _prepare_incremental_base(database, temporary) if allow_incremental else None
                    if last_mod is not None:
                        incremental = True
                        min_mod_ms = max(0, last_mod - 86400_000)
                        today_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
                        lb_default = today_dt - dt.timedelta(days=2)
                        lb_from_mod = dt.datetime.fromtimestamp(min_mod_ms / 1000.0, tz=timezone).replace(
                            hour=0, minute=0, second=0, microsecond=0
                        )
                        lb_dt = min(lb_default, lb_from_mod)
                        min_date_str = lb_dt.strftime("%Y-%m-%d")
                        window_start_ms = int(lb_dt.timestamp() * 1000)
                        hourly_start_ms = min(window_start_ms, min_mod_ms)
                    else:
                        min_date_str = None
                        window_start_ms = None
                        min_mod_ms = None
                        hourly_start_ms = None

                    max_mod_ms = _get_max_source_modified_ms(source_db)
                    meta = {
                        "last_synced_iso": now.isoformat(timespec="seconds"),
                        "last_mode": str(mode_label or "本机导入"),
                        "last_source_modified_ms": str(max_mod_ms),
                    }
                    if source_db_signature:
                        meta["source_db_signature"] = str(source_db_signature)

                    with closing(open_health_db(temporary)) as target:
                        workouts, workout_stats = extract_workouts(
                            source_db, timezone, now_ms, True, window_start_ms, min_mod_ms
                        )
                        upsert_batch(target, {"workouts": workouts})
                        upsert_batch(target, {
                            "daily_summary": extract_daily_summary(
                                source_db, timezone, now_ms, min_date_str, workout_stats
                            ),
                            "sleep_sessions": extract_sleep_sessions(
                                source_db, timezone, now_ms, window_start_ms
                            ),
                            "devices": extract_devices(source_db),
                            "sync_meta": meta,
                        })
                        vitals = extract_vitals(source_db, timezone, now_ms, min_mod_ms, hourly_start_ms)
                        upsert_batch(target, {"vitals_points": vitals})
                        temperature_days = sorted({point["date"] for point in vitals
                                                   if point["metric"] == "body_temperature"})
                        temperature_summary = []
                        for day in temperature_days:
                            points = [row[0] for row in target.execute(
                                "SELECT value FROM vitals_points WHERE metric='body_temperature' AND date=? ORDER BY ts_ms", (day,))]
                            if points:
                                temperature_summary.append({
                                    "date": day, "temp_min": min(points), "temp_max": max(points),
                                    "temp_avg": sum(points) / len(points), "temp_last": points[-1],
                                })
                        upsert_batch(target, {"daily_summary": temperature_summary, "synced_at_ms": now_ms})
                        daily_total = target.execute("SELECT COUNT(*) FROM daily_summary;").fetchone()[0]
                        workouts_total = target.execute("SELECT COUNT(*) FROM workouts;").fetchone()[0]
                        _finalize(target)
                else:
                    raise ValueError("未识别到华为运动健康或面板数据库")

            with _db_lock:
                os.replace(temporary, database)
        finally:
            _remove_database(temporary)

    return json.dumps(
        {"daily": int(daily_total), "workouts": int(workouts_total), "incremental": incremental},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def clear_database(database_path):
    with _import_lock:
        with _db_lock:
            _remove_database(Path(database_path))


def _finalize(connection):
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    connection.execute("PRAGMA journal_mode=DELETE")


def _remove_database(path):
    for suffix in ("", "-wal", "-shm", "-journal"):
        Path(str(path) + suffix).unlink(missing_ok=True)


def _reply(status, data, mime="application/json", filename=""):
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if mime == "application/json" else data
    return json.dumps([status, mime, filename, body], ensure_ascii=False, separators=(",", ":"))


def request(database, path, query):
    args = parse_qs(query)

    def arg(key, default=None):
        return args.get(key, [default])[0]

    try:
        with _db_lock:
            if path == "/api/v1/dashboard/overview":
                return _reply(200, get_overview(database, int(arg("days", "30"))))
            if path == "/api/v1/dashboard/insights":
                return _reply(200, get_pro_insights(database))
            if path == "/api/v1/dashboard/ecg.csv":
                record = get_record(database, int(arg("id", "0")))
                hz = record["sample_rate_hz"]
                samples = record["waveform_mv"]
                if not samples or not hz:
                    raise KeyError("ECG waveform")
                body = "time_s,voltage_mv\n" + "".join(
                    f"{i / hz:.6f},{sample:.3f}\n" for i, sample in enumerate(samples))
                return _reply(200, body, "text/csv")
            if path == "/api/v1/dashboard/ecg":
                record_id = arg("id")
                if record_id is not None:
                    return _reply(200, get_record(database, int(record_id)))
                return _reply(200, list_records(database, include_preview=True))
            if path == "/api/v1/dashboard/metric":
                metric = arg("type", "")
                detail = get_metric_detail(database, metric, scope=arg("scope", "W"), end_date=arg("end"))
                if metric == "heart_rate":
                    detail["latest_ecg"] = next(iter(list_records(database, days=1, include_preview=True)["records"]), None)
                return _reply(200, detail)
            if path == "/api/v1/dashboard/day":
                return _reply(200, get_day_detail(database, date_str=arg("date")))
            if path == "/api/v1/dashboard/workouts":
                return _reply(200, get_workouts_list(database, sport=arg("sport", ""), limit=int(arg("limit", "150"))))
            if path == "/api/v1/dashboard/workout":
                return _reply(200, get_workout_detail_full(database, int(arg("id", "0")), max_points=int(arg("max_points", "400"))))
            if path == "/api/v1/dashboard/workout.gpx":
                xml, filename = export_workout_gpx(database, int(arg("id", "0")))
                return _reply(200, xml, "application/gpx+xml", filename)
            return _reply(404, {"error": "此离线接口不存在"})
    except (FileNotFoundError, KeyError):
        return _reply(404, {"error": "本机没有对应的记录"})
    except ValueError as error:
        return _reply(400, {"error": str(error)})
    except sqlite3.Error:
        return _reply(500, {"error": "无法读取本机数据库"})


def export_panel_database(source, destination):
    """Export a consistent SQLite copy using the same lock as database replacement."""
    with _db_lock, closing(open_health_db(source, readonly=True)) as original:
        with closing(sqlite3.connect(destination)) as target:
            original.backup(target)
            target.execute("PRAGMA journal_mode=DELETE").fetchall()



def verify_exported_sqlite(path):
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as con:
        if con.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("Invalid SQLite snapshot")


def mcp_read(database, tool, arguments):
    from mcp_tools import read
    with _db_lock:
        return json.dumps(read(database, tool, json.loads(arguments)), ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False)
