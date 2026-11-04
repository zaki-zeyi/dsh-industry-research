import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ServiceError } from './service.mjs';
import { larkRecoveryForError } from './lark-health.mjs';
import { registerFeishuApp } from './feishu-register-app.mjs';

export function registrationUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['open.feishu.cn', 'open.larksuite.com'].includes(u.hostname) && ['/page/cli', '/page/launcher'].includes(u.pathname) && Boolean(u.searchParams.get('user_code')); } catch { return false; }
}
const active = flow => flow && ['initializing', 'awaiting_scan', 'saving'].includes(flow.status);
export class FeishuRegistration {
  constructor(binding, registerApp = registerFeishuApp) { this.binding = binding; this.registerApp = registerApp; this.delay = ms => new Promise(resolve => setTimeout(resolve, ms)); }
  get busy() { return Boolean(active(this.flow)); }
  snapshot() {
    const f = this.flow; if (!f) return { status: 'idle' };
    if (active(f) && f.expires <= Date.now()) { f.controller.abort(); f.status = 'expired'; f.error = '二维码已过期，请重新扫码登录并选择应用'; }
    return { flowId: f.id, status: f.status, canRetrySave: Boolean(f.credentials && f.status === 'failed' && f.expires > Date.now()), saveAttempts: f.saveAttempts ?? 0, saveAttempt: f.saveAttempt ?? 0, phase: f.phase ?? 'registration', ...(f.storageDiagnostic ? { storageDiagnostic: f.storageDiagnostic } : {}), updatingApp: Boolean(f.targetAppId), ...(f.appId || f.targetAppId ? { appId: f.appId ?? f.targetAppId } : {}), ...(f.url ? { authorizationUrl: f.url } : {}), expiresAt: new Date(f.expires).toISOString(), ...(f.remoteStatus ? { remoteStatus: f.remoteStatus } : {}), ...(f.failureCode ? { failureCode: f.failureCode } : {}), ...(f.error ? { error: f.error } : {}), ...(f.recovery ? { recovery: f.recovery } : {}) };
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
      // Retain the received credentials only in memory, for a bounded save retry.
      f.credentials = result; f.expires = Date.now() + 600000;
      f.credentialTimer = setTimeout(() => { delete f.credentials; }, 600000); f.credentialTimer.unref?.();
      await this.persist(f);
    } catch (error) {
      this.fail(f, error);
    } finally { clearTimeout(f.timer); }
  }
  fail(f, error) {
      if (this.flow !== f || f.controller.signal.aborted) return;
      const failureCode = String(error?.code ?? error?.cause?.code ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
      if (failureCode) f.failureCode = failureCode;
      // A working old user token does not prove that newly requested bot
      // permissions were granted. Only the registration result confirms that.
      f.status = error?.code === 'expired_token' ? 'expired' : 'failed';
      f.recovery = error?.code === 'access_denied'
        ? { code: 'LARK_APP_AUTHORIZATION_DENIED', action: 'register_app', automatic: false, message: '已取消应用授权，可重新扫码；原绑定仍保留。' }
        : error?.recovery ?? larkRecoveryForError(error);
      if (f.recovery.code === 'LARK_AUTHORIZATION_PENDING') {
        const messages = { credential_storage: '飞书已返回应用凭据，但本机保存失败。请检查本机 Lark CLI 与凭据存储后重试；原绑定仍保留。', account_staging: '应用凭据已保存，但账号切换准备失败；原绑定仍保留，请恢复原账号授权后重试。' };
        if (messages[f.phase]) f.recovery = { code: 'LARK_' + f.phase.toUpperCase() + '_FAILED', action: 'retry', automatic: false, message: messages[f.phase] };
      }
      f.failureCode ??= f.recovery.code;
      f.error = f.recovery.message;
  }
  retrySave(id) {
    const f = this.flow;
    if (!f || f.id !== id || !f.credentials || f.expires <= Date.now()) throw new ServiceError(409, '可重试的应用凭据已失效，请重新扫码');
    if (f.status === 'saving') return this.snapshot();
    if (f.status !== 'failed' || this.binding.configuring || this.binding.starting || this.binding.completing) throw new ServiceError(409, '当前流程无法重试保存');
    this.work = this.persist(f).catch(error => this.fail(f, error));
    return this.snapshot();
  }
  async persist(f) {
    f.status = 'saving'; f.saveAttempt = 0; f.phase = 'credential_storage'; this.binding.configuring = true;
    delete f.error; delete f.recovery; delete f.failureCode;
    try {
      const result = f.credentials;
      // Permission repair keeps the working profile and user login. Recreating
      // a profile here would strand pending notifications on stale credentials.
      const current = this.binding.applicationSnapshot();
      if (f.targetAppId === current.appId && current.profile) {
        try {
          const state = await this.binding.json(['auth', 'status', '--json', '--verify'], current);
          if (state.appId === result.client_id && state.identities?.bot?.verified === true && state.identities.bot.available === true) {
            if (this.flow !== f || f.controller.signal.aborted) return;
            f.appId = result.client_id; f.status = 'completed'; clearTimeout(f.credentialTimer); delete f.credentials; return;
          }
        } catch { /* Missing local credentials still take the normal save path. */ }
      }
      let profile = f.savedProfile;
      if (!profile) for (let attempt = 0; attempt < 3; attempt++) {
        if (this.flow !== f || f.controller.signal.aborted || f.expires <= Date.now()) return;
        const candidate = 'research-' + randomUUID();
        f.saveAttempt = attempt + 1; f.saveAttempts = (f.saveAttempts ?? 0) + 1;
        try {
          const raw = await this.binding.run(['profile', 'add', '--name', candidate, '--app-id', result.client_id, '--app-secret-stdin', '--brand', 'feishu'], { input: result.client_secret + '\n' });
          let payload; try { payload = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
          if (payload?.ok === false) throw Object.assign(new Error('credential storage rejected'), { code: payload.error?.code });
          profile = f.savedProfile = candidate; break;
        } catch (error) {
          // A timeout can arrive after the CLI has written the profile. Verify
          // that exact candidate before creating another one or asking to scan.
          let credentialStatus = 'unconfirmed';
          try {
            const saved = await this.binding.json(['auth', 'status', '--json', '--verify'], { mode: 'custom', appId: result.client_id, profile: candidate });
            if (saved.appId === result.client_id && saved.identities?.bot?.available === true && saved.identities.bot.verified === true) {
              credentialStatus = 'verified'; profile = f.savedProfile = candidate;
            }
          } catch { /* Preserve the original storage failure below. */ }
          f.storageDiagnostic = { code: String(error?.code ?? 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80), killed: Boolean(error?.killed), credentialStatus };
          if (profile) break;
          if (attempt === 2) throw error;
          await this.delay(300 * 2 ** attempt);
        }
      }
      if (this.flow !== f || f.controller.signal.aborted || f.expires <= Date.now()) return;
      f.phase = 'account_staging';
      await this.binding.stageApplication({ mode: 'custom', appId: result.client_id, profile, registeredByOpenId: result.user_info.open_id }, f.accountRebind ? 'different' : (f.replaceApp || f.targetAppId ? 'same' : 'any'));
      this.binding.clear(); f.appId = result.client_id; f.status = 'completed'; clearTimeout(f.credentialTimer); delete f.credentials;
    } finally { this.binding.configuring = false; clearTimeout(f.timer); }
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
    clearTimeout(f.credentialTimer); delete f.credentials; f.controller.abort(); clearTimeout(f.timer); rmSync(f.directory, { recursive: true, force: true }); this.flow = null;
  }
  close() { if (this.flow) { clearTimeout(this.flow.credentialTimer); delete this.flow.credentials; this.flow.controller.abort(); clearTimeout(this.flow.timer); rmSync(this.flow.directory, { recursive: true, force: true }); this.flow = null; } }
}
