import { test, expect } from '@playwright/test';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==', 'base64');
const future = () => new Date(Date.now() + 600000).toISOString();

test('已绑定后显示账号信息，更换应用与重新绑定使用独立二维码', async ({ page }) => {
  let registrationFlow = null;
  let serial = 0;
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
      serial++;
      registrationFlow = {
        flowId: `${serial}`.repeat(8) + '-2222-4222-8222-222222222222',
        status: 'awaiting_scan',
        updatingApp: false,
        authorizationUrl: `https://open.feishu.cn/page/cli?user_code=fixture-${serial}`,
        expiresAt: future(),
      };
      return route.fulfill({ json: registrationFlow });
    }
    return route.fulfill({ json: registrationFlow ?? { status: 'idle' } });
  });

  await page.goto('/');
  const entryActions = page.getByRole('main').locator('.industry-top');
  await expect(entryActions.getByRole('status', { name: '已绑定飞书：原飞书账号，当前应用：测试行研应用' })).toContainText('已绑定：原飞书账号');
  await expect(entryActions.getByRole('button', { name: '绑定飞书', exact: true })).toHaveCount(0);
  await expect(entryActions.getByRole('button', { name: '更换应用', exact: true })).toBeVisible();
  await expect(entryActions.getByRole('button', { name: '重新绑定', exact: true })).toBeVisible();
  await entryActions.getByRole('button', { name: '重新绑定', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(1);
  expect(registrationPosts[0]).toEqual({ refresh: false });
  await expect(page.getByRole('heading', { name: '扫码登录并绑定应用', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开飞书应用绑定页' })).toBeVisible();
  const rebindQr = await page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' }).getAttribute('src');
  await page.screenshot({ path: 'artifacts/feishu-account-rebind.png', fullPage: true });

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '飞书绑定', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '绑定飞书', exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '更换应用', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(2);
  expect(registrationPosts[1]).toEqual({ refresh: false });
  await expect(page.getByRole('heading', { name: '扫码登录并绑定应用', exact: true })).toBeVisible();
  const replaceQr = await page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' }).getAttribute('src');
  expect(replaceQr).not.toBe(rebindQr);
  await page.screenshot({ path: 'artifacts/feishu-app-replace.png', fullPage: true });
});

test('未绑定时入口只提供绑定飞书，并生成初始绑定二维码', async ({ page }) => {
  const registrationPosts = [];
  await page.route('**/api/feishu-binding**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    return route.fulfill({ json: { bound: false, available: true, appId: 'cli_unbound123', appName: '待绑定应用' } });
  });
  await page.route('**/api/feishu-registration**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') {
      registrationPosts.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          flowId: '66666666-6666-4666-8666-666666666666',
          status: 'awaiting_scan',
          updatingApp: false,
          authorizationUrl: 'https://open.feishu.cn/page/cli?user_code=unbound',
          expiresAt: future(),
        },
      });
    }
    return route.fulfill({ json: { status: 'awaiting_scan' } });
  });

  await page.goto('/');
  const entryActions = page.getByRole('main').locator('.industry-top');
  await expect(entryActions.getByRole('button', { name: '绑定飞书', exact: true })).toBeVisible();
  await expect(entryActions.getByRole('button', { name: '更换应用', exact: true })).toHaveCount(0);
  await expect(entryActions.getByRole('button', { name: '重新绑定', exact: true })).toHaveCount(0);
  await entryActions.getByRole('button', { name: '绑定飞书', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(1);
  expect(registrationPosts[0]).toEqual({ refresh: false });
  await expect(page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' })).toBeVisible();
});

test('应用登记轮询短暂失败后，新状态到达会清除旧错误提示', async ({ page }) => {
  let polls = 0;
  const awaiting = {
    flowId: '77777777-7777-4777-8777-777777777777',
    status: 'awaiting_scan',
    updatingApp: false,
    authorizationUrl: 'https://open.feishu.cn/page/cli?user_code=retry',
    expiresAt: future(),
  };
  await page.route('**/api/feishu-binding**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    return route.fulfill({ json: { bound: false, available: true, appId: 'cli_pollretry123', appName: '重试测试应用' } });
  });
  await page.route('**/api/feishu-registration**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/qr/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (route.request().method() === 'POST') return route.fulfill({ json: awaiting });
    polls++;
    if (polls === 1) return route.fulfill({ status: 503, json: { error: '轮询暂时失败' } });
    return route.fulfill({ json: awaiting });
  });

  await page.goto('/');
  await page.getByRole('main').locator('.industry-top').getByRole('button', { name: '绑定飞书', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('轮询暂时失败');
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' })).toBeVisible();
});

test('应用登记完成后生成个人授权二维码，手动确认后完成绑定', async ({ page }) => {
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
  await expect(page.getByRole('img', { name: '飞书账号登录与应用绑定二维码' })).toBeVisible();

  registrationCompleted = true;
  await expect.poll(() => bindingPosts.length).toBe(1);
  expect(bindingPosts[0]).toEqual({ rebind: true });
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('点击“我已授权”');
  bindingMode = 'bound';
  await page.getByRole('button',{name:'我已授权',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('已绑定飞书：原飞书账号');
  await expect(page.getByRole('dialog').getByRole('button', { name: '更换应用', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '重新绑定', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('已有个人授权二维码可手动确认，打开弹窗不重复交换device code',async({page})=>{
 let posts=0;const active={bound:false,available:true,appId:'cli_active123',flowId:'44444444-4444-4444-8444-444444444444',authorizationUrl:'https://accounts.feishu.cn/device?code=active',expiresAt:future()};
 await page.route('**/api/feishu-binding**',route=>{if(route.request().url().includes('/qr/'))return route.fulfill({contentType:'image/png',body:png});if(route.request().method()==='POST')posts++;return route.fulfill({json:active});});
 await page.route('**/api/feishu-registration**',route=>route.fulfill({json:{status:'idle'}}));
 await page.goto('/');await page.getByRole('button',{name:'绑定飞书',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
 await expect(page.getByRole('img',{name:'绑定飞书授权二维码',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'我已授权',exact:true})).toBeVisible();expect(posts).toBe(0);
});

test('授权异常通过手动重新获取二维码恢复，不自动更改登录方式',async({page})=>{
 const posts=[];const active={bound:false,available:true,appId:'cli_manual123',flowId:'55555555-5555-4555-8555-555555555555',authorizationUrl:'https://accounts.feishu.cn/device?code=manual',expiresAt:future()};
 await page.route('**/api/feishu-binding**',route=>{if(route.request().url().includes('/qr/'))return route.fulfill({contentType:'image/png',body:png});if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:active});}return route.fulfill({json:{bound:false,available:true,appId:'cli_manual123',error:'请重新授权'}});});
 await page.route('**/api/feishu-registration**',route=>route.fulfill({json:{status:'idle'}}));
 await page.goto('/');await page.getByRole('button',{name:'绑定飞书',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();expect(posts).toEqual([]);
 await page.getByRole('button',{name:'重新获取个人授权二维码',exact:true}).click();await expect(page.getByRole('img',{name:'绑定飞书授权二维码',exact:true})).toBeVisible();expect(posts).toEqual([{rebind:true}]);await expect(page.getByRole('button',{name:'我已授权',exact:true})).toBeVisible();
});

test('保存失败保留错误，用户重新获取应用二维码后产生新流程',async({page})=>{
 const posts=[];const failure={status:'failed',flowId:'99999999-9999-4999-8999-999999999999',error:'本机保存失败'};
 const next={status:'awaiting_scan',flowId:'88888888-8888-4888-8888-888888888888',authorizationUrl:'https://open.feishu.cn/page/cli?user_code=retry',expiresAt:future()};
 await page.route('**/api/feishu-registration**',route=>{if(route.request().url().includes('/qr/'))return route.fulfill({contentType:'image/png',body:png});if(route.request().method()==='POST')posts.push(route.request().postDataJSON());return route.fulfill({json:posts.length>1?next:failure});});
 await page.route('**/api/feishu-binding',route=>route.fulfill({json:{bound:true,available:true,appId:'cli_fixture123',userName:'原账号'}}));
 await page.goto('/');await page.getByRole('button',{name:'更换应用',exact:true}).click();await expect(page.getByRole('alert')).toContainText('本机保存失败');await page.getByRole('button',{name:'重新获取应用绑定二维码',exact:true}).click();await expect(page.getByRole('img',{name:'飞书账号登录与应用绑定二维码',exact:true})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);expect(posts).toEqual([{refresh:false},{refresh:true}]);
});

test('更换应用直接进入应用登记，登记前不自动发起个人授权',async({page})=>{
 let personalPosts=0,registrations=0;
 await page.route('**/api/feishu-binding',route=>{if(route.request().method()==='POST')personalPosts++;return route.fulfill({json:{bound:true,available:true,appId:'cli_old123',userName:'原账号'}});});
 await page.route('**/api/feishu-registration**',route=>{if(route.request().url().includes('/qr/'))return route.fulfill({contentType:'image/png',body:png});if(route.request().method()==='POST')registrations++;return route.fulfill({json:{status:'awaiting_scan',flowId:'77777777-7777-4777-8777-777777777777',authorizationUrl:'https://open.feishu.cn/page/cli?user_code=replace',expiresAt:future()}});});
 await page.goto('/');await page.getByRole('button',{name:'更换应用',exact:true}).click();await expect(page.getByRole('heading',{name:'扫码登录并绑定应用',exact:true})).toBeVisible();await expect(page.getByRole('img',{name:'飞书账号登录与应用绑定二维码',exact:true})).toBeVisible();expect(registrations).toBe(1);expect(personalPosts).toBe(0);
});
