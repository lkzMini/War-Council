import test from 'node:test';
import assert from 'node:assert/strict';
import { getMatches, request, searchProfiles } from '../api.js';

test('fetches four pages for the latest 200 and deduplicates requests', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok:true, json:async () => ({ matches:Array.from({length:50},(_,i) => ({matchId:(page-1)*50+i+1})) }) };
  };
  try {
    const progress = [];
    const matches = await getMatches(199325,200,count => progress.push(count));
    assert.equal(matches.length,200);
    assert.deepEqual(progress,[50,100,150,200]);
    assert.equal(calls.length,4);
  } finally { globalThis.fetch = original; }
});

test('coalesces identical in-flight requests', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok:true, json:async () => ({ profiles:[{profileId:1}] }) };
  };
  try {
    const [a,b] = await Promise.all([request('/profiles?search=test'),request('/profiles?search=test')]);
    assert.equal(calls,1);
    assert.deepEqual(a,b);
  } finally { globalThis.fetch = original; }
});

test('searches Steam ID and Profile ID through their distinct endpoints', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(url);
    return { ok:true, json:async () => url.includes('/profiles/12345') ? {profileId:12345} : {profiles:[{profileId:12345}]} };
  };
  try {
    assert.equal((await searchProfiles('76561198449406083'))[0].profileId,12345);
    assert.equal((await searchProfiles('12345'))[0].profileId,12345);
    assert.match(urls[0],/steam_id=/);
    assert.match(urls[1],/\/profiles\/12345$/);
  } finally { globalThis.fetch = original; }
});
