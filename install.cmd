@echo off
rem Double-click to install RedGiant on Windows (runs install.ps1 next to this file).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
