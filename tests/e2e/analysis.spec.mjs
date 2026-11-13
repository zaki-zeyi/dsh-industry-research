import { test, expect } from '@playwright/test';

async function waitReady(request, id) {
  await expect.poll(async () => (await (await request.get(`/api/tasks/${id}`)).json()).task.status, { timeout: 15000 }).toBe('ready');
}

test('友商分析：从全量信息库生成报告、浏览历史卡片并回到 AI 会话', async ({ page, request }) => {
  const created = await request.post('/api/industry/tasks', {
    data: { companies: ['后摩智能', '光羽芯辰'], dimensions: ['技术路线'], sources: ['芯东西'], requirements: '' },
  });
  expect(created.status()).toBe(202);
  const task = await created.json();
  await waitReady(request, task.id);

  await page.goto('/');
  await page.locator('.industry-sidebar').getByRole('button', { name: /友商分析/ }).click();
  await expect(page.getByRole('heading', { name: '友商分析', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建友商分析', exact: true }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '新建友商分析' })).toBeVisible();
  await dialog.getByRole('group', { name: '调研公司' }).getByRole('button', { name: '清空', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '后摩智能', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '光羽芯辰', exact: true }).check();
  await dialog.getByRole('group', { name: '对比维度' }).getByRole('button', { name: '清空', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '技术路线', exact: true }).check();
  await expect(dialog.getByLabel('任务 Prompt', { exact: false })).toHaveValue(/对比报告里的数据必须严格来自【全量信息库】/);
  await expect(dialog.getByLabel('任务 Prompt', { exact: false })).toHaveValue(/自动保存到飞书根目录的【友商分析】中/);
  await dialog.getByRole('button', { name: '启动', exact: true }).click();

  await expect(page.getByRole('heading', { name: /友商分析 · 后摩智能 × 光羽芯辰/ })).toBeVisible();
  await expect(page.getByText(/已完成 ·/)).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '← 返回工作台' }).click();
  await expect(page.getByRole('heading', { name: '友商分析', exact: true })).toBeVisible();
  await expect(page.locator('.analysis-report')).toHaveCount(1);
  await expect(page.locator('.analysis-report .company-title')).toHaveAttribute('href', /example\.feishu\.cn\/docx\/AnalysisReport/);
  await page.locator('.analysis-report').getByRole('button', { name: 'AI 会话 ↗' }).click();
  await expect(page.getByRole('heading', { name: /友商分析 · 后摩智能 × 光羽芯辰/ })).toBeVisible();
  await expect(page.getByText('在工作台内继续调研')).toBeVisible();

  const reports = await (await request.get('/api/analysis/reports')).json();
  expect(reports.reports).toHaveLength(1);
  expect(reports.reports[0].taskId).toBeTruthy();
});

test('友商分析：缓存读取后仍展示进行中和失败任务卡片', async ({ page }) => {
  const card = (id, status, error = null) => ({ taskId: id, title: `对比 ${id}`, companies: ['后摩智能', '光羽芯辰'], dimensions: ['技术路线'], status, error, url: null, createdAt: '2026-11-13T00:00:00Z' });
  await page.route('**/api/analysis/reports*', route => route.fulfill({ json: {
    reports: [], tasks: [card('running-comparison', 'running'), card('failed-comparison', 'failed', '报告保存失败')], syncedAt: new Date().toISOString(),
  } }));
  await page.goto('/');
  await page.locator('.industry-sidebar').getByRole('button', { name: /友商分析/ }).click();
  await expect(page.locator('.analysis-report')).toHaveCount(2);
  await expect(page.locator('.analysis-report .company-state.running')).toHaveText('调研中');
  await expect(page.locator('.analysis-report .company-state.failed')).toHaveText('失败');
  await expect(page.locator('.analysis-report').getByText('报告保存失败')).toBeVisible();
  await expect(page.locator('.analysis-report a.company-title')).toHaveCount(0);
});
