/* ============================================================
   parser.js — rule-based разбор ввода на задачи (RU)
   Делит текст на задачи, определяет раздел, срок и важность.
   Никаких внешних сервисов — только правила и словари.
   ============================================================ */
(function (global) {
  'use strict';

  // --- Ключевые слова важности ---
  const HIGH = ['срочно', 'срочное', 'срочная', 'важно', 'важное', 'важная', 'горит',
    'критично', 'критичн', 'обязательно', 'кровь из носа', 'asap', 'аврал', 'немедленно', 'первым делом'];
  const LOW = ['не горит', 'не срочно', 'несрочно', 'когда-нибудь', 'когда нибудь',
    'не важно', 'неважно', 'на досуге', 'если будет время', 'потом как-нибудь', 'low', 'без спешки'];

  // --- Коннекторы для разбиения (длинные — раньше) ---
  const CONNECTORS = [
    'а также', 'и ещё', 'а ещё', 'и еще', 'а еще', 'плюс ещё', 'плюс еще',
    'а потом', 'и потом', 'потом ещё', 'потом еще',
    'также', 'плюс', 'затем', 'потом'
  ];

  // Дни недели (все склонения → индекс 0=Пн … 6=Вс, JS: 0=Вс)
  const WEEKDAYS = {
    'понедельник': 1, 'понедельника': 1, 'понедельнику': 1,
    'вторник': 2, 'вторника': 2, 'вторнику': 2,
    'среда': 3, 'среду': 3, 'среды': 3, 'среде': 3,
    'четверг': 4, 'четверга': 4, 'четвергу': 4,
    'пятница': 5, 'пятницу': 5, 'пятницы': 5, 'пятнице': 5,
    'суббота': 6, 'субботу': 6, 'субботы': 6, 'субботе': 6,
    'воскресенье': 0, 'воскресенью': 0, 'воскресенья': 0
  };

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function nextWeekday(targetDow) {
    const d = today();
    const cur = d.getDay();
    let diff = (targetDow - cur + 7) % 7;
    if (diff === 0) diff = 7; // «в пятницу», когда сегодня пятница → следующая
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Границы слова для кириллицы: JS-`\b` работает только с ASCII (\w), поэтому
  // рядом с русскими буквами он никогда не срабатывает. Используем lookaround
  // по набору «буква/цифра» (кириллица + латиница + цифры).
  const LB = '(?<![а-яёa-z0-9])'; // левая граница
  const RB = '(?![а-яёa-z0-9])';  // правая граница

  // --- Определение срока. Возвращает {iso, matched} или null ---
  function detectDate(text) {
    const t = text.toLowerCase();

    // относительные слова (порядок: длинные раньше)
    const rel = [
      { re: new RegExp(LB + 'послезавтра' + RB), days: 2 },
      { re: new RegExp(LB + 'завтра' + RB), days: 1 },
      { re: new RegExp(LB + 'сегодня' + RB), days: 0 },
    ];
    for (const r of rel) {
      const m = t.match(r.re);
      if (m) {
        const d = today(); d.setDate(d.getDate() + r.days);
        return { iso: toISO(d), matched: m[0] };
      }
    }

    // «через N дней/недель/месяцев»
    let m = t.match(new RegExp('через\\s+(\\d+)?\\s*(день|дня|дней|недел[юяией]+|месяц[аев]*)' + RB));
    if (m) {
      const n = m[1] ? parseInt(m[1], 10) : 1;
      const d = today();
      const unit = m[2];
      if (unit.startsWith('недел')) d.setDate(d.getDate() + n * 7);
      else if (unit.startsWith('месяц')) d.setMonth(d.getMonth() + n);
      else d.setDate(d.getDate() + n);
      return { iso: toISO(d), matched: m[0] };
    }

    // «на выходных / на выходные» → ближайшая суббота
    const wknd = t.match(/на\s+выходн[а-яё]*/);
    if (wknd) {
      return { iso: toISO(nextWeekday(6)), matched: wknd[0] };
    }

    // «к пятнице», «в пятницу», «во вторник», «до понедельника»
    m = t.match(new RegExp(LB + '(?:к|ко|в|во|до|на)\\s+([а-яё]+)' + RB));
    if (m && WEEKDAYS.hasOwnProperty(m[1])) {
      return { iso: toISO(nextWeekday(WEEKDAYS[m[1]])), matched: m[0] };
    }
    // просто название дня недели без предлога
    for (const w in WEEKDAYS) {
      const re = new RegExp(LB + w + RB);
      if (re.test(t)) return { iso: toISO(nextWeekday(WEEKDAYS[w])), matched: w };
    }

    return null;
  }

  // --- Определение важности ---
  function detectPriority(text) {
    const t = text.toLowerCase();
    for (const w of LOW) if (t.includes(w)) return { priority: 'low', matched: w };
    for (const w of HIGH) if (t.includes(w)) return { priority: 'high', matched: w };
    return { priority: 'medium', matched: null };
  }

  // --- Определение раздела по словарю ключевых слов ---
  function detectSection(text, sections) {
    const t = text.toLowerCase();
    let best = null, bestScore = 0;
    for (const s of sections) {
      let score = 0;
      for (const kw of (s.keywords || [])) {
        const k = kw.trim().toLowerCase();
        if (!k) continue;
        if (t.includes(k)) score += k.length; // длинное совпадение весомее
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best; // может быть null → назначим позже дефолт
  }

  // --- Разбиение сырого ввода на отдельные задачи ---
  function splitTasks(raw, sections) {
    let text = ' ' + raw.replace(/\s+/g, ' ').trim() + ' ';

    // 1) вставляем разделитель перед маркером «по <раздел>» (кроме начала)
    for (const s of sections) {
      for (const kw of (s.keywords || [])) {
        const k = kw.trim().toLowerCase();
        if (k.length < 4) continue;
        const re = new RegExp('(.)\\s(по\\s+' + escapeRe(k) + ')', 'gi');
        text = text.replace(re, (mm, before, marker) => {
          if (/[.,;!]/.test(before)) return mm; // уже есть граница
          return before + ' ||| ' + marker;
        });
      }
    }

    // 2) коннекторы → разделитель
    for (const c of CONNECTORS) {
      const re = new RegExp('\\s' + escapeRe(c) + '\\s', 'gi');
      text = text.replace(re, ' ||| ');
    }

    // 3) сильные знаки препинания и переводы строк
    text = text.replace(/[.;!\n]+/g, ' ||| ');

    // 4) запятая — мягкий разделитель: режем, только если после неё идёт
    //    маркер «по …» или глагол-действие в начале
    text = text.replace(/,\s*(?=по\s+[а-яё]|нужно|надо|сделать|позвонить|написать|купить|отправить|встретить|запланировать|проверить)/gi, ' ||| ');

    return text.split('|||').map((s) => s.trim()).filter((s) => s.length > 1);
  }

  // --- Чистим текст задачи от служебных слов ---
  function cleanText(text, dateMatch, prioMatch, sections) {
    let t = text;
    // убрать префикс «по <раздел>»
    for (const s of sections) {
      for (const kw of (s.keywords || [])) {
        const k = kw.trim();
        if (k.length < 4) continue;
        t = t.replace(new RegExp('^по\\s+' + escapeRe(k) + '\\s*[:—-]?\\s*', 'i'), '');
      }
    }
    // убрать совпадение даты
    if (dateMatch) t = t.replace(new RegExp('\\s*' + escapeRe(dateMatch) + '\\s*', 'i'), ' ');
    // убрать маркер важности
    if (prioMatch) t = t.replace(new RegExp('\\s*' + escapeRe(prioMatch) + '\\s*', 'i'), ' ');
    // убрать ведущие «нужно/надо/мне»
    t = t.replace(/^(мне\s+)?(нужно|надо|нужно бы|стоит)\s+/i, '');
    // подчистить осиротевшую пунктуацию после вырезанных слов срока/важности
    t = t.replace(/\s+([,;:])/g, '$1').replace(/([,;:])\s*(?=[,;:])/g, '');
    t = t.replace(/\s+/g, ' ').replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').trim();
    if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  }

  // --- Главная функция ---
  function parse(raw, sections) {
    if (!raw || !raw.trim()) return [];
    const chunks = splitTasks(raw, sections);
    const defaultSection = sections[sections.length - 1] || sections[0];
    const result = [];
    for (const chunk of chunks) {
      const dateRes = detectDate(chunk);
      const prioRes = detectPriority(chunk);
      const section = detectSection(chunk, sections) || defaultSection;
      const text = cleanText(chunk, dateRes && dateRes.matched, prioRes.matched, sections);
      if (!text) continue;
      result.push({
        text,
        sectionId: section.id,
        priority: prioRes.priority,
        due: dateRes ? dateRes.iso : null,
      });
    }
    // если ничего не распозналось как отдельные задачи — вернуть одну целиком
    if (result.length === 0) {
      const dateRes = detectDate(raw);
      const prioRes = detectPriority(raw);
      const section = detectSection(raw, sections) || defaultSection;
      result.push({
        text: cleanText(raw.trim(), dateRes && dateRes.matched, prioRes.matched, sections) || raw.trim(),
        sectionId: section.id,
        priority: prioRes.priority,
        due: dateRes ? dateRes.iso : null,
      });
    }
    return result;
  }

  global.Parser = { parse, detectDate, detectPriority, detectSection, splitTasks };
})(window);
