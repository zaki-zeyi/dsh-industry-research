import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';

const workbench = 'http://127.0.0.1:3099';
const frame = 'iframe[title="行研工作台"]';

const hostedPage = test.extend({ embed: async ({ page }, use) => {
  let state;
  const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`
    <iframe title="行研工作台" style="width:100%;height:850px" src="${workbench}/?embed=dsh&amp;hostOrigin=${host}&amp;view=settings"></iframe>
    <script>
      window.actions = [];
      let state = ${JSON.stringify(state)};
      const frame = document.querySelector('iframe');
      window.addEventListener('message', event => {
        const {type, requestId, action, version} = event.data ?? {};
        if (event.origin !== '${workbench}' || event.source !== frame.contentWindow || type !== 'industry-research:official-update') return;
        window.actions.push({action, version});
        if (action === 'install') state = {...state, operation: '等待宿主重启', error: 'DSH 已安装新版，当前宿主需要重启后生效', version: null, label: '检查更新'};
        if (action !== 'unwatch') event.source.postMessage({type:'industry-research:official-update-state', requestId, state}, event.origin);
      });
    </script>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  try {
    await use(async value => {
      state = value;
      await page.goto(host);
      return page.frameLocator(frame);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
} });

hostedPage('设置中通过宿主检查和安装完整插件，并显示重启结果', async ({ page, embed }) => {
  await page.route('**/api/plugin-update', route => {
    expect(route.request().method()).toBe('GET');
    return route.continue();
  });
  const workbench = await embed({ runningVersion: '0.13.27', installedVersion: '0.13.27', version: '0.13.28', label: '更新到 0.13.28' });
  await expect(workbench.getByRole('tab', { name: '版本与更新' })).toHaveAttribute('aria-selected', 'true');
  await expect(workbench.getByLabel('版本信息')).toContainText('0.13.27');
  await expect(workbench.getByRole('checkbox', { name: '空闲时自动更新' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: '安装已校验版本' })).toHaveCount(0);
  await workbench.getByRole('button', { name: '重新检查' }).click();
  await workbench.getByRole('button', { name: '更新到 0.13.28' }).click();
  await expect(workbench.getByText('等待宿主重启', { exact: true })).toBeVisible();
  await expect(workbench.getByRole('alert')).toContainText('需要重启后生效');
  expect((await page.evaluate(() => window.actions)).filter(({ action }) => action !== 'watch')).toEqual([
    { action: 'check', version: undefined }, { action: 'install', version: '0.13.28' },
  ]);
  await workbench.getByRole('tab', { name: '平台日志' }).click();
  await expect(workbench.getByRole('heading', { name: '平台日志' })).toBeVisible();
  await expect(workbench.getByRole('tab', { name: '更新日志' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.actions.at(-1).action)).toBe('unwatch');
});

hostedPage('设置显示官方更新不可用原因，不提供安装按钮', async ({ embed }) => {
  const workbench = await embed({ runningVersion: '0.13.27', installedVersion: '0.13.26', label: '检查更新', unavailableReason: '请从 DSH「插件 → 发现」安装固定 Git 提交的版本' });
  await expect(workbench.getByLabel('版本信息')).toContainText('DSH 安装版本：0.13.26');
  await expect(workbench.getByText('请从 DSH「插件 → 发现」安装固定 Git 提交的版本')).toBeVisible();
  await expect(workbench.getByRole('button', { name: /^更新到/ })).toHaveCount(0);
});

test('独立打开工作台时仅显示版本与 DSH 更新说明，更新日志仍可查看', async ({ page }) => {
  await page.route('**/api/runtime-logs?*', async route => route.fulfill({ json: { items: route.request().url().includes('kind=update') ? [
    { seq: 1, at: '2026-11-25T07:00:00Z', event: 'update.official.updated', level: 'info', details: { version: '0.13.28', installedVersion: '0.13.28', operationId: 'update-123' } },
  ] : [] } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '平台日志', exact: true })).toHaveCount(0);
  await page.locator('.industry-top').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toHaveCount(0);
  await expect(page.getByText('请在 DSH 中打开行研工作台以更新插件。')).toBeVisible();
  await expect(page.getByRole('button', { name: '检查更新', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '平台日志' }).click();
  await page.getByRole('tab', { name: '更新日志' }).click();
  await expect(page.getByText('更新完成', { exact: true })).toBeVisible();
  await expect(page.getByText('update-123')).toBeVisible();
});

test('停留在公司资料页时也检测运行版本变化并重新加载资源', async ({ page }) => {
  let version = '0.13.15';
  await page.route('**/api/plugin-update', route => route.fulfill({ json: { installedVersion: version } }));
  await page.goto('/?view=library#keep-task');
  await expect(page.getByRole('heading', { name: '全量信息库', exact: true })).toBeVisible();
  const loaded = page.waitForEvent('load');
  version = '0.13.16';
  await loaded;
  await expect(page).toHaveURL(/view=library#keep-task$/);
  await expect(page.getByRole('heading', { name: '全量信息库', exact: true })).toBeVisible();
});
