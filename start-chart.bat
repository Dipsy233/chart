@echo off
rem ==========================================================================
rem  CHART / Regimen - start the rule editor (Windows)
rem
rem  The .cmd counterpart of start-chart.sh. One command that gets this
rem  checkout running:
rem
rem    1. installs dependencies when node_modules is missing (root + web\)
rem    2. starts the Vite dev server for the editor in web\
rem    3. prints the URL
rem
rem  The editor imports ..\src directly, so there is no build step between the
rem  engine and the UI - edit a rule engine file and the page reloads.
rem
rem  Usage:
rem    start-chart.bat              start the editor (http://localhost:5174)
rem    start-chart.bat open         start it and open a browser
rem    start-chart.bat check        run the 588 checks, then exit
rem    start-chart.bat demo         print the demo report, then exit
rem    start-chart.bat rules list   the rule-pack CLI (passes the rest through)
rem    start-chart.bat api          the rules API for agents (http://127.0.0.1:5175)
rem    start-chart.bat serve        build the editor, serve it + the API on one port
rem    start-chart.bat build        production build of the editor
rem
rem  Env:
rem    CHART_PORT=5174     port for the dev server
rem    CHART_API_PORT=5175 port for the rules API
rem    CHART_RULES_DIR     where the CLI's packs live (default .chart\rules)
rem ==========================================================================
setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0"

if "%CHART_PORT%"=="" (set "PORT=5174") else (set "PORT=%CHART_PORT%")
if "%CHART_API_PORT%"=="" (set "API_PORT=5175") else (set "API_PORT=%CHART_API_PORT%")

echo ============================================================
echo   CHART / Regimen - observation engine + rule editor
echo ------------------------------------------------------------
echo   repo  : %CD%
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEV=%%v"
if "%NODEV%"=="" (
  echo   node  : MISSING
) else (
  echo   node  : %NODEV%
)
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo node is not on PATH - install Node 20 or newer.
  exit /b 1
)

rem -- dependencies -------------------------------------------------------
rem Only install when something is missing: a fresh install is 20s, and the
rem editor is usually opened many times in a row.
if not exist "node_modules" (
  echo -^> installing library dev dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
if not exist "web\node_modules" (
  echo -^> installing editor dependencies...
  pushd web
  call npm install --no-audit --no-fund
  popd
  if errorlevel 1 exit /b 1
)

set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"

if /i "%CMD%"=="check" (
  echo -^> running the checks
  call npm run --silent check
  exit /b %errorlevel%
)

if /i "%CMD%"=="demo" (
  echo -^> the demo run
  call npm run --silent demo
  exit /b %errorlevel%
)

if /i "%CMD%"=="build" (
  echo -^> production build of the editor
  pushd web
  call npx tsc --noEmit
  if errorlevel 1 (popd & exit /b 1)
  call npx vite build
  popd
  echo   output: web\dist
  exit /b %errorlevel%
)

rem `%*` always holds the *original* argument list, even after `shift`, so the
rem verb has to be split off by hand before the CLI sees it.
if /i "%CMD%"=="rules" (
  set "REST="
  for /f "tokens=1,*" %%A in ("%*") do set "REST=%%B"
  rem Delayed expansion: `%REST%` inside this block would be expanded before the
  rem `for` above ever runs.
  if defined REST (
    call npm run --silent rules -- !REST!
  ) else (
    call npm run --silent rules --
  )
  exit /b %errorlevel%
)

if /i "%CMD%"=="api" (
  set "REST="
  for /f "tokens=1,*" %%A in ("%*") do set "REST=%%B"
  if defined REST (
    call npm run --silent api -- --port %API_PORT% !REST!
  ) else (
    call npm run --silent api -- --port %API_PORT%
  )
  exit /b %errorlevel%
)

if /i "%CMD%"=="serve" (
  echo -^> building the editor, then serving it with the API on http://localhost:%API_PORT%
  call npm run --silent web:build
  if errorlevel 1 exit /b 1
  call npm run --silent api -- --port %API_PORT% --static web/dist
  exit /b %errorlevel%
)

if /i "%CMD%"=="open" (
  echo -^> starting the editor on http://localhost:%PORT% ^(opening a browser^)
  echo   ctrl-c to stop
  pushd web
  call npx vite --port %PORT% --open
  popd
  exit /b %errorlevel%
)

if /i "%CMD%"=="start" (
  echo -^> starting the editor on http://localhost:%PORT%
  echo   ctrl-c to stop
  pushd web
  call npx vite --port %PORT%
  popd
  exit /b %errorlevel%
)

echo usage: %~nx0 [start^|open^|check^|demo^|rules^|api^|serve^|build]
exit /b 2
