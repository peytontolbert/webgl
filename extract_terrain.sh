#!/bin/bash
# GTA 5 Terrain Extractor Shell Script
# This shell script runs the terrain extractor with CodeWalker integration

echo "GTA 5 Terrain Extractor"
echo "----------------------"

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "Python is not installed or not in PATH."
    echo "Please install Python 3.7 or higher."
    exit 1
fi

# Check Python version
PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
if [[ $(echo "$PYTHON_VERSION < 3.7" | bc) -eq 1 ]]; then
    echo "Python 3.7 or higher is required."
    echo "Current version: $PYTHON_VERSION"
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "Creating .env file..."
    echo "Please enter the path to your GTA 5 installation:"
    read GTA_PATH
    echo "gta_location=\"$GTA_PATH\"" > .env
    
    echo "Please enter the path to your CodeWalker source code:"
    read CODEWALKER_PATH
    echo "codewalker_map=\"$CODEWALKER_PATH\"" >> .env
fi

# Check if requirements are installed
echo "Checking requirements..."
if ! python3 -c "import numpy, matplotlib, dotenv" &> /dev/null; then
    echo "Installing required packages..."
    pip3 install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo "Failed to install required packages."
        exit 1
    fi
fi

# Create output directory if it doesn't exist
mkdir -p output

# Run the terrain extractor
echo "Running terrain extractor..."
python3 extract_gta_terrain.py

if [ $? -ne 0 ]; then
    echo "Terrain extraction failed."
    exit 1
fi

echo "Terrain extraction completed successfully."
echo "Output files are in the output directory."

# Open the output directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    open output
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    if command -v xdg-open &> /dev/null; then
        xdg-open output
    elif command -v nautilus &> /dev/null; then
        nautilus output
    elif command -v dolphin &> /dev/null; then
        dolphin output
    fi
fi

exit 0 