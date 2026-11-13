import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';

test('PRD1742 飞书根目录默认值、校验、持久化和本机 API', async () => {
  const f = fixture(); const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/feishu-settings`)).json(), { rootName: '行研工作台' });
    for (const body of [{ rootName: ' ' }, { rootName: 'a\nb' }, { rootName: 'a'.repeat(101) }, { rootName: '目录', token: 'not-allowed' }]) {
      assert.equal((await fetch(`${base}/api/feishu-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    }
    const response = await fetch(`${base}/api/feishu-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rootName: '  行业研究  ' }) });
    assert.deepEqual(await response.json(), { rootName: '行业研究' });
    assert.equal((await (await fetch(`${base}/api/config`)).json()).feishuRoot.rootName, '行业研究');
    const reopened = new Store(f.path); try { assert.equal(reopened.setting('feishu').rootName, '行业研究'); } finally { reopened.close(); }
    const blocked = await fetch(`${base}/api/feishu-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ rootName: '恶意修改' }) });
    assert.equal(blocked.status, 403); assert.equal(f.service.feishuSettings().rootName, '行业研究');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); }
});

test('PRD1915 文件夹链接解析、安全校验、持久化与任务目录快照', async () => {
  const f = fixture(); try {
    for (const folderUrl of ['http://a.feishu.cn/drive/folder/token', 'https://evil.example/drive/folder/token', 'https://a.feishu.cn.evil.example/drive/folder/token', 'https://user:password@a.feishu.cn/drive/folder/token', 'https://a.feishu.cn/docx/token', 'https://a.feishu.cn/wiki/token', 'https://a.feishu.cn:8443/drive/folder/token', 'https://a.feishu.cn/drive/folder/a%2fb']) assert.throws(() => f.service.setFeishuSettings({ rootName: '目录', folderUrl }));
    const folderUrl = 'https://tenant.feishu.cn/drive/folder/folderOne123?from=share';
    assert.equal(f.service.setFeishuSettings({ rootName: '直接保存', folderUrl }).folderToken, 'folderOne123');
    const task = f.service.create({ direction: '文件夹固定验收' });
    f.service.setFeishuSettings({ rootName: '另一批', folderUrl: 'https://tenant.feishu.cn/drive/folder/folderTwo456' });
    assert.equal(f.store.get(task.id).feishuRoot.folderToken, 'folderOne123');
    const reopened = new Store(f.path); try { assert.equal(reopened.setting('feishu').folderToken, 'folderTwo456'); } finally { reopened.close(); }
    assert.equal(f.service.setFeishuSettings({ rootName: '未指定', folderUrl: ' ' }).folderToken, undefined);
    assert.throws(() => f.service.setFeishuSettings({ rootName: '伪造', folderToken: 'injected' }));
  } finally { await f.close(); }
});

test('PRD1939 根目录名字与链接二选一，链接模式无需名字且Prompt准确，切回名字清除链接', async () => {
  const f = fixture(); const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const folderUrl = 'https://tenant.feishu.cn/drive/folder/linkOnly123';
    const response = await fetch(base+'/api/feishu-settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({folderUrl}) });
    assert.equal(response.status,200);const settings=await response.json();assert.equal(settings.folderToken,'linkOnly123');
    const config=await(await fetch(base+'/api/config')).json();assert.equal(config.feishuTarget,'飞书云盘 / 指定文件夹');
    const task=f.service.create({direction:'仅填写链接验收'});assert.equal(task.feishuRoot.folderToken,'linkOnly123');assert.match(task.prompt,/指定飞书文件夹【https:\/\/tenant.feishu.cn\/drive\/folder\/linkOnly123】/);
    f.service.setFeishuSettings({rootName:'新的名字'});assert.equal(f.service.feishuSettings().folderUrl,undefined);assert.equal(f.service.feishuSettings().folderToken,undefined);
    const next=f.service.create({direction:'切回名字验收'});assert.match(next.prompt,/根目录【新的名字】/);assert.ok(!next.prompt.includes('linkOnly123'));assert.equal(f.store.get(task.id).feishuRoot.folderToken,'linkOnly123');
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); await f.close(); }
});
