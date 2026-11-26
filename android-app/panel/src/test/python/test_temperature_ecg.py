import json
import math
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from db import open_health_db, upsert_batch
from ecg import classify_waveform, encode_waveform
from local_panel import import_snapshot, mcp_read, request


class TemperatureEcgTest(unittest.TestCase):
    def setUp(self):
        self.fixture_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.fixture_dir.cleanup)
        self.directory = Path(self.fixture_dir.name)
        self.panel = self.directory / "panel.sqlite"
        self.start = datetime(2026, 11, 24, 12, tzinfo=timezone.utc)

    def get(self, route, query=""):
        code, mime, _, body = json.loads(request(self.panel, "/api/v1/dashboard/" + route, query))
        self.assertEqual(code, 200, body)
        return json.loads(body) if mime == "application/json" else body

    def test_documented_body_temperature_survives_raw_snapshot_import(self):
        original = self.directory / "original.sqlite"
        start_ms = int(self.start.timestamp() * 1000)
        with closing(sqlite3.connect(original)) as conn, conn:
            conn.execute("CREATE TABLE sample_point_health (_id INTEGER PRIMARY KEY, type_id INTEGER, start_time INTEGER, value REAL, merged INTEGER, modified_time INTEGER)")
            conn.executemany("INSERT INTO sample_point_health VALUES (?, 2104, ?, ?, 0, ?)", [
                (1, start_ms, 36.4, start_ms),
                (2, start_ms + 60000, 37.2, start_ms + 60000),
                (3, start_ms + 120000, 368, start_ms + 120000),  # unverified scaling
            ])
        import_snapshot(original, self.panel, 0)
        day = self.get("metric", "type=body_temperature&scope=D")
        self.assertEqual(day["temperature_points"], [{"label": "12:00", "value": 36.4}, {"label": "12:01", "value": 37.2}])
        combined = self.get("metric", "type=temperature&scope=D")
        self.assertEqual([point["minute"] for point in combined["temperature_points"]], [720, 721])
        self.assertIsNone(combined["daily_wrist"])
        week = self.get("metric", "type=body_temperature&scope=W")
        self.assertEqual(week["temperature_points"][-1]["value"], 36.8)

    def test_legacy_schema_and_normalized_ecg_with_explicit_millivolts(self):
        legacy = self.directory / "legacy.sqlite"
        with closing(open_health_db(legacy)) as conn:
            for column in ("temp_min", "temp_max", "temp_avg", "temp_last", "skin_temp_baseline_delta"):
                conn.execute(f"ALTER TABLE daily_summary DROP COLUMN {column}")
            conn.execute("DROP TABLE ecg_records")
            conn.commit()
        import_snapshot(legacy, self.panel, 0)
        self.assertEqual(self.get("ecg")["records"], [])
        start_ms = int(self.start.timestamp() * 1000)
        fixture = self.directory / "normalized.sqlite"
        samples = [
            sum(height * math.exp(-((i / 500 % 1 - center) ** 2) / (2 * width ** 2))
                for center, width, height in ((.12, .02, .12), (.25, .012, -.14), (.28, .013, 1.15),
                                              (.32, .013, -.21), (.52, .041, .31)))
            for i in range(15000)
        ]
        blob = encode_waveform(samples)
        self.assertLess(len(blob), 30000)
        with closing(open_health_db(fixture)) as conn:
            upsert_batch(conn, {
                "daily_summary": [{"date": (self.start.date() - timedelta(days=i)).isoformat(),
                                   "skin_temp_baseline_delta": .3 - i / 10, "sleep_total_min": 420}
                                  for i in range(6)],
                "ecg_records": [{
                    "start_ms": start_ms, "end_ms": start_ms + 30000, "date": "2026-11-24",
                    "start_iso": self.start.isoformat(), "classification": "合成测试记录", "avg_hr": 60,
                    "sample_rate_hz": 500, "duration_s": 30, "waveform_gz": blob,
                }],
            })
        import_snapshot(fixture, self.panel, 0)
        wrist = self.get("metric", "type=skin_temperature&scope=W")
        self.assertEqual(wrist["temperature_points"][-1]["value"], .3)
        self.assertIsNotNone(wrist["typical_band"])
        weekly = self.get("metric", "type=temperature&scope=W")
        self.assertEqual(weekly["temperature_points"][-1]["wrist"], .3)
        self.assertIsNone(weekly["temperature_points"][-1]["body"])
        self.assertIsNotNone(weekly["typical_band"])
        day = self.get("metric", "type=temperature&scope=D")
        self.assertEqual(day["daily_wrist"], .3)
        self.assertEqual(day["temperature_points"], [])
        vitals = self.get("overview")["overnight_vitals"]["items"]
        self.assertIn("skin_temperature", {item["metric"] for item in vitals})
        recent = self.get("ecg")["records"][0]
        self.assertIn("preview_mv", recent)
        self.assertNotIn("waveform_mv", recent)
        record = self.get("ecg", f"id={start_ms}")
        self.assertEqual(len(record["waveform_mv"]), 15000)
        self.assertLess(max(abs(a - b) for a, b in zip(samples, record["waveform_mv"])), .00051)
        self.assertEqual(record["analysis"]["type"], "sinus_rhythm")
        self.assertAlmostEqual(record["analysis"]["bpm"], 60, delta=2)
        csv = self.get("ecg.csv", f"id={start_ms}")
        self.assertEqual(len(csv.splitlines()), 15001)
        mcp = json.loads(mcp_read(self.panel, "get_ecg_records", "{}"))
        self.assertNotIn("waveform_mv", mcp["records"][0])

    def _synth_waveform(self, beat_times, hz=500, duration_s=30.0, pvc_indices=None):
        pvc_set = set(pvc_indices or ())
        n = int(round(duration_s * hz))
        out = [0.0] * n
        for b_idx, t_r in enumerate(beat_times):
            is_pvc = b_idx in pvc_set
            lo = max(0, int((t_r - 0.25) * hz))
            hi = min(n, int((t_r + 0.40) * hz))
            for idx in range(lo, hi):
                dt = idx / hz - t_r
                if is_pvc:
                    out[idx] += -1.35 * math.exp(-(dt ** 2) / (2 * 0.042 ** 2)) + 0.35 * math.exp(-((dt - 0.16) ** 2) / (2 * 0.045 ** 2))
                else:
                    out[idx] += (
                        0.12 * math.exp(-((dt + 0.16) ** 2) / (2 * 0.021 ** 2))
                        - 0.14 * math.exp(-((dt + 0.03) ** 2) / (2 * 0.012 ** 2))
                        + 1.15 * math.exp(-(dt ** 2) / (2 * 0.013 ** 2))
                        - 0.21 * math.exp(-((dt - 0.04) ** 2) / (2 * 0.013 ** 2))
                        + 0.31 * math.exp(-((dt - 0.24) ** 2) / (2 * 0.041 ** 2))
                    )
        return out

    def _regular_beats(self, period, duration_s=30.0, start=0.5):
        beats = []
        t = start
        while t < duration_s - 0.35:
            beats.append(t)
            t += period
        return beats

    def test_ecg_rhythm_classifier_categories(self):
        hz = 500
        sinus = self.get_cls(self._synth_waveform(self._regular_beats(0.82), hz))
        self.assertEqual(sinus["type"], "sinus_rhythm")
        self.assertTrue(70 <= sinus["bpm"] <= 76)

        brady = self.get_cls(self._synth_waveform(self._regular_beats(1.30), hz))
        self.assertEqual(brady["type"], "sinus_bradycardia")
        self.assertTrue(43 <= brady["bpm"] <= 49)

        tachy = self.get_cls(self._synth_waveform(self._regular_beats(0.50), hz))
        self.assertEqual(tachy["type"], "sinus_tachycardia")
        self.assertTrue(115 <= tachy["bpm"] <= 125)

        afib_rr = [0.56, 0.94, 0.62, 1.12, 0.58, 0.89, 0.53, 1.05, 0.68, 0.49, 0.97, 0.61, 1.16, 0.57,
                   0.84, 0.52, 1.09, 0.66, 0.91, 0.55, 1.02, 0.63, 0.87, 0.54, 1.07, 0.60, 0.95, 0.59]
        afib_beats = [0.45]
        for rr in afib_rr:
            if afib_beats[-1] + rr < 29.6:
                afib_beats.append(afib_beats[-1] + rr)
        afib = self.get_cls(self._synth_waveform(afib_beats, hz))
        self.assertEqual(afib["type"], "afib_suspected")

        pvc_rr = [0.80] * 35
        pvc_rr[8] = 0.50
        pvc_rr[9] = 1.10
        pvc_rr[20] = 0.50
        pvc_rr[21] = 1.10
        pvc_beats = [0.50]
        for rr in pvc_rr:
            if pvc_beats[-1] + rr < 29.6:
                pvc_beats.append(pvc_beats[-1] + rr)
        pvc = self.get_cls(self._synth_waveform(pvc_beats, hz, pvc_indices={9, 21}))
        self.assertEqual(pvc["type"], "premature_beat")
        self.assertIn("室性早搏", pvc["label"])
        self.assertGreaterEqual(pvc["premature_count"], 1)

        arr_beats = [0.50]
        idx = 0
        while arr_beats[-1] < 29.2:
            rr = 0.84 + 0.14 * math.sin(2.0 * math.pi * idx / 8.0)
            arr_beats.append(arr_beats[-1] + rr)
            idx += 1
        sa = self.get_cls(self._synth_waveform(arr_beats, hz))
        self.assertEqual(sa["type"], "sinus_arrhythmia")

        flat = self.get_cls([0.005 * math.sin(i * 0.05) for i in range(10000)])
        self.assertEqual(flat["type"], "poor_signal")

        short = self.get_cls([0.1] * 500)
        self.assertEqual(short["type"], "signal_too_short")

    def get_cls(self, samples, hz=500):
        return classify_waveform(samples, hz)


if __name__ == "__main__":
    unittest.main()
