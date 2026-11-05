import { test, expect } from '@playwright/test';

async function create(page, direction) {
  await page.goto('/'); await page.getByRole('button',{name:'新建调研',exact:true}).click(); await page.getByLabel('调研方向').fill(direction); await expect(page.getByLabel('任务 Prompt')).toHaveValue(new RegExp(direction)); await page.getByRole('button',{name:'启动调研',exact:true}).click(); await expect(page).toHaveURL(/#.+/); if (!/PTY 页面验收|CLI 页面验收/.test(direction)) await page.getByRole('button',{name:'调研报告',exact:true}).click();
}
test('AC-UI-01 新建、刷新后继续、报告来源、文档链接与历史回放', async ({page,request})=>{
  await create(page,'AI Agent CPU 需求验收');
  const id=new URL(page.url()).hash.slice(1).split('/')[0]; await page.reload();
  await expect(page.getByRole('link',{name:'打开演示文档'})).toBeVisible();
  await expect(page.getByRole('heading',{name:/数据来源/})).toBeVisible();
  await page.getByRole('button',{name:'AI对话',exact:true}).click(); await expect(page.getByText('会话已自动保存')).toBeVisible(); await page.getByRole('button',{name:'调研报告',exact:true}).click();
  const before=(await (await request.get(`/api/tasks/${id}`)).json());
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await expect(page.getByRole('button',{name:/AI Agent CPU 需求验收/}).last().getByText('已完成')).toBeVisible();
  await page.screenshot({path:'test-results/workbench-dashboard.png',fullPage:true});
  await page.getByRole('button',{name:/AI Agent CPU 需求验收/}).last().click();
  await expect(page.getByRole('link',{name:'打开演示文档'})).toBeVisible();
  const after=(await (await request.get(`/api/tasks/${id}`)).json()); expect(after.task.runs.length).toBe(1);expect(after.events).toEqual(before.events);
  const doc=await request.get(after.task.publication.url); expect(doc.ok()).toBeTruthy();expect(await doc.text()).toContain('此页面不是飞书文档');
  await page.screenshot({path:'test-results/workbench-detail.png',fullPage:true});
});
test('AC-UI-02 调研故障可见、草稿保留，重试后报告完成',async({page})=>{
  await create(page,'调研故障验收：恢复草稿'); await expect(page.getByRole('button',{name:'重试调研'})).toBeVisible();await expect(page.getByText('已保存的草稿')).toBeVisible();
  await page.getByRole('button',{name:'重试调研'}).click(); await expect(page.getByRole('link',{name:'打开演示文档'})).toBeVisible(); await expect(page.getByText('2 次执行')).toBeVisible();
});
test('AC-UI-03 发布失败仅重试发布，不重复 AI 执行和文档',async({page,request})=>{
  await create(page,'发布故障验收：复用文档');await expect(page.getByRole('button',{name:'重试保存'})).toBeVisible();
  const id=new URL(page.url()).hash.slice(1).split('/')[0];const before=(await (await request.get(`/api/tasks/${id}`)).json()).task;
  await page.getByRole('button',{name:'重试保存'}).click();await expect(page.getByRole('link',{name:'打开演示文档'})).toBeVisible();
  const after=(await (await request.get(`/api/tasks/${id}`)).json()).task;expect(after.publication.documentId).toBe(before.publication.documentId);expect(after.runs.length).toBe(1);expect(after.report).toEqual(before.report);
});
test('AC-UI-04 创建校验、默认 Prompt、搜索与移动端布局',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'新建调研',exact:true}).click();await expect(page.getByRole('button',{name:'启动调研'})).toBeDisabled();
  await page.getByLabel('调研方向').fill('验收主题');await expect(page.getByLabel('任务 Prompt')).toHaveValue('帮我在【全网】进行【验收主题】的调研，整理成带数据来源的报告。报告上传到飞书云盘根目录【行研工作台】。');
  await page.getByLabel('数据来源').selectOption('custom');await expect(page.getByRole('button',{name:'启动调研'})).toBeDisabled();await page.getByLabel('指定数据来源').fill('https://example.com');await expect(page.getByLabel('任务 Prompt')).toHaveValue(/https:\/\/example.com/);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByLabel('搜索调研').fill('不存在的主题-xyz');await expect(page.getByText('没有匹配的调研')).toBeVisible();await page.getByLabel('搜索调研').clear();
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'行研工作台.'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:'test-results/workbench-mobile.png',fullPage:true});
});
test('AC-UI-05 Codex 命令行实时展示、命令输出合并与刷新回放', async ({page, request}) => {
  await create(page, 'CLI 页面验收：实时命令行');
  await expect(page.getByText('Codex 命令行对话', {exact:true})).toBeVisible();
  await expect(page.getByRole('log', {name:'Codex 命令行对话记录'}).getByText('已收到调研 Prompt，开始整理资料。')).toBeVisible();
  await expect(page.locator('[data-item-id="cmd-1"]')).toHaveCount(1);
  await expect(page.locator('[data-item-id="cmd-1"]')).toContainText('CLI_STREAM_OK');
  await expect(page.locator('[data-item-id="cmd-1"]')).toContainText('退出码 0');
  const id = new URL(page.url()).hash.slice(1).split('/')[0]; const before = await (await request.get(`/api/tasks/${id}`)).json();
  await page.reload(); await expect(page.locator('[data-item-id="cmd-1"]')).toContainText('CLI_STREAM_OK'); await expect(page.locator('[data-item-id="cmd-1"]')).toHaveCount(1);
  const after = await (await request.get(`/api/tasks/${id}`)).json(); expect(after.events).toEqual(before.events); expect(after.task.runs.length).toBe(1);
  await page.screenshot({path:'test-results/codex-conversation.png',fullPage:true});
  await page.getByRole('button', {name:'调研报告',exact:true}).click(); await expect(page.getByRole('link', {name:'打开本地报告'})).toBeVisible();
});
test('AC-UI-06 原生终端输入、刷新重连、报告交付及继续会话', async ({page, request}) => {
  await create(page, 'PTY 页面验收：直接终端映射');
  const panel = page.getByRole('region', {name:'Codex 原生终端'});
  await expect(panel).toBeVisible(); await expect(panel.locator('.xterm-screen')).toBeVisible();
  await expect(panel.getByLabel('Codex 会话权限')).toContainText('完整访问');
  const id = new URL(page.url()).hash.slice(1).split('/')[0];
  await expect.poll(async () => { const d = await (await request.get(`/api/tasks/${id}`)).json(); return Boolean(d.task.terminalId); }).toBeTruthy();
  const input = panel.locator('.xterm-helper-textarea');
  await input.focus(); await input.pressSequentially('hello'); await input.press('Enter');
  await page.reload(); await expect(page.getByRole('region', {name:'Codex 原生终端'})).toBeVisible();
  await page.getByRole('region', {name:'Codex 原生终端'}).locator('.xterm-helper-textarea').focus();
  await page.getByRole('region', {name:'Codex 原生终端'}).locator('.xterm-helper-textarea').pressSequentially('REPEAT_REPORT');
  await page.getByRole('region', {name:'Codex 原生终端'}).locator('.xterm-helper-textarea').press('Enter');
  await expect(page.getByRole('button', {name:'调研报告',exact:true})).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('等待新要求');
  await page.reload(); await expect(panel.getByRole('status')).toHaveText('等待新要求');
  await expect(panel.getByLabel('Codex 会话权限')).toContainText('完整访问');
  await panel.locator('.xterm-helper-textarea').focus(); await panel.locator('.xterm-helper-textarea').pressSequentially('continue'); await panel.locator('.xterm-helper-textarea').press('Enter');
  await expect(panel.getByRole('status')).toHaveText('等待新要求');
  const d = await (await request.get(`/api/tasks/${id}`)).json(); expect(d.task.runs.length).toBe(1);
  await page.screenshot({path:'test-results/native-terminal.png',fullPage:true});
  await page.getByRole('button', {name:'调研报告',exact:true}).click(); await expect(page.getByRole('heading', {name:'原生终端验收报告'}).first()).toBeVisible();
  await page.getByRole('button', {name:'AI对话',exact:true}).click(); await expect(page.getByRole('region', {name:'Codex 原生终端'})).toBeVisible();
});

