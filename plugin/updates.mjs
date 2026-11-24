import { createHash, randomUUID } from 'node:crypto';

const releaseUrl = 'https://api.github.com/repos/zaki-zeyi/dsh-industry-research/releases/latest';
const settingKey = 'plugin-update';
const checkIntervalMs = 6 * 60 * 60 * 1000;
const retryIntervalMs = 5 * 60 * 1000;
const releaseAgeMs = 12 * 60 * 60 * 1000;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const commitPattern = /^[a-f0-9]{40}$/;

function newerVersion(candidate, installed) {
  const next = versionPattern.exec(candidate);
  const current = versionPattern.exec(installed);
  if (!next || !current) return false;
  for (let index = 1; index <= 3; index++) {
    if (Number(next[index]) !== Number(current[index])) return Number(next[index]) > Number(current[index]);
  }
  return false;
}

async function readJson(response, maxBytes) {
  if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('更新清单过大');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

export class PluginUpdates {
  constructor(service, manager, version, { request = fetch, now = Date.now } = {}) {
    this.service = service;
    this.manager = manager;
    this.version = version;
    this.request = request;
    this.now = now;
    this.saved = service.store.setting(settingKey) ?? { automatic: false };
    this.candidate = null;
    this.state = 'idle';
    this.error = '';
    this.eligible = null;
    this.reconcile();
  }

  getManager() { return typeof this.manager === 'function' ? this.manager() : this.manager; }

  reconcile() {
    const pending = this.saved.pending;
    if (!pending) return;
    this.saved = {
      ...this.saved,
      pending: null,
      lastResult: this.version === pending.version ? 'updated' : this.version === pending.previousVersion ? 'restored' : 'unexpected-version',
      lastVersion: pending.version,
    };
    this.service.store.saveSetting(settingKey, this.saved);
  }

  snapshot() {
    return {
      installedVersion: this.version,
      automatic: this.saved.automatic,
      checkedAt: this.saved.checkedAt ?? null,
      candidateVersion: this.candidate?.version ?? null,
      readyAt: this.candidate ? new Date(Date.parse(this.candidate.publishedAt) + releaseAgeMs).toISOString() : null,
      state: this.state,
      error: this.error,
      lastResult: this.saved.lastResult ?? null,
      lastVersion: this.saved.lastVersion ?? null,
      supported: typeof this.getManager()?.updateBundle === 'function',
      eligible: this.eligible,
    };
  }

  async refreshEligibility() {
    const manager = this.getManager();
    if (typeof manager?.listBundles !== 'function') { this.eligible = false; return; }
    const bundles = await manager.listBundles();
    const installed = bundles.find(bundle => bundle.name === 'dsh-industry-research');
    this.eligible = Boolean(installed?.installed && installed.update === 'git' && installed.version === this.version);
  }

  start() {
    void this.refreshEligibility().catch(() => { this.eligible = false; });
    this.timer = setInterval(() => {
      if (!this.saved.checkedAt || this.now() - Date.parse(this.saved.checkedAt) >= checkIntervalMs) {
        void this.check().catch(() => {});
      } else if (this.saved.automatic && this.candidate && this.now() - Date.parse(this.candidate.publishedAt) >= releaseAgeMs && this.state !== 'installing') {
        void this.install().catch(() => {});
      }
    }, retryIntervalMs);
    this.timer.unref?.();
    const delay = 30_000 + Math.floor(Math.random() * 30_000);
    this.firstCheck = setTimeout(() => { void this.check().catch(() => {}); }, delay);
    this.firstCheck.unref?.();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.firstCheck);
  }

  setAutomatic(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动更新设置无效');
    if (enabled && this.eligible !== true) throw new Error('请先通过 DSH 插件管理器安装固定提交的正式版');
    this.saved = { ...this.saved, automatic: enabled };
    this.service.store.saveSetting(settingKey, this.saved);
    if (enabled && this.candidate && this.now() - Date.parse(this.candidate.publishedAt) >= releaseAgeMs) {
      void this.install().catch(() => {});
    }
    return this.snapshot();
  }

  async check() {
    if (this.closed || this.checking || this.state === 'installing') return this.snapshot();
    this.checking = true;
    this.state = 'checking';
    this.error = '';
    try {
      const { value: release } = await readJson(await this.request(releaseUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-industry-research' },
        signal: AbortSignal.timeout(15_000),
      }), 128 * 1024);
      if (/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '') && !newerVersion(release.tag_name.slice(1), this.version)) {
        this.candidate = null;
        await this.refreshEligibility();
        this.saved = { ...this.saved, checkedAt: new Date(this.now()).toISOString() };
        this.service.store.saveSetting(settingKey, this.saved);
        this.state = 'current';
        return this.snapshot();
      }
      if (release.immutable !== true) throw new Error('正式发布未启用不可变保护，已暂停自动更新');
      const asset = release.assets?.find(item => item.name === 'update-manifest.json');
      if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error('正式发布缺少可校验的更新清单');
      const { bytes, value: manifest } = await readJson(await this.request(asset.browser_download_url, {
        signal: AbortSignal.timeout(15_000),
      }), 8 * 1024);
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('更新清单校验失败');
      if (manifest.schema !== 'dsh-industry-research/update/v1' || manifest.name !== 'dsh-industry-research' ||
        release.tag_name !== `v${manifest.version}` || !commitPattern.test(manifest.sourceCommit) ||
        manifest.sourceCommit !== release.target_commitish || !commitPattern.test(manifest.installCommit) ||
        manifest.installTag !== `plugin-install-v${manifest.version}` ||
        !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) || !Number.isFinite(Date.parse(release.published_at))) {
        throw new Error('更新清单与正式发布不一致');
      }
      this.candidate = newerVersion(manifest.version, this.version)
        ? { version: manifest.version, installCommit: manifest.installCommit, publishedAt: release.published_at }
        : null;
      await this.refreshEligibility();
      this.saved = { ...this.saved, checkedAt: new Date(this.now()).toISOString() };
      this.service.store.saveSetting(settingKey, this.saved);
      this.state = this.candidate ? 'available' : 'current';
      if (this.saved.automatic && this.candidate && this.now() - Date.parse(this.candidate.publishedAt) >= releaseAgeMs) {
        void this.install().catch(() => {});
      }
    } catch (error) {
      this.candidate = null;
      this.state = 'failed';
      this.error = error.message;
    } finally {
      this.checking = false;
    }
    return this.snapshot();
  }

  async install() {
    if (this.closed || this.state === 'installing') throw new Error('已有更新正在安装');
    const candidate = this.candidate;
    if (!candidate) throw new Error('请先检查更新');
    const manager = this.getManager();
    if (typeof manager?.updateBundle !== 'function') throw new Error('当前 DSH 宿主不支持插件原生更新');
    const bundles = await manager.listBundles();
    const installed = bundles.find(bundle => bundle.name === 'dsh-industry-research');
    this.eligible = Boolean(installed?.installed && installed.update === 'git' && installed.version === this.version);
    if (!this.eligible) {
      throw new Error('当前安装来源尚未固定到 Git 提交，请先通过 DSH 插件管理器安装正式版本');
    }
    this.service.updating = true;
    if (this.service.active.size || this.service.queue?.length || this.service.store.list().some(task => ['running', 'queued'].includes(task.status)) ||
      this.service.queuedSaves?.running.size || this.service.queuedSaves?.submissions.size || this.service.inFlightWrites) {
      this.service.updating = false;
      throw new Error('工作台仍有任务或写入正在执行，稍后自动重试');
    }
    this.state = 'installing';
    this.saved = { ...this.saved, pending: { version: candidate.version, previousVersion: this.version }, lastResult: null };
    this.service.store.saveSetting(settingKey, this.saved);
    try {
      const spec = `git+https://github.com/zaki-zeyi/dsh-industry-research.git#${candidate.installCommit}`;
      const result = await manager.updateBundle('dsh-industry-research', candidate.version, { spec, requestId: randomUUID() });
      if (this.closed) return;
      if (!['applied', 'restart-required'].includes(result.application)) {
        throw new Error(result.error?.diagnostic ?? `DSH 更新失败：${result.application ?? '未知状态'}`);
      }
      this.state = result.application === 'restart-required' ? 'restart-required' : 'installed';
    } catch (error) {
      if (!this.closed) {
        this.saved = { ...this.saved, pending: null, lastResult: 'failed', lastVersion: candidate.version };
        this.service.store.saveSetting(settingKey, this.saved);
        this.state = 'failed';
        this.error = error.message;
      }
      throw error;
    } finally {
      this.service.updating = false;
    }
  }
}
