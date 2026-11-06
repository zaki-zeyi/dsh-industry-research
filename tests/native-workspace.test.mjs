import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fixture} from './helpers.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {NativeSessions} from '../server/native-sessions.mjs';
const task=n=>({id:'task-'+n,prompt:'Test research',direction:'测试',sources:'web'});
function setup(){const f=fixture(),host=mockHost(),workRoot=resolve(f.dir,'sessions'),sessions=new NativeSessions(f.store,host,{workRoot});return{...f,host,workRoot,sessions,async finish(){sessions.close();await f.close();}};}
test('回归：并行会话创建显式传workspaceId并真正归入唯一插件工作区',async()=>{
 const f=setup();try{const metas=await Promise.all([1,2,3].map(n=>f.sessions.create(task(n))));const groups=f.host.workspaceRegistry.list();assert.equal(groups.length,1);assert.equal(groups[0].title,'dsh-industry-research');assert.equal(groups[0].sessionIds.length,3);assert.ok(metas.every(v=>v.workspaceId===groups[0].id));assert.ok(f.host.calls.filter(v=>v.kind==='create').every(v=>v.workspaceId===groups[0].id&&v.cwd===undefined));}finally{await f.finish();}
});
test('回归：插件重载恢复已有未分组会话和定时会话，不重复创建也不执行任务',async()=>{
 const f=setup();let reloaded;try{const first=await f.sessions.create(task(1)),w=f.host.workspaceRegistry.list()[0];const schedule=await f.host.sessionController.create({cwd:w.path});f.store.saveSetting('briefing-schedule',{sessionId:schedule.sessionId});w.sessionIds=[];const count=f.host.created;f.sessions.close();reloaded=new NativeSessions(f.store,f.host,{workRoot:f.workRoot});await reloaded.reconcileWorkspace();assert.equal(f.host.created,count);assert.equal(f.host.workspaceRegistry.list().length,1);assert.ok(w.sessionIds.includes(first.sessionId));assert.ok(w.sessionIds.includes(schedule.sessionId));assert.equal(f.host.calls.filter(v=>v.kind==='prompt').length,0);assert.equal(f.store.terminal(first.id).workspaceId,w.id);const next=await reloaded.create({...task(1),terminalId:first.id});assert.equal(next.sessionId,first.sessionId);assert.equal(f.host.created,count);}finally{reloaded?.close();await f.finish();}
});
test('回归：归组只处理插件记录，不移动用户会话，旧cwd不匹配时保留并记录原因',async()=>{
 const f=setup();try{const first=await f.sessions.create(task(1)),w=f.host.workspaceRegistry.list()[0];const user=await f.host.sessionController.create({cwd:'/other/user'});w.sessionIds=[];f.host.sessionCwds.set(first.sessionId,'/legacy/incompatible');await f.sessions.reconcileWorkspace();assert.ok(!w.sessionIds.includes(user.sessionId));assert.ok(!w.sessionIds.includes(first.sessionId));assert.ok(f.store.terminal(first.id).workspaceBindingError);assert.deepEqual(f.sessions.workspaceState().unboundSessionIds,[first.sessionId]);assert.equal(f.host.created,2);}finally{await f.finish();}
});
test('回归：宿主缺少工作区能力时失败关闭，不回退创建未分组会话',async()=>{
 const f=setup();try{delete f.host.workspaceRegistry;await assert.rejects(f.sessions.create(task(1)),/工作区/);assert.equal(f.host.created,0);}finally{await f.finish();}
});

test('PRD4549 升级原地更名插件工作区，保留 ID、目录、历史与定时会话',async()=>{
 const f=setup();let reloaded;
 try {
  const first=await f.sessions.create(task(1)), workspace=f.host.workspaceRegistry.list()[0];
  await workspace.setTitle('行研工作台');
  const scheduled=await f.host.sessionController.create({workspaceId:workspace.id,agentPreset:'standard'});
  f.store.saveSetting('briefing-schedule',{sessionId:scheduled.sessionId});
  const before={id:workspace.id,path:workspace.path,sessions:[...workspace.sessionIds]};
  f.sessions.close();reloaded=new NativeSessions(f.store,f.host,{workRoot:f.workRoot});
  await Promise.all([reloaded.reconcileWorkspace(),reloaded.workspace()]);
  assert.equal(workspace.title,'dsh-industry-research');assert.equal(workspace.id,before.id);assert.equal(workspace.path,before.path);
  assert.deepEqual(workspace.sessionIds,before.sessions);assert.equal(f.host.workspaceRegistry.list().length,1);
  assert.equal(f.host.calls.filter(v=>v.kind==='prompt').length,0);
  assert.equal(reloaded.get(first.id).sessionId,first.sessionId);
  assert.equal(f.store.setting('native-workspace').title,'dsh-industry-research');
 }finally{reloaded?.close();await f.finish();}
});

test('PRD4549 更名失败不新建替代工作区或丢失历史，下次可重试',async()=>{
 const f=setup();
 try {
  const w=await f.host.workspaceRegistry.create(resolve(f.workRoot,'workspace'),'行研工作台');
  const rename=w.setTitle;w.setTitle=async()=>{throw Error('disk failure');};
  await assert.rejects(f.sessions.workspace(),/disk failure/);assert.equal(f.host.created,0);assert.equal(f.host.workspaceRegistry.list().length,1);
  w.setTitle=rename;assert.equal((await f.sessions.workspace()).id,w.id);assert.equal(w.title,'dsh-industry-research');
 }finally{await f.finish();}
});
