import {DatabaseSync} from 'node:sqlite';
import {mkdir, readFile, rename, access, cp, rm, readdir} from 'node:fs/promises';
import {randomBytes, randomUUID, scrypt, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';

const derive = promisify(scrypt);
const planFields = ['title','department','owner','start','due','goal','tasks','priority','status','progress','createdAt','updatedAt'];
const ownershipFields=['ownerUserId','organizationId'];
const basisFields = ['title','category','source','date','content','createdAt','updatedAt'];
export const sessionSeconds = 30 * 24 * 60 * 60;
export const fail = (message, status = 400) => Object.assign(new Error(message), {status});
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${Buffer.from(await derive(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [salt, hash] = encoded.split(':');
  const actual = Buffer.from(await derive(password, salt, 64));
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const publicUser = user => ({id:user.id, username:user.username, displayName:user.displayName, role:user.role, enabled:!!user.enabled, createdAt:user.createdAt});

export async function openStore(dir) {
  await mkdir(dir, {recursive:true});
  // 在任何升级写入之前保存完整数据快照，排除历史备份，SQLite 使用一致性备份。
  let previous;
  try {await access(path.join(dir,'workbench.sqlite'));previous=new DatabaseSync(path.join(dir,'workbench.sqlite'),{readOnly:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  try {
    const initialized=previous?.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata'").get()&&previous.prepare("SELECT 1 FROM metadata WHERE key='planOwnershipInitialized'").get();
    let legacy=false;try{await access(path.join(dir,'workbench.json'));legacy=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!initialized&&(previous||legacy)){
      const destination=path.join(dir,'backups','计划权限升级前_'+new Date().toISOString().replace(/[:.]/g,'-')+'_'+randomUUID());
      await mkdir(destination,{recursive:true});
      try {
        for(const name of await readdir(dir))if(name!=='backups'&&!/^workbench\.sqlite(?:-wal|-shm|-journal)?$/.test(name))await cp(path.join(dir,name),path.join(destination,name),{recursive:true});
        if(previous)previous.prepare('VACUUM INTO ?').run(path.join(destination,'workbench.sqlite'));
      }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
    }
  }finally{previous?.close();}
  const sql = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
  sql.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, parentId TEXT REFERENCES organizations(id), createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, displayName TEXT NOT NULL, passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_organizations (userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, organizationId TEXT NOT NULL REFERENCES organizations(id), PRIMARY KEY(userId,organizationId));
    CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (username TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expiresAt);
    CREATE TABLE IF NOT EXISTS bases (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, date TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, title TEXT NOT NULL, department TEXT NOT NULL, owner TEXT NOT NULL, start TEXT NOT NULL, due TEXT NOT NULL, goal TEXT NOT NULL, tasks TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plan_bases (planId TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, basisId TEXT NOT NULL REFERENCES bases(id), position INTEGER NOT NULL, PRIMARY KEY(planId,basisId));`);
  const transaction = fn => {
    sql.exec('BEGIN IMMEDIATE');
    try {const result=fn(); sql.exec('COMMIT'); return result;}
    catch(error) {sql.exec('ROLLBACK'); throw error;}
  };
  const insert = (table, fields, record) => sql.prepare(`INSERT INTO ${table} (id,${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')},?)`).run(record.id,...fields.map(f=>record[f] ?? (f==='progress'?0:ownershipFields.includes(f)?null:'')));
  const legacyFile = path.join(dir, 'workbench.json');
  try {
    // 旧用户归入默认机构，保留密码、会话和业务数据；以后不重复分配。
    transaction(()=>{
      if(!sql.prepare("SELECT 1 FROM metadata WHERE key='organizationsInitialized'").get()){
        sql.prepare('INSERT INTO organizations VALUES (?,?,NULL,?)').run('default-organization','默认机构',new Date().toISOString());
        sql.prepare('INSERT INTO user_organizations SELECT id,? FROM users').run('default-organization');
        sql.prepare('INSERT INTO metadata VALUES (?,?)').run('organizationsInitialized','1');
      }
    });
    if (!sql.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) {
      let legacy;
      try {legacy=JSON.parse(await readFile(legacyFile,'utf8'));}
      catch(error) {if(error.code!=='ENOENT')throw Error('旧数据读取失败，未迁移；请检查备份与数据格式。');}
      if(legacy && (!Array.isArray(legacy.plans)||!Array.isArray(legacy.bases)))throw Error('旧数据结构错误，未迁移。');
      const seed = {id:randomUUID(), username:'admin', displayName:'管理员', passwordHash:await hashPassword('admin'), role:'admin', enabled:1, createdAt:new Date().toISOString()};
      transaction(()=>{
        // 仅在整个初始化成功时写入标记；迁移失败不会留下半份业务数据。
        if(legacy) {
          for(const b of [...legacy.bases].reverse()) {if(typeof b.id!=='string'||!b.id)throw Error('旧依据编号错误'); insert('bases',basisFields,b);}
          for(const p of [...legacy.plans].reverse()) {
            if(typeof p.id!=='string'||!p.id||!Array.isArray(p.basisIds))throw Error('旧计划结构错误');
            insert('plans',planFields,p);
            [...new Set(p.basisIds)].forEach((id,index)=>sql.prepare('INSERT INTO plan_bases VALUES (?,?,?)').run(p.id,id,index));
          }
        }
        sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(seed.id,seed.username,seed.displayName,seed.passwordHash,seed.role,seed.enabled,seed.createdAt);
        sql.prepare('INSERT INTO user_organizations VALUES (?,?)').run(seed.id,'default-organization');
        sql.prepare('INSERT INTO metadata VALUES (?,?)').run('initialized','1');
        if(legacy)sql.prepare('INSERT INTO metadata VALUES (?,?)').run('legacyImported','1');
      });
    }
    transaction(()=>{
      const columns=sql.prepare('PRAGMA table_info(plans)').all().map(c=>c.name);
      if(!columns.includes('ownerUserId'))sql.exec('ALTER TABLE plans ADD COLUMN ownerUserId TEXT REFERENCES users(id) ON DELETE SET NULL');
      if(!columns.includes('organizationId'))sql.exec('ALTER TABLE plans ADD COLUMN organizationId TEXT REFERENCES organizations(id) ON DELETE SET NULL');
      sql.exec('CREATE TABLE IF NOT EXISTS uploads (name TEXT PRIMARY KEY,userId TEXT REFERENCES users(id) ON DELETE SET NULL)');
      if(!sql.prepare("SELECT 1 FROM metadata WHERE key='planOwnershipInitialized'").get()){
        const users=sql.prepare('SELECT id,username,displayName FROM users').all();
        for(const p of sql.prepare('SELECT * FROM plans WHERE ownerUserId IS NULL').all()){
          const matches=users.filter(u=>p.owner.trim()&&(u.displayName===p.owner.trim()||u.username.toLowerCase()===p.owner.trim().toLowerCase()));
          if(matches.length!==1)continue;
          const owner=matches[0];
          const orgs=sql.prepare('SELECT o.id,o.name FROM organizations o JOIN user_organizations m ON m.organizationId=o.id WHERE m.userId=?').all(owner.id);
          const matching=orgs.filter(o=>o.name===p.department);
          const org=matching.length===1?matching[0]:orgs.length===1?orgs[0]:null;
          sql.prepare('UPDATE plans SET ownerUserId=?,organizationId=coalesce(organizationId,?) WHERE id=?').run(owner.id,org?.id??null,p.id);
        }
        sql.prepare('INSERT INTO metadata VALUES (?,?)').run('planOwnershipInitialized','1');
      }
    });
    if(sql.prepare("SELECT 1 FROM metadata WHERE key='legacyImported'").get()) {
      try {
        await access(legacyFile);
        const backup=legacyFile+'.migrated.bak';
        try {await access(backup); throw Error('旧数据备份文件已存在，请先确认文件后再启动。');}
        catch(error) {if(error.code!=='ENOENT')throw error;}
        await rename(legacyFile,backup);
      } catch(error) {if(error.code!=='ENOENT')throw error;}
    }
  } catch(error) {sql.close(); throw error;}
  return {
    sql, transaction,
    userView(user) {return {...publicUser(user),organizationIds:sql.prepare('SELECT organizationId FROM user_organizations WHERE userId=? ORDER BY organizationId').all(user.id).map(row=>row.organizationId)};},
    readData() {
      const bases=sql.prepare('SELECT * FROM bases ORDER BY rowid DESC').all();
      const links=sql.prepare('SELECT * FROM plan_bases ORDER BY position').all();
      const plans=sql.prepare('SELECT * FROM plans ORDER BY rowid DESC').all().map(p=>({...p,basisIds:links.filter(l=>l.planId===p.id).map(l=>l.basisId)}));
      return {plans,bases};
    },
    writeRecord(type,record,isNew) {
      transaction(()=>{
        const fields=type==='plans'?[...planFields,...ownershipFields]:basisFields;
        if(isNew)insert(type,fields,record);
        else sql.prepare(`UPDATE ${type} SET ${fields.map(f=>f+'=?').join(',')} WHERE id=?`).run(...fields.map(f=>record[f] ?? (f==='progress'?0:ownershipFields.includes(f)?null:'')),record.id);
        if(type==='plans') {
          sql.prepare('DELETE FROM plan_bases WHERE planId=?').run(record.id);
          record.basisIds.forEach((id,index)=>sql.prepare('INSERT INTO plan_bases VALUES (?,?,?)').run(record.id,id,index));
        }
      });
    },
    deleteRecord(type,id) {sql.prepare(`DELETE FROM ${type} WHERE id=?`).run(id);},
    session(token) {
      if(!token || !/^[a-f0-9]{64}$/.test(token))return null;
      sql.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(Date.now());
      return sql.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.userId WHERE tokenHash=? AND users.enabled=1').get(tokenHash(token));
    },
    createSession(userId) {
      const token=randomBytes(32).toString('hex');
      sql.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token),userId,Date.now()+sessionSeconds*1000);
      return token;
    },
    revoke(token) {if(token)sql.prepare('DELETE FROM sessions WHERE tokenHash=?').run(tokenHash(token));}
  };
}
