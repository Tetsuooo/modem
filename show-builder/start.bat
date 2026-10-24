@echo off
title modem show builder
cd /d "%~dp0.."
rem A show builder that's still running keeps port 8090: the new one couldn't start and the
rem browser would open the OLD version (after a git pull, that looks like the update did
rem nothing). So close the old server first - its window, then anything else on the port.
taskkill /fi "WINDOWTITLE eq modem show builder - server*" /t /f >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":8090 .*LISTENING"') do taskkill /pid %%p /t /f >nul 2>&1
timeout /t 1 /nobreak >nul
if /i "%~1"=="--restart" (
  rem restarted from the Health tab: minimised, and no new browser tab (the page reloads itself)
  start "modem show builder - server" /min cmd /k node show-builder\server.js
  exit /b
)
start "modem show builder - server" cmd /k node show-builder\server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:8090
