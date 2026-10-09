import { abortError, fetchMatchPage, getMatches, pause } from './api.js';
import { normalizeMatches } from './data.js';

const timestamp = match => Date.parse(match.started || 0) || 0;
export function mergeMatches(existing, incoming) {
  const byId = new Map();
  for (const match of [...existing, ...incoming]) byId.set(match.id, match);
  return [...byId.values()].sort((a,b) => timestamp(b) - timestamp(a) || b.id - a.id);
}
const signature = page => page.length ? `${page.length}:${page[0].matchId}:${page.at(-1).matchId}` : 'empty';

export async function downloadFullHistory({
  profileId, store, fetchPage = fetchMatchPage, signal, onProgress = () => {},
  onPage = () => {}, wait = pause, pageSize = 200, paceMs = 350, maxPages = 10000,
}) {
  let meta = await store.getMeta(profileId) || { profileId:String(profileId), complete:false, nextPage:1 };
  if (meta.complete) {
    const count = await store.count(profileId);
    onProgress({ status:'complete', count, total:meta.total ?? null });
    return { count, complete:true, total:meta.total ?? null };
  }
  const seen = new Set();
  const seenIds = new Set();
  let page = 1;
  let resumePage = Number.isInteger(meta.nextPage) && meta.nextPage > 1 && meta.pageSize === pageSize ? meta.nextPage : 1;
  let lastSignature = resumePage > 1 ? meta.lastSignature : null;
  while (page <= maxPages) {
    if (signal?.aborted) throw abortError();
    const data = await fetchPage(profileId, page, pageSize, { signal });
    const raw = data.matches;
    const currentSignature = signature(raw);
    const ids = raw.map(match => match.matchId).filter(id => id != null);
    if (raw.length && (!ids.length || (page !== 1 && ids.every(id => seenIds.has(id))))) {
      throw new Error(`La API no avanzó en la página ${page}; la descarga quedó parcial.`);
    }
    if (page === 1 && !raw.length && await store.count(profileId)) {
      throw new Error('La API devolvió una primera página vacía para un historial ya guardado; no se marcó como completo.');
    }
    if (seen.has(currentSignature) || (page !== 1 && currentSignature === lastSignature)) {
      throw new Error(`La API repitió la página ${page}; la descarga quedó parcial para evitar un bucle.`);
    }
    seen.add(currentSignature);
    for (const id of ids) seenIds.add(id);
    const headId = raw[0]?.matchId != null ? String(raw[0].matchId) : null;
    if (page === 1 && resumePage > 1 && (String(meta.headId) !== headId)) {
      resumePage = 1;
      lastSignature = null;
    }
    const resumeCheck = page === 1 && resumePage > 1;
    const normalized = normalizeMatches(raw, profileId);
    const effectiveSize = data.perPage || pageSize;
    const complete = raw.length === 0 || data.hasMore === false || raw.length < effectiveSize;
    const nextPage = complete ? null : page + 1;
    const patch = {
      complete, nextPage:page === 1 && resumePage > 1 && !complete ? resumePage : nextPage,
      headId:page === 1 ? headId : meta.headId,
      lastSignature:resumeCheck ? meta.lastSignature : currentSignature,
      pageSize, total:data.total ?? meta.total ?? null,
      lastSync:new Date().toISOString(),
    };
    const count = await store.savePage(profileId, normalized, patch);
    meta = { ...meta, ...patch };
    await onPage({ page, matches:normalized, count, complete, total:meta.total });
    onProgress({ status:complete ? 'complete' : 'loading', page, count, total:meta.total });
    if (complete) return { count, complete:true, total:meta.total };
    lastSignature = patch.lastSignature;
    page = page === 1 && resumePage > 1 ? resumePage : nextPage;
    if (page <= maxPages) await wait(paceMs, signal);
  }
  throw new Error('Se alcanzó el límite de seguridad de páginas; el historial sigue parcial.');
}

export async function refreshRecent({
  profileId, limit, store, fetchMatches = getMatches, signal, onProgress = () => {},
}) {
  const meta = await store.getMeta(profileId) || { profileId:String(profileId), complete:false, nextPage:1 };
  const previous = await store.getRecent(profileId, Math.max(limit, 200));
  const known = new Set(previous.map(match => match.id));
  const raw = await fetchMatches(profileId, limit, onProgress, { signal });
  const incoming = normalizeMatches(raw, profileId);
  const overlap = incoming.some(match => known.has(match.id));
  const firstId = incoming[0]?.id == null ? null : String(incoming[0].id);
  const headChanged = !!meta.headId && meta.headId !== firstId;
  const complete = !!meta.complete && (overlap || (!previous.length && !incoming.length));
  const patch = {
    lastSync:new Date().toISOString(),
    recentLimit:Math.max(limit, meta.recentLimit || 0),
    complete,
    nextPage:complete ? null : headChanged ? 1 : meta.nextPage || 1,
    headId:firstId || meta.headId || null,
    pageSize:meta.pageSize || 200,
  };
  const count = await store.savePage(profileId, incoming, patch);
  return { matches:incoming, count, meta:{ ...meta, ...patch }, overlap };
}
