import { test, expect } from '@playwright/test';

test('release 连接界面：更换应用和重新绑定生成新流程，保存后手动确认个人授权', async ({ page }) => {
  let registration = { status: 'idle' }, serial = 0, bound = true;
  const posts = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==', 'base64');
  const identity = () => ({ bound, available: true, appId: serial ? 'cli_new123' : 'cli_old123', appName: serial ? '新应用' : '原应用', userName: '测试用户' });
  await page.route('**/api/feishu-binding**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/qr/')) return route.fulfill({ contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') {
      posts.push({ path, body: route.request().postDataJSON() });
      if (path.endsWith('/complete')) { bound = true; return route.fulfill({ json: identity() }); }
      return route.fulfill({ json: { ...identity(), bound: false, flowId: '11111111-2222-4222-8222-222222222222', authorizationUrl: 'https://accounts.feishu.cn/device?code=fixture', expiresAt: new Date(Date.now() + 600000).toISOString() } });
    }
    return route.fulfill({ json: identity() });
  });
  await page.route('**/api/feishu-registration**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/qr/')) return route.fulfill({ contentType: 'image/png', body: png });
    if (route.request().method() === 'DELETE') { registration = { status: 'idle' }; return route.fulfill({ json: registration }); }
    if (route.request().method() === 'POST') {
      posts.push({ path, body: route.request().postDataJSON() }); serial++;
      registration = { status: 'awaiting_scan', flowId: String(serial), authorizationUrl: 'https://open.feishu.cn/page/cli?user_code=fixture' };
    }
    return route.fulfill({ json: registration });
  });
  await page.goto('/');
  await page.getByRole('main').locator('.industry-top').getByRole('button', { name: '更换应用', exact: true }).click();
  await expect(page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' })).toBeVisible();
  const firstQr = await page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' }).getAttribute('src');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '重新绑定', exact: true }).click();
  await expect(page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' })).toHaveAttribute('src', /\/2$/);
  expect(await page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' }).getAttribute('src')).not.toBe(firstQr);
  bound = false; registration = { status: 'completed', appId: 'cli_new123' };
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我已授权', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('已绑定飞书：测试用户');
  expect(posts.filter(p => p.path.endsWith('/feishu-registration')).map(p => p.body)).toEqual([{ refresh: false }, { refresh: false }]);
  expect(posts.find(p => p.path.endsWith('/feishu-binding')).body).toEqual({ rebind: true });
  await page.screenshot({ path: 'artifacts/feishu-release-baseline.png', fullPage: true });
});
