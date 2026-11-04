import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ServiceError } from './service.mjs';
import { larkRecoveryForError } from './lark-health.mjs';

export function registrationUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['open.feishu.cn', 'open.larksuite.com'].includes(u.hostname) && ['/page/cli', '/page/launcher'].includes(u.pathname) && Boolean(u.searchParams.get('user_code')); } catch { return false; }
}
const active = flow => flow && ['initializing', 'awaiting_scan', 'saving'].includes(flow.status);
export class FeishuRegistration {
  constructor(binding, registerApp = async options => (await import('@larksuiteoapi/node-sdk')).registerApp(options)) { this.binding = binding; this.registerApp = registerApp; }
  get busy() { return Boolean(active(this.flow)); }
  snapshot() {
    const f = this.flow; if (!f) return { status: 'idle' };
    if (active(f) && f.expires <= Date.now()) { f.controller.abort(); f.status = 'expired'; f.error = '二维码已过期，请重新扫码登录并选择应用'; }
    return { flowId: f.id, status: f.status, updatingApp: Boolean(f.targetAppId), ...(f.appId || f.targetAppId ? { appId: f.appId ?? f.targetAppId } : {}), ...(f.url ? { authorizationUrl: f.url } : {}), expiresAt: new Date(f.expires).toISOString(), ...(f.remoteStatus ? { remoteStatus: f.remoteStatus } : {}), ...(f.failureCode ? { failureCode: f.failureCode } : {}), ...(f.error ? { error: f.error } : {}), ...(f.recovery ? { recovery: f.recovery } : {}) };
  }
  start({ refresh = false, replaceApp = false, accountRebind = false } = {}) {
    if (!this.binding.store) throw new ServiceError(503, '当前服务未启用飞书绑定配置');
    if (this.binding.configuring || this.binding.starting || this.binding.completing || this.flow?.status === 'saving') throw new ServiceError(409, '授权或应用配置正在处理中，请稍后再试');
    if (this.busy && !refresh) return this.snapshot();
    this.cancel(); this.binding.clear();
    const selected = this.binding.applicationSnapshot();
    const targetAppId = !replaceApp && selected?.mode === 'custom' && /^cli_[A-Za-z0-9]{5,100}$/.test(selected.appId ?? '') ? selected.appId : undefined;
    const f = {
      id: randomUUID(),
      status: 'initializing',
      controller: new AbortController(),
      expires: Date.now() + 600000,
      directory: mkdtempSync(resolve(tmpdir(), 'research-feishu-app-')),
      targetAppId,
      replaceApp,
      accountRebind,
    };
    f.qrPath = resolve(f.directory, 'qrcode.png'); this.flow = f;
    f.timer = setTimeout(() => { if (active(f)) { f.controller.abort(); f.status = 'expired'; f.error = '二维码已过期，请重新扫码登录并选择应用'; } }, 600000); f.timer.unref?.();
    this.work = this.execute(f); return this.snapshot();
  }
  async execute(f) {
    let qrWork;
    try {
      const result = await this.registerApp({ source: 'dsh-industry-research', signal: f.controller.signal, ...(f.targetAppId ? { appId: f.targetAppId } : {}),
        appPreset: { name: '{user}的行研工作台', desc: '调研报告创建与保存' },
        // Include user scopes for document delivery and tenant scopes for bot notifications.
        addons: { preset: false, scopes: { user: this.binding.scopes.filter(s => s !== 'offline_access'), tenant: this.binding.tenantScopes } },
        onQRCodeReady: info => {
          if (this.flow !== f || f.controller.signal.aborted) return;
          if (!registrationUrl(info.url) || !Number.isFinite(info.expireIn) || info.expireIn <= 0) throw new Error('invalid verification response');
          f.url = info.url; f.expires = Date.now() + Math.min(info.expireIn, 600) * 1000; f.status = 'awaiting_scan';
          qrWork = this.binding.run(['auth', 'qrcode', f.url, '--output', f.qrPath], { cwd: f.directory });
          // Observe immediately, even when registration continues polling for several minutes.
          qrWork.catch(error => {
            if (this.flow === f && active(f)) {
              f.recovery = larkRecoveryForError(error);
              f.status = 'failed';
              f.error = f.recovery.message;
              f.controller.abort();
            }
          });
        },
        onStatusChange: info => {
          if (this.flow === f && active(f) && typeof info?.status === 'string') f.remoteStatus = info.status;
        } });
      if (this.flow !== f || f.controller.signal.aborted) return;
      if (!f.url || !qrWork || !/^cli_[A-Za-z0-9]{5,100}$/.test(result.client_id ?? '') || typeof result.client_secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(result.client_secret) || !/^ou_[A-Za-z0-9_-]+$/.test(result.user_info?.open_id ?? '') || (result.user_info?.tenant_brand && result.user_info.tenant_brand !== 'feishu')) throw new Error('invalid app result');
      if (f.targetAppId && result.client_id !== f.targetAppId) throw new Error('updated app id mismatch');
      await qrWork;
      if (this.flow !== f || f.controller.signal.aborted || f.expires <= Date.now()) return;
      f.status = 'saving'; this.binding.configuring = true;
      try {
        const profile = `research-${randomUUID()}`;
        await this.binding.run(['profile', 'add', '--name', profile, '--app-id', result.client_id, '--app-secret-stdin', '--brand', 'feishu'], { input: result.client_secret + '\n' });
        if (this.flow !== f || f.controller.signal.aborted) return;
        // Do not select the app until both the official page and local credential storage succeed.
        // The account used to manage an application is not necessarily the
        // account used for personal authorization. Keep it as metadata and
        // verify the personal identity only after `auth login` completes.
        const operationMode = f.accountRebind ? 'different' : (f.replaceApp || f.targetAppId ? 'same' : 'any');
        await this.binding.stageApplication({
          mode: 'custom',
          appId: result.client_id,
          profile,
          registeredByOpenId: result.user_info.open_id,
        }, operationMode);
        this.binding.clear(); f.appId = result.client_id; f.status = 'completed';
      } finally { this.binding.configuring = false; }
    } catch (error) {
      if (this.flow !== f || f.controller.signal.aborted) return;
      const failureCode = String(error?.code ?? error?.cause?.code ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
      if (failureCode) f.failureCode = failureCode;
      const terminal = /^(access_denied|expired_token|abort)$/i.test(failureCode);
      if (f.targetAppId && f.remoteStatus === 'polling' && !terminal) {
        try {
          const application = this.binding.applicationSnapshot();
          if (application.mode !== 'custom' || application.appId !== f.targetAppId || !application.profile) throw new Error('existing application profile unavailable');
          const state = await this.binding.status(application);
          if (!state.bound || state.appId !== f.targetAppId) throw new Error('existing application is no longer authorized');
          this.binding.store.saveSetting('feishu-application', {
            ...application,
            ownerOpenId: application.ownerOpenId ?? state.openId,
            permissionUpdatedAt: new Date().toISOString(),
          });
          this.binding.store.saveSetting('feishu-account', {
            openId: state.openId,
            appId: f.targetAppId,
            userName: state.userName ?? '',
            verifiedAt: new Date().toISOString(),
          });
          this.binding.clear();
          f.appId = f.targetAppId;
          f.status = 'completed';
          f.remoteStatus = 'confirmed_existing_profile';
          delete f.error;
          delete f.recovery;
          return;
        } catch {
          // Fall through to the normal recoverable failure below.
        }
      }
      f.status = error?.code === 'expired_token' ? 'expired' : 'failed';
      f.recovery = error?.code === 'access_denied'
        ? { code: 'LARK_APP_AUTHORIZATION_DENIED', action: 'register_app', automatic: false, message: '已取消应用授权，可重新扫码；原绑定仍保留。' }
        : larkRecoveryForError(error);
      f.error = f.recovery.message;
    } finally { clearTimeout(f.timer); }
  }
  qr(id) {
    this.snapshot(); const f = this.flow;
    if (!f || f.id !== id || f.status !== 'awaiting_scan') throw new ServiceError(404, '应用绑定二维码已失效，请重新获取');
    let bytes; try { bytes = readFileSync(f.qrPath); } catch { throw new ServiceError(404, '二维码生成中，请稍后重试'); }
    if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new ServiceError(404, '二维码格式无效'); return bytes;
  }
  cancel() {
    const f = this.flow; if (!f) return;
    if (f.status === 'saving') throw new ServiceError(409, '应用凭据正在保存，请稍后再试');
    f.controller.abort(); clearTimeout(f.timer); rmSync(f.directory, { recursive: true, force: true }); this.flow = null;
  }
  close() { if (this.flow) { this.flow.controller.abort(); clearTimeout(this.flow.timer); rmSync(this.flow.directory, { recursive: true, force: true }); this.flow = null; } }
}
