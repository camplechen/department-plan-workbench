import {matchesTree} from './plan-tree.js';
import {sanitizeHTML,plainText,hasText,hasContent} from './rich-text.js';
import {richField,setupEditors,destroyEditors,readEditors} from './rich-editor.js';
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let db={plans:[],bases:[]},view='plans',grouped=false,editing=null,currentUser=null,users=[],editingUser=null,organizations=[],editingOrganization=null,userTab='users';
let planScope={organizations:[],people:[]},treeSelection=null;
const expandedOrganizations=new Set();
const today=()=>new Date().toLocaleDateString('en-CA');
const overdue=p=>p.due<today()&&!['已完成','已暂停'].includes(p.status);
const badge=p=>`<span class="badge ${overdue(p)?'red':p.status==='已完成'?'green':p.status==='草稿'||p.status==='已暂停'?'gray':''}">${overdue(p)?'已逾期':esc(p.status)}</span>`;
function toast(t){$('#toast').textContent=t;$('#toast').style.display='block';setTimeout(()=>$('#toast').style.display='none',3000);}
async function api(url,method='GET',data){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(r.status===401){location.replace('/login');throw Error('登录已失效，请重新登录');}if(!r.ok)throw Error(v.error);return v;}
async function load(){db=await api('/api/data');planScope=await api('/api/plan-scope');if(treeSelection&&treeSelection.type!=='unassigned'&&!(treeSelection.type==='person'?planScope.people:planScope.organizations).some(n=>n.id===treeSelection.id))treeSelection=null;if(currentUser?.role==='admin'){users=await api('/api/users');organizations=await api('/api/organizations');}render();}
const opts=(items,current)=>items.map(x=>`<option ${x===current?'selected':''}>${esc(x)}</option>`).join('');
function render(){
 renderPlanTree();
 $('#stats').hidden=view==='users';$('#business-tabs').hidden=view==='users';$('#user-tabs').hidden=view!=='users';$('.filters').hidden=view==='users';$('#export').hidden=view==='users';
 if(view==='users'){renderUsers();return;}
 const isPlan=view==='plans';$('#breadcrumb').textContent='工作台 / '+(isPlan?'部门工作计划':'制定依据库');$('#page-title').textContent=isPlan?'部门工作计划':'制定依据库';$('#subtitle').textContent=isPlan?'把部门目标转化为行动，让制定依据与计划紧密相连。':'沉淀目标、数据与要求，为每一项计划提供清晰的依据。';$('#create').textContent=isPlan?'＋ 新建计划':'＋ 新建依据';
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
 const stats=isPlan?[[db.plans.length,'全部计划','部门行动总览','▦'],[db.plans.filter(p=>p.status==='进行中').length,'进行中','正在推进的工作','◷'],[db.plans.filter(p=>p.status==='已完成').length,'已完成','已达成的工作目标','✓'],[db.plans.filter(overdue).length,'已逾期','需要及时关注','!']]:[[db.bases.length,'全部依据','部门计划知识沉淀','▤'],[new Set(db.bases.map(b=>b.category)).size,'依据分类','多维度梳理计划来源','◇'],[db.bases.filter(b=>db.plans.some(p=>p.basisIds.includes(b.id))).length,'已关联依据','已转化为行动的依据','↗'],[db.bases.filter(b=>!db.plans.some(p=>p.basisIds.includes(b.id))).length,'待关联依据','可进一步制定计划','＋']];
 $('#stats').innerHTML=stats.map(([n,t,s,i])=>`<div class="stat"><span class="symbol">${i}</span><small>${t}</small><strong>${n}</strong><em>${s}</em></div>`).join('');
 $('#all-tab').textContent=isPlan?'全部计划':'全部依据';$('#group-tab').hidden=!isPlan;$('#all-tab').classList.toggle('selected',!grouped||!isPlan);$('#group-tab').classList.toggle('selected',grouped&&isPlan);$('#status').style.display=isPlan?'':'none';$('#department').style.display=isPlan?'':'none';$('#category').style.display=isPlan?'none':'block';$('#export').textContent=isPlan?'↓ 导出计划':'↓ 导出依据';$('#search').placeholder=isPlan?'搜索计划、负责人、部门…':'搜索依据名称、来源、正文…';
 const dep=$('#department').value;$('#department').innerHTML='<option value="">全部部门</option>'+opts([...new Set(db.plans.map(p=>p.department))],dep);
 const q=$('#search').value.toLowerCase();const list=isPlan?db.plans.filter(p=>matchesTree(p,treeSelection,planScope.organizations)&&(!q||[p.title,p.department,p.owner,plainText(p.goal),plainText(p.tasks),...p.basisIds.map(id=>db.bases.find(b=>b.id===id)?.title)].join(' ').toLowerCase().includes(q))&&(!$('#department').value||p.department===$('#department').value)&&(!$('#status').value||($('#status').value==='已逾期'?overdue(p):p.status===$('#status').value))):db.bases.filter(b=>(!q||[b.title,b.source,b.content].join(' ').toLowerCase().includes(q))&&(!$('#category').value||b.category===$('#category').value));
 $('#count').textContent=`共 ${list.length} 项`;window.filtered=list;
 if(isPlan&&grouped){const groups=[...db.bases,{id:'none',title:'未关联依据',category:'待整理',content:'为这些计划补充制定依据，让行动有据可依。'}];$('#list').innerHTML=groups.map(b=>{const plans=list.filter(p=>b.id==='none'?!p.basisIds.length:p.basisIds.includes(b.id));if(!plans.length&&q)return '';return `<div class="group"><h3>${b.id==='none'?esc(b.title):`<button class="title-link" data-detail="${b.id}" data-type="bases">${esc(b.title)}</button>`} <span class="badge gray">${esc(b.category)}</span></h3><p>${esc(b.content.slice(0,150))} · ${plans.length} 项计划</p>${plans.map(p=>`<div class="mini"><button class="title-link" data-detail="${p.id}" data-type="plans">${esc(p.title)}</button><span>${esc(p.department)}</span>${badge(p)}<button data-edit="${p.id}" data-type="plans">编辑计划</button></div>`).join('')||'<p>暂无关联计划</p>'}</div>`;}).join('')||empty();return;}
 if(!list.length){$('#list').innerHTML=empty();return;}
 $('#list').innerHTML=isPlan?`<table><thead><tr><th>计划名称 / 制定依据</th><th>部门 / 负责人</th><th>截止日期</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>${list.map(p=>`<tr><td><button class="title-link" data-detail="${p.id}" data-type="plans">${esc(p.title)}</button><span class="sub">${p.basisIds.length?p.basisIds.map(id=>esc(db.bases.find(b=>b.id===id)?.title)).join(' · '):'尚未关联制定依据'}</span></td><td>${esc(p.department)}<span class="sub">${p.ownerUserId?esc(p.owner):'<span class="badge red">未归属</span> '+esc(p.owner)} · ${esc(p.priority)}优先级</span></td><td>${esc(p.due)}</td><td>${badge(p)}</td><td><div class="progress"><progress max="100" value="${p.progress}"></progress>${p.progress}%</div></td><td class="actions"><button data-edit="${p.id}" data-type="plans">编辑</button><button data-delete="${p.id}" data-type="plans">删除</button></td></tr>`).join('')}</tbody></table>`:`<table><thead><tr><th>依据名称</th><th>分类</th><th>来源 / 日期</th><th>关联计划</th><th>操作</th></tr></thead><tbody>${list.map(b=>`<tr><td><button class="title-link" data-detail="${b.id}" data-type="bases">${esc(b.title)}</button><span class="sub">${esc(b.content.slice(0,65))}</span></td><td><span class="badge">${esc(b.category)}</span></td><td>${esc(b.source||'未填写来源')}<span class="sub">${esc(b.date||'未填写日期')}</span></td><td>${db.plans.filter(p=>p.basisIds.includes(b.id)).length} 项</td><td class="actions"><button data-plan="${b.id}">制定计划</button><button data-edit="${b.id}" data-type="bases">编辑</button><button data-delete="${b.id}" data-type="bases">删除</button></td></tr>`).join('')}</tbody></table>`;
}
function empty(){return '<div class="empty"><h3>让工作从一项清晰的计划开始</h3><p>当前没有符合条件的记录。你可以新建内容，或调整筛选条件。</p><button class="primary" data-new>＋ 立即新建</button></div>';}
function field(label,name,value='',type='text',wide=false,required=true){return `<label class="${wide?'wide':''}">${label}${required?' *':''}${type==='textarea'?`<textarea name="${name}" ${required?'required':''} maxlength="10000">${esc(value)}</textarea>`:`<input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${type==='number'?'min="0" max="100" step="1"':'maxlength="10000"'}>`}</label>`;}
function select(label,name,items,value){return `<label>${label}<select name="${name}">${opts(items,value)}</select></label>`;}
function edit(type,id,basis){destroyEditors();const p=db[type].find(x=>x.id===id)||{};editing={type,id};$('#dialog-title').textContent=(id?'编辑':'新建')+(type==='plans'?'部门工作计划':'制定依据');$('#form-error').textContent='';$('#fields').innerHTML=type==='plans'?
 field('计划名称','title',p.title,'text',true)+planOwnerFields(p)+field('开始日期','start',p.start||today(),'date')+field('截止日期','due',p.due||today(),'date')+select('优先级','priority',['中','高','低'],p.priority)+select('计划状态','status',['草稿','进行中','已完成','已暂停'],p.status)+field('完成进度（%）','progress',p.progress??0,'number')+richField('目标与验收标准','goal',p.goal,true)+richField('行动安排 / 进展记录','tasks',p.tasks)+`<label class="wide">制定依据（可多选）<div class="checks">${db.bases.length?db.bases.map(b=>`<label><input type="checkbox" name="basisIds" value="${b.id}" ${(p.basisIds||[basis]).includes(b.id)?'checked':''}>${esc(b.title)} · ${esc(b.category)}</label>`).join(''):'暂无依据，可先保存计划，再到「制定依据库」添加依据并关联。'}</div></label>`:
 field('依据名称','title',p.title,'text',true)+select('依据分类','category',['战略目标','经营数据','上级要求','问题改进','其他'],p.category)+field('依据日期','date',p.date||today(),'date',false,false)+field('来源（文件名称 / 会议 / 链接）','source',p.source,'text',true,false)+field('依据正文 / 关键要求','content',p.content,'textarea',true);
 if(type==='plans')updatePlanOrganizations(p.organizationId);
 $('#editor').showModal();setupEditors($('#fields'));}
