// One-time data correction requested by PM; subsequent edits remain authoritative.
export async function archiveArendaKz(client){
 const marker='archive-arenda-kz-20261111';
 if((await client.query('SELECT id FROM fit_registry_state WHERE id=$1',[marker])).rows.length)return;
 const matches=value=>{try{const u=new URL(value);return ['arenda.fitavto.kz','www.arenda.fitavto.kz'].includes(u.hostname)&&u.pathname==='/'&&!u.search&&!u.hash}catch{return false}};
 const rows=(await client.query('SELECT payload FROM fit_registry FOR UPDATE')).rows;
 let archived=0;
 for(const {payload:e} of rows){
 const ru=matches(e.ru),kz=matches(e.kz);if(!ru&&!kz)continue;
 const other=ru?e.kz:e.ru;
 const archive={...e,status:'archive',groupPath:['Архив',...(e.groupPath||[]).filter(x=>x!=='Архив')]};
 if(other){
 const retained={...e,[ru?'ru':'kz']:'',[ru?'redirectRu':'redirectKz']:''};
 await client.query('UPDATE fit_registry SET payload=$2,revision=revision+1 WHERE id=$1',[e.id,retained]);
 archive.id=e.id+'-arenda-kz';archive.ru='';archive.kz='https://www.arenda.fitavto.kz/';archive.redirectRu='';archive.redirectKz=ru?e.redirectRu:e.redirectKz;
 await client.query('INSERT INTO fit_registry(id,payload) VALUES($1,$2)',[archive.id,archive]);
 }else{
 await client.query('UPDATE fit_registry SET payload=$2,revision=revision+1 WHERE id=$1',[e.id,archive]);
 }
 await client.query('INSERT INTO fit_registry_audit(entry_id,editor_id,action,payload) VALUES($1,$2,$3,$4)',[archive.id,'pm-request','archive',archive]);
 archived++;
 }
 if(!archived){
 const e={id:'archive-arenda-kz',ru:'',kz:'https://www.arenda.fitavto.kz/',redirectRu:'',redirectKz:'',description:'Предложить помещение под автосервис — Казахстан',project:'Другие сайты и сервисы',groupPath:['Архив','Сайты и проекты','Другие сайты и сервисы'],status:'archive',isTemplate:false,expires:'',owner:'',requestId:''};
 await client.query('INSERT INTO fit_registry(id,payload) VALUES($1,$2)',[e.id,e]);archived++;
 }
 const candidates=(await client.query('SELECT payload FROM fit_registry_candidates FOR UPDATE')).rows;
 for(const {payload:c} of candidates)if(matches(c.url))await client.query('UPDATE fit_registry_candidates SET payload=$2 WHERE id=$1',[c.id,{...c,state:'approved'}]);
 await client.query('INSERT INTO fit_registry_state VALUES($1,$2)',[marker,{archived,at:new Date().toISOString()}]);
 console.info('Arenda Kazakhstan archived',{archived});
}
