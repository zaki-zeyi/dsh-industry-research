@echo off
setlocal
chcp 65001 >nul
title DSH Industry Research Uninstaller
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall.ps1"
exit /b %errorlevel%
