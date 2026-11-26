"""Read-only dashboard aggregation and GPX export API for Huawei Health."""

from __future__ import annotations

import bisect
import datetime as dt
import gzip
import json
import math
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Any

from db import get_db_status, open_health_db

TZ_PLUS8 = dt.timezone(dt.timedelta(hours=8))


def _clamp(val: Any, lo: int, hi: int, default: int) -> int:
    try:
        v = int(val)
    except Exception:
        return default
    return max(lo, min(hi, v))


def _avg(vals: list[float | int | None], ndigits: int = 2) -> float | None:
    clean = [float(v) for v in vals if v is not None]
    if not clean:
        return None
    return round(sum(clean) / len(clean), ndigits)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _kpi_entry(cur: float | None, prev: float | None, ndigits: int = 1) -> dict[str, Any]:
    delta = None
    delta_pct = None
    if cur is not None and prev is not None:
        delta = round(cur - prev, ndigits)
        if abs(prev) > 1e-9:
            delta_pct = round((cur - prev) / abs(prev) * 100.0, 1)
    return {
        "current": round(cur, ndigits) if cur is not None else None,
        "previous": round(prev, ndigits) if prev is not None else None,
        "delta": delta,
        "delta_pct": delta_pct,
    }


def _table_has_col(con, table: str, col: str) -> bool:
    return any(r[1] == col for r in con.execute(f"PRAGMA table_info({table});").fetchall())


def _safe_json_dict(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _calc_workout_load(w: dict[str, Any], dyn: dict[str, Any]) -> float:
    lp = dyn.get("training_load")
    if lp is not None and float(lp) > 0:
        return float(lp)
    dur_min = float(w.get("duration_s") or 0) / 60.0
    if dur_min <= 0:
        return 0.0
    hr = float(w.get("hr_avg") or 130.0)
    return round(dur_min * max(0.3, (hr - 60.0) / 130.0) * 1.1, 1)


def _compute_training_series(con) -> list[dict[str, Any]]:
    has_load_col = _table_has_col(con, "daily_summary", "training_load")
    load_by_date: dict[str, float] = {}
    dates_seen: set[str] = set()

    if has_load_col:
        for r in con.execute("SELECT date, training_load FROM daily_summary ORDER BY date ASC;"):
            d = str(r["date"])
            dates_seen.add(d)
            if r["training_load"] is not None:
                load_by_date[d] = round(float(r["training_load"]), 1)
    else:
        for r in con.execute("SELECT date FROM daily_summary ORDER BY date ASC;"):
            dates_seen.add(str(r["date"]))

    wo_loads: dict[str, float] = defaultdict(float)
    for r in con.execute(
        "SELECT date, duration_s, hr_avg, running_dynamics_json FROM workouts ORDER BY start_ms ASC;"
    ):
        d = str(r["date"])
        dates_seen.add(d)
        dyn = _safe_json_dict(r["running_dynamics_json"])
        wo_loads[d] += _calc_workout_load(dict(r), dyn)

    for d, v in wo_loads.items():
        if d not in load_by_date and v > 0:
            load_by_date[d] = round(v, 1)

    if not dates_seen:
        return []

    min_d = dt.date.fromisoformat(min(dates_seen))
    max_d = dt.date.fromisoformat(max(dates_seen))
    ctl = 0.0
    atl = 0.0
    win28: list[float] = []
    out: list[dict[str, Any]] = []
    cur = min_d
    while cur <= max_d:
        ds = str(cur)
        ld = round(float(load_by_date.get(ds, 0.0)), 1)
        ctl = ctl + (ld - ctl) / 42.0
        atl = atl + (ld - atl) / 7.0
        tsb = ctl - atl
        win28.append(ld)
        if len(win28) > 28:
            win28.pop(0)
        load_7d = round(sum(win28[-7:]), 1)
        load_28d_wk = round(sum(win28) / 4.0, 1)
        acwr = round(load_7d / max(load_28d_wk, 1.0), 2)

        if load_7d < 10:
            status = "训练不足"
        elif acwr > 1.5 or tsb < -15:
            status = "负荷偏高"
        elif 1.05 <= acwr <= 1.5 and tsb >= -15:
            status = "高效提升"
        elif 0.8 <= acwr < 1.05 and tsb > 3:
            status = "状态巅峰"
        elif 0.8 <= acwr < 1.05:
            status = "保持稳定"
        else:
            status = "积极恢复"

        out.append({
            "date": ds,
            "load": ld,
            "ctl": round(ctl, 1),
            "atl": round(atl, 1),
            "tsb": round(tsb, 1),
            "load_7d": load_7d,
            "load_28d_wk": load_28d_wk,
            "acwr": acwr,
            "status": status,
        })
        cur += dt.timedelta(days=1)
    return out


def _classify_vo2max(val: float) -> tuple[str, str]:
    if val >= 52.0:
        return "高", "#30D158"
    if val >= 44.0:
        return "高于平均", "#32ADE6"
    if val >= 38.0:
        return "低于平均", "#FF9F0A"
    return "低", "#FF3B30"


def _compute_vo2max_points(con) -> list[dict[str, Any]]:
    by_date: dict[str, float] = {}
    if _table_has_col(con, "daily_summary", "vo2max"):
        for r in con.execute("SELECT date, vo2max FROM daily_summary WHERE vo2max IS NOT NULL ORDER BY date ASC;"):
            by_date[str(r["date"])] = round(float(r["vo2max"]), 1)

    for r in con.execute("SELECT date, running_dynamics_json FROM workouts ORDER BY start_ms ASC;"):
        dyn = _safe_json_dict(r["running_dynamics_json"])
        v = dyn.get("vo2max")
        if v is not None and 20.0 <= float(v) <= 95.0:
            by_date[str(r["date"])] = round(float(v), 1)

    pts = []
    for d in sorted(by_date):
        v = by_date[d]
        lvl, col = _classify_vo2max(v)
        pts.append({"date": d, "val": v, "level": lvl, "color": col})
    return pts


def _classify_rai(val: float) -> str:
    if val >= 60.0:
        return "专业级"
    if val >= 52.0:
        return "竞速跑者"
    if val >= 44.0:
        return "精英跑者"
    if val >= 36.0:
        return "进阶跑者"
    return "初级跑者"


_VDOT_TABLE = [
    (30.0, 1840.0, 3826.0, 8464.0, 17357.0),
    (35.0, 1620.0, 3363.0, 7453.0, 15361.0),
    (40.0, 1448.0, 3003.0, 6659.0, 13785.0),
    (45.0, 1310.0, 2716.0, 6020.0, 12489.0),
    (50.0, 1197.0, 2481.0, 5495.0, 11449.0),
    (55.0, 1102.0, 2286.0, 5058.0, 10560.0),
    (60.0, 1023.0, 2122.0, 4689.0, 9805.0),
    (65.0, 954.0, 1981.0, 4373.0, 9141.0),
    (70.0, 895.0, 1859.0, 4101.0, 8575.0),
    (75.0, 844.0, 1752.0, 3862.0, 8087.0),
]


def _fmt_race_duration(sec: float) -> str:
    s = int(round(sec))
    h, rem = divmod(s, 3600)
    m, ss = divmod(rem, 60)
    if h > 0:
        return f"{h}:{m:02d}:{ss:02d}"
    return f"{m}:{ss:02d}"


def _fmt_pace_cn(s_per_km: float) -> str:
    total = int(round(s_per_km))
    m, s = divmod(total, 60)
    return f"{m}'{s:02d}\"/km"


def _predict_race_times(rai: float | None) -> list[dict[str, str]]:
    if rai is None or rai <= 0:
        return []
    x = max(_VDOT_TABLE[0][0], min(_VDOT_TABLE[-1][0], float(rai)))
    idx = 0
    while idx < len(_VDOT_TABLE) - 2 and _VDOT_TABLE[idx + 1][0] < x:
        idx += 1
    row0, row1 = _VDOT_TABLE[idx], _VDOT_TABLE[idx + 1]
    frac = (x - row0[0]) / max(row1[0] - row0[0], 1e-6)
    specs = [
        ("5公里", 1, 5.0),
        ("10公里", 2, 10.0),
        ("半程马拉松", 3, 21.0975),
        ("全程马拉松", 4, 42.195),
    ]
    out = []
    for name, col_idx, dist_km in specs:
        t_s = row0[col_idx] + (row1[col_idx] - row0[col_idx]) * frac
        out.append({
            "distance": name,
            "time": _fmt_race_duration(t_s),
            "pace": _fmt_pace_cn(t_s / dist_km),
        })
    return out


def _compute_rai_series(con) -> list[dict[str, Any]]:
    by_date: dict[str, float] = {}
    if _table_has_col(con, "daily_summary", "running_index"):
        for r in con.execute("SELECT date, running_index FROM daily_summary WHERE running_index IS NOT NULL ORDER BY date ASC;"):
            by_date[str(r["date"])] = round(float(r["running_index"]), 1)

    if not by_date:
        ewma = None
        for r in con.execute(
            "SELECT date, sport_type_id, duration_s, distance_m, pace_avg_s_per_km, hr_avg, running_dynamics_json "
            "FROM workouts WHERE sport_type_id IN (258, 264) ORDER BY start_ms ASC;"
        ):
            dyn = _safe_json_dict(r["running_dynamics_json"])
            if dyn.get("running_index") is not None:
                val = round(float(dyn["running_index"]), 1)
                ewma = val
                by_date[str(r["date"])] = val
                continue
            vo2_wo = dyn.get("vo2max")
            dist_m = float(r["distance_m"] or 0)
            dur_s = float(r["duration_s"] or 0)
            pace_avg = float(r["pace_avg_s_per_km"] or 0)
            hr_avg = float(r["hr_avg"] or 0)
            eff_est = None
            if dist_m >= 800 and dur_s >= 180 and 0 < pace_avg <= 600:
                vel = dist_m / (dur_s / 60.0)
                vo2_spd = -4.60 + 0.182258 * vel + 0.000104 * vel * vel
                if 100 <= hr_avg <= 210:
                    pct_hrr = max(0.55, min(0.98, (hr_avg - 60.0) / 135.0))
                    eff_est = vo2_spd / pct_hrr
            raw_idx = None
            if vo2_wo is not None and eff_est is not None:
                vo2_f = float(vo2_wo)
                raw_idx = 0.75 * vo2_f + 0.25 * max(vo2_f - 12.0, min(vo2_f + 3.0, eff_est))
            elif vo2_wo is not None:
                raw_idx = 0.95 * float(vo2_wo)
            elif eff_est is not None and 20.0 <= eff_est <= 85.0:
                raw_idx = eff_est
            if raw_idx is not None:
                ewma = raw_idx if ewma is None else (0.35 * raw_idx + 0.65 * ewma)
                by_date[str(r["date"])] = round(ewma, 1)

    return [{"date": d, "val": by_date[d], "tier": _classify_rai(by_date[d])} for d in sorted(by_date)]


def _pct_band(vals: list[float], q_lo: float = 0.2, q_hi: float = 0.8) -> tuple[float, float] | None:
    clean = sorted(float(v) for v in vals if v is not None)
    if len(clean) < 3:
        return None
    i_lo = max(0, int((len(clean) - 1) * q_lo))
    i_hi = min(len(clean) - 1, int((len(clean) - 1) * q_hi))
    return round(clean[i_lo], 1), round(clean[i_hi], 1)


def _parse_iso_ms(iso_str: str | None) -> int | None:
    if not iso_str:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(iso_str))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=TZ_PLUS8)
        return int(round(parsed.timestamp() * 1000))
    except Exception:
        return None


def _infer_tz(latest_night_row: dict[str, Any] | None, daily_rows: list[dict[str, Any]]) -> dt.timezone:
    candidates: list[str | None] = []
    if latest_night_row:
        candidates.extend([latest_night_row.get("start_iso"), latest_night_row.get("end_iso")])
    for r in reversed(daily_rows):
        candidates.extend([r.get("sleep_fall_asleep_iso"), r.get("sleep_wakeup_iso")])
    for s in candidates:
        if not s:
            continue
        try:
            parsed = dt.datetime.fromisoformat(str(s))
            if parsed.tzinfo is not None:
                offset = parsed.utcoffset()
                if offset is not None:
                    return dt.timezone(offset)
        except Exception:
            continue
    return TZ_PLUS8


def _resolve_sleep_window(
    date_str: str,
    sleep_row: dict[str, Any] | None,
    d_row: dict[str, Any] | None,
    tz: dt.timezone,
) -> tuple[int, int, str]:
    if sleep_row and sleep_row.get("start_ms") is not None and sleep_row.get("end_ms") is not None:
        s_ms, e_ms = int(sleep_row["start_ms"]), int(sleep_row["end_ms"])
        if e_ms > s_ms:
            s_lbl = (str(sleep_row.get("start_iso") or "")[11:16]
                     or dt.datetime.fromtimestamp(s_ms / 1000.0, tz=tz).strftime("%H:%M"))
            e_lbl = (str(sleep_row.get("end_iso") or "")[11:16]
                     or dt.datetime.fromtimestamp(e_ms / 1000.0, tz=tz).strftime("%H:%M"))
            return s_ms, e_ms, f"{s_lbl}–{e_lbl}"

    if d_row:
        s_iso = d_row.get("sleep_fall_asleep_iso")
        e_iso = d_row.get("sleep_wakeup_iso")
        s_ms = _parse_iso_ms(s_iso)
        e_ms = _parse_iso_ms(e_iso)
        if s_ms is not None and e_ms is not None and e_ms > s_ms:
            return s_ms, e_ms, f"{str(s_iso)[11:16]}–{str(e_iso)[11:16]}"

    anchor_d = dt.date.fromisoformat(date_str)
    s_dt = dt.datetime(anchor_d.year, anchor_d.month, anchor_d.day, 23, 0, tzinfo=tz) - dt.timedelta(days=1)
    e_dt = dt.datetime(anchor_d.year, anchor_d.month, anchor_d.day, 7, 0, tzinfo=tz)
    return int(s_dt.timestamp() * 1000), int(e_dt.timestamp() * 1000), "23:00–07:00"


def _trimmed_vital_stat(
    vals: list[float],
    lo_b: float,
    hi_b: float,
    min_n: int,
    mode: str = "trimmed_mean",
) -> tuple[float | None, int]:
    clean = sorted(float(v) for v in vals if v is not None and lo_b <= float(v) <= hi_b)
    n = len(clean)
    if n < min_n:
        return None, 0
    if mode == "trimmed_mean" and n >= 10:
        cut = max(1, int(n * 0.1))
        core = clean[cut : n - cut] or clean
        return round(sum(core) / len(core), 1), n
    mid = n // 2
    med = clean[mid] if n % 2 == 1 else (clean[mid - 1] + clean[mid]) / 2.0
    return round(med, 1), n


def _reconstruct_overnight_history(
    con,
    target_date: str,
    by_date: dict[str, dict[str, Any]],
    tz: dt.timezone,
) -> dict[str, list[float]]:
    end_d = dt.date.fromisoformat(target_date)
    start_d = end_d - dt.timedelta(days=35)
    sleep_by_date: dict[str, dict[str, Any]] = {}
    for r in con.execute(
        """
        SELECT date, start_ms, end_ms, start_iso, end_iso
        FROM sleep_sessions
        WHERE session_type = 'night' AND date >= ? AND date < ?
        ORDER BY start_ms ASC;
        """,
        (str(start_d), target_date),
    ):
        sleep_by_date[str(r["date"])] = dict(r)

    min_win_ms = int((dt.datetime(start_d.year, start_d.month, start_d.day, 0, 0, tzinfo=tz) - dt.timedelta(days=1)).timestamp() * 1000)
    max_win_ms = int(dt.datetime(end_d.year, end_d.month, end_d.day, 12, 0, tzinfo=tz).timestamp() * 1000)

    series: dict[str, tuple[list[int], list[float]]] = {
        "heart_rate": ([], []),
        "spo2": ([], []),
    }
    for r in con.execute(
        """
        SELECT metric, ts_ms, value
        FROM vitals_points
        WHERE metric IN ('heart_rate', 'spo2') AND ts_ms >= ? AND ts_ms <= ?
        ORDER BY ts_ms ASC;
        """,
        (min_win_ms, max_win_ms),
    ):
        ts_list, v_list = series[str(r["metric"])]
        ts_list.append(int(r["ts_ms"]))
        v_list.append(float(r["value"]))

    candidate_dates = sorted(set(by_date.keys()) | set(sleep_by_date.keys()))
    if not candidate_dates:
        candidate_dates = [str(start_d + dt.timedelta(days=i)) for i in range(35)]

    out: dict[str, list[float]] = {"heart_rate": [], "spo2": []}
    hr_ts, hr_vs = series["heart_rate"]
    sp_ts, sp_vs = series["spo2"]
    for d_str in candidate_dates:
        if d_str >= target_date:
            continue
        win_s, win_e, _ = _resolve_sleep_window(d_str, sleep_by_date.get(d_str), by_date.get(d_str), tz)
        if hr_ts:
            i0 = bisect.bisect_left(hr_ts, win_s)
            i1 = bisect.bisect_right(hr_ts, win_e)
            est_hr, _ = _trimmed_vital_stat(hr_vs[i0:i1], 35.0, 130.0, 3, "trimmed_mean")
            if est_hr is not None:
                out["heart_rate"].append(est_hr)
        if sp_ts:
            i0 = bisect.bisect_left(sp_ts, win_s)
            i1 = bisect.bisect_right(sp_ts, win_e)
            est_sp, _ = _trimmed_vital_stat(sp_vs[i0:i1], 70.0, 100.0, 2, "median")
            if est_sp is not None:
                out["spo2"].append(est_sp)
    return out


