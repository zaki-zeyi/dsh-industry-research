import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { TopicDigest } from '../server/topic-digest.mjs';
import { TopicSchedules } from '../server/topic-schedules.mjs';
import { topicScope } from '../server/topics.mjs';

const APP = { appId: 'cli_demo', ownerOpenId: 'ou_fixture' };
const DATE = '2026-11-26';
const IDs = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const reportUrl = id => 'https://example.feishu.cn/docx/' + id;
const digestUrl = reportUrl('Digest');
const slot = (time, date = DATE) => Date.parse(`${date}T${time}:00+08:00`);

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const control = { now: slot('12:00'), root: { rootName: '测试根目录', folderToken: 'Root' }, app: APP, notices: [], paths: [], creates: [] };
  const documents = {
    reports: new Map(), archive: [],
    async files(_, parent) { assert.equal(parent, 'DigestFolder'); return this.archive; },
    async read(_, url) {
      if (url !== digestUrl) await control.onSourceRead?.();
      return { content: this.reports.get(url) };
    },
    async create(_, folder, name, content) {
      control.creates.push({ folder, name, content });
      this.archive.push({ name, type: 'docx', url: digestUrl });
      this.reports.set(digestUrl, content);
      if (control.loseCreateReply) throw new Error('timeout after create');
      return digestUrl;
    },
  };
  const service = {
    store, feishuSettings: () => control.root,
    binding: {
      applicationSnapshot: () => control.app,
      requireBound: async () => ({ appId: control.app.appId, openId: control.user ?? control.app.ownerOpenId }),
      async json(args, app) {
        assert.deepEqual(app, APP);
        if (args[0] === 'auth') return { appId: APP.appId, identities: {
          user: { openId: APP.ownerOpenId, available: true, verified: true }, bot: { available: true, verified: true },
        } };
        control.notices.push(args);
        if (control.loseNotificationReply) throw new Error('uncertain delivery');
        return { ok: true };
      },
    },
    directories: { async folder(_, parent, name) {
      control.paths.push([parent, name]);
      return name === '专题调研' ? 'TopicsFolder' : 'DigestFolder';
    } },
    require: id => store.get(id),
    async createAuthorized(input, key, { scheduled }) {
      const task = { ...input, id: key, createdAt: scheduled.scheduledFor, scheduled, notificationRecipient: APP.ownerOpenId,
        notificationApp: APP, feishuRoot: control.root, feishuApp: control.app, status: 'queued', publication: { status: 'pending' } };
      store.save(task);
      store.saveRequest(key, '', task.id);
      return task;
    },
  };
  const worker = () => service.topicDigest = new TopicDigest(service, documents, { now: () => control.now });
  worker();
  const schedules = service.topicSchedules = new TopicSchedules(service);
  const scope = topicScope(control.root, control.app);
  const [early, late] = IDs.map((topicId, i) => ({ topicId, scope, enabled: true, time: i ? '11:00' : '08:00',
    activatedAt: '2026-11-25T01:00:00Z', research: { question: i ? '测试替代路线' : '测试成本 & 供应', sources: ['测试信源'] } }));
  store.saveSetting('topic-schedules', {
    [scope + ':' + early.topicId]: early, [scope + ':' + late.topicId]: late,
    disabled: { ...early, topicId: 'disabled', enabled: false },
    notYetActivated: { ...early, topicId: 'tomorrow', activatedAt: '2026-11-27T01:00:00Z' },
    otherRoot: { ...late, topicId: 'elsewhere', scope: 'other-root' },
  });
  const trigger = (i, date) => schedules.trigger(IDs[i], { scope, scheduledFor: slot(i ? '11:00' : '08:00', date) });
  const record = (task, id, markdown, status = 'ready') => {
    const url = reportUrl(id);
    documents.reports.set(url, markdown);
    store.save({ ...task, status, publication: { status: status === 'ready' ? 'published' : 'failed', url } });
  };
  return { store, scope, service, documents, control, worker, trigger, record };
}

test('PRD 6004 waits for later slots and failed reports, then writes all summaries with original links', async t => {
  const f = fixture(t);
  const first = await f.trigger(0);
  f.record(first, 'First', '## 摘要\n- 首份摘要 <b>保留</b>，功耗 < 10 W 而产量 > 100 件。\n## 详情\n不属于摘要');
  await f.service.topicDigest.tick();
  assert.equal(f.service.topicDigest.latest(), null);
  assert.deepEqual(f.control.paths, []); // The second slot has not yet started.
  const second = await f.trigger(1);
  f.record(second, 'Second', '## 摘要\n本日无更新。', 'failed');
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 0);
  assert.equal(f.control.notices.length, 0);

  assert.equal((await f.trigger(1)).id, second.id); // same schedule slot
  f.record(second, 'Second', '## 摘要\n本日无更新。');
  await Promise.all([f.service.topicDigest.tick(), f.service.topicDigest.tick()]);
  assert.deepEqual(f.control.paths, [['Root', '专题调研'], ['TopicsFolder', '汇总日报']]);
  assert.equal(f.control.creates.length, 1);
  const [{ folder, name, content }] = f.control.creates;
  assert.equal(folder, 'DigestFolder');
  assert.equal(name, '汇总日报 · ' + DATE);
  assert.match(content, /<h2>测试成本 &amp; 供应<\/h2><p>首份摘要 保留，功耗 &lt; 10 W 而产量 &gt; 100 件。<\/p>/);
  assert.match(content, /<h2>测试替代路线<\/h2><p>本日无更新。<\/p>/);
  assert.doesNotMatch(content, /详情|不属于摘要|<b>/);
  for (const id of ['First', 'Second']) assert.ok(content.includes(`href="${reportUrl(id)}"`));
  assert.deepEqual(f.service.topicDigest.latest(), { date: DATE, url: digestUrl });
  assert.equal(f.control.notices.length, 1);
  assert.match(f.control.notices[0].at(-3), /汇总日报 · 2026-11-26已完成/);
  assert.ok(f.control.notices[0].includes(APP.ownerOpenId));
  assert.equal(f.service.inFlightWrites, 0);
  await f.worker().tick();
  assert.equal(f.control.notices.length, 1);
  assert.equal(f.control.creates.length, 1);
});

