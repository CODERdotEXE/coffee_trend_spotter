@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python not found. Install from https://python.org & pause & exit /b 1)
python -m pip install -q -r requirements.txt
echo.
echo  Brewscope starting...  open  http://127.0.0.1:5000  in your browser
echo.
python app.py
pause
