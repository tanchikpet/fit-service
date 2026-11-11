export async function flagRabota3(client){
 const marker='attention-rabota3-www-20261111',url='https://www.rabota3.fitauto.ru/';
 if((await client.query('SELECT id FROM fit_registry_state WHERE id=$1',[marker])).rows.length)return;
 const rows=(await client.query('SELECT payload FROM fit_registry FOR UPDATE')).rows;
 const old=rows.find(r=>[r.payload.ru,r.payload.kz].includes(url))?.payload;
 const e={...(old||{id:'page-rabota3-www',ru:url,kz:'',redirectRu:'',redirectKz:'',description:'rabota3.fitauto.ru — страница с www',project:'Другие сайты и сервисы',groupPath:['Сайты и проекты','Другие сайты и сервисы'],status:'active',isTemplate:false,expires:'',owner:'',requestId:''}),attentionRequestedAt:new Date().toISOString(),attentionUrl:url};
 await client.query('INSERT INTO fit_registry(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,revision=fit_registry.revision+1',[e.id,e]);
 await client.query("UPDATE fit_registry_candidates SET payload=jsonb_set(payload,'{state}','\"approved\"') WHERE payload->>'url'=$1",[url]);
 await client.query('INSERT INTO fit_registry_state VALUES($1,$2)',[marker,{at:e.attentionRequestedAt}]);
 console.info('rabota3 www marked for attention');
}
