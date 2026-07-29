@echo off

cd /d "%~dp0"

set PYTHON_EXE=%~dp0.venv\Scripts\python.exe
set PATH=%~dp0.venv\Scripts;%PATH%

echo ========================================
echo    oh_memos Windows Launcher
echo ========================================
echo.

echo [1/4] Checking Python...
if not exist "%PYTHON_EXE%" (
    echo [ERROR] Python not found: %PYTHON_EXE%
    echo         Make sure .venv folder exists
    pause
    exit /b 1
)
"%PYTHON_EXE%" --version
echo       Python OK

echo.
echo [2/4] Checking config...
if not exist .env (
    if exist .env.windows.example (
        copy .env.windows.example .env >nul
        echo [INFO] Created .env from .env.windows.example
    ) else (
        echo [ERROR] Config file not found
        pause
        exit /b 1
    )
)
echo       Config OK

echo.
echo [3/4] Syncing config to src...
copy /y .env src\.env >nul
echo       Config synced

echo.
echo [4/4] Starting service...
echo.
echo ========================================
echo    Server: http://localhost:18000
echo    API Docs: http://localhost:18000/docs
echo    Press Ctrl+C to stop
echo ========================================
echo.

cd /d "%~dp0src"
"%PYTHON_EXE%" -m uvicorn oh_memos.api.start_api:app --host 0.0.0.0 --port 18000

pause
