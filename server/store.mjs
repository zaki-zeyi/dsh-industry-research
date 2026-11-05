import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, input TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_documents(id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS runtime_logs(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS terminals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminal_frames(seq INTEGER PRIMARY KEY AUTOINCREMENT, terminal_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS terminal_frames_session ON terminal_frames(terminal_id,seq);`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(id) { const r = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id); return r ? JSON.parse(r.body) : null; }
  list() { return this.db.prepare('SELECT body FROM tasks ORDER BY created_at DESC, id DESC').all().map(r => JSON.parse(r.body)); }
  save(task) { task.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, JSON.stringify(task), task.createdAt); return task; }
  event(id, type, data) { const event = { type, data, at: new Date().toISOString() }; const r = this.db.prepare('INSERT INTO events(task_id,body) VALUES(?,?)').run(id, JSON.stringify(event)); return { ...event, seq: Number(r.lastInsertRowid) }; }
  events(id, after = 0) { return this.db.prepare('SELECT seq,body FROM events WHERE task_id=? AND seq>? ORDER BY seq').all(id, after).map(r => ({ ...JSON.parse(r.body), seq: r.seq })); }
  request(key) { return this.db.prepare('SELECT * FROM requests WHERE key=?').get(key); }
  saveRequest(key, input, taskId) { this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(key, input, taskId); }
  putDocument(id, body) { this.db.prepare('INSERT INTO demo_documents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(body)); }
  document(id) { const r = this.db.prepare('SELECT body FROM demo_documents WHERE id=?').get(id); return r ? JSON.parse(r.body) : null; }
  setting(key) { const r = this.db.prepare('SELECT body FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.body) : null; }
  runtimeLog(event, details = {}, level = 'info') {
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(event) || !['info','warn','error'].includes(level)) return;
    const safe = {};
    const allowed = ['appId','targetAppId','previousAppId','code','status','phase','profile','operation','scope','attempt','taskId','killed','credentialStatus','operationId','durationMs'];
    for (const key of allowed) {
      const value = details[key];
      if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === 'string' && /^[A-Za-z0-9_.:\-]{1,120}$/.test(value)) safe[key] = value;
    }
    try { this.db.prepare('INSERT INTO runtime_logs(at,level,event,details) VALUES(?,?,?,?)').run(new Date().toISOString(), level, event, JSON.stringify(safe));
    this.db.exec('DELETE FROM runtime_logs WHERE seq <= (SELECT MAX(seq)-1000 FROM runtime_logs)'); } catch { /* Diagnostics must not replace the original operation failure. */ }
  }
  runtimeLogs({ limit = 100, before = Number.MAX_SAFE_INTEGER, feishu = false, level } = {}) {
    return this.db.prepare("SELECT * FROM runtime_logs WHERE seq < ? AND (? = 0 OR event LIKE 'feishu.%') AND (? IS NULL OR level = ?) ORDER BY seq DESC LIMIT ?").all(before, feishu ? 1 : 0, level ?? null, level ?? null, Math.min(200, Math.max(1, limit))).map(row => ({ ...row, details: JSON.parse(row.details) }));
  }
  saveSetting(key, value) { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value)); return value; }
  deleteSetting(key) { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); }
  close() { this.db.close(); }
  saveTerminal(meta) { this.db.prepare('INSERT INTO terminals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(meta.id, meta.taskId, JSON.stringify(meta)); }
  terminal(id) { const row = this.db.prepare('SELECT body FROM terminals WHERE id=?').get(id); return row ? JSON.parse(row.body) : null; }
  terminalList() { return this.db.prepare('SELECT body FROM terminals').all().map(row => JSON.parse(row.body)); }
  terminalFrame(id, data) { const r = this.db.prepare('INSERT INTO terminal_frames(terminal_id,body) VALUES(?,?)').run(id, JSON.stringify(data)); return { ...data, seq: Number(r.lastInsertRowid) }; }
  terminalFrames(id) { return this.db.prepare('SELECT seq,body FROM terminal_frames WHERE terminal_id=? ORDER BY seq').all(id).map(r => ({ ...JSON.parse(r.body), seq: r.seq })); }
}
export const newId = () => randomUUID();
