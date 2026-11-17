import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const updater=path.resolve('scripts/update-server.sh');
const git=(cwd,...args)=>{
 const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull}});
 assert.equal(r.status,0,'临时 Git 操作失败');return r.stdout.trim();
};
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'workbench-deploy-'));
 const project=path.join(root,'project'),remote=path.join(root,'remote'),bin=path.join(root,'bin'),data=path.join(root,'data'),home=path.join(root,'home');
 for(const d of [project,remote,bin,data,home])await mkdir(d);
 await writeFile(path.join(data,'workbench.sqlite'),'原始数据');await mkdir(path.join(data,'uploads'));await writeFile(path.join(data,'uploads','fixture.png'),'图片');await mkdir(path.join(data,'backups'));await writeFile(path.join(data,'backups','old.txt'),'历史备份');
 git(remote,'init','-b','main');git(remote,'config','user.name','测试维护者');git(remote,'config','user.email','fixture@example.invalid');
 await writeFile(path.join(remote,'server.js'),'旧版');await writeFile(path.join(remote,'package.json'),'{}');await mkdir(path.join(remote,'scripts'));await cp(updater,path.join(remote,'scripts/update-server.sh'));
 git(remote,'add','.');git(remote,'commit','-m','旧版');
 const previous=git(remote,'rev-parse','HEAD');
 // project 已存在空目录，clone 可以直接使用。
 git(root,'clone',remote,project);
 await writeFile(path.join(remote,'server.js'),'新版');git(remote,'add','.');git(remote,'commit','-m','新版');const target=git(remote,'rev-parse','HEAD');
 const state=path.join(root,'state'),calls=path.join(root,'calls');await writeFile(state,'active');await writeFile(calls,'');
 const shell=async(name,body)=>writeFile(path.join(bin,name),'#!/usr/bin/env bash\n'+body+'\n',{mode:0o755});
 await shell('uname','printf "Linux\\n"');await shell('id','if [[ "$1" == -u ]]; then printf "0\\n"; else exit 1; fi');
 await shell('chown','exit 0');await shell('flock','[[ "${FIXTURE_FAILURE:-}" != lock ]]');await shell('sleep','exit 0');await shell('timeout','shift; exec "$@"');
 await writeFile(path.join(bin,'sudo'),`#!${process.execPath}\nimport {spawnSync} from 'node:child_process';
let args=process.argv.slice(2);while(args[0]?.startsWith('-')){if(args.shift()==='-u')args.shift();}
const result=spawnSync(args[0],args.slice(1),{stdio:'inherit',env:{...process.env,HOME:process.env.FIXTURE_HOME}});process.exit(result.status??1);
`,{mode:0o755});
 await writeFile(path.join(bin,'systemctl'),`#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2),env=process.env;
if(args[0]==='show'){
 const key=args[args.indexOf('-p')+1];
 const values={User:'fixture-service',WorkingDirectory:env.FIXTURE_PROJECT,Environment:JSON.stringify('DATA_DIR='+env.FIXTURE_DATA)+' PORT=3210 APP_ORIGIN=https://example.test',EnvironmentFiles:''};
 console.log(values[key]??'');
}else if(args[0]==='is-active')process.exit(fs.readFileSync(env.FIXTURE_STATE,'utf8')==='active'?0:3);
else if(['stop','start'].includes(args[0])){
 fs.appendFileSync(env.FIXTURE_CALLS,args[0]+'\\n');fs.writeFileSync(env.FIXTURE_STATE,args[0]==='stop'?'inactive':'active');
 if(args[0]==='start'&&env.FIXTURE_FAILURE==='health')fs.writeFileSync(env.FIXTURE_DATA+'/workbench.sqlite','已迁移的数据');
}else process.exit(1);
`,{mode:0o755});
 await writeFile(path.join(bin,'npm'),`#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2),env=process.env;
if(env.DATA_DIR||env.APP_ORIGIN)process.exit(88);
fs.appendFileSync(env.FIXTURE_CALLS,'npm '+args.join(' ')+'\\n');
if(args.includes('test')&&env.FIXTURE_FAILURE==='test')process.exit(1);
if(args.includes('--offline')&&env.FIXTURE_FAILURE==='install')process.exit(1);
const index=args.indexOf('--cache');if(index>=0)fs.mkdirSync(args[index+1],{recursive:true});
`,{mode:0o755});
 await shell('curl','[[ "${FIXTURE_FAILURE:-}" != health ]] || exit 22\nwhile [[ "$#" -gt 0 ]]; do if [[ "$1" == -o ]]; then printf \'<form id="login-form"></form>\' > "$2"; break; fi; shift; done');
 // 使用真实 tar 归档数据，仅在备份失败场景中注入退出码。
 const tar=spawnSync('which',['tar'],{encoding:'utf8'}).stdout.trim();
 await shell('tar',`if [[ "\${FIXTURE_FAILURE:-}" == backup && "$*" == *data.tar* ]]; then exit 1; fi\nexec "${tar}" "$@"`);
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,WORKBENCH_PROJECT_DIR:project,WORKBENCH_BACKUP_DIR:path.join(root,'backup'),WORKBENCH_LOCK_FILE:path.join(root,'lock'),WORKBENCH_COMMAND_PATH:path.join(root,'update-command'),FIXTURE_PROJECT:project,FIXTURE_DATA:data,FIXTURE_HOME:home,FIXTURE_STATE:state,FIXTURE_CALLS:calls,DATA_DIR:data,APP_ORIGIN:'https://production.example.test'};
 const run=(args=[],failure='')=>spawnSync('bash',[updater,...args],{env:{...env,FIXTURE_FAILURE:failure},encoding:'utf8',timeout:15000});
 return {root,project,remote,data,state,calls,previous,target,env,run,async close(){await rm(root,{recursive:true,force:true});}};
}

