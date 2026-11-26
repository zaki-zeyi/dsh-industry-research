import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, linkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// HMR can give the replacement module a different global object. The on-disk
// lease is authoritative; this map only retains the owner's mutable record.
const operations = new Map();
const identity = directory => process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);
const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  try { renameSync(temporary, file); } finally { try { unlinkSync(temporary); } catch {} }
}

export function activeUpdate(directory) {
  if (!directory) return undefined;
  const id = identity(directory), file = resolve(id, 'operation-lock.json');
  const lease = read(file);
  if (!lease) return undefined;
  if (!Number.isInteger(lease.pid) || lease.pid <= 0 || !lease.id) throw new Error('更新互斥记录无效');
  if (!alive(lease.pid)) { unlinkSync(file); return undefined; }
  const local = operations.get(id);
  return local?.id === lease.id ? local : lease;
}

export function claimUpdate(directory, kind) {
  const directoryId = identity(directory);
  if (activeUpdate(directoryId)) throw Object.assign(new Error('另一个更新正在执行，请完成后重试'), { code: 'UPDATE_BUSY' });
  mkdirSync(directoryId, { recursive: true });
  const operation = { id: randomUUID(), pid: process.pid, kind, startedAt: new Date().toISOString() };
  const file = resolve(directoryId, 'operation-lock.json'), temporary = `${file}.${operation.id}.tmp`;
  writeFileSync(temporary, JSON.stringify(operation));
  try { linkSync(temporary, file); }
  catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('另一个更新正在执行，请完成后重试'), { code: 'UPDATE_BUSY' }); throw error; }
  finally { unlinkSync(temporary); }
  operations.set(directoryId, operation);
  return { operation, release() {
    if (read(file)?.id === operation.id) unlinkSync(file);
    if (operations.get(directoryId) === operation) operations.delete(directoryId);
  } };
}

export function confirmUpdateRuntime(directory, version) {
  let record;
  try { record = read(resolve(directory, 'official-update.json')); } catch { return; }
  const legacyEarlyFailure = record?.state === 'failed' && record.error === 'DSH 已完成安装，但工作台新版健康状态尚未确认';
  if (!record?.id || record.version !== version || !legacyEarlyFailure && !['checking', 'installing', 'removing'].includes(record.state)) return;
  atomicWrite(resolve(directory, 'official-ready.json'), { id: record.id, version, pid: process.pid, at: new Date().toISOString() });
}

export function confirmedUpdateRuntime(directory, record, maxAge = Infinity) {
  let ready;
  try { ready = read(resolve(directory, 'official-ready.json')); } catch { return false; }
  return Boolean(ready && ready.id === record.id && ready.version === record.version && ready.pid === process.pid &&
    ready.at >= record.startedAt && Date.now() - Date.parse(ready.at) <= maxAge);
}
