import {test,expect} from '@playwright/test';

const digestDefaultPrompt = '聚合所有日报的摘要生成汇总日报，发布飞书文档到【存储位置】，并发送到飞书消息。【汇总规则】每个章节一个专题题目和摘要，附带每个日报链接。';
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

test('PRD 6004 专题列表置顶显示已完成的日报汇总并打开飞书文档', async ({page, context}) => {
  const url = 'https://example.feishu.cn/docx/TopicDigest';
  const date = '2026-11-26';
  const topic = { topicId:'77777777-7777-4777-8777-777777777777', question:'测试专题', workflowVersion:468 };
  let digest = null;
  await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({ json: {
    items: [{ id:'digest-topic', topic, status:'ready', dailyReports:[] }], digest, digestDate:date,
    digestPrompt:digestDefaultPrompt, digestRetryable:false, syncedAt:new Date().toISOString(),
  } }));
  await context.route(url, route => route.fulfill({ body:'汇总日报验收' }));
  await page.goto('/');
  await page.getByRole('button', { name:'专题调研', exact:true }).click();
  await expect(page.getByText('全部专题日报生成后，汇总会显示在这里。')).toBeVisible();
  const link = page.getByRole('link', { name:'打开最新日报汇总' });
  await expect(link).toHaveCount(0);
  const card = page.locator('.topic-digest-card');
  const settings = card.getByRole('button', {name:'设置汇总 Prompt',exact:true});
  await expect(settings).toBeEnabled();
  await expect(card.getByRole('status')).toContainText('未生成');
  digest = { date, url };
  await page.getByRole('button', { name:'刷新', exact:true }).click();
  await expect(link).toHaveAttribute('href', url);
  await expect(link.getByText(date, { exact:true })).toBeVisible();
  await expect(card.getByRole('status')).toContainText('已完成');
  await expect(settings).toBeEnabled();
  await expect(page.getByRole('button', {name:'日报一键重试',exact:true})).toBeDisabled();
  const [report] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await expect(report).toHaveURL(url);
  await report.close();
  await expect(page.getByRole('heading', { level:1, name:'专题调研', exact:true })).toBeVisible();
  await page.getByRole('button', { name:'查看专题：测试专题' }).click();
  await expect(link).toHaveCount(0);
  await page.getByRole('button', { name:'← 返回专题列表' }).click();
  await expect(link).toBeVisible();
});

test('PRD6264 保存汇总默认 Prompt，现有任务不变，重载后仍保留', async ({page}) => {
  const scope = (await (await page.request.get('/api/config')).json()).topicScope;
  const response = await page.request.get('/api/topics');
  await expect(response).toBeOK();
  const initial = await response.json();
  expect(initial.digestPrompt).toBe(digestDefaultPrompt);
  expect(initial.digestRetryable).toEqual(expect.any(Boolean));
  const date = '2026-01-02', taskId = '62640000-0000-4000-8000-000000000001';
  const taskPrompt = '已经排队的汇总任务使用自己的原 Prompt。';
  const prompt = '聚合所有日报并在飞书通知中突出共性趋势。';
  let configuredPrompt = digestDefaultPrompt, saved = 0;
  const mutations = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/topics') && request.method() !== 'GET') mutations.push([request.method(), path]);
  });
  await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{
    items:[], digestDate:date, digestPrompt:configuredPrompt, digestRetryable:false,
    digestGeneration:{date,status:'queued',taskId,prompt:taskPrompt}, syncedAt:new Date().toISOString(),
  }}));
  await page.route('**/api/topics/digest/settings', route => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toEqual({scope,prompt});
    saved++;
    if (saved === 1) return route.fulfill({status:503,json:{error:'暂时无法保存汇总配置'}});
    configuredPrompt = prompt;
    return route.fulfill({json:{prompt:configuredPrompt}});
  });
  await page.goto('/');
  const tab = page.getByRole('button', {name:'专题调研',exact:true});
  await tab.click();
  const card = page.locator('.topic-digest-card');
  const settings = card.getByRole('button', {name:'设置汇总 Prompt',exact:true});
  const dialog = page.getByRole('dialog', {name:'设置汇总 Prompt'});
  const promptField = dialog.getByRole('textbox', {name:'默认汇总 Prompt',exact:true});
  const save = dialog.getByRole('button', {name:'保存',exact:true});
  await expect(card.locator('.topic-digest-status')).toContainText('排队中');
  await settings.click();
  await expect(promptField).toBeFocused();
  await expect(promptField).toHaveValue(digestDefaultPrompt);
  await expect(dialog.getByRole('button', {name:'启动',exact:true})).toHaveCount(0);
  await promptField.fill('不保存此草稿');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  expect(mutations).toEqual([]);
  await settings.click();
  await expect(promptField).toHaveValue(digestDefaultPrompt);
  await promptField.fill('   ');
  await expect(save).toBeDisabled();
  await promptField.fill(prompt);
  const listUrl = page.url();
  await save.click();
  await expect(dialog.getByRole('alert')).toHaveText('暂时无法保存汇总配置');
  await expect(promptField).toHaveValue(prompt);
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByText('汇总 Prompt 已保存。', {exact:true})).toBeVisible();
  await expect(card.locator('.topic-digest-status')).toContainText('排队中');
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole('button', {name:'← 返回工作台'})).toHaveCount(0);
  await page.reload();
  await tab.click();
  await settings.click();
  await expect(promptField).toHaveValue(prompt);
  expect(mutations).toEqual([['PUT','/api/topics/digest/settings'],['PUT','/api/topics/digest/settings']]);
});

