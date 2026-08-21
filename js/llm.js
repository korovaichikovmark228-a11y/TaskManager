/* ============================================================
   llm.js — необязательный «умный» разбор через локальную LLM (Ollama).
   Работает на своём компьютере/сервере, бесплатно, без внешних API.
   Если Ollama выключена, недоступна или ответила мусором — вызывающий
   код откатывается на rule-based Parser.parse (js/parser.js).

   Требования на стороне Ollama (один раз):
     ollama pull llama3.2          # или mistral, qwen2.5 и т.п.
     # чтобы браузер мог обращаться к серверу, разрешить CORS-origin:
     OLLAMA_ORIGINS='*' ollama serve
   ============================================================ */
(function (global) {
  'use strict';

  const DEFAULTS = { url: 'http://localhost:11434', model: 'llama3.2', enabled: false };

  function normUrl(u) {
    return (u || DEFAULTS.url).trim().replace(/\/+$/, '');
  }

  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function weekdayName() {
    return ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][new Date().getDay()];
  }

  function buildPrompt(raw, sections) {
    const secLines = sections.map((s) =>
      `- id="${s.id}" — «${s.name}» (относится к: ${(s.keywords || []).slice(0, 8).join(', ')})`
    ).join('\n');

    return [
      'Ты — парсер задач для личного планировщика. Пользователь надиктовал или написал текст.',
      'Раздели его на отдельные атомарные задачи и для каждой определи раздел, важность и срок.',
      '',
      'Доступные разделы (используй только эти id):',
      secLines,
      '',
      `Сегодня: ${todayISO()} (${weekdayName()}). Срок "due" отдавай строго в формате YYYY-MM-DD или null.`,
      'Важность "priority": "high" (срочно/важно/горит), "low" (не срочно/когда-нибудь) или "medium" (по умолчанию).',
      'В "text" оставляй только суть задачи, без служебных слов ("мне нужно", "по работе", названия срока).',
      'Если раздел неочевиден — выбери наиболее подходящий по смыслу.',
      '',
      'Верни СТРОГО JSON без пояснений вида:',
      '{"tasks":[{"text":"...","section_id":"...","priority":"medium","due":null}]}',
      '',
      'Текст пользователя:',
      raw,
    ].join('\n');
  }

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Приводит ответ модели к тому же формату, что и Parser.parse.
  function normalize(parsed, sections, raw) {
    if (!parsed || !Array.isArray(parsed.tasks)) return [];
    const validIds = new Set(sections.map((s) => s.id));
    const fallbackId = (sections[sections.length - 1] || sections[0] || {}).id;
    const out = [];
    for (const it of parsed.tasks) {
      let text = (it && typeof it.text === 'string') ? it.text.trim() : '';
      if (!text) continue;
      let sectionId = it.section_id;
      if (!validIds.has(sectionId)) {
        // модель могла вернуть название вместо id — попробуем сопоставить,
        // иначе доверимся rule-based определению раздела
        const byName = sections.find((s) => s.name.toLowerCase() === String(sectionId || '').toLowerCase());
        sectionId = byName ? byName.id
          : ((global.Parser && Parser.detectSection(text, sections)) || {}).id || fallbackId;
      }
      let priority = it.priority;
      if (priority !== 'high' && priority !== 'low' && priority !== 'medium') priority = 'medium';
      let due = it.due;
      if (typeof due !== 'string' || !ISO_RE.test(due)) {
        // подстрахуемся детерминированным парсером: сперва пробуем разобрать
        // саму строку (модель могла вернуть «завтра»), затем — текст задачи
        let d = null;
        if (global.Parser) {
          if (typeof due === 'string' && due.trim()) d = Parser.detectDate(due);
          if (!d) d = Parser.detectDate(text);
        }
        due = d ? d.iso : null;
      }
      out.push({ text, sectionId, priority, due });
    }
    return out;
  }

  // Достаёт JSON даже если модель обернула его в текст/```json блоки.
  function extractJson(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) {}
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
    }
    return null;
  }

  /* Главная функция. Возвращает массив черновиков задач или бросает ошибку.
     opts: { url, model, timeoutMs } */
  async function parse(raw, sections, opts) {
    opts = opts || {};
    const url = normUrl(opts.url);
    const model = (opts.model || DEFAULTS.model).trim();
    const timeoutMs = opts.timeoutMs || 20000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(url + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          prompt: buildPrompt(raw, sections),
          format: 'json',   // Ollama гарантирует валидный JSON
          stream: false,
          options: { temperature: 0.1 },
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error('Ollama HTTP ' + resp.status);
    const data = await resp.json();
    const parsed = extractJson(data.response);
    const drafts = normalize(parsed, sections, raw);
    if (drafts.length === 0) throw new Error('LLM вернула пустой разбор');
    return drafts;
  }

  // Быстрая проверка доступности сервера/модели (для настроек).
  async function ping(opts) {
    opts = opts || {};
    const url = normUrl(opts.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const resp = await fetch(url + '/api/tags', { signal: controller.signal });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const models = (data.models || []).map((m) => m.name);
      return { ok: true, models };
    } finally {
      clearTimeout(timer);
    }
  }

  global.LLM = { parse, ping, DEFAULTS };
})(window);
