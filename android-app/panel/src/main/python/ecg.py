"""Normalized lead-I ECG storage. All waveforms are calibrated millivolts."""
import gzip
import io
import json
import math
import struct
from contextlib import closing
from datetime import date, timedelta
from pathlib import Path

from db import open_health_db

# Signed microvolts are delta encoded to avoid storing redundant float bits.
MAX_SAMPLES = 120_000


def encode_waveform(samples):
    uv = [round(value * 1000) for value in samples]
    if not 1 <= len(uv) <= MAX_SAMPLES or any(abs(value) > 30_000 for value in uv):
        raise ValueError("Invalid ECG waveform")
    deltas = [uv[0]] + [value - previous for previous, value in zip(uv, uv[1:])]
    if any(abs(value) > 32767 for value in deltas):
        raise ValueError("Invalid ECG waveform delta")
    return gzip.compress(struct.pack(f"<{len(deltas)}h", *deltas), mtime=0)


def decode_waveform(data):
    if not data:
        return []
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        raw = stream.read(MAX_SAMPLES * 2 + 1)
    if len(raw) % 2 or len(raw) > MAX_SAMPLES * 2:
        raise ValueError("Invalid ECG waveform length")
    accum = 0
    samples = []
    for (delta,) in struct.iter_unpack("<h", raw):
        accum += delta
        if abs(accum) > 30_000:
            raise ValueError("Invalid ECG waveform sample")
        samples.append(accum / 1000)
    return samples


def _has_records(con):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ecg_records'").fetchone()


def _record(row, include_waveform=False):
    data = dict(row)
    blob = data.pop("waveform_gz", None)
    try:
        symptoms = json.loads(data.pop("symptoms_json", None) or "[]")
        data["symptoms"] = [value for value in symptoms if isinstance(value, str)] if isinstance(symptoms, list) else []
    except ValueError:
        data["symptoms"] = []
    hz = data["sample_rate_hz"]
    if include_waveform:
        try:
            data["waveform_mv"] = decode_waveform(blob) if hz and math.isfinite(hz) and 1 <= hz <= 4096 else []
        except (OSError, EOFError, ValueError):
            data["waveform_mv"] = []
    return data


_FIELDS = """start_ms, end_ms, date, start_iso, classification, classification_code,
             avg_hr, sample_rate_hz, duration_s, lead_count, symptoms_json, device_name"""


def preview_samples(waveform):
    if len(waveform) <= 96:
        return waveform
    stride = len(waveform) // 48
    preview = []
    for start in range(0, len(waveform), stride):
        batch = waveform[start:start + stride]
        lo, hi = min(batch), max(batch)
        preview.extend((lo, hi) if batch.index(lo) < batch.index(hi) else (hi, lo))
    return preview


_ECG_DISCLAIMER = "基于单导联 R 波与 RR 间期特征的本地轻量算法分析，仅供参考，不构成医疗诊断。"


def _quantile(sorted_vals, q):
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = max(0.0, min(1.0, q)) * (len(sorted_vals) - 1)
    lo = int(math.floor(pos))
    hi = min(len(sorted_vals) - 1, lo + 1)
    frac = pos - lo
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac)


def _moving_avg(arr, win):
    n = len(arr)
    if n == 0 or win <= 1:
        return list(arr)
    half = win // 2
    prefix = [0.0] * (n + 1)
    for idx, val in enumerate(arr):
        prefix[idx + 1] = prefix[idx] + val
    out = [0.0] * n
    for idx in range(n):
        lo = 0 if idx < half else idx - half
        hi = n if idx + half + 1 > n else idx + half + 1
        out[idx] = (prefix[hi] - prefix[lo]) / (hi - lo)
    return out


def _ecg_result(rtype, label, tone, summary, *, bpm=None, beat_count=None, median_rr_ms=None,
                cv_rr_pct=None, qrs_ms=None, premature_count=0):
    return {
        "type": rtype,
        "label": label,
        "tone": tone,
        "bpm": bpm,
        "beat_count": beat_count,
        "median_rr_ms": median_rr_ms,
        "cv_rr_pct": cv_rr_pct,
        "qrs_ms": qrs_ms,
        "premature_count": premature_count,
        "summary": summary,
        "disclaimer": _ECG_DISCLAIMER,
    }


