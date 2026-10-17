@echo off
rem Daily job collection: LinkedIn (Apify) + Naukri, Indeed and Glassdoor (naukri-scraper, opens Chrome windows).
rem Run by Windows Task Scheduler on a PC that stays on and logged in. See README "Daily schedule".
rem Each day's output goes to data\logs\collect-YYYY-MM-DD.log.
cd /d "%~dp0"
if not exist data\logs mkdir data\logs
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%d
echo ===== %DATE% %TIME% ===== >> "data\logs\collect-%TODAY%.log"
call npm run collect >> "data\logs\collect-%TODAY%.log" 2>&1
exit /b %ERRORLEVEL%
