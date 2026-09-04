// Напоминает каждому работнику, у кого сегодня рабочая смена по графику,
// внести данные по сделке — за 1 час 20 минут до конца смены.
// Дневная смена: 07:00–19:00 → напоминание в 17:40.
// Ночная смена: 19:00–07:00 → напоминание в 05:40 (уже на следующий день).
//
// Запускается дважды в день через GitHub Actions (см. reminder.yml),
// SHIFT_TYPE передаётся из workflow и указывает, какую смену проверять сейчас.

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '3', 10); // Москва = 3
const SHIFT_TYPE = process.env.SHIFT_TYPE; // 'day' или 'night'

if (!BOT_TOKEN || !DATABASE_URL || !SHIFT_TYPE) {
  console.error('Не заданы BOT_TOKEN / FIREBASE_DATABASE_URL / SHIFT_TYPE');
  process.exit(1);
}

function localDateStr(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000 + offsetDays * 86400000);
  return shifted.toISOString().slice(0, 10);
}
function formatDateRu(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function sanitizeKey(name) {
  return name.replace(/[.#$\[\]]/g, '_');
}

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

async function main() {
  // День проверяем "сегодня"; ночь проверяем "вчера" — потому что ночная смена
  // в графике записана под датой, когда она НАЧАЛАСЬ (19:00), а заканчивается уже
  // утром следующих суток, когда и происходит эта проверка (05:40).
  const targetDate = SHIFT_TYPE === 'night' ? localDateStr(-1) : localDateStr(0);
  // для ночной смены запись по сделке могла попасть под любую из двух дат
  const entryDateCandidates = SHIFT_TYPE === 'night'
    ? [targetDate, localDateStr(0)]
    : [targetDate];

  const brigades = await fbGet('brigades');
  if (!brigades) {
    console.log('Бригад пока нет — нечего проверять.');
    return;
  }

  for (const code of Object.keys(brigades)) {
    const b = brigades[code] || {};
    const workers = b.workers || [];
    const schedule = b.schedule || {};
    const entries = b.entries || {};
    const telegramIds = b.telegramIds || {};
    const reminded = b.reminded || {};

    const daySched = schedule[targetDate] || {};

    for (const worker of workers) {
      const shiftId = daySched[worker];
      if (shiftId !== SHIFT_TYPE) continue; // не тот тип смены (или смены вообще нет)

      const key = sanitizeKey(worker);
      const chatId = telegramIds[key];
      if (!chatId) {
        console.log(`[${code}] ${worker}: смена ${SHIFT_TYPE}, но нет Telegram ID`);
        continue;
      }

      const remindedKey = `${targetDate}_${SHIFT_TYPE}_${key}`;
      if (reminded[remindedKey]) continue; // уже напоминали сегодня по этой смене

      const hasEntries = entryDateCandidates.some(d =>
        Object.values(entries).some(e => e.worker === worker && e.date === d)
      );
      if (hasEntries) continue; // данные уже внесены — не беспокоим

      const endTime = SHIFT_TYPE === 'day' ? '19:00' : '07:00';
      const text = `⏰ Смена заканчивается в ${endTime} — через 1 час 20 минут.\n`
        + `Не забудьте внести данные по сделке за сегодня в приложении, пока смена не закончилась.`;

      const ok = await sendTelegramMessage(chatId, text);
      if (ok) {
        console.log(`[${code}] Напоминание отправлено: ${worker} (${SHIFT_TYPE})`);
        await fbPut(`brigades/${code}/reminded/${remindedKey}`, true);
      }
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