test('AC-UI-07 报告生成后点击上传飞书，Agent 回传授权二维码，继续保存不重跑', async ({page, request}) => {
  await create(page, 'PTY 页面验收：Agent 负责飞书保存');
  const input = page.getByRole('region', {name:'Codex 原生终端'}).locator('.xterm-helper-textarea');
  await input.focus(); await input.pressSequentially('REPORT'); await input.press('Enter');
  const delivery = page.getByRole('region', {name:'Agent 飞书交付'});
  await expect(delivery.getByRole('button', {name:'上传飞书',exact:true})).toBeEnabled();
  await expect(delivery.getByRole('link', {name:'打开飞书授权页'})).toHaveCount(0);
  await page.screenshot({path:'test-results/manual-upload.png',fullPage:true});
  await delivery.getByRole('button', {name:'上传飞书',exact:true}).click();
  await expect(delivery.getByText('请扫码授权飞书', {exact:true})).toBeVisible();
  await expect(delivery.getByRole('link', {name:'打开飞书授权页'})).toHaveAttribute('href', 'https://accounts.feishu.cn/device?user_code=fixture');
  const qr = delivery.getByRole('img', {name:'Agent 生成的飞书授权二维码'}); await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate(el => el.complete && el.naturalWidth > 0)).toBeTruthy();
  await expect(page.getByRole('button', {name:'上传到飞书',exact:true})).toHaveCount(0);
  const id = new URL(page.url()).hash.slice(1).split('/')[0]; const before = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  await page.getByRole('button', {name:'返回',exact:true}).click();
  await page.getByRole('button', {name:'进行中',exact:true}).click();
  const card = page.getByRole('button', {name:/PTY 页面验收：Agent 负责飞书保存/}).last(); await expect(card).toContainText('待飞书授权'); await card.click();
  await page.reload(); await expect(delivery.getByText('请扫码授权飞书', {exact:true})).toBeVisible();
  await expect(page.getByRole('region', {name:'Codex 原生终端'})).toHaveCount(0); await page.getByRole('button', {name:'AI对话',exact:true}).click();
  await expect(page.getByRole('region', {name:'Codex 原生终端'}).getByRole('status')).toHaveText('等待新要求');
  await input.focus(); await input.pressSequentially('AUTHORIZED'); await input.press('Enter');
  await expect(delivery.getByRole('link', {name:'打开飞书文档',exact:true})).toHaveAttribute('href', 'https://example.feishu.cn/docx/agentReport123');
  await expect(delivery.getByRole('img', {name:'Agent 生成的飞书授权二维码'})).toHaveCount(0);
  const after = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(after.report).toEqual(before.report); expect(after.runs).toEqual(before.runs);
  await page.screenshot({path:'test-results/agent-delivery.png',fullPage:true});
});

