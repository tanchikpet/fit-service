const $el=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node};
export function fieldControlId(key){return 'request'+key[0].toUpperCase()+key.slice(1)}
export function mountFields(container,schema,answers={}){
 container.replaceChildren();
 for(const section of schema.sections){
  const group=$el('div');
  group.className='configured-section';
  if(section.name)group.append($el('h3',section.name));
  for(const field of section.fields){
   const id=fieldControlId(field.id);
   const row=$el('div');row.className='intake-field';row.dataset.field=field.id;
   const label=$el('label',field.label+(field.required?' *':''));label.htmlFor=id;
   const control=$el(field.type==='textarea'?'textarea':['select','multi','boolean'].includes(field.type)?'select':'input');
   control.id=id;control.required=field.required;control.dataset.valueType=field.type;
   const value=Object.hasOwn(answers,field.id)?answers[field.id]:null;
   if(control.tagName==='TEXTAREA'){control.rows=3;control.maxLength=field.max}
   if(control.tagName==='INPUT'){
    control.type=field.type;
    if(field.type==='number')control.step='any';
    if(['text','url'].includes(field.type))control.maxLength=field.max;
    if(field.type==='url')control.placeholder='https://…';
   }
   if(control.tagName==='SELECT'){
    control.multiple=field.type==='multi';
    if(!control.multiple)control.add(new Option('Выбери вариант',''));
    const options=field.type==='boolean'?[{id:'true',label:'Да'},{id:'false',label:'Нет'}]:field.options;
    for(const option of options)control.add(new Option(option.label,option.id));
    if(control.multiple)for(const option of control.options)option.selected=Array.isArray(value)&&value.includes(option.value);
   }
   if(!control.multiple)control.value=value??'';
   row.append(label,control);
   if(field.hint){const hint=$el('small',field.hint);hint.id=id+'Hint';row.append(hint)}
   const error=$el('small');error.className='field-error';error.id=id+'Error';error.hidden=true;row.append(error);
   control.setAttribute('aria-describedby',error.id+(field.hint?' '+id+'Hint':''));
   group.append(row);
  }
  container.append(group);
 }
}
export function collectAnswers(container){
 return Object.fromEntries(Array.from(container.querySelectorAll('[data-value-type]'),control=>{
  const {valueType}=control.dataset;
  const value=valueType==='multi'?Array.from(control.selectedOptions,option=>option.value):
   control.value===''?null:valueType==='boolean'?control.value==='true':
   valueType==='number'?control.valueAsNumber:control.value.trim();
  return [control.closest('[data-field]').dataset.field,value];
 }));
}
