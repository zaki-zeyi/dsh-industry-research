import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { FeishuDirectories } from '../server/feishu-directories.mjs';
import { CloudWrites } from '../server/cloud-writes.mjs';
import { analysisKey, refreshAnalysisLibrary } from '../server/analysis.mjs';
import { importLibrary, library, libraryKey } from '../server/industry.mjs';
import { cloudPrompt } from '../server/cloud-research.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { briefingTask, briefingKey } from '../server/briefings.mjs';
import { folderCacheKey } from '../server/feishu-folder.mjs';
import { until } from './helpers.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const folder = (name, token) => ({ name, token, type: 'folder' });
const document = (name, token) => ({ name, token, type: 'docx', url: `https://tenant.feishu.cn/docx/${token}` });
const app = { profile: 'selected', appId: 'cli_selected' };
const root = () => ({ rootName: '行研工作台', folderToken: 'Root' });
const task = extra => ({ id: 'task1', terminalId: 'terminal1', status: 'running', feishuRoot: root(), feishuApp: app, ...extra });
function fixture(files = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'unique-folders-')), store = new Store(resolve(dir, 'data.sqlite'));
  const calls = [], pages = new Map(Object.entries(files)); let created = 0;
  const run = async (command, args) => {
    assert.equal(command, '/mock/lark-cli');
    assert.equal(args[0], '--profile'); calls.push(args);
    if (args.includes('list')) {
      const parent = args[args.indexOf('--folder-token') + 1];
      const page = args.includes('--page-token') ? ':' + args[args.indexOf('--page-token') + 1] : '';
      const value = pages.get(parent + page) ?? [];
      if (value instanceof Error) throw value;
      return { stdout: JSON.stringify({ ok: true, data: Array.isArray(value) ? { files: value, has_more: false } : value }) };
    }
    if (args.includes('+create-folder')) {
      const parent = args.includes('--folder-token') ? args[args.indexOf('--folder-token') + 1] : '';
      const name = args[args.indexOf('--name') + 1], token = 'Created' + ++created;
      pages.set(parent, [...(pages.get(parent) ?? []), folder(name, token)]); pages.set(token, []);
      return { stdout: JSON.stringify({ ok: true, data: { folder_token: token } }) };
    }
    if (args.includes('+fetch')) return { stdout: JSON.stringify({ ok: true, data: { document: { content: '{"companies":[]}' } } }) };
    throw Error('Unexpected CLI operation');
  };
  const directories = new FeishuDirectories(store, { run, command: '/mock/lark-cli' });
  return { store, dir, run, calls, pages, directories, creates: () => calls.filter(a => a.includes('+create-folder')), close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('无本机缓存时复用别人创建的同名日报、周报与友商目录，索引也复用', async () => {
  const f = fixture({ Root: [folder('全量信息库', 'Library'), folder('日报', 'Daily'), folder('周报', 'Weekly'), folder('友商分析', 'Analysis')], Analysis: [document('分析报告索引', 'AnalysisIndex')] });
  try {
    for (const kind of ['daily', 'weekly']) {
      const t = task({ briefing: { kind } }); await f.directories.prepare(t);
      assert.equal(t.briefingLibrary.folderToken, kind === 'daily' ? 'Daily' : 'Weekly');
    }
    const t = task({ analysis: {} }); await f.directories.prepare(t);
    assert.equal(t.analysisIndex.folderToken, 'Analysis'); assert.match(t.analysisIndex.manifestUrl, /AnalysisIndex$/);
    assert.equal(f.creates().length, 0);
  } finally { f.close(); }
});

test('默认根目录已存在时先查再复用，不因本机第一次运行而重建', async () => {
  const f = fixture({ '': [folder('行研工作台', 'ExistingRoot')] });
  try {
    const t = task({ feishuRoot: { rootName: '行研工作台' } }); await f.directories.prepare(t);
    assert.equal(t.feishuRoot.folderToken, 'ExistingRoot'); assert.equal(f.creates().length, 0);
  } finally { f.close(); }
});

test('升级前已证明所属根目录的token继续复用，不强制要求新增目录读取权限', async () => {
  const f = fixture({ Root: new Error('permission denied') });
  const t = task({ briefing: { kind: 'daily' } });
  try {
    f.store.saveSetting(libraryKey(root(), app), { rootFolderToken: 'Root', folderToken: 'Library', manifestUrl: 'https://tenant.feishu.cn/docx/Index', companies: [] });
    f.store.saveSetting(briefingKey(t), { rootFolderToken: 'Root', folderToken: 'Daily' });
    await f.directories.prepare(t); assert.equal(t.briefingLibrary.folderToken, 'Daily'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('旧版本根目录创建未确认的记录不会因升级而再次创建', async () => {
  const f = fixture();
  const t = task({ feishuRoot: { rootName: '行研工作台' } });
  try {
    f.store.saveSetting(folderCacheKey(t.feishuRoot), { owner: 'old-task' });
    await assert.rejects(f.directories.prepare(t), e => e.code === 'FOLDER_CREATE_UNCONFIRMED');
    assert.equal(f.creates().length, 0);
  } finally { f.close(); }
});

test('跨应用并发首次保存只创建一个缺失子目录，重启解析器后仍复用', async () => {
  const f = fixture({ Root: [folder('全量信息库', 'Library')] });
  try {
    const a = task({ briefing: { kind: 'daily' } });
    const b = task({ briefing: { kind: 'daily' }, feishuApp: { profile: 'another', appId: 'cli_another' } });
    await Promise.all([f.directories.prepare(a), f.directories.prepare(b)]);
    assert.equal(a.briefingLibrary.folderToken, b.briefingLibrary.folderToken);
    assert.deepEqual(f.creates().map(a => a[a.indexOf('--name') + 1]), ['日报']);
    const restarted = new FeishuDirectories(f.store, { command: '/mock/lark-cli', run: f.run });
    await restarted.prepare(task({ briefing: { kind: 'daily' } })); assert.equal(f.creates().length, 1);
  } finally { f.close(); }
});

test('第二台机器没有目录缓存，仍根据云端实际父目录复用，不复制文件夹', async () => {
  const a = fixture({ Root: [folder('全量信息库', 'Library')] }), b = fixture();
  try {
    await a.directories.prepare(task({ briefing: { kind: 'daily' } }));
    for (const [k, v] of a.pages) b.pages.set(k, v);
    const t = task({ briefing: { kind: 'daily' } }); await b.directories.prepare(t);
    assert.equal(t.briefingLibrary.folderToken, 'Created1'); assert.equal(b.creates().length, 0);
  } finally { a.close(); b.close(); }
});

test('读取全部分页后才判定不存在；同名普通文档不算文件夹', async () => {
  const f = fixture({ Root: { files: [document('日报', 'NotFolder')], has_more: true, next_page_token: 'page2' }, 'Root:page2': [folder('日报', 'Daily'), folder('全量信息库', 'Library')] });
  try {
    const t = task({ briefing: { kind: 'daily' } }); await f.directories.prepare(t);
    assert.equal(t.briefingLibrary.folderToken, 'Daily'); assert.equal(f.creates().length, 0);
    assert.ok(f.calls.some(a => a.includes('--page-token')));
  } finally { f.close(); }
});

test('截图中的两个同名目录明确报冲突，不任选一个、不新建、不删除', async () => {
  const f = fixture({ Root: [folder('全量信息库', 'Library'), folder('日报', 'A'), folder('日报', 'B')] });
  try {
    await assert.rejects(f.directories.prepare(task({ briefing: { kind: 'daily' } })), e => e.code === 'FOLDER_AMBIGUOUS' && /多个同名/.test(e.message));
    assert.equal(f.creates().length, 0); assert.ok(f.calls.every(a => a.includes('list')));
  } finally { f.close(); }
});

for (const [name, listing] of [
  ['权限或网络错误', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
  ['has_more却缺少分页游标', { files: [], has_more: true }],
  ['超过分页读取上限', { files: [], has_more: true, next_page_token: 'again' }],
  ['响应缺少files', { has_more: false }],
]) test(name + '时禁止将查询失败当作空目录创建', async () => {
  const f = fixture({ Root: listing, 'Root:again': listing });
  try { await assert.rejects(f.directories.prepare(task({ analysis: {} }))); assert.equal(f.creates().length, 0); }
  finally { f.close(); }
});

test('创建超时后再次查询：找到实际创建结果就恢复，查不到也不盲目重建', async () => {
  for (const committed of [true, false]) {
    const f = fixture(); let writes = 0;
    const run = async (command, args) => {
      if (args.includes('+create-folder')) { writes++; if (committed) f.pages.set('Root', [folder('友商分析', 'Recovered')]); throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }
      return f.run(command, args);
    };
    try {
      const resolver = new FeishuDirectories(f.store, { command: '/mock/lark-cli', run });
      await assert.rejects(resolver.prepare(task({ analysis: {} })), e => e.code === 'TIMEOUT');
      const restarted = new FeishuDirectories(f.store, { command: '/mock/lark-cli', run });
      const t = task({ analysis: {} });
      if (committed) { await restarted.prepare(t); assert.equal(t.analysisIndex.folderToken, 'Recovered'); }
      else await assert.rejects(restarted.prepare(t), e => e.code === 'FOLDER_CREATE_UNCONFIRMED');
      assert.equal(writes, 1);
    } finally { f.close(); }
  }
});

test('根目录切换后不复用旧目录下的日报，内部资料各级目录逐层复用', async () => {
  const f = fixture({ Root: [folder('全量信息库', 'Library'), folder('日报', 'Daily')], NewRoot: [folder('全量信息库', 'NewLibrary'), folder('日报', 'NewDaily'), folder('内部资料', 'Material')], Material: [folder('原始资料', 'Source'), folder('逐字稿', 'Transcript'), folder('会议纪要', 'Minutes')] });
  try {
    await f.directories.prepare(task({ briefing: { kind: 'daily' } }));
    const t = task({ feishuRoot: { rootName: '行研工作台', folderToken: 'NewRoot' }, briefing: { kind: 'daily' }, internal: {} });
    await f.directories.prepare(t); assert.equal(t.briefingLibrary.folderToken, 'NewDaily');
    assert.equal(t.internalFolders.materialFolderToken, 'Material'); assert.equal(t.internalFolders.transcriptFolderToken, 'Transcript');
    assert.equal(t.internalFolders.minutesFolderToken, 'Minutes'); assert.equal(f.creates().length, 0);
  } finally { f.close(); }
});

test('保存锁返回服务端已复用的analysisIndex，目录检查失败后不继续持锁', async () => {
  const f = fixture({ Root: [folder('友商分析', 'Analysis')] }), t = task({ analysis: {} });
  let resolveCalls = 0;
  const s = { store: f.store, active: new Map([[t.id, { controller: new AbortController() }]]), require: () => t, save() {},
    directories: { async prepare(...args) { resolveCalls++; return f.directories.prepare(...args); } } };
  f.store.saveTerminal({ id: t.terminalId, taskId: t.id, deliveryRequestId: 'request', activity: 'waiting_input' });
  try {
    const writes = new CloudWrites(s), snapshot = await writes.acquire(t.id, 'request');
    assert.equal(resolveCalls, 1); assert.equal(snapshot.analysisIndex.folderToken, 'Analysis');
    t.status = 'ready'; writes.release(t.id); assert.equal(writes.locks.size, 0);
    s.directories.prepare = async () => { throw Error('directory failure'); };
    await assert.rejects(writes.acquire(t.id, 'request'), /directory failure/); assert.equal(writes.locks.size, 0);
    assert.throws(() => writes.assertOwner(t), /先获取/);
  } finally { f.close(); }
});

test('获取目录时取消不会发送创建请求', async () => {
  const f = fixture(), controller = new AbortController();
  try {
    const resolver = new FeishuDirectories(f.store, { command: '/mock/lark-cli', run: async (...args) => { const r = await f.run(...args); controller.abort(); return r; } });
    await assert.rejects(resolver.prepare(task({ analysis: {} }), controller.signal), e => e.name === 'AbortError');
    assert.equal(f.creates().length, 0);
  } finally { f.close(); }
});

test('导入公司库时多个同名库必须报错，不能先取第一个', async () => {
  const f = fixture({ Root: [folder('全量信息库', 'A'), folder('全量信息库', 'B')] });
  try {
    await assert.rejects(importLibrary(f.store, root(), app, f.run, { command: '/mock/lark-cli' }), e => e.code === 'LIBRARY_FOLDER_AMBIGUOUS');
    assert.deepEqual(library(f.store, root(), app).companies, []);
  } finally { f.close(); }
});

test('友商刷新在真实子进程中支持JS CLI入口，保留所选profile而非回退默认CLI', async () => {
  const f = fixture();
  try {
    const cli = resolve(f.dir, 'cli.mjs');
    writeFileSync(cli, 'import assert from "node:assert/strict";assert.deepEqual(process.argv.slice(2,4),["--profile","selected"]);console.log(JSON.stringify({ok:true,data:{document:{content:"{\\"reports\\":[]}"}}}));');
    f.store.saveSetting(analysisKey(root(), app), { folderToken: 'Analysis', manifestUrl: 'https://tenant.feishu.cn/docx/Index', reports: [] });
    const updated = await refreshAnalysisLibrary(f.store, root(), app, undefined, { command: cli });
    assert.deepEqual(updated.reports, []); assert.ok(updated.syncedAt);
  } finally { f.close(); }
});

test('调研提示词只允许复用保存锁中的目录，不再指示按缓存缺失首次创建', () => {
  for (const extra of [{}, { industry: {} }, { analysis: { companies: [], dimensions: [] } }, { briefing: { kind: 'daily', window: {} } }, { internal: { sourceType: 'url', source: 'https://example.com' } }]) {
    const prompt = cloudPrompt(task({ ...extra, prompt: 'test prompt' }), { writeClientPath: 'client', writeConfigPath: 'config', deliveryPath: 'receipt', deliveryRequestId: 'request' });
    assert.match(prompt, /禁止自行创建文件夹/); assert.match(prompt, /analysisIndex和internalFolders/);
    assert.doesNotMatch(prompt, /首次创建.*(?:子文件夹|根目录|内部资料目录|【会议纪要】|【逐字稿】|【原始资料】)/);
  }
});

test('原生任务通过实际HTTP保存锁取得已有目录，交付使用原日报token且不新建', async () => {
  const f = fixture({ Root: [folder('全量信息库', 'Library'), folder('日报', 'Daily')] });
  const host = mockHost(), runtimeDir = resolve(f.dir, 'runtime'); let snapshot;
  const runtime = await startRuntime({ port: 0, dataDir: runtimeDir, env: { RESEARCH_MODE: 'native' }, host,
    binding: { applicationSnapshot: () => app, requireBound: async () => ({ bound: true }), close() {} } });
  try {
    runtime.service.directories = new FeishuDirectories(runtime.service.store, { run: f.run, command: '/mock/lark-cli' });
    runtime.service.notifications.send = async () => {};
    runtime.service.setFeishuSettings({ rootName: '行研工作台', folderUrl: 'https://tenant.feishu.cn/drive/folder/Root' });
    host.sessionController.prompt = async request => {
      host.emit(request.sessionId, 'turn/start');
      const t = runtime.service.store.list().find(t => t.nativeSessionId === request.sessionId);
      const meta = runtime.service.store.terminal(t.terminalId);
      const { stdout } = await promisify(execFile)(process.execPath, [meta.writeClientPath, meta.writeConfigPath]);
      snapshot = JSON.parse(stdout);
      writeFileSync(meta.deliveryPath, JSON.stringify({ requestId: meta.deliveryRequestId, status: 'published', folderToken: snapshot.feishuRoot.folderToken,
        reportFolderToken: snapshot.briefingLibrary.folderToken, url: 'https://tenant.feishu.cn/docx/DailyReport', noUpdates: true, companies: [] }));
      host.emit(request.sessionId, 'turn/end', { kind: 'completed' }); return { accepted: true };
    };
    const t = await runtime.service.createAuthorized(briefingTask({ kind: 'daily', companies: ['后摩智能'], dimensions: ['技术路线'], sources: ['芯东西'] }, new Date()));
    await until(() => ['ready', 'failed'].includes(runtime.service.require(t.id).status));
    const completed = runtime.service.require(t.id);
    assert.equal(completed.status, 'ready', completed.error); assert.equal(completed.publication.reportFolderToken, 'Daily');
    assert.equal(snapshot.industryLibrary.folderToken, 'Library'); assert.equal(f.creates().length, 0);
    assert.ok(runtime.service.store.runtimeLogs().some(e => e.event === 'feishu.directories.finished' && e.details.taskId === t.id));
  } finally { await runtime.close(); f.close(); }
});
