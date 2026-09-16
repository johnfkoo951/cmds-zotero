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

/** VaultLinks bundled against a mock `obsidian` and a mock `vault-storage` (boundary check is awaited on `app.boundary()`). */
async function loadVaultLinks(){
  const bundled=await build({entryPoints:['src/vault-links.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{
    name:'mock-host',setup(build){
      build.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
      build.onResolve({filter:/vault-storage$/},()=>({path:'storage',namespace:'mock'}));
      build.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='obsidian'?'export class App{};export class TFile{};':'export async function assertVaultBoundary(app){await app.boundary();} export async function ensureDirectory(){} export async function ensureCmdsIgnore(){} export const relativePath=x=>x;'}));
    },
  }]});
  const {VaultLinks}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  return VaultLinks;
}

test('note-map publication is serialized and checks lifecycle after awaits',async()=>{
  const VaultLinks=await loadVaultLinks();
  let active=true;let release!:()=>void;const writes:string[]=[];
  let onDisk:string|null=null;let reads=0;
  const app={boundary:()=>new Promise<void>(resolve=>{release=resolve;}),vault:{getName:()=> 'Research',getMarkdownFiles:()=>[],adapter:{write:async(_p:string,value:string)=>{writes.push(value);onDisk=value;},exists:async()=>onDisk!==null,read:async()=>{reads++;return onDisk??'';}}},metadataCache:{getFileCache:()=>undefined}};
  const links=new VaultLinks(app,()=>({peerVaults:[]}),()=>active);
  const pending=links.publish({entries:[],generatedAt:'example'});
  await new Promise(resolve=>setImmediate(resolve));active=false;release();await pending;
  assert.equal(writes.length,0);
  active=true;app.boundary=async()=>{};
  await Promise.all([links.publish({entries:[],generatedAt:'first'}),links.publish({entries:[],generatedAt:'second'})]);
  assert.equal(writes.length,2);assert.equal(JSON.parse(writes[1]).indexGeneratedAt,'second');
  // 0.5 R13/F07: publishing from every UI read must not rewrite an unchanged map (its own generatedAt is ignored) and,
  // after the first publication seeded the fingerprint, does not even re-read the map from disk.
  const readsBefore=reads;
  await links.publish({entries:[],generatedAt:'second'});
  assert.equal(writes.length,2,'an unchanged note map is not rewritten');
  assert.equal(reads,readsBefore,'an unchanged publication compares in memory');
  // A map deleted behind the plugin's back (git clean, manual removal) is restored on the next publication.
  onDisk=null;
  await links.publish({entries:[],generatedAt:'second'});
  assert.equal(writes.length,3,'a missing map is written again');
  await links.publish({entries:[],generatedAt:'third'});
  assert.equal(writes.length,4);assert.equal(JSON.parse(writes[3]).indexGeneratedAt,'third');
});

const file=(path:string,frontmatter?:Record<string,unknown>)=>({path,basename:path.split('/').pop()!.replace(/\.md$/,''),frontmatter});
type Fake=ReturnType<typeof file>;

test('0.5 F06: localFilesByEntry groups every note in one vault pass and shares that pass with publishNow',async()=>{
  const VaultLinks=await loadVaultLinks();
  const entries=Array.from({length:40},(_,i)=>entry(`1:ENTRY${String(i).padStart(4,'0')}`,`key${i}`));
  const files:Fake[]=[];
  for(let i=0;i<300;i++){
    const owner=i%50;
    files.push(owner<entries.length?file(`Notes/folder${i%7}/@key${owner}${i%3===0?' copy':''}.md`,i%2===0?{citekey:`key${owner}`}:undefined):file(`Misc/plain-${i}.md`));
  }
  let listings=0;let lookups=0;
  const app={boundary:async()=>{},vault:{getName:()=>'Research',getMarkdownFiles:()=>{listings++;return files;},adapter:{write:async()=>{},exists:async()=>false,read:async()=>''}},metadataCache:{getFileCache:(f:Fake)=>{lookups++;return f.frontmatter?{frontmatter:f.frontmatter}:undefined;}}};
  const links=new VaultLinks(app,()=>({peerVaults:[]}));
  const index={entries,generatedAt:'g1'};
  const byEntry:Map<string,Fake[]>=links.localFilesByEntry(index);
  assert.equal(listings,1,'one getMarkdownFiles call for all entries');
  assert.equal(lookups,files.length,'one metadata-cache lookup per file');
  assert.equal(byEntry.size,entries.length);
  const lookup=buildAliasIndex(entries);
  assert.equal([...byEntry.values()].reduce((n,list)=>n+list.length,0),files.filter(f=>noteIdentity(f.basename,f.frontmatter,lookup)!==null).length);
  for(const list of byEntry.values()) assert.deepEqual(list.map(f=>f.path),[...list.map(f=>f.path)].sort((a,b)=>a.localeCompare(b)),'paths within an entry are sorted');
  // localFiles(entry) is one pass, not one pass per entry per file; a plain entry lookup costs the same single pass.
  listings=0;lookups=0;
  const forOne=links.localFiles(entries[3],index);
  assert.equal(listings,1);assert.equal(lookups,files.length);
  assert.deepEqual(forOne.map(f=>f.path),byEntry.get(entries[3].id)!.map(f=>f.path));
  // publishNow uses the same grouping pass.
  listings=0;lookups=0;
  await links.publish(index);
  assert.equal(listings,1);assert.equal(lookups,files.length);
});

test('0.5 F07: the published map is deterministic across file order and a new instance seeds from disk without writing',async()=>{
  const VaultLinks=await loadVaultLinks();
  const entries=[entry('1:BBBB0001','b'),entry('1:AAAA0001','a')];
  const notes=[file('Z/@b.md'),file('A/@a.md'),file('M/@b.md'),file('B/@a second.md',{citekey:'a'})];
  const writes:string[]=[];let onDisk:string|null=null;
  const make=(order:Fake[])=>{
    const app={boundary:async()=>{},vault:{getName:()=>'Research',getMarkdownFiles:()=>order,adapter:{write:async(_p:string,v:string)=>{writes.push(v);onDisk=v;},exists:async()=>onDisk!==null,read:async()=>onDisk??''}},metadataCache:{getFileCache:(f:Fake)=>f.frontmatter?{frontmatter:f.frontmatter}:undefined}};
    return new VaultLinks(app,()=>({peerVaults:[]}));
  };
  await make(notes).publish({entries,generatedAt:'g1'});
  assert.equal(writes.length,1);
  const first=JSON.parse(writes[0]);
  assert.deepEqual(Object.keys(first.notes),['1:AAAA0001','1:BBBB0001'],'entry ids are sorted');
  assert.deepEqual(first.notes['1:AAAA0001'],['A/@a.md','B/@a second.md']);
  assert.deepEqual(first.notes['1:BBBB0001'],['M/@b.md','Z/@b.md']);
  // A fresh instance (plugin reload) with the files listed in another order sees the map on disk as unchanged: zero writes.
  await make([...notes].reverse()).publish({entries:[...entries].reverse(),generatedAt:'g1'});
  assert.equal(writes.length,1,'second publish with no change performs zero writes');
  // A different generation still writes, and the serialized bytes ignore file order.
  await make([...notes].reverse()).publish({entries,generatedAt:'g2'});
  assert.equal(writes.length,2);
  assert.deepEqual(JSON.parse(writes[1]).notes,first.notes);
});
