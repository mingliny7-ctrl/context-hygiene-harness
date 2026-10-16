@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if not exist "plugins\context_hygiene\.venv\Scripts\python.exe" (
    echo Project Python environment is missing. Registration was not changed.
    pause
    exit /b 1
)
"plugins\context_hygiene\.venv\Scripts\python.exe" -m shared.desktop_host.install_native_host --interactive
if errorlevel 1 (
    echo Registration failed. Keep the error above for diagnosis.
    pause
    exit /b 1
)
echo Registration finished. Retry Open Atlas in the existing Edge extension.
echo This installer does not start Collector or Atlas.
pause
