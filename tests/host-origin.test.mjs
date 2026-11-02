import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOrigin } from '../src/host-origin.mjs';
test('桌面协议无Referer时可以使用显式宿主来源，本机浏览器来源仍兼容', () => {
  assert.equal(hostOrigin('', 'dsh-app://app'), 'dsh-app://app');
  assert.equal(hostOrigin('dsh-app://app/'), 'dsh-app://app');
  assert.equal(hostOrigin('http://127.0.0.1:3090/?token=private'), 'http://127.0.0.1:3090');
  assert.equal(hostOrigin('', 'http://localhost:3090'), 'http://localhost:3090');
});
test('不接受不透明来源、任意外网父页或带凭据的宿主提示', () => {
  for (const value of ['null', 'https://evil.example', 'http://127.0.0.1.evil.example', 'dsh-app://evil', 'http://user:pass@localhost:3090']) assert.equal(hostOrigin('', value), null);
});
