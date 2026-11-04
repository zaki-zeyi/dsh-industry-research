import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
test('完整公司调研流程：默认配置、自定义持久化、可编辑Prompt、文档卡片、冲突和历史',async({page,request})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:'全量信息库',exact:true})).toBeVisible();await page.getByRole('button',{name:'更新全量信息库',exact:true}).first().click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'更新全量信息库'})).toBeVisible();await expect(dialog.getByText('17 家公司 · 5 个维度 · 16 个信源')).toBeVisible();
 await dialog.getByRole('textbox',{name:'自定义调研维度'}).fill('客户与合作伙伴');await dialog.getByRole('group',{name:'调研维度'}).getByRole('button',{name:'＋ 添加'}).click();await expect(dialog.getByRole('checkbox',{name:'客户与合作伙伴'})).toBeChecked();
 await dialog.getByRole('textbox',{name:'自定义数据源'}).fill('公司官方网站');await dialog.getByRole('group',{name:'数据源'}).getByRole('button',{name:'＋ 添加'}).click();await expect(dialog.getByRole('checkbox',{name:'公司官方网站'})).toBeChecked();
 await dialog.getByRole('button',{name:'关闭调研配置'}).click();await page.getByRole('button',{name:'更新全量信息库',exact:true}).first().click();await expect(dialog.getByRole('checkbox',{name:'客户与合作伙伴'})).toBeChecked();await expect(dialog.getByRole('checkbox',{name:'公司官方网站'})).toBeChecked();
 await dialog.getByLabel('其他要求').fill('优先最近一年信息');await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/优先最近一年信息/);await dialog.getByLabel('任务 Prompt',{exact:false}).fill('请调研选择的全部公司，保留来源与日期，呈现更新摘要。');await dialog.getByRole('button',{name:'启动',exact:true}).click();
 await expect(page.getByRole('heading',{name:'更新全量信息库 · 17 家公司'})).toBeVisible();await page.getByRole('button',{name:'← 返回工作台'}).click();await expect(page.locator('.industry-company')).toHaveCount(17,{timeout:10000});
 await expect(page.getByText('1 处信息冲突，请在文档中核对来源')).toBeVisible();await page.screenshot({path:'artifacts/industry-library.png',fullPage:true});await expect(page.getByRole('link',{name:'后摩智能'})).toHaveAttribute('href',/feishu.cn\/docx\//);
 await page.getByRole('textbox',{name:'搜索',exact:true}).fill('后摩');await expect(page.locator('.industry-company')).toHaveCount(1);await page.reload();await expect(page.locator('.industry-company')).toHaveCount(17);
 await page.getByRole('tab',{name:'历史 AI 任务'}).click();await expect(page.locator('.industry-history article').first()).toContainText('已完成');await page.locator('.industry-history article').first().getByRole('button',{name:'继续会话'}).click();await expect(page.getByRole('heading',{name:'更新全量信息库 · 17 家公司'})).toBeVisible();
 const tasks=await(await request.get('/api/tasks')).json();expect(tasks.items[0].status).toBe('ready');
});
test('空选禁用启动、失败任务保留并可重试',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'更新全量信息库',exact:true}).first().click();const dialog=page.getByRole('dialog');await dialog.getByRole('group',{name:'调研公司'}).getByRole('button',{name:'清空',exact:true}).click();await expect(dialog.getByRole('button',{name:'启动',exact:true})).toBeDisabled();
 await dialog.getByRole('textbox',{name:'自定义调研公司'}).fill('失败验收公司');await dialog.getByRole('group',{name:'调研公司'}).getByRole('button',{name:'＋ 添加'}).click();await dialog.getByRole('button',{name:'启动',exact:true}).click();await expect(page.getByRole('button',{name:'重试任务'})).toBeVisible({timeout:10000});await expect(page.getByRole('alert')).toContainText('测试信源不可用');await page.getByRole('button',{name:'重试任务'}).click();await expect(page.getByText(/已完成 ·/)).toBeVisible({timeout:10000});
});
test('窄屏布局无横向溢出，弹窗支持Escape和键盘焦点',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByRole('button',{name:'更新全量信息库',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('返回工作台后，迟到的详情响应不能重新打开旧会话',async({page,request})=>{
 const list=await(await request.get('/api/tasks')).json();const id=list.items[0].id;
 await page.goto('/');await page.getByRole('tab',{name:'历史 AI 任务'}).click();
 let release;const gate=new Promise(r=>{release=r;});let observed;const received=new Promise(r=>{observed=r;});let finish;const finished=new Promise(r=>{finish=r;});
 await page.route('**/api/tasks/'+id,async route=>{const response=await route.fetch();observed();await gate;await route.fulfill({response});finish();});
 await page.locator('.industry-history article').filter({hasText:list.items[0].direction}).first().getByRole('button',{name:'继续会话'}).click();await received;
 await page.getByRole('button',{name:'← 返回工作台'}).click();release();await finished;await page.evaluate(()=>new Promise(requestAnimationFrame));await page.unroute('**/api/tasks/'+id);
 await expect(page.getByRole('tab',{name:'历史 AI 任务'})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('button',{name:'← 返回工作台'})).toHaveCount(0);
});
test('索引格式错误准确提示并保留公司，后台轮询不清除错误，刷新成功后清除',async({page,request})=>{
 const before=await(await request.get('/api/industry/library')).json();
 await page.route('**/api/industry/library?refresh=true',route=>route.fulfill({status:502,json:{code:'LIBRARY_INVALID_SCHEMA',error:'公司索引字段格式不正确，请在原会话核对公司链接、维度和日期；本地已同步记录保留'}}));
 await page.clock.install();await page.goto('/');await expect(page.getByRole('alert')).toContainText('日期');await expect(page.getByRole('alert')).not.toContainText('授权');await expect(page.locator('.industry-company')).toHaveCount(before.companies.length);
 await page.clock.runFor(4500);await expect(page.getByRole('alert')).toContainText('日期');
 await page.unroute('**/api/industry/library?refresh=true');await page.getByRole('button',{name:'刷新列表'}).click();await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByText(/上次同步/)).toBeVisible();await expect(page.locator('.industry-company')).toHaveCount(before.companies.length);
});
test('FR04 内部资料链接可生成逐字稿、展示文档和原始资料并自动通知',async({page,request})=>{
 await page.goto('/');await page.getByRole('button',{name:'内部资料'}).click();await expect(page.getByRole('heading',{name:'内部资料',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'解析内部资料'}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'内部资料'})).toBeVisible();
 await expect(dialog.getByLabel('内部资料目录',{exact:false})).toHaveCount(0);await dialog.getByLabel('网络链接').check();await dialog.getByLabel('网络资料链接').fill('https://example.com/interview.mp4');await dialog.getByLabel('其他要求').fill('核对融资日期');
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/核对融资日期/);await dialog.getByRole('button',{name:'启动'}).click();
 await expect(page.getByRole('heading',{name:'内部资料解析 · interview.mp4'})).toBeVisible({timeout:10000});await page.getByRole('button',{name:'← 返回工作台'}).click();
 const sourceTitle='后摩智能项之初：硅基算力会改变我们的生活吗？',list=page.locator('.industry-company').filter({hasText:sourceTitle});await expect(list).toContainText('已完成',{timeout:10000});await expect(list.locator('h2')).toHaveAttribute('title',sourceTitle);await expect(list.locator('h2')).toHaveCSS('-webkit-line-clamp','2');await expect(list.getByRole('link',{name:'逐字稿'})).toHaveAttribute('href',/InternalTranscript/);await expect(list.getByRole('link',{name:'原始资料'})).toHaveAttribute('href',/FixtureSource/);await expect(list).toContainText('飞书机器人已通知');
 await expect(list.getByRole('link',{name:'会议纪要',exact:true})).toHaveAttribute('href',/InternalMinutes/);
 const api=await(await request.get('/api/internal-materials')).json();const task=api.items.find(item=>item.internal.source==='https://example.com/interview.mp4');expect(task.internal.sourceLabel).toBe(sourceTitle);expect(task.publication.sourceTitle).toBe(sourceTitle);expect(task.publication.sourceMaterialUrl).toContain('FixtureSource');expect(task.notification.status).toBe('sent');expect(task.internal.directoryName).toBe('内部资料');
 await page.getByRole('button',{name:'解析内部资料'}).click();await expect(page.getByRole('dialog').getByLabel('内部资料目录',{exact:false})).toHaveCount(0);await page.keyboard.press('Escape');
});



