export const STRATEGIES = ['Drush', 'Men-at-Arms', 'Scouts', 'Archers', 'Fast Castle', 'Boom', 'Castle Drop', 'Siege Push', 'Fast Imperial', 'Other'];
export const sampleLabel = count => count <= 2 ? 'Muestra insuficiente' : count <= 5 ? 'Muestra pequeña' : 'Muestra útil';
export const pct = (wins, games) => games ? `${(wins / games * 100).toFixed(1)}%` : '—';

const player = raw => ({
  id: Number(raw.profileId), name: raw.name || `#${raw.profileId}`,
  civ: raw.civName || raw.civ || 'Desconocida', civImage: raw.civImageUrl || '',
  rating: Number.isFinite(raw.rating) ? raw.rating : null,
  ratingDiff: Number.isFinite(raw.ratingDiff) ? raw.ratingDiff : null,
  won: typeof raw.won === 'boolean' ? raw.won : null,
});

export function normalizeMatch(raw, profileId) {
  if (!Array.isArray(raw.teams) || !raw.matchId) return null;
  const teams = raw.teams.map(team => ({
    id: team.teamId,
    players: (team.players || []).map(player),
  }));
  const own = teams.find(team => team.players.some(p => p.id === Number(profileId)));
  const self = own?.players.find(p => p.id === Number(profileId));
  if (!self) return null;
  const opponents = teams.filter(team => team !== own).flatMap(team => team.players);
  const allies = own.players.filter(p => p.id !== self.id);
  const sizes = teams.map(team => team.players.length);
  const format = teams.length === 2 && sizes[0] === sizes[1] && sizes[0] >= 1 && sizes[0] <= 4
    ? `${sizes[0]}v${sizes[1]}` : sizes.join('v') || 'Otro';
  const started = raw.started || null;
  const finished = raw.finished || null;
  const duration = started && finished ? Math.max(0, Math.round((Date.parse(finished) - Date.parse(started)) / 60000)) : null;
  return {
    id: Number(raw.matchId), started, finished, duration,
    map: raw.mapName || raw.map || 'Mapa desconocido', mapImage: raw.mapImageUrl || '',
    mode: raw.gameModeName || raw.gameMode || 'Desconocido',
    leaderboard: raw.leaderboardName || raw.leaderboard || 'Sin leaderboard',
    format, teams, self, allies, opponents,
    result: self.won === true ? 'win' : self.won === false ? 'loss' : 'unknown',
  };
}

export function normalizeMatches(rawMatches, profileId) {
  return rawMatches.map(match => normalizeMatch(match, profileId)).filter(Boolean)
    .sort((a, b) => Date.parse(b.started || 0) - Date.parse(a.started || 0));
}

export function filterMatches(matches, filters) {
  const now = Date.now();
  return matches.filter(match => {
    if (filters.allies?.length) {
      const present = new Set(match.allies.map(p => p.id));
      const selected = filters.allies.map(Number);
      if (filters.allAllies ? !selected.every(id => present.has(id)) : !selected.some(id => present.has(id))) return false;
    }
    if (filters.civ && match.self.civ !== filters.civ) return false;
    if (filters.map && match.map !== filters.map) return false;
    if (filters.result && match.result !== filters.result) return false;
    if (filters.format && match.format !== filters.format) return false;
    if (filters.mode && match.leaderboard !== filters.mode) return false;
    if (filters.days && (!match.started || now - Date.parse(match.started) > Number(filters.days) * 86400000)) return false;
    return true;
  });
}

export function record(matches) {
  const wins = matches.filter(m => m.result === 'win').length;
  const losses = matches.filter(m => m.result === 'loss').length;
  return { games: matches.length, wins, losses, unknown: matches.length - wins - losses, rate: pct(wins, wins + losses) };
}

export function aggregate(matches, keyOf) {
  const groups = new Map();
  for (const match of matches) {
    for (const key of keyOf(match)) {
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { key, games: 0, wins: 0, losses: 0 });
      const item = groups.get(key);
      item.games++;
      if (match.result === 'win') item.wins++;
      if (match.result === 'loss') item.losses++;
    }
  }
  return [...groups.values()].sort((a, b) => b.games - a.games || a.key.localeCompare(b.key));
}

export function sessions(matches, gapHours = 3) {
  const ordered = [...matches].filter(m => m.started && Number.isFinite(Date.parse(m.started)))
    .sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  const groups = [];
  for (const match of ordered) {
    let session = groups.at(-1);
    if (!session || Date.parse(session.oldest) - Date.parse(match.started) > gapHours * 3600000) {
      session = { newest: match.started, oldest: match.started, matches: [] };
      groups.push(session);
    }
    session.matches.push(match);
    session.oldest = match.started;
  }
  return groups;
}
