import {sanitizeHTML,plainText,hasText,hasContent} from './rich-text.js';
import {richField,setupEditors,destroyEditors,readEditors} from './rich-editor.js';
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let db={plans:[],bases:[]},view='plans',grouped=false,editing=null,currentUser=null,users=[],editingUser=null;
const today=()=>new Date().toLocaleDateString('en-CA');
const overdue=p=>p.due<today()&&!['已完成','已暂停'].includes(p.status);
const badge=p=>`<span class="badge ${overdue(p)?'red':p.status==='已完成'?'green':p.status==='草稿'||p.status==='已暂停'?'gray':''}">${overdue(p)?'已逾期':esc(p.status)}</span>`;
function toast(t){$('#toast').textContent=t;$('#toast').style.display='block';setTimeout(()=>$('#toast').style.display='none',3000);}
async function api(url,method='GET',data){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(r.status===401){location.replace('/login');throw Error('登录已失效，请重新登录');}if(!r.ok)throw Error(v.error);return v;}
async function load(){db=await api('/api/data');if(currentUser?.role==='admin')users=await api('/api/users');render();}
const opts=(items,current)=>items.map(x=>`<option ${x===current?'selected':''}>${esc(x)}</option>`).join('');
function render(){
 $('#stats').hidden=view==='users';$('.tabs').hidden=view==='users';$('.filters').hidden=view==='users';$('#export').hidden=view==='users';
 if(view==='users'){renderUsers();return;}
 const isPlan=view==='plans';$('#breadcrumb').textContent='工作台 / '+(isPlan?'部门工作计划':'制定依据库');$('#page-title').textContent=isPlan?'部门工作计划':'制定依据库';$('#subtitle').textContent=isPlan?'把部门目标转化为行动，让制定依据与计划紧密相连。':'沉淀目标、数据与要求，为每一项计划提供清晰的依据。';$('#create').textContent=isPlan?'＋ 新建计划':'＋ 新建依据';
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 const stats=isPlan?[[db.plans.length,'全部计划','部门行动总览','▦'],[db.plans.filter(p=>p.status==='进行中').length,'进行中','正在推进的工作','◷'],[db.plans.filter(p=>p.status==='已完成').length,'已完成','已达成的工作目标','✓'],[db.plans.filter(overdue).length,'已逾期','需要及时关注','!']]:[[db.bases.length,'全部依据','部门计划知识沉淀','▤'],[new Set(db.bases.map(b=>b.category)).size,'依据分类','多维度梳理计划来源','◇'],[db.bases.filter(b=>db.plans.some(p=>p.basisIds.includes(b.id))).length,'已关联依据','已转化为行动的依据','↗'],[db.bases.filter(b=>!db.plans.some(p=>p.basisIds.includes(b.id))).length,'待关联依据','可进一步制定计划','＋']];
 $('#stats').innerHTML=stats.map(([n,t,s,i])=>`<div class="stat"><span class="symbol">${i}</span><small>${t}</small><strong>${n}</strong><em>${s}</em></div>`).join('');
 $('#all-tab').textContent=isPlan?'全部计划':'全部依据';$('#group-tab').hidden=!isPlan;$('#all-tab').classList.toggle('selected',!grouped||!isPlan);$('#group-tab').classList.toggle('selected',grouped&&isPlan);$('#status').style.display=isPlan?'':'none';$('#department').style.display=isPlan?'':'none';$('#category').style.display=isPlan?'none':'block';$('#export').textContent=isPlan?'↓ 导出计划':'↓ 导出依据';$('#search').placeholder=isPlan?'搜索计划、负责人、部门…':'搜索依据名称、来源、正文…';
 const dep=$('#department').value;$('#department').innerHTML='<option value="">全部部门</option>'+opts([...new Set(db.plans.map(p=>p.department))],dep);
 const q=$('#search').value.toLowerCase();const list=isPlan?db.plans.filter(p=>(!q||[p.title,p.department,p.owner,plainText(p.goal),plainText(p.tasks),...p.basisIds.map(id=>db.bases.find(b=>b.id===id)?.title)].join(' ').toLowerCase().includes(q))&&(!$('#department').value||p.department===$('#department').value)&&(!$('#status').value||($('#status').value==='已逾期'?overdue(p):p.status===$('#status').value))):db.bases.filter(b=>(!q||[b.title,b.source,b.content].join(' ').toLowerCase().includes(q))&&(!$('#category').value||b.category===$('#category').value));
 $('#count').textContent=`共 ${list.length} 项`;window.filtered=list;
 if(isPlan&&grouped){const groups=[...db.bases,{id:'none',title:'未关联依据',category:'待整理',content:'为这些计划补充制定依据，让行动有据可依。'}];$('#list').innerHTML=groups.map(b=>{const plans=list.filter(p=>b.id==='none'?!p.basisIds.length:p.basisIds.includes(b.id));if(!plans.length&&q)return '';return `<div class="group"><h3>${b.id==='none'?esc(b.title):`<button class="title-link" data-detail="${b.id}" data-type="bases">${esc(b.title)}</button>`} <span class="badge gray">${esc(b.category)}</span></h3><p>${esc(b.content.slice(0,150))} · ${plans.length} 项计划</p>${plans.map(p=>`<div class="mini"><button class="title-link" data-detail="${p.id}" data-type="plans">${esc(p.title)}</button><span>${esc(p.department)}</span>${badge(p)}<button data-edit="${p.id}" data-type="plans">编辑计划</button></div>`).join('')||'<p>暂无关联计划</p>'}</div>`;}).join('')||empty();return;}
 if(!list.length){$('#list').innerHTML=empty();return;}
 $('#list').innerHTML=isPlan?`<table><thead><tr><th>计划名称 / 制定依据</th><th>部门 / 负责人</th><th>截止日期</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>${list.map(p=>`<tr><td><button class="title-link" data-detail="${p.id}" data-type="plans">${esc(p.title)}</button><span class="sub">${p.basisIds.length?p.basisIds.map(id=>esc(db.bases.find(b=>b.id===id)?.title)).join(' · '):'尚未关联制定依据'}</span></td><td>${esc(p.department)}<span class="sub">${esc(p.owner)} · ${esc(p.priority)}优先级</span></td><td>${esc(p.due)}</td><td>${badge(p)}</td><td><div class="progress"><progress max="100" value="${p.progress}"></progress>${p.progress}%</div></td><td class="actions"><button data-edit="${p.id}" data-type="plans">编辑</button><button data-delete="${p.id}" data-type="plans">删除</button></td></tr>`).join('')}</tbody></table>`:`<table><thead><tr><th>依据名称</th><th>分类</th><th>来源 / 日期</th><th>关联计划</th><th>操作</th></tr></thead><tbody>${list.map(b=>`<tr><td><button class="title-link" data-detail="${b.id}" data-type="bases">${esc(b.title)}</button><span class="sub">${esc(b.content.slice(0,65))}</span></td><td><span class="badge">${esc(b.category)}</span></td><td>${esc(b.source||'未填写来源')}<span class="sub">${esc(b.date||'未填写日期')}</span></td><td>${db.plans.filter(p=>p.basisIds.includes(b.id)).length} 项</td><td class="actions"><button data-plan="${b.id}">制定计划</button><button data-edit="${b.id}" data-type="bases">编辑</button><button data-delete="${b.id}" data-type="bases">删除</button></td></tr>`).join('')}</tbody></table>`;
}
function empty(){return '<div class="empty"><h3>让工作从一项清晰的计划开始</h3><p>当前没有符合条件的记录。你可以新建内容，或调整筛选条件。</p><button class="primary" data-new>＋ 立即新建</button></div>';}
function field(label,name,value='',type='text',wide=false,required=true){return `<label class="${wide?'wide':''}">${label}${required?' *':''}${type==='textarea'?`<textarea name="${name}" ${required?'required':''} maxlength="10000">${esc(value)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${type==='number'?'min="0" max="100" step="1"':'maxlength="10000"'}>`}</label>`;}
function select(label,name,items,value){return `<label>${label}<select name="${name}">${opts(items,value)}</select></label>`;}
function edit(type,id,basis){destroyEditors();const p=db[type].find(x=>x.id===id)||{};editing={type,id};$('#dialog-title').textContent=(id?'编辑':'新建')+(type==='plans'?'部门工作计划':'制定依据');$('#form-error').textContent='';$('#fields').innerHTML=type==='plans'?
 field('计划名称','title',p.title,'text',true)+field('所属部门','department',p.department)+field('负责人','owner',p.owner)+field('开始日期','start',p.start||today(),'date')+field('截止日期','due',p.due||today(),'date')+select('优先级','priority',['中','高','低'],p.priority)+select('计划状态','status',['草稿','进行中','已完成','已暂停'],p.status)+field('完成进度（%）','progress',p.progress??0,'number')+richField('目标与验收标准','goal',p.goal,true)+richField('行动安排 / 进展记录','tasks',p.tasks)+`<label class="wide">制定依据（可多选）<div class="checks">${db.bases.length?db.bases.map(b=>`<label><input type="checkbox" name="basisIds" value="${b.id}" ${(p.basisIds||[basis]).includes(b.id)?'checked':''}>${esc(b.title)} · ${esc(b.category)}</label>`).join(''):'暂无依据，可先保存计划，再到「制定依据库」添加依据并关联。'}</div></label>`:
 field('依据名称','title',p.title,'text',true)+select('依据分类','category',['战略目标','经营数据','上级要求','问题改进','其他'],p.category)+field('依据日期','date',p.date||today(),'date',false,false)+field('来源（文件名称 / 会议 / 链接）','source',p.source,'text',true,false)+field('依据正文 / 关键要求','content',p.content,'textarea',true);
 $('#editor').showModal();setupEditors($('#fields'));}
function detail(type,id){const p=db[type].find(x=>x.id===id);if(!p)return;const row=(k,v)=>`<h4>${k}</h4><p>${esc(v||'未填写')}</p>`;$('#detail-content').innerHTML=`<div class="dialog-head"><h2>${esc(p.title)}</h2></div><div class="detail-body">${type==='plans'?`<div class="detail-grid"><div>${row('部门 / 负责人',p.department+' / '+p.owner)}</div><div>${row('状态 / 进度',p.status+' / '+p.progress+'%')}</div><div>${row('计划周期',p.start+' 至 '+p.due)}</div><div>${row('优先级',p.priority)}</div></div><h4>目标与验收标准</h4><div class="rich-content">${sanitizeHTML(p.goal)}</div><h4>行动安排 / 进展记录</h4><div class="rich-content">${hasContent(p.tasks)?sanitizeHTML(p.tasks):'未填写'}</div><h4>制定依据</h4>${p.basisIds.map(id=>`<p>${esc(db.bases.find(b=>b.id===id)?.title)}</p>`).join('')||'<p>尚未关联</p>'}`:`${row('分类 / 来源',p.category+' / '+(p.source||'未填写'))}${row('依据日期',p.date)}${row('依据正文 / 关键要求',p.content)}<h4>关联计划</h4>${db.plans.filter(x=>x.basisIds.includes(id)).map(x=>`<p><button class="title-link" data-related="${x.id}">${esc(x.title)}</button> · ${esc(x.department)} · ${esc(x.status)}</p>`).join('')||'<p>暂无关联计划</p>'}`}<h4>最近更新</h4><p>${esc(new Date(p.updatedAt).toLocaleString('zh-CN'))}</p></div>`;if(!$('#detail').open)$('#detail').showModal();}
$('#editor').addEventListener('close',()=>{destroyEditors();$('#editor').classList.remove('editor-fullscreen');});
$('#editor').addEventListener('cancel',e=>{const editor=tinymce.activeEditor;if($('#editor .tox-dialog')){e.preventDefault();return;}if(editor?.plugins.fullscreen?.isFullscreen()){e.preventDefault();editor.execCommand('mceFullScreen');}});
$('#detail-content').addEventListener('click',event=>{const image=event.target.closest('.rich-content img');if(image)window.open(image.src,'_blank','noopener,noreferrer');});
$('#form').onsubmit=async e=>{
 e.preventDefault();const button=e.submitter||$('#form button[type="submit"]');if(button.disabled)return;button.disabled=true;
 try{
 const f=new FormData(e.target),data=Object.fromEntries(f);
 if(editing.type==='plans'){
 Object.assign(data,await readEditors());
 if(!hasText(data.goal))throw Error('请填写目标与验收标准');
 data.progress=Number(data.progress);data.basisIds=f.getAll('basisIds');
 }
 await api('/api/'+editing.type+(editing.id?'/'+editing.id:''),editing.id?'PUT':'POST',data);await load();$('#editor').close();toast('已保存');
 }catch(error){$('#form-error').textContent=error.message;}finally{button.disabled=false;}
};
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-close'))b.closest('dialog').close();if(b.dataset.view){view=b.dataset.view;$('#search').value='';$('#status').value='';$('#category').value='';$('#department').value='';render();}if(b.id==='create'||b.hasAttribute('data-new')){if(view==='users')editUser();else edit(view);}if(b.dataset.edit)edit(b.dataset.type,b.dataset.edit);if(b.dataset.detail)detail(b.dataset.type,b.dataset.detail);if(b.dataset.related)detail('plans',b.dataset.related);if(b.dataset.plan)edit('plans',null,b.dataset.plan);if(b.dataset.delete&&confirm('确定删除这条记录吗？删除后无法恢复。')){try{await api('/api/'+b.dataset.type+'/'+b.dataset.delete,'DELETE');await load();toast('已删除');}catch(e){toast(e.message);}}});
$('#all-tab').onclick=()=>{grouped=false;render();};$('#group-tab').onclick=()=>{grouped=true;render();};['search','status','department','category'].forEach(id=>$('#'+id).addEventListener(id==='search'?'input':'change',render));
$('#export').onclick=()=>{const is=view==='plans';const rows=is?[['计划名称','部门','负责人','开始日期','截止日期','优先级','状态','进度','目标','行动安排','制定依据'],...window.filtered.map(p=>[p.title,p.department,p.owner,p.start,p.due,p.priority,p.status,p.progress,plainText(p.goal),plainText(p.tasks),p.basisIds.map(id=>db.bases.find(b=>b.id===id)?.title).join('；')])]:[['依据名称','分类','来源','日期','正文'],...window.filtered.map(b=>[b.title,b.category,b.source,b.date,b.content])];const csv=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(is?'部门工作计划':'制定依据')+'-'+today()+'.csv';a.click();URL.revokeObjectURL(url);toast('已导出当前筛选结果');};
async function boot(){currentUser=await api('/api/auth/me');$('#current-user').textContent=currentUser.displayName+(currentUser.role==='admin'&&currentUser.displayName!=='管理员'?' · 管理员':'');$('#users-nav').hidden=currentUser.role!=='admin';await load();}
boot().catch(error=>{$('#list').innerHTML='<div class="empty">读取失败，请确认本地服务已启动后刷新。</div>';toast(error.message);});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
$('#logout').onclick=async()=>{try{await api('/api/auth/logout','POST');location.replace('/login');}catch(error){toast(error.message);}};

function renderUsers(){
 $('#breadcrumb').textContent='工作台 / 用户管理';$('#page-title').textContent='用户管理';$('#subtitle').textContent='由管理员分配账号、设置角色和管理登录权限。';$('#create').textContent='＋ 新建用户';
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view==='users'));
 $('#list').innerHTML=`<table><thead><tr><th>账号 / 显示名称</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.username)}<span class="sub">${esc(u.displayName)}${u.id===currentUser.id?' · 当前用户':''}</span></td><td>${u.role==='admin'?'管理员':'普通用户'}</td><td><span class="badge ${u.enabled?'green':'gray'}">${u.enabled?'启用':'已停用'}</span></td><td>${esc(new Date(u.createdAt).toLocaleString('zh-CN'))}</td><td class="actions"><button data-user-edit="${esc(u.id)}">编辑 / 重置密码</button>${u.id!==currentUser.id?`<button data-user-delete="${esc(u.id)}">删除</button>`:''}</td></tr>`).join('')}</tbody></table>`;
}
function editUser(id){
 const u=users.find(u=>u.id===id);editingUser=u?.id||null;
 const form=$('#user-form');form.reset();form.elements.username.value=u?.username||'';form.elements.username.readOnly=!!u;form.elements.displayName.value=u?.displayName||'';form.elements.role.value=u?.role||'user';form.elements.enabled.value=String(u?.enabled??true);form.elements.password.required=!u;
 $('#password-help').textContent=u?'留空保留原密码；修改密码后该用户须重新登录。':'设置 4 至 128 个字符的初始密码。';$('#user-dialog-title').textContent=u?'编辑用户':'新建用户';$('#user-form-error').textContent='';$('#user-editor').showModal();
}
$('#user-editor').addEventListener('close',()=>$('#user-form').reset());
$('#user-form').onsubmit=async event=>{
 event.preventDefault();const button=event.submitter;button.disabled=true;$('#user-form-error').textContent='';
 try{
  const data=Object.fromEntries(new FormData(event.target));data.enabled=data.enabled==='true';
  await api('/api/users'+(editingUser?'/'+editingUser:''),editingUser?'PUT':'POST',data);$('#user-editor').close();await boot();toast('用户已保存');
 }catch(error){$('#user-form-error').textContent=error.message;}finally{button.disabled=false;}
};
document.addEventListener('click',async event=>{
 const b=event.target.closest('button');if(!b)return;
 if(b.dataset.userEdit)editUser(b.dataset.userEdit);
 if(b.dataset.userDelete&&confirm('确定删除该用户？其登录会话会立即失效，已有计划和依据会保留。')){
  try{await api('/api/users/'+b.dataset.userDelete,'DELETE');await load();toast('用户已删除');}catch(error){toast(error.message);}
 }
});
