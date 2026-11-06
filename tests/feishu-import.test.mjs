import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { importLibrary, library, libraryKey, libraryNamespaceKey, refreshLibrary } from '../server/industry.mjs';

const docUrl = name => `https://tenant.feishu.cn/docx/${name}`;
const root = { rootName: '行研工作台', folderUrl: 'https://tenant.feishu.cn/drive/folder/root123', folderToken: 'root123' };
const app = { profile: 'research-test' };
const company = (name, updatedAt = '2026-11-02T19:41:58+08:00') => ({
  name,
  url: docUrl(name === '后摩智能' ? 'HoumoDoc' : 'OtherDoc'),
  dimensions: ['技术路线'],
  added: 1,
  conflicts: 0,
  updatedAt,
});
function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-import-'));
  const store = new Store(join(dir, 'test.sqlite'));
  return { dir, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function runFor(filesByFolder, indexContent, expectedCommand = '/test/lark-cli') {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args });
      assert.equal(command, expectedCommand);
      if (args.includes('list')) {
        const folder = args[args.indexOf('--folder-token') + 1];
        const page = args.includes('--page-token') ? args[args.indexOf('--page-token') + 1] : '';
        const value = filesByFolder[folder + ':' + page];
        assert.ok(value, `unexpected folder listing ${folder}:${page}`);
        return { stdout: JSON.stringify({ ok: true, data: value }) };
      }
      if (args.includes('+fetch')) {
        return { stdout: JSON.stringify({ ok: true, data: { document: { content: indexContent } } }) };
      }
      throw new Error('unexpected write or command: ' + args.join(' '));
    },
  };
}

test('PRD4632 公司库以实际根目录隔离，同一目录改名不改变索引', () => {
  const before = libraryKey({ rootName: root.rootName }, app);
  assert.notEqual(libraryKey(root, app), before);
  assert.equal(libraryKey({ ...root, rootName: '另一个名字' }, app), libraryKey(root,app));
  assert.notEqual(libraryKey({...root,folderToken:'otherRoot'},app),libraryKey(root,app));
});

test('PRD4632 同名根目录切换后只显示新目录公司，旧任务与旧缓存保留',async()=>{
 const f=storeFixture();try{
  const old={...company('后摩智能','2099-01-01T00:00:00Z'),url:docUrl('OldHoumo'),taskId:'old-task'};
  f.store.saveSetting(libraryKey(root,app),{rootFolderToken:root.folderToken,folderToken:'oldLibrary',manifestUrl:docUrl('OldIndex'),companies:[old,company('旧公司')]});
  f.store.save({id:'old-task',createdAt:'2026-11-01T00:00:00Z',feishuRoot:root,feishuApp:app,industry:{companies:['后摩智能']},publication:{url:old.url}});
  const next={...root,folderToken:'root456',folderUrl:'https://tenant.feishu.cn/drive/folder/root456'};
  const imported={...company('后摩智能','2020-01-01T00:00:00Z'),url:docUrl('NewHoumo')};
  const mock=runFor({'root456:':{files:[{name:'全量信息库',token:'newLibrary',type:'folder'}],has_more:false},'newLibrary:':{files:[{name:'公司索引',type:'docx',url:docUrl('NewIndex')}],has_more:false}},JSON.stringify({companies:[imported]}));
  await importLibrary(f.store,next,app,mock.run,{command:'/test/lark-cli'});
  const current=library(f.store,next,app);assert.equal(current.companies.length,1);assert.equal(current.companies[0].url,imported.url);assert.equal(current.companies[0].taskId,undefined);
  assert.ok(mock.calls.every(c=>!c.args.includes('oldLibrary')&&!c.args.includes(docUrl('OldIndex'))));
  assert.equal(library(f.store,root,app).companies.length,2);assert.equal(f.store.get('old-task').publication.url,old.url);
 }finally{f.close();}
});

test('PRD4632 已有同名公司链接也以当前索引为准，不由旧文档更新时间决定',async()=>{
 const f=storeFixture();try{
  f.store.saveSetting(libraryKey(root,app),{folderToken:'library123',manifestUrl:docUrl('Index'),rootFolderToken:root.folderToken,companies:[{...company('后摩智能','2099-01-01T00:00:00Z'),url:docUrl('Old')},company('已移走公司')]});
  const expected={...company('后摩智能','2020-01-01T00:00:00Z'),url:docUrl('Current')};
  await importLibrary(f.store,root,app,runFor({},JSON.stringify({companies:[expected]})).run,{command:'/test/lark-cli'});
  assert.deepEqual(library(f.store,root,app).companies.map(c=>c.url),[expected.url]);
  f.store.saveSetting(libraryKey(root,app),{...library(f.store,root,app),companies:[{...expected,url:docUrl('Stale'),updatedAt:'2099-01-01T00:00:00Z'}]});
  await refreshLibrary(f.store,root,app,runFor({},JSON.stringify({companies:[expected]})).run,{command:'/test/lark-cli'});
  assert.equal(library(f.store,root,app).companies[0].url,expected.url);
 }finally{f.close();}
});

