import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuPublisher, toBlocks } from '../server/providers/publisher.mjs';

const report = { title: '飞书验收报告', version: 1, markdown: '# 研究结论\n\n完整保留研究正文和引用 [S1]。', sources: [{ id:'S1',title:'官方来源', url:'https://example.com', excerpt:'这是公开来源的证据摘录内容。' }] };
function response(data) { return new Response(JSON.stringify({ code:0,data }), { status:200 }); }
test('AC-11 飞书分批写入失败后续写，复用文档和同一幂等 token', async () => {
  let creates = 0, attempt = 0, lastToken; const tokens = [];
  const p = new FeishuPublisher({ token:'test',folderToken:'folder',fetchImpl:async (url, options) => {
    if (url.endsWith('/documents')) { creates++; return response({ document:{ document_id:'doc-1' } }); }
    const token = new URL(url).searchParams.get('client_token'); tokens.push(token); lastToken = token;
    assert.equal(JSON.parse(options.body).index, -1); if (++attempt === 1) throw new Error('网络中断，服务端可能已写入'); return response({ children:[] });
  } });
  const task = { id:'task-1', report, publication:{ status:'publishing', writtenBlocks:0 } };
  const persist = value => { task.publication = { ...value }; };
  await assert.rejects(p.publish(task, persist, new AbortController().signal), /网络中断/); assert.equal(task.publication.documentId,'doc-1');
  const result = await p.publish(task,persist,new AbortController().signal); assert.equal(result.status,'published'); assert.equal(creates,1); assert.equal(tokens[0],lastToken); assert.ok(result.writtenBlocks > 0);
});
test('AC-12 创建响应丢失时通过唯一标题核对，不重复创建', async () => {
  let creates = 0, remoteTitle; const p = new FeishuPublisher({ token:'test', folderToken:'folder', fetchImpl: async (url, options) => {
    if (url.endsWith('/documents')) { creates++; remoteTitle = JSON.parse(options.body).title; throw new Error('响应丢失'); }
    if (url.includes('/drive/v1/files')) return response({ files:[{ type:'docx',name:remoteTitle,token:'reconciled-doc' }], has_more:false });
    return response({});
  } });
  const task = { id:'task-2',report,publication:{ status:'publishing' } }; const persist = value => task.publication = { ...value };
  await assert.rejects(p.publish(task,persist,new AbortController().signal),/响应丢失/);
  const result = await p.publish(task,persist,new AbortController().signal); assert.equal(creates,1); assert.equal(result.documentId,'reconciled-doc');
});
test('AC-13 未能核对创建结果时停止，禁止盲目新建', async () => {
  let creates=0; const p = new FeishuPublisher({token:'test',folderToken:'folder',fetchImpl:async url => { if (url.endsWith('/documents')) creates++; return response({files:[],has_more:false}); }});
  await assert.rejects(p.publish({id:'uncertain',report,publication:{createIntent:true}},()=>{},new AbortController().signal),/创建结果待核对/); assert.equal(creates,0);
});
test('AC-14 缺少授权不调用飞书；报告转换包括正文和来源', async () => {
  let called=false; const p=new FeishuPublisher({fetchImpl:async()=>{called=true;}});
  await assert.rejects(p.publish({id:'no-token',report,publication:{}},()=>{},new AbortController().signal),/请配置/); assert.equal(called,false);
  const blocks=toBlocks(report); assert.equal(blocks[0].block_type,3); assert.match(JSON.stringify(blocks),/https:\/\/example.com/);
});
