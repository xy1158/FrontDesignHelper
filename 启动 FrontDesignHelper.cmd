@echo off
rem FrontDesignHelper launcher
rem Prefer the packaged build in app\; fall back to running from source.
cd /d "%~dp0"

if exist "app\FrontDesignHelper.exe" (
  start "" "app\FrontDesignHelper.exe"
  exit /b 0
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Neither app\FrontDesignHelper.exe nor node_modules\electron\dist\electron.exe found.
  echo Run: npm install
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0"