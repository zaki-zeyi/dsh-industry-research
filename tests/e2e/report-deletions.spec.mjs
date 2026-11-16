import {test,expect} from '@playwright/test';

for(const kind of ['analysis','daily','weekly'])test('PRD4896 '+kind+'删除入口、取消、异步核对和刷新不恢复',async({page})=>{
 const label=kind==='analysis'?'友商分析':kind==='daily'?'日报':'周报',title=label+' · 删除验收';
 const id='66666666-6666-4666-8666-666666666666',url='https://example.feishu.cn/docx/ReportDelete';let deleted=false,deletes=0;
 const scope=(await(await page.request.get('/api/config')).json()).documentScope;
 const card={id,taskId:id,title,direction:title,status:'ready',createdAt:'2026-11-16T01:00:00Z',updatedAt:'2026-11-16T01:00:00Z',url,companies:['后摩智能','光羽芯辰'],dimensions:['技术路线'],briefing:{kind,window:{display:'测试区间'}},publication:{status:'published',url}};
 if(kind==='analysis')await page.route(/\/api\/analysis\/reports(?:\?.*)?$/,route=>route.fulfill({json:{reports:deleted?[]:[card],tasks:[]}}));
 else await page.route(/\/api\/briefings\?kind=.*/,route=>route.fulfill({json:{items:deleted?[]:[card]}}));
 await page.route('**/api/document-deletions/'+kind+'?*',route=>route.fulfill({json:{target:kind==='analysis'?url:id,scope,confirmation:'c'.repeat(64),status:'ready',documents:[{label,url}]}}));
 await page.route('**/api/document-deletions/'+kind,route=>{
  expect(route.request().method()).toBe('DELETE');expect(route.request().postDataJSON()).toEqual({target:kind==='analysis'?url:id,scope,confirmation:'c'.repeat(64),confirmed:true});deletes++;
  if(deletes===1)return route.fulfill({status:202,json:{status:'pending',message:'飞书正在处理删除，请稍后继续核对。'}});
  deleted=true;return route.fulfill({json:{status:'deleted'}});
 });
 await page.goto('/');await page.getByRole('button',{name:new RegExp('^'+label+(kind==='analysis'?' \\d+':'')+'$')}).click();
 const trigger=page.getByRole('button',{name:'删除'+label+'：'+title,exact:true});await trigger.click();
 const dialog=page.getByRole('dialog',{name:'删除'+label+'？'});await expect(dialog.getByRole('link',{name:'查看'})).toHaveAttribute('href',url);
 await expect(dialog).toContainText('保留全量信息库中的公司资料和已有定时设置');await dialog.getByRole('button',{name:'取消',exact:true}).click();expect(deletes).toBe(0);await expect(trigger).toBeVisible();
 await trigger.click();await dialog.getByRole('button',{name:'确认删除',exact:true}).click();await expect(dialog.getByRole('button',{name:'继续核对',exact:true})).toBeVisible();await expect(trigger).toHaveCount(1);
 await dialog.getByRole('button',{name:'继续核对',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(trigger).toHaveCount(0);
 await page.getByRole('button',{name:kind==='analysis'?'刷新列表':'刷新',exact:true}).click();await expect(trigger).toHaveCount(0);expect(deletes).toBe(2);
});

test('PRD4896 友商分析删除后丢弃迟到的旧刷新结果',async({page})=>{
 const title='友商分析 · 刷新竞态',url='https://example.feishu.cn/docx/DelayedReport';let deleted=false,armed=false,release;
 const scope=(await(await page.request.get('/api/config')).json()).documentScope;
 const report={title,url,taskId:'77777777-7777-4777-8777-777777777777',companies:['后摩智能','光羽芯辰'],dimensions:['技术路线'],updatedAt:'2026-11-16T01:00:00Z'};
 await page.route(/\/api\/analysis\/reports(?:\?.*)?$/,async route=>{
  if(armed&&route.request().url().includes('refresh=true')){armed=false;await new Promise(resolve=>release=resolve);return route.fulfill({json:{reports:[report],tasks:[]}});}
  return route.fulfill({json:{reports:deleted?[]:[report],tasks:[]}});
 });
 await page.route('**/api/document-deletions/analysis?*',route=>route.fulfill({json:{target:url,scope,confirmation:'d'.repeat(64),status:'ready',documents:[{label:'友商分析',url}]}}));
 await page.route('**/api/document-deletions/analysis',route=>{deleted=true;return route.fulfill({json:{status:'deleted'}});});
 await page.goto('/');await page.getByRole('button',{name:/^友商分析 \d+$/}).click();const trigger=page.getByRole('button',{name:'删除友商分析：'+title,exact:true});await expect(trigger).toBeVisible();
 await expect(page.getByRole('button',{name:'刷新列表',exact:true})).toBeEnabled();armed=true;await page.getByRole('button',{name:'刷新列表',exact:true}).click();await expect.poll(()=>Boolean(release)).toBe(true);
 await trigger.click();await page.getByRole('dialog').getByRole('button',{name:'确认删除',exact:true}).click();await expect(trigger).toHaveCount(0);
 release();await expect(page.getByRole('button',{name:'刷新列表',exact:true})).toBeEnabled();await expect(trigger).toHaveCount(0);
});
