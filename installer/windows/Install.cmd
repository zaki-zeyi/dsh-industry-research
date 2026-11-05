@echo off
setlocal
chcp 65001 >nul
title DSH Industry Research Installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
exit /b %errorlevel%
