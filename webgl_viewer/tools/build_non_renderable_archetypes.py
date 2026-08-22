"""Build the browser's known-non-renderable archetype index from export reports.

Only CodeWalker-confirmed ``no_drawable`` outcomes are included. A missing archetype or an
export error remains a real export gap rather than being hidden from the client.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models-dir", default="", help="Viewer assets/models directory")
    args = ap.parse_args()

    here = Path(__file__).resolve()
    models_dir = Path(args.models_dir) if args.models_dir else (here.parents[1] / "assets" / "models")
    hashes: set[str] = set()
    reports = sorted(models_dir.glob("export_report_list_*.json"))
    for report_path in reports:
        try:
            report = json.loads(report_path.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        for item in report.get("failuresSample") or []:
            if not isinstance(item, dict) or item.get("reason") != "no_drawable":
                continue
            try:
                hashes.add(str(int(str(item.get("hash", "")).strip()) & 0xFFFFFFFF))
            except Exception:
                continue

    payload = {
        "schema": "webglgta-non-renderable-archetypes-v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceReports": len(reports),
        "hashes": sorted(hashes, key=lambda s: int(s)),
    }
    out_path = models_dir / "non_renderable_archetypes.json"
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} hashes={len(hashes)} reports={len(reports)}")


if __name__ == "__main__":
    main()
