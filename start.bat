@echo off
title iBots Project Management
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
set OPEN_BROWSER=1
echo Starting iBots Project Management. Keep this window open while you use it.
echo The dashboard will open in your browser. Login: dhamotharan / demo1234
node server.js
pause
exit /b

:nonode
echo Node.js is not installed. Opening the download page.
echo Install Node.js (LTS version), then double-click start.bat again.
start https://nodejs.org
pause
