import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.mjs';
import {topicTask, topicScope, topicDeletionKey} from '../server/topics.mjs';
import {fixture} from './helpers.mjs';

test('一键重试只向现有队列提交当前范围的失败专题日报，并返回未提交原因', async () => {
  const f = fixture(), {service,store} = f;
  const root = service.feishuSettings(), scope = topicScope(root);
  service.drain = () => {}; // Observe the real queue without executing research.
  const server = createApp(service).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const retry = requestedScope => fetch(`http://127.0.0.1:${server.address().port}/api/topics/retry-failed-dailies`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({scope:requestedScope}),
  });
  const create = (question, {status='failed', date='2026-11-22T01:00:00Z', feishuRoot=root, feishuApp, topicId=randomUUID()}={}) => {
    const task = {
      ...topicTask({topicId,question,sources:['公司官网']},date),
      id:randomUUID(), status, stage:'research', feishuRoot, feishuApp, createdAt:new Date().toISOString(),
      publication:{status:'pending'}, runs:[],
    };
    return store.save(task);
  };
  try {
    const a = create('专题甲'), b = create('专题乙');
    const busy = create('状态尚在收尾的日报');
    service.active.set(busy.id,{controller:new AbortController()});
    const otherRoot = create('其他目录的日报',{feishuRoot:{rootName:'其他目录'}});
    const otherUser = create('其他账号的日报',{feishuApp:{ownerOpenId:'ou_other'}});
    const done = create('已完成的日报',{status:'ready'});
    const interrupted = create('用户中断的日报',{status:'interrupted'});
    const total = create('失败的总报',{date:null});
    const deleting = create('正在回收的专题');
    store.saveSetting(topicDeletionKey(root,undefined,deleting.topic.topicId),{status:'pending'});

    assert.equal((await retry('outdated-scope')).status,409);
    assert.equal(service.queue.length,0);
    const results = await Promise.all([retry(scope),retry(scope)]);
    const responses = await Promise.all(results.map(response=>response.json()));
    assert.deepEqual(results.map(response=>response.status).sort(),[200,202]);
    assert.equal(responses[0].accepted+responses[1].accepted,2);
    assert.ok(responses.every(r=>r.rejected.length===1&&r.rejected[0].id===busy.id&&/正在执行/.test(r.rejected[0].error)));
    assert.deepEqual(new Set(service.queue.map(job=>job.id)),new Set([a.id,b.id]));
    assert.equal(service.queue.length,2);
    for (const task of [a,b]) {
      const saved = service.require(task.id);
      assert.equal(saved.status,'queued');
      assert.deepEqual(saved.topic.window,task.topic.window);
    }
    for (const task of [total,otherRoot,otherUser,done,interrupted,deleting]) {
      assert.equal(service.require(task.id).status,task.status);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    await f.close();
  }
});
