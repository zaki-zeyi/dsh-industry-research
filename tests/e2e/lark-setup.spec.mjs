import { test, expect } from '@playwright/test';

const install = { documentationUrl: 'https://github.com/larksuite/cli#installation--quick-start', nodeUrl: 'https://nodejs.org/en/download', windowsCommand: 'npx.cmd --yes @larksuite/cli@latest install', unixCommand: 'npx --yes @larksuite/cli@latest install' };
test('全局飞书环境：未安装时展示官方指引，安装后检测恢复且不触碰绑定', async ({ page }) => {
  let ready = false; const writes = [];
  page.on('request', r => { if (r.method() !== 'GET' && /feishu-(?:binding|registration|application)/.test(r.url())) writes.push(r.url()); });
  await page.route('**/api/feishu-cli', route => route.fulfill({ json: { install, platform: 'win32', status: ready ? 'ready' : 'missing', version: ready ? '1.2.3' : undefined, message: '未找到飞书 CLI，请安装官方 CLI 后重新检测' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '平台日志', exact: true }).click();
  await page.getByRole('tab', { name: '飞书连接监测', exact: true }).click();
  const setup = page.getByRole('region', { name: '飞书 CLI 环境', exact: true });
  await expect(setup.getByLabel('官方安装命令', { exact: true })).toHaveValue(install.windowsCommand);
  await expect(setup.getByRole('link', { name: '官方安装说明' })).toHaveAttribute('href', install.documentationUrl);
  await expect(setup.getByText(/网页版请在服务所在机器安装/)).toBeVisible();
  await page.screenshot({ path: 'artifacts/lark-setup-guide.png', fullPage: true });
  ready = true; await setup.getByRole('button', { name: '重新检测 CLI' }).click();
  await expect(setup.getByText('CLI 可用 · 1.2.3', { exact: true })).toBeVisible();
  await expect(setup.getByLabel('官方安装命令', { exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('绑定前CLI缺失时显示安装帮助，不误导用户重复扫码', async ({ page }) => {
  await page.route('**/api/feishu-cli', route => route.fulfill({ json: { install, platform: 'win32', status: 'missing', message: '未找到飞书 CLI' } }));
  await page.route('**/api/feishu-binding', route => route.fulfill({ json: { bound: false, available: false, code: 'LARK_CLI_NOT_FOUND', error: '未找到飞书 CLI' } }));
  await page.route('**/api/feishu-registration', route => route.fulfill({ status: 503, json: { code: 'LARK_CLI_NOT_FOUND', error: '未找到飞书 CLI，请先安装或修复' } }));
  await page.goto('/'); await page.getByRole('button', { name: '绑定飞书', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('官方安装命令', { exact: true })).toHaveValue(install.windowsCommand);
  await expect(dialog.getByAltText('飞书账号登录与应用绑定二维码')).toHaveCount(0);
});

test('页签报错可直接打开统一环境检查，不需要离开当前页面', async ({ page }) => {
  await page.route('**/api/feishu-cli', route => route.fulfill({ json: { install, platform: 'win32', status: 'missing', message: '未找到飞书 CLI' } }));
  await page.route('**/api/industry/library*', route => route.fulfill({ status: 503, json: { error: '未找到 Lark CLI，请检查安装路径' } }));
  await page.goto('/'); await page.getByRole('button', { name: '检查飞书环境', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '飞书环境检查' });
  await expect(dialog.getByLabel('官方安装命令', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭飞书环境检查' }).click(); await expect(dialog).toHaveCount(0);
});
