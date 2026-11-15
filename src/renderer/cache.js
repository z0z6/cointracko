'use strict';
// Trwała pamięć podręczna w IndexedDB (historia cen na 6 lat, wykaz feedów oracle, wiadomości).
// Gdy IndexedDB jest niedostępne (np. testy), działa w pamięci.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KVCache = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DB = 'cointracko-cache';
  const STORE = 'kv';
  const MAX_ENTRIES = 400;

  function create(idb) {
    const mem = new Map();
    let dbp = null;
    const open = () => {
      if (!idb) return Promise.resolve(null);
      if (!dbp) {
        dbp = new Promise((resolve) => {
          try {
            const req = idb.open(DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
          } catch (_) { resolve(null); }
        });
      }
      return dbp;
    };
    const tx = (db, mode, fn) => new Promise((resolve, reject) => {
      try {
        const t = db.transaction(STORE, mode);
        const st = t.objectStore(STORE);
        const r = fn(st);
        t.oncomplete = () => resolve(r && r.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      } catch (e) { reject(e); }
    });

    return {
      // → wartość albo null, gdy brak lub starsza niż maxAgeMs
      async get(key, maxAgeMs = Infinity) {
        const db = await open();
        let rec = mem.get(key);
        if (!rec && db) { try { rec = await tx(db, 'readonly', (s) => s.get(key)); } catch (_) { rec = null; } }
        if (!rec || typeof rec.at !== 'number') return null;
        return Date.now() - rec.at <= maxAgeMs ? rec.value : null;
      },
      async set(key, value) {
        const rec = { at: Date.now(), value };
        mem.set(key, rec);
        if (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value);
        const db = await open();
        if (db) { try { await tx(db, 'readwrite', (s) => s.put(rec, key)); } catch (_) { /* pamięć podręczna jest opcjonalna */ } }
      },
      async clear() {
        mem.clear();
        const db = await open();
        if (db) { try { await tx(db, 'readwrite', (s) => s.clear()); } catch (_) { /* ignore */ } }
      }
    };
  }

  return { create, default: typeof indexedDB !== 'undefined' ? create(indexedDB) : create(null) };
});
