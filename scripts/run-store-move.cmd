@echo off
setlocal
cd /d "%~dp0"

set "LOG=%~dp0store-move.log"
echo [store-move] log: %LOG%
echo [store-move] Close DSH completely before continuing.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-store-to-d.ps1" > "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" goto done

echo [store-move] store migration OK; installing dsh-git-panel...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-profile.ps1" -Mode manual >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"

:done
echo.
echo [store-move] exit code: %CODE%
echo [store-move] ----- log -----
type "%LOG%"
echo [store-move] --------------
echo.
echo If exit code is 0, start DSH again and check the right sidebar.
echo If it is not 0, the migration attempted rollback; read the log above.
pause
exit /b %CODE%