def classify_waveform(samples, sample_rate_hz):
    """Classify single-lead ECG rhythm from Lead-I mV waveform and sample rate."""
    if not samples or not sample_rate_hz or not math.isfinite(sample_rate_hz):
        return _ecg_result("signal_too_short", "采样过短 / 无法识别", "muted", "缺少有效的采样率或波形数据。")
    hz = float(sample_rate_hz)
    if not 100.0 <= hz <= 2000.0 or len(samples) < int(round(4.0 * hz)):
        return _ecg_result("signal_too_short", "采样过短 / 无法识别", "muted", "有效记录时长不足 4 秒，无法可靠识别节律。")

    clean = []
    bad_count = 0
    for val in samples:
        if isinstance(val, (int, float)) and math.isfinite(val):
            clean.append(float(val))
            if abs(val) > 4.5:
                bad_count += 1
        else:
            clean.append(0.0)
            bad_count += 1
    n = len(clean)
    if bad_count / n > 0.10:
        return _ecg_result("poor_signal", "信号质量不佳", "warn", "检测到较多超量程或无效采样点，建议贴合电极后重测。")

    base_win = max(3, int(round(0.20 * hz)) | 1)
    baseline = _moving_avg(clean, base_win)
    hp = [a - b for a, b in zip(clean, baseline)]

    edge = min(n // 4, max(1, int(round(0.25 * hz))))
    interior = hp[edge:n - edge] if n > 2 * edge + 4 else hp
    if max((abs(v) for v in interior), default=0.0) < 0.08:
        return _ecg_result("poor_signal", "信号质量不佳", "warn", "波形幅值过弱或接近直线，未检测到有效心电信号。")

    lp_win = max(1, int(round(0.015 * hz)) | 1)
    smooth = _moving_avg(hp, lp_win)
    mag_d = [0.0] * n
    for idx in range(1, n):
        mag_d[idx] = abs(smooth[idx] - smooth[idx - 1])
    int_win = max(3, int(round(0.10 * hz)) | 1)
    env = _moving_avg(mag_d, int_win)

    env_inner = sorted(env[edge:n - edge])
    med_env = _quantile(env_inner, 0.50)
    ref_env = _quantile(env_inner, 0.98)
    thresh = max(med_env + 0.30 * (ref_env - med_env), 0.28 * ref_env, 1e-5)

    search_rad = max(2, int(round(0.08 * hz)))
    refrac = max(10, int(round(0.24 * hz)))
    r_peaks = []
    idx = edge
    limit_hi = n - edge
    while idx < limit_hi:
        if env[idx] < thresh:
            idx += 1
            continue
        seg_start = idx
        best_env_idx = idx
        best_env_val = env[idx]
        while idx < limit_hi and env[idx] >= thresh:
            if env[idx] > best_env_val:
                best_env_val = env[idx]
                best_env_idx = idx
            idx += 1
        win_lo = max(edge, min(seg_start, best_env_idx) - search_rad)
        win_hi = min(limit_hi - 1, max(idx - 1, best_env_idx) + search_rad)
        r_idx = best_env_idx
        best_amp = -1.0
        for pos in range(win_lo, win_hi + 1):
            amp = abs(hp[pos])
            if amp > best_amp:
                best_amp = amp
                r_idx = pos
        if not r_peaks or r_idx - r_peaks[-1] >= refrac:
            r_peaks.append(r_idx)
        elif abs(hp[r_idx]) > abs(hp[r_peaks[-1]]):
            r_peaks[-1] = r_idx

    if len(r_peaks) < 4:
        return _ecg_result("inconclusive", "波形不明确 / 无法判定", "muted",
                           f"仅识别出 {len(r_peaks)} 个清晰 QRS 波峰，尚不足以判定节律类型。",
                           beat_count=len(r_peaks))

    raw_rr = [(r_peaks[k + 1] - r_peaks[k]) * 1000.0 / hz for k in range(len(r_peaks) - 1)]
    valid_rr = [rr for rr in raw_rr if 240.0 <= rr <= 2400.0]
    if len(valid_rr) < 3:
        return _ecg_result("inconclusive", "波形不明确 / 无法判定", "muted",
                           "有效 RR 间期数量不足，无法稳定识别心律类型。",
                           beat_count=len(r_peaks))

    bad_rr_ratio = (len(raw_rr) - len(valid_rr)) / len(raw_rr)
    quiet_rad = max(2, int(round(0.12 * hz)))
    noise_sq = 0.0
    noise_n = 0
    peak_ptr = 0
    for pos in range(edge, limit_hi):
        while peak_ptr < len(r_peaks) and pos > r_peaks[peak_ptr] + quiet_rad:
            peak_ptr += 1
        if peak_ptr < len(r_peaks) and r_peaks[peak_ptr] - quiet_rad <= pos <= r_peaks[peak_ptr] + quiet_rad:
            continue
        noise_sq += hp[pos] * hp[pos]
        noise_n += 1
    r_amps = sorted(abs(hp[p]) for p in r_peaks)
    med_r_amp = _quantile(r_amps, 0.50)
    noise_rms = math.sqrt(noise_sq / noise_n) if noise_n > 0 else 0.0
    if bad_rr_ratio > 0.30 or (noise_n >= hz and med_r_amp > 0 and noise_rms > 0.45 * med_r_amp):
        return _ecg_result("poor_signal", "信号干扰较大 / 建议重测", "warn",
                           "基线干扰或伪差较多，建议保持静止与干燥接触后重新采集。",
                           beat_count=len(r_peaks))

    s_rr = sorted(valid_rr)
    median_rr = _quantile(s_rr, 0.50)
    mean_rr = sum(valid_rr) / len(valid_rr)
    std_rr = math.sqrt(sum((v - mean_rr) ** 2 for v in valid_rr) / len(valid_rr))
    cv_rr = std_rr / mean_rr if mean_rr > 0 else 0.0
    cv_pct = round(cv_rr * 100.0, 1)
    iqr_ratio = (_quantile(s_rr, 0.75) - _quantile(s_rr, 0.25)) / median_rr if median_rr > 0 else 0.0
    range_ratio = (s_rr[-1] - s_rr[0]) / median_rr if median_rr > 0 else 0.0
    diffs = [abs(valid_rr[k + 1] - valid_rr[k]) for k in range(len(valid_rr) - 1)]
    rmssd_ratio = (math.sqrt(sum(d * d for d in diffs) / len(diffs)) / median_rr) if diffs and median_rr > 0 else 0.0
    irregular_step_ratio = (sum(1 for d in diffs if d / median_rr > 0.15) / len(diffs)) if diffs and median_rr > 0 else 0.0
    bpm = int(round(60000.0 / median_rr)) if median_rr > 0 else 0
    median_rr_ms = int(round(median_rr))

    max_half = max(3, int(round(0.14 * hz)))
    beat_qrs = []
    for p in r_peaks:
        amp = abs(hp[p])
        cutoff = 0.20 * amp
        lo = p
        while lo > edge and p - lo < max_half and abs(hp[lo - 1]) >= cutoff:
            lo -= 1
        hi = p
        while hi < limit_hi - 1 and hi - p < max_half and abs(hp[hi + 1]) >= cutoff:
            hi += 1
        w_ms = max(40.0, min(220.0, (hi - lo) * 1000.0 / hz))
        beat_qrs.append(w_ms)
    median_qrs = int(round(_quantile(sorted(beat_qrs), 0.50)))

    tmpl_rad = max(3, int(round(0.06 * hz)))
    beat_vecs = []
    for p in r_peaks:
        if p - tmpl_rad >= 0 and p + tmpl_rad < n:
            beat_vecs.append(hp[p - tmpl_rad:p + tmpl_rad + 1])
        else:
            beat_vecs.append(None)
    valid_vecs = [v for v in beat_vecs if v is not None]
    tmpl = None
    tmpl_norm = 0.0
    if valid_vecs:
        vec_len = len(valid_vecs[0])
        tmpl = [_quantile(sorted(v[k] for v in valid_vecs), 0.50) for k in range(vec_len)]
        tmpl_norm = math.sqrt(sum(val * val for val in tmpl))
    beat_corr = []
    for vec in beat_vecs:
        if vec is None or tmpl is None or tmpl_norm <= 1e-9:
            beat_corr.append(1.0)
            continue
        vec_norm = math.sqrt(sum(val * val for val in vec))
        if vec_norm <= 1e-9:
            beat_corr.append(0.0)
        else:
            dot = sum(a * b for a, b in zip(vec, tmpl))
            beat_corr.append(dot / (vec_norm * tmpl_norm))

    premature_count = 0
    wide_premature_count = 0
    regular_baseline = iqr_ratio < 0.14 and irregular_step_ratio < 0.45
    if regular_baseline and median_rr > 0:
        for idx_rr, rr in enumerate(raw_rr):
            if not (240.0 <= rr <= 2400.0):
                continue
            if rr < 0.80 * median_rr:
                has_pause = (idx_rr + 1 < len(raw_rr)) and (240.0 <= raw_rr[idx_rr + 1] <= 2400.0) and (raw_rr[idx_rr + 1] > 1.12 * median_rr)
                b_idx = idx_rr + 1
                beat_aberrant = (
                    beat_corr[b_idx] < 0.72
                    or beat_qrs[b_idx] >= 120.0
                    or beat_qrs[b_idx] > 1.35 * median_qrs
                )
                if has_pause or beat_aberrant:
                    premature_count += 1
                    if beat_aberrant:
                        wide_premature_count += 1

    common = dict(
        bpm=bpm,
        beat_count=len(r_peaks),
        median_rr_ms=median_rr_ms,
        cv_rr_pct=cv_pct,
        qrs_ms=median_qrs,
        premature_count=premature_count,
    )

    if irregular_step_ratio >= 0.45 and (cv_rr >= 0.14 or rmssd_ratio >= 0.18) and iqr_ratio >= 0.12:
        return _ecg_result(
            "afib_suspected", "疑似心房颤动（房颤）", "alert",
            f"RR 间期呈现明显绝对不规整（节律变异 {cv_pct:.1f}%，相邻突变占比 {round(irregular_step_ratio * 100)}%），提示房颤节律特征。",
            **common,
        )
    if regular_baseline and premature_count >= 1:
        is_pvc = wide_premature_count >= 1
        label = "疑似室性早搏（早搏）" if is_pvc else "疑似房性早搏（早搏）"
        desc = "伴畸形宽大 QRS 形态及代偿间歇" if is_pvc else "伴提前心搏及代偿间歇，QRS 形态与主导搏一致"
        return _ecg_result(
            "premature_beat", label, "warn",
            f"在规整基线心率（{bpm} 次/分）下检测到 {premature_count} 次提前搏动（{desc}）。",
            **common,
        )
    if 50 <= bpm <= 100 and premature_count == 0 and irregular_step_ratio < 0.45 and (cv_rr >= 0.10 or range_ratio >= 0.22):
        return _ecg_result(
            "sinus_arrhythmia", "窦性心律不齐", "info",
            f"心率 {bpm} 次/分处于正常区间，RR 间期呈渐进周期性波动（变异度 {cv_pct:.1f}%），符合窦性心律不齐特征。",
            **common,
        )
    if bpm < 50:
        return _ecg_result(
            "sinus_bradycardia", "窦性心动过缓", "warn" if bpm < 45 else "info",
            f"识别平均心率约 {bpm} 次/分（平均 RR {median_rr_ms} ms），节律规整，低于 50 次/分。",
            **common,
        )
    if bpm > 100:
        return _ecg_result(
            "sinus_tachycardia", "窦性心动过速", "warn",
            f"识别平均心率约 {bpm} 次/分（平均 RR {median_rr_ms} ms），节律规整，高于 100 次/分。",
            **common,
        )
    return _ecg_result(
        "sinus_rhythm", "窦性心律", "good",
        f"心率 {bpm} 次/分，RR 间期规整（变异度 {cv_pct:.1f}%），符合窦性心律特征。",
        **common,
    )


def list_records(database, days=None, include_waveform=False, include_preview=False):
    records = []
    if Path(database).is_file():
        with closing(open_health_db(database, readonly=True)) as con:
            if _has_records(con):
                latest = con.execute("SELECT max(date) FROM ecg_records").fetchone()[0]
                if latest:
                    start = (date.fromisoformat(latest) - timedelta(days=days - 1)).isoformat() if days else ""
                    fields = _FIELDS + (", waveform_gz" if include_waveform or include_preview else "")
                    limit = 20 if include_waveform else 500
                    for index, row in enumerate(con.execute(
                        f"SELECT {fields} FROM ecg_records WHERE date >= ? ORDER BY start_ms DESC LIMIT ?", (start, limit))):
                        preview = include_preview and index < 50
                        record = _record(row, include_waveform or preview)
                        if preview:
                            record["preview_mv"] = preview_samples(record.pop("waveform_mv"))
                        elif include_waveform and record.get("waveform_mv"):
                            record["analysis"] = classify_waveform(record["waveform_mv"], record.get("sample_rate_hz"))
                        records.append(record)
    return {"available": bool(records), "records": records}


def get_record(database, record_id):
    if Path(database).is_file():
        with closing(open_health_db(database, readonly=True)) as con:
            if _has_records(con):
                row = con.execute(f"SELECT {_FIELDS}, waveform_gz FROM ecg_records WHERE start_ms = ?", (record_id,)).fetchone()
                if row:
                    record = _record(row, True)
                    if record.get("waveform_mv"):
                        record["analysis"] = classify_waveform(record["waveform_mv"], record.get("sample_rate_hz"))
                    return record
    raise KeyError("ECG record")
