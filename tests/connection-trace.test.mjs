import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';
import { traceFor, withTrace, nativeDiagnostic, recordRuntimeStart, recordRuntimeStop, traceMiddleware } from '../server/connection-trace.mjs';

test('绑定HTTP、SDK、凭据保存及UI确认共用traceId，埋点不增加CLI验证请求', async () => {
  const f=fixture(),cli=applicationRunner(),sdk=registrationRunner(),traceId=randomUUID();
  const binding=new FeishuBinding({store:f.store,run:cli.run,registerApp:sdk.registerApp});f.service.binding=binding;
  const server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const post=(path,body,attempt=1)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Feishu-Trace-Id':traceId,'X-Feishu-Attempt':String(attempt),'X-Feishu-Action':'replace'},body:JSON.stringify(body)});
  try {
    const started=await post('/feishu-registration',{refresh:false});assert.equal(started.headers.get('x-feishu-trace-id'),traceId);
    sdk.approve('cli_trace123');await binding.registration.work;
    const flow=await (await post('/feishu-binding',{rebind:true})).json();
    const completed=await (await post('/feishu-binding/complete',{flowId:flow.flowId})).json();assert.equal(completed.bound,true);
    assert.equal((await post('/feishu-monitor/events',{traceId,attempt:1,action:'replace',event:'rendered',phase:'ui_sync',status:'bound',appId:'cli_trace123'})).status,204);
    const rows=f.store.runtimeLogs({limit:200,traceId});
    for(const event of ['feishu.http.received','feishu.flow.created','feishu.credentials.saved','feishu.application.selected','feishu.authorization.confirmed','feishu.ui.rendered'])assert.ok(rows.some(r=>r.event===event),event);
    assert.ok(rows.every(r=>r.details.traceId===traceId&&r.details.attempt===1));
    assert.ok(rows.every(r=>r.details.pluginVersion&&r.details.instanceId&&r.details.platform));
    assert.ok(!JSON.stringify(rows).includes('fixture-secret')); assert.ok(!JSON.stringify(rows).includes('private-device'));
    assert.equal(cli.calls.filter(c=>(c.args[0]==='--profile'?c.args.slice(2):c.args)[1]==='status').length,2);
    await post('/feishu-registration',{refresh:true},2);sdk.approve('cli_trace456');await binding.registration.work;
    assert.ok(f.store.runtimeLogs({limit:200,traceId}).some(r=>r.details.attempt===2));
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));binding.close();await f.close();}
});

test('并发异步调用的关联编号隔离，按trace筛选在分页前生效',async()=>{
  const f=fixture(),a=randomUUID(),b=randomUUID();
  try{
    await Promise.all([a,b].map(id=>withTrace(traceFor(id,1,'bind'),async()=>{await new Promise(r=>setTimeout(r,id===a?10:1));f.store.runtimeLog('feishu.test',{status:'completed'});})));
    assert.equal(f.store.runtimeLogs({traceId:a}).length,1);assert.equal(f.store.runtimeLogs({traceId:b}).length,1);
    assert.notEqual(f.store.runtimeLogs({traceId:a})[0].details.traceId,f.store.runtimeLogs({traceId:b})[0].details.traceId);
    assert.equal(f.store.runtimeLogs({traceId:a})[0].details.step,1);
  }finally{await f.close();}
});

test('前端事件严格过滤并限流；原生错误仅保留白名单代码与请求编号',async()=>{
  const f=fixture(),server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/api/feishu-monitor`,traceId=randomUUID();
  const body={traceId,attempt:1,action:'bind',event:'request_failed',phase:'frontend',status:'failed'};
  const send=value=>fetch(base+'/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  try{
    assert.equal((await send({...body,token:'SECRET'})).status,400);
    for(let i=0;i<65;i++)assert.equal((await send(body)).status,204);
    assert.equal(f.store.runtimeLogs({limit:200,traceId}).length,60);
    assert.equal((await fetch(base+'/logs?traceId=bad')).status,400);
    assert.deepEqual(nativeDiagnostic({stdout:JSON.stringify({code:99991672,log_id:'ABCD1234567890',secret:'SECRET'})}),{nativeCode:99991672,requestId:'ABCD1234567890'});
    assert.deepEqual(nativeDiagnostic({code:'private-secret',request_id:'SECRET'}),{});
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});

test('生命周期未正常关闭仅记录待确认；正常关闭有结束记录',async()=>{
  const f=fixture();try{
    recordRuntimeStart(f.store);recordRuntimeStart(f.store);
    assert.ok(f.store.runtimeLogs().some(r=>r.event==='runtime.previous_unconfirmed'&&r.details.status==='pending_confirmation'));
    recordRuntimeStop(f.store);assert.equal(f.store.setting('monitor-runtime-state').status,'stopped');
    assert.equal(f.store.runtimeLogs()[0].event,'runtime.stopped');
  }finally{await f.close();}
});

test('请求长时间未结束只记录待确认，不重复执行或终止业务',async t=>{
  const f=fixture();t.mock.timers.enable({apis:['setTimeout']});
  const response=new EventEmitter();response.setHeader=()=>{};response.statusCode=200;let executions=0;
  try {
    traceMiddleware(f.store)({path:'/api/feishu-binding/complete',method:'POST',headers:{}},response,()=>{executions++;});
    t.mock.timers.tick(20001);
    assert.equal(executions,1);assert.ok(f.store.runtimeLogs().some(r=>r.event==='feishu.http.pending'&&r.details.status==='pending_confirmation'));
    response.emit('finish');assert.equal(executions,1);
    assert.equal(f.store.runtimeLogs()[0].event,'feishu.http.finished');
  }finally{t.mock.timers.reset();await f.close();}
});