test('AC-UI-08 上传失败可单独重试，报告不变且不增加调研次数', async ({page, request}) => {
  await create(page, 'PTY 页面验收：保存失败验收');
  const input = page.getByRole('region', {name:'Codex 原生终端'}).locator('.xterm-helper-textarea');
  await input.focus(); await input.pressSequentially('REPORT'); await input.press('Enter');
  const id = new URL(page.url()).hash.slice(1).split('/')[0]; const panel = page.getByRole('region', {name:'Agent 飞书交付'});
  await expect(panel.getByRole('button', {name:'上传飞书',exact:true})).toBeEnabled();
  const before = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  await panel.getByRole('button', {name:'上传飞书',exact:true}).click();
  await expect(panel.getByText('验收注入：保存失败，请重试上传')).toBeVisible();
  await panel.getByRole('button', {name:'重试上传飞书',exact:true}).click();
  await expect(panel.getByRole('link', {name:'打开飞书文档',exact:true})).toBeVisible();
  const after = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(after.report).toEqual(before.report); expect(after.runs).toEqual(before.runs); expect(after.terminalId).toBe(before.terminalId);
});


test('AC-UI-09 dsh 嵌入模式保留调研入口且不出现重复侧栏', async ({ page }) => {
  await page.goto('/?embed=dsh');
  await expect(page.getByRole('heading', { name: '行研工作台.' })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button', { name: '新建调研', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 800, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});


test('AC-UI-10 历史卡片默认报告，AI对话恢复原会话，刷新与前进后退保留视图', async ({ page, request }) => {
  await create(page, 'PTY 页面验收：历史报告优先');
  const terminal = page.getByRole('region', { name: 'Codex 原生终端' });
  const input = terminal.locator('.xterm-helper-textarea');
  await expect(terminal).toBeVisible();
  await input.focus(); await input.pressSequentially('REPORT'); await input.press('Enter');
  await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  const id = new URL(page.url()).hash.slice(1).split('/')[0];
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task.status).toBe('ready');
  const before = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  await page.getByRole('button', { name: '返回', exact: true }).click();
  let sockets = 0; page.on('websocket', () => sockets++);
  await page.locator('.research-card').filter({ hasText: '历史报告优先' }).click();
  await expect(page).toHaveURL(new RegExp(`#${id}$`));
  await expect(page.getByRole('heading', { name: '原生终端验收报告' }).first()).toBeVisible();
  await expect(terminal).toHaveCount(0); expect(sockets).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '原生终端验收报告' }).first()).toBeVisible(); expect(sockets).toBe(0);
  await page.screenshot({ path: 'test-results/history-report-default.png', fullPage: true });
  await page.getByRole('button', { name: 'AI对话', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#${id}/chat$`));
  await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  await page.reload(); await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  await page.goBack(); await expect(terminal).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '原生终端验收报告' }).first()).toBeVisible();
  await page.goForward(); await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  await input.focus(); await input.pressSequentially('continue'); await input.press('Enter');
  await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  const after = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(after.terminalId).toBe(before.terminalId); expect(after.runs).toEqual(before.runs); expect(after.report).toEqual(before.report);
});

