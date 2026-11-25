import { createHash, randomUUID } from 'node:crypto';
import { stageUpdateArchive } from './update-download.mjs';

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
  constructor(service, manager, version, { request = fetch, now = Date.now, cacheDir, slotUpdater } = {}) {
    this.service = service;
    this.manager = manager;
    this.version = version;
    this.request = request;
    this.now = now;
    this.cacheDir = cacheDir;
    this.slotUpdater = slotUpdater;
    this.saved = service.store.setting(settingKey) ?? { automatic: false };
    this.candidate = newerVersion(this.saved.staged?.candidate?.version, version) &&
      this.saved.failedVersion !== this.saved.staged.candidate.version ? this.saved.staged.candidate : null;
    this.rollbackArchive = this.candidate ? this.saved.staged.rollbackArchive : null;
    this.state = 'idle';
    this.error = '';
    this.eligible = null;
    this.packageReady = false;
    this.downloadWork = null;
  }

  getManager() { return typeof this.manager === 'function' ? this.manager() : this.manager; }

  async reconcile() {
    const pending = this.saved.pending;
    if (!pending) {
      const verdict = this.slotUpdater?.state.lastResult;
      const failedVersion = verdict?.state === 'restored' ?
        verdict.version ?? (newerVersion(this.saved.lastVersion, this.version) ? this.saved.lastVersion : null) : null;
      if (failedVersion && failedVersion !== this.saved.failedVersion) {
        this.saved = { ...this.saved, failedVersion, lastResult: 'restored', lastVersion: failedVersion };
        this.service.store.saveSetting(settingKey, this.saved);
        this.candidate = null;
        this.packageReady = false;
        this.state = 'failed';
        this.error = `版本 ${failedVersion} 启动失败，已回到旧版；等待下一正式版本`;
      }
      return;
    }
    if (this.slotUpdater) {
      await this.slotUpdater.waitForActivation();
      const verdict = this.slotUpdater.state.lastResult;
      if (!verdict || (verdict.version !== pending.version && verdict.reason !== 'state-corrupt') ||
        !['updated', 'restored'].includes(verdict.state)) return;
      this.saved = { ...this.saved, pending: null, staged: null,
        failedVersion: verdict.state === 'restored' ? pending.version : null,
        lastResult: verdict.state, lastVersion: pending.version };
      this.service.store.saveSetting(settingKey, this.saved);
      if (verdict.state === 'restored') {
        this.candidate = null;
        this.packageReady = false;
        this.state = 'failed';
        this.error = `版本 ${pending.version} 启动失败，已回到旧版；等待下一正式版本`;
      }
      return;
    }
    const manager = this.getManager();
    if (typeof manager?.listBundles !== 'function') return;
    if (pending.requestId && typeof manager.waitForInstall === 'function') {
      await manager.waitForInstall(pending.requestId);
    }
    const installed = (await manager.listBundles()).find(bundle => bundle.name === 'dsh-industry-research');
    if (!installed?.installed || installed.version !== this.version ||
      ![pending.version, pending.previousVersion].includes(installed.version)) return;
    this.saved = {
      ...this.saved,
      pending: null,
      lastResult: installed.version === pending.version ? 'updated' : 'restored',
      lastVersion: pending.version,
      installedArchive: installed.version === pending.version ? pending.archive : pending.previousArchive,
      staged: null,
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
      supported: Boolean(this.slotUpdater) || typeof this.getManager()?.installBundle === 'function' &&
        typeof this.getManager()?.removeBundle === 'function',
      eligible: this.eligible,
      packageReady: this.packageReady,
    };
  }

  async refreshEligibility() {
    if (this.slotUpdater) { this.eligible = this.slotUpdater.activeVersion === this.version; return; }
    const manager = this.getManager();
    if (typeof manager?.listBundles !== 'function') { this.eligible = false; return; }
    const bundles = await manager.listBundles();
    const installed = bundles.find(bundle => bundle.name === 'dsh-industry-research');
    this.eligible = Boolean(installed?.installed && installed.version === this.version &&
      (installed.update === 'git' || this.saved.installedArchive?.version === this.version));
  }

  start() {
    void this.reconcile().then(() => this.refreshEligibility()).then(() => {
      if (this.candidate) return this.download();
    }).catch(() => { this.eligible = false; });
    this.timer = setInterval(() => {
      if (this.saved.pending && this.state !== 'installing') {
        if (!this.slotUpdater) void this.reconcile().catch(() => {});
        return;
      }
      if (!this.saved.checkedAt || this.now() - Date.parse(this.saved.checkedAt) >= checkIntervalMs) {
        void this.check().catch(() => {});
      } else if (this.candidate && this.state === 'download-failed') {
        void this.download().catch(() => {});
      } else if (this.saved.automatic && this.candidate && this.packageReady && this.now() - Date.parse(this.candidate.publishedAt) >= releaseAgeMs && this.state !== 'installing') {
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
    this.downloadAbort?.abort();
  }

  setAutomatic(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动更新设置无效');
    if (enabled && this.eligible !== true) throw new Error('请先通过 DSH 插件管理器安装固定提交的正式版');
    this.saved = { ...this.saved, automatic: enabled };
    this.service.store.saveSetting(settingKey, this.saved);
    if (enabled && this.candidate && this.packageReady && this.now() - Date.parse(this.candidate.publishedAt) >= releaseAgeMs) {
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
      if (this.downloadWork) {
        this.downloadAbort?.abort();
        await this.downloadWork.promise.catch(() => {});
      }
      const { value: release } = await readJson(await this.request(releaseUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-industry-research' },
        signal: AbortSignal.timeout(15_000),
      }), 128 * 1024);
      if (/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '') && !newerVersion(release.tag_name.slice(1), this.version)) {
        this.candidate = null;
        this.rollbackArchive = null;
        this.packageReady = false;
        await this.refreshEligibility();
        this.saved = { ...this.saved, staged: null, checkedAt: new Date(this.now()).toISOString() };
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
        !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
        manifest.archiveName !== `dsh-industry-research-${manifest.version}.tgz` ||
        !Number.isSafeInteger(manifest.archiveSize) || manifest.archiveSize < 1 ||
        !Number.isFinite(Date.parse(release.published_at))) {
        throw new Error('更新清单与正式发布不一致');
      }
      const archiveAsset = release.assets?.find(item => item.name === manifest.archiveName);
      if (!archiveAsset || archiveAsset.size !== manifest.archiveSize ||
        archiveAsset.digest !== `sha256:${manifest.archiveSha256}`) throw new Error('正式发布安装包与更新清单不一致');
      this.candidate = newerVersion(manifest.version, this.version) && manifest.version !== this.saved.failedVersion
        ? { version: manifest.version, installCommit: manifest.installCommit, publishedAt: release.published_at,
          archive: { version: manifest.version, name: manifest.archiveName, size: manifest.archiveSize,
            sha256: manifest.archiveSha256, url: archiveAsset.browser_download_url } }
        : null;
      this.packageReady = false;
      await this.refreshEligibility();
      this.saved = { ...this.saved, checkedAt: new Date(this.now()).toISOString() };
      this.service.store.saveSetting(settingKey, this.saved);
      this.state = this.candidate ? 'available' : manifest.version === this.saved.failedVersion ? 'failed' : 'current';
      if (manifest.version === this.saved.failedVersion) this.error = `版本 ${manifest.version} 启动失败，已回到旧版；等待下一正式版本`;
      if (this.candidate && this.eligible) void this.download().catch(() => {});
    } catch (error) {
      if (!this.saved.staged?.candidate || this.candidate?.version !== this.saved.staged.candidate.version ||
        this.candidate?.archive?.sha256 !== this.saved.staged.candidate.archive?.sha256) {
        this.candidate = null;
        this.packageReady = false;
        this.state = 'failed';
      } else this.state = this.packageReady ? 'available' : 'download-failed';
      this.error = error.message;
    } finally {
      this.checking = false;
    }
    return this.snapshot();
  }

  async previousArchive() {
    if (this.rollbackArchive?.version === this.version) return this.rollbackArchive;
    if (this.saved.installedArchive?.version === this.version) return this.saved.installedArchive;
    const { value: release } = await readJson(await this.request(
      `https://api.github.com/repos/zaki-zeyi/dsh-industry-research/releases/tags/v${this.version}`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-industry-research' },
        signal: AbortSignal.timeout(15_000) }), 128 * 1024);
    const name = `dsh-industry-research-${this.version}.tgz`;
    const asset = release.assets?.find(item => item.name === name);
    if (release.tag_name !== `v${this.version}` || !asset ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
      !Number.isSafeInteger(asset.size) || asset.size < 1) {
      throw new Error('旧版安装包不可校验，更新已暂停');
    }
    return { version: this.version, name, size: asset.size,
      sha256: asset.digest.slice(7), url: asset.browser_download_url };
  }

  async download() {
    const candidate = this.candidate;
    if (!candidate) throw new Error('没有可下载的更新');
    if (!this.cacheDir) throw new Error('更新缓存目录未配置');
    if (this.downloadWork?.candidate === candidate) return this.downloadWork.promise;
    this.state = 'downloading';
    this.error = '';
    const controller = new AbortController();
    this.downloadAbort = controller;
    const promise = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)]);
        const staged = await stageUpdateArchive(this.cacheDir, candidate.archive, this.request, signal);
        const previousArchive = this.slotUpdater ? null : await this.previousArchive();
        if (previousArchive) await stageUpdateArchive(this.cacheDir, previousArchive, this.request, signal);
        if (this.candidate !== candidate || this.closed) return staged;
        this.rollbackArchive = previousArchive;
        this.saved = { ...this.saved, staged: { candidate, rollbackArchive: previousArchive } };
        this.service.store.saveSetting(settingKey, this.saved);
        this.packageReady = true;
        this.state = 'available';
        return staged;
      } catch (error) {
        if (this.candidate === candidate && !this.closed) {
          this.packageReady = false;
          this.state = 'download-failed';
          this.error = error.message;
        }
        throw error;
      } finally {
        if (this.downloadWork?.candidate === candidate) this.downloadWork = null;
      }
    })();
    this.downloadWork = { candidate, promise };
    return promise;
  }

  async install() {
    if (this.installWork) return this.installWork;
    const work = this.performInstall();
    this.installWork = work;
    try { return await work; }
    finally { if (this.installWork === work) this.installWork = null; }
  }

  async performInstall() {
    if (this.closed || this.state === 'installing') throw new Error('已有更新正在安装');
    const candidate = this.candidate;
    if (!candidate) throw new Error('请先检查更新');
    if (this.slotUpdater) return this.performSlotInstall(candidate);
    const manager = this.getManager();
    if (typeof manager?.installBundle !== 'function' || typeof manager?.removeBundle !== 'function') {
      throw new Error('当前 DSH 宿主不支持本地安装包更新');
    }
    const bundles = await manager.listBundles();
    const installed = bundles.find(bundle => bundle.name === 'dsh-industry-research');
    this.eligible = Boolean(installed?.installed && installed.version === this.version &&
      (installed.update === 'git' || this.saved.installedArchive?.version === this.version));
    if (!this.eligible) {
      throw new Error('当前安装来源不受自动更新支持，请先通过 DSH 插件管理器安装正式版本');
    }
    const staged = await this.download();
    const previous = await stageUpdateArchive(this.cacheDir, this.rollbackArchive, this.request,
      AbortSignal.timeout(5 * 60 * 1000));
    this.service.updating = true;
    if (this.service.active.size || this.service.queue?.length || this.service.store.list().some(task => ['running', 'queued'].includes(task.status)) ||
      this.service.queuedSaves?.running.size || this.service.queuedSaves?.submissions.size || this.service.inFlightWrites) {
      this.service.updating = false;
      throw new Error('工作台仍有任务或写入正在执行，稍后自动重试');
    }
    this.state = 'installing';
    const requestId = randomUUID();
    this.saved = { ...this.saved, pending: { version: candidate.version, previousVersion: this.version, requestId,
      archive: candidate.archive, previousArchive: this.rollbackArchive }, lastResult: null };
    this.service.store.saveSetting(settingKey, this.saved);
    try {
      const name = 'dsh-industry-research';
      const removal = await manager.removeBundle(name);
      const noHmr = removal?.application === 'failed' && removal?.error?.code === 'stop-profile';
      if (!noHmr && removal?.application !== 'applied') {
        throw new Error(removal?.error?.diagnostic ?? '无法安全移除旧插件');
      }
      let result;
      try {
        result = await manager.installBundle(staged.path, {
          enabled: installed.enabled, expected: { name, version: candidate.version }, requestId });
      } catch (error) {
        result = { application: 'failed', error: { diagnostic: error.message } };
      }
      let application = result?.application;
      let mismatch = false;
      if (['applied', 'restart-required'].includes(application)) {
        const current = (await manager.listBundles()).find(bundle => bundle.name === name);
        mismatch = result?.bundle && result.bundle !== name || !current?.installed || current.version !== candidate.version;
        if (mismatch) {
          result = { ...result, application: 'failed', error: { diagnostic: '宿主安装结果与目标插件版本不一致' } };
          application = 'failed';
        }
      }
      if (!['applied', 'restart-required'].includes(application)) {
        let restored = noHmr;
        if (noHmr && mismatch) {
          const recovery = await manager.installBundle(previous.path, {
            enabled: installed.enabled, expected: { name, version: this.version }, requestId: randomUUID() });
          restored = ['applied', 'restart-required'].includes(recovery?.application);
        } else if (!noHmr) {
          const cleanupName = result?.bundle ?? name;
          const current = (await manager.listBundles()).find(bundle => bundle.name === cleanupName);
          if (current?.installed) {
            const cleanup = await manager.removeBundle(cleanupName);
            if (cleanup?.application !== 'applied') throw new Error('新版安装失败，且无法清理失败的安装');
          }
          const recovery = await manager.installBundle(previous.path, {
            enabled: installed.enabled, expected: { name, version: this.version }, requestId: randomUUID() });
          restored = ['applied', 'restart-required'].includes(recovery?.application);
        }
        if (restored) {
          const current = (await manager.listBundles()).find(bundle => bundle.name === name);
          restored = Boolean(current?.installed && current.version === this.version);
        }
        const detail = result?.error?.diagnostic ?? `DSH 更新失败：${application ?? '未知状态'}`;
        throw new Error(restored ? `${detail}；旧版已从本地缓存恢复` : `${detail}；旧版恢复失败`);
      }
      if (!this.closed) this.state = application === 'restart-required' ? 'restart-required' : 'installed';
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

  async performSlotInstall(candidate) {
    if (this.saved.pending) throw new Error('更新已准备完成，请先重启 DSH');
    await this.refreshEligibility();
    if (!this.eligible) throw new Error('当前运行版本与更新槽位不一致');
    const staged = await this.download();
    this.state = 'installing';
    try {
      await this.slotUpdater.schedule(staged.path, candidate);
      this.saved = { ...this.saved, pending: { version: candidate.version, previousVersion: this.version }, lastResult: null };
      this.service.store.saveSetting(settingKey, this.saved);
      this.state = 'restart-required';
      return this.snapshot();
    } catch (error) {
      this.state = 'failed';
      this.error = error.message;
      throw error;
    }
  }
}
