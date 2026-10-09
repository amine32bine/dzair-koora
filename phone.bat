@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dzair Koora - phone link

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo cloudflared not found. Installing it now...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. CLOSE this window and run phone.bat again.
  pause
  exit /b
)

start "Dzair Koora Server" cmd /k start.bat
timeout /t 5 >nul
echo.
echo ==========================================================
echo  Look below for a link like  https://xxxx.trycloudflare.com
echo  Open it on your phone: this is your app. Keep this window open.
echo ==========================================================
echo.
cloudflared tunnel --url http://localhost:8080
pause
