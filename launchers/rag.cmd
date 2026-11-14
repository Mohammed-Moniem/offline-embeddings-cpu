@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0src\cli.mjs" %*
exit /b %errorlevel%
