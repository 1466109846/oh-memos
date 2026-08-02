@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: oh-memos MCP Configuration for Claude Code
:: Configure the Node MCP server (mcp-server-node) into Claude Code

set "BUNDLE_ROOT=%~dp0..\.."
pushd "%BUNDLE_ROOT%"
set "BUNDLE_ROOT=%CD%"
popd

:: Windows -> Unix-like path for JSON
set "BUNDLE_ROOT_UNIX=%BUNDLE_ROOT:\=/%"

:: MCP server ships as the npm package oh-memos-mcp (pure Node, no Python),
:: fetched on demand by npx. Data stays in the bundle, so MEMOS_CUBES_DIR
:: still points at BUNDLE_ROOT.
set "MCP_PACKAGE=oh-memos-mcp"
set "CUBES_DIR=%BUNDLE_ROOT_UNIX%/data/oh-memos_cubes"

:: npx is required: the config generated below cannot start without it
where npx >nul 2>&1
if errorlevel 1 (
    echo   [WARN] npx not found on PATH
    echo   The oh-memos MCP server ships as an npm package and needs Node.js ^>= 18.
    echo   Install Node.js first: https://nodejs.org/
    echo   The config is still generated, but cannot start until Node is installed.
    echo.
) else (
    echo   [OK] npx found on PATH
    echo.
)

echo.
echo ========================================
echo   oh-memos MCP Configuration
echo   Configure MCP for Claude Code
echo ========================================
echo.

:: Claude Code config path
set "CLAUDE_CONFIG=%USERPROFILE%\.claude\settings.json"
set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude"

if not exist "%CLAUDE_CONFIG_DIR%" (
    echo [INFO] Creating Claude Code config directory...
    mkdir "%CLAUDE_CONFIG_DIR%"
)

echo.
echo ================================================
echo   MCP config info (oh-memos)
echo ================================================
echo.
echo   Add the following to your Claude Code settings:
echo.
echo   Option 1: Claude Code command
echo   ----------------------------------
echo   In Claude Code, run:
echo.
echo   /mcp add oh-memos
echo.
echo   Then enter:
echo   - command: npx
echo   - args: -y %MCP_PACKAGE%
echo.
echo.
echo   Option 2: Edit the config file manually
echo   ----------------------------------
echo   Edit: %CLAUDE_CONFIG%
echo.
echo   Add the following under "mcpServers":
echo.
echo   {
echo     "mcpServers": {
echo       "oh-memos": {
echo         "type": "stdio",
echo         "command": "npx",
echo         "args": ["-y", "%MCP_PACKAGE%"],
echo         "env": {
echo           "MEMOS_URL": "http://localhost:18000",
echo           "MEMOS_USER": "dev_user",
echo           "MEMOS_DEFAULT_CUBE": "dev_cube",
echo           "MEMOS_CUBES_DIR": "%CUBES_DIR%"
echo         }
echo       }
echo     }
echo   }
echo.
echo ================================================
echo.

:: Generate config template file
set "MCP_CONFIG_FILE=%BUNDLE_ROOT%\mcp-config.json"

echo Generating config template...
(
echo {
echo   "mcpServers": {
echo     "oh-memos": {
echo       "type": "stdio",
echo       "command": "npx",
echo       "args": ["-y", "%MCP_PACKAGE%"],
echo       "env": {
echo         "MEMOS_URL": "http://localhost:18000",
echo         "MEMOS_USER": "dev_user",
echo         "MEMOS_DEFAULT_CUBE": "dev_cube",
echo         "MEMOS_CUBES_DIR": "%CUBES_DIR%"
echo       }
echo     }
echo   }
echo }
) > "%MCP_CONFIG_FILE%"

echo.
echo Config template saved to: %MCP_CONFIG_FILE%
echo.
echo ================================================
echo   Next Steps
echo ================================================
echo.
echo   1. Start services: start.bat
echo   2. Use memos_* tools in Claude Code
echo.
echo   Available Tools (10):
echo   - memos_context_resume : restore project context (session start / after compaction)
echo   - memos_search         : search memories (pass context for LLM intent)
echo   - memos_save           : save a memory (memory_type is required)
echo   - memos_list_v2        : list memories
echo   - memos_get            : fetch one memory by ID
echo   - memos_suggest        : query suggestions + memory_type decision tree
echo   - memos_think          : evidence pack + gap analysis
echo   - memos_graph          : knowledge graph (mode=related/path/impact/schema)
echo   - memos_admin          : maintenance (action=list_cubes/register_cube/stats/calendar...)
echo   - memos_export_wiki    : export an interlinked markdown wiki
echo.
echo ================================================
echo.

pause
endlocal
