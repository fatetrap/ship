@echo off
rem Double-click: opens the Ship board. From a terminal: Ship.bat done <slug>, Ship.bat pdf <file>, Ship.bat triage, ...
rem Uses the .venv folder next to this file if you made one (see README), else the Python launcher (py).
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto venv
py -3 .agent\ship.py %*
goto end
:venv
".venv\Scripts\python.exe" .agent\ship.py %*
:end
if "%~1"=="" pause
