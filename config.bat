@echo off
rem ============================================================================
rem  OnLIVE - beallito varazslo (1.0.017)
rem
rem  Dupla kattintasra vegigkerdezi a fontos beallitasokat, es maga irja be
rem  oket a helyukre:
rem
rem    - admin jelszo   -> scrypt hash a .env-be (a nyers jelszo sehova)
rem    - streamkulcs    -> scrypt hash a server\data\stream-key.json-ba
rem    - port, cimek    -> .env es server\data\server.json
rem    - hook titok     -> .env ES infra\mediamtx\hooks\hook-env.bat
rem
rem  Nem kell kezzel fajlt szerkeszteni, es nem kell npm install sem: a
rem  varazslo csak a Node beepitett moduljait hasznalja.
rem
rem  FIGYELEM, ha ezt a fajlt szerkeszted: NE hasznalj zarojeles if-blokkot
rem  ( if ... ( ... ) else ( ... ) ). Egyetlen escape-eletlen zarojel egy echo
rem  soron belul lezarja a blokkot, amitol a cmd AZONNAL megszakitja a fajlt -
rem  az ablak felvillan es eltunik. Ezert itt mindenhol goto-t hasznalunk.
rem ============================================================================

setlocal
title OnLIVE - beallitas
cd /d "%~dp0"

set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
set "EXIT_CODE=0"

echo.
echo   ============================================================
echo      OnLIVE - beallito varazslo
echo   ============================================================
echo.

rem ---------------------------------------------------------------------------
rem  Node.js
rem ---------------------------------------------------------------------------

where node >nul 2>&1
if errorlevel 1 goto :no_node

for /f "usebackq delims=" %%v in (`node -v 2^>nul`) do set "NODE_VERSION=%%v"
echo         OK   Node.js %NODE_VERSION%

if not exist "%SERVER_DIR%\tools\config.js" goto :no_wizard

rem ---------------------------------------------------------------------------
rem  A varazslo
rem
rem  Innentol a Node veszi at a szot: o kerdez, o ir. Az ablak vegig nyitva
rem  marad, a kilepesi kodot pedig tovabbadjuk.
rem ---------------------------------------------------------------------------

pushd "%SERVER_DIR%"
node tools\config.js
set "EXIT_CODE=%errorlevel%"
popd

if not "%EXIT_CODE%"=="0" goto :cancelled

rem ---------------------------------------------------------------------------
rem  Inditsuk is el a szervert?
rem ---------------------------------------------------------------------------

echo.
set "LAUNCH="
set /p "LAUNCH=  Indulhat most a szerver? [I/n] "
if /i "%LAUNCH%"=="n" goto :no_launch
if /i "%LAUNCH%"=="nem" goto :no_launch

echo.
echo   Inditas...
echo.
endlocal & call "%~dp0start.bat"
exit /b 0

:no_launch
echo.
echo         Rendben - amikor inditanad: start.bat
goto :end

rem ---------------------------------------------------------------------------
rem  Hibautak - mindegyik a kozos vegen all meg, nyitott ablakkal
rem ---------------------------------------------------------------------------

:no_node
echo.
echo         HIBA Nincs telepitve a Node.js, vagy nincs a PATH-ban.
echo              Telepites: https://nodejs.org - 20-as vagy ujabb valtozat kell.
echo              Telepites utan indits ujra ezt a fajlt.
set "EXIT_CODE=1"
goto :end

:no_wizard
echo.
echo         HIBA Nem talalom a varazslot:
echo              %SERVER_DIR%\tools\config.js
echo              Ugy tunik, hianyos a mappa - toltsd le ujra a projektet.
set "EXIT_CODE=1"
goto :end

:cancelled
echo.
echo         A beallitas felbeszakadt vagy megszakitottad.
echo         A korabbi beallitasok valtozatlanok.
goto :end

rem ---------------------------------------------------------------------------
rem  Vege - MINDIG ide futunk be, es MINDIG varunk billentyure
rem ---------------------------------------------------------------------------

:end
echo.
echo   Nyomj egy billentyut a bezarashoz...
pause >nul
rem Egy soron: a %EXIT_CODE% kifejtese meg az endlocal lefutasa ELOTT tortenik.
endlocal & exit /b %EXIT_CODE%
