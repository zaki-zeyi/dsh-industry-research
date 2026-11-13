import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRuntime } from '../../server/runtime.mjs';
import { FeishuBinding, requiredScopes } from '../../server/feishu-binding.mjs';
import { applicationRunner, registrationRunner } from '../fixtures/fake-feishu-application.mjs';
import { mockHost } from '../fixtures/fake-native-host.mjs';
let runtime,host,shell,url,dir,sdk;
test.beforeAll(async()=>{
 dir=mkdtempSync(resolve(tmpdir(),'native-ui-'));host=mockHost();
 sdk=registrationRunner();const runner=applicationRunner({defaultBound:false,defaultUserName:'验收用户'}),binding=new FeishuBinding({run:runner.run,registerApp:sdk.registerApp});
 runtime=await startRuntime({env:{RESEARCH_MODE:'native'},port:0,dataDir:dir,host,binding});binding.store=runtime.service.store;
 shell=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><div id="native" hidden><h1>行研工作台 · AI对话</h1><button id="back">返回</button></div><iframe title="行研工作台" referrerpolicy="no-referrer" src="${runtime.url}/?embed=dsh&hostOrigin=${encodeURIComponent(url)}" style="width:100%;height:95vh;border:0"></iframe><script>
 const frame=document.querySelector('iframe'),native=document.querySelector('#native');window.opened=[];
 window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='${runtime.url}'||event.data.type!=='industry-research:embed-session')return;window.opened.push(event.data.taskId);event.source.postMessage({type:'industry-research:session-result',requestId:event.data.requestId,ok:true},event.origin);frame.hidden=true;native.hidden=false;});
 document.querySelector('#back').onclick=()=>{frame.contentWindow.postMessage({type:'industry-research:show-report',taskId:'',publish:false},'${runtime.url}');frame.hidden=false;native.hidden=true;};</script>`);});await new Promise(r=>shell.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${shell.address().port}`;
});
test.afterAll(async()=>{shell?.closeAllConnections();await new Promise(r=>shell?.close(r));await runtime?.close();rmSync(dir,{recursive:true,force:true});});
test('AC-NATIVE-UI-02 绑定飞书是前置条件，扫码后调研只显示会话，报告卡片直达飞书',async({page})=>{
 await page.goto(url);const workbench=page.frameLocator('iframe[title="行研工作台"]');
 await workbench.getByRole('button',{name:'新建调研',exact:true}).click();await expect(workbench.getByRole('dialog')).toContainText('绑定飞书');expect(host.created).toBe(0);
 await workbench.getByRole('button',{name:'仅补充当前应用授权',exact:true}).click();await expect(workbench.getByRole('img',{name:'绑定飞书授权二维码'})).toBeVisible();
 await expect(workbench.getByRole('link',{name:'打开飞书授权页'})).toHaveAttribute('href','https://accounts.feishu.cn/device?code=test-1');await expect(workbench.getByRole('region',{name:'授权应用'})).toContainText('默认应用');await expect(workbench.getByRole('region',{name:'授权应用'})).toContainText('cli_default123');expect(runtime.service.binding.flow.appId).toBe('cli_default123');
 await workbench.getByRole('button',{name:'我已授权',exact:true}).click();await expect(workbench.getByRole('dialog')).toHaveCount(0);
 await workbench.getByRole('button',{name:'新建调研',exact:true}).click();await workbench.getByLabel('调研方向').fill('宿主云端报告验收');await workbench.getByRole('button',{name:'启动调研',exact:true}).click();
 await expect(page.getByRole('heading',{name:'行研工作台 · AI对话',exact:true})).toBeVisible();expect(host.created).toBe(1);
 await expect.poll(()=>runtime.service.store.list()[0]?.status).toBe('ready');
 const first=runtime.service.store.list()[0];expect(first.report).toBeNull();expect(first.draft).toBe('');expect(readdirSync(runtime.service.nativeSessions.get(first.terminalId).cwd).some(n=>n.startsWith('report-'))).toBe(false);
 await page.getByRole('button',{name:'返回',exact:true}).click();const card=workbench.locator('.research-card').filter({hasText:'宿主云端报告验收'});await expect(card.getByRole('link')).toHaveAttribute('href','https://example.feishu.cn/docx/cloudReport123');
 await expect(workbench.getByRole('button',{name:'调研报告',exact:true})).toHaveCount(0);await expect(workbench.locator('.report-pane')).toHaveCount(0);
 await card.getByRole('button',{name:'AI会话',exact:true}).click();await expect(page.getByRole('heading',{name:'行研工作台 · AI对话',exact:true})).toBeVisible();expect(host.created).toBe(1);
 await page.screenshot({path:'test-results/cloud-native-workbench.png',fullPage:true});
});

