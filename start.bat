@echo off
rem ============================================================================
rem  OnLIVE - indito script (1.0.012)
rem
rem  Dupla kattintasra elinditja a TELJES rendszert, es lepesenkent kiirja,
rem  hol tart:
rem    1. Cloudflare Tunnel service (ha nem fut)
rem    2. Node es fuggosegek ellenorzese
rem    3. Port ellenorzese
rem    4. MediaMTX ingest (az npm start intezi)
rem    5. Vezerlo szerver - a naploja ELOBEN ebben az ablakban latszik
rem
rem  Az ablak MINDEN esetben nyitva marad - hibanal is -, hogy latszodjon,
rem  mi tortent. Leallitas: Ctrl+C, majd egy billentyu.
rem
rem  FIGYELEM, ha ezt a fajlt szerkeszted: NE hasznalj zarojeles if-blokkot
rem  ( if ... ( ... ) else ( ... ) ). Egyetlen escape-eletlen zarojel egy echo
rem  soron belul lezarja a blokkot, amitol a cmd szintaktikai hibaval AZONNAL
rem  megszakitja a fajlt - az ablak felvillan es eltunik. Pontosan ez volt a
rem  hiba 1.0.011-ig. Ezert itt mindenhol goto-t hasznalunk, blokk nelkul.
rem ============================================================================

setlocal
title OnLIVE
cd /d "%~dp0"

set "ROOT=%~dp0"
set "STARTUP_LOG=%ROOT%logs\startup.log"
set "SERVER_DIR=%ROOT%server"
set "LOG_DIR=%SERVER_DIR%\logs"
set "EXIT_CODE=0"
set "PORT="

if not exist "%ROOT%logs" mkdir "%ROOT%logs"
call :log "INDITAS  ---------------------------------------------"

echo.
echo   ============================================================
echo      OnLIVE - inditas
echo   ============================================================
echo.

rem ---------------------------------------------------------------------------
rem  1/5  Cloudflare Tunnel
rem
rem  A Node oldali indito is ellenorzi, de itt hamarabb kiderul, ha
rem  rendszergazdai jog kell hozza - meg a szerver elindulasa elott.
rem ---------------------------------------------------------------------------

set "TUNNEL_SERVICE=cloudflared"
call :step "1/5" "Cloudflare Tunnel ellenorzese"

sc query "%TUNNEL_SERVICE%" >nul 2>&1
if errorlevel 1 goto :tunnel_missing

sc query "%TUNNEL_SERVICE%" | find "RUNNING" >nul
if errorlevel 1 goto :tunnel_stopped

call :ok "A tunnel service mar fut."
call :log "TUNNEL   mar futott"
goto :tunnel_done

:tunnel_missing
call :warn "A '%TUNNEL_SERVICE%' service nincs telepitve."
echo         A rendszer csak helyi halozaton lesz elerheto.
echo         Telepites: docs\NETWORKING.md 4.7 fejezet
call :log "TUNNEL   nincs telepitve"
goto :tunnel_done

:tunnel_stopped
call :info "A tunnel service all - inditas..."
net start "%TUNNEL_SERVICE%" >nul 2>&1
if errorlevel 1 goto :tunnel_failed
call :ok "Cloudflare Tunnel elindult."
call :log "TUNNEL   elinditva"
goto :tunnel_done

:tunnel_failed
call :warn "A tunnel service inditasa nem sikerult."
echo         Rendszergazdakent inditsd a start.bat-ot, vagy kezzel:
echo             net start %TUNNEL_SERVICE%
call :log "TUNNEL   inditas sikertelen"

:tunnel_done
echo.

rem ---------------------------------------------------------------------------
rem  2/5  Node es npm
rem ---------------------------------------------------------------------------

call :step "2/5" "Node.js ellenorzese"

where node >nul 2>&1
if errorlevel 1 goto :no_node

for /f "usebackq delims=" %%v in (`node -v 2^>nul`) do set "NODE_VERSION=%%v"
call :ok "Node.js %NODE_VERSION%"

where npm >nul 2>&1
if errorlevel 1 goto :no_npm

if not exist "%SERVER_DIR%\node_modules" goto :install_deps
call :ok "Fuggosegek rendben."
goto :deps_done

:install_deps
call :info "Elso inditas - fuggosegek telepitese, ez eltarthat egy percig..."
pushd "%SERVER_DIR%"
call npm install --no-audit --no-fund
set "EXIT_CODE=%errorlevel%"
popd
if not "%EXIT_CODE%"=="0" goto :install_failed
call :ok "Fuggosegek telepitve."
call :log "NPM      install lefutott"

:deps_done
echo.

rem ---------------------------------------------------------------------------
rem  3/5  Port
rem
rem  Meg az inditas elott kiirjuk, hol lesz elerheto a felulet - es szolunk,
rem  ha a portot mar hasznalja valaki (jellemzoen egy masik, mar futo OnLIVE).
rem ---------------------------------------------------------------------------

call :step "3/5" "Port ellenorzese"

pushd "%SERVER_DIR%"
for /f "usebackq delims=" %%p in (`node tools\port.js 2^>nul`) do set "PORT=%%p"
popd

if "%PORT%"=="" goto :port_unknown
call :ok "A szerver a %PORT%-es porton fog indulni."
echo         Helyi cim:  http://localhost:%PORT%/admin

netstat -ano | findstr /c:":%PORT% " | findstr /i "LISTENING" >nul 2>&1
if errorlevel 1 goto :port_free
call :warn "Ezt a portot mar hasznalja valami."
echo         Vagy mar fut egy OnLIVE peldany, vagy mas program foglalja.
echo         Ha a szerver most 'EADDRINUSE' hibaval all meg, ez az oka.
echo         Port atallitasa: Admin felulet - Szerver ful.
call :log "PORT     %PORT% foglalt"
goto :port_done

:port_free
call :log "PORT     %PORT% szabad"
goto :port_done

:port_unknown
call :warn "A portot nem sikerult megallapitani - a szerver a sajat beallitasat hasznalja."
call :log "PORT     ismeretlen"

:port_done
echo.

rem ---------------------------------------------------------------------------
rem  4-5/5  Vezerlo szerver (a MediaMTX-et az npm start intezi)
rem ---------------------------------------------------------------------------

call :step "4/5" "MediaMTX ingest ellenorzese - az inditot koveti"
call :step "5/5" "Vezerlo szerver inditasa"
echo.
echo   ------------------------------------------------------------
echo    Innentol a szerver naploja latszik. Leallitas: Ctrl+C
echo    Naplo konyvtar: %LOG_DIR%  ^(naponta uj fajl^)
echo   ------------------------------------------------------------
echo.
call :log "SZERVER  inditas (port: %PORT%)"

pushd "%SERVER_DIR%"
call npm start
set "EXIT_CODE=%errorlevel%"
popd

call :log "SZERVER  leallt (kilepesi kod: %EXIT_CODE%)"

echo.
echo   ============================================================
echo      A szerver leallt. Kilepesi kod: %EXIT_CODE%
echo   ============================================================
echo.

if "%EXIT_CODE%"=="0" goto :show_log
call :warn "A szerver hibaval allt le. Az utolso naplosorok:"

:show_log
call :tail_log
goto :end

rem ---------------------------------------------------------------------------
rem  Hibautak - mindegyik a kozos vegen all meg, nyitott ablakkal
rem ---------------------------------------------------------------------------

:no_node
call :err "Nincs telepitve a Node.js, vagy nincs a PATH-ban."
echo         Telepites: https://nodejs.org  - 20-as vagy ujabb valtozat kell.
echo         Telepites utan indits ujra ezt a fajlt.
call :log "HIBA     nincs node"
goto :end

:no_npm
call :err "A Node.js megvan, de az npm nem talalhato a PATH-ban."
echo         Telepitsd ujra a Node.js-t a hivatalos telepitovel.
call :log "HIBA     nincs npm"
goto :end

:install_failed
call :err "A fuggosegek telepitese nem sikerult (npm install)."
echo         Ellenorizd az internetkapcsolatot, majd probald ujra.
echo         Kezzel:  cd server ^&^& npm install
call :log "HIBA     npm install sikertelen"
goto :end

rem ---------------------------------------------------------------------------
rem  Vege - MINDIG ide futunk be, es MINDIG varunk billentyure
rem ---------------------------------------------------------------------------

:end
call :log "LEALLAS  ---------------------------------------------"
echo.
echo   Nyomj egy billentyut a bezarashoz...
pause >nul
rem Egy soron: a %EXIT_CODE% kifejtese meg az endlocal lefutasa ELOTT tortenik,
rem kulon sorban mar ures lenne.
endlocal & exit /b %EXIT_CODE%

rem ===========================================================================
rem  Segedrutinok
rem ===========================================================================

rem Lepes-fejlec: "[2/5] Node.js ellenorzese"
:step
echo   [%~1] %~2
exit /b 0

:ok
echo         OK   %~1
exit /b 0

:info
echo         ...  %~1
exit /b 0

:warn
echo         FIGY %~1
exit /b 0

:err
echo.
echo         HIBA %~1
exit /b 0

rem A legutobbi naplofajl utolso sorai - hogy egy gyors leallas oka is latszodjon,
rem akkor is, ha a konzol mar elgorgott.
:tail_log
if not exist "%LOG_DIR%" exit /b 0
where powershell >nul 2>&1
if errorlevel 1 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Get-ChildItem -Path '%LOG_DIR%\*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1; if ($f) { Write-Host ''; Write-Host ('   Naplo: ' + $f.FullName); Write-Host ''; Get-Content -Path $f.FullName -Tail 20 | ForEach-Object { try { $e = $_ | ConvertFrom-Json; '   {0}  {1,-5} {2}' -f $e.ts.Substring(11,8), $e.level.ToUpper(), $e.message } catch { '   ' + $_ } } }"
exit /b 0

rem Idobelyeges sor a startup.log-ba - visszakereshetoen, mikor futott.
rem A szokoz a '>>' elott KELL: szamjegyre vegzodo uzenetnel a cmd
rem fajlkezelo-atiranyitasnak ertelmezne (pl. '...kod: 1>>fajl').
:log
echo %date% %time% ^| %~1 >>"%STARTUP_LOG%"
exit /b 0
