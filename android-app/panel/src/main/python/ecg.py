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
                        records.append(record)
    return {"available": bool(records), "records": records}


def get_record(database, record_id):
    if Path(database).is_file():
        with closing(open_health_db(database, readonly=True)) as con:
            if _has_records(con):
                row = con.execute(f"SELECT {_FIELDS}, waveform_gz FROM ecg_records WHERE start_ms = ?", (record_id,)).fetchone()
                if row:
                    return _record(row, True)
    raise KeyError("ECG record")
