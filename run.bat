@echo off
setlocal
title STICKY - goo blob demo
cd /d "%~dp0"

set "PORT=8000"
if not "%~1"=="" set "PORT=%~1"

echo.
echo   STICKY - third-person goo blob demo
echo   ------------------------------------
echo   serving this folder on port %PORT%
echo.

rem Node is preferred: the repo ships a tiny zero-dependency server that also
rem opens your browser once it is actually listening.
where node >nul 2>nul
if %ERRORLEVEL%==0 (
    node "tools\serve.mjs" --port %PORT% --open
    goto :done
)

rem Fall back to whatever Python is on the machine.
where py >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" http://localhost:%PORT%/
    py -3 -m http.server %PORT%
    goto :done
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" http://localhost:%PORT%/
    python -m http.server %PORT%
    goto :done
)

echo   Could not find Node.js or Python on this machine.
echo   Install either one, then run this file again:
echo     Node.js   https://nodejs.org
echo     Python    https://www.python.org/downloads/
echo.
echo   ^(A plain web server is required - browsers refuse to load
echo    ES modules straight off the file system.^)
echo.
pause
exit /b 1

:done
echo.
echo   server stopped.
pause
