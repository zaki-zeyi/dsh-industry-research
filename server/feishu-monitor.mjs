import { randomUUID } from 'node:crypto';
import { traceContext, nativeDiagnostic } from './connection-trace.mjs';

export function classifyFeishuError(error) {
  const text = [error?.code, error?.message, error?.stdout, error?.stderr, error?.cause?.message].filter(Boolean).join('\n');
  if (/unique app-id|already used by profile|already exists/i.test(text)) return 'PROFILE_CONFLICT';
  if (/DPoP|0x80090016|keychain|keystore|key unavailable/i.test(text)) return 'LOCAL_KEY_UNAVAILABLE';
  if (/ENOENT|找不到.*CLI|not recognized|not found/i.test(text)) return 'CLI_NOT_FOUND';
  if (/EACCES|EPERM|access.*denied.*file|安全存储/i.test(text)) return 'LOCAL_STORAGE_DENIED';
  if (/scope|99991672|99991679|permission|forbidden/i.test(text)) return 'PERMISSION_DENIED';
  if (/ETIMEDOUT|timeout|timed out|killed/i.test(text) || error?.killed) return 'TIMEOUT';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|TLS|certificate/i.test(text)) return 'NETWORK_ERROR';
  if (/\b50[0234]\b|service unavailable|server error/i.test(text)) return 'REMOTE_SERVICE_ERROR';
  if (/expired_token|token.*expired|invalid.*token/i.test(text)) return 'AUTH_EXPIRED';
  if (/access_denied|cancel|abort/i.test(text)) return 'CANCELLED';
  return 'UNKNOWN_ERROR';
}

function stage(args) {
  const command = args[0] === '--profile' ? args.slice(2) : args;
  if (command[0] === 'profile' && command[1] === 'add' || command[0] === 'config' && command[1] === 'init') return 'credential_storage';
  if (command[0] === 'auth' && command[1] === 'qrcode') return 'qr_generation';
  if (command[0] === 'auth' && command[1] === 'status') return 'identity_check';
  if (command[0] === 'auth' && command[1] === 'login') return command.includes('--device-code') ? 'authorization_confirm' : 'authorization_start';
  if (command[0] === 'im') return 'bot_message';
  return 'cli_request';
}

