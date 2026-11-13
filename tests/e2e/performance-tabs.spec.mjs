import { test, expect } from '@playwright/test';

const card = (id, kind) => ({
  id,
  direction: (kind === 'daily' ? '日报' : '周报') + ' · ' + id,
  status: 'ready',
  stage: 'done',
  createdAt: '2026-11-10T01:00:00.000Z',
  briefing: { kind, window: { display: kind === 'daily' ? '昨日' : '上周' } },
  publication: { status: 'published', url: 'https://example.feishu.cn/docx/' + id },
  notification: {},
});

test('慢响应与快速往返切换都不会串页', async ({ page }) => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/briefings?kind=daily*', async route => {
    await gate;
    return route.fulfill({ json: { items: [card('daily-1', 'daily')], syncedAt: new Date().toISOString() } });
  });
  await page.route('**/api/briefings?kind=weekly*', route => route.fulfill({ json: { items: [card('weekly-1', 'weekly')], syncedAt: new Date().toISOString() } }));
  await page.goto('/');
  await page.getByRole('button', { name: '周报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '周报 · weekly-1' })).toBeVisible();
  await page.getByRole('button', { name: '日报', exact: true }).click();
  await expect(page.getByText('正在读取日报…')).toBeVisible();
  await expect(page.getByRole('heading', { name: '周报 · weekly-1' })).toHaveCount(0);
  await page.getByRole('button', { name: '周报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '周报 · weekly-1' })).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '周报 · weekly-1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '日报 · daily-1' })).toHaveCount(0);
});

test('有缓存时先显示内容，远端同步在后台完成', async ({ page }) => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/briefings?kind=daily*', async route => {
    const refresh = new URL(route.request().url()).searchParams.get('refresh') === 'true';
    if (refresh) { await gate; return route.fulfill({ json: { items: [card('fresh', 'daily')], syncedAt: new Date().toISOString() } }); }
    return route.fulfill({ json: { items: [card('cached', 'daily')], syncedAt: '2020-01-01T00:00:00.000Z' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '日报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '日报 · cached' })).toBeVisible();
  await expect(page.getByText('正在读取日报…')).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: '日报 · fresh' })).toBeVisible();
});

test('同一范围 60 秒内只同步一次，手动刷新才强制同步', async ({ page }) => {
  let refresh = 0;
  await page.route('**/api/briefings?kind=daily*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('refresh') !== 'true') return route.fulfill({ json: { items: [], syncedAt: null } });
    refresh++;
    await new Promise(resolve => setTimeout(resolve, 300));
    return route.fulfill({ json: { items: [card('daily-' + refresh, 'daily')], syncedAt: new Date().toISOString() } });
  });
  await page.route('**/api/briefings?kind=weekly*', route => route.fulfill({ json: { items: [card('weekly-1', 'weekly')], syncedAt: new Date().toISOString() } }));
  await page.goto('/');
  await page.getByRole('button', { name: '日报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '日报 · daily-1' })).toBeVisible();
  await page.getByRole('button', { name: '周报', exact: true }).click();
  await page.getByRole('button', { name: '日报', exact: true }).click();
  await page.waitForTimeout(400);
  expect(refresh).toBe(1);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('heading', { name: '日报 · daily-2' })).toBeVisible();
  expect(refresh).toBe(2);
});

test('同步失败保留卡片并显示错误与重试入口', async ({ page }) => {
  let fail = true;
  await page.route('**/api/briefings?kind=daily*', async route => {
    const refresh = new URL(route.request().url()).searchParams.get('refresh') === 'true';
    if (refresh && fail) return route.fulfill({ status: 502, json: { error: '飞书连接暂时不可用，缓存已保留' } });
    if (refresh) return route.fulfill({ json: { items: [card('fresh', 'daily')], syncedAt: new Date().toISOString() } });
    return route.fulfill({ json: { items: [card('cached', 'daily')], syncedAt: '2020-01-01T00:00:00.000Z' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '日报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '日报 · cached' })).toBeVisible();
  const panel = page.locator('.industry-content');
  await expect(panel.getByRole('alert')).toContainText('飞书连接暂时不可用，缓存已保留');
  await expect(page.getByRole('heading', { name: '日报 · cached' })).toBeVisible();
  fail = false;
  await panel.getByRole('button', { name: '重试同步', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '日报 · fresh' })).toBeVisible();
});

test('内部资料进入后先显示缓存，再后台同步', async ({ page }) => {
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const material = (id, title) => ({ id, direction: title, status: 'ready', stage: 'done', createdAt: '2026-11-10T01:00:00.000Z', internal: { directoryName: '内部资料', sourceType: 'url', source: 'https://example.com/' + id, sourceLabel: title, uploadEligible: false }, publication: { sourceTitle: title }, notification: {} });
  await page.route('**/api/internal-materials*', async route => {
    const refresh = new URL(route.request().url()).searchParams.get('refresh') === 'true';
    if (refresh) { await gate; return route.fulfill({ json: { items: [material('fresh', '新访谈')], syncedAt: new Date().toISOString() } }); }
    return route.fulfill({ json: { items: [material('cached', '缓访谈')], syncedAt: '2020-01-01T00:00:00.000Z' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '内部资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '缓访谈' })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: '新访谈' })).toBeVisible();
});
