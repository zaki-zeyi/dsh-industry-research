import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  openSync, fsyncSync, closeSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

function runTar(args) {
  return new Promise((done, reject) => {
    const child = spawn('tar', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? done(stdout) : reject(new Error(`更新包解压失败：${stderr.slice(0, 500)}`)));
  });
}

function safeArchiveEntry(name) {
  const parts = name.replace(/\/$/, '').split('/');
  return parts[0] === 'package' &&
    parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes(':'));
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class UpdateSlots {
  constructor(dataDir, baseVersion) {
    this.root = resolve(dataDir, 'updates');
    this.slots = resolve(this.root, 'slots');
    this.statePath = resolve(this.root, 'slots.json');
    this.baseVersion = baseVersion;
    this.base = { kind: 'base', version: baseVersion };
    this.state = this.readState();
    this.activation = new Promise(resolve => { this.finishActivation = resolve; });
  }

  readState() {
    try {
      const state = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (state.schema !== 1) throw new Error('更新槽位状态版本不兼容');
      return state;
    } catch (error) {
      return { schema: 1, active: this.base, previous: null, pending: null,
        lastResult: error.code === 'ENOENT' ? null : { state: 'restored', version: null,
          reason: 'state-corrupt', error: '槽位状态不可读，已加载内置版本' } };
    }
  }

  save(state) {
    mkdirSync(this.root, { recursive: true });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    const handle = openSync(temp, 'r+');
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temp, this.statePath);
    this.state = state;
  }

  pathFor(slot) {
    if (slot.kind === 'base' && slot.version === this.baseVersion) return new URL('./payload.mjs', import.meta.url);
    if (slot.kind !== 'slot' || !/^[a-f0-9]{64}$/.test(slot.sha256) || !/^\d+\.\d+\.\d+$/.test(slot.version)) {
      throw new Error('更新槽位标识无效');
    }
    return resolve(this.slots, slot.sha256, 'package', 'plugin', 'payload.mjs');
  }

  async prepare(archivePath, candidate) {
    const archive = candidate.archive;
    if (!archive || !/^[a-f0-9]{64}$/.test(archive.sha256) || archive.version !== candidate.version ||
      (await stat(archivePath)).size !== archive.size || await digestFile(archivePath) !== archive.sha256) {
      throw new Error('更新包校验失败');
    }
    const slot = { kind: 'slot', version: candidate.version, sha256: archive.sha256 };
    const target = resolve(this.slots, archive.sha256);
    if (existsSync(this.pathFor(slot))) {
      const manifest = JSON.parse(await readFile(resolve(target, 'package', 'package.json'), 'utf8'));
      if (manifest.name !== 'dsh-industry-research' || manifest.version !== candidate.version ||
        !existsSync(resolve(target, 'package', 'dist', 'index.html'))) throw new Error('本地更新槽位内容无效');
      return slot;
    }
    const entries = (await runTar(['-tzf', archivePath])).split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some(entry => !safeArchiveEntry(entry))) throw new Error('更新包含非法路径');
    const kinds = (await runTar(['-tvzf', archivePath])).split(/\r?\n/).filter(Boolean);
    if (kinds.length !== entries.length || kinds.some(line => !/^[-d]/.test(line))) throw new Error('更新包含符号链接或特殊文件');
    await mkdir(this.slots, { recursive: true });
    const temporary = resolve(this.slots, `.stage-${randomUUID()}`);
    await mkdir(temporary, { recursive: true });
    try {
      await runTar(['-xzf', archivePath, '-C', temporary]);
      const manifest = JSON.parse(await readFile(resolve(temporary, 'package', 'package.json'), 'utf8'));
      if (manifest.name !== 'dsh-industry-research' || manifest.version !== candidate.version ||
        !existsSync(resolve(temporary, 'package', 'plugin', 'payload.mjs')) ||
        !existsSync(resolve(temporary, 'package', 'dist', 'index.html'))) throw new Error('更新包内容或版本无效');
      try { await rename(temporary, target); }
      catch (error) { if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error; }
      return slot;
    } finally {
      if (temporary.startsWith(this.slots + sep)) await rm(temporary, { recursive: true, force: true });
    }
  }

  async schedule(archivePath, candidate) {
    if (this.state.pending) throw new Error('已有待重启的更新');
    const target = await this.prepare(archivePath, candidate);
    const previous = this.state.active ?? this.base;
    this.save({ ...this.state, pending: { target, previous }, lastResult: null });
    return { application: 'restart-required', version: target.version };
  }

  async boot(mount) {
    const pending = this.state.pending;
    const target = pending?.target ?? this.state.active ?? this.base;
    let current, result;
    const healthStartedAt = Date.now();
    try {
      current = await mount(target);
      if (pending) {
        this.save({ ...this.state, active: target, previous: pending.previous, pending: null,
          lastResult: { state: 'updated', version: target.version, healthDurationMs: Date.now() - healthStartedAt } });
      }
      result = { state: pending ? 'updated' : 'current', version: target.version };
    } catch (error) {
      await Promise.resolve(current?.dispose?.()).catch(() => {});
      const fallback = pending?.previous ?? this.state.previous ?? this.base;
      if (target.kind === fallback.kind && target.version === fallback.version && target.sha256 === fallback.sha256) throw error;
      const rollbackStartedAt = Date.now();
      current = await mount(fallback);
      this.save({ ...this.state, active: fallback, previous: null, pending: null,
        lastResult: { state: 'restored', version: target.version, error: error.message,
          healthDurationMs: rollbackStartedAt - healthStartedAt,
          rollbackDurationMs: Date.now() - rollbackStartedAt } });
      result = { state: 'restored', version: fallback.version, failedVersion: target.version };
    } finally {
      this.finishActivation(result);
    }
    return current;
  }

  waitForActivation() { return this.activation; }
  get activeVersion() { return this.state.active?.version ?? this.baseVersion; }
}
