"""Offline normalization of a user-provided, already decrypted Huawei Health snapshot."""
from __future__ import annotations

import base64
import bisect
import datetime
import gzip
import json
import sqlite3
from collections import defaultdict
from typing import Any

# Point metrics in sample_point_health (merged=0): type_id -> (metric_name, unit, round_digits)
SPH_METRICS: dict[int, tuple[str, str, int]] = {
    # HiHealthPointType.DATA_POINT_BODY_THERMOMETER, Huawei constant values.
    2104: ("body_temperature", "°C", 2),
    2002: ("heart_rate", "bpm", 1),
    2105: ("resting_hr", "bpm", 1),
    2103: ("spo2", "%", 1),
    2200: ("ppg_irregular_hb", "flag", 1),
    500002847: ("osa_level", "level", 1),
    500031195: ("emotion_status", "level", 1),
    500031347: ("emotion_valence", "score", 3),
    500031842: ("emotion_arousal", "score", 3),
    500044831: ("hrv_rmssd", "ms", 1),
}

# Hourly aggregated metrics in sample_point (merged=0): type_id -> (metric_name, unit, scale, round_digits)
HOURLY_METRICS: dict[int, tuple[str, str, float, int]] = {
    2: ("steps_hourly", "steps", 1.0, 1),
    4: ("calories_hourly", "kcal", 0.001, 2),
    7: ("intensity_hourly", "min", 1.0, 1),
}

# Sport type ID -> Chinese name matching server mcp_tools / workouts table
SPORT_NAMES: dict[int, str] = {
    140: "力量训练",
    210: "攀岩",
    257: "户外步行",
    258: "户外跑步",
    259: "户外骑行",
    260: "室内骑行",
    262: "泳池游泳",
    264: "室内跑步",
    265: "椭圆机",
    266: "开放水域游泳",
    273: "徒步",
    274: "登山",
    280: "越野跑",
    281: "划船机",
    282: "跳绳",
    283: "自由训练",
    10001: "HIIT",
}

SLEEP_STAGE_MAP: dict[int, str] = {
    22101: "light",
    22102: "rem",
    22103: "deep",
    22104: "awake",
    22105: "nap",
}

BASELINE_KEYS = (
    "minHeartrateBaseline",
    "maxHeartrateBaseline",
    "minHrvBaseline",
    "maxHrvBaseline",
    "minOxygenSaturationBaseline",
    "maxOxygenSaturationBaseline",
    "minBreathrateBaseline",
    "maxBreathrateBaseline",
)

def make_tz(offset_hours: int) -> datetime.timezone:
    return datetime.timezone(datetime.timedelta(hours=offset_hours))


def ms_to_dt(ms: int, tz: datetime.timezone) -> datetime.datetime:
    return datetime.datetime.fromtimestamp(ms / 1000.0, tz=tz)


def ms_to_iso(ms: int, tz: datetime.timezone) -> str:
    return ms_to_dt(ms, tz).strftime("%Y-%m-%dT%H:%M:%S%z")[:-2] + ":" + ms_to_dt(ms, tz).strftime("%z")[-2:]


def ms_to_date(ms: int, tz: datetime.timezone) -> str:
    return ms_to_dt(ms, tz).strftime("%Y-%m-%d")


def int_date_to_str(d_int: int) -> str:
    s = str(int(d_int))
    if len(s) != 8:
        return s
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def date_str_to_int(d_str: str) -> int:
    return int(d_str.replace("-", ""))


def _clean_float(val: Any, min_v: float = -1e6, max_v: float = 1e9) -> float | None:
    if val is None:
        return None
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    if f != f or abs(f) > max_v or f < min_v:
        return None
    if 0 < abs(f) < 1e-12:  # Java Float.MIN_VALUE sentinel
        return None
    return f


def _clean_alti(val: Any) -> float | None:
    f = _clean_float(val, min_v=-500.0, max_v=10000.0)
    if f is None:
        return None
    return round(f, 1)


def _decode_sequence_text(raw: Any) -> str:
    if not raw:
        return ""
    if isinstance(raw, str):
        raw_bytes = raw.encode("latin-1", errors="ignore")
    elif isinstance(raw, (bytes, bytearray)):
        raw_bytes = bytes(raw)
    else:
        return ""
    if raw_bytes.startswith(b"\x1f\x8b"):
        try:
            return gzip.decompress(raw_bytes).decode("utf-8", errors="replace")
        except Exception:
            return ""
    return raw_bytes.decode("utf-8", errors="replace")


