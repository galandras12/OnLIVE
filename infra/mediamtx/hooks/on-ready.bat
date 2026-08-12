@echo off
rem ============================================================================
rem  OnLIVE — MediaMTX runOnReady hook
rem
rem  Akkor fut le, amikor egy útvonal ÉLŐVÉ válik: a publisher (a telefon)
rem  csatlakozott, és a sávok ismertek. A vezérlő szerver ebből tudja meg
rem  azonnal, hogy van bejövő adás — nem kell megvárnia a következő pollt.
rem
rem  Hívás a mediamtx.yml-ből:
rem    runOnReady: ...\on-ready.bat "$MTX_PATH" "$MTX_SOURCE_TYPE" "$MTX_SOURCE_ID"
rem ============================================================================

setlocal
if exist "%~dp0hook-env.bat" call "%~dp0hook-env.bat"

set MTX_PATH_ARG=%~1
set MTX_SOURCE_TYPE_ARG=%~2
set MTX_SOURCE_ID_ARG=%~3

call "%~dp0post-hook.bat" ready "%MTX_PATH_ARG%" "%MTX_SOURCE_TYPE_ARG%" "%MTX_SOURCE_ID_ARG%"
endlocal
