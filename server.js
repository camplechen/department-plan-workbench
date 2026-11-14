import http from 'node:http';
import {sanitizeHTML,hasText} from './public/rich-text.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {openStore,fail,publicUser,hashPassword,verifyPassword,sessionSeconds} from './src/database.js';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=process.env.DATA_DIR||path.join(root,'data');
const uploadDir=path.join(dir,'uploads');
// 公网入口由服务器配置指定，不信任客户端可伪造的转发头。
let appOrigin=null;
if(process.env.APP_ORIGIN){
 try{
  const entry=new URL(process.env.APP_ORIGIN);
  if(!['http:','https:'].includes(entry.protocol)||entry.username||entry.password||entry.pathname!=='/'||entry.search||entry.hash)throw Error();
  appOrigin=entry.origin;
 }catch{throw Error('APP_ORIGIN 必须是完整的 HTTP/HTTPS 来源地址，不能含账号、密码、路径、查询参数或片段');}
}
const store=await openStore(dir);
function validate(type,b,db){
 if(!b || typeof b!=='object' || Array.isArray(b))throw fail('提交内容格式不正确');
 const fields=type==='plans'?['title','department','owner','start','due','goal','tasks','priority','status','progress','basisIds']:['title','category','source','date','content'];
 const v=Object.fromEntries(fields.filter(k=>b[k]!==undefined).map(k=>[k,b[k]]));
 const required=type==='plans'?['title','department','owner','start','due','goal']:['title','category','content'];
 for(const k of fields)if(k!=='basisIds'&&k!=='progress'&&v[k]!==undefined&&(typeof v[k]!=='string'||v[k].length>(['goal','tasks'].includes(k)?500000:10000)))throw fail('字段格式不正确或内容过长');
 for(const k of required)if(!v[k]?.trim())throw fail('请完整填写必填项');
 if(type==='plans'){
 v.goal=sanitizeHTML(v.goal);v.tasks=sanitizeHTML(v.tasks);
 if(!hasText(v.goal))throw fail('请填写目标与验收标准');
 if(!['草稿','进行中','已完成','已暂停'].includes(v.status)||!['高','中','低'].includes(v.priority))throw fail('请选择有效的状态与优先级');
 if(!Number.isInteger(v.progress)||v.progress<0||v.progress>100)throw fail('进度必须为 0 至 100 的整数');
 if(!Array.isArray(v.basisIds)||v.basisIds.some(id=>!db.bases.some(x=>x.id===id)))throw fail('关联依据不存在');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(v.start)||!/^\d{4}-\d{2}-\d{2}$/.test(v.due)||!Number.isFinite(Date.parse(v.start))||!Number.isFinite(Date.parse(v.due))||v.start>v.due)throw fail('请检查开始与截止日期');
 v.basisIds=[...new Set(v.basisIds)];if(v.status==='已完成')v.progress=100;
 } else if(!['战略目标','经营数据','上级要求','问题改进','其他'].includes(v.category))throw fail('依据分类无效');
 return v;
}
const server=http.createServer(async(req,res)=>{
 const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 try {
 const url=new URL(req.url,'http://localhost');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 const sessionToken=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('workbench_session='))?.slice(18);
 const user=store.session(sessionToken);
 const requireUser=()=>{if(!store.session(sessionToken))throw fail('请先登录',401);};
 const requireAdmin=()=>{requireUser();if(store.session(sessionToken)?.role!=='admin')throw fail('仅管理员可管理用户',403);};
 const cookie=(token,age=sessionSeconds)=>`workbench_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${appOrigin?.startsWith('https://')?'; Secure':''}`;
 const inputJSON=async()=>{
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1200000)throw fail('提交内容过大',413);}
   try {const input=JSON.parse(body||'{}');if(!input||typeof input!=='object'||Array.isArray(input))throw Error();return input;}
   catch {throw fail('提交内容格式不正确');}
 };
 const checkOrigin=()=>{
   if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==(appOrigin||`http://${req.headers.host}`)))throw fail('不允许跨来源操作',403);
 };
 if(url.pathname==='/'&&!user){res.writeHead(302,{Location:'/login'});return res.end();}
 if(url.pathname==='/login'&&user){res.writeHead(302,{Location:'/'});return res.end();}
 if(url.pathname.startsWith('/uploads/'))requireUser();
 if(url.pathname.startsWith('/api/')){
 checkOrigin();
 if(url.pathname==='/api/auth/login'&&req.method==='POST') {
   const input=await inputJSON();
   if(typeof input.username!=='string'||typeof input.password!=='string'||input.username.length>40||input.password.length>128)throw fail('账号或密码不正确',401);
   const loginName=input.username.trim().toLowerCase();
   store.sql.prepare('DELETE FROM login_attempts WHERE expiresAt<=?').run(Date.now());
   const attempt=store.sql.prepare('SELECT * FROM login_attempts WHERE username=?').get(loginName);
   if(attempt?.attempts>=10)throw fail('尝试次数过多，请 15 分钟后重试',429);
   const account=store.sql.prepare('SELECT * FROM users WHERE username=?').get(loginName);
   if(!account||!account.enabled||!await verifyPassword(input.password,account.passwordHash)){
     store.sql.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(username) DO UPDATE SET attempts=attempts+1').run(loginName,Date.now()+15*60*1000);
     throw fail('账号或密码不正确',401);
   }
   // 异步密码校验期间账号可能被禁用或重置，必须再次确认。
   const current=store.sql.prepare('SELECT * FROM users WHERE id=? AND enabled=1').get(account.id);
   if(!current||current.passwordHash!==account.passwordHash)throw fail('账号或密码不正确',401);
   store.sql.prepare('DELETE FROM login_attempts WHERE username=?').run(loginName);
   store.revoke(sessionToken);
   res.setHeader('Set-Cookie',cookie(store.createSession(account.id)));
   return send(200,publicUser(current));
 }
 if(url.pathname==='/api/auth/logout'&&req.method==='POST') {
   store.revoke(sessionToken);res.setHeader('Set-Cookie',cookie('',0));return send(200,{message:'已退出登录'});
 }
 requireUser();
 if(url.pathname==='/api/auth/me'&&req.method==='GET')return send(200,publicUser(user));
 const userRoute=url.pathname.match(/^\/api\/users(?:\/([\w-]+))?$/);
 if(userRoute){
   requireAdmin();const id=userRoute[1];
   if(req.method==='GET'&&!id)return send(200,store.sql.prepare('SELECT * FROM users ORDER BY createdAt,id').all().map(publicUser));
   if(!['POST','PUT','DELETE'].includes(req.method)||(req.method==='POST'&&id)||(req.method!=='POST'&&!id))throw fail('请求方式不支持',405);
   const target=id?store.sql.prepare('SELECT * FROM users WHERE id=?').get(id):null;
   if(id&&!target)throw fail('用户不存在',404);
   if(req.method==='DELETE') {
     if(id===user.id)throw fail('不能删除当前登录用户');
     if(target.role==='admin'&&target.enabled&&store.sql.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND enabled=1").get().n<=1)throw fail('必须保留一位启用的管理员');
     store.sql.prepare('DELETE FROM users WHERE id=?').run(id);return send(200,{message:'已删除用户'});
   }
   const input=await inputJSON();
   const rawUsername=input.username??target?.username;
   const username=typeof rawUsername==='string'?rawUsername.trim():rawUsername;
   if(typeof username!=='string'||!/^[-a-zA-Z0-9_.]{3,40}$/.test(username))throw fail('账号须为 3 至 40 位字母、数字、点、下划线或连字符');
   if(target&&username!==target.username)throw fail('账号创建后不可修改');
   if(input.displayName!==undefined&&typeof input.displayName!=='string')throw fail('显示名称格式不正确');
   const displayName=input.displayName?.trim()||username, role=input.role??target?.role??'user', enabled=input.enabled??(target?!!target.enabled:true);
   if(typeof displayName!=='string'||displayName.length>100||!['admin','user'].includes(role)||typeof enabled!=='boolean')throw fail('用户信息格式不正确');
   const changePassword=input.password!==undefined&&input.password!=='';
   if((!target||changePassword)&&(typeof input.password!=='string'||input.password.length<4||input.password.length>128))throw fail('密码长度须为 4 至 128 个字符');
   const passwordHash=(!target||changePassword)?await hashPassword(input.password):target.passwordHash;
   const record={id:target?.id||randomUUID(),username,displayName,role,enabled:enabled?1:0,passwordHash,createdAt:target?.createdAt||new Date().toISOString()};
   store.transaction(()=>{
     const caller=store.session(sessionToken);if(!caller||caller.role!=='admin')throw fail('管理员登录已失效',401);
     if(target){
       if(id===user.id&&(!enabled||role!=='admin'))throw fail('不能停用当前管理员或取消自身管理员权限');
       const fresh=store.sql.prepare('SELECT * FROM users WHERE id=?').get(id);if(!fresh)throw fail('用户不存在',404);
       if(fresh.role==='admin'&&fresh.enabled&&(!enabled||role!=='admin')&&store.sql.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND enabled=1").get().n<=1)throw fail('必须保留一位启用的管理员');
       store.sql.prepare('UPDATE users SET displayName=?,role=?,enabled=?,passwordHash=? WHERE id=?').run(displayName,role,record.enabled,changePassword?passwordHash:fresh.passwordHash,id);
       if(changePassword||!enabled||role!==fresh.role)store.sql.prepare('DELETE FROM sessions WHERE userId=?').run(id);
     }else {
       if(store.sql.prepare('SELECT 1 FROM users WHERE username=?').get(username))throw fail('该账号已存在',409);
       store.sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(record.id,username,displayName,passwordHash,role,record.enabled,record.createdAt);
     }
   });
   return send(target?200:201,publicUser(record));
 }

 const db=store.readData();
 if(req.method==='GET'&&url.pathname==='/api/data')return send(200,{...db,plans:db.plans.map(p=>({...p,goal:sanitizeHTML(p.goal),tasks:sanitizeHTML(p.tasks)}))});
 if(url.pathname==='/api/uploads'){
 if(req.method!=='POST')throw fail('请求方式不支持',405);
 const type=(req.headers['content-type']||'').split(';')[0].trim();
 const extensions={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
 if(!extensions[type])throw fail('仅支持 PNG、JPG、JPEG、GIF、WebP 图片',415);
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>10*1024*1024)throw fail('单张图片不能超过 10MB',413);chunks.push(chunk);}
 const image=Buffer.concat(chunks);
 const valid=type==='image/png'?image.length>=24&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&image.toString('ascii',12,16)==='IHDR':type==='image/jpeg'?image.length>=4&&image[0]===255&&image[1]===216&&image[2]===255:type==='image/gif'?image.length>=13&&/^GIF8[79]a$/.test(image.toString('ascii',0,6)):image.length>=16&&image.toString('ascii',0,4)==='RIFF'&&image.toString('ascii',8,12)==='WEBP';
 if(!valid)throw fail('图片文件内容与类型不符',415);
 requireUser();const name=randomUUID()+'.'+extensions[type];await mkdir(uploadDir,{recursive:true});await writeFile(path.join(uploadDir,name),image,{flag:'wx'});
 return send(201,{location:'/uploads/'+name});
 }
 const m=url.pathname.match(/^\/api\/(plans|bases)(?:\/([\w-]+))?$/);if(!m)throw fail('接口不存在',404);
 if(!['POST','PUT','DELETE'].includes(req.method))throw fail('请求方式不支持',405);
 const input=await inputJSON();requireUser();
 const [,type,id]=m;const snapshot=store.readData();const existing=snapshot[type].find(x=>x.id===id);
 if(req.method!=='POST'&&!existing)throw fail('记录不存在',404);
 if(req.method==='DELETE'){
   if(type==='bases'&&snapshot.plans.some(p=>p.basisIds.includes(id)))throw fail('该依据仍被计划引用，请先在关联计划中移除关联',409);
   store.deleteRecord(type,id);return send(200,{message:'已删除'});
 }
 const value=validate(type,input,snapshot);const now=new Date().toISOString();
 const record={...value,id:req.method==='POST'?randomUUID():id,createdAt:req.method==='POST'?now:existing.createdAt,updatedAt:now};
 store.writeRecord(type,record,req.method==='POST');return send(req.method==='POST'?201:200,record);
 }
 if(req.method!=='GET')throw fail('请求方式不支持',405);
 const files={'/login':'login.html','/login.js':'login.js','/':'index.html','/app.js':'app.js','/style.css':'style.css','/editor-content.css':'editor-content.css','/rich-text.js':'rich-text.js','/rich-editor.js':'rich-editor.js'};
 let name=files[url.pathname],location;
 if(/^\/uploads\/[a-f0-9-]{36}\.(png|jpg|jpeg|gif|webp)$/.test(url.pathname)) {name=url.pathname.slice(9);location=path.join(uploadDir,name);}
 else if(/^\/vendor\/[a-zA-Z0-9_./-]+$/.test(url.pathname)&&!url.pathname.split('/').includes('..')){name=url.pathname.slice(1);location=path.join(root,'public',name);}
 else if(name)location=path.join(root,'public',name);
 if(!location)throw fail('页面不存在',404);
 let content;try{content=await readFile(location);}catch(e){if(e.code==='ENOENT'||e.code==='EISDIR')throw fail('文件不存在',404);throw e;}
 const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2'};
 res.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(content);
 }catch(e){send(e.status||500,{error:e.status?e.message:'保存或读取失败，请检查本地磁盘后重试'});}
});
server.listen(process.env.PORT===undefined?3210:Number(process.env.PORT),'127.0.0.1',()=>console.log(`部门工作台已启动：http://127.0.0.1:${server.address().port}`));

const shutdown=()=>server.close(()=>{store.sql.close();process.exit(0);});
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
