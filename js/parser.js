/* ============================================================
   parser.js — rule-based разбор ввода на задачи (RU)
   Делит текст на задачи, определяет раздел, срок и важность.
   Заточен под живую диктовку: терпит слова-паразиты («вот», «там»,
   «типа», «ну»), вводные обороты («мне нужно», «дали задачу»,
   «у меня есть») и градации важности («чуть менее срочно» → средне).
   Никаких внешних сервисов — только правила и словари.
   ============================================================ */
(function (global) {
  'use strict';

  // --- Важность. Порядок проверки: MEDIUM-обороты → LOW → HIGH ---
  // («менее срочно» должно давать средний, хотя содержит «срочно»;
  //  «не срочно» — низкий, хотя содержит «срочно»; поэтому HIGH последним.)
  const PRIO_MEDIUM = ['чуть менее срочно', 'чуть-чуть менее срочно', 'менее срочно',
    'не сильно срочно', 'средний приоритет', 'средней важности', 'средне', 'умеренно'];
  const LOW = ['не очень срочно', 'не очень важно', 'не срочно', 'несрочно', 'низкий приоритет',
    'низкий', 'не важно', 'неважно', 'не горит', 'когда-нибудь', 'когда нибудь', 'на досуге',
    'если будет время', 'потом как-нибудь', 'без спешки', 'не к спеху', 'не очень', 'по возможности'];
  const HIGH = ['очень срочно', 'супер срочно', 'срочно', 'срочное', 'срочная', 'очень важно',
    'важно', 'важное', 'важная', 'горит', 'критично', 'критичн', 'высокий приоритет',
    'первым делом', 'обязательно', 'кровь из носа', 'asap', 'аврал', 'немедленно'];
  // Все маркеры важности — для вычистки из заголовка (длинные раньше)
  const PRIO_ALL = [].concat(PRIO_MEDIUM, LOW, HIGH, ['приоритет']).sort((a, b) => b.length - a.length);

  // --- Коннекторы-разделители задач (длинные — раньше) ---
  const CONNECTORS = ['после этого', 'а потом', 'и потом', 'потом ещё', 'потом еще',
    'а также', 'а ещё', 'и ещё', 'а еще', 'и еще', 'плюс ещё', 'плюс еще',
    'затем', 'далее', 'потом', 'также', 'плюс', 'ещё', 'еще'];

  // Глаголы-действия — по ним режем по запятой и опознаём начало задачи
  const VERBS = ['погулять', 'разобрать', 'структурировать', 'внести', 'договориться',
    'написать', 'купить', 'позвонить', 'сделать', 'отправить', 'встретить', 'встретиться',
    'запланировать', 'проверить', 'забрать', 'оплатить', 'записаться', 'сходить', 'заехать',
    'подготовить', 'закончить', 'доделать', 'починить', 'заказать', 'убрать', 'помыть',
    'переделать', 'переписать', 'обновить', 'добавить', 'настроить', 'разработать',
    'собрать', 'организовать', 'обсудить', 'ответить', 'прочитать', 'изучить', 'создать'];

  // Слова-паразиты (вычищаются как отдельные слова)
  const FILLERS = ['вот', 'там', 'ну', 'типа', 'прям', 'прямо', 'короче', 'сейчас', 'щас', 'счас',
    'тоже', 'допустим', 'это', 'такой', 'такую', 'такая', 'такое', 'чуть-чуть', 'чуть чуть', 'чуть',
    'мне', 'просто', 'как-то', 'вообще', 'блин', 'будет', 'собственно', 'так скажем', 'скажем', 'вроде'];

  // Вводные обороты (вырезаются целиком; длинные — раньше)
  const INTRO = ['мне сейчас', 'мне дали такую задачу', 'мне дали задачу', 'дали такую задачу',
    'дал мне такую задачу', 'дал мне задачу', 'дал такую задачу', 'дали задачу', 'дал задачу',
    'мне дали', 'мне дал', 'у меня есть задача', 'у меня была задача', 'у меня стоит задача',
    'у меня есть', 'есть задача', 'стоит задача', 'мне нужно бы', 'мне нужно', 'мне надо',
    'нужно бы', 'у меня', 'нужно', 'надо', 'как бы', 'тоже задача', 'задачу', 'задача', 'дело'];

  // Хвостовые обороты
  const TAILS = ['и так далее', 'и т д', 'и тд', 'и прочее', 'и всё такое'];

  // Дни недели (все склонения → индекс 0=Вс … 6=Сб, JS-стиль)
  const WEEKDAYS = {
    'понедельник': 1, 'понедельника': 1, 'понедельнику': 1,
    'вторник': 2, 'вторника': 2, 'вторнику': 2,
    'среда': 3, 'среду': 3, 'среды': 3, 'среде': 3,
    'четверг': 4, 'четверга': 4, 'четвергу': 4,
    'пятница': 5, 'пятницу': 5, 'пятницы': 5, 'пятнице': 5,
    'суббота': 6, 'субботу': 6, 'субботы': 6, 'субботе': 6,
    'воскресенье': 0, 'воскресенью': 0, 'воскресенья': 0
  };

  // между «по» и названием раздела могут стоять служебные слова:
  // «по поводу проекта», «по своему проекту», «а по поводу личного»
  const POBRIDGE = '(?:поводу\\s+|про\\s+|своему\\s+|своей\\s+|моему\\s+|моей\\s+|нашему\\s+|нашей\\s+|этому\\s+)?';

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function toISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }
  function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function nextWeekday(targetDow) {
    const d = today();
    let diff = (targetDow - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Границы слова для кириллицы (JS `\b` с кириллицей не работает).
  const LB = '(?<![а-яёa-z0-9])';
  const RB = '(?![а-яёa-z0-9])';

  // --- Определение срока. Возвращает {iso, matched} или null ---
  function detectDate(text) {
    const t = text.toLowerCase();
    const rel = [
      { re: new RegExp(LB + 'послезавтра' + RB), days: 2 },
      { re: new RegExp(LB + 'завтра' + RB), days: 1 },
      { re: new RegExp(LB + 'сегодня' + RB), days: 0 },
    ];
    for (const r of rel) {
      const m = t.match(r.re);
      if (m) { const d = today(); d.setDate(d.getDate() + r.days); return { iso: toISO(d), matched: m[0] }; }
    }
    let m = t.match(new RegExp('через\\s+(\\d+)?\\s*(день|дня|дней|недел[юяией]+|месяц[аев]*)' + RB));
    if (m) {
      const n = m[1] ? parseInt(m[1], 10) : 1;
      const d = today(); const unit = m[2];
      if (unit.startsWith('недел')) d.setDate(d.getDate() + n * 7);
      else if (unit.startsWith('месяц')) d.setMonth(d.getMonth() + n);
      else d.setDate(d.getDate() + n);
      return { iso: toISO(d), matched: m[0] };
    }
    const wknd = t.match(/на\s+выходн[а-яё]*/);
    if (wknd) return { iso: toISO(nextWeekday(6)), matched: wknd[0] };
    m = t.match(new RegExp(LB + '(?:к|ко|в|во|до|на)\\s+([а-яё]+)' + RB));
    if (m && WEEKDAYS.hasOwnProperty(m[1])) return { iso: toISO(nextWeekday(WEEKDAYS[m[1]])), matched: m[0] };
    for (const w in WEEKDAYS) {
      if (new RegExp(LB + w + RB).test(t)) return { iso: toISO(nextWeekday(WEEKDAYS[w])), matched: w };
    }
    return null;
  }

  // --- Определение времени: «в 13:00», «к 18», «в 9 утра», «в 6 вечера» ---
  function pad2(n) { return String(n).padStart(2, '0'); }
  function detectTime(text) {
    const t = text.toLowerCase();
    // ЧЧ:ММ (с необязательным предлогом)
    let m = t.match(new RegExp('(?:в|во|к|ко|на)?\\s*(\\d{1,2}):(\\d{2})' + RB));
    if (m) {
      const h = +m[1], mi = +m[2];
      if (h < 24 && mi < 60) return { time: pad2(h) + ':' + pad2(mi), matched: m[0].trim() };
    }
    // «в 13 часов», «в 9 утра», «в 6 вечера», «к 18»
    m = t.match(new RegExp(LB + '(?:в|во|к|ко|на)\\s+(\\d{1,2})\\s*(час[а-яё]*|утра|вечера|дня|ночи)?' + RB));
    if (m) {
      let h = +m[1]; const suf = m[2] || '';
      if (h <= 23) {
        if (/вечера|дня/.test(suf) && h < 12) h += 12;
        if (/ночи/.test(suf) && h === 12) h = 0;
        return { time: pad2(h) + ':00', matched: m[0].trim() };
      }
    }
    return null;
  }

  // --- Определение важности ---
  function detectPriority(text) {
    const t = text.toLowerCase();
    for (const w of PRIO_MEDIUM) if (t.includes(w)) return { priority: 'medium', matched: w };
    for (const w of LOW) if (t.includes(w)) return { priority: 'low', matched: w };
    for (const w of HIGH) if (t.includes(w)) return { priority: 'high', matched: w };
    return { priority: 'medium', matched: null };
  }

  // --- Лёгкий стеммер: сводит формы слова к основе ---
  const ENDINGS = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
    'ах', 'ях', 'ов', 'ев', 'ье', 'ья', 'ой', 'ей', 'ую', 'юю', 'ая', 'яя', 'ое', 'ее',
    'ать', 'ять', 'ить', 'еть', 'ы', 'и', 'а', 'я', 'у', 'ю', 'о', 'е', 'ь', 'й'];
  function stem(w) {
    w = w.toLowerCase();
    for (const e of ENDINGS) if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length);
    return w;
  }
  function tokenize(t) { return (t.toLowerCase().match(/[а-яёa-z0-9]+/g) || []); }

  // --- Определение раздела по словарю ключевых слов (с морфологией) ---
  function detectSection(text, sections) {
    const t = text.toLowerCase();
    const tokens = tokenize(t);
    const tokenStems = tokens.map(stem);
    let best = null, bestScore = 0;
    for (const s of sections) {
      let score = 0;
      for (const kw of (s.keywords || [])) {
        const k = kw.trim().toLowerCase();
        if (!k) continue;
        if (k.includes(' ')) { if (t.includes(k)) score += k.length + 2; continue; }
        if (t.includes(k)) { score += k.length; continue; }
        const ks = stem(k);
        if (ks.length < 3) continue;
        for (let i = 0; i < tokens.length; i++) {
          if (tokenStems[i] === ks || (ks.length >= 4 && tokens[i].startsWith(ks))) { score += ks.length; break; }
        }
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  // --- Разбиение сырого ввода на отдельные задачи ---
  function splitTasks(raw, sections) {
    let text = ' ' + raw.replace(/\s+/g, ' ').trim() + ' ';

    // 0) убрать хвостовые обороты до разбиения, иначе «далее» из «и так далее»
    //    съедается как коннектор
    text = stripAll(text, TAILS);
    text = ' ' + text.replace(/\s+/g, ' ').trim() + ' ';

    const verbAlt = VERBS.join('[а-яё]*|') + '[а-яё]*';

    // 1) разделитель перед маркером «по [поводу/своему] <раздел>» — начинает задачу.
    //    Матчим по основе слова, ловим формы: «по личному», «по поводу отношений».
    const seen = new Set();
    for (const s of sections) {
      for (const kw of (s.keywords || [])) {
        const st = stem(kw.trim().toLowerCase());
        if (st.length < 4 || seen.has(st)) continue;
        seen.add(st);
        // «по [поводу] <раздел>»
        text = text.replace(new RegExp('(.)\\s(по\\s+' + POBRIDGE + escapeRe(st) + '[а-яё]*)', 'gi'),
          (mm, before, marker) => /[.,;!]/.test(before) ? mm : before + ' ||| ' + marker);
        // голое название раздела перед глаголом: «Сообществе написать …»,
        // но НЕ когда это часть маркера «по/поводу <раздел>»
        if (st.length >= 6) {
          text = text.replace(new RegExp('(?<!по)(?<!поводу)(?<!про)(?<!своему)(?<!своей)(?<!моему)(?<!моей)\\s(' + escapeRe(st) + '[а-яё]*\\s+(?=(?:' + verbAlt + ')' + RB + '))', 'gi'),
            ' ||| $1');
        }
      }
    }
    // 2) коннекторы-разделители
    for (const c of CONNECTORS) {
      text = text.replace(new RegExp('\\s' + escapeRe(c) + '\\s', 'gi'), ' ||| ');
    }
    // 3) сильные знаки препинания и переводы строк
    text = text.replace(/[.;!\n]+/g, ' ||| ');
    // 4) запятая — мягкий разделитель перед маркером «по …» или глаголом
    text = text.replace(new RegExp(',\\s*(?=по\\s+[а-яё]|нужно|надо|' + verbAlt + ')', 'gi'), ' ||| ');
    // 5) «и/а + глагол-действие» → новая задача (купить хлеб И позвонить маме)
    text = text.replace(new RegExp('\\s[иа]\\s+(?=(?:' + verbAlt + ')' + RB + ')', 'gi'), ' ||| ');

    return text.split('|||').map((s) => s.trim()).filter((s) => s.length > 1);
  }

  // Удаляет из строки список слов/оборотов как отдельные единицы
  function stripAll(t, list) {
    for (const p of list) {
      const re = new RegExp(LB + escapeRe(p).replace(/\\?\s+/g, '\\s+') + RB, 'gi');
      t = t.replace(re, ' ');
    }
    return t;
  }

  // --- Чистим текст задачи от служебных слов ---
  function cleanText(text, dateMatch, prioMatch, sections, timeMatch) {
    let t = ' ' + text + ' ';

    // префикс «по <раздел>» (по основе: «по личному», «по работе»)
    for (const s of sections) {
      for (const kw of (s.keywords || [])) {
        const st = stem(kw.trim().toLowerCase());
        if (st.length < 4) continue;
        t = t.replace(new RegExp('(^|\\s)по\\s+' + POBRIDGE + escapeRe(st) + '[а-яё]*\\s*[:—-]?\\s*', 'i'), ' ');
        // голое название раздела в начале задачи: «Сообществе написать …»
        if (st.length >= 6) t = t.replace(new RegExp('^\\s*' + escapeRe(st) + '[а-яё]*\\s+(?=[а-яё])', 'i'), ' ');
      }
    }
    if (dateMatch) t = t.replace(new RegExp('\\s*' + escapeRe(dateMatch) + '\\s*', 'i'), ' ');
    if (timeMatch) t = t.replace(new RegExp('\\s*' + escapeRe(timeMatch) + '\\s*', 'i'), ' ');
    t = stripAll(t, PRIO_ALL);      // все маркеры важности, а не только сработавший

    t = stripAll(t, TAILS);         // хвосты «и так далее»
    t = stripAll(t, FILLERS);       // слова-паразиты
    t = t.replace(/\s+/g, ' ');
    t = stripAll(t, INTRO);         // вводные обороты («мне нужно», «у меня есть»)
    t = t.replace(/\s+/g, ' ');
    t = stripAll(t, FILLERS);       // второй проход (обороты могли обнажить паразитов)

    // убрать сдвоенный глагол в начале: «сделать написать …» → «написать …»
    const verbAlt = VERBS.join('[а-яё]*|') + '[а-яё]*';
    t = t.replace(new RegExp('^\\s*(?:сдела[а-яё]+)\\s+(?=(?:' + verbAlt + ')' + RB + ')', 'i'), ' ');

    // подчистить осиротевшую пунктуацию и края
    t = t.replace(/\s+([,;:])/g, '$1').replace(/([,;:])\s*(?=[,;:])/g, '');
    t = t.replace(/\s+/g, ' ').replace(/^[\s,;:—-]+|[\s,;:—-]+$/g, '').trim();
    // повисшие союзы по краям («…о встрече а» → «…о встрече»)
    t = t.replace(new RegExp('\\s+(?:а|и|но|да|же)$', 'i'), '').replace(new RegExp('^(?:а|и|но|да)\\s+', 'i'), '').trim();
    if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  }

  // Пустой/бессмысленный фрагмент (один предлог/союз, «по поводу» и т.п.)
  const JUNK = /^(?:по|по поводу|поводу|про|для|на|в|во|с|со|и|а|но|да|же|это)$/i;
  function isJunk(text) {
    if (!text || text.trim().length < 3) return true;
    return JUNK.test(text.trim());
  }

  // --- Главная функция ---
  function parse(raw, sections) {
    if (!raw || !raw.trim()) return [];
    const chunks = splitTasks(raw, sections);
    const defaultSection = sections[sections.length - 1] || sections[0];
    const result = [];
    for (const chunk of chunks) {
      const dateRes = detectDate(chunk);
      const timeRes = detectTime(chunk);
      const prioRes = detectPriority(chunk);
      const section = detectSection(chunk, sections) || defaultSection;
      const text = cleanText(chunk, dateRes && dateRes.matched, prioRes.matched, sections, timeRes && timeRes.matched);
      if (isJunk(text)) continue; // отбрасываем пустышки/предлоги
      const due = dateRes ? dateRes.iso : (timeRes ? toISO(today()) : null);
      result.push({ text, sectionId: section.id, priority: prioRes.priority, due, time: timeRes ? timeRes.time : null });
    }
    if (result.length === 0) {
      const dateRes = detectDate(raw);
      const timeRes = detectTime(raw);
      const prioRes = detectPriority(raw);
      const section = detectSection(raw, sections) || defaultSection;
      const text = cleanText(raw.trim(), dateRes && dateRes.matched, prioRes.matched, sections, timeRes && timeRes.matched) || raw.trim();
      const due = dateRes ? dateRes.iso : (timeRes ? toISO(today()) : null);
      result.push({ text, sectionId: section.id, priority: prioRes.priority, due, time: timeRes ? timeRes.time : null });
    }
    return result;
  }

  global.Parser = { parse, detectDate, detectTime, detectPriority, detectSection, splitTasks, stem };
})(typeof window !== 'undefined' ? window : globalThis);

// Node (тесты): позволяем require('js/parser.js')
if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window : globalThis).Parser;
