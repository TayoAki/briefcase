const root = document.querySelector('#workbench');
const status = document.querySelector('#workbench-status');
const api = '/api/workbench';
const selected = new URLSearchParams(location.search).get('item');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const title = value => String(value).replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
let info, catalog, itemInfo, sourceDocs = [], busy = false, pendingCreate;
const message = (text,error=false) => { status.textContent=text; status.dataset.error=String(error); };
async function request(path,body) {
  const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json','X-Briefcase-Request':'1'},body:JSON.stringify(body)}:{});
  const data=await response.json(); if(!response.ok) throw new Error(data.error||'Could not complete the request.'); return data;
}
const options = (values,chosen='') => values.map(value=>{const v=typeof value==='string'?value:value.value;return `<option value="${esc(v)}" ${v===chosen?'selected':''}>${esc(typeof value==='string'?value:value.label??v)}</option>`;}).join('');
function parseExample(value) {
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return null;}
}
function arraySchema(field,definition) {
  let example=parseExample(field.example??field.hint);
  if(!Array.isArray(example)||!example.length){
    for(const candidate of [...(definition?.fields??[]),...(definition?.actions??[]).flatMap(a=>a.fields)]){
      if(candidate.name!==field.name)continue;
      const value=parseExample(candidate.example??candidate.hint);
      if(Array.isArray(value)&&value.length){example=value;break;}
    }
  }
  if(!Array.isArray(example)||!example.length)return null;
  const type=value=>typeof value==='number'?'number':typeof value==='boolean'?'boolean':typeof value==='string'?'text':
    Array.isArray(value)&&value.every(v=>typeof v==='string')?'string-list':
    Array.isArray(value)&&value.length&&value.every(v=>typeof v==='number')?'number-list':null;
  const first=example[0];
  if(typeof first!=='object'||first===null){const kind=type(first);return ['text','number','boolean'].includes(kind)?{primitive:true,columns:[{name:'value',type:kind}]}:null;}
  if(Array.isArray(first))return null;
  const columns=Object.entries(first).map(([name,value])=>({name,type:type(value)}));
  return columns.length&&columns.every(c=>c.type)?{primitive:false,columns}:null;
}
function sourceOptions(value='') {
  const known=sourceDocs.some(d=>d.id===value);
  return '<option value="">Choose a source document</option>'+options(sourceDocs.map(d=>({value:d.id,label:d.name+' · '+d.id})),value)+
    (value&&!known?`<option value="${esc(value)}" selected>Previous / unavailable source: ${esc(value)}</option>`:'');
}
function rowControl(column,value,index) {
  const label=title(column.name),attrs=`data-cell-key="${esc(column.name)}" data-cell-type="${column.type}" aria-label="Row ${index+1}: ${esc(label)}"`;
  if(/documentId$/i.test(column.name))return `<select ${attrs} data-source-select>${sourceOptions(value??'')}</select>`;
  if(column.type==='boolean')return `<input type="checkbox" ${attrs} ${value?'checked':''}>`;
  if(column.type.endsWith('-list'))return `<textarea ${attrs} placeholder="One value per line">${esc(Array.isArray(value)?value.join('\n'):value??'')}</textarea>`;
  if(column.type==='number')return `<input type="number" step="any" ${attrs} value="${esc(value??'')}">`;
  if(/text|quote|summary|analysis|proposition|description/i.test(column.name))return `<textarea ${attrs}>${esc(value??'')}</textarea>`;
  return `<input type="${/date$/i.test(column.name)?'date':'text'}" ${attrs} value="${esc(value??'')}">`;
}
function rowsMarkup(schema,rows) {
  return `<div class="entry-table-wrap"><table class="entry-table"><thead><tr>${schema.columns.map(c=>`<th scope="col">${esc(title(c.name))}</th>`).join('')}<th scope="col">Actions</th></tr></thead><tbody>${rows.map((row,index)=>`<tr data-entry-row data-row-base="${esc(JSON.stringify(row))}">${schema.columns.map(c=>`<td>${rowControl(c,schema.primitive?row:row[c.name],index)}</td>`).join('')}<td><button type="button" class="btn" data-remove-row aria-label="Remove row ${index+1}">Remove</button></td></tr>`).join('')}</tbody></table>${rows.length?'':'<p class="work-meta">No rows yet. Add a row to enter this work.</p>'}</div>`;
}
function jsonField(f,definition) {
  const schema=arraySchema(f,definition),example=parseExample(f.example??f.hint),hint=f.hint?`<p class="field-hint">${esc(f.hint)}</p>`:'';
  const textarea=`<textarea name="data.${esc(f.name)}" ${f.required?'required':''} class="json-input" data-json="true" placeholder="${esc(example?JSON.stringify(example,null,2):'')}">${schema?'[]':''}</textarea>`;
  const load=`<label class="field-hint">Import a JSON file<input type="file" data-json-file="data.${esc(f.name)}" accept="application/json,.json"></label>`;
  if(!schema)return `<fieldset class="json-entry"><legend>${esc(f.label)}</legend>${textarea}${hint}${load}</fieldset>`;
  return `<fieldset class="json-entry" data-json-editor data-schema="${esc(JSON.stringify(schema))}"><legend>${esc(f.label)}</legend><div data-json-rows>${rowsMarkup(schema,[])}</div><button type="button" class="btn" data-add-row>Add row</button><p data-json-status class="field-hint" role="status"></p><details class="advanced-json"><summary>Advanced JSON and file import</summary><p class="field-hint">Table edits and JSON stay in sync. Imported extra fields are retained.</p>${textarea}${load}${hint}</details></fieldset>`;
}
function field(f,definition) {
  const attr=`name="data.${esc(f.name)}" ${f.required?'required':''}`;
  let input;
  if(f.type==='json')return jsonField(f,definition);
  if(/documentId$/i.test(f.name)) input=`<select ${attr} data-source-select>${sourceOptions()}</select>`;
  else if(f.type==='select') input=`<select ${attr}>${options(f.options??[])}</select>`;
  else if(f.type==='textarea') input=`<textarea ${attr}></textarea>`;
  else if(f.type==='file') input=`<input type="file" ${attr} accept="${esc(f.accept??'')}" data-encoding="${esc(f.encoding??'base64')}">`;
  else if(f.type==='checkbox') input=`<input type="checkbox" ${attr}>`;
  else input=`<input type="${f.type==='number'?'number':f.type==='date'?'date':'text'}" ${attr} ${f.type==='number'?'step="any"':''}>`;
  return `<label>${esc(f.label)}${input}${f.hint?`<span class="field-hint">${esc(f.hint)}</span>`:''}</label>`;
}
function sourceInventory(matter) {
  if(!matter)return '<p class="field-hint">Link a source matter to choose original documents.</p>';
  if(!sourceDocs.length)return '<p class="field-hint">This matter has no original documents. Upload originals in its workspace first.</p>';
  return `<details class="source-inventory"><summary>Source references (${sourceDocs.length})</summary><p class="field-hint">Use these IDs in imported records. Page numbers refer to the physical original PDF.</p><ul>${sourceDocs.map(doc=>`<li><a href="/api/matters/${encodeURIComponent(matter)}/documents/${encodeURIComponent(doc.id)}/original" target="_blank" rel="noopener">${esc(doc.name)}</a> · ${doc.pages?.length??'Unknown'} pages<div class="source-reference"><input readonly aria-label="Source ID for ${esc(doc.name)}" value="${esc(doc.id)}"><button type="button" class="btn" data-copy-reference="${esc(doc.id)}">Copy ID</button></div></li>`).join('')}</ul></details>`;
}
function refreshSourceChoices(matter) {
  for(const select of root.querySelectorAll('[data-source-select]')){const previous=select.value;select.innerHTML=sourceOptions(previous);select.value=previous;}
  const inventory=root.querySelector('#source-reference-list');if(inventory)inventory.innerHTML=sourceInventory(matter);
}
function editorRows(editor) {
  const schema=JSON.parse(editor.dataset.schema);
  return [...editor.querySelectorAll('[data-entry-row]')].map(row=>{
    const value=schema.primitive?{}:{...JSON.parse(row.dataset.rowBase)};
    for(const control of row.querySelectorAll('[data-cell-key]')){
      const kind=control.dataset.cellType,raw=control.value;
      value[control.dataset.cellKey]=kind==='boolean'?control.checked:kind==='number'?(raw===''?null:Number(raw)):
        kind==='string-list'?raw.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):
        kind==='number-list'?raw.split(/[,\r\n]+/).map(v=>v.trim()).filter(Boolean).map(Number):raw;
    }
    return schema.primitive?value.value:value;
  });
}
function syncRows(editor) {
  editor.querySelector('[data-json]').value=JSON.stringify(editorRows(editor),null,2);
  editor.querySelector('[data-json-status]').textContent='';
}
function applyJson(editor) {
  const schema=JSON.parse(editor.dataset.schema),text=editor.querySelector('[data-json]').value;
  try{
    const rows=JSON.parse(text);
    if(!Array.isArray(rows)||rows.length>200||rows.some(row=>schema.primitive?row!==null&&typeof row==='object':!row||typeof row!=='object'||Array.isArray(row)))throw new Error('Use an array of '+(schema.primitive?'values':'records')+' with at most 200 rows.');
    editor.querySelector('[data-json-rows]').innerHTML=rowsMarkup(schema,rows);editor.dataset.invalidJson='false';editor.querySelector('[data-json-status]').textContent='';
  }catch(error){editor.dataset.invalidJson='true';editor.querySelector('[data-json-rows]').innerHTML='';editor.querySelector('[data-json-status]').textContent='The table is paused until the JSON is valid. '+error.message;}
}
function renderValue(value,depth=0) {
  if(value===null||value===undefined)return '<span class="work-meta">Not recorded</span>';
  if(typeof value==='string')return value.length>1800?`<details><summary>Read complete text (${value.length.toLocaleString()} characters)</summary><div class="work-copy">${esc(value)}</div></details>`:/^[a-f0-9]{64}$/.test(value)?`<code>${esc(value)}</code>`:esc(value);
  if(typeof value!=='object')return esc(value);
  if(depth>5)return `<details><summary>Review complete nested record</summary><pre class="work-copy">${esc(JSON.stringify(value,null,2))}</pre></details>`;
  if(Array.isArray(value)) {
    if(!value.length)return '<span class="work-meta">None</span>';
    if(value.every(v=>v&&typeof v==='object'&&!Array.isArray(v))) {
      const keys=[...new Set(value.flatMap(v=>Object.keys(v)))];
      return `<div class="specialist-data"><table><thead><tr>${keys.map(k=>`<th>${esc(title(k))}</th>`).join('')}</tr></thead><tbody>${value.map(v=>`<tr>${keys.map(k=>`<td>${renderValue(v[k],depth+1)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<ul>${value.map(v=>`<li>${renderValue(v,depth+1)}</li>`).join('')}</ul>`;
  }
  return `<dl>${Object.entries(value).map(([k,v])=>`<dt>${esc(title(k))}</dt><dd>${renderValue(v,depth+1)}</dd>`).join('')}</dl>`;
}
let sourceRequest=0;
async function loadSources(matter) { const sequence=++sourceRequest;const docs=matter?(await request('/api/matters/'+encodeURIComponent(matter))).documents:[];if(sequence!==sourceRequest)return false;sourceDocs=docs;return true; }
function renderQueue() {
  root.innerHTML=`<section><h2>My specialist work</h2><label>Filter by role or title<input id="queue-filter" type="search" placeholder="For example: R54 or trust"></label><ul class="work-queue" id="queue-items">${catalog.items.map(item=>`<li data-search="${esc((item.roleId+' '+item.title).toLowerCase())}"><a href="?item=${encodeURIComponent(item.id)}">${esc(item.title)}</a><div class="work-meta">${esc(item.roleId+' · '+item.status+' · '+item.assignee+' → '+item.reviewer)}</div></li>`).join('')||'<li>No specialist assignments yet.</li>'}</ul></section>
    ${info.matterOnly?'':`<section><h2>Start specialist work</h2><form id="create-specialist"><label>Role workflow<select name="roleId" id="workflow-choice">${options(catalog.workflows.map(w=>({value:w.roleId,label:w.roleId+' · '+w.title})))}</select></label><p id="workflow-description" class="work-meta"></p>
    <label>Assignment title<input name="title" required maxlength="180"></label>
    <label>Preparer<select name="assignee">${options(catalog.roster.map(a=>({value:a.username,label:a.name+' ('+a.username+')'})))}</select></label>
    <label>Reviewing lawyer<select name="reviewer">${options(catalog.roster.filter(a=>a.role==='lawyer').map(a=>({value:a.username,label:a.name+' ('+a.username+')'})),info.username)}</select></label>
    <label>Source matter<select name="matter" id="source-matter"><option value="">No matter linked</option></select></label><p class="field-hint">The preparer and reviewer need current access to the source matter. A solo account records explicit self-review.</p>
    <div id="source-reference-list"></div><div id="create-domain-fields"></div><button class="btn primary">Create workflow</button></form></section>`}`;
  root.querySelector('#queue-filter').addEventListener('input',event=>{ for(const row of root.querySelectorAll('[data-search]')) row.hidden=!row.dataset.search.includes(event.target.value.toLowerCase()); });
  const choice=root.querySelector('#workflow-choice');
  if(choice){choice.addEventListener('change',renderCreationFields);renderCreationFields();}
}
function renderCreationFields() {
  const def=catalog.workflows.find(w=>w.roleId===root.querySelector('#workflow-choice').value);
  root.querySelector('#workflow-description').textContent=def.description;
  root.querySelector('#source-matter').required=def.matterRequired;
  root.querySelector('#create-domain-fields').innerHTML=def.fields.map(f=>field(f,def)).join('');
}
function renderItem() {
  const {item,validation}=itemInfo, def=catalog.workflows.find(w=>w.roleId===item.roleId);
  const preparer=item.assignee===info.username, reviewer=item.reviewer===info.username;
  const latest=item.versions.at(-1);
  const commands=def.actions.filter(a=>a.reviewerOnly?reviewer:preparer);
  const exports=version=>def.formats.map(format=>`<a href="${api}/${item.id}/export?version=${version.number}&format=${encodeURIComponent(format)}">${format==='json'?'Internal verification record':esc(format.toUpperCase())}</a>`).join('');
  root.innerHTML=`<p><a href="/workbench.html">← My specialist work</a></p><section><h2>${esc(item.title)}</h2><p><span class="workbench-badge">${esc(item.roleId+' · '+item.status)}</span> ${esc(item.assignee+' → '+item.reviewer)}</p><p class="work-meta">${esc(def.description)}</p>${item.matter?`<a href="/?matter=${encodeURIComponent(item.matter)}">Open source matter</a><div id="source-reference-list">${sourceInventory(item.matter)}</div>`:''}
    ${validation.errors.length?`<ul class="check-list">${validation.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:'<p class="check-pass">The workflow checks pass. Review the work and supporting evidence before approval.</p>'}
    ${validation.warnings.length?`<ul class="work-meta">${validation.warnings.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:''}</section>
    <div class="workbench-columns"><div><section><h2>Current work</h2><div class="specialist-data">${renderValue(item.data)}</div></section>
    ${latest?`<section><h2>Submitted output · version ${latest.number}</h2><p class="work-copy"><code>${esc(latest.sha256)}</code></p><div class="specialist-data">${renderValue(latest.output)}</div>${latest.sources.length?`<h3>Bound original sources</h3><ul>${latest.sources.map(s=>`<li><a href="/api/matters/${encodeURIComponent(item.matter)}/documents/${encodeURIComponent(s.documentId)}/original">${esc(s.name)}${s.page?' · page '+s.page:''}</a></li>`).join('')}</ul>`:''}</section>`:''}</div><aside>
    ${commands.length?`<section><h2>Workflow actions</h2>${commands.map(action=>`<details><summary>${esc(action.label)}</summary><form data-command="${esc(action.id)}">${action.fields.map(f=>field(f,def)).join('')}<button class="btn primary">${esc(action.label)}</button></form></details>`).join('')}</section>`:''}
    ${preparer&&item.status!=='submitted'?`<section><h2>Send for review</h2><form data-command="submit"><p>The submission preserves this work and its source references as an exact version.</p><button class="btn primary" ${validation.errors.length?'disabled':''}>Submit current work</button></form></section>`:''}
    ${reviewer&&item.status==='submitted'?`<section><h2>Review version ${latest.number}</h2><form id="review-specialist"><label>Review notes<textarea name="notes" required maxlength="2000"></textarea></label><label><span><input type="checkbox" name="attested"> I reviewed this output and its supporting sources.</span></label><div class="work-actions"><button class="btn primary" name="action" value="approve">Approve this version</button><button class="btn" name="action" value="return">Return for revision</button></div></form></section>`:''}
    <section><h2>Approved versions</h2>${item.versions.filter(v=>v.decision?.action==='approve').map(v=>`<p>Version ${v.number} · ${esc(v.decision.by)}</p><div class="workbench-links">${exports(v)}</div>`).join('')||'<p>No approved outputs yet.</p>'}<p class="work-meta">Changes require a new review. Previous approved versions remain available as historical records, subject to current access and release restrictions.</p></section>
    ${item.creator===info.username?`<details><summary>Change preparer or reviewer</summary><form data-command="change-assignment"><label>Preparer<select name="assignee">${options(catalog.roster.map(a=>({value:a.username,label:a.name+' ('+a.username+')'})),item.assignee)}</select></label><label>Reviewer<select name="reviewer">${options(catalog.roster.filter(a=>a.role==='lawyer').map(a=>({value:a.username,label:a.name+' ('+a.username+')'})),item.reviewer)}</select></label><p class="field-hint">The new participants need source-matter access. Changing participants requires a fresh submission and review.</p><button class="btn">Update assignment</button></form></details>`:''}
    <details><summary>Activity history</summary><ol>${item.history.map(e=>`<li>${esc(title(e.action)+' · '+e.actor+' · '+new Date(e.at).toLocaleString())}${e.note?'<br>'+esc(e.note):''}</li>`).join('')}</ol></details></aside></div>`;
}
async function values(form,fields) {
  const data={};
  for(const f of fields){const element=form.elements.namedItem('data.'+f.name);if(!element)continue;
    if(f.type==='file') {const file=element.files[0]; if(!file)continue;if(file.size>7*1024*1024)throw new Error('Choose a file smaller than 7 MB.');if(f.encoding==='text')data[f.name]=await file.text();else {const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));data[f.name]=btoa(binary);}}
    else if(f.type==='checkbox')data[f.name]=element.checked;
    else if(element.value!=='') {if(f.type==='number')data[f.name]=Number(element.value);else if(f.type==='json'){try{data[f.name]=JSON.parse(element.value);}catch{throw new Error(f.label+' needs valid JSON.');}}else data[f.name]=element.value;}
  }return data;
}
root.addEventListener('input',event=>{
  const editor=event.target.closest?.('[data-json-editor]');if(!editor)return;
  if(event.target.dataset.json)applyJson(editor);else if(event.target.dataset.cellKey)syncRows(editor);
});
root.addEventListener('click',async event=>{
  const button=event.target.closest?.('button');if(!button)return;
  try{
    if(button.dataset.copyReference){
      if(globalThis.navigator?.clipboard?.writeText){await navigator.clipboard.writeText(button.dataset.copyReference);message('Source ID copied.');}
      else{const input=button.parentElement.querySelector('input');input.focus();input.select();message('Source ID selected. Copy it with your keyboard.');}
    }
    if(button.hasAttribute('data-add-row')){
      const editor=button.closest('[data-json-editor]');if(editor.dataset.invalidJson==='true')throw new Error('Fix the JSON before adding a row.');
      const rows=editorRows(editor);if(rows.length>=200)throw new Error('Use at most 200 rows in one table.');
      const schema=JSON.parse(editor.dataset.schema),empty=schema.primitive?'':Object.fromEntries(schema.columns.map(c=>[c.name,c.type.endsWith('-list')?[]:c.type==='boolean'?false:'']));
      rows.push(empty);editor.querySelector('[data-json-rows]').innerHTML=rowsMarkup(schema,rows);syncRows(editor);
    }
    if(button.hasAttribute('data-remove-row')){const editor=button.closest('[data-json-editor]');button.closest('[data-entry-row]').remove();syncRows(editor);}
  }catch(error){message(error.message,true);}
});
root.addEventListener('change',async event=>{
  try{
    const editor=event.target.closest?.('[data-json-editor]');if(editor&&event.target.dataset.cellKey)syncRows(editor);
    if(event.target.id==='source-matter'){const matter=event.target.value;if(await loadSources(matter))refreshSourceChoices(matter);}
    if(event.target.dataset.jsonFile){const file=event.target.files[0];if(file){if(file.size>7*1024*1024)throw new Error('Choose a file smaller than 7 MB.');const text=await file.text();JSON.parse(text);const target=event.target.form.elements.namedItem(event.target.dataset.jsonFile);target.value=text;const editor=target.closest('[data-json-editor]');if(editor)applyJson(editor);}}
  }catch(error){message(error.message,true);}
});
root.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;
  const form=event.target,buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{
    if(form.id==='create-specialist'){
      const def=catalog.workflows.find(w=>w.roleId===form.elements.roleId.value);
      const body={roleId:def.roleId,title:form.elements.title.value,assignee:form.elements.assignee.value,reviewer:form.elements.reviewer.value,matter:form.elements.matter.value,data:await values(form,def.fields)};
      const signature=JSON.stringify(body);if(pendingCreate?.signature!==signature)pendingCreate={signature,id:crypto.randomUUID()};body.requestId=pendingCreate.id;
      const result=await request(api,body);location.href='?item='+result.item.id;
    }else{
      const item=itemInfo.item,def=catalog.workflows.find(w=>w.roleId===item.roleId);
      const action=form.id==='review-specialist'?event.submitter.value:form.dataset.command;
      const body={action,revision:item.revision,data:await values(form,def.actions.find(a=>a.id===action)?.fields??[])};
      if(action==='change-assignment')body.data={assignee:form.elements.assignee.value,reviewer:form.elements.reviewer.value};
      if(form.id==='review-specialist')Object.assign(body,{sha256:item.submission.sha256,notes:form.elements.notes.value,attested:form.elements.attested.checked});
      await request(api+'/'+selected,body);itemInfo=await request(api+'/'+selected);renderItem();message('Workflow updated.');
    }
  }catch(error){message(error.message,true);}finally{busy=false;buttons.forEach(b=>b.disabled=false);}
});
async function start(){try{[info,catalog]=await Promise.all([request('/api/bootstrap'),request(api)]);if(selected){itemInfo=await request(api+'/'+selected);await loadSources(itemInfo.item.matter);renderItem();}else{renderQueue();const select=root.querySelector('#source-matter');if(select){const matters=await request('/api/matters');select.innerHTML='<option value="">No matter linked</option>'+options(matters.map(m=>({value:m.id,label:m.name})));}}root.setAttribute('aria-busy','false');}catch(error){root.textContent='';message(error.message,true);root.setAttribute('aria-busy','false');}}
start();
