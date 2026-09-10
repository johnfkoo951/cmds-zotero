import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestAPI } from '../src/ingest-api';

function service(capabilities:()=>Promise<unknown>) {
  return new IngestAPI({vault:{getName:()=> 'Research'}} as never, {capabilities} as never, {} as never, {} as never, async()=>{});
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('CLI jobs acknowledge immediately and surface async terminal results',async()=>{
  let finish!:(value:unknown)=>void;
  const api=service(()=>new Promise(resolve=>{finish=resolve;}));
  const id=api.startJob('connection');
  assert.equal(api.getJob(id).state,'pending');
  finish({zotero:'example',betterbibtex:'example'});
  await tick();
  assert.equal(api.getJob(id).state,'completed');
  assert.equal((api.getJob(id).result as {vault:string}).vault,'Research');
});

test('CLI jobs expose failures and missing jobs rather than hanging',async()=>{
  const api=service(async()=>{throw new Error('Offline');});
  const id=api.startJob('connection');await tick();
  assert.deepEqual(api.getJob(id),{state:'failed',error:'Offline'});
  assert.equal(api.getJob('absent').state,'failed');
  assert.throws(()=>api.startJob('write-library' as never));
});

test('pending job capacity is bounded without evicting active work',()=>{
  const api=service(()=>new Promise(()=>{}));
  const ids=Array.from({length:16},()=>api.startJob('connection'));
  assert.throws(()=>api.startJob('connection'),/Too many/);
  assert.equal(api.getJob(ids[0]).state,'pending');
});
