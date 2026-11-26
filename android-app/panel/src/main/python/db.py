"""Normalized SQLite storage and UPSERT/query helpers for Huawei Health MCP."""

from __future__ import annotations

import base64
import sqlite3
from pathlib import Path
from typing import Any

HEALTH_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS daily_summary (
    date TEXT PRIMARY KEY,
    steps INTEGER,
    calories_kcal REAL,
    distance_m REAL,
    active_duration_s INTEGER,
    active_hours INTEGER,
    moderate_high_min INTEGER,
    step_goal INTEGER,
    calorie_goal_kcal REAL,
    basal_metabolism_kcal REAL,
    hr_rest REAL,
    hr_min REAL,
    hr_avg REAL,
    hr_max REAL,
    hr_last REAL,
    hrv_min REAL,
    hrv_avg REAL,
    hrv_max REAL,
    hrv_last REAL,
    spo2_min REAL,
    spo2_avg REAL,
    spo2_max REAL,
    spo2_last REAL,
    stress_min REAL,
    stress_avg REAL,
    stress_max REAL,
    stress_last REAL,
    stress_count INTEGER,
    emotion_total_count INTEGER,
    emotion_peace_count INTEGER,
    emotion_pleasant_count INTEGER,
    emotion_unpleasant_count INTEGER,
    sleep_score REAL,
    sleep_total_min REAL,
    sleep_deep_min REAL,
    sleep_light_min REAL,
    sleep_rem_min REAL,
    sleep_awake_min REAL,
    sleep_nap_min REAL,
    sleep_efficiency REAL,
    sleep_latency_min REAL,
    sleep_fall_asleep_iso TEXT,
    sleep_wakeup_iso TEXT,
    sleep_bed_iso TEXT,
    sleep_rising_iso TEXT,
    sleep_avg_hr REAL,
    sleep_avg_hrv REAL,
    sleep_avg_spo2 REAL,
    sleep_avg_breath_rate REAL,
    sleep_snore_freq REAL,
    vo2max REAL,
    training_load REAL,
    running_index REAL,
    temp_min REAL,
    temp_avg REAL,
    temp_max REAL,
    temp_last REAL,
    skin_temp_baseline_delta REAL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sleep_sessions (
    start_ms INTEGER PRIMARY KEY,
    end_ms INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    session_type TEXT NOT NULL,
    total_sleep_min REAL NOT NULL,
    deep_min REAL NOT NULL,
    light_min REAL NOT NULL,
    rem_min REAL NOT NULL,
    awake_min REAL NOT NULL,
    nap_min REAL NOT NULL,
    sleep_score REAL,
    sleep_latency_min REAL,
    avg_hr REAL,
    avg_hrv REAL,
    avg_breath_rate REAL,
    snore_freq REAL,
    deep_part_score REAL,
    baselines_json TEXT,
    stages_json TEXT,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sleep_date ON sleep_sessions(date);

CREATE TABLE IF NOT EXISTS vitals_points (
    metric TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    date TEXT NOT NULL,
    ts_iso TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (metric, ts_ms)
);
CREATE INDEX IF NOT EXISTS idx_vitals_date_metric ON vitals_points(date, metric);
CREATE INDEX IF NOT EXISTS idx_vitals_metric_ts ON vitals_points(metric, ts_ms);

CREATE TABLE IF NOT EXISTS workouts (
    start_ms INTEGER PRIMARY KEY,
    end_ms INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    duration_s REAL NOT NULL,
    sport_type_id INTEGER,
    sport_name TEXT NOT NULL,
    distance_m REAL,
    calories_kcal REAL,
    steps INTEGER,
    hr_min INTEGER,
    hr_avg REAL,
    hr_max INTEGER,
    pace_avg_s_per_km REAL,
    pace_best_s_per_km REAL,
    cadence_avg_spm REAL,
    cadence_best_spm REAL,
    elevation_gain_m REAL,
    elevation_loss_m REAL,
    max_alti_m REAL,
    min_alti_m REAL,
    avg_gct_ms REAL,
    has_gps INTEGER NOT NULL DEFAULT 0,
    gps_point_count INTEGER NOT NULL DEFAULT 0,
    splits_json TEXT,
    running_dynamics_json TEXT,
    track_points_gz BLOB,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    device_name TEXT,
    model TEXT,
    manufacturer TEXT,
    firmware_version TEXT
);

CREATE TABLE IF NOT EXISTS ecg_records (
    start_ms INTEGER PRIMARY KEY,
    end_ms INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_iso TEXT NOT NULL,
    classification TEXT NOT NULL,
    classification_code INTEGER,
    avg_hr REAL,
    sample_rate_hz REAL,
    duration_s REAL,
    lead_count INTEGER NOT NULL DEFAULT 1,
    symptoms_json TEXT,
    meta_json TEXT,
    device_name TEXT,
    waveform_gz BLOB,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ecg_date ON ecg_records(date);

CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DAILY_COLS = [
    "date", "steps", "calories_kcal", "distance_m", "active_duration_s",
    "active_hours", "moderate_high_min", "step_goal", "calorie_goal_kcal",
    "basal_metabolism_kcal", "hr_rest", "hr_min", "hr_avg", "hr_max",
    "hr_last", "hrv_min", "hrv_avg", "hrv_max", "hrv_last", "spo2_min",
    "spo2_avg", "spo2_max", "spo2_last", "stress_min", "stress_avg",
    "stress_max", "stress_last", "stress_count", "emotion_total_count",
    "emotion_peace_count", "emotion_pleasant_count", "emotion_unpleasant_count",
    "sleep_score", "sleep_total_min", "sleep_deep_min", "sleep_light_min",
    "sleep_rem_min", "sleep_awake_min", "sleep_nap_min", "sleep_efficiency",
    "sleep_latency_min", "sleep_fall_asleep_iso", "sleep_wakeup_iso",
    "sleep_bed_iso", "sleep_rising_iso", "sleep_avg_hr", "sleep_avg_hrv",
    "sleep_avg_spo2", "sleep_avg_breath_rate", "sleep_snore_freq",
    "vo2max", "training_load", "running_index",
    "temp_min", "temp_avg", "temp_max", "temp_last", "skin_temp_baseline_delta",
    "updated_at_ms",
]

ECG_COLS = [
    "start_ms", "end_ms", "date", "start_iso", "classification", "classification_code",
    "avg_hr", "sample_rate_hz", "duration_s", "lead_count", "symptoms_json", "meta_json",
    "device_name", "waveform_gz", "updated_at_ms",
]

SLEEP_COLS = [
    "start_ms", "end_ms", "date", "start_iso", "end_iso", "session_type",
    "total_sleep_min", "deep_min", "light_min", "rem_min", "awake_min",
    "nap_min", "sleep_score", "sleep_latency_min", "avg_hr", "avg_hrv",
    "avg_breath_rate", "snore_freq", "deep_part_score", "baselines_json",
    "stages_json", "updated_at_ms",
]

VITALS_COLS = ["metric", "ts_ms", "date", "ts_iso", "value", "unit", "updated_at_ms"]

WORKOUT_COLS = [
    "start_ms", "end_ms", "date", "start_iso", "end_iso", "duration_s",
    "sport_type_id", "sport_name", "distance_m", "calories_kcal", "steps",
    "hr_min", "hr_avg", "hr_max", "pace_avg_s_per_km", "pace_best_s_per_km",
    "cadence_avg_spm", "cadence_best_spm", "elevation_gain_m",
    "elevation_loss_m", "max_alti_m", "min_alti_m", "avg_gct_ms", "has_gps",
    "gps_point_count", "splits_json", "running_dynamics_json",
    "track_points_gz", "updated_at_ms",
]


def _configure_connection(con: sqlite3.Connection, readonly: bool = False) -> sqlite3.Connection:
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = 5000;")
    if not readonly:
        con.execute("PRAGMA journal_mode = WAL;")
        con.execute("PRAGMA synchronous = NORMAL;")
    return con


def _migrate_schema(con: sqlite3.Connection) -> None:
    """Safely add newly introduced nullable columns on existing health databases."""
    existing = {r[1] for r in con.execute("PRAGMA table_info(daily_summary);").fetchall()}
    for col in ("vo2max", "training_load", "running_index", "temp_min", "temp_avg", "temp_max",
                "temp_last", "skin_temp_baseline_delta"):
        if col not in existing:
            con.execute(f"ALTER TABLE daily_summary ADD COLUMN {col} REAL;")
    con.commit()


def open_health_db(db_path: str | Path, readonly: bool = False) -> sqlite3.Connection:
    """Open health SQLite database; initialize schema if writable."""
    path = Path(db_path)
    if readonly:
        if not path.exists():
            raise FileNotFoundError(f"Health database not found: {path}")
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
        return _configure_connection(con, readonly=True)

    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), check_same_thread=False)
    _configure_connection(con, readonly=False)
    con.executescript(HEALTH_SCHEMA_SQL)
    _migrate_schema(con)
    return con


def _build_upsert_sql(table: str, cols: list[str], pk_cols: list[str], coalesce_cols: set[str] | None = None) -> str:
    placeholders = ",".join("?" for _ in cols)
    col_list = ",".join(cols)
    conflict_target = ",".join(pk_cols)
    coalesce_cols = coalesce_cols or set()
    updates = []
    for c in cols:
        if c in pk_cols:
            continue
        if c in coalesce_cols:
            updates.append(f"{c} = COALESCE(excluded.{c}, {table}.{c})")
        else:
            updates.append(f"{c} = excluded.{c}")
    return (
        f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT({conflict_target}) DO UPDATE SET {', '.join(updates)};"
    )


def upsert_batch(con: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, int]:
    """Idempotently upsert a sync payload into normalized tables in one transaction."""
    counts = {
        "daily_summary": 0,
        "sleep_sessions": 0,
        "vitals_points": 0,
        "workouts": 0,
        "devices": 0,
    }
    now_ms = int(payload.get("synced_at_ms") or 0)

    with con:
        daily_rows = payload.get("daily_summary") or []
        if daily_rows:
            # Preserve existing non-null columns when partial updates arrive
            sql = _build_upsert_sql("daily_summary", DAILY_COLS, ["date"], coalesce_cols=set(DAILY_COLS) - {"date", "updated_at_ms"})
            vals = [tuple(row.get(c, now_ms if c == "updated_at_ms" else None) for c in DAILY_COLS) for row in daily_rows]
            con.executemany(sql, vals)
            counts["daily_summary"] = len(vals)

        sleep_rows = payload.get("sleep_sessions") or []
        if sleep_rows:
            sql = _build_upsert_sql("sleep_sessions", SLEEP_COLS, ["start_ms"], coalesce_cols={"sleep_score", "sleep_latency_min", "avg_hr", "avg_hrv", "avg_breath_rate", "snore_freq", "deep_part_score", "baselines_json"})
            vals = [tuple(row.get(c, now_ms if c == "updated_at_ms" else None) for c in SLEEP_COLS) for row in sleep_rows]
            con.executemany(sql, vals)
            counts["sleep_sessions"] = len(vals)

        vitals_rows = payload.get("vitals_points") or []
        if vitals_rows:
            sql = _build_upsert_sql("vitals_points", VITALS_COLS, ["metric", "ts_ms"])
            vals = [tuple(row.get(c, now_ms if c == "updated_at_ms" else None) for c in VITALS_COLS) for row in vitals_rows]
            con.executemany(sql, vals)
            counts["vitals_points"] = len(vals)

        ecg_rows = payload.get("ecg_records") or []
        if ecg_rows:
            sql = _build_upsert_sql("ecg_records", ECG_COLS, ["start_ms"])
            defaults = {"updated_at_ms": now_ms, "lead_count": 1}
            vals = [tuple(row.get(c, defaults.get(c)) for c in ECG_COLS) for row in ecg_rows]
            con.executemany(sql, vals)
            counts["ecg_records"] = len(vals)

        workout_rows = payload.get("workouts") or []
        if workout_rows:
            sql = _build_upsert_sql("workouts", WORKOUT_COLS, ["start_ms"])
            vals = []
            for row in workout_rows:
                row_copy = dict(row)
                b64 = row_copy.pop("track_points_gz_b64", None)
                if b64 and not row_copy.get("track_points_gz"):
                    row_copy["track_points_gz"] = base64.b64decode(b64)
                vals.append(tuple(row_copy.get(c, now_ms if c == "updated_at_ms" else None) for c in WORKOUT_COLS))
            con.executemany(sql, vals)
            counts["workouts"] = len(vals)

        device_rows = payload.get("devices") or []
        if device_rows:
            sql = _build_upsert_sql("devices", ["id", "device_name", "model", "manufacturer", "firmware_version"], ["id"])
            vals = [
                (
                    d.get("id"),
                    d.get("device_name"),
                    d.get("model"),
                    d.get("manufacturer"),
                    d.get("firmware_version"),
                )
                for d in device_rows
            ]
            con.executemany(sql, vals)
            counts["devices"] = len(vals)

        meta = payload.get("sync_meta") or {}
        if isinstance(meta, dict) and meta:
            con.executemany(
                "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                [(str(k), str(v)) for k, v in meta.items()],
            )

    return counts


def get_db_status(db_path: str | Path) -> dict[str, Any]:
    """Return non-sensitive health DB table counts, date coverage, and file size."""
    path = Path(db_path)
    if not path.exists():
        return {"exists": False}

    con = open_health_db(path, readonly=True)
    try:
        counts = {}
        for tbl in ("daily_summary", "sleep_sessions", "vitals_points", "workouts", "devices"):
            counts[tbl] = con.execute(f"SELECT COUNT(*) FROM {tbl};").fetchone()[0]

        date_range = con.execute("SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM daily_summary;").fetchone()
        vitals_range = con.execute("SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM vitals_points;").fetchone()
        meta = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM sync_meta;")}
        devices = [dict(r) for r in con.execute("SELECT id, device_name, model, manufacturer, firmware_version FROM devices ORDER BY id;")]
    finally:
        con.close()

    return {
        "exists": True,
        "db_size_bytes": path.stat().st_size,
        "db_size_mb": round(path.stat().st_size / (1024 * 1024), 2),
        "counts": counts,
        "daily_date_range": {"min": date_range["min_d"], "max": date_range["max_d"]},
        "vitals_date_range": {"min": vitals_range["min_d"], "max": vitals_range["max_d"]},
        "devices": devices,
        "sync_meta": meta,
    }
