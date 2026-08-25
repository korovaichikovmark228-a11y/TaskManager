/* ============================================================
   sync.js — необязательная синхронизация через Supabase.
   Загружает клиент Supabase с CDN только когда настроен URL+ключ.
   Стратегия конфликтов: «последняя правка побеждает» (по updatedAt).
   Работает поверх офлайн-хранилища: локально всё живёт и без сети.
   ============================================================ */
(function (global) {
  'use strict';

  const CDN = 'https://esm.sh/@supabase/supabase-js@2';

  let client = null;
  let cfg = { url: '', key: '' };
  let session = null;

  function isConfigured() { return !!(cfg.url && cfg.key); }
  function currentUser() { return session ? session.user : null; }

  async function init(url, key) {
    cfg.url = (url || '').trim();
    cfg.key = (key || '').trim();
    if (!isConfigured()) { client = null; session = null; return false; }
    try {
      const mod = await import(/* @vite-ignore */ CDN);
      client = mod.createClient(cfg.url, cfg.key, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tasks-sb-auth' },
      });
      const { data } = await client.auth.getSession();
      session = data.session || null;
      client.auth.onAuthStateChange((_e, s) => { session = s; });
      return true;
    } catch (e) {
      console.error('Supabase init failed', e);
      client = null;
      throw e;
    }
  }

  async function signUp(email, password) {
    if (!client) throw new Error('Синхронизация не настроена');
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    session = data.session || null;
    return data;
  }
  async function signIn(email, password) {
    if (!client) throw new Error('Синхронизация не настроена');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    session = data.session || null;
    return data;
  }
  async function signOut() {
    if (client) await client.auth.signOut();
    session = null;
  }

  // Забирает удалённые задачи пользователя
  async function pullRemote() {
    if (!client || !session) return [];
    const { data, error } = await client
      .from('tasks')
      .select('*')
      .eq('user_id', session.user.id);
    if (error) throw error;
    return (data || []).map(rowToTask);
  }

  // true, если колонки subtasks нет в таблице (старая схема) — тогда шлём без неё.
  let noSubtasksCol = false;
  function isMissingSubtasksErr(e) {
    const m = ((e && (e.message || e.hint || e.details)) || '').toLowerCase();
    return m.includes('subtasks') && (m.includes('column') || m.includes('schema') || (e && e.code === 'PGRST204'));
  }

  async function pushRemote(tasks) {
    if (!client || !session || !tasks.length) return;
    const rows = tasks.map((t) => taskToRow(t, session.user.id));
    if (noSubtasksCol) rows.forEach((r) => { delete r.subtasks; });
    let { error } = await client.from('tasks').upsert(rows, { onConflict: 'id' });
    if (error && isMissingSubtasksErr(error)) {
      // Колонки subtasks ещё нет в БД — повторяем без неё, дальше не шлём.
      noSubtasksCol = true;
      rows.forEach((r) => { delete r.subtasks; });
      ({ error } = await client.from('tasks').upsert(rows, { onConflict: 'id' }));
    }
    if (error) throw error;
  }

  function rowToTask(r) {
    return {
      id: r.id,
      text: r.text,
      sectionId: r.section_id,
      priority: r.priority,
      due: r.due,
      time: r.time || null,
      subtasks: parseSubtasks(r.subtasks),
      done: !!r.done,
      deleted: !!r.deleted,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  function parseSubtasks(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
    }
    return [];
  }
  function taskToRow(t, userId) {
    return {
      id: t.id,
      user_id: userId,
      text: t.text,
      section_id: t.sectionId,
      priority: t.priority,
      due: t.due || null,
      time: t.time || null,
      subtasks: JSON.stringify(Array.isArray(t.subtasks) ? t.subtasks : []),
      done: !!t.done,
      deleted: !!t.deleted,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    };
  }

  /* Двусторонняя синхронизация:
     localTasks — текущие локальные задачи.
     Возвращает { merged, toSaveLocally } — что записать в IndexedDB. */
  async function sync(localTasks) {
    if (!client || !session) throw new Error('Нет входа');
    const remote = await pullRemote();
    const remoteMap = new Map(remote.map((t) => [t.id, t]));
    const localMap = new Map(localTasks.map((t) => [t.id, t]));

    const toSaveLocally = [];
    const toPush = [];
    const ids = new Set([...remoteMap.keys(), ...localMap.keys()]);

    for (const id of ids) {
      const r = remoteMap.get(id);
      const l = localMap.get(id);
      if (r && !l) { toSaveLocally.push(r); }
      else if (l && !r) { toPush.push(l); }
      else if (l && r) {
        const lt = l.updatedAt || '';
        const rt = r.updatedAt || '';
        if (lt > rt) toPush.push(l);
        else if (rt > lt) toSaveLocally.push(r);
      }
    }

    if (toPush.length) await pushRemote(toPush);
    return { toSaveLocally, pushed: toPush.length, pulled: toSaveLocally.length };
  }

  global.Sync = {
    init, isConfigured, currentUser,
    signUp, signIn, signOut, sync, pushRemote,
  };
})(window);
