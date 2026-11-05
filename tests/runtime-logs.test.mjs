import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';

test('平台日志保留1000条，白名单过滤敏感字段并支持按游标读取', async () => {
  const f=fixture();
  try {
    f.store.runtimeLog('feishu.registration.failed',{appId:'cli_test123',code:'ETIMEDOUT',appSecret:'private-secret',token:'private-token',authorizationUrl:'https://example.com/?secret=private-secret'},'error');
    const initial=f.store.runtimeLogs()[0]; assert.equal(initial.level,'error');
    assert.equal(initial.details.appId,'cli_test123');assert.equal(initial.details.code,'ETIMEDOUT');assert.ok(initial.details.instanceId);assert.ok(initial.details.pluginVersion);assert.ok(!JSON.stringify(initial).includes('private-secret'));assert.ok(!JSON.stringify(initial).includes('private-token'));
    for(let i=0;i<1002;i++)f.store.runtimeLog('runtime.started',{attempt:i});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM runtime_logs').get().n,1000);
    const page=f.store.runtimeLogs({limit:20}),next=f.store.runtimeLogs({limit:20,before:page.at(-1).seq});
    assert.equal(page.length,20);assert.ok(next[0].seq<page.at(-1).seq);
  }finally{await f.close();}
});
test('平台日志接口返回结构化事件且拒绝无效分页参数',async()=>{
  const f=fixture();f.store.runtimeLog('feishu.application.validation_failed',{targetAppId:'cli_new123',previousAppId:'cli_old123',code:'LARK_STABLE_IDENTITY_REQUIRED'},'error');
  const server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{const base=`http://127.0.0.1:${server.address().port}/api/runtime-logs`;
    const response=await fetch(base+'?limit=10');assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.equal(body.items[0].details.targetAppId,'cli_new123');
    assert.equal((await fetch(base+'?limit=999')).status,400);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});
