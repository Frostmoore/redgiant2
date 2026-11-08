@echo off
rem redgiant: RedGiant's command line (G36.15), with the Node and the server that came with
rem the installer. It finds the RedGiant this user runs in its data folder (token.txt, address.txt):
rem the folder chosen in the installer, as the registry says, unless REDGIANT_DATA_DIR is set.
setlocal
set "RG_APP=%~dp0.."
if not defined REDGIANT_DATA_DIR for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\RedGiant" /v DataDir 2^>nul ^| findstr /i "REG_"') do set "REDGIANT_DATA_DIR=%%b"
if not defined REDGIANT_DATA_DIR set "REDGIANT_DATA_DIR=%LOCALAPPDATA%\RedGiant\data"
"%RG_APP%\node\node.exe" "%RG_APP%\server\cli\main.js" %*
exit /b %ERRORLEVEL%
