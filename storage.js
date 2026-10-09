const DB_NAME = 'war-council-history';
const DB_VERSION = 1;
let opening;

function openDatabase() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Este navegador no ofrece IndexedDB.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const matches = db.createObjectStore('matches', { keyPath:['profileId','id'] });
      matches.createIndex('byProfile', 'profileId');
      matches.createIndex('byProfileStarted', ['profileId','sortKey']);
      db.createObjectStore('meta', { keyPath:'profileId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('No se pudo abrir IndexedDB.'));
    request.onblocked = () => reject(new Error('Otra pestaña bloquea la actualización de la caché.'));
  }).catch(error => { opening = null; throw error; });
  return opening;
}
const fromRequest = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const fromTransaction = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error('Error al guardar el historial.'));
  transaction.onabort = () => reject(transaction.error || new Error('Guardado interrumpido.'));
});

export const historyStore = {
  async getMeta(profileId) {
    const db = await openDatabase();
    return await fromRequest(db.transaction('meta').objectStore('meta').get(String(profileId))) || null;
  },
  async count(profileId) {
    const db = await openDatabase();
    const tx = db.transaction('matches');
    return fromRequest(tx.objectStore('matches').index('byProfile').count(IDBKeyRange.only(String(profileId))));
  },
  async getRecent(profileId, limit) {
    const db = await openDatabase();
    const tx = db.transaction('matches');
    const range = IDBKeyRange.bound([String(profileId),''], [String(profileId),'\uffff']);
    const cursor = tx.objectStore('matches').index('byProfileStarted').openCursor(range, 'prev');
    return new Promise((resolve, reject) => {
      const matches = [];
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || matches.length >= limit) { resolve(matches); return; }
        matches.push(current.value);
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  },
  async getAll(profileId) {
    const db = await openDatabase();
    const tx = db.transaction('matches');
    return fromRequest(tx.objectStore('matches').index('byProfile').getAll(IDBKeyRange.only(String(profileId))));
  },
  async savePage(profileId, matches, patch = {}) {
    const id = String(profileId);
    const db = await openDatabase();
    const tx = db.transaction(['matches','meta'], 'readwrite');
    const finished = fromTransaction(tx);
    const matchStore = tx.objectStore('matches');
    const metaStore = tx.objectStore('meta');
    const current = metaStore.get(id);
    current.onsuccess = () => metaStore.put({ ...(current.result || { profileId:id }), ...patch, profileId:id });
    for (const match of matches) {
      if (!Number.isFinite(match.id)) continue;
      matchStore.put({ ...match, profileId:id, sortKey:match.started || '' });
    }
    await finished;
    return this.count(id);
  },
  async migrateLegacy(profileId, cache) {
    if (!cache?.matches?.length || await this.getMeta(profileId)) return false;
    await this.savePage(profileId, cache.matches, {
      profile:cache.profile || null, lastSync:cache.fetchedAt || null,
      complete:false, nextPage:1, headId:null, pageSize:200, total:null,
      recentLimit:cache.limit || cache.matches.length,
    });
    return true;
  },
};
