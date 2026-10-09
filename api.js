const BASE = 'https://data.aoe2companion.com/api';
const pending = new Map();

export const abortError = () => new DOMException('Descarga cancelada.', 'AbortError');
export function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once:true });
  });
}
function retryDelay(response, attempt) {
  const header = response?.headers?.get?.('Retry-After');
  const seconds = Number(header);
  const retryAt = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  const hinted = Number.isFinite(retryAt) && retryAt > 0 ? retryAt : 0;
  return Math.min(30000, Math.max(hinted, 1000 * 2 ** attempt));
}
async function doRequest(path, signal) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once:true });
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(BASE + path, {
        headers: { Accept:'application/json' },
        signal:controller.signal,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        clearTimeout(timer);
        await pause(retryDelay(response, attempt), signal);
        continue;
      }
      if (!response.ok) {
        const error = new Error(`La API respondió HTTP ${response.status}. Intentá de nuevo más tarde.`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error.status) throw error;
      if (attempt === 3) {
        if (error.name === 'AbortError') throw new Error('La API tardó demasiado en responder.');
        if (error instanceof TypeError) throw new Error('No se pudo conectar con AoE II Companion. Revisá tu conexión.');
        throw error;
      }
      await pause(1000 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}
export async function request(path, { signal } = {}) {
  if (signal) return doRequest(path, signal);
  if (pending.has(path)) return pending.get(path);
  const task = doRequest(path);
  pending.set(path, task);
  try { return await task; } finally { pending.delete(path); }
}

export async function searchProfiles(query) {
  const term = query.trim();
  if (!term) return [];
  if (/^\d{17}$/.test(term)) {
    const data = await request(`/profiles?steam_id=${term}&page=1&per_page=20`);
    return data.profiles || [];
  }
  if (/^\d+$/.test(term)) {
    try { return [await request(`/profiles/${term}`)]; }
    catch (error) { if (error.status === 404) return []; throw error; }
  }
  const data = await request(`/profiles?search=${encodeURIComponent(term)}&page=1&per_page=20`);
  return data.profiles || [];
}

export const getProfile = id => request(`/profiles/${encodeURIComponent(id)}`);

export async function fetchMatchPage(id, page, perPage, { signal } = {}) {
  const data = await request(`/matches?profile_ids=${encodeURIComponent(id)}&page=${page}&per_page=${perPage}`, { signal });
  if (!Array.isArray(data.matches)) throw new Error('La API devolvió una página de partidas inválida.');
  return {
    matches:data.matches,
    total:Number.isFinite(data.total) ? data.total : null,
    hasMore:typeof data.hasMore === 'boolean' ? data.hasMore : null,
    perPage:Number.isInteger(data.perPage) && data.perPage > 0 ? data.perPage : perPage,
  };
}

export async function getMatches(id, limit, onProgress = () => {}, { signal } = {}) {
  const result = new Map();
  const pageSize = 50;
  for (let page = 1; result.size < limit; page++) {
    const data = await fetchMatchPage(id, page, pageSize, { signal });
    for (const match of data.matches) {
      if (match.matchId != null) result.set(String(match.matchId), match);
    }
    onProgress(Math.min(result.size, limit));
    if (data.matches.length < data.perPage || data.hasMore === false || page >= Math.ceil(limit / pageSize)) break;
  }
  return [...result.values()].slice(0, limit);
}
