import os
import argparse
import logging
import subprocess
import sys
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def check_openiv_path(path):
    """Check if the provided OpenIV path is valid"""
    openiv_exe = Path(path) / "OpenIV.exe"
    if not openiv_exe.exists():
        logger.error(f"OpenIV.exe not found at {openiv_exe}")
        return False
    return True

def extract_rpf(openiv_path, rpf_path, output_dir):
    """Extract RPF file using OpenIV command line"""
    if not check_openiv_path(openiv_path):
        return False
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Check if RPF file exists
    rpf_file = Path(rpf_path)
    if not rpf_file.exists():
        logger.error(f"RPF file not found: {rpf_file}")
        return False
    
    # Construct OpenIV command
    openiv_exe = Path(openiv_path) / "OpenIV.exe"
    cmd = f'"{openiv_exe}" -extract "{rpf_file}" "{output_dir}"'
    
    logger.info(f"Executing: {cmd}")
    
    try:
        # Run OpenIV command
        subprocess.run(cmd, shell=True, check=True)
        logger.info(f"Successfully extracted {rpf_file} to {output_dir}")
        return True
    except subprocess.CalledProcessError as e:
        logger.error(f"Failed to extract RPF file: {e}")
        return False

def extract_common_rpfs(openiv_path, gta_path, output_dir):
    """Extract common RPF files needed for terrain extraction"""
    rpf_files = [
        "common.rpf",
        "update/update.rpf"
    ]
    
    success = True
    for rpf in rpf_files:
        rpf_path = Path(gta_path) / rpf
        rpf_output = Path(output_dir) / rpf.replace(".rpf", "")
        
        if not extract_rpf(openiv_path, rpf_path, rpf_output):
            success = False
    
    return success

def main():
    """Main function to run the RPF extractor"""
    parser = argparse.ArgumentParser(description='Extract RPF files from GTA 5')
    parser.add_argument('--openiv-path', required=True, help='Path to OpenIV directory')
    parser.add_argument('--gta-path', required=True, help='Path to GTA 5 directory')
    parser.add_argument('--output-dir', default='extracted', help='Directory to save extracted files')
    parser.add_argument('--rpf-file', help='Specific RPF file to extract (relative to GTA path)')
    
    args = parser.parse_args()
    
    if args.rpf_file:
        # Extract specific RPF file
        rpf_path = Path(args.gta_path) / args.rpf_file
        extract_rpf(args.openiv_path, rpf_path, args.output_dir)
    else:
        # Extract common RPF files
        extract_common_rpfs(args.openiv_path, args.gta_path, args.output_dir)

if __name__ == "__main__":
    main() 