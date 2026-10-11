@echo off
rem Start the terminal app from source and attach it to the engine (start run_engine.cmd first).
cd /d "%~dp0frontend"
bun run --cwd packages/orynr --conditions=browser src/index.ts attach http://127.0.0.1:4096
