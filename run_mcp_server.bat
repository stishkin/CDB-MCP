@echo off
REM Change directory to the script's own directory (project root)
cd /D "%~dp0"
REM Execute the Node.js server
"C:\Program Files\nodejs\node.exe" build/index.js
