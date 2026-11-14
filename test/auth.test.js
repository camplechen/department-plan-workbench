import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/database.js';

async function service(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'workbench-auth-'));let proc,base;
 const start=()=>new Promise((resolve,reject)=>{
  proc=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',DATA_DIR:dir}});let output='';
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
 await start();return {dir,start,stop,client,async close(){await stop();await rm(dir,{recursive:true,force:true});}};
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
  const input={username:'test.member',password:'fixture-password',displayName:'测试成员',role:'user',enabled:true};
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