async function shell(page, paths) {
 await page.route('**/picker-shell',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><iframe title="测试工作台" style="width:100vw;height:100vh" src="/?embed=dsh&hostOrigin=http%3A%2F%2F127.0.0.1%3A3099"></iframe><script>
 const paths=${JSON.stringify(paths)};const frame=document.querySelector('iframe');
 window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==frame.contentWindow||e.data.type!=='industry-research:pick-file')return;
 const input=document.createElement('input');input.type='file';document.body.append(input);const finish=value=>{frame.contentWindow.postMessage({type:'industry-research:file-result',requestId:e.data.requestId,...value},location.origin);input.remove();};
 input.addEventListener('cancel',()=>finish({cancelled:true}));input.addEventListener('change',()=>{const f=input.files[0];finish(f?{path:paths[f.name],size:f.size}:{cancelled:true});});input.click();});
 </script>`}));
 await page.goto('/picker-shell');return page.frameLocator('iframe[title="测试工作台"]');
}
test('PRD1622 历史任务位于全量信息库页内，支持键盘切换',async({page})=>{
 await page.goto('/');await expect(page.locator('.industry-sidebar').getByText('历史 AI 任务')).toHaveCount(0);
 const tabs=page.getByRole('tablist',{name:'全量信息库视图'});await tabs.getByRole('tab',{name:'历史 AI 任务'}).click();await expect(page.getByRole('tabpanel')).toHaveAccessibleName('历史 AI 任务');
 await page.keyboard.press('ArrowLeft');await expect(tabs.getByRole('tab',{name:'公司档案'})).toHaveAttribute('aria-selected','true');
});
test('PRD1622 选择原始完整路径、取消保留原选择，启动不复制也不上传字节',async({page,request})=>{
 const dir=mkdtempSync(join(tmpdir(),'prd1622-original-')),path=join(dir,'访谈确认.txt');writeFileSync(path,'original interview bytes');let copies=0;
 page.on('request',r=>{if(r.url().includes('/internal-material-files'))copies++;});
 try {
  const w=await shell(page,{'访谈确认.txt':path});await w.getByRole('button',{name:'内部资料',exact:true}).click();await w.getByRole('button',{name:'解析内部资料'}).click();const d=w.getByRole('dialog');
  await expect(d.getByRole('button',{name:'启动',exact:true})).toBeDisabled();
  const chosen=page.waitForEvent('filechooser');await d.getByRole('button',{name:'选择本地文件'}).click();await(await chosen).setFiles(path);
  await expect(d.getByLabel('本地文件完整路径')).toHaveText(path);await expect(d.getByLabel('任务 Prompt',{exact:false})).toHaveValue(new RegExp('访谈确认'));
  const cancel=page.waitForEvent('filechooser');await d.getByRole('button',{name:'选择本地文件'}).click();await(await cancel).setFiles([]);await expect(d.getByLabel('本地文件完整路径')).toHaveText(path);
  await d.getByRole('button',{name:'启动',exact:true}).click();await expect(w.getByRole('heading',{name:'内部资料解析 · 访谈确认.txt'})).toBeVisible();
  const tasks=await(await request.get('/api/internal-materials')).json();expect(tasks.items.find(t=>t.internal.sourceLabel==='访谈确认.txt').internal.source).toBe(path);expect(copies).toBe(0);expect(readFileSync(path,'utf8')).toBe('original interview bytes');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('PRD1622 网页无宿主路径桥接时提示，不复制文件，网络来源仍可用',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'内部资料',exact:true}).click();await page.getByRole('button',{name:'解析内部资料'}).click();const d=page.getByRole('dialog');
 await d.getByRole('button',{name:'选择本地文件'}).click();await expect(d.getByRole('alert')).toContainText('DSH 桌面版');await expect(d.getByRole('button',{name:'启动',exact:true})).toBeDisabled();
 await d.getByLabel('网络链接').check();await d.getByLabel('网络资料链接').fill('https://example.com/another.mp4');await expect(d.getByRole('button',{name:'启动',exact:true})).toBeEnabled();await d.getByRole('button',{name:'关闭内部资料解析'}).click();
});
