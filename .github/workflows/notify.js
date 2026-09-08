// Скрипт запускается через GitHub Actions по расписанию.
// Проверяет график смен всех бригад и отправляет личное сообщение в Telegram
// каждому сотруднику, у которого сегодня последний рабочий день перед выходными.
//
// Нужен Node.js 18+ (в GitHub Actions уже есть из коробки, встроенный fetch).

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL; // например: https://uchet-b8c60-default-rtdb.firebaseio.com
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '3', 10); // Москва = 3

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('Не заданы переменные окружения BOT_TOKEN и/или FIREBASE_DATABASE_URL');
  process.exit(1);
}

// ---------- Даты в нужном часовом поясе ----------
function localDateStr(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000 + offsetDays * 86400000);
  return shifted.toISOString().slice(0, 10); // YYYY-MM-DD
}
function formatDateRu(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Та же санитизация ключа, что и в приложении (Firebase не разрешает . # $ [ ] в ключах)
function sanitizeKey(name) {
  return name.replace(/[.#$\[\]]/g, '_');
}

// ---------- Firebase REST helpers ----------
async function fbGet(path) {
  const res = await fetch(`${DATABASE_URL}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase GET ${path} -> ${res.status}`);
  return res.json();
}
async function fbPut(path, value) {
  const res = await fetch(`${DATABASE_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) console.error(`Firebase PUT ${path} -> ${res.status}`);
}

// ---------- Telegram ----------
async function sendTelegramMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await res.json();
  if (!data.ok) console.error('Ошибка отправки в Telegram:', data);
  return data.ok;
}

// ---------- Основная логика ----------
async function main() {
  const today = localDateStr(0);
  const tomorrow = localDateStr(1);

  const brigades = await fbGet('brigades');
  if (!brigades) {
    console.log('Бригад пока нет — нечего проверять.');
    return;
  }

  for (const code of Object.keys(brigades)) {
    const b = brigades[code] || {};
    const workers = b.workers || [];
    const shiftTypes = b.shiftTypes || [];
    const schedule = b.schedule || {};
    const entries = b.entries || {};
    const telegramIds = b.telegramIds || {};
    const notified = b.notified || {};

    const offType = shiftTypes.find(t => t.id === 'off');

    const todaySched = schedule[today] || {};
    const tomorrowSched = schedule[tomorrow] || {};

    for (const worker of workers) {
      const todayShift = todaySched[worker];
      const tomorrowShift = tomorrowSched[worker];

      const isWorkingToday = todayShift && (!offType || todayShift !== offType.id);
      const isOffTomorrow = offType && tomorrowShift === offType.id;

      if (!isWorkingToday || !isOffTomorrow) continue; // не последний рабочий день

      const key = sanitizeKey(worker);
      const chatId = telegramIds[key];
      if (!chatId) {
        console.log(`[${code}] ${worker}: последний рабочий день, но нет Telegram ID (ещё не открывал(а) приложение в Telegram)`);
        continue;
      }

      const notifiedKey = `${today}_${key}`;
      if (notified[notifiedKey]) continue; // уже отправляли сегодня этому человеку

      // Собираем отчёт по этому работнику за сегодняшнюю смену
      const ownEntries = Object.values(entries).filter(e => e.worker === worker && e.date === today);
      const byCategory = {};
      ownEntries.forEach(e => {
        byCategory[e.category] = (byCategory[e.category] || 0) + e.qty;
      });
      const total = Object.values(byCategory).reduce((s, q) => s + q, 0);

      let text = `📄 Отчёт за последнюю рабочую смену\n`;
      text += `Завод/цех: ${b.factory || '—'}\n`;
      text += `Дата: ${formatDateRu(today)}\n\n`;
      if (Object.keys(byCategory).length === 0) {
        text += `Записей за сегодня не найдено.\n`;
      } else {
        Object.keys(byCategory).forEach(cat => {
          text += `🔧 ${cat}: ${byCategory[cat]} шт\n`;
        });
        text += `\nИтого: ${total} шт\n`;
      }
      text += `\nЗавтра у вас выходной. Хорошего отдыха!`;

      const ok = await sendTelegramMessage(chatId, text);
      if (ok) {
        console.log(`[${code}] Отправлено: ${worker}`);
        await fbPut(`brigades/${code}/notified/${notifiedKey}`, true);
      }
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
