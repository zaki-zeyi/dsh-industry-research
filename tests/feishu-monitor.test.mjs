import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
import { createApp } from '../server/app.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';

test('飞书监测：重复应用错误保留原异常，记录存储阶段和耗时，过滤全部凭据及原始输出', async () => {
  const f = fixture(), error = Object.assign(new Error('each profile must have a unique app-id; SECRET'), { stderr: 'access_token=TOKEN' });
  const b = new FeishuBinding({ store: f.store, run: async () => { throw error; } });
  try {
    await assert.rejects(b.run(['profile','add','--app-id','cli_test123'], { input: 'SECRET\n' }), e => e === error);
    const row = f.store.runtimeLogs()[0];
    assert.equal(row.details.phase, 'credential_storage'); assert.equal(row.details.code, 'PROFILE_CONFLICT');
    assert.equal(typeof row.details.durationMs, 'number'); assert.ok(row.details.operationId);
    assert.ok(!JSON.stringify(f.store.runtimeLogs()).includes('SECRET')); assert.ok(!JSON.stringify(f.store.runtimeLogs()).includes('TOKEN'));
  } finally { b.close(); await f.close(); }
});

test('飞书监测：SDK登记异常不会被原版通用错误吞掉诊断阶段', async () => {
  const f = fixture(), cli = applicationRunner();
  const b = new FeishuBinding({ store: f.store, run: cli.run, registerApp: async () => { throw Object.assign(new Error('fetch failed SECRET'), { code: 'ECONNRESET' }); } });
  try {
    b.registration.start(); await b.registration.work;
    assert.equal(b.registration.snapshot().status, 'failed');
    const row = f.store.runtimeLogs()[0]; assert.equal(row.details.phase, 'app_registration'); assert.equal(row.details.code, 'NETWORK_ERROR');
    assert.ok(!JSON.stringify(row).includes('SECRET'));
  } finally { b.close(); await f.close(); }
});

test('飞书监测：检测只读并合并并发，区分账号、权限和机器人身份异常', async () => {
  const f = fixture(); let calls = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  f.store.saveSetting('feishu-application', { mode: 'custom', appId: 'cli_test123', profile: 'research-test', ownerOpenId: 'ou_expected' });
  const before = f.store.setting('feishu-application');
  const b = new FeishuBinding({ store: f.store, run: async args => {
    calls++; assert.deepEqual(args, ['--profile','research-test','auth','status','--json','--verify']); await wait;
    return { appId: 'cli_test123', identities: { user: { available: true, verified: true, openId: 'ou_other', scope: '' }, bot: { available: false } } };
  } });
  try {
    const a = b.connectionMonitor.check(), c = b.connectionMonitor.check(); release();
    const [result, other] = await Promise.all([a,c]); assert.deepEqual(result,other); assert.equal(calls,1);
    assert.equal(result.status,'error'); assert.equal(result.missingScopes.length,requiredScopes.length);
    assert.ok(result.checks.some(c=>c.code==='ACCOUNT_MISMATCH')); assert.ok(result.checks.some(c=>c.code==='BOT_NOT_READY'));
    assert.deepEqual(f.store.setting('feishu-application'),before); assert.ok(!JSON.stringify(result).includes('ou_other'));
  } finally { b.close(); await f.close(); }
});

test('飞书监测：过滤在数据库分页前执行，API无缓存并校验参数', async () => {
  const f = fixture();
  f.store.runtimeLog('feishu.connection.failed',{code:'TIMEOUT'},'error');
  for (let i=0;i<150;i++) f.store.runtimeLog('runtime.started');
  f.store.runtimeLog('feishu.connection.finished',{code:'OK'});
  f.service.binding = new FeishuBinding({ store:f.store, run:async()=>{ throw Object.assign(new Error('missing'),{code:'ENOENT'}); } });
  const server=createApp(f.service).listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/api/feishu-monitor`;
  try {
    const response=await fetch(base+'/logs?level=error&limit=1'); assert.equal(response.headers.get('cache-control'),'no-store');
    const {items}=await response.json(); assert.equal(items.length,1); assert.equal(items[0].details.code,'TIMEOUT');
    assert.equal((await fetch(base+'/logs?level=bad')).status,400);
    const result=await (await fetch(base+'/check',{method:'POST'})).json(); assert.equal(result.checks[0].code,'CLI_NOT_FOUND');
    const cross=await fetch(base+'/check',{method:'POST',headers:{Origin:'https://evil.example'}}); assert.equal(cross.status,403);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); f.service.binding.close(); await f.close(); }
});

test('飞书监测：正常操作不受日志服务故障影响', async () => {
  const f=fixture(), cli=applicationRunner(), sdk=registrationRunner();
  const b=new FeishuBinding({store:f.store,run:cli.run,registerApp:sdk.registerApp});
  f.store.runtimeLog=()=>{throw new Error('database unavailable');};
  try { assert.equal((await b.status()).bound,true); b.registration.start(); sdk.approve(); await b.registration.work; assert.equal(b.registration.snapshot().status,'completed'); }
  finally {b.close();await f.close();}
});
