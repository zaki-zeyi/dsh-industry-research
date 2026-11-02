import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { waitCloudDelivery, RESEARCH_TIMEOUT_MS } from '../server/cloud-research.mjs';
import { NativeResearcher, NativeSessions } from '../server/native-sessions.mjs';
import { fixture } from './helpers.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
function deliveryFixture(){const dir=mkdtempSync(resolve(tmpdir(),'research-deadline-'));const meta={id:randomUUID(),deliveryRequestId:randomUUID(),deliveryPath:resolve(dir,'receipt.json')};return{meta,dir,close(){rmSync(dir,{recursive:true,force:true});}};}
test('PRD169 标准调研上限为30分钟，20分钟内交付不因旧10分钟上限失败',async()=>{
 assert.equal(RESEARCH_TIMEOUT_MS,1800000);assert.equal(new NativeResearcher({}).timeoutMs,1800000);
 const f=deliveryFixture();let elapsed=0,cancelled=0;const sessions={get:()=>({activity:elapsed>=1200000?'waiting_input':'working'}),cancel(){cancelled++;}};
 try{const result=await waitCloudDelivery(sessions,f.meta,{signal:new AbortController().signal,now:()=>elapsed,pause:async()=>{elapsed+=600000;if(elapsed===1200000)writeFileSync(f.meta.deliveryPath,JSON.stringify({requestId:f.meta.deliveryRequestId,status:'published',folderToken:'folder',url:'https://example.feishu.cn/docx/Done'}));}});assert.equal(result.cloudDelivery.status,'published');assert.equal(elapsed,1200000);assert.equal(cancelled,0);}finally{f.close();}
});
test('PRD169 30分钟整仍等待，超过30分钟才失败并停止当前轮次',async()=>{
 const f=deliveryFixture();let elapsed=0,cancelled=0,atBoundary=false;const sessions={get:()=>({activity:'working'}),cancel(){cancelled++;}};
 try{await assert.rejects(waitCloudDelivery(sessions,f.meta,{signal:new AbortController().signal,now:()=>elapsed,pause:async()=>{if(elapsed===1800000){atBoundary=true;assert.equal(cancelled,0);elapsed++;}else elapsed+=600000;}}),/超过 30 分钟/);assert.equal(atBoundary,true);assert.equal(cancelled,1);}finally{f.close();}
});
test('重发指令先清除上一轮完成时间，不把继续会话误判成已结束',async()=>{
 const f=fixture(),host=mockHost(),sessions=new NativeSessions(f.store,host,{workRoot:resolve(f.dir,'sessions')});
 try{const task={id:randomUUID()},meta=await sessions.create(task);meta.lastTurnCompletedAt='2026-11-02T00:00:00Z';meta.lastTurnReason='completed';f.store.saveTerminal(meta);host.sessionController.prompt=async()=>({accepted:true});await sessions.send(meta.id,'继续处理已有资料');assert.equal(sessions.get(meta.id).lastTurnCompletedAt,null);assert.equal(sessions.get(meta.id).activity,'working');}finally{sessions.close();await f.close();}
});
