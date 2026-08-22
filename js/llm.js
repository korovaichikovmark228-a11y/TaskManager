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
      `Сегодня: ${todayISO()} (${weekdayName()}). Срок "due": YYYY-MM-DD, либо YYYY-MM-DDTHH:MM если названо время, либо null.`,
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
      // Раздел определяется ключевыми словами пользователя — доверяем правилам,
      // если они нашли раздел; иначе берём выбор модели.
      let sectionId;
      const ruleSec = global.Parser && Parser.detectSection(text, sections);
      if (ruleSec) sectionId = ruleSec.id;
      else if (validIds.has(it.section_id)) sectionId = it.section_id;
      else {
        const byName = sections.find((s) => s.name.toLowerCase() === String(it.section_id || '').toLowerCase());
        sectionId = byName ? byName.id : fallbackId;
      }
      let priority = it.priority;
      if (priority !== 'high' && priority !== 'low' && priority !== 'medium') priority = 'medium';
      // due может прийти как «YYYY-MM-DD» или «YYYY-MM-DDTHH:MM» — разбираем оба
      let due = null, time = null;
      if (typeof it.due === 'string') {
        const m = it.due.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (m) { due = m[1]; if (m[2]) time = m[2] + ':' + m[3]; }
      }
      if (typeof it.time === 'string' && !time) { const tm = it.time.match(/(\d{1,2}):(\d{2})/); if (tm) time = tm[1].padStart(2, '0') + ':' + tm[2]; }
      // подстраховка детерминированным парсером (модель могла сказать «завтра»)
      if (global.Parser) {
        if (!due) { const d = (typeof it.due === 'string' && Parser.detectDate(it.due)) || Parser.detectDate(text); if (d) due = d.iso; }
        if (!time) { const t = Parser.detectTime(text); if (t) time = t.time; }
      }
      out.push({ text, sectionId, priority, due, time });
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

  // ===== Облачная модель (OpenAI-совместимый API: OpenRouter, Groq и т.п.) =====
  const CLOUD_DEFAULTS = {
    url: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-4-31b-it:free',
  };

  function chatHeaders(apiKey) {
    // Только простые заголовки — иначе кастомные (HTTP-Referer/X-Title) ломают
    // CORS-preflight из браузера (fetch падает с TypeError).
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h['Authorization'] = 'Bearer ' + apiKey.trim();
    return h;
  }

  /* Разбор через облачную модель. opts: {url, apiKey, model, timeoutMs} */
  async function parseCloud(raw, sections, opts) {
    opts = opts || {};
    const url = normUrl(opts.url || CLOUD_DEFAULTS.url);
    const model = (opts.model || CLOUD_DEFAULTS.model).trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 30000);
    let resp;
    try {
      resp = await fetch(url + '/chat/completions', {
        method: 'POST',
        headers: chatHeaders(opts.apiKey),
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Ты — парсер задач. Отвечай СТРОГО одним JSON-объектом, без пояснений.' },
            { role: 'user', content: buildPrompt(raw, sections) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const e = await resp.json(); if (e.error && e.error.message) msg = e.error.message; } catch (e) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const drafts = normalize(extractJson(content), sections, raw);
    if (drafts.length === 0) throw new Error('Модель вернула пустой разбор');
    return drafts;
  }

  // Проверка связи и ключа (для настроек): тот же путь, что и реальный разбор
  // (минимальный chat/completions), чтобы гарантировать, что и разбор пройдёт.
  async function pingCloud(opts) {
    opts = opts || {};
    const url = normUrl(opts.url || CLOUD_DEFAULTS.url);
    const model = (opts.model || CLOUD_DEFAULTS.model).trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let resp;
    try {
      resp = await fetch(url + '/chat/completions', {
        method: 'POST', headers: chatHeaders(opts.apiKey), signal: controller.signal,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const e = await resp.json(); if (e.error && e.error.message) msg = e.error.message; } catch (e) {}
      throw new Error(msg);
    }
    return { ok: true };
  }

  global.LLM = { parse, ping, parseCloud, pingCloud, DEFAULTS, CLOUD_DEFAULTS };
})(window);
