import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const [endpoint, version] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? '') || !/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: <desktop-cdp-url> <published-target-version>');
const output = resolve('artifacts/official-git-update', version);
mkdirSync(output, { recursive: true });
function processes() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and ($_.CommandLine -match '--expose-internals' -or $_.CommandLine -notmatch ' --type') } | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); return JSON.parse(result.stdout).sort((a, b) => a.ProcessId - b.ProcessId);
}
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('dsh-app://'));
  assert.ok(page, 'Use the actual desktop DSH page');
  const read = path => page.evaluate(async path => {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    const value = await response.json(); delete value.actionToken; return value;
  }, path);
  const status = await read('/industry-research/status'), before = await read('/industry-research/official-update');
  assert.equal(before.eligible, true); assert.notEqual(before.installedVersion, version);
  const companies = async url => {
    const response = await fetch(url + '/api/industry/library'); assert.equal(response.ok, true);
    const names = (await response.json()).companies.map(row => row.name).sort();
    return { count: names.length, digest: createHash('sha256').update(JSON.stringify(names)).digest('hex') };
  };
  const companiesBefore = await companies(status.url), beforeProcesses = processes();
  assert.equal(beforeProcesses.length, 2, 'One desktop shell and one Host');
  async function details() {
    if (await page.getByLabel('行研工作台官方 Git 更新').isVisible()) return;
    await page.getByRole('button', { name: '插件', exact: true }).first().click();
    if (!await page.getByRole('button', { name: '查看 dsh-industry-research', exact: true }).count() &&
      await page.getByRole('button', { name: '插件', exact: true }).count() > 1) {
      await page.getByRole('button', { name: '插件', exact: true }).last().click();
    }
    await page.getByRole('button', { name: '查看 dsh-industry-research', exact: true }).click();
    await expect(page.getByLabel('行研工作台官方 Git 更新')).toBeVisible({ timeout: 30000 });
  }
  await details();
  const controls = page.getByLabel('行研工作台官方 Git 更新');
  if (await controls.getByRole('button', { name: '重新检查', exact: true }).count()) await controls.getByRole('button', { name: '重新检查', exact: true }).click();
  else await controls.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(controls.getByRole('button', { name: `更新到 ${version}`, exact: true })).toBeEnabled({ timeout: 45000 });
  await expect(page.getByText('可更新', { exact: true })).toBeVisible();
  await controls.screenshot({ path: resolve(output, 'before.png') });
  await controls.getByRole('button', { name: `更新到 ${version}`, exact: true }).click();
  const deadline = Date.now() + 10 * 60 * 1000;
  let after;
  const phases = new Set();
  while (Date.now() < deadline) {
    try { after = await read('/industry-research/official-update'); } catch { after = null; }
    if (after?.operation) {
      phases.add(after.operation.state);
      if (after.operation.version === version && ['updated', 'failed', 'restored', 'restart-required', 'interrupted'].includes(after.operation.state)) break;
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  assert.equal(after?.operation?.state, 'updated', JSON.stringify(after));
  assert.equal(after.installedVersion, version); assert.equal(after.runningVersion, version); assert.equal(after.eligible, true);
  assert.match(after.source, /#[a-f0-9]{40}$/);
  const running = await read('/industry-research/status'); assert.equal(running.state, 'ready'); assert.equal(running.version, version);
  const health = await (await fetch(running.url + '/api/health')).json(); assert.equal(health.version, version); assert.equal(health.ready, true);
  const afterProcesses = processes(); assert.deepEqual(afterProcesses, beforeProcesses, 'Official Git update did not restart DSH');
  const companiesAfter = await companies(running.url); assert.deepEqual(companiesAfter, companiesBefore);
  // HMR can temporarily remove a bundle from the list; inspect its final detail page again.
  await details();
  await expect(page.getByLabel('行研工作台官方 Git 更新')).toContainText('更新完成', { timeout: 30000 });
  await page.getByLabel('行研工作台官方 Git 更新').screenshot({ path: resolve(output, 'after.png') });
  await page.getByLabel('行研工作台更新服务').screenshot({ path: resolve(output, 'result.png') });
  const result = { beforeVersion: before.installedVersion, installedVersion: after.installedVersion, runningVersion: running.version,
    source: after.source, operation: after.operation, observedPhases: [...phases], beforeProcesses, afterProcesses, companiesBefore, companiesAfter };
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
