// Сервер: раздаёт Mini App, отдаёт игровое API и запускает Telegram-бота (long polling).
// Зависимостей нет — нужен только Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CARS, BY_ID, RARITY, rollCar } = require('./cars');

loadEnv();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
let WEBAPP_URL = process.env.WEBAPP_URL || '';
const URL_FILE = path.join(__dirname, 'data', 'webapp_url.txt');
async function refreshUrl() {
  try {
    const u = fs.readFileSync(URL_FILE, 'utf8').trim();
    if (u && u !== WEBAPP_URL) {
      WEBAPP_URL = u;
      console.log('Новый адрес Mini App:', u);
      await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '🎰 Играть', web_app: { url: u } } });
    }
  } catch {}
}
setInterval(() => refreshUrl().catch(() => {}), 10000);
const PORT = Number(process.env.PORT) || 3000;
const DEV = process.env.DEV === '1';

const START_BALANCE = 100000;
const SPIN_COST = 5000;
const SELL_RATIO = 0.4; // за сколько от рыночной цены можно продать машину

// ---------- простое хранилище (JSON-файл) ----------
const DB_FILE = path.join(__dirname, 'data', 'db.json');
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}
function getUser(tgUser) {
  const id = String(tgUser.id);
  if (!db.users[id]) {
    db.users[id] = { name: tgUser.first_name || 'Игрок', balance: START_BALANCE, cars: [], spins: 0, seen: [] };
    save();
  }
  return db.users[id];
}

// ---------- индивидуальные бонусы (data/boosts.json) ----------
// Формат: { "username": { "rarity": "mythic", "spins": 10 } } — на следующие N прокруток игрока выпадает указанная редкость.
const BOOSTS_FILE = process.env.BOOSTS_FILE || path.join(__dirname, 'data', 'boosts.json');
function takeBoost(username) {
  if (!username) return null;
  let b; try { b = JSON.parse(fs.readFileSync(BOOSTS_FILE, 'utf8')); } catch { return null; }
  const key = Object.keys(b).find((k) => k.toLowerCase().replace(/^@/, '') === username.toLowerCase());
  if (!key || !(b[key].spins > 0)) return null;
  b[key].spins -= 1;
  try { fs.writeFileSync(BOOSTS_FILE, JSON.stringify(b, null, 2)); } catch {}
  return b[key].rarity;
}

// ---------- проверка подписи Telegram initData ----------
function authUser(req) {
  if (DEV && req.headers['x-dev-user']) {
    return { id: Number(req.headers['x-dev-user']) || 1, first_name: 'Dev', username: req.headers['x-dev-username'] || undefined };
  }
  const initData = req.headers['x-init-data'];
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// ---------- игровая логика ----------
function view(u) {
  const counts = {};
  for (const id of u.cars) counts[id] = (counts[id] || 0) + 1;
  return {
    name: u.name,
    balance: u.balance,
    spins: u.spins,
    cars: u.cars, // список id, повторы = дубликаты
    seen: u.seen, // id машин, которые когда-либо выпадали (для прогресса коллекции)
    spinCost: SPIN_COST,
    sellRatio: SELL_RATIO,
    catalog: CARS,
    rarity: RARITY,
  };
}

function spin(u, tgUser) {
  if (u.balance < SPIN_COST) return { error: 'Недостаточно средств' };
  u.balance -= SPIN_COST;
  u.spins += 1;
  const car = rollCar(Math.random, takeBoost(tgUser && tgUser.username));
  u.cars.push(car.id);
  const isNew = !u.seen.includes(car.id);
  if (isNew) u.seen.push(car.id);
  save();
  return { car, isNew, state: view(u) };
}

function sell(u, carId, all) {
  const car = BY_ID.get(carId);
  if (!car) return { error: 'Нет такой машины' };
  let n = all ? u.cars.filter((c) => c === carId).length : 1;
  if (!u.cars.includes(carId)) return { error: 'Этой машины нет в коллекции' };
  for (let i = 0; i < n; i++) u.cars.splice(u.cars.indexOf(carId), 1);
  const gain = Math.round(car.price * SELL_RATIO) * n;
  u.balance += gain;
  save();
  return { gain, state: view(u) };
}

function reset(u) {
  if (u.balance >= SPIN_COST || u.cars.length > 0) return { error: 'Сброс доступен только при банкротстве' };
  u.balance = START_BALANCE;
  save();
  return { state: view(u) };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.ttf': 'font/ttf' };
const PUBLIC = path.join(__dirname, 'public');

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const tg = authUser(req);
    if (!tg) return json(res, 401, { error: 'Откройте игру через Telegram' });
    const u = getUser(tg);
    const body = req.method === 'POST' ? await readBody(req) : {};
    let r;
    switch (url.pathname) {
      case '/api/state': r = { state: view(u) }; break;
      case '/api/spin': r = spin(u, tg); break;
      case '/api/sell': r = sell(u, Number(body.carId), !!body.all); break;
      case '/api/reset': r = reset(u); break;
      default: return json(res, 404, { error: 'not found' });
    }
    return json(res, r.error ? 400 : 200, r);
  }
  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': /^\/(cars|fonts)\//.test(url.pathname) ? 'public, max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Mini App: http://localhost:${PORT}  (машин в каталоге: ${CARS.length})`);
  if (DEV) console.log('DEV режим: авторизация по заголовку x-dev-user');
});

// ---------- Telegram-бот (long polling) ----------
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function startBot() {
  if (!BOT_TOKEN) return console.log('BOT_TOKEN не задан — бот не запущен (работает только сервер).');
  if (!WEBAPP_URL) console.log('⚠ WEBAPP_URL не задан — кнопка игры не появится.');
  for (;;) {
    try {
      await tg('deleteWebhook', {});
      if (WEBAPP_URL) {
        await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: '🎰 Играть', web_app: { url: WEBAPP_URL } } });
      }
      break;
    } catch (e) {
      console.error('Нет связи с Telegram (нужен VPN/прокси?):', e.cause ? e.cause.code : e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log('Бот запущен');
  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const upd of r.result || []) {
        offset = upd.update_id + 1;
        const m = upd.message;
        if (!m || !m.text) continue;
        if (m.text.startsWith('/start') || m.text.startsWith('/play')) {
          await tg('sendMessage', {
            chat_id: m.chat.id,
            text: '🏎 <b>Автоколлекция</b>\n\nКрути рулетку, собирай машины от «Оки» до Bugatti Chiron!\n💰 Старт: 100 000 ₽ · 🎰 Прокрут: 5 000 ₽\nНенужные машины можно продать и крутить дальше.',
            parse_mode: 'HTML',
            reply_markup: WEBAPP_URL
              ? { inline_keyboard: [[{ text: '🎰 Играть', web_app: { url: WEBAPP_URL } }]] }
              : undefined,
          });
        }
      }
    } catch (e) {
      console.error('polling error:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
startBot().catch((e) => console.error('bot error:', e.cause ? e.cause.code : e.message));

function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}
