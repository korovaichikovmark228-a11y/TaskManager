/* ============================================================
   db.js — локальное хранилище на IndexedDB
   Хранит задачи, разделы и настройки. Полностью офлайн.
   ============================================================ */
(function (global) {
  'use strict';

  const DB_NAME = 'tasks-app';
  const DB_VERSION = 1;
  const STORE_TASKS = 'tasks';
  const STORE_SECTIONS = 'sections';
  const STORE_META = 'meta';

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_TASKS)) {
          const s = db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
          s.createIndex('sectionId', 'sectionId', { unique: false });
          s.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SECTIONS)) {
          db.createObjectStore(STORE_SECTIONS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getAll(store) {
    return tx(store, 'readonly').then((os) => reqToPromise(os.getAll()));
  }
  function put(store, value) {
    return tx(store, 'readwrite').then((os) => reqToPromise(os.put(value)));
  }
  function bulkPut(store, values) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const os = t.objectStore(store);
      values.forEach((v) => os.put(v));
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    }));
  }
  function del(store, key) {
    return tx(store, 'readwrite').then((os) => reqToPromise(os.delete(key)));
  }
  function getMeta(key, fallback) {
    return tx(STORE_META, 'readonly')
      .then((os) => reqToPromise(os.get(key)))
      .then((row) => (row ? row.value : fallback));
  }
  function setMeta(key, value) {
    return put(STORE_META, { key, value });
  }

  // Публичное API
  global.DB = {
    STORE_TASKS, STORE_SECTIONS, STORE_META,
    open,
    getTasks: () => getAll(STORE_TASKS),
    putTask: (t) => put(STORE_TASKS, t),
    bulkPutTasks: (arr) => bulkPut(STORE_TASKS, arr),
    deleteTask: (id) => del(STORE_TASKS, id),
    getSections: () => getAll(STORE_SECTIONS),
    putSection: (s) => put(STORE_SECTIONS, s),
    bulkPutSections: (arr) => bulkPut(STORE_SECTIONS, arr),
    deleteSection: (id) => del(STORE_SECTIONS, id),
    getMeta, setMeta,
  };
})(window);
