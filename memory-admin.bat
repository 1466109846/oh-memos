@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   oh-memos Memory Admin GUI
echo   URL: http://127.0.0.1:18010
echo   Press Ctrl+C to stop the server.
echo ============================================
if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] .venv\Scripts\python.exe not found.
  echo Please create the virtualenv first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" "tools\memory-admin\run.py"
echo.
echo Server stopped.
pause
