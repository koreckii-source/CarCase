# Автоколлекция — Telegram Mini App

Рулетка машин: старт 100 000 ₽, прокрут 5 000 ₽, машины с примерными рыночными ценами, коллекция, продажа.
Без зависимостей — нужен только Node.js 18+.

## Запуск
1. Создайте бота в @BotFather → скопируйте токен.
2. Mini App требует HTTPS. Запустите туннель: `cloudflared tunnel --url http://localhost:3000` (или `ngrok http 3000`) и скопируйте https-адрес.
3. `copy .env.example .env` и впишите `BOT_TOKEN` и `WEBAPP_URL`.
4. `node server.js`
5. Напишите боту `/start` → кнопка «Играть» (также есть кнопка меню).

## Настройки
- `cars.js` — список машин, цены, шансы редкостей.
- `server.js` — `START_BALANCE`, `SPIN_COST`, `SELL_RATIO` (доля цены при продаже, сейчас 40%).
- Прогресс игроков: `data/db.json`.

## Проверка без Telegram
`DEV=1 node server.js`, затем открыть `http://localhost:3000/?dev=1`.