def _compute_overnight_vitals(
    con,
    latest_night_row: dict[str, Any] | None,
    daily_30d: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not latest_night_row and not daily_30d:
        return None
    by_date = {r["date"]: r for r in daily_30d}
    target_date = (latest_night_row or {}).get("date") or (daily_30d[-1]["date"] if daily_30d else None)
    if not target_date:
        return None
    d_row = by_date.get(target_date)
    if d_row is None:
        r = con.execute("SELECT * FROM daily_summary WHERE date = ?;", (target_date,)).fetchone()
        d_row = dict(r) if r else {}

    tz = _infer_tz(latest_night_row, daily_30d)
    win_s, win_e, win_lbl = _resolve_sleep_window(target_date, latest_night_row, d_row, tz)

    baselines = _safe_json_dict((latest_night_row or {}).get("baselines_json"))
    hr_val = (latest_night_row or {}).get("avg_hr") or d_row.get("sleep_avg_hr")
    hrv_val = (latest_night_row or {}).get("avg_hrv") or d_row.get("sleep_avg_hrv")
    breath_val = (latest_night_row or {}).get("avg_breath_rate") or d_row.get("sleep_avg_breath_rate")
    spo2_val = d_row.get("sleep_avg_spo2")
    sleep_val = d_row.get("sleep_total_min") if d_row.get("sleep_total_min") is not None else (latest_night_row or {}).get("total_sleep_min")

    val_sources: dict[str, str] = {}
    need_metrics: list[str] = []
    if hr_val is None:
        need_metrics.append("heart_rate")
    if spo2_val is None:
        need_metrics.append("spo2")

    if need_metrics:
        ph = ",".join("?" for _ in need_metrics)
        win_pts: dict[str, list[float]] = defaultdict(list)
        for r in con.execute(
            f"SELECT metric, value FROM vitals_points WHERE metric IN ({ph}) AND ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms ASC;",
            (*need_metrics, win_s, win_e),
        ):
            win_pts[str(r["metric"])].append(float(r["value"]))
        if hr_val is None:
            est_hr, cnt_hr = _trimmed_vital_stat(win_pts.get("heart_rate", []), 35.0, 130.0, 3, "trimmed_mean")
            if est_hr is not None:
                hr_val = est_hr
                val_sources["heart_rate"] = f"昨晚 {win_lbl} {cnt_hr} 条连续心率本地估算"
            elif d_row.get("hr_rest") is not None:
                hr_val = float(d_row["hr_rest"])
                val_sources["heart_rate"] = "当日静息心率本地回退"
        if spo2_val is None:
            est_sp, cnt_sp = _trimmed_vital_stat(win_pts.get("spo2", []), 70.0, 100.0, 2, "median")
            if est_sp is not None:
                spo2_val = est_sp
                val_sources["spo2"] = f"昨晚 {win_lbl} {cnt_sp} 条连续血氧本地估算"
            elif d_row.get("spo2_avg") is not None:
                spo2_val = float(d_row["spo2_avg"])
                val_sources["spo2"] = "当日血氧均值本地回退"

    recon_cache: dict[str, list[float]] | None = None

    def get_reconstructed() -> dict[str, list[float]]:
        nonlocal recon_cache
        if recon_cache is None:
            recon_cache = _reconstruct_overnight_history(con, target_date, by_date, tz)
        return recon_cache

    specs = [
        {
            "key": "heart_rate",
            "label": "夜间心率",
            "val": hr_val,
            "low": baselines.get("minHeartrateBaseline"),
            "high": baselines.get("maxHeartrateBaseline"),
            "fallback": _pct_band([r.get("sleep_avg_hr") for r in daily_30d]),
            "unit": "次/分",
            "digits": 0,
            "metric": "heart_rate",
        },
        {
            "key": "hrv",
            "label": "夜间 HRV",
            "val": hrv_val,
            "low": baselines.get("minHrvBaseline"),
            "high": baselines.get("maxHrvBaseline"),
            "fallback": _pct_band([r.get("sleep_avg_hrv") for r in daily_30d]),
            "unit": "毫秒",
            "digits": 0,
            "metric": "hrv",
        },
        {
            "key": "breath",
            "label": "呼吸频率",
            "val": breath_val,
            "low": baselines.get("minBreathrateBaseline"),
            "high": baselines.get("maxBreathrateBaseline"),
            "fallback": _pct_band([r.get("sleep_avg_breath_rate") for r in daily_30d]),
            "unit": "次/分",
            "digits": 0,
            "metric": "sleep",
        },
        {
            "key": "spo2",
            "label": "夜间血氧",
            "val": spo2_val,
            "low": baselines.get("minOxygenSaturationBaseline"),
            "high": baselines.get("maxOxygenSaturationBaseline"),
            "fallback": _pct_band([r.get("sleep_avg_spo2") for r in daily_30d]),
            "unit": "%",
            "digits": 0,
            "metric": "spo2",
        },
        {
            "key": "sleep",
            "label": "睡眠时长",
            "val": sleep_val,
            "low": None,
            "high": None,
            "fallback": _pct_band([r.get("sleep_total_min") for r in daily_30d]),
            "unit": "",
            "digits": -1,  # format as h m
            "metric": "sleep",
        },
    ]

    if d_row.get("skin_temp_baseline_delta") is not None:
        specs.append({"key": "skin_temperature", "label": "夜间腕温", "metric": "skin_temperature",
                      "val": d_row["skin_temp_baseline_delta"], "low": None, "high": None, "digits": 1, "unit": "°C"})

    items: list[dict[str, Any]] = []
    for sp in specs:
        if sp["val"] is None:
            continue
        v = float(sp["val"])
        lo, hi = sp["low"], sp["high"]
        is_oem_baseline = lo is not None and hi is not None
        field = {"heart_rate": "sleep_avg_hr", "hrv": "sleep_avg_hrv", "breath": "sleep_avg_breath_rate", "spo2": "sleep_avg_spo2", "sleep": "sleep_total_min", "skin_temperature": "skin_temp_baseline_delta"}[sp["key"]]
        history = [r for r in daily_30d if r["date"] < target_date and r.get(field) is not None]
        base_method = "设备提供的个人基线"
        if not is_oem_baseline:
            if len(history) >= 5:
                lo_hi = _pct_band([r[field] for r in history])
                if lo_hi:
                    lo, hi = lo_hi
                    base_method = f'{history[0]["date"]} 至 {history[-1]["date"]} · {len(history)} 晚 · P20–P80'
            elif sp["key"] in ("heart_rate", "spo2"):
                recon_vals = get_reconstructed().get(sp["key"], [])
                if len(recon_vals) >= 5:
                    lo_hi = _pct_band(recon_vals)
                    if lo_hi:
                        lo, hi = lo_hi
                        base_method = f"本地算法基线（近 {len(recon_vals)} 晚夜间采样 P20–P80）"
                if lo is None or hi is None:
                    if sp["key"] == "heart_rate":
                        rhr_vals = [float(r["hr_rest"]) for r in daily_30d if r.get("hr_rest") is not None]
                        r_band = _pct_band(rhr_vals) if len(rhr_vals) >= 3 else None
                        if r_band:
                            lo = round(max(40.0, r_band[0] - 2.0), 1)
                            hi = round(min(100.0, r_band[1] + 4.0), 1)
                            base_method = "本地参考范围（基于近期静息心率推算）"
                        else:
                            lo, hi = 50.0, 75.0
                            base_method = "本地默认生理参考范围（夜间心率）"
                    else:
                        lo, hi = 95.0, 100.0
                        base_method = "本地默认生理参考范围（血氧常规 ≥95%）"
            else:
                base_method = "有效夜数不足 5 晚，基线积累中"

        val_src = val_sources.get(sp["key"])
        method = f"{val_src} · {base_method}" if val_src else base_method

        if lo is None or hi is None:
            items.append({"key": sp["key"], "label": sp["label"], "metric": sp["metric"], "value": v,
                          "display": _fmt_hm_cn(v) if sp["digits"] == -1 else f'{v:g} {sp["unit"]}',
                          "range_display": "积累中", "method": method, "status": "pending", "pos_pct": 50})
            continue
        lo_f, hi_f = float(lo), float(hi)
        if hi_f < lo_f:
            lo_f, hi_f = hi_f, lo_f
        if sp["key"] == "spo2" and not is_oem_baseline:
            hi_f = min(100.0, hi_f)
            if hi_f - lo_f < 2.0:
                lo_f = max(90.0, round(hi_f - 2.0, 1))
        span = max(hi_f - lo_f, 1e-6)
        pos_pct = round(max(6.0, min(94.0, (50.0 if hi_f == lo_f and v == lo_f else 25.0 + ((v - lo_f) / span) * 50.0))), 1)
        if lo_f - 1e-6 <= v <= hi_f + 1e-6:
            status = "typical"
        elif v > hi_f:
            status = "high"
        else:
            status = "low"

        if sp["digits"] == -1:
            disp = _fmt_hm_cn(v).replace(" 小时 ", "h").replace(" 分钟", "m")
            rng_disp = f"{round(lo_f / 60.0, 1)}–{round(hi_f / 60.0, 1)}h"
        else:
            val_fmt = f"{int(round(v))}" if sp["digits"] == 0 else f"{round(v, sp['digits'])}"
            if sp["key"] == "skin_temperature":
                val_fmt = f"{v:+.1f}"
            disp = f"{val_fmt}{sp['unit'] if sp['unit'] == '%' else ' ' + sp['unit']}"
            lo_s = f"{int(round(lo_f))}" if lo_f == int(lo_f) else f"{round(lo_f, 1)}"
            hi_s = f"{int(round(hi_f))}" if hi_f == int(hi_f) else f"{round(hi_f, 1)}"
            rng_disp = f"{lo_s}–{hi_s}"

        items.append({
            "key": sp["key"],
            "label": sp["label"],
            "value": round(v, 1),
            "display": disp,
            "low": round(lo_f, 1),
            "high": round(hi_f, 1),
            "range_display": rng_disp,
            "status": status,
            "pos_pct": pos_pct, "method": method,
            "metric": sp["metric"],
        })

    if not items:
        return None
    in_range = sum(1 for it in items if it["status"] == "typical")
    outliers = sum(it["status"] in ("high","low") for it in items)
    summary_text = "全部体征处于典型范围" if outliers == 0 else f"{outliers} 项指标超出典型范围"
    if any(it["status"] == "pending" for it in items):
        summary_text = f"{outliers} 项偏离 · 部分基线积累中"
    return {
        "date": target_date,
        "in_range_count": in_range,
        "total_count": len(items),
        "summary_text": summary_text,
        "items": items,
    }


def _compute_recent_trends(rows_30d: list[dict[str, Any]], latest_date: str) -> list[dict[str, Any]]:
    if not rows_30d:
        return []
    end_d = dt.date.fromisoformat(latest_date)
    start_7d = str(end_d - dt.timedelta(days=6))
    rows_7d = [r for r in rows_30d if r["date"] >= start_7d]

    def _hrv_pick(r: dict[str, Any]) -> float | None:
        v = r.get("hrv_avg")
        if v is None:
            v = r.get("hrv_last")
        return float(v) if v is not None else None

    specs = [
        ("heart_rate", "静息心率", lambda r: r.get("hr_rest"), "down", lambda v: f"{round(v, 1)} 次/分", 0.8),
        ("hrv", "心率变异性", _hrv_pick, "up", lambda v: f"{round(v, 1)} 毫秒", 1.2),
        ("sleep", "睡眠时长", lambda r: r.get("sleep_total_min"), "up", lambda v: _fmt_hm_cn(v), 8.0),
        ("steps", "每日步数", lambda r: r.get("steps"), "up", lambda v: f"{int(round(v)):,} 步", 150.0),
    ]
    out: list[dict[str, Any]] = []
    for metric, label, getter, good_dir, fmt_fn, flat_abs in specs:
        v7 = _avg([getter(r) for r in rows_7d], 1)
        v30 = _avg([getter(r) for r in rows_30d], 1)
        if v7 is None or v30 is None:
            continue
        diff = round(v7 - v30, 1)
        pct = round((v7 - v30) / max(abs(v30), 1e-6) * 100.0, 1)
        if abs(pct) < 2.0 or abs(diff) < flat_abs:
            direction, sentiment = "flat", "neutral"
        elif diff > 0:
            direction = "up"
            sentiment = "good" if good_dir == "up" else "warn"
        else:
            direction = "down"
            sentiment = "good" if good_dir == "down" else "warn"
        out.append({
            "metric": metric,
            "label": label,
            "cur_7d": v7,
            "avg_30d": v30,
            "delta": diff,
            "delta_pct": pct,
            "direction": direction,
            "sentiment": sentiment,
            "display_7d": fmt_fn(v7),
            "display_30d": fmt_fn(v30),
        })
    return out


_STAGE_CODE_MAP = {"deep": "d", "light": "l", "rem": "r", "awake": "a"}


def _iso_to_sleep_hour(iso_str: str | None) -> float | None:
    if not iso_str or len(iso_str) < 16:
        return None
    try:
        t = dt.datetime.fromisoformat(iso_str)
        h = t.hour + t.minute / 60.0 + t.second / 3600.0
    except ValueError:
        try:
            hh, mm = int(iso_str[11:13]), int(iso_str[14:16])
            h = hh + mm / 60.0
        except Exception:
            return None
    if h < 18.0:
        h += 24.0
    return round(h, 2)


def _ms_to_sleep_hour(ms: Any) -> float | None:
    if ms is None:
        return None
    try:
        t = dt.datetime.fromtimestamp(float(ms) / 1000.0, tz=TZ_PLUS8)
    except Exception:
        return None
    h = t.hour + t.minute / 60.0 + t.second / 3600.0
    if h < 18.0:
        h += 24.0
    return round(h, 2)


def _sleep_hour_to_hm(h: float | None) -> str:
    if h is None:
        return "-"
    m_tot = int(round((float(h) % 24.0) * 60.0)) % 1440
    hh, mm = divmod(m_tot, 60)
    return f"{hh:02d}:{mm:02d}"


def _merge_night_stage_intervals(raw_stages_json: str | None) -> list[tuple[str, int, int]]:
    if not raw_stages_json:
        return []
    try:
        parsed = json.loads(raw_stages_json)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    raw_items: list[tuple[str, int, int]] = []
    for st in parsed:
        code = _STAGE_CODE_MAP.get(str(st.get("stage") or ""))
        if not code:
            continue
        s_ms = int(st.get("start_ms") or 0)
        e_ms = int(st.get("end_ms") or s_ms)
        if e_ms > s_ms:
            raw_items.append((code, s_ms, e_ms))
    raw_items.sort(key=lambda x: x[1])

    merged: list[list[Any]] = []
    for code, s_ms, e_ms in raw_items:
        if merged and merged[-1][0] == code and s_ms - merged[-1][2] <= 90_000:
            merged[-1][2] = max(merged[-1][2], e_ms)
        else:
            merged.append([code, s_ms, e_ms])
    return [(item[0], item[1], item[2]) for item in merged]


def _compact_sleep_stage_bars(raw_stages_json: str | None, max_items: int = 24) -> list[list[Any]]:
    intervals = _merge_night_stage_intervals(raw_stages_json)
    if not intervals:
        return []
    bars: list[list[Any]] = []
    for code, s_ms, e_ms in intervals:
        dur = max(1, int(round((e_ms - s_ms) / 60000.0)))
        if bars and bars[-1][0] == code:
            bars[-1][1] += dur
        else:
            bars.append([code, dur])
    while len(bars) > max_items:
        min_idx = min(range(len(bars)), key=lambda i: bars[i][1])
        cur_code, cur_dur = bars.pop(min_idx)
        if min_idx == 0:
            bars[0][1] += cur_dur
        elif min_idx >= len(bars):
            bars[-1][1] += cur_dur
        else:
            if bars[min_idx - 1][1] <= bars[min_idx][1]:
                bars[min_idx - 1][1] += cur_dur
            else:
                bars[min_idx][1] += cur_dur
        # Re-merge consecutive identical codes after absorbing short block
        compact: list[list[Any]] = []
        for c, d in bars:
            if compact and compact[-1][0] == c:
                compact[-1][1] += d
            else:
                compact.append([c, d])
        bars = compact
    return bars


def _sleep_stage_clock_segs(raw_stages_json: str | None, bed_h: float | None = None) -> list[list[Any]]:
    intervals = _merge_night_stage_intervals(raw_stages_json)
    if not intervals:
        return []
    segs: list[list[Any]] = []
    for code, s_ms, e_ms in intervals:
        s_h = _ms_to_sleep_hour(s_ms)
        e_h = _ms_to_sleep_hour(e_ms)
        if s_h is None or e_h is None:
            continue
        if bed_h is not None and s_h < bed_h - 1.5:
            s_h = round(s_h + 24.0, 2)
            e_h = round(e_h + 24.0, 2)
        if e_h < s_h:
            e_h = round(e_h + 24.0, 2)
        if e_h - s_h < 0.03:
            e_h = round(s_h + 0.03, 2)
        if segs and segs[-1][0] == code and s_h - segs[-1][2] <= 0.03:
            segs[-1][2] = max(segs[-1][2], e_h)
        else:
            segs.append([code, s_h, e_h])
    return segs


def _compute_summary_highlights(
    con,
    latest_date: str,
    recent_30d: list[dict[str, Any]],
) -> dict[str, Any]:
    end_d = dt.date.fromisoformat(latest_date)
    by_date = {r["date"]: r for r in recent_30d}

    # 1. Cumulative hourly steps pacing (Today vs 28d average)
    p28_start = str(end_d - dt.timedelta(days=27))
    per_day_hrs: dict[str, list[float]] = {}
    for vr in con.execute(
        """
        SELECT date, ts_iso, value FROM vitals_points
        WHERE metric = 'steps_hourly' AND date >= ? AND date <= ?
        ORDER BY date ASC, ts_ms ASC;
        """,
        (p28_start, latest_date),
    ):
        ds = str(vr["date"])
        try:
            hr = int(vr["ts_iso"][11:13])
        except Exception:
            continue
        if 0 <= hr < 24:
            arr = per_day_hrs.setdefault(ds, [0.0] * 24)
            arr[hr] += float(vr["value"] or 0.0)

    day_dates_with_hourly = sorted(d for d, arr in per_day_hrs.items() if sum(arr) > 0)
    target_date = latest_date if latest_date in per_day_hrs else (day_dates_with_hourly[-1] if day_dates_with_hourly else latest_date)

    cum_by_day: dict[str, list[float]] = {}
    for ds, arr in per_day_hrs.items():
        run = 0.0
        cums: list[float] = []
        for v in arr:
            run += v
            cums.append(run)
        cum_by_day[ds] = cums

    today_row = by_date.get(target_date) or {}
    today_daily_steps = today_row.get("steps")
    today_hr_arr = per_day_hrs.get(target_date)
    if today_hr_arr and any(v > 0 for v in today_hr_arr):
        last_h = max(h for h, v in enumerate(today_hr_arr) if v > 0)
        today_cum = [int(round(v)) for v in cum_by_day[target_date][: last_h + 1]]
        today_steps = int(round(max(float(today_daily_steps or 0), float(today_cum[-1]))))
        if today_cum[-1] != today_steps:
            today_cum[-1] = today_steps
    elif today_daily_steps is not None:
        last_h = 20
        today_steps = int(round(float(today_daily_steps)))
        today_cum = [int(round(today_steps * (h + 1) / (last_h + 1))) for h in range(last_h + 1)]
    else:
        last_h = 0
        today_steps = 0
        today_cum = []

    prior_days = [d for d in day_dates_with_hourly if d != target_date]
    avg_cum: list[int] = []
    if prior_days:
        for h in range(24):
            avg_cum.append(int(round(sum(cum_by_day[d][h] for d in prior_days) / len(prior_days))))

    avg_same_h = avg_cum[last_h] if (avg_cum and 0 <= last_h < len(avg_cum)) else None
    avg_full_day = avg_cum[-1] if avg_cum else (
        int(round(_avg([r.get("steps") for r in recent_30d if r["date"] != target_date], 0) or 0))
    )

    if today_cum and avg_same_h:
        ratio = today_steps / max(avg_same_h, 1)
        if ratio >= 1.12:
            steps_headline = "今天步数高于平时。"
        elif ratio <= 0.88:
            steps_headline = "截止到此时，你走的步数比平时少。"
        else:
            steps_headline = "截止到此时，步数与平时接近。"
        steps_text = f"今日已走 {today_steps:,} 步（截止 {last_h:02d}:59），28 日同时段均值 {avg_same_h:,} 步。"
    elif today_steps > 0:
        steps_headline = f"今日累计 {today_steps:,} 步"
        steps_text = f"日均全天参考约 {avg_full_day:,} 步。"
    else:
        steps_headline = "步数追踪"
        steps_text = "同步今日步行记录后即可显示实时步数节奏对比。"

    steps_pacing = {
        "date": target_date,
        "today_steps": today_steps,
        "avg_at_hour": avg_same_h,
        "avg_full_day": avg_full_day,
        "last_hour": last_h,
        "today_cum": today_cum,
        "avg_cum": avg_cum,
        "headline": steps_headline,
        "text": steps_text,
    }

    # 2 & 3. 7-day average bars for active energy & walking+running distance
    def _build_7d_highlight(field: str, scale: float, digits: int, unit_label: str, noun: str) -> dict[str, Any]:
        days_list = []
        vals: list[float] = []
        for offset in range(6, -1, -1):
            d = end_d - dt.timedelta(days=offset)
            ds = str(d)
            r = by_date.get(ds)
            raw_v = r.get(field) if r else None
            v = round(float(raw_v) / scale, digits) if raw_v is not None else None
            if digits == 0 and v is not None:
                v = int(round(v))
            if v is not None:
                vals.append(float(v))
            days_list.append({
                "date": ds,
                "tick": f"周{WEEKDAY_CN[d.weekday()]}",
                "val": v,
                "is_today": ds == latest_date,
            })
        avg_v = _avg(vals, 0 if digits == 0 else 1)
        if avg_v is not None and digits == 0:
            avg_v = int(round(avg_v))
        today_v = days_list[-1]["val"] if days_list else None
        if avg_v is not None:
            disp = f"{avg_v:,}" if isinstance(avg_v, int) else f"{avg_v}"
            text = f"过去 7 天中，你平均每天{noun}为 {disp} {unit_label}。"
        else:
            text = f"最近 7 天暂无足够{noun}记录。"
        return {
            "avg": avg_v,
            "today_val": today_v,
            "days": days_list,
            "text": text,
        }

    return {
        "steps_pacing": steps_pacing,
        "active_energy_7d": _build_7d_highlight("calories_kcal", 1.0, 0, "千卡", "燃烧的活动能量"),
        "distance_7d": _build_7d_highlight("distance_m", 1000.0, 2, "公里", "步行+跑步距离"),
    }


def _median(vals: list[float]) -> float | None:
    if not vals:
        return None
    s = sorted(float(v) for v in vals)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 == 1 else (s[mid - 1] + s[mid]) / 2.0


def _percentile(sorted_vals: list[float], pct: float) -> float | None:
    if not sorted_vals:
        return None
    idx = max(0, min(len(sorted_vals) - 1, int(round((len(sorted_vals) - 1) * pct))))
    return float(sorted_vals[idx])


def _pick_day_hrv(r: dict[str, Any] | None) -> float | None:
    if not r:
        return None
    v = r.get("hrv_avg") if r.get("hrv_avg") is not None else r.get("hrv_last")
    if v is None and r.get("hrv_min") is not None and r.get("hrv_max") is not None:
        v = (float(r["hrv_min"]) + float(r["hrv_max"])) / 2.0
    return float(v) if v is not None else None


def _compute_readiness(
    days_hist: list[dict[str, Any]],
    latest_night: dict[str, Any] | None,
    tr_series: list[dict[str, Any]],
    latest_date: str,
) -> dict[str, Any]:
    """Compute Daily Readiness (0-100), 4 physiological factors, 14d curve, and overtraining risk."""
    tr_by_date = {pt["date"]: pt for pt in tr_series}
    by_date = {r["date"]: r for r in days_hist}
    sorted_dates = sorted(by_date)
    if not sorted_dates:
        return {"score": None, "status": "数据积累中", "color": "#8E8E93", "factors": [], "trend_14d": [], "advice": "同步更多睡眠与 HRV 记录后即可评估每日准备度。"}

    def _eval_for_date(ds: str, night_ref: dict[str, Any] | None = None) -> tuple[int, list[dict[str, Any]], dict[str, Any]]:
        d_obj = dt.date.fromisoformat(ds)
        win_start = str(d_obj - dt.timedelta(days=27))
        hist = [by_date[k] for k in sorted_dates if win_start <= k <= ds]
        cur = by_date.get(ds) or (hist[-1] if hist else {})
        # If today hasn't synced a morning signal yet, inspect previous day cleanly
        prev_ds = str(d_obj - dt.timedelta(days=1))
        prev_r = by_date.get(prev_ds) or {}

        hrv_cur = _pick_day_hrv(cur)
        if hrv_cur is None and night_ref and night_ref.get("avg_hrv") is not None:
            hrv_cur = float(night_ref["avg_hrv"])
        if hrv_cur is None:
            hrv_cur = _pick_day_hrv(prev_r)
        hrv_hist = sorted(v for v in (_pick_day_hrv(x) for x in hist) if v is not None)

        rhr_cur = float(cur["hr_rest"]) if cur.get("hr_rest") is not None else (float(prev_r["hr_rest"]) if prev_r.get("hr_rest") is not None else None)
        rhr_hist = [float(x["hr_rest"]) for x in hist if x.get("hr_rest") is not None]

        slp_tot = cur.get("sleep_total_min")
        slp_deep = cur.get("sleep_deep_min")
        slp_rem = cur.get("sleep_rem_min")
        slp_score_raw = cur.get("sleep_score")
        if slp_tot is None and night_ref and night_ref.get("date") in (ds, prev_ds):
            slp_tot = night_ref.get("total_sleep_min")
            slp_deep = night_ref.get("deep_min")
            slp_rem = night_ref.get("rem_min")
            slp_score_raw = night_ref.get("sleep_score")
        elif slp_tot is None and prev_r.get("sleep_total_min") is not None:
            slp_tot = prev_r.get("sleep_total_min")
            slp_deep = prev_r.get("sleep_deep_min")
            slp_rem = prev_r.get("sleep_rem_min")
            slp_score_raw = prev_r.get("sleep_score")

        tr_row = tr_by_date.get(ds) or tr_by_date.get(prev_ds) or (tr_series[-1] if tr_series else {})
        factors: list[dict[str, Any]] = []
        meta: dict[str, Any] = {}

        if hrv_cur is not None:
            med_hrv = _median(hrv_hist) or hrv_cur
            iqr = max((_percentile(hrv_hist, 0.75) or med_hrv + 6) - (_percentile(hrv_hist, 0.25) or med_hrv - 6), 5.0)
            s_hrv = int(round(max(32.0, min(99.0, 76.0 + ((hrv_cur - med_hrv) / iqr) * 22.0))))
            diff_hrv = round(hrv_cur - med_hrv, 1)
            factors.append({
                "key": "hrv",
                "label": "HRV 恢复",
                "score": s_hrv,
                "weight": 0.30,
                "display": f"{round(hrv_cur, 1):g} ms",
                "delta": f"{'+' if diff_hrv >= 0 else ''}{diff_hrv} vs 基线",
                "color": "#30D158" if s_hrv >= 72 else ("#FF9F0A" if s_hrv >= 55 else "#FF3B30"),
            })
            meta.update({"hrv": hrv_cur, "med_hrv": med_hrv, "diff_hrv": diff_hrv})

        if rhr_cur is not None:
            med_rhr = _median(rhr_hist) or rhr_cur
            diff_rhr = round(rhr_cur - med_rhr, 1)  # negative is calmer/better
            s_rhr = int(round(max(35.0, min(98.0, 78.0 - diff_rhr * 5.0))))
            factors.append({
                "key": "rhr",
                "label": "静息心率",
                "score": s_rhr,
                "weight": 0.25,
                "display": f"{round(rhr_cur, 1):g} bpm",
                "delta": f"{'+' if diff_rhr >= 0 else ''}{diff_rhr} vs 基线",
                "color": "#30D158" if s_rhr >= 72 else ("#FF9F0A" if s_rhr >= 55 else "#FF3B30"),
            })
            meta.update({"rhr": rhr_cur, "med_rhr": med_rhr, "diff_rhr": diff_rhr})

        if slp_tot is not None and float(slp_tot) > 0:
            tot_m = float(slp_tot)
            dur_sc = min(98.0, (tot_m / 450.0) * 84.0)
            rest_share = ((float(slp_deep or 0) + float(slp_rem or 0)) / max(tot_m, 1.0)) * 100.0
            arch_sc = float(slp_score_raw) if slp_score_raw is not None else min(96.0, 58.0 + rest_share * 0.85)
            s_slp = int(round(max(30.0, min(99.0, 0.65 * dur_sc + 0.35 * arch_sc))))
            factors.append({
                "key": "sleep",
                "label": "睡眠恢复",
                "score": s_slp,
                "weight": 0.25,
                "display": _fmt_hm_cn(tot_m),
                "delta": f"评分 {int(round(slp_score_raw))}" if slp_score_raw is not None else f"深/REM {round(rest_share)}%",
                "color": "#5856D6" if s_slp >= 72 else ("#FF9F0A" if s_slp >= 55 else "#FF3B30"),
            })
            meta.update({"sleep_min": tot_m, "sleep_score": slp_score_raw})

        if tr_row:
            acwr = float(tr_row.get("acwr") or 1.0)
            tsb = float(tr_row.get("tsb") or 0.0)
            if 0.78 <= acwr <= 1.25 and tsb >= -10.0:
                s_load = 88
            elif acwr <= 1.38 and tsb >= -16.0:
                s_load = 72
            elif acwr > 1.50 or tsb < -22.0:
                s_load = 44
            else:
                s_load = 60
            factors.append({
                "key": "load",
                "label": "负荷余额",
                "score": s_load,
                "weight": 0.20,
                "display": f"ACWR {acwr:.2f}",
                "delta": f"TSB {tsb:+.1f}",
                "color": "#30B0C7" if s_load >= 72 else ("#FF9F0A" if s_load >= 56 else "#FF3B30"),
            })
            meta.update({"acwr": acwr, "tsb": tsb, "tr_status": tr_row.get("status")})

        if not factors:
            return 72, [], meta
        tot_w = sum(f["weight"] for f in factors)
        overall = int(round(sum(f["score"] * f["weight"] for f in factors) / max(tot_w, 1e-6)))
        return overall, factors, meta

    score, factors, meta = _eval_for_date(latest_date, latest_night)
    if score >= 82:
        status, color = "状态巅峰", "#30D158"
    elif score >= 68:
        status, color = "恢复良好", "#32ADE6"
    elif score >= 52:
        status, color = "适度调整", "#FF9F0A"
    else:
        status, color = "建议休养", "#FF3B30"

    # 14-day readiness curve
    end_d = dt.date.fromisoformat(latest_date)
    trend_14d: list[dict[str, Any]] = []
    for off in range(13, -1, -1):
        ds = str(end_d - dt.timedelta(days=off))
        if ds in by_date:
            sc_d, _, _ = _eval_for_date(ds, latest_night if ds == latest_date else None)
            trend_14d.append({"date": ds, "score": sc_d})

    # Overtraining / injury risk check
    acwr = meta.get("acwr")
    tsb = meta.get("tsb")
    diff_rhr = meta.get("diff_rhr") or 0.0
    diff_hrv = meta.get("diff_hrv") or 0.0
    recent3_hrv = [_pick_day_hrv(by_date[k]) for k in sorted_dates[-3:]]
    recent3_hrv_clean = [v for v in recent3_hrv if v is not None]
    hrv_3d_drop = bool(
        len(recent3_hrv_clean) == 3
        and meta.get("med_hrv")
        and sum(recent3_hrv_clean) / 3.0 < float(meta["med_hrv"]) - 3.0
    )

    if (acwr is not None and acwr > 1.48) or (tsb is not None and tsb < -16 and (diff_rhr >= 3.0 or hrv_3d_drop)):
        risk_alert = {
            "level": "high",
            "title": "高负荷与恢复警报",
            "text": f"急慢性负荷比 ACWR 达 {acwr:.2f}，叠加自主神经疲劳信号，建议未来 48 小时降为 Z1–Z2 轻松有氧或休跑防伤。",
        }
    elif (acwr is not None and acwr > 1.30) or (diff_rhr >= 3.0 and diff_hrv <= -3.0):
        risk_alert = {
            "level": "warn",
            "title": "负荷爬升注意窗口",
            "text": "近期负荷略高于 4 周基线，或出现静息心率上浮，今日建议控制强度与总跑量。",
        }
    else:
        risk_alert = {
            "level": "ok",
            "title": "负荷与恢复处于平衡区",
            "text": f"ACWR {f'{acwr:.2f}' if acwr is not None else '-'}，静息心率与 HRV 总体稳定在个人基线区间。",
        }

    # Actionable today coaching cue
    parts: list[str] = []
    if meta.get("hrv") is not None:
        parts.append(f"HRV {round(meta['hrv'], 1):g} ms")
    if meta.get("sleep_min") is not None:
        parts.append(f"昨晚睡眠 {_fmt_hm_cn(meta['sleep_min'])}")
    if acwr is not None:
        parts.append(f"ACWR {acwr:.2f}")
    ctx_str = " · ".join(parts)

    if score >= 82:
        rec = "神经与心肺恢复充分，今天适合安排间歇跑、阈值课或长距离质量训练。"
    elif score >= 68:
        rec = "身体准备度稳健，按计划开展中等强度有氧（Z2–Z3）或稳态耐力训练即可。"
    elif score >= 52:
        rec = "体能储备有所消耗，今天优先轻松慢跑（Z1–Z2）或核心拉伸，避免极限冲刺。"
    else:
        rec = "恢复信号明显偏低，建议以散步、泡沫轴放松与早睡为主，优先偿还睡眠与恢复债。"

    advice = f"{ctx_str + '。' if ctx_str else ''}{rec}"
    return {
        "date": latest_date,
        "score": score,
        "status": status,
        "color": color,
        "factors": factors,
        "trend_14d": trend_14d,
        "risk_alert": risk_alert,
        "advice": advice,
    }


def _compute_weekly_coach(
    latest_date: str,
    days_rows: list[dict[str, Any]],
    workouts_rows: list[dict[str, Any]],
    tr_series: list[dict[str, Any]],
    readiness: dict[str, Any],
) -> dict[str, Any]:
    """Compute 7d-vs-prior-7d training summary and actionable Chinese coaching tips."""
    end_d = dt.date.fromisoformat(latest_date)
    w_cur_start = str(end_d - dt.timedelta(days=6))
    w_prev_start = str(end_d - dt.timedelta(days=13))
    w_prev_end = str(end_d - dt.timedelta(days=7))

    cur_days = [r for r in days_rows if w_cur_start <= r["date"] <= latest_date]
    prev_days = [r for r in days_rows if w_prev_start <= r["date"] <= w_prev_end]
    cur_wos = [w for w in workouts_rows if w_cur_start <= w["date"] <= latest_date]
    prev_wos = [w for w in workouts_rows if w_prev_start <= w["date"] <= w_prev_end]

    dist_km = round(sum(float(w.get("distance_m") or 0) for w in cur_wos) / 1000.0, 1)
    prev_dist_km = round(sum(float(w.get("distance_m") or 0) for w in prev_wos) / 1000.0, 1)
    dur_min = round(sum(float(w.get("duration_s") or 0) for w in cur_wos) / 60.0, 0)
    avg_slp = _avg([r.get("sleep_total_min") for r in cur_days], 0)
    avg_hrv = _avg([_pick_day_hrv(r) for r in cur_days], 1)
    avg_rhr = _avg([r.get("hr_rest") for r in cur_days], 1)

    tr_cur = [pt for pt in tr_series if w_cur_start <= pt["date"] <= latest_date]
    tr_prev = [pt for pt in tr_series if w_prev_start <= pt["date"] <= w_prev_end]
    load_7d = round(sum(float(pt.get("load") or 0) for pt in tr_cur), 0)
    prev_load_7d = round(sum(float(pt.get("load") or 0) for pt in tr_prev), 0)
    load_delta_pct = round(((load_7d - prev_load_7d) / prev_load_7d) * 100.0, 1) if prev_load_7d > 0 else None

    tips: list[str] = []
    if load_delta_pct is not None:
        if load_delta_pct > 15.0:
            tips.append(f"近 7 天训练负荷环比上涨 +{load_delta_pct}%（高于 10–15% 安全增幅），下周建议维持或回调跑量。")
        elif load_delta_pct < -20.0 and len(cur_wos) > 0:
            tips.append(f"近 7 天负荷环比下降 {abs(load_delta_pct)}%，正适合巩固恢复或按准备度恢复 1 次节奏跑。")
        else:
            tips.append(f"近 7 天完成 {len(cur_wos)} 次训练共 {dist_km} 公里，周负荷增幅控制健康（{load_delta_pct:+.1f}%）。")
    else:
        tips.append(f"近 7 天累计训练 {len(cur_wos)} 次（{dist_km} 公里 / {int(dur_min)} 分钟），保持每周 3–4 次稳步节奏。")

    if avg_slp is not None:
        if avg_slp < 420:
            tips.append(f"本周日均睡眠 {_fmt_hm_cn(avg_slp)}，较 7.5 小时目标偏短，提早 30 分钟熄灯可显著提升次日 HRV。")
        else:
            tips.append(f"本周日均睡眠 {_fmt_hm_cn(avg_slp)}，恢复底座稳固（均静息心率 {avg_rhr or '-'} 次/分）。")

    if readiness.get("score") is not None:
        tips.append(f"今日状态准备度 {readiness['score']} 分（{readiness['status']}）：{readiness['advice'].split('。')[-2] if '。' in readiness['advice'] else readiness['advice']}。")

    return {
        "range": f"{w_cur_start[5:]} – {latest_date[5:]}",
        "workouts_count": len(cur_wos),
        "distance_km": dist_km,
        "prev_distance_km": prev_dist_km,
        "duration_min": int(dur_min),
        "load_7d": int(load_7d),
        "load_delta_pct": load_delta_pct,
        "avg_sleep_min": avg_slp,
        "avg_hrv": avg_hrv,
        "avg_rhr": avg_rhr,
        "tips": tips[:3],
    }


def _compute_workout_biomechanics(
    row: dict[str, Any],
    raw_pts: list[Any],
    hr_samples: list[tuple[int, float]],
    cad_series: list[dict[str, Any]],
    post_series: list[dict[str, Any]],
    splits: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Compute Efficiency Factor (EF), Aerobic Decoupling (Pw:Hr), pacing split & late-run form drift."""
    dur_s = float(row.get("duration_s") or 0)
    dist_m = float(row.get("distance_m") or 0)
    hr_avg = float(row.get("hr_avg") or 0)
    if hr_avg <= 30 and hr_samples:
        hr_avg = sum(v for _, v in hr_samples) / len(hr_samples)
    if dur_s < 180 or dist_m < 300 or hr_avg <= 30:
        return None

    speed_m_per_min = dist_m / (dur_s / 60.0)
    ef = round(speed_m_per_min / hr_avg, 2)

    decoupling_pct: float | None = None
    h1_pace_s: float | None = None
    h2_pace_s: float | None = None

    # Method 1: Per-point GPS + HR halves (excluding 60s warmup when duration >= 480s)
    if len(raw_pts) >= 18:
        t0 = int(raw_pts[0][0])
        t_end = int(raw_pts[-1][0])
        warm_ms = t0 + 60_000 if (t_end - t0) >= 480_000 else t0
        pts_a = [p for p in raw_pts if int(p[0]) >= warm_ms]
        if len(pts_a) >= 12:
            t_mid = (int(pts_a[0][0]) + int(pts_a[-1][0])) / 2.0
            h1 = [p for p in pts_a if int(p[0]) <= t_mid]
            h2 = [p for p in pts_a if int(p[0]) >= t_mid]

            def _seg_ef(pts_seg: list[Any]) -> tuple[float | None, float | None]:
                if len(pts_seg) < 4:
                    return None, None
                sd = 0.0
                for idx in range(1, len(pts_seg)):
                    sd += _haversine_m(pts_seg[idx - 1][1], pts_seg[idx - 1][2], pts_seg[idx][1], pts_seg[idx][2])
                dt_min = (int(pts_seg[-1][0]) - int(pts_seg[0][0])) / 60000.0
                hrs = [float(p[4]) for p in pts_seg if len(p) > 4 and p[4] is not None and float(p[4]) > 35]
                if not hrs and hr_samples:
                    s_t, e_t = int(pts_seg[0][0]), int(pts_seg[-1][0])
                    hrs = [hv for ts, hv in hr_samples if s_t <= ts <= e_t]
                if sd < 150 or dt_min < 1.5 or not hrs:
                    return None, None
                avg_h = sum(hrs) / len(hrs)
                pace_s = (dt_min * 60.0) / (sd / 1000.0)
                return (sd / dt_min) / avg_h, pace_s

            ef1, p1 = _seg_ef(h1)
            ef2, p2 = _seg_ef(h2)
            if ef1 and ef2 and ef1 > 0:
                decoupling_pct = round(((ef1 - ef2) / ef1) * 100.0, 1)
                h1_pace_s = round(p1, 0) if p1 else None
                h2_pace_s = round(p2, 0) if p2 else None

    # Fallback: Splits halves when GPS HR track wasn't embedded
    if decoupling_pct is None and len(splits) >= 2:
        full_sp = [s for s in splits if float(s.get("sp") or 0) > 0 and float(s.get("sd") or 0) >= 25000]
        if len(full_sp) >= 2:
            mid_i = len(full_sp) // 2
            sp1, sp2 = full_sp[:mid_i], full_sp[mid_i:]

            def _sp_stats(grp: list[dict[str, Any]]) -> tuple[float | None, float | None]:
                paces = [float(x["sp"]) for x in grp]
                hrs = [float(x["shr"]) for x in grp if x.get("shr") and float(x["shr"]) > 35]
                avg_p = sum(paces) / len(paces)
                spd_m_min = (1000.0 / avg_p) * 60.0 if avg_p > 0 else 0
                if not hrs or spd_m_min <= 0:
                    return None, avg_p
                return spd_m_min / (sum(hrs) / len(hrs)), avg_p

            ef1, p1 = _sp_stats(sp1)
            ef2, p2 = _sp_stats(sp2)
            if p1 and p2:
                h1_pace_s, h2_pace_s = round(p1, 0), round(p2, 0)
            if ef1 and ef2 and ef1 > 0:
                decoupling_pct = round(((ef1 - ef2) / ef1) * 100.0, 1)

    if decoupling_pct is not None:
        if decoupling_pct <= 5.0:
            dec_lbl, dec_col = "有氧稳健", "#30D158"
        elif decoupling_pct <= 8.0:
            dec_lbl, dec_col = "轻度漂移", "#FF9F0A"
        else:
            dec_lbl, dec_col = "后程漂移", "#FF3B30"
    else:
        dec_lbl, dec_col = "数据不足", "#8E8E93"

    pace_strategy = "配速稳定"
    if h1_pace_s and h2_pace_s:
        diff_p = h2_pace_s - h1_pace_s
        if diff_p <= -5.0:
            pace_strategy = "负配速 · 后程加速"
        elif diff_p >= 8.0:
            pace_strategy = "正配速 · 前快后慢"
        else:
            pace_strategy = "均匀配速"

    # Early (first 1/3) vs Late (final 1/3) fatigue drift across telemetry series
    drift_rows: list[dict[str, Any]] = []

    def _add_drift(items: list[dict[str, Any]], key: str, label: str, unit: str, digits: int, lower_better: bool | None) -> None:
        vals = [float(x[key]) for x in items if x.get(key) is not None]
        if len(vals) < 6:
            return
        k = max(2, len(vals) // 3)
        early = round(sum(vals[:k]) / k, digits)
        late = round(sum(vals[-k:]) / k, digits)
        delta = round(late - early, digits)
        sent = "neutral"
        if lower_better is True:
            sent = "warn" if delta > (2 if digits == 0 else 0.3) else "good"
        elif lower_better is False:
            sent = "warn" if delta < -2 else "good"
        else:
            sent = "warn" if abs(late - 50.0) > abs(early - 50.0) + 0.5 else "good"
        fmt = (lambda v: f"{int(round(v))}") if digits == 0 else (lambda v: f"{v:.{digits}f}")
        drift_rows.append({
            "label": label,
            "early": f"{fmt(early)} {unit}",
            "late": f"{fmt(late)} {unit}",
            "delta_text": f"{'+' if delta > 0 else ''}{fmt(delta)} {unit}",
            "sentiment": sent,
        })

    if len(hr_samples) >= 6:
        _add_drift([{"hr": v} for _, v in hr_samples], "hr", "心率漂移", "bpm", 0, True)
    _add_drift(cad_series, "spm", "步频维持", "spm", 0, False)
    _add_drift(post_series, "gct_ms", "触地时间", "ms", 0, True)
    _add_drift(post_series, "vo_cm", "垂直振幅", "cm", 1, True)
    _add_drift(post_series, "gtb_left", "左脚触地占比", "%", 1, None)

    verdict_parts = [f"有氧效率系数 EF {ef}"]
    if decoupling_pct is not None:
        verdict_parts.append(
            f"前后半程有氧解耦 {decoupling_pct:+.1f}%（{dec_lbl}）"
        )
    if h1_pace_s and h2_pace_s:
        verdict_parts.append(f"前半程 {_fmt_pace_cn(h1_pace_s)} → 后半程 {_fmt_pace_cn(h2_pace_s)}")
    verdict = "，".join(verdict_parts) + "。"

    return {
        "ef": ef,
        "decoupling_pct": decoupling_pct,
        "decoupling_label": dec_lbl,
        "decoupling_color": dec_col,
        "pace_strategy": pace_strategy,
        "first_half_pace": _fmt_pace_cn(h1_pace_s) if h1_pace_s else None,
        "second_half_pace": _fmt_pace_cn(h2_pace_s) if h2_pace_s else None,
        "drift_rows": drift_rows,
        "verdict": verdict,
    }


def get_pro_insights(db_path: str | Path) -> dict[str, Any]:
    """Return Readiness, 80/20 Polarization, 365d Heatmap, Sleep Rhythm/Debt, Correlations & Aerobic Lab."""
    if not Path(db_path).exists():
        return {"empty": True}

    con = open_health_db(db_path, readonly=True)
    try:
        all_days = [dict(r) for r in con.execute("SELECT * FROM daily_summary ORDER BY date ASC;")]
        if not all_days:
            return {"empty": True}
        latest_date = str(all_days[-1]["date"])
        end_d = dt.date.fromisoformat(latest_date)

        all_nights = [
            dict(r)
            for r in con.execute(
                """
                SELECT date, start_ms, end_ms, start_iso, end_iso, total_sleep_min,
                       deep_min, light_min, rem_min, sleep_score, sleep_latency_min, avg_hr, avg_hrv
                FROM sleep_sessions
                WHERE session_type = 'night'
                ORDER BY start_ms ASC;
                """
            )
        ]
        all_workouts = [
            dict(r)
            for r in con.execute(
                """
                SELECT start_ms, end_ms, date, duration_s, sport_name, distance_m, calories_kcal,
                       hr_avg, hr_max, pace_avg_s_per_km, avg_gct_ms, has_gps, running_dynamics_json, splits_json, track_points_gz
                FROM workouts
                ORDER BY start_ms ASC;
                """
            )
        ]
        tr_series = _compute_training_series(con)
    finally:
        con.close()

    recent_30d = [r for r in all_days if r["date"] >= str(end_d - dt.timedelta(days=29))]
    latest_night = all_nights[-1] if all_nights else None
    readiness = _compute_readiness(all_days, latest_night, tr_series, latest_date)
    weekly_coach = _compute_weekly_coach(latest_date, all_days, all_workouts, tr_series, readiness)

    # 1. 80/20 Polarized Intensity Distribution (30d & 90d)
    rhr_vals_30 = [float(r["hr_rest"]) for r in recent_30d if r.get("hr_rest") is not None]
    rhr_ref = round(sum(rhr_vals_30) / len(rhr_vals_30), 1) if rhr_vals_30 else 60.0
    max_hrs_all = [float(w["hr_max"]) for w in all_workouts if w.get("hr_max") is not None]
    hrmax_ref = max([*(max_hrs_all or [188.0]), rhr_ref + 40.0, 175.0])
    hrr_ref = max(hrmax_ref - rhr_ref, 30.0)

    def _build_polarization(window_days: int) -> dict[str, Any]:
        w_start = str(end_d - dt.timedelta(days=window_days - 1))
        wos = [w for w in all_workouts if w["date"] >= w_start]
        z_sec = {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0, 5: 0.0}
        for w in wos:
            used_track = False
            if w.get("track_points_gz"):
                try:
                    raw_pts = json.loads(gzip.decompress(w["track_points_gz"]).decode("utf-8"))
                    hrs = [(int(p[0]), float(p[4])) for p in raw_pts if len(p) > 4 and p[4] is not None and float(p[4]) > 35]
                    if len(hrs) >= 5:
                        used_track = True
                        for i, (t_ms, hv) in enumerate(hrs):
                            dt_s = max(1.0, min(60.0, (hrs[i + 1][0] - t_ms) / 1000.0)) if i < len(hrs) - 1 else 5.0
                            z_sec[_classify_hr_zone(hv, rhr_ref, hrr_ref)] += dt_s
                except Exception:
                    pass
            if not used_track:
                dur_s = float(w.get("duration_s") or 0)
                if dur_s > 0:
                    hr_val = float(w.get("hr_avg") or (rhr_ref + 0.62 * hrr_ref))
                    z_sec[_classify_hr_zone(hr_val, rhr_ref, hrr_ref)] += dur_s

        tot_s = max(sum(z_sec.values()), 1.0)
        z_meta = [
            (1, "热身恢复", "#5AC8FA"),
            (2, "燃脂耐力", "#30D158"),
            (3, "有氧提升", "#FFD60A"),
            (4, "无氧阈值", "#FF9F0A"),
            (5, "极限冲刺", "#FF375F"),
        ]
        zones = [
            {
                "zone": zid,
                "name": zname,
                "color": zcol,
                "duration_min": round(z_sec[zid] / 60.0, 1),
                "pct": round(z_sec[zid] / tot_s * 100.0, 1),
            }
            for zid, zname, zcol in z_meta
        ]
        low_pct = round((z_sec[1] + z_sec[2]) / tot_s * 100.0, 1)
        mid_pct = round(z_sec[3] / tot_s * 100.0, 1)
        high_pct = round((z_sec[4] + z_sec[5]) / tot_s * 100.0, 1)
        if sum(z_sec.values()) < 60:
            diag = "该周期内带心率记录的训练较少。"
        elif low_pct >= 72.0 and high_pct <= 28.0:
            diag = f"符合理想 80/20 极化模型（低强度有氧 {low_pct}% · 高强度 {high_pct}%），有氧基础与恢复比俱佳。"
        elif mid_pct >= 35.0:
            diag = f"区间 3 灰区偏高（{mid_pct}%），容易只累积疲劳不破上限；建议把慢跑再降速到 Z2，重点课再拉到 Z4+。"
        else:
            diag = f"中高强度占比偏多（Z3–Z5 合计 {round(mid_pct + high_pct, 1)}%），建议增加 1–2 次纯粹 Z1–Z2 恢复慢跑。"
        return {
            "days": window_days,
            "workouts_count": len(wos),
            "total_min": round(sum(z_sec.values()) / 60.0, 0),
            "low_pct": low_pct,
            "mid_pct": mid_pct,
            "high_pct": high_pct,
            "zones": zones,
            "diagnosis": diag,
        }

    polarization = {
        "30d": _build_polarization(30),
        "90d": _build_polarization(90),
    }

    # 2. Full-Year Contribution Heatmap (52 weeks aligned Mon-Sun ending end_d)
    end_mon = end_d - dt.timedelta(days=end_d.weekday())
    hm_start = end_mon - dt.timedelta(weeks=51)
    days_by_date = {r["date"]: r for r in all_days}
    tr_by_date = {pt["date"]: pt for pt in tr_series}
    wos_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for w in all_workouts:
        wos_by_date[w["date"]].append(w)

    hm_cells: list[dict[str, Any]] = []
    cur_d = hm_start
    total_km_yr = 0.0
    total_wos_yr = 0
    active_days_yr = 0
    cur_streak = 0
    longest_streak = 0
    run_streak = 0
    while cur_d <= end_d:
        ds = str(cur_d)
        wlist = wos_by_date.get(ds, [])
        tr_d = tr_by_date.get(ds) or {}
        day_r = days_by_date.get(ds) or {}
        load_v = float(tr_d.get("load") or 0.0)
        dist_km = round(sum(float(w.get("distance_m") or 0) for w in wlist) / 1000.0, 2)
        dur_m = round(sum(float(w.get("duration_s") or 0) for w in wlist) / 60.0, 0)
        if wlist:
            active_days_yr += 1
            total_wos_yr += len(wlist)
            total_km_yr += dist_km
            run_streak += 1
            longest_streak = max(longest_streak, run_streak)
        else:
            run_streak = 0
        if not wlist and load_v < 4:
            lvl = 0
        elif load_v <= 25:
            lvl = 1
        elif load_v <= 60:
            lvl = 2
        elif load_v <= 110:
            lvl = 3
        else:
            lvl = 4
        hm_cells.append({
            "date": ds,
            "week_idx": (cur_d - hm_start).days // 7,
            "dow": cur_d.weekday(),
            "level": lvl,
            "load": round(load_v, 1),
            "workouts": len(wlist),
            "distance_km": dist_km,
            "duration_min": int(dur_m),
            "sleep_min": round(float(day_r["sleep_total_min"]), 0) if day_r.get("sleep_total_min") is not None else None,
            "hrv": round(float(_pick_day_hrv(day_r)), 1) if _pick_day_hrv(day_r) is not None else None,
        })
        cur_d += dt.timedelta(days=1)

    # Active days streak backwards from end_d (or yesterday if no workout logged yet today)
    check_d = end_d if wos_by_date.get(str(end_d)) else (end_d - dt.timedelta(days=1))
    while wos_by_date.get(str(check_d)):
        cur_streak += 1
        check_d -= dt.timedelta(days=1)

    heatmap = {
        "start_date": str(hm_start),
        "end_date": latest_date,
        "weeks": 52,
        "sessions": [{"id": w["start_ms"], "date": w["date"], "sport": w["sport_name"],
                      "load": _calc_workout_load(w, _safe_json_dict(w.get("running_dynamics_json")))}
                     for w in all_workouts if w["date"] >= str(hm_start - dt.timedelta(days=28))],
        "active_days": active_days_yr,
        "total_workouts": total_wos_yr,
        "total_km": round(total_km_yr, 1),
        "longest_streak": longest_streak,
        "current_streak": cur_streak,
        "cells": hm_cells,
    }

    # 3. Sleep Regularity Index (SRI) + 14-day Sleep Debt
    night_by_date: dict[str, dict[str, Any]] = {}
    for nr in all_nights:
        ds = str(nr["date"])
        prev = night_by_date.get(ds)
        if not prev or float(nr.get("total_sleep_min") or 0) >= float(prev.get("total_sleep_min") or 0):
            night_by_date[ds] = nr

    recent_nights_30 = [n for n in all_nights if n["date"] >= str(end_d - dt.timedelta(days=29))]
    bed_hrs_30: list[float] = []
    wake_hrs_30: list[float] = []
    wkday_beds: list[float] = []
    wkend_beds: list[float] = []
    for nr in recent_nights_30:
        d_row = days_by_date.get(nr["date"]) or {}
        b_h = _iso_to_sleep_hour(d_row.get("sleep_fall_asleep_iso") or nr.get("start_iso")) or _ms_to_sleep_hour(nr.get("start_ms"))
        w_h = _iso_to_sleep_hour(d_row.get("sleep_wakeup_iso") or nr.get("end_iso")) or _ms_to_sleep_hour(nr.get("end_ms"))
        if b_h is not None:
            bed_hrs_30.append(b_h)
            wd = dt.date.fromisoformat(nr["date"]).weekday()
            if wd in (5, 6):
                wkend_beds.append(b_h)
            else:
                wkday_beds.append(b_h)
        if w_h is not None:
            if b_h is not None and w_h < b_h:
                w_h += 24.0
            wake_hrs_30.append(w_h)

    def _std(arr: list[float]) -> float:
        if len(arr) < 2:
            return 0.0
        mu = sum(arr) / len(arr)
        return math.sqrt(sum((x - mu) ** 2 for x in arr) / len(arr))

    comb_std = (_std(bed_hrs_30) + _std(wake_hrs_30)) / 2.0
    sri_score = int(round(max(20.0, min(100.0, 100.0 - max(0.0, comb_std - 0.15) * 32.0)))) if len(bed_hrs_30) >= 4 else None
    avg_wkday_bed = _avg(wkday_beds, 2)
    avg_wkend_bed = _avg(wkend_beds, 2)
    social_jetlag_h = round(abs(avg_wkend_bed - avg_wkday_bed), 1) if (avg_wkday_bed is not None and avg_wkend_bed is not None) else None

    nightly_balance_14d: list[dict[str, Any]] = []
    cum_debt = 0.0
    for off in range(13, -1, -1):
        d = end_d - dt.timedelta(days=off)
        ds = str(d)
        r = days_by_date.get(ds) or {}
        ns = night_by_date.get(ds) or {}
        tot = r.get("sleep_total_min") if r.get("sleep_total_min") is not None else ns.get("total_sleep_min")
        if tot is not None:
            delta_m = int(round(float(tot) - 480.0))
            cum_debt = max(0.0, cum_debt - delta_m)
        else:
            delta_m = None
        nightly_balance_14d.append({
            "date": ds,
            "tick": f"周{WEEKDAY_CN[d.weekday()]}",
            "total_min": round(float(tot), 0) if tot is not None else None,
            "delta_min": delta_m,
            "cum_debt_min": int(round(cum_debt)),
        })

    debt_14d_min = int(round(cum_debt))
    if debt_14d_min > 360:
        sr_verdict = f"近两周累计睡眠债 {round(debt_14d_min / 60.0, 1)} 小时，建议本周每天提早半小时入睡逐步回补。"
    elif social_jetlag_h is not None and social_jetlag_h >= 1.2:
        sr_verdict = f"规律性评分 {sri_score or '-'}，但周末与工作日入睡差 {social_jetlag_h} 小时（社会时差），固定起床时刻可快速提效。"
    else:
        sr_verdict = f"作息规律性评分 {sri_score or '-'}，睡眠节律保持平稳（近 14 日累计睡眠债 {_fmt_hm_cn(debt_14d_min)}）。"

    sleep_rhythm = {
        "sri_score": sri_score,
        "bed_std_min": int(round(_std(bed_hrs_30) * 60.0)),
        "wake_std_min": int(round(_std(wake_hrs_30) * 60.0)),
        "weekday_bed_hm": _sleep_hour_to_hm(avg_wkday_bed),
        "weekend_bed_hm": _sleep_hour_to_hm(avg_wkend_bed),
        "social_jetlag_h": social_jetlag_h,
        "debt_14d_min": debt_14d_min,
        "nightly_balance_14d": nightly_balance_14d,
        "verdict": sr_verdict,
    }

    # 4. Personal Cross-Metric Correlations (full history two-group comparisons)
    correlations: list[dict[str, Any]] = []
    # Pair A: Early bedtime vs Late bedtime -> Next-day HRV & Deep sleep
    bed_pairs: list[tuple[float, float | None, float | None]] = []
    for ds, r in days_by_date.items():
        ns = night_by_date.get(ds) or {}
        b_h = _iso_to_sleep_hour(r.get("sleep_fall_asleep_iso") or ns.get("start_iso")) or _ms_to_sleep_hour(ns.get("start_ms"))
        if b_h is None:
            continue
        hrv_v = _pick_day_hrv(r)
        deep_v = r.get("sleep_deep_min") if r.get("sleep_deep_min") is not None else ns.get("deep_min")
        if hrv_v is not None or deep_v is not None:
            bed_pairs.append((b_h, float(hrv_v) if hrv_v is not None else None, float(deep_v) if deep_v is not None else None))

    if len(bed_pairs) >= 12:
        med_bed = _median([x[0] for x in bed_pairs]) or 24.0
        early_grp = [x for x in bed_pairs if x[0] <= med_bed and x[1] is not None]
        late_grp = [x for x in bed_pairs if x[0] > med_bed and x[1] is not None]
        if len(early_grp) >= 5 and len(late_grp) >= 5:
            e_hrv = round(sum(x[1] for x in early_grp) / len(early_grp), 1)
            l_hrv = round(sum(x[1] for x in late_grp) / len(late_grp), 1)
            e_deep = _avg([x[2] for x in early_grp if x[2] is not None], 0)
            l_deep = _avg([x[2] for x in late_grp if x[2] is not None], 0)
            med_hm = _sleep_hour_to_hm(med_bed)
            diff_h = round(e_hrv - l_hrv, 1)
            mx = max(e_hrv, l_hrv, 1.0)
            correlations.append({
                "key": "bedtime_hrv",
                "title": "就寝时刻 vs 次日 HRV",
                "badge": f"分界 {med_hm}",
                "insight": f"{med_hm} 前入睡日平均 HRV 为 {e_hrv} ms（深睡 {e_deep or '-'}m），比晚睡日{'高' if diff_h >= 0 else '低'} {abs(diff_h)} ms。",
                "accent": "#5856D6",
                "bars": [
                    {"label": f"{med_hm} 前早睡 ({len(early_grp)}晚)", "display": f"{e_hrv} ms", "pct": round(max(18.0, e_hrv / mx * 100.0), 1), "primary": True},
                    {"label": f"{med_hm} 后晚睡 ({len(late_grp)}晚)", "display": f"{l_hrv} ms", "pct": round(max(18.0, l_hrv / mx * 100.0), 1), "primary": False},
                ],
            })

    # Pair B: Workout Day vs Rest Day -> Same-night Deep Sleep
    wo_deep: list[float] = []
    rest_deep: list[float] = []
    for ds, r in days_by_date.items():
        ns = night_by_date.get(ds) or {}
        d_m = r.get("sleep_deep_min") if r.get("sleep_deep_min") is not None else ns.get("deep_min")
        if d_m is None or float(d_m) <= 0:
            continue
        prev_ds = str(dt.date.fromisoformat(ds) - dt.timedelta(days=1))
        has_wo = any(float(w.get("duration_s") or 0) >= 600 for w in wos_by_date.get(prev_ds, []))
        (wo_deep if has_wo else rest_deep).append(float(d_m))
    if len(wo_deep) >= 5 and len(rest_deep) >= 5:
        w_d = round(sum(wo_deep) / len(wo_deep), 0)
        r_d = round(sum(rest_deep) / len(rest_deep), 0)
        diff_d = int(round(w_d - r_d))
        mx = max(w_d, r_d, 1.0)
        correlations.append({
            "key": "workout_deep",
            "title": "训练日 vs 休息日 · 当晚深睡",
            "badge": f"{len(wo_deep)}+{len(rest_deep)}晚",
            "insight": f"有体能训练当晚平均深睡 {int(w_d)} 分钟，比无训练日{'多' if diff_d >= 0 else '少'} {abs(diff_d)} 分钟。",
            "accent": "#28CD41",
            "bars": [
                {"label": f"训练日当晚 ({len(wo_deep)}晚)", "display": f"{int(w_d)} 分钟", "pct": round(max(18.0, w_d / mx * 100.0), 1), "primary": True},
                {"label": f"休息日当晚 ({len(rest_deep)}晚)", "display": f"{int(r_d)} 分钟", "pct": round(max(18.0, r_d / mx * 100.0), 1), "primary": False},
            ],
        })

    # Pair C: Sufficient Sleep (>=7.5h) vs Short Sleep (<6.7h) -> Next-day RHR
    good_rhr: list[float] = []
    short_rhr: list[float] = []
    for ds, r in days_by_date.items():
        if r.get("hr_rest") is None:
            continue
        tot_m = r.get("sleep_total_min")
        if tot_m is None:
            continue
        if float(tot_m) >= 450:
            good_rhr.append(float(r["hr_rest"]))
        elif float(tot_m) < 400:
            short_rhr.append(float(r["hr_rest"]))
    if len(good_rhr) >= 5 and len(short_rhr) >= 5:
        g_v = round(sum(good_rhr) / len(good_rhr), 1)
        s_v = round(sum(short_rhr) / len(short_rhr), 1)
        diff_r = round(s_v - g_v, 1)
        mx = max(g_v, s_v, 1.0)
        correlations.append({
            "key": "sleep_rhr",
            "title": "睡眠充足度 vs 次日静息心率",
            "badge": "恢复效率",
            "insight": f"睡足 7.5 小时后静息心率均值 {g_v} bpm，熬夜少睡（<6.7h）后会升高 {diff_r:+.1f} bpm。",
            "accent": "#FF2D55",
            "bars": [
                {"label": f"睡足 ≥7.5 小时 ({len(good_rhr)}天)", "display": f"{g_v} bpm", "pct": round(max(18.0, g_v / mx * 100.0), 1), "primary": True},
                {"label": f"少睡 <6.7 小时 ({len(short_rhr)}天)", "display": f"{s_v} bpm", "pct": round(max(18.0, s_v / mx * 100.0), 1), "primary": False},
            ],
        })

    # 5. Aerobic Efficiency Lab (EF longitudinal trend + Decoupling summary)
    run_wos = [
        w for w in all_workouts
        if (w.get("distance_m") or 0) >= 800 and (w.get("duration_s") or 0) >= 240 and (w.get("hr_avg") or 0) > 40
    ]
    preferred_runs = [w for w in run_wos if "跑" in str(w.get("sport_name") or "")]
    lab_pool = preferred_runs if len(preferred_runs) >= 5 else run_wos
    recent_pool = lab_pool[-28:]

    ef_series: list[dict[str, Any]] = []
    for idx, w in enumerate(recent_pool):
        dur_s = float(w["duration_s"])
        dist_m = float(w["distance_m"])
        hr_v = float(w["hr_avg"])
        ef_val = round((dist_m / (dur_s / 60.0)) / hr_v, 2)
        dec_pct: float | None = None
        if idx >= len(recent_pool) - 18 and (w.get("track_points_gz") or w.get("splits_json")):
            raw_pts = []
            if w.get("track_points_gz"):
                try:
                    raw_pts = json.loads(gzip.decompress(w["track_points_gz"]).decode("utf-8"))
                except Exception:
                    raw_pts = []
            sp_list = []
            if w.get("splits_json"):
                try:
                    sp_list = json.loads(w["splits_json"])
                except Exception:
                    sp_list = []
            bm = _compute_workout_biomechanics(w, raw_pts, [], [], [], sp_list)
            if bm:
                dec_pct = bm.get("decoupling_pct")
        ef_series.append({
            "workout_id": w["start_ms"],
            "date": w["date"],
            "sport_name": w["sport_name"],
            "distance_km": round(dist_m / 1000.0, 2),
            "duration_min": round(dur_s / 60.0, 1),
            "pace_s": round(w["pace_avg_s_per_km"], 0) if w.get("pace_avg_s_per_km") else None,
            "hr_avg": round(hr_v, 0),
            "ef": ef_val,
            "decoupling_pct": dec_pct,
            "gct_ms": round(float(w["avg_gct_ms"]), 0) if w.get("avg_gct_ms") else None,
        })

    w30_cut = str(end_d - dt.timedelta(days=29))
    w60_cut = str(end_d - dt.timedelta(days=59))
    ef_30 = [pt["ef"] for pt in ef_series if pt["date"] >= w30_cut]
    ef_prev = [pt["ef"] for pt in ef_series if w60_cut <= pt["date"] < w30_cut]
    latest_ef = ef_series[-1]["ef"] if ef_series else None
    ef_30d_avg = _avg(ef_30, 2) if ef_30 else _avg([pt["ef"] for pt in ef_series], 2)
    ef_prev30_avg = _avg(ef_prev, 2)
    ef_delta_pct = round(((ef_30d_avg - ef_prev30_avg) / ef_prev30_avg) * 100.0, 1) if (ef_30d_avg and ef_prev30_avg and ef_prev30_avg > 0) else None
    decs = [pt["decoupling_pct"] for pt in ef_series if pt.get("decoupling_pct") is not None]
    avg_dec = _avg(decs, 1)

    if ef_series:
        dec_txt = f"平均有氧解耦 {avg_dec:+.1f}%" if avg_dec is not None else "追踪持续积累中"
        delta_txt = f"，较上月 {'+' if ef_delta_pct >= 0 else ''}{ef_delta_pct}%" if ef_delta_pct is not None else ""
        aerobic_summary_txt = f"近 30 天有氧效率系数均值为 {ef_30d_avg}{delta_txt}；{dec_txt}（同一心率下跑得更快即 EF 提升）。"
    else:
        aerobic_summary_txt = "积累户外跑步心率与距离记录后即可生成有氧效率趋势。"

    aerobic_lab = {
        "latest_ef": latest_ef,
        "ef_30d_avg": ef_30d_avg,
        "ef_delta_pct": ef_delta_pct,
        "avg_decoupling_pct": avg_dec,
        "summary_text": aerobic_summary_txt,
        "ef_series": ef_series,
    }

    return {
        "empty": False,
        "date": latest_date,
        "readiness": readiness,
        "weekly_coach": weekly_coach,
        "polarization": polarization,
        "heatmap": heatmap,
        "sleep_rhythm": sleep_rhythm,
        "correlations": correlations,
        "aerobic_lab": aerobic_lab,
    }


def _summarize_window_kpis(days_rows: list[dict[str, Any]], workouts_rows: list[dict[str, Any]]) -> dict[str, float | None]:
    total_emo = sum((r.get("emotion_total_count") or 0) for r in days_rows)
    peace_emo = sum((r.get("emotion_peace_count") or 0) for r in days_rows)
    return {
        "steps": _avg([r.get("steps") for r in days_rows], 0),
        "calories_kcal": _avg([r.get("calories_kcal") for r in days_rows], 1),
        "distance_m": _avg([r.get("distance_m") for r in days_rows], 0),
        "active_hours": _avg([r.get("active_hours") for r in days_rows], 1),
        "sleep_total_min": _avg([r.get("sleep_total_min") for r in days_rows], 1),
        "sleep_score": _avg([r.get("sleep_score") for r in days_rows], 1),
        "sleep_deep_min": _avg([r.get("sleep_deep_min") for r in days_rows], 1),
        "sleep_rem_min": _avg([r.get("sleep_rem_min") for r in days_rows], 1),
        "hr_rest": _avg([r.get("hr_rest") for r in days_rows], 1),
        "hrv_avg": _avg([(r.get("hrv_avg") if r.get("hrv_avg") is not None else r.get("hrv_last")) for r in days_rows], 1),
        "spo2_avg": _avg([r.get("spo2_avg") for r in days_rows], 2),
        "stress_avg": _avg([r.get("stress_avg") for r in days_rows], 1),
        "emotion_peace_ratio_pct": round(100.0 * peace_emo / total_emo, 1) if total_emo > 0 else None,
        "workouts_count": float(len(workouts_rows)),
        "workouts_distance_m": round(sum((w.get("distance_m") or 0) for w in workouts_rows), 1),
        "workouts_duration_min": round(sum(((w.get("duration_s") or 0) / 60.0) for w in workouts_rows), 1),
    }


def get_overview(db_path: str | Path, days: int = 30) -> dict[str, Any]:
    """Return period KPIs (with prior-period deltas), daily trend series, sleep, and sync status."""
    days = _clamp(days, 1, 400, 30)
    sync_status = get_db_status(db_path)
    if not sync_status.get("exists"):
        return {"empty": True, "sync_status": sync_status}

    con = open_health_db(db_path, readonly=True)
    try:
        mx_row = con.execute("SELECT MAX(date) AS max_d FROM daily_summary;").fetchone()
        latest_date = mx_row["max_d"] if mx_row and mx_row["max_d"] else None
        if not latest_date:
            return {"empty": True, "sync_status": sync_status}

        end_d = dt.date.fromisoformat(latest_date)
        cur_start = str(end_d - dt.timedelta(days=days - 1))
        prev_end = str(end_d - dt.timedelta(days=days))
        prev_start = str(end_d - dt.timedelta(days=2 * days - 1))

        cur_days = [
            dict(r)
            for r in con.execute(
                "SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date ASC;",
                (cur_start, latest_date),
            )
        ]
        prev_days = [
            dict(r)
            for r in con.execute(
                "SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date ASC;",
                (prev_start, prev_end),
            )
        ]

        cur_wos = [
            dict(r)
            for r in con.execute(
                "SELECT start_ms, date, duration_s, distance_m, calories_kcal, sport_name FROM workouts WHERE date >= ? AND date <= ? ORDER BY date ASC;",
                (cur_start, latest_date),
            )
        ]
        prev_wos = [
            dict(r)
            for r in con.execute(
                "SELECT start_ms, date, duration_s, distance_m, calories_kcal FROM workouts WHERE date >= ? AND date <= ?;",
                (prev_start, prev_end),
            )
        ]

        sleep_sessions = [
            dict(r)
            for r in con.execute(
                """
                SELECT start_ms, end_ms, date, start_iso, end_iso, session_type,
                       total_sleep_min, deep_min, light_min, rem_min, awake_min, nap_min,
                       sleep_score, sleep_latency_min, avg_hr, avg_hrv, avg_breath_rate, snore_freq, deep_part_score
                FROM sleep_sessions
                WHERE date >= ? AND date <= ?
                ORDER BY start_ms ASC;
                """,
                (cur_start, latest_date),
            )
        ]
        latest_night_row = con.execute(
            """
            SELECT start_ms, end_ms, date, start_iso, end_iso, session_type,
                   total_sleep_min, deep_min, light_min, rem_min, awake_min, nap_min,
                   sleep_score, sleep_latency_min, avg_hr, avg_hrv, avg_breath_rate, snore_freq,
                   stages_json, baselines_json
            FROM sleep_sessions WHERE session_type = 'night' ORDER BY start_ms DESC LIMIT 1;
            """
        ).fetchone()
        recent_14d = [
            dict(r)
            for r in con.execute(
                "SELECT * FROM (SELECT * FROM daily_summary ORDER BY date DESC LIMIT 14) ORDER BY date ASC;"
            )
        ]
        recent_30d = (
            cur_days
            if days == 30
            else [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date ASC;",
                    (str(end_d - dt.timedelta(days=29)), latest_date),
                )
            ]
        )
        recent_workouts = [
            dict(r)
            for r in con.execute(
                """
                SELECT start_ms AS workout_id, date, start_iso,
                       ROUND(duration_s, 1) AS duration_s,
                       sport_name, distance_m, calories_kcal, hr_avg, pace_avg_s_per_km, has_gps
                FROM workouts
                ORDER BY start_ms DESC
                LIMIT 5;
                """
            )
        ]
        overnight_vitals = _compute_overnight_vitals(
            con, dict(latest_night_row) if latest_night_row else None, recent_30d
        )
        trends = _compute_recent_trends(recent_30d, latest_date)
        summary_highlights = _compute_summary_highlights(con, latest_date, recent_30d)
        coach_wos = [
            dict(r)
            for r in con.execute(
                "SELECT date, duration_s, distance_m, calories_kcal, hr_avg, sport_name FROM workouts WHERE date >= ? AND date <= ? ORDER BY start_ms ASC;",
                (str(end_d - dt.timedelta(days=13)), latest_date),
            )
        ]
        vo2_pts = _compute_vo2max_points(con)
        tr_series = _compute_training_series(con)
        rai_pts = _compute_rai_series(con)
    finally:
        con.close()

    cur_agg = _summarize_window_kpis(cur_days, cur_wos)
    prev_agg = _summarize_window_kpis(prev_days, prev_wos) if prev_days else {k: None for k in cur_agg}

    kpis = {
        "steps": _kpi_entry(cur_agg["steps"], prev_agg["steps"], 0),
        "calories_kcal": _kpi_entry(cur_agg["calories_kcal"], prev_agg["calories_kcal"], 1),
        "distance_m": _kpi_entry(cur_agg["distance_m"], prev_agg["distance_m"], 0),
        "active_hours": _kpi_entry(cur_agg["active_hours"], prev_agg["active_hours"], 1),
        "sleep_total_min": _kpi_entry(cur_agg["sleep_total_min"], prev_agg["sleep_total_min"], 1),
        "sleep_score": _kpi_entry(cur_agg["sleep_score"], prev_agg["sleep_score"], 1),
        "sleep_deep_min": _kpi_entry(cur_agg["sleep_deep_min"], prev_agg["sleep_deep_min"], 1),
        "sleep_rem_min": _kpi_entry(cur_agg["sleep_rem_min"], prev_agg["sleep_rem_min"], 1),
        "hr_rest": _kpi_entry(cur_agg["hr_rest"], prev_agg["hr_rest"], 1),
        "hrv_avg": _kpi_entry(cur_agg["hrv_avg"], prev_agg["hrv_avg"], 1),
        "spo2_avg": _kpi_entry(cur_agg["spo2_avg"], prev_agg["spo2_avg"], 2),
        "stress_avg": _kpi_entry(cur_agg["stress_avg"], prev_agg["stress_avg"], 1),
        "emotion_peace_ratio_pct": _kpi_entry(cur_agg["emotion_peace_ratio_pct"], prev_agg["emotion_peace_ratio_pct"], 1),
        "workouts_count": _kpi_entry(cur_agg["workouts_count"], prev_agg["workouts_count"], 0),
        "workouts_distance_m": _kpi_entry(cur_agg["workouts_distance_m"], prev_agg["workouts_distance_m"], 0),
        "workouts_duration_min": _kpi_entry(cur_agg["workouts_duration_min"], prev_agg["workouts_duration_min"], 1),
    }

    wo_by_day: dict[str, dict[str, Any]] = {}
    for w in cur_wos:
        d = w["date"]
        item = wo_by_day.setdefault(d, {"date": d, "count": 0, "distance_m": 0.0, "duration_min": 0.0})
        item["count"] += 1
        item["distance_m"] = round(item["distance_m"] + (w.get("distance_m") or 0.0), 1)
        item["duration_min"] = round(item["duration_min"] + ((w.get("duration_s") or 0.0) / 60.0), 1)

    latest_night_clean = dict(latest_night_row) if latest_night_row else None
    raw_latest_stages = None
    if latest_night_clean:
        latest_night_clean.pop("baselines_json", None)
        raw_latest_stages = latest_night_clean.pop("stages_json", None)
    latest_night_stages = _compact_sleep_stage_bars(raw_latest_stages, max_items=24)

    latest_vo2 = vo2_pts[-1] if vo2_pts else None
    latest_tr = tr_series[-1] if tr_series else None
    latest_rai = rai_pts[-1] if rai_pts else None
    athletic_summary = {
        "vo2max": {
            "latest": latest_vo2["val"] if latest_vo2 else None,
            "date": latest_vo2["date"] if latest_vo2 else None,
            "level": latest_vo2["level"] if latest_vo2 else None,
            "color": latest_vo2["color"] if latest_vo2 else None,
            "series": [pt["val"] for pt in vo2_pts[-14:]],
        },
        "training_index": {
            "tsb": latest_tr["tsb"] if latest_tr else None,
            "ctl": latest_tr["ctl"] if latest_tr else None,
            "atl": latest_tr["atl"] if latest_tr else None,
            "load_7d": latest_tr["load_7d"] if latest_tr else None,
            "load_28d_wk": latest_tr["load_28d_wk"] if latest_tr else None,
            "acwr": latest_tr["acwr"] if latest_tr else None,
            "status": latest_tr["status"] if latest_tr else None,
            "date": latest_tr["date"] if latest_tr else None,
            "series": [pt["tsb"] for pt in tr_series[-14:]],
        },
        "running_index": {
            "latest": latest_rai["val"] if latest_rai else None,
            "date": latest_rai["date"] if latest_rai else None,
            "tier": latest_rai["tier"] if latest_rai else None,
            "series": [pt["val"] for pt in rai_pts[-14:]],
        },
    }

    latest_day = dict(cur_days[-1]) if cur_days else None
    readiness = _compute_readiness(recent_30d, latest_night_clean, tr_series, latest_date)
    weekly_coach = _compute_weekly_coach(latest_date, recent_30d, coach_wos, tr_series, readiness)
    return {
        "empty": False,
        "window": {
            "days": days,
            "start_date": cur_start,
            "end_date": latest_date,
            "days_with_data": len(cur_days),
        },
        "sync_status": sync_status,
        "latest_day": latest_day,
        "latest_night_sleep": latest_night_clean,
        "kpis": kpis,
        "daily_series": cur_days,
        "recent_14d": recent_14d,
        "recent_workouts": recent_workouts,
        "sleep_sessions": sleep_sessions,
        "workout_days": sorted(wo_by_day.values(), key=lambda x: x["date"]),
        "overnight_vitals": overnight_vitals,
        "trends": trends,
        "summary_highlights": summary_highlights,
        "latest_night_stages": latest_night_stages,
        "athletic_summary": athletic_summary,
        "readiness": readiness,
        "weekly_coach": weekly_coach,
    }


def get_day_detail(db_path: str | Path, date_str: str | None = None) -> dict[str, Any]:
    """Return full single-day summary, sleep hypnogram stages, 24h vitals series, and workouts."""
    if not Path(db_path).exists():
        return {"empty": True}

    con = open_health_db(db_path, readonly=True)
    try:
        if not date_str:
            r = con.execute("SELECT MAX(date) AS md FROM daily_summary;").fetchone()
            date_str = r["md"] if r and r["md"] else None
        if not date_str:
            return {"empty": True}

        daily_row = con.execute("SELECT * FROM daily_summary WHERE date = ?;", (date_str,)).fetchone()
        prev_row = con.execute("SELECT MAX(date) AS d FROM daily_summary WHERE date < ?;", (date_str,)).fetchone()
        next_row = con.execute("SELECT MIN(date) AS d FROM daily_summary WHERE date > ?;", (date_str,)).fetchone()

        sleeps = []
        for r in con.execute("SELECT * FROM sleep_sessions WHERE date = ? ORDER BY start_ms ASC;", (date_str,)):
            item = dict(r)
            for jf, target in (("stages_json", "stages"), ("baselines_json", "baselines")):
                raw = item.pop(jf, None)
                if raw:
                    try:
                        item[target] = json.loads(raw)
                    except Exception:
                        item[target] = [] if target == "stages" else {}
                else:
                    item[target] = [] if target == "stages" else None
            sleeps.append(item)

        vitals: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in con.execute(
            "SELECT metric, ts_ms, ts_iso, value, unit FROM vitals_points WHERE date = ? ORDER BY ts_ms ASC;",
            (date_str,),
        ):
            vitals[r["metric"]].append({
                "ts_ms": r["ts_ms"],
                "ts_iso": r["ts_iso"],
                "value": r["value"],
                "unit": r["unit"],
            })

        workouts = [
            dict(r)
            for r in con.execute(
                """
                SELECT start_ms AS workout_id, end_ms, date, start_iso, end_iso,
                       ROUND(duration_s, 1) AS duration_s, sport_type_id, sport_name,
                       distance_m, calories_kcal, steps, hr_min, hr_avg, hr_max,
                       pace_avg_s_per_km, cadence_avg_spm, elevation_gain_m, has_gps, gps_point_count
                FROM workouts WHERE date = ? ORDER BY start_ms ASC;
                """,
                (date_str,),
            )
        ]
    finally:
        con.close()

    return {
        "empty": False,
        "date": date_str,
        "prev_date": prev_row["d"] if prev_row else None,
        "next_date": next_row["d"] if next_row else None,
        "daily": dict(daily_row) if daily_row else None,
        "sleep_sessions": sleeps,
        "vitals": dict(vitals),
        "workouts": workouts,
    }


def get_workouts_list(db_path: str | Path, sport: str = "", limit: int = 150,
                      start_date: str | None = None, end_date: str | None = None) -> dict[str, Any]:
    """Return workout history and per-sport breakdown."""
    if not Path(db_path).exists():
        return {"workouts": [], "sport_breakdown": []}
    limit = _clamp(limit, 1, 500, 150)
    sport = (sport or "").strip()

    con = open_health_db(db_path, readonly=True)
    try:
        breakdown = [
            dict(r)
            for r in con.execute(
                """
                SELECT sport_name,
                       COUNT(*) AS count,
                       ROUND(COALESCE(SUM(distance_m), 0), 1) AS total_distance_m,
                       ROUND(COALESCE(SUM(duration_s), 0) / 60.0, 1) AS total_duration_min,
                       ROUND(COALESCE(SUM(calories_kcal), 0), 1) AS total_calories_kcal
                FROM workouts
                GROUP BY sport_name
                ORDER BY count DESC;
                """
            )
        ]

        where = "1=1"
        params: list[Any] = []
        if sport:
            where = "sport_name LIKE ?"
            params.append(f"%{sport}%")
        if start_date:
            where += " AND date >= ?"
            params.append(start_date)
        if end_date:
            where += " AND date <= ?"
            params.append(end_date)
        rows = [
            dict(r)
            for r in con.execute(
                f"""
                SELECT start_ms AS workout_id, end_ms, date, start_iso, end_iso,
                       ROUND(duration_s, 1) AS duration_s,
                       ROUND(duration_s / 60.0, 1) AS duration_min,
                       sport_type_id, sport_name, distance_m, calories_kcal, steps,
                       hr_min, hr_avg, hr_max, pace_avg_s_per_km, pace_best_s_per_km,
                       cadence_avg_spm, cadence_best_spm, elevation_gain_m, elevation_loss_m,
                       max_alti_m, min_alti_m, avg_gct_ms, has_gps, gps_point_count
                FROM workouts
                WHERE {where}
                ORDER BY start_ms DESC
                LIMIT ?;
                """,
                (*params, limit),
            )
        ]
    finally:
        con.close()

    return {"count": len(rows), "workouts": rows, "sport_breakdown": breakdown}


def _classify_hr_zone(hr_val: float, rhr: float, hrr: float) -> int:
    frac = (hr_val - rhr) / max(hrr, 30.0)
    if frac < 0.59:
        return 1
    if frac < 0.69:
        return 2
    if frac < 0.79:
        return 3
    if frac < 0.89:
        return 4
    return 5


def get_workout_detail_full(db_path: str | Path, workout_id: int, max_points: int = 400) -> dict[str, Any]:
    """Return complete workout details including splits, HR series/zones, pace-tagged GPS track, and running dynamics."""
    max_points = _clamp(max_points, 20, 1500, 400)
    con = open_health_db(db_path, readonly=True)
    try:
        row = con.execute("SELECT * FROM workouts WHERE start_ms = ?;", (int(workout_id),)).fetchone()
        if row is None:
            raise KeyError(f"Workout not found: {workout_id}")
        end_ms = int(row["end_ms"])
        recovery = [dict(r) for r in con.execute(
            "SELECT ts_ms,value FROM vitals_points WHERE metric='heart_rate' AND ts_ms BETWEEN ? AND ? AND value>0 ORDER BY ts_ms",
            (end_ms - 15000, end_ms + 135000))]
        rhr_row = con.execute(
            "SELECT AVG(hr_rest) AS rhr, MAX(hr_max) AS hrmax FROM daily_summary WHERE date >= (SELECT date(MAX(date), '-30 days') FROM daily_summary);"
        ).fetchone()
        vp_hr = [
            (int(r["ts_ms"]), float(r["value"]))
            for r in con.execute(
                "SELECT ts_ms, value FROM vitals_points WHERE metric = 'heart_rate' AND ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms ASC;",
                (int(row["start_ms"]) - 60000, int(row["end_ms"]) + 60000),
            )
            if r["value"] and float(r["value"]) > 0
        ]
    finally:
        con.close()

    detail: dict[str, Any] = {
        "workout_id": row["start_ms"],
        "date": row["date"],
        "start_iso": row["start_iso"],
        "end_iso": row["end_iso"],
        "duration_s": round(row["duration_s"], 1),
        "duration_min": round(row["duration_s"] / 60.0, 1),
        "sport_type_id": row["sport_type_id"],
        "sport_name": row["sport_name"],
        "distance_m": row["distance_m"],
        "calories_kcal": row["calories_kcal"],
        "steps": row["steps"],
        "hr_min": row["hr_min"],
        "hr_avg": row["hr_avg"],
        "hr_max": row["hr_max"],
        "pace_avg_s_per_km": row["pace_avg_s_per_km"],
        "pace_best_s_per_km": row["pace_best_s_per_km"],
        "cadence_avg_spm": row["cadence_avg_spm"],
        "cadence_best_spm": row["cadence_best_spm"],
        "elevation_gain_m": row["elevation_gain_m"],
        "elevation_loss_m": row["elevation_loss_m"],
        "max_alti_m": row["max_alti_m"],
        "min_alti_m": row["min_alti_m"],
        "avg_gct_ms": row["avg_gct_ms"],
        "has_gps": bool(row["has_gps"]),
        "gps_point_count": row["gps_point_count"],
        "splits": [],
        "running_dynamics": {},
        "training_metrics": {},
        "cadence_series": [],
        "posture_series": [],
        "elevation_profile": None,
        "gps_track": [],
        "hr_series": [],
        "hr_zones": [],
    }
    start_ms = int(row["start_ms"])
    if row["splits_json"]:
        try:
            detail["splits"] = json.loads(row["splits_json"])
        except Exception:
            pass
    if row["running_dynamics_json"]:
        try:
            dyn = json.loads(row["running_dynamics_json"])
            if isinstance(dyn, dict):
                raw_cad = dyn.pop("cadence_series", None)
                raw_post = dyn.pop("posture_series", None)
                detail["running_dynamics"] = dyn
                tr_meta = {}
                for k in ("vo2max", "training_load", "aerobic_te", "anaerobic_te", "recovery_time_min", "running_index"):
                    if k in dyn and dyn[k] is not None:
                        tr_meta[k] = dyn[k]
                detail["training_metrics"] = tr_meta
                if isinstance(raw_cad, list):
                    for pt in raw_cad:
                        if isinstance(pt, (list, tuple)) and len(pt) >= 2 and pt[1] is not None:
                            el_s = float(pt[0])
                            t_ms = start_ms + int(round(el_s * 1000))
                            detail["cadence_series"].append({
                                "elapsed_s": el_s,
                                "time": dt.datetime.fromtimestamp(t_ms / 1000.0, tz=TZ_PLUS8).strftime("%H:%M:%S"),
                                "spm": int(pt[1]),
                            })
                if isinstance(raw_post, list):
                    for pt in raw_post:
                        if isinstance(pt, (list, tuple)) and len(pt) >= 4:
                            el_s = float(pt[0])
                            t_ms = start_ms + int(round(el_s * 1000))
                            gtb_l = round(float(pt[2]), 2) if pt[2] is not None else None
                            gtb_r = round(100.0 - gtb_l, 2) if gtb_l is not None else None
                            detail["posture_series"].append({
                                "elapsed_s": el_s,
                                "time": dt.datetime.fromtimestamp(t_ms / 1000.0, tz=TZ_PLUS8).strftime("%H:%M:%S"),
                                "gct_ms": int(pt[1]) if pt[1] is not None else None,
                                "gtb_left": gtb_l,
                                "gtb_right": gtb_r,
                                "vo_cm": round(float(pt[3]), 2) if pt[3] is not None else None,
                            })
        except Exception:
            pass

    raw_pts: list[Any] = []
    track_hrs: list[tuple[int, float]] = []
    hr_samples: list[tuple[int, float]] = []

    if row["track_points_gz"]:
        raw_pts = json.loads(gzip.decompress(row["track_points_gz"]).decode("utf-8"))
        eles = [p[3] for p in raw_pts if len(p) > 3 and p[3] is not None]
        track_hrs = [(int(p[0]), float(p[4])) for p in raw_pts if len(p) > 4 and p[4] is not None and p[4] > 0]
        if not detail["cadence_series"]:
            cad_fb = [
                {
                    "elapsed_s": round((int(p[0]) - start_ms) / 1000.0, 1),
                    "time": dt.datetime.fromtimestamp(int(p[0]) / 1000.0, tz=TZ_PLUS8).strftime("%H:%M:%S"),
                    "spm": int(p[5]),
                }
                for p in raw_pts
                if len(p) > 5 and p[5] is not None and p[5] > 0
            ]
            if len(cad_fb) > 180:
                step_idxs = sorted({0, len(cad_fb) - 1, *(int(round(i * (len(cad_fb) - 1) / 179.0)) for i in range(180))})
                cad_fb = [cad_fb[i] for i in step_idxs]
            detail["cadence_series"] = cad_fb
        max_grade = 0.0
        for i in range(1, len(raw_pts)):
            p0, p1 = raw_pts[i - 1], raw_pts[i]
            if p0[3] is None or p1[3] is None:
                continue
            d = _haversine_m(p0[1], p0[2], p1[1], p1[2])
            if d >= 5.0:
                g = abs(p1[3] - p0[3]) / d * 100.0
                if g < 45.0:
                    max_grade = max(max_grade, g)

        # Compute smoothed local pace across track indices
        n = len(raw_pts)
        paced_pts: list[float | None] = [None] * n
        cum_dist = [0.0] * n
        for i in range(1, n):
            cum_dist[i] = cum_dist[i - 1] + _haversine_m(raw_pts[i - 1][1], raw_pts[i - 1][2], raw_pts[i][1], raw_pts[i][2])
        win = 4
        for i in range(n):
            j0 = max(0, i - win)
            j1 = min(n - 1, i + win)
            dist_seg = cum_dist[j1] - cum_dist[j0]
            dt_seg = (raw_pts[j1][0] - raw_pts[j0][0]) / 1000.0
            if dist_seg >= 8.0 and dt_seg >= 2.0:
                pace_v = dt_seg / (dist_seg / 1000.0)
                if 120.0 <= pace_v <= 1500.0:
                    paced_pts[i] = round(pace_v, 1)

        if n <= max_points:
            sampled_idxs = list(range(n))
        else:
            sampled_idxs = sorted({0, n - 1, *(int(round(i * (n - 1) / (max_points - 1))) for i in range(max_points))})

        detail["elevation_profile"] = {
            "min_ele_m": round(min(eles), 1) if eles else None,
            "max_ele_m": round(max(eles), 1) if eles else None,
            "max_grade_pct": round(max_grade, 1) if eles else None,
        }
        detail["gps_track"] = [
            {
                "t_ms": raw_pts[i][0],
                "elapsed_s": round((raw_pts[i][0] - start_ms) / 1000.0, 1),
                "time": dt.datetime.fromtimestamp(raw_pts[i][0] / 1000.0, tz=TZ_PLUS8).strftime("%H:%M:%S"),
                "lat": raw_pts[i][1],
                "lon": raw_pts[i][2],
                "ele_m": raw_pts[i][3],
                "hr": raw_pts[i][4],
                "cad": raw_pts[i][5],
                "pace_s_per_km": paced_pts[i],
            }
            for i in sampled_idxs
        ]

    # Build workout-wide HR series & Apple Watch 5-zone Karvonen distribution
    hr_samples = track_hrs if len(track_hrs) >= 5 else (vp_hr if vp_hr else track_hrs)
    if hr_samples:
        rhr = float(rhr_row["rhr"]) if rhr_row and rhr_row["rhr"] else 62.0
        max_db = float(rhr_row["hrmax"]) if rhr_row and rhr_row["hrmax"] else 185.0
        wo_max = float(row["hr_max"] or 0.0)
        hr_max_ref = max(max_db, wo_max, rhr + 40.0, 175.0)
        hrr = max(hr_max_ref - rhr, 30.0)

        z_sec = {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0, 5: 0.0}
        for i, (t_ms, hr_v) in enumerate(hr_samples):
            if i < len(hr_samples) - 1:
                dt_s = max(1.0, min(120.0, (hr_samples[i + 1][0] - t_ms) / 1000.0))
            else:
                dt_s = 5.0
            z_sec[_classify_hr_zone(hr_v, rhr, hrr)] += dt_s

        tot_z_s = max(sum(z_sec.values()), 1.0)
        zone_defs = [
            (1, "热身恢复", f"<{round(rhr + 0.59 * hrr)}", "#5AC8FA"),
            (2, "燃脂耐力", f"{round(rhr + 0.59 * hrr)}–{round(rhr + 0.69 * hrr - 1)}", "#30D158"),
            (3, "有氧提升", f"{round(rhr + 0.69 * hrr)}–{round(rhr + 0.79 * hrr - 1)}", "#FFD60A"),
            (4, "无氧阈值", f"{round(rhr + 0.79 * hrr)}–{round(rhr + 0.89 * hrr - 1)}", "#FF9F0A"),
            (5, "极限冲刺", f"≥{round(rhr + 0.89 * hrr)}", "#FF375F"),
        ]
        detail["hr_zones"] = [
            {
                "zone": z_id,
                "name": z_name,
                "range_bpm": z_range,
                "duration_s": round(z_sec[z_id]),
                "pct": round(z_sec[z_id] / tot_z_s * 100.0, 1),
                "color": z_color,
            }
            for z_id, z_name, z_range, z_color in zone_defs
        ]

        nh = len(hr_samples)
        if nh <= 180:
            h_idxs = list(range(nh))
        else:
            h_idxs = sorted({0, nh - 1, *(int(round(i * (nh - 1) / 179.0)) for i in range(180))})
        detail["hr_series"] = [
            {
                "t_ms": hr_samples[i][0],
                "elapsed_s": round((hr_samples[i][0] - start_ms) / 1000.0, 1),
                "time": dt.datetime.fromtimestamp(hr_samples[i][0] / 1000.0, tz=TZ_PLUS8).strftime("%H:%M:%S"),
                "hr": round(hr_samples[i][1]),
            }
            for i in h_idxs
        ]

    recovery_points = [(int(r["ts_ms"]), float(r["value"])) for r in recovery]
    recovery_points.extend((t, v) for t, v in hr_samples if abs(t - end_ms) <= 15000)
    detail["recovery"] = []
    for seconds in (0, 60, 120):
        target = end_ms + seconds * 1000
        hit = min(recovery_points, key=lambda item: abs(item[0] - target), default=None)
        if hit and abs(hit[0] - target) <= 15000:
            detail["recovery"].append({"target": seconds, "offset": round((hit[0]-end_ms)/1000), "hr": round(hit[1])})

    detail["biomechanics"] = _compute_workout_biomechanics(
        dict(row), raw_pts, hr_samples, detail["cadence_series"], detail["posture_series"], detail["splits"]
    )
    return detail


def export_workout_gpx(db_path: str | Path, workout_id: int) -> tuple[str, str]:
    """Generate a standard GPX 1.1 XML string and safe download filename for a workout."""
    con = open_health_db(db_path, readonly=True)
    try:
        row = con.execute("SELECT start_ms, sport_name, track_points_gz FROM workouts WHERE start_ms = ?;", (int(workout_id),)).fetchone()
    finally:
        con.close()

    if row is None:
        raise KeyError(f"Workout not found: {workout_id}")
    if not row["track_points_gz"]:
        raise ValueError(f"Workout {workout_id} has no GPS track points")

    raw_pts = json.loads(gzip.decompress(row["track_points_gz"]).decode("utf-8"))
    start_dt = dt.datetime.fromtimestamp(row["start_ms"] / 1000.0, tz=TZ_PLUS8)
    filename = f"workout_{start_dt.strftime('%Y%m%d_%H%M%S')}.gpx"

    ns_gpx = "http://www.topografix.com/GPX/1/1"
    ns_tpx = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
    ET.register_namespace("", ns_gpx)
    ET.register_namespace("gpxtpx", ns_tpx)

    gpx_el = ET.Element(f"{{{ns_gpx}}}gpx", {"version": "1.1", "creator": "HuaweiHealthDashboard"})
    meta_el = ET.SubElement(gpx_el, f"{{{ns_gpx}}}metadata")
    ET.SubElement(meta_el, f"{{{ns_gpx}}}time").text = start_dt.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    trk_el = ET.SubElement(gpx_el, f"{{{ns_gpx}}}trk")
    ET.SubElement(trk_el, f"{{{ns_gpx}}}name").text = f"{row['sport_name']} {start_dt.strftime('%Y-%m-%d %H:%M')}"
    seg_el = ET.SubElement(trk_el, f"{{{ns_gpx}}}trkseg")

    for p in raw_pts:
        t_ms, lat, lon, ele, hr, cad = p[0], p[1], p[2], p[3], p[4], p[5]
        pt_el = ET.SubElement(seg_el, f"{{{ns_gpx}}}trkpt", {"lat": f"{lat:.6f}", "lon": f"{lon:.6f}"})
        if ele is not None:
            ET.SubElement(pt_el, f"{{{ns_gpx}}}ele").text = f"{float(ele):.1f}"
        ET.SubElement(pt_el, f"{{{ns_gpx}}}time").text = dt.datetime.fromtimestamp(t_ms / 1000.0, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if hr is not None or cad is not None:
            ext_el = ET.SubElement(pt_el, f"{{{ns_gpx}}}extensions")
            tpx_el = ET.SubElement(ext_el, f"{{{ns_tpx}}}TrackPointExtension")
            if hr is not None:
                ET.SubElement(tpx_el, f"{{{ns_tpx}}}hr").text = str(int(hr))
            if cad is not None:
                ET.SubElement(tpx_el, f"{{{ns_tpx}}}cad").text = str(int(cad))

    tree = ET.ElementTree(gpx_el)
    ET.indent(tree, space="  ")
    xml_bytes = ET.tostring(gpx_el, encoding="utf-8", xml_declaration=True)
    return xml_bytes.decode("utf-8"), filename


WEEKDAY_CN = ("一", "二", "三", "四", "五", "六", "日")
METRIC_TITLES = {
    "temperature": "温度",
    "body_temperature": "体温",
    "skin_temperature": "腕温",
    "heart_rate": "心率",
    "resting_hr": "静息心率",
    "sleep": "睡眠",
    "steps": "步数",
    "active_energy": "活动能量",
    "basal_energy": "静息能量",
    "distance": "步行+跑步距离",
    "hrv": "心率变异性 (HRV)",
    "spo2": "血氧饱和度",
    "stress": "压力与心理状态",
    "activity": "健身记录",
    "vo2max": "最大摄氧量",
    "training_index": "训练指数",
    "running_index": "跑步指数",
}


def _add_months_first(d: dt.date, delta_months: int) -> dt.date:
    total_m = (d.year * 12 + (d.month - 1)) + delta_months
    y, m0 = divmod(total_m, 12)
    return dt.date(y, m0 + 1, 1)


def _clamp_day_in_month(year: int, month: int, day: int) -> dt.date:
    nxt = _add_months_first(dt.date(year, month, 1), 1)
    last_day = (nxt - dt.timedelta(days=1)).day
    return dt.date(year, month, min(day, last_day))


def _fmt_hm_cn(mins: float | None) -> str:
    if mins is None:
        return "-"
    m = int(round(mins))
    h, rem = divmod(m, 60)
    return f"{h} 小时 {rem} 分钟" if h > 0 else f"{rem} 分钟"


def _fmt_range_date_label(start_d: dt.date, end_d: dt.date, scope: str) -> str:
    if scope == "D":
        return f"{end_d.year}年{end_d.month}月{end_d.day}日 周{WEEKDAY_CN[end_d.weekday()]}"
    if start_d.year == end_d.year:
        return f"{start_d.year}年{start_d.month}月{start_d.day}日 – {end_d.month}月{end_d.day}日"
    return f"{start_d.year}年{start_d.month}月{start_d.day}日 – {end_d.year}年{end_d.month}月{end_d.day}日"


def _build_highlight(
    title: str,
    badge: str,
    insight: str,
    cur_val: float | None,
    prev_val: float | None,
    cur_label: str,
    prev_label: str,
    cur_disp: str,
    prev_disp: str,
    color: str,
) -> dict[str, Any]:
    max_v = max(float(cur_val or 0), float(prev_val or 0), 1e-6)
    bars = []
    if cur_val is not None:
        bars.append({
            "label": cur_label,
            "display": cur_disp,
            "pct": round(min(100.0, max(12.0, float(cur_val) / max_v * 100.0)), 1),
            "color": color,
        })
    if prev_val is not None:
        bars.append({
            "label": prev_label,
            "display": prev_disp,
            "pct": round(min(100.0, max(12.0, float(prev_val) / max_v * 100.0)), 1),
            "color": "muted",
        })
    return {"title": title, "badge": badge, "insight": insight, "bars": bars}


def _fetch_daily_rows(con, start_str: str, end_str: str) -> list[dict[str, Any]]:
    return [
        dict(r)
        for r in con.execute(
            "SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date ASC;",
            (start_str, end_str),
        )
    ]


def _group_period_slots(
    rows: list[dict[str, Any]],
    start_d: dt.date,
    end_d: dt.date,
    scope: str,
) -> list[tuple[str, str, str, list[dict[str, Any]]]]:
    """Return chronological list of (key, tick_label, scrub_title, rows_in_slot)."""
    by_date = {r["date"]: r for r in rows}
    slots: list[tuple[str, str, str, list[dict[str, Any]]]] = []

    if scope in ("W", "M"):
        total_days = (end_d - start_d).days + 1
        for i in range(total_days):
            d = start_d + dt.timedelta(days=i)
            ds = str(d)
            if scope == "W":
                tick = WEEKDAY_CN[d.weekday()]
                scrub = f"{d.month}月{d.day}日 周{tick}"
            else:
                tick = f"{d.month}/{d.day}" if (i == 0 or i == total_days - 1 or i % 7 == 0) else ""
                scrub = f"{d.year}年{d.month}月{d.day}日"
            r = by_date.get(ds)
            slots.append((ds, tick, scrub, [r] if r else []))
        return slots

    if scope == "6M":
        # Weekly buckets starting Mondays from start_d..end_d
        wk_start = start_d - dt.timedelta(days=start_d.weekday())
        prev_month = None
        while wk_start <= end_d:
            wk_end = min(end_d, wk_start + dt.timedelta(days=6))
            wk_rows = []
            cur = max(start_d, wk_start)
            while cur <= wk_end:
                r = by_date.get(str(cur))
                if r:
                    wk_rows.append(r)
                cur += dt.timedelta(days=1)
            tick = f"{wk_start.month}月" if wk_start.month != prev_month else ""
            prev_month = wk_start.month
            scrub = f"{wk_start.month}/{wk_start.day} – {wk_end.month}/{wk_end.day}"
            slots.append((str(wk_start), tick, scrub, wk_rows))
            wk_start += dt.timedelta(days=7)
        return slots

    # Y: 12 monthly slots ending at end_d's month
    cur_m = dt.date(start_d.year, start_d.month, 1)
    end_m = dt.date(end_d.year, end_d.month, 1)
    by_ym: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_ym[r["date"][:7]].append(r)
    while cur_m <= end_m:
        ym = cur_m.strftime("%Y-%m")
        slots.append((ym, f"{cur_m.month}月", f"{cur_m.year}年{cur_m.month}月", by_ym.get(ym, [])))
        cur_m = _add_months_first(cur_m, 1)
    return slots


def _hrv_val(r: dict[str, Any]) -> float | None:
    v = r.get("hrv_avg")
    if v is None:
        v = r.get("hrv_last")
    if v is None and r.get("hrv_min") is not None and r.get("hrv_max") is not None:
        v = (float(r["hrv_min"]) + float(r["hrv_max"])) / 2.0
    return float(v) if v is not None else None


def get_metric_detail(
    db_path: str | Path,
    metric_type: str,
    scope: str = "W",
    end_date: str | None = None,
) -> dict[str, Any]:
    """Return Apple Health-style single-metric detail payload across D/W/M/6M/Y scopes."""
    mtype = (metric_type or "").strip().lower()
    if mtype not in METRIC_TITLES:
        raise ValueError(f"Unsupported metric type: {metric_type}")

    sc = (scope or "W").strip().upper()
    if sc not in ("D", "W", "M", "6M", "Y"):
        sc = "W"

    if not Path(db_path).exists():
        return {"empty": True, "metric": mtype, "title": METRIC_TITLES[mtype]}

    con = open_health_db(db_path, readonly=True)
    try:
        bounds = con.execute("SELECT MIN(date) AS min_d, MAX(date) AS max_d FROM daily_summary;").fetchone()
        if not bounds or not bounds["max_d"]:
            return {"empty": True, "metric": mtype, "title": METRIC_TITLES[mtype]}

        db_min_d = dt.date.fromisoformat(bounds["min_d"])
        db_max_d = dt.date.fromisoformat(bounds["max_d"])

        anchor_end = db_max_d
        if end_date:
            try:
                anchor_end = dt.date.fromisoformat(end_date.strip())
            except ValueError:
                anchor_end = db_max_d
        elif mtype == "sleep" and sc == "D":
            slp_max = con.execute(
                "SELECT date FROM sleep_sessions WHERE session_type = 'night' ORDER BY start_ms DESC LIMIT 1;"
            ).fetchone()
            if slp_max and slp_max["date"]:
                anchor_end = dt.date.fromisoformat(slp_max["date"])

        if anchor_end > db_max_d:
            anchor_end = db_max_d
        if anchor_end < db_min_d:
            anchor_end = db_min_d

        # Window bounds for D/W/M/6M/Y
        if sc == "D":
            cur_start = anchor_end
            prev_end = str(anchor_end - dt.timedelta(days=1)) if anchor_end > db_min_d else None
            next_end = str(anchor_end + dt.timedelta(days=1)) if anchor_end < db_max_d else None
            comp_start = anchor_end - dt.timedelta(days=7)
            comp_end = anchor_end - dt.timedelta(days=1)
        elif sc == "W":
            cur_start = anchor_end - dt.timedelta(days=6)
            prev_end = str(cur_start - dt.timedelta(days=1)) if cur_start > db_min_d else None
            next_end = str(min(db_max_d, anchor_end + dt.timedelta(days=7))) if anchor_end < db_max_d else None
            comp_start = cur_start - dt.timedelta(days=7)
            comp_end = cur_start - dt.timedelta(days=1)
        elif sc == "M":
            cur_start = anchor_end - dt.timedelta(days=29)
            prev_end = str(cur_start - dt.timedelta(days=1)) if cur_start > db_min_d else None
            next_end = str(min(db_max_d, anchor_end + dt.timedelta(days=30))) if anchor_end < db_max_d else None
            comp_start = cur_start - dt.timedelta(days=30)
            comp_end = cur_start - dt.timedelta(days=1)
        elif sc == "6M":
            wk_mon = anchor_end - dt.timedelta(days=anchor_end.weekday())
            cur_start = wk_mon - dt.timedelta(weeks=25)
            prev_end = str(cur_start - dt.timedelta(days=1)) if cur_start > db_min_d else None
            next_end = str(min(db_max_d, anchor_end + dt.timedelta(weeks=26))) if anchor_end < db_max_d else None
            comp_start = cur_start - dt.timedelta(weeks=26)
            comp_end = cur_start - dt.timedelta(days=1)
        else:  # Y: 12 months
            cur_start = _add_months_first(anchor_end, -11)
            prev_end = str(cur_start - dt.timedelta(days=1)) if cur_start > db_min_d else None
            yr_fwd = _clamp_day_in_month(anchor_end.year + 1, anchor_end.month, anchor_end.day)
            next_end = str(min(db_max_d, yr_fwd)) if anchor_end < db_max_d else None
            comp_start = _add_months_first(cur_start, -12)
            comp_end = cur_start - dt.timedelta(days=1)

        base_resp: dict[str, Any] = {
            "empty": False,
            "metric": mtype,
            "title": METRIC_TITLES[mtype],
            "scope": sc,
            "anchor_date": str(anchor_end),
            "start_date": str(cur_start),
            "end_date": str(anchor_end),
            "range_label": _fmt_range_date_label(cur_start, anchor_end, sc),
            "prev_end": prev_end,
            "next_end": next_end,
            "db_min_date": str(db_min_d),
            "db_max_date": str(db_max_d),
        }

        if mtype == "temperature":
            days = _fetch_daily_rows(con, str(cur_start), str(anchor_end))
            history = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=30)),
                                        str(anchor_end - dt.timedelta(days=1)))
            prior_wrist = [row["skin_temp_baseline_delta"] for row in history
                           if row.get("skin_temp_baseline_delta") is not None]

            def average(rows, key):
                values = [row[key] for row in rows if row.get(key) is not None]
                return round(sum(values) / len(values), 2) if values else None

            if sc == "D":
                body_points = []
                for row in con.execute(
                    "SELECT ts_iso, value FROM vitals_points WHERE metric='body_temperature' AND date=? ORDER BY ts_ms",
                    (str(anchor_end),),
                ):
                    stamp = dt.datetime.fromisoformat(row["ts_iso"])
                    body_points.append({"minute": stamp.hour * 60 + stamp.minute + stamp.second / 60,
                                        "label": stamp.strftime("%H:%M"), "body": row["value"]})
                base_resp.update(temperature_points=body_points,
                                 daily_body=average(days, "temp_avg"),
                                 daily_wrist=average(days, "skin_temp_baseline_delta"))
            else:
                base_resp["temperature_points"] = [
                    {"label": label, "tick": tick, "body": average(rows, "temp_avg"),
                     "wrist": average(rows, "skin_temp_baseline_delta")}
                    for _, tick, label, rows in _group_period_slots(days, cur_start, anchor_end, sc)
                ]
            base_resp["typical_band"] = _pct_band(prior_wrist) if len(prior_wrist) >= 5 else None
            return base_resp

        if mtype in ("body_temperature", "skin_temperature"):
            wrist = mtype == "skin_temperature"
            key = "skin_temp_baseline_delta" if wrist else "temp_avg"
            days = _fetch_daily_rows(con, str(cur_start), str(anchor_end))
            points = []
            if sc == "D" and not wrist:
                points = [{"label": row["ts_iso"][11:16], "value": row["value"]}
                          for row in con.execute(
                              "SELECT ts_iso, value FROM vitals_points WHERE metric=? AND date=? ORDER BY ts_ms",
                              (mtype, str(anchor_end)))]
            if sc == "D" and not points:
                value = days[0].get(key) if days else None
                if value is not None:
                    points = [{"label": str(anchor_end), "value": value}]
            elif sc != "D":
                for _, tick, label, rows in _group_period_slots(days, cur_start, anchor_end, sc):
                    values = [row[key] for row in rows if row.get(key) is not None]
                    points.append({"label": label, "tick": tick,
                                   "value": round(sum(values) / len(values), 2) if values else None})
            history = [row.get(key) for row in _fetch_daily_rows(
                con, str(anchor_end - dt.timedelta(days=30)), str(anchor_end - dt.timedelta(days=1)))]
            valid = [value for value in history if value is not None]
            band = _pct_band(valid, 0.2, 0.8) if wrist and len(valid) >= 5 else None
            base_resp.update(temperature_points=points, typical_band=band)
            return base_resp

        # ------------------------------------------------------------------
        point_metric = {"heart_rate":"heart_rate","resting_hr":"resting_hr","hrv":"hrv_rmssd",
                        "spo2":"spo2","steps":"steps_hourly","active_energy":"calories_hourly"}.get(mtype)
        if point_metric and sc == "D":
            base_resp["source_points"] = [dict(r) for r in con.execute(
                "SELECT ts_iso,value,unit FROM vitals_points WHERE metric=? AND date=? ORDER BY ts_ms",
                (point_metric,str(anchor_end)))]
        # Special Case: Apple Fitness Activity Rings (week strip + 24h bars)
        # ------------------------------------------------------------------
        if mtype == "activity":
            wk_mon = anchor_end - dt.timedelta(days=anchor_end.weekday())
            wk_sun = wk_mon + dt.timedelta(days=6)
            wk_rows = {r["date"]: r for r in _fetch_daily_rows(con, str(wk_mon), str(wk_sun))}
            day_row = wk_rows.get(str(anchor_end), {})

            prev7_rows = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=7)), str(anchor_end - dt.timedelta(days=1)))
            cur7_rows = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=6)), str(anchor_end))

            week_strip = []
            for i in range(7):
                d = wk_mon + dt.timedelta(days=i)
                ds = str(d)
                r = wk_rows.get(ds) or {}
                week_strip.append({
                    "date": ds,
                    "weekday": WEEKDAY_CN[i],
                    "day_num": d.day,
                    "is_selected": d == anchor_end,
                    "is_future": d > db_max_d,
                    "move_kcal": round(float(r.get("calories_kcal") or 0), 1),
                    "move_goal": round(float(r.get("calorie_goal_kcal") or 300), 0),
                    "ex_min": int(r.get("moderate_high_min") or 0),
                    "ex_goal": 25,
                    "stand_hrs": int(r.get("active_hours") or 0),
                    "stand_goal": 12,
                })

            hourly_map: dict[int, dict[str, float]] = {h: {"move": 0.0, "ex": 0.0, "steps": 0.0} for h in range(24)}
            hourly_count = 0
            for vr in con.execute(
                """
                SELECT metric, ts_iso, value FROM vitals_points
                WHERE date = ? AND metric IN ('steps_hourly', 'calories_hourly', 'intensity_hourly')
                ORDER BY ts_ms ASC;
                """,
                (str(anchor_end),),
            ):
                hourly_count += 1
                hr = int(vr["ts_iso"][11:13])
                if vr["metric"] == "calories_hourly":
                    hourly_map[hr]["move"] = round(float(vr["value"]), 2)
                elif vr["metric"] == "intensity_hourly":
                    hourly_map[hr]["ex"] = round(float(vr["value"]), 1)
                elif vr["metric"] == "steps_hourly":
                    hourly_map[hr]["steps"] = round(float(vr["value"]), 0)

            hourly = [
                {
                    "hour": h,
                    "label": f"{h:02d}:00",
                    "move_kcal": hourly_map[h]["move"],
                    "ex_min": hourly_map[h]["ex"],
                    "steps": hourly_map[h]["steps"],
                    "stand": (
                        hourly_map[h]["steps"] >= 20
                        or hourly_map[h]["move"] >= 2.0
                        or hourly_map[h]["ex"] > 0
                    ),
                }
                for h in range(24)
            ]

            wos = [
                dict(r)
                for r in con.execute(
                    """
                    SELECT start_ms AS workout_id, date, start_iso, ROUND(duration_s, 1) AS duration_s,
                           sport_name, distance_m, calories_kcal, hr_avg, pace_avg_s_per_km, has_gps
                    FROM workouts WHERE date = ? ORDER BY start_ms ASC;
                    """,
                    (str(anchor_end),),
                )
            ]

            cal_cur = float(day_row.get("calories_kcal") or 0)
            cal_goal = float(day_row.get("calorie_goal_kcal") or 300)
            ex_cur = int(day_row.get("moderate_high_min") or 0)
            stand_cur = int(day_row.get("active_hours") or 0)
            avg_cal7 = _avg([r.get("calories_kcal") for r in prev7_rows], 1)
            avg_cal_cur7 = _avg([r.get("calories_kcal") for r in cur7_rows], 1)

            highlights = []
            if avg_cal_cur7 is not None:
                diff = round(cal_cur - (avg_cal7 or avg_cal_cur7), 0)
                sign = "+" if diff > 0 else ""
                highlights.append(_build_highlight(
                    "活动热量对比",
                    f"{anchor_end.month}/{anchor_end.day}",
                    f"当日活动消耗 {round(cal_cur)} 千卡，较近 7 天均值 {sign}{int(diff)} 千卡。",
                    cal_cur,
                    avg_cal7,
                    "当日",
                    "近 7 天均值",
                    f"{round(cal_cur)} 千卡",
                    f"{round(avg_cal7)} 千卡" if avg_cal7 is not None else "-",
                    "#FA114F",
                ))

            base_resp.update({
                "hero": {
                    "kicker": "活动圆环总览",
                    "primary": str(int(round(cal_cur))),
                    "unit": "千卡",
                    "range_label": base_resp["range_label"],
                },
                "week_strip": week_strip,
                "prev_week_end": str(wk_mon - dt.timedelta(days=1)) if wk_mon > db_min_d else None,
                "next_week_end": str(min(db_max_d, wk_mon + dt.timedelta(days=13))) if wk_sun < db_max_d else None,
                "rings": {
                    "move_kcal": round(cal_cur, 1),
                    "move_goal": round(cal_goal, 0),
                    "ex_min": ex_cur,
                    "ex_goal": 25,
                    "stand_hrs": stand_cur,
                    "stand_goal": 12,
                    "steps": int(day_row.get("steps") or 0),
                    "distance_km": round(float(day_row.get("distance_m") or 0) / 1000.0, 2),
                    "basal_kcal": day_row.get("basal_metabolism_kcal"),
                },
                "hourly_available": hourly_count > 0,
                "hourly": hourly,
                "workouts": wos,
                "highlights": highlights,
            })
            return base_resp

        # Fetch window rows and comparison rows
        cur_days = _fetch_daily_rows(con, str(cur_start), str(anchor_end))
        comp_days = _fetch_daily_rows(con, str(comp_start), str(comp_end))

        # ------------------------------------------------------------------
        # Special Case: Sleep (D hypnogram + W/M/6M/Y stage/duration bars)
        # ------------------------------------------------------------------
        if mtype == "sleep":
            goal_min = 480.0
            if sc == "D":
                sess_rows = [
                    dict(r)
                    for r in con.execute(
                        "SELECT * FROM sleep_sessions WHERE date = ? ORDER BY start_ms ASC;",
                        (str(anchor_end),),
                    )
                ]
                night_sessions = [s for s in sess_rows if s.get("session_type") == "night"]
                nap_sessions = [s for s in sess_rows if s.get("session_type") != "night"]

                raw_night_stages: list[dict[str, Any]] = []
                for sr in (night_sessions or []):
                    raw_st = sr.pop("stages_json", None)
                    sr.pop("baselines_json", None)
                    if raw_st:
                        try:
                            parsed = json.loads(raw_st)
                            if isinstance(parsed, list):
                                for st in parsed:
                                    if st.get("stage") in ("awake", "rem", "light", "deep"):
                                        raw_night_stages.append(st)
                        except Exception:
                            pass

                raw_night_stages.sort(key=lambda s: int(s.get("start_ms") or 0))
                stages: list[dict[str, Any]] = []
                for st in raw_night_stages:
                    s_ms = int(st.get("start_ms") or 0)
                    e_ms = int(st.get("end_ms") or s_ms)
                    st_name = str(st.get("stage"))
                    if stages and stages[-1]["stage"] == st_name and s_ms - stages[-1]["end_ms"] <= 90_000:
                        stages[-1]["end_ms"] = max(stages[-1]["end_ms"], e_ms)
                        stages[-1]["min"] = round((stages[-1]["end_ms"] - stages[-1]["start_ms"]) / 60000.0, 1)
                    else:
                        stages.append({
                            "stage": st_name,
                            "start_ms": s_ms,
                            "end_ms": e_ms,
                            "min": round(max(1.0, (e_ms - s_ms) / 60000.0), 1),
                        })

                for st in stages:
                    st["start_iso"] = dt.datetime.fromtimestamp(st["start_ms"] / 1000.0, tz=TZ_PLUS8).isoformat(timespec="seconds")
                    st["end_iso"] = dt.datetime.fromtimestamp(st["end_ms"] / 1000.0, tz=TZ_PLUS8).isoformat(timespec="seconds")

                d_row = cur_days[-1] if cur_days else {}
                night_sess = night_sessions[0] if night_sessions else {}
                total_min = d_row.get("sleep_total_min") if d_row.get("sleep_total_min") is not None else night_sess.get("total_sleep_min")
                deep_m = float(d_row.get("sleep_deep_min") if d_row.get("sleep_deep_min") is not None else (night_sess.get("deep_min") or 0))
                light_m = float(d_row.get("sleep_light_min") if d_row.get("sleep_light_min") is not None else (night_sess.get("light_min") or 0))
                rem_m = float(d_row.get("sleep_rem_min") if d_row.get("sleep_rem_min") is not None else (night_sess.get("rem_min") or 0))
                awake_m = float(d_row.get("sleep_awake_min") if d_row.get("sleep_awake_min") is not None else (night_sess.get("awake_min") or 0))
                nap_m = float(d_row.get("sleep_nap_min") or sum(float(n.get("nap_min") or n.get("total_sleep_min") or 0) for n in nap_sessions))
                score = d_row.get("sleep_score") if d_row.get("sleep_score") is not None else night_sess.get("sleep_score")

                naps = [
                    {
                        "start_ms": n["start_ms"],
                        "end_ms": n["end_ms"],
                        "start_iso": n["start_iso"],
                        "end_iso": n["end_iso"],
                        "duration_min": round(float(n.get("total_sleep_min") or n.get("nap_min") or 0), 0),
                        "label": "零星小睡",
                    }
                    for n in nap_sessions
                ]
                if not naps and nap_m > 0:
                    naps.append({
                        "start_iso": "",
                        "end_iso": "",
                        "duration_min": round(nap_m, 0),
                        "label": "日间小睡",
                    })

                prev7_avg = _avg([r.get("sleep_total_min") for r in comp_days if r.get("sleep_total_min")], 1)
                highlights = []
                if total_min is not None:
                    if prev7_avg is not None:
                        delta_m = round(float(total_min) - prev7_avg)
                        desc = f"昨晚夜间睡眠 {_fmt_hm_cn(total_min)}，比近 7 天平均{'多' if delta_m >= 0 else '少'} {abs(delta_m)} 分钟。"
                    else:
                        desc = f"昨晚记录夜间总睡眠 {_fmt_hm_cn(total_min)}。"
                    highlights.append(_build_highlight(
                        "与近期平均对比",
                        f"评分 {int(round(score))}" if score is not None else "睡眠洞察",
                        desc,
                        float(total_min),
                        prev7_avg,
                        "昨晚夜间",
                        "近 7 天均值",
                        _fmt_hm_cn(total_min),
                        _fmt_hm_cn(prev7_avg) if prev7_avg is not None else "-",
                        "#5856D6",
                    ))

                stage_cn = {"awake": "清醒", "rem": "快速眼动", "light": "核心睡眠", "deep": "深度睡眠"}
                if stages:
                    samples = list(con.execute(
                        "SELECT metric,ts_ms,value FROM vitals_points WHERE metric IN ('heart_rate','spo2','hrv_rmssd') AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms",
                        (stages[0]["start_ms"], stages[-1]["end_ms"])))
                    for stage in stages:
                        selected = [r for r in samples if stage["start_ms"] <= r["ts_ms"] < stage["end_ms"]]
                        texts = []
                        for metric, title, unit in (("heart_rate","心率","次/分"),("spo2","血氧","%"),("hrv_rmssd","HRV","ms")):
                            vals = [r["value"] for r in selected if r["metric"] == metric]
                            if vals:
                                texts.append(f"{title} {min(vals):g}–{max(vals):g} {unit}")
                        stage["vitals"] = " · ".join(texts)
                records = [
                    {
                        "time": f"{st['start_iso'][11:16]} – {st['end_iso'][11:16]}",
                        "label": stage_cn.get(st["stage"], st["stage"]),
                        "value": f"{int(round(float(st.get('min') or 0)))} 分钟",
                    }
                    for st in reversed(stages)
                ]
                for np_item in naps:
                    t_span = f"{np_item['start_iso'][11:16]} – {np_item['end_iso'][11:16]}" if np_item.get("start_iso") else str(anchor_end)
                    records.append({
                        "time": t_span,
                        "label": np_item["label"],
                        "value": f"{int(round(np_item['duration_min']))} 分钟",
                    })

                sub_metrics = [
                    {"label": "入睡时间", "value": (d_row.get("sleep_fall_asleep_iso") or night_sess.get("start_iso") or "-")[11:16] if (d_row.get("sleep_fall_asleep_iso") or night_sess.get("start_iso")) else "-"},
                    {"label": "起床时间", "value": (d_row.get("sleep_wakeup_iso") or night_sess.get("end_iso") or "-")[11:16] if (d_row.get("sleep_wakeup_iso") or night_sess.get("end_iso")) else "-"},
                    {"label": "夜间平均心率", "value": f"{int(round(d_row['sleep_avg_hr']))} 次/分" if d_row.get("sleep_avg_hr") else (f"{int(round(night_sess['avg_hr']))} 次/分" if night_sess.get("avg_hr") else "-")},
                    {"label": "夜间 HRV / 呼吸", "value": f"{int(round(d_row['sleep_avg_hrv']))} ms · {d_row['sleep_avg_breath_rate']} 次/分" if d_row.get("sleep_avg_hrv") else "-"},
                    {"label": "睡眠效率 / 潜伏期", "value": f"{int(round(d_row['sleep_efficiency']))}% · {int(round(d_row.get('sleep_latency_min') or 0))} 分钟" if d_row.get("sleep_efficiency") else "-"},
                ]

                base_resp.update({
                    "hero": {
                        "kicker": "夜间睡眠总时长",
                        "primary_min": round(float(total_min), 1) if total_min is not None else None,
                        "primary": _fmt_hm_cn(total_min),
                        "unit": "",
                        "range_label": base_resp["range_label"],
                        "score": score,
                    },
                    "goal_min": goal_min,
                    "sleep_detail": {
                        "start_ms": night_sess.get("start_ms") or (stages[0]["start_ms"] if stages else None),
                        "end_ms": night_sess.get("end_ms") or (stages[-1]["end_ms"] if stages else None),
                        "total_min": total_min,
                        "deep_min": deep_m,
                        "light_min": light_m,
                        "rem_min": rem_m,
                        "awake_min": awake_m,
                        "nap_min": nap_m,
                        "naps": naps,
                        "score": score,
                        "stages": stages,
                    },
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": records[:60],
                })
                return base_resp

            # W / M / 6M / Y for Sleep
            slots = _group_period_slots(cur_days, cur_start, anchor_end, sc)
            night_by_date: dict[str, dict[str, Any]] = {}
            for nr in con.execute(
                """
                SELECT date, start_ms, end_ms, start_iso, end_iso, total_sleep_min, stages_json
                FROM sleep_sessions
                WHERE session_type = 'night' AND date >= ? AND date <= ?
                ORDER BY start_ms ASC;
                """,
                (str(cur_start - dt.timedelta(days=1)), str(anchor_end)),
            ):
                nd = dict(nr)
                ds_key = str(nd["date"])
                prev = night_by_date.get(ds_key)
                if not prev or float(nd.get("total_sleep_min") or 0) >= float(prev.get("total_sleep_min") or 0):
                    night_by_date[ds_key] = nd

            buckets = []
            for key, tick, scrub, rs in slots:
                valid = [r for r in rs if r.get("sleep_total_min") is not None]
                avg_tot = _avg([r.get("sleep_total_min") for r in valid], 1)

                bed_hours: list[float] = []
                wake_hours: list[float] = []
                for r in valid:
                    ns = night_by_date.get(r["date"]) or {}
                    b_h = _iso_to_sleep_hour(r.get("sleep_fall_asleep_iso") or ns.get("start_iso"))
                    if b_h is None and ns.get("start_ms"):
                        b_h = _ms_to_sleep_hour(ns.get("start_ms"))
                    w_h = _iso_to_sleep_hour(r.get("sleep_wakeup_iso") or ns.get("end_iso"))
                    if w_h is None and ns.get("end_ms"):
                        w_h = _ms_to_sleep_hour(ns.get("end_ms"))
                    if b_h is not None and w_h is not None and w_h < b_h:
                        w_h = round(w_h + 24.0, 2)
                    if b_h is not None:
                        bed_hours.append(b_h)
                    if w_h is not None:
                        wake_hours.append(w_h)

                avg_bed_slot = _avg(bed_hours, 2)
                avg_wake_slot = _avg(wake_hours, 2)

                slot_tick = tick
                if sc == "W":
                    slot_tick = f"周{WEEKDAY_CN[dt.date.fromisoformat(key).weekday()]}"
                elif sc == "M" and tick:
                    slot_tick = f"{dt.date.fromisoformat(key).day}日"

                b_entry: dict[str, Any] = {
                    "key": key,
                    "tick": slot_tick,
                    "scrub_title": scrub,
                    "val": avg_tot,
                    "deep": _avg([r.get("sleep_deep_min") for r in valid], 1) or 0,
                    "light": _avg([r.get("sleep_light_min") for r in valid], 1) or 0,
                    "rem": _avg([r.get("sleep_rem_min") for r in valid], 1) or 0,
                    "awake": _avg([r.get("sleep_awake_min") for r in valid], 1) or 0,
                    "score": _avg([r.get("sleep_score") for r in valid], 0),
                    "bed_h": avg_bed_slot,
                    "wake_h": avg_wake_slot,
                    "bed_hm": _sleep_hour_to_hm(avg_bed_slot),
                    "wake_hm": _sleep_hour_to_hm(avg_wake_slot),
                    "count": len(valid),
                }
                if sc in ("W", "M"):
                    ns_slot = night_by_date.get(key)
                    b_entry["stage_segs"] = _sleep_stage_clock_segs(
                        ns_slot.get("stages_json") if ns_slot else None,
                        avg_bed_slot,
                    )
                buckets.append(b_entry)

            cur_slp_vals = [r["sleep_total_min"] for r in cur_days if r.get("sleep_total_min") is not None]
            prev_slp_vals = [r["sleep_total_min"] for r in comp_days if r.get("sleep_total_min") is not None]
            cur_avg = _avg(cur_slp_vals, 1)
            prev_avg = _avg(prev_slp_vals, 1)

            avg_bed_all = _avg([b["bed_h"] for b in buckets if b.get("bed_h") is not None], 2)
            avg_wake_all = _avg([b["wake_h"] for b in buckets if b.get("wake_h") is not None], 2)
            avg_bed_hm = _sleep_hour_to_hm(avg_bed_all)
            avg_wake_hm = _sleep_hour_to_hm(avg_wake_all)

            highlights = []
            if cur_avg is not None:
                diff = round(cur_avg - prev_avg) if prev_avg is not None else 0
                insight = (
                    f"本周期日均睡眠 {_fmt_hm_cn(cur_avg)}，比上一周期{'增加' if diff >= 0 else '减少'} {abs(diff)} 分钟。"
                    if prev_avg is not None
                    else f"本周期共记录 {len(cur_slp_vals)} 晚睡眠，均值 {_fmt_hm_cn(cur_avg)}。"
                )
                highlights.append(_build_highlight(
                    "睡眠平均时长趋势",
                    f"{len(cur_slp_vals)} 晚数据",
                    insight,
                    cur_avg,
                    prev_avg,
                    "本周期平均",
                    "上一周期平均",
                    _fmt_hm_cn(cur_avg),
                    _fmt_hm_cn(prev_avg) if prev_avg is not None else "-",
                    "#5856D6",
                ))

            sub_metrics = [
                {"label": "平均入睡 / 起床", "value": f"{avg_bed_hm} – {avg_wake_hm}" if avg_bed_all is not None else "-"},
                {"label": "平均深睡时长", "value": _fmt_hm_cn(_avg([r.get("sleep_deep_min") for r in cur_days], 1))},
                {"label": "平均快速眼动 (REM)", "value": _fmt_hm_cn(_avg([r.get("sleep_rem_min") for r in cur_days], 1))},
                {"label": "平均睡眠评分", "value": f"{_avg([r.get('sleep_score') for r in cur_days], 1) or '-'} 分"},
                {"label": "达到 8 小时天数", "value": f"{sum(1 for v in cur_slp_vals if v >= 480)} / {len(cur_slp_vals)} 天"},
            ]
            records = [
                {
                    "time": r["date"],
                    "label": (
                        f"{_sleep_hour_to_hm(_iso_to_sleep_hour(r.get('sleep_fall_asleep_iso') or (night_by_date.get(r['date']) or {}).get('start_iso')))}–"
                        f"{_sleep_hour_to_hm(_iso_to_sleep_hour(r.get('sleep_wakeup_iso') or (night_by_date.get(r['date']) or {}).get('end_iso')))}"
                        + (f" · 评分 {int(round(r['sleep_score']))}" if r.get("sleep_score") is not None else "")
                    ),
                    "value": _fmt_hm_cn(r["sleep_total_min"]),
                }
                for r in reversed(cur_days)
                if r.get("sleep_total_min") is not None
            ]
            base_resp.update({
                "hero": {
                    "kicker": "平均睡眠时长",
                    "primary_min": cur_avg,
                    "primary": _fmt_hm_cn(cur_avg),
                    "unit": "",
                    "range_label": base_resp["range_label"],
                    "avg_bed_hm": avg_bed_hm,
                    "avg_wake_hm": avg_wake_hm,
                },
                "goal_min": goal_min,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        # ------------------------------------------------------------------
        # Athletic Performance: vo2max, training_index, running_index
        # ------------------------------------------------------------------
        if mtype in ("vo2max", "training_index", "running_index"):
            slot_scope = "W" if sc == "D" else sc
            slot_start = (anchor_end - dt.timedelta(days=6)) if sc == "D" else cur_start

            if mtype == "vo2max":
                all_pts = _compute_vo2max_points(con)
                upto_anchor = [pt for pt in all_pts if pt["date"] <= str(anchor_end)]
                win_pts = [pt for pt in all_pts if str(slot_start) <= pt["date"] <= str(anchor_end)]
                comp_pts = [pt for pt in all_pts if str(comp_start) <= pt["date"] <= str(comp_end)]
                latest_pt = upto_anchor[-1] if upto_anchor else None

                slots = _group_period_slots(win_pts, slot_start, anchor_end, slot_scope)
                buckets = []
                for key, tick, scrub, rs in slots:
                    vals = [float(r["val"]) for r in rs if r.get("val") is not None]
                    avg_v = round(sum(vals) / len(vals), 1) if vals else None
                    buckets.append({
                        "key": key,
                        "tick": tick,
                        "scrub_title": scrub,
                        "avg": avg_v,
                        "min": round(min(vals), 1) if vals else None,
                        "max": round(max(vals), 1) if vals else None,
                        "level": _classify_vo2max(avg_v)[0] if avg_v is not None else None,
                        "count": len(vals),
                    })

                cur_avg = _avg([p["val"] for p in win_pts], 1) if win_pts else (latest_pt["val"] if latest_pt else None)
                prev_avg = _avg([p["val"] for p in comp_pts], 1)
                hero_val = latest_pt["val"] if latest_pt else cur_avg
                lvl_text, lvl_color = _classify_vo2max(hero_val) if hero_val is not None else ("-", "#8E8E93")
                highlights = []
                if hero_val is not None:
                    diff = round(hero_val - prev_avg, 1) if prev_avg is not None else 0.0
                    insight = (
                        f"最大摄氧量 {hero_val} mL/kg·min（有氧适能等级：{lvl_text}），较上一周期{'提升' if diff >= 0 else '下降'} {abs(diff)}。"
                        if prev_avg is not None
                        else f"当前最大摄氧量 {hero_val} mL/kg·min（有氧适能等级：{lvl_text}），测量自 {latest_pt['date'] if latest_pt else anchor_end}。"
                    )
                    highlights.append(_build_highlight(
                        "有氧适能水平评估",
                        lvl_text,
                        insight,
                        hero_val,
                        prev_avg,
                        "当前最大摄氧量",
                        "上一周期均值",
                        f"{hero_val} mL/kg·min",
                        f"{prev_avg} mL/kg·min" if prev_avg is not None else "-",
                        "#FF3B30",
                    ))
                all_vals = [p["val"] for p in upto_anchor]
                sub_metrics = [
                    {"label": "Cardio Fitness 等级", "value": lvl_text},
                    {"label": "最近一次评估日期", "value": latest_pt["date"] if latest_pt else "-"},
                    {"label": "历史峰值 / 最低", "value": f"{max(all_vals)} / {min(all_vals)} mL/kg·min" if all_vals else "-"},
                    {"label": "累计有效评估次数", "value": f"{len(upto_anchor)} 次"},
                ]
                records = [
                    {"time": pt["date"], "label": f"等级 · {pt['level']}", "value": f"{pt['val']} mL/kg·min"}
                    for pt in reversed(upto_anchor)
                ]
                bands = [
                    {"label": "高", "min": 52, "max": 70, "color": "#30D158"},
                    {"label": "高于平均", "min": 44, "max": 52, "color": "#32ADE6"},
                    {"label": "低于平均", "min": 38, "max": 44, "color": "#FF9F0A"},
                    {"label": "低", "min": 20, "max": 38, "color": "#FF3B30"},
                ]
                if latest_pt and not win_pts:
                    sub_hint = f"最近评估 {latest_pt['date']} · {lvl_text}"
                elif cur_avg is not None and len(win_pts) > 1:
                    sub_hint = f"周期均值 {cur_avg} · {lvl_text}"
                else:
                    sub_hint = f"有氧适能水平：{lvl_text}"
                base_resp.update({
                    "hero": {
                        "kicker": "最大摄氧量 (VO₂ Max)",
                        "primary": f"{hero_val:.1f}" if hero_val is not None else "-",
                        "unit": "mL/kg·min",
                        "range_label": sub_hint,
                    },
                    "classification": {"label": lvl_text, "color": lvl_color},
                    "classification_bands": bands,
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": records[:60],
                })
                return base_resp

            if mtype == "training_index":
                tr_all = _compute_training_series(con)
                upto_anchor = [r for r in tr_all if r["date"] <= str(anchor_end)]
                win_rows = [r for r in tr_all if str(slot_start) <= r["date"] <= str(anchor_end)]
                slots = _group_period_slots(win_rows, slot_start, anchor_end, slot_scope)
                buckets = []
                for key, tick, scrub, rs in slots:
                    if not rs:
                        buckets.append({"key": key, "tick": tick, "scrub_title": scrub, "load": None, "ctl": None, "atl": None, "tsb": None})
                        continue
                    last_r = rs[-1]
                    buckets.append({
                        "key": key,
                        "tick": tick,
                        "scrub_title": scrub,
                        "load": round(sum(float(r["load"]) for r in rs), 1),
                        "ctl": last_r["ctl"],
                        "atl": last_r["atl"],
                        "tsb": last_r["tsb"],
                        "load_7d": last_r["load_7d"],
                        "load_28d_wk": last_r["load_28d_wk"],
                        "acwr": last_r["acwr"],
                        "status": last_r["status"],
                    })

                cur_pt = upto_anchor[-1] if upto_anchor else None
                tsb_v = cur_pt["tsb"] if cur_pt else None
                ctl_v = cur_pt["ctl"] if cur_pt else None
                atl_v = cur_pt["atl"] if cur_pt else None
                l7 = cur_pt["load_7d"] if cur_pt else None
                l28w = cur_pt["load_28d_wk"] if cur_pt else None
                acwr_v = cur_pt["acwr"] if cur_pt else None
                st_lbl = cur_pt["status"] if cur_pt else "-"
                highlights = []
                if cur_pt is not None:
                    highlights.append(_build_highlight(
                        "7天负荷与28天基线对比",
                        st_lbl,
                        f"近 7 天累计负荷 {int(round(l7 or 0))}，28 天周均基线 {int(round(l28w or 0))}（负荷比 {acwr_v}），当前处于“{st_lbl}”阶段。",
                        l7,
                        l28w,
                        "最近 7 天负荷",
                        "28 天周均基线",
                        f"{int(round(l7 or 0))}",
                        f"{int(round(l28w or 0))}",
                        "#007AFF",
                    ))
                sub_metrics = [
                    {"label": "训练状态评估", "value": st_lbl},
                    {"label": "体能指数 (Fitness 42d)", "value": f"{ctl_v}"},
                    {"label": "疲劳指数 (Fatigue 7d)", "value": f"{atl_v}"},
                    {"label": "近 7 天负荷 / 28 天周均", "value": f"{int(round(l7 or 0))} / {int(round(l28w or 0))}"},
                    {"label": "急慢性负荷比 (ACWR)", "value": f"{acwr_v}"},
                ]
                records = [
                    {
                        "time": r["date"],
                        "label": f"体能 {r['ctl']} · 疲劳 {r['atl']} · {r['status']}",
                        "value": f"负荷 {int(round(r['load']))} · 指数 {r['tsb']:+.1f}",
                    }
                    for r in reversed(upto_anchor)
                    if r["load"] > 0
                ]
                hero_primary = f"{tsb_v:+.1f}" if tsb_v is not None else "-"
                hero_sub = f"体能 {ctl_v} · 疲劳 {atl_v} · 7天负荷 {int(round(l7 or 0))}" if cur_pt else base_resp["range_label"]
                base_resp.update({
                    "hero": {
                        "kicker": "训练状态指数 (TSB)",
                        "primary": hero_primary,
                        "unit": "分",
                        "range_label": hero_sub,
                    },
                    "baseline": {"status": st_lbl},
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": records[:60],
                })
                return base_resp

            # running_index (RAI)
            all_rai = _compute_rai_series(con)
            upto_anchor = [pt for pt in all_rai if pt["date"] <= str(anchor_end)]
            win_pts = [pt for pt in all_rai if str(slot_start) <= pt["date"] <= str(anchor_end)]
            comp_pts = [pt for pt in all_rai if str(comp_start) <= pt["date"] <= str(comp_end)]
            latest_pt = upto_anchor[-1] if upto_anchor else None

            slots = _group_period_slots(win_pts, slot_start, anchor_end, slot_scope)
            buckets = []
            for key, tick, scrub, rs in slots:
                vals = [float(r["val"]) for r in rs if r.get("val") is not None]
                avg_v = round(sum(vals) / len(vals), 1) if vals else None
                buckets.append({
                    "key": key,
                    "tick": tick,
                    "scrub_title": scrub,
                    "avg": avg_v,
                    "min": round(min(vals), 1) if vals else None,
                    "max": round(max(vals), 1) if vals else None,
                    "tier": _classify_rai(avg_v) if avg_v is not None else None,
                    "count": len(vals),
                })

            hero_val = latest_pt["val"] if latest_pt else _avg([p["val"] for p in win_pts], 1)
            tier_text = _classify_rai(hero_val) if hero_val is not None else "-"
            prev_avg = _avg([p["val"] for p in comp_pts], 1)
            preds = _predict_race_times(hero_val)
            highlights = []
            if hero_val is not None:
                diff = round(hero_val - prev_avg, 1) if prev_avg is not None else 0.0
                highlights.append(_build_highlight(
                    "跑步能力指数趋势",
                    tier_text,
                    (f"当前跑步指数 {hero_val} 分（{tier_text}），较上一周期{'提升' if diff >= 0 else '变化'} {abs(diff)} 分。" if prev_avg is not None else f"当前跑步指数 {hero_val} 分（{tier_text}），基于心率配速效率综合评估。"),
                    hero_val,
                    prev_avg,
                    "当前跑步指数",
                    "上一周期均值",
                    f"{hero_val} 分",
                    f"{prev_avg} 分" if prev_avg is not None else "-",
                    "#28CD41",
                ))
            all_vals = [p["val"] for p in upto_anchor]
            sub_metrics = [
                {"label": "当前跑力等级", "value": tier_text},
                {"label": "历史最高跑步指数", "value": f"{max(all_vals)} 分" if all_vals else "-"},
                {"label": "最近更新日期", "value": latest_pt["date"] if latest_pt else "-"},
                {"label": "半马理论完赛预测", "value": preds[2]["time"] if len(preds) >= 3 else "-"},
            ]
            records = [
                {"time": pt["date"], "label": f"跑力等级 · {pt['tier']}", "value": f"{pt['val']} 分"}
                for pt in reversed(upto_anchor)
            ]
            base_resp.update({
                "hero": {
                    "kicker": "跑步能力指数 (RAI)",
                    "primary": f"{hero_val:.1f}" if hero_val is not None else "-",
                    "unit": "分",
                    "range_label": f"最近更新 {latest_pt['date']} · {tier_text}" if (latest_pt and not win_pts) else base_resp["range_label"],
                },
                "baseline": {"status": tier_text},
                "race_predictions": preds,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        # ------------------------------------------------------------------
        # Apple Health Native Energy / Distance / Resting HR across D/W/M/6M/Y
        # ------------------------------------------------------------------
        if mtype in ("active_energy", "basal_energy", "distance", "resting_hr"):
            is_macro = sc in ("6M", "Y")
            d_row = cur_days[-1] if cur_days else {}

            if mtype in ("active_energy", "distance"):
                is_dist = (mtype == "distance")
                unit_str = "公里" if is_dist else "千卡"
                accent = "#FF6B00" if is_dist else "#FF3B30"

                if sc == "D":
                    vm_name = "steps_hourly" if is_dist else "calories_hourly"
                    hourly_pts: dict[int, list[float]] = defaultdict(list)
                    for vr in con.execute(
                        "SELECT ts_iso, value FROM vitals_points WHERE date = ? AND metric = ? ORDER BY ts_ms ASC;",
                        (str(anchor_end), vm_name),
                    ):
                        hourly_pts[int(vr["ts_iso"][11:13])].append(float(vr["value"]))
                    hourly_available = len(hourly_pts) > 0

                    buckets = []
                    raw_records = []
                    if is_dist:
                        tot_km_day = round(float(d_row.get("distance_m") or 0) / 1000.0, 2) if d_row.get("distance_m") is not None else None
                        hr_steps_sum = sum(sum(v) for v in hourly_pts.values())
                        for h in range(24):
                            if hourly_pts[h] and tot_km_day is not None and hr_steps_sum > 0:
                                val = round(tot_km_day * (sum(hourly_pts[h]) / hr_steps_sum), 2)
                            else:
                                val = None
                            buckets.append({"key": f"{h:02d}", "tick": f"{h}时" if h in (0, 6, 12, 18) else "", "scrub_title": f"{anchor_end} {h:02d}:00 – {h:02d}:59", "val": val})
                            if val and val > 0:
                                raw_records.append({"time": f"{h:02d}:00 – {h:02d}:59", "label": "小时估算距离", "value": f"{val} 公里"})
                        tot_val = tot_km_day
                    else:
                        for h in range(24):
                            val = round(sum(hourly_pts[h]), 1) if hourly_pts[h] else None
                            buckets.append({"key": f"{h:02d}", "tick": f"{h}时" if h in (0, 6, 12, 18) else "", "scrub_title": f"{anchor_end} {h:02d}:00 – {h:02d}:59", "val": val})
                            if val and val > 0:
                                raw_records.append({"time": f"{h:02d}:00 – {h:02d}:59", "label": "小时活动能量", "value": f"{round(val, 1):g} 千卡"})
                        tot_val = round(float(d_row["calories_kcal"]), 0) if d_row.get("calories_kcal") is not None else (round(sum((b["val"] or 0) for b in buckets), 0) if hourly_available else None)

                    raw_records.reverse()
                    prev7 = _avg([
                        (float(r["distance_m"]) / 1000.0 if is_dist else float(r["calories_kcal"]))
                        for r in comp_days
                        if r.get("distance_m" if is_dist else "calories_kcal") is not None
                    ], 2 if is_dist else 0)
                    highlights = []
                    if tot_val is not None:
                        diff = round(float(tot_val) - (prev7 or float(tot_val)), 2 if is_dist else 0)
                        c_disp = f"{tot_val:.2f} 公里" if is_dist else f"{int(round(tot_val)):,} 千卡"
                        p_disp = (f"{prev7:.2f} 公里" if is_dist else f"{int(round(prev7)):,} 千卡") if prev7 is not None else "-"
                        highlights.append(_build_highlight(
                            f"与近 7 天平均{'距离' if is_dist else '活动能量'}对比",
                            f"{anchor_end.month}/{anchor_end.day}",
                            f"当日{'步行+跑步距离 ' if is_dist else '消耗活动能量 '}{c_disp}，较近 7 天均值{'增加' if diff >= 0 else '减少'} {abs(diff):g} {unit_str}。",
                            float(tot_val), prev7, "当日", "近 7 天均值", c_disp, p_disp, accent,
                        ))
                    sub_metrics = (
                        [
                            {"label": "当日步数", "value": f"{int(d_row['steps']):,} 步" if d_row.get("steps") is not None else "-"},
                            {"label": "近 7 天日均距离", "value": f"{prev7:.2f} 公里" if prev7 is not None else "-"},
                            {"label": "活动能量消耗", "value": f"{round(float(d_row.get('calories_kcal') or 0), 1):g} 千卡"},
                        ]
                        if is_dist else
                        [
                            {"label": "每日活动目标", "value": f"{int(round(d_row.get('calorie_goal_kcal') or 300))} 千卡"},
                            {"label": "静息基础消耗", "value": f"{int(round(d_row['basal_metabolism_kcal'])):,} 千卡" if d_row.get("basal_metabolism_kcal") is not None else "-"},
                            {"label": "近 7 天日均消耗", "value": f"{int(round(prev7)):,} 千卡" if prev7 is not None else "-"},
                        ]
                    )
                    hero_pri = (f"{tot_val:.2f}" if is_dist else f"{int(round(tot_val)):,}") if tot_val is not None else "-"
                    base_resp.update({
                        "hero": {"kicker": "总计", "primary": hero_pri, "unit": unit_str, "range_label": base_resp["range_label"]},
                        "goal": None if is_dist else float(d_row.get("calorie_goal_kcal") or 300),
                        "hourly_available": hourly_available,
                        "buckets": buckets,
                        "highlights": highlights,
                        "sub_metrics": sub_metrics,
                        "records": raw_records[:60],
                    })
                    return base_resp

                # W / M / 6M / Y for active_energy or distance
                slots = _group_period_slots(cur_days, cur_start, anchor_end, sc)
                buckets = []
                field = "distance_m" if is_dist else "calories_kcal"
                scale = 1000.0 if is_dist else 1.0
                for key, tick, scrub, rs in slots:
                    vals = [round(float(r[field]) / scale, 2 if is_dist else 1) for r in rs if r.get(field) is not None]
                    val = round(sum(vals) / len(vals), 2 if is_dist else 0) if (is_macro and vals) else (round(vals[0], 2 if is_dist else 0) if vals else None)
                    buckets.append({"key": key, "tick": tick, "scrub_title": scrub, "val": val, "sum": round(sum(vals), 2 if is_dist else 0) if vals else 0, "days": len(vals)})
                cur_vals = [float(r[field]) / scale for r in cur_days if r.get(field) is not None]
                prev_vals = [float(r[field]) / scale for r in comp_days if r.get(field) is not None]
                cur_avg = _avg(cur_vals, 2 if is_dist else 0)
                prev_avg = _avg(prev_vals, 2 if is_dist else 0)
                tot_period = round(sum(cur_vals), 1 if is_dist else 0)
                highlights = []
                if cur_avg is not None:
                    diff = round(cur_avg - prev_avg, 2 if is_dist else 0) if prev_avg is not None else 0
                    c_disp = f"{cur_avg:.2f} 公里" if is_dist else f"{int(round(cur_avg)):,} 千卡"
                    p_disp = (f"{prev_avg:.2f} 公里" if is_dist else f"{int(round(prev_avg)):,} 千卡") if prev_avg is not None else "-"
                    highlights.append(_build_highlight(
                        f"平均每日{'距离' if is_dist else '活动能量'}对比",
                        f"总计 {tot_period:,g} {unit_str}" if isinstance(tot_period, float) else f"总 {int(tot_period):,} {unit_str}",
                        f"本周期日均 {c_disp}，{'较上一周期增加' if diff >= 0 else '较上一周期减少'} {abs(diff):g} {unit_str}。" if prev_avg is not None else f"本周期累计 {tot_period:g} {unit_str}。",
                        cur_avg, prev_avg, "本周期日均", "上一周期日均", c_disp, p_disp, accent,
                    ))
                sub_metrics = [
                    {"label": "周期总计", "value": f"{tot_period} {unit_str}"},
                    {"label": "日均均值", "value": f"{cur_avg:.2f} {unit_str}" if (is_dist and cur_avg is not None) else (f"{int(round(cur_avg)):,} {unit_str}" if cur_avg is not None else "-")},
                    {"label": "有效记录天数", "value": f"{len(cur_vals)} 天"},
                ]
                records = [
                    {
                        "time": r["date"],
                        "label": METRIC_TITLES[mtype],
                        "value": f"{round(float(r[field]) / scale, 2)} 公里" if is_dist else f"{int(round(r[field])):,} 千卡",
                    }
                    for r in reversed(cur_days)
                    if r.get(field) is not None
                ]
                hero_pri = (f"{cur_avg:.2f}" if is_dist else f"{int(round(cur_avg)):,}") if cur_avg is not None else "-"
                base_resp.update({
                    "hero": {"kicker": "平均", "primary": hero_pri, "unit": unit_str, "range_label": base_resp["range_label"]},
                    "goal": None if is_dist else float((cur_days[-1].get("calorie_goal_kcal") or 300) if cur_days else 300),
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": records[:60],
                })
                return base_resp

            if mtype == "basal_energy":
                slot_scope = "W" if sc == "D" else sc
                slot_start = (anchor_end - dt.timedelta(days=6)) if sc == "D" else cur_start
                win_days = _fetch_daily_rows(con, str(slot_start), str(anchor_end)) if sc == "D" else cur_days
                slots = _group_period_slots(win_days, slot_start, anchor_end, slot_scope)
                buckets = []
                for key, tick, scrub, rs in slots:
                    vals = [float(r["basal_metabolism_kcal"]) for r in rs if r.get("basal_metabolism_kcal") is not None]
                    val = round(sum(vals) / len(vals), 0) if vals else None
                    buckets.append({"key": key, "tick": tick, "scrub_title": scrub, "val": val, "days": len(vals)})
                cur_vals = [float(r["basal_metabolism_kcal"]) for r in cur_days if r.get("basal_metabolism_kcal") is not None]
                prev_vals = [float(r["basal_metabolism_kcal"]) for r in comp_days if r.get("basal_metabolism_kcal") is not None]
                hero_val = d_row.get("basal_metabolism_kcal") if sc == "D" else _avg(cur_vals, 0)
                prev_avg = _avg(prev_vals, 0)
                highlights = []
                if hero_val is not None:
                    diff = round(float(hero_val) - prev_avg) if prev_avg is not None else 0
                    highlights.append(_build_highlight(
                        "静息基础代谢趋势",
                        "BMR",
                        f"{'当日' if sc == 'D' else '本周期日均'}静息能量 {int(round(hero_val)):,} 千卡，维持生命基础代谢较稳定{'（+' + str(diff) + '）' if diff > 0 else ''}。",
                        float(hero_val), prev_avg,
                        "当日静息能量" if sc == "D" else "本周期日均",
                        "近 7 天均值" if sc == "D" else "上一周期均值",
                        f"{int(round(hero_val)):,} 千卡",
                        f"{int(round(prev_avg)):,} 千卡" if prev_avg is not None else "-",
                        "#FF6B00",
                    ))
                rec_src = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=13)), str(anchor_end)) if sc == "D" else cur_days
                records = [
                    {"time": r["date"], "label": "每日静息能量 (BMR)", "value": f"{int(round(r['basal_metabolism_kcal'])):,} 千卡"}
                    for r in reversed(rec_src)
                    if r.get("basal_metabolism_kcal") is not None
                ]
                sub_metrics = [
                    {"label": "总燃烧预估 (活动+静息)", "value": f"{int(round((hero_val or 0) + float((d_row.get('calories_kcal') if sc == 'D' else _avg([r.get('calories_kcal') for r in cur_days], 0)) or 0))):,} 千卡"},
                    {"label": "有效代谢天数", "value": f"{len(cur_vals)} 天"},
                ]
                base_resp.update({
                    "hero": {"kicker": "静息能量" if sc == "D" else "平均静息能量", "primary": f"{int(round(hero_val)):,}" if hero_val is not None else "-", "unit": "千卡", "range_label": base_resp["range_label"]},
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": records[:60],
                })
                return base_resp

            # resting_hr across D / W / M / 6M / Y
            slot_scope = "W" if sc == "D" else sc
            slot_start = (anchor_end - dt.timedelta(days=6)) if sc == "D" else cur_start
            win_days = _fetch_daily_rows(con, str(slot_start), str(anchor_end)) if sc == "D" else cur_days
            slots = _group_period_slots(win_days, slot_start, anchor_end, slot_scope)
            buckets = []
            for key, tick, scrub, rs in slots:
                vals = [float(r["hr_rest"]) for r in rs if r.get("hr_rest") is not None]
                buckets.append({
                    "key": key,
                    "tick": tick,
                    "scrub_title": scrub,
                    "avg": round(sum(vals) / len(vals), 1) if vals else None,
                    "min": round(min(vals), 0) if vals else None,
                    "max": round(max(vals), 0) if vals else None,
                    "days": len(vals),
                })
            cur_vals = [float(r["hr_rest"]) for r in cur_days if r.get("hr_rest") is not None]
            prev_vals = [float(r["hr_rest"]) for r in comp_days if r.get("hr_rest") is not None]
            hero_val = float(d_row["hr_rest"]) if (sc == "D" and d_row.get("hr_rest") is not None) else _avg(cur_vals, 1)
            prev_avg = _avg(prev_vals, 1)
            highlights = []
            if hero_val is not None:
                diff = round(hero_val - prev_avg, 1) if prev_avg is not None else 0.0
                highlights.append(_build_highlight(
                    "静息心率趋势",
                    f"均 {round(hero_val, 1):g} 次/分",
                    f"{'当日' if sc == 'D' else '本周期均值'}静息心率 {round(hero_val, 1):g} 次/分" + (f"，较上一周期{'上升' if diff > 0 else '下降'} {abs(diff)} 次/分。" if prev_avg is not None else "。"),
                    hero_val, prev_avg,
                    "当日静息" if sc == "D" else "本周期均值",
                    "近 7 天均值" if sc == "D" else "上一周期均值",
                    f"{round(hero_val, 1):g} 次/分",
                    f"{prev_avg} 次/分" if prev_avg is not None else "-",
                    "#FF2D55",
                ))
            rec_src = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=13)), str(anchor_end)) if sc == "D" else cur_days
            records = [
                {"time": r["date"], "label": "夜间及清晨静息", "value": f"{round(float(r['hr_rest']), 1):g} 次/分"}
                for r in reversed(rec_src)
                if r.get("hr_rest") is not None
            ]
            sub_metrics = [
                {"label": "夜间睡眠均心率", "value": f"{_avg([r.get('sleep_avg_hr') for r in cur_days], 1) or '-'} 次/分"},
                {"label": "周期最低 / 最高静息", "value": f"{int(round(min(cur_vals)))} / {int(round(max(cur_vals)))} 次/分" if cur_vals else "-"},
            ]
            base_resp.update({
                "hero": {"kicker": "静息心率" if sc == "D" else "平均静息心率", "primary": f"{round(hero_val, 1):g}" if hero_val is not None else "-", "unit": "次/分", "range_label": base_resp["range_label"]},
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        # ------------------------------------------------------------------
        # Day Scope (D) for heart_rate, hrv, spo2, stress, steps
        # ------------------------------------------------------------------
        if sc == "D":
            d_row = cur_days[-1] if cur_days else {}
            hourly_pts: dict[int, list[float]] = defaultdict(list)
            raw_records: list[dict[str, Any]] = []
            hourly_available = False

            if mtype == "steps":
                for vr in con.execute(
                    "SELECT ts_iso, value FROM vitals_points WHERE date = ? AND metric = 'steps_hourly' ORDER BY ts_ms ASC;",
                    (str(anchor_end),),
                ):
                    hourly_available = True
                    hr = int(vr["ts_iso"][11:13])
                    hourly_pts[hr].append(float(vr["value"]))
                buckets = []
                for h in range(24):
                    v = round(sum(hourly_pts[h]), 0) if hourly_pts[h] else None
                    buckets.append({
                        "key": f"{h:02d}",
                        "tick": f"{h}时" if h in (0, 6, 12, 18) else "",
                        "scrub_title": f"{anchor_end} {h:02d}:00 – {h:02d}:59",
                        "val": v,
                    })
                    if v:
                        raw_records.append({"time": f"{h:02d}:00 – {h:02d}:59", "label": "小时步数", "value": f"{int(v):,} 步"})
                raw_records.reverse()

                tot_steps = d_row.get("steps")
                if tot_steps is None and hourly_available:
                    tot_steps = int(sum((b["val"] or 0) for b in buckets))
                prev7_steps = _avg([r.get("steps") for r in comp_days if r.get("steps") is not None], 0)
                highlights = []
                if tot_steps is not None:
                    diff = round(float(tot_steps) - (prev7_steps or float(tot_steps)))
                    highlights.append(_build_highlight(
                        "与近 7 天平均步数对比",
                        f"{anchor_end.month}/{anchor_end.day}",
                        f"当日累计 {int(tot_steps):,} 步，较近 7 天日均{'多' if diff >= 0 else '少'} {abs(diff):,} 步。",
                        float(tot_steps),
                        prev7_steps,
                        "当日",
                        "近 7 天均值",
                        f"{int(tot_steps):,} 步",
                        f"{int(prev7_steps):,} 步" if prev7_steps is not None else "-",
                        "#FF9500",
                    ))

                sub_metrics = [
                    {"label": "步行距离", "value": f"{round(float(d_row.get('distance_m') or 0) / 1000.0, 2)} 公里"},
                    {"label": "活动消耗", "value": f"{round(float(d_row.get('calories_kcal') or 0), 1)} 千卡"},
                    {"label": "每日目标", "value": f"{int(d_row.get('step_goal') or 10000):,} 步"},
                ]
                base_resp.update({
                    "hero": {
                        "kicker": "总步数",
                        "primary": f"{int(tot_steps):,}" if tot_steps is not None else "-",
                        "unit": "步",
                        "range_label": base_resp["range_label"],
                    },
                    "goal": int(d_row.get("step_goal") or 10000),
                    "hourly_available": hourly_available,
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": raw_records,
                })
                return base_resp

            # heart_rate / hrv / spo2 / stress single-day vitals
            vital_metric_map = {
                "heart_rate": "heart_rate",
                "hrv": "hrv_rmssd",
                "spo2": "spo2",
                "stress": "stress",
            }
            vm = vital_metric_map[mtype]
            all_vals: list[float] = []
            raw_hr_pts: list[tuple[int, str, float]] = []
            for vr in con.execute(
                "SELECT ts_iso, value, unit FROM vitals_points WHERE date = ? AND metric = ? ORDER BY ts_ms ASC;",
                (str(anchor_end), vm),
            ):
                hourly_available = True
                hr = int(vr["ts_iso"][11:13])
                mm = int(vr["ts_iso"][14:16])
                v = float(vr["value"])
                hourly_pts[hr].append(v)
                all_vals.append(v)
                if mtype == "heart_rate":
                    raw_hr_pts.append((hr * 60 + mm, str(vr["ts_iso"][11:16]), round(v, 1)))
                raw_records.append({
                    "time": vr["ts_iso"][11:19],
                    "label": METRIC_TITLES[mtype],
                    "value": f"{round(v, 1):g} {'次/分' if mtype == 'heart_rate' else ('毫秒' if mtype == 'hrv' else ('%' if mtype == 'spo2' else '分'))}",
                })
            raw_records.reverse()

            buckets = []
            for h in range(24):
                pts = hourly_pts.get(h) or []
                buckets.append({
                    "key": f"{h:02d}",
                    "tick": f"{h}时" if h in (0, 6, 12, 18) else "",
                    "scrub_title": f"{anchor_end} {h:02d}:00 – {h:02d}:59",
                    "min": round(min(pts), 1) if pts else None,
                    "max": round(max(pts), 1) if pts else None,
                    "avg": round(sum(pts) / len(pts), 1) if pts else None,
                    "count": len(pts),
                })

            if mtype == "heart_rate":
                lo = round(min(all_vals)) if all_vals else (round(d_row["hr_min"]) if d_row.get("hr_min") is not None else None)
                hi = round(max(all_vals)) if all_vals else (round(d_row["hr_max"]) if d_row.get("hr_max") is not None else None)
                primary = f"{lo}–{hi}" if (lo is not None and hi is not None) else "-"
                prev7_rest = _avg([r.get("hr_rest") for r in comp_days if r.get("hr_rest") is not None], 1)
                cur_rest = d_row.get("hr_rest")
                if len(raw_hr_pts) > 288:
                    hr_bins: dict[int, list[float]] = defaultdict(list)
                    for m_day, _t, val in raw_hr_pts:
                        hr_bins[m_day // 5].append(val)
                    hr_series = [
                        {"m": b * 5 + 2, "t": f"{(b * 5) // 60:02d}:{(b * 5) % 60:02d}", "v": round(sum(vs) / len(vs), 1)}
                        for b, vs in sorted(hr_bins.items())
                    ]
                else:
                    hr_series = [{"m": m_day, "t": t_str, "v": val} for m_day, t_str, val in raw_hr_pts]
                highlights = []
                if cur_rest is not None:
                    highlights.append(_build_highlight(
                        "静息心率变化",
                        f"{anchor_end.month}/{anchor_end.day}",
                        f"当日静息心率 {round(cur_rest)} 次/分，全天心率区间 {primary} 次/分。",
                        float(cur_rest),
                        prev7_rest,
                        "当日静息",
                        "近 7 天静息均值",
                        f"{round(cur_rest)} 次/分",
                        f"{round(prev7_rest, 1)} 次/分" if prev7_rest is not None else "-",
                        "#FF2D55",
                    ))
                sub_metrics = [
                    {"label": "静息心率", "value": f"{round(cur_rest)} 次/分" if cur_rest is not None else "-"},
                    {"label": "夜间睡眠均心率", "value": f"{round(d_row['sleep_avg_hr'])} 次/分" if d_row.get("sleep_avg_hr") is not None else "-"},
                    {"label": "全天平均心率", "value": f"{round(sum(all_vals)/len(all_vals), 1)} 次/分" if all_vals else (f"{round(d_row['hr_avg'], 1)} 次/分" if d_row.get("hr_avg") is not None else "-")},
                ]
                base_resp.update({
                    "hero": {"kicker": "心率范围", "primary": primary, "unit": "次/分", "range_label": base_resp["range_label"]},
                    "hourly_available": hourly_available,
                    "buckets": buckets,
                    "hr_series": hr_series,
                    "rest_ref": round(float(cur_rest), 1) if cur_rest is not None else None,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": raw_records[:60],
                })
                return base_resp

            if mtype == "hrv":
                hrv28_rows = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=27)), str(anchor_end))
                hrv28_vals = sorted(v for v in (_hrv_val(r) for r in hrv28_rows) if v is not None)
                baseline = None
                if hrv28_vals:
                    b_avg = round(sum(hrv28_vals) / len(hrv28_vals), 1)
                    b_lo = round(hrv28_vals[max(0, int(len(hrv28_vals) * 0.25))], 1)
                    b_hi = round(hrv28_vals[min(len(hrv28_vals) - 1, int(len(hrv28_vals) * 0.75))], 1)
                    cur_v = round(sum(all_vals) / len(all_vals), 1) if all_vals else _hrv_val(d_row)
                    status = "处于个人基线" if (cur_v is not None and b_lo <= cur_v <= b_hi) else ("高于基线（恢复良好）" if (cur_v or 0) > b_hi else "偏低于基线（注意休息）")
                    baseline = {"low": b_lo, "high": b_hi, "avg": b_avg, "status": status}

                cur_v = round(sum(all_vals) / len(all_vals), 1) if all_vals else _hrv_val(d_row)
                prev7_hrv = _avg([_hrv_val(r) for r in comp_days], 1)
                highlights = []
                if cur_v is not None:
                    highlights.append(_build_highlight(
                        "与近 7 天 HRV 均值对比",
                        baseline["status"] if baseline else "RMSSD",
                        f"当日平均 HRV {cur_v} 毫秒，{baseline['status'] if baseline else ''}。",
                        cur_v,
                        prev7_hrv,
                        "当日平均",
                        "近 7 天均值",
                        f"{cur_v} 毫秒",
                        f"{prev7_hrv} 毫秒" if prev7_hrv is not None else "-",
                        "#28CD41",
                    ))
                sub_metrics = [
                    {"label": "个人 28 天基线区间", "value": f"{baseline['low']}–{baseline['high']} 毫秒" if baseline else "-"},
                    {"label": "夜间睡眠平均 HRV", "value": f"{d_row['sleep_avg_hrv']} 毫秒" if d_row.get("sleep_avg_hrv") is not None else "-"},
                    {"label": "当日最低 / 最高", "value": f"{round(min(all_vals))} / {round(max(all_vals))} 毫秒" if all_vals else "-"},
                ]
                base_resp.update({
                    "hero": {"kicker": "平均心率变异性", "primary": f"{cur_v}" if cur_v is not None else "-", "unit": "毫秒", "range_label": base_resp["range_label"]},
                    "baseline": baseline,
                    "hourly_available": hourly_available,
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": raw_records[:60],
                })
                return base_resp

            if mtype == "spo2":
                lo = round(min(all_vals)) if all_vals else (round(d_row["spo2_min"]) if d_row.get("spo2_min") is not None else None)
                hi = round(max(all_vals)) if all_vals else (round(d_row["spo2_max"]) if d_row.get("spo2_max") is not None else None)
                avg_v = round(sum(all_vals) / len(all_vals), 1) if all_vals else d_row.get("spo2_avg")
                primary = f"{lo}–{hi}%" if (lo is not None and hi is not None and lo != hi) else (f"{lo}%" if lo is not None else "-")
                prev7_spo2 = _avg([r.get("spo2_avg") for r in comp_days if r.get("spo2_avg") is not None], 1)
                highlights = []
                if avg_v is not None:
                    highlights.append(_build_highlight(
                        "血氧饱和度稳定性",
                        f"平均 {avg_v}%",
                        f"全天血氧处于 {primary}，95%–100% 通常为理想健康范围。",
                        float(avg_v),
                        prev7_spo2,
                        "当日均值",
                        "近 7 天均值",
                        f"{avg_v}%",
                        f"{prev7_spo2}%" if prev7_spo2 is not None else "-",
                        "#30B0C7",
                    ))
                sub_metrics = [
                    {"label": "全天平均血氧", "value": f"{avg_v}%" if avg_v is not None else "-"},
                    {"label": "夜间睡眠均血氧", "value": f"{d_row['sleep_avg_spo2']}%" if d_row.get("sleep_avg_spo2") is not None else "-"},
                    {"label": "低于 95% 采样次数", "value": f"{sum(1 for v in all_vals if v < 95)} 次"},
                ]
                base_resp.update({
                    "hero": {"kicker": "血氧范围", "primary": primary, "unit": "", "range_label": base_resp["range_label"]},
                    "ref_line": 95.0,
                    "hourly_available": hourly_available,
                    "buckets": buckets,
                    "highlights": highlights,
                    "sub_metrics": sub_metrics,
                    "records": raw_records[:60],
                })
                return base_resp

            # stress Single Day (+ emotion distribution)
            avg_st = round(sum(all_vals) / len(all_vals), 1) if all_vals else d_row.get("stress_avg")
            prev7_st = _avg([r.get("stress_avg") for r in comp_days if r.get("stress_avg") is not None], 1)
            emo_tot = int(d_row.get("emotion_total_count") or 0)
            emo_peace = int(d_row.get("emotion_peace_count") or 0)
            emo_pleas = int(d_row.get("emotion_pleasant_count") or 0)
            emo_unpl = int(d_row.get("emotion_unpleasant_count") or 0)
            peace_pct = round(100.0 * emo_peace / emo_tot, 1) if emo_tot > 0 else None
            highlights = []
            if avg_st is not None:
                highlights.append(_build_highlight(
                    "压力负荷水平",
                    f"平和情绪 {peace_pct}%" if peace_pct is not None else "压力评分",
                    f"当日平均压力 {avg_st} 分（1–29 放松 · 30–59 正常 · 60–79 偏高）。",
                    float(avg_st),
                    prev7_st,
                    "当日均值",
                    "近 7 天均值",
                    f"{avg_st} 分",
                    f"{prev7_st} 分" if prev7_st is not None else "-",
                    "#AF52DE",
                ))
            sub_metrics = [
                {"label": "压力极值区间", "value": f"{int(round(min(all_vals)))}–{int(round(max(all_vals)))} 分" if all_vals else (f"{d_row.get('stress_min') or '-'}–{d_row.get('stress_max') or '-'} 分")},
                {"label": "心理状态分布", "value": f"平和 {emo_peace} · 愉悦 {emo_pleas} · 不悦 {emo_unpl}" if emo_tot > 0 else "-"},
                {"label": "采样记录条数", "value": f"{len(all_vals) or (d_row.get('stress_count') or 0)} 条"},
            ]
            base_resp.update({
                "hero": {"kicker": "平均压力值", "primary": f"{avg_st}" if avg_st is not None else "-", "unit": "分", "range_label": base_resp["range_label"]},
                "emotion": {"total": emo_tot, "peace": emo_peace, "pleasant": emo_pleas, "unpleasant": emo_unpl},
                "hourly_available": hourly_available,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": raw_records[:60],
            })
            return base_resp

        # ------------------------------------------------------------------
        # Multi-Day Scopes (W / M / 6M / Y) for heart_rate, hrv, spo2, stress, steps
        # ------------------------------------------------------------------
        slots = _group_period_slots(cur_days, cur_start, anchor_end, sc)
        is_macro = sc in ("6M", "Y")

        if mtype == "steps":
            buckets = []
            for key, tick, scrub, rs in slots:
                vals = [float(r["steps"]) for r in rs if r.get("steps") is not None]
                val = round(sum(vals) / len(vals), 0) if (is_macro and vals) else (round(vals[0], 0) if vals else None)
                tot = round(sum(vals), 0) if vals else 0
                buckets.append({"key": key, "tick": tick, "scrub_title": scrub, "val": val, "sum": tot, "days": len(vals)})

            cur_vals = [float(r["steps"]) for r in cur_days if r.get("steps") is not None]
            prev_vals = [float(r["steps"]) for r in comp_days if r.get("steps") is not None]
            cur_avg = _avg(cur_vals, 0)
            prev_avg = _avg(prev_vals, 0)
            tot_dist = round(sum(float(r.get("distance_m") or 0) for r in cur_days) / 1000.0, 1)
            highlights = []
            if cur_avg is not None:
                diff = round(cur_avg - prev_avg) if prev_avg is not None else 0
                insight = (
                    f"本周期日均 {int(cur_avg):,} 步，较上一周期{'增加' if diff >= 0 else '减少'} {abs(diff):,} 步。"
                    if prev_avg is not None
                    else f"本周期日均 {int(cur_avg):,} 步，总计行进 {tot_dist} 公里。"
                )
                highlights.append(_build_highlight(
                    "每日平均步数对比",
                    f"总 {int(sum(cur_vals)):,} 步",
                    insight,
                    cur_avg,
                    prev_avg,
                    "本周期日均",
                    "上一周期日均",
                    f"{int(cur_avg):,} 步",
                    f"{int(prev_avg):,} 步" if prev_avg is not None else "-",
                    "#FF9500",
                ))
            sub_metrics = [
                {"label": "周期累计距离", "value": f"{tot_dist} 公里"},
                {"label": "日均活动消耗", "value": f"{_avg([r.get('calories_kcal') for r in cur_days], 0) or '-'} 千卡"},
                {"label": "达成目标天数", "value": f"{sum(1 for r in cur_days if (r.get('steps') or 0) >= (r.get('step_goal') or 10000))} / {len(cur_vals)} 天"},
            ]
            records = [
                {"time": r["date"], "label": "日步数", "value": f"{int(r['steps']):,} 步"}
                for r in reversed(cur_days)
                if r.get("steps") is not None
            ]
            base_resp.update({
                "hero": {"kicker": "平均每日步数", "primary": f"{int(cur_avg):,}" if cur_avg is not None else "-", "unit": "步", "range_label": base_resp["range_label"]},
                "goal": int(cur_days[-1].get("step_goal") or 10000) if cur_days else 10000,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        if mtype == "heart_rate":
            buckets = []
            for key, tick, scrub, rs in slots:
                mins = [float(r["hr_min"]) for r in rs if r.get("hr_min") is not None]
                maxs = [float(r["hr_max"]) for r in rs if r.get("hr_max") is not None]
                avgs = [float(r["hr_avg"]) for r in rs if r.get("hr_avg") is not None]
                rests = [float(r["hr_rest"]) for r in rs if r.get("hr_rest") is not None]
                avg_v = (
                    round(sum(avgs) / len(avgs), 1)
                    if avgs
                    else (round((min(mins) + max(maxs)) / 2.0, 1) if mins and maxs else (round(sum(rests) / len(rests), 1) if rests else None))
                )
                buckets.append({
                    "key": key,
                    "tick": tick,
                    "scrub_title": scrub,
                    "min": round(min(mins), 0) if mins else None,
                    "max": round(max(maxs), 0) if maxs else None,
                    "avg": avg_v,
                    "rest": round(sum(rests) / len(rests), 1) if rests else None,
                    "days": len(rs),
                })

            all_lo = [float(r["hr_min"]) for r in cur_days if r.get("hr_min") is not None]
            all_hi = [float(r["hr_max"]) for r in cur_days if r.get("hr_max") is not None]
            cur_rest = _avg([r.get("hr_rest") for r in cur_days if r.get("hr_rest") is not None], 1)
            prev_rest = _avg([r.get("hr_rest") for r in comp_days if r.get("hr_rest") is not None], 1)
            primary = f"{round(min(all_lo))}–{round(max(all_hi))}" if (all_lo and all_hi) else "-"
            highlights = []
            if cur_rest is not None:
                diff = round(cur_rest - prev_rest, 1) if prev_rest is not None else 0
                highlights.append(_build_highlight(
                    "静息心率趋势",
                    f"均 {cur_rest} 次/分",
                    (f"本周期静息心率均值 {cur_rest} 次/分，较上一周期{'上升' if diff > 0 else '下降'} {abs(diff)} 次/分。" if prev_rest is not None else f"本周期心率跨度 {primary} 次/分。"),
                    cur_rest,
                    prev_rest,
                    "本周期静息",
                    "上一周期静息",
                    f"{cur_rest} 次/分",
                    f"{prev_rest} 次/分" if prev_rest is not None else "-",
                    "#FF2D55",
                ))
            sub_metrics = [
                {"label": "平均静息心率", "value": f"{cur_rest} 次/分" if cur_rest is not None else "-"},
                {"label": "夜间睡眠均心率", "value": f"{_avg([r.get('sleep_avg_hr') for r in cur_days], 1) or '-'} 次/分"},
                {"label": "全周期最高峰值", "value": f"{round(max(all_hi))} 次/分" if all_hi else "-"},
            ]
            records = [
                {"time": r["date"], "label": f"静息 {round(r['hr_rest']) if r.get('hr_rest') is not None else '-'} bpm", "value": f"{round(r['hr_min'])}–{round(r['hr_max'])} 次/分"}
                for r in reversed(cur_days)
                if r.get("hr_min") is not None and r.get("hr_max") is not None
            ]
            base_resp.update({
                "hero": {"kicker": "心率范围", "primary": primary, "unit": "次/分", "range_label": base_resp["range_label"]},
                "rest_ref": cur_rest,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        if mtype == "hrv":
            buckets = []
            for key, tick, scrub, rs in slots:
                vals = [v for v in (_hrv_val(r) for r in rs) if v is not None]
                mins = [float(r["hrv_min"]) for r in rs if r.get("hrv_min") is not None]
                maxs = [float(r["hrv_max"]) for r in rs if r.get("hrv_max") is not None]
                avg_v = round(sum(vals) / len(vals), 1) if vals else None
                buckets.append({
                    "key": key,
                    "tick": tick,
                    "scrub_title": scrub,
                    "min": round(min(mins), 0) if mins else (round(min(vals), 0) if vals else None),
                    "max": round(max(maxs), 0) if maxs else (round(max(vals), 0) if vals else None),
                    "avg": avg_v,
                })
            hrv28_rows = _fetch_daily_rows(con, str(anchor_end - dt.timedelta(days=27)), str(anchor_end))
            hrv28_vals = sorted(v for v in (_hrv_val(r) for r in hrv28_rows) if v is not None)
            baseline = None
            cur_vals = [v for v in (_hrv_val(r) for r in cur_days) if v is not None]
            cur_avg = _avg(cur_vals, 1)
            prev_avg = _avg([v for v in (_hrv_val(r) for r in comp_days) if v is not None], 1)
            if hrv28_vals:
                b_lo = round(hrv28_vals[max(0, int(len(hrv28_vals) * 0.25))], 1)
                b_hi = round(hrv28_vals[min(len(hrv28_vals) - 1, int(len(hrv28_vals) * 0.75))], 1)
                status = "处于个人基线" if (cur_avg is not None and b_lo <= cur_avg <= b_hi) else ("高于个人基线" if (cur_avg or 0) > b_hi else "低于个人基线")
                baseline = {"low": b_lo, "high": b_hi, "avg": round(sum(hrv28_vals) / len(hrv28_vals), 1), "status": status}
            highlights = []
            if cur_avg is not None:
                diff = round(cur_avg - prev_avg, 1) if prev_avg is not None else 0
                highlights.append(_build_highlight(
                    "恢复力 HRV 对比",
                    baseline["status"] if baseline else "RMSSD",
                    (f"本周期平均 HRV {cur_avg} 毫秒，较上一周期{'提升' if diff >= 0 else '下降'} {abs(diff)} 毫秒。" if prev_avg is not None else f"本周期平均 HRV {cur_avg} 毫秒。"),
                    cur_avg,
                    prev_avg,
                    "本周期平均",
                    "上一周期平均",
                    f"{cur_avg} 毫秒",
                    f"{prev_avg} 毫秒" if prev_avg is not None else "-",
                    "#28CD41",
                ))
            sub_metrics = [
                {"label": "个人 28 天基线区间", "value": f"{baseline['low']}–{baseline['high']} 毫秒" if baseline else "-"},
                {"label": "夜间睡眠平均 HRV", "value": f"{_avg([r.get('sleep_avg_hrv') for r in cur_days], 1) or '-'} 毫秒"},
                {"label": "周期最高 / 最低", "value": f"{round(max(cur_vals), 1)} / {round(min(cur_vals), 1)} 毫秒" if cur_vals else "-"},
            ]
            records = [
                {"time": r["date"], "label": f"范围 {round(r['hrv_min'])}–{round(r['hrv_max'])} ms" if r.get("hrv_min") is not None else "日均 HRV", "value": f"{round(_hrv_val(r), 1)} 毫秒"}
                for r in reversed(cur_days)
                if _hrv_val(r) is not None
            ]
            base_resp.update({
                "hero": {"kicker": "平均心率变异性", "primary": f"{cur_avg}" if cur_avg is not None else "-", "unit": "毫秒", "range_label": base_resp["range_label"]},
                "baseline": baseline,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        if mtype == "spo2":
            buckets = []
            for key, tick, scrub, rs in slots:
                mins = [float(r["spo2_min"]) for r in rs if r.get("spo2_min") is not None]
                maxs = [float(r["spo2_max"]) for r in rs if r.get("spo2_max") is not None]
                avgs = [float(r["spo2_avg"]) for r in rs if r.get("spo2_avg") is not None]
                buckets.append({
                    "key": key,
                    "tick": tick,
                    "scrub_title": scrub,
                    "min": round(min(mins), 0) if mins else (round(min(avgs), 1) if avgs else None),
                    "max": round(max(maxs), 0) if maxs else (round(max(avgs), 1) if avgs else None),
                    "avg": round(sum(avgs) / len(avgs), 1) if avgs else None,
                })
            cur_avgs = [float(r["spo2_avg"]) for r in cur_days if r.get("spo2_avg") is not None]
            cur_mins = [float(r["spo2_min"]) for r in cur_days if r.get("spo2_min") is not None]
            cur_maxs = [float(r["spo2_max"]) for r in cur_days if r.get("spo2_max") is not None]
            cur_avg = _avg(cur_avgs, 1)
            prev_avg = _avg([r.get("spo2_avg") for r in comp_days if r.get("spo2_avg") is not None], 1)
            primary = f"{round(min(cur_mins))}–{round(max(cur_maxs))}%" if (cur_mins and cur_maxs) else (f"{cur_avg}%" if cur_avg is not None else "-")
            highlights = []
            if cur_avg is not None:
                highlights.append(_build_highlight(
                    "血氧均值对比",
                    f"均 {cur_avg}%",
                    f"本周期平均血氧 {cur_avg}%，最低 {round(min(cur_mins)) if cur_mins else '-'}%。",
                    cur_avg,
                    prev_avg,
                    "本周期均值",
                    "上一周期均值",
                    f"{cur_avg}%",
                    f"{prev_avg}%" if prev_avg is not None else "-",
                    "#30B0C7",
                ))
            sub_metrics = [
                {"label": "周期平均血氧", "value": f"{cur_avg}%" if cur_avg is not None else "-"},
                {"label": "夜间睡眠均血氧", "value": f"{_avg([r.get('sleep_avg_spo2') for r in cur_days], 1) or '-'}%"},
                {"label": "低于 95% 天数", "value": f"{sum(1 for v in cur_mins if v < 95)} / {len(cur_mins)} 天"},
            ]
            records = [
                {"time": r["date"], "label": f"均值 {r['spo2_avg']}%" if r.get("spo2_avg") is not None else "日血氧", "value": f"{round(r['spo2_min'])}–{round(r['spo2_max'])}%" if r.get("spo2_min") is not None else "-"}
                for r in reversed(cur_days)
                if r.get("spo2_avg") is not None
            ]
            base_resp.update({
                "hero": {"kicker": "血氧饱和度范围", "primary": primary, "unit": "", "range_label": base_resp["range_label"]},
                "ref_line": 95.0,
                "buckets": buckets,
                "highlights": highlights,
                "sub_metrics": sub_metrics,
                "records": records[:60],
            })
            return base_resp

        # stress Multi-Day (+ emotion)
        buckets = []
        for key, tick, scrub, rs in slots:
            mins = [float(r["stress_min"]) for r in rs if r.get("stress_min") is not None]
            maxs = [float(r["stress_max"]) for r in rs if r.get("stress_max") is not None]
            avgs = [float(r["stress_avg"]) for r in rs if r.get("stress_avg") is not None]
            buckets.append({
                "key": key,
                "tick": tick,
                "scrub_title": scrub,
                "min": round(min(mins), 0) if mins else (round(min(avgs), 0) if avgs else None),
                "max": round(max(maxs), 0) if maxs else (round(max(avgs), 0) if avgs else None),
                "avg": round(sum(avgs) / len(avgs), 1) if avgs else None,
            })

        cur_avgs = [float(r["stress_avg"]) for r in cur_days if r.get("stress_avg") is not None]
        cur_avg = _avg(cur_avgs, 1)
        prev_avg = _avg([r.get("stress_avg") for r in comp_days if r.get("stress_avg") is not None], 1)
        emo_tot = sum(int(r.get("emotion_total_count") or 0) for r in cur_days)
        emo_peace = sum(int(r.get("emotion_peace_count") or 0) for r in cur_days)
        emo_pleas = sum(int(r.get("emotion_pleasant_count") or 0) for r in cur_days)
        emo_unpl = sum(int(r.get("emotion_unpleasant_count") or 0) for r in cur_days)
        peace_pct = round(100.0 * emo_peace / emo_tot, 1) if emo_tot > 0 else None

        highlights = []
        if cur_avg is not None:
            highlights.append(_build_highlight(
                "压力与心理平衡",
                f"平和情绪 {peace_pct}%" if peace_pct is not None else "压力均值",
                f"本周期平均压力 {cur_avg} 分，积极与平和情绪占比较稳。",
                cur_avg,
                prev_avg,
                "本周期均值",
                "上一周期均值",
                f"{cur_avg} 分",
                f"{prev_avg} 分" if prev_avg is not None else "-",
                "#AF52DE",
            ))
        sub_metrics = [
            {"label": "平均压力值", "value": f"{cur_avg} 分" if cur_avg is not None else "-"},
            {"label": "平和情绪比例", "value": f"{peace_pct}%" if peace_pct is not None else "-"},
            {"label": "情绪样本分布", "value": f"平和 {emo_peace} · 愉悦 {emo_pleas} · 不悦 {emo_unpl}" if emo_tot > 0 else "-"},
        ]
        records = [
            {"time": r["date"], "label": f"区间 {round(r['stress_min'])}–{round(r['stress_max'])} 分" if r.get("stress_min") is not None else "日均压力", "value": f"{round(r['stress_avg'], 1)} 分"}
            for r in reversed(cur_days)
            if r.get("stress_avg") is not None
        ]
        base_resp.update({
            "hero": {"kicker": "平均压力评分", "primary": f"{cur_avg}" if cur_avg is not None else "-", "unit": "分", "range_label": base_resp["range_label"]},
            "emotion": {"total": emo_tot, "peace": emo_peace, "pleasant": emo_pleas, "unpleasant": emo_unpl},
            "buckets": buckets,
            "highlights": highlights,
            "sub_metrics": sub_metrics,
            "records": records[:60],
        })
        return base_resp
    finally:
        con.close()

