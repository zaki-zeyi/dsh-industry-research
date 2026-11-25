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
});
