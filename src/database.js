import {DatabaseSync} from 'node:sqlite';
import {mkdir, readFile, rename, access} from 'node:fs/promises';
import {randomBytes, randomUUID, scrypt, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';

const derive = promisify(scrypt);
const planFields = ['title','department','owner','start','due','goal','tasks','priority','status','progress','createdAt','updatedAt'];
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
  const sql = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
  sql.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, displayName TEXT NOT NULL, passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), createdAt TEXT NOT NULL);
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
  const insert = (table, fields, record) => sql.prepare(`INSERT INTO ${table} (id,${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')},?)`).run(record.id,...fields.map(f=>record[f] ?? (f==='progress'?0:'')));
  const legacyFile = path.join(dir, 'workbench.json');
  try {
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
        sql.prepare('INSERT INTO metadata VALUES (?,?)').run('initialized','1');
        if(legacy)sql.prepare('INSERT INTO metadata VALUES (?,?)').run('legacyImported','1');
      });
    }
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
    readData() {
      const bases=sql.prepare('SELECT * FROM bases ORDER BY rowid DESC').all();
      const links=sql.prepare('SELECT * FROM plan_bases ORDER BY position').all();
      const plans=sql.prepare('SELECT * FROM plans ORDER BY rowid DESC').all().map(p=>({...p,basisIds:links.filter(l=>l.planId===p.id).map(l=>l.basisId)}));
      return {plans,bases};
    },
    writeRecord(type,record,isNew) {
      transaction(()=>{
        const fields=type==='plans'?planFields:basisFields;
        if(isNew)insert(type,fields,record);
        else sql.prepare(`UPDATE ${type} SET ${fields.map(f=>f+'=?').join(',')} WHERE id=?`).run(...fields.map(f=>record[f] ?? (f==='progress'?0:'')),record.id);
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