def _parse_kv_line(line: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in line.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k] = v
    return out


def _nearest_series_val(
    ts_list: list[int],
    vals: list[float],
    target_ms: int,
    max_diff_ms: int = 10000,
) -> float | None:
    if not ts_list:
        return None
    idx = bisect.bisect_left(ts_list, target_ms)
    best_diff = max_diff_ms + 1
    best_val: float | None = None
    for cand in (idx - 1, idx):
        if 0 <= cand < len(ts_list):
            diff = abs(ts_list[cand] - target_ms)
            if diff < best_diff:
                best_diff = diff
                best_val = vals[cand]
    return best_val if best_diff <= max_diff_ms else None


def extract_devices(con: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT _id, deviceName, model, manufacturer, firmwareVersion "
        "FROM hihealth_device ORDER BY _id ASC;"
    ).fetchall()
    return [
        {
            "id": int(r["_id"]),
            "device_name": r["deviceName"],
            "model": r["model"],
            "manufacturer": r["manufacturer"],
            "firmware_version": r["firmwareVersion"],
        }
        for r in rows
    ]


def extract_vitals(
    con: sqlite3.Connection,
    tz: datetime.timezone,
    now_ms: int,
    min_mod_ms: int | None,
    hourly_start_ms: int | None,
) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []

    # 1. Point vitals from sample_point_health
    sph_sql = (
        "SELECT type_id, start_time, value FROM sample_point_health "
        f"WHERE merged = 0 AND type_id IN ({','.join(str(k) for k in SPH_METRICS)})"
    )
    sph_params: list[Any] = []
    if min_mod_ms is not None:
        sph_sql += " AND modified_time >= ?"
        sph_params.append(min_mod_ms)
    if hourly_start_ms is not None and min_mod_ms is None:
        sph_sql += " AND start_time >= ?"
        sph_params.append(hourly_start_ms)

    for r in con.execute(sph_sql, sph_params):
        metric, unit, ndigits = SPH_METRICS[int(r["type_id"])]
        ts_ms = int(r["start_time"])
        val = _clean_float(r["value"])
        if val is None or (metric == "body_temperature" and not 25 <= val <= 45):
            continue
        points.append({
            "metric": metric,
            "ts_ms": ts_ms,
            "date": ms_to_date(ts_ms, tz),
            "ts_iso": ms_to_iso(ts_ms, tz),
            "value": round(val, ndigits),
            "unit": unit,
            "updated_at_ms": now_ms,
        })

    # 2. Stress from sample_point_health_stress
    str_sql = "SELECT start_time, value FROM sample_point_health_stress WHERE merged = 0 AND type_id = 2034"
    str_params: list[Any] = []
    if min_mod_ms is not None:
        str_sql += " AND modified_time >= ?"
        str_params.append(min_mod_ms)
    elif hourly_start_ms is not None:
        str_sql += " AND start_time >= ?"
        str_params.append(hourly_start_ms)

    for r in con.execute(str_sql, str_params):
        ts_ms = int(r["start_time"])
        val = _clean_float(r["value"])
        if val is None:
            continue
        points.append({
            "metric": "stress",
            "ts_ms": ts_ms,
            "date": ms_to_date(ts_ms, tz),
            "ts_iso": ms_to_iso(ts_ms, tz),
            "value": round(val, 1),
            "unit": "score",
            "updated_at_ms": now_ms,
        })

    # 3. Hourly aggregated metrics from sample_point (recompute complete hours)
    sp_sql = (
        "SELECT type_id, start_time, value FROM sample_point "
        f"WHERE merged = 0 AND type_id IN ({','.join(str(k) for k in HOURLY_METRICS)})"
    )
    sp_params: list[Any] = []
    if hourly_start_ms is not None:
        aligned_start = (hourly_start_ms // 3600000) * 3600000
        sp_sql += " AND start_time >= ?"
        sp_params.append(aligned_start)

    buckets: dict[tuple[int, int], float] = defaultdict(float)
    for r in con.execute(sp_sql, sp_params):
        tid = int(r["type_id"])
        val = _clean_float(r["value"])
        if val is None:
            continue
        hour_ms = (int(r["start_time"]) // 3600000) * 3600000
        buckets[(tid, hour_ms)] += val

    for (tid, hour_ms), raw_sum in sorted(buckets.items()):
        metric, unit, scale, ndigits = HOURLY_METRICS[tid]
        scaled = round(raw_sum * scale, ndigits)
        if scaled <= 0:
            continue
        points.append({
            "metric": metric,
            "ts_ms": hour_ms,
            "date": ms_to_date(hour_ms, tz),
            "ts_iso": ms_to_iso(hour_ms, tz),
            "value": scaled,
            "unit": unit,
            "updated_at_ms": now_ms,
        })

    return points


def _parse_workout_track(
    raw_text: str,
    start_ms: int,
    include_gps: bool,
) -> tuple[
    str | None,          # splits_json
    list[list[Any]],     # cadence_series
    int,                 # rp_samples_count
    list[list[Any]],     # posture_series
    bytes | None,        # track_points_gz_b64 (str actually)
    int,                 # has_gps
    int,                 # gps_point_count
]:
    if not raw_text:
        return None, [], 0, [], None, 0, 0

    splits: list[dict[str, str]] = []
    sr_pairs: list[tuple[int, int]] = []
    hr_pairs: list[tuple[int, int]] = []
    alti_pairs: list[tuple[int, float]] = []
    lbs_raw: list[tuple[int, float, float, float]] = []
    rp_count = 0
    posture_series: list[list[Any]] = []

    for line in raw_text.splitlines():
        if not line.startswith("tp="):
            continue
        kv = _parse_kv_line(line)
        tp = kv.get("tp")
        if tp == "sec":
            kv.pop("tp", None)
            if kv:
                splits.append(kv)
        elif tp == "s-r":
            try:
                ts_ms = int(float(kv["k"]))
                spm = int(float(kv["v"]))
                if spm > 0:
                    sr_pairs.append((ts_ms, spm))
            except (KeyError, ValueError):
                pass
        elif tp == "h-r":
            try:
                ts_ms = int(float(kv["k"]))
                hr = int(float(kv["v"]))
                if hr > 0:
                    hr_pairs.append((ts_ms, hr))
            except (KeyError, ValueError):
                pass
        elif tp == "alti":
            try:
                ts_ms = int(float(kv["k"]))
                alt = _clean_alti(kv["v"])
                if alt is not None:
                    alti_pairs.append((ts_ms, alt))
            except (KeyError, ValueError):
                pass
        elif tp == "rp":
            rp_count += 1
            try:
                gct = int(float(kv.get("gct", 0)))
                if gct > 0:
                    el_s = round(float(kv["k"]), 1)
                    gtb = round(float(kv.get("gtb", 0.0)), 2)
                    vo = round(float(kv.get("vo", 0.0)), 2)
                    posture_series.append([el_s, gct, gtb, vo])
            except (KeyError, ValueError):
                pass
        elif tp == "lbs" and include_gps:
            try:
                lat = float(kv["lat"])
                lon = float(kv["lon"])
                # Filter Huawei's invalid pause/placeholder GPS coordinates (90.0, -80.0 / 0, 0)
                if abs(lat) >= 89.9 or abs(lon) > 180.0 or (lat == 0.0 and lon == 0.0):
                    continue
                t_sec = float(kv["t"])
                ts_ms = int(round(t_sec * 1000.0)) if t_sec < 1e11 else int(round(t_sec))
                alt_lbs = float(kv.get("alt", 0.0))
                lbs_raw.append((ts_ms, lat, lon, alt_lbs))
            except (KeyError, ValueError):
                pass

    sr_pairs.sort(key=lambda x: x[0])
    hr_pairs.sort(key=lambda x: x[0])
    alti_pairs.sort(key=lambda x: x[0])

    cadence_series = [
        [round((ts - start_ms) / 1000.0, 1), spm]
        for ts, spm in sr_pairs
    ]

    track_gz_b64: str | None = None
    has_gps = 0
    gps_count = 0
    if include_gps and lbs_raw:
        lbs_raw.sort(key=lambda x: x[0])
        alti_ts = [x[0] for x in alti_pairs]
        alti_vs = [x[1] for x in alti_pairs]
        hr_ts = [x[0] for x in hr_pairs]
        hr_vs = [float(x[1]) for x in hr_pairs]
        sr_ts = [x[0] for x in sr_pairs]
        sr_vs = [float(x[1]) for x in sr_pairs]

        pts: list[list[Any]] = []
        for ts_ms, lat, lon, alt_lbs in lbs_raw:
            alt = _nearest_series_val(alti_ts, alti_vs, ts_ms)
            if alt is None and alt_lbs != 0.0:
                alt = _clean_alti(alt_lbs)
            hr_v = _nearest_series_val(hr_ts, hr_vs, ts_ms)
            sr_v = _nearest_series_val(sr_ts, sr_vs, ts_ms)
            pts.append([
                ts_ms,
                round(lat, 6),
                round(lon, 6),
                round(alt, 1) if alt is not None else None,
                int(round(hr_v)) if hr_v is not None else None,
                int(round(sr_v)) if sr_v is not None else None,
            ])

        if pts:
            gz_bytes = gzip.compress(json.dumps(pts, separators=(",", ":")).encode("utf-8"))
            track_gz_b64 = base64.b64encode(gz_bytes).decode("ascii")
            has_gps = 1
            gps_count = len(pts)

    splits_json = json.dumps(splits, ensure_ascii=False) if splits else None
    return splits_json, cadence_series, rp_count, posture_series, track_gz_b64, has_gps, gps_count


def extract_workouts(
    con: sqlite3.Connection,
    tz: datetime.timezone,
    now_ms: int,
    include_gps: bool,
    window_start_ms: int | None,
    min_mod_ms: int | None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, float]]]:
    """Extract workouts (computing continuous EWMA running_index across all runs)."""
    rows = con.execute(
        "SELECT start_time, end_time, sub_type_id, meta_data, data, modified_time "
        "FROM sample_sequence WHERE type_id = 30001 AND merged = 0 "
        "ORDER BY start_time ASC;"
    ).fetchall()

    workouts_out: list[dict[str, Any]] = []
    daily_workout_stats: dict[str, dict[str, float]] = defaultdict(dict)
    ewma_rai: float | None = None

    for r in rows:
        start_ms = int(r["start_time"])
        end_ms = int(r["end_time"])
        sport_id = int(r["sub_type_id"] or 0)
        mod_ms = int(r["modified_time"] or 0)
        date_str = ms_to_date(start_ms, tz)

        try:
            md = json.loads(r["meta_data"] or "{}")
        except Exception:
            md = {}

        ext = md.get("mExtendTrackDataMap") or {}
        wear = md.get("wearSportData") or {}

        duration_s = round((float(md.get("totalTime") or (end_ms - start_ms))) / 1000.0, 1)
        dist_m = _clean_float(md.get("totalDistance"), min_v=0.0)
        cal_raw = _clean_float(md.get("totalCalories"), min_v=0.0)
        calories_kcal = round(cal_raw / 1000.0, 2) if cal_raw is not None else None
        steps = int(md["totalSteps"]) if md.get("totalSteps") is not None else None

        hr_min = int(md["minHeartRate"]) if md.get("minHeartRate") and int(md["minHeartRate"]) > 0 else None
        hr_avg = round(float(md["avgHeartRate"]), 1) if md.get("avgHeartRate") and float(md["avgHeartRate"]) > 0 else None
        hr_max = int(md["maxHeartRate"]) if md.get("maxHeartRate") and int(md["maxHeartRate"]) > 0 else None

        pace_avg = _clean_float(md.get("avgPace"), min_v=0.0)
        pace_best = _clean_float(md.get("bestPace"), min_v=0.0)
        cadence_avg = _clean_float(md.get("avgStepRate"), min_v=0.0)
        cadence_best = _clean_float(md.get("bestStepRate"), min_v=0.0)
        elev_gain = _clean_float(md.get("creepingWave"), min_v=0.0, max_v=50000.0)
        elev_loss = _clean_float(md.get("mTotalDescent"), min_v=0.0, max_v=50000.0)
        max_alti = _clean_alti(md.get("mMaxAlti"))
        min_alti = _clean_alti(md.get("mMinAlti"))

        gct_raw = md.get("mAvgGroundContactTime")
        avg_gct_ms = float(gct_raw) if gct_raw is not None and float(gct_raw) > 0 else None

        max_met = wear.get("max_met") or 0
        vo2max = round(float(max_met) / 65536.0 * 3.5, 1) if max_met and float(max_met) > 0 else None

        load_raw = wear.get("load_peak")
        if not load_raw and ext.get("aerobicLoadPeak"):
            try:
                load_raw = int(float(ext["aerobicLoadPeak"]))
            except ValueError:
                load_raw = None
        training_load = int(load_raw) if load_raw and int(load_raw) > 0 else None

        # Continuous EWMA running_index matching server dashboard_api.py formula
        running_index: float | None = None
        if sport_id in (258, 264):
            eff_est = None
            if (
                dist_m is not None
                and dist_m >= 800
                and duration_s >= 180
                and pace_avg is not None
                and 0 < pace_avg <= 600
                and hr_avg is not None
                and 100 <= hr_avg <= 210
            ):
                vel = dist_m / (duration_s / 60.0)
                vo2_spd = -4.60 + 0.182258 * vel + 0.000104 * vel * vel
                pct_hrr = max(0.55, min(0.98, (hr_avg - 60.0) / 135.0))
                eff_est = vo2_spd / pct_hrr
            raw_idx: float | None = None
            if vo2max is not None and eff_est is not None:
                raw_idx = 0.75 * vo2max + 0.25 * max(vo2max - 12.0, min(vo2max + 3.0, eff_est))
            elif vo2max is not None:
                raw_idx = 0.95 * vo2max
            elif eff_est is not None and 20.0 <= eff_est <= 85.0:
                raw_idx = eff_est
            if raw_idx is not None:
                ewma_rai = raw_idx if ewma_rai is None else (0.35 * raw_idx + 0.65 * ewma_rai)
                running_index = round(ewma_rai, 1)

        # Accumulate daily performance metrics across all workouts on that date
        if vo2max is not None:
            daily_workout_stats[date_str]["vo2max"] = vo2max
        if training_load is not None:
            daily_workout_stats[date_str]["training_load"] = (
                daily_workout_stats[date_str].get("training_load", 0.0) + float(training_load)
            )
        if running_index is not None:
            daily_workout_stats[date_str]["running_index"] = running_index

        in_window = (
            (window_start_ms is None and min_mod_ms is None)
            or (window_start_ms is not None and start_ms >= window_start_ms)
            or (min_mod_ms is not None and mod_ms >= min_mod_ms)
        )
        if not in_window:
            continue

        raw_text = _decode_sequence_text(r["data"])
        splits_json, cadence_series, rp_count, posture_series, track_gz_b64, has_gps, gps_count = (
            _parse_workout_track(raw_text, start_ms, include_gps)
        )

        dyn: dict[str, Any] = {}
        if avg_gct_ms is not None:
            dyn["mAvgGroundContactTime"] = int(avg_gct_ms)
        if md.get("paceMap"):
            dyn["paceMap"] = md["paceMap"]
        if avg_gct_ms is not None:
            dyn["avg_gct_ms"] = int(avg_gct_ms)
        if ext.get("avg_gc_tb"):
            v = _clean_float(ext["avg_gc_tb"], min_v=0.0, max_v=100.0)
            if v is not None and v > 0:
                dyn["avg_gc_tb"] = round(v, 2)
        if ext.get("avg_v_osc"):
            v = _clean_float(ext["avg_v_osc"], min_v=0.0, max_v=50.0)
            if v is not None and v > 0:
                dyn["avg_v_osc_cm"] = round(v, 2)
        if vo2max is not None:
            dyn["vo2max"] = vo2max
        if training_load is not None:
            dyn["training_load"] = training_load
        if wear.get("etraining_effect"):
            te = float(wear["etraining_effect"]) / 10.0
            if te > 0:
                dyn["aerobic_te"] = round(te, 1)
        if wear.get("anaerobic_exercise_etraining_effect"):
            ate = float(wear["anaerobic_exercise_etraining_effect"]) / 10.0
            if ate > 0:
                dyn["anaerobic_te"] = round(ate, 1)
        if wear.get("recovery_time") and int(wear["recovery_time"]) > 0:
            dyn["recovery_time_min"] = int(wear["recovery_time"])
        if cadence_series:
            dyn["cadence_series"] = cadence_series
        if rp_count > 0:
            dyn["rp_samples_count"] = rp_count
        if posture_series:
            dyn["posture_series"] = posture_series
        if running_index is not None:
            dyn["running_index"] = running_index

        row_dict: dict[str, Any] = {
            "start_ms": start_ms,
            "end_ms": end_ms,
            "date": date_str,
            "start_iso": ms_to_iso(start_ms, tz),
            "end_iso": ms_to_iso(end_ms, tz),
            "duration_s": duration_s,
            "sport_type_id": sport_id,
            "sport_name": SPORT_NAMES.get(sport_id, f"运动({sport_id})"),
            "distance_m": dist_m,
            "calories_kcal": calories_kcal,
            "steps": steps,
            "hr_min": hr_min,
            "hr_avg": hr_avg,
            "hr_max": hr_max,
            "pace_avg_s_per_km": round(pace_avg, 4) if pace_avg is not None else None,
            "pace_best_s_per_km": round(pace_best, 4) if pace_best is not None else None,
            "cadence_avg_spm": round(cadence_avg, 1) if cadence_avg is not None else None,
            "cadence_best_spm": round(cadence_best, 1) if cadence_best is not None else None,
            "elevation_gain_m": elev_gain,
            "elevation_loss_m": elev_loss,
            "max_alti_m": max_alti,
            "min_alti_m": min_alti,
            "avg_gct_ms": avg_gct_ms,
            "has_gps": has_gps,
            "gps_point_count": gps_count,
            "splits_json": splits_json,
            "running_dynamics_json": json.dumps(dyn, ensure_ascii=False) if dyn else None,
            "updated_at_ms": now_ms,
        }
        if track_gz_b64 is not None:
            row_dict["track_points_gz_b64"] = track_gz_b64
        workouts_out.append(row_dict)

    return workouts_out, daily_workout_stats


