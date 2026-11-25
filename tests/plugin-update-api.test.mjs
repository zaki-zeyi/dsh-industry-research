import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.mjs';
import { fixture } from './helpers.mjs';

test('设置页通过同源接口读取更新状态，写操作必须携带启动令牌', async () => {
  const f = fixture();
  const token = 'test-update-token';
  let automatic = false;
  f.service.pluginUpdates = {
    token,
    snapshot: () => ({ installedVersion: '0.13.11', automatic, actionToken: token, eligible: true }),
    automatic: enabled => ({ installedVersion: '0.13.11', automatic: automatic = enabled, actionToken: token, eligible: true }),
  };
  const server = createApp(f.service).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/plugin-update`;
  try {
    const initial = await fetch(url);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.equal((await initial.json()).installedVersion, '0.13.11');
    const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin, ...headers }, body: JSON.stringify({ action: 'automatic', enabled: true }) });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ 'X-DSH-Update-Token': 'wrong' })).status, 403);
    const changed = await post({ 'X-DSH-Update-Token': token });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).automatic, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});