for (const startStatus of [202, 200]) test(`PRD6282 日报齐备时手动生成汇总并进入原生会话（${startStatus}），同日存档后不可再生成`, async ({page}) => {
  const scope = (await (await page.request.get('/api/config')).json()).topicScope;
  const date = '2026-01-02', url = 'https://example.feishu.cn/docx/ManualDigest';
  const topic = {topicId:'62820000-0000-4000-8000-000000000002',question:'已发布的专题日报'};
  const daily = {id:'ready-daily',topic:{...topic,window:{display:date}},status:'ready',
    publication:{status:'published',url:'https://example.feishu.cn/docx/ReadyDaily'}};
  const task = {id:'62820000-0000-4000-8000-000000000001',direction:'专题日报汇总 · '+date,
    status:startStatus === 202 ? 'queued' : 'running',createdAt:date+'T01:00:00Z',nativeSession:true,
    nativeSessionId:'manual-digest-native-session'};
  const gate = Promise.withResolvers();
  let phase = 'waiting', requests = 0;
  await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{
    items:[{id:'ready-topic',topic,status:'ready',dailyReports:[phase === 'waiting' ? {...daily,status:'running',publication:{status:'pending'}} : daily]}],
    digestDate:date, digestPrompt:digestDefaultPrompt, digestCanCreate:phase === 'ready',
    digest:phase === 'archived' ? {date,url} : null,
    digestGeneration:phase === 'waiting' ? {date,status:'waiting'} : phase === 'ready' ? null
      : {date,status:phase === 'archived' ? 'sent' : task.status,taskId:task.id},
  }}));
  await page.route('**/api/topics/digest/start', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({scope});
    requests++;
    await gate.promise;
    phase = 'active';
    const returnedTask = startStatus === 202 ? {...task,nativeSessionId:undefined} : task;
    await route.fulfill({status:startStatus,json:{date,status:task.status,task:returnedTask}});
  });
  await page.route('**/api/tasks/'+task.id, route => route.fulfill({json:{task}}));
  await page.goto('/');
  await page.getByRole('button',{name:'专题调研',exact:true}).click();
  const card = page.locator('.topic-digest-card');
  const create = card.getByRole('button',{name:'生成汇总',exact:true});
  await expect(card.getByRole('heading',{name:'日报汇总',exact:true})).toBeVisible();
  await expect(card.getByRole('status')).toContainText('等待日报');
  await expect(create).toHaveCount(0);
  phase = 'ready';
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(create).toBeEnabled();
  await create.dblclick();
  await expect(card.getByRole('button',{name:'正在提交…',exact:true})).toBeDisabled();
  await expect.poll(()=>requests).toBe(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  gate.resolve();
  await expect(page).toHaveURL(new RegExp('#'+task.id+'$'));
  await expect(page.getByRole('heading',{name:task.direction,exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'DSH 原生会话'})).toBeVisible();

  phase = 'archived';
  await page.getByRole('button',{name:'← 返回工作台'}).click();
  await expect(card.getByRole('link',{name:'打开最新日报汇总'})).toHaveAttribute('href',url);
  await expect(card.getByRole('status')).toContainText('已完成');
  await expect(create).toHaveCount(0);
  expect(requests).toBe(1);
});

