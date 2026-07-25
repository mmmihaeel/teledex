@echo off
setlocal
cd /d "%~dp0\..\.."
node src\cli\user-live-agent-audit.js
exit /b %errorlevel%