test('服务器更新：真实 Git 快进、停服备份、离线安装及服务检查',async()=>{
 const f=await fixture();try{
  const result=f.run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/更新成功/);assert.equal(git(f.project,'rev-parse','HEAD'),f.target);
  const calls=(await readFile(f.calls,'utf8')).trim().split('\n');assert.ok(calls.findIndex(x=>x.includes(' test'))<calls.indexOf('stop'));assert.ok(calls.some(x=>x.includes('--offline')));assert.deepEqual(calls.filter(x=>['start','stop'].includes(x)),['stop','start']);
  const backups=await readdir(f.env.WORKBENCH_BACKUP_DIR);const backup=path.join(f.env.WORKBENCH_BACKUP_DIR,backups.find(x=>x.startsWith('update-')));
  assert.ok(await readFile(path.join(backup,'backup-complete.txt')));
  const restored=path.join(f.root,'restored');await mkdir(restored);const unpack=spawnSync('tar',['-xf',path.join(backup,'data.tar'),'-C',restored],{encoding:'utf8'});assert.equal(unpack.status,0);
  assert.equal(await readFile(path.join(restored,'workbench.sqlite'),'utf8'),'原始数据');assert.equal(await readFile(path.join(restored,'uploads','fixture.png'),'utf8'),'图片');await assert.rejects(readFile(path.join(restored,'backups','old.txt')));
  assert.equal(await readFile(path.join(f.data,'workbench.sqlite'),'utf8'),'原始数据');
  const again=f.run();assert.equal(again.status,0);assert.match(again.stdout,/已经是最新/);
 }finally{await f.close();}
});

test('服务器更新：脏工作区、网络、测试及并发失败均不停止原服务',async()=>{
 for(const scenario of ['dirty','network','test','lock']){
  const f=await fixture();try{
   if(scenario==='dirty')await writeFile(path.join(f.project,'server.js'),'未提交内容');
   if(scenario==='network')git(f.project,'remote','set-url','origin',path.join(f.root,'missing-remote'));
   const result=f.run([],scenario);assert.notEqual(result.status,0,scenario);assert.equal(await readFile(f.state,'utf8'),'active');
   assert.equal(git(f.project,'rev-parse','HEAD'),f.previous);assert.doesNotMatch(await readFile(f.calls,'utf8'),/^stop$/m);
  }finally{await f.close();}
 }
});

test('服务器更新：备份失败恢复旧服务，切换后失败保留备份且不自动回退数据库',async()=>{
 for(const scenario of ['backup','install','health']){
  const f=await fixture();try{
   const result=f.run([],scenario);assert.notEqual(result.status,0,scenario);
   if(scenario==='backup'){
    assert.equal(await readFile(f.state,'utf8'),'active');assert.equal(git(f.project,'rev-parse','HEAD'),f.previous);
   }else{
    assert.equal(await readFile(f.state,'utf8'),'inactive');assert.equal(git(f.project,'rev-parse','HEAD'),f.target);
    assert.match(result.stderr,/服务保持停止/,scenario+' 输出：'+result.stdout);const backups=await readdir(f.env.WORKBENCH_BACKUP_DIR);assert.ok(backups.some(x=>x.startsWith('update-')));
   }
   if(scenario==='health')assert.equal(await readFile(path.join(f.data,'workbench.sqlite'),'utf8'),'已迁移的数据');
  }finally{await f.close();}
 }
});

test('服务器更新：bundle 离线导入、分歧保护及快捷命令安装',async()=>{
 const f=await fixture();try{
  const bundle=path.join(f.root,'update.bundle');git(f.remote,'bundle','create',bundle,f.previous+'..main');git(f.project,'remote','set-url','origin',path.join(f.root,'missing-remote'));
  const result=f.run([bundle]);assert.equal(result.status,0,result.stderr);assert.equal(git(f.project,'rev-parse','HEAD'),f.target);
  assert.equal(f.run(['--install']).status,0);const wrapper=await readFile(f.env.WORKBENCH_COMMAND_PATH,'utf8');assert.ok(wrapper.includes('scripts/update-server.sh'));assert.ok(!wrapper.includes('password'));
  const forced=f.run([bundle,'--restart']);assert.equal(forced.status,0,forced.stderr);
 }finally{await f.close();}
 const diverged=await fixture();try{
  git(diverged.project,'config','user.name','测试维护者');git(diverged.project,'config','user.email','fixture@example.invalid');await writeFile(path.join(diverged.project,'local.txt'),'本地改动');git(diverged.project,'add','.');git(diverged.project,'commit','-m','本地提交');
  const result=diverged.run();assert.notEqual(result.status,0);assert.equal(await readFile(diverged.state,'utf8'),'active');assert.match(result.stderr,/分歧/);
 }finally{await diverged.close();}
});
