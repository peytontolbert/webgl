import subprocess
import sys
import os
from pathlib import Path
import shutil
import socket
from contextlib import closing

def run_viewer():
    """Run the WebGL viewer.

    Prefers Vite (npm). Falls back to a simple static server if npm isn't available.
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
    preferred_port = int(os.getenv("WEBGL_VIEWER_PORT", "5173"))

    npm = shutil.which("npm") or shutil.which("npm.cmd") or shutil.which("npm.exe")

    # If npm exists, prefer Vite.
    if npm:
        # Ensure deps.
        if not (viewer_dir / "node_modules").exists():
            print("Installing dependencies...")
            subprocess.run([npm, "install"], cwd=viewer_dir, check=True)

        port = pick_free_port(host, preferred_port)

        print("\nStarting WebGL viewer (Vite)...")
        print("Press Ctrl+C to stop the server")
        print(f"\nOpen your browser and navigate to: http://{host}:{port}/")

        try:
            # --strictPort prevents Vite from silently hopping ports (which makes the printed URL wrong).
            #
            # Note: `package.json` already pins `--host 127.0.0.1` for IPv4 reliability, so we only pass port args here
            # to avoid duplicating `--host` on the command line.
            subprocess.run([npm, "run", "dev", "--", "--port", str(port), "--strictPort"], cwd=viewer_dir)
        except KeyboardInterrupt:
            print("\nStopping server...")
            sys.exit(0)
        return

    # Fallback: Node/npm not available.
    port = pick_free_port(host, preferred_port)
    print("\nStarting WebGL viewer (static server; npm not found)...")
    print("Press Ctrl+C to stop the server")
    print(f"\nOpen your browser and navigate to: http://{host}:{port}/")

    try:
        subprocess.run([sys.executable, "-m", "http.server", str(port), "--bind", host], cwd=viewer_dir)
    except KeyboardInterrupt:
        print("\nStopping server...")
        sys.exit(0)

if __name__ == '__main__':
    run_viewer() 