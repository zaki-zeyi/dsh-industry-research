import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { briefingKey } from '../server/briefings.mjs';
import { library, libraryKey, parseLibraryManifest } from '../server/industry.mjs';
import { QueuedSaveDocuments, plainXml } from '../server/queued-save-documents.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { until } from './helpers.mjs';

const root = { rootName: '测试', folderToken: 'root' };
const app = { mode: 'default', profile: 'same-user', ownerOpenId: 'ou_one' };
const url = id => 'https://example.feishu.cn/docx/' + id;
const nameA = '后摩智能', nameB = '光羽芯辰';
const firstText = '后摩智能完成第二轮芯片流片';
const secondText = '后摩智能发布样片测评报告';
const otherText = '光羽芯辰发布新产品';
const fact = (company, key, text) => ({ company, key, text, date: '2026-11-20',
  dimension: '技术路线', sources: ['https://example.com/' + key] });
const first = fact(nameA, 'tapeout', firstText);
const second = fact(nameA, 'review', secondText);
const other = fact(nameB, 'release', otherText);

function cliFixture() {
  let sequence = 0;
  const docs = new Map();
  const writes = [];
  const activeReports = new Set();
  let maximumReports = 0;
  let afterUpdate = async () => {};
  let afterCreate = async () => {};
  let beforeReport = async () => {};
  function seed(id, title, folder, content) {
    docs.set(url(id), { id, title, folder, content, revision: 1 });
  }
  seed('one', nameA, 'company-folder', '<h2 id="heading">技术路线</h2><p>人工整理的历史记录</p>');
  seed('two', nameB, 'company-folder', '<h2 id="heading">技术路线</h2>');
  const adapter = new QueuedSaveDocuments('fixture', async (_command, args, { input }) => {
    const arg = name => args[args.indexOf(name) + 1];
    const token = args.includes('--doc') && arg('--doc');
    const doc = token && docs.get(token);
    assert.deepEqual(args.slice(0, 2), ['--profile', app.profile]);
    assert.equal(arg('--as'), 'user');
    let data;
    if (args.includes('list')) {
      data = { files: [...docs].filter(([, value]) => value.folder === arg('--folder-token'))
        .map(([url, value]) => ({ url, name: value.title, token: value.id, type: 'docx' })), has_more: false };
    } else if (args.includes('+create')) {
      const id = 'created' + ++sequence;
      const parent = args.includes('--parent-token') ? arg('--parent-token') : '';
      if (['daily-folder', 'weekly-folder'].includes(parent)) {
        activeReports.add(id);
        maximumReports = Math.max(maximumReports, activeReports.size);
        try { await beforeReport(); }
        finally { activeReports.delete(id); }
      }
      seed(id, arg('--title'), parent, input || '');
      await afterCreate(docs.get(url(id)));
      data = { document: { url: url(id) } };
    } else if (args.includes('+fetch')) {
      assert.ok(doc);
      data = { document: { document_id: doc.id, title: doc.title, revision_id: doc.revision,
        content: arg('--doc-format') === 'markdown' ? plainXml(doc.content) : doc.content } };
    } else if (args.includes('+update-title')) {
      docs.get(arg('--url')).title = arg('--title');
      data = {};
    } else if (args.includes('+update')) {
      assert.ok(doc);
      assert.equal(Number(arg('--revision-id')), doc.revision);
      writes.push({ id: doc.id, command: arg('--command'), content: input });
      doc.content = arg('--command') === 'overwrite' ? input : doc.content + input;
      doc.revision++;
      await afterUpdate(doc, input);
      data = { document: { revision_id: doc.revision } };
    } else throw new Error('Unexpected fake CLI arguments: ' + args.join(' '));
    return JSON.stringify({ ok: true, data });
  });
  return { docs, writes, adapter, seed, get maximumReports() { return maximumReports; },
    afterUpdate: fn => { afterUpdate = fn; },
    beforeReport: fn => { beforeReport = fn; }, afterCreate: fn => { afterCreate = fn; } };
}