test('PRD6282 会话准备与启动失败不指向旧会话，提交错误显示在汇总卡片', async ({page}) => {
  const date = '2026-01-02', archive = {date:'2026-01-01',url:'https://example.feishu.cn/docx/PriorManualDigest'};
  const startIssue = '暂时无法核对飞书存储位置';
  const authError = '请先绑定飞书再生成日报汇总';
  const eligibilityError = '今天的专题日报尚未全部生成，请等日报补齐后再试';
  let status = 'preparing', requests = 0;
  await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{
    items:[], digest:archive, digestArchivedTaskId:'62820000-0000-4000-8000-000000000003', digestDate:date,
    digestPrompt:digestDefaultPrompt, digestCanCreate:status === 'start_failed',
    digestGeneration:{date,status,...(status === 'start_failed' && {startIssue})},
  }}));
  await page.route('**/api/topics/digest/start', route => {
    if (++requests === 1) return route.fulfill({status:428,json:{error:authError}});
    status = 'waiting';
    return route.fulfill({status:409,json:{error:eligibilityError}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'专题调研',exact:true}).click();
  const listUrl = page.url(), card = page.locator('.topic-digest-card');
  const create = card.getByRole('button',{name:'生成汇总',exact:true});
  const details = card.getByRole('button',{name:'AI 会话详情',exact:true});
  await expect(card.getByRole('status')).toContainText('正在准备 AI 会话');
  await expect(card.getByRole('link',{name:'打开最新日报汇总'})).toHaveAttribute('href',archive.url);
  await expect(create).toHaveCount(0);
  await expect(details).toHaveCount(0);
  status = 'start_failed';
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await expect(card.getByRole('status')).toContainText('会话尚未创建');
  await expect(card.getByRole('status')).toContainText(startIssue);
  await expect(details).toHaveCount(0);
  await create.click();
  await expect(card.getByRole('alert')).toHaveText(authError);
  await expect(page).toHaveURL(listUrl);
  await create.click();
  await expect(card.getByRole('alert')).toHaveText(eligibilityError);
  await expect(card.getByRole('status')).toContainText('等待日报');
  await expect(create).toHaveCount(0);
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests).toBe(2);
});

test('PRD6264 同日存档文档与失败任务状态同时可见，仍可打开现有会话', async ({page}) => {
  const date = '2026-01-02', url = 'https://example.feishu.cn/docx/SameDayArchive';
  const task = {id:'62640000-0000-4000-8000-000000000002',direction:'失败的汇总日报',status:'failed',
    createdAt:date+'T01:00:00Z',nativeSession:true,nativeSessionId:'failed-digest-native-session'};
  let canOpen = false, taskReads = 0;
  await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{items:[],digestDate:date,
    digest:{date,url}, digestPrompt:digestDefaultPrompt, digestRetryable:false,
    digestGeneration:{date,status:'failed',taskId:task.id},syncedAt:new Date().toISOString()}}));
  await page.route('**/api/tasks/'+task.id, route => {
    expect(route.request().method()).toBe('GET');
    taskReads++;
    return canOpen ? route.fulfill({json:{task}}) : route.fulfill({status:503,json:{error:'暂时无法读取会话'}});
  });
  await page.goto('/');
  await page.getByRole('button', {name:'专题调研',exact:true}).click();
  const card = page.locator('.topic-digest-card');
  const link = card.getByRole('link', {name:'打开最新日报汇总'});
  await expect(link).toHaveAttribute('href',url);
  await expect(link.getByText(date,{exact:true})).toBeVisible();
  await expect(card.getByRole('status')).toContainText('本期任务 · '+date);
  await expect(card.getByRole('status')).toContainText('汇总生成失败');
  await expect(card.getByRole('status')).not.toContainText('已完成');
  await expect(card.getByRole('button',{name:'设置汇总 Prompt',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'日报一键重试',exact:true})).toBeDisabled();
  await expect(card.getByRole('button',{name:/重试/})).toHaveCount(0);
  const details = card.getByRole('button', {name:'AI 会话详情',exact:true});
  await details.click();
  await expect(card.getByRole('alert')).toHaveText('暂时无法读取会话');
  expect(taskReads).toBe(1);
  canOpen = true;
  await details.click();
  await expect(page).toHaveURL(new RegExp('#'+task.id+'$'));
  await expect(page.getByRole('heading', {name:task.direction,exact:true})).toBeVisible();
  await expect(page.getByRole('region', {name:'DSH 原生会话'})).toBeVisible();
});