def extract_sleep_sessions(
    con: sqlite3.Connection,
    tz: datetime.timezone,
    now_ms: int,
    window_start_ms: int | None,
) -> list[dict[str, Any]]:
    # Load 700013 sleep summaries
    meta_rows: list[tuple[int, int, dict[str, Any]]] = []
    for r in con.execute(
        "SELECT start_time, end_time, meta_data FROM sample_sequence "
        "WHERE type_id = 700013 AND merged = 0 ORDER BY start_time ASC;"
    ):
        try:
            md = json.loads(r["meta_data"] or "{}")
        except Exception:
            md = {}
        meta_rows.append((int(r["start_time"]), int(r["end_time"]), md))

    core_sql = (
        "SELECT start_time, end_time, type_id FROM sample_session_core "
        "WHERE merged = 0 AND type_id IN (22101,22102,22103,22104,22105) "
        "ORDER BY start_time ASC;"
    )
    core_rows = con.execute(core_sql).fetchall()

    # Group contiguous segments into sessions (> 30 min gap or nap<->night switch starts a new session)
    sessions_raw: list[list[tuple[int, int, str]]] = []
    cur: list[tuple[int, int, str]] = []
    prev_end = 0
    prev_is_nap: bool | None = None

    for r in core_rows:
        st = int(r["start_time"])
        et = int(r["end_time"])
        if et <= st:
            continue
        stage = SLEEP_STAGE_MAP[int(r["type_id"])]
        is_nap = stage == "nap"
        if cur and (st - prev_end > 30 * 60 * 1000 or is_nap != prev_is_nap):
            sessions_raw.append(cur)
            cur = []
        cur.append((st, et, stage))
        prev_end = max(prev_end, et)
        prev_is_nap = is_nap
    if cur:
        sessions_raw.append(cur)

    sessions_out: list[dict[str, Any]] = []
    for segs in sessions_raw:
        s_ms = segs[0][0]
        e_ms = max(x[1] for x in segs)
        if window_start_ms is not None and e_ms < window_start_ms:
            continue

        is_nap = segs[0][2] == "nap"
        totals = defaultdict(float)
        stages_list = []
        for st, et, stage in segs:
            mins = round((et - st) / 60000.0, 2)
            totals[stage] += mins
            stages_list.append({"stage": stage, "start_ms": st, "end_ms": et, "min": mins})

        deep_m = round(totals["deep"], 1)
        light_m = round(totals["light"], 1)
        rem_m = round(totals["rem"], 1)
        awake_m = round(totals["awake"], 1)
        nap_m = round(totals["nap"], 1)
        total_m = nap_m if is_nap else round(deep_m + light_m + rem_m, 1)

        # Find overlapping 700013 summary within ±30 min
        matched_md: dict[str, Any] = {}
        best_overlap = -1
        pad = 30 * 60 * 1000
        for ms0, me0, md in meta_rows:
            ov = min(e_ms + pad, me0 + pad) - max(s_ms - pad, ms0 - pad)
            if ov > 0 and ov > best_overlap:
                # Avoid matching a night summary to a nap or vice versa when lengths wildly differ
                best_overlap = ov
                matched_md = md

        # Normalize session boundaries from 700013 bedTime/wakeupTime if available for night sleep
        if matched_md and not is_nap:
            bt = matched_md.get("bedTime")
            wt = matched_md.get("wakeupTime")
            if bt and int(bt) > 0:
                bt_ms = int(bt) * 1000 if int(bt) < 1e11 else int(bt)
                if abs(bt_ms - s_ms) <= 2 * 3600 * 1000:
                    s_ms = min(s_ms, bt_ms)
            if wt and int(wt) > 0:
                wt_ms = int(wt) * 1000 if int(wt) < 1e11 else int(wt)
                if abs(wt_ms - e_ms) <= 2 * 3600 * 1000:
                    e_ms = max(e_ms, wt_ms)

        baselines = {k: matched_md[k] for k in BASELINE_KEYS if k in matched_md}

        sessions_out.append({
            "start_ms": s_ms,
            "end_ms": e_ms,
            "date": ms_to_date(e_ms, tz),
            "start_iso": ms_to_iso(s_ms, tz),
            "end_iso": ms_to_iso(e_ms, tz),
            "session_type": "nap" if is_nap else "night",
            "total_sleep_min": total_m,
            "deep_min": deep_m,
            "light_min": light_m,
            "rem_min": rem_m,
            "awake_min": awake_m,
            "nap_min": nap_m,
            "sleep_score": float(matched_md["sleepScore"]) if "sleepScore" in matched_md else None,
            "sleep_latency_min": float(matched_md["sleepLatency"]) if "sleepLatency" in matched_md else None,
            "avg_hr": float(matched_md["avgHeartrate"]) if "avgHeartrate" in matched_md else None,
            "avg_hrv": float(matched_md["avgHrv"]) if "avgHrv" in matched_md else None,
            "avg_breath_rate": float(matched_md["avgBreathrate"]) if "avgBreathrate" in matched_md else None,
            "snore_freq": float(matched_md["snoreFreq"]) if "snoreFreq" in matched_md else None,
            "deep_part_score": float(matched_md["deepPart"]) if "deepPart" in matched_md else None,
            "baselines_json": json.dumps(baselines, ensure_ascii=False) if baselines else None,
            "stages_json": json.dumps(stages_list, ensure_ascii=False),
            "updated_at_ms": now_ms,
        })

    return sessions_out


