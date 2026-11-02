import { FeishuRegistration } from './feishu-registration.mjs';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDeliverySchema } from './agent-delivery.mjs';
import { ServiceError } from './service.mjs';
import { applicationSchema, cliFor } from './feishu-application.mjs';
export const requiredScopes = ['docx:document:create', 'docx:document:write_only', 'docx:document:readonly', 'docs:document:import', 'drive:drive.metadata:readonly', 'space:folder:create', 'offline_access'];
export class FeishuBinding {
  constructor({ command, run, store, registerApp } = {}) {
    this.store = store; this.scopes = requiredScopes; this.registration = new FeishuRegistration(this, registerApp);
    const local = resolve(homedir(), '.local/bin/lark-cli');
    this.command = command ?? (existsSync(local) ? local : 'lark-cli');
    this.run = run ?? ((args, options = {}) => new Promise((resolveRun, reject) => {
      const child = execFile(this.command, args, { timeout: 15000, maxBuffer: 128 * 1024, cwd: options.cwd, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }, (error, stdout) => error ? reject(error) : resolveRun(stdout));
      child.stdin?.on('error', () => {}); child.stdin?.end(options.input ?? '');
    }));
  }
  applicationSnapshot() { return this.store?.setting('feishu-application') ?? { mode: 'default' }; }
  async applicationInfo() {
    const app = this.applicationSnapshot();
    if (app.mode === 'custom') return { mode: 'custom', appId: app.appId, hasSecret: true };
    const state = await this.status(app); return { mode: 'default', appId: state.appId ?? '', appName: state.appName ?? '', hasSecret: false };
  }
  async configureApplication(input) {
    const data = applicationSchema.parse(input);
    if (!this.store) throw new ServiceError(503, '当前服务未启用飞书应用配置');
    if (this.registration.busy || this.starting || this.completing || this.configuring) throw new ServiceError(409, '飞书授权或配置正在处理中，请稍后再试');
    this.configuring = true;
    try {
      if (data.mode === 'default') { this.store.saveSetting('feishu-application', { mode: 'default' }); this.clear(); return this.applicationInfo(); }
      const prior = this.applicationSnapshot();
      if (!data.appSecret && prior.mode === 'custom' && prior.appId === data.appId) return this.applicationInfo();
      if (!data.appSecret) throw new ServiceError(400, '首次配置或更换 App ID 时，请填写 App Secret');
      const profile = `research-${randomUUID()}`;
      try { await this.run(['profile', 'add', '--name', profile, '--app-id', data.appId, '--app-secret-stdin', '--brand', 'feishu'], { input: data.appSecret + '\n' }); }
      catch { throw new ServiceError(503, '飞书应用配置失败，请检查应用凭据、Lark CLI 和本机安全存储'); }
      this.store.saveSetting('feishu-application', { mode: 'custom', appId: data.appId, profile }); this.clear(); return this.applicationInfo();
    } finally { this.configuring = false; }
  }
  selectedArgs(args, application = this.applicationSnapshot()) { cliFor(application); return application?.profile ? ['--profile', application.profile, ...args] : args; }
  async json(args, application = this.applicationSnapshot()) { const raw = await this.run(this.selectedArgs(args, application)); return typeof raw === 'string' ? JSON.parse(raw) : raw; }

