@echo off
setlocal
pushd "%~dp0\..\.."
node src\cli\run-live-tests.js --app-server-v2 %*
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