function runClient(meta, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [meta.queuedSavePath, meta.queuedSaveConfig], (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function createTask(runtime, topic, kind) {
  return runtime.service.createAuthorized({
    direction: kind ? (kind === 'daily' ? '日报' : '周报') + ' · ' + topic : topic,
    sources: '来源',
    prompt: '测试交付持久化任务 ' + topic,
    ...(kind ? { briefing: { kind, companies: [nameA, nameB], dimensions: ['技术路线'], sources: ['来源'],
      requirements: '', window: { start: '2026-11-20T00:00:00Z', end: '2026-11-21T00:00:00Z', display: '测试区间' } } }
      : { industry: { companies: [nameA, nameB], dimensions: ['技术路线'], sources: ['来源'], requirements: '' } }),
  });
}

async function runtimeFor(dataDir, fixture, host, payloads, ended) {
  const binding = { applicationSnapshot: () => app, requireBound: async () => ({ openId: app.ownerOpenId }), close() {} };
  const directories = { async prepare(task) {
    task.feishuRoot = root;
    if (task.briefing) runtime.service.store.saveSetting(briefingKey(task), { folderToken: task.briefing.kind + '-folder' });
  } };
  const runtime = await startRuntime({ dataDir, port: 0, env: { RESEARCH_MODE: 'native' }, host, binding, directories, queuedDocuments: fixture.adapter });
  if (!runtime.service.store.setting('feishu')) {
    runtime.service.store.saveSetting('feishu', root);
    runtime.service.store.saveSetting(libraryKey(root, app), { rootFolderToken: 'root', folderToken: 'company-folder',
      companies: [[nameA, 'one'], [nameB, 'two']].map(([name, id]) => ({ name, url: url(id), dimensions: ['技术路线'] })) });
  }
  host.sessionController.prompt = async request => {
    const task = runtime.service.store.list().find(candidate => candidate.nativeSessionId === request.sessionId);
    if (!task) return { accepted: true };
    host.emit(request.sessionId, 'turn/start');
    const meta = runtime.service.store.terminal(task.terminalId);
    assert.match(readFileSync(meta.promptPath, 'utf8'), /无需申请锁/);
    assert.equal(meta.writeGuard, undefined);
    const payload = payloads.get(task.direction);
    assert.deepEqual(await runClient(meta, payload), { accepted: true });
    // The same HTTP handoff can be retried if the response was lost.
    assert.deepEqual(await runClient(meta, payload), { accepted: true });
    host.emit(request.sessionId, 'turn/end', { kind: 'completed' });
    ended.add(task.id);
    return { accepted: true };
  };
  return runtime;
}

test('同一公司按文档排队且重启后去重，其他公司和日报周报并行，索引独立合并', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'queued-saves-'));
  const fixture = cliFixture(), host = mockHost(), ended = new Set();
  const payloads = new Map([
    ['第一轮', { facts: [first] }],
    ['日报 · 第二轮', { report: '日报内容', facts: [first, second] }],
    ['周报 · 第三轮', { report: '周报内容', facts: [other] }],
  ]);
  let failAfterWrite;
  const holdFirst = new Promise(resolve => { failAfterWrite = resolve; });
  fixture.afterUpdate(async doc => {
    if (doc.id !== 'one') return;
    await holdFirst;
    throw Object.assign(new Error('remote response lost'), { code: 'ECONNRESET' });
  });
  let releaseReports;
  const holdReports = new Promise(resolve => { releaseReports = resolve; });
  fixture.beforeReport(() => holdReports);
  let runtime = await runtimeFor(dataDir, fixture, host, payloads, ended);
  try {
    const firstTask = await createTask(runtime, '第一轮');
    await until(() => fixture.docs.get(url('one')).content.includes(firstText));
    const [daily, weekly] = await Promise.all([createTask(runtime, '第二轮', 'daily'), createTask(runtime, '第三轮', 'weekly')]);
    await until(() => fixture.maximumReports === 2 && ended.has(firstTask.id) && ended.has(daily.id) && ended.has(weekly.id));
    releaseReports();
    await until(() => runtime.service.require(weekly.id).status === 'ready');
    assert.equal(runtime.service.require(daily.id).stage, 'waiting_save');
    assert.ok(runtime.service.require(daily.id).publication.url);
    assert.deepEqual(fixture.writes.filter(write => write.id === 'one').map(write => write.command), ['block_insert_after']);
    assert.equal(host.calls.filter(call => call.kind === 'create').length, 3);
    const before = runtime.service.store.saveJobs(daily.id);
    assert.ok(before.every(job => !JSON.stringify(job).includes(firstText)));
    const meta = runtime.service.store.terminal(runtime.service.require(daily.id).terminalId);
    assert.ok(readdirSync(meta.cwd).every(name => !name.startsWith('report-')));

    const closed = runtime.close();
    failAfterWrite();
    await closed;
    fixture.afterUpdate(async () => {});
    runtime = await runtimeFor(dataDir, fixture, host, payloads, ended);
    await until(() => [firstTask, daily, weekly].every(task => runtime.service.require(task.id).status === 'ready'));
    const content = fixture.docs.get(url('one')).content;
    assert.equal(content.split(firstText).length - 1, 1);
    assert.equal(content.split(secondText).length - 1, 1);
    assert.ok(content.includes('人工整理的历史记录'));
    assert.equal(fixture.writes.filter(write => write.id === 'one').length, 2);
    assert.ok(fixture.docs.get(url('two')).content.includes(otherText));
    const index = [...fixture.docs.values()].filter(doc => doc.title === '公司索引');
    assert.equal(index.length, 1);
    assert.deepEqual(parseLibraryManifest(plainXml(index[0].content)).map(entry => entry.name).sort(), [nameA, nameB].sort());
    assert.equal(library(runtime.service.store, root, app).companies.length, 2);
    assert.equal(host.calls.filter(call => call.kind === 'create').length, 3);
  } finally {
    releaseReports();
    failAfterWrite();
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('首次建档回包丢失时复用唯一公司文档，同事实键的不同表述不重复写入', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'queued-company-create-'));
  const fixture = cliFixture(), host = mockHost(), ended = new Set();
  fixture.docs.delete(url('one'));
  fixture.afterCreate(async doc => {
    if (doc.title === nameA) throw Object.assign(new Error('remote response lost'), { code: 'ECONNRESET' });
  });
  const payloads = new Map([
    ['初次建档', { facts: [first] }],
    ['再次更新', { facts: [{ ...first, text: '第二次芯片流片已由后摩智能完成' }] }],
  ]);
  const runtime = await runtimeFor(dataDir, fixture, host, payloads, ended);
  try {
    const key = libraryKey(root, app);
    const original = runtime.service.store.setting(key);
    runtime.service.store.saveSetting(key, { ...original, companies: original.companies.filter(c => c.name !== nameA) });
    const a = await createTask(runtime, '初次建档');
    await until(() => [...fixture.docs.values()].some(doc => doc.title === nameA));
    const b = await createTask(runtime, '再次更新');
    await until(() => [a, b].every(task => runtime.service.require(task.id).status === 'ready'));
    assert.ok(ended.has(a.id) && ended.has(b.id));
    const documents = [...fixture.docs.values()].filter(doc => doc.title === nameA);
    assert.equal(documents.length, 1);
    assert.equal(fixture.writes.filter(write => write.id === documents[0].id).length, 1);
    assert.ok(documents[0].content.includes(firstText));
    assert.equal(runtime.service.require(a.id).publication.url, runtime.service.require(b.id).publication.url);
  } finally {
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('公司正文完成后仍等待本任务报告，所有交付写完才写公司索引', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'queued-index-last-'));
  const fixture = cliFixture(), host = mockHost(), ended = new Set();
  const payloads = new Map([['日报 · 索引最后', { report: '日报验收正文', facts: [first, other] }]]);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  fixture.beforeReport(() => held);
  const runtime = await runtimeFor(dataDir, fixture, host, payloads, ended);
  try {
    const task = await createTask(runtime, '索引最后', 'daily');
    await until(() => runtime.service.store.saveJobs(task.id).filter(job => job.role === 'company' && job.status === 'done').length === 2 && ended.has(task.id));
    assert.ok(runtime.service.store.saveJobs(task.id).filter(job => job.role === 'companyIndex').every(job => job.status === 'pending'));
    assert.ok(![...fixture.docs.values()].some(doc => doc.title === '公司索引'));
    release();
    await until(() => runtime.service.require(task.id).status === 'ready');
    const index = [...fixture.docs.values()].find(doc => doc.title === '公司索引');
    assert.deepEqual(parseLibraryManifest(plainXml(index.content)).map(entry => entry.name).sort(), [nameA, nameB].sort());
  } finally {
    release();
    await runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
