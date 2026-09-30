import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMatch, normalizeMatches, filterMatches, record, aggregate, sessions, sampleLabel } from '../data.js';

const raw = (id, start, won, teamId = 2) => ({
  matchId:id, started:start, finished:new Date(Date.parse(start) + 1800000).toISOString(),
  mapName:'Arena', leaderboardName:'Team Random Map', gameModeName:'Random Map',
  teams:[
    {teamId:1, players:[{profileId:3,name:'Rival',civName:'Franks',won:!won}]},
    {teamId, players:[{profileId:2,name:'Aliado',civName:'Britons',won},
      {profileId:1,name:'Yo',civName:'Mongols',rating:1200,ratingDiff:won?12:-12,won}]}
  ]
});

test('uses actual teams, never slot or color, to find allies', () => {
  const match = normalizeMatch(raw(10,'2026-01-01T20:00:00Z',true), 1);
  assert.deepEqual(match.allies.map(p => p.id), [2]);
  assert.deepEqual(match.opponents.map(p => p.id), [3]);
  assert.equal(match.result, 'win');
  assert.equal(match.format, '1v2');
  assert.equal(match.duration, 30);
});

test('normalizes, sorts and filters cumulative criteria', () => {
  const matches = normalizeMatches([
    raw(10,'2026-01-01T20:00:00Z',true),
    raw(11,'2026-01-02T20:00:00Z',false)
  ],1);
  assert.equal(matches[0].id,11);
  const selected = filterMatches(matches,{allies:[2],allAllies:true,civ:'Mongols',map:'Arena',result:'win',format:'1v2',mode:'Team Random Map',days:0});
  assert.deepEqual(selected.map(m => m.id),[10]);
  assert.deepEqual(record(matches),{games:2,wins:1,losses:1,unknown:0,rate:'50.0%'});
  assert.equal(aggregate(matches,m => m.allies.map(a => String(a.id)))[0].games,2);
});

test('groups sessions by a three-hour gap and labels small samples', () => {
  const matches = normalizeMatches([
    raw(1,'2026-01-01T20:00:00Z',true),
    raw(2,'2026-01-01T22:00:00Z',false),
    raw(3,'2026-01-02T03:01:00Z',true)
  ],1);
  assert.deepEqual(sessions(matches).map(s => s.matches.length),[1,2]);
  assert.equal(sampleLabel(1),'Muestra insuficiente');
  assert.equal(sampleLabel(4),'Muestra pequeña');
  assert.equal(sampleLabel(6),'Muestra útil');
});
