/* ============================================================
   test-parser.js — набор тестов для rule-based парсера.
   Запуск:  node tools/test-parser.js
   Проверяет разбор дат, важности, разделов и деления на задачи.
   ============================================================ */
'use strict';
const Parser = require('../js/parser.js');

// Разделы как в приложении (js/app.js: DEFAULT_SECTIONS)
const SECTIONS = [
  { id: 'work', name: 'Работа', order: 0,
    keywords: ['работа', 'работе', 'работы', 'рабоч', 'офис', 'начальник', 'клиент', 'встреч', 'созвон', 'отчёт', 'отчет', 'презентац', 'дедлайн', 'коллег'] },
  { id: 'project', name: 'Свой проект', order: 1,
    keywords: ['проект', 'стартап', 'продукт', 'разработ', 'код', 'дизайн', 'лендинг', 'приложени', 'фича', 'релиз', 'mvp'] },
  { id: 'community', name: 'Сообщество', order: 2,
    keywords: ['сообществ', 'комьюнити', 'чат', 'канал', 'подписчик', 'контент', 'пост', 'эфир', 'вебинар', 'рассылк'] },
  { id: 'relationships', name: 'Отношения', order: 3,
    keywords: ['отношени', 'жена', 'муж', 'девушк', 'свидани', 'семь', 'мама', 'папа', 'родител', 'друз', 'друг', 'подар'] },
  { id: 'personal', name: 'Личное', order: 4,
    keywords: ['личное', 'здоровь', 'спорт', 'зал', 'врач', 'покуп', 'дом', 'быт', 'финанс', 'деньг', 'книг', 'учеб', 'хобби', 'отдых'] },
];

// --- мини-фреймворк ---
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) { check(name, got === want, `получено ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`); }

// --- ожидаемые даты относительно «сегодня» ---
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function todayPlus(days) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days); return iso(d); }
function nextDow(dow) { const d = new Date(); d.setHours(0, 0, 0, 0); let diff = (dow - d.getDay() + 7) % 7; if (diff === 0) diff = 7; d.setDate(d.getDate() + diff); return iso(d); }
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------------- ДАТЫ ---------------- */
eq('дата: сегодня', (Parser.detectDate('позвонить сегодня') || {}).iso, todayPlus(0));
eq('дата: завтра', (Parser.detectDate('купить завтра молоко') || {}).iso, todayPlus(1));
eq('дата: послезавтра', (Parser.detectDate('встреча послезавтра') || {}).iso, todayPlus(2));
eq('дата: через 3 дня', (Parser.detectDate('сделать через 3 дня') || {}).iso, todayPlus(3));
eq('дата: через день', (Parser.detectDate('напомнить через день') || {}).iso, todayPlus(1));
eq('дата: через неделю', (Parser.detectDate('через неделю отпуск') || {}).iso, todayPlus(7));
eq('дата: через 2 недели', (Parser.detectDate('через 2 недели') || {}).iso, todayPlus(14));
eq('дата: к пятнице', (Parser.detectDate('отчёт к пятнице') || {}).iso, nextDow(5));
eq('дата: в понедельник', (Parser.detectDate('созвон в понедельник') || {}).iso, nextDow(1));
eq('дата: во вторник', (Parser.detectDate('во вторник к врачу') || {}).iso, nextDow(2));
eq('дата: на выходных', (Parser.detectDate('отдохнуть на выходных') || {}).iso, nextDow(6));
check('дата: нет срока → null', Parser.detectDate('просто задача без срока') === null);

/* ---------------- ВАЖНОСТЬ ---------------- */
eq('важность: срочно → high', Parser.detectPriority('сделать срочно').priority, 'high');
eq('важность: важно → high', Parser.detectPriority('это важно').priority, 'high');
eq('важность: не срочно → low', Parser.detectPriority('это не срочно').priority, 'low');
eq('важность: когда-нибудь → low', Parser.detectPriority('прочитать когда-нибудь').priority, 'low');
eq('важность: по умолчанию → medium', Parser.detectPriority('обычная задача').priority, 'medium');

/* ---------------- РАЗДЕЛЫ (в т.ч. морфология) ---------------- */
const secId = (txt) => (Parser.detectSection(txt, SECTIONS) || {}).id;
eq('раздел: работа', secId('позвонить клиенту'), 'work');
eq('раздел: морфология «на работе»', secId('задержаться на работе'), 'work');
eq('раздел: морфология «поработать»', secId('поработать над задачей'), 'work');
eq('раздел: проект/код', secId('пофиксить код в проекте'), 'project');
eq('раздел: личное/врач', secId('записаться к врачу'), 'personal');
eq('раздел: спорт → личное', secId('сходить в зал'), 'personal');
eq('раздел: отношения/жена', secId('купить подарок жене'), 'relationships');
eq('раздел: сообщество/пост', secId('написать пост в канал'), 'community');

/* ---------------- ДЕЛЕНИЕ НА ЗАДАЧИ ---------------- */
const t1 = Parser.parse('позвонить клиенту завтра срочно, купить продукты', SECTIONS);
eq('split: две задачи по запятой', t1.length, 2);
eq('split: первая — раздел work', t1[0].sectionId, 'work');
eq('split: первая — high', t1[0].priority, 'high');
eq('split: первая — срок завтра', t1[0].due, todayPlus(1));
check('split: из текста вырезаны служебные слова',
  !/срочно|завтра/i.test(t1[0].text), 'text=' + JSON.stringify(t1[0].text));

const t2 = Parser.parse('сделать отчёт и позвонить маме, потом сходить в зал', SECTIONS);
check('split: коннектор «потом» делит', t2.length >= 2, 'кол-во=' + t2.length);

const t3 = Parser.parse('пустой ввод разберётся как одна задача', SECTIONS);
eq('parse: одна задача когда нет разделителей', t3.length, 1);

/* ---------------- ЧИСТОТА ТЕКСТА ---------------- */
check('текст: с заглавной буквы', /^[А-ЯЁA-Z]/.test(t1[0].text), 'text=' + JSON.stringify(t1[0].text));
check('текст: без осиротевшей пунктуации',
  !/\s[,;:]|[,;:]{2,}/.test(t1[0].text), 'text=' + JSON.stringify(t1[0].text));
check('текст: все задачи непустые и ISO-срок валиден',
  t1.every((x) => x.text.length > 0 && (x.due === null || ISO_RE.test(x.due))));

/* ---------------- ИТОГ ---------------- */
console.log(`\nПройдено: ${pass}, провалено: ${fail}`);
if (fail) {
  console.log('\nПровалы:');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✓ Все тесты парсера пройдены.');
