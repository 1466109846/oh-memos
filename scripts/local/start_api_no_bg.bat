@echo off
setlocal EnableDelayedExpansion

title MemOS - Windows API (host databases, container owns background jobs)

rem The switch is interpreted by start_api.py *after* it loads src/.env, because
rem that file intentionally overrides ordinary environment variables.
set "MEMOS_DISABLE_BACKGROUND_WRITERS=true"

set "SCRIPT_DIR=%~dp0"
set "OH_MEMOS_ROOT=%SCRIPT_DIR%..\.."
cd /d "%OH_MEMOS_ROOT%" || (
    echo [ERROR] Cannot enter project root: %OH_MEMOS_ROOT%
    pause
    exit /b 1
)

if exist "%OH_MEMOS_ROOT%\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%OH_MEMOS_ROOT%\.venv\Scripts\python.exe"
) else if exist "%OH_MEMOS_ROOT%\conda_venv\python.exe" (
    set "PYTHON_EXE=%OH_MEMOS_ROOT%\conda_venv\python.exe"
) else (
    echo [ERROR] No Python environment found.
    echo         Please run VENV_scripts\setup_venv.bat first.
    pause
    exit /b 1
)

rem start_api.py runs with src as its working directory and loads src\.env, so
rem check that file rather than the project-root copy.
if not exist "%OH_MEMOS_ROOT%\src\.env" (
    echo [ERROR] src\.env not found: %OH_MEMOS_ROOT%\src\.env
    pause
    exit /b 1
)

rem This script does not launch Neo4j/Qdrant; in host-db mode they are expected
rem to be running already (start.bat, or scripts\local\start_db_silent.bat).
rem Warn instead of failing, so an intentionally partial setup still starts.
call :warn_if_down 7687 Neo4j
call :warn_if_down 16333 Qdrant

rem src\.env keeps supplying LLM, cube and host database settings. The switch
rem above makes start_api.py override both background writer flags after that
rem file loads, and makes POST /archive/run return 409 on this instance.
echo.
echo ============================================================
echo  MemOS Windows API - background writers disabled
echo  API:    http://localhost:18000  (read-only side)
echo  Writes, archive and reorganize belong to the host-db container.
echo ============================================================
echo.

cd /d "%OH_MEMOS_ROOT%\src"
"%PYTHON_EXE%" -m uvicorn oh_memos.api.start_api:app --host 0.0.0.0 --port 18000

pause
exit /b 0

:warn_if_down
netstat -ano 2>nul | findstr ":%~1 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 echo      [WARN] %~2 not listening on port %~1 - start the databases first
goto :eof
