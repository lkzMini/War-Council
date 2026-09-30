import { searchProfiles, getProfile, getMatches } from './api.js';
import { STRATEGIES, sampleLabel, pct, normalizeMatches, filterMatches, record, aggregate, sessions } from './data.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const dateText = value => value ? new Intl.DateTimeFormat('es-AR', { dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) : 'Fecha desconocida';
const dateShort = value => value ? new Intl.DateTimeFormat('es-AR', { dateStyle:'medium' }).format(new Date(value)) : 'Fecha desconocida';
const unique = values => [...new Set(values.filter(Boolean))].sort((a,b) => String(a).localeCompare(String(b), 'es'));
const country = profile => {
  const value = profile?.countryName;
  if (value && !String(value).startsWith('[country.')) return value;
  return profile?.country || '';
};
const cacheKey = id => `war-council:matches:v1:${id}`;
const noteKey = id => `war-council:notes:v1:${id}`;
const initialFilters = () => ({ allies:[], allAllies:false, civ:'', map:'', result:'', format:'', mode:'', days:0 });
const state = {
  profileId:null, profile:null, matches:[], lastSync:null, cachedLimit:0,
  limit:Number(localStorage.getItem('war-council:limit')) || 100,
  filters:initialFilters(), annotations:{}, searchResults:[], syncing:false,
  shown:25, civSort:'games', mapSort:'games', generation:0
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { toast('El navegador no pudo guardar la caché local.'); }
}
let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3500);
}
function errorMessage(message = '') {
  $('errorMessage').textContent = message;
  $('errorMessage').hidden = !message;
}
function safeImage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'backend.cdn.aoe2companion.com' ? parsed.href : '';
  } catch { return ''; }
}
function readFilters() {
  const q = new URLSearchParams(location.search);
  const filters = initialFilters();
  filters.allies = (q.get('allies') || '').split(',').filter(id => /^\d+$/.test(id)).map(Number);
  filters.allAllies = q.get('all') === '1';
  for (const key of ['civ','map','result','format','mode']) filters[key] = q.get(key) || '';
  filters.days = [7,30,90].includes(Number(q.get('days'))) ? Number(q.get('days')) : 0;
  return filters;
}
function writeURL(push = false) {
  const url = new URL(location.href);
  if (state.profileId) url.searchParams.set('profile', state.profileId);
  else url.searchParams.delete('profile');
  const f = state.filters;
  for (const key of ['allies','all','civ','map','result','format','mode','days']) url.searchParams.delete(key);
  if (f.allies.length) url.searchParams.set('allies', f.allies.join(','));
  if (f.allAllies && f.allies.length > 1) url.searchParams.set('all', '1');
  for (const key of ['civ','map','result','format','mode']) if (f[key]) url.searchParams.set(key, f[key]);
  if (f.days) url.searchParams.set('days', f.days);
  history[push ? 'pushState' : 'replaceState']({}, '', url);
}
function showWorkspace(show) {
  $('workspace').hidden = !show;
  $('searchScreen').hidden = show;
  $('mastActions').hidden = !show;
}
function profileTitle() {
  const profile = state.profile;
  $('profileName').textContent = profile?.name || `Jugador #${state.profileId}`;
  $('profileMeta').textContent = [profile?.platformName || profile?.platform, country(profile), `Profile ID ${state.profileId}`, profile?.steamId ? `Steam ID ${profile.steamId}` : ''].filter(Boolean).join(' · ');
  const leaderboards = (profile?.leaderboards || []).filter(item => Number.isFinite(item.rating)).slice(0,3);
  $('profileRatings').innerHTML = leaderboards.map(item => `<div class="rating"><span>${esc(item.leaderboardId || item.name)}</span><strong>${item.rating}</strong></div>`).join('');
  $('matchLimit').value = String(state.limit);
  $('syncStatus').textContent = state.lastSync ? `Última actualización: ${dateText(state.lastSync)}` : 'Todavía no se sincronizaron partidas.';
}
function restoreCache(id) {
  const cache = loadJSON(cacheKey(id), null);
  if (cache?.version === 1 && String(cache.profileId) === String(id) && Array.isArray(cache.matches)) {
    state.profile = cache.profile || null;
    state.matches = cache.matches;
    state.lastSync = cache.fetchedAt || null;
    state.cachedLimit = cache.limit || 0;
  }
  state.annotations = loadJSON(noteKey(id), {});
}
async function selectProfile(id, profile = null, push = true) {
  if (!/^\d+$/.test(String(id))) return;
  state.generation++;
  state.syncing = false;
  $('syncButton').disabled = false;
  const generation = state.generation;
  state.profileId = String(id);
  state.profile = profile;
  state.matches = [];
  state.lastSync = null;
  state.cachedLimit = 0;
  state.shown = 25;
  state.annotations = {};
  restoreCache(id);
  if (profile) state.profile = profile;
  localStorage.setItem('war-council:profile', state.profileId);
  writeURL(push);
  showWorkspace(true);
  errorMessage();
  profileTitle();
  render();
  try {
    const freshProfile = await getProfile(id);
    if (generation !== state.generation) return;
    state.profile = freshProfile;
    profileTitle();
  } catch (error) {
    if (generation === state.generation) errorMessage(`No se pudo actualizar el perfil: ${error.message}`);
  }
  if (generation !== state.generation) return;
  if (!state.lastSync || Date.now() - Date.parse(state.lastSync) > 30 * 60000 || state.cachedLimit < state.limit) await synchronize();
}
async function synchronize(force = false) {
  if (state.syncing || !state.profileId) return;
  if (!force && state.lastSync && Date.now() - Date.parse(state.lastSync) < 30 * 60000 && state.cachedLimit >= state.limit) return;
  const id = state.profileId;
  const generation = state.generation;
  state.syncing = true;
  $('syncButton').disabled = true;
  errorMessage();
  $('syncStatus').textContent = 'Sincronizando partidas…';
  try {
    const raw = await getMatches(id, state.limit, count => {
      if (generation === state.generation) $('syncStatus').textContent = `Sincronizando… ${count} partidas obtenidas`;
    });
    if (generation !== state.generation) return;
    state.matches = normalizeMatches(raw, id);
    state.lastSync = new Date().toISOString();
    state.cachedLimit = state.limit;
    saveJSON(cacheKey(id), { version:1, profileId:id, profile:state.profile, matches:state.matches, fetchedAt:state.lastSync, limit:state.limit });
    render();
    profileTitle();
  } catch (error) {
    if (generation === state.generation) {
      errorMessage(`No se pudieron actualizar las partidas: ${error.message}${state.matches.length ? ' Se muestra la caché disponible.' : ''}`);
      $('syncStatus').textContent = state.lastSync ? `Caché: ${dateText(state.lastSync)}` : 'Sin datos sincronizados.';
    }
  } finally {
    if (generation === state.generation) {
      state.syncing = false;
      $('syncButton').disabled = false;
      render();
    }
  }
}
function selectOptions(values, selected, allLabel) {
  return `<option value="">${esc(allLabel)}</option>` + values.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function filterSelect(label, name, options) {
  return `<label class="filter-field"><span>${esc(label)}</span><select data-filter="${name}">${options}</select></label>`;
}
function allAllies() {
  const map = new Map();
  for (const match of state.matches) for (const ally of match.allies) map.set(ally.id, ally.name);
  return [...map].sort((a,b) => a[1].localeCompare(b[1], 'es'));
}
function renderFilters(filtered) {
  const f = state.filters;
  const allies = allAllies();
  $('filterControls').innerHTML = `
    <div class="filter-field"><span>Compañeros</span><div class="ally-checks">${allies.length ? allies.map(([id,name]) => `<label><input type="checkbox" data-ally="${id}" ${f.allies.includes(id) ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('') : '<span class="muted">Todavía no hay aliados en este historial.</span>'}</div></div>
    <label class="check-field"><input id="allAllies" type="checkbox" ${f.allAllies ? 'checked' : ''} ${f.allies.length < 2 ? 'disabled' : ''}>Jugamos todos juntos</label>
    ${filterSelect('Civilización','civ',selectOptions(unique(state.matches.map(m => m.self.civ)), f.civ, 'Todas'))}
    ${filterSelect('Mapa','map',selectOptions(unique(state.matches.map(m => m.map)), f.map, 'Todos'))}
    ${filterSelect('Resultado','result',`<option value="">Todos</option><option value="win" ${f.result === 'win' ? 'selected' : ''}>Victorias</option><option value="loss" ${f.result === 'loss' ? 'selected' : ''}>Derrotas</option>`)}
    ${filterSelect('Formato','format',selectOptions(unique(state.matches.map(m => m.format)), f.format, 'Todos'))}
    ${filterSelect('Modo / leaderboard','mode',selectOptions(unique(state.matches.map(m => m.leaderboard)), f.mode, 'Todos'))}
    ${filterSelect('Fecha','days',`<option value="0">Todas</option>${[7,30,90].map(days => `<option value="${days}" ${Number(f.days) === days ? 'selected' : ''}>Últimos ${days} días</option>`).join('')}`)}
  `;
  $('filterCount').textContent = `${filtered.length} de ${state.matches.length} partidas en la muestra`;
}
function card(label, value, detail = '') {
  return `<article class="summary-card panel"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
}
function renderSummary(matches) {
  const r = record(matches);
  const known = matches.filter(m => m.result !== 'unknown');
  const streakType = known[0]?.result;
  const streak = streakType ? known.findIndex(m => m.result !== streakType) : -1;
  const streakCount = streakType ? (streak < 0 ? known.length : streak) : 0;
  const ratingMatch = matches.find(m => Number.isFinite(m.self.rating));
  const rated = ratingMatch ? matches.filter(m => m.leaderboard === ratingMatch.leaderboard && Number.isFinite(m.self.ratingDiff)) : [];
  const change = rated.length ? rated.reduce((total,m) => total + m.self.ratingDiff, 0) : null;
  $('sampleCount').textContent = `${r.games} ${r.games === 1 ? 'partida' : 'partidas'} · ${sampleLabel(r.games)}`;
  $('summaryCards').innerHTML = [
    card('Partidas', r.games, `${r.wins} victorias · ${r.losses} derrotas${r.unknown ? ` · ${r.unknown} sin resultado` : ''}`),
    card('Win rate', r.rate, `${r.wins + r.losses} partidas con resultado`),
    card('Racha reciente', streakCount ? `${streakCount} ${streakType === 'win' ? 'W' : 'L'}` : '—', 'En esta muestra'),
    card('Rating', ratingMatch?.self.rating ?? '—', ratingMatch ? `Último registrado · ${ratingMatch.leaderboard}` : 'No disponible'),
    card('Cambio de rating', change === null ? '—' : `${change > 0 ? '+' : ''}${change}`, ratingMatch ? `Suma de partidas mostradas · ${ratingMatch.leaderboard}` : 'No disponible'),
  ].join('');
  const ten = known.slice(0,10);
  const twentyFive = known.slice(0,25);
  const tenRecord = record(ten);
  const twentyFiveRecord = record(twentyFive);
  $('recentForm').innerHTML = `<div><p class="eyebrow">FORMA RECIENTE</p><h3>Últimas partidas</h3></div><div class="form-sequence">${ten.length ? ten.map(m => `<span class="${m.result}">${m.result === 'win' ? 'W' : 'L'}</span>`).join('') : '<span class="muted">Sin resultados disponibles</span>'}</div><div class="form-records"><span>Últimas 10: <b>${tenRecord.wins}-${tenRecord.losses} · ${tenRecord.rate}</b></span><span>Últimas 25: <b>${twentyFiveRecord.wins}-${twentyFiveRecord.losses} · ${twentyFiveRecord.rate}</b></span><span>Muestra: <b>${r.wins}-${r.losses} · ${r.rate}</b></span></div>`;
}
function statLine(item, action = '', image = '') {
  const known = item.wins + item.losses;
  const imageUrl = safeImage(image);
  return `<button class="stat-line" type="button" ${action}><span class="stat-name">${imageUrl ? `<img src="${esc(imageUrl)}" alt="" loading="lazy">` : ''}<b>${esc(item.key)}</b></span><span>${item.games} partidas <small>· ${sampleLabel(item.games)}</small></span><span>${item.wins}W / ${item.losses}L</span><strong>${pct(item.wins, known)}</strong></button>`;
}
function sortedStats(items, by) {
  return [...items].sort(by === 'rate'
    ? (a,b) => (b.wins/(b.wins+b.losses || 1)) - (a.wins/(a.wins+a.losses || 1)) || b.games - a.games
    : (a,b) => b.games - a.games || a.key.localeCompare(b.key));
}
function renderBreakdown(matches) {
  const civs = aggregate(matches, m => [m.self.civ]);
  const maps = aggregate(matches, m => [m.map]);
  $('civList').innerHTML = civs.length ? sortedStats(civs, state.civSort).map(item => {
    const image = matches.find(m => m.self.civ === item.key)?.self.civImage;
    return statLine(item, `data-pick-civ="${esc(item.key)}"`, image);
  }).join('') : '<p class="empty-inline">Sin datos para estos filtros.</p>';
  $('mapList').innerHTML = maps.length ? sortedStats(maps, state.mapSort).map(item => statLine(item, `data-pick-map="${esc(item.key)}"`)).join('') : '<p class="empty-inline">Sin datos para estos filtros.</p>';
}
function renderAllies(matches) {
  const names = new Map(allAllies());
  const allies = aggregate(matches, m => m.allies.map(a => String(a.id)));
  $('alliesList').innerHTML = allies.length ? allies.map(item => `<button class="ally-card ${state.filters.allies.includes(Number(item.key)) ? 'active' : ''}" data-pick-ally="${esc(item.key)}" type="button"><span class="ally-name">${esc(names.get(Number(item.key)) || `#${item.key}`)}</span><small>Profile ID ${esc(item.key)}</small><strong>${item.games} juntos · ${pct(item.wins,item.wins+item.losses)}</strong><span>${item.wins}W / ${item.losses}L · ${sampleLabel(item.games)}</span></button>`).join('') : '<p class="empty-inline">No hay aliados en la muestra. Los rivales nunca se cuentan acá.</p>';
}
function comboGroup(title, items) {
  return `<div class="combo-column"><h3>${esc(title)}</h3>${items.length ? items.slice(0,6).map(item => `<div class="combo-row"><b>${esc(item.key.replaceAll('\u001f',' · '))}</b><span>${item.games} partidas · ${item.wins}W / ${item.losses}L · ${pct(item.wins,item.wins+item.losses)}</span><small>${sampleLabel(item.games)}</small></div>`).join('') : '<p class="empty-inline">Sin combinaciones suficientes.</p>'}</div>`;
}
function renderCombos(matches) {
  const civMap = aggregate(matches, m => [`${m.self.civ}\u001f${m.map}`]);
  const friendMap = aggregate(matches, m => m.allies.map(a => `${a.name}\u001f${m.map}`));
  const friendCiv = aggregate(matches, m => m.allies.map(a => `${a.name}\u001f${m.self.civ}`)).filter(item => item.games >= 3);
  $('combinationList').innerHTML = comboGroup('Civilización + mapa', civMap) + comboGroup('Compañero + mapa', friendMap) + comboGroup('Compañero + civilización · 3+ partidas', friendCiv);
}
function renderSessions(matches) {
  const groups = sessions(matches);
  $('sessionList').innerHTML = groups.length ? groups.slice(0,12).map(group => {
    const r = record(group.matches);
    const maps = unique(group.matches.map(m => m.map)).slice(0,4);
    const civs = unique(group.matches.map(m => m.self.civ)).slice(0,4);
    const allies = unique(group.matches.flatMap(m => m.allies.map(a => a.name))).slice(0,5);
    return `<article class="session-row"><div><strong>${esc(dateText(group.newest))}</strong><small>${r.games} partidas · ${r.wins}W / ${r.losses}L · ${r.rate}</small></div><div><span>Mapas</span><p>${esc(maps.join(' · ') || '—')}</p></div><div><span>Civs</span><p>${esc(civs.join(' · ') || '—')}</p></div><div><span>Aliados</span><p>${esc(allies.join(' · ') || '—')}</p></div></article>`;
  }).join('') : '<p class="empty-inline">No hay sesiones para estos filtros.</p>';
}
function renderHistory(matches) {
  $('historyCount').textContent = `${matches.length} partidas`;
  $('historyList').innerHTML = matches.length ? matches.slice(0,state.shown).map(m => {
    const result = m.result === 'win' ? 'Victoria' : m.result === 'loss' ? 'Derrota' : 'Sin resultado';
    const diff = Number.isFinite(m.self.ratingDiff) ? ` (${m.self.ratingDiff > 0 ? '+' : ''}${m.self.ratingDiff})` : '';
    return `<button type="button" class="history-row" data-match="${m.id}"><span class="history-result ${m.result}">${result}</span><span><b>${esc(m.map)}</b><small>${esc(dateShort(m.started))} · ${esc(m.format)} · ${esc(m.leaderboard)}</small></span><span><b>${esc(m.self.civ)}</b><small>Aliados: ${esc(m.allies.map(a => a.name).join(', ') || '—')}</small></span><span><small>Rivales: ${esc(m.opponents.map(p => p.name).join(', ') || '—')}</small><small>Rating: ${m.self.rating ?? '—'}${diff}</small></span><span class="history-arrow">›</span></button>`;
  }).join('') : '<p class="empty-inline">Ninguna partida coincide con estos filtros.</p>';
  $('moreHistory').hidden = matches.length <= state.shown;
}
function render() {
  profileTitle();
  $('dataArea').hidden = !state.matches.length;
  $('emptyMessage').hidden = !!state.matches.length || state.syncing;
  if (!state.matches.length && !state.syncing) $('emptyMessage').textContent = state.lastSync ? 'Este perfil no tiene partidas públicas recientes.' : 'Sin partidas todavía. La sincronización empezará en un momento.';
  if (!state.matches.length) return;
  const matches = filterMatches(state.matches, state.filters);
  renderFilters(matches);
  renderSummary(matches);
  renderAllies(matches);
  renderBreakdown(matches);
  renderCombos(matches);
  renderSessions(matches);
  renderHistory(matches);
}
function updateFilter() {
  state.shown = 25;
  writeURL();
  render();
}
function changePlayer() {
  state.generation++;
  state.syncing = false;
  $('syncButton').disabled = false;
  state.profileId = null;
  state.profile = null;
  state.matches = [];
  state.filters = initialFilters();
  localStorage.removeItem('war-council:profile');
  writeURL(true);
  errorMessage();
  showWorkspace(false);
  $('searchInput').focus();
}
function openMatch(id) {
  const match = state.matches.find(m => m.id === Number(id));
  if (!match) return;
  $('dialogTitle').textContent = `${match.map} · ${match.format}`;
  const note = state.annotations[id] || {};
  const result = match.result === 'win' ? 'Victoria' : match.result === 'loss' ? 'Derrota' : 'Sin resultado';
  $('dialogBody').innerHTML = `<div class="match-facts"><div><span>Resultado</span><b>${result}</b></div><div><span>Fecha</span><b>${esc(dateText(match.started))}</b></div><div><span>Duración</span><b>${match.duration != null ? `${match.duration} min` : '—'}</b></div><div><span>Modo</span><b>${esc(match.mode)} · ${esc(match.leaderboard)}</b></div><div><span>Match ID</span><b>${match.id}</b></div></div>
    <div class="teams">${match.teams.map((team,index) => `<section class="team"><h3>Equipo ${esc(team.id ?? index+1)}</h3>${team.players.map(p => `<div class="team-player"><span>${esc(p.name)}${p.id === Number(state.profileId) ? ' · vos' : ''}</span><small>${esc(p.civ)} · rating ${p.rating ?? '—'}${p.ratingDiff != null ? ` (${p.ratingDiff > 0 ? '+' : ''}${p.ratingDiff})` : ''} · ${p.won === true ? 'W' : p.won === false ? 'L' : '—'}</small></div>`).join('')}</section>`).join('')}</div>
    <div class="annotation"><p class="eyebrow">ANOTACIÓN LOCAL · NO PROVIENE DE LA API</p><label>Estrategia<select id="strategyInput"><option value="">Sin etiqueta</option>${STRATEGIES.map(tag => `<option value="${esc(tag)}" ${note.strategy === tag ? 'selected' : ''}>${esc(tag)}</option>`).join('')}</select></label><label>Nota corta<textarea id="noteInput" maxlength="500" placeholder="¿Qué aprendiste de esta partida?">${esc(note.note || '')}</textarea></label><button class="button gold" id="saveNote" type="button">Guardar anotación</button></div>`;
  $('matchDialog').showModal();
  $('saveNote').onclick = () => {
    state.annotations[id] = { strategy:$('strategyInput').value, note:$('noteInput').value.trim() };
    saveJSON(noteKey(state.profileId), state.annotations);
    toast('Anotación guardada sólo en este navegador.');
    $('matchDialog').close();
  };
}

$('searchForm').addEventListener('submit', async event => {
  event.preventDefault();
  const query = $('searchInput').value.trim();
  $('searchStatus').textContent = 'Buscando jugadores…';
  $('searchResults').innerHTML = '';
  try {
    state.searchResults = await searchProfiles(query);
    $('searchStatus').textContent = state.searchResults.length ? `${state.searchResults.length} resultado(s). Elegí el perfil correcto.` : 'No se encontraron jugadores con esos datos.';
    $('searchResults').innerHTML = state.searchResults.map((p,index) => `<button type="button" class="search-result" data-search-index="${index}"><span><strong>${esc(p.name || `#${p.profileId}`)}</strong><small>${esc(p.platformName || p.platform || 'Plataforma desconocida')} · ${esc(country(p) || 'País desconocido')} · Profile ID ${esc(p.profileId)}${p.steamId ? ` · Steam ID ${esc(p.steamId)}` : ''}${p.games ? ` · ${esc(p.games)} partidas` : ''}</small></span><span class="pick">Elegir ›</span></button>`).join('');
  } catch (error) { $('searchStatus').textContent = `Error al buscar: ${error.message}`; }
});
$('searchResults').addEventListener('click', event => {
  const button = event.target.closest('[data-search-index]');
  if (button) {
    const profile = state.searchResults[Number(button.dataset.searchIndex)];
    state.filters = initialFilters();
    selectProfile(profile.profileId, profile);
  }
});
$('changePlayer').addEventListener('click', changePlayer);
$('syncButton').addEventListener('click', () => synchronize(true));
$('matchLimit').addEventListener('change', event => {
  state.limit = Number(event.target.value);
  localStorage.setItem('war-council:limit', String(state.limit));
  synchronize(true);
});
$('clearFilters').addEventListener('click', () => { state.filters = initialFilters(); updateFilter(); });
$('filterControls').addEventListener('change', event => {
  const target = event.target;
  if (target.dataset.ally) {
    const id = Number(target.dataset.ally);
    state.filters.allies = target.checked ? unique([...state.filters.allies,id]) : state.filters.allies.filter(value => value !== id);
    if (state.filters.allies.length < 2) state.filters.allAllies = false;
  } else if (target.id === 'allAllies') state.filters.allAllies = target.checked;
  else if (target.dataset.filter) state.filters[target.dataset.filter] = target.dataset.filter === 'days' ? Number(target.value) : target.value;
  updateFilter();
});
$('alliesList').addEventListener('click', event => {
  const button = event.target.closest('[data-pick-ally]');
  if (!button) return;
  const id = Number(button.dataset.pickAlly);
  state.filters.allies = state.filters.allies.includes(id) ? state.filters.allies.filter(value => value !== id) : [...state.filters.allies,id];
  if (state.filters.allies.length < 2) state.filters.allAllies = false;
  updateFilter();
});
$('civList').addEventListener('click', event => {
  const button = event.target.closest('[data-pick-civ]');
  if (button) { state.filters.civ = state.filters.civ === button.dataset.pickCiv ? '' : button.dataset.pickCiv; updateFilter(); }
});
$('mapList').addEventListener('click', event => {
  const button = event.target.closest('[data-pick-map]');
  if (button) { state.filters.map = state.filters.map === button.dataset.pickMap ? '' : button.dataset.pickMap; updateFilter(); }
});
$('civSort').addEventListener('change', event => { state.civSort = event.target.value; render(); });
$('mapSort').addEventListener('change', event => { state.mapSort = event.target.value; render(); });
$('moreHistory').addEventListener('click', () => { state.shown += 25; renderHistory(filterMatches(state.matches,state.filters)); });
$('historyList').addEventListener('click', event => {
  const button = event.target.closest('[data-match]');
  if (button) openMatch(button.dataset.match);
});
$('closeDialog').addEventListener('click', () => $('matchDialog').close());
$('matchDialog').addEventListener('click', event => { if (event.target === $('matchDialog')) $('matchDialog').close(); });
$('shareButton').addEventListener('click', async () => {
  const url = new URL(location.href);
  url.hash = '';
  try { await navigator.clipboard.writeText(url.href); toast('Enlace copiado con el perfil y filtros actuales.'); }
  catch { toast('Copiá la URL de la barra del navegador para compartir.'); }
});
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('profile');
  state.filters = readFilters();
  if (id && /^\d+$/.test(id) && id !== state.profileId) selectProfile(id,null,false);
  else if (!id) changePlayer();
  else render();
});

state.filters = readFilters();
const urlId = new URLSearchParams(location.search).get('profile');
const savedId = localStorage.getItem('war-council:profile');
const initialId = /^\d+$/.test(urlId || '') ? urlId : /^\d+$/.test(savedId || '') ? savedId : null;
if (initialId) selectProfile(initialId,null,false);
else showWorkspace(false);
