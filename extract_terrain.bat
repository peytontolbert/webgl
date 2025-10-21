@echo off
setlocal enabledelayedexpansion

echo GTA 5 Terrain Extractor
echo ----------------------

:: Check if Python is installed
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Python is not installed or not in PATH.
    echo Please install Python 3.7 or higher.
    pause
    exit /b 1
)

:: Check Python version
for /f "tokens=2" %%V in ('python -c "import sys; print(sys.version_info[0])"') do set PYTHON_MAJOR=%%V
if %PYTHON_MAJOR% lss 3 (
    echo Python 3.7 or higher is required.
    echo Current version: 
    python --version
    pause
    exit /b 1
)

:: Check if .env file exists
if not exist .env (
    echo Creating .env file...
    echo Please enter the path to your GTA 5 installation:
    set /p GTA_PATH=
    echo gta_location="%GTA_PATH%"> .env
    
    echo Please enter the path to your CodeWalker source code:
    set /p CODEWALKER_PATH=
    echo codewalker_map="%CODEWALKER_PATH%">> .env
)

:: Check if requirements are installed
echo Checking requirements...
python -c "import numpy, matplotlib, dotenv" >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Installing required packages...
    pip install -r requirements.txt
    if %ERRORLEVEL% neq 0 (
        echo Failed to install required packages.
        pause
        exit /b 1
    )
)

:: Create output directory if it doesn't exist
if not exist output mkdir output

:: Run the terrain extractor
echo Running terrain extractor...
python extract_gta_terrain.py

if %ERRORLEVEL% neq 0 (
    echo Terrain extraction failed.
    pause
    exit /b 1
)

echo Terrain extraction completed successfully.
echo Output files are in the output directory.

:: Open the output directory
start "" "output"

pause 