import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), dir = mkdtempSync(resolve(tmpdir(), 'native-host-')), profile = resolve(dir, 'profiles/native-test');
mkdirSync(resolve(profile, 'node_modules'), { recursive: true }); symlinkSync(root, resolve(profile, 'node_modules/dsh-industry-research'), 'junction');
writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'native-host-test', private: true, dependencies: { 'dsh-industry-research': `link:${root}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-industry-research'] } } }));
const report = { title: '真实宿主原生会话验收报告', summary: '本报告由隔离的真实 DSH 宿主与本机模拟模型接口协作生成。', markdown: '本验收通过真实宿主的 Session Controller 创建会话、设定完整权限、提交任务并接收原生轮次事件。报告文件由本机模型测试夹具交付，验证工作台正确读取结构化结果并保留会话绑定。[S1]', sources: [{ id: 'S1', title: '本机模拟证据', url: 'https://example.com/native-host', excerpt: '本来源为验收夹具，用于验证本机真实宿主的会话与报告协议。' }] };
let modelCalls = 0, browser, page, followUpObserved = false;
const fakeLark = resolve(dir, 'fake-lark');
writeFileSync(fakeLark, `#!/usr/bin/env node
const fs=require('fs'),file=${JSON.stringify(resolve(dir,'fake-lark-profiles.json'))};let profiles={};try{profiles=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
const args=process.argv.slice(2);
if(args[0]==='profile'){
 process.stdin.resume();process.stdin.on('end',()=>{profiles[args[args.indexOf('--name')+1]]=args[args.indexOf('--app-id')+1];fs.writeFileSync(file,JSON.stringify(profiles));console.log('saved');});
}else{
 const profile=args[0]==='--profile'?args[1]:null;
 console.log(JSON.stringify({appId:profile?profiles[profile]:'cli_default123',identities:{user:{available:true,verified:true,userName:'验收用户',scope:'docx:document:create docx:document:write_only docx:document:readonly docs:document:import drive:drive.metadata:readonly space:folder:create offline_access'}}}));
}
`); chmodSync(fakeLark, 0o700);
const model = createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  if (!req.url.includes('/messages')) { res.writeHead(404).end(); return; }
  modelCalls++; const body = JSON.parse(text);
  const input = JSON.stringify(body.messages ?? []); if (body.tools?.length && input.includes('针对这份报告补充解释')) followUpObserved = true; const match = [...input.matchAll(/请读取 (.+?prompt-[a-f0-9-]+\.txt)，按照/g)].at(-1);
  if (match && body.tools?.length) {
    const prompt = readFileSync(match[1], 'utf8');
    if (prompt.includes('本次报告仅存储在飞书云文档')) {
      const receiptPath = /原子更新 (.+)，本次 requestId/.exec(prompt)[1], requestId = /本次 requestId 固定为 ([a-f0-9-]+)/.exec(prompt)[1];
      writeFileSync(receiptPath, JSON.stringify({ requestId, status: 'published', folderToken: /目标文件夹 ID：([A-Za-z0-9_-]+)/.exec(prompt)?.[1] ?? 'autoFolder123', url: 'https://example.feishu.cn/docx/embeddedNativeReport', ...(prompt.includes('knownLibrary') ? { libraryFolderToken: 'industryNativeFolder', manifestUrl: 'https://example.feishu.cn/docx/industryNativeManifest', companies: [{ name: '后摩智能', url: 'https://example.feishu.cn/docx/embeddedNativeReport', dimensions: ['技术路线'], added: 1, conflicts: 0 }] } : {}) }));
    }
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of [
    ['message_start', { type: 'message_start', message: { id: 'native_test', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '报告已按要求交付，等待用户后续要求。' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }],
  ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}); await new Promise(r => model.listen(0, '127.0.0.1', r));
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
writeFileSync(resolve(dir, 'test-patch.json'), JSON.stringify([
  { id: 'dsh-industry-research', config: { dataDir: resolve(dir, 'workbench') } },
  { id: 'agent-preset-registry', config: { default: 'cordis' } },
  { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  { id: 'llm-deepseek-account', disabled: true },
  { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${model.address().port}`, apiKeyEnv: 'DSH_NATIVE_ACCEPTANCE_KEY' } },
]));
const child = spawn(process.env.DSH_COMMAND ?? 'dsh', ['--profile', 'native-test', '--patch', resolve(dir, 'test-patch.json'), '--no-open', '--port', String(port)], { env: { ...process.env, DSH_HOME: dir, LARK_CLI_COMMAND: fakeLark, DSH_NATIVE_ACCEPTANCE_KEY: 'sk-' + 'a'.repeat(32) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', x => { log = (log + x).slice(-12000); }); child.stderr.on('data', x => { log = (log + x).slice(-12000); });
const hostURL = `http://127.0.0.1:${port}`;
async function until(fn, timeout = 40000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}`); await new Promise(r => setTimeout(r, 200)); } throw new Error('真实宿主验收等待超时'); }
try {
  const status = await until(async () => { try { const s = await (await fetch(`${hostURL}/industry-research/status`)).json(); if (s.state === 'error') throw new Error(s.message); return s.state === 'ready' && s; } catch (e) { if (e.message.includes('fetch failed') || e instanceof SyntaxError) return; throw e; } });
  assert.equal((await (await fetch(`${status.url}/api/config`)).json()).nativeSessionAvailable, true);
  const configured = await fetch(`${status.url}/api/feishu-application`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'custom', appId: 'cli_nativeCustom123', appSecret: 'fake-acceptance-secret' }) }); assert.equal(configured.status, 200); assert.ok(!(await configured.text()).includes('fake-acceptance-secret'));
  const response = await fetch(`${status.url}/api/industry/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companies: ['后摩智能'], dimensions: ['技术路线'], sources: ['芯东西'], requirements: '真实宿主原生会话验收' }) }); assert.equal(response.status, 202); const created = await response.json();
  const task = await until(async () => { const t = (await (await fetch(`${status.url}/api/tasks/${created.id}`)).json()).task; if (t.status === 'failed') throw new Error(t.error); return t.status === 'ready' && t.publication.status === 'published' && t; });
  const db = new DatabaseSync(resolve(dir, 'workbench/research.sqlite'), { readOnly: true }); const bindingMeta = JSON.parse(db.prepare('SELECT body FROM terminals WHERE id=?').get(task.terminalId).body); db.close(); assert.equal(bindingMeta.agentPreset, 'standard', '宿主默认其他模式时，新调研仍明确采用标准模式');
  assert.equal(task.feishuApp.appId, 'cli_nativeCustom123'); assert.match(task.feishuApp.profile, /^research-/); assert.ok(readFileSync(bindingMeta.promptPath, 'utf8').includes('lark-cli --profile ' + task.feishuApp.profile)); assert.ok(!JSON.stringify(task).includes('fake-acceptance-secret'));
  assert.equal(task.nativeSession, true); assert.equal(task.terminalMode, false); assert.equal(task.report, null); assert.equal(task.draft, ''); assert.equal(task.cloudOnly, true); assert.ok(task.nativeSessionId);
  const binding = await (await fetch(`${hostURL}/industry-research/session?taskId=${task.id}`)).json(); assert.equal(binding.sessionId, task.nativeSessionId); assert.equal(task.publication.status, 'published'); assert.ok(modelCalls > 0);
  if (process.argv.includes('--browser')) {
    browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const launchURL = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(log)?.[1] ?? hostURL;
    let blockStartup = true; await page.route('**/industry-research/status', route => blockStartup ? new Promise(() => {}) : route.continue());
    await page.goto(launchURL);
    const preview = page.getByRole('button', { name: 'Continue', exact: true }); try { await preview.waitFor({ state: 'visible', timeout: 5000 }); await preview.click(); } catch {}
    await page.getByRole('button', { name: '行研工作台', exact: true }).click({ timeout: 25000 });
    await page.getByRole('alert').filter({ hasText: '连接宿主超时' }).waitFor({ timeout: 12000 }); blockStartup = false; await page.getByRole('button', { name: '重新连接工作台', exact: true }).click();
    const workbench = page.frameLocator('iframe[title="行研工作台"]');
    await workbench.getByRole('button', { name: '历史 AI 任务' }).click();
    const card = workbench.locator('.industry-history article').filter({ hasText: task.direction });
    await card.getByRole('button', { name: /继续会话/ }).click();
    await page.getByRole('region', { name: '行研工作台原生对话' }).waitFor();
    await page.locator('[contenteditable="true"]').last().waitFor();
    assert.equal(await page.getByRole('button', { name: '调研报告', exact: true }).count(), 0);
    await page.getByRole('link', { name: '打开飞书报告', exact: true }).waitFor();
    await page.locator('[contenteditable="true"]').last().fill('针对这份报告补充解释，不重新调研。');
    await page.locator('[contenteditable="true"]').last().press('Enter'); await until(() => followUpObserved);
    mkdirSync(resolve(root, 'artifacts'), { recursive: true }); await page.screenshot({ path: resolve(root, 'artifacts/embedded-native-chat.png'), fullPage: true });
    await page.getByRole('region', { name: '行研工作台原生对话' }).getByRole('button', { name: '返回', exact: true }).click();
    await workbench.getByRole('button', { name: '历史 AI 任务' }).click(); await card.waitFor(); await workbench.getByRole('button', { name: /^全量信息库/ }).click(); await workbench.getByRole('link', { name: '后摩智能' }).waitFor();
    const after = (await (await fetch(`${status.url}/api/tasks/${task.id}`)).json()).task;
    assert.equal(after.nativeSessionId, task.nativeSessionId); assert.equal(after.runs.length, 1); assert.equal(after.report, null);
    assert.ok(readdirSync(bindingMeta.cwd).every(name => !name.startsWith('report-')));
    console.log('PASS: 真实 DSH 工作台内嵌原生消息与输入框、绑定前置检查、飞书报告卡片、无本地报告/详情页、会话追问和返回首页通过');
  }
  console.log('PASS: 真实 DSH 宿主插件 → Session Controller → 本机模拟模型 → 飞书链接回执 → 原生会话绑定；未启动 TUI/PTY，未调用外部模型');
} catch (error) { if (page) { console.error((await page.locator('body').innerText()).slice(0,2500)); mkdirSync(resolve(root, 'artifacts'), { recursive: true }); await page.screenshot({path:resolve(root,'artifacts/native-host-error.png')}); } console.error(log.slice(-3500).replace(/([?&]token=)[^\s&]+/g, '$1[REDACTED]')); throw error; }
finally { await browser?.close(); child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]); if (child.exitCode === null) child.kill('SIGKILL'); model.closeAllConnections(); await new Promise(r => model.close(r)); rmSync(dir, { recursive: true, force: true }); }
