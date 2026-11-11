import {archiveArendaKz} from './registry-archive-arenda.js';
import {cityAddress,groupRegistryCities} from './registry-cities.js';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
const execute=promisify(execFile);
const fields=['ru','kz','redirectRu','redirectKz','description','expires','owner','project','requestId','status'];
export function validateEntry(value,old){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Неверный формат записи');
 const e={...old,id:old?.id||'page-'+randomUUID(),isTemplate:Boolean(old?.isTemplate)};
 for(const key of fields){if(typeof value[key]!=='string'||value[key].length>(key==='description'?4000:2048))throw Error('Неверное поле: '+key);e[key]=value[key].trim()}
 if(!e.ru&&!e.kz)throw Error('Укажи хотя бы один адрес');
 for(const key of ['ru','kz','redirectRu','redirectKz'])if(e[key]&&!(e.isTemplate&&['ru','kz'].includes(key))){try{const u=new URL(e[key]);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error()}catch{throw Error('Неверный адрес: '+key)}}
 if(!e.description||!e.project)throw Error('Укажи проект и назначение страницы');
 if(!['active','archive'].includes(e.status))throw Error('Неверное состояние');
 if(e.expires&&(!/^\d{4}-\d{2}-\d{2}$/.test(e.expires)||!Number.isFinite(Date.parse(e.expires))||new Date(e.expires).toISOString().slice(0,10)!==e.expires))throw Error('Неверная дата');
 if(typeof value.category!=='string'||!value.category.trim()||value.category.length>150)throw Error('Укажи раздел');
 e.groupPath=[...(e.status==='archive'?['Архив']:[]),...(cityAddress(e.ru)&&!e.kz&&!e.expires?['Основной сайт','Города']:[value.category.trim(),e.project])];return e;
}
export async function initRegistry(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS fit_registry (id text PRIMARY KEY,payload jsonb NOT NULL,revision integer NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS fit_registry_candidates(id text PRIMARY KEY,payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS fit_registry_state(id text PRIMARY KEY,payload jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS fit_registry_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,entry_id text,editor_id text,action text,payload jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS fit_registry_notifications(id text PRIMARY KEY,sent_at timestamptz NOT NULL);`);
 const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(332384503)');
 const done=await client.query("SELECT id FROM fit_registry_state WHERE id='migration-v1'");
 if(!done.rows.length){
 const read=async name=>JSON.parse(await readFile(new URL('../seed/'+name+'.json',import.meta.url),'utf8'));
 const [registry,candidates,checks]=await Promise.all([read('registry'),read('registry-candidates'),read('registry-checks')]);
 for(const e of registry.entries)await client.query('INSERT INTO fit_registry(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,e]);
 for(const e of candidates.items)await client.query('INSERT INTO fit_registry_candidates VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,e]);
 for(const [key,date] of Object.entries(checks.notifications||{}))if(key.startsWith('telegram:'))await client.query('INSERT INTO fit_registry_notifications VALUES($1,$2) ON CONFLICT DO NOTHING',[key,date]);
 delete checks.notifications;checks.emailStatus='Напоминания через Telegram-бота FIT Requests';
 await client.query("INSERT INTO fit_registry_state VALUES('report',$1),('migration-v1',$2)",[checks,{at:new Date().toISOString(),entries:registry.entries.length,candidates:candidates.items.length}]);
 console.info('Registry migrated',{entries:registry.entries.length,candidates:candidates.items.length,checks:Object.keys(checks.checks||{}).length});
 }await groupRegistryCities(client);await archiveArendaKz(client);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function registrySnapshot(pool){const [r,c,s]=await Promise.all([pool.query('SELECT payload,revision FROM fit_registry ORDER BY id'),pool.query('SELECT payload FROM fit_registry_candidates ORDER BY id'),pool.query("SELECT payload FROM fit_registry_state WHERE id='report'")]);return {entries:r.rows.map(x=>({...x.payload,revision:x.revision})),candidates:c.rows.map(x=>x.payload),checks:s.rows[0]?.payload||{checks:{}}}}
export async function saveRegistry(pool,user,body){
 if(user.role!=='admin')throw Error('Нет доступа');
 const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(332384504)');
 const q=body.id?await client.query('SELECT payload,revision FROM fit_registry WHERE id=$1 FOR UPDATE',[body.id]):{rows:[]};
 if(body.id&&!q.rows.length)throw Error('Запись не найдена');
 const old=q.rows[0];if(old&&body.revision!==old.revision)throw Error('Запись изменена. Обнови реестр перед сохранением; твои поля остаются в форме.');
 const e=validateEntry(body,old?.payload);
 const dup=await client.query("SELECT id FROM fit_registry WHERE id<>$1 AND (payload->>'ru'=ANY($2::text[]) OR payload->>'kz'=ANY($2::text[])) LIMIT 1",[e.id,[e.ru,e.kz].filter(Boolean)]);
 if(dup.rows.length&&(!old||e.ru!==old.payload.ru||e.kz!==old.payload.kz))throw Error('Этот адрес уже есть в реестре');
 await client.query('INSERT INTO fit_registry(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,revision=fit_registry.revision+1',[e.id,e]);
 if(body.candidateId){const candidate=await client.query('SELECT payload FROM fit_registry_candidates WHERE id=$1 FOR UPDATE',[body.candidateId]);if(!candidate.rows.length||![e.ru,e.kz].includes(candidate.rows[0].payload.url))throw Error('Адрес кандидата не совпадает');await client.query("UPDATE fit_registry_candidates SET payload=jsonb_set(payload,'{state}','\"approved\"') WHERE id=$1",[body.candidateId]);}
 await client.query('INSERT INTO fit_registry_audit(entry_id,editor_id,action,payload) VALUES($1,$2,$3,$4)',[e.id,user.telegram_id,old?'update':'create',e]);await client.query('COMMIT');return {ok:true,id:e.id};
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
export async function dismissCandidate(pool,user,id){if(user.role!=='admin')throw Error('Нет доступа');await pool.query("UPDATE fit_registry_candidates SET payload=jsonb_set(payload,'{state}','\"dismissed\"') WHERE id=$1 AND payload->>'state'='pending'",[id]);}
export async function restoreCandidate(pool,user,id){
 if(user.role!=='admin')throw Error('Нет доступа');
 const result=await pool.query("UPDATE fit_registry_candidates SET payload=jsonb_set(payload,'{state}','\"pending\"') WHERE id=$1 AND payload->>'state'='dismissed' RETURNING id",[id]);
 if(!result.rows.length)throw Error('Адрес уже изменен. Обнови список.');
}
export function dueReminder(e,date){if(e.status==='archive'||!e.expires)return null;const days=Math.round((Date.parse(e.expires)-Date.parse(date))/86400000);return [7,3,1,0].includes(days)?String(days):days<0&&days>=-7?'overdue':null}
export function makeRegistryMonitor(pool){
 let running=false;
 async function run(){if(running)return;running=true;let client;try{client=await pool.connect()}catch(e){running=false;throw e}let locked=false,dir;
 try{locked=(await client.query('SELECT pg_try_advisory_lock(332384505) AS ok')).rows[0].ok;if(!locked)return;
 const snapshot=await registrySnapshot(pool);dir=await mkdtemp(join(tmpdir(),'fit-registry-'));await mkdir(join(dir,'data'));
 const write=(name,value)=>writeFile(join(dir,'data',name+'.json'),JSON.stringify(value));
 await Promise.all([write('registry',{entries:snapshot.entries}),write('registry-checks',snapshot.checks),write('registry-candidates',{items:snapshot.candidates})]);
 await client.query("UPDATE fit_registry_state SET payload=payload || $1::jsonb WHERE id='report'",[{running:true,startedAt:new Date().toISOString(),lastError:null,failedAt:null}]);
 await execute('python3',[new URL('../monitor/registry_monitor.py',import.meta.url).pathname],{env:{PATH:process.env.PATH,REGISTRY_WORK_DIR:dir},timeout:1200000,maxBuffer:1024*1024});
 const report=JSON.parse(await readFile(join(dir,'data/registry-checks.json'),'utf8')),candidates=JSON.parse(await readFile(join(dir,'data/registry-candidates.json'),'utf8'));
 delete report.notifications;report.running=false;console.info('Registry scan completed',{checks:Object.keys(report.checks||{}).length,candidates:candidates.items.length});
 await client.query('BEGIN');
 for(const c of candidates.items)await client.query('INSERT INTO fit_registry_candidates VALUES($1,$2) ON CONFLICT DO NOTHING',[c.id,c]);
 await client.query("UPDATE fit_registry_candidates c SET payload=jsonb_set(c.payload,'{state}','\"approved\"') WHERE c.payload->>'state'='pending' AND EXISTS(SELECT 1 FROM fit_registry r WHERE c.payload->>'url' IN (r.payload->>'ru',r.payload->>'kz'))");
 await groupRegistryCities(client);
 await client.query("UPDATE fit_registry_state SET payload=$1 WHERE id='report'",[report]);await client.query('COMMIT');
 // Existing authenticated PM receives reminders through the already configured login bot.
 const token=process.env.TELEGRAM_BOT_TOKEN,recipient=process.env.TELEGRAM_ADMIN_ID;
 let status='Telegram не настроен';
 if(token&&recipient){status='Напоминания: @'+(process.env.TELEGRAM_BOT_USERNAME||'fit_requests_auth_bot');
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Novosibirsk',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const current=await pool.query('SELECT payload FROM fit_registry');
 for(const {payload:e} of current.rows){const milestone=dueReminder(e,date);if(milestone===null)continue;const key='telegram:'+e.id+':'+e.expires+':'+milestone;
 if((await client.query('SELECT id FROM fit_registry_notifications WHERE id=$1',[key])).rows.length)continue;
 let success=false;try{const response=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:recipient,text:('⏳ Срок акции: '+e.expires+'\n'+e.description+'\n'+[e.ru,e.kz].filter(Boolean).join('\n')+'\nОтветственный: '+(e.owner||'не указан')+'\n'+process.env.PUBLIC_ORIGIN+'/app/registry').slice(0,4000),link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(15000)});success=response.ok&&(await response.json()).ok}catch{}if(!success){status+=' · отправка не удалась, повтор при следующей проверке';break}await client.query('INSERT INTO fit_registry_notifications VALUES($1,now()) ON CONFLICT DO NOTHING',[key]);
 }}await client.query("UPDATE fit_registry_state SET payload=payload || $1::jsonb WHERE id='report'",[{emailStatus:status}]);
 }catch(e){await client.query('ROLLBACK').catch(()=>{});await client.query("UPDATE fit_registry_state SET payload=payload || $1::jsonb WHERE id='report'",[{running:false,lastError:'Проверка не завершена. Повтори запуск.',failedAt:new Date().toISOString()}]).catch(()=>{});console.error('Registry monitor failed',e.code||'scan_error');}
 finally{if(dir)await rm(dir,{recursive:true,force:true});if(locked)await client.query('SELECT pg_advisory_unlock(332384505)').catch(()=>{});client.release();running=false;}}
 async function tick(){const now=new Date(),local=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Novosibirsk',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);const part=k=>local.find(x=>x.type===k).value;const date=part('year')+'-'+part('month')+'-'+part('day');if(Number(part('hour'))<12)return;const q=await pool.query("SELECT payload FROM fit_registry_state WHERE id='report'");const report=q.rows[0]?.payload||{};if(report.failedAt&&Date.now()-Date.parse(report.failedAt)<1800000)return;const last=report.checkedAt;if(!last||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Novosibirsk'}).format(new Date(last))!==date)await run()}
 return {run,start(){const timer=setInterval(()=>tick().catch(()=>{}),60000);timer.unref();setTimeout(()=>tick().catch(()=>{}),15000).unref()},get running(){return running}};
}
