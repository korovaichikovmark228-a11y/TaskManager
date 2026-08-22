/* ============================================================
   app.js — связывает всё вместе: список, ввод, разбор, фокус,
   настройки, синхронизация, PWA.
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
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
      webllmEnabled: false, webllmModel: 'qwen2.5-1.5b' },
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

    // Предзагрузка модели на устройстве (из кэша — быстро; иначе тихо ждёт),
    // чтобы умный разбор был готов, в т.ч. офлайн.
    if (state.settings.webllmEnabled && window.WebLLM && WebLLM.isSupported()) {
      WebLLM.load(state.settings.webllmModel).catch((e) => console.warn('WebLLM preload:', e));
    }
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

  function sectionBlock(name, color, list) {
    const secEl = document.createElement('div');
    secEl.className = 'section';
    const head = document.createElement('div');
    head.className = 'section-header';
    head.innerHTML = `<span class="section-dot" style="background:${color}"></span>
      <span class="section-name">${escapeHtml(name)}</span>
      <span class="section-count">${list.filter((t) => !t.done).length}</span>`;
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

  function render() {
    const container = $('sectionsContainer');
    container.innerHTML = '';
    const filtered = state.filter !== 'all';
    let shown = 0;

    for (const sec of sortedSections()) {
      const list = tasksOf(sec.id).filter(matchesFilter);
      if (filtered && list.length === 0) continue; // в фильтрах прячем пустые разделы
      shown += list.length;
      container.appendChild(sectionBlock(sec.name, sec.color, list));
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
    const dueChip = due ? `<span class="chip due ${due.overdue && !t.done ? 'overdue' : ''}">📅 ${due.label}</span>` : '';
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

    // 1) Умный разбор моделью на устройстве (WebLLM). Работает офлайн.
    if (!drafts && state.settings.webllmEnabled && window.WebLLM && WebLLM.isSupported()) {
      try {
        if (!WebLLM.isReady()) {
          toast('Загружаю модель… (первый раз дольше)');
          await WebLLM.load(state.settings.webllmModel);
        }
        toast('Разбор ИИ на устройстве…');
        drafts = await WebLLM.parse(raw, state.sections);
      } catch (e) {
        console.warn('WebLLM parse failed, fallback:', e);
      }
    }

    // 2) Умный разбор через Ollama/облако (если настроено и есть сеть).
    if (!drafts && state.settings.llmEnabled && window.LLM) {
      toast('Разбор ИИ…');
      try {
        drafts = await LLM.parse(raw, state.sections, {
          url: state.settings.llmUrl,
          model: state.settings.llmModel,
        });
      } catch (e) {
        console.warn('LLM parse failed, fallback to rules:', e);
      }
    }

    // 3) Офлайн-разбор по правилам — всегда доступный базис.
    if (!drafts) drafts = Parser.parse(raw, state.sections);

    reviewItems = drafts.map((d) => ({
      id: null,
      text: d.text,
      sectionId: d.sectionId,
      priority: d.priority,
      due: d.due,
    }));
    openReview();
  }

  /* ---------------- ЭКРАН ПОДТВЕРЖДЕНИЯ ---------------- */
  function openReview() {
    const list = $('reviewList');
    list.innerHTML = '';
    reviewItems.forEach((item, idx) => list.appendChild(reviewItemEl(item, idx)));
    $('reviewOverlay').hidden = false;
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
          <span class="ri-label">Срок</span>
          <input class="rv-due" type="date" value="${item.due || ''}" />
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
    el.querySelector('.rv-due').onchange = (e) => { reviewItems[idx].due = e.target.value || null; };
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
          await persistTask(t);
        }
      } else {
        await persistTask({
          id: uid(),
          text: item.text.trim(),
          sectionId: item.sectionId,
          priority: item.priority,
          due: item.due || null,
          done: false,
          deleted: false,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
      }
    }
    closeReview();
    render();
    queueSync();
    toast(items.length === 1 ? 'Задача добавлена' : `Добавлено задач: ${items.length}`);
  }

  function openEdit(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    reviewItems = [{ id: t.id, text: t.text, sectionId: t.sectionId, priority: t.priority, due: t.due }];
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
    $('setWebllmEnabled').checked = !!state.settings.webllmEnabled;
    $('setWebllmModel').value = state.settings.webllmModel || 'qwen2.5-1.5b';
    $('webllmStatus').textContent = window.WebLLM && WebLLM.isReady() ? 'Модель загружена и готова.'
      : (window.WebLLM && WebLLM.isSupported() ? '' : 'WebGPU не поддерживается — будет разбор по правилам.');
    $('webllmStatus').className = 'auth-status' + (window.WebLLM && WebLLM.isReady() ? ' ok' : '');
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
    state.settings.webllmEnabled = $('setWebllmEnabled').checked;
    state.settings.webllmModel = $('setWebllmModel').value || 'qwen2.5-1.5b';
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

  async function loadWebllm() {
    const s = $('webllmStatus');
    if (!window.WebLLM || !WebLLM.isSupported()) {
      s.textContent = 'WebGPU не поддерживается этим браузером. Нужен iOS 18+ / современный Chrome. Пока — разбор по правилам.';
      s.className = 'auth-status err';
      return;
    }
    const modelKey = $('setWebllmModel').value || 'qwen2.5-1.5b';
    const bar = $('webllmBar'); const prog = $('webllmProgress');
    prog.hidden = false; bar.style.width = '0%';
    s.textContent = 'Загрузка модели… (первый раз — несколько минут, потом из кэша)';
    s.className = 'auth-status';
    $('btnWebllmLoad').disabled = true;
    try {
      await WebLLM.load(modelKey, (p) => {
        bar.style.width = Math.round((p.progress || 0) * 100) + '%';
        if (p.text) s.textContent = p.text;
      });
      bar.style.width = '100%';
      s.textContent = 'Готово! Модель загружена — умный разбор работает офлайн.';
      s.className = 'auth-status ok';
      state.settings.webllmEnabled = true;
      $('setWebllmEnabled').checked = true;
      await DB.setMeta('settings', state.settings);
    } catch (e) {
      console.error(e);
      s.textContent = 'Не удалось загрузить модель: ' + (e.message || e) + '. Разбор пойдёт по правилам.';
      s.className = 'auth-status err';
    } finally {
      $('btnWebllmLoad').disabled = false;
      setTimeout(() => { prog.hidden = true; }, 1500);
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
      if (!v.trim()) return;
      handleQuickSubmit(v);
      $('quickInput').value = '';
    };
    $('btnMic').onclick = toggleMic;

    document.querySelectorAll('#filters .filter-chip').forEach((c) => {
      c.onclick = () => setFilter(c.dataset.filter);
    });

    $('reviewClose').onclick = closeReview;
    $('reviewCancel').onclick = closeReview;
    $('reviewSave').onclick = saveReview;

    $('btnSettings').onclick = openSettings;
    $('settingsClose').onclick = closeSettings;
    $('settingsSave').onclick = saveSettings;
    $('btnAddSection').onclick = addSection;
    $('btnLlmTest').onclick = testLlm;
    $('btnWebllmLoad').onclick = loadWebllm;

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
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW fail', e));
    }
  }

  boot();
})();
