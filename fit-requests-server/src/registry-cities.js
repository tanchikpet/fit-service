// Explicit city names from registry discoveries. Never classify arbitrary subdomains as cities.
const cities=new Set('lnkz achinsk angarsk aramil arkhangelsk azov balakovo balashikha barabinsk barnaul belgorod belogorsk berdsk birobidzhan biysk blagoveshchensk bolshoykamen bratsk bryansk chaykovskiy chelyabinsk cheremkhovo chita dalnerechensk dzerzhinsk ekaterinburg gelendzhik gorno-altaysk irkutsk ishim iskitim izhevsk kaluga kartaly kazan kemerovo khabarovsk kirov korolev kovrov krasnodar krasnoyarsk kulebaki kurgan kuybyshev lipetsk magnitogorsk makhachkala mezhdurechensk moskva myski naberezhnyechelny nakhodka nizhneudinsk nizhnevartovsk novokuznetsk novorossiysk novosibirsk nur-sultan oktyabrskiy omsk ordynskoe orel orenburg otradnyy pavlodar perm petrozavodsk podolsk prokopevsk pskov pushkino pyatigorsk rubtsovsk ryazan salsk samara saratov sevastopol seversk shchelkovo solikamsk sosnovoborsk stavropol surgut tolyatti tomsk tyumen ufa ulan-ude ussuriysk uzlovaya vladimir vladivostok volgodonsk volgograd volsk volzhskiy voronezh votkinsk yablonovskiy yaroslavl zelenogorsk zheleznogorsk zlatoust'.split(' '));
export function cityAddress(value){
 try{const url=new URL(value);const host=url.hostname.replace(/^www\./,'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)return null;
 const match=host.match(/^([a-z-]+)\.fitauto\.ru$/);
 return match&&cities.has(match[1])?{slug:match[1],url:'https://'+host+'/'}:null;
 }catch{return null}
}
export async function groupRegistryCities(client){
 const entries=(await client.query('SELECT payload FROM fit_registry')).rows.map(r=>r.payload);
 const candidates=(await client.query('SELECT payload FROM fit_registry_candidates')).rows.map(r=>r.payload);
 const known=new Map();
 for(const entry of entries){const city=cityAddress(entry.ru);
 // Preserve records containing a second site or campaign-specific metadata.
 if(!city||entry.kz||entry.expires||entry.isTemplate)continue;
 known.set(city.slug,entry);
 const groupPath=[...(entry.status==='archive'?['Архив']:[]),'Основной сайт','Города'];
 if(JSON.stringify(entry.groupPath)!==JSON.stringify(groupPath)){
 const updated={...entry,groupPath};
 await client.query('UPDATE fit_registry SET payload=$2,revision=revision+1 WHERE id=$1',[entry.id,updated]);
 }
 }
 for(const candidate of candidates){
 const city=cityAddress(candidate.url);if(!city||candidate.state!=='pending')continue;
 let entry=known.get(city.slug);
 if(!entry){
 entry={id:'city-'+city.slug,ru:city.url,kz:'',redirectRu:'',redirectKz:'',description:'Городская версия основного сайта: '+(city.slug==='lnkz'?'Ленинск-Кузнецкий':city.slug),project:'Основной сайт — fitauto.ru',groupPath:['Основной сайт','Города'],status:'active',isTemplate:false,expires:'',owner:'',requestId:''};
 await client.query('INSERT INTO fit_registry(id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING',[entry.id,entry]);
 known.set(city.slug,entry);
 }
 await client.query('UPDATE fit_registry_candidates SET payload=$2 WHERE id=$1',[candidate.id,{...candidate,state:'approved',registryEntryId:entry.id,classification:'city'}]);
 }
}
