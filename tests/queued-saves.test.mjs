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
import { topicTask, topicScope, topicScheduleRequestKey, topicScheduleDate } from '../server/topics.mjs';
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

test('PRD 6282 automatic and manual digest creation share readiness, saved prompt and the retry session', async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'digest-native-'));
  const fixture = cliFixture(), host = mockHost(), notices = [];
  const appId = 'cli_digest';
  let directoryReadError, waitBeforeTurn;
  const binding = { applicationSnapshot: () => app, requireBound: async () => ({ openId:app.ownerOpenId, appId }), close() {},
    async json(args) {
      if (args[0] === 'auth') return { appId, identities:{user:{openId:app.ownerOpenId,available:true,verified:true},bot:{available:true,verified:true}} };
      notices.push(args);
      return {ok:true};
    } };
  const directories = { async folder(_, parent, name) {
    if (parent === root.folderToken && name === '专题调研') return 'topics-folder';
    if (parent === 'topics-folder' && name === '汇总日报') return 'digest-folder';
    throw new Error('unexpected folder');
  }, async list(_, parent) {
    if (directoryReadError) throw directoryReadError;
    if (parent === root.folderToken) return [{type:'folder',name:'专题调研',token:'topics-folder'}];
    if (parent === 'topics-folder') return [{type:'folder',name:'汇总日报',token:'digest-folder'}];
    return fixture.adapter.files(app, parent);
  } };
  const runtime = await startRuntime({ dataDir, port:0, env:{RESEARCH_MODE:'native'}, host, binding, directories, queuedDocuments:fixture.adapter });
  try {
    const service = runtime.service, digest = service.topicDigest, store = service.store;
    const time = new Date('2026-11-26T04:00:00Z'), day = topicScheduleDate(time);
    let now = time.getTime();
    digest.now = () => now;
    store.saveSetting('feishu', root);
    const scope = topicScope(root, app), topicsApi = runtime.url + '/api/topics';
    const request = (path, method, body) => fetch(topicsApi + path, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const generate = prompt => request('/digest', 'POST', {scope,prompt});
    const createDigest = (scopeArg = scope) => request('/digest/start', 'POST', {scope:scopeArg});
    const settings = (scope, prompt) => request('/digest/settings', 'PUT', {scope,prompt});
    const retry = () => request('/retry-failed-dailies', 'POST', {scope});
    const card = async () => (await fetch(topicsApi)).json();
    const prompt = '请先比较两项结论，再聚合全部专题日报摘要。';
    assert.equal((await card()).digestPrompt, '聚合所有日报的摘要生成汇总日报，发布飞书文档到【存储位置】，并发送到飞书消息。【汇总规则】每个章节一个专题题目和摘要，附带每个日报链接。');
    assert.equal((await createDigest('other-scope')).status,409);
    assert.equal((await settings('outdated-scope', prompt)).status,409);
    assert.deepEqual(await (await settings(scope, prompt)).json(), {prompt});
    assert.equal((await card()).digestPrompt,prompt);
    assert.equal(host.created,0);
    const topicId = '33333333-3333-4333-8333-333333333333';
    const input = { topicId, question:'验证日报来源', sources:['测试来源'] };
    const task = { ...topicTask(input, time, {startDaysAgo:1,startTime:'00:00',endDaysAgo:0,endTime:'00:00'}),
      id:'source-report', createdAt:time.toISOString(), status:'ready', feishuApp:app, feishuRoot:root,
      notificationRecipient:app.ownerOpenId, notificationApp:{...app,appId},
      scheduled:{kind:'topic',scheduledFor:time.toISOString()}, publication:{status:'published',url:url('sourceReport')} };
    fixture.seed('sourceReport', '源日报', 'topic-daily-folder', '## 摘要\n测试原日报的完整摘要。');
    fixture.seed('archiveNotes', '归档备注', 'digest-folder', '<p>现有文档，必须保留</p>');
    store.saveSetting('topic-schedules', { [`${scope}:${topicId}`]:{ topicId,scope,enabled:true,time:'12:00', research:input } });
    store.save(task);
    store.saveRequest(topicScheduleRequestKey(scope,topicId,day), '', task.id);
    digest.expect(scope, day, topicId);

    const prompts = [];
    host.sessionController.prompt = async request => {
      host.emit(request.sessionId, 'turn/start');
      if (waitBeforeTurn) await waitBeforeTurn;
      const current = store.list().find(candidate => candidate.nativeSessionId === request.sessionId);
      const meta = store.terminal(current.terminalId);
      prompts.push({id:request.sessionId,text:readFileSync(meta.promptPath,'utf8')});
      if (prompts.length < 4) host.emit(request.sessionId, 'turn/end', {kind:'error'});
      else {
        assert.deepEqual(await runClient(meta, {report:'按编辑后的要求输出综合观察。'}), {accepted:true});
        host.emit(request.sessionId, 'turn/end', {kind:'completed'});
      }
      return {accepted:true};
    };
    await digest.tick();
    const failed = await until(() => store.list().find(candidate => candidate.topicDigest && candidate.status === 'failed' && !service.active.has(candidate.id)));
    assert.ok(prompts[0].text.startsWith(prompt));
    assert.deepEqual(await (await settings(scope, '供下次自动汇总使用的新默认提示词。')).json(), {prompt:'供下次自动汇总使用的新默认提示词。'});
    assert.equal(host.created, 1);
    await digest.tick(); // persist the first retry deadline
    now += 16_000;
    await digest.tick();
    await until(() => prompts.length === 2 && store.get(failed.id)?.status === 'failed' && !service.active.has(failed.id));
    assert.equal(prompts[0].id, prompts[1].id);
    assert.ok(prompts[1].text.startsWith(prompt));
    assert.equal((await card()).digestRetryable,true);
    const immediate = await retry();
    assert.equal(immediate.status,202);
    assert.deepEqual(await immediate.json(), {accepted:0,rejected:[],digestRetry:'submitted'});
    await until(() => prompts.length === 3 && store.get(failed.id)?.status === 'failed' && !service.active.has(failed.id));
    assert.equal(prompts[0].id,prompts[2].id);
    // Simulate a source going back to failed before the next batch retry.
    // Keep the real retry queue but gate execution so this test controls publication.
    const drain = service.drain;
    service.drain = () => {};
    store.save({ ...task, status:'failed', runs:[] });
    const response = await retry();
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {accepted:1,rejected:[],digestRetry:'waiting'});
    assert.deepEqual(await (await retry()).json(), {accepted:0,rejected:[],digestRetry:null});
    await digest.tick();
    assert.equal(prompts.length,3);
    assert.deepEqual((await card()).digestGeneration, {date:day,status:'waiting',taskId:failed.id,prompt});
    assert.equal(service.queue.shift().id,task.id);
    // A genuine conflict introduced after the model turn starts must leave the
    // accepted draft intact. Once gone, publication retries the saved draft, not AI.
    fixture.seed('legacyTotal', '汇总日报专题调研总报', 'digest-folder', '<p>旧专题</p>');
    store.save(task);
    service.drain = drain;
    await until(async () => {
      await digest.tick();
      return store.runtimeLogs({limit:30}).some(row=>row.event==='topic.digest.retry' && row.details.code==='DIGEST_FOLDER_CONFLICT');
    });
    assert.ok(store.get(failed.id).queuedSave);
    assert.deepEqual((await card()).digestGeneration,{date:day,status:'retrying',taskId:failed.id,prompt});
    assert.equal(notices.length,0);
    fixture.docs.delete(url('legacyTotal')); // Simulates the folder owner resolving the genuine conflict.
    now += 16_000;
    const finished = await until(async () => {
      await digest.tick();
      return digest.manualStatus(scope)?.status === 'sent' && store.get(failed.id);
    });
    assert.equal(finished.status,'ready');
    assert.equal(prompts.length, 4);
    assert.equal(prompts[0].id, prompts[3].id);
    assert.ok(prompts[3].text.startsWith(prompt));
    assert.doesNotMatch(prompts[3].text, /供下次自动汇总使用/);
    const [[digestUrl, doc]] = [...fixture.docs].filter(([,entry]) => entry.folder === 'digest-folder' && entry.title.startsWith('汇总日报 · '));
    assert.equal(fixture.docs.get(url('archiveNotes')).content,'<p>现有文档，必须保留</p>');
    assert.match(doc.content,/按编辑后的要求输出综合观察/);
    assert.match(doc.content,/测试原日报的完整摘要/);
    assert.match(doc.content,/href="https:\/\/example\.feishu\.cn\/docx\/sourceReport"/);
    assert.equal(finished.publication.url,digestUrl);
    assert.equal(notices.length, 1);
    assert.equal((await generate('当天汇总已存在，不应创建另一份文档。')).status, 409);
    assert.equal((await createDigest()).status,409);
    const {digest:archived,digestGeneration,digestDate,digestRetryable,digestCanCreate} = await card();
    assert.equal(digestCanCreate,false);
    assert.deepEqual(archived,{date:day,url:digestUrl});
    assert.equal(digestDate,day);
    assert.equal(digestGeneration.taskId,finished.id);
    assert.equal(digestRetryable,false);
    assert.deepEqual(await (await retry()).json(), {accepted:0,rejected:[],digestRetry:null});
    // A fresh local day record must still respect a document already in Drive.
    store.deleteSetting('topic-digests:' + scope);
    assert.equal((await generate('飞书已经归档，不应启动另一个汇总会话。')).status, 409);
    assert.equal(host.created, 1);
    assert.equal(notices.length, 1);

    const nextDate = new Date(time.getTime() + 86_400_000), nextDay = topicScheduleDate(nextDate);
    now = nextDate.getTime();
    const nextReport = { ...task, id:'next-source-report', status:'failed', scheduled:{...task.scheduled,scheduledFor:nextDate.toISOString()} };
    store.save(nextReport);
    store.saveRequest(topicScheduleRequestKey(scope,topicId,nextDay), '', nextReport.id);
    digest.expect(scope, nextDay, topicId);
    assert.equal((await card()).digestCanCreate,false);
    assert.equal((await createDigest()).status,409);
    store.save({...nextReport,status:'ready'});
    assert.equal((await card()).digestCanCreate,true);

    directoryReadError = Object.assign(new Error('fixture must not leak'), {code:'FOLDER_LIST_INCOMPLETE'});
    assert.equal((await createDigest()).ok,false);
    assert.deepEqual((await card()).digestGeneration,{date:nextDay,status:'start_failed',startIssue:'飞书目录未读取完整，请检查连接后重试。'});
    assert.equal(host.created,1);
    directoryReadError = null;

    const gate = Promise.withResolvers();
    waitBeforeTurn = gate.promise;
    let created;
    try {
      const launched = await createDigest();
      assert.equal(launched.status,202);
      ({task:created} = await launched.json());
      assert.equal(created.prompt,'供下次自动汇总使用的新默认提示词。');
      const rejoin = await createDigest();
      assert.equal(rejoin.status,200);
      assert.equal((await rejoin.json()).task.id,created.id);
      await digest.tick();
      assert.equal((await card()).digestCanCreate,false);
      const active = await card();
      assert.equal(active.digestGeneration.taskId,created.id);
      assert.ok(!active.digestGeneration.startIssue);
    } finally { gate.resolve(); }
    await until(async () => { await digest.tick(); return digest.manualStatus(scope)?.status === 'sent'; });
    assert.equal(host.created,2);
    assert.equal(notices.length,2);
    assert.equal((await createDigest()).status,409);
  } finally { await runtime.close(); rmSync(dataDir,{recursive:true,force:true}); }
});

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
