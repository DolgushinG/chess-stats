#!/usr/bin/env bash
# Chess Stats — запуск локального сервера (macOS / Linux)
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установи его (macOS: brew install node)."
  exit 1
fi

echo "Запуск сервера Chess Stats... (http://localhost:8000)"

# открыть браузер через 2 секунды (пока сервер стартует)
( sleep 2; (open http://localhost:8000 2>/dev/null || xdg-open http://localhost:8000 2>/dev/null) ) &

node server.js
