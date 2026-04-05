# Project: telega-bron

MVP Telegram-бот для создания ссылок на бронирование со скидкой в RealtyCalendar через Playwright.

## Commands
- `npm run dev` — запуск в режиме разработки
- `npm run build` — сборка TypeScript
- `npm start` — запуск продакшен

## Stack
- Node.js + TypeScript
- Telegraf (Telegram Bot API)
- Playwright (browser automation)
- Winston (logging)

## Conventions
- Language: TypeScript strict mode
- Secrets in .env only, never commit .env
- Logs go to storage/logs/, screenshots to storage/screenshots/
- One automation task at a time (mutex in taskRunner)
