"""Merge scanner output into the latest main without losing human review decisions."""
import json
from pathlib import Path
import sys


def merge(latest_report, scanned_report, latest_candidates, scanned_candidates):
    report = dict(latest_report)
    for url, check in scanned_report.get("checks", {}).items():
        current = report.setdefault("checks", {}).get(url, {})
        if check.get("checkedAt", "") >= current.get("checkedAt", ""):
            report["checks"][url] = check
    report["notifications"] = {**latest_report.get("notifications", {}), **scanned_report.get("notifications", {})}
    if scanned_report.get("checkedAt", "") >= latest_report.get("checkedAt", ""):
        for key in ["checkedAt", "emailStatus", "discoveryErrors"]:
            if key in scanned_report:
                report[key] = scanned_report[key]
    items = {e["url"]: dict(e) for e in latest_candidates.get("items", [])}
    for e in scanned_candidates.get("items", []):
        if e["url"] not in items:
            items[e["url"]] = e
        elif items[e["url"]].get("state") == "pending" and e.get("state") == "approved":
            items[e["url"]]["state"] = "approved"
    candidates = {"updatedAt": max(latest_candidates.get("updatedAt") or "", scanned_candidates.get("updatedAt") or ""), "items": list(items.values())}
    return report, candidates


def main():
    root = Path(__file__).resolve().parents[1]
    report_path, candidates_path = root / "data/registry-checks.json", root / "data/registry-candidates.json"
    report, candidates = merge(json.loads(report_path.read_text()), json.loads(Path(sys.argv[1]).read_text()), json.loads(candidates_path.read_text()), json.loads(Path(sys.argv[2]).read_text()))
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    candidates_path.write_text(json.dumps(candidates, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