test('PRD6264 / PRD6282 仅汇总失败可从顶部重试，重试中可以打开本期原生会话', async ({page}) => {
  const scope = (await (await page.request.get('/api/config')).json()).topicScope;
  const date = '2026-01-02', previousDate = '2026-01-01', taskId = '62640000-0000-4000-8000-000000000003';
  const url = 'https://example.feishu.cn/docx/CompletedDigest', previousUrl = 'https://example.feishu.cn/docx/PreviousDigest';
  const archivedTaskId = '62640000-0000-4000-8000-000000000005';
  const task = {id:taskId,direction:'正在重试的汇总日报',status:'running',
    createdAt:date+'T01:00:00Z',nativeSession:true,nativeSessionId:'retrying-digest-native-session'};
  let status = 'failed', archivedReads = 0;
  const mutations = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/topics') && request.method() !== 'GET') mutations.push([request.method(), path]);
  });
  await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{
    items:[], digestDate:date, digestPrompt:digestDefaultPrompt, digestRetryable:status === 'failed',
    digest:status === 'sent' ? {date,url} : {date:previousDate,url:previousUrl},
    digestArchivedTaskId:status === 'sent' ? taskId : archivedTaskId,
    digestGeneration:status === 'retrying' ? {status,taskId} : {date,status,taskId}, syncedAt:new Date().toISOString(),
  }}));
  await page.route('**/api/tasks/'+taskId, route => route.fulfill({json:{task}}));
  await page.route('**/api/tasks/'+archivedTaskId, route => {
    archivedReads++;
    return route.fulfill({status:404,json:{error:'误打开之前存档的汇总会话'}});
  });
  await page.route('**/api/topics/retry-failed-dailies', route => {
    expect(route.request().postDataJSON()).toEqual({scope});
    status = 'queued';
    return route.fulfill({status:202,json:{accepted:0,rejected:[],digestRetry:'submitted'}});
  });
  await page.goto('/');
  await page.getByRole('button', {name:'专题调研',exact:true}).click();
  const card = page.locator('.topic-digest-card');
  const retry = page.getByRole('button', {name:'日报一键重试',exact:true});
  const link = card.getByRole('link', {name:'打开最新日报汇总'});
  const taskStatus = card.getByRole('status');
  await expect(link).toHaveAttribute('href',previousUrl);
  await expect(taskStatus).toContainText('汇总生成失败');
  await expect(card.getByRole('button',{name:/重试/})).toHaveCount(0);
  await expect(retry).toBeEnabled();
  const listUrl = page.url();
  await retry.click();
  await expect(page.locator('.topic-batch-result').getByRole('status')).toHaveText('已提交日报汇总重试。');
  await expect(taskStatus).toContainText('排队中');
  await expect(retry).toBeDisabled();
  await expect(link).toHaveAttribute('href',previousUrl);
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  status = 'retrying';
  await page.getByRole('button', {name:'刷新',exact:true}).click();
  await expect(taskStatus).toContainText('本期任务 · '+date);
  await expect(taskStatus).toContainText('重试中');
  await expect(link).toHaveAttribute('href',previousUrl);
  await expect(page).toHaveURL(listUrl);
  await card.getByRole('button',{name:'AI 会话详情',exact:true}).click();
  await expect(page).toHaveURL(new RegExp('#'+taskId+'$'));
  await expect(page.getByRole('heading',{name:task.direction,exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'DSH 原生会话'})).toBeVisible();
  expect(archivedReads).toBe(0);
  status = 'running';
  await page.getByRole('button',{name:'← 返回工作台'}).click();
  await expect(taskStatus).toContainText('生成中');
  status = 'sent';
  await expect(taskStatus).toContainText('已完成', {timeout:10000});
  await expect(taskStatus).toContainText('汇总已生成并发送飞书通知。');
  await expect(link).toHaveAttribute('href',url);
  await expect(card.getByRole('button',{name:'AI 会话详情',exact:true})).toBeEnabled();
  expect(mutations).toEqual([['POST','/api/topics/retry-failed-dailies']]);
});

