import { resolve } from 'node:path';

// A full DSH update unloads this package. The operation must outlive its Cordis
// context and be visible to the replacement package in the same Host process.
const key = Symbol.for('dsh-industry-research.update-operations.v1');
const operations = globalThis[key] ??= new Map();
const identity = directory => process.platform === 'win32' ? resolve(directory).toLowerCase() : resolve(directory);

export function activeUpdate(directory) { return directory ? operations.get(identity(directory)) : undefined; }

export function claimUpdate(directory, kind) {
  const id = identity(directory);
  if (operations.has(id)) throw Object.assign(new Error('另一个更新正在执行，请完成后重试'), { code: 'UPDATE_BUSY' });
  const operation = { kind, startedAt: new Date().toISOString() };
  operations.set(id, operation);
  return { operation, release() { if (operations.get(id) === operation) operations.delete(id); } };
}
