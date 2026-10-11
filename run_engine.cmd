@echo off
rem Start the Orynr Code engine on http://127.0.0.1:4096 (Python 3.11; see README "Run from source").
cd /d "%~dp0"
python engine\orynr_engine.py serve --port 4096 --directory "%CD%"
