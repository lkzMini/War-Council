const BASE = 'https://data.aoe2companion.com/api';
const pending = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function request(path) {
  if (pending.has(path)) return pending.get(path);
  const task = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(BASE + path, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            await pause((attempt + 1) * 900);
            continue;
          }
          throw new Error(`La API respondió HTTP ${response.status}. Intentá de nuevo más tarde.`);
        }
        return await response.json();
      } catch (error) {
        if (attempt === 2 || (error.message.startsWith('La API'))) {
          if (error.name === 'AbortError') throw new Error('La API tardó demasiado en responder.');
          if (error instanceof TypeError) throw new Error('No se pudo conectar con AoE II Companion. Revisá tu conexión.');
          throw error;
        }
        await pause((attempt + 1) * 900);
      } finally {
        clearTimeout(timer);
      }
    }
  })();
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
    catch (error) { if (/HTTP 404/.test(error.message)) return []; throw error; }
  }
  const data = await request(`/profiles?search=${encodeURIComponent(term)}&page=1&per_page=20`);
  return data.profiles || [];
}

export const getProfile = id => request(`/profiles/${encodeURIComponent(id)}`);

export async function getMatches(id, limit, onProgress = () => {}) {
  const result = new Map();
  const pageSize = 50;
  for (let page = 1; result.size < limit; page++) {
    const data = await request(`/matches?profile_ids=${encodeURIComponent(id)}&page=${page}&per_page=${pageSize}`);
    const pageMatches = Array.isArray(data.matches) ? data.matches : [];
    for (const match of pageMatches) {
      if (match.matchId != null) result.set(String(match.matchId), match);
    }
    onProgress(Math.min(result.size, limit));
    if (pageMatches.length < pageSize || (data.hasMore === false) || page >= Math.ceil(limit / pageSize)) break;
  }
  return [...result.values()].slice(0, limit);
}
