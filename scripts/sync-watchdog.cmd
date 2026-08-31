@echo off
rem Hourly watchdog for the Kapture sync (GitHub's cron scheduler has been
rem firing intermittently since 27 Aug 2026). Dispatches the workflow only if
rem the newest run is older than 45 minutes, and only inside the 8:00-19:30
rem IST sync window. Registered in Windows Task Scheduler as HPTrackerSyncWatchdog.
set GH="C:\Program Files\GitHub CLI\gh.exe"
for /f %%H in ('powershell -NoProfile -Command "(Get-Date).Hour"') do set HOUR=%%H
if %HOUR% LSS 8 exit /b 0
if %HOUR% GTR 19 exit /b 0
for /f %%A in ('powershell -NoProfile -Command "$r = & 'C:\Program Files\GitHub CLI\gh.exe' run list -R shariqkhan-ui/hp-customer-tracker --workflow=kapture-sync.yml --limit 1 --json createdAt -q '.[0].createdAt' 2>$null; if ($r) { [int]((Get-Date) - [datetime]::Parse($r)).TotalMinutes } else { 999 }"') do set AGE=%%A
if %AGE% LSS 45 exit /b 0
%GH% workflow run kapture-sync.yml -R shariqkhan-ui/hp-customer-tracker
echo %date% %time% dispatched (last run %AGE% min old) >> "%~dp0sync-watchdog.log"
