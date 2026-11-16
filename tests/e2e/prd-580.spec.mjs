import {test,expect} from '@playwright/test';
const company={name:'后摩智能',url:'https://example.feishu.cn/docx/Company',dimensions:['技术路线'],updatedAt:'2026-11-16T01:00:00Z',conflicts:0,added:1};

test('PRD580 公司删除先确认，取消不操作，完成后移除卡片',async({page})=>{
 let deleted=false,deletes=0;
 const scope=(await(await page.request.get('/api/config')).json()).documentScope;
 await page.route(/\/api\/industry\/library(?:\?.*)?$/,route=>route.fulfill({json:{companies:deleted?[]:[company],syncedAt:new Date().toISOString()}}));
 await page.route('**/api/document-deletions/company?*',route=>route.fulfill({json:{target:company.url,scope,confirmation:'a'.repeat(64),status:'ready',documents:[{label:'公司资料 · 后摩智能',url:company.url}]}}));
 await page.route('**/api/document-deletions/company',route=>{expect(route.request().method()).toBe('DELETE');expect(route.request().postDataJSON()).toEqual({target:company.url,scope,confirmation:'a'.repeat(64),confirmed:true});deletes++;deleted=true;return route.fulfill({json:{status:'deleted'}});});
 await page.goto('/');await page.getByRole('button',{name:'删除公司资料：后摩智能',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'删除公司资料？'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('link',{name:'查看'})).toHaveAttribute('href',company.url);
 await dialog.getByRole('button',{name:'取消',exact:true}).click();expect(deletes).toBe(0);await expect(page.getByRole('link',{name:'后摩智能',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'删除公司资料：后摩智能',exact:true}).click();await dialog.getByRole('button',{name:'确认删除',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('link',{name:'后摩智能',exact:true})).toHaveCount(0);expect(deletes).toBe(1);
});

test('PRD580 核对已完成结果清除假失败，无重新解析；内部资料删除可续查',async({page})=>{
 const id='55555555-5555-4555-8555-555555555555',title='内部访谈核对测试',url='https://example.feishu.cn/docx/Transcript',minutes='https://example.feishu.cn/docx/Minutes';let deleted=false,reconciled=false,deletes=0,creates=0;
 const scope=(await(await page.request.get('/api/config')).json()).documentScope;
 const task=()=>({id,status:reconciled?'ready':'failed',direction:title,createdAt:'2026-11-16T01:00:00Z',error:reconciled?null:'内部资料尚未完成信息库增量同步',internal:{workflowVersion:1534,sourceType:'url',source:'https://example.feishu.cn/docx/Original',sourceLabel:title,directoryName:'内部资料'},publication:{status:reconciled?'published':'publishing',url,minutesUrl:minutes}});
 await page.route(/\/api\/industry\/library(?:\?.*)?$/,route=>route.fulfill({json:{companies:[company]}}));
 await page.route(/\/api\/internal-materials(?:\?.*)?$/,route=>{if(route.request().method()==='POST')creates++;return route.fulfill({json:{items:deleted?[]:[task()],syncedAt:new Date().toISOString()}});});
 await page.route('**/api/internal-materials/'+id+'/reconcile',route=>{expect(route.request().method()).toBe('POST');reconciled=true;return route.fulfill({json:task()});});
 await page.route('**/api/document-deletions/internal?*',route=>route.fulfill({json:{target:id,scope,confirmation:'b'.repeat(64),status:'ready',documents:[{label:'逐字稿',url},{label:'会议纪要',url:minutes}]}}));
 await page.route('**/api/document-deletions/internal',route=>{deletes++;if(deletes===1)return route.fulfill({status:202,json:{status:'pending',message:'飞书正在处理删除，请稍后继续核对。'}});deleted=true;return route.fulfill({json:{status:'deleted'}});});
 await page.goto('/');await page.getByRole('button',{name:'内部资料',exact:true}).click();const card=page.locator('.industry-company').filter({hasText:title});
 await expect(card.locator('.task-status')).toHaveText('失败');await card.getByRole('button',{name:'核对已完成结果',exact:true}).click();await expect(card.locator('.task-status')).toHaveText('已完成');await expect(card.getByText('内部资料尚未完成信息库增量同步',{exact:true})).toHaveCount(0);expect(creates).toBe(0);
 await page.screenshot({path:'artifacts/prd580-internal-reconciled.png',fullPage:true});
 await card.getByRole('button',{name:'删除内部资料：'+title,exact:true}).click();const dialog=page.getByRole('dialog',{name:'删除内部资料？'});await expect(dialog.getByRole('link',{name:'查看'})).toHaveCount(2);
 await dialog.getByRole('button',{name:'确认删除',exact:true}).click();await expect(dialog.getByRole('button',{name:'继续核对',exact:true})).toBeVisible();await expect(card).toHaveCount(1);await dialog.getByRole('button',{name:'继续核对',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(card).toHaveCount(0);expect(creates).toBe(0);
});
