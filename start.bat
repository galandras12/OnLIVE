@echo off
rem ============================================================================
rem  OnLIVE — indító script (11. szegmens)
rem
rem  Dupla kattintásra elindítja a TELJES rendszert:
rem    1. Cloudflare Tunnel service (ha nem fut)
rem    2. MediaMTX ingest (az npm start intézi)
rem    3. Vezérlő szerver
rem
rem  Az ablak NYITVA marad, hogy a napló élőben látszódjon.
rem ============================================================================

setlocal enabledelayedexpansion
title OnLIVE

rem A projekt gyökeréből dolgozunk, akárhonnan indították.
cd /d "%~dp0"

set "STARTUP_LOG=%~dp0logs\startup.log"
if not exist "%~dp0logs" mkdir "%~dp0logs"

call :log "INDITAS  ---------------------------------------------"

echo.
echo   ==========================================
echo     OnLIVE - eloa keszules
echo   ==========================================
echo.

rem ---------------------------------------------------------------------------
rem  1) Cloudflare Tunnel
rem
rem  A Node oldali indito is ellenorzi, de itt hamarabb kiderul, ha
rem  rendszergazdai jog kell hozza - meg a szerver elindulasa elott.
rem ---------------------------------------------------------------------------

set "TUNNEL_SERVICE=cloudflared"

sc query "%TUNNEL_SERVICE%" >nul 2>&1
if errorlevel 1 (
    echo   [!] A(z) "%TUNNEL_SERVICE%" service nincs telepitve.
    echo       A rendszer csak helyi halozaton lesz elerheto.
    echo       Telepites: docs\NETWORKING.md 4.7 fejezet
    call :log "TUNNEL   nincs telepitve"
) else (
    sc query "%TUNNEL_SERVICE%" | find "RUNNING" >nul
    if errorlevel 1 (
        echo   [*] A tunnel service all - inditas...
        net start "%TUNNEL_SERVICE%" >nul 2>&1
        if errorlevel 1 (
            echo   [!] Nem sikerult elinditani. Inditsd a .bat-ot rendszergazdakent,
            echo       vagy kezzel:  net start %TUNNEL_SERVICE%
            call :log "TUNNEL   inditas sikertelen"
        ) else (
            echo   [OK] Cloudflare Tunnel elindult.
            call :log "TUNNEL   elinditva"
        )
    ) else (
        echo   [OK] Cloudflare Tunnel mar fut.
        call :log "TUNNEL   mar futott"
    )
)

rem ---------------------------------------------------------------------------
rem  2) Node ellenorzes
rem ---------------------------------------------------------------------------

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [HIBA] Nincs telepitve a Node.js, vagy nincs a PATH-ban.
    echo          Telepites: https://nodejs.org  ^(20-as vagy ujabb^)
    call :log "HIBA     nincs node"
    goto :end
)

if not exist "%~dp0server\node_modules" (
    echo   [*] Elso inditas - fuggosegek telepitese ^(npm install^)...
    pushd "%~dp0server"
    call npm install --no-audit --no-fund
    popd
    call :log "NPM      install lefutott"
)

rem ---------------------------------------------------------------------------
rem  3) Vezerlo szerver
rem ---------------------------------------------------------------------------

echo.
echo   [*] Vezerlo szerver inditasa... ^(a leallitas: Ctrl+C^)
echo.
call :log "SZERVER  inditas"

pushd "%~dp0server"
call npm start
set "EXIT_CODE=%errorlevel%"
popd

call :log "SZERVER  leallt (kilepesi kod: %EXIT_CODE%)"

echo.
echo   ==========================================
echo     A szerver leallt. ^(kilepesi kod: %EXIT_CODE%^)
echo   ==========================================
echo.

:end
call :log "LEALLAS  ---------------------------------------------"
echo   Nyomj egy billentyut a bezarashoz...
pause >nul
endlocal
exit /b

rem ---------------------------------------------------------------------------
rem  Idobelyeges sor a startup.log-ba - visszakereshetoen, mikor futott.
rem ---------------------------------------------------------------------------
:log
echo %date% %time% ^| %~1>>"%STARTUP_LOG%"
exit /b 0
