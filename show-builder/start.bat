@echo off
title modem show builder
cd /d "%~dp0.."
start "modem show builder - server" cmd /k node show-builder\server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:8090
