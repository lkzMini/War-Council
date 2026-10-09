import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFullHistory, refreshRecent } from '../history.js';
import { filterMatches, record, aggregate, sessions } from '../data.js';

const rawMatch = (id, profileId = 1) => ({
  matchId:id, started:new Date(Date.UTC(2026,0,1) - (4000-id)*4*3600000).toISOString(),
  finished:new Date(Date.UTC(2026,0,1) - (4000-id)*4*3600000 + 1800000).toISOString(),
  mapName:id % 2 ? 'Arena' : 'Arabia',
  leaderboardName:'Team Random Map', gameModeName:'Random Map',
  teams:[
    {teamId:1,players:[{profileId:99,name:'Rival',civName:'Franks',won:id%3===0}]},
    {teamId:2,players:[
      {profileId:2,name:'Amigo',civName:'Britons',won:id%3!==0},
      {profileId,name:'Principal',civName:id%2?'Mongols':'Huns',won:id%3!==0}
    ]}
  ]
});
class MemoryStore {
  constructor() { this.matches = new Map(); this.meta = new Map(); }
  bucket(id) { const key=String(id); if (!this.matches.has(key)) this.matches.set(key,new Map()); return this.matches.get(key); }
  async getMeta(id) { return this.meta.get(String(id)) || null; }
  async count(id) { return this.bucket(id).size; }
  async getAll(id) { return [...this.bucket(id).values()]; }
  async getRecent(id,limit) {
    return [...this.bucket(id).values()].sort((a,b) => Date.parse(b.started)-Date.parse(a.started)).slice(0,limit);
  }
  async savePage(id,matches,patch) {
    for (const match of matches) this.bucket(id).set(match.id,match);
    this.meta.set(String(id),{...(this.meta.get(String(id)) || {}),...patch});
    return this.bucket(id).size;
  }
}
const fetcher = (items,calls=[]) => async (_id,page,perPage) => {
  calls.push(page);
  return { matches:items.slice((page-1)*perPage,page*perPage), perPage, hasMore:null,total:null };
};
const run = (profileId,store,fetchPage,options={}) => downloadFullHistory({
  profileId,store,fetchPage,wait:async()=>{},...options,
});

test('finishes a small history only at the observable terminal page', async () => {
  const store = new MemoryStore();
  const calls=[];
  const progress=[];
  const result = await run(1,store,fetcher(Array.from({length:23},(_,i)=>rawMatch(23-i)),calls),{
    onProgress:p=>progress.push(p),
  });
  assert.equal(result.count,23);
  assert.equal(result.complete,true);
  assert.deepEqual(calls,[1]);
  assert.equal(progress[0].total,null);
  assert.equal((await store.getMeta(1)).complete,true);
});

test('stores thousands of matches, deduplicates and keeps full analytics correct', async () => {
  const store = new MemoryStore();
  const calls=[];
  const items=Array.from({length:3000},(_,i)=>rawMatch(3000-i));
  const result=await run(1,store,fetcher(items,calls));
  assert.equal(result.count,3000);
  assert.equal(calls.length,16);
  assert.equal((await store.getRecent(1,100)).length,100);
  const all=await store.getAll(1);
  assert.equal(record(all).games,3000);
  assert.equal(filterMatches(all,{allies:[2],allAllies:true,civ:'Mongols',map:'Arena',result:'win'}).length,1000);
  assert.equal(aggregate(all,m=>m.allies.map(p=>String(p.id)))[0].games,3000);
  assert.ok(sessions(all).length>100);
  assert.equal((await store.getMeta(1)).nextPage,null);
});

test('detects repeated pages without falsely completing', async () => {
  const store=new MemoryStore();
  const page=Array.from({length:200},(_,i)=>rawMatch(400-i));
  await assert.rejects(run(1,store,async()=>({matches:page,perPage:200,hasMore:null,total:null})),/no avanzó en la página 2|repitió la página 2/);
  assert.equal(await store.count(1),200);
  assert.equal((await store.getMeta(1)).complete,false);
  assert.equal((await store.getMeta(1)).nextPage,2);
});

test('cancellation and network failure preserve pages for resumption', async () => {
  const store=new MemoryStore();
  const items=Array.from({length:650},(_,i)=>rawMatch(650-i));
  const controller=new AbortController();
  await assert.rejects(run(1,store,fetcher(items),{
    signal:controller.signal,
    onPage:({page})=>{if(page===2) controller.abort();}
  }),{name:'AbortError'});
  assert.equal(await store.count(1),400);
  assert.equal((await store.getMeta(1)).nextPage,3);
  const calls=[];
  await run(1,store,fetcher(items,calls));
  assert.deepEqual(calls,[1,3,4]);
  assert.equal(await store.count(1),650);
  const failed=new MemoryStore();
  await assert.rejects(run(1,failed,async(_id,page,size)=>{
    if(page===2) throw new Error('network offline');
    return fetcher(items)(1,page,size);
  }),/network offline/);
  assert.equal(await failed.count(1),200);
  assert.equal((await failed.getMeta(1)).complete,false);
});

test('head movement restarts safely and recent refresh preserves a complete archive', async () => {
  const store=new MemoryStore();
  const initial=Array.from({length:450},(_,i)=>rawMatch(450-i));
  const controller=new AbortController();
  await assert.rejects(run(1,store,fetcher(initial),{
    signal:controller.signal,onPage:()=>controller.abort(),
  }),{name:'AbortError'});
  const newHead=[rawMatch(452),rawMatch(451),...initial];
  const calls=[];
  await run(1,store,fetcher(newHead,calls));
  assert.deepEqual(calls,[1,2,3]);
  assert.equal(await store.count(1),452);
  assert.equal((await store.getMeta(1)).complete,true);
  const recent=await refreshRecent({
    profileId:1,limit:100,store,
    fetchMatches:async()=>[rawMatch(454),rawMatch(453),...newHead.slice(0,98)],
  });
  assert.equal(recent.count,454);
  assert.equal(recent.meta.complete,true);
  assert.equal(recent.meta.nextPage,null);
  assert.equal((await store.getRecent(1,100))[0].id,454);
  await run(2,store,fetcher([rawMatch(9,2)]));
  assert.equal(await store.count(2),1);
  assert.equal(await store.count(1),454);
});

test('a recent refresh without overlap never calls an old archive complete', async () => {
  const store=new MemoryStore();
  const old=Array.from({length:230},(_,i)=>rawMatch(230-i));
  await run(1,store,fetcher(old));
  const fresh=Array.from({length:100},(_,i)=>rawMatch(500-i));
  const result=await refreshRecent({profileId:1,limit:100,store,fetchMatches:async()=>fresh});
  assert.equal(result.overlap,false);
  assert.equal(result.meta.complete,false);
  assert.equal(result.meta.nextPage,1);
  assert.equal(result.count,330);
});
