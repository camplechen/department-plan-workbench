import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile,readdir,mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {matchesTree} from '../public/plan-tree.js';
import {openStore} from '../src/database.js';

async function service(environment={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-auth-'));let proc,base;
 const start=()=>new Promise((resolve,reject)=>{
  proc=spawn(process.execPath,['server.js'],{env:{...process.env,APP_ORIGIN:'',...environment,PORT:'0',DATA_DIR:dir}});let output='';
  const timer=setTimeout(()=>{proc.kill();reject(Error('测试服务启动超时'));},10000);
  proc.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){base=match[0];clearTimeout(timer);resolve();}});
  proc.once('error',error=>{clearTimeout(timer);reject(error);});proc.once('exit',()=>{clearTimeout(timer);reject(Error('测试服务已退出'));});
 });
 const stop=()=>new Promise(resolve=>{if(proc.exitCode!==null)return resolve();proc.once('exit',resolve);proc.kill();});
 const client=()=>({cookie:'',async request(route,method='GET',data,headers={}){
  const response=await fetch(base+route,{method,redirect:'manual',headers:{'Content-Type':'application/json',Cookie:this.cookie,...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});
  const setCookie=response.headers.get('set-cookie');if(setCookie)this.cookie=setCookie.split(';')[0];
  const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}
  return {status:response.status,body,headers:response.headers};
 }});
 await start();return {dir,start,stop,client,url:()=>base,async close(){await stop();await rm(dir,{recursive:true,force:true});}};
}

test('登录保护、Cookie 保持、SQLite 会话、退出及过期失效',async()=>{
 const s=await service();try{
  const c=s.client();
  assert.equal((await c.request('/')).headers.get('location'),'/login');
  assert.equal((await c.request('/login')).status,200);
  for(const route of ['/api/data','/api/users','/api/auth/me','/uploads/12345678-1234-1234-1234-123456789abc.png'])assert.equal((await c.request(route)).status,401);
  assert.equal((await c.request('/api/auth/register','POST',{})).status,401);
  assert.equal((await c.request('/api/auth/login','POST',{username:'admin',password:'incorrect'})).status,401);
  assert.equal((await c.request('/api/auth/login','POST',{username:[],password:'x'})).status,401);
  assert.equal((await c.request('/api/auth/login','POST',{username:'admin',password:'admin'},{Origin:'http://untrusted.invalid'})).status,403);
  const login=await c.request('/api/auth/login','POST',{username:'admin',password:'admin'});
  assert.equal(login.status,200);assert.equal(login.body.role,'admin');assert.ok(!('passwordHash' in login.body));
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);assert.match(login.headers.get('set-cookie'),/Max-Age=2592000/);
  assert.equal((await c.request('/')).status,200);assert.equal((await c.request('/api/data')).headers.get('cache-control'),'no-store');
  const sql=new DatabaseSync(path.join(s.dir,'workbench.sqlite'));
  const row=sql.prepare('SELECT * FROM users').get();assert.notEqual(row.passwordHash,'admin');
  const session=sql.prepare('SELECT * FROM sessions').get();assert.notEqual(session.tokenHash,c.cookie.split('=')[1]);assert.ok(session.expiresAt>Date.now()+29*86400000);
  await s.stop();await s.start();assert.equal((await c.request('/api/auth/me')).status,200);
  const oldCookie=c.cookie;assert.equal((await c.request('/api/auth/logout','POST')).status,200);assert.equal((await c.request('/api/data')).status,401);
  c.cookie=oldCookie;assert.equal((await c.request('/api/data')).status,401);
  await c.request('/api/auth/login','POST',{username:'admin',password:'admin'});
  sql.prepare('UPDATE sessions SET expiresAt=?').run(Date.now()-1);assert.equal((await c.request('/api/auth/me')).status,401);sql.close();
  for(let i=0;i<10;i++)assert.equal((await c.request('/api/auth/login','POST',{username:'unknown.fixture',password:'incorrect'})).status,401);
  await s.stop();await s.start();assert.equal((await c.request('/api/auth/login','POST',{username:'unknown.fixture',password:'incorrect'})).status,429);
  await assert.rejects(readFile(path.join(s.dir,'workbench.json')),e=>e.code==='ENOENT');
 }finally{await s.close();}
});

test('管理员分配账号、用户管理权限、共享数据、重置密码及停用删除撤销会话',async()=>{
 const s=await service();try{
  const admin=s.client(),member=s.client();await admin.request('/api/auth/login','POST',{username:'admin',password:'admin'});
  const input={organizationIds:['default-organization'],username:'test.member',password:'fixture-password',displayName:'测试成员',role:'user',enabled:true};
  const created=await admin.request('/api/users','POST',input);assert.equal(created.status,201);const id=created.body.id;
  assert.equal((await admin.request('/api/users','POST',input)).status,409);
  assert.equal((await admin.request('/api/users','POST',{...input,username:input.username.toUpperCase()})).status,409);
  assert.equal((await admin.request('/api/users','POST',{...input,username:7})).status,400);
  assert.equal((await admin.request('/api/users','POST',{...input,username:'another',displayName:7})).status,400);
  assert.equal((await member.request('/api/auth/login','POST',{username:input.username,password:input.password})).status,200);
  const session=member.cookie;
  for(const [route,method,data] of [['/api/users','GET'],['/api/users','POST',input],['/api/users/'+id,'PUT',input],['/api/users/'+id,'DELETE']])assert.equal((await member.request(route,method,data)).status,403);
  const basis=await member.request('/api/bases','POST',{title:'共同依据',category:'其他',content:'共享内容'});assert.equal(basis.status,201);assert.equal((await admin.request('/api/data')).body.bases[0].id,basis.body.id);
  const list=await admin.request('/api/users');assert.ok(list.body.every(u=>!('passwordHash' in u)&&!('password' in u)));
  const self=list.body.find(u=>u.role==='admin');
  assert.equal((await admin.request('/api/users/'+self.id,'DELETE')).status,400);
  assert.equal((await admin.request('/api/users/'+self.id,'PUT',{...self,role:'user'})).status,400);
  assert.equal((await admin.request('/api/users/'+self.id,'PUT',{...self,enabled:false})).status,400);
  assert.equal((await admin.request('/api/users/'+id,'PUT',{...input,password:'fixture-replaced'})).status,200);
  member.cookie=session;assert.equal((await member.request('/api/data')).status,401);
  assert.equal((await member.request('/api/auth/login','POST',{username:input.username,password:input.password})).status,401);
  assert.equal((await member.request('/api/auth/login','POST',{username:input.username,password:'fixture-replaced'})).status,200);
  await admin.request('/api/users/'+id,'PUT',{...input,password:'',enabled:false});assert.equal((await member.request('/api/data')).status,401);
  assert.equal((await member.request('/api/auth/login','POST',{username:input.username,password:'fixture-replaced'})).status,401);
  await admin.request('/api/users/'+id,'PUT',{...input,password:'',enabled:true});await member.request('/api/auth/login','POST',{username:input.username,password:'fixture-replaced'});
  await admin.request('/api/users/'+id,'DELETE');assert.equal((await member.request('/api/data')).status,401);assert.equal((await admin.request('/api/data')).body.bases.length,1);
 }finally{await s.close();}
});

test('旧数据事务迁移保留顺序与关联，重启不重复导入，失败保留原文件',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-migration-'));
 try{
  const legacy={bases:[{id:'b1',title:'第一条',content:'正文'},{id:'b2',title:'第二条',content:'正文'}],plans:[{id:'p1',title:'计划一',basisIds:['b2','b1'],goal:'旧内容'},{id:'p2',title:'计划二',basisIds:[],goal:'另一条'}]};
  await writeFile(path.join(dir,'workbench.json'),JSON.stringify(legacy));
  let store=await openStore(dir);assert.deepEqual(store.readData().plans.map(p=>p.id),['p1','p2']);assert.deepEqual(store.readData().bases.map(p=>p.id),['b1','b2']);assert.deepEqual(store.readData().plans[0].basisIds,['b2','b1']);
  assert.equal(await readFile(path.join(dir,'workbench.json.migrated.bak'),'utf8'),JSON.stringify(legacy));store.deleteRecord('plans','p2');store.sql.close();
  store=await openStore(dir);assert.equal(store.readData().plans.length,1);store.sql.close();
  const badDir=path.join(dir,'broken');await import('node:fs/promises').then(fs=>fs.mkdir(badDir));
  const invalid={bases:[{id:'same'},{id:'same'}],plans:[]};const text=JSON.stringify(invalid);await writeFile(path.join(badDir,'workbench.json'),text);
  await assert.rejects(openStore(badDir));assert.equal(await readFile(path.join(badDir,'workbench.json'),'utf8'),text);
  const sql=new DatabaseSync(path.join(badDir,'workbench.sqlite'));assert.equal(sql.prepare('SELECT count(*) AS n FROM bases').get().n,0);assert.equal(sql.prepare('SELECT count(*) AS n FROM users').get().n,0);sql.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('HTTPS 代理入口接受可信来源，登录与退出 Cookie 带 Secure，拒绝伪造转发来源',async()=>{
 const origin='https://workbench.example.test';
 const s=await service({APP_ORIGIN:origin});try{
  const c=s.client(),credentials={username:'admin',password:'admin'};
  const login=await c.request('/api/auth/login','POST',credentials,{Origin:origin,Host:'127.0.0.1'});
  assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/; Secure/);
  assert.equal((await c.request('/api/auth/me','GET',undefined,{Origin:origin})).status,200);
  const created=await c.request('/api/bases','POST',{title:'HTTPS 计划依据',category:'其他',content:'验收正文'},{Origin:origin});assert.equal(created.status,201);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=','base64');
  const uploaded=await fetch(s.url()+'/api/uploads',{method:'POST',headers:{Cookie:c.cookie,Origin:origin,'Content-Type':'image/png'},body:png});
  assert.equal(uploaded.status,201);const {location}=await uploaded.json();assert.equal((await c.request(location,'GET',undefined,{Origin:origin})).status,200);
  for(const other of ['http://workbench.example.test','https://other.example.test','null']){
   assert.equal((await c.request('/api/auth/login','POST',credentials,{Origin:other,'X-Forwarded-Proto':'https','X-Forwarded-Host':'other.example.test'})).status,403);
  }
  assert.equal((await c.request('/api/auth/logout','POST',undefined,{Origin:origin,'Sec-Fetch-Site':'cross-site'})).status,403);
  const logout=await c.request('/api/auth/logout','POST',undefined,{Origin:origin});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);assert.match(logout.headers.get('set-cookie'),/; Secure/);
  assert.equal((await c.request('/api/data')).status,401);
 }finally{await s.close();}
 const local=await service();try{
  const c=local.client();const login=await c.request('/api/auth/login','POST',{username:'admin',password:'admin'},{'X-Forwarded-Proto':'https'});
  assert.equal(login.status,200);assert.doesNotMatch(login.headers.get('set-cookie'),/; Secure/);
 }finally{await local.close();}
});


test('错误的公网来源配置在初始化数据库前停止启动',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-origin-'));
 try{
  const withUser=new URL('https://example.test');withUser.username='fixture';
  const invalid=['file:///tmp/workbench','https://example.test/path','https://example.test/?query=value','https://example.test/#fragment',withUser.href,'not-an-origin'];
  for(let index=0;index<invalid.length;index++){
   const dataDir=path.join(dir,String(index));
   const result=spawnSync(process.execPath,['server.js'],{env:{...process.env,APP_ORIGIN:invalid[index],PORT:'0',DATA_DIR:dataDir},encoding:'utf8',timeout:5000});
   assert.equal(result.status,1);assert.match(result.stderr,/APP_ORIGIN 必须/);
   await assert.rejects(readFile(path.join(dataDir,'workbench.sqlite')),error=>error.code==='ENOENT');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('多层组织维护、循环与删除保护、跨层多机构归属必填及权限',async()=>{
 const s=await service();try{
  const admin=s.client(),member=s.client(),guest=s.client();
  assert.equal((await guest.request('/api/organizations')).status,401);
  await admin.request('/api/auth/login','POST',{username:'admin',password:'admin'});
  const create=async(name,parentId=null)=>{const response=await admin.request('/api/organizations','POST',{name,parentId});assert.equal(response.status,201);return response.body;};
  const root=await create('总部'),child=await create('运营部',root.id),leaf=await create('一组',child.id),other=await create('另一总部');
  for(const data of [{name:''},{name:'x'.repeat(101)},{name:[]},{name:'不存在上级',parentId:'missing'},{name:'错误上级',parentId:7}])assert.equal((await admin.request('/api/organizations','POST',data)).status,400);
  assert.equal((await admin.request('/api/organizations','POST',{name:'运营部',parentId:root.id})).status,409);
  const sameName=await create('运营部',other.id);
  assert.equal((await admin.request('/api/organizations/'+root.id,'PUT',{name:'总部',parentId:leaf.id})).status,400);
  assert.equal((await admin.request('/api/organizations/'+root.id,'PUT',{name:'总部',parentId:root.id})).status,400);
  assert.equal((await admin.request('/api/organizations/'+root.id,'DELETE')).status,409);
  const input={username:'organization.member',password:'fixture-password',displayName:'多机构成员',role:'user',enabled:true,organizationIds:[root.id,leaf.id,other.id,leaf.id]};
  for(const organizationIds of [undefined,[],null,'wrong',[7],[''],['missing']])assert.equal((await admin.request('/api/users','POST',{...input,organizationIds})).status,400);
  const created=await admin.request('/api/users','POST',input);assert.equal(created.status,201);const id=created.body.id;
  assert.deepEqual(new Set(created.body.organizationIds),new Set([root.id,leaf.id,other.id]));
  await member.request('/api/auth/login','POST',{username:input.username,password:input.password});
  for(const [route,method,data] of [['/api/organizations','GET'],['/api/organizations','POST',{name:'禁止'}],['/api/organizations/'+root.id,'PUT',{name:'禁止'}],['/api/organizations/'+leaf.id,'DELETE']])assert.equal((await member.request(route,method,data)).status,403);
  assert.equal((await admin.request('/api/organizations/'+leaf.id,'DELETE')).status,409);
  for(const organizationIds of [undefined,[],['missing']])assert.equal((await admin.request('/api/users/'+id,'PUT',{...input,password:'',organizationIds})).status,400);
  assert.deepEqual(new Set((await member.request('/api/auth/me')).body.organizationIds),new Set([root.id,leaf.id,other.id]));
  const updated=await admin.request('/api/users/'+id,'PUT',{...input,password:'',organizationIds:[child.id,leaf.id]});assert.equal(updated.status,200);
  assert.deepEqual(new Set(updated.body.organizationIds),new Set([child.id,leaf.id]));
  assert.equal((await admin.request('/api/organizations/'+child.id,'PUT',{name:'运营中心',parentId:other.id})).status,200);
  await s.stop();await s.start();
  assert.deepEqual(new Set((await member.request('/api/auth/me')).body.organizationIds),new Set([child.id,leaf.id]));
  const list=(await admin.request('/api/organizations')).body;
  assert.equal(list.find(o=>o.id===child.id).parentId,other.id);assert.equal(list.find(o=>o.id===child.id).name,'运营中心');
  await admin.request('/api/users/'+id,'DELETE');
  assert.equal((await admin.request('/api/organizations/'+leaf.id,'DELETE')).status,200);
  assert.equal((await admin.request('/api/organizations/'+child.id,'DELETE')).status,200);
  assert.equal((await admin.request('/api/organizations/'+sameName.id,'DELETE')).status,200);
  assert.equal((await admin.request('/api/organizations/'+other.id,'DELETE')).status,200);
  assert.equal((await admin.request('/api/organizations/'+root.id,'DELETE')).status,200);
  assert.equal((await admin.request('/api/organizations/missing','PUT',{name:'不存在'})).status,404);
 }finally{await s.close();}
});

test('旧 SQLite 用户和会话自动保留并分配默认机构，重启不覆盖多机构归属',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-organization-migration-'));
 try{
  const sql=new DatabaseSync(path.join(dir,'workbench.sqlite'));
  sql.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('initialized','1');
    CREATE TABLE users (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,displayName TEXT NOT NULL,passwordHash TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,createdAt TEXT NOT NULL);
    CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expiresAt INTEGER NOT NULL);`);
  sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('legacy-user','legacy.fixture','旧用户','fixture-hash','admin',1,'2026-01-01');
  sql.prepare('INSERT INTO sessions VALUES (?,?,?)').run('fixture-session-hash','legacy-user',Date.now()+100000);sql.close();
  let store=await openStore(dir);
  const user=store.sql.prepare('SELECT * FROM users').get();assert.equal(user.passwordHash,'fixture-hash');assert.equal(user.createdAt,'2026-01-01');
  assert.deepEqual(store.userView(user).organizationIds,['default-organization']);
  assert.equal(store.sql.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
  store.sql.prepare('INSERT INTO organizations VALUES (?,?,?,?)').run('custom','新机构',null,'2026-01-01');
  store.sql.prepare('UPDATE user_organizations SET organizationId=?').run('custom');
  store.sql.prepare('DELETE FROM organizations WHERE id=?').run('default-organization');store.sql.close();
  store=await openStore(dir);assert.deepEqual(store.userView(user).organizationIds,['custom']);assert.equal(store.sql.prepare('SELECT count(*) AS n FROM organizations').get().n,1);store.sql.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('计划数据权限：平级隔离、下级及多机构并集、树筛选、越权读写、图片和依据详情',async()=>{
 const s=await service();try{
  const admin=s.client();await admin.request('/api/auth/login','POST',{username:'admin',password:'admin'});
  const org=async(name,parentId=null)=>(await admin.request('/api/organizations','POST',{name,parentId})).body;
  const root=await org('总部'),a=await org('运营',root.id),a1=await org('运营一组',a.id),a2=await org('运营二组',a.id),b=await org('研发',root.id),b1=await org('研发一组',b.id),outside=await org('外部');
  const create=async(name,organizationIds)=>{
   const input={username:name,password:'fixture-only',displayName:name,organizationIds,role:'user',enabled:true};
   const response=await admin.request('/api/users','POST',input);assert.equal(response.status,201);
   const client=s.client();await client.request('/api/auth/login','POST',{username:name,password:input.password});return {...response.body,client,input};
  };
  const leader=await create('leader',[a.id,a1.id,b.id]),peer=await create('peer',[a.id]),worker=await create('worker',[a1.id]),workerPeer=await create('worker.peer',[a1.id]),lower=await create('lower',[a2.id]),research=await create('research',[b1.id]),outsider=await create('outsider',[outside.id]);
  const basis=(await admin.request('/api/bases','POST',{title:'共同依据',category:'其他',content:'共享依据正文'})).body;
  const planInput={title:'权限测试',goal:'目标',tasks:'行动',start:'2026-11-01',due:'2026-11-02',priority:'中',status:'进行中',progress:10,basisIds:[basis.id]};
  const save=async(owner,client=owner.client)=>{
   const response=await client.request('/api/plans','POST',{...planInput,title:owner.displayName+' 的计划',ownerUserId:owner.id,organizationId:owner.organizationIds[0],owner:'伪造负责人',department:'伪造机构'});
   assert.equal(response.status,201);assert.equal(response.body.owner,owner.displayName);return response.body;
  };
  const people=[leader,peer,worker,workerPeer,lower,research,outsider],plans=[];
  for(const person of people)plans.push(await save(person));
  const ids=async client=>(await client.request('/api/data')).body.plans.map(p=>p.ownerUserId).sort();
  assert.deepEqual(await ids(worker.client),[worker.id]);assert.deepEqual(await ids(workerPeer.client),[workerPeer.id]);assert.deepEqual(await ids(peer.client),[peer.id,leader.id,worker.id,workerPeer.id,lower.id].sort());
  assert.deepEqual(await ids(leader.client),[leader.id,worker.id,workerPeer.id,lower.id,research.id].sort());
  assert.equal((await admin.request('/api/data')).body.plans.length,7);
  const forbidden=plans[1];
  for(const [route,method,data] of [['/api/plans/'+forbidden.id,'GET'],['/api/plans/'+forbidden.id,'PUT',{...forbidden,title:'越权改动'}],['/api/plans/'+forbidden.id,'DELETE']]){
   const response=await leader.client.request(route,method,data);assert.equal(response.status,403);assert.ok(!JSON.stringify(response.body).includes(forbidden.title));
  }
  assert.equal((await worker.client.request('/api/plans','POST',{...planInput,ownerUserId:workerPeer.id,organizationId:a1.id})).status,403);
  assert.equal((await leader.client.request('/api/plans','POST',{...planInput,ownerUserId:peer.id,organizationId:a.id})).status,403);
  assert.equal((await worker.client.request('/api/plans','POST',{...planInput,organizationId:a.id})).status,400);
  assert.equal((await worker.client.request('/api/plans','POST',{...planInput,organizationId:a1.id})).body.ownerUserId,worker.id);
  const delegated=await save(worker,leader.client);assert.equal((await leader.client.request('/api/plans/'+delegated.id,'PUT',{...delegated,title:'上级修改'})).status,200);
  assert.equal((await leader.client.request('/api/plans/'+delegated.id,'DELETE')).status,200);
  const scope=(await worker.client.request('/api/plan-scope')).body;
  assert.deepEqual(scope.people.map(u=>u.id),[worker.id]);assert.deepEqual(new Set(scope.organizations.map(o=>o.id)),new Set([root.id,a.id,a1.id]));
  assert.ok(scope.people.every(u=>!('username' in u)&&!('passwordHash' in u)));
  const leaderScope=(await leader.client.request('/api/plan-scope')).body;
  assert.ok(!leaderScope.people.some(u=>u.id===peer.id||u.id===outsider.id));assert.ok(!leaderScope.organizations.some(o=>o.id===outside.id));
  assert.equal((await admin.request('/api/plan-scope')).body.people.length,8);
  const all=(await leader.client.request('/api/data')).body.plans;
  for(const selection of [{type:'organization',id:a.id},{type:'organization',id:a1.id},{type:'person',id:worker.id}]){
   const query=selection.type==='person'?'ownerUserId':'organizationId';
   const filtered=(await leader.client.request('/api/data?'+query+'='+selection.id)).body.plans;
   assert.deepEqual(filtered.map(p=>p.id),all.filter(p=>matchesTree(p,selection,leaderScope.organizations)).map(p=>p.id));
  }
  assert.equal((await leader.client.request('/api/data?ownerUserId='+peer.id)).body.plans.length,0);
  const detail=(await worker.client.request('/api/bases/'+basis.id)).body;assert.ok(detail.plans.length);assert.ok(detail.plans.every(p=>p.ownerUserId===worker.id));assert.ok(!JSON.stringify(detail).includes(forbidden.title));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=','base64');
  const uploaded=await fetch(s.url()+'/api/uploads',{method:'POST',headers:{Cookie:worker.client.cookie,'Content-Type':'image/png'},body:png});const {location}=await uploaded.json();
  assert.equal((await outsider.client.request(location)).status,403);
  const illustrated=await worker.client.request('/api/plans','POST',{...planInput,organizationId:a1.id,goal:`<p>私有图片</p><img src="${location}">`});assert.equal(illustrated.status,201);
  assert.equal((await leader.client.request(location)).status,200);assert.equal((await workerPeer.client.request(location)).status,403);
  assert.equal((await workerPeer.client.request('/api/plans','POST',{...planInput,organizationId:a1.id,goal:`<p>盗用图片</p><img src="${location}">`})).status,403);
  await s.stop();await s.start();assert.equal((await workerPeer.client.request(location)).status,403);assert.equal((await leader.client.request('/api/plans/'+illustrated.body.id)).status,200);
  // 组织变化立即改变权限，不依赖重新登录或客户端树。
  await admin.request('/api/users/'+leader.id,'PUT',{...leader.input,password:'',organizationIds:[outside.id]});
  assert.equal((await leader.client.request('/api/plans/'+illustrated.body.id)).status,403);assert.equal((await leader.client.request(location)).status,403);
  assert.equal((await admin.request('/api/plans/'+illustrated.body.id,'DELETE')).status,200);
  assert.equal((await admin.request('/api/plans','POST',{...planInput,ownerUserId:worker.id,organizationId:outside.id})).status,400);
  await admin.request('/api/users/'+outsider.id,'DELETE');
  const orphan=plans.find(p=>p.ownerUserId===outsider.id);
  assert.equal((await worker.client.request('/api/plans/'+orphan.id)).status,403);
  assert.equal((await admin.request('/api/plans/'+orphan.id)).body.ownerUserId,null);
  assert.equal((await admin.request('/api/plans/'+orphan.id,'PUT',{...orphan,ownerUserId:worker.id,organizationId:a1.id})).status,200);
  assert.equal((await worker.client.request('/api/plans/'+orphan.id)).status,200);

 }finally{await s.close();}
});

test('计划归属升级备份、唯一匹配与未归属、事务回滚和重复启动不覆盖',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-owner-migration-'));
 try{
  let store=await openStore(dir);const admin=store.sql.prepare('SELECT * FROM users').get();
  const plan=(id,owner,ownerUserId=null)=>({id,title:id,owner,department:'默认机构',ownerUserId,organizationId:null,goal:'保留正文',tasks:'',start:'',due:'',priority:'中',status:'草稿',progress:0,basisIds:[],createdAt:'旧时间',updatedAt:'旧时间'});
  store.writeRecord('plans',plan('unique','管理员'),true);store.writeRecord('plans',plan('ambiguous','同名'),true);store.writeRecord('plans',plan('unmatched','无人匹配'),true);store.writeRecord('plans',plan('bound','无人匹配',admin.id),true);
  for(const id of ['one','two'])store.sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,id,'同名','fixture-hash','user',1,'旧时间');
  store.sql.prepare("DELETE FROM metadata WHERE key='planOwnershipInitialized'").run();
  store.sql.exec('ALTER TABLE plans DROP COLUMN organizationId');store.sql.exec('ALTER TABLE plans DROP COLUMN ownerUserId');
  store.sql.exec("CREATE TRIGGER fail_owner BEFORE UPDATE OF ownerUserId ON plans WHEN new.id='unique' BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");
  store.sql.close();
  await mkdir(path.join(dir,'uploads'));await writeFile(path.join(dir,'uploads','fixture.txt'),'本地图片占位');await mkdir(path.join(dir,'backups','historic'),{recursive:true});await writeFile(path.join(dir,'backups','historic','old.txt'),'历史备份');
  await assert.rejects(openStore(dir),/fixture migration failure/);
  const sql=new DatabaseSync(path.join(dir,'workbench.sqlite'));assert.ok(!sql.prepare('PRAGMA table_info(plans)').all().some(c=>c.name==='ownerUserId'));assert.equal(sql.prepare("SELECT 1 FROM metadata WHERE key='planOwnershipInitialized'").get(),undefined);sql.exec('DROP TRIGGER fail_owner');sql.close();
  store=await openStore(dir);let data=store.readData().plans;
  assert.equal(data.find(p=>p.id==='unique').ownerUserId,admin.id);assert.equal(data.find(p=>p.id==='unique').organizationId,'default-organization');
  assert.equal(data.find(p=>p.id==='ambiguous').ownerUserId,null);assert.equal(data.find(p=>p.id==='unmatched').ownerUserId,null);assert.equal(data.find(p=>p.id==='bound').ownerUserId,null);store.sql.prepare("UPDATE plans SET ownerUserId=? WHERE id='bound'").run(admin.id);assert.ok(data.every(p=>p.goal==='保留正文'&&p.updatedAt==='旧时间'));
  const backups=(await readdir(path.join(dir,'backups'))).filter(n=>n.startsWith('计划权限升级前_'));assert.equal(backups.length,2);
  const snapshot=path.join(dir,'backups',backups[0]);assert.equal(await readFile(path.join(snapshot,'uploads','fixture.txt'),'utf8'),'本地图片占位');assert.ok(!(await readdir(snapshot)).includes('backups'));
  const saved=new DatabaseSync(path.join(snapshot,'workbench.sqlite'),{readOnly:true});assert.ok(!saved.prepare('PRAGMA table_info(plans)').all().some(c=>c.name==='ownerUserId'));saved.close();
  store.sql.prepare("UPDATE users SET displayName='改名' WHERE id=?").run(admin.id);store.sql.close();store=await openStore(dir);assert.equal(store.readData().plans.find(p=>p.id==='unique').ownerUserId,admin.id);assert.equal(store.readData().plans.find(p=>p.id==='bound').ownerUserId,admin.id);assert.equal((await readdir(path.join(dir,'backups'))).filter(n=>n.startsWith('计划权限升级前_')).length,2);store.sql.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('已绑定计划不被迁移重配，备份失败时不进行归属升级',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-bound-migration-'));
 try{
  let store=await openStore(dir);const user=store.sql.prepare('SELECT id FROM users').get();
  store.writeRecord('plans',{id:'bound',title:'保留',owner:'不存在的姓名',department:'历史部门',ownerUserId:user.id,organizationId:'default-organization',basisIds:[]},true);
  store.sql.prepare("DELETE FROM metadata WHERE key='planOwnershipInitialized'").run();store.sql.close();
  await writeFile(path.join(dir,'backups'),'阻止创建备份目录');await assert.rejects(openStore(dir));
  let sql=new DatabaseSync(path.join(dir,'workbench.sqlite'),{readOnly:true});assert.equal(sql.prepare("SELECT 1 FROM metadata WHERE key='planOwnershipInitialized'").get(),undefined);assert.equal(sql.prepare('SELECT ownerUserId FROM plans').get().ownerUserId,user.id);sql.close();
  await rm(path.join(dir,'backups'));store=await openStore(dir);const plan=store.readData().plans[0];assert.equal(plan.ownerUserId,user.id);assert.equal(plan.owner,'不存在的姓名');assert.equal(plan.department,'历史部门');assert.equal(plan.organizationId,'default-organization');store.sql.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
