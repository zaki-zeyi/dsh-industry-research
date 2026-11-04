import { test, expect } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==', 'base64');
const future = () => new Date(Date.now() + 600000).toISOString();

test('更换账号走换号模式，更换应用走同账号模式', async ({ page }) => {
  let registrationFlow = null;
  const registrationPosts = [];
  const boundState = {
    bound: true,
    available: true,
    appId: 'cli_fixture123',
    appName: '测试行研应用',
    userName: '原飞书账号',
    notificationReady: true,
  };

  await page.route('**/api/feishu-binding**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    return route.fulfill({ json: boundState });
  });

  await page.route('**/api/feishu-registration**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      registrationPosts.push(body);
      registrationFlow = {
        flowId: '22222222-2222-4222-8222-222222222222',
        status: 'awaiting_scan',
        updatingApp: false,
        authorizationUrl: 'https://open.feishu.cn/page/cli?user_code=fixture',
        expiresAt: future(),
      };
      return route.fulfill({ json: registrationFlow });
    }
    return route.fulfill({ json: registrationFlow ?? { status: 'idle' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '更换账号', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('已绑定飞书：原飞书账号');
  await dialog.getByRole('button', { name: '更换账号', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(1);
  expect(registrationPosts[0]).toEqual({ refresh: false, replaceApp: true, accountRebind: true });
  await expect(page.getByRole('heading', { name: '更换账号并绑定应用', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开飞书更换账号页面' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/feishu-account-rebind.png', fullPage: true });

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '更换应用', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(2);
  expect(registrationPosts[1]).toEqual({ refresh: false, replaceApp: true, accountRebind: false });
  await expect(page.getByRole('heading', { name: '更换飞书应用', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/feishu-app-replace.png', fullPage: true });
});
