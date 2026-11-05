import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ServiceError } from './service.mjs';
import { saveFeishuProfile } from './feishu-profile.mjs';
import { observeFlow, recordTrace } from './connection-trace.mjs';

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
    return { flowId: f.id, status: f.status, ...(f.url ? { authorizationUrl: f.url } : {}), expiresAt: new Date(f.expires).toISOString(), ...(f.appId ? { appId: f.appId } : {}), ...(f.error ? { error: f.error } : {}) };
  }
  start({ refresh = false } = {}) {
    if (!this.binding.store) throw new ServiceError(503, '当前服务未启用飞书绑定配置');
    if (this.binding.configuring || this.binding.starting || this.binding.completing || this.flow?.status === 'saving') throw new ServiceError(409, '授权或应用配置正在处理中，请稍后再试');
    if (this.busy && !refresh) return this.snapshot();
    this.cancel(); this.binding.clear();
    const f = { id: randomUUID(), status: 'initializing', controller: new AbortController(), expires: Date.now() + 600000, directory: mkdtempSync(resolve(tmpdir(), 'research-feishu-app-')) };
    f.qrPath = resolve(f.directory, 'qrcode.png'); this.flow = f;
    observeFlow(this.binding.store, f);
    f.timer = setTimeout(() => { if (active(f)) { f.controller.abort(); f.status = 'expired'; f.error = '二维码已过期，请重新扫码登录并选择应用'; } }, 600000); f.timer.unref?.();
    this.work = this.execute(f); return this.snapshot();
  }
  async execute(f) {
    let qrWork;
    try {
      const result = await this.registerApp({ source: 'dsh-industry-research', signal: f.controller.signal,
        appPreset: { name: '{user}的行研工作台', desc: '调研报告创建与保存' },
        // Include only the business scopes needed by the existing personal delivery flow.
        addons: { preset: false, scopes: { user: this.binding.scopes.filter(s => s !== 'offline_access') } },
        onQRCodeReady: info => {
          if (this.flow !== f || f.controller.signal.aborted) return;
          if (!registrationUrl(info.url) || !Number.isFinite(info.expireIn) || info.expireIn <= 0) throw new Error('invalid verification response');
          f.url = info.url; f.expires = Date.now() + Math.min(info.expireIn, 600) * 1000; f.status = 'awaiting_scan';
          recordTrace(this.binding.store,'feishu.registration.waiting',{phase:'app_registration',status:'waiting',flowId:f.id});
          qrWork = this.binding.run(['auth', 'qrcode', f.url, '--output', f.qrPath], { cwd: f.directory });
          // Observe immediately, even when registration continues polling for several minutes.
          qrWork.catch(() => { if (this.flow === f && active(f)) { f.status = 'failed'; f.error = '二维码生成失败，请检查本机 Lark CLI 后重试'; f.controller.abort(); } });
        } });
      if (this.flow !== f || f.controller.signal.aborted) return;
      if (!f.url || !qrWork || !/^cli_[A-Za-z0-9]{5,100}$/.test(result.client_id ?? '') || typeof result.client_secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(result.client_secret) || !/^ou_[A-Za-z0-9_-]+$/.test(result.user_info?.open_id ?? '') || (result.user_info?.tenant_brand && result.user_info.tenant_brand !== 'feishu')) throw new Error('invalid app result');
      await qrWork;
      if (this.flow !== f || f.controller.signal.aborted || f.expires <= Date.now()) return;
      f.status = 'saving'; this.binding.configuring = true;
      try {
        const profile = await saveFeishuProfile(this.binding, result.client_id, result.client_secret);
        if (this.flow !== f || f.controller.signal.aborted) return;
        // Do not select the app until both the official page and local credential storage succeed.
        let previousAppId; try { previousAppId = this.binding.applicationSnapshot()?.appId; } catch {}
        this.binding.store.saveSetting('feishu-application', { mode: 'custom', appId: result.client_id, profile, ownerOpenId: result.user_info.open_id });
        recordTrace(this.binding.store,'feishu.application.selected',{phase:'binding_commit',status:'completed',previousAppId,appId:result.client_id,profile});
        this.binding.clear(); f.appId = result.client_id; f.status = 'completed';
      } finally { this.binding.configuring = false; }
    } catch (error) {
      if (this.flow !== f || f.controller.signal.aborted) return;
      f.status = error?.code === 'expired_token' ? 'expired' : 'failed';
      f.error = error?.code === 'access_denied' ? '已取消应用授权，可重新扫码；原绑定仍保留' : '应用绑定未完成，请检查账号的应用管理权限、网络及本机 Lark CLI 后重试；原绑定仍保留';
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
