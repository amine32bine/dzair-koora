@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist server.js (
  echo.
  echo ERROR: server.js was not found next to start.bat.
  echo Extract the ZIP completely, then run start.bat from INSIDE the dzair-koora folder.
  pause
  exit /b
)
title Dzair Koora

rem ===================== WRITE YOUR KEYS HERE =====================
rem Type the key right after the = sign. No spaces, no quotes.
rem FOOTBALL_DATA_KEY = free token from https://www.football-data.org/client/register
rem API_FOOTBALL_KEY  = paid key from api-football.com (Algerian + Arab leagues) - leave empty if you have none
set FOOTBALL_DATA_KEY=
set API_FOOTBALL_KEY=
set POLL_MS=60000
rem ================================================================

where node >nul 2>&1 || (echo Install Node.js from https://nodejs.org then run this file again & pause & exit /b)
for /f "tokens=1 delims=." %%a in ('node -v') do set NV=%%a
set NV=%NV:v=%
if %NV% LSS 14 (echo Your Node.js is too old. Install Node.js 20 LTS from https://nodejs.org & pause & exit /b)

if "%FOOTBALL_DATA_KEY%%API_FOOTBALL_KEY%"=="" if not exist .env echo [!] No keys set: prayer times work, matches need a key. Open start.bat with Notepad and add one.
node server.js
pause
