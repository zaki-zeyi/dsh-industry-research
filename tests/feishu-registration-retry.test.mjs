import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import {
  installRegistrationRetry,
  shouldRetryRegistrationRequest,
} from '../server/feishu-register-app.mjs';

test('应用登记轮询遇到临时网络或服务错误会自动重试', async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts++;
    response.setHeader('content-type', 'application/json');
    if (attempts < 3) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'temporary' }));
      return;
    }
    response.end(JSON.stringify({ error: 'authorization_pending' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const http = defaultHttpInstance.create();
    installRegistrationRetry(http, { delay: async () => {}, shouldRetry: () => true });
    const response = await http.post(
      `http://127.0.0.1:${server.address().port}/oauth/v1/app/registration`,
      'action=poll',
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    );
    assert.deepEqual(response.data, { error: 'authorization_pending' });
    assert.equal(attempts, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('重试只作用于应用登记接口，并尊重取消信号', () => {
  const request = error => ({ config: { url: 'https://accounts.feishu.cn/oauth/v1/app/registration' }, ...error });
  assert.equal(shouldRetryRegistrationRequest(request({ code: 'ECONNRESET' })), true);
  assert.equal(shouldRetryRegistrationRequest(request({ response: { status: 503 } })), true);
  assert.equal(shouldRetryRegistrationRequest(request({ response: { status: 400 } })), false);
  assert.equal(shouldRetryRegistrationRequest({ config: { url: 'https://example.com/oauth/v1/app/registration' }, code: 'ECONNRESET' }), false);
  assert.equal(shouldRetryRegistrationRequest(request({ code: 'ECONNRESET' }), { aborted: true }), false);
});