test('AC-NATIVE-UI-03 重新绑定扫码登录新账号并选择应用，刷新和取消保留原绑定',async({page})=>{
 await page.goto(url);const w=page.frameLocator('iframe[title="行研工作台"]'),before=runtime.service.store.list()[0];
 await w.getByRole('button',{name:'已绑定飞书',exact:true}).click();await w.getByRole('button',{name:'重新绑定',exact:true}).click();const qr=w.getByRole('img',{name:'飞书账号登录与应用绑定二维码'});await expect(qr).toBeVisible();await expect(w.getByRole('dialog')).toContainText('选择已有应用或创建新应用');const first=await qr.getAttribute('src');expect(runtime.service.binding.flow).toBeNull();await w.getByRole('button',{name:'重新获取应用绑定二维码',exact:true}).click();await expect(qr).not.toHaveAttribute('src',first);expect((await page.request.get(runtime.url+first)).status()).toBe(404);await page.screenshot({path:'test-results/feishu-account-app-qr.png',fullPage:true});
 await w.getByRole('button',{name:'取消',exact:true}).click();await expect(w.getByRole('status')).toContainText('验收用户');expect(runtime.service.binding.registration.snapshot().status).toBe('idle');expect(runtime.service.store.list()[0].nativeSessionId).toBe(before.nativeSessionId);expect((await runtime.service.binding.status()).userName).toBe('验收用户');
});

test('AC-NATIVE-UI-04 应用扫码完成后自动继续个人授权，同账号上传且不回显密钥',async({page})=>{
 await page.goto(url);const w=page.frameLocator('iframe[title="行研工作台"]');await w.getByRole('button',{name:'已绑定飞书',exact:true}).click();await w.getByRole('button',{name:'更换应用',exact:true}).click();await expect(w.getByRole('img',{name:'飞书账号登录与应用绑定二维码'})).toBeVisible();sdk.approve('cli_newaccount123');await expect(w.getByRole('img',{name:'绑定飞书授权二维码'})).toBeVisible();await expect(w.getByRole('region',{name:'授权应用'})).toContainText('cli_newaccount123');await expect(w.getByRole('dialog')).toContainText('同一账号授权');expect(await w.getByRole('dialog').textContent()).not.toContain('fixture-secret');expect(JSON.stringify(await(await page.request.get(runtime.url+'/api/feishu-application')).json())).not.toContain('fixture-secret');await w.getByRole('button',{name:'我已授权',exact:true}).click();await expect(w.getByRole('dialog')).toHaveCount(0);
 await w.getByRole('button',{name:'新建调研',exact:true}).click();await w.getByLabel('调研方向').fill('扫码新账号应用调研');await w.getByRole('button',{name:'启动调研',exact:true}).click();await expect(page.getByRole('heading',{name:'行研工作台 · AI对话',exact:true})).toBeVisible();await expect.poll(()=>runtime.service.store.list().find(t=>t.direction==='扫码新账号应用调研')?.status).toBe('ready');await expect.poll(()=>runtime.service.active.size).toBe(0);const task=runtime.service.store.list().find(t=>t.direction==='扫码新账号应用调研');expect(task.feishuApp.appId).toBe('cli_newaccount123');expect(task.feishuApp.ownerOpenId).toBe('ou_scanned');expect(task.report).toBeNull();await page.getByRole('button',{name:'返回',exact:true}).click();
});

