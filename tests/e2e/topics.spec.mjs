import {test,expect} from '@playwright/test';
test('FR05 专题调研创建、可编辑提示、续聊、独立日报与页签隔离',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'专题调研',exact:true}).click();
 await expect(page.getByRole('heading',{name:'专题调研',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'启动专题调研',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('调研方向',{exact:true}).fill('国产推理芯片的软件生态如何发展？');
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/国产推理芯片.*专题调研/);
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/每个信息条目附可点击的原始来源链接和信息日期，链接紧跟该条正文/);
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).not.toHaveValue(/【调研结论】|【调研依据】/);
 await expect(dialog.getByText('报告按问题、结论、依据组织。',{exact:false})).toHaveCount(0);
 await dialog.getByLabel('其他要求',{exact:true}).fill('注明证据日期');
 const sourceGroup=dialog.getByRole('group',{name:/^数据源/});
 await expect(sourceGroup).toHaveClass('industry-choices');
 await sourceGroup.getByRole('button',{name:'全选',exact:true}).click();
 await expect(sourceGroup.getByRole('checkbox',{name:'全网查询',exact:true})).toBeChecked();
 await sourceGroup.getByRole('button',{name:'清空',exact:true}).click();
 await expect(sourceGroup.getByRole('checkbox',{checked:true})).toHaveCount(0);
 await sourceGroup.getByRole('button',{name:'全选',exact:true}).click();
 await sourceGroup.getByLabel('自定义数据源').fill('专题测试信源');await sourceGroup.getByRole('button',{name:'＋ 添加',exact:true}).click();
 await expect(dialog.getByLabel('专题测试信源',{exact:true})).toBeChecked();
 await page.screenshot({path:'artifacts/fr05-topic-modal.png',fullPage:true});
 await dialog.getByRole('button',{name:'启动',exact:true}).click();await expect(page.getByRole('button',{name:'← 返回工作台'})).toBeVisible();
 await page.getByRole('button',{name:'← 返回工作台'}).click();
 await expect(page.getByRole('link',{name:'打开总报'})).toHaveAttribute('href',/feishu.cn\/docx\//);
 await expect(page.locator('.topic-report-card .task-status')).toHaveText('已完成');
 await page.getByRole('button',{name:'设置日报',exact:true}).click();
 await expect(dialog.getByLabel('调研方向',{exact:true})).toHaveValue('国产推理芯片的软件生态如何发展？');
 await expect(dialog.getByRole('group',{name:/^数据源/})).toHaveClass('industry-choices');
 await expect(dialog.getByLabel('发送时间（北京时间）')).toHaveValue('09:00');
 const startDay=dialog.getByLabel('开始日期（发送日前几天）');
 const startTime=dialog.getByLabel('开始时间',{exact:true});
 const endDay=dialog.getByLabel('结束日期（发送日前几天）');
 const endTime=dialog.getByLabel('结束时间',{exact:true});
 await expect(startDay).toHaveValue('1');
 await expect(startTime).toHaveValue('00:00');
 await expect(endDay).toHaveValue('0');
 await expect(endTime).toHaveValue('00:00');
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/帮我在【\{\{时间范围\}\}】内.*每个信息条目附可点击的原始来源链接和信息日期，链接紧跟该条正文/);
 await startDay.fill('3');
 await startTime.fill('18:30');
 await endTime.fill('08:45');
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/每日日报信息去重合并保存到【本专题调研】的总报/);await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/【专题总报合并规则】/);await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/禁止把本次调研摘要或专题日报整体追加到专题总报/);
 await dialog.getByLabel('发送时间（北京时间）').fill('10:30');await expect(dialog.getByLabel('启用此定时任务')).toHaveCount(0);
 await dialog.getByRole('button',{name:'完成',exact:true}).click();await expect(dialog).toHaveCount(0);
 await expect(page.getByText('专题日报 · 每天 10:30（北京时间）')).toBeVisible();
 await page.route(/\/api\/topics\/[^/]+\/schedule$/,async route=>{
  if(route.request().method()!=='GET')return route.continue();
  const response=await route.fetch(),plan=await response.json();
  await route.fulfill({response,json:{...plan,research:{...plan.research,prompt:'自定义补充：关注算力成本。报告按照【调研问题】【调研结论】【调研依据】组织，每条依据紧跟来源链接和日期。'}}});
 });
 await page.getByRole('button',{name:'设置日报',exact:true}).click();await expect(dialog.getByLabel('发送时间（北京时间）')).toHaveValue('10:30');
 await expect(startDay).toHaveValue('3');
 await expect(startTime).toHaveValue('18:30');
 await expect(endTime).toHaveValue('08:45');
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/自定义补充：关注算力成本/);
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).not.toHaveValue(/【调研结论】|【调研依据】/);
 await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/每日日报信息去重合并保存到【本专题调研】的总报/);await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/【专题总报合并规则】/);await expect(dialog.getByLabel('任务 Prompt',{exact:false})).toHaveValue(/禁止把本次调研摘要或专题日报整体追加到专题总报/);
 await dialog.getByRole('button',{name:'关闭专题配置'}).click();
 await page.getByRole('button',{name:'日报',exact:true}).click();await expect(page.locator('.topic-card')).toHaveCount(0);
 await page.getByRole('button',{name:'专题调研',exact:true}).click();await expect(page.locator('.topic-report-card')).toHaveCount(1);
 await page.getByRole('button',{name:'← 返回专题列表'}).click();await expect(page.locator('.topic-card')).toHaveCount(1);
 await page.getByRole('button',{name:/^查看专题：/}).click();await expect(page.getByRole('heading',{name:'专题总报',exact:true})).toBeVisible();
 await page.screenshot({path:'artifacts/fr05-topic-library.png',fullPage:true});
 await page.getByRole('button',{name:'AI 会话详情',exact:false}).click();await expect(page.getByRole('button',{name:'← 返回工作台'})).toBeVisible();
});

