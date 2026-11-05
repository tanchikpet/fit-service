import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("merge", Path(__file__).resolve().parents[1] / "scripts/registry_merge.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MergeTests(unittest.TestCase):
    def test_preserves_human_decisions_and_newer_checks(self):
        report, candidates = m.merge(
            {"checkedAt": "2026-11-05T06:00", "checks": {"url": {"checkedAt": "2026-11-05T06:00", "status": 200}}, "notifications": {"old": "sent"}},
            {"checkedAt": "2026-11-05T05:00", "checks": {"url": {"checkedAt": "2026-11-05T05:00", "status": 404}}, "notifications": {"new": "sent"}},
            {"items": [{"url": "https://a.fitauto.ru/", "state": "dismissed"}]},
            {"items": [{"url": "https://a.fitauto.ru/", "state": "pending"}, {"url": "https://b.fitauto.ru/", "state": "pending"}]},
        )
        self.assertEqual(report["checks"]["url"]["status"], 200)
        self.assertEqual(set(report["notifications"]), {"old", "new"})
        self.assertEqual(candidates["items"][0]["state"], "dismissed")
        self.assertEqual(len(candidates["items"]), 2)
