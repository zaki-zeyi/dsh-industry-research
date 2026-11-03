import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { fixture, until } from './helpers.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { agentDeliverySchema } from '../server/agent-delivery.mjs';
import {
  MAX_LOCAL_UPLOAD_BYTES,
  internalMaterialCloudPrompt,
  internalMaterialInputSchema,
  internalNotificationText,
  prepareInternalMaterial,
} from '../server/internal-materials.mjs';

test('FR04 本地资料大小、URL安全校验与默认逐字稿Prompt', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'internal-material-input-'));
  const file = resolve(dir, '访谈.mp4');
  writeFileSync(file, 'fixture');
  try {
    const local = prepareInternalMaterial({
      sourceType: 'local',
      source: file,
      requirements: '重点核对融资日期',
    });
    assert.equal(local.internal.sourceLabel, '访谈.mp4');
    assert.equal(local.internal.uploadEligible, true);
    assert.equal(local.internal.fileSize, 7);
    assert.match(local.prompt, /【时间】【说话人】/);
    assert.match(local.prompt, /【逐字稿】/);
    assert.match(local.prompt, /重点核对融资日期/);

    const network = prepareInternalMaterial({ sourceType: 'url', source: 'https://example.com/interview?id=1' });
    assert.equal(network.internal.sourceType, 'url');
    assert.equal(network.internal.uploadEligible, false);
    assert.throws(() => prepareInternalMaterial({ sourceType: 'url', source: 'file:///private/secret' }), /http/);
    assert.throws(() => prepareInternalMaterial({ sourceType: 'local', source: resolve(dir, 'missing.m4a') }), /不存在/);
    assert.throws(() => internalMaterialInputSchema.parse({ sourceType: 'local', source: file, extra: true }));

    const large = resolve(dir, 'large.wav');
    const fd = openSync(large, 'w');
    truncateSync(large, MAX_LOCAL_UPLOAD_BYTES + 1);
    closeSync(fd);
    const tooLarge = prepareInternalMaterial({ sourceType: 'local', source: large });
    assert.equal(tooLarge.internal.uploadEligible, false);
    assert.equal(tooLarge.internal.fileSize, MAX_LOCAL_UPLOAD_BYTES + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR04 飞书交付Prompt复用双目录、限制上传并回传原始资料', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'internal-material-prompt-'));
  const file = resolve(dir, 'fixture.wav');
  writeFileSync(file, 'fixture');
  try {
    const input = prepareInternalMaterial({ sourceType: 'local', source: file });
    input.internal.fileSize = MAX_LOCAL_UPLOAD_BYTES + 1;
    input.internal.uploadEligible = false;
    const prompt = internalMaterialCloudPrompt({
      ...input,
      id: 'task_internal',
      feishuApp: { mode: 'custom', appId: 'cli_fixture123', profile: 'research-fixture' },
      feishuRoot: { rootName: '行研工作台', folderToken: 'rootFolder' },
      internalFolders: { transcriptFolderToken: 'internalFolder', sourceFolderToken: 'sourceFolder' },
    }, { deliveryPath: 'delivery.json', deliveryRequestId: '12345678-1234-4234-8234-123456789abc' });
    assert.match(prompt, /lark-cli --profile research-fixture/);
    assert.match(prompt, /逐字稿.*internalFolder/);
    assert.match(prompt, /原始资料.*sourceFolder/);
    assert.match(prompt, /超过 100MB，禁止上传/);
    assert.match(prompt, /sourceMaterialUrl/);
    assert.ok(!prompt.includes('fixture-secret'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FR04 API创建内部资料任务并出现在独立历史列表', async () => {
  const serviceFixture = fixture();
  const server = createApp(serviceFixture.service).listen(0, '127.0.0.1');
  await new Promise(resolveListening => server.once('listening', resolveListening));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = resolve(serviceFixture.dir, 'meeting.txt');
  writeFileSync(file, '会议记录');
  try {
    const response = await fetch(base + '/api/internal-materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'internal-once' },
      body: JSON.stringify({ sourceType: 'local', source: file, requirements: '逐字核对' }),
    });
    assert.equal(response.status, 202);
    const task = await response.json();
    assert.equal(task.internal.sourceLabel, 'meeting.txt');
    assert.match(task.prompt, /逐字核对/);

    const list = await (await fetch(base + '/api/internal-materials')).json();
    assert.ok(list.items.some(item => item.id === task.id && item.internal.sourceLabel === 'meeting.txt'));

    const replay = await fetch(base + '/api/internal-materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'internal-once' },
      body: JSON.stringify({ sourceType: 'local', source: file, requirements: '逐字核对' }),
    });
    assert.equal((await replay.json()).id, task.id);

    const invalid = await fetch(base + '/api/internal-materials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'url', source: 'ftp://example.com/a.mp3' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await serviceFixture.close();
  }
});

test('FR04 通知同时包含解析文档和原始资料，交付回执校验原始链接', () => {
  const text = internalNotificationText({
    internal: { sourceLabel: '访谈.mp4', source: 'D:\\资料\\访谈.mp4' },
    publication: {
      url: 'https://example.feishu.cn/docx/TranscriptDoc',
      sourceMaterialUrl: 'https://example.feishu.cn/file/SourceFile',
    },
  });
  assert.match(text, /TranscriptDoc/);
  assert.match(text, /SourceFile/);
  assert.equal(agentDeliverySchema.safeParse({
    status: 'published',
    folderToken: 'rootFolder',
    reportFolderToken: 'internalFolder',
    sourceFolderToken: 'sourceFolder', materialFolderToken: 'materialFolder', minutesFolderToken: 'minutesFolder', minutesUrl: 'https://example.feishu.cn/docx/MinutesDoc', companies: [],
    sourceMaterialUrl: 'https://example.feishu.cn/file/SourceFile',
    url: 'https://example.feishu.cn/docx/TranscriptDoc',
  }).success, true);
  assert.equal(agentDeliverySchema.safeParse({
    status: 'published',
    folderToken: 'rootFolder',
    reportFolderToken: 'internalFolder',
    sourceMaterialUrl: 'javascript:alert(1)',
    url: 'https://example.feishu.cn/docx/TranscriptDoc',
  }).success, false);
});

test('FR04 原生会话完成逐字稿交付后保存双目录并自动通知绑定用户', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'internal-material-native-'));
  const file = resolve(dir, 'interview.txt');
  writeFileSync(file, '访谈原始资料');
  const host = mockHost();
  const messages = [];
  const binding = {
    requireBound: async () => ({ openId: 'ou_internal', appId: 'cli_internal123' }),
    applicationSnapshot: () => ({ mode: 'default' }),
    async json(args) {
      if (args[0] === 'auth') return { appId: 'cli_internal123', identities: { bot: { status: 'ready', available: true, verified: true }, user: { openId: 'ou_internal', available: true } } };
      messages.push(args);
      return { ok: true, data: { message_id: 'om_internal' } };
    },
    close() {},
  };
  host.sessionController.prompt = async request => {
    host.emit(request.sessionId, 'turn/start');
    const promptPath = /请读取 (.+)，按照/.exec(request.content[0].text)?.[1];
    if (promptPath) {
      const prompt = readFileSync(promptPath, 'utf8');
      const deliveryPath = /原子更新 (.+)，本次 requestId/.exec(prompt)?.[1];
      const requestId = /本次 requestId 固定为 ([a-f0-9-]+)/.exec(prompt)?.[1];
      writeFileSync(deliveryPath, JSON.stringify({
        requestId,
        status: 'published',
        folderToken: 'rootFolder',
        reportFolderToken: 'internalFolder',
        sourceFolderToken: 'sourceFolder', materialFolderToken: 'materialFolder', minutesFolderToken: 'minutesFolder', minutesUrl: 'https://example.feishu.cn/docx/MinutesDoc', companies: [],
        sourceMaterialUrl: 'https://example.feishu.cn/file/SourceFile',
        url: 'https://example.feishu.cn/docx/TranscriptDoc',
      }));
    }
    host.emit(request.sessionId, 'turn/end', { kind: 'completed' });
    return { accepted: true };
  };

  const runtime = await startRuntime({ port: 0, dataDir: dir, env: { RESEARCH_MODE: 'native' }, host, binding });
  try {
    const input = prepareInternalMaterial({ sourceType: 'local', source: file, requirements: '核对数字' });
    const task = await runtime.service.createAuthorized(input);
    await until(() => runtime.service.require(task.id).status === 'ready');
    await until(() => runtime.service.require(task.id).notification?.status === 'sent');
    const done = runtime.service.require(task.id);
    assert.equal(done.publication.url, 'https://example.feishu.cn/docx/TranscriptDoc');
    assert.equal(done.publication.sourceMaterialUrl, 'https://example.feishu.cn/file/SourceFile');
    assert.equal(done.internalFolders.transcriptFolderToken, 'internalFolder');
    assert.equal(done.internalFolders.sourceFolderToken, 'sourceFolder');
    assert.equal(done.internalFolders.materialFolderToken, 'materialFolder');
    assert.equal(done.internalFolders.minutesFolderToken, 'minutesFolder');
    assert.equal(done.publication.minutesUrl, 'https://example.feishu.cn/docx/MinutesDoc');
    assert.equal(messages.length, 1);
    assert.ok(messages[0].join(' ').includes('TranscriptDoc'));
    assert.ok(messages[0].join(' ').includes('SourceFile'));
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
