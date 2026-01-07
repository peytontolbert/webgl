import subprocess
import sys
import os
from pathlib import Path
import shutil
import socket
from contextlib import closing

def run_viewer():
    """Run the WebGL viewer.

    For hosting/production-like testing, prefer:
      - npm install (if needed)
      - npm run build
      - npm run preview -- --host <host> --port <port>

    Falls back to a simple static server if npm isn't available.
    """
    viewer_dir = Path(__file__).parent

    def pick_free_port(host: str, start_port: int) -> int:
        for p in range(start_port, start_port + 100):
            with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    s.bind((host, p))
                    return p
                except OSError:
                    continue
        raise RuntimeError(f"Could not find a free port in range [{start_port}, {start_port + 99}] on {host}")

    host = os.getenv("WEBGL_VIEWER_HOST", "127.0.0.1")
    # Vite preview defaults to 4173; keep 5173 as a common dev port but allow override.
    preferred_port = int(os.getenv("WEBGL_VIEWER_PORT", "4173"))

    npm = shutil.which("npm") or shutil.which("npm.cmd") or shutil.which("npm.exe")
    dump_proc = None

    def start_dump_server(preview_port: int) -> None:
        """
        Start a small debug dump server so the browser can persist JSON dumps to disk.
        Controlled by env vars:
          - WEBGL_VIEWER_ENABLE_DUMP_SERVER=1 (default 1)
          - WEBGL_VIEWER_DUMP_PORT (default preview_port+1)
        """
        nonlocal dump_proc
        enabled = os.getenv("WEBGL_VIEWER_ENABLE_DUMP_SERVER", "1").strip().lower() not in ("0", "false", "no")
        if not enabled:
            return
        try:
            preferred_dump_port = int(os.getenv("WEBGL_VIEWER_DUMP_PORT", str(preview_port + 1)))
        except Exception:
            preferred_dump_port = preview_port + 1
        dump_port = pick_free_port(host, preferred_dump_port)
        dump_script = viewer_dir / "dump_server.py"
        if not dump_script.exists():
            return
        try:
            dump_proc = subprocess.Popen(
                [sys.executable, str(dump_script), "--host", host, "--port", str(dump_port)],
                cwd=viewer_dir,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            print(f"\nStarted dump server: http://{host}:{dump_port}/__viewer_dump")
            print(f"Dumps will be written under: {viewer_dir / 'tools' / 'out' / 'viewer_dumps'}")
            print("In the browser, call: __viewerDumpTextures()")
            # Best-effort: print first couple lines from the dump server (non-blocking-ish).
            try:
                if dump_proc.stdout:
                    for _ in range(2):
                        line = dump_proc.stdout.readline().strip()
                        if line:
                            print(line)
            except Exception:
                pass
        except Exception as e:
            print(f"Failed to start dump server: {e}")
            dump_proc = None

    # If npm exists, prefer Vite build + preview.
    if npm:
        # Ensure deps.
        if not (viewer_dir / "node_modules").exists():
            print("Installing dependencies...")
            subprocess.run([npm, "install"], cwd=viewer_dir, check=True)

        port = pick_free_port(host, preferred_port)
        start_dump_server(port)

        print("\nBuilding WebGL viewer (Vite)...")
        subprocess.run([npm, "run", "build"], cwd=viewer_dir, check=True)

        print("\nStarting WebGL viewer (Vite preview)...")
        print("Press Ctrl+C to stop the server")
        print(f"\nOpen your browser and navigate to: http://{host}:{port}/")

        try:
            # Use CLI args so the printed URL stays correct.
            subprocess.run(
                [npm, "run", "preview", "--", "--host", host, "--port", str(port), "--strictPort"],
                cwd=viewer_dir,
            )
        except KeyboardInterrupt:
            print("\nStopping server...")
        finally:
            try:
                if dump_proc and dump_proc.poll() is None:
                    dump_proc.terminate()
            except Exception:
                pass
        sys.exit(0)
        return

    # Fallback: Node/npm not available.
    port = pick_free_port(host, preferred_port)
    start_dump_server(port)
    print("\nStarting WebGL viewer (static server; npm not found)...")
    print("Press Ctrl+C to stop the server")
    print(f"\nOpen your browser and navigate to: http://{host}:{port}/")

    try:
        subprocess.run([sys.executable, "-m", "http.server", str(port), "--bind", host], cwd=viewer_dir)
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        try:
            if dump_proc and dump_proc.poll() is None:
                dump_proc.terminate()
        except Exception:
            pass
    sys.exit(0)

if __name__ == '__main__':
    run_viewer() 