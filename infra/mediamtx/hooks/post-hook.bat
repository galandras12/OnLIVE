@echo off
rem ============================================================================
rem  OnLIVE — közös hook-küldő
rem
rem  Használat:  post-hook.bat <esemeny> <path> <sourceType> <sourceId>
rem  Esemény: ready | notready
rem
rem  Háromszor próbálkozik (1s, 2s, 4s), majd feladja. Ez szándékos: a hook a
rem  GYORS jelzés, nem az igazság forrása. Ha nem ér célba, a vezérlő szerver
rem  API-pollja pár másodpercen belül úgyis észreveszi az állapotot
rem  (docs/INGEST.md 3. fejezet), ezért soha nem blokkoljuk miatta a MediaMTX-et.
rem ============================================================================

setlocal enabledelayedexpansion

set EVENT=%~1
set MTX_PATH_ARG=%~2
set MTX_SOURCE_TYPE_ARG=%~3
set MTX_SOURCE_ID_ARG=%~4

if "%ONLIVE_CONTROL_URL%"=="" set ONLIVE_CONTROL_URL=http://127.0.0.1:3000
if "%ONLIVE_HOOK_LOG%"=="" set ONLIVE_HOOK_LOG=%~dp0..\..\..\logs\mediamtx-hooks.log

set URL=%ONLIVE_CONTROL_URL%/api/ingest/%EVENT%
set BODY={\"path\":\"%MTX_PATH_ARG%\",\"sourceType\":\"%MTX_SOURCE_TYPE_ARG%\",\"sourceId\":\"%MTX_SOURCE_ID_ARG%\",\"event\":\"%EVENT%\"}

set DELAY=1
for /L %%i in (1,1,3) do (
    curl.exe -sS -m 5 -o nul -X POST "%URL%" ^
        -H "Content-Type: application/json" ^
        -H "X-OnLIVE-Hook-Secret: %ONLIVE_HOOK_SECRET%" ^
        -d "%BODY%"

    if !errorlevel! equ 0 (
        call :log "OK   %EVENT% path=%MTX_PATH_ARG% (proba %%i)"
        endlocal
        exit /b 0
    )

    call :log "HIBA %EVENT% path=%MTX_PATH_ARG% (proba %%i, errorlevel=!errorlevel!)"
    timeout /t !DELAY! /nobreak >nul
    set /a DELAY=!DELAY!*2
)

call :log "FELADVA %EVENT% path=%MTX_PATH_ARG% - a szerver API-pollja fogja eszrevenni"
endlocal
exit /b 1

:log
echo %date% %time% %~1>>"%ONLIVE_HOOK_LOG%"
exit /b 0
