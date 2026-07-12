@echo off
setlocal
cd /d "%~dp0"

where pnpm >nul 2>nul
if %errorlevel%==0 (
    set PKG=pnpm
) else (
    set PKG=npm
)

echo Using %PKG% to rebuild grouter Switcher...
echo.

call %PKG% install
if errorlevel 1 goto :error

call %PKG% run tauri build
if errorlevel 1 goto :error

echo.
echo Build complete. Installer/exe is under src-tauri\target\release\
pause
exit /b 0

:error
echo.
echo Build failed -- see errors above.
pause
exit /b 1