async function detail(type,id){let p;try{p=await api('/api/'+type+'/'+id);}catch(error){toast(error.message);return;}const row=(k,v)=>`<h4>${k}</h4><p>${esc(v||'未填写')}</p>`;$('#detail-content').innerHTML=`<div class="dialog-head"><h2>${esc(p.title)}</h2></div><div class="detail-body">${type==='plans'?`<div class="detail-grid"><div>${row('部门 / 负责人',p.department+' / '+p.owner)}</div><div>${row('状态 / 进度',p.status+' / '+p.progress+'%')}</div><div>${row('计划周期',p.start+' 至 '+p.due)}</div><div>${row('优先级',p.priority)}</div></div><h4>目标与验收标准</h4><div class="rich-content">${sanitizeHTML(p.goal)}</div><h4>行动安排 / 进展记录</h4><div class="rich-content">${hasContent(p.tasks)?sanitizeHTML(p.tasks):'未填写'}</div><h4>制定依据</h4>${p.basisIds.map(id=>`<p>${esc(db.bases.find(b=>b.id===id)?.title)}</p>`).join('')||'<p>尚未关联</p>'}`:`${row('分类 / 来源',p.category+' / '+(p.source||'未填写'))}${row('依据日期',p.date)}${row('依据正文 / 关键要求',p.content)}<h4>关联计划</h4>${p.plans.map(x=>`<p><button class="title-link" data-related="${x.id}">${esc(x.title)}</button> · ${esc(x.department)} · ${esc(x.status)}</p>`).join('')||'<p>暂无关联计划</p>'}`}<h4>最近更新</h4><p>${esc(new Date(p.updatedAt).toLocaleString('zh-CN'))}</p></div>`;if(!$('#detail').open)$('#detail').showModal();}
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
document.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-close'))b.closest('dialog').close();if(b.dataset.view){view=b.dataset.view;$('#search').value='';$('#status').value='';$('#category').value='';$('#department').value='';render();}if(b.id==='create'||b.hasAttribute('data-new')){if(view==='users'){if(userTab==='organizations')editOrganization();else editUser();}else edit(view);}if(b.dataset.edit)edit(b.dataset.type,b.dataset.edit);if(b.dataset.detail)detail(b.dataset.type,b.dataset.detail);if(b.dataset.related)detail('plans',b.dataset.related);if(b.dataset.plan)edit('plans',null,b.dataset.plan);if(b.dataset.delete&&confirm('确定删除这条记录吗？删除后无法恢复。')){try{await api('/api/'+b.dataset.type+'/'+b.dataset.delete,'DELETE');await load();toast('已删除');}catch(e){toast(e.message);}}});
$('#all-tab').onclick=()=>{grouped=false;render();};$('#group-tab').onclick=()=>{grouped=true;render();};['search','status','department','category'].forEach(id=>$('#'+id).addEventListener(id==='search'?'input':'change',render));
$('#export').onclick=async()=>{try{await load();const is=view==='plans';const rows=is?[['计划名称','部门','负责人','开始日期','截止日期','优先级','状态','进度','目标','行动安排','制定依据'],...window.filtered.map(p=>[p.title,p.department,p.owner,p.start,p.due,p.priority,p.status,p.progress,plainText(p.goal),plainText(p.tasks),p.basisIds.map(id=>db.bases.find(b=>b.id===id)?.title).join('；')])]:[['依据名称','分类','来源','日期','正文'],...window.filtered.map(b=>[b.title,b.category,b.source,b.date,b.content])];const csv=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(is?'部门工作计划':'制定依据')+'-'+today()+'.csv';a.click();URL.revokeObjectURL(url);toast('已导出当前筛选结果');}catch(error){toast(error.message);}};
async function boot(){currentUser=await api('/api/auth/me');$('#current-user').textContent=currentUser.displayName+(currentUser.role==='admin'&&currentUser.displayName!=='管理员'?' · 管理员':'');$('#users-nav').hidden=currentUser.role!=='admin';await load();for(const o of planScope.organizations)expandedOrganizations.add(o.id);render();}
boot().catch(error=>{$('#list').innerHTML='<div class="empty">读取失败，请确认本地服务已启动后刷新。</div>';toast(error.message);});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
$('#logout').onclick=async()=>{try{await api('/api/auth/logout','POST');location.replace('/login');}catch(error){toast(error.message);}};