export function installFeishuMonitor(binding) {
  const log = (event, details, level = 'info') => { try { binding.store?.runtimeLog(event, details, level); } catch {} };
  const run = binding.run;
  let lastIdentity = '';
  binding.run = async (args, options) => {
    const phase = stage(args), operationId = randomUUID(), started = Date.now();
    const profile = args[0] === '--profile' ? args[1] : args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined;
    const appId = args.includes('--app-id') ? args[args.indexOf('--app-id') + 1] : undefined;
    if (phase !== 'identity_check') log('feishu.connection.started', { phase, operationId, profile, appId });
    try {
      const raw = await run(args, options);
      let value; try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
      const rejected = value?.ok === false || (typeof value?.code === 'number' && value.code !== 0);
      let code = rejected ? classifyFeishuError({ message: JSON.stringify(value) }) : 'OK';
      if (!rejected && phase === 'identity_check') {
        const user = value?.identities?.user;
        if (!value?.appId) code = 'APP_MISMATCH_OR_MISSING';
        else if (classifyFeishuError({ message: JSON.stringify(value) }) === 'LOCAL_KEY_UNAVAILABLE') code = 'LOCAL_KEY_UNAVAILABLE';
        else if (user?.available !== true || user?.verified !== true) code = 'USER_AUTH_REQUIRED';
        else if (binding.scopes.filter(scope=>!binding.optionalScopes?.includes(scope)).some(scope => !new Set(String(user.scope ?? '').split(/[ ,]+/)).has(scope))) code = 'SCOPE_MISSING';
      }
      const signature = JSON.stringify([traceContext()?.traceId, profile, value?.appId, value?.dpopKeyStatus, value?.identities, code]);
      if (phase !== 'identity_check' || signature !== lastIdentity) {
        log('feishu.connection.finished', { phase, operationId, profile, durationMs: Date.now() - started, code, ...nativeDiagnostic(value), status: rejected ? 'failed' : code !== 'OK' ? 'attention' : 'completed', appId: value?.appId }, rejected ? 'error' : code !== 'OK' ? 'warn' : 'info');
        if (phase === 'identity_check') lastIdentity = signature;
      }
      return raw;
    } catch (error) {
      log('feishu.connection.failed', { phase, operationId, profile, appId, durationMs: Date.now() - started, code: classifyFeishuError(error), ...nativeDiagnostic(error) }, 'error');
      throw error;
    }
  };
  const status = binding.status;
  let lastBinding = '';
  binding.status = async (...args) => {
    const result = await status.apply(binding, args);
    const code = result.bound ? 'OK' : /账号.*不一致/.test(result.error ?? '') ? 'ACCOUNT_MISMATCH' : /应用.*不一致/.test(result.error ?? '') ? 'APP_MISMATCH_OR_MISSING' : result.missingScopes?.length ? 'SCOPE_MISSING' : result.available === false ? 'CLI_CHECK_FAILED' : 'USER_AUTH_REQUIRED';
    const signature = JSON.stringify([traceContext()?.traceId,result.appId, code]);
    if (signature !== lastBinding) {
      log('feishu.monitor.check', { phase: 'binding_validation', appId: result.appId, code, status: result.bound ? 'ok' : 'error' }, result.bound ? 'info' : 'warn');
      lastBinding = signature;
    }
    return result;
  };
  const register = binding.registration.registerApp;
  binding.registration.registerApp = async options => {
    const operationId = randomUUID(), started = Date.now();
    log('feishu.connection.started', { phase: 'app_registration', operationId });
    try {
      const result = await register(options);
      log('feishu.connection.finished', { phase: 'app_registration', operationId, appId: result?.client_id, code: 'OK', status: 'completed', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      log('feishu.connection.failed', { phase: 'app_registration', operationId, code: classifyFeishuError(error), ...nativeDiagnostic(error), durationMs: Date.now() - started }, 'error');
      throw error;
    }
  };
  let checking;
  binding.connectionMonitor = {
    check() {
      if (checking) return checking;
      checking = (async () => {
        const started = Date.now(), operationId = randomUUID(), checks = [];
        try {
          const app = binding.applicationSnapshot();
          const result = await binding.json(['auth', 'status', '--json', '--verify'], app);
          if (result?.ok === false || (typeof result?.code === 'number' && result.code !== 0)) throw new Error(JSON.stringify(result));
          const user = result?.identities?.user, bot = result?.identities?.bot;
          const scopes = new Set(String(user?.scope ?? '').split(/[ ,]+/));
          const missing = binding.scopes.filter(s => !binding.optionalScopes?.includes(s) && !scopes.has(s));
          const add = (phase, ok, code) => checks.push({ phase, status: ok ? 'ok' : 'error', code: ok ? 'OK' : code });
          add('application', Boolean(result?.appId) && (app.mode !== 'custom' || result.appId === app.appId), 'APP_MISMATCH_OR_MISSING');
          const key = String(result?.dpopKeyStatus ?? '').toLowerCase();
          if (key) add('local_key', ['available', 'ready', 'present'].includes(key), 'LOCAL_KEY_UNAVAILABLE');
          add('user_authorization', user?.available === true && user?.verified === true, 'USER_AUTH_REQUIRED');
          add('document_permissions', missing.length === 0, 'SCOPE_MISSING');
          if (app.ownerOpenId) add('account', user?.openId === app.ownerOpenId, 'ACCOUNT_MISMATCH');
          add('bot_identity', bot?.available === true && bot?.verified === true, 'BOT_NOT_READY');
          const snapshot = { checkedAt: new Date().toISOString(), durationMs: Date.now() - started, appId: result?.appId, checks, missingScopes: missing, status: checks.every(c => c.status === 'ok') ? 'ok' : 'error' };
          for (const c of checks) log('feishu.monitor.check', { operationId, phase: c.phase, code: c.code, status: c.status, appId: snapshot.appId, durationMs: snapshot.durationMs }, c.status === 'ok' ? 'info' : 'warn');
          return snapshot;
        } catch (error) {
          const code = classifyFeishuError(error);
          log('feishu.monitor.check', { operationId, phase: 'identity_check', code, status: 'error', durationMs: Date.now() - started }, 'error');
          return { checkedAt: new Date().toISOString(), durationMs: Date.now() - started, status: 'error', checks: [{ phase: 'identity_check', status: 'error', code }] };
        }
      })().finally(() => { checking = null; });
      return checking;
    },
  };
}
