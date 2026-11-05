import { larkLaunch } from './lark-launch.mjs';
import { FeishuRegistration } from './feishu-registration.mjs';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDeliverySchema } from './agent-delivery.mjs';
import { ServiceError } from './service.mjs';
import { applicationSchema, cliFor } from './feishu-application.mjs';
import { isAuthorizationPending, larkRecoveryForError, larkRecoveryForStatus } from './lark-health.mjs';
import { qrcodeArgs, qrcodeFailure, qrcodePath, verifyQrcode } from './feishu-qrcode.mjs';
export const requiredScopes = ['auth:user.id:read', 'contact:user.basic_profile:readonly', 'docx:document:create', 'docx:document:write_only', 'docx:document:readonly', 'docs:document:import', 'docs:document.media:upload', 'docs:document.media:download', 'drive:drive.metadata:readonly', 'space:document:retrieve', 'drive:file:upload', 'drive:file:download', 'space:folder:create', 'offline_access'];
// Listing a cloud-drive folder is only needed for the first import. Once the
// company index is known, research and refreshes use the saved manifest URL.
export const optionalScopes = ['space:document:retrieve'];
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
      const missingRequiredScopes = missingScopes.filter(s => !optionalScopes.includes(s));
      const accountMismatch = !allowAccountChange && authenticated && application.ownerOpenId && user.openId !== application.ownerOpenId;
      const recovery = larkRecoveryForStatus(result, { missingScopes: missingRequiredScopes, accountMismatch });
      if (accountMismatch) return { ...metadata, bound: false, available: true, error: '个人授权账号与扫码绑定应用的账号不一致，请使用同一账号授权，或重新扫码登录并绑定新账号的应用', recovery };
      const importReady = !missingScopes.includes('space:document:retrieve');
      const bound = authenticated && missingRequiredScopes.length === 0;
      const state = {
        ...metadata,
        bound,
        authenticated,
        importReady,
        ...(missingScopes.length ? { missingScopes } : {}),
        ...(bound
          ? { openId: user.openId, userName: String(user.userName ?? '飞书用户').slice(0, 100) }
          : { recovery, error: authenticated ? '飞书已登录，但文档或云盘权限不完整，请补充授权后开始调研' : recovery?.message ?? '请绑定飞书并授权文档与云盘访问权限后开始调研' }),
      };
      // Keep the token grant time private but let status() prove that a scan
      // completed after the pending application switch was staged.
      const authorizedAt = Date.parse(user?.grantedAt ?? '');
      if (Number.isFinite(authorizedAt)) Object.defineProperty(state, 'authorizedAt', { value: authorizedAt, enumerable: false });
      return state;
    } catch (error) {
      const failure = larkRecoveryForError(error);
      return { bound: false, available: false, error: failure.message, recovery: failure };
    }
  }
  async status(application = this.applicationSnapshot(), options = {}) {
    let state = await this.inspectStatus(application, options);
    const operation = this.store?.setting?.('feishu-last-operation');
    if (operation?.status === 'failed') state.operation = operation;
    const pending = this.pendingApplicationOperation();
    const pendingAt = Date.parse(pending?.createdAt ?? '');
    // Only finish a pending switch when the current token was granted after the
    // switch was staged. This recovers a scan that outlived the in-memory flow
    // without letting an older token confirm a new application by accident.
    if (state.bound && pending && Number.isFinite(pendingAt) && state.authorizedAt > pendingAt) {
      try {
        const stable = await this.withStableIdentity(state, application);
        this.commitPendingApplicationOperation(stable);
        state = stable;
      } catch (error) {
        return {
          ...state,
          bound: false,
          ...(state.recovery?.code === 'LARK_DPOP_KEY_UNAVAILABLE' ? { compatibilityAvailable: true } : {}),
          error: operation?.error ?? error.message,
          ...(error.recovery ? { recovery: error.recovery } : {}),
        };
      }
    }
    if (state.bound && this.pendingApplicationOperation()) return {
      ...state, ...(this.flow ? this.publicFlow() : {}), bound: false, ...(state.recovery?.code === 'LARK_DPOP_KEY_UNAVAILABLE' ? { compatibilityAvailable: true } : {}), error: operation?.error ?? '个人授权已收到，正在校验账号并提交绑定。', ...(operation?.status === 'failed' ? {recovery:{code:operation.code,action:'authorize',automatic:false,message:operation.error}} : {}),
    };
    if (!this.flow || state.bound) return state;
    return {
      ...state,
      ...this.publicFlow(),
      bound: false,
      available: true,
      ...(state.recovery?.code === 'LARK_DPOP_KEY_UNAVAILABLE' ? { compatibilityAvailable: true } : {}),
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
      const directory = mkdtempSync(resolve(tmpdir(), 'research-feishu-binding-')), qrPath = qrcodePath(directory);
      this.flow = { id: randomUUID(), deviceCode: data.device_code, url, rebind, compatibility, pending, application, appId: state.appId ?? application.appId, appName: state.appName, expires: Date.now() + Math.min(expiresIn, 1800) * 1000, directory, qrPath };
      try {
        // Lark CLI only accepts a relative --output path. The file still lands
        // inside this flow's private directory through the process cwd.
        await this.run(this.selectedArgs(qrcodeArgs(url), application), { cwd: directory });
        verifyQrcode(qrPath);
      } catch (failure) { throw qrcodeFailure(failure); }
      return this.publicFlow();
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
    try { return verifyQrcode(this.flow.qrPath); }
    catch (error) { throw new ServiceError(404, error.code === 'LARK_QRCODE_INVALID' ? '二维码格式无效' : '二维码尚不可用，请重试'); }
  }
  async complete(id) {
    if (!this.flow || this.flow.id !== id || this.flow.expires <= Date.now()) throw new ServiceError(409, '授权已过期，请重新发起绑定');
    if (this.completing) return this.completing;
    const flow = this.flow;
    this.completing = (async () => {
      for (;;) {
        try {
          const raw = await this.run(this.selectedArgs(['auth', 'login', '--device-code', flow.deviceCode, '--json'], flow.application), {
            timeoutMs: Math.min(900000, Math.max(15000, flow.expires - Date.now() + 5000)),
            onSpawn: (child) => { flow.child = child; },
          });
          const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (payload?.ok === false) throw Object.assign(new Error(payload?.error?.message || 'authorization failed'), { code: payload?.error?.code });
          break;
        } catch (failure) {
          // Some CLI versions return immediately while the user is still on
          // the Feishu consent page. Keep the flow alive and poll again.
          if (isAuthorizationPending(failure) && this.flow === flow && flow.expires > Date.now() + 2000) {
            flow.child = null;
            await new Promise(resolve => setTimeout(resolve, 1500));
            continue;
          }
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
