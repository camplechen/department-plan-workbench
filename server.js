import http from 'node:http';
import {sanitizeHTML,hasText} from './public/rich-text.js';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const dir=process.env.DATA_DIR||path.join(root,'data');
await mkdir(dir,{recursive:true});
const file=path.join(dir,'workbench.json');
const uploadDir=path.join(dir,'uploads');
let db;
try {db=JSON.parse(await readFile(file,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;db={plans:[],bases:[]};await writeFile(file,JSON.stringify(db,null,2));}
let queue=Promise.resolve();
const save=async next=>{await writeFile(file+'.tmp',JSON.stringify(next,null,2));await rename(file+'.tmp',file);db=next;};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function validate(type,b){
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
 const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 try {
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
 if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw fail('不允许跨来源操作',403);
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
 const name=randomUUID()+'.'+extensions[type];await mkdir(uploadDir,{recursive:true});await writeFile(path.join(uploadDir,name),image,{flag:'wx'});
 return send(201,{location:'/uploads/'+name});
 }
 const m=url.pathname.match(/^\/api\/(plans|bases)(?:\/([\w-]+))?$/);if(!m)throw fail('接口不存在',404);
 if(!['POST','PUT','DELETE'].includes(req.method))throw fail('请求方式不支持',405);
 let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1200000)throw fail('提交内容过大',413);}
 let input={};if(body){try{input=JSON.parse(body);}catch{throw fail('提交内容格式不正确');}}
 const operation=queue.then(async()=>{
 const [,type,id]=m;const next=structuredClone(db);const index=next[type].findIndex(x=>x.id===id);
 if(req.method!=='POST'&&index<0)throw fail('记录不存在',404);
 if(req.method==='DELETE'){
 if(type==='bases'&&db.plans.some(p=>p.basisIds.includes(id)))throw fail('该依据仍被计划引用，请先在关联计划中移除关联',409);
 next[type].splice(index,1);await save(next);return {message:'已删除'};
 }
 const value=validate(type,input);const now=new Date().toISOString();const record={...value,id:req.method==='POST'?randomUUID():id,createdAt:req.method==='POST'?now:next[type][index].createdAt,updatedAt:now};
 if(req.method==='POST')next[type].unshift(record);else next[type][index]=record;
 await save(next);return record;
 });queue=operation.catch(()=>{});return send(req.method==='POST'?201:200,await operation);
 }
 if(req.method!=='GET')throw fail('请求方式不支持',405);
 const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/editor-content.css':'editor-content.css','/rich-text.js':'rich-text.js','/rich-editor.js':'rich-editor.js'};
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
server.listen(Number(process.env.PORT)||3210,'127.0.0.1',()=>console.log(`部门工作台已启动：http://127.0.0.1:${server.address().port}`));
