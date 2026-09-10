import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { buildAliasIndex, noteIdentity } from '../src/note-aliases';
import type { ZoteroIndexEntry } from '../src/types';

const entry=(id:string,citekey:string,citekeyHistory:string[]=[])=>({id,citekey,citekeyHistory}) as ZoteroIndexEntry;
test('legacy note aliases include history and refuse reassigned aliases',()=>{
  const a=entry('1:AAAA2345','New',['Old']);
  assert.equal(noteIdentity('@Old',{},buildAliasIndex([a])),a.id);
  const both=buildAliasIndex([a,entry('1:BBBB2345','Old')]);
  assert.equal(noteIdentity('@Old',{citekey:'Old'},both),null);
  assert.equal(noteIdentity('@Old',{zoteroID:a.id},both),a.id);
  assert.equal(noteIdentity('@New',{zoteroID:'unknown'},both),null);
});

test('note-map publication is serialized and checks lifecycle after awaits',async()=>{
  const bundled=await build({entryPoints:['src/vault-links.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{
    name:'mock-host',setup(build){
      build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
      build.onResolve({filter:/vault-storage$/},()=>({path:'storage',namespace:'mock'}));
      build.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='obsidian'?'export class App{};export class TFile{};':'export async function assertVaultBoundary(app){await app.boundary();} export async function ensureDirectory(){} export const relativePath=x=>x;'}));
    },
  }]});
  const {VaultLinks}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  let active=true;let release!:()=>void;const writes:string[]=[];
  const app={boundary:()=>new Promise<void>(resolve=>{release=resolve;}),vault:{getName:()=> 'Research',getMarkdownFiles:()=>[],adapter:{write:async(_p:string,value:string)=>{writes.push(value);}}}};
  const links=new VaultLinks(app,()=>({peerVaults:[]}),()=>active);
  const pending=links.publish({entries:[],generatedAt:'example'});
  await new Promise(resolve=>setImmediate(resolve));active=false;release();await pending;
  assert.equal(writes.length,0);
  active=true;app.boundary=async()=>{};
  await Promise.all([links.publish({entries:[],generatedAt:'first'}),links.publish({entries:[],generatedAt:'second'})]);
  assert.equal(writes.length,2);assert.equal(JSON.parse(writes[1]).indexGeneratedAt,'second');
});
