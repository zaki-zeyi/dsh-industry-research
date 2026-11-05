import { larkLaunch } from './lark-launch.mjs';
import { FeishuRegistration } from './feishu-registration.mjs';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDeliverySchema } from './agent-delivery.mjs';
import { ServiceError } from './service.mjs';
import { applicationSchema, cliFor } from './feishu-application.mjs';
import { larkRecoveryForError, larkRecoveryForStatus } from './lark-health.mjs';
export const requiredScopes = ['auth:user.id:read', 'contact:user.basic_profile:readonly', 'docx:document:create', 'docx:document:write_only', 'docx:document:readonly', 'docs:document:import', 'docs:document.media:upload', 'docs:document.media:download', 'drive:drive.metadata:readonly', 'space:document:retrieve', 'drive:file:upload', 'drive:file:download', 'space:folder:create', 'offline_access'];
export const requiredTenantScopes = ['im:message:send_as_bot'];
export class FeishuBinding {
  constructor({ command, run, store, registerApp } = {}) {
    this.store = store; this.scopes = requiredScopes; this.tenantScopes = requiredTenantScopes; this.registration = new FeishuRegistration(this, registerApp);
    const local = resolve(homedir(), '.local/bin/lark-cli');
    this.command = command ?? (existsSync(local) ? local : 'lark-cli');
    this.run = run ?? ((args, options = {}) => new Promise((resolveRun, reject) => {
      const launch = larkLaunch(this.command, args);
      const child = execFile(launch.command, launch.args, { timeout: options.timeoutMs ?? 15000, maxBuffer: 128 * 1024, cwd: options.cwd, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }, (error, stdout, stderr) => {
        if (!error) return resolveRun(stdout);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      });
      options.onSpawn?.(child);
      child.stdin?.on('error', () => {}); child.stdin?.end(options.input ?? '');
    }));
  }
  applicationSnapshot() {
    const application = this.store?.setting('feishu-application') ?? { mode: 'default' };
    const account = this.store?.setting?.('feishu-account');
    const accountMatches = account && (!application.appId || !account.appId || account.appId === application.appId);
    if (!accountMatches) return application;
    return {
      ...application,
      ownerOpenId: application.ownerOpenId ?? account.openId,
      ...(!application.ownerName && account.userName ? { ownerName: account.userName } : {}),
    };
  }
  pendingApplicationOperation() {
    return this.store?.setting?.('feishu-pending-application') ?? null;
  }
  async stageApplication(application, mode = 'any') {
    if (!['same', 'different', 'any'].includes(mode)) throw new Error('invalid binding account mode');
    if (!this.store?.transaction || !this.store?.deleteSetting) throw new Error('binding storage unavailable');
    const previousApplication = this.store.setting('feishu-application') ?? { mode: 'default' };
    const previousAccount = this.store.setting('feishu-account');
    const samePreviousAccount = previousAccount && (!previousApplication.appId || previousAccount.appId === previousApplication.appId);
    const previousOpenId = samePreviousAccount ? previousAccount.openId : previousApplication.ownerOpenId;
    let previousUnionId = samePreviousAccount ? previousAccount.unionId : previousApplication.ownerUnionId;
    if (mode !== 'any' && !previousUnionId && previousOpenId) {
      const previousState = await this.inspectStatus(previousApplication, { allowAccountChange: true });
      if (previousState.bound) previousUnionId = (await this.withStableIdentity(previousState, previousApplication)).unionId;
    }
    const pending = {
      mode,
      ...(previousOpenId ? { previousOpenId } : {}),
      ...(previousUnionId ? { previousUnionId } : {}),
      previousAppId: previousApplication.appId,
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.saveSetting('feishu-pending-application', pending);
      this.store.saveSetting('feishu-application', application);
      this.store.deleteSetting('feishu-account');
      this.store.deleteSetting('feishu-last-operation');
    });
    this.store.runtimeLog?.('feishu.application.staged', {appId:application.appId, previousAppId:previousApplication.appId, operation:mode});
    return pending;
  }
  clearPendingApplicationOperation() {
    this.store?.deleteSetting?.('feishu-pending-application');
  }
  commitPendingApplicationOperation(state) {
    const pending = this.pendingApplicationOperation();
    if (!pending) return;
    const currentApplication = this.applicationSnapshot();
    const targetAppId = currentApplication.appId;
    const previousAppId = pending.previousAppId ?? pending.previousApplication?.appId;
    const rememberFailure = error => { this.store?.runtimeLog?.('feishu.application.validation_failed', {targetAppId,previousAppId:previousAppId,code:error.code},'error'); this.store?.saveSetting?.('feishu-last-operation', {status:'failed', targetAppId, previousAppId, code:error.code, error:error.message, at:new Date().toISOString()}); };
    const sameApp = previousAppId && previousAppId === currentApplication.appId;
    // Compare identifiers only within the same namespace. open_id is app-scoped.
    const useOpenId = sameApp && pending.previousOpenId && state.openId;
    const previousIdentity = useOpenId ? pending.previousOpenId : pending.previousUnionId;
    const currentIdentity = useOpenId ? state.openId : state.unionId;
    const sameAccount = previousIdentity && currentIdentity === previousIdentity;
    const differentAccount = previousIdentity && currentIdentity !== previousIdentity;
    if (pending.mode !== 'any' && (!previousIdentity || !currentIdentity)) {
      const error = new ServiceError(409, '无法确认原账号与当前个人授权的稳定身份。所选新应用已保留，未完成绑定，请补充身份授权后重试。');
      error.code = 'LARK_STABLE_IDENTITY_REQUIRED';
      error.recovery = { code: error.code, action: 'authorize', automatic: false, message: error.message };
      rememberFailure(error); throw error;
    }
    if (pending.mode === 'same' && previousIdentity && !sameAccount) {
      const error = new ServiceError(409, '更换应用必须使用原绑定的飞书账号。所选新应用已保留，请使用原账号重新扫码完成个人授权。');
      error.code = 'LARK_REPLACE_APP_ACCOUNT_CHANGED';
      error.recovery = { code: error.code, action: 'register_app', automatic: false, message: error.message };
      rememberFailure(error); throw error;
    }
    if (pending.mode === 'different' && previousIdentity && !differentAccount) {
      const error = new ServiceError(409, '重新绑定需要使用与原账号不同的飞书账号。所选应用已保留，请使用新账号重新扫码完成个人授权。');
      error.code = 'LARK_REBIND_SAME_ACCOUNT';
      error.recovery = { code: error.code, action: 'rebind_app', automatic: false, message: error.message };
      rememberFailure(error); throw error;
    }
    this.store?.runtimeLog?.('feishu.application.committed', {appId:currentApplication.appId, previousAppId, operation:pending.mode});
    this.store?.deleteSetting?.('feishu-last-operation');
    this.rememberVerifiedAccount(state, this.applicationSnapshot());
    this.clearPendingApplicationOperation();
  }
  rememberVerifiedAccount(state, application) {
    if (!state?.openId || !this.store?.saveSetting) return;
    const verified = {
      openId: state.openId,
      ...(state.unionId ? { unionId: state.unionId } : {}),
      appId: state.appId ?? application.appId ?? '',
      userName: state.userName ?? '',
      verifiedAt: new Date().toISOString(),
    };
    this.store.saveSetting('feishu-account', verified);
    const current = this.store.setting('feishu-application');
    if (current?.mode === 'custom' && (!verified.appId || current.appId === verified.appId)) {
      this.store.saveSetting('feishu-application', { ...current, ownerOpenId: state.openId, ...(state.unionId ? { ownerUnionId: state.unionId } : {}) });
    }
  }
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
      if (data.mode === 'default') {
        this.store.saveSetting('feishu-application', { mode: 'default' });
        this.store.deleteSetting?.('feishu-account');
        this.clear();
        return this.applicationInfo();
      }
      const prior = this.applicationSnapshot();
      if (!data.appSecret && prior.mode === 'custom' && prior.appId === data.appId) return this.applicationInfo();
      if (!data.appSecret) throw new ServiceError(400, '首次配置或更换 App ID 时，请填写 App Secret');
      const profile = `research-${randomUUID()}`;
      try { await this.run(['profile', 'add', '--name', profile, '--app-id', data.appId, '--app-secret-stdin', '--brand', 'feishu'], { input: data.appSecret + '\n' }); }
      catch { throw new ServiceError(503, '飞书应用配置失败，请检查应用凭据、Lark CLI 和本机安全存储'); }
      this.store.saveSetting('feishu-application', { mode: 'custom', appId: data.appId, profile });
      this.store.deleteSetting?.('feishu-account');
      this.clear();
      return this.applicationInfo();
    } finally { this.configuring = false; }
  }
  selectedArgs(args, application = this.applicationSnapshot()) { cliFor(application); return application?.profile ? ['--profile', application.profile, ...args] : args; }
  async json(args, application = this.applicationSnapshot()) { const raw = await this.run(this.selectedArgs(args, application)); return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  async withStableIdentity(state, application) {
    if (!state?.bound || state.unionId) return state;
    try {
      const raw = await this.json(['contact', '+get-user', '--as', 'user', '--json'], application);
      const payload = raw?.data ?? raw;
      const user = payload?.user ?? payload;
      const unionId = String(user?.union_id ?? user?.unionId ?? '');
      return /^on_[A-Za-z0-9_-]+$/.test(unionId) ? { ...state, unionId } : state;
    } catch {
      this.store?.runtimeLog?.('feishu.identity.unavailable', {appId:application.appId,scope:'contact:user.basic_profile:readonly'}, 'warn');
      return state;
    }
  }

  async inspectStatus(application = this.applicationSnapshot(), { allowAccountChange = false } = {}) {
    try {
      const result = await this.json(['auth', 'status', '--json', '--verify'], application);
      if (application?.mode === 'custom' && result.appId !== application.appId) return { bound: false, available: true, error: 'Lark CLI 返回的应用与所选应用不一致，请重新配置，未使用默认应用代替' };
      const bot = result.identities?.bot;
      const notificationReady = bot?.status === 'ready' && bot?.available === true && bot?.verified === true;
      const metadata = { ...(result.appId ? { appId: result.appId } : {}), ...(bot?.appName ? { appName: String(bot.appName).slice(0, 100) } : {}), notificationReady };
      const user = result.identities?.user, scopes = new Set((user?.scope ?? '').split(/[ ,]+/));
      const authenticated = user?.available === true && user?.verified === true;
      const missingScopes = requiredScopes.filter(s => !scopes.has(s));
      const accountMismatch = !allowAccountChange && authenticated && application.ownerOpenId && user.openId !== application.ownerOpenId;
      const recovery = larkRecoveryForStatus(result, { missingScopes, accountMismatch });
      if (accountMismatch) return { ...metadata, bound: false, available: true, error: '个人授权账号与扫码绑定应用的账号不一致，请使用同一账号授权，或重新扫码登录并绑定新账号的应用', recovery };
      const bound = authenticated && missingScopes.length === 0;
      return { ...metadata, bound, authenticated, available: true, ...(bound ? { openId: user.openId, userName: String(user.userName ?? '飞书用户').slice(0, 100) } : { missingScopes, recovery, error: authenticated ? '飞书已登录，但文档与云盘权限不完整，请补充授权后开始调研' : recovery?.message ?? '请绑定飞书并授权文档与云盘访问权限后开始调研' }) };
    } catch (error) {
      const failure = larkRecoveryForError(error);
      return { bound: false, available: false, error: failure.message, recovery: failure };
    }
  }
  async status(application = this.applicationSnapshot(), options = {}) {
    const state = await this.inspectStatus(application, options);
    const operation = this.store?.setting?.('feishu-last-operation');
    if (operation?.status === 'failed') state.operation = operation;
    if (state.bound && this.pendingApplicationOperation()) return {
      ...state, ...(this.flow ? this.publicFlow() : {}), bound: false, error: operation?.error ?? '个人授权已收到，正在校验账号并提交绑定。', ...(operation?.status === 'failed' ? {recovery:{code:operation.code,action:'authorize',automatic:false,message:operation.error}} : {}),
    };
    if (!this.flow || state.bound) return state;
    return {
      ...state,
      ...this.publicFlow(),
      bound: false,
      available: true,
      error: this.flow.completionError || this.flow.recovery?.message || state.error,
      recovery: this.flow.recovery || state.recovery,
    };
  }
  async requireBound(application = this.applicationSnapshot()) {
    if (this.registration.busy) throw new ServiceError(428, '请先完成扫码登录和应用绑定，再启动调研');
    const state = await this.status(application);
    if (!state.bound) {
      const error = new ServiceError(428, state.error);
      error.code = state.recovery?.code;
      error.recovery = state.recovery;
      throw error;
    }
    return state;
  }
  async start({ rebind = false, compatibility = false } = {}) {
    if (this.registration.busy || this.configuring) throw new ServiceError(409, '飞书应用配置正在处理中，请稍后再试');
    if (this.completing) {
      if (this.flow) return this.publicFlow();
      throw new ServiceError(409, '授权确认正在处理中，请稍后再重新绑定');
    }
    if (this.starting) {
      if (this.startingRebind !== rebind || this.startingCompatibility !== compatibility) throw new ServiceError(409, '授权二维码正在生成，请稍后再试');
      return this.starting;
    }
    this.startingRebind = rebind;
    this.startingCompatibility = compatibility;
    this.starting = this.startOnce(rebind, compatibility).finally(() => { this.starting = null; }); return this.starting;
  }
  async startOnce(rebind = false, compatibility = false) {
    const application = this.applicationSnapshot();
    const pending = this.pendingApplicationOperation();
    if (compatibility) {
      if (!application.profile) throw new ServiceError(400, '当前应用没有独立的飞书 CLI profile，无法启用兼容登录');
      await this.run(this.selectedArgs(['config', 'set', 'dpop', 'disabled'], application));
      try { await this.run(this.selectedArgs(['auth', 'logout', '--json'], application)); } catch {}
    }
    let state = await this.inspectStatus(application, { allowAccountChange: Boolean(pending) });
    if (state.bound && pending) state = await this.withStableIdentity(state, application);
    if (state.bound && !rebind) {
      this.commitPendingApplicationOperation(state);
      return state;
    }
    if (!rebind && this.flow && this.flow.expires > Date.now()) return this.publicFlow();
    this.clear();
    try {
      const raw = await this.json(['auth', 'login', '--scope', requiredScopes.join(' '), '--no-wait', '--json'], application);
      const data = raw.data ?? raw;
      const url = data.verification_uri_complete ?? data.verification_url ?? data.verification_uri;
      if (!agentDeliverySchema.safeParse({ status: 'awaiting_authorization', authorizationUrl: url }).success || typeof data.device_code !== 'string' || !data.device_code) throw new Error('invalid flow');
      const expiresIn = Number(data.expires_in ?? 600); if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('invalid expiry');
      const directory = mkdtempSync(resolve(tmpdir(), 'research-feishu-binding-')), qrPath = resolve(directory, 'qrcode.png');
      this.flow = { id: randomUUID(), deviceCode: data.device_code, url, rebind, compatibility, pending, application, appId: state.appId ?? application.appId, appName: state.appName, expires: Date.now() + Math.min(expiresIn, 1800) * 1000, directory, qrPath };
      await this.run(this.selectedArgs(['auth', 'qrcode', url, '--output', qrPath], application), { cwd: directory }); return this.publicFlow();
    } catch (failure) {
      this.clear();
      const recovery = larkRecoveryForError(failure);
      const message = recovery.code === 'LARK_AUTHORIZATION_PENDING'
        ? `无法发起飞书绑定：${recovery.message}`
        : recovery.message;
      const error = new ServiceError(503, message);
      error.code = recovery.code;
      error.recovery = recovery;
      throw error;
    }
  }
  publicFlow() {
    return {
      bound: false,
      rebind: this.flow.rebind,
      compatibilityMode: this.flow.compatibility,
      appId: this.flow.appId,
      appName: this.flow.appName,
      flowId: this.flow.id,
      authorizationUrl: this.flow.url,
      expiresAt: new Date(this.flow.expires).toISOString(),
      autoCompleting: Boolean(this.flow.autoCompleting),
      ...(this.flow.recovery ? { recovery: this.flow.recovery } : {}),
    };
  }
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
      try {
        const raw = await this.run(this.selectedArgs(['auth', 'login', '--device-code', flow.deviceCode, '--json'], flow.application), {
          timeoutMs: Math.min(900000, Math.max(15000, flow.expires - Date.now() + 5000)),
          onSpawn: (child) => { flow.child = child; },
        });
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (payload?.ok === false) throw Object.assign(new Error(payload?.error?.message || 'authorization failed'), { code: payload?.error?.code });
      } catch (failure) {
        const recovery = larkRecoveryForError(failure);
        if (this.flow === flow) {
          flow.completionError = recovery.message;
          flow.recovery = recovery;
        }
        const error = new ServiceError(409, recovery.message);
        error.code = recovery.code;
        error.recovery = recovery;
        throw error;
      }
      flow.child = null;
      let state = flow.rebind || flow.pending
        ? await this.inspectStatus(flow.application, { allowAccountChange: true })
        : await this.requireBound(flow.application);
      if (!state.bound) throw new ServiceError(409, state.error);
      if (flow.appId && state.appId !== flow.appId) throw new ServiceError(409, '授权应用已发生变化，请重新扫码，未完成绑定');
      state = await this.withStableIdentity(state, flow.application);
      if (flow.pending) this.commitPendingApplicationOperation(state);
      else this.rememberVerifiedAccount(state, flow.application);
      this.clear();
      return flow.rebind ? this.status() : state;
    })().finally(() => { flow.child = null; this.completing = null; }); return this.completing;
  }
  autoComplete(id) {
    const flow = this.flow;
    if (!flow || flow.id !== id || flow.expires <= Date.now() || flow.autoCompletion) return flow?.autoCompletion ?? null;
    flow.autoCompleting = true;
    flow.autoCompletion = this.complete(id)
      .catch(() => null)
      .finally(() => { flow.autoCompleting = false; });
    return flow.autoCompletion;
  }
  clear() {
    if (this.flow) {
      try { this.flow.child?.kill(); } catch {}
      this.flow.child = null;
      rmSync(this.flow.directory, { recursive: true, force: true });
    }
    this.flow = null;
  }
  close() { this.registration.close(); this.clear(); }
}
