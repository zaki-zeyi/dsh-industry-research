import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryReadError } from '../server/library-errors.mjs';

test('CLI 已安装时区分密钥、网络和未知读取错误，不泄漏原始输出', () => {
  const cases = [
    [{ stdout: 'progress', stderr: 'DPoP key unavailable 0x80090016 secret-private' }, 'FEISHU_LOCAL_KEY_UNAVAILABLE'],
    [{ stdout: 'progress', stderr: 'TOKEN_EXPIRED secret-private' }, 'FEISHU_AUTH_REQUIRED'],
    [{ code: 'ECONNRESET', message: 'secret-private' }, 'FEISHU_NETWORK_ERROR'],
    [{ stderr: 'secret-private' }, 'LIBRARY_READ_FAILED'],
  ];
  for (const [input, code] of cases) {
    const error = libraryReadError(input);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('secret-private'));
  }
});
