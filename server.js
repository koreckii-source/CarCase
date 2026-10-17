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

// ---------- хранилище (JSON-файл) ----------
// DATA_DIR можно вынести на постоянный диск хостинга (например /data), иначе используется ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_BAK = path.join(DATA_DIR, 'db.bak.json');
let db = { users: {} };
function loadDb() {
  for (const f of [DB_FILE, DB_BAK]) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d && d.users) { console.log(`База загружена: ${f} (игроков: ${Object.keys(d.users).length})`); return d; } } catch {}
  }
  console.log(`Новая база: ${DB_FILE}`);
  return { users: {} };
}
db = loadDb();
let lastBak = 0;
// запись через временный файл; на Windows переименование иногда блокируется антивирусом — повторяем и при неудаче пишем напрямую
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i === 5) { fs.writeFileSync(file, text); try { fs.unlinkSync(tmp); } catch {} return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (i + 1));
    }
  }
}
function save() { // сохраняем сразу после каждого действия
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeAtomic(DB_FILE, JSON.stringify(db));
    if (Date.now() - lastBak > 60000) { fs.copyFileSync(DB_FILE, DB_BAK); lastBak = Date.now(); }
  } catch (e) { console.error('Ошибка сохранения базы:', e.message); }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
function getUser(tgUser) {
  const id = String(tgUser.id);
  if (!db.users[id]) {
    db.users[id] = { id, name: tgUser.first_name || 'Игрок', balance: START_BALANCE, cars: [], spins: 0, seen: [], rev: 0 };
    save();
  }
  db.users[id].id = id;
  return db.users[id];
}

// ---------- индивидуальные бонусы (data/boosts.json) ----------
// Формат: { "username": { "rarity": "mythic", "spins": 10 } } — на следующие N прокруток игрока выпадает указанная редкость.
const BOOSTS_FILE = process.env.BOOSTS_FILE || path.join(DATA_DIR, 'boosts.json');
function readBoosts() {
  let b = {}; try { b = JSON.parse(fs.readFileSync(BOOSTS_FILE, 'utf8')); } catch {}
  // BOOSTS_SEED (переменная окружения): разовая выдача; применяется, если её метка _v ещё не использовалась
  if (process.env.BOOSTS_SEED) {
    try {
      const seed = JSON.parse(process.env.BOOSTS_SEED);
      b._applied = Array.isArray(b._applied) ? b._applied : [];
      if (seed._v && !b._applied.includes(seed._v)) {
        for (const [k, v] of Object.entries(seed)) if (k !== '_v') b[k] = v;
        b._applied.push(seed._v); writeBoosts(b);
        console.log('Применён BOOSTS_SEED:', seed._v);
      }
    } catch (e) { console.error('BOOSTS_SEED:', e.message); }
  }
  return b;
}
function writeBoosts(b) { try { fs.mkdirSync(path.dirname(BOOSTS_FILE), { recursive: true }); writeAtomic(BOOSTS_FILE, JSON.stringify(b, null, 2)); } catch {} }
function findBoost(b, username) {
  if (!username) return null;
  const key = Object.keys(b).find((k) => !k.startsWith('_') && k.toLowerCase().replace(/^@/, '') === username.toLowerCase());
  return key ? b[key] : null;
}
function takeBoost(username) {
  const b = readBoosts(), e = findBoost(b, username);
  if (!e || !(e.spins > 0)) return null;
  e.spins -= 1; writeBoosts(b);
  return e.rarity;
}
// разовая установка баланса игроку: { "username": { "balance": 1000000000 } } — применяется один раз, затем поле удаляется
function applyGrant(u, tgUser) {
  if (!tgUser || !tgUser.username) return;
  u.username = tgUser.username;
  const b = readBoosts(), e = findBoost(b, tgUser.username);
  if (e && typeof e.balance === 'number') {
    u.balance = Math.max(0, Math.floor(e.balance)); u.rev = (u.rev || 0) + 1;
    delete e.balance; writeBoosts(b); save();
    console.log(`Выдан баланс ${u.balance} игроку @${tgUser.username}`);
  }
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

// ---------- подписанный снимок прогресса (хранится у игрока в облаке Telegram) ----------
// Ключ подписи: SAVE_SECRET (рекомендуется задать на хостинге), иначе BOT_TOKEN.
const SECRET = process.env.SAVE_SECRET || BOT_TOKEN || 'dev-secret';
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function snapshot(u) {
  const c = {}; for (const x of u.cars) c[x] = (c[x] || 0) + 1;
  const data = Buffer.from(JSON.stringify({ i: String(u.id), b: u.balance, s: u.spins, r: u.rev || 0, c, n: u.seen, t: Date.now() })).toString('base64url');
  return data + '.' + sign(data);
}
function restore(u, snap) {
  const [data, sig] = String(snap || '').split('.');
  if (!data || !sig) return { error: 'Нет данных' };
  const good = sign(data);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return { error: 'Подпись не совпала' };
  let p; try { p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return { error: 'Повреждённые данные' }; }
  if (p.i !== String(u.id)) return { error: 'Чужой снимок' };
  if (!(p.r > (u.rev || 0))) return { error: 'Сервер уже новее' };
  const cars = [];
  for (const [id, n] of Object.entries(p.c || {})) { if (!BY_ID.has(Number(id)) || !(n >= 0) || n > 100000) return { error: 'Некорректные данные' }; for (let k = 0; k < n; k++) cars.push(Number(id)); }
  u.balance = Math.max(0, Math.floor(p.b)); u.spins = Math.max(0, Math.floor(p.s)); u.rev = p.r; u.cars = cars;
  u.seen = (p.n || []).filter((id) => BY_ID.has(id));
  save();
  return { state: view(u) };
}

// ---------- игровая логика ----------
function view(u) {
  const counts = {};
  for (const id of u.cars) counts[id] = (counts[id] || 0) + 1;
  return {
    name: u.name,
    rev: u.rev || 0,
    snap: snapshot(u),
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
  u.rev = (u.rev || 0) + 1;
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
  u.rev = (u.rev || 0) + 1;
  u.balance += gain;
  save();
  return { gain, state: view(u) };
}

function reset(u) {
  if (u.balance >= SPIN_COST || u.cars.length > 0) return { error: 'Сброс доступен только при банкротстве' };
  u.balance = START_BALANCE;
  u.rev = (u.rev || 0) + 1;
  save();
  return { state: view(u) };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.ttf': 'font/ttf' };
const PUBLIC = path.join(__dirname, 'public');

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e4) req.destroy(); });
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
    applyGrant(u, tg);
    const body = req.method === 'POST' ? await readBody(req) : {};
    let r;
    switch (url.pathname) {
      case '/api/state': r = { state: view(u) }; break;
      case '/api/spin': r = spin(u, tg); break;
      case '/api/sell': r = sell(u, Number(body.carId), !!body.all); break;
      case '/api/reset': r = reset(u); break;
      case '/api/restore': r = restore(u, body.snap); break;
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
async function tg(method, payload, timeoutMs = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    return await r.json();
  } finally { clearTimeout(t); }
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
      const r = await tg('getUpdates', { offset, timeout: 15, allowed_updates: ['message'] }, 30000);
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
      console.error('polling error:', e.name === 'AbortError' ? 'таймаут' : e.message, e.cause ? (e.cause.code || e.cause.message) : '');
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
