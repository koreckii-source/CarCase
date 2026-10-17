// Создаёт набор анимированных кастомных эмодзи и записывает их id в emoji.json.
// Запуск:  set USER_ID=ваш_telegram_id   затем   node create_emoji_pack.mjs
// (на Windows с прокси: set NODE_USE_ENV_PROXY=1)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(dir, '.env')) ? fs.readFileSync(path.join(dir, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const TOKEN = process.env.BOT_TOKEN, USER_ID = process.env.USER_ID;
if (!TOKEN || !USER_ID) { console.error('Нужны BOT_TOKEN (в .env) и USER_ID (ваш Telegram ID).'); process.exit(1); }
const api = async (method, fields = {}, files = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [name, p] of files) fd.append(name, new Blob([fs.readFileSync(p)]), path.basename(p));
  return (await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body: fd })).json();
};

const KEYS = [['car', '🏎'], ['wheel', '🛞'], ['coin', '🪙'], ['crown', '👑'], ['gem', '💎'], ['play', '▶️'], ['garage', '🏠'], ['catalog', '📖'], ['star', '⭐'], ['trophy', '🏆']];
const me = await api('getMe'); if (!me.ok) { console.error('getMe:', me.description); process.exit(1); }
const setName = `carcase_emoji_by_${me.result.username}`;
console.log('Бот:', me.result.username, '| набор:', setName);
const files = KEYS.map(([k], i) => [`s${i}`, path.join(dir, 'data', 'emoji', `${k}.webm`)]);
const stickers = KEYS.map(([k, e], i) => ({ sticker: `attach://s${i}`, format: 'video', emoji_list: [e] }));

let r = await api('getStickerSet', { name: setName });
if (!r.ok) {
  r = await api('createNewStickerSet', { user_id: USER_ID, name: setName, title: 'Car Case', sticker_type: 'custom_emoji', stickers }, files);
  if (!r.ok) { console.error('createNewStickerSet:', r.description); process.exit(1); }
  console.log('Набор создан');
  r = await api('getStickerSet', { name: setName });
} else console.log('Набор уже есть, беру идентификаторы');
const ids = {}; r.result.stickers.forEach((s, i) => { if (KEYS[i]) ids[KEYS[i][0]] = s.custom_emoji_id; });
fs.writeFileSync(path.join(dir, 'emoji.json'), JSON.stringify(ids, null, 2));
console.log('emoji.json записан:', ids);
console.log('Ссылка на набор: https://t.me/addemoji/' + setName);
