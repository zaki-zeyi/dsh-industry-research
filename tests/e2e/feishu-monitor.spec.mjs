import { test, expect } from '@playwright/test';

test('飞书监测入口、异常定位、筛选、导出和服务异常提示', async ({ page }) => {
  let failed = false;
  const queries = [];
  const row = { seq: 1, at: '2026-11-05T02:00:00Z', level: 'error', event: 'feishu.connection.failed', details: { phase: 'credential_storage', code: 'PROFILE_CONFLICT', durationMs: 125, operationId: '11111111-2222-4222-8222-222222222222' } };
  await page.route('**/api/feishu-monitor/**', route => {
    const url = new URL(route.request().url());
    if (failed) return route.fulfill({ status: 503, json: { error: '连接服务暂不可用' } });
    if (url.pathname.endsWith('/check')) return route.fulfill({ json: { checkedAt: row.at, durationMs: 210, appId: 'cli_test123', status: 'error', checks: [{ phase: 'bot_identity', status: 'error', code: 'BOT_NOT_READY' }] } });
    queries.push(url.searchParams.get('level'));
    return route.fulfill({ json: { items: [row] } });
  });
  await page.goto('/');
  await expect(page.locator('.industry-sidebar').getByRole('button', { name: '平台日志', exact: true })).toHaveCount(0);
  await page.locator('.industry-top').getByRole('button', { name: '平台日志', exact: true }).click();
  await expect(page.getByRole('heading', {name:'平台日志',exact:true})).toBeVisible();
  await page.getByRole('tab', { name: '飞书连接监测', exact: true }).click();
  const dialog = page.getByRole('region', { name: '飞书连接监测', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('本机凭据保存 · 失败')).toBeVisible();
  await expect(dialog.getByText(/应用配置重复/)).toBeVisible();
  await dialog.getByRole('button', { name: '立即检测连接' }).click();
  await expect(dialog.getByText('发现连接异常')).toBeVisible();
  await expect(dialog.getByText('机器人身份未就绪', { exact: true })).toBeVisible();
  await dialog.getByRole('combobox', { name: '日志级别' }).selectOption('error');
  await expect.poll(() => queries.includes('error')).toBe(true);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '导出当前记录' }).click();
  expect((await download).suggestedFilename()).toBe('feishu-connection-logs.json');
  await page.screenshot({ path: 'artifacts/feishu-monitor.png', fullPage: true });
  failed = true;
  await dialog.getByRole('button', { name: '刷新日志' }).click();
  await expect(dialog.getByRole('alert')).toContainText('监测服务异常：连接服务暂不可用');
  await page.getByRole('tab', {name:'运行日志',exact:true}).click(); await expect(dialog).toHaveCount(0);
});
