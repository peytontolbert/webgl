import subprocess
import sys
import os
from pathlib import Path

def run_viewer():
    """Run the WebGL viewer using Vite"""
    # Get the viewer directory
    viewer_dir = Path(__file__).parent
    
    # Check if node_modules exists
    if not (viewer_dir / 'node_modules').exists():
        print("Installing dependencies...")
        subprocess.run(['npm', 'install'], cwd=viewer_dir, check=True)
    
    # Run the development server
    print("\nStarting WebGL viewer...")
    print("Press Ctrl+C to stop the server")
    print("\nOpen your browser and navigate to: http://localhost:5173")
    
    try:
        subprocess.run(['npm', 'run', 'dev'], cwd=viewer_dir)
    except KeyboardInterrupt:
        print("\nStopping server...")
        sys.exit(0)

if __name__ == '__main__':
    run_viewer() 