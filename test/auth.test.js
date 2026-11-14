import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
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