test('PRD4632 新根目录为空时清空当前视图，不回退旧公司目录或导入根目录杂项',async()=>{
 const f=storeFixture();try{
  f.store.saveSetting(libraryNamespaceKey(root,app),{rootFolderToken:'oldRoot',folderToken:'oldLibrary',manifestUrl:docUrl('OldIndex'),companies:[company('旧公司')]});
  const mock=runFor({'root123:':{files:[{name:'无关文档',type:'docx',url:docUrl('Unrelated')}],has_more:false}},null);
  const result=await importLibrary(f.store,root,app,mock.run,{command:'/test/lark-cli'});
  assert.equal(result.status,'empty');assert.deepEqual(library(f.store,root,app).companies,[]);assert.equal(library(f.store,root,app).folderToken,null);assert.equal(mock.calls.length,1);
 }finally{f.close();}
});

test('PRD4632 旧缓存仅在能证明根目录一致时迁移，不按同名猜测归属',()=>{
 const f=storeFixture();try{
  const legacy={rootFolderToken:root.folderToken,folderToken:'library123',manifestUrl:docUrl('KnownIndex'),companies:[company('后摩智能')]};
  f.store.saveSetting(libraryNamespaceKey(root,app),legacy);
  assert.equal(library(f.store,root,app).companies.length,1);assert.equal(f.store.setting(libraryKey(root,app)).rootFolderToken,root.folderToken);
  assert.equal(library(f.store,{...root,folderToken:'unknownRoot'},app).companies.length,0);
  f.store.saveSetting(libraryNamespaceKey(root,app),{folderToken:'unproven',manifestUrl:docUrl('UnprovenIndex'),companies:[company('旧公司')]});
  assert.equal(library(f.store,{...root,folderToken:'thirdRoot'},app).companies.length,0);
 }finally{f.close();}
});

test('PRD4632 旧版未记录根目录时根据唯一历史交付证明迁移',()=>{
 const f=storeFixture();try{
  const c=company('后摩智能');f.store.saveSetting(libraryNamespaceKey(root,app),{folderToken:'library123',companies:[c]});
  f.store.save({id:'old-delivery',createdAt:'2026-11-01T00:00:00Z',feishuRoot:root,feishuApp:app,publication:{url:c.url}});
  assert.equal(library(f.store,root,app).companies[0].url,c.url);
 }finally{f.close();}
});

test('PRD4632 同步中交付的新公司保留，不保留同步前已移走的公司',async()=>{
 const f=storeFixture();try{
  f.store.saveSetting(libraryKey(root,app),{folderToken:'library123',manifestUrl:docUrl('KnownIndex'),companies:[company('已移走公司')]});
  const run=async()=>{const saved=library(f.store,root,app);f.store.saveSetting(libraryKey(root,app),{...saved,companies:[...saved.companies,company('并行新公司')]});return{stdout:JSON.stringify({ok:true,data:{document:{content:JSON.stringify({companies:[company('后摩智能')]})}}})};};
  await importLibrary(f.store,root,app,run);
  assert.deepEqual(library(f.store,root,app).companies.map(c=>c.name),['后摩智能','并行新公司']);
 }finally{f.close();}
});

