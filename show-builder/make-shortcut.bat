@echo off
rem Double-click: puts a "modem show builder" shortcut with the modem icon on the desktop
rem (or gives the one already there the icon). See make-shortcut.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1"
pause
