import {test,expect} from '@playwright/test';
test('FR02 日报周报入口、可编辑任务、报告卡片、续聊和独立历史',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'日报',exact:true}).click();
 await expect(page.getByRole('heading',{name:'日报',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'手动生成日报',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/同时按维度就地合并.*全量信息库/);await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/不新增“增量更新”章节/);
 await dialog.getByRole('button',{name:'启动',exact:true}).click();await expect(page.getByRole('button',{name:'← 返回工作台'})).toBeVisible();await page.getByRole('button',{name:'← 返回工作台'}).click();
 await expect(page.getByRole('link',{name:'打开飞书日报'})).toHaveAttribute('href',/feishu.cn\/docx\//);await expect(page.getByText('本日无更新')).toBeVisible();
 const card=page.locator('.briefing-card').filter({hasText:'日报 ·'}).first(),status=card.locator('.company-top .task-status');await expect(status).toHaveText('已完成');
 const cardBox=await card.boundingBox(),statusBox=await status.boundingBox();expect(statusBox.x).toBeGreaterThan(cardBox.x+cardBox.width/2);expect(statusBox.width).toBeLessThan(cardBox.width/2);expect(statusBox.y).toBeLessThan(cardBox.y+80);
 await page.screenshot({path:'artifacts/fr02-daily-card.png',fullPage:true});
 await page.getByRole('button',{name:'AI 会话详情'}).click();await expect(page.getByRole('button',{name:'← 返回工作台'})).toBeVisible();await page.getByRole('button',{name:'← 返回工作台'}).click();
 await page.getByRole('button',{name:'周报',exact:true}).click();await expect(page.getByText(/前七个完整自然日/)).toBeVisible();await expect(page.getByRole('heading',{name:'暂无周报记录'})).toBeVisible();
 await page.getByRole('button',{name:'定时生成周报'}).click();const settings=page.getByRole('dialog');await expect(settings.getByLabel('发送时间（北京时间）')).toHaveValue('09:00');await settings.getByLabel('发送时间（北京时间）').fill('09:15');await settings.getByLabel('启用此定时任务').check();await settings.getByRole('button',{name:/完成|关闭/}).last().click();await settings.getByRole('button',{name:'关闭',exact:true}).click();await expect(settings).toHaveCount(0);
 await page.getByRole('button',{name:'定时生成周报'}).click();await expect(page.getByRole('dialog').getByLabel('发送时间（北京时间）')).toHaveValue('09:15');await page.getByRole('dialog').getByRole('button',{name:'关闭调研配置'}).click();
 await page.getByRole('button',{name:'日报',exact:true}).click();await page.getByRole('button',{name:'定时生成日报'}).click();await expect(page.getByRole('dialog').getByLabel('发送时间（北京时间）')).toHaveValue('09:00');await page.getByRole('dialog').getByRole('button',{name:'关闭调研配置'}).click();await page.getByRole('button',{name:'周报',exact:true}).click();
 await page.screenshot({path:'artifacts/fr02-weekly.png',fullPage:true});
});

test('FR02 通知失败可进入当前应用的机器人权限修复',async({page})=>{
 const posts=[];
 await page.route('**/api/briefings?kind=daily*',route=>route.fulfill({json:{items:[{id:'11111111-1111-4111-8111-111111111111',direction:'日报 · 2026-11-03 00:00 至 2026-11-03 23:59（北京时间）',status:'ready',stage:'done',createdAt:'2026-11-04T01:00:00.000Z',briefing:{window:{display:'2026-11-03 00:00 至 2026-11-03 23:59（北京时间）'}},publication:{status:'published',url:'https://example.feishu.cn/docx/DailyFixture',partial:false,noUpdates:false},notification:{status:'failed',error:'当前飞书应用尚未获得机器人发消息权限（im:message:send_as_bot）。'}}]}}));
 await page.route('**/api/feishu-registration',route=>{if(route.request().method()==='POST')posts.push(route.request().postDataJSON());return route.fulfill({json:{flowId:'22222222-2222-4222-8222-222222222222',status:'failed',error:'测试权限更新',expiresAt:new Date(Date.now()+600000).toISOString()}});});
 await page.goto('/');await page.getByRole('button',{name:'日报',exact:true}).click();
 await page.route('**/api/briefings/11111111-1111-4111-8111-111111111111/notify',route=>route.fulfill({json:{id:'11111111-1111-4111-8111-111111111111',direction:'日报',publication:{status:'published'},briefing:{window:{display:'昨天'}},notification:{status:'failed',error:'机器人缺少权限',diagnostic:{action:'repair_bot'}}}}));
 await page.getByRole('button',{name:'重试通知',exact:true}).click();
 await expect(page.getByRole('button',{name:'修复机器人权限',exact:true})).toHaveCount(0);
 await expect.poll(()=>posts.length).toBe(1);expect(posts[0]).toEqual({refresh:false,repairBot:true});
});


test('重试通知缺权限时修复后自动补发，成功后卡片立即更新',async({page})=>{
 let sends=0,done=false;
 const task={id:'77777777-7777-4777-8777-777777777777',direction:'日报 · 测试补发',status:'ready',createdAt:'2026-11-04T01:00:00.000Z',briefing:{window:{display:'昨天'}},publication:{status:'published',url:'https://example.feishu.cn/docx/Report'},notification:{status:'failed',error:'机器人缺少权限',diagnostic:{action:'repair_bot'}}};
 await page.route('**/api/briefings?kind=daily*',route=>route.fulfill({json:{items:[{...task,notification:sends>1?{status:'sent'}:task.notification}]}}));
 await page.route('**/api/briefings/'+task.id+'/notify',route=>{sends++;return route.fulfill({json:{...task,notification:sends>1?{status:'sent'}:task.notification}});});
 const flow={flowId:'88888888-8888-4888-8888-888888888888',status:'awaiting_scan',updatingApp:true,appId:'cli_fixture123',authorizationUrl:'https://open.feishu.cn/page/cli?user_code=fixture',expiresAt:new Date(Date.now()+600000).toISOString()};
 await page.route('**/api/feishu-registration',route=>route.fulfill({json:{...flow,status:done?'completed':'awaiting_scan'}}));
 await page.route('**/api/feishu-registration/qr/*',route=>route.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==','base64')}));
 await page.goto('/');await page.getByRole('button',{name:'日报',exact:true}).click();
 await page.getByRole('button',{name:'重试通知',exact:true}).click();await expect(page.getByRole('heading',{name:'确认应用权限更新'})).toBeVisible();expect(sends).toBe(1);
 done=true;await expect.poll(()=>sends).toBe(2);await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByText('飞书机器人已通知')).toBeVisible();await expect(page.getByRole('button',{name:'重试通知',exact:true})).toHaveCount(0);
});