test('AC-UI-11 带时区授权回执显示二维码，图片暂不可用时自动重试', async ({ page }) => {
  let qrRequests = 0;
  await page.route('**/agent-qr?*', async route => {
    qrRequests++;
    if (qrRequests === 1) await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not ready"}' });
    else await route.continue();
  });
  await create(page, 'PTY 页面验收：授权二维码时区');
  const input = page.getByRole('region', { name: 'Codex 原生终端' }).locator('.xterm-helper-textarea');
  await input.focus(); await input.pressSequentially('REPORT'); await input.press('Enter');
  await page.getByRole('button', { name: '上传飞书', exact: true }).click();
  await expect(page.getByText('请扫码授权飞书', { exact: true })).toBeVisible();
  const qr = page.getByRole('img', { name: 'Agent 生成的飞书授权二维码' });
  await expect.poll(async () => await qr.count() > 0 && await qr.evaluate(el => el.complete && el.naturalWidth > 0)).toBeTruthy();
  expect(qrRequests).toBeGreaterThanOrEqual(2);
});

test('AC-UI-12 授权二维码过期后可在原会话重新获取，不重复调研', async ({ page, request }) => {
  await create(page, 'PTY 页面验收：二维码过期');
  const terminal = page.getByRole('region', { name: 'Codex 原生终端' }), input = terminal.locator('.xterm-helper-textarea');
  await input.focus(); await input.pressSequentially('REPORT'); await input.press('Enter');
  const id = new URL(page.url()).hash.slice(1).split('/')[0];
  await page.getByRole('button', { name: '上传飞书', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新获取授权二维码', exact: true })).toBeVisible();
  await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  const before = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  await page.getByRole('button', { name: '重新获取授权二维码', exact: true }).click();
  await expect(page.getByRole('link', { name: '打开飞书授权页' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Agent 生成的飞书授权二维码' })).toBeVisible();
  const after = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(after.publication.requestId).not.toBe(before.publication.requestId);
  expect(after.terminalId).toBe(before.terminalId); expect(after.report).toEqual(before.report); expect(after.runs).toEqual(before.runs);
});

test('AC-UI-13 配置AI选择DSH使用原生配置，历史任务不随配置切换', async ({ page, request }) => {
  await page.goto('/'); await page.getByRole('button', { name: '配置AI', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('Base URL')).toHaveCount(0); await expect(dialog.getByLabel('API Key')).toHaveCount(0);
  await dialog.getByLabel('选择agent').selectOption('dsh'); await expect(dialog.getByText(/使用 DSH 已配置的默认模型/)).toBeVisible();
  await dialog.getByRole('button', { name: '保存配置' }).click(); await expect(dialog).toHaveCount(0);
  expect(await (await request.get('/api/ai-settings')).text()).not.toContain('ui-private-api-key');
  await page.reload(); await page.getByRole('button', { name: '配置AI', exact: true }).click();
  await expect(dialog.getByLabel('选择agent')).toHaveValue('dsh'); await expect(dialog.getByLabel('API Key')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭AI配置' }).click();
  await create(page, 'PTY 页面验收：DSH配置持久化');
  const terminal = page.getByRole('region', { name: 'dsh tui 原生终端' }); await expect(terminal).toBeVisible();
  await expect(terminal.getByRole('status')).toHaveText('等待新要求');
  const id = new URL(page.url()).hash.slice(1).split('/')[0];
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task.status).toBe('ready');
  const before = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  await page.getByRole('button', { name: '配置AI', exact: true }).click(); await dialog.getByLabel('选择agent').selectOption('codex');
  await dialog.getByRole('button', { name: '保存配置' }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '调研报告', exact: true }).click(); await expect(page.getByRole('heading', { name: 'DSH 原生终端报告' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'AI对话', exact: true }).click(); await expect(terminal).toBeVisible();
  await page.getByRole('button', { name: '上传飞书', exact: true }).click();
  await expect(page.getByRole('link', { name: '打开飞书文档', exact: true })).toHaveAttribute('href', 'https://example.feishu.cn/docx/dshReport123');
  const after = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  expect(after.ai).toEqual(before.ai); expect(after.terminalId).toBe(before.terminalId); expect(after.runs).toEqual(before.runs);
});

test('AC-UI-14 配置只提交Agent选择，未安装DSH时显示可处理错误', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '配置AI', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('选择agent').selectOption('dsh');
  await expect(dialog.getByLabel('API Key')).toHaveCount(0); await expect(dialog.getByLabel('Base URL')).toHaveCount(0);
  await page.route('**/api/ai-settings', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    expect(route.request().postDataJSON()).toEqual({ agent: 'dsh' });
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '尚未安装 dsh tui，请先安装匹配当前 dsh 版本的 TUI 插件' }) });
  });
  await dialog.getByRole('button', { name: '保存配置' }).click(); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('尚未安装 dsh tui');
  await page.unroute('**/api/ai-settings'); await dialog.getByRole('button', { name: '保存配置' }).click(); await expect(dialog).toHaveCount(0);
});