def extract_daily_summary(
    con: sqlite3.Connection,
    tz: datetime.timezone,
    now_ms: int,
    min_date_str: str | None,
    daily_workout_stats: dict[str, dict[str, float]],
) -> list[dict[str, Any]]:
    sql = "SELECT date, stat_type, value, modified_time, _id FROM hihealth_stat_day"
    params: list[Any] = []
    if min_date_str is not None:
        sql += " WHERE date >= ?"
        params.append(date_str_to_int(min_date_str))
    sql += " ORDER BY date ASC, modified_time ASC, _id ASC;"

    stats_by_date: dict[str, dict[int, float]] = defaultdict(dict)
    for r in con.execute(sql, params):
        d_str = int_date_to_str(int(r["date"]))
        stats_by_date[d_str][int(r["stat_type"])] = float(r["value"])

    # Supplement daily HR avg/last, HRV avg, and basal metabolism from sample_point_health
    supp_sql = (
        "SELECT type_id, start_time, value FROM sample_point_health "
        "WHERE merged = 0 AND type_id IN (2002, 500044831, 500018055, 500025628)"
    )
    supp_params: list[Any] = []
    if min_date_str is not None:
        dt_0 = datetime.datetime.strptime(min_date_str, "%Y-%m-%d").replace(tzinfo=tz)
        supp_sql += " AND start_time >= ?"
        supp_params.append(int(dt_0.timestamp() * 1000))
    supp_sql += " ORDER BY start_time ASC;"

    hr_by_date: dict[str, list[float]] = defaultdict(list)
    hrv_by_date: dict[str, list[float]] = defaultdict(list)
    basal_by_date: dict[str, float] = {}

    for r in con.execute(supp_sql, supp_params):
        tid = int(r["type_id"])
        ts_ms = int(r["start_time"])
        val = _clean_float(r["value"])
        if val is None:
            continue
        d_str = ms_to_date(ts_ms, tz)
        if tid == 2002:
            hr_by_date[d_str].append(val)
        elif tid == 500044831:
            hrv_by_date[d_str].append(val)
        elif tid == 500018055:
            basal_by_date[d_str] = round(val / 1000.0, 1)
        elif tid == 500025628 and d_str not in basal_by_date:
            basal_by_date[d_str] = round(val / 1000.0, 1)

    all_dates = sorted(
        set(stats_by_date.keys())
        | set(hr_by_date.keys())
        | set(basal_by_date.keys())
        | {d for d in daily_workout_stats if min_date_str is None or d >= min_date_str}
    )

    rows_out: list[dict[str, Any]] = []
    for d_str in all_dates:
        st = stats_by_date.get(d_str, {})
        row: dict[str, Any] = {"date": d_str, "updated_at_ms": now_ms}

        def set_int(col: str, *codes: int) -> None:
            for c in codes:
                if c in st:
                    row[col] = int(round(st[c]))
                    return

        def set_float(col: str, *codes: int, scale: float = 1.0, ndigits: int = 2) -> None:
            for c in codes:
                if c in st:
                    row[col] = round(st[c] * scale, ndigits)
                    return

        def set_iso(col: str, code: int) -> None:
            if code in st and st[code] > 1e11:
                row[col] = ms_to_iso(int(round(st[code])), tz)

        set_int("steps", 40002)
        set_float("calories_kcal", 40003, scale=0.001, ndigits=2)
        set_float("distance_m", 40004, scale=1.0, ndigits=1)
        set_int("active_duration_s", 40006)
        set_int("active_hours", 300002748, 200005921)
        set_int("moderate_high_min", 47101, 300002182)
        set_int("step_goal", 300002058)
        set_float("calorie_goal_kcal", 300002125, scale=0.001, ndigits=1)

        if d_str in basal_by_date:
            row["basal_metabolism_kcal"] = basal_by_date[d_str]

        set_float("hr_rest", 46020, ndigits=1)
        set_float("hr_min", 46017, ndigits=1)
        set_float("hr_max", 46016, ndigits=1)
        if d_str in hr_by_date:
            vals = hr_by_date[d_str]
            row["hr_avg"] = round(sum(vals) / len(vals), 1)
            row["hr_last"] = round(vals[-1], 1)

        set_float("hrv_min", 500044018, ndigits=1)
        if d_str in hrv_by_date:
            vals = hrv_by_date[d_str]
            row["hrv_avg"] = round(sum(vals) / len(vals), 1)
        set_float("hrv_max", 500044760, ndigits=1)
        set_float("hrv_last", 500044710, ndigits=1)

        set_float("spo2_min", 47202, ndigits=1)
        set_float("spo2_avg", 47203, ndigits=2)
        set_float("spo2_max", 47201, ndigits=1)
        set_float("spo2_last", 47204, ndigits=1)

        set_float("stress_min", 44304, ndigits=1)
        set_float("stress_max", 44305, ndigits=1)
        set_float("stress_avg", 44306, ndigits=1)
        set_float("stress_last", 44307, ndigits=1)
        set_int("stress_count", 44308)

        set_int("emotion_total_count", 500031670)
        set_int("emotion_peace_count", 500031335)
        set_int("emotion_pleasant_count", 500031801)
        set_int("emotion_unpleasant_count", 500031872)

        set_float("sleep_score", 44203, ndigits=1)
        set_float("sleep_total_min", 44105, ndigits=1)
        set_float("sleep_deep_min", 44102, ndigits=1)
        set_float("sleep_light_min", 44103, ndigits=1)
        set_float("sleep_rem_min", 44101, ndigits=1)
        set_float("sleep_awake_min", 44104, ndigits=1)
        set_float("sleep_nap_min", 44107, ndigits=1)
        set_float("sleep_efficiency", 44207, ndigits=1)
        set_float("sleep_latency_min", 44204, ndigits=1)
        set_iso("sleep_fall_asleep_iso", 44201)
        set_iso("sleep_wakeup_iso", 44202)
        set_iso("sleep_bed_iso", 44205)
        set_iso("sleep_rising_iso", 44216)
        set_float("sleep_avg_hr", 44219, ndigits=1)
        set_float("sleep_avg_hrv", 44231, ndigits=1)
        set_float("sleep_avg_spo2", 44223, ndigits=1)
        set_float("sleep_avg_breath_rate", 44227, ndigits=1)
        set_float("sleep_snore_freq", 44208, ndigits=1)

        wo_st = daily_workout_stats.get(d_str)
        if wo_st:
            if "vo2max" in wo_st:
                row["vo2max"] = round(wo_st["vo2max"], 1)
            if "training_load" in wo_st:
                row["training_load"] = round(wo_st["training_load"], 1)
            if "running_index" in wo_st:
                row["running_index"] = round(wo_st["running_index"], 1)

        if len(row) > 2:
            rows_out.append(row)

    return rows_out