  async status(application = this.applicationSnapshot()) {
    try {
      const result = await this.json(['auth', 'status', '--json', '--verify'], application);
      if (application?.mode === 'custom' && result.appId !== application.appId) return { bound: false, available: true, error: 'Lark CLI 返回的应用与所选应用不一致，请重新配置，未使用默认应用代替' };
      const metadata = { ...(result.appId ? { appId: result.appId } : {}), ...(result.identities?.bot?.appName ? { appName: String(result.identities.bot.appName).slice(0, 100) } : {}) };
      const user = result.identities?.user, scopes = new Set((user?.scope ?? '').split(/[ ,]+/));
      const authenticated = user?.available === true && user?.verified === true;
      const missingScopes = requiredScopes.filter(s => !scopes.has(s));
      const accountMismatch = authenticated && application.ownerOpenId && user.openId !== application.ownerOpenId;
      if (accountMismatch) return { ...metadata, bound: false, available: true, error: '个人授权账号与扫码绑定应用的账号不一致，请使用同一账号授权，或重新扫码登录并绑定新账号的应用' };
      const bound = authenticated && missingScopes.length === 0;
      return { ...metadata, bound, authenticated, available: true, ...(bound ? { userName: String(user.userName ?? '飞书用户').slice(0, 100) } : { missingScopes, error: authenticated ? '飞书已登录，但文档与云盘权限不完整，请补充授权后开始调研' : '请绑定飞书并授权文档与云盘访问权限后开始调研' }) };
    } catch { return { bound: false, available: false, error: '无法检查飞书授权，请确认已安装并配置 lark-cli，或稍后重试' }; }
  }
  async requireBound(application = this.applicationSnapshot()) { if (this.registration.busy) throw new ServiceError(428, '请先完成扫码登录和应用绑定，再启动调研'); const state = await this.status(application); if (!state.bound) throw new ServiceError(428, state.error); return state; }
  async start({ rebind = false } = {}) {
    if (this.registration.busy || this.configuring) throw new ServiceError(409, '飞书应用配置正在处理中，请稍后再试');
    if (this.completing) throw new ServiceError(409, '授权确认正在处理中，请稍后再重新绑定');
    if (this.starting) {
      if (this.startingRebind !== rebind) throw new ServiceError(409, '授权二维码正在生成，请稍后再试');
      return this.starting;
    }
    this.startingRebind = rebind;
    this.starting = this.startOnce(rebind).finally(() => { this.starting = null; }); return this.starting;
  }
  async startOnce(rebind = false) {
    const application = this.applicationSnapshot();
    const state = await this.status(application); if (state.bound && !rebind) return state;
    if (!rebind && this.flow && this.flow.expires > Date.now()) return this.publicFlow();
    this.clear();
    try {
      const raw = await this.json(['auth', 'login', '--scope', requiredScopes.join(' '), '--no-wait', '--json'], application);
      const data = raw.data ?? raw;
      const url = data.verification_uri_complete ?? data.verification_url ?? data.verification_uri;
      if (!agentDeliverySchema.safeParse({ status: 'awaiting_authorization', authorizationUrl: url }).success || typeof data.device_code !== 'string' || !data.device_code) throw new Error('invalid flow');
      const expiresIn = Number(data.expires_in ?? 600); if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('invalid expiry');
      const directory = mkdtempSync(resolve(tmpdir(), 'research-feishu-binding-')), qrPath = resolve(directory, 'qrcode.png');
      this.flow = { id: randomUUID(), deviceCode: data.device_code, url, rebind, application, appId: state.appId ?? application.appId, appName: state.appName, expires: Date.now() + Math.min(expiresIn, 1800) * 1000, directory, qrPath };
      await this.run(this.selectedArgs(['auth', 'qrcode', url, '--output', qrPath], application), { cwd: directory }); return this.publicFlow();
    } catch { this.clear(); throw new ServiceError(503, '无法发起飞书绑定，请检查 lark-cli 应用配置与网络后重试'); }
  }
  publicFlow() { return { bound: false, rebind: this.flow.rebind, appId: this.flow.appId, appName: this.flow.appName, flowId: this.flow.id, authorizationUrl: this.flow.url, expiresAt: new Date(this.flow.expires).toISOString() }; }
  qr(id) {
    if (!this.flow || id !== this.flow.id || this.flow.expires <= Date.now()) throw new ServiceError(404, '授权二维码已失效，请重新绑定飞书');
    let bytes; try { bytes = readFileSync(this.flow.qrPath); } catch { throw new ServiceError(404, '二维码尚不可用，请重试'); }
    if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new ServiceError(404, '二维码格式无效'); return bytes;
  }
  async complete(id) {
    if (!this.flow || this.flow.id !== id || this.flow.expires <= Date.now()) throw new ServiceError(409, '授权已过期，请重新发起绑定');
    if (this.completing) return this.completing;
    const flow = this.flow;
    this.completing = (async () => {
      try { await this.json(['auth', 'login', '--device-code', flow.deviceCode, '--json'], flow.application); } catch { throw new ServiceError(409, '尚未完成授权或确认超时，请确认扫码账号有当前应用的使用权限；其他企业的账号请先更换对应应用再扫码'); }
      const state = await this.requireBound(flow.application);
      if (flow.appId && state.appId !== flow.appId) throw new ServiceError(409, '授权应用已发生变化，请重新扫码，未完成绑定'); this.clear(); return state;
    })().finally(() => { this.completing = null; }); return this.completing;
  }
  clear() { if (this.flow) rmSync(this.flow.directory, { recursive: true, force: true }); this.flow = null; }
  close() { this.registration.close(); this.clear(); }
}
