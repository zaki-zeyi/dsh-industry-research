import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRuntime } from '../../server/runtime.mjs';

test('在健康检查及切换时打开页面，自动等待就绪并保留原来的地址', async ({ page }) => {
  const root = mkdtempSync(resolve(tmpdir(), 'industry-transition-browser-'));
  const runtime = await startRuntime({ dataDir: root, port: 0, env: { RESEARCH_MODE: 'demo' }, deferActivation: true });
  try {
    const url = runtime.url + '/?view=settings&embed=dsh&hostOrigin=http%3A%2F%2F127.0.0.1%3A9999#keep-task';
    // The first readiness request fails just as it can when an old listener closes.
    let failed = false;
    await page.route('**/api/health', route => {
      if (!failed) { failed = true; return route.abort('connectionreset'); }
      return route.continue();
    });
    const response = await page.goto(url);
    expect(response.status()).toBe(503);
    await expect(page.getByLabel('工作台更新过渡页')).toContainText('正在进行健康检查');
    await expect.poll(() => failed).toBe(true);
    const mutation = await page.request.post(runtime.url + '/api/tasks', { data: {} });
    expect(mutation.status()).toBe(503);
    expect((await mutation.json()).code).toBe('WORKBENCH_UPDATING');
    await runtime.activate();
    await expect(page.locator('.settings-version-number')).toHaveText(/^\d+\.\d+\.\d+$/);
    await expect(page).toHaveURL(url);
    await expect(page.getByLabel('工作台更新过渡页')).toHaveCount(0);

    runtime.service.updating = true;
    const switching = await page.reload();
    expect(switching.status()).toBe(503);
    await expect(page.getByLabel('工作台更新过渡页')).toContainText('正在切换版本');
    const health = await (await page.request.get(runtime.url + '/api/health')).json();
    expect(health.ready).toBe(false);
    expect(health.state).toBe('switching');
    runtime.service.updating = false;
    await expect(page.locator('.settings-version-number')).toHaveText(/^\d+\.\d+\.\d+$/);
    await expect(page).toHaveURL(url);
  } finally {
    await page.goto('about:blank');
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