test('PRD4632 旧目录导入晚返回时API拒绝覆盖当前目录设置',async()=>{
 const f=fixture();let release,started;const gate=new Promise(r=>release=r),observed=new Promise(r=>started=r);
 const server=createApp(f.service,{libraryImportRun:async()=>{started();await gate;return{stdout:JSON.stringify({ok:true,data:{files:[],has_more:false}})};}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const pending=fetch(base+'/api/feishu-settings/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderUrl:root.folderUrl})});await observed;
  f.service.setFeishuSettings({folderUrl:'https://tenant.feishu.cn/drive/folder/newRoot'});release();
  assert.equal((await pending).status,409);assert.equal(f.service.feishuSettings().folderToken,'newRoot');assert.equal(library(f.store,f.service.feishuSettings()).companies.length,0);
 }finally{release();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});

test('PRD4632 不完整或异常目录响应不被当成空目录清除卡片',async()=>{
 const f=storeFixture();try{
  f.store.saveSetting(libraryKey(root,app),{folderToken:'library123',companies:[company('后摩智能')]});
  const before=library(f.store,root,app);
  for(const data of [{unexpected:true},{files:[],has_more:true,next_page_token:'repeat'}]){
   await assert.rejects(importLibrary(f.store,root,app,async()=>({stdout:JSON.stringify({ok:true,data})})),e=>['LIBRARY_TOO_LARGE','LIBRARY_INVALID_RESPONSE'].includes(e.code));
   assert.deepEqual(library(f.store,root,app),before);
  }
 }finally{f.close();}
});

test('保存并导入优先读取全量信息库和公司索引，支持分页且只读', async () => {
  const f = storeFixture();
  try {
    const indexUrl = docUrl('ManifestDoc');
    const files = {
      'root123:': { files: [{ name: '全量信息库', token: 'library123', type: 'folder', url: 'https://tenant.feishu.cn/drive/folder/library123' }], has_more: false },
      'library123:': { files: [{ name: '公司索引', token: 'manifest', type: 'docx', url: indexUrl }, { name: '友商分析', token: 'folder2', type: 'folder' }], has_more: true, next_page_token: 'lib-page-2' },
      'library123:lib-page-2': { files: [{ name: '后摩智能', token: 'company1', type: 'docx', url: docUrl('HoumoDoc') }, { name: '光羽芯辰', token: 'company2', type: 'docx', url: docUrl('OtherDoc') }], has_more: false },
    };
    const mock = runFor(files, JSON.stringify({ companies: [company('后摩智能'), company('光羽芯辰')] }));
    const result = await importLibrary(f.store, root, app, mock.run, { command: '/test/lark-cli' });
    assert.equal(result.status, 'completed');
    assert.equal(result.imported, 2);
    assert.equal(result.indexFound, true);
    assert.equal(result.libraryFolderFound, true);
    assert.equal(mock.calls.length, 4);
    assert.ok(mock.calls.some(call => call.args.includes('--page-token') && call.args.includes('lib-page-2')));
    assert.equal(mock.calls.some(call => call.args.includes('+fetch') && call.args.includes(indexUrl)), true);
    assert.equal(mock.calls.some(call => call.args.includes('create') || call.args.includes('upload') || call.args.includes('delete')), false);
    const saved = library(f.store, root, app);
    assert.equal(saved.folderToken, 'library123');
    assert.equal(saved.manifestUrl, indexUrl);
    assert.deepEqual(saved.companies.map(item => item.name), ['后摩智能', '光羽芯辰']);
  } finally { f.close(); }
});

test('已知公司索引时直接读取，不再要求云盘目录列表权限', async () => {
  const f = storeFixture();
  try {
    const indexUrl = docUrl('KnownManifest');
    f.store.saveSetting(libraryKey(root, app), {
      folderToken: 'library123',
      manifestUrl: indexUrl,
      rootFolderToken: root.folderToken,
      companies: [],
    });
    const calls = [];
    const run = async (command, args) => {
      calls.push({ command, args });
      assert.equal(command, '/test/lark-cli');
      assert.ok(args.includes('+fetch'));
      assert.equal(args.includes('list'), false);
      return { stdout: JSON.stringify({ ok: true, data: { document: { content: JSON.stringify({ companies: [company('后摩智能'), company('光羽芯辰')] }) } } }) };
    };
    const result = await importLibrary(f.store, root, app, run, { command: '/test/lark-cli' });
    assert.equal(result.status, 'completed');
    assert.equal(result.imported, 2);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes(indexUrl));
    assert.equal(library(f.store, root, app).companies.length, 2);
  } finally { f.close(); }
});

test('没有公司索引时按公司文档导入，排除系统目录并去重', async () => {
  const f = storeFixture();
  try {
    const files = {
      'root123:': { files: [{ name: '全量信息库', token: 'library123', type: 'folder', url: 'https://tenant.feishu.cn/drive/folder/library123' }], has_more: false },
      'library123:': { files: [
        { name: '后摩智能.docx', token: 'company1', type: 'docx', url: docUrl('HoumoDoc'), modified_time: '1700000000' },
        { name: '后摩智能', token: 'company1b', type: 'docx', url: docUrl('DuplicateName') },
        { name: '光羽芯辰', token: 'company2', type: 'docx', url: docUrl('OtherDoc'), modified_time: '1700000100' },
        { name: '日报', token: 'daily', type: 'folder' },
        { name: '内部资料', token: 'internal', type: 'docx', url: docUrl('InternalDoc') },
        { name: '分析报告索引', token: 'analysis-index', type: 'docx', url: docUrl('AnalysisIndex') },
      ], has_more: false },
    };
    const mock = runFor(files, null);
    const result = await importLibrary(f.store, root, app, mock.run, { command: '/test/lark-cli' });
    assert.equal(result.status, 'completed');
    assert.equal(result.imported, 2);
    assert.equal(result.indexFound, false);
    assert.equal(mock.calls.some(call => call.args.includes('+fetch')), false);
    const saved = library(f.store, root, app);
    assert.deepEqual(saved.companies.map(item => item.name), ['后摩智能', '光羽芯辰']);
    assert.deepEqual(saved.companies[0].dimensions, []);
    assert.equal(saved.companies[0].updatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(saved.companies[0].url, docUrl('HoumoDoc'));
  } finally { f.close(); }
});

test('根目录还没有 token 时保存成功但不读取飞书', async () => {
  const f = storeFixture();
  try {
    let calls = 0;
    const result = await importLibrary(f.store, { rootName: '尚未创建' }, app, async () => { calls++; });
    assert.equal(result.status, 'skipped');
    assert.equal(result.imported, 0);
    assert.equal(calls, 0);
    assert.match(result.message, /首次调研/);
  } finally { f.close(); }
});

test('保存并导入 API 返回设置、导入摘要和公司列表', async () => {
  const f = fixture(); const mock = runFor({
    'root123:': { files: [{ name: '全量信息库', token: 'library123', type: 'folder', url: 'https://tenant.feishu.cn/drive/folder/library123' }], has_more: false },
    'library123:': { files: [{ name: '公司索引', token: 'manifest', type: 'docx', url: docUrl('ManifestDoc') }], has_more: false },
  }, JSON.stringify({ companies: [company('后摩智能'), company('光羽芯辰')] }), 'lark-cli');
  const server = createApp(f.service, { libraryImportRun: mock.run }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/feishu-settings/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderUrl: root.folderUrl }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.settings.folderToken, 'root123');
    assert.equal(body.import.status, 'completed');
    assert.equal(body.import.imported, 2);
    assert.deepEqual(body.library.companies.map(item => item.name), ['后摩智能', '光羽芯辰']);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).feishuRoot.folderToken, 'root123');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('导入权限失败时设置仍保存，错误不泄露 CLI 输出', async () => {
  const f = fixture();
  const failure = Object.assign(new Error('command failed'), { stdout: '', stderr: 'missing_scope space:document:retrieve secret-must-not-leak' });
  const server = createApp(f.service, { libraryImportRun: async () => { throw failure; } }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/feishu-settings/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderUrl: root.folderUrl }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.settings.folderToken, 'root123');
    assert.equal(body.import.status, 'failed');
    assert.equal(body.import.code, 'FEISHU_DRIVE_SCOPE_REQUIRED');
    assert.ok(!JSON.stringify(body).includes('secret-must-not-leak'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); }
});


test('公司索引被删除后自动从飞书目录重新发现，导入与刷新均可恢复', async () => {
  const f = storeFixture();
  try {
    const oldIndex = docUrl('DeletedIndex');
    const newIndex = docUrl('RecoveredIndex');
    const seed = () => f.store.saveSetting(libraryKey(root, app), {
      folderToken: 'library123',
      manifestUrl: oldIndex,
      rootFolderToken: root.folderToken,
      companies: [company('后摩智能')],
    });
    const run = async (command, args) => {
      assert.equal(command, '/test/lark-cli');
      if (args.includes('list')) {
        const folder = args[args.indexOf('--folder-token') + 1];
        if (folder === 'root123') return { stdout: JSON.stringify({ ok: true, data: { files: [{ name: '全量信息库', token: 'library123', type: 'folder' }], has_more: false } }) };
        return { stdout: JSON.stringify({ ok: true, data: { files: [{ name: '公司索引', token: 'new-index', type: 'docx', url: newIndex }], has_more: false } }) };
      }
      if (args.includes(oldIndex)) return { stdout: JSON.stringify({ ok: false, error: { code: 3380003, msg: 'Document page has been deleted' } }) };
      if (args.includes(newIndex)) return { stdout: JSON.stringify({ ok: true, data: { document: { content: JSON.stringify({ companies: [company('后摩智能'), company('光羽芯辰')] }) } } }) };
      throw new Error('unexpected command: ' + args.join(' '));
    };

    seed();
    const imported = await importLibrary(f.store, root, app, run, { command: '/test/lark-cli' });
    assert.equal(imported.status, 'completed');
    assert.equal(imported.indexFound, true);
    assert.equal(library(f.store, root, app).manifestUrl, newIndex);
    assert.deepEqual(library(f.store, root, app).companies.map(item => item.name), ['后摩智能', '光羽芯辰']);

    seed();
    const refreshed = await refreshLibrary(f.store, root, app, run, { command: '/test/lark-cli' });
    assert.equal(refreshed.manifestUrl, newIndex);
    assert.equal(refreshed.companies.length, 2);
  } finally { f.close(); }
});