for (const digestWaiting of [false, true]) test(`专题列表一键重试显示部分提交结果${digestWaiting ? '和汇总等待状态' : ''}`, async ({page}) => {
 const scope = (await (await page.request.get('/api/config')).json()).topicScope;
 const topic = {topicId:'66666666-6666-4666-8666-666666666666',question:'日报一键重试验收',workflowVersion:468};
 const day = '2026-11-22';
 const daily = {id:'batch-daily',topic:{...topic,window:{display:day}},direction:'专题日报 · '+day,status:'failed',publication:{status:'failed'}};
 const blocked = {...daily,id:'blocked-daily',direction:'专题日报 · 2026-11-21',topic:{...topic,window:{display:'2026-11-21'}}};
 const archive = {date:'2026-11-21',url:'https://example.feishu.cn/docx/PriorDigest'};
 const archivedTask = {id:'62640000-0000-4000-8000-000000000004',direction:'上一期汇总日报',status:'ready',
   createdAt:archive.date+'T01:00:00Z',nativeSession:true,nativeSessionId:'archived-digest-native-session'};
 let accepted = false, requests = 0;
 await page.route(/\/api\/topics(?:\?.*)?$/, route => route.fulfill({json:{items:[
   {id:'batch-topic',topic,status:'ready',totalReport:null,dailyReports:[accepted?{...daily,status:'queued',stage:'queued'}:daily,blocked]},
 ],digestDate:day, digestPrompt:digestDefaultPrompt, digestRetryable:digestWaiting && !accepted,
 ...(digestWaiting && {digest:archive, digestArchivedTaskId:archivedTask.id,
   digestGeneration:{date:day,status:accepted?'waiting':'failed'}}), syncedAt:new Date().toISOString()}}));
 if (digestWaiting) await page.route('**/api/tasks/'+archivedTask.id, route => route.fulfill({json:{task:archivedTask}}));
 await page.route('**/api/topics/retry-failed-dailies', route => {
   expect(route.request().method()).toBe('POST');
   expect(route.request().postDataJSON()).toEqual({scope});
   requests++;
   accepted = true;
   return route.fulfill({status:202,json:{accepted:1,rejected:[{id:blocked.id,title:blocked.direction,error:'任务正在执行，请勿重复重试'}],
     ...(digestWaiting && {digestRetry:'waiting'})}});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'专题调研',exact:true}).click();
 await page.getByRole('button',{name:'日报一键重试',exact:true}).click();
 const result = page.locator('.topic-batch-result').getByRole('status');
 await expect(result).toContainText('已提交 1 份专题日报重试');
 await expect(result).toContainText('1 份未能提交');
 const card = page.locator('.topic-digest-card');
 if (digestWaiting) {
   await expect(result).toContainText('日报汇总正在等待日报补齐，全部恢复后将自动重试。');
   await expect(card.getByRole('status')).toContainText('等待日报');
   await expect(card.getByRole('link',{name:'打开最新日报汇总'})).toHaveAttribute('href',archive.url);
 } else {
   await expect(result).not.toContainText('汇总');
 }
 await page.getByText('查看未提交原因',{exact:true}).click();
 await expect(page.getByText('专题日报 · 2026-11-21：任务正在执行，请勿重复重试',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看专题：'+topic.question,exact:true}).click();
 await expect(page.locator('.topic-report-card').filter({hasText:day}).locator('.task-status')).toHaveText('排队中');
 await expect(page.getByRole('button',{name:'日报一键重试',exact:true})).toHaveCount(0);
 if (digestWaiting) {
   await page.getByRole('button',{name:'← 返回专题列表'}).click();
   const details = card.getByRole('button',{name:'AI 会话详情',exact:true});
   await expect(details).toHaveAccessibleDescription('打开 '+archive.date+' 已存档汇总的 AI 会话');
   await details.click();
   await expect(page.getByRole('heading',{name:archivedTask.direction,exact:true})).toBeVisible();
   await expect(page).toHaveURL(new RegExp('#'+archivedTask.id+'$'));
 }
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
