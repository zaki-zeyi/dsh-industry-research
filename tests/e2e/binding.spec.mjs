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
  expect(registrationPosts[0]).toEqual({ refresh: false, replaceApp: true, accountRebind: true });
  await expect(page.getByRole('heading', { name: '重新绑定飞书账号并应用', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '打开飞书重新绑定页面' })).toBeVisible();
  const rebindQr = await page.getByRole('img', { name: '飞书重新绑定与应用绑定二维码' }).getAttribute('src');
  await page.screenshot({ path: 'artifacts/feishu-account-rebind.png', fullPage: true });

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '飞书绑定', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '绑定飞书', exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '更换应用', exact: true }).click();
  await expect.poll(() => registrationPosts.length).toBe(2);
  expect(registrationPosts[1]).toEqual({ refresh: false, replaceApp: true, accountRebind: false });
  await expect(page.getByRole('heading', { name: '更换飞书应用', exact: true })).toBeVisible();
  const replaceQr = await page.getByRole('img', { name: '飞书更换应用二维码' }).getAttribute('src');
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
  await expect(page.getByRole('img', { name: '飞书重新绑定与应用绑定二维码' })).toBeVisible();

  registrationCompleted = true;
  await expect.poll(() => bindingPosts.length).toBe(1);
  expect(bindingPosts[0]).toEqual({ rebind: false, auto: true });
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('扫码后会自动完成授权，并展示绑定的账号和应用信息');
  bindingMode = 'bound';
  await expect(page.getByRole('dialog')).toContainText('已绑定飞书：原飞书账号');
  await expect(page.getByRole('dialog').getByRole('button', { name: '更换应用', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '重新绑定', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  await page.getByRole('button', { name: '更新全量信息库', exact: true }).first().click();
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(posts).toEqual([]);
  await expect(page.getByRole('dialog')).toContainText('扫码后会自动完成授权，并展示绑定的账号和应用信息');
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
  await page.getByRole('button', { name: '更新全量信息库', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '使用兼容登录修复', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '使用兼容登录修复', exact: true }).click();
  await expect.poll(() => posts.some(body => body.compatibility === true)).toBe(true);
  await expect(page.getByRole('img', { name: '绑定飞书授权二维码' })).toBeVisible();
});


test('凭据保存失败可在原流程重试，无需再获取扫码二维码',async({page})=>{
 let saves=0,registrations=0;
 const flow={flowId:'99999999-9999-4999-8999-999999999999',status:'failed',canRetrySave:true,phase:'credential_storage',error:'本机保存失败',expiresAt:new Date(Date.now()+600000).toISOString()};
 await page.route('**/api/feishu-registration',route=>{if(route.request().method()==='POST')registrations++;return route.fulfill({json:saves?{...flow,status:'completed'}:flow});});
 await page.route('**/api/feishu-registration/retry',route=>{saves++;expect(route.request().postDataJSON()).toEqual({flowId:flow.flowId});return route.fulfill({json:{...flow,status:'saving'}});});
 const bound={bound:true,available:true,appId:'cli_fixture123',appName:'测试行研应用',userName:'原飞书账号',notificationReady:true};
 await page.route('**/api/feishu-binding',route=>route.fulfill({json:bound}));
 await page.goto('/');await page.getByRole('button',{name:'更换应用',exact:true}).click();
 await page.getByRole('button',{name:'重试保存，无需扫码',exact:true}).click();
 await expect.poll(()=>saves).toBe(1);await expect(page.getByRole('dialog')).toContainText('已绑定飞书：原飞书账号');expect(registrations).toBe(1);
});


test('更换应用前先补充原账号身份授权，通过后才生成应用选择二维码',async({page})=>{
 let reads=0,identityReady=false,registrationPosts=0;
 const bound={bound:true,available:true,appId:'cli_old123',appName:'旧应用',userName:'原账号'};
 const auth={bound:false,available:true,appId:'cli_old123',flowId:'66666666-6666-4666-8666-666666666666',authorizationUrl:'https://accounts.feishu.cn/device?code=fixture',expiresAt:new Date(Date.now()+600000).toISOString(),autoCompleting:true};
 await page.route('**/api/feishu-binding',route=>{if(route.request().method()==='POST')return route.fulfill({json:auth});reads++;return route.fulfill({json:reads===1||identityReady?bound:{...auth,recovery:{code:'LARK_SCOPE_MISSING',action:'authorize',automatic:true,message:'请补充账号身份权限'}}});});
 await page.route('**/api/feishu-binding/qr/*',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==','base64')}));
 await page.route('**/api/feishu-registration',route=>{if(route.request().method()==='POST')registrationPosts++;return route.fulfill({json:{status:'failed',flowId:'55555555-5555-4555-8555-555555555555',error:'应用选择测试',expiresAt:new Date(Date.now()+600000).toISOString()}});});
 await page.goto('/');await page.getByRole('button',{name:'更换应用',exact:true}).click();
 await expect(page.getByRole('img',{name:'绑定飞书授权二维码'})).toBeVisible();expect(registrationPosts).toBe(0);
 identityReady=true;await expect.poll(()=>registrationPosts).toBe(1);await expect(page.getByRole('heading',{name:'更换飞书应用',exact:true})).toBeVisible();
});
