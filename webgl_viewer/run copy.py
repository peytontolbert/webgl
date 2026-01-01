import subprocess
import sys
import os
from pathlib import Path
import shutil

def run_viewer():
    """Run the WebGL viewer.

    Preferred: Vite dev server (npm).
    Fallback: plain static server (no npm required).
    """
    # Get the viewer directory
    viewer_dir = Path(__file__).parent
    
    npm = shutil.which("npm")

    # If npm exists, prefer Vite.
    if npm:
        # Check if node_modules exists
        if not (viewer_dir / 'node_modules').exists():
            print("Installing dependencies...")
            subprocess.run([npm, 'install'], cwd=viewer_dir, check=True)

        print("\nStarting WebGL viewer (Vite)...")
        print("Press Ctrl+C to stop the server")
        print("\nOpen your browser and navigate to: http://localhost:5173")
        try:
            subprocess.run([npm, 'run', 'dev'], cwd=viewer_dir)
        except KeyboardInterrupt:
            print("\nStopping server...")
            sys.exit(0)
        return

    # Fallback: Node/npm not available.
    # Serve static files directly; index.html loads gl-matrix from node_modules and modules from ./js.
    port = int(os.getenv("WEBGL_VIEWER_PORT", "5173"))
    print("\nStarting WebGL viewer (static server; npm not found)...")
    print("Press Ctrl+C to stop the server")
    print(f"\nOpen your browser and navigate to: http://localhost:{port}")

    try:
        subprocess.run([sys.executable, "-m", "http.server", str(port)], cwd=viewer_dir)
    except KeyboardInterrupt:
        print("\nStopping server...")
        sys.exit(0)

if __name__ == '__main__':
    run_viewer() 