import { test, expect } from '@playwright/test';

test('设置把版本更新和平台日志放在同一入口', async ({ page }) => {
  const actions = [];
  let automatic = false;
  await page.route('**/api/plugin-update', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      actions.push({ ...body, token: request.headers()['x-dsh-update-token'] });
      if (body.action === 'automatic') automatic = body.enabled;
    }
    await route.fulfill({ status: request.method() === 'POST' && request.postDataJSON().action === 'install' ? 202 : 200,
      json: { installedVersion: '0.13.11', candidateVersion: '0.13.12', state: 'available', automatic,
        supported: true, eligible: true, packageReady: true, actionToken: 'test-token' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '平台日志', exact: true })).toHaveCount(0);
  await page.locator('.industry-top').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '版本与更新' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('版本信息')).toContainText('0.13.11');
  await page.getByRole('button', { name: '检查更新' }).click();
  await page.getByRole('checkbox', { name: '空闲时自动更新' }).click();
  await expect(page.getByRole('checkbox', { name: '空闲时自动更新' })).toBeChecked();
  await page.getByRole('button', { name: '安装已校验版本' }).click();
  await expect.poll(() => actions.map(item => item.action)).toEqual(['check', 'automatic', 'install']);
  expect(actions.every(item => item.token === 'test-token')).toBe(true);
  await page.getByRole('tab', { name: '平台日志' }).click();
  await expect(page.getByRole('heading', { name: '平台日志' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '更新日志' })).toBeVisible();
});

test('三阶段进度显示下载错误、重试和独立更新日志', async ({ page }) => {
  let failed = true;
  const actions = [];
  await page.route('**/api/plugin-update', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      actions.push(body.action);
      if (body.action === 'retry') failed = false;
    }
    await route.fulfill({ status: actions.at(-1) === 'retry' ? 202 : 200, json: {
      installedVersion: '0.13.12', candidateVersion: '0.13.13', automatic: false, eligible: true,
      actionToken: 'test-token', state: failed ? 'download-failed' : 'available',
      error: failed ? '安装包校验失败' : '', packageReady: !failed,
      progress: { percent: failed ? 18 : 33, phases: [
        { id: 'download', label: '下载阶段', status: failed ? 'error' : 'complete', percent: failed ? 55 : 100 },
        { id: 'health', label: '健康检查阶段', status: 'waiting', percent: 0 },
        { id: 'update', label: '更新阶段', status: 'waiting', percent: 0 },
      ] },
    } });
  });
  await page.route('**/api/runtime-logs?*', async route => route.fulfill({ json: { items: route.request().url().includes('kind=update') ? [
    { seq: 1, at: '2026-11-25T07:00:00Z', event: 'update.download.failed', level: 'error', details: { version: '0.13.13', phase: 'download', percent: 55, bytesReceived: 550000, bytesTotal: 1000000, durationMs: 1200, code: 'INTEGRITY_FAILED', operationId: 'update-123' } },
  ] : [] } }));
  await page.goto('/');
  await page.locator('.industry-top').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '更新总进度' })).toHaveAttribute('aria-valuenow', '18');
  await expect(page.getByRole('alert')).toContainText('安装包校验失败');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('progressbar', { name: '更新总进度' })).toHaveAttribute('aria-valuenow', '33');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(actions).toEqual(['retry']);
  await page.getByRole('tab', { name: '平台日志' }).click();
  await page.getByRole('tab', { name: '更新日志' }).click();
  await expect(page.getByText('下载或校验失败')).toBeVisible();
  await expect(page.getByText('55%')).toBeVisible();
  await expect(page.getByText('发布或安装包校验失败')).toBeVisible();
  await expect(page.getByText('update-123')).toBeVisible();
});

test('已完成更新后的版本检查异常只出现在版本信息', async ({ page }) => {
  await page.route('**/api/plugin-update', route => route.fulfill({ json: {
    installedVersion: '0.13.13', state: 'check-failed', lastResult: 'updated',
    error: 'fetch failed', automatic: true, eligible: true, actionToken: 'test-token',
    progress: { percent: 100, phases: [
      { id: 'download', label: '下载阶段', status: 'complete', percent: 100 },
      { id: 'health', label: '健康检查阶段', status: 'complete', percent: 100 },
      { id: 'update', label: '更新阶段', status: 'complete', percent: 100 },
    ] },
  } }));
  await page.goto('/');
  await page.locator('.industry-top').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('版本信息')).toContainText('检查新版本暂时失败');
  await expect(page.getByLabel('版本信息').getByRole('alert')).toContainText('fetch failed');
  await expect(page.getByLabel('更新进度').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: '更新总进度' })).toHaveAttribute('aria-valuenow', '100');
});
