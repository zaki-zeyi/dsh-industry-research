import { test, expect } from '@playwright/test';

test('PRD4549 存储位置设置目录并用于新任务，解析弹窗不恢复多余目录字段',async({page,request})=>{
 try {
  await page.goto('/');await page.getByRole('button',{name:'内部资料',exact:true}).click();
  await page.getByRole('button',{name:'设置目录',exact:true}).click();
  await page.getByLabel('内部资料目录名称').fill('访谈资料');
  await page.getByRole('button',{name:'保存目录',exact:true}).click();
  await expect(page.getByText('飞书云盘 / 行研工作台 / 访谈资料',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'解析内部资料',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/【访谈资料】/);
  await expect(dialog.getByLabel('内部资料目录名称')).toHaveCount(0);
  await page.screenshot({path:'artifacts/prd-4549-internal-directory.png',fullPage:true});
  await page.getByRole('button',{name:'关闭内部资料解析'}).click();
  await page.reload();await page.getByRole('button',{name:'内部资料',exact:true}).click();
  await expect(page.getByText('飞书云盘 / 行研工作台 / 访谈资料',{exact:true})).toBeVisible();
 }finally{await request.put('/api/internal-materials/settings',{data:{directoryName:'内部资料'}});}
});

test('PRD4549 云端历史报告提供文档链接，无本机记录时不伪造会话',async({page})=>{
 let refresh=false;
 await page.route('**/api/briefings?*',route=>{
  if(new URL(route.request().url()).searchParams.get('refresh')==='true')refresh=true;
  return route.fulfill({json:{items:[{id:'cloud-fixture',remoteOnly:true,direction:'日报 · 飞书历史报告',status:'ready',briefing:{kind:'daily',window:{display:'飞书历史报告 · 统计区间见文档'}},publication:{status:'published',url:'https://example.feishu.cn/docx/RemoteDaily'}}]}});
 });
 await page.goto('/');await page.getByRole('button',{name:'日报',exact:true}).click();
 await expect(page.getByRole('link',{name:'打开飞书日报'})).toHaveAttribute('href','https://example.feishu.cn/docx/RemoteDaily');
 await expect(page.getByRole('button',{name:'AI 会话详情'})).toBeDisabled();expect(refresh).toBe(true);
 await page.getByRole('button',{name:'手动生成日报',exact:true}).click();
 await expect(page.getByRole('dialog').getByLabel('任务 Prompt',{exact:false})).toHaveValue(/事件发生日和入库日/);
});

test('PRD4549 云端读取失败保留卡片并显示同步错误',async({page})=>{
 await page.route('**/api/briefings?*',route=>route.fulfill({json:{items:[{id:'cloud-cache',remoteOnly:true,direction:'缓存周报',status:'ready',briefing:{kind:'weekly',window:{display:'缓存数据'}},publication:{status:'published',url:'https://example.feishu.cn/docx/Cached'}}],syncError:'飞书连接暂时不可用，缓存已保留'}}));
 await page.goto('/');await page.getByRole('button',{name:'周报',exact:true}).click();
 await expect(page.getByRole('heading',{name:'缓存周报'})).toBeVisible();
 await expect(page.getByRole('alert').filter({hasText:'缓存已保留'})).toBeVisible();
});
