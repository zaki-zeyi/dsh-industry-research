import { test, expect } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==', 'base64');
const future = () => new Date(Date.now() + 600000).toISOString();

test('重新绑定走换号模式，更换应用走同账号模式', async ({ page }) => {
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
  await page.getByRole('button', { name: '重新绑定', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('已绑定飞书：原飞书账号');
  await dialog.getByRole('button', { name: '重新绑定', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(1);
  expect(registrationPosts[0]).toEqual({ refresh: false, replaceApp: true, accountRebind: true });
  await expect(page.getByRole('heading', { name: '重新绑定飞书账号并应用', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开飞书重新绑定页面' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/feishu-account-rebind.png', fullPage: true });

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '更换应用', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(2);
  expect(registrationPosts[1]).toEqual({ refresh: false, replaceApp: true, accountRebind: false });
  await expect(page.getByRole('heading', { name: '更换飞书应用', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/feishu-app-replace.png', fullPage: true });
});

test('应用登记完成后立即发起个人授权，不退回到旧状态错误', async ({ page }) => {
  let registrationCompleted = false;
  let bindingMode = 'bound';
  const bindingPosts = [];
  const boundState = {
    bound: true,
    available: true,
    appId: 'cli_fixture123',
    appName: '测试行研应用',
    userName: '原飞书账号',
    notificationReady: true,
  };
  const authorizationState = {
    bound: false,
    available: true,
    appId: 'cli_next123',
    appName: '新行研应用',
    flowId: '33333333-3333-4333-8333-333333333333',
    authorizationUrl: 'https://accounts.feishu.cn/device?code=fixture',
    expiresAt: future(),
    autoCompleting: true,
  };
  const registrationFlow = {
    flowId: '22222222-2222-4222-8222-222222222222',
    status: 'awaiting_scan',
    updatingApp: false,
    authorizationUrl: 'https://open.feishu.cn/page/cli?user_code=fixture',
    expiresAt: future(),
  };

  await page.route('**/api/feishu-binding**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST' && url.pathname === '/api/feishu-binding') {
      bindingPosts.push(route.request().postDataJSON());
      bindingMode = 'authorizing';
      return route.fulfill({ json: authorizationState });
    }
    return route.fulfill({ json: bindingMode === 'bound' ? boundState : authorizationState });
  });

  await page.route('**/api/feishu-registration**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') return route.fulfill({ json: registrationFlow });
    return route.fulfill({ json: { ...registrationFlow, status: registrationCompleted ? 'completed' : 'awaiting_scan' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '重新绑定', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '重新绑定', exact: true }).click();
  await expect(page.getByRole('img', { name: '飞书重新绑定与应用绑定二维码' })).toBeVisible();

  registrationCompleted = true;
  await expect.poll(() => bindingPosts.length).toBe(1);
  expect(bindingPosts[0]).toEqual({ rebind: false, auto: true });
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('扫码后会自动完成授权并关闭窗口');
});

test('已有有效授权二维码时重新打开只恢复流程，不重复发起绑定', async ({ page }) => {
  const posts = [];
  const activeState = {
    bound: false,
    available: true,
    appId: 'cli_fixture123',
    appName: '测试行研应用',
    flowId: '44444444-4444-4444-8444-444444444444',
    authorizationUrl: 'https://accounts.feishu.cn/device?code=active',
    expiresAt: future(),
    autoCompleting: true,
    recovery: {
      code: 'LARK_DPOP_KEY_UNAVAILABLE',
      action: 'authorize',
      automatic: true,
      message: '本机飞书登录密钥不可用，将自动重新发起扫码授权；完成扫码后会自动恢复。',
    },
  };
  await page.route('**/api/feishu-binding**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
    return route.fulfill({ json: activeState });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '绑定飞书', exact: true }).click();
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);
  await expect(page.getByRole('dialog')).toContainText('扫码后会自动完成授权并关闭窗口');
});

test('插件内提供仅供当前profile使用的Bearer兼容登录', async ({ page }) => {
  const posts = [];
  const unavailable = {
    bound: false,
    available: true,
    appId: 'cli_fixture123',
    appName: '测试行研应用',
    recovery: {
      code: 'LARK_DPOP_KEY_UNAVAILABLE',
      action: 'authorize',
      automatic: true,
      message: '本机飞书登录密钥不可用，将自动重新发起扫码授权；完成扫码后会自动恢复。',
    },
  };
  const compatibilityFlow = {
    ...unavailable,
    flowId: '55555555-5555-4555-8555-555555555555',
    authorizationUrl: 'https://accounts.feishu.cn/device?code=compatibility',
    expiresAt: future(),
    autoCompleting: true,
    compatibilityMode: true,
  };
  await page.route('**/api/feishu-binding**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posts.push(body);
      return route.fulfill({ json: body.compatibility ? compatibilityFlow : unavailable });
    }
    return route.fulfill({ json: unavailable });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '绑定飞书', exact: true }).click();
  await expect(page.getByRole('button', { name: '使用兼容登录修复', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '使用兼容登录修复', exact: true }).click();
  await expect.poll(() => posts.some(body => body.compatibility === true)).toBe(true);
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
});