test('PRD468 专题列表进入详情，分别展示总报与全部日期日报，刷新不丢失层级',async({page})=>{
 const topicId='99999999-9999-4999-8999-999999999999',question='AI 推理产业发展';
 const report=(id,name,url,daily)=>({id,direction:name,status:'ready',nativeSessionId:'session-'+id,createdAt:'2026-11-15T01:00:00Z',topic:{topicId,question,workflowVersion:468,...(daily?{window:{start:name,end:name,display:name}}:{})},publication:{status:'published',url}});
 const total=report('total','总报','https://example.feishu.cn/docx/Total'),daily1=report('day1','2026-11-13','https://example.feishu.cn/docx/Day1',true),daily2=report('day2','2026-11-14','https://example.feishu.cn/docx/Day2',true);
 await page.route(/\/api\/industry\/library(?:\?.*)?$/,route=>route.fulfill({json:{companies:[]}}));
 let reads=0;await page.route(/\/api\/topics(?:\?.*)?$/,route=>{reads++;return route.fulfill({json:{items:[{...total,totalReport:total,dailyReports:[daily2,daily1],schedule:{enabled:false}}],syncedAt:new Date().toISOString()}});});
 await page.goto('/');await page.getByRole('button',{name:'专题调研',exact:true}).click();
 await expect(page.locator('.topic-card')).toHaveCount(1);await expect(page.locator('.topic-report-card')).toHaveCount(0);
 const storage=await page.locator('.topic-storage').boundingBox(),location=await page.locator('.topic-storage-location').boundingBox();
 expect(location.x-storage.x).toBeGreaterThan(20);expect(storage.height).toBeLessThan(130);
 await page.screenshot({path:'artifacts/prd497-topic-list.png',fullPage:true});
 // Click the card padding, away from its title and footer.
 await page.getByRole('button',{name:'查看专题：'+question,exact:true}).click({position:{x:8,y:8}});await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
 await expect(page.getByRole('link',{name:'打开总报',exact:false})).toHaveAttribute('href',total.publication.url);
 await expect(page.getByRole('link',{name:'打开专题日报',exact:false})).toHaveCount(2);await expect(page.locator('.topic-report-card')).toHaveCount(3);
 await expect(page.getByText('2026-11-13',{exact:true})).toBeVisible();await expect(page.getByText('2026-11-14',{exact:true})).toBeVisible();
 const before=reads;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect.poll(()=>reads).toBeGreaterThan(before);await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
 await page.screenshot({path:'artifacts/prd468-topic-detail.png',fullPage:true});
 await page.getByRole('button',{name:'← 返回专题列表'}).click();await expect(page.locator('.topic-card')).toHaveCount(1);
 const card=page.getByRole('button',{name:'查看专题：'+question,exact:true});await card.focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
 await page.getByRole('button',{name:'← 返回专题列表'}).click();
 await page.setViewportSize({width:390,height:844});
 await expect(page.locator('.topic-storage')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 const mobileStorage=await page.locator('.topic-storage').boundingBox(),mobileText=await page.locator('.topic-storage-location').boundingBox();expect(mobileText.x-mobileStorage.x).toBeGreaterThan(18);
 await page.screenshot({path:'artifacts/prd497-topic-mobile.png',fullPage:true});
 await card.focus();await page.keyboard.press('Space');await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
});

test('专题卡片直达总报和最近发布的日报，打开报告仍停留在专题列表', async ({page, context}) => {
 const topic = {topicId:'88888888-8888-4888-8888-888888888888',question:'推理芯片进展',workflowVersion:468};
 const totalUrl = 'https://example.feishu.cn/docx/TopicTotal';
 const dailyUrl = 'https://example.feishu.cn/docx/LatestDaily';
 const card = {
  id:'topic-report-links',topic,status:'ready',
  totalReport:{publication:{status:'published',url:totalUrl}},
  dailyReports:[
   {status:'running',publication:{status:'publishing',url:'https://example.feishu.cn/docx/Unfinished'}},
   {status:'ready',publication:{status:'published',url:dailyUrl}},
   {status:'ready',publication:{status:'published',url:'https://example.feishu.cn/docx/OlderDaily'}},
  ],
 };
 const empty = {id:'no-reports-yet',topic:{...topic,topicId:'77777777-7777-4777-8777-777777777777',question:'尚未生成报告的专题'},status:'queued',dailyReports:[]};
 await page.route(/\/api\/topics(?:\?.*)?$/,route=>route.fulfill({json:{items:[card,empty]}}));
 await context.route('https://example.feishu.cn/docx/*',route=>route.fulfill({body:'报告验收'}));
 await page.goto('/');
 await page.getByRole('button',{name:'专题调研',exact:true}).click();
 for(const [label,url] of [['打开总报',totalUrl],['打开最新日报',dailyUrl]]){
  const link = page.getByRole('link',{name:topic.question+' · '+label,exact:true});
  const [report] = await Promise.all([page.waitForEvent('popup'),link.click()]);
  await expect(report).toHaveURL(url);
  await expect(page.getByRole('heading',{level:1,name:'专题调研',exact:true})).toBeVisible();
  await report.close();
 }
 const emptyCard = page.locator('.topic-card-wrap').filter({hasText:empty.topic.question});
 await expect(emptyCard.getByRole('link')).toHaveCount(0);
 await expect(emptyCard.getByText('暂无日报',{exact:true})).toBeVisible();
});

test('专题列表一键重试保留列表，显示部分提交结果并更新日报状态', async ({page}) => {
 const scope = (await (await page.request.get('/api/config')).json()).topicScope;
 const topic = {topicId:'66666666-6666-4666-8666-666666666666',question:'日报一键重试验收',workflowVersion:468};
 const day = '2026-11-22';
 const daily = {id:'batch-daily',topic:{...topic,window:{display:day}},direction:'专题日报 · '+day,status:'failed',publication:{status:'failed'}};
 const blocked = {...daily,id:'blocked-daily',direction:'专题日报 · 2026-11-21',topic:{...topic,window:{display:'2026-11-21'}}};
 let accepted = false, requests = 0;
 await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{items:[
   {id:'batch-topic',topic,status:'ready',totalReport:null,dailyReports:[accepted?{...daily,status:'queued',stage:'queued'}:daily,blocked]},
 ],syncedAt:new Date().toISOString()}}));
 await page.route('**/api/topics/retry-failed-dailies', route => {
   expect(route.request().method()).toBe('POST');
   expect(route.request().postDataJSON()).toEqual({scope});
   requests++;
   accepted = true;
   return route.fulfill({status:202,json:{accepted:1,rejected:[{id:blocked.id,title:blocked.direction,error:'任务正在执行，请勿重复重试'}]}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'专题调研',exact:true}).click();
 await page.getByRole('button',{name:'日报一键重试',exact:true}).click();
 const result = page.locator('.topic-batch-result').getByRole('status');
 await expect(result).toContainText('已提交 1 份专题日报重试');
 await expect(result).toContainText('1 份未能提交');
 await page.getByText('查看未提交原因',{exact:true}).click();
 await expect(page.getByText('专题日报 · 2026-11-21：任务正在执行，请勿重复重试',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看专题：'+topic.question,exact:true}).click();
 await expect(page.locator('.topic-report-card').filter({hasText:day}).locator('.task-status')).toHaveText('排队中');
 await expect(page.getByRole('button',{name:'日报一键重试',exact:true})).toHaveCount(0);
 expect(requests).toBe(1);
});

for(const asynchronous of [false,true])test(`PRD519 删除专题确认、取消、整卡点击隔离与${asynchronous?'异步续查':'刷新竞态'}`,async({page})=>{
 const topicId='33333333-3333-4333-8333-333333333333',question='删除流程验收专题';
 const total={id:'delete-total',direction:'专题总报 · '+question,status:'ready',createdAt:'2026-11-16T01:00:00Z',topic:{topicId,question,workflowVersion:468},publication:{status:'published',url:'https://example.feishu.cn/docx/DeleteTotal'}};
 const card={...total,totalReport:total,dailyReports:[],schedule:{enabled:true,time:'10:10'}};
 let deleted=false,attempts=0,delayNext=false,waiting=false,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const scope=(await(await page.request.get('/api/config')).json()).topicScope;
 await page.route(/\/api\/topics(?:\?.*)?$/,async route=>{
  const snapshot=deleted?[]:[card];if(delayNext){delayNext=false;waiting=true;await gate;}
  await route.fulfill({json:{items:snapshot,syncedAt:new Date().toISOString()}});
 });
 await page.route('**/api/topics/'+topicId+'/deletion?*',route=>route.fulfill({json:{topicId,question,scope,confirmation:'a'.repeat(64),totalCount:1,dailyCount:2,status:'ready'}}));
 await page.route('**/api/topics/'+topicId,async route=>{
  expect(route.request().method()).toBe('DELETE');expect(route.request().postDataJSON()).toEqual({scope,confirmation:'a'.repeat(64),confirmed:true});attempts++;
  if(asynchronous&&attempts===1)return route.fulfill({status:202,json:{status:'pending',message:'飞书正在处理删除，请稍后继续核对。'}});
  deleted=true;await route.fulfill({json:{status:'deleted',topicId}});
 });
 await page.goto('/');await page.getByRole('button',{name:'专题调研',exact:true}).click();await expect(page.locator('.topic-card')).toHaveCount(1);
 await page.getByRole('button',{name:'删除专题：'+question,exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'删除专题？'});await expect(dialog).toBeVisible();await expect(page.getByRole('heading',{level:1,name:question,exact:true})).toHaveCount(0);
 await expect(dialog).toContainText('总报 1 份 · 日报 2 份');await expect(dialog).toContainText('飞书回收站');
 await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toHaveCount(0);expect(attempts).toBe(0);
 if(!asynchronous){delayNext=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await expect.poll(()=>waiting).toBe(true);}
 await page.getByRole('button',{name:'删除专题：'+question,exact:true}).click();await expect(dialog.getByRole('button',{name:'确认删除',exact:true})).toBeEnabled();
 await page.screenshot({path:'artifacts/prd519-topic-delete-confirm.png',fullPage:true});
 await dialog.getByRole('button',{name:'确认删除',exact:true}).click();
 if(asynchronous){await expect(dialog.getByRole('status')).toHaveText('飞书正在处理删除，请稍后继续核对。');await expect(page.locator('.topic-card')).toHaveCount(1);await dialog.getByRole('button',{name:'继续核对',exact:true}).click();}
 await expect(dialog).toHaveCount(0);await expect(page.locator('.topic-card')).toHaveCount(0);release();
 await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.locator('.topic-card')).toHaveCount(0);
 expect(attempts).toBe(asynchronous?2:1);
 await page.screenshot({path:'artifacts/prd519-topic-deleted.png',fullPage:true});
});

test('PRD519 删除范围核对失败不能提交，可取消且不影响其他专题',async({page})=>{
 const question='运行中的专题',topicId='44444444-4444-4444-8444-444444444444';let deletes=0;
 await page.route(/\/api\/topics(?:\?.*)?$/,route=>route.fulfill({json:{items:[{id:'busy-topic',status:'running',topic:{topicId,question},totalReport:null,dailyReports:[]}],syncedAt:new Date().toISOString()}}));
 await page.route('**/api/topics/'+topicId+'/deletion?*',route=>route.fulfill({status:409,json:{error:'该专题有调研正在执行，请完成后再删除'}}));
 await page.route('**/api/topics/'+topicId,route=>{deletes++;return route.fulfill({json:{status:'deleted'}});});
 await page.goto('/');await page.getByRole('button',{name:'专题调研',exact:true}).click();
 await page.getByRole('button',{name:'删除专题：'+question,exact:true}).click();const dialog=page.getByRole('dialog');
 await expect(dialog.getByRole('alert')).toContainText('调研正在执行');await expect(dialog.getByRole('button',{name:'确认删除',exact:true})).toBeDisabled();
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.locator('.topic-card')).toHaveCount(1);expect(deletes).toBe(0);
});
