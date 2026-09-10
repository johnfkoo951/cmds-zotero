import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProtocolRequest, citekeyAtCursor } from '../src/protocol';
import { normalizeSettings, validateEndpoint } from '../src/settings-data';

test('deep links permit stable open actions only', () => {
  assert.deepEqual(parseProtocolRequest({vault:'Research',libraryID:'1',itemKey:'ABCD2345',target:'pdf',page:'3',annotation:'EFGH6789'}), {
    vault:'Research',libraryID:1,itemKey:'ABCD2345',target:'pdf',page:3,annotation:'EFGH6789',
  });
  for (const change of [{target:'write'}, {page:'0'}, {page:'-1'}, {page:'1.5'}, {page:'2junk'}, {libraryID:'0'}, {itemKey:'citekey'}, {file:'../secret'}, {annotation:'bad'}]) {
    assert.throws(() => parseProtocolRequest({vault:'Research',libraryID:'1',itemKey:'ABCD2345',...change}));
  }
});

test('Obsidian consumes vault before delivering custom protocol parameters', () => {
  const request = parseProtocolRequest({action:'cmds-zotero',libraryID:'1',itemKey:'ABCD2345',target:'note'}, 'Routed vault');
  assert.equal(request.vault, 'Routed vault');
  assert.throws(()=>parseProtocolRequest({vault:'Other',libraryID:'1',itemKey:'ABCD2345'}, 'Routed vault'),/wrong vault/);
});

test('citekey selection follows cursor rather than first citation on line', () => {
  const line='See [@first2024] and [@second2025].';
  assert.equal(citekeyAtCursor(line,25),'second2025');
  assert.equal(citekeyAtCursor(line,1),'');
  assert.equal(citekeyAtCursor('',0,'[@selected2026]'),'selected2026');
  assert.equal(citekeyAtCursor('',0,'[@one; @two]'),'');
});

test('settings migrate known values without carrying legacy export path', () => {
  const settings=normalizeSettings({libraryExportPath:'/broken',outputFolder:'Papers',concurrency:999,requestTimeoutMs:-1,peerVaults:[null,{name:'Peer',path:'/synthetic/vault'}]});
  assert.equal(settings.outputFolder,'Papers');
  assert.equal(settings.concurrency,2);
  assert.equal(settings.requestTimeoutMs,20000);
  assert.equal('libraryExportPath' in settings,false);
  assert.equal(settings.peerVaults.length,1);
});

test('connection configuration cannot silently send literature to remote servers', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:23119/better-bibtex/'),'http://127.0.0.1:23119/better-bibtex');
  for (const url of ['https://example.org','file:///private','http://user:pass@localhost','http://localhost/?secret=x']) assert.throws(()=>validateEndpoint(url));
});
