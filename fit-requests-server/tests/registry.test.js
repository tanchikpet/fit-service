import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEntry,dueReminder,saveRegistry,dismissCandidate} from '../src/registry.js';
const entry=()=>({ru:'https://example.com/',kz:'',redirectRu:'',redirectKz:'',description:'Test',expires:'',owner:'PM',project:'Web',requestId:'',status:'active',category:'Сайты'});
test('registry validates required fields, URL protocols and dates',()=>{
 assert.equal(validateEntry(entry()).ru,'https://example.com/');
 for(const changes of [{ru:'javascript:alert(1)'},{ru:'https://user:pass@example.com/'},{description:''},{project:''},{expires:'2026-02-30'},{status:'deleted'}])assert.throws(()=>validateEntry({...entry(),...changes}));
});
test('registry preserves existing templates but cannot create arbitrary template flags',()=>{
 assert.equal(validateEntry({...entry(),ru:'https://{city}.fitauto.ru/'},{id:'template',isTemplate:true}).isTemplate,true);
 assert.equal(validateEntry({...entry(),isTemplate:true}).isTemplate,false);
});
test('registry writes are denied to employees before accessing database',async()=>{
 await assert.rejects(saveRegistry({}, {role:'employee'},entry()),/Нет доступа/);
 await assert.rejects(dismissCandidate({}, {role:'employee'},'candidate'),/Нет доступа/);
});
test('reminder milestones, overdue window and archive exclusion',()=>{
 assert.equal(dueReminder({status:'active',expires:'2026-11-17'},'2026-11-10'),'7');
 assert.equal(dueReminder({status:'active',expires:'2026-11-10'},'2026-11-10'),'0');
 assert.equal(dueReminder({status:'active',expires:'2026-11-09'},'2026-11-10'),'overdue');
 assert.equal(dueReminder({status:'active',expires:'2026-11-01'},'2026-11-10'),null);
 assert.equal(dueReminder({status:'archive',expires:'2026-11-10'},'2026-11-10'),null);
});