test('uncertain create and message recover across workers without another document or another notification key', async t => {
  const f = fixture(t);
  f.record(await f.trigger(0), 'First', '# 标题\n原报告没有独立摘要。');
  f.record(await f.trigger(1), 'Second', '## 摘要\n第二份已完成。');
  f.control.loseCreateReply = true;
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 1);
  assert.match(f.control.creates[0].content, /正文摘录/);
  assert.equal(f.service.topicDigest.latest(), null);
  assert.equal(f.service.topicDigest.remoteVisible(f.scope, { date: DATE, url: digestUrl }), null);
  assert.equal(f.control.notices.length, 0);
  f.control.loseCreateReply = false;
  f.control.loseNotificationReply = true;
  f.control.now += 16_000;
  await f.worker().tick();
  assert.equal(f.control.creates.length, 1);
  assert.deepEqual(f.service.topicDigest.latest(), { date: DATE, url: digestUrl });
  assert.equal(f.control.notices.length, 1);
  f.control.loseNotificationReply = false;
  f.control.now += 31_000;
  await f.worker().tick();
  assert.equal(f.control.creates.length, 1);
  assert.deepEqual(f.control.notices[0], f.control.notices[1]);
  assert.match(f.control.notices[1].at(-1), /^[a-f0-9-]{36}$/);
});

test('late schedule edits are reflected before publication, without dropping failed tasks', async t => {
  const f = fixture(t);
  f.record(await f.trigger(0), 'First', '## 摘要\n第一份。');
  const plans = f.service.topicSchedules.all(), lateKey = f.scope + ':' + IDs[1];
  plans[lateKey].enabled = false;
  f.store.saveSetting('topic-schedules', plans);
  // While the first document is being read, a later slot is enabled again.
  f.control.onSourceRead = () => {
    plans[lateKey].enabled = true;
    f.store.saveSetting('topic-schedules', plans);
    f.control.onSourceRead = null;
  };
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 0);
  f.record(await f.trigger(1), 'Second', '## 摘要\n第二份。', 'failed');
  plans[lateKey].enabled = false;
  f.store.saveSetting('topic-schedules', plans);
  f.control.now += 16_000;
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 0);
  const request = f.store.request('topic:' + f.scope + ':' + IDs[1] + ':' + DATE);
  f.record(f.store.get(request.task_id), 'Second', '## 摘要\n第二份。');
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 1);
  assert.match(f.control.creates[0].content, /第二份/);
});

test('a same-title document without the report abstracts is not announced', async t => {
  const f = fixture(t);
  f.record(await f.trigger(0), 'First', '## 摘要\n第一份关键内容。');
  f.record(await f.trigger(1), 'Second', '## 摘要\n第二份关键内容。');
  f.documents.archive.push({ name:'汇总日报 · ' + DATE, type:'docx', url:digestUrl });
  f.documents.reports.set(digestUrl, '<a href="'+reportUrl('First')+'">第一份</a><a href="'+reportUrl('Second')+'">第二份</a>');
  await f.service.topicDigest.tick();
  assert.equal(f.service.topicDigest.latest(), null);
  assert.equal(f.control.notices.length, 0);
  assert.equal(f.control.creates.length, 0);
});

test('same-profile account switch during a report read prevents writing', async t => {
  const f = fixture(t);
  f.record(await f.trigger(0), 'First', '## 摘要\n第一份。');
  f.record(await f.trigger(1), 'Second', '## 摘要\n第二份。');
  f.control.onSourceRead = () => { f.control.user = 'ou_replacement'; };
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 0);
  assert.equal(f.service.topicDigest.latest(), null);
  assert.equal(f.control.notices.length, 0);
});

test('an older incomplete batch does not publish or block the next Beijing send date', async t => {
  const f = fixture(t);
  f.record(await f.trigger(0, '2026-11-25'), 'OldFirst', '## 摘要\n旧日报应独立。');
  f.record(await f.trigger(1, '2026-11-25'), 'OldSecond', '## 摘要\n旧日报失败。', 'failed');
  f.record(await f.trigger(0), 'First', '## 摘要\n新日报一。');
  f.record(await f.trigger(1), 'Second', '## 摘要\n新日报二。');
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 1);
  assert.equal(f.control.creates[0].name, '汇总日报 · ' + DATE);
  assert.doesNotMatch(f.control.creates[0].content, /旧日报/);
  assert.equal(f.control.notices.length, 1);
});

test('digest does not write or expose prior scope after an account or root switch', async t => {
  const f = fixture(t);
  f.record(await f.trigger(0), 'First', '## 摘要\n第一份已完成。');
  f.record(await f.trigger(1), 'Second', '## 摘要\n第二份已完成。');
  f.control.onSourceRead = () => { f.control.root = { rootName: '另一个目录', folderToken: 'Other' }; };
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 0);
  assert.equal(f.control.notices.length, 0);
  assert.equal(f.service.topicDigest.latest(), null);
  f.control.root = { rootName: '测试根目录', folderToken: 'Root' };
  f.control.onSourceRead = null;
  f.control.now += 16_000;
  await f.service.topicDigest.tick();
  assert.equal(f.control.creates.length, 1);
  f.control.app = { ...APP, ownerOpenId: 'ou_another' };
  assert.equal(f.service.topicDigest.latest(), null);
});
