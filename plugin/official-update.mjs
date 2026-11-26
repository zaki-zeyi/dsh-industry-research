import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeUpdate, claimUpdate } from './update-operation.mjs';
import { pauseForUpdate } from './update-busy.mjs';
import { newerVersion, packageName, readVerifiedRelease, repository, trustedGitSource } from './update-release.mjs';

const terminal = new Set(['updated', 'failed', 'restored', 'restart-required', 'interrupted']);

export class OfficialGitUpdates {
  constructor(service, manager, version, { cacheDir, request = fetch } = {}) {
    this.service = service; this.manager = manager; this.version = version;
    this.cacheDir = cacheDir; this.request = request;
    this.file = resolve(cacheDir, 'official-update.json');
    this.candidate = null; this.error = ''; this.checkedAt = null;
  }

  record() {
    const live = activeUpdate(this.cacheDir);
    if (live?.kind === 'official') return live.record;
    try {
      const record = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!terminal.has(record.state)) return { ...record, state: 'interrupted', error: '上次更新被中断，请检查当前版本后重试' };
      return record;
    } catch { return null; }
  }

  save(operation, state, extra = {}) {
    const at = new Date().toISOString();
    operation.record = { ...operation.record, ...extra, state, updatedAt: at,
      events: [...(operation.record?.events ?? []), { at, state, ...extra }].slice(-50) };
    mkdirSync(this.cacheDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(operation.record, null, 2));
    renameSync(temporary, this.file);
  }

  async installed() { return (await this.manager()?.listBundles?.() ?? []).find(item => item.name === packageName); }

  async snapshot() {
    const installed = await this.installed();
    const supported = typeof this.manager()?.updateBundle === 'function';
    const eligible = supported && installed?.installed === true && installed.update === 'git' && trustedGitSource(installed.source);
    const candidate = this.candidate && newerVersion(this.candidate.version, installed?.version) &&
      !newerVersion(this.version, this.candidate.version) ? this.candidate : null;
    const operation = this.record();
    // Transfer the durable audit into the platform log after a full plugin replacement.
    if (operation && terminal.has(operation.state)) {
      try {
        const cursor = `${operation.id}:${operation.updatedAt}`;
        if (this.service.store.setting('official-update-log-cursor') !== cursor) {
          for (const event of operation.events ?? []) this.service.store.runtimeLog?.(`update.official.${event.state}`,
            { operationId: operation.id, from: operation.from, version: operation.version, ...event }, event.error ? 'error' : 'info');
          this.service.store.saveSetting('official-update-log-cursor', cursor);
        }
      } catch { /* The old runtime's store can already be closed during HMR. */ }
    }
    return { installedVersion: installed?.version ?? null, runningVersion: this.version, source: installed?.source ?? null,
      supported, eligible, candidateVersion: candidate?.version ?? null, checkedAt: this.checkedAt,
      checking: Boolean(this.checking), error: this.error, operation,
      busy: Boolean(activeUpdate(this.cacheDir)),
      unavailableReason: !supported ? '当前 DSH 不支持官方 Git 更新' : !eligible ? '请通过 DSH 安装固定 Git 提交的版本后使用此入口' : null };
  }

  async check() {
    if (!this.checking) this.checking = (async () => {
      this.error = '';
      try {
        const installed = await this.installed();
        this.candidate = await readVerifiedRelease(this.request, installed?.version);
        this.checkedAt = new Date().toISOString();
      } catch (error) { this.error = error.message; this.candidate = null; }
      finally { this.checking = null; }
    })();
    await this.checking;
    return this.snapshot();
  }

  start(version) {
    const target = this.candidate;
    if (!target || target.version !== version) throw new Error('版本信息已变化，请重新检查更新');
    const lease = claimUpdate(this.cacheDir, 'official');
    const operation = lease.operation;
    operation.record = { id: randomUUID(), version: target.version, startedAt: operation.startedAt, events: [] };
    try { this.save(operation, 'checking'); }
    catch (error) { lease.release(); throw error; }
    // DSH owns updateBundle: do not await it from a disposer or a request whose
    // route will disappear when DSH unloads this package.
    this.work = this.run(target, operation).finally(() => lease.release());
    void this.work.catch(() => {});
    return operation.record;
  }

  async run(target, operation) {
    let resume;
    try {
      const manager = this.manager(), installed = await this.installed();
      if (typeof manager?.updateBundle !== 'function' || !installed?.installed || installed.update !== 'git' || !trustedGitSource(installed.source)) {
        throw new Error('当前安装来源不支持官方 Git 更新，请先安装固定 Git 提交的版本');
      }
      if (!newerVersion(target.version, installed.version) || newerVersion(this.version, target.version)) throw new Error('目标版本不能低于当前运行版本，且必须高于宿主安装版本');
      resume = pauseForUpdate(this.service);
      this.save(operation, 'installing', { from: installed.version });
      const result = await manager.updateBundle(packageName, target.version, {
        spec: `${repository}#${target.installCommit}`, requestId: operation.record.id,
      });
      const application = result?.result?.application;
      const current = (await manager.listBundles()).find(item => item.name === packageName);
      const matches = current?.installed && current.version === target.version && trustedGitSource(current.source) && current.source.endsWith(`#${target.installCommit}`);
      if (application === 'restart-required' && matches) {
        this.save(operation, 'restart-required', { error: 'DSH 已安装新版，当前宿主需要重启后生效' });
      } else if (application === 'applied' && matches) {
        if (operation.runningVersion !== target.version) throw new Error('DSH 已完成安装，但工作台新版健康状态尚未确认');
        this.save(operation, 'updated', { installedVersion: current.version, error: '' });
      } else {
        const restored = result?.restore?.application === 'applied' && current?.version === installed.version;
        this.save(operation, restored ? 'restored' : 'failed', {
          error: result?.result?.error?.diagnostic ?? (restored ? '更新失败，DSH 已恢复原版本' : 'DSH 未完成更新，请查看宿主安装日志后重试'),
          application: application ?? 'unknown', restoredVersion: restored ? current.version : null,
        });
      }
    } catch (error) { this.save(operation, 'failed', { error: error.message }); }
    finally { if (resume && !this.disposed) { try { resume(); } catch {} } }
  }

  progress(progress) {
    const operation = activeUpdate(this.cacheDir);
    if (operation?.kind === 'official' && progress.requestId === operation.record?.id && !terminal.has(operation.record.state)) {
      this.save(operation, progress.step);
    }
  }
}
