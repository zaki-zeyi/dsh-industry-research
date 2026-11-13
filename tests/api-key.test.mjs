import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiKey } from '../server/api-key.mjs';
import { AISettings } from '../server/ai-settings.mjs';
import { fixture } from './helpers.mjs';
import { writeFileSync } from 'node:fs';
import { apply } from '../plugin/dsh-terminal-bridge.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('纯密钥与常见赋值/请求头包装规范化，不删除密钥内部字符', () => {
  for (const input of [' sk-test123 ', 'DEEPSEEK_API_KEY=sk-test123', 'export DEEPSEEK_API_KEY="sk-test123"', 'API Key：sk-test123', 'Bearer sk-test123']) assert.equal(normalizeApiKey(input), 'sk-test123');
  for (const input of ['sk-测试', 'sk-test\u200b123', 'sk-test 123', '说明：sk-test123', 'sk-abc\ndef']) assert.throws(() => normalizeApiKey(input), error => !error.message.includes(input) && /纯密钥/.test(error.message));
});
test('保存拒绝非法字符且不更改配置，已存坏密钥在启动前被拦截', async () => {
  const f = fixture();
  try {
    const settings = new AISettings(f.dir, { dshAvailable: () => true });
    settings.save({ agent: 'dsh', apiKey: 'sk-valid', baseUrl: 'https://api.deepseek.com' }); const before = settings.snapshot();
    assert.throws(() => settings.save({ agent: 'dsh', apiKey: 'sk-测试', baseUrl: 'https://api.deepseek.com' }), /纯密钥/); assert.deepEqual(settings.snapshot(), before);
    settings.data.revisions[before.configId].secret = settings.encrypt('sk-坏值');
    assert.equal(settings.get().apiKeyValid, false); assert.throws(() => settings.resolve(before.configId), /纯密钥/);
  } finally { await f.close(); }
});
test('DSH 原生错误事件输出安全失败码，不包含上游错误正文或凭据', async () => {
  const f = fixture(); const callbacks = {}, path = resolve(f.dir, 'complete.json');
  try {
    apply({ on(name, callback) { callbacks[name] = callback; } }, { sessionPath: resolve(f.dir, 'session.json'), completionPath: path });
    callbacks['session/created']({ id: 'session-1' }); callbacks['session/event']({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'INVALID_CREDENTIAL', message: 'private-credential-should-never-leak' } } } });
    const text = readFileSync(path, 'utf8'), event = JSON.parse(text); assert.equal(event.reason, 'error'); assert.equal(event.errorCode, 'INVALID_CREDENTIAL'); assert.ok(!text.includes('private-credential'));
  } finally { await f.close(); }
});
