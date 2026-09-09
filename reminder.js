// =====================================================
// Бот напоминаний: проверяет график смен в Firebase,
// шлёт Telegram-уведомление за 1ч20м до конца смены.
// Дневная смена: 07:00–19:00 → напоминание в 17:40
// Ночная смена: 19:00–07:00 → напоминание в 05:40
// =====================================================

console.log('=== SCRIPT STARTED ===');
console.log('SHIFT_TYPE:', process.env.SHIFT_TYPE);

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '3', 10);
const SHIFT_TYPE = process.env.SHIFT_TYPE; // 'day' или 'night'

if (!BOT_TOKEN || !DATABASE_URL || !SHIFT_TYPE) {
  console.error('Не заданы BOT_TOKEN / FIREBASE_DATABASE_URL / SHIFT_TYPE');
  process.exit(1);
}

// ---- Вспомогательные функции ----

function localDateStr(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000 + offsetDays * 86400000);
  return shifted.toISOString().slice(0, 10);
}

function sanitizeKey(name) {
  return name.replace(/[.#$]/g, '_');
}

// ---- Firebase REST API ----

async function fbGet(path) {
  const url = `${DATABASE_URL}/${path}.json`;
  console.log(`Firebase GET: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase GET ${path} -> ${res.status}`);
  return res.json();
}

async function fbPut(path, value) {
  const url = `${DATABASE_URL}/${path}.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!res.ok) console.error(`Firebase PUT ${path} -> ${res.status}`);
  return res.ok;
}

// ---- Telegram API ----

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Ошибка Telegram:', JSON.stringify(data));
    }
    return data.ok;
  } catch (e) {
    console.error('Ошибка отправки в Telegram:', e.message);
    return false;
  }
}

// ---- Основная логика ----

async function main() {
  // Ночная смена в графике записана под датой начала (19:00 вчерашнего дня),
  // а проверяем мы её утром в 05:40 — уже на следующий день.
  const targetDate = SHIFT_TYPE === 'night' ? localDateStr(-1) : localDateStr(0);
  // Для ночной смены запись могла быть внесена под любую из двух дат
  const entryDateCandidates = SHIFT_TYPE === 'night'
    ? [targetDate, localDateStr(0)]
    : [targetDate];

  console.log(`Целевая дата графика: ${targetDate}`);
  console.log(`Даты для поиска записей: ${entryDateCandidates.join(', ')}`);

  // Читаем все бригады одним запросом
  const brigades = await fbGet('brigades');
  if (!brigades) {
    console.log('Бригад в базе нет — нечего проверять.');
    return;
  }

  let totalSent = 0;
  let totalSkipped = 0;

  for (const code of Object.keys(brigades)) {
    const b = brigades[code] || {};
    const workers = b.workers || [];
    const schedule = b.schedule || {};
    const entries = b.entries || {};
    const telegramIds = b.telegramIds || {};
    const reminded = b.reminded || {};

    if (workers.length === 0) continue;

    const daySched = schedule[targetDate] || {};
    console.log(`\nБригада ${code}: ${workers.length} работников, график на ${targetDate}: ${JSON.stringify(daySched)}`);

    for (const worker of workers) {
      const shiftId = daySched[worker];
      if (shiftId !== SHIFT_TYPE) continue; // не та смена или нет смены

      const key = sanitizeKey(worker);
      const chatId = telegramIds[key];

      if (!chatId) {
        console.log(`  ${worker}: смена ${SHIFT_TYPE}, но нет Telegram ID — пропускаем`);
        totalSkipped++;
        continue;
      }

      // Проверяем, не отправляли ли уже напоминание
      const remindedKey = `${targetDate}_${SHIFT_TYPE}_${key}`;
      if (reminded[remindedKey]) {
        console.log(`  ${worker}: уже напоминали (${remindedKey}) — пропускаем`);
        continue;
      }

      // Проверяем, есть ли записи за эту смену
      const entriesList = entries ? Object.values(entries) : [];
      const hasEntries = entryDateCandidates.some(d =>
        entriesList.some(e => e.worker === worker && e.date === d)
      );

      const endTime = SHIFT_TYPE === 'day' ? '19:00' : '07:00';
      const shiftName = SHIFT_TYPE === 'day' ? 'Дневная' : 'Ночная';

      const text = hasEntries
        ? `<b>⏰ ${shiftName} смена заканчивается в ${endTime}</b>\n`
          + `Осталось около 1 часа 20 минут.\n\n`
          + `✅ Вы уже внесли данные по сделке за сегодня.\n`
          + `Пожалуйста, перепроверьте ваши записи — всё ли верно?\n\n`
          + `Открыть приложение → «📝 Ввод»`
        : `<b>⏰ ${shiftName} смена заканчивается в ${endTime}</b>\n`
          + `Осталось около 1 часа 20 минут.\n\n`
          + `❗️ Вы ещё не внесли данные по сделке за смену.\n`
          + `Откройте приложение и добавьте записи, пока смена не закончилась.\n\n`
          + `Открыть приложение → «📝 Ввод»`;

      console.log(`  ${worker}: отправка (записи: ${hasEntries ? 'есть' : 'нет'})...`);
      const ok = await sendTelegramMessage(chatId, text);

      if (ok) {
        console.log(`  ✅ Напоминание отправлено: ${worker}`);
        await fbPut(`brigades/${code}/reminded/${remindedKey}`, true);
        totalSent++;
        // Задержка 500мс, чтобы Telegram не заблокировал
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.error(`  ❌ Ошибка отправки: ${worker}`);
      }
    }
  }

  console.log(`\n=== ИТОГ: отправлено ${totalSent}, пропущено ${totalSkipped} ===`);
}

main().catch(err => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