test('AC-NATIVE-UI-05 高级手动配置保留，恢复默认不迁移历史任务',async({page})=>{
 await page.goto(url);const w=page.frameLocator('iframe[title="行研工作台"]');const task=runtime.service.store.list().find(t=>t.direction==='扫码新账号应用调研');await w.getByRole('button',{name:'已绑定飞书',exact:true}).click();await w.getByRole('button',{name:'手动配置已有应用',exact:true}).click();await expect(w.getByLabel('App Secret',{exact:true})).toHaveValue('');await expect(w.getByLabel('App Secret',{exact:true})).toHaveAttribute('type','password');await expect(w.getByLabel('App ID',{exact:true})).toHaveValue('cli_newaccount123');await page.keyboard.press('Escape');await expect(w.getByRole('heading',{name:'绑定飞书',exact:true})).toBeVisible();await w.getByRole('button',{name:'手动配置已有应用',exact:true}).click();await w.getByLabel('应用来源').selectOption('default');await w.getByRole('button',{name:'保存应用配置',exact:true}).click();await expect(w.getByRole('dialog')).toHaveCount(0);expect(runtime.service.binding.applicationSnapshot().mode).toBe('default');expect(runtime.service.store.get(task.id).feishuApp.appId).toBe('cli_newaccount123');
});

test('AC-NATIVE-UI-06 无默认应用也能扫码登录并选择或创建应用',async({page})=>{
 await page.route('**/api/feishu-binding',route=>route.fulfill({json:{bound:false,available:false,error:'未配置应用'}}));await page.goto(url);const w=page.frameLocator('iframe[title="行研工作台"]');await w.getByRole('button',{name:'绑定飞书',exact:true}).click();await expect(w.getByRole('button',{name:'仅补充当前应用授权',exact:true})).toHaveCount(0);await w.getByRole('button',{name:'扫码登录并选择应用',exact:true}).click();await expect(w.getByRole('img',{name:'飞书账号登录与应用绑定二维码'})).toBeVisible();await w.getByRole('button',{name:'取消',exact:true}).click();expect(runtime.service.binding.applicationSnapshot().mode).toBe('default');
});

test('AC-NATIVE-UI-07 个人授权生成失败保留应用并允许重试',async({page})=>{
 let starts=0;await page.route('**/api/feishu-binding',async route=>{if(route.request().method()==='POST'){starts++;await route.fulfill({status:503,json:{error:'无法发起飞书绑定'}});}else await route.fulfill({json:{bound:false,available:true,appId:'cli_retry123',appName:'验收应用'}});});await page.goto(url);const w=page.frameLocator('iframe[title="行研工作台"]');await w.getByRole('button',{name:'绑定飞书',exact:true}).click();await w.getByRole('button',{name:'仅补充当前应用授权',exact:true}).click();await expect(w.getByRole('alert')).toContainText('无法发起飞书绑定');expect(starts).toBe(1);await expect(w.getByRole('region',{name:'授权应用'})).toContainText('cli_retry123');await w.getByRole('button',{name:'仅补充当前应用授权',exact:true}).click();await expect.poll(()=>starts).toBe(2);
});

test('AC-NATIVE-UI-08 拒绝或过期应用授权可重新扫码，旧账号仍可使用',async({page})=>{
 await page.goto(url);const w=page.frameLocator('iframe[title="行研工作台"]');await w.getByRole('button',{name:'已绑定飞书',exact:true}).click();await w.getByRole('button',{name:'重新绑定',exact:true}).click();await expect(w.getByRole('img',{name:'飞书账号登录与应用绑定二维码'})).toBeVisible();sdk.pending.at(-1).reject(Object.assign(new Error('private-error'),{code:'access_denied'}));await expect(w.getByRole('alert')).toContainText('已取消应用授权');await w.getByRole('button',{name:'重新获取应用绑定二维码',exact:true}).click();await expect(w.getByRole('img',{name:'飞书账号登录与应用绑定二维码'})).toBeVisible();runtime.service.binding.registration.flow.expires=Date.now()-1;await expect(w.getByRole('alert')).toContainText('二维码已过期');await w.getByRole('button',{name:'取消',exact:true}).click();await expect(w.getByRole('status')).toContainText('验收用户');
});
