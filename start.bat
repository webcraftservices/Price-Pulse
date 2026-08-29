@echo off
title PricePulse Server
echo.
echo  Starting PricePulse server...
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
