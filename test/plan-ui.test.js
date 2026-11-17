import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {matchesTree} from '../public/plan-tree.js';
import {sanitizeHTML,plainText,hasText,hasContent} from '../public/rich-text.js';

// 在轻量 DOM 适配器中运行真实 app.js，验证按钮事件到列表、计数及导出的联动。
// 不模拟排版或原生控件，视觉验收仍须浏览器执行。
test('前端组织 / 人员点击、选中状态、搜索及状态叠加、导出刷新权限和依据视图',async()=>{
 const elements=new Map();
 const element=selector=>{
  if(!elements.has(selector))elements.set(selector,{value:'',style:{},dataset:{},innerHTML:'',textContent:'',hidden:false,events:{},classList:{toggle(){}},addEventListener(name,handler){this.events[name]=handler;}});
  return elements.get(selector);
 };
 const nodes=[{id:'root',name:'总部',parentId:null},{id:'a',name:'运营',parentId:'root'},{id:'leaf',name:'小组',parentId:'a'},{id:'b',name:'研发',parentId:'root'}];
 const people=[{id:'self',displayName:'本人',organizationIds:['a'],enabled:true},{id:'child',displayName:'下属',organizationIds:['leaf'],enabled:true}];
 const plan=(id,ownerUserId,organizationId,status='进行中')=>({id,title:id,ownerUserId,organizationId,status,department:'部门',owner:'成员',due:'2999-01-01',basisIds:['basis'],goal:'目标',tasks:'行动',progress:20});
 let data={plans:[plan('本人的计划','self','a'),plan('小组计划','child','leaf','已完成')],bases:[{id:'basis',title:'共享依据',category:'其他',content:'正文'}]};
 let downloads=0,dataRequests=0;
 const document={hidden:false,querySelector:selector=>selector==='dialog[open]'?null:element(selector),querySelectorAll:()=>[],addEventListener(){},createElement:()=>({click(){downloads++;}})};
 const context=vm.createContext({document,window:{addEventListener(){}},location:{replace(){}},matchesTree,sanitizeHTML,plainText,hasText,hasContent,richField(){return '';},destroyEditors(){},setupEditors(){},setInterval(){},setTimeout(){},Blob,URL:{createObjectURL:()=>'',revokeObjectURL(){}},fetch:async route=>{
  if(route==='/api/data')dataRequests++;
  const body=route==='/api/auth/me'?{id:'self',displayName:'本人',role:'user'}:route==='/api/plan-scope'?{organizations:nodes,people}:data;
  return {status:200,ok:true,json:async()=>structuredClone(body)};
 }});
 const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('boot().catch(', 'globalThis.ready=boot().catch(');
 vm.runInContext(source,context);await context.ready;
 const ownerFields=vm.runInContext("editing={type:'plans'};planOwnerFields({})",context);
 assert.match(ownerFields,/name="ownerUserId"/);assert.match(ownerFields,/value="self" selected/);assert.doesNotMatch(ownerFields,/name="owner"/);
 element('#form').elements={ownerUserId:{value:'child'},organizationId:{value:'',innerHTML:''}};
 vm.runInContext("updatePlanOrganizations()",context);assert.equal(element('#form').elements.organizationId.value,'leaf');assert.doesNotMatch(element('#form').elements.organizationId.innerHTML,/value="b"/);
 assert.equal(element('#count').textContent,'共 2 项');assert.match(element('#tree-content').innerHTML,/权限范围内全部/);
 const click=(type,id)=>element('#tree-content').events.click({target:{closest:()=>({dataset:{treeType:type,treeId:id}})}});
 click('organization','leaf');assert.equal(element('#count').textContent,'共 1 项');assert.match(element('#list').innerHTML,/小组计划/);assert.doesNotMatch(element('#list').innerHTML,/本人的计划/);assert.equal(element('#tree-selection').textContent,'总部 / 运营 / 小组');
 assert.match(element('#tree-content').innerHTML,/data-tree-id="leaf" aria-pressed="true"/);
 click('person','self');assert.equal(element('#count').textContent,'共 1 项');assert.match(element('#list').innerHTML,/本人的计划/);
 element('#status').value='已完成';element('#status').events.change();assert.equal(element('#count').textContent,'共 0 项');
 click('all');assert.equal(element('#count').textContent,'共 1 项');element('#search').value='本人';element('#search').events.input();assert.equal(element('#count').textContent,'共 0 项');
 element('#status').value='';element('#search').value='';click('all');
 // 导出前若权限变化，刷新后只导出最新服务端返回的记录。
 data={...data,plans:[data.plans[0]]};const before=dataRequests;await element('#export').onclick();assert.ok(dataRequests>before);assert.equal(downloads,1);assert.equal(element('#count').textContent,'共 1 项');
 vm.runInContext("view='bases';render();",context);assert.equal(element('#plan-tree').hidden,true);assert.match(element('#list').innerHTML,/共享依据/);
});
