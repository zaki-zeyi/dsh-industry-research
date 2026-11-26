import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const [url, targetVersion] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url ?? '') || !/^\d+\.\d+\.\d+$/.test(targetVersion ?? '')) {
  throw new Error('Usage: node scripts/desktop-hot-update-acceptance.mjs <running-plugin-url> <published-target-version>');
}
const root = url.replace(/\/$/, '');
const output = resolve('artifacts/desktop-hot-update'); mkdirSync(output, { recursive: true });
function processes() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and ($_.CommandLine -match '--expose-internals' -or $_.CommandLine -notmatch ' --') } | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  return (Array.isArray(value) ? value : [value]).sort((a, b) => a.ProcessId - b.ProcessId);
}
const beforeProcesses = processes(); assert.equal(beforeProcesses.length, 2, 'Desktop shell and Host must both be present');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const read = async path => {
    const response = await page.request.get(root + path);
    if (!response.ok()) throw new Error(`GET ${path} returned ${response.status()}`);
    return response.json();
  };
  async function poll(predicate, label, timeout = 180000) {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
      try { value = await read('/api/plugin-update'); if (predicate(value)) return value; } catch {}
      await new Promise(done => setTimeout(done, 500));
    }
    throw new Error(`${label}: ${value?.state} ${value?.error ?? ''}`);
  }
  const before = await read('/api/plugin-update');
  assert.equal(before.liveActivation, true); assert.notEqual(before.installedVersion, targetVersion);
  const companiesBefore = (await read('/api/industry/library')).companies.map(c => c.name).sort();
  await page.goto(root + '/?view=settings');
  await expect(page.getByLabel('版本信息')).toContainText(before.installedVersion);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await poll(s => s.candidateVersion === targetVersion && s.packageReady, 'verified download');
  await expect(page.getByRole('button', { name: '安装已校验版本', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('button', { name: '安装已校验版本', exact: true }).click();
  const updated = await poll(s => s.installedVersion === targetVersion && s.lastResult === 'updated' && s.progress.percent === 100,
    'in-process activation');
  await expect(page.getByLabel('版本信息')).toContainText(targetVersion, { timeout: 30000 });
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(output, 'version.png') });
  const afterProcesses = processes(); assert.deepEqual(afterProcesses, beforeProcesses, 'DSH shell and Host did not restart');
  const companiesAfter = (await read('/api/industry/library')).companies.map(c => c.name).sort();
  assert.deepEqual(companiesAfter, companiesBefore);
  const logs = await read('/api/runtime-logs?kind=update&limit=100');
  assert.ok(logs.items.some(item => item.event === 'update.completed' && item.details.installedVersion === targetVersion));
  assert.ok(logs.items.some(item => item.event === 'update.health.passed' && item.details.installedVersion === targetVersion));
  await page.getByRole('tab', { name: '平台日志', exact: true }).click();
  await page.getByRole('tab', { name: '更新日志', exact: true }).click();
  await page.getByText('更新完成', { exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(output, 'logs.png') });
  const evidence = { beforeVersion: before.installedVersion, installedVersion: updated.installedVersion,
    bootstrapVersion: updated.bootstrapVersion, progress: updated.progress, lastResult: updated.lastResult,
    beforeProcesses, afterProcesses, companyCount: companiesAfter.length,
    operationId: logs.items.find(item => item.event === 'update.completed' && item.details.installedVersion === targetVersion)?.details.operationId };
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
