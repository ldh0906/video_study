@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist web\dist\index.html call npm run build
start "" http://localhost:5178
call npm start