function renderUsers(){
 $('#breadcrumb').textContent='工作台 / 用户管理';$('#page-title').textContent='用户管理';$('#subtitle').textContent='由管理员分配账号、设置角色和管理登录权限。';$('#create').textContent='＋ 新建用户';
 document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view==='users'));
 document.querySelectorAll('[data-user-tab]').forEach(b=>b.classList.toggle('selected',b.dataset.userTab===userTab));
 if(userTab==='organizations'){renderOrganizations();return;}
 $('#list').innerHTML=`<table><thead><tr><th>账号 / 显示名称</th><th>归属组织机构</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.username)}<span class="sub">${esc(u.displayName)}${u.id===currentUser.id?' · 当前用户':''}</span></td><td class="organization-path">${(u.organizationIds||[]).map(id=>esc(organizationPath(id))).join('<br>')}</td><td>${u.role==='admin'?'管理员':'普通用户'}</td><td><span class="badge ${u.enabled?'green':'gray'}">${u.enabled?'启用':'已停用'}</span></td><td>${esc(new Date(u.createdAt).toLocaleString('zh-CN'))}</td><td class="actions"><button data-user-edit="${esc(u.id)}">编辑 / 重置密码</button>${u.id!==currentUser.id?`<button data-user-delete="${esc(u.id)}">删除</button>`:''}</td></tr>`).join('')}</tbody></table>`;
}
function editUser(id){
 if(!organizations.length){toast('请先在组织架构管理中新建机构');userTab='organizations';render();return;}
 const u=users.find(u=>u.id===id);editingUser=u?.id||null;
 const form=$('#user-form');form.reset();form.elements.username.value=u?.username||'';form.elements.username.readOnly=!!u;form.elements.displayName.value=u?.displayName||'';form.elements.role.value=u?.role||'user';form.elements.enabled.value=String(u?.enabled??true);form.elements.password.required=!u;$('#user-organizations').innerHTML=organizationRows().map(({node})=>`<label><input type="checkbox" name="organizationIds" value="${esc(node.id)}" ${u?.organizationIds?.includes(node.id)?'checked':''}>${esc(organizationPath(node.id))}</label>`).join('');
 $('#password-help').textContent=u?'留空保留原密码；修改密码后该用户须重新登录。':'设置 4 至 128 个字符的初始密码。';$('#user-dialog-title').textContent=u?'编辑用户':'新建用户';$('#user-form-error').textContent='';$('#user-editor').showModal();
}
$('#user-editor').addEventListener('close',()=>$('#user-form').reset());
$('#user-form').onsubmit=async event=>{
 event.preventDefault();const button=event.submitter;button.disabled=true;$('#user-form-error').textContent='';
 try{
  const formData=new FormData(event.target),data=Object.fromEntries(formData);data.enabled=data.enabled==='true';data.organizationIds=formData.getAll('organizationIds');if(!data.organizationIds.length)throw Error('请至少选择一个归属组织机构');
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

// 用完整路径区分不同分支的同名机构，按树顺序展示可选机构。
function organizationPath(id){
 const names=[];let node=organizations.find(o=>o.id===id);
 while(node){names.unshift(node.name);node=organizations.find(o=>o.id===node.parentId);}
 return names.join(' / ');
}
function organizationRows(){
 const rows=[],stack=organizations.filter(o=>!o.parentId).reverse().map(o=>({node:o,depth:0}));
 while(stack.length){const row=stack.pop();rows.push(row);stack.push(...organizations.filter(o=>o.parentId===row.node.id).reverse().map(node=>({node,depth:row.depth+1})));}
 return rows;
}
function organizationOptions(excluded=new Set()){
 return organizationRows().filter(({node})=>!excluded.has(node.id)).map(({node})=>`<option value="${esc(node.id)}">${esc(organizationPath(node.id))}</option>`).join('');
}
function renderOrganizations(){
 $('#subtitle').textContent='维护多层级组织机构，为用户分配明确的归属。';$('#create').textContent='＋ 新建机构';
 $('#list').innerHTML=organizations.length?`<table class="organization-table"><thead><tr><th>组织架构</th><th>直属用户数</th><th>操作</th></tr></thead><tbody>${organizationRows().map(({node,depth})=>`<tr><td><div class="organization-name" style="padding-left:${Math.min(depth,12)*20}px">${depth?'└ ':''}${esc(node.name)}</div><span class="sub organization-path">${esc(organizationPath(node.id))}</span></td><td>${users.filter(u=>u.organizationIds?.includes(node.id)).length}</td><td class="actions"><button data-organization-child="${esc(node.id)}">新增下级</button><button data-organization-edit="${esc(node.id)}">编辑</button><button data-organization-delete="${esc(node.id)}">删除</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty"><h3>尚未创建组织机构</h3><p>点击「新建机构」建立组织架构，再为用户选择归属。</p></div>';
}
function editOrganization(id,parentId=null){
 const node=organizations.find(o=>o.id===id);editingOrganization=node?.id||null;
 const excluded=new Set(node?[node.id]:[]);
 for(const {node:o} of organizationRows())if(excluded.has(o.parentId))excluded.add(o.id);
 const form=$('#organization-form');form.reset();form.elements.name.value=node?.name||'';
 form.elements.parentId.innerHTML='<option value="">无上级（顶级机构）</option>'+organizationOptions(excluded);
 form.elements.parentId.value=node?.parentId||parentId||'';
 $('#organization-dialog-title').textContent=node?'编辑组织机构':parentId?'新增下级机构':'新建组织机构';
 $('#organization-form-error').textContent='';$('#organization-editor').showModal();
}
$('#organization-form').onsubmit=async event=>{
 event.preventDefault();const button=event.submitter;button.disabled=true;$('#organization-form-error').textContent='';
 try{
  const data=Object.fromEntries(new FormData(event.target));data.parentId=data.parentId||null;
  await api('/api/organizations'+(editingOrganization?'/'+editingOrganization:''),editingOrganization?'PUT':'POST',data);
  $('#organization-editor').close();await load();toast('组织机构已保存');
 }catch(error){$('#organization-form-error').textContent=error.message;}finally{button.disabled=false;}
};
document.addEventListener('click',async event=>{
 const b=event.target.closest('button');if(!b)return;
 if(b.dataset.userTab){userTab=b.dataset.userTab;render();}
 if(b.dataset.organizationEdit)editOrganization(b.dataset.organizationEdit);
 if(b.dataset.organizationChild)editOrganization(null,b.dataset.organizationChild);
 if(b.dataset.organizationDelete&&confirm('确定删除该机构？存在下级机构或归属用户时无法删除。')){
  try{await api('/api/organizations/'+b.dataset.organizationDelete,'DELETE');await load();toast('组织机构已删除');}catch(error){toast(error.message);}
 }
});

function planOwnerFields(plan){
 const owner=plan.ownerUserId||(editing.id?'':currentUser.id);
 return `<label>负责人 *<select name="ownerUserId" required>${owner?'':'<option value="">未归属，请选择用户</option>'}${planScope.people.map(u=>`<option value="${esc(u.id)}" ${u.id===owner?'selected':''}>${esc(u.displayName)}${u.id===currentUser.id?'（本人）':''}${u.enabled?'':'（已停用）'}</option>`).join('')}</select></label><label>所属部门 / 机构 *<select name="organizationId" required></select></label>`;
}
function scopePath(id){const names=[];let node=planScope.organizations.find(o=>o.id===id);while(node){names.unshift(node.name);node=planScope.organizations.find(o=>o.id===node.parentId);}return names.join(' / ');}
function updatePlanOrganizations(selected){
 const form=$('#form'),owner=planScope.people.find(u=>u.id===form.elements.ownerUserId.value);
 form.elements.organizationId.innerHTML='<option value="">请选择所属机构</option>'+planScope.organizations.filter(o=>owner?.organizationIds.includes(o.id)).map(o=>`<option value="${esc(o.id)}" ${o.id===selected?'selected':''}>${esc(scopePath(o.id))}</option>`).join('');
 if(owner?.organizationIds.length===1)form.elements.organizationId.value=owner.organizationIds[0];
}
$('#form').addEventListener('change',event=>{if(event.target.name==='ownerUserId')updatePlanOrganizations();});
function renderPlanTree(){
 const container=$('#plan-tree');container.hidden=view!=='plans';$('#tree-selection').hidden=view!=='plans';if(view!=='plans')return;
 const selected=(type,id)=>treeSelection?.type===type&&treeSelection.id===id;
 const person=u=>`<button data-tree-type="person" data-tree-id="${esc(u.id)}" aria-pressed="${selected('person',u.id)}" class="tree-person ${selected('person',u.id)?'active':''}">♙ ${esc(u.displayName)}${u.id===currentUser.id?'（本人）':''}</button>`;
 const branch=parent=>planScope.organizations.filter(o=>o.parentId===parent).map(o=>`<details data-tree-branch="${esc(o.id)}" ${expandedOrganizations.has(o.id)?'open':''}><summary><button data-tree-type="organization" data-tree-id="${esc(o.id)}" aria-pressed="${selected('organization',o.id)}" class="${selected('organization',o.id)?'active':''}">${esc(o.name)}</button></summary><div class="tree-children">${planScope.people.filter(u=>u.organizationIds.includes(o.id)).map(person).join('')}${branch(o.id)}</div></details>`).join('');
 $('#tree-content').innerHTML=`<button data-tree-type="all" aria-pressed="${!treeSelection}" class="${treeSelection?'':'active'}">权限范围内全部</button>${currentUser.role==='admin'?`<button data-tree-type="unassigned" class="${treeSelection?.type==='unassigned'?'active':''}" aria-pressed="${treeSelection?.type==='unassigned'}">未归属计划</button>`:''}${branch(null)}`;
 $('#tree-selection').textContent=treeSelection?(treeSelection.type==='unassigned'?'未归属计划':treeSelection.type==='person'?planScope.people.find(u=>u.id===treeSelection.id)?.displayName:scopePath(treeSelection.id)):'权限范围内全部';
}
$('#tree-content').addEventListener('toggle',event=>{const id=event.target.dataset.treeBranch;if(id){if(event.target.open)expandedOrganizations.add(id);else expandedOrganizations.delete(id);}},true);
$('#tree-content').addEventListener('click',event=>{
 const button=event.target.closest('[data-tree-type]');if(!button)return;
 treeSelection=button.dataset.treeType==='all'?null:{type:button.dataset.treeType,id:button.dataset.treeId};
 if(treeSelection?.type==='organization')expandedOrganizations.add(treeSelection.id);
 render();
});
// 切回页面时重新取得权限和人员关系，避免长期停留在旧范围。
window.addEventListener('focus',()=>{load().catch(error=>toast(error.message));});

setInterval(()=>{if(!document.hidden&&!document.querySelector('dialog[open]'))load().catch(error=>toast(error.message));},60000);
