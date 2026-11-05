@echo off
rem Build release\TabChat-Server.exe (server window), release\TabChat.exe (app) and release\TabTunnel.exe
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
    py -3 -m venv .venv
    .venv\Scripts\python -m pip install -r requirements.txt pyinstaller
)
.venv\Scripts\python -m PyInstaller --noconfirm --onefile --windowed --name TabChat-Server --icon "%~dp0static\icons\app.ico" --add-data "%~dp0static;static" --distpath release --workpath build\server --specpath build server.py
if errorlevel 1 goto fail
.venv\Scripts\python -m PyInstaller --noconfirm --onefile --windowed --name TabChat --icon "%~dp0static\icons\app.ico" --add-data "%~dp0static;static" --distpath release --workpath build\client --specpath build client.py
if errorlevel 1 goto fail
.venv\Scripts\python -m PyInstaller --noconfirm --onefile --console --name TabTunnel --paths "%~dp0tunnel" --icon "%~dp0tunnel\icon.ico" --add-data "%~dp0tunnel\icon.png;." --distpath release --workpath build\tunnel --specpath build tunnel\app.py
if errorlevel 1 goto fail
echo.
echo Done: release\TabChat-Server.exe, release\TabChat.exe and release\TabTunnel.exe
exit /b 0
:fail
echo.
echo Build failed. If one of the programs is running, close it and try again.
exit /b 1
