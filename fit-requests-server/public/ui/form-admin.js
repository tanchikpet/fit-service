import {allFields} from './form-schema.js';
import {mountFields} from './form-render.js';

const $=selector=>document.querySelector(selector);
const status=$('#catalogStatus');
const editor=$('#typeEditor');
const types={text:'Однострочный текст',textarea:'Многострочный текст',number:'Число',date:'Дата',url:'URL',select:'Список',multi:'Множественный выбор',boolean:'Да / Нет'};
const icons={file:'▤ Документ',star:'★ Акция',refresh:'↻ Обновление',chart:'▥ Аналитика',link:'↗ Ссылка',flag:'⚑ Флаг'};
const states={active:'Активен',inactive:'Неактивен',archived:'Архив'};
let items=[],id,working,position,dirty=false,busy=false;
const selected=()=>items.find(item=>item.id===id);
const key=prefix=>prefix+'-'+crypto.randomUUID();
function element(tag,text,css){
 const node=document.createElement(tag);
 if(text)node.textContent=text;
 if(css)node.className=css;
 return node;
}
function button(text,action,primary=false){
 const result=element('button',text,'button '+(primary?'primary':'secondary'));
 result.type='button';result.onclick=action;return result;
}
function label(text,control){const node=element('label',text);node.append(control);return node}
function change(){dirty=true}
function input(value,oninput,type='text'){
 const node=element(type==='textarea'?'textarea':'input');
 if(type!=='textarea')node.type=type;
 node.value=value??'';
 node.oninput=()=>{oninput(node.value);change()};
 return node;
}
function select(options,value,onchange){
 const node=element('select');
 for(const [id,text] of Object.entries(options))node.add(new Option(text,id));
 node.value=value??'';
 node.onchange=()=>onchange(node.value);
 return node;
}
function move(array,index,delta){
 const target=index+delta;
 [array[index],array[target]]=[array[target],array[index]];
 change();renderEditor();
}
function row(...children){const node=element('div','','type-actions');node.append(...children);return node}
async function api(body){
 const response=await fetch('/api/admin/form-types',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
 const result=await response.json();
 if(!response.ok)throw Error(result.error||'Не удалось загрузить справочник');
 return result.items;
}
function choose(next){
 const record=items.find(item=>item.id===next);
 id=record?.id;working=record&&structuredClone(record.draft);position=record?.position;dirty=false;
 renderList();renderEditor();
}
async function run(action,params={},message='Изменения сохранены'){
 if(busy)return;
 if(dirty&&!['save','publish'].includes(action)&&!confirm('Изменения формы ещё не сохранены. Продолжить?'))return;
 busy=true;
 const before=new Set(items.map(item=>item.id));
 editor.inert=true;
 try{
  items=await api({action,id,revision:selected()?.revision,...params});
  const fresh=items.find(item=>!before.has(item.id));
  if(action==='state'&&params.state==='archived')$('#showArchived').checked=true;
  choose(fresh?.id|| (selected()?id:items.find(item=>item.state!=='archived')?.id));
  status.textContent=message;
 }catch(error){status.textContent=error.message}
 finally{editor.inert=false;busy=false}
}
function renderList(){
 const list=$('#typeList');list.replaceChildren();
 for(const item of items.filter(item=>item.state!=='archived'||$('#showArchived').checked)){
  const node=button((icons[item.draft.icon]||'').split(' ')[0]+' '+item.draft.name+' · '+states[item.state],()=>{
   if(item.id!==id&&(!dirty||confirm('Закрыть тип без сохранения изменений?')))choose(item.id);
  });
  node.setAttribute('aria-current',String(item.id===id));list.append(node);
 }
}
function defaultControl(field){
 if(['select','multi','boolean'].includes(field.type)){
  const choices=field.type==='boolean'?{true:'Да',false:'Нет'}:Object.fromEntries(field.options.map(option=>[option.id,option.label]));
  if(field.type==='multi'){
   const control=select(choices,null,()=>{field.defaultValue=Array.from(control.selectedOptions,option=>option.value);change()});
   control.multiple=true;
   for(const option of control.options)option.selected=Array.isArray(field.defaultValue)&&field.defaultValue.includes(option.value);
   return control;
  }
  return select({'':'Без значения',...choices},field.defaultValue==null?'':String(field.defaultValue),value=>{
   field.defaultValue=value===''?null:field.type==='boolean'?value==='true':value;change();
  });
 }
 return input(field.defaultValue,value=>{field.defaultValue=value===''?null:field.type==='number'?Number(value):value},field.type);
}
function renderField(section,field,index,opened){
 const detail=element('details');detail.open=opened;
 detail.append(element('summary',field.label+(field.required?' *':'')+' · '+types[field.type]));
 const settings=element('div','','field-settings');
 const type=select(types,field.type,value=>{
  field.type=value;field.defaultValue=null;field.max=value==='textarea'?10000:2048;change();renderEditor(field.id);
 });
 type.disabled=field.id==='title';
 const required=element('input');required.type='checkbox';required.checked=field.required;required.disabled=field.id==='title';
 required.onchange=()=>{field.required=required.checked;change()};
 const obligation=label('Обязательное поле',required);obligation.className='checkbox-label';
 settings.append(label('Название поля',input(field.label,value=>field.label=value)),
  label('Тип поля',type),label('Подсказка',input(field.hint,value=>field.hint=value)),obligation,
  label('Значение по умолчанию',defaultControl(field)));
 detail.append(settings);
 if(['select','multi'].includes(field.type)){
  const options=element('div');
  for(const option of field.options){
   const line=element('div','','option-row');
   const name=input(option.label,value=>option.label=value);
   name.setAttribute('aria-label','Название варианта');
   name.onchange=()=>renderEditor(field.id);
   line.append(name,button('Убрать вариант',()=>{
    field.options=field.options.filter(value=>value!==option);
    if(Array.isArray(field.defaultValue))field.defaultValue=field.defaultValue.filter(value=>value!==option.id);
    else if(field.defaultValue===option.id)field.defaultValue=null;
    change();renderEditor(field.id);
   }));options.append(line);
  }
  options.append(button('＋ Вариант',()=>{field.options.push({id:key('option'),label:'Новый вариант'});change();renderEditor(field.id)}));
  detail.append(options);
 }
 const up=button('Выше',()=>move(section.fields,index,-1));up.disabled=index===0;
 const down=button('Ниже',()=>move(section.fields,index,1));down.disabled=index===section.fields.length-1;
 const remove=button('Убрать поле',()=>{section.fields.splice(index,1);change();renderEditor()});remove.disabled=field.id==='title';
 const actions=row(up,down,remove);
 if(working.sections.length>1){
  const choices=Object.fromEntries(working.sections.map((group,i)=>[group.id,group.name||'Раздел '+(i+1)]));
  actions.append(label('Раздел поля',select(choices,section.id,target=>{
   section.fields.splice(index,1);working.sections.find(group=>group.id===target).fields.push(field);change();renderEditor(field.id);
  })));
 }
 detail.append(actions);return detail;
}
function renderSection(section,index,openId){
 const panel=element('section','','form-admin-section');
 const name=input(section.name,value=>section.name=value);
 name.setAttribute('aria-label','Название раздела');
 const up=button('Раздел выше',()=>move(working.sections,index,-1));up.disabled=index===0;
 const down=button('Раздел ниже',()=>move(working.sections,index,1));down.disabled=index===working.sections.length-1;
 const remove=button('Удалить пустой раздел',()=>{working.sections.splice(index,1);change();renderEditor()});
 remove.disabled=working.sections.length===1||section.fields.length>0;
 panel.append(name,row(up,down,remove));
 for(const [index,field] of section.fields.entries())panel.append(renderField(section,field,index,openId===field.id));
 panel.append(button('＋ Добавить поле',()=>{
  const id=key('field');section.fields.push({id,label:'Новое поле',type:'text',required:false,hint:'',options:[],max:2048,defaultValue:null});
  change();renderEditor(id);
 }));
 return panel;
}
function preview(){
 $('#previewTitle').textContent=working.name;
 $('#previewDescription').textContent=working.description;
 mountFields($('#previewFields'),working,Object.fromEntries(allFields(working).map(field=>[field.id,field.defaultValue])));
 $('#formPreview').showModal();
}
function renderEditor(openId){
 editor.replaceChildren();
 const item=selected();
 if(!item){editor.append(element('p','Выбери тип заявки или создай новый.'));return}
 const current=item.versions.find(version=>version.id===String(item.current_version_id));
 editor.append(element('h2',working.name),element('p',item.id+' · '+states[item.state]+' · '+(current?'Версия '+current.number:'Без публикации'),'sub'));
 const metadata=element('div','','type-meta');
 const icon=select(icons,working.icon,value=>{working.icon=value;change()});
 metadata.append(label('Название типа',input(working.name,value=>working.name=value)),
  label('Порядок',input(position,value=>position=value===''?NaN:Number(value),'number')),
  label('Иконка',icon),label('Описание',input(working.description,value=>working.description=value,'textarea')));
 editor.append(metadata);
 const state=item.state==='active'?'inactive':'active';
 const toggle=button(state==='active'?'Активировать':'Деактивировать',()=>run('state',{state}));toggle.disabled=state==='active'&&!current;
 const archive=button('Архивировать',()=>{if(confirm('Скрыть тип и заблокировать подачу его черновиков?'))run('state',{state:'archived'})});
 archive.disabled=item.state==='archived';
 editor.append(row(button('Копировать',()=>run('copy')),toggle,archive,
  button('Удалить тип',()=>{if(confirm('Удалить тип?'))run('delete',{},'Тип удалён')})));
 editor.append(element('h3','Разделы и поля'),element('p','Номер, автор, дата создания и статус заполняются системой.','sub'));
 for(const [index,section] of working.sections.entries())editor.append(renderSection(section,index,openId));
 editor.append(row(button('＋ Добавить раздел',()=>{working.sections.push({id:key('section'),name:'Новый раздел',fields:[]});change();renderEditor()})));
 if(item.versions.length){
  const versions=element('details');versions.append(element('summary','История публикаций'));
  for(const version of item.versions){
   const date=new Date(version.publishedAt).toLocaleString('ru-RU');
   versions.append(row(element('span','Версия '+version.number+' · '+date+' · '+version.publishedBy),
    button('В черновик формы',()=>run('restore',{versionId:version.id},'Версия загружена в черновик формы'))));
  }
  editor.append(versions);
 }
 editor.append(row(button('Предпросмотр',preview),button('Сохранить черновик формы',()=>run('save',{schema:working,position})),
  button('Опубликовать версию',()=>run('publish',{schema:working,position},'Новая версия опубликована'),true)));
}
$('#showArchived').onchange=renderList;
$('#createType').onclick=()=>{const name=prompt('Название нового типа');if(name?.trim())run('create',{name})};
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue=''}});
try{items=await api();choose(items.find(item=>item.state!=='archived')?.id)}
catch(error){status.textContent=error.message}
