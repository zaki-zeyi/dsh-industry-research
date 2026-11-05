import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { importLibrary, library, libraryKey } from '../server/industry.mjs';

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

test('补充或切换根目录链接不会改变公司库索引，已有公司不会消失', () => {
  const before = libraryKey({ rootName: root.rootName }, app);
  assert.equal(libraryKey(root, app), before);
  assert.notEqual(libraryKey({ ...root, rootName: '另一个根目录' }, app), before);
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
