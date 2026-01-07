"""
Minimal debug dump server for the WebGL viewer.

Why:
- The viewer runs in a browser, so it can't write to the local filesystem directly.
- For debugging missing textures/exports, it's useful to persist a JSON dump to disk.

This server accepts POST JSON and writes it to `tools/out/viewer_dumps/`.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


def _now_stamp() -> str:
    # 2026-01-06T12-34-56
    return time.strftime("%Y-%m-%dT%H-%M-%S", time.localtime())


class DumpHandler(BaseHTTPRequestHandler):
    server_version = "WebGLGTA-DumpServer/1.0"

    def _set_cors(self) -> None:
        # Allow browser JS from the viewer (different port) to POST.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/__viewer_dump", "/__viewer_dump/textures"):
            self.send_response(404)
            self._set_cors()
            self.end_headers()
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0

        raw = self.rfile.read(max(0, length)) if length else b""
        try:
            payload: Any = json.loads(raw.decode("utf-8") if raw else "{}")
        except Exception as e:
            self.send_response(400)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": f"Invalid JSON: {e}"}).encode("utf-8"))
            return

        out_dir: Path = self.server.out_dir  # type: ignore[attr-defined]
        out_dir.mkdir(parents=True, exist_ok=True)

        # Best-effort filename hint.
        kind = "dump"
        try:
            kind = str(payload.get("kind") or payload.get("subsystem") or payload.get("type") or "dump")
        except Exception:
            kind = "dump"
        kind = "".join([c if c.isalnum() or c in ("_", "-") else "_" for c in kind])[:64] or "dump"

        path = out_dir / f"viewer_{kind}_{_now_stamp()}.json"
        # Ensure we don't overwrite if multiple dumps happen in the same second.
        if path.exists():
            path = out_dir / f"viewer_{kind}_{_now_stamp()}_{os.getpid()}.json"

        try:
            path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")
        except Exception as e:
            self.send_response(500)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": f"Failed to write: {e}"}).encode("utf-8"))
            return

        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "path": str(path), "bytes": len(raw)}).encode("utf-8"))

    def log_message(self, fmt: str, *args: Any) -> None:
        # Quiet by default; dumps are user-triggered and we already print server startup info.
        return


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4174)
    ap.add_argument("--out-dir", default=None, help="Defaults to <webgl_viewer>/tools/out/viewer_dumps")
    args = ap.parse_args()

    here = Path(__file__).parent
    out_dir = Path(args.out_dir) if args.out_dir else (here / "tools" / "out" / "viewer_dumps")

    httpd = HTTPServer((args.host, args.port), DumpHandler)
    httpd.out_dir = out_dir  # type: ignore[attr-defined]

    print(f"[dump_server] Listening on http://{args.host}:{args.port}/__viewer_dump")
    print(f"[dump_server] Writing dumps to: {out_dir}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


