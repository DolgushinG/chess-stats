@echo off
rem Chess Stats — запуск локального сервера (Windows)
cd /d "%~dp0"

set "NODE=%~dp0runtime\node-v24.21.0-win-x64\node.exe"

if not exist "%NODE%" (
  echo.
  echo [Ошибка] Портативный Node.js не найден: %NODE%
  echo Скачайте https://nodejs.org/dist/latest-v24.x/node-v24.21.0-win-x64.zip
  echo и распакуйте в папку runtime\.
  echo.
  pause
  exit /b 1
)

echo Запуск сервера Chess Stats...
echo Открывается браузер: http://localhost:8000
echo.

rem Открыть браузер через 2 секунды (пока сервер стартует)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8000"

"%NODE%" server.js

echo.
echo Сервер остановлен.
pause
