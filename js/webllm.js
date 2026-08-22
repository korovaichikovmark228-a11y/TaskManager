/* ============================================================
   webllm.js — умный разбор задач локальной моделью прямо в браузере
   (WebLLM + WebGPU). Полностью на устройстве: после первой загрузки
   модели интернет не нужен — веса лежат в кэше браузера.
   Бесплатно, без внешних API. При отсутствии WebGPU или незагруженной
   модели вызывающий код откатывается на rule-based Parser.

   Библиотека грузится с CDN один раз (кэшируется Service Worker'ом),
   веса модели скачивает и кэширует сам WebLLM.
   ============================================================ */
(function (global) {
  'use strict';

  const CDN = 'https://esm.run/@mlc-ai/web-llm';

  // Модели MLC (q4f32 — совместимо с WebGPU без shader-f16, напр. Safari).
  const MODELS = {
    'qwen2.5-1.5b': 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    'qwen2.5-0.5b': 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    'llama3.2-1b': 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
  };
  const DEFAULT_MODEL = 'qwen2.5-1.5b';

  let engine = null;
  let loadedModelId = null;
  let loading = null;

  function isSupported() { return typeof navigator !== 'undefined' && !!navigator.gpu; }
  function isReady() { return !!engine; }
  function isLoading() { return !!loading; }
  function currentModel() { return loadedModelId; }
  function resolveModel(key) { return MODELS[key] || key || MODELS[DEFAULT_MODEL]; }

  // Загрузка (скачивание при первом разе) движка и модели.
  // onProgress({progress:0..1, text}) — для полосы прогресса.
  async function load(modelKey, onProgress) {
    if (!isSupported()) throw new Error('WebGPU не поддерживается этим браузером');
    const modelId = resolveModel(modelKey);
    if (engine && loadedModelId === modelId) return engine;
    if (loading) return loading;

    loading = (async () => {
      const webllm = await import(/* @vite-ignore */ CDN);
      if (engine) { try { await engine.unload(); } catch (e) {} engine = null; }
      engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (r) => { if (onProgress) onProgress({ progress: r.progress || 0, text: r.text || '' }); },
      });
      loadedModelId = modelId;
      return engine;
    })();
    try { return await loading; }
    finally { loading = null; }
  }

  async function unload() {
    if (engine) { try { await engine.unload(); } catch (e) {} }
    engine = null; loadedModelId = null;
  }

  function buildMessages(raw, sections) {
    const secLines = sections.map((s) =>
      `- id="${s.id}" — «${s.name}» (${(s.keywords || []).slice(0, 8).join(', ')})`).join('\n');
    const d = new Date();
    const todayISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sys = [
      'Ты — парсер задач для личного планировщика. Пользователь надиктовал текст в свободной речи',
      '(возможны слова-паразиты: «вот», «там», «типа», «ну», «потом»). Раздели его на отдельные',
      'атомарные задачи. Для каждой задачи верни суть без служебных слов и вводных оборотов',
      '(«мне нужно», «дали задачу», «у меня есть»), определи раздел, важность и срок.',
      '',
      'Обороты «по работе/проекту/сообществу/личному», «потом», «затем», «а ещё»',
      'ВСЕГДА начинают НОВУЮ задачу — не объединяй разные дела в одну.',
      '',
      'Разделы (используй только эти id):',
      secLines,
      '',
      `Сегодня ${todayISO}. "due": YYYY-MM-DD, либо YYYY-MM-DDTHH:MM если названо время, либо null.`,
      '"priority": "high" (срочно/важно/горит), "low" (не срочно/потом/низкий), иначе "medium".',
      'Пример: «по проекту сделать ревью кода по сообществу написать пост» →',
      '{"tasks":[{"text":"Сделать ревью кода","section_id":"project","priority":"medium","due":null},{"text":"Написать пост","section_id":"community","priority":"medium","due":null}]}',
      'Верни ТОЛЬКО JSON: {"tasks":[{"text":"...","section_id":"...","priority":"medium","due":null}]}',
    ].join('\n');
    return [
      { role: 'system', content: sys },
      { role: 'user', content: raw },
    ];
  }

  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  function extractJson(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
    return null;
  }
  function normalize(parsed, sections) {
    if (!parsed || !Array.isArray(parsed.tasks)) return [];
    const ids = new Set(sections.map((s) => s.id));
    const fb = (sections[sections.length - 1] || sections[0] || {}).id;
    const out = [];
    for (const it of parsed.tasks) {
      const text = (it && typeof it.text === 'string') ? it.text.trim() : '';
      if (!text) continue;
      // Доверяем разделу от модели; правила — только запас, если id невалиден.
      let sectionId;
      if (ids.has(it.section_id)) sectionId = it.section_id;
      else {
        const byName = sections.find((s) => s.name.toLowerCase() === String(it.section_id || '').toLowerCase());
        sectionId = byName ? byName.id : ((global.Parser && Parser.detectSection(text, sections)) || {}).id || fb;
      }
      let priority = it.priority;
      if (priority !== 'high' && priority !== 'low' && priority !== 'medium') priority = 'medium';
      let due = null, time = null;
      if (typeof it.due === 'string') {
        const m = it.due.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (m) { due = m[1]; if (m[2]) time = m[2] + ':' + m[3]; }
      }
      if (typeof it.time === 'string' && !time) { const tm = it.time.match(/(\d{1,2}):(\d{2})/); if (tm) time = tm[1].padStart(2, '0') + ':' + tm[2]; }
      if (global.Parser) {
        if (!due) { const dd = (typeof it.due === 'string' && Parser.detectDate(it.due)) || Parser.detectDate(text); if (dd) due = dd.iso; }
        if (!time) { const t = Parser.detectTime(text); if (t) time = t.time; }
      }
      out.push({ text, sectionId, priority, due, time });
    }
    return out;
  }

  // Разбор. Требует уже загруженного движка (load()).
  // Без response_format (строгий JSON-грамматик тормозит/ломает мелкие модели) —
  // JSON вытаскиваем из ответа сами. С таймаутом: если модель зависла,
  // прерываем и даём вызывающему коду откатиться на правила.
  async function parse(raw, sections, opts) {
    if (!engine) throw new Error('Модель не загружена');
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 45000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { if (engine && engine.interruptGenerate) engine.interruptGenerate(); } catch (e) {}
        reject(new Error('таймаут ' + Math.round(timeoutMs / 1000) + 'с (модель слишком долго думает)'));
      }, timeoutMs);
    });
    const gen = engine.chat.completions.create({
      messages: buildMessages(raw, sections),
      temperature: 0.2,
      max_tokens: 700,
    });
    let reply;
    try { reply = await Promise.race([gen, timeout]); }
    finally { clearTimeout(timer); }
    const content = reply && reply.choices && reply.choices[0] && reply.choices[0].message.content;
    const drafts = normalize(extractJson(content), sections);
    if (drafts.length === 0) throw new Error('пустой разбор (модель ответила: «' + String(content || '').slice(0, 60) + '…»)');
    return drafts;
  }

  global.WebLLM = { isSupported, isReady, isLoading, currentModel, load, unload, parse, resolveModel, MODELS, DEFAULT_MODEL };
})(window);