test('AC-UI-15 报告与AI对话均可返回工作台，重新打开不重复调研', async ({ page, request }) => {
  await request.put('/api/ai-settings', { data: { agent: 'codex' } });
  await create(page, '返回入口统一验收'); await expect(page.getByRole('link', { name: '打开演示文档' })).toBeVisible();
  const id = new URL(page.url()).hash.slice(1).split('/')[0], before = (await (await request.get(`/api/tasks/${id}`)).json()).task;
  await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(page.getByRole('button', { name: '新建调研', exact: true })).toBeVisible();
  await page.locator('.research-card').filter({ hasText: '返回入口统一验收' }).click();
  await page.getByRole('button', { name: 'AI对话', exact: true }).click(); await expect(page.getByRole('button', { name: '返回', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(page.locator('.research-card').filter({ hasText: '返回入口统一验收' })).toBeVisible();
  const after = (await (await request.get(`/api/tasks/${id}`)).json()).task; expect(after.runs).toEqual(before.runs); expect(after.report).toEqual(before.report);
});

test('AC-UI-17 飞书根目录设置、Prompt 联动与刷新保留', async ({ page, request }) => {
  await page.goto('/'); await page.getByRole('button', { name: '设置飞书根目录', exact: true }).click();
  await expect(page.getByLabel('根目录名字')).toHaveValue('行研工作台');
  await page.getByLabel('根目录名字').fill('产业研究'); await page.getByRole('button', { name: '保存设置并导入', exact: true }).click();
  await page.getByRole('button', { name: '新建调研', exact: true }).click();
  await expect(page.getByLabel('任务 Prompt')).toHaveValue(/飞书云盘根目录【产业研究】/);
  await expect(page.locator('.destination')).toContainText('产业研究');
  await page.keyboard.press('Escape'); await page.reload();
  await page.getByRole('button', { name: '设置飞书根目录', exact: true }).click(); await expect(page.getByLabel('根目录名字')).toHaveValue('产业研究');
  await page.getByLabel('根目录名字').fill(''); await expect(page.getByRole('button', { name: '保存设置并导入', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await request.put('/api/feishu-settings', { data: { rootName: '行研工作台' } });
});

test('AC-UI-18 已发布报告卡片链接到飞书，AI会话按钮独立进入原会话', async ({ page, request }) => {
  const created = await (await request.post('/api/tasks', { data: { direction: '飞书卡片入口验收' } })).json();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${created.id}`)).json()).task.status).toBe('ready');
  const url = 'https://example.feishu.cn/docx/cardReport';
  await page.route('**/api/tasks', async route => {
    const response = await route.fetch(), body = await response.json();
    body.items = body.items.map(t => t.id === created.id ? { ...t, publication: { target: 'feishu', status: 'published', url } } : t);
    await route.fulfill({ response, json: body });
  });
  await page.goto('/'); const card = page.locator('.research-card').filter({ hasText: '飞书卡片入口验收' });
  await expect(card.getByRole('link')).toHaveAttribute('href', url); await expect(card.getByRole('link')).toHaveAttribute('target', '_blank');
  await card.getByRole('button', { name: 'AI会话', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`#${created.id}/chat$`));
  await expect(page.getByRole('button', { name: 'AI对话', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: '返回', exact: true }).click(); await expect(card).toBeVisible();
});

test('AC-UI-19 目标文件夹链接保存ID、刷新保留，拒绝文档与外站链接',async({page,request})=>{
 await page.goto('/');await page.getByRole('button',{name:'设置飞书根目录',exact:true}).click();await page.getByRole('radio',{name:'使用文件夹链接',exact:true}).check();
 await page.getByLabel('飞书文件夹链接',{exact:true}).fill('https://evil.example/drive/folder/token');await page.getByRole('button',{name:'保存设置并导入',exact:true}).click();await expect(page.getByRole('alert')).toContainText('飞书文件夹');
 await page.getByLabel('飞书文件夹链接',{exact:true}).fill('https://tenant.feishu.cn/docx/document123');await page.getByRole('button',{name:'保存设置并导入',exact:true}).click();await expect(page.getByRole('alert')).toContainText('飞书文件夹');
 const url='https://tenant.feishu.cn/drive/folder/uiFolder123';await page.getByLabel('飞书文件夹链接',{exact:true}).fill(url);await page.getByRole('button',{name:'保存设置并导入',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect((await(await request.get('/api/feishu-settings')).json()).folderToken).toBe('uiFolder123');await page.reload();await page.getByRole('button',{name:'设置飞书根目录',exact:true}).click();await expect(page.getByLabel('飞书文件夹链接',{exact:true})).toHaveValue(url);await page.keyboard.press('Escape');
 await request.put('/api/feishu-settings',{data:{rootName:'行研工作台',folderUrl:''}});
});

test('AC-UI-20 目录名字或链接二选一，链接独立提交及Prompt联动，切换后不携带隐藏值',async({page,request})=>{
 await page.goto('/');await page.getByRole('button',{name:'设置飞书根目录',exact:true}).click();
 await page.getByRole('radio',{name:'使用文件夹链接',exact:true}).check();await expect(page.getByLabel('根目录名字',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'保存设置并导入',exact:true})).toBeDisabled();
 const folderUrl='https://tenant.feishu.cn/drive/folder/choiceFolder456';await page.getByLabel('飞书文件夹链接',{exact:true}).fill(folderUrl);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:'test-results/root-link-mode.png',fullPage:true});
 const submitted=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/feishu-settings/import'));await page.getByRole('button',{name:'保存设置并导入',exact:true}).click();expect((await submitted).postDataJSON()).toEqual({folderUrl});
 await page.getByRole('button',{name:'新建调研',exact:true}).click();await expect(page.getByLabel('任务 Prompt')).toHaveValue(new RegExp('指定飞书文件夹'));await expect(page.getByLabel('任务 Prompt')).toHaveValue(new RegExp('choiceFolder456'));await expect(page.locator('.destination')).toContainText('指定文件夹');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'设置飞书根目录',exact:true}).click();await expect(page.getByRole('radio',{name:'使用文件夹链接',exact:true})).toBeChecked();await page.getByRole('radio',{name:'按名字创建',exact:true}).check();await expect(page.getByLabel('飞书文件夹链接',{exact:true})).toHaveCount(0);await page.getByLabel('根目录名字',{exact:true}).fill('二选一目录');
 const nameSubmit=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/feishu-settings/import'));await page.getByRole('button',{name:'保存设置并导入',exact:true}).click();expect((await nameSubmit).postDataJSON()).toEqual({rootName:'二选一目录'});expect((await(await request.get('/api/feishu-settings')).json()).folderUrl).toBeUndefined();
 await request.put('/api/feishu-settings',{data:{rootName:'行研工作台'}});
});
