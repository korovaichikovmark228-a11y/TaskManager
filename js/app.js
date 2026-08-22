/* ============================================================
   app.js — связывает всё вместе: список, ввод, разбор, фокус,
   настройки, синхронизация, PWA.
   ============================================================ */
(function () {
  'use strict';

  const APP_VERSION = 'v30'; // держим в синхроне с CACHE в sw.js
  const $ = (id) => document.getElementById(id);

  // Показ любой ошибки прямо на экране (для диагностики на телефоне).
  function showFatal(msg) {
    try {
      const t = document.getElementById('toast');
      if (t) { t.textContent = '⚠ ' + msg; t.hidden = false; }
      else setTimeout(() => showFatal(msg), 300);
    } catch (e) {}
  }
  window.addEventListener('error', (e) => showFatal((e.message || 'ошибка') + ' @' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || '')));
  window.addEventListener('unhandledrejection', (e) => showFatal('promise: ' + ((e.reason && e.reason.message) || e.reason || '')));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const nowISO = () => new Date().toISOString();

  const PRIO_RANK = { high: 0, medium: 1, low: 2 };
  const PRIO_LABEL = { high: 'важно', medium: 'средне', low: 'не срочно' };

  const DEFAULT_SECTIONS = [
    { id: 'work', name: 'Работа', order: 0, color: '#ff6b6b',
      keywords: ['работа', 'работе', 'работы', 'рабоч', 'офис', 'начальник', 'руководител', 'босс', 'клиент', 'встреч', 'созвон', 'отчёт', 'отчет', 'презентац', 'дедлайн', 'коллег', 'проект по работе'] },
    { id: 'project', name: 'Свой проект', order: 1, color: '#8a6cff',
      keywords: ['проект', 'проекта', 'проекте', 'стартап', 'продукт', 'разработ', 'код', 'дизайн', 'лендинг', 'приложени', 'фича', 'релиз', 'mvp'] },
    { id: 'community', name: 'Сообщество', order: 2, color: '#35c67a',
      keywords: ['сообществ', 'комьюнити', 'чат', 'канал', 'подписчик', 'контент', 'пост', 'эфир', 'вебинар', 'участник', 'рассылк'] },
    { id: 'relationships', name: 'Отношения', order: 3, color: '#ff9f43',
      keywords: ['отношени', 'жена', 'муж', 'девушк', 'партнёр', 'партнер', 'свидани', 'семь', 'мама', 'папа', 'родител', 'друз', 'друг', 'подар'] },
    { id: 'personal', name: 'Личное', order: 4, color: '#56b3ff',
      keywords: ['личное', 'здоровь', 'спорт', 'зал', 'врач', 'покуп', 'дом', 'быт', 'финанс', 'деньг', 'книг', 'учеб', 'хобби', 'отдых'] },
  ];

  const state = {
    sections: [],
    tasks: [],
    filter: 'all', // 'all' | 'today' | 'overdue'
    settings: { workMin: 25, breakMin: 5, sbUrl: '', sbKey: '', sound: 'lofi', volume: 45,
      llmEnabled: false, llmUrl: 'http://localhost:11434', llmModel: 'llama3.2',
      webllmEnabled: false, webllmModel: 'qwen2.5-0.5b',
      cloudEnabled: false, cloudUrl: 'https://openrouter.ai/api/v1',
      cloudModel: 'google/gemma-4-31b-it:free', cloudKey: '',
      remindersEnabled: false },
  };

  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // Предикат текущего фильтра. «Сегодня» = срок ≤ сегодня (просроченные тоже),
  // «Просроченные» = срок < сегодня. В обоих видах выполненные скрыты.
  function matchesFilter(t) {
    if (state.filter === 'all') return true;
    if (t.done || !t.due) return false;
    const today = todayISO();
    if (state.filter === 'today') return t.due <= today;
    if (state.filter === 'overdue') return t.due < today;
    return true;
  }

  const timer = new Focus.Timer();
  const sound = new Focus.Soundscape();
  let focusTaskId = null;
  let reviewItems = [];      // черновики для экрана подтверждения
  let recognizer = null;
  let recognizing = false;

  /* ---------------- ЗАГРУЗКА ---------------- */
  async function boot() {
    await DB.open();
    // разделы
    let secs = await DB.getSections();
    if (!secs || secs.length === 0) {
      secs = DEFAULT_SECTIONS.slice();
      await DB.bulkPutSections(secs);
    }
    state.sections = secs.sort((a, b) => a.order - b.order);
    // настройки
    const saved = await DB.getMeta('settings', null);
    if (saved) state.settings = Object.assign(state.settings, saved);
    // миграция: старая бесплатная модель убрана из OpenRouter — переводим на рабочую
    if (state.settings.cloudModel === 'meta-llama/llama-3.3-70b-instruct:free') {
      state.settings.cloudModel = 'google/gemma-4-31b-it:free';
      await DB.setMeta('settings', state.settings);
    }
    // задачи
    state.tasks = (await DB.getTasks()).filter((t) => !t.deleted);

    timer.configure(state.settings.workMin, state.settings.breakMin);
    render();
    wire();
    registerSW();

    // авто-инициализация синхронизации
    if (state.settings.sbUrl && state.settings.sbKey) {
      Sync.init(state.settings.sbUrl, state.settings.sbKey)
        .then(() => { updateSyncBadge(); if (Sync.currentUser()) doSync(true); })
        .catch(() => updateSyncBadge('err'));
    }
    updateSyncBadge();
    window.addEventListener('online', () => { updateSyncBadge(); if (Sync.currentUser()) doSync(true); });
    window.addEventListener('offline', () => updateSyncBadge());
    // Модель на устройстве НЕ грузим автоматически на старте — только по
    // явному «Включить модель» в настройках. Так плашка не появляется сама.
    setModelLoading(false); // на всякий случай гасим баннер при запуске
    const ver = $('appVersion'); if (ver) ver.textContent = APP_VERSION;

    // напоминания: проверяем при запуске, раз в минуту и при возврате в приложение
    checkReminders();
    setInterval(checkReminders, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkReminders(); });
  }

  /* ---------------- МУЗЫКА (глобально) ---------------- */
  let musicPlaying = false;
  function openMusic() {
    const snd = (state.settings.sound && state.settings.sound !== 'none') ? state.settings.sound : 'lofi';
    $('musicSound').value = snd;
    $('musicVolume').value = state.settings.volume ?? 45;
    updateMusicToggle();
    $('musicOverlay').hidden = false;
  }
  function closeMusic() { $('musicOverlay').hidden = true; }
  function updateMusicToggle() {
    $('musicToggle').textContent = musicPlaying ? '⏹ Выключить' : '▶ Включить';
    $('btnMusic').classList.toggle('playing', musicPlaying);
  }
  function toggleMusic() {
    if (musicPlaying) {
      sound.stop(); musicPlaying = false;
    } else {
      const snd = $('musicSound').value || 'lofi';
      sound.setVolume((parseInt($('musicVolume').value, 10) || 45) / 100);
      sound.play(snd);
      state.settings.sound = snd;
      musicPlaying = true;
    }
    DB.setMeta('settings', state.settings);
    updateMusicToggle();
  }

  /* ---------------- ЛОКАЛЬНЫЕ НАПОМИНАНИЯ ---------------- */
  // Момент напоминания: дата + время (или 09:00, если время не задано).
  function reminderAt(t) {
    if (!t.due) return null;
    const time = (t.time && /^\d{2}:\d{2}$/.test(t.time)) ? t.time : '09:00';
    const d = new Date(t.due + 'T' + time + ':00');
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  function checkReminders() {
    if (!state.settings.remindersEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    for (const t of state.tasks) {
      if (t.done || t.deleted || t.notified || !t.due) continue;
      const at = reminderAt(t);
      if (at == null) continue;
      // наступило и не слишком давно (в пределах 12 ч), чтобы не сыпать старьём
      if (now >= at && now - at < 12 * 3600 * 1000) {
        fireReminder(t);
        t.notified = true;
        DB.putTask(t); // локальный флаг, без изменения updatedAt/синхронизации
      }
    }
  }
  function fireReminder(t) {
    try {
      const sec = state.sections.find((s) => s.id === t.sectionId);
      const body = (sec ? sec.name : '') + (t.time ? ' • ' + t.time : '');
      const n = new Notification('Задача: ' + t.text, { body, tag: t.id, icon: 'icons/icon-192.png' });
      n.onclick = () => { try { window.focus(); } catch (e) {} n.close(); };
    } catch (e) { console.warn('notify fail', e); }
  }
  async function enableReminders() {
    if (!('Notification' in window)) { $('remindersStatus').textContent = 'Уведомления не поддерживаются этим браузером.'; $('remindersStatus').className = 'auth-status err'; return false; }
    let perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) {} }
    if (perm !== 'granted') {
      $('remindersStatus').textContent = 'Разрешение на уведомления не выдано. Разрешите в настройках Safari для сайта.';
      $('remindersStatus').className = 'auth-status err';
      return false;
    }
    $('remindersStatus').textContent = 'Напоминания включены.';
    $('remindersStatus').className = 'auth-status ok';
    return true;
  }

  /* ---------------- РЕНДЕР СПИСКА ---------------- */
  function sortedSections() {
    return state.sections.slice().sort((a, b) => a.order - b.order);
  }
  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const pr = PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
      if (pr !== 0) return pr;
      if (a.due && b.due) return a.due < b.due ? -1 : 1;
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
    });
  }
  function tasksOf(sectionId) {
    return sortTasks(state.tasks.filter((t) => t.sectionId === sectionId && !t.deleted));
  }

  function formatDue(due) {
    if (!due) return null;
    const d = new Date(due + 'T00:00:00');
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((d - t) / 86400000);
    let label;
    if (diff === 0) label = 'сегодня';
    else if (diff === 1) label = 'завтра';
    else if (diff === 2) label = 'послезавтра';
    else if (diff === -1) label = 'вчера';
    else label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return { label, overdue: diff < 0 };
  }

  function sectionBlock(name, color, list, sectionId) {
    const secEl = document.createElement('div');
    secEl.className = 'section';
    const head = document.createElement('div');
    head.className = 'section-header';
    head.innerHTML = `<span class="section-dot" style="background:${color}"></span>
      <span class="section-name">${escapeHtml(name)}</span>
      <span class="section-count">${list.filter((t) => !t.done).length}</span>
      ${sectionId ? `<button class="section-add" title="Добавить задачу в «${escapeHtml(name)}»" aria-label="Добавить задачу">＋</button>` : ''}`;
    if (sectionId) head.querySelector('.section-add').onclick = () => openManualAdd(sectionId);
    secEl.appendChild(head);
    if (list.length === 0) {
      const e = document.createElement('div');
      e.className = 'section-empty';
      e.textContent = '—';
      secEl.appendChild(e);
    }
    for (const t of list) secEl.appendChild(taskEl(t));
    return secEl;
  }

  // Ручное добавление задачи прямо в выбранный раздел (без разбора).
  function openManualAdd(sectionId) {
    reviewItems = [{ id: null, text: '', sectionId, priority: 'medium', due: null, time: null }];
    openReview(true);
  }

  function render() {
    const container = $('sectionsContainer');
    container.innerHTML = '';
    const filtered = state.filter !== 'all';
    let shown = 0;

    for (const sec of sortedSections()) {
      const list = tasksOf(sec.id).filter(matchesFilter);
      if (filtered && list.length === 0) continue; // в фильтрах прячем пустые разделы
      shown += list.length;
      container.appendChild(sectionBlock(sec.name, sec.color, list, sec.id));
    }

    // задачи без существующего раздела (после удаления раздела/импорта/синка)
    const known = new Set(state.sections.map((s) => s.id));
    const orphans = sortTasks(state.tasks.filter((t) => !t.deleted && !known.has(t.sectionId)))
      .filter(matchesFilter);
    if (orphans.length) {
      shown += orphans.length;
      container.appendChild(sectionBlock('Без раздела', '#6b7280', orphans));
    }

    updateFilterBadges();
    $('emptyState').hidden = shown > 0;
    const msg = {
      all: 'Пока задач нет.<br />Нажмите кнопку записи внизу и продиктуйте или напишите задачу.',
      today: 'На сегодня задач нет.<br />Отдыхайте или переключитесь на «Все».',
      overdue: 'Просроченных задач нет. 👍',
    };
    $('emptyText').innerHTML = msg[state.filter] || msg.all;
  }

  function updateFilterBadges() {
    const today = todayISO();
    const active = state.tasks.filter((t) => !t.deleted && !t.done && t.due);
    const nToday = active.filter((t) => t.due <= today).length;
    const nOver = active.filter((t) => t.due < today).length;
    const setBadge = (id, n) => { const b = $(id); b.textContent = n; b.hidden = n === 0; };
    setBadge('badgeToday', nToday);
    setBadge('badgeOverdue', nOver);
  }

  function setFilter(f) {
    state.filter = f;
    document.querySelectorAll('#filters .filter-chip').forEach((c) =>
      c.classList.toggle('is-active', c.dataset.filter === f));
    render();
  }

  function taskEl(t) {
    const el = document.createElement('div');
    el.className = 'task' + (t.done ? ' done' : '');
    const due = formatDue(t.due);
    const timeLabel = t.time ? ` ⏰ ${t.time}` : '';
    const dueChip = due
      ? `<span class="chip due ${due.overdue && !t.done ? 'overdue' : ''}">📅 ${due.label}${timeLabel}</span>`
      : (t.time ? `<span class="chip due">⏰ ${t.time}</span>` : '');
    const prioChip = t.priority !== 'medium'
      ? `<span class="chip prio-${t.priority}">${PRIO_LABEL[t.priority]}</span>` : '';
    el.innerHTML = `
      <button class="check" aria-label="Выполнено">✓</button>
      <div class="task-body">
        <div class="task-text">${escapeHtml(t.text)}</div>
        <div class="task-meta">${prioChip}${dueChip}</div>
      </div>
      <div class="task-actions">
        <button class="mini-btn focus" title="Фокус">🎯</button>
        <button class="mini-btn edit" title="Изменить">✏️</button>
        <button class="mini-btn del" title="Удалить">🗑</button>
      </div>`;
    el.querySelector('.check').onclick = () => toggleDone(t.id);
    el.querySelector('.focus').onclick = () => openFocus(t.id);
    el.querySelector('.edit').onclick = () => openEdit(t.id);
    el.querySelector('.del').onclick = () => deleteTask(t.id);
    return el;
  }

  /* ---------------- CRUD ---------------- */
  async function persistTask(t) {
    t.updatedAt = nowISO();
    await DB.putTask(t);
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.push(t);
  }

  async function toggleDone(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    await persistTask(t);
    render();
    queueSync();
  }

  async function deleteTask(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    if (!confirm('Удалить задачу?')) return;
    t.deleted = true; // tombstone для синхронизации
    t.updatedAt = nowISO();
    await DB.putTask(t);
    state.tasks = state.tasks.filter((x) => x.id !== id);
    render();
    queueSync();
    toast('Задача удалена');
  }

  /* ---------------- БЫСТРЫЙ ВВОД → РАЗБОР ---------------- */
  async function handleQuickSubmit(text) {
    const raw = text.trim();
    if (!raw) return;
    let drafts = null;
    let engine = null;      // какой движок реально разобрал
    let lastError = null;   // текст ошибки умного разбора (для показа)
    setBusy(true);          // спиннер в кнопке ＋ на всё время разбора

    // 1) Облако (когда есть ключ и интернет) — быстро и умно. Приоритет.
    if (!drafts && state.settings.cloudKey && navigator.onLine && window.LLM) {
      try {
        toast('Разбор облачной моделью…');
        drafts = await LLM.parseCloud(raw, state.sections, {
          url: state.settings.cloudUrl, apiKey: state.settings.cloudKey, model: state.settings.cloudModel,
        });
        engine = 'облако';
      } catch (e) { lastError = 'облако: ' + (e && e.message || e); console.warn('Cloud failed:', e); }
    }

    // 2) Модель на устройстве (WebLLM) — если включена (в основном как офлайн-запас).
    if (!drafts && state.settings.webllmEnabled && window.WebLLM && WebLLM.isSupported()) {
      try {
        if (!WebLLM.isReady()) { setModelLoading(true, 'Загрузка ИИ-модели…'); await WebLLM.load(state.settings.webllmModel, webllmProgress); }
        setModelLoading(true, '🧠 Модель думает…');
        drafts = await WebLLM.parse(raw, state.sections);
        engine = 'на устройстве';
      } catch (e) { lastError = 'модель: ' + (e && e.message || e); console.warn('WebLLM failed:', e); }
      finally { setModelLoading(false); }
    }

    // 3) Умный разбор через Ollama (если настроено и есть сеть).
    if (!drafts && state.settings.llmEnabled && window.LLM) {
      try {
        toast('Разбор через Ollama…');
        drafts = await LLM.parse(raw, state.sections, { url: state.settings.llmUrl, model: state.settings.llmModel });
        engine = 'Ollama';
      } catch (e) { lastError = 'Ollama: ' + (e && e.message || e); console.warn('Ollama failed:', e); }
    }

    // Если умный разбор был включён, но не сработал — честно скажем почему.
    const smartOn = state.settings.webllmEnabled || state.settings.cloudKey || state.settings.llmEnabled;
    if (!drafts && smartOn && lastError) toast('ИИ не сработал (' + lastError + ') — разбор по правилам', 5000);

    // 4) Офлайн-разбор по правилам — всегда доступный базис.
    if (!drafts) { drafts = Parser.parse(raw, state.sections); engine = engine || 'правила'; }
    else { toast('Разобрано: ' + engine); }

    reviewItems = drafts.map((d) => {
      let time = d.time || null;
      let due = d.due || null;
      // модель могла не выделить время — подстрахуемся детерминированным парсером
      if (!time) { const tr = Parser.detectTime(d.text); if (tr) time = tr.time; }
      if (time && !due) due = todayISO();
      return { id: null, text: d.text, sectionId: d.sectionId, priority: d.priority, due, time };
    });
    setBusy(false);
    openReview();
  }

  // Спиннер в кнопке ＋ на время разбора (видно, что идёт работа, не завис).
  function setBusy(on) {
    const btn = $('btnAdd');
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle('busy', on);
    btn.innerHTML = on ? '<span class="btn-spinner"></span>' : '＋';
  }

  /* ---------------- ЭКРАН ПОДТВЕРЖДЕНИЯ ---------------- */
  function openReview(focusFirst) {
    const list = $('reviewList');
    list.innerHTML = '';
    reviewItems.forEach((item, idx) => list.appendChild(reviewItemEl(item, idx)));
    const manual = reviewItems.length === 1 && !reviewItems[0].id && !reviewItems[0].text;
    $('reviewSub').textContent = manual
      ? 'Введите задачу — она попадёт в выбранный раздел. Можно задать важность, дату и время.'
      : 'Приложение разложило ввод на задачи. Поправьте раздел, срок или важность при необходимости.';
    $('reviewOverlay').hidden = false;
    if (focusFirst) { const ta = list.querySelector('.ri-text'); if (ta) ta.focus(); }
  }
  function closeReview() { $('reviewOverlay').hidden = true; reviewItems = []; }

  const PRIO_ORDER = ['high', 'medium', 'low'];

  function reviewItemEl(item, idx) {
    const el = document.createElement('div');
    el.className = 'review-item';
    const secColor = (sortedSections().find((s) => s.id === item.sectionId) || {}).color || '#6b7280';
    const secOptions = sortedSections().map((s) =>
      `<option value="${s.id}" ${s.id === item.sectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    const prioBtns = PRIO_ORDER.map((p) =>
      `<button type="button" class="prio-pill prio-${p} ${p === item.priority ? 'active' : ''}" data-prio="${p}">${PRIO_LABEL[p]}</button>`).join('');

    el.innerHTML = `
      <div class="ri-top">
        <span class="ri-badge" style="background:${secColor}"></span>
        <textarea class="ri-text" rows="1">${escapeHtml(item.text)}</textarea>
        <button class="ri-del" title="Убрать" aria-label="Убрать">✕</button>
      </div>
      <div class="ri-fields">
        <label class="ri-field ri-section-field">
          <span class="ri-label">Раздел</span>
          <select class="rv-section">${secOptions}</select>
        </label>
        <div class="ri-field">
          <span class="ri-label">Важность</span>
          <div class="prio-seg">${prioBtns}</div>
        </div>
        <label class="ri-field">
          <span class="ri-label">Дата</span>
          <input class="rv-due" type="date" value="${item.due || ''}" />
        </label>
        <label class="ri-field">
          <span class="ri-label">Время</span>
          <input class="rv-time" type="time" value="${item.time || ''}" />
        </label>
      </div>`;

    const ta = el.querySelector('.ri-text');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.oninput = () => { reviewItems[idx].text = ta.value; grow(); };
    setTimeout(grow, 0);

    const badge = el.querySelector('.ri-badge');
    el.querySelector('.rv-section').onchange = (e) => {
      reviewItems[idx].sectionId = e.target.value;
      const c = (sortedSections().find((s) => s.id === e.target.value) || {}).color || '#6b7280';
      badge.style.background = c;
    };
    el.querySelectorAll('.prio-pill').forEach((btn) => {
      btn.onclick = () => {
        reviewItems[idx].priority = btn.dataset.prio;
        el.querySelectorAll('.prio-pill').forEach((b) => b.classList.toggle('active', b === btn));
      };
    });
    el.querySelector('.rv-due').onchange = (e) => {
      reviewItems[idx].due = e.target.value || null;
      // если задали время, но не дату — подставим сегодня
      if (reviewItems[idx].time && !reviewItems[idx].due) { reviewItems[idx].due = todayISO(); e.target.value = reviewItems[idx].due; }
    };
    el.querySelector('.rv-time').onchange = (e) => {
      reviewItems[idx].time = e.target.value || null;
      if (reviewItems[idx].time && !reviewItems[idx].due) {
        reviewItems[idx].due = todayISO();
        const dd = el.querySelector('.rv-due'); if (dd) dd.value = reviewItems[idx].due;
      }
    };
    el.querySelector('.ri-del').onclick = () => { reviewItems.splice(idx, 1); openReview(); };
    return el;
  }

  async function saveReview() {
    const items = reviewItems.filter((i) => i.text && i.text.trim());
    if (items.length === 0) { closeReview(); return; }
    for (const item of items) {
      if (item.id) {
        const t = state.tasks.find((x) => x.id === item.id);
        if (t) {
          t.text = item.text.trim();
          t.sectionId = item.sectionId;
          t.priority = item.priority;
          t.due = item.due || null;
          t.time = item.time || null;
          t.notified = false; // срок могли изменить — разрешаем напомнить снова
          await persistTask(t);
        }
      } else {
        await persistTask({
          id: uid(),
          text: item.text.trim(),
          sectionId: item.sectionId,
          priority: item.priority,
          due: item.due || null,
          time: item.time || null,
          done: false,
          deleted: false,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
      }
    }
    closeReview();
    $('quickInput').value = ''; // очищаем ввод только после успешного сохранения
    render();
    queueSync();
    toast(items.length === 1 ? 'Задача добавлена' : `Добавлено задач: ${items.length}`);
  }

  function openEdit(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    reviewItems = [{ id: t.id, text: t.text, sectionId: t.sectionId, priority: t.priority, due: t.due, time: t.time || null }];
    openReview();
  }

  /* ---------------- ГОЛОСОВОЙ ВВОД ---------------- */
  function toggleMic() {
    if (!Speech.isSupported()) {
      toast('Голосовой ввод не поддерживается в этом браузере — печатайте текстом');
      $('quickInput').focus();
      return;
    }
    if (recognizing) { stopMic(); return; }
    recognizer = Speech.createRecognizer({ lang: 'ru-RU' });
    let finalText = '';
    showLive('');
    recognizer.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      const full = (finalText + interim).trim();
      $('quickInput').value = full;
      // держим видимым конец строки в однострочном поле
      const qi = $('quickInput'); qi.scrollLeft = qi.scrollWidth;
      updateLive(full, interim);
    };
    recognizer.onerror = (e) => {
      recognizing = false;
      $('btnMic').classList.remove('recording');
      hideLive();
      if (e.error === 'not-allowed') toast('Нет доступа к микрофону');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Ошибка распознавания: ' + e.error);
    };
    recognizer.onend = () => {
      recognizing = false;
      $('btnMic').classList.remove('recording');
      hideLive();
      // НЕ разбираем автоматически: распознавание речи часто искажает слова,
      // поэтому оставляем текст в поле — можно поправить и нажать ＋.
      const qi = $('quickInput');
      const v = qi.value.trim();
      if (v) { qi.value = v; qi.focus(); qi.setSelectionRange(v.length, v.length); toast('Проверьте текст и нажмите ＋'); }
    };
    try {
      recognizer.start();
      recognizing = true;
      $('btnMic').classList.add('recording');
    } catch (e) { hideLive(); toast('Не удалось запустить запись'); }
  }
  function stopMic() { if (recognizer) recognizer.stop(); }

  /* ---------------- ЖИВАЯ ТРАНСКРИПЦИЯ ---------------- */
  function showLive() {
    const box = $('liveTranscript');
    $('liveText').innerHTML = '<span class="live-placeholder">Говорите… текст появится здесь</span>';
    box.hidden = false;
  }
  function updateLive(full, interim) {
    const el = $('liveText');
    if (!full) { el.innerHTML = '<span class="live-placeholder">Говорите… текст появится здесь</span>'; return; }
    const finalPart = full.slice(0, full.length - interim.length);
    el.innerHTML = escapeHtml(finalPart) + '<span class="live-interim">' + escapeHtml(interim) + '</span>';
    el.scrollTop = el.scrollHeight; // прокрутка за речью
  }
  function hideLive() { $('liveTranscript').hidden = true; }

  /* ---------------- ФОКУС-РЕЖИМ ---------------- */
  function openFocus(id) {
    focusTaskId = id;
    const t = state.tasks.find((x) => x.id === id);
    $('focusTaskText').textContent = t ? t.text : 'Свободный фокус';
    timer.configure(state.settings.workMin, state.settings.breakMin);
    timer.reset();
    $('focusSound').value = state.settings.sound || 'lofi';
    $('focusVolume').value = state.settings.volume ?? 45;
    updateFocusUI(timer.remaining, timer.total, timer.phase);
    $('focusToggle').textContent = 'Старт';
    $('focusOverlay').classList.remove('break');
    $('focusOverlay').hidden = false;
  }
  function closeFocus() {
    timer.stop();
    sound.stop();
    $('focusOverlay').hidden = true;
    $('btnMic'); // noop
  }
  function updateFocusUI(remaining, total, phase) {
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    $('focusTime').textContent = `${mm}:${ss}`;
    $('focusPhase').textContent = phase === 'work' ? 'Фокус' : 'Перерыв';
    const circ = 2 * Math.PI * 100; // 628
    const ratio = total > 0 ? remaining / total : 0;
    $('ringProgress').style.strokeDashoffset = String(circ * (1 - ratio));
    $('focusOverlay').classList.toggle('break', phase === 'break');
  }

  timer.onTick = (r, t, p) => updateFocusUI(r, t, p);
  timer.onComplete = (finished) => {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    beep();
    if (finished === 'work') {
      toast('Помидор завершён! Отметьте задачу или сделайте перерыв.');
    } else {
      toast('Перерыв окончен — снова в фокус.');
    }
    $('focusToggle').textContent = 'Старт';
  };

  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 660; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      o.start(); o.stop(ctx.currentTime + 0.6);
    } catch (e) {}
  }

  /* ---------------- НАСТРОЙКИ ---------------- */
  function openSettings() {
    renderSectionManager();
    $('setWork').value = state.settings.workMin;
    $('setBreak').value = state.settings.breakMin;
    $('setSbUrl').value = state.settings.sbUrl || '';
    $('setSbKey').value = state.settings.sbKey || '';
    $('setLlmEnabled').checked = !!state.settings.llmEnabled;
    $('setLlmUrl').value = state.settings.llmUrl || 'http://localhost:11434';
    $('setLlmModel').value = state.settings.llmModel || 'llama3.2';
    $('llmStatus').textContent = '';
    $('llmStatus').className = 'auth-status';
    $('setWebllmModel').value = state.settings.webllmModel || 'qwen2.5-0.5b';
    renderWebllmState();
    $('setCloudEnabled').checked = !!state.settings.cloudEnabled;
    $('setCloudKey').value = state.settings.cloudKey || '';
    $('setCloudUrl').value = state.settings.cloudUrl || 'https://openrouter.ai/api/v1';
    $('setCloudModel').value = state.settings.cloudModel || 'google/gemma-4-31b-it:free';
    $('cloudStatus').textContent = ''; $('cloudStatus').className = 'auth-status';
    $('setReminders').checked = !!state.settings.remindersEnabled;
    $('remindersStatus').textContent = ('Notification' in window)
      ? (Notification.permission === 'granted' ? '' : (Notification.permission === 'denied' ? 'Уведомления запрещены в настройках Safari.' : ''))
      : 'Уведомления не поддерживаются этим браузером.';
    $('remindersStatus').className = 'auth-status';
    updateAuthBox();
    $('settingsOverlay').hidden = false;
  }
  function closeSettings() { $('settingsOverlay').hidden = true; }

  const PALETTE = ['#ff6b6b', '#8a6cff', '#35c67a', '#ff9f43', '#56b3ff', '#e857c4', '#f7b731', '#26d0ce'];

  function renderSectionManager() {
    const box = $('sectionManager');
    box.innerHTML = '';
    const secs = sortedSections();
    secs.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'sm-row';
      row.innerHTML = `
        <div class="sm-head">
          <input type="color" class="sm-color" value="${escapeHtml(s.color || '#6b7280')}" aria-label="Цвет" />
          <input type="text" class="sm-name" value="${escapeHtml(s.name)}" placeholder="Название" />
          <span class="sm-arrows">
            <button class="sm-up" ${i === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
            <button class="sm-down" ${i === secs.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
          </span>
          <button class="sm-del" aria-label="Удалить" ${secs.length <= 1 ? 'disabled' : ''}>🗑</button>
        </div>
        <input type="text" class="sm-kw" value="${escapeHtml((s.keywords || []).join(', '))}"
               placeholder="ключевые слова через запятую" />`;

      row.querySelector('.sm-color').onchange = async (e) => {
        s.color = e.target.value; await DB.putSection(s); render();
      };
      const nameInput = row.querySelector('.sm-name');
      nameInput.onchange = async () => {
        s.name = nameInput.value.trim() || s.name; nameInput.value = s.name;
        await DB.putSection(s); render();
      };
      row.querySelector('.sm-kw').onchange = async (e) => {
        s.keywords = e.target.value.split(',').map((k) => k.trim()).filter(Boolean);
        await DB.putSection(s);
      };
      row.querySelector('.sm-up').onclick = () => moveSection(s.id, -1);
      row.querySelector('.sm-down').onclick = () => moveSection(s.id, 1);
      row.querySelector('.sm-del').onclick = () => deleteSection(s.id);
      box.appendChild(row);
    });
  }

  async function moveSection(id, dir) {
    const secs = sortedSections();
    const idx = secs.findIndex((s) => s.id === id);
    const swap = idx + dir;
    if (swap < 0 || swap >= secs.length) return;
    [secs[idx].order, secs[swap].order] = [secs[swap].order, secs[idx].order];
    await DB.bulkPutSections(secs);
    state.sections = secs;
    renderSectionManager();
    render();
  }

  async function addSection() {
    const secs = sortedSections();
    const maxOrder = secs.reduce((m, s) => Math.max(m, s.order || 0), -1);
    const color = PALETTE[secs.length % PALETTE.length];
    const s = { id: 'sec-' + uid().slice(0, 8), name: 'Новый раздел', order: maxOrder + 1, color, keywords: [] };
    state.sections.push(s);
    await DB.putSection(s);
    renderSectionManager();
    render();
    // прокрутить к новому и выделить имя для правки
    const box = $('sectionManager');
    const last = box.lastElementChild;
    if (last) { last.scrollIntoView({ block: 'nearest' }); const n = last.querySelector('.sm-name'); if (n) { n.focus(); n.select(); } }
  }

  async function deleteSection(id) {
    const secs = sortedSections();
    if (secs.length <= 1) { toast('Нужен хотя бы один раздел'); return; }
    const sec = secs.find((s) => s.id === id);
    const fallback = secs.find((s) => s.id !== id); // ближайший по порядку
    const affected = state.tasks.filter((t) => t.sectionId === id && !t.deleted);
    const msg = affected.length
      ? `Удалить раздел «${sec.name}»? ${affected.length} задач(и) перейдут в «${fallback.name}».`
      : `Удалить раздел «${sec.name}»?`;
    if (!confirm(msg)) return;
    // переносим задачи в запасной раздел (updatedAt → синхронизация подхватит)
    for (const t of affected) { t.sectionId = fallback.id; await persistTask(t); }
    state.sections = state.sections.filter((s) => s.id !== id);
    await DB.deleteSection(id);
    renderSectionManager();
    render();
    queueSync();
    toast('Раздел удалён');
  }

  async function saveSettings() {
    state.settings.workMin = clampInt($('setWork').value, 1, 120, 25);
    state.settings.breakMin = clampInt($('setBreak').value, 1, 60, 5);
    state.settings.llmEnabled = $('setLlmEnabled').checked;
    state.settings.llmUrl = $('setLlmUrl').value.trim() || 'http://localhost:11434';
    state.settings.llmModel = $('setLlmModel').value.trim() || 'llama3.2';
    // webllmEnabled управляется кнопкой-переключателем (toggleWebllm), не здесь
    state.settings.webllmModel = $('setWebllmModel').value || 'qwen2.5-0.5b';
    state.settings.cloudKey = $('setCloudKey').value.trim();
    state.settings.cloudEnabled = $('setCloudEnabled').checked || !!state.settings.cloudKey;
    state.settings.cloudUrl = $('setCloudUrl').value.trim() || 'https://openrouter.ai/api/v1';
    state.settings.cloudModel = $('setCloudModel').value.trim() || 'google/gemma-4-31b-it:free';
    state.settings.remindersEnabled = $('setReminders').checked;
    const newUrl = $('setSbUrl').value.trim();
    const newKey = $('setSbKey').value.trim();
    const changed = newUrl !== state.settings.sbUrl || newKey !== state.settings.sbKey;
    state.settings.sbUrl = newUrl;
    state.settings.sbKey = newKey;
    await DB.setMeta('settings', state.settings);
    timer.configure(state.settings.workMin, state.settings.breakMin);
    if (changed && newUrl && newKey) {
      try { await Sync.init(newUrl, newKey); updateSyncBadge(); toast('Синхронизация настроена — войдите в аккаунт'); }
      catch (e) { updateSyncBadge('err'); toast('Не удалось подключить Supabase'); }
    }
    closeSettings();
  }

  async function testLlm() {
    const s = $('llmStatus');
    const url = $('setLlmUrl').value.trim() || 'http://localhost:11434';
    const model = $('setLlmModel').value.trim() || 'llama3.2';
    s.textContent = 'Проверяю…';
    s.className = 'auth-status';
    try {
      const res = await LLM.ping({ url });
      const has = res.models.some((m) => m === model || m.split(':')[0] === model);
      if (has) {
        s.textContent = `Связь есть. Модель «${model}» доступна.`;
        s.className = 'auth-status ok';
      } else {
        s.textContent = `Сервер отвечает, но модели «${model}» нет. Доступны: ${res.models.join(', ') || '—'}. Загрузите: ollama pull ${model}`;
        s.className = 'auth-status err';
      }
    } catch (e) {
      s.textContent = 'Нет связи с Ollama. Проверьте, что сервер запущен и разрешён CORS (OLLAMA_ORIGINS).';
      s.className = 'auth-status err';
    }
  }

  // Глобальный баннер загрузки модели (виден на любом экране).
  let modelLoadingTimer = null;
  function setModelLoading(show, text) {
    const el = $('modelLoading');
    if (!el) return;
    if (text) $('modelLoadingText').textContent = text;
    el.hidden = !show;
    clearTimeout(modelLoadingTimer);
    // страховка: баннер не может висеть дольше 60 сек ни при каких условиях
    if (show) modelLoadingTimer = setTimeout(() => { el.hidden = true; }, 60000);
  }
  // Единый колбэк прогресса: обновляет баннер и полосу в настройках.
  function webllmProgress(p) {
    // если модель успели выключить/отменить — не показываем баннер вообще
    if (!state.settings.webllmEnabled) { setModelLoading(false); return; }
    const pct = Math.round((p && p.progress || 0) * 100);
    setModelLoading(true, 'Загрузка ИИ-модели… ' + pct + '%');
    const bar = $('webllmBar'); if (bar) bar.style.width = pct + '%';
    const st = $('webllmStateText'); if (st && !$('settingsOverlay').hidden) st.textContent = 'Загрузка модели… ' + pct + '%';
  }

  // Единый рендер состояния модели: цветной индикатор + подпись + кнопка.
  function renderWebllmState() {
    const dot = document.querySelector('#webllmState .engine-dot');
    const txt = $('webllmStateText');
    const btn = $('btnWebllmToggle');
    if (!dot || !txt || !btn) return;
    const supported = !!(window.WebLLM && WebLLM.isSupported());
    const ready = !!(window.WebLLM && WebLLM.isReady());
    const loading = !!(window.WebLLM && WebLLM.isLoading());
    const enabled = !!state.settings.webllmEnabled;
    dot.className = 'engine-dot';
    btn.disabled = false;
    btn.classList.remove('btn--ghost'); btn.classList.add('btn--primary');
    if (!supported) {
      dot.classList.add('err');
      txt.textContent = 'Не поддерживается (нет WebGPU) — работают правила';
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    if (loading) {
      dot.classList.add('load');
      txt.textContent = 'Загрузка модели…';
      // кнопку НЕ блокируем — можно отменить/выключить прямо во время загрузки
      btn.classList.remove('btn--primary'); btn.classList.add('btn--ghost');
      btn.textContent = 'Отменить загрузку';
    } else if (enabled && ready) {
      dot.classList.add('on');
      txt.textContent = '✅ Включена — разбираю ИИ на устройстве';
      btn.classList.remove('btn--primary'); btn.classList.add('btn--ghost');
      btn.textContent = 'Выключить модель';
    } else if (enabled && !ready) {
      dot.classList.add('load');
      txt.textContent = 'Включена, но не загружена — нажмите, чтобы загрузить';
      btn.textContent = 'Загрузить и включить';
    } else {
      dot.classList.add('off');
      txt.textContent = 'Выключена — работают правила';
      btn.textContent = 'Включить модель';
    }
  }

  async function toggleWebllm() {
    if (!window.WebLLM || !WebLLM.isSupported()) { renderWebllmState(); return; }
    // если идёт загрузка ИЛИ уже включена — выключаем/отменяем
    if (state.settings.webllmEnabled || WebLLM.isLoading() || WebLLM.isReady()) {
      state.settings.webllmEnabled = false;
      await DB.setMeta('settings', state.settings);
      setModelLoading(false);
      $('webllmProgress').hidden = true;
      try { await WebLLM.unload(); } catch (e) {}
      renderWebllmState();
      toast('Модель выключена — разбор по правилам');
      return;
    }
    // иначе включаем и грузим
    const modelKey = $('setWebllmModel').value || 'qwen2.5-0.5b';
    state.settings.webllmModel = modelKey;
    state.settings.webllmEnabled = true;
    await DB.setMeta('settings', state.settings);
    const bar = $('webllmBar'); const prog = $('webllmProgress');
    prog.hidden = false; bar.style.width = '0%';
    setModelLoading(true, 'Загрузка ИИ-модели…');
    renderWebllmState();
    try {
      await WebLLM.load(modelKey, webllmProgress);
      bar.style.width = '100%';
      setModelLoading(false);
      renderWebllmState();
      toast('Готово! Модель включена');
    } catch (e) {
      console.error(e);
      setModelLoading(false);
      state.settings.webllmEnabled = false;
      await DB.setMeta('settings', state.settings);
      $('webllmStateText').textContent = 'Ошибка загрузки: ' + (e && e.message || e);
      document.querySelector('#webllmState .engine-dot').className = 'engine-dot err';
      $('btnWebllmToggle').textContent = 'Повторить';
    } finally {
      setTimeout(() => { $('webllmProgress').hidden = true; }, 1500);
    }
  }

  async function testCloud() {
    const s = $('cloudStatus');
    const key = $('setCloudKey').value.trim();
    const url = $('setCloudUrl').value.trim() || 'https://openrouter.ai/api/v1';
    const model = $('setCloudModel').value.trim() || 'google/gemma-4-31b-it:free';
    if (!key) { s.textContent = 'Вставьте API-ключ (получить бесплатно на openrouter.ai).'; s.className = 'auth-status err'; return; }
    s.textContent = 'Проверяю…'; s.className = 'auth-status';
    try {
      await LLM.pingCloud({ url, apiKey: key, model });
      s.textContent = 'Связь и ключ в порядке. Онлайн-разбор включён.';
      s.className = 'auth-status ok';
      // сохраняем ключ и включаем облако
      state.settings.cloudKey = key; state.settings.cloudModel = model; state.settings.cloudEnabled = true;
      $('setCloudEnabled').checked = true;
      await DB.setMeta('settings', state.settings);
    } catch (e) {
      s.textContent = 'Не удалось подключиться: ' + (e.message || e);
      s.className = 'auth-status err';
    }
  }

  /* ---------------- СИНХРОНИЗАЦИЯ (UI) ---------------- */
  function updateAuthBox() {
    const user = Sync.currentUser();
    const status = $('authStatus');
    if (!state.settings.sbUrl || !state.settings.sbKey) {
      status.textContent = 'Заполните URL и ключ, затем нажмите «Готово».';
      status.className = 'auth-status';
      $('btnSignOut').hidden = true; $('btnSyncNow').hidden = true;
      return;
    }
    if (user) {
      status.textContent = 'Вошли как ' + (user.email || user.id);
      status.className = 'auth-status ok';
      $('btnSignOut').hidden = false; $('btnSyncNow').hidden = false;
    } else {
      status.textContent = 'Не выполнен вход.';
      status.className = 'auth-status';
      $('btnSignOut').hidden = true; $('btnSyncNow').hidden = true;
    }
  }

  async function handleSignIn(isSignUp) {
    const email = $('authEmail').value.trim();
    const pass = $('authPass').value;
    if (!email || !pass) { toast('Введите почту и пароль'); return; }
    if (!Sync.isConfigured()) {
      try { await Sync.init(state.settings.sbUrl, state.settings.sbKey); }
      catch (e) { toast('Сначала настройте Supabase'); return; }
    }
    try {
      if (isSignUp) { await Sync.signUp(email, pass); toast('Регистрация выполнена'); }
      else { await Sync.signIn(email, pass); toast('Вход выполнен'); }
      updateAuthBox();
      updateSyncBadge();
      await doSync(true);
    } catch (e) {
      const s = $('authStatus'); s.textContent = 'Ошибка: ' + (e.message || e); s.className = 'auth-status err';
    }
  }

  let syncTimer = null;
  function queueSync() {
    if (!Sync.currentUser()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => doSync(false), 1500);
  }

  async function doSync(showToast) {
    if (!Sync.currentUser()) return;
    updateSyncBadge('syncing');
    try {
      const all = await DB.getTasks(); // включая tombstones
      const res = await Sync.sync(all);
      if (res.toSaveLocally.length) {
        await DB.bulkPutTasks(res.toSaveLocally);
        state.tasks = (await DB.getTasks()).filter((t) => !t.deleted);
        render();
      }
      updateSyncBadge('ok');
      if (showToast) toast(`Синхронизировано ↑${res.pushed} ↓${res.pulled}`);
    } catch (e) {
      console.error(e);
      updateSyncBadge('err');
      if (showToast) toast('Ошибка синхронизации');
    }
  }

  function updateSyncBadge(force) {
    const b = $('syncBadge');
    let s = force;
    if (!s) {
      if (!navigator.onLine) s = 'offline';
      else if (Sync.currentUser()) s = 'ok';
      else s = 'local';
    }
    const map = {
      offline: ['офлайн', ''], local: ['локально', ''],
      ok: ['синхр.', 'ok'], syncing: ['синхр…', 'syncing'], err: ['ошибка', 'err'],
    };
    const [text, cls] = map[s] || map.local;
    b.textContent = text;
    b.className = 'sync-badge ' + cls;
  }

  /* ---------------- ЭКСПОРТ / ИМПОРТ ---------------- */
  async function exportData() {
    const data = {
      version: 1, exportedAt: nowISO(),
      sections: state.sections,
      tasks: await DB.getTasks(),
      settings: state.settings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tasks-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
  async function importData(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.sections) { await DB.bulkPutSections(data.sections); state.sections = data.sections; }
      if (data.tasks) { await DB.bulkPutTasks(data.tasks); state.tasks = (await DB.getTasks()).filter((t) => !t.deleted); }
      if (data.settings) { state.settings = Object.assign(state.settings, data.settings); await DB.setMeta('settings', state.settings); }
      state.sections = state.sections.slice().sort((a, b) => a.order - b.order);
      render(); renderSectionManager();
      toast('Импортировано');
    } catch (e) { toast('Не удалось прочитать файл'); }
  }

  /* ---------------- ПРИВЯЗКА СОБЫТИЙ ---------------- */
  function wire() {
    $('quickForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('quickInput').value;
      // пустое поле → открываем ручное добавление в первый раздел
      if (!v.trim()) { const s = sortedSections()[0]; if (s) openManualAdd(s.id); return; }
      // текст НЕ стираем сразу — очистим только после успешного сохранения
      handleQuickSubmit(v);
    };
    $('btnMic').onclick = toggleMic;

    document.querySelectorAll('#filters .filter-chip').forEach((c) => {
      c.onclick = () => setFilter(c.dataset.filter);
    });

    $('reviewClose').onclick = closeReview;
    $('reviewCancel').onclick = closeReview;
    $('reviewSave').onclick = saveReview;

    $('btnMusic').onclick = openMusic;
    $('musicClose').onclick = closeMusic;
    $('musicToggle').onclick = toggleMusic;
    $('musicSound').onchange = (e) => {
      state.settings.sound = e.target.value; DB.setMeta('settings', state.settings);
      if (musicPlaying) sound.play(e.target.value);
    };
    $('musicVolume').oninput = (e) => {
      const v = parseInt(e.target.value, 10);
      state.settings.volume = v; sound.setVolume(v / 100);
    };
    $('musicVolume').onchange = () => DB.setMeta('settings', state.settings);
    $('musicOverlay').addEventListener('click', (e) => { if (e.target.id === 'musicOverlay') closeMusic(); });

    $('btnSettings').onclick = openSettings;
    $('settingsClose').onclick = closeSettings;
    $('settingsSave').onclick = saveSettings;
    $('btnAddSection').onclick = addSection;
    $('btnLlmTest').onclick = testLlm;
    $('btnWebllmToggle').onclick = toggleWebllm;
    $('setWebllmModel').onchange = async () => {
      // если модель включена, а выбрали другую — перегружаем
      if (state.settings.webllmEnabled) { await WebLLM.unload().catch(() => {}); await toggleWebllm(); }
      else { state.settings.webllmModel = $('setWebllmModel').value; DB.setMeta('settings', state.settings); }
    };
    $('btnCloudTest').onclick = testCloud;
    $('setReminders').onchange = async (e) => {
      if (e.target.checked) {
        const ok = await enableReminders();
        e.target.checked = ok;
        state.settings.remindersEnabled = ok;
      } else {
        state.settings.remindersEnabled = false;
        $('remindersStatus').textContent = 'Напоминания выключены.'; $('remindersStatus').className = 'auth-status';
      }
      DB.setMeta('settings', state.settings);
    };
    $('btnReminderTest').onclick = async () => {
      const ok = await enableReminders();
      if (ok) { try { new Notification('Проверка ✓', { body: 'Напоминания работают', icon: 'icons/icon-192.png' }); } catch (e) {} }
    };
    // вставил ключ → сразу сохраняем и включаем облако (без лишних действий)
    $('setCloudKey').onchange = () => {
      state.settings.cloudKey = $('setCloudKey').value.trim();
      state.settings.cloudEnabled = !!state.settings.cloudKey;
      $('setCloudEnabled').checked = state.settings.cloudEnabled;
      DB.setMeta('settings', state.settings);
      if (state.settings.cloudKey) toast('Ключ сохранён — умный разбор включён');
    };

    // фокус
    $('focusClose').onclick = closeFocus;
    $('focusToggle').onclick = () => {
      timer.toggle();
      $('focusToggle').textContent = timer.running ? 'Пауза' : 'Продолжить';
      if (timer.running && $('focusSound').value !== 'none') sound.play($('focusSound').value);
    };
    $('focusReset').onclick = () => {
      timer.reset();
      $('focusToggle').textContent = 'Старт';
      updateFocusUI(timer.remaining, timer.total, timer.phase);
    };
    $('focusSound').onchange = (e) => {
      state.settings.sound = e.target.value;
      DB.setMeta('settings', state.settings);
      if (timer.running) sound.play(e.target.value); else sound.stop();
    };
    $('focusVolume').oninput = (e) => {
      const v = parseInt(e.target.value, 10) / 100;
      sound.setVolume(v);
      state.settings.volume = parseInt(e.target.value, 10);
    };
    $('focusVolume').onchange = () => DB.setMeta('settings', state.settings);
    $('focusDone').onclick = async () => {
      if (focusTaskId) {
        const t = state.tasks.find((x) => x.id === focusTaskId);
        if (t) { t.done = true; await persistTask(t); render(); queueSync(); }
      }
      closeFocus();
      toast('Отличная работа!');
    };

    // синхронизация
    $('btnSignIn').onclick = () => handleSignIn(false);
    $('btnSignUp').onclick = () => handleSignIn(true);
    $('btnSignOut').onclick = async () => { await Sync.signOut(); updateAuthBox(); updateSyncBadge(); toast('Вышли'); };
    $('btnSyncNow').onclick = () => doSync(true);

    // данные
    $('btnExport').onclick = exportData;
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); };

    // закрытие overlay по клику на фон
    [['reviewOverlay', closeReview], ['settingsOverlay', closeSettings]].forEach(([id, fn]) => {
      $(id).addEventListener('click', (e) => { if (e.target.id === id) fn(); });
    });
  }

  /* ---------------- УТИЛИТЫ ---------------- */
  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2600);
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // при появлении новой версии — один раз перезагрузиться, чтобы не залипать
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return; refreshed = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js')
      .then((reg) => { reg.update(); })
      .catch((e) => console.warn('SW fail', e));
  }

  boot();
})();
