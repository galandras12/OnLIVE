@echo off
rem ============================================================================
rem  OnLIVE — MediaMTX runOnNotReady hook
rem
rem  Akkor fut le, amikor az útvonal megszűnik élő lenni: a publisher
rem  lecsatlakozott, vagy a readTimeout letelt adat nélkül.
rem
rem  FONTOS: ez a hook NEM dönti el, hogy "megszakadt" vagy "vége az adásnak" —
rem  csak tényt közöl. A megkülönböztetés a vezérlő szerver állapotgépéé
rem  (4. szegmens): ha a felhasználó nyomott Befejezést, OUTRO következik;
rem  ha nem, akkor INTERRUPTED.
rem ============================================================================

setlocal
if exist "%~dp0hook-env.bat" call "%~dp0hook-env.bat"

set MTX_PATH_ARG=%~1
set MTX_SOURCE_TYPE_ARG=%~2
set MTX_SOURCE_ID_ARG=%~3

call "%~dp0post-hook.bat" notready "%MTX_PATH_ARG%" "%MTX_SOURCE_TYPE_ARG%" "%MTX_SOURCE_ID_ARG%"
endlocal
